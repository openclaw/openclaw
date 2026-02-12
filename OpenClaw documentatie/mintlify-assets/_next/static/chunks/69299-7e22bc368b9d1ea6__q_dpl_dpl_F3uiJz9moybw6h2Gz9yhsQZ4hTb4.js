"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [69299],
  {
    22904: (e, t, r) => {
      r.d(t, { Gq: () => a, SO: () => n });
      let a = (e) => {
          try {
            return window.localStorage.getItem(e);
          } catch {
            return null;
          }
        },
        n = (e, t) => {
          try {
            window.localStorage.setItem(e, t);
          } catch {}
        };
    },
    35021: (e, t, r) => {
      r.d(t, { C: () => i, ColorVariables: () => o });
      var a = r(54568),
        n = r(10897),
        l = r(7620),
        s = r(71252);
      function i(e) {
        let t = e?.colors.primary ?? "#16A34A",
          r = e?.colors.light ?? "#4ADE80",
          a = e?.colors.dark ?? "#166534",
          l = e?.colors.primary,
          s = e?.colors.primary;
        return (
          e?.theme === "linden" &&
            (e.background = {
              ...e.background,
              color: {
                light: e.background?.color?.light || (0, n.Ob)((0, n._x)("#FFFFFF", 1, t, 0.03)),
                dark: e.background?.color?.dark || (0, n.Ob)((0, n._x)("#09090B", 1, r, 0.03)),
              },
            }),
          {
            primary: (0, n.N9)(t),
            primaryLight: (0, n.N9)(r),
            primaryDark: (0, n.N9)(a),
            primaryDarkForeground: ((e) => {
              let t = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(e),
                r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(e) ?? t;
              if (!r || !r[1] || !r[2] || !r[3]) {
                return !1;
              }
              let a = (e) => (1 === e.length ? e + e : e),
                n = parseInt(a(r[1]), 16),
                l = parseInt(a(r[2]), 16);
              return 0.299 * n + 0.587 * l + 0.114 * parseInt(a(r[3]), 16) > 165;
            })(a)
              ? "0 0 0"
              : "255 255 255",
            backgroundLight: (0, n.N9)(e?.background?.color?.light ?? "#ffffff"),
            backgroundDark: (0, n.ab)(r, e?.background?.color?.dark),
            anchorDefault: l,
            dropdownDefault: s,
            gray: (0, n.Eo)(t),
          }
        );
      }
      function o({ docsConfig: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, l.useContext)(s.K),
          n = r(),
          o = i(t && n ? { ...e, ...n } : e),
          c = `:root {
    --primary: ${o.primary};
    --primary-light: ${o.primaryLight};
    --primary-dark: ${o.primaryDark};
    --tooltip-foreground: ${o.primaryDarkForeground};
    --background-light: ${o.backgroundLight};
    --background-dark: ${o.backgroundDark};
    --gray-50: ${o.gray[50]};
    --gray-100: ${o.gray[100]};
    --gray-200: ${o.gray[200]};
    --gray-300: ${o.gray[300]};
    --gray-400: ${o.gray[400]};
    --gray-500: ${o.gray[500]};
    --gray-600: ${o.gray[600]};
    --gray-700: ${o.gray[700]};
    --gray-800: ${o.gray[800]};
    --gray-900: ${o.gray[900]};
    --gray-950: ${o.gray[950]};
  }`;
        return (0, a.jsx)("style", { children: c });
      }
    },
    42080: (e, t, r) => {
      (r.r(t),
        r.d(t, {
          FooterAndSidebarScrollScript: () => p,
          ScrollTopScript: () => m,
          handleFooterAndSidebarScrollTop: () => u,
        }));
      var a = r(54568),
        n = r(23792),
        l = r(7620),
        s = r(12192),
        i = r(71252),
        o = r(76829);
      function c(e, t, r) {
        return `(${d.toString()})(${e}, ${t}, "${r}")`;
      }
      function d(e, t, r) {
        let a = document.documentElement.getAttribute("data-banner-state"),
          n = 2.5 * !!(null != a ? "visible" === a : t),
          l = 3 * !!e,
          s = 4,
          i = n + 4 + l;
        switch (r) {
          case "mint":
          case "palm":
            break;
          case "aspen":
            ((s = 3.5), (i = n + (l = 2.5 * !!e) + s));
            break;
          case "linden":
            i = n + (s = 4);
            break;
          case "almond":
            i = n + (s = 3.5);
            break;
          case "sequoia":
            i = n + (s = 3) + (l = 3 * !!e);
        }
        return i;
      }
      let x = function (e, t, r, a) {
        var n;
        let l,
          s = "mint" === a || "linden" === a ? "sidebar" : "sidebar-content",
          i =
            ((l = "navbar-transition"),
            "maple" === (n = a) && (l += "-maple"),
            "willow" === n && (l += "-willow"),
            l),
          [o, c] = (() => {
            switch (a) {
              case "almond":
                return ["[--scroll-mt:2.5rem]", "[--scroll-mt:2.5rem]"];
              case "sequoia":
                return ["lg:[--scroll-mt:8.5rem]", "lg:[--scroll-mt:11rem]"];
              default:
                return ["lg:[--scroll-mt:9.5rem]", "lg:[--scroll-mt:12rem]"];
            }
          })();
        function d() {
          document.documentElement.classList.add(o);
        }
        function x(e) {
          document.getElementById(s)?.style.setProperty("top", `${e}rem`);
        }
        function u(e) {
          document.getElementById(s)?.style.setProperty("height", `calc(100vh - ${e}rem)`);
        }
        function m(e, t) {
          (!e && t) || (e && !t)
            ? (d(), document.documentElement.classList.remove(c))
            : e &&
              t &&
              (document.documentElement.classList.add(c),
              document.documentElement.classList.remove(o));
        }
        let p = document.documentElement.getAttribute("data-banner-state"),
          h = null != p ? "visible" === p : t;
        switch (a) {
          case "mint":
            (x(r), m(e, h));
            break;
          case "palm":
          case "aspen":
            (x(r), u(r), m(e, h));
            break;
          case "linden":
            (x(r), h && d());
            break;
          case "almond":
            (d(), x(r), u(r));
            break;
          case "sequoia":
            m(e, h);
        }
        let g = (function () {
          let e = document.createElement("style");
          return (
            e.appendChild(
              document.createTextNode(
                "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}",
              ),
            ),
            document.head.appendChild(e),
            function () {
              (window.getComputedStyle(document.body),
                setTimeout(() => {
                  document.head.removeChild(e);
                }, 1));
            }
          );
        })();
        ("requestAnimationFrame" in globalThis ? requestAnimationFrame : setTimeout)(() => {
          let e;
          ((e = !1),
            (e = window.scrollY > 50),
            document.getElementById(i)?.setAttribute("data-is-opaque", `${!!e}`),
            g());
        });
      }.toString();
      function u(e, t) {
        if (
          !document.getElementById("footer")?.classList.contains("advanced-footer") ||
          "maple" === t ||
          "willow" === t ||
          "almond" === t ||
          "sequoia" === t
        ) {
          return;
        }
        let r = document.documentElement.getAttribute("data-page-mode"),
          a = document.getElementById("navbar"),
          n = document.getElementById("navigation-items"),
          l = document.getElementById("sidebar"),
          s = document.getElementById("footer"),
          i = document.getElementById("table-of-contents-content"),
          o = (n?.clientHeight ?? 0) + 16 * e + 32 * ("mint" === t || "linden" === t);
        if (!s || "center" === r) {
          return;
        }
        let c = s.getBoundingClientRect().top,
          d = window.innerHeight - c;
        (l &&
          n &&
          (o > c
            ? ((l.style.top = `-${d}px`), (l.style.height = `${window.innerHeight}px`))
            : ((l.style.top = `${e}rem`), (l.style.height = "auto"))),
          i &&
            a &&
            (d > 0
              ? (i.style.top =
                  "custom" === r ? `${a.clientHeight - d}px` : `${40 + a.clientHeight - d}px`)
              : (i.style.top = "")));
      }
      function m({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, l.useContext)(i.K),
          d = r(),
          u = d?.theme,
          m = t && u ? u : e,
          { banner: p } = (0, l.useContext)(s.y),
          { divisions: h } = (0, l.useContext)(o.NavigationContext),
          g = h.tabs.length > 0,
          V = !!p,
          L = (0, l.useMemo)(
            () => `(${x})(
  ${g},
  ${V},
  ${c(g, V, m)},
  "${m}",
)`,
            [g, V, m],
          );
        return (0, a.jsx)(n.default, {
          strategy: "beforeInteractive",
          id: "_mintlify-scroll-top-script",
          dangerouslySetInnerHTML: { __html: L },
          suppressHydrationWarning: !0,
        });
      }
      function p({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, l.useContext)(i.K),
          d = r(),
          x = d?.theme,
          m = t && x ? x : e,
          { banner: p } = (0, l.useContext)(s.y),
          { divisions: h } = (0, l.useContext)(o.NavigationContext),
          g = h.tabs.length > 0,
          V = !!p,
          L = (0, l.useMemo)(
            () => `(${u.toString()})(
  ${c(g, V, m)},
  "${m}",
)`,
            [g, V, m],
          );
        return (0, a.jsx)(n.default, {
          strategy: "beforeInteractive",
          id: "_mintlify-footer-and-sidebar-scroll-script",
          dangerouslySetInnerHTML: { __html: L },
          suppressHydrationWarning: !0,
        });
      }
    },
    59646: (e, t, r) => {
      (r.r(t), r.d(t, { default: () => em }));
      var a = r(54568),
        n = r(24560),
        l = r(7620),
        s = r(76829),
        i = r(22153),
        o = r(65477),
        c = r(27194),
        d = r(35878),
        x = r(33052),
        u = r(73205),
        m = r(12158),
        p = r(81325);
      function h() {
        let [e, t] = (0, l.useState)(null),
          [r, n] = (0, l.useState)(""),
          [h, g] = (0, l.useState)(!1),
          { hasChatPermissions: V, assistantConfig: L } = (0, l.useContext)(m.SearchContext),
          {
            isChatSheetOpen: f,
            onChatSheetToggle: v,
            setShouldFocusChatSheet: y,
          } = (0, l.useContext)(m.ChatAssistantContext),
          j = (0, s.n)(),
          b = (0, c.G)(),
          H = (0, i.p)("docs.assistant.ask_ai_on_text_selection");
        (0, l.useEffect)(() => {
          let e;
          if (!V) {
            return;
          }
          let r = () => {
              (clearTimeout(e),
                (e = setTimeout(() => {
                  let e = window.getSelection();
                  if (!e || e.isCollapsed) {
                    return void g(!1);
                  }
                  let r = e.toString().trim();
                  if (!r) {
                    return void g(!1);
                  }
                  let a = e.getRangeAt(0),
                    l = a.startContainer,
                    s = document.getElementsByClassName(x.x.Content);
                  if (!s[0]?.contains(l)) {
                    return void g(!1);
                  }
                  let i = a.getBoundingClientRect();
                  (n(r), t({ top: i.top - 45, left: i.left + i.width / 2 }), g(!0));
                }, 100)));
            },
            a = (r) => {
              let a = document.getElementById(d.V.TextSelectionTooltip);
              a?.contains(r.target) || (clearTimeout(e), g(!1), t(null), n(""));
            },
            l = () => {
              (g(!1), t(null), n(""));
            };
          return (
            document.addEventListener("mouseup", r),
            document.addEventListener("mousedown", a),
            window.addEventListener("scroll", l, !0),
            window.addEventListener("resize", l),
            () => {
              (clearTimeout(e),
                document.removeEventListener("mouseup", r),
                document.removeEventListener("mousedown", a),
                window.removeEventListener("scroll", l, !0),
                window.removeEventListener("resize", l));
            }
          );
        }, [V]);
        let { payloadInput: M, setPayloadInput: w } = (0, o.w)();
        return e && r && V && L?.askAiOnTextSelection !== !1
          ? (0, a.jsx)("div", {
              id: d.V.TextSelectionTooltip,
              className: "fixed z-50 pointer-events-auto",
              style: { top: `${e.top}px`, left: `${e.left}px`, transform: "translateX(-50%)" },
              children: (0, a.jsx)("button", {
                id: d.V.TextSelectionTooltipButton,
                onClick: () => {
                  r &&
                    (f || v({ entryPoint: "text-selection" }),
                    H({ path: b, text: r }).catch(console.error),
                    w({
                      context: [...(M.context || []), { type: "textSelection", value: r, path: b }],
                    }),
                    y(!0),
                    window.getSelection()?.removeAllRanges(),
                    g(!1),
                    t(null),
                    n(""));
                },
                className: (0, p.cn)(
                  "flex items-center gap-1.5 rounded-xl",
                  "bg-white dark:bg-[#0B0C0E] text-gray-900 dark:text-white border border-gray-200 dark:border-white/10",
                  "transition-all duration-100",
                  "shadow-xl shadow-gray-500/5 dark:shadow-gray-500/5",
                  h ? "opacity-100 scale-100 translate-y-0" : "opacity-0 scale-95 translate-y-1",
                ),
                children: (0, a.jsxs)("div", {
                  className:
                    "px-2.5 py-1.5 flex gap-1.5 items-center rounded-[10px] text-sm font-medium whitespace-nowrap hover:bg-gray-50 dark:hover:bg-gray-900",
                  children: [
                    (0, a.jsx)(u.BZ, {
                      className: "h-3.5 w-3.5 text-primary dark:text-primary-light",
                    }),
                    (0, a.jsx)("span", { className: "select-none", children: j.addToAssistant }),
                  ],
                }),
              }),
            })
          : null;
      }
      var g = r(30793),
        V = r(15209),
        L = r(74092),
        f = r(59705),
        v = r(90280),
        y = r(91052),
        j = r(98167),
        b = r(72902);
      let H = () => {
        let [e, t] = (0, l.useState)(!0);
        return (0, a.jsxs)("div", {
          className: "flex items-center justify-between",
          children: [
            (0, a.jsx)("span", { className: "text-sm", children: "Cache Toolbar:" }),
            (0, a.jsx)("button", {
              onClick: () => {
                let r = document.getElementsByClassName("nct-inline-flex"),
                  a = document.getElementById("dev-panel-button");
                r[0] &&
                  r[0] instanceof HTMLElement &&
                  (e
                    ? (r[0].setAttribute("style", "z-index: 9999"),
                      a?.setAttribute("style", "transform: translateX(-100%)"))
                    : (r[0].setAttribute("style", "z-index: -9999"),
                      a?.setAttribute("style", "transform: translateX(0%)")),
                  t(!e));
              },
              className: (0, b.A)(
                "px-3 py-1 text-xs rounded",
                "transition-colors duration-150",
                e
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                  : "bg-green-600 text-white hover:bg-green-700",
              ),
              children: e ? "Show" : "Hide",
            }),
          ],
        });
      };
      var M = r(6438),
        w = r(17023),
        Z = r(72116),
        k = r(57810);
      let N = ({
        title: e,
        defaultOpen: t = !1,
        theme: r,
        children: n,
        copyText: s,
        sectionClassName: i,
      }) => {
        let [o, c] = (0, l.useState)(t),
          [d, x] = (0, l.useState)(!1),
          u = async (e) => {
            (e.stopPropagation(),
              e.preventDefault(),
              s &&
                "success" === (await (0, k.l)(s)) &&
                (x(!0),
                setTimeout(() => {
                  x(!1);
                }, 2e3)));
          };
        return (0, a.jsxs)("div", {
          className: (0, b.A)(
            "border rounded-lg",
            "dark" === r ? "border-gray-800" : "border-gray-200",
          ),
          children: [
            (0, a.jsxs)("button", {
              onClick: () => c(!o),
              className: (0, b.A)(
                "w-full flex items-center justify-between p-3",
                "transition-colors",
                "hover:bg-gray-100 dark:hover:bg-gray-800",
                o ? "rounded-tl-lg rounded-tr-lg" : "rounded-lg",
              ),
              children: [
                (0, a.jsx)("span", { className: "font-semibold text-sm", children: e }),
                (0, a.jsxs)("div", {
                  className: "flex items-center gap-2",
                  children: [
                    s &&
                      (0, a.jsx)("button", {
                        onClick: u,
                        children: d ? (0, a.jsx)(M.A, { size: 14 }) : (0, a.jsx)(w.A, { size: 14 }),
                      }),
                    (0, a.jsx)(Z.A, {
                      size: 16,
                      className: (0, b.A)("transition-transform duration-200", o && "rotate-180"),
                    }),
                  ],
                }),
              ],
            }),
            o &&
              (0, a.jsx)("div", {
                className: (0, b.A)(
                  "p-3 border-t border-gray-200 dark:border-gray-800 space-y-4",
                  i,
                ),
                children: n,
              }),
          ],
        });
      };
      var C = r(14486);
      let A = ({ value: e, color: t, displayValue: r }) => {
          let [n, s] = (0, l.useState)(!1),
            i = async () => {
              "success" === (await (0, k.l)(e)) &&
                (s(!0),
                setTimeout(() => {
                  s(!1);
                }, 2e3));
            };
          return (0, a.jsxs)("span", {
            onClick: i,
            className:
              "cursor-pointer hover:opacity-70 transition-opacity inline-flex items-center gap-1",
            title: "Click to copy",
            children: [
              (0, a.jsx)("span", { style: { color: t }, children: r ?? e }),
              n && (0, a.jsx)(M.A, { size: 10, className: "text-green-500" }),
            ],
          });
        },
        S = ({ label: e, value: t, theme: r, depth: n = 0 }) => {
          let [s, i] = (0, l.useState)(0 === n),
            o = {
              property: "dark" === r ? "#8BE9FD" : "#7c3aed",
              punctuation: "dark" === r ? "#F8F8F2" : "#6b7280",
              string: "dark" === r ? "#F1FA8C" : "#d97706",
              number: "dark" === r ? "#BD93F9" : "#16a34a",
              boolean: "dark" === r ? "#FF79C6" : "#2563eb",
              null: "dark" === r ? "#6272A4" : "#9ca3af",
            };
          if (null == t) {
            return (0, a.jsxs)("div", {
              className: "flex items-center gap-1",
              children: [
                e &&
                  (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                      (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                    ],
                  }),
                (0, a.jsx)(A, { value: String(t), color: o.null }),
              ],
            });
          }
          if ("boolean" == typeof t) {
            return (0, a.jsxs)("div", {
              className: "flex items-center gap-1",
              children: [
                e &&
                  (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                      (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                    ],
                  }),
                (0, a.jsx)(A, { value: String(t), color: o.boolean }),
              ],
            });
          }
          if ("number" == typeof t) {
            return (0, a.jsxs)("div", {
              className: "flex items-center gap-1",
              children: [
                e &&
                  (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                      (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                    ],
                  }),
                (0, a.jsx)(A, { value: String(t), color: o.number }),
              ],
            });
          }
          if ("string" == typeof t) {
            return (0, a.jsxs)("div", {
              className: "flex items-center gap-1",
              children: [
                e &&
                  (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                      (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                    ],
                  }),
                (0, a.jsx)(A, { value: t, color: o.string, displayValue: `"${t}"` }),
              ],
            });
          }
          if (Array.isArray(t)) {
            return 0 === t.length
              ? (0, a.jsxs)("div", {
                  className: "flex items-center gap-1",
                  children: [
                    e &&
                      (0, a.jsxs)(a.Fragment, {
                        children: [
                          (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                          (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                        ],
                      }),
                    (0, a.jsx)("span", { style: { color: o.punctuation }, children: "[]" }),
                  ],
                })
              : (0, a.jsxs)("div", {
                  children: [
                    (0, a.jsxs)("button", {
                      onClick: () => i(!s),
                      className: "flex items-center gap-1 hover:opacity-70 transition-opacity",
                      style: { color: o.punctuation },
                      children: [
                        (0, a.jsx)(C.A, {
                          size: 12,
                          className: (0, b.A)("transition-transform", s && "rotate-90"),
                        }),
                        e &&
                          (0, a.jsxs)(a.Fragment, {
                            children: [
                              (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                              (0, a.jsx)("span", {
                                style: { color: o.punctuation },
                                children: ": ",
                              }),
                            ],
                          }),
                        (0, a.jsxs)("span", {
                          style: { color: o.punctuation },
                          children: ["[", t.length, "]"],
                        }),
                      ],
                    }),
                    s &&
                      (0, a.jsx)("div", {
                        className: "ml-4 border-l pl-2",
                        style: { borderColor: "dark" === r ? "#44475a" : "#e5e7eb" },
                        children: t.map((e, t) =>
                          (0, a.jsx)(S, { label: String(t), value: e, theme: r, depth: n + 1 }, t),
                        ),
                      }),
                  ],
                });
          }
          if ("object" == typeof t) {
            let l = Object.entries(t);
            return 0 === l.length
              ? (0, a.jsxs)("div", {
                  className: "flex items-center gap-1",
                  children: [
                    e &&
                      (0, a.jsxs)(a.Fragment, {
                        children: [
                          (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                          (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                        ],
                      }),
                    (0, a.jsx)("span", { style: { color: o.punctuation }, children: "{}" }),
                  ],
                })
              : e
                ? (0, a.jsxs)("div", {
                    children: [
                      (0, a.jsxs)("button", {
                        onClick: () => i(!s),
                        className: "flex items-center gap-1 hover:opacity-70 transition-opacity",
                        style: { color: o.punctuation },
                        children: [
                          (0, a.jsx)(C.A, {
                            size: 12,
                            className: (0, b.A)("transition-transform", s && "rotate-90"),
                          }),
                          (0, a.jsx)("span", { style: { color: o.property }, children: e }),
                          (0, a.jsx)("span", { style: { color: o.punctuation }, children: ": " }),
                          (0, a.jsxs)("span", {
                            style: { color: o.punctuation },
                            children: ["{", l.length, "}"],
                          }),
                        ],
                      }),
                      s &&
                        (0, a.jsx)("div", {
                          className: "ml-4 border-l pl-2",
                          style: { borderColor: "dark" === r ? "#44475a" : "#e5e7eb" },
                          children: l.map(([e, t]) =>
                            (0, a.jsx)(S, { label: e, value: t, theme: r, depth: n + 1 }, e),
                          ),
                        }),
                    ],
                  })
                : (0, a.jsx)("div", {
                    children: l.map(([e, t]) =>
                      (0, a.jsx)(S, { label: e, value: t, theme: r, depth: n + 1 }, e),
                    ),
                  });
          }
          return null;
        },
        E = ({ data: e, theme: t }) =>
          (0, a.jsx)("div", {
            className: (0, b.A)(
              "rounded-md p-3 font-mono text-xs overflow-x-auto",
              "dark" === t ? "bg-gray-900" : "bg-gray-50",
            ),
            children: (0, a.jsx)(S, { value: e, theme: t }),
          });
      var T = r(83176);
      let $ = ({ readOnly: e = !1 }) => {
          let { flags: t, overrides: r, isEnabled: n, setOverride: s } = (0, l.useContext)(T.I),
            i = t.getAllToggles();
          return e
            ? (0, a.jsx)("div", {
                className: "flex flex-col gap-2 text-sm",
                children: i.map(({ name: e, enabled: t }) =>
                  (0, a.jsxs)(
                    "div",
                    {
                      children: [
                        e,
                        ":",
                        " ",
                        t
                          ? (0, a.jsx)("span", { className: "text-green-500", children: "enabled" })
                          : (0, a.jsx)("span", { className: "", children: "disabled" }),
                      ],
                    },
                    e,
                  ),
                ),
              })
            : (0, a.jsxs)("div", {
                className: "flex flex-col gap-2",
                children: [
                  i.map(({ name: e, enabled: l }) => {
                    let i = n(e),
                      o = void 0 !== r[e];
                    return (0, a.jsxs)(
                      "div",
                      {
                        className: "flex items-center justify-between py-1",
                        children: [
                          (0, a.jsx)("div", {
                            className: "flex flex-col gap-0.5 flex-1",
                            children: (0, a.jsxs)("div", {
                              className: "flex items-center gap-2",
                              children: [
                                (0, a.jsx)("span", { className: "text-[13px]", children: e }),
                                l &&
                                  !o &&
                                  (0, a.jsx)("span", {
                                    className:
                                      "text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-semibold",
                                    children: "DEFAULT",
                                  }),
                                o &&
                                  (0, a.jsx)("span", {
                                    className:
                                      "text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-500 font-semibold",
                                    children: "LOCAL",
                                  }),
                              ],
                            }),
                          }),
                          (0, a.jsx)("button", {
                            onClick: () =>
                              ((e) => {
                                let a = t.isEnabled(e);
                                void 0 !== r[e] ? s(e, void 0) : s(e, !a);
                              })(e),
                            className: `relative w-10 h-5 rounded-full border-none cursor-pointer transition-colors ${i ? "bg-green-500" : "bg-gray-400"}`,
                            children: (0, a.jsx)("div", {
                              className: `absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-md ${i ? "left-[22px]" : "left-0.5"}`,
                            }),
                          }),
                        ],
                      },
                      e,
                    );
                  }),
                  0 === i.length &&
                    (0, a.jsx)("div", {
                      className: "p-4 text-center text-gray-400",
                      children: "No feature flags available",
                    }),
                ],
              });
        },
        O = ({ setPosition: e, position: t }) =>
          (0, a.jsxs)("div", {
            className: "flex items-center justify-between",
            children: [
              (0, a.jsx)("span", { className: "text-sm", children: "Position:" }),
              (0, a.jsx)("div", {
                className: "flex gap-1",
                children: ["top", "right", "bottom", "left"].map((r) =>
                  (0, a.jsx)(
                    "button",
                    {
                      onClick: () => e(r),
                      className: (0, b.A)(
                        "px-2 py-1 text-xs rounded capitalize",
                        "transition-colors duration-150",
                        t === r
                          ? "bg-green-600 text-white hover:bg-green-700"
                          : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700",
                      ),
                      children: r,
                    },
                    r,
                  ),
                ),
              }),
            ],
          }),
        I = ({ toggleTheme: e, docsAreDarkMode: t }) =>
          t
            ? null
            : (0, a.jsxs)("div", {
                className: "flex items-center justify-between",
                children: [
                  (0, a.jsx)("span", { className: "text-sm", children: "Theme:" }),
                  (0, a.jsxs)("button", {
                    onClick: e,
                    className:
                      "relative flex h-7 w-[3.25rem] items-center rounded-full border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 p-1 transition-colors",
                    "aria-label": "Toggle theme",
                    children: [
                      (0, a.jsxs)("div", {
                        className: "z-10 flex w-full items-center justify-between px-1",
                        children: [
                          (0, a.jsx)(u.gL, {
                            className: "size-3 text-gray-600 dark:text-gray-500 fill-current",
                          }),
                          (0, a.jsx)(u.rR, {
                            className: "size-3 text-gray-400 dark:text-gray-300 fill-current",
                          }),
                        ],
                      }),
                      (0, a.jsx)("div", {
                        className: (0, b.A)(
                          "absolute left-1 h-5 w-5 rounded-full bg-gray-200 dark:bg-gray-700 transition-transform duration-200",
                          "dark:translate-x-[1.40rem]",
                        ),
                      }),
                    ],
                  }),
                ],
              });
      var F = r(12598),
        B = r(92068);
      let z = (0, B.A)("Settings", [
        [
          "path",
          {
            d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
            key: "1qme2f",
          },
        ],
        ["circle", { cx: "12", cy: "12", r: "3", key: "1v7zrd" }],
      ]);
      var D = r(97509);
      let R = ({
        theme: e,
        toggleSheet: t,
        isOpen: r,
        currentPosition: n,
        children: s,
        buttonRef: i,
        onPointerDown: o,
        isButtonPositioned: c,
      }) => {
        let [d, x] = (0, l.useState)(!1);
        (0, l.useEffect)(() => {
          x(!0);
        }, []);
        let u = (0, a.jsxs)("div", {
          className: (0, b.A)("dark" === e ? "dark" : ""),
          children: [
            (0, a.jsx)("button", {
              ref: i,
              onPointerDown: o,
              id: "dev-panel-button",
              onClick: t,
              className: (0, b.A)(
                "fixed top-0 left-0 z-[99999] touch-none",
                "flex items-center justify-center",
                "w-12 h-12 rounded-full",
                "bg-green-600 text-white",
                "shadow-lg hover:shadow-xl",
                "transition-[transform,background-color,opacity] duration-200",
                "hover:scale-105 active:cursor-grabbing active:scale-95",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                c ? "opacity-100" : "opacity-0 pointer-events-none",
              ),
              "aria-label": r ? "Close dev panel" : "Open dev panel",
              children: r ? (0, a.jsx)(F.A, {}) : (0, a.jsx)(z, {}),
            }),
            (0, a.jsx)("div", {
              id: "dev-panel-wrapper",
              className: (0, b.A)(
                "fixed z-[99999]",
                "bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800",
                "shadow-2xl",
                "transition-transform duration-300 ease-in-out",
                n.container,
                n.transform,
              ),
              children: (0, a.jsxs)("div", {
                className: "h-full flex flex-col overflow-hidden",
                children: [
                  (0, a.jsx)("div", {
                    className: "flex items-center justify-end p-4",
                    children: (0, a.jsx)("button", {
                      onClick: t,
                      className:
                        "p-0.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-700 dark:text-gray-300",
                      "aria-label": "Close",
                      children: (0, a.jsx)(F.A, { size: 16 }),
                    }),
                  }),
                  (0, a.jsx)("div", {
                    className: "flex-1 overflow-auto px-4 pb-6 text-gray-900 dark:text-gray-100",
                    children: (0, a.jsx)("div", { className: "space-y-4", children: s }),
                  }),
                ],
              }),
            }),
          ],
        });
        return d ? (0, D.createPortal)(u, document.body) : null;
      };
      var P = r(22904);
      let q = 80,
        _ = 25,
        W = 5,
        U = 2,
        K = 20,
        J = (e, [t, r], a = U, n = K) => {
          if (e > r) {
            let t = e - r;
            return r + Math.min((t > 0 ? Math.sqrt(t) : -Math.sqrt(-t)) * a, n);
          }
          if (e < t) {
            let r = e - t;
            return t + Math.max((r > 0 ? Math.sqrt(r) : -Math.sqrt(-r)) * a, -n);
          }
          return e;
        },
        G = new Set(["STYLE", "SCRIPT", "TITLE"]),
        X = new Set(["dev-panel-button", "dev-panel-wrapper"]),
        Y = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ",
        Q = new WeakMap(),
        ee = (e) => {
          let t = e;
          for (; t; ) {
            if (t instanceof Element && t.id && X.has(t.id)) {
              return !0;
            }
            t = t.parentNode;
          }
          return !1;
        },
        et = (e) => /^\s*$/.test(e),
        er = () => {
          let [e, t] = (0, l.useState)(!1);
          return (0, a.jsxs)("div", {
            className: "flex flex-col gap-2 py-1",
            children: [
              (0, a.jsxs)("div", {
                className: "flex items-center justify-between",
                children: [
                  (0, a.jsxs)("div", {
                    className: "flex flex-col gap-0.5 flex-1",
                    children: [
                      (0, a.jsxs)("div", {
                        className: "flex items-center gap-2",
                        children: [
                          (0, a.jsx)("span", {
                            className: "text-[13px]",
                            children: "Chaos String Test",
                          }),
                          e &&
                            (0, a.jsx)("span", {
                              className:
                                "text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-500 font-semibold",
                              children: "ACTIVE",
                            }),
                        ],
                      }),
                      (0, a.jsx)("span", {
                        className: "text-[11px] text-gray-500",
                        children: "Replaces all text with random strings",
                      }),
                    ],
                  }),
                  (0, a.jsx)("button", {
                    onClick: () => {
                      ((() => {
                        for (let e of (function* (e) {
                          yield* (function* (
                            e,
                            t = NodeFilter.SHOW_ALL,
                            { inspect: r, collect: a, callback: n } = {},
                          ) {
                            let l,
                              s = document.createTreeWalker(e, t, {
                                acceptNode: (e) =>
                                  r && !r(e)
                                    ? NodeFilter.FILTER_REJECT
                                    : a && !a(e)
                                      ? NodeFilter.FILTER_SKIP
                                      : NodeFilter.FILTER_ACCEPT,
                              });
                            for (; (l = s.nextNode()); ) {
                              (n?.(l), yield l);
                            }
                          })(e, NodeFilter.SHOW_TEXT, {
                            inspect: (e) => !G.has(e.parentElement?.nodeName || ""),
                          });
                        })(document.body)) {
                          if (ee(e) || null === e.textContent || et(e.textContent)) {
                            continue;
                          }
                          let t = e.textContent.length,
                            r = Q.get(e);
                          void 0 === r
                            ? (Q.set(e, e.textContent),
                              (e.textContent = Array.from(
                                { length: 3 * t },
                                () => Y[Math.floor(Math.random() * Y.length)],
                              ).join("")))
                            : ((e.textContent = r), Q.delete(e));
                        }
                      })(),
                        t((e) => !e));
                    },
                    className: `relative w-10 h-5 rounded-full border-none cursor-pointer transition-colors ${e ? "bg-green-500" : "bg-gray-400"}`,
                    children: (0, a.jsx)("div", {
                      className: `absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-md ${e ? "left-[22px]" : "left-0.5"}`,
                    }),
                  }),
                ],
              }),
              e &&
                (0, a.jsxs)("div", {
                  className: "text-[11px] bg-blue-500/10 text-blue-400 p-2 rounded font-mono",
                  children: [
                    (0, a.jsx)("div", {
                      className: "text-[10px] text-blue-500 font-semibold mb-1",
                      children: "Potential fix:",
                    }),
                    (0, a.jsx)("div", { className: "text-gray-500", children: "/* css */" }),
                    (0, a.jsx)("div", { children: "overflow-wrap: break-word;" }),
                    (0, a.jsx)("div", { children: "hyphens: auto;" }),
                    (0, a.jsx)("div", {
                      className: "text-gray-500 mt-1",
                      children: "/* tailwind */",
                    }),
                    (0, a.jsx)("div", { children: "break-words hyphens-auto" }),
                  ],
                }),
            ],
          });
        },
        ea = ({ text: e }) => {
          let [t, r] = (0, l.useState)(!1),
            n = async () => {
              "success" === (await (0, k.l)(e)) &&
                (r(!0),
                setTimeout(() => {
                  r(!1);
                }, 2e3));
            };
          return (0, a.jsxs)("span", {
            children: [
              (0, a.jsx)("button", {
                className: "p-1 hover:bg-zinc-950/5 dark:hover:bg-white/5 rounded mr-1",
                onClick: n,
                children: t
                  ? (0, a.jsx)(M.A, { className: "size-3" })
                  : (0, a.jsx)(w.A, { className: "size-3" }),
              }),
              e,
            ],
          });
        },
        en = (0, B.A)("Download", [
          ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", key: "ih7n3h" }],
          ["polyline", { points: "7 10 12 15 17 10", key: "2ggqvy" }],
          ["line", { x1: "12", x2: "12", y1: "15", y2: "3", key: "1vk2je" }],
        ]);
      function el({ enabled: e, onToggle: t, size: r = "normal" }) {
        let n = "small" === r;
        return (0, a.jsx)("button", {
          onClick: (e) => {
            (e.stopPropagation(), t());
          },
          className: (0, b.A)(
            "relative rounded-full border-none cursor-pointer transition-colors",
            e ? "bg-green-500" : "bg-gray-400",
            n ? "w-8 h-4" : "w-10 h-5",
          ),
          children: (0, a.jsx)("div", {
            className: (0, b.A)(
              "absolute rounded-full bg-white transition-all shadow-md",
              n ? "top-0.5 w-3 h-3" : "top-0.5 w-4 h-4",
              e ? (n ? "left-[18px]" : "left-[22px]") : "left-0.5",
            ),
          }),
        });
      }
      let es = ({ rule: e, theme: t }) => {
          let [r, n] = (0, l.useState)(!1);
          return 0 === e.declarations.length
            ? null
            : (0, a.jsxs)("div", {
                className: (0, b.A)(
                  "border rounded text-xs overflow-hidden",
                  "dark" === t ? "border-gray-700" : "border-gray-200",
                ),
                children: [
                  (0, a.jsxs)("button", {
                    onClick: () => n(!r),
                    className: (0, b.A)(
                      "w-full flex items-center justify-between pl-0.5 pr-2 py-1.5 gap-2",
                      "transition-colors text-left",
                      "dark" === t
                        ? "hover:bg-gray-800"
                        : "hover:bg-gray-50 dark:hover:bg-gray-800",
                    ),
                    children: [
                      (0, a.jsx)("code", {
                        className: (0, b.A)(
                          "text-[11px] font-mono truncate flex-1 bg-transparent dark:bg-transparent",
                          "dark" === t ? "text-gray-200" : "text-gray-800",
                        ),
                        title: e.selector,
                        children: e.selector,
                      }),
                      (0, a.jsx)("div", {
                        className: "flex items-center gap-2",
                        children: (0, a.jsx)(Z.A, {
                          size: 12,
                          className: (0, b.A)(
                            "transition-transform duration-200",
                            r && "rotate-180",
                          ),
                        }),
                      }),
                    ],
                  }),
                  r &&
                    (0, a.jsx)("div", {
                      className: (0, b.A)(
                        "border-t py-2 px-1 bg-gray-100/5 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]",
                        "dark" === t ? "border-gray-700" : "border-gray-200",
                      ),
                      children: (0, a.jsx)("div", {
                        className: "w-fit",
                        children: e.declarations.map((e) =>
                          (0, a.jsxs)(
                            "code",
                            {
                              className:
                                "text-[10px] font-mono whitespace-nowrap rounded-none !bg-transparent block",
                              children: [
                                (0, a.jsx)("span", {
                                  className: "text-purple-600 dark:text-purple-400",
                                  children: e.property,
                                }),
                                (0, a.jsx)("span", { className: "text-gray-500", children: ": " }),
                                (0, a.jsx)("span", {
                                  className: "text-blue-600 dark:text-blue-400",
                                  children: e.value,
                                }),
                              ],
                            },
                            e.key,
                          ),
                        ),
                      }),
                    }),
                ],
              });
        },
        ei = ({ file: e, onToggleFile: t, theme: r }) => {
          let [n, s] = (0, l.useState)(!1),
            [i, o] = (0, l.useState)(!1),
            c = [...e.content.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
              .map((e, t) => {
                let r = e[1],
                  a = e[2];
                if (!r || void 0 === a) {
                  return null;
                }
                let n = r.trim();
                if (!n || n.startsWith("/*") || n.endsWith("*/")) {
                  return null;
                }
                let l = a
                  .split(";")
                  .map((e) => e.trim())
                  .filter(Boolean)
                  .map((e) => {
                    let r = (function (e) {
                      let t = e.indexOf(":");
                      if (-1 === t) {
                        return null;
                      }
                      let r = e.slice(0, t).trim(),
                        a = e.slice(t + 1).trim();
                      return r && a ? { property: r, value: a } : null;
                    })(e);
                    return r
                      ? { property: r.property, value: r.value, key: `${t}|${n}|${r.property}` }
                      : null;
                  })
                  .filter((e) => null !== e);
                return { selector: n, declarations: l, ruleIndex: t };
              })
              .filter((e) => null !== e),
            d = (0, l.useCallback)(
              (t) => {
                (t.stopPropagation(),
                  navigator.clipboard.writeText(e.content),
                  o(!0),
                  setTimeout(() => o(!1), 1500));
              },
              [e.content],
            ),
            x = (0, l.useCallback)(
              (t) => {
                t.stopPropagation();
                let r = new Blob([e.content], { type: "text/css" }),
                  a = URL.createObjectURL(r),
                  n = document.createElement("a");
                ((n.href = a),
                  (n.download = e.path.split("/").pop() || "custom.css"),
                  document.body.appendChild(n),
                  n.click(),
                  document.body.removeChild(n),
                  URL.revokeObjectURL(a));
              },
              [e.content, e.path],
            );
          return (0, a.jsxs)("div", {
            className: (0, b.A)(
              "border-b last-of-type:border-b-0 overflow-hidden",
              "dark" === r ? "border-gray-700" : "border-gray-200",
              !e.enabled && "opacity-60",
            ),
            children: [
              (0, a.jsxs)("div", {
                onClick: () => s(!n),
                className: (0, p.cn)(
                  "w-full flex items-center justify-between p-2 gap-2 overflow-hidden cursor-pointer",
                  "dark" === r ? "hover:bg-gray-200/10" : "hover:bg-gray-900/5",
                ),
                children: [
                  (0, a.jsxs)("div", {
                    className: "flex items-center gap-2 flex-1 min-w-0 text-left",
                    children: [
                      (0, a.jsx)(Z.A, {
                        size: 14,
                        className: (0, b.A)(
                          "transition-transform duration-200 shrink-0",
                          n && "rotate-180",
                        ),
                      }),
                      (0, a.jsx)("span", {
                        className: "text-[13px] truncate",
                        title: e.path,
                        children: e.path,
                      }),
                    ],
                  }),
                  (0, a.jsxs)("div", {
                    className: "flex items-center gap-1.5 shrink-0",
                    children: [
                      (0, a.jsx)("button", {
                        onClick: d,
                        className: (0, b.A)(
                          "p-1 rounded transition-colors",
                          "dark" === r
                            ? "hover:bg-gray-700 bg-neutral-800"
                            : "hover:bg-gray-200 bg-neutral-100 dark:bg-neutral-800",
                        ),
                        title: "Copy CSS",
                        children: i
                          ? (0, a.jsx)(M.A, { size: 14, className: "text-green-500" })
                          : (0, a.jsx)(w.A, { size: 14, className: "opacity-60" }),
                      }),
                      (0, a.jsx)("button", {
                        onClick: x,
                        className: (0, b.A)(
                          "p-1 rounded transition-colors bg-neutral-100",
                          "dark" === r
                            ? "hover:bg-gray-700 bg-neutral-800"
                            : "hover:bg-gray-200 bg-neutral-100 dark:bg-neutral-800",
                        ),
                        title: "Download CSS",
                        children: (0, a.jsx)(en, { size: 14, className: "opacity-60" }),
                      }),
                      (0, a.jsx)(el, {
                        size: "small",
                        enabled: e.enabled,
                        onToggle: () => t(e.index),
                      }),
                    ],
                  }),
                ],
              }),
              n &&
                (0, a.jsx)("div", {
                  className: (0, b.A)(
                    "border-t p-2 space-y-2 max-h-[280px] overflow-y-auto",
                    "dark" === r ? "border-gray-700" : "border-gray-200",
                  ),
                  children:
                    0 === c.length
                      ? (0, a.jsx)("div", {
                          className: "text-xs text-gray-500 italic",
                          children: "No CSS rules found",
                        })
                      : c.map((t) =>
                          (0, a.jsx)(es, { rule: t, theme: r }, `${e.index}-${t.ruleIndex}`),
                        ),
                }),
            ],
          });
        },
        eo = ({ theme: e }) => {
          let [t, r] = (0, l.useState)(null);
          (0, l.useEffect)(() => {
            let e = document.querySelectorAll("style[data-custom-css-index]"),
              t = [];
            (e.forEach((e) => {
              let r = parseInt(e.dataset.customCssIndex ?? "0", 10),
                a = e.dataset.customCssPath ?? `css-file-${r}`,
                n = e.textContent ?? "",
                l = "not all" !== e.media;
              t.push({ index: r, path: a, content: n, enabled: l });
            }),
              r(t));
          }, []);
          let n = (0, l.useCallback)((e) => {
            let t = document.querySelector(`style[data-custom-css-index="${e}"]`);
            if (!t) {
              return;
            }
            let a = "not all" !== t.media;
            ((t.media = a ? "not all" : ""),
              r((t) => t?.map((t) => (t.index === e ? { ...t, enabled: !a } : t)) ?? null));
          }, []);
          return null === t
            ? null
            : 0 === t.length
              ? (0, a.jsx)("div", {
                  className: "text-sm text-gray-500 italic p-4",
                  children: "No custom CSS files found",
                })
              : (0, a.jsx)("div", {
                  className: "flex flex-col overflow-hidden",
                  children: t.map((t) =>
                    (0, a.jsx)(ei, { file: t, onToggleFile: n, theme: e }, t.index),
                  ),
                });
        },
        ec = "mintlify-dev-panel",
        ed = () => {
          let [e, t] = (0, l.useState)(!1),
            [r, n] = (0, l.useState)("right"),
            [s, i] = (0, l.useState)("light"),
            {
              ref: o,
              onPointerDown: c,
              isPositioned: d,
            } = (({
              localStorageKey: e,
              dragThreshold: t = W,
              offsetTop: r = q,
              offsetOther: a = _,
              onDragStart: n,
              defaultSide: s = "right",
              defaultVertical: i = "bottom",
            }) => {
              let o = (0, l.useRef)(null),
                [c, d] = (0, l.useState)(!1),
                x = (0, l.useRef)(!1),
                u = (0, l.useRef)({ state: "idle" }),
                m = (0, l.useRef)(null),
                p = (0, l.useRef)({ x: 0, y: 0 }),
                h = (0, l.useRef)({ x: 0, y: 0 }),
                g = (0, l.useRef)(0),
                V = (0, l.useRef)([]),
                L = (e, t, r) => Math.max(t, Math.min(r, e)),
                f = (0, l.useRef)(s),
                v = (e) => {
                  if (!o.current) {
                    return 0;
                  }
                  let t = o.current.offsetWidth,
                    r = window.innerWidth - document.documentElement.clientWidth;
                  return "right" === e ? window.innerWidth - r - a - t : a;
                },
                y = () => {
                  if (!o.current) {
                    return { x: 0, y: 0 };
                  }
                  let e = v(s),
                    t = o.current.getBoundingClientRect();
                  return { x: e, y: "bottom" === i ? window.innerHeight - t.height - a : r };
                };
              ((0, l.useEffect)(() => {
                let e = () => {
                  if (!o.current) {
                    return;
                  }
                  let e = o.current.getBoundingClientRect().height,
                    t = v(f.current),
                    n = window.innerHeight - a - e,
                    l = L(h.current.y, r, n);
                  ((h.current = { x: t, y: l }), (o.current.style.translate = `${t}px ${l}px`));
                };
                return (
                  window.addEventListener("resize", e),
                  () => window.removeEventListener("resize", e)
                );
              }, [r, a]),
                (0, l.useEffect)(
                  () => () => {
                    null !== m.current && (m.current(), (m.current = null));
                  },
                  [],
                ));
              let j = () => {
                  "drag" === u.current.state &&
                    o.current?.releasePointerCapture(u.current.pointerId);
                  let e = "drag" === u.current.state;
                  ((u.current = e ? { state: "drag-end" } : { state: "idle" }),
                    null !== m.current && (m.current(), (m.current = null)),
                    e || o.current?.removeEventListener("click", H),
                    (V.current = []),
                    (document.body.style.userSelect = ""));
                },
                b = (e) => {
                  o.current && ((h.current = e), (o.current.style.translate = `${e.x}px ${e.y}px`));
                },
                H = (e) => {
                  "drag-end" === u.current.state &&
                    (e.preventDefault(),
                    e.stopPropagation(),
                    (u.current = { state: "idle" }),
                    o.current?.removeEventListener("click", H));
                },
                M = (e) => {
                  if ("press" === u.current.state) {
                    let r = e.clientX - p.current.x,
                      a = e.clientY - p.current.y;
                    Math.sqrt(r * r + a * a) >= t &&
                      (n?.(),
                      (u.current = { state: "drag", pointerId: e.pointerId }),
                      o.current?.setPointerCapture(e.pointerId),
                      (document.body.style.userSelect = "none"));
                  }
                  if ("drag" !== u.current.state || !o.current) {
                    return;
                  }
                  let l = { x: e.clientX, y: e.clientY },
                    s = l.x - p.current.x,
                    i = l.y - p.current.y;
                  p.current = l;
                  let c = o.current.getBoundingClientRect(),
                    d = c.width,
                    x = c.height,
                    m = window.innerWidth - document.documentElement.clientWidth,
                    L = window.innerWidth - m - a - d,
                    f = window.innerHeight - a - x;
                  b({ x: J(h.current.x + s, [a, L]), y: J(h.current.y + i, [r, f]) });
                  let v = Date.now();
                  (v - g.current >= 10 &&
                    (V.current = [...V.current.slice(-5), { position: l, timestamp: v }]),
                    (g.current = v));
                },
                w = () => {
                  if ("drag" !== u.current.state || !o.current) {
                    return j();
                  }
                  let t = ((e) => {
                      if (e.length < 2) {
                        return { x: 0, y: 0 };
                      }
                      let t = e[0],
                        r = e[e.length - 1],
                        a = (r?.timestamp ?? 0) - (t?.timestamp ?? 0);
                      return 0 === a
                        ? { x: 0, y: 0 }
                        : {
                            x: 1e3 * (((r?.position.x ?? 0) - (t?.position.x ?? 0)) / a),
                            y: 1e3 * (((r?.position.y ?? 0) - (t?.position.y ?? 0)) / a),
                          };
                    })(V.current),
                    n = o.current.getBoundingClientRect(),
                    l = n.height,
                    s = n.width,
                    i =
                      n.left + s / 2 + ((e, t = 0.998) => ((e / 1e3) * t) / (1 - t))(t.x) <
                      window.innerWidth / 2
                        ? "left"
                        : "right",
                    c = v(i),
                    d = window.innerHeight - a - l,
                    x = L(h.current.y, r, d);
                  (j(),
                    ((t, r) => {
                      let a = o.current;
                      if (!a) {
                        return;
                      }
                      let n = (l) => {
                        if ("translate" === l.propertyName) {
                          ((h.current = t),
                            (f.current = r),
                            (a.style.transition = ""),
                            a.removeEventListener("transitionend", n));
                          var s = t.y;
                          try {
                            localStorage.setItem(e, JSON.stringify({ side: r, y: s }));
                          } catch (e) {
                            console.error("Failed to save widget position:", e);
                          }
                        }
                      };
                      ((a.style.transition = "translate 300ms cubic-bezier(0.34, 1.56, 0.64, 1)"),
                        a.addEventListener("transitionend", n),
                        b(t));
                    })({ x: c, y: x }, i));
                };
              return {
                ref: (t) => {
                  ((o.current = t),
                    t &&
                      !x.current &&
                      ((x.current = !0),
                      ((t) => {
                        try {
                          let r = localStorage.getItem(e);
                          if (r) {
                            let e = JSON.parse(r);
                            f.current = e.side;
                            let a = v(e.side);
                            ((h.current = { x: a, y: e.y }),
                              (t.style.translate = `${a}px ${e.y}px`));
                          } else {
                            let { x: e, y: r } = y();
                            ((f.current = s),
                              (h.current = { x: e, y: r }),
                              (t.style.translate = `${e}px ${r}px`));
                          }
                        } catch (a) {
                          console.error("Failed to load widget position:", a);
                          let { x: e, y: r } = y();
                          ((f.current = s),
                            (h.current = { x: e, y: r }),
                            (t.style.translate = `${e}px ${r}px`));
                        }
                        d(!0);
                      })(t)));
                },
                onPointerDown: (e) => {
                  0 === e.button &&
                    (o.current && (o.current.style.transition = ""),
                    (p.current = { x: e.clientX, y: e.clientY }),
                    (u.current = { state: "press" }),
                    window.addEventListener("pointermove", M),
                    window.addEventListener("pointerup", w),
                    null !== m.current && (m.current(), (m.current = null)),
                    (m.current = () => {
                      (window.removeEventListener("pointermove", M),
                        window.removeEventListener("pointerup", w));
                    }),
                    o.current?.addEventListener("click", H));
                },
                isPositioned: c,
              };
            })({
              localStorageKey: "mintlify-dev-panel-position",
              defaultSide: "right",
              defaultVertical: "bottom",
            }),
            x = ((e, t) =>
              ({
                top: {
                  container: "top-0 left-0 right-0 h-[60vh] border-b",
                  transform: t ? "translate-y-0" : "-translate-y-full",
                },
                bottom: {
                  container: "bottom-0 left-0 right-0 h-[60vh] border-t",
                  transform: t ? "translate-y-0" : "translate-y-full",
                },
                left: {
                  container: "top-0 left-0 bottom-0 w-[400px] border-r",
                  transform: t ? "translate-x-0" : "-translate-x-full",
                },
                right: {
                  container: "top-0 right-0 bottom-0 w-[400px] border-l",
                  transform: t ? "translate-x-0" : "translate-x-full",
                },
              })[e])(r, e),
            u = (0, l.useContext)(m.SearchContext),
            p = (0, l.useContext)(g.DeploymentMetadataContext),
            h = (0, l.useContext)(g.DocsConfigContext),
            { apiReferenceData2: V } = (0, l.useContext)(g.ApiReferenceContext2),
            { inputs: L, getApiPlaygroundInputs: b } = (0, f.jT)(),
            M = b();
          if (
            ((0, l.useEffect)(() => {
              let e = (e) => {
                e.shiftKey &&
                  e.ctrlKey &&
                  e.metaKey &&
                  "m" === e.key.toLowerCase() &&
                  ("true" === (0, P.Gq)(ec)
                    ? ((0, P.SO)(ec, "false"), t(!1))
                    : ((0, P.SO)(ec, "true"), t(!0)));
              };
              return (
                window.addEventListener("keydown", e),
                () => window.removeEventListener("keydown", e)
              );
            }, [e]),
            "true" !== (0, P.Gq)(ec))
          ) {
            return null;
          }
          let w = document.documentElement.classList.contains("dark");
          return (0, a.jsxs)(R, {
            theme: s,
            toggleSheet: () => t(!e),
            isOpen: e,
            currentPosition: x,
            buttonRef: o,
            onPointerDown: c,
            isButtonPositioned: d,
            children: [
              (0, a.jsxs)("div", {
                className: "mb-2 text-xs opacity-60",
                children: [j.c.IS_LOCAL_CLIENT && "LOCAL ", "v", y.f],
              }),
              (0, a.jsxs)(N, {
                title: "Dev Panel Settings",
                defaultOpen: !0,
                theme: s,
                children: [
                  (0, a.jsx)(I, {
                    toggleTheme: () => i("dark" === s ? "light" : "dark"),
                    docsAreDarkMode: w,
                  }),
                  (0, a.jsx)(O, { position: r, setPosition: n }),
                  y._.CACHE_TOOLBAR && (0, a.jsx)(H, {}),
                ],
              }),
              (0, a.jsx)(N, {
                title: "Custom CSS",
                defaultOpen: !1,
                theme: s,
                sectionClassName: "px-0 py-0 overflow-hidden",
                children: (0, a.jsx)(eo, { theme: s }),
              }),
              (0, a.jsx)(N, {
                title: "Search Data",
                defaultOpen: !1,
                theme: s,
                children: (0, a.jsx)(E, { data: u, theme: s }),
              }),
              (0, a.jsx)(N, {
                title: "Deployment Metadata",
                defaultOpen: !1,
                theme: s,
                copyText: JSON.stringify(p),
                children: (0, a.jsx)(E, { data: p, theme: s }),
              }),
              (0, a.jsx)(N, {
                title: "Docs Config",
                defaultOpen: !1,
                theme: s,
                copyText: JSON.stringify(h.docsConfig),
                children: (0, a.jsx)(E, { data: h.docsConfig ?? {}, theme: s }),
              }),
              (0, a.jsx)(N, {
                title: "Docs Nav With Metadata",
                defaultOpen: !1,
                theme: s,
                copyText: JSON.stringify(h.docsNavWithMetadata),
                children: (0, a.jsx)(E, { data: h.docsNavWithMetadata ?? {}, theme: s }),
              }),
              "development" !== y._.NODE_ENV &&
                (0, a.jsx)(N, {
                  title: "Feature Flags",
                  defaultOpen: !1,
                  theme: s,
                  children: (0, a.jsx)($, { readOnly: !0 }),
                }),
              v.HL &&
                (0, a.jsxs)(a.Fragment, {
                  children: [
                    (0, a.jsxs)(N, {
                      title: "Api Reference Data",
                      defaultOpen: !1,
                      theme: s,
                      children: [
                        V.filename &&
                          (0, a.jsxs)("div", {
                            className: "text-sm",
                            children: ["filename: ", (0, a.jsx)(ea, { text: V.filename })],
                          }),
                        V.originalFileLocation &&
                          (0, a.jsxs)("div", {
                            className: "text-sm",
                            children: [
                              "originalFileLocation: ",
                              (0, a.jsx)(ea, { text: V.originalFileLocation }),
                            ],
                          }),
                        (0, a.jsx)(E, {
                          data: { operation: V.operation, dependencies: V.dependencies },
                          theme: s,
                        }),
                      ],
                    }),
                    (0, a.jsxs)(N, {
                      title: "Api Playground Inputs",
                      defaultOpen: !1,
                      theme: s,
                      children: [
                        (0, a.jsx)("div", { className: "text-sm", children: "flattened" }),
                        (0, a.jsx)(E, { data: L, theme: s }),
                        (0, a.jsx)("div", { className: "text-sm", children: "unflattened" }),
                        (0, a.jsx)(E, { data: M, theme: s }),
                      ],
                    }),
                    (0, a.jsx)(N, {
                      title: "Feature Flags",
                      defaultOpen: !1,
                      theme: s,
                      children: (0, a.jsx)($, {}),
                    }),
                    (0, a.jsx)(N, {
                      title: "Actions",
                      defaultOpen: !1,
                      theme: s,
                      children: (0, a.jsx)(er, {}),
                    }),
                  ],
                }),
            ],
          });
        };
      var ex = r(6723),
        eu = r(36140);
      function em(e) {
        let { mdxSource: t, mdxSourceWithNoJs: r, forceIsLoading: s } = e,
          { pageMetadata: i } = (0, l.useContext)(g.PageContext),
          { userInfo: o } = (0, l.useContext)(g.AuthContext),
          { resolvedTheme: c } = (0, n.D)(),
          d = (0, V.e)();
        return (
          (({ containJsCode: e }) => {
            (0, l.useEffect)(() => {
              if (!e) {
                return;
              }
              let t = setTimeout(() => {
                let e = window.location.hash;
                if (e) {
                  let t = document.getElementById(e.slice(1));
                  t && t.scrollIntoView({ behavior: "instant", block: "start" });
                }
              });
              return () => clearTimeout(t);
            }, [e]);
          })({ containJsCode: t.compiledSource !== r.compiledSource }),
          (0, L.E)(() => {
            "dark" === d || "dark" === c
              ? document.documentElement.classList.add("twoslash-dark")
              : document.documentElement.classList.remove("twoslash-dark");
          }, [c]),
          (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)(ex.A, {
                children: (0, a.jsx)(eu.b, {
                  mdxSource: t,
                  mdxSourceWithNoJs: r,
                  pageMetadata: i,
                  userInfo: o,
                  forceIsLoading: s,
                }),
              }),
              (0, a.jsx)(ed, {}),
              (0, a.jsx)(h, {}),
            ],
          })
        );
      }
    },
    70715: (e, t, r) => {
      (r.r(t), r.d(t, { MDXContentController: () => eN }));
      var a = r(54568),
        n = r(7620),
        l = r(71252),
        s = r(16974),
        i = r(52094),
        o = r(54808),
        c = r(35878),
        d = r(32795),
        x = r(178),
        u = r(66438),
        m = r(66818),
        p = r(61706),
        h = r(97154),
        g = r(81325),
        V = r(840),
        L = r(12192),
        f = r(19518),
        v = r(12145);
      let y = ({ className: e, isModal: t = !1 }) => (0, a.jsx)(v._, {});
      var j = r(30793),
        b = r(81817),
        H = r(39282),
        M = r(6482),
        w = r(4517),
        Z = r(7755),
        k = r(76829),
        N = r(27194);
      let C = (e, t, r) =>
          e
            .map((e) => {
              let a = t ? void 0 === e.tabId || t.includes(e.tabId) : !e.tabId,
                n = r ? void 0 === e.viewId || e.viewId === r : !e.viewId;
              if (a && n) {
                let a = C(e.children, t, r);
                return { ...e, slug: (0, Z.P)(e.slug), children: a };
              }
              return null;
            })
            .filter((e) => null !== e),
        A = () => {
          let [{ tableOfContents: e, multiViewItems: t }] = (0, H.O)(),
            r = (() => {
              let [e, t] = (0, n.useState)([]),
                r = (0, N.G)();
              return (
                (0, n.useEffect)(() => {
                  let e = () => {
                      let e = Array.from(
                        document.querySelectorAll(
                          '[data-component-part="tab-button"][data-active="true"]',
                        ),
                      )
                        .filter((e) => !e.closest('[data-component-part="tab-content"].hidden'))
                        .map((e) => e.parentElement?.id)
                        .filter((e) => void 0 !== e);
                      t((t) => (t.length === e.length && t.every((t, r) => t === e[r]) ? t : e));
                    },
                    r = () => {
                      setTimeout(e, 0);
                    };
                  e();
                  let a = new MutationObserver((e) => {
                    e.some(
                      (e) =>
                        ("attributes" === e.type && "data-active" === e.attributeName) ||
                        "childList" === e.type,
                    ) && r();
                  });
                  a.observe(document.body, {
                    attributes: !0,
                    attributeFilter: ["data-active"],
                    childList: !0,
                    subtree: !0,
                  });
                  let n = (e) => {
                    let t = e.target;
                    t instanceof Element &&
                      "tab-button" === t.getAttribute("data-component-part") &&
                      r();
                  };
                  return (
                    setTimeout(() => {
                      r();
                    }),
                    document.addEventListener("hashchange", r),
                    document.addEventListener("click", n),
                    () => {
                      (a.disconnect(),
                        document.removeEventListener("hashchange", r),
                        document.removeEventListener("click", n));
                    }
                  );
                }, [r]),
                e
              );
            })(),
            a = (0, n.useMemo)(() => {
              let e = t.find((e) => e.active);
              return e?.title;
            }, [t]),
            { setNavIsOpen: l } = (0, n.useContext)(k.NavigationContext),
            s = (0, n.useCallback)(() => l(!1), [l]),
            i = (0, n.useMemo)(() => C(e, r, a), [e, r, a]),
            o = i.some((e) => e.children.length > 0);
          return (0, n.useMemo)(
            () => ({ closeNav: s, pageHasSubsections: o, tableOfContents: i }),
            [s, o, i],
          );
        };
      var S = r(12158),
        E = r(12598),
        T = r(67908);
      function $() {
        let { docsConfig: e } = (0, n.useContext)(j.DocsConfigContext),
          t = e?.theme,
          [{ changelogFilters: r }, l] = (0, H.O)(),
          { filters: s, clear: i } = (0, k.n)(),
          o = r.some((e) => e.active),
          d = (e) => {
            l({ type: "toggle_changelog_filter", payload: { ...e, active: !e.active } });
          };
        return r.length
          ? (0, a.jsxs)("div", {
              className: (0, g.cn)(
                T.f.Control,
                "hidden xl:flex flex-col box-border",
                "sequoia" === t ? "w-full" : "pl-10 w-[19rem]",
              ),
              id: "changelog-filters",
              children: [
                (0, a.jsx)(m.g, {}),
                (0, a.jsxs)("div", {
                  id: c.V.ChangelogFilters,
                  className: (0, g.cn)(
                    "relative text-gray-600 text-sm leading-6 space-y-4",
                    "sequoia" === t ? "w-full overflow-y-auto pb-4" : "w-[16.5rem] overflow-y-auto",
                  ),
                  children: [
                    (0, a.jsxs)("div", {
                      className: "w-full flex justify-between items-center",
                      children: [
                        (0, a.jsx)("span", {
                          className: "text-gray-700 dark:text-gray-300 font-medium",
                          children: s,
                        }),
                        (0, a.jsx)("button", {
                          className: (0, g.cn)(
                            "text-sm font-medium px-3 rounded-full",
                            o
                              ? "text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
                              : "hidden",
                          ),
                          onClick: () => {
                            o && r.forEach((e) => d({ ...e, active: !0 }));
                          },
                          children: (0, a.jsxs)("span", {
                            className: "flex items-center",
                            children: [(0, a.jsx)(E.A, { className: "w-4 h-4 mr-1" }), i],
                          }),
                        }),
                      ],
                    }),
                    (0, a.jsx)("div", {
                      className: "flex flex-wrap gap-2",
                      id: c.V.ChangelogFiltersContent,
                      children: r.map((e) =>
                        (0, a.jsx)(
                          O,
                          {
                            tag: e.tag,
                            count: e.count,
                            active: e.active ?? !1,
                            onClick: () => d(e),
                          },
                          e.tag,
                        ),
                      ),
                    }),
                  ],
                }),
              ],
            })
          : null;
      }
      let O = ({ tag: e, active: t, onClick: r }) =>
        (0, a.jsx)(
          "button",
          {
            onClick: r,
            className: (0, g.cn)(
              "px-3 py-1 text-sm rounded-full flex items-center space-x-1",
              t
                ? "bg-primary text-white/90"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-300",
            ),
            children: (0, a.jsx)("span", { children: e }),
          },
          e,
        );
      var I = r(36602);
      function F({ children: e, isApiExample: t }) {
        let { divisions: r } = (0, n.useContext)(k.NavigationContext),
          { docsConfig: l } = (0, n.useContext)(j.DocsConfigContext),
          { banner: s } = (0, n.useContext)(L.y),
          { isCustom: i, isCenter: o, isWide: d } = (0, I.c)(),
          x = r.tabs.length > 0,
          u = l?.footer?.links && l.footer.links.length > 0;
        return ((0, n.useEffect)(() => {
          let e = () => {
            if (!u) {
              return;
            }
            let e = document.getElementById(c.V.Content);
            if (e) {
              let t = e.getBoundingClientRect().bottom,
                r = window.innerHeight - t;
              document.documentElement.style.setProperty(
                "--sidenav-move-up",
                `${Math.max(r, 0)}px`,
              );
            }
          };
          return (
            e(),
            window.addEventListener("scroll", e),
            window.addEventListener("resize", e),
            () => {
              (window.removeEventListener("scroll", e), window.removeEventListener("resize", e));
            }
          );
        }, [u]),
        i || o || d)
          ? null
          : (0, a.jsx)("div", {
              suppressHydrationWarning: !0,
              className: (function (e, t, r, a) {
                let n = "hidden xl:flex self-start sticky xl:flex-col max-w-[28rem] z-[21]";
                return "maple" === e
                  ? (0, g.cn)(
                      n,
                      t && r
                        ? "h-[calc(100vh-8rem)] top-[calc(8rem-var(--sidenav-move-up,0px))]"
                        : t
                          ? "h-[calc(100vh-6rem)] top-[calc(6rem-var(--sidenav-move-up,0px))]"
                          : r
                            ? "h-[calc(100vh-5rem)] top-[calc(6rem-var(--sidenav-move-up,0px))]"
                            : "h-[calc(100vh-4rem)] top-[calc(2.5rem-var(--sidenav-move-up,0px))]",
                    )
                  : "palm" === e
                    ? (0, g.cn)(
                        n,
                        t && r
                          ? "h-[calc(100vh-15rem)] top-[calc(12rem-var(--sidenav-move-up,0px))]"
                          : t
                            ? "h-[calc(100vh-9.5rem)] top-[calc(9.5rem-var(--sidenav-move-up,0px))]"
                            : r
                              ? "h-[calc(100vh-9.5rem)] top-[calc(9rem-var(--sidenav-move-up,0px))]"
                              : "h-[calc(100vh-8rem)] top-[calc(6.5rem-var(--sidenav-move-up,0px))]",
                      )
                    : "willow" === e
                      ? (0, g.cn)(
                          n,
                          t && r
                            ? "h-[calc(100vh-9rem)] top-[calc(9rem-var(--sidenav-move-up,0px))]"
                            : t
                              ? "h-[calc(100vh-6rem)] top-[calc(5.5rem-var(--sidenav-move-up,0px))]"
                              : r
                                ? "h-[calc(100vh-6rem)] top-[calc(5rem-var(--sidenav-move-up,0px))]"
                                : "h-[calc(100vh-4rem)] top-[calc(2.5rem-var(--sidenav-move-up,0px))]",
                        )
                      : "linden" === e
                        ? (0, g.cn)(
                            n,
                            r
                              ? "h-[calc(100vh-12rem)] top-[calc(12rem-var(--sidenav-move-up,0px))]"
                              : "h-[calc(100vh-6.5rem)] top-[calc(6.5rem-var(--sidenav-move-up,0px))]",
                          )
                        : "almond" === e
                          ? (0, g.cn)(
                              n,
                              "h-[calc(100vh-6.5rem)] top-[calc(0px-var(--sidenav-move-up,0px))]",
                            )
                          : "aspen" === e
                            ? (0, g.cn)(
                                n,
                                t && r
                                  ? "h-[calc(100vh-15rem)] top-[calc(12rem-var(--sidenav-move-up,0px))]"
                                  : t
                                    ? "h-[calc(100vh-9.5rem)] top-[calc(9.5rem-var(--sidenav-move-up,0px))]"
                                    : r
                                      ? "h-[calc(100vh-9.5rem)] top-[calc(9rem-var(--sidenav-move-up,0px))]"
                                      : "h-[calc(100vh-8rem)] top-[calc(6.5rem-var(--sidenav-move-up,0px))]",
                              )
                            : "sequoia" === e
                              ? (0, g.cn)(
                                  n,
                                  "top-[var(--topbar-height,0px)]",
                                  "h-[calc(100vh-var(--topbar-height,0px))]",
                                  a && "pt-6 xl:mr-6",
                                  !a &&
                                    "w-60 border-l border-gray-100 dark:border-gray-800 px-4 pt-4",
                                )
                              : (0, g.cn)(
                                  n,
                                  t && r
                                    ? "h-[calc(100vh-12rem)] top-[calc(12rem-var(--sidenav-move-up,0px))]"
                                    : t || r
                                      ? "h-[calc(100vh-9.5rem)] top-[calc(9.5rem-var(--sidenav-move-up,0px))]"
                                      : "h-[calc(100vh-8rem)] top-[calc(6.5rem-var(--sidenav-move-up,0px))]",
                                );
              })(l?.theme, x, !!s, t),
              id: c.V.ContentSideLayout,
              children: e,
            });
      }
      var B = r(34920),
        z = r(26976),
        D = r(33052),
        R = r(68999);
      let P = (e) => {
        try {
          return decodeURIComponent(e);
        } catch {
          return e;
        }
      };
      var q = r(73205);
      let _ = ({ section: e, closeNav: t, pageHasSubsections: r, style: l, theme: s }) => {
          let i = "arrow" === l ? 1 : 2,
            o = (() => {
              let e = (() => {
                  let { docsConfig: e } = (0, n.useContext)(j.DocsConfigContext),
                    [{ tableOfContents: t, headings: r }] = (0, H.O)(),
                    [a, l] = (0, n.useState)(""),
                    [s, i] = (0, n.useState)(),
                    o = (0, n.useRef)(void 0),
                    d = e?.theme === "almond";
                  return (
                    (0, n.useEffect)(
                      () => (
                        d && (o.current = document.getElementById(c.V.ContentContainer)),
                        () => {
                          o.current = void 0;
                        }
                      ),
                      [d],
                    ),
                    (0, n.useEffect)(() => {
                      let e = () => {
                        let e = window.location.hash;
                        e && l(e.substring(1));
                      };
                      return (
                        window.addEventListener("hashchange", e),
                        e(),
                        () => {
                          window.removeEventListener("hashchange", e);
                        }
                      );
                    }, []),
                    (0, n.useEffect)(() => {
                      if (0 === t.length || 0 === r.length) {
                        return;
                      }
                      function e() {
                        let e,
                          t = !1;
                        if (d) {
                          if (o.current) {
                            let { scrollTop: e, scrollHeight: r, clientHeight: a } = o.current;
                            t = 5 > Math.abs(e + a - r);
                          }
                        } else {
                          t = window.innerHeight + window.scrollY === document.body.offsetHeight;
                        }
                        if (t) {
                          let e = r.concat([]).toSorted((e, t) => (e.top ?? 0) - (t.top ?? 0)),
                            t = e[e.length - 1];
                          if (t?.id) {
                            return void i(t.id);
                          }
                        }
                        let a = window.getComputedStyle(document.documentElement),
                          n = parseFloat(
                            a.getPropertyValue("--scroll-mt").match(/[\d.]+/)?.[0] ?? "0",
                          );
                        (d && (n += 6.5),
                          (n *= parseFloat(a.fontSize.match(/[\d.]+/)?.[0] ?? "16")));
                        let l = r.concat([]).toSorted((e, t) => (e.top ?? 0) - (t.top ?? 0));
                        e = d ? (o.current?.scrollTop ?? 0) + n + 1 : window.scrollY + n + 1;
                        let c = l[0];
                        for (let t = 0; t < l.length; t++) {
                          e >= (l[t]?.top ?? 0) && (c = l[t]);
                        }
                        s != c?.id && i(c?.id);
                      }
                      let a = { capture: !0, passive: !0 };
                      return d
                        ? o.current
                          ? (o.current.addEventListener("scroll", e, a),
                            e(),
                            () => o.current?.removeEventListener("scroll", e, a))
                          : void 0
                        : (window.addEventListener("scroll", e, a),
                          e(),
                          () => window.removeEventListener("scroll", e, a));
                    }, [a, s, r, t, d]),
                    s
                  );
                })(),
                t = (0, n.useCallback)(
                  (r) =>
                    r.slug === P(e ?? "") || (!!r.children.length && r.children.findIndex(t) > -1),
                  [e],
                );
              return (0, n.useMemo)(() => t, [t]);
            })();
          return (0, a.jsxs)(
            n.Fragment,
            {
              children: [
                (0, a.jsxs)("li", {
                  className: (0, g.cn)(
                    D.x.TableOfContentsItem,
                    "relative",
                    "arrow" === l && "pl-4",
                  ),
                  "data-depth": 0,
                  children: [
                    "arrow" === l &&
                      o(e) &&
                      (0, a.jsx)(q.DropdownArrowIcon, {
                        className: "absolute left-0 mt-1 text-primary dark:text-primary-light",
                      }),
                    (0, a.jsx)("a", {
                      href: `#${encodeURIComponent(P(e.slug))}`,
                      onClick: t,
                      className: (0, g.cn)(
                        "break-words py-1 block",
                        r && "font-medium",
                        "border" === l &&
                          "border-l pl-4 border-gray-950/5 dark:border-white/10 hover:border-gray-950/20 dark:hover:border-white/20",
                        o(e)
                          ? "font-medium text-primary dark:text-primary-light border-primary dark:border-primary-light hover:border-primary dark:hover:border-primary-light"
                          : "sequoia" === s
                            ? "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            : "hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
                        "sequoia" === s && "!font-normal",
                      ),
                      children: e.title,
                    }),
                  ],
                }),
                e.children.map((e) => {
                  let r = e.depth - i,
                    n = Math.max(e.depth - i, 0);
                  return (0, a.jsxs)(
                    "li",
                    {
                      className: (0, g.cn)(
                        D.x.TableOfContentsItem,
                        "relative",
                        "border" === l &&
                          "border-l pl-4 border-gray-950/5 dark:border-white/10 hover:border-gray-950/20 dark:hover:border-white/20",
                        o(e) && "border-primary hover:border-primary dark:border-primary-light",
                      ),
                      "data-depth": n,
                      children: [
                        "arrow" === l &&
                          o(e) &&
                          (0, a.jsx)(q.DropdownArrowIcon, {
                            className: "absolute left-0 mt-1 text-primary dark:text-primary-light",
                          }),
                        (0, a.jsx)("a", {
                          style: { paddingLeft: r + "rem" },
                          href: `#${encodeURIComponent(P(e.slug))}`,
                          onClick: t,
                          className: (0, g.cn)(
                            "group flex items-start break-words py-1 whitespace-pre-wrap",
                            o(e)
                              ? "text-primary dark:text-primary-light"
                              : "sequoia" === s
                                ? "text-gray-500 hover:text-gray-900 dark:hover:text-gray-300"
                                : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
                          ),
                          children: e.title,
                        }),
                      ],
                    },
                    e.slug,
                  );
                }),
              ],
            },
            e.slug,
          );
        },
        W = "regular";
      function U({ icon: e }) {
        return "function" == typeof e
          ? (0, a.jsx)(e, { className: "w-3.5 h-3.5 shrink-0" })
          : (0, a.jsx)(R.ComponentIcon, {
              icon: "string" == typeof e ? e : (e?.name ?? "info"),
              iconType: "string" == typeof e ? W : e?.style || W,
              className: "h-3.5 w-3.5 bg-current",
              overrideColor: !0,
            });
      }
      function K({ option: e }) {
        let t = "copy" === e.id || "mcp" === e.id,
          { text: r, execute: l, isDisabled: s } = (0, z.k)({ idleText: e.title }),
          i = (0, n.useCallback)(async () => {
            t ? await l(e.action) : e.action();
          }, [e, t, l]);
        return (0, a.jsxs)("button", {
          onClick: i,
          disabled: s,
          className:
            "flex items-center gap-2 w-full py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 transition-colors text-left disabled:opacity-70",
          children: [
            (0, a.jsx)(U, { icon: e.icon }),
            (0, a.jsxs)("span", {
              className: "flex items-center gap-1",
              children: [
                t ? r : e.title,
                e.externalLink &&
                  (0, a.jsx)(B.A, { className: "w-3 h-3 text-gray-400 dark:text-gray-500" }),
              ],
            }),
          ],
        });
      }
      function J() {
        let { docsConfig: e } = (0, n.useContext)(j.DocsConfigContext),
          { onThisPage: t } = (0, k.n)(),
          { closeNav: r, pageHasSubsections: l, tableOfContents: s } = A(),
          { options: i, display: o } = (0, w.t)(),
          d = "toc" === o && i.length > 0,
          x = Array.isArray(s) && s.length > 0;
        return x || d
          ? e?.theme === "sequoia"
            ? (0, a.jsxs)("div", {
                className: "text-sm leading-6 w-full overflow-y-auto pb-4",
                id: c.V.TableOfContents,
                children: [
                  (0, a.jsx)(m.g, { className: "mb-2.5" }),
                  x &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        (0, a.jsx)("button", {
                          onClick: () => {
                            let e = document.getElementById(c.V.ContentContainer);
                            e && e.scrollHeight > e.clientHeight
                              ? e.scrollTo({ top: 0, behavior: "smooth" })
                              : window.scrollTo({ top: 0, behavior: "smooth" });
                          },
                          className:
                            "text-gray-500 dark:text-gray-400 text-xs font-normal py-2 hover:text-gray-700 dark:hover:text-gray-300 transition-colors cursor-pointer",
                          children: t,
                        }),
                        (0, a.jsx)("ul", {
                          id: c.V.TableOfContentsContent,
                          className: (0, g.cn)(D.x.TableOfContents, "space-y-0"),
                          children: s.map((e) =>
                            (0, a.jsx)(
                              _,
                              {
                                section: e,
                                closeNav: r,
                                pageHasSubsections: l,
                                style: "default",
                                theme: "sequoia",
                              },
                              `TableOfContentSection-${e.slug}`,
                            ),
                          ),
                        }),
                      ],
                    }),
                  d &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        x &&
                          (0, a.jsx)("div", {
                            className: "h-px w-full bg-gray-200 dark:bg-white/10 my-4",
                          }),
                        (0, a.jsx)("div", {
                          className: "space-y-0",
                          children: i.map((e) => (0, a.jsx)(K, { option: e }, e.id)),
                        }),
                      ],
                    }),
                ],
              })
            : (0, a.jsxs)("div", {
                className: (0, g.cn)(
                  "text-gray-600 text-sm leading-6 w-[16.5rem] overflow-y-auto space-y-2 pb-4 -mt-10 pt-10",
                ),
                id: c.V.TableOfContents,
                children: [
                  (0, a.jsx)(m.g, { className: "mb-2.5" }),
                  x &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        (0, a.jsxs)("button", {
                          onClick: () => {
                            let e = document.getElementById(c.V.ContentContainer);
                            e && e.scrollHeight > e.clientHeight
                              ? e.scrollTo({ top: 0, behavior: "smooth" })
                              : window.scrollTo({ top: 0, behavior: "smooth" });
                          },
                          className:
                            "text-gray-700 dark:text-gray-300 font-medium flex items-center space-x-2 hover:text-gray-900 dark:hover:text-gray-100 transition-colors cursor-pointer",
                          children: [(0, a.jsx)(G, {}), (0, a.jsx)("span", { children: t })],
                        }),
                        (0, a.jsx)("ul", {
                          id: c.V.TableOfContentsContent,
                          className: D.x.TableOfContents,
                          children: s.map((t) => {
                            var n;
                            return (0, a.jsx)(
                              _,
                              {
                                section: t,
                                closeNav: r,
                                pageHasSubsections: l,
                                style:
                                  "maple" === (n = e?.theme) || "aspen" === n
                                    ? "border"
                                    : "linden" === n
                                      ? "arrow"
                                      : "almond" === n
                                        ? "border"
                                        : "default",
                                theme: e?.theme,
                              },
                              `TableOfContentSection-${t.slug}`,
                            );
                          }),
                        }),
                      ],
                    }),
                  d &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        x &&
                          (0, a.jsx)("div", {
                            className: "h-px w-full bg-gray-200 dark:bg-white/10 my-3",
                          }),
                        (0, a.jsx)("div", {
                          className: "space-y-1",
                          children: i.map((e) => (0, a.jsx)(K, { option: e }, e.id)),
                        }),
                      ],
                    }),
                ],
              })
          : (0, a.jsx)(m.g, {});
      }
      function G() {
        return (0, a.jsxs)("svg", {
          width: "16",
          height: "16",
          viewBox: "0 0 16 16",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
          xmlns: "http://www.w3.org/2000/svg",
          className: "h-3 w-3",
          children: [
            (0, a.jsx)("path", {
              d: "M2.44434 12.6665H13.5554",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }),
            (0, a.jsx)("path", {
              d: "M2.44434 3.3335H13.5554",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }),
            (0, a.jsx)("path", {
              d: "M2.44434 8H7.33323",
              strokeLinecap: "round",
              strokeLinejoin: "round",
            }),
          ],
        });
      }
      let X = ({ children: e }) => {
          let { docsConfig: t } = (0, n.useContext)(j.DocsConfigContext);
          return (0, a.jsx)("div", {
            className: (0, g.cn)(
              T.f.Control,
              "hidden xl:flex box-border max-h-full",
              t?.theme === "sequoia" ? "w-full" : "pl-10 w-[19rem]",
            ),
            id: c.V.TableOfContentsLayout,
            children: e,
          });
        },
        Y = () => (0, a.jsx)(X, { children: (0, a.jsx)(J, {}) }),
        Q = () => {
          let { docsConfig: e } = (0, n.useContext)(j.DocsConfigContext),
            t = (function () {
              let { tableOfContents: e } = A(),
                [{ multiViewItems: t }] = (0, H.O)(),
                { options: r, display: a } = (0, w.t)();
              return (0, n.useMemo)(() => {
                let n = Array.isArray(e) && e.length > 0,
                  l = t.length > 0,
                  s = "toc" === a && r.length > 0;
                return n || l || s;
              }, [e, t, r, a]);
            })();
          return e?.theme !== "sequoia" || t
            ? (0, a.jsx)(F, { children: (0, a.jsx)(Y, {}) })
            : null;
        },
        ee = () => {
          let e = (0, M.i)(),
            [{ changelogFilters: t }] = (0, H.O)(),
            r = (0, b.B)(),
            { apiReferenceData2: l } = (0, n.useContext)(j.ApiReferenceContext2),
            s = e || l.operation || l.schemaData,
            o = (() => {
              let { panelMdxSource: e, panelMdxSourceWithNoJs: t } = (0, n.useContext)(
                j.PageContext,
              );
              return !!e && !!t;
            })(),
            { isChatSheetOpen: c } = (0, n.useContext)(S.ChatAssistantContext);
          return c
            ? null
            : o
              ? (0, a.jsxs)(F, {
                  isApiExample: !0,
                  children: [
                    (0, a.jsx)(m.g, {}),
                    (0, a.jsx)(i.A, {}),
                    r && !s && (0, a.jsx)(f.z, { name: "Messages", channel: r }),
                    s && (0, a.jsx)(y, {}),
                  ],
                })
              : r
                ? (0, a.jsx)(F, {
                    isApiExample: !0,
                    children: (0, a.jsx)(f.z, { name: "Messages", channel: r }),
                  })
                : s
                  ? (0, a.jsxs)(F, {
                      isApiExample: !0,
                      children: [
                        (0, a.jsx)(m.g, { className: "ml-auto xl:mb-2.5" }),
                        (0, a.jsx)(y, {}),
                      ],
                    })
                  : t.length
                    ? (0, a.jsx)(F, { children: (0, a.jsx)($, {}) })
                    : (0, a.jsx)(Q, {});
        };
      function et({ isWide: e, isCenter: t, children: r }) {
        let { banner: l } = (0, n.useContext)(L.y);
        return (0, a.jsx)("div", {
          className: "flex rounded-2xl h-[calc(100dvh-8rem)] lg:h-[calc(100dvh-4.5rem)]",
          children: (0, a.jsxs)("div", {
            className: (0, g.cn)(
              "flex-1 px-8 pt-8 lg:pt-12 lg:ml-[16.5rem] lg:px-16 overflow-y-auto stable-scrollbar-gutter",
              "rounded-2xl bg-background-light dark:bg-background-dark border border-gray-200/70 dark:border-white/[0.07]",
              e && "px-14",
              !!l && "h-[calc(100dvh-8rem)]",
            ),
            id: c.V.ContentContainer,
            children: [
              (0, a.jsxs)("div", {
                className: (0, g.cn)(
                  "flex flex-row-reverse gap-x-12 justify-center mx-auto w-full",
                  !t && !e && "lg:pl-12",
                ),
                children: [
                  !e && (0, a.jsx)(ee, {}),
                  (0, a.jsx)("div", {
                    className: (0, g.cn)(
                      "w-full overflow-x-visible max-w-xl",
                      e && "max-w-full",
                      t && "max-w-3xl",
                    ),
                    id: c.V.ContentArea,
                    children: r,
                  }),
                ],
              }),
              (0, a.jsx)(s.S, { disableSidebarOffset: !0 }),
            ],
          }),
        });
      }
      function er({ isWide: e, isCenter: t, children: r }) {
        return (0, a.jsx)(et, { isCenter: t, isWide: e, children: r });
      }
      var ea = r(61664);
      function en({ pageMetadata: e, children: t }) {
        let { isCustom: r, isWide: n, isCenter: l, isFrame: L } = (0, V.H)(e);
        return r
          ? (0, a.jsxs)(o.MB, {
              children: [
                (0, a.jsx)(ea.AlmondTopBar, { pageMetadata: e }),
                (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                (0, a.jsx)(h.A, {}),
              ],
            })
          : L
            ? (0, a.jsx)(o.MB, {
                children: (0, a.jsx)("div", {
                  className: "flex rounded-2xl h-[calc(100dvh-8rem)] lg:h-[calc(100dvh-4.5rem)]",
                  children: (0, a.jsxs)("div", {
                    className: (0, g.cn)(
                      "flex-1 lg:ml-[16.5rem] overflow-y-auto stable-scrollbar-gutter",
                      "rounded-2xl bg-background-light dark:bg-background-dark border border-gray-200/70 dark:border-white/[0.07]",
                    ),
                    id: c.V.ContentContainer,
                    children: [
                      (0, a.jsx)(p.z, {}),
                      (0, a.jsx)(m.g, { mobile: !0 }),
                      (0, a.jsx)(i.A, { mobile: !0 }),
                      (0, a.jsx)(x.j, { pageMetadata: e, children: t }),
                      (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                      (0, a.jsx)(s.S, { className: "w-full" }),
                      (0, a.jsx)(h.A, {}),
                    ],
                  }),
                }),
              })
            : (0, a.jsx)(o.MB, {
                children: (0, a.jsx)(er, {
                  isCenter: l,
                  isWide: n,
                  children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
                }),
              });
      }
      function el({ pageMetadata: e, children: t }) {
        let { isCenter: r, isWide: l } = (0, V.H)(e),
          { banner: i } = (0, n.useContext)(L.y);
        return (0, a.jsxs)("div", {
          className: "w-full",
          children: [
            (0, a.jsxs)("div", {
              className: (0, g.cn)(
                "px-5 lg:pr-10 lg:pl-[5.5rem] lg:pt-10 mx-auto max-w-6xl flex flex-row-reverse gap-x-12 w-full",
                r && "lg:pl-0 max-w-3xl mx-auto",
                i ? "pt-[200px]" : " pt-36",
              ),
              id: c.V.ContentContainer,
              children: [
                !l && (0, a.jsx)(ee, {}),
                (0, a.jsx)("div", {
                  className: (0, g.cn)(
                    "grow w-full mx-auto [contain:inline-size]",
                    l ? "xl:w-[calc(100%-19rem)]" : "xl:w-[calc(100%-28rem)]",
                  ),
                  id: c.V.ContentArea,
                  children: t,
                }),
              ],
            }),
            (0, a.jsx)(s.S, { className: "w-full" }),
          ],
        });
      }
      function es({ pageMetadata: e, children: t }) {
        let { isCustom: r, isFrame: n } = (0, V.H)(e);
        return r || n
          ? (0, a.jsx)(o.MB, {
              children: (0, a.jsxs)("div", {
                id: c.V.ContentArea,
                className: "pt-28 lg:pt-0",
                children: [
                  (0, a.jsx)(p.z, {}),
                  (0, a.jsx)(m.g, { mobile: !0 }),
                  (0, a.jsx)(i.A, { mobile: !0 }),
                  (0, a.jsx)(x.j, { pageMetadata: e, children: t }),
                  (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                  n && (0, a.jsx)(s.S, { className: "w-full" }),
                  (0, a.jsx)(h.A, {}),
                ],
              }),
            })
          : (0, a.jsx)(o.MB, {
              children: (0, a.jsx)(el, {
                pageMetadata: e,
                children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
              }),
            });
      }
      let ei = ({ isCustom: e, children: t }) => {
          let { banner: r } = (0, n.useContext)(L.y);
          return (0, a.jsx)("div", {
            suppressHydrationWarning: !0,
            className: (0, g.cn)(
              "flex flex-row-reverse gap-12 box-border w-full",
              e ? "pt-[120px] lg:pt-0" : `${r ? "pt-[200px]" : "pt-40"} lg:pt-10`,
            ),
            children: t,
          });
        },
        eo = ({ pageMetadata: e, children: t }) => {
          let { isWide: r, isCustom: n, isCenter: l } = (0, V.H)(e),
            s = !(r || n || l);
          return (0, a.jsxs)(ei, {
            isCustom: n,
            children: [
              (0, a.jsx)(ee, {}),
              (0, a.jsx)("div", {
                className: (0, g.cn)(
                  "relative grow box-border flex-col w-full",
                  !n && !l && "mx-auto px-1 lg:pl-[20rem] w-full",
                  s ? "xl:max-w-4xl" : "xl:w-[calc(100%-19rem)] xl:min-w-full",
                ),
                id: c.V.ContentArea,
                children: t,
              }),
            ],
          });
        };
      function ec({ pageMetadata: e, children: t }) {
        return "custom" === e.mode
          ? (0, a.jsx)(o.MB, {
              children: (0, a.jsxs)(eo, {
                pageMetadata: e,
                children: [(0, a.jsx)(u.U, { pageMetadata: e, children: t }), (0, a.jsx)(h.A, {})],
              }),
            })
          : (0, a.jsx)(o.MB, {
              children: (0, a.jsx)(eo, {
                pageMetadata: e,
                children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
              }),
            });
      }
      var ed = r(8283);
      let ex = function ({ hasBanner: e, hasTabs: t }) {
          return (0, a.jsx)(d.m8, {
            id: c.V.NavBarTransition + "-maple",
            hasTabs: t,
            hasBanner: e,
            className: "px-12 w-full border-gray-200/70",
            children: (0, a.jsx)(ed.U, {}),
          });
        },
        eu = ({ isWide: e, isCustom: t, isCenter: r, children: l }) => {
          let { divisions: s } = (0, n.useContext)(k.NavigationContext),
            { banner: i } = (0, n.useContext)(L.y),
            o = !(e || t || r),
            d = s.tabs.length > 0,
            x = !!i;
          return (0, a.jsxs)("div", {
            suppressHydrationWarning: !0,
            className: (0, g.cn)(
              "relative w-full lg:ml-[19rem] flex gap-x-8 min-h-screen",
              t
                ? "pt-[120px] lg:pt-0"
                : `${x ? "pt-[200px]" : "pt-40"} px-4 lg:pt-10 lg:pl-16 lg:pr-10`,
            ),
            id: c.V.ContentContainer,
            children: [
              (0, a.jsx)(ex, { hasBanner: x, hasTabs: d }),
              (0, a.jsx)("div", {
                className: (0, g.cn)(
                  "flex flex-col box-border w-full relative grow",
                  !t && "mx-auto max-w-xl 2xl:max-w-2xl [contain:inline-size]",
                  o ? "xl:w-[calc(100%-28rem)]" : "xl:w-[calc(100%-19rem)]",
                  (t || e) && "xl:min-w-full",
                  r && "max-w-3xl",
                  d && "lg:mt-12",
                ),
                id: c.V.ContentArea,
                children: l,
              }),
              (0, a.jsx)(ee, {}),
            ],
          });
        },
        em = ({ pageMetadata: e, children: t }) => {
          let { isWide: r, isCustom: n, isCenter: l } = (0, V.H)(e);
          return (0, a.jsx)(eu, { isCustom: n, isCenter: l, isWide: r, children: t });
        };
      function ep({ pageMetadata: e, children: t }) {
        return "custom" === e.mode
          ? (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("div", {
                  className: "block lg:hidden",
                  children: (0, a.jsx)(d.Vs, { pageMetadata: e }),
                }),
                (0, a.jsx)(o.MB, {
                  children: (0, a.jsxs)(em, {
                    pageMetadata: e,
                    children: [
                      (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                      (0, a.jsx)(h.A, {}),
                    ],
                  }),
                }),
              ],
            })
          : (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("div", {
                  className: "block lg:hidden",
                  children: (0, a.jsx)(d.Vs, { pageMetadata: e }),
                }),
                (0, a.jsx)(o.MB, {
                  children: (0, a.jsx)(em, {
                    pageMetadata: e,
                    children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
                  }),
                }),
              ],
            });
      }
      let eh = ({ isCustom: e, children: t }) => {
          let { banner: r } = (0, n.useContext)(L.y);
          return (0, a.jsx)("div", {
            suppressHydrationWarning: !0,
            className: (0, g.cn)(
              "flex flex-row-reverse gap-12 box-border w-full",
              e ? "pt-[120px] lg:pt-0" : `${r ? "pt-[200px]" : "pt-40"} lg:pt-10`,
            ),
            children: t,
          });
        },
        eg = ({ pageMetadata: e, children: t }) => {
          let { isWide: r, isCustom: n, isCenter: l } = (0, V.H)(e),
            s = !(r || n || l);
          return (0, a.jsxs)(eh, {
            isCustom: n,
            children: [
              (0, a.jsx)(ee, {}),
              (0, a.jsx)("div", {
                className: (0, g.cn)(
                  "relative grow box-border flex-col w-full",
                  !n && !l && "mx-auto px-1 lg:pl-[23.7rem] lg:-ml-12",
                  s ? "xl:w-[calc(100%-28rem)]" : "xl:w-[calc(100%-19rem)] xl:min-w-full",
                ),
                id: c.V.ContentArea,
                children: t,
              }),
            ],
          });
        };
      function eV({ pageMetadata: e, children: t }) {
        return "custom" === e.mode
          ? (0, a.jsx)(o.MB, {
              children: (0, a.jsxs)(eg, {
                pageMetadata: e,
                children: [(0, a.jsx)(u.U, { pageMetadata: e, children: t }), (0, a.jsx)(h.A, {})],
              }),
            })
          : (0, a.jsx)(o.MB, {
              children: (0, a.jsx)(eg, {
                pageMetadata: e,
                children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
              }),
            });
      }
      function eL({ pageMetadata: e, children: t }) {
        let { isWide: r, isCenter: n } = (0, V.H)(e);
        return (0, a.jsx)("div", {
          className: (0, g.cn)(
            "flex-1 px-5 pt-36 lg:pt-10 lg:pl-24 transition-all duration-100",
            r && "px-14",
            n && "lg:pl-0 max-w-3xl mx-auto",
          ),
          id: c.V.ContentContainer,
          children: (0, a.jsxs)("div", {
            className: "mx-auto max-w-5xl flex flex-row-reverse gap-x-12",
            children: [
              !r && (0, a.jsx)(ee, {}),
              (0, a.jsx)("div", {
                className: "w-full [contain:inline-size]",
                id: c.V.ContentArea,
                children: t,
              }),
            ],
          }),
        });
      }
      var ef = r(98046);
      function ev({ pageMetadata: e, children: t }) {
        let { isCustom: r } = (0, V.H)(e);
        return r
          ? (0, a.jsxs)(o.MB, {
              children: [
                (0, a.jsx)(ef.PalmTopBar, { pageMetadata: e }),
                (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                (0, a.jsx)(h.A, {}),
              ],
            })
          : (0, a.jsx)(o.MB, {
              children: (0, a.jsx)(eL, {
                pageMetadata: e,
                children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
              }),
            });
      }
      function ey({ pageMetadata: e, children: t }) {
        let { isWide: r } = (0, V.H)(e);
        return (0, a.jsxs)("div", {
          className: "w-full flex-1 flex flex-col pt-[var(--topbar-height,6rem)] lg:pt-0",
          children: [
            (0, a.jsxs)("div", {
              className: "flex-1 flex",
              id: c.V.ContentContainer,
              children: [
                (0, a.jsx)("div", {
                  className: "flex-1 flex justify-center",
                  children: (0, a.jsx)("div", {
                    className: "box-content w-full max-w-[696px] pt-6 px-6 overflow-x-visible",
                    id: c.V.ContentArea,
                    children: t,
                  }),
                }),
                !r && (0, a.jsx)(ee, {}),
              ],
            }),
            (0, a.jsx)(s.S, { className: "w-full", disableSidebarOffset: !0 }),
          ],
        });
      }
      function ej({ pageMetadata: e, children: t }) {
        let { isCustom: r, isFrame: n } = (0, V.H)(e);
        return r || n
          ? (0, a.jsx)(o.MB, {
              children: (0, a.jsxs)("div", {
                id: c.V.ContentArea,
                className: "pt-28 lg:pt-0",
                children: [
                  (0, a.jsx)(p.z, {}),
                  (0, a.jsx)(m.g, { mobile: !0 }),
                  (0, a.jsx)(i.A, { mobile: !0 }),
                  (0, a.jsx)(x.j, { pageMetadata: e, children: t }),
                  (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                  n && (0, a.jsx)(s.S, { className: "w-full", disableSidebarOffset: !0 }),
                  (0, a.jsx)(h.A, {}),
                ],
              }),
            })
          : (0, a.jsx)(o.MB, {
              children: (0, a.jsx)(ey, {
                pageMetadata: e,
                children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
              }),
            });
      }
      var eb = r(30921);
      let eH = () =>
          (0, a.jsx)(eb.NavbarLinks, {
            actionClassName: eb.DEFAULT_ACTION_CLASSNAME,
            hideMobileCtaButton: !0,
          }),
        eM = ({ hasTabs: e, hasBanner: t }) =>
          (0, a.jsxs)(d.m8, {
            id: "navbar-transition-willow",
            hasTabs: e,
            hasBanner: t,
            className: "px-14 space-x-6 border-gray-200/40",
            children: [
              (0, a.jsx)("div", { className: "flex-1", children: (0, a.jsx)(ed.U, {}) }),
              (0, a.jsx)("div", {
                className: "flex items-center text-sm space-x-6 list-none",
                children: (0, a.jsx)(eH, {}),
              }),
              (0, a.jsx)("div", { className: "flex items-center", children: (0, a.jsx)(d.cI, {}) }),
            ],
          }),
        ew = ({ isCustom: e, children: t }) => {
          let { banner: r } = (0, n.useContext)(L.y),
            { divisions: l } = (0, n.useContext)(k.NavigationContext),
            s = l.tabs.length > 0,
            i = !!r;
          return (0, a.jsxs)("div", {
            suppressHydrationWarning: !0,
            className: (0, g.cn)(
              "relative w-full lg:ml-[19rem] flex flex-row-reverse gap-x-8",
              e
                ? "pt-[120px] lg:pt-0"
                : `${i ? "pt-[200px]" : "pt-40"} px-4 lg:pt-10 lg:pl-16 lg:pr-10`,
              s && "lg:mt-12",
            ),
            id: c.V.ContentContainer,
            children: [(0, a.jsx)(eM, { hasTabs: s, hasBanner: i }), t],
          });
        },
        eZ = ({ pageMetadata: e, children: t }) => {
          let { isWide: r, isCustom: n, isCenter: l } = (0, V.H)(e),
            s = !(r || n || l);
          return (0, a.jsxs)(ew, {
            isCustom: n,
            children: [
              (0, a.jsx)(ee, {}),
              (0, a.jsx)("div", {
                className: (0, g.cn)(
                  "flex flex-col box-border w-full relative grow",
                  n ? "xl:min-w-full" : "mx-auto max-w-xl 2xl:max-w-2xl",
                  s ? "xl:w-[calc(100%-28rem)]" : "xl:w-[calc(100%-19rem)]",
                  l && "max-w-3xl",
                  r && "max-w-5xl",
                ),
                id: c.V.ContentArea,
                children: t,
              }),
            ],
          });
        };
      function ek({ pageMetadata: e, children: t }) {
        return "custom" === e.mode
          ? (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("div", {
                  className: "block lg:hidden",
                  children: (0, a.jsx)(d.Vs, { pageMetadata: e }),
                }),
                (0, a.jsx)(o.MB, {
                  children: (0, a.jsxs)(eZ, {
                    pageMetadata: e,
                    children: [
                      (0, a.jsx)(u.U, { pageMetadata: e, children: t }),
                      (0, a.jsx)(h.A, {}),
                    ],
                  }),
                }),
              ],
            })
          : (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("div", {
                  className: "block lg:hidden",
                  children: (0, a.jsx)(d.Vs, { pageMetadata: e }),
                }),
                (0, a.jsx)(o.MB, {
                  children: (0, a.jsx)(eZ, {
                    pageMetadata: e,
                    children: (0, a.jsx)(d.Kd, { pageMetadata: e, children: t }),
                  }),
                }),
              ],
            });
      }
      function eN({ slug: e, theme: t, pageMetadata: r, children: s }) {
        let { isLivePreview: i, getDocsConfigOverrides: o } = (0, n.useContext)(l.K),
          c = o(),
          d = c?.theme;
        switch (i && d ? d : t) {
          case "maple":
            return (0, a.jsx)(ep, { pageMetadata: r, children: s }, e);
          case "palm":
            return (0, a.jsx)(ev, { pageMetadata: r, children: s }, e);
          case "willow":
            return (0, a.jsx)(ek, { pageMetadata: r, children: s }, e);
          case "linden":
            return (0, a.jsx)(ec, { pageMetadata: r, children: s }, e);
          case "aspen":
            return (0, a.jsx)(es, { pageMetadata: r, children: s }, e);
          case "almond":
            return (0, a.jsx)(en, { pageMetadata: r, children: s }, e);
          case "sequoia":
            return (0, a.jsx)(ej, { pageMetadata: r, children: s }, e);
          default:
            return (0, a.jsx)(eV, { pageMetadata: r, children: s }, e);
        }
      }
    },
    83176: (e, t, r) => {
      r.d(t, { I: () => o, default: () => c });
      var a = r(54568),
        n = r(8494),
        l = r(7620);
      let s = "mintlify-flag-overrides";
      var i = r(22904);
      let o = (0, l.createContext)({
        flags: (0, n.flagsClient)([]),
        overrides: {},
        isEnabled: () => !1,
        setOverride: () => {},
      });
      function c({ children: e, toggles: t }) {
        let r = (0, l.useMemo)(() => (0, n.flagsClient)(t), [t]),
          [c, d] = (0, l.useState)(() => {
            let e = (0, i.Gq)(s);
            return e ? JSON.parse(e) : {};
          }),
          x = (0, l.useCallback)((e, t) => {
            d((r) => {
              let a = { ...r };
              return (void 0 === t ? delete a[e] : (a[e] = t), (0, i.SO)(s, JSON.stringify(a)), a);
            });
          }, []),
          u = (0, l.useCallback)((e) => (void 0 !== c[e] ? c[e] : r.isEnabled(e)), [r, c]);
        return (0, a.jsx)(o.Provider, {
          value: { flags: r, overrides: c, isEnabled: u, setOverride: x },
          children: e,
        });
      }
    },
    91153: (e, t, r) => {
      (r.r(t), r.d(t, { Background: () => m }));
      var a = r(54568),
        n = r(10897),
        l = r(7620),
        s = r(71252),
        i = r(35878),
        o = r(81325),
        c = r(35021);
      let d = (e, t, r) => {
          switch (e?.decoration) {
            case "gradient":
              return {
                background: `radial-gradient(49.63% 57.02% at 58.99% -7.2%, rgba(${(0, n.uu)(t)}, 0.1) 39.4%, rgba(0, 0, 0, 0) 100%)`,
                className: "h-[64rem]",
              };
            case "grid":
              return {
                background: `radial-gradient(49.63% 57.02% at 58.99% -7.2%, rgba(${(0, n.uu)(t)}, 0.1) 39.4%, rgba(0, 0, 0, 0) 100%)`,
                className: "h-[64rem]",
                children: (0, a.jsxs)("svg", {
                  width: "918",
                  height: "560",
                  viewBox: "0 0 918 591",
                  fill: "none",
                  xmlns: "http://www.w3.org/2000/svg",
                  className: "absolute pl-48 -top-16 left-1/2 -translate-x-1/2",
                  children: [
                    (0, a.jsx)("mask", {
                      id: `mask-${r}`,
                      maskUnits: "userSpaceOnUse",
                      style: { maskType: "alpha" },
                      x: "0",
                      y: "-80",
                      width: "936",
                      height: "671",
                      children: (0, a.jsx)("ellipse", {
                        cx: "468.373",
                        cy: "255.536",
                        rx: "467.627",
                        ry: "335.114",
                        fill: `url(#radial-${r})`,
                      }),
                    }),
                    (0, a.jsx)("g", {
                      mask: `url(#mask-${r})`,
                      children: (0, a.jsx)("path", {
                        fillRule: "evenodd",
                        clipRule: "evenodd",
                        d: "M-64.8616 -138.566L1001.61 -138.566V-139.566L-64.8616 -139.566L-64.8616 -138.566ZM73.7705 589.928V649.243H74.7705V589.928H134.479V649.243H135.479V589.928H195.187V649.243H196.187V589.928H255.895V649.243H256.895V589.928H316.603V649.243H317.603V589.928H377.311V649.243H378.311V589.928H438.019V649.243H439.019V589.928L498.727 589.928V649.243H499.727V589.928H559.435V649.243H560.435V589.928H620.143V649.243H621.143V589.928H680.851V649.243H681.851V589.928H741.559V649.243H742.559V589.928H802.267V649.243H803.267V589.928H862.975V649.243H863.975V589.928H1001.61V588.928H863.975V529.221H1001.61V528.221H863.975V468.512H1001.61V467.512H863.975V407.805H1001.61V406.805H863.975V347.097H1001.61V346.097H863.975V286.39H1001.61V285.39H863.975V225.681H1001.61V224.681H863.975V164.974H1001.61V163.974H863.975V104.266H1001.61V103.266H863.975V43.5572H1001.61V42.5572H863.975V-17.152H1001.61V-18.152H863.975V-77.8592L1001.61 -77.8593V-78.8593L863.975 -78.8592V-137.177H862.975V-78.8592H803.267V-137.177H802.267V-78.8592H742.559V-137.177H741.559V-78.8592L681.851 -78.8592V-137.177H680.851V-78.8592H621.143V-137.177H620.143V-78.8592H560.435V-137.177H559.435V-78.8592L499.727 -78.8592V-137.177H498.727V-78.8592H439.019V-137.177H438.019V-78.8592L378.311 -78.8592V-137.177H377.311V-78.8592H317.603V-137.177H316.603V-78.8592H256.895V-137.177H255.895V-78.8592L196.187 -78.8592V-137.177H195.187V-78.8592H135.479V-137.177H134.479V-78.8592H74.7706V-137.177H73.7706V-78.8592L-64.862 -78.8592L-64.862 -77.8592L73.7706 -77.8592L73.7705 -18.152H-64.8617L-64.8617 -17.152H73.7705V42.5572H-64.8621L-64.8621 43.5572H73.7705V103.267H-64.8618L-64.8618 104.267H73.7705V163.974H-64.8622L-64.8622 164.974H73.7705V224.681H-64.8619L-64.8619 225.681H73.7705V285.39H-64.8623L-64.8623 286.39H73.7705V346.097H-64.862L-64.862 347.097H73.7705V406.805H-64.8617L-64.8617 407.805H73.7705V467.512H-64.8614L-64.8614 468.512H73.7705V528.221H-64.8618L-64.8618 529.221H73.7705V588.928H-64.8622L-64.8622 589.928H73.7705ZM803.267 -77.8592H862.975V-18.152L803.267 -18.152V-77.8592ZM742.559 -77.8592H802.267V-18.152H742.559V-77.8592ZM681.851 -77.8592L741.559 -77.8592V-18.152H681.851V-77.8592ZM621.143 -77.8592H680.851V-18.152H621.143V-77.8592ZM560.435 -77.8592H620.143V-18.152H560.435L560.435 -77.8592ZM499.727 -77.8592L559.435 -77.8592L559.435 -18.152H499.727L499.727 -77.8592ZM439.019 -77.8592H498.727L498.727 -18.152L439.019 -18.152L439.019 -77.8592ZM378.311 -77.8592L438.019 -77.8592L438.019 -18.152H378.311L378.311 -77.8592ZM317.603 -77.8592H377.311L377.311 -18.152H317.603L317.603 -77.8592ZM256.895 -77.8592H316.603L316.603 -18.152H256.895L256.895 -77.8592ZM196.187 -77.8592L255.895 -77.8592L255.895 -18.152H196.187L196.187 -77.8592ZM135.479 -77.8592H195.187L195.187 -18.152H135.479L135.479 -77.8592ZM74.7706 -77.8592H134.479L134.479 -18.152L74.7705 -18.152L74.7706 -77.8592ZM74.7705 -17.152V42.5572H134.479V-17.152L74.7705 -17.152ZM135.479 -17.152V42.5572H195.187V-17.152H135.479ZM196.187 -17.152V42.5572L255.895 42.5572V-17.152H196.187ZM256.895 -17.152V42.5572H316.603V-17.152H256.895ZM317.603 -17.152V42.5572H377.311V-17.152H317.603ZM378.311 -17.152V42.5572H438.019V-17.152H378.311ZM439.019 -17.152V42.5572H498.727V-17.152L439.019 -17.152ZM499.727 -17.152V42.5572H559.435V-17.152H499.727ZM560.435 -17.152V42.5572H620.143V-17.152H560.435ZM621.143 -17.152V42.5572H680.851V-17.152H621.143ZM681.851 -17.152V42.5572L741.559 42.5572V-17.152H681.851ZM742.559 -17.152V42.5572H802.267V-17.152H742.559ZM803.267 -17.152V42.5572H862.975V-17.152L803.267 -17.152ZM803.267 43.5572H862.975V103.266H803.267V43.5572ZM742.559 43.5572H802.267V103.266H742.559V43.5572ZM681.851 43.5572L741.559 43.5572V103.266L681.851 103.266V43.5572ZM621.143 43.5572H680.851V103.266H621.143V43.5572ZM560.435 43.5572H620.143V103.266H560.435V43.5572ZM499.727 43.5572H559.435V103.266H499.727V43.5572ZM439.019 43.5572H498.727V103.266H439.019V43.5572ZM378.311 43.5572H438.019V103.266H378.311V43.5572ZM317.603 43.5572H377.311V103.266H317.603V43.5572ZM256.895 43.5572H316.603V103.266H256.895V43.5572ZM196.187 43.5572L255.895 43.5572V103.266L196.187 103.267V43.5572ZM135.479 43.5572H195.187V103.267H135.479V43.5572ZM74.7705 43.5572H134.479V103.267H74.7705V43.5572ZM74.7705 104.267V163.974H134.479V104.267H74.7705ZM135.479 104.267V163.974H195.187V104.267H135.479ZM196.187 104.267V163.974H255.895V104.266L196.187 104.267ZM256.895 104.266V163.974H316.603V104.266H256.895ZM317.603 104.266V163.974H377.311V104.266H317.603ZM378.311 104.266V163.974H438.019V104.266H378.311ZM439.019 104.266V163.974L498.727 163.974V104.266H439.019ZM499.727 104.266V163.974H559.435V104.266H499.727ZM560.435 104.266V163.974H620.143V104.266H560.435ZM621.143 104.266V163.974H680.851V104.266H621.143ZM681.851 104.266V163.974H741.559V104.266L681.851 104.266ZM742.559 104.266V163.974H802.267V104.266H742.559ZM803.267 104.266V163.974H862.975V104.266H803.267ZM803.267 164.974H862.975V224.681H803.267V164.974ZM742.559 164.974H802.267V224.681H742.559V164.974ZM681.851 164.974H741.559V224.681H681.851V164.974ZM621.143 164.974H680.851V224.681H621.143V164.974ZM560.435 164.974H620.143V224.681H560.435V164.974ZM499.727 164.974H559.435V224.681H499.727V164.974ZM439.019 164.974L498.727 164.974V224.681L439.019 224.681V164.974ZM378.311 164.974H438.019V224.681H378.311V164.974ZM317.603 164.974H377.311V224.681H317.603V164.974ZM256.895 164.974H316.603V224.681H256.895V164.974ZM196.187 164.974H255.895V224.681H196.187V164.974ZM135.479 164.974H195.187V224.681H135.479V164.974ZM74.7705 164.974H134.479V224.681H74.7705V164.974ZM74.7705 225.681V285.39H134.479V225.681H74.7705ZM135.479 225.681V285.39H195.187V225.681H135.479ZM196.187 225.681V285.39H255.895V225.681H196.187ZM256.895 225.681V285.39H316.603V225.681H256.895ZM317.603 225.681V285.39H377.311V225.681H317.603ZM378.311 225.681V285.39H438.019V225.681H378.311ZM439.019 225.681V285.39L498.727 285.39V225.681L439.019 225.681ZM499.727 225.681V285.39H559.435V225.681H499.727ZM560.435 225.681V285.39H620.143V225.681H560.435ZM621.143 225.681V285.39H680.851V225.681H621.143ZM681.851 225.681V285.39H741.559V225.681H681.851ZM742.559 225.681V285.39H802.267V225.681H742.559ZM803.267 225.681V285.39H862.975V225.681H803.267ZM803.267 286.39H862.975V346.097H803.267V286.39ZM742.559 286.39H802.267V346.097H742.559V286.39ZM681.851 286.39H741.559V346.097H681.851V286.39ZM621.143 286.39H680.851V346.097H621.143V286.39ZM560.435 286.39H620.143V346.097H560.435V286.39ZM499.727 286.39H559.435V346.097H499.727V286.39ZM439.019 286.39L498.727 286.39V346.097L439.019 346.097V286.39ZM378.311 286.39H438.019V346.097H378.311V286.39ZM317.603 286.39H377.311V346.097H317.603V286.39ZM256.895 286.39H316.603V346.097H256.895V286.39ZM196.187 286.39H255.895V346.097H196.187V286.39ZM135.479 286.39H195.187V346.097H135.479V286.39ZM74.7705 286.39H134.479V346.097H74.7705V286.39ZM74.7705 347.097V406.805H134.479V347.097H74.7705ZM135.479 347.097V406.805H195.187V347.097H135.479ZM196.187 347.097V406.805H255.895V347.097H196.187ZM256.895 347.097V406.805H316.603V347.097H256.895ZM317.603 347.097V406.805H377.311V347.097H317.603ZM378.311 347.097V406.805H438.019V347.097H378.311ZM439.019 347.097V406.805L498.727 406.805V347.097L439.019 347.097ZM499.727 347.097V406.805H559.435V347.097H499.727ZM560.435 347.097V406.805H620.143V347.097H560.435ZM621.143 347.097V406.805H680.851V347.097H621.143ZM681.851 347.097V406.805H741.559V347.097H681.851ZM742.559 347.097V406.805H802.267V347.097H742.559ZM803.267 347.097V406.805H862.975V347.097H803.267ZM803.267 407.805H862.975V467.512H803.267V407.805ZM742.559 407.805H802.267V467.512H742.559V407.805ZM681.851 407.805H741.559V467.512H681.851V407.805ZM621.143 407.805H680.851V467.512H621.143V407.805ZM560.435 407.805H620.143V467.512H560.435V407.805ZM499.727 407.805H559.435V467.512H499.727V407.805ZM439.019 407.805L498.727 407.805V467.512L439.019 467.512V407.805ZM378.311 407.805H438.019V467.512H378.311V407.805ZM317.603 407.805H377.311V467.512H317.603V407.805ZM256.895 407.805H316.603V467.512H256.895V407.805ZM196.187 407.805H255.895V467.512H196.187V407.805ZM135.479 407.805H195.187V467.512H135.479V407.805ZM74.7705 407.805H134.479V467.512H74.7705V407.805ZM74.7705 468.512V528.221H134.479V468.512H74.7705ZM135.479 468.512V528.221H195.187V468.512H135.479ZM196.187 468.512V528.221H255.895V468.512H196.187ZM256.895 468.512V528.221H316.603V468.512H256.895ZM317.603 468.512V528.221H377.311V468.512H317.603ZM378.311 468.512V528.221H438.019V468.512H378.311ZM439.019 468.512V528.221L498.727 528.221V468.512L439.019 468.512ZM499.727 468.512V528.221H559.435V468.512H499.727ZM560.435 468.512V528.221H620.143V468.512H560.435ZM621.143 468.512V528.221H680.851V468.512H621.143ZM681.851 468.512V528.221H741.559V468.512H681.851ZM742.559 468.512V528.221H802.267V468.512H742.559ZM803.267 468.512V528.221H862.975V468.512H803.267ZM803.267 529.221H862.975V588.928H803.267V529.221ZM742.559 529.221H802.267V588.928H742.559V529.221ZM681.851 529.221H741.559V588.928H681.851V529.221ZM621.143 529.221H680.851V588.928H621.143V529.221ZM560.435 529.221H620.143V588.928H560.435V529.221ZM499.727 529.221H559.435V588.928H499.727V529.221ZM439.019 529.221L498.727 529.221V588.928L439.019 588.928V529.221ZM378.311 529.221H438.019V588.928H378.311V529.221ZM317.603 529.221H377.311V588.928H317.603V529.221ZM256.895 529.221H316.603V588.928H256.895V529.221ZM196.187 529.221H255.895V588.928H196.187V529.221ZM135.479 529.221H195.187V588.928H135.479V529.221ZM74.7705 529.221H134.479V588.928H74.7705V529.221ZM1001.61 650.637L-64.862 650.638L-64.862 649.638L1001.61 649.637V650.637Z",
                        className: "fill-primary dark:fill-primary-light",
                        fillOpacity: "0.08",
                      }),
                    }),
                    (0, a.jsx)("defs", {
                      children: (0, a.jsxs)("radialGradient", {
                        id: `radial-${r}`,
                        cx: "0",
                        cy: "0",
                        r: "1",
                        gradientUnits: "userSpaceOnUse",
                        gradientTransform:
                          "translate(468.373 255.536) rotate(90) scale(335.114 467.627)",
                        children: [
                          (0, a.jsx)("stop", { stopColor: "#D9D9D9" }),
                          (0, a.jsx)("stop", { offset: "1", stopOpacity: "0" }),
                        ],
                      }),
                    }),
                  ],
                }),
              };
            case "windows":
              return {
                background: `radial-gradient(49.63% 57.02% at 58.99% -7.2%, rgba(${(0, n.uu)(t)}, 0.1) 39.4%, rgba(0, 0, 0, 0) 100%)`,
                className: "h-[64rem]",
                children: (0, a.jsxs)("svg", {
                  width: "790",
                  height: "640",
                  viewBox: "0 0 790 718",
                  fill: "none",
                  xmlns: "http://www.w3.org/2000/svg",
                  className: "absolute pl-48 -top-16 left-1/2 -translate-x-1/2",
                  children: [
                    (0, a.jsx)("mask", {
                      id: `mask-${r}`,
                      style: { maskType: "alpha" },
                      maskUnits: "userSpaceOnUse",
                      x: "0",
                      y: "-143",
                      width: "936",
                      height: "861",
                      children: (0, a.jsx)("ellipse", {
                        cx: "468.373",
                        cy: "287.536",
                        rx: "467.627",
                        ry: "430.464",
                        fill: `url(#radial-${r})`,
                      }),
                    }),
                    (0, a.jsxs)("g", {
                      mask: `url(#mask-${r})`,
                      className: "fill-primary dark:fill-primary-light",
                      children: [
                        (0, a.jsx)("path", {
                          d: "M506.419 281.855L446.417 297.931V359.885L506.419 343.71V281.855Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M384.768 188.752L324.766 204.828V266.781L384.768 250.606V188.752Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M263.625 347.002L203.623 363.078V425.031L263.625 408.856V347.002Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M385.089 440.096L325.087 456.172V518.125L385.089 501.95V440.096Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M627.756 123.527L567.754 139.603V201.557L627.756 185.382V123.527Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M445.32 46.918L385.318 62.994V124.947L445.32 108.772V46.918Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M749.192 279.59L689.19 295.666V357.619L749.192 341.444V279.59Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M627.905 437.912L567.903 453.988V515.941L627.905 499.766V437.912Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          d: "M202.491 175.656L142.489 191.732V253.685L202.491 237.511V175.656Z",
                          fillOpacity: "0.05",
                        }),
                        (0, a.jsx)("path", {
                          fillRule: "evenodd",
                          clipRule: "evenodd",
                          d: "M446.54 -79.1784L949.537 -213.956L949.278 -214.922L446.54 -80.2137V-87.9997H445.54V-79.9457L385.832 -63.947V-87.9997H384.832V-63.679L325.124 -47.6803V-87.9997H324.124V-47.4124L264.416 -31.4137V-87.9997H263.416V-31.1457L203.708 -15.147L203.708 -87.9997H202.708L202.708 -14.8791L143 1.11966L143 -87.9997H142L142 1.3876L-80.8521 61.1006L-80.5932 62.0666L142 2.42287V64.2363L-65.1402 119.739L-64.8814 120.705L142 65.2715L142 127.085L-49.4278 178.378L-49.1689 179.344L142 128.12V189.936L-33.7155 237.019L-33.4566 237.985L142 190.971V252.787L-18.0025 295.659L-17.7437 296.625L142 253.822V315.635L-2.29068 354.298L-2.03186 355.264L142 316.671V378.484L13.4218 412.937L13.6806 413.903L142 379.519V441.335L29.1341 471.577L29.3929 472.543L142 442.37V504.184L44.8466 530.216L45.1054 531.182L142 505.219V567.032L60.5591 588.855L60.8179 589.82L142 568.068V629.881L76.2715 647.493L76.5303 648.459L142 630.917V692.732L91.9838 706.134L92.2426 707.1L142 693.767V698.42H143V693.499L202.708 677.501V698.42H203.708V677.233L263.416 661.234V698.42H264.416V660.966L324.124 644.967V698.42H325.124V644.699L384.832 628.701V690.514L107.696 764.773L107.954 765.738L384.832 691.549V698.42H385.832V691.281L445.54 675.283V698.42H446.54V675.015L506.248 659.016V698.42H507.248V658.748L566.956 642.749V698.42H567.956V642.481L627.664 626.483V688.298L123.409 823.413L123.667 824.379L627.664 689.334V698.42H628.664V689.066L688.372 673.067V698.42H689.372V672.799L749.08 656.8V698.42H750.08V656.532L809.788 640.534V698.42H810.788V640.266L870.496 624.267V698.42H871.496V623.999L931.204 608V698.42H932.204V607.732L1153.8 548.357L1153.54 547.391L932.204 606.697V544.881L1138.08 489.716L1137.83 488.75L932.204 543.846V482.033L1122.37 431.077L1122.11 430.111L932.204 480.997V419.182L1106.66 372.437L1106.4 371.471L932.204 418.147V356.333L1090.95 313.798L1090.69 312.832L932.204 355.298V293.484L1075.24 255.159L1074.98 254.193L932.204 292.449V230.636L1059.52 196.521L1059.26 195.555L932.204 229.6V167.785L1043.81 137.88L1043.55 136.914L932.204 166.75V104.936L1028.1 79.2413L1027.84 78.2754L932.204 103.901V42.0874L1012.39 20.6027L1012.13 19.6367L932.204 41.0522V-20.7634L996.674 -38.0379L996.415 -39.0039L932.204 -21.7987L932.204 -83.6142L980.961 -96.6786L980.702 -97.6445L932.204 -84.6495V-87.9997H931.204V-84.3815L871.496 -68.3828V-87.9997H870.496V-68.1149L810.788 -52.1161V-87.9997H809.788V-51.8482L750.08 -35.8495V-87.9997H749.08V-35.5815L689.372 -19.5828L689.372 -81.3963L965.249 -155.317L964.99 -156.283L689.372 -82.4316V-87.9997H688.372V-82.1637L628.664 -66.1649V-87.9997H627.664V-65.897L567.956 -49.8983V-87.9997H566.956V-49.6303L507.248 -33.6316V-87.9997H506.248V-33.3637L446.54 -17.365L446.54 -79.1784ZM445.54 -78.9104L385.832 -62.9117L385.832 -1.09831L445.54 -17.097L445.54 -78.9104ZM384.832 -62.6438L325.124 -46.6451L325.124 15.1684L384.832 -0.830353L384.832 -62.6438ZM324.124 -46.3771L264.416 -30.3784L264.416 31.435L324.124 15.4363L324.124 -46.3771ZM263.416 -30.1104L203.708 -14.1117V47.7017L263.416 31.703L263.416 -30.1104ZM202.708 -13.8438L143 2.15492V63.9683L202.708 47.9696V-13.8438ZM628.664 -65.1297L688.372 -81.1284L688.372 -19.3149L628.664 -3.31616L628.664 -65.1297ZM567.956 -48.863L627.664 -64.8617L627.664 -3.04822L567.956 12.9505L567.956 -48.863ZM507.248 -32.5964L566.956 -48.5951L566.956 13.2184L507.248 29.2172L507.248 -32.5964ZM446.54 -16.3297L506.248 -32.3284L506.248 29.4851L446.54 45.4838V-16.3297ZM385.832 -0.0630493L445.54 -16.0618V45.7517L385.832 61.7505V-0.0630493ZM325.124 16.2036L384.832 0.20491V62.0184L325.124 78.0171V16.2036ZM264.416 32.4703L324.124 16.4716V78.2851L264.416 94.2838V32.4703ZM203.708 48.7369L263.416 32.7382V94.5517L203.708 110.55V48.7369ZM143 65.0036L202.708 49.0049V110.818L143 126.817L143 65.0036ZM931.204 -83.3463L871.496 -67.3475L871.496 -5.53207L931.204 -21.5308L931.204 -83.3463ZM870.496 -67.0796L810.788 -51.0809L810.788 10.7346L870.496 -5.26411L870.496 -67.0796ZM809.788 -50.8129L750.08 -34.8142L750.08 27.0013L809.788 11.0025L809.788 -50.8129ZM749.08 -34.5463L689.372 -18.5476V43.2679L749.08 27.2692L749.08 -34.5463ZM688.372 -18.2796L628.664 -2.2809V59.5346L688.372 43.5359V-18.2796ZM627.664 -2.01295L567.956 13.9858V75.8012L627.664 59.8025V-2.01295ZM566.956 14.2537L507.248 30.2524V92.0679L566.956 76.0692V14.2537ZM506.248 30.5204L446.54 46.5191V108.335L506.248 92.3358V30.5204ZM445.54 46.787L385.832 62.7857V124.601L445.54 108.603V46.787ZM384.832 63.0537L325.124 79.0524V140.868L384.832 124.869V63.0537ZM324.124 79.3203L264.416 95.319V157.135L324.124 141.136V79.3203ZM263.416 95.587L203.708 111.586V173.401L263.416 157.402V95.587ZM202.708 111.854L143 127.852V189.668L202.708 173.669V111.854ZM871.496 -4.49677L931.204 -20.4955V41.3201L871.496 57.3188V-4.49677ZM810.788 11.7699L870.496 -4.22882V57.5868L810.788 73.5855V11.7699ZM750.08 28.0365L809.788 12.0378V73.8534L750.08 89.8521V28.0365ZM689.372 44.3032L749.08 28.3045V90.1201L689.372 106.119V44.3032ZM628.664 60.5699L688.372 44.5711V106.387L628.664 122.385V60.5699ZM567.956 76.8365L627.664 60.8378V122.653L567.956 138.652V76.8365ZM507.248 93.1032L566.956 77.1045V138.92L507.248 154.919V93.1032ZM446.54 109.37L506.248 93.3711V155.187L446.54 171.185V109.37ZM385.832 125.636L445.54 109.638V171.453L385.832 187.452V125.636ZM325.124 141.903L384.832 125.904V187.72L325.124 203.719V141.903ZM264.416 158.17L324.124 142.171V203.987L264.416 219.985V158.17ZM203.708 174.436L263.416 158.438V220.253L203.708 236.252V174.436ZM143 190.703L202.708 174.704V236.52L143 252.519V190.703ZM143 253.554V315.367L202.708 299.369V237.555L143 253.554ZM203.708 237.287V299.101L263.416 283.102V221.289L203.708 237.287ZM264.416 221.021V282.834L324.124 266.835V205.022L264.416 221.021ZM325.124 204.754V266.567L384.832 250.569V188.755L325.124 204.754ZM385.832 188.487V250.301L445.54 234.302V172.489L385.832 188.487ZM446.54 172.221V234.034L506.248 218.035V156.222L446.54 172.221ZM507.248 155.954V217.767L566.956 201.769V139.955L507.248 155.954ZM567.956 139.687V201.501L627.664 185.502V123.689L567.956 139.687ZM628.664 123.421V185.234L688.372 169.235V107.422L628.664 123.421ZM689.372 107.154V168.967L749.08 152.969V91.1554L689.372 107.154ZM750.08 90.8874V152.701L809.788 136.702V74.8887L750.08 90.8874ZM810.788 74.6208V136.434L870.496 120.435V58.622L810.788 74.6208ZM871.496 58.3541V120.167L931.204 104.169V42.3554L871.496 58.3541ZM871.496 121.203L931.204 105.204V167.018L871.496 183.016V121.203ZM810.788 137.469L870.496 121.471V183.284L810.788 199.283V137.469ZM750.08 153.736L809.788 137.737V199.551L750.08 215.55V153.736ZM689.372 170.003L749.08 154.004V215.818L689.372 231.816V170.003ZM628.664 186.269L688.372 170.271V232.084L628.664 248.083V186.269ZM567.956 202.536L627.664 186.537V248.351L567.956 264.35V202.536ZM507.248 218.803L566.956 202.804V264.617L507.248 280.616V218.803ZM446.54 235.069L506.248 219.071V280.884L446.54 296.883V235.069ZM385.832 251.336L445.54 235.337V297.151L385.832 313.15V251.336ZM325.124 267.603L384.832 251.604V313.417L325.124 329.416V267.603ZM264.416 283.869L324.124 267.871V329.684L264.416 345.683V283.869ZM203.708 300.136L263.416 284.137V345.951L203.708 361.95V300.136ZM143 316.403L202.708 300.404V362.217L143 378.216V316.403ZM143 379.251V441.067L202.708 425.068V363.253L143 379.251ZM203.708 362.985V424.8L263.416 408.802V346.986L203.708 362.985ZM264.416 346.718V408.534L324.124 392.535V330.719L264.416 346.718ZM325.124 330.451V392.267L384.832 376.268V314.453L325.124 330.451ZM385.832 314.185V376L445.54 360.002V298.186L385.832 314.185ZM446.54 297.918V359.734L506.248 343.735V281.919L446.54 297.918ZM507.248 281.651V343.467L566.956 327.468V265.653L507.248 281.651ZM567.956 265.385V327.2L627.664 311.202V249.386L567.956 265.385ZM628.664 249.118V310.934L688.372 294.935V233.119L628.664 249.118ZM689.372 232.852V294.667L749.08 278.668V216.853L689.372 232.852ZM750.08 216.585V278.4L809.788 262.402V200.586L750.08 216.585ZM810.788 200.318V262.134L870.496 246.135V184.319L810.788 200.318ZM871.496 184.052V245.867L931.204 229.868V168.053L871.496 184.052ZM871.496 246.902L931.204 230.904V292.717L871.496 308.716V246.902ZM810.788 263.169L870.496 247.17V308.984L810.788 324.982V263.169ZM750.08 279.436L809.788 263.437V325.25L750.08 341.249V279.436ZM689.372 295.702L749.08 279.704V341.517L689.372 357.516V295.702ZM628.664 311.969L688.372 295.97V357.784L628.664 373.782V311.969ZM567.956 328.236L627.664 312.237V374.05L567.956 390.049V328.236ZM507.248 344.502L566.956 328.504V390.317L507.248 406.316V344.502ZM446.54 360.769L506.248 344.77V406.584L446.54 422.582V360.769ZM385.832 377.036L445.54 361.037V422.85L385.832 438.849V377.036ZM325.124 393.302L384.832 377.304V439.117L325.124 455.116V393.302ZM264.416 409.569L324.124 393.57V455.384L264.416 471.382V409.569ZM203.708 425.836L263.416 409.837V471.65L203.708 487.649V425.836ZM143 442.102L202.708 426.104V487.917L143 503.916V442.102ZM143 504.951V566.765L202.708 550.766V488.952L143 504.951ZM203.708 488.684V550.498L263.416 534.499V472.686L203.708 488.684ZM264.416 472.418V534.231L324.124 518.232V456.419L264.416 472.418ZM325.124 456.151V517.965L384.832 501.966V440.152L325.124 456.151ZM385.832 439.884V501.698L445.54 485.699V423.886L385.832 439.884ZM446.54 423.618V485.431L506.248 469.433V407.619L446.54 423.618ZM507.248 407.351V469.165L566.956 453.166V391.352L507.248 407.351ZM567.956 391.084V452.898L627.664 436.899V375.086L567.956 391.084ZM628.664 374.818V436.631L688.372 420.633V358.819L628.664 374.818ZM689.372 358.551V420.365L749.08 404.366V342.552L689.372 358.551ZM750.08 342.284V404.098L809.788 388.099V326.286L750.08 342.284ZM810.788 326.018V387.831L870.496 371.833V310.019L810.788 326.018ZM871.496 309.751V371.565L931.204 355.566V293.752L871.496 309.751ZM871.496 372.6L931.204 356.601V418.415L871.496 434.413V372.6ZM810.788 388.867L870.496 372.868V434.681L810.788 450.68V388.867ZM750.08 405.133L809.788 389.135V450.948L750.08 466.947V405.133ZM689.372 421.4L749.08 405.401V467.215L689.372 483.213V421.4ZM628.664 437.667L688.372 421.668V483.481L628.664 499.48V437.667ZM567.956 453.933L627.664 437.935V499.748L567.956 515.747V453.933ZM507.248 470.2L566.956 454.201V516.015L507.248 532.013V470.2ZM446.54 486.467L506.248 470.468V532.281L446.54 548.28V486.467ZM385.832 502.733L445.54 486.734V548.548L385.832 564.547V502.733ZM325.124 519L384.832 503.001V564.815L325.124 580.813V519ZM264.416 535.267L324.124 519.268V581.081L264.416 597.08V535.267ZM203.708 551.533L263.416 535.534V597.348L203.708 613.347V551.533ZM143 567.8L202.708 551.801V613.615L143 629.613V567.8ZM143 630.649V692.464L202.708 676.465V614.65L143 630.649ZM203.708 614.382V676.197L263.416 660.199V598.383L203.708 614.382ZM264.416 598.115V659.931L324.124 643.932V582.117L264.416 598.115ZM325.124 581.849V643.664L384.832 627.665V565.85L325.124 581.849ZM385.832 565.582V627.397L445.54 611.399V549.583L385.832 565.582ZM446.54 549.315V611.131L506.248 595.132V533.317L446.54 549.315ZM507.248 533.049V594.864L566.956 578.865V517.05L507.248 533.049ZM567.956 516.782V578.597L627.664 562.599V500.783L567.956 516.782ZM628.664 500.515V562.331L688.372 546.332V484.517L628.664 500.515ZM689.372 484.249V546.064L749.08 530.065V468.25L689.372 484.249ZM750.08 467.982V529.797L809.788 513.799V451.983L750.08 467.982ZM810.788 451.715V513.531L870.496 497.532V435.717L810.788 451.715ZM871.496 435.449V497.264L931.204 481.265V419.45L871.496 435.449ZM385.832 690.246V628.433L445.54 612.434V674.247L385.832 690.246ZM446.54 673.979V612.166L506.248 596.167V657.981L446.54 673.979ZM507.248 657.713V595.899L566.956 579.901V641.714L507.248 657.713ZM567.956 641.446V579.633L627.664 563.634V625.447L567.956 641.446ZM628.664 625.18V563.366L688.372 547.367V609.181L628.664 625.18ZM689.372 608.913V547.099L749.08 531.101V592.914L689.372 608.913ZM750.08 592.646V530.833L809.788 514.834V576.647L750.08 592.646ZM810.788 576.38V514.566L870.496 498.567V560.381L810.788 576.38ZM871.496 560.113V498.299L931.204 482.301V544.114L871.496 560.113ZM628.664 626.215V688.03L688.372 672.032V610.216L628.664 626.215ZM689.372 609.948V671.764L749.08 655.765V593.949L689.372 609.948ZM750.08 593.681V655.497L809.788 639.498V577.683L750.08 593.681ZM810.788 577.415V639.23L870.496 623.232V561.416L810.788 577.415ZM871.496 561.148V622.964L931.204 606.965V545.149L871.496 561.148Z",
                          fillOpacity: "0.1",
                        }),
                      ],
                    }),
                    (0, a.jsx)("defs", {
                      children: (0, a.jsxs)("radialGradient", {
                        id: `radial-${r}`,
                        cx: "0",
                        cy: "0",
                        r: "1",
                        gradientUnits: "userSpaceOnUse",
                        gradientTransform:
                          "translate(468.373 287.536) rotate(90) scale(430.464 467.627)",
                        children: [
                          (0, a.jsx)("stop", { stopColor: "#D9D9D9" }),
                          (0, a.jsx)("stop", { offset: "1", stopOpacity: "0" }),
                        ],
                      }),
                    }),
                  ],
                }),
              };
            default:
              return { background: void 0 };
          }
        },
        x = ({ docsConfig: e }) => {
          let t = (0, c.C)(e);
          if (null == e.background) {
            return null;
          }
          let r = d(e.background, t.primary, "light"),
            n = d(e.background, t.primaryLight, "dark");
          return null == r || null == n
            ? null
            : (0, a.jsxs)(a.Fragment, {
                children: [
                  (0, a.jsx)("span", {
                    className: (0, o.cn)(
                      "block absolute dark:hidden inset-0 overflow-hidden pointer-events-none",
                      r.className,
                    ),
                    style: { background: r.background },
                    children: r.children,
                  }),
                  (0, a.jsx)("span", {
                    className: (0, o.cn)(
                      "hidden absolute dark:block inset-0 overflow-hidden pointer-events-none",
                      n.className,
                    ),
                    style: { background: n.background },
                    children: n.children,
                  }),
                ],
              });
        },
        u = ({ backgroundImage: e, className: t }) =>
          (0, a.jsx)("span", {
            className: (0, o.cn)("fixed inset-0 pointer-events-none", t),
            style: {
              backgroundImage: `url('${e}')`,
              backgroundRepeat: "no-repeat",
              backgroundPosition: "top right",
              backgroundAttachment: "fixed",
              WebkitTouchCallout: "none",
            },
          }),
        m = ({ docsConfig: e, pageMetadata: t, className: r }) => {
          let { isLivePreview: n, getDocsConfigOverrides: c } = (0, l.useContext)(s.K),
            d = c(),
            m = n && d ? { ...e, ...d } : e,
            p = n && d?.background?.image !== void 0 ? d.background.image : e.background?.image,
            h = m.theme,
            g = "custom" === t.mode;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)("span", {
                className: (0, o.cn)(
                  "fixed inset-0 bg-background-light dark:bg-background-dark -z-10 pointer-events-none",
                  !g && "almond" === h && "bg-gray-950/[0.03] dark:bg-[#09090B]",
                  r,
                ),
                id: i.V.AlmondBackground,
              }),
              (0, a.jsx)(x, { docsConfig: m }),
              "string" == typeof p && (0, a.jsx)(u, { backgroundImage: p }),
              "object" == typeof p &&
                (0, a.jsxs)(a.Fragment, {
                  children: [
                    (0, a.jsx)(u, { backgroundImage: p.light, className: "dark:hidden" }),
                    (0, a.jsx)(u, { backgroundImage: p.dark, className: "hidden dark:block" }),
                  ],
                }),
            ],
          });
        };
    },
  },
]);
