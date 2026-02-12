"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [41725],
  {
    38706: (e, t, n) => {
      n.d(t, { Zx: () => k, bv: () => w, vW: () => H, we: () => y });
      var l,
        r = n(7620),
        u = n(71003),
        o = n(55213),
        c = n(77547),
        f = n(97509),
        i = n(81543),
        s = n(48415);
      let a = { ...(l || (l = n.t(r, 2))) },
        m = a.useInsertionEffect || ((e) => e());
      function g(e) {
        let t = r.useRef(() => {});
        return (
          m(() => {
            t.current = e;
          }),
          r.useCallback(function () {
            for (var e = arguments.length, n = Array(e), l = 0; l < e; l++) {
              n[l] = arguments[l];
            }
            return null == t.current ? void 0 : t.current(...n);
          }, [])
        );
      }
      var d = "undefined" != typeof document ? r.useLayoutEffect : r.useEffect;
      let v = !1,
        p = 0,
        h = () => "floating-ui-" + Math.random().toString(36).slice(2, 6) + p++,
        C =
          a.useId ||
          function () {
            let [e, t] = r.useState(() => (v ? h() : void 0));
            return (
              d(() => {
                null == e && t(h());
              }, []),
              r.useEffect(() => {
                v = !0;
              }, []),
              e
            );
          },
        b = r.createContext(null),
        x = r.createContext(null);
      function y(e) {
        void 0 === e && (e = {});
        let { nodeId: t } = e,
          n = (function (e) {
            var t;
            let { open: n = !1, onOpenChange: l, elements: u } = e,
              o = C(),
              c = r.useRef({}),
              [f] = r.useState(() =>
                (function () {
                  let e = new Map();
                  return {
                    emit(t, n) {
                      var l;
                      null == (l = e.get(t)) || l.forEach((e) => e(n));
                    },
                    on(t, n) {
                      e.set(t, [...(e.get(t) || []), n]);
                    },
                    off(t, n) {
                      var l;
                      e.set(t, (null == (l = e.get(t)) ? void 0 : l.filter((e) => e !== n)) || []);
                    },
                  };
                })(),
              ),
              i = null != ((null == (t = r.useContext(b)) ? void 0 : t.id) || null),
              [s, a] = r.useState(u.reference),
              m = g((e, t, n) => {
                ((c.current.openEvent = e ? t : void 0),
                  f.emit("openchange", { open: e, event: t, reason: n, nested: i }),
                  null == l || l(e, t, n));
              }),
              d = r.useMemo(() => ({ setPositionReference: a }), []),
              v = r.useMemo(
                () => ({
                  reference: s || u.reference || null,
                  floating: u.floating || null,
                  domReference: u.reference,
                }),
                [s, u.reference, u.floating],
              );
            return r.useMemo(
              () => ({
                dataRef: c,
                open: n,
                onOpenChange: m,
                elements: v,
                events: f,
                floatingId: o,
                refs: d,
              }),
              [n, m, v, f, o, d],
            );
          })({ ...e, elements: { reference: null, floating: null, ...e.elements } }),
          l = e.rootContext || n,
          u = l.elements,
          [o, f] = r.useState(null),
          [s, a] = r.useState(null),
          m = (null == u ? void 0 : u.domReference) || o,
          v = r.useRef(null),
          p = r.useContext(x);
        d(() => {
          m && (v.current = m);
        }, [m]);
        let h = (0, i.we)({ ...e, elements: { ...u, ...(s && { reference: s }) } }),
          y = r.useCallback(
            (e) => {
              let t = (0, c.vq)(e)
                ? { getBoundingClientRect: () => e.getBoundingClientRect(), contextElement: e }
                : e;
              (a(t), h.refs.setReference(t));
            },
            [h.refs],
          ),
          R = r.useCallback(
            (e) => {
              (((0, c.vq)(e) || null === e) && ((v.current = e), f(e)),
                ((0, c.vq)(h.refs.reference.current) ||
                  null === h.refs.reference.current ||
                  (null !== e && !(0, c.vq)(e))) &&
                  h.refs.setReference(e));
            },
            [h.refs],
          ),
          T = r.useMemo(
            () => ({ ...h.refs, setReference: R, setPositionReference: y, domReference: v }),
            [h.refs, R, y],
          ),
          M = r.useMemo(() => ({ ...h.elements, domReference: m }), [h.elements, m]),
          w = r.useMemo(() => ({ ...h, ...l, refs: T, elements: M, nodeId: t }), [h, T, M, t, l]);
        return (
          d(() => {
            l.dataRef.current.floatingContext = w;
            let e = null == p ? void 0 : p.nodesRef.current.find((e) => e.id === t);
            e && (e.context = w);
          }),
          r.useMemo(() => ({ ...h, context: w, refs: T, elements: M }), [h, T, M, w])
        );
      }
      let R = "active",
        T = "selected";
      function M(e, t, n) {
        let l = new Map(),
          r = "item" === n,
          u = e;
        if (r && e) {
          let { [R]: t, [T]: n, ...l } = e;
          u = l;
        }
        return {
          ...("floating" === n && { tabIndex: -1, "data-floating-ui-focusable": "" }),
          ...u,
          ...t
            .map((t) => {
              let l = t ? t[n] : null;
              return "function" == typeof l ? (e ? l(e) : null) : l;
            })
            .concat(e)
            .reduce(
              (e, t) => (
                t &&
                  Object.entries(t).forEach((t) => {
                    let [n, u] = t;
                    if (!(r && [R, T].includes(n))) {
                      if (0 === n.indexOf("on")) {
                        if ((l.has(n) || l.set(n, []), "function" == typeof u)) {
                          var o;
                          (null == (o = l.get(n)) || o.push(u),
                            (e[n] = function () {
                              for (var e, t = arguments.length, r = Array(t), u = 0; u < t; u++)
                                r[u] = arguments[u];
                              return null == (e = l.get(n))
                                ? void 0
                                : e.map((e) => e(...r)).find((e) => void 0 !== e);
                            }));
                        }
                      } else e[n] = u;
                    }
                  }),
                e
              ),
              {},
            ),
        };
      }
      function w(e) {
        void 0 === e && (e = []);
        let t = e.map((e) => (null == e ? void 0 : e.reference)),
          n = e.map((e) => (null == e ? void 0 : e.floating)),
          l = e.map((e) => (null == e ? void 0 : e.item)),
          u = r.useCallback((t) => M(t, e, "reference"), t),
          o = r.useCallback((t) => M(t, e, "floating"), n),
          c = r.useCallback((t) => M(t, e, "item"), l);
        return r.useMemo(
          () => ({ getReferenceProps: u, getFloatingProps: o, getItemProps: c }),
          [u, o, c],
        );
      }
      function E(e, t) {
        return { ...e, rects: { ...e.rects, floating: { ...e.rects.floating, height: t } } };
      }
      let H = (e) => ({
        name: "inner",
        options: e,
        async fn(t) {
          let {
              listRef: n,
              overflowRef: l,
              onFallbackChange: r,
              offset: u = 0,
              index: c = 0,
              minItemsVisible: a = 4,
              referenceOverflowThreshold: m = 0,
              scrollRef: g,
              ...d
            } = (0, o._3)(e, t),
            {
              rects: v,
              elements: { floating: p },
            } = t,
            h = n.current[c],
            C = (null == g ? void 0 : g.current) || p,
            b = p.clientTop || C.clientTop,
            x = 0 !== p.clientTop,
            y = 0 !== C.clientTop,
            R = p === C;
          if (!h) {
            return {};
          }
          let T = {
              ...t,
              ...(await (0, i.cY)(
                -h.offsetTop - p.clientTop - v.reference.height / 2 - h.offsetHeight / 2 - u,
              ).fn(t)),
            },
            M = await (0, s.__)(E(T, C.scrollHeight + b + p.clientTop), d),
            w = await (0, s.__)(T, { ...d, elementContext: "reference" }),
            H = (0, o.T9)(0, M.top),
            k = T.y + H,
            _ = (C.scrollHeight > C.clientHeight ? (e) => e : o.LI)(
              (0, o.T9)(
                0,
                C.scrollHeight + ((x && R) || y ? 2 * b : 0) - H - (0, o.T9)(0, M.bottom),
              ),
            );
          if (((C.style.maxHeight = _ + "px"), (C.scrollTop = H), r)) {
            let e =
              C.offsetHeight < h.offsetHeight * (0, o.jk)(a, n.current.length) - 1 ||
              w.top >= -m ||
              w.bottom >= -m;
            f.flushSync(() => r(e));
          }
          return (
            l &&
              (l.current = await (0, s.__)(E({ ...T, y: k }, C.offsetHeight + b + p.clientTop), d)),
            { y: k }
          );
        },
      });
      function k(e, t) {
        let { open: n, elements: l } = e,
          { enabled: o = !0, overflowRef: c, scrollRef: i, onChange: s } = t,
          a = g(s),
          m = r.useRef(!1),
          d = r.useRef(null),
          v = r.useRef(null);
        r.useEffect(() => {
          if (!o) {
            return;
          }
          function e(e) {
            if (e.ctrlKey || !t || null == c.current) {
              return;
            }
            let n = e.deltaY,
              l = c.current.top >= -0.5,
              r = c.current.bottom >= -0.5,
              o = t.scrollHeight - t.clientHeight,
              i = n < 0 ? -1 : 1,
              s = n < 0 ? "max" : "min";
            !(t.scrollHeight <= t.clientHeight) &&
              ((!l && n > 0) || (!r && n < 0)
                ? (e.preventDefault(),
                  f.flushSync(() => {
                    a((e) => e + Math[s](n, o * i));
                  }))
                : /firefox/i.test((0, u.$t)()) && (t.scrollTop += n));
          }
          let t = (null == i ? void 0 : i.current) || l.floating;
          if (n && t) {
            return (
              t.addEventListener("wheel", e),
              requestAnimationFrame(() => {
                ((d.current = t.scrollTop), null != c.current && (v.current = { ...c.current }));
              }),
              () => {
                ((d.current = null), (v.current = null), t.removeEventListener("wheel", e));
              }
            );
          }
        }, [o, n, l.floating, c, i, a]);
        let p = r.useMemo(
          () => ({
            onKeyDown() {
              m.current = !0;
            },
            onWheel() {
              m.current = !1;
            },
            onPointerMove() {
              m.current = !1;
            },
            onScroll() {
              let e = (null == i ? void 0 : i.current) || l.floating;
              if (c.current && e && m.current) {
                if (null !== d.current) {
                  let t = e.scrollTop - d.current;
                  ((c.current.bottom < -0.5 && t < -1) || (c.current.top < -0.5 && t > 1)) &&
                    f.flushSync(() => a((e) => e + t));
                }
                requestAnimationFrame(() => {
                  d.current = e.scrollTop;
                });
              }
            },
          }),
          [l.floating, a, c, i],
        );
        return r.useMemo(() => (o ? { floating: p } : {}), [o, p]);
      }
    },
  },
]);
