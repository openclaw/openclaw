(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [68789],
  {
    901: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t) => n(e, t, !0);
    },
    1050: (e, t, r) => {
      "use strict";
      var n = r(40459);
      Object.defineProperty(t, "__esModule", { value: !0 });
      let s = r(77249);
      class i extends s.Strategy {
        hostname;
        constructor() {
          (super("applicationHostname"),
            (this.hostname = (n.env.HOSTNAME || "undefined").toLowerCase()));
        }
        isEnabled(e) {
          return (
            !!e.hostNames &&
            e.hostNames
              .toLowerCase()
              .split(/\s*,\s*/)
              .includes(this.hostname)
          );
        }
      }
      t.default = i;
    },
    2319: (e, t, r) => {
      let n = r(49420),
        s = r(8916),
        { ANY: i } = s,
        o = r(4093),
        a = r(69412),
        l = r(45912),
        u = r(18103),
        c = r(53662),
        h = r(44107);
      e.exports = (e, t, r, d) => {
        let f, p, g, m, v;
        switch (((e = new n(e, d)), (t = new o(t, d)), r)) {
          case ">":
            ((f = l), (p = c), (g = u), (m = ">"), (v = ">="));
            break;
          case "<":
            ((f = u), (p = h), (g = l), (m = "<"), (v = "<="));
            break;
          default:
            throw TypeError('Must provide a hilo val of "<" or ">"');
        }
        if (a(e, t, d)) {
          return !1;
        }
        for (let r = 0; r < t.set.length; ++r) {
          let n = t.set[r],
            o = null,
            a = null;
          if (
            (n.forEach((e) => {
              (e.semver === i && (e = new s(">=0.0.0")),
                (o = o || e),
                (a = a || e),
                f(e.semver, o.semver, d) ? (o = e) : g(e.semver, a.semver, d) && (a = e));
            }),
            o.operator === m ||
              o.operator === v ||
              ((!a.operator || a.operator === m) && p(e, a.semver)) ||
              (a.operator === v && g(e, a.semver)))
          ) {
            return !1;
          }
        }
        return !0;
      };
    },
    3121: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.FlagProvider = void 0));
      let n = r(54568),
        s = r(24699),
        i = r(87323);
      t.FlagProvider = ({ children: e, ...t }) =>
        (0, n.jsx)(s.FlagProvider, {
          ...t,
          startClient: void 0 !== t.startClient ? t.startClient : "undefined" != typeof window,
          config: { ...(0, i.getDefaultClientConfig)(), ...t.config },
          children: e,
        });
    },
    4093: (e, t, r) => {
      let n = /\s+/g;
      class s {
        constructor(e, t) {
          if (((t = o(t)), e instanceof s)) {
            if (!!t.loose === e.loose && !!t.includePrerelease === e.includePrerelease) return e;
            else return new s(e.raw, t);
          }
          if (e instanceof a) {
            return ((this.raw = e.value), (this.set = [[e]]), (this.formatted = void 0), this);
          }
          if (
            ((this.options = t),
            (this.loose = !!t.loose),
            (this.includePrerelease = !!t.includePrerelease),
            (this.raw = e.trim().replace(n, " ")),
            (this.set = this.raw
              .split("||")
              .map((e) => this.parseRange(e.trim()))
              .filter((e) => e.length)),
            !this.set.length)
          ) {
            throw TypeError(`Invalid SemVer Range: ${this.raw}`);
          }
          if (this.set.length > 1) {
            let e = this.set[0];
            if (((this.set = this.set.filter((e) => !v(e[0]))), 0 === this.set.length)) {
              this.set = [e];
            } else if (this.set.length > 1) {
              for (let e of this.set) {
                if (1 === e.length && E(e[0])) {
                  this.set = [e];
                  break;
                }
              }
            }
          }
          this.formatted = void 0;
        }
        get range() {
          if (void 0 === this.formatted) {
            this.formatted = "";
            for (let e = 0; e < this.set.length; e++) {
              e > 0 && (this.formatted += "||");
              let t = this.set[e];
              for (let e = 0; e < t.length; e++) {
                (e > 0 && (this.formatted += " "), (this.formatted += t[e].toString().trim()));
              }
            }
          }
          return this.formatted;
        }
        format() {
          return this.range;
        }
        toString() {
          return this.range;
        }
        parseRange(e) {
          let t = ((this.options.includePrerelease && g) | (this.options.loose && m)) + ":" + e,
            r = i.get(t);
          if (r) {
            return r;
          }
          let n = this.options.loose,
            s = n ? c[h.HYPHENRANGELOOSE] : c[h.HYPHENRANGE];
          (l("hyphen replace", (e = e.replace(s, C(this.options.includePrerelease)))),
            l("comparator trim", (e = e.replace(c[h.COMPARATORTRIM], d))),
            l("tilde trim", (e = e.replace(c[h.TILDETRIM], f))),
            l("caret trim", (e = e.replace(c[h.CARETTRIM], p))));
          let o = e
            .split(" ")
            .map((e) => y(e, this.options))
            .join(" ")
            .split(/\s+/)
            .map((e) => x(e, this.options));
          (n &&
            (o = o.filter(
              (e) => (l("loose invalid filter", e, this.options), !!e.match(c[h.COMPARATORLOOSE])),
            )),
            l("range list", o));
          let u = new Map();
          for (let e of o.map((e) => new a(e, this.options))) {
            if (v(e)) {
              return [e];
            }
            u.set(e.value, e);
          }
          u.size > 1 && u.has("") && u.delete("");
          let E = [...u.values()];
          return (i.set(t, E), E);
        }
        intersects(e, t) {
          if (!(e instanceof s)) {
            throw TypeError("a Range is required");
          }
          return this.set.some(
            (r) =>
              b(r, t) &&
              e.set.some((e) => b(e, t) && r.every((r) => e.every((e) => r.intersects(e, t)))),
          );
        }
        test(e) {
          if (!e) {
            return !1;
          }
          if ("string" == typeof e) {
            try {
              e = new u(e, this.options);
            } catch (e) {
              return !1;
            }
          }
          for (let t = 0; t < this.set.length; t++) {
            if (L(this.set[t], e, this.options)) return !0;
          }
          return !1;
        }
      }
      e.exports = s;
      let i = new (r(35e3))(),
        o = r(33959),
        a = r(8916),
        l = r(66512),
        u = r(49420),
        {
          safeRe: c,
          t: h,
          comparatorTrimReplace: d,
          tildeTrimReplace: f,
          caretTrimReplace: p,
        } = r(93592),
        { FLAG_INCLUDE_PRERELEASE: g, FLAG_LOOSE: m } = r(82478),
        v = (e) => "<0.0.0-0" === e.value,
        E = (e) => "" === e.value,
        b = (e, t) => {
          let r = !0,
            n = e.slice(),
            s = n.pop();
          for (; r && n.length; ) {
            ((r = n.every((e) => s.intersects(e, t))), (s = n.pop()));
          }
          return r;
        },
        y = (e, t) => (
          l("comp", e, t),
          l("caret", (e = T(e, t))),
          l("tildes", (e = R(e, t))),
          l("xrange", (e = A(e, t))),
          l("stars", (e = O(e, t))),
          e
        ),
        I = (e) => !e || "x" === e.toLowerCase() || "*" === e,
        R = (e, t) =>
          e
            .trim()
            .split(/\s+/)
            .map((e) => S(e, t))
            .join(" "),
        S = (e, t) => {
          let r = t.loose ? c[h.TILDELOOSE] : c[h.TILDE];
          return e.replace(r, (t, r, n, s, i) => {
            let o;
            return (
              l("tilde", e, t, r, n, s, i),
              I(r)
                ? (o = "")
                : I(n)
                  ? (o = `>=${r}.0.0 <${+r + 1}.0.0-0`)
                  : I(s)
                    ? (o = `>=${r}.${n}.0 <${r}.${+n + 1}.0-0`)
                    : i
                      ? (l("replaceTilde pr", i), (o = `>=${r}.${n}.${s}-${i} <${r}.${+n + 1}.0-0`))
                      : (o = `>=${r}.${n}.${s} <${r}.${+n + 1}.0-0`),
              l("tilde return", o),
              o
            );
          });
        },
        T = (e, t) =>
          e
            .trim()
            .split(/\s+/)
            .map((e) => _(e, t))
            .join(" "),
        _ = (e, t) => {
          l("caret", e, t);
          let r = t.loose ? c[h.CARETLOOSE] : c[h.CARET],
            n = t.includePrerelease ? "-0" : "";
          return e.replace(r, (t, r, s, i, o) => {
            let a;
            return (
              l("caret", e, t, r, s, i, o),
              I(r)
                ? (a = "")
                : I(s)
                  ? (a = `>=${r}.0.0${n} <${+r + 1}.0.0-0`)
                  : I(i)
                    ? (a =
                        "0" === r
                          ? `>=${r}.${s}.0${n} <${r}.${+s + 1}.0-0`
                          : `>=${r}.${s}.0${n} <${+r + 1}.0.0-0`)
                    : o
                      ? (l("replaceCaret pr", o),
                        (a =
                          "0" === r
                            ? "0" === s
                              ? `>=${r}.${s}.${i}-${o} <${r}.${s}.${+i + 1}-0`
                              : `>=${r}.${s}.${i}-${o} <${r}.${+s + 1}.0-0`
                            : `>=${r}.${s}.${i}-${o} <${+r + 1}.0.0-0`))
                      : (l("no pr"),
                        (a =
                          "0" === r
                            ? "0" === s
                              ? `>=${r}.${s}.${i}${n} <${r}.${s}.${+i + 1}-0`
                              : `>=${r}.${s}.${i}${n} <${r}.${+s + 1}.0-0`
                            : `>=${r}.${s}.${i} <${+r + 1}.0.0-0`)),
              l("caret return", a),
              a
            );
          });
        },
        A = (e, t) => (
          l("replaceXRanges", e, t),
          e
            .split(/\s+/)
            .map((e) => N(e, t))
            .join(" ")
        ),
        N = (e, t) => {
          e = e.trim();
          let r = t.loose ? c[h.XRANGELOOSE] : c[h.XRANGE];
          return e.replace(r, (r, n, s, i, o, a) => {
            l("xRange", e, r, n, s, i, o, a);
            let u = I(s),
              c = u || I(i),
              h = c || I(o);
            return (
              "=" === n && h && (n = ""),
              (a = t.includePrerelease ? "-0" : ""),
              u
                ? (r = ">" === n || "<" === n ? "<0.0.0-0" : "*")
                : n && h
                  ? (c && (i = 0),
                    (o = 0),
                    ">" === n
                      ? ((n = ">="), c ? ((s = +s + 1), (i = 0)) : (i = +i + 1), (o = 0))
                      : "<=" === n && ((n = "<"), c ? (s = +s + 1) : (i = +i + 1)),
                    "<" === n && (a = "-0"),
                    (r = `${n + s}.${i}.${o}${a}`))
                  : c
                    ? (r = `>=${s}.0.0${a} <${+s + 1}.0.0-0`)
                    : h && (r = `>=${s}.${i}.0${a} <${s}.${+i + 1}.0-0`),
              l("xRange return", r),
              r
            );
          });
        },
        O = (e, t) => (l("replaceStars", e, t), e.trim().replace(c[h.STAR], "")),
        x = (e, t) => (
          l("replaceGTE0", e, t), e.trim().replace(c[t.includePrerelease ? h.GTE0PRE : h.GTE0], "")
        ),
        C = (e) => (t, r, n, s, i, o, a, l, u, c, h, d) => (
          (r = I(n)
            ? ""
            : I(s)
              ? `>=${n}.0.0${e ? "-0" : ""}`
              : I(i)
                ? `>=${n}.${s}.0${e ? "-0" : ""}`
                : o
                  ? `>=${r}`
                  : `>=${r}${e ? "-0" : ""}`),
          (l = I(u)
            ? ""
            : I(c)
              ? `<${+u + 1}.0.0-0`
              : I(h)
                ? `<${u}.${+c + 1}.0-0`
                : d
                  ? `<=${u}.${c}.${h}-${d}`
                  : e
                    ? `<${u}.${c}.${+h + 1}-0`
                    : `<=${l}`),
          `${r} ${l}`.trim()
        ),
        L = (e, t, r) => {
          for (let r = 0; r < e.length; r++) {
            if (!e[r].test(t)) return !1;
          }
          if (t.prerelease.length && !r.includePrerelease) {
            for (let r = 0; r < e.length; r++) {
              if ((l(e[r].semver), e[r].semver !== a.ANY && e[r].semver.prerelease.length > 0)) {
                let n = e[r].semver;
                if (n.major === t.major && n.minor === t.minor && n.patch === t.patch) return !0;
              }
            }
            return !1;
          }
          return !0;
        };
    },
    6994: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t, r) => new n(e, r).compare(new n(t, r));
    },
    8494: function (e, t, r) {
      "use strict";
      var n =
          (this && this.__createBinding) ||
          (Object.create
            ? function (e, t, r, n) {
                void 0 === n && (n = r);
                var s = Object.getOwnPropertyDescriptor(t, r);
                ((!s || ("get" in s ? !t.__esModule : s.writable || s.configurable)) &&
                  (s = {
                    enumerable: !0,
                    get: function () {
                      return t[r];
                    },
                  }),
                  Object.defineProperty(e, n, s));
              }
            : function (e, t, r, n) {
                (void 0 === n && (n = r), (e[n] = t[r]));
              }),
        s =
          (this && this.__exportStar) ||
          function (e, t) {
            for (var r in e) {
              "default" === r || Object.prototype.hasOwnProperty.call(t, r) || n(t, e, r);
            }
          };
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        s(r(45152), t),
        s(r(41576), t),
        s(r(87323), t),
        s(r(34438), t),
        s(r(63141), t),
        s(r(11087), t),
        s(r(53416), t),
        s(r(3121), t),
        s(r(41630), t));
    },
    8916: (e, t, r) => {
      let n = Symbol("SemVer ANY");
      class s {
        static get ANY() {
          return n;
        }
        constructor(e, t) {
          if (((t = i(t)), e instanceof s)) {
            if (!!t.loose === e.loose) return e;
            else e = e.value;
          }
          (u("comparator", (e = e.trim().split(/\s+/).join(" ")), t),
            (this.options = t),
            (this.loose = !!t.loose),
            this.parse(e),
            this.semver === n
              ? (this.value = "")
              : (this.value = this.operator + this.semver.version),
            u("comp", this));
        }
        parse(e) {
          let t = this.options.loose ? o[a.COMPARATORLOOSE] : o[a.COMPARATOR],
            r = e.match(t);
          if (!r) {
            throw TypeError(`Invalid comparator: ${e}`);
          }
          ((this.operator = void 0 !== r[1] ? r[1] : ""),
            "=" === this.operator && (this.operator = ""),
            r[2] ? (this.semver = new c(r[2], this.options.loose)) : (this.semver = n));
        }
        toString() {
          return this.value;
        }
        test(e) {
          if ((u("Comparator.test", e, this.options.loose), this.semver === n || e === n)) {
            return !0;
          }
          if ("string" == typeof e) {
            try {
              e = new c(e, this.options);
            } catch (e) {
              return !1;
            }
          }
          return l(e, this.operator, this.semver, this.options);
        }
        intersects(e, t) {
          if (!(e instanceof s)) {
            throw TypeError("a Comparator is required");
          }
          return "" === this.operator
            ? "" === this.value || new h(e.value, t).test(this.value)
            : "" === e.operator
              ? "" === e.value || new h(this.value, t).test(e.semver)
              : !(
                  ((t = i(t)).includePrerelease &&
                    ("<0.0.0-0" === this.value || "<0.0.0-0" === e.value)) ||
                  (!t.includePrerelease &&
                    (this.value.startsWith("<0.0.0") || e.value.startsWith("<0.0.0")))
                ) &&
                !!(
                  (this.operator.startsWith(">") && e.operator.startsWith(">")) ||
                  (this.operator.startsWith("<") && e.operator.startsWith("<")) ||
                  (this.semver.version === e.semver.version &&
                    this.operator.includes("=") &&
                    e.operator.includes("=")) ||
                  (l(this.semver, "<", e.semver, t) &&
                    this.operator.startsWith(">") &&
                    e.operator.startsWith("<")) ||
                  (l(this.semver, ">", e.semver, t) &&
                    this.operator.startsWith("<") &&
                    e.operator.startsWith(">"))
                );
        }
      }
      e.exports = s;
      let i = r(33959),
        { safeRe: o, t: a } = r(93592),
        l = r(38205),
        u = r(66512),
        c = r(49420),
        h = r(4093);
    },
    9151: (e) => {
      let t = /^[0-9]+$/,
        r = (e, r) => {
          let n = t.test(e),
            s = t.test(r);
          return (
            n && s && ((e *= 1), (r *= 1)),
            e === r ? 0 : n && !s ? -1 : s && !n ? 1 : e < r ? -1 : 1
          );
        };
      e.exports = { compareIdentifiers: r, rcompareIdentifiers: (e, t) => r(t, e) };
    },
    10663: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.getDefaultVariant = function () {
          return { name: "disabled", enabled: !1, feature_enabled: !1 };
        }),
        (t.selectVariantDefinition = l),
        (t.selectVariant = function (e, t) {
          let r = e.variants?.[0]?.stickiness ?? void 0;
          return l(e.name, r, e.variants || [], t);
        }));
      let s = r(52735),
        i = n(r(70250));
      function o() {
        return String(Math.round(1e5 * Math.random()));
      }
      let a = ["userId", "sessionId", "remoteAddress"];
      function l(e, t, r, n) {
        let l = r.reduce((e, t) => e + t.weight, 0);
        if (l <= 0) {
          return null;
        }
        let u = r
          .filter((e) => e.overrides)
          .find((e) =>
            e.overrides?.some((e) =>
              e.values.some((t) => t === (0, s.resolveContextValue)(n, e.contextName)),
            ),
          );
        if (u) {
          return u;
        }
        let c = (0, i.default)(
            (function (e, t = "default") {
              let r;
              if ("default" !== t) {
                let r = (0, s.resolveContextValue)(e, t);
                return r ? r.toString() : o();
              }
              return (
                a.some((t) => {
                  let n = e[t];
                  return "string" == typeof n && "" !== n && ((r = n), !0);
                }),
                r || o()
              );
            })(n, t),
            e,
            l,
            0x520af7d,
          ),
          h = 0;
        return (
          r.find((e) => {
            if (0 !== e.weight && !((h += e.weight) < c)) {
              return e;
            }
          }) || null
        );
      }
    },
    11004: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t) => new n(e, t).major;
    },
    11087: (e, t) => {
      "use strict";
      Object.defineProperty(t, "__esModule", { value: !0 });
    },
    11477: (e, t) => {
      "use strict";
      let r;
      var n = function (e, t) {
          return (n =
            Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array &&
              function (e, t) {
                e.__proto__ = t;
              }) ||
            function (e, t) {
              for (var r in t) {
                Object.prototype.hasOwnProperty.call(t, r) && (e[r] = t[r]);
              }
            })(e, t);
        },
        s = function () {
          return (s =
            Object.assign ||
            function (e) {
              for (var t, r = 1, n = arguments.length; r < n; r++) {
                for (var s in (t = arguments[r]))
                  Object.prototype.hasOwnProperty.call(t, s) && (e[s] = t[s]);
              }
              return e;
            }).apply(this, arguments);
        };
      function i(e, t, r, n) {
        return new (r || (r = Promise))(function (s, i) {
          function o(e) {
            try {
              l(n.next(e));
            } catch (e) {
              i(e);
            }
          }
          function a(e) {
            try {
              l(n.throw(e));
            } catch (e) {
              i(e);
            }
          }
          function l(e) {
            var t;
            e.done
              ? s(e.value)
              : ((t = e.value) instanceof r
                  ? t
                  : new r(function (e) {
                      e(t);
                    })
                ).then(o, a);
          }
          l((n = n.apply(e, t || [])).next());
        });
      }
      function o(e, t) {
        var r,
          n,
          s,
          i = {
            label: 0,
            sent: function () {
              if (1 & s[0]) {
                throw s[1];
              }
              return s[1];
            },
            trys: [],
            ops: [],
          },
          o = Object.create(("function" == typeof Iterator ? Iterator : Object).prototype);
        return (
          (o.next = a(0)),
          (o.throw = a(1)),
          (o.return = a(2)),
          "function" == typeof Symbol &&
            (o[Symbol.iterator] = function () {
              return this;
            }),
          o
        );
        function a(a) {
          return function (l) {
            var u = [a, l];
            if (r) {
              throw TypeError("Generator is already executing.");
            }
            for (; o && ((o = 0), u[0] && (i = 0)), i; ) {
              try {
                if (
                  ((r = 1),
                  n &&
                    (s =
                      2 & u[0]
                        ? n.return
                        : u[0]
                          ? n.throw || ((s = n.return) && s.call(n), 0)
                          : n.next) &&
                    !(s = s.call(n, u[1])).done)
                )
                  return s;
                switch (((n = 0), s && (u = [2 & u[0], s.value]), u[0])) {
                  case 0:
                  case 1:
                    s = u;
                    break;
                  case 4:
                    return (i.label++, { value: u[1], done: !1 });
                  case 5:
                    (i.label++, (n = u[1]), (u = [0]));
                    continue;
                  case 7:
                    ((u = i.ops.pop()), i.trys.pop());
                    continue;
                  default:
                    if (
                      !(s = (s = i.trys).length > 0 && s[s.length - 1]) &&
                      (6 === u[0] || 2 === u[0])
                    ) {
                      i = 0;
                      continue;
                    }
                    if (3 === u[0] && (!s || (u[1] > s[0] && u[1] < s[3]))) {
                      i.label = u[1];
                      break;
                    }
                    if (6 === u[0] && i.label < s[1]) {
                      ((i.label = s[1]), (s = u));
                      break;
                    }
                    if (s && i.label < s[2]) {
                      ((i.label = s[2]), i.ops.push(u));
                      break;
                    }
                    (s[2] && i.ops.pop(), i.trys.pop());
                    continue;
                }
                u = t.call(e, i);
              } catch (e) {
                ((u = [6, e]), (n = 0));
              } finally {
                r = s = 0;
              }
            }
            if (5 & u[0]) {
              throw u[1];
            }
            return { value: u[0] ? u[1] : void 0, done: !0 };
          };
        }
      }
      "function" == typeof SuppressedError && SuppressedError;
      var a = { exports: {} };
      function l() {}
      ((l.prototype = {
        on: function (e, t, r) {
          var n = this.e || (this.e = {});
          return ((n[e] || (n[e] = [])).push({ fn: t, ctx: r }), this);
        },
        once: function (e, t, r) {
          var n = this;
          function s() {
            (n.off(e, s), t.apply(r, arguments));
          }
          return ((s._ = t), this.on(e, s, r));
        },
        emit: function (e) {
          for (
            var t = [].slice.call(arguments, 1),
              r = ((this.e || (this.e = {}))[e] || []).slice(),
              n = 0,
              s = r.length;
            n < s;
            n++
          ) {
            r[n].fn.apply(r[n].ctx, t);
          }
          return this;
        },
        off: function (e, t) {
          var r = this.e || (this.e = {}),
            n = r[e],
            s = [];
          if (n && t) {
            for (var i = 0, o = n.length; i < o; i++)
              n[i].fn !== t && n[i].fn._ !== t && s.push(n[i]);
          }
          return (s.length ? (r[e] = s) : delete r[e], this);
        },
      }),
        (a.exports = l));
      var u = (a.exports.TinyEmitter = l),
        c = function (e) {
          return null != e[1];
        },
        h = function (e) {
          var t = e.properties,
            r = (function (e, t) {
              var r = {};
              for (var n in e) {
                Object.prototype.hasOwnProperty.call(e, n) && 0 > t.indexOf(n) && (r[n] = e[n]);
              }
              if (null != e && "function" == typeof Object.getOwnPropertySymbols) {
                var s = 0;
                for (n = Object.getOwnPropertySymbols(e); s < n.length; s++) {
                  0 > t.indexOf(n[s]) &&
                    Object.prototype.propertyIsEnumerable.call(e, n[s]) &&
                    (r[n[s]] = e[n[s]]);
                }
              }
              return r;
            })(e, ["properties"]),
            n = function (e) {
              return Object.entries(e).toSorted(function (e, t) {
                var r = e[0],
                  n = t[0];
                return r.localeCompare(n, void 0);
              });
            };
          return JSON.stringify([n(r), n(void 0 === t ? {} : t)]);
        },
        d = function (e) {
          return i(void 0, void 0, void 0, function () {
            var t;
            return o(this, function (r) {
              var n;
              switch (r.label) {
                case 0:
                  ((t = h(e)), (r.label = 1));
                case 1:
                  return (
                    r.trys.push([1, 3, , 4]),
                    [
                      4,
                      ((n = t),
                      i(void 0, void 0, void 0, function () {
                        var e, t, r, s;
                        return o(this, function (i) {
                          switch (i.label) {
                            case 0:
                              if (
                                ((e =
                                  "undefined" != typeof globalThis &&
                                  (null == (r = globalThis.crypto) ? void 0 : r.subtle)
                                    ? null == (s = globalThis.crypto)
                                      ? void 0
                                      : s.subtle
                                    : void 0),
                                "undefined" == typeof TextEncoder ||
                                  !(null == e ? void 0 : e.digest) ||
                                  "undefined" == typeof Uint8Array)
                              ) {
                                throw Error("Hashing function not available");
                              }
                              return (
                                (t = new TextEncoder().encode(n)), [4, e.digest("SHA-256", t)]
                              );
                            case 1:
                              return [
                                2,
                                Array.from(new Uint8Array(i.sent()))
                                  .map(function (e) {
                                    return e.toString(16).padStart(2, "0");
                                  })
                                  .join(""),
                              ];
                          }
                        });
                      })),
                    ]
                  );
                case 2:
                  return [2, r.sent()];
                case 3:
                  return (r.sent(), [2, t]);
                case 4:
                  return [2];
              }
            });
          });
        },
        f = function (e) {
          var t,
            r = e.clientKey,
            n = e.appName,
            s = e.connectionId,
            i = e.customHeaders,
            o = e.headerName,
            a = e.etag,
            l = e.isPost,
            u =
              (((t = { accept: "application/json" })[
                (void 0 === o ? "authorization" : o).toLocaleLowerCase()
              ] = r),
              (t["unleash-sdk"] = "unleash-client-js:3.7.8"),
              (t["unleash-appname"] = n),
              t);
          return (
            l && (u["content-type"] = "application/json"),
            a && (u["if-none-match"] = a),
            Object.entries(i || {})
              .filter(c)
              .forEach(function (e) {
                var t = e[0],
                  r = e[1];
                return (u[t.toLocaleLowerCase()] = r);
              }),
            (u["unleash-connection-id"] = s),
            u
          );
        },
        p = function () {},
        g = (function () {
          function e(e) {
            var t = e.onError,
              r = e.onSent,
              n = e.appName,
              s = e.metricsInterval,
              i = e.disableMetrics,
              o = e.url,
              a = e.clientKey,
              l = e.fetch,
              u = e.headerName,
              c = e.customHeaders,
              h = e.metricsIntervalInitial,
              d = e.connectionId;
            ((this.onError = t),
              (this.onSent = r || p),
              (this.disabled = void 0 !== i && i),
              (this.metricsInterval = 1e3 * s),
              (this.metricsIntervalInitial = 1e3 * h),
              (this.appName = n),
              (this.url = o instanceof URL ? o : new URL(o)),
              (this.clientKey = a),
              (this.bucket = this.createEmptyBucket()),
              (this.fetch = l),
              (this.headerName = u),
              (this.customHeaders = void 0 === c ? {} : c),
              (this.connectionId = d));
          }
          return (
            (e.prototype.start = function () {
              var e = this;
              if (this.disabled) {
                return !1;
              }
              "number" == typeof this.metricsInterval &&
                this.metricsInterval > 0 &&
                (this.metricsIntervalInitial > 0
                  ? setTimeout(function () {
                      (e.startTimer(), e.sendMetrics());
                    }, this.metricsIntervalInitial)
                  : this.startTimer());
            }),
            (e.prototype.stop = function () {
              this.timer && (clearInterval(this.timer), delete this.timer);
            }),
            (e.prototype.createEmptyBucket = function () {
              return { start: new Date(), stop: null, toggles: {} };
            }),
            (e.prototype.getHeaders = function () {
              return f({
                clientKey: this.clientKey,
                appName: this.appName,
                connectionId: this.connectionId,
                customHeaders: this.customHeaders,
                headerName: this.headerName,
                isPost: !0,
              });
            }),
            (e.prototype.sendMetrics = function () {
              return i(this, void 0, void 0, function () {
                var e, t, r;
                return o(this, function (n) {
                  switch (n.label) {
                    case 0:
                      if (
                        ((e = "".concat(this.url, "/client/metrics")),
                        (t = this.getPayload()),
                        this.bucketIsEmpty(t))
                      ) {
                        return [2];
                      }
                      n.label = 1;
                    case 1:
                      return (
                        n.trys.push([1, 3, , 4]),
                        [
                          4,
                          this.fetch(e, {
                            cache: "no-cache",
                            method: "POST",
                            headers: this.getHeaders(),
                            body: JSON.stringify(t),
                          }),
                        ]
                      );
                    case 2:
                      return (n.sent(), this.onSent(t), [3, 4]);
                    case 3:
                      return (
                        console.error("Unleash: unable to send feature metrics", (r = n.sent())),
                        this.onError(r),
                        [3, 4]
                      );
                    case 4:
                      return [2];
                  }
                });
              });
            }),
            (e.prototype.count = function (e, t) {
              return (
                !(this.disabled || !this.bucket) &&
                (this.assertBucket(e), this.bucket.toggles[e][t ? "yes" : "no"]++, !0)
              );
            }),
            (e.prototype.countVariant = function (e, t) {
              return (
                !(this.disabled || !this.bucket) &&
                (this.assertBucket(e),
                this.bucket.toggles[e].variants[t]
                  ? (this.bucket.toggles[e].variants[t] += 1)
                  : (this.bucket.toggles[e].variants[t] = 1),
                !0)
              );
            }),
            (e.prototype.assertBucket = function (e) {
              if (this.disabled || !this.bucket) {
                return !1;
              }
              this.bucket.toggles[e] || (this.bucket.toggles[e] = { yes: 0, no: 0, variants: {} });
            }),
            (e.prototype.startTimer = function () {
              var e = this;
              this.timer = setInterval(function () {
                e.sendMetrics();
              }, this.metricsInterval);
            }),
            (e.prototype.bucketIsEmpty = function (e) {
              return 0 === Object.keys(e.bucket.toggles).length;
            }),
            (e.prototype.getPayload = function () {
              var e = s(s({}, this.bucket), { stop: new Date() });
              return (
                (this.bucket = this.createEmptyBucket()),
                { bucket: e, appName: this.appName, instanceId: "browser" }
              );
            }),
            e
          );
        })(),
        m = (function () {
          function e() {
            this.store = new Map();
          }
          return (
            (e.prototype.save = function (e, t) {
              return i(this, void 0, void 0, function () {
                return o(this, function (r) {
                  return (this.store.set(e, t), [2]);
                });
              });
            }),
            (e.prototype.get = function (e) {
              return i(this, void 0, void 0, function () {
                return o(this, function (t) {
                  return [2, this.store.get(e)];
                });
              });
            }),
            e
          );
        })(),
        v = (function () {
          function e(e) {
            (void 0 === e && (e = "unleash:repository"), (this.prefix = e));
          }
          return (
            (e.prototype.save = function (e, t) {
              return i(this, void 0, void 0, function () {
                var r, n;
                return o(this, function (s) {
                  ((r = JSON.stringify(t)), (n = "".concat(this.prefix, ":").concat(e)));
                  try {
                    window.localStorage.setItem(n, r);
                  } catch (e) {
                    console.error(e);
                  }
                  return [2];
                });
              });
            }),
            (e.prototype.get = function (e) {
              try {
                var t = "".concat(this.prefix, ":").concat(e),
                  r = window.localStorage.getItem(t);
                return r ? JSON.parse(r) : void 0;
              } catch (e) {
                console.error(e);
              }
            }),
            e
          );
        })();
      let E = new Uint8Array(16),
        b = [];
      for (let e = 0; e < 256; ++e) {
        b.push((e + 256).toString(16).slice(1));
      }
      var y = {
          randomUUID:
            "undefined" != typeof crypto && crypto.randomUUID && crypto.randomUUID.bind(crypto),
        },
        I = (function () {
          function e() {}
          return (
            (e.prototype.generateEventId = function () {
              return (function (e, t, n) {
                if (y.randomUUID && !e) {
                  return y.randomUUID();
                }
                let s =
                  (e = e || {}).random ||
                  (
                    e.rng ||
                    function () {
                      if (
                        !r &&
                        !(r =
                          "undefined" != typeof crypto &&
                          crypto.getRandomValues &&
                          crypto.getRandomValues.bind(crypto))
                      ) {
                        throw Error(
                          "crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported",
                        );
                      }
                      return r(E);
                    }
                  )();
                ((s[6] = (15 & s[6]) | 64), void (s[8] = (63 & s[8]) | 128));
                return (function (e, t = 0) {
                  return (
                    b[e[t + 0]] +
                    b[e[t + 1]] +
                    b[e[t + 2]] +
                    b[e[t + 3]] +
                    "-" +
                    b[e[t + 4]] +
                    b[e[t + 5]] +
                    "-" +
                    b[e[t + 6]] +
                    b[e[t + 7]] +
                    "-" +
                    b[e[t + 8]] +
                    b[e[t + 9]] +
                    "-" +
                    b[e[t + 10]] +
                    b[e[t + 11]] +
                    b[e[t + 12]] +
                    b[e[t + 13]] +
                    b[e[t + 14]] +
                    b[e[t + 15]]
                  );
                })(s);
              })();
            }),
            (e.prototype.createImpressionEvent = function (e, t, r, n, i, o) {
              var a = this.createBaseEvent(e, t, r, n, i);
              return o ? s(s({}, a), { variant: o }) : a;
            }),
            (e.prototype.createBaseEvent = function (e, t, r, n, s) {
              return {
                eventType: n,
                eventId: this.generateEventId(),
                context: e,
                enabled: t,
                featureName: r,
                impressionData: s,
              };
            }),
            e
          );
        })(),
        R = ["userId", "sessionId", "remoteAddress", "currentTime"],
        S = function (e) {
          return R.includes(e);
        },
        T = {
          INIT: "initialized",
          ERROR: "error",
          READY: "ready",
          UPDATE: "update",
          IMPRESSION: "impression",
          SENT: "sent",
          RECOVERED: "recovered",
        },
        _ = { name: "disabled", enabled: !1, feature_enabled: !1 },
        A = "repo",
        N = "repoLastUpdateTimestamp",
        O = function () {
          try {
            if ("undefined" != typeof window && "fetch" in window) {
              return fetch.bind(window);
            }
            if ("fetch" in globalThis) {
              return fetch.bind(globalThis);
            }
          } catch (e) {
            console.error('Unleash failed to resolve "fetch"', e);
          }
        },
        x = (function (e) {
          function t(t) {
            var r,
              n = t.storageProvider,
              i = t.url,
              o = t.clientKey,
              a = t.disableRefresh,
              l = t.refreshInterval,
              u = t.metricsInterval,
              c = t.metricsIntervalInitial,
              h = t.disableMetrics,
              d = t.appName,
              f = t.environment,
              p = t.context,
              E = t.fetch,
              b = void 0 === E ? O() : E,
              y = t.createAbortController,
              R =
                void 0 === y
                  ? (function () {
                      try {
                        if ("undefined" != typeof window && "AbortController" in window) {
                          return function () {
                            return new window.AbortController();
                          };
                        }
                        if ("fetch" in globalThis) {
                          return function () {
                            return new globalThis.AbortController();
                          };
                        }
                      } catch (e) {
                        console.error('Unleash failed to resolve "AbortController" factory', e);
                      }
                    })()
                  : y,
              S = t.bootstrap,
              _ = t.bootstrapOverride,
              A = t.headerName,
              N = void 0 === A ? "Authorization" : A,
              x = t.customHeaders,
              C = void 0 === x ? {} : x,
              L = t.impressionDataAll,
              w = t.usePOSTrequests,
              $ = t.experimental,
              P = e.call(this) || this;
            if (
              ((P.toggles = []),
              (P.etag = ""),
              (P.readyEventEmitted = !1),
              (P.fetchedFromServer = !1),
              (P.usePOSTrequests = !1),
              (P.started = !1),
              !i)
            ) {
              throw Error("url is required");
            }
            if (!o) {
              throw Error("clientKey is required");
            }
            if (!d) {
              throw Error("appName is required.");
            }
            ((P.eventsHandler = new I()),
              (P.impressionDataAll = void 0 !== L && L),
              (P.toggles = S && S.length > 0 ? S : []),
              (P.url = i instanceof URL ? i : new URL(i)),
              (P.clientKey = o),
              (P.headerName = N),
              (P.customHeaders = C),
              (P.storage = n || ("undefined" != typeof window ? new v() : new m())),
              (P.refreshInterval = void 0 !== a && a ? 0 : 1e3 * (void 0 === l ? 30 : l)),
              (P.context = s({ appName: d, environment: void 0 === f ? "default" : f }, p)),
              (P.usePOSTrequests = void 0 !== w && w),
              (P.sdkState = "initializing"));
            var M = null == $ ? void 0 : $.metricsUrl;
            return (
              !M || M instanceof URL || (M = new URL(M)),
              (P.experimental = s(s({}, $), { metricsUrl: M })),
              (null == $ ? void 0 : $.togglesStorageTTL) &&
                (null == $ ? void 0 : $.togglesStorageTTL) > 0 &&
                (P.experimental.togglesStorageTTL = 1e3 * $.togglesStorageTTL),
              (P.lastRefreshTimestamp = 0),
              (P.ready = new Promise(function (e) {
                P.init()
                  .then(e)
                  .catch(function (t) {
                    (console.error(t),
                      (P.sdkState = "error"),
                      P.emit(T.ERROR, t),
                      (P.lastError = t),
                      e());
                  });
              })),
              b ||
                console.error(
                  'Unleash: You must either provide your own "fetch" implementation or run in an environment where "fetch" is available.',
                ),
              R ||
                console.error(
                  'Unleash: You must either provide your own "AbortController" implementation or run in an environment where "AbortController" is available.',
                ),
              (P.fetch = b),
              (P.createAbortController = R),
              (P.bootstrap = S && S.length > 0 ? S : void 0),
              (P.bootstrapOverride = void 0 === _ || _),
              (P.connectionId = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
                /[xy]/g,
                function (e) {
                  var t = (16 * Math.random()) | 0;
                  return ("x" === e ? t : (3 & t) | 8).toString(16);
                },
              )),
              (P.metrics = new g({
                onError: P.emit.bind(P, T.ERROR),
                onSent: P.emit.bind(P, T.SENT),
                appName: d,
                metricsInterval: void 0 === u ? 30 : u,
                disableMetrics: void 0 !== h && h,
                url: (null == (r = P.experimental) ? void 0 : r.metricsUrl) || P.url,
                clientKey: o,
                fetch: b,
                headerName: N,
                customHeaders: C,
                metricsIntervalInitial: void 0 === c ? 2 : c,
                connectionId: P.connectionId,
              })),
              P
            );
          }
          return (
            (function (e, t) {
              if ("function" != typeof t && null !== t) {
                throw TypeError(
                  "Class extends value " + String(t) + " is not a constructor or null",
                );
              }
              function r() {
                this.constructor = e;
              }
              (n(e, t),
                (e.prototype =
                  null === t ? Object.create(t) : ((r.prototype = t.prototype), new r())));
            })(t, e),
            (t.prototype.getAllToggles = function () {
              return (function (e, t, r) {
                if (r || 2 == arguments.length) {
                  for (var n, s = 0, i = t.length; s < i; s++)
                    (!n && s in t) ||
                      (n || (n = Array.prototype.slice.call(t, 0, s)), (n[s] = t[s]));
                }
                return e.concat(n || Array.prototype.slice.call(t));
              })([], this.toggles, !0);
            }),
            (t.prototype.isEnabled = function (e) {
              var t,
                r = this.toggles.find(function (t) {
                  return t.name === e;
                }),
                n = !!r && r.enabled;
              if (
                (this.metrics.count(e, n),
                (null == r ? void 0 : r.impressionData) || this.impressionDataAll)
              ) {
                var s = this.eventsHandler.createImpressionEvent(
                  this.context,
                  n,
                  e,
                  "isEnabled",
                  null != (t = null == r ? void 0 : r.impressionData) ? t : void 0,
                );
                this.emit(T.IMPRESSION, s);
              }
              return n;
            }),
            (t.prototype.getVariant = function (e) {
              var t,
                r = this.toggles.find(function (t) {
                  return t.name === e;
                }),
                n = (null == r ? void 0 : r.enabled) || !1,
                i = r ? r.variant : _;
              if (
                (i.name && this.metrics.countVariant(e, i.name),
                this.metrics.count(e, n),
                (null == r ? void 0 : r.impressionData) || this.impressionDataAll)
              ) {
                var o = this.eventsHandler.createImpressionEvent(
                  this.context,
                  n,
                  e,
                  "getVariant",
                  null != (t = null == r ? void 0 : r.impressionData) ? t : void 0,
                  i.name,
                );
                this.emit(T.IMPRESSION, o);
              }
              return s(s({}, i), { feature_enabled: n });
            }),
            (t.prototype.updateToggles = function () {
              return i(this, void 0, void 0, function () {
                var e = this;
                return o(this, function (t) {
                  switch (t.label) {
                    case 0:
                      return this.timerRef || this.fetchedFromServer
                        ? [4, this.fetchToggles()]
                        : [3, 2];
                    case 1:
                      return (t.sent(), [3, 4]);
                    case 2:
                      return this.started
                        ? [
                            4,
                            new Promise(function (t) {
                              var r = function () {
                                e.fetchToggles().then(function () {
                                  (e.off(T.READY, r), t());
                                });
                              };
                              e.once(T.READY, r);
                            }),
                          ]
                        : [3, 4];
                    case 3:
                      (t.sent(), (t.label = 4));
                    case 4:
                      return [2];
                  }
                });
              });
            }),
            (t.prototype.updateContext = function (e) {
              return i(this, void 0, void 0, function () {
                var t;
                return o(this, function (r) {
                  switch (r.label) {
                    case 0:
                      return (
                        (e.appName || e.environment) &&
                          console.warn(
                            "appName and environment are static. They can't be updated with updateContext.",
                          ),
                        (t = {
                          environment: this.context.environment,
                          appName: this.context.appName,
                          sessionId: this.context.sessionId,
                        }),
                        (this.context = s(s({}, t), e)),
                        [4, this.updateToggles()]
                      );
                    case 1:
                      return (r.sent(), [2]);
                  }
                });
              });
            }),
            (t.prototype.getContext = function () {
              return s({}, this.context);
            }),
            (t.prototype.setContextField = function (e, t) {
              return i(this, void 0, void 0, function () {
                var r, n, i;
                return o(this, function (o) {
                  switch (o.label) {
                    case 0:
                      return (
                        S(e)
                          ? (this.context = s(s({}, this.context), (((n = {})[e] = t), n)))
                          : ((r = s(s({}, this.context.properties), (((i = {})[e] = t), i))),
                            (this.context = s(s({}, this.context), { properties: r }))),
                        [4, this.updateToggles()]
                      );
                    case 1:
                      return (o.sent(), [2]);
                  }
                });
              });
            }),
            (t.prototype.removeContextField = function (e) {
              return i(this, void 0, void 0, function () {
                var t;
                return o(this, function (r) {
                  switch (r.label) {
                    case 0:
                      return (
                        S(e)
                          ? (this.context = s(s({}, this.context), (((t = {})[e] = void 0), t)))
                          : "object" == typeof this.context.properties &&
                            delete this.context.properties[e],
                        [4, this.updateToggles()]
                      );
                    case 1:
                      return (r.sent(), [2]);
                  }
                });
              });
            }),
            (t.prototype.setReady = function () {
              ((this.readyEventEmitted = !0), this.emit(T.READY));
            }),
            (t.prototype.init = function () {
              return i(this, void 0, void 0, function () {
                var e, t, r;
                return o(this, function (n) {
                  switch (n.label) {
                    case 0:
                      return [4, this.resolveSessionId()];
                    case 1:
                      return (
                        (e = n.sent()),
                        (this.context = s({ sessionId: e }, this.context)),
                        [4, this.storage.get(A)]
                      );
                    case 2:
                      return (
                        (t = n.sent() || []), (r = this), [4, this.getLastRefreshTimestamp()]
                      );
                    case 3:
                      return (
                        (r.lastRefreshTimestamp = n.sent()),
                        this.bootstrap && (this.bootstrapOverride || 0 === t.length)
                          ? [4, this.storage.save(A, this.bootstrap)]
                          : [3, 6]
                      );
                    case 4:
                      return (
                        n.sent(),
                        (this.toggles = this.bootstrap),
                        (this.sdkState = "healthy"),
                        [4, this.storeLastRefreshTimestamp()]
                      );
                    case 5:
                      return (n.sent(), this.setReady(), [3, 7]);
                    case 6:
                      ((this.toggles = t), (n.label = 7));
                    case 7:
                      return ((this.sdkState = "healthy"), this.emit(T.INIT), [2]);
                  }
                });
              });
            }),
            (t.prototype.start = function () {
              return i(this, void 0, void 0, function () {
                var e,
                  t = this;
                return o(this, function (r) {
                  switch (r.label) {
                    case 0:
                      return (
                        (this.started = !0),
                        this.timerRef
                          ? (console.error(
                              "Unleash SDK has already started, if you want to restart the SDK you should call client.stop() before starting again.",
                            ),
                            [2])
                          : [4, this.ready]
                      );
                    case 1:
                      return (
                        r.sent(),
                        this.metrics.start(),
                        (e = this.refreshInterval),
                        [4, this.initialFetchToggles()]
                      );
                    case 2:
                      return (
                        r.sent(),
                        e > 0 &&
                          (this.timerRef = setInterval(function () {
                            return t.fetchToggles();
                          }, e)),
                        [2]
                      );
                  }
                });
              });
            }),
            (t.prototype.stop = function () {
              (this.timerRef && (clearInterval(this.timerRef), (this.timerRef = void 0)),
                this.metrics.stop());
            }),
            (t.prototype.isReady = function () {
              return this.readyEventEmitted;
            }),
            (t.prototype.getError = function () {
              return "error" === this.sdkState ? this.lastError : void 0;
            }),
            (t.prototype.sendMetrics = function () {
              return this.metrics.sendMetrics();
            }),
            (t.prototype.resolveSessionId = function () {
              return i(this, void 0, void 0, function () {
                var e;
                return o(this, function (t) {
                  switch (t.label) {
                    case 0:
                      return this.context.sessionId
                        ? [2, this.context.sessionId]
                        : [4, this.storage.get("sessionId")];
                    case 1:
                      return (e = t.sent())
                        ? [3, 3]
                        : ((e = Math.floor(1e9 * Math.random())),
                          [4, this.storage.save("sessionId", e.toString(10))]);
                    case 2:
                      (t.sent(), (t.label = 3));
                    case 3:
                      return [2, e.toString(10)];
                  }
                });
              });
            }),
            (t.prototype.getHeaders = function () {
              return f({
                clientKey: this.clientKey,
                connectionId: this.connectionId,
                appName: this.context.appName,
                customHeaders: this.customHeaders,
                headerName: this.headerName,
                etag: this.etag,
                isPost: this.usePOSTrequests,
              });
            }),
            (t.prototype.storeToggles = function (e) {
              return i(this, void 0, void 0, function () {
                return o(this, function (t) {
                  switch (t.label) {
                    case 0:
                      return (
                        (this.toggles = e), this.emit(T.UPDATE), [4, this.storage.save(A, e)]
                      );
                    case 1:
                      return (t.sent(), [2]);
                  }
                });
              });
            }),
            (t.prototype.isTogglesStorageTTLEnabled = function () {
              var e;
              return !!(
                (null == (e = this.experimental) ? void 0 : e.togglesStorageTTL) &&
                this.experimental.togglesStorageTTL > 0
              );
            }),
            (t.prototype.isUpToDate = function () {
              if (!this.isTogglesStorageTTLEnabled()) {
                return !1;
              }
              var e,
                t = Date.now(),
                r = (null == (e = this.experimental) ? void 0 : e.togglesStorageTTL) || 0;
              return (
                this.lastRefreshTimestamp > 0 &&
                this.lastRefreshTimestamp <= t &&
                t - this.lastRefreshTimestamp <= r
              );
            }),
            (t.prototype.getLastRefreshTimestamp = function () {
              return i(this, void 0, void 0, function () {
                var e, t;
                return o(this, function (r) {
                  switch (r.label) {
                    case 0:
                      return this.isTogglesStorageTTLEnabled() ? [4, this.storage.get(N)] : [3, 3];
                    case 1:
                      return ((e = r.sent()), [4, d(this.context)]);
                    case 2:
                      return (
                        (t = r.sent()), [2, (null == e ? void 0 : e.key) === t ? e.timestamp : 0]
                      );
                    case 3:
                      return [2, 0];
                  }
                });
              });
            }),
            (t.prototype.storeLastRefreshTimestamp = function () {
              return i(this, void 0, void 0, function () {
                var e, t;
                return o(this, function (r) {
                  switch (r.label) {
                    case 0:
                      return this.isTogglesStorageTTLEnabled()
                        ? ((this.lastRefreshTimestamp = Date.now()), (t = {}), [4, d(this.context)])
                        : [3, 3];
                    case 1:
                      return (
                        (t.key = r.sent()),
                        (t.timestamp = this.lastRefreshTimestamp),
                        (e = t),
                        [4, this.storage.save(N, e)]
                      );
                    case 2:
                      (r.sent(), (r.label = 3));
                    case 3:
                      return [2];
                  }
                });
              });
            }),
            (t.prototype.initialFetchToggles = function () {
              if (!this.isUpToDate()) {
                return this.fetchToggles();
              }
              this.fetchedFromServer || ((this.fetchedFromServer = !0), this.setReady());
            }),
            (t.prototype.fetchToggles = function () {
              return i(this, void 0, void 0, function () {
                var e, t, r, n, s, i, a, l, u;
                return o(this, function (o) {
                  switch (o.label) {
                    case 0:
                      if (!this.fetch) {
                        return [3, 9];
                      }
                      (this.abortController &&
                        !this.abortController.signal.aborted &&
                        this.abortController.abort(),
                        (this.abortController =
                          null == (u = this.createAbortController) ? void 0 : u.call(this)),
                        (e = this.abortController ? this.abortController.signal : void 0),
                        (o.label = 1));
                    case 1:
                      var h, d, f;
                      return (
                        o.trys.push([1, 7, 8, 9]),
                        (r = (t = this.usePOSTrequests)
                          ? this.url
                          : ((h = this.url),
                            (d = this.context),
                            (f = new URL(h.toString())),
                            Object.entries(d)
                              .filter(c)
                              .forEach(function (e) {
                                var t = e[0],
                                  r = e[1];
                                "properties" === t && r
                                  ? Object.entries(r)
                                      .filter(c)
                                      .forEach(function (e) {
                                        var t = e[0],
                                          r = e[1];
                                        return f.searchParams.append(
                                          "properties[".concat(t, "]"),
                                          r,
                                        );
                                      })
                                  : f.searchParams.append(t, r);
                              }),
                            f)),
                        (n = t ? "POST" : "GET"),
                        (s = t ? JSON.stringify({ context: this.context }) : void 0),
                        [
                          4,
                          this.fetch(r.toString(), {
                            method: n,
                            cache: "no-cache",
                            headers: this.getHeaders(),
                            body: s,
                            signal: e,
                          }),
                        ]
                      );
                    case 2:
                      return (
                        (i = o.sent()),
                        "error" === this.sdkState &&
                          i.status < 400 &&
                          ((this.sdkState = "healthy"), this.emit(T.RECOVERED)),
                        i.ok ? ((this.etag = i.headers.get("ETag") || ""), [4, i.json()]) : [3, 5]
                      );
                    case 3:
                      return ((a = o.sent()), [4, this.storeToggles(a.toggles)]);
                    case 4:
                      return (
                        o.sent(),
                        "healthy" !== this.sdkState && (this.sdkState = "healthy"),
                        this.fetchedFromServer || ((this.fetchedFromServer = !0), this.setReady()),
                        this.storeLastRefreshTimestamp(),
                        [3, 6]
                      );
                    case 5:
                      (304 === i.status
                        ? this.storeLastRefreshTimestamp()
                        : (console.error(
                            "Unleash: Fetching feature toggles did not have an ok response",
                          ),
                          (this.sdkState = "error"),
                          this.emit(T.ERROR, { type: "HttpError", code: i.status }),
                          (this.lastError = { type: "HttpError", code: i.status })),
                        (o.label = 6));
                    case 6:
                      return [3, 9];
                    case 7:
                      return (
                        ("object" == typeof (l = o.sent()) &&
                          null !== l &&
                          "name" in l &&
                          "AbortError" === l.name) ||
                          (console.error("Unleash: unable to fetch feature toggles", l),
                          (this.sdkState = "error"),
                          this.emit(T.ERROR, l),
                          (this.lastError = l)),
                        [3, 9]
                      );
                    case 8:
                      return ((this.abortController = null), [7]);
                    case 9:
                      return [2];
                  }
                });
              });
            }),
            t
          );
        })(u);
      ((t.EVENTS = T),
        (t.InMemoryStorageProvider = m),
        (t.LocalStorageProvider = v),
        (t.UnleashClient = x),
        (t.lastUpdateKey = N),
        (t.resolveFetch = O));
    },
    12461: (e, t, r) => {
      let n = r(4093);
      e.exports = (e, t) =>
        new n(e, t).set.map((e) =>
          e
            .map((e) => e.value)
            .join(" ")
            .trim()
            .split(" "),
        );
    },
    12752: function (e, t) {
      !(function (r, n) {
        "use strict";
        var s = { version: "3.0.1", x86: {}, x64: {} };
        function i(e, t) {
          return (65535 & e) * t + ((((e >>> 16) * t) & 65535) << 16);
        }
        function o(e, t) {
          return (e << t) | (e >>> (32 - t));
        }
        function a(e) {
          return (
            (e ^= e >>> 16),
            (e = i(e, 0x85ebca6b)),
            (e ^= e >>> 13),
            (e = i(e, 0xc2b2ae35)),
            (e ^= e >>> 16)
          );
        }
        function l(e, t) {
          ((e = [e[0] >>> 16, 65535 & e[0], e[1] >>> 16, 65535 & e[1]]),
            (t = [t[0] >>> 16, 65535 & t[0], t[1] >>> 16, 65535 & t[1]]));
          var r = [0, 0, 0, 0];
          return (
            (r[3] += e[3] + t[3]),
            (r[2] += r[3] >>> 16),
            (r[3] &= 65535),
            (r[2] += e[2] + t[2]),
            (r[1] += r[2] >>> 16),
            (r[2] &= 65535),
            (r[1] += e[1] + t[1]),
            (r[0] += r[1] >>> 16),
            (r[1] &= 65535),
            (r[0] += e[0] + t[0]),
            (r[0] &= 65535),
            [(r[0] << 16) | r[1], (r[2] << 16) | r[3]]
          );
        }
        function u(e, t) {
          ((e = [e[0] >>> 16, 65535 & e[0], e[1] >>> 16, 65535 & e[1]]),
            (t = [t[0] >>> 16, 65535 & t[0], t[1] >>> 16, 65535 & t[1]]));
          var r = [0, 0, 0, 0];
          return (
            (r[3] += e[3] * t[3]),
            (r[2] += r[3] >>> 16),
            (r[3] &= 65535),
            (r[2] += e[2] * t[3]),
            (r[1] += r[2] >>> 16),
            (r[2] &= 65535),
            (r[2] += e[3] * t[2]),
            (r[1] += r[2] >>> 16),
            (r[2] &= 65535),
            (r[1] += e[1] * t[3]),
            (r[0] += r[1] >>> 16),
            (r[1] &= 65535),
            (r[1] += e[2] * t[2]),
            (r[0] += r[1] >>> 16),
            (r[1] &= 65535),
            (r[1] += e[3] * t[1]),
            (r[0] += r[1] >>> 16),
            (r[1] &= 65535),
            (r[0] += e[0] * t[3] + e[1] * t[2] + e[2] * t[1] + e[3] * t[0]),
            (r[0] &= 65535),
            [(r[0] << 16) | r[1], (r[2] << 16) | r[3]]
          );
        }
        function c(e, t) {
          return 32 == (t %= 64)
            ? [e[1], e[0]]
            : t < 32
              ? [(e[0] << t) | (e[1] >>> (32 - t)), (e[1] << t) | (e[0] >>> (32 - t))]
              : ((t -= 32), [(e[1] << t) | (e[0] >>> (32 - t)), (e[0] << t) | (e[1] >>> (32 - t))]);
        }
        function h(e, t) {
          return 0 == (t %= 64)
            ? e
            : t < 32
              ? [(e[0] << t) | (e[1] >>> (32 - t)), e[1] << t]
              : [e[1] << (t - 32), 0];
        }
        function d(e, t) {
          return [e[0] ^ t[0], e[1] ^ t[1]];
        }
        function f(e) {
          return (
            (e = u((e = d(e, [0, e[0] >>> 1])), [0xff51afd7, 0xed558ccd])),
            (e = u((e = d(e, [0, e[0] >>> 1])), [0xc4ceb9fe, 0x1a85ec53])),
            (e = d(e, [0, e[0] >>> 1]))
          );
        }
        ((s.x86.hash32 = function (e, t) {
          t = t || 0;
          for (
            var r = (e = e || "").length % 4, n = e.length - r, s = t, l = 0, u = 0;
            u < n;
            u += 4
          ) {
            ((l = o(
              (l = i(
                (l =
                  (255 & e.charCodeAt(u)) |
                  ((255 & e.charCodeAt(u + 1)) << 8) |
                  ((255 & e.charCodeAt(u + 2)) << 16) |
                  ((255 & e.charCodeAt(u + 3)) << 24)),
                0xcc9e2d51,
              )),
              15,
            )),
              (s ^= l = i(l, 0x1b873593)),
              (s = i((s = o(s, 13)), 5) + 0xe6546b64));
          }
          switch (((l = 0), r)) {
            case 3:
              l ^= (255 & e.charCodeAt(u + 2)) << 16;
            case 2:
              l ^= (255 & e.charCodeAt(u + 1)) << 8;
            case 1:
              ((l ^= 255 & e.charCodeAt(u)),
                (l = o((l = i(l, 0xcc9e2d51)), 15)),
                (s ^= l = i(l, 0x1b873593)));
          }
          return ((s ^= e.length), (s = a(s)) >>> 0);
        }),
          (s.x86.hash128 = function (e, t) {
            t = t || 0;
            for (
              var r = (e = e || "").length % 16,
                n = e.length - r,
                s = t,
                l = t,
                u = t,
                c = t,
                h = 0,
                d = 0,
                f = 0,
                p = 0,
                g = 0;
              g < n;
              g += 16
            ) {
              ((h =
                (255 & e.charCodeAt(g)) |
                ((255 & e.charCodeAt(g + 1)) << 8) |
                ((255 & e.charCodeAt(g + 2)) << 16) |
                ((255 & e.charCodeAt(g + 3)) << 24)),
                (d =
                  (255 & e.charCodeAt(g + 4)) |
                  ((255 & e.charCodeAt(g + 5)) << 8) |
                  ((255 & e.charCodeAt(g + 6)) << 16) |
                  ((255 & e.charCodeAt(g + 7)) << 24)),
                (f =
                  (255 & e.charCodeAt(g + 8)) |
                  ((255 & e.charCodeAt(g + 9)) << 8) |
                  ((255 & e.charCodeAt(g + 10)) << 16) |
                  ((255 & e.charCodeAt(g + 11)) << 24)),
                (p =
                  (255 & e.charCodeAt(g + 12)) |
                  ((255 & e.charCodeAt(g + 13)) << 8) |
                  ((255 & e.charCodeAt(g + 14)) << 16) |
                  ((255 & e.charCodeAt(g + 15)) << 24)),
                (h = o((h = i(h, 0x239b961b)), 15)),
                (s ^= h = i(h, 0xab0e9789)),
                (s = i((s = o(s, 19) + l), 5) + 0x561ccd1b),
                (d = o((d = i(d, 0xab0e9789)), 16)),
                (l ^= d = i(d, 0x38b34ae5)),
                (l = i((l = o(l, 17) + u), 5) + 0xbcaa747),
                (f = o((f = i(f, 0x38b34ae5)), 17)),
                (u ^= f = i(f, 0xa1e38b93)),
                (u = i((u = o(u, 15) + c), 5) + 0x96cd1c35),
                (p = o((p = i(p, 0xa1e38b93)), 18)),
                (c ^= p = i(p, 0x239b961b)),
                (c = i((c = o(c, 13) + s), 5) + 0x32ac3b17));
            }
            switch (((h = 0), (d = 0), (f = 0), (p = 0), r)) {
              case 15:
                p ^= e.charCodeAt(g + 14) << 16;
              case 14:
                p ^= e.charCodeAt(g + 13) << 8;
              case 13:
                ((p ^= e.charCodeAt(g + 12)),
                  (p = o((p = i(p, 0xa1e38b93)), 18)),
                  (c ^= p = i(p, 0x239b961b)));
              case 12:
                f ^= e.charCodeAt(g + 11) << 24;
              case 11:
                f ^= e.charCodeAt(g + 10) << 16;
              case 10:
                f ^= e.charCodeAt(g + 9) << 8;
              case 9:
                ((f ^= e.charCodeAt(g + 8)),
                  (f = o((f = i(f, 0x38b34ae5)), 17)),
                  (u ^= f = i(f, 0xa1e38b93)));
              case 8:
                d ^= e.charCodeAt(g + 7) << 24;
              case 7:
                d ^= e.charCodeAt(g + 6) << 16;
              case 6:
                d ^= e.charCodeAt(g + 5) << 8;
              case 5:
                ((d ^= e.charCodeAt(g + 4)),
                  (d = o((d = i(d, 0xab0e9789)), 16)),
                  (l ^= d = i(d, 0x38b34ae5)));
              case 4:
                h ^= e.charCodeAt(g + 3) << 24;
              case 3:
                h ^= e.charCodeAt(g + 2) << 16;
              case 2:
                h ^= e.charCodeAt(g + 1) << 8;
              case 1:
                ((h ^= e.charCodeAt(g)),
                  (h = o((h = i(h, 0x239b961b)), 15)),
                  (s ^= h = i(h, 0xab0e9789)));
            }
            return (
              (s ^= e.length),
              (l ^= e.length),
              (u ^= e.length),
              (c ^= e.length),
              (s += l),
              (s += u),
              (s += c),
              (l += s),
              (u += s),
              (c += s),
              (s = a(s)),
              (l = a(l)),
              (u = a(u)),
              (c = a(c)),
              (s += l),
              (s += u),
              (s += c),
              (l += s),
              (u += s),
              (c += s),
              ("00000000" + (s >>> 0).toString(16)).slice(-8) +
                ("00000000" + (l >>> 0).toString(16)).slice(-8) +
                ("00000000" + (u >>> 0).toString(16)).slice(-8) +
                ("00000000" + (c >>> 0).toString(16)).slice(-8)
            );
          }),
          (s.x64.hash128 = function (e, t) {
            t = t || 0;
            for (
              var r = (e = e || "").length % 16,
                n = e.length - r,
                s = [0, t],
                i = [0, t],
                o = [0, 0],
                a = [0, 0],
                p = [0x87c37b91, 0x114253d5],
                g = [0x4cf5ad43, 0x2745937f],
                m = 0;
              m < n;
              m += 16
            ) {
              ((o = [
                (255 & e.charCodeAt(m + 4)) |
                  ((255 & e.charCodeAt(m + 5)) << 8) |
                  ((255 & e.charCodeAt(m + 6)) << 16) |
                  ((255 & e.charCodeAt(m + 7)) << 24),
                (255 & e.charCodeAt(m)) |
                  ((255 & e.charCodeAt(m + 1)) << 8) |
                  ((255 & e.charCodeAt(m + 2)) << 16) |
                  ((255 & e.charCodeAt(m + 3)) << 24),
              ]),
                (a = [
                  (255 & e.charCodeAt(m + 12)) |
                    ((255 & e.charCodeAt(m + 13)) << 8) |
                    ((255 & e.charCodeAt(m + 14)) << 16) |
                    ((255 & e.charCodeAt(m + 15)) << 24),
                  (255 & e.charCodeAt(m + 8)) |
                    ((255 & e.charCodeAt(m + 9)) << 8) |
                    ((255 & e.charCodeAt(m + 10)) << 16) |
                    ((255 & e.charCodeAt(m + 11)) << 24),
                ]),
                (o = c((o = u(o, p)), 31)),
                (s = l((s = c((s = d(s, (o = u(o, g)))), 27)), i)),
                (s = l(u(s, [0, 5]), [0, 0x52dce729])),
                (a = c((a = u(a, g)), 33)),
                (i = l((i = c((i = d(i, (a = u(a, p)))), 31)), s)),
                (i = l(u(i, [0, 5]), [0, 0x38495ab5])));
            }
            switch (((o = [0, 0]), (a = [0, 0]), r)) {
              case 15:
                a = d(a, h([0, e.charCodeAt(m + 14)], 48));
              case 14:
                a = d(a, h([0, e.charCodeAt(m + 13)], 40));
              case 13:
                a = d(a, h([0, e.charCodeAt(m + 12)], 32));
              case 12:
                a = d(a, h([0, e.charCodeAt(m + 11)], 24));
              case 11:
                a = d(a, h([0, e.charCodeAt(m + 10)], 16));
              case 10:
                a = d(a, h([0, e.charCodeAt(m + 9)], 8));
              case 9:
                ((a = c((a = u((a = d(a, [0, e.charCodeAt(m + 8)])), g)), 33)),
                  (i = d(i, (a = u(a, p)))));
              case 8:
                o = d(o, h([0, e.charCodeAt(m + 7)], 56));
              case 7:
                o = d(o, h([0, e.charCodeAt(m + 6)], 48));
              case 6:
                o = d(o, h([0, e.charCodeAt(m + 5)], 40));
              case 5:
                o = d(o, h([0, e.charCodeAt(m + 4)], 32));
              case 4:
                o = d(o, h([0, e.charCodeAt(m + 3)], 24));
              case 3:
                o = d(o, h([0, e.charCodeAt(m + 2)], 16));
              case 2:
                o = d(o, h([0, e.charCodeAt(m + 1)], 8));
              case 1:
                ((o = c((o = u((o = d(o, [0, e.charCodeAt(m)])), p)), 31)),
                  (s = d(s, (o = u(o, g)))));
            }
            return (
              (s = l((s = d(s, [0, e.length])), (i = d(i, [0, e.length])))),
              (i = l(i, s)),
              (s = l((s = f(s)), (i = f(i)))),
              (i = l(i, s)),
              ("00000000" + (s[0] >>> 0).toString(16)).slice(-8) +
                ("00000000" + (s[1] >>> 0).toString(16)).slice(-8) +
                ("00000000" + (i[0] >>> 0).toString(16)).slice(-8) +
                ("00000000" + (i[1] >>> 0).toString(16)).slice(-8)
            );
          }),
          e.exports && (t = e.exports = s),
          (t.murmurHash3 = s));
      })(0);
    },
    16782: (e, t, r) => {
      let n = r(4093);
      e.exports = (e, t, r) => ((e = new n(e, r)), (t = new n(t, r)), e.intersects(t, r));
    },
    17023: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("Copy", [
        ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2", key: "17jyea" }],
        ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2", key: "zix9uf" }],
      ]);
    },
    17312: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t) => new n(e, t).minor;
    },
    18103: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => 0 > n(e, t, r);
    },
    23792: (e, t, r) => {
      "use strict";
      r.d(t, { default: () => s.a });
      var n = r(45165),
        s = r.n(n);
    },
    24699: function (e, t, r) {
      (function (e, t, r) {
        "use strict";
        let n = r.createContext(null),
          s = {
            bootstrap: [],
            disableRefresh: !0,
            disableMetrics: !0,
            url: "http://localhost",
            appName: "offline",
            clientKey: "not-used",
          },
          i = r.startTransition || ((e) => e()),
          o = ({
            config: e,
            children: o,
            unleashClient: a,
            startClient: l = !0,
            stopClient: u = !0,
            startTransition: c = i,
          }) => {
            var h, d, f;
            let p = e || s,
              g = r.useRef(a || new t.UnleashClient(p)),
              [m, v] = r.useState(
                !!(a
                  ? (null != e &&
                      e.bootstrap &&
                      (null == e ? void 0 : e.bootstrapOverride) !== !1) ||
                    (null != (h = a.isReady) && h.call(a))
                  : p.bootstrap && !1 !== p.bootstrapOverride),
              ),
              [E, b] = r.useState(
                (null == (f = (d = g.current).getError) ? void 0 : f.call(d)) || null,
              );
            r.useEffect(() => {
              p ||
                a ||
                console.error(`You must provide either a config or an unleash client to the flag provider.
        If you are initializing the client in useEffect, you can avoid this warning
        by checking if the client exists before rendering.`);
              let e = (e) => {
                  c(() => {
                    b((t) => t || e);
                  });
                },
                t = (e) => {
                  c(() => {
                    b(null);
                  });
                },
                r = null,
                n = () => {
                  r = setTimeout(() => {
                    c(() => {
                      v(!0);
                    });
                  }, 0);
                };
              return (
                g.current.on("ready", n),
                g.current.on("error", e),
                g.current.on("recovered", t),
                l && (g.current.stop(), g.current.start()),
                function () {
                  (g.current &&
                    (g.current.off("error", e),
                    g.current.off("ready", n),
                    g.current.off("recovered", t),
                    u && g.current.stop()),
                    r && clearTimeout(r));
                }
              );
            }, []);
            let y = r.useMemo(
              () => ({
                on: (e, t, r) => g.current.on(e, t, r),
                off: (e, t) => g.current.off(e, t),
                updateContext: async (e) => await g.current.updateContext(e),
                isEnabled: (e) => g.current.isEnabled(e),
                getVariant: (e) => g.current.getVariant(e),
                client: g.current,
                flagsReady: m,
                flagsError: E,
                setFlagsReady: v,
                setFlagsError: b,
              }),
              [m, E],
            );
            return r.createElement(n.Provider, { value: y }, o);
          },
          a = {
            on: (e, t, r) => (console.error("on() must be used within a FlagProvider"), l),
            off: (e, t) => (console.error("off() must be used within a FlagProvider"), l),
            updateContext: async () => {
              console.error("updateContext() must be used within a FlagProvider");
            },
            isEnabled: () => (console.error("isEnabled() must be used within a FlagProvider"), !1),
            getVariant: () => (
              console.error("getVariant() must be used within a FlagProvider"),
              { name: "disabled", enabled: !1 }
            ),
          },
          l = {
            ...a,
            toggles: [],
            impressionDataAll: {},
            context: {},
            storage: {},
            start: () => {},
            stop: () => {},
            isReady: () => !1,
            getError: () => null,
            getAllToggles: () => [],
          },
          u = {
            ...a,
            client: l,
            flagsReady: !1,
            setFlagsReady: () => {
              console.error("setFlagsReady() must be used within a FlagProvider");
            },
            flagsError: null,
            setFlagsError: () => {
              console.error("setFlagsError() must be used within a FlagProvider");
            },
          };
        function c() {
          return (
            r.useContext(n) ||
            (console.error("useFlagContext() must be used within a FlagProvider"), u)
          );
        }
        (Object.defineProperty(e, "InMemoryStorageProvider", {
          enumerable: !0,
          get: () => t.InMemoryStorageProvider,
        }),
          Object.defineProperty(e, "LocalStorageProvider", {
            enumerable: !0,
            get: () => t.LocalStorageProvider,
          }),
          Object.defineProperty(e, "UnleashClient", { enumerable: !0, get: () => t.UnleashClient }),
          (e.FlagContext = n),
          (e.FlagProvider = o),
          (e.default = o),
          (e.useFlag = (e) => {
            let { isEnabled: t, client: n } = c(),
              [s, i] = r.useState(!!t(e)),
              o = r.useRef();
            return (
              (o.current = s),
              r.useEffect(() => {
                if (!n) {
                  return;
                }
                let r = () => {
                    let r = t(e);
                    r !== o.current && ((o.current = r), i(!!r));
                  },
                  s = () => {
                    let r = t(e);
                    ((o.current = r), i(r));
                  };
                return (
                  n.on("update", r),
                  n.on("ready", s),
                  () => {
                    (n.off("update", r), n.off("ready", s));
                  }
                );
              }, [n]),
              s
            );
          }),
          (e.useFlags = () => {
            let { client: e } = c(),
              [t, n] = r.useState(e.getAllToggles());
            return (
              r.useEffect(() => {
                let t = () => {
                  n(e.getAllToggles());
                };
                return (
                  e.on("update", t),
                  () => {
                    e.off("update", t);
                  }
                );
              }, []),
              t
            );
          }),
          (e.useFlagsStatus = () => {
            let { flagsReady: e, flagsError: t } = c();
            return { flagsReady: e, flagsError: t };
          }),
          (e.useUnleashClient = () => {
            let { client: e } = c();
            return e;
          }),
          (e.useUnleashContext = () => {
            let { updateContext: e } = c();
            return e;
          }),
          (e.useVariant = (e) => {
            let { getVariant: t, client: n } = c(),
              [s, i] = r.useState(t(e)),
              o = r.useRef({ name: s.name, enabled: s.enabled });
            return (
              (o.current = s),
              r.useEffect(() => {
                if (!n) {
                  return;
                }
                let r = () => {
                    var r, n, s, a, l;
                    let u = t(e);
                    ((r = o.current),
                      (r.name !== (null == u ? void 0 : u.name) ||
                        r.enabled !== (null == u ? void 0 : u.enabled) ||
                        r.feature_enabled !== (null == u ? void 0 : u.feature_enabled) ||
                        (null == (n = r.payload) ? void 0 : n.type) !==
                          (null == (s = null == u ? void 0 : u.payload) ? void 0 : s.type) ||
                        (null == (a = r.payload) ? void 0 : a.value) !==
                          (null == (l = null == u ? void 0 : u.payload) ? void 0 : l.value)) &&
                        (i(u), (o.current = u)));
                  },
                  s = () => {
                    let r = t(e);
                    ((o.current.name = null == r ? void 0 : r.name),
                      (o.current.enabled = null == r ? void 0 : r.enabled),
                      i(r));
                  };
                return (
                  n.on("update", r),
                  n.on("ready", s),
                  () => {
                    (n.off("update", r), n.off("ready", s));
                  }
                );
              }, [n]),
              s || {}
            );
          }),
          Object.defineProperties(e, {
            __esModule: { value: !0 },
            [Symbol.toStringTag]: { value: "Module" },
          }));
      })(t, r(11477), r(7620));
    },
    27318: (e, t, r) => {
      let n = r(49420),
        s = r(4093);
      e.exports = (e, t, r) => {
        let i = null,
          o = null,
          a = null;
        try {
          a = new s(t, r);
        } catch (e) {
          return null;
        }
        return (
          e.forEach((e) => {
            a.test(e) && (!i || -1 === o.compare(e)) && (o = new n((i = e), r));
          }),
          i
        );
      };
    },
    27635: (e, t, r) => {
      let n = r(99914);
      e.exports = (e, t) => {
        let r = n(e, t);
        return r ? r.version : null;
      };
    },
    29363: (e, t, r) => {
      let n = r(98851);
      e.exports = (e, t) => e.sort((e, r) => n(r, e, t));
    },
    31799: (e, t, r) => {
      "use strict";
      Object.defineProperty(t, "__esModule", { value: !0 });
      let n = r(60996),
        s = /^(\d{1,3}\.){3,3}\d{1,3}$/,
        i = /^(::)?(((\d{1,3}\.){3}(\d{1,3}){1})?([0-9a-f]){0,4}:{0,2}){1,8}(::)?$/i,
        o = {
          isV4Format: function (e) {
            return s.test(e);
          },
          toBuffer: function (e, t, r = 0) {
            let s;
            if (((r = ~~r), this.isV4Format(e))) {
              ((s = t || n.Buffer.alloc(r + 4)),
                e.split(/\./g).map((e) => {
                  s[r++] = 255 & parseInt(e, 10);
                }));
            } else if (this.isV6Format(e)) {
              let i,
                o = e.split(":", 8);
              for (i = 0; i < o.length; i++) {
                let e;
                (this.isV4Format(o[i]) &&
                  ((e = this.toBuffer(o[i])), (o[i] = e.slice(0, 2).toString("hex"))),
                  e && ++i < 8 && o.splice(i, 0, e.slice(2, 4).toString("hex")));
              }
              if ("" === o[0]) {
                for (; o.length < 8; ) o.unshift("0");
              } else if ("" === o[o.length - 1]) {
                for (; o.length < 8; ) o.push("0");
              } else if (o.length < 8) {
                for (i = 0; i < o.length && "" !== o[i]; i++) {}
                let e = [i, 1];
                for (i = 9 - o.length; i > 0; i--) {
                  e.push("0");
                }
                o.splice(...e);
              }
              for (i = 0, s = t || n.Buffer.alloc(r + 16); i < o.length; i++) {
                let e = parseInt(o[i], 16);
                ((s[r++] = (e >> 8) & 255), (s[r++] = 255 & e));
              }
            }
            if (!s) {
              throw Error(`Invalid ip address: ${e}`);
            }
            return s;
          },
          isV6Format: function (e) {
            return i.test(e);
          },
          toLong: function (e) {
            let t = 0;
            return (
              e.split(".").forEach((e) => {
                ((t <<= 8), (t += parseInt(e)));
              }),
              t >>> 0
            );
          },
          fromLong: function (e) {
            return `${e >>> 24}.${(e >> 16) & 255}.${(e >> 8) & 255}.${255 & e}`;
          },
          subnet: function (e, t) {
            let r = o.toLong(o.mask(e, t)),
              n = o.toBuffer(t),
              s = 0;
            for (let e = 0; e < n.length; e++) {
              if (255 === n[e]) s += 8;
              else {
                let t = 255 & n[e];
                for (; t; ) ((t = (t << 1) & 255), s++);
              }
            }
            let i = 2 ** (32 - s);
            return {
              networkAddress: o.fromLong(r),
              firstAddress: i <= 2 ? o.fromLong(r) : o.fromLong(r + 1),
              lastAddress: i <= 2 ? o.fromLong(r + i - 1) : o.fromLong(r + i - 2),
              broadcastAddress: o.fromLong(r + i - 1),
              subnetMask: t,
              subnetMaskLength: s,
              numHosts: i <= 2 ? i : i - 2,
              length: i,
              contains: (e) => r === o.toLong(o.mask(e, t)),
            };
          },
          toString: function (e, t, r) {
            t = ~~(t || 0);
            let n = [];
            if (4 === (r = r || e.length - t)) {
              for (let s = 0; s < r; s++) {
                n.push(e[t + s]);
              }
              n = n.join(".");
            } else if (16 === r) {
              for (let s = 0; s < r; s += 2) {
                n.push(e.readUInt16BE(t + s).toString(16));
              }
              n = (n = (n = n.join(":")).replace(/(^|:)0(:0)*:0(:|$)/, "$1::$3")).replace(
                /:{3,4}/,
                "::",
              );
            }
            return n;
          },
          fromPrefixLen: function (e, t) {
            if (e > 32) {
              t = "ipv6";
            } else {
              var r;
              t = 4 === (r = t) ? "ipv4" : 6 === r ? "ipv6" : r ? `${r}`.toLowerCase() : "ipv4";
            }
            let s = 4;
            "ipv6" === t && (s = 16);
            let i = n.Buffer.alloc(s);
            for (let t = 0, r = i.length; t < r; ++t) {
              let r = 8;
              (e < 8 && (r = e), (e -= r), (i[t] = 255 & ~(255 >> r)));
            }
            return o.toString(i);
          },
          cidrSubnet: function (e) {
            let t = e.split("/"),
              r = t[0];
            if (2 !== t.length) {
              throw Error(`invalid CIDR subnet: ${r}`);
            }
            let n = o.fromPrefixLen(parseInt(t[1], 10));
            return o.subnet(r, n);
          },
          mask: function (e, t) {
            let r,
              s = o.toBuffer(e),
              i = o.toBuffer(t),
              a = n.Buffer.alloc(Math.max(s.length, i.length));
            if (s.length === i.length) {
              for (r = 0; r < s.length; r++) a[r] = s[r] & i[r];
            } else if (4 === i.length) {
              for (r = 0; r < i.length; r++) a[r] = s[s.length - 4 + r] & i[r];
            } else {
              for (r = 0; r < a.length - 6; r++) {
                a[r] = 0;
              }
              for (r = 0, a[10] = 255, a[11] = 255; r < s.length; r++) {
                a[r + 12] = s[r] & i[r + 12];
              }
              r += 12;
            }
            for (; r < a.length; r++) {
              a[r] = 0;
            }
            return o.toString(a);
          },
        };
      t.default = o;
    },
    33959: (e) => {
      let t = Object.freeze({ loose: !0 }),
        r = Object.freeze({});
      e.exports = (e) => (e ? ("object" != typeof e ? t : e) : r);
    },
    34438: (e, t, r) => {
      "use strict";
      var n = r(40459);
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.flagsClient = void 0));
      let s = r(11477),
        i = r(87323);
      t.flagsClient = (e = [], t) => {
        let {
          appName: r,
          url: o,
          clientKey: a,
        } = {
          ...((0, i.getServerBaseUrl)() && n.env.UNLEASH_SERVER_API_TOKEN
            ? (0, i.getDefaultServerConfig)()
            : (0, i.getDefaultClientConfig)()),
          ...t,
        };
        return new s.UnleashClient({
          url: o,
          appName: r,
          clientKey: a,
          bootstrap: e,
          createAbortController: () => null,
          refreshInterval: 0,
          metricsInterval: 0,
          disableRefresh: !0,
          bootstrapOverride: !0,
          storageProvider: { get: async (e) => {}, save: async (e, t) => {} },
        });
      };
    },
    35e3: (e) => {
      class t {
        constructor() {
          ((this.max = 1e3), (this.map = new Map()));
        }
        get(e) {
          let t = this.map.get(e);
          if (void 0 !== t) {
            return (this.map.delete(e), this.map.set(e, t), t);
          }
        }
        delete(e) {
          return this.map.delete(e);
        }
        set(e, t) {
          if (!this.delete(e) && void 0 !== t) {
            if (this.map.size >= this.max) {
              let e = this.map.keys().next().value;
              this.delete(e);
            }
            this.map.set(e, t);
          }
          return this;
        }
      }
      e.exports = t;
    },
    35139: (e, t, r) => {
      let n = r(93592),
        s = r(82478),
        i = r(49420),
        o = r(9151),
        a = r(99914),
        l = r(27635),
        u = r(99184),
        c = r(53005),
        h = r(35844),
        d = r(11004),
        f = r(17312),
        p = r(88955),
        g = r(44757),
        m = r(6994),
        v = r(78706),
        E = r(901),
        b = r(98851),
        y = r(96659),
        I = r(29363),
        R = r(45912),
        S = r(18103),
        T = r(78769),
        _ = r(59437),
        A = r(44107),
        N = r(53662),
        O = r(38205),
        x = r(75470),
        C = r(8916),
        L = r(4093),
        w = r(69412),
        $ = r(12461),
        P = r(27318),
        M = r(87420),
        U = r(48009),
        j = r(45010),
        D = r(2319),
        F = r(86347),
        k = r(38350),
        V = r(16782);
      e.exports = {
        parse: a,
        valid: l,
        clean: u,
        inc: c,
        diff: h,
        major: d,
        minor: f,
        patch: p,
        prerelease: g,
        compare: m,
        rcompare: v,
        compareLoose: E,
        compareBuild: b,
        sort: y,
        rsort: I,
        gt: R,
        lt: S,
        eq: T,
        neq: _,
        gte: A,
        lte: N,
        cmp: O,
        coerce: x,
        Comparator: C,
        Range: L,
        satisfies: w,
        toComparators: $,
        maxSatisfying: P,
        minSatisfying: M,
        minVersion: U,
        validRange: j,
        outside: D,
        gtr: F,
        ltr: k,
        intersects: V,
        simplifyRange: r(90615),
        subset: r(84390),
        SemVer: i,
        re: n.re,
        src: n.src,
        tokens: n.t,
        SEMVER_SPEC_VERSION: s.SEMVER_SPEC_VERSION,
        RELEASE_TYPES: s.RELEASE_TYPES,
        compareIdentifiers: o.compareIdentifiers,
        rcompareIdentifiers: o.rcompareIdentifiers,
      };
    },
    35844: (e, t, r) => {
      let n = r(99914);
      e.exports = (e, t) => {
        let r = n(e, null, !0),
          s = n(t, null, !0),
          i = r.compare(s);
        if (0 === i) {
          return null;
        }
        let o = i > 0,
          a = o ? r : s,
          l = o ? s : r,
          u = !!a.prerelease.length;
        if (l.prerelease.length && !u) {
          return l.patch || l.minor ? (a.patch ? "patch" : a.minor ? "minor" : "major") : "major";
        }
        let c = u ? "pre" : "";
        return r.major !== s.major
          ? c + "major"
          : r.minor !== s.minor
            ? c + "minor"
            : r.patch !== s.patch
              ? c + "patch"
              : "prerelease";
      };
    },
    38205: (e, t, r) => {
      let n = r(78769),
        s = r(59437),
        i = r(45912),
        o = r(44107),
        a = r(18103),
        l = r(53662);
      e.exports = (e, t, r, u) => {
        switch (t) {
          case "===":
            return (
              "object" == typeof e && (e = e.version),
              "object" == typeof r && (r = r.version),
              e === r
            );
          case "!==":
            return (
              "object" == typeof e && (e = e.version),
              "object" == typeof r && (r = r.version),
              e !== r
            );
          case "":
          case "=":
          case "==":
            return n(e, r, u);
          case "!=":
            return s(e, r, u);
          case ">":
            return i(e, r, u);
          case ">=":
            return o(e, r, u);
          case "<":
            return a(e, r, u);
          case "<=":
            return l(e, r, u);
          default:
            throw TypeError(`Invalid operator: ${t}`);
        }
      };
    },
    38350: (e, t, r) => {
      let n = r(2319);
      e.exports = (e, t, r) => n(e, t, "<", r);
    },
    38503: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      Object.defineProperty(t, "__esModule", { value: !0 });
      let s = r(77249),
        i = n(r(70250)),
        o = r(52735),
        a = "default";
      class l extends s.Strategy {
        randomGenerator = () => `${Math.round(100 * Math.random()) + 1}`;
        constructor(e) {
          (super("flexibleRollout"), e && (this.randomGenerator = e));
        }
        resolveStickiness(e, t) {
          switch (e) {
            case a:
              return t.userId || t.sessionId || this.randomGenerator();
            case "random":
              return this.randomGenerator();
            default:
              return (0, o.resolveContextValue)(t, e);
          }
        }
        isEnabled(e, t) {
          let r = e.groupId || t.featureToggle || "",
            n = Number(e.rollout),
            s = e.stickiness || a,
            o = this.resolveStickiness(s, t);
          if (!o) {
            return !1;
          }
          let l = (0, i.default)(o, r);
          return n > 0 && l <= n;
        }
      }
      t.default = l;
    },
    41576: (e, t, r) => {
      "use strict";
      var n = r(40459);
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.evaluateFlags = void 0));
      let s = r(46440);
      t.evaluateFlags = (e, t = {}) => {
        let r;
        try {
          r = new s.ToggleEngine(e);
        } catch (e) {
          return (
            console.error("Unleash: Failed to evaluate flags from provided definitions", e),
            { toggles: [] }
          );
        }
        let i = {
            currentTime: new Date(),
            appName: n.env.UNLEASH_APP_NAME || n.env.NEXT_PUBLIC_UNLEASH_APP_NAME,
            ...t,
          },
          o = e?.features?.map((e) => {
            let t = r.getValue(e.name, i);
            return {
              name: e.name,
              enabled: !!t,
              impressionData: !!e.impressionData,
              variant: t || { enabled: !1, name: "disabled" },
              dependencies: e.dependencies,
            };
          });
        return {
          toggles: o
            .filter(
              (e) =>
                !1 !== e.enabled &&
                (!e?.dependencies?.length ||
                  e.dependencies.every((t) => {
                    let r = o.find((e) => e.name === t.feature);
                    return (r ||
                      console.warn(
                        `Unleash: \`${e.name}\` has unresolved dependency \`${t.feature}\`.`,
                      ),
                    r?.dependencies?.length)
                      ? (console.warn(
                          `Unleash: \`${e.name}\` cannot depend on \`${t.feature}\` which also has dependencies.`,
                        ),
                        !1)
                      : !(
                          (r?.enabled && !1 === t.enabled) ||
                          (!r?.enabled && !1 !== t.enabled) ||
                          (t.variants?.length &&
                            (!r?.variant.name || !t.variants.includes(r.variant.name)))
                        );
                  })),
            )
            .map((e) => ({
              name: e.name,
              enabled: e.enabled,
              variant: { ...e.variant, feature_enabled: e.enabled },
              impressionData: e.impressionData,
            })),
        };
      };
    },
    41630: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.useUnleashClient =
          t.useUnleashContext =
          t.useFlagsStatus =
          t.useFlags =
          t.useVariant =
          t.useFlag =
            void 0));
      let n = r(24699);
      ((t.useFlag = (e) => (0, n.useFlag)(e)),
        (t.useVariant = (e) => (0, n.useVariant)(e)),
        (t.useFlags = () => (0, n.useFlags)()),
        (t.useFlagsStatus = n.useFlagsStatus),
        (t.useUnleashContext = n.useUnleashContext),
        (t.useUnleashClient = n.useUnleashClient));
    },
    44107: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => n(e, t, r) >= 0;
    },
    44757: (e, t, r) => {
      let n = r(99914);
      e.exports = (e, t) => {
        let r = n(e, t);
        return r && r.prerelease.length ? r.prerelease : null;
      };
    },
    45010: (e, t, r) => {
      let n = r(4093);
      e.exports = (e, t) => {
        try {
          return new n(e, t).range || "*";
        } catch (e) {
          return null;
        }
      };
    },
    45152: (e, t, r) => {
      "use strict";
      var n = r(40459);
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.getDefinitions = t.getDefaultConfig = void 0));
      let s = r(87323),
        i = r(96827),
        o = "http://localhost:4242/api/client/features",
        a = "default:development.unleash-insecure-api-token",
        l = i.devDependencies["@unleash/client-specification"];
      t.getDefaultConfig = (e = "nextjs") => {
        let t,
          r = (0, s.removeTrailingSlash)(
            n.env.UNLEASH_SERVER_API_URL || n.env.NEXT_PUBLIC_UNLEASH_SERVER_API_URL,
          ),
          i = n.env.UNLEASH_SERVER_API_TOKEN,
          l = n.env.UNLEASH_SERVER_INSTANCE_ID;
        return (
          i ? (t = i) : l || (t = a),
          {
            appName: n.env.UNLEASH_APP_NAME || n.env.NEXT_PUBLIC_UNLEASH_APP_NAME || e,
            url: r ? `${r}/client/features` : o,
            ...(t ? { token: t } : {}),
            ...(l ? { instanceId: l } : {}),
            fetchOptions: {},
          }
        );
      };
      let u = async (e) => {
        let {
          appName: r,
          url: n,
          token: s,
          instanceId: u,
          fetchOptions: c,
        } = { ...(0, t.getDefaultConfig)(), ...e };
        (n === o &&
          console.warn(
            "Using fallback Unleash API URL (http://localhost:4242/api).",
            "Provide a URL or set UNLEASH_SERVER_API_URL environment variable.",
          ),
          s === a &&
            console.error(
              "Using fallback default token. Pass token or set UNLEASH_SERVER_API_TOKEN environment variable.",
            ));
        let h = new URL(n),
          d = !u || s !== a,
          f = {
            "content-type": "application/json",
            "user-agent": r,
            "unleash-client-spec": l,
            "unleash-sdk": `unleash-client-nextjs:${i.version}`,
            "unleash-appname": r,
          };
        (d && s && (f.authorization = s),
          u && (f["unleash-instanceid"] = u),
          c.headers &&
            Object.entries(c.headers).forEach(([e, t]) => {
              f[e.toLowerCase()] = t;
            }));
        let p = await fetch(h.toString(), { ...c, headers: f });
        return p?.json();
      };
      t.getDefinitions = u;
    },
    45165: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          default: function () {
            return v;
          },
          handleClientScriptLoad: function () {
            return p;
          },
          initScriptLoader: function () {
            return g;
          },
        }));
      let n = r(21736),
        s = r(24045),
        i = r(54568),
        o = n._(r(97509)),
        a = s._(r(7620)),
        l = r(89892),
        u = r(78716),
        c = r(55848),
        h = new Map(),
        d = new Set(),
        f = (e) => {
          let {
              src: t,
              id: r,
              onLoad: n = () => {},
              onReady: s = null,
              dangerouslySetInnerHTML: i,
              children: a = "",
              strategy: l = "afterInteractive",
              onError: c,
              stylesheets: f,
            } = e,
            p = r || t;
          if (p && d.has(p)) {
            return;
          }
          if (h.has(t)) {
            (d.add(p), h.get(t).then(n, c));
            return;
          }
          let g = () => {
              (s && s(), d.add(p));
            },
            m = document.createElement("script"),
            v = new Promise((e, t) => {
              (m.addEventListener("load", function (t) {
                (e(), n && n.call(this, t), g());
              }),
                m.addEventListener("error", function (e) {
                  t(e);
                }));
            }).catch(function (e) {
              c && c(e);
            });
          (i
            ? ((m.innerHTML = i.__html || ""), g())
            : a
              ? ((m.textContent = "string" == typeof a ? a : Array.isArray(a) ? a.join("") : ""),
                g())
              : t && ((m.src = t), h.set(t, v)),
            (0, u.setAttributesFromProps)(m, e),
            "worker" === l && m.setAttribute("type", "text/partytown"),
            m.setAttribute("data-nscript", l),
            f &&
              ((e) => {
                if (o.default.preinit) {
                  return e.forEach((e) => {
                    o.default.preinit(e, { as: "style" });
                  });
                }
                {
                  let t = document.head;
                  e.forEach((e) => {
                    let r = document.createElement("link");
                    ((r.type = "text/css"), (r.rel = "stylesheet"), (r.href = e), t.appendChild(r));
                  });
                }
              })(f),
            document.body.appendChild(m));
        };
      function p(e) {
        let { strategy: t = "afterInteractive" } = e;
        "lazyOnload" === t
          ? window.addEventListener("load", () => {
              (0, c.requestIdleCallback)(() => f(e));
            })
          : f(e);
      }
      function g(e) {
        (e.forEach(p),
          [
            ...document.querySelectorAll('[data-nscript="beforeInteractive"]'),
            ...document.querySelectorAll('[data-nscript="beforePageRender"]'),
          ].forEach((e) => {
            let t = e.id || e.getAttribute("src");
            d.add(t);
          }));
      }
      function m(e) {
        let {
            id: t,
            src: r = "",
            onLoad: n = () => {},
            onReady: s = null,
            strategy: u = "afterInteractive",
            onError: h,
            stylesheets: p,
            ...g
          } = e,
          {
            updateScripts: m,
            scripts: v,
            getIsSsr: E,
            appDir: b,
            nonce: y,
          } = (0, a.useContext)(l.HeadManagerContext);
        y = g.nonce || y;
        let I = (0, a.useRef)(!1);
        (0, a.useEffect)(() => {
          let e = t || r;
          I.current || (s && e && d.has(e) && s(), (I.current = !0));
        }, [s, t, r]);
        let R = (0, a.useRef)(!1);
        if (
          ((0, a.useEffect)(() => {
            if (!R.current) {
              if ("afterInteractive" === u) {
                f(e);
              } else {
                "lazyOnload" === u &&
                  ("complete" === document.readyState
                    ? (0, c.requestIdleCallback)(() => f(e))
                    : window.addEventListener("load", () => {
                        (0, c.requestIdleCallback)(() => f(e));
                      }));
              }
              R.current = !0;
            }
          }, [e, u]),
          ("beforeInteractive" === u || "worker" === u) &&
            (m
              ? ((v[u] = (v[u] || []).concat([
                  { id: t, src: r, onLoad: n, onReady: s, onError: h, ...g, nonce: y },
                ])),
                m(v))
              : E && E()
                ? d.add(t || r)
                : E && !E() && f({ ...e, nonce: y })),
          b)
        ) {
          if (
            (p &&
              p.forEach((e) => {
                o.default.preinit(e, { as: "style" });
              }),
            "beforeInteractive" === u)
          ) {
            if (!r)
              return (
                g.dangerouslySetInnerHTML &&
                  ((g.children = g.dangerouslySetInnerHTML.__html),
                  delete g.dangerouslySetInnerHTML),
                (0, i.jsx)("script", {
                  nonce: y,
                  dangerouslySetInnerHTML: {
                    __html:
                      "(self.__next_s=self.__next_s||[]).push(" +
                      JSON.stringify([0, { ...g, id: t }]) +
                      ")",
                  },
                })
              );
            else
              return (
                o.default.preload(
                  r,
                  g.integrity
                    ? { as: "script", integrity: g.integrity, nonce: y, crossOrigin: g.crossOrigin }
                    : { as: "script", nonce: y, crossOrigin: g.crossOrigin },
                ),
                (0, i.jsx)("script", {
                  nonce: y,
                  dangerouslySetInnerHTML: {
                    __html:
                      "(self.__next_s=self.__next_s||[]).push(" +
                      JSON.stringify([r, { ...g, id: t }]) +
                      ")",
                  },
                })
              );
          }
          "afterInteractive" === u &&
            r &&
            o.default.preload(
              r,
              g.integrity
                ? { as: "script", integrity: g.integrity, nonce: y, crossOrigin: g.crossOrigin }
                : { as: "script", nonce: y, crossOrigin: g.crossOrigin },
            );
        }
        return null;
      }
      Object.defineProperty(m, "__nextScript", { value: !0 });
      let v = m;
      ("function" == typeof t.default || ("object" == typeof t.default && null !== t.default)) &&
        void 0 === t.default.__esModule &&
        (Object.defineProperty(t.default, "__esModule", { value: !0 }),
        Object.assign(t.default, t),
        (e.exports = t.default));
    },
    45912: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => n(e, t, r) > 0;
    },
    46440: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.ToggleEngine = void 0));
      let n = r(10663),
        s = r(80160),
        i = r(10663);
      class o {
        features;
        strategies;
        segments;
        constructor(e) {
          ((this.features = (function (e) {
            let t = new Map();
            return (
              e &&
                e.features.forEach((e) => {
                  t.set(e.name, e);
                }),
              t
            );
          })(e)),
            (this.strategies = [...s.defaultStrategies]),
            (this.segments = (function (e) {
              let t = new Map();
              return (
                e &&
                  e.segments &&
                  e.segments.forEach((e) => {
                    t.set(e.id, e);
                  }),
                t
              );
            })(e)));
        }
        getStrategy(e) {
          return this.strategies.find((t) => t.name === e);
        }
        *yieldConstraintsFor(e) {
          e.constraints && (yield* e.constraints);
          let t = e.segments?.map((e) => this.segments.get(e));
          t && (yield* this.yieldSegmentConstraints(t));
        }
        yieldSegmentConstraints(e) {
          let t = [];
          for (let r of e) {
            r ? (t = t.concat(r.constraints)) : t.push(void 0);
          }
          return t;
        }
        getValue(e, t) {
          let r,
            s = this.features.get(e);
          if (!s?.enabled) {
            return;
          }
          let o = s?.strategies?.some((e) => {
            let n = this.getStrategy(e.name);
            if (!n) {
              return !1;
            }
            let s = this.yieldConstraintsFor(e),
              i = n.getResult(e.parameters, t, s, e.variants);
            return !!i.enabled && ((r = i.variant), !0);
          });
          if (r) {
            return r;
          }
          if ((s?.strategies?.length === 0 || o) && s?.variants) {
            let e = (0, n.selectVariant)(s, t);
            if (e) {
              return { name: e.name, payload: e.payload, enabled: !0 };
            }
          }
          if (o || !s?.strategies?.length) {
            return (0, i.getDefaultVariant)();
          }
        }
      }
      t.ToggleEngine = o;
    },
    48009: (e, t, r) => {
      let n = r(49420),
        s = r(4093),
        i = r(45912);
      e.exports = (e, t) => {
        e = new s(e, t);
        let r = new n("0.0.0");
        if (e.test(r) || ((r = new n("0.0.0-0")), e.test(r))) {
          return r;
        }
        r = null;
        for (let t = 0; t < e.set.length; ++t) {
          let s = e.set[t],
            o = null;
          (s.forEach((e) => {
            let t = new n(e.semver.version);
            switch (e.operator) {
              case ">":
                (0 === t.prerelease.length ? t.patch++ : t.prerelease.push(0),
                  (t.raw = t.format()));
              case "":
              case ">=":
                (!o || i(t, o)) && (o = t);
                break;
              case "<":
              case "<=":
                break;
              default:
                throw Error(`Unexpected operation: ${e.operator}`);
            }
          }),
            o && (!r || i(r, o)) && (r = o));
        }
        return r && e.test(r) ? r : null;
      };
    },
    49420: (e, t, r) => {
      let n = r(66512),
        { MAX_LENGTH: s, MAX_SAFE_INTEGER: i } = r(82478),
        { safeRe: o, t: a } = r(93592),
        l = r(33959),
        { compareIdentifiers: u } = r(9151);
      class c {
        constructor(e, t) {
          if (((t = l(t)), e instanceof c)) {
            if (!!t.loose === e.loose && !!t.includePrerelease === e.includePrerelease) return e;
            else e = e.version;
          } else if ("string" != typeof e) {
            throw TypeError(`Invalid version. Must be a string. Got type "${typeof e}".`);
          }
          if (e.length > s) {
            throw TypeError(`version is longer than ${s} characters`);
          }
          (n("SemVer", e, t),
            (this.options = t),
            (this.loose = !!t.loose),
            (this.includePrerelease = !!t.includePrerelease));
          let r = e.trim().match(t.loose ? o[a.LOOSE] : o[a.FULL]);
          if (!r) {
            throw TypeError(`Invalid Version: ${e}`);
          }
          if (
            ((this.raw = e),
            (this.major = +r[1]),
            (this.minor = +r[2]),
            (this.patch = +r[3]),
            this.major > i || this.major < 0)
          ) {
            throw TypeError("Invalid major version");
          }
          if (this.minor > i || this.minor < 0) {
            throw TypeError("Invalid minor version");
          }
          if (this.patch > i || this.patch < 0) {
            throw TypeError("Invalid patch version");
          }
          (r[4]
            ? (this.prerelease = r[4].split(".").map((e) => {
                if (/^[0-9]+$/.test(e)) {
                  let t = +e;
                  if (t >= 0 && t < i) {
                    return t;
                  }
                }
                return e;
              }))
            : (this.prerelease = []),
            (this.build = r[5] ? r[5].split(".") : []),
            this.format());
        }
        format() {
          return (
            (this.version = `${this.major}.${this.minor}.${this.patch}`),
            this.prerelease.length && (this.version += `-${this.prerelease.join(".")}`),
            this.version
          );
        }
        toString() {
          return this.version;
        }
        compare(e) {
          if ((n("SemVer.compare", this.version, this.options, e), !(e instanceof c))) {
            if ("string" == typeof e && e === this.version) {
              return 0;
            }
            e = new c(e, this.options);
          }
          return e.version === this.version ? 0 : this.compareMain(e) || this.comparePre(e);
        }
        compareMain(e) {
          return (
            e instanceof c || (e = new c(e, this.options)),
            u(this.major, e.major) || u(this.minor, e.minor) || u(this.patch, e.patch)
          );
        }
        comparePre(e) {
          if (
            (e instanceof c || (e = new c(e, this.options)),
            this.prerelease.length && !e.prerelease.length)
          ) {
            return -1;
          }
          if (!this.prerelease.length && e.prerelease.length) {
            return 1;
          }
          if (!this.prerelease.length && !e.prerelease.length) {
            return 0;
          }
          let t = 0;
          do {
            let r = this.prerelease[t],
              s = e.prerelease[t];
            if ((n("prerelease compare", t, r, s), void 0 === r && void 0 === s)) {
              return 0;
            }
            if (void 0 === s) {
              return 1;
            }
            if (void 0 === r) {
              return -1;
            } else if (r === s) {
              continue;
            } else {
              return u(r, s);
            }
          } while (++t);
        }
        compareBuild(e) {
          e instanceof c || (e = new c(e, this.options));
          let t = 0;
          do {
            let r = this.build[t],
              s = e.build[t];
            if ((n("build compare", t, r, s), void 0 === r && void 0 === s)) {
              return 0;
            }
            if (void 0 === s) {
              return 1;
            }
            if (void 0 === r) {
              return -1;
            } else if (r === s) {
              continue;
            } else {
              return u(r, s);
            }
          } while (++t);
        }
        inc(e, t, r) {
          switch (e) {
            case "premajor":
              ((this.prerelease.length = 0),
                (this.patch = 0),
                (this.minor = 0),
                this.major++,
                this.inc("pre", t, r));
              break;
            case "preminor":
              ((this.prerelease.length = 0), (this.patch = 0), this.minor++, this.inc("pre", t, r));
              break;
            case "prepatch":
              ((this.prerelease.length = 0), this.inc("patch", t, r), this.inc("pre", t, r));
              break;
            case "prerelease":
              (0 === this.prerelease.length && this.inc("patch", t, r), this.inc("pre", t, r));
              break;
            case "major":
              ((0 !== this.minor || 0 !== this.patch || 0 === this.prerelease.length) &&
                this.major++,
                (this.minor = 0),
                (this.patch = 0),
                (this.prerelease = []));
              break;
            case "minor":
              ((0 !== this.patch || 0 === this.prerelease.length) && this.minor++,
                (this.patch = 0),
                (this.prerelease = []));
              break;
            case "patch":
              (0 === this.prerelease.length && this.patch++, (this.prerelease = []));
              break;
            case "pre": {
              let e = +!!Number(r);
              if (!t && !1 === r) {
                throw Error("invalid increment argument: identifier is empty");
              }
              if (0 === this.prerelease.length) {
                this.prerelease = [e];
              } else {
                let n = this.prerelease.length;
                for (; --n >= 0; ) {
                  "number" == typeof this.prerelease[n] && (this.prerelease[n]++, (n = -2));
                }
                if (-1 === n) {
                  if (t === this.prerelease.join(".") && !1 === r) {
                    throw Error("invalid increment argument: identifier already exists");
                  }
                  this.prerelease.push(e);
                }
              }
              if (t) {
                let n = [t, e];
                (!1 === r && (n = [t]),
                  0 === u(this.prerelease[0], t)
                    ? isNaN(this.prerelease[1]) && (this.prerelease = n)
                    : (this.prerelease = n));
              }
              break;
            }
            default:
              throw Error(`invalid increment argument: ${e}`);
          }
          return (
            (this.raw = this.format()),
            this.build.length && (this.raw += `+${this.build.join(".")}`),
            this
          );
        }
      }
      e.exports = c;
    },
    52735: function (e, t, r) {
      "use strict";
      var n = r(40459),
        s =
          (this && this.__createBinding) ||
          (Object.create
            ? function (e, t, r, n) {
                void 0 === n && (n = r);
                var s = Object.getOwnPropertyDescriptor(t, r);
                ((!s || ("get" in s ? !t.__esModule : s.writable || s.configurable)) &&
                  (s = {
                    enumerable: !0,
                    get: function () {
                      return t[r];
                    },
                  }),
                  Object.defineProperty(e, n, s));
              }
            : function (e, t, r, n) {
                (void 0 === n && (n = r), (e[n] = t[r]));
              }),
        i =
          (this && this.__setModuleDefault) ||
          (Object.create
            ? function (e, t) {
                Object.defineProperty(e, "default", { enumerable: !0, value: t });
              }
            : function (e, t) {
                e.default = t;
              }),
        o =
          (this && this.__importStar) ||
          function (e) {
            if (e && e.__esModule) {
              return e;
            }
            var t = {};
            if (null != e) {
              for (var r in e)
                "default" !== r && Object.prototype.hasOwnProperty.call(e, r) && s(t, e, r);
            }
            return (i(t, e), t);
          };
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.createFallbackFunction = function (e, t, r) {
          return "function" == typeof r
            ? () => r(e, t)
            : "boolean" == typeof r
              ? () => r
              : () => !1;
        }),
        (t.resolveContextValue = function (e, t) {
          return e[t] ? e[t] : e.properties && e.properties[t] ? e.properties[t] : void 0;
        }),
        (t.safeName = function (e = "") {
          return e.replace(/\//g, "_");
        }),
        (t.generateInstanceId = function (e) {
          if (e) {
            return e;
          }
          let t = `generated-${Math.round(1e6 * Math.random())}-${n.pid}`;
          return `${t}-nextjs`;
        }),
        (t.generateHashOfObject = function (e) {
          let t = JSON.stringify(e);
          return a.x86.hash128(t);
        }));
      let a = o(r(90314));
    },
    53005: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t, r, s, i) => {
        "string" == typeof r && ((i = s), (s = r), (r = void 0));
        try {
          return new n(e instanceof n ? e.version : e, r).inc(t, s, i).version;
        } catch (e) {
          return null;
        }
      };
    },
    53416: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.flag = void 0));
      let n = r(41576),
        s = r(34438),
        i = r(45152);
      t.flag = async (e, t = {}, r) => {
        let o =
          r?.fetchOptions?.next?.revalidate !== void 0 ? r?.fetchOptions?.next?.revalidate : 15;
        try {
          let a = await (0, i.getDefinitions)({
              ...r,
              fetchOptions: { next: { revalidate: o }, ...r?.fetchOptions },
            }),
            { toggles: l } = await (0, n.evaluateFlags)(a, t),
            u = (0, s.flagsClient)(l);
          return { enabled: u.isEnabled(e), variant: u.getVariant(e) };
        } catch (e) {
          return { enabled: !1, variant: {}, error: e };
        }
      };
    },
    53662: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => 0 >= n(e, t, r);
    },
    55848: (e, t) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          cancelIdleCallback: function () {
            return n;
          },
          requestIdleCallback: function () {
            return r;
          },
        }));
      let r =
          ("undefined" != typeof self &&
            self.requestIdleCallback &&
            self.requestIdleCallback.bind(window)) ||
          function (e) {
            let t = Date.now();
            return self.setTimeout(function () {
              e({
                didTimeout: !1,
                timeRemaining: function () {
                  return Math.max(0, 50 - (Date.now() - t));
                },
              });
            }, 1);
          },
        n =
          ("undefined" != typeof self &&
            self.cancelIdleCallback &&
            self.cancelIdleCallback.bind(window)) ||
          function (e) {
            return clearTimeout(e);
          };
      ("function" == typeof t.default || ("object" == typeof t.default && null !== t.default)) &&
        void 0 === t.default.__esModule &&
        (Object.defineProperty(t.default, "__esModule", { value: !0 }),
        Object.assign(t.default, t),
        (e.exports = t.default));
    },
    59437: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => 0 !== n(e, t, r);
    },
    63141: (e, t, r) => {
      "use strict";
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.getFrontendFlags = void 0));
      let n = r(11477),
        s = r(87323);
      t.getFrontendFlags = async (e) =>
        new Promise((t, r) => {
          let i = new n.UnleashClient({
            ...(0, s.getDefaultClientConfig)(),
            ...e,
            disableRefresh: !0,
            disableMetrics: !0,
          });
          (i.on("ready", () => {
            (t({ toggles: i.getAllToggles() }), i.stop());
          }),
            i.on("error", (e) => {
              (r(e), i.stop());
            }),
            i.start());
        });
    },
    64138: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      Object.defineProperty(t, "__esModule", { value: !0 });
      let s = r(77249),
        i = n(r(31799));
      class o extends s.Strategy {
        constructor() {
          super("remoteAddress");
        }
        isEnabled(e, t) {
          return (
            !!e.IPs &&
            e.IPs.split(/\s*,\s*/).some((e) => {
              if (e === t.remoteAddress) {
                return !0;
              }
              if (!i.default.isV6Format(e)) {
                try {
                  return (
                    (t.remoteAddress && i.default.cidrSubnet(e).contains(t.remoteAddress)) || !1
                  );
                } catch (e) {}
              }
              return !1;
            })
          );
        }
      }
      t.default = o;
    },
    66512: (e, t, r) => {
      var n = r(40459);
      e.exports =
        "object" == typeof n && n.env && n.env.NODE_DEBUG && /\bsemver\b/i.test(n.env.NODE_DEBUG)
          ? (...e) => console.error("SEMVER", ...e)
          : () => {};
    },
    66794: (e, t, r) => {
      "use strict";
      Object.defineProperty(t, "__esModule", { value: !0 });
      let n = r(77249);
      class s extends n.Strategy {
        randomGenerator = () => Math.floor(100 * Math.random()) + 1;
        constructor(e) {
          (super("gradualRolloutRandom"), (this.randomGenerator = e || this.randomGenerator));
        }
        isEnabled(e, t) {
          return Number(e.percentage) >= this.randomGenerator();
        }
      }
      t.default = s;
    },
    69412: (e, t, r) => {
      let n = r(4093);
      e.exports = (e, t, r) => {
        try {
          t = new n(t, r);
        } catch (e) {
          return !1;
        }
        return t.test(e);
      };
    },
    70250: function (e, t, r) {
      "use strict";
      var n =
          (this && this.__createBinding) ||
          (Object.create
            ? function (e, t, r, n) {
                void 0 === n && (n = r);
                var s = Object.getOwnPropertyDescriptor(t, r);
                ((!s || ("get" in s ? !t.__esModule : s.writable || s.configurable)) &&
                  (s = {
                    enumerable: !0,
                    get: function () {
                      return t[r];
                    },
                  }),
                  Object.defineProperty(e, n, s));
              }
            : function (e, t, r, n) {
                (void 0 === n && (n = r), (e[n] = t[r]));
              }),
        s =
          (this && this.__setModuleDefault) ||
          (Object.create
            ? function (e, t) {
                Object.defineProperty(e, "default", { enumerable: !0, value: t });
              }
            : function (e, t) {
                e.default = t;
              }),
        i =
          (this && this.__importStar) ||
          function (e) {
            if (e && e.__esModule) {
              return e;
            }
            var t = {};
            if (null != e) {
              for (var r in e)
                "default" !== r && Object.prototype.hasOwnProperty.call(e, r) && n(t, e, r);
            }
            return (s(t, e), t);
          };
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.default = function (e, t, r = 100, n = 0) {
          return (o.x86.hash32(`${t}:${e}`, n) % r) + 1;
        }));
      let o = i(r(90314));
    },
    75470: (e, t, r) => {
      let n = r(49420),
        s = r(99914),
        { safeRe: i, t: o } = r(93592);
      e.exports = (e, t) => {
        if (e instanceof n) {
          return e;
        }
        if (("number" == typeof e && (e = String(e)), "string" != typeof e)) {
          return null;
        }
        let r = null;
        if ((t = t || {}).rtl) {
          let n,
            s = t.includePrerelease ? i[o.COERCERTLFULL] : i[o.COERCERTL];
          for (; (n = s.exec(e)) && (!r || r.index + r[0].length !== e.length); ) {
            ((r && n.index + n[0].length === r.index + r[0].length) || (r = n),
              (s.lastIndex = n.index + n[1].length + n[2].length));
          }
          s.lastIndex = -1;
        } else {
          r = e.match(t.includePrerelease ? i[o.COERCEFULL] : i[o.COERCE]);
        }
        if (null === r) {
          return null;
        }
        let a = r[2],
          l = r[3] || "0",
          u = r[4] || "0",
          c = t.includePrerelease && r[5] ? `-${r[5]}` : "",
          h = t.includePrerelease && r[6] ? `+${r[6]}` : "";
        return s(`${a}.${l}.${u}${c}${h}`, t);
      };
    },
    77249: (e, t, r) => {
      "use strict";
      var n;
      (Object.defineProperty(t, "__esModule", { value: !0 }), (t.Strategy = t.Operator = void 0));
      let s = r(35139),
        i = r(52735),
        o = r(10663);
      !(function (e) {
        ((e.IN = "IN"),
          (e.NOT_IN = "NOT_IN"),
          (e.STR_ENDS_WITH = "STR_ENDS_WITH"),
          (e.STR_STARTS_WITH = "STR_STARTS_WITH"),
          (e.STR_CONTAINS = "STR_CONTAINS"),
          (e.NUM_EQ = "NUM_EQ"),
          (e.NUM_GT = "NUM_GT"),
          (e.NUM_GTE = "NUM_GTE"),
          (e.NUM_LT = "NUM_LT"),
          (e.NUM_LTE = "NUM_LTE"),
          (e.DATE_AFTER = "DATE_AFTER"),
          (e.DATE_BEFORE = "DATE_BEFORE"),
          (e.SEMVER_EQ = "SEMVER_EQ"),
          (e.SEMVER_GT = "SEMVER_GT"),
          (e.SEMVER_LT = "SEMVER_LT"));
      })(n || (t.Operator = n = {}));
      let a = (e) => e.filter((e) => !!e).map((e) => e.trim()),
        l = (e, t) => {
          let r = e.contextName,
            s = a(e.values),
            o = (0, i.resolveContextValue)(t, r),
            l = s.some((e) => e === o);
          return e.operator === n.IN ? l : !l;
        },
        u = (e, t) => {
          let { contextName: r, operator: s, caseInsensitive: o } = e,
            l = a(e.values),
            u = (0, i.resolveContextValue)(t, r);
          return (
            o && ((l = l.map((e) => e.toLocaleLowerCase())), (u = u?.toLocaleLowerCase())),
            "string" == typeof u &&
              (s === n.STR_STARTS_WITH
                ? l.some((e) => u?.startsWith(e))
                : s === n.STR_ENDS_WITH
                  ? l.some((e) => u?.endsWith(e))
                  : s === n.STR_CONTAINS && l.some((e) => u?.includes(e)))
          );
        },
        c = (e, t) => {
          let { contextName: r, operator: o } = e,
            a = e.value,
            l = (0, i.resolveContextValue)(t, r);
          if (!l || !((e) => (0, s.clean)(e) === e)(l)) {
            return !1;
          }
          try {
            if (o === n.SEMVER_EQ) {
              return (0, s.eq)(l, a);
            }
            if (o === n.SEMVER_LT) {
              return (0, s.lt)(l, a);
            }
            if (o === n.SEMVER_GT) {
              return (0, s.gt)(l, a);
            }
          } catch (e) {}
          return !1;
        },
        h = (e, t) => {
          let { operator: r } = e,
            s = new Date(e.value),
            i = t.currentTime ? new Date(t.currentTime) : new Date();
          return r === n.DATE_AFTER ? i > s : r === n.DATE_BEFORE && i < s;
        },
        d = (e, t) => {
          let r = e.contextName,
            { operator: s } = e,
            o = Number(e.value),
            a = Number((0, i.resolveContextValue)(t, r));
          return (
            !(Number.isNaN(o) || Number.isNaN(a)) &&
            (s === n.NUM_EQ
              ? a === o
              : s === n.NUM_GT
                ? a > o
                : s === n.NUM_GTE
                  ? a >= o
                  : s === n.NUM_LT
                    ? a < o
                    : s === n.NUM_LTE && a <= o)
          );
        },
        f = new Map();
      (f.set(n.IN, l),
        f.set(n.NOT_IN, l),
        f.set(n.STR_STARTS_WITH, u),
        f.set(n.STR_ENDS_WITH, u),
        f.set(n.STR_CONTAINS, u),
        f.set(n.NUM_EQ, d),
        f.set(n.NUM_LT, d),
        f.set(n.NUM_LTE, d),
        f.set(n.NUM_GT, d),
        f.set(n.NUM_GTE, d),
        f.set(n.DATE_AFTER, h),
        f.set(n.DATE_BEFORE, h),
        f.set(n.SEMVER_EQ, c),
        f.set(n.SEMVER_GT, c),
        f.set(n.SEMVER_LT, c));
      class p {
        name;
        returnValue;
        constructor(e, t = !1) {
          ((this.name = e || "unknown"), (this.returnValue = t));
        }
        checkConstraint(e, t) {
          let r = f.get(e.operator);
          return !!r && (e.inverted ? !r(e, t) : r(e, t));
        }
        checkConstraints(e, t) {
          if (!t) {
            return !0;
          }
          for (let r of t) {
            if (!r || !this.checkConstraint(r, e)) return !1;
          }
          return !0;
        }
        isEnabled(e, t) {
          return this.returnValue;
        }
        isEnabledWithConstraints(e, t, r) {
          return this.checkConstraints(t, r) && this.isEnabled(e, t);
        }
        getResult(e, t, r, n) {
          let s = this.isEnabledWithConstraints(e, t, r);
          if (s && Array.isArray(n) && n.length > 0) {
            let r = n[0].stickiness || e.stickiness,
              s = (0, o.selectVariantDefinition)(e.groupId, r, n, t);
            return s
              ? { enabled: !0, variant: { name: s.name, enabled: !0, payload: s.payload } }
              : { enabled: !0 };
          }
          return s ? { enabled: !0 } : { enabled: !1 };
        }
      }
      t.Strategy = p;
    },
    78706: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => n(t, e, r);
    },
    78769: (e, t, r) => {
      let n = r(6994);
      e.exports = (e, t, r) => 0 === n(e, t, r);
    },
    80160: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.defaultStrategies = t.Strategy = void 0));
      let s = n(r(87325)),
        i = n(r(1050)),
        o = n(r(66794)),
        a = n(r(87020)),
        l = n(r(81775)),
        u = n(r(87130)),
        c = n(r(64138)),
        h = n(r(38503));
      var d = r(77249);
      (Object.defineProperty(t, "Strategy", {
        enumerable: !0,
        get: function () {
          return d.Strategy;
        },
      }),
        (t.defaultStrategies = [
          new s.default(),
          new i.default(),
          new o.default(),
          new a.default(),
          new l.default(),
          new u.default(),
          new c.default(),
          new h.default(),
        ]));
    },
    81775: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      Object.defineProperty(t, "__esModule", { value: !0 });
      let s = r(77249),
        i = n(r(70250));
      class o extends s.Strategy {
        constructor() {
          super("gradualRolloutSessionId");
        }
        isEnabled(e, t) {
          let { sessionId: r } = t;
          if (!r) {
            return !1;
          }
          let n = Number(e.percentage),
            s = e.groupId || "",
            o = (0, i.default)(r, s);
          return n > 0 && o <= n;
        }
      }
      t.default = o;
    },
    82478: (e) => {
      e.exports = {
        MAX_LENGTH: 256,
        MAX_SAFE_COMPONENT_LENGTH: 16,
        MAX_SAFE_BUILD_LENGTH: 250,
        MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER || 0x1fffffffffffff,
        RELEASE_TYPES: [
          "major",
          "premajor",
          "minor",
          "preminor",
          "patch",
          "prepatch",
          "prerelease",
        ],
        SEMVER_SPEC_VERSION: "2.0.0",
        FLAG_INCLUDE_PRERELEASE: 1,
        FLAG_LOOSE: 2,
      };
    },
    84390: (e, t, r) => {
      let n = r(4093),
        s = r(8916),
        { ANY: i } = s,
        o = r(69412),
        a = r(6994),
        l = [new s(">=0.0.0-0")],
        u = [new s(">=0.0.0")],
        c = (e, t, r) => {
          let n, s, c, f, p, g, m;
          if (e === t) {
            return !0;
          }
          if (1 === e.length && e[0].semver === i) {
            if (1 === t.length && t[0].semver === i) return !0;
            else e = r.includePrerelease ? l : u;
          }
          if (1 === t.length && t[0].semver === i) {
            if (r.includePrerelease) return !0;
            else t = u;
          }
          let v = new Set();
          for (let t of e) {
            ">" === t.operator || ">=" === t.operator
              ? (n = h(n, t, r))
              : "<" === t.operator || "<=" === t.operator
                ? (s = d(s, t, r))
                : v.add(t.semver);
          }
          if (v.size > 1) {
            return null;
          }
          if (
            n &&
            s &&
            ((c = a(n.semver, s.semver, r)) > 0 ||
              (0 === c && (">=" !== n.operator || "<=" !== s.operator)))
          ) {
            return null;
          }
          for (let e of v) {
            if ((n && !o(e, String(n), r)) || (s && !o(e, String(s), r))) {
              return null;
            }
            for (let n of t) {
              if (!o(e, String(n), r)) return !1;
            }
            return !0;
          }
          let E = !!s && !r.includePrerelease && !!s.semver.prerelease.length && s.semver,
            b = !!n && !r.includePrerelease && !!n.semver.prerelease.length && n.semver;
          for (let e of (E &&
            1 === E.prerelease.length &&
            "<" === s.operator &&
            0 === E.prerelease[0] &&
            (E = !1),
          t)) {
            if (
              ((m = m || ">" === e.operator || ">=" === e.operator),
              (g = g || "<" === e.operator || "<=" === e.operator),
              n)
            ) {
              if (
                (b &&
                  e.semver.prerelease &&
                  e.semver.prerelease.length &&
                  e.semver.major === b.major &&
                  e.semver.minor === b.minor &&
                  e.semver.patch === b.patch &&
                  (b = !1),
                ">" === e.operator || ">=" === e.operator)
              ) {
                if ((f = h(n, e, r)) === e && f !== n) {
                  return !1;
                }
              } else if (">=" === n.operator && !o(n.semver, String(e), r)) {
                return !1;
              }
            }
            if (s) {
              if (
                (E &&
                  e.semver.prerelease &&
                  e.semver.prerelease.length &&
                  e.semver.major === E.major &&
                  e.semver.minor === E.minor &&
                  e.semver.patch === E.patch &&
                  (E = !1),
                "<" === e.operator || "<=" === e.operator)
              ) {
                if ((p = d(s, e, r)) === e && p !== s) {
                  return !1;
                }
              } else if ("<=" === s.operator && !o(s.semver, String(e), r)) {
                return !1;
              }
            }
            if (!e.operator && (s || n) && 0 !== c) {
              return !1;
            }
          }
          return (!n || !g || !!s || 0 === c) && (!s || !m || !!n || 0 === c) && !b && !E && !0;
        },
        h = (e, t, r) => {
          if (!e) {
            return t;
          }
          let n = a(e.semver, t.semver, r);
          return n > 0 ? e : n < 0 || (">" === t.operator && ">=" === e.operator) ? t : e;
        },
        d = (e, t, r) => {
          if (!e) {
            return t;
          }
          let n = a(e.semver, t.semver, r);
          return n < 0 ? e : n > 0 || ("<" === t.operator && "<=" === e.operator) ? t : e;
        };
      e.exports = (e, t, r = {}) => {
        if (e === t) {
          return !0;
        }
        ((e = new n(e, r)), (t = new n(t, r)));
        let s = !1;
        e: for (let n of e.set) {
          for (let e of t.set) {
            let t = c(n, e, r);
            if (((s = s || null !== t), t)) {
              continue e;
            }
          }
          if (s) {
            return !1;
          }
        }
        return !0;
      };
    },
    86347: (e, t, r) => {
      let n = r(2319);
      e.exports = (e, t, r) => n(e, t, ">", r);
    },
    87020: function (e, t, r) {
      "use strict";
      var n =
        (this && this.__importDefault) ||
        function (e) {
          return e && e.__esModule ? e : { default: e };
        };
      Object.defineProperty(t, "__esModule", { value: !0 });
      let s = r(77249),
        i = n(r(70250));
      class o extends s.Strategy {
        constructor() {
          super("gradualRolloutUserId");
        }
        isEnabled(e, t) {
          let { userId: r } = t;
          if (!r) {
            return !1;
          }
          let n = Number(e.percentage),
            s = e.groupId || "",
            o = (0, i.default)(r, s);
          return n > 0 && o <= n;
        }
      }
      t.default = o;
    },
    87130: (e, t, r) => {
      "use strict";
      Object.defineProperty(t, "__esModule", { value: !0 });
      let n = r(77249);
      class s extends n.Strategy {
        constructor() {
          super("userWithId");
        }
        isEnabled(e, t) {
          return (e.userIds ? e.userIds.split(/\s*,\s*/) : []).includes(t.userId);
        }
      }
      t.default = s;
    },
    87323: (e, t, r) => {
      "use strict";
      var n = r(40459);
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        (t.removeTrailingSlash =
          t.getDefaultServerConfig =
          t.getDefaultClientConfig =
          t.getServerBaseUrl =
          t.randomSessionId =
          t.safeCompare =
            void 0),
        (t.safeCompare = (e, t) => {
          let r = String(e),
            n = String(t),
            s = r.length,
            i = 0;
          s !== n.length && ((n = r), (i = 1));
          for (let e = 0; e < s; e++) {
            i |= r.charCodeAt(e) ^ n.charCodeAt(e);
          }
          return 0 === i;
        }),
        (t.randomSessionId = () => `${Math.floor(1e9 * Math.random())}`));
      let s = () => {
        n.env.NEXT_PUBLIC_UNLEASH_SERVER_API_TOKEN &&
          console.warn(
            "You are trying to set `NEXT_PUBLIC_UNLEASH_SERVER_API_TOKEN`. Server keys shouldn't be public. Use frontend keys or skip `NEXT_PUBLIC_ prefix.",
          );
      };
      ((t.getServerBaseUrl = () =>
        n.env.UNLEASH_SERVER_API_URL || n.env.NEXT_PUBLIC_UNLEASH_SERVER_API_URL),
        (t.getDefaultClientConfig = () => (
          s(),
          {
            url:
              n.env.UNLEASH_FRONTEND_API_URL ||
              "https://us.app.unleash-hosted.com/usnn0082/api/frontend/",
            appName: n.env.UNLEASH_APP_NAME || n.env.NEXT_PUBLIC_UNLEASH_APP_NAME || "nextjs",
            clientKey:
              n.env.UNLEASH_FRONTEND_API_TOKEN ||
              "*:production.b333a8d3153c52896cd1859fe3229657e94c406ecc595569ec8f7818",
          }
        )),
        (t.getDefaultServerConfig = () => (
          s(),
          {
            url: (0, t.getServerBaseUrl)() || "http://localhost:4242/api",
            appName: n.env.UNLEASH_APP_NAME || n.env.NEXT_PUBLIC_UNLEASH_APP_NAME || "nextjs",
            clientKey:
              n.env.UNLEASH_SERVER_API_TOKEN ||
              "default:development.unleash-insecure-server-api-token",
          }
        )),
        (t.removeTrailingSlash = (e) => e?.replace(/\/$/, "")));
    },
    87325: (e, t, r) => {
      "use strict";
      Object.defineProperty(t, "__esModule", { value: !0 });
      let n = r(77249);
      class s extends n.Strategy {
        constructor() {
          super("default");
        }
        isEnabled() {
          return !0;
        }
      }
      t.default = s;
    },
    87420: (e, t, r) => {
      let n = r(49420),
        s = r(4093);
      e.exports = (e, t, r) => {
        let i = null,
          o = null,
          a = null;
        try {
          a = new s(t, r);
        } catch (e) {
          return null;
        }
        return (
          e.forEach((e) => {
            a.test(e) && (!i || 1 === o.compare(e)) && (o = new n((i = e), r));
          }),
          i
        );
      };
    },
    88955: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t) => new n(e, t).patch;
    },
    90314: (e, t, r) => {
      e.exports = r(12752);
    },
    90615: (e, t, r) => {
      let n = r(69412),
        s = r(6994);
      e.exports = (e, t, r) => {
        let i = [],
          o = null,
          a = null,
          l = e.toSorted((e, t) => s(e, t, r));
        for (let e of l) {
          n(e, t, r) ? ((a = e), o || (o = e)) : (a && i.push([o, a]), (a = null), (o = null));
        }
        o && i.push([o, null]);
        let u = [];
        for (let [e, t] of i) {
          e === t
            ? u.push(e)
            : t || e !== l[0]
              ? t
                ? e === l[0]
                  ? u.push(`<=${t}`)
                  : u.push(`${e} - ${t}`)
                : u.push(`>=${e}`)
              : u.push("*");
        }
        let c = u.join(" || "),
          h = "string" == typeof t.raw ? t.raw : String(t);
        return c.length < h.length ? c : t;
      };
    },
    93592: (e, t, r) => {
      let { MAX_SAFE_COMPONENT_LENGTH: n, MAX_SAFE_BUILD_LENGTH: s, MAX_LENGTH: i } = r(82478),
        o = r(66512),
        a = ((t = e.exports = {}).re = []),
        l = (t.safeRe = []),
        u = (t.src = []),
        c = (t.t = {}),
        h = 0,
        d = "[a-zA-Z0-9-]",
        f = [
          ["\\s", 1],
          ["\\d", i],
          [d, s],
        ],
        p = (e, t, r) => {
          let n = ((e) => {
              for (let [t, r] of f) {
                e = e.split(`${t}*`).join(`${t}{0,${r}}`).split(`${t}+`).join(`${t}{1,${r}}`);
              }
              return e;
            })(t),
            s = h++;
          (o(e, s, t),
            (c[e] = s),
            (u[s] = t),
            (a[s] = new RegExp(t, r ? "g" : void 0)),
            (l[s] = new RegExp(n, r ? "g" : void 0)));
        };
      (p("NUMERICIDENTIFIER", "0|[1-9]\\d*"),
        p("NUMERICIDENTIFIERLOOSE", "\\d+"),
        p("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${d}*`),
        p(
          "MAINVERSION",
          `(${u[c.NUMERICIDENTIFIER]})\\.(${u[c.NUMERICIDENTIFIER]})\\.(${u[c.NUMERICIDENTIFIER]})`,
        ),
        p(
          "MAINVERSIONLOOSE",
          `(${u[c.NUMERICIDENTIFIERLOOSE]})\\.(${u[c.NUMERICIDENTIFIERLOOSE]})\\.(${u[c.NUMERICIDENTIFIERLOOSE]})`,
        ),
        p("PRERELEASEIDENTIFIER", `(?:${u[c.NUMERICIDENTIFIER]}|${u[c.NONNUMERICIDENTIFIER]})`),
        p(
          "PRERELEASEIDENTIFIERLOOSE",
          `(?:${u[c.NUMERICIDENTIFIERLOOSE]}|${u[c.NONNUMERICIDENTIFIER]})`,
        ),
        p("PRERELEASE", `(?:-(${u[c.PRERELEASEIDENTIFIER]}(?:\\.${u[c.PRERELEASEIDENTIFIER]})*))`),
        p(
          "PRERELEASELOOSE",
          `(?:-?(${u[c.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${u[c.PRERELEASEIDENTIFIERLOOSE]})*))`,
        ),
        p("BUILDIDENTIFIER", `${d}+`),
        p("BUILD", `(?:\\+(${u[c.BUILDIDENTIFIER]}(?:\\.${u[c.BUILDIDENTIFIER]})*))`),
        p("FULLPLAIN", `v?${u[c.MAINVERSION]}${u[c.PRERELEASE]}?${u[c.BUILD]}?`),
        p("FULL", `^${u[c.FULLPLAIN]}$`),
        p("LOOSEPLAIN", `[v=\\s]*${u[c.MAINVERSIONLOOSE]}${u[c.PRERELEASELOOSE]}?${u[c.BUILD]}?`),
        p("LOOSE", `^${u[c.LOOSEPLAIN]}$`),
        p("GTLT", "((?:<|>)?=?)"),
        p("XRANGEIDENTIFIERLOOSE", `${u[c.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`),
        p("XRANGEIDENTIFIER", `${u[c.NUMERICIDENTIFIER]}|x|X|\\*`),
        p(
          "XRANGEPLAIN",
          `[v=\\s]*(${u[c.XRANGEIDENTIFIER]})(?:\\.(${u[c.XRANGEIDENTIFIER]})(?:\\.(${u[c.XRANGEIDENTIFIER]})(?:${u[c.PRERELEASE]})?${u[c.BUILD]}?)?)?`,
        ),
        p(
          "XRANGEPLAINLOOSE",
          `[v=\\s]*(${u[c.XRANGEIDENTIFIERLOOSE]})(?:\\.(${u[c.XRANGEIDENTIFIERLOOSE]})(?:\\.(${u[c.XRANGEIDENTIFIERLOOSE]})(?:${u[c.PRERELEASELOOSE]})?${u[c.BUILD]}?)?)?`,
        ),
        p("XRANGE", `^${u[c.GTLT]}\\s*${u[c.XRANGEPLAIN]}$`),
        p("XRANGELOOSE", `^${u[c.GTLT]}\\s*${u[c.XRANGEPLAINLOOSE]}$`),
        p("COERCEPLAIN", `(^|[^\\d])(\\d{1,${n}})(?:\\.(\\d{1,${n}}))?(?:\\.(\\d{1,${n}}))?`),
        p("COERCE", `${u[c.COERCEPLAIN]}(?:$|[^\\d])`),
        p(
          "COERCEFULL",
          u[c.COERCEPLAIN] + `(?:${u[c.PRERELEASE]})?` + `(?:${u[c.BUILD]})?` + "(?:$|[^\\d])",
        ),
        p("COERCERTL", u[c.COERCE], !0),
        p("COERCERTLFULL", u[c.COERCEFULL], !0),
        p("LONETILDE", "(?:~>?)"),
        p("TILDETRIM", `(\\s*)${u[c.LONETILDE]}\\s+`, !0),
        (t.tildeTrimReplace = "$1~"),
        p("TILDE", `^${u[c.LONETILDE]}${u[c.XRANGEPLAIN]}$`),
        p("TILDELOOSE", `^${u[c.LONETILDE]}${u[c.XRANGEPLAINLOOSE]}$`),
        p("LONECARET", "(?:\\^)"),
        p("CARETTRIM", `(\\s*)${u[c.LONECARET]}\\s+`, !0),
        (t.caretTrimReplace = "$1^"),
        p("CARET", `^${u[c.LONECARET]}${u[c.XRANGEPLAIN]}$`),
        p("CARETLOOSE", `^${u[c.LONECARET]}${u[c.XRANGEPLAINLOOSE]}$`),
        p("COMPARATORLOOSE", `^${u[c.GTLT]}\\s*(${u[c.LOOSEPLAIN]})$|^$`),
        p("COMPARATOR", `^${u[c.GTLT]}\\s*(${u[c.FULLPLAIN]})$|^$`),
        p("COMPARATORTRIM", `(\\s*)${u[c.GTLT]}\\s*(${u[c.LOOSEPLAIN]}|${u[c.XRANGEPLAIN]})`, !0),
        (t.comparatorTrimReplace = "$1$2$3"),
        p("HYPHENRANGE", `^\\s*(${u[c.XRANGEPLAIN]})\\s+-\\s+(${u[c.XRANGEPLAIN]})\\s*$`),
        p(
          "HYPHENRANGELOOSE",
          `^\\s*(${u[c.XRANGEPLAINLOOSE]})\\s+-\\s+(${u[c.XRANGEPLAINLOOSE]})\\s*$`,
        ),
        p("STAR", "(<|>)?=?\\s*\\*"),
        p("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$"),
        p("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$"));
    },
    96659: (e, t, r) => {
      let n = r(98851);
      e.exports = (e, t) => e.sort((e, r) => n(e, r, t));
    },
    96827: (e) => {
      "use strict";
      e.exports = JSON.parse(
        '{"name":"@unleash/nextjs","version":"1.6.2","description":"Unleash SDK for Next.js","main":"dist/index.js","types":"dist/index.d.ts","license":"Apache-2.0","bin":{"unleash":"./dist/cli/index.js"},"exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"},"./client":{"types":"./client.d.ts","default":"./client.js"}},"files":["dist","client.*","src"],"scripts":{"lint":"eslint src/**/*.ts* client.ts","test":"vitest run --coverage","test:dev":"vitest","build":"tsc && tsc --p tsconfig.client.json && cp ../README.md ./README.md","dev":"tsc -w"},"devDependencies":{"@types/murmurhash3js":"3.0.7","@types/node":"22.5.5","@types/react":"18.3.8","@types/react-dom":"18.3.0","@types/semver":"7.5.8","@unleash/client-specification":"5.1.9","@vitest/coverage-v8":"^2.1.1","eslint-config-custom":"*","next":"14.2.13","react":"18.3.1","react-dom":"18.3.1","typescript":"5.6.2","vite":"5.4.6","vitest":"2.1.1"},"dependencies":{"@commander-js/extra-typings":"12.1.0","@next/env":"14.2.13","@unleash/proxy-client-react":"5.0.0","commander":"12.1.0","murmurhash3js":"3.0.1","semver":"7.6.3","unleash-client":"^6.4.4","unleash-proxy-client":"^3.7.4"},"peerDependencies":{"next":">=12","react":">=17","react-dom":">=17"},"repository":{"type":"git","url":"https://github.com/Unleash/unleash-client-nextjs"},"bugs":{"url":"https://github.com/Unleash/unleash-client-nextjs/issues"},"publishConfig":{"access":"public","registry":"https://registry.npmjs.org/"}}',
      );
    },
    98851: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t, r) => {
        let s = new n(e, r),
          i = new n(t, r);
        return s.compare(i) || s.compareBuild(i);
      };
    },
    99184: (e, t, r) => {
      let n = r(99914);
      e.exports = (e, t) => {
        let r = n(e.trim().replace(/^[=v]+/, ""), t);
        return r ? r.version : null;
      };
    },
    99914: (e, t, r) => {
      let n = r(49420);
      e.exports = (e, t, r = !1) => {
        if (e instanceof n) {
          return e;
        }
        try {
          return new n(e, t);
        } catch (e) {
          if (!r) {
            return null;
          }
          throw e;
        }
      };
    },
  },
]);
