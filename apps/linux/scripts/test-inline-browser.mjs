#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values: options } = parseArgs({ options: {
  endpoint: { type: 'string', default: 'http://127.0.0.1:9223' },
  'dashboard-url': { type: 'string' },
  output: { type: 'string' },
  hold: { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (options.help) {
  console.log(`Usage: node apps/linux/scripts/test-inline-browser.mjs [options]

Run against an already launched Windows Tauri candidate with a ready loopback
dashboard and a loopback WebView2 CDP endpoint. All test pages are synthetic.

  --endpoint URL       CDP endpoint (default http://127.0.0.1:9223)
  --dashboard-url URL  Restrict dashboard discovery to this origin and path
  --output DIRECTORY  Proof directory (default: unique OS temporary directory)
  --hold              Keep fixtures open for native UI verification; create the
                      printed continue file or press Ctrl+C to finish cleanup
  --help              Print this help without connecting to the application`);
  process.exit(0);
}
const endpoint = new URL(options.endpoint);
assert(['http:', 'https:'].includes(endpoint.protocol), 'CDP endpoint must be HTTP(S)');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'CDP must be loopback');
const dashboardUrl = options['dashboard-url'] ? new URL(options['dashboard-url']) : null;
const run = `inline-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
const out = path.resolve(options.output ?? path.join(os.tmpdir(), run));
await fs.mkdir(out, { recursive: true });
const results = { run, started: new Date().toISOString(), tests: [], observations: {}, artifacts: [] };
const connections = new Set();
const ownedTabs = new Set();
const scopes = [`${run}-primary`, `${run}-secondary`];
const sessionA = `${run}-conversation-a`, sessionB = `${run}-conversation-b`;
const requests = new Map();
let refusedUrl;
let recoverInitialRedirect = false;
let authenticatedRequests = 0;
const fixtureAuthorization = `Basic ${Buffer.from('inline-fixture:synthetic-password').toString('base64')}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, description, timeout = 15000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}

