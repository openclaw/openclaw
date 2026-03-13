#!/usr/bin/env node
// cdp - lightweight Chrome DevTools Protocol CLI
// Uses raw CDP over WebSocket, no Puppeteer dependency.
// Requires Node 22+ (built-in WebSocket).
//
// Per-tab persistent daemon: page commands go through a daemon that holds
// the CDP session open. Chrome's "Allow debugging" modal fires once per
// daemon (= once per tab). Daemons auto-exit after 20min idle.

import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';
import net from 'net';

const TIMEOUT = 15000;
const NAVIGATION_TIMEOUT = 30000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const MIN_TARGET_PREFIX_LEN = 8;
const SOCK_PREFIX = '/tmp/cdp-';
const PAGES_CACHE = '/tmp/cdp-pages.json';

function sockPath(targetId) { return `${SOCK_PREFIX}${targetId}.sock`; }

function getWsUrl() {
  const portFile = resolve(homedir(), 'Library/Application Support/Google/Chrome/DevToolsActivePort');
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function listDaemonSockets() {
  return readdirSync('/tmp')
    .filter(f => f.startsWith('cdp-') && f.endsWith('.sock'))
    .map(f => ({
      targetId: f.slice(4, -5),
      socketPath: `/tmp/${f}`,
    }));
}

function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(candidate => candidate.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

// ---------------------------------------------------------------------------
// CDP WebSocket client
// ---------------------------------------------------------------------------

class CDP {
  #ws; #id = 0; #pending = new Map(); #eventHandlers = new Map(); #closeHandlers = [];

  async connect(wsUrl) {
    return new Promise((res, rej) => {
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => res();
      this.#ws.onerror = (e) => rej(new Error('WebSocket error: ' + (e.message || e.type)));
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      let timer; 
      
      const wrappedResolve = (val) => { clearTimeout(timer); resolve(val); };
      const wrappedReject = (err) => { clearTimeout(timer); reject(err); };
      
      this.#pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      
      timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          wrappedReject(new Error(`Timeout: ${method}`));
        }
      }, TIMEOUT);
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() { this.#ws.close(); }
}

// ---------------------------------------------------------------------------
// Command implementations — return strings, take (cdp, sessionId)
// ---------------------------------------------------------------------------

async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function formatPageList(pages) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

function shouldShowAxNode(node, compact = false) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  if (compact && role === 'InlineTextBox') return false;
  return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
}

function formatAxNode(node, depth) {
  const role = node.role?.value || '';
  const name = node.name?.value ?? '';
  const value = node.value?.value;
  const indent = '  '.repeat(Math.min(depth, 10));
  let line = `${indent}[${role}]`;
  if (name !== '') line += ` ${name}`;
  if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
  return line;
}

function orderedAxChildren(node, nodesById, childrenByParent) {
  const children = [];
  const seen = new Set();
  for (const childId of node.childIds || []) {
    const child = nodesById.get(childId);
    if (child && !seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  for (const child of childrenByParent.get(node.nodeId) || []) {
    if (!seen.has(child.nodeId)) {
      seen.add(child.nodeId);
      children.push(child);
    }
  }
  return children;
}

async function snapshotStr(cdp, sid, compact = false, selector = null) {
  let nodes;
  if (selector) {
    // Scoped: resolve selector → DOM node → accessibility subtree
    await cdp.send('DOM.enable', {}, sid);
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 }, sid);
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
    if (!nodeId) throw new Error(`Element not found: ${selector}`);
    const { object } = await cdp.send('DOM.resolveNode', { nodeId }, sid);
    const result = await cdp.send('Accessibility.queryAXTree', { objectId: object.objectId }, sid);
    nodes = result.nodes;
  } else {
    ({ nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sid));
  }
  const nodesById = new Map(nodes.map(node => [node.nodeId, node]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShowAxNode(node, compact)) lines.push(formatAxNode(node, depth));
    for (const child of orderedAxChildren(node, nodesById, childrenByParent)) {
      visit(child, depth + 1);
    }
  }

  const roots = nodes.filter(node => !node.parentId || !nodesById.has(node.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

async function shotStr(cdp, sid, filePath) {
  let dpr = 1;
  try {
    const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
    const parsed = parseFloat(raw);
    if (parsed > 0) dpr = parsed;
  } catch {}

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid);
  const out = filePath || '/tmp/screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved. Device pixel ratio (DPR): ${dpr}`);
  lines.push(`Coordinate mapping:`);
  lines.push(`  Screenshot pixels → CSS pixels (for CDP Input events): divide by ${dpr}`);
  lines.push(`  e.g. screenshot point (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200) → use clickxy <target> 100 200`);
  if (dpr !== 1) {
    lines.push(`  On this ${dpr}x display: CSS px = screenshot px / ${dpr} ≈ screenshot px × ${Math.round(100/dpr)/100}`);
  }
  return lines.join('\n');
}

async function htmlStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
    : `document.documentElement.outerHTML`;
  return evalStr(cdp, sid, expr);
}

async function waitForDocumentReady(cdp, sid, timeoutMs = NAVIGATION_TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) {
    throw new Error(`Timed out waiting for navigation to finish (last readyState: ${lastState})`);
  }
  if (lastError) {
    throw new Error(`Timed out waiting for navigation to finish (${lastError.message})`);
  }
  throw new Error('Timed out waiting for navigation to finish');
}

async function navStr(cdp, sid, url) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}

async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  return JSON.parse(raw).map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  ).join('\n');
}

