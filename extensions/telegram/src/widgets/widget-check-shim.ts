// Guest program for the widget trial run. It runs inside QuickJS before the widget's scripts and
// stands in for Telegram's widget runtime: a small DOM, the TelegramWidget API, virtual timers and
// simulated taps, then reports what Telegram would drop, stop or show broken.
// Behavior follows https://core.telegram.org/bots/widgets; no Telegram client code is used.
// The program is a plain string so bundling cannot rewrite it; it avoids backticks and "${".
import { TELEGRAM_WIDGET_CHECK_SHIM_DOM } from "./widget-check-shim-dom.js";

const SHIM_HEAD = String.raw`(function () {
"use strict";
var G = globalThis;
var SOURCE = G.__widgetSource;
var STRING_LITERAL = /(["'\x60])(?:\\.|(?!\1)[^\\])*\1/g;
var LITERAL_TEXT = SOURCE
  .replace(/<script\b[\s\S]*?<\/script>/gi, function (m) { return " " + (m.match(STRING_LITERAL) || []).join(" ") + " "; })
  .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
var STATE = G.__widgetState;
var errors = [];
var seen = new Set();
var context = "while loading";
var gesture = false;
var maxHeavy = 0, maxBackdrop = 0, maxNodes = 0, maxRules = 0;
// The host drains promise jobs between driver calls; QuickJS cannot run them re-entrantly.
G.__drainJobs = function () {};
G.queueMicrotask = G.queueMicrotask || function (f) { Promise.resolve().then(f); };
// Approximate checks (CSS paint projection, visible undefined/NaN) warn but never block.
var warnings = [];
function warn(msg) {
  if (seen.has(msg) || warnings.length >= 6) return;
  seen.add(msg);
  warnings.push(msg);
}
function fail(msg) {
  if (seen.has(msg) || errors.length >= 12) return;
  seen.add(msg);
  errors.push(msg);
}
function describe(e) {
  if (e === null || typeof e !== "object") return "Uncaught " + String(e);
  var stack = String(e.stack || "");
  var m = /(script-(\d+)|inline-handler)\.js:(\d+)/.exec(stack);
  var at = m ? (m[2] ? " (script " + m[2] + ", line " + m[3] + ")" : " (in an inline on* handler)") : "";
  return (e.name || "Error") + ": " + e.message + at;
}
function guard(label, fn) {
  try { return fn(); } catch (e) {
    if (e && e.message === "interrupted") throw e;
    fail(describe(e) + " " + label);
  }
}
`;

