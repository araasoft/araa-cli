#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawnSync } = require('child_process');

const VERSION = '4.0.0';
const CONF = path.join(os.homedir(), '.araa.json');
const SIDES = ['backend', 'frontend'];
const cap = s => s[0].toUpperCase() + s.slice(1);
const c = {
  g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
  d: s => `\x1b[2m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m`, u: s => `\x1b[4m\x1b[36m${s}\x1b[0m`,
};
const die = m => { console.error(c.r(m)); process.exit(1); };

// ---------- timed log ----------
const T0 = Date.now();
const stamp = () => c.d(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(3)}s]`);
const PAD = '       ';
const say = {
  run: t => console.log(`${stamp()} ${c.y('…')} ${t}`),
  ok: t => console.log(`${stamp()} ${c.g('✔')} ${t}`),
  err: t => console.log(`${stamp()} ${c.r('✘')} ${t}`),
  info: t => console.log(`${stamp()} ${c.d(t)}`),
};

// ---------- args, prompts, config ----------
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), eq = k.indexOf('=');
      if (eq > -1) flags[k.slice(0, eq)] = k.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith('--') && !['new-urls', 'renew'].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

let rl, lines;
const ask = async (q, def = '') => {
  if (!rl) { rl = readline.createInterface({ input: process.stdin }); lines = rl[Symbol.asyncIterator](); }
  process.stdout.write(c.b('? ') + q);
  const { value } = await lines.next();
  return (value || '').trim() || def;
};
const yes = s => s === '' || /^y/i.test(s);

function getConf() {
  let f = {}; try { f = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
  return { url: process.env.ARAA_URL || f.url, key: process.env.ARAA_KEY || f.key };
}
async function call(method, route, body, headers = {}) {
  const conf = getConf();
  if (!conf.url || !conf.key) die('Not logged in. Run: araa login');
  try { return await fetch(conf.url.replace(/\/+$/, '') + route, { method, headers: { 'x-key': conf.key, ...headers }, body }); }
  catch { die('Cannot reach server: ' + conf.url); }
}
async function jsonCall(method, route) {
  const res = await call(method, route);
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { message: text }; }
  return { ok: res.ok, status: res.status, data };
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64');

// ---------- project (araa.json) ----------
function findProject() {
  let dir = process.cwd();
  for (;;) {
    const f = path.join(dir, 'araa.json');
    if (fs.existsSync(f)) {
      try { return { root: dir, cfg: JSON.parse(fs.readFileSync(f, 'utf8')) }; }
      catch (e) { die('araa.json is not valid JSON: ' + e.message); }
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ---------- packing ----------
function globToRe(g) {
  let s = g.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  s = s.replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*').replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
  return new RegExp('^' + s + '$');
}
function makeIgnore(patterns) {
  const rules = patterns.map(p => { p = p.replace(/^\.?\//, '').replace(/\/+$/, ''); return { re: globToRe(p), anchored: p.includes('/') }; });
  return (rel, isDir) => rules.some(({ re, anchored }) => {
    const hit = s => re.test(s) || (isDir && re.test(s + '/'));
    return anchored ? hit(rel) : rel.split('/').some(hit);
  });
}
function walk(root, ignored, rel = '') {
  let out = [];
  for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (!ignored(r, true)) out = out.concat(walk(root, ignored, r)); }
    else if ((e.isFile() || e.isSymbolicLink()) && !ignored(r, false)) out.push(r);
  }
  return out;
}
function pack(dir, files) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'araa-'));
  const list = path.join(tmpDir, 'files.txt'), out = path.join(tmpDir, 'pack.tgz');
  fs.writeFileSync(list, files.join('\n') + '\n');
  // run tar INSIDE the folder (works with GNU tar, bsdtar and BusyBox tar)
  const t = spawnSync('tar', ['-czf', out, '-T', list], { cwd: dir, encoding: 'utf8' });
  if (t.error || t.status !== 0) die('Packing failed: ' + ((t.stderr || (t.error && t.error.message) || 'tar not found').trim()));
  const buf = fs.readFileSync(out);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return buf;
}
function predeploy(cmds, root, label) {
  for (const cmd of cmds || []) {
    say.run(`${label}: running predeploy command: ${cmd}`);
    const r = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: root });
    if (r.status !== 0) { say.err(`${label}: predeploy failed: ${cmd}`); process.exit(1); }
  }
}

// ---------- server stream ----------
async function stream(res, urls = {}) {
  let result = 'fail', pending = '';
  const dec = new TextDecoder();
  const show = line => {
    if (!line.trim()) return;
    if (line.startsWith('__RESULT__')) { result = line.split(' ')[1]; return; }
    if (line.startsWith('__URL__')) { const [, n, u] = line.split(' '); urls[n] = u; return; }
    if (line.startsWith('✔')) say.ok(line.slice(1).trim());
    else if (line.startsWith('✘')) say.err(line.slice(1).trim());
    else if (line.startsWith('…')) say.run(line.slice(1).trim());
    else if (line.startsWith('↩')) console.log(`${stamp()} ${c.y('↩')} ${line.slice(1).trim()}`);
    else console.log(PAD + c.d(line));
  };
  for await (const chunk of res.body) {
    pending += dec.decode(chunk, { stream: true });
    const parts = pending.split('\n'); pending = parts.pop(); parts.forEach(show);
  }
  if (pending) show(pending);
  return result === 'ok';
}
async function post(route, body, config) {
  const res = await call('POST', route, body, { 'content-type': 'application/gzip', 'x-araa-config': b64(config || {}) });
  if (!res.ok) { let m; try { m = (await res.json()).error; } catch {} die(`✘ Server said ${res.status}: ${m || 'error'}`); }
  return res;
}

// ---------- commands ----------
const commands = {
  async login(flags) {
    const url = flags.url || await ask('Agent URL (e.g. http://1.2.3.4:5001): ');
    const key = flags.key || await ask('Deploy key: ');
    if (rl) rl.close();
    fs.writeFileSync(CONF, JSON.stringify({ url, key }), { mode: 0o600 });
    const r = await jsonCall('GET', '/status');
    if (r.ok) console.log(c.g('✔ Success! Logged in.'));
    else { try { fs.unlinkSync(CONF); } catch {} die(`✘ Login failed (${r.status}): ${r.data.error || r.data.message}`); }
  },
  async logout() { try { fs.unlinkSync(CONF); } catch {} console.log(c.g('✔ Logged out.')); },

  async init() {
    const found = findProject();
    if (found && found.root === process.cwd() && !yes(await ask('araa.json already exists. Overwrite? (Y/n) '))) return;
    console.log(c.b('\nAraa project setup') + c.d('  (creates araa.json in this folder)\n'));
    const pick = names => names.find(n => fs.existsSync(n) && fs.statSync(n).isDirectory()) || '.';
    const cfg = {};
    const baseIgnore = ['araa.json', 'node_modules', '.git', '.env', '.env.*', '*.log', '.DS_Store'];

    if (yes(await ask('Set up Backend? (Y/n) '))) {
      const g = pick(['backend', 'server', 'api']);
      const source = await ask(`Backend folder? (${g}) `, g);
      const port = +(await ask('Backend port? (5000) ', '5000'));
      const install = await ask('Install command? (pnpm install) ', 'pnpm install');
      const start = await ask('Start command? (npm run dev) ', 'npm run dev');
      cfg.backend = { source, port, install, start, env: { AUTH_URL: '{frontendUrl}', CORS_URLS: '{frontendUrl}' }, ignore: baseIgnore };
    }
    if (yes(await ask('Set up Frontend? (Y/n) '))) {
      const g = pick(['frontend', 'client', 'web', 'app']);
      const source = await ask(`Frontend folder? (${g}) `, g);
      const port = +(await ask('Frontend port? (5173) ', '5173'));
      const install = await ask('Install command? (pnpm install) ', 'pnpm install');
      const start = await ask('Start command? (npm run dev) ', 'npm run dev');
      cfg.frontend = { source, port, install, start, env: { API_URL: '{backendUrl}', VITE_API_URL: '{backendUrl}' }, ignore: [...baseIgnore, 'dist', '.next', '.vite'] };
    }
    if (rl) rl.close();
    if (!cfg.backend && !cfg.frontend) die('Nothing selected. Run araa init again.');
    fs.writeFileSync('araa.json', JSON.stringify(cfg, null, 2) + '\n');
    console.log(c.g('\n✔ Wrote araa.json'));
    console.log(c.d('  After deploy, araa writes the Cloudflare URLs into your apps:'));
    if (cfg.frontend) console.log(c.d('    frontend .env: API_URL, VITE_API_URL = backend URL'));
    if (cfg.backend) console.log(c.d('    backend  .env: AUTH_URL, CORS_URLS   = frontend URL'));
    console.log(c.d('  Change the names under "env" in araa.json if your apps use other names.'));
    console.log('Next: ' + c.b('araa deploy'));
  },

  async deploy(flags) {
    const proj = findProject();
    if (!proj) die('No araa.json found. Run: araa init');
    const { root, cfg } = proj;
    if (cfg.hosting && !cfg.frontend) die('This araa.json is from an older version. Run: araa init');
    const only = flags.only ? String(flags.only).split(',').map(s => s.trim()) : null;
    if (only) for (const o of only) { if (!SIDES.includes(o)) die(`Unknown target "${o}". Use: backend, frontend`); if (!cfg[o]) die(`"${o}" is not set up in araa.json. Run: araa init`); }
    const sides = SIDES.filter(n => cfg[n] && (!only || only.includes(n)));
    if (!sides.length) die('Nothing to deploy. Run: araa init');

    console.log(c.b(`\n=== Araa deploy ===`) + c.d(`  ${getConf().url || ''}\n`));
    say.ok(`Project folder: ${root}`);
    say.ok(`Selected: ${sides.map(cap).join(' + ')}`);

    for (const name of sides) {
      const b = cfg[name], L = cap(name), src = path.resolve(root, b.source || '.');
      say.run(`${L}: selecting folder ${path.relative(root, src) || '.'}`);
      if (!fs.existsSync(path.join(src, 'package.json'))) { say.err(`${L}: no package.json in ${src}`); process.exit(1); }
      predeploy(b.predeploy, root, L);
      const ignore = [...(b.ignore || [])];
      const other = cfg[SIDES.find(n => n !== name)];
      if (other && other.source) { const rel = path.relative(src, path.resolve(root, other.source)); if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) ignore.push(rel.split(path.sep).join('/')); }
      say.run(`${L}: finding files (skipping node_modules, .env, .git)`);
      const files = walk(src, makeIgnore(ignore));
      if (!files.length) { say.err(`${L}: no files to upload`); process.exit(1); }
      say.ok(`${L}: ${files.length} files selected`);
      say.run(`${L}: making zip`);
      const buf = pack(src, files);
      say.ok(`${L}: zip ready (${(buf.length / 1048576).toFixed(2)} MB)`);
      say.run(`${L}: uploading to server`);
      const res = await post('/deploy/' + name, buf, { install: b.install, start: b.start, port: b.port });
      if (!await stream(res)) { console.log(''); die(`✘ ${L} deploy failed. Nothing was restarted.`); }
    }

    say.run('Starting your apps and Cloudflare tunnels');
    const slots = {};
    for (const n of SIDES) if (cfg[n]) slots[n] = { port: cfg[n].port, start: cfg[n].start, env: cfg[n].env };
    const urls = {};
    const lres = await post('/launch', Buffer.alloc(0), { slots, only: sides, rollback: true, renew: !!flags['new-urls'] });
    const ok = await stream(lres, urls);
    if (!ok) { console.log(''); die('✘ Deploy finished with errors. See the lines above.'); }
    printSummary(cfg, urls, Math.round((Date.now() - T0) / 1000));
  },

  async urls(flags) {
    if (flags.renew) {
      const proj = findProject();
      const slots = {};
      if (proj) for (const n of SIDES) if (proj.cfg[n]) slots[n] = { port: proj.cfg[n].port, start: proj.cfg[n].start, env: proj.cfg[n].env };
      const urls = {};
      const res = await post('/launch', Buffer.alloc(0), { slots, renew: true });
      if (!await stream(res, urls)) die('✘ Failed. See the lines above.');
      return printSummary(proj && proj.cfg, urls);
    }
    const r = await jsonCall('GET', '/urls');
    if (!r.ok) die('✘ ' + (r.data.error || r.data.message));
    printSummary(null, r.data);
  },

  async status() {
    const r = await jsonCall('GET', '/status');
    if (!r.ok) die('✘ ' + (r.data.error || r.data.message));
    for (const n of SIDES) {
      const s = r.data[n];
      console.log(c.b(cap(n)));
      if (!s.deployed) { console.log(c.y('  not deployed yet')); continue; }
      console.log('  ' + (s.running ? c.g('● running') + c.d(`  pid ${s.pid}, up ${s.uptimeSec}s, port ${s.port}`) : c.r('● stopped')));
      console.log('  ' + (s.url ? c.u(s.url) : c.y('no tunnel URL (run: araa urls --renew)')));
      console.log(c.d(`  start: ${s.start}\n  last deploy: ${s.lastDeploy || 'none'}`));
    }
  },

  async logs(flags, pos) {
    const slot = SIDES.includes(pos[0]) ? pos[0] : 'backend';
    const n = flags.n || pos.find(p => /^\d+$/.test(p)) || '50';
    const res = await call('GET', `/logs?slot=${slot}&n=${encodeURIComponent(n)}`);
    console.log(c.d(`--- ${slot} logs ---`));
    console.log(await res.text());
  },

  async restart(flags, pos) {
    const slot = SIDES.includes(pos[0]) ? [pos[0]] : null;
    const urls = {};
    say.run(`Restarting ${slot ? slot[0] : 'everything'}`);
    const res = await post('/launch', Buffer.alloc(0), { only: slot || SIDES });
    if (!await stream(res, urls)) die('✘ Restart failed. See the lines above.');
    printSummary(null, urls);
  },

  async stop(flags, pos) {
    const slot = SIDES.includes(pos[0]) ? pos[0] : 'all';
    const r = await jsonCall('POST', '/stop?slot=' + slot);
    console.log(r.ok ? c.g(`✔ Stopped ${slot}`) : c.r('✘ ' + (r.data.error || 'failed')));
  },

  async help() {
    console.log(`