class CDP {
  static async connect(url) {
    const parsed = new URL(url);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Target CDP must be loopback');
    const cdp = new CDP();
    cdp.pending = new Map(); cdp.seq = 0; cdp.socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.socket.close(); reject(new Error('CDP connection timed out')); }, 5000);
      cdp.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      cdp.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    cdp.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const request = cdp.pending.get(message.id);
      if (!request) return;
      cdp.pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
    cdp.socket.addEventListener('close', () => {
      for (const request of cdp.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP target closed')); }
      cdp.pending.clear();
    });
    connections.add(cdp);
    return cdp;
  }
  send(method, params = {}, timeout = 20000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, userGesture = false) {
    const response = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result?.value;
  }
  close() { this.socket.close(); connections.delete(this); }
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
  if (pathname === '/cookie-set') res.setHeader('Set-Cookie', `${run}=shared-fixture-value; Path=/; SameSite=Lax`);
  if (pathname === '/cookie-clear') res.setHeader('Set-Cookie', `${run}=; Path=/; Max-Age=0; SameSite=Lax`);
  if (pathname === '/redirect') { res.writeHead(302, { Location: '/landing' }); res.end(); return; }
  if (pathname === '/failed-initial-redirect') {
    res.writeHead(302, { Location: recoverInitialRedirect ? '/recovered-initial-redirect' : refusedUrl });
    res.end(); return;
  }
  if (pathname === '/basic-auth') {
    if (req.headers.authorization !== fixtureAuthorization) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="inline-browser-fixture"' });
      res.end('Synthetic browser authentication required'); return;
    }
    authenticatedRequests += 1;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const name = pathname.slice(1) || 'home';
  res.write(`<!doctype html><html><head><meta charset="utf-8"><title>Inline fixture ${name}</title><style>html,body{margin:0;background:#e8eefc;color:#12223a;font:18px system-ui}#inspect-target{position:absolute;left:32px;top:32px;width:210px;height:64px;background:#2663eb;color:white;border:0;border-radius:8px;font-size:18px}h1{position:absolute;top:115px;left:32px}#popup{position:absolute;left:32px;top:210px}</style></head><body><button id="inspect-target" class="fixture primary" aria-label="Synthetic inspect target">Inspect me</button><h1>Inline fixture ${name}</h1><a id="popup" href="/popup" target="_blank">Open synthetic popup</a><script>window.fixtureName=${JSON.stringify(name)};</script>`);
  if (pathname === '/slow') {
    const timer = setTimeout(() => res.end('</body></html>'), 25000);
    res.on('close', () => clearTimeout(timer));
  } else res.end('</body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Allocate and close a separate loopback listener, so this initial redirect
// exercises a native connection-refused navigation rather than a 404 response.
const refusedListener = http.createServer();
await new Promise(resolve => refusedListener.listen(0, '127.0.0.1', resolve));
refusedUrl = `http://127.0.0.1:${refusedListener.address().port}/failed-target`;
await new Promise(resolve => refusedListener.close(resolve));
results.fixtureOrigin = base;
console.log(`RUN ${run}\nFixture ${base}\nResults ${out}`);

let dashboard, firstId, child, rect;
const targets = async () => {
  const response = await fetch(new URL('/json/list', endpoint), { signal: AbortSignal.timeout(5000) });
  assert(response.ok, `CDP target discovery returned HTTP ${response.status}`);
  return response.json();
};
const state = () => dashboard.evaluate('window.__OPENCLAW_NATIVE_BROWSER__');
async function post(message) {
  const reply = await dashboard.evaluate(`window.webkit.messageHandlers.openclawBrowser.postMessage(${JSON.stringify(message)})`);
  assert.equal(reply?.ok, true, `${message.type}: ${reply?.error ?? JSON.stringify(reply)}`);
  if (message.type === 'open' && reply.tabId === message.tabId) ownedTabs.add(reply.tabId);
  return reply;
}
async function tabReady(id, url) {
  return until(async () => {
    const tab = (await state())?.tabs?.find(tab => tab.id === id);
    return tab && !tab.loading && (!url || tab.url === url) && tab;
  }, `tab ${id} loaded ${url ?? ''}`);
}
async function fixtureChild(url) {
  const target = await until(async () => (await targets()).find(target => target.type === 'page' && target.url === url), `child target ${url}`);
  return CDP.connect(target.webSocketDebuggerUrl);
}
async function record(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.tests.push({ name, status: 'passed', durationMs: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.tests.push({ name, status: 'failed', durationMs: Date.now() - started, error: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
  }
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
}
async function snapshot(id, file) {
  const reply = await post({ type: 'snapshot', tabId: id });
  assert.match(reply.dataUrl, /^data:image\/png;base64,/);
  assert(reply.cssWidth > 0 && reply.cssHeight > 0);
  const png = Buffer.from(reply.dataUrl.split(',')[1], 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(png.subarray(12, 16).toString(), 'IHDR');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert(width > 0 && height > 0);
  assert(png.includes(Buffer.from('IEND')), 'PNG must contain IEND');
  await fs.writeFile(path.join(out, file), png);
  results.artifacts.push(file);
  return { cssWidth: reply.cssWidth, cssHeight: reply.cssHeight, pixelWidth: width, pixelHeight: height };
}

try {
  await record('real dashboard bridge ready', async () => {
    dashboard = await until(async () => {
      for (const target of await targets()) {
        if (target.type !== 'page' || !target.webSocketDebuggerUrl) continue;
        let url;
        try { url = new URL(target.url); } catch { continue; }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) continue;
        if (target.url.startsWith(base)) continue;
        if (dashboardUrl) {
          const basePath = dashboardUrl.pathname.replace(/\/$/, '');
          if (url.origin !== dashboardUrl.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) continue;
        }
        const candidate = await CDP.connect(target.webSocketDebuggerUrl);
        try {
          if (await candidate.evaluate('typeof window.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function" && !!window.__OPENCLAW_NATIVE_BROWSER__')) return candidate;
        } catch {}
        candidate.close();
      }
      return null;
    }, 'dashboard bridge and initial state', 30000);
    const initial = await state();
    results.observations.initialTabCount = initial.tabs.length;
    assert(Number.isSafeInteger(initial.revision));
    const size = await dashboard.evaluate('({width:innerWidth,height:innerHeight})');
    rect = { x: 20, y: 80, width: Math.min(620, size.width - 40), height: Math.min(430, size.height - 110) };
    assert(rect.width > 260 && rect.height > 260, 'Dashboard must be large enough for native presentation');
  });
  if (!dashboard) throw new Error('No ready candidate dashboard');
  await record('open publishes session-owned tab', async () => {
    const requested = `${run}-one`;
    const opened = await post({ type: 'open', tabId: requested, url: `${base}/one`, sessionKey: sessionA });
    assert.equal(opened.tabId, requested); firstId = opened.tabId;
    const tab = await tabReady(firstId, `${base}/one`);
    assert.equal(tab.sessionKey, sessionA); assert.equal(tab.openedBy, 'web');
    assert.equal(tab.title, 'Inline fixture one');
    child = await fixtureChild(`${base}/one`);
    assert.equal(await child.evaluate('window.fixtureName'), 'one');
  });
  if (!firstId || !child) throw new Error('Initial native child was not created');
  await record('per-session dedupe and conversation isolation', async () => {
    const same = await post({ type: 'open', tabId: `${run}-same`, url: `${base}/one`, sessionKey: sessionA });
    assert.equal(same.tabId, firstId);
    const other = await post({ type: 'open', tabId: `${run}-other-session`, url: `${base}/one`, sessionKey: sessionB });
    assert.notEqual(other.tabId, firstId);
    const tab = await tabReady(other.tabId, `${base}/one`); assert.equal(tab.sessionKey, sessionB);
  });
  await record('blank opens create separate new tabs', async () => {
    const a = await post({ type: 'open', tabId: `${run}-blank-a`, url: 'about:blank', sessionKey: sessionA });
    const b = await post({ type: 'open', tabId: `${run}-blank-b`, url: 'about:blank', sessionKey: sessionA });
    assert.notEqual(a.tabId, b.tabId);
    await tabReady(a.tabId, 'about:blank'); await tabReady(b.tabId, 'about:blank');
  });
  await record('redirect initial alias dedupe', async () => {
    const opened = await post({ type: 'open', tabId: `${run}-redirect`, url: `${base}/redirect`, sessionKey: sessionA });
    await tabReady(opened.tabId, `${base}/landing`);
    const alias = await post({ type: 'open', tabId: `${run}-redirect-again`, url: `${base}/redirect`, sessionKey: sessionA });
    assert.equal(alias.tabId, opened.tabId);
    const current = await post({ type: 'open', tabId: `${run}-landing-again`, url: `${base}/landing`, sessionKey: sessionA });
    assert.equal(current.tabId, opened.tabId);
  });
  await record('failed initial redirect retires its alias before a successful reopen', async () => {
    const original = `${base}/failed-initial-redirect`;
    const failed = await post({ type: 'open', tabId: `${run}-failed-initial`, url: original, sessionKey: sessionA });
    await until(() => requests.has('/failed-initial-redirect'), 'initial redirect request received');
    await tabReady(failed.tabId, refusedUrl);
    const before = requests.get('/failed-initial-redirect');
    recoverInitialRedirect = true;
    const recovered = await post({ type: 'open', tabId: `${run}-recovered-initial`, url: original, sessionKey: sessionA });
    assert.notEqual(recovered.tabId, failed.tabId, 'A failed initial alias must not reuse its stale tab');
    await until(() => requests.get('/failed-initial-redirect') > before, 'reopening starts a fresh original request');
    await tabReady(recovered.tabId, `${base}/recovered-initial-redirect`);
    const recoveredChild = await fixtureChild(`${base}/recovered-initial-redirect`);
    assert.equal(await recoveredChild.evaluate('window.fixtureName'), 'recovered-initial-redirect');
    recoveredChild.close();
    const alias = await post({ type: 'open', tabId: `${run}-recovered-alias`, url: original, sessionKey: sessionA });
    assert.equal(alias.tabId, recovered.tabId, 'Only the successful replacement retains the redirect alias');
    return { failedTabId: failed.tabId, recoveredTabId: recovered.tabId };
  });
  await record('credential-bearing HTTP URL authenticates a synthetic native page', async () => {
    const url = new URL(`${base}/basic-auth`);
    url.username = 'inline-fixture'; url.password = 'synthetic-password';
    const opened = await post({ type: 'open', tabId: `${run}-basic-auth`, url: url.href, sessionKey: sessionA });
    await until(() => authenticatedRequests > 0, 'native HTTP Basic authorization reaches synthetic fixture');
    const tab = await tabReady(opened.tabId);
    assert.equal(new URL(tab.url).pathname, '/basic-auth');
    const target = await until(async () => (await targets()).find(target => {
      if (target.type !== 'page') return false;
      try { const current = new URL(target.url); return current.origin === base && current.pathname === '/basic-auth'; }
      catch { return false; }
    }), 'authenticated native child target');
    const authenticatedChild = await CDP.connect(target.webSocketDebuggerUrl);
    assert.equal(await authenticatedChild.evaluate('window.fixtureName'), 'basic-auth');
    authenticatedChild.close();
  });
  await record('synthetic browser cookie session shared across child tabs', async () => {
    const setter = await post({ type: 'open', tabId: `${run}-cookie-set`, url: `${base}/cookie-set`, sessionKey: sessionA });
    await tabReady(setter.tabId, `${base}/cookie-set`);
    const reader = await post({ type: 'open', tabId: `${run}-cookie-read`, url: `${base}/cookie-read`, sessionKey: sessionB });
    await tabReady(reader.tabId, `${base}/cookie-read`);
    const cookieChild = await fixtureChild(`${base}/cookie-read`);
    const present = await cookieChild.evaluate(`document.cookie.split('; ').includes(${JSON.stringify(`${run}=shared-fixture-value`)})`);
    cookieChild.close();
    assert.equal(present, true, 'Synthetic cookie is shared across child views');
    await post({ type: 'navigate', tabId: setter.tabId, url: `${base}/cookie-clear` });
    await tabReady(setter.tabId, `${base}/cookie-clear`);
  });
  await record('present scope uses dashboard CSS pixel bounds', async () => {
    await post({ type: 'present', scope: scopes[0], tabId: firstId, rect, visible: true });
    return until(async () => {
      const size = await child.evaluate('({width:innerWidth,height:innerHeight,visibility:document.visibilityState})');
      return Math.abs(size.width - rect.width) <= 1 && Math.abs(size.height - rect.height) <= 1 && size;
    }, 'native child viewport equals presentation rectangle');
  });
  await record('latest scope wins; hidden scope restores earlier scope', async () => {
    const small = { ...rect, width: rect.width - 80, height: rect.height - 60 };
    await post({ type: 'present', scope: scopes[1], tabId: firstId, rect: small, visible: true });
    await until(async () => Math.abs((await child.evaluate('innerWidth')) - small.width) <= 1, 'latest scope width');
    await post({ type: 'present', scope: scopes[1], tabId: firstId, rect: small, visible: false });
    await until(async () => Math.abs((await child.evaluate('innerWidth')) - rect.width) <= 1, 'original scope restored');
    await post({ type: 'present', scope: scopes[0], tabId: null, rect: null, visible: false });
    results.observations.hiddenVisibilityState = await child.evaluate('document.visibilityState');
    assert((await state()).tabs.some(tab => tab.id === firstId), 'Hide retains tab');
    await post({ type: 'present', scope: scopes[0], tabId: firstId, rect, visible: true });
    await until(async () => Math.abs((await child.evaluate('innerWidth')) - rect.width) <= 1, 'scope restored after hide');
    results.observations.shownVisibilityState = await child.evaluate('document.visibilityState');
    await post({ type: 'present', scope: scopes[1], tabId: firstId, rect: small, visible: true });
    await until(async () => Math.abs((await child.evaluate('innerWidth')) - small.width) <= 1, 'latest scope reapplied');
    await post({ type: 'release-scope', scope: scopes[1] });
    await until(async () => Math.abs((await child.evaluate('innerWidth')) - rect.width) <= 1, 'release restores earlier scope');
    return { hidden: results.observations.hiddenVisibilityState, shown: results.observations.shownVisibilityState, visibilityRequiresNativeScreenshot: results.observations.hiddenVisibilityState === results.observations.shownVisibilityState };
  });
  await record('snapshot returns valid PNG and positive CSS size', async () => snapshot(firstId, 'native-snapshot.png'));
  await record('inspect returns synthetic button metadata', async () => {
    const reply = await post({ type: 'inspect', tabId: firstId, x: 60, y: 55 });
    assert(reply.node, 'Expected node at fixture coordinates');
    assert.equal(reply.node.tag.toLowerCase(), 'button');
    assert.equal(reply.node.id, 'inspect-target');
    assert(reply.node.classes.includes('fixture'));
    assert.equal(reply.node.name, 'Synthetic inspect target');
    assert.equal(reply.node.focusable, true);
    assert(reply.node.rect.width > 0 && reply.node.rect.height > 0);
    return reply.node;
  });
  await record('navigate, back, forward, reload preserve tab identity', async () => {
    await post({ type: 'navigate', tabId: firstId, url: `${base}/two` });
    const two = await tabReady(firstId, `${base}/two`); assert.equal(two.canGoBack, true);
    await post({ type: 'back', tabId: firstId });
    const one = await tabReady(firstId, `${base}/one`); assert.equal(one.canGoForward, true);
    await post({ type: 'forward', tabId: firstId }); await tabReady(firstId, `${base}/two`);
    const before = requests.get('/two') ?? 0;
    await post({ type: 'reload', tabId: firstId });
    await until(() => (requests.get('/two') ?? 0) > before, 'reload causes fixture request');
    await tabReady(firstId, `${base}/two`);
    assert.equal(await child.evaluate('window.fixtureName'), 'two');
  });
  await record('SPA pushState, hash, and history navigation update native state', async () => {
    // Native Chromium Back skips history entries created without user activation.
    // Exercise the user-initiated SPA path, as with the popup interaction below.
    await child.evaluate('history.pushState({fixture:true}, "", "/spa-pushed"); document.title="Inline fixture SPA"', true);
    await until(async () => { const tab = (await state()).tabs.find(tab => tab.id === firstId); return tab.url === `${base}/spa-pushed` && tab.title === 'Inline fixture SPA' && tab.canGoBack; }, 'SPA URL and title publication');
    await child.evaluate('location.hash="fixture-fragment"', true);
    await until(async () => (await state()).tabs.find(tab => tab.id === firstId).url === `${base}/spa-pushed#fixture-fragment`, 'hash URL publication');
    await post({ type: 'back', tabId: firstId });
    await until(async () => { const tab = (await state()).tabs.find(tab => tab.id === firstId); return tab.url === `${base}/spa-pushed` && tab.canGoForward; }, 'hash back updates state');
    await post({ type: 'forward', tabId: firstId });
    await until(async () => (await state()).tabs.find(tab => tab.id === firstId).url === `${base}/spa-pushed#fixture-fragment`, 'hash forward updates state');
  });
  await record('stop ends a pending synthetic navigation', async () => {
    await post({ type: 'navigate', tabId: firstId, url: `${base}/slow` });
    await until(async () => (await state()).tabs.find(tab => tab.id === firstId)?.loading === true, 'slow navigation enters loading');
    await until(() => requests.has('/slow'), 'slow fixture received request');
    await post({ type: 'stop', tabId: firstId });
    await tabReady(firstId, undefined);
    await post({ type: 'navigate', tabId: firstId, url: `${base}/one` }); await tabReady(firstId, `${base}/one`);
  });
  await record('popup inherits opener and conversation session', async () => {
    await child.evaluate('document.getElementById("popup").click()', true);
    const popup = await until(async () => (await state()).tabs.find(tab => tab.openerTabId === firstId && tab.url === `${base}/popup`), 'popup publication');
    ownedTabs.add(popup.id);
    assert.equal(popup.sessionKey, sessionA); assert.equal(popup.openedBy, 'native');
    await tabReady(popup.id, `${base}/popup`);
    const popupChild = await fixtureChild(`${base}/popup`);
    assert.equal(await popupChild.evaluate('window.fixtureName'), 'popup'); popupChild.close();
  });
  await record('release-scope retains native tabs', async () => {
    await post({ type: 'release-scope', scope: scopes[0] });
    await post({ type: 'release-scope', scope: scopes[1] });
    assert((await state()).tabs.some(tab => tab.id === firstId));
  });
  await record('dashboard reload retains tabs and repopulates state', async () => {
    const ids = (await state()).tabs.filter(tab => [sessionA, sessionB].includes(tab.sessionKey)).map(tab => tab.id).sort();
    await dashboard.evaluate(`window.__INLINE_LIVE_DOCUMENT_MARKER__=${JSON.stringify(run)}`);
    await dashboard.send('Page.reload');
    await until(async () => await dashboard.evaluate('!window.__INLINE_LIVE_DOCUMENT_MARKER__ && typeof window.webkit?.messageHandlers?.openclawBrowser?.postMessage === "function" && !!window.__OPENCLAW_NATIVE_BROWSER__'), 'ready bridge after dashboard reload', 30000);
    const retained = (await state()).tabs.filter(tab => [sessionA, sessionB].includes(tab.sessionKey));
    assert.deepEqual(retained.map(tab => tab.id).sort(), ids);
    assert(retained.some(tab => tab.sessionKey === sessionA) && retained.some(tab => tab.sessionKey === sessionB));
    await post({ type: 'present', scope: scopes[0], tabId: firstId, rect, visible: true });
    await snapshot(firstId, 'native-snapshot-after-dashboard-reload.png');
  });
  await record('close removes only requested synthetic tab', async () => {
    const id = `${run}-blank-a`;
    const before = (await state()).tabs.map(tab => tab.id).filter(tabId => tabId !== id).sort();
    await post({ type: 'close', tabId: id }); ownedTabs.delete(id);
    await until(async () => !(await state()).tabs.some(tab => tab.id === id), 'closed tab removed');
    assert.deepEqual((await state()).tabs.map(tab => tab.id).sort(), before);
  });
  if (options.hold) {
    const releaseFile = path.join(out, 'continue');
    console.log(`HOLD: fixture and synthetic tabs remain for native UI verification. Main tab ${firstId}. Create ${releaseFile} or send Ctrl+C to clean up.`);
    await new Promise(resolve => {
      const finish = () => { clearInterval(timer); resolve(); };
      const timer = setInterval(() => fs.access(releaseFile).then(finish, () => {}), 300);
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
    });
  }
} catch (error) {
  results.fatal = error.stack; console.error(error.stack);
} finally {
  if (dashboard) {
    await record('cleanup removes only this run synthetic tabs and scopes', async () => {
      const errors = [];
      const attempt = async fn => { try { await fn(); } catch (error) { errors.push(error); } };
      for (const scope of scopes) await attempt(() => post({ type: 'release-scope', scope }));
      const current = await state();
      for (const tab of current.tabs) {
        if ([sessionA, sessionB].includes(tab.sessionKey)) ownedTabs.add(tab.id);
      }
      const cleaner = current.tabs.find(tab => ownedTabs.has(tab.id) && tab.url.startsWith(base));
      if (cleaner) {
        await attempt(async () => {
          await post({ type: 'navigate', tabId: cleaner.id, url: `${base}/cookie-clear` });
          await tabReady(cleaner.id, `${base}/cookie-clear`);
        });
      }
      for (const id of ownedTabs) {
        if (current.tabs.some(tab => tab.id === id)) await attempt(() => post({ type: 'close', tabId: id }));
      }
      assert(!(await state()).tabs.some(tab => [sessionA, sessionB].includes(tab.sessionKey)));
      if (errors.length) throw new AggregateError(errors, 'Some native browser cleanup requests failed');
    });
  }
  for (const cdp of [...connections]) cdp.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  results.finished = new Date().toISOString();
  results.passed = results.tests.filter(test => test.status === 'passed').length;
  results.failed = results.tests.filter(test => test.status === 'failed').length;
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`RESULT ${results.passed} passed, ${results.failed} failed${results.fatal ? ', fatal setup/runtime error' : ''}`);
  process.exitCode = results.failed || results.fatal ? 1 : 0;
}
