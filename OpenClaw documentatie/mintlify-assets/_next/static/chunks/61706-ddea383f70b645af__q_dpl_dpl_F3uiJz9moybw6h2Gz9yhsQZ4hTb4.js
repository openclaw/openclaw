"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [61706],
  {
    4517: (e, t, r) => {
      r.d(t, { t: () => y });
      var n = r(70785),
        a = r(7620),
        i = r(30793),
        o = r(76829),
        s = r(98167),
        l = r(22153),
        c = r(27194),
        d = r(66740),
        u = r(73205),
        p = r(12158),
        g = r(57810);
      function x(e) {
        return void 0 !== e;
      }
      var m = r(18423),
        f = r(60996).Buffer;
      let h = () => {
        let e = s.c.BASE_PATH || "",
          t = window.location.href;
        if (t) {
          let r = new URL(t);
          return `${(0, m.f)(r.origin)}${e}/mcp`;
        }
        return `${e}/mcp`;
      };
      function y() {
        let { docsConfig: e } = (0, a.useContext)(i.DocsConfigContext),
          { hasChatPermissions: t } = (0, a.useContext)(p.SearchContext),
          { onChatSheetToggle: r } = (0, a.useContext)(p.ChatAssistantContext),
          m = (0, c.G)(),
          y = (0, l.p)("docs.context_menu.copy_page"),
          b = (0, l.p)("docs.context_menu.copy_mcp_link"),
          k = (0, l.p)("docs.context_menu.ai_provider_click"),
          w = (0, l.p)("docs.context_menu.install_mcp_server"),
          v = (0, l.p)("docs.context_menu.copy_add_mcp_command"),
          {
            copyPage: j,
            viewAsMarkdown: C,
            openInChatGPT: N,
            openInClaude: _,
            openInPerplexity: A,
            openInGrok: $,
            copyPageAsMarkdown: P,
            viewPageAsMarkdown: M,
            askQuestionsAboutPage: R,
            askAIAssistant: L,
            copyMCPServer: I,
            copyMCPServerDescription: D,
            copyAddMCPCommand: S,
            copyAddMCPCommandDescription: q,
            connectToCursor: E,
            installMCPServerOnCursor: U,
            connectToVSCode: T,
            installMCPServerOnVSCode: B,
          } = (0, o.n)(),
          F = (0, a.useCallback)(async () => {
            let e = await (0, d.wC)({ pathname: m });
            return (y({ path: m }).catch(console.error), e);
          }, [m, y]),
          H = (0, a.useCallback)(() => {
            let e = `${s.c.BASE_PATH}${m}.md`;
            window.open(e, "_blank");
          }, [m]),
          O = (0, a.useCallback)(
            async (e) => {
              let t = new URL(window.location.href);
              t.hash = "";
              let r = t.toString(),
                n = `Read from ${r}.md so I can ask questions about it.`;
              ("chatgpt" === e && (n = `Read from ${r} so I can ask questions about it.`),
                "chatgpt" === e
                  ? window.open(
                      `https://chat.openai.com/?hints=search&q=${encodeURIComponent(n)}`,
                      "_blank",
                    )
                  : "claude" === e
                    ? window.open(`https://claude.ai/new?q=${encodeURIComponent(n)}`, "_blank")
                    : "grok" === e
                      ? window.open(`https://grok.com/?q=${encodeURIComponent(n)}`, "_blank")
                      : window.open(
                          `https://www.perplexity.ai/search?q=${encodeURIComponent(n)}`,
                          "_blank",
                        ),
                k({ provider: e }).catch(console.error));
            },
            [k],
          ),
          V = (0, a.useCallback)(async () => {
            let e = h(),
              t = await (0, g.l)(e);
            return (b({ path: m }).catch(console.error), "success" === t);
          }, [m, b]),
          J = (0, a.useCallback)(async () => {
            let e = h(),
              t = `npx add-mcp ${e}`,
              r = await (0, g.l)(t);
            return (v({ path: m }).catch(console.error), "success" === r);
          }, [m, v]),
          G = (0, a.useCallback)(
            (t) => {
              let r = h(),
                n = {
                  name: (function (e, t) {
                    let r = e.replace(/\s+/g, " ").trim();
                    if (r.length <= 30) {
                      return r;
                    }
                    let n = r.slice(0, 31),
                      a = n.lastIndexOf(" ");
                    return -1 === a ? r.slice(0, t).trim() : n.slice(0, a).trim();
                  })(e?.name || "Documentation", 30),
                  url: r,
                },
                a = null;
              ((a =
                "cursor" === t
                  ? ((e) => {
                      try {
                        let t = JSON.stringify(e),
                          r = f.from(t, "utf8").toString("base64").replace(/\+/g, "%2B");
                        return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(e.name)}&config=${encodeURIComponent(r)}`;
                      } catch (e) {
                        return (console.error("Error generating Cursor deep link:", e), null);
                      }
                    })(n)
                  : `vscode:mcp/install?${encodeURIComponent(JSON.stringify(n))}`) &&
                window.open(a, "_blank"),
                w({ ide: t }).catch(console.error));
            },
            [e?.name, w],
          ),
          z = (0, a.useCallback)(
            async (e) => {
              if ("string" == typeof e.href) {
                window.open(e.href, "_blank");
              } else {
                let { base: t, query: r } = e.href,
                  n = new URL(t);
                if (r) {
                  for (let { key: e, value: t } of r) {
                    let r = t;
                    if (t.includes("$page")) {
                      let e = await (0, d.V)(m);
                      r = t.replace("$page", e.slice(0, 200));
                    }
                    (t.includes("$path") && (r = t.replace("$path", m)),
                      t.includes("$mcp") && (r = t.replace("$mcp", h())),
                      n.searchParams.set(e, r));
                  }
                }
                window.open(n.toString(), "_blank");
              }
            },
            [m],
          ),
          W = (0, a.useMemo)(
            () => [
              { id: "copy", title: j, description: P, icon: u.j, action: () => F() },
              {
                id: "assistant",
                title: L,
                description: R,
                icon: u.BZ,
                action: () => r({ entryPoint: "context-menu" }),
              },
              { id: "view", title: C, description: M, icon: u.Hb, action: H, externalLink: !0 },
              {
                id: "chatgpt",
                title: N,
                description: R,
                icon: u.pc,
                action: () => void O("chatgpt"),
                externalLink: !0,
              },
              {
                id: "claude",
                title: _,
                description: R,
                icon: u.w6,
                action: () => void O("claude"),
                externalLink: !0,
              },
              {
                id: "perplexity",
                title: A,
                description: R,
                icon: u.Mm,
                action: () => void O("perplexity"),
                externalLink: !0,
              },
              {
                id: "grok",
                title: $,
                description: R,
                icon: u.Ts,
                action: () => void O("grok"),
                externalLink: !0,
              },
              { id: "mcp", title: I, description: D, icon: u.hA, action: () => V() },
              { id: "add-mcp", title: S, description: q, icon: u.k3, action: () => J() },
              {
                id: "cursor",
                title: E,
                description: U,
                icon: u.oA,
                action: () => G("cursor"),
                externalLink: !0,
              },
              {
                id: "vscode",
                title: T,
                description: B,
                icon: u.WH,
                action: () => G("vscode"),
                externalLink: !0,
              },
            ],
            [L, R, r, j, P, F, C, M, H, N, O, _, A, $, I, D, V, S, q, J, E, U, G, T, B],
          );
        return {
          options: (0, a.useMemo)(() => {
            let r = e?.contextual?.options;
            return r
              ? Array.from(
                  new Set(
                    r
                      .map((e) =>
                        "string" == typeof e
                          ? W.find((t) => t.id === e)
                          : {
                              id: `custom-${e.title}`,
                              title: e.title,
                              description: e.description,
                              icon: e.icon,
                              action: () => void z(e),
                              externalLink:
                                "string" == typeof e.href
                                  ? (0, n.v)(e.href)
                                  : (0, n.v)(e.href.base),
                            },
                      )
                      .filter(x)
                      .filter((e) => "assistant" !== e.id || t),
                  ),
                )
              : [];
          }, [e?.contextual?.options, W, z, t]),
          display: e?.contextual?.display ?? "header",
        };
      }
    },
    26976: (e, t, r) => {
      r.d(t, { k: () => i });
      var n = r(7620),
        a = r(76829);
      function i({
        idleText: e,
        copyingText: t,
        copiedText: r,
        failedText: o,
        resetDelay: s = 2e3,
        timeout: l = 3e4,
      } = {}) {
        let [c, d] = (0, n.useState)("idle"),
          u = (0, a.n)(),
          p = (0, n.useRef)(0),
          g = e ?? u.copyPage,
          x = t ?? u.copying,
          m = r ?? u.copied,
          f = o ?? u.copyFailed;
        (0, n.useEffect)(() => {
          if ("copied" === c || "failed" === c) {
            let e = setTimeout(() => {
              d("idle");
            }, s);
            return () => clearTimeout(e);
          }
        }, [c, s]);
        let h = (0, n.useCallback)(
            async (e) => {
              d("copying");
              let t = ++p.current,
                r = new Promise((e) => {
                  setTimeout(() => e("timeout"), l);
                });
              try {
                let n = await Promise.race([
                  Promise.resolve(e()).then((e) => ({ type: "success", value: e })),
                  r.then(() => ({ type: "timeout" })),
                ]);
                if (p.current !== t) {
                  return;
                }
                if ("timeout" === n.type) {
                  (console.error("Copy action timed out"), d("failed"));
                  return;
                }
                let a = void 0 === n.value || n.value;
                d(a ? "copied" : "failed");
              } catch (e) {
                if (p.current !== t) {
                  return;
                }
                (console.error("Copy action failed:", e), d("failed"));
              }
            },
            [l],
          ),
          y = (0, n.useMemo)(() => {
            switch (c) {
              case "copying":
                return x;
              case "copied":
                return m;
              case "failed":
                return f;
              default:
                return g;
            }
          }, [c, g, x, m, f]);
        return { state: c, text: y, execute: h, isDisabled: "copying" === c };
      }
    },
    36602: (e, t, r) => {
      r.d(t, { c: () => o });
      var n = r(7620),
        a = r(30793),
        i = r(840);
      let o = () => {
        let { pageMetadata: e } = (0, n.useContext)(a.PageContext);
        return (0, n.useMemo)(() => (0, i.H)(e), [e]);
      };
    },
    61532: (e, t, r) => {
      r.d(t, { m: () => i });
      var n = r(54568),
        a = r(81325);
      function i({ className: e }) {
        return (0, n.jsx)("div", {
          className: (0, a.cn)(
            "w-[78px] h-[21px] bg-[#FDEAD8] dark:bg-[#613105] text-[#AE590A] dark:text-[#E9760C] font-medium text-xs leading-4 flex justify-center items-center p-1.5 rounded-md",
            e,
          ),
          children: "deprecated",
        });
      }
    },
    61706: (e, t, r) => {
      r.d(t, { z: () => F });
      var n = r(54568),
        a = r(92685),
        i = r(55575),
        o = r(7620),
        s = r(9601),
        l = r(30793),
        c = r(71252),
        d = r(17644),
        u = r(27194),
        p = r(28331),
        g = r(39282),
        x = r(36602),
        m = r(35878),
        f = r(14486),
        h = r(19664),
        y = r.n(h),
        b = r(33052),
        k = r(81325),
        w = r(53457),
        v = r(76075),
        j = r(98920),
        C = r(67793);
      let N = (e) => {
        let t = e[0];
        if (t) {
          return "string" == typeof t
            ? t
            : N("pages" in t && Array.isArray(t.pages) ? t.pages : []);
        }
      };
      function _(e, t) {
        if ("pages" in e && Array.isArray(e.pages)) {
          let r = "root" in e && "string" == typeof e.root ? e.root : void 0,
            n = { title: e.group, path: (0, w.Mi)(r ?? N(e.pages) ?? "") };
          if (r && (0, C.N)(r, t)) {
            return [n];
          }
          for (let r of e.pages) {
            if ((0, j.a)(r)) {
              let e = _(r, t);
              if (e.length > 0) return [n, ...e];
            } else if ((0, C.N)(r, t)) return [n];
          }
        }
        return [];
      }
      var A = r(87920);
      function $() {
        let e = (0, u.G)(),
          { docsConfig: t } = (0, o.useContext)(l.DocsConfigContext),
          r = (0, A.a)(e, t?.navigation),
          a = (function e(t, r) {
            if (!r) {
              return [];
            }
            if ("pages" in r) {
              for (let e of r.pages) {
                if ((0, j.a)(e)) {
                  let r = _(e, t);
                  if (r.length > 0) return r;
                }
              }
            }
            if ("groups" in r) {
              for (let e of r.groups) {
                let r = _(e, t);
                if (r.length > 0) return r;
              }
            }
            for (let n of v.J) {
              if (n in r)
                for (let a of r[n]) {
                  let r = e(t, a);
                  if (r.length > 0) return r;
                }
            }
            return [];
          })(e, t?.navigation);
        return (0, n.jsx)(n.Fragment, {
          children:
            t?.styling?.eyebrows === "breadcrumbs"
              ? (0, n.jsx)(P, { breadcrumbs: a })
              : r &&
                (0, n.jsx)("div", {
                  className: (0, k.cn)(
                    b.x.Eyebrow,
                    "h-5 text-primary dark:text-primary-light",
                    t?.theme === "sequoia" ? "text-xs font-medium" : "text-sm font-semibold",
                  ),
                  children: r,
                }),
        });
      }
      let P = ({ breadcrumbs: e }) =>
        0 === e.length
          ? null
          : (0, n.jsx)("div", {
              className: (0, k.cn)(b.x.BreadcrumbList, "flex flex-row items-center gap-1.5"),
              children: e.map((t, r) =>
                (0, n.jsxs)(
                  "div",
                  {
                    className: (0, k.cn)(
                      b.x.BreadcrumbItem,
                      "inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
                    ),
                    "data-breadcrumb-title": t.title,
                    children: [
                      (0, n.jsx)(y(), { href: t.path ?? "#", children: t.title }),
                      r < e.length - 1 &&
                        (0, n.jsx)(f.A, {
                          size: 12,
                          strokeWidth: 2.5,
                          className: "text-gray-400 dark:text-gray-500",
                        }),
                    ],
                  },
                  t.title,
                ),
              ),
            });
      var M = r(61532),
        R = r(34920),
        L = r(6472),
        I = r(76829),
        D = r(4517),
        S = r(26976),
        q = r(68999),
        E = r(73205);
      let U = "regular",
        T = ({ className: e }) => {
          let { pageMetadata: t } = (0, o.useContext)(l.PageContext),
            r = !0 === t.rss,
            a = (0, I.n)(),
            { options: i, display: s } = (0, D.t)(),
            [c, d] = (0, o.useState)(!1),
            { state: u, text: p, execute: g, isDisabled: x } = (0, S.k)(),
            f = (0, o.useCallback)(
              (e, t) => async () => {
                (d(!1), "copy" === e ? await g(t) : t());
              },
              [g],
            ),
            h = (0, o.useMemo)(() => i.map((e) => ({ ...e, action: f(e.id, e.action) })), [i, f]),
            y = () => {
              let e = window.location.origin + window.location.pathname;
              window.open(`${e}/rss.xml`, "_blank");
            },
            b = ({ icon: e }) =>
              "function" == typeof e
                ? (0, n.jsx)(e, { className: "w-4 h-4 shrink-0" })
                : (0, n.jsx)(q.ComponentIcon, {
                    icon: "string" == typeof e ? e : (e?.name ?? "info"),
                    iconType: "string" == typeof e ? U : e?.style || U,
                    className: "h-4 w-4 bg-gray-700 dark:bg-gray-300",
                    overrideColor: !0,
                  });
          if ("toc" === s) {
            return r
              ? (0, n.jsx)("div", {
                  id: m.V.PageContextMenu,
                  className: (0, k.cn)("flex items-center shrink-0", e),
                  children: (0, n.jsx)("button", {
                    className:
                      "flex items-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-white/[0.07] bg-background-light dark:bg-background-dark rounded-xl p-2 hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                    onClick: y,
                    "data-testid": "rss-feed-button",
                    "aria-label": a["aria.openRssFeed"],
                    children: (0, n.jsx)(E.wi, { className: "w-4 h-4" }),
                  }),
                })
              : null;
          }
          if (!h.length && !r) {
            return null;
          }
          let w = h[0];
          return (0, n.jsxs)("div", {
            id: m.V.PageContextMenu,
            className: (0, k.cn)(
              "flex items-center shrink-0",
              w?.id === "copy" && "min-w-[156px]",
              e,
            ),
            children: [
              w &&
                (0, n.jsx)("button", {
                  id: m.V.PageContextMenuButton,
                  className: (0, k.cn)(
                    "rounded-l-xl px-3 text-gray-700 dark:text-gray-300 py-1.5 border border-gray-200 dark:border-white/[0.07] bg-background-light dark:bg-background-dark hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                    1 === h.length ? "rounded-xl" : "border-r-0",
                    "idle" !== u && "text-gray-600 dark:text-gray-400",
                  ),
                  onClick: () => {
                    w.action();
                  },
                  disabled: x,
                  "aria-label": w.title,
                  children: (0, n.jsx)("div", {
                    className: "flex items-center gap-2 text-sm text-center font-medium",
                    children:
                      "copy" === w.id
                        ? (0, n.jsxs)(n.Fragment, {
                            children: [
                              (0, n.jsx)(E.j, { className: "w-4 h-4" }),
                              (0, n.jsx)("span", { children: p }),
                            ],
                          })
                        : (0, n.jsxs)(n.Fragment, {
                            children: [
                              (0, n.jsx)(b, { icon: w.icon }),
                              (0, n.jsx)("span", { children: w.title }),
                            ],
                          }),
                  }),
                }),
              h.length > 1 &&
                (0, n.jsxs)(L.DropdownMenu, {
                  open: c,
                  onOpenChange: d,
                  children: [
                    (0, n.jsx)(L.DropdownMenuTrigger, {
                      asChild: !0,
                      className: "rounded-none",
                      children: (0, n.jsx)("button", {
                        className:
                          "rounded-r-xl border px-3 border-gray-200 aspect-square dark:border-white/[0.07] bg-background-light dark:bg-background-dark hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                        "aria-label": a["aria.moreActions"],
                        children: (0, n.jsx)(E.DropdownArrowIcon, {
                          className: (0, k.cn)("rotate-90", c && "rotate-[270deg]"),
                        }),
                      }),
                    }),
                    (0, n.jsx)(L.DropdownMenuContent, {
                      side: "bottom",
                      align: "end",
                      className:
                        "inline-flex max-h-[420px] p-1 border border-gray-200 dark:border-white/[0.07] flex-col",
                      children: h.map((e, t) =>
                        (0, n.jsxs)(
                          L._,
                          {
                            onClick: e.action,
                            className:
                              "flex items-center justify-normal px-1.5 py-1.5 gap-1 hover:bg-gray-600/5 dark:hover:bg-gray-200/5 cursor-pointer rounded-lg",
                            children: [
                              (0, n.jsx)("div", {
                                className:
                                  "border border-gray-200 dark:border-white/[0.07] rounded-lg p-1.5",
                                children: (0, n.jsx)(b, { icon: e.icon }),
                              }),
                              (0, n.jsxs)("div", {
                                className: "flex flex-col px-1",
                                children: [
                                  (0, n.jsxs)("div", {
                                    className:
                                      "text-sm font-medium text-gray-800 dark:text-gray-300 flex items-center gap-1",
                                    children: [
                                      e.title,
                                      e.externalLink &&
                                        (0, n.jsx)(R.A, {
                                          className:
                                            "w-3 h-3 text-gray-600 dark:text-gray-400 shrink-0",
                                        }),
                                    ],
                                  }),
                                  (0, n.jsx)("div", {
                                    className: "text-xs text-gray-600 dark:text-gray-400",
                                    children: e.description,
                                  }),
                                ],
                              }),
                            ],
                          },
                          e.id + t,
                        ),
                      ),
                    }),
                  ],
                }),
              r &&
                (0, n.jsx)("button", {
                  className:
                    "flex items-center text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-white/[0.07] bg-background-light dark:bg-background-dark rounded-xl p-2 ml-2 hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                  onClick: y,
                  "data-testid": "rss-feed-button",
                  "aria-label": a["aria.openRssFeed"],
                  children: (0, n.jsx)(E.wi, { className: "w-4 h-4" }),
                }),
            ],
          });
        };
      function B() {
        return (0, n.jsxs)("header", {
          className: "relative",
          children: [
            (0, n.jsx)("div", {
              className: "mt-0.5",
              children: (0, n.jsx)("div", {
                className: "animate-pulse",
                children: (0, n.jsx)("div", {
                  className: "h-9 bg-gray-200 dark:bg-gray-700 rounded w-2/3",
                }),
              }),
            }),
            (0, n.jsxs)("div", {
              className: "mt-2 animate-pulse space-y-2",
              children: [
                (0, n.jsx)("div", { className: "h-5 bg-gray-200 dark:bg-gray-700 rounded w-full" }),
                (0, n.jsx)("div", { className: "h-5 bg-gray-200 dark:bg-gray-700 rounded w-4/5" }),
              ],
            }),
          ],
        });
      }
      function F() {
        let { description: e, pageType: t } = (0, o.useContext)(l.PageContext),
          { docsConfig: r } = (0, o.useContext)(l.DocsConfigContext),
          { isLivePreview: f, isPathLoading: h } = (0, o.useContext)(c.K),
          [{ pageMetadata: y }] = (0, g.O)(),
          b = (0, u.G)(),
          w = (0, p.Zk)(),
          { isCustom: v, isFrame: j } = (0, x.c)();
        if (f && b && h(b)) {
          return (0, n.jsx)(B, {});
        }
        let C = y.title || (0, a.r)(b),
          N = (f && y.description) || e,
          _ = "pdf" === t;
        if ((!C && !N) || v || j) {
          return null;
        }
        let A = !C.trim().includes(" ");
        return (0, n.jsxs)("header", {
          id: _ ? b.replace(/[/\\:*?"<>|]/g, "-") : m.V.Header,
          className: "relative leading-none",
          children: [
            (0, n.jsxs)("div", {
              className: (0, k.cn)("mt-0.5", r?.theme === "sequoia" ? "space-y-1" : "space-y-2.5"),
              children: [
                (0, n.jsx)($, {}),
                (0, n.jsxs)("div", {
                  className:
                    "flex flex-col sm:flex-row items-start sm:items-center relative gap-2 min-w-0",
                  children: [
                    (0, n.jsx)("h1", {
                      id: m.V.PageTitle,
                      className: (0, k.cn)(
                        "text-2xl sm:text-3xl text-gray-900 tracking-tight dark:text-gray-200 [overflow-wrap:anywhere]",
                        r?.theme === "sequoia" ? "font-medium" : "font-bold",
                        A && "break-all",
                        (0, d.H)(r?.theme).title,
                      ),
                      children: C,
                    }),
                    w?.deprecated && (0, n.jsx)(M.m, {}),
                    !_ && (0, n.jsx)(T, { className: "justify-end ml-auto sm:flex hidden" }),
                  ],
                }),
              ],
            }),
            (0, n.jsx)(
              () =>
                "string" == typeof N
                  ? (0, n.jsx)("div", {
                      className:
                        "mt-2 text-lg prose prose-gray dark:prose-invert [overflow-wrap:anywhere]",
                      children: N,
                    })
                  : N
                    ? (0, n.jsx)("div", {
                        className:
                          "mt-2 text-lg prose prose-gray dark:prose-invert [&>*]:[overflow-wrap:anywhere]",
                        children: (0, n.jsx)(i.L, { components: s.A, ...N }),
                      })
                    : null,
              {},
            ),
            !_ && (0, n.jsx)(T, { className: "mt-3 sm:hidden" }),
          ],
        });
      }
    },
    87920: (e, t, r) => {
      r.d(t, {
        a: () =>
          function e(t, r) {
            if (!r) {
              return "";
            }
            if ("pages" in r) {
              for (let e of r.pages) {
                if ((0, a.a)(e)) {
                  let r = o(e, t);
                  if (r) return r;
                }
              }
            }
            if ("groups" in r) {
              for (let e of r.groups) {
                let r = o(e, t);
                if (r) return r;
              }
            }
            for (let a of n.J) {
              if (a in r)
                for (let n of r[a]) {
                  let r = e(t, n);
                  if (r) return r;
                }
            }
            return "";
          },
      });
      var n = r(76075),
        a = r(98920),
        i = r(67793);
      function o(e, t) {
        if ("pages" in e && Array.isArray(e.pages)) {
          if ("root" in e && "string" == typeof e.root && (0, i.N)(e.root, t)) {
            return e.group;
          }
          for (let r of e.pages) {
            if ((0, a.a)(r)) {
              let e = o(r, t);
              if (e) return e;
            } else if ((0, i.N)(r, t)) return e.group;
          }
        }
        return "";
      }
    },
    98920: (e, t, r) => {
      r.d(t, { a: () => n });
      function n(e) {
        return !!(e && e.hasOwnProperty("group") && e.hasOwnProperty("pages"));
      }
    },
  },
]);
