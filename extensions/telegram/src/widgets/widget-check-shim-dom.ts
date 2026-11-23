// Part of the widget trial-run guest program (see widget-check-shim.ts): DOM nodes, the
// document, HTML parsing and CSS selectors. Evaluated inside the same function scope.
export const TELEGRAM_WIDGET_CHECK_SHIM_DOM = String.raw`// ---------- nodes ----------
var VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
var RAW = new Set(["script", "style", "textarea", "title"]);
var ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", middot: "\u00b7", times: "\u00d7", hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", rarr: "\u2192", larr: "\u2190", uarr: "\u2191", darr: "\u2193", bull: "\u2022", copy: "\u00a9", deg: "\u00b0", check: "\u2713", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c", minus: "\u2212", plusmn: "\u00b1", le: "\u2264", ge: "\u2265", ne: "\u2260", euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", rupee: "\u20b9", star: "\u2606" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, e) {
    if (e[0] === "#") { var n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (x) { return m; } }
    var v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function esc(s, attr) {
  s = String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return attr ? s.replace(/"/g, "&quot;") : s;
}

function Node(type) { this.nodeType = type; this.childNodes = []; this.parentNode = null; }
Node.prototype = {
  get ownerDocument() { return document; },
  get children() { return this.childNodes.filter(function (n) { return n.nodeType === 1; }); },
  get childElementCount() { return this.children.length; },
  get firstChild() { return this.childNodes[0] || null; },
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; },
  get firstElementChild() { return this.children[0] || null; },
  get lastElementChild() { var c = this.children; return c[c.length - 1] || null; },
  get parentElement() { var p = this.parentNode; return p && p.nodeType === 1 ? p : null; },
  get nextSibling() { var p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; },
  get previousSibling() { var p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; },
  get nextElementSibling() { for (var n = this.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n; return null; },
  get previousElementSibling() { for (var n = this.previousSibling; n; n = n.previousSibling) if (n.nodeType === 1) return n; return null; },
  get isConnected() { for (var n = this; n; n = n.parentNode) if (n === document) return true; return false; },
  hasChildNodes: function () { return this.childNodes.length > 0; },
  appendChild: function (n) { return this.insertBefore(n, null); },
  insertBefore: function (n, ref) {
    if (!n || typeof n.nodeType !== "number") throw new TypeError("Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'.");
    if (n.nodeType === 11) { var kids = n.childNodes.slice(); for (var i = 0; i < kids.length; i++) this.insertBefore(kids[i], ref); return n; }
    if (n.contains && n.contains(this)) throw new Error("HierarchyRequestError: the new child contains the parent");
    if (n.parentNode) n.parentNode.removeChild(n);
    var at = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && at < 0) throw new Error("NotFoundError: the reference node is not a child of this node");
    n.parentNode = this;
    if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
    return n;
  },
  removeChild: function (n) {
    var i = this.childNodes.indexOf(n);
    if (i < 0) throw new Error("NotFoundError: the node to be removed is not a child of this node");
    this.childNodes.splice(i, 1); n.parentNode = null; return n;
  },
  replaceChild: function (n, old) { this.insertBefore(n, old); return this.removeChild(old); },
  append: function () { for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; this.appendChild(typeof a === "object" && a !== null ? a : document.createTextNode(String(a))); } },
  prepend: function () { var first = this.firstChild; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; this.insertBefore(typeof a === "object" && a !== null ? a : document.createTextNode(String(a)), first); } },
  replaceChildren: function () { var old = this.childNodes; for (var i = 0; i < old.length; i++) old[i].parentNode = null; this.childNodes = []; this.append.apply(this, arguments); },
  remove: function () { if (this.parentNode) this.parentNode.removeChild(this); },
  before: function () { var p = this.parentNode; if (!p) return; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; p.insertBefore(typeof a === "object" ? a : document.createTextNode(String(a)), this); } },
  after: function () { var p = this.parentNode; if (!p) return; var next = this.nextSibling; for (var i = 0; i < arguments.length; i++) { var a = arguments[i]; p.insertBefore(typeof a === "object" ? a : document.createTextNode(String(a)), next); } },
  replaceWith: function () { var p = this.parentNode; if (!p) return; this.before.apply(this, arguments); p.removeChild(this); },
  contains: function (n) { for (; n; n = n.parentNode) if (n === this) return true; return false; },
  get textContent() {
    if (this.nodeType === 3) return this.data;
    if (this.nodeType === 8) return "";
    return this.childNodes.map(function (c) { return c.textContent; }).join("");
  },
  set textContent(v) {
    if (this.nodeType === 3 || this.nodeType === 8) { this.data = String(v); return; }
    this.replaceChildren();
    if (v !== null && v !== undefined && v !== "") this.appendChild(document.createTextNode(String(v)));
  },
  get nodeValue() { return this.nodeType === 3 || this.nodeType === 8 ? this.data : null; },
  set nodeValue(v) { if (this.nodeType === 3 || this.nodeType === 8) this.data = String(v); },
  cloneNode: function (deep) {
    var c;
    if (this.nodeType === 3) return document.createTextNode(this.data);
    if (this.nodeType === 8) return document.createComment(this.data);
    if (this.nodeType === 11) c = document.createDocumentFragment();
    else { c = document.createElement(this.localName); var self = this; this._attrs.forEach(function (v, k) { c.setAttribute(k, k === "style" ? self.style.cssText : v); }); }
    if (deep) for (var i = 0; i < this.childNodes.length; i++) c.appendChild(this.childNodes[i].cloneNode(true));
    return c;
  },
  addEventListener: function (type, fn, opts) {
    if (typeof fn !== "function" && !(fn && typeof fn.handleEvent === "function")) return;
    var l = this._l || (this._l = {}); var list = l[type] || (l[type] = []);
    if (list.some(function (x) { return x.fn === fn; })) return;
    list.push({ fn: fn, once: !!(opts && typeof opts === "object" && opts.once) });
  },
  removeEventListener: function (type, fn) { var list = this._l && this._l[type]; if (!list) return; var i = list.findIndex(function (x) { return x.fn === fn; }); if (i >= 0) list.splice(i, 1); },
  dispatchEvent: function (e) { dispatch(this, e); return !e.defaultPrevented; },
};
function Text(d) { Node.call(this, 3); this.data = String(d); }
Text.prototype = Object.create(Node.prototype, { nodeName: { value: "#text" } });
function Comment(d) { Node.call(this, 8); this.data = String(d); }
Comment.prototype = Object.create(Node.prototype, { nodeName: { value: "#comment" } });
function Fragment() { Node.call(this, 11); }
Fragment.prototype = Object.create(Node.prototype, { nodeName: { value: "#document-fragment" } });

function camelToKebab(p) { return p.startsWith("--") ? p : p.replace(/[A-Z]/g, function (c) { return "-" + c.toLowerCase(); }).replace(/^(webkit|moz|ms)-/, "-$1-"); }
function makeStyle(el) {
  var map = new Map();
  var api = {
    get cssText() { var out = []; map.forEach(function (v, k) { out.push(k + ": " + v + ";"); }); return out.join(" "); },
    set cssText(v) { map.clear(); parseDecls(String(v)).forEach(function (val, k) { setProp(k, val); }); },
    setProperty: function (k, v) { setProp(String(k).toLowerCase(), v); },
    getPropertyValue: function (k) { return map.get(String(k).toLowerCase()) || ""; },
    removeProperty: function (k) { var v = map.get(k) || ""; map.delete(k); return v; },
    get length() { return map.size; },
    _map: map,
  };
  function setProp(k, v) {
    if (v === null || v === undefined || v === "") { map.delete(k); return; }
    v = String(v).replace(/\s*!important\s*$/i, "");
    map.set(k, v);
    checkCssValue(k, v);
  }
  return new Proxy(api, {
    get: function (t, k) { if (typeof k !== "string" || k in t) return t[k]; return map.get(camelToKebab(k)) || ""; },
    set: function (t, k, v) { if (k === "cssText") { t.cssText = v; return true; } if (typeof k === "string") setProp(camelToKebab(k), v); return true; },
  });
}

function ClassList(el) { this.el = el; }
ClassList.prototype = {
  _get: function () { return (this.el.getAttribute("class") || "").split(/\s+/).filter(Boolean); },
  _set: function (l) { this.el.setAttribute("class", l.join(" ")); },
  contains: function (c) { return this._get().indexOf(String(c)) >= 0; },
  add: function () { var l = this._get(); for (var i = 0; i < arguments.length; i++) if (l.indexOf(String(arguments[i])) < 0) l.push(String(arguments[i])); this._set(l); },
  remove: function () { var a = Array.prototype.map.call(arguments, String); this._set(this._get().filter(function (c) { return a.indexOf(c) < 0; })); },
  toggle: function (c, force) { var has = this.contains(c); var want = force === undefined ? !has : !!force; if (want && !has) this.add(c); if (!want && has) this.remove(c); return want; },
  replace: function (a, b) { if (!this.contains(a)) return false; this._set(this._get().map(function (c) { return c === a ? String(b) : c; })); return true; },
  get length() { return this._get().length; },
  item: function (i) { return this._get()[i] || null; },
  forEach: function (fn) { this._get().forEach(fn); },
  toString: function () { return this._get().join(" "); },
};

var EVENTS = ["click", "pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "input", "change", "keydown", "keyup", "load", "transitionend", "animationend", "focus", "blur", "dblclick", "contextmenu"];
function Element(name) {
  Node.call(this, 1);
  this.localName = name;
  this._attrs = new Map();
  this._on = {};
  this.style = makeStyle(this);
}
Element.prototype = Object.create(Node.prototype);
Object.assign(Element.prototype, {
  getAttribute: function (n) { n = String(n).toLowerCase(); if (n === "style") return this.style.length ? this.style.cssText : (this._attrs.has("style") ? "" : null); return this._attrs.has(n) ? this._attrs.get(n) : null; },
  setAttribute: function (n, v) { n = String(n).toLowerCase(); v = String(v); this._attrs.set(n, v); if (n === "style") this.style.cssText = v; if (n === "src" || n === "href") checkUrlAttr(this, n, v); },
  hasAttribute: function (n) { return this._attrs.has(String(n).toLowerCase()); },
  removeAttribute: function (n) { n = String(n).toLowerCase(); this._attrs.delete(n); if (n === "style") this.style.cssText = ""; },
  toggleAttribute: function (n, f) { var has = this.hasAttribute(n); var want = f === undefined ? !has : !!f; if (want) this.setAttribute(n, ""); else this.removeAttribute(n); return want; },
  getAttributeNames: function () { return Array.from(this._attrs.keys()); },
  setAttributeNS: function (ns, n, v) { this.setAttribute(n, v); },
  getAttributeNS: function (ns, n) { return this.getAttribute(n); },
  querySelector: function (s) { return querySelectorAll(this, s)[0] || null; },
  querySelectorAll: function (s) { return querySelectorAll(this, s); },
  getElementsByClassName: function (c) { return querySelectorAll(this, String(c).trim().split(/\s+/).map(function (x) { return "." + x; }).join("")); },
  getElementsByTagName: function (t) { return querySelectorAll(this, t === "*" ? "*" : String(t)); },
  matches: function (s) { return matchesSelector(this, s); },
  closest: function (s) { for (var n = this; n && n.nodeType === 1; n = n.parentNode) if (matchesSelector(n, s)) return n; return null; },
  click: function () { fireTap(this); },
  focus: function () { document.activeElement = this; },
  blur: function () {},
  scrollIntoView: function () {}, scrollTo: function () {}, scrollBy: function () {},
  animate: function () { return { finished: Promise.resolve(), cancel: function () {}, play: function () {}, pause: function () {}, onfinish: null }; },
  getBoundingClientRect: function () { return { x: 0, y: 0, top: 0, left: 0, width: 320, height: 24, right: 320, bottom: 24 }; },
  getClientRects: function () { return [this.getBoundingClientRect()]; },
  insertAdjacentHTML: function (pos, html) {
    var f = document.createDocumentFragment(); parseHTML(String(html), f, false);
    insertAdjacent(this, pos, f);
  },
  insertAdjacentElement: function (pos, el) { insertAdjacent(this, pos, el); return el; },
  insertAdjacentText: function (pos, t) { insertAdjacent(this, pos, document.createTextNode(String(t))); },
  getContext: function (kind) { return this.localName === "canvas" && kind === "2d" ? canvasContext(this) : null; },
  toDataURL: function () { return "data:image/png;base64,"; },
});
function insertAdjacent(el, pos, node) {
  pos = String(pos).toLowerCase();
  if (pos === "beforebegin") el.parentNode && el.parentNode.insertBefore(node, el);
  else if (pos === "afterbegin") el.insertBefore(node, el.firstChild);
  else if (pos === "beforeend") el.appendChild(node);
  else if (pos === "afterend") el.parentNode && el.parentNode.insertBefore(node, el.nextSibling);
  else throw new SyntaxError("insertAdjacent: invalid position " + pos);
}
function attrProp(name, attr, kind) {
  Object.defineProperty(Element.prototype, name, {
    get: function () { var v = this.getAttribute(attr); if (kind === "bool") return v !== null; if (kind === "num") return v === null ? 0 : Number(v); return v === null ? "" : v; },
    set: function (v) { if (kind === "bool") { if (v) this.setAttribute(attr, ""); else this.removeAttribute(attr); } else this.setAttribute(attr, v); },
  });
}
[["id", "id"], ["className", "class"], ["title", "title"], ["href", "href"], ["src", "src"], ["alt", "alt"], ["type", "type"], ["name", "name"], ["role", "role"], ["lang", "lang"], ["dir", "dir"]].forEach(function (p) { attrProp(p[0], p[1]); });
[["hidden", "hidden"], ["disabled", "disabled"], ["checked", "checked"], ["open", "open"], ["selected", "selected"]].forEach(function (p) { attrProp(p[0], p[1], "bool"); });
[["width", "width"], ["height", "height"], ["tabIndex", "tabindex"]].forEach(function (p) { attrProp(p[0], p[1], "num"); });
Object.defineProperties(Element.prototype, {
  tagName: { get: function () { return this.localName.toUpperCase(); } },
  nodeName: { get: function () { return this.localName.toUpperCase(); } },
  classList: { get: function () { return new ClassList(this); } },
  value: { get: function () { var v = this.getAttribute("value"); return v === null ? "" : v; }, set: function (v) { this.setAttribute("value", v); } },
  dataset: { get: function () {
    var el = this;
    return new Proxy({}, {
      get: function (t, k) { if (typeof k !== "string") return undefined; var v = el.getAttribute("data-" + camelToKebab(k)); return v === null ? undefined : v; },
      set: function (t, k, v) { el.setAttribute("data-" + camelToKebab(String(k)), v); return true; },
      has: function (t, k) { return el.hasAttribute("data-" + camelToKebab(String(k))); },
      deleteProperty: function (t, k) { el.removeAttribute("data-" + camelToKebab(String(k))); return true; },
      ownKeys: function () { return el.getAttributeNames().filter(function (n) { return n.startsWith("data-"); }).map(function (n) { return n.slice(5).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }); },
      getOwnPropertyDescriptor: function (t, k) { var v = el.getAttribute("data-" + camelToKebab(String(k))); return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }; },
    });
  } },
  innerHTML: {
    get: function () { return this.childNodes.map(serialize).join(""); },
    set: function (v) { this.replaceChildren(); parseHTML(String(v), this, false); },
  },
  outerHTML: { get: function () { return serialize(this); } },
  innerText: { get: function () { return this.textContent; }, set: function (v) { this.textContent = v; } },
  outerText: { get: function () { return this.textContent; } },
  offsetWidth: { get: function () { return 320; } }, offsetHeight: { get: function () { return 24; } },
  clientWidth: { get: function () { return 320; } }, clientHeight: { get: function () { return 24; } },
  scrollWidth: { get: function () { return 320; } }, scrollHeight: { get: function () { return 24; } },
  offsetLeft: { get: function () { return 0; } }, offsetTop: { get: function () { return 0; } },
  scrollTop: { get: function () { return 0; }, set: function () {} }, scrollLeft: { get: function () { return 0; }, set: function () {} },
  offsetParent: { get: function () { return this.parentElement; } },
});
EVENTS.forEach(function (type) {
  Object.defineProperty(Element.prototype, "on" + type, {
    get: function () { return this._on[type] || null; },
    set: function (fn) { this._on[type] = typeof fn === "function" ? fn : null; },
  });
});
function serialize(n) {
  if (n.nodeType === 3) return n.parentNode && (n.parentNode.localName === "script" || n.parentNode.localName === "style") ? n.data : esc(n.data);
  if (n.nodeType === 8) return "<!--" + n.data + "-->";
  if (n.nodeType === 11) return n.childNodes.map(serialize).join("");
  var a = "";
  n._attrs.forEach(function (v, k) { a += " " + k + '="' + esc(k === "style" ? n.style.cssText : v, true) + '"'; });
  if (VOID.has(n.localName)) return "<" + n.localName + a + ">";
  return "<" + n.localName + a + ">" + n.childNodes.map(serialize).join("") + "</" + n.localName + ">";
}

// ---------- document ----------
var document = new Node(9);
var docEl = new Element("html"), head = new Element("head"), body = new Element("body");
Node.prototype.appendChild.call(document, docEl); docEl.appendChild(head); docEl.appendChild(body);
Object.assign(document, {
  documentElement: docEl, head: head, body: body, readyState: "loading", activeElement: null, title: "", cookie: "",
  nodeName: "#document",
  get defaultView() { return G; },
  createElement: function (n) { return new Element(String(n).toLowerCase()); },
  createElementNS: function (ns, n) { return new Element(String(n).toLowerCase()); },
  createTextNode: function (t) { return new Text(t); },
  createComment: function (t) { return new Comment(t); },
  createDocumentFragment: function () { return new Fragment(); },
  getElementById: function (id) { id = String(id); return walkFind(docEl, function (e) { return e._attrs.get("id") === id; }); },
  querySelector: function (s) { return querySelectorAll(docEl, s, true)[0] || null; },
  querySelectorAll: function (s) { return querySelectorAll(docEl, s, true); },
  getElementsByClassName: function (c) { return docEl.getElementsByClassName(c); },
  getElementsByTagName: function (t) { return querySelectorAll(docEl, t, true); },
  createEvent: function () { return new Event(""); },
  hasFocus: function () { return true; },
  elementFromPoint: function () { return null; },
  execCommand: function () { return false; },
});
function walkFind(root, pred) {
  for (var i = 0; i < root.childNodes.length; i++) { var c = root.childNodes[i]; if (c.nodeType !== 1) continue; if (pred(c)) return c; var r = walkFind(c, pred); if (r) return r; }
  return null;
}
function eachElement(root, fn) {
  for (var i = 0; i < root.childNodes.length; i++) { var c = root.childNodes[i]; if (c.nodeType !== 1) continue; if (fn(c) !== false) eachElement(c, fn); }
}

// ---------- HTML parsing ----------
var pending = null;
function parseHTML(html, parent, isDocument) {
  var stack = [parent];
  var i = 0;
  function top() { return stack[stack.length - 1]; }
  function text(t) { if (t) top().appendChild(document.createTextNode(decode(t))); }
  function closeTo(names) { for (var k = stack.length - 1; k > 0; k--) { var n = stack[k].localName; if (names.indexOf(n) >= 0) { stack.length = k; return; } if (["ul", "ol", "table", "tbody", "thead", "tr", "div", "section", "body"].indexOf(n) >= 0) return; } }
  function step() {
    while (i < html.length) {
      var lt = html.indexOf("<", i);
      if (lt < 0) { text(html.slice(i)); i = html.length; break; }
      if (lt > i) text(html.slice(i, lt));
      if (html.startsWith("<!--", lt)) { var e = html.indexOf("-->", lt + 4); i = e < 0 ? html.length : e + 3; continue; }
      if (html[lt + 1] === "!" || html[lt + 1] === "?") { var e2 = html.indexOf(">", lt); i = e2 < 0 ? html.length : e2 + 1; continue; }
      var rest = html.slice(lt);
      if (html[lt + 1] === "/") {
        var c = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(rest);
        if (!c) { text("<"); i = lt + 1; continue; }
        var cn = c[1].toLowerCase();
        for (var k = stack.length - 1; k > 0; k--) if (stack[k].localName === cn) { stack.length = k; break; }
        i = lt + c[0].length; continue;
      }
      var m = /^<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?)*)\s*(\/?)>/.exec(rest);
      if (!m) { text("<"); i = lt + 1; continue; }
      var name = m[1].toLowerCase();
      i = lt + m[0].length;
      if (isDocument && (name === "html" || name === "head" || name === "body")) { stack.push(name === "html" ? docEl : name === "head" ? head : body); continue; }
      if (name === "li") closeTo(["li"]);
      else if (name === "tr") closeTo(["tr"]);
      else if (name === "td" || name === "th") closeTo(["td", "th"]);
      else if (name === "option") closeTo(["option"]);
      else if (name === "p" || /^(div|ul|ol|table|h[1-6]|section)$/.test(name)) closeTo(["p"]);
      var el = document.createElement(name);
      var re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g, a;
      while ((a = re.exec(m[2]))) el.setAttribute(a[1].toLowerCase(), decode(a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : ""));
      top().appendChild(el);
      if (RAW.has(name)) {
        var close = new RegExp("</" + name + "\\s*>", "i");
        var after = html.slice(i); var cm = close.exec(after);
        var bodyText = cm ? after.slice(0, cm.index) : after;
        el.appendChild(document.createTextNode(name === "script" || name === "style" ? bodyText : decode(bodyText)));
        i += cm ? cm.index + cm[0].length : after.length;
        if (name === "script" && isDocument) return el;
        continue;
      }
      if (!VOID.has(name) && !m[3]) stack.push(el);
    }
    return null;
  }
  if (isDocument) return step;
  while (step()) {}
  return null;
}

// ---------- selectors ----------
var selectorCache = new Map();
function splitTop(s, sep) {
  var out = [], depth = 0, q = null, cur = "";
  for (var i = 0; i < s.length; i++) {
    var ch = s[i];
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseSelector(text) {
  var cached = selectorCache.get(text);
  if (cached) return cached;
  var out = [];
  splitTop(String(text), ",").forEach(function (part) {
    var s = part.trim(), steps = [], comb = " ", i = 0;
    while (i < s.length) {
      var ws = false;
      while (i < s.length && /\s/.test(s[i])) { i++; ws = true; }
      if (s[i] === ">" || s[i] === "+" || s[i] === "~") { comb = s[i]; i++; while (i < s.length && /\s/.test(s[i])) i++; }
      else if (ws && steps.length) comb = " ";
      var c = { tag: null, id: null, classes: [], attrs: [], pseudos: [], pseudoEl: null }, start = i;
      while (i < s.length && !/[\s>+~]/.test(s[i])) {
        var ch = s[i], rest = s.slice(i), m;
        if (ch === "*") { i++; continue; }
        if (ch === "#" || ch === ".") { m = /^[\w-]+/.exec(s.slice(i + 1)); var v = m ? m[0] : ""; i += 1 + v.length; if (ch === "#") c.id = v; else c.classes.push(v); continue; }
        if (ch === "[") {
          var end = s.indexOf("]", i), bodyT = s.slice(i + 1, end < 0 ? s.length : end); i = end < 0 ? s.length : end + 1;
          m = /^\s*([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]*)))?/.exec(bodyT);
          if (m) c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] || "" });
          continue;
        }
        if (ch === ":") {
          m = /^::?([\w-]+)(\((?:[^()]|\([^()]*\))*\))?/.exec(rest);
          if (!m) { i++; continue; }
          i += m[0].length;
          var pn = m[1].toLowerCase();
          if (rest[1] === ":" || pn === "before" || pn === "after") c.pseudoEl = pn; else c.pseudos.push({ name: pn, arg: m[2] ? m[2].slice(1, -1) : null });
          continue;
        }
        m = /^[\w-]+/.exec(rest);
        if (m) { c.tag = m[0].toLowerCase(); i += m[0].length; continue; }
        i++;
      }
      if (i > start) { steps.push({ comb: steps.length ? comb : null, c: c }); comb = " "; }
    }
    if (steps.length) out.push(steps);
  });
  selectorCache.set(text, out);
  return out;
}
var DYNAMIC = new Set(["hover", "active", "focus", "focus-visible", "focus-within", "visited", "target", "link"]);
function siblingsOf(el) { return el.parentNode ? el.parentNode.childNodes.filter(function (n) { return n.nodeType === 1; }) : [el]; }
function nth(arg, index) {
  arg = String(arg || "").replace(/\s+/g, "").toLowerCase();
  if (arg === "odd") return index % 2 === 1;
  if (arg === "even") return index % 2 === 0;
  var m = /^([+-]?\d*)n([+-]\d+)?$/.exec(arg);
  if (!m) return index === Number(arg);
  var a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]), b = Number(m[2] || 0);
  return a === 0 ? index === b : (index - b) / a >= 0 && (index - b) % a === 0;
}
function matchCompound(el, c, live) {
  if (el.nodeType !== 1) return false;
  if (c.tag && c.tag !== el.localName) return false;
  if (c.id !== null && el._attrs.get("id") !== c.id) return false;
  if (c.classes.length) { var cls = (el._attrs.get("class") || "").split(/\s+/); for (var i = 0; i < c.classes.length; i++) if (cls.indexOf(c.classes[i]) < 0) return false; }
  for (var j = 0; j < c.attrs.length; j++) {
    var at = c.attrs[j], v = el.getAttribute(at.name);
    if (v === null) return false;
    if (at.op === "=" && v !== at.value) return false;
    if (at.op === "~=" && v.split(/\s+/).indexOf(at.value) < 0) return false;
    if (at.op === "^=" && !v.startsWith(at.value)) return false;
    if (at.op === "$=" && !v.endsWith(at.value)) return false;
    if (at.op === "*=" && v.indexOf(at.value) < 0) return false;
    if (at.op === "|=" && v !== at.value && !v.startsWith(at.value + "-")) return false;
  }
  for (var k = 0; k < c.pseudos.length; k++) {
    var p = c.pseudos[k], sib, idx;
    // Nothing is hovered, focused or pressed in a trial run.
    if (DYNAMIC.has(p.name)) return false;
    switch (p.name) {
      case "first-child": if (siblingsOf(el)[0] !== el) return false; break;
      case "last-child": sib = siblingsOf(el); if (sib[sib.length - 1] !== el) return false; break;
      case "only-child": if (siblingsOf(el).length !== 1) return false; break;
      case "nth-child": if (!nth(p.arg, siblingsOf(el).indexOf(el) + 1)) return false; break;
      case "nth-last-child": sib = siblingsOf(el); if (!nth(p.arg, sib.length - sib.indexOf(el))) return false; break;
      case "first-of-type": if (siblingsOf(el).filter(function (s) { return s.localName === el.localName; })[0] !== el) return false; break;
      case "last-of-type": sib = siblingsOf(el).filter(function (s) { return s.localName === el.localName; }); if (sib[sib.length - 1] !== el) return false; break;
      case "nth-of-type": idx = siblingsOf(el).filter(function (s) { return s.localName === el.localName; }).indexOf(el) + 1; if (!nth(p.arg, idx)) return false; break;
      case "not": if (matchesSelector(el, p.arg, live)) return false; break;
      case "is": case "where": if (!matchesSelector(el, p.arg, live)) return false; break;
      case "has": if (!querySelectorAll(el, p.arg).length) return false; break;
      case "empty": if (el.childNodes.some(function (n) { return n.nodeType === 1 || (n.nodeType === 3 && n.data); })) return false; break;
      case "checked": case "disabled": case "open": if (!el.hasAttribute(p.name)) return false; break;
      case "enabled": if (el.hasAttribute("disabled")) return false; break;
      case "root": if (el !== docEl) return false; break;
      default: return false;
    }
  }
  return true;
}
function matchSteps(el, steps, k, live) {
  if (!matchCompound(el, steps[k].c, live)) return false;
  if (k === 0) return true;
  var comb = steps[k].comb, p;
  if (comb === ">") { p = el.parentNode; return !!p && p.nodeType === 1 && matchSteps(p, steps, k - 1, live); }
  if (comb === "+") { p = el.previousElementSibling; return !!p && matchSteps(p, steps, k - 1, live); }
  if (comb === "~") { for (p = el.previousElementSibling; p; p = p.previousElementSibling) if (matchSteps(p, steps, k - 1, live)) return true; return false; }
  for (p = el.parentNode; p && p.nodeType === 1; p = p.parentNode) if (matchSteps(p, steps, k - 1, live)) return true;
  return false;
}
function matchesSelector(el, sel, live) {
  var list = parseSelector(sel);
  for (var i = 0; i < list.length; i++) if (matchSteps(el, list[i], list[i].length - 1, live !== false)) return true;
  return false;
}
function querySelectorAll(root, sel, includeRoot) {
  var out = [];
  if (includeRoot && root.nodeType === 1 && matchesSelector(root, sel)) out.push(root);
  eachElement(root, function (e) { if (matchesSelector(e, sel)) out.push(e); });
  return out;
}
`;
