"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [19664],
  {
    557: (e, t) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          DecodeError: function () {
            return h;
          },
          MiddlewareNotFoundError: function () {
            return b;
          },
          MissingStaticPage: function () {
            return m;
          },
          NormalizeError: function () {
            return y;
          },
          PageNotFoundError: function () {
            return g;
          },
          SP: function () {
            return p;
          },
          ST: function () {
            return d;
          },
          WEB_VITALS: function () {
            return r;
          },
          execOnce: function () {
            return n;
          },
          getDisplayName: function () {
            return l;
          },
          getLocationOrigin: function () {
            return a;
          },
          getURL: function () {
            return i;
          },
          isAbsoluteUrl: function () {
            return u;
          },
          isResSent: function () {
            return f;
          },
          loadGetInitialProps: function () {
            return s;
          },
          normalizeRepeatedSlashes: function () {
            return c;
          },
          stringifyError: function () {
            return P;
          },
        }));
      let r = ["CLS", "FCP", "FID", "INP", "LCP", "TTFB"];
      function n(e) {
        let t,
          r = !1;
        return function () {
          for (var n = arguments.length, o = Array(n), u = 0; u < n; u++) {
            o[u] = arguments[u];
          }
          return (r || ((r = !0), (t = e(...o))), t);
        };
      }
      let o = /^[a-zA-Z][a-zA-Z\d+\-.]*?:/,
        u = (e) => o.test(e);
      function a() {
        let { protocol: e, hostname: t, port: r } = window.location;
        return e + "//" + t + (r ? ":" + r : "");
      }
      function i() {
        let { href: e } = window.location,
          t = a();
        return e.substring(t.length);
      }
      function l(e) {
        return "string" == typeof e ? e : e.displayName || e.name || "Unknown";
      }
      function f(e) {
        return e.finished || e.headersSent;
      }
      function c(e) {
        let t = e.split("?");
        return (
          t[0].replace(/\\/g, "/").replace(/\/\/+/g, "/") + (t[1] ? "?" + t.slice(1).join("?") : "")
        );
      }
      async function s(e, t) {
        let r = t.res || (t.ctx && t.ctx.res);
        if (!e.getInitialProps) {
          return t.ctx && t.Component ? { pageProps: await s(t.Component, t.ctx) } : {};
        }
        let n = await e.getInitialProps(t);
        if (r && f(r)) {
          return n;
        }
        if (!n) {
          throw Object.defineProperty(
            Error(
              '"' +
                l(e) +
                '.getInitialProps()" should resolve to an object. But found "' +
                n +
                '" instead.',
            ),
            "__NEXT_ERROR_CODE",
            { value: "E394", enumerable: !1, configurable: !0 },
          );
        }
        return n;
      }
      let p = "undefined" != typeof performance,
        d =
          p &&
          ["mark", "measure", "getEntriesByName"].every((e) => "function" == typeof performance[e]);
      class h extends Error {}
      class y extends Error {}
      class g extends Error {
        constructor(e) {
          (super(),
            (this.code = "ENOENT"),
            (this.name = "PageNotFoundError"),
            (this.message = "Cannot find module for page: " + e));
        }
      }
      class m extends Error {
        constructor(e, t) {
          (super(), (this.message = "Failed to load static file for page: " + e + " " + t));
        }
      }
      class b extends Error {
        constructor() {
          (super(), (this.code = "ENOENT"), (this.message = "Cannot find the middleware module"));
        }
      }
      function P(e) {
        return JSON.stringify({ message: e.message, stack: e.stack });
      }
    },
    19664: (e, t, r) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          default: function () {
            return g;
          },
          useLinkStatus: function () {
            return b;
          },
        }));
      let n = r(24045),
        o = r(54568),
        u = n._(r(7620)),
        a = r(35015),
        i = r(36329),
        l = r(47424),
        f = r(557),
        c = r(54539);
      r(50560);
      let s = r(67168),
        p = r(66410),
        d = r(2064);
      r(62502);
      let h = r(70915);
      function y(e) {
        return "string" == typeof e ? e : (0, a.formatUrl)(e);
      }
      function g(e) {
        var t;
        let r,
          n,
          a,
          [g, b] = (0, u.useOptimistic)(s.IDLE_LINK_STATUS),
          P = (0, u.useRef)(null),
          {
            href: _,
            as: v,
            children: E,
            prefetch: O = null,
            passHref: j,
            replace: S,
            shallow: C,
            scroll: N,
            onClick: T,
            onMouseEnter: x,
            onTouchStart: A,
            legacyBehavior: M = !1,
            onNavigate: R,
            ref: L,
            unstable_dynamicOnHover: k,
            ...I
          } = e;
        ((r = E),
          M &&
            ("string" == typeof r || "number" == typeof r) &&
            (r = (0, o.jsx)("a", { children: r })));
        let U = u.default.useContext(i.AppRouterContext),
          w = !1 !== O,
          F =
            !1 !== O
              ? null === (t = O) || "auto" === t
                ? h.FetchStrategy.PPR
                : h.FetchStrategy.Full
              : h.FetchStrategy.PPR,
          { href: D, as: K } = u.default.useMemo(() => {
            let e = y(_);
            return { href: e, as: v ? y(v) : e };
          }, [_, v]);
        M && (n = u.default.Children.only(r));
        let B = M ? n && "object" == typeof n && n.ref : L,
          z = u.default.useCallback(
            (e) => (
              null !== U && (P.current = (0, s.mountLinkInstance)(e, D, U, F, w, b)),
              () => {
                (P.current &&
                  ((0, s.unmountLinkForCurrentNavigation)(P.current), (P.current = null)),
                  (0, s.unmountPrefetchableInstance)(e));
              }
            ),
            [w, D, U, F, b],
          ),
          Q = {
            ref: (0, l.useMergedRef)(z, B),
            onClick(e) {
              (M || "function" != typeof T || T(e),
                M && n.props && "function" == typeof n.props.onClick && n.props.onClick(e),
                U &&
                  (e.defaultPrevented ||
                    (function (e, t, r, n, o, a, i) {
                      let { nodeName: l } = e.currentTarget;
                      if (
                        !(
                          ("A" === l.toUpperCase() &&
                            (function (e) {
                              let t = e.currentTarget.getAttribute("target");
                              return (
                                (t && "_self" !== t) ||
                                e.metaKey ||
                                e.ctrlKey ||
                                e.shiftKey ||
                                e.altKey ||
                                (e.nativeEvent && 2 === e.nativeEvent.which)
                              );
                            })(e)) ||
                          e.currentTarget.hasAttribute("download")
                        )
                      ) {
                        if (!(0, p.isLocalURL)(t)) {
                          o && (e.preventDefault(), location.replace(t));
                          return;
                        }
                        if ((e.preventDefault(), i)) {
                          let e = !1;
                          if (
                            (i({
                              preventDefault: () => {
                                e = !0;
                              },
                            }),
                            e)
                          ) {
                            return;
                          }
                        }
                        u.default.startTransition(() => {
                          (0, d.dispatchNavigateAction)(
                            r || t,
                            o ? "replace" : "push",
                            null == a || a,
                            n.current,
                          );
                        });
                      }
                    })(e, D, K, P, S, N, R)));
            },
            onMouseEnter(e) {
              (M || "function" != typeof x || x(e),
                M &&
                  n.props &&
                  "function" == typeof n.props.onMouseEnter &&
                  n.props.onMouseEnter(e),
                U && w && (0, s.onNavigationIntent)(e.currentTarget, !0 === k));
            },
            onTouchStart: function (e) {
              (M || "function" != typeof A || A(e),
                M &&
                  n.props &&
                  "function" == typeof n.props.onTouchStart &&
                  n.props.onTouchStart(e),
                U && w && (0, s.onNavigationIntent)(e.currentTarget, !0 === k));
            },
          };
        return (
          (0, f.isAbsoluteUrl)(K)
            ? (Q.href = K)
            : (M && !j && ("a" !== n.type || "href" in n.props)) ||
              (Q.href = (0, c.addBasePath)(K)),
          (a = M ? u.default.cloneElement(n, Q) : (0, o.jsx)("a", { ...I, ...Q, children: r })),
          (0, o.jsx)(m.Provider, { value: g, children: a })
        );
      }
      let m = (0, u.createContext)(s.IDLE_LINK_STATUS),
        b = () => (0, u.useContext)(m);
      ("function" == typeof t.default || ("object" == typeof t.default && null !== t.default)) &&
        void 0 === t.default.__esModule &&
        (Object.defineProperty(t.default, "__esModule", { value: !0 }),
        Object.assign(t.default, t),
        (e.exports = t.default));
    },
    35015: (e, t, r) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          formatUrl: function () {
            return u;
          },
          formatWithValidation: function () {
            return i;
          },
          urlObjectKeys: function () {
            return a;
          },
        }));
      let n = r(24045)._(r(86437)),
        o = /https?|ftp|gopher|file/;
      function u(e) {
        let { auth: t, hostname: r } = e,
          u = e.protocol || "",
          a = e.pathname || "",
          i = e.hash || "",
          l = e.query || "",
          f = !1;
        ((t = t ? encodeURIComponent(t).replace(/%3A/i, ":") + "@" : ""),
          e.host
            ? (f = t + e.host)
            : r && ((f = t + (~r.indexOf(":") ? "[" + r + "]" : r)), e.port && (f += ":" + e.port)),
          l && "object" == typeof l && (l = String(n.urlQueryToSearchParams(l))));
        let c = e.search || (l && "?" + l) || "";
        return (
          u && !u.endsWith(":") && (u += ":"),
          e.slashes || ((!u || o.test(u)) && !1 !== f)
            ? ((f = "//" + (f || "")), a && "/" !== a[0] && (a = "/" + a))
            : f || (f = ""),
          i && "#" !== i[0] && (i = "#" + i),
          c && "?" !== c[0] && (c = "?" + c),
          "" +
            u +
            f +
            (a = a.replace(/[?#]/g, encodeURIComponent)) +
            (c = c.replace("#", "%23")) +
            i
        );
      }
      let a = [
        "auth",
        "hash",
        "host",
        "hostname",
        "href",
        "path",
        "pathname",
        "port",
        "protocol",
        "query",
        "search",
        "slashes",
      ];
      function i(e) {
        return u(e);
      }
    },
    47424: (e, t, r) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        Object.defineProperty(t, "useMergedRef", {
          enumerable: !0,
          get: function () {
            return o;
          },
        }));
      let n = r(7620);
      function o(e, t) {
        let r = (0, n.useRef)(null),
          o = (0, n.useRef)(null);
        return (0, n.useCallback)(
          (n) => {
            if (null === n) {
              let e = r.current;
              e && ((r.current = null), e());
              let t = o.current;
              t && ((o.current = null), t());
            } else {
              (e && (r.current = u(e, n)), t && (o.current = u(t, n)));
            }
          },
          [e, t],
        );
      }
      function u(e, t) {
        if ("function" != typeof e) {
          return (
            (e.current = t),
            () => {
              e.current = null;
            }
          );
        }
        {
          let r = e(t);
          return "function" == typeof r ? r : () => e(null);
        }
      }
      ("function" == typeof t.default || ("object" == typeof t.default && null !== t.default)) &&
        void 0 === t.default.__esModule &&
        (Object.defineProperty(t.default, "__esModule", { value: !0 }),
        Object.assign(t.default, t),
        (e.exports = t.default));
    },
    62502: (e, t) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        Object.defineProperty(t, "errorOnce", {
          enumerable: !0,
          get: function () {
            return r;
          },
        }));
      let r = (e) => {};
    },
    66410: (e, t, r) => {
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        Object.defineProperty(t, "isLocalURL", {
          enumerable: !0,
          get: function () {
            return u;
          },
        }));
      let n = r(557),
        o = r(94540);
      function u(e) {
        if (!(0, n.isAbsoluteUrl)(e)) {
          return !0;
        }
        try {
          let t = (0, n.getLocationOrigin)(),
            r = new URL(e, t);
          return r.origin === t && (0, o.hasBasePath)(r.pathname);
        } catch (e) {
          return !1;
        }
      }
    },
    86437: (e, t) => {
      function r(e) {
        let t = {};
        for (let [r, n] of e.entries()) {
          let e = t[r];
          void 0 === e ? (t[r] = n) : Array.isArray(e) ? e.push(n) : (t[r] = [e, n]);
        }
        return t;
      }
      function n(e) {
        return "string" == typeof e
          ? e
          : ("number" != typeof e || isNaN(e)) && "boolean" != typeof e
            ? ""
            : String(e);
      }
      function o(e) {
        let t = new URLSearchParams();
        for (let [r, o] of Object.entries(e)) {
          if (Array.isArray(o)) for (let e of o) t.append(r, n(e));
          else t.set(r, n(o));
        }
        return t;
      }
      function u(e) {
        for (var t = arguments.length, r = Array(t > 1 ? t - 1 : 0), n = 1; n < t; n++) {
          r[n - 1] = arguments[n];
        }
        for (let t of r) {
          for (let r of t.keys()) {
            e.delete(r);
          }
          for (let [r, n] of t.entries()) {
            e.append(r, n);
          }
        }
        return e;
      }
      (Object.defineProperty(t, "__esModule", { value: !0 }),
        !(function (e, t) {
          for (var r in t) {
            Object.defineProperty(e, r, { enumerable: !0, get: t[r] });
          }
        })(t, {
          assign: function () {
            return u;
          },
          searchParamsToUrlQuery: function () {
            return r;
          },
          urlQueryToSearchParams: function () {
            return o;
          },
        }));
    },
  },
]);
