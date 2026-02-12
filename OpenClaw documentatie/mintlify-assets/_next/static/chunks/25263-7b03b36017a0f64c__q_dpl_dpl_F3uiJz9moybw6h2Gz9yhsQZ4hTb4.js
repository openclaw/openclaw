"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [25263],
  {
    61664: (e, a, s) => {
      s.d(a, { AlmondTopBar: () => L });
      var r = s(54568),
        l = s(7620),
        i = s(8677),
        n = s(67908),
        t = s(76829),
        c = s(35878),
        o = s(40588),
        d = s(91263),
        x = s(32795),
        g = s(34766),
        h = s(12158),
        m = s(26842),
        j = s(81325),
        f = s(68999),
        u = s(8283),
        b = s(70785),
        v = s(19664),
        p = s.n(v),
        y = s(30793),
        N = s(68367),
        k = s(22153),
        w = s(33052),
        C = s(50864),
        T = s(43119),
        A = s(49201),
        B = s(96116);
      let E =
          "flex items-center gap-1.5 whitespace-nowrap font-medium text-gray-600 hover:text-gray-900 dark:text-white/90 dark:hover:text-gray-300",
        z = ({ mobile: e = !1 }) => {
          let { docsConfig: a } = (0, l.useContext)(y.DocsConfigContext),
            s = (0, k.p)("docs.navitem.click"),
            {
              userAuthLoginButton: i,
              authLoginButton: n,
              authLogoutButton: t,
              userAuthLogoutButton: c,
            } = (0, l.useContext)(N.F),
            o = (0, l.useCallback)((e, a) => s({ name: e, url: a }), [s]);
          return (0, r.jsxs)(r.Fragment, {
            children: [
              a?.navbar?.links?.map((a) => {
                let s = (0, b.v)(a.href),
                  { label: l, type: i } = a;
                return "github" === i
                  ? (0, r.jsx)(
                      A.GitHubCta,
                      { href: a.href, label: l || "", actionClassName: E },
                      a.href,
                    )
                  : "discord" === i
                    ? (0, r.jsx)(
                        T.DiscordCta,
                        { href: a.href, label: l || "", actionClassName: E },
                        a.href,
                      )
                    : s
                      ? (0, r.jsx)(
                          "li",
                          {
                            className: (0, j.cn)(
                              w.x.NavBarLink,
                              !e &&
                                "border border-gray-400/20 dark:border-gray-600/30 bg-background-light dark:bg-white/5 dark:border-none dark:text-white/90 group group-hover:opacity-[0.9] rounded-lg px-2.5 py-1.5 relative inline-flex items-center text-sm font-semibold",
                            ),
                            children: (0, r.jsxs)("a", {
                              href: a.href,
                              className: E,
                              onClick: () => o(l, a.href),
                              target: "_blank",
                              children: [
                                a.icon &&
                                  (0, r.jsx)(f.ComponentIcon, {
                                    icon: "string" == typeof a.icon ? a.icon : a.icon.name,
                                    iconType:
                                      "string" == typeof a.icon
                                        ? "regular"
                                        : a.icon.style || "regular",
                                    className: "h-4 w-4",
                                  }),
                                l,
                              ],
                            }),
                          },
                          l,
                        )
                      : (0, r.jsx)(
                          "li",
                          {
                            className: (w.x.NavBarLink, "list-none"),
                            children: (0, r.jsxs)(p(), {
                              href: a.href || "/",
                              className: E,
                              onClick: () => o(l, a.href),
                              children: [
                                a.icon &&
                                  (0, r.jsx)(f.ComponentIcon, {
                                    icon: "string" == typeof a.icon ? a.icon : a.icon.name,
                                    iconType:
                                      "string" == typeof a.icon
                                        ? "regular"
                                        : a.icon.style || "regular",
                                    className: "h-4 w-4",
                                  }),
                                l,
                              ],
                            }),
                          },
                          l,
                        );
              }),
              i && (0, r.jsx)("li", { children: i }, "login"),
              c && (0, r.jsx)("li", { children: c }, "personalization-logout"),
              n && (0, r.jsx)("li", { children: n }, "partial-auth-login"),
              t && (0, r.jsx)("li", { children: t }, "auth-logout"),
              (0, r.jsx)(B.MobileTopBarCtaButton, { actionClassName: E }),
              (0, r.jsx)(C.j, {}),
            ],
          });
        };
      function L({ className: e, pageMetadata: a }) {
        let { divisions: s } = (0, l.useContext)(t.NavigationContext),
          b = (0, t.n)(),
          { search: v } = b,
          [p, y] = (0, l.useState)(!1),
          N = s.tabs.length > 0;
        return (0, r.jsxs)("div", {
          id: c.V.Navbar,
          className: (0, j.cn)(n.f.PrimaryNav, "fixed top-0", e),
          style: { width: "calc(100% - var(--assistant-sheet-width, 0px))" },
          children: [
            (0, r.jsx)("div", { className: "z-10 absolute w-full h-full" }),
            (0, r.jsx)("div", { className: "z-0 absolute inset-0" }),
            (0, r.jsx)(i.l, {}),
            (0, r.jsx)("div", {
              className: "z-10 mx-auto relative",
              children: (0, r.jsxs)("div", {
                className: "relative",
                children: [
                  (0, r.jsx)("div", {
                    className: (0, j.cn)(
                      "flex items-center lg:px-7 h-14 min-w-0",
                      N ? "mx-4 lg:mx-0" : "px-4",
                    ),
                    children: (0, r.jsxs)("div", {
                      className: (0, j.cn)(
                        "h-full relative flex-1 flex items-center gap-x-4 min-w-0 lg:border-none",
                      ),
                      children: [
                        (0, r.jsxs)("div", {
                          className: "flex-1 flex items-center gap-x-4",
                          children: [
                            (0, r.jsx)(g.l, { logoClassName: "h-6" }),
                            (0, r.jsx)(x.Xh, { showLocalization: !1 }),
                            (0, r.jsx)(x.m4, { className: "max-lg:hidden bg-transparent" }),
                          ],
                        }),
                        (0, r.jsxs)("div", {
                          className: "flex items-center gap-4",
                          children: [
                            (0, r.jsxs)("div", {
                              className:
                                "flex-1 relative hidden lg:flex items-center ml-auto ustify-end gap-x-6",
                              children: [
                                (0, r.jsx)("div", {
                                  className: "h-16 font-semibold",
                                  children: (0, r.jsx)(u.U, { underlineClassName: "hidden" }),
                                }),
                                (0, r.jsx)("nav", {
                                  className: "text-sm",
                                  children: (0, r.jsx)("ul", {
                                    className: "flex gap-x-2 items-center",
                                    children: (0, r.jsx)(z, {}),
                                  }),
                                }),
                              ],
                            }),
                            (0, r.jsxs)("div", {
                              className: "flex lg:hidden items-center gap-3",
                              children: [
                                (0, r.jsxs)(h.SearchButton, {
                                  className:
                                    "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                                  id: c.V.SearchBarEntryMobile,
                                  children: [
                                    (0, r.jsx)("span", { className: "sr-only", children: v }),
                                    (0, r.jsx)(f.A, {
                                      icon: "magnifying-glass",
                                      iconType: "solid",
                                      className:
                                        "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                    }),
                                  ],
                                }),
                                (0, r.jsx)(m.A, {}),
                                (0, r.jsx)("button", {
                                  "aria-label": b["aria.moreActions"],
                                  className: "h-7 w-5 flex items-center justify-end",
                                  onClick: () => y(!0),
                                  children: (0, r.jsx)(f.A, {
                                    icon: "ellipsis-vertical",
                                    iconType: "solid",
                                    className:
                                      "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                  }),
                                }),
                                (0, r.jsx)(x.j1, {
                                  topbarDialogOpen: p,
                                  setTopbarDialogOpen: y,
                                  children: (0, r.jsx)(z, { mobile: !0 }),
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  }),
                  (0, r.jsx)(d.i, { pageMetadata: a }),
                ],
              }),
            }),
            (0, r.jsx)(o.c, {}),
          ],
        });
      }
    },
    98046: (e, a, s) => {
      s.d(a, { PalmTopBar: () => y });
      var r = s(54568),
        l = s(7620),
        i = s(8677),
        n = s(67908),
        t = s(12192),
        c = s(76829),
        o = s(35878),
        d = s(40588),
        x = s(91263),
        g = s(32795),
        h = s(34766),
        m = s(12158),
        j = s(26842),
        f = s(81325),
        u = s(68999),
        b = s(8283),
        v = s(30921);
      let p = ({ showThemeToggle: e }) =>
        (0, r.jsx)(v.NavbarLinks, {
          actionClassName: v.DEFAULT_ACTION_CLASSNAME,
          showThemeToggle: e,
        });
      function y({ className: e, pageMetadata: a }) {
        let { banner: s } = (0, l.useContext)(t.y),
          { divisions: v } = (0, l.useContext)(c.NavigationContext),
          y = (0, c.n)(),
          { search: N } = y,
          [k, w] = (0, l.useState)(!1),
          C = v.tabs.length > 0,
          T = !!s;
        return (
          (0, l.useEffect)(() => {
            (!C && T) || (C && !T)
              ? window.document.documentElement.classList.add("lg:[--scroll-mt:9.5rem]")
              : C && T && window.document.documentElement.classList.add("lg:[--scroll-mt:12rem]");
          }, [C, T]),
          (0, r.jsxs)("div", {
            id: o.V.Navbar,
            className: (0, f.cn)(n.f.PrimaryNav, "fixed lg:sticky top-0 w-full", e),
            children: [
              (0, r.jsx)("div", {
                className: (0, f.cn)(
                  "z-10 absolute w-full h-full bg-gray-950/[0.03] dark:bg-white/[0.03] border-b border-gray-200 dark:border-gray-800",
                ),
              }),
              (0, r.jsx)("div", {
                className: "z-0 absolute inset-0 bg-background-light dark:bg-background-dark",
              }),
              (0, r.jsx)(i.l, {}),
              (0, r.jsxs)("div", {
                className: "z-10 mx-auto relative",
                children: [
                  (0, r.jsxs)("div", {
                    className: "relative",
                    children: [
                      (0, r.jsx)("div", {
                        className: (0, f.cn)(
                          "flex items-center lg:px-12 h-16 min-w-0",
                          C ? "mx-4 lg:mx-0" : "px-4",
                        ),
                        children: (0, r.jsxs)("div", {
                          className: (0, f.cn)(
                            "h-full relative flex-1 flex items-center gap-x-4 min-w-0",
                            !C && "lg:border-none",
                          ),
                          children: [
                            (0, r.jsxs)("div", {
                              className: "flex-1 flex items-center gap-x-4",
                              children: [
                                (0, r.jsx)(h.l, {}),
                                (0, r.jsx)(g.Xh, { showLocalization: !1 }),
                                (0, r.jsx)(g.m4, { className: "!bg-transparent max-lg:hidden" }),
                              ],
                            }),
                            (0, r.jsx)(m.DesktopSearchEntry, {
                              searchButtonClassName:
                                "rounded-lg hover:ring-1 hover:ring-gray-200 dark:hover:ring-gray-800 shadow-none",
                              includeAskAiText: !0,
                            }),
                            (0, r.jsx)("div", {
                              className:
                                "flex-1 relative hidden lg:flex items-center ml-auto justify-end space-x-4",
                              children: (0, r.jsx)("nav", {
                                className: "text-sm",
                                children: (0, r.jsx)("ul", {
                                  className: "flex space-x-6 items-center",
                                  children: (0, r.jsx)(p, {}),
                                }),
                              }),
                            }),
                            (0, r.jsxs)("div", {
                              className: "flex lg:hidden items-center gap-3",
                              children: [
                                (0, r.jsxs)(m.SearchButton, {
                                  className:
                                    "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                                  id: o.V.SearchBarEntryMobile,
                                  children: [
                                    (0, r.jsx)("span", { className: "sr-only", children: N }),
                                    (0, r.jsx)(u.A, {
                                      icon: "magnifying-glass",
                                      iconType: "solid",
                                      className:
                                        "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                    }),
                                  ],
                                }),
                                (0, r.jsx)(j.A, {}),
                                (0, r.jsx)("button", {
                                  "aria-label": y["aria.moreActions"],
                                  className: "h-7 w-5 flex items-center justify-end",
                                  onClick: () => w(!0),
                                  children: (0, r.jsx)(u.A, {
                                    icon: "ellipsis-vertical",
                                    iconType: "solid",
                                    className:
                                      "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                  }),
                                }),
                                (0, r.jsx)(g.j1, {
                                  topbarDialogOpen: k,
                                  setTopbarDialogOpen: w,
                                  children: (0, r.jsx)(p, { showThemeToggle: !1 }),
                                }),
                              ],
                            }),
                          ],
                        }),
                      }),
                      (0, r.jsx)(x.i, { pageMetadata: a }),
                    ],
                  }),
                  C &&
                    (0, r.jsx)("div", {
                      className: "hidden lg:flex px-12 h-12",
                      children: (0, r.jsx)(b.U, {}),
                    }),
                ],
              }),
              (0, r.jsx)(d.c, {}),
            ],
          })
        );
      }
    },
  },
]);
