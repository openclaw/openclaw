"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [86707],
  {
    2492: (e, t, r) => {
      r.d(t, { X: () => o });
      var a = r(54568),
        n = r(95159),
        s = r(70656);
      function o({ triggerClassName: e, showLocalization: t = !0 }) {
        return (0, a.jsxs)("div", {
          className: "hidden lg:flex items-center gap-x-2",
          children: [
            (0, a.jsx)(s.VersionSelect, { triggerClassName: e }),
            t && (0, a.jsx)(n.LocalizationSelect, { triggerClassName: e }),
          ],
        });
      }
    },
    8283: (e, t, r) => {
      r.d(t, { U: () => f });
      var a = r(54568),
        n = r(7620),
        s = r(76829),
        o = r(33052),
        i = r(81325),
        l = r(79634),
        d = r(68999),
        c = r(70785),
        g = r(45835),
        x = r(34920),
        u = r(6472),
        m = r(73205);
      let h = ({
        tab: e,
        className: t,
        activeClassName: r,
        underlineClassName: s,
        isNotFoundPage: h,
      }) => {
        let [p, f] = (0, n.useState)(!1),
          y = (0, n.useRef)(null),
          b = e.menu ?? [];
        (0, n.useEffect)(
          () => () => {
            y.current && clearTimeout(y.current);
          },
          [],
        );
        let v = () => {
            (y.current && (clearTimeout(y.current), (y.current = null)), f(!0));
          },
          k = () => {
            y.current = setTimeout(() => {
              (f(!1), (y.current = null));
            }, 100);
          };
        return (0, a.jsxs)(u.DropdownMenu, {
          open: p,
          onOpenChange: f,
          children: [
            (0, a.jsxs)(g.ty, {
              className: (0, i.cn)(
                o.x.TabsBarItem,
                "group relative h-full gap-2 flex items-center focus:outline-0",
                t,
                e.isActive && (0, i.cn)("text-gray-800 dark:text-gray-200 font-semibold", r),
              ),
              onMouseEnter: v,
              onMouseLeave: k,
              children: [
                (0, a.jsxs)("div", {
                  className: (0, i.cn)(
                    "flex items-center gap-2 font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-300",
                    e.isActive && "text-gray-800 dark:text-gray-200 font-semibold",
                    p && "text-gray-800 dark:text-gray-300",
                  ),
                  children: [
                    e.icon &&
                      (0, a.jsx)(d.ComponentIcon, {
                        icon: "string" == typeof e.icon ? e.icon : e.icon.name,
                        iconType: "string" == typeof e.icon ? "regular" : e.icon.style,
                        className: (0, i.cn)(
                          "h-4 w-4",
                          e.isActive || p
                            ? "bg-gray-800 dark:bg-gray-300"
                            : "bg-gray-600 dark:bg-gray-400",
                        ),
                        overrideColor: !0,
                      }),
                    e.name,
                    (0, a.jsx)(m.DropdownArrowIcon, {
                      className: (0, i.cn)(
                        "text-gray-400 dark:text-gray-600 group-hover:text-gray-600 dark:group-hover:text-gray-400 rotate-90",
                        p && "rotate-[270deg]",
                      ),
                    }),
                  ],
                }),
                (0, a.jsx)("div", {
                  className: (0, i.cn)(
                    "absolute bottom-0 h-[1.5px] w-full",
                    !h && e.isActive
                      ? "bg-primary dark:bg-primary-light"
                      : "group-hover:bg-gray-200 dark:group-hover:bg-gray-700",
                    s,
                  ),
                }),
              ],
            }),
            (0, a.jsx)(u.DropdownMenuContent, {
              align: "start",
              side: "bottom",
              sideOffset: -4,
              alignOffset: -4,
              onMouseEnter: v,
              onMouseLeave: k,
              className:
                "p-1 border border-gray-200 dark:border-white/[0.07] w-56 !animate-none !transition-none !transform-none !opacity-100 data-[state=open]:!animate-none data-[state=closed]:!animate-none data-[state=open]:!fade-in-0 data-[state=closed]:!fade-out-0 data-[state=open]:!zoom-in-100 data-[state=closed]:!zoom-out-100 data-[side=bottom]:!slide-in-from-top-0 data-[side=left]:!slide-in-from-right-0 data-[side=right]:!slide-in-from-left-0 data-[side=top]:!slide-in-from-bottom-0",
              children: b.map((e, t) =>
                (0, a.jsxs)(
                  l.DynamicLink,
                  {
                    href: e.href,
                    className: (0, i.cn)(
                      o.x.DropdownItem,
                      "rounded-xl text-gray-600 hover:text-gray-800 px-2.5 py-2 dark:text-gray-400 dark:hover:text-gray-300 flex group items-center gap-2 hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                    ),
                    onClick: () => f(!1),
                    children: [
                      e.icon &&
                        (0, a.jsx)(d.ComponentIcon, {
                          icon: "string" == typeof e.icon ? e.icon : e.icon.name,
                          iconType:
                            "string" == typeof e.icon ? "regular" : e.icon.style || "regular",
                          className: (0, i.cn)(
                            "h-4 w-4 shrink-0",
                            e.isActive
                              ? "bg-primary dark:bg-primary-light"
                              : "bg-gray-600 dark:bg-gray-400",
                          ),
                          overrideColor: !0,
                        }),
                      (0, a.jsxs)("div", {
                        className: "flex flex-col min-w-0 grow",
                        children: [
                          (0, a.jsx)("span", {
                            className: (0, i.cn)(
                              "text-sm font-medium",
                              e.isActive && "text-primary dark:text-primary-light font-semibold",
                            ),
                            children: e.item,
                          }),
                          e.description &&
                            (0, a.jsx)("span", {
                              className: "text-xs text-gray-600 dark:text-gray-400",
                              children: e.description,
                            }),
                        ],
                      }),
                      (0, c.v)(e.href) &&
                        (0, a.jsx)(x.A, {
                          className:
                            "w-3.5 h-3.5 text-gray-600 dark:text-gray-400 shrink-0 opacity-0 group-hover:opacity-100",
                        }),
                    ],
                  },
                  e.href + t,
                ),
              ),
            }),
          ],
        });
      };
      function p(e) {
        let {
          tab: t,
          underlineClassName: r,
          className: n,
          activeClassName: s,
          isNotFoundPage: c,
        } = e;
        return t.menu && t.menu.length
          ? (0, a.jsx)(h, { ...e })
          : (0, a.jsxs)(l.DynamicLink, {
              className: (0, i.cn)(
                o.x.TabsBarItem,
                "group relative h-full gap-2 flex items-center font-medium text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-300",
                n,
                t.isActive &&
                  (0, i.cn)(
                    "text-gray-800 dark:text-gray-200 [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor]",
                    s,
                  ),
              ),
              href: t.href,
              children: [
                t.icon &&
                  (0, a.jsx)(d.ComponentIcon, {
                    icon: "string" == typeof t.icon ? t.icon : t.icon.name,
                    iconType: "string" == typeof t.icon ? "regular" : t.icon.style,
                    className: "h-4 w-4 bg-current",
                    overrideColor: !0,
                  }),
                t.name,
                (0, a.jsx)("div", {
                  className: (0, i.cn)(
                    "absolute bottom-0 h-[1.5px] w-full left-0",
                    !c && t.isActive
                      ? "bg-primary dark:bg-primary-light"
                      : "group-hover:bg-gray-200 dark:group-hover:bg-gray-700",
                    r,
                  ),
                }),
              ],
            });
      }
      function f({ className: e, activeClassName: t, underlineClassName: r, align: l }) {
        let { divisions: d } = (0, n.useContext)(s.NavigationContext),
          c = (() => {
            let [e, t] = (0, n.useState)(!1);
            return (
              (0, n.useEffect)(() => {
                let e = () =>
                  "undefined" != typeof document &&
                  null !== document.querySelector(`.${o.x.NotFoundContainer}`);
                t(e());
                let r = new MutationObserver(() => {
                  t(e());
                });
                return (
                  r.observe(document.body, { childList: !0, subtree: !0 }), () => r.disconnect()
                );
              }, []),
              e
            );
          })(),
          g = (0, n.useMemo)(
            () =>
              "end" === l
                ? d.tabs.filter((e) => "end" === e.align)
                : "start" === l
                  ? d.tabs.filter((e) => !e.align || "start" === e.align)
                  : d.tabs,
            [d.tabs, l],
          );
        return 0 === g.length
          ? null
          : (0, a.jsx)("div", {
              className: (0, i.cn)(o.x.TabsBar, "h-full flex text-sm gap-x-6"),
              children: g.map((n) =>
                (0, a.jsx)(
                  p,
                  {
                    tab: n,
                    className: e,
                    activeClassName: t,
                    underlineClassName: r,
                    isNotFoundPage: c,
                  },
                  n.name,
                ),
              ),
            });
      }
    },
    8677: (e, t, r) => {
      r.d(t, { l: () => x });
      var a = r(54568),
        n = r(12598),
        s = r(7620),
        o = r(84487),
        i = r(67908),
        l = r(12192),
        d = r(76829),
        c = r(35878),
        g = r(81325);
      let x = () => {
        let { banner: e, dismissBanner: t } = (0, s.useContext)(l.y),
          r = (0, d.n)();
        return e?.content
          ? (0, a.jsxs)("div", {
              id: c.V.Banner,
              className: (0, g.cn)(
                "px-2 w-full text-white/90 dark:text-white/90 [&_*]:!text-white/90 dark:[&_*]:!text-white/90 [&_a:hover]:decoration-primary-light max-h-16 md:h-10 relative text-center flex items-center justify-center text-sm [&_a]:border-none [&_a]:underline-offset-[3px] line-clamp-2 md:truncate md:[&>*]:truncate bg-primary-dark font-medium",
                i.f.Banner,
              ),
              children: [
                (0, a.jsx)(o.jH, {
                  mode: "static",
                  className: "my-2 md:[&>p]:m-0",
                  rehypePlugins: [
                    ...(o.XX.raw ? [o.XX.raw] : []),
                    ...(o.XX.katex ? [o.XX.katex] : []),
                  ],
                  children: e.content,
                }),
                t &&
                  (0, a.jsx)("button", {
                    className:
                      "absolute right-4 top-1/2 -translate-y-1/2 text-zinc-100 hover:backdrop-blue-sm",
                    onClick: () => {
                      t();
                    },
                    "aria-label": r["aria.dismissBanner"],
                    children: (0, a.jsx)(n.A, { className: "size-4", "aria-hidden": "true" }),
                  }),
              ],
            })
          : null;
      };
    },
    11383: (e, t, r) => {
      r.d(t, { ContentStack: () => $ });
      var a = r(54568),
        n = r(16974),
        s = r(52094),
        o = r(178),
        i = r(66438),
        l = r(7620),
        d = r(30793),
        c = r(81325);
      function g({ pageMetadata: e, className: t }) {
        let { lastModified: r } = (0, l.useContext)(d.PageContext),
          { docsConfig: n } = (0, l.useContext)(d.DocsConfigContext),
          s = n?.metadata?.timestamp === !0;
        if (!(e.timestamp ?? s) || !r) {
          return null;
        }
        let o = new Date(r).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
        return (0, a.jsxs)("div", {
          className: (0, c.cn)("pt-4 pb-16 text-sm text-gray-500 dark:text-gray-400", t),
          children: ["Last modified on ", o],
        });
      }
      var x = r(66818),
        u = r(61706),
        m = r(23752),
        h = r(76829),
        p = r(98167),
        f = r(27194),
        y = r(36602),
        b = r(33052),
        v = r(44564),
        k = r(80841),
        j = r(64286),
        w = r(35878);
      let C = new j.d();
      function N({
        feedbackType: e,
        selectedOption: t,
        setSelectedOption: r,
        additionalFeedback: n,
        setAdditionalFeedback: s,
        email: o,
        setEmail: i,
        showThankYouMessage: d,
        config: g,
        onSubmit: x,
        onCancelDetailedFeedback: u,
      }) {
        let m = (0, h.n)(),
          p = [
            { id: "worked-as-expected", label: m["feedback.positive.workedAsExpected"] },
            { id: "easy-to-find", label: m["feedback.positive.easyToFind"] },
            { id: "easy-to-understand", label: m["feedback.positive.easyToUnderstand"] },
            { id: "up-to-date", label: m["feedback.positive.upToDate"] },
            { id: "something-else-positive", label: m["feedback.positive.somethingElse"] },
          ],
          f = [
            { id: "get-started-faster", label: m["feedback.negative.getStartedFaster"] },
            { id: "easier-to-find", label: m["feedback.negative.easierToFind"] },
            { id: "easier-to-understand", label: m["feedback.negative.easierToUnderstand"] },
            { id: "update-docs", label: m["feedback.negative.updateDocs"] },
            { id: "something-else-negative", label: m["feedback.negative.somethingElse"] },
          ],
          y = "Yes" === e ? m["feedback.greatWhatWorkedBest"] : m["feedback.howCanWeImprove"],
          v = (0, l.useMemo)(() => !!(n.trim() && C.isProfane(n)), [n]),
          k = (0, l.useMemo)(() => {
            let e = o.trim();
            return !!(e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
          }, [o]),
          j = (0, l.useCallback)(
            async (e) => {
              e.preventDefault();
              let r = g?.textInputOnly === !0;
              (r ? !n.trim() || v || k : !t || v || k) ||
                (await x({
                  optionId: r ? "" : t,
                  additionalFeedback: n.trim() || void 0,
                  email: o.trim() || void 0,
                }));
            },
            [n, x, t, v, k, o, g?.textInputOnly],
          );
        return d
          ? (0, a.jsx)("div", {
              className: (0, c.cn)(
                "pt-6 pb-4 border-t border-gray-200 dark:border-gray-700",
                b.x.ContextualFeedbackContainer,
              ),
              children: (0, a.jsx)("p", {
                className: (0, c.cn)(
                  "text-base font-medium text-gray-900 dark:text-gray-100 h-16",
                  b.x.ContextualFeedbackFormTitle,
                ),
                children: "Thank you!",
              }),
            })
          : (0, a.jsx)("div", {
              className: (0, c.cn)(
                "pt-6 pb-4 border-t border-gray-200 dark:border-gray-700",
                b.x.ContextualFeedbackContainer,
              ),
              children: (0, a.jsxs)("form", {
                id: w.V.FeedbackForm,
                onSubmit: j,
                className: (0, c.cn)("flex flex-col gap-y-6", b.x.ContextualFeedbackForm),
                children: [
                  (0, a.jsx)("h3", {
                    className: (0, c.cn)(
                      "text-base font-medium text-gray-900 dark:text-gray-100",
                      b.x.ContextualFeedbackFormTitle,
                    ),
                    children: y,
                  }),
                  !g?.textInputOnly &&
                    (0, a.jsx)("div", {
                      className: "flex flex-col gap-y-3",
                      children: ("Yes" === e ? p : f).map((e) =>
                        (0, a.jsx)(
                          l.Fragment,
                          {
                            children: (0, a.jsxs)("label", {
                              className: "flex items-start cursor-pointer pl-0.5",
                              children: [
                                (0, a.jsxs)("div", {
                                  className: "relative",
                                  children: [
                                    (0, a.jsx)("input", {
                                      type: "radio",
                                      name: "feedback-option",
                                      value: e.id,
                                      checked: t === e.id,
                                      onChange: (e) => r(e.target.value),
                                      className: (0, c.cn)("sr-only"),
                                    }),
                                    (0, a.jsx)("div", {
                                      className: (0, c.cn)(
                                        "h-4 w-4 rounded-full border border-primary-dark dark:border-primary-light",
                                        t === e.id
                                          ? "bg-primary-dark dark:bg-primary-light ring-1 ring-primary-dark dark:ring-primary-light border-white dark:border-background-dark border-2"
                                          : "border-gray-400 dark:border-gray-600",
                                      ),
                                      children:
                                        t === e.id &&
                                        (0, a.jsx)("div", {
                                          className: (0, c.cn)(
                                            "h-2 w-2 rounded-full bg-primary-dark dark:bg-primary-light absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
                                          ),
                                        }),
                                    }),
                                  ],
                                }),
                                (0, a.jsx)("span", {
                                  className: (0, c.cn)(
                                    "ml-3 text-sm leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
                                    t === e.id && "text-gray-800 dark:text-gray-200",
                                  ),
                                  children: e.label,
                                }),
                              ],
                            }),
                          },
                          e.id,
                        ),
                      ),
                    }),
                  (t || g?.textInputOnly) &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        (0, a.jsx)("input", {
                          id: w.V.FeedbackFormInput,
                          value: n,
                          onChange: (e) => s(e.target.value),
                          placeholder: g?.textInputOnly
                            ? m["feedback.placeholder"].replace(/^[(（].*?[)）]\s*/, "")
                            : m["feedback.placeholder"],
                          "aria-label": m["aria.additionalFeedback"],
                          className: (0, c.cn)(
                            "w-full px-4 py-2.5 border border-gray-200 dark:border-gray-800 rounded-xl text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-600/70 dark:placeholder:text-gray-400/70 bg-black/0 focus:ring-0 focus:outline-0 focus:border-gray-300 dark:focus:border-gray-700",
                            b.x.ContextualFeedbackFormInput,
                          ),
                        }),
                        (0, a.jsxs)("div", {
                          className: "flex flex-col gap-y-1",
                          children: [
                            (0, a.jsx)("input", {
                              type: "email",
                              value: o,
                              onChange: (e) => i(e.target.value),
                              placeholder: m["feedback.emailPlaceholder"],
                              "aria-label": m["aria.emailAddress"],
                              className: (0, c.cn)(
                                "w-full px-4 py-2.5 border border-gray-200 dark:border-gray-800 rounded-xl text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-600/70 dark:placeholder:text-gray-400/70 bg-black/0 focus:ring-0 focus:outline-0 focus:border-gray-300 dark:focus:border-gray-700",
                                k && "border-red-500 dark:border-red-500",
                                b.x.ContextualFeedbackFormInput,
                              ),
                            }),
                            k &&
                              (0, a.jsx)("p", {
                                className: "text-xs text-red-500",
                                children: m["feedback.invalidEmail"],
                              }),
                          ],
                        }),
                      ],
                    }),
                  (0, a.jsxs)("div", {
                    className: (0, c.cn)("flex gap-2 mt-2"),
                    children: [
                      (0, a.jsx)("button", {
                        id: w.V.FeedbackFormCancel,
                        type: "button",
                        onClick: u,
                        className: (0, c.cn)(
                          "px-4 py-2 border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 text-gray-800 dark:text-gray-200 text-sm rounded-xl disabled:cursor-not-allowed disabled:opacity-50",
                          b.x.ContextualFeedbackFormButton,
                        ),
                        children: m["feedback.cancel"],
                      }),
                      (0, a.jsx)("button", {
                        id: w.V.FeedbackFormSubmit,
                        type: "submit",
                        disabled: g?.textInputOnly ? !n.trim() || v || k : !t || v || k,
                        className: (0, c.cn)(
                          "px-4 py-2 bg-black dark:bg-white text-white dark:text-black text-sm font-medium rounded-xl disabled:cursor-not-allowed disabled:opacity-50",
                          b.x.ContextualFeedbackFormSubmitButton,
                        ),
                        children: m["feedback.submit"],
                      }),
                    ],
                  }),
                ],
              }),
            });
      }
      var L = r(19664),
        A = r.n(L);
      let _ = ({ className: e }) =>
          (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)("svg", {
                className: (0, c.cn)("h-3.5 w-3.5 block", e),
                xmlns: "http://www.w3.org/2000/svg",
                viewBox: "0 0 512 512",
                children: (0, a.jsx)("path", {
                  d: "M506.3 417l-213.3-364C284.8 39 270.4 32 256 32C241.6 32 227.2 39 218.1 53l-213.2 364C-10.59 444.9 9.851 480 42.74 480h426.6C502.1 480 522.6 445 506.3 417zM52.58 432L255.1 84.8L459.4 432H52.58zM256 337.1c-17.36 0-31.44 14.08-31.44 31.44c0 17.36 14.11 31.44 31.48 31.44s31.4-14.08 31.4-31.44C287.4 351.2 273.4 337.1 256 337.1zM232 184v96C232 293.3 242.8 304 256 304s24-10.75 24-24v-96C280 170.8 269.3 160 256 160S232 170.8 232 184z",
                }),
              }),
              (0, a.jsx)("svg", {
                className:
                  "h-3.5 w-3.5 hidden group-hover:block fill-gray-500 dark:fill-gray-400 group-hover:fill-gray-700 dark:group-hover:fill-gray-200",
                xmlns: "http://www.w3.org/2000/svg",
                viewBox: "0 0 512 512",
                children: (0, a.jsx)("path", {
                  d: "M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480H40c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24V296c0 13.3 10.7 24 24 24s24-10.7 24-24V184c0-13.3-10.7-24-24-24zm32 224c0-17.7-14.3-32-32-32s-32 14.3-32 32s14.3 32 32 32s32-14.3 32-32z",
                }),
              }),
            ],
          }),
        D = ({ className: e }) =>
          (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)("svg", {
                className: (0, c.cn)("h-3.5 w-3.5 block", e),
                xmlns: "http://www.w3.org/2000/svg",
                viewBox: "0 0 512 512",
                children: (0, a.jsx)("path", {
                  d: "M58.57 323.5L362.7 19.32C387.7-5.678 428.3-5.678 453.3 19.32L492.7 58.75C495.8 61.87 498.5 65.24 500.9 68.79C517.3 93.63 514.6 127.4 492.7 149.3L188.5 453.4C187.2 454.7 185.9 455.1 184.5 457.2C174.9 465.7 163.5 471.1 151.1 475.6L30.77 511C22.35 513.5 13.24 511.2 7.03 504.1C.8198 498.8-1.502 489.7 .976 481.2L36.37 360.9C40.53 346.8 48.16 333.9 58.57 323.5L58.57 323.5zM82.42 374.4L59.44 452.6L137.6 429.6C143.1 427.7 149.8 424.2 154.6 419.5L383 191L320.1 128.1L92.51 357.4C91.92 358 91.35 358.6 90.8 359.3C86.94 363.6 84.07 368.8 82.42 374.4L82.42 374.4z",
                }),
              }),
              (0, a.jsx)("svg", {
                className:
                  "h-3.5 w-3.5 hidden group-hover:block fill-gray-500 dark:fill-gray-400 group-hover:fill-gray-700 dark:group-hover:fill-gray-200",
                xmlns: "http://www.w3.org/2000/svg",
                viewBox: "0 0 512 512",
                children: (0, a.jsx)("path", {
                  d: "M362.7 19.3L314.3 67.7 444.3 197.7l48.4-48.4c25-25 25-65.5 0-90.5L453.3 19.3c-25-25-65.5-25-90.5 0zm-71 71L58.6 323.5c-10.4 10.4-18 23.3-22.2 37.4L1 481.2C-1.5 489.7 .8 498.8 7 505s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L421.7 220.3 291.7 90.3z",
                }),
              }),
            ],
          });
      var I = (function (e) {
        return ((e[(e.Edit = 0)] = "Edit"), (e[(e.Alert = 1)] = "Alert"), e);
      })({});
      let T = ({ href: e, type: t }) => {
        let { suggestEdits: r, raiseIssue: n } = (0, h.n)();
        return (0, a.jsxs)(A(), {
          href: e,
          className:
            "h-fit whitespace-nowrap px-3.5 py-2 flex flex-row gap-3 items-center border-standard rounded-xl text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 bg-white/50 dark:bg-codeblock/50 hover:border-gray-500 hover:dark:border-gray-500",
          target: "_blank",
          rel: "noopener noreferrer",
          children: [
            1 === t && (0, a.jsx)(_, { className: "fill-current" }),
            0 === t && (0, a.jsx)(D, { className: "fill-current" }),
            0 === t && (0, a.jsx)("small", { className: "text-sm leading-4", children: r }),
            1 === t && (0, a.jsx)("small", { className: "text-sm leading-4", children: n }),
          ],
        });
      };
      var M = r(81715),
        S = r.n(M),
        E = r(22153);
      function z() {
        return (0, a.jsx)("svg", {
          xmlns: "http://www.w3.org/2000/svg",
          width: "16",
          height: "16",
          viewBox: "0 0 16 16",
          className: "fill-current",
          children: (0, a.jsx)("path", {
            d: "M10.1187 14.9124C8.925 15.253 7.67813 14.5624 7.3375 13.3687L7.15938 12.7437C7.04375 12.3374 6.83438 11.9624 6.55 11.6499L4.94688 9.8874C4.66875 9.58115 4.69062 9.10615 4.99687 8.82803C5.30312 8.5499 5.77813 8.57178 6.05625 8.87803L7.65938 10.6405C8.1 11.1249 8.42188 11.703 8.6 12.3312L8.77812 12.9562C8.89062 13.353 9.30625 13.5843 9.70625 13.4718C10.1063 13.3593 10.3344 12.9437 10.2219 12.5437L10.0437 11.9187C9.86562 11.2968 9.58437 10.7093 9.2125 10.1843C9.05 9.95615 9.03125 9.65615 9.15938 9.40615C9.2875 9.15615 9.54375 8.9999 9.825 8.9999H14C14.275 8.9999 14.5 8.7749 14.5 8.4999C14.5 8.2874 14.3656 8.10303 14.175 8.03115C13.9438 7.94365 13.7688 7.7499 13.7094 7.50928C13.65 7.26865 13.7125 7.01553 13.875 6.83115C13.9531 6.74365 14 6.62803 14 6.4999C14 6.25615 13.825 6.05303 13.5938 6.00928C13.3375 5.95928 13.1219 5.78115 13.0312 5.53428C12.9406 5.2874 12.9813 5.0124 13.1438 4.80615C13.2094 4.72178 13.25 4.61553 13.25 4.49678C13.25 4.2874 13.1187 4.10303 12.9312 4.03115C12.5719 3.89053 12.3781 3.50303 12.4812 3.13115C12.4937 3.09053 12.5 3.04365 12.5 2.99678C12.5 2.72178 12.275 2.49678 12 2.49678H8.95312C8.55937 2.49678 8.17188 2.6124 7.84375 2.83115L5.91563 4.11553C5.57188 4.34678 5.10625 4.25303 4.875 3.90615C4.64375 3.55928 4.7375 3.09678 5.08437 2.86553L7.0125 1.58115C7.5875 1.19678 8.2625 0.993652 8.95312 0.993652H12C13.0844 0.993652 13.9656 1.85615 14 2.93115C14.4563 3.29678 14.75 3.85928 14.75 4.49365C14.75 4.63428 14.7344 4.76865 14.7094 4.8999C15.1906 5.26553 15.5 5.84365 15.5 6.49365C15.5 6.69678 15.4688 6.89365 15.4125 7.07803C15.775 7.44678 16 7.94678 16 8.4999C16 9.60303 15.1063 10.4999 14 10.4999H11.1156C11.2625 10.8249 11.3875 11.1624 11.4844 11.5062L11.6625 12.1312C12.0031 13.3249 11.3125 14.5718 10.1187 14.9124ZM1 11.9999C0.446875 11.9999 0 11.553 0 10.9999V3.9999C0 3.44678 0.446875 2.9999 1 2.9999H3C3.55313 2.9999 4 3.44678 4 3.9999V10.9999C4 11.553 3.55313 11.9999 3 11.9999H1Z",
          }),
        });
      }
      function F() {
        return (0, a.jsx)("svg", {
          xmlns: "http://www.w3.org/2000/svg",
          width: "16",
          height: "16",
          viewBox: "0 0 16 16",
          className: "fill-current",
          children: (0, a.jsx)("path", {
            d: "M10.1187 1.08741C8.925 0.746789 7.67813 1.43741 7.3375 2.63116L7.15938 3.25616C7.04375 3.66241 6.83438 4.03741 6.55 4.34991L4.94688 6.11241C4.66875 6.41866 4.69062 6.89366 4.99687 7.17179C5.30312 7.44991 5.77813 7.42804 6.05625 7.12179L7.65938 5.35929C8.1 4.87491 8.42188 4.29679 8.6 3.66866L8.77812 3.04366C8.89062 2.64679 9.30625 2.41554 9.70625 2.52804C10.1063 2.64054 10.3344 3.05616 10.2219 3.45616L10.0437 4.08116C9.86562 4.70304 9.58437 5.29054 9.2125 5.81554C9.05 6.04366 9.03125 6.34366 9.15938 6.59366C9.2875 6.84366 9.54375 6.99991 9.825 6.99991H14C14.275 6.99991 14.5 7.22491 14.5 7.49991C14.5 7.71241 14.3656 7.89679 14.175 7.96866C13.9438 8.05616 13.7688 8.24992 13.7094 8.49054C13.65 8.73117 13.7125 8.98429 13.875 9.16866C13.9531 9.25616 14 9.37179 14 9.49991C14 9.74366 13.825 9.94679 13.5938 9.99054C13.3375 10.0405 13.1219 10.2187 13.0312 10.4624C12.9406 10.7062 12.9813 10.9843 13.1438 11.1905C13.2094 11.2749 13.25 11.3812 13.25 11.4999C13.25 11.7093 13.1187 11.8937 12.9312 11.9655C12.5719 12.1062 12.3781 12.4937 12.4812 12.8655C12.4937 12.9062 12.5 12.953 12.5 12.9999C12.5 13.2749 12.275 13.4999 12 13.4999H8.95312C8.55937 13.4999 8.17188 13.3843 7.84375 13.1655L5.91563 11.8812C5.57188 11.6499 5.10625 11.7437 4.875 12.0905C4.64375 12.4374 4.7375 12.8999 5.08437 13.1312L7.0125 14.4155C7.5875 14.7999 8.2625 15.003 8.95312 15.003H12C13.0844 15.003 13.9656 14.1405 14 13.0655C14.4563 12.6999 14.75 12.1374 14.75 11.503C14.75 11.3624 14.7344 11.228 14.7094 11.0968C15.1906 10.7312 15.5 10.153 15.5 9.50304C15.5 9.29991 15.4688 9.10304 15.4125 8.91866C15.775 8.55304 16 8.05304 16 7.49991C16 6.39679 15.1063 5.49991 14 5.49991H11.1156C11.2625 5.17491 11.3875 4.83741 11.4844 4.49366L11.6625 3.86866C12.0031 2.67491 11.3125 1.42804 10.1187 1.08741ZM1 5.99991C0.446875 5.99991 0 6.44679 0 6.99991V13.9999C0 14.553 0.446875 14.9999 1 14.9999H3C3.55313 14.9999 4 14.553 4 13.9999V6.99991C4 6.44679 3.55313 5.99991 3 5.99991H1Z",
          }),
        });
      }
      function V({ type: e, label: t, selectedFeedback: r, setSelectedFeedback: n }) {
        let s = (0, E.p)("docs.feedback.thumbs_up"),
          o = (0, E.p)("docs.feedback.thumbs_down"),
          i = (0, E.p)("thumb_vote");
        return (0, a.jsxs)("button", {
          id: "Yes" === e ? w.V.FeedbackThumbsUp : w.V.FeedbackThumbsDown,
          className: (0, c.cn)(
            "px-3.5 py-2 flex flex-row gap-3 items-center border-standard rounded-xl text-gray-600 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 bg-white/50 dark:bg-codeblock/50 hover:border-gray-500 hover:dark:border-gray-500",
            r === e &&
              "border border-gray-500 dark:border-gray-500 text-gray-700 dark:text-gray-300",
          ),
          onClick: () => {
            ("Yes" === e ? s({}) : o({}), i({ vote: e }), n(e));
          },
          children: [
            "Yes" === e ? (0, a.jsx)(F, {}) : (0, a.jsx)(z, {}),
            (0, a.jsx)("small", { className: "text-sm font-normal leading-4", children: S()(t) }),
          ],
        });
      }
      let B = { YES: "Yes", NO: "No" };
      function H() {
        let e,
          t,
          [r, n] = (0, l.useState)(null),
          [s, o] = (0, l.useState)(!1),
          [i, g] = (0, l.useState)(!1),
          [x, u] = (0, l.useState)(""),
          [j, w] = (0, l.useState)(""),
          [C, L] = (0, l.useState)(""),
          {
            gitSource: A,
            feedback: _,
            entitlements: D,
            subdomain: M,
          } = (0, l.useContext)(d.DeploymentMetadataContext),
          { docsConfig: S } = (0, l.useContext)(d.DocsConfigContext),
          { cookiesEnabled: E } = (0, l.useContext)(m.O),
          { isCustom: z } = (0, y.c)(),
          F = (0, f.G)(),
          { yes: H, no: O, wasThisPageHelpful: P } = (0, h.n)(),
          $ = S?.integrations?.telemetry?.enabled === !1,
          R = (0, v.J)(D, "CONTEXTUAL_FEEDBACK");
        F &&
          A?.type === "github" &&
          !A.isPrivate &&
          ((e = (function (e, t) {
            let { owner: r, repo: a, deployBranch: n, contentDirectory: s } = t;
            return `https://github.com/${r}/${a}/edit/${n}/${s ? `${s}/` : ""}${(0, k.$)(e) || "index"}.mdx`;
          })(F, A)),
          (t = (function (e, t) {
            let { owner: r, repo: a } = t;
            return `https://github.com/${r}/${a}/issues/new?title=Issue on docs&body=Path: ${e || "index"}`;
          })(F, A)));
        let G = (_?.edits && e) || (_?.issues && t) || _?.thumbs,
          W = (e) => {
            (n(e), w(""), u(""), L(""), R && (e ? o(!0) : o(!1)));
          },
          U = async ({ optionId: e, additionalFeedback: t, email: a }) => {
            try {
              let s = JSON.stringify({
                path: F,
                helpful: "Yes" === r,
                feedback: `[${e}]${t?.trim() ? ` ${t.trim()}` : ""}`,
                ...(a?.trim() && { contact: a.trim() }),
              });
              (fetch(`${p.c.BASE_PATH}/_mintlify/feedback/${M}/contextual-feedback`, {
                method: "POST",
                body: s,
              }),
                g(!0),
                setTimeout(() => {
                  (n(null), w(""), u(""), L(""), o(!1), g(!1));
                }, 3e3));
            } catch (e) {
              console.error("Error submitting feedback:", e);
            }
          };
        return !G || !E || $ || z
          ? null
          : (0, a.jsxs)("div", {
              className: (0, c.cn)(b.x.FeedbackToolbar, "pb-16 w-full flex flex-col gap-y-8"),
              children: [
                (0, a.jsxs)("div", {
                  className: (0, c.cn)(
                    "flex flex-row flex-wrap gap-4 items-center justify-between",
                  ),
                  children: [
                    _.thumbs &&
                      (0, a.jsx)("p", {
                        className:
                          "inline-block text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap",
                        children: P,
                      }),
                    (0, a.jsxs)("div", {
                      className: (0, c.cn)(
                        "flex flex-wrap flex-grow gap-3 items-center",
                        _.edits || _.issues ? "justify-between" : "justify-end",
                      ),
                      children: [
                        _.thumbs &&
                          (0, a.jsxs)("div", {
                            className: "flex gap-3 items-center",
                            children: [
                              (0, a.jsx)(V, {
                                type: B.YES,
                                label: H,
                                selectedFeedback: r,
                                setSelectedFeedback: W,
                              }),
                              (0, a.jsx)(V, {
                                type: B.NO,
                                label: O,
                                selectedFeedback: r,
                                setSelectedFeedback: W,
                              }),
                            ],
                          }),
                        (0, a.jsxs)("div", {
                          className: "flex gap-3",
                          children: [
                            _.edits && e && (0, a.jsx)(T, { type: I.Edit, href: e }),
                            _.issues && t && (0, a.jsx)(T, { type: I.Alert, href: t }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                R &&
                  s &&
                  r &&
                  (0, a.jsx)(N, {
                    feedbackType: r,
                    config: _.contextualFeedback,
                    additionalFeedback: x,
                    setAdditionalFeedback: u,
                    selectedOption: j,
                    setSelectedOption: w,
                    email: C,
                    setEmail: L,
                    showThankYouMessage: i,
                    onSubmit: U,
                    onCancelDetailedFeedback: () => n(null),
                  }),
              ],
            });
      }
      var O = r(97154),
        P = r(47473);
      function $({ pageMetadata: e, children: t }) {
        return (0, a.jsxs)(a.Fragment, {
          children: [
            (0, a.jsx)(u.z, {}),
            (0, a.jsx)(x.g, { mobile: !0 }),
            (0, a.jsx)(s.A, { mobile: !0 }),
            (0, a.jsx)(o.j, { pageMetadata: e, children: t }),
            (0, a.jsx)(i.U, { pageMetadata: e, children: t }),
            (0, a.jsx)(g, { pageMetadata: e }),
            (0, a.jsx)(H, {}),
            (0, a.jsx)(P.d, {}),
            (0, a.jsx)(O.A, {}),
            (0, a.jsx)(n.w, {}),
          ],
        });
      }
    },
    16974: (e, t, r) => {
      r.d(t, { S: () => D, w: () => _ });
      var a = r(54568),
        n = r(7620),
        s = r(12192),
        o = r(30793),
        i = r(76829),
        l = r(22153),
        d = r(36602),
        c = r(35878),
        g = r(33052);
      let x = ({ className: e }) =>
        (0, a.jsxs)("svg", {
          width: "1274",
          height: "367",
          viewBox: "0 0 1274 367",
          fill: "none",
          xmlns: "http://www.w3.org/2000/svg",
          className: e,
          children: [
            (0, a.jsx)("path", {
              d: "M1154.38 366.038H1097.86L1137.69 276.14L1058.04 97.1046H1114.93L1161.35 209.337C1162.97 213.26 1168.53 213.253 1170.14 209.325L1216.21 97.1046H1273.49L1154.38 366.038Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M982.714 286.761V142.622H944.403V97.1041H982.714V72.4488C982.714 49.9429 989.542 32.2416 1003.2 19.345C1016.85 6.44832 1034.17 0 1055.16 0C1068.06 0 1079.06 1.39081 1088.16 4.17244V50.0693C1082.09 47.7934 1075.01 46.6555 1066.92 46.6555C1055.54 46.6555 1047.32 49.1843 1042.27 54.2418C1037.21 59.0464 1034.68 67.2648 1034.68 78.8971V97.1041H1088.16V142.622H1034.68V286.761H982.714Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M897.916 66.0005C889.066 66.0005 881.353 62.8395 874.778 56.5176C868.203 49.9429 864.916 42.1037 864.916 33.0002C864.916 23.8967 868.203 16.184 874.778 9.86215C881.353 3.28738 889.066 0 897.916 0C907.273 0 915.112 3.28738 921.434 9.86215C928.008 16.184 931.296 23.8967 931.296 33.0002C931.296 42.1037 928.008 49.9429 921.434 56.5176C915.112 62.8395 907.273 66.0005 897.916 66.0005ZM872.123 286.761V97.1041H924.089V286.761H872.123Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M781.638 286.761V2.27609H833.604V286.761H781.638Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M722.934 289.037C701.693 289.037 684.244 283.221 670.589 271.588C657.187 259.703 650.485 242.634 650.485 220.381V142.622H612.175V97.1044H650.485V44.3799H702.451V97.1044H755.934V142.622H702.451V210.14C702.451 221.772 704.98 230.117 710.038 235.174C715.095 239.979 723.313 242.381 734.693 242.381C742.785 242.381 749.865 241.243 755.934 238.967V284.864C746.831 287.646 735.831 289.037 722.934 289.037Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M417.674 286.761V97.1041H469.64V110.967C469.64 113.311 472.83 114.347 474.382 112.591C485.967 99.4848 502.467 92.9317 523.881 92.9317C546.64 92.9317 564.468 100.518 577.365 115.69C590.514 130.61 597.089 150.587 597.089 175.622V286.761H545.123V184.346C545.123 170.438 542.215 159.691 536.399 152.105C530.583 144.265 522.364 140.346 511.743 140.346C499.1 140.346 488.858 144.898 481.019 154.001C473.433 163.105 469.64 176.507 469.64 194.208V286.761H417.674Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M352.981 66.0005C344.13 66.0005 336.417 62.8395 329.843 56.5176C323.268 49.9429 319.98 42.1037 319.98 33.0002C319.98 23.8967 323.268 16.184 329.843 9.86215C336.417 3.28738 344.13 0 352.981 0C362.337 0 370.176 3.28738 376.498 9.86215C383.073 16.184 386.36 23.8967 386.36 33.0002C386.36 42.1037 383.073 49.9429 376.498 56.5176C370.176 62.8395 362.337 66.0005 352.981 66.0005ZM327.187 286.761V97.1041H379.153V286.761H327.187Z",
              fill: "currentColor",
            }),
            (0, a.jsx)("path", {
              d: "M238.967 286.761V185.484C238.967 155.392 229.105 140.346 209.381 140.346C198.001 140.346 188.898 144.645 182.07 153.242C175.495 161.84 171.955 174.61 171.449 191.553V286.761H119.484V185.484C119.484 155.392 109.621 140.346 89.8972 140.346C78.2649 140.346 69.035 144.898 62.2073 154.001C55.3797 163.105 51.9659 176.507 51.9659 194.208V286.761H0V97.1041H51.9659V111.103C51.9659 113.435 55.1014 114.462 56.633 112.704C68.1136 99.5223 83.3741 92.9317 102.415 92.9317C127.436 92.9317 146.283 103.262 158.953 123.923C159.953 125.553 162.412 125.527 163.406 123.894C168.884 114.891 176.496 107.731 186.243 102.415C197.369 96.0926 208.622 92.9317 220.002 92.9317C242.507 92.9317 259.956 100.392 272.347 115.311C284.738 130.231 290.933 150.714 290.933 176.76V286.761H238.967Z",
              fill: "currentColor",
            }),
          ],
        });
      var u = r(34766),
        m = r(81325),
        h = r(44564),
        p = r(51115),
        f = r(24560),
        y = r(73205);
      let b = new Set(["system", "light", "dark"]),
        v = [
          { value: "system", icon: y.yo },
          { value: "light", icon: y.gL },
          { value: "dark", icon: p.A },
        ],
        k = () => {
          let { docsConfig: e } = (0, n.useContext)(o.DocsConfigContext),
            { theme: t, setTheme: r } = (0, f.D)(),
            s = (0, i.n)();
          return e?.appearance?.strict === !0
            ? null
            : (0, a.jsx)("div", {
                className: "flex items-center gap-2",
                children: v.map((e) =>
                  (0, a.jsx)(
                    "button",
                    {
                      "aria-label": s["aria.switchToTheme"].replace("{theme}", e.value),
                      "data-testid": `mode-switch-${e.value}`,
                      className: (0, m.cn)(
                        "p-1.5 rounded-lg",
                        e.value === t
                          ? "bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                          : "text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400",
                      ),
                      onClick: () => {
                        e.value !== t && b.has(e.value) && r(e.value);
                      },
                      suppressHydrationWarning: !0,
                      children: (0, a.jsx)(e.icon, { className: "size-4" }),
                    },
                    e.value,
                  ),
                ),
              });
        },
        j = new Set([
          "x",
          "website",
          "facebook",
          "youtube",
          "discord",
          "slack",
          "github",
          "linkedin",
          "instagram",
          "hacker-news",
          "medium",
          "telegram",
          "twitter",
          "x-twitter",
          "earth-americas",
          "bluesky",
          "threads",
          "reddit",
          "podcast",
        ]);
      var w = r(68999);
      let C = ({ type: e, url: t, iconClassName: r }) => {
          let n,
            s = "website" === e || null == e ? "earth-americas" : e;
          return (
            "x" === s && (s = "x-twitter"),
            ((n = s), j.has(n))
              ? (0, a.jsxs)("a", {
                  href: t,
                  target: "_blank",
                  className: "h-fit",
                  children: [
                    (0, a.jsx)("span", { className: "sr-only", children: e }),
                    (0, a.jsx)(w.A, {
                      icon: s,
                      iconType: "solid",
                      className: (0, m.cn)(
                        "w-5 h-5 bg-gray-500 dark:bg-gray-600 hover:bg-gray-600 dark:hover:bg-gray-500",
                        r,
                      ),
                    }),
                  ],
                })
              : null
          );
        },
        N = ({ isAdvanced: e, className: t }) => {
          let { docsConfig: r } = (0, n.useContext)(o.DocsConfigContext),
            s = r?.footer?.socials;
          if (!s) {
            return null;
          }
          let i = e ? "" : "bg-gray-400 dark:bg-gray-500 hover:bg-gray-500 dark:hover:bg-gray-400",
            l = (0, m.cn)(
              "flex",
              e ? "gap-4 min-w-[140px] max-w-[492px] flex-wrap" : "gap-6 flex-wrap",
            );
          return Array.isArray(s)
            ? (0, a.jsx)("div", {
                className: (0, m.cn)(l, t),
                children: s.map((e) =>
                  (0, a.jsx)(C, { url: e.url, type: e.type, iconClassName: i }, e.url),
                ),
              })
            : "object" == typeof s
              ? (0, a.jsx)("div", {
                  className: (0, m.cn)(l, t),
                  children: Object.entries(s).map(([e, t]) =>
                    (0, a.jsx)(C, { url: t, type: e, iconClassName: i }, t),
                  ),
                })
              : null;
        },
        L = () => {
          let { docsConfig: e } = (0, n.useContext)(o.DocsConfigContext),
            t = e?.footer?.links,
            r = 1 === t?.length;
          return t
            ? (0, a.jsx)("div", {
                className: "flex flex-col sm:grid max-md:!grid-cols-2 gap-8 flex-1",
                style: { gridTemplateColumns: `repeat(${t.length}, minmax(0, 1fr))` },
                children: t.map((e, t) =>
                  (0, a.jsx)(
                    "div",
                    {
                      className: (0, m.cn)(
                        "flex flex-col gap-4 flex-1 whitespace-nowrap",
                        r ? "max-w-full" : "w-full md:items-center",
                      ),
                      children: (0, a.jsxs)("div", {
                        className: (0, m.cn)(
                          "flex gap-4 flex-col",
                          r ? "md:flex-row md:items-center md:gap-8 md:justify-center" : "",
                        ),
                        children: [
                          e.header &&
                            !r &&
                            (0, a.jsx)("p", {
                              className: "text-sm font-semibold text-gray-950 dark:text-white mb-1",
                              children: e.header,
                            }),
                          e.items.map((e) =>
                            (0, a.jsx)(
                              "a",
                              {
                                className:
                                  "text-sm max-w-36 whitespace-normal md:truncate text-gray-950/50 dark:text-white/50 hover:text-gray-950/70 dark:hover:text-white/70",
                                href: e.href,
                                target:
                                  e.href.startsWith("http://") || e.href.startsWith("https://")
                                    ? "_blank"
                                    : "_self",
                                rel: "noreferrer",
                                children: e.label,
                              },
                              `${e.label}-${e.href}}`,
                            ),
                          ),
                        ],
                      }),
                    },
                    `${e.header}-${t}`,
                  ),
                ),
              })
            : null;
        },
        A = ({ isAdvanced: e }) => {
          let { subdomain: t, entitlements: r } = (0, n.useContext)(o.DeploymentMetadataContext),
            { poweredBy: s } = (0, i.n)(),
            d = (0, l.p)("docs.footer.powered_by_mintlify_click");
          return (0, h.x)(r, "REMOVE_BRANDING")
            ? null
            : e
              ? (0, a.jsxs)(a.Fragment, {
                  children: [
                    (0, a.jsx)("div", { className: "h-[1px] w-full bg-gray-100 dark:bg-white/5" }),
                    (0, a.jsxs)("div", {
                      className: "flex items-center justify-between",
                      children: [
                        (0, a.jsx)("div", {
                          className: "sm:flex",
                          children: (0, a.jsxs)("a", {
                            href: `https://www.mintlify.com?utm_campaign=poweredBy&utm_medium=referral&utm_source=${t}`,
                            target: "_blank",
                            rel: "noreferrer",
                            className:
                              "group flex items-baseline gap-1 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300",
                            onClick: () => d({ subdomain: t }).catch(console.error),
                            children: [
                              (0, a.jsx)("span", { children: s }),
                              (0, a.jsx)(x, { className: "h-3.5 w-auto translate-y-[3px]" }),
                            ],
                          }),
                        }),
                        (0, a.jsx)(k, {}),
                      ],
                    }),
                  ],
                })
              : (0, a.jsx)(a.Fragment, {
                  children: (0, a.jsx)("div", {
                    className: "flex items-center justify-between",
                    children: (0, a.jsx)("div", {
                      className: "sm:flex",
                      children: (0, a.jsxs)("a", {
                        href: `https://www.mintlify.com?utm_campaign=poweredBy&utm_medium=referral&utm_source=${t}`,
                        target: "_blank",
                        rel: "noreferrer",
                        className:
                          "group flex items-baseline gap-1 text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 text-nowrap",
                        onClick: () => d({ subdomain: t }).catch(console.error),
                        children: [
                          (0, a.jsx)("span", { children: s }),
                          (0, a.jsx)(x, { className: "h-3.5 w-auto translate-y-[3px]" }),
                        ],
                      }),
                    }),
                  }),
                });
        },
        _ = ({ className: e }) => {
          let { isCustom: t } = (0, d.c)(),
            { docsConfig: r } = (0, n.useContext)(o.DocsConfigContext),
            s = (0, n.useMemo)(() => r?.footer?.links && r.footer.links.length > 0, [r]);
          return t || s
            ? null
            : (0, a.jsxs)("footer", {
                id: c.V.Footer,
                className: (0, m.cn)(
                  "flex gap-12 justify-between pt-10 border-t border-gray-100 sm:flex dark:border-gray-800/50 pb-28",
                  e,
                ),
                children: [(0, a.jsx)(N, {}), (0, a.jsx)(A, {})],
              });
        },
        D = ({ className: e, disableSidebarOffset: t }) => {
          let { docsConfig: r } = (0, n.useContext)(o.DocsConfigContext),
            { banner: l } = (0, n.useContext)(s.y),
            { divisions: x } = (0, n.useContext)(i.NavigationContext),
            { isCustom: h, isCenter: p } = (0, d.c)(),
            f = x.tabs.length > 0,
            y = !!l,
            b = r?.footer?.links && r.footer.links.length <= 3 ? "column" : "row",
            v = r?.footer?.links && 1 === r.footer.links.length,
            k = (() => {
              let e = 4;
              return (f && r?.theme !== "linden" && (e += 3.1), y && (e += 2.5), e);
            })(),
            j = (0, n.useMemo)(() => r?.footer?.links && r.footer.links.length > 0, [r]);
          if (
            ((0, n.useEffect)(() => {
              if (!j || t) {
                return;
              }
              let e = document.getElementById(c.V.Navbar),
                a = document.getElementById(c.V.NavigationItems),
                n = document.getElementById(c.V.Sidebar),
                s = document.getElementById(c.V.Footer),
                o = document.getElementById(c.V.TableOfContentsContent),
                i = 16 * k,
                l = 32 * (r?.theme === "mint" || r?.theme === "linden"),
                d = () => {
                  if (!s || p) {
                    return;
                  }
                  let t = (a?.clientHeight ?? 0) + i + l,
                    r = s.getBoundingClientRect().top,
                    d = window.innerHeight - r;
                  (n &&
                    a &&
                    (t > r && d > 0
                      ? ((n.style.top = `-${d}px`), (n.style.height = `${window.innerHeight}px`))
                      : ((n.style.top = `${k}rem`), (n.style.height = "auto"))),
                    o &&
                      e &&
                      (d > 0
                        ? (o.style.top = h
                            ? `${e.clientHeight - d}px`
                            : `${40 + e.clientHeight - d}px`)
                        : (o.style.top = "")));
                };
              return (
                d(),
                window.addEventListener("scroll", d, { passive: !0 }),
                () => {
                  (window.removeEventListener("scroll", d),
                    n && ((n.style.top = ""), (n.style.height = "")),
                    o && (o.style.top = ""));
                }
              );
            }, [k, j, t, p, h, r?.theme]),
            !j)
          ) {
            return null;
          }
          let w = r?.footer?.links?.every((e) => e.header);
          return (0, a.jsx)("footer", {
            id: c.V.Footer,
            className: (0, m.cn)(
              g.x.AdvancedFooter,
              "flex flex-col items-center mx-auto border-t border-gray-100 dark:border-gray-800/50",
              e,
            ),
            children: (0, a.jsxs)("div", {
              className:
                "flex w-full flex-col gap-12 justify-between px-8 py-16 md:py-20 lg:py-28 max-w-[984px] z-20",
              children: [
                (0, a.jsxs)("div", {
                  className: (0, m.cn)(
                    "flex flex-col md:flex-row gap-8 justify-between",
                    !v && " min-h-[76px]",
                  ),
                  children: [
                    (0, a.jsxs)("div", {
                      className:
                        "flex md:flex-col justify-between items-center md:items-start min-w-16 md:min-w-20 lg:min-w-48 md:gap-y-24",
                      children: [
                        (0, a.jsx)(u.l, { logoClassName: "max-w-48 h-[26px]" }),
                        (0, a.jsx)(N, {
                          isAdvanced: !0,
                          className: (0, m.cn)(
                            "h-fit",
                            "column" === b
                              ? w
                                ? "md:hidden justify-end"
                                : "hidden"
                              : w
                                ? "flex justify-end md:justify-start"
                                : "hidden md:flex justify-end md:justify-start",
                          ),
                        }),
                      ],
                    }),
                    (0, a.jsx)(L, {}),
                    "column" === b &&
                      (0, a.jsx)(N, { isAdvanced: !0, className: "hidden md:flex justify-end" }),
                  ],
                }),
                !w && (0, a.jsx)(N, { isAdvanced: !0, className: "md:hidden justify-start" }),
                (0, a.jsx)(A, { isAdvanced: !0 }),
              ],
            }),
          });
        };
    },
    21254: (e, t, r) => {
      r.d(t, { Anchors: () => d });
      var a = r(54568),
        n = r(7620),
        s = r(76829),
        o = r(29462),
        i = r(81325),
        l = r(79769);
      function d({ className: e }) {
        let { divisions: t } = (0, n.useContext)(s.NavigationContext),
          { anchorDefault: r } = (0, o.G)();
        return (0, a.jsx)("ul", {
          className: (0, i.cn)("list-none", e),
          children: t.anchors.map((e) =>
            (0, a.jsx)(
              "li",
              {
                className: "list-none",
                children: (0, a.jsx)(
                  l.h,
                  {
                    href: e.href,
                    name: e.name,
                    icon: "string" == typeof e.icon ? e.icon : e.icon?.name,
                    iconType: "string" == typeof e.icon ? "solid" : e.icon?.style,
                    color: e.color?.light ?? r,
                    isActive: e.isActive,
                  },
                  e.name,
                ),
              },
              e.name,
            ),
          ),
        });
      }
    },
    21433: (e, t, r) => {
      r.d(t, { h: () => o });
      var a = r(54568),
        n = r(33052),
        s = r(81325);
      let o = ({ tag: e, isActive: t }) =>
        (0, a.jsx)("span", {
          className: (0, s.cn)(n.x.NavTagPill, "flex items-center w-fit"),
          children: (0, a.jsx)("span", {
            className: (0, s.cn)(
              n.x.NavTagPillText,
              "px-1 py-0.5 rounded-md text-[0.65rem] leading-tight font-bold text-primary dark:text-primary-light bg-primary/10",
            ),
            "data-nav-tag": e,
            "data-active": t,
            children: e,
          }),
        });
    },
    23416: (e, t, r) => {
      r.d(t, { U: () => c });
      var a = r(54568),
        n = r(24560),
        s = r(7620),
        o = r(30793),
        i = r(76829),
        l = r(73205),
        d = r(81325);
      function c() {
        let { docsConfig: e } = (0, s.useContext)(o.DocsConfigContext),
          { resolvedTheme: t, setTheme: r } = (0, n.D)(),
          c = (0, i.n)();
        return e?.appearance?.strict === !0
          ? null
          : (0, a.jsxs)("button", {
              onClick: function () {
                r("dark" === t ? "light" : "dark");
              },
              className:
                "relative flex lg:h-7 h-[2.375rem] justify-between lg:w-[3.25rem] w-[4.5rem] items-center rounded-full border border-gray-200/70 dark:border-white/[0.07] hover:border-gray-200 dark:hover:border-white/10 p-1",
              "aria-label": c["aria.toggleDarkMode"],
              children: [
                (0, a.jsxs)("div", {
                  className: "z-10 flex w-full items-center justify-between lg:px-1 px-2",
                  children: [
                    (0, a.jsx)(l.gL, {
                      className: "lg:size-3 size-3.5 text-gray-600 dark:text-gray-600",
                    }),
                    (0, a.jsx)(l.rR, {
                      className:
                        "lg:size-3 size-3.5 text-gray-400 dark:text-gray-400 translate-x-[0.5px]",
                    }),
                  ],
                }),
                (0, a.jsx)("div", {
                  className: (0, d.cn)(
                    "absolute left-1 lg:size-5 size-[1.875rem] rounded-full bg-gray-200/50 dark:bg-gray-900 transition-transform duration-200",
                    "lg:dark:translate-x-[1.40rem] dark:translate-x-[32px]",
                  ),
                }),
              ],
            });
      }
    },
    26842: (e, t, r) => {
      r.d(t, { A: () => d });
      var a = r(54568),
        n = r(7620),
        s = r(35878),
        o = r(73205),
        i = r(81325),
        l = r(12158);
      let d = function () {
        let { hasChatPermissions: e } = (0, n.useContext)(l.SearchContext),
          { isChatSheetOpen: t, onChatSheetToggle: r } = (0, n.useContext)(l.ChatAssistantContext);
        return e
          ? (0, a.jsx)("button", {
              onClick: () => r({ entryPoint: "mobile" }),
              id: s.V.AssistantEntryMobile,
              children: (0, a.jsx)(o.BZ, {
                className: (0, i.cn)(
                  "size-4.5 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300",
                  t &&
                    "text-primary dark:text-primary-light hover:text-primary-dark dark:hover:text-primary",
                ),
              }),
            })
          : null;
      };
    },
    29462: (e, t, r) => {
      r.d(t, { G: () => o });
      var a = r(10897),
        n = r(7620),
        s = r(30793);
      function o() {
        let { docsConfig: e } = (0, n.useContext)(s.DocsConfigContext);
        return (0, n.useMemo)(() => {
          let t = e?.colors.primary ?? "#16A34A",
            r = e?.colors.light ?? "#4ADE80",
            n = e?.colors.dark ?? "#166534",
            s = e?.colors.primary,
            o = e?.colors.primary,
            { light: i, dark: l, lightHex: d, darkHex: c } = (0, a.JT)(e);
          return (
            e?.theme === "linden" &&
              (e.background = {
                ...e.background,
                color: {
                  light: e.background?.color?.light || (0, a.Ob)((0, a._x)("#FFFFFF", 1, t, 0.03)),
                  dark: e.background?.color?.dark || (0, a.Ob)((0, a._x)("#09090B", 1, r, 0.03)),
                },
              }),
            {
              primary: (0, a.N9)(t),
              primaryLight: (0, a.N9)(r),
              primaryDark: (0, a.N9)(n),
              backgroundLight: i,
              backgroundDark: l,
              bgLightHex: d,
              bgDarkHex: c,
              anchorDefault: s,
              dropdownDefault: o,
              gray: (0, a.Eo)(t),
            }
          );
        }, [e]);
      }
    },
    30921: (e, t, r) => {
      r.d(t, { DEFAULT_ACTION_CLASSNAME: () => v, NavbarLinks: () => b });
      var a = r(54568),
        n = r(70785),
        s = r(19664),
        o = r.n(s),
        i = r(7620),
        l = r(30793),
        d = r(68367),
        c = r(22153),
        g = r(33052),
        x = r(68999),
        u = r(81325),
        m = r(50864),
        h = r(43119),
        p = r(49201),
        f = r(96116),
        y = r(62581);
      function b({ actionClassName: e, showThemeToggle: t, hideMobileCtaButton: r }) {
        let { docsConfig: s } = (0, i.useContext)(l.DocsConfigContext),
          b = (0, c.p)("docs.navitem.click"),
          {
            userAuthLoginButton: v,
            authLoginButton: k,
            authLogoutButton: j,
            userAuthLogoutButton: w,
          } = (0, i.useContext)(d.F),
          C = (0, i.useCallback)((e, t) => b({ name: e, url: t }), [b]);
        return (0, a.jsxs)(a.Fragment, {
          children: [
            s?.navbar?.links?.map((t) => {
              let r = (0, n.v)(t.href),
                { label: s, type: i } = t;
              return "github" === i
                ? (0, a.jsx)(
                    p.GitHubCta,
                    { href: t.href, label: s || "", actionClassName: e },
                    t.href,
                  )
                : "discord" === i
                  ? (0, a.jsx)(
                      h.DiscordCta,
                      { href: t.href, label: s || "", actionClassName: e },
                      t.href,
                    )
                  : r
                    ? (0, a.jsx)(
                        "li",
                        {
                          className: (0, u.cn)(g.x.NavBarLink),
                          children: (0, a.jsxs)("a", {
                            href: t.href,
                            className: e,
                            onClick: () => C(s, t.href),
                            target: "_blank",
                            children: [
                              t.icon &&
                                (0, a.jsx)(x.ComponentIcon, {
                                  icon: "string" == typeof t.icon ? t.icon : t.icon.name,
                                  iconType:
                                    "string" == typeof t.icon
                                      ? "regular"
                                      : t.icon.style || "regular",
                                  className: "h-4 w-4",
                                }),
                              s,
                            ],
                          }),
                        },
                        s,
                      )
                    : (0, a.jsx)(
                        "li",
                        {
                          className: (0, u.cn)(g.x.NavBarLink),
                          children: (0, a.jsxs)(o(), {
                            href: t.href || "/",
                            className: e,
                            onClick: () => C(s, t.href),
                            children: [
                              t.icon &&
                                (0, a.jsx)(x.ComponentIcon, {
                                  icon: "string" == typeof t.icon ? t.icon : t.icon.name,
                                  iconType:
                                    "string" == typeof t.icon
                                      ? "regular"
                                      : t.icon.style || "regular",
                                  className: "h-4 w-4",
                                }),
                              s,
                            ],
                          }),
                        },
                        s,
                      );
            }),
            v && (0, a.jsx)("li", { children: v }, "login"),
            w && (0, a.jsx)("li", { children: w }, "personalization-logout"),
            k && (0, a.jsx)("li", { children: k }, "partial-auth-login"),
            j && (0, a.jsx)("li", { children: j }, "auth-logout"),
            t && (0, a.jsx)("li", { children: (0, a.jsx)(y.ModeToggle, {}) }, "theme-toggle"),
            !r && (0, a.jsx)(f.MobileTopBarCtaButton, { actionClassName: e }),
            (0, a.jsx)(m.j, {}),
          ],
        });
      }
      let v =
        "flex items-center gap-1.5 whitespace-nowrap font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300";
    },
    32397: (e, t, r) => {
      r.d(t, { Pagination: () => D });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        o = r(33052),
        i = r(85973),
        l = r(14486),
        d = r(19664),
        c = r.n(d),
        g = r(76829),
        x = r(35878),
        u = r(81325),
        m = r(39282),
        h = r(36602),
        p = r(2811),
        f = r(84514),
        y = r(67793),
        b = r(27194);
      function v(e) {
        let [{ pageMetadata: t }] = (0, m.O)(),
          { prev: r, next: a } = (function () {
            let e = (0, b.G)(),
              { divisions: t } = (0, n.useContext)(g.NavigationContext);
            return (0, n.useMemo)(() => {
              let r = ((e) => {
                  let t = [],
                    r = (e) => {
                      if (((0, p.y)(e) && t.push(e), "pages" in e && Array.isArray(e.pages))) {
                        if ("root" in e && null != e.root && "object" == typeof e.root) {
                          let a = e.root;
                          (0, p.y)(a) ? t.push({ ...a, href: (0, f.C)(a.href) }) : r(a);
                        }
                        for (let a of e.pages) {
                          if ((0, p.y)(a)) {
                            let e = { ...a, href: (0, f.C)(a.href) };
                            t.push(e);
                          } else r(a);
                        }
                      }
                    };
                  for (let t of e) {
                    r(t);
                  }
                  return t;
                })(t.groupsOrPages),
                a = r.findIndex((t) => (0, y.N)(t.href, e));
              return { prev: a > -1 ? r[a - 1] : void 0, next: a > -1 ? r[a + 1] : void 0 };
            }, [e, t.groupsOrPages]);
          })(),
          { isCustom: s } = (0, h.c)(),
          o = e?.hideOnCustomPages ?? !1,
          i = !0 === t.hideFooterPagination || (o && s);
        return { previous: i ? void 0 : r, next: i ? void 0 : a, isHidden: i };
      }
      function k({ prevClassName: e, nextClassName: t, titleClassName: r }) {
        let { previous: n, next: s } = v(),
          { previous: o, next: i } = (0, g.n)();
        return null == n && null == s
          ? null
          : (0, a.jsxs)("div", {
              id: x.V.Pagination,
              className: "grid lg:grid-cols-2 gap-4",
              children: [
                n
                  ? (0, a.jsx)(j, {
                      href: n.href,
                      title: n.title,
                      label: o,
                      align: "left",
                      className: e,
                      titleClassName: r,
                    })
                  : (0, a.jsx)("div", {}),
                s
                  ? (0, a.jsx)(j, {
                      href: s.href,
                      title: s.title,
                      label: i,
                      align: "right",
                      className: t,
                      titleClassName: r,
                    })
                  : (0, a.jsx)("div", {}),
              ],
            });
      }
      function j({
        href: e,
        title: t,
        label: r,
        align: n = "left",
        className: s,
        titleClassName: o,
      }) {
        return (0, a.jsx)(c(), {
          href: e || "/",
          className: (0, u.cn)(
            s,
            "border border-gray-200/70 dark:border-gray-800/70 group flex items-center rounded-xl py-3 px-4 hover:border-gray-300 dark:hover:border-gray-700",
            "left" === n ? "justify-start" : "justify-end",
          ),
          children: (0, a.jsxs)("div", {
            className: "space-y-1",
            children: [
              (0, a.jsx)("div", {
                className: (0, u.cn)(
                  o,
                  "font-medium text-gray-900 dark:text-gray-200",
                  "right" === n && "text-right",
                ),
                children: t,
              }),
              (0, a.jsxs)("div", {
                className: (0, u.cn)(
                  "flex items-center text-sm text-gray-500 dark:text-gray-500 group-hover:text-gray-600 dark:group-hover:text-gray-400 gap-x-1",
                  "right" === n && "flex-row-reverse",
                ),
                children: [
                  "left" === n
                    ? (0, a.jsx)(i.A, {
                        className:
                          "size-3.5 text-gray-400 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-500",
                      })
                    : (0, a.jsx)(l.A, {
                        className:
                          "size-3.5 text-gray-400 dark:text-gray-600 group-hover:text-gray-500 dark:group-hover:text-gray-500",
                      }),
                  (0, a.jsx)("span", { className: "font-medium", children: r }),
                ],
              }),
            ],
          }),
        });
      }
      function w() {
        let { previous: e, next: t } = v();
        return null == e && null == t
          ? null
          : (0, a.jsxs)("div", {
              id: x.V.Pagination,
              className: (0, u.cn)("grid gap-4", e && t ? "lg:grid-cols-2" : "lg:grid-cols-1"),
              children: [
                e
                  ? (0, a.jsx)(C, { href: e.href, title: e.title, align: "left" })
                  : (0, a.jsx)("div", {}),
                t
                  ? (0, a.jsx)(C, { href: t.href, title: t.title, align: "right" })
                  : (0, a.jsx)("div", {}),
              ],
            });
      }
      function C({ href: e, title: t, align: r }) {
        return (0, a.jsx)(c(), {
          href: e || "/",
          className: (0, u.cn)(
            "text-primary dark:text-primary-light hover:text-primary-dark dark:hover:text-primary border border-current group flex items-center rounded-lg py-1.5 px-3 justify-center text-sm ",
          ),
          children: (0, a.jsxs)("div", {
            className: (0, u.cn)("flex items-center gap-1", "left" === r && "flex-row-reverse"),
            children: [
              (0, a.jsx)("div", { className: "font-medium uppercase", children: t }),
              "right" === r
                ? (0, a.jsx)(l.A, { className: "size-3.5", strokeWidth: 2.5 })
                : (0, a.jsx)(i.A, { className: "size-3.5", strokeWidth: 2.5 }),
            ],
          }),
        });
      }
      var N = r(1491);
      function L() {
        let { previous: e, next: t } = v({ hideOnCustomPages: !0 }),
          { previous: r, next: n } = (0, g.n)();
        return null == e && null == t
          ? null
          : (0, a.jsxs)("div", {
              id: x.V.Pagination,
              className: "w-full rounded-2xl flex bg-gray-50/80 dark:bg-white/[0.03] p-1 text-sm",
              children: [
                null != e &&
                  null != t &&
                  (0, a.jsxs)(c(), {
                    href: e.href || "/",
                    className: "group flex items-center justify-between pl-3 pr-6 space-x-1.5",
                    children: [
                      (0, a.jsx)(i.A, {
                        className:
                          "size-3 text-gray-300 dark:text-gray-700 group-hover:text-gray-600 dark:group-hover:text-gray-400",
                        strokeWidth: 3,
                      }),
                      (0, a.jsx)(A, { children: r }),
                    ],
                  }),
                e &&
                  null == t &&
                  (0, a.jsx)(c(), {
                    href: e.href || "/",
                    className: "group w-full",
                    children: (0, a.jsxs)("div", {
                      className:
                        "flex-1 flex items-center justify-start h-16 bg-background-light dark:bg-background-dark hover:ring-1 hover:ring-gray-200 dark:hover:ring-gray-800 rounded-xl",
                      children: [
                        (0, a.jsxs)("div", {
                          className: "flex items-center justify-center pl-3 pr-5 space-x-1.5",
                          children: [
                            (0, a.jsx)(i.A, {
                              className:
                                "size-3 text-gray-300 dark:text-gray-700 group-hover:text-gray-600 dark:group-hover:text-gray-400",
                              strokeWidth: 3,
                            }),
                            (0, a.jsx)(A, { children: r }),
                          ],
                        }),
                        (0, a.jsx)("div", { className: "w-px h-8 bg-gray-100 dark:bg-white/5" }),
                        (0, a.jsxs)("div", {
                          className: "flex flex-col items-start justify-center px-5 min-w-0",
                          children: [
                            (0, a.jsx)("span", {
                              className: "font-semibold text-gray-800 dark:text-gray-200",
                              children: (0, N.f3)(e),
                            }),
                            e.description &&
                              (0, a.jsx)("span", {
                                className:
                                  "text-left text-gray-500 dark:text-gray-400 w-full truncate",
                                children: e.description,
                              }),
                          ],
                        }),
                      ],
                    }),
                  }),
                null != t &&
                  (0, a.jsx)(c(), {
                    href: t.href || "/",
                    className: "group w-full",
                    children: (0, a.jsxs)("div", {
                      className:
                        "flex-1 flex items-center justify-end h-16 bg-background-light dark:bg-background-dark hover:ring-1 hover:ring-gray-200 dark:hover:ring-gray-800 rounded-xl",
                      children: [
                        (0, a.jsxs)("div", {
                          className: "flex flex-col items-end justify-center px-5 min-w-0",
                          children: [
                            (0, a.jsx)("span", {
                              className:
                                "font-semibold text-gray-800 dark:text-gray-200 text-right",
                              children: (0, N.f3)(t),
                            }),
                            t.description &&
                              (0, a.jsx)("span", {
                                className: (0, u.cn)(
                                  "hidden text-right text-gray-500 dark:text-gray-400 lg:block w-full truncate",
                                  null != e ? "lg:w-72" : "lg:w-96",
                                ),
                                children: t.description,
                              }),
                          ],
                        }),
                        (0, a.jsx)("div", { className: "w-px h-8 bg-gray-100 dark:bg-white/5" }),
                        (0, a.jsxs)("div", {
                          className:
                            "pl-5 pr-3 text-gray-600 dark:text-gray-400 flex items-center space-x-1.5",
                          children: [
                            (0, a.jsx)(A, { children: n }),
                            (0, a.jsx)(l.A, {
                              className:
                                "size-3 text-gray-300 dark:text-gray-700 group-hover:text-gray-600 dark:group-hover:text-gray-400",
                              strokeWidth: 3,
                            }),
                          ],
                        }),
                      ],
                    }),
                  }),
              ],
            });
      }
      function A({ children: e }) {
        return (0, a.jsx)("span", {
          className:
            "text-gray-500 dark:text-gray-400 font-medium tracking-tight group-hover:text-gray-900 dark:group-hover:text-gray-100",
          children: e,
        });
      }
      function _() {
        let { previous: e, next: t } = v();
        return e || t
          ? (0, a.jsxs)("div", {
              id: x.V.Pagination,
              className:
                "px-0.5 flex items-center text-sm font-semibold text-gray-700 dark:text-gray-200",
              children: [
                e &&
                  (0, a.jsxs)(c(), {
                    href: e.href || "/",
                    className: "flex items-center space-x-3 group",
                    children: [
                      (0, a.jsx)("svg", {
                        viewBox: "0 0 3 6",
                        className:
                          "h-1.5 stroke-gray-400 overflow-visible group-hover:stroke-gray-600 dark:group-hover:stroke-gray-300",
                        children: (0, a.jsx)("path", {
                          d: "M3 0L0 3L3 6",
                          fill: "none",
                          strokeWidth: "2",
                          strokeLinecap: "round",
                          strokeLinejoin: "round",
                        }),
                      }),
                      (0, a.jsx)("span", {
                        className: "group-hover:text-gray-900 dark:group-hover:text-white",
                        children: (0, N.f3)(e),
                      }),
                    ],
                  }),
                t &&
                  (0, a.jsxs)(c(), {
                    href: t.href || "/",
                    className: "flex items-center ml-auto space-x-3 group",
                    children: [
                      (0, a.jsx)("span", {
                        className: "group-hover:text-gray-900 dark:group-hover:text-white",
                        children: (0, N.f3)(t),
                      }),
                      (0, a.jsx)("svg", {
                        viewBox: "0 0 3 6",
                        className:
                          "rotate-180 h-1.5 stroke-gray-400 overflow-visible group-hover:stroke-gray-600 dark:group-hover:stroke-gray-300",
                        children: (0, a.jsx)("path", {
                          d: "M3 0L0 3L3 6",
                          fill: "none",
                          strokeWidth: "2",
                          strokeLinecap: "round",
                          strokeLinejoin: "round",
                        }),
                      }),
                    ],
                  }),
              ],
            })
          : null;
      }
      function D() {
        let { docsConfig: e } = (0, n.useContext)(s.DocsConfigContext);
        switch (e?.theme) {
          case "mint":
          case "willow":
            return (0, a.jsx)(_, {});
          case "maple":
            return (0, a.jsx)(L, {});
          case "linden":
            return (0, a.jsx)(w, {});
          case "almond":
            return (0, a.jsx)(k, {
              prevClassName: o.x.PaginationPrev,
              nextClassName: o.x.PaginationNext,
              titleClassName: o.x.PaginationTitle,
            });
          default:
            return (0, a.jsx)(k, {});
        }
      }
    },
    32795: (e, t, r) => {
      (r.d(t, {
        Kd: () => a.ContentStack,
        xR: () => n.DiscordCta,
        Xt: () => s.Dropdowns,
        sR: () => o.GitHubCta,
        K2: () => i.LocalizationSelect,
        cI: () => l.ModeToggle,
        m8: () => d.NavBarTransition,
        m4: () => c.m,
        Vs: () => g.TopBar,
        TJ: () => u.TopLevelNavTabsMobile,
        j1: () => x.TopbarDialog,
        t7: () => h.VersionSelect,
        Xh: () => m.X,
      }),
        r(21254));
      var a = r(11383),
        n = r(43119),
        s = r(48358),
        o = r(49201),
        i = r(95159);
      r(96116);
      var l = r(62581);
      r(30921);
      var d = r(86087);
      r(47473);
      var c = r(80963),
        g = r(77548),
        x = r(40972),
        u = r(82326),
        m = r(2492),
        h = r(70656);
    },
    34766: (e, t, r) => {
      r.d(t, { l: () => C });
      var a = r(54568),
        n = r(59676),
        s = r(24560),
        o = r(19664),
        i = r.n(o),
        l = r(7620),
        d = r(59955),
        c = r(81325);
      function g({ ...e }) {
        return (0, a.jsx)(d.tz, { "data-slot": "context-menu", ...e });
      }
      function x({ className: e, ...t }) {
        return (0, a.jsx)(d.Rc, {
          "data-slot": "context-menu-trigger",
          className: (0, c.cn)("select-none", e),
          ...t,
        });
      }
      function u({ className: e, ...t }) {
        return (0, a.jsx)(d.JW, {
          children: (0, a.jsx)(d.Ip, {
            "data-slot": "context-menu-content",
            style: { textRendering: "geometricPrecision" },
            className: (0, c.cn)(
              "origin-[--radix-context-menu-content-transform-origin] shadow-xl dark:shadow-none shadow-gray-500/5 dark:shadow-gray-500/5 bg-background-light dark:bg-background-dark p-1 relative z-50 max-h-96 min-w-36 overflow-y-auto rounded-2xl border-standard",
              "text-gray-950/55 dark:text-white/55 hover:text-gray-950/85 dark:hover:text-white/85 focus:text-gray-950/95 dark:focus:text-white/95",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              e,
            ),
            ...t,
          }),
        });
      }
      let m = [
        "flex items-center font-medium px-2.5 py-2 gap-3 text-sm rounded-xl group/context-menu-item relative w-full cursor-pointer select-none outline-0",
        "hover:bg-background-dark/[0.03] dark:hover:bg-background-light/5 focus:bg-background-dark/[0.03] dark:focus:bg-background-light/5 focus:bg-accent focus:text-accent-foreground",
        "data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[disabled]:opacity-50",
        "text-gray-950/70 dark:text-white/65 hover:text-gray-950/85 dark:hover:text-white/85 focus:text-gray-950/95 dark:focus:text-white/95",
        "data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive",
      ];
      function h({ className: e, inset: t, variant: r = "default", ...n }) {
        return (0, a.jsx)(d.kt, {
          "data-slot": "context-menu-item",
          "data-inset": t,
          "data-variant": r,
          className: (0, c.cn)(...m, e),
          ...n,
        });
      }
      var p = r(30793),
        f = r(71252),
        y = r(68999);
      function b(e) {
        return "string" == typeof e.logo ? "/" : e.logo?.href || "/";
      }
      var v = r(33052);
      function k({ className: e }) {
        let { docsConfig: t } = (0, l.useContext)(p.DocsConfigContext),
          { isLivePreview: r, getDocsConfigOverrides: n } = (0, l.useContext)(f.K),
          s = n(),
          o = r && s?.logo !== void 0 ? s.logo : t?.logo,
          i = r && s?.name !== void 0 ? s.name : t?.name,
          d = "w-auto h-7 relative object-contain shrink-0";
        return o && "object" == typeof o
          ? (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("img", {
                  className: (0, c.cn)(v.x.Logo, d, "block dark:hidden", e),
                  src: o.light,
                  alt: "light logo",
                }),
                (0, a.jsx)("img", {
                  className: (0, c.cn)(v.x.Logo, d, "hidden dark:block", e),
                  src: o.dark,
                  alt: "dark logo",
                }),
              ],
            })
          : "string" == typeof o
            ? (0, a.jsx)("img", { className: (0, c.cn)(v.x.Logo, d, e), src: o, alt: "logo" })
            : i
              ? (0, a.jsx)("div", {
                  className: (0, c.cn)(
                    v.x.Logo,
                    "inline-block text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight dark:text-gray-200",
                    e,
                  ),
                  children: i,
                })
              : (0, a.jsx)(a.Fragment, {});
      }
      async function j(e) {
        try {
          return (await fetch(e, { method: "HEAD" })).ok;
        } catch {
          return !1;
        }
      }
      async function w(e) {
        let t;
        if (e.startsWith("/")) {
          return !0;
        }
        try {
          t = new URL(e);
        } catch {
          return !1;
        }
        return (
          "mintlify.s3.us-west-1.amazonaws.com" !== t.host &&
          ("mintcdn.com" === t.host || "www.mintcdn.com" === t.host || j(e))
        );
      }
      let C = ({ logoClassName: e, linkClassName: t }) => {
        let { docsConfig: r } = (0, l.useContext)(p.DocsConfigContext),
          { isLivePreview: o, getDocsConfigOverrides: d } = (0, l.useContext)(f.K),
          { resolvedTheme: c } = (0, s.D)(),
          m = d(),
          v = (0, l.useMemo)(() => c ?? "light", [c]),
          j = r ? (o && m?.logo ? b(m) : b(r)) : "/",
          C = o && m?.logo !== void 0 ? m.logo : r?.logo,
          N = o && m?.favicon !== void 0 ? m.favicon : r?.favicon,
          L = o && m?.name !== void 0 ? m.name : r?.name,
          A = "string" == typeof N ? N : N?.[v],
          _ = "string" == typeof C ? C : C?.[v];
        async function D(e, t) {
          try {
            let r = document.createElement("a"),
              a = (function (e) {
                try {
                  let t = new URL(e, window.location.origin).pathname.match(/\.([a-zA-Z0-9]+)$/);
                  return t?.[1] ?? "png";
                } catch {
                  return "png";
                }
              })(e),
              s = await fetch(e);
            if (!s.ok) {
              return void window.open(e, "_blank");
            }
            let o = await s.blob(),
              i = URL.createObjectURL(o);
            r.href = i;
            let l = L?.toLowerCase()
              .replace("developer docs", "")
              .replace("developer documentation", "")
              .replace("api reference", "")
              .replace(/\sdocs$/, "")
              .replace(/\sdocumentation$/, "")
              .trim();
            ((r.download = `${l ? `${(0, n.A)(l)}-` : ""}${t}.${a}`),
              document.body.appendChild(r),
              r.click(),
              document.body.removeChild(r),
              URL.revokeObjectURL(i));
          } catch {
            window.open(e, "_blank");
          }
        }
        let [I, T] = (0, l.useState)(!1),
          [M, S] = (0, l.useState)(!1);
        (0, l.useEffect)(() => {
          let e = !1;
          return (
            (async () => {
              let [t, r] = await Promise.all([!!_ && w(_), !!A && w(A)]);
              e || (T(t), S(r));
            })().catch(() => {}),
            () => {
              e = !0;
            }
          );
        }, [_, A]);
        let E = {
            iconType: "regular",
            className:
              "size-4 shrink-0 bg-gray-950/70 dark:bg-white/65 group-hover/context-menu-item:bg-gray-950/85 dark:group-hover/context-menu-item:bg-white/85 group-focus/context-menu-item:bg-gray-950/95 dark:group-focus/context-menu-item:bg-white/95",
            overrideColor: !0,
          },
          z = r?.icons?.library === "lucide";
        return (0, a.jsxs)(g, {
          children: [
            (0, a.jsx)(x, {
              asChild: !0,
              children: (0, a.jsxs)(i(), {
                href: j,
                className: t,
                children: [
                  (0, a.jsxs)("span", { className: "sr-only", children: [L ?? "", " home page"] }),
                  (0, a.jsx)(k, { className: e }),
                ],
              }),
            }),
            (0, a.jsxs)(u, {
              className: "w-56 p-1.5 bg-background-light dark:bg-background-dark",
              children: [
                j &&
                  (0, a.jsx)(a.Fragment, {
                    children: (0, a.jsxs)(h, {
                      onSelect: () => {
                        window.open(j, "_blank");
                      },
                      children: [
                        (0, a.jsx)(y.ComponentIcon, {
                          icon: z ? "square-arrow-out-up-right" : "arrow-up-right-from-square",
                          ...E,
                        }),
                        "Open link in new tab",
                      ],
                    }),
                  }),
                _ &&
                  (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsxs)(h, {
                        onSelect: () => {
                          window.open(_, "_blank");
                        },
                        children: [
                          (0, a.jsx)(y.ComponentIcon, { icon: "image", ...E }),
                          "Open logo in new tab",
                        ],
                      }),
                      I &&
                        (0, a.jsxs)(h, {
                          onSelect: () => {
                            D(_, "logo");
                          },
                          children: [
                            (0, a.jsx)(y.ComponentIcon, { icon: "download", ...E }),
                            "Download logo",
                          ],
                        }),
                    ],
                  }),
                A &&
                  M &&
                  (0, a.jsx)(a.Fragment, {
                    children: (0, a.jsxs)(h, {
                      onSelect: () => {
                        D(A, "favicon");
                      },
                      children: [
                        (0, a.jsx)(y.ComponentIcon, { icon: "download", ...E }),
                        "Download favicon",
                      ],
                    }),
                  }),
              ],
            }),
          ],
        });
      };
    },
    39692: (e, t, r) => {
      r.d(t, { V: () => f });
      var a = r(54568),
        n = r(77373),
        s = r(7620),
        o = r(31722),
        i = r(76829),
        l = r(65477),
        d = r(90723),
        c = r(35878),
        g = r(33052),
        x = r(81325),
        u = r(82075);
      function m({ disabled: e, onClick: t, size: r = "md", className: n }) {
        let s = (0, i.n)();
        return (0, a.jsx)("button", {
          className: (0, x.cn)(
            g.x.ChatAssistantSendButton,
            "flex justify-center items-center rounded-full",
            "sm" === r ? "p-1 size-6" : "p-1 size-7",
            e ? "bg-primary/30 dark:bg-primary-dark/30" : "bg-primary dark:bg-primary-dark",
            n,
          ),
          "aria-label": s["aria.sendMessage"],
          disabled: e,
          onClick: t,
          children: (0, a.jsx)(u.A, {
            className: (0, x.cn)("text-white dark:text-white", "sm" === r ? "size-3.5" : "size-5"),
          }),
        });
      }
      let h = (0, x.cn)(
          "flex flex-col w-full rounded-2xl pointer-events-auto",
          "bg-background-light/90 dark:bg-background-dark/90 backdrop-blur-xl",
          "border border-gray-200 dark:border-white/30",
          "focus-within:border-primary dark:focus-within:border-primary-light",
          "transition-colors",
        ),
        p = (0, x.cn)(
          g.x.ChatAssistantInput,
          "w-full bg-transparent border-0 peer/input",
          "text-gray-900 dark:text-gray-100",
          "placeholder-gray-500 dark:placeholder-gray-400",
          "!outline-none focus:!outline-none focus:ring-0",
          "py-2.5 pl-3.5 pr-10",
          "font-bodyWeight",
        ),
        f = (0, s.forwardRef)(function (
          {
            variant: e,
            onBeforeSubmit: t,
            onSubmit: r,
            onDeleteEmpty: g,
            showKeyboardHint: u,
            actionKey: f = "⌘",
            readOnly: y = !1,
            isMobile: b = !1,
            floating: v = !1,
            minRows: k = 2,
            headerContent: j,
            className: w,
            inputClassName: C,
            inputId: N,
          },
          L,
        ) {
          let {
              input: A,
              setInput: _,
              handleSubmit: D,
              isInProgress: I,
              isFeatureUnavailable: T,
            } = (0, l.w)(),
            { selectedLocale: M } = (0, s.useContext)(i.NavigationContext),
            { askAQuestion: S } = (0, i.n)(),
            E = I || T.unavailable,
            z = "" === A.trim() || E,
            F = () => {
              "" === A.trim() || E || (t?.(A), D(), r?.(A));
            },
            V = (t) => {
              ("Enter" === t.key &&
                !t.nativeEvent.isComposing &&
                ((("bar" !== e || "ja" === M || "jp" === M || "ja-jp" === M) &&
                  ("panel" !== e || t.shiftKey)) ||
                  (t.preventDefault(), F())),
                "Backspace" === t.key && "" === A && g && g());
            };
          return (0, a.jsxs)("div", {
            onClick: (e) => {
              if (L && "object" == typeof L && "current" in L) {
                let t = L.current;
                e.target === e.currentTarget && document.activeElement !== t && t?.focus();
              }
            },
            className: (0, x.cn)(
              h,
              v && "sm:shadow-xl",
              T.unavailable && "opacity-50 cursor-not-allowed",
              y && "cursor-pointer",
              w,
            ),
            children: [
              j,
              (0, a.jsxs)("div", {
                className: "relative flex items-end",
                children: [
                  "bar" === e
                    ? (0, a.jsx)("input", {
                        ref: L,
                        type: "text",
                        id: N,
                        placeholder: S,
                        "aria-label": S,
                        className: (0, x.cn)(
                          p,
                          b ? "text-base" : "text-sm",
                          y && "pointer-events-none",
                          C,
                        ),
                        value: A,
                        onChange: (e) => _(e.target.value),
                        onKeyDown: V,
                        disabled: E,
                        readOnly: y,
                      })
                    : (0, a.jsx)(o.A, {
                        ref: L,
                        id: N ?? c.V.ChatAssistantTextArea,
                        "aria-label": S,
                        autoComplete: "off",
                        placeholder: S,
                        value: A,
                        onChange: (e) => _(e.target.value),
                        cacheMeasurements: !1,
                        minRows: k,
                        maxRows: 10,
                        disabled: T.unavailable,
                        className: (0, x.cn)(p, b ? "text-base" : "text-sm", C),
                        onKeyDown: V,
                        style: { resize: "none", fontSize: b ? "16px" : void 0 },
                      }),
                  u &&
                    (0, a.jsxs)("span", {
                      className: (0, x.cn)(
                        "absolute right-11 bottom-3 text-xs font-medium text-gray-400 dark:text-gray-500",
                        "select-none pointer-events-none peer-focus/input:hidden",
                        "hidden sm:inline",
                      ),
                      children: [f, "⌘" === f ? "" : "+", "I"],
                    }),
                  I
                    ? (0, a.jsx)(a.Fragment, {
                        children: (0, a.jsx)("button", {
                          type: "button",
                          onClick: () => d.A.getState().activeStop?.(),
                          className: (0, x.cn)(
                            "absolute right-2.5 bottom-2 flex justify-center items-center rounded-full",
                            b ? "p-1 size-7" : "p-1 size-6",
                            "bg-primary dark:bg-primary-dark",
                          ),
                          "aria-label": "Stop generating",
                          children: (0, a.jsx)(n.A, {
                            className: (0, x.cn)(
                              "text-white dark:text-white fill-current",
                              b ? "size-3" : "size-2.5",
                            ),
                          }),
                        }),
                      })
                    : (0, a.jsx)(m, {
                        disabled: z,
                        onClick: F,
                        size: b ? "md" : "sm",
                        className: "absolute right-2.5 bottom-2",
                      }),
                ],
              }),
            ],
          });
        });
    },
    40588: (e, t, r) => {
      r.d(t, { c: () => x });
      var a = r(54568),
        n = r(64429),
        s = r(7620),
        o = r(67908),
        i = r(76829),
        l = r(35878),
        d = r(73205),
        c = r(81325),
        g = r(97263);
      let x = () => {
          let { navIsOpen: e, setNavIsOpen: t } = (0, s.useContext)(i.NavigationContext);
          return (0, a.jsxs)(n.lG, {
            open: e,
            onClose: () => t(!1),
            className: (0, c.cn)(o.f.Popup, "fixed inset-0 overflow-y-auto lg:hidden"),
            children: [
              (0, a.jsx)(n.Xi, {
                transition: !0,
                className:
                  "fixed inset-0 bg-black/20 dark:bg-background-dark/80 backdrop-blur-sm transition-opacity duration-300 ease-out data-[closed]:opacity-0",
              }),
              (0, a.jsxs)("div", {
                className: "fixed inset-0 flex",
                children: [
                  e && (0, a.jsx)(u, {}),
                  (0, a.jsx)(n.Lj, {
                    id: l.V.MobileNav,
                    transition: !0,
                    className:
                      "flex flex-col relative bg-background-light w-[85dvw] min-w-[19rem] max-w-[22rem] min-h-full dark:bg-background-dark transition-transform duration-100 ease-in-out data-[closed]:-translate-x-full",
                    children: (0, a.jsx)("div", {
                      className: "flex flex-col flex-1 px-4 pt-4 pb-12 overflow-y-auto h-full",
                      children: (0, a.jsx)(g.f, { mobile: !0 }),
                    }),
                  }),
                ],
              }),
            ],
          });
        },
        u = () => {
          let { setNavIsOpen: e } = (0, s.useContext)(i.NavigationContext);
          return (0, a.jsxs)("button", {
            type: "button",
            onClick: () => e(!1),
            className: (0, c.cn)(
              o.f.Control,
              "absolute bg-background-light dark:bg-background-dark rounded-full top-4 right-4 w-8 h-8 flex items-center justify-center fill-gray-500 hover:fill-gray-600 dark:fill-gray-400 dark:hover:fill-gray-300",
            ),
            children: [
              (0, a.jsx)("span", { className: "sr-only", children: "Close navigation" }),
              (0, a.jsx)(d.Y3, {}),
            ],
          });
        };
    },
    40972: (e, t, r) => {
      r.d(t, { TopbarDialog: () => c });
      var a = r(54568),
        n = r(15146),
        s = r(64429),
        o = r(7620),
        i = r(67908),
        l = r(81325);
      function d() {
        return (0, a.jsx)("svg", {
          viewBox: "0 0 10 10",
          className: "w-2.5 h-2.5 overflow-visible",
          "aria-hidden": "true",
          children: (0, a.jsx)("path", {
            d: "M0 0L10 10M10 0L0 10",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: "2",
            strokeLinecap: "round",
          }),
        });
      }
      let c = ({ topbarDialogOpen: e, setTopbarDialogOpen: t, children: r }) =>
        (0, a.jsx)(n.e, {
          show: e,
          as: o.Fragment,
          afterLeave: () => {
            t(!1);
          },
          appear: !0,
          children: (0, a.jsxs)(s.lG, {
            as: "div",
            open: e,
            onClose: () => t(!1),
            className: (0, l.cn)(i.f.Popup, "fixed inset-0 overflow-y-auto lg:hidden"),
            children: [
              (0, a.jsx)(s.Xi, {
                className: "fixed inset-0 bg-gray-500/25 transition-opacity backdrop-blur-sm",
              }),
              (0, a.jsx)(n._, {
                as: o.Fragment,
                enter: "ease-out duration-300",
                enterFrom: "opacity-0",
                enterTo: "opacity-100",
                leave: "ease-in duration-200",
                leaveFrom: "opacity-100",
                leaveTo: "opacity-0",
                children: (0, a.jsxs)(s.Lj, {
                  className:
                    "relative float-right bg-white w-[16rem] rounded-md m-2 py-7 px-8 dark:bg-background-dark",
                  children: [
                    (0, a.jsxs)("button", {
                      type: "button",
                      onClick: () => t(!1),
                      className: (0, l.cn)(
                        i.f.Control,
                        "absolute top-5 right-5 w-8 h-8 flex items-center justify-center fill-gray-500 hover:fill-gray-600 dark:fill-gray-400 dark:hover:fill-gray-300",
                      ),
                      children: [
                        (0, a.jsx)("span", { className: "sr-only", children: "Close" }),
                        (0, a.jsx)(d, {}),
                      ],
                    }),
                    (0, a.jsx)("nav", {
                      className: "text-sm",
                      children: (0, a.jsx)("ul", {
                        className: "items-center space-y-4",
                        children: r,
                      }),
                    }),
                  ],
                }),
              }),
            ],
          }),
        });
    },
    43119: (e, t, r) => {
      r.d(t, { DiscordCta: () => c });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        o = r(22153),
        i = r(33052),
        l = r(81325),
        d = r(73205);
      function c({ className: e, href: t, label: c, actionClassName: g }) {
        let { docsConfig: x } = (0, n.useContext)(s.DocsConfigContext),
          u = (0, o.p)("docs.navitem.cta_click"),
          m = (0, o.p)("docs.navitem.click"),
          [h, p] = (0, n.useState)(),
          f = x?.navbar?.primary,
          y = !t,
          b = t ?? (f?.type === "discord" ? f.href : void 0),
          v = c ?? (y && f?.type === "discord" ? f.label : void 0),
          k = (0, n.useMemo)(() => {
            if (!b) {
              return null;
            }
            try {
              let e = new URL(b),
                t = e.pathname;
              if ("discord.gg" === e.hostname) {
                return t.slice(1) || null;
              }
              if ("discord.com" === e.hostname || "www.discord.com" === e.hostname) {
                let e = t.split("/").filter(Boolean);
                if ("invite" === e[0] && e[1]) {
                  return e[1];
                }
              }
              return null;
            } catch {
              return null;
            }
          }, [b]),
          j = (0, n.useCallback)(async () => {
            if (null == k) {
              return;
            }
            let e = await r
                .e(29220)
                .then(r.bind(r, 29220))
                .then((e) => e.default),
              { data: t } = await e.get(
                `https://discord.com/api/v10/invites/${k}?with_counts=true`,
              );
            t.guild?.name &&
              "number" == typeof t.approximate_presence_count &&
              p({ presence_count: t.approximate_presence_count, name: t.guild.name });
          }, [k]);
        if (
          ((0, n.useEffect)(() => {
            j().catch(console.error);
          }, [j]),
          null == k || !b)
        ) {
          return null;
        }
        let w = v || h?.name || "Discord",
          C = !!g,
          N = () => {
            C ? m({ name: w, url: b }) : u({ url: b, type: "discord" });
          },
          L =
            h &&
            (0, a.jsxs)(a.Fragment, {
              children: [
                (0, a.jsx)("div", {
                  className: "flex items-center justify-center size-3",
                  children: (0, a.jsx)("div", { className: "size-1.5 bg-green-500 rounded-full" }),
                }),
                (0, a.jsxs)("span", { children: [h.presence_count.toLocaleString(), " online"] }),
              ],
            });
        return C
          ? (0, a.jsx)("li", {
              className: (0, l.cn)(i.x.NavBarLink, "max-w-full", e),
              children: (0, a.jsxs)("a", {
                href: b,
                target: "_blank",
                rel: "noreferrer",
                onClick: N,
                title: w,
                className: (0, l.cn)(g, "group min-w-0"),
                children: [
                  (0, a.jsx)(d.EI, { className: "size-4 shrink-0" }),
                  (0, a.jsx)("span", { className: "truncate", children: w }),
                  h &&
                    (0, a.jsx)("span", {
                      className: "flex items-center gap-1.5 ml-1 shrink-0",
                      children: L,
                    }),
                ],
              }),
            })
          : (0, a.jsx)("li", {
              className: (0, l.cn)("cursor-pointer max-w-full", e),
              children: (0, a.jsx)("a", {
                href: b,
                target: "_blank",
                rel: "noreferrer",
                onClick: N,
                title: w,
                className:
                  "group flex items-center rounded-md hover:text-primary dark:hover:text-primary-light min-w-0",
                children: (0, a.jsxs)("div", {
                  className: "flex items-center gap-1.5 h-8 min-w-0",
                  children: [
                    (0, a.jsxs)("div", {
                      className: "flex items-center gap-2 min-w-0",
                      children: [
                        (0, a.jsx)(d.EI, { className: "size-4 shrink-0" }),
                        (0, a.jsx)("span", {
                          className:
                            "text-sm font-medium text-gray-700 dark:text-gray-300 group-hover:text-primary dark:group-hover:text-primary-light truncate",
                          children: w,
                        }),
                      ],
                    }),
                    h &&
                      (0, a.jsx)("div", {
                        className: "flex items-center gap-1.5 ml-1 shrink-0",
                        children: L,
                      }),
                  ],
                }),
              }),
            });
      }
    },
    47473: (e, t, r) => {
      r.d(t, { d: () => a.Pagination });
      var a = r(32397);
    },
    48358: (e, t, r) => {
      r.d(t, { Dropdowns: () => p });
      var a = r(54568),
        n = r(6438),
        s = r(7620),
        o = r(41574),
        i = r(6472),
        l = r(79634),
        d = r(76829),
        c = r(33052),
        g = r(68999),
        x = r(73205),
        u = r(81325);
      let m = "solid";
      function h({ dropdown: e, isActive: t }) {
        let r = e.color;
        return (0, a.jsxs)(a.Fragment, {
          children: [
            (0, a.jsx)("div", {
              className: (0, u.cn)(
                c.x.DropdownItemIcon,
                "h-8 w-8 flex items-center justify-center rounded-lg flex-shrink-0 border border-gray-200/70 dark:border-white/[0.07]",
              ),
              children: (0, a.jsx)(g.ComponentIcon, {
                icon: "string" == typeof e.icon ? e.icon : (e.icon?.name ?? "layers"),
                iconType: "string" == typeof e.icon ? m : e.icon?.style || m,
                className: "h-4 w-4 bg-primary dark:bg-primary-light",
                color: r?.light ?? r?.dark,
                overrideColor: !0,
              }),
            }),
            (0, a.jsxs)("div", {
              className: (0, u.cn)(
                c.x.DropdownItemTextContainer,
                "flex-1 px-1 flex flex-col grow text-left",
              ),
              children: [
                (0, a.jsx)("p", {
                  className: (0, u.cn)(
                    c.x.DropdownItemTitle,
                    "text-base lg:text-sm font-medium",
                    t ? "text-primary dark:text-primary-light" : "text-gray-800 dark:text-gray-300",
                  ),
                  children: e.dropdown,
                }),
                e.description &&
                  (0, a.jsx)("p", {
                    className: (0, u.cn)(
                      c.x.DropdownItemDescription,
                      "hidden lg:block text-sm lg:text-xs text-gray-600 dark:text-gray-400",
                    ),
                    title: e.description,
                    children: e.description,
                  }),
              ],
            }),
            t &&
              (0, a.jsx)(n.A, { className: "ml-2 h-4 w-4 text-primary dark:text-primary-light" }),
          ],
        });
      }
      let p = ({ triggerClassName: e }) => {
        let [t, r] = (0, s.useState)(!1),
          { divisions: n } = (0, s.useContext)(d.NavigationContext),
          g = n.dropdowns,
          m = g.find((e) => e.isActive) ?? g[0],
          p = (0, o.Ub)("(max-width: 1024px)");
        return 0 !== g.length && m
          ? (0, a.jsxs)(i.DropdownMenu, {
              open: t,
              onOpenChange: r,
              children: [
                (0, a.jsxs)(i.DropdownMenuTrigger, {
                  className: (0, u.cn)(
                    c.x.DropdownTrigger,
                    "mb-4 z-10 group flex w-full items-center pl-2 pr-3.5 py-1.5 rounded-[0.85rem] border border-gray-200/70 dark:border-white/[0.07] hover:bg-gray-600/5 dark:hover:bg-gray-200/5 gap-1",
                    e,
                  ),
                  children: [
                    (0, a.jsx)(h, { dropdown: m, isActive: !1 }),
                    (0, a.jsx)(x.DropdownArrowIcon, {
                      className: (0, u.cn)("rotate-90", t && "rotate-[270deg]"),
                    }),
                  ],
                }),
                (0, a.jsx)(i.DropdownMenuContent, {
                  className: (0, u.cn)(c.x.DropdownContent, "p-1 gap-2"),
                  align: "start",
                  style: { width: p ? "var(--radix-dropdown-menu-trigger-width)" : "100%" },
                  children: g.map((e) =>
                    (0, a.jsx)(
                      l.DynamicLink,
                      {
                        href: e.href,
                        className: (0, u.cn)(
                          c.x.DropdownItem,
                          "rounded-xl text-gray-800 hover:text-gray-900 px-1.5 pr-2.5 py-1.5 dark:text-gray-300 dark:hover:text-gray-200 flex group items-center gap-1 hover:bg-gray-950/5 dark:hover:bg-white/5",
                        ),
                        onClick: () => r(!1),
                        "data-dropdown-item": e.dropdown,
                        children: (0, a.jsx)(h, { dropdown: e, isActive: e.isActive }),
                      },
                      e.name + e.href,
                    ),
                  ),
                }),
              ],
            })
          : null;
      };
    },
    49201: (e, t, r) => {
      r.d(t, { GitHubCta: () => u });
      var a = r(54568),
        n = r(34668),
        s = r.n(n),
        o = r(7620),
        i = r(30793),
        l = r(22153),
        d = r(33052),
        c = r(81325),
        g = r(68999),
        x = r(73205);
      function u({ className: e, href: t, label: n, actionClassName: u }) {
        let { docsConfig: m } = (0, o.useContext)(i.DocsConfigContext),
          h = (0, l.p)("docs.navitem.cta_click"),
          p = (0, l.p)("docs.navitem.click"),
          [f, y] = (0, o.useState)(),
          b = m?.navbar?.primary,
          v = !t,
          k = t ?? (b?.type === "github" ? b.href : void 0),
          j = n ?? (v && b?.type === "github" ? b.label : void 0),
          w = (0, o.useMemo)(() => (k ? s()(k) : null), [k]),
          C = (0, o.useCallback)(async () => {
            if (null == w) {
              return;
            }
            let e = await r
                .e(29220)
                .then(r.bind(r, 29220))
                .then((e) => e.default),
              { data: t } = await e.get(`https://api.github.com/repos/${w.user}/${w.repo}`);
            "number" == typeof t.stargazers_count && y(t);
          }, [w]);
        if (
          ((0, o.useEffect)(() => {
            C().catch(console.error);
          }, [C]),
          null == w || !k)
        ) {
          return null;
        }
        let N = j || `${w.user}/${w.repo}`,
          L = !!u,
          A = () => {
            L ? p({ name: N, url: k }) : h({ url: k, type: "github" });
          };
        return L
          ? (0, a.jsx)("li", {
              className: (0, c.cn)(d.x.NavBarLink, "max-w-full", e),
              children: (0, a.jsxs)("a", {
                href: k,
                target: "_blank",
                rel: "noreferrer",
                onClick: A,
                title: N,
                className: (0, c.cn)(u, "group min-w-0"),
                children: [
                  (0, a.jsx)(x.Nb, { className: "size-4 shrink-0" }),
                  (0, a.jsx)("span", { className: "truncate", children: N }),
                  f &&
                    (0, a.jsxs)("span", {
                      className: "flex items-center gap-1.5 ml-1 shrink-0",
                      children: [
                        (0, a.jsx)(g.A, {
                          className: "size-3.5",
                          icon: "star",
                          iconType: "regular",
                          color: "currentColor",
                        }),
                        (0, a.jsx)("span", { children: f.stargazers_count.toLocaleString() }),
                      ],
                    }),
                ],
              }),
            })
          : (0, a.jsx)("li", {
              className: (0, c.cn)("cursor-pointer max-w-full", e),
              children: (0, a.jsx)("a", {
                href: k,
                target: "_blank",
                rel: "noreferrer",
                onClick: A,
                title: N,
                className:
                  "group flex items-center rounded-md hover:text-primary dark:hover:text-primary-light min-w-0",
                children: (0, a.jsxs)("div", {
                  className: "flex items-center gap-1.5 h-8 min-w-0",
                  children: [
                    (0, a.jsxs)("div", {
                      className: "flex items-center gap-2 min-w-0",
                      children: [
                        (0, a.jsx)(x.Nb, { className: "size-4 shrink-0" }),
                        (0, a.jsx)("span", {
                          className:
                            "text-sm font-medium text-gray-700 dark:text-gray-300 group-hover:text-primary dark:group-hover:text-primary-light truncate",
                          children: N,
                        }),
                      ],
                    }),
                    f &&
                      (0, a.jsxs)("div", {
                        className: "flex items-center gap-1.5 ml-1 shrink-0",
                        children: [
                          (0, a.jsx)(g.A, {
                            className: "size-3.5",
                            icon: "star",
                            iconType: "regular",
                            color: "currentColor",
                          }),
                          (0, a.jsx)("span", {
                            className: "text-sm",
                            children: f.stargazers_count.toLocaleString(),
                          }),
                        ],
                      }),
                  ],
                }),
              }),
            });
      }
    },
    50864: (e, t, r) => {
      r.d(t, { j: () => h });
      var a = r(54568),
        n = r(19664),
        s = r.n(n),
        o = r(7620),
        i = r(67908),
        l = r(30793),
        d = r(22153),
        c = r(35878),
        g = r(32795),
        x = r(81325),
        u = r(73205);
      let m = {
        default: {
          link: "group px-4 py-1.5 relative inline-flex items-center text-sm font-medium",
          container: "mr-0.5 space-x-2.5 flex items-center",
          background: "absolute inset-0 bg-primary-dark rounded-xl group-hover:opacity-[0.9]",
          textClass: "text-white",
          arrow: "text-white/90",
        },
        linden: {
          link: "group text-primary dark:text-primary-light hover:text-primary-dark dark:hover:text-primary border border-current rounded-lg pl-3 pr-1.5 py-1.5 relative inline-flex items-center text-sm font-semibold",
          container: "flex items-center",
          arrow: "h-6 w-6",
        },
        palm: {
          link: "group py-1.5 relative inline-flex items-center text-sm font-medium",
          container:
            "mr-0.5 flex items-center text-primary dark:text-primary-light hover:text-primary-dark dark:hover:text-primary-light font-medium",
          arrow: "size-6 opacity-90",
        },
        willow: {
          link: "group py-1.5 relative inline-flex items-center text-sm font-medium",
          container:
            "space-x-2.5 flex items-center text-gray-950/90 dark:text-white/90 hover:text-gray-950 dark:hover:text-white",
          arrow: "text-current",
        },
        almond: {
          link: "group bg-primary-dark hover:opacity-[0.9] rounded-lg px-2.5 py-1.5 relative inline-flex items-center text-sm font-semibold",
          container: "flex items-center gap-2",
          textClass: "text-white",
          arrow: "hidden",
        },
      };
      function h() {
        let { docsConfig: e } = (0, o.useContext)(l.DocsConfigContext),
          t = (0, d.p)("docs.navitem.cta_click"),
          r = e?.navbar?.primary,
          n = m[e?.theme ?? "mint"] ?? m.default;
        return r
          ? "github" === r.type
            ? (0, a.jsx)(g.sR, { className: "hidden lg:flex" })
            : "discord" === r.type
              ? (0, a.jsx)(g.xR, { className: "hidden lg:flex" })
              : r.href && r.label
                ? (0, a.jsx)("li", {
                    className: "whitespace-nowrap hidden lg:flex",
                    id: c.V.TopbarCtaButton,
                    children: (0, a.jsxs)(s(), {
                      href: r.href,
                      target: "_blank",
                      className: n.link,
                      onClick: () => t({ name: r.label, url: r.href, type: "button" }),
                      children: [
                        n.background && (0, a.jsx)("span", { className: n.background }),
                        (0, a.jsxs)("div", {
                          className: n.container,
                          children: [
                            (0, a.jsx)("span", {
                              className: (0, x.cn)(i.f.Control, n.textClass),
                              children: r.label,
                            }),
                            (0, a.jsx)(u.fl, { className: n.arrow }),
                          ],
                        }),
                      ],
                    }),
                  })
                : null
          : null;
      }
    },
    53016: (e, t, r) => {
      r.d(t, { W: () => g });
      var a = r(27277),
        n = r(27541),
        s = r(7620),
        o = r(98167),
        i = r(28838),
        l = r(71826),
        d = r(43967),
        c = r(47922);
      function g() {
        let e = (0, n.useRouter)();
        return {
          logout: (0, s.useCallback)(
            ({ redirectOverride: t } = {}) => {
              try {
                (a.A.remove(l.Jm),
                  a.A.remove(l.EO),
                  a.A.remove(d.zC),
                  localStorage.removeItem(i.O),
                  localStorage.removeItem(c._T));
                let r = new URL(window.location.href);
                r.pathname = `${o.c.BASE_PATH}/logout`;
                let n = t ?? `${o.c.BASE_PATH}/`;
                ((r.search = `?redirect=${encodeURIComponent(n)}`), e.push(r.toString()));
              } catch (e) {
                (console.error("Error during logout:", e), (window.location.href = "/logout"));
              }
            },
            [e],
          ),
        };
      }
    },
    55030: (e, t, r) => {
      r.d(t, { O: () => n });
      var a = r(7620);
      function n(e = 50) {
        let [t, r] = (0, a.useState)(!1);
        return (
          (0, a.useEffect)(() => {
            function a() {
              !t && window.scrollY > e ? r(!0) : t && window.scrollY <= e && r(!1);
            }
            return (
              a(),
              window.addEventListener("scroll", a, { passive: !0 }),
              () => {
                window.removeEventListener("scroll", a);
              }
            );
          }, [t, e]),
          t
        );
      }
    },
    60284: (e, t, r) => {
      r.d(t, { u: () => a });
      let a = (e) => ("willow" === e || "maple" === e ? "" : "space-y-px");
    },
    62581: (e, t, r) => {
      r.d(t, { ModeToggle: () => g });
      var a = r(54568),
        n = r(51115),
        s = r(24560),
        o = r(7620),
        i = r(30793),
        l = r(76829),
        d = r(73205),
        c = r(81325);
      function g({ sunIconClassName: e, moonIconClassName: t, backgroundClassName: r }) {
        let { docsConfig: g } = (0, o.useContext)(i.DocsConfigContext),
          { resolvedTheme: x, setTheme: u } = (0, s.D)(),
          m = (0, l.n)();
        return g?.appearance?.strict === !0
          ? null
          : (0, a.jsxs)("button", {
              onClick: () => void u("dark" === x ? "light" : "dark"),
              className: (0, c.cn)("group p-2 flex items-center justify-center", r),
              "aria-label": m["aria.toggleDarkMode"],
              children: [
                (0, a.jsx)(d.gL, {
                  className: (0, c.cn)(
                    "h-4 w-4 block text-gray-400 dark:hidden group-hover:text-gray-600",
                    e,
                  ),
                }),
                (0, a.jsx)(n.A, {
                  className: (0, c.cn)(
                    "h-4 w-4 hidden dark:block text-gray-500 dark:group-hover:text-gray-300",
                    t,
                  ),
                }),
              ],
            });
      }
    },
    66818: (e, t, r) => {
      r.d(t, { g: () => h });
      var a = r(54568),
        n = r(7620),
        s = r(6472),
        o = r(67908),
        i = r(23752),
        l = r(39282),
        d = r(35878),
        c = r(33052),
        g = r(81325),
        x = r(68999),
        u = r(73205);
      let m = "regular",
        h = ({ className: e, mobile: t = !1 }) => {
          let [{ multiViewItems: r }, h] = (0, l.O)(),
            { setPreferredCodeLanguage: p } = (0, n.useContext)(i.O),
            [f, y] = (0, n.useState)(!1),
            b = r.find((e) => e.active);
          return 0 === r.length
            ? null
            : (0, a.jsx)("div", {
                id: d.V.MultiViewDropdown,
                className: (0, g.cn)(
                  c.x.MultiViewDropdown,
                  "w-[14rem] max-w-full",
                  o.f.SecondaryNav,
                  e,
                  t && "mt-8 xl:mt-0 xl:hidden -mb-4 sm:ml-auto",
                ),
                children: (0, a.jsxs)(s.DropdownMenu, {
                  open: f,
                  onOpenChange: y,
                  children: [
                    (0, a.jsxs)(s.DropdownMenuTrigger, {
                      className: (0, g.cn)(
                        c.x.MultiViewDropdownTrigger,
                        "z-10 group flex w-full items-center justify-start pl-1.5 pr-3 py-1.5 rounded-xl gap-1 border border-gray-200 dark:border-white/[0.07] hover:bg-gray-600/5 dark:hover:bg-gray-200/5",
                      ),
                      children: [
                        !!b?.icon &&
                          (0, a.jsx)("div", {
                            className:
                              "flex items-center justify-center shrink-0 size-[26px] border border-gray-200 dark:border-white/[0.07] rounded-md",
                            children: (0, a.jsx)(x.ComponentIcon, {
                              icon: b.icon || "",
                              iconType: b.iconType || m,
                              className: "size-3.5 shrink-0",
                            }),
                          }),
                        (0, a.jsx)("span", {
                          className:
                            "text-sm font-medium text-gray-900 dark:text-gray-200 leading-[20px] tracking-[-0.1px] px-1 truncate",
                          children: b?.title,
                        }),
                        (0, a.jsx)(u.DropdownArrowIcon, {
                          className:
                            "shrink-0 rotate-90 group-data-[state=open]:rotate-[270deg] ml-auto",
                        }),
                      ],
                    }),
                    (0, a.jsx)(s.DropdownMenuContent, {
                      className: (0, g.cn)(
                        c.x.MultiViewDropdownContent,
                        "p-1 gap-1 w-[var(--radix-dropdown-menu-trigger-width)] rounded-xl",
                      ),
                      align: "start",
                      sideOffset: 4,
                      avoidCollisions: !1,
                      children: r.map((e) =>
                        (0, a.jsxs)(
                          s._,
                          {
                            className: (0, g.cn)(
                              c.x.MultiViewDropdownItem,
                              "flex items-center justify-start gap-2 rounded-lg text-gray-900 dark:text-gray-200 px-2.5 py-2 cursor-pointer hover:bg-gray-950/5 dark:bg-transparent focus-within:bg-gray-950/5 dark:focus-within:bg-white/5",
                            ),
                            onClick: () =>
                              ((e) => {
                                let t = r.find((t) => t.title === e);
                                t &&
                                  (h({ type: "toggle_multi_view_change", payload: t }),
                                  p?.(e),
                                  y(!1));
                              })(e.title),
                            isSelected: b?.title === e.title,
                            children: [
                              !!e.icon &&
                                (0, a.jsx)(x.ComponentIcon, {
                                  icon: e.icon,
                                  iconType: e.iconType || m,
                                  className: "size-4 shrink-0",
                                }),
                              (0, a.jsx)("span", {
                                className:
                                  "text-sm font-medium text-gray-900 dark:text-gray-200 truncate mr-auto",
                                children: e.title,
                              }),
                            ],
                          },
                          e.title,
                        ),
                      ),
                    }),
                  ],
                }),
              });
        };
    },
    68367: (e, t, r) => {
      r.d(t, { F: () => m, LoginButtonProvider: () => h });
      var a = r(54568),
        n = r(19664),
        s = r.n(n),
        o = r(7620),
        i = r(27194),
        l = r(53016),
        d = r(9537),
        c = r(56991),
        g = r(33052),
        x = r(81325),
        u = r(30793);
      let m = (0, o.createContext)({
        authLoginButton: null,
        userAuthLoginButton: null,
        authLogoutButton: null,
        userAuthLogoutButton: null,
      });
      function h({ children: e }) {
        let { docsConfig: t } = (0, o.useContext)(u.DocsConfigContext),
          {
            userInfo: r,
            userAuth: n,
            auth: h,
            isFetchingUserInfo: p,
          } = (0, o.useContext)(u.AuthContext),
          { logout: f } = (0, l.W)(),
          y = (0, i.G)(),
          b =
            t?.theme === "aspen"
              ? "flex items-center gap-2 whitespace-nowrap font-medium text-gray-800 dark:text-gray-50 bg-gray-950/[0.03] dark:bg-white/[0.03] hover:bg-gray-950/10 dark:hover:bg-white/10 rounded-xl px-[14px] py-2"
              : "flex items-center gap-1.5 whitespace-nowrap font-medium text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
          v = (0, o.useMemo)(() => {
            if (p || r || !n) {
              return null;
            }
            switch (n.type) {
              case "jwt":
                return (0, a.jsx)(s(), {
                  href: n.loginUrl,
                  className: (0, x.cn)(b, g.x.LoginLink),
                  children: "Log In",
                });
              case "shared-session":
                if (!n.loginUrl) {
                  return null;
                }
                return (0, a.jsx)(s(), {
                  href: n.loginUrl,
                  className: (0, x.cn)(b, g.x.LoginLink),
                  children: "Log In",
                });
              case "oauth":
                return (0, a.jsx)("button", {
                  onClick: () => (0, d.A)(n),
                  className: (0, x.cn)(b, g.x.LoginLink),
                  children: "Log In",
                });
            }
          }, [b, p, n, r]),
          k = (0, o.useMemo)(() => {
            if (r || !h || !1 !== p) {
              return null;
            }
            let e = `/login?redirect=${y}`.replace(/\/{2,}/g, "/");
            return (0, a.jsx)(s(), {
              href: e,
              className: (0, x.cn)(b, g.x.LoginLink),
              children: "Log In",
            });
          }, [y, b, h, r, p]),
          j = (0, o.useMemo)(
            () =>
              r && h
                ? (0, a.jsx)("button", {
                    onClick: () => f({ redirectOverride: h.logoutUrl }),
                    className: (0, x.cn)(b, g.x.LogoutLink),
                    children: "Log Out",
                  })
                : null,
            [r, h, f, b],
          ),
          w = (0, o.useMemo)(
            () =>
              r && n
                ? (0, a.jsx)("button", {
                    onClick: () => {
                      try {
                        localStorage.removeItem(c.$A);
                      } catch {}
                      window.location.reload();
                    },
                    className: (0, x.cn)(b, g.x.LogoutLink),
                    children: "Log Out",
                  })
                : null,
            [r, n, b],
          );
        return (0, a.jsx)(m.Provider, {
          value: {
            userAuthLoginButton: v,
            authLoginButton: k,
            authLogoutButton: j,
            userAuthLogoutButton: w,
          },
          children: e,
        });
      }
    },
    70656: (e, t, r) => {
      (r.r(t), r.d(t, { VersionSelect: () => u }));
      var a = r(54568),
        n = r(70785),
        s = r(45835),
        o = r(6438),
        i = r(7620),
        l = r(41574),
        d = r(6472),
        c = r(76829),
        g = r(73205),
        x = r(81325);
      function u({ triggerClassName: e }) {
        let {
            divisions: t,
            selectedVersion: r,
            setSelectedVersion: u,
          } = (0, i.useContext)(c.NavigationContext),
          m = t.versions,
          h = (0, l.Ub)("(max-width: 1024px)");
        return r && 0 !== m.length
          ? (0, a.jsxs)(d.DropdownMenu, {
              children: [
                (0, a.jsx)(d.DropdownMenuTrigger, {
                  asChild: !0,
                  className: (0, x.cn)(
                    "py-1.5 px-2.5 rounded-xl hover:!bg-gray-600/5 dark:hover:!bg-gray-200/5 aria-[expanded=true]:bg-gray-600/5 dark:aria-[expanded=true]:bg-gray-200/5 text-sm font-medium text-gray-900 h-8 focus:outline-primary dark:text-gray-300 group/trigger flex items-center gap-2 whitespace-nowrap",
                    e,
                  ),
                  children: (0, a.jsxs)("button", {
                    children: [
                      (0, a.jsx)("span", { className: "truncate max-w-[12.5rem]", children: r }),
                      (0, a.jsx)(g.DropdownArrowIcon, {
                        className:
                          "rotate-90 ml-auto group-aria-[expanded=true]/trigger:rotate-[270deg]",
                      }),
                    ],
                  }),
                }),
                (0, a.jsx)(d.DropdownMenuContent, {
                  side: "bottom",
                  align: "start",
                  className: "max-h-[420px] p-1 border border-gray-200 dark:border-white/[0.07]",
                  style: { width: h ? "var(--radix-dropdown-menu-trigger-width)" : void 0 },
                  children: m.map((e, t) => {
                    let i = "string" == typeof e ? e : e.name,
                      l = i === r;
                    return (0, a.jsxs)(
                      s.Item,
                      {
                        onSelect: () =>
                          ((e) => {
                            if ("object" == typeof e && e.href && (0, n.v)(e.href)) {
                              return void window.open(e.href, "_blank");
                            }
                            u("object" == typeof e ? e.name : e);
                          })(e),
                        "aria-selected": l,
                        className:
                          "flex !outline-none focus-visible:!outline-primary items-center pl-2.5 pr-4 py-2 gap-2 focus:bg-gray-600/5 dark:focus:bg-gray-200/5 cursor-pointer rounded-xl",
                        children: [
                          (0, a.jsx)("p", {
                            className: (0, x.cn)(
                              "flex-1 text-sm font-medium",
                              l
                                ? "text-primary dark:text-primary-light"
                                : "text-gray-800 dark:text-gray-300",
                            ),
                            children: i,
                          }),
                          l &&
                            (0, a.jsx)(o.A, {
                              className: "size-4 shrink-0 text-primary dark:text-primary-light",
                            }),
                        ],
                      },
                      `version-${t}`,
                    );
                  }),
                }),
              ],
            })
          : null;
      }
    },
    77548: (e, t, r) => {
      r.d(t, { TopBar: () => N });
      var a = r(54568),
        n = r(7620),
        s = r(8677),
        o = r(67908),
        i = r(12192),
        l = r(30793),
        d = r(76829),
        c = r(35878),
        g = r(55030),
        x = r(68999),
        u = r(34766),
        m = r(8283),
        h = r(12158),
        p = r(26842),
        f = r(81325),
        y = r(40588),
        b = r(91263),
        v = r(62581),
        k = r(30921),
        j = r(80963),
        w = r(40972),
        C = r(2492);
      function N({ className: e, pageMetadata: t }) {
        let { docsConfig: r } = (0, n.useContext)(l.DocsConfigContext),
          { banner: N } = (0, n.useContext)(i.y),
          { divisions: L } = (0, n.useContext)(d.NavigationContext),
          A = (0, d.n)(),
          { search: _ } = A,
          D = (0, g.O)(),
          [I, T] = (0, n.useState)(!1),
          M = L.tabs.length > 0,
          S = !!N;
        return (
          (0, n.useEffect)(() => {
            (!M && S) || (M && !S)
              ? document.documentElement.classList.add("lg:[--scroll-mt:9.5rem]")
              : M &&
                S &&
                r?.theme !== "maple" &&
                r?.theme !== "willow" &&
                document.documentElement.classList.add("lg:[--scroll-mt:12rem]");
          }, [M, S, r?.theme]),
          (0, a.jsxs)("div", {
            id: c.V.Navbar,
            className: (0, f.cn)(o.f.PrimaryNav, "fixed lg:sticky top-0 w-full", e),
            children: [
              (0, a.jsx)("div", {
                id: c.V.NavBarTransition,
                className: (0, f.cn)(
                  "absolute w-full h-full backdrop-blur flex-none transition-colors duration-500",
                  "border-b border-gray-500/5 dark:border-gray-300/[0.06]",
                  "data-[is-opaque=true]:bg-background-light data-[is-opaque=true]:supports-backdrop-blur:bg-background-light/95 data-[is-opaque=true]:dark:bg-background-dark/75",
                  "data-[is-opaque=false]:supports-backdrop-blur:bg-background-light/60 data-[is-opaque=false]:dark:bg-transparent",
                ),
                "data-is-opaque": D,
              }),
              (0, a.jsx)(s.l, {}),
              (0, a.jsx)("div", {
                className: "max-w-8xl mx-auto relative",
                children: (0, a.jsxs)("div", {
                  children: [
                    (0, a.jsxs)("div", {
                      className: "relative",
                      children: [
                        (0, a.jsx)("div", {
                          className: (0, f.cn)(
                            "flex items-center lg:px-12 h-16 min-w-0",
                            M ? "mx-4 lg:mx-0" : "px-4",
                          ),
                          children: (0, a.jsxs)("div", {
                            className: (0, f.cn)(
                              "h-full relative flex-1 flex items-center gap-x-4 min-w-0",
                              "border-b border-gray-500/5 dark:border-gray-300/[0.06]",
                              !M && "lg:border-none",
                            ),
                            children: [
                              (0, a.jsxs)("div", {
                                className: "flex-1 flex items-center gap-x-4",
                                children: [
                                  (0, a.jsx)(u.l, {}),
                                  (0, a.jsx)(C.X, {}),
                                  (0, a.jsx)(j.m, { className: "max-lg:hidden" }),
                                ],
                              }),
                              (0, a.jsx)(h.DesktopSearchEntry, { includeAskAiText: !0 }),
                              (0, a.jsxs)("div", {
                                className:
                                  "flex-1 relative hidden lg:flex items-center ml-auto justify-end space-x-4",
                                children: [
                                  (0, a.jsx)("nav", {
                                    className: "text-sm",
                                    children: (0, a.jsx)("ul", {
                                      className: "flex space-x-6 items-center",
                                      children: (0, a.jsx)(k.NavbarLinks, {
                                        actionClassName: k.DEFAULT_ACTION_CLASSNAME,
                                      }),
                                    }),
                                  }),
                                  (0, a.jsx)("div", {
                                    className: "flex items-center",
                                    children: (0, a.jsx)(v.ModeToggle, {}),
                                  }),
                                ],
                              }),
                              (0, a.jsxs)("div", {
                                className: "flex lg:hidden items-center gap-3",
                                children: [
                                  (0, a.jsxs)(h.SearchButton, {
                                    className:
                                      "text-gray-500 w-8 h-8 flex items-center justify-center hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
                                    id: c.V.SearchBarEntryMobile,
                                    children: [
                                      (0, a.jsx)("span", { className: "sr-only", children: _ }),
                                      (0, a.jsx)(x.A, {
                                        icon: "magnifying-glass",
                                        iconType: "solid",
                                        className:
                                          "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                      }),
                                    ],
                                  }),
                                  (0, a.jsx)(p.A, {}),
                                  (0, a.jsx)("button", {
                                    "aria-label": A["aria.moreActions"],
                                    className: "h-7 w-5 flex items-center justify-end",
                                    onClick: () => T(!0),
                                    children: (0, a.jsx)(x.A, {
                                      icon: "ellipsis-vertical",
                                      iconType: "solid",
                                      className:
                                        "h-4 w-4 bg-gray-500 dark:bg-gray-400 hover:bg-gray-600 dark:hover:bg-gray-300",
                                    }),
                                  }),
                                  (0, a.jsx)(w.TopbarDialog, {
                                    topbarDialogOpen: I,
                                    setTopbarDialogOpen: T,
                                    children: (0, a.jsx)(k.NavbarLinks, {
                                      actionClassName: k.DEFAULT_ACTION_CLASSNAME,
                                    }),
                                  }),
                                ],
                              }),
                            ],
                          }),
                        }),
                        (0, a.jsx)(b.i, { pageMetadata: t }),
                      ],
                    }),
                    M &&
                      (0, a.jsx)("div", {
                        className: "hidden lg:flex px-12 h-12",
                        children: (0, a.jsx)(m.U, {}),
                      }),
                  ],
                }),
              }),
              (0, a.jsx)(y.c, {}),
            ],
          })
        );
      }
    },
    79769: (e, t, r) => {
      r.d(t, { M: () => d, h: () => c });
      var a = r(54568),
        n = r(7620),
        s = r(79634),
        o = r(33052),
        i = r(68999),
        l = r(81325);
      let d = ({
          name: e,
          href: t,
          icon: r = "book-open",
          iconType: d = "duotone",
          isActive: c,
          color: g,
        }) => {
          let [x, u] = (0, n.useState)(!1);
          return (0, a.jsxs)(s.DynamicLink, {
            href: t,
            onMouseEnter: () => u(!0),
            onMouseLeave: () => u(!1),
            className: (0, l.cn)(
              o.x.Anchor,
              "ml-4 group flex items-center lg:text-sm lg:leading-6 mb-5 sm:mb-4 font-medium outline-offset-4",
              c
                ? "[text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] text-primary dark:text-primary-light"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
            ),
            children: [
              (0, a.jsx)("div", {
                style: (c || x) && g ? { background: g } : {},
                className: (0, l.cn)(
                  "mr-4 rounded-md p-1",
                  !g && "group-hover:bg-primary",
                  c
                    ? [g ? "" : "bg-primary"]
                    : "text-gray-400 dark:text-white/50 dark:bg-background-dark dark:brightness-[1.35] dark:ring-1 dark:hover:brightness-150 group-hover:brightness-100 group-hover:ring-0 ring-1 ring-gray-950/[0.07] dark:ring-gray-700/40",
                ),
                children: (0, a.jsx)(i.ComponentIcon, {
                  icon: r,
                  iconType: d,
                  className: (0, l.cn)(
                    "h-4 w-4 secondary-opacity group-hover:fill-primary-dark group-hover:bg-white",
                    c ? "bg-white" : "bg-gray-400 dark:bg-gray-500",
                  ),
                  overrideColor: !0,
                }),
              }),
              e ?? t,
            ],
          });
        },
        c = ({
          name: e,
          href: t,
          icon: r = "book-open",
          iconType: n = "solid",
          isActive: d,
          color: c,
        }) => {
          let g = c?.includes("linear-gradient");
          return (0, a.jsxs)(s.DynamicLink, {
            href: t,
            style: d && g ? { color: c } : {},
            className: (0, l.cn)(
              o.x.Anchor,
              "pl-4 group flex items-center lg:text-sm lg:leading-6 mb-3 gap-3.5",
              d
                ? ["font-semibold", g ? "" : "text-primary dark:text-primary-light"]
                : "text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
            ),
            children: [
              (0, a.jsx)(i.ComponentIcon, {
                icon: r.toLowerCase(),
                iconType: n,
                className: (0, l.cn)(
                  "h-4 w-4 secondary-opacity group-hover:fill-primary-dark group-hover:bg-gray-900 dark:group-hover:bg-gray-300",
                  d
                    ? "bg-primary group-hover:bg-primary dark:bg-primary-light dark:group-hover:bg-primary-light"
                    : "bg-gray-400 dark:bg-gray-500",
                ),
                overrideColor: !0,
              }),
              (0, a.jsx)("span", { children: e ?? t }),
            ],
          });
        };
    },
    80963: (e, t, r) => {
      r.d(t, { m: () => h });
      var a = r(54568),
        n = r(45835),
        s = r(6438),
        o = r(7620),
        i = r(6472),
        l = r(79634),
        d = r(76829),
        c = r(33052),
        g = r(68999),
        x = r(73205),
        u = r(81325);
      let m = "regular",
        h = ({ className: e }) => {
          let { divisions: t } = (0, o.useContext)(d.NavigationContext),
            { products: r } = t;
          if (!(r.length > 0)) {
            return null;
          }
          let h = r.find((e) => e.isActive) ?? r[0],
            p = void 0 !== h && "icon" in h && void 0 !== h.icon;
          return (0, a.jsxs)(i.DropdownMenu, {
            children: [
              (0, a.jsx)(i.DropdownMenuTrigger, {
                asChild: !0,
                className: (0, u.cn)(
                  c.x.ProductsSelectorTrigger,
                  "py-1.5 px-2.5 rounded-xl hover:!bg-gray-600/5 dark:hover:!bg-gray-200/5 aria-[expanded=true]:bg-gray-600/5 dark:aria-[expanded=true]:bg-gray-200/5 text-sm font-medium text-gray-900 h-8 focus:outline-primary dark:text-gray-300 group/trigger flex items-center gap-2 whitespace-nowrap",
                  e,
                ),
                children: (0, a.jsxs)("button", {
                  children: [
                    p &&
                      (0, a.jsx)(g.ComponentIcon, {
                        icon: "string" == typeof h.icon ? h.icon : (h.icon?.name ?? ""),
                        iconType: "string" == typeof h.icon ? m : h.icon?.style || m,
                        className: "size-4 shrink-0",
                      }),
                    (0, a.jsx)("span", {
                      className: "truncate max-w-[12.5rem]",
                      title: h?.name ?? h?.product,
                      children: h?.name ?? h?.product,
                    }),
                    (0, a.jsx)(x.DropdownArrowIcon, {
                      className:
                        "rotate-90 ml-auto group-aria-[expanded=true]/trigger:rotate-[270deg]",
                    }),
                  ],
                }),
              }),
              (0, a.jsx)(i.DropdownMenuContent, {
                side: "bottom",
                align: "start",
                className: (0, u.cn)(
                  c.x.ProductsSelectorContent,
                  "inline-flex max-h-[420px] max-w-[16rem] md:max-w-[32rem] p-1 border border-gray-200 dark:border-white/[0.07] flex-col",
                ),
                children: r.map((e, t) => {
                  let r = "icon" in e && void 0 !== e.icon;
                  return (0, a.jsx)(
                    l.DynamicLink,
                    {
                      href: e.href,
                      children: (0, a.jsxs)(n.Item, {
                        "aria-selected": e.isActive,
                        className: (0, u.cn)(
                          c.x.ProductsSelectorItem,
                          "grid !outline-none focus-visible:!outline-primary grid-rows-1 items-center pl-2.5 pr-4 py-2 gap-2 focus:bg-gray-600/5 dark:focus:bg-gray-200/5 cursor-pointer rounded-xl",
                          r ? "grid-cols-[24px_1fr_auto]" : "grid-cols-[1fr_auto]",
                        ),
                        children: [
                          r &&
                            (0, a.jsx)("div", {
                              className: (0, u.cn)(
                                c.x.ProductsSelectorItemIcon,
                                "flex items-center justify-center",
                              ),
                              children: (0, a.jsx)(g.ComponentIcon, {
                                icon: "string" == typeof e.icon ? e.icon : (e.icon?.name ?? ""),
                                iconType: "string" == typeof e.icon ? m : e.icon?.style || m,
                                className: "size-4 shrink-0",
                              }),
                            }),
                          (0, a.jsxs)("div", {
                            className: "flex flex-col",
                            children: [
                              (0, a.jsx)("p", {
                                className: (0, u.cn)(
                                  c.x.ProductsSelectorItemTitle,
                                  "text-sm font-medium line-clamp-1",
                                  e.isActive
                                    ? "text-primary dark:text-primary-light"
                                    : "text-gray-800 dark:text-gray-300",
                                ),
                                children: e.product,
                              }),
                              (0, a.jsx)("p", {
                                className: (0, u.cn)(
                                  c.x.ProductsSelectorItemDescription,
                                  "text-sm text-gray-600 dark:text-gray-400 line-clamp-1",
                                ),
                                title: e.description,
                                children: e.description,
                              }),
                            ],
                          }),
                          e.isActive &&
                            (0, a.jsx)(s.A, {
                              className: "size-4 text-primary dark:text-primary-light",
                            }),
                        ],
                      }),
                    },
                    e.product + t,
                  );
                }),
              }),
            ],
          });
        };
    },
    82326: (e, t, r) => {
      r.d(t, { TopLevelNavTabsMobile: () => x });
      var a = r(54568),
        n = r(6438),
        s = r(7620),
        o = r(6472),
        i = r(79634),
        l = r(76829),
        d = r(33052),
        c = r(73205),
        g = r(81325);
      function x() {
        let { divisions: e } = (0, s.useContext)(l.NavigationContext),
          t = e.tabs.find((e) => e.isActive),
          r = t?.menu,
          n = r?.find((e) => e.isActive);
        return (0, a.jsxs)("div", {
          className: "flex flex-wrap gap-2",
          children: [
            (0, a.jsx)(u, { activeItem: t, items: e.tabs }),
            n && (0, a.jsx)(u, { activeItem: n, items: r }),
          ],
        });
      }
      let u = ({ activeItem: e, items: t }) => {
          let { navIsOpen: r } = (0, s.useContext)(l.NavigationContext),
            [n, i] = (0, s.useState)(!1);
          return (0, a.jsxs)(o.DropdownMenu, {
            open: n && r,
            onOpenChange: i,
            children: [
              (0, a.jsxs)(o.DropdownMenuTrigger, {
                className:
                  "group/trigger flex w-full items-center justify-between pl-4 pr-3.5 h-10 rounded-[0.85rem] border border-gray-200/70 dark:border-white/[0.07] hover:bg-gray-600/5 dark:hover:bg-gray-200/5 gap-1.5",
                children: [
                  (0, a.jsx)("span", {
                    className: "text-base font-normal text-gray-800 dark:text-gray-300",
                    children: e?.name,
                  }),
                  (0, a.jsx)(c.DropdownArrowIcon, {
                    className: (0, g.cn)("rotate-90", n && "rotate-[270deg]"),
                  }),
                ],
              }),
              (0, a.jsx)(o.DropdownMenuContent, {
                className: "p-1.5 gap-0",
                style: { width: "var(--radix-dropdown-menu-trigger-width)" },
                children: t?.map((e) => (0, a.jsx)(m, { item: e }, e.name)),
              }),
            ],
          });
        },
        m = ({ item: e }) => {
          let t = "isActive" in e && e.isActive;
          return (0, a.jsxs)(i.DynamicLink, {
            href: e.href,
            className: (0, g.cn)(
              d.x.MobileNavTabsBarItem,
              "px-2.5 py-2 group flex items-center justify-between gap-3 text-sm font-medium",
              t ? "text-primary dark:text-primary-light" : "text-gray-800 dark:text-gray-300",
            ),
            children: [
              e.name,
              t &&
                (0, a.jsx)(n.A, {
                  className: "size-4 shrink-0 text-primary dark:text-primary-light",
                }),
            ],
          });
        };
    },
    86087: (e, t, r) => {
      r.d(t, { NavBarTransition: () => l });
      var a = r(54568),
        n = r(7620),
        s = r(67908),
        o = r(55030),
        i = r(81325);
      function l({ id: e, hasTabs: t, hasBanner: r, className: l, children: d }) {
        let c = (0, o.O)();
        return ((0, n.useEffect)(() => {
          let e = 3;
          (t && (e += 2.5),
            r && (e += 2.5),
            document.documentElement.style.setProperty("--scroll-mt", `${e}rem`));
        }, [t, r]),
        t)
          ? (0, a.jsx)("div", {
              id: e,
              className: (0, i.cn)(
                s.f.SecondaryNav,
                "hidden lg:flex fixed top-0 left-[19rem] h-12 right-0 bottom-0 backdrop-blur flex-none transition-colors duration-500 border-b dark:border-white/[0.07]",
                "data-[is-opaque=true]:bg-background-light data-[is-opaque=true]:supports-backdrop-blur:bg-background-light/95 data-[is-opaque=true]:dark:bg-background-dark/75",
                "data-[is-opaque=false]:supports-backdrop-blur:bg-background-light/60 data-[is-opaque=false]:dark:bg-transparent",
                r && "lg:mt-10",
                l,
              ),
              "data-is-opaque": c,
              children: d,
            })
          : null;
      }
    },
    91263: (e, t, r) => {
      r.d(t, { i: () => c });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        o = r(76829),
        i = r(27194),
        l = r(73205),
        d = r(87920);
      let c = ({ pageMetadata: e }) => {
        let t = (0, i.G)(),
          { navIsOpen: r, setNavIsOpen: c } = (0, n.useContext)(o.NavigationContext),
          { docsConfig: g } = (0, n.useContext)(s.DocsConfigContext),
          x = (0, d.a)(t, g?.navigation),
          { title: u } = e;
        return (0, a.jsxs)("button", {
          type: "button",
          className: "flex items-center h-14 py-4 px-5 lg:hidden focus:outline-0 w-full text-left",
          onClick: () => c(!r),
          children: [
            (0, a.jsxs)("div", {
              className:
                "text-gray-500 hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-300",
              children: [
                (0, a.jsx)("span", { className: "sr-only", children: "Navigation" }),
                (0, a.jsx)(l.ZB, {}),
              ],
            }),
            u &&
              (0, a.jsxs)("div", {
                className:
                  "ml-4 flex text-sm leading-6 whitespace-nowrap min-w-0 space-x-3 overflow-hidden",
                children: [
                  x &&
                    (0, a.jsxs)("div", {
                      className: "flex items-center space-x-3 flex-shrink-0",
                      children: [
                        (0, a.jsx)("span", { children: x }),
                        (0, a.jsx)(l.fl, { className: "fill-gray-400" }),
                      ],
                    }),
                  (0, a.jsx)("div", {
                    className:
                      "font-semibold text-gray-900 truncate dark:text-gray-200 min-w-0 flex-1",
                    children: u,
                  }),
                ],
              }),
          ],
        });
      };
    },
    91392: (e, t, r) => {
      r.d(t, { j: () => F });
      var a = r(54568),
        n = r(92815),
        s = r(16916),
        o = r(84514),
        i = r(70785),
        l = r(19664),
        d = r.n(l),
        c = r(7620),
        g = r(72179),
        x = r(71252),
        u = r(76829),
        m = r(96924),
        h = r(22153),
        p = r(27194),
        f = r(81325);
      let y = (e, t) => `${1 + e * ("leading" === t ? 1.5 : 0.75)}rem`,
        b = (e = "container", t, r) => {
          let a = (0, f.cn)(
              "group flex items-center pr-3 py-1.5 cursor-pointer gap-x-3 text-left",
              r && "break-words hyphens-auto",
            ),
            n = {
              container: (0, f.cn)(
                "rounded-xl w-full outline-offset-[-1px]",
                t
                  ? "bg-primary/10 text-primary [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] dark:text-primary-light dark:bg-primary-light/10"
                  : "hover:bg-gray-600/5 dark:hover:bg-gray-200/5 text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
              ),
              card: (0, f.cn)(
                "ml-4 border-l outline-offset-[-1px]",
                t
                  ? "border-primary dark:border-primary-light bg-primary/10 text-primary [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] dark:text-primary-light dark:bg-primary-light/10"
                  : "border-gray-950/5 dark:border-white/10 hover:bg-gray-600/5 dark:hover:bg-gray-200/5 text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
              ),
              border: (0, f.cn)(
                "ml-4 border-l py-2 lg:py-1.5 w-[calc(100%-1rem)]",
                t
                  ? "border-primary dark:border-primary-light text-primary [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] dark:text-primary-light"
                  : "border-gray-950/5 dark:border-white/10 hover:border-gray-950/20 dark:hover:border-white/20 text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
              ),
              undecorated: (0, f.cn)(
                t
                  ? "border-primary dark:border-primary-light text-primary [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] dark:text-primary-light"
                  : "border-gray-950/5 dark:border-white/10 hover:border-gray-950/20 dark:hover:border-white/20 text-gray-700 hover:text-gray-950 dark:text-gray-400 dark:hover:text-gray-300",
              ),
              arrow: (0, f.cn)(
                t
                  ? "border-primary dark:border-primary-light text-primary [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor] dark:text-primary-light"
                  : "border-gray-950/5 dark:border-white/10 hover:border-gray-950/20 dark:hover:border-white/20 text-gray-700 hover:text-gray-950 dark:text-gray-400 dark:hover:text-gray-300",
              ),
              plain: (0, f.cn)(
                t
                  ? "text-primary dark:text-primary-light [text-shadow:-0.2px_0_0_currentColor,0.2px_0_0_currentColor]"
                  : "text-gray-950 dark:text-white hover:text-primary hover:dark:text-primary-light",
              ),
            };
          return (0, f.cn)(a, n[e]);
        };
      var v = r(2811),
        k = r(27541),
        j = r(30793),
        w = r(68999),
        C = r(60284),
        N = r(67793);
      function L(e) {
        return e.split("?")[0]?.split("#")[0] ?? "";
      }
      function A(e, t) {
        return (
          !!(t.root && "href" in t.root && (0, N.N)(t.root.href, L(e))) ||
          t.pages.some((t) => ((0, n.I)(t) ? A(e, t) : (0, N.N)(t.href, L(e))))
        );
      }
      var _ = r(21433),
        D = r(73205);
      let I = ({
        group: e,
        level: t,
        shouldAutoNavigate: r,
        sidebarItemStyle: s,
        arrowPosition: o,
      }) => {
        let { isLivePreview: i } = (0, c.useContext)(x.K),
          l = (0, u.n)(),
          d = (0, k.useRouter)(),
          h = (0, p.G)(),
          { docsConfig: I } = (0, c.useContext)(j.DocsConfigContext),
          { prefetch: T } = (0, m.B)(),
          [M, S] = (0, c.useState)(!!A(h, e)),
          { group: E, pages: z } = e;
        if (
          ((0, c.useEffect)(() => {
            ((A(h, e) || e.expanded) && S(!0),
              t <= 1 &&
                e.root &&
                (0, v.y)(e.root) &&
                T(e.root.href, { source: "group-dropdown-root", level: t }),
              t <= 1 &&
                "pages" in e &&
                Array.isArray(e.pages) &&
                e.pages
                  .filter(
                    (e) =>
                      !!e &&
                      "object" == typeof e &&
                      "href" in e &&
                      "string" == typeof e.href &&
                      (e.href.startsWith("/") || /\w/.test(e.href[0] ?? "")),
                  )
                  .slice(0, 3)
                  .forEach((e) => {
                    (0, v.y)(e) && T(e.href, { source: "group-dropdown", level: t });
                  }));
          }, [h, e, t, T]),
          !E)
        ) {
          return null;
        }
        let V = 1 === E.split(" ").length,
          B = e.root && (0, v.y)(e.root) && (0, N.N)(e.root.href, L(h));
        return (0, a.jsxs)("li", {
          "data-title": E,
          "data-group-tag": e.tag || "",
          className: (0, f.cn)((0, C.u)(I?.theme)),
          children: [
            (0, a.jsxs)("button", {
              className: (0, f.cn)(b(s, !!B, V)),
              style: { paddingLeft: y(t, o) },
              onClick: () => {
                if (e.root && (0, v.y)(e.root)) {
                  if (B) {
                    S(!M);
                  } else {
                    let t = i ? (0, g.yv)(e.root.href) : e.root.href;
                    (d.push(t), S(!0));
                  }
                  return;
                }
                let t = z[0],
                  a = I?.interaction?.drilldown;
                if (!M && t && (0, v.y)(t) && !A(h, e) && (!0 === a || (!1 !== a && !r))) {
                  let e = i ? (0, g.yv)(t.href) : t.href;
                  d.push(e);
                }
                S(!M);
              },
              "aria-label": l["aria.toggleSection"].replace("{section}", E),
              "aria-expanded": M,
              children: [
                "leading" === o &&
                  (0, a.jsx)(D.DropdownArrowIcon, {
                    className: (0, f.cn)("w-2 h-5 -mr-0.5", M && "duration-75 rotate-90"),
                  }),
                e.icon &&
                  (0, a.jsx)(w.ComponentIcon, {
                    icon: "object" == typeof e.icon ? e.icon.name : e.icon,
                    iconType: "object" == typeof e.icon ? e.icon.style : void 0,
                    className: "h-4 w-4 bg-gray-400 dark:bg-gray-500",
                    overrideColor: !0,
                  }),
                (0, a.jsxs)("div", {
                  className: (0, f.cn)(
                    !!e.tag && "justify-between flex items-center gap-2",
                    ("end" === o || "leading" === o) &&
                      "flex-1 flex items-center gap-2 justify-start",
                  ),
                  children: [E, e.tag && (0, a.jsx)(_.h, { tag: e.tag })],
                }),
                "leading" !== o &&
                  (0, a.jsx)(D.DropdownArrowIcon, {
                    className: (0, f.cn)("w-2 h-5 -mr-0.5", M && "duration-75 rotate-90"),
                  }),
              ],
            }),
            M &&
              (0, a.jsx)("ul", {
                className: (0, f.cn)((0, C.u)(I?.theme)),
                children: z.map((e) => {
                  let i = (0, n.I)(e) ? e.group : e.href;
                  return (0, a.jsx)(
                    F,
                    {
                      entry: e,
                      level: t + 1,
                      shouldAutoNavigateOnGroupClick: r,
                      sidebarItemStyle: s,
                      arrowPosition: o,
                    },
                    i,
                  );
                }),
              }),
          ],
        });
      };
      var T = r(61532),
        M = r(1491),
        S = r(5904),
        E = r(33052);
      let z = ({ isActive: e, method: t, deprecated: r }) => {
          let {
            activeNavPillBg: n,
            activeNavPillText: s,
            inactiveNavPillText: o,
            inactiveNavPillBg: i,
          } = (0, S.H)(r ? "DEPRECATED" : t);
          return (0, a.jsx)("span", {
            className: (0, f.cn)(E.x.MethodNavPill, "flex items-center w-8"),
            children: (0, a.jsx)("span", {
              className: (0, f.cn)(
                "px-1 py-0.5 rounded-md text-[0.55rem] leading-tight font-bold",
                e ? `${n} ${s}` : `${i} ${o}`,
              ),
              children: (0, S._)(t),
            }),
          });
        },
        F = (0, c.forwardRef)(function (
          {
            entry: e,
            level: t = 0,
            shouldAutoNavigateOnGroupClick: r = !1,
            sidebarItemStyle: l,
            arrowPosition: v = "trailing",
            trailingIcon: k,
          },
          j,
        ) {
          let C,
            { isLivePreview: A } = (0, c.useContext)(x.K),
            { divisions: S } = (0, c.useContext)(u.NavigationContext),
            { prefetch: E } = (0, m.B)(),
            F = (0, h.p)("docs.navitem.click"),
            V = (0, p.G)(),
            B = (0, c.useRef)(null),
            H = (0, c.useRef)(!1),
            O = (0, c.useRef)(null),
            P = (0, c.useRef)((e) => {
              ((B.current = e), "function" == typeof j ? j(e) : j && (j.current = e));
            });
          if (
            ((0, c.useEffect)(() => {
              let r = B.current;
              if (!r || !e || (0, n.I)(e) || H.current) {
                return;
              }
              let a = e.href,
                s = (0, o.C)(a),
                l = e.url,
                d = l || s || "/";
              if (!l && (!s || !(0, i.v)(s))) {
                return (
                  (O.current = new IntersectionObserver(
                    (e) => {
                      e.forEach((e) => {
                        e.isIntersecting &&
                          !H.current &&
                          ((H.current = !0),
                          E(d, { source: "nav-item", level: t }),
                          O.current?.disconnect());
                      });
                    },
                    { rootMargin: "50%" },
                  )),
                  O.current.observe(r),
                  () => {
                    (O.current?.disconnect(), (O.current = null));
                  }
                );
              }
            }, [e, t, E]),
            null == e)
          ) {
            return null;
          }
          if ((0, n.I)(e)) {
            return (0, a.jsx)(
              I,
              { group: e, level: t, shouldAutoNavigate: r, sidebarItemStyle: l, arrowPosition: v },
              e.group,
            );
          }
          let { href: $, api: R, openapi: G, url: W, asyncapi: U, deprecated: X, mode: Z } = e,
            q = (0, o.C)($),
            Y = (0, N.N)(q, L(V)),
            K = R || G || U,
            J = (0, M.f3)(e);
          if ("custom" === Z && 1 === S.groupsOrPages.length) {
            return null;
          }
          if (U) {
            C = "websocket";
          } else if (K) {
            let e = (0, s.sE)(K);
            void 0 != e && (C = e.method);
          }
          if (!J && !e.icon && !k && !e.tag) {
            return null;
          }
          let Q = 1 === J.split(" ").length,
            ee = W || (A ? (0, g.yv)(q || "/") : q || "/");
          return (0, a.jsx)("li", {
            ref: P.current,
            id: W || q || "/",
            className: "relative scroll-m-4 first:scroll-m-20",
            "data-title": J,
            children: (0, a.jsxs)(d(), {
              prefetch: !1,
              href: ee,
              className: b(l, Y, Q),
              style: { paddingLeft: y(t, v) },
              target: W || (q && (0, i.v)(q)) ? "_blank" : void 0,
              onClick: () => F({ name: J, url: W || q || "/" }),
              children: [
                "arrow" === l &&
                  Y &&
                  (0, a.jsx)(D.DropdownArrowIcon, {
                    className:
                      "absolute left-0 text-primary group-hover:text-primary dark:text-primary-light dark:group-hover:text-primary-light",
                  }),
                K &&
                  !0 !== e.hideApiMarker &&
                  C &&
                  (0, a.jsx)(z, { isActive: Y, method: C, deprecated: X }),
                e.icon &&
                  (0, a.jsx)(w.ComponentIcon, {
                    icon: "string" == typeof e.icon ? e.icon : e.icon.name,
                    iconType: e.iconType || "regular",
                    className: (0, f.cn)(
                      "h-4 w-4",
                      Y ? "bg-primary dark:bg-primary-light" : "bg-gray-400 dark:bg-gray-500",
                    ),
                    overrideColor: !0,
                  }),
                (0, a.jsxs)("div", {
                  className: (0, f.cn)(
                    "flex-1 flex items-center space-x-2.5",
                    X && "w-full max-w-full overflow-x-hidden justify-between",
                  ),
                  children: [
                    (0, a.jsx)("div", {
                      className: (0, f.cn)(
                        X &&
                          "min-w-0 max-w-full flex-1 whitespace-nowrap overflow-hidden text-ellipsis",
                      ),
                      children: J,
                    }),
                    W &&
                      (0, a.jsx)("div", {
                        className: (0, f.cn)("end" === v && "flex-1 flex justify-end"),
                        children: (0, a.jsx)(D.WL, { className: "flex-shrink-0" }),
                      }),
                    e.tag && (0, a.jsx)(_.h, { tag: e.tag }),
                    X &&
                      (0, a.jsx)("span", {
                        className: "flex-shrink-0",
                        children: (0, a.jsx)(T.m, {}),
                      }),
                  ],
                }),
                k,
              ],
            }),
          });
        });
    },
    92815: (e, t, r) => {
      r.d(t, { I: () => a });
      let a = (e) => !!(e.hasOwnProperty("group") && e.hasOwnProperty("pages"));
    },
    93372: (e, t, r) => {
      r.d(t, { L: () => a });
      function a(e) {
        for (
          ;
          e !== document.body &&
          !(function (e) {
            let t = window.getComputedStyle(e),
              r = t.overflowX,
              a = t.overflowY,
              n = e.clientHeight < e.scrollHeight,
              s = e.clientWidth < e.scrollWidth;
            return (
              (n && ("auto" === a || "scroll" === a)) || (s && ("auto" === r || "scroll" === r))
            );
          })(e) &&
          e.parentElement;
        ) {
          e = e.parentElement;
        }
        return e;
      }
    },
    95159: (e, t, r) => {
      (r.r(t), r.d(t, { LocalizationSelect: () => f, getFlag: () => p }));
      var a = r(54568),
        n = r(45835),
        s = r(6438),
        o = r(7620),
        i = r(41574),
        l = r(6472),
        d = r(79634),
        c = r(90280),
        g = r(76829),
        x = r(35878),
        u = r(73205),
        m = r(81325),
        h = r(52927);
      let p = (e) => {
        let t = new Intl.Locale((0, h.U)(e)).region;
        return (0, a.jsx)("img", {
          className: "w-full h-full rounded-full",
          alt: t,
          src: `${c.M5}/flags/${t}.svg`,
        });
      };
      function f({ triggerClassName: e, hideLanguageText: t = !1 }) {
        let {
            divisions: r,
            selectedLocale: c,
            setSelectedLocale: f,
            pageMetadata: y,
          } = (0, o.useContext)(g.NavigationContext),
          b = (0, i.Ub)("(max-width: 1024px)");
        (0, o.useEffect)(() => {
          c && document.documentElement.lang !== c && (document.documentElement.lang = c);
        }, [c]);
        let v = (0, o.useMemo)(
          () =>
            r.languages.map((e) => {
              let t = y[`${e.language}_link`],
                r = "string" == typeof t ? t : e.href;
              return {
                label: (0, h.J)(e.language).language,
                value: e.language,
                href: r,
                isActive: e.isActive,
              };
            }),
          [r.languages, y],
        );
        if (0 === v.length || !r.languages.length) {
          return null;
        }
        let k = v.find((e) => e.value === c);
        return (0, a.jsxs)(l.DropdownMenu, {
          children: [
            (0, a.jsx)(l.DropdownMenuTrigger, {
              asChild: !0,
              className: (0, m.cn)(
                "py-1.5 px-2.5 rounded-xl hover:!bg-gray-600/5 dark:hover:!bg-gray-200/5 aria-[expanded=true]:bg-gray-600/5 dark:aria-[expanded=true]:bg-gray-200/5 text-sm font-medium text-gray-900 h-8 focus-visible:outline-primary dark:text-gray-300 group/trigger flex items-center gap-2 whitespace-nowrap",
                t && "px-1.5",
                e,
              ),
              id: x.V.LocalizationSelectTrigger,
              children: (0, a.jsxs)("button", {
                children: [
                  (0, a.jsxs)("div", {
                    className: "relative size-4 rounded-full shrink-0",
                    children: [
                      k && p(k.value),
                      (0, a.jsx)("div", {
                        className:
                          "absolute top-0 left-0 w-full h-full border rounded-full bg-primary-light/10 border-black/10",
                      }),
                    ],
                  }),
                  !t &&
                    (0, a.jsx)("span", {
                      className: "truncate max-w-[12.5rem]",
                      children: k?.label,
                    }),
                  !t &&
                    (0, a.jsx)(u.DropdownArrowIcon, {
                      className:
                        "rotate-90 ml-auto group-aria-[expanded=true]/trigger:rotate-[270deg]",
                    }),
                ],
              }),
            }),
            (0, a.jsx)(l.DropdownMenuContent, {
              id: x.V.LocalizationSelectContent,
              side: "bottom",
              align: "start",
              className: "max-h-[420px] p-1 border border-gray-200 dark:border-white/[0.07]",
              style: { width: b ? "var(--radix-dropdown-menu-trigger-width)" : void 0 },
              children: v.map((e) => {
                let t = e.value === k?.value,
                  r = (0, a.jsxs)(
                    n.Item,
                    {
                      onSelect: e.href
                        ? void 0
                        : () => {
                            f(e.value);
                          },
                      "aria-selected": t,
                      className:
                        "flex !outline-none focus-visible:!outline-primary items-center pl-2.5 pr-4 py-2 gap-2 focus:bg-gray-600/5 dark:focus:bg-gray-200/5 cursor-pointer rounded-xl",
                      id: x.V.LocalizationSelectItem + "-" + e.value,
                      children: [
                        (0, a.jsxs)("div", {
                          className: "relative size-4 rounded-full shrink-0",
                          children: [
                            p(e.value),
                            (0, a.jsx)("div", {
                              className:
                                "absolute top-0 left-0 w-full h-full border rounded-full bg-primary-light/10 border-black/10",
                            }),
                          ],
                        }),
                        (0, a.jsx)("p", {
                          className: (0, m.cn)(
                            "flex-1 text-sm font-medium",
                            t
                              ? "text-primary dark:text-primary-light"
                              : "text-gray-800 dark:text-gray-300",
                          ),
                          children: e.label,
                        }),
                        t &&
                          (0, a.jsx)(s.A, {
                            className: "size-4 shrink-0 text-primary dark:text-primary-light",
                          }),
                      ],
                    },
                    e.value,
                  );
                return e.href
                  ? (0, a.jsx)(d.DynamicLink, { href: e.href, children: r }, e.value)
                  : r;
              }),
            }),
          ],
        });
      }
    },
    96116: (e, t, r) => {
      r.d(t, { MobileTopBarCtaButton: () => g });
      var a = r(54568),
        n = r(19664),
        s = r.n(n),
        o = r(7620),
        i = r(30793),
        l = r(22153),
        d = r(43119),
        c = r(49201);
      function g({ actionClassName: e }) {
        let { docsConfig: t } = (0, o.useContext)(i.DocsConfigContext),
          r = (0, l.p)("docs.navitem.cta_click"),
          n = t?.navbar?.primary;
        return n
          ? "github" === n.type
            ? (0, a.jsx)(c.GitHubCta, { className: "flex lg:hidden" })
            : "discord" === n.type
              ? (0, a.jsx)(d.DiscordCta, { className: "flex lg:hidden" })
              : n.href && n.label
                ? (0, a.jsx)("li", {
                    className: "block lg:hidden",
                    children: (0, a.jsx)(s(), {
                      href: n.href,
                      className: e,
                      onClick: () => r({ name: n.label, url: n.href, type: "button" }),
                      children: n.label,
                    }),
                  })
                : null
          : null;
      }
    },
    96119: (e, t, r) => {
      r.d(t, { f: () => f, r: () => p });
      var a = r(54568),
        n = r(2811),
        s = r(92815),
        o = r(7620),
        i = r(30793),
        l = r(76829),
        d = r(96924),
        c = r(33052),
        g = r(91392),
        x = r(81325),
        u = r(60284),
        m = r(68999),
        h = r(21433);
      function p({
        nav: e,
        shouldAutoNavigateOnGroupClick: t,
        navItemProps: r,
        showDivider: p,
        shouldLimitMarginWithAnchors: f,
        classNames: y,
      }) {
        let { prefetch: b } = (0, d.B)(),
          { docsConfig: v } = (0, o.useContext)(i.DocsConfigContext),
          { divisions: k, hasAdvancedTabs: j } = (0, o.useContext)(l.NavigationContext),
          { sidebarItemStyle: w, arrowPosition: C } = r ?? {},
          { groupLabel: N, icon: L } = y ?? {},
          A = k.dropdowns.length > 0 && !j,
          _ = k.anchors.length > 0,
          D = (e) => {
            let t = "mt-6 lg:mt-8";
            return f ? (0 !== e && p ? "my-2" : (0, x.cn)((!(0 === e && !_) || A) && t)) : t;
          },
          I = () =>
            (0, a.jsx)("div", {
              className: "px-1 py-3",
              children: (0, a.jsx)("div", {
                className: (0, x.cn)(
                  c.x.SidebarNavGroupDivider,
                  "h-px w-full bg-gray-100 dark:bg-white/10",
                ),
              }),
            });
        return (0, a.jsx)(a.Fragment, {
          children: e
            .map((r, i) => {
              if ((0, n.y)(r)) {
                return (
                  (r.href.startsWith("/") || /\w/.test(r.href[0] ?? "")) &&
                    b(r.href, { source: "side-nav-groups" }),
                  (0, a.jsx)(
                    o.Fragment,
                    {
                      children: (0, a.jsx)(
                        "ul",
                        {
                          className: (0, x.cn)(
                            c.x.SidebarGroup,
                            ((() => {
                              if (0 === i) return !1;
                              let t = e[i - 1];
                              return t && (0, s.I)(t);
                            })() ||
                              0 === i) &&
                              D(i),
                          ),
                          children: (0, a.jsx)(
                            g.j,
                            {
                              entry: r,
                              shouldAutoNavigateOnGroupClick: t,
                              sidebarItemStyle: w,
                              arrowPosition: C,
                            },
                            i,
                          ),
                        },
                        i,
                      ),
                    },
                    r.href,
                  )
                );
              }
              let { group: l, pages: d } = r;
              return r.root && (0, n.y)(r.root)
                ? (0, a.jsxs)(
                    o.Fragment,
                    {
                      children: [
                        p && i > 0 && (0, a.jsx)(I, {}),
                        (0, a.jsx)(
                          "ul",
                          {
                            className: (0, x.cn)(c.x.SidebarGroup, D(i), (0, u.u)(v?.theme)),
                            children: (0, a.jsx)(g.j, {
                              entry: r,
                              shouldAutoNavigateOnGroupClick: t,
                              sidebarItemStyle: w,
                              arrowPosition: C,
                            }),
                          },
                          i,
                        ),
                      ],
                    },
                    `${i} ${l}`,
                  )
                : (0, a.jsxs)(
                    o.Fragment,
                    {
                      children: [
                        p && i > 0 && (0, a.jsx)(I, {}),
                        (0, a.jsxs)(
                          "div",
                          {
                            className: D(i),
                            children: [
                              (0, a.jsxs)("div", {
                                className: (0, x.cn)(
                                  c.x.SidebarGroupHeader,
                                  "flex items-center gap-2.5 pl-4 mb-3.5 lg:mb-2.5 font-semibold",
                                  "text-gray-900 dark:text-gray-200",
                                  N,
                                ),
                                children: [
                                  r.icon &&
                                    (0, a.jsx)(m.ComponentIcon, {
                                      icon: "string" == typeof r.icon ? r.icon : r.icon.name,
                                      iconType:
                                        "object" == typeof r.icon
                                          ? r.icon.style
                                          : r.iconType || "regular",
                                      className: (0, x.cn)(
                                        c.x.SidebarGroupIcon,
                                        "h-3.5 w-3.5 bg-current",
                                        L,
                                      ),
                                      overrideColor: !0,
                                    }),
                                  (0, a.jsx)("h5", { id: c.x.SidebarTitle, children: l }),
                                  r.tag && (0, a.jsx)(h.h, { tag: r.tag }),
                                ],
                              }),
                              (0, a.jsx)("ul", {
                                id: c.x.SidebarGroup,
                                className: (0, x.cn)(c.x.SidebarGroup, (0, u.u)(v?.theme)),
                                children: d.map((e, r) =>
                                  (0, a.jsx)(
                                    g.j,
                                    {
                                      entry: e,
                                      shouldAutoNavigateOnGroupClick: t,
                                      sidebarItemStyle: w,
                                      arrowPosition: C,
                                    },
                                    r,
                                  ),
                                ),
                              }),
                            ],
                          },
                          i,
                        ),
                      ],
                    },
                    `${i} ${l}`,
                  );
            })
            .filter(Boolean),
        });
      }
      function f({ theme: e, isMobile: t }) {
        switch (e) {
          case "mint":
            return { shouldAutoNavigateOnGroupClick: t, shouldLimitMarginWithAnchors: !0 };
          case "maple":
          case "willow":
            return {
              shouldAutoNavigateOnGroupClick: t ?? !0,
              shouldLimitMarginWithAnchors: !0,
              classNames: { groupLabel: "font-medium" },
              navItemProps: { sidebarItemStyle: "border", arrowPosition: "trailing" },
            };
          case "aspen":
            return {
              shouldAutoNavigateOnGroupClick: t ?? !0,
              showDivider: !0,
              shouldLimitMarginWithAnchors: !0,
              classNames: {
                groupLabel: "text-gray-700 dark:text-gray-300 text-xs",
                icon: "h-3.5 w-3.5",
              },
              navItemProps: { arrowPosition: "end" },
            };
          case "linden":
            return {
              shouldLimitMarginWithAnchors: !0,
              navItemProps: { sidebarItemStyle: "arrow" },
            };
          case "palm":
            return {
              shouldAutoNavigateOnGroupClick: t ?? !0,
              shouldLimitMarginWithAnchors: !0,
              classNames: { groupLabel: "font-medium" },
              navItemProps: { sidebarItemStyle: "undecorated", arrowPosition: "leading" },
            };
          case "almond":
            return {
              shouldLimitMarginWithAnchors: !0,
              classNames: { groupLabel: "font-medium" },
              navItemProps: { arrowPosition: "end" },
            };
          case "sequoia":
            return {
              shouldAutoNavigateOnGroupClick: t ?? !0,
              showDivider: !1,
              shouldLimitMarginWithAnchors: !0,
              classNames: { groupLabel: "text-gray-500 dark:text-gray-400 text-xs font-normal" },
              navItemProps: { sidebarItemStyle: "plain", arrowPosition: "end" },
            };
          default:
            return { shouldAutoNavigateOnGroupClick: !0, shouldLimitMarginWithAnchors: !0 };
        }
      }
    },
    97154: (e, t, r) => {
      r.d(t, { A: () => m });
      var a = r(54568),
        n = r(7620),
        s = r(41574),
        o = r(24419),
        i = r(65477),
        l = r(35878),
        d = r(33052),
        c = r(81325),
        g = r(12158),
        x = r(39692);
      let u = !1,
        m = function ({ className: e }) {
          let { isInProgress: t, messages: r } = (0, i.w)(),
            { hasChatPermissions: m } = (0, n.useContext)(g.SearchContext),
            { isChatSheetOpen: h, onChatSheetToggle: p } = (0, n.useContext)(
              g.ChatAssistantContext,
            ),
            f = (0, s.Ub)("(max-width: 1024px)"),
            [y, b] = (0, n.useState)(() => {
              let e = document.getElementById(l.V.Footer);
              if (!e) {
                return !u;
              }
              let t = document.getElementById(l.V.ContentArea),
                r =
                  document.documentElement.scrollHeight > document.documentElement.clientHeight &&
                  (t?.clientHeight || 0) > document.documentElement.clientHeight,
                a = e.getBoundingClientRect();
              return !(a.top < window.innerHeight && a.bottom >= 0 && !r) || !u;
            }),
            [v, k] = (0, n.useState)(!1),
            j = (0, o.t)(),
            w = (0, n.useMemo)(() => j[0]?.trim() ?? "⌘", [j]);
          (0, n.useEffect)(() => {
            let e,
              t = document.getElementById(l.V.Footer);
            if (!t) {
              return;
            }
            let r = t.getBoundingClientRect(),
              a = r.top < window.innerHeight && r.bottom >= 0,
              n = document.getElementById(l.V.ContentArea),
              s =
                document.documentElement.scrollHeight > document.documentElement.clientHeight &&
                (n?.clientHeight || 0) > document.documentElement.clientHeight,
              o = a && !s;
            u
              ? a
                ? (k(!1), b(!0))
                : (k(!1), b(!1))
              : ((u = !0),
                a ||
                  (e = setTimeout(() => {
                    (k(!0), b(!1));
                  }, 10)));
            let i = new IntersectionObserver((e) => {
              let t = e[0];
              t && u && !o && (k(!0), b(t.isIntersecting));
            });
            return (
              i.observe(t),
              () => {
                (i.disconnect(), clearTimeout(e));
              }
            );
          }, []);
          let C = !m || y || h,
            N = t || r.length > 0;
          return (0, a.jsxs)("div", {
            className: (0, c.cn)(
              "left-0 right-0 sticky sm:px-4 pb-4 sm:pb-6 bottom-0 pt-1 flex flex-col items-center w-full overflow-hidden z-20 pointer-events-none print:hidden",
              e,
            ),
            children: [
              !C &&
                (0, a.jsx)("div", {
                  id: l.V.AssistantBarPlaceholder,
                  className: (0, c.cn)(
                    "fixed sm:hidden left-0 right-0 bottom-0 h-12 bg-background-light dark:bg-background-dark",
                  ),
                }),
              (0, a.jsx)("div", {
                className: (0, c.cn)(
                  d.x.ChatAssistantFloatingInput,
                  "z-10 w-full sm:w-96 focus-within:w-full group/assistant-bar sm:focus-within:w-[30rem] hover:scale-100 sm:hover:scale-105 focus-within:hover:scale-100 ",
                  "[transition:width_400ms,left_200ms,transform_500ms,opacity_200ms]",
                ),
                children: (0, a.jsx)("div", {
                  className: (0, c.cn)(
                    v && "transition-all duration-300",
                    C ? "translate-y-[100px] opacity-0" : "translate-y-0 opacity-100",
                  ),
                  onClick: (e) => {
                    N && (e.stopPropagation(), p({ entryPoint: "floating-input" }));
                  },
                  children: (0, a.jsx)(x.V, {
                    variant: "panel",
                    floating: !0,
                    showKeyboardHint: !0,
                    actionKey: w,
                    minRows: 2,
                    isMobile: f,
                    readOnly: N,
                    onSubmit: () => p({ entryPoint: "floating-input" }),
                  }),
                }),
              }),
            ],
          });
        };
    },
    97263: (e, t, r) => {
      r.d(t, { f: () => k });
      var a = r(54568),
        n = r(2811),
        s = r(7620),
        o = r(30793),
        i = r(76829),
        l = r(27194),
        d = r(74092),
        c = r(35878),
        g = r(32795),
        x = r(34766),
        u = r(23416),
        m = r(81325),
        h = r(93372),
        p = r(29462),
        f = r(79769);
      function y() {
        let { divisions: e } = (0, s.useContext)(i.NavigationContext),
          { anchorDefault: t } = (0, p.G)();
        return (0, a.jsx)("ul", {
          className: "list-none",
          children: e.anchors.map((e) =>
            (0, a.jsx)(
              "li",
              {
                className: "list-none",
                children: (0, a.jsx)(f.M, {
                  href: e.href,
                  name: e.name,
                  icon: "string" == typeof e.icon ? e.icon : e.icon?.name,
                  iconType: "object" == typeof e.icon ? e.icon.style : void 0,
                  color: e.color?.light ?? t,
                  isActive: e.isActive,
                }),
              },
              e.name,
            ),
          ),
        });
      }
      var b = r(96119);
      function v({ nav: e, mobile: t, docsConfig: r }) {
        return (0, a.jsx)(b.r, { nav: e, ...(0, b.f)({ theme: r?.theme, isMobile: t }) });
      }
      function k({ mobile: e = !1 }) {
        let t = (0, l.G)(),
          { divisions: r } = (0, s.useContext)(i.NavigationContext),
          { docsConfig: p } = (0, s.useContext)(o.DocsConfigContext),
          f = (0, s.useRef)(null),
          b = (0, s.useRef)(null),
          k = (0, s.useRef)(null),
          j = r.groupsOrPages.reduce((e, t) => ((0, n.y)(t) ? e + 1 : e + t.pages.length), 0);
        (0, d.E)(() => {
          function e() {
            b.current = f.current;
          }
          if (f.current) {
            if (f.current === b.current) {
              return e();
            }
            e();
            let t = k.current ? (0, h.L)(k.current) : document.body,
              r = t.getBoundingClientRect(),
              a = f.current.getBoundingClientRect(),
              n = f.current.offsetTop,
              s = n - r.height + a.height;
            (t.scrollTop > n || t.scrollTop < s) && (t.scrollTop = n - r.height / 2 + a.height / 2);
          }
        }, [t]);
        let w = r.versions.length > 0,
          C = r.languages.length > 0,
          N = r.tabs.length > 0;
        return (0, a.jsxs)("div", {
          ref: k,
          className: "relative lg:text-sm lg:leading-6",
          children: [
            !e &&
              (0, a.jsx)("div", {
                className: (0, m.cn)(
                  "sticky top-0 h-8",
                  p?.background?.image == null &&
                    p?.background?.decoration == null &&
                    "z-10 bg-gradient-to-b from-background-light dark:from-background-dark",
                ),
              }),
            e &&
              (0, a.jsxs)("div", {
                className: "flex items-center justify-between mb-6",
                children: [
                  (0, a.jsx)(x.l, { logoClassName: "max-w-48 h-[26px]" }),
                  !p?.appearance?.strict && (0, a.jsx)(u.U, {}),
                ],
              }),
            (0, a.jsxs)("div", {
              id: c.V.NavigationItems,
              children: [
                e &&
                  (0, a.jsx)(g.m4, {
                    className: (0, m.cn)(
                      "px-4 mb-2 rounded-[0.85rem] w-full border border-gray-200/70 dark:border-white/[0.07] h-10",
                      !w && !C && !N && "mb-6",
                    ),
                  }),
                e &&
                  (w || C || N) &&
                  (0, a.jsxs)("div", {
                    className: "flex flex-col gap-y-2 mb-6",
                    children: [
                      (0, a.jsx)(g.t7, {
                        triggerClassName:
                          "font-normal text-base justify-between pl-4 pr-3.5 h-10 rounded-[0.85rem] border border-gray-200/70 dark:border-white/[0.07] hover:bg-gray-600/5 dark:hover:bg-gray-200/5 gap-1.5",
                      }),
                      (0, a.jsx)(g.K2, {
                        triggerClassName:
                          "font-normal text-base justify-between pl-4 pr-3.5 h-10 rounded-[0.85rem] border border-gray-200/70 dark:border-white/[0.07] hover:bg-gray-600/5 dark:hover:bg-gray-200/5 gap-1.5",
                      }),
                      r.tabs.length > 0 && (0, a.jsx)(g.TJ, {}),
                    ],
                  }),
                (0, a.jsx)(g.Xt, {}),
                r.anchors.length > 0 && (0, a.jsx)(y, {}),
                j > 0 && (0, a.jsx)(v, { docsConfig: p, nav: r.groupsOrPages, mobile: e }),
              ],
            }),
          ],
        });
      }
    },
  },
]);