// Click element by CSS selector
async function clickStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Clicked <${r.tag}> "${r.text}"`;
}

// Click at CSS pixel coordinates using Input.dispatchMouseEvent
async function clickXyStr(cdp, sid, x, y) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked at CSS (${cx}, ${cy})`;
}

// Type text using Input.insertText (works in cross-origin iframes, unlike eval)
async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

// Send a key press (Enter, Tab, Escape, etc.) using Input.dispatchKeyEvent
const KEY_MAP = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  space: { key: ' ', code: 'Space', keyCode: 32 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

async function keyStr(cdp, sid, keyName) {
  if (!keyName) throw new Error(`Key name required. Supported: ${Object.keys(KEY_MAP).join(', ')}`);
  const mapped = KEY_MAP[keyName.toLowerCase()];
  if (!mapped) throw new Error(`Unknown key: ${keyName}. Supported: ${Object.keys(KEY_MAP).join(', ')}`);
  const base = { key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.keyCode, nativeVirtualKeyCode: mapped.keyCode };
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' }, sid);
  await cdp.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, sid);
  return `Pressed ${mapped.key}`;
}

// Scroll the viewport
async function scrollStr(cdp, sid, direction = 'down') {
  const scrollMap = {
    down: 'window.scrollBy(0, window.innerHeight * 0.8)',
    up: 'window.scrollBy(0, -window.innerHeight * 0.8)',
    top: 'window.scrollTo(0, 0)',
    bottom: 'window.scrollTo(0, document.body.scrollHeight)',
  };
  const expr = scrollMap[direction.toLowerCase()];
  if (!expr) throw new Error(`Unknown direction: ${direction}. Use: down, up, top, bottom`);
  await evalStr(cdp, sid, expr);
  const pos = await evalStr(cdp, sid, 'JSON.stringify({ y: Math.round(window.scrollY), max: Math.round(document.body.scrollHeight - window.innerHeight) })');
  const { y, max } = JSON.parse(pos);
  return `Scrolled ${direction} — position: ${y}/${max}px`;
}

