(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [89841],
  {
    11533: (e, t, r) => {
      "use strict";
      (r.r(t), r.d(t, { NotFoundComponent: () => m, SupportLink: () => u }));
      var n = r(54568),
        s = r(19664),
        i = r.n(s),
        l = r(7620),
        o = r(30793),
        a = r(33052),
        d = r(81325),
        c = r(48622);
      function m({ content: e, recommendPages: t }) {
        let { docsConfig: r } = (0, l.useContext)(o.DocsConfigContext),
          s = r?.errors?.[404].title;
        return (0, n.jsxs)("div", {
          className: (0, d.cn)(
            "flex flex-col items-center justify-center w-full max-w-lg overflow-x-hidden mx-auto py-48 px-5 text-center *:text-center gap-y-8",
            a.x.NotFoundContainer,
          ),
          children: [
            (0, n.jsxs)("div", {
              className: "flex flex-col items-center justify-center gap-y-6",
              children: [
                (0, n.jsx)("span", {
                  id: "error-badge",
                  className: (0, d.cn)(
                    "inline-flex -mb-2 text-5xl font-semibold p-1 text-primary dark:text-primary-light",
                    a.x.NotFoundStatusCode,
                  ),
                  children: "404",
                }),
                (0, n.jsx)("h1", {
                  id: "error-title",
                  className: (0, d.cn)(
                    "font-medium mb-0 text-2xl text-gray-800 dark:text-gray-200",
                    a.x.NotFoundTitle,
                  ),
                  children: s ?? "Page Not Found",
                }),
                (0, n.jsx)("div", {
                  id: "error-description",
                  className: (0, d.cn)(
                    "flex flex-col items-center gap-y-6 prose prose-gray dark:prose-invert",
                    a.x.NotFoundDescription,
                  ),
                  children: e,
                }),
              ],
            }),
            (0, n.jsx)(c.RecommendedPagesList, { recommendPages: t }),
          ],
        });
      }
      function u() {
        return (0, n.jsx)(i(), {
          href: "mailto:support@mintlify.com",
          className:
            "font-medium text-gray-700 dark:text-gray-100 border-b hover:border-b-[2px] border-primary-dark dark:border-primary-light",
          children: "contact support",
        });
      }
    },
    14162: (e, t, r) => {
      "use strict";
      r.d(t, { CustomJsFiles: () => o });
      var n = r(54568),
        s = r(23792),
        i = r(7620),
        l = r(71252);
      function o({ jsFiles: e, customJsDisabled: t }) {
        let { isLivePreview: r } = (0, i.useContext)(l.K);
        return (
          !r &&
          !t &&
          e.map(({ content: e }, t) => (0, n.jsx)(s.default, { id: t.toString(), children: e }, t))
        );
      }
    },
    24441: (e, t, r) => {
      (Promise.resolve().then(r.bind(r, 11533)),
        Promise.resolve().then(r.bind(r, 42080)),
        Promise.resolve().then(r.bind(r, 30793)),
        Promise.resolve().then(r.bind(r, 97870)),
        Promise.resolve().then(r.bind(r, 70715)),
        Promise.resolve().then(r.bind(r, 91153)),
        Promise.resolve().then(r.bind(r, 14162)),
        Promise.resolve().then(r.bind(r, 59646)),
        Promise.resolve().then(r.t.bind(r, 45165, 23)));
    },
    48622: (e, t, r) => {
      "use strict";
      r.d(t, { RecommendedPagesList: () => a });
      var n = r(54568),
        s = r(7620),
        i = r(98167),
        l = r(33052),
        o = r(81325);
      function a({ recommendPages: e = [] }) {
        let t = (0, s.useMemo)(
          () => (t) =>
            (function (e, t) {
              let r = new Map();
              t.forEach((e) => {
                let t = r.get(e.title) || [];
                r.set(e.title, [...t, e]);
              });
              let n = r.get(e.title) || [];
              if (n.length <= 1 || !e.breadcrumbs || e.breadcrumbs.length <= 1) {
                return [];
              }
              let s = n.filter((e) => e.breadcrumbs && e.breadcrumbs.length > 1);
              if (s.length <= 1) {
                return [];
              }
              let i = 1,
                l = Math.max(...s.map((e) => (e.breadcrumbs?.length || 1) - 1));
              for (; i <= l; ) {
                let t = Math.max(0, e.breadcrumbs.length - 1 - i),
                  r = e.breadcrumbs.length - 1,
                  n = e.breadcrumbs.slice(t, r);
                if (
                  s
                    .filter((t) => t !== e)
                    .every((e) => {
                      if (!e.breadcrumbs || e.breadcrumbs.length <= 1) {
                        return !0;
                      }
                      let t = Math.max(0, e.breadcrumbs.length - 1 - i),
                        r = e.breadcrumbs.length - 1,
                        s = e.breadcrumbs.slice(t, r);
                      return n.join("/") !== s.join("/");
                    })
                ) {
                  return n;
                }
                i++;
              }
              return [];
            })(t, e),
          [e],
        );
        return e.length > 0
          ? (0, n.jsx)("div", {
              className: (0, o.cn)(l.x.NotFoundRecommendedPagesList, "w-full flex flex-col gap-3"),
              children: e.map((e, r) => {
                let s = e.link.startsWith("/") ? e.link : `/${e.link}`,
                  a =
                    i.c.BASE_PATH && s.startsWith(i.c.BASE_PATH)
                      ? s.slice(i.c.BASE_PATH.length)
                      : s;
                return (0, n.jsxs)(
                  "a",
                  {
                    href: `${i.c.BASE_PATH}${a}`,
                    className: (0, o.cn)(
                      l.x.NotFoundRecommendedPageLink,
                      "text-base text-primary dark:text-primary-light hover:brightness-[0.75] dark:hover:brightness-[1.35] text-center min-w-0 truncate",
                    ),
                    children: [
                      t(e).length > 0 &&
                        (0, n.jsxs)("span", { children: [t(e).join(" / "), " - "] }),
                      (0, n.jsx)("span", { children: e.title }),
                    ],
                  },
                  r,
                );
              }),
            })
          : (0, n.jsx)(n.Fragment, {});
      }
    },
  },
  (e) => {
    (e.O(
      0,
      [
        67903, 73473, 53016, 41725, 82431, 43881, 98816, 75321, 19664, 21246, 97374, 62767, 79845,
        68789, 18697, 73205, 14224, 61706, 86707, 25263, 69299, 587, 90018, 77358,
      ],
      () => e((e.s = 24441)),
    ),
      (_N_E = e.O()));
  },
]);
