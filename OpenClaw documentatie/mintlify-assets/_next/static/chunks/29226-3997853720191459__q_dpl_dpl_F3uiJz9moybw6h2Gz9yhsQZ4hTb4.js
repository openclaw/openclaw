(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [29226],
  {
    8705: (e, t, r) => {
      "use strict";
      r.d(t, { WidgetTrigger: () => I });
      var s = r(54568),
        n = r(93407),
        a = r(7620),
        i = r(62987),
        o = r(35590),
        l = r(81325),
        c = r(12784),
        d = r(12598),
        u = r(19664),
        h = r.n(u),
        g = r(27194),
        m = r(67793),
        x = r(84342),
        p = r(12494),
        f = r(10614),
        y = r(7877);
      let v = ({ status: e, className: t }) => {
          let { Icon: r, label: n } = {
            added: { Icon: p.A, label: "Added file" },
            removed: { Icon: f.A, label: "Removed file" },
            modified: { Icon: y.A, label: "Modified file" },
          }[e];
          return (0, s.jsx)(r, {
            className: (0, l.cn)("size-3.5 text-inherit", t),
            "aria-label": n,
          });
        },
        b = ({ status: e }) => {
          let t = {
            added: {
              label: "Added",
              className: "bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-500",
            },
            removed: {
              label: "Removed",
              className: "bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-500",
            },
            modified: {
              label: "Modified",
              className: "bg-yellow-50 dark:bg-yellow-900/20 text-yellow-800 dark:text-yellow-500",
            },
          }[e];
          return (0, s.jsxs)("div", {
            className: (0, l.cn)(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-xs font-medium",
              t.className,
            ),
            role: "status",
            "aria-label": `File status: ${t.label}`,
            children: [
              (0, s.jsx)(v, { status: e, className: "shrink-0 size-2.5" }),
              (0, s.jsx)("span", { children: t.label }),
            ],
          });
        },
        j = ({ file: e }) => {
          let { setIsMenuOpen: t } = (0, a.useContext)(c.e),
            r = (0, g.G)(),
            n = (0, m.N)(r, e.path),
            i = "removed" === e.status,
            o = (0, l.cn)(
              "p-2 rounded-xl flex items-center gap-2 w-full disabled:cursor-not-allowed",
              n && "bg-[#F9F9F9] dark:bg-[#191A1B]",
              !i && "hover:bg-[#F9F9F9] dark:hover:bg-[#191A1B]",
            ),
            d = (0, s.jsxs)("div", {
              className: "flex items-center gap-2 min-w-0",
              children: [
                (0, s.jsx)("div", {
                  className: "w-[5rem] flex justify-start",
                  children: (0, s.jsx)(b, { status: e.status }),
                }),
                (0, s.jsx)("p", {
                  className: "text-sm text-left text-gray-900 dark:text-gray-100 truncate flex-1",
                  title: e.path,
                  children: e.path,
                }),
              ],
            });
          return i
            ? (0, s.jsx)("button", {
                className: o,
                disabled: !0,
                "aria-disabled": "true",
                children: d,
              })
            : (0, s.jsx)(h(), {
                href: (0, x.M)(e.path),
                prefetch: !0,
                className: o,
                onClick: () => t(!1),
                "aria-current": n ? "page" : void 0,
                children: d,
              });
        },
        k = () => {
          let { changedFiles: e, searchQuery: t } = (0, a.useContext)(c.e),
            r = (0, a.useMemo)(
              () =>
                ((e, t) => {
                  if (!t.trim()) {
                    return e;
                  }
                  let r = t
                    .trim()
                    .split("/")
                    .filter((e) => "" !== e)
                    .join("/")
                    .toLowerCase();
                  return e.filter((e) => {
                    let t = e.pageMetadata?.title?.toLowerCase().includes(r),
                      s = e.path.toLowerCase().includes(r);
                    return t || s;
                  });
                })(e, t),
              [e, t],
            );
          return (0, s.jsx)("div", {
            className: "flex flex-col overflow-y-auto flex-1 min-h-0 gap-px",
            role: "list",
            "aria-label": "Changed files",
            children:
              r.length > 0
                ? r.map((e) =>
                    (0, s.jsx)(
                      "div",
                      { role: "listitem", children: (0, s.jsx)(j, { file: e }) },
                      e.path,
                    ),
                  )
                : (0, s.jsx)("div", {
                    className: "flex flex-col items-center justify-center py-8 px-4",
                    role: "status",
                    children: (0, s.jsx)("p", {
                      className: "text-sm text-gray-500 dark:text-gray-400 text-center",
                      children: t.trim() ? "No files match your search" : "No file changes",
                    }),
                  }),
          });
        },
        w = () => {
          let { searchQuery: e, setSearchQuery: t, setIsMenuOpen: r } = (0, a.useContext)(c.e),
            n = (0, a.useRef)(null);
          return (
            (0, a.useEffect)(() => {
              let s = (s) => {
                "Escape" === s.key &&
                  n.current === document.activeElement &&
                  (e ? (s.preventDefault(), s.stopPropagation(), t("")) : r(!1));
              };
              return (
                document.addEventListener("keydown", s),
                () => document.removeEventListener("keydown", s)
              );
            }, [e, t, r]),
            (0, s.jsxs)("div", {
              className: "relative flex items-center w-full",
              children: [
                (0, s.jsx)("label", {
                  htmlFor: "preview-widget-search",
                  className: "sr-only",
                  children: "Search files",
                }),
                (0, s.jsx)("input", {
                  id: "preview-widget-search",
                  ref: n,
                  type: "text",
                  value: e,
                  onChange: (e) => t(e.target.value),
                  placeholder: "What are you looking for?",
                  "aria-label": "Search files",
                  className:
                    "flex-1 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 bg-transparent focus-within:outline-0",
                  autoFocus: !0,
                  autoComplete: "off",
                }),
              ],
            })
          );
        },
        N = () => {
          let {
            changedFiles: e,
            isSearchOpen: t,
            setIsSearchOpen: r,
            setSearchQuery: n,
          } = (0, a.useContext)(c.e);
          return (0, s.jsx)("div", {
            className: "flex flex-col min-h-0 flex-1",
            children: (0, s.jsx)("div", {
              className: "flex flex-col flex-1 min-h-0 transition-all duration-300 ease-out",
              children: (0, s.jsx)("div", {
                id: "files-panel",
                role: "tabpanel",
                "aria-labelledby": "files-tab",
                className: "flex flex-col flex-1 min-h-0",
                children: (0, s.jsxs)("div", {
                  className: "flex flex-col overflow-y-auto flex-1 min-h-0 p-2",
                  children: [
                    (0, s.jsxs)("div", {
                      className:
                        "flex items-center justify-between gap-2 px-2 pt-1.5 pb-3 shrink-0 text-sm text-gray-400 dark:text-gray-500",
                      children: [
                        t
                          ? (0, s.jsx)(w, {})
                          : (0, s.jsx)(s.Fragment, {
                              children: (0, s.jsxs)("span", {
                                className: "text-sm",
                                children: [
                                  e.length > 0 &&
                                    (0, s.jsx)("span", {
                                      "aria-label": `${e.length} files changed`,
                                      children: e.length,
                                    }),
                                  " ",
                                  e.length > 1 ? "files" : "file",
                                  " changed",
                                ],
                              }),
                            }),
                        (0, s.jsx)("button", {
                          onClick: () => {
                            (t && n(""), r(!t));
                          },
                          "aria-label": "Toggle search",
                          "aria-expanded": t,
                          children: t
                            ? (0, s.jsx)(d.A, { className: "size-4" })
                            : (0, s.jsx)(C, { className: "size-4" }),
                        }),
                      ],
                    }),
                    (0, s.jsx)(k, {}),
                  ],
                }),
              }),
            }),
          });
        },
        C = ({ className: e }) =>
          (0, s.jsxs)("svg", {
            width: "16",
            height: "16",
            viewBox: "0 0 16 16",
            fill: "none",
            xmlns: "http://www.w3.org/2000/svg",
            className: e,
            "aria-hidden": "true",
            children: [
              (0, s.jsx)("path", {
                d: "M13.5552 13.5552L10.0308 10.0308",
                stroke: "currentColor",
                strokeWidth: "1.5",
                strokeLinecap: "round",
                strokeLinejoin: "round",
              }),
              (0, s.jsx)("path", {
                d: "M6.88878 11.3332C9.34338 11.3332 11.3332 9.34338 11.3332 6.88878C11.3332 4.43418 9.34338 2.44434 6.88878 2.44434C4.43418 2.44434 2.44434 4.43418 2.44434 6.88878C2.44434 9.34338 4.43418 11.3332 6.88878 11.3332Z",
                stroke: "currentColor",
                strokeWidth: "1.5",
                strokeLinecap: "round",
                strokeLinejoin: "round",
              }),
            ],
          }),
        I = () => {
          let { isMenuOpen: e, setIsMenuOpen: t, searchQuery: r } = (0, a.useContext)(c.e),
            [d, u] = (0, a.useState)(!1);
          return (0, s.jsx)(i.Bc, {
            children: (0, s.jsxs)(o.AM, {
              open: e,
              onOpenChange: t,
              children: [
                (0, s.jsxs)(i.m_, {
                  delayDuration: 150,
                  open: d && !e,
                  children: [
                    (0, s.jsx)(i.k$, {
                      asChild: !0,
                      children: (0, s.jsx)(o.Wv, {
                        asChild: !0,
                        children: (0, s.jsx)("button", {
                          onClick: () => t(!e),
                          onPointerEnter: () => u(!0),
                          onPointerLeave: () => u(!1),
                          "aria-haspopup": "menu",
                          "aria-expanded": e,
                          "aria-label": "Preview Widget",
                          className: (0, l.cn)(
                            "overflow-hidden z-[999] flex touch-none fixed bottom-7 right-7 w-fit items-center justify-center rounded-full p-2 border border-gray-950/20 dark:border-white/20 size-12",
                            "bg-background-dark dark:bg-background-light dark:brightness-[1.5]",
                            "hover:bg-neutral-900 dark:hover:bg-neutral-100 aria-expanded:bg-neutral-900 dark:aria-expanded:bg-neutral-100",
                            "cursor-pointer active:scale-[93%] transition-height transition-[transform,background-color] duration-150 ease-in-out outline-offset-4",
                            "animate-[slide-up_0.8s_ease-out]",
                          ),
                          children: (0, s.jsx)(n.A, {
                            className: "size-5 text-white dark:text-gray-900",
                          }),
                        }),
                      }),
                    }),
                    (0, s.jsxs)(i.ZI, {
                      side: "left",
                      showArrow: !1,
                      className: "bg-background-dark dark:bg-background-light",
                      children: [
                        (0, s.jsx)(i.PR, {
                          className:
                            "[&_svg]:text-background-dark dark:[&_svg]:text-background-light",
                          arrowBgClassName: "bg-background-dark dark:bg-background-light",
                        }),
                        (0, s.jsx)("p", {
                          className: "text-xs text-white dark:text-gray-900",
                          children: "View changed files",
                        }),
                      ],
                    }),
                  ],
                }),
                (0, s.jsx)(o.hl, {
                  collisionPadding: 25,
                  onEscapeKeyDown: (e) => {
                    r && e.preventDefault();
                  },
                  className:
                    "outline-0 sm:w-[380px] p-0 min-h-[70px] max-h-[80vh] rounded-3xl bg-background-light dark:bg-background-dark border border-gray-50 dark:border-white/[0.08] flex flex-col backdrop-blur-xl shadow-2xl shadow-gray-900/5",
                  side: "top",
                  align: "end",
                  role: "dialog",
                  "aria-label": "Preview Widget Menu",
                  style: { boxShadow: "0px 0px 10px 0px rgba(0, 0, 0, 0.1)" },
                  children: (0, s.jsx)(N, {}),
                }),
              ],
            }),
          });
        };
    },
    12784: (e, t, r) => {
      "use strict";
      r.d(t, { PreviewWidgetProvider: () => i, e: () => a });
      var s = r(54568),
        n = r(7620);
      let a = (0, n.createContext)({
          changedFiles: [],
          isMenuOpen: !1,
          setIsMenuOpen: (e) => {},
          searchQuery: "",
          setSearchQuery: (e) => {},
          isSearchOpen: !1,
          setIsSearchOpen: (e) => {},
        }),
        i = ({ changedFiles: e, children: t }) => {
          let [r, i] = (0, n.useState)(!1),
            [o, l] = (0, n.useState)(""),
            [c, d] = (0, n.useState)(!1);
          return (0, s.jsx)(a.Provider, {
            value: {
              changedFiles: e,
              isMenuOpen: r,
              setIsMenuOpen: i,
              searchQuery: o,
              setSearchQuery: l,
              isSearchOpen: c,
              setIsSearchOpen: d,
            },
            children: t,
          });
        };
    },
    22904: (e, t, r) => {
      "use strict";
      r.d(t, { Gq: () => s, SO: () => n });
      let s = (e) => {
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
    24223: (e, t, r) => {
      "use strict";
      r.d(t, { RoundedVariables: () => i });
      var s = r(54568),
        n = r(7620),
        a = r(71252);
      function i({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, n.useContext)(a.K),
          i = r(),
          o = i?.theme;
        if ("linden" !== (t && o ? o : e)) {
          return null;
        }
        {
          let e = `:root {
      --rounded-sm: 4px;
      --rounded: 4px;
      --rounded-md: 4px;
      --rounded-lg: 4px;
      --rounded-xl: 4px;
      --rounded-xt: 4px;
      --rounded-2xl: 4px;
      --rounded-search: 4px;
      --rounded-3xl: 4px;
      --rounded-full: 4px;
  }`;
          return (0, s.jsx)("style", { children: e });
        }
      }
    },
    29226: (e, t, r) => {
      (Promise.resolve().then(r.bind(r, 34182)),
        Promise.resolve().then(r.bind(r, 42080)),
        Promise.resolve().then(r.bind(r, 12192)),
        Promise.resolve().then(r.bind(r, 30793)),
        Promise.resolve().then(r.bind(r, 83176)),
        Promise.resolve().then(r.bind(r, 71252)),
        Promise.resolve().then(r.bind(r, 92177)),
        Promise.resolve().then(r.bind(r, 68367)),
        Promise.resolve().then(r.bind(r, 76829)),
        Promise.resolve().then(r.bind(r, 96924)),
        Promise.resolve().then(r.bind(r, 54001)),
        Promise.resolve().then(r.bind(r, 51749)),
        Promise.resolve().then(r.bind(r, 17644)),
        Promise.resolve().then(r.bind(r, 49769)),
        Promise.resolve().then(r.bind(r, 62964)),
        Promise.resolve().then(r.bind(r, 35021)),
        Promise.resolve().then(r.bind(r, 69445)),
        Promise.resolve().then(r.bind(r, 8705)),
        Promise.resolve().then(r.bind(r, 12784)),
        Promise.resolve().then(r.bind(r, 24223)),
        Promise.resolve().then(r.bind(r, 89261)),
        Promise.resolve().then(r.bind(r, 12158)),
        Promise.resolve().then(r.bind(r, 76982)),
        Promise.resolve().then(r.bind(r, 3121)),
        Promise.resolve().then(r.bind(r, 41630)),
        Promise.resolve().then(r.t.bind(r, 45165, 23)),
        Promise.resolve().then(r.bind(r, 34071)),
        Promise.resolve().then(r.bind(r, 3625)));
    },
    34182: (e, t, r) => {
      "use strict";
      r.d(t, { HotReloader: () => i });
      var s = r(54568),
        n = r(27541),
        a = r(7620);
      let i = () => (
        (() => {
          let e = (0, n.useRouter)();
          (0, a.useEffect)(() => {
            let t,
              s = !1;
            return (
              (async () => {
                let { default: n } = await r.e(3831).then(r.bind(r, 3831));
                s ||
                  (console.warn("Connected to Socket.io"),
                  (t = n()).on("reload", () => {
                    (console.warn("Received change, reloading page now"), e.refresh());
                  }));
              })(),
              () => {
                ((s = !0), t?.disconnect());
              }
            );
          }, [e]);
        })(),
        (0, s.jsx)(s.Fragment, {})
      );
    },
    35021: (e, t, r) => {
      "use strict";
      r.d(t, { C: () => o, ColorVariables: () => l });
      var s = r(54568),
        n = r(10897),
        a = r(7620),
        i = r(71252);
      function o(e) {
        let t = e?.colors.primary ?? "#16A34A",
          r = e?.colors.light ?? "#4ADE80",
          s = e?.colors.dark ?? "#166534",
          a = e?.colors.primary,
          i = e?.colors.primary;
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
            primaryDark: (0, n.N9)(s),
            primaryDarkForeground: ((e) => {
              let t = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(e),
                r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(e) ?? t;
              if (!r || !r[1] || !r[2] || !r[3]) {
                return !1;
              }
              let s = (e) => (1 === e.length ? e + e : e),
                n = parseInt(s(r[1]), 16),
                a = parseInt(s(r[2]), 16);
              return 0.299 * n + 0.587 * a + 0.114 * parseInt(s(r[3]), 16) > 165;
            })(s)
              ? "0 0 0"
              : "255 255 255",
            backgroundLight: (0, n.N9)(e?.background?.color?.light ?? "#ffffff"),
            backgroundDark: (0, n.ab)(r, e?.background?.color?.dark),
            anchorDefault: a,
            dropdownDefault: i,
            gray: (0, n.Eo)(t),
          }
        );
      }
      function l({ docsConfig: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, a.useContext)(i.K),
          n = r(),
          l = o(t && n ? { ...e, ...n } : e),
          c = `:root {
    --primary: ${l.primary};
    --primary-light: ${l.primaryLight};
    --primary-dark: ${l.primaryDark};
    --tooltip-foreground: ${l.primaryDarkForeground};
    --background-light: ${l.backgroundLight};
    --background-dark: ${l.backgroundDark};
    --gray-50: ${l.gray[50]};
    --gray-100: ${l.gray[100]};
    --gray-200: ${l.gray[200]};
    --gray-300: ${l.gray[300]};
    --gray-400: ${l.gray[400]};
    --gray-500: ${l.gray[500]};
    --gray-600: ${l.gray[600]};
    --gray-700: ${l.gray[700]};
    --gray-800: ${l.gray[800]};
    --gray-900: ${l.gray[900]};
    --gray-950: ${l.gray[950]};
  }`;
        return (0, s.jsx)("style", { children: c });
      }
    },
    42080: (e, t, r) => {
      "use strict";
      (r.r(t),
        r.d(t, {
          FooterAndSidebarScrollScript: () => m,
          ScrollTopScript: () => g,
          handleFooterAndSidebarScrollTop: () => h,
        }));
      var s = r(54568),
        n = r(23792),
        a = r(7620),
        i = r(12192),
        o = r(71252),
        l = r(76829);
      function c(e, t, r) {
        return `(${d.toString()})(${e}, ${t}, "${r}")`;
      }
      function d(e, t, r) {
        let s = document.documentElement.getAttribute("data-banner-state"),
          n = 2.5 * !!(null != s ? "visible" === s : t),
          a = 3 * !!e,
          i = 4,
          o = n + 4 + a;
        switch (r) {
          case "mint":
          case "palm":
            break;
          case "aspen":
            ((i = 3.5), (o = n + (a = 2.5 * !!e) + i));
            break;
          case "linden":
            o = n + (i = 4);
            break;
          case "almond":
            o = n + (i = 3.5);
            break;
          case "sequoia":
            o = n + (i = 3) + (a = 3 * !!e);
        }
        return o;
      }
      let u = function (e, t, r, s) {
        var n;
        let a,
          i = "mint" === s || "linden" === s ? "sidebar" : "sidebar-content",
          o =
            ((a = "navbar-transition"),
            "maple" === (n = s) && (a += "-maple"),
            "willow" === n && (a += "-willow"),
            a),
          [l, c] = (() => {
            switch (s) {
              case "almond":
                return ["[--scroll-mt:2.5rem]", "[--scroll-mt:2.5rem]"];
              case "sequoia":
                return ["lg:[--scroll-mt:8.5rem]", "lg:[--scroll-mt:11rem]"];
              default:
                return ["lg:[--scroll-mt:9.5rem]", "lg:[--scroll-mt:12rem]"];
            }
          })();
        function d() {
          document.documentElement.classList.add(l);
        }
        function u(e) {
          document.getElementById(i)?.style.setProperty("top", `${e}rem`);
        }
        function h(e) {
          document.getElementById(i)?.style.setProperty("height", `calc(100vh - ${e}rem)`);
        }
        function g(e, t) {
          (!e && t) || (e && !t)
            ? (d(), document.documentElement.classList.remove(c))
            : e &&
              t &&
              (document.documentElement.classList.add(c),
              document.documentElement.classList.remove(l));
        }
        let m = document.documentElement.getAttribute("data-banner-state"),
          x = null != m ? "visible" === m : t;
        switch (s) {
          case "mint":
            (u(r), g(e, x));
            break;
          case "palm":
          case "aspen":
            (u(r), h(r), g(e, x));
            break;
          case "linden":
            (u(r), x && d());
            break;
          case "almond":
            (d(), u(r), h(r));
            break;
          case "sequoia":
            g(e, x);
        }
        let p = (function () {
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
            document.getElementById(o)?.setAttribute("data-is-opaque", `${!!e}`),
            p());
        });
      }.toString();
      function h(e, t) {
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
          s = document.getElementById("navbar"),
          n = document.getElementById("navigation-items"),
          a = document.getElementById("sidebar"),
          i = document.getElementById("footer"),
          o = document.getElementById("table-of-contents-content"),
          l = (n?.clientHeight ?? 0) + 16 * e + 32 * ("mint" === t || "linden" === t);
        if (!i || "center" === r) {
          return;
        }
        let c = i.getBoundingClientRect().top,
          d = window.innerHeight - c;
        (a &&
          n &&
          (l > c
            ? ((a.style.top = `-${d}px`), (a.style.height = `${window.innerHeight}px`))
            : ((a.style.top = `${e}rem`), (a.style.height = "auto"))),
          o &&
            s &&
            (d > 0
              ? (o.style.top =
                  "custom" === r ? `${s.clientHeight - d}px` : `${40 + s.clientHeight - d}px`)
              : (o.style.top = "")));
      }
      function g({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, a.useContext)(o.K),
          d = r(),
          h = d?.theme,
          g = t && h ? h : e,
          { banner: m } = (0, a.useContext)(i.y),
          { divisions: x } = (0, a.useContext)(l.NavigationContext),
          p = x.tabs.length > 0,
          f = !!m,
          y = (0, a.useMemo)(
            () => `(${u})(
  ${p},
  ${f},
  ${c(p, f, g)},
  "${g}",
)`,
            [p, f, g],
          );
        return (0, s.jsx)(n.default, {
          strategy: "beforeInteractive",
          id: "_mintlify-scroll-top-script",
          dangerouslySetInnerHTML: { __html: y },
          suppressHydrationWarning: !0,
        });
      }
      function m({ theme: e }) {
        let { isLivePreview: t, getDocsConfigOverrides: r } = (0, a.useContext)(o.K),
          d = r(),
          u = d?.theme,
          g = t && u ? u : e,
          { banner: m } = (0, a.useContext)(i.y),
          { divisions: x } = (0, a.useContext)(l.NavigationContext),
          p = x.tabs.length > 0,
          f = !!m,
          y = (0, a.useMemo)(
            () => `(${h.toString()})(
  ${c(p, f, g)},
  "${g}",
)`,
            [p, f, g],
          );
        return (0, s.jsx)(n.default, {
          strategy: "beforeInteractive",
          id: "_mintlify-footer-and-sidebar-scroll-script",
          dangerouslySetInnerHTML: { __html: y },
          suppressHydrationWarning: !0,
        });
      }
    },
    49769: (e, t, r) => {
      "use strict";
      r.d(t, { default: () => a });
      var s = r(54568),
        n = r(90663);
      function a(e) {
        let { appId: t, children: r } = e;
        return void 0 === t
          ? (0, s.jsx)(s.Fragment, { children: r })
          : (0, s.jsx)(n.F, { ...e, appId: t });
      }
    },
    51749: (e, t, r) => {
      "use strict";
      r.d(t, { ThemeProvider: () => l });
      var s = r(54568),
        n = r(24560),
        a = r(7620),
        i = r(16816),
        o = r(71252);
      function l({ children: e, appearance: t, queryParamMode: r, codeblockTheme: l, ...c }) {
        let {
            isLivePreview: d,
            getDocsConfigOverrides: u,
            livePreviewUpdateId: h,
          } = (0, a.useContext)(o.K),
          g = u(),
          m = g?.appearance,
          x = g?.styling?.codeblocks,
          p = r && ["dark", "light", "system"].includes(r),
          f = d && x ? x : l;
        (0, i.px)(f);
        let y = p ? r : d && m?.default ? m.default : t?.default,
          v = p ? r : d && m?.strict ? m.default : t?.strict ? t.default : void 0;
        return (0, s.jsx)(
          n.N,
          {
            attribute: "class",
            disableTransitionOnChange: !0,
            defaultTheme: y,
            forcedTheme: v,
            storageKey: "isDarkMode",
            themes: ["dark", "light", "true", "false", "system"],
            value: { true: "dark", false: "light", dark: "dark", light: "light" },
            enableSystem: !0,
            ...c,
            children: e,
          },
          h,
        );
      }
    },
    54001: (e, t, r) => {
      "use strict";
      r.d(t, { SidebarLoginButtonProvider: () => y, h: () => f });
      var s = r(54568),
        n = r(34920),
        a = r(19664),
        i = r.n(a),
        o = r(7620),
        l = r(98167),
        c = r(27194),
        d = r(53016),
        u = r(9537),
        h = r(56991),
        g = r(33052),
        m = r(91392),
        x = r(81325),
        p = r(30793);
      let f = (0, o.createContext)({
        authLoginButton: null,
        userAuthLoginButton: null,
        authLogoutButton: null,
        userAuthLogoutButton: null,
      });
      function y({ children: e }) {
        let {
            userInfo: t,
            userAuth: r,
            auth: a,
            isFetchingUserInfo: y,
          } = (0, o.useContext)(p.AuthContext),
          { docsConfig: v } = (0, o.useContext)(p.DocsConfigContext),
          { logout: b } = (0, d.W)(),
          j = (0, c.G)(),
          k =
            v?.theme === "aspen"
              ? "flex items-center gap-2 whitespace-nowrap font-medium text-gray-800 dark:text-gray-50 bg-gray-950/[0.03] dark:bg-white/[0.03] hover:bg-gray-950/10 dark:hover:bg-white/10 rounded-xl px-[14px] py-2"
              : "flex items-center gap-1.5 whitespace-nowrap font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
          w = (0, o.useCallback)(
            (e, t, r, a) =>
              a
                ? (0, s.jsx)("button", {
                    onClick: a,
                    className: "w-full text-left",
                    children: (0, s.jsx)(m.j, {
                      entry: { href: "#", title: r },
                      shouldAutoNavigateOnGroupClick: !0,
                      sidebarItemStyle: "undecorated",
                      trailingIcon: (0, s.jsx)(n.A, {
                        className:
                          "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                      }),
                    }),
                  })
                : (0, s.jsx)(m.j, {
                    entry: { href: t, title: r },
                    shouldAutoNavigateOnGroupClick: !0,
                    sidebarItemStyle: "undecorated",
                    trailingIcon: (0, s.jsx)(n.A, {
                      className:
                        "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                    }),
                  }),
            [],
          ),
          N = (0, o.useMemo)(() => {
            let e, n, a;
            if (y || t || !r) {
              return null;
            }
            switch (r.type) {
              case "jwt":
                ((n = r.loginUrl),
                  (e = (0, s.jsx)(i(), {
                    href: n,
                    className: (0, x.cn)(k, g.x.LoginLink),
                    children: "Log In",
                  })));
                break;
              case "shared-session":
                if (!r.loginUrl) {
                  return null;
                }
                ((n = r.loginUrl),
                  (e = (0, s.jsx)(i(), {
                    href: n,
                    className: (0, x.cn)(k, g.x.LoginLink),
                    children: "Log In",
                  })));
                break;
              case "oauth":
                ((n = "#"),
                  (a = () => (0, u.A)(r)),
                  (e = (0, s.jsx)("button", {
                    onClick: () => (0, u.A)(r),
                    className: (0, x.cn)(k, g.x.LoginLink),
                    children: "Log In",
                  })));
                break;
              default:
                return null;
            }
            return w(e, n, "Log In", a);
          }, [y, r, t, w, k]),
          C = (0, o.useMemo)(() => {
            if (t || !a || !1 !== y) {
              return null;
            }
            let e = `/${l.c.BASE_PATH}/login?redirect=${j}`.replace(/\/{2,}/g, "/");
            return w(
              (0, s.jsx)(i(), {
                href: e,
                className: (0, x.cn)(k, g.x.LoginLink),
                children: "Log In",
              }),
              e,
              "Log In",
            );
          }, [j, a, t, y, w, k]),
          I = (0, o.useMemo)(
            () =>
              t && a
                ? w(
                    (0, s.jsx)("button", {
                      onClick: () => b({ redirectOverride: a.logoutUrl }),
                      className: (0, x.cn)(k, g.x.LogoutLink),
                      children: "Log Out",
                    }),
                    "#",
                    "Log Out",
                    () => b({ redirectOverride: a.logoutUrl }),
                  )
                : null,
            [t, a, b, w, k],
          ),
          S = (0, o.useMemo)(() => {
            if (!t || !r) {
              return null;
            }
            let e = () => {
              try {
                localStorage.removeItem(h.$A);
              } catch {}
              window.location.reload();
            };
            return w(
              (0, s.jsx)("button", {
                onClick: e,
                className: (0, x.cn)(k, g.x.LogoutLink),
                children: "Log Out",
              }),
              "#",
              "Log Out",
              e,
            );
          }, [t, r, w, k]);
        return (0, s.jsx)(f.Provider, {
          value: {
            userAuthLoginButton: N,
            authLoginButton: C,
            authLogoutButton: I,
            userAuthLogoutButton: S,
          },
          children: e,
        });
      }
    },
    62964: (e, t, r) => {
      "use strict";
      r.d(t, { ThemeLayout: () => ed });
      var s = r(54568),
        n = r(7620),
        a = r(27194),
        i = r(84514),
        o = r(35878);
      function l(e) {
        let t = (0, i.C)(
            (function (e) {
              if (e) {
                return e.split("#")[0] || void 0;
              }
            })(e) ?? "",
          ),
          s = document.querySelectorAll(`[id="${t}"]`);
        if (1 === s.length && s[0] instanceof HTMLElement) {
          let e = s[0];
          r.e(88206)
            .then(r.bind(r, 88206))
            .then((t) => {
              let { default: r } = t;
              r(e, {
                scrollMode: "if-needed",
                boundary: (e) => e.id !== o.V.SidebarContent && e.id !== o.V.Sidebar,
              });
            })
            .catch(() => "Error auto scroll the sidebar");
        }
      }
      function c() {
        let e = (0, a.G)(),
          t = (0, n.useRef)(void 0);
        (0, n.useEffect)(() => l(e), []);
        let r = (0, n.useCallback)(() => {
          (void 0 !== t.current && clearTimeout(t.current),
            (t.current = window.setTimeout(() => {
              l(e);
            }, 10)));
        }, [e]);
        return (
          (0, n.useEffect)(() => {
            r();
          }, [r]),
          (0, s.jsx)(s.Fragment, {})
        );
      }
      var d = r(71252),
        u = r(16974),
        h = r(84246),
        g = r(67908),
        m = r(12192),
        x = r(76829),
        p = r(30793);
      let f = (0, n.createContext)({ pageMetadata: {} });
      function y({ children: e }) {
        let t = (function () {
          let { pageMetadata: e } = (0, n.useContext)(p.PageContext);
          return (0, n.useMemo)(() => ({ pageMetadata: e }), [e]);
        })();
        return (0, s.jsx)(f.Provider, { value: t, children: e });
      }
      f.displayName = "PageMetadataContext";
      var v = r(81325),
        b = r(97263);
      function j({ children: e }) {
        let { banner: t } = (0, n.useContext)(m.y),
          { divisions: r } = (0, n.useContext)(x.NavigationContext),
          a = r.tabs.length > 0;
        return (0, s.jsx)(s.Fragment, {
          children: (0, s.jsxs)(y, {
            children: [
              (0, s.jsxs)("div", {
                className: (0, v.cn)(
                  "scroll-mt-[var(--scroll-mt)]",
                  "peer-[.is-custom]:max-w-none peer-[.is-center]:max-w-3xl peer-[.is-not-custom]:peer-[.is-not-center]:max-w-8xl",
                  "peer-[.is-not-custom]:px-4 peer-[.is-not-custom]:mx-auto peer-[.is-not-custom]:lg:px-8 peer-[.is-wide]:[&>div:last-child]:max-w-6xl",
                  h.N.firstChildHiddenIfCustom,
                  h.N.firstChildHiddenIfCenter,
                ),
                children: [
                  (0, s.jsx)("div", {
                    className: (0, v.cn)(
                      g.f.SecondaryNav,
                      "hidden lg:block fixed bottom-0 right-auto w-[18rem]",
                    ),
                    id: o.V.Sidebar,
                    style: { top: `${2.5 * !!t + 4 + 3 * !!a}rem` },
                    children: (0, s.jsx)("div", {
                      className:
                        "absolute inset-0 z-10 stable-scrollbar-gutter overflow-auto pr-8 pb-10",
                      id: o.V.SidebarContent,
                      children: (0, s.jsx)(b.f, {}),
                    }),
                  }),
                  (0, s.jsx)("div", { id: o.V.ContentContainer, children: e }),
                ],
              }),
              (0, s.jsx)(u.S, {}),
            ],
          }),
        });
      }
      let k = ({ children: e, topbar: t }) =>
          (0, s.jsxs)(s.Fragment, { children: [t, (0, s.jsx)(j, { children: e })] }),
        w = 10,
        N = ({ children: e, threshold: t = w, ...r }) => {
          let a = (0, n.useRef)(null),
            [i, o] = (0, n.useState)({ top: !1 });
          (0, n.useEffect)(() => {
            let e = a.current;
            if (e) {
              return (
                r(),
                e.addEventListener("scroll", r, { passive: !0 }),
                () => e.removeEventListener("scroll", r)
              );
            }
            function r() {
              if (!e) {
                return;
              }
              let { scrollTop: r } = e;
              o({ top: r > t });
            }
          }, [t]);
          let l = i.top ? "linear-gradient(to bottom, transparent, black 32px)" : void 0;
          return (0, s.jsx)("div", {
            ref: a,
            ...r,
            style: { ...r.style, maskImage: l, WebkitMaskImage: l },
            children: e,
          });
        };
      var C = r(33052),
        I = r(12158),
        S = r(96119),
        E = r(23416),
        _ = r(32795),
        A = r(21254);
      function L({ className: e }) {
        let { docsConfig: t } = (0, n.useContext)(p.DocsConfigContext),
          { banner: r } = (0, n.useContext)(m.y),
          { divisions: a } = (0, n.useContext)(x.NavigationContext),
          i = a.languages,
          l = !!r,
          c = () => 2.5 * !!l + 3.5;
        return (0, s.jsxs)("div", {
          id: o.V.SidebarContent,
          suppressHydrationWarning: !0,
          className: (0, v.cn)(
            "hidden fixed lg:flex flex-col left-0 bottom-0 right-auto transition-transform duration-100 w-[16.5rem] pl-2",
            e,
          ),
          style: { top: `${c()}rem`, height: `calc(100vh - ${c()}rem)` },
          children: [
            (0, s.jsx)("div", {
              className: "flex-1 p-2 relative",
              children: (0, s.jsxs)("div", {
                className: "text-sm flex flex-col px-2",
                children: [
                  (0, s.jsx)(I.DesktopSearchEntry, {}),
                  (0, s.jsxs)(N, {
                    className:
                      "overflow-y-auto stable-scrollbar-gutter absolute inset-x-0 top-11 bottom-0 px-2 max-h-full py-6",
                    id: o.V.NavigationItems,
                    children: [
                      (0, s.jsx)("div", { className: "px-2", children: (0, s.jsx)(_.Xt, {}) }),
                      (0, s.jsx)($, {}),
                      (0, s.jsx)(S.r, { nav: a.groupsOrPages, ...(0, S.f)({ theme: t?.theme }) }),
                    ],
                  }),
                ],
              }),
            }),
            (0, s.jsxs)("div", {
              className: (0, v.cn)(
                C.x.AlmondNavBottomSection,
                "w-full px-4",
                t?.appearance?.strict && !i.length && "hidden",
              ),
              children: [
                (0, s.jsx)("div", {
                  className: (0, v.cn)(
                    C.x.AlmondNavBottomSectionDivider,
                    "h-px bg-gray-200/70 dark:bg-gray-800/70 w-full",
                  ),
                }),
                (0, s.jsxs)("div", {
                  className: "flex items-center gap-3 py-3",
                  children: [
                    i.length > 0 &&
                      (0, s.jsx)("div", {
                        className: "flex-1",
                        children: (0, s.jsx)(_.K2, { triggerClassName: "border-none font-medium" }),
                      }),
                    !t?.appearance?.strict && (0, s.jsx)(E.U, {}),
                  ],
                }),
              ],
            }),
          ],
        });
      }
      function $() {
        return (0, s.jsx)(A.Anchors, { className: C.x.Anchors });
      }
      function P({ children: e }) {
        let { banner: t } = (0, n.useContext)(m.y);
        return (0, s.jsx)("div", {
          suppressHydrationWarning: !0,
          className: (0, v.cn)(
            "scroll-mt-[var(--scroll-mt)]",
            C.x.AlmondLayout,
            "top-[7rem] lg:top-[3.5rem]",
            !!t && "lg:top-[6.5rem] top-[9.5rem]",
            "peer-[.is-not-custom]:fixed peer-[.is-not-custom]:pb-2 peer-[.is-not-custom]:px-2 peer-[.is-not-custom]:pt-0 peer-[.is-custom]:absolute",
            h.N.firstChildHiddenIfCustom,
          ),
          style: { width: "calc(100% - var(--assistant-sheet-width, 0px))" },
          children: e,
        });
      }
      function z({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [t, (0, s.jsxs)(P, { children: [(0, s.jsx)(L, {}), e] })],
        });
      }
      function R({ className: e }) {
        let { banner: t } = (0, n.useContext)(m.y),
          { divisions: r } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: a } = (0, n.useContext)(p.DocsConfigContext),
          i = r.tabs.length > 0,
          l = !!t,
          c = () => 2.5 * !!l + 2.5 * !!i + 3.5;
        return (0, s.jsx)("div", {
          id: o.V.SidebarContent,
          suppressHydrationWarning: !0,
          className: (0, v.cn)(
            "hidden sticky shrink-0 w-[18rem] lg:flex flex-col left-0 top-[7rem] bottom-0 right-auto border-r border-gray-100 dark:border-white/10 transition-transform duration-100",
            e,
          ),
          style: { top: `${c()}rem`, height: `calc(100vh - ${c()}rem)` },
          children: (0, s.jsx)(N, {
            className: "flex-1 pr-5 pt-5 pb-4 overflow-y-auto stable-scrollbar-gutter",
            id: o.V.NavigationItems,
            children: (0, s.jsxs)("div", {
              className: "text-sm relative",
              children: [
                (0, s.jsx)("div", { className: "pl-2", children: (0, s.jsx)(_.Xt, {}) }),
                (0, s.jsx)(M, {}),
                (0, s.jsx)(S.r, { nav: r.groupsOrPages, ...(0, S.f)({ theme: a?.theme }) }),
              ],
            }),
          }),
        });
      }
      function M() {
        return (0, s.jsx)(A.Anchors, {});
      }
      function T({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            t,
            (0, s.jsxs)("div", {
              id: o.V.BodyContent,
              className: (0, v.cn)(
                "scroll-mt-[var(--scroll-mt)]",
                "peer-[.is-custom]:max-w-none peer-[.is-not-custom]:max-w-8xl peer-[.is-not-custom]:lg:flex peer-[.is-not-custom]:mx-auto peer-[.is-not-custom]:px-0 peer-[.is-not-custom]:lg:px-5",
                h.N.firstChildHiddenIfCustom,
              ),
              children: [(0, s.jsx)(R, {}), e],
            }),
          ],
        });
      }
      function F() {
        let { banner: e } = (0, n.useContext)(m.y),
          t = !!e;
        return (
          (0, n.useEffect)(() => {
            t && window.document.documentElement.classList.add("lg:[--scroll-mt:9.5rem]");
          }, [t]),
          null
        );
      }
      var D = r(2811),
        O = r(74092),
        B = r(93372),
        H = r(68999);
      function q() {
        let { docsConfig: e } = (0, n.useContext)(p.DocsConfigContext),
          { banner: t } = (0, n.useContext)(m.y),
          { divisions: r, hasAdvancedTabs: a } = (0, n.useContext)(x.NavigationContext),
          [i, l] = (0, n.useState)(!0),
          c = r.tabs.length > 0,
          d = !!t,
          u = () => 2.5 * !!d + 3 * !!c + 4,
          h = r.dropdowns.length > 0 && !a && i;
        return (
          (0, n.useEffect)(() => {
            !(r.dropdowns.length > 0) || a || i || l(!0);
          }, [r.dropdowns.length, a, i]),
          (0, s.jsxs)("div", {
            id: o.V.SidebarContent,
            suppressHydrationWarning: !0,
            className: (0, v.cn)(
              "hidden sticky lg:flex flex-col left-0 top-[7rem] bottom-0 right-auto border-r border-gray-200/70 dark:border-white/[0.07] transition-transform duration-100",
              i ? "w-[19rem]" : "w-[4rem]",
            ),
            style: { top: `${u()}rem`, height: `calc(100vh - ${u()}rem)` },
            children: [
              (0, s.jsx)(N, {
                className: "flex-1 px-7 py-6 overflow-y-auto stable-scrollbar-gutter",
                id: o.V.NavigationItems,
                children: (0, s.jsxs)("div", {
                  className: (0, v.cn)("text-sm relative", !i && "hidden"),
                  children: [
                    (0, s.jsx)(_.Xt, {}),
                    (0, s.jsx)(Q, {}),
                    (0, s.jsx)(S.r, { nav: r.groupsOrPages, ...(0, S.f)({ theme: e?.theme }) }),
                  ],
                }),
              }),
              (0, s.jsxs)("div", {
                className: (0, v.cn)(
                  "w-full flex items-center px-7 py-4 border-t border-gray-200/70 dark:border-white/[0.07]",
                  (!i || e?.appearance?.strict === !0) && "hidden",
                ),
                children: [
                  (0, s.jsx)("div", {
                    className: "flex-1",
                    children: (0, s.jsx)(_.K2, {
                      triggerClassName: "border-none px-0 font-medium",
                    }),
                  }),
                  (0, s.jsx)(E.U, {}),
                ],
              }),
              (0, s.jsxs)("button", {
                className: (0, v.cn)(
                  "absolute top-5 right-5 p-1.5 rounded-md hover:bg-neutral-950/5 dark:hover:bg-white/5 cursor-pointer",
                  h && "hidden",
                ),
                onClick: () => l(!i),
                children: [
                  (0, s.jsx)("span", { className: "sr-only", children: i ? "close" : "open" }),
                  i
                    ? (0, s.jsx)(H.A, {
                        icon: "arrow-left-from-line",
                        className: "h-3.5 w-3.5 bg-gray-700 dark:bg-gray-300",
                      })
                    : (0, s.jsx)(H.A, {
                        icon: "arrow-right-to-line",
                        className: "h-3.5 w-3.5 bg-gray-700 dark:bg-gray-300",
                      }),
                ],
              }),
            ],
          })
        );
      }
      function Q() {
        return (0, s.jsx)(A.Anchors, {});
      }
      function W({ mobile: e = !1 }) {
        let t = (0, a.G)(),
          { divisions: r } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: i } = (0, n.useContext)(p.DocsConfigContext),
          l = (0, n.useRef)(null),
          c = (0, n.useRef)(null),
          d = (0, n.useRef)(null),
          u = r.groupsOrPages.reduce((e, t) => ((0, D.y)(t) ? e + 1 : e + t.pages.length), 0);
        return (
          (0, O.E)(() => {
            function e() {
              c.current = l.current;
            }
            if (l.current) {
              if (l.current === c.current) {
                return e();
              }
              e();
              let t = d.current ? (0, B.L)(d.current) : document.body,
                r = t.getBoundingClientRect(),
                s = l.current.getBoundingClientRect(),
                n = l.current.offsetTop,
                a = n - r.height + s.height;
              (t.scrollTop > n || t.scrollTop < a) &&
                (t.scrollTop = n - r.height / 2 + s.height / 2);
            }
          }, [t]),
          (0, s.jsxs)("div", {
            ref: d,
            className: "relative lg:text-sm lg:leading-6",
            children: [
              !e &&
                (0, s.jsx)("div", {
                  className: (0, v.cn)(
                    "sticky top-0 h-8",
                    i?.background?.image == null &&
                      i?.background?.decoration == null &&
                      "z-10 bg-gradient-to-b from-background-light dark:from-background-dark",
                  ),
                }),
              (0, s.jsxs)("div", {
                id: o.V.NavigationItems,
                children: [
                  (0, s.jsx)(_.Xt, { triggerClassName: "rounded-lg" }),
                  r.tabs.length > 0 && e && (0, s.jsx)(_.TJ, {}),
                  r.anchors.length > 0 && (0, s.jsx)(Q, {}),
                  u > 0 &&
                    (0, s.jsx)(S.r, { nav: r.groupsOrPages, ...(0, S.f)({ theme: i?.theme }) }),
                ],
              }),
            ],
          })
        );
      }
      function K({ children: e }) {
        let { banner: t } = (0, n.useContext)(m.y);
        return (0, s.jsx)("div", {
          suppressHydrationWarning: !0,
          className: (0, v.cn)(
            g.f.PrimaryNav,
            "hidden lg:block fixed bottom-0 right-auto w-[18rem]",
          ),
          id: o.V.Sidebar,
          style: { top: `${2.5 * !!t + 4}rem` },
          children: e,
        });
      }
      function V({ children: e }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            (0, s.jsx)(F, {}),
            (0, s.jsxs)("div", {
              className: (0, v.cn)(
                "scroll-mt-[var(--scroll-mt)]",
                "peer-[.is-custom]:max-w-none peer-[.is-center]:max-w-3xl peer-[.is-not-custom]:peer-[.is-not-center]:max-w-8xl",
                "peer-[.is-not-custom]:px-4 peer-[.is-not-custom]:mx-auto peer-[.is-not-custom]:lg:px-8 peer-[.is-wide]:[&>div:last-child]:max-w-6xl",
                h.N.firstChildHiddenIfCustom,
                h.N.firstChildHiddenIfCenter,
              ),
              children: [
                (0, s.jsx)(K, {
                  children: (0, s.jsx)("div", {
                    className:
                      "absolute inset-0 z-10 stable-scrollbar-gutter overflow-auto pr-8 pb-10",
                    id: o.V.SidebarContent,
                    children: (0, s.jsx)(W, {}),
                  }),
                }),
                (0, s.jsx)("div", { id: o.V.ContentContainer, children: e }),
              ],
            }),
            (0, s.jsx)(u.S, {}),
          ],
        });
      }
      function U({ topbar: e, children: t }) {
        return (0, s.jsxs)(s.Fragment, { children: [e, (0, s.jsx)(V, { children: t })] });
      }
      var Y = r(34920),
        G = r(54001),
        J = r(34766),
        X = r(91392);
      function Z() {
        return (0, s.jsx)(A.Anchors, { className: "mt-8" });
      }
      function ee() {
        let { divisions: e } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: t } = (0, n.useContext)(p.DocsConfigContext),
          { banner: r } = (0, n.useContext)(m.y),
          {
            userAuthLoginButton: a,
            authLoginButton: i,
            authLogoutButton: l,
            userAuthLogoutButton: c,
          } = (0, n.useContext)(G.h);
        return (0, s.jsxs)("div", {
          className: (0, v.cn)(
            "hidden lg:flex fixed flex-col left-0 top-0 bottom-0 w-[19rem] border-r border-gray-200/70 dark:border-white/[0.07]",
            !!r && "top-10",
          ),
          id: o.V.Sidebar,
          children: [
            (0, s.jsxs)("div", {
              className: "flex-1 overflow-y-auto stable-scrollbar-gutter px-7 py-6",
              id: o.V.SidebarContent,
              children: [
                (0, s.jsxs)("div", {
                  className: "flex justify-between items-center",
                  children: [
                    (0, s.jsx)(J.l, { logoClassName: "px-1 h-6 max-w-48" }),
                    (0, s.jsx)(E.U, {}),
                  ],
                }),
                (0, s.jsxs)("div", {
                  className: "flex flex-col gap-4 mt-6",
                  children: [
                    (0, s.jsx)(_.m4, {
                      className:
                        "w-full justify-between bg-gray-600/5 dark:bg-gray-200/5 max-lg:hidden",
                    }),
                    (0, s.jsx)(I.DesktopSearchEntry, {}),
                    (0, s.jsx)(_.Xt, {}),
                  ],
                }),
                (0, s.jsxs)("div", {
                  className: "-mx-3 text-sm",
                  id: o.V.NavigationItems,
                  children: [
                    (0, s.jsx)(Z, {}),
                    (0, s.jsx)(S.r, { nav: e.groupsOrPages, ...(0, S.f)({ theme: t?.theme }) }),
                  ],
                }),
              ],
            }),
            (0, s.jsxs)("ul", {
              className:
                "px-4 py-3 w-[calc(19rem-1px)] left-0 right-0 bottom-0 bg-background-light dark:bg-background-dark border-t border-gray-200/70 dark:border-white/[0.07] text-sm",
              children: [
                t?.navbar?.links?.map((e) => {
                  let { type: t } = e;
                  return "github" === t
                    ? (0, s.jsx)(_.sR, { className: "px-2", href: e.href, label: e.label }, e.href)
                    : "discord" === t
                      ? (0, s.jsx)(
                          _.xR,
                          { className: "px-2", href: e.href, label: e.label },
                          e.href,
                        )
                      : (0, s.jsx)(
                          X.j,
                          {
                            entry: { href: e.href, title: e.label ?? "", icon: e.icon },
                            shouldAutoNavigateOnGroupClick: !0,
                            sidebarItemStyle: "undecorated",
                            trailingIcon: (0, s.jsx)(Y.A, {
                              className:
                                "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                            }),
                          },
                          e.href,
                        );
                }),
                t?.navbar?.primary?.type === "button" &&
                  (0, s.jsx)(X.j, {
                    entry: { href: t.navbar.primary.href, title: t.navbar.primary.label },
                    shouldAutoNavigateOnGroupClick: !0,
                    sidebarItemStyle: "undecorated",
                    trailingIcon: (0, s.jsx)(Y.A, {
                      className:
                        "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                    }),
                  }),
                t?.navbar?.primary?.type === "github" &&
                  (0, s.jsx)(_.sR, { className: "hidden lg:flex px-2" }),
                t?.navbar?.primary?.type === "discord" &&
                  (0, s.jsx)(_.xR, { className: "hidden lg:flex px-2" }),
                a && (0, s.jsx)("li", { children: a }),
                c && (0, s.jsx)("li", { children: c }),
                i && (0, s.jsx)("li", { children: i }),
                l && (0, s.jsx)("li", { children: l }),
                (0, s.jsx)("li", {
                  children: (0, s.jsx)(_.Xh, {
                    triggerClassName:
                      "mt-1 rounded-lg py-1.5 justify-between w-full border-gray-200/70 dark:border-white/10",
                  }),
                }),
              ],
            }),
          ],
        });
      }
      function et({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            t,
            (0, s.jsxs)("div", {
              className: "flex scroll-mt-[var(--scroll-mt)]",
              children: [(0, s.jsx)(ee, {}), e],
            }),
            (0, s.jsx)(u.S, { className: "lg:ml-[19rem]", disableSidebarOffset: !0 }),
          ],
        });
      }
      function er({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            t,
            (0, s.jsxs)("div", {
              className: (0, v.cn)(
                "scroll-mt-[var(--scroll-mt)] peer-[.is-not-custom]:lg:flex",
                h.N.firstChildHiddenIfCustom,
              ),
              children: [(0, s.jsx)(q, {}), e],
            }),
            (0, s.jsx)(u.S, {
              className: (0, v.cn)(
                "w-full bg-gray-950/[0.03] dark:bg-white/[0.03]",
                h.N.hiddenIfCustom,
              ),
            }),
          ],
        });
      }
      function es({ className: e }) {
        let { divisions: t } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: r } = (0, n.useContext)(p.DocsConfigContext),
          a = r?.theme;
        return (0, s.jsx)("div", {
          id: o.V.Sidebar,
          suppressHydrationWarning: !0,
          className: (0, v.cn)(
            "hidden fixed w-72 lg:flex flex-col left-0 bottom-0 right-auto border-r border-gray-100 dark:border-white/10 transition-transform duration-100",
            e,
          ),
          style: { top: "var(--topbar-height,0px)" },
          children: (0, s.jsx)(N, {
            className: "flex-1 px-2 pt-4 pb-4 overflow-y-auto stable-scrollbar-gutter",
            id: o.V.NavigationItems,
            children: (0, s.jsxs)("div", {
              className: "text-sm relative",
              children: [
                (0, s.jsx)("div", { className: "px-2.5", children: (0, s.jsx)(_.Xt, {}) }),
                (0, s.jsx)(en, {}),
                (0, s.jsx)(S.r, { nav: t.groupsOrPages, ...(0, S.f)({ theme: a }) }),
              ],
            }),
          }),
        });
      }
      function en() {
        return (0, s.jsx)(A.Anchors, {});
      }
      function ea({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            t,
            (0, s.jsx)(es, { className: h.N.hiddenIfCustom }),
            (0, s.jsx)("div", {
              id: o.V.BodyContent,
              className: (0, v.cn)(
                "peer-[.is-custom]:max-w-none peer-[.is-not-custom]:lg:pl-72",
                h.N.firstChildHiddenIfCustom,
              ),
              children: e,
            }),
          ],
        });
      }
      function ei() {
        let { docsConfig: e } = (0, n.useContext)(p.DocsConfigContext),
          { divisions: t } = (0, n.useContext)(x.NavigationContext),
          {
            userAuthLoginButton: r,
            authLoginButton: a,
            authLogoutButton: i,
            userAuthLogoutButton: o,
          } = (0, n.useContext)(G.h);
        return r || o || a || i || !(t.tabs.length > 0)
          ? (0, s.jsxs)("ul", {
              className:
                "bg-zinc-950/5 dark:bg-white/5 px-4 py-3 w-[calc(19rem-1px)] left-0 right-0 bottom-0 bg-background-light dark:bg-background-dark border-t border-gray-200/50 dark:border-white/[0.07] text-sm",
              children: [
                e?.navbar?.links?.map((e) => {
                  let { type: t } = e;
                  return "github" === t
                    ? (0, s.jsx)(_.sR, { className: "px-2", href: e.href, label: e.label }, e.href)
                    : "discord" === t
                      ? (0, s.jsx)(
                          _.xR,
                          { className: "px-2", href: e.href, label: e.label },
                          e.href,
                        )
                      : (0, s.jsx)(
                          X.j,
                          {
                            entry: { href: e.href, title: e.label ?? "", icon: e.icon },
                            shouldAutoNavigateOnGroupClick: !0,
                            sidebarItemStyle: "undecorated",
                            trailingIcon: (0, s.jsx)(Y.A, {
                              className:
                                "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                            }),
                          },
                          e.href,
                        );
                }),
                e?.navbar?.primary?.type === "button" &&
                  (0, s.jsx)(X.j, {
                    entry: { href: e.navbar.primary.href, title: e.navbar.primary.label },
                    shouldAutoNavigateOnGroupClick: !0,
                    sidebarItemStyle: "undecorated",
                    trailingIcon: (0, s.jsx)(Y.A, {
                      className:
                        "size-3.5 text-gray-400 dark:text-gray-500 group-hover:text-gray-500 dark:group-hover:text-gray-400",
                    }),
                  }),
                e?.navbar?.primary?.type === "github" &&
                  (0, s.jsx)(_.sR, { className: "hidden lg:flex px-2" }),
                e?.navbar?.primary?.type === "discord" &&
                  (0, s.jsx)(_.xR, { className: "hidden lg:flex px-2" }),
                r && r,
                o && o,
                a && a,
                i && i,
              ],
            })
          : null;
      }
      function eo() {
        let { divisions: e } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: t } = (0, n.useContext)(p.DocsConfigContext),
          { banner: r } = (0, n.useContext)(m.y),
          a = e.tabs.length > 0;
        return (0, s.jsxs)("div", {
          className: (0, v.cn)(
            "hidden lg:flex fixed flex-col left-0 top-0 bottom-0 w-[19rem]",
            !!r && "top-10",
          ),
          id: o.V.Sidebar,
          children: [
            (0, s.jsxs)("div", {
              className:
                "flex-1 overflow-y-auto stable-scrollbar-gutter px-4 py-6 bg-gray-950/5 dark:bg-white/5",
              id: o.V.SidebarContent,
              children: [
                (0, s.jsxs)("div", {
                  className: "flex justify-between items-center",
                  children: [
                    (0, s.jsxs)("div", {
                      className: "flex items-center gap-x-4 justify-between w-full",
                      children: [
                        (0, s.jsx)(J.l, { logoClassName: "px-1 h-6" }),
                        (0, s.jsx)(_.t7, {}),
                        (0, s.jsx)(_.K2, {}),
                      ],
                    }),
                    !a && (0, s.jsx)(_.cI, {}),
                  ],
                }),
                (0, s.jsxs)("div", {
                  className: "flex flex-col gap-4 mt-6",
                  children: [
                    (0, s.jsx)(_.m4, { className: "justify-between max-lg:hidden" }),
                    (0, s.jsx)(I.DesktopSearchEntry, { searchButtonClassName: "bg-white" }),
                    (0, s.jsx)(_.Xt, {}),
                  ],
                }),
                (0, s.jsxs)("div", {
                  className: "-mx-3 text-sm",
                  id: o.V.NavigationItems,
                  children: [
                    (0, s.jsx)(el, {}),
                    (0, s.jsx)(S.r, { nav: e.groupsOrPages, ...(0, S.f)({ theme: t?.theme }) }),
                  ],
                }),
              ],
            }),
            (0, s.jsx)(ei, {}),
          ],
        });
      }
      function el() {
        return (0, s.jsx)(A.Anchors, { className: "mt-8" });
      }
      function ec({ children: e, topbar: t }) {
        return (0, s.jsxs)(s.Fragment, {
          children: [
            t,
            (0, s.jsxs)("div", {
              className: "flex scroll-mt-[var(--scroll-mt)]",
              children: [(0, s.jsx)(eo, {}), e],
            }),
            (0, s.jsx)(u.S, { className: "lg:ml-[19rem]", disableSidebarOffset: !0 }),
          ],
        });
      }
      function ed({ theme: e, children: t, topbar: r }) {
        let a,
          { isLivePreview: i, getDocsConfigOverrides: o } = (0, n.useContext)(d.K),
          l = o(),
          u = l?.theme;
        switch (i && u ? u : e) {
          case "maple":
            a = (0, s.jsx)(et, { topbar: r, children: t });
            break;
          case "palm":
            a = (0, s.jsx)(er, { topbar: r, children: t });
            break;
          case "willow":
            a = (0, s.jsx)(ec, { topbar: r, children: t });
            break;
          case "linden":
            a = (0, s.jsx)(U, { topbar: r, children: t });
            break;
          case "aspen":
            a = (0, s.jsx)(T, { topbar: r, children: t });
            break;
          case "almond":
            a = (0, s.jsx)(z, { topbar: r, children: t });
            break;
          case "sequoia":
            a = (0, s.jsx)(ea, { topbar: r, children: t });
            break;
          default:
            a = (0, s.jsx)(k, { topbar: r, children: t });
        }
        return (0, s.jsxs)(s.Fragment, { children: [(0, s.jsx)(c, {}), a] });
      }
    },
    69445: (e, t, r) => {
      "use strict";
      r.d(t, { Fonts: () => l });
      var s = r(54568),
        n = r(7620),
        a = r(71252),
        i = r(81325),
        o = r(79627);
      function l({ fonts: e, children: t }) {
        let { isLivePreview: r, getDocsConfigOverrides: l } = (0, n.useContext)(a.K),
          c = l(),
          d = c?.fonts,
          u = r && d ? d : e;
        return (0, s.jsx)("div", {
          className: (0, i.cn)(
            "relative antialiased text-gray-500 dark:text-gray-400",
            (0, o.W)(u, "headings")?.weight && "[[&_:is(h1,h2,h3,h4,h5,h6)]:font-headingsWeight",
            (0, o.W)(u, "body")?.weight &&
              "[&_*:not(h1,h2,h3,h4,h5,h6,h1_*,h2_*,h3_*,h4_*,h5_*,h6_*)]:font-bodyWeight",
          ),
          children: t,
        });
      }
    },
    76982: (e, t, r) => {
      "use strict";
      r.d(t, { SkipToContent: () => i });
      var s = r(54568),
        n = r(76829),
        a = r(35878);
      function i() {
        let e = (0, n.n)();
        return (0, s.jsx)("a", {
          href: `#${a.V.ContentArea}`,
          className:
            "sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:p-2 focus:text-sm focus:bg-background-light dark:focus:bg-background-dark focus:rounded-md focus:outline-primary dark:focus:outline-primary-light",
          children: e["aria.skipToMainContent"],
        });
      }
    },
    83176: (e, t, r) => {
      "use strict";
      r.d(t, { I: () => l, default: () => c });
      var s = r(54568),
        n = r(8494),
        a = r(7620);
      let i = "mintlify-flag-overrides";
      var o = r(22904);
      let l = (0, a.createContext)({
        flags: (0, n.flagsClient)([]),
        overrides: {},
        isEnabled: () => !1,
        setOverride: () => {},
      });
      function c({ children: e, toggles: t }) {
        let r = (0, a.useMemo)(() => (0, n.flagsClient)(t), [t]),
          [c, d] = (0, a.useState)(() => {
            let e = (0, o.Gq)(i);
            return e ? JSON.parse(e) : {};
          }),
          u = (0, a.useCallback)((e, t) => {
            d((r) => {
              let s = { ...r };
              return (void 0 === t ? delete s[e] : (s[e] = t), (0, o.SO)(i, JSON.stringify(s)), s);
            });
          }, []),
          h = (0, a.useCallback)((e) => (void 0 !== c[e] ? c[e] : r.isEnabled(e)), [r, c]);
        return (0, s.jsx)(l.Provider, {
          value: { flags: r, overrides: c, isEnabled: h, setOverride: u },
          children: e,
        });
      }
    },
    84246: (e, t, r) => {
      "use strict";
      r.d(t, { N: () => s });
      let s = {
        isCustom: "peer is-custom",
        isCenter: "peer is-center",
        isWide: "peer is-wide",
        isFrame: "peer is-frame",
        isNotCustom: "peer is-not-custom",
        isNotCenter: "peer is-not-center",
        isNotWide: "peer is-not-wide",
        isNotFrame: "peer is-not-frame",
        hiddenIfCustom:
          "peer-[.is-custom]:!hidden peer-[.is-custom]:sm:!hidden peer-[.is-custom]:md:!hidden peer-[.is-custom]:lg:!hidden peer-[.is-custom]:xl:!hidden",
        hiddenIfNotCustom:
          "peer-[.is-not-custom]:!hidden peer-[.is-not-custom]:sm:!hidden peer-[.is-not-custom]:md:!hidden peer-[.is-not-custom]:lg:!hidden peer-[.is-not-custom]:xl:!hidden",
        hiddenIfCenter:
          "peer-[.is-center]:!hidden peer-[.is-center]:sm:!hidden peer-[.is-center]:md:!hidden peer-[.is-center]:lg:!hidden peer-[.is-center]:xl:!hidden",
        firstChildHiddenIfCustom:
          "peer-[.is-custom]:[&>div:first-child]:!hidden peer-[.is-custom]:[&>div:first-child]:sm:!hidden peer-[.is-custom]:[&>div:first-child]:md:!hidden peer-[.is-custom]:[&>div:first-child]:lg:!hidden peer-[.is-custom]:[&>div:first-child]:xl:!hidden",
        firstChildHiddenIfCenter:
          "peer-[.is-center]:[&>div:first-child]:!hidden peer-[.is-center]:[&>div:first-child]:sm:!hidden peer-[.is-center]:[&>div:first-child]:md:!hidden peer-[.is-center]:[&>div:first-child]:lg:!hidden peer-[.is-center]:[&>div:first-child]:xl:!hidden",
      };
    },
    89261: (e, t, r) => {
      "use strict";
      r.d(t, { AssistantLayoutWrapper: () => ev });
      var s = r(54568),
        n = r(7620),
        a = r(41574);
      let i = (e, t) => {
        let [r, s] = (0, a.Mj)(e, t),
          [i, o] = (0, n.useState)(!1);
        return (
          (0, n.useEffect)(() => {
            o(!0);
          }, []),
          [(0, n.useMemo)(() => (i ? r : t), [i, r, t]), s, i]
        );
      };
      var o = r(73181),
        l = r(40999),
        c = r(12598),
        d = r(9196),
        u = r(97509),
        h = r(67908),
        g = r(76829),
        m = r(22153),
        x = r(65477),
        p = r(37113),
        f = r(90723),
        y = r(35878),
        v = r(33052),
        b = r(68999),
        j = r(73205),
        k = r(81325),
        w = r(12158),
        N = r(91640),
        C = r.n(N),
        I = r(42469),
        S = r(27541),
        E = r(27194),
        _ = r(38637),
        A = r(11339),
        L = r(39808);
      let $ = ["flex-shrink-0 h-3.5 w-3.5 text-gray-600 dark:text-gray-400"],
        P = ({ context: e, onClick: t, onRemove: r }) => {
          let n = (0, g.n)(),
            a = e.value.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, ""),
            i = a.length > 30 ? `${a.slice(0, 30)}...` : a;
          return (0, s.jsxs)("div", {
            className: (0, k.cn)(
              v.x.ChatAssistantPayloadItem,
              "relative inline-flex items-center gap-1.5 px-2 py-1",
              "border border-gray-200 dark:border-gray-800 rounded-lg text-xs group",
              "hover:border-gray-300 dark:hover:border-gray-700 cursor-pointer",
            ),
            children: [
              (0, s.jsxs)("button", {
                type: "button",
                onClick: () => t?.(e),
                "aria-label": n["aria.viewPayloadItem"]
                  .replace("{type}", e.type)
                  .replace("{value}", i),
                className: "flex items-center gap-1.5 flex-1 min-w-0",
                children: [
                  "code" === e.type
                    ? (0, s.jsx)(A.A, { className: (0, k.cn)(...$) })
                    : (0, s.jsx)(L.A, { className: (0, k.cn)(...$) }),
                  (0, s.jsx)("span", {
                    className: (0, k.cn)("text-gray-900 dark:text-gray-100 max-w-[100px] truncate"),
                    children: i,
                  }),
                ],
              }),
              r &&
                (0, s.jsx)("button", {
                  type: "button",
                  onClick: (e) => {
                    (e.preventDefault(), e.stopPropagation(), r());
                  },
                  "aria-label": n["aria.removePayloadItem"]
                    .replace("{type}", e.type)
                    .replace("{value}", i),
                  className: (0, k.cn)(
                    "rounded-r-lg hidden absolute right-0 top-0 bottom-0 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 flex-shrink-0",
                    "bg-gradient-to-l from-background-light via-background-light to-transparent dark:from-background-dark dark:via-background-dark/50 dark:to-transparent",
                    "group-hover:flex items-center pl-4 pr-2",
                  ),
                  children: (0, s.jsx)(c.A, { className: "h-3.5 w-3.5" }),
                }),
            ],
          });
        },
        z = n.forwardRef(({ className: e, message: t, ...r }, n) => {
          let a = (0, S.useRouter)(),
            i = (0, E.G)(),
            o = (0, f.A)((e) => e.getMessageContext(t.id)),
            l = o && o.length > 0,
            c = (e) => {
              let t = e.path;
              if (t && t !== i && t) {
                ((0, _.U_)(e), a.push(t));
                return;
              }
              (0, _.Es)(e);
            };
          return (0, s.jsxs)("div", {
            className: "flex justify-end items-end w-full flex-col gap-2",
            children: [
              l &&
                (0, s.jsx)("div", {
                  className: "flex flex-wrap gap-1.5 justify-end",
                  children: o.map((e, t) => (0, s.jsx)(P, { context: e, onClick: c }, t)),
                }),
              (0, s.jsx)("div", {
                ref: n,
                className: (0, k.cn)(
                  "flex px-3 py-2 items-start gap-4 w-fit rounded-2xl bg-gray-100 dark:bg-white/5",
                  e,
                ),
                ...r,
                children: (0, s.jsx)("div", {
                  className: "flex items-start gap-4 w-full",
                  children: (0, s.jsx)("div", {
                    className: "flex flex-col gap-1 w-full",
                    children: (0, s.jsx)("div", {
                      className:
                        "break-words hyphens-auto text-base lg:text-sm text-gray-800 dark:text-gray-200",
                      children: t.content,
                    }),
                  }),
                }),
              }),
            ],
          });
        });
      z.displayName = "ChatMessage";
      var R = r(45234),
        M = r(6438),
        T = r(17023),
        F = r(74363),
        D = r(34518),
        O = r(83308),
        B = r(30793),
        H = r(41995),
        q = r(40711),
        Q = r(65202),
        W = r(14486);
      let K = ({ children: e }) =>
          (0, s.jsx)("span", {
            className:
              "animate-shimmer bg-[length:200%_100%] bg-clip-text text-transparent font-medium",
            style: {
              backgroundImage:
                "linear-gradient(90deg, rgb(156 163 175) 0%, rgb(209 213 219) 50%, rgb(156 163 175) 100%)",
            },
            children: e,
          }),
        V = ({ query: e, children: t }) => {
          let [r, a] = (0, n.useState)(!1),
            i = (0, g.n)(),
            o = null != t;
          return (0, s.jsxs)(s.Fragment, {
            children: [
              (0, s.jsxs)("button", {
                className: (0, k.cn)(
                  "group flex items-start text-left gap-2 text-gray-500 dark:text-gray-400 flex-shrink-0 hover:text-gray-600 dark:hover:text-gray-300 transition-colors",
                  o ? "cursor-pointer" : "cursor-default",
                ),
                onClick: () => {
                  o && a(!r);
                },
                children: [
                  (0, s.jsx)(Q.A, {
                    className: (0, k.cn)(
                      "size-3 mt-1 flex-shrink-0",
                      o && "block group-hover:hidden",
                      r && "hidden",
                    ),
                    absoluteStrokeWidth: !0,
                    strokeWidth: 1.5,
                  }),
                  (0, s.jsx)(W.A, {
                    className: (0, k.cn)(
                      "size-3 mt-1 hidden flex-shrink-0",
                      o && "group-hover:block",
                      r && "block rotate-90",
                    ),
                    absoluteStrokeWidth: !0,
                    strokeWidth: 1.5,
                  }),
                  (0, s.jsx)("span", {
                    className: "text-base sm:text-sm flex items-center gap-1.5",
                    children: o
                      ? (0, s.jsx)("span", {
                          className: "font-medium",
                          children: `${i.foundResultsFor} ${e}`,
                        })
                      : (0, s.jsx)(K, { children: `${i.searchingFor} ${e}` }),
                  }),
                ],
              }),
              r && (0, s.jsx)("div", { className: "pl-6 pt-0.5 not-prose", children: t }),
            ],
          });
        };
      var U = r(50519);
      function Y({
        text: e,
        charDelay: t = 1,
        onComplete: r,
        className: a = "",
        disabled: i = !1,
        renderAsMarkdown: o = !1,
        markdownProps: l = {},
      }) {
        let { displayedText: c } = (function (e, t = {}) {
            let { charDelay: r = 1, onComplete: s = () => {}, disabled: a = !1 } = t,
              [i, o] = (0, n.useState)(""),
              [l, c] = (0, n.useState)(!1),
              d = (0, n.useRef)(null),
              u = (0, n.useRef)(""),
              h = (0, n.useRef)(0),
              g = (0, n.useRef)(!1),
              m = (0, n.useRef)(!1),
              x = (0, n.useCallback)(() => {
                (d.current && (clearTimeout(d.current), (d.current = null)),
                  c(!1),
                  (g.current = !1));
              }, []),
              p = (0, n.useCallback)(() => {
                if (g.current) {
                  return;
                }
                (c(!0), (g.current = !0), (m.current = !0));
                let e = () => {
                  let t = u.current;
                  h.current < t.length
                    ? ((h.current += 1), o(t.slice(0, h.current)), (d.current = setTimeout(e, r)))
                    : (c(!1), (g.current = !1), s());
                };
                e();
              }, [r, s]);
            return (
              (0, n.useEffect)(() => {
                if (((u.current = e), a && !m.current)) {
                  (o(e), (h.current = e.length));
                  return;
                }
                !g.current && h.current < e.length && (!a || m.current) && p();
              }, [e, a, p]),
              (0, n.useEffect)(() => {
                "" === e && (x(), o(""), (h.current = 0), (m.current = !1));
              }, [e, x]),
              {
                displayedText: i,
                isRendering: l,
                completeRendering: (0, n.useCallback)(() => {
                  (x(), o(e), (h.current = e.length), s());
                }, [e, x, s]),
                reset: (0, n.useCallback)(() => {
                  (x(), o(""), (h.current = 0), (u.current = ""), (m.current = !1));
                }, [x]),
                progress: e.length > 0 ? h.current / e.length : 0,
              }
            );
          })(e, { charDelay: t, onComplete: r, disabled: i }),
          d = (0, n.useMemo)(() => (i ? e : c), [i, c, e]);
        return o
          ? (0, s.jsx)(U.o, { ...l, children: d })
          : (0, s.jsx)("div", {
              className: (0, k.cn)("relative", a),
              children: (0, s.jsx)("span", { className: "whitespace-pre-wrap", children: d }),
            });
      }
      let G = {
          className:
            "prose prose-sm dark:prose-invert overflow-x-auto pb-1 max-lg:text-base max-lg:[&_p]:text-base max-lg:[&_li]:text-base max-lg:[&_ul]:text-base max-lg:[&_ol]:text-base",
          showCopyButton: !0,
          components: {
            h1: ({ children: e }) =>
              (0, s.jsx)("h1", {
                className: "text-lg font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
            h2: ({ children: e }) =>
              (0, s.jsx)("h2", {
                className: "text-base font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
            h3: ({ children: e }) =>
              (0, s.jsx)("h3", {
                className: "text-base font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
            h4: ({ children: e }) =>
              (0, s.jsx)("h4", {
                className: "text-base font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
            h5: ({ children: e }) =>
              (0, s.jsx)("h5", {
                className: "text-base font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
            h6: ({ children: e }) =>
              (0, s.jsx)("h6", {
                className: "text-base font-semibold text-gray-950 dark:text-gray-50",
                children: e,
              }),
          },
        },
        J = ({ response: e, isLast: t, onInternalLinkClick: r }) => {
          let a = (0, n.useMemo)(() => ({ ...G, onInternalLinkClick: r }), [r]);
          return t
            ? (0, s.jsx)(Y, {
                text: e.text,
                renderAsMarkdown: !0,
                disabled: !t,
                charDelay: 1,
                markdownProps: a,
              })
            : (0, s.jsx)(U.o, { ...a, children: e.text });
        },
        X = ({ children: e }) =>
          (0, s.jsx)("span", {
            className:
              "animate-shimmer bg-[length:200%_100%] bg-clip-text text-transparent font-medium",
            style: {
              backgroundImage:
                "linear-gradient(90deg, rgb(156 163 175) 0%, rgb(209 213 219) 50%, rgb(156 163 175) 100%)",
            },
            children: e,
          }),
        Z = ({ query: e, children: t }) => {
          let [r, a] = (0, n.useState)(!1),
            i = (0, g.n)(),
            o = null != t;
          return (0, s.jsxs)(s.Fragment, {
            children: [
              (0, s.jsxs)("button", {
                className: (0, k.cn)(
                  "group flex items-center text-left gap-2.5 text-gray-500 dark:text-gray-400 flex-shrink-0 hover:text-gray-600 dark:hover:text-gray-300 transition-colors",
                  o ? "cursor-pointer" : "cursor-default",
                ),
                onClick: () => {
                  o && a(!r);
                },
                children: [
                  (0, s.jsx)(Q.A, {
                    className: (0, k.cn)(
                      "size-3 flex-shrink-0",
                      o && "block group-hover:hidden",
                      r && "hidden",
                    ),
                    absoluteStrokeWidth: !0,
                    strokeWidth: 1.5,
                  }),
                  (0, s.jsx)(W.A, {
                    className: (0, k.cn)(
                      "size-3 hidden flex-shrink-0",
                      o && "group-hover:block",
                      r && "block rotate-90",
                    ),
                    absoluteStrokeWidth: !0,
                    strokeWidth: 1.5,
                  }),
                  (0, s.jsx)("span", {
                    className: "text-base sm:text-sm flex items-center gap-1.5",
                    children: o
                      ? (0, s.jsx)("span", {
                          className: "font-medium",
                          children: `${i.foundResultsFor} ${e}`,
                        })
                      : (0, s.jsx)(X, { children: `${i.searchingFor} ${e}` }),
                  }),
                ],
              }),
              r && (0, s.jsx)("div", { className: "pl-6 pt-0.5 not-prose", children: t }),
            ],
          });
        },
        ee =
          "rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer text-gray-500",
        et = "rounded-lg p-1.5 bg-primary dark:bg-bg-primary-light text-white dark:text-gray-950",
        er = () => {
          let { onReload: e } = (0, x.w)(),
            t = (0, g.n)();
          return (0, s.jsxs)("button", {
            className:
              "mt-6 group text-primary dark:text-primary-light hover:text-primary-light dark:hover:text-primary-light text-sm cursor-pointer flex items-center gap-0.5 whitespace-nowrap self-start",
            onClick: e,
            "aria-label": t["aria.reloadChat"],
            children: [
              (0, s.jsx)(j.HD.Retry, {}),
              (0, s.jsx)("span", { className: "px-1", children: "Retry" }),
            ],
          });
        },
        es = () => {
          let { onReload: e } = (0, x.w)(),
            t = (0, g.n)();
          return (0, s.jsx)("button", {
            className:
              "rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer text-gray-500",
            onClick: e,
            "aria-label": t["aria.reloadLastChat"],
            children: (0, s.jsx)(R.A, { className: "size-4 sm:size-3.5" }),
          });
        },
        en = ({ message: e }) => {
          let t = (0, m.p)("docs.assistant.copy_response"),
            [r, a] = (0, n.useState)(!1),
            i = (0, g.n)();
          return (
            (0, n.useEffect)(() => {
              r && setTimeout(() => a(!1), 2e3);
            }, [r]),
            (0, s.jsx)("button", {
              className:
                "rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer text-gray-500",
              onClick: () => {
                navigator.clipboard
                  .writeText(e.content)
                  .then(() => {
                    (t({ message: e.content }).catch(console.error), a(!0));
                  })
                  .catch(console.error);
              },
              "aria-label": i["aria.copyChatResponse"],
              children: r
                ? (0, s.jsx)(M.A, {
                    className: "size-4 sm:size-3.5 text-primary dark:text-primary-light",
                  })
                : (0, s.jsx)(T.A, { className: "size-4 sm:size-3.5" }),
            })
          );
        },
        ea = n.forwardRef(
          ({ className: e, message: t, isLast: r, hasError: a, handleClose: i, ...o }, l) => {
            let [c, d] = (0, n.useState)(!1),
              [u, h] = (0, n.useState)(!1),
              { subdomain: x } = (0, n.useContext)(B.DeploymentMetadataContext),
              { userInfo: p } = (0, n.useContext)(B.AuthContext),
              y = (0, g.n)(),
              v = (0, f.A)((e) => e.status),
              b = (0, f.A)((e) => e.getMessageUlid),
              j = (0, n.useMemo)(() => {
                let e;
                return (
                  (e = t.parts),
                  e?.some(
                    (e) =>
                      "text" === e.type ||
                      ("tool-invocation" === e.type &&
                        ("search" === e.toolInvocation.toolName ||
                          "searchDocsAndSiteRestrictedWeb" === e.toolInvocation.toolName)),
                  ) ?? !1
                );
              }, [t.parts]),
              w = (0, m.p)("docs.assistant.source_click"),
              N = (0, m.p)("docs.assistant.web_search_click"),
              C = async (e, t) => {
                try {
                  let r = b(e);
                  if (!r) {
                    return console.error("Message ULID not found for message ID:", e);
                  }
                  let s = (0, O.c)({
                    subdomain: x ?? "",
                    isAuthenticated: !!p,
                    messageId: r,
                    feedback: t,
                  });
                  await fetch(s, { method: "PUT" });
                } catch (e) {
                  console.error("Failed to send thumbs feedback:", e);
                }
              };
            return a
              ? (0, s.jsxs)("div", {
                  ref: l,
                  className: (0, k.cn)("py-4 text-sm", e),
                  ...o,
                  children: [
                    (0, s.jsx)("span", {
                      children: "Sorry, we could not generate a response to your question.",
                    }),
                    (0, s.jsx)(er, {}),
                  ],
                })
              : j
                ? (0, s.jsxs)("div", {
                    ref: l,
                    className: (0, k.cn)("flex flex-col py-4 gap-4 self-stretch", e),
                    ...o,
                    children: [
                      t.parts?.map((e, n) => {
                        if ("text" === e.type) {
                          return (0, s.jsx)(
                            J,
                            {
                              response: e,
                              isLast: r && n === (t.parts?.length ?? 0) - 1,
                              onInternalLinkClick: i,
                            },
                            `text-${n}`,
                          );
                        }
                        if (
                          "tool-invocation" === e.type &&
                          "search" === e.toolInvocation.toolName &&
                          ("call" === e.toolInvocation.state ||
                            "partial-call" === e.toolInvocation.state)
                        ) {
                          return (0, s.jsx)(
                            Z,
                            { query: e.toolInvocation.args.query },
                            `${e.toolInvocation.toolCallId}-call`,
                          );
                        }
                        if (
                          "tool-invocation" === e.type &&
                          "search" === e.toolInvocation.toolName &&
                          "result" === e.toolInvocation.state
                        ) {
                          return (0, s.jsx)(
                            "div",
                            {
                              className: (0, k.cn)(
                                "flex flex-col gap-2",
                                e.toolInvocation.result.results?.length === 0 && "hidden",
                              ),
                              children: (0, s.jsx)(Z, {
                                query: e.toolInvocation.args.query,
                                children: (0, s.jsx)("div", {
                                  className: "flex gap-1 flex-col",
                                  children: e.toolInvocation.result.results?.map((e) =>
                                    (0, s.jsx)(
                                      q.k,
                                      {
                                        href: `/${e.path}`,
                                        onInternalLinkClick: i,
                                        onClick: () => {
                                          w({ url: e.path }).catch(console.error);
                                        },
                                        title: e.metadata.title,
                                        titleContainerClassName: "gap-1 py-1",
                                      },
                                      e.path,
                                    ),
                                  ),
                                }),
                              }),
                            },
                            `${e.toolInvocation.toolCallId}-result`,
                          );
                        }
                        if (
                          "tool-invocation" === e.type &&
                          "searchDocsAndSiteRestrictedWeb" === e.toolInvocation.toolName &&
                          ("call" === e.toolInvocation.state ||
                            "partial-call" === e.toolInvocation.state)
                        ) {
                          return (0, s.jsx)(
                            V,
                            { query: e.toolInvocation.args.query },
                            `${e.toolInvocation.toolCallId}-call`,
                          );
                        }
                        if (
                          "tool-invocation" === e.type &&
                          "searchDocsAndSiteRestrictedWeb" === e.toolInvocation.toolName &&
                          "result" === e.toolInvocation.state
                        ) {
                          let t = e.toolInvocation.result,
                            r = t.docs.length > 0 || t.web.length > 0;
                          return (0, s.jsx)(
                            "div",
                            {
                              className: (0, k.cn)("flex flex-col gap-2", !r && "hidden"),
                              children: (0, s.jsx)(V, {
                                query: e.toolInvocation.args.query,
                                children: (0, s.jsxs)("div", {
                                  className: "flex gap-1 flex-col",
                                  children: [
                                    t.docs.map((e) =>
                                      (0, s.jsx)(
                                        q.k,
                                        {
                                          href: `/${e.path}`,
                                          onInternalLinkClick: i,
                                          onClick: () => {
                                            w({ url: e.path }).catch(console.error);
                                          },
                                          title: e.metadata.title,
                                          titleContainerClassName: "gap-1 py-1",
                                        },
                                        e.path,
                                      ),
                                    ),
                                    t.web.map((e) =>
                                      (0, s.jsx)(
                                        H.s,
                                        {
                                          href: e.url,
                                          onClick: () => {
                                            N({ url: e.url }).catch(console.error);
                                          },
                                          title: e.metadata.title,
                                          publishedDate: e.metadata.publishedDate,
                                          className: "gap-1 py-1",
                                        },
                                        e.url,
                                      ),
                                    ),
                                  ],
                                }),
                              }),
                            },
                            `${e.toolInvocation.toolCallId}-result`,
                          );
                        }
                      }),
                      (!r || "ready" === v) &&
                        t.parts &&
                        t.parts.length > 0 &&
                        (0, s.jsx)("div", {
                          className: "flex items-start gap-2 w-full",
                          children: (0, s.jsxs)("div", {
                            className: "flex items-center gap-1",
                            children: [
                              (0, s.jsx)("button", {
                                "aria-label": y["aria.voteGood"],
                                className: c ? et : ee,
                                onClick: () => {
                                  c || (C(t.id, "positive").catch(console.error), d(!0), h(!1));
                                },
                                children: (0, s.jsx)(F.A, { className: "size-4 sm:size-3.5" }),
                              }),
                              (0, s.jsx)("button", {
                                "aria-label": y["aria.voteBad"],
                                className: u ? et : ee,
                                onClick: () => {
                                  u || (C(t.id, "negative").catch(console.error), d(!1), h(!0));
                                },
                                children: (0, s.jsx)(D.A, { className: "size-4 sm:size-3.5" }),
                              }),
                              (0, s.jsx)(en, { message: t }),
                              r && (0, s.jsx)(es, {}),
                            ],
                          }),
                        }),
                    ],
                  })
                : null;
          },
        );
      ea.displayName = "ChatResponse";
      let ei = n.memo(
        ({ message: e, isLast: t, hasError: r, handleClose: n }) =>
          "user" === e.role
            ? (0, s.jsx)(z, { message: e })
            : "assistant" === e.role
              ? (0, s.jsx)(ea, { message: e, isLast: t, hasError: r, handleClose: n })
              : void 0,
        (e, t) =>
          e.message.content === t.message.content &&
          e.message.parts?.length === t.message.parts?.length &&
          e.handleClose === t.handleClose &&
          e.isLast === t.isLast &&
          e.hasError === t.hasError,
      );
      ei.displayName = "ChatItem";
      let eo = () =>
          (0, s.jsxs)("div", {
            className: "jsx-d74a492b66aec8f2 flex justify-start",
            children: [
              (0, s.jsxs)("div", {
                className: "jsx-d74a492b66aec8f2 flex gap-0.5 items-end h-3 py-2",
                children: [
                  (0, s.jsx)("span", {
                    className:
                      "jsx-d74a492b66aec8f2 size-1 bg-zinc-400 dark:bg-zinc-500 rounded-full animate-[dotBounce_1.4s_ease-in-out_infinite]",
                  }),
                  (0, s.jsx)("span", {
                    className:
                      "jsx-d74a492b66aec8f2 size-1 bg-zinc-400 dark:bg-zinc-500 rounded-full animate-[dotBounce_1.4s_ease-in-out_0.2s_infinite]",
                  }),
                  (0, s.jsx)("span", {
                    className:
                      "jsx-d74a492b66aec8f2 size-1 bg-zinc-400 dark:bg-zinc-500 rounded-full animate-[dotBounce_1.4s_ease-in-out_0.4s_infinite]",
                  }),
                ],
              }),
              (0, s.jsx)(C(), {
                id: "d74a492b66aec8f2",
                children:
                  "@keyframes dotBounce{0%,20%,100%{transform:translatey(0)}10%{transform:translatey(2px)}}",
              }),
            ],
          }),
        el = () => {
          let { status: e, messages: t } = (0, x.w)();
          if (
            (0, n.useMemo)(() => {
              if ("submitted" === e) {
                return !0;
              }
              if ("streaming" !== e) {
                return !1;
              }
              let r = t.at(-1)?.parts.at(-1);
              return r?.type === "step-start" || r?.type === "tool-invocation";
            }, [e, t])
          ) {
            return (0, s.jsx)("div", { className: "py-4 text-sm", children: (0, s.jsx)(eo, {}) });
          }
        },
        ec = ({ className: e, handleClose: t }) => {
          let r = (0, f.A)((0, I.k)((e) => e.messages)),
            n = "error" === (0, f.A)((e) => e.status);
          return (0, s.jsxs)("div", {
            className: (0, k.cn)("flex flex-col gap-3 mb-2", e),
            children: [
              r.map((e, a) =>
                (0, s.jsx)(
                  ei,
                  {
                    message: e,
                    isLast: a === r.length - 1,
                    hasError: a === r.length - 1 && n,
                    handleClose: t,
                  },
                  e.id,
                ),
              ),
              (0, s.jsx)(el, {}),
            ],
          });
        };
      var ed = r(39692);
      let eu = ({ scrollRef: e, isMobile: t }) => {
        let { subdomain: r } = (0, n.useContext)(B.DeploymentMetadataContext),
          {
            isChatSheetOpen: a,
            shouldFocusChatSheet: i,
            entryPoint: o,
            setShouldFocusChatSheet: l,
          } = (0, n.useContext)(w.ChatAssistantContext),
          c = (0, m.p)("docs.assistant.enter"),
          d = (0, S.useRouter)(),
          u = (0, E.G)(),
          h = (0, n.useRef)(null),
          {
            setInput: g,
            isFeatureUnavailable: p,
            payloadInput: y,
            setPayloadInput: v,
          } = (0, x.w)();
        (0, n.useEffect)(() => {
          if (!a) {
            return void h.current?.blur();
          }
          if (!i) {
            return;
          }
          let e = h.current;
          (e && !t && (e.focus(), e.setSelectionRange(e.value.length, e.value.length)), l(!1));
        }, [a, i, l, t]);
        let b = (e) => {
            let t = e.path;
            if (t && t !== u && t) {
              ((0, _.U_)(e), d.push(t));
              return;
            }
            (0, _.Es)(e);
          },
          j =
            y.context && y.context.length > 0 && y.context
              ? (0, s.jsx)("div", {
                  className: "flex flex-wrap gap-2 px-2 pt-2 max-h-[300px] overflow-y-auto",
                  children: y.context.map((e, t) =>
                    (0, s.jsx)(
                      P,
                      {
                        context: e,
                        onClick: b,
                        onRemove: () => {
                          v({ context: y.context?.filter((e, r) => r !== t) || [] });
                        },
                      },
                      t,
                    ),
                  ),
                })
              : null;
        return (0, s.jsxs)("div", {
          className: (0, k.cn)(t && "z-50 bg-background-light dark:bg-background-dark"),
          children: [
            p.unavailable &&
              (0, s.jsx)("div", {
                className: (0, k.cn)(
                  "mb-3 p-3 rounded-xl border",
                  "blocked" === p.type
                    ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/50"
                    : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/50",
                ),
                children: (0, s.jsxs)("p", {
                  className: (0, k.cn)(
                    "text-sm",
                    "blocked" === p.type
                      ? "text-red-800 dark:text-red-200"
                      : "text-amber-800 dark:text-amber-200",
                  ),
                  children: [
                    p.message,
                    "blocked" === p.type &&
                      (0, s.jsxs)(s.Fragment, {
                        children: [
                          " ",
                          "If you believe this is a false positive, please email",
                          " ",
                          (0, s.jsx)("a", {
                            href: "mailto:support@mintlify.com?subject=Assistant%20blocked%20on%20my%20network",
                            target: "_blank",
                            rel: "noopener noreferrer",
                            className: "underline hover:opacity-80",
                            children: "support@mintlify.com",
                          }),
                          " ",
                          "with details from",
                          " ",
                          (0, s.jsx)("a", {
                            href: "https://ipinfo.io/json",
                            target: "_blank",
                            rel: "noopener noreferrer",
                            className: "underline hover:opacity-80",
                            children: "ipinfo.io/json",
                          }),
                          ".",
                        ],
                      }),
                  ],
                }),
              }),
            (0, s.jsx)(ed.V, {
              ref: h,
              variant: "panel",
              isMobile: t,
              headerContent: j,
              onBeforeSubmit: () => {
                y.context && y.context.length > 0 && f.A.getState().setPendingContext(y.context);
              },
              onSubmit: (s) => {
                (g(""),
                  v({ context: void 0 }),
                  requestAnimationFrame(() => {
                    e.current?.scrollTo({ top: 0, behavior: "instant" });
                  }),
                  c({ subdomain: r, query: s, entryPoint: o }),
                  t && h.current && h.current.blur());
              },
              onDeleteEmpty: () => {
                y.context && y.context.length > 0 && v({ context: y.context.slice(0, -1) });
              },
            }),
          ],
        });
      };
      var eh = r(17635),
        eg = r.n(eh);
      let em = ({ starterQuestions: e, assistantConfig: t }) => {
          let { append: r } = (0, x.w)(),
            { selectedLocale: a } = (0, n.useContext)(g.NavigationContext),
            i = (0, g.n)(),
            o = (0, m.p)("docs.assistant.starter_question_clicked"),
            l = (0, n.useMemo)(
              () =>
                e && t?.enableStarterQuestions === !0
                  ? a && "en" !== a
                    ? e.filter((e) => e.translations?.[a])
                    : e
                  : [],
              [e, a, t?.enableStarterQuestions],
            );
          return (0, s.jsxs)("div", {
            className: "h-full flex flex-col justify-between",
            children: [
              (0, s.jsx)("div", {
                className: "mt-4 flex flex-col items-center text-sm",
                children: (0, s.jsx)("div", {
                  className: (0, k.cn)(
                    "mx-8 text-center text-gray-400 dark:text-gray-600 text-xs",
                    v.x.ChatAssistantDisclaimerText,
                  ),
                  children: i["assistant.disclaimer"],
                }),
              }),
              l.length > 0 &&
                (0, s.jsx)("div", {
                  className: "pb-6",
                  children: (0, s.jsxs)("div", {
                    className: "flex flex-col gap-4",
                    children: [
                      (0, s.jsx)("p", {
                        className: (0, k.cn)(
                          "text-sm text-gray-700 dark:text-gray-300",
                          v.x.StarterQuestionText,
                        ),
                        children: i["assistant.suggestions"],
                      }),
                      l.slice(0, 3).map((e, t) => {
                        let n =
                          a && "en" !== a && e.translations?.[a]
                            ? e.translations[a].questionText
                            : e.questionText;
                        return (0, s.jsx)(
                          "button",
                          {
                            onClick: () =>
                              ((e) => {
                                let t =
                                  a && "en" !== a && e.translations?.[a]
                                    ? e.translations[a].questionText
                                    : e.questionText;
                                (o({ questionId: e._id, questionText: t, locale: a }),
                                  r({ id: eg()(), role: "user", content: t }));
                              })(e),
                            className:
                              "font-medium text-left text-sm text-primary hover:brightness-[0.75] dark:hover:brightness-[1.35] dark:text-primary-light dark:hover:text-primary transition-colors",
                            children: n,
                          },
                          t,
                        );
                      }),
                    ],
                  }),
                }),
            ],
          });
        },
        ex = 368,
        ep = 576,
        ef = ({ className: e, minWidth: t = ex, maxWidth: r = ep, hidden: d = !1 }) => {
          let { isChatSheetOpen: x, onChatSheetToggle: N } = (0, n.useContext)(
              w.ChatAssistantContext,
            ),
            C = (0, g.n)(),
            { starterQuestions: I, assistantConfig: S } = (0, n.useContext)(w.SearchContext),
            E = (0, f.A)((e) => e.messages.length),
            _ = (0, f.A)((e) => "submitted" === e.status || "streaming" === e.status);
          (0, p.f)({
            key: "x",
            isDisabled: !x || !_,
            callback: () => f.A.getState().activeStop?.(),
          });
          let A = (0, n.useRef)(null),
            L = (0, n.useRef)(null),
            [$, P] = i("chat-assistant-sheet-width", t),
            [z, R] = (0, n.useState)(!1),
            M = (0, m.p)("docs.assistant.maximize_click"),
            T = (0, m.p)("docs.assistant.minimize_click"),
            F = (0, n.useMemo)(() => $ >= r, [$, r]),
            D = (0, a.Ub)("(max-width: 1024px)"),
            [O, B] = (0, n.useState)(!1),
            [H, q] = (0, n.useState)(!1),
            [Q, W] = (0, n.useState)(0),
            [K, V] = (0, n.useState)(!1);
          (0, n.useEffect)(() => {
            (B(!0), q(D));
          }, [D]);
          let U = (0, n.useRef)(!1),
            Y = (0, n.useRef)(0),
            G = (0, n.useRef)(null),
            J = (0, n.useRef)(!1),
            X = (0, n.useRef)(!1);
          (0, n.useEffect)(() => {
            if (!x) {
              return;
            }
            let e = G.current,
              t = A.current;
            if (!e || !t) {
              return;
            }
            let r = new IntersectionObserver(
              ([e]) => {
                J.current = e?.isIntersecting ?? !1;
              },
              { root: t, threshold: 0.1 },
            );
            return (r.observe(e), () => r.disconnect());
          }, [x]);
          let Z = (0, n.useCallback)((e) => {
              let t = e.touches[0];
              t &&
                (V(!1), W(0), (U.current = !1), (X.current = J.current), (Y.current = t.clientY));
            }, []),
            ee = (0, n.useCallback)((e) => {
              let t = e.touches[0];
              if (!t) {
                return;
              }
              let r = t.clientY - Y.current;
              if (U.current) {
                (e.preventDefault(), W(Math.max(0, r)));
                return;
              }
              !(r <= 10) && X.current && ((U.current = !0), V(!0), e.preventDefault(), W(r));
            }, []),
            et = (0, n.useCallback)(() => {
              (V(!1), W(0), (U.current = !1), (Y.current = 0));
            }, []),
            er = (0, n.useCallback)(() => {
              (U.current && Q > 100 && N(), et());
            }, [Q, N, et]),
            es = (0, n.useCallback)(() => {
              et();
            }, [et]),
            en = (0, n.useCallback)((e) => {
              (e.preventDefault(), R(!0), (document.body.style.cursor = "col-resize"));
            }, []),
            ea = (0, n.useCallback)(
              (e) => {
                z &&
                  L.current &&
                  P(Math.min(Math.max(L.current.getBoundingClientRect().right - e.clientX, t), r));
              },
              [z, t, r, P],
            ),
            ei = (0, n.useCallback)(() => {
              (R(!1), (document.body.style.cursor = "default"));
            }, []),
            eo = (0, n.useCallback)(() => {
              (F ? T({}).catch(console.error) : M({}).catch(console.error), P(F ? t : r));
            }, [F, t, r, P, M, T]);
          ((0, n.useEffect)(
            () => (
              z &&
                (document.addEventListener("mousemove", ea),
                document.addEventListener("mouseup", ei)),
              () => {
                (document.removeEventListener("mousemove", ea),
                  document.removeEventListener("mouseup", ei));
              }
            ),
            [z, ea, ei],
          ),
            (0, n.useEffect)(() => {
              if (O && H && x) {
                let e = window.scrollY,
                  t = document.body.style.overflow,
                  r = document.body.style.position,
                  s = document.body.style.top,
                  n = document.body.style.width;
                return (
                  (document.body.style.overflow = "hidden"),
                  (document.body.style.position = "fixed"),
                  (document.body.style.top = `-${e}px`),
                  (document.body.style.width = "100%"),
                  (document.body.style.height = "100%"),
                  () => {
                    ((document.body.style.overflow = t),
                      (document.body.style.position = r),
                      (document.body.style.top = s),
                      (document.body.style.width = n),
                      (document.body.style.height = ""),
                      window.scrollTo(0, e));
                  }
                );
              }
            }, [O, H, x]));
          let el = (0, s.jsxs)("div", {
            suppressHydrationWarning: !0,
            className: (0, k.cn)(
              H
                ? "fixed inset-0 z-10"
                : (0, k.cn)(
                    "sticky top-0 h-screen shrink-0 z-[22]",
                    "bg-background-light dark:bg-background-dark",
                  ),
              H && h.f.Popup,
              e,
              "print:hidden",
            ),
            style: {
              width: H ? void 0 : d ? 0 : `${$}px`,
              minWidth: H || d ? void 0 : `${t}px`,
              maxWidth: H || d ? void 0 : `${r}px`,
              pointerEvents: (H && !x) || d ? "none" : void 0,
              visibility: d ? "hidden" : void 0,
              overflow: d ? "hidden" : void 0,
            },
            children: [
              H &&
                (0, s.jsx)("div", {
                  className: (0, k.cn)(
                    "absolute inset-0 bg-black/40 transition-opacity duration-200",
                    x ? "opacity-100" : "opacity-0",
                  ),
                  onClick: () => N(),
                }),
              !H &&
                (0, s.jsx)("div", {
                  className: (0, k.cn)(
                    "absolute left-0 top-0 bottom-0 w-px z-10 cursor-col-resize",
                    "bg-gray-100 dark:bg-gray-800",
                    "hover:bg-gray-200 dark:hover:bg-gray-700",
                    'after:content-[""] after:absolute after:inset-y-0 after:-inset-x-2 after:select-none',
                    z && "bg-gray-200 dark:bg-gray-700",
                  ),
                  onMouseDown: en,
                }),
              (0, s.jsxs)("div", {
                ref: L,
                id: y.V.ChatAssistantSheet,
                className: (0, k.cn)(
                  "flex flex-col overflow-hidden shrink-0",
                  O && H
                    ? "overscroll-contain bg-background-light dark:bg-background-dark"
                    : "h-full bg-background-light dark:bg-background-dark",
                  H && !K && "transition-transform duration-200 ease-out",
                  v.x.ChatAssistantSheet,
                ),
                style:
                  O && H
                    ? {
                        position: "fixed",
                        left: 0,
                        right: 0,
                        bottom: 0,
                        height: "85vh",
                        borderTopLeftRadius: "16px",
                        borderTopRightRadius: "16px",
                        zIndex: 10,
                        transform: x ? `translateY(${Q}px)` : "translateY(100%)",
                        willChange: "transform",
                      }
                    : void 0,
                "aria-hidden": !x,
                onTouchStart: H ? Z : void 0,
                onTouchMove: H ? ee : void 0,
                onTouchEnd: H ? er : void 0,
                onTouchCancel: H ? es : void 0,
                children: [
                  H &&
                    (0, s.jsx)("div", {
                      className: "flex justify-center pt-3 touch-none",
                      children: (0, s.jsx)("div", {
                        className: "w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600",
                      }),
                    }),
                  (0, s.jsxs)("div", {
                    className: (0, k.cn)(
                      "w-full flex flex-col flex-1 min-h-0",
                      O && H ? "pt-0" : "lg:pt-3",
                    ),
                    children: [
                      (0, s.jsxs)("div", {
                        className: (0, k.cn)(
                          v.x.ChatAssistantSheetHeader,
                          "flex items-center justify-between pb-3 px-4",
                        ),
                        children: [
                          (0, s.jsxs)("div", {
                            className: "flex items-center gap-2",
                            children: [
                              (0, s.jsx)(j.BZ, {
                                className: "size-5 text-primary dark:text-primary-light",
                              }),
                              (0, s.jsx)("span", {
                                className: "font-medium text-gray-900 dark:text-gray-100",
                                children: C.assistant,
                              }),
                            ],
                          }),
                          (0, s.jsxs)("div", {
                            className: "flex items-center gap-1",
                            children: [
                              !H &&
                                (0, s.jsx)("button", {
                                  onClick: eo,
                                  className:
                                    "group hover:bg-gray-100 dark:hover:bg-white/10 p-1.5 rounded-lg",
                                  children: F
                                    ? (0, s.jsx)(o.A, {
                                        className:
                                          "size-4 sm:size-3.5 text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300",
                                      })
                                    : (0, s.jsx)(l.A, {
                                        className:
                                          "size-4 sm:size-3.5 text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300",
                                      }),
                                }),
                              E > 0 && (0, s.jsx)(ey, {}),
                              (0, s.jsx)("button", {
                                onClick: () => {
                                  (f.A.getState().activeStop?.(), N());
                                },
                                className:
                                  "group hover:bg-gray-100 dark:hover:bg-white/10 p-1.5 rounded-lg",
                                children: (0, s.jsx)(c.A, {
                                  className:
                                    "size-[20px] sm:size-4 text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300",
                                }),
                              }),
                            ],
                          }),
                        ],
                      }),
                      (0, s.jsxs)("div", {
                        ref: A,
                        id: "chat-content",
                        className: (0, k.cn)(
                          v.x.ChatAssistantSheetContent,
                          "flex flex-col-reverse flex-1 overflow-y-auto relative px-5 min-h-0",
                        ),
                        style: K ? { overflow: "hidden", touchAction: "none" } : void 0,
                        children: [
                          (0, s.jsx)("div", { className: "flex-grow" }),
                          E > 0
                            ? (0, s.jsx)(ec, { handleClose: D ? () => N() : void 0 })
                            : (0, s.jsx)(em, { starterQuestions: I, assistantConfig: S }),
                          (0, s.jsx)("div", { ref: G, className: "h-px w-full shrink-0" }),
                        ],
                      }),
                      (0, s.jsxs)("div", {
                        className: "px-4 pb-4 shrink-0",
                        children: [
                          (0, s.jsx)(eu, { scrollRef: A, isMobile: H }),
                          S?.deflection?.enabled &&
                            S.deflection.email &&
                            S.deflection.showHelpButton &&
                            (0, s.jsx)("div", {
                              className: "w-full flex items-center justify-between",
                              children: (0, s.jsxs)("a", {
                                href: `mailto:${S.deflection.email}`,
                                className:
                                  "group flex justify-between items-center gap-1 mt-2 py-1 transition-colors duration-200",
                                children: [
                                  (0, s.jsx)(b.A, {
                                    icon: "circle-question",
                                    className:
                                      "w-3 h-3 bg-gray-400 group-hover:bg-gray-600 dark:group-hover:bg-gray-300",
                                  }),
                                  (0, s.jsx)("p", {
                                    className:
                                      "text-gray-400 font-regular text-xs group-hover:text-gray-600 dark:group-hover:text-gray-300",
                                    children: C["assistant.createSupportTicket"],
                                  }),
                                ],
                              }),
                            }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          });
          return O ? (H ? (0, u.createPortal)(el, document.body) : el) : null;
        },
        ey = () => {
          let { onClear: e } = (0, x.w)();
          return (0, s.jsx)("button", {
            onClick: e,
            className: "group hover:bg-gray-100 dark:hover:bg-white/10 p-1.5 rounded-lg",
            children: (0, s.jsx)(d.A, {
              className:
                "size-4 sm:size-3.5 text-gray-500 group-hover:text-gray-700 dark:group-hover:text-gray-300",
            }),
          });
        };
      function ev({ children: e }) {
        let { isChatSheetOpen: t } = (0, n.useContext)(w.ChatAssistantContext),
          r = (0, a.Ub)("(max-width: 1024px)"),
          [o, l] = (0, n.useState)(!1),
          [c, d] = (0, n.useState)(!1),
          [u] = i("chat-assistant-sheet-width", ex);
        ((0, n.useEffect)(() => {
          (l(!0), d(r));
        }, [r]),
          (0, n.useEffect)(() => {
            if (!o || c) {
              return;
            }
            let e = document.documentElement;
            return (
              e.style.setProperty("--assistant-sheet-width", t ? `${u}px` : "0px"),
              () => {
                e.style.removeProperty("--assistant-sheet-width");
              }
            );
          }, [o, c, t, u]));
        let h = o && !c;
        return (0, s.jsxs)("div", {
          className: "max-lg:contents lg:flex lg:w-full",
          children: [
            (0, s.jsx)("div", {
              className: "max-lg:contents lg:flex-1 lg:min-w-0 lg:overflow-x-clip",
              children: e,
            }),
            (0, s.jsx)(ef, { hidden: h && !t }),
          ],
        });
      }
    },
    92177: (e, t, r) => {
      "use strict";
      r.d(t, { LocalStorageAndAnalyticsProviders: () => V });
      var s = r(54568),
        n = r(7620),
        a = r(42758),
        i = r(23792);
      function o({ clarity: e }) {
        return e?.projectId
          ? (0, s.jsx)(i.default, {
              strategy: "afterInteractive",
              id: "clarity-init",
              type: "text/javascript",
              dangerouslySetInnerHTML: {
                __html: `
          (function(c,l,a,r,i){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            var t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
            var y=l.getElementsByTagName(r)[0];if(y&&y.parentNode){y.parentNode.insertBefore(t,y);}else{l.head.appendChild(t);}
          })(window, document, "clarity", "script", "${e.projectId}");
        `,
              },
            })
          : null;
      }
      function l({ clearbit: e }) {
        return e?.publicApiKey
          ? (0, s.jsx)(s.Fragment, {
              children: (0, s.jsx)(i.default, {
                strategy: "afterInteractive",
                src: `https://tag.clearbitscripts.com/v1/${e.publicApiKey}/tags.js`,
              }),
            })
          : null;
      }
      function c({ ga4: e }) {
        return e?.measurementId
          ? (0, s.jsxs)(s.Fragment, {
              children: [
                (0, s.jsx)(i.default, {
                  strategy: "afterInteractive",
                  src: `https://www.googletagmanager.com/gtag/js?id=${e.measurementId}`,
                }),
                (0, s.jsx)(i.default, {
                  strategy: "afterInteractive",
                  id: "ga4",
                  dangerouslySetInnerHTML: {
                    __html: `
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${e.measurementId}', {
              page_path: window.location.pathname,
            });
          `,
                  },
                }),
              ],
            })
          : null;
      }
      function d({ gtm: e }) {
        return e?.tagId
          ? (0, s.jsxs)(s.Fragment, {
              children: [
                (0, s.jsx)(i.default, {
                  id: "gtm",
                  strategy: "afterInteractive",
                  dangerouslySetInnerHTML: {
                    __html: `
          (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${e.tagId}');`,
                  },
                }),
                (0, s.jsx)("noscript", {
                  children: (0, s.jsx)("iframe", {
                    src: `https://www.googletagmanager.com/ns.html?id=${e.tagId}`,
                    height: "0",
                    width: "0",
                    style: { display: "none", visibility: "hidden" },
                  }),
                }),
              ],
            })
          : null;
      }
      function u({ heap: e }) {
        return e?.appId
          ? (0, s.jsx)(i.default, {
              id: "heap",
              type: "text/javascript",
              dangerouslySetInnerHTML: {
                __html: `
          window.heap=window.heap||[],heap.load=function(e,t){window.heap.appid=e,window.heap.config=t=t||{};var r=document.createElement("script");r.type="text/javascript",r.async=!0,r.src="https://cdn.heapanalytics.com/js/heap-"+e+".js";var a=document.getElementsByTagName("script")[0];a.parentNode.insertBefore(r,a);for(var n=function(e){return function(){heap.push([e].concat(Array.prototype.slice.call(arguments,0)))}},p=["addEventProperties","addUserProperties","clearEventProperties","identify","resetIdentity","removeEventProperty","setEventProperties","track","unsetEventProperty"],o=0;o<p.length;o++)heap[p[o]]=n(p[o])};
          heap.load("${e.appId}");
          `,
              },
            })
          : null;
      }
      function h({ koala: e }) {
        return e?.publicApiKey
          ? (0, s.jsx)(s.Fragment, {
              children: (0, s.jsx)(i.default, {
                strategy: "afterInteractive",
                id: "koala",
                dangerouslySetInnerHTML: {
                  __html: `
          !(function (t) {
            if (window.ko) return;
            (window.ko = []),
              [
                "identify",
                "track",
                "removeListeners",
                "open",
                "on",
                "off",
                "qualify",
                "ready",
              ].forEach(function (t) {
                ko[t] = function () {
                  var n = [].slice.call(arguments);
                  return n.unshift(t), ko.push(n), ko;
                };
              });
            var n = document.createElement("script");
            (n.async = !0),
              n.setAttribute(
                "src",
                "https://cdn.getkoala.com/v1/${e.publicApiKey}/sdk.js"
              ),
              (document.body || document.head).appendChild(n);
          })();
          `,
                },
              }),
            })
          : null;
      }
      function g({ plausible: e }) {
        return e?.domain
          ? (0, s.jsx)(i.default, {
              strategy: "afterInteractive",
              "data-domain": e.domain,
              src: `https://${e.server ?? "plausible.io"}/js/script.js`,
            })
          : null;
      }
      var m = r(90280),
        x = r(30793);
      function p({ segment: e }) {
        return e?.key
          ? (0, s.jsx)(i.default, {
              strategy: "afterInteractive",
              id: "segment",
              dangerouslySetInnerHTML: {
                __html: `
  !function(){var i="analytics",analytics=window[i]=window[i]||[];if(!analytics.initialize)if(analytics.invoked)window.console&&console.error&&console.error("Segment snippet included twice.");else{analytics.invoked=!0;analytics.methods=["trackSubmit","trackClick","trackLink","trackForm","pageview","identify","reset","group","track","ready","alias","debug","page","screen","once","off","on","addSourceMiddleware","addIntegrationMiddleware","setAnonymousId","addDestinationMiddleware","register"];analytics.factory=function(e){return function(){if(window[i].initialized)return window[i][e].apply(window[i],arguments);var n=Array.prototype.slice.call(arguments);if(["track","screen","alias","group","page","identify"].indexOf(e)>-1){n.push({__t:"bpc",c:location.href,p:location.pathname,u:location.href,s:location.search,t:document.title,r:document.referrer})}n.unshift(e);analytics.push(n);return analytics}};for(var n=0;n<analytics.methods.length;n++){var key=analytics.methods[n];analytics[key]=analytics.factory(key)}analytics.load=function(key,n){var t=document.createElement("script");t.type="text/javascript";t.async=!0;t.setAttribute("data-global-segment-analytics-key",i);t.src="https://cdn.segment.com/analytics.js/v1/" + key + "/analytics.min.js";var r=document.getElementsByTagName("script")[0];r.parentNode.insertBefore(t,r);analytics._loadOptions=n};analytics._writeKey="${e.key}";;analytics.SNIPPET_VERSION="5.2.0";
  analytics.load("${e.key}");
  analytics.page();
  }}();`,
              },
            })
          : null;
      }
      let f = () => {
        let { docsConfig: e } = (0, n.useContext)(x.DocsConfigContext);
        return m.db
          ? (0, s.jsxs)(s.Fragment, {
              children: [
                (0, s.jsx)(o, { clarity: e?.integrations?.clarity }),
                (0, s.jsx)(l, { clearbit: e?.integrations?.clearbit }),
                (0, s.jsx)(c, { ga4: e?.integrations?.ga4 }),
                (0, s.jsx)(d, { gtm: e?.integrations?.gtm }),
                (0, s.jsx)(u, { heap: e?.integrations?.heap }),
                (0, s.jsx)(h, { koala: e?.integrations?.koala }),
                (0, s.jsx)(g, { plausible: e?.integrations?.plausible }),
                (0, s.jsx)(p, { segment: e?.integrations?.segment }),
              ],
            })
          : null;
      };
      var y = r(27541),
        v = r(13435);
      class b {}
      class j extends b {
        init(e, t = !1) {
          e.apiKey &&
            r
              .e(803)
              .then(r.bind(r, 89211))
              .then((r) => {
                r.default.init(e.apiKey, {
                  api_host: e.apiHost || "https://ph.mintlify.com",
                  ui_host: "https://us.posthog.com",
                  capture_pageview: !1,
                  disable_session_recording: !t,
                  loaded: (e) => {
                    (m.db || e.opt_out_capturing(),
                      (this.posthog = e),
                      (this.initialized = !0),
                      this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                        this.captureEvent(e, t);
                      }),
                      (this.eventQueue = []));
                  },
                });
              })
              .catch((e) => {
                console.error("Failed to load PostHog", e);
              });
        }
        captureEvent(e, t = {}) {
          if (this.initialized) {
            return void this.posthog?.capture(e, { ...t });
          }
          this.eventQueue.push({ eventName: e, eventProperties: { ...t } });
        }
        createEventListener(e) {
          return async (t) => {
            this.captureEvent(e, t);
          };
        }
        onRouteChange(e, t) {
          (this.captureEvent("$pageview"), this.captureEvent(`$${v.bJ}`));
        }
        constructor(...e) {
          (super(...e), (this.initialized = !1), (this.eventQueue = []), (this.posthog = null));
        }
      }
      class k {
        constructor(e = 10, t = 5e3) {
          ((this.queue = []),
            (this.isProcessing = !1),
            (this.batchSize = e),
            (this.flushInterval = t));
        }
        enqueue(e) {
          this.queue.push({ event: e, timestamp: Date.now(), retryCount: 0 });
        }
        shouldFlush() {
          return this.queue.length >= this.batchSize;
        }
        getBatch() {
          return this.queue.splice(0, this.batchSize);
        }
        requeueEvents(e) {
          let t = e.map((e) =>
            Object.assign(Object.assign({}, e), { retryCount: e.retryCount + 1 }),
          );
          this.queue.unshift(...t);
        }
        startPeriodicFlush(e) {
          (this.flushTimer && clearInterval(this.flushTimer),
            (this.flushTimer = setInterval(() => {
              this.queue.length > 0 &&
                !this.isProcessing &&
                ((this.isProcessing = !0),
                e().finally(() => {
                  this.isProcessing = !1;
                }));
            }, this.flushInterval)));
        }
        size() {
          return this.queue.length;
        }
      }
      class w {
        constructor(e) {
          ((this.storage = e), (this.identity = this.loadOrCreateIdentity()));
        }
        loadOrCreateIdentity() {
          let e = this.storage.get(w.KEYS.ANONYMOUS_ID),
            t = this.storage.get(w.KEYS.USER_ID),
            r = this.storage.get(w.KEYS.SESSION_ID, "session"),
            s = e;
          s || ((s = this.generateId("anon")), this.storage.set(w.KEYS.ANONYMOUS_ID, s));
          let n = r;
          return (
            n ||
              ((n = this.generateId("session")), this.storage.set(w.KEYS.SESSION_ID, n, "session")),
            { anonymousId: s, userId: t || void 0, sessionId: n }
          );
        }
        generateId(e) {
          return `${e}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        }
        identify(e) {
          e &&
            "string" == typeof e &&
            ((this.identity.userId = e), this.storage.set(w.KEYS.USER_ID, e));
        }
        reset() {
          let e = this.generateId("anon"),
            t = this.generateId("session");
          ((this.identity = { anonymousId: e, userId: void 0, sessionId: t }),
            this.storage.set(w.KEYS.ANONYMOUS_ID, e),
            this.storage.remove(w.KEYS.USER_ID),
            this.storage.set(w.KEYS.SESSION_ID, t, "session"));
        }
        getIdentity() {
          return Object.assign({}, this.identity);
        }
        getAnonymousId() {
          return this.identity.anonymousId;
        }
        getUserId() {
          return this.identity.userId;
        }
        getSessionId() {
          return this.identity.sessionId;
        }
      }
      w.KEYS = {
        ANONYMOUS_ID: "mintlify_anonymous_id",
        USER_ID: "mintlify_user_id",
        SESSION_ID: "mintlify_session_id",
      };
      var N = r(31899);
      class C {
        buildEvent(e, t, r, s) {
          let n = Object.assign({}, t),
            a = {
              event_id: (0, N.A)(),
              subdomain: s,
              anon_id: r.anonymousId,
              session_id: r.sessionId,
              event: e,
              created_at: new Date().toISOString(),
            };
          r.userId && (a.user_id = r.userId);
          {
            ((a.path = window.location.pathname), (a.referrer = document.referrer));
            let e = window.location.search;
            e && (n.$current_url_search = e);
            let t = window.location.hash;
            (t && (n.$current_url_hash = t),
              (n.$current_url = window.location.href),
              (n.$viewport_height = window.innerHeight.toString()),
              (n.$viewport_width = window.innerWidth.toString()));
          }
          if (
            "undefined" != typeof navigator &&
            ((a.user_agent = navigator.userAgent),
            (n.$browser_language = navigator.language),
            "connection" in navigator)
          ) {
            let e = navigator.connection;
            e && (n.$network_connection_type = e.effectiveType);
          }
          "undefined" != typeof screen &&
            ((n.$screen_height = screen.height.toString()),
            (n.$screen_width = screen.width.toString()));
          try {
            n.$timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          } catch (e) {}
          return (Object.keys(n).length > 0 && (a.properties = n), a);
        }
        buildBatchPayload(e) {
          return JSON.stringify({ events: e, timestamp: Date.now() });
        }
      }
      class I {
        getStorage(e) {
          try {
            return "session" === e ? sessionStorage : localStorage;
          } catch (e) {
            return null;
          }
        }
        get(e, t = "local") {
          try {
            let r = this.getStorage(t);
            return (null == r ? void 0 : r.getItem(e)) || null;
          } catch (e) {
            return null;
          }
        }
        set(e, t, r = "local") {
          try {
            let s = this.getStorage(r);
            null == s || s.setItem(e, t);
          } catch (e) {
            console.warn(`Failed to set item in ${r}Storage`);
          }
        }
        remove(e, t = "local") {
          try {
            let r = this.getStorage(t);
            null == r || r.removeItem(e);
          } catch (e) {
            console.warn(`Failed to remove item from ${t}Storage`);
          }
        }
      }
      class S {
        constructor() {
          ((this.isUnloading = !1), this.setupPageLifecycleHandlers());
        }
        setupPageLifecycleHandlers() {
          let e = () => {
            this.isUnloading = !0;
          };
          (window.addEventListener("beforeunload", e),
            window.addEventListener("pagehide", e),
            document.addEventListener("visibilitychange", () => {
              "hidden" === document.visibilityState && (this.isUnloading = !0);
            }));
        }
        send(e, t) {
          var r, s, n, a;
          return (
            (r = this),
            (s = void 0),
            (n = void 0),
            (a = function* () {
              if (
                this.isUnloading &&
                "undefined" != typeof navigator &&
                "sendBeacon" in navigator &&
                navigator.sendBeacon(e, t)
              ) {
                return new Response("", { status: 202 });
              }
              let r = yield fetch(e, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: t,
              });
              if (!r.ok) {
                let e = Error(`HTTP ${r.status}`);
                throw ((e.status = r.status), e);
              }
              return r;
            }),
            new (n || (n = Promise))(function (e, t) {
              function i(e) {
                try {
                  l(a.next(e));
                } catch (e) {
                  t(e);
                }
              }
              function o(e) {
                try {
                  l(a.throw(e));
                } catch (e) {
                  t(e);
                }
              }
              function l(t) {
                var r;
                t.done
                  ? e(t.value)
                  : ((r = t.value) instanceof n
                      ? r
                      : new n(function (e) {
                          e(r);
                        })
                    ).then(i, o);
              }
              l((a = a.apply(r, s || [])).next());
            })
          );
        }
      }
      var E = function (e, t, r, s) {
        return new (r || (r = Promise))(function (n, a) {
          function i(e) {
            try {
              l(s.next(e));
            } catch (e) {
              a(e);
            }
          }
          function o(e) {
            try {
              l(s.throw(e));
            } catch (e) {
              a(e);
            }
          }
          function l(e) {
            var t;
            e.done
              ? n(e.value)
              : ((t = e.value) instanceof r
                  ? t
                  : new r(function (e) {
                      e(t);
                    })
                ).then(i, o);
          }
          l((s = s.apply(e, t || [])).next());
        });
      };
      class _ {
        constructor(e) {
          ((this.config = Object.assign({ batchSize: 10, flushInterval: 5e3, maxRetries: 3 }, e)),
            (this.transportManager = new S()),
            (this.payloadBuilder = new C()),
            (this.storageManager = new I()),
            (this.identityManager = new w(this.storageManager)),
            (this.eventQueue = new k(this.config.batchSize, this.config.flushInterval)),
            this.eventQueue.startPeriodicFlush(() => this.flushEvents()),
            this.setupPageLifecycleHandlers());
        }
        trackEvent(e) {
          return E(this, arguments, void 0, function* (e, t = {}) {
            let r = this.identityManager.getIdentity(),
              s = Object.entries(t).reduce(
                (e, [t, r]) => ((e[t] = "string" == typeof r ? r : JSON.stringify(r)), e),
                {},
              ),
              n = this.payloadBuilder.buildEvent(e, s, r, this.config.subdomain);
            (this.eventQueue.enqueue(n),
              this.eventQueue.shouldFlush() && (yield this.flushEvents()));
          });
        }
        flushEvents() {
          return E(this, void 0, void 0, function* () {
            let e = this.eventQueue.getBatch();
            if (0 === e.length) {
              return;
            }
            let t = e.map((e) => e.event),
              r = this.payloadBuilder.buildBatchPayload(t);
            try {
              yield this.transportManager.send(this.config.apiEndpoint, r);
            } catch (s) {
              let t = s.status;
              if (400 === t || 401 === t || 403 === t || 404 === t || 413 === t) {
                return;
              }
              let r = e.filter((e) => {
                var t;
                return e.retryCount < (null != (t = this.config.maxRetries) ? t : 3);
              });
              r.length > 0 && this.eventQueue.requeueEvents(r);
            }
          });
        }
        setupPageLifecycleHandlers() {
          let e = () => {
            this.forceFlush();
          };
          (window.addEventListener("beforeunload", e),
            window.addEventListener("pagehide", e),
            document.addEventListener("visibilitychange", () => {
              "hidden" === document.visibilityState && this.forceFlush();
            }));
        }
        forceFlush() {
          return E(this, void 0, void 0, function* () {
            yield this.flushEvents();
          });
        }
        identify(e) {
          this.identityManager.identify(e);
        }
        reset() {
          this.identityManager.reset();
        }
        getQueueLength() {
          return this.eventQueue.size();
        }
        getSessionId() {
          return this.identityManager.getSessionId();
        }
        getAnonymousId() {
          return this.identityManager.getAnonymousId();
        }
        getUserId() {
          return this.identityManager.getUserId();
        }
      }
      var A = r(98167);
      class L extends b {
        constructor(e) {
          (super(),
            (this.initialized = !1),
            (this.subdomain = e),
            (this.mintlifySdk = new _({
              apiEndpoint: `${A.c.BASE_PATH}/_mintlify/api/v1/e`,
              subdomain: this.subdomain,
            })));
        }
        init() {
          this.initialized = !0;
        }
        captureEvent(e) {
          return async (t) => {
            this.mintlifySdk.trackEvent(e, t);
          };
        }
        createEventListener(e) {
          return this.initialized ? this.captureEvent(e) : async function (e) {};
        }
        onRouteChange(e, t) {
          this.mintlifySdk.trackEvent(v.bJ, {
            subdomain: this.subdomain,
            title: "undefined" != typeof document ? document.title : "",
          });
        }
      }
      class $ extends b {
        init(e) {
          if (!e.apiKey) {
            return;
          }
          let { apiKey: t } = e;
          r.e(78416)
            .then(r.bind(r, 78416))
            .then((e) => {
              this.initialized ||
                (e.init(t),
                (this.track = e.track),
                (this.initialized = !0),
                this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                  this.track(e, t);
                }),
                (this.eventQueue = []));
            })
            .catch((e) => {
              ((this.track = () => {}), console.error(e));
            });
        }
        createEventListener(e) {
          return async function (t) {
            this.track(e, t);
          }.bind(this);
        }
        onRouteChange(e, t) {
          t.shallow || (this.track("page_view", { url: e }), this.track(v.bJ, { url: e }));
        }
        constructor(...e) {
          (super(...e),
            (this.initialized = !1),
            (this.eventQueue = []),
            (this.track = (e, t) => {
              "string" == typeof e &&
                t &&
                this.eventQueue.push({ eventName: e, eventProperties: t });
            }));
        }
      }
      class P extends b {
        init(e) {
          this.projectId = e.projectId;
        }
        createEventListener(e) {
          return this.projectId && "clarity" in window && "function" == typeof window.clarity
            ? async function (t) {
                try {
                  window.clarity("event", e);
                } catch (e) {
                  console.warn("Failed to track Clarity event:", e);
                }
              }
            : async function (e) {};
        }
        onRouteChange(e, t) {}
      }
      class z extends b {
        init(e) {
          if (!e.siteId) {
            return;
          }
          let { siteId: t } = e;
          r.e(39960)
            .then(r.bind(r, 39960))
            .then((e) => {
              this.initialized ||
                (e.load(t), (this.trackPageview = e.trackPageview), (this.initialized = !0));
            })
            .catch((e) => {
              console.error(e);
            });
        }
        createEventListener(e) {
          return () => Promise.resolve();
        }
        onRouteChange(e, t) {
          this.trackPageview && !t.shallow && this.trackPageview();
        }
        constructor(...e) {
          (super(...e), (this.initialized = !1));
        }
      }
      class R extends b {
        init(e) {
          this.measurementId = e.measurementId;
        }
        createEventListener(e) {
          return this.measurementId && "gtag" in window
            ? async function (t) {
                window.gtag("event", e, {});
              }
            : async function (e) {};
        }
        onRouteChange(e) {
          this.measurementId &&
            "gtag" in window &&
            window.gtag("config", this.measurementId, { page_path: e });
        }
      }
      class M extends b {
        init(e) {
          if (!e.writeKey) {
            return;
          }
          let { writeKey: t, apiHost: s } = e;
          Promise.all([r.e(5706), r.e(16521), r.e(34012), r.e(61023)])
            .then(r.bind(r, 61023))
            .then((e) => {
              if (!this.initialized) {
                let r = e.HtEventsBrowser.load(
                  { writeKey: t },
                  { apiHost: s || "us-east-1.hightouch-events.com" },
                );
                ((this.track = r.track),
                  (this.initialized = !0),
                  this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                    this.track(e, t);
                  }),
                  (this.eventQueue = []));
              }
            })
            .catch((e) => {
              ((this.track = () => {}), console.error(e));
            });
        }
        createEventListener(e) {
          return async function (t) {
            this.track(e, t);
          }.bind(this);
        }
        onRouteChange(e, t) {
          t.shallow || this.track(v.bJ, { url: e });
        }
        constructor(...e) {
          (super(...e),
            (this.initialized = !1),
            (this.eventQueue = []),
            (this.track = (e, t) => {
              e &&
                t &&
                "object" == typeof t &&
                this.eventQueue.push({ eventName: e, eventProperties: t });
            }));
        }
      }
      class T extends b {
        init(e) {
          if (!e.hjid || !e.hjsv) {
            return;
          }
          let t = parseInt(e.hjid, 10),
            s = parseInt(e.hjsv, 10);
          r.e(47272)
            .then(r.t.bind(r, 47272, 23))
            .then((e) => {
              this.initialized ||
                ((this.hotjar = e.hotjar),
                this.hotjar.initialize(t, s),
                (this.initialized = !0),
                this.eventQueue.forEach((e) => {
                  this.hotjar && this.hotjar.event(e);
                }));
            })
            .catch((e) => {
              console.error(e);
            });
        }
        createEventListener(e) {
          return async function (t) {
            this.hotjar ? this.hotjar.event(e) : this.eventQueue.push(e);
          }.bind(this);
        }
        onRouteChange(e, t) {}
        constructor(...e) {
          (super(...e), (this.initialized = !1), (this.eventQueue = []));
        }
      }
      class F extends b {
        init(e) {
          e.appId &&
            r
              .e(27701)
              .then(r.t.bind(r, 27701, 23))
              .then((t) => {
                (t.default.init(e.appId),
                  (this.trackEvent = t.default.track),
                  this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                    this.trackEvent?.(e, t);
                  }),
                  (this.eventQueue = []));
              })
              .catch((e) => {
                console.error("Failed to load LogRocket", e);
              });
        }
        captureEvent(e, t = {}) {
          if (this.trackEvent) {
            return void this.trackEvent(e, t);
          }
          this.eventQueue.push({ eventName: e, eventProperties: { ...t } });
        }
        createEventListener(e) {
          return async (t) => this.captureEvent(e, t);
        }
        onRouteChange(e, t) {}
        constructor(...e) {
          (super(...e), (this.eventQueue = []));
        }
      }
      class D extends b {
        init(e) {
          e.projectToken
            ? r
                .e(55284)
                .then(r.t.bind(r, 4874, 23))
                .then((t) => {
                  if (!this.initialized) {
                    let r = t.default;
                    (r.init(e.projectToken, { secure_cookie: !0 }),
                      (this.initialized = !0),
                      (this.mixpanel = r),
                      this.waitTracking.forEach((e) => {
                        this.mixpanel.track(e.name, e.properties);
                      }));
                  }
                })
                .catch((e) => {
                  console.error(e);
                })
            : (this.mixpanel.track = (e, t) => {});
        }
        createEventListener(e) {
          return async function (t) {
            this.mixpanel.track(e, t);
          }.bind(this);
        }
        onRouteChange(e) {
          (this.mixpanel.track("pageview", { path: e }), this.mixpanel.track(v.bJ, { path: e }));
        }
        constructor(...e) {
          (super(...e),
            (this.initialized = !1),
            (this.waitTracking = []),
            (this.mixpanel = {
              track: (e, t) => {
                this.waitTracking.push({ name: e, properties: t });
              },
            }));
        }
      }
      class O extends b {
        init(e) {
          if (!e.id) {
            return;
          }
          let t = e.id;
          r.e(98186)
            .then(r.t.bind(r, 98186, 23))
            .then((e) => {
              this.initialized ||
                ((this.pirsch = new e.Pirsch({ identificationCode: t })),
                (this.initialized = !0),
                this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                  this.pirsch && this.pirsch.event(e, void 0, t);
                }));
            })
            .catch((e) => {
              console.error(e);
            });
        }
        createEventListener(e) {
          return async function (t) {
            this.pirsch
              ? this.pirsch.event(e, void 0, t)
              : this.eventQueue.push({ eventName: e, eventProperties: t });
          }.bind(this);
        }
        onRouteChange(e) {
          this.pirsch && this.pirsch.hit();
        }
        constructor(...e) {
          (super(...e), (this.initialized = !1), (this.eventQueue = []));
        }
      }
      class B extends b {
        init(e) {
          if (!e.key) {
            return;
          }
          let { key: t } = e;
          Promise.all([r.e(24430), r.e(16521), r.e(65223)])
            .then(r.bind(r, 65223))
            .then((e) => {
              if (!this.initialized) {
                let r = new e.AnalyticsBrowser();
                (r.load({ writeKey: t }),
                  (this.track = r.track),
                  (this.initialized = !0),
                  this.eventQueue.forEach(({ eventName: e, eventProperties: t }) => {
                    this.track(e, t);
                  }),
                  (this.eventQueue = []));
              }
            })
            .catch((e) => {
              ((this.track = () => {}), console.error(e));
            });
        }
        createEventListener(e) {
          return async function (t) {
            this.track(e, t);
          }.bind(this);
        }
        onRouteChange(e, t) {
          t.shallow || this.track(v.bJ, { url: e });
        }
        constructor(...e) {
          (super(...e),
            (this.initialized = !1),
            (this.eventQueue = []),
            (this.track = (e, t) => {
              e &&
                t &&
                "object" == typeof t &&
                this.eventQueue.push({ eventName: e, eventProperties: t });
            }));
        }
      }
      class H {
        constructor(e, t) {
          this.analyticsIntegrations = [];
          let r = !!e?.clarity?.projectId,
            s = !!e?.amplitude?.apiKey,
            n = !!e?.fathom?.siteId,
            a = !!e?.ga4?.measurementId,
            i = !!e?.hightouch?.writeKey,
            o = !!(e?.hotjar?.hjid && e.hotjar.hjsv),
            l = !!e?.logrocket?.appId,
            c = !!e?.mixpanel?.projectToken,
            d = !!e?.pirsch?.id,
            u = !!e?.posthog?.apiKey,
            h = !!e?.segment?.key;
          if (r && e?.clarity) {
            let t = new P();
            (t.init(e.clarity), this.analyticsIntegrations.push(t));
          }
          if (s && e?.amplitude) {
            let t = new $();
            (t.init(e.amplitude), this.analyticsIntegrations.push(t));
          }
          if (n && e?.fathom) {
            let t = new z();
            (t.init(e.fathom), this.analyticsIntegrations.push(t));
          }
          if (a && e?.ga4) {
            let t = new R();
            (t.init(e.ga4), this.analyticsIntegrations.push(t));
          }
          if (i && e?.hightouch) {
            let t = new M();
            (t.init(e.hightouch), this.analyticsIntegrations.push(t));
          }
          if (o && e?.hotjar) {
            let t = new T();
            (t.init(e.hotjar), this.analyticsIntegrations.push(t));
          }
          if (l && e?.logrocket) {
            let t = new F();
            (t.init(e.logrocket), this.analyticsIntegrations.push(t));
          }
          if (c && e?.mixpanel) {
            let t = new D();
            (t.init(e.mixpanel), this.analyticsIntegrations.push(t));
          }
          if (d && e?.pirsch) {
            let t = new O();
            (t.init(e.pirsch), this.analyticsIntegrations.push(t));
          }
          if (u && e?.posthog) {
            let t = new j(),
              r = e.posthog.sessionRecording ?? !0;
            (t.init(e.posthog, r), this.analyticsIntegrations.push(t));
          }
          if (t) {
            let { subdomain: e } = t,
              r = new L(e);
            (r.init(), this.analyticsIntegrations.push(r));
          }
          if (h && e?.segment) {
            let t = new B();
            (t.init(e.segment), this.analyticsIntegrations.push(t));
          }
        }
        createEventListener(e) {
          let t = this.analyticsIntegrations.map((t) => t.createEventListener(e));
          return async function (e) {
            t.forEach((t) => t(e));
          };
        }
        onRouteChange(e, t) {
          this.analyticsIntegrations.forEach((r) => r.onRouteChange(e, t));
        }
      }
      var q = r(27194);
      function Q({ frontchat: e }) {
        return e?.snippetId
          ? (0, s.jsxs)(s.Fragment, {
              children: [
                (0, s.jsx)(i.default, {
                  strategy: "beforeInteractive",
                  src: "https://chat-assets.frontapp.com/v1/chat.bundle.js",
                }),
                (0, s.jsx)(i.default, {
                  id: "frontchat",
                  strategy: "afterInteractive",
                  children: `window.FrontChat('init', {chatId: '${e.snippetId}', useDefaultLauncher: true});`,
                }),
              ],
            })
          : null;
      }
      let W = () => {
        let { docsConfig: e } = (0, n.useContext)(x.DocsConfigContext);
        return m.db ? (0, s.jsx)(Q, { frontchat: e?.integrations?.frontchat }) : null;
      };
      var K = r(23752);
      function V({ children: e, subdomain: t }) {
        let { docsConfig: r } = (0, n.useContext)(x.DocsConfigContext),
          i = r?.integrations?.telemetry?.enabled === !1,
          o = ((e) => {
            let t = void 0 == e || e.integrations?.cookies !== void 0,
              r = e?.integrations?.cookies?.key,
              s = e?.integrations?.cookies?.value,
              [a, i] = (0, n.useState)(!t);
            return (
              (0, n.useEffect)(() => {
                t &&
                  void 0 !== r &&
                  void 0 !== s &&
                  ((window.localStorage.getItem(r) || "") === s ? i(!0) : i(!1));
              }, [t, r, s]),
              a
            );
          })(r),
          l = (function (e, t, r, s) {
            let a = (0, y.useRouter)(),
              i = (0, q.G)(),
              [o, l] = (0, n.useState)(!1),
              [c, d] = (0, n.useState)();
            return (
              (0, n.useEffect)(() => {
                let n;
                !r && s && m.db && !o && (t && (n = { subdomain: t }), d(new H(e, n)), l(!0));
              }, [o, e, t, r, s]),
              (0, n.useEffect)(() => {
                c && c.onRouteChange(i, { initialLoad: !0 });
              }, [i, c, a]),
              c
            );
          })(r?.integrations ?? {}, t, i, o);
        return (0, s.jsx)(a.y, {
          value: { analyticsMediator: l },
          children: (0, s.jsxs)(K.i, {
            cookiesEnabled: o,
            children: [(0, s.jsx)(W, {}), (0, s.jsx)(f, {}), e],
          }),
        });
      }
    },
  },
]);