${c.b('araa')} ${VERSION}  deploy backend + frontend to your own server

  ${c.b('araa login')}                   connect to your server (once)
  ${c.b('araa init')}                    create araa.json for this project
  ${c.b('araa deploy')}                  zip, upload, install, run npm run dev,
                                 open Cloudflare URLs, write them to .env
  ${c.b('araa deploy --only backend')}   (or frontend)
  ${c.b('araa deploy --new-urls')}       also get fresh Cloudflare URLs
  ${c.b('araa urls')}                    show frontend + backend URLs
  ${c.b('araa urls --renew')}            new URLs and restart both apps
  ${c.b('araa status')}                  what is running
  ${c.b('araa logs [backend|frontend] [n]')}   app output
  ${c.b('araa restart [backend|frontend]')}    restart without uploading
  ${c.b('araa stop [backend|frontend]')}       stop the apps
  ${c.b('araa logout')}                  forget saved login

CI / scripts: set ARAA_URL and ARAA_KEY instead of running login.
`);
  },
};

function printSummary(cfg, urls, secs) {
  console.log('');
  if (secs != null) console.log(c.g(c.b(`✔ Deploy complete in ${secs}s`)) + '\n');
  if (urls.frontend) console.log('  ' + c.b('Frontend  ') + c.u(urls.frontend));
  if (urls.backend) console.log('  ' + c.b('Backend   ') + c.u(urls.backend));
  if (!urls.frontend && !urls.backend) console.log(c.y('  No URLs yet. Run: araa deploy'));
  if (cfg) {
    const fill = t => String(t).replace(/\{backendUrl\}/g, urls.backend || '').replace(/\{frontendUrl\}/g, urls.frontend || '');
    const show = (name, label) => {
      if (!cfg[name] || !cfg[name].env || !urls[name === 'frontend' ? 'backend' : 'frontend']) return;
      console.log('\n  ' + c.d(`${label} .env was updated:`));
      for (const [k, v] of Object.entries(cfg[name].env)) console.log('    ' + c.d(`${k}=${fill(v)}`));
    };
    show('frontend', 'Frontend'); show('backend', 'Backend');
  }
  console.log('');
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const cmd = pos.shift();
if (flags.version || flags.v || cmd === '-v') console.log(VERSION);
else if (!cmd || flags.help || cmd === 'help') commands.help();
else if (commands[cmd]) commands[cmd](flags, pos).catch(e => die(e.message));
else { console.error(c.r(`Unknown command: ${cmd}`)); commands.help(); process.exit(1); }
