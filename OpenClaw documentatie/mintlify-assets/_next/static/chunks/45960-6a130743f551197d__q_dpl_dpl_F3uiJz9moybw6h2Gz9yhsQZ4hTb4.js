"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [45960],
  {
    6816: (e, a, r) => {
      r.d(a, { DefaultTopbar: () => o });
      var s = r(54568),
        t = r(7620),
        l = r(8677),
        n = r(67908),
        i = r(12192),
        d = r(35878),
        c = r(81325);
      function o({ pageModeClasses: e }) {
        let { banner: a } = (0, t.useContext)(i.y);
        return (0, s.jsx)("div", {
          id: d.V.Navbar,
          className: (0, c.cn)(
            n.f.Banner,
            a ? "w-full sticky top-0 hidden lg:block" : "hidden",
            ...e,
          ),
          children: (0, s.jsx)(l.l, {}),
        });
      }
    },
    7824: (e, a, r) => {
      r.d(a, { TopBar: () => N });
      var s = r(54568),
        t = r(7620),
        l = r(8677),
        n = r(67908),
        i = r(76829),
        d = r(35878),
        c = r(40588),
        o = r(91263),
        g = r(32795),
        x = r(55030),
        m = r(34766),
        h = r(12158),
        y = r(26842),
        u = r(81325),
        p = r(68999),
        b = r(8283),
        f = r(40972),
        j = r(30921);
      let v = () => (0, s.jsx)(j.NavbarLinks, { actionClassName: j.DEFAULT_ACTION_CLASSNAME });
      function N({ className: e, pageMetadata: a }) {
        let { divisions: r } = (0, t.useContext)(i.NavigationContext),
          j = (0, i.n)(),
          { search: N } = j,
          k = (0, x.O)(),
          [w, C] = (0, t.useState)(!1),
          A = r.tabs.length > 0;
        return (0, s.jsxs)("div", {
          id: d.V.Navbar,
          className: (0, u.cn)(n.f.PrimaryNav, "fixed lg:sticky top-0 w-full", e),
          children: [
            (0, s.jsx)("div", {
              id: d.V.NavBarTransition,
              className: (0, u.cn)(
                "absolute w-full h-full backdrop-blur flex-none transition-colors duration-500",
                "border-b border-gray-500/5 dark:border-gray-300/[0.06]",
                "data-[is-opaque=true]:bg-background-light data-[is-opaque=true]:supports-backdrop-blur:bg-background-light/95 data-[is-opaque=true]:dark:bg-background-dark/75",
                "data-[is-opaque=false]:supports-backdrop-blur:bg-background-light/60 data-[is-opaque=false]:dark:bg-transparent",
              ),
              "data-is-opaque": k,
            }),
            (0, s.jsx)(l.l, {}),
            (0, s.jsx)("div", {
              className: "max-w-8xl mx-auto relative",
              children: (0, s.jsxs)("div", {
                className: "relative",
                children: [
                  (0, s.jsx)("div", {
                    className: (0, u.cn)(
                      "flex items-center lg:px-12 h-16 min-w-0",
                      A ? "mx-4 lg:mx-0" : "px-4",
                    ),
                    children: (0, s.jsxs)("div", {
                      className: (0, u.cn)(
                        "h-full relative flex-1 flex items-center gap-x-4 min-w-0",
                        "border-b border-gray-500/5 dark:border-gray-300/[0.06]",
                        !A && "lg:border-none",
                      ),
                      children: [
                        (0, s.jsxs)("div", {
                          className: "flex-1 lg:flex-none flex items-center gap-x-4",
                          children: [
                            (0, s.jsx)(m.l, {}),
                            (0, s.jsx)(g.Xh, {}),
                            (0, s.jsx)(g.m4, { className: "max-lg:hidden" }),
                          ],
                        }),
                        (0, s.jsxs)("div", {
                          className:
                            "flex-1 relative hidden lg:flex items-center ml-auto justify-end gap-x-4",
                          children: [
                            (0, s.jsxs)("div", {
                              className: "flex items-center gap-x-6",
                              children: [
                                (0, s.jsx)("div", {
                                  className: "h-16 font-semibold",
                                  children: (0, s.jsx)(b.U, { underlineClassName: "hidden" }),
                                }),
                                (0, s.jsx)("nav", {
                                  className: "text-sm",
                                  children: (0, s.jsx)("ul", {
                                    className: "flex gap-x-6 items-center",
                                    children: (0, s.jsx)(v, {}),
                                  }),
                                }),
                              ],
                            }),
                            (0, s.jsxs)("div", {
                              className: "flex items-center gap-x-2",
                              children: [
                                (0, s.jsxs)(h.SearchButton, {
                                  className: "group w-8 h-8 flex items-center justify-center",
                                  id: d.V.SearchBarEntryMobile,
                                  children: [
                                    (0, s.jsx)("span", { className: "sr-only", children: N }),
                                    (0, s.jsx)(p.A, {
                                      icon: "magnifying-glass",
                                      iconType: "solid",
                                      className:
                                        "h-3.5 w-3.5 bg-gray-600 dark:bg-gray-300 group-hover:bg-gray-800 dark:group-hover:bg-gray-100",
                                    }),
                                  ],
                                }),
                                (0, s.jsx)(y.A, {}),
                                (0, s.jsx)(g.cI, {
                                  sunIconClassName: "text-gray-600 group-hover:text-gray-800",
                                  moonIconClassName: "text-gray-300 dark:group-hover:text-gray-100",
                                }),
                              ],
                            }),
                          ],
                        }),
                        (0, s.jsxs)("div", {
                          className: "flex lg:hidden items-center gap-3",
                          children: [
                            (0, s.jsxs)(h.SearchButton, {
                              className:
                                "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                              id: d.V.SearchBarEntryMobile,
                              children: [
                                (0, s.jsx)("span", { className: "sr-only", children: N }),
                                (0, s.jsx)(p.A, {
                                  icon: "magnifying-glass",
                                  iconType: "solid",
                                  className:
                                    "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                }),
                              ],
                            }),
                            (0, s.jsx)(y.A, {}),
                            (0, s.jsx)("button", {
                              "aria-label": j["aria.moreActions"],
                              className: "h-7 w-5 flex items-center justify-end",
                              onClick: () => C(!0),
                              children: (0, s.jsx)(p.A, {
                                icon: "ellipsis-vertical",
                                iconType: "solid",
                                className:
                                  "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                              }),
                            }),
                            (0, s.jsx)(f.TopbarDialog, {
                              topbarDialogOpen: w,
                              setTopbarDialogOpen: C,
                              children: (0, s.jsx)(v, {}),
                            }),
                          ],
                        }),
                      ],
                    }),
                  }),
                  (0, s.jsx)(o.i, { pageMetadata: a }),
                ],
              }),
            }),
            (0, s.jsx)(c.c, {}),
          ],
        });
      }
    },
    13380: (e, a, r) => {
      r.d(a, { SequoiaTopBar: () => V });
      var s = r(54568),
        t = r(43906),
        l = r.n(t),
        n = r(7620),
        i = r(8677),
        d = r(67908),
        c = r(12192),
        o = r(30793),
        g = r(68367),
        x = r(76829),
        m = r(24419),
        h = r(35878),
        y = r(40588),
        u = r(91263),
        p = r(32795),
        b = r(70656),
        f = r(68999),
        j = r(34766),
        v = r(8283),
        N = r(12158),
        k = r(26842),
        w = r(81325),
        C = r(70785),
        A = r(19664),
        E = r.n(A),
        T = r(22153),
        B = r(33052);
      let S =
          "flex items-center gap-2 whitespace-nowrap font-medium text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 px-2.5 h-12",
        I = () => {
          let { docsConfig: e } = (0, n.useContext)(o.DocsConfigContext),
            {
              userAuthLoginButton: a,
              authLoginButton: r,
              authLogoutButton: t,
              userAuthLogoutButton: l,
            } = (0, n.useContext)(g.F),
            i = (0, T.p)("docs.navitem.click"),
            d = (0, n.useCallback)((e, a) => i({ name: e, url: a }), [i]);
          return (0, s.jsxs)(s.Fragment, {
            children: [
              e?.navbar?.links?.map((e) => {
                let a = (0, C.v)(e.href),
                  { label: r } = e;
                return a
                  ? (0, s.jsx)(
                      "li",
                      {
                        className: (0, w.cn)(B.x.NavBarLink),
                        children: (0, s.jsxs)("a", {
                          href: e.href,
                          className: S,
                          onClick: () => d(r, e.href),
                          target: "_blank",
                          rel: "noopener noreferrer",
                          children: [
                            e.icon &&
                              (0, s.jsx)(f.ComponentIcon, {
                                icon: "string" == typeof e.icon ? e.icon : e.icon.name,
                                iconType:
                                  "string" == typeof e.icon ? "regular" : e.icon.style || "regular",
                                className: "h-4 w-4 bg-gray-600 dark:bg-gray-400",
                                overrideColor: !0,
                              }),
                            r,
                          ],
                        }),
                      },
                      r,
                    )
                  : (0, s.jsx)(
                      "li",
                      {
                        className: (0, w.cn)(B.x.NavBarLink),
                        children: (0, s.jsxs)(E(), {
                          href: e.href || "/",
                          className: S,
                          onClick: () => d(r, e.href),
                          children: [
                            e.icon &&
                              (0, s.jsx)(f.ComponentIcon, {
                                icon: "string" == typeof e.icon ? e.icon : e.icon.name,
                                iconType:
                                  "string" == typeof e.icon ? "regular" : e.icon.style || "regular",
                                className: "h-4 w-4 bg-gray-600 dark:bg-gray-400",
                                overrideColor: !0,
                              }),
                            r,
                          ],
                        }),
                      },
                      r,
                    );
              }),
              a && (0, s.jsx)("li", { className: "lg:hidden", children: a }, "login"),
              l &&
                (0, s.jsx)("li", { className: "lg:hidden", children: l }, "personalization-logout"),
              r && (0, s.jsx)("li", { className: "lg:hidden", children: r }, "partial-auth-login"),
              t && (0, s.jsx)("li", { className: "lg:hidden", children: t }, "auth-logout"),
            ],
          });
        };
      function V({ className: e, pageMetadata: a }) {
        let { banner: r } = (0, n.useContext)(c.y),
          { divisions: t } = (0, n.useContext)(x.NavigationContext),
          { docsConfig: C } = (0, n.useContext)(o.DocsConfigContext),
          {
            userAuthLoginButton: A,
            authLoginButton: E,
            authLogoutButton: T,
            userAuthLogoutButton: B,
          } = (0, n.useContext)(g.F),
          S = (0, x.n)(),
          { search: V, askAI: L } = S,
          [D, z] = (0, n.useState)(!1),
          M = !!r,
          O = t.tabs.length > 0,
          { searchPrompt: _, hasChatPermissions: q } = (0, n.useContext)(N.SearchContext),
          { onChatSheetToggle: P } = (0, n.useContext)(N.ChatAssistantContext),
          F = (0, m.t)(),
          U = A || E || T || B,
          H = C?.navbar?.primary;
        return (
          (0, n.useLayoutEffect)(() => {
            let e = document.getElementById(h.V.Navbar)?.offsetHeight ?? 0;
            document.documentElement.style.setProperty("--topbar-height", `${e}px`);
          }, [O, M]),
          (0, n.useEffect)(() => {
            (!O && M) || (O && !M)
              ? window.document.documentElement.classList.add("lg:[--scroll-mt:8.5rem]")
              : O && M && window.document.documentElement.classList.add("lg:[--scroll-mt:11rem]");
            let e = l()(() => {
              let e = document.getElementById(h.V.Navbar)?.offsetHeight ?? 0;
              document.documentElement.style.setProperty("--topbar-height", `${e}px`);
            }, 100);
            return (
              window.addEventListener("resize", e),
              () => {
                (e.cancel(), window.removeEventListener("resize", e));
              }
            );
          }, [O, M]),
          (0, s.jsxs)("div", {
            id: h.V.Navbar,
            className: (0, w.cn)(d.f.PrimaryNav, "fixed lg:sticky top-0 w-full", e),
            children: [
              (0, s.jsx)("div", {
                className:
                  "z-10 absolute w-full h-full border-b border-gray-100 dark:border-gray-800",
              }),
              (0, s.jsx)("div", {
                className: "z-0 absolute inset-0 bg-background-light dark:bg-background-dark",
              }),
              (0, s.jsx)(i.l, {}),
              (0, s.jsxs)("div", {
                className: "z-10 relative",
                children: [
                  (0, s.jsxs)("div", {
                    className: "hidden lg:flex items-center h-12 min-w-0 w-full px-6",
                    children: [
                      (0, s.jsxs)("div", {
                        className: "flex-1 flex items-center gap-6 h-full pr-2",
                        children: [
                          (0, s.jsx)(j.l, { linkClassName: "shrink-0", logoClassName: "h-[22px]" }),
                          (0, s.jsxs)("div", {
                            className: "flex items-center gap-3",
                            children: [
                              (0, s.jsx)(b.VersionSelect, {
                                triggerClassName:
                                  "text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-1.5",
                              }),
                              t.versions.length > 0 &&
                                t.languages.length > 0 &&
                                (0, s.jsx)("div", {
                                  className: "h-3 w-px bg-gray-200 dark:bg-gray-700",
                                }),
                              (0, s.jsx)(p.K2, {
                                triggerClassName:
                                  "text-sm font-medium text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 flex items-center gap-2",
                              }),
                            ],
                          }),
                        ],
                      }),
                      (0, s.jsxs)("div", {
                        className: "flex-1 flex items-center justify-center gap-2 px-2 min-w-0",
                        children: [
                          (0, s.jsx)(N.SearchButton, {
                            className:
                              "flex items-center w-64 min-w-0 shrink h-8 px-2 gap-1 bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-800",
                            id: h.V.SearchBarEntry,
                            children: ({ actionKey: e }) =>
                              (0, s.jsxs)(s.Fragment, {
                                children: [
                                  (0, s.jsx)(f.A, {
                                    icon: "magnifying-glass",
                                    iconType: "regular",
                                    className: "h-4 w-4 bg-gray-500 dark:bg-gray-400",
                                  }),
                                  (0, s.jsx)("span", {
                                    className:
                                      "flex-1 text-left text-sm text-gray-500 dark:text-gray-500 pl-1",
                                    children: _,
                                  }),
                                  e &&
                                    (0, s.jsxs)("span", {
                                      className:
                                        "px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-950 rounded",
                                      children: [e[0], "K"],
                                    }),
                                ],
                              }),
                          }),
                          q &&
                            (0, s.jsxs)("button", {
                              type: "button",
                              className:
                                "flex items-center h-8 px-2.5 gap-1.5 bg-gray-50 dark:bg-gray-900 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg border border-gray-100 dark:border-gray-800",
                              onClick: () => P({ entryPoint: "topbar" }),
                              id: h.V.AssistantEntry,
                              "aria-label": S["aria.toggleAssistantPanel"],
                              children: [
                                (0, s.jsx)("span", {
                                  className:
                                    "text-sm font-medium text-gray-600 dark:text-gray-400 whitespace-nowrap",
                                  children: L,
                                }),
                                (0, s.jsxs)("span", {
                                  className:
                                    "px-1.5 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-950 rounded",
                                  children: [F[0], "I"],
                                }),
                              ],
                            }),
                        ],
                      }),
                      (0, s.jsxs)("div", {
                        className: "flex-1 flex items-center gap-4 h-full justify-end",
                        children: [
                          (0, s.jsx)("nav", {
                            className: "text-sm",
                            children: (0, s.jsx)("ul", {
                              className: "flex gap-x-2 items-center",
                              children: (0, s.jsx)(I, {}),
                            }),
                          }),
                          H &&
                            "button" === H.type &&
                            H.href &&
                            H.label &&
                            (0, s.jsx)("a", {
                              href: H.href,
                              target: "_blank",
                              rel: "noopener noreferrer",
                              className:
                                "flex items-center px-3 py-1.5 text-sm font-medium text-white dark:text-black/75 bg-primary dark:bg-primary-light hover:opacity-90 rounded-lg shadow-sm whitespace-nowrap",
                              children: H.label,
                            }),
                          U &&
                            (0, s.jsxs)("div", {
                              className: "flex items-center gap-2",
                              children: [A, E, T, B],
                            }),
                          (0, s.jsx)("div", {
                            className: "-mr-4",
                            children: (0, s.jsx)(p.cI, {
                              sunIconClassName: "text-gray-500 group-hover:text-gray-700",
                              moonIconClassName: "text-gray-400 dark:group-hover:text-gray-200",
                              backgroundClassName: "w-8 h-8 rounded-lg",
                            }),
                          }),
                        ],
                      }),
                    ],
                  }),
                  O &&
                    (0, s.jsx)("div", {
                      className: "hidden lg:block bg-gray-50 dark:bg-gray-900",
                      children: (0, s.jsxs)("div", {
                        className: "flex items-center justify-between h-12 w-full px-6",
                        children: [
                          (0, s.jsx)(v.U, {
                            className: "h-12 text-sm font-medium text-gray-600 dark:text-gray-400",
                            activeClassName: "text-primary dark:text-primary-light",
                            align: "start",
                          }),
                          (0, s.jsx)(v.U, {
                            className: "h-12 text-sm font-medium text-gray-600 dark:text-gray-400",
                            activeClassName: "text-primary dark:text-primary-light",
                            align: "end",
                          }),
                        ],
                      }),
                    }),
                  (0, s.jsxs)("div", {
                    className: "flex lg:hidden items-center justify-between h-12 px-4",
                    children: [
                      (0, s.jsx)(j.l, { logoClassName: "h-[22px]" }),
                      (0, s.jsxs)("div", {
                        className: "flex items-center gap-3",
                        children: [
                          (0, s.jsxs)(N.SearchButton, {
                            className:
                              "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                            id: h.V.SearchBarEntryMobile,
                            children: [
                              (0, s.jsx)("span", { className: "sr-only", children: V }),
                              (0, s.jsx)(f.A, {
                                icon: "magnifying-glass",
                                iconType: "solid",
                                className:
                                  "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                              }),
                            ],
                          }),
                          (0, s.jsx)(k.A, {}),
                          (0, s.jsx)("button", {
                            "aria-label": S["aria.moreActions"],
                            className: "h-7 w-5 flex items-center justify-end",
                            onClick: () => z(!0),
                            children: (0, s.jsx)(f.A, {
                              icon: "ellipsis-vertical",
                              iconType: "solid",
                              className:
                                "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                            }),
                          }),
                          (0, s.jsx)(p.j1, {
                            topbarDialogOpen: D,
                            setTopbarDialogOpen: z,
                            children: (0, s.jsx)(I, {}),
                          }),
                        ],
                      }),
                    ],
                  }),
                  (0, s.jsx)("div", {
                    className: "lg:hidden bg-gray-50 dark:bg-gray-900",
                    children: (0, s.jsx)(u.i, { pageMetadata: a }),
                  }),
                ],
              }),
              (0, s.jsx)(y.c, {}),
            ],
          })
        );
      }
    },
    98849: (e, a, r) => {
      r.d(a, { AspenTopBar: () => N });
      var s = r(54568),
        t = r(7620),
        l = r(8677),
        n = r(67908),
        i = r(12192),
        d = r(76829),
        c = r(35878),
        o = r(33052),
        g = r(40588),
        x = r(91263),
        m = r(32795),
        h = r(34766),
        y = r(12158),
        u = r(26842),
        p = r(81325),
        b = r(68999),
        f = r(8283),
        j = r(30921);
      let v = () =>
        (0, s.jsx)(j.NavbarLinks, {
          actionClassName:
            "flex items-center gap-2 whitespace-nowrap font-medium text-gray-800 dark:text-gray-50 bg-gray-950/[0.03] dark:bg-white/[0.03] hover:bg-gray-950/10 dark:hover:bg-white/10 rounded-xl px-[14px] py-2",
        });
      function N({ className: e, pageMetadata: a }) {
        let { banner: r } = (0, t.useContext)(i.y),
          { divisions: j } = (0, t.useContext)(d.NavigationContext),
          N = (0, d.n)(),
          { search: k } = N,
          [w, C] = (0, t.useState)(!1),
          A = j.tabs.length > 0,
          E = !!r;
        return (
          (0, t.useEffect)(() => {
            (!A && E) || (A && !E)
              ? window.document.documentElement.classList.add("lg:[--scroll-mt:9.5rem]")
              : A && E && window.document.documentElement.classList.add("lg:[--scroll-mt:12rem]");
          }, [A, E]),
          (0, s.jsxs)("div", {
            id: c.V.Navbar,
            className: (0, p.cn)(n.f.PrimaryNav, "fixed lg:sticky top-0 w-full", e),
            children: [
              (0, s.jsx)("div", {
                className:
                  "z-10 absolute w-full h-full border-b border-gray-100 dark:border-gray-800",
              }),
              (0, s.jsx)("div", {
                className: "z-0 absolute inset-0 bg-background-light dark:bg-background-dark",
              }),
              (0, s.jsx)(l.l, {}),
              (0, s.jsxs)("div", {
                className: "z-10 mx-auto relative max-w-8xl px-0 lg:px-5",
                children: [
                  (0, s.jsxs)("div", {
                    className: "relative",
                    children: [
                      (0, s.jsx)("div", {
                        className: (0, p.cn)(
                          "flex items-center lg:px-4 h-14 min-w-0",
                          A ? "mx-4 lg:mx-0" : "px-4",
                        ),
                        children: (0, s.jsxs)("div", {
                          className: (0, p.cn)(
                            "h-full relative flex-1 flex items-center gap-x-4 min-w-0",
                            !A && "lg:border-none",
                          ),
                          children: [
                            (0, s.jsxs)("div", {
                              className: "flex-1 flex items-center gap-x-4",
                              children: [
                                (0, s.jsx)(h.l, { logoClassName: "h-6" }),
                                (0, s.jsx)(m.Xh, {}),
                                (0, s.jsx)(m.m4, { className: "max-lg:hidden" }),
                              ],
                            }),
                            (0, s.jsx)(y.DesktopSearchEntry, {
                              searchButtonClassName:
                                "max-w-sm bg-gray-950/[0.03] dark:bg-white/[0.03] hover:bg-gray-950/10 dark:hover:bg-white/10 rounded-full shadow-none border-none ring-0 dark:ring-0",
                              includeAskAiText: !0,
                            }),
                            (0, s.jsxs)("div", {
                              className: (0, p.cn)(
                                o.x.TopbarRightContainer,
                                "hidden lg:flex flex-1 items-center gap-2 ml-auto justify-end",
                              ),
                              children: [
                                (0, s.jsx)("div", {
                                  className: "flex relative items-center justify-end space-x-4",
                                  children: (0, s.jsx)("nav", {
                                    className: "text-sm",
                                    children: (0, s.jsx)("ul", {
                                      className: "flex gap-2 items-center",
                                      children: (0, s.jsx)(v, {}),
                                    }),
                                  }),
                                }),
                                (0, s.jsx)(m.cI, {
                                  sunIconClassName: "text-gray-600 group-hover:text-gray-800",
                                  moonIconClassName: "text-gray-300 dark:group-hover:text-gray-100",
                                  backgroundClassName:
                                    "w-[30px] h-[30px] rounded-full bg-gray-800/[0.04] dark:bg-white/10",
                                }),
                              ],
                            }),
                            (0, s.jsxs)("div", {
                              className: "flex lg:hidden items-center gap-3",
                              children: [
                                (0, s.jsxs)(y.SearchButton, {
                                  className:
                                    "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                                  id: c.V.SearchBarEntryMobile,
                                  children: [
                                    (0, s.jsx)("span", { className: "sr-only", children: k }),
                                    (0, s.jsx)(b.A, {
                                      icon: "magnifying-glass",
                                      iconType: "solid",
                                      className:
                                        "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                    }),
                                  ],
                                }),
                                (0, s.jsx)(u.A, {}),
                                (0, s.jsx)("button", {
                                  "aria-label": N["aria.moreActions"],
                                  className: "h-7 w-5 flex items-center justify-end",
                                  onClick: () => C(!0),
                                  children: (0, s.jsx)(b.A, {
                                    icon: "ellipsis-vertical",
                                    iconType: "solid",
                                    className:
                                      "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                  }),
                                }),
                                (0, s.jsx)(m.j1, {
                                  topbarDialogOpen: w,
                                  setTopbarDialogOpen: C,
                                  children: (0, s.jsx)(v, {}),
                                }),
                              ],
                            }),
                          ],
                        }),
                      }),
                      (0, s.jsx)(x.i, { pageMetadata: a }),
                    ],
                  }),
                  A &&
                    (0, s.jsx)("div", {
                      className: "hidden lg:flex px-4 h-10",
                      children: (0, s.jsx)(f.U, {
                        className: "text-gray-800 dark:text-gray-200",
                        activeClassName:
                          "text-primary dark:text-primary-light hover:text-primary dark:hover:text-primary-light",
                        underlineClassName: "h-px",
                      }),
                    }),
                ],
              }),
              (0, s.jsx)(g.c, {}),
            ],
          })
        );
      }
    },
  },
]);