// Wait for a CSS selector to appear in the DOM
async function waitStr(cdp, sid, selector, timeoutMs = 10000) {
  if (!selector) throw new Error('CSS selector required');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (found === 'true') return `Element found: ${selector}`;
    await sleep(300);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${selector}`);
}

// Load-more: repeatedly click a button/selector until it disappears
async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000; // 5-minute hard cap
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

// Send a raw CDP command and return the result as JSON
async function evalRawStr(cdp, sid, method, paramsJson) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');
  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}

// Page info summary for agent orientation
async function infoStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify({
    url: location.href,
    title: document.title,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    scroll: { y: Math.round(window.scrollY), max: Math.round(document.body.scrollHeight - window.innerHeight) },
    focus: (() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
      const name = el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '';
      return { tag, selector: tag + id + cls + name, type: el.type || null, value: (el.value || '').substring(0, 80) };
    })(),
    forms: document.forms.length,
    iframes: document.querySelectorAll('iframe').length,
  })`);
  const info = JSON.parse(raw);
  const lines = [
    `URL:      ${info.url}`,
    `Title:    ${info.title}`,
    `Viewport: ${info.viewport.w}x${info.viewport.h}`,
    `Scroll:   ${info.scroll.y}/${info.scroll.max}px`,
  ];
  if (info.focus) lines.push(`Focus:    <${info.focus.tag}> ${info.focus.selector}${info.focus.value ? ' = "' + info.focus.value + '"' : ''}`);
  else lines.push(`Focus:    (none)`);
  if (info.forms) lines.push(`Forms:    ${info.forms}`);
  if (info.iframes) lines.push(`Iframes:  ${info.iframes}`);
  return lines.join('\n');
}

// Focus an element without clicking (no toggle side effects)
async function focusStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    el.focus();
    return { ok: true, tag: el.tagName, type: el.type || null };
  })()`);
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error);
  return `Focused <${r.tag}>${r.type ? ' type=' + r.type : ''}`;
}

// Clear an input/textarea/contenteditable using native setter for React compat
async function clearStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea') {
      const nativeSet = Object.getOwnPropertyDescriptor(
        tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value'
      )?.set;
      if (nativeSet) nativeSet.call(el, '');
      else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, tag: el.tagName };
    }
    if (el.isContentEditable) {
      el.textContent = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, tag: el.tagName };
    }
    return { ok: false, error: 'Element is not an input, textarea, or contenteditable' };
  })()`);
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error);
  return `Cleared <${r.tag}>`;
}

// Pick a <select> option by value or visible text
async function selectStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null) throw new Error('value required');
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    if (el.tagName !== 'SELECT') return { ok: false, error: 'Element is not a <select> (found <' + el.tagName + '>)' };
    const opt = Array.from(el.options).find(o => o.value === ${JSON.stringify(value)} || o.textContent.trim() === ${JSON.stringify(value)});
    if (!opt) {
      const avail = Array.from(el.options).map(o => o.value + ' (' + o.textContent.trim() + ')').join(', ');
      return { ok: false, error: 'Option not found: ' + ${JSON.stringify(value)} + '. Available: ' + avail };
    }
    el.value = opt.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true, value: opt.value, text: opt.textContent.trim() };
  })()`);
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error);
  return `Selected "${r.text}" (value: ${r.value})`;
}

// Get text content (innerText, not HTML)
async function textStr(cdp, sid, selector) {
  const expr = selector
    ? `document.querySelector(${JSON.stringify(selector)})?.innerText || 'Element not found'`
    : `document.body.innerText`;
  return evalStr(cdp, sid, expr);
}

// Hover an element via CDP mouse events (triggers :hover and JS handlers)
async function hoverStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');
  const raw = await evalStr(cdp, sid, `(function() {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName };
  })()`);
  const r = JSON.parse(raw);
  if (!r.ok) throw new Error(r.error);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y }, sid);
  return `Hovered <${r.tag}> at CSS (${r.x}, ${r.y})`;
}

// Navigate back in history
async function backStr(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  await evalStr(cdp, sid, 'history.back()');
  try { await loadEvent.promise; } catch { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, sid, 5000);
  const url = await evalStr(cdp, sid, 'location.href');
  return `Back: ${url}`;
}

// Navigate forward in history
async function forwardStr(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  await evalStr(cdp, sid, 'history.forward()');
  try { await loadEvent.promise; } catch { loadEvent.cancel(); }
  await waitForDocumentReady(cdp, sid, 5000);
  const url = await evalStr(cdp, sid, 'location.href');
  return `Forward: ${url}`;
}

// Reload current page
async function reloadStr(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', NAVIGATION_TIMEOUT);
  await cdp.send('Page.reload', {}, sid);
  await loadEvent.promise;
  await waitForDocumentReady(cdp, sid, 5000);
  const url = await evalStr(cdp, sid, 'location.href');
  return `Reloaded: ${url}`;
}

// Wait for a CSS selector to disappear from the DOM
async function waitGoneStr(cdp, sid, selector, timeoutMs = 10000) {
  if (!selector) throw new Error('CSS selector required');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (found !== 'true') return `Element gone: ${selector}`;
    await sleep(300);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for element to disappear: ${selector}`);
}

