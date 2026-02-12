"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [82431],
  {
    8121: (e, t, n) => {
      n.d(t, { A: () => l });
      let r = {}.hasOwnProperty;
      function l(e, t) {
        let n = t || {};
        function l(t, ...n) {
          let s = l.invalid,
            o = l.handlers;
          if (t && r.call(t, e)) {
            let n = String(t[e]);
            s = r.call(o, n) ? o[n] : l.unknown;
          }
          if (s) {
            return s.call(this, t, ...n);
          }
        }
        return (
          (l.handlers = n.handlers || {}), (l.invalid = n.invalid), (l.unknown = n.unknown), l
        );
      }
    },
    13980: (e, t, n) => {
      n.d(t, { b: () => r });
      let r = [
        "area",
        "base",
        "basefont",
        "bgsound",
        "br",
        "col",
        "command",
        "embed",
        "frame",
        "hr",
        "image",
        "img",
        "input",
        "keygen",
        "link",
        "meta",
        "param",
        "source",
        "track",
        "wbr",
      ];
    },
    29424: (e, t, n) => {
      n.d(t, { DI: () => eg, OR: () => ed, Sx: () => h, j8: () => C, zz: () => m });
      var r = n(40459);
      function l(e, ...t) {
        return (
          t.forEach((t) => {
            for (let n in t) {
              e[n] = t[n];
            }
          }),
          e
        );
      }
      var s = /\$(\d+)|\${(\d+):\/(downcase|upcase)}/g,
        o = class {
          static hasCaptures(e) {
            return null !== e && ((s.lastIndex = 0), s.test(e));
          }
          static replaceCaptures(e, t, n) {
            return e.replace(s, (e, r, l, s) => {
              let o = n[parseInt(r || l, 10)];
              if (!o) {
                return e;
              }
              {
                let e = t.substring(o.start, o.end);
                for (; "." === e[0]; ) {
                  e = e.substring(1);
                }
                switch (s) {
                  case "downcase":
                    return e.toLowerCase();
                  case "upcase":
                    return e.toUpperCase();
                  default:
                    return e;
                }
              }
            });
          }
        };
      function a(e, t) {
        if (null === e && null === t) {
          return 0;
        }
        if (!e) {
          return -1;
        }
        if (!t) {
          return 1;
        }
        let n = e.length,
          r = t.length;
        if (n === r) {
          for (let r = 0; r < n; r++) {
            var l, s;
            let n = ((l = e[r]), l < (s = t[r]) ? -1 : +(l > s));
            if (0 !== n) {
              return n;
            }
          }
          return 0;
        }
        return n - r;
      }
      function i(e) {
        return !!(
          /^#[0-9a-f]{6}$/i.test(e) ||
          /^#[0-9a-f]{8}$/i.test(e) ||
          /^#[0-9a-f]{3}$/i.test(e) ||
          /^#[0-9a-f]{4}$/i.test(e)
        );
      }
      function u(e) {
        return e.replace(/[-\\{}*+?|^$.,[\]()#\s]/g, "\\$&");
      }
      var c = class {
          constructor(e) {
            this.fn = e;
          }
          cache = new Map();
          get(e) {
            if (this.cache.has(e)) {
              return this.cache.get(e);
            }
            let t = this.fn(e);
            return (this.cache.set(e, t), t);
          }
        },
        h = class {
          constructor(e, t, n) {
            ((this._colorMap = e), (this._defaults = t), (this._root = n));
          }
          static createFromRawTheme(e, t) {
            return this.createFromParsedTheme(
              (function (e) {
                if (!e || !e.settings || !Array.isArray(e.settings)) {
                  return [];
                }
                let t = e.settings,
                  n = [],
                  r = 0;
                for (let e = 0, l = t.length; e < l; e++) {
                  let l,
                    s = t[e];
                  if (!s.settings) {
                    continue;
                  }
                  if ("string" == typeof s.scope) {
                    let e = s.scope;
                    l = (e = (e = e.replace(/^[,]+/, "")).replace(/[,]+$/, "")).split(",");
                  } else {
                    l = Array.isArray(s.scope) ? s.scope : [""];
                  }
                  let o = -1;
                  if ("string" == typeof s.settings.fontStyle) {
                    o = 0;
                    let e = s.settings.fontStyle.split(" ");
                    for (let t = 0, n = e.length; t < n; t++) {
                      switch (e[t]) {
                        case "italic":
                          o |= 1;
                          break;
                        case "bold":
                          o |= 2;
                          break;
                        case "underline":
                          o |= 4;
                          break;
                        case "strikethrough":
                          o |= 8;
                      }
                    }
                  }
                  let a = null;
                  "string" == typeof s.settings.foreground &&
                    i(s.settings.foreground) &&
                    (a = s.settings.foreground);
                  let u = null;
                  "string" == typeof s.settings.background &&
                    i(s.settings.background) &&
                    (u = s.settings.background);
                  for (let t = 0, s = l.length; t < s; t++) {
                    let s = l[t].trim().split(" "),
                      i = s[s.length - 1],
                      c = null;
                    (s.length > 1 && (c = s.slice(0, s.length - 1)).toReversed(),
                      (n[r++] = new g(i, c, e, o, a, u)));
                  }
                }
                return n;
              })(e),
              t,
            );
          }
          static createFromParsedTheme(e, t) {
            return (function (e, t) {
              e.sort((e, t) => {
                var n, r;
                let l = ((n = e.scope), n < (r = t.scope) ? -1 : +(n > r));
                return 0 !== l || 0 !== (l = a(e.parentScopes, t.parentScopes))
                  ? l
                  : e.index - t.index;
              });
              let n = 0,
                r = "#000000",
                l = "#ffffff";
              for (; e.length >= 1 && "" === e[0].scope; ) {
                let t = e.shift();
                (-1 !== t.fontStyle && (n = t.fontStyle),
                  null !== t.foreground && (r = t.foreground),
                  null !== t.background && (l = t.background));
              }
              let s = new f(t),
                o = new d(n, s.getId(r), s.getId(l)),
                i = new b(new y(0, null, -1, 0, 0), []);
              for (let t = 0, n = e.length; t < n; t++) {
                let n = e[t];
                i.insert(
                  0,
                  n.scope,
                  n.parentScopes,
                  n.fontStyle,
                  s.getId(n.foreground),
                  s.getId(n.background),
                );
              }
              return new h(s, o, i);
            })(e, t);
          }
          _cachedMatchRoot = new c((e) => this._root.match(e));
          getColorMap() {
            return this._colorMap.getColorMap();
          }
          getDefaults() {
            return this._defaults;
          }
          match(e) {
            if (null === e) {
              return this._defaults;
            }
            let t = e.scopeName,
              n = this._cachedMatchRoot.get(t).find((t) =>
                (function (e, t) {
                  if (0 === t.length) {
                    return !0;
                  }
                  for (let l = 0; l < t.length; l++) {
                    var n, r;
                    let s = t[l],
                      o = !1;
                    if (">" === s) {
                      if (l === t.length - 1) {
                        return !1;
                      }
                      ((s = t[++l]), (o = !0));
                    }
                    for (
                      ;
                      e &&
                      ((n = e.scopeName),
                      !((r = s) === n || (n.startsWith(r) && "." === n[r.length])));
                    ) {
                      if (o) {
                        return !1;
                      }
                      e = e.parent;
                    }
                    if (!e) {
                      return !1;
                    }
                    e = e.parent;
                  }
                  return !0;
                })(e.parent, t.parentScopes),
              );
            return n ? new d(n.fontStyle, n.foreground, n.background) : null;
          }
        },
        p = class e {
          constructor(e, t) {
            ((this.parent = e), (this.scopeName = t));
          }
          static push(t, n) {
            for (let r of n) {
              t = new e(t, r);
            }
            return t;
          }
          static from(...t) {
            let n = null;
            for (let r = 0; r < t.length; r++) {
              n = new e(n, t[r]);
            }
            return n;
          }
          push(t) {
            return new e(this, t);
          }
          getSegments() {
            let e = this,
              t = [];
            for (; e; ) {
              (t.push(e.scopeName), (e = e.parent));
            }
            return (t.toReversed(), t);
          }
          toString() {
            return this.getSegments().join(" ");
          }
          extends(e) {
            return this === e || (null !== this.parent && this.parent.extends(e));
          }
          getExtensionIfDefined(e) {
            let t = [],
              n = this;
            for (; n && n !== e; ) {
              (t.push(n.scopeName), (n = n.parent));
            }
            return n === e ? t.toReversed() : void 0;
          }
        },
        d = class {
          constructor(e, t, n) {
            ((this.fontStyle = e), (this.foregroundId = t), (this.backgroundId = n));
          }
        },
        g = class {
          constructor(e, t, n, r, l, s) {
            ((this.scope = e),
              (this.parentScopes = t),
              (this.index = n),
              (this.fontStyle = r),
              (this.foreground = l),
              (this.background = s));
          }
        },
        m = ((e) => (
          (e[(e.NotSet = -1)] = "NotSet"),
          (e[(e.None = 0)] = "None"),
          (e[(e.Italic = 1)] = "Italic"),
          (e[(e.Bold = 2)] = "Bold"),
          (e[(e.Underline = 4)] = "Underline"),
          (e[(e.Strikethrough = 8)] = "Strikethrough"),
          e
        ))(m || {}),
        f = class {
          _isFrozen;
          _lastColorId;
          _id2color;
          _color2id;
          constructor(e) {
            if (
              ((this._lastColorId = 0),
              (this._id2color = []),
              (this._color2id = Object.create(null)),
              Array.isArray(e))
            ) {
              this._isFrozen = !0;
              for (let t = 0, n = e.length; t < n; t++) {
                ((this._color2id[e[t]] = t), (this._id2color[t] = e[t]));
              }
            } else {
              this._isFrozen = !1;
            }
          }
          getId(e) {
            if (null === e) {
              return 0;
            }
            e = e.toUpperCase();
            let t = this._color2id[e];
            if (t) {
              return t;
            }
            if (this._isFrozen) {
              throw Error(`Missing color in color map - ${e}`);
            }
            return ((t = ++this._lastColorId), (this._color2id[e] = t), (this._id2color[t] = e), t);
          }
          getColorMap() {
            return this._id2color.slice(0);
          }
        },
        _ = Object.freeze([]),
        y = class e {
          scopeDepth;
          parentScopes;
          fontStyle;
          foreground;
          background;
          constructor(e, t, n, r, l) {
            ((this.scopeDepth = e),
              (this.parentScopes = t || _),
              (this.fontStyle = n),
              (this.foreground = r),
              (this.background = l));
          }
          clone() {
            return new e(
              this.scopeDepth,
              this.parentScopes,
              this.fontStyle,
              this.foreground,
              this.background,
            );
          }
          static cloneArr(e) {
            let t = [];
            for (let n = 0, r = e.length; n < r; n++) {
              t[n] = e[n].clone();
            }
            return t;
          }
          acceptOverwrite(e, t, n, r) {
            (this.scopeDepth > e ? console.log("how did this happen?") : (this.scopeDepth = e),
              -1 !== t && (this.fontStyle = t),
              0 !== n && (this.foreground = n),
              0 !== r && (this.background = r));
          }
        },
        b = class e {
          constructor(e, t = [], n = {}) {
            ((this._mainRule = e), (this._children = n), (this._rulesWithParentScopes = t));
          }
          _rulesWithParentScopes;
          static _cmpBySpecificity(e, t) {
            if (e.scopeDepth !== t.scopeDepth) {
              return t.scopeDepth - e.scopeDepth;
            }
            let n = 0,
              r = 0;
            for (
              ;
              ">" === e.parentScopes[n] && n++,
                ">" === t.parentScopes[r] && r++,
                !(n >= e.parentScopes.length) && !(r >= t.parentScopes.length);
            ) {
              let l = t.parentScopes[r].length - e.parentScopes[n].length;
              if (0 !== l) {
                return l;
              }
              (n++, r++);
            }
            return t.parentScopes.length - e.parentScopes.length;
          }
          match(t) {
            if ("" !== t) {
              let e,
                n,
                r = t.indexOf(".");
              if (
                (-1 === r
                  ? ((e = t), (n = ""))
                  : ((e = t.substring(0, r)), (n = t.substring(r + 1))),
                this._children.hasOwnProperty(e))
              ) {
                return this._children[e].match(n);
              }
            }
            let n = this._rulesWithParentScopes.concat(this._mainRule);
            return (n.toSorted(e._cmpBySpecificity), n);
          }
          insert(t, n, r, l, s, o) {
            let a, i, u;
            if ("" === n) {
              return this._doInsertHere(t, r, l, s, o);
            }
            let c = n.indexOf(".");
            (-1 === c ? ((a = n), (i = "")) : ((a = n.substring(0, c)), (i = n.substring(c + 1))),
              this._children.hasOwnProperty(a)
                ? (u = this._children[a])
                : ((u = new e(this._mainRule.clone(), y.cloneArr(this._rulesWithParentScopes))),
                  (this._children[a] = u)),
              u.insert(t + 1, i, r, l, s, o));
          }
          _doInsertHere(e, t, n, r, l) {
            if (null === t) {
              return void this._mainRule.acceptOverwrite(e, n, r, l);
            }
            for (let s = 0, o = this._rulesWithParentScopes.length; s < o; s++) {
              let o = this._rulesWithParentScopes[s];
              if (0 === a(o.parentScopes, t)) {
                return void o.acceptOverwrite(e, n, r, l);
              }
            }
            (-1 === n && (n = this._mainRule.fontStyle),
              0 === r && (r = this._mainRule.foreground),
              0 === l && (l = this._mainRule.background),
              this._rulesWithParentScopes.push(new y(e, t, n, r, l)));
          }
        },
        C = class e {
          static toBinaryStr(e) {
            return e.toString(2).padStart(32, "0");
          }
          static print(t) {
            let n = e.getLanguageId(t),
              r = e.getTokenType(t),
              l = e.getFontStyle(t);
            console.log({
              languageId: n,
              tokenType: r,
              fontStyle: l,
              foreground: e.getForeground(t),
              background: e.getBackground(t),
            });
          }
          static getLanguageId(e) {
            return (255 & e) >>> 0;
          }
          static getTokenType(e) {
            return (768 & e) >>> 8;
          }
          static containsBalancedBrackets(e) {
            return (1024 & e) != 0;
          }
          static getFontStyle(e) {
            return (30720 & e) >>> 11;
          }
          static getForeground(e) {
            return (0xff8000 & e) >>> 15;
          }
          static getBackground(e) {
            return (0xff000000 & e) >>> 24;
          }
          static set(t, n, r, l, s, o, a) {
            let i = e.getLanguageId(t),
              u = e.getTokenType(t),
              c = +!!e.containsBalancedBrackets(t),
              h = e.getFontStyle(t),
              p = e.getForeground(t),
              d = e.getBackground(t);
            return (
              0 !== n && (i = n),
              8 !== r && (u = r),
              null !== l && (c = +!!l),
              -1 !== s && (h = s),
              0 !== o && (p = o),
              0 !== a && (d = a),
              (0 | i | (u << 8) | (c << 10) | (h << 11) | (p << 15) | (d << 24)) >>> 0
            );
          }
        };
      function S(e, t) {
        var n;
        let r,
          l,
          s = [],
          o =
            ((n = e),
            (l = (r = /([LR]:|[\w.:][\w.:-]*|[,|\-()])/g).exec(n)),
            {
              next: () => {
                if (!l) {
                  return null;
                }
                let e = l[0];
                return ((l = r.exec(n)), e);
              },
            }),
          a = o.next();
        for (; null !== a; ) {
          let e = 0;
          if (2 === a.length && ":" === a.charAt(1)) {
            switch (a.charAt(0)) {
              case "R":
                e = 1;
                break;
              case "L":
                e = -1;
                break;
              default:
                console.log(`Unknown priority ${a} in scope selector`);
            }
            a = o.next();
          }
          let t = u();
          if ((s.push({ matcher: t, priority: e }), "," !== a)) {
            break;
          }
          a = o.next();
        }
        return s;
        function i() {
          if ("-" === a) {
            a = o.next();
            let e = i();
            return (t) => !!e && !e(t);
          }
          if ("(" === a) {
            a = o.next();
            let e = (function () {
              let e = [],
                t = u();
              for (; t && (e.push(t), "|" === a || "," === a); ) {
                do {
                  a = o.next();
                } while ("|" === a || "," === a);
                t = u();
              }
              return (t) => e.some((e) => e(t));
            })();
            return (")" === a && (a = o.next()), e);
          }
          if (k(a)) {
            let e = [];
            do {
              (e.push(a), (a = o.next()));
            } while (k(a));
            return (n) => t(e, n);
          }
          return null;
        }
        function u() {
          let e = [],
            t = i();
          for (; t; ) {
            (e.push(t), (t = i()));
          }
          return (t) => e.every((e) => e(t));
        }
      }
      function k(e) {
        return !!e && !!e.match(/[\w.:]+/);
      }
      var v = ((e) => (
        (e[(e.None = 0)] = "None"),
        (e[(e.NotBeginString = 1)] = "NotBeginString"),
        (e[(e.NotEndString = 2)] = "NotEndString"),
        (e[(e.NotBeginPosition = 4)] = "NotBeginPosition"),
        (e[(e.DebugCall = 8)] = "DebugCall"),
        e
      ))(v || {});
      function w(e) {
        "function" == typeof e.dispose && e.dispose();
      }
      var A = class {
          constructor(e) {
            this.scopeName = e;
          }
          toKey() {
            return this.scopeName;
          }
        },
        P = class {
          constructor(e, t) {
            ((this.scopeName = e), (this.ruleName = t));
          }
          toKey() {
            return `${this.scopeName}#${this.ruleName}`;
          }
        },
        N = class {
          _references = [];
          _seenReferenceKeys = new Set();
          get references() {
            return this._references;
          }
          visitedRule = new Set();
          add(e) {
            let t = e.toKey();
            this._seenReferenceKeys.has(t) ||
              (this._seenReferenceKeys.add(t), this._references.push(e));
          }
        },
        R = class {
          constructor(e, t) {
            ((this.repo = e),
              (this.initialScopeName = t),
              this.seenFullScopeRequests.add(this.initialScopeName),
              (this.Q = [new A(this.initialScopeName)]));
          }
          seenFullScopeRequests = new Set();
          seenPartialScopeRequests = new Set();
          Q;
          processQueue() {
            let e = this.Q;
            this.Q = [];
            let t = new N();
            for (let n of e) {
              !(function (e, t, n, r) {
                let l = n.lookup(e.scopeName);
                if (!l) {
                  if (e.scopeName === t) throw Error(`No grammar provided for <${t}>`);
                  return;
                }
                let s = n.lookup(t);
                e instanceof A
                  ? E({ baseGrammar: s, selfGrammar: l }, r)
                  : x(e.ruleName, { baseGrammar: s, selfGrammar: l, repository: l.repository }, r);
                let o = n.injections(e.scopeName);
                if (o) for (let e of o) r.add(new A(e));
              })(n, this.initialScopeName, this.repo, t);
            }
            for (let e of t.references) {
              if (e instanceof A) {
                if (this.seenFullScopeRequests.has(e.scopeName)) continue;
                (this.seenFullScopeRequests.add(e.scopeName), this.Q.push(e));
              } else {
                if (
                  this.seenFullScopeRequests.has(e.scopeName) ||
                  this.seenPartialScopeRequests.has(e.toKey())
                )
                  continue;
                (this.seenPartialScopeRequests.add(e.toKey()), this.Q.push(e));
              }
            }
          }
        };
      function x(e, t, n) {
        t.repository && t.repository[e] && I([t.repository[e]], t, n);
      }
      function E(e, t) {
        (e.selfGrammar.patterns &&
          Array.isArray(e.selfGrammar.patterns) &&
          I(e.selfGrammar.patterns, { ...e, repository: e.selfGrammar.repository }, t),
          e.selfGrammar.injections &&
            I(
              Object.values(e.selfGrammar.injections),
              { ...e, repository: e.selfGrammar.repository },
              t,
            ));
      }
      function I(e, t, n) {
        for (let r of e) {
          if (n.visitedRule.has(r)) {
            continue;
          }
          n.visitedRule.add(r);
          let e = r.repository ? l({}, t.repository, r.repository) : t.repository;
          Array.isArray(r.patterns) && I(r.patterns, { ...t, repository: e }, n);
          let s = r.include;
          if (!s) {
            continue;
          }
          let o = G(s);
          switch (o.kind) {
            case 0:
              E({ ...t, selfGrammar: t.baseGrammar }, n);
              break;
            case 1:
              E(t, n);
              break;
            case 2:
              x(o.ruleName, { ...t, repository: e }, n);
              break;
            case 3:
            case 4:
              let a =
                o.scopeName === t.selfGrammar.scopeName
                  ? t.selfGrammar
                  : o.scopeName === t.baseGrammar.scopeName
                    ? t.baseGrammar
                    : void 0;
              if (a) {
                let r = { baseGrammar: t.baseGrammar, selfGrammar: a, repository: e };
                4 === o.kind ? x(o.ruleName, r, n) : E(r, n);
              } else {
                4 === o.kind ? n.add(new P(o.scopeName, o.ruleName)) : n.add(new A(o.scopeName));
              }
          }
        }
      }
      var L = class {
          kind = 0;
        },
        T = class {
          kind = 1;
        },
        O = class {
          constructor(e) {
            this.ruleName = e;
          }
          kind = 2;
        },
        M = class {
          constructor(e) {
            this.scopeName = e;
          }
          kind = 3;
        },
        D = class {
          constructor(e, t) {
            ((this.scopeName = e), (this.ruleName = t));
          }
          kind = 4;
        };
      function G(e) {
        if ("$base" === e) {
          return new L();
        }
        if ("$self" === e) {
          return new T();
        }
        let t = e.indexOf("#");
        return -1 === t
          ? new M(e)
          : 0 === t
            ? new O(e.substring(1))
            : new D(e.substring(0, t), e.substring(t + 1));
      }
      var B = /\\(\d+)/,
        F = /\\(\d+)/g;
      Symbol("RuleId");
      var U = class {
          $location;
          id;
          _nameIsCapturing;
          _name;
          _contentNameIsCapturing;
          _contentName;
          constructor(e, t, n, r) {
            ((this.$location = e),
              (this.id = t),
              (this._name = n || null),
              (this._nameIsCapturing = o.hasCaptures(this._name)),
              (this._contentName = r || null),
              (this._contentNameIsCapturing = o.hasCaptures(this._contentName)));
          }
          get debugName() {
            let e = this.$location
              ? `${(function e(t) {
                  let n = ~t.lastIndexOf("/") || ~t.lastIndexOf("\\");
                  return 0 === n
                    ? t
                    : ~n == t.length - 1
                      ? e(t.substring(0, t.length - 1))
                      : t.substr(~n + 1);
                })(this.$location.filename)}:${this.$location.line}`
              : "unknown";
            return `${this.constructor.name}#${this.id} @ ${e}`;
          }
          getName(e, t) {
            return this._nameIsCapturing && null !== this._name && null !== e && null !== t
              ? o.replaceCaptures(this._name, e, t)
              : this._name;
          }
          getContentName(e, t) {
            return this._contentNameIsCapturing && null !== this._contentName
              ? o.replaceCaptures(this._contentName, e, t)
              : this._contentName;
          }
        },
        j = class extends U {
          retokenizeCapturedWithRuleId;
          constructor(e, t, n, r, l) {
            (super(e, t, n, r), (this.retokenizeCapturedWithRuleId = l));
          }
          dispose() {}
          collectPatterns(e, t) {
            throw Error("Not supported!");
          }
          compile(e, t) {
            throw Error("Not supported!");
          }
          compileAG(e, t, n, r) {
            throw Error("Not supported!");
          }
        },
        q = class extends U {
          _match;
          captures;
          _cachedCompiledPatterns;
          constructor(e, t, n, r, l) {
            (super(e, t, n, null),
              (this._match = new K(r, this.id)),
              (this.captures = l),
              (this._cachedCompiledPatterns = null));
          }
          dispose() {
            this._cachedCompiledPatterns &&
              (this._cachedCompiledPatterns.dispose(), (this._cachedCompiledPatterns = null));
          }
          get debugMatchRegExp() {
            return `${this._match.source}`;
          }
          collectPatterns(e, t) {
            t.push(this._match);
          }
          compile(e, t) {
            return this._getCachedCompiledPatterns(e).compile(e);
          }
          compileAG(e, t, n, r) {
            return this._getCachedCompiledPatterns(e).compileAG(e, n, r);
          }
          _getCachedCompiledPatterns(e) {
            return (
              this._cachedCompiledPatterns ||
                ((this._cachedCompiledPatterns = new V()),
                this.collectPatterns(e, this._cachedCompiledPatterns)),
              this._cachedCompiledPatterns
            );
          }
        },
        z = class extends U {
          hasMissingPatterns;
          patterns;
          _cachedCompiledPatterns;
          constructor(e, t, n, r, l) {
            (super(e, t, n, r),
              (this.patterns = l.patterns),
              (this.hasMissingPatterns = l.hasMissingPatterns),
              (this._cachedCompiledPatterns = null));
          }
          dispose() {
            this._cachedCompiledPatterns &&
              (this._cachedCompiledPatterns.dispose(), (this._cachedCompiledPatterns = null));
          }
          collectPatterns(e, t) {
            for (let n of this.patterns) {
              e.getRule(n).collectPatterns(e, t);
            }
          }
          compile(e, t) {
            return this._getCachedCompiledPatterns(e).compile(e);
          }
          compileAG(e, t, n, r) {
            return this._getCachedCompiledPatterns(e).compileAG(e, n, r);
          }
          _getCachedCompiledPatterns(e) {
            return (
              this._cachedCompiledPatterns ||
                ((this._cachedCompiledPatterns = new V()),
                this.collectPatterns(e, this._cachedCompiledPatterns)),
              this._cachedCompiledPatterns
            );
          }
        },
        $ = class extends U {
          _begin;
          beginCaptures;
          _end;
          endHasBackReferences;
          endCaptures;
          applyEndPatternLast;
          hasMissingPatterns;
          patterns;
          _cachedCompiledPatterns;
          constructor(e, t, n, r, l, s, o, a, i, u) {
            (super(e, t, n, r),
              (this._begin = new K(l, this.id)),
              (this.beginCaptures = s),
              (this._end = new K(o || "￿", -1)),
              (this.endHasBackReferences = this._end.hasBackReferences),
              (this.endCaptures = a),
              (this.applyEndPatternLast = i || !1),
              (this.patterns = u.patterns),
              (this.hasMissingPatterns = u.hasMissingPatterns),
              (this._cachedCompiledPatterns = null));
          }
          dispose() {
            this._cachedCompiledPatterns &&
              (this._cachedCompiledPatterns.dispose(), (this._cachedCompiledPatterns = null));
          }
          get debugBeginRegExp() {
            return `${this._begin.source}`;
          }
          get debugEndRegExp() {
            return `${this._end.source}`;
          }
          getEndWithResolvedBackReferences(e, t) {
            return this._end.resolveBackReferences(e, t);
          }
          collectPatterns(e, t) {
            t.push(this._begin);
          }
          compile(e, t) {
            return this._getCachedCompiledPatterns(e, t).compile(e);
          }
          compileAG(e, t, n, r) {
            return this._getCachedCompiledPatterns(e, t).compileAG(e, n, r);
          }
          _getCachedCompiledPatterns(e, t) {
            if (!this._cachedCompiledPatterns) {
              for (let t of ((this._cachedCompiledPatterns = new V()), this.patterns)) {
                e.getRule(t).collectPatterns(e, this._cachedCompiledPatterns);
              }
              this.applyEndPatternLast
                ? this._cachedCompiledPatterns.push(
                    this._end.hasBackReferences ? this._end.clone() : this._end,
                  )
                : this._cachedCompiledPatterns.unshift(
                    this._end.hasBackReferences ? this._end.clone() : this._end,
                  );
            }
            return (
              this._end.hasBackReferences &&
                (this.applyEndPatternLast
                  ? this._cachedCompiledPatterns.setSource(
                      this._cachedCompiledPatterns.length() - 1,
                      t,
                    )
                  : this._cachedCompiledPatterns.setSource(0, t)),
              this._cachedCompiledPatterns
            );
          }
        },
        W = class extends U {
          _begin;
          beginCaptures;
          whileCaptures;
          _while;
          whileHasBackReferences;
          hasMissingPatterns;
          patterns;
          _cachedCompiledPatterns;
          _cachedCompiledWhilePatterns;
          constructor(e, t, n, r, l, s, o, a, i) {
            (super(e, t, n, r),
              (this._begin = new K(l, this.id)),
              (this.beginCaptures = s),
              (this.whileCaptures = a),
              (this._while = new K(o, -2)),
              (this.whileHasBackReferences = this._while.hasBackReferences),
              (this.patterns = i.patterns),
              (this.hasMissingPatterns = i.hasMissingPatterns),
              (this._cachedCompiledPatterns = null),
              (this._cachedCompiledWhilePatterns = null));
          }
          dispose() {
            (this._cachedCompiledPatterns &&
              (this._cachedCompiledPatterns.dispose(), (this._cachedCompiledPatterns = null)),
              this._cachedCompiledWhilePatterns &&
                (this._cachedCompiledWhilePatterns.dispose(),
                (this._cachedCompiledWhilePatterns = null)));
          }
          get debugBeginRegExp() {
            return `${this._begin.source}`;
          }
          get debugWhileRegExp() {
            return `${this._while.source}`;
          }
          getWhileWithResolvedBackReferences(e, t) {
            return this._while.resolveBackReferences(e, t);
          }
          collectPatterns(e, t) {
            t.push(this._begin);
          }
          compile(e, t) {
            return this._getCachedCompiledPatterns(e).compile(e);
          }
          compileAG(e, t, n, r) {
            return this._getCachedCompiledPatterns(e).compileAG(e, n, r);
          }
          _getCachedCompiledPatterns(e) {
            if (!this._cachedCompiledPatterns) {
              for (let t of ((this._cachedCompiledPatterns = new V()), this.patterns))
                e.getRule(t).collectPatterns(e, this._cachedCompiledPatterns);
            }
            return this._cachedCompiledPatterns;
          }
          compileWhile(e, t) {
            return this._getCachedCompiledWhilePatterns(e, t).compile(e);
          }
          compileWhileAG(e, t, n, r) {
            return this._getCachedCompiledWhilePatterns(e, t).compileAG(e, n, r);
          }
          _getCachedCompiledWhilePatterns(e, t) {
            return (
              this._cachedCompiledWhilePatterns ||
                ((this._cachedCompiledWhilePatterns = new V()),
                this._cachedCompiledWhilePatterns.push(
                  this._while.hasBackReferences ? this._while.clone() : this._while,
                )),
              this._while.hasBackReferences &&
                this._cachedCompiledWhilePatterns.setSource(0, t || "￿"),
              this._cachedCompiledWhilePatterns
            );
          }
        },
        H = class e {
          static createCaptureRule(e, t, n, r, l) {
            return e.registerRule((e) => new j(t, e, n, r, l));
          }
          static getCompiledRuleId(t, n, r) {
            return (
              t.id ||
                n.registerRule((s) => {
                  if (((t.id = s), t.match)) {
                    return new q(
                      t.$vscodeTextmateLocation,
                      t.id,
                      t.name,
                      t.match,
                      e._compileCaptures(t.captures, n, r),
                    );
                  }
                  if (void 0 === t.begin) {
                    t.repository && (r = l({}, r, t.repository));
                    let s = t.patterns;
                    return (
                      void 0 === s && t.include && (s = [{ include: t.include }]),
                      new z(
                        t.$vscodeTextmateLocation,
                        t.id,
                        t.name,
                        t.contentName,
                        e._compilePatterns(s, n, r),
                      )
                    );
                  }
                  return t.while
                    ? new W(
                        t.$vscodeTextmateLocation,
                        t.id,
                        t.name,
                        t.contentName,
                        t.begin,
                        e._compileCaptures(t.beginCaptures || t.captures, n, r),
                        t.while,
                        e._compileCaptures(t.whileCaptures || t.captures, n, r),
                        e._compilePatterns(t.patterns, n, r),
                      )
                    : new $(
                        t.$vscodeTextmateLocation,
                        t.id,
                        t.name,
                        t.contentName,
                        t.begin,
                        e._compileCaptures(t.beginCaptures || t.captures, n, r),
                        t.end,
                        e._compileCaptures(t.endCaptures || t.captures, n, r),
                        t.applyEndPatternLast,
                        e._compilePatterns(t.patterns, n, r),
                      );
                }),
              t.id
            );
          }
          static _compileCaptures(t, n, r) {
            let l = [];
            if (t) {
              let s = 0;
              for (let e in t) {
                if ("$vscodeTextmateLocation" === e) {
                  continue;
                }
                let t = parseInt(e, 10);
                t > s && (s = t);
              }
              for (let e = 0; e <= s; e++) {
                l[e] = null;
              }
              for (let s in t) {
                if ("$vscodeTextmateLocation" === s) {
                  continue;
                }
                let o = parseInt(s, 10),
                  a = 0;
                (t[s].patterns && (a = e.getCompiledRuleId(t[s], n, r)),
                  (l[o] = e.createCaptureRule(
                    n,
                    t[s].$vscodeTextmateLocation,
                    t[s].name,
                    t[s].contentName,
                    a,
                  )));
              }
            }
            return l;
          }
          static _compilePatterns(t, n, r) {
            let l = [];
            if (t) {
              for (let s = 0, o = t.length; s < o; s++) {
                let o = t[s],
                  a = -1;
                if (o.include) {
                  let t = G(o.include);
                  switch (t.kind) {
                    case 0:
                    case 1:
                      a = e.getCompiledRuleId(r[o.include], n, r);
                      break;
                    case 2:
                      let l = r[t.ruleName];
                      l && (a = e.getCompiledRuleId(l, n, r));
                      break;
                    case 3:
                    case 4:
                      let s = t.scopeName,
                        i = 4 === t.kind ? t.ruleName : null,
                        u = n.getExternalGrammar(s, r);
                      if (u)
                        if (i) {
                          let t = u.repository[i];
                          t && (a = e.getCompiledRuleId(t, n, u.repository));
                        } else a = e.getCompiledRuleId(u.repository.$self, n, u.repository);
                  }
                } else a = e.getCompiledRuleId(o, n, r);
                if (-1 !== a) {
                  let e = n.getRule(a),
                    t = !1;
                  if (
                    ((e instanceof z || e instanceof $ || e instanceof W) &&
                      e.hasMissingPatterns &&
                      0 === e.patterns.length &&
                      (t = !0),
                    t)
                  )
                    continue;
                  l.push(a);
                }
              }
            }
            return { patterns: l, hasMissingPatterns: (t ? t.length : 0) !== l.length };
          }
        },
        K = class e {
          source;
          ruleId;
          hasAnchor;
          hasBackReferences;
          _anchorCache;
          constructor(e, t) {
            if (e && "string" == typeof e) {
              let t = e.length,
                n = 0,
                r = [],
                l = !1;
              for (let s = 0; s < t; s++) {
                if ("\\" === e.charAt(s) && s + 1 < t) {
                  let t = e.charAt(s + 1);
                  ("z" === t
                    ? (r.push(e.substring(n, s)), r.push("$(?!\\n)(?<!\\n)"), (n = s + 2))
                    : ("A" === t || "G" === t) && (l = !0),
                    s++);
                }
              }
              ((this.hasAnchor = l),
                0 === n
                  ? (this.source = e)
                  : (r.push(e.substring(n, t)), (this.source = r.join(""))));
            } else {
              ((this.hasAnchor = !1), (this.source = e));
            }
            (this.hasAnchor
              ? (this._anchorCache = this._buildAnchorCache())
              : (this._anchorCache = null),
              (this.ruleId = t),
              "string" == typeof this.source
                ? (this.hasBackReferences = B.test(this.source))
                : (this.hasBackReferences = !1));
          }
          clone() {
            return new e(this.source, this.ruleId);
          }
          setSource(e) {
            this.source !== e &&
              ((this.source = e), this.hasAnchor && (this._anchorCache = this._buildAnchorCache()));
          }
          resolveBackReferences(e, t) {
            if ("string" != typeof this.source) {
              throw Error("This method should only be called if the source is a string");
            }
            let n = t.map((t) => e.substring(t.start, t.end));
            return (
              (F.lastIndex = 0), this.source.replace(F, (e, t) => u(n[parseInt(t, 10)] || ""))
            );
          }
          _buildAnchorCache() {
            let e, t, n, r;
            if ("string" != typeof this.source) {
              throw Error("This method should only be called if the source is a string");
            }
            let l = [],
              s = [],
              o = [],
              a = [];
            for (e = 0, t = this.source.length; e < t; e++) {
              ((n = this.source.charAt(e)),
                (l[e] = n),
                (s[e] = n),
                (o[e] = n),
                (a[e] = n),
                "\\" === n &&
                  e + 1 < t &&
                  ("A" === (r = this.source.charAt(e + 1))
                    ? ((l[e + 1] = "￿"), (s[e + 1] = "￿"), (o[e + 1] = "A"), (a[e + 1] = "A"))
                    : "G" === r
                      ? ((l[e + 1] = "￿"), (s[e + 1] = "G"), (o[e + 1] = "￿"), (a[e + 1] = "G"))
                      : ((l[e + 1] = r), (s[e + 1] = r), (o[e + 1] = r), (a[e + 1] = r)),
                  e++));
            }
            return { A0_G0: l.join(""), A0_G1: s.join(""), A1_G0: o.join(""), A1_G1: a.join("") };
          }
          resolveAnchors(e, t) {
            if (!this.hasAnchor || !this._anchorCache || "string" != typeof this.source) {
              return this.source;
            }
            if (e) {
              if (t) return this._anchorCache.A1_G1;
              else return this._anchorCache.A1_G0;
            }
            return t ? this._anchorCache.A0_G1 : this._anchorCache.A0_G0;
          }
        },
        V = class {
          _items;
          _hasAnchors;
          _cached;
          _anchorCache;
          constructor() {
            ((this._items = []),
              (this._hasAnchors = !1),
              (this._cached = null),
              (this._anchorCache = { A0_G0: null, A0_G1: null, A1_G0: null, A1_G1: null }));
          }
          dispose() {
            this._disposeCaches();
          }
          _disposeCaches() {
            (this._cached && (this._cached.dispose(), (this._cached = null)),
              this._anchorCache.A0_G0 &&
                (this._anchorCache.A0_G0.dispose(), (this._anchorCache.A0_G0 = null)),
              this._anchorCache.A0_G1 &&
                (this._anchorCache.A0_G1.dispose(), (this._anchorCache.A0_G1 = null)),
              this._anchorCache.A1_G0 &&
                (this._anchorCache.A1_G0.dispose(), (this._anchorCache.A1_G0 = null)),
              this._anchorCache.A1_G1 &&
                (this._anchorCache.A1_G1.dispose(), (this._anchorCache.A1_G1 = null)));
          }
          push(e) {
            (this._items.push(e), (this._hasAnchors = this._hasAnchors || e.hasAnchor));
          }
          unshift(e) {
            (this._items.unshift(e), (this._hasAnchors = this._hasAnchors || e.hasAnchor));
          }
          length() {
            return this._items.length;
          }
          setSource(e, t) {
            this._items[e].source !== t && (this._disposeCaches(), this._items[e].setSource(t));
          }
          compile(e) {
            if (!this._cached) {
              let t = this._items.map((e) => e.source);
              this._cached = new Y(
                e,
                t,
                this._items.map((e) => e.ruleId),
              );
            }
            return this._cached;
          }
          compileAG(e, t, n) {
            if (!this._hasAnchors) {
              return this.compile(e);
            }
            if (t) {
              if (n)
                return (
                  this._anchorCache.A1_G1 ||
                    (this._anchorCache.A1_G1 = this._resolveAnchors(e, t, n)),
                  this._anchorCache.A1_G1
                );
              else
                return (
                  this._anchorCache.A1_G0 ||
                    (this._anchorCache.A1_G0 = this._resolveAnchors(e, t, n)),
                  this._anchorCache.A1_G0
                );
            }
            return n
              ? (this._anchorCache.A0_G1 ||
                  (this._anchorCache.A0_G1 = this._resolveAnchors(e, t, n)),
                this._anchorCache.A0_G1)
              : (this._anchorCache.A0_G0 ||
                  (this._anchorCache.A0_G0 = this._resolveAnchors(e, t, n)),
                this._anchorCache.A0_G0);
          }
          _resolveAnchors(e, t, n) {
            return new Y(
              e,
              this._items.map((e) => e.resolveAnchors(t, n)),
              this._items.map((e) => e.ruleId),
            );
          }
        },
        Y = class {
          constructor(e, t, n) {
            ((this.regExps = t), (this.rules = n), (this.scanner = e.createOnigScanner(t)));
          }
          scanner;
          dispose() {
            "function" == typeof this.scanner.dispose && this.scanner.dispose();
          }
          toString() {
            let e = [];
            for (let t = 0, n = this.rules.length; t < n; t++) {
              e.push("   - " + this.rules[t] + ": " + this.regExps[t]);
            }
            return e.join("\n");
          }
          findNextMatchSync(e, t, n) {
            let r = this.scanner.findNextMatchSync(e, t, n);
            return r ? { ruleId: this.rules[r.index], captureIndices: r.captureIndices } : null;
          }
        },
        X = class {
          constructor(e, t) {
            ((this.languageId = e), (this.tokenType = t));
          }
        },
        Q = class e {
          _defaultAttributes;
          _embeddedLanguagesMatcher;
          constructor(e, t) {
            ((this._defaultAttributes = new X(e, 8)),
              (this._embeddedLanguagesMatcher = new Z(Object.entries(t || {}))));
          }
          getDefaultAttributes() {
            return this._defaultAttributes;
          }
          getBasicScopeAttributes(t) {
            return null === t ? e._NULL_SCOPE_METADATA : this._getBasicScopeAttributes.get(t);
          }
          static _NULL_SCOPE_METADATA = new X(0, 0);
          _getBasicScopeAttributes = new c(
            (e) => new X(this._scopeToLanguage(e), this._toStandardTokenType(e)),
          );
          _scopeToLanguage(e) {
            return this._embeddedLanguagesMatcher.match(e) || 0;
          }
          _toStandardTokenType(t) {
            let n = t.match(e.STANDARD_TOKEN_TYPE_REGEXP);
            if (!n) {
              return 8;
            }
            switch (n[1]) {
              case "comment":
                return 1;
              case "string":
                return 2;
              case "regex":
                return 3;
              case "meta.embedded":
                return 0;
            }
            throw Error("Unexpected match for standard token type!");
          }
          static STANDARD_TOKEN_TYPE_REGEXP = /\b(comment|string|regex|meta\.embedded)\b/;
        },
        Z = class {
          values;
          scopesRegExp;
          constructor(e) {
            if (0 === e.length) {
              ((this.values = null), (this.scopesRegExp = null));
            } else {
              this.values = new Map(e);
              let t = e.map(([e, t]) => u(e));
              (t.toSorted(),
                t.toReversed(),
                (this.scopesRegExp = RegExp(`^((${t.join(")|(")}))($|\\.)`, "")));
            }
          }
          match(e) {
            if (!this.scopesRegExp) {
              return;
            }
            let t = e.match(this.scopesRegExp);
            if (t) {
              return this.values.get(t[1]);
            }
          }
        };
      void 0 !== r && r.env.VSCODE_TEXTMATE_DEBUG;
      var J = class {
        constructor(e, t) {
          ((this.stack = e), (this.stoppedEarly = t));
        }
      };
      function ee(e, t, n, r, l, s, o, a) {
        let i = t.content.length,
          u = !1,
          c = -1;
        if (o) {
          let o = (function (e, t, n, r, l, s) {
            let o = l.beginRuleCapturedEOL ? 0 : -1,
              a = [];
            for (let t = l; t; t = t.pop()) {
              let n = t.getRule(e);
              n instanceof W && a.push({ rule: n, stack: t });
            }
            for (let d = a.pop(); d; d = a.pop()) {
              var i, u, c, h, p;
              let { ruleScanner: a, findOptions: g } =
                  ((i = d.rule),
                  (u = e),
                  (c = d.stack.endRule),
                  (h = n),
                  (p = r === o),
                  { ruleScanner: i.compileWhileAG(u, c, h, p), findOptions: 0 }),
                m = a.findNextMatchSync(t, r, g);
              if (m) {
                if (-2 !== m.ruleId) {
                  l = d.stack.pop();
                  break;
                }
                m.captureIndices &&
                  m.captureIndices.length &&
                  (s.produce(d.stack, m.captureIndices[0].start),
                  en(e, t, n, d.stack, s, d.rule.whileCaptures, m.captureIndices),
                  s.produce(d.stack, m.captureIndices[0].end),
                  (o = m.captureIndices[0].end),
                  m.captureIndices[0].end > r && ((r = m.captureIndices[0].end), (n = !1)));
              } else {
                l = d.stack.pop();
                break;
              }
            }
            return { stack: l, linePos: r, anchorPosition: o, isFirstLine: n };
          })(e, t, n, r, l, s);
          ((l = o.stack), (r = o.linePos), (n = o.isFirstLine), (c = o.anchorPosition));
        }
        let h = Date.now();
        for (; !u; ) {
          if (0 !== a && Date.now() - h > a) {
            return new J(l, !0);
          }
          !(function () {
            let o = (function (e, t, n, r, l, s) {
              let o = (function (e, t, n, r, l, s) {
                  let { ruleScanner: o, findOptions: a } = et(
                      l.getRule(e),
                      e,
                      l.endRule,
                      n,
                      r === s,
                    ),
                    i = o.findNextMatchSync(t, r, a);
                  return i ? { captureIndices: i.captureIndices, matchedRuleId: i.ruleId } : null;
                })(e, t, n, r, l, s),
                a = e.getInjections();
              if (0 === a.length) {
                return o;
              }
              let i = (function (e, t, n, r, l, s, o) {
                let a,
                  i = Number.MAX_VALUE,
                  u = null,
                  c = 0,
                  h = s.contentNameScopesList.getScopeNames();
                for (let s = 0, p = e.length; s < p; s++) {
                  let p = e[s];
                  if (!p.matcher(h)) {
                    continue;
                  }
                  let { ruleScanner: d, findOptions: g } = et(
                      t.getRule(p.ruleId),
                      t,
                      null,
                      r,
                      l === o,
                    ),
                    m = d.findNextMatchSync(n, l, g);
                  if (!m) {
                    continue;
                  }
                  let f = m.captureIndices[0].start;
                  if (
                    !(f >= i) &&
                    ((i = f), (u = m.captureIndices), (a = m.ruleId), (c = p.priority), i === l)
                  ) {
                    break;
                  }
                }
                return u ? { priorityMatch: -1 === c, captureIndices: u, matchedRuleId: a } : null;
              })(a, e, t, n, r, l, s);
              if (!i) {
                return o;
              }
              if (!o) {
                return i;
              }
              let u = o.captureIndices[0].start,
                c = i.captureIndices[0].start;
              return c < u || (i.priorityMatch && c === u) ? i : o;
            })(e, t, n, r, l, c);
            if (!o) {
              (s.produce(l, i), (u = !0));
              return;
            }
            let a = o.captureIndices,
              h = o.matchedRuleId,
              p = !!a && a.length > 0 && a[0].end > r;
            if (-1 === h) {
              let o = l.getRule(e);
              (s.produce(l, a[0].start),
                (l = l.withContentNameScopesList(l.nameScopesList)),
                en(e, t, n, l, s, o.endCaptures, a),
                s.produce(l, a[0].end));
              let h = l;
              if (((l = l.parent), (c = h.getAnchorPos()), !p && h.getEnterPos() === r)) {
                ((l = h), s.produce(l, i), (u = !0));
                return;
              }
            } else {
              let o = e.getRule(h);
              s.produce(l, a[0].start);
              let d = l,
                g = o.getName(t.content, a),
                m = l.contentNameScopesList.pushAttributed(g, e);
              if (((l = l.push(h, r, c, a[0].end === i, null, m, m)), o instanceof $)) {
                (en(e, t, n, l, s, o.beginCaptures, a), s.produce(l, a[0].end), (c = a[0].end));
                let r = o.getContentName(t.content, a),
                  h = m.pushAttributed(r, e);
                if (
                  ((l = l.withContentNameScopesList(h)),
                  o.endHasBackReferences &&
                    (l = l.withEndRule(o.getEndWithResolvedBackReferences(t.content, a))),
                  !p && d.hasSameRuleAs(l))
                ) {
                  ((l = l.pop()), s.produce(l, i), (u = !0));
                  return;
                }
              } else if (o instanceof W) {
                (en(e, t, n, l, s, o.beginCaptures, a), s.produce(l, a[0].end), (c = a[0].end));
                let r = o.getContentName(t.content, a),
                  h = m.pushAttributed(r, e);
                if (
                  ((l = l.withContentNameScopesList(h)),
                  o.whileHasBackReferences &&
                    (l = l.withEndRule(o.getWhileWithResolvedBackReferences(t.content, a))),
                  !p && d.hasSameRuleAs(l))
                ) {
                  ((l = l.pop()), s.produce(l, i), (u = !0));
                  return;
                }
              } else if (
                (en(e, t, n, l, s, o.captures, a), s.produce(l, a[0].end), (l = l.pop()), !p)
              ) {
                ((l = l.safePop()), s.produce(l, i), (u = !0));
                return;
              }
            }
            a[0].end > r && ((r = a[0].end), (n = !1));
          })();
        }
        return new J(l, !1);
      }
      function et(e, t, n, r, l) {
        return { ruleScanner: e.compileAG(t, n, r, l), findOptions: 0 };
      }
      function en(e, t, n, r, l, s, o) {
        if (0 === s.length) {
          return;
        }
        let a = t.content,
          i = Math.min(s.length, o.length),
          u = [],
          c = o[0].end;
        for (let t = 0; t < i; t++) {
          let i = s[t];
          if (null === i) {
            continue;
          }
          let h = o[t];
          if (0 === h.length) {
            continue;
          }
          if (h.start > c) {
            break;
          }
          for (; u.length > 0 && u[u.length - 1].endPos <= h.start; ) {
            (l.produceFromScopes(u[u.length - 1].scopes, u[u.length - 1].endPos), u.pop());
          }
          if (
            (u.length > 0
              ? l.produceFromScopes(u[u.length - 1].scopes, h.start)
              : l.produce(r, h.start),
            i.retokenizeCapturedWithRuleId)
          ) {
            let t = i.getName(a, o),
              s = r.contentNameScopesList.pushAttributed(t, e),
              u = i.getContentName(a, o),
              c = s.pushAttributed(u, e),
              p = r.push(i.retokenizeCapturedWithRuleId, h.start, -1, !1, null, s, c),
              d = e.createOnigString(a.substring(0, h.end));
            (ee(e, d, n && 0 === h.start, h.start, p, l, !1, 0), w(d));
            continue;
          }
          let p = i.getName(a, o);
          if (null !== p) {
            let t = (
              u.length > 0 ? u[u.length - 1].scopes : r.contentNameScopesList
            ).pushAttributed(p, e);
            u.push(new er(t, h.end));
          }
        }
        for (; u.length > 0; ) {
          (l.produceFromScopes(u[u.length - 1].scopes, u[u.length - 1].endPos), u.pop());
        }
      }
      var er = class {
        scopes;
        endPos;
        constructor(e, t) {
          ((this.scopes = e), (this.endPos = t));
        }
      };
      function el(e, t, n, r, l) {
        let s = S(t, es),
          o = H.getCompiledRuleId(n, r, l.repository);
        for (let n of s) {
          e.push({
            debugSelector: t,
            matcher: n.matcher,
            ruleId: o,
            grammar: l,
            priority: n.priority,
          });
        }
      }
      function es(e, t) {
        if (t.length < e.length) {
          return !1;
        }
        let n = 0;
        return e.every((e) => {
          for (let r = n; r < t.length; r++) {
            if (
              (function (e, t) {
                if (!e) return !1;
                if (e === t) return !0;
                let n = t.length;
                return e.length > n && e.substr(0, n) === t && "." === e[n];
              })(t[r], e)
            )
              return ((n = r + 1), !0);
          }
          return !1;
        });
      }
      var eo = class {
        constructor(e, t, n, r, l, s, o, a) {
          if (
            ((this._rootScopeName = e),
            (this.balancedBracketSelectors = s),
            (this._onigLib = a),
            (this._basicScopeAttributesProvider = new Q(n, r)),
            (this._rootId = -1),
            (this._lastRuleId = 0),
            (this._ruleId2desc = [null]),
            (this._includedGrammars = {}),
            (this._grammarRepository = o),
            (this._grammar = ea(t, null)),
            (this._injections = null),
            (this._tokenTypeMatchers = []),
            l)
          ) {
            for (let e of Object.keys(l))
              for (let t of S(e, es))
                this._tokenTypeMatchers.push({ matcher: t.matcher, type: l[e] });
          }
        }
        _rootId;
        _lastRuleId;
        _ruleId2desc;
        _includedGrammars;
        _grammarRepository;
        _grammar;
        _injections;
        _basicScopeAttributesProvider;
        _tokenTypeMatchers;
        get themeProvider() {
          return this._grammarRepository;
        }
        dispose() {
          for (let e of this._ruleId2desc) {
            e && e.dispose();
          }
        }
        createOnigScanner(e) {
          return this._onigLib.createOnigScanner(e);
        }
        createOnigString(e) {
          return this._onigLib.createOnigString(e);
        }
        getMetadataForScope(e) {
          return this._basicScopeAttributesProvider.getBasicScopeAttributes(e);
        }
        _collectInjections() {
          let e = [],
            t = this._rootScopeName,
            n = {
              lookup: (e) =>
                e === this._rootScopeName ? this._grammar : this.getExternalGrammar(e),
              injections: (e) => this._grammarRepository.injections(e),
            }.lookup(t);
          if (n) {
            let r = n.injections;
            if (r) {
              for (let t in r) el(e, t, r[t], this, n);
            }
            let l = this._grammarRepository.injections(t);
            l &&
              l.forEach((t) => {
                let n = this.getExternalGrammar(t);
                if (n) {
                  let t = n.injectionSelector;
                  t && el(e, t, n, this, n);
                }
              });
          }
          return (e.toSorted((e, t) => e.priority - t.priority), e);
        }
        getInjections() {
          return (
            null === this._injections && (this._injections = this._collectInjections()),
            this._injections
          );
        }
        registerRule(e) {
          let t = ++this._lastRuleId,
            n = e(t);
          return ((this._ruleId2desc[t] = n), n);
        }
        getRule(e) {
          return this._ruleId2desc[e];
        }
        getExternalGrammar(e, t) {
          if (this._includedGrammars[e]) {
            return this._includedGrammars[e];
          }
          if (this._grammarRepository) {
            let n = this._grammarRepository.lookup(e);
            if (n) {
              return ((this._includedGrammars[e] = ea(n, t && t.$base)), this._includedGrammars[e]);
            }
          }
        }
        tokenizeLine(e, t, n = 0) {
          let r = this._tokenize(e, t, !1, n);
          return {
            tokens: r.lineTokens.getResult(r.ruleStack, r.lineLength),
            ruleStack: r.ruleStack,
            stoppedEarly: r.stoppedEarly,
          };
        }
        tokenizeLine2(e, t, n = 0) {
          let r = this._tokenize(e, t, !0, n);
          return {
            tokens: r.lineTokens.getBinaryResult(r.ruleStack, r.lineLength),
            ruleStack: r.ruleStack,
            stoppedEarly: r.stoppedEarly,
          };
        }
        _tokenize(e, t, n, r) {
          let l;
          if (
            (-1 === this._rootId &&
              ((this._rootId = H.getCompiledRuleId(
                this._grammar.repository.$self,
                this,
                this._grammar.repository,
              )),
              this.getInjections()),
            t && t !== eu.NULL)
          ) {
            ((l = !1), t.reset());
          } else {
            let e;
            l = !0;
            let n = this._basicScopeAttributesProvider.getDefaultAttributes(),
              r = this.themeProvider.getDefaults(),
              s = C.set(
                0,
                n.languageId,
                n.tokenType,
                null,
                r.fontStyle,
                r.foregroundId,
                r.backgroundId,
              ),
              o = this.getRule(this._rootId).getName(null, null);
            ((e = o ? ei.createRootAndLookUpScopeName(o, s, this) : ei.createRoot("unknown", s)),
              (t = new eu(null, this._rootId, -1, -1, !1, null, e, e)));
          }
          e += "\n";
          let s = this.createOnigString(e),
            o = s.content.length,
            a = new eh(n, e, this._tokenTypeMatchers, this.balancedBracketSelectors),
            i = ee(this, s, l, 0, t, a, !0, r);
          return (
            w(s), { lineLength: o, lineTokens: a, ruleStack: i.stack, stoppedEarly: i.stoppedEarly }
          );
        }
      };
      function ea(e, t) {
        return (
          ((e = (function e(t) {
            return Array.isArray(t)
              ? (function (t) {
                  let n = [];
                  for (let r = 0, l = t.length; r < l; r++) {
                    n[r] = e(t[r]);
                  }
                  return n;
                })(t)
              : t instanceof RegExp
                ? t
                : "object" == typeof t
                  ? (function (t) {
                      let n = {};
                      for (let r in t) {
                        n[r] = e(t[r]);
                      }
                      return n;
                    })(t)
                  : t;
          })(e)).repository = e.repository || {}),
          (e.repository.$self = {
            $vscodeTextmateLocation: e.$vscodeTextmateLocation,
            patterns: e.patterns,
            name: e.scopeName,
          }),
          (e.repository.$base = t || e.repository.$self),
          e
        );
      }
      var ei = class e {
          constructor(e, t, n) {
            ((this.parent = e), (this.scopePath = t), (this.tokenAttributes = n));
          }
          static fromExtension(t, n) {
            let r = t,
              l = t?.scopePath ?? null;
            for (let t of n) {
              r = new e(r, (l = p.push(l, t.scopeNames)), t.encodedTokenAttributes);
            }
            return r;
          }
          static createRoot(t, n) {
            return new e(null, new p(null, t), n);
          }
          static createRootAndLookUpScopeName(t, n, r) {
            let l = r.getMetadataForScope(t),
              s = new p(null, t),
              o = r.themeProvider.themeMatch(s),
              a = e.mergeAttributes(n, l, o);
            return new e(null, s, a);
          }
          get scopeName() {
            return this.scopePath.scopeName;
          }
          toString() {
            return this.getScopeNames().join(" ");
          }
          equals(t) {
            return e.equals(this, t);
          }
          static equals(e, t) {
            for (;;) {
              if (e === t || (!e && !t)) {
                return !0;
              }
              if (
                !e ||
                !t ||
                e.scopeName !== t.scopeName ||
                e.tokenAttributes !== t.tokenAttributes
              ) {
                return !1;
              }
              ((e = e.parent), (t = t.parent));
            }
          }
          static mergeAttributes(e, t, n) {
            let r = -1,
              l = 0,
              s = 0;
            return (
              null !== n && ((r = n.fontStyle), (l = n.foregroundId), (s = n.backgroundId)),
              C.set(e, t.languageId, t.tokenType, null, r, l, s)
            );
          }
          pushAttributed(t, n) {
            if (null === t) {
              return this;
            }
            if (-1 === t.indexOf(" ")) {
              return e._pushAttributed(this, t, n);
            }
            let r = t.split(/ /g),
              l = this;
            for (let t of r) {
              l = e._pushAttributed(l, t, n);
            }
            return l;
          }
          static _pushAttributed(t, n, r) {
            let l = r.getMetadataForScope(n),
              s = t.scopePath.push(n),
              o = r.themeProvider.themeMatch(s),
              a = e.mergeAttributes(t.tokenAttributes, l, o);
            return new e(t, s, a);
          }
          getScopeNames() {
            return this.scopePath.getSegments();
          }
          getExtensionIfDefined(e) {
            let t = [],
              n = this;
            for (; n && n !== e; ) {
              (t.push({
                encodedTokenAttributes: n.tokenAttributes,
                scopeNames: n.scopePath.getExtensionIfDefined(n.parent?.scopePath ?? null),
              }),
                (n = n.parent));
            }
            return n === e ? t.toReversed() : void 0;
          }
        },
        eu = class e {
          constructor(e, t, n, r, l, s, o, a) {
            ((this.parent = e),
              (this.ruleId = t),
              (this.beginRuleCapturedEOL = l),
              (this.endRule = s),
              (this.nameScopesList = o),
              (this.contentNameScopesList = a),
              (this.depth = this.parent ? this.parent.depth + 1 : 1),
              (this._enterPos = n),
              (this._anchorPos = r));
          }
          _stackElementBrand = void 0;
          static NULL = new e(null, 0, 0, 0, !1, null, null, null);
          _enterPos;
          _anchorPos;
          depth;
          equals(t) {
            return null !== t && e._equals(this, t);
          }
          static _equals(e, t) {
            return (
              e === t ||
              (!!this._structuralEquals(e, t) &&
                ei.equals(e.contentNameScopesList, t.contentNameScopesList))
            );
          }
          static _structuralEquals(e, t) {
            for (;;) {
              if (e === t || (!e && !t)) {
                return !0;
              }
              if (
                !e ||
                !t ||
                e.depth !== t.depth ||
                e.ruleId !== t.ruleId ||
                e.endRule !== t.endRule
              ) {
                return !1;
              }
              ((e = e.parent), (t = t.parent));
            }
          }
          clone() {
            return this;
          }
          static _reset(e) {
            for (; e; ) {
              ((e._enterPos = -1), (e._anchorPos = -1), (e = e.parent));
            }
          }
          reset() {
            e._reset(this);
          }
          pop() {
            return this.parent;
          }
          safePop() {
            return this.parent ? this.parent : this;
          }
          push(t, n, r, l, s, o, a) {
            return new e(this, t, n, r, l, s, o, a);
          }
          getEnterPos() {
            return this._enterPos;
          }
          getAnchorPos() {
            return this._anchorPos;
          }
          getRule(e) {
            return e.getRule(this.ruleId);
          }
          toString() {
            let e = [];
            return (this._writeString(e, 0), "[" + e.join(",") + "]");
          }
          _writeString(e, t) {
            return (
              this.parent && (t = this.parent._writeString(e, t)),
              (e[t++] =
                `(${this.ruleId}, ${this.nameScopesList?.toString()}, ${this.contentNameScopesList?.toString()})`),
              t
            );
          }
          withContentNameScopesList(e) {
            return this.contentNameScopesList === e
              ? this
              : this.parent.push(
                  this.ruleId,
                  this._enterPos,
                  this._anchorPos,
                  this.beginRuleCapturedEOL,
                  this.endRule,
                  this.nameScopesList,
                  e,
                );
          }
          withEndRule(t) {
            return this.endRule === t
              ? this
              : new e(
                  this.parent,
                  this.ruleId,
                  this._enterPos,
                  this._anchorPos,
                  this.beginRuleCapturedEOL,
                  t,
                  this.nameScopesList,
                  this.contentNameScopesList,
                );
          }
          hasSameRuleAs(e) {
            let t = this;
            for (; t && t._enterPos === e._enterPos; ) {
              if (t.ruleId === e.ruleId) {
                return !0;
              }
              t = t.parent;
            }
            return !1;
          }
          toStateStackFrame() {
            return {
              ruleId: this.ruleId,
              beginRuleCapturedEOL: this.beginRuleCapturedEOL,
              endRule: this.endRule,
              nameScopesList:
                this.nameScopesList?.getExtensionIfDefined(this.parent?.nameScopesList ?? null) ??
                [],
              contentNameScopesList:
                this.contentNameScopesList?.getExtensionIfDefined(this.nameScopesList) ?? [],
            };
          }
          static pushFrame(t, n) {
            let r = ei.fromExtension(t?.nameScopesList ?? null, n.nameScopesList);
            return new e(
              t,
              n.ruleId,
              n.enterPos ?? -1,
              n.anchorPos ?? -1,
              n.beginRuleCapturedEOL,
              n.endRule,
              r,
              ei.fromExtension(r, n.contentNameScopesList),
            );
          }
        },
        ec = class {
          balancedBracketScopes;
          unbalancedBracketScopes;
          allowAny = !1;
          constructor(e, t) {
            ((this.balancedBracketScopes = e.flatMap((e) =>
              "*" === e ? ((this.allowAny = !0), []) : S(e, es).map((e) => e.matcher),
            )),
              (this.unbalancedBracketScopes = t.flatMap((e) => S(e, es).map((e) => e.matcher))));
          }
          get matchesAlways() {
            return this.allowAny && 0 === this.unbalancedBracketScopes.length;
          }
          get matchesNever() {
            return 0 === this.balancedBracketScopes.length && !this.allowAny;
          }
          match(e) {
            for (let t of this.unbalancedBracketScopes) {
              if (t(e)) return !1;
            }
            for (let t of this.balancedBracketScopes) {
              if (t(e)) return !0;
            }
            return this.allowAny;
          }
        },
        eh = class {
          constructor(e, t, n, r) {
            ((this.balancedBracketSelectors = r),
              (this._emitBinaryTokens = e),
              (this._tokenTypeOverrides = n),
              (this._lineText = null),
              (this._tokens = []),
              (this._binaryTokens = []),
              (this._lastTokenEndIndex = 0));
          }
          _emitBinaryTokens;
          _lineText;
          _tokens;
          _binaryTokens;
          _lastTokenEndIndex;
          _tokenTypeOverrides;
          produce(e, t) {
            this.produceFromScopes(e.contentNameScopesList, t);
          }
          produceFromScopes(e, t) {
            if (this._lastTokenEndIndex >= t) {
              return;
            }
            if (this._emitBinaryTokens) {
              let n = e?.tokenAttributes ?? 0,
                r = !1;
              if (
                (this.balancedBracketSelectors?.matchesAlways && (r = !0),
                this._tokenTypeOverrides.length > 0 ||
                  (this.balancedBracketSelectors &&
                    !this.balancedBracketSelectors.matchesAlways &&
                    !this.balancedBracketSelectors.matchesNever))
              ) {
                let t = e?.getScopeNames() ?? [];
                for (let e of this._tokenTypeOverrides) {
                  e.matcher(t) && (n = C.set(n, 0, e.type, null, -1, 0, 0));
                }
                this.balancedBracketSelectors && (r = this.balancedBracketSelectors.match(t));
              }
              if (
                (r && (n = C.set(n, 0, 8, r, -1, 0, 0)),
                this._binaryTokens.length > 0 &&
                  this._binaryTokens[this._binaryTokens.length - 1] === n)
              ) {
                this._lastTokenEndIndex = t;
                return;
              }
              (this._binaryTokens.push(this._lastTokenEndIndex),
                this._binaryTokens.push(n),
                (this._lastTokenEndIndex = t));
              return;
            }
            let n = e?.getScopeNames() ?? [];
            (this._tokens.push({ startIndex: this._lastTokenEndIndex, endIndex: t, scopes: n }),
              (this._lastTokenEndIndex = t));
          }
          getResult(e, t) {
            return (
              this._tokens.length > 0 &&
                this._tokens[this._tokens.length - 1].startIndex === t - 1 &&
                this._tokens.pop(),
              0 === this._tokens.length &&
                ((this._lastTokenEndIndex = -1),
                this.produce(e, t),
                (this._tokens[this._tokens.length - 1].startIndex = 0)),
              this._tokens
            );
          }
          getBinaryResult(e, t) {
            (this._binaryTokens.length > 0 &&
              this._binaryTokens[this._binaryTokens.length - 2] === t - 1 &&
              (this._binaryTokens.pop(), this._binaryTokens.pop()),
              0 === this._binaryTokens.length &&
                ((this._lastTokenEndIndex = -1),
                this.produce(e, t),
                (this._binaryTokens[this._binaryTokens.length - 2] = 0)));
            let n = new Uint32Array(this._binaryTokens.length);
            for (let e = 0, t = this._binaryTokens.length; e < t; e++) {
              n[e] = this._binaryTokens[e];
            }
            return n;
          }
        },
        ep = class {
          constructor(e, t) {
            ((this._onigLib = t), (this._theme = e));
          }
          _grammars = new Map();
          _rawGrammars = new Map();
          _injectionGrammars = new Map();
          _theme;
          dispose() {
            for (let e of this._grammars.values()) {
              e.dispose();
            }
          }
          setTheme(e) {
            this._theme = e;
          }
          getColorMap() {
            return this._theme.getColorMap();
          }
          addGrammar(e, t) {
            (this._rawGrammars.set(e.scopeName, e),
              t && this._injectionGrammars.set(e.scopeName, t));
          }
          lookup(e) {
            return this._rawGrammars.get(e);
          }
          injections(e) {
            return this._injectionGrammars.get(e);
          }
          getDefaults() {
            return this._theme.getDefaults();
          }
          themeMatch(e) {
            return this._theme.match(e);
          }
          grammarForScopeName(e, t, n, r, l) {
            if (!this._grammars.has(e)) {
              let s = this._rawGrammars.get(e);
              if (!s) {
                return null;
              }
              this._grammars.set(e, new eo(e, s, t, n, r, l, this, this._onigLib));
            }
            return this._grammars.get(e);
          }
        },
        ed = class {
          _options;
          _syncRegistry;
          _ensureGrammarCache;
          constructor(e) {
            ((this._options = e),
              (this._syncRegistry = new ep(h.createFromRawTheme(e.theme, e.colorMap), e.onigLib)),
              (this._ensureGrammarCache = new Map()));
          }
          dispose() {
            this._syncRegistry.dispose();
          }
          setTheme(e, t) {
            this._syncRegistry.setTheme(h.createFromRawTheme(e, t));
          }
          getColorMap() {
            return this._syncRegistry.getColorMap();
          }
          loadGrammarWithEmbeddedLanguages(e, t, n) {
            return this.loadGrammarWithConfiguration(e, t, { embeddedLanguages: n });
          }
          loadGrammarWithConfiguration(e, t, n) {
            return this._loadGrammar(
              e,
              t,
              n.embeddedLanguages,
              n.tokenTypes,
              new ec(n.balancedBracketSelectors || [], n.unbalancedBracketSelectors || []),
            );
          }
          loadGrammar(e) {
            return this._loadGrammar(e, 0, null, null, null);
          }
          _loadGrammar(e, t, n, r, l) {
            let s = new R(this._syncRegistry, e);
            for (; s.Q.length > 0; ) {
              (s.Q.map((e) => this._loadSingleGrammar(e.scopeName)), s.processQueue());
            }
            return this._grammarForScopeName(e, t, n, r, l);
          }
          _loadSingleGrammar(e) {
            this._ensureGrammarCache.has(e) ||
              (this._doLoadSingleGrammar(e), this._ensureGrammarCache.set(e, !0));
          }
          _doLoadSingleGrammar(e) {
            let t = this._options.loadGrammar(e);
            if (t) {
              let n =
                "function" == typeof this._options.getInjections
                  ? this._options.getInjections(e)
                  : void 0;
              this._syncRegistry.addGrammar(t, n);
            }
          }
          addGrammar(e, t = [], n = 0, r = null) {
            return (
              this._syncRegistry.addGrammar(e, t), this._grammarForScopeName(e.scopeName, n, r)
            );
          }
          _grammarForScopeName(e, t = 0, n = null, r = null, l = null) {
            return this._syncRegistry.grammarForScopeName(e, t, n, r, l);
          }
        },
        eg = eu.NULL;
    },
    54565: (e, t, n) => {
      n.d(t, { K: () => r });
      let r = [
        "AElig",
        "AMP",
        "Aacute",
        "Acirc",
        "Agrave",
        "Aring",
        "Atilde",
        "Auml",
        "COPY",
        "Ccedil",
        "ETH",
        "Eacute",
        "Ecirc",
        "Egrave",
        "Euml",
        "GT",
        "Iacute",
        "Icirc",
        "Igrave",
        "Iuml",
        "LT",
        "Ntilde",
        "Oacute",
        "Ocirc",
        "Ograve",
        "Oslash",
        "Otilde",
        "Ouml",
        "QUOT",
        "REG",
        "THORN",
        "Uacute",
        "Ucirc",
        "Ugrave",
        "Uuml",
        "Yacute",
        "aacute",
        "acirc",
        "acute",
        "aelig",
        "agrave",
        "amp",
        "aring",
        "atilde",
        "auml",
        "brvbar",
        "ccedil",
        "cedil",
        "cent",
        "copy",
        "curren",
        "deg",
        "divide",
        "eacute",
        "ecirc",
        "egrave",
        "eth",
        "euml",
        "frac12",
        "frac14",
        "frac34",
        "gt",
        "iacute",
        "icirc",
        "iexcl",
        "igrave",
        "iquest",
        "iuml",
        "laquo",
        "lt",
        "macr",
        "micro",
        "middot",
        "nbsp",
        "not",
        "ntilde",
        "oacute",
        "ocirc",
        "ograve",
        "ordf",
        "ordm",
        "oslash",
        "otilde",
        "ouml",
        "para",
        "plusmn",
        "pound",
        "quot",
        "raquo",
        "reg",
        "sect",
        "shy",
        "sup1",
        "sup2",
        "sup3",
        "szlig",
        "thorn",
        "times",
        "uacute",
        "ucirc",
        "ugrave",
        "uml",
        "uuml",
        "yacute",
        "yen",
        "yuml",
      ];
    },
    60184: (e, t, n) => {
      n.d(t, { D: () => r });
      function r(e, t) {
        let n = String(e);
        if ("string" != typeof t) {
          throw TypeError("Expected character");
        }
        let r = 0,
          l = n.indexOf(t);
        for (; -1 !== l; ) {
          (r++, (l = n.indexOf(t, l + t.length)));
        }
        return r;
      }
    },
    68541: (e, t, n) => {
      function r(e) {
        let t = String(e || "").trim();
        return t ? t.split(/[ \t\n\r\f]+/g) : [];
      }
      function l(e) {
        return e.join(" ").trim();
      }
      n.d(t, { A: () => l, q: () => r });
    },
    83398: (e, t, n) => {
      function r(e) {
        let t = [],
          n = String(e || ""),
          r = n.indexOf(","),
          l = 0,
          s = !1;
        for (; !s; ) {
          -1 === r && ((r = n.length), (s = !0));
          let e = n.slice(l, r).trim();
          ((e || !s) && t.push(e), (l = r + 1), (r = n.indexOf(",", l)));
        }
        return t;
      }
      function l(e, t) {
        let n = t || {};
        return ("" === e[e.length - 1] ? [...e, ""] : e)
          .join((n.padRight ? " " : "") + "," + (!1 === n.padLeft ? "" : " "))
          .trim();
      }
      n.d(t, { A: () => l, q: () => r });
    },
    86307: (e, t, n) => {
      n.d(t, { m: () => l });
      let r = /[ \t\n\f\r]/g;
      function l(e) {
        return "object" == typeof e ? "text" === e.type && s(e.value) : s(e);
      }
      function s(e) {
        return "" === e.replace(r, "");
      }
    },
    87747: (e, t, n) => {
      n.d(t, { H: () => r });
      class r extends Error {
        constructor(e) {
          (super(e), (this.name = "ShikiError"));
        }
      }
    },
    88030: (e, t, n) => {
      function r(e, t) {
        if (
          ((e = e.replace(
            t.subset
              ? (function (e) {
                  let t = [],
                    n = -1;
                  for (; ++n < e.length; ) {
                    t.push(e[n].replace(/[|\\{}()[\]^$+*?.]/g, "\\$&"));
                  }
                  return RegExp("(?:" + t.join("|") + ")", "g");
                })(t.subset)
              : /["&'<>`]/g,
            n,
          )),
          t.subset || t.escapeOnly)
        ) {
          return e;
        }
        return e
          .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function (e, n, r) {
            return t.format(
              (e.charCodeAt(0) - 55296) * 1024 + e.charCodeAt(1) - 56320 + 65536,
              r.charCodeAt(n + 2),
              t,
            );
          })
          .replace(/[\x01-\t\v\f\x0E-\x1F\x7F\x81\x8D\x8F\x90\x9D\xA0-\uFFFF]/g, n);
        function n(e, n, r) {
          return t.format(e.charCodeAt(0), r.charCodeAt(n + 1), t);
        }
      }
      n.d(t, { I: () => r });
    },
    90278: (e, t, n) => {
      let r;
      n.d(t, { l: () => u });
      var l = n(54565);
      let s = {
          nbsp: "\xa0",
          iexcl: "\xa1",
          cent: "\xa2",
          pound: "\xa3",
          curren: "\xa4",
          yen: "\xa5",
          brvbar: "\xa6",
          sect: "\xa7",
          uml: "\xa8",
          copy: "\xa9",
          ordf: "\xaa",
          laquo: "\xab",
          not: "\xac",
          shy: "\xad",
          reg: "\xae",
          macr: "\xaf",
          deg: "\xb0",
          plusmn: "\xb1",
          sup2: "\xb2",
          sup3: "\xb3",
          acute: "\xb4",
          micro: "\xb5",
          para: "\xb6",
          middot: "\xb7",
          cedil: "\xb8",
          sup1: "\xb9",
          ordm: "\xba",
          raquo: "\xbb",
          frac14: "\xbc",
          frac12: "\xbd",
          frac34: "\xbe",
          iquest: "\xbf",
          Agrave: "\xc0",
          Aacute: "\xc1",
          Acirc: "\xc2",
          Atilde: "\xc3",
          Auml: "\xc4",
          Aring: "\xc5",
          AElig: "\xc6",
          Ccedil: "\xc7",
          Egrave: "\xc8",
          Eacute: "\xc9",
          Ecirc: "\xca",
          Euml: "\xcb",
          Igrave: "\xcc",
          Iacute: "\xcd",
          Icirc: "\xce",
          Iuml: "\xcf",
          ETH: "\xd0",
          Ntilde: "\xd1",
          Ograve: "\xd2",
          Oacute: "\xd3",
          Ocirc: "\xd4",
          Otilde: "\xd5",
          Ouml: "\xd6",
          times: "\xd7",
          Oslash: "\xd8",
          Ugrave: "\xd9",
          Uacute: "\xda",
          Ucirc: "\xdb",
          Uuml: "\xdc",
          Yacute: "\xdd",
          THORN: "\xde",
          szlig: "\xdf",
          agrave: "\xe0",
          aacute: "\xe1",
          acirc: "\xe2",
          atilde: "\xe3",
          auml: "\xe4",
          aring: "\xe5",
          aelig: "\xe6",
          ccedil: "\xe7",
          egrave: "\xe8",
          eacute: "\xe9",
          ecirc: "\xea",
          euml: "\xeb",
          igrave: "\xec",
          iacute: "\xed",
          icirc: "\xee",
          iuml: "\xef",
          eth: "\xf0",
          ntilde: "\xf1",
          ograve: "\xf2",
          oacute: "\xf3",
          ocirc: "\xf4",
          otilde: "\xf5",
          ouml: "\xf6",
          divide: "\xf7",
          oslash: "\xf8",
          ugrave: "\xf9",
          uacute: "\xfa",
          ucirc: "\xfb",
          uuml: "\xfc",
          yacute: "\xfd",
          thorn: "\xfe",
          yuml: "\xff",
          fnof: "ƒ",
          Alpha: "Α",
          Beta: "Β",
          Gamma: "Γ",
          Delta: "Δ",
          Epsilon: "Ε",
          Zeta: "Ζ",
          Eta: "Η",
          Theta: "Θ",
          Iota: "Ι",
          Kappa: "Κ",
          Lambda: "Λ",
          Mu: "Μ",
          Nu: "Ν",
          Xi: "Ξ",
          Omicron: "Ο",
          Pi: "Π",
          Rho: "Ρ",
          Sigma: "Σ",
          Tau: "Τ",
          Upsilon: "Υ",
          Phi: "Φ",
          Chi: "Χ",
          Psi: "Ψ",
          Omega: "Ω",
          alpha: "α",
          beta: "β",
          gamma: "γ",
          delta: "δ",
          epsilon: "ε",
          zeta: "ζ",
          eta: "η",
          theta: "θ",
          iota: "ι",
          kappa: "κ",
          lambda: "λ",
          mu: "μ",
          nu: "ν",
          xi: "ξ",
          omicron: "ο",
          pi: "π",
          rho: "ρ",
          sigmaf: "ς",
          sigma: "σ",
          tau: "τ",
          upsilon: "υ",
          phi: "φ",
          chi: "χ",
          psi: "ψ",
          omega: "ω",
          thetasym: "ϑ",
          upsih: "ϒ",
          piv: "ϖ",
          bull: "•",
          hellip: "…",
          prime: "′",
          Prime: "″",
          oline: "‾",
          frasl: "⁄",
          weierp: "℘",
          image: "ℑ",
          real: "ℜ",
          trade: "™",
          alefsym: "ℵ",
          larr: "←",
          uarr: "↑",
          rarr: "→",
          darr: "↓",
          harr: "↔",
          crarr: "↵",
          lArr: "⇐",
          uArr: "⇑",
          rArr: "⇒",
          dArr: "⇓",
          hArr: "⇔",
          forall: "∀",
          part: "∂",
          exist: "∃",
          empty: "∅",
          nabla: "∇",
          isin: "∈",
          notin: "∉",
          ni: "∋",
          prod: "∏",
          sum: "∑",
          minus: "−",
          lowast: "∗",
          radic: "√",
          prop: "∝",
          infin: "∞",
          ang: "∠",
          and: "∧",
          or: "∨",
          cap: "∩",
          cup: "∪",
          int: "∫",
          there4: "∴",
          sim: "∼",
          cong: "≅",
          asymp: "≈",
          ne: "≠",
          equiv: "≡",
          le: "≤",
          ge: "≥",
          sub: "⊂",
          sup: "⊃",
          nsub: "⊄",
          sube: "⊆",
          supe: "⊇",
          oplus: "⊕",
          otimes: "⊗",
          perp: "⊥",
          sdot: "⋅",
          lceil: "⌈",
          rceil: "⌉",
          lfloor: "⌊",
          rfloor: "⌋",
          lang: "〈",
          rang: "〉",
          loz: "◊",
          spades: "♠",
          clubs: "♣",
          hearts: "♥",
          diams: "♦",
          quot: '"',
          amp: "&",
          lt: "<",
          gt: ">",
          OElig: "Œ",
          oelig: "œ",
          Scaron: "Š",
          scaron: "š",
          Yuml: "Ÿ",
          circ: "ˆ",
          tilde: "˜",
          ensp: " ",
          emsp: " ",
          thinsp: " ",
          zwnj: "‌",
          zwj: "‍",
          lrm: "‎",
          rlm: "‏",
          ndash: "–",
          mdash: "—",
          lsquo: "‘",
          rsquo: "’",
          sbquo: "‚",
          ldquo: "“",
          rdquo: "”",
          bdquo: "„",
          dagger: "†",
          Dagger: "‡",
          permil: "‰",
          lsaquo: "‹",
          rsaquo: "›",
          euro: "€",
        },
        o = new Set(["cent", "copy", "divide", "gt", "lt", "not", "para", "times"]),
        a = {}.hasOwnProperty,
        i = {};
      for (r in s) a.call(s, r) && (i[s[r]] = r);
      function u(e, t, n) {
        let r,
          s = (function (e, t, n) {
            let r = "&#x" + e.toString(16).toUpperCase();
            return n && t && !/[\dA-Fa-f]/.test(String.fromCharCode(t)) ? r : r + ";";
          })(e, t, n.omitOptionalSemicolons);
        if (
          ((n.useNamedReferences || n.useShortestReferences) &&
            (r = (function (e, t, n, r) {
              let s = String.fromCharCode(e);
              if (a.call(i, s)) {
                let e = i[s],
                  a = "&" + e;
                return n &&
                  l.K.includes(e) &&
                  !o.has(e) &&
                  (!r || (t && 61 !== t && /[^\da-z]/i.test(String.fromCharCode(t))))
                  ? a
                  : a + ";";
              }
              return "";
            })(e, t, n.omitOptionalSemicolons, n.attribute)),
          (n.useShortestReferences || !r) && n.useShortestReferences)
        ) {
          let r = (function (e, t, n) {
            let r = "&#" + String(e);
            return n && t && !/\d/.test(String.fromCharCode(t)) ? r : r + ";";
          })(e, t, n.omitOptionalSemicolons);
          r.length < s.length && (s = r);
        }
        return r && (!n.useShortestReferences || r.length < s.length) ? r : s;
      }
    },
    95248: (e, t, n) => {
      n.d(t, { V: () => eu });
      var r = {};
      (n.r(r),
        n.d(r, {
          boolean: () => c,
          booleanish: () => h,
          commaOrSpaceSeparated: () => f,
          commaSeparated: () => m,
          number: () => d,
          overloadedBoolean: () => p,
          spaceSeparated: () => g,
        }));
      var l = n(13980);
      class s {
        constructor(e, t, n) {
          ((this.normal = t), (this.property = e), n && (this.space = n));
        }
      }
      function o(e, t) {
        let n = {},
          r = {};
        for (let t of e) {
          (Object.assign(n, t.property), Object.assign(r, t.normal));
        }
        return new s(n, r, t);
      }
      function a(e) {
        return e.toLowerCase();
      }
      ((s.prototype.normal = {}), (s.prototype.property = {}), (s.prototype.space = void 0));
      class i {
        constructor(e, t) {
          ((this.attribute = t), (this.property = e));
        }
      }
      ((i.prototype.attribute = ""),
        (i.prototype.booleanish = !1),
        (i.prototype.boolean = !1),
        (i.prototype.commaOrSpaceSeparated = !1),
        (i.prototype.commaSeparated = !1),
        (i.prototype.defined = !1),
        (i.prototype.mustUseProperty = !1),
        (i.prototype.number = !1),
        (i.prototype.overloadedBoolean = !1),
        (i.prototype.property = ""),
        (i.prototype.spaceSeparated = !1),
        (i.prototype.space = void 0));
      let u = 0,
        c = _(),
        h = _(),
        p = _(),
        d = _(),
        g = _(),
        m = _(),
        f = _();
      function _() {
        return 2 ** ++u;
      }
      let y = Object.keys(r);
      class b extends i {
        constructor(e, t, n, l) {
          let s = -1;
          if (
            (super(e, t),
            (function (e, t, n) {
              n && (e[t] = n);
            })(this, "space", l),
            "number" == typeof n)
          ) {
            for (; ++s < y.length; ) {
              let e = y[s];
              !(function (e, t, n) {
                n && (e[t] = n);
              })(this, y[s], (n & r[e]) === r[e]);
            }
          }
        }
      }
      function C(e) {
        let t = {},
          n = {};
        for (let [r, l] of Object.entries(e.properties)) {
          let s = new b(r, e.transform(e.attributes || {}, r), l, e.space);
          (e.mustUseProperty && e.mustUseProperty.includes(r) && (s.mustUseProperty = !0),
            (t[r] = s),
            (n[a(r)] = r),
            (n[a(s.attribute)] = r));
        }
        return new s(t, n, e.space);
      }
      b.prototype.defined = !0;
      let S = C({
        properties: {
          ariaActiveDescendant: null,
          ariaAtomic: h,
          ariaAutoComplete: null,
          ariaBusy: h,
          ariaChecked: h,
          ariaColCount: d,
          ariaColIndex: d,
          ariaColSpan: d,
          ariaControls: g,
          ariaCurrent: null,
          ariaDescribedBy: g,
          ariaDetails: null,
          ariaDisabled: h,
          ariaDropEffect: g,
          ariaErrorMessage: null,
          ariaExpanded: h,
          ariaFlowTo: g,
          ariaGrabbed: h,
          ariaHasPopup: null,
          ariaHidden: h,
          ariaInvalid: null,
          ariaKeyShortcuts: null,
          ariaLabel: null,
          ariaLabelledBy: g,
          ariaLevel: d,
          ariaLive: null,
          ariaModal: h,
          ariaMultiLine: h,
          ariaMultiSelectable: h,
          ariaOrientation: null,
          ariaOwns: g,
          ariaPlaceholder: null,
          ariaPosInSet: d,
          ariaPressed: h,
          ariaReadOnly: h,
          ariaRelevant: null,
          ariaRequired: h,
          ariaRoleDescription: g,
          ariaRowCount: d,
          ariaRowIndex: d,
          ariaRowSpan: d,
          ariaSelected: h,
          ariaSetSize: d,
          ariaSort: null,
          ariaValueMax: d,
          ariaValueMin: d,
          ariaValueNow: d,
          ariaValueText: null,
          role: null,
        },
        transform: (e, t) => ("role" === t ? t : "aria-" + t.slice(4).toLowerCase()),
      });
      function k(e, t) {
        return t in e ? e[t] : t;
      }
      function v(e, t) {
        return k(e, t.toLowerCase());
      }
      let w = C({
          attributes: {
            acceptcharset: "accept-charset",
            classname: "class",
            htmlfor: "for",
            httpequiv: "http-equiv",
          },
          mustUseProperty: ["checked", "multiple", "muted", "selected"],
          properties: {
            abbr: null,
            accept: m,
            acceptCharset: g,
            accessKey: g,
            action: null,
            allow: null,
            allowFullScreen: c,
            allowPaymentRequest: c,
            allowUserMedia: c,
            alt: null,
            as: null,
            async: c,
            autoCapitalize: null,
            autoComplete: g,
            autoFocus: c,
            autoPlay: c,
            blocking: g,
            capture: null,
            charSet: null,
            checked: c,
            cite: null,
            className: g,
            cols: d,
            colSpan: null,
            content: null,
            contentEditable: h,
            controls: c,
            controlsList: g,
            coords: d | m,
            crossOrigin: null,
            data: null,
            dateTime: null,
            decoding: null,
            default: c,
            defer: c,
            dir: null,
            dirName: null,
            disabled: c,
            download: p,
            draggable: h,
            encType: null,
            enterKeyHint: null,
            fetchPriority: null,
            form: null,
            formAction: null,
            formEncType: null,
            formMethod: null,
            formNoValidate: c,
            formTarget: null,
            headers: g,
            height: d,
            hidden: p,
            high: d,
            href: null,
            hrefLang: null,
            htmlFor: g,
            httpEquiv: g,
            id: null,
            imageSizes: null,
            imageSrcSet: null,
            inert: c,
            inputMode: null,
            integrity: null,
            is: null,
            isMap: c,
            itemId: null,
            itemProp: g,
            itemRef: g,
            itemScope: c,
            itemType: g,
            kind: null,
            label: null,
            lang: null,
            language: null,
            list: null,
            loading: null,
            loop: c,
            low: d,
            manifest: null,
            max: null,
            maxLength: d,
            media: null,
            method: null,
            min: null,
            minLength: d,
            multiple: c,
            muted: c,
            name: null,
            nonce: null,
            noModule: c,
            noValidate: c,
            onAbort: null,
            onAfterPrint: null,
            onAuxClick: null,
            onBeforeMatch: null,
            onBeforePrint: null,
            onBeforeToggle: null,
            onBeforeUnload: null,
            onBlur: null,
            onCancel: null,
            onCanPlay: null,
            onCanPlayThrough: null,
            onChange: null,
            onClick: null,
            onClose: null,
            onContextLost: null,
            onContextMenu: null,
            onContextRestored: null,
            onCopy: null,
            onCueChange: null,
            onCut: null,
            onDblClick: null,
            onDrag: null,
            onDragEnd: null,
            onDragEnter: null,
            onDragExit: null,
            onDragLeave: null,
            onDragOver: null,
            onDragStart: null,
            onDrop: null,
            onDurationChange: null,
            onEmptied: null,
            onEnded: null,
            onError: null,
            onFocus: null,
            onFormData: null,
            onHashChange: null,
            onInput: null,
            onInvalid: null,
            onKeyDown: null,
            onKeyPress: null,
            onKeyUp: null,
            onLanguageChange: null,
            onLoad: null,
            onLoadedData: null,
            onLoadedMetadata: null,
            onLoadEnd: null,
            onLoadStart: null,
            onMessage: null,
            onMessageError: null,
            onMouseDown: null,
            onMouseEnter: null,
            onMouseLeave: null,
            onMouseMove: null,
            onMouseOut: null,
            onMouseOver: null,
            onMouseUp: null,
            onOffline: null,
            onOnline: null,
            onPageHide: null,
            onPageShow: null,
            onPaste: null,
            onPause: null,
            onPlay: null,
            onPlaying: null,
            onPopState: null,
            onProgress: null,
            onRateChange: null,
            onRejectionHandled: null,
            onReset: null,
            onResize: null,
            onScroll: null,
            onScrollEnd: null,
            onSecurityPolicyViolation: null,
            onSeeked: null,
            onSeeking: null,
            onSelect: null,
            onSlotChange: null,
            onStalled: null,
            onStorage: null,
            onSubmit: null,
            onSuspend: null,
            onTimeUpdate: null,
            onToggle: null,
            onUnhandledRejection: null,
            onUnload: null,
            onVolumeChange: null,
            onWaiting: null,
            onWheel: null,
            open: c,
            optimum: d,
            pattern: null,
            ping: g,
            placeholder: null,
            playsInline: c,
            popover: null,
            popoverTarget: null,
            popoverTargetAction: null,
            poster: null,
            preload: null,
            readOnly: c,
            referrerPolicy: null,
            rel: g,
            required: c,
            reversed: c,
            rows: d,
            rowSpan: d,
            sandbox: g,
            scope: null,
            scoped: c,
            seamless: c,
            selected: c,
            shadowRootClonable: c,
            shadowRootDelegatesFocus: c,
            shadowRootMode: null,
            shape: null,
            size: d,
            sizes: null,
            slot: null,
            span: d,
            spellCheck: h,
            src: null,
            srcDoc: null,
            srcLang: null,
            srcSet: null,
            start: d,
            step: null,
            style: null,
            tabIndex: d,
            target: null,
            title: null,
            translate: null,
            type: null,
            typeMustMatch: c,
            useMap: null,
            value: h,
            width: d,
            wrap: null,
            writingSuggestions: null,
            align: null,
            aLink: null,
            archive: g,
            axis: null,
            background: null,
            bgColor: null,
            border: d,
            borderColor: null,
            bottomMargin: d,
            cellPadding: null,
            cellSpacing: null,
            char: null,
            charOff: null,
            classId: null,
            clear: null,
            code: null,
            codeBase: null,
            codeType: null,
            color: null,
            compact: c,
            declare: c,
            event: null,
            face: null,
            frame: null,
            frameBorder: null,
            hSpace: d,
            leftMargin: d,
            link: null,
            longDesc: null,
            lowSrc: null,
            marginHeight: d,
            marginWidth: d,
            noResize: c,
            noHref: c,
            noShade: c,
            noWrap: c,
            object: null,
            profile: null,
            prompt: null,
            rev: null,
            rightMargin: d,
            rules: null,
            scheme: null,
            scrolling: h,
            standby: null,
            summary: null,
            text: null,
            topMargin: d,
            valueType: null,
            version: null,
            vAlign: null,
            vLink: null,
            vSpace: d,
            allowTransparency: null,
            autoCorrect: null,
            autoSave: null,
            disablePictureInPicture: c,
            disableRemotePlayback: c,
            prefix: null,
            property: null,
            results: d,
            security: null,
            unselectable: null,
          },
          space: "html",
          transform: v,
        }),
        A = C({
          attributes: {
            accentHeight: "accent-height",
            alignmentBaseline: "alignment-baseline",
            arabicForm: "arabic-form",
            baselineShift: "baseline-shift",
            capHeight: "cap-height",
            className: "class",
            clipPath: "clip-path",
            clipRule: "clip-rule",
            colorInterpolation: "color-interpolation",
            colorInterpolationFilters: "color-interpolation-filters",
            colorProfile: "color-profile",
            colorRendering: "color-rendering",
            crossOrigin: "crossorigin",
            dataType: "datatype",
            dominantBaseline: "dominant-baseline",
            enableBackground: "enable-background",
            fillOpacity: "fill-opacity",
            fillRule: "fill-rule",
            floodColor: "flood-color",
            floodOpacity: "flood-opacity",
            fontFamily: "font-family",
            fontSize: "font-size",
            fontSizeAdjust: "font-size-adjust",
            fontStretch: "font-stretch",
            fontStyle: "font-style",
            fontVariant: "font-variant",
            fontWeight: "font-weight",
            glyphName: "glyph-name",
            glyphOrientationHorizontal: "glyph-orientation-horizontal",
            glyphOrientationVertical: "glyph-orientation-vertical",
            hrefLang: "hreflang",
            horizAdvX: "horiz-adv-x",
            horizOriginX: "horiz-origin-x",
            horizOriginY: "horiz-origin-y",
            imageRendering: "image-rendering",
            letterSpacing: "letter-spacing",
            lightingColor: "lighting-color",
            markerEnd: "marker-end",
            markerMid: "marker-mid",
            markerStart: "marker-start",
            navDown: "nav-down",
            navDownLeft: "nav-down-left",
            navDownRight: "nav-down-right",
            navLeft: "nav-left",
            navNext: "nav-next",
            navPrev: "nav-prev",
            navRight: "nav-right",
            navUp: "nav-up",
            navUpLeft: "nav-up-left",
            navUpRight: "nav-up-right",
            onAbort: "onabort",
            onActivate: "onactivate",
            onAfterPrint: "onafterprint",
            onBeforePrint: "onbeforeprint",
            onBegin: "onbegin",
            onCancel: "oncancel",
            onCanPlay: "oncanplay",
            onCanPlayThrough: "oncanplaythrough",
            onChange: "onchange",
            onClick: "onclick",
            onClose: "onclose",
            onCopy: "oncopy",
            onCueChange: "oncuechange",
            onCut: "oncut",
            onDblClick: "ondblclick",
            onDrag: "ondrag",
            onDragEnd: "ondragend",
            onDragEnter: "ondragenter",
            onDragExit: "ondragexit",
            onDragLeave: "ondragleave",
            onDragOver: "ondragover",
            onDragStart: "ondragstart",
            onDrop: "ondrop",
            onDurationChange: "ondurationchange",
            onEmptied: "onemptied",
            onEnd: "onend",
            onEnded: "onended",
            onError: "onerror",
            onFocus: "onfocus",
            onFocusIn: "onfocusin",
            onFocusOut: "onfocusout",
            onHashChange: "onhashchange",
            onInput: "oninput",
            onInvalid: "oninvalid",
            onKeyDown: "onkeydown",
            onKeyPress: "onkeypress",
            onKeyUp: "onkeyup",
            onLoad: "onload",
            onLoadedData: "onloadeddata",
            onLoadedMetadata: "onloadedmetadata",
            onLoadStart: "onloadstart",
            onMessage: "onmessage",
            onMouseDown: "onmousedown",
            onMouseEnter: "onmouseenter",
            onMouseLeave: "onmouseleave",
            onMouseMove: "onmousemove",
            onMouseOut: "onmouseout",
            onMouseOver: "onmouseover",
            onMouseUp: "onmouseup",
            onMouseWheel: "onmousewheel",
            onOffline: "onoffline",
            onOnline: "ononline",
            onPageHide: "onpagehide",
            onPageShow: "onpageshow",
            onPaste: "onpaste",
            onPause: "onpause",
            onPlay: "onplay",
            onPlaying: "onplaying",
            onPopState: "onpopstate",
            onProgress: "onprogress",
            onRateChange: "onratechange",
            onRepeat: "onrepeat",
            onReset: "onreset",
            onResize: "onresize",
            onScroll: "onscroll",
            onSeeked: "onseeked",
            onSeeking: "onseeking",
            onSelect: "onselect",
            onShow: "onshow",
            onStalled: "onstalled",
            onStorage: "onstorage",
            onSubmit: "onsubmit",
            onSuspend: "onsuspend",
            onTimeUpdate: "ontimeupdate",
            onToggle: "ontoggle",
            onUnload: "onunload",
            onVolumeChange: "onvolumechange",
            onWaiting: "onwaiting",
            onZoom: "onzoom",
            overlinePosition: "overline-position",
            overlineThickness: "overline-thickness",
            paintOrder: "paint-order",
            panose1: "panose-1",
            pointerEvents: "pointer-events",
            referrerPolicy: "referrerpolicy",
            renderingIntent: "rendering-intent",
            shapeRendering: "shape-rendering",
            stopColor: "stop-color",
            stopOpacity: "stop-opacity",
            strikethroughPosition: "strikethrough-position",
            strikethroughThickness: "strikethrough-thickness",
            strokeDashArray: "stroke-dasharray",
            strokeDashOffset: "stroke-dashoffset",
            strokeLineCap: "stroke-linecap",
            strokeLineJoin: "stroke-linejoin",
            strokeMiterLimit: "stroke-miterlimit",
            strokeOpacity: "stroke-opacity",
            strokeWidth: "stroke-width",
            tabIndex: "tabindex",
            textAnchor: "text-anchor",
            textDecoration: "text-decoration",
            textRendering: "text-rendering",
            transformOrigin: "transform-origin",
            typeOf: "typeof",
            underlinePosition: "underline-position",
            underlineThickness: "underline-thickness",
            unicodeBidi: "unicode-bidi",
            unicodeRange: "unicode-range",
            unitsPerEm: "units-per-em",
            vAlphabetic: "v-alphabetic",
            vHanging: "v-hanging",
            vIdeographic: "v-ideographic",
            vMathematical: "v-mathematical",
            vectorEffect: "vector-effect",
            vertAdvY: "vert-adv-y",
            vertOriginX: "vert-origin-x",
            vertOriginY: "vert-origin-y",
            wordSpacing: "word-spacing",
            writingMode: "writing-mode",
            xHeight: "x-height",
            playbackOrder: "playbackorder",
            timelineBegin: "timelinebegin",
          },
          properties: {
            about: f,
            accentHeight: d,
            accumulate: null,
            additive: null,
            alignmentBaseline: null,
            alphabetic: d,
            amplitude: d,
            arabicForm: null,
            ascent: d,
            attributeName: null,
            attributeType: null,
            azimuth: d,
            bandwidth: null,
            baselineShift: null,
            baseFrequency: null,
            baseProfile: null,
            bbox: null,
            begin: null,
            bias: d,
            by: null,
            calcMode: null,
            capHeight: d,
            className: g,
            clip: null,
            clipPath: null,
            clipPathUnits: null,
            clipRule: null,
            color: null,
            colorInterpolation: null,
            colorInterpolationFilters: null,
            colorProfile: null,
            colorRendering: null,
            content: null,
            contentScriptType: null,
            contentStyleType: null,
            crossOrigin: null,
            cursor: null,
            cx: null,
            cy: null,
            d: null,
            dataType: null,
            defaultAction: null,
            descent: d,
            diffuseConstant: d,
            direction: null,
            display: null,
            dur: null,
            divisor: d,
            dominantBaseline: null,
            download: c,
            dx: null,
            dy: null,
            edgeMode: null,
            editable: null,
            elevation: d,
            enableBackground: null,
            end: null,
            event: null,
            exponent: d,
            externalResourcesRequired: null,
            fill: null,
            fillOpacity: d,
            fillRule: null,
            filter: null,
            filterRes: null,
            filterUnits: null,
            floodColor: null,
            floodOpacity: null,
            focusable: null,
            focusHighlight: null,
            fontFamily: null,
            fontSize: null,
            fontSizeAdjust: null,
            fontStretch: null,
            fontStyle: null,
            fontVariant: null,
            fontWeight: null,
            format: null,
            fr: null,
            from: null,
            fx: null,
            fy: null,
            g1: m,
            g2: m,
            glyphName: m,
            glyphOrientationHorizontal: null,
            glyphOrientationVertical: null,
            glyphRef: null,
            gradientTransform: null,
            gradientUnits: null,
            handler: null,
            hanging: d,
            hatchContentUnits: null,
            hatchUnits: null,
            height: null,
            href: null,
            hrefLang: null,
            horizAdvX: d,
            horizOriginX: d,
            horizOriginY: d,
            id: null,
            ideographic: d,
            imageRendering: null,
            initialVisibility: null,
            in: null,
            in2: null,
            intercept: d,
            k: d,
            k1: d,
            k2: d,
            k3: d,
            k4: d,
            kernelMatrix: f,
            kernelUnitLength: null,
            keyPoints: null,
            keySplines: null,
            keyTimes: null,
            kerning: null,
            lang: null,
            lengthAdjust: null,
            letterSpacing: null,
            lightingColor: null,
            limitingConeAngle: d,
            local: null,
            markerEnd: null,
            markerMid: null,
            markerStart: null,
            markerHeight: null,
            markerUnits: null,
            markerWidth: null,
            mask: null,
            maskContentUnits: null,
            maskUnits: null,
            mathematical: null,
            max: null,
            media: null,
            mediaCharacterEncoding: null,
            mediaContentEncodings: null,
            mediaSize: d,
            mediaTime: null,
            method: null,
            min: null,
            mode: null,
            name: null,
            navDown: null,
            navDownLeft: null,
            navDownRight: null,
            navLeft: null,
            navNext: null,
            navPrev: null,
            navRight: null,
            navUp: null,
            navUpLeft: null,
            navUpRight: null,
            numOctaves: null,
            observer: null,
            offset: null,
            onAbort: null,
            onActivate: null,
            onAfterPrint: null,
            onBeforePrint: null,
            onBegin: null,
            onCancel: null,
            onCanPlay: null,
            onCanPlayThrough: null,
            onChange: null,
            onClick: null,
            onClose: null,
            onCopy: null,
            onCueChange: null,
            onCut: null,
            onDblClick: null,
            onDrag: null,
            onDragEnd: null,
            onDragEnter: null,
            onDragExit: null,
            onDragLeave: null,
            onDragOver: null,
            onDragStart: null,
            onDrop: null,
            onDurationChange: null,
            onEmptied: null,
            onEnd: null,
            onEnded: null,
            onError: null,
            onFocus: null,
            onFocusIn: null,
            onFocusOut: null,
            onHashChange: null,
            onInput: null,
            onInvalid: null,
            onKeyDown: null,
            onKeyPress: null,
            onKeyUp: null,
            onLoad: null,
            onLoadedData: null,
            onLoadedMetadata: null,
            onLoadStart: null,
            onMessage: null,
            onMouseDown: null,
            onMouseEnter: null,
            onMouseLeave: null,
            onMouseMove: null,
            onMouseOut: null,
            onMouseOver: null,
            onMouseUp: null,
            onMouseWheel: null,
            onOffline: null,
            onOnline: null,
            onPageHide: null,
            onPageShow: null,
            onPaste: null,
            onPause: null,
            onPlay: null,
            onPlaying: null,
            onPopState: null,
            onProgress: null,
            onRateChange: null,
            onRepeat: null,
            onReset: null,
            onResize: null,
            onScroll: null,
            onSeeked: null,
            onSeeking: null,
            onSelect: null,
            onShow: null,
            onStalled: null,
            onStorage: null,
            onSubmit: null,
            onSuspend: null,
            onTimeUpdate: null,
            onToggle: null,
            onUnload: null,
            onVolumeChange: null,
            onWaiting: null,
            onZoom: null,
            opacity: null,
            operator: null,
            order: null,
            orient: null,
            orientation: null,
            origin: null,
            overflow: null,
            overlay: null,
            overlinePosition: d,
            overlineThickness: d,
            paintOrder: null,
            panose1: null,
            path: null,
            pathLength: d,
            patternContentUnits: null,
            patternTransform: null,
            patternUnits: null,
            phase: null,
            ping: g,
            pitch: null,
            playbackOrder: null,
            pointerEvents: null,
            points: null,
            pointsAtX: d,
            pointsAtY: d,
            pointsAtZ: d,
            preserveAlpha: null,
            preserveAspectRatio: null,
            primitiveUnits: null,
            propagate: null,
            property: f,
            r: null,
            radius: null,
            referrerPolicy: null,
            refX: null,
            refY: null,
            rel: f,
            rev: f,
            renderingIntent: null,
            repeatCount: null,
            repeatDur: null,
            requiredExtensions: f,
            requiredFeatures: f,
            requiredFonts: f,
            requiredFormats: f,
            resource: null,
            restart: null,
            result: null,
            rotate: null,
            rx: null,
            ry: null,
            scale: null,
            seed: null,
            shapeRendering: null,
            side: null,
            slope: null,
            snapshotTime: null,
            specularConstant: d,
            specularExponent: d,
            spreadMethod: null,
            spacing: null,
            startOffset: null,
            stdDeviation: null,
            stemh: null,
            stemv: null,
            stitchTiles: null,
            stopColor: null,
            stopOpacity: null,
            strikethroughPosition: d,
            strikethroughThickness: d,
            string: null,
            stroke: null,
            strokeDashArray: f,
            strokeDashOffset: null,
            strokeLineCap: null,
            strokeLineJoin: null,
            strokeMiterLimit: d,
            strokeOpacity: d,
            strokeWidth: null,
            style: null,
            surfaceScale: d,
            syncBehavior: null,
            syncBehaviorDefault: null,
            syncMaster: null,
            syncTolerance: null,
            syncToleranceDefault: null,
            systemLanguage: f,
            tabIndex: d,
            tableValues: null,
            target: null,
            targetX: d,
            targetY: d,
            textAnchor: null,
            textDecoration: null,
            textRendering: null,
            textLength: null,
            timelineBegin: null,
            title: null,
            transformBehavior: null,
            type: null,
            typeOf: f,
            to: null,
            transform: null,
            transformOrigin: null,
            u1: null,
            u2: null,
            underlinePosition: d,
            underlineThickness: d,
            unicode: null,
            unicodeBidi: null,
            unicodeRange: null,
            unitsPerEm: d,
            values: null,
            vAlphabetic: d,
            vMathematical: d,
            vectorEffect: null,
            vHanging: d,
            vIdeographic: d,
            version: null,
            vertAdvY: d,
            vertOriginX: d,
            vertOriginY: d,
            viewBox: null,
            viewTarget: null,
            visibility: null,
            width: null,
            widths: null,
            wordSpacing: null,
            writingMode: null,
            x: null,
            x1: null,
            x2: null,
            xChannelSelector: null,
            xHeight: d,
            y: null,
            y1: null,
            y2: null,
            yChannelSelector: null,
            z: null,
            zoomAndPan: null,
          },
          space: "svg",
          transform: k,
        }),
        P = C({
          properties: {
            xLinkActuate: null,
            xLinkArcRole: null,
            xLinkHref: null,
            xLinkRole: null,
            xLinkShow: null,
            xLinkTitle: null,
            xLinkType: null,
          },
          space: "xlink",
          transform: (e, t) => "xlink:" + t.slice(5).toLowerCase(),
        }),
        N = C({
          attributes: { xmlnsxlink: "xmlns:xlink" },
          properties: { xmlnsXLink: null, xmlns: null },
          space: "xmlns",
          transform: v,
        }),
        R = C({
          properties: { xmlBase: null, xmlLang: null, xmlSpace: null },
          space: "xml",
          transform: (e, t) => "xml:" + t.slice(3).toLowerCase(),
        }),
        x = o([S, w, P, N, R], "html"),
        E = o([S, A, P, N, R], "svg");
      var I = n(8121),
        L = n(95947);
      let T = /^>|^->|<!--|-->|--!>|<!-$/g,
        O = [">"],
        M = ["<", ">"];
      var D = n(60184),
        G = n(83398);
      let B = /[A-Z]/g,
        F = /-[a-z]/g,
        U = /^data[-\w.:]+$/i;
      function j(e) {
        return "-" + e.toLowerCase();
      }
      function q(e) {
        return e.charAt(1).toUpperCase();
      }
      var z = n(68541),
        $ = n(86307);
      let W = V(1),
        H = V(-1),
        K = [];
      function V(e) {
        return function (t, n, r) {
          let l = t ? t.children : K,
            s = (n || 0) + e,
            o = l[s];
          if (!r) {
            for (; o && (0, $.m)(o); ) ((s += e), (o = l[s]));
          }
          return o;
        };
      }
      let Y = {}.hasOwnProperty;
      function X(e) {
        return function (t, n, r) {
          return Y.call(e, t.tagName) && e[t.tagName](t, n, r);
        };
      }
      let Q = X({
        body: function (e, t, n) {
          let r = W(n, t);
          return !r || "comment" !== r.type;
        },
        caption: Z,
        colgroup: Z,
        dd: function (e, t, n) {
          let r = W(n, t);
          return !r || ("element" === r.type && ("dt" === r.tagName || "dd" === r.tagName));
        },
        dt: function (e, t, n) {
          let r = W(n, t);
          return !!(r && "element" === r.type && ("dt" === r.tagName || "dd" === r.tagName));
        },
        head: Z,
        html: function (e, t, n) {
          let r = W(n, t);
          return !r || "comment" !== r.type;
        },
        li: function (e, t, n) {
          let r = W(n, t);
          return !r || ("element" === r.type && "li" === r.tagName);
        },
        optgroup: function (e, t, n) {
          let r = W(n, t);
          return !r || ("element" === r.type && "optgroup" === r.tagName);
        },
        option: function (e, t, n) {
          let r = W(n, t);
          return (
            !r || ("element" === r.type && ("option" === r.tagName || "optgroup" === r.tagName))
          );
        },
        p: function (e, t, n) {
          let r = W(n, t);
          return r
            ? "element" === r.type &&
                ("address" === r.tagName ||
                  "article" === r.tagName ||
                  "aside" === r.tagName ||
                  "blockquote" === r.tagName ||
                  "details" === r.tagName ||
                  "div" === r.tagName ||
                  "dl" === r.tagName ||
                  "fieldset" === r.tagName ||
                  "figcaption" === r.tagName ||
                  "figure" === r.tagName ||
                  "footer" === r.tagName ||
                  "form" === r.tagName ||
                  "h1" === r.tagName ||
                  "h2" === r.tagName ||
                  "h3" === r.tagName ||
                  "h4" === r.tagName ||
                  "h5" === r.tagName ||
                  "h6" === r.tagName ||
                  "header" === r.tagName ||
                  "hgroup" === r.tagName ||
                  "hr" === r.tagName ||
                  "main" === r.tagName ||
                  "menu" === r.tagName ||
                  "nav" === r.tagName ||
                  "ol" === r.tagName ||
                  "p" === r.tagName ||
                  "pre" === r.tagName ||
                  "section" === r.tagName ||
                  "table" === r.tagName ||
                  "ul" === r.tagName)
            : !n ||
                "element" !== n.type ||
                ("a" !== n.tagName &&
                  "audio" !== n.tagName &&
                  "del" !== n.tagName &&
                  "ins" !== n.tagName &&
                  "map" !== n.tagName &&
                  "noscript" !== n.tagName &&
                  "video" !== n.tagName);
        },
        rp: J,
        rt: J,
        tbody: function (e, t, n) {
          let r = W(n, t);
          return !r || ("element" === r.type && ("tbody" === r.tagName || "tfoot" === r.tagName));
        },
        td: ee,
        tfoot: function (e, t, n) {
          return !W(n, t);
        },
        th: ee,
        thead: function (e, t, n) {
          let r = W(n, t);
          return !!(r && "element" === r.type && ("tbody" === r.tagName || "tfoot" === r.tagName));
        },
        tr: function (e, t, n) {
          let r = W(n, t);
          return !r || ("element" === r.type && "tr" === r.tagName);
        },
      });
      function Z(e, t, n) {
        let r = W(n, t, !0);
        return !r || ("comment" !== r.type && !("text" === r.type && (0, $.m)(r.value.charAt(0))));
      }
      function J(e, t, n) {
        let r = W(n, t);
        return !r || ("element" === r.type && ("rp" === r.tagName || "rt" === r.tagName));
      }
      function ee(e, t, n) {
        let r = W(n, t);
        return !r || ("element" === r.type && ("td" === r.tagName || "th" === r.tagName));
      }
      let et = X({
          body: function (e) {
            let t = W(e, -1, !0);
            return (
              !t ||
              ("comment" !== t.type &&
                !("text" === t.type && (0, $.m)(t.value.charAt(0))) &&
                ("element" !== t.type ||
                  ("meta" !== t.tagName &&
                    "link" !== t.tagName &&
                    "script" !== t.tagName &&
                    "style" !== t.tagName &&
                    "template" !== t.tagName)))
            );
          },
          colgroup: function (e, t, n) {
            let r = H(n, t),
              l = W(e, -1, !0);
            return (
              !(
                n &&
                r &&
                "element" === r.type &&
                "colgroup" === r.tagName &&
                Q(r, n.children.indexOf(r), n)
              ) && !!(l && "element" === l.type && "col" === l.tagName)
            );
          },
          head: function (e) {
            let t = new Set();
            for (let n of e.children) {
              if ("element" === n.type && ("base" === n.tagName || "title" === n.tagName)) {
                if (t.has(n.tagName)) return !1;
                t.add(n.tagName);
              }
            }
            let n = e.children[0];
            return !n || "element" === n.type;
          },
          html: function (e) {
            let t = W(e, -1);
            return !t || "comment" !== t.type;
          },
          tbody: function (e, t, n) {
            let r = H(n, t),
              l = W(e, -1);
            return (
              !(
                n &&
                r &&
                "element" === r.type &&
                ("thead" === r.tagName || "tbody" === r.tagName) &&
                Q(r, n.children.indexOf(r), n)
              ) && !!(l && "element" === l.type && "tr" === l.tagName)
            );
          },
        }),
        en = {
          name: [
            ["	\n\f\r &/=>".split(""), "	\n\f\r \"&'/=>`".split("")],
            ["\0	\n\f\r \"&'/<=>".split(""), "\0	\n\f\r \"&'/<=>`".split("")],
          ],
          unquoted: [
            ["	\n\f\r &>".split(""), "\0	\n\f\r \"&'<=>`".split("")],
            ["\0	\n\f\r \"&'<=>`".split(""), "\0	\n\f\r \"&'<=>`".split("")],
          ],
          single: [
            ["&'".split(""), "\"&'`".split("")],
            ["\0&'".split(""), "\0\"&'`".split("")],
          ],
          double: [
            ['"&'.split(""), "\"&'`".split("")],
            ['\0"&'.split(""), "\0\"&'`".split("")],
          ],
        },
        er = ["<", "&"];
      function el(e, t, n, r) {
        return n && "element" === n.type && ("script" === n.tagName || "style" === n.tagName)
          ? e.value
          : (0, L.l)(e.value, Object.assign({}, r.settings.characterReferences, { subset: er }));
      }
      let es = (0, I.A)("type", {
          invalid: function (e) {
            throw Error("Expected node, not `" + e + "`");
          },
          unknown: function (e) {
            throw Error("Cannot compile unknown node `" + e.type + "`");
          },
          handlers: {
            comment: function (e, t, n, r) {
              return r.settings.bogusComments
                ? "<?" +
                    (0, L.l)(
                      e.value,
                      Object.assign({}, r.settings.characterReferences, { subset: O }),
                    ) +
                    ">"
                : "\x3c!--" +
                    e.value.replace(T, function (e) {
                      return (0, L.l)(
                        e,
                        Object.assign({}, r.settings.characterReferences, { subset: M }),
                      );
                    }) +
                    "--\x3e";
            },
            doctype: function (e, t, n, r) {
              return (
                "<!" +
                (r.settings.upperDoctype ? "DOCTYPE" : "doctype") +
                (r.settings.tightDoctype ? "" : " ") +
                "html>"
              );
            },
            element: function (e, t, n, r) {
              let l,
                s = r.schema,
                o = "svg" !== s.space && r.settings.omitOptionalTags,
                u =
                  "svg" === s.space
                    ? r.settings.closeEmptyElements
                    : r.settings.voids.includes(e.tagName.toLowerCase()),
                c = [];
              "html" === s.space && "svg" === e.tagName && (r.schema = E);
              let h = (function (e, t) {
                  let n,
                    r = [],
                    l = -1;
                  if (t) {
                    for (n in t) {
                      if (null !== t[n] && void 0 !== t[n]) {
                        let l = (function (e, t, n) {
                          let r,
                            l = (function (e, t) {
                              let n = a(t),
                                r = t,
                                l = i;
                              if (n in e.normal) return e.property[e.normal[n]];
                              if (n.length > 4 && "data" === n.slice(0, 4) && U.test(t)) {
                                if ("-" === t.charAt(4)) {
                                  let e = t.slice(5).replace(F, q);
                                  r = "data" + e.charAt(0).toUpperCase() + e.slice(1);
                                } else {
                                  let e = t.slice(4);
                                  if (!F.test(e)) {
                                    let n = e.replace(B, j);
                                    ("-" !== n.charAt(0) && (n = "-" + n), (t = "data" + n));
                                  }
                                }
                                l = b;
                              }
                              return new l(r, t);
                            })(e.schema, t),
                            s = e.settings.allowParseErrors && "html" === e.schema.space ? 0 : 1,
                            o = +!e.settings.allowDangerousCharacters,
                            u = e.quote;
                          if (
                            (l.overloadedBoolean && (n === l.attribute || "" === n)
                              ? (n = !0)
                              : (l.boolean || l.overloadedBoolean) &&
                                ("string" != typeof n || n === l.attribute || "" === n) &&
                                (n = !!n),
                            null == n || !1 === n || ("number" == typeof n && Number.isNaN(n)))
                          )
                            return "";
                          let c = (0, L.l)(
                            l.attribute,
                            Object.assign({}, e.settings.characterReferences, {
                              subset: en.name[s][o],
                            }),
                          );
                          return !0 === n ||
                            ((n = Array.isArray(n)
                              ? (l.commaSeparated ? G.A : z.A)(n, {
                                  padLeft: !e.settings.tightCommaSeparatedLists,
                                })
                              : String(n)),
                            e.settings.collapseEmptyAttributes && !n)
                            ? c
                            : (e.settings.preferUnquoted &&
                                (r = (0, L.l)(
                                  n,
                                  Object.assign({}, e.settings.characterReferences, {
                                    attribute: !0,
                                    subset: en.unquoted[s][o],
                                  }),
                                )),
                              r !== n &&
                                (e.settings.quoteSmart &&
                                  (0, D.D)(n, u) > (0, D.D)(n, e.alternative) &&
                                  (u = e.alternative),
                                (r =
                                  u +
                                  (0, L.l)(
                                    n,
                                    Object.assign({}, e.settings.characterReferences, {
                                      subset: ("'" === u ? en.single : en.double)[s][o],
                                      attribute: !0,
                                    }),
                                  ) +
                                  u)),
                              c + (r ? "=" + r : r));
                        })(e, n, t[n]);
                        l && r.push(l);
                      }
                    }
                  }
                  for (; ++l < r.length; ) {
                    let t = e.settings.tightAttributes ? r[l].charAt(r[l].length - 1) : void 0;
                    l !== r.length - 1 && '"' !== t && "'" !== t && (r[l] += " ");
                  }
                  return r.join("");
                })(r, e.properties),
                p = r.all("html" === s.space && "template" === e.tagName ? e.content : e);
              return (
                (r.schema = s),
                p && (u = !1),
                (!h && o && et(e, t, n)) ||
                  (c.push("<", e.tagName, h ? " " + h : ""),
                  u &&
                    ("svg" === s.space || r.settings.closeSelfClosing) &&
                    ((l = h.charAt(h.length - 1)),
                    (!r.settings.tightSelfClosing || "/" === l || (l && '"' !== l && "'" !== l)) &&
                      c.push(" "),
                    c.push("/")),
                  c.push(">")),
                c.push(p),
                u || (o && Q(e, t, n)) || c.push("</" + e.tagName + ">"),
                c.join("")
              );
            },
            raw: function (e, t, n, r) {
              return r.settings.allowDangerousHtml ? e.value : el(e, t, n, r);
            },
            root: function (e, t, n, r) {
              return r.all(e);
            },
            text: el,
          },
        }),
        eo = {},
        ea = {},
        ei = [];
      function eu(e, t) {
        let n = t || eo,
          r = n.quote || '"';
        if ('"' !== r && "'" !== r) {
          throw Error("Invalid quote `" + r + "`, expected `'` or `\"`");
        }
        return {
          one: ec,
          all: eh,
          settings: {
            omitOptionalTags: n.omitOptionalTags || !1,
            allowParseErrors: n.allowParseErrors || !1,
            allowDangerousCharacters: n.allowDangerousCharacters || !1,
            quoteSmart: n.quoteSmart || !1,
            preferUnquoted: n.preferUnquoted || !1,
            tightAttributes: n.tightAttributes || !1,
            upperDoctype: n.upperDoctype || !1,
            tightDoctype: n.tightDoctype || !1,
            bogusComments: n.bogusComments || !1,
            tightCommaSeparatedLists: n.tightCommaSeparatedLists || !1,
            tightSelfClosing: n.tightSelfClosing || !1,
            collapseEmptyAttributes: n.collapseEmptyAttributes || !1,
            allowDangerousHtml: n.allowDangerousHtml || !1,
            voids: n.voids || l.b,
            characterReferences: n.characterReferences || ea,
            closeSelfClosing: n.closeSelfClosing || !1,
            closeEmptyElements: n.closeEmptyElements || !1,
          },
          schema: "svg" === n.space ? E : x,
          quote: r,
          alternative: '"' === r ? "'" : '"',
        }.one(Array.isArray(e) ? { type: "root", children: e } : e, void 0, void 0);
      }
      function ec(e, t, n) {
        return es(e, t, n, this);
      }
      function eh(e) {
        let t = [],
          n = (e && e.children) || ei,
          r = -1;
        for (; ++r < n.length; ) {
          t[r] = this.one(n[r], r, e);
        }
        return t.join("");
      }
    },
  },
]);