const SHIM_REST = String.raw`// ---------- CSS ----------
function splitDecls(body) { return splitTop(body, ";"); }
function parseDecls(body) {
  var map = new Map();
  splitDecls(body).forEach(function (d) {
    var c = d.indexOf(":"); if (c < 0) return;
    var k = d.slice(0, c).trim().toLowerCase(), v = d.slice(c + 1).trim().replace(/\s*!important\s*$/i, "");
    if (k && v) map.set(k, v);
  });
  return map;
}
function checkCssValue(prop, value) {
  var v = String(value), where = prop + ": " + v;
  if (/(^|[^\w.-])-?(\d+\.?\d*|\.\d+)(d|s|l)?vh\b/i.test(v)) fail("CSS \"" + short(where) + "\": vh units do not work in a widget (there is no viewport height). Use px or %.");
  if (/^overflow(-[xy])?$/.test(prop) && /\b(auto|scroll|overlay)\b/i.test(v)) fail("CSS \"" + short(where) + "\": widgets cannot scroll; Telegram turns this into overflow: hidden and cuts the rest off. Show fewer items, or split them with tabs or <details>.");
  if (prop === "position" && /sticky/i.test(v)) fail("CSS \"" + short(where) + "\": position: sticky is not supported in widgets.");
  if (/(^|[^\w-])(color-mix|oklch|oklab)\(/i.test(v)) fail("CSS \"" + short(where) + "\": color-mix(), oklch() and oklab() are not supported. Use theme variables or hex colors.");
  if (/url\(\s*['"]?(?!data:|#)/i.test(v)) fail("CSS \"" + short(where) + "\": widgets have no network, so external url() resources never load. Inline a data: URL or drop it.");
  if (/\b(undefined|NaN)\b/.test(v)) warn("CSS \"" + short(where) + "\" " + context + ": a computed style value is undefined or NaN, so that element renders wrong. Check the data the code reads.");
}
var sheetCache = new Map();
function parseSheet(text) {
  var cached = sheetCache.get(text);
  if (cached) return cached;
  var out = { rules: [], count: 0 };
  (function walk(t, conditional) {
    t = t.replace(/\/\*[\s\S]*?\*\//g, "");
    var i = 0;
    while (i < t.length) {
      var open = t.indexOf("{", i); if (open < 0) break;
      var prelude = t.slice(i, open).replace(/^[\s;]+/, "").trim();
      var depth = 1, j = open + 1;
      while (j < t.length && depth) { if (t[j] === "{") depth++; else if (t[j] === "}") depth--; j++; }
      var bodyT = t.slice(open + 1, j - 1); i = j;
      var atm = /^@(?:-webkit-)?([\w-]+)/.exec(prelude);
      if (atm) {
        var at = atm[1].toLowerCase();
        // Conditional rules may never apply in the bubble; they are linted but not counted for paint.
        if (at === "media" || at === "supports" || at === "container") walk(bodyT, true);
        else if (at === "layer") walk(bodyT, conditional);
        else if (at === "font-face") fail("CSS @font-face: widgets cannot load fonts. Use a generic family such as sans-serif, serif or monospace.");
        continue;
      }
      if (bodyT.indexOf("{") >= 0) fail("CSS rule \"" + short(prelude) + "\" uses nesting, which widgets do not support. Write each selector as its own rule.");
      out.count++;
      var decls = parseDecls(bodyT.replace(/[^;{}]*\{[^}]*\}/g, ""));
      decls.forEach(function (v, k) { checkCssValue(k, v); });
      if (!conditional) out.rules.push({ selector: prelude, decls: decls, order: out.rules.length });
    }
    if (/@import\b/i.test(t)) fail("CSS @import: widgets have no network. Put all styles inline.");
  })(text, false);
  sheetCache.set(text, out);
  return out;
}
function short(s) { s = String(s).replace(/\s+/g, " ").trim(); return s.length > 60 ? s.slice(0, 57) + "..." : s; }

// ---------- rendering checks ----------
var REMOVED = { input: "inputs are removed (there is no keyboard); use buttons", select: "selects are removed; use buttons", textarea: "text areas are removed (there is no keyboard)", form: "forms are removed; handle taps in click handlers", iframe: "iframes are removed", frame: "frames are removed", audio: "audio is removed", video: "video is removed", object: "embedded objects are removed", embed: "embedded objects are removed", link: "link elements are removed (no network); inline styles in <style>", base: "base elements are removed" };
var SVG_DROPPED = { clippath: "clipPath", mask: "mask", filter: "filter", foreignobject: "foreignObject", animate: "SMIL animation", animatetransform: "SMIL animation", animatemotion: "SMIL animation", set: "SMIL animation" };
function checkUrlAttr(el, attr, v) {
  if (el.localName === "img" && attr === "src" && !/^data:image\/(png|jpe?g|webp|gif);/i.test(v)) fail("<img src=\"" + short(v) + "\">: widgets have no network; images must be data: PNG, JPEG, WebP or GIF.");
  if (el.localName === "script" && attr === "src") fail("<script src=\"" + short(v) + "\">: widgets have no network or CDN. Put the code inline.");
}
function isHidden(el, decl) { return el.hasAttribute("hidden") || (decl && decl.display === "none"); }
function heavyOf(d, isButton) {
  var none = function (v) { return v === undefined || /^\s*none\s*$/i.test(v); };
  var backdrop = !none(d["backdrop-filter"]) || !none(d["-webkit-backdrop-filter"]);
  var op = d.opacity, opacity = false;
  if (op !== undefined && !isButton) { var n = /%\s*$/.test(op) ? parseFloat(op) / 100 : parseFloat(op); opacity = Number.isFinite(n) && n < 1; }
  var shadow = false;
  if (!none(d["box-shadow"])) splitTop(d["box-shadow"], ",").forEach(function (s) {
    var lens = s.replace(/rgba?\([^)]*\)|hsla?\([^)]*\)|var\([^)]*\)/g, " ").split(/\s+/).filter(function (t) { return /^-?(\d+\.?\d*|\.\d+)(px|em|rem)?$/.test(t); });
    if (lens.length >= 3 && parseFloat(lens[2]) > 0) shadow = true;
  });
  return { heavy: backdrop || !none(d.filter) || opacity || shadow, backdrop: backdrop };
}
function specificity(steps) {
  var ids = 0, classes = 0, tags = 0, extra = 0;
  steps.forEach(function (s) {
    var c = s.c;
    if (c.id !== null) ids++;
    c.pseudos.forEach(function (p) {
      // :where() adds nothing; :is(), :not() and :has() take their most specific argument.
      if (p.name === "where") return;
      if (p.name === "is" || p.name === "not" || p.name === "has") {
        extra += parseSelector(p.arg || "").reduce(function (max, inner) { return Math.max(max, specificity(inner)); }, 0);
        return;
      }
      classes++;
    });
    classes += c.classes.length + c.attrs.length;
    if (c.tag) tags++;
    if (c.pseudoEl) tags++;
  });
  return ids * 10000 + classes * 100 + tags + extra;
}
function measure() {
  var sheets = [];
  eachElement(docEl, function (e) { if (e.localName === "style") sheets.push(parseSheet(e.textContent)); });
  var rules = [], ruleCount = 0;
  sheets.forEach(function (s) { ruleCount += s.count; s.rules.forEach(function (r) {
    parseSelector(r.selector).forEach(function (steps) {
      var last = steps[steps.length - 1].c;
      rules.push({ steps: steps, pseudoEl: last.pseudoEl, decls: r.decls, spec: specificity(steps), order: rules.length });
    });
  }); });
  // Cascade order: lower specificity first, then source order, so later writes win like CSS.
  rules.sort(function (a, b) { return a.spec - b.spec || a.order - b.order; });
  var heavy = 0, backdrop = 0, nodes = 0;
  (function walk(root) {
    for (var i = 0; i < root.childNodes.length; i++) {
      var el = root.childNodes[i];
      if (el.nodeType !== 1) continue;
      nodes++;
      if (REMOVED[el.localName]) fail("<" + el.localName + ">: " + REMOVED[el.localName] + ".");
      if (SVG_DROPPED[el.localName]) fail("SVG <" + el.localName + ">: " + SVG_DROPPED[el.localName] + " is dropped in widgets; draw it with plain shapes.");
      if (el.localName === "script" || el.localName === "style" || el.localName === "head") continue;
      var d = {}, before = null, after = null;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (!matchSteps(el, rule.steps, rule.steps.length - 1, false)) continue;
        var target = rule.pseudoEl === "before" ? (before = before || {}) : rule.pseudoEl === "after" ? (after = after || {}) : rule.pseudoEl ? null : d;
        if (target) rule.decls.forEach(function (v, k) { target[k] = v; });
      }
      el.style._map.forEach(function (v, k) { d[k] = v; });
      if (isHidden(el, d)) continue;
      var h = heavyOf(d, el.localName === "button");
      if (h.heavy) heavy++; if (h.backdrop) backdrop++;
      [before, after].forEach(function (p) { if (p && p.content !== undefined && !/^\s*none\s*$/i.test(p.content)) { var ph = heavyOf(p, false); if (ph.heavy) heavy++; if (ph.backdrop) backdrop++; } });
      walk(el);
    }
  })(docEl);
  maxHeavy = Math.max(maxHeavy, heavy); maxBackdrop = Math.max(maxBackdrop, backdrop);
  maxNodes = Math.max(maxNodes, nodes); maxRules = Math.max(maxRules, ruleCount);
  var shown = visibleText(body);
  var bad = /\b(undefined|NaN|\[object Object\])\b/.exec(shown);
  // Words the author wrote as text or string literals are content, not missing data.
  if (bad && LITERAL_TEXT.indexOf(bad[1]) < 0) {
    var at = Math.max(0, bad.index - 30);
    warn("The widget shows \"" + bad[1] + "\" " + context + " (\"..." + short(shown.slice(at, bad.index + 30)) + "...\"). The code reads data that is not there; check the state shape and the variables it uses.");
  }
}
function visibleText(root) {
  var out = "";
  for (var i = 0; i < root.childNodes.length; i++) {
    var n = root.childNodes[i];
    if (n.nodeType === 3) out += n.data + " ";
    else if (n.nodeType === 1 && n.localName !== "script" && n.localName !== "style" && !n.hasAttribute("hidden") && n.style._map.get("display") !== "none") out += visibleText(n);
  }
  return out;
}

// ---------- events ----------
function Event(type, init) {
  this.type = String(type); init = init || {};
  this.bubbles = !!init.bubbles; this.cancelable = !!init.cancelable; this.composed = !!init.composed;
  this.defaultPrevented = false; this.target = null; this.currentTarget = null; this.timeStamp = Date.now();
  this.isTrusted = false; this._stop = false; this._stopNow = false; this.detail = init.detail;
  this.clientX = init.clientX || 0; this.clientY = init.clientY || 0; this.button = 0; this.pointerType = "touch";
  this.key = init.key || ""; this.touches = []; this.changedTouches = [];
}
Event.prototype = {
  preventDefault: function () { if (this.cancelable) this.defaultPrevented = true; },
  stopPropagation: function () { this._stop = true; },
  stopImmediatePropagation: function () { this._stop = true; this._stopNow = true; },
  composedPath: function () { var p = []; for (var n = this.target; n; n = n.parentNode) p.push(n); p.push(G); return p; },
};
function CustomEvent(type, init) { Event.call(this, type, init); }
CustomEvent.prototype = Object.create(Event.prototype);
var compiled = new Map();
function inlineHandler(node, type) {
  if (node._on && node._on[type]) return node._on[type];
  if (node.nodeType !== 1) return null;
  var code = node.getAttribute("on" + type);
  if (code === null) return null;
  if (!compiled.has(code)) {
    // Sloppy-mode Function like a browser inline handler: element, then document, then globals.
    try { compiled.set(code, new Function("event", "with(document){with(this){" + code + "\n}}")); }
    catch (e) { fail(describe(e) + " in the inline on" + type + " handler"); compiled.set(code, null); }
  }
  return compiled.get(code);
}
function dispatch(target, e) {
  e.target = target;
  var path = [];
  for (var n = target; n; n = n.parentNode) path.push(n);
  path.push(G);
  for (var i = 0; i < path.length; i++) {
    var node = path[i];
    if (i > 0 && !e.bubbles) break;
    e.currentTarget = node;
    var h = node === G ? G["on" + e.type] : inlineHandler(node, e.type);
    if (typeof h === "function") {
      var r = h.call(node, e);
      if (r === false) e.preventDefault();
    }
    var list = node._l && node._l[e.type];
    if (list) {
      list = list.slice();
      for (var k = 0; k < list.length && !e._stopNow; k++) {
        if (list[k].once) node.removeEventListener(e.type, list[k].fn);
        if (typeof list[k].fn === "function") list[k].fn.call(node, e); else list[k].fn.handleEvent(e);
      }
    }
    if (e._stop) break;
  }
  e.currentTarget = null;
}
G.addEventListener = function (t, f, o) { Node.prototype.addEventListener.call(G, t, f, o); };
G.removeEventListener = function (t, f) { Node.prototype.removeEventListener.call(G, t, f); };
G.dispatchEvent = function (e) { e.target = G; e.currentTarget = G; var list = G._l && G._l[e.type]; if (list) list.slice().forEach(function (x) { x.fn.call(G, e); }); return true; };
function fireTap(el) {
  for (var n = el; n && n.nodeType === 1; n = n.parentNode) if (n.hasAttribute("disabled")) return;
  var prev = gesture; gesture = true;
  try {
    ["pointerdown", "touchstart", "mousedown", "pointerup", "touchend", "mouseup", "click"].forEach(function (t) {
      dispatch(el, new Event(t, { bubbles: true, cancelable: true }));
    });
  } finally { gesture = prev; }
}

// ---------- timers ----------
var now = 0, timerSeq = 0, timers = new Map();
function addTimer(fn, ms, args, repeat) {
  if (typeof fn !== "function") { if (typeof fn === "string") fail("setTimeout/setInterval with a code string is not allowed; pass a function."); return 0; }
  var id = ++timerSeq, delay = Math.max(repeat ? 1 : 0, Number(ms) || 0);
  timers.set(id, { fn: fn, at: now + delay, delay: delay, args: args, repeat: repeat });
  return id;
}
G.setTimeout = function (fn, ms) { return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false); };
G.setInterval = function (fn, ms) { return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true); };
G.clearTimeout = G.clearInterval = function (id) { timers.delete(id); };
G.requestAnimationFrame = function (fn) { return addTimer(function () { fn(now); }, 16, [], false); };
G.cancelAnimationFrame = function (id) { timers.delete(id); };
function settle(ms) {
  var until = now + ms, runs = 0;
  for (;;) {
    var next = null;
    timers.forEach(function (t, id) { if (t.at <= until && (!next || t.at < next.t.at)) next = { id: id, t: t }; });
    if (!next || runs++ > 300) break;
    now = next.t.at;
    if (next.t.repeat) next.t.at = now + next.t.delay; else timers.delete(next.id);
    var t = next.t;
    guard("in a timer callback " + context, function () { t.fn.apply(G, t.args); });
    G.__drainJobs();
  }
  now = until;
}

// ---------- environment ----------
function storage() {
  var map = new Map();
  var api = {
    getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
    setItem: function (k, v) { map.set(String(k), String(v)); },
    removeItem: function (k) { map.delete(String(k)); },
    clear: function () { map.clear(); },
    key: function (i) { return Array.from(map.keys())[i] || null; },
    get length() { return map.size; },
  };
  return new Proxy(api, {
    get: function (t, k) { if (typeof k !== "string" || k in t) return t[k]; return map.has(k) ? map.get(k) : undefined; },
    set: function (t, k, v) { map.set(String(k), String(v)); return true; },
    has: function (t, k) { return k in t || map.has(String(k)); },
    deleteProperty: function (t, k) { map.delete(String(k)); return true; },
    ownKeys: function () { return Array.from(map.keys()); },
    getOwnPropertyDescriptor: function (t, k) { return map.has(k) ? { value: map.get(k), enumerable: true, configurable: true, writable: true } : undefined; },
  });
}
function canvasContext(canvas) {
  var state = { canvas: canvas, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif", textAlign: "start", textBaseline: "alphabetic", globalAlpha: 1, lineCap: "butt", lineJoin: "miter" };
  return new Proxy(state, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (k === "measureText") return function (s) { return { width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }; };
      if (k === "createLinearGradient" || k === "createRadialGradient" || k === "createConicGradient") return function () { return { addColorStop: function () {} }; };
      if (k === "getImageData" || k === "createImageData") return function (x, y, w, h) { return { width: w || 1, height: h || 1, data: new Uint8ClampedArray(4 * (w || 1) * (h || 1)) }; };
      if (k === "getLineDash") return function () { return []; };
      if (k === "getTransform") return function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; };
      if (k === "isPointInPath" || k === "isPointInStroke") return function () { return false; };
      return function () {};
    },
    set: function (t, k, v) { t[k] = v; if (typeof v === "string" && /\b(undefined|NaN)\b/.test(v)) warn("Canvas " + String(k) + " = \"" + short(v) + "\" " + context + ": a computed value is undefined or NaN."); return true; },
  });
}
function noopObserver() { return function () { this.observe = function () {}; this.unobserve = function () {}; this.disconnect = function () {}; this.takeRecords = function () { return []; }; }; }
function intl(kind, locale, opts, value) {
  var r = JSON.parse(G.__intl(JSON.stringify({ kind: kind, locale: locale, opts: opts, value: value })));
  if (r.error) throw new RangeError(r.error);
  return r.value;
}
var IntlShim = {
  NumberFormat: function (l, o) { return { format: function (v) { return intl("number", l, o, Number(v)); }, resolvedOptions: function () { return Object.assign({ locale: l || "en-US" }, o); }, formatToParts: function (v) { return [{ type: "literal", value: intl("number", l, o, Number(v)) }]; } }; },
  DateTimeFormat: function (l, o) { return { format: function (v) { return intl("date", l, o, v === undefined ? Date.now() : +new Date(v)); }, resolvedOptions: function () { return Object.assign({ locale: l || "en-US", timeZone: "UTC" }, o); }, formatToParts: function (v) { return [{ type: "literal", value: intl("date", l, o, v === undefined ? Date.now() : +new Date(v)) }]; } }; },
  PluralRules: function (l, o) { return { select: function (v) { return intl("plural", l, o, Number(v)); } }; },
  RelativeTimeFormat: function (l, o) { return { format: function (v, u) { return intl("relative", l, o, [Number(v), String(u)]); } }; },
  ListFormat: function (l, o) { return { format: function (v) { return intl("list", l, o, Array.from(v, String)); } }; },
  Collator: function () { return { compare: function (a, b) { return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; } }; },
  getCanonicalLocales: function (l) { return [].concat(l === undefined ? [] : l); },
};
G.Intl = IntlShim;
Number.prototype.toLocaleString = function (l, o) { return intl("number", l, o, Number(this)); };
["toLocaleString", "toLocaleDateString", "toLocaleTimeString"].forEach(function (method) {
  Date.prototype[method] = function (l, o) { return intl("date-method", l, o, [method, +this]); };
});

var b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
Object.assign(G, {
  window: G, self: G, document: document, top: G,
  Node: Node, Element: Element, HTMLElement: Element, SVGElement: Element, Text: Text, Comment: Comment, DocumentFragment: Fragment,
  Event: Event, CustomEvent: CustomEvent, MouseEvent: Event, PointerEvent: Event, KeyboardEvent: Event, TouchEvent: Event, UIEvent: Event,
  localStorage: storage(), sessionStorage: storage(),
  navigator: { language: "en-US", languages: ["en-US"], userAgent: "TelegramWidget", platform: "", maxTouchPoints: 5, vibrate: function () { return false; }, clipboard: undefined },
  location: { href: "about:blank", protocol: "about:", host: "", hostname: "", pathname: "blank", search: "", hash: "", origin: "null", reload: function () {}, assign: function () {}, replace: function () {} },
  history: { length: 1, state: null, pushState: function () {}, replaceState: function () {}, back: function () {} },
  screen: { width: 390, height: 844, availWidth: 390, availHeight: 844 },
  innerWidth: 320, innerHeight: 600, outerWidth: 320, outerHeight: 600, devicePixelRatio: 2, scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
  performance: { now: function () { return now; }, mark: function () {}, measure: function () {} },
  console: { log: function () {}, info: function () {}, warn: function () {}, error: function () {}, debug: function () {}, table: function () {}, group: function () {}, groupEnd: function () {}, time: function () {}, timeEnd: function () {}, assert: function () {} },
  getComputedStyle: function (el) { return el && el.style ? el.style : makeStyle(new Element("div")); },
  matchMedia: function (q) { return { matches: /prefers-reduced-motion|hover:\s*none|pointer:\s*coarse/.test(String(q)), media: String(q), addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} }; },
  ResizeObserver: noopObserver(), MutationObserver: noopObserver(), IntersectionObserver: noopObserver(),
  scrollTo: function () {}, scrollBy: function () {}, focus: function () {}, blur: function () {}, print: function () {},
  alert: function () { fail("alert()/confirm()/prompt() do not exist in widgets; show the message in the widget."); },
  confirm: function () { fail("alert()/confirm()/prompt() do not exist in widgets; show the message in the widget."); return false; },
  prompt: function () { fail("alert()/confirm()/prompt() do not exist in widgets; show the message in the widget."); return null; },
  fetch: function () { fail("fetch(): widgets have no network. Put the data in the code or in the widget state."); return Promise.reject(new TypeError("Network access is not available in widgets")); },
  XMLHttpRequest: function () { fail("XMLHttpRequest: widgets have no network. Put the data in the code or in the widget state."); this.open = this.send = this.setRequestHeader = function () {}; },
  WebSocket: function () { fail("WebSocket: widgets have no network."); throw new TypeError("Network access is not available in widgets"); },
  EventSource: function () { fail("EventSource: widgets have no network."); throw new TypeError("Network access is not available in widgets"); },
  Image: function () { return document.createElement("img"); },
  structuredClone: function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); },
  btoa: function (s) { s = String(s); var o = ""; for (var i = 0; i < s.length; i += 3) { var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2); if (a > 255 || b > 255 || c > 255) throw new Error("InvalidCharacterError: btoa"); o += b64[a >> 2] + b64[((a & 3) << 4) | (b >> 4 || 0)] + (i + 1 < s.length ? b64[((b & 15) << 2) | (c >> 6 || 0)] : "=") + (i + 2 < s.length ? b64[c & 63] : "="); } return o; },
  atob: function (s) { s = String(s).replace(/[\s=]/g, ""); var o = "", bits = 0, acc = 0; for (var i = 0; i < s.length; i++) { var v = b64.indexOf(s[i]); if (v < 0) throw new Error("InvalidCharacterError: atob"); acc = (acc << 6) | v; bits += 6; if (bits >= 8) { bits -= 8; o += String.fromCharCode((acc >> bits) & 255); } } return o; },
});

// ---------- TelegramWidget (https://core.telegram.org/bots/widgets) ----------
var WIDGET_EVENTS = ["themeChanged", "activated", "deactivated", "chatDataChanged", "publicDataChanged", "contentSafeAreaChanged"];
var widgetHandlers = new Map(WIDGET_EVENTS.map(function (e) { return [e, []]; }));
var requests = 0;
function utf8Length(s) { var n = 0; for (var i = 0; i < s.length; i++) { var c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3; } return n; }
function needsTap(name) { if (!gesture) fail("TelegramWidget." + name + "() ran " + context + ", outside a tap. Telegram only allows it inside a click handler."); }
// Dark-theme palette and a private-chat viewer, the values Telegram supplies to query-enabled widgets.
var THEME_PARAMS = Object.freeze({ bg_color: "#212121", text_color: "#ffffff", hint_color: "#aaaaaa", link_color: "#8774e1", button_color: "#8774e1", button_text_color: "#ffffff", secondary_bg_color: "#181818", header_bg_color: "#212121", accent_text_color: "#8774e1", section_bg_color: "#212121", section_header_text_color: "#8774e1", subtitle_text_color: "#aaaaaa", destructive_text_color: "#e53935", bottom_bar_bg_color: "#212121" });
var VIEWER = Object.freeze({ id: 1, first_name: "Test", last_name: "User", username: "test_user", language_code: "en", is_premium: false });
// Web APIs the trial run does not model: touching one means the check cannot judge the widget.
var unsupported = null;
["URL", "URLSearchParams", "Blob", "File", "FileReader", "crypto", "AbortController", "DOMParser", "Worker", "BroadcastChannel", "IndexedDB", "indexedDB", "caches", "Response", "Request", "Headers", "FormData", "ReadableStream", "WebAssembly", "OffscreenCanvas", "createImageBitmap"].forEach(function (name) {
  if (name in G) return;
  Object.defineProperty(G, name, { configurable: true, get: function () { if (!unsupported) unsupported = name; throw new ReferenceError(name + " is not available in the widget trial run"); } });
});
G.TextEncoder = function () {};
G.TextEncoder.prototype.encoding = "utf-8";
G.TextEncoder.prototype.encode = function (str) {
  var u = unescape(encodeURIComponent(String(str === undefined ? "" : str))), out = new Uint8Array(u.length);
  for (var i = 0; i < u.length; i++) out[i] = u.charCodeAt(i);
  return out;
};
G.TextDecoder = function () {};
G.TextDecoder.prototype.encoding = "utf-8";
G.TextDecoder.prototype.decode = function (bytes) {
  if (!bytes) return "";
  var arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes), s = "";
  for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
};
var HapticFeedback = { impactOccurred: function () {}, notificationOccurred: function () {}, selectionChanged: function () {} };
G.TelegramWidget = Object.freeze({
  get profile() { return 1; },
  isProfileAtLeast: function (n) { return typeof n === "number" && 1 >= n; },
  get colorScheme() { return "dark"; },
  get themeParams() { return THEME_PARAMS; },
  get isActive() { return true; },
  get contentSafeAreaInset() { return Object.freeze({ top: 0, bottom: 0, left: 0, right: 0, cornerLeft: 0, cornerRight: 0 }); },
  onEvent: function (type, handler) { var l = widgetHandlers.get(String(type)); if (l && typeof handler === "function" && l.indexOf(handler) < 0 && l.length < 16) l.push(handler); },
  offEvent: function (type, handler) { var l = widgetHandlers.get(String(type)); var i = l ? l.indexOf(handler) : -1; if (i >= 0) l.splice(i, 1); },
  openLink: function (url) { needsTap("openLink"); if (typeof url !== "string" || !/^https:\/\/[^\s@\/]+/.test(url)) fail("TelegramWidget.openLink(" + short(JSON.stringify(url)) + "): the link must be an https:// URL."); },
  openTelegramLink: function (url) { needsTap("openTelegramLink"); if (typeof url !== "string" || !/^https:\/\/t\.me\//.test(url)) fail("TelegramWidget.openTelegramLink(" + short(JSON.stringify(url)) + "): the link must start with https://t.me/."); },
  HapticFeedback: HapticFeedback,
  ready: function () {},
  setResizeAnchor: function () {},
  watchPublicData: function () {}, unwatchPublicData: function () {},
  get chatData() { return STATE; },
  get publicData() { return null; },
  get isForward() { return false; },
  get isPreview() { return false; },
  get chatType() { return "private"; },
  get viewer() { return VIEWER; },
  get wallet() { return null; },
  request: function (data) {
    if (typeof data !== "string" || data.length === 0 || utf8Length(data) > 64) {
      fail("TelegramWidget.request(" + short(JSON.stringify(data)) + ") " + context + ": the data must be a string of 1 to 64 bytes.");
      throw new TypeError("request: data must be a string of 1 to 64 bytes (UTF-8), without lone surrogates");
    }
    needsTap("request");
    requests++;
    // Telegram resolves an acknowledged request with { result }; an empty answer is null.
    return Promise.resolve({ result: null });
  },
  copyText: function (text) {
    needsTap("copyText");
    if (typeof text !== "string" || text.length === 0 || text.length > 256) { fail("TelegramWidget.copyText(): the text must be 1 to 256 characters."); throw new TypeError("copyText: text must be a string of 1 to 256 characters (UTF-16), without lone surrogates"); }
  },
});

// ---------- driver (called by the host between script evaluations) ----------
var nextScript = parseHTML(SOURCE, body, true);
var scriptIndex = 0;
function isClassicScript(el) { var t = (el.getAttribute("type") || "").trim().toLowerCase(); return !t || t === "text/javascript" || t === "application/javascript" || t === "module"; }
function clickTargets() {
  var out = [];
  eachElement(body, function (el) {
    if (el.hasAttribute("hidden") || el.style._map.get("display") === "none") return false;
    // A disabled control cannot be tapped in Telegram.
    if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") return false;
    var handled = (el._on && el._on.click) || el.hasAttribute("onclick") || (el._l && (el._l.click || el._l.pointerdown || el._l.pointerup || el._l.touchstart || el._l.mousedown));
    var hasElementKids = el.children.length > 0;
    if (el.localName === "button" || el.getAttribute("role") === "button" || (handled && !hasElementKids)) out.push(el);
    else if (handled && hasElementKids) el.children.forEach(function (c) { out.push(c); });
  });
  return out;
}
G.__widgetCheck = {
  // Returns the next inline script's code ("" for one to skip), or null when the document is parsed.
  nextScript: function () {
    for (;;) {
      var el = nextScript();
      if (!el) return null;
      scriptIndex++;
      if (el.hasAttribute("src")) continue;
      if (!isClassicScript(el)) continue;
      return el.textContent;
    }
  },
  scriptNumber: function () { return scriptIndex; },
  recordError: function (e) { fail(describe(e) + " " + context); },
  loaded: function () {
    document.readyState = "interactive";
    guard("in a DOMContentLoaded handler", function () { dispatch(document, new Event("DOMContentLoaded", { bubbles: true })); });
    document.readyState = "complete";
    guard("in a load handler", function () { G.dispatchEvent(new Event("load")); if (typeof G.onload === "function") G.onload(new Event("load")); });
    G.__drainJobs();
    settle(3000);
    measure();
  },
  tapAll: function () {
    var labels = [], k = 0;
    for (; k < 24; k++) {
      var targets = clickTargets();
      if (k >= targets.length) break;
      var el = targets[k];
      var label = short(el.textContent).slice(0, 30) || el.localName;
      context = "after tapping \"" + label + "\"";
      guard(context, function () { fireTap(el); });
      G.__drainJobs();
      settle(800);
      measure();
      labels.push(label);
    }
    return labels.length;
  },
  dataChanged: function (state) {
    STATE = state;
    context = "after the state update";
    (widgetHandlers.get("chatDataChanged") || []).forEach(function (h) { guard(context, function () { h.call(G.TelegramWidget); }); });
    G.__drainJobs();
    measure();
  },
  report: function () {
    if (maxHeavy > 16) warn(maxHeavy + " elements use opacity below 1, filter or a blurred box-shadow. Telegram stops widgets with more than 16, so it would show \"Widget stopped\". Use solid theme colors for tints and fills instead of opacity.");
    if (maxBackdrop > 2) warn(maxBackdrop + " elements use backdrop-filter. Telegram stops widgets with more than 2.");
    if (maxNodes > 2000) fail("The widget has " + maxNodes + " elements. Telegram stops widgets with more than 2000.");
    if (maxRules > 400) fail("The widget has " + maxRules + " CSS rules. Telegram stops widgets with more than 400.");
    return JSON.stringify({ errors: errors, warnings: warnings, unsupported: unsupported, requests: requests, heavy: maxHeavy, nodes: maxNodes, rules: maxRules });
  },
};
})();`;

export const TELEGRAM_WIDGET_CHECK_SHIM = `${SHIM_HEAD}\n${TELEGRAM_WIDGET_CHECK_SHIM_DOM}\n${SHIM_REST}`;