// Return recent console messages from daemon ring buffer
function consoleStr(consoleBuf, count = 20) {
  const entries = consoleBuf.slice(-count);
  if (entries.length === 0) return '(no console messages)';
  return entries.map(e => {
    const age = Math.round((Date.now() - e.ts) / 1000);
    return `[${e.type}] ${age}s ago: ${e.text}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Per-tab daemon
// ---------------------------------------------------------------------------

async function runDaemon(targetId) {
  const sp = sockPath(targetId);

  const cdp = new CDP();
  try {
    await cdp.connect(getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Console log capture — ring buffer of last 100 entries
  const consoleBuf = [];
  const CONSOLE_BUF_MAX = 100;
  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    cdp.onEvent('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'debug') return;
      const text = (params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      consoleBuf.push({ type: params.type, text: text.substring(0, 500), ts: Date.now() });
      if (consoleBuf.length > CONSOLE_BUF_MAX) consoleBuf.shift();
    });
  } catch {}

  // Shutdown helpers
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  // Exit if target goes away or Chrome disconnects
  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  // Handle a command
  async function handleCommand({ cmd, args }) {
    resetIdle();
    try {
      let result;
      switch (cmd) {
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': result = await snapshotStr(cdp, sessionId, true, args[0] || null); break;
        case 'eval': result = await evalStr(cdp, sessionId, args[0]); break;
        case 'shot': case 'screenshot': result = await shotStr(cdp, sessionId, args[0]); break;
        case 'html': result = await htmlStr(cdp, sessionId, args[0]); break;
        case 'info': result = await infoStr(cdp, sessionId); break;
        case 'text': result = await textStr(cdp, sessionId, args[0]); break;
        case 'nav': case 'navigate': result = await navStr(cdp, sessionId, args[0]); break;
        case 'back': result = await backStr(cdp, sessionId); break;
        case 'forward': result = await forwardStr(cdp, sessionId); break;
        case 'reload': result = await reloadStr(cdp, sessionId); break;
        case 'net': case 'network': result = await netStr(cdp, sessionId); break;
        case 'click': result = await clickStr(cdp, sessionId, args[0]); break;
        case 'clickxy': result = await clickXyStr(cdp, sessionId, args[0], args[1]); break;
        case 'hover': result = await hoverStr(cdp, sessionId, args[0]); break;
        case 'focus': result = await focusStr(cdp, sessionId, args[0]); break;
        case 'clear': result = await clearStr(cdp, sessionId, args[0]); break;
        case 'select': result = await selectStr(cdp, sessionId, args[0], args[1]); break;
        case 'type': result = await typeStr(cdp, sessionId, args[0]); break;
        case 'key': result = await keyStr(cdp, sessionId, args[0]); break;
        case 'scroll': result = await scrollStr(cdp, sessionId, args[0] || 'down'); break;
        case 'wait': result = await waitStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 10000); break;
        case 'waitgone': result = await waitGoneStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 10000); break;
        case 'console': result = consoleStr(consoleBuf, args[0] ? parseInt(args[0]) : 20); break;
        case 'loadall': result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500); break;
        case 'evalraw': result = await evalRawStr(cdp, sessionId, args[0], args[1]); break;
        case 'stop': return { ok: true, result: '', stopAfter: true };
        default: return { ok: false, error: `Unknown command: ${cmd}` };
      }
      return { ok: true, result: result ?? '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server — NDJSON protocol
  // Wire format: each message is one JSON object followed by \n (newline-delimited JSON).
  // Request:  { "id": <number>, "cmd": "<command>", "args": ["arg1", "arg2", ...] }
  // Response: { "id": <number>, "ok": <boolean>, "result": "<string>" }
  //           or { "id": <number>, "ok": false, "error": "<message>" }
  const server = net.createServer((conn) => {
    let buf = '';
    let queue = Promise.resolve();
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        queue = queue.then(() =>
          handleCommand(req).then((res) => {
            const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
            if (res.stopAfter) conn.end(payload, shutdown);
            else conn.write(payload);
          })
        );
      }
    });
  });

  try { unlinkSync(sp); } catch {}
  server.listen(sp);
}

// ---------------------------------------------------------------------------
// CLI ↔ daemon communication
// ---------------------------------------------------------------------------

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function getOrStartTabDaemon(targetId) {
  const sp = sockPath(targetId);
  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  try { unlinkSync(sp); } catch {}

  // Spawn daemon
  const child = spawn(process.execPath, [process.argv[1], '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for socket (includes time for user to click Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

// Find any running daemon socket to reuse for list
function findAnyDaemonSocket() {
  return listDaemonSockets()[0]?.socketPath || null;
}

// ---------------------------------------------------------------------------
// Stop daemons
// ---------------------------------------------------------------------------

async function stopDaemons(targetPrefix) {
  const daemons = listDaemonSockets();

  if (targetPrefix) {
    const targetId = resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon');
    const daemon = daemons.find(d => d.targetId === targetId);
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(daemon.socketPath); } catch {}
    }
    return;
  }

  for (const daemon of daemons) {
    try {
      const conn = await connectToSocket(daemon.socketPath);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(daemon.socketPath); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `cdp - lightweight Chrome DevTools Protocol CLI (no Puppeteer)

Usage: cdp <command> [args]

PAGE DISCOVERY
  list                              List open pages (shows unique target prefixes)
  info    <target>                  Page state: URL, title, viewport, scroll, focus, forms, iframes

READING
  snap    <target> [selector]       Accessibility tree snapshot (full page or scoped to selector)
  text    <target> [selector]       Get text content (innerText, not HTML)
  html    <target> [selector]       Get HTML (full page or CSS selector)
  eval    <target> <expr>           Evaluate JS expression
  shot    <target> [file]           Screenshot (default: /tmp/screenshot.png); prints coordinate mapping
  net     <target>                  Network performance entries
  console <target> [count]          Show last N console messages (default 20)

NAVIGATION
  nav     <target> <url>            Navigate to URL and wait for load completion
  back    <target>                  Navigate back in history and wait for load
  forward <target>                  Navigate forward in history and wait for load
  reload  <target>                  Reload page and wait for load
  scroll  <target> [direction]      Scroll: down (default), up, top, bottom

INTERACTION
  click   <target> <selector>       Click an element by CSS selector
  clickxy <target> <x> <y>          Click at CSS pixel coordinates (see coordinate note below)
  hover   <target> <selector>       Hover an element (triggers :hover CSS and mouse events)
  focus   <target> <selector>       Focus an element (no click side effects)
  clear   <target> <selector>       Clear an input/textarea/contenteditable
  type    <target> <text>           Type text at current focus via Input.insertText
                                    Works in cross-origin iframes unlike eval-based approaches
  key     <target> <key>            Send a key press (Enter, Tab, Escape, Backspace, ArrowDown, etc.)
  select  <target> <selector> <val> Pick a <select> option by value or visible text

WAITING
  wait     <target> <selector> [ms] Wait for CSS selector to appear (default 10000ms timeout)
  waitgone <target> <selector> [ms] Wait for element to disappear (default 10000ms timeout)
  loadall  <target> <selector> [ms] Repeatedly click "load more" until gone (default 1500ms, 5min cap)

ADVANCED
  evalraw <target> <method> [json]  Send a raw CDP command; returns JSON result
                                    e.g. evalraw <t> "DOM.getDocument" '{}'
  stop    [target]                  Stop daemon(s)

<target> is a unique targetId prefix from "cdp list". If a prefix is ambiguous,
use more characters.

COORDINATE SYSTEM
  shot captures the viewport at the device's native resolution.
  The screenshot image size = CSS pixels × DPR (device pixel ratio).
  For CDP Input events (clickxy, etc.) you need CSS pixels, not image pixels.

    CSS pixels = screenshot image pixels / DPR

  shot prints the DPR and an example conversion for the current page.
  Typical Retina (DPR=2): CSS px ≈ screenshot px × 0.5
  If your viewer rescales the image further, account for that scaling too.

EVAL SAFETY NOTE
  Avoid index-based DOM selection (querySelectorAll(...)[i]) across multiple
  eval calls when the list can change between calls (e.g. after clicking
  "Ignore" buttons on a feed — indices shift). Prefer stable selectors or
  collect all data in a single eval.

FORM FILLING PATTERN
  focus <t> "#email"  →  clear <t> "#email"  →  type <t> "user@example.com"  →  key <t> Tab
  select <t> "#country" "US"  (lists available options on failure)

DAEMON IPC (for advanced use / scripting)
  Each tab runs a persistent daemon at Unix socket: /tmp/cdp-<fullTargetId>.sock
  Protocol: newline-delimited JSON (one JSON object per line, UTF-8).
    Request:  {"id":<number>, "cmd":"<command>", "args":["arg1","arg2",...]}
    Response: {"id":<number>, "ok":true,  "result":"<string>"}
           or {"id":<number>, "ok":false, "error":"<message>"}
  Commands mirror the CLI. Use evalraw to send arbitrary CDP methods.
  The socket disappears after 20 min of inactivity or when the tab closes.
`;

const NEEDS_TARGET = new Set([
  'snap','snapshot','eval','shot','screenshot','html','nav','navigate',
  'back','forward','reload','info','text','console',
  'net','network','click','clickxy','hover','focus','clear','select',
  'type','key','scroll','wait','waitgone','loadall','evalraw',
]);

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') { await runDaemon(args[0]); return; }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE); process.exit(0);
  }

  // List — use existing daemon if available, otherwise direct
  if (cmd === 'list' || cmd === 'ls') {
    let pages;
    const existingSock = findAnyDaemonSocket();
    if (existingSock) {
      try {
        const conn = await connectToSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch {}
    }
    if (!pages) {
      // No daemon running — connect directly (will trigger one Allow)
      const cdp = new CDP();
      await cdp.connect(getWsUrl());
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(PAGES_CACHE, JSON.stringify(pages));
    console.log(formatPageList(pages));
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0]);
    return;
  }

  // Page commands — need target prefix
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "cdp list" first.');
    process.exit(1);
  }

  // Resolve prefix → full targetId from cache or running daemon
  let targetId;
  const daemonTargetIds = listDaemonSockets().map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(PAGES_CACHE)) {
      console.error('No page list cached. Run "cdp list" first.');
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "cdp list".');
  }

  const conn = await getOrStartTabDaemon(targetId);

  const cmdArgs = args.slice(1);

  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
    cmdArgs.length = 1; 
  } else if (cmd === 'type') {
    // Join all remaining args as text (allows spaces)
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
    cmdArgs.length = 1; 
  } else if (cmd === 'select') {
    // args: [selector, ...valueParts] — join value parts to allow spaces
    if (!cmdArgs[0]) { console.error('Error: CSS selector required'); process.exit(1); }
    if (!cmdArgs[1]) { console.error('Error: value required'); process.exit(1); }
    if (cmdArgs.length > 2) { cmdArgs[1] = cmdArgs.slice(1).join(' '); cmdArgs.length = 2; }
  } else if (cmd === 'evalraw') {
    // args: [method, ...jsonParts] — join json parts in case of spaces
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) { cmdArgs[1] = cmdArgs.slice(1).join(' '); cmdArgs.length = 2; }
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
