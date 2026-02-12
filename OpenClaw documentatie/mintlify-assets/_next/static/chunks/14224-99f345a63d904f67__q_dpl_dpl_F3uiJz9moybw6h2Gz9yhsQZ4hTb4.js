(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [14224],
  {
    150: (e, t, r) => {
      "use strict";
      r.d(t, { X: () => p });
      var a = r(54568),
        n = r(7620),
        s = r(41363),
        i = r(76829),
        o = r(68999),
        l = r(73205),
        d = r(81325);
      let c = ({ type: e, title: t, content: r }) => {
          let [c, p] = (0, n.useState)(!1),
            u = (0, i.n)();
          return (0, a.jsxs)("div", {
            className: "border-t w-full border-zinc-100 dark:border-white/5",
            children: [
              (0, a.jsxs)("button", {
                "aria-label": u["aria.expandMessageSection"],
                "aria-expanded": c,
                onClick: () => p((e) => !e),
                className: "flex justify-between w-full px-3 py-2.5 items-center cursor-pointer",
                children: [
                  (0, a.jsxs)("div", {
                    className: "flex items-center gap-x-2",
                    children: [
                      (0, a.jsx)("div", {
                        className: "w-4 h-4",
                        children: "send" === e ? (0, a.jsx)(l.t9, {}) : (0, a.jsx)(l.Cc, {}),
                      }),
                      (0, a.jsx)("div", {
                        className:
                          "text-xs font-mono text-gray-600 dark:text-gray-400 whitespace-nowrap overflow-hidden text-ellipsis",
                        children: t,
                      }),
                    ],
                  }),
                  (0, a.jsx)(o.A, {
                    icon: "angle-right",
                    iconType: "solid",
                    className: (0, d.cn)(
                      "h-3 w-3 bg-gray-400 dark:bg-gray-600 transition-transform rotate-90",
                      c && "rotate-[-90deg]",
                    ),
                  }),
                ],
              }),
              (0, a.jsx)("div", {
                className: (0, d.cn)(
                  "bg-zinc-100 dark:bg-zinc-900 flex-1 px-4 divide-y divide-gray-100 dark:divide-white/5 text-xs",
                  c ? "" : "hidden",
                ),
                children: (0, a.jsx)("div", {
                  className: "overflow-scroll py-2",
                  tabIndex: 0,
                  role: "region",
                  "aria-label": u["aria.messageContent"],
                  children: (0, a.jsx)(s.z, { language: "json", children: r }),
                }),
              }),
            ],
          });
        },
        p = ({ name: e, messages: t, className: r, icon: n, rightElement: s, children: i }) =>
          (0, a.jsxs)("div", {
            className: (0, d.cn)(
              "w-full xl:w-[28rem] gap-6 grid grid-rows-[repeat(auto-fit,minmax(0,min-content))] grid-rows relative",
              r,
            ),
            children: [
              (0, a.jsx)("div", {
                className:
                  "flex w-full items-center justify-between border-standard border-t border-x rounded-t-2xl rounded-b-2xl overflow-scroll h-full max-h-[calc(100vh-11rem)]",
                children: (0, a.jsxs)("div", {
                  className: "flex flex-col w-full h-full",
                  children: [
                    (0, a.jsxs)("div", {
                      className: "flex items-center justify-between px-3",
                      children: [
                        (0, a.jsxs)("div", {
                          className: "flex items-center gap-x-2",
                          children: [
                            n && n,
                            (0, a.jsx)("div", {
                              className:
                                "text-sm font-medium text-gray-800 dark:text-gray-200 leading-6 py-2",
                              children: e,
                            }),
                          ],
                        }),
                        (0, a.jsx)("div", { className: "flex items-center", children: s && s }),
                      ],
                    }),
                    t.map((e) =>
                      (0, a.jsx)(c, { type: e.type, title: e.title, content: e.content }, e.id),
                    ),
                  ],
                }),
              }),
              i,
            ],
          });
    },
    178: (e, t, r) => {
      "use strict";
      r.d(t, { j: () => ad });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        i = r(6723),
        o = r(84941),
        l = r(5904),
        d = r(76829),
        c = r(33052),
        p = r(68999),
        u = r(81325);
      let m = ({
        label: e,
        method: t,
        onClick: r,
        isSending: n,
        className: s,
        icon: i,
        disabled: o,
      }) => {
        let { activeNavPillBg: m, activeNavPillText: h } = (0, l.H)(t),
          x = (0, d.n)();
        return (0, a.jsx)("button", {
          "aria-label": n ? x["aria.sendingRequest"] : e,
          className: (0, u.cn)(
            c.x.TryitButton,
            "flex items-center justify-center px-3 h-9 font-medium rounded-xl mouse-pointer hover:opacity-80 gap-1.5",
            m,
            h,
            s,
            (o || n) && "opacity-50 hover:opacity-50 cursor-not-allowed pointer-events-none",
          ),
          onClick: r,
          disabled: n || o,
          "data-testid": "try-it-button",
          children: n
            ? (0, a.jsx)(p.A, {
                icon: "spinner-third",
                iconType: "duotone",
                className: "w-4 h-4 bg-white animate-spin",
              })
            : (0, a.jsxs)(a.Fragment, {
                children: [
                  (0, a.jsx)("span", { children: e }),
                  i ||
                    (0, a.jsx)(p.A, {
                      icon: "play",
                      iconType: "solid",
                      className: "w-3 h-3 bg-white",
                    }),
                ],
              }),
        });
      };
      var h = r(40599),
        x = r(840),
        g = r(12145),
        f = r(37914),
        y = r(22652),
        b = r(16903),
        v = r(50519);
      let j = ({ markdown: e, className: t }) =>
          e
            ? (0, a.jsx)(v.o, {
                mode: "static",
                className: (0, u.cn)(
                  "prose prose-sm prose-gray dark:prose-invert overflow-wrap-anywhere [&_*]:overflow-wrap-anywhere",
                  "[&_li_p.whitespace-pre-line]:!my-0 [&_li.py-1]:!py-0 [&_li.py-1]:!my-2",
                  t,
                ),
                children: e,
              })
            : null,
        k = ({ markdown: e, className: t }) =>
          (0, a.jsx)(v.w, {
            mode: "static",
            className: (0, u.cn)(
              "prose prose-sm prose-gray dark:prose-invert overflow-wrap-anywhere [&_*]:overflow-wrap-anywhere",
              "[&_li_p.whitespace-pre-line]:!my-0 [&_li.py-1]:!py-0 [&_li.py-1]:!my-2",
              t,
            ),
            children: e,
          });
      function w({ example: e }) {
        return (0, a.jsx)(j, {
          className: "overflow-wrap-anywhere text-[13px] [&_*]:text-[13px]",
          markdown:
            "object" == typeof e && null !== e
              ? `\`\`\`json
${(function (e, t = 45) {
  return (function e(t, r, a, n) {
    return null === t
      ? "null"
      : void 0 === t
        ? "undefined"
        : "string" == typeof t
          ? JSON.stringify(t)
          : "number" == typeof t || "boolean" == typeof t
            ? String(t)
            : Array.isArray(t)
              ? (function (t, r, a, n) {
                  if (0 === t.length) {
                    return "[]";
                  }
                  let s = "[" + t.map((t) => e(t, r, a, n)).join(", ") + "]";
                  if (s.length <= r) {
                    return s;
                  }
                  a++;
                  let i =
                    "[\n" +
                    t.map((t) => n.repeat(a) + e(t, r, a, n)).join(",\n") +
                    "\n" +
                    n.repeat(a - 1) +
                    "]";
                  return (a--, i);
                })(t, r, a, n)
              : "object" == typeof t && null !== t
                ? (function (t, r, a, n) {
                    let s = Object.keys(t);
                    if (0 === s.length) {
                      return "{}";
                    }
                    let i =
                      "{ " +
                      s.map((s) => `${JSON.stringify(s)}: ${e(t[s], r, a, n)}`).join(", ") +
                      " }";
                    if (i.length <= r) {
                      return i;
                    }
                    a++;
                    let o =
                      "{\n" +
                      s
                        .map((s) => n.repeat(a) + `${JSON.stringify(s)}: ${e(t[s], r, a, n)}`)
                        .join(",\n") +
                      "\n" +
                      n.repeat(a - 1) +
                      "}";
                    return (a--, o);
                  })(t, r, a, n)
                : String(t);
  })(e, t, 0, "  ");
})(e)}
\`\`\``
              : `\`${"null" === e ? null : JSON.stringify(e, void 0, 2)}\``,
        });
      }
      let N = ({ schema: e }) => {
        let t = (0, d.n)(),
          r = e.example,
          n =
            void 0 !== e.examples
              ? Array.isArray(e.examples)
                ? e.examples
                : [e.examples]
              : void 0,
          s = void 0 !== r || (void 0 !== n && n.length > 0),
          i = n && n.length > 1 ? t["api.examples"] : t["api.example"];
        return (
          s &&
          (0, a.jsxs)("div", {
            className: (0, u.cn)(
              "flex prose prose-sm prose-gray dark:prose-invert mt-6 gap-1.5",
              ("object" == typeof r || "object" == typeof n?.[0]) && "flex-col gap-y-3",
            ),
            children: [
              (0, a.jsxs)("span", { children: [i, ":"] }),
              void 0 !== n
                ? (0, a.jsx)("div", {
                    className: (0, u.cn)(
                      "*:my-2",
                      "object" != typeof n[0] && "inline *:mr-2 [&_*]:inline",
                    ),
                    children: n.map((e, t) => (0, a.jsx)(w, { example: e }, t)),
                  })
                : (0, a.jsx)(w, { example: r }),
            ],
          })
        );
      };
      function C({ paramId: e, children: t, noBorder: r = !1, className: n }) {
        return (0, a.jsx)(
          "div",
          {
            className: (0, u.cn)(
              n,
              r ? "" : "border-gray-100 dark:border-gray-800 border-b last:border-b-0",
            ),
            children: t,
          },
          e,
        );
      }
      var S = r(8657);
      let O = ({
          displayFlattened: e = !1,
          fieldType: t,
          schema: r,
          name: n,
          location: s,
          parentName: i,
          typeOptions: o,
          selectedIndex: l,
          onSelectTypeOption: d,
          paramId: c,
          style: p,
          explode: m,
          required: h,
          schemas: x,
          omitPadding: g,
          hideName: f,
        }) => {
          if (!(0, b.DZ)(r)) {
            return null;
          }
          let y = o?.[l ?? 0] ?? "unknown",
            v = r.items,
            k = (0, b.B2)(r.items),
            w = e && !k ? (r.description ?? `The ${t} is of type \`${y}\`.`) : r.description,
            O = (0, b.Fy)(r.items) && "object" === r.items.type;
          return (0, a.jsx)(C, {
            paramId: c,
            className: "array-param-field",
            children: (0, a.jsxs)("div", {
              className: (0, u.cn)(!e && !g && "py-6"),
              children: [
                (0, a.jsx)(S.ob, {
                  id: c,
                  name: f ? void 0 : n,
                  location: s,
                  required: h ?? !1,
                  deprecated: r.deprecated,
                  typeLabel: y,
                  fieldType: t,
                  typeOptions: o,
                  selectedTypeOptionIndex: l,
                  onSelectTypeOption: d,
                  parentName: i,
                  style: p,
                  explode: m,
                }),
                (0, a.jsxs)("div", {
                  className: (0, u.cn)({ "mt-4": !g && w }),
                  children: [
                    n && w && (0, a.jsx)(j, { markdown: w }),
                    (0, a.jsx)($, { schema: r, description: w }),
                    (0, b.Fy)(v) &&
                      (0, a.jsx)(H, {
                        omitPadding: !0,
                        schema: v,
                        displayFlattened: e,
                        fieldType: t,
                        location: s,
                        name: n,
                        parentName: i,
                        style: p,
                        explode: m,
                        onSelectTypeOption: d,
                        schemas: x,
                        hideExampleDescription: !0,
                        hideDescription: O,
                        hideName: !0,
                      }),
                    (0, a.jsx)(N, { schema: r }),
                  ],
                }),
              ],
            }),
          });
        },
        $ = ({ schema: e, description: t }) =>
          (0, a.jsx)(a.Fragment, {
            children:
              (void 0 !== e.minItems || void 0 !== e.maxItems) &&
              (0, a.jsx)("div", {
                className: (0, u.cn)("prose prose-sm prose-gray dark:prose-invert", t && "mt-6"),
                children: (0, a.jsx)(T, { minItems: e.minItems, maxItems: e.maxItems }),
              }),
          }),
        T = ({ minItems: e, maxItems: t }) =>
          e === t && void 0 !== e
            ? (0, a.jsxs)(a.Fragment, {
                children: [
                  "Required array length: ",
                  (0, a.jsx)("code", { children: e }),
                  " element",
                  e > 1 ? "s" : "",
                ],
              })
            : e && t
              ? (0, a.jsxs)(a.Fragment, {
                  children: [
                    "Required array length: ",
                    (0, a.jsx)("code", { children: `${e} - ${t}` }),
                    " element",
                    t > 1 ? "s" : "",
                  ],
                })
              : e
                ? (0, a.jsxs)(a.Fragment, {
                    children: ["Minimum array length: ", (0, a.jsx)("code", { children: e })],
                  })
                : t
                  ? (0, a.jsxs)(a.Fragment, {
                      children: ["Maximum array length: ", (0, a.jsx)("code", { children: t })],
                    })
                  : "";
      var E = r(42945);
      let A = ({ options: e, selectedIndex: t, onSelectOption: r }) =>
        (0, a.jsx)("div", {
          className: "-mt-2",
          children: (0, a.jsx)(E.t, {
            defaultTabIndex: t,
            onClickTab: r,
            className: "!border-gray-100 !mb-4 dark:!border-white/10",
            children: e.map((e) => (0, a.jsx)(E.o, { title: e }, e)),
          }),
        });
      var P = r(51637),
        I = r(84583);
      let _ = ({
        fieldType: e,
        schema: t,
        name: r,
        location: i,
        parentName: o,
        typeOptions: l,
        selectedIndex: d,
        onSelectTypeOption: c,
        paramId: p,
        style: m,
        explode: h,
        required: x,
        displayFlattened: g = !1,
        schemas: f,
        oneOfOptions: y,
        lazy: v,
        omitPadding: k = !1,
        hideDescription: w,
        hideExampleDescription: O,
        hideName: $,
      }) => {
        let { properties: T, additionalProperties: E } = (function (e) {
            return "object" !== e.type
              ? { properties: void 0, additionalProperties: void 0 }
              : { properties: e.properties, additionalProperties: e.additionalProperties };
          })(t),
          P = (() => {
            let { docsConfig: e } = (0, n.useContext)(s.DocsConfigContext);
            return e?.api?.params?.expanded;
          })(),
          { anchor: _ } = (0, I.ad)(),
          F = !!(p && _?.includes(p)),
          R = "all" === P || F || g,
          L = (0, b.B2)(t),
          D = (0, b.fo)(t),
          M = !!g,
          B = M && !L ? (t.description ?? `The ${e} is of type \`${D}\`.`) : t.description,
          U = !!y,
          z = !!B,
          V = !g,
          K = z && M !== U,
          W = z && !K;
        return (0, a.jsx)(C, {
          noBorder: O,
          paramId: p,
          className: "object-param-field",
          children: (0, a.jsxs)("div", {
            className: (0, u.cn)(!M && !k && "py-6"),
            children: [
              (0, a.jsx)(S.ob, {
                id: p,
                name: $ ? void 0 : r,
                location: i,
                required: x ?? !1,
                deprecated: t.deprecated,
                typeLabel: D,
                fieldType: e,
                typeOptions: l ?? [D],
                selectedTypeOptionIndex: d,
                onSelectTypeOption: c,
                parentName: o,
                style: m,
                explode: h,
              }),
              (0, a.jsxs)("div", {
                className: (0, u.cn)({ "mt-4": !k && (z || L) }),
                children: [
                  K && !w && (0, a.jsx)(j, { markdown: B }),
                  (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      U && "mt-4",
                      U &&
                        !M &&
                        "rounded-xl border border-gray-100 px-4 pb-4 pt-2 dark:border-white/10",
                    ),
                    children: [
                      U && (0, a.jsx)(A, { selectedIndex: d, options: y, onSelectOption: c }),
                      W &&
                        !w &&
                        (0, a.jsx)("div", {
                          className: (0, u.cn)(U && M && "pt-6 pb-4"),
                          children: (0, a.jsx)(j, { markdown: B }),
                        }),
                      L &&
                        (0, a.jsx)("div", {
                          className: (0, u.cn)(U && !M && "-mt-4"),
                          children: (0, a.jsx)(q, {
                            expandable: V,
                            defaultOpen: R,
                            lazy: v ?? !R,
                            uniqueParamId: p,
                            children: (0, a.jsxs)(a.Fragment, {
                              children: [
                                T &&
                                  Object.entries(T).map(([t, n]) => {
                                    let s =
                                      "deepObject" === m && h
                                        ? (0, b.zP)(r ?? void 0, o)
                                        : (0, b.ib)(r ?? void 0, o);
                                    return (0, a.jsx)(
                                      H,
                                      {
                                        schema: n,
                                        name: t,
                                        required: n.isRequired,
                                        fieldType: e,
                                        location: i,
                                        parentName: s,
                                        style: m,
                                        explode: h,
                                        onSelectTypeOption: c,
                                        schemas: f,
                                      },
                                      t,
                                    );
                                  }),
                                "object" == typeof E &&
                                  ((0, b.Fy)(E) || (0, b.FS)(E)) &&
                                  (0, a.jsx)(
                                    H,
                                    {
                                      schema: E,
                                      name: "{key}",
                                      required: E.isRequired,
                                      fieldType: e,
                                      location: i,
                                      parentName: (0, b.ib)(r ?? void 0, o),
                                      style: m,
                                      explode: h,
                                      onSelectTypeOption: c,
                                      schemas: f,
                                    },
                                    "{key}",
                                  ),
                              ],
                            }),
                          }),
                        }),
                      V && !O && (0, a.jsx)(N, { schema: t }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        });
      };
      function q({ expandable: e, children: t, ...r }) {
        return e ? (0, a.jsx)(P.V, { ...r, children: t }) : (0, a.jsx)(a.Fragment, { children: t });
      }
      let F = ({ schema: e }) => {
          let t = (0, d.n)(),
            r = "boolean" === e.type ? ["true", "false"] : e.enum;
          return r && 0 !== r.length
            ? (0, a.jsxs)("div", {
                className: "whitespace-pre-wrap prose-sm mt-6",
                children: [
                  t.availableOptions,
                  ":",
                  " ",
                  r.map((e, t) =>
                    (0, a.jsxs)(
                      "div",
                      {
                        className: "inline-block",
                        children: [
                          (0, a.jsx)("code", { children: e }),
                          t !== r.length - 1 && ",",
                          " ",
                        ],
                      },
                      `${e}-${t}`,
                    ),
                  ),
                ],
              })
            : null;
        },
        R = ({ enumTable: e }) => {
          let t = (0, d.n)();
          return (0, a.jsxs)("div", {
            className: "whitespace-pre-wrap prose prose-sm mt-6",
            children: [
              t.availableOptions,
              ":",
              (0, a.jsxs)("table", {
                className: "w-min max-w-full text-sm not-prose",
                children: [
                  (0, a.jsxs)("tr", {
                    children: [
                      (0, a.jsx)("th", { className: "text-left", children: t["api.title"] }),
                      (0, a.jsx)("th", { children: t["api.const"] }),
                    ],
                  }),
                  e.map(({ title: e, const: t }) =>
                    (0, a.jsxs)(
                      "tr",
                      {
                        children: [
                          (0, a.jsx)("td", { children: e }),
                          (0, a.jsx)("td", { children: (0, a.jsx)("code", { children: t }) }),
                        ],
                      },
                      e,
                    ),
                  ),
                ],
              }),
            ],
          });
        },
        L = ({ schema: e }) => {
          let t = e.exclusiveMinimum || void 0 !== e.exclusiveMinimum,
            r = e.exclusiveMaximum || void 0 !== e.exclusiveMaximum,
            n = (0, d.n)(),
            s = "";
          return (void 0 !== e.maximum && (s = `x ${r ? "<" : "<="} ${e.maximum}`),
          void 0 !== e.minimum && (s = `x ${t ? ">" : ">="} ${e.minimum}`),
          void 0 !== e.maximum &&
            void 0 !== e.minimum &&
            (s = `${e.minimum} ${t ? "<" : "<="} x ${r ? "<" : "<="} ${e.maximum}`),
          "" === s && void 0 === e.multipleOf)
            ? null
            : (0, a.jsxs)("div", {
                className: "prose prose-sm prose-gray dark:prose-invert mt-6",
                children: [
                  s &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [n.requiredRange, ": ", (0, a.jsx)("code", { children: s })],
                    }),
                  e.multipleOf &&
                    (0, a.jsxs)(a.Fragment, {
                      children: [
                        n["api.mustBeMultipleOf"],
                        " ",
                        (0, a.jsx)("code", { children: e.multipleOf }),
                      ],
                    }),
                ],
              });
        },
        D = ({ schema: e, description: t }) =>
          (0, a.jsxs)(a.Fragment, {
            children: [
              "const" in e &&
                void 0 !== e.const &&
                (0, a.jsxs)("div", {
                  className: (0, u.cn)("prose prose-sm prose-gray dark:prose-invert", t && "mt-6"),
                  children: ["Allowed value: ", (0, a.jsx)("code", { children: `"${e.const}"` })],
                }),
              (void 0 !== e.minLength || void 0 !== e.maxLength) &&
                (0, a.jsx)("div", {
                  className: (0, u.cn)("prose prose-sm prose-gray dark:prose-invert", t && "mt-6"),
                  children: (0, a.jsx)(M, { minLength: e.minLength, maxLength: e.maxLength }),
                }),
            ],
          }),
        M = ({ minLength: e, maxLength: t }) =>
          e === t && void 0 !== e
            ? (0, a.jsxs)(a.Fragment, {
                children: ["Required string length: ", (0, a.jsx)("code", { children: e })],
              })
            : e && t
              ? (0, a.jsxs)(a.Fragment, {
                  children: [
                    "Required string length: ",
                    (0, a.jsx)("code", { children: `${e} - ${t}` }),
                  ],
                })
              : e
                ? (0, a.jsxs)(a.Fragment, {
                    children: ["Minimum string length: ", (0, a.jsx)("code", { children: e })],
                  })
                : t
                  ? (0, a.jsxs)(a.Fragment, {
                      children: ["Maximum string length: ", (0, a.jsx)("code", { children: t })],
                    })
                  : "",
        B = ({
          fieldType: e,
          schema: t,
          name: r,
          location: n,
          typeOptions: s,
          selectedIndex: i,
          onSelectTypeOption: o,
          parentName: l,
          paramId: d,
          style: c,
          explode: p,
          enumTable: m,
          omitPadding: h,
          hideExampleDescription: x,
          isTopLevel: g,
          hideName: f,
        }) => {
          let y = s?.[i ?? 0] ?? "unknown",
            v = g ? (t.description ?? `The ${e} is of type \`${y}\`.`) : t.description;
          return (0, a.jsx)(C, {
            noBorder: x,
            paramId: d,
            className: "primitive-param-field",
            children: (0, a.jsxs)("div", {
              className: (0, u.cn)(!h && "py-6"),
              children: [
                (0, a.jsx)(S.ob, {
                  id: d,
                  name: f ? void 0 : r,
                  typeLabel: y,
                  location: n,
                  fieldType: e,
                  required: t.isRequired,
                  deprecated: t.deprecated,
                  defaultValue: t.default,
                  typeOptions: s,
                  selectedTypeOptionIndex: i,
                  onSelectTypeOption: o,
                  parentName: l,
                  style: c,
                  explode: p,
                }),
                (0, a.jsxs)("div", {
                  className: (0, u.cn)({ "mt-4": !h && (v || (0, b.GG)(t)) }),
                  children: [
                    v && (0, a.jsx)(j, { className: (0, u.cn)(x && "py-4"), markdown: v }),
                    m && (0, a.jsx)(R, { enumTable: m }),
                    !m && (0, b.GG)(t) && (0, a.jsx)(F, { schema: t }),
                    (0, b.z4)(t) && (0, a.jsx)(D, { schema: t, description: v }),
                    (0, b.TU)(t) && (0, a.jsx)(L, { schema: t }),
                    !x && (0, a.jsx)(N, { schema: t }),
                  ],
                }),
              ],
            }),
          });
        },
        H = ({
          schema: e,
          omitPadding: t,
          name: r,
          displayFlattened: n = !1,
          typeOptions: s,
          fieldType: i,
          location: o,
          parentName: l,
          style: d,
          explode: c,
          required: p,
          onSelectTypeOption: u,
          selectedIndex: m,
          schemas: h,
          enumTable: x,
          hideExampleDescription: g,
          hideDescription: v,
          isTopLevel: j = !1,
          hideName: k = !1,
        }) => {
          let w = (0, y.Gb)(e, i, r, l);
          if ((0, b.FS)(e)) {
            let n = e[f.aZ],
              u = h?.[n];
            return u
              ? (0, a.jsx)(_, {
                  lazy: !0,
                  omitPadding: t,
                  schema: { ...u, description: e.description },
                  typeOptions: s,
                  fieldType: i,
                  name: r,
                  location: o,
                  parentName: l,
                  style: d,
                  explode: c,
                  required: p,
                  schemas: h,
                  paramId: w,
                  hideName: k,
                })
              : null;
          }
          if (e.oneOf && Array.isArray(e.oneOf) && e.oneOf.length > 0) {
            let s,
              x = e.oneOf.filter((e) => (0, b.Fy)(e));
            if (0 === x.length) {
              return null;
            }
            if (
              (x.some((e) => (0, b.GG)(e) && "const" in e) &&
                (s = (x = (0, b.vN)(x))
                  .filter((e) => (0, b.GG)(e) && "const" in e)
                  .map((e) => ({ title: e.title ?? "Unknown", const: e.const ?? "" }))),
              1 === x.length && x[0]?.type === "null" && x[0])
            ) {
              return (0, a.jsx)(B, {
                omitPadding: t,
                fieldType: i,
                enumTable: s,
                schema: e,
                name: r,
                location: o,
                parentName: l,
                selectedIndex: m,
                onSelectTypeOption: u,
                style: d,
                explode: c,
                required: p,
                paramId: w,
                hideExampleDescription: g,
                isTopLevel: j,
                hideName: k,
              });
            }
            let f = x.filter((e) => "null" !== e.type),
              y = x.some((e) => "null" === e.type),
              v = (0, b.FJ)(f);
            if (1 === f.length && f[0]) {
              let s = y && e.typeLabel ? [e.typeLabel] : v;
              return (0, a.jsx)(H, {
                schema: f[0],
                omitPadding: t,
                displayFlattened: n,
                typeOptions: s,
                fieldType: i,
                name: r,
                location: o,
                parentName: l,
                style: d,
                explode: c,
                required: p,
                schemas: h,
                hideName: k,
              });
            }
            if (f.every((e) => "object" === e.type || (0, b.Rr)(e))) {
              return (0, a.jsx)(z, {
                omitPadding: t,
                schema: e,
                schemas: f,
                displayFlattened: n,
                typeOptions: ["object"],
                fieldType: i,
                name: r,
                location: o,
                style: d,
                explode: c,
                parentName: l,
                required: p,
                paramId: w,
                hideName: k,
              });
            }
            {
              let e = f[m ?? 0];
              return e
                ? (0, a.jsx)(U, {
                    omitPadding: t,
                    schemas: f,
                    schema: e,
                    enumTable: s,
                    displayFlattened: n,
                    typeOptions: v,
                    fieldType: i,
                    name: r,
                    location: o,
                    style: d,
                    explode: c,
                    required: p,
                    selectedIndex: m,
                    parentName: l,
                    onSelectTypeOption: u,
                    hideName: k,
                  })
                : null;
            }
          }
          let N = (0, b.FJ)([e]);
          return "array" !== e.type && "object" !== e.type
            ? (0, a.jsx)(B, {
                omitPadding: t,
                fieldType: i,
                enumTable: x,
                schema: e,
                typeOptions: s ?? N,
                name: r,
                location: o,
                parentName: l,
                selectedIndex: m,
                onSelectTypeOption: u,
                style: d,
                explode: c,
                required: p,
                paramId: w,
                hideExampleDescription: g,
                isTopLevel: j,
                hideName: k,
              })
            : "object" === e.type
              ? (0, a.jsx)(_, {
                  omitPadding: t,
                  displayFlattened: n,
                  fieldType: i,
                  schema: e,
                  typeOptions: s ?? N,
                  name: r,
                  location: o,
                  parentName: l,
                  selectedIndex: m,
                  onSelectTypeOption: u,
                  style: d,
                  explode: c,
                  required: p,
                  schemas: h,
                  paramId: w,
                  hideDescription: v,
                  hideExampleDescription: g,
                  hideName: k,
                })
              : "array" === e.type
                ? (0, a.jsx)(O, {
                    omitPadding: t,
                    displayFlattened: n,
                    fieldType: i,
                    schema: e,
                    typeOptions: s ?? N,
                    name: r,
                    location: o,
                    parentName: l,
                    selectedIndex: m,
                    onSelectTypeOption: u,
                    style: d,
                    explode: c,
                    required: p,
                    schemas: h,
                    paramId: w,
                    hideName: k,
                  })
                : void 0;
        };
      function U({ schemas: e, ...t }) {
        let [r, s] = (0, n.useState)(0),
          i = e[r];
        return i
          ? (0, a.jsx)(H, { ...t, selectedIndex: r, onSelectTypeOption: s, schema: i })
          : null;
      }
      function z({ schemas: e, paramId: t, ...r }) {
        let [s, i] = (0, n.useState)(0),
          o = e[s];
        if (((0, b.Rr)(o) && (o = o.items), !o)) {
          return null;
        }
        let l = (0, b.FJ)(e),
          d = t ?? (0, y.Gb)(o, r.fieldType, r.name, r.parentName);
        return (0, a.jsx)(_, {
          ...r,
          oneOfOptions: l,
          schema: o,
          selectedIndex: s,
          onSelectTypeOption: i,
          paramId: d,
        });
      }
      var V = r(91619),
        K = r(28835);
      let W = ({
          title: e,
          subtitle: t,
          rightElement: r,
          options: n,
          selectedIndex: s,
          onSelectOption: i,
          withPadding: o = !1,
          children: l,
        }) =>
          (0, a.jsxs)("div", {
            className: (0, u.cn)(c.x.APISectionHeading, "flex flex-col gap-y-4 w-full"),
            children: [
              (0, a.jsxs)("div", {
                className:
                  "flex items-baseline border-b pb-2.5 border-gray-100 dark:border-gray-800 w-full",
                children: [
                  (0, a.jsx)("h4", {
                    className: (0, u.cn)(c.x.APISectionHeadingTitle, "flex-1 mb-0"),
                    children: e,
                  }),
                  n &&
                    n.length > 1 &&
                    (0, a.jsx)(K.b, {
                      options: n,
                      selectedIndex: s,
                      onSelectOption: i,
                      noBackground: !0,
                    }),
                  (0, a.jsx)("div", {
                    className: "flex items-center",
                    children:
                      r &&
                      ("string" == typeof r
                        ? (0, a.jsx)("div", {
                            className:
                              "font-mono px-2 py-0.5 text-xs font-medium text-gray-600 dark:text-gray-300",
                            children: r,
                          })
                        : r),
                  }),
                ],
              }),
              l,
              t
                ? (0, a.jsx)("div", {
                    className: (0, u.cn)(
                      c.x.APISectionHeadingSubtitle,
                      "text-sm prose prose-gray dark:prose-invert mb-2",
                    ),
                    children: (0, a.jsx)(j, { markdown: t }),
                  })
                : o
                  ? (0, a.jsx)("div", {})
                  : null,
            ],
          }),
        G = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            { selectedRequestBodyContentTypeIndex: r, setSelectedRequestBodyContentTypeIndex: n } =
              (0, V.d)(),
            s = e.dependencies?.requestBody,
            i = s?.description,
            o = Object.keys(s?.content ?? {}),
            l = Object.fromEntries(
              o.map((e) => [e, s?.content[e]?.schema]).filter((e) => void 0 !== e[1]),
            ),
            p = e.dependencies?.schemas,
            m = Object.values(l)[r];
          return void 0 === m
            ? null
            : (0, a.jsxs)("div", {
                className: (0, u.cn)(c.x.APISection),
                children: [
                  o.length > 1
                    ? (0, a.jsx)(W, {
                        title: t["api.body"],
                        options: o,
                        selectedIndex: r,
                        onSelectOption: n,
                        subtitle: i,
                        withPadding: !i,
                      })
                    : (0, a.jsx)(W, {
                        title: t["api.body"],
                        rightElement: o[0],
                        subtitle: i,
                        withPadding: !i,
                      }),
                  (0, a.jsx)(H, {
                    schema: m,
                    fieldType: "body",
                    displayFlattened: !0,
                    omitPadding: !0,
                    schemas: p,
                    isTopLevel: !0,
                  }),
                ],
              });
        },
        J = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            r = (0, n.useMemo)(
              () => e.dependencies?.parameters ?? {},
              [e.dependencies?.parameters],
            ),
            s = e.dependencies?.schemas,
            i = (0, n.useMemo)(() => {
              let e = { header: {}, path: {}, query: {}, cookie: {} };
              return (
                Object.entries(r).forEach(([t, r]) => {
                  let a = r.in;
                  a in e && e[a] && (e[a][r.name] = r);
                }),
                e
              );
            }, [r]);
          return (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)(Z, { title: t["api.headers"], parameters: i.header ?? {}, schemas: s }),
              (0, a.jsx)(Z, {
                title: t["api.pathParameters"],
                parameters: i.path ?? {},
                schemas: s,
              }),
              (0, a.jsx)(Z, {
                title: t["api.queryParameters"],
                parameters: i.query ?? {},
                schemas: s,
              }),
              (0, a.jsx)(Z, { title: t["api.cookies"], parameters: i.cookie ?? {}, schemas: s }),
            ],
          });
        },
        Z = ({ parameters: e, title: t, schemas: r }) => {
          if (0 === Object.keys(e).length) {
            return null;
          }
          let n = Object.entries(e).map(([e, t]) =>
            t.schema && (0, b.Fy)(t.schema)
              ? (0, a.jsx)(
                  H,
                  {
                    schema: t.schema,
                    fieldType: "parameter",
                    name: t.name,
                    style: t.style,
                    explode: t.explode,
                    required: t.required,
                    schemas: r,
                  },
                  t.name,
                )
              : null,
          );
          return (0, a.jsxs)("div", {
            className: (0, u.cn)(c.x.APISection),
            children: [(0, a.jsx)(W, { title: t }), n],
          });
        };
      var X = r(61755),
        Y = r(72116),
        Q = r(6472);
      function ee(e) {
        if (e) {
          return e.schema.deprecated ? `${e.label}, deprecated` : e.label;
        }
      }
      let et = ({ options: e, selectedIndex: t, onSelectOption: r, className: n }) => {
        let s = e.length > 1,
          i = e[t];
        return (0, a.jsx)("div", {
          className: (0, u.cn)(
            "relative flex items-center px-2 py-0.5 text-gray-600 dark:text-gray-300 hover:text-gray-950 dark:hover:text-white font-medium",
            n,
          ),
          children: (0, a.jsxs)(Q.DropdownMenu, {
            children: [
              (0, a.jsx)(Q.DropdownMenuTrigger, {
                disabled: !s,
                className:
                  "font-mono text-xs text-gray-600 dark:text-gray-300 hover:text-gray-950 dark:hover:text-white",
                children: (0, a.jsxs)("div", {
                  className: "flex items-center gap-1.5",
                  children: [
                    (0, a.jsx)("span", { children: ee(i) }),
                    s &&
                      (0, a.jsx)(Y.A, {
                        className: "h-2.5 w-2.5 text-gray-500 dark:text-gray-400 shrink-0",
                      }),
                  ],
                }),
              }),
              (0, a.jsx)(Q.DropdownMenuContent, {
                className: "min-w-24",
                children: e.map((e, n) =>
                  (0, a.jsx)(
                    Q._,
                    {
                      isSelected: n === t,
                      onSelect: () => r(n),
                      className: "text-xs",
                      children: ee(e),
                    },
                    n,
                  ),
                ),
              }),
            ],
          }),
        });
      };
      var er = r(54368),
        ea = r(22300);
      let en = (e, ...t) =>
        [e.map((e) => e.replace("\\", "\\\\").replace("/", "\\/")).join("/"), ...t].join("\n");
      class es extends Error {
        constructor(e, ...t) {
          (super(en(e, ...t)),
            (this.name = "InvalidSchemaError"),
            Object.setPrototypeOf(this, es.prototype));
        }
      }
      class ei extends Error {
        constructor(e, ...t) {
          (super(en(e, ...t)),
            (this.name = "ImpossibleSchemaError"),
            Object.setPrototypeOf(this, ei.prototype));
        }
      }
      class eo extends Error {
        constructor(e, ...t) {
          (super(en(e, ...t)),
            (this.name = "ConversionError"),
            Object.setPrototypeOf(this, eo.prototype));
        }
      }
      class el {
        constructor(e = !1) {
          this.safeParse = e;
        }
        handleExistingError(e, t, ...r) {
          if (this.safeParse) {
            console.error(en(t, ...r), e);
          } else {
            throw e;
          }
        }
        handleNewError(e, t, ...r) {
          if (this.safeParse) {
            console.error(en(t, ...r));
          } else {
            throw new e(t, ...r);
          }
        }
      }
      let ed = new Set(["binary", "base64"]),
        ec = ["multipart/form-data", "application/json", "application/x-www-form-urlencoded"];
      function ep(e, t, r, a = 5) {
        let n = `#/components/${e}/`;
        if (!t.startsWith(n)) return;
        let s = t.slice(n.length),
          i = null == r ? void 0 : r[s];
        return i && "$ref" in i
          ? a > 0 && "string" == typeof i.$ref
            ? ep(e, i.$ref, r, a - 1)
            : void 0
          : i;
      }
      let eu = (e, t, r) => {
          void 0 !== t && (r[e] = t);
        },
        em = (e, t, r) => {
          void 0 !== t[e] && (r[e] = t[e]);
        },
        eh = (e, t) => {
          var r;
          let a = void 0 !== e.example ? e.example : null == (r = e.examples) ? void 0 : r[0];
          void 0 !== a && (t.example = a);
        };
      function ex(e, t) {
        var r;
        if ("object" == typeof e && void 0 !== t) {
          if (e.discriminator && e.discriminator.mapping) {
            let a = e.discriminator.mapping;
            if (t in a && (null == (r = a[t]) ? void 0 : r.description)) return a[t].description;
          }
          if (Array.isArray(e)) {
            for (let r of e) {
              let e = ex(r, t);
              if (e) return e;
            }
            return;
          }
          if ("type" in e && e.type === t && "description" in e && "string" == typeof e.description)
            return e.description;
          for (let [r, a] of Object.entries(e)) {
            if (
              r === t &&
              "object" == typeof a &&
              null !== a &&
              "description" in a &&
              "string" == typeof a.description
            )
              return a.description;
            let e = ex(a, t);
            if (e) return e;
          }
        }
      }
      let eg = (e, t, r, a) => {
          var n;
          return void 0 !== e[r] && void 0 !== t[r] ? a(e[r], t[r]) : null != (n = e[r]) ? n : t[r];
        },
        ef = (e, t, r, a) => {
          eu(e, eg(t, r, e, a), r);
        };
      function ey(e) {
        let t = e.discriminator;
        if (null == t || !t.mapping) return !1;
        {
          let r = Object.values(t.mapping).map((e) => e),
            a = [];
          ("allOf" in e &&
            Array.isArray(e.allOf) &&
            e.allOf.forEach((e) => {
              "$ref" in e && a.push(e.$ref);
            }),
            "oneOf" in e &&
              Array.isArray(e.oneOf) &&
              e.oneOf.forEach((e) => {
                "$ref" in e && a.push(e.$ref);
              }),
            "anyOf" in e &&
              Array.isArray(e.anyOf) &&
              e.anyOf.forEach((e) => {
                "$ref" in e && a.push(e.$ref);
              }));
          let n = new Set(r),
            s = new Set(a);
          return n.size === s.size && [...n].every((e) => s.has(e));
        }
      }
      class eb extends el {
        constructor(e, t, r = ["#"], a, n, s = !1) {
          (super(s),
            (this.schema = e),
            (this.required = t),
            (this.path = r),
            (this.location = a),
            (this.contentType = n),
            (this.safeParse = s));
        }
        convert() {
          if (void 0 === this.schema)
            return this.contentType &&
              !ec.some((e) => {
                var t;
                return null == (t = this.contentType) ? void 0 : t.startsWith(e);
              })
              ? [{ type: "file", contentMediaType: this.contentType }]
              : (this.handleNewError(es, this.path, "schema undefined"), [{ type: "any" }]);
          try {
            let e = ea(this.schema);
            return (
              (e = this.reduceCompositionsRecursive(this.path, e, 0)),
              this.convertSchemaRecursive(this.path, e, this.required, 0)
            );
          } catch (e) {
            return (
              this.handleExistingError(e, this.path, "error converting top-level schema"),
              [{ type: "any" }]
            );
          }
        }
        reduceOnly() {
          if (void 0 === this.schema)
            return this.contentType &&
              !ec.some((e) => {
                var t;
                return null == (t = this.contentType) ? void 0 : t.startsWith(e);
              })
              ? { oneOf: [{ type: "file", contentMediaType: this.contentType }] }
              : (this.handleNewError(es, this.path, "schema undefined"), { oneOf: [{}] });
          try {
            let e = ea(this.schema);
            return (e = this.reduceCompositionsRecursive(this.path, e, 0));
          } catch (e) {
            return (
              this.handleExistingError(e, this.path, "error converting top-level schema"),
              { oneOf: [{}] }
            );
          }
        }
        reduceOptionsCompositions(e, t, r) {
          let a = t.flatMap((t, a) => {
            var n;
            try {
              return null !=
                (n = this.reduceCompositionsRecursive([...e, a.toString()], t, r + 1).oneOf)
                ? n
                : [];
            } catch (e) {
              if (e instanceof ei) return [];
              throw e;
            }
          });
          if (0 === a.length)
            throw new ei(e, "no valid options in schema:", JSON.stringify(t, void 0, 2));
          return a;
        }
        reduceCompositionsRecursive(e, t, r) {
          if (r > eb.MAX_RECURSION_DEPTH || this.shouldTruncateForSize(t))
            return this.createTruncatedReducedSchema(t);
          if (
            (t.oneOf && t.oneOf.length > 0
              ? (t.oneOf = this.reduceOptionsCompositions([...e, "oneOf"], t.oneOf, r))
              : (t.oneOf = []),
            t.anyOf &&
              t.anyOf.length > 0 &&
              (t.anyOf = this.reduceOptionsCompositions([...e, "anyOf"], t.anyOf, r)),
            t.allOf && t.allOf.length > 0)
          ) {
            let a = t.allOf
              .map((t, a) =>
                this.reduceCompositionsRecursive([...e, "allOf", a.toString()], t, r + 1),
              )
              .reduce(
                (t, a, n) => this.combineReducedSchemas([...e, "allOf", n.toString()], t, a, r + 1),
                { oneOf: [] },
              );
            t.oneOf = this.multiplySchemaArrays(e, t.oneOf, a.oneOf, r);
          }
          if (t.properties)
            for (let a in t.properties) {
              let n = t.properties[a];
              if (
                (n.readOnly && "request" === this.location) ||
                (n.writeOnly && "response" === this.location)
              ) {
                delete t.properties[a];
                continue;
              }
              let s = [...e, "properties", a];
              try {
                t.properties[a] = this.reduceCompositionsRecursive(s, n, r + 1);
              } catch (e) {
                (this.handleExistingError(e, s, "error reducing property schema"),
                  (t.properties[a] = { oneOf: [{}] }));
              }
            }
          if ("items" in t && t.items) {
            let a = [...e, "items"];
            try {
              t.items = this.reduceCompositionsRecursive(a, t.items, r + 1);
            } catch (e) {
              (this.handleExistingError(e, a, "error reducing items schema"),
                (t.items = { oneOf: [{}] }));
            }
          }
          if (t.additionalProperties && "object" == typeof t.additionalProperties) {
            let a = [...e, "additionalProperties"];
            try {
              t.additionalProperties = this.reduceCompositionsRecursive(
                a,
                t.additionalProperties,
                r + 1,
              );
            } catch (e) {
              e instanceof ei
                ? (t.additionalProperties = !1)
                : (this.handleExistingError(e, a, "error reducing additionalProperties schema"),
                  (t.additionalProperties = !0));
            }
          }
          t.anyOf &&
            t.anyOf.length > 0 &&
            (t.oneOf = this.multiplySchemaArrays(e, t.oneOf, t.anyOf, r));
          let a = this.generateTopLevelSchemaArray(t);
          return { oneOf: this.multiplySchemaArrays(e, t.oneOf, a, r) };
        }
        generateTopLevelSchemaArray(e) {
          if (e.nullable) {
            let t = Object.assign({}, e);
            (delete t.oneOf, delete t.nullable);
            let r = Object.assign({}, e);
            return (delete r.oneOf, delete r.nullable, (r.type = "null"), [t, r]);
          }
          if (Array.isArray(e.type)) {
            if (0 === e.type.length) {
              let t = Object.assign({}, e);
              return (delete t.oneOf, delete t.type, [t]);
            }
            return e.type.map((t) => {
              let r = Object.assign({}, e);
              return (delete r.oneOf, (r.type = t), r);
            });
          }
          let t = Object.assign({}, e);
          return (delete t.oneOf, [t]);
        }
        multiplySchemaArrays(e, t, r, a = 0) {
          if (
            t.length * r.length > eb.MAX_SCHEMA_COMBINATION_SIZE ||
            (0 === t.length && 0 === r.length)
          )
            return [{}];
          if (0 === t.length) return r;
          if (0 === r.length) return t;
          let n = t.flatMap((t) =>
            r.flatMap((r) => {
              try {
                return [this.combineTopLevelSchemas(e, t, r, a + 1)];
              } catch (e) {
                if (e instanceof ei) return [];
                throw e;
              }
            }),
          );
          if (0 === n.length)
            throw new ei(
              e,
              "impossible schema combination:",
              "schema array 1:",
              JSON.stringify(t, void 0, 2),
              "schema array 2:",
              JSON.stringify(r, void 0, 2),
            );
          return n;
        }
        combineReducedSchemas(e, t, r, a = 0) {
          var n, s;
          return {
            oneOf: this.multiplySchemaArrays(
              e,
              null != (n = t.oneOf) ? n : [],
              null != (s = r.oneOf) ? s : [],
              a,
            ),
          };
        }
        combineTopLevelSchemas(e, t, r, a = 0) {
          var n, s;
          let i = t.type,
            o = r.type;
          if (
            ("integer" === i && "number" === o
              ? (o = "integer")
              : "number" === i && "integer" === o && (i = "integer"),
            i && o && i !== o)
          )
            throw new ei(e, `mismatched type in composition: "${i}" "${o}"`);
          for (let e of [t, r])
            ("number" == typeof e.exclusiveMaximum &&
              (void 0 === e.maximum || e.maximum >= e.exclusiveMaximum
                ? ((e.maximum = e.exclusiveMaximum), (e.exclusiveMaximum = !0))
                : (e.exclusiveMaximum = void 0)),
              "number" == typeof e.exclusiveMinimum &&
                (void 0 === e.minimum || e.minimum <= e.exclusiveMinimum
                  ? ((e.minimum = e.exclusiveMinimum), (e.exclusiveMinimum = !0))
                  : (e.exclusiveMinimum = void 0)));
          let l = {
            title: ev(t, r, "title"),
            description: ev(t, r, "description"),
            format: ev(t, r, "format"),
            multipleOf: ej(t, r, "multipleOf", er),
            maximum: ej(t, r, "maximum", Math.min),
            minimum: ej(t, r, "minimum", Math.max),
            maxLength: ej(t, r, "maxLength", Math.min),
            minLength: ej(t, r, "minLength", Math.max),
            maxItems: ej(t, r, "maxItems", Math.min),
            minItems: ej(t, r, "minItems", Math.max),
            maxProperties: ej(t, r, "maxProperties", Math.min),
            minProperties: ej(t, r, "minProperties", Math.max),
            required: ej(t, r, "required", (e, t) => t.concat(e.filter((e) => !t.includes(e)))),
            enum: ej(t, r, "enum", (e, t) => t.filter((t) => e.includes(t))),
            readOnly: t.readOnly && r.readOnly,
            writeOnly: t.writeOnly && r.writeOnly,
            deprecated: t.deprecated || r.deprecated,
          };
          ((l.exclusiveMaximum =
            (t.maximum === l.maximum ? t.exclusiveMaximum : void 0) ||
            (r.maximum === l.maximum ? r.exclusiveMaximum : void 0)),
            (l.exclusiveMinimum =
              (t.minimum === l.minimum ? t.exclusiveMinimum : void 0) ||
              (r.minimum === l.minimum ? r.exclusiveMinimum : void 0)));
          let d = (null == (n = t.examples) ? void 0 : n[0]) !== void 0 ? t.examples[0] : t.example,
            c = (null == (s = r.examples) ? void 0 : s[0]) !== void 0 ? r.examples[0] : r.example;
          d && c && "object" == typeof d && "object" == typeof c
            ? (l.example = Object.assign(Object.assign({}, d), c))
            : (l.example = void 0 !== c ? c : d);
          let p = null != i ? i : o;
          if ("array" === p)
            return Object.assign(
              {
                type: p,
                items: this.combineReducedSchemas(
                  [...e, "items"],
                  "items" in t && t.items ? t.items : {},
                  "items" in r && r.items ? r.items : {},
                  a + 1,
                ),
              },
              l,
            );
          if (t.properties && r.properties) {
            let n = Object.assign({}, t.properties);
            (Object.entries(r.properties).forEach(([t, r]) => {
              let s = n[t];
              s
                ? (n[t] = this.combineReducedSchemas([...e, "properties", t], s, r, a + 1))
                : (n[t] = r);
            }),
              (l.properties = n));
          } else
            (t.properties || r.properties) &&
              (l.properties = Object.assign(Object.assign({}, t.properties), r.properties));
          return (
            !1 === t.additionalProperties || !1 === r.additionalProperties
              ? (l.additionalProperties = !1)
              : t.additionalProperties &&
                  "object" == typeof t.additionalProperties &&
                  r.additionalProperties &&
                  "object" == typeof r.additionalProperties
                ? (l.additionalProperties = this.combineReducedSchemas(
                    [...e, "additionalProperties"],
                    t.additionalProperties,
                    r.additionalProperties,
                    a + 1,
                  ))
                : t.additionalProperties && "object" == typeof t.additionalProperties
                  ? (l.additionalProperties = t.additionalProperties)
                  : r.additionalProperties &&
                    "object" == typeof r.additionalProperties &&
                    (l.additionalProperties = r.additionalProperties),
            Object.assign({ type: p }, l)
          );
        }
        convertSchemaRecursive(e, t, r, a = 0) {
          if (a > eb.MAX_RECURSION_DEPTH || this.shouldTruncateForSize(t))
            return this.createTruncatedDataSchema(t);
          if (void 0 === t.oneOf || 0 === t.oneOf.length)
            throw new eo(e, "missing schema definition");
          let n = t.oneOf.map((t) => {
            let n = {};
            if (
              (eu("required", r, n),
              em("title", t, n),
              em("description", t, n),
              em("readOnly", t, n),
              em("writeOnly", t, n),
              em("deprecated", t, n),
              em("x-mint", t, n),
              em("x-mint-enum", t, n),
              void 0 === t.type)
            ) {
              let e = ek(t);
              if (void 0 === e) return Object.assign({ type: "any" }, n);
              t.type = e;
            }
            switch (t.type) {
              case "boolean":
              case "null":
                return (
                  em("default", t, n),
                  em("x-default", t, n),
                  eh(t, n),
                  Object.assign({ type: t.type }, n)
                );
              case "number":
              case "integer":
                if (t.enum)
                  return (
                    em("default", t, n),
                    em("x-default", t, n),
                    eh(t, n),
                    Object.assign(
                      {
                        type: "number" === t.type ? "enum<number>" : "enum<integer>",
                        enum: t.enum.filter((e) => "number" == typeof e),
                      },
                      n,
                    )
                  );
                return (
                  em("multipleOf", t, n),
                  em("maximum", t, n),
                  em("exclusiveMaximum", t, n),
                  em("minimum", t, n),
                  em("exclusiveMinimum", t, n),
                  em("default", t, n),
                  em("x-default", t, n),
                  em("const", t, n),
                  eh(t, n),
                  Object.assign({ type: t.type }, n)
                );
              case "string":
                if (t.enum)
                  return (
                    em("default", t, n),
                    em("x-default", t, n),
                    eh(t, n),
                    Object.assign(
                      { type: "enum<string>", enum: t.enum.filter((e) => "string" == typeof e) },
                      n,
                    )
                  );
                if (t.format && ed.has(t.format))
                  return Object.assign({ type: "file", contentEncoding: t.format }, n);
                return (
                  em("format", t, n),
                  em("pattern", t, n),
                  em("maxLength", t, n),
                  em("minLength", t, n),
                  em("default", t, n),
                  em("x-default", t, n),
                  em("const", t, n),
                  eh(t, n),
                  Object.assign({ type: t.type }, n)
                );
              case "array":
                let s,
                  i = [...e, "items"];
                try {
                  s =
                    "object" == typeof t.items && null != t.items
                      ? this.convertSchemaRecursive(i, t.items, void 0, a + 1)
                      : [{ type: "any" }];
                } catch (e) {
                  (this.handleExistingError(e, i, "error converting items schema"),
                    (s = [{ type: "any" }]));
                }
                return (
                  em("maxItems", t, n),
                  em("minItems", t, n),
                  em("uniqueItems", t, n),
                  em("default", t, n),
                  em("x-default", t, n),
                  eh(t, n),
                  Object.assign({ type: t.type, items: s }, n)
                );
              case "object":
                let o,
                  l = this.convertProperties([...e, "properties"], t.properties, t.required, a),
                  d = [...e, "additionalProperties"];
                try {
                  o =
                    "object" == typeof t.additionalProperties && null != t.additionalProperties
                      ? this.convertSchemaRecursive(d, t.additionalProperties, void 0, a + 1)
                      : t.additionalProperties;
                } catch (e) {
                  this.handleExistingError(e, d, "error converting additionalProperties schema");
                }
                return (
                  eu("additionalProperties", o, n),
                  em("maxProperties", t, n),
                  em("minProperties", t, n),
                  em("default", t, n),
                  em("x-default", t, n),
                  eh(t, n),
                  Object.assign({ type: t.type, properties: l }, n)
                );
              default:
                throw new es(e, `invalid schema type: ${t.type}`);
            }
          });
          if (!n[0]) throw new eo(e, "missing schema definition in position 0");
          return [n[0], ...n.slice(1)];
        }
        convertProperties(e, t, r, a = 0) {
          return void 0 === t
            ? {}
            : Object.fromEntries(
                Object.entries(t).map(([t, n]) => {
                  let s,
                    i = [...e, t],
                    o = !!r && Array.isArray(r) && r.includes(t);
                  try {
                    s = this.convertSchemaRecursive(i, n, o || void 0, a + 1);
                  } catch (e) {
                    (this.handleExistingError(e, i, "error converting property schema"),
                      (s = [{ type: "any" }]));
                  }
                  return [t, s];
                }),
              );
        }
        shouldTruncateForSize(e) {
          var t, r, a, n, s, i;
          let o = null != (r = null == (t = e.oneOf) ? void 0 : t.length) ? r : 1,
            l = [
              o,
              null != (n = null == (a = e.anyOf) ? void 0 : a.length) ? n : 1,
              null != (i = null == (s = e.allOf) ? void 0 : s.length) ? i : 1,
            ],
            d = ["properties", "additionalProperties", "items", "oneOf", "anyOf", "allOf"];
          return (
            d.forEach((t) => {
              if (e[t]) {
                let r = e[t];
                (l.push(Object.keys(r).length),
                  d.forEach((e) => {
                    if (r[e]) {
                      let t = r[e];
                      (l.push(Object.keys(t).length),
                        d.forEach((e) => {
                          if (t[e]) {
                            let r = t[e];
                            l.push(Object.keys(r).length);
                          }
                        }));
                    }
                  }));
              }
            }),
            l.reduce((e, t) => e * t, 1) > eb.MAX_SCHEMA_COMBINATION_SIZE
          );
        }
        createTruncatedNextProperties(e) {
          let t = Object.assign({}, e);
          return (
            delete t.oneOf,
            delete t.anyOf,
            delete t.allOf,
            "array" === t.type
              ? (t.items = {})
              : "object" === t.type &&
                ((t.properties = {}),
                t.additionalProperties &&
                  "object" == typeof t.additionalProperties &&
                  (t.additionalProperties = {})),
            t
          );
        }
        createTruncatedReducedSchema(e) {
          return { oneOf: [this.createTruncatedNextProperties(e)] };
        }
        createTruncatedDataSchema(e) {
          let t = this.createTruncatedNextProperties(e);
          try {
            return this.convertSchemaRecursive(
              ["truncated"],
              { oneOf: [t] },
              void 0,
              eb.MAX_RECURSION_DEPTH + 10,
            );
          } catch (e) {
            return [{ type: "any" }];
          }
        }
        static convert({
          schema: e,
          required: t,
          path: r,
          location: a,
          contentType: n,
          safeParse: s,
        }) {
          return new eb(e, t, r, a, n, s).convert();
        }
        static reduce({
          schema: e,
          required: t,
          path: r,
          location: a,
          contentType: n,
          safeParse: s,
        }) {
          return new eb(e, t, r, a, n, s).reduceOnly();
        }
      }
      ((eb.MAX_RECURSION_DEPTH = 10), (eb.MAX_SCHEMA_COMBINATION_SIZE = 1e3));
      let ev = (e, t, r) => {
          var a;
          return null != (a = t[r]) ? a : e[r];
        },
        ej = (e, t, r, a) => {
          var n;
          return void 0 !== e[r] && void 0 !== t[r] ? a(e[r], t[r]) : null != (n = e[r]) ? n : t[r];
        },
        ek = (e) => {
          var t, r;
          let a;
          if (
            ((void 0 !== e.format ||
              void 0 !== e.pattern ||
              void 0 !== e.minLength ||
              void 0 !== e.maxLength ||
              (null == (t = e.enum) ? void 0 : t.every((e) => "string" == typeof e))) &&
              (a = "string"),
            void 0 !== e.multipleOf ||
              void 0 !== e.minimum ||
              void 0 !== e.maximum ||
              void 0 !== e.exclusiveMinimum ||
              void 0 !== e.exclusiveMaximum ||
              (null == (r = e.enum) ? void 0 : r.every((e) => "number" == typeof e)))
          ) {
            if (void 0 !== a) return;
            a = "number";
          }
          if (
            ("items" in e && void 0 !== e.items) ||
            void 0 !== e.minItems ||
            void 0 !== e.maxItems ||
            void 0 !== e.uniqueItems
          ) {
            if (void 0 !== a) return;
            a = "array";
          }
          if (
            void 0 !== e.additionalProperties ||
            void 0 !== e.properties ||
            void 0 !== e.minProperties ||
            void 0 !== e.maxProperties
          ) {
            if (void 0 !== a) return;
            a = "object";
          }
          return a;
        };
      function ew(e) {
        if (!e[0]) return [[]];
        let t = ew(e.slice(1));
        return e[0].flatMap((e) =>
          t.map((t) => {
            let r = [...e, ...t];
            return r.map((e) => {
              let t = {};
              return (
                r.forEach((e) => {
                  (e.isOneOf && (t.isOneOf = e.isOneOf),
                    e.isAnyOf && (t.isAnyOf = e.isAnyOf),
                    e.isAllOf && (t.isAllOf = e.isAllOf));
                }),
                e.refIdentifier &&
                  (t.isOneOf === e.refIdentifier && delete t.isOneOf,
                  t.isAnyOf === e.refIdentifier && delete t.isAnyOf,
                  t.isAllOf === e.refIdentifier && delete t.isAllOf),
                Object.assign(Object.assign({}, e), t)
              );
            });
          }),
        );
      }
      function eN(e, t, r, a) {
        let n = (function e(t, r, a) {
          var n, s, i, o, l, d, c, p, u, m, h, x, g;
          let f,
            y = null != (n = null == a ? void 0 : a._depth) ? n : 0,
            b = null != (s = null == a ? void 0 : a._visited) ? s : new Set();
          if ("$ref" in t) {
            let e = t.$ref;
            if (b.has(e)) return [[{}]];
            let n = new Set(b);
            n.add(e);
            let s = ep("schemas", t.$ref, r);
            if (!s) return [[{}]];
            void 0 === s.type &&
              (null == (i = s.allOf)
                ? void 0
                : i.find((e) => "type" in e && "object" === e.type)) &&
              (s.type = "object");
            let d = null != (o = t.title) ? o : s.title;
            ((f = Object.assign(Object.assign({}, s), {
              title: d,
              refIdentifier: e,
              description: null != (l = t.description) ? l : s.description,
              isOneOf: t.isOneOf,
              isAnyOf: t.isAnyOf,
              isAllOf: t.isAllOf,
              "x-mint": t["x-mint"],
            })),
              (a = Object.assign(Object.assign({}, a), { _visited: n })));
          } else f = t;
          if (
            (null == a ? void 0 : a.isRoot) &&
            "array" === f.type &&
            (null == (d = f.discriminator) ? void 0 : d.mapping) &&
            !ey(f)
          ) {
            let e = f.discriminator,
              t = f.items;
            delete f.discriminator;
            let a = Object.values(null != (c = e.mapping) ? c : {}).map((e) => ({ $ref: e })),
              n = [];
            "oneOf" in t &&
              ((n = (n =
                null !=
                (u =
                  null == (p = t.oneOf)
                    ? void 0
                    : p.filter((t) => {
                        var r;
                        return (
                          !("$ref" in t) ||
                          !Object.values(null != (r = e.mapping) ? r : {}).includes(t.$ref)
                        );
                      }))
                  ? u
                  : []).map((e) => Object.assign(Object.assign({}, e), { _depth: y + 1 }))),
              delete t.oneOf);
            let s = a.map((e) => {
              var a, n;
              let s = ep("schemas", e.$ref, r);
              if (!s) return Object.assign(Object.assign({}, t), { _depth: y + 1 });
              let i = "$ref" in t ? ep("schemas", t.$ref, r) : t,
                o = null != (a = null == i ? void 0 : i.properties) ? a : {},
                l = null != (n = s.properties) ? n : {};
              return Object.assign(Object.assign(Object.assign({}, t), s), {
                properties: Object.assign(Object.assign({}, o), l),
                _depth: y + 1,
              });
            });
            f = Object.assign(Object.assign({}, f), {
              items: Object.assign(Object.assign({}, t), { oneOf: [...s, ...n] }),
            });
          } else if (
            (null == a ? void 0 : a.isRoot) &&
            (null == (m = f.discriminator) ? void 0 : m.mapping) &&
            !f.oneOf &&
            !f.allOf &&
            !ey(f)
          ) {
            let e = Object.values(f.discriminator.mapping);
            e.length &&
              (delete f.discriminator,
              (f = Object.assign(Object.assign({}, f), {
                allOf: [{ oneOf: [...e.map((e) => ({ $ref: e }))] }],
              })));
          }
          let v = f.nullable;
          if (!f.oneOf && !f.allOf && !f.anyOf && !Array.isArray(f.type) && !v)
            return [[Object.assign(Object.assign({}, f), { _depth: y })]];
          let j = Object.assign(Object.assign({}, f), { _depth: y });
          (delete j.oneOf, delete j.anyOf, delete j.allOf, delete j.not);
          let k = Array.isArray(j.type) ? [...j.type] : [j.type];
          v && !k.includes("null") && k.push("null");
          let w =
              Object.keys(j).filter((e) => !e.startsWith("_")).length > 0
                ? [k.map((e) => [Object.assign(Object.assign({}, j), { type: e })])]
                : [],
            N =
              null == (h = f.oneOf)
                ? void 0
                : h.map(
                    (t) => (
                      "refIdentifier" in f && (t.isOneOf = f.refIdentifier),
                      e(t, r, { _depth: y + 1, _visited: new Set(null == a ? void 0 : a._visited) })
                    ),
                  ),
            C =
              null == (x = f.anyOf)
                ? void 0
                : x.map(
                    (t) => (
                      "refIdentifier" in f && (t.isAnyOf = f.refIdentifier),
                      e(t, r, { _depth: y + 1, _visited: new Set(null == a ? void 0 : a._visited) })
                    ),
                  ),
            S =
              null == (g = f.allOf)
                ? void 0
                : g.map(
                    (t) => (
                      "refIdentifier" in f && (t.isAllOf = f.refIdentifier),
                      e(t, r, { _depth: y + 1, _visited: new Set(null == a ? void 0 : a._visited) })
                    ),
                  ),
            O = N ? [N.flat()] : [],
            $ = C ? [C.flat()] : [],
            T = S ? [ew(S)] : [];
          return ew([...O, ...$, ...T, ...w]).map((e) =>
            e.map((e) =>
              Object.assign(
                Object.assign(
                  Object.assign(Object.assign({}, e), e.isOneOf && { isOneOf: e.isOneOf }),
                  e.isAnyOf && { isAnyOf: e.isAnyOf },
                ),
                e.isAllOf && { isAllOf: e.isAllOf },
              ),
            ),
          );
        })(e, t, { isRoot: !0 }).flatMap((e) => {
          try {
            var n, s, i;
            let o =
              ((n = e),
              (s = t),
              (i = a),
              n.sort((e, t) => {
                var r, a;
                let n = null != (r = e._depth) ? r : 0,
                  s = null != (a = t._depth) ? a : 0;
                return n !== s ? n - s : e.type && !t.type ? -1 : !e.type && t.type ? 1 : 0;
              }),
              n.reduce((e, t) => {
                var r, a, o, l;
                let d = t.type;
                if (
                  ("integer" === e.type && "number" === d
                    ? (d = "integer")
                    : "number" === e.type && "integer" === d
                      ? (e.type = "integer")
                      : void 0 === e.type && void 0 !== d
                        ? (e.type = d)
                        : void 0 !== e.type && void 0 === d && (d = e.type),
                  e.type !== d)
                )
                  throw Error(`${e.type} vs ${d}`);
                for (let r of [e, t])
                  ("number" == typeof r.exclusiveMaximum &&
                    (void 0 === r.maximum || r.maximum >= r.exclusiveMaximum
                      ? ((r.maximum = r.exclusiveMaximum), (r.exclusiveMaximum = !0))
                      : (r.exclusiveMaximum = void 0)),
                    "number" == typeof r.exclusiveMinimum &&
                      (void 0 === r.minimum || r.minimum <= r.exclusiveMinimum
                        ? ((r.minimum = r.exclusiveMinimum), (r.exclusiveMinimum = !0))
                        : (r.exclusiveMinimum = void 0)));
                void 0 != t.discriminator ||
                  (void 0 == t.type && void 0 != e.title) ||
                  (t.isAllOf && t.refIdentifier && t.refIdentifier !== t.isAllOf) ||
                  em("title", t, e);
                (em("refIdentifier", t, e),
                  em("examples", t, e),
                  em("format", t, e),
                  em("default", t, e),
                  em("x-default", t, e),
                  em("const", t, e),
                  em("x-mint-enum", t, e),
                  em("x-mint", t, e),
                  ef("multipleOf", t, e, er),
                  ef("maxLength", t, e, Math.min),
                  ef("minLength", t, e, Math.max),
                  ef("maxItems", t, e, Math.min),
                  ef("minItems", t, e, Math.max),
                  ef("maxProperties", t, e, Math.min),
                  ef("minProperties", t, e, Math.max),
                  ef("required", t, e, (e, t) => t.concat(e.filter((e) => !t.includes(e)))),
                  ef("enum", t, e, (e, t) => t.filter((t) => e.includes(t))),
                  ef("readOnly", t, e, (e, t) => e && t),
                  ef("writeOnly", t, e, (e, t) => e && t),
                  ef("deprecated", t, e, (e, t) => e || t));
                let c = eg(t, e, "maximum", Math.min),
                  p = eg(t, e, "minimum", Math.max);
                (eu(
                  "exclusiveMaximum",
                  (e.maximum === c ? e.exclusiveMaximum : void 0) ||
                    (t.maximum === c ? t.exclusiveMaximum : void 0),
                  e,
                ),
                  eu(
                    "exclusiveMinimum",
                    (e.minimum === p ? e.exclusiveMinimum : void 0) ||
                      (t.minimum === p ? t.exclusiveMinimum : void 0),
                    e,
                  ),
                  eu("maximum", c, e),
                  eu("minimum", p, e));
                let u =
                    (null == (a = e.examples) ? void 0 : a[0]) !== void 0
                      ? e.examples[0]
                      : e.example,
                  m =
                    (null == (o = t.examples) ? void 0 : o[0]) !== void 0
                      ? t.examples[0]
                      : t.example;
                if (
                  (u && m && "object" == typeof u && "object" == typeof m
                    ? (e.example = Object.assign(Object.assign({}, u), m))
                    : eu("example", void 0 !== m ? m : u, e),
                  t.items)
                ) {
                  let a = null != (r = e.items) ? r : { allOf: [] };
                  (a.allOf.push(t.items), (e.items = a));
                }
                (t.properties &&
                  Object.entries(t.properties)
                    .filter(([e, t]) => {
                      if ("$ref" in t) {
                        let e = ep("schemas", t.$ref, s);
                        if (!e) return !0;
                        t = e;
                      }
                      return (!t.readOnly || "request" !== i) && (!t.writeOnly || "response" !== i);
                    })
                    .forEach(([t, r]) => {
                      var a;
                      let n = null != (a = e.properties) ? a : {},
                        s = n[t];
                      (s ? s.allOf.push(r) : (n[t] = { allOf: [r] }), (e.properties = n));
                    }),
                  (function (e, t, r) {
                    var a, n;
                    if (
                      (null == (a = e.properties) ? void 0 : a.type) &&
                      t.discriminator &&
                      !e.description
                    ) {
                      let a,
                        s = null != (n = e.properties.type.allOf[0]) ? n : {};
                      "const" in s && "string" == typeof s.const && (a = s.const);
                      let i = ex(t, a) || r.flatMap((e) => ex(e, a)).filter(Boolean)[0];
                      i && (e.description = i);
                    } else
                      e.description &&
                      t.description &&
                      !t.discriminator &&
                      !e.description.includes(t.description)
                        ? (e.description = `${e.description}
${t.description}`)
                        : e.description || em("description", t, e);
                  })(e, t, n));
                if (!1 === t.additionalProperties) e.additionalProperties = !1;
                else if (
                  !1 !== e.additionalProperties &&
                  t.additionalProperties &&
                  "object" == typeof t.additionalProperties
                ) {
                  let r = null != (l = e.additionalProperties) ? l : { allOf: [] };
                  (r.allOf.push(t.additionalProperties), (e.additionalProperties = r));
                }
                return e;
              }, {}));
            return [
              (function (e, t) {
                var r, a;
                let n = {};
                if (
                  (eu("required", t, n),
                  em("title", e, n),
                  em("description", e, n),
                  em("readOnly", e, n),
                  em("writeOnly", e, n),
                  em("deprecated", e, n),
                  em("refIdentifier", e, n),
                  em("examples", e, n),
                  em("x-mint-enum", e, n),
                  em("x-mint", e, n),
                  void 0 === e.type)
                ) {
                  let t = ek(e);
                  if (void 0 === t) return Object.assign({ type: "any" }, n);
                  e.type = t;
                }
                switch (e.type) {
                  case "boolean":
                  case "null":
                    return (
                      em("default", e, n),
                      em("x-default", e, n),
                      eh(e, n),
                      Object.assign({ type: e.type }, n)
                    );
                  case "number":
                  case "integer":
                    if (e.enum)
                      return (
                        em("default", e, n),
                        em("x-default", e, n),
                        em("const", e, n),
                        eh(e, n),
                        Object.assign(
                          {
                            type: "number" === e.type ? "enum<number>" : "enum<integer>",
                            enum: e.enum.filter((e) => "number" == typeof e),
                          },
                          n,
                        )
                      );
                    return (
                      em("multipleOf", e, n),
                      em("maximum", e, n),
                      em("exclusiveMaximum", e, n),
                      em("minimum", e, n),
                      em("exclusiveMinimum", e, n),
                      em("default", e, n),
                      em("x-default", e, n),
                      em("const", e, n),
                      eh(e, n),
                      Object.assign({ type: e.type }, n)
                    );
                  case "string":
                    if (e.enum)
                      return (
                        em("default", e, n),
                        em("x-default", e, n),
                        em("const", e, n),
                        eh(e, n),
                        Object.assign(
                          {
                            type: "enum<string>",
                            enum: e.enum.filter((e) => "string" == typeof e),
                          },
                          n,
                        )
                      );
                    if (e.format && ed.has(e.format)) {
                      return Object.assign({ type: "file", contentEncoding: e.format }, n);
                    }
                    return (
                      em("format", e, n),
                      em("pattern", e, n),
                      em("maxLength", e, n),
                      em("minLength", e, n),
                      em("default", e, n),
                      em("x-default", e, n),
                      em("const", e, n),
                      eh(e, n),
                      Object.assign({ type: e.type }, n)
                    );
                  case "array":
                    return (
                      em("maxItems", e, n),
                      em("minItems", e, n),
                      em("uniqueItems", e, n),
                      em("default", e, n),
                      em("x-default", e, n),
                      eh(e, n),
                      Object.assign({ type: e.type, items: null != (r = e.items) ? r : {} }, n)
                    );
                  case "object":
                    return (
                      eu("requiredProperties", e.required, n),
                      em("additionalProperties", e, n),
                      em("maxProperties", e, n),
                      em("minProperties", e, n),
                      em("default", e, n),
                      em("x-default", e, n),
                      eh(e, n),
                      Object.assign(
                        { type: e.type, properties: null != (a = e.properties) ? a : {} },
                        n,
                      )
                    );
                  default:
                    throw Error();
                }
              })(o, r),
            ];
          } catch (e) {
            return [];
          }
        });
        return n[0] ? [n[0], ...n.slice(1)] : [{ type: "any" }];
      }
      function eC(e, t, r) {
        return Array.isArray(e.items) ? e.items : eN(e.items, t, void 0, r);
      }
      let eS = ({ schemaArray: e, userGroups: t }) => {
          let r = e.filter((e) => {
            let r = eO(e);
            return 0 === r.length || r.some((e) => t?.includes(e));
          });
          return ((e) => Array.isArray(e) && e.length > 0)(r) ? r : null;
        },
        eO = (e) => {
          let t = [];
          return (
            "x-mint" in e &&
              e["x-mint"] &&
              "object" == typeof e["x-mint"] &&
              "groups" in e["x-mint"] &&
              Array.isArray(e["x-mint"].groups) &&
              t.push(...e["x-mint"].groups),
            t
          );
        },
        e$ = " | null",
        eT = (e, t, r, a, n = 0) => {
          let s = !1,
            i = r ? e$ : "";
          switch (e.type) {
            case "any":
              return "any";
            case "null":
              return "null";
            case "object":
              if (e.title) {
                return `${e.title} \xb7 object`;
              }
              return "object";
            case "array":
              let o = eC(e, t, void 0),
                l = eS({ schemaArray: o, userGroups: a });
              if ((l && (o = l), o.some((e) => "array" === e.type) && n >= 5)) {
                return ((s = !0), `array${i}`);
              }
              let d = new Set();
              o.forEach((e) => d.add(eT(e, t, !1, a, n + 1)));
              let c = Array.from(d);
              if (s) {
                return `array${i}`;
              }
              if (1 === c.length && "object" === c[0] && e.title) {
                return `${e.title} \xb7 object[]${i}`;
              }
              if (1 === c.length) {
                return `${c[0]}[]${i}`;
              }
              if (c.length > 1 && e.title) {
                return `${e.title} \xb7 array`;
              }
              if (c.every((e) => "object" !== e && "array" !== e)) {
                return `(${c.join(" | ")})[]${i}`;
              }
              return `array${i}`;
            default:
              let p =
                "format" in e && "string" == typeof e.format ? `${e.type}<${e.format}>` : e.type;
              return `${p}${i}`;
          }
        },
        eE = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            [r, s] = (0, n.useState)(0),
            { selectedResponseContentTypeIndex: i, setSelectedResponseContentTypeIndex: o } = (0,
            X.n)(),
            l = (0, n.useRef)(e.operation),
            p = (0, n.useMemo)(() => e.dependencies?.responses ?? {}, [e.dependencies?.responses]),
            m = e.dependencies?.schemas,
            h = (0, n.useMemo)(() => {
              let t = e.operation?.responses;
              return t
                ? Object.entries(t).map(([e, t]) => {
                    let r = p[t];
                    return [e, r?.content ?? {}];
                  })
                : [];
            }, [p, e.operation?.responses]);
          (0, n.useEffect)(() => {
            l.current !== e.operation
              ? ((l.current = e.operation), s(0))
              : r >= h.length && h.length > 0 && s(0);
          }, [e.operation, h.length, r]);
          let x = (0, n.useMemo)(() => {
              let e = h[r];
              return e && e[1] ? Object.entries(e[1]) : [];
            }, [h, r]),
            g = (0, n.useCallback)(
              (e) => {
                s(e);
                let t = h[e];
                t && t[1] && i >= Object.entries(t[1]).length && o(0);
              },
              [h, i, s, o],
            ),
            f = (0, n.useCallback)(
              (e) => {
                o(e);
              },
              [o],
            ),
            {
              contentType: y,
              schema: v,
              description: j,
            } = (0, n.useMemo)(() => {
              let t = x[i];
              if (!t) {
                return { contentType: void 0, schema: void 0, description: void 0 };
              }
              let [a, n] = t,
                s = n.schema,
                o = h[r],
                l = o ? String(o[0]) : void 0,
                d = l ? e.operation?.responses?.[l] : void 0,
                c = d ? p[d] : void 0,
                u = c?.description;
              return "_mintlify/placeholder" === a
                ? { schema: s, contentType: "", description: u }
                : { schema: s, contentType: a, description: u };
            }, [x, i, h, r, p, e.operation?.responses]),
            k = v ? [v] : [];
          k.some((e) => (0, b.Fy)(e) && "null" === e.type) &&
            (k = k.filter((e) => !(0, b.Fy)(e) || "null" !== e.type));
          let w = (0, b.FJ)(k),
            N = h.map(([e, t]) => ({ label: String(e), schema: t })),
            C = x
              .filter(([e]) => "_mintlify/placeholder" !== e)
              .map(([e, t]) => ({ label: String(e), schema: t })),
            O = h[0] ? `${h[0][0]}` : "",
            $ = "" === y ? "" : `${y}`,
            T = `${O}${O && $ ? " - " : ""}${$}`,
            A = h.length > 1,
            P = x.length > 1,
            I = A || P;
          return (0, a.jsxs)("div", {
            className: (0, u.cn)(c.x.APISection),
            children: [
              (0, a.jsx)(W, {
                title: t["api.response"],
                subtitle: j,
                rightElement: I
                  ? (0, a.jsxs)("div", {
                      className: "flex items-center gap-x-3 font-mono text-xs",
                      children: [
                        (0, a.jsx)(et, {
                          onSelectOption: g,
                          options: N,
                          selectedIndex: r,
                          className: (0, u.cn)(
                            "bg-transparent dark:bg-transparent",
                            A && "hover:text-zinc-950 dark:hover:text-white transition-all",
                          ),
                        }),
                        (0, a.jsx)(et, {
                          onSelectOption: f,
                          options: C,
                          selectedIndex: i,
                          className: (0, u.cn)(
                            "bg-transparent dark:bg-transparent",
                            P && "hover:text-zinc-950 dark:hover:text-white transition-all",
                          ),
                        }),
                      ],
                    })
                  : T,
                children:
                  w[0] &&
                  w[0].includes(e$) &&
                  (0, a.jsx)("div", {
                    children: (0, a.jsx)(S.ks, {
                      className: "max-w-fit text-xs font-medium font-mono break-words",
                      children: w[0],
                    }),
                  }),
              }),
              k.length > 1
                ? (0, a.jsx)(E.t, {
                    children: k.map((e, t) =>
                      (0, a.jsx)(
                        E.o,
                        {
                          title: w[t] ?? "",
                          children:
                            (0, b.Fy)(e) &&
                            (0, a.jsx)(H, {
                              schema: e,
                              fieldType: "response",
                              displayFlattened: !0,
                              schemas: m,
                              isTopLevel: !0,
                            }),
                        },
                        t,
                      ),
                    ),
                  })
                : k[0] && (0, b.Fy)(k[0])
                  ? (0, a.jsx)(H, {
                      schema: k[0],
                      fieldType: "response",
                      displayFlattened: !0,
                      omitPadding: !0,
                      schemas: m,
                      isTopLevel: !0,
                    })
                  : null,
            ],
          });
        };
      var eA = r(49962);
      let eP = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            { selectedSecurityOptionIndex: r, setSelectedSecurityOptionIndex: n } = (0, eA.a)(),
            s = e.dependencies?.processedSecurityOptions;
          if (!s) {
            return null;
          }
          let i = s[r];
          if (!i) {
            return null;
          }
          let o = [];
          if (
            (i.schemes.forEach(({ scheme: e, schema: t, name: r }) => {
              if ("apiKey" === e.type && "name" in e && "in" in e) {
                o.push(
                  (0, a.jsx)(
                    B,
                    {
                      fieldType: "authorization",
                      schema: t,
                      typeOptions: ["string"],
                      name: r,
                      location: e.in,
                    },
                    `${e.in}:${e.name}`,
                  ),
                );
              } else if ("http" === e.type && "scheme" in e) {
                if ("basic" === e.scheme) {
                  let e = { ...t, type: "string" };
                  o.push(
                    (0, a.jsx)(
                      B,
                      {
                        fieldType: "authorization",
                        schema: e,
                        typeOptions: ["string"],
                        name: r,
                        location: "header",
                      },
                      `header:${t.title}`,
                    ),
                  );
                } else
                  "bearer" === e.scheme &&
                    o.push(
                      (0, a.jsx)(
                        B,
                        {
                          fieldType: "authorization",
                          schema: t,
                          typeOptions: ["string"],
                          name: r,
                          location: "header",
                        },
                        `header:${t.title}`,
                      ),
                    );
              } else {
                "oauth2" === e.type &&
                  o.push(
                    (0, a.jsx)(
                      B,
                      {
                        fieldType: "authorization",
                        schema: t,
                        typeOptions: ["string"],
                        name: r,
                        location: "header",
                      },
                      `header:${t.title}`,
                    ),
                  );
              }
            }),
            0 === o.length)
          ) {
            return null;
          }
          let l = s.map((e) => e.title);
          return (0, a.jsxs)("div", {
            className: (0, u.cn)(c.x.APISection),
            children: [
              (0, a.jsx)(W, {
                title: t["api.authorizations"],
                options: l,
                selectedIndex: r,
                onSelectOption: n,
              }),
              o,
            ],
          });
        },
        eI = (0, n.memo)(function ({ pageMetadata: e }) {
          let { isCustom: t, isFrame: r } = (0, x.H)(e);
          return (0, a.jsx)("div", {
            className: (0, u.cn)("mb-14", !t && !r && "prose prose-gray dark:prose-invert"),
            children: e.openapi && (0, a.jsx)(e_, {}),
          });
        }),
        e_ = () => {
          let { apiReferenceData2: e } = (0, n.useContext)(s.ApiReferenceContext2);
          if (!e.operation) {
            return null;
          }
          let { dependencies: t } = e,
            r = t?.processedSecurityOptions && t.processedSecurityOptions.length > 0,
            i = t?.parameters && Object.keys(t.parameters).length > 0,
            o = t?.requestBody,
            l = t?.responses && Object.keys(t.responses).length > 0;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              r && (0, a.jsx)(eP, { apiReferenceData: e }),
              i && (0, a.jsx)(J, { apiReferenceData: e }),
              o &&
                (0, a.jsx)(I.oW, {
                  location: "request",
                  children: (0, a.jsx)(G, { apiReferenceData: e }),
                }),
              l &&
                (0, a.jsx)(I.oW, {
                  location: "response",
                  children: (0, a.jsx)(eE, { apiReferenceData: e }),
                }),
            ],
          });
        };
      var eq = r(81391);
      let eF = ({
          baseUrlOptions: e,
          selectedBaseUrlIndex: t = 0,
          setSelectedBaseUrlIndex: r,
          onBaseUrlChange: s,
        }) => {
          let [i, o] = (0, n.useState)(0),
            l = (0, d.n)(),
            c = e?.[t];
          return ((0, n.useEffect)(() => {
            let e = document.createElement("span");
            ((e.className = "text-sm absolute font-mono invisible"),
              (e.textContent = c ?? ""),
              document.body.appendChild(e),
              o(e.offsetWidth + 16),
              document.body.removeChild(e));
          }, [c]),
          e && 0 !== e.length && r)
            ? 1 === e.length
              ? (0, a.jsx)("div", {
                  className:
                    "min-w-max bg-transparent text-sm text-gray-600 dark:text-gray-400 outline-0 font-mono cursor-pointer hover:text-gray-900 dark:hover:text-gray-300",
                  children: e[0],
                })
              : (0, a.jsxs)("div", {
                  className: "flex items-center gap-1 relative -mr-1",
                  children: [
                    (0, a.jsx)("select", {
                      "aria-label": l["aria.selectBaseUrl"],
                      className:
                        "bg-transparent text-sm text-gray-600 dark:text-gray-400 outline-0 font-mono cursor-pointer hover:text-gray-900 dark:hover:text-gray-300",
                      value: t,
                      onClick: (e) => e.stopPropagation(),
                      onChange: (e) => {
                        (r(Number(e.target.value)), s?.());
                      },
                      style: { width: `${i}px` },
                      children: e.map((e, t) => (0, a.jsx)("option", { value: t, children: e }, e)),
                    }),
                    (0, a.jsx)(eq.A, {
                      className:
                        "absolute right-0 w-3 h-3 text-gray-400 dark:text-white/30 pointer-events-none",
                      strokeWidth: 2.5,
                    }),
                  ],
                })
            : null;
        },
        eR = ({ path: e, method: t, isCopiedActive: r, hasGrayBackground: s }) => {
          let i = (0, n.useMemo)(
            () =>
              e.split("/").flatMap((e, r) => {
                let n = [];
                return (
                  r > 0 && e && n.push((0, a.jsx)(eM, {}, r)),
                  e.split("{").forEach((e, s) => {
                    if (e.includes("}")) {
                      let [i, o] = e.split("}");
                      (n.push((0, a.jsx)(eD, { method: t, children: i }, `${r}-${s}-param`)),
                        o && n.push((0, a.jsx)(eL, { children: o }, `${r}-${s}`)));
                    } else {
                      e && n.push((0, a.jsx)(eL, { children: e }, `${r}-${s}`));
                    }
                  }),
                  n
                );
              }),
            [e, t],
          );
          return (0, a.jsxs)("div", {
            className: "group flex items-center flex-1 gap-0.5 font-mono pr-1.5",
            children: [
              (0, a.jsx)("div", {
                className: (0, u.cn)(
                  "absolute right-0 p-2 bg-background-light dark:bg-background-dark rounded-lg",
                  s && "bg-transparent dark:bg-transparent",
                  r ? "block" : "hidden group-hover:block",
                ),
                children: r
                  ? (0, a.jsx)(p.A, {
                      icon: "circle-check",
                      iconType: "solid",
                      className: "w-4 h-4 bg-primary dark:bg-primary-light",
                    })
                  : (0, a.jsx)(p.A, {
                      icon: "clone",
                      className: "w-4 h-4 bg-gray-400 dark:bg-white/30",
                    }),
              }),
              i,
            ],
          });
        },
        eL = ({ children: e }) =>
          (0, a.jsx)("div", {
            className: "text-sm font-medium text-gray-800 dark:text-white min-w-max",
            children: e,
          }),
        eD = ({ children: e, method: t }) => {
          let { paramStyle: r } = (0, l.H)(t);
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "text-sm font-mono font-medium rounded-md px-1 border-2 min-w-max",
              r,
            ),
            children: `{${e}}`,
          });
        },
        eM = () => (0, a.jsx)("div", { className: "text-sm text-gray-400", children: "/" });
      var eB = r(94585),
        eH = r(57810),
        eU = r(59705);
      let ez = ({
        baseUrl: e,
        baseUrlOptions: t,
        selectedBaseUrlIndex: r,
        setSelectedBaseUrlIndex: s,
        display: i,
        path: o,
        method: l,
        type: d,
        onBaseUrlChange: c,
        isInPlaygroundModal: p,
      }) => {
        let [m, h] = (0, n.useState)(!1),
          x = (({ path: e, baseUrl: t }) => {
            let r,
              a,
              n,
              s = (0, eU.jT)((e) => e.getApiPlaygroundInputs)(),
              i =
                ((r = e),
                Object.entries(s.path).reduce(
                  (e, [t, r]) =>
                    void 0 == r ? e : e.replace(`{${t}}`, encodeURIComponent(r.toString())),
                  r,
                ));
            return (
              (a = ((e, t) => {
                let r = e;
                return (
                  Object.entries(t).forEach(([e, t]) => {
                    t && (r = r.replace(`{${e}}`, t));
                  }),
                  r
                );
              })(t, s.server)),
              (n = i),
              a.replace(/\/$/, "") + "/" + n.replace(/^\//, "")
            );
          })({ path: o, baseUrl: e }),
          g = async () => {
            "success" === (await (0, eH.l)(x)) &&
              (h(!0),
              setTimeout(() => {
                h(!1);
              }, 2e3));
          };
        return (0, a.jsxs)("div", {
          className: (0, u.cn)(
            "relative flex-1 flex gap-2 min-w-0 rounded-xl items-center cursor-pointer p-1.5 pr-0 overflow-hidden",
            "simple" != i && "border-standard",
            p && "bg-gray-50 dark:bg-white/5",
          ),
          onClick: g,
          children: [
            (0, a.jsx)(eB.l, { method: "webhook" === d ? "webhook" : l, active: !1 }),
            (0, a.jsxs)("div", {
              className: "flex items-center space-x-2 overflow-x-auto flex-1 no-scrollbar",
              children: [
                (0, a.jsx)(eF, {
                  baseUrlOptions: t,
                  selectedBaseUrlIndex: r,
                  setSelectedBaseUrlIndex: s,
                  onBaseUrlChange: c,
                }),
                (0, a.jsx)(eR, { path: o, method: l, isCopiedActive: m, hasGrayBackground: p }),
              ],
            }),
          ],
        });
      };
      var eV = r(12757),
        eK = r(78306),
        eW = r(15209);
      let eG = ({ message: e, icon: t }) => {
          let r = (0, eW.e)();
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "system" === r ? "bg-response-body-auto" : "bg-response-body-dark",
              "rounded-b-xl overflow-auto",
            ),
            children: (0, a.jsxs)("div", {
              className: "pb-8 pt-10 px-6 space-y-4 flex flex-col items-center",
              children: [
                (0, a.jsx)(p.A, { icon: t, className: "h-8 w-8 bg-gray-300 dark:bg-white/20" }),
                (0, a.jsx)("div", { className: "text-sm text-center", children: e }),
              ],
            }),
          });
        },
        eJ = ({ data: e }) => {
          let t = (0, eW.e)();
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "system" === t ? "bg-response-body-auto" : "bg-response-body-dark",
              "flex p-12 items-center rounded-b-xl h-full",
            ),
            children: (0, a.jsx)("audio", { controls: !0, className: "w-full", src: e.url }),
          });
        };
      var eZ = r(90280),
        eX = r(27833),
        eY = r(65904),
        eQ = r(34972);
      let e0 = ({ data: e }) => {
          let t = (0, eW.e)(),
            r = (0, eW.O)(),
            n = (0, d.n)(),
            s = !1,
            i = e.content,
            o = e.content.length > 5 * eZ.S5;
          try {
            ((i = JSON.parse(e.content)), (s = !0));
          } catch (e) {
            console.error(e);
          }
          let l = (0, eQ.S)({
            codeString: s ? JSON.stringify(i, null, 2) : e.content,
            codeBlockTheme: r,
            language: s ? "json" : "text",
            opts: { structure: "inline" },
          });
          return (0, a.jsx)("div", {
            tabIndex: 0,
            role: "region",
            "aria-label": n["aria.responseContent"],
            className: (0, u.cn)("overflow-auto h-full", (0, eX.O)(t)),
            children: (0, a.jsx)("div", {
              className: (0, u.cn)(
                eY.SHIKI_CLASSNAME,
                "px-3 py-3.5 h-full whitespace-pre border-gray-200 dark:border-gray-700 dark:text-gray-300 font-mono text-xs leading-5",
                o && "whitespace-pre-line",
              ),
              children:
                s && void 0 !== l
                  ? (0, a.jsx)("span", {
                      suppressHydrationWarning: !0,
                      dangerouslySetInnerHTML: { __html: l },
                    })
                  : (0, a.jsx)("span", {
                      suppressHydrationWarning: !0,
                      children: s ? JSON.stringify(i, null, 2) : e.content,
                    }),
            }),
          });
        },
        e1 = ({ data: e }) => {
          let t = (0, eW.e)();
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "system" === t ? "bg-response-body-auto" : "bg-response-body-dark",
              "h-60",
            ),
            children: (0, a.jsx)("img", {
              alt: "image response from the server",
              className: "p-6 w-full h-full object-scale-down",
              src: e.url,
            }),
          });
        },
        e2 = ({ data: e }) => {
          let t = (0, eW.e)();
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "system" === t ? "bg-response-body-auto" : "bg-response-body-dark",
              "flex p-2 items-center h-full rounded-xt",
            ),
            children: (0, a.jsx)("video", {
              controls: !0,
              className: "w-full rounded-lg",
              src: e.url,
            }),
          });
        },
        e5 = ({ data: e }) => {
          let t = (0, d.n)();
          if (null == e) {
            return (0, a.jsx)(eG, { message: t["api.noBodyReceived"], icon: "brackets-curly" });
          }
          switch (e.type) {
            case "video":
              return (0, a.jsx)(e2, { data: e });
            case "audio":
              return (0, a.jsx)(eJ, { data: e });
            case "image":
              return (0, a.jsx)(e1, { data: e });
            case "other":
              return (0, a.jsx)(e0, { data: e });
          }
        },
        e4 = ({ message: e }) => {
          let t = (0, d.n)();
          return (0, a.jsx)(eG, {
            message: `${t["api.requestError"]} ${e}`,
            icon: "triangle-exclamation",
          });
        },
        e3 = ({ data: e }) => {
          let t = (0, eW.e)();
          return (0, a.jsx)("div", {
            className: "w-full rounded-b-xl overflow-y-auto",
            children: (0, a.jsx)("table", {
              className: "table-fixed pb-8 w-full pt-10",
              children: e.flatMap(([e, r]) =>
                (0, a.jsxs)(
                  "tr",
                  {
                    className: (0, u.cn)(
                      "w-full flex divide-x border-b last:border-b-0 text-xs text-gray-600 dark:text-gray-400",
                      "system" === t
                        ? "divide-gray-100 dark:divide-white/10 border-gray-100 dark:border-white/10 text-gray-600 dark:text-gray-400"
                        : "divide-white/10 border-white/10 text-gray-400",
                    ),
                    children: [
                      (0, a.jsx)("td", {
                        className:
                          "flex items-center basis-1/2 py-2 px-4 overflow-x-auto text-gray-600",
                        children: (0, a.jsx)("div", { className: "min-w-max", children: e }),
                      }),
                      (0, a.jsx)("td", {
                        className: "flex items-center basis-1/2 py-2 px-4 overflow-x-auto",
                        children: (0, a.jsx)("div", { className: "min-w-max", children: `${r}` }),
                      }),
                    ],
                  },
                  e,
                ),
              ),
            }),
          });
        },
        e6 = ({ response: e }) => {
          let t = (0, d.n)(),
            r = Object.entries(e.headers);
          return 0 === r.length
            ? (0, a.jsx)(eG, { message: t["api.noHeadersReceived"], icon: "table" })
            : (0, a.jsx)(e3, { data: r });
        };
      var e7 = r(87799);
      let e9 = ({ data: e }) => {
          let [t, r] = (0, n.useState)(!1),
            s = te(
              e,
              () => {
                (r(!0),
                  setTimeout(() => {
                    r(!1);
                  }, 2e3));
              },
              (e) => console.error(`unable to copy response to clipboard: ${e}`),
            );
          return s ? (0, a.jsx)(e7.rZ, { onClick: s, isCopiedActive: t }) : null;
        },
        e8 = new Set(["image/png", "text/plain"]),
        te = (e, t, r) =>
          (0, n.useMemo)(() => {
            if (e.contentType && e8.has(e.contentType)) {
              try {
                let a = new ClipboardItem({
                  [e.contentType]: e.blob
                    .arrayBuffer()
                    .then((t) => new Blob([t], { type: e.contentType }))
                    .catch((e) => {
                      throw Error(`Failed to process blob: ${e.message}`);
                    }),
                });
                return () => navigator.clipboard.write([a]).then(t, r);
              } catch (e) {
                console.error(`unable to create clipboard item: ${e}`);
              }
            }
            if ("other" === e.type) {
              return () => navigator.clipboard.writeText(e.content).then(t, r);
            }
          }, [e, t, r]),
        tt = ({ data: e }) => {
          let [t, r] = (0, n.useState)(!1),
            s = (0, d.n)(),
            i = (0, eW.e)();
          return e.extension
            ? (0, a.jsxs)("a", {
                "aria-label": t ? s["aria.fileDownloaded"] : s["aria.downloadResponseFile"],
                className: "group h-7 w-7 flex items-center justify-center cursor-pointer relative",
                onClick: () => {
                  (r(!0),
                    setTimeout(() => {
                      r(!1);
                    }, 2e3));
                },
                href: e.url,
                download: `api-response.${e.extension}`,
                children: [
                  t
                    ? (0, a.jsx)(p.A, {
                        icon: "circle-check",
                        iconType: "solid",
                        className: "h-4 w-4 bg-primary dark:bg-primary-light",
                      })
                    : (0, a.jsx)(p.A, {
                        icon: "arrow-down-to-line",
                        className: (0, u.cn)(
                          "w-4 h-4",
                          "system" === i
                            ? "bg-gray-400 group-hover:bg-gray-500 dark:bg-white/40 dark:group-hover:bg-white/60"
                            : "bg-white/40 group-hover:bg-white/60",
                        ),
                      }),
                  (0, a.jsx)(e7.iG, { text: t ? s["tooltip.copied"] : s["tooltip.download"] }),
                ],
              })
            : null;
        },
        tr = ({ result: e, selectedSection: t, setSelectedSection: r, data: n }) =>
          (0, a.jsxs)("div", {
            className: "flex w-full px-2 py-1 space-x-3 items-center rounded-t-2xl",
            children: [
              (0, a.jsx)("div", {
                className: "flex flex-1 space-x-4 items-center",
                children: (0, a.jsx)(ta, {
                  status: e.error ? void 0 : e.response.status,
                  statusText: e.error ? void 0 : e.response.statusText,
                }),
              }),
              n
                ? (0, a.jsxs)(a.Fragment, {
                    children: [
                      (0, a.jsx)(ts, { selectedSection: t, setSelectedSection: r }),
                      (0, a.jsx)(tt, { data: n }),
                      (0, a.jsx)(e9, { data: n }),
                    ],
                  })
                : null,
            ],
          }),
        ta = ({ status: e, statusText: t }) => {
          let r = (0, eW.e)();
          return (0, a.jsxs)("div", {
            className: "flex space-x-2 items-center",
            children: [
              (0, a.jsx)(tn, { status: e }),
              (0, a.jsx)("div", {
                className: (0, u.cn)(
                  "text-xs",
                  "system" === r
                    ? "text-gray-800 dark:text-gray-200 font-medium"
                    : "text-gray-200 font-medium",
                ),
                children: e ? `${e} - ${t}` : "--",
              }),
            ],
          });
        },
        tn = ({ status: e }) => {
          let t = "w-3.5 h-3.5";
          return void 0 === e
            ? (0, a.jsx)(p.A, {
                icon: "triangle-exclamation",
                className: (0, u.cn)(t, "bg-red-600 dark:bg-red-500"),
              })
            : e >= 400
              ? (0, a.jsx)(p.A, {
                  icon: "circle-x",
                  className: (0, u.cn)(t, "bg-red-600 dark:bg-red-500"),
                })
              : e >= 200 && e < 300
                ? (0, a.jsx)(p.A, {
                    icon: "circle-check",
                    className: (0, u.cn)(t, "bg-green-600 dark:bg-green-500"),
                  })
                : (0, a.jsx)(p.A, {
                    icon: "circle-exclamation",
                    className: (0, u.cn)(t, "bg-orange-600 dark:bg-orange-500"),
                  });
        },
        ts = ({ selectedSection: e, setSelectedSection: t }) => {
          let r = (0, eW.e)(),
            n = (0, d.n)();
          return (0, a.jsxs)("div", {
            className: "relative",
            children: [
              (0, a.jsx)("select", {
                "aria-label": n["aria.selectResponseSection"],
                className: (0, u.cn)(
                  "pl-2.5 pr-6 py-1 rounded-lg text-xs font-medium border cursor-pointer focus:outline-0",
                  "system" === r
                    ? "text-gray-600 dark:text-gray-400 border-standard hover:bg-gray-50 dark:hover:bg-white/[0.03]"
                    : "text-gray-200 border-gray-800/50 hover:bg-gray-800/50 bg-gray-800/50",
                ),
                value: e,
                onChange: (e) => t(e.target.value),
                children: to.map((e) =>
                  (0, a.jsx)(
                    "option",
                    { value: e, children: (e[0]?.toUpperCase() ?? "") + e.slice(1) },
                    e,
                  ),
                ),
              }),
              (0, a.jsx)("div", {
                className:
                  "pointer-events-none absolute inset-0 flex items-center justify-end pr-2.5",
                children: (0, a.jsx)(p.A, {
                  icon: "angle-down",
                  iconType: "solid",
                  className: (0, u.cn)(
                    "w-2.5 h-2.5",
                    "system" === r ? "bg-gray-400 dark:bg-gray-500" : "bg-gray-200",
                  ),
                }),
              }),
            ],
          });
        };
      var ti = r(60996).Buffer;
      let to = ["body", "headers"],
        tl = ({ result: e, className: t }) => {
          let [r, s] = (0, n.useState)("body"),
            o = td(e),
            l = (0, eW.e)();
          return (0, a.jsx)(i.A, {
            children: (0, a.jsxs)("div", {
              className: (0, u.cn)(
                "w-full flex-grow rounded-2xl border p-0.5",
                e.error && "flex-shrink-0",
                "system" === l
                  ? "bg-gray-50 dark:bg-white/5 border-gray-950/10 dark:border-white/10"
                  : "bg-codeblock dark:bg-white/5 border-white/10",
                t,
              ),
              children: [
                (0, a.jsx)(tr, { selectedSection: r, setSelectedSection: s, result: e, data: o }),
                (0, a.jsx)(
                  () =>
                    (0, a.jsx)("div", {
                      className: (0, u.cn)(
                        "rounded-xt dark:bg-codeblock max-h-[360px] overflow-y-auto",
                        "system" === l ? "bg-white" : "bg-codeblock",
                      ),
                      children: e.error
                        ? (0, a.jsx)(e4, { message: e.errorMessage })
                        : "body" === r
                          ? (0, a.jsx)(e5, { data: o })
                          : (0, a.jsx)(e6, { response: e.response }),
                    }),
                  {},
                ),
              ],
            }),
          });
        },
        td = (e) =>
          (0, n.useMemo)(() => {
            if (e.error || void 0 == e.response.data) {
              return;
            }
            let t = ti.from(e.response.data, "base64"),
              r = tc(e.response.headers),
              a = tp(r),
              n = new Blob([t], { type: r }),
              s = URL.createObjectURL(n),
              i = (r && (0, eK.extension)(r)) || void 0;
            return r && "other" !== a
              ? { type: a, contentType: r, blob: n, url: s, extension: i }
              : {
                  type: "other",
                  contentType: r,
                  content: t.toString("utf-8"),
                  blob: n,
                  url: s,
                  extension: i,
                };
          }, [e]),
        tc = (e) => {
          for (let t in e) {
            if ("content-type" === t.toLowerCase()) {
              let r = e[t];
              if ("string" == typeof r) return r.split(";")[0]?.toLowerCase();
            }
          }
        },
        tp = (e) => {
          let [t] = e?.split("/") ?? [];
          return "image" === t || "audio" === t || "video" === t ? t : "other";
        };
      var tu = r(92685),
        tm = r(16916),
        th = r(27194),
        tx = r(39282),
        tg = r(35878),
        tf = r(19664),
        ty = r.n(tf),
        tb = r(27541),
        tv = r(67793);
      let tj = ({ page: e }) => {
        let t = (0, tb.useRouter)(),
          r = (0, th.G)(),
          n = (0, tv.N)(e.href, r),
          s = "asyncapi" === e.type,
          i = "none" === e.playground || "simple" === e.playground || "webhook" === e.method;
        return (0, a.jsx)(ty(), {
          href: e.href,
          title: e.title,
          children: (0, a.jsxs)("div", {
            onClick: (r) => {
              (r.preventDefault(), i ? t.push(e.href) : t.push(`${e.href}?playground=open`));
            },
            className: (0, u.cn)(
              "flex items-center gap-x-2 hover:bg-gray-50 dark:hover:bg-white/5 rounded-xl p-1.5 group cursor-pointer",
              n
                ? "bg-gray-50 dark:bg-white/5 text-primary dark:text-primary-light font-medium"
                : "text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-300",
            ),
            children: [
              (0, a.jsx)(eB.l, {
                method: e.method,
                shortMethod: s,
                className: "font-medium px-1 py-px text-xs rounded-md",
                active: n,
              }),
              (0, a.jsx)("div", { className: "text-sm truncate", children: e.title }),
            ],
          }),
        });
      };
      var tk = r(43906),
        tw = r.n(tk),
        tN = r(65202),
        tC = r(24560),
        tS = r(12158);
      let tO = ({ search: e, setSearch: t }) => {
          let r = (0, d.n)(),
            { resolvedTheme: n } = (0, tC.D)(),
            s = tw()(async (e) => {
              t(e);
            }, tS.DEBOUNCE_TIME_IN_MS);
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "h-[52px] sticky z-[2] -mb-1 -mx-2 pb-0 p-2 left-0 top-0",
              "dark" === n ? "fade-down-dark" : "fade-down-light",
            ),
            children: (0, a.jsxs)("div", {
              className:
                "p-1.5 border border-gray-200/70 dark:border-white/10 rounded-[0.6rem] bg-white dark:bg-gray-950 border-solid flex items-center gap-x-2 mb-2",
              children: [
                (0, a.jsx)(tN.A, {
                  size: 16,
                  className: "min-w-4 flex-none text-gray-400 dark:text-gray-600",
                }),
                (0, a.jsx)("input", {
                  type: "text",
                  value: e,
                  onChange: (e) => s(e.target.value),
                  autoFocus: !0,
                  placeholder: r["api.searchEndpoint"],
                  "aria-label": r["aria.searchForEndpoint"],
                  className:
                    "w-full text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-600 font-light focus:outline-0 dark:bg-gray-950",
                }),
              ],
            }),
          });
        },
        t$ = (e) =>
          e.reduce((e, t) => {
            if ("pages" in t) {
              let r = [];
              if ("root" in t && "object" == typeof t.root) {
                let e = t.root;
                ("openapi" in e || "api" in e || "asyncapi" in e) && r.push(e);
              }
              return [...e, ...r, ...t$(t.pages)];
            }
            return "openapi" in t || "api" in t || "asyncapi" in t ? [...e, t] : e;
          }, []),
        tT = ({ endpoint: e, channel: t, operation: r }) => {
          let { divisions: s } = (0, n.useContext)(d.NavigationContext),
            [{ pageMetadata: i }] = (0, tx.O)(),
            o = (0, th.G)(),
            l = i.title || (0, tu.r)(o),
            [c, p] = (0, n.useState)(""),
            u = t$(s.groupsOrPages),
            m = (0, n.useMemo)(
              () =>
                u
                  .map((e) => {
                    if (e.asyncapi) {
                      if (
                        void 0 !=
                        ((e) => {
                          let t,
                            r,
                            a = e.trim().split(/\s+/);
                          if (!(a.length > 2)) {
                            if (a[0] && a[1]) {
                              [t, r] = a;
                            } else {
                              if (!a[0]) {
                                return;
                              }
                              r = a[0];
                            }
                            return { filename: t, channelId: r };
                          }
                        })(e.asyncapi)
                      ) {
                        return {
                          method: "websocket",
                          title: e.title || (0, tu.r)(e.href),
                          href: e.href,
                          type: "asyncapi",
                          playground: e.playground,
                        };
                      }
                    } else {
                      let t = e.openapi || e.api;
                      if (void 0 == t) {
                        return;
                      }
                      let r = (0, tm.sE)(t);
                      if (void 0 == r) {
                        return;
                      }
                      return {
                        method: r.method,
                        title: e.title || (0, tu.r)(e.href),
                        href: e.href,
                        type: "openapi",
                        playground: e.playground,
                      };
                    }
                  })
                  .filter((e) => void 0 != e),
              [u],
            ),
            h = r ? r.title || l : e ? e.title || l : t?.title || l,
            x = r ? r.method : e ? e.method : "websocket",
            g = (0, n.useMemo)(
              () => (c ? m.filter((e) => e.title.toLowerCase().includes(c.toLowerCase())) : m),
              [c, m],
            );
          return (0, a.jsxs)(Q.DropdownMenu, {
            children: [
              (0, a.jsx)(Q.DropdownMenuTrigger, {
                className: "hidden lg:block",
                id: tg.V.EndpointsMenuTrigger,
                children: (0, a.jsxs)("div", {
                  className:
                    "flex items-center gap-x-2 border-standard rounded-xl p-1.5 pr-3 min-w-80 hover:bg-gray-50 dark:hover:bg-white/5",
                  children: [
                    (0, a.jsx)(eB.l, { method: x, shortMethod: "websocket" === x, active: !0 }),
                    (0, a.jsx)("div", {
                      className:
                        "flex-1 text-left text-sm font-medium text-gray-900 dark:text-white truncate",
                      children: h,
                    }),
                    (0, a.jsx)("div", {
                      children: (0, a.jsx)(Y.A, {
                        className: "w-4 h-4 text-gray-500 dark:text-gray-400",
                      }),
                    }),
                  ],
                }),
              }),
              (0, a.jsx)(Q.DropdownMenuContent, {
                className:
                  "hidden lg:block w-80 border border-gray-100 dark:border-white/10 rounded-xl px-2 pb-2 pt-0",
                children: (0, a.jsxs)("div", {
                  className: "flex flex-col",
                  children: [
                    (0, a.jsx)(tO, { search: c, setSearch: p }),
                    g.map((e) =>
                      (0, a.jsx)(
                        "div",
                        { children: (0, a.jsx)(tj, { page: e }) },
                        `search-${e.title}-${e.href}`,
                      ),
                    ),
                  ],
                }),
              }),
            ],
          });
        },
        tE = ({ title: e, description: t }) =>
          (0, a.jsxs)("div", {
            className: "space-y-1 min-w-full w-full max-w-full overflow-hidden",
            children: [
              (0, a.jsx)("div", {
                className: "text-base font-medium text-gray-900 dark:text-white max-w-full",
                children: e,
              }),
              (0, a.jsx)("div", {
                className: "flex items-start gap-x-12 justify-between !max-w-full overflow-x-auto",
                children:
                  t &&
                  (0, a.jsx)(k, {
                    markdown: t,
                    className: "text-sm text-gray-500 dark:text-gray-400",
                  }),
              }),
            ],
          });
      var tA = r(15146),
        tP = r(97509),
        tI = r(67908);
      let t_ = ({ isPlaygroundExpanded: e, setIsPlaygroundExpanded: t, children: r }) =>
        (0, tP.createPortal)(
          (0, a.jsx)(tA.e, {
            show: e,
            as: n.Fragment,
            children: (0, a.jsxs)("div", {
              className: (0, u.cn)(tI.f.Popup, "fixed inset-0 overflow-y-auto p-4 sm:p-6 md:p-12"),
              children: [
                (0, a.jsx)(tA._, {
                  as: n.Fragment,
                  enter: "ease-out duration-100",
                  enterFrom: "opacity-0",
                  enterTo: "opacity-100",
                  leave: "ease-in duration-50",
                  leaveFrom: "opacity-100",
                  leaveTo: "opacity-0",
                  children: (0, a.jsx)("div", {
                    className:
                      "fixed z-0 inset-0 bg-background-dark/20 transition-opacity backdrop-blur-sm",
                    onClick: () => t?.(!1),
                  }),
                }),
                (0, a.jsx)(tA._, {
                  as: n.Fragment,
                  enter: "ease-out duration-100",
                  enterFrom: "opacity-0 scale-95",
                  enterTo: "opacity-100 scale-100",
                  leave: "ease-in duration-50",
                  leaveFrom: "opacity-100 scale-100",
                  leaveTo: "opacity-0 scale-95",
                  children: (0, a.jsxs)("div", {
                    "data-testid": "api-playground-modal",
                    className:
                      "relative mx-auto max-w-screen-xl max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-3rem)] md:max-h-[calc(100dvh-6rem)] overflow-y-auto overscroll-contain bg-background-light dark:bg-background-dark shadow-search rounded-3xl border-standard",
                    children: [
                      (0, a.jsx)("style", {
                        children: `[data-testid="api-playground-modal"] div:has(> #${tg.V.AskAiCodeBlockButton}) { display: none; }`,
                      }),
                      r,
                    ],
                  }),
                }),
              ],
            }),
          }),
          document.body,
        );
      var tq = r(37113),
        tF = r(47922),
        tR = r(99424);
      let tL = ({ options: e, selectedIndex: t, onSelectOption: r, className: n }) => {
          let s = e.length > 1,
            i = e[t];
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "relative flex items-center px-2 py-0.5 text-gray-600 dark:text-gray-300 hover:text-gray-950 dark:hover:text-white font-medium",
              n,
            ),
            children: (0, a.jsxs)(Q.DropdownMenu, {
              children: [
                (0, a.jsx)(Q.DropdownMenuTrigger, {
                  disabled: !s,
                  className:
                    "font-mono text-xs text-gray-600 dark:text-gray-300 hover:text-gray-950 dark:hover:text-white px-2",
                  children: (0, a.jsxs)("div", {
                    className: "flex items-center gap-1.5",
                    children: [
                      (0, a.jsx)("span", { children: i?.label }),
                      s &&
                        (0, a.jsx)(Y.A, {
                          className: "h-2.5 w-2.5 text-gray-500 dark:text-gray-400 shrink-0",
                        }),
                    ],
                  }),
                }),
                (0, a.jsx)(Q.DropdownMenuContent, {
                  className: "min-w-24",
                  children: e.map((e, n) =>
                    (0, a.jsx)(
                      Q._,
                      {
                        isSelected: n === t,
                        onSelect: () => r(n),
                        className: "text-xs",
                        children: e.label,
                      },
                      n,
                    ),
                  ),
                }),
              ],
            }),
          });
        },
        tD = ({ name: e, validationState: t, children: r, rightElement: s }) => {
          let [i, o] = (0, n.useState)(!0),
            l = (0, d.n)();
          return (0, a.jsxs)("div", {
            children: [
              (0, a.jsxs)("div", {
                role: "button",
                tabIndex: 0,
                "aria-label": l["aria.expandInputSection"],
                onClick: () => o((e) => !e),
                onKeyDown: (e) => {
                  ("Enter" === e.key || " " === e.key) && (e.preventDefault(), o((e) => !e));
                },
                className: (0, u.cn)(
                  "flex w-full px-4 py-2.5 items-center justify-between border-standard cursor-pointer hover:bg-gray-50 dark:hover:bg-white/5",
                  i ? "!border-b-0 border-t border-x rounded-t-2xl" : "rounded-2xl",
                ),
                children: [
                  (0, a.jsxs)("div", {
                    className: "flex items-center gap-x-1.5",
                    children: [
                      (0, a.jsx)(p.A, {
                        icon: "angle-right",
                        iconType: "solid",
                        className: (0, u.cn)(
                          "h-3 w-3 bg-gray-400 dark:bg-gray-500 transition-transform",
                          i && "rotate-90",
                        ),
                      }),
                      (0, a.jsxs)("div", {
                        className: "flex-1 flex items-center space-x-2",
                        children: [
                          (0, a.jsx)("div", {
                            className:
                              "text-sm font-medium text-gray-800 dark:text-gray-200 leading-6",
                            children: e,
                          }),
                          t ? ("invalid" === t ? (0, a.jsx)(tM, {}) : (0, a.jsx)(tB, {})) : null,
                        ],
                      }),
                    ],
                  }),
                  (0, a.jsx)("div", {
                    onClick: (e) => e.stopPropagation(),
                    onKeyDown: (e) => e.stopPropagation(),
                    children: s,
                  }),
                ],
              }),
              (0, a.jsxs)("div", {
                className: (0, u.cn)(
                  "bg-background-light dark:bg-background-dark flex-1 px-4 rounded-b-xl border-standard !border-t-0 divide-y divide-gray-100 dark:divide-white/10",
                  i && r ? "" : "hidden",
                ),
                children: [(0, a.jsx)("div", {}), r],
              }),
            ],
          });
        },
        tM = () => (0, a.jsx)(p.A, { className: "h-4 w-4 bg-[#2AB673]", icon: "circle-check" }),
        tB = () =>
          (0, a.jsx)(p.A, { className: "h-4 w-4 bg-[#CB3A32]", icon: "circle-exclamation" });
      var tH = r(20388),
        tU = r(42469);
      let tz = ({ className: e, onClick: t, label: r, dataTestId: n }) =>
          (0, a.jsx)("div", {
            className: e,
            children: (0, a.jsxs)("button", {
              "aria-label": r,
              className:
                "flex text-playground-input w-fit items-center gap-x-1.5 !py-1 !px-2 hover:bg-gray-50 dark:hover:bg-white/[0.03]",
              onClick: t,
              "data-testid": n,
              children: [
                (0, a.jsx)(p.A, {
                  icon: "plus",
                  iconType: "solid",
                  className: "bg-gray-500 dark:bg-white/40 h-3 w-3",
                }),
                (0, a.jsx)("span", { className: "text-gray-600 dark:text-gray-200", children: r }),
              ],
            }),
          }),
        tV = (e) => {
          switch ((0, b.HA)(e)) {
            case "object":
              return {};
            case "array":
              return [];
            case "string":
            case "enum<string>":
              return "";
            case "number":
            case "integer":
            case "enum<number>":
            case "enum<integer>":
              return 0;
            case "boolean":
              return !1;
            case "null":
              return null;
            case "oneOf":
              if (e.oneOf && Array.isArray(e.oneOf) && e.oneOf.length > 0) {
                let t = e.oneOf[0];
                if ((0, b.Fy)(t) && "null" !== t.type) {
                  return tV(t);
                }
                if (e.oneOf.length > 1 && (0, b.Fy)(e.oneOf[1])) {
                  return tV(e.oneOf[1]);
                }
              }
              return;
            default:
              return;
          }
        },
        tK = ({ schema: e, depth: t, parentNames: r, inputKeyPrefix: n, arrayIndices: s }) => {
          let i = (0, d.n)(),
            o = (0, eU.jT)((e) => e.setInput),
            l = (0, eU.jT)((e) => e.deleteInput),
            c = (0, eU.jT)((0, tU.k)((e) => e.inputs)),
            p = (0, tH.A)(),
            m = "items" in e && (0, b.Fy)(e.items) ? e.items : void 0;
          if (!m) {
            return null;
          }
          let h = "uniqueKey" in m ? m.uniqueKey : "",
            x = `${n}.${h}`;
          (s?.forEach((e) => {
            x = x.replace("[INDEX]", String(e));
          }),
            (x = x.replaceAll("[INDEX]", "")));
          let g = [];
          (Object.keys(c).forEach((e) => {
            if (e.startsWith(x)) {
              let t = e.substring(x.length).match(/^(\d+)/);
              if (t) {
                let e = parseInt(t[1] ?? "0", 10);
                g.includes(e) || g.push(e);
              }
            }
          }),
            g.toSorted((e, t) => e - t));
          let f = g.length > 0 ? Math.max(...g) + 1 : 0;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              g.map((e) => {
                let i = [...(s ?? []), e],
                  o = (0, y.ZZ)(n, m, i);
                return (0, a.jsx)(
                  rw,
                  {
                    schema: m,
                    arrayIndices: i,
                    depth: (t ?? 0) + 1,
                    parentNames: r,
                    inputKeyPrefix: n,
                    clearValue: () => {
                      l(o);
                    },
                    isArrayChild: !0,
                  },
                  `item-${e}`,
                );
              }),
              (0, a.jsx)(
                tz,
                {
                  label: i["api.addItem"],
                  className: (0, u.cn)(g.length > 0 && "mt-4"),
                  onClick: () => {
                    let e = [...(s ?? []), f];
                    o((0, y.ZZ)(n, m, e), tV(m));
                  },
                  dataTestId: x + "add-item-button",
                },
                "add-item-button" + p,
              ),
            ],
          });
        },
        tW = ({ name: e, schema: t, inputKeyPrefix: r, arrayIndices: s }) => {
          let i = (0, d.n)(),
            o = (0, n.useRef)(null),
            l = (0, b.vt)(t) ?? "Drop a file here or click to upload",
            c = (0, y.ZZ)(r, t, s),
            { value: p, setInput: m } = (0, eU.Bh)(c),
            h = p instanceof File ? p : void 0,
            x = h?.name ?? l;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)("button", {
                "aria-label": i["aria.fileUploadButton"],
                className: (0, u.cn)(
                  "text-left flex text-playground-input overflow-hidden",
                  h ? "!text-gray-900 dark:!text-gray-100" : "!text-gray-400 dark:!text-white/30",
                ),
                onClick: () => o.current?.click(),
                children: x,
              }),
              (0, a.jsx)("input", {
                type: "file",
                "data-testid": `${e ?? "file"}-input`,
                onChange: (e) => {
                  m(c, e.target.files?.[0]);
                },
                ref: o,
                className: "hidden",
              }),
            ],
          });
        };
      function tG({ children: e, className: t }) {
        return (0, a.jsx)("div", {
          className: (0, u.cn)(
            "rounded-full h-5 w-5 flex items-center justify-center bg-gray-50 dark:bg-white/10 text-xs font-sans font-medium text-gray-600 dark:text-gray-300",
            t,
          ),
          children: e,
        });
      }
      let tJ = ({ onClick: e, count: t, labeled: r }) => {
        let n = "";
        return 0 === t
          ? null
          : ((n = 1 === t ? "show 1 property" : `show ${t} properties`), r)
            ? (0, a.jsxs)("button", {
                "aria-label": n,
                onClick: e,
                className:
                  "flex justify-center items-center pt-0.5 pb-0.5 pl-2 pr-1.5 rounded-lg border border-gray-200 dark:border-gray-800 text-gray-600 dark:text-gray-400",
                children: [
                  (0, a.jsx)("span", {
                    className: "text-sm font-sans font-medium mr-1 whitespace-nowrap",
                    children: n,
                  }),
                  (0, a.jsx)(eq.A, { className: "w-3.5 h-3.5", strokeWidth: 2.5 }),
                ],
              })
            : (0, a.jsx)("button", {
                "aria-label": n,
                onClick: e,
                className: "px-1 text-gray-600 dark:text-gray-500",
                children: (0, a.jsx)(eq.A, { className: "w-3.5 h-3.5", strokeWidth: 2.5 }),
              });
      };
      var tZ = r(73205);
      let tX = (e) => /^\s*\|.*\|\s*$/m.test(e),
        tY = ({
          name: e,
          schema: t,
          defaultExpanded: r = !0,
          typeDropdown: s,
          arrayIndices: i,
          parentNames: o,
          clearValue: l,
          style: d,
          explode: c,
          children: p,
          isArrayChild: m,
        }) => {
          let [h, x] = (0, n.useState)(r),
            g = (0, b.GG)(t) && t.description && tX(t.description),
            f = "array" === t.type,
            y = "object" === t.type,
            v = y ? Object.keys(t.properties ?? {}).length : 0,
            k = i && i.length > 0 ? i[i.length - 1] : void 0,
            w = void 0 != k && m;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsxs)("div", {
                className: (0, u.cn)("flex space-x-3 items-start", w && !y && "flex items-center"),
                children: [
                  w && (0, a.jsx)(tG, { className: (0, u.cn)(y && "mt-8"), children: k + 1 }),
                  (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      "flex-1 grid lg:grid-cols-2 gap-x-12 gap-y-4 py-5 max-w-full",
                      f && "flex flex-col",
                      y &&
                        "gap-y-0 flex flex-col border border-gray-50 dark:border-white/5 rounded-xl px-4 py-0 my-5",
                      w && "py-1 my-2",
                    ),
                    children: [
                      (0, a.jsxs)("div", {
                        className: (0, u.cn)(
                          "space-y-2",
                          y && "pt-8 py-5 border-b border-gray-50 dark:border-white/5",
                          !h && "border-none",
                          w && !y && "flex items-center",
                        ),
                        children: [
                          (0, a.jsxs)("div", {
                            className: "flex items-center justify-between font-mono font-bold",
                            children: [
                              (0, a.jsxs)("div", {
                                className: "flex flex-wrap items-center gap-2 text-xs truncate",
                                title: o && o.length > 0 ? `${o.join(".")}.${e}` : e,
                                children: [
                                  (0, a.jsx)("div", {
                                    className: (0, u.cn)(
                                      "text-sm truncate",
                                      void 0 == e && "hidden",
                                    ),
                                    children:
                                      o && o.length > 0 && "deepObject" === d && c
                                        ? (0, a.jsxs)(a.Fragment, {
                                            children: [
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: o.map((e, t) =>
                                                  (0, a.jsxs)(a.Fragment, {
                                                    children: [e, 0 === t ? "[" : "]["],
                                                  }),
                                                ),
                                              }),
                                              (0, a.jsx)("span", {
                                                className:
                                                  "font-semibold text-gray-900 dark:text-gray-100",
                                                children: e,
                                              }),
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: "]",
                                              }),
                                            ],
                                          })
                                        : (0, a.jsxs)(a.Fragment, {
                                            children: [
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: o ? `${o.join(".")}.` : "",
                                              }),
                                              (0, a.jsx)("span", {
                                                className:
                                                  "font-semibold text-gray-900 dark:text-gray-100",
                                                children: e,
                                              }),
                                            ],
                                          }),
                                  }),
                                  void 0 != s
                                    ? s
                                    : (0, a.jsx)(S.ks, {
                                        className: "text-wrap",
                                        children: t.typeLabel,
                                      }),
                                  t.isRequired && (0, a.jsx)(S.rG, {}),
                                  t.deprecated && (0, a.jsx)(S.n, {}),
                                ],
                              }),
                              y &&
                                (0, a.jsx)(tJ, {
                                  onClick: () => x(!h),
                                  count: v,
                                  labeled: !1 == r,
                                }),
                            ],
                          }),
                          t.description &&
                            !g &&
                            (0, a.jsx)(j, {
                              markdown: t.description,
                              className: "text-gray-500 dark:text-gray-400",
                            }),
                        ],
                      }),
                      h &&
                        (0, a.jsx)("div", {
                          className: (0, u.cn)(
                            "grid grid-cols-1 w-full items-start divide-y divide-gray-50 dark:divide-white/5",
                            f && "divide-y-0",
                          ),
                          children: p,
                        }),
                    ],
                  }),
                  ((void 0 != i && i.length > 0) || o) &&
                    l &&
                    (0, a.jsx)(tQ, {
                      className: (0, u.cn)(y && "mt-8", o && "mt-7"),
                      onClick: () => l(),
                    }),
                ],
              }),
              t.description &&
                g &&
                (0, a.jsx)(j, {
                  markdown: t.description,
                  className: "text-gray-500 dark:text-gray-400",
                }),
            ],
          });
        },
        tQ = ({ className: e, onClick: t }) => {
          let r = (0, d.n)();
          return (0, a.jsx)("button", {
            className: (0, u.cn)(
              "px-1 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400",
              e,
            ),
            onClick: t,
            "aria-label": r["aria.deleteItem"],
            children: (0, a.jsx)(tZ.uc, { className: "w-4 h-4" }),
          });
        },
        t0 = () =>
          (0, a.jsx)("input", {
            className: "flex-1 min-w-0 outline-0 bg-transparent text-playground-input",
            type: "text",
            placeholder: "--",
            contentEditable: "false",
            disabled: !0,
          });
      var t1 = r(5693);
      let t2 = ({ name: e, schema: t, inputKeyPrefix: r, numberType: n, arrayIndices: s }) => {
          let i = (0, d.n)(),
            o = (0, b.vt)(t),
            l = (0, y.ZZ)(r, t, s),
            { value: c, setInput: p } = (0, eU.Bh)(l),
            u = o ?? i["api.enterValue"].replace("{name}", e ?? i["api.value"]),
            m = t.type,
            h = ((e, t) =>
              "integer" === e ? ((0, t1.Fq)(t) ? t : void 0) : (0, t1.Et)(t) ? t : void 0)(n, c);
          return (0, a.jsx)("input", {
            id: tg.V.APIPlaygroundInput,
            className: "flex-1 min-w-0 bg-transparent outline-0 text-playground-input",
            placeholder: u,
            "aria-label": o ?? i["aria.enterValue"].replace("{name}", e ?? i["api.value"]),
            onKeyDown: (e) => {
              ("e" === e.key || ("." === e.key && "integer" === m)) && e.preventDefault();
            },
            type: "number",
            value: h ?? "",
            onChange: (e) => {
              if (0 === e.target.value.length) {
                return void p(l, void 0);
              }
              if ("integer" === m) {
                let t = parseInt(e.target.value);
                if (isNaN(t)) {
                  return;
                }
                p(l, t);
              } else {
                p(l, parseFloat(e.target.value));
              }
            },
          });
        },
        t5 = (e, t, r) => {
          if (!(0, b.Fy)(e)) {
            return e;
          }
          let a = { ...e };
          if (
            (a.uniqueKey && a.uniqueKey.startsWith(t) && (a.uniqueKey = a.uniqueKey.replace(t, r)),
            a.oneOf &&
              Array.isArray(a.oneOf) &&
              (a.oneOf = a.oneOf.map((e) => ((0, b.Fy)(e) ? t5(e, t, r) : e))),
            a.properties && "object" == typeof a.properties)
          ) {
            let e = {};
            (Object.entries(a.properties).forEach(([a, n]) => {
              (0, b.Fy)(n) ? (e[a] = t5(n, t, r)) : (e[a] = n);
            }),
              (a.properties = e));
          }
          return (
            a.additionalProperties &&
              "object" == typeof a.additionalProperties &&
              (0, b.Fy)(a.additionalProperties) &&
              (a.additionalProperties = t5(a.additionalProperties, t, r)),
            "array" === a.type &&
              "items" in a &&
              (0, b.Fy)(a.items) &&
              (a.items = t5(a.items, t, r)),
            a
          );
        };
      var t4 = r(20043),
        t3 = r.n(t4);
      let t6 = () => {
          let { apiReferenceData: e } = (0, n.useContext)(s.ApiReferenceContext);
          return e.componentSchemas;
        },
        t7 = ({ className: e, onClick: t }) => {
          let r = (0, d.n)();
          return (0, a.jsx)("button", {
            className: (0, u.cn)(
              "px-1 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400",
              e,
            ),
            onClick: t,
            "aria-label": r["aria.deleteItem"],
            children: (0, a.jsx)(tZ.uc, { className: "w-4 h-4" }),
          });
        },
        t9 = ({
          name: e,
          children: t,
          schema: r,
          onClear: s,
          isObject: o,
          isArray: l,
          parentNames: d,
          arrayIndex: c,
          typeDropdown: p,
          defaultExpanded: m = !0,
          style: h,
          explode: x,
        }) => {
          let [g, f] = (0, n.useState)(m),
            y = "object" === r.type ? Object.keys(r.properties).length : 0,
            b = "format" in r && "string" == typeof r.format ? `${r.type}<${r.format}>` : r.type,
            v = t8(r) && r.description && tX(r.description);
          return (0, a.jsxs)(i.A, {
            children: [
              (0, a.jsxs)("div", {
                className: (0, u.cn)(
                  "flex space-x-3 items-start",
                  void 0 != c && !o && "flex items-center",
                ),
                children: [
                  void 0 != c &&
                    (0, a.jsx)(tG, { className: (0, u.cn)(o && "mt-8"), children: c + 1 }),
                  (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      "flex-1 grid lg:grid-cols-2 gap-x-12 gap-y-4 py-5 max-w-full",
                      l && "flex flex-col",
                      o &&
                        "gap-y-0 flex flex-col border border-gray-50 dark:border-white/5 rounded-xl px-4 py-0 my-5",
                      void 0 !== c && "py-1 my-2",
                    ),
                    children: [
                      (0, a.jsxs)("div", {
                        className: (0, u.cn)(
                          "space-y-2",
                          o && "pt-8 py-5 border-b border-gray-50 dark:border-white/5",
                          !g && "border-none",
                          void 0 != c && !o && "flex items-center",
                        ),
                        children: [
                          (0, a.jsxs)("div", {
                            className: "flex items-center justify-between font-mono font-bold",
                            children: [
                              (0, a.jsxs)("div", {
                                className: "flex flex-wrap items-center gap-2 text-xs truncate",
                                title: d ? `${d.join(".")}.${e}` : e,
                                children: [
                                  (0, a.jsx)("div", {
                                    className: (0, u.cn)(
                                      "text-sm truncate",
                                      void 0 == e && "hidden",
                                    ),
                                    children:
                                      d && d.length > 0 && "deepObject" === h && x
                                        ? (0, a.jsxs)(a.Fragment, {
                                            children: [
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: d.map((e, t) =>
                                                  (0, a.jsxs)(a.Fragment, {
                                                    children: [e, 0 === t ? "[" : "]["],
                                                  }),
                                                ),
                                              }),
                                              (0, a.jsx)("span", {
                                                className:
                                                  "font-semibold text-gray-900 dark:text-gray-100",
                                                children: e,
                                              }),
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: "]",
                                              }),
                                            ],
                                          })
                                        : (0, a.jsxs)(a.Fragment, {
                                            children: [
                                              (0, a.jsx)("span", {
                                                className: "text-gray-500 dark:text-gray-400",
                                                children: d ? `${d.join(".")}.` : "",
                                              }),
                                              (0, a.jsx)("span", {
                                                className:
                                                  "font-semibold text-gray-900 dark:text-gray-100",
                                                children: e,
                                              }),
                                            ],
                                          }),
                                  }),
                                  void 0 != p ? p : (0, a.jsx)(S.ks, { children: b }),
                                  r.required && (0, a.jsx)(S.rG, {}),
                                  r.deprecated && (0, a.jsx)(S.n, {}),
                                ],
                              }),
                              o &&
                                (0, a.jsx)(tJ, {
                                  onClick: () => f(!g),
                                  count: y,
                                  labeled: !1 == m,
                                }),
                            ],
                          }),
                          r.description &&
                            !v &&
                            (0, a.jsx)(j, {
                              markdown: r.description,
                              className: "text-gray-500 dark:text-gray-400",
                            }),
                        ],
                      }),
                      g &&
                        (0, a.jsx)("div", {
                          className: (0, u.cn)(
                            "grid grid-cols-1 w-full items-start divide-y divide-gray-50 dark:divide-white/5",
                            l && "divide-y-0",
                          ),
                          children: t,
                        }),
                    ],
                  }),
                  (void 0 != c || d) &&
                    s &&
                    (0, a.jsx)(t7, {
                      className: (0, u.cn)(o && "mt-8", d && "mt-7"),
                      onClick: () => s(),
                    }),
                ],
              }),
              r.description &&
                v &&
                (0, a.jsx)(j, {
                  markdown: r.description,
                  className: "text-gray-500 dark:text-gray-400",
                }),
            ],
          });
        },
        t8 = (e) =>
          "enum<integer>" === e.type || "enum<number>" === e.type || "enum<string>" === e.type;
      var re = r(60130),
        rt = r(28331),
        rr = r(67377);
      let ra = ({
          name: e,
          schema: t,
          typeDropdown: r,
          value: s,
          setValue: i,
          clearValue: o,
          parentNames: l,
          arrayIndex: c,
        }) => {
          let p = (0, d.n)(),
            m = (0, n.useRef)(null);
          return (0, a.jsxs)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: o,
            parentNames: l,
            arrayIndex: c,
            children: [
              (0, a.jsx)("button", {
                "aria-label": p["aria.fileUploadButton"],
                className: (0, u.cn)(
                  "text-left flex text-playground-input overflow-hidden",
                  s ? "!text-gray-900 dark:!text-gray-100" : "!text-gray-400 dark:!text-white/30",
                ),
                onClick: () => m.current?.click(),
                children: s?.name ?? t.placeholder ?? "Drop a file here or click to upload",
              }),
              (0, a.jsx)("input", {
                type: "file",
                "data-testid": "file-input",
                onChange: (e) => i(e.target.files?.[0]),
                ref: m,
                className: "hidden",
              }),
            ],
          });
        },
        rn = ({
          name: e,
          schema: t,
          typeDropdown: r,
          clearValue: n,
          parentNames: s,
          arrayIndex: i,
        }) =>
          (0, a.jsx)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: n,
            parentNames: s,
            arrayIndex: i,
            children: (0, a.jsx)("input", {
              className: "flex-1 min-w-0 outline-0 bg-transparent text-playground-input",
              type: "text",
              placeholder: "--",
              contentEditable: "false",
              disabled: !0,
            }),
          }),
        rs = ({
          name: e,
          typeDropdown: t,
          schema: r,
          value: s,
          setValue: i,
          clearValue: o,
          arrayIndex: l,
          ...c
        }) => {
          let p = (0, d.n)(),
            u = (0, n.useCallback)(
              (e) => {
                if (0 === e.target.value.length) {
                  return void i(void 0);
                }
                if ("integer" === r.type) {
                  let t = parseInt(e.target.value);
                  if (isNaN(t)) {
                    return;
                  }
                  i(t);
                } else {
                  i(parseFloat(e.target.value));
                }
              },
              [i, r.type],
            );
          return (0, a.jsx)(t9, {
            name: e,
            typeDropdown: t,
            schema: r,
            onClear: o,
            parentNames: c.parentNames,
            arrayIndex: l,
            children: (0, a.jsx)("input", {
              id: tg.V.APIPlaygroundInput,
              className: "flex-1 min-w-0 bg-transparent outline-0 text-playground-input",
              placeholder:
                r.placeholder ?? p["api.enterValue"].replace("{name}", e ?? p["api.value"]),
              "aria-label":
                r.placeholder ?? p["aria.enterValue"].replace("{name}", e ?? p["api.value"]),
              onKeyDown: (e) => {
                ("e" === e.key || ("." === e.key && "integer" === r.type)) && e.preventDefault();
              },
              type: "number",
              value: s ?? "",
              onChange: u,
            }),
          });
        };
      function ri(e, t = "", r = {}) {
        for (let a in e) {
          let n = t ? `${t}.${a}` : a,
            s = e[a];
          "object" == typeof s ? ri(s, n, r) : (r[n] = s);
        }
        return r;
      }
      let ro = ({
          name: e,
          schema: t,
          typeDropdown: r,
          setValue: s,
          clearValue: i,
          value: o,
          depth: l,
          parentNames: d,
          arrayIndex: c,
          defaultExpanded: p,
          style: u,
          explode: m,
          renderedRefs: h,
        }) => {
          let [x, g] = (0, n.useState)(t3()()),
            f = !1 !== t.additionalProperties,
            y = [...Object.keys(o ?? {}), ...Object.keys(t.properties)],
            b = (function (e) {
              let t = t6(),
                { location: r } = (0, I.ad)();
              return (0, n.useMemo)(
                () =>
                  Object.fromEntries(
                    Object.entries(e.properties)
                      .toSorted(([t], [r]) => {
                        let a = e.requiredProperties?.includes(t) ?? !1;
                        return a === (e.requiredProperties?.includes(r) ?? !1) ? 0 : a ? -1 : 1;
                      })
                      .map(([a, n]) =>
                        Array.isArray(n)
                          ? [a, n]
                          : [a, eN(n, t, e.requiredProperties?.includes(a), r)],
                      ),
                  ),
                [e, t, r],
              );
            })(t),
            v = (function (e) {
              let t = t6(),
                { location: r } = (0, I.ad)();
              return (0, n.useMemo)(
                () =>
                  "object" != typeof e.additionalProperties || Array.isArray(e.additionalProperties)
                    ? e.additionalProperties
                    : eN(e.additionalProperties, t, void 0, r),
                [e, t, r],
              );
            })(t),
            j = t.refIdentifier,
            k = (0, n.useMemo)(
              () =>
                (({
                  properties: e,
                  additionalProperties: t,
                  value: r,
                  setValue: n,
                  name: s,
                  parentNames: i,
                  defaultExpanded: o,
                  depth: l,
                  refId: d,
                  refs: c,
                  style: p,
                  explode: u,
                }) => {
                  let m = new Set(c);
                  d && m.add(d);
                  let h = [],
                    x = ((e, t, r) => {
                      let a = Object.entries(e).map(([e, t]) => ({
                        key: e,
                        schema: t,
                        value: r?.[e],
                        isAdditionalProperty: !1,
                      }));
                      if (!1 === t) {
                        return a;
                      }
                      let n = "object" == typeof t ? t : [{ type: "any" }];
                      return [
                        ...a,
                        ...Object.keys(r ?? {})
                          .filter((t) => !Object.keys(e).includes(t))
                          .map((e) => ({
                            key: e,
                            schema: n,
                            value: r?.[e],
                            isAdditionalProperty: !0,
                          })),
                      ];
                    })(e, t, r);
                  return (
                    m.size > 0
                      ? x.map((e) => {
                          let { key: t, schema: d, value: c, isAdditionalProperty: x } = e,
                            g =
                              void 0 !== c || x
                                ? () => {
                                    let e = { ...r };
                                    (delete e[t], n(e));
                                  }
                                : void 0,
                            f = s ? [...(i ?? []), s] : void 0,
                            y = Object.values(
                              ((e) =>
                                "object" === e.type
                                  ? ri(e.properties)
                                  : "array" === e.type
                                    ? ri(e.items)
                                    : [])(d[0]),
                            ).some((e) => "string" == typeof e && m.has(e));
                          h.push(
                            (0, a.jsx)(
                              rm,
                              {
                                name: t,
                                schemaArray: d,
                                value: c,
                                setValue: (e) => {
                                  let a = { ...r };
                                  ((a[t] = e), n(a));
                                },
                                clearValue: g,
                                depth: l + 1,
                                parentNames: f,
                                defaultExpanded: !y && o,
                                renderedRefs: new Set(m),
                                style: p,
                                explode: u,
                              },
                              t,
                            ),
                          );
                        })
                      : x.map((e) => {
                          let { key: t, schema: d, value: c, isAdditionalProperty: m } = e,
                            x =
                              void 0 !== c || m
                                ? () => {
                                    let e = { ...r };
                                    (delete e[t], n(e));
                                  }
                                : void 0,
                            g = s ? [...(i ?? []), s] : void 0;
                          h.push(
                            (0, a.jsx)(
                              rm,
                              {
                                name: t,
                                schemaArray: d,
                                value: c,
                                setValue: (e) => {
                                  let a = { ...r };
                                  ((a[t] = e), n(a));
                                },
                                clearValue: x,
                                depth: l + 1,
                                parentNames: g,
                                defaultExpanded: o,
                                style: p,
                                explode: u,
                                renderedRefs: new Set(),
                              },
                              t,
                            ),
                          );
                        }),
                    h
                  );
                })({
                  properties: b,
                  additionalProperties: v,
                  value: o,
                  setValue: s,
                  name: e,
                  parentNames: d,
                  defaultExpanded: p,
                  depth: l,
                  refId: j,
                  refs: new Set(h),
                  style: u,
                  explode: m,
                }),
              [v, p, l, e, d, b, j, h, s, o, u, m],
            );
          return 0 === l
            ? k
            : (0, a.jsxs)(t9, {
                name: e,
                typeDropdown: r,
                schema: t,
                onClear: i,
                isObject: !0,
                parentNames: d,
                arrayIndex: c,
                defaultExpanded: p,
                style: u,
                explode: m,
                children: [
                  k,
                  f
                    ? (0, a.jsx)(
                        rg,
                        {
                          onAddKey: (e) => {
                            let t = { ...o };
                            ((t[e] = void 0), s(t), g(t3()()));
                          },
                          existingKeys: y,
                          dataTestId: e + "-additional-property-button",
                        },
                        x,
                      )
                    : null,
                ],
              });
        },
        rl = ({
          name: e,
          schema: t,
          typeDropdown: r,
          value: n,
          setValue: s,
          clearValue: i,
          parentNames: o,
          arrayIndex: l,
        }) => {
          let c = (0, d.n)(),
            p = (0, rr.f)(),
            m =
              "boolean" === t.type
                ? [!0, !1]
                : (({ schema: e, userGroups: t }) => {
                    let r = e.enum;
                    return (
                      e["x-mint-enum"] &&
                        (r =
                          "enum<string>" === e.type
                            ? ((e, t) => {
                                let r = e.enum,
                                  a = [];
                                return (
                                  Object.entries(e["x-mint-enum"] ?? {}).forEach(([e, r]) => {
                                    (Array.isArray(r) && r.some((e) => t?.includes(e))) ||
                                      a.push(e);
                                  }),
                                  r.filter((e) => !a.includes(e))
                                );
                              })(e, t)
                            : ((e, t) => {
                                let r = e.enum,
                                  a = [];
                                return (
                                  Object.entries(e["x-mint-enum"] ?? {}).forEach(([e, r]) => {
                                    (Array.isArray(r) && r.some((e) => t?.includes(e))) ||
                                      a.push(Number(e));
                                  }),
                                  r.filter((e) => !a.includes(e))
                                );
                              })(e, t)),
                      r
                    );
                  })({ schema: t, userGroups: p });
          return (0, a.jsx)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: i,
            parentNames: o,
            arrayIndex: l,
            children: (0, a.jsxs)("div", {
              className: "relative",
              children: [
                (0, a.jsxs)("select", {
                  className: (0, u.cn)(
                    "relative text-playground-input w-full text-left flex-1 outline-0 cursor-pointer bg-transparent",
                    void 0 !== n
                      ? "!text-gray-900 dark:!text-gray-100"
                      : "!text-gray-400 dark:!text-white/30",
                  ),
                  value: n?.toString() ?? "",
                  "aria-label":
                    t.placeholder ?? c["aria.selectOption"].replace("{name}", e || c["api.option"]),
                  onChange: (e) => {
                    "boolean" === t.type ? s("true" === e.target.value) : s(e.target.value);
                  },
                  children: [
                    (0, a.jsx)("option", {
                      value: "",
                      disabled: !0,
                      children:
                        t.placeholder ??
                        c["api.selectOption"].replace("{name}", e || c["api.option"]),
                    }),
                    m.map((e) =>
                      (0, a.jsx)(
                        "option",
                        { value: e.toString(), children: e.toString() },
                        e.toString(),
                      ),
                    ),
                  ],
                }),
                (0, a.jsx)(Y.A, {
                  className:
                    "absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-white/30 pointer-events-none",
                }),
              ],
            }),
          });
        },
        rd = ({
          name: e,
          schema: t,
          typeDropdown: r,
          value: s,
          setValue: i,
          clearValue: o,
          parentNames: l,
          arrayIndex: c,
          style: p,
          explode: u,
        }) => {
          let m = (0, d.n)(),
            { prefix: h, placeholder: x } = rc(t.format, m["api.enterBearerToken"]),
            g = h && s?.startsWith(h) ? s.substring(h.length) : s,
            f = (0, n.useCallback)(
              (e) => {
                let t = `${h ?? ""}${e}`;
                t ? i(t) : i(void 0);
              },
              [i, h],
            );
          return (0, a.jsx)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: o,
            parentNames: l,
            arrayIndex: c,
            style: p,
            explode: u,
            children: (0, a.jsxs)("div", {
              className: "relative flex flex-1 items-center",
              children: [
                (0, a.jsx)("div", {
                  className:
                    "absolute left-2.5 top-0 bottom-0 flex items-center justify-center text-sm text-gray-800 dark:text-gray-100",
                  children: h,
                }),
                (0, a.jsx)("input", {
                  id: tg.V.APIPlaygroundInput,
                  className: "flex-1 min-w-0 bg-transparent outline-0 text-playground-input",
                  style: { paddingLeft: h ? 0.52 * h.length + "rem" : void 0 },
                  placeholder:
                    t.placeholder ??
                    x ??
                    m["api.enterValue"].replace("{name}", e ?? m["api.value"]),
                  "aria-label":
                    t.placeholder ??
                    x ??
                    m["aria.enterValue"].replace("{name}", e ?? m["api.value"]),
                  type: "text",
                  value: g ?? "",
                  onChange: (e) => f(e.target.value),
                  spellCheck: !1,
                }),
              ],
            }),
          });
        },
        rc = (e, t) => (e?.toLowerCase() === "bearer" ? { prefix: "Bearer ", placeholder: t } : {}),
        rp = ({
          name: e,
          schema: t,
          typeDropdown: r,
          value: n,
          setValue: s,
          clearValue: i,
          parentNames: o,
          arrayIndex: l,
        }) => {
          let c = (0, d.n)();
          return (0, a.jsx)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: i,
            parentNames: o,
            arrayIndex: l,
            children: (0, a.jsx)("textarea", {
              className:
                "-mx-3.5 px-3.5 flex-1 min-h-[2.5rem] min-w-0 bg-transparent outline-0 text-playground-input resize-y",
              rows: 2,
              placeholder:
                t.placeholder ??
                c["api.enterValueCapitalized"].replace("{name}", e ?? c["api.value"]),
              "aria-label":
                t.placeholder ?? c["aria.enterValue"].replace("{name}", e ?? c["api.value"]),
              value: n,
              onChange: (e) => s(e.target.value),
              spellCheck: !1,
              autoCapitalize: "off",
              autoComplete: "off",
              autoCorrect: "off",
            }),
          });
        },
        ru = ({
          schema: e,
          value: t,
          depth: r,
          isBody: s,
          setValue: i,
          defaultExpanded: o,
          renderedRefs: l,
          prefillDisabled: d,
          ...c
        }) => {
          switch (
            (((e, t, r, a) => {
              let s = (0, n.useRef)(!1);
              (0, n.useEffect)(() => {
                if (!a && !s.current) {
                  switch (
                    (void 0 === e.default &&
                      void 0 !== e["x-default"] &&
                      (e.default = e["x-default"]),
                    e.type)
                  ) {
                    case "string":
                    case "enum<string>":
                      (0, t1.Kg)(e.default) && !(0, t1.Kg)(t) && r(e.default);
                      break;
                    case "number":
                    case "enum<number>":
                      (0, t1.Et)(e.default) && !(0, t1.Et)(t) && r(e.default);
                      break;
                    case "boolean":
                      (0, t1.Lm)(e.default) && !(0, t1.Lm)(t) && r(e.default);
                      break;
                    case "object":
                      if (e.default && (0, t1.Gv)(e.default) && !(0, t1.Gv)(t)) {
                        let t = {};
                        for (let [r, a] of Object.entries(e.default)) {
                          t[r] = a;
                        }
                        r(t);
                      }
                      break;
                    case "integer":
                    case "enum<integer>":
                      (0, t1.Fq)(e.default) && !(0, t1.Fq)(t) && r(e.default);
                      break;
                    case "array":
                      void 0 === e.default ||
                        (0, t1.cy)(t) ||
                        r([...((0, t1.cy)(e.default) ? e.default : [e.default])]);
                      break;
                    case "null":
                      (0, t1.kZ)(e.default) && null !== t && r(e.default);
                  }
                  s.current = !0;
                }
              }, [e, t, r, a]);
            })(e, t, i, d),
            e.type)
          ) {
            case "string": {
              let n = (0, t1.Kg)(t) ? t : void 0;
              return (0, a.jsx)(s && 0 === r ? rp : rd, { schema: e, value: n, setValue: i, ...c });
            }
            case "number": {
              let r = (0, t1.Et)(t) ? t : void 0;
              return (0, a.jsx)(rs, { schema: e, value: r, setValue: i, ...c });
            }
            case "boolean": {
              let r = (0, t1.Lm)(t) ? t : void 0;
              return (0, a.jsx)(rl, { schema: e, value: r, setValue: i, ...c });
            }
            case "object": {
              let n = (0, t1.Gv)(t) ? t : void 0;
              return (0, a.jsx)(ro, {
                schema: e,
                value: n,
                setValue: i,
                depth: r,
                defaultExpanded: o,
                renderedRefs: l,
                ...c,
              });
            }
            case "integer": {
              let r = (0, t1.Fq)(t) ? t : void 0;
              return (0, a.jsx)(rs, { schema: e, value: r, setValue: i, ...c });
            }
            case "array": {
              let n = (0, t1.cy)(t) ? t : void 0;
              return (0, a.jsx)(rh, { schema: e, value: n, setValue: i, depth: r, ...c });
            }
            case "enum<string>": {
              let r = (0, t1.Kg)(t) ? t : void 0;
              return (0, a.jsx)(rl, { schema: e, value: r, setValue: i, ...c });
            }
            case "enum<number>": {
              let r = (0, t1.Et)(t) ? t : void 0;
              return (0, a.jsx)(rl, { schema: e, value: r, setValue: i, ...c });
            }
            case "enum<integer>": {
              let r = (0, t1.Fq)(t) ? t : void 0;
              return (0, a.jsx)(rl, { schema: e, value: r, setValue: i, ...c });
            }
            case "file": {
              let r = t instanceof File ? t : void 0;
              return (0, a.jsx)(ra, { schema: e, value: r, setValue: i, ...c });
            }
            case "null": {
              let r = null === t ? null : void 0;
              return (0, a.jsx)(rn, { schema: e, value: r, setValue: i, ...c });
            }
          }
        },
        rm = ({
          name: e,
          value: t,
          schemaArray: r,
          setValue: o,
          clearValue: l,
          isBody: d,
          depth: c = 0,
          parentNames: p,
          arrayIndex: u,
          defaultExpanded: m,
          style: h,
          explode: x,
          renderedRefs: g = new Set(),
        }) => {
          let f = eS({ schemaArray: r, userGroups: (0, rr.f)() }),
            [y, b] = (0, n.useState)(0),
            v = ((e) => {
              let t = t6(),
                r = (0, rr.f)();
              return (0, n.useMemo)(
                () =>
                  e
                    ? ((e, t, r) => {
                        let a,
                          n = e.some((e) => "null" === e.type),
                          s = e.every((e) => "object" === e.type),
                          i = ((e, t, r, a, n, s) => {
                            if (e.length <= 1) {
                              return [eT(e[0], t, a, n)];
                            }
                            if (r) {
                              return e.map(({ title: e }, t) => e ?? `Option ${t + 1}`);
                            }
                            let i = e.map((e) => eT(e, t, a, n, 0));
                            return new Set(i).size === i.length
                              ? i
                              : s
                                ? i.map((t, r) =>
                                    "any" === t
                                      ? t
                                      : (e[r]?.title ?? `Option ${r + 1}`) + " \xb7 " + t,
                                  )
                                : i.map(
                                    (t, r) => (e[r]?.title ?? `Option ${r + 1}`) + " \xb7 " + t,
                                  );
                          })(e, t, s, n, r, !0),
                          o = [],
                          l = [];
                        for (let t of e) {
                          "any" === t.type ? (a = a ?? t) : o.push(t);
                        }
                        for (let e of i) {
                          "any" === e ? l.push(null) : l.push(e);
                        }
                        if (void 0 !== a) {
                          let e = { description: a.description, required: a.required };
                          o.push(
                            { ...e, type: "string" },
                            { ...e, type: "number" },
                            { ...e, type: "boolean" },
                            { ...e, type: "object", properties: {} },
                            { ...e, type: "array", items: [{ type: "any" }] },
                            { ...e, type: "null" },
                          );
                        }
                        return o.map((e, t) => ({ schema: e, label: l[t] ?? e.type }));
                      })(e, t, r)
                    : [],
                [e, t, r],
              );
            })(f),
            j = v[y]?.schema,
            { prefillExamplesEnabled: k } = (() => {
              let { docsConfig: e } = (0, n.useContext)(s.DocsConfigContext),
                t = (0, rt.Zk)(),
                r = (() => {
                  let e = (0, rt.Zk)(),
                    { docsConfig: t } = (0, n.useContext)(s.DocsConfigContext);
                  return (0, n.useMemo)(() => {
                    let r = e?.servers?.map(({ url: e }) => e);
                    if (r && r.length > 0) {
                      return r;
                    }
                    let a = t?.api?.mdx?.server;
                    return "string" == typeof a ? [a] : a;
                  }, [e?.servers, t?.api?.mdx?.server]);
                })(),
                [{ apiBaseIndex: a }] = (0, tx.O)(),
                i = r?.[a] ?? r?.[0],
                o = void 0 !== t && void 0 !== i;
              return e?.api?.examples?.prefill && o
                ? {
                    prefillExamplesEnabled: !0,
                    generatedRequestExampleData: ((e) => {
                      let [t] = Object.entries(e.request.body);
                      if (void 0 === t) {
                        return [re.x4];
                      }
                      let [r, a] = t,
                        n = Object.values(a.examples)[0];
                      if (void 0 === n) {
                        return [re.x4];
                      }
                      if (!(Object.keys(a.examples).length > 1)) {
                        return [{ ...re.x4, body: n.value }];
                      }
                      {
                        let e = Object.values(a.examples),
                          t = [];
                        for (let r of e) {
                          t.push({ ...re.x4, body: r.value });
                        }
                        return t;
                      }
                    })(t),
                  }
                : { prefillExamplesEnabled: !1, generatedRequestExampleData: [re.x4] };
            })(),
            w = (0, n.useCallback)(
              (e) => {
                (v[e]?.schema.type === "null" ? o(null) : o(void 0), b(e));
              },
              [v, o],
            ),
            N = (0, a.jsx)(et, { options: v, selectedIndex: y, onSelectOption: w });
          return void 0 === j
            ? null
            : (0, a.jsx)(i.A, {
                children: (0, a.jsx)(ru, {
                  name: e,
                  schema: j,
                  typeDropdown: N,
                  value: t,
                  setValue: o,
                  clearValue: l,
                  isBody: d,
                  depth: c,
                  parentNames: p,
                  arrayIndex: u,
                  defaultExpanded: m,
                  style: h,
                  explode: x,
                  renderedRefs: g,
                  prefillDisabled: k,
                }),
              });
        },
        rh = ({
          name: e,
          schema: t,
          typeDropdown: r,
          value: s,
          setValue: i,
          clearValue: o,
          depth: l,
          parentNames: c,
        }) => {
          let p = (0, d.n)(),
            [m, h] = (0, n.useState)(s?.map(t3()) ?? []),
            x = (function (e) {
              let t = t6(),
                { location: r } = (0, I.ad)();
              return (0, n.useMemo)(() => eC(e, t, r), [e, t, r]);
            })(t),
            g = (0, n.useMemo)(() => {
              let t =
                s?.map((e, t) =>
                  (0, a.jsx)(
                    rm,
                    {
                      schemaArray: x,
                      value: e,
                      setValue: (e) => {
                        let r = [...s];
                        ((r[t] = e), i(r));
                      },
                      clearValue: () => {
                        let e = [...s];
                        (e.splice(t, 1),
                          h((e) => {
                            let r = [...e];
                            return (r.splice(t, 1), r);
                          }),
                          i(e));
                      },
                      depth: l + 1,
                      arrayIndex: t,
                    },
                    m[t],
                  ),
                ) ?? [];
              return (
                t.push(
                  (0, a.jsx)(
                    rx,
                    {
                      label: p["api.addItem"],
                      className: (0, u.cn)(t.length > 0 && "mt-4"),
                      onClick: () => {
                        (h((e) => [...e, t3()()]), i([...(s ?? []), void 0]));
                      },
                      dataTestId: e + "-add-item-button",
                    },
                    "add-button",
                  ),
                ),
                t
              );
            }, [m, x, s, i, l, e, p]);
          return (0, a.jsx)(t9, {
            name: e,
            typeDropdown: r,
            schema: t,
            onClear: o,
            parentNames: c,
            isArray: !0,
            children: g,
          });
        };
      function rx({ className: e, onClick: t, label: r, dataTestId: n }) {
        return (0, a.jsx)("div", {
          className: e,
          children: (0, a.jsxs)("button", {
            "aria-label": r,
            className:
              "flex text-playground-input w-fit items-center gap-x-1.5 !py-1 !px-2 hover:bg-gray-50 dark:hover:bg-white/[0.03]",
            onClick: t,
            "data-testid": n,
            children: [
              (0, a.jsx)(p.A, {
                icon: "plus",
                iconType: "solid",
                className: "bg-gray-500 dark:bg-white/40 h-3 w-3",
              }),
              (0, a.jsx)("span", { className: "text-gray-600 dark:text-gray-200", children: r }),
            ],
          }),
        });
      }
      let rg = ({ onAddKey: e, existingKeys: t, dataTestId: r }) => {
          let [s, i] = (0, n.useState)(!1),
            [o, l] = (0, n.useState)(""),
            c = (0, d.n)(),
            p = t.includes(o),
            m = o.length > 0 && !p;
          return s
            ? (0, a.jsx)("input", {
                className: (0, u.cn)(
                  "py-6 flex-1 bg-transparent outline-0 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-300 dark:placeholder-white/30 font-mono font-medium",
                  p ? "underline decoration-wavy decoration-red-400" : "",
                ),
                placeholder: c["api.enterPropertyKey"],
                type: "text",
                autoFocus: !0,
                value: o,
                onBlur: () => {
                  (l(""), i(!1));
                },
                onChange: (e) => l(e.target.value),
                onKeyDown: (t) => {
                  ("Enter" === t.key || "Tab" === t.key) && m && e(t.currentTarget.value);
                },
                spellCheck: !1,
              })
            : (0, a.jsx)(rx, {
                className: "py-5",
                onClick: () => i((e) => !e),
                label: c["api.addNewProperty"],
                dataTestId: r,
              });
        },
        rf = ({
          schema: e,
          depth: t,
          parentNames: r,
          style: s,
          explode: i,
          inputKeyPrefix: o,
          name: l,
          arrayIndices: d,
        }) => {
          let c = (0, eU.jT)((e) => e.deleteInput),
            p = [];
          Object.entries(e.properties ?? {}).forEach(([e, n]) => {
            if ((0, b.Fy)(n)) {
              let c = l ? [...(r ?? []), l] : void 0;
              p.push(
                (0, a.jsx)(
                  rw,
                  {
                    name: e,
                    schema: n,
                    depth: (t ?? 0) + 1,
                    parentNames: c,
                    style: s,
                    explode: i,
                    arrayIndices: d,
                    inputKeyPrefix: o,
                  },
                  e,
                ),
              );
            }
          });
          let u = !1 !== e.additionalProperties,
            m = (0, tH.A)(),
            [h, x] = (0, n.useState)([]),
            g = [];
          h.forEach((n) => {
            let p = l ? [...(r ?? []), l] : r;
            if ((0, b.Fy)(e.additionalProperties)) {
              let r = e.uniqueKey ?? "",
                l = r ? `${r}.${(0, b.EG)(n)}` : (0, b.EG)(n),
                u = e.additionalProperties,
                m = "uniqueKey" in u && "string" == typeof u.uniqueKey ? u.uniqueKey : "",
                h = t5(u, m, l),
                f = (0, y.ZZ)(o, h, d);
              g.push(
                (0, a.jsx)(
                  rw,
                  {
                    name: n,
                    schema: h,
                    depth: (t ?? 0) + 1,
                    parentNames: p,
                    style: s,
                    explode: i,
                    arrayIndices: d,
                    inputKeyPrefix: o,
                    clearValue: () => {
                      (c(f), x((e) => e.filter((e) => e !== n)));
                    },
                  },
                  n,
                ),
              );
            } else {
              let r = e.uniqueKey ?? "",
                l = (0, b.gY)(),
                u = `${r}.${(0, b.EG)(n)}.oneOf`,
                m = {
                  oneOf: l.oneOf?.map((e, t) => ({ ...e, uniqueKey: `${u}.${t}` })),
                  uniqueKey: u,
                };
              (0, b.Fy)(m) &&
                g.push(
                  (0, a.jsx)(
                    rw,
                    {
                      name: n,
                      schema: m,
                      depth: (t ?? 0) + 1,
                      parentNames: p,
                      style: s,
                      explode: i,
                      arrayIndices: d,
                      inputKeyPrefix: o,
                      clearValue: () => {
                        (c((0, y.ZZ)(o, m, d)), x((e) => e.filter((e) => e !== n)));
                      },
                    },
                    n,
                  ),
                );
            }
          });
          let f = [...p, ...g];
          if (0 === t) {
            return (0, a.jsx)(a.Fragment, { children: f });
          }
          let v = [...Object.keys(e.properties ?? {}), ...h];
          return (0, a.jsxs)(a.Fragment, {
            children: [
              f,
              u
                ? (0, a.jsx)(
                    rg,
                    {
                      existingKeys: v,
                      onAddKey: (e) => {
                        x([...h, e]);
                      },
                      dataTestId: e.uniqueKey + ".additional-property-button",
                    },
                    "add-property-button" + m,
                  )
                : null,
            ],
          });
        },
        ry = ({
          name: e,
          schema: t,
          clearValue: r,
          parentNames: s,
          style: i,
          explode: o,
          inputKeyPrefix: l,
          arrayIndices: d,
          isArrayChild: c,
          isBody: p,
        }) => {
          let u = "oneOf" in t && t.oneOf ? t.oneOf.filter(b.Fy) : [],
            m = u.map((e) => ({ label: (0, b.fo)(e), schema: e })),
            h = (0, eU.jT)((e) => e.setInput),
            x = (0, eU.jT)((e) => e.deleteInput),
            g = (0, y.ZZ)(l, t, d),
            f = `${g}.oneOf.`,
            v = (0, eU.jT)(
              (0, tU.k)((e) => {
                let t = {};
                return (
                  Object.keys(e.inputs).forEach((r) => {
                    r.startsWith(f) && (t[r] = e.inputs[r]);
                  }),
                  t
                );
              }),
            ),
            j = (0, n.useMemo)(() => {
              let e = Object.keys(v).find((e) => e.startsWith(f));
              if (e) {
                let t = e.slice(f.length).match(/^(\d+)(?:\.|$)/);
                if (t && t[1]) {
                  let e = parseInt(t[1], 10);
                  if (e >= 0 && e < u.length) {
                    return e;
                  }
                }
              }
              return 0;
            }, [v, f, u.length]),
            [k, w] = (0, n.useState)(j);
          (0, n.useEffect)(() => {
            w(j);
          }, [j]);
          let N = u[k],
            C = (0, eU.jT)((e) => e.setInputs),
            S = (e) => {
              x(g);
              let t = u[e];
              if (t && "type" in t && "null" === t.type) {
                h(g, null);
              } else if ((h(g, void 0), p && t)) {
                let e = (0, b.cY)(t);
                Object.keys(e).length > 0 && C(e);
              }
              w(e);
            };
          if (!N) {
            return null;
          }
          let O = u.every((e) => "object" === e.type || (0, b.Rr)(e));
          if (!c && O && p) {
            let t = (0, b.FJ)(u);
            return (0, a.jsx)(E.t, {
              defaultTabIndex: k,
              onClickTab: S,
              className: "!border-gray-100 !mb-4 dark:!border-white/10",
              children: t.map((t) =>
                (0, a.jsx)(
                  E.o,
                  {
                    title: t,
                    children: (0, a.jsx)(rw, {
                      skipContainer: !0,
                      arrayIndices: d,
                      name: e,
                      schema: N,
                      clearValue: r,
                      parentNames: s,
                      style: i,
                      explode: o,
                      inputKeyPrefix: l,
                    }),
                  },
                  t,
                ),
              ),
            });
          }
          let $ = (0, a.jsx)(tL, { options: m, selectedIndex: k, onSelectOption: S });
          return (0, a.jsx)(rw, {
            name: e,
            schema: N,
            typeDropdown: $,
            clearValue: r,
            parentNames: s,
            style: i,
            explode: o,
            inputKeyPrefix: l,
            arrayIndices: d,
          });
        },
        rb = ({ name: e, schema: t, inputKeyPrefix: r, enumType: n, arrayIndices: s }) => {
          let i = (0, d.n)(),
            o = (0, b.vt)(t),
            l = t.enum?.filter((e) => "number" == typeof e || "string" == typeof e) ?? [],
            c = "boolean" === t.type ? [!0, !1] : l,
            p = (0, y.ZZ)(r, t, s),
            { value: m, setInput: h } = (0, eU.Bh)(p),
            x = (0, eU.jT)((e) => e.deleteInput),
            g = ((e, t) => {
              switch (e) {
                case "integer":
                  return (0, t1.Fq)(t) ? t : void 0;
                case "number":
                  return (0, t1.Et)(t) ? t : void 0;
                case "string":
                  return (0, t1.Kg)(t) ? t : void 0;
                case "boolean":
                  return (0, t1.Lm)(t) ? t : void 0;
                default:
                  return;
              }
            })(n, m);
          return (0, a.jsxs)("div", {
            className: "flex items-center gap-1",
            children: [
              (0, a.jsxs)("div", {
                className: "relative flex-1",
                children: [
                  (0, a.jsxs)("select", {
                    className: (0, u.cn)(
                      "relative text-playground-input w-full text-left flex-1 outline-0 cursor-pointer bg-transparent pr-6",
                      void 0 !== g
                        ? "!text-gray-900 dark:!text-gray-100"
                        : "!text-gray-400 dark:!text-white/30",
                    ),
                    value: g?.toString() ?? "",
                    "aria-label":
                      o ?? i["aria.selectOption"].replace("{name}", e || i["api.option"]),
                    onChange: (e) => {
                      "boolean" === n
                        ? h(p, "true" === e.target.value)
                        : "integer" === n
                          ? h(p, parseInt(e.target.value, 10))
                          : "number" === n
                            ? h(p, parseFloat(e.target.value))
                            : h(p, e.target.value);
                    },
                    children: [
                      (0, a.jsx)("option", {
                        value: "",
                        disabled: !0,
                        children:
                          o ?? i["api.selectOption"].replace("{name}", e || i["api.option"]),
                      }),
                      c.map((e) =>
                        (0, a.jsx)(
                          "option",
                          { value: e.toString(), children: e.toString() },
                          e.toString(),
                        ),
                      ),
                    ],
                  }),
                  (0, a.jsx)(Y.A, {
                    className:
                      "absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-white/30 pointer-events-none",
                  }),
                ],
              }),
              void 0 !== g &&
                (0, a.jsx)("button", {
                  type: "button",
                  className:
                    "p-0.5 text-gray-400 dark:text-gray-600 hover:text-gray-600 dark:hover:text-gray-400",
                  onClick: () => {
                    x(p);
                  },
                  "aria-label": i["aria.deleteItem"],
                  children: (0, a.jsx)(tZ.uc, { className: "h-4 w-4" }),
                }),
            ],
          });
        },
        rv = ({ name: e, schema: t, inputKeyPrefix: r, arrayIndices: n }) => {
          let s = (0, d.n)(),
            i = (0, b.vt)(t),
            { prefix: o, placeholder: l } = rj(t.format, s["api.enterBearerToken"]),
            c = (0, y.ZZ)(r, t, n),
            { value: p, setInput: u } = (0, eU.Bh)(c),
            m = (0, t1.Kg)(p) ? p : void 0,
            h = o && m?.startsWith(o) ? m.substring(o.length) : m;
          return (0, a.jsxs)("div", {
            className: "relative flex flex-1 items-center",
            children: [
              (0, a.jsx)("div", {
                className:
                  "absolute left-2.5 top-0 bottom-0 flex items-center justify-center text-sm text-gray-800 dark:text-gray-100",
                children: o,
              }),
              (0, a.jsx)("input", {
                id: tg.V.APIPlaygroundInput,
                className: "flex-1 min-w-0 bg-transparent outline-0 text-playground-input",
                style: { paddingLeft: o ? 0.52 * o.length + "rem" : void 0 },
                placeholder: i ?? l ?? s["api.enterValue"].replace("{name}", e ?? s["api.value"]),
                "aria-label": i ?? l ?? s["aria.enterValue"].replace("{name}", e ?? s["api.value"]),
                type: "text",
                value: h ?? "",
                onChange: (e) => {
                  ((e) => {
                    let t = `${o ?? ""}${e}`;
                    t ? u(c, t) : u(c, void 0);
                  })(e.target.value);
                },
                spellCheck: !1,
              }),
            ],
          });
        },
        rj = (e, t) => (e?.toLowerCase() === "bearer" ? { prefix: "Bearer ", placeholder: t } : {}),
        rk = ({ name: e, schema: t, inputKeyPrefix: r, arrayIndices: n }) => {
          let s = (0, d.n)(),
            i = (0, y.ZZ)(r, t, n),
            { value: o, setInput: l } = (0, eU.Bh)(i),
            c = (0, t1.Kg)(o) ? o : void 0,
            p = (0, b.vt)(t);
          return (0, a.jsx)("textarea", {
            className:
              "-mx-3.5 px-3.5 flex-1 min-h-[2.5rem] min-w-0 bg-transparent outline-0 text-playground-input resize-y",
            rows: 2,
            placeholder: p ?? s["api.enterValueCapitalized"].replace("{name}", e ?? s["api.value"]),
            "aria-label": p ?? s["aria.enterValue"].replace("{name}", e ?? s["api.value"]),
            value: c,
            onChange: (e) => {
              l(i, e.target.value);
            },
            spellCheck: !1,
            autoCapitalize: "off",
            autoComplete: "off",
            autoCorrect: "off",
          });
        },
        rw = ({ ...e }) => {
          switch ((0, b.HA)(e.schema)) {
            case "oneOf":
              return (0, a.jsx)(ry, { ...e });
            case "string": {
              let t = (e.isBody && 0 === e.depth) || e.skipContainer ? rk : rv;
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(t, { ...e }) });
            }
            case "object":
              if ((e.isBody && 0 === e.depth) || e.skipContainer) {
                return (0, a.jsx)(rf, { ...e });
              }
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(rf, { ...e }) });
            case "number":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(t2, { ...e, numberType: "number" }),
              });
            case "integer":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(t2, { ...e, numberType: "integer" }),
              });
            case "array":
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(tK, { ...e }) });
            case "boolean":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(rb, { ...e, enumType: "boolean" }),
              });
            case "enum<string>":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(rb, { ...e, enumType: "string" }),
              });
            case "enum<number>":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(rb, { ...e, enumType: "number" }),
              });
            case "enum<integer>":
              return (0, a.jsx)(tY, {
                ...e,
                children: (0, a.jsx)(rb, { ...e, enumType: "integer" }),
              });
            case "file":
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(tW, { ...e }) });
            case "null":
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(t0, {}) });
            default:
              return (0, a.jsx)(tY, { ...e, children: (0, a.jsx)(rv, { ...e }) });
          }
        },
        rN = ({
          apiReferenceData: e,
          selectedContentTypeIndex: t,
          setSelectedContentTypeIndex: r,
        }) => {
          let n = (0, d.n)(),
            { dependencies: s } = e,
            { requestBody: i } = s ?? {};
          if (!i) {
            return null;
          }
          let o = Object.entries(i.content)
              .map(([e, t]) =>
                (0, b.Fy)(t.schema) ? { contentType: e, schema: t.schema, label: e } : null,
              )
              .filter((e) => null !== e),
            l = o[t];
          if (!l) {
            return null;
          }
          let { schema: c } = l,
            p = `${f.gw.body}`;
          return (0, a.jsx)(tD, {
            name: n["api.body"],
            rightElement: (0, a.jsx)(
              () =>
                (0, a.jsx)("div", {
                  onClick: (e) => e.stopPropagation(),
                  className: (0, u.cn)("text-xs font-mono", o.length <= 1 && "hidden"),
                  children: (0, a.jsx)(tL, {
                    options: o,
                    selectedIndex: t,
                    onSelectOption: (e) => {
                      r(e);
                    },
                  }),
                }),
              {},
            ),
            children: (0, a.jsx)(rw, { schema: c, isBody: !0, depth: 0, inputKeyPrefix: p }),
          });
        },
        rC = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            { dependencies: r } = e,
            { parameters: n } = r ?? {};
          if (!n || 0 === Object.keys(n).length) {
            return null;
          }
          let { header: s, path: i, query: o, cookie: l } = (0, b.v9)(e),
            c = (e) => {
              if (void 0 === e) {
                return null;
              }
              if ((0, b.Fy)(e.schema)) {
                let t = `${(0, b.eV)(e.in)}.${(0, b.EG)(e.name)}`;
                return (0, a.jsx)(
                  rw,
                  {
                    name: e.name,
                    schema: { ...e.schema, description: e.description },
                    style: e.style,
                    explode: e.explode,
                    inputKeyPrefix: t,
                  },
                  e.name,
                );
              }
            },
            p = s.map(c).filter((e) => null !== e),
            u = l.map(c).filter((e) => null !== e),
            m = i.map(c).filter((e) => null !== e),
            h = o.map(c).filter((e) => null !== e);
          return (0, a.jsxs)(a.Fragment, {
            children: [
              p.length > 0 && (0, a.jsx)(tD, { name: t["api.header"], children: p }),
              u.length > 0 && (0, a.jsx)(tD, { name: t["api.cookies"], children: u }),
              m.length > 0 && (0, a.jsx)(tD, { name: t["api.path"], children: m }),
              h.length > 0 && (0, a.jsx)(tD, { name: t["api.query"], children: h }),
            ],
          });
        },
        rS = ({ apiReferenceData: e }) => {
          let t = (0, d.n)(),
            { selectedSecurityOptionIndex: r, setSelectedSecurityOptionIndex: s } = (0, eA.a)(),
            i = e.dependencies?.processedSecurityOptions;
          if (!i || 0 === i.length) {
            return null;
          }
          let o = i[r];
          if (!o) {
            return null;
          }
          let l = i.map((e) => ({
            label: e.title,
            schema: e.schemes[0]?.schema ?? { type: "string" },
          }));
          return (0, a.jsx)(tD, {
            name: t["api.authorization"],
            rightElement: (0, a.jsx)(
              () =>
                (0, a.jsx)("div", {
                  onClick: (e) => e.stopPropagation(),
                  className: (0, u.cn)("text-xs font-mono", i.length <= 1 && "hidden"),
                  children: (0, a.jsx)(tL, {
                    options: l,
                    selectedIndex: r,
                    onSelectOption: (e) => {
                      s(e);
                    },
                  }),
                }),
              {},
            ),
            children: o.schemes.map(({ scheme: e, schema: t, name: r }, s) => {
              let i = (0, b.PY)({ scheme: e, name: r });
              return (0, a.jsxs)(
                n.Fragment,
                {
                  children: [
                    t.description &&
                      "object" === t.type &&
                      (0, a.jsx)(j, {
                        markdown: t.description,
                        className: "text-gray-500 dark:text-gray-400 py-2",
                      }),
                    (0, a.jsx)(
                      rw,
                      { name: r, schema: t, inputKeyPrefix: i, skipContainer: "object" === t.type },
                      `${e.type}-${r}`,
                    ),
                  ],
                },
                `${e.type}-${r}-${s}`,
              );
            }),
          });
        },
        rO = ({ apiReferenceData: e, selectedBaseUrlIndex: t }) => {
          let { dependencies: r } = e,
            { servers: n } = r ?? {};
          if (!n || 0 === Object.keys(n).length) {
            return null;
          }
          let s = Object.values(n),
            i = s[t]?.variables;
          return i && 0 !== Object.keys(i).length
            ? (0, a.jsx)(tD, {
                name: "Server",
                children: Object.entries(i).map(([e, t]) => {
                  let r = { ...t, type: "string" },
                    n = `${f.gw.server}.${(0, b.EG)(e)}`;
                  return (0, a.jsx)(rw, { name: e, schema: r, inputKeyPrefix: n }, e);
                }),
              })
            : null;
        };
      var r$ = r(98167),
        rT = r(22153),
        rE = r(60996).Buffer;
      let rA = async ({ method: e, path: t, inputs: a, headers: n }) => {
          let s = n["API-SECRET"],
            { getCoboV1CustodyGeneratedKeys: i } = await Promise.all([r.e(77717), r.e(84447)]).then(
              r.bind(r, 82377),
            ),
            o = { ...n, ...i(e, t, s, a.body || a.query) };
          return (delete o["API-SECRET"], o);
        },
        rP = async (e, t, a, n, s) => {
          let { getCoboV2CustodyGeneratedKeys: i } = await r.e(40725).then(r.bind(r, 40725)),
            o = s["BIZ-API-KEY"];
          return "string" == typeof o ? await i(o, e, t, a, n) : {};
        },
        rI = async (e) => {
          let t = await r
              .e(29220)
              .then(r.bind(r, 29220))
              .then((e) => e.default),
            a = Object.keys(e.header).find((e) => "content-type" === e.toLowerCase()),
            n = e.body,
            s = e.header;
          if (a?.includes("multipart/form-data")) {
            let { data: t, headers: r } = rq(e);
            ((n = t), (s = r));
          }
          return t({
            url: e.url,
            method: e.method,
            params: e.query,
            data: n,
            headers: s,
            paramsSerializer: { indexes: null },
            responseType: "arraybuffer",
            validateStatus: () => !0,
            transformResponse: (e) => rE.from(e).toString("base64"),
          });
        },
        r_ = async (e) => {
          let t = await r
              .e(29220)
              .then(r.bind(r, 29220))
              .then((e) => e.default),
            a = new FormData();
          (a.append(
            "requestInfo",
            JSON.stringify({
              method: e.method,
              url: e.url,
              header: e.header,
              query: e.query,
              cookie: e.cookie,
            }),
          ),
            "object" == typeof e.body &&
              null !== e.body &&
              Object.entries(e.body).forEach(([e, t]) => {
                t instanceof File
                  ? a.append(e, t)
                  : Array.isArray(t)
                    ? t.forEach((t) => {
                        t instanceof File
                          ? a.append(e, t)
                          : null != t &&
                            a.append(e, "object" == typeof t ? JSON.stringify(t) : t.toString());
                      })
                    : null != t &&
                      a.append(e, "object" == typeof t ? JSON.stringify(t) : t.toString());
              }));
          let { data: n } = await t.post(`${r$.c.BASE_PATH}/_mintlify/api/file-request`, a);
          return n;
        },
        rq = (e) => {
          let t = e.body,
            r = e.header;
          if (r["content-type"]?.includes("multipart/form-data")) {
            let e = new FormData();
            "object" == typeof t &&
              null !== t &&
              (Object.entries(t).forEach(([t, r]) => {
                r instanceof File
                  ? e.append(t, r)
                  : Array.isArray(r)
                    ? r.forEach((r) => {
                        r instanceof File
                          ? e.append(t, r)
                          : null != r &&
                            e.append(t, "object" == typeof r ? JSON.stringify(r) : r.toString());
                      })
                    : null != r &&
                      e.append(t, "object" == typeof r ? JSON.stringify(r) : r.toString());
              }),
              (t = e),
              delete r["content-type"]);
          }
          return { data: t, headers: r };
        },
        rF = ({
          apiReferenceData: e,
          baseUrl: t,
          selectedRequestBodyContentTypeIndex: s,
          setResult: i,
          label: o,
          method: l,
          className: d,
        }) => {
          let [c, p] = (0, n.useState)(!1),
            u = (({
              apiReferenceData: e,
              baseUrl: t,
              contentType: a = "application/json",
              setResult: s,
              setIsSending: i,
            }) => {
              let o = (0, rT.p)("docs.api_playground.request"),
                l = (0, eU.jT)((e) => e.getApiPlaygroundInputs),
                d = e.operation?.isCobo,
                c = e.operation?.disableProxy,
                p = e.operation?.path,
                u = e.operation?.method;
              return (0, n.useCallback)(async () => {
                let e,
                  n,
                  m,
                  h,
                  x = l();
                if ((i(!0), !p || !t || !u || !a || !t)) {
                  (i(!1),
                    s({
                      error: !0,
                      errorMessage: "Missing required fields to send a playground request",
                    }),
                    console.error(`Missing some required field to send a playground request:

path=${p}
method=${u}
contentType=${a}
baseUrl=${t}`));
                  return;
                }
                let g = await r
                    .e(29220)
                    .then(r.bind(r, 29220))
                    .then((e) => e.default),
                  f =
                    ((n = p),
                    Object.entries(x.path).reduce(
                      (e, [t, r]) =>
                        void 0 == r ? e : e.replace(`{${t}}`, encodeURIComponent(r.toString())),
                      n,
                    )),
                  y =
                    ((m = ((e, t) => {
                      let r = e;
                      return (
                        Object.entries(t).forEach(([e, t]) => {
                          t && (r = r.replace(`{${e}}`, t));
                        }),
                        r
                      );
                    })(t, x.server)),
                    (h = f),
                    m.replace(/\/$/, "") + "/" + h.replace(/^\//, "")),
                  v = ((e, t) =>
                    Object.keys(e).some((e) => "content-type" === e.toLowerCase())
                      ? e
                      : { ...e, "content-type": t })(x.header, a);
                ((v = ((e) => {
                  if (!e.Authorization || "object" != typeof e.Authorization) {
                    return e;
                  }
                  if ("object" == typeof e.Authorization) {
                    let t = "username" in e.Authorization ? e.Authorization.username : "",
                      r = "password" in e.Authorization ? e.Authorization.password : "",
                      a = (0, b.lq)(t, r);
                    ((e.Authorization = `Basic ${a}`),
                      delete e.Authorization.username,
                      delete e.Authorization.password);
                  }
                  return e;
                })(v)),
                  d &&
                    (v = f.startsWith("/v1")
                      ? await rA({ method: u, path: p, inputs: x, headers: v })
                      : await rP(u, f, x.body, x.query, v)));
                let j = {
                    method: u,
                    url: y,
                    header: v,
                    body: x.body,
                    cookie: x.cookie,
                    query: x.query,
                  },
                  k = !1;
                try {
                  if (c) {
                    let t = await rI(j);
                    ((e = t.status),
                      s({
                        error: !1,
                        response: {
                          status: t.status,
                          statusText: t.statusText,
                          headers: t.headers,
                          data: t.data,
                        },
                      }));
                  } else if (a && a.includes("multipart/form-data")) {
                    let t = await r_(j);
                    ("response" in t && (e = t.response.status), s(t));
                  } else {
                    let { data: t } = await g.post(`${r$.c.BASE_PATH}/_mintlify/api/request`, j);
                    ("response" in t && (e = t.response.status), s(t));
                  }
                } catch (e) {
                  ((k = !0),
                    s({ error: !0, errorMessage: "unable to complete request" }),
                    console.error(e));
                }
                (i(!1), o({ path: p, method: u, responseStatus: e, isError: k }));
              }, [u, p, i, l, t, a, d, o, c, s]);
            })({
              apiReferenceData: e,
              baseUrl: t,
              contentType: (0, b.pI)(e, s),
              setResult: i,
              setIsSending: p,
            });
          return (0, a.jsx)(m, { label: o, method: l, isSending: c, onClick: u, className: d });
        };
      function rR({
        apiReferenceData: e,
        selectedBaseUrlIndex: t,
        selectedSecurityOptionIndex: r,
        selectedExampleIndex: a,
        selectedContentTypeIndex: n,
        locallyStoredCredentials: s,
        serverInputs: i,
      }) {
        let o = e.operation?.userInfoPlaygroundInputs;
        return rL({
          apiReferenceData: e,
          selectedBaseUrlIndex: t,
          selectedSecurityOptionIndex: r,
          selectedExampleIndex: a,
          selectedContentTypeIndex: n,
          mergedUserInfo: {
            server: { ...o?.server, ...i },
            header: { ...o?.header, ...s?.header },
            query: { ...o?.query, ...s?.query },
            cookie: { ...o?.cookie, ...s?.cookie },
          },
        });
      }
      let rL = ({
        apiReferenceData: e,
        selectedBaseUrlIndex: t,
        selectedSecurityOptionIndex: r,
        selectedExampleIndex: a = 0,
        selectedContentTypeIndex: n = 0,
        mergedUserInfo: s,
      }) => {
        let i = {},
          o = e.operation?.prefillPlaygroundWithExample,
          l = (e.operation?.prefillPlaygroundExamples ?? [])[a],
          d = Object.values(e.dependencies?.servers ?? {}),
          c = d[t]?.variables,
          p = e.dependencies?.processedSecurityOptions,
          u = p?.[r],
          m = e.dependencies?.parameters,
          h = e.dependencies?.requestBody;
        if (o && l) {
          i = { ...rD(c), ...rM(u), ...rB({ apiReferenceData: e, parameters: m }), ...l };
        } else if (h?.exampleType === "examples") {
          i = { ...rD(c), ...rM(u), ...rB({ apiReferenceData: e, parameters: m }) };
        } else {
          let t = e.operation?.requiredOnlyExamples;
          i = {
            ...rD(c),
            ...rM(u),
            ...rB({ apiReferenceData: e, parameters: m }),
            ...(t
              ? {}
              : (function ({ requestBody: e, apiReferenceData: t, selectedContentTypeIndex: r }) {
                  let a = {};
                  if (!e) {
                    return a;
                  }
                  let n = (0, b.pI)(t, r);
                  if (n) {
                    let t = e.content[n]?.schema,
                      r = (0, b.b9)(t);
                    if (r) {
                      a[`${f.gw.body}`] = r;
                    } else if ((0, b.Fy)(t)) {
                      let e = (0, b.cY)(t);
                      return { ...a, ...e };
                    }
                  }
                  return a;
                })({ requestBody: h, apiReferenceData: e, selectedContentTypeIndex: n })),
          };
        }
        return (
          s &&
            (i = {
              ...i,
              ...(function ({ mergedUserInfo: e, securityOption: t, serverVariables: r }) {
                let a = {};
                if (t) {
                  let r = {};
                  (t.schemes.forEach(({ scheme: e, name: t }) => {
                    r[t] = e;
                  }),
                    Object.entries(e.header ?? {}).forEach(([e, t]) => {
                      let n = r[e];
                      n &&
                        ((0, b.Zt)(n)
                          ? ("object" == typeof t &&
                              null !== t &&
                              "username" in t &&
                              "string" == typeof t.username &&
                              (a[`${f.gw.header}.Authorization.username`] = t.username),
                            "object" == typeof t &&
                              null !== t &&
                              "password" in t &&
                              "string" == typeof t.password &&
                              (a[`${f.gw.header}.Authorization.password`] = t.password))
                          : "string" == typeof t && (a[`${f.gw.header}.${(0, b.EG)(e)}`] = t));
                    }),
                    Object.entries(e.query ?? {}).forEach(([e, t]) => {
                      r[e] && (a[`${f.gw.query}.${(0, b.EG)(e)}`] = t);
                    }),
                    Object.entries(e.cookie ?? {}).forEach(([e, t]) => {
                      r[e] && (a[`${f.gw.cookie}.${(0, b.EG)(e)}`] = t);
                    }));
                }
                return (
                  r &&
                    Object.keys(r).length > 0 &&
                    e.server &&
                    Object.entries(e.server).forEach(([e, t]) => {
                      r[e] && (a[`${f.gw.server}.${(0, b.EG)(e)}`] = t);
                    }),
                  a
                );
              })({ mergedUserInfo: s, securityOption: u, serverVariables: c }),
            }),
          i
        );
      };
      function rD(e) {
        let t = {};
        return (
          e &&
            Object.entries(e).forEach(([e, r]) => {
              let a = `${f.gw.server}.${(0, b.EG)(e)}`;
              if ("object" == typeof r && null !== r) {
                let e = (0, b.b9)(r);
                e && (t[a] = e);
              }
            }),
          t
        );
      }
      function rM(e) {
        let t = {};
        return (
          e &&
            e.schemes.forEach(({ scheme: e, schema: r, name: a }) => {
              let n = (0, b.PY)({ scheme: e, name: a }),
                s = (0, b.b9)(r);
              (s && "string" == typeof s && (t[n] = s),
                s &&
                  "object" == typeof s &&
                  ((t[n + ".username"] =
                    "username" in s && "string" == typeof s.username ? s.username : ""),
                  (t[n + ".password"] =
                    "password" in s && "string" == typeof s.password ? s.password : "")));
            }),
          t
        );
      }
      function rB({ apiReferenceData: e, parameters: t }) {
        let r = {};
        if (!t) {
          return r;
        }
        let { header: a, path: n, query: s, cookie: i } = (0, b.v9)(e);
        return (
          [...a, ...n, ...s, ...i].forEach((e) => {
            if (e.schema) {
              let t = `${(0, b.eV)(e.in)}.${(0, b.EG)(e.name)}`,
                a = (0, b.b9)(e.schema);
              a && (r[t] = a);
            }
          }),
          r
        );
      }
      let rH = ({
          isPlaygroundExpanded: e,
          setIsPlaygroundExpanded: t,
          baseUrl: r,
          baseUrlOptions: s,
          apiReferenceData: i,
        }) => {
          let { selectedBaseUrlIndex: l, setSelectedBaseUrlIndex: c } = (0, o.b)(),
            { selectedRequestBodyContentTypeIndex: p, setSelectedRequestBodyContentTypeIndex: m } =
              (0, V.d)(),
            [h, x] = (0, n.useState)(),
            f = (0, d.n)(),
            { selectedExampleIndex: y } = (0, eV.b)(),
            [b, v] = (0, n.useState)(void 0),
            [j, k] = (0, n.useState)(void 0);
          if (
            ((0, n.useEffect)(() => {
              (k((0, tR.tn)()),
                (async () => {
                  v(await (0, tF.pC)());
                })());
            }, []),
            (0, n.useEffect)(() => {
              let t = () => {
                e && eU.jT.getState().updateLocalStorage();
              };
              return (
                e || eU.jT.getState().updateLocalStorage(),
                window.addEventListener("beforeunload", t),
                () => {
                  window.removeEventListener("beforeunload", t);
                }
              );
            }, [e]),
            !(function ({
              apiReferenceData: e,
              selectedBaseUrlIndex: t,
              selectedExampleIndex: r,
              selectedRequestBodyContentTypeIndex: a,
              locallyStoredCredentials: s,
              serverInputs: i,
            }) {
              let o = (0, n.useRef)(!1),
                l = (0, n.useRef)(!1),
                d = (0, n.useRef)(r);
              ((0, n.useEffect)(() => {
                if (o.current) {
                  return;
                }
                let r = eU.jT.getState();
                r.reset();
                let n = rR({
                  apiReferenceData: e,
                  selectedBaseUrlIndex: t,
                  selectedSecurityOptionIndex: 0,
                  selectedExampleIndex: 0,
                  selectedContentTypeIndex: a,
                  locallyStoredCredentials: s,
                  serverInputs: i,
                });
                (r.initializeInputs(n),
                  r.initializeApiReferenceData(e),
                  (o.current = !0),
                  (l.current = !!s),
                  (d.current = 0));
              }, []),
                (0, n.useEffect)(() => {
                  if (!o.current || l.current || !s) {
                    return;
                  }
                  let r = eU.jT.getState(),
                    n = rR({
                      apiReferenceData: e,
                      selectedBaseUrlIndex: t,
                      selectedSecurityOptionIndex: r.selectedSecurityOptionIndex,
                      selectedExampleIndex: r.selectedExampleIndex,
                      selectedContentTypeIndex: a,
                      locallyStoredCredentials: s,
                      serverInputs: i,
                    });
                  (r.replaceInputs(n), (l.current = !0));
                }, [s]),
                (0, n.useEffect)(() => {
                  if (!o.current || d.current === r || !e.operation?.prefillPlaygroundWithExample) {
                    return;
                  }
                  let n = eU.jT.getState();
                  (n.updateLocalStorage(), n.clear());
                  let l = rR({
                    apiReferenceData: e,
                    selectedBaseUrlIndex: t,
                    selectedSecurityOptionIndex: n.selectedSecurityOptionIndex,
                    selectedExampleIndex: r,
                    selectedContentTypeIndex: a,
                    locallyStoredCredentials: s,
                    serverInputs: i,
                  });
                  (n.initializeInputs(l), (d.current = r));
                }, [r, e.operation?.prefillPlaygroundWithExample]));
            })({
              apiReferenceData: i,
              selectedBaseUrlIndex: l,
              selectedExampleIndex: y,
              selectedRequestBodyContentTypeIndex: p,
              locallyStoredCredentials: b,
              serverInputs: j?.[r] ?? {},
            }),
            (0, tq.f)({ key: "Escape", callback: e ? () => t(!1) : void 0, isSingleKey: !0 }),
            !i.operation)
          ) {
            return null;
          }
          let { path: w, method: N, title: C, description: S, type: O } = i.operation;
          return (0, a.jsxs)(t_, {
            isPlaygroundExpanded: e,
            setIsPlaygroundExpanded: t,
            children: [
              (0, a.jsx)("div", {
                className:
                  "sticky top-0 z-50 bg-background-light dark:bg-background-dark px-4 pt-4 pb-2",
                children: (0, a.jsxs)("div", {
                  className: "flex items-center justify-between gap-x-2",
                  children: [
                    (0, a.jsx)(tT, { operation: { method: N, title: C } }),
                    (0, a.jsx)(ez, {
                      baseUrl: r,
                      baseUrlOptions: s,
                      selectedBaseUrlIndex: l,
                      setSelectedBaseUrlIndex: c,
                      display: "interactive",
                      path: w,
                      method: N,
                      type: O,
                      onBaseUrlChange: () => {},
                      isInPlaygroundModal: !0,
                    }),
                    (0, a.jsx)(rF, {
                      apiReferenceData: i,
                      baseUrl: r,
                      selectedRequestBodyContentTypeIndex: p,
                      setResult: x,
                      label: f.send,
                      method: N,
                      className: "w-20",
                    }),
                  ],
                }),
              }),
              (0, a.jsxs)("div", {
                className: "grid grid-cols-1 lg:grid-cols-5 gap-x-8 gap-y-6 px-4 pb-4 pt-3",
                children: [
                  (0, a.jsxs)("div", {
                    className: "col-span-1 lg:col-span-3",
                    children: [
                      (0, a.jsx)(tE, { title: C, description: S }),
                      h && (0, a.jsx)(tl, { result: h, className: "mt-6 block lg:hidden" }),
                      (0, a.jsxs)("div", {
                        className: "space-y-2 mt-6",
                        children: [
                          (0, a.jsx)(rO, { apiReferenceData: i, selectedBaseUrlIndex: l }),
                          (0, a.jsx)(rS, { apiReferenceData: i }),
                          (0, a.jsx)(rC, { apiReferenceData: i }),
                          (0, a.jsx)(rN, {
                            apiReferenceData: i,
                            selectedContentTypeIndex: p,
                            setSelectedContentTypeIndex: m,
                          }),
                        ],
                      }),
                    ],
                  }),
                  (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      "col-span-1 lg:col-span-2 lg:space-y-6 lg:sticky lg:top-20 lg:self-start",
                      h && "lg:flex lg:flex-col",
                    ),
                    children: [
                      h && (0, a.jsx)(tl, { result: h, className: "hidden lg:block min-h-fit" }),
                      (0, a.jsx)(g._, {
                        isModal: !0,
                        "data-testid": "api-playground-request-example",
                        className: "xl:w-full",
                      }),
                    ],
                  }),
                ],
              }),
            ],
          });
        },
        rU = (0, n.createContext)({ isSending: !1, isPlaygroundExpanded: !1 }),
        rz = ({ apiReferenceData: e, operation: t, children: r }) => {
          let { path: l, method: p, baseUrlOptions: f, type: y } = t,
            { pageMetadata: b } = (0, n.useContext)(s.PageContext),
            { isCustom: v, isFrame: j } = (0, x.H)(b),
            k = (0, h.D)(),
            w = (0, d.n)(),
            [N, C] = (0, n.useState)(!1),
            S = "none" === k,
            O = "simple" === k,
            { selectedBaseUrlIndex: $, setSelectedBaseUrlIndex: T, baseUrl: E } = (0, o.b)();
          (0, n.useEffect)(() => {
            new URLSearchParams(window.location.search).has("playground") &&
              requestAnimationFrame(() => {
                C(!0);
              });
          }, []);
          let A = (e) => {
            if ((C(e), e)) {
              let e = new URL(window.location.href);
              (e.searchParams.set("playground", "open"), window.history.replaceState({}, "", e));
            } else {
              let e = new URL(window.location.href);
              (e.searchParams.delete("playground"), window.history.replaceState({}, "", e));
            }
          };
          return (0, a.jsxs)(rU.Provider, {
            value: { isPlaygroundExpanded: N, setIsPlaygroundExpanded: A },
            children: [
              (0, a.jsxs)("div", {
                className: "flex flex-col gap-8 isolate",
                id: "api-playground-2-operation-page",
                children: [
                  (0, a.jsx)(i.A, {
                    children: (0, a.jsxs)("div", {
                      className: (0, u.cn)(!S && "mt-6", "flex w-full flex-col space-y-4"),
                      children: [
                        S
                          ? null
                          : (0, a.jsx)(i.A, {
                              children: (0, a.jsx)("div", {
                                className: (0, u.cn)(
                                  "flex w-full flex-col bg-background-light dark:bg-background-dark border-standard rounded-2xl p-1.5",
                                  "simple" === k ? "p-1" : "p-1.5",
                                ),
                                children: (0, a.jsxs)("div", {
                                  className: "flex items-center space-x-1.5",
                                  children: [
                                    (0, a.jsx)(ez, {
                                      baseUrl: E,
                                      baseUrlOptions: f,
                                      selectedBaseUrlIndex: $,
                                      setSelectedBaseUrlIndex: T,
                                      display: k,
                                      path: l,
                                      method: p,
                                      type: y,
                                      onBaseUrlChange: () => {},
                                      isInPlaygroundModal: !1,
                                    }),
                                    O
                                      ? null
                                      : (0, a.jsx)(m, {
                                          label: w.tryIt,
                                          method: p,
                                          onClick: () => A(!0),
                                        }),
                                  ],
                                }),
                              }),
                            }),
                        (0, a.jsx)(i.A, {
                          children: (0, a.jsx)("div", {
                            className: "mt-8 lg:mt-0 flex flex-col gap-6 xl:hidden max-h-[30rem]",
                            children: (0, a.jsx)(g._, {}),
                          }),
                        }),
                      ],
                    }),
                  }),
                  (0, a.jsx)(i.A, {
                    children: (0, a.jsxs)("div", {
                      className: (0, u.cn)(
                        c.x.Content,
                        "relative",
                        !v && !j && "prose prose-gray dark:prose-invert",
                      ),
                      children: [r, (0, a.jsx)(eI, { pageMetadata: b })],
                    }),
                  }),
                ],
              }),
              !S &&
                !O &&
                (0, a.jsx)(i.A, {
                  children: (0, a.jsx)(rH, {
                    isPlaygroundExpanded: N,
                    setIsPlaygroundExpanded: A,
                    baseUrl: E,
                    baseUrlOptions: f,
                    apiReferenceData: e,
                  }),
                }),
            ],
          });
        },
        rV = ({ apiReferenceData: e, children: t }) => {
          let r = e.schemaData,
            { pageMetadata: o } = (0, n.useContext)(s.PageContext),
            { isCustom: l, isFrame: d } = (0, x.H)(o);
          return r
            ? (0, a.jsx)("div", {
                className: "flex flex-col gap-8 isolate",
                id: "api-playground-2-schema-page",
                children: (0, a.jsx)(i.A, {
                  children: (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      c.x.Content,
                      "relative",
                      !l && !d && "prose prose-gray dark:prose-invert",
                    ),
                    children: [
                      (0, a.jsx)(i.A, { children: t }),
                      (0, a.jsx)(i.A, {
                        children: (0, a.jsx)(H, {
                          schema: r,
                          fieldType: "schema",
                          displayFlattened: !0,
                        }),
                      }),
                    ],
                  }),
                }),
              })
            : null;
        },
        rK = ({ children: e }) => {
          let { apiReferenceData2: t } = (0, n.useContext)(s.ApiReferenceContext2);
          return t.operation
            ? (0, a.jsx)(i.A, {
                children: (0, a.jsx)(rz, {
                  apiReferenceData: t,
                  operation: t.operation,
                  children: e,
                }),
              })
            : t.schemaData
              ? (0, a.jsx)(i.A, { children: (0, a.jsx)(rV, { apiReferenceData: t, children: e }) })
              : null;
        },
        rW = (0, n.createContext)({
          result: [],
          setResult: () => {},
          address: "",
          setAddress: () => {},
          clearResult: () => {},
          onMessage: () => {},
          parameterValues: {},
          setParameterValues: () => {},
          handleParameterChange: () => {},
          handleSecuritySchemeChange: () => {},
          securitySchemeValues: {},
        }),
        rG = ({ children: e }) => {
          let [t, r] = (0, n.useState)([]),
            [s, i] = (0, n.useState)(""),
            [o, l] = (0, n.useState)({}),
            [d, c] = (0, n.useState)({});
          return (0, a.jsx)(rW.Provider, {
            value: {
              result: t,
              setResult: r,
              address: s,
              setAddress: i,
              clearResult: () => {
                r([]);
              },
              onMessage: (e) => {
                r((t) => [...t, e]);
              },
              parameterValues: o,
              setParameterValues: l,
              handleParameterChange: (e, t) => {
                l({ ...o, [e]: t });
              },
              handleSecuritySchemeChange: (e, t, r) => {
                c({ ...d, [e]: { name: r, value: t } });
              },
              securitySchemeValues: d,
            },
            children: e,
          });
        };
      var rJ = r(49897),
        rZ = r(57303);
      let rX = ({
          name: e,
          children: t,
          rightElement: r,
          className: s,
          defaultExpanded: i = !0,
        }) => {
          let [o, l] = (0, n.useState)(i),
            c = (0, d.n)();
          return (0, a.jsxs)("div", {
            className: (0, u.cn)(
              s,
              "rounded-2xl border border-zinc-200 dark:border-zinc-800 border-solid",
              o && "pb-1",
            ),
            children: [
              (0, a.jsxs)("button", {
                "aria-label": c["aria.expandInputSection"],
                "aria-expanded": o,
                onClick: () => l((e) => !e),
                className: (0, u.cn)(
                  "flex w-full pt-3.5 pb-3 px-3.5 items-center justify-between cursor-pointer rounded-t-2xl hover:bg-gray-50 dark:hover:bg-white/5",
                  o ? "rounded-t-2xl" : "rounded-2xl",
                ),
                children: [
                  (0, a.jsxs)("div", {
                    className: "flex items-center gap-x-1.5",
                    children: [
                      (0, a.jsx)(p.A, {
                        icon: "angle-right",
                        iconType: "solid",
                        className: (0, u.cn)(
                          "h-3 w-3 bg-gray-400 dark:bg-gray-500 transition-transform",
                          o && "rotate-90",
                        ),
                      }),
                      (0, a.jsx)("div", {
                        className: "flex-1 flex items-center space-x-2",
                        children: (0, a.jsx)("div", {
                          className:
                            "text-sm font-medium text-gray-800 dark:text-gray-200 leading-6",
                          children: e,
                        }),
                      }),
                    ],
                  }),
                  r,
                ],
              }),
              (0, a.jsxs)("div", {
                className: (0, u.cn)("flex-1 rounded-b-xl w-full", o && t ? "" : "hidden"),
                children: [
                  (0, a.jsx)("div", { className: "h-px mx-3.5 bg-[#f4f4f5] dark:bg-[#18181b]" }),
                  (0, a.jsx)("div", { className: "mx-3.5", children: t }),
                ],
              }),
            ],
          });
        },
        rY = ({
          children: e,
          label: t,
          typeLabel: r,
          required: s,
          deprecated: i,
          propertiesCount: o,
          defaultShowChildren: l,
          description: d,
          className: c,
          topLevel: p,
        }) => {
          let [m, h] = (0, n.useState)(0 === o || (l ?? o <= 2));
          return (0, a.jsx)("div", {
            className: (0, u.cn)(
              "expand-schema-container flex space-x-3 items-start",
              p ? "" : "px-3.5",
              c,
            ),
            children: (0, a.jsxs)("div", {
              className: (0, u.cn)(
                "flex flex-col flex-1 grid gap-x-12 gap-y-0 rounded-xl",
                m ? "mt-3.5" : "my-3.5",
                !d && "my-3.5",
              ),
              children: [
                (0, a.jsx)("div", {
                  className: (0, u.cn)(!m && "border-none"),
                  children: (0, a.jsxs)("div", {
                    className: "flex items-center justify-between font-mono font-bold",
                    children: [
                      (0, a.jsxs)("div", {
                        className: "flex flex-wrap items-center gap-2 text-xs truncate",
                        title: t,
                        children: [
                          (0, a.jsx)("div", {
                            className: "text-sm truncate",
                            children: (0, a.jsx)("span", {
                              className: "font-semibold text-gray-900 dark:text-gray-100",
                              children: t,
                            }),
                          }),
                          r && (0, a.jsx)(S.ks, { prefix: "type:", children: r }),
                          s && (0, a.jsx)(S.rG, {}),
                          i && (0, a.jsx)(S.n, {}),
                        ],
                      }),
                      (0, a.jsx)(tJ, { onClick: () => h(!m), count: o, labeled: !0 }),
                    ],
                  }),
                }),
                d &&
                  (0, a.jsx)("div", {
                    className: "py-2",
                    children: (0, a.jsx)(j, {
                      markdown: d,
                      className: "text-gray-500 dark:text-gray-400",
                    }),
                  }),
                m &&
                  (0, a.jsx)("div", {
                    className:
                      "grid grid-cols-1 w-full items-start divide-y divide-gray-100 dark:divide-white/5",
                    children: e,
                  }),
              ],
            }),
          });
        },
        rQ = ({ schema: e, defaultShowChildren: t, className: r, topLevel: n = !0 }) =>
          (0, a.jsx)(a.Fragment, {
            children: e.map(
              ({ name: e, type: s, description: i, properties: o, required: l, deprecated: d }) =>
                (0, a.jsx)(
                  rY,
                  {
                    label: e,
                    description: i,
                    typeLabel: s,
                    propertiesCount: o?.length ?? 0,
                    defaultShowChildren: t,
                    required: l,
                    deprecated: d,
                    className: r,
                    topLevel: n,
                    children:
                      ((e) =>
                        !!e && ("object" === e || "oneOf" === e || "anyOf" === e || "allOf" === e))(
                        s,
                      ) &&
                      o &&
                      (0, a.jsx)(rQ, { schema: o, defaultShowChildren: t, topLevel: !1 }),
                  },
                  e,
                ),
            ),
          }),
        r0 = ({ bindings: e }) =>
          (0, a.jsx)(rX, {
            name: "Bindings",
            className: "bindings-container",
            children: e.map((e) =>
              (0, a.jsx)(
                rQ,
                { schema: e.schemaProperties, className: "bindings-schema" },
                e.protocol,
              ),
            ),
          }),
        r1 = ({
          onCopy: e,
          baseUrlOptions: t,
          selectedBaseUrlIndex: r,
          setSelectedBaseUrlIndex: n,
          isCopiedActive: s,
          hasGrayBackground: i,
          display: o,
          path: l,
          method: d,
          onBaseUrlChange: c,
        }) =>
          (0, a.jsxs)("div", {
            className: (0, u.cn)(
              "relative flex-1 flex gap-2 min-w-0 rounded-xl items-center cursor-pointer p-1.5",
              "simple" != o && "border-standard",
              i && "bg-gray-50 dark:bg-white/5",
            ),
            onClick: e,
            children: [
              (0, a.jsx)(eB.l, { method: d, shortMethod: !0, active: !1 }),
              (0, a.jsxs)("div", {
                className: "flex items-center space-x-2 overflow-x-auto flex-1 no-scrollbar pr-8",
                children: [
                  (0, a.jsx)(eF, {
                    baseUrlOptions: t,
                    selectedBaseUrlIndex: r,
                    setSelectedBaseUrlIndex: n,
                    onBaseUrlChange: c,
                  }),
                  (0, a.jsx)(eR, { path: l, method: d, isCopiedActive: s, hasGrayBackground: i }),
                ],
              }),
            ],
          });
      var r2 = r(19518);
      let r5 = ({ operations: e, type: t }) => {
          let r = (0, d.n)(),
            n = "send" === t ? r.send : r["api.receive"],
            s = "send" === t ? (0, a.jsx)(tZ.t9, {}) : (0, a.jsx)(tZ.Cc, {}),
            i = e.flatMap((e) => e.messages);
          return (0, a.jsx)(rX, {
            name: n,
            rightElement: s,
            children: i.map((e) =>
              e.payload
                ? (0, a.jsx)(rQ, { schema: e.payload, defaultShowChildren: !1 }, e.id)
                : null,
            ),
          });
        },
        r4 = ({ parameters: e }) =>
          (0, a.jsx)(rX, {
            name: "Parameters",
            children: e.map((e) =>
              (0, a.jsx)(
                rQ,
                {
                  schema: [
                    {
                      name: e.id,
                      type: e.type,
                      description: e.description,
                      required: e.required,
                      deprecated: e.deprecated,
                    },
                  ],
                  className: "bindings-schema",
                },
                e.id,
              ),
            ),
          }),
        r3 = ({ address: e, baseUrl: t, parameterValues: r, securitySchemeValues: a }) => {
          let n = Object.entries(r).reduce(
              (e, [t, r]) => (null == r ? e : e.replace(`{${t}}`, encodeURIComponent(String(r)))),
              e,
            ),
            s = "",
            i = a.httpApiKey?.name,
            o = a.httpApiKey?.value;
          return (i && o && (s = `?${i}=${o}`), s && (n = `${n}${s}`), (0, rJ.s4)(t, n));
        },
        r6 = ({ connecting: e, isConnected: t, onClick: r }) => {
          let n = (0, d.n)(),
            s = t ? n["api.disconnect"] : n["api.connect"],
            i = e
              ? (0, a.jsx)(p.A, {
                  icon: "spinner-third",
                  iconType: "duotone",
                  className: "w-4 h-4 bg-white animate-spin",
                })
              : t
                ? (0, a.jsx)(tZ.W1, {})
                : (0, a.jsx)(tZ.oD, {});
          return (0, a.jsxs)("button", {
            className:
              "flex items-center justify-center px-3 h-9 text-white font-medium rounded-xl mouse-pointer disabled:opacity-70 hover:opacity-80 gap-1.5 bg-[#000000] dark:bg-[#52525c]",
            onClick: r,
            disabled: e,
            children: [(0, a.jsx)("span", { children: s }), i],
          });
        },
        r7 = ({ name: e, parameters: t, parameterValues: r, onChange: n }) =>
          t && 0 !== t.length
            ? (0, a.jsx)(rX, {
                name: e,
                children: t.map((e) => {
                  let t = { ...e.jsonSchema, deprecated: e.deprecated, required: e.required };
                  return (0, a.jsx)(
                    rm,
                    {
                      name: e.id,
                      schemaArray: [t],
                      value: r[e.id],
                      setValue: (t) => n(e.id, t),
                      clearValue: () => n(e.id, void 0),
                    },
                    e.id,
                  );
                }),
              })
            : null,
        r9 = ({
          name: e,
          securitySchemes: t,
          securitySchemeValues: r,
          handleSecuritySchemeChange: n,
        }) =>
          (0, a.jsx)(rX, {
            name: e,
            children: t.map((e) => {
              let t = {
                id: e.id,
                type: "string",
                title: e.name,
                description: e.description,
                required: !0,
              };
              return (0, a.jsx)(
                rm,
                {
                  name: e.name,
                  schemaArray: [t],
                  value: r[e.type]?.value || "",
                  setValue: (t) => n(e.type, t, e.name ?? ""),
                  clearValue: () => n(e.type, "", e.name ?? ""),
                },
                e.id,
              );
            }),
          }),
        r8 = ({ isConnected: e }) => {
          let t = (0, d.n)();
          return (0, a.jsxs)("div", {
            className: (0, u.cn)(
              "flex items-center justify-center px-2 h-6 text-white font-medium rounded-md mouse-pointer disabled:opacity-70 gap-1.5",
              e ? "bg-green-500 dark:bg-[#084608]" : "bg-red-100 dark:bg-[#460809]",
            ),
            children: [
              (0, a.jsx)(p.A, {
                icon: e ? "circle-check" : "circle-xmark",
                iconType: "solid",
                className: (0, u.cn)(
                  "w-3 h-3",
                  e ? "bg-white dark:bg-[#2cfb2c]" : "bg-red-600 dark:bg-[#fb2c36]",
                ),
              }),
              (0, a.jsx)("div", {
                className: (0, u.cn)(
                  "font-mono text-sm font-bold uppercase tracking-tighter",
                  e ? "text-white dark:text-[#2cfb2c]" : "text-red-600 dark:text-[#fb2c36]",
                ),
                children: e ? t["api.connected"] : t["api.notConnected"],
              }),
            ],
          });
        };
      var ae = r(150);
      let at = ({ ariaLabel: e, onClick: t }) =>
          (0, a.jsx)("button", {
            "aria-label": e,
            className:
              "flex items-center justify-center h-6 w-6 rounded-lg mouse-pointer hover:opacity-80 gap-1.5 border border-standard",
            onClick: t,
            children: (0, a.jsx)(p.A, {
              icon: "ban",
              iconType: "solid",
              className: "w-2.5 h-2.5 bg-gray-400 dark:bg-gray-500 rotate-90",
            }),
          }),
        ar = ({ name: e, className: t, messages: r, isConnected: n, clearResult: s }) => {
          if (!r) {
            return null;
          }
          let i = r.map((e, t) => {
            let r = e.timestamp ? `${e.timestamp}` : `message-${t}`,
              a = JSON.stringify(e.data, null, 2);
            return { id: r, type: e.type, title: a, content: a };
          });
          return (0, a.jsx)(ae.X, {
            name: e,
            messages: i,
            className: t,
            icon: (0, a.jsx)(tZ.bM, {}),
            rightElement: (0, a.jsxs)("div", {
              className: "flex items-center gap-x-2",
              children: [
                (0, a.jsx)(r8, { isConnected: n }),
                i.length > 0 && (0, a.jsx)(at, { ariaLabel: "Clear messages", onClick: s }),
              ],
            }),
          });
        },
        aa = ({ message: e, sendMessage: t, isConnected: r }) => {
          let s = (0, d.n)(),
            i = { ...e.jsonPayloadSchema, requiredProperties: e.jsonPayloadSchema?.required },
            [o, l] = (0, n.useState)(
              (function e(t) {
                let r;
                return !t?.properties && t?.default
                  ? (r = t.default)
                  : (t?.properties &&
                      (r = Object.fromEntries(
                        Object.entries(t.properties).map(([t, r]) => [t, e(r)]),
                      )),
                    r);
              })(i),
            ),
            c = `${e.title}`;
          return ((0, tq.f)({ key: "Enter", callback: () => t({ ...o }), isSingleKey: !0 }),
          e.jsonPayloadSchema && e.jsonPayloadSchema.properties)
            ? (0, a.jsx)("div", {
                className: "flex flex-col gap-y-2 items-end",
                children: (0, a.jsxs)(
                  rX,
                  {
                    name: c,
                    className: "w-full",
                    defaultExpanded: !1,
                    children: [
                      (0, a.jsx)(
                        rm,
                        {
                          schemaArray: [i],
                          value: o,
                          setValue: (e) => l(e),
                          clearValue: () => l({}),
                          defaultExpanded: !1,
                        },
                        e.id,
                      ),
                      (0, a.jsx)("div", {
                        className: "flex items-center justify-end gap-x-2 p-3",
                        children: (0, a.jsx)(m, {
                          label: s["api.sendMessage"],
                          method: "websocket",
                          onClick: () => r && t({ ...o }),
                          className: "bg-[#000000] dark:bg-[#52525c]",
                          disabled: !r,
                        }),
                      }),
                    ],
                  },
                  e.title,
                ),
              })
            : null;
        },
        an = ({ sendOperations: e, sendMessage: t, isConnected: r }) => {
          let n = e.flatMap(({ messages: e }) => e);
          return (0, a.jsx)("div", {
            className: "space-y-2",
            children: n.map((e) =>
              (0, a.jsx)(aa, { message: e, sendMessage: t, isConnected: r }, e.id),
            ),
          });
        },
        as = ({
          channel: e,
          isPlaygroundExpanded: t,
          setIsPlaygroundExpanded: r,
          baseUrlOptions: s,
          initialSelectedBaseUrlIndex: i,
        }) => {
          let [o, l] = (0, n.useState)(i),
            [d, c] = (0, n.useState)(!1),
            {
              address: p,
              setAddress: m,
              onMessage: h,
              parameterValues: x,
              handleParameterChange: g,
              result: f,
              clearResult: y,
              securitySchemeValues: b,
              handleSecuritySchemeChange: v,
            } = (0, n.useContext)(rW),
            {
              connect: j,
              disconnect: k,
              connecting: w,
              isConnected: N,
              sendMessage: C,
            } = (({ address: e, onMessage: t }) => {
              let r = (0, n.useRef)(null),
                [a, s] = (0, n.useState)(""),
                [i, o] = (0, n.useState)(!1),
                [l, d] = (0, n.useState)(!1);
              (0, n.useEffect)(
                () => () => {
                  r.current && (r.current.close(), (r.current = null));
                },
                [],
              );
              let c = (0, n.useCallback)(() => {
                try {
                  r.current && r.current.close();
                  let a = new WebSocket(e);
                  ((r.current = a),
                    d(!0),
                    (a.onopen = () => {
                      (o(!0), s(""), d(!1));
                    }),
                    (a.onclose = () => {
                      (o(!1), s(""));
                    }),
                    (a.onerror = (e) => {
                      (s("WebSocket connection error"),
                        o(!1),
                        d(!1),
                        console.error("WebSocket error:", e));
                    }),
                    (a.onmessage = (e) => {
                      if (t) {
                        try {
                          let r = JSON.parse(e.data);
                          t({ type: "receive", timestamp: Date.now(), data: r });
                        } catch (r) {
                          t({ type: "receive", timestamp: Date.now(), data: e.data });
                        }
                      }
                    }));
                } catch (e) {
                  (s(e instanceof Error ? e.message : "Failed to connect to WebSocket"),
                    o(!1),
                    d(!1));
                }
              }, [e, t, o]);
              return {
                connect: c,
                disconnect: (0, n.useCallback)(() => {
                  (d(!0),
                    r.current &&
                      ((r.current.onclose = () => {
                        (d(!1), o(!1));
                      }),
                      r.current.close(),
                      (r.current = null)));
                }, []),
                sendMessage: (0, n.useCallback)(
                  (e) => {
                    if (!r.current || r.current.readyState !== WebSocket.OPEN) {
                      return void s("WebSocket is not connected");
                    }
                    try {
                      let a = "string" == typeof e ? e : JSON.stringify(e);
                      (r.current.send(a), t && t({ type: "send", timestamp: Date.now(), data: e }));
                    } catch (e) {
                      s(e instanceof Error ? e.message : "Failed to send message");
                    }
                  },
                  [t],
                ),
                error: a,
                connecting: l,
                setIsConnecting: d,
                isConnected: i,
                setIsConnected: o,
              };
            })({ address: p, onMessage: h });
          (0, n.useEffect)(() => {
            m(
              r3({
                address: e.address ?? "",
                baseUrl: s[o] ?? s[0] ?? "",
                parameterValues: x,
                securitySchemeValues: b,
              }),
            );
          }, [o, s, e, m, x, b]);
          let S = async () => {
            let t = r3({
              address: e.address ?? "",
              baseUrl: s[o] ?? s[0] ?? "",
              parameterValues: x,
              securitySchemeValues: b,
            });
            "success" === (await (0, eH.l)(t)) &&
              (c(!0),
              setTimeout(() => {
                c(!1);
              }, 2e3));
          };
          return (
            (0, tq.f)({
              key: "Escape",
              callback: t ? () => void (N && k(), r(!1)) : void 0,
              isSingleKey: !0,
            }),
            (0, a.jsxs)(t_, {
              isPlaygroundExpanded: t,
              setIsPlaygroundExpanded: r,
              children: [
                (0, a.jsx)("div", {
                  className:
                    "sticky top-0 z-50 bg-background-light dark:bg-background-dark px-4 pt-4 pb-2",
                  children: (0, a.jsxs)("div", {
                    className: "flex items-center justify-between gap-x-2",
                    children: [
                      (0, a.jsx)(tT, { channel: e }),
                      (0, a.jsx)(r1, {
                        onCopy: S,
                        baseUrlOptions: s,
                        selectedBaseUrlIndex: o,
                        setSelectedBaseUrlIndex: l,
                        onBaseUrlChange: N ? k : () => {},
                        isCopiedActive: d,
                        hasGrayBackground: !0,
                        display: "interactive",
                        path: e.address ?? "",
                        method: "websocket",
                      }),
                      (0, a.jsx)(r6, { connecting: w, isConnected: N, onClick: N ? k : j }),
                    ],
                  }),
                }),
                (0, a.jsxs)("div", {
                  className:
                    "grid grid-cols-1 lg:grid-cols-5 gap-x-8 gap-y-6 px-4 pb-4 pt-3 relative",
                  children: [
                    (0, a.jsxs)("div", {
                      className: "col-span-1 lg:col-span-3",
                      children: [
                        (0, a.jsx)(tE, { title: e.title, description: e.description }),
                        (0, a.jsxs)("div", {
                          className: "space-y-2 mt-6",
                          children: [
                            e.securitySchemes.length > 0 &&
                              (0, a.jsx)(r9, {
                                name: "Security Schemes",
                                securitySchemes: e.securitySchemes,
                                securitySchemeValues: b,
                                handleSecuritySchemeChange: v,
                              }),
                            e.parameters.length > 0 &&
                              (0, a.jsx)(r7, {
                                name: "Path Parameters",
                                parameters: e.parameters,
                                parameterValues: x,
                                onChange: g,
                              }),
                            e.sendOperations.length > 0 &&
                              (0, a.jsx)(an, {
                                sendOperations: e.sendOperations,
                                sendMessage: C,
                                isConnected: N,
                              }),
                          ],
                        }),
                      ],
                    }),
                    (0, a.jsx)("div", {
                      className: (0, u.cn)(
                        "p-px col-span-1 lg:col-span-2 lg:space-y-6 lg:flex lg:sticky lg:top-0 lg:self-start lg:h-[calc(100vh-5.5rem)]",
                        f.length > 0 && "lg:flex-col overflow-y-auto lg:-top-12 lg:h-screen",
                      ),
                      children: (0, a.jsx)(ar, {
                        name: "Messages",
                        messages: f,
                        isConnected: N,
                        clearResult: y,
                      }),
                    }),
                  ],
                }),
              ],
            })
          );
        },
        ai = ({ securitySchemes: e }) =>
          (0, a.jsx)(rX, {
            name: "Security Schemes",
            children: e.map((e) =>
              (0, a.jsx)(
                rY,
                {
                  label: e.name,
                  typeLabel: e.type,
                  propertiesCount: 0,
                  defaultShowChildren: !1,
                  required: !1,
                  deprecated: !1,
                  description: e.description,
                  topLevel: !0,
                },
                e.id,
              ),
            ),
          }),
        ao = ({ channel: e }) => {
          let t = (0, h.D)(),
            [r, s] = (0, n.useState)(0),
            [i, o] = (0, n.useState)(!1),
            [l, d] = (0, n.useState)(!1),
            c = new Set(["httpApiKey"]),
            p = e.securitySchemes.every((e) => c.has(e.type)),
            u = "none" === t,
            x = "simple" === t || !p;
          (0, n.useEffect)(() => {
            new URLSearchParams(window.location.search).has("playground") &&
              requestAnimationFrame(() => {
                o(!0);
              });
          }, []);
          let g = e.servers.map((e) => {
              let t = e.protocol,
                r = e.host;
              return `${t}://${r}`;
            }),
            f = async () => {
              let t = g[r] ?? g[0] ?? "",
                a = e.address ?? "",
                n = (0, rJ.s4)(t, a);
              "success" === (await (0, eH.l)(n)) &&
                (d(!0),
                setTimeout(() => {
                  d(!1);
                }, 2e3));
            };
          return (0, a.jsxs)(rZ.z.Provider, {
            value: {
              isSending: !1,
              setSelectedBaseUrlIndex: s,
              selectedBaseUrlIndex: r,
              baseUrlOptions: g,
              isPlaygroundExpanded: i,
              setIsPlaygroundExpanded: (e) => {
                if ((o(e), e)) {
                  let e = new URL(window.location.href);
                  (e.searchParams.set("playground", "open"),
                    window.history.replaceState({}, "", e));
                } else {
                  let e = new URL(window.location.href);
                  (e.searchParams.delete("playground"), window.history.replaceState({}, "", e));
                }
              },
            },
            children: [
              (0, a.jsx)("div", {
                className: "flex flex-col gap-8",
                children: (0, a.jsxs)("div", {
                  className: "mt-6 flex w-full flex-col space-y-4",
                  children: [
                    u
                      ? null
                      : (0, a.jsx)("div", {
                          className:
                            "flex w-full flex-col bg-background-light dark:bg-background-dark border-standard rounded-2xl p-1.5",
                          children: (0, a.jsxs)("div", {
                            className: "flex items-center space-x-1.5",
                            children: [
                              (0, a.jsx)(r1, {
                                onCopy: f,
                                baseUrlOptions: g,
                                selectedBaseUrlIndex: r,
                                setSelectedBaseUrlIndex: s,
                                isCopiedActive: l,
                                hasGrayBackground: !1,
                                display: t,
                                path: e.address ?? "",
                                method: "websocket",
                              }),
                              x
                                ? null
                                : (0, a.jsx)(m, {
                                    label: "Connect",
                                    method: "websocket",
                                    onClick: () => o(!0),
                                    className: "bg-[#000000] dark:bg-[#52525c]",
                                    isSending: !1,
                                  }),
                            ],
                          }),
                        }),
                    (0, a.jsx)("div", {
                      className: "mt-8 lg:mt-0 flex flex-col gap-6 xl:hidden",
                      children: (0, a.jsx)(r2.z, { name: "Messages", channel: e }),
                    }),
                    (0, a.jsxs)("div", {
                      className: "flex flex-col gap-6",
                      children: [
                        e.parameters.length > 0 && (0, a.jsx)(r4, { parameters: e.parameters }),
                        e.securitySchemes.length > 0 &&
                          (0, a.jsx)(ai, { securitySchemes: e.securitySchemes }),
                        e.bindings.length > 0 && (0, a.jsx)(r0, { bindings: e.bindings }),
                        e.sendOperations.length > 0 &&
                          (0, a.jsx)(r5, { operations: e.sendOperations, type: "send" }),
                        e.receiveOperations.length > 0 &&
                          (0, a.jsx)(r5, { operations: e.receiveOperations, type: "receive" }),
                      ],
                    }),
                  ],
                }),
              }),
              !u &&
                !x &&
                (0, a.jsx)(rG, {
                  children: (0, a.jsx)(as, {
                    channel: e,
                    isPlaygroundExpanded: i,
                    setIsPlaygroundExpanded: o,
                    baseUrlOptions: g,
                    initialSelectedBaseUrlIndex: r,
                  }),
                }),
            ],
          });
        };
      var al = r(81817);
      let ad = ({ pageMetadata: e, children: t }) => {
        let r = (0, al.B)(),
          n = e.api || e.openapi || e["openapi-schema"];
        return e.asyncapi && r
          ? (0, a.jsx)(ao, { channel: r })
          : n
            ? (0, a.jsx)(rK, { children: t })
            : null;
      };
    },
    840: (e, t, r) => {
      "use strict";
      function a(e) {
        return {
          isWide: "wide" === e.mode,
          isCenter: "center" === e.mode,
          isCustom: "custom" === e.mode,
          isFrame: "frame" === e.mode,
        };
      }
      r.d(t, { H: () => a });
    },
    1491: (e, t, r) => {
      "use strict";
      r.d(t, { cg: () => l, f3: () => d });
      var a = r(92685),
        n = r(90280),
        s = r(91052);
      let i = [
        "description",
        "canonical",
        "og:site_name",
        "og:title",
        "og:description",
        "og:image",
        "og:locale",
        "og:logo",
        "og:url",
        "article:publisher",
        "twitter:title",
        "twitter:description",
        "twitter:url",
        "twitter:image",
        "twitter:site",
        "og:image:width",
        "og:image:height",
        "robots",
      ];
      function o(e, t) {
        let r = "";
        return (
          (r += n.HL ? "http://" : "https://"),
          e.includes(".")
            ? (r += e)
            : (r += e + "." + (n.W7 || n.HL ? "localhost:3000" : s._.HOST_NAME)),
          (r += s._.BASE_PATH),
          (r += t ?? "")
        );
      }
      function l(e, t, r, a, n) {
        let s = t.seo?.metatags || {},
          l = {
            charset: "utf-8",
            "og:type": "website",
            "og:site_name": t.name,
            "twitter:card": "summary_large_image",
            "og:title": c(e, t.name),
            "twitter:title": c(e, t.name),
          };
        (e.description && (l["og:description"] = e.description),
          i.forEach((t) => {
            let a = e[t] ?? s[t];
            (a && (l[t] = a),
              ("og:image" === t || "twitter:image" === t) &&
                r &&
                "string" == typeof a &&
                (l[t] = a));
          }),
          Object.entries(s).forEach(([e, t]) => {
            t && !l[e] && (l[e] = t);
          }),
          (l.noindex = e.noindex ?? e.hidden));
        let d = n?.[0],
          p = "";
        return (
          e.canonical
            ? (p = e.canonical)
            : t.seo?.metatags?.canonical && e.href
              ? (p = t.seo.metatags.canonical + e.href)
              : d
                ? (p = o(d, e.href))
                : a && (p = o(a, e.href)),
          p && (p.endsWith("/index") && (p = p.slice(0, -6)), (l.canonical = p), (l["og:url"] = p)),
          l
        );
      }
      function d(e) {
        let t = e.sidebarTitle,
          r = e.title;
        return "string" == typeof t && t
          ? t
          : "string" == typeof r && r
            ? r
            : (0, a.r)(e.href || "");
      }
      function c(e, t) {
        let r = (function (e) {
          let t = e.title,
            r = e.sidebarTitle;
          return "string" == typeof t && t
            ? t
            : "string" == typeof r && r
              ? r
              : (0, a.r)(e.href || "");
        })(e);
        return r && t ? r + " - " + t : t || r;
      }
    },
    5904: (e, t, r) => {
      "use strict";
      r.d(t, { H: () => a, _: () => n });
      let a = (e) => {
          switch (e?.toUpperCase()) {
            case "GET":
              return {
                activeNavPillBg: "bg-[#2AB673]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-green-700 dark:text-green-400",
                inactiveNavPillBg: "bg-green-400/20 dark:bg-green-400/20",
                paramStyle: "text-[#2AB673] bg-[#2AB673]/10 border-[#2AB673]/30",
              };
            case "POST":
            case "WEBHOOK":
              return {
                activeNavPillBg: "bg-[#3064E3]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-blue-700 dark:text-blue-400",
                inactiveNavPillBg: "bg-blue-400/20 dark:bg-blue-400/20",
                paramStyle: "text-[#3064E3] bg-[#3064E3]/10 border-[#3064E3]/30",
              };
            case "PUT":
              return {
                activeNavPillBg: "bg-[#C28C30]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-yellow-700 dark:text-yellow-400",
                inactiveNavPillBg: "bg-yellow-400/20 dark:bg-yellow-400/20",
                paramStyle: "text-[#C28C30] bg-[#C28C30]/10 border-[#C28C30]/30",
              };
            case "DELETE":
              return {
                activeNavPillBg: "bg-[#CB3A32]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-red-700 dark:text-red-400",
                inactiveNavPillBg: "bg-red-400/20 dark:bg-red-400/20",
                paramStyle: "text-[#CB3A32] bg-[#CB3A32]/10 border-[#CB3A32]/30",
              };
            case "OPTIONS":
              return {
                activeNavPillBg: "bg-[#9341FB]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-purple-700 dark:text-purple-400",
                inactiveNavPillBg: "bg-purple-400/20 dark:bg-purple-400/20",
                paramStyle: "text-[#9341FB] bg-[#9341FB]/10 border-[#9341FB]/30",
              };
            case "HEAD":
              return {
                activeNavPillBg: "bg-[#0e7490]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-cyan-700 dark:text-cyan-400",
                inactiveNavPillBg: "bg-cyan-400/20 dark:bg-cyan-400/20",
                paramStyle:
                  "text-[#0e7490] dark:text-[#00d3f2] bg-[#00d3f2]/10 border-[#00d3f2]/30",
              };
            case "PATCH":
              return {
                activeNavPillBg: "bg-[#DA622B]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-orange-700 dark:text-orange-400",
                inactiveNavPillBg: "bg-orange-400/20 dark:bg-orange-400/20",
                paramStyle: "text-[#DA622B] bg-[#DA622B]/10 border-[#DA622B]/30",
              };
            case "TRACE":
              return {
                activeNavPillBg: "bg-[#BD30D3]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-fuchsia-700 dark:text-fuchsia-400",
                inactiveNavPillBg: "bg-fuchsia-400/20 dark:bg-fuchsia-400/20",
                paramStyle: "text-[#BD30D3] bg-[#BD30D3]/10 border-[#BD30D3]/30",
              };
            case "WEBSOCKET":
              return {
                activeNavPillBg: "bg-[#F54A00] dark:bg-[#FF6900]",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-[#F54A00] dark:text-[#FF6900]",
                inactiveNavPillBg: "bg-[#FFEDD4] dark:bg-[#FF6900]/20",
                paramStyle:
                  "text-[#F54A00] bg-[#FFEDD4]/10 border-[#FFEDD4]/30 dark:text-[#FF6900] dark:bg-[#FF6900]/10 dark:border-[#FF6900]/30",
              };
            case "DEPRECATED":
              return {
                activeNavPillBg: "bg-[#F7F7F8] dark:bg-[#14151A]",
                activeNavPillText: "text-[#14151A] dark:text-[#FFFFFF]",
                inactiveNavPillText: "text-[#14151A] dark:text-[#FFFFFF]",
                inactiveNavPillBg: "bg-[#F7F7F8] dark:bg-[#14151A]",
              };
            default:
              return {
                activeNavPillBg: "bg-gray-600",
                activeNavPillText: "text-[#FFFFFF]",
                inactiveNavPillText: "text-gray-700 dark:text-gray-400",
                inactiveNavPillBg: "bg-gray-400/20 dark:bg-gray-400/20",
                paramStyle: "text-gray-600 bg-gray-600/10 border-gray-600/30",
              };
          }
        },
        n = (e) => {
          let t = e?.toUpperCase();
          switch (t) {
            case "DELETE":
              return "DEL";
            case "WEBHOOK":
              return "HOOK";
            case "WEBSOCKET":
              return "WSS";
            default:
              return t;
          }
        };
    },
    6472: (e, t, r) => {
      "use strict";
      r.d(t, {
        DropdownMenu: () => l,
        DropdownMenuContent: () => c,
        DropdownMenuTrigger: () => d,
        _: () => p,
      });
      var a = r(54568),
        n = r(45835),
        s = r(6438),
        i = r(7620),
        o = r(81325);
      let l = (e) => (0, a.jsx)(n.bL, { modal: !1, ...e });
      l.displayName = n.bL.displayName;
      let d = i.forwardRef(({ className: e, children: t, ...r }, s) =>
        (0, a.jsx)(n.l9, {
          ref: s,
          className: (0, o.cn)(
            "group disabled:pointer-events-none [&>span]:line-clamp-1 rounded-lg overflow-hidden group",
            "flex items-center py-0.5 gap-1 text-sm text-gray-950/50 dark:text-white/50 group-hover:text-gray-950/70 dark:group-hover:text-white/70",
            e,
          ),
          ...r,
          children: t,
        }),
      );
      ((d.displayName = n.l9.displayName), n.ZL);
      let c = i.forwardRef(({ className: e, sideOffset: t = 4, ...r }, s) =>
        (0, a.jsx)(n.ZL, {
          children: (0, a.jsx)(n.UC, {
            ref: s,
            sideOffset: t,
            collisionPadding: 16,
            align: "start",
            style: { textRendering: "geometricPrecision" },
            className: (0, o.cn)(
              "origin-[--radix-dropdown-menu-content-transform-origin] shadow-xl dark:shadow-none shadow-gray-500/5 dark:shadow-gray-500/5 bg-background-light dark:bg-background-dark p-1 relative z-50 max-h-96 max-w-[var(--radix-dropdown-menu-content-available-width)] min-w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-2xl border-standard text-gray-950/70 dark:text-white/70",
              "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
              e,
            ),
            ...r,
          }),
        }),
      );
      c.displayName = n.UC.displayName;
      let p = i.forwardRef(({ className: e, isSelected: t, ...r }, i) =>
        (0, a.jsxs)(n.Item, {
          ref: i,
          style: { fontWeight: "normal !important" },
          className: (0, o.cn)(
            "flex items-center justify-between px-2 py-1 gap-2 text-sm rounded-md group hover:bg-background-dark/[0.03] dark:hover:bg-background-light/[0.03] focus:bg-background-dark/5 dark:focus:bg-background-light/5 relative w-full cursor-pointer select-none outline-0 focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:cursor-default data-[disabled]:opacity-50",
            t
              ? "text-primary dark:text-primary-light font-medium"
              : "text-gray-950/50 dark:text-white/50 hover:text-gray-950/75 dark:hover:text-white/75 focus:text-gray-950/75 dark:focus:text-white/75",
            e,
          ),
          ...r,
          children: [
            r.children,
            (0, a.jsx)(s.A, {
              className: (0, o.cn)(
                "size-3.5 text-primary dark:text-primary-light shrink-0",
                !t && "opacity-0",
              ),
              strokeWidth: 2.5,
            }),
          ],
        }),
      );
      p.displayName = n.Item.displayName;
    },
    6482: (e, t, r) => {
      "use strict";
      r.d(t, { i: () => s, u: () => n });
      var a = r(39282);
      let n = (e) => {
          let [{ codeExamples: t }] = (0, a.O)();
          return t[e];
        },
        s = () => {
          let [{ codeExamples: e }] = (0, a.O)();
          return !!e.request || !!e.response;
        };
    },
    6723: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => s });
      var a = r(7620);
      class n extends a.Component {
        constructor(e) {
          (super(e), (this.state = { hasError: !1 }));
        }
        static getDerivedStateFromError() {
          return { hasError: !0 };
        }
        componentDidCatch(e, t) {
          console.log({ error: e, errorInfo: t });
        }
        render() {
          return this.state.hasError ? null : this.props.children;
        }
      }
      let s = n;
    },
    7603: (e, t, r) => {
      "use strict";
      r.d(t, { j: () => o });
      var a = r(54568),
        n = r(7620),
        s = r(81325);
      function i(e) {
        if ("number" == typeof e) {
          return { type: "pixel", value: e };
        }
        if ("string" == typeof e) {
          if (e.endsWith("%")) {
            return { type: "percentage", value: e };
          }
          let t = parseInt(e, 10);
          if (!isNaN(t)) {
            return { type: "pixel", value: t };
          }
        }
      }
      let o = ({ height: e, width: t, src: r, className: o, style: l, ...d }) => {
        let [c, p] = (0, n.useState)(!1);
        ((0, n.useEffect)(() => {
          p(!0);
        }, []),
          (e = e || l?.height));
        let u = i((t = t || l?.width)),
          m = i(e),
          h = u?.type === "pixel" && m?.type === "pixel" ? `${u.value} / ${m.value}` : void 0,
          x = !t && !e;
        return (0, a.jsxs)("div", {
          "data-as": "iframe",
          className: (0, s.cn)("flex justify-center w-full"),
          children: [
            !c &&
              (0, a.jsx)("div", {
                className: (0, s.cn)("object-contain w-full", o),
                style: {
                  ...(m ? { height: m.value } : {}),
                  ...(u ? { width: u.value } : {}),
                  ...(h ? { aspectRatio: h } : { aspectRatio: "16/9" }),
                },
              }),
            c &&
              (0, a.jsx)("iframe", {
                ...d,
                src: r,
                className: (0, s.cn)(x && "w-full", o),
                style: {
                  ...(h ? { aspectRatio: h } : { aspectRatio: "16/9" }),
                  ...l,
                  ...(m ? { height: m.value } : {}),
                  ...(u ? { width: u.value } : {}),
                },
              }),
          ],
        });
      };
    },
    7755: (e, t, r) => {
      "use strict";
      r.d(t, { D: () => g, P: () => x });
      var a = r(54568),
        n = r(7620),
        s = r(47990),
        i = r(30793),
        o = r(76829),
        l = r(17644),
        d = r(39282),
        c = r(70153),
        p = r(73205),
        u = r(81325),
        m = r(7844),
        h = r(57810);
      let x = (e) =>
        decodeURIComponent(e)
          .replace(/[?,;:!'"()[\]{}]/g, "")
          .replace(
            /\p{Emoji_Modifier}|\p{Emoji_Modifier_Base}|\p{Emoji_Presentation}|\p{Extended_Pictographic}|[\u200D\uFE0E\uFE0F]/gu,
            "",
          );
      function g({
        level: e,
        id: t,
        children: r,
        className: g = "",
        hidden: f = !1,
        style: y = {},
        noAnchor: b = !1,
        ...v
      }) {
        let { docsConfig: j } = (0, n.useContext)(i.DocsConfigContext),
          k = (0, o.n)(),
          w = `h${e}`,
          [N, C] = (0, d.O)(),
          [S, O] = (0, n.useState)(null),
          [$] = (0, s.y)(O),
          T = (0, c.T)(S),
          E = x(t),
          A = (0, n.useCallback)(() => {
            b ||
              ((0, h.l)(`https://${window.location.host}${window.location.pathname}#${E}`),
              (window.location.hash = E),
              (0, m.h)({ id: E }));
          }, [E, b]),
          P = !!N;
        return (
          (0, n.useEffect)(() => {
            if (P) {
              return (
                void 0 !== T && C({ type: "register_heading", payload: { id: E, top: T } }),
                () => {
                  C({ type: "unregister_heading", payload: E });
                }
              );
            }
          }, [T, E, P, C]),
          (0, a.jsxs)(w, {
            className: (0, u.cn)(
              "flex whitespace-pre-wrap group font-semibold",
              (0, l.H)(j?.theme).headings,
              g,
              { "text-2xl sm:text-3xl mt-8": "h1" === w },
            ),
            id: E,
            ref: $,
            style: { ...(f ? { marginBottom: 0 } : {}), ...y },
            ...v,
            children: [
              !f &&
                !b &&
                (0, a.jsx)("div", {
                  className: "absolute",
                  tabIndex: -1,
                  children: (0, a.jsxs)("a", {
                    href: `#${E}`,
                    className:
                      "-ml-10 flex items-center opacity-0 border-0 group-hover:opacity-100 focus:opacity-100 focus:outline-0 group/link",
                    "aria-label": k["aria.navigateToHeader"],
                    onClick: A,
                    children: [
                      "​",
                      (0, a.jsx)("div", {
                        className:
                          "w-6 h-6 rounded-md flex items-center justify-center shadow-sm text-gray-400 dark:text-white/50 dark:bg-background-dark dark:brightness-[1.35] dark:ring-1 dark:hover:brightness-150 bg-white ring-1 ring-gray-400/30 dark:ring-gray-700/25 hover:ring-gray-400/60 dark:hover:ring-white/20 group-focus/link:border-2 group-focus/link:border-primary dark:group-focus/link:border-primary-light",
                        children: (0, a.jsx)(p.qY, {}),
                      }),
                    ],
                  }),
                }),
              (0, a.jsx)("span", {
                className: (0, u.cn)(!b && "cursor-pointer", f && "sr-only"),
                onClick: A,
                children: r,
              }),
            ],
          })
        );
      }
    },
    8239: (e, t, r) => {
      "use strict";
      function a(e) {
        if ("string" != typeof e) {
          return !1;
        }
        try {
          let t = new URL(e);
          return "https:" === t.protocol;
        } catch {
          return !1;
        }
      }
      r.d(t, { K: () => a });
    },
    8657: (e, t, r) => {
      "use strict";
      r.d(t, { n: () => y, t1: () => j, ks: () => g, sG: () => b, ob: () => v, rG: () => f });
      var a = r(54568),
        n = r(7620),
        s = r(16903),
        i = r(28835),
        o = r(84583),
        l = r(76829),
        d = r(33052),
        c = r(73205);
      let p = { query: {}, path: {}, header: {}, body: {}, cookie: {} },
        u = (e, t) => {
          if (void 0 === t || !e) {
            return t;
          }
          let r = e.toLowerCase();
          if (r.endsWith("[]")) {
            let e = r.slice(0, -2),
              a = (t) => u(e, t);
            try {
              let e = JSON.parse(t);
              if (Array.isArray(e)) {
                return e.map((e) => a(String(e)));
              }
            } catch {}
            return t.split(",").map((e) => a(e.trim()));
          }
          switch (r) {
            case "number":
              return Number(t);
            case "bool":
              if ("true" === t.toLowerCase()) {
                return !0;
              }
              if ("false" === t.toLowerCase()) {
                return !1;
              }
              return t;
            case "object":
              try {
                return JSON.parse(t);
              } catch {
                return t;
              }
            default:
              return t;
          }
        };
      var m = r(81325),
        h = r(57810),
        x = r(7844);
      function g({ children: e, prefix: t, className: r }) {
        return (0, a.jsxs)("div", {
          className: (0, m.cn)(
            "flex items-center px-2 py-0.5 rounded-md bg-gray-100/50 dark:bg-white/5 text-gray-600 dark:text-gray-200 font-medium break-all",
            r,
          ),
          "data-component-part": "field-info-pill",
          children: [
            t && (0, a.jsx)("span", { className: "text-gray-400 dark:text-gray-500", children: t }),
            (0, a.jsx)("span", { children: e }),
          ],
        });
      }
      function f() {
        let e = (0, l.n)();
        return (0, a.jsx)("div", {
          className:
            "px-2 py-0.5 rounded-md bg-red-100/50 dark:bg-red-400/10 text-red-600 dark:text-red-300 font-medium whitespace-nowrap",
          "data-component-part": "field-required-pill",
          children: e["api.required"],
        });
      }
      function y() {
        let e = (0, l.n)();
        return (0, a.jsx)("div", {
          className:
            "px-2 py-0.5 rounded-md bg-amber-100/50 dark:bg-amber-400/10 text-amber-600 dark:text-amber-300 font-medium whitespace-nowrap",
          "data-component-part": "field-deprecated-pill",
          children: e["api.deprecated"],
        });
      }
      function b({
        query: e,
        path: t,
        body: r,
        header: s,
        children: i,
        default: o,
        type: l,
        location: d,
        required: c = !1,
        deprecated: m = !1,
        hidden: h = !1,
        id: x,
        pre: g,
        post: f,
      }) {
        let y = e || t || r || s;
        return ((0, n.useEffect)(() => {
          if (y && void 0 !== o) {
            let a = e ? "query" : t ? "path" : s ? "header" : r ? "body" : void 0;
            if (a) {
              let e = u(l, "string" == typeof o ? o : JSON.stringify(o));
              p[a][y] = e;
            }
          }
        }, [y, o, e, t, s, d]),
        null == y)
          ? null
          : (0, a.jsx)(j, {
              name: y,
              defaultValue: o,
              type: l,
              location: d,
              required: c,
              deprecated: m,
              hidden: h,
              id: x,
              pre: g,
              post: f,
              children: i,
            });
      }
      function v({
        name: e,
        typeLabel: t,
        location: r,
        required: d,
        deprecated: p,
        fieldType: u,
        defaultValue: b,
        typeOptions: v,
        selectedTypeOptionIndex: j,
        onSelectTypeOption: k,
        parentName: w,
        id: N,
        pre: C,
        post: S,
        style: O,
        explode: $,
      }) {
        let { hasScrolledToAnchorRef: T } = (0, n.useContext)(o.m$),
          E = (0, l.n)(),
          A = (0, n.useRef)(null),
          [P, I] = (0, n.useState)(!1),
          _ = N ?? (0, s.Ls)(u, e, w),
          q = (0, n.useCallback)(() => {
            _ &&
              ((0, h.l)(window.location.href.split("#")[0] + "#" + _), (window.location.hash = _));
          }, [_]);
        ((0, n.useEffect)(() => {
          let e = A.current;
          if (!e) {
            return;
          }
          function t() {
            I((e?.offsetHeight ?? 0) > 28);
          }
          t();
          let r = new ResizeObserver(t);
          return (
            r.observe(e),
            () => {
              r.unobserve(e);
            }
          );
        }, []),
          (0, n.useEffect)(() => {
            (0, x.h)({
              id: _,
              shouldReturnEarly: !!T?.current || !_ || !!w,
              checkIfShouldScroll: (e, t) => t === _,
              postScrollCallback() {
                T && (T.current = !0);
              },
            });
          }, [T, _, w]));
        let F = w
          ? "deepObject" === O && $
            ? (0, a.jsxs)(a.Fragment, {
                children: [
                  (0, a.jsx)("span", {
                    className: "text-gray-500 dark:text-gray-400",
                    children: w,
                  }),
                  e,
                  (0, a.jsx)("span", {
                    className: "text-gray-500 dark:text-gray-400",
                    children: "]",
                  }),
                ],
              })
            : (0, a.jsxs)(a.Fragment, {
                children: [
                  (0, a.jsx)("span", {
                    className: "text-gray-500 dark:text-gray-400",
                    children: w,
                  }),
                  e,
                ],
              })
          : e;
        return null == e
          ? null
          : (0, a.jsx)(
              "div",
              {
                className: (0, m.cn)(
                  "flex font-mono text-sm group/param-head param-head break-all relative",
                ),
                id: _,
                children: (0, a.jsx)("div", {
                  className: "flex-1 flex flex-col content-start py-0.5 mr-5",
                  children: (0, a.jsxs)("div", {
                    className: "flex items-center flex-wrap gap-2",
                    children: [
                      _ &&
                        (0, a.jsx)("div", {
                          className: "absolute -top-1.5",
                          children: (0, a.jsxs)("a", {
                            href: `#${_}`,
                            className: (0, m.cn)(
                              w ? "-ml-[2.1rem]" : "-ml-10",
                              "flex items-center opacity-0 border-0 group-hover/param-head:opacity-100 focus:opacity-100 focus:outline-0 py-2 [.expandable-content_&]:-ml-[2.1rem] group/link",
                            ),
                            "aria-label": E["aria.navigateToHeader"],
                            onClick: q,
                            children: [
                              "​",
                              (0, a.jsx)("div", {
                                className:
                                  "w-6 h-6 rounded-md flex items-center justify-center shadow-sm text-gray-400 dark:text-white/50 dark:bg-background-dark dark:brightness-[1.35] dark:ring-1 dark:hover:brightness-150 bg-white ring-1 ring-gray-400/30 dark:ring-gray-700/25 hover:ring-gray-400/60 dark:hover:ring-white/20 group-focus/link:border-2 group-focus/link:border-primary dark:group-focus/link:border-primary-light",
                                children: (0, a.jsx)(c.qY, {}),
                              }),
                            ],
                          }),
                        }),
                      C?.map((e, t) =>
                        (0, a.jsx)(
                          "div",
                          {
                            className:
                              "px-2 py-0.5 rounded-md bg-gray-100/50 dark:bg-white/5 text-gray-600 dark:text-gray-200",
                            "data-component-part": "field-meta-pre",
                            children: e,
                          },
                          t,
                        ),
                      ),
                      (w || e) &&
                        (0, a.jsx)("div", {
                          className:
                            "font-semibold text-primary dark:text-primary-light cursor-pointer overflow-wrap-anywhere",
                          "data-component-part": "field-name",
                          onClick: q,
                          children: F,
                        }),
                      (0, a.jsxs)("div", {
                        ref: A,
                        className: (0, m.cn)(
                          "inline items-center gap-2 text-xs font-medium [&_div]:inline [&_div]:mr-2",
                          P ? "[&_div]:leading-6" : "[&_div]:leading-5",
                        ),
                        "data-component-part": "field-meta",
                        children: [
                          v && v.length > 1 && k
                            ? (0, a.jsx)(i.b, { options: v, selectedIndex: j, onSelectOption: k })
                            : t && (0, a.jsx)(g, { children: t }),
                          r && (0, a.jsx)(g, { children: r }),
                          null != b &&
                            (0, a.jsx)(g, {
                              prefix: E["api.default"],
                              children:
                                "string" == typeof b ? ("" === b ? '""' : b) : JSON.stringify(b),
                            }),
                          d && (0, a.jsx)(f, {}),
                          p && (0, a.jsx)(y, {}),
                          S?.map((e, t) =>
                            (0, a.jsx)(
                              "div",
                              {
                                className:
                                  "px-2 py-0.5 rounded-md bg-gray-100/50 dark:bg-white/5 text-gray-600 dark:text-gray-200",
                                "data-component-part": "field-meta-post",
                                children: e,
                              },
                              t,
                            ),
                          ),
                        ],
                      }),
                    ],
                  }),
                }),
              },
              _,
            );
      }
      function j({
        name: e,
        type: t,
        location: r,
        defaultValue: s,
        required: i = !1,
        deprecated: o = !1,
        hidden: l = !1,
        id: c,
        pre: p,
        post: u,
        children: h,
      }) {
        let x = (0, n.useMemo)(() => {
          if ("object" == typeof s && Object.values(s).some((e) => "object" == typeof e)) {
            return null;
          }
          let e = JSON.stringify(s);
          return e && e.length > 0 && e.length < 50 ? e : null;
        }, [s]);
        return l
          ? null
          : (0, a.jsxs)("div", {
              className: (0, m.cn)(
                d.x.Field,
                "pt-2.5 pb-5 my-2.5 border-gray-50 dark:border-gray-800/50 border-b",
              ),
              children: [
                (0, a.jsx)(v, {
                  name: e,
                  typeLabel: t,
                  location: r,
                  required: i,
                  deprecated: o,
                  defaultValue: x,
                  id: c,
                  pre: p,
                  post: u,
                }),
                h &&
                  (0, a.jsx)("div", {
                    className:
                      "mt-4 prose-sm prose-gray dark:prose-invert [&_.prose>p:first-child]:mt-0 [&_.prose>p:last-child]:mb-0",
                    "data-component-part": "field-content",
                    children: h,
                  }),
              ],
            });
      }
    },
    9601: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => ej });
      var a = r(35154),
        n = r(19664),
        s = r.n(n),
        i = r(54568),
        o = r(59676),
        l = r(20795),
        d = r.n(l),
        c = r(7620),
        p = r(22153),
        u = r(33052),
        m = r(68999),
        h = r(81325),
        x = r(57810),
        g = r(7844),
        f = r(12192),
        y = r(76829);
      let b = function ({ id: e, title: t, description: r, open: a, icon: n, coverClass: s }) {
          let { divisions: o } = (0, c.useContext)(y.NavigationContext),
            { banner: l } = (0, c.useContext)(f.y),
            d = o.tabs.length > 0,
            p = !!l;
          return (0, i.jsxs)("summary", {
            className: (0, h.cn)(
              "relative not-prose flex flex-row items-center content-center w-full cursor-pointer",
              "list-none [&::-webkit-details-marker]:hidden",
              s,
            ),
            "aria-controls": e + " accordion children",
            "aria-expanded": a,
            "data-component-part": "accordion-button",
            children: [
              (0, i.jsx)("div", {
                id: e,
                className: (0, h.cn)(
                  "absolute",
                  p && d
                    ? "-top-[10.5rem]"
                    : p
                      ? "-top-[7rem]"
                      : d
                        ? "-top-[8rem]"
                        : "-top-[4.5rem]",
                ),
              }),
              (0, i.jsx)("div", {
                className: "mr-0.5",
                "data-component-part": "accordion-caret-right",
                children: (0, i.jsx)(m.A, {
                  icon: "caret-right",
                  iconType: "solid",
                  className: (0, h.cn)(
                    "h-3 w-3 transition bg-gray-700 dark:bg-gray-400",
                    a && "duration-200 rotate-90 -mt-1",
                    !a && "duration-75",
                  ),
                }),
              }),
              n
                ? (0, i.jsx)("div", {
                    className:
                      "h-4 w-4 fill-gray-800 dark:fill-gray-100 text-gray-800 dark:text-gray-100",
                    "data-component-part": "accordion-icon",
                    children: n,
                  })
                : null,
              (0, i.jsxs)("div", {
                className: "leading-tight text-left w-full",
                contentEditable: !1,
                "data-component-part": "accordion-title-container",
                children: [
                  (0, i.jsx)("p", {
                    className: "m-0 font-medium text-gray-900 dark:text-gray-200",
                    "data-component-part": "accordion-title",
                    children: t,
                  }),
                  r
                    ? (0, i.jsx)("p", {
                        className: "m-0 text-gray-900 dark:text-gray-200",
                        "data-component-part": "accordion-description",
                        children: r,
                      })
                    : null,
                ],
              }),
            ],
          });
        },
        v = (0, c.createContext)({ parentIds: [] });
      function j({
        title: e,
        description: t,
        defaultOpen: r = !1,
        icon: a,
        onChange: n,
        variant: s = "rounded",
        children: l,
        _disabled: p,
      }) {
        let m = "string" == typeof e ? (0, o.A)(e.replace(":", "-"), { decamelize: !1 }) : void 0,
          f = window.location.hash.substring(1).split(":"),
          y = (0, c.useContext)(v),
          [j, k] = (0, c.useState)(() => {
            var e;
            return m
              ? ((e = y.parentIds),
                !f || 0 === f.length || r
                  ? r
                  : !!d()(e, f.slice(0, f.indexOf(m))) && f.indexOf(m) === e.length)
              : r;
          });
        (0, c.useEffect)(() => {
          m &&
            j &&
            f &&
            f[f.length - 1] === m &&
            d()(y.parentIds, f.slice(0, f.indexOf(m))) &&
            (0, g.h)({
              id: m,
              preScrollCallback() {
                history.scrollRestoration = "manual";
              },
            });
        }, []);
        let w = (e) => `${window.location.pathname}${e ? `#${e}` : ""}`;
        function N(e, t) {
          if (p || "undefined" == typeof document || !document.hasFocus()) {
            return;
          }
          let r = w(e.join(t));
          ((0, x.l)(r),
            window.history.replaceState({ ...window.history.state, as: r, url: r }, "", r));
        }
        let {
          parentClass: C,
          coverClass: S,
          contentClass: O,
        } = "minimalist" === s
          ? {
              parentClass: "",
              coverClass:
                "[&>div]:ml-2 py-1 text-gray-700 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200",
              contentClass:
                "mt-2 pt-1 mb-4 mx-[7px] px-4 border-l border-gray-100 dark:border-gray-800/50",
            }
          : {
              parentClass:
                "border-standard rounded-2xl mb-3 overflow-hidden bg-background-light dark:bg-codeblock",
              coverClass:
                "py-4 px-5 space-x-2 hover:bg-gray-100 hover:dark:bg-gray-800 rounded-t-xl",
              contentClass: "mt-2 mb-4 mx-6",
            };
        return (0, i.jsx)(v.Provider, {
          value: { ...y, parentIds: [...y.parentIds, ...(void 0 != m ? [m] : [])] },
          children: (0, i.jsxs)(
            "details",
            {
              open: j,
              onKeyDownCapture: (e) => {
                let t = e.target;
                if (("TEXTAREA" === t.tagName || "INPUT" === t.tagName) && " " === e.key) {
                  e.preventDefault();
                  let r = t.selectionStart ?? 0,
                    a = t.selectionEnd ?? 0,
                    n = t.value;
                  ((t.value = n.slice(0, r) + " " + n.slice(a)),
                    (t.selectionStart = t.selectionEnd = r + 1),
                    t.dispatchEvent(new Event("input", { bubbles: !0 })));
                }
              },
              onToggle: (e) => {
                let t = e.currentTarget.open;
                if (t !== j) {
                  k(t);
                  if ((k(t), !p)) {
                    if (t && m) {
                      N([...y.parentIds, m], ":");
                    } else if (y.parentIds.length > 0) {
                      N(y.parentIds, ":");
                    } else {
                      let e = w("");
                      window.history.replaceState(
                        { ...window.history.state, as: e, url: e },
                        "",
                        e,
                      );
                    }
                    n && n(t);
                  }
                }
              },
              className: (0, h.cn)(u.x.Accordion, C, "cursor-default"),
              children: [
                (0, i.jsx)(b, { id: m, title: e, description: t, open: j, icon: a, coverClass: S }),
                (0, i.jsx)("div", {
                  id: m + " accordion children",
                  role: "region",
                  "aria-labelledby": m,
                  className: (0, h.cn)(
                    O,
                    "prose prose-gray dark:prose-invert overflow-x-auto cursor-default",
                  ),
                  "data-component-part": "accordion-content",
                  children: l,
                }),
              ],
            },
            "string" == typeof e ? e : "accordion",
          ),
        });
      }
      let k = {
          lg: 'gap-1 py-1 pl-2.5 pr-2.5 [&_svg]:size-3.5 text-sm tracking-[-0.1px] data-[shape="rounded"]:rounded-[8px]',
          md: 'gap-1 py-0.5 pl-2 pr-2 [&_svg]:size-3.5 text-sm tracking-[-0.1px] data-[shape="rounded"]:rounded-[8px]',
          sm: 'gap-[3px] py-0.5 pl-1.5 pr-1.5 [&_svg]:size-3 text-xs data-[shape="rounded"]:rounded-[6px]',
          xs: 'gap-0.5 py-0 pl-1 pr-1 [&_svg]:size-2.5 text-xs data-[shape="rounded"]:rounded-[4px]',
        },
        w = {
          gray: "[--color-bg:#F5F5F5] dark:[--color-bg:#262727] [--color-text:#78787A] dark:[--color-text:#D7D7D7] [--color-bg-disabled:#F5F5F5] dark:[--color-bg-disabled:#262727] [--color-text-disabled:#E9E9EA] dark:[--color-text-disabled:#3C3C3D]",
          blue: "[--color-bg:#E3EAFD] dark:[--color-bg:#07296A] [--color-text:#133A9A] dark:[--color-text:#7196F4] [--color-bg-disabled:#F0F4FE] dark:[--color-bg-disabled:#03153A] [--color-text-disabled:rgba(51,104,240,0.50)] dark:[--color-text-disabled:rgba(51,104,240,0.30)]",
          green:
            "[--color-bg:#D1FAE4] dark:[--color-bg:#0F4C2C] [--color-text:#166E3F] dark:[--color-text:#6AE1A1] [--color-bg-disabled:#EDFDF4] dark:[--color-bg-disabled:#072213] [--color-text-disabled:rgba(38,189,108,0.50)] dark:[--color-text-disabled:rgba(38,189,108,0.30)]",
          yellow:
            "[--color-bg:#FEF9C3] dark:[--color-bg:#713F12] [--color-text:#A16207] dark:[--color-text:#FDE047] [--color-bg-disabled:#FEFCE8] dark:[--color-bg-disabled:#422006] [--color-text-disabled:#FEF08A] dark:[--color-text-disabled:#854D0E]",
          orange:
            "[--color-bg:#FDEAD8] dark:[--color-bg:#613105] [--color-text:#AE590A] dark:[--color-text:#F8B577] [--color-bg-disabled:#FEF4EC] dark:[--color-bg-disabled:#301903] [--color-text-disabled:rgba(244,142,47,0.50)] dark:[--color-text-disabled:rgba(244,142,47,0.30)]",
          red: "[--color-bg:#FCE5E4] dark:[--color-bg:#64120D] [--color-text:#9A1C13] dark:[--color-text:#F08B85] [--color-bg-disabled:#FDF2F1] dark:[--color-bg-disabled:#360A07] [--color-text-disabled:rgba(230,72,61,0.50)] dark:[--color-text-disabled:rgba(230,72,61,0.30)]",
          purple:
            "[--color-bg:#ECDFFB] dark:[--color-bg:#3A0F71] [--color-text:#5314A3] dark:[--color-text:#B78AF0] [--color-bg-disabled:#ECDFFB] dark:[--color-bg-disabled:#3A0F71] [--color-text-disabled:rgba(135,61,230,0.50)] dark:[--color-text-disabled:rgba(135,61,230,0.30)]",
          white:
            "[--color-bg:rgba(255,255,255,0.95)] dark:[--color-bg:rgba(255,255,255,0.95)] [--color-text:rgba(11,12,14,0.60)] dark:[--color-text:rgba(11,12,14,0.60)] [--color-bg-disabled:rgba(255,255,255,0.08)] dark:[--color-bg-disabled:rgba(255,255,255,0.24)] [--color-text-disabled:#E9E9EA] dark:[--color-text-disabled:#3C3C3D]",
          surface:
            "[--color-bg:rgba(255,255,255,0.95)] dark:[--color-bg:#262727] [--color-text:#78787A] dark:[--color-text:#D7D7D7] [--color-bg-disabled:rgba(255,255,255,0.95)] dark:[--color-bg-disabled:#262727] [--color-text-disabled:#E9E9EA] dark:[--color-text-disabled:#3C3C3D]",
          "white-destructive":
            "[--color-bg:rgba(255,255,255,0.95)] dark:[--color-bg:rgba(255,255,255,0.95)] [--color-text:#E6483D] dark:[--color-text:#E6483D] [--color-bg-disabled:rgba(255,255,255,0.08)] dark:[--color-bg-disabled:rgba(255,255,255,0.24)] [--color-text-disabled:rgba(230,72,61,0.30)] dark:[--color-text-disabled:rgba(230,72,61,0.40)]",
          "surface-destructive":
            "[--color-bg:rgba(255,255,255,0.95)] dark:[--color-bg:#262727] [--color-text:#E6483D] dark:[--color-text:#E6483D] [--color-bg-disabled:rgba(255,255,255,0.95)] dark:[--color-bg-disabled:#262727] [--color-text-disabled:rgba(230,72,61,0.30)] dark:[--color-text-disabled:rgba(230,72,61,0.40)]",
        },
        N = ({
          children: e,
          className: t,
          color: r = "gray",
          shape: a = "rounded",
          stroke: n = !1,
          disabled: s = !1,
          size: o = "md",
          icon: l,
          iconType: d,
        }) => {
          let c =
            "string" == typeof l
              ? (0, i.jsx)(m.ComponentIcon, {
                  icon: l,
                  iconType: d,
                  className: "shrink-0",
                  overrideColor: !0,
                })
              : l;
          return (0, i.jsxs)("span", {
            "data-shape": a,
            "data-stroke": n,
            "data-disabled": s,
            className: (0, h.cn)(
              'inline-flex items-center w-fit font-medium relative data-[disabled="true"]:cursor-not-allowed',
              "data-[shape='pill']:rounded-full",
              "data-[stroke='true']:outline data-[stroke='true']:outline-1 data-[stroke='true']:-outline-offset-[1px] data-[stroke='true']:outline-[rgba(11,12,14,0.08)] dark:data-[stroke='true']:outline-[rgba(255,255,255,0.14)]",
              "bg-[--color-bg] text-[--color-text] [&_svg]:bg-[--color-text] data-[disabled='true']:bg-[--color-bg-disabled] data-[disabled='true']:text-[--color-text-disabled] [&_svg]:data-[disabled='true']:bg-[--color-text-disabled]",
              k[o],
              w[r],
              t,
            ),
            children: [!!c && c, e],
          });
        };
      var C = r(86419),
        S = r.n(C),
        O = r(73205);
      function $({
        children: e,
        icon: t,
        iconType: r,
        color: a,
        className: n,
        childrenClassName: s,
        calloutType: o,
        customStyle: l,
        customTextStyle: d,
      }) {
        let c =
          "string" == typeof t
            ? (0, i.jsx)(m.ComponentIcon, {
                icon: t,
                iconType: r,
                color: a,
                className: "size-4 !m-0 shrink-0",
              })
            : t;
        return (0, i.jsxs)("div", {
          className: (0, h.cn)(
            u.x.Callout,
            "my-4 px-5 py-4 overflow-hidden rounded-2xl flex gap-3",
            n,
          ),
          style: { ...l, ...d },
          "data-callout-type": o,
          children: [
            !!c &&
              (0, i.jsx)("div", {
                className: "mt-0.5 w-4",
                "data-component-part": "callout-icon",
                children: c,
              }),
            (0, i.jsx)("div", {
              className: (0, h.cn)(
                "text-sm prose dark:prose-invert min-w-0 w-full [&_kbd]:bg-background-light dark:[&_kbd]:bg-background-dark [&_code]:!text-current [&_kbd]:!text-current [&_a]:!text-current [&_a]:border-current [&_strong]:!text-current",
                s,
              ),
              style: d,
              "data-component-part": "callout-content",
              children: e,
            }),
          ],
        });
      }
      var T = r(34920),
        E = r(8239);
      function A({
        title: e,
        icon: t,
        img: r,
        className: a,
        children: n,
        horizontal: o,
        arrow: l,
        as: d,
        mRef: c,
        cta: p,
        disabled: m,
        ...x
      }) {
        let g = x.href && (x.href.startsWith("/") || x.href.startsWith("#")),
          f = d || (g ? s() : void 0 != x.href ? "a" : "div"),
          y = (0, E.K)(x.href ?? ""),
          b = "string" == typeof t,
          v = r ? (r.match(/\/([^/]+)\.[^.]+$/)?.[1] ?? "") : "",
          j = (0, i.jsx)(i.Fragment, {
            children: t
              ? b
                ? (0, i.jsx)("img", {
                    src: t,
                    alt: "string" == typeof e ? e : "",
                    className: "h-6 w-6 object-cover object-center",
                    "data-component-part": "card-icon",
                  })
                : (0, i.jsx)("div", {
                    className:
                      "h-6 w-6 fill-gray-800 dark:fill-gray-100 text-gray-800 dark:text-gray-100",
                    "data-component-part": "card-icon",
                    children: t,
                  })
              : null,
          });
        return (0, i.jsxs)(f, {
          className: (0, h.cn)(
            u.x.Card,
            "block font-normal group relative my-2 ring-2 ring-transparent rounded-2xl bg-white dark:bg-background-dark border border-gray-950/10 dark:border-white/10 overflow-hidden w-full",
            x.href && "cursor-pointer",
            a,
          ),
          ...(y ? { target: "_blank", rel: "noreferrer" } : {}),
          ...x,
          ref: c,
          children: [
            r &&
              (0, i.jsx)("img", {
                src: r,
                alt: v,
                className: "w-full object-cover object-center not-prose",
                "data-component-part": "card-image",
              }),
            (0, i.jsxs)("div", {
              className: (0, h.cn)("px-6 py-5 relative", o && "flex items-center gap-x-4"),
              "data-component-part": "card-content-container",
              children: [
                x.href &&
                  (0, i.jsx)("div", {
                    id: "card-link-arrow-icon",
                    className: (0, h.cn)(
                      "absolute text-gray-400 dark:text-gray-500 group-hover:text-primary dark:group-hover:text-primary-light top-5 right-5",
                      !(l ?? y) && "hidden",
                    ),
                    children: (0, i.jsx)(T.A, { className: "w-4 h-4" }),
                  }),
                j,
                (0, i.jsxs)("div", {
                  className: "w-full",
                  children: [
                    (0, i.jsx)("h2", {
                      className: (0, h.cn)(
                        "not-prose font-semibold text-base text-gray-800 dark:text-white",
                        null != t && !o && "mt-4",
                      ),
                      contentEditable: !1,
                      "data-component-part": "card-title",
                      children: e,
                    }),
                    (0, i.jsx)("div", {
                      className: (0, h.cn)(
                        "prose mt-1 font-normal text-base leading-6",
                        e ? "text-gray-600 dark:text-gray-400" : "text-gray-700 dark:text-gray-300",
                        o && "leading-6 mt-0",
                      ),
                      "data-component-part": "card-content",
                      children: n,
                    }),
                    p &&
                      (0, i.jsx)("div", {
                        className: "mt-8",
                        "data-component-part": "card-cta",
                        children: (0, i.jsxs)("button", {
                          className: (0, h.cn)(
                            "text-left text-gray-600 gap-2 dark:text-gray-400 text-sm font-medium flex flex-row items-center",
                            !m &&
                              "hover:text-primary dark:hover:text-primary-light group-hover:text-primary group-hover:dark:text-primary-light",
                          ),
                          disabled: m,
                          children: [p, (0, i.jsx)(O.fl, { className: "h-6" })],
                        }),
                      }),
                  ],
                }),
              ],
            }),
          ],
        });
      }
      function P({ children: e, cols: t = 2, className: r }) {
        let a = "";
        switch ((t = Number(t))) {
          case 1:
            a = "sm:grid-cols-1";
            break;
          case 2:
            a = "sm:grid-cols-2";
            break;
          case 3:
            a = "sm:grid-cols-3";
            break;
          case 4:
            a = "sm:grid-cols-4";
            break;
          default:
            a = "";
        }
        return (0, i.jsx)("div", {
          className: (0, h.cn)(u.x.CardGroup, "prose dark:prose-dark grid gap-x-4", a, r),
          children: e,
        });
      }
      var I = r(26859),
        _ = r(16530),
        q = r(24560),
        F = r(31002),
        R = r(14486),
        L = r(79634);
      function D({ tip: e, children: t, headline: r, cta: a, href: n }) {
        var s;
        let [o, l] = (0, c.useState)(!1),
          d = (function () {
            try {
              return matchMedia("(hover: hover)").matches;
            } catch {
              return !0;
            }
          })();
        if (!t) {
          return null;
        }
        let p =
          (0, c.isValidElement)(t) &&
          ("button" === t.type || ("string" == typeof t.type && "button" === t.type.toLowerCase()));
        return (0, i.jsx)(F.Kq, {
          delayDuration: 0,
          children: (0, i.jsxs)(F.bL, {
            open: o,
            onOpenChange: l,
            children: [
              (0, i.jsx)(F.l9, {
                "aria-label": r ? `${r}: ${e}` : e,
                asChild: p && (0, c.isValidElement)(t),
                onClick: d
                  ? void 0
                  : () => {
                      l(!o);
                    },
                children:
                  ((s = t),
                  (0, c.isValidElement)(s)
                    ? s
                    : (0, i.jsx)("span", {
                        className: (0, h.cn)(
                          u.x.Tooltip,
                          "underline decoration-dotted decoration-2 underline-offset-4 decoration-gray-400 dark:decoration-gray-500",
                        ),
                        children: s,
                      })),
              }),
              (0, i.jsx)(F.ZL, {
                children: (0, i.jsxs)(F.UC, {
                  collisionPadding: 8,
                  className:
                    "z-50 max-w-[16rem] px-4 py-3 rounded-xl bg-white border border-gray-200 dark:bg-gray-950 dark:border-gray-900 space-y-1 shadow-[0_10px_16px_-3px_rgb(10_10_10/0.05),0_3px_10px_-2px_rgb(10_10_10/0.02)]",
                  "data-component-part": "tooltip-content",
                  onPointerDownOutside: () => l(!1),
                  children: [
                    !!r &&
                      (0, i.jsx)("p", {
                        className: "text-xs font-medium leading-4 text-gray-900 dark:text-gray-200",
                        "data-component-part": "tooltip-headline",
                        children: r,
                      }),
                    (0, i.jsx)("p", {
                      className: "text-xs text-gray-600 dark:text-gray-400 leading-4",
                      "data-component-part": "tooltip-tip",
                      children: e,
                    }),
                    a &&
                      n &&
                      (0, i.jsxs)(L.DynamicLink, {
                        href: n,
                        "data-component-part": "tooltip-cta",
                        className:
                          "text-gray-600 !mt-2 dark:text-gray-400 hover:text-primary dark:hover:text-primary-light gap-0.5 flex items-center text-xs font-medium leading-4",
                        children: [
                          a,
                          (0, i.jsx)(R.A, {
                            className: "size-3",
                            strokeWidth: 2.5,
                            "aria-hidden": "true",
                          }),
                        ],
                      }),
                  ],
                }),
              }),
            ],
          }),
        });
      }
      let M = (0, c.createContext)("compact"),
        B = ({ children: e, variant: t }) =>
          (0, i.jsx)(M.Provider, {
            value: t,
            children: (0, i.jsx)("div", {
              "data-variant": t,
              className: (0, h.cn)(
                u.x.Color,
                "flex group",
                "table" === t && "flex-col gap-6",
                "compact" === t && "flex-row flex-wrap gap-x-2 gap-y-4",
              ),
              children: e,
            }),
          });
      ((B.Row = ({ children: e, title: t }) =>
        (0, i.jsxs)("div", {
          className: (0, h.cn)(u.x.ColorRow, "flex flex-col gap-2 md:flex-row md:items-center"),
          children: [
            !!t &&
              (0, i.jsx)("div", {
                className: "md:w-[120px] w-full flex-shrink-0",
                children: (0, i.jsx)("p", {
                  className:
                    "text-sm font-medium [letter-spacing:-0.1px] text-gray-900 dark:text-gray-200 m-0 truncate",
                  title: t,
                  children: t,
                }),
              }),
            (0, i.jsx)("div", { className: "flex w-full gap-1 md:gap-2", children: e }),
          ],
        })),
        (B.Item = ({ name: e, value: t }) => {
          let [r, a] = (0, c.useState)("idle"),
            [n, s] = (0, c.useTransition)(),
            { resolvedTheme: o } = (0, q.D)(),
            l = (0, c.useContext)(M),
            d = "string" == typeof t ? t : "dark" === (o || "light") ? t.dark : t.light,
            p = (0, i.jsx)("button", {
              style: { backgroundColor: d },
              onClick: () => {
                s(async () => {
                  (await (0, x.l)(d),
                    a("copied"),
                    await new Promise((e) => setTimeout(e, 2e3)),
                    a("idle"));
                });
              },
              className: (0, h.cn)(
                "cursor-copy relative flex items-center justify-center rounded-lg border border-neutral-200 dark:border-neutral-800",
                "compact" === l && "max-h-[104px] aspect-square",
                "table" === l && "aspect-square w-full md:h-10",
              ),
              "aria-label": e || `Color ${d}`,
              "aria-pressed": "copied" === r,
              "aria-roledescription": "copied" === r ? "Copied" : "Copy",
              children: (0, i.jsx)(O.Sr, {
                "aria-hidden": !0,
                className: (0, h.cn)(
                  "absolute inset-0 m-auto pointer-events-none transition-opacity duration-100 opacity-0",
                  "text-white dark:text-white [filter:drop-shadow(0_0_2px_rgb(0_0_0_/_0.1))_drop-shadow(0_0_4px_rgb(0_0_0_/_0.1))]",
                  "copied" === r && "opacity-100",
                ),
              }),
            });
          return (0, i.jsxs)("div", {
            className: (0, h.cn)(
              u.x.ColorItem,
              "compact" === l && "flex flex-col gap-2 flex-shrink-0",
              "table" === l && "w-full max-w-[50px] md:max-w-[60px]",
            ),
            children: [
              "table" === l ? (0, i.jsx)(D, { tip: d, children: p }) : p,
              "compact" === l &&
                (0, i.jsxs)("div", {
                  className: "flex flex-col gap-0.5 min-w-0 w-[104px]",
                  children: [
                    e &&
                      (0, i.jsx)("p", {
                        className:
                          "text-sm font-medium text-gray-900 dark:text-gray-200 m-0 truncate text-center",
                        title: e,
                        children: e,
                      }),
                    (0, i.jsx)("p", {
                      className:
                        "text-xs text-gray-600 dark:text-gray-400 m-0 truncate font-mono text-center",
                      title: d,
                      children: d,
                    }),
                  ],
                }),
            ],
          });
        }));
      var H = r(90235),
        U = r(96442);
      let z = (0, U.default)(() => Promise.resolve().then(r.bind(r, 90235)), {
        loadableGenerated: { webpack: () => [90235] },
        loading: () => (0, i.jsx)("p", { children: "Loading..." }),
        ssr: !1,
      });
      var V = r(51637),
        K = r(50519),
        W = r(7755);
      let G = (0, U.default)(
        () =>
          Promise.all([r.e(33220), r.e(18320), r.e(85815), r.e(40154)])
            .then(r.bind(r, 40154))
            .then((e) => e.Mermaid),
        { loadableGenerated: { webpack: () => [40154] }, ssr: !1 },
      );
      var J = r(97637),
        Z = r(35878),
        X = r(8657),
        Y = r(47990),
        Q = r(39282),
        ee = r(70153);
      let et = new Set(["p", "h2", "h3", "h4"]),
        er = ({
          stepNumber: e = 1,
          icon: t,
          iconType: r,
          title: a,
          children: n,
          titleSize: s = "p",
          noAnchor: o = !1,
          isLast: l = !1,
          id: d,
        }) => {
          let [p, f] = (0, Q.O)(),
            [y, b] = (0, c.useState)(null),
            [v, j] = (0, c.useState)(!1),
            [k] = (0, Y.y)(b),
            w = (0, ee.T)(y),
            N = et.has(s) ? s : "p",
            C = ["h2", "h3"].includes(N),
            S = !!p,
            $ = (0, W.P)(d ?? ""),
            T = (0, c.useCallback)(() => {
              o ||
                ((0, x.l)(`https://${window.location.host}${window.location.pathname}#${$}`),
                (window.location.hash = $),
                (0, g.h)({ id: $ }));
            }, [$, o]);
          ((0, c.useEffect)(() => {
            if (S && $) {
              return (
                void 0 !== w && f({ type: "register_heading", payload: { id: $, top: w } }),
                () => {
                  f({ type: "unregister_heading", payload: $ });
                }
              );
            }
          }, [w, $, S, f]),
            (0, c.useEffect)(() => {
              $ && !o && window.location.hash.substring(1) === $ && (0, g.h)({ id: $ });
            }, []));
          let E = (0, c.useCallback)(
              (e) => {
                C && j(e);
              },
              [C],
            ),
            A = { onMouseEnter: () => E(!0), onMouseLeave: () => E(!1), onClick: T },
            P =
              "string" == typeof t
                ? (0, i.jsx)(m.ComponentIcon, {
                    icon: t,
                    iconType: r,
                    className: "h-3 w-3 bg-gray-900 dark:bg-gray-50",
                    overrideColor: !0,
                  })
                : void 0 === t
                  ? Number(e)
                  : t;
          return (0, i.jsxs)("div", {
            id: $,
            ref: k,
            role: "listitem",
            className: (0, h.cn)(
              u.x.Step,
              "group/step step-container relative flex items-start pb-5",
            ),
            children: [
              (0, i.jsx)("div", {
                "data-component-part": "step-line",
                className: (0, h.cn)(
                  "absolute w-px h-[calc(100%-2.75rem)] top-[2.75rem]",
                  l
                    ? 'bg-transparent bg-gradient-to-b from-gray-200 dark:from-white/10 via-80% to-transparent group-has-[[data-component-part="step-content"]:empty]/step:hidden'
                    : "bg-gray-200/70 dark:bg-white/10",
                ),
                contentEditable: !1,
              }),
              (0, i.jsx)("div", {
                className: "absolute ml-[-13px] py-2",
                "data-component-part": "step-number",
                contentEditable: !1,
                children: (0, i.jsxs)("div", {
                  className:
                    "relative size-7 shrink-0 rounded-full bg-gray-50 dark:bg-white/10 text-xs text-gray-900 dark:text-gray-50 font-semibold flex items-center justify-center",
                  onMouseEnter: () => E(!0),
                  onMouseLeave: () => E(!1),
                  children: [
                    (0, i.jsx)("div", { className: (0, h.cn)(v && "opacity-0"), children: P }),
                    !o &&
                      (0, i.jsx)("div", {
                        className: "absolute",
                        "data-component-part": "step-number-anchor-link",
                        children: (0, i.jsx)("a", {
                          href: `#${$}`,
                          className: (0, h.cn)(
                            "flex items-center opacity-0 border-0",
                            v && "opacity-100",
                          ),
                          "aria-label": "Navigate to header",
                          onClick: (e) => {
                            (e.preventDefault(), T());
                          },
                          children: (0, i.jsx)("div", {
                            className: "w-6 h-6 flex items-center justify-center",
                            children: (0, i.jsx)(O.qY, {}),
                          }),
                        }),
                      }),
                  ],
                }),
              }),
              (0, i.jsxs)("div", {
                className: "w-full overflow-hidden pl-8 pr-px",
                children: [
                  !!a &&
                    {
                      p: (0, i.jsx)("p", {
                        className:
                          "mt-2 font-semibold prose dark:prose-invert text-gray-900 dark:text-gray-200",
                        contentEditable: !1,
                        "data-component-part": "step-title",
                        ...A,
                        children: a,
                      }),
                      h2: (0, i.jsx)("h2", {
                        className: "mt-2 cursor-pointer",
                        contentEditable: !1,
                        "data-component-part": "step-title",
                        ...A,
                        children: a,
                      }),
                      h3: (0, i.jsx)("h3", {
                        className: "mt-2 cursor-pointer",
                        contentEditable: !1,
                        "data-component-part": "step-title",
                        ...A,
                        children: a,
                      }),
                      h4: (0, i.jsx)("h4", {
                        className: "mt-2",
                        contentEditable: !1,
                        "data-component-part": "step-title",
                        ...A,
                        children: a,
                      }),
                    }[N],
                  (0, i.jsx)("div", {
                    "data-component-part": "step-content",
                    className: (0, h.cn)("prose dark:prose-invert", !a && "mt-2"),
                    children: n,
                  }),
                ],
              }),
            ],
          });
        };
      var ea = r(68429),
        en = r(42945);
      let es = (e) => {
          let t = `
    <svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
      <g opacity="0.5">
        <line x1="12" y1="${7}" x2="12" y2="${17}" 
              stroke="${e}" stroke-width="1" stroke-linecap="round"/>
        <line x1="${7}" y1="12" x2="${17}" y2="12" 
              stroke="${e}" stroke-width="1" stroke-linecap="round"/>
      </g>
    </svg>
  `;
          return `data:image/svg+xml,${encodeURIComponent(t)}`;
        },
        ei = es("rgb(0 0 0 / 0.02)"),
        eo = es("rgb(255 255 255 / 0.05)"),
        el = (0, c.createContext)({ level: 1, parentId: null }),
        ed = () => (0, c.useContext)(el),
        ec = ({ children: e, level: t, parentId: r }) => {
          let a = (0, c.useMemo)(() => ({ level: t, parentId: r }), [t, r]);
          return (0, i.jsx)(el.Provider, { value: a, children: e });
        },
        ep = (e) => 6 + (e - 1) * 22,
        eu = (e, t) => {
          e.querySelectorAll('[role="treeitem"]').forEach((e) => {
            e.setAttribute("tabindex", e === t ? "0" : "-1");
          });
        },
        em = Object.assign(
          ({ children: e }) => {
            let t = (0, c.useRef)(null),
              r = (0, c.useRef)(""),
              a = (0, c.useRef)(null),
              n = (0, c.useRef)(!1);
            ((0, c.useEffect)(() => {
              if (!t.current || n.current) {
                return;
              }
              let e = t.current.querySelector('[role="treeitem"]');
              e && (eu(t.current, e), (n.current = !0));
            }, [e]),
              (0, c.useEffect)(
                () => () => {
                  a.current && clearTimeout(a.current);
                },
                [],
              ));
            let s = (0, c.useCallback)((e) => {
                e && t.current && (eu(t.current, e), e.focus());
              }, []),
              o = (0, c.useCallback)((e) => {
                let r = e.target;
                r instanceof HTMLElement &&
                  "treeitem" === r.getAttribute("role") &&
                  t.current &&
                  eu(t.current, r);
              }, []);
            return (0, i.jsx)("div", {
              ref: t,
              role: "tree",
              "aria-label": "File tree",
              onFocus: o,
              onKeyDown: (e) => {
                let t = e.currentTarget,
                  n = e.target;
                if (!(n instanceof HTMLElement) || "treeitem" !== n.getAttribute("role")) {
                  return;
                }
                let i = ((e) =>
                    Array.from(e.querySelectorAll('[role="treeitem"]')).filter(
                      (t) =>
                        !((e, t) => {
                          let r = (e) => {
                            if (!e || e === t) {
                              return !1;
                            }
                            if ("group" === e.getAttribute("role")) {
                              let t = e.previousElementSibling;
                              if (t?.getAttribute("aria-expanded") === "false") {
                                return !0;
                              }
                            }
                            return r(e.parentElement);
                          };
                          return r(e.parentElement);
                        })(t, e),
                    ))(t),
                  o = i.indexOf(n),
                  l = null !== n.getAttribute("aria-expanded"),
                  d = "true" === n.getAttribute("aria-expanded");
                switch (e.key) {
                  case "ArrowDown":
                    (e.preventDefault(), s(i[o + 1]));
                    break;
                  case "ArrowUp":
                    (e.preventDefault(), s(i[o - 1]));
                    break;
                  case "ArrowRight":
                    (e.preventDefault(),
                      l &&
                        (d
                          ? s(
                              ((e) => {
                                let t = e.nextElementSibling;
                                return t?.getAttribute("role") === "group"
                                  ? t.querySelector('[role="treeitem"]')
                                  : null;
                              })(n),
                            )
                          : n.click()));
                    break;
                  case "ArrowLeft":
                    (e.preventDefault(),
                      l && d
                        ? n.click()
                        : s(
                            ((e, t) => {
                              let r = (e) => {
                                if (!e || e === t) {
                                  return null;
                                }
                                if ("group" === e.getAttribute("role")) {
                                  let t = e.previousElementSibling;
                                  if (
                                    t instanceof HTMLElement &&
                                    "treeitem" === t.getAttribute("role")
                                  ) {
                                    return t;
                                  }
                                }
                                return r(e.parentElement);
                              };
                              return r(e.parentElement);
                            })(n, t),
                          ));
                    break;
                  case "Home":
                    (e.preventDefault(), s(i[0]));
                    break;
                  case "End":
                    (e.preventDefault(), s(i[i.length - 1]));
                    break;
                  case " ":
                  case "Enter":
                    (e.preventDefault(), n.click());
                    break;
                  case "*":
                    (e.preventDefault(),
                      ((e, t) => {
                        let r = (e) =>
                          e && e !== t
                            ? "group" === e.getAttribute("role") ||
                              "tree" === e.getAttribute("role")
                              ? e
                              : r(e.parentElement)
                            : null;
                        return Array.from((r(e.parentElement) ?? t).children).flatMap((e) =>
                          [
                            e.querySelector(':scope > [role="treeitem"][aria-expanded]'),
                            e instanceof HTMLElement &&
                            "treeitem" === e.getAttribute("role") &&
                            e.hasAttribute("aria-expanded")
                              ? e
                              : null,
                          ].filter((e) => null !== e),
                        );
                      })(n, t).forEach((e) => {
                        "false" === e.getAttribute("aria-expanded") && e.click();
                      }));
                    break;
                  default:
                    if (1 === e.key.length && !e.ctrlKey && !e.metaKey && !e.altKey) {
                      (e.preventDefault(),
                        a.current && clearTimeout(a.current),
                        (r.current += e.key.toLowerCase()));
                      let t = r.current,
                        n = o + 1,
                        l = [...i.slice(n), ...i.slice(0, n)].find((e) => {
                          let r = ((e) => {
                            let t = e.querySelector("[title]");
                            return t?.textContent ?? e.textContent ?? null;
                          })(e);
                          return r?.toLowerCase().startsWith(t);
                        });
                      (l && s(l),
                        (a.current = setTimeout(() => {
                          r.current = "";
                        }, 500)));
                    }
                }
              },
              className: (0, h.cn)(u.x.Tree),
              children: (0, i.jsx)(ec, { level: 1, parentId: null, children: e }),
            });
          },
          {
            File: ({ name: e }) => {
              let { level: t } = ed();
              return (0, i.jsxs)("div", {
                role: "treeitem",
                "aria-level": t,
                "aria-selected": !1,
                tabIndex: -1,
                className: (0, h.cn)(
                  "py-1 pr-1.5 -outline-offset-1 pl-[calc(var(--padding-left)*1px)] flex items-center gap-1.5 cursor-default hover:bg-neutral-100 rounded-lg dark:hover:bg-neutral-900 text-gray-700 dark:text-gray-400",
                  u.x.TreeFile,
                ),
                style: { "--padding-left": ep(t) },
                children: [
                  (0, i.jsx)(O.oS, {
                    className: "shrink-0 select-none size-4",
                    "aria-hidden": "true",
                    "data-component-part": "tree-file-icon",
                  }),
                  (0, i.jsx)("span", {
                    className: "truncate text-sm font-medium leading-5 -tracking-[0.1px]",
                    "data-component-part": "tree-file-title",
                    title: e,
                    children: e,
                  }),
                ],
              });
            },
            Folder: function ({ name: e, defaultOpen: t = !1, children: r, openable: a = !0 }) {
              let n = (0, c.useId)(),
                s = `tree-folder-${n}`,
                o = `tree-group-${n}`,
                l = a && !!r,
                { level: d } = ed(),
                [p, m] = (0, c.useState)(l && t),
                x = l && p ? O.m8 : O.CA;
              return (0, i.jsxs)("div", {
                role: "none",
                style: { "--padding-left": ep(d) },
                children: [
                  (0, i.jsxs)("div", {
                    id: s,
                    role: "treeitem",
                    "aria-level": d,
                    "aria-expanded": l ? p : void 0,
                    "aria-selected": !1,
                    "aria-owns": l && p ? o : void 0,
                    tabIndex: -1,
                    onClick: l ? () => m((e) => !e) : void 0,
                    className: (0, h.cn)(
                      "py-1 pr-1.5 -outline-offset-1 pl-[calc(var(--padding-left)*1px)] flex items-center gap-1.5 hover:bg-neutral-100 rounded-lg dark:hover:bg-neutral-900 text-gray-700 dark:text-gray-400",
                      l ? "cursor-pointer" : "cursor-default",
                      u.x.TreeFolder,
                    ),
                    children: [
                      (0, i.jsx)(x, {
                        className: "shrink-0 select-none size-4",
                        "aria-hidden": "true",
                        "data-component-part":
                          l && p ? "tree-folder-icon-open" : "tree-folder-icon-closed",
                      }),
                      (0, i.jsx)("span", {
                        className: "truncate text-sm font-medium leading-5 -tracking-[0.1px]",
                        "data-component-part": "tree-folder-title",
                        title: e,
                        children: e,
                      }),
                    ],
                  }),
                  l &&
                    p &&
                    (0, i.jsxs)("div", {
                      id: o,
                      role: "group",
                      className: "relative",
                      "data-component-part": "tree-folder-children-wrapper",
                      children: [
                        (0, i.jsx)("div", {
                          "aria-hidden": "true",
                          className:
                            "select-none absolute w-px h-full bg-neutral-200 dark:bg-neutral-800 left-[calc((var(--padding-left)+8)*1px)] z-10",
                          "data-component-part": "tree-folder-children-line",
                        }),
                        (0, i.jsx)(ec, { level: d + 1, parentId: s, children: r }),
                      ],
                    }),
                ],
              });
            },
          },
        ),
        eh = (0, c.forwardRef)(
          ({ children: e, label: t, id: r, description: a, tags: n, className: s, ...o }, l) => {
            let [d, p] = (0, Q.O)(),
              m = (0, y.n)(),
              [f, b] = (0, c.useState)(null),
              [v] = (0, Y.y)(b),
              j = (0, ee.T)(f),
              k = n?.map((e) => e.trim()).filter(Boolean),
              w = !!d;
            (0, c.useEffect)(() => {
              if (w) {
                return (
                  void 0 !== j && p({ type: "register_heading", payload: { id: r, top: j } }),
                  () => {
                    p({ type: "unregister_heading", payload: r });
                  }
                );
              }
            }, [j, r, w, p]);
            let N = (0, c.useCallback)(() => {
              ((0, x.l)(`https://${window.location.host}${window.location.pathname}#${r}`),
                (window.location.hash = r),
                (0, g.h)({ id: r }));
            }, [r]);
            return (0, c.useMemo)(() => {
              if (!d.changelogFilters.length) {
                return !0;
              }
              let e = d.changelogFilters.filter((e) => e.active);
              return 0 === e.length || k?.some((t) => e.some((e) => e.tag === t));
            }, [d.changelogFilters, k])
              ? (0, i.jsxs)("div", {
                  className: (0, h.cn)(
                    u.x.Update,
                    "flex flex-col relative items-start w-full lg:flex-row gap-2 lg:gap-6 py-8 update-container",
                    s,
                  ),
                  ref: l,
                  id: r,
                  ...o,
                  children: [
                    (0, i.jsxs)("div", {
                      className:
                        "lg:sticky top-[var(--scroll-mt)] group flex flex-col w-full lg:w-[160px] items-start flex-shrink-0 justify-start",
                      children: [
                        (0, i.jsx)("div", {
                          className: "absolute",
                          children: (0, i.jsxs)("a", {
                            href: `#${r}`,
                            className:
                              "-ml-10 flex items-center opacity-0 border-0 group-hover:opacity-100 focus:opacity-100 focus:outline-0 group/link",
                            "aria-label": m["aria.navigateToChangelog"],
                            children: [
                              "​",
                              (0, i.jsx)("div", {
                                className:
                                  "w-6 h-6 rounded-md flex items-center justify-center shadow-sm text-gray-400 dark:text-white/50 dark:bg-background-dark dark:brightness-[1.35] dark:ring-1 dark:hover:brightness-150 bg-white ring-1 ring-gray-400/30 dark:ring-gray-700/25 hover:ring-gray-400/60 dark:hover:ring-white/20 group-focus/link:border-2 group-focus/link:border-primary dark:group-focus/link:border-primary-light",
                                children: (0, i.jsx)(O.qY, {}),
                              }),
                            ],
                          }),
                        }),
                        (0, i.jsx)("div", {
                          className:
                            "cursor-pointer px-2 py-1 rounded-lg text-sm flex items-center flex-grow-0 justify-center font-medium bg-primary/10 text-primary dark:text-primary-light",
                          onClick: N,
                          contentEditable: !1,
                          "data-component-part": "update-label",
                          children: t,
                        }),
                        !!k?.length &&
                          (0, i.jsx)("div", {
                            className:
                              "px-1 flex flex-wrap gap-2 text-secondary dark:text-secondary-light mt-3 text-sm",
                            "data-component-part": "update-tag-list",
                            children: k.map((e) =>
                              (0, i.jsx)(
                                "span",
                                {
                                  className: "inline-block rounded-lg text-sm font-medium",
                                  "data-component-part": "update-tag",
                                  children: e,
                                },
                                e,
                              ),
                            ),
                          }),
                        a &&
                          (0, i.jsx)("div", {
                            className:
                              "px-1 text-secondary dark:text-secondary-light mt-3 text-sm max-w-[160px] break-words",
                            contentEditable: !1,
                            "data-component-part": "update-description",
                            children: a,
                          }),
                      ],
                    }),
                    (0, i.jsx)("div", {
                      className: "flex-1 overflow-hidden px-0.5 max-w-full",
                      ref: v,
                      children: (0, i.jsx)("div", {
                        className: "prose-sm",
                        "data-component-part": "update-content",
                        children: e,
                      }),
                    }),
                  ],
                })
              : null;
          },
        );
      eh.displayName = "Update";
      let ex = (0, c.forwardRef)(({ children: e, title: t, className: r, ...a }, n) => {
        let [{ multiViewItems: s }] = (0, Q.O)(),
          [o, l] = (0, c.useState)(!1);
        (0, c.useLayoutEffect)(() => {
          l(!0);
        }, []);
        let d = s.find((e) => e.title === t)?.active;
        return o && d
          ? (0, i.jsx)("div", {
              className: (0, h.cn)(u.x.MultiViewItem, "prose dark:prose-dark", r),
              ref: n,
              ...a,
              children: e,
            })
          : null;
      });
      ex.displayName = "View";
      var eg = r(46540);
      let ef = (0, U.default)(
        () =>
          Promise.all([r.e(17043), r.e(77401), r.e(19615), r.e(5823)])
            .then(r.bind(r, 5823))
            .then((e) => e.CustomCode),
        { loadableGenerated: { webpack: () => [5823] }, ssr: !1 },
      );
      var ey = r(7603),
        eb = r(84487);
      let ev =
          "px-2 py-1 flex items-center gap-1 justify-center rounded-lg border cursor-pointer transition-colors duration-70 outline-offset-4 text-xs/[16px] whitespace-nowrap font-medium",
        ej = {
          Accordion: function ({
            title: e,
            description: t,
            defaultOpen: r = !1,
            icon: a,
            iconType: n,
            children: s,
            _disabled: o,
          }) {
            let l = (0, p.p)("docs.accordion.open"),
              d = (0, p.p)("docs.accordion.close"),
              c =
                "string" == typeof a
                  ? (0, i.jsx)(m.ComponentIcon, { icon: a, iconType: n, className: "w-4 h-4" })
                  : a;
            return (0, i.jsx)(j, {
              title: e,
              description: t,
              defaultOpen: !0 === r || ("string" == typeof r && "true" === r),
              onChange: (t) => {
                let r = "string" == typeof e ? e : void 0;
                t ? l({ title: r }).catch(console.error) : d({ title: r }).catch(console.error);
              },
              icon: c,
              _disabled: o,
              children: s,
            });
          },
          AccordionGroup: function ({ children: e }) {
            return (0, i.jsx)("div", {
              className: (0, h.cn)(
                u.x.AccordionGroup,
                "[&>details]:border-0 [&>details]:rounded-none [&>details>summary]:rounded-none [&>details]:mb-0 overflow-hidden mt-0 mb-3 rounded-xl prose prose-gray dark:prose-invert divide-y divide-inherit border dark:border-gray-800/50",
              ),
              children: e,
            });
          },
          Badge: N,
          Heading: W.D,
          Callout: function ({ children: e, icon: t, iconType: r, color: a }) {
            let n = {},
              s = {};
            if (a) {
              let e = S()(a),
                t = e.isDark(),
                r = t ? e.lighten(0.5) : e.darken(0.5),
                i = e.lighten(0.5),
                o = e.darken(0.5);
              (console.log(r.hex()),
                (n = {
                  borderColor: `${a}33`,
                  backgroundColor: `${a}1a`,
                  "--callout-border-color": `${a}${t ? "66" : "4d"}`,
                  "--callout-bg-color": `${a}${t ? "4d" : "1a"}`,
                }),
                (s = {
                  "--callout-text-color": `${o.hex()}`,
                  "--dark-callout-text-color": `${i.hex()}`,
                }));
            }
            return (0, i.jsx)($, {
              calloutType: "callout",
              icon: t,
              iconType: r,
              color: a,
              className: a
                ? "border bg-transparent dark:border-[var(--callout-border-color,#71717a4d)] dark:bg-[var(--callout-bg-color,#7171711a)]"
                : "border border-zinc-500/20 bg-zinc-50/50 dark:border-zinc-500/30 dark:bg-zinc-500/10",
              childrenClassName: a
                ? "text-[var(--callout-text-color)] dark:text-[var(--dark-callout-text-color)]"
                : "text-zinc-900 dark:text-zinc-200",
              customStyle: n,
              customTextStyle: s,
              children: e,
            });
          },
          Card: function ({
            title: e,
            icon: t,
            iconType: r,
            color: a,
            horizontal: n,
            href: s,
            img: o,
            children: l,
            disabled: d,
            cta: p,
            arrow: u,
          }) {
            let x =
              "string" == typeof t
                ? (0, i.jsx)(m.ComponentIcon, {
                    icon: t,
                    iconType: r,
                    color: a,
                    className: "h-6 w-6 bg-primary dark:bg-primary-light !m-0 shrink-0",
                    overrideColor: !0,
                  })
                : t;
            d && (s = void 0);
            let g = {
                className: (0, h.cn)(s && "hover:!border-primary dark:hover:!border-primary-light"),
                title: e,
                icon: x,
                img: o,
                horizontal: n,
                href: s,
                children: l,
                cta: p,
                arrow: u,
                disabled: d,
              },
              f = (0, c.forwardRef)((e, t) => (0, i.jsx)(A, { ...e, mRef: t }));
            return ((f.displayName = "RefCard"), s && (s.startsWith("/") || s.startsWith("#")))
              ? (0, i.jsx)(f, { ...g })
              : (0, i.jsx)(A, { ...g });
          },
          CardGroup: P,
          Columns: function ({ children: e, ...t }) {
            return (0, i.jsx)(P, { ...t, children: e });
          },
          Color: B,
          Check: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "check",
              icon: (0, i.jsx)(O.Sr, {}),
              iconType: void 0,
              className:
                "border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-600/20",
              childrenClassName: "text-green-800 dark:text-green-300",
              children: e,
            });
          },
          CodeGroup: _.l,
          CodeBlock: I.N,
          CustomCode: ef,
          CustomComponent: H.default,
          DynamicCustomComponent: z,
          Expandable: V.V,
          Frame: function ({
            as: e = "div",
            caption: t,
            style: r,
            className: a,
            containerClassName: n,
            children: s,
            hint: o,
          }) {
            let l = c.Children.map(s, (e) => {
              if ((0, c.isValidElement)(e) && "string" == typeof e.type && "video" === e.type) {
                let t = e.props;
                if (t.autoPlay) {
                  return c.cloneElement(e, { ...t, playsInline: !0, loop: !0, muted: !0 });
                }
              }
              return e;
            });
            return (0, i.jsxs)("div", {
              className: n,
              children: [
                void 0 !== o &&
                  (0, i.jsxs)("div", {
                    className: "not-prose mb-4 flex items-center space-x-2",
                    children: [
                      (0, i.jsx)("svg", {
                        xmlns: "http://www.w3.org/2000/svg",
                        viewBox: "0 0 512 512",
                        className: "flex-none w-4 h-4 fill-gray-400 dark:fill-gray-300",
                        children: (0, i.jsx)("path", {
                          d: "M224 320c0 17.69 14.33 32 32 32h64c17.67 0 32-14.31 32-32s-14.33-32-32-32h-64C238.3 288 224 302.3 224 320zM267.6 256H352c17.67 0 32-14.31 32-32s-14.33-32-32-32h-80v40C272 240.5 270.3 248.5 267.6 256zM272 160H480c17.67 0 32-14.31 32-32s-14.33-32-32-32h-208.8C271.5 98.66 272 101.3 272 104V160zM320 416c0-17.69-14.33-32-32-32H224c-17.67 0-32 14.31-32 32s14.33 32 32 32h64C305.7 448 320 433.7 320 416zM202.1 355.8C196 345.6 192 333.3 192 320c0-5.766 1.08-11.24 2.51-16.55C157.4 300.6 128 269.9 128 232V159.1C128 151.2 135.2 144 143.1 144S160 151.2 159.1 159.1l0 69.72C159.1 245.2 171.3 271.1 200 271.1C222.1 271.1 240 254.1 240 232v-128C240 81.91 222.1 64 200 64H136.6C103.5 64 72.03 80 52.47 106.8L26.02 143.2C9.107 166.5 0 194.5 0 223.3V312C0 387.1 60.89 448 136 448h32.88C163.4 438.6 160 427.7 160 416C160 388.1 178 364.6 202.1 355.8z",
                        }),
                      }),
                      (0, i.jsx)("p", {
                        className: "text-gray-700 text-sm font-medium dark:text-gray-200",
                        children: o,
                      }),
                    ],
                  }),
                (0, i.jsxs)(e, {
                  style: r,
                  "data-name": "frame",
                  className: (0, h.cn)(
                    u.x.Frame,
                    "p-2 not-prose relative bg-gray-50/50 rounded-2xl overflow-hidden dark:bg-gray-800/25",
                  ),
                  children: [
                    (0, i.jsx)("div", {
                      style: { backgroundPosition: "10px 10px" },
                      className:
                        "absolute inset-0 bg-grid-neutral-200/20 [mask-image:linear-gradient(0deg,#fff,rgba(255,255,255,0.6))] dark:bg-grid-white/5 dark:[mask-image:linear-gradient(0deg,rgba(255,255,255,0.1),rgba(255,255,255,0.5))]",
                    }),
                    (0, i.jsx)("div", {
                      className: (0, h.cn)(
                        "relative rounded-xl overflow-hidden flex justify-center",
                        a,
                      ),
                      children: l,
                    }),
                    t &&
                      (0, i.jsx)("div", {
                        className: (0, h.cn)(
                          "relative rounded-2xl text-center mt-3 pt-0 px-8 pb-2 text-sm text-gray-700 dark:text-gray-400 [&_p]:m-0 [&_a]:font-semibold [&_a]:no-underline [&_a]:border-b [&_a]:border-primary [&_a:hover]:border-b-2 dark:[&_a]:text-white dark:[&_a]:border-primary-light",
                          a,
                        ),
                        contentEditable: !1,
                        "data-component-part": "frame-caption",
                        children: (0, i.jsx)(K.o, { children: t }),
                      }),
                    (0, i.jsx)("div", {
                      className: (0, h.cn)(
                        "absolute inset-0 pointer-events-none border border-black/5 rounded-2xl dark:border-white/5",
                      ),
                    }),
                  ],
                }),
              ],
            });
          },
          Tile: ({ href: e, children: t, title: r, description: a, className: n }) => {
            let s = (0, h.cn)(
              "bg-repeat-round bg-center [grid-area:1/1] size-full pointer-events-none select-none",
              "bg-[size:24px_24px]",
              "after:content-[''] after:left-0 after:absolute after:h-full after:w-[7px] dark:after:bg-gray-900 after:bg-gray-50",
              "before:content-[''] before:right-0 before:absolute before:h-full before:w-[7px] dark:before:bg-gray-900 before:bg-gray-50",
            );
            return (0, i.jsxs)(L.DynamicLink, {
              href: e,
              className: (0, h.cn)(
                u.x.Tile,
                "flex items-center justify-center flex-col w-full min-w-0 gap-1 group cursor-pointer not-prose",
                n,
              ),
              children: [
                (0, i.jsxs)("div", {
                  className:
                    "h-[170px] w-full relative bg-gray-50 dark:bg-gray-900 rounded-2xl py-1 grid place-items-center overflow-hidden",
                  "data-component-part": "tile-children-container",
                  children: [
                    (0, i.jsx)("div", {
                      "aria-hidden": "true",
                      className: (0, h.cn)(s, "block dark:hidden"),
                      style: { backgroundImage: `url("${ei}")` },
                      "data-component-part": "tile-background-light",
                    }),
                    (0, i.jsx)("div", {
                      "aria-hidden": "true",
                      className: (0, h.cn)(s, "hidden dark:block"),
                      style: { backgroundImage: `url("${eo}")` },
                      "data-component-part": "tile-background-dark",
                    }),
                    (0, i.jsx)("div", {
                      className:
                        "size-full flex items-center justify-center p-8 [grid-area:1/1] [&_svg]:max-w-full [&_svg]:max-h-full [&_svg]:w-auto [&_svg]:h-auto",
                      "data-component-part": "tile-children-inner-container",
                      children: t,
                    }),
                  ],
                }),
                (!!r || !!a) &&
                  (0, i.jsxs)("div", {
                    className: "flex flex-col gap-1 p-2 items-center justify-center w-full min-w-0",
                    "data-component-part": "tile-text-container",
                    children: [
                      !!r &&
                        (0, i.jsx)("p", {
                          className:
                            "text-base font-medium [letter-spacing:-0.2px] text-gray-900 dark:text-gray-200 m-0 truncate max-w-full",
                          title: r,
                          "data-component-part": "tile-title",
                          children: r,
                        }),
                      !!a &&
                        (0, i.jsx)("p", {
                          className:
                            "text-sm [letter-spacing:-0.1px] text-gray-600 dark:text-gray-400 truncate m-0 font-normal max-w-full",
                          title: a,
                          "data-component-part": "tile-description",
                          children: a,
                        }),
                    ],
                  }),
              ],
            });
          },
          Tree: em,
          Info: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "info",
              icon: (0, i.jsx)(O.mo, {}),
              iconType: void 0,
              className:
                "border border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-white/10",
              childrenClassName: "text-neutral-800 dark:text-neutral-300",
              children: e,
            });
          },
          Icon: function ({ icon: e, iconType: t, color: r, size: a, className: n }) {
            return (0, i.jsx)(m.ComponentIcon, {
              icon: e,
              iconType: t,
              color: r,
              style: {
                width: a || 16,
                height: a || 16,
                display: "inline-block",
                verticalAlign: "middle",
              },
              className: (0, h.cn)(u.x.Icon, "inline", !r && "bg-primary dark:bg-primary-light", n),
            });
          },
          Link: s(),
          Note: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "note",
              icon: (0, i.jsx)(O.Qv, {}),
              iconType: void 0,
              className:
                "border border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-600/20",
              childrenClassName: "text-blue-800 dark:text-blue-300",
              children: e,
            });
          },
          ParamField: X.sG,
          RequestExample: function ({ dropdown: e, children: t }) {
            return (0, i.jsx)("div", {
              className: "block xl:hidden mt-8",
              id: Z.V.RequestExample,
              children: (0, i.jsx)(_.l, {
                isSmallText: !0,
                noMargins: !0,
                dropdown: e,
                hideCodeSnippetFeedbackButton: !0,
                children: t,
              }),
            });
          },
          ResponseExample: function ({ children: e, dropdown: t }) {
            return (0, i.jsx)("div", {
              className: "block xl:hidden mt-8",
              id: Z.V.ResponseExample,
              children: (0, i.jsx)(_.l, {
                isSmallText: !0,
                noMargins: !0,
                dropdown: t,
                hideCodeSnippetFeedbackButton: !0,
                children: e,
              }),
            });
          },
          ResponseField: function ({
            name: e,
            type: t,
            hidden: r,
            default: a,
            required: n,
            deprecated: s,
            children: o,
            id: l,
            pre: d,
            post: c,
          }) {
            return (0, i.jsx)(X.t1, {
              name: e,
              type: t,
              hidden: r,
              defaultValue: a,
              required: n,
              deprecated: s,
              id: l,
              pre: d,
              post: c,
              children: o,
            });
          },
          Step: er,
          Steps: ({ children: e, titleSize: t }) =>
            (0, i.jsx)(i.Fragment, {
              children: (0, i.jsx)("div", {
                role: "list",
                className: (0, h.cn)(u.x.Steps, "ml-3.5 mt-10 mb-6"),
                children: Array.isArray(e)
                  ? e.map(({ props: r }, a) =>
                      (0, i.jsx)(
                        er,
                        {
                          ...r,
                          stepNumber: r.stepNumber ?? a + 1,
                          ...(t && { titleSize: t }),
                          isLast: a === e.length - 1,
                        },
                        `${r.title} + ${a}`,
                      ),
                    )
                  : e,
              }),
            }),
          Tab: en.o,
          Table: ea.X,
          Tabs: en.t,
          Tip: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "tip",
              icon: (0, i.jsx)(O.V5, {}),
              iconType: void 0,
              className:
                "border border-green-200 bg-green-50 dark:border-green-900 dark:bg-green-600/20 [&_[data-component-part='callout-icon']]:mt-px",
              childrenClassName: "text-green-800 dark:text-green-300",
              children: e,
            });
          },
          Tooltip: D,
          SnippetGroup: _.P,
          Warning: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "warning",
              icon: (0, i.jsx)(O.id, {}),
              iconType: void 0,
              className:
                "border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-600/20 [&_[data-component-part='callout-icon']]:mt-px",
              childrenClassName: "text-yellow-800 dark:text-yellow-300",
              children: e,
            });
          },
          Latex: function ({ children: e }) {
            return (0, i.jsx)("span", {
              className: "latex-style inline text-inherit p-0",
              children: e,
            });
          },
          ZoomImage: eg.T,
          OptimizedFrame: ey.j,
          OptimizedImage: J.p,
          Mermaid: G,
          Update: eh,
          Panel: function ({ children: e }) {
            return (0, i.jsx)("div", { className: "block xl:hidden", id: Z.V.Panel, children: e });
          },
          Danger: function ({ children: e }) {
            return (0, i.jsx)($, {
              calloutType: "danger",
              icon: (0, i.jsx)(O.x$, {}),
              iconType: void 0,
              className: "border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-600/20",
              childrenClassName: "text-red-800 dark:text-red-300",
              children: e,
            });
          },
          Prompt: ({
            description: e,
            children: t,
            actions: r = ["copy"],
            icon: a,
            iconType: n,
            className: s,
          }) => {
            let o = (0, y.n)(),
              [l, d] = (0, c.useState)(!1),
              p = (0, c.useRef)(void 0);
            (0, c.useEffect)(() => () => clearTimeout(p.current), []);
            let g = async () => {
                "success" === (await (0, x.l)(t)) &&
                  (d(!0), clearTimeout(p.current), (p.current = setTimeout(() => d(!1), 2e3)));
              },
              f = `https://cursor.com/link/prompt?text=${encodeURIComponent(t)}`,
              b =
                "string" == typeof a
                  ? (0, i.jsx)(m.ComponentIcon, {
                      className: "!m-0 size-3.5 shrink-0",
                      icon: a,
                      iconType: n,
                    })
                  : a;
            return (0, i.jsxs)("div", {
              className: (0, h.cn)(
                u.x.Prompt,
                "my-6 flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border p-4",
                "border-stone-100 bg-stone-50 dark:border-stone-800 dark:bg-stone-900",
                "text-sm/[20px] text-stone-900 tracking-[-0.1px] dark:text-stone-50",
                s,
              ),
              children: [
                (0, i.jsxs)("div", {
                  className: "not-prose flex min-w-0 items-start gap-2",
                  "data-component-part": "prompt-content-wrapper",
                  children: [
                    !!b &&
                      (0, i.jsx)("span", {
                        "aria-hidden": "true",
                        className: "flex h-[1lh] shrink-0 select-none items-center justify-center",
                        "data-component-part": "prompt-icon",
                        children: b,
                      }),
                    (0, i.jsx)(eb.jH, {
                      mode: "static",
                      className: "min-w-0",
                      "data-component-part": "prompt-description",
                      components: { badge: (e) => (0, i.jsx)(N, { ...e }) },
                      rehypePlugins: [
                        ...(eb.XX.raw ? [eb.XX.raw] : []),
                        ...(eb.XX.katex ? [eb.XX.katex] : []),
                      ],
                      children: e,
                    }),
                  ],
                }),
                (0, i.jsx)("div", {
                  className: "ml-auto flex shrink-0 items-center gap-1.5",
                  "data-component-part": "prompt-actions-wrapper",
                  children: [...new Set(r)].map((e, t) => {
                    switch (e) {
                      case "copy":
                        return (0, i.jsx)(
                          "button",
                          {
                            className: (0, h.cn)(
                              ev,
                              "border-transparent bg-primary text-white hover:bg-primary-dark",
                            ),
                            "data-component-part": "prompt-action-copy-button",
                            onClick: g,
                            type: "button",
                            children: (0, i.jsxs)("span", {
                              "aria-live": "polite",
                              className:
                                "grid [&>*]:col-start-1 [&>*]:row-start-1 [&>*]:flex [&>*]:items-center [&>*]:justify-center [&>*]:gap-1",
                              children: [
                                (0, i.jsxs)("span", {
                                  "aria-hidden": !l,
                                  className: (0, h.cn)(!l && "invisible"),
                                  children: [
                                    (0, i.jsx)(O.Sr, {
                                      "aria-hidden": "true",
                                      className: "size-2.5 shrink-0 text-white dark:text-white",
                                    }),
                                    o.copied,
                                  ],
                                }),
                                (0, i.jsx)("span", {
                                  "aria-hidden": l,
                                  className: (0, h.cn)(l && "invisible"),
                                  children: o["prompt.copyPrompt"],
                                }),
                              ],
                            }),
                          },
                          t,
                        );
                      case "cursor":
                        return (0, i.jsxs)(
                          "a",
                          {
                            className: (0, h.cn)(
                              ev,
                              "no-underline",
                              "text-stone-900 dark:text-stone-50",
                              "bg-white hover:bg-stone-100 dark:bg-black hover:dark:bg-black/20",
                              "border-stone-200 dark:border-stone-700",
                            ),
                            "data-component-part": "prompt-action-cursor-button",
                            href: f,
                            rel: "noopener noreferrer",
                            target: "_blank",
                            children: [
                              (0, i.jsx)(O.oA, {
                                "aria-hidden": "true",
                                className: "size-3 shrink-0 select-none",
                              }),
                              o["prompt.openInCursor"],
                            ],
                          },
                          t,
                        );
                      default:
                        return null;
                    }
                  }),
                }),
              ],
            });
          },
          Popup: a.zD,
          PopupContent: a.g0,
          PopupTrigger: a.J1,
          View: ex,
        };
    },
    12145: (e, t, r) => {
      "use strict";
      r.d(t, { _: () => eY });
      var a = r(54568),
        n = r(7620),
        s = r(59705),
        i = r(1612),
        o = r(26859),
        l = r(16530),
        d = r(16816);
      let c = ({ data: e }) => {
        let t = e.attributes?.some((e) => "dropdown" === e.name && "false" !== e.value);
        return (0, a.jsx)(l.l, {
          isSmallText: !0,
          noMargins: !0,
          dropdown: t,
          children: e.children?.map((e, t) => {
            let r = (0, i.Ay)(e.html ?? ""),
              n =
                "object" != typeof r || Array.isArray(r) || "pre" !== r.type
                  ? void 0
                  : (r.props.language ?? (0, d.G4)(r.props.className, e.filename));
            return (0, a.jsx)(
              o.N,
              { language: n, filename: e.filename, children: (0, a.jsx)("span", { children: r }) },
              (e.filename ?? "") + t,
            );
          }),
        });
      };
      var p = r(41363);
      let u = (0, n.createContext)(void 0),
        m = () => {
          let e = (0, n.useContext)(u);
          if (void 0 === e) {
            throw Error(
              "useCodeExampleLabel must be used within a CodeExampleLabelContext.Provider",
            );
          }
          return e;
        };
      var h = r(30793),
        x = r(6482),
        g = r(6723),
        f = r(12158),
        y = r(81325),
        b = r(37914);
      let v = ["bash", "python", "javascript", "php", "go", "java", "ruby"];
      var j = r(54923),
        k = r(53812),
        w = r(5693),
        N = r(22300),
        C = r.n(N),
        S = r(19295),
        O = r.n(S),
        $ = r(16903);
      let T = (e, t = new Set()) => (
          "required" in e && Array.isArray(e.required) && e.required.forEach((e) => t.add(e)),
          "items" in e && e.items && (0, $.Fy)(e.items) && T(e.items, t),
          "properties" in e &&
            e.properties &&
            Object.values(e.properties).forEach((e) => {
              T(e, t);
            }),
          "additionalProperties" in e &&
            (0, $.Fy)(e.additionalProperties) &&
            T(e.additionalProperties, t),
          "oneOf" in e &&
            Array.isArray(e.oneOf) &&
            e.oneOf.forEach((e) => {
              (0, $.Fy)(e) && T(e, t);
            }),
          [...t]
        ),
        E = {
          headers: [],
          method: "GET",
          url: "",
          httpVersion: "HTTP/1.1",
          queryString: [],
          headersSize: -1,
          cookies: [],
          bodySize: -1,
        };
      var A = r(49897);
      let P = (e) => {
          switch (e.type) {
            case "http":
              return "basic" === e.scheme ? "Basic <encoded-value>" : "Bearer <token>";
            case "oauth2":
              return "Bearer <token>";
            default:
              return "<api-key>";
          }
        },
        I = (e, t = "", r = []) => {
          if (
            ("format" in e &&
              ("binary" === e.format || "base64" === e.format) &&
              t &&
              !r.includes(t) &&
              r.push(t),
            "items" in e && e.items)
          ) {
            let a = t ? `${t}.items` : "items";
            (0, $.Fy)(e.items) && I(e.items, a, r);
          }
          if (
            ("properties" in e &&
              e.properties &&
              Object.entries(e.properties).forEach(([e, a]) => {
                I(a, t ? `${t}.${e}` : e, r);
              }),
            "additionalProperties" in e && (0, $.Fy)(e.additionalProperties))
          ) {
            let a = t ? `${t}.additionalProperties` : "additionalProperties";
            I(e.additionalProperties, a, r);
          }
          return (
            "oneOf" in e &&
              Array.isArray(e.oneOf) &&
              e.oneOf.forEach((e, a) => {
                (0, $.Fy)(e) && I(e, t ? `${t}.${a}` : `${a}`, r);
              }),
            r
          );
        },
        _ = ({
          exampleData: e,
          apiReferenceData: t,
          baseUrl: r,
          inputs: a,
          selectedBodyContentType: n,
          requiredOnly: s,
          selectedSecurityOptionIndex: i,
          exampleType: o,
        }) => {
          let l,
            d,
            c = t.dependencies?.processedSecurityOptions?.[i],
            p = (({ inputs: e, queryParamsWithDeepObjects: t, securityOption: r }) => {
              let a = Object.entries(e.query).flatMap(([e, r]) =>
                null == r
                  ? []
                  : Array.isArray(r)
                    ? r.filter((e) => null != e).map((t) => ({ name: e, value: t.toString() }))
                    : "object" == typeof r
                      ? t?.includes(e)
                        ? Object.entries(r)
                            .filter(([e, t]) => null != t)
                            .map(([t, r]) => ({ name: `${e}[${t}]`, value: r.toString() }))
                        : [{ name: e, value: JSON.stringify(r) }]
                      : [{ name: e, value: r.toString() }],
              );
              return (
                r &&
                  r.schemes.forEach(({ scheme: t, name: r }) => {
                    if ("in" in t && "query" === t.in) {
                      let n = "name" in t ? t.name : r;
                      n in e.query
                        ? a.filter((e) => e.name == n && "" === e.value)
                        : a.push({ name: n, value: "" });
                    }
                  }),
                a
              );
            })({
              inputs: a,
              queryParamsWithDeepObjects: Object.values(t.dependencies?.parameters ?? {})
                .filter((e) => "deepObject" === e.style)
                .map((e) => e.name),
              securityOption: c,
            }),
            u = (0, A.rV)(t.operation?.path ?? "", a.path),
            m = (({
              apiReferenceData: e,
              headerInputs: t,
              selectedBodyContentType: r,
              securityOption: a,
            }) => {
              let n = [],
                s = new Set(),
                i = Object.values(e.dependencies?.parameters ?? {}).filter(
                  (e) => !e.in || "header" === e.in,
                ),
                o = new Set(i.map((e) => e.name)),
                l = i.filter((e) => e.schema?.isRequired);
              return (
                Object.entries(t)
                  .filter((e) => null != e[1])
                  .filter(([e]) => o.has(e))
                  .forEach(([e, t]) => {
                    (s.add(e), n.push({ name: e, value: t.toString() }));
                  }),
                l.forEach((e) => {
                  let t = e.name;
                  s.has(t) || n.push({ name: t, value: `<${t.toLowerCase()}>` });
                }),
                a &&
                  a.schemes.forEach(({ scheme: e, name: r }) => {
                    let a =
                      ("in" in e && "header" === e.in) || "http" === e.type || "oauth2" === e.type;
                    if ((0, $.Zt)(e)) {
                      let a = t[r]?.username,
                        s = t[r]?.password;
                      if (a || s) {
                        let e = (0, $.lq)(a, s);
                        n.push({ name: r, value: `Basic ${e}` });
                      } else {
                        n.push({ name: r, value: P(e) });
                      }
                    } else {
                      a &&
                        (r in t && "string" == typeof t[r]
                          ? n.push({ name: r, value: t[r].toString() })
                          : n.push({ name: r, value: P(e) }));
                    }
                  }),
                r &&
                  ((e, t) => {
                    e.some(({ name: e }) => "content-type" === e.toLowerCase()) ||
                      e.push({ name: "Content-Type", value: t });
                  })(n, r),
                n
              );
            })({
              apiReferenceData: t,
              headerInputs: a.header,
              selectedBodyContentType: n,
              securityOption: c,
            }),
            h = (({ securityOption: e, inputs: t }) => {
              if (!e) {
                return [];
              }
              let r = [];
              return (
                e.schemes.forEach(({ scheme: e, name: a }) => {
                  if ("in" in e && "cookie" === e.in) {
                    let n = "name" in e ? e.name : a;
                    t.cookie[n] && "string" == typeof t.cookie[n]
                      ? r.push({ name: n, value: t.cookie[n] })
                      : r.push({ name: n, value: "" });
                  }
                }),
                r
              );
            })({ securityOption: c, inputs: a }),
            x = q(a.body),
            g = (0, w.Gv)(e),
            f = Array.isArray(e),
            y = Array.isArray(a.body),
            b = (0, w.Gv)(a.body)
              ? (function e(t) {
                  let r = C()(t);
                  for (let t in r) {
                    void 0 === r[t] ? delete r[t] : (0, w.Gv)(r[t]) && e(r[t]);
                  }
                  return r;
                })(a.body)
              : y
                ? a.body
                : (a.body ?? {});
          ((l = x
            ? e
            : f && y
              ? b
              : g && (0, w.Gv)(b)
                ? "examples" === o
                  ? b
                  : O()(C()(e), b)
                : b),
            n &&
              (0, $.Fy)(t.dependencies?.requestBody?.content[n]?.schema) &&
              (d = t.dependencies.requestBody.content[n].schema));
          let v = s && d ? T(d) : void 0,
            j =
              s && (0, w.Gv)(a.body)
                ? Object.entries(a.body)
                    .filter(([, e]) => void 0 !== e)
                    .map(([e]) => e)
                : void 0,
            k = ((e, t, r, a, n) => {
              if (void 0 !== e) {
                if (
                  ("object" == typeof e &&
                    null !== e &&
                    !Array.isArray(e) &&
                    r &&
                    r.length > 0 &&
                    (e = Object.fromEntries(
                      Object.entries(e).filter(([e]) => r.includes(e) || n?.includes(e)),
                    )),
                  "multipart/form-data" === t || "application/x-www-form-urlencoded" === t)
                ) {
                  if (!e || "object" != typeof e) {
                    return;
                  }
                  "object" == typeof e &&
                    a &&
                    a.length > 0 &&
                    (0, w.Gv)(e) &&
                    a.forEach((t) => {
                      t in e || (e[t] = { fileName: "example-file" });
                    });
                  let r = (e) =>
                    (0, w.fo)(e)
                      ? e.name || "file"
                      : "object" == typeof e
                        ? JSON.stringify(e, void 0, 2)
                        : e?.toString();
                  return {
                    mimeType: t,
                    params: Object.entries(e).flatMap(([e, t]) =>
                      Array.isArray(t)
                        ? t
                            .filter((e) => null != e)
                            .map((n, s) => {
                              let i = t.length > 1 ? `${e}[${s}]` : e;
                              return (0, w.fo)(n) && "name" in n
                                ? { name: i, value: r(n), fileName: n.name }
                                : a && a.includes(e)
                                  ? { name: i, value: r(n), fileName: "example-file" }
                                  : { name: i, value: r(n) };
                            })
                        : (0, w.fo)(t) && "name" in t
                          ? [{ name: e, value: r(t), fileName: t.name }]
                          : a && a.includes(e)
                            ? [{ name: e, value: r(t), fileName: "example-file" }]
                            : [{ name: e, value: r(t) }],
                    ),
                  };
                }
                return "string" == typeof e &&
                  t &&
                  (function (e) {
                    let t = e.toLowerCase();
                    return t.startsWith("text/") || t.endsWith("+xml") || t.endsWith("/xml");
                  })(t)
                  ? { mimeType: t, text: e }
                  : { mimeType: "application/json", text: JSON.stringify(e, null, 2) };
              }
            })(l, n, v, d ? I(d) : void 0, j);
          return {
            ...E,
            method: (t.operation?.method ?? "").toUpperCase(),
            url: (0, A.s4)((0, A.sb)(r, a.server), u),
            queryString: p,
            headers: m,
            postData: k,
            cookies: h,
          };
        },
        q = (e) =>
          null == e ||
          ("object" == typeof e ? Object.values(e).every((e) => void 0 === e) : void 0);
      var F = r(59862);
      let R = (e, t) => Object.keys(e).find((e) => e.toLowerCase() === t.toLowerCase()),
        L = (e, t) => {
          let r = R(e, t);
          if (r) {
            return e[r];
          }
        },
        D = (e, t) => !!R(e, t),
        M = (e, t) => {
          let r = e[t.name];
          return (
            void 0 === r
              ? (e[t.name] = t.value)
              : Array.isArray(r)
                ? r.push(t.value)
                : (e[t.name] = [r, t.value]),
            e
          );
        };
      function B(e) {
        if (!e) {
          return "";
        }
        if (e.href && !e.protocol && !e.host && !e.hostname) {
          return e.href;
        }
        let t = "";
        if (
          (e.protocol && ((t += e.protocol), e.protocol.endsWith(":") || (t += ":")),
          (e.slashes || (e.protocol && (e.host || e.hostname))) && (t += "//"),
          e.auth)
        ) {
          let r = e.auth
            .split(":")
            .map((e, t) => (0 === t ? e : e.replace(/@/g, "%40")))
            .join(":");
          t += `${r}@`;
        }
        if (
          (e.host
            ? (t += e.host)
            : e.hostname && ((t += e.hostname), e.port && (t += `:${e.port}`)),
          e.pathname && (t += e.pathname.startsWith("/") ? e.pathname : `/${e.pathname}`),
          e.search)
        ) {
          t += e.search.startsWith("?") ? e.search : `?${e.search}`;
        } else if (null !== e.query && void 0 !== e.query && "string" != typeof e.query) {
          let r = new URLSearchParams();
          for (let [t, a] of Object.entries(e.query)) {
            if (Array.isArray(a)) for (let e of a) r.append(t, null == e ? "" : String(e));
            else r.append(t, null == a ? "" : String(a));
          }
          let a = r.toString();
          a && (t += `?${a}`);
        }
        return (e.hash && (t += e.hash.startsWith("#") ? e.hash : `#${e.hash}`), t);
      }
      class H {
        constructor({ indent: e, join: t } = {}) {
          ((this.postProcessors = []),
            (this.code = []),
            (this.indentationCharacter = ""),
            (this.lineJoin = "\n"),
            (this.indentLine = (e, t = 0) => {
              let r = this.indentationCharacter.repeat(t);
              return `${r}${e}`;
            }),
            (this.unshift = (e, t) => {
              let r = this.indentLine(e, t);
              this.code.unshift(r);
            }),
            (this.push = (e, t) => {
              let r = this.indentLine(e, t);
              this.code.push(r);
            }),
            (this.blank = () => {
              this.code.push("");
            }),
            (this.join = () => {
              let e = this.code.join(this.lineJoin);
              return this.postProcessors.reduce((e, t) => t(e), e);
            }),
            (this.addPostProcessor = (e) => {
              this.postProcessors = [...this.postProcessors, e];
            }),
            (this.indentationCharacter = e || ""),
            (this.lineJoin = t ?? "\n"));
        }
      }
      function U(e, t = {}) {
        let { delimiter: r = '"', escapeChar: a = "\\", escapeNewlines: n = !0 } = t;
        return [...e.toString()]
          .map((e) => {
            if ("\b" === e) {
              return `${a}b`;
            }
            if ("	" === e) {
              return `${a}t`;
            }
            if ("\n" === e) {
              if (n) {
                return `${a}n`;
              }
            } else if ("\f" === e) {
              return `${a}f`;
            } else if ("\r" === e) {
              if (n) {
                return `${a}r`;
              }
            } else if (e === a) {
              return a + a;
            } else if (e === r) {
              return a + r;
            } else if (e < " " || e > "~") {
              return JSON.stringify(e).slice(1, -1);
            }
            return e;
          })
          .join("");
      }
      let z = (e) => U(e, { delimiter: "'" }),
        V = (e) => U(e, { delimiter: '"' });
      class K {
        constructor(e) {
          ((this.name = ""), (this.toString = () => `:${this.name}`), (this.name = e));
        }
      }
      class W {
        constructor(e) {
          ((this.path = ""),
            (this.toString = () => `(clojure.java.io/file "${this.path}")`),
            (this.path = e));
        }
      }
      let G = (e) => (void 0 === e ? null : null === e ? "null" : e.constructor.name.toLowerCase()),
        J = (e) => void 0 === e || ("object" === G(e) && 0 === Object.keys(e).length),
        Z = (e) => (
          Object.keys(e)
            .filter((t) => J(e[t]))
            .forEach((t) => {
              delete e[t];
            }),
          e
        ),
        X = (e, t) => {
          let r = " ".repeat(e);
          return t.replace(
            /\n/g,
            `
${r}`,
          );
        },
        Y = (e) => {
          switch (G(e)) {
            case "string":
              return `"${e.replace(/"/g, '\\"')}"`;
            case "file":
            case "keyword":
            default:
              return e.toString();
            case "null":
              return "nil";
            case "regexp":
              return `#"${e.source}"`;
            case "object": {
              let t = Object.keys(e)
                .reduce((t, r) => {
                  let a = X(r.length + 2, Y(e[r]));
                  return `${t}:${r} ${a}
 `;
                }, "")
                .trim();
              return `{${X(1, t)}}`;
            }
            case "array": {
              let t = e.reduce((e, t) => `${e} ${Y(t)}`, "").trim();
              return `[${X(1, t)}]`;
            }
          }
        },
        Q = {
          info: {
            key: "clj_http",
            title: "clj-http",
            link: "https://github.com/dakrone/clj-http",
            description: "An idiomatic clojure http client wrapping the apache client.",
            extname: ".clj",
          },
          convert: ({ queryObj: e, method: t, postData: r, url: a, allHeaders: n }, s) => {
            let { push: i, join: o } = new H({ indent: s?.indent });
            if (
              !["get", "post", "put", "delete", "patch", "head", "options"].includes(
                (t = t.toLowerCase()),
              )
            ) {
              return (i("Method not supported"), o());
            }
            let l = { headers: n, "query-params": e };
            switch (r.mimeType) {
              case "application/json":
                {
                  ((l["content-type"] = new K("json")), (l["form-params"] = r.jsonObj));
                  let e = R(l.headers, "content-type");
                  e && delete l.headers[e];
                }
                break;
              case "application/x-www-form-urlencoded":
                {
                  l["form-params"] = r.paramsObj;
                  let e = R(l.headers, "content-type");
                  e && delete l.headers[e];
                }
                break;
              case "text/plain":
                {
                  l.body = r.text;
                  let e = R(l.headers, "content-type");
                  e && delete l.headers[e];
                }
                break;
              case "multipart/form-data":
                if (r.params) {
                  l.multipart = r.params.map((e) =>
                    e.fileName && !e.value
                      ? { name: e.name, content: new W(e.fileName) }
                      : { name: e.name, content: e.value },
                  );
                  let e = R(l.headers, "content-type");
                  e && delete l.headers[e];
                }
            }
            if ("application/json" === L(l.headers, "accept")) {
              l.accept = new K("json");
              let e = R(l.headers, "accept");
              e && delete l.headers[e];
            }
            if ((i("(require '[clj-http.client :as client])\n"), J(Z(l)))) {
              i(`(client/${t} "${a}")`);
            } else {
              let e = X(11 + t.length + a.length, Y(Z(l)));
              i(`(client/${t} "${a}" ${e})`);
            }
            return o();
          },
        },
        ee = {
          info: {
            key: "httpclient",
            title: "HttpClient",
            link: "https://docs.microsoft.com/en-us/dotnet/api/system.net.http.httpclient",
            description: ".NET Standard HTTP Client",
            extname: ".cs",
          },
          convert: ({ allHeaders: e, postData: t, method: r, fullUrl: a }, n) => {
            let { push: s, join: i } = new H({ indent: { indent: "    ", ...n }.indent });
            s("using System.Net.Http.Headers;");
            let o = "",
              l = !!e.cookie,
              d = ((e) => {
                let t = L(e, "accept-encoding");
                if (!t) {
                  return [];
                }
                let r = {
                    gzip: "DecompressionMethods.GZip",
                    deflate: "DecompressionMethods.Deflate",
                  },
                  a = [];
                return (
                  "string" == typeof t && (t = [t]),
                  t.forEach((e) => {
                    e.split(",").forEach((e) => {
                      let t = /\s*([^;\s]+)/.exec(e);
                      if (t) {
                        let e = r[t[1]];
                        e && a.push(e);
                      }
                    });
                  }),
                  a
                );
              })(e);
            ((l || d.length) &&
              ((o = "clientHandler"),
              s("var clientHandler = new HttpClientHandler"),
              s("{"),
              l && s("UseCookies = false,", 1),
              d.length && s(`AutomaticDecompression = ${d.join(" | ")},`, 1),
              s("};")),
              s(`var client = new HttpClient(${o});`),
              s("var request = new HttpRequestMessage"),
              s("{"),
              (r =
                (r = r.toUpperCase()) &&
                ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"].includes(r)
                  ? `HttpMethod.${r[0]}${r.substring(1).toLowerCase()}`
                  : `new HttpMethod("${r}")`),
              s(`Method = ${r},`, 1),
              s(`RequestUri = new Uri("${a}"),`, 1));
            let c = Object.keys(e).filter((e) => {
              switch (e.toLowerCase()) {
                case "content-type":
                case "content-length":
                case "accept-encoding":
                  return !1;
                default:
                  return !0;
              }
            });
            if (
              (c.length &&
                (s("Headers =", 1),
                s("{", 1),
                c.forEach((t) => {
                  s(`{ "${t}", "${V(e[t])}" },`, 2);
                }),
                s("},", 1)),
              t.text)
            ) {
              let e = t.mimeType;
              switch (e) {
                case "application/x-www-form-urlencoded":
                  (s("Content = new FormUrlEncodedContent(new Dictionary<string, string>", 1),
                    s("{", 1),
                    t.params?.forEach((e) => {
                      s(`{ "${e.name}", "${e.value}" },`, 2);
                    }),
                    s("}),", 1));
                  break;
                case "multipart/form-data":
                  (s("Content = new MultipartFormDataContent", 1),
                    s("{", 1),
                    t.params?.forEach((e) => {
                      (s(`new StringContent(${JSON.stringify(e.value || "")})`, 2),
                        s("{", 2),
                        s("Headers =", 3),
                        s("{", 3),
                        e.contentType &&
                          s(`ContentType = new MediaTypeHeaderValue("${e.contentType}"),`, 4),
                        s('ContentDisposition = new ContentDispositionHeaderValue("form-data")', 4),
                        s("{", 4),
                        s(`Name = "${e.name}",`, 5),
                        e.fileName && s(`FileName = "${e.fileName}",`, 5),
                        s("}", 4),
                        s("}", 3),
                        s("},", 2));
                    }),
                    s("},", 1));
                  break;
                default:
                  (s(`Content = new StringContent(${JSON.stringify(t.text || "")})`, 1),
                    s("{", 1),
                    s("Headers =", 2),
                    s("{", 2),
                    s(`ContentType = new MediaTypeHeaderValue("${e}")`, 3),
                    s("}", 2),
                    s("}", 1));
              }
            }
            return (
              s("};"),
              s("using (var response = await client.SendAsync(request))"),
              s("{"),
              s("response.EnsureSuccessStatusCode();", 1),
              s("var body = await response.Content.ReadAsStringAsync();", 1),
              s("Console.WriteLine(body);", 1),
              s("}"),
              i()
            );
          },
        };
      var et = r(60996).Buffer,
        er = r(78497);
      let ea = (e, t, r, a) => {
          let n = `${e} *${t} = `,
            s = en(r, a ? n.length : void 0);
          return `${n}${s};`;
        },
        en = (e, t) => {
          let r =
            void 0 === t
              ? ", "
              : `,
   ${" ".repeat(t)}`;
          switch (Object.prototype.toString.call(e)) {
            case "[object Number]":
              return `@${e}`;
            case "[object Array]": {
              let t = e.map((e) => en(e));
              return `@[ ${t.join(r)} ]`;
            }
            case "[object Object]": {
              let t = [];
              return (
                Object.keys(e).forEach((r) => {
                  t.push(`@"${r}": ${en(e[r])}`);
                }),
                `@{ ${t.join(r)} }`
              );
            }
            case "[object Boolean]":
              return e ? "@YES" : "@NO";
            default:
              if (null == e) {
                return "";
              }
              return `@"${e.toString().replace(/"/g, '\\"')}"`;
          }
        },
        es = (e, t, r) => {
          switch (((r = r || ""), (t = t || ""), Object.prototype.toString.call(e))) {
            case "[object Boolean]":
              return e;
            case "[object Null]":
            case "[object Undefined]":
            default:
              return "null";
            case "[object String]":
              return `'${U(e, { delimiter: "'", escapeNewlines: !1 })}'`;
            case "[object Number]":
              return e.toString();
            case "[object Array]": {
              let a = e.map((e) => es(e, `${t}${t}`, t)).join(`,
${t}`);
              return `[
${t}${a}
${r}]`;
            }
            case "[object Object]": {
              let a = [];
              for (let r in e) {
                Object.prototype.hasOwnProperty.call(e, r) &&
                  a.push(`${es(r, t)} => ${es(e[r], `${t}${t}`, t)}`);
              }
              return `[
${t}${a.join(`,
${t}`)}
${r}]`;
            }
          }
        },
        ei = new Set([
          "ACL",
          "BASELINE_CONTROL",
          "CHECKIN",
          "CHECKOUT",
          "CONNECT",
          "COPY",
          "DELETE",
          "GET",
          "HEAD",
          "LABEL",
          "LOCK",
          "MERGE",
          "MKACTIVITY",
          "MKCOL",
          "MKWORKSPACE",
          "MOVE",
          "OPTIONS",
          "POST",
          "PROPFIND",
          "PROPPATCH",
          "PUT",
          "REPORT",
          "TRACE",
          "UNCHECKOUT",
          "UNLOCK",
          "UPDATE",
          "VERSION_CONTROL",
        ]),
        eo =
          (e) =>
          ({
            method: t,
            headersObj: r,
            cookies: a,
            uriObj: n,
            fullUrl: s,
            postData: i,
            allHeaders: o,
          }) => {
            let { push: l, join: d } = new H();
            if (
              !["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(
                t.toUpperCase(),
              )
            )
              return "Method not supported";
            let c = [],
              p = Object.keys(r);
            return (
              p.length &&
                (l("$headers=@{}"),
                p.forEach((e) => {
                  "connection" !== e &&
                    l(`$headers.Add("${e}", "${U(r[e], { escapeChar: "`" })}")`);
                }),
                c.push("-Headers $headers")),
              a.length &&
                (l("$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession"),
                a.forEach((e) => {
                  (l("$cookie = New-Object System.Net.Cookie"),
                    l(`$cookie.Name = '${e.name}'`),
                    l(`$cookie.Value = '${e.value}'`),
                    l(`$cookie.Domain = '${n.host}'`),
                    l("$session.Cookies.Add($cookie)"));
                }),
                c.push("-WebSession $session")),
              i.text &&
                (c.push(
                  `-ContentType '${U(L(o, "content-type"), { delimiter: "'", escapeChar: "`" })}'`,
                ),
                c.push(`-Body '${i.text}'`)),
              l(`$response = ${e} -Uri '${s}' -Method ${t} ${c.join(" ")}`.trim()),
              d()
            );
          },
        el = {
          info: {
            key: "restmethod",
            title: "Invoke-RestMethod",
            link: "https://docs.microsoft.com/en-us/powershell/module/Microsoft.PowerShell.Utility/Invoke-RestMethod",
            description: "Powershell Invoke-RestMethod client",
            extname: ".ps1",
          },
          convert: eo("Invoke-RestMethod"),
        },
        ed = {
          info: {
            key: "webrequest",
            title: "Invoke-WebRequest",
            link: "https://docs.microsoft.com/en-us/powershell/module/Microsoft.PowerShell.Utility/Invoke-WebRequest",
            description: "Powershell Invoke-WebRequest client",
            extname: ".ps1",
          },
          convert: eo("Invoke-WebRequest"),
        };
      function ec(e, t, r, a, n) {
        let s = a.repeat(n),
          i = a.repeat(n - 1),
          o = r
            ? `,
${s}`
            : ", ",
          l = "object" === e ? "{" : "[",
          d = "object" === e ? "}" : "]";
        return r
          ? `${l}
${s}${t.join(o)}
${i}${d}`
          : "object" === e && t.length > 0
            ? `${l} ${t.join(o)} ${d}`
            : `${l}${t.join(o)}${d}`;
      }
      let ep = (e, t, r) => {
          switch (((r = void 0 === r ? 1 : r + 1), Object.prototype.toString.call(e))) {
            case "[object Number]":
              return e;
            case "[object Array]": {
              let a = !1;
              return ec(
                "array",
                e.map(
                  (e) => (
                    "[object Object]" === Object.prototype.toString.call(e) &&
                      (a = Object.keys(e).length > 1),
                    ep(e, t, r)
                  ),
                ),
                a,
                t.indent,
                r,
              );
            }
            case "[object Object]": {
              let a = [];
              for (let n in e) a.push(`"${n}": ${ep(e[n], t, r)}`);
              return ec("object", a, t.pretty && a.length > 1, t.indent, r);
            }
            case "[object Null]":
              return "None";
            case "[object Boolean]":
              return e ? "True" : "False";
            default:
              if (null == e) return "";
              return `"${e.toString().replace(/"/g, '\\"')}"`;
          }
        },
        eu = ["HEAD", "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        em = (e = "") => (/^[a-z0-9-_/.@%^=:]+$/i.test(e) ? e : `'${e.replace(/'/g, "'\\''")}'`),
        eh = {
          "http1.0": "0",
          "url ": "",
          cookie: "b",
          data: "d",
          form: "F",
          globoff: "g",
          header: "H",
          insecure: "k",
          request: "X",
        },
        ex = (e, t) => t.repeat(e),
        eg = (e, t, r, a) => {
          let n = ex(a, r),
            s = ex(a - 1, r),
            i = t
              ? `,
${n}`
              : ", ";
          return t
            ? `[
${n}${e.join(i)}
${s}]`
            : `[${e.join(i)}]`;
        },
        ef = (e, t, r) => `let ${e} = ${ey(t, r)}`,
        ey = (e, t, r) => {
          switch (((r = void 0 === r ? 1 : r + 1), Object.prototype.toString.call(e))) {
            case "[object Number]":
              return e;
            case "[object Array]": {
              let a = !1;
              return eg(
                e.map(
                  (e) => (
                    "[object Object]" === Object.prototype.toString.call(e) &&
                      (a = Object.keys(e).length > 1),
                    ey(e, t, r)
                  ),
                ),
                a,
                t.indent,
                r,
              );
            }
            case "[object Object]": {
              let a = [];
              for (let n in e) a.push(`"${n}": ${ey(e[n], t, r)}`);
              return eg(a, t.pretty && a.length > 1, t.indent, r);
            }
            case "[object Boolean]":
              return e.toString();
            default:
              if (null == e) return "nil";
              return `"${e.toString().replace(/"/g, '\\"')}"`;
          }
        },
        eb = {
          c: {
            info: { key: "c", title: "C", default: "libcurl", cli: "c" },
            clientsById: {
              libcurl: {
                info: {
                  key: "libcurl",
                  title: "Libcurl",
                  link: "http://curl.haxx.se/libcurl",
                  description: "Simple REST and HTTP API Client for C",
                  extname: ".c",
                },
                convert: ({ method: e, fullUrl: t, headersObj: r, allHeaders: a, postData: n }) => {
                  let { push: s, blank: i, join: o } = new H();
                  (s("CURL *hnd = curl_easy_init();"),
                    i(),
                    s(`curl_easy_setopt(hnd, CURLOPT_CUSTOMREQUEST, "${e.toUpperCase()}");`),
                    s("curl_easy_setopt(hnd, CURLOPT_WRITEDATA, stdout);"),
                    s(`curl_easy_setopt(hnd, CURLOPT_URL, "${t}");`));
                  let l = Object.keys(r);
                  return (
                    l.length &&
                      (i(),
                      s("struct curl_slist *headers = NULL;"),
                      l.forEach((e) => {
                        s(`headers = curl_slist_append(headers, "${e}: ${V(r[e])}");`);
                      }),
                      s("curl_easy_setopt(hnd, CURLOPT_HTTPHEADER, headers);")),
                    a.cookie && (i(), s(`curl_easy_setopt(hnd, CURLOPT_COOKIE, "${a.cookie}");`)),
                    n.text &&
                      (i(),
                      s(`curl_easy_setopt(hnd, CURLOPT_POSTFIELDS, ${JSON.stringify(n.text)});`)),
                    i(),
                    s("CURLcode ret = curl_easy_perform(hnd);"),
                    o()
                  );
                },
              },
            },
          },
          clojure: {
            info: { key: "clojure", title: "Clojure", default: "clj_http" },
            clientsById: { clj_http: Q },
          },
          csharp: {
            info: { key: "csharp", title: "C#", default: "restsharp", cli: "dotnet" },
            clientsById: {
              httpclient: ee,
              restsharp: {
                info: {
                  key: "restsharp",
                  title: "RestSharp",
                  link: "http://restsharp.org/",
                  description: "Simple REST and HTTP API Client for .NET",
                  extname: ".cs",
                  installation: () => "dotnet add package RestSharp",
                },
                convert: ({
                  method: e,
                  fullUrl: t,
                  headersObj: r,
                  cookies: a,
                  postData: n,
                  uriObj: s,
                }) => {
                  let { push: i, join: o } = new H();
                  if (
                    !["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(
                      e.toUpperCase(),
                    )
                  )
                    return "Method not supported";
                  (i("using RestSharp;\n\n"),
                    i(`var options = new RestClientOptions("${t}");`),
                    i("var client = new RestClient(options);"),
                    i('var request = new RestRequest("");'));
                  let l = n.mimeType && "multipart/form-data" === n.mimeType;
                  switch (
                    (l && i("request.AlwaysMultipartFormData = true;"),
                    Object.keys(r).forEach((e) => {
                      if (n.mimeType && "content-type" === e.toLowerCase() && n.text) {
                        l && n.boundary && i(`request.FormBoundary = "${n.boundary}";`);
                        return;
                      }
                      i(`request.AddHeader("${e}", "${V(r[e])}");`);
                    }),
                    a.forEach(({ name: e, value: t }) => {
                      i(`request.AddCookie("${e}", "${V(t)}", "${s.pathname}", "${s.host}");`);
                    }),
                    n.mimeType)
                  ) {
                    case "multipart/form-data":
                      if (!n.params) break;
                      n.params.forEach((e) => {
                        e.fileName
                          ? i(`request.AddFile("${e.name}", "${e.fileName}");`)
                          : i(`request.AddParameter("${e.name}", "${e.value}");`);
                      });
                      break;
                    case "application/x-www-form-urlencoded":
                      if (!n.params) break;
                      n.params.forEach((e) => {
                        i(`request.AddParameter("${e.name}", "${e.value}");`);
                      });
                      break;
                    case "application/json": {
                      if (!n.text) break;
                      let e = JSON.stringify(n.text);
                      i(`request.AddJsonBody(${e}, false);`);
                      break;
                    }
                    default:
                      if (!n.text) break;
                      i(`request.AddStringBody("${n.text}", "${n.mimeType}");`);
                  }
                  return (
                    i(`var response = await client.${(function (e) {
                      return e[0].toUpperCase() + e.slice(1).toLowerCase();
                    })(e)}Async(request);
`),
                    i('Console.WriteLine("{0}", response.Content);\n'),
                    o()
                  );
                },
              },
            },
          },
          go: {
            info: { key: "go", title: "Go", default: "native", cli: "go" },
            clientsById: {
              native: {
                info: {
                  key: "native",
                  title: "NewRequest",
                  link: "http://golang.org/pkg/net/http/#NewRequest",
                  description: "Golang HTTP client request",
                  extname: ".go",
                },
                convert: ({ postData: e, method: t, allHeaders: r, fullUrl: a }, n = {}) => {
                  let { blank: s, push: i, join: o } = new H({ indent: "	" }),
                    {
                      showBoilerplate: l = !0,
                      checkErrors: d = !1,
                      printBody: c = !0,
                      timeout: p = -1,
                    } = n,
                    u = d ? "err" : "_",
                    m = +!!l,
                    h = () => {
                      d && (i("if err != nil {", m), i("panic(err)", m + 1), i("}", m));
                    };
                  l &&
                    (i("package main"),
                    s(),
                    i("import ("),
                    i('"fmt"', m),
                    p > 0 && i('"time"', m),
                    e.text && i('"strings"', m),
                    i('"net/http"', m),
                    c && i('"io"', m),
                    i(")"),
                    s(),
                    i("func main() {"),
                    s());
                  let x = p > 0;
                  return (
                    x &&
                      (i("client := http.Client{", m),
                      x && i(`Timeout: time.Duration(${p} * time.Second),`, m + 1),
                      i("}", m),
                      s()),
                    i(`url := "${a}"`, m),
                    s(),
                    e.text
                      ? (i(`payload := strings.NewReader(${JSON.stringify(e.text)})`, m),
                        s(),
                        i(`req, ${u} := http.NewRequest("${t}", url, payload)`, m))
                      : i(`req, ${u} := http.NewRequest("${t}", url, nil)`, m),
                    s(),
                    h(),
                    Object.keys(r).length &&
                      (Object.keys(r).forEach((e) => {
                        i(`req.Header.Add("${e}", "${V(r[e])}")`, m);
                      }),
                      s()),
                    i(`res, ${u} := ${x ? "client" : "http.DefaultClient"}.Do(req)`, m),
                    h(),
                    c &&
                      (s(),
                      i("defer res.Body.Close()", m),
                      i(`body, ${u} := io.ReadAll(res.Body)`, m),
                      h()),
                    s(),
                    c && i("fmt.Println(string(body))", m),
                    l && (s(), i("}")),
                    o()
                  );
                },
              },
            },
          },
          http: {
            info: { key: "http", title: "HTTP", default: "http1.1" },
            clientsById: {
              "http1.1": {
                info: {
                  key: "http1.1",
                  title: "HTTP/1.1",
                  link: "https://tools.ietf.org/html/rfc7230",
                  description: "HTTP/1.1 request string in accordance with RFC 7230",
                  extname: null,
                },
                convert: (
                  { method: e, fullUrl: t, uriObj: r, httpVersion: a, allHeaders: n, postData: s },
                  i,
                ) => {
                  let o = { absoluteURI: !1, autoContentLength: !0, autoHost: !0, ...i },
                    { blank: l, push: d, join: c } = new H({ indent: "", join: "\r\n" }),
                    p = o.absoluteURI ? t : r.path;
                  d(`${e} ${p} ${a}`);
                  let u = Object.keys(n);
                  if (
                    (u.forEach((e) => {
                      let t = e.toLowerCase().replace(/(^|-)(\w)/g, (e) => e.toUpperCase());
                      d(`${t}: ${n[e]}`);
                    }),
                    o.autoHost && !u.includes("host") && d(`Host: ${r.host}`),
                    o.autoContentLength && s.text && !u.includes("content-length"))
                  ) {
                    let e = et.byteLength(s.text, "ascii").toString();
                    d(`Content-Length: ${e}`);
                  }
                  l();
                  let m = c(),
                    h = s.text || "";
                  return `${m}\r
${h}`;
                },
              },
            },
          },
          java: {
            info: { key: "java", title: "Java", default: "unirest" },
            clientsById: {
              asynchttp: {
                info: {
                  key: "asynchttp",
                  title: "AsyncHttp",
                  link: "https://github.com/AsyncHttpClient/async-http-client",
                  description: "Asynchronous Http and WebSocket Client library for Java",
                  extname: ".java",
                },
                convert: ({ method: e, allHeaders: t, postData: r, fullUrl: a }, n) => {
                  let {
                    blank: s,
                    push: i,
                    join: o,
                  } = new H({ indent: { indent: "  ", ...n }.indent });
                  return (
                    i("AsyncHttpClient client = new DefaultAsyncHttpClient();"),
                    i(`client.prepare("${e.toUpperCase()}", "${a}")`),
                    Object.keys(t).forEach((e) => {
                      i(`.setHeader("${e}", "${V(t[e])}")`, 1);
                    }),
                    r.text && i(`.setBody(${JSON.stringify(r.text)})`, 1),
                    i(".execute()", 1),
                    i(".toCompletableFuture()", 1),
                    i(".thenAccept(System.out::println)", 1),
                    i(".join();", 1),
                    s(),
                    i("client.close();"),
                    o()
                  );
                },
              },
              nethttp: {
                info: {
                  key: "nethttp",
                  title: "java.net.http",
                  link: "https://openjdk.java.net/groups/net/httpclient/intro.html",
                  description: "Java Standardized HTTP Client API",
                  extname: ".java",
                },
                convert: ({ allHeaders: e, fullUrl: t, method: r, postData: a }, n) => {
                  let { push: s, join: i } = new H({ indent: { indent: "  ", ...n }.indent });
                  return (
                    s("HttpRequest request = HttpRequest.newBuilder()"),
                    s(`.uri(URI.create("${t}"))`, 2),
                    Object.keys(e).forEach((t) => {
                      s(`.header("${t}", "${V(e[t])}")`, 2);
                    }),
                    a.text
                      ? s(
                          `.method("${r.toUpperCase()}", HttpRequest.BodyPublishers.ofString(${JSON.stringify(a.text)}))`,
                          2,
                        )
                      : s(`.method("${r.toUpperCase()}", HttpRequest.BodyPublishers.noBody())`, 2),
                    s(".build();", 2),
                    s(
                      "HttpResponse<String> response = HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.ofString());",
                    ),
                    s("System.out.println(response.body());"),
                    i()
                  );
                },
              },
              okhttp: {
                info: {
                  key: "okhttp",
                  title: "OkHttp",
                  link: "http://square.github.io/okhttp/",
                  description: "An HTTP Request Client Library",
                  extname: ".java",
                },
                convert: ({ postData: e, method: t, fullUrl: r, allHeaders: a }, n) => {
                  let {
                    push: s,
                    blank: i,
                    join: o,
                  } = new H({ indent: { indent: "  ", ...n }.indent });
                  return (
                    s("OkHttpClient client = new OkHttpClient();"),
                    i(),
                    e.text &&
                      (e.boundary
                        ? s(
                            `MediaType mediaType = MediaType.parse("${e.mimeType}; boundary=${e.boundary}");`,
                          )
                        : s(`MediaType mediaType = MediaType.parse("${e.mimeType}");`),
                      s(
                        `RequestBody body = RequestBody.create(mediaType, ${JSON.stringify(e.text)});`,
                      )),
                    s("Request request = new Request.Builder()"),
                    s(`.url("${r}")`, 1),
                    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].includes(t.toUpperCase())
                      ? ["POST", "PUT", "DELETE", "PATCH"].includes(t.toUpperCase())
                        ? e.text
                          ? s(`.${t.toLowerCase()}(body)`, 1)
                          : s(`.${t.toLowerCase()}(null)`, 1)
                        : s(`.${t.toLowerCase()}()`, 1)
                      : e.text
                        ? s(`.method("${t.toUpperCase()}", body)`, 1)
                        : s(`.method("${t.toUpperCase()}", null)`, 1),
                    Object.keys(a).forEach((e) => {
                      s(`.addHeader("${e}", "${V(a[e])}")`, 1);
                    }),
                    s(".build();", 1),
                    i(),
                    s("Response response = client.newCall(request).execute();"),
                    o()
                  );
                },
              },
              unirest: {
                info: {
                  key: "unirest",
                  title: "Unirest",
                  link: "http://unirest.io/java.html",
                  description: "Lightweight HTTP Request Client Library",
                  extname: ".java",
                },
                convert: ({ method: e, allHeaders: t, postData: r, fullUrl: a }, n) => {
                  let { join: s, push: i } = new H({ indent: { indent: "  ", ...n }.indent });
                  return (
                    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(
                      e.toUpperCase(),
                    )
                      ? i(`HttpResponse<String> response = Unirest.${e.toLowerCase()}("${a}")`)
                      : i(
                          `HttpResponse<String> response = Unirest.customMethod("${e.toUpperCase()}","${a}")`,
                        ),
                    Object.keys(t).forEach((e) => {
                      i(`.header("${e}", "${V(t[e])}")`, 1);
                    }),
                    r.text && i(`.body(${JSON.stringify(r.text)})`, 1),
                    i(".asString();", 1),
                    s()
                  );
                },
              },
            },
          },
          javascript: {
            info: { key: "javascript", title: "JavaScript", default: "fetch" },
            clientsById: {
              xhr: {
                info: {
                  key: "xhr",
                  title: "XMLHttpRequest",
                  link: "https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest",
                  description: "W3C Standard API that provides scripted client functionality",
                  extname: ".js",
                },
                convert: ({ postData: e, allHeaders: t, method: r, fullUrl: a }, n) => {
                  let s = { indent: "  ", cors: !0, ...n },
                    { blank: i, push: o, join: l } = new H({ indent: s.indent });
                  switch (e.mimeType) {
                    case "application/json":
                      (o(`const data = JSON.stringify(${er(e.jsonObj, { indent: s.indent })});`),
                        i());
                      break;
                    case "multipart/form-data":
                      if (!e.params) break;
                      if (
                        (o("const data = new FormData();"),
                        e.params.forEach((e) => {
                          o(`data.append('${e.name}', '${e.value || e.fileName || ""}');`);
                        }),
                        D(t, "content-type") && L(t, "content-type")?.includes("boundary"))
                      ) {
                        let e = R(t, "content-type");
                        e && delete t[e];
                      }
                      i();
                      break;
                    default:
                      (o(`const data = ${e.text ? `'${e.text}'` : "null"};`), i());
                  }
                  return (
                    o("const xhr = new XMLHttpRequest();"),
                    s.cors && o("xhr.withCredentials = true;"),
                    i(),
                    o("xhr.addEventListener('readystatechange', function () {"),
                    o("if (this.readyState === this.DONE) {", 1),
                    o("console.log(this.responseText);", 2),
                    o("}", 1),
                    o("});"),
                    i(),
                    o(`xhr.open('${r}', '${a}');`),
                    Object.keys(t).forEach((e) => {
                      o(`xhr.setRequestHeader('${e}', '${z(t[e])}');`);
                    }),
                    i(),
                    o("xhr.send(data);"),
                    l()
                  );
                },
              },
              axios: {
                info: {
                  key: "axios",
                  title: "Axios",
                  link: "https://github.com/axios/axios",
                  description: "Promise based HTTP client for the browser and node.js",
                  extname: ".js",
                  installation: () => "npm install axios --save",
                },
                convert: ({ allHeaders: e, method: t, url: r, queryObj: a, postData: n }, s) => {
                  let {
                    blank: i,
                    push: o,
                    join: l,
                    addPostProcessor: d,
                  } = new H({ indent: { indent: "  ", ...s }.indent });
                  (o("import axios from 'axios';"), i());
                  let c = { method: t, url: r };
                  switch (
                    (Object.keys(a).length && (c.params = a),
                    Object.keys(e).length && (c.headers = e),
                    n.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      n.params &&
                        (o("const encodedParams = new URLSearchParams();"),
                        n.params.forEach((e) => {
                          o(`encodedParams.set('${e.name}', '${e.value}');`);
                        }),
                        i(),
                        (c.data = "encodedParams,"),
                        d((e) => e.replace(/'encodedParams,'/, "encodedParams,")));
                      break;
                    case "application/json":
                      n.jsonObj && (c.data = n.jsonObj);
                      break;
                    case "multipart/form-data":
                      if (!n.params) break;
                      (o("const form = new FormData();"),
                        n.params.forEach((e) => {
                          o(`form.append('${e.name}', '${e.value || e.fileName || ""}');`);
                        }),
                        i(),
                        (c.data = "[form]"));
                      break;
                    default:
                      n.text && (c.data = n.text);
                  }
                  let p = er(c, { indent: "  ", inlineCharacterLimit: 80 }).replace(
                    '"[form]"',
                    "form",
                  );
                  return (
                    o(`const options = ${p};`),
                    i(),
                    o("axios"),
                    o(".request(options)", 1),
                    o(".then(res => console.log(res.data))", 1),
                    o(".catch(err => console.error(err));", 1),
                    l()
                  );
                },
              },
              fetch: {
                info: {
                  key: "fetch",
                  title: "fetch",
                  link: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch",
                  description: "Perform asynchronous HTTP requests with the Fetch API",
                  extname: ".js",
                },
                convert: ({ method: e, allHeaders: t, postData: r, fullUrl: a }, n) => {
                  let s = { indent: "  ", credentials: null, ...n },
                    { blank: i, join: o, push: l } = new H({ indent: s.indent }),
                    d = { method: e };
                  switch (
                    (Object.keys(t).length && (d.headers = t),
                    null !== s.credentials && (d.credentials = s.credentials),
                    r.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      d.body = r.paramsObj ? r.paramsObj : r.text;
                      break;
                    case "application/json":
                      r.jsonObj && (d.body = r.jsonObj);
                      break;
                    case "multipart/form-data": {
                      if (!r.params) break;
                      let e = R(t, "content-type");
                      (e && delete t[e],
                        l("const form = new FormData();"),
                        r.params.forEach((e) => {
                          l(`form.append('${e.name}', '${e.value || e.fileName || ""}');`);
                        }),
                        i());
                      break;
                    }
                    default:
                      r.text && (d.body = r.text);
                  }
                  return (
                    d.headers && !Object.keys(d.headers).length && delete d.headers,
                    l(
                      `const options = ${er(d, {
                        indent: s.indent,
                        inlineCharacterLimit: 80,
                        transform: (e, t, a) => {
                          if ("body" === t) {
                            if ("application/x-www-form-urlencoded" === r.mimeType)
                              return `new URLSearchParams(${a})`;
                            else if ("application/json" === r.mimeType)
                              return `JSON.stringify(${a})`;
                          }
                          return a;
                        },
                      })};`,
                    ),
                    i(),
                    r.params &&
                      "multipart/form-data" === r.mimeType &&
                      (l("options.body = form;"), i()),
                    l(`fetch('${a}', options)`),
                    l(".then(res => res.json())", 1),
                    l(".then(res => console.log(res))", 1),
                    l(".catch(err => console.error(err));", 1),
                    o()
                  );
                },
              },
              jquery: {
                info: {
                  key: "jquery",
                  title: "jQuery",
                  link: "http://api.jquery.com/jquery.ajax/",
                  description: "Perform an asynchronous HTTP (Ajax) requests with jQuery",
                  extname: ".js",
                },
                convert: ({ fullUrl: e, method: t, allHeaders: r, postData: a }, n) => {
                  let s = { indent: "  ", ...n },
                    { blank: i, push: o, join: l } = new H({ indent: s.indent }),
                    d = { async: !0, crossDomain: !0, url: e, method: t, headers: r };
                  switch (a.mimeType) {
                    case "application/x-www-form-urlencoded":
                      d.data = a.paramsObj ? a.paramsObj : a.text;
                      break;
                    case "application/json":
                      ((d.processData = !1), (d.data = a.text));
                      break;
                    case "multipart/form-data":
                      if (!a.params) break;
                      if (
                        (o("const form = new FormData();"),
                        a.params.forEach((e) => {
                          o(`form.append('${e.name}', '${e.value || e.fileName || ""}');`);
                        }),
                        (d.processData = !1),
                        (d.contentType = !1),
                        (d.mimeType = "multipart/form-data"),
                        (d.data = "[form]"),
                        D(r, "content-type") && L(r, "content-type")?.includes("boundary"))
                      ) {
                        let e = R(r, "content-type");
                        e && delete d.headers[e];
                      }
                      i();
                      break;
                    default:
                      a.text && (d.data = a.text);
                  }
                  let c = er(d, { indent: s.indent }).replace("'[form]'", "form");
                  return (
                    o(`const settings = ${c};`),
                    i(),
                    o("$.ajax(settings).done(res => {"),
                    o("console.log(res);", 1),
                    o("});"),
                    l()
                  );
                },
              },
            },
          },
          json: {
            info: { key: "json", title: "JSON", default: "native" },
            clientsById: {
              native: {
                info: {
                  key: "native",
                  title: "Native JSON",
                  link: "https://www.json.org/json-en.html",
                  description: "A JSON represetation of any HAR payload.",
                  extname: ".json",
                },
                convert: ({ postData: e }, t) => {
                  let r = { indent: "  ", ...t },
                    a = "";
                  switch (e.mimeType) {
                    case "application/x-www-form-urlencoded":
                      a = e.paramsObj ? e.paramsObj : e.text;
                      break;
                    case "application/json":
                      e.jsonObj && (a = e.jsonObj);
                      break;
                    case "multipart/form-data": {
                      if (!e.params) break;
                      let t = {};
                      (e.params.forEach((e) => {
                        t[e.name] = e.value;
                      }),
                        (a = t));
                      break;
                    }
                    default:
                      e.text && (a = e.text);
                  }
                  return void 0 === a || "" === a
                    ? "No JSON body"
                    : JSON.stringify(a, null, r.indent);
                },
              },
            },
          },
          kotlin: {
            info: { key: "kotlin", title: "Kotlin", default: "okhttp" },
            clientsById: {
              okhttp: {
                info: {
                  key: "okhttp",
                  title: "OkHttp",
                  link: "http://square.github.io/okhttp/",
                  description: "An HTTP Request Client Library",
                  extname: ".kt",
                },
                convert: ({ postData: e, fullUrl: t, method: r, allHeaders: a }, n) => {
                  let {
                    blank: s,
                    join: i,
                    push: o,
                  } = new H({ indent: { indent: "  ", ...n }.indent });
                  return (
                    o("val client = OkHttpClient()"),
                    s(),
                    e.text &&
                      (e.boundary
                        ? o(
                            `val mediaType = MediaType.parse("${e.mimeType}; boundary=${e.boundary}")`,
                          )
                        : o(`val mediaType = MediaType.parse("${e.mimeType}")`),
                      o(`val body = RequestBody.create(mediaType, ${JSON.stringify(e.text)})`)),
                    o("val request = Request.Builder()"),
                    o(`.url("${t}")`, 1),
                    ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].includes(r.toUpperCase())
                      ? ["POST", "PUT", "DELETE", "PATCH"].includes(r.toUpperCase())
                        ? e.text
                          ? o(`.${r.toLowerCase()}(body)`, 1)
                          : o(`.${r.toLowerCase()}(null)`, 1)
                        : o(`.${r.toLowerCase()}()`, 1)
                      : e.text
                        ? o(`.method("${r.toUpperCase()}", body)`, 1)
                        : o(`.method("${r.toUpperCase()}", null)`, 1),
                    Object.keys(a).forEach((e) => {
                      o(`.addHeader("${e}", "${V(a[e])}")`, 1);
                    }),
                    o(".build()", 1),
                    s(),
                    o("val response = client.newCall(request).execute()"),
                    i()
                  );
                },
              },
            },
          },
          node: {
            info: { key: "node", title: "Node.js", default: "fetch", cli: "node %s" },
            clientsById: {
              native: {
                info: {
                  key: "native",
                  title: "HTTP",
                  link: "http://nodejs.org/api/http.html#http_http_request_options_callback",
                  description: "Node.js native HTTP interface",
                  extname: ".cjs",
                },
                convert: ({ uriObj: e, method: t, allHeaders: r, postData: a }, n = {}) => {
                  let { indent: s = "  " } = n,
                    { blank: i, join: o, push: l, unshift: d } = new H({ indent: s }),
                    c = { method: t, hostname: e.hostname, port: e.port, path: e.path, headers: r };
                  switch (
                    (l(`const http = require('${e.protocol?.replace(":", "")}');`),
                    i(),
                    l(`const options = ${er(c, { indent: s })};`),
                    i(),
                    l("const req = http.request(options, function (res) {"),
                    l("const chunks = [];", 1),
                    i(),
                    l("res.on('data', function (chunk) {", 1),
                    l("chunks.push(chunk);", 2),
                    l("});", 1),
                    i(),
                    l("res.on('end', function () {", 1),
                    l("const body = Buffer.concat(chunks);", 2),
                    l("console.log(body.toString());", 2),
                    l("});", 1),
                    l("});"),
                    i(),
                    a.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      a.paramsObj &&
                        (d("const qs = require('querystring');"),
                        l(
                          `req.write(qs.stringify(${er(a.paramsObj, { indent: "  ", inlineCharacterLimit: 80 })}));`,
                        ));
                      break;
                    case "application/json":
                      a.jsonObj &&
                        l(
                          `req.write(JSON.stringify(${er(a.jsonObj, { indent: "  ", inlineCharacterLimit: 80 })}));`,
                        );
                      break;
                    default:
                      a.text && l(`req.write(${er(a.text, { indent: s })});`);
                  }
                  return (l("req.end();"), o());
                },
              },
              axios: {
                info: {
                  key: "axios",
                  title: "Axios",
                  link: "https://github.com/axios/axios",
                  description: "Promise based HTTP client for the browser and node.js",
                  extname: ".js",
                  installation: () => "npm install axios --save",
                },
                convert: ({ method: e, fullUrl: t, allHeaders: r, postData: a }, n) => {
                  let {
                    blank: s,
                    join: i,
                    push: o,
                    addPostProcessor: l,
                  } = new H({ indent: { indent: "  ", ...n }.indent });
                  (o("import axios from 'axios';"), s());
                  let d = { method: e, url: t };
                  switch ((Object.keys(r).length && (d.headers = r), a.mimeType)) {
                    case "application/x-www-form-urlencoded":
                      a.params &&
                        (o("const encodedParams = new URLSearchParams();"),
                        a.params.forEach((e) => {
                          o(`encodedParams.set('${e.name}', '${e.value}');`);
                        }),
                        s(),
                        (d.data = "encodedParams,"),
                        l((e) => e.replace(/'encodedParams,'/, "encodedParams,")));
                      break;
                    case "application/json":
                      a.jsonObj && (d.data = a.jsonObj);
                      break;
                    default:
                      a.text && (d.data = a.text);
                  }
                  let c = er(d, { indent: "  ", inlineCharacterLimit: 80 });
                  return (
                    o(`const options = ${c};`),
                    s(),
                    o("axios"),
                    o(".request(options)", 1),
                    o(".then(res => console.log(res.data))", 1),
                    o(".catch(err => console.error(err));", 1),
                    i()
                  );
                },
              },
              fetch: {
                info: {
                  key: "fetch",
                  title: "fetch",
                  link: "https://nodejs.org/docs/latest/api/globals.html#fetch",
                  description: "Perform asynchronous HTTP requests with the Fetch API",
                  extname: ".js",
                },
                convert: ({ method: e, fullUrl: t, postData: r, headersObj: a, cookies: n }, s) => {
                  let i = { indent: "  ", ...s },
                    o = !1,
                    { blank: l, push: d, join: c, unshift: p } = new H({ indent: i.indent }),
                    u = { method: e };
                  switch ((Object.keys(a).length && (u.headers = a), r.mimeType)) {
                    case "application/x-www-form-urlencoded":
                      (d("const encodedParams = new URLSearchParams();"),
                        r.params?.forEach((e) => {
                          d(`encodedParams.set('${e.name}', '${e.value}');`);
                        }),
                        (u.body = "encodedParams"),
                        l());
                      break;
                    case "application/json":
                      r.jsonObj && (u.body = r.jsonObj);
                      break;
                    case "multipart/form-data": {
                      if (!r.params) break;
                      let e = R(a, "content-type");
                      (e && delete a[e],
                        d("const formData = new FormData();"),
                        r.params.forEach((e) => {
                          if (!e.fileName && !e.fileName && !e.contentType)
                            return d(`formData.append('${e.name}', '${e.value}');`);
                          e.fileName &&
                            ((o = !0),
                            d(
                              `formData.append('${e.name}', await new Response(fs.createReadStream('${e.fileName}')).blob());`,
                            ));
                        }),
                        (u.body = "formData"),
                        l());
                      break;
                    }
                    default:
                      r.text && (u.body = r.text);
                  }
                  if (n.length) {
                    let e = n
                      .map(
                        ({ name: e, value: t }) =>
                          `${encodeURIComponent(e)}=${encodeURIComponent(t)}`,
                      )
                      .join("; ");
                    (u.headers || (u.headers = {}), (u.headers.cookie = e));
                  }
                  (d(`const url = '${t}';`),
                    u.headers && !Object.keys(u.headers).length && delete u.headers);
                  let m = er(u, {
                    indent: "  ",
                    inlineCharacterLimit: 80,
                    transform: (e, t, a) =>
                      "body" === t && "application/json" === r.mimeType
                        ? `JSON.stringify(${a})`
                        : a,
                  });
                  return (
                    d(`const options = ${m};`),
                    l(),
                    o && p("import fs from 'fs';\n"),
                    d("fetch(url, options)"),
                    d(".then(res => res.json())", 1),
                    d(".then(json => console.log(json))", 1),
                    d(".catch(err => console.error(err));", 1),
                    c()
                      .replace(/'encodedParams'/, "encodedParams")
                      .replace(/'formData'/, "formData")
                  );
                },
              },
            },
          },
          objc: {
            info: { key: "objc", title: "Objective-C", default: "nsurlsession" },
            clientsById: {
              nsurlsession: {
                info: {
                  key: "nsurlsession",
                  title: "NSURLSession",
                  link: "https://developer.apple.com/library/mac/documentation/Foundation/Reference/NSURLSession_class/index.html",
                  description: "Foundation's NSURLSession request",
                  extname: ".m",
                },
                convert: ({ allHeaders: e, postData: t, method: r, fullUrl: a }, n) => {
                  let s = { indent: "    ", pretty: !0, timeout: 10, ...n },
                    { push: i, join: o, blank: l } = new H({ indent: s.indent }),
                    d = { hasHeaders: !1, hasBody: !1 };
                  if (
                    (i("#import <Foundation/Foundation.h>"),
                    Object.keys(e).length &&
                      ((d.hasHeaders = !0), l(), i(ea("NSDictionary", "headers", e, s.pretty))),
                    t.text || t.jsonObj || t.params)
                  )
                    switch (((d.hasBody = !0), t.mimeType)) {
                      case "application/x-www-form-urlencoded":
                        if (t.params?.length) {
                          l();
                          let [e, ...r] = t.params;
                          (i(
                            `NSMutableData *postData = [[NSMutableData alloc] initWithData:[@"${e.name}=${e.value}" dataUsingEncoding:NSUTF8StringEncoding]];`,
                          ),
                            r.forEach(({ name: e, value: t }) => {
                              i(
                                `[postData appendData:[@"&${e}=${t}" dataUsingEncoding:NSUTF8StringEncoding]];`,
                              );
                            }));
                        } else d.hasBody = !1;
                        break;
                      case "application/json":
                        t.jsonObj &&
                          (i(ea("NSDictionary", "parameters", t.jsonObj, s.pretty)),
                          l(),
                          i(
                            "NSData *postData = [NSJSONSerialization dataWithJSONObject:parameters options:0 error:nil];",
                          ));
                        break;
                      case "multipart/form-data":
                        (i(ea("NSArray", "parameters", t.params || [], s.pretty)),
                          i(`NSString *boundary = @"${t.boundary}";`),
                          l(),
                          i("NSError *error;"),
                          i("NSMutableString *body = [NSMutableString string];"),
                          i("for (NSDictionary *param in parameters) {"),
                          i('[body appendFormat:@"--%@\\r\\n", boundary];', 1),
                          i('if (param[@"fileName"]) {', 1),
                          i(
                            '[body appendFormat:@"Content-Disposition:form-data; name=\\"%@\\"; filename=\\"%@\\"\\r\\n", param[@"name"], param[@"fileName"]];',
                            2,
                          ),
                          i(
                            '[body appendFormat:@"Content-Type: %@\\r\\n\\r\\n", param[@"contentType"]];',
                            2,
                          ),
                          i(
                            '[body appendFormat:@"%@", [NSString stringWithContentsOfFile:param[@"fileName"] encoding:NSUTF8StringEncoding error:&error]];',
                            2,
                          ),
                          i("if (error) {", 2),
                          i('NSLog(@"%@", error);', 3),
                          i("}", 2),
                          i("} else {", 1),
                          i(
                            '[body appendFormat:@"Content-Disposition:form-data; name=\\"%@\\"\\r\\n\\r\\n", param[@"name"]];',
                            2,
                          ),
                          i('[body appendFormat:@"%@", param[@"value"]];', 2),
                          i("}", 1),
                          i("}"),
                          i('[body appendFormat:@"\\r\\n--%@--\\r\\n", boundary];'),
                          i("NSData *postData = [body dataUsingEncoding:NSUTF8StringEncoding];"));
                        break;
                      default:
                        (l(),
                          i(
                            `NSData *postData = [[NSData alloc] initWithData:[@"${t.text}" dataUsingEncoding:NSUTF8StringEncoding]];`,
                          ));
                    }
                  return (
                    l(),
                    i(
                      `NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"${a}"]`,
                    ),
                    i(
                      "                                                       cachePolicy:NSURLRequestUseProtocolCachePolicy",
                    ),
                    i(
                      `                                                   timeoutInterval:${s.timeout.toFixed(1)}];`,
                    ),
                    i(`[request setHTTPMethod:@"${r}"];`),
                    d.hasHeaders && i("[request setAllHTTPHeaderFields:headers];"),
                    d.hasBody && i("[request setHTTPBody:postData];"),
                    l(),
                    i("NSURLSession *session = [NSURLSession sharedSession];"),
                    i("NSURLSessionDataTask *dataTask = [session dataTaskWithRequest:request"),
                    i(
                      "                                            completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {",
                    ),
                    i("                                            if (error) {", 1),
                    i('                                            NSLog(@"%@", error);', 2),
                    i("                                            } else {", 1),
                    i(
                      "                                            NSHTTPURLResponse *httpResponse = (NSHTTPURLResponse *) response;",
                      2,
                    ),
                    i('                                            NSLog(@"%@", httpResponse);', 2),
                    i("                                            }", 1),
                    i("                                            }];"),
                    i("[dataTask resume];"),
                    o()
                  );
                },
              },
            },
          },
          ocaml: {
            info: { key: "ocaml", title: "OCaml", default: "cohttp" },
            clientsById: {
              cohttp: {
                info: {
                  key: "cohttp",
                  title: "CoHTTP",
                  link: "https://github.com/mirage/ocaml-cohttp",
                  description:
                    "Cohttp is a very lightweight HTTP server using Lwt or Async for OCaml",
                  extname: ".ml",
                  installation: () => "opam install cohttp-lwt-unix cohttp-async",
                },
                convert: ({ fullUrl: e, allHeaders: t, postData: r, method: a }, n) => {
                  let {
                    push: s,
                    blank: i,
                    join: o,
                  } = new H({ indent: { indent: "  ", ...n }.indent });
                  (s("open Cohttp_lwt_unix"),
                    s("open Cohttp"),
                    s("open Lwt"),
                    i(),
                    s(`let uri = Uri.of_string "${e}" in`));
                  let l = Object.keys(t);
                  (1 === l.length
                    ? s(`let headers = Header.add (Header.init ()) "${l[0]}" "${V(t[l[0]])}" in`)
                    : l.length > 1 &&
                      (s("let headers = Header.add_list (Header.init ()) ["),
                      l.forEach((e) => {
                        s(`("${e}", "${V(t[e])}");`, 1);
                      }),
                      s("] in")),
                    r.text &&
                      s(`let body = Cohttp_lwt_body.of_string ${JSON.stringify(r.text)} in`),
                    i());
                  let d = l.length ? "~headers " : "",
                    c = r.text ? "~body " : "",
                    p = ["get", "post", "head", "delete", "patch", "put", "options"].includes(
                      a.toLowerCase(),
                    )
                      ? `\`${a.toUpperCase()}`
                      : `(Code.method_of_string "${a}")`;
                  return (
                    s(`Client.call ${d}${c}${p} uri`),
                    s(">>= fun (res, body_stream) ->"),
                    s("(* Do stuff with the result *)", 1),
                    o()
                  );
                },
              },
            },
          },
          php: {
            info: { key: "php", title: "PHP", default: "curl", cli: "php %s" },
            clientsById: {
              curl: {
                info: {
                  key: "curl",
                  title: "cURL",
                  link: "http://php.net/manual/en/book.curl.php",
                  description: "PHP with ext-curl",
                  extname: ".php",
                },
                convert: (
                  {
                    uriObj: e,
                    postData: t,
                    fullUrl: r,
                    method: a,
                    httpVersion: n,
                    cookies: s,
                    headersObj: i,
                  },
                  o = {},
                ) => {
                  let {
                      closingTag: l = !1,
                      indent: d = "  ",
                      maxRedirects: c = 10,
                      namedErrors: p = !1,
                      noTags: u = !1,
                      shortTags: m = !1,
                      timeout: h = 30,
                    } = o,
                    { push: x, blank: g, join: f } = new H({ indent: d });
                  (u || (x(m ? "<?" : "<?php"), g()), x("$curl = curl_init();"), g());
                  let y = [
                    { escape: !0, name: "CURLOPT_PORT", value: e.port },
                    { escape: !0, name: "CURLOPT_URL", value: r },
                    { escape: !1, name: "CURLOPT_RETURNTRANSFER", value: "true" },
                    { escape: !0, name: "CURLOPT_ENCODING", value: "" },
                    { escape: !1, name: "CURLOPT_MAXREDIRS", value: c },
                    { escape: !1, name: "CURLOPT_TIMEOUT", value: h },
                    {
                      escape: !1,
                      name: "CURLOPT_HTTP_VERSION",
                      value: "HTTP/1.0" === n ? "CURL_HTTP_VERSION_1_0" : "CURL_HTTP_VERSION_1_1",
                    },
                    { escape: !0, name: "CURLOPT_CUSTOMREQUEST", value: a },
                    {
                      escape: !t.jsonObj,
                      name: "CURLOPT_POSTFIELDS",
                      value: t
                        ? t.jsonObj
                          ? `json_encode(${es(t.jsonObj, d.repeat(2), d)})`
                          : t.text
                        : void 0,
                    },
                  ];
                  x("curl_setopt_array($curl, [");
                  let b = new H({
                    indent: d,
                    join: `
${d}`,
                  });
                  y.forEach(({ value: e, name: t, escape: r }) => {
                    null != e && b.push(`${t} => ${r ? JSON.stringify(e) : e},`);
                  });
                  let v = s.map(
                    (e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`,
                  );
                  v.length && b.push(`CURLOPT_COOKIE => "${v.join("; ")}",`);
                  let j = Object.keys(i)
                    .sort()
                    .map((e) => `"${e}: ${V(i[e])}"`);
                  return (
                    j.length &&
                      (b.push("CURLOPT_HTTPHEADER => ["),
                      b.push(
                        j.join(`,
${d}${d}`),
                        1,
                      ),
                      b.push("],")),
                    x(b.join(), 1),
                    x("]);"),
                    g(),
                    x("$response = curl_exec($curl);"),
                    x("$err = curl_error($curl);"),
                    g(),
                    x("curl_close($curl);"),
                    g(),
                    x("if ($err) {"),
                    x(
                      p
                        ? 'echo array_flip(get_defined_constants(true)["curl"])[$err];'
                        : 'echo "cURL Error #:" . $err;',
                      1,
                    ),
                    x("} else {"),
                    x("echo $response;", 1),
                    x("}"),
                    !u && l && (g(), x("?>")),
                    f()
                  );
                },
              },
              guzzle: {
                info: {
                  key: "guzzle",
                  title: "Guzzle",
                  link: "http://docs.guzzlephp.org/en/stable/",
                  description: "PHP with Guzzle",
                  extname: ".php",
                  installation: () => "composer require guzzlehttp/guzzle",
                },
                convert: ({ postData: e, fullUrl: t, method: r, cookies: a, headersObj: n }, s) => {
                  let i = { closingTag: !1, indent: "  ", noTags: !1, shortTags: !1, ...s },
                    { push: o, blank: l, join: d } = new H({ indent: i.indent }),
                    { code: c, push: p, join: u } = new H({ indent: i.indent });
                  switch (
                    (!i.noTags && o(i.shortTags ? "<?" : "<?php"),
                    o("require_once('vendor/autoload.php');"),
                    l(),
                    e.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      p(`'form_params' => ${es(e.paramsObj, i.indent + i.indent, i.indent)},`, 1);
                      break;
                    case "multipart/form-data": {
                      let t = [];
                      if (
                        (e.params &&
                          e.params.forEach((e) => {
                            if (e.fileName) {
                              let r = { name: e.name, filename: e.fileName, contents: e.value };
                              (e.contentType && (r.headers = { "Content-Type": e.contentType }),
                                t.push(r));
                            } else e.value && t.push({ name: e.name, contents: e.value });
                          }),
                        t.length &&
                          (p(`'multipart' => ${es(t, i.indent + i.indent, i.indent)}`, 1),
                          D(n, "content-type") && L(n, "content-type")?.indexOf("boundary")))
                      ) {
                        let e = R(n, "content-type");
                        e && delete n[e];
                      }
                      break;
                    }
                    default:
                      e.text && p(`'body' => ${es(e.text)},`, 1);
                  }
                  let m = Object.keys(n)
                      .sort()
                      .map((e) => `${i.indent}${i.indent}'${e}' => '${z(n[e])}',`),
                    h = a
                      .map((e) => `${encodeURIComponent(e.name)}=${encodeURIComponent(e.value)}`)
                      .join("; ");
                  return (
                    h.length && m.push(`${i.indent}${i.indent}'cookie' => '${z(h)}',`),
                    m.length && (p("'headers' => [", 1), p(m.join("\n")), p("],", 1)),
                    o("$client = new \\GuzzleHttp\\Client();"),
                    l(),
                    c.length
                      ? (o(`$response = $client->request('${r}', '${t}', [`), o(u()), o("]);"))
                      : o(`$response = $client->request('${r}', '${t}');`),
                    l(),
                    o("echo $response->getBody();"),
                    !i.noTags && i.closingTag && (l(), o("?>")),
                    d()
                  );
                },
              },
              http1: {
                info: {
                  key: "http1",
                  title: "HTTP v1",
                  link: "http://php.net/manual/en/book.http.php",
                  description: "PHP with pecl/http v1",
                  extname: ".php",
                },
                convert: (
                  { method: e, url: t, postData: r, queryObj: a, headersObj: n, cookiesObj: s },
                  i = {},
                ) => {
                  let {
                      closingTag: o = !1,
                      indent: l = "  ",
                      noTags: d = !1,
                      shortTags: c = !1,
                    } = i,
                    { push: p, blank: u, join: m } = new H({ indent: l });
                  switch (
                    (!d && (p(c ? "<?" : "<?php"), u()),
                    !ei.has(e.toUpperCase()) && p(`HttpRequest::methodRegister('${e}');`),
                    p("$request = new HttpRequest();"),
                    p(`$request->setUrl(${es(t)});`),
                    p(
                      ei.has(e.toUpperCase())
                        ? `$request->setMethod(HTTP_METH_${e.toUpperCase()});`
                        : `$request->setMethod(HttpRequest::HTTP_METH_${e.toUpperCase()});`,
                    ),
                    u(),
                    Object.keys(a).length && (p(`$request->setQueryData(${es(a, l)});`), u()),
                    Object.keys(n).length && (p(`$request->setHeaders(${es(n, l)});`), u()),
                    Object.keys(s).length && (p(`$request->setCookies(${es(s, l)});`), u()),
                    r.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      (p(`$request->setContentType(${es(r.mimeType)});`),
                        p(`$request->setPostFields(${es(r.paramsObj, l)});`),
                        u());
                      break;
                    case "application/json":
                      (p(`$request->setContentType(${es(r.mimeType)});`),
                        p(`$request->setBody(json_encode(${es(r.jsonObj, l)}));`),
                        u());
                      break;
                    default:
                      r.text && (p(`$request->setBody(${es(r.text)});`), u());
                  }
                  return (
                    p("try {"),
                    p("$response = $request->send();", 1),
                    u(),
                    p("echo $response->getBody();", 1),
                    p("} catch (HttpException $ex) {"),
                    p("echo $ex;", 1),
                    p("}"),
                    !d && o && (u(), p("?>")),
                    m()
                  );
                },
              },
              http2: {
                info: {
                  key: "http2",
                  title: "HTTP v2",
                  link: "http://devel-m6w6.rhcloud.com/mdref/http",
                  description: "PHP with pecl/http v2",
                  extname: ".php",
                },
                convert: (
                  { postData: e, headersObj: t, method: r, queryObj: a, cookiesObj: n, url: s },
                  i = {},
                ) => {
                  let {
                      closingTag: o = !1,
                      indent: l = "  ",
                      noTags: d = !1,
                      shortTags: c = !1,
                    } = i,
                    { push: p, blank: u, join: m } = new H({ indent: l }),
                    h = !1;
                  switch (
                    (!d && (p(c ? "<?" : "<?php"), u()),
                    p("$client = new http\\Client;"),
                    p("$request = new http\\Client\\Request;"),
                    u(),
                    e.mimeType)
                  ) {
                    case "application/x-www-form-urlencoded":
                      (p("$body = new http\\Message\\Body;"),
                        p(`$body->append(new http\\QueryString(${es(e.paramsObj, l)}));`),
                        u(),
                        (h = !0));
                      break;
                    case "multipart/form-data": {
                      if (!e.params) {
                        break;
                      }
                      let r = [],
                        a = {};
                      e.params.forEach(({ name: e, fileName: t, value: n, contentType: s }) => {
                        if (t) {
                          return void r.push({ name: e, type: s, file: t, data: n });
                        }
                        n && (a[e] = n);
                      });
                      let n = Object.keys(a).length ? es(a, l) : "null",
                        s = r.length ? es(r, l) : "null";
                      if (
                        (p("$body = new http\\Message\\Body;"),
                        p(`$body->addForm(${n}, ${s});`),
                        D(t, "content-type") && L(t, "content-type")?.indexOf("boundary"))
                      ) {
                        let e = R(t, "content-type");
                        e && delete t[e];
                      }
                      (u(), (h = !0));
                      break;
                    }
                    case "application/json":
                      (p("$body = new http\\Message\\Body;"),
                        p(`$body->append(json_encode(${es(e.jsonObj, l)}));`),
                        (h = !0));
                      break;
                    default:
                      e.text &&
                        (p("$body = new http\\Message\\Body;"),
                        p(`$body->append(${es(e.text)});`),
                        u(),
                        (h = !0));
                  }
                  return (
                    p(`$request->setRequestUrl(${es(s)});`),
                    p(`$request->setRequestMethod(${es(r)});`),
                    h && (p("$request->setBody($body);"), u()),
                    Object.keys(a).length &&
                      (p(`$request->setQuery(new http\\QueryString(${es(a, l)}));`), u()),
                    Object.keys(t).length && (p(`$request->setHeaders(${es(t, l)});`), u()),
                    Object.keys(n).length && (u(), p(`$client->setCookies(${es(n, l)});`), u()),
                    p("$client->enqueue($request)->send();"),
                    p("$response = $client->getResponse();"),
                    u(),
                    p("echo $response->getBody();"),
                    !d && o && (u(), p("?>")),
                    m()
                  );
                },
              },
            },
          },
          powershell: {
            info: { key: "powershell", title: "Powershell", default: "webrequest" },
            clientsById: { webrequest: ed, restmethod: el },
          },
          python: {
            info: { key: "python", title: "Python", default: "requests", cli: "python3 %s" },
            clientsById: {
              requests: {
                info: {
                  key: "requests",
                  title: "Requests",
                  link: "http://docs.python-requests.org/en/latest/api/#requests.request",
                  description: "Requests HTTP library",
                  extname: ".py",
                  installation: () => "python -m pip install requests",
                },
                convert: ({ fullUrl: e, postData: t, allHeaders: r, method: a }, n) => {
                  let s = { indent: "    ", pretty: !0, ...n },
                    {
                      push: i,
                      blank: o,
                      join: l,
                      addPostProcessor: d,
                    } = new H({ indent: s.indent });
                  (i("import requests"), o(), i(`url = "${e}"`), o());
                  let c = {},
                    p = {},
                    u = !1,
                    m = !1,
                    h = !1;
                  switch (t.mimeType) {
                    case "application/json":
                      t.jsonObj && (i(`payload = ${ep(t.jsonObj, s)}`), (h = !0), (m = !0));
                      break;
                    case "multipart/form-data":
                      if (!t.params) {
                        break;
                      }
                      if (
                        ((c = {}),
                        t.params.forEach((e) => {
                          e.fileName
                            ? (e.contentType
                                ? (p[e.name] =
                                    `('${e.fileName}', open('${e.fileName}', 'rb'), '${e.contentType}')`)
                                : (p[e.name] = `('${e.fileName}', open('${e.fileName}', 'rb'))`),
                              (u = !0))
                            : ((c[e.name] = e.value), (m = !0));
                        }),
                        u)
                      ) {
                        (i(`files = ${ep(p, s)}`), m && i(`payload = ${ep(c, s)}`));
                        let e = R(r, "content-type");
                        e && delete r[e];
                      } else {
                        let e = JSON.stringify(t.text);
                        e && (i(`payload = ${e}`), (m = !0));
                      }
                      d((e) =>
                        e
                          .replace(
                            /"\('(.+)', open\('(.+)', 'rb'\)\)"/g,
                            '("$1", open("$2", "rb"))',
                          )
                          .replace(
                            /"\('(.+)', open\('(.+)', 'rb'\), '(.+)'\)"/g,
                            '("$1", open("$2", "rb"), "$3")',
                          ),
                      );
                      break;
                    default: {
                      if ("application/x-www-form-urlencoded" === t.mimeType && t.paramsObj) {
                        (i(`payload = ${ep(t.paramsObj, s)}`), (m = !0));
                        break;
                      }
                      let e = JSON.stringify(t.text);
                      e && (i(`payload = ${e}`), (m = !0));
                    }
                  }
                  let x = Object.keys(r).length;
                  if (0 === x && (m || u)) {
                    o();
                  } else if (1 === x) {
                    Object.keys(r).forEach((e) => {
                      (i(`headers = {"${e}": "${V(r[e])}"}`), o());
                    });
                  } else if (x > 1) {
                    let e = 1;
                    (i("headers = {"),
                      Object.keys(r).forEach((t) => {
                        (e !== x ? i(`"${t}": "${V(r[t])}",`, 1) : i(`"${t}": "${V(r[t])}"`, 1),
                          (e += 1));
                      }),
                      i("}"),
                      o());
                  }
                  let g = eu.includes(a)
                    ? `response = requests.${a.toLowerCase()}(url`
                    : `response = requests.request("${a}", url`;
                  return (
                    m && (h ? (g += ", json=payload") : (g += ", data=payload")),
                    u && (g += ", files=files"),
                    x > 0 && (g += ", headers=headers"),
                    i((g += ")")),
                    o(),
                    i("print(response.text)"),
                    l()
                  );
                },
              },
            },
          },
          r: {
            info: { key: "r", title: "R", default: "httr" },
            clientsById: {
              httr: {
                info: {
                  key: "httr",
                  title: "httr",
                  link: "https://cran.r-project.org/web/packages/httr/vignettes/quickstart.html",
                  description: "httr: Tools for Working with URLs and HTTP",
                  extname: ".r",
                },
                convert: ({
                  url: e,
                  queryObj: t,
                  queryString: r,
                  postData: a,
                  allHeaders: n,
                  method: s,
                }) => {
                  let { push: i, blank: o, join: l } = new H();
                  (i("library(httr)"), o(), i(`url <- "${e}"`), o(), delete t.key);
                  let d = Object.keys(t).length;
                  1 === r.length
                    ? (i(
                        `queryString <- list(${Object.keys(t)} = "${Object.values(t).toString()}")`,
                      ),
                      o())
                    : r.length > 1 &&
                      (i("queryString <- list("),
                      Object.keys(t).forEach((e, r) => {
                        r !== d - 1
                          ? i(`  ${e} = "${t[e].toString()}",`)
                          : i(`  ${e} = "${t[e].toString()}"`);
                      }),
                      i(")"),
                      o());
                  let c = JSON.stringify(a.text);
                  if ((c && (i(`payload <- ${c}`), o()), a.text || a.jsonObj || a.params)) {
                    switch (a.mimeType) {
                      case "application/x-www-form-urlencoded":
                        (i('encode <- "form"'), o());
                        break;
                      case "application/json":
                        (i('encode <- "json"'), o());
                        break;
                      case "multipart/form-data":
                        (i('encode <- "multipart"'), o());
                        break;
                      default:
                        (i('encode <- "raw"'), o());
                    }
                  }
                  let p = L(n, "cookie"),
                    u = L(n, "accept"),
                    m = p
                      ? `set_cookies(\`${String(p).replace(/;/g, '", `').replace(/` /g, "`").replace(/[=]/g, '` = "')}")`
                      : void 0,
                    h = u ? `accept("${V(u)}")` : void 0,
                    x = `content_type("${V(a.mimeType)}")`,
                    g = Object.entries(n)
                      .filter(
                        ([e]) => !["cookie", "accept", "content-type"].includes(e.toLowerCase()),
                      )
                      .map(([e, t]) => `'${e}' = '${z(t)}'`)
                      .join(", "),
                    f = g ? `add_headers(${g})` : void 0,
                    y = `response <- VERB("${s}", url`;
                  (c && (y += ", body = payload"), r.length && (y += ", query = queryString"));
                  let b = [f, x, h, m].filter((e) => !!e).join(", ");
                  return (
                    b && (y += `, ${b}`),
                    (a.text || a.jsonObj || a.params) && (y += ", encode = encode"),
                    i((y += ")")),
                    o(),
                    i('content(response, "text")'),
                    l()
                  );
                },
              },
            },
          },
          ruby: {
            info: { key: "ruby", title: "Ruby", default: "native" },
            clientsById: {
              native: {
                info: {
                  key: "native",
                  title: "net::http",
                  link: "http://ruby-doc.org/stdlib-2.2.1/libdoc/net/http/rdoc/Net/HTTP.html",
                  description: "Ruby HTTP client",
                  extname: ".rb",
                },
                convert: ({ uriObj: e, method: t, fullUrl: r, postData: a, allHeaders: n }) => {
                  let { push: s, blank: i, join: o } = new H();
                  (s("require 'uri'"), s("require 'net/http'"), i());
                  let l = t.toUpperCase(),
                    d = l.charAt(0) + l.substring(1).toLowerCase();
                  ([
                    "GET",
                    "POST",
                    "HEAD",
                    "DELETE",
                    "PATCH",
                    "PUT",
                    "OPTIONS",
                    "COPY",
                    "LOCK",
                    "UNLOCK",
                    "MOVE",
                    "TRACE",
                  ].includes(l) ||
                    (s(`class Net::HTTP::${d} < Net::HTTPRequest`),
                    s(`  METHOD = '${l.toUpperCase()}'`),
                    s(`  REQUEST_HAS_BODY = '${a.text ? "true" : "false"}'`),
                    s("  RESPONSE_HAS_BODY = true"),
                    s("end"),
                    i()),
                    s(`url = URI("${r}")`),
                    i(),
                    s("http = Net::HTTP.new(url.host, url.port)"),
                    "https:" === e.protocol && s("http.use_ssl = true"),
                    i(),
                    s(`request = Net::HTTP::${d}.new(url)`));
                  let c = Object.keys(n);
                  return (
                    c.length &&
                      c.forEach((e) => {
                        s(`request["${e}"] = '${z(n[e])}'`);
                      }),
                    a.text && s(`request.body = ${JSON.stringify(a.text)}`),
                    i(),
                    s("response = http.request(request)"),
                    s("puts response.read_body"),
                    o()
                  );
                },
              },
            },
          },
          shell: {
            info: { key: "shell", title: "Shell", default: "curl", cli: "%s" },
            clientsById: {
              curl: {
                info: {
                  key: "curl",
                  title: "cURL",
                  link: "http://curl.haxx.se/",
                  description:
                    "cURL is a command line tool and library for transferring data with URL syntax",
                  extname: ".sh",
                },
                convert: (
                  {
                    fullUrl: e,
                    method: t,
                    httpVersion: r,
                    headersObj: a,
                    allHeaders: n,
                    postData: s,
                  },
                  i = {},
                ) => {
                  let { indent: o = "  ", short: l = !1, binary: d = !1, globOff: c = !1 } = i,
                    { push: p, join: u } = new H({
                      ...("string" == typeof o ? { indent: o } : {}),
                      join:
                        !1 !== o
                          ? ` \\
${o}`
                          : " ",
                    }),
                    m = (e) => {
                      if (l) {
                        let t = eh[e];
                        return t ? `-${t}` : "";
                      }
                      return `--${e}`;
                    },
                    h = em(e);
                  if (
                    (p(`curl ${m("request")} ${t}`),
                    c && ((h = unescape(h)), p(m("globoff"))),
                    p(`${m("url ")}${h}`),
                    "HTTP/1.0" === r && p(m("http1.0")),
                    L(n, "accept-encoding") && p("--compressed"),
                    "multipart/form-data" === s.mimeType)
                  ) {
                    let e = R(a, "content-type");
                    if (e) {
                      let t = a[e];
                      if (e && t) {
                        let r = String(t).replace(/; boundary.+?(?=(;|$))/, "");
                        ((a[e] = r), (n[e] = r));
                      }
                    }
                  }
                  switch (
                    (Object.keys(a)
                      .toSorted()
                      .forEach((e) => {
                        let t = `${e}: ${a[e]}`;
                        p(`${m("header")} ${em(t)}`);
                      }),
                    n.cookie && p(`${m("cookie")} ${em(n.cookie)}`),
                    s.mimeType)
                  ) {
                    case "multipart/form-data":
                      s.params?.forEach((e) => {
                        let t = "";
                        ((t = e.fileName
                          ? `${e.name}='@${e.fileName}'`
                          : em(`${e.name}=${e.value}`)),
                          p(`${m("form")} ${t}`));
                      });
                      break;
                    case "application/x-www-form-urlencoded":
                      s.params
                        ? s.params.forEach((e) => {
                            let t = e.name,
                              r = encodeURIComponent(e.name),
                              a = r !== t,
                              n = d ? "--data-binary" : a ? "--data-urlencode" : m("data");
                            p(`${n} ${em(`${a ? r : t}=${e.value}`)}`);
                          })
                        : p(`${d ? "--data-binary" : m("data")} ${em(s.text)}`);
                      break;
                    default: {
                      let e;
                      if (!s.text) {
                        break;
                      }
                      let t = !1;
                      if (
                        ((e = s.mimeType),
                        [
                          "application/json",
                          "application/x-json",
                          "text/json",
                          "text/x-json",
                          "+json",
                        ].some((t) => e.indexOf(t) > -1) && s.text.length > 20)
                      ) {
                        try {
                          let e = JSON.parse(s.text);
                          ((t = !0),
                            s.text.indexOf("'") > 0
                              ? p(`${d ? "--data-binary" : m("data")} @- <<EOF
${JSON.stringify(e, null, "  ")}
EOF`)
                              : p(`${d ? "--data-binary" : m("data")} '
${JSON.stringify(e, null, "  ")}
'`));
                        } catch {}
                      }
                      t || p(`${d ? "--data-binary" : m("data")} ${em(s.text)}`);
                    }
                  }
                  return u();
                },
              },
              httpie: {
                info: {
                  key: "httpie",
                  title: "HTTPie",
                  link: "http://httpie.org/",
                  description: "a CLI, cURL-like tool for humans",
                  extname: ".sh",
                  installation: () => "brew install httpie",
                },
                convert: (
                  { allHeaders: e, postData: t, queryObj: r, fullUrl: a, method: n, url: s },
                  i,
                ) => {
                  let o = {
                      body: !1,
                      cert: !1,
                      headers: !1,
                      indent: "  ",
                      pretty: !1,
                      print: !1,
                      queryParams: !1,
                      short: !1,
                      style: !1,
                      timeout: !1,
                      verbose: !1,
                      verify: !1,
                      ...i,
                    },
                    {
                      push: l,
                      join: d,
                      unshift: c,
                    } = new H({
                      indent: o.indent,
                      join:
                        !1 !== o.indent
                          ? ` \\
${o.indent}`
                          : " ",
                    }),
                    p = !1,
                    u = [];
                  (o.headers && u.push(o.short ? "-h" : "--headers"),
                    o.body && u.push(o.short ? "-b" : "--body"),
                    o.verbose && u.push(o.short ? "-v" : "--verbose"),
                    o.print && u.push(`${o.short ? "-p" : "--print"}=${o.print}`),
                    o.verify && u.push(`--verify=${o.verify}`),
                    o.cert && u.push(`--cert=${o.cert}`),
                    o.pretty && u.push(`--pretty=${o.pretty}`),
                    o.style && u.push(`--style=${o.style}`),
                    o.timeout && u.push(`--timeout=${o.timeout}`),
                    o.queryParams &&
                      Object.keys(r).forEach((e) => {
                        let t = r[e];
                        Array.isArray(t)
                          ? t.forEach((t) => {
                              l(`${e}==${em(t)}`);
                            })
                          : l(`${e}==${em(t)}`);
                      }),
                    Object.keys(e)
                      .toSorted()
                      .forEach((t) => {
                        l(`${t}:${em(e[t])}`);
                      }),
                    "application/x-www-form-urlencoded" === t.mimeType
                      ? t.params?.length &&
                        (u.push(o.short ? "-f" : "--form"),
                        t.params.forEach((e) => {
                          l(`${e.name}=${em(e.value)}`);
                        }))
                      : (p = !0));
                  let m = u.length ? `${u.join(" ")} ` : "";
                  if (((s = em(o.queryParams ? s : a)), c(`http ${m}${n} ${s}`), p && t.text)) {
                    let e = em(t.text);
                    c(`echo ${e} | `);
                  }
                  return d();
                },
              },
              wget: {
                info: {
                  key: "wget",
                  title: "Wget",
                  link: "https://www.gnu.org/software/wget/",
                  description: "a free software package for retrieving files using HTTP, HTTPS",
                  extname: ".sh",
                },
                convert: ({ method: e, postData: t, allHeaders: r, fullUrl: a }, n) => {
                  let s = { indent: "  ", short: !1, verbose: !1, ...n },
                    { push: i, join: o } = new H({
                      ...("string" == typeof s.indent ? { indent: s.indent } : {}),
                      join:
                        !1 !== s.indent
                          ? ` \\
${s.indent}`
                          : " ",
                    });
                  return (
                    s.verbose
                      ? i(`wget ${s.short ? "-v" : "--verbose"}`)
                      : i(`wget ${s.short ? "-q" : "--quiet"}`),
                    i(`--method ${em(e)}`),
                    Object.keys(r).forEach((e) => {
                      let t = `${e}: ${r[e]}`;
                      i(`--header ${em(t)}`);
                    }),
                    t.text &&
                      i(`--body-data ${em(t.text).replace(/\r/g, "\\r").replace(/\n/g, "\\n")}`),
                    i(s.short ? "-O" : "--output-document"),
                    i(`- ${em(a)}`),
                    o()
                  );
                },
              },
            },
          },
          swift: {
            info: { key: "swift", title: "Swift", default: "urlsession" },
            clientsById: {
              urlsession: {
                info: {
                  key: "urlsession",
                  title: "URLSession",
                  link: "https://developer.apple.com/documentation/foundation/urlsession",
                  description: "Foundation's URLSession request",
                  extname: ".swift",
                },
                convert: ({ allHeaders: e, postData: t, uriObj: r, queryObj: a, method: n }, s) => {
                  let i = { indent: "  ", pretty: !0, timeout: 10, ...s },
                    { push: o, blank: l, join: d } = new H({ indent: i.indent });
                  (o("import Foundation"), l());
                  let c = t.text || t.jsonObj || t.params;
                  if (c) {
                    switch (t.mimeType) {
                      case "application/x-www-form-urlencoded":
                        if (t.params?.length) {
                          let e = t.params.map((e) => `"${e.name}": "${e.value}"`);
                          (i.pretty
                            ? (o("let parameters = ["),
                              e.forEach((e) => {
                                o(`${e},`, 1);
                              }),
                              o("]"))
                            : o(`let parameters = [${e.join(", ")}]`),
                            o(
                              'let joinedParameters = parameters.map { "\\($0.key)=\\($0.value)" }.joined(separator: "&")',
                            ),
                            o("let postData = Data(joinedParameters.utf8)"),
                            l());
                        }
                        break;
                      case "application/json":
                        t.jsonObj &&
                          (o(`${ef("parameters", t.jsonObj, i)} as [String : Any?]`),
                          l(),
                          o(
                            "let postData = try JSONSerialization.data(withJSONObject: parameters, options: [])",
                          ),
                          l());
                        break;
                      case "multipart/form-data":
                        (o(ef("parameters", t.params, i)),
                          l(),
                          o(`let boundary = "${t.boundary}"`),
                          l(),
                          o('var body = ""'),
                          o("for param in parameters {"),
                          o('let paramName = param["name"]!', 1),
                          o('body += "--\\(boundary)\\r\\n"', 1),
                          o('body += "Content-Disposition:form-data; name=\\"\\(paramName)\\""', 1),
                          o('if let filename = param["fileName"] {', 1),
                          o('let contentType = param["contentType"]!', 2),
                          o(
                            "let fileContent = try String(contentsOfFile: filename, encoding: .utf8)",
                            2,
                          ),
                          o('body += "; filename=\\"\\(filename)\\"\\r\\n"', 2),
                          o('body += "Content-Type: \\(contentType)\\r\\n\\r\\n"', 2),
                          o("body += fileContent", 2),
                          o('} else if let paramValue = param["value"] {', 1),
                          o('body += "\\r\\n\\r\\n\\(paramValue)"', 2),
                          o("}", 1),
                          o("}"),
                          l(),
                          o("let postData = Data(body.utf8)"),
                          l());
                        break;
                      default:
                        (o(`let postData = Data("${t.text}".utf8)`), l());
                    }
                  }
                  o(`let url = URL(string: "${r.href}")!`);
                  let p = a ? Object.entries(a) : [];
                  return (
                    p.length < 1
                      ? o("var request = URLRequest(url: url)")
                      : (o(
                          "var components = URLComponents(url: url, resolvingAgainstBaseURL: true)!",
                        ),
                        o("let queryItems: [URLQueryItem] = ["),
                        p.forEach((e) => {
                          let t = e[0],
                            r = e[1];
                          switch (Object.prototype.toString.call(r)) {
                            case "[object String]":
                              o(`URLQueryItem(name: "${t}", value: "${r}"),`, 1);
                              break;
                            case "[object Array]":
                              r.forEach((e) => {
                                o(`URLQueryItem(name: "${t}", value: "${e}"),`, 1);
                              });
                          }
                        }),
                        o("]"),
                        o(
                          "components.queryItems = components.queryItems.map { $0 + queryItems } ?? queryItems",
                        ),
                        l(),
                        o("var request = URLRequest(url: components.url!)")),
                    o(`request.httpMethod = "${n}"`),
                    o(`request.timeoutInterval = ${i.timeout}`),
                    Object.keys(e).length && o(`request.allHTTPHeaderFields = ${ey(e, i)}`),
                    c && o("request.httpBody = postData"),
                    l(),
                    o("let (data, _) = try await URLSession.shared.data(for: request)"),
                    o("print(String(decoding: data, as: UTF8.self))"),
                    d()
                  );
                },
              },
            },
          },
        };
      class ev {
        constructor(e, t = {}) {
          ((this.initCalled = !1),
            (this.entries = []),
            (this.requests = []),
            (this.options = {}),
            (this.options = { harIsAlreadyEncoded: !1, ...t }),
            (this.requests = []),
            ((e) =>
              "object" == typeof e &&
              "log" in e &&
              "object" == typeof e.log &&
              "entries" in e.log &&
              Array.isArray(e.log.entries))(e)
              ? (this.entries = e.log.entries)
              : (this.entries = [{ request: e }]));
        }
        init() {
          return (
            (this.initCalled = !0),
            (this.requests = this.entries.map(({ request: e }) => {
              let t = {
                bodySize: 0,
                headersSize: 0,
                headers: [],
                cookies: [],
                httpVersion: "HTTP/1.1",
                queryString: [],
                postData: { mimeType: e.postData?.mimeType || "application/octet-stream" },
                ...e,
              };
              return (
                t.postData &&
                  !t.postData.mimeType &&
                  (t.postData.mimeType = "application/octet-stream"),
                this.prepare(t, this.options)
              );
            })),
            this
          );
        }
        prepare(e, t) {
          let r,
            a = {
              ...e,
              fullUrl: "",
              uriObj: {},
              queryObj: {},
              headersObj: {},
              cookiesObj: {},
              allHeaders: {},
            };
          if (
            (a?.queryString.length && (a.queryObj = a.queryString.reduce(M, {})), a?.headers.length)
          ) {
            let e = /^HTTP\/2/;
            a.headersObj = a.headers.reduce((t, { name: r, value: n }) => {
              let s = e.exec(a.httpVersion) ? r.toLocaleLowerCase() : r;
              return { ...t, [s]: n };
            }, {});
          }
          a?.cookies.length &&
            (a.cookiesObj = a.cookies.reduceRight(
              (e, { name: t, value: r }) => ({ ...e, [t]: r }),
              {},
            ));
          let n = a.cookies?.map(({ name: e, value: r }) =>
            t.harIsAlreadyEncoded
              ? `${e}=${r}`
              : `${encodeURIComponent(e)}=${encodeURIComponent(r)}`,
          );
          switch ((n?.length && (a.allHeaders.cookie = n.join("; ")), a.postData.mimeType)) {
            case "multipart/mixed":
            case "multipart/related":
            case "multipart/form-data":
            case "multipart/alternative":
              if (
                ((a.postData.text = ""),
                (a.postData.mimeType = "multipart/form-data"),
                a.postData?.params)
              ) {
                let e = "---011000010111000001101001",
                  t = `${e}--`,
                  r = (e) => e.replace(/\r?\n|\r/g, "\r\n"),
                  n = [`--${e}`];
                (a.postData?.params.forEach((t, s) => {
                  let i = t.name,
                    o = t.value || "",
                    l = t.fileName || null,
                    d = t.contentType || "application/octet-stream";
                  (l
                    ? (n.push(
                        `Content-Disposition: form-data; name="${r(i).replace(/\n/g, "%0A").replace(/\r/g, "%0D").replace(/"/g, "%22")}"; filename="${l}"`,
                      ),
                      n.push(`Content-Type: ${d}`))
                    : n.push(`Content-Disposition: form-data; name="${escape(r(i))}"`),
                    n.push(""),
                    n.push(r(o)),
                    s !== a.postData.params.length - 1 && n.push(`--${e}`));
                }),
                  n.push(`--${t}`),
                  (a.postData.boundary = e),
                  (a.postData.text = n.join("\r\n")));
                let s = R(a.headersObj, "content-type") || "content-type";
                a.headersObj[s] = `multipart/form-data; boundary=${e}`;
              }
              break;
            case "application/x-www-form-urlencoded":
              a.postData.params
                ? ((a.postData.paramsObj = a.postData.params.reduce(M, {})),
                  (a.postData.text = (0, F.stringify)(a.postData.paramsObj)))
                : (a.postData.text = "");
              break;
            case "text/json":
            case "text/x-json":
            case "application/json":
            case "application/x-json":
              if (((a.postData.mimeType = "application/json"), a.postData.text)) {
                try {
                  a.postData.jsonObj = JSON.parse(a.postData.text);
                } catch {
                  a.postData.mimeType = "text/plain";
                }
              }
          }
          let s = { ...a.allHeaders, ...a.headersObj },
            i = (function (e, t = !1, r = !1) {
              let a, n;
              if (!e) {
                return {
                  auth: null,
                  hash: null,
                  host: null,
                  hostname: null,
                  href: "",
                  path: null,
                  pathname: null,
                  protocol: null,
                  search: null,
                  slashes: null,
                  query: t ? {} : null,
                  port: null,
                };
              }
              let s = e;
              if (
                (r && !e.match(/^[a-z][a-z0-9+.-]*:/i) && (s = `http://${e}`),
                e.match(/^([a-z][a-z0-9+.-]*:\/\/)$/i))
              ) {
                return {
                  auth: null,
                  hash: null,
                  host: "",
                  hostname: "",
                  href: e,
                  path: null,
                  pathname: null,
                  protocol: e.match(/^[a-z][a-z0-9+.-]*:/i)?.[0] || null,
                  search: null,
                  slashes: !0,
                  query: t ? {} : null,
                  port: null,
                };
              }
              try {
                a = new URL(s);
              } catch {
                try {
                  a = new URL(s, "http://example.com");
                } catch {
                  return {
                    auth: null,
                    hash: null,
                    host: null,
                    hostname: null,
                    href: e,
                    path: null,
                    pathname: null,
                    protocol: null,
                    search: null,
                    slashes: null,
                    query: t ? {} : null,
                    port: null,
                  };
                }
              }
              let i =
                  a.username || a.password
                    ? `${decodeURIComponent(a.username)}${a.password ? `:${decodeURIComponent(a.password)}` : ""}`
                    : null,
                o = a.hostname || null;
              o && o.startsWith("[") && o.endsWith("]") && (o = o.slice(1, -1));
              let l = a.port || null,
                d = e.match(/:(\d+)(?:\/|$|\?|#)/);
              !l && d && (l = d[1]);
              let c = null;
              if (o) {
                let e = o.includes(":");
                c = l ? (e ? `[${o}]:${l}` : `${o}:${l}`) : o;
              }
              let p = e.indexOf("#"),
                u = e.indexOf("?"),
                m = -1 !== u && (-1 === p || u < p) && !a.search ? "?" : a.search || null,
                h = e.includes("#") && !a.hash ? "#" : a.hash || null,
                x = null;
              try {
                let e = s.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/i);
                x = e && e[1] ? e[1] : a.pathname || null;
              } catch {
                x = a.pathname || null;
              }
              let g = m ? `${x}${m}` : x;
              if (t) {
                if (m) {
                  let e = new URLSearchParams(m),
                    t = {};
                  for (let [r, a] of e.entries())
                    if (r in t) {
                      let e = t[r];
                      Array.isArray(e) ? e.push(a) : (t[r] = [e, a]);
                    } else t[r] = a;
                  n = t;
                } else n = {};
              } else {
                n = m ? m.slice(1) : null;
              }
              return {
                auth: i,
                hash: h,
                host: c,
                hostname: o,
                href: a.href,
                path: g,
                pathname: x,
                protocol: a.protocol || null,
                search: m,
                slashes: !!a.protocol || null,
                query: n,
                port: l,
              };
            })(a.url, !0, !0);
          ((a.queryObj = { ...a.queryObj, ...i.query }),
            (r = t.harIsAlreadyEncoded
              ? (0, F.stringify)(a.queryObj, { encode: !1, indices: !1 })
              : (0, F.stringify)(a.queryObj, { indices: !1 })));
          let o = {
              ...i,
              query: a.queryObj,
              search: r,
              path: r ? `${i.pathname}?${r}` : i.pathname,
            },
            l = B({ ...i, query: null, search: null }),
            d = B({ ...i, ...o });
          return { ...a, allHeaders: s, fullUrl: d, url: l, uriObj: o };
        }
        convert(e, t, r) {
          (this.initCalled || this.init(), !r && t && (r = { clientId: t }));
          let a = eb[e];
          if (!a) {
            return [!1];
          }
          let { convert: n } = a.clientsById[t || a.info.default];
          return this.requests.map((e) => n(e, r));
        }
        installation(e, t, r) {
          (this.initCalled || this.init(), !r && t && (r = { clientId: t }));
          let a = eb[e];
          if (!a) {
            return [!1];
          }
          let { info: n } = a.clientsById[t || a.info.default];
          return this.requests.map((e) => !!n?.installation && n.installation(e, r));
        }
      }
      var ej = r(20043),
        ek = r.n(ej);
      let ew = ({
          request: e,
          pathInputs: t,
          apiReferenceData: r,
          snippetPresets: a = j.SR,
          isMultipleRequest: n = !1,
        }) => {
          let s = {},
            i = e.url
              .replace(/:{[^{}]+}/g, (e) => {
                let t = ":62437";
                return ((s[t] = e), t);
              })
              .replace(/{[^{}]+}/g, (e) => {
                let r = t[e.slice(1, e.length - 1)];
                if (r && ("string" != typeof r || r.length > 0)) {
                  return `${encodeURIComponent(r.toString())}`;
                }
                let a = ek()();
                return ((s[a] = e), a);
              });
          if (
            !((e) => {
              try {
                return (new URL(e), !0);
              } catch (e) {
                return !1;
              }
            })(i)
          ) {
            return [
              {
                filename: "Error",
                code: "A valid request URL is required to generate request examples",
                language: "",
              },
            ];
          }
          let o = new ev({
            ...e,
            url: i,
            postData: e.postData || { mimeType: "application/json" },
          });
          return a
            .map((e) => {
              let { target: t, client: a } = e.httpSnippet;
              try {
                let i = o.convert(t, a),
                  l = eN(s, i.toString());
                return {
                  filename: n ? e.displayName : r.operation?.title || e.displayName,
                  code: l,
                  language: e.key,
                };
              } catch (t) {
                return (console.error(`Error generating snippet for ${e.key}:`, t), null);
              }
            })
            .filter((e) => null !== e);
        },
        eN = (e, t) => Object.entries(e).reduce((e, [t, r]) => e.replace(t, r), t),
        eC = (e, t, r, a, n) => {
          "" in a && ((a["Example 1"] = a[""]), delete a[""]);
          let s = Object.keys(a).length,
            i = e.label ?? (s > 0 ? `Example ${s + 1}` : "");
          a[i] = { filename: n ? r : i || r, language: t, code: e.source };
        };
      var eS = r(84941),
        eO = r(91619),
        e$ = r(49962),
        eT = r(57303),
        eE = r(76829),
        eA = r(15209),
        eP = r(67018),
        eI = r(22153),
        e_ = r(87799);
      let eq = ({ code: e }) => {
        let t = (0, eI.p)("docs.code_block.copy");
        return (0, a.jsx)("div", {
          "data-testid": "code-group-select-copy-button",
          children: (0, a.jsx)(e_.TN, { textToCopy: e, onCopied: (e, r) => t({ code: r }) }),
        });
      };
      var eF = r(72116),
        eR = r(6472);
      let eL = ({ selectedOption: e, setSelectedOption: t, options: r }) => {
          let n = r.length > 1,
            s = (0, eA.e)();
          return (0, a.jsxs)(eR.DropdownMenu, {
            children: [
              (0, a.jsx)(eR.DropdownMenuTrigger, {
                disabled: !n,
                className: (0, y.cn)(
                  "select-none bg-transparent px-2 py-[5px] text-xs font-medium min-w-16 flex-1 dark:bg-transparent",
                  "system" === s && "text-primary dark:text-primary-light",
                  "dark" === s && "text-primary-light",
                ),
                children: (0, a.jsxs)("div", {
                  className:
                    "flex gap-1.5 items-center px-2 py-1 group-hover:hover:bg-primary-light/10 rounded-lg min-w-16",
                  children: [
                    (0, a.jsx)("p", { className: "truncate", children: e }),
                    n && (0, a.jsx)(eF.A, { size: 12, className: "min-w-3" }),
                  ],
                }),
              }),
              (0, a.jsx)(eR.DropdownMenuContent, {
                className: (0, y.cn)(
                  "overflow-y-auto",
                  "system" === s &&
                    "border border-gray-200/70 dark:border-gray-800/50 bg-gray-50 dark:bg-[#0F1117]",
                  "dark" === s && "border-none bg-[#0F1117]",
                ),
                children: r.map((r, n) =>
                  (0, a.jsx)(
                    eR._,
                    {
                      onSelect: () => t(r),
                      className: (0, y.cn)(
                        "py-1.5 text-xs",
                        "system" === s &&
                          "hover:text-primary hover:bg-primary/10 dark:hover:text-primary-light dark:hover:bg-primary-light/10",
                        "dark" === s &&
                          "text-primary-light dark:text-primary-light hover:text-primary-light hover:bg-primary-light/10",
                        r === e &&
                          "system" === s &&
                          "text-primary dark:text-primary-light font-medium",
                        r === e &&
                          "dark" === s &&
                          "text-primary-light dark:text-primary-light font-medium",
                        r !== e && "system" === s && "text-gray-500 dark:text-white/50",
                        r !== e && "dark" === s && "text-white/50",
                      ),
                      children: r,
                    },
                    n,
                  ),
                ),
              }),
            ],
          });
        },
        eD = (0, n.memo)(function ({ snippets: e }) {
          let { setSelectedExampleIndex: t } = (0, n.useContext)(eT.z),
            r = (0, eA.e)(),
            { selectedLabel: s, setSelectedLabel: i } = m(),
            o = (0, eE.n)(),
            l = Object.keys(e),
            [d, c] = (0, n.useState)(l[0]),
            u = void 0 !== d ? e[d] : void 0,
            h = u ? Object.keys(u) : void 0,
            [x, g] = (0, n.useState)(h && h[0]),
            f = x && h?.includes(x) ? x : h?.[0],
            b = void 0 !== u && void 0 !== f ? u[f] : void 0;
          return (
            (0, n.useEffect)(() => {
              s && s !== f && h?.includes(s) && g(s);
            }, [s, h, f]),
            (0, a.jsxs)("div", {
              className: (0, y.cn)(
                "text-xs p-0.5 leading-6 rounded-2xl not-prose overflow-hidden relative max-w-full min-w-full",
                "system" === r &&
                  "bg-gray-50 dark:bg-white/5 border border-gray-950/10 dark:border-white/10",
                "dark" === r &&
                  "bg-codeblock dark:bg-white/5 ring-1 ring-transparent dark:ring-white/[0.14]",
              ),
              "data-testid": "code-group-select",
              children: [
                (0, a.jsxs)("div", {
                  className: "flex justify-between text-xs leading-6 rounded-t-2xl w-full",
                  children: [
                    (0, a.jsx)(eL, {
                      selectedOption: d,
                      setSelectedOption: (e) => {
                        c(e);
                      },
                      options: l,
                      "data-testid": "code-group-select-group",
                    }),
                    (0, a.jsxs)("div", {
                      className: "flex overflow-hidden",
                      children: [
                        h &&
                          (0, a.jsx)(eL, {
                            selectedOption: f,
                            setSelectedOption: (e) => {
                              (g(e), t?.(h?.indexOf(e) ?? 0), e !== s && i(e));
                            },
                            options: h,
                            "data-testid": "code-group-select-option",
                          }),
                        (0, a.jsxs)("div", {
                          className: "flex items-center gap-1.5 pr-2.5",
                          "data-testid": "code-group-select-copy-button",
                          children: [
                            (0, a.jsx)(eq, { code: b?.code ?? "" }),
                            (0, a.jsx)(eP.y, {
                              code: b?.code ?? "",
                              filename: b?.filename,
                              language: b?.language,
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                (0, a.jsx)("div", {
                  role: "region",
                  "aria-label": o["aria.codeSnippet"],
                  className: (0, y.cn)(
                    "dark:bg-codeblock not-prose rounded-xt p-5 min-w-full max-w-0 overflow-x-auto max-h-[calc(100%-34px)] w-full scrollbar-track-transparent scrollbar-thin scrollbar-thumb-rounded text-xs leading-[1.35rem]",
                    "system" === r &&
                      "bg-white text-gray-950 dark:text-gray-50 scrollbar-thumb-black/20 dark:scrollbar-thumb-white/10 codeblock-light",
                    "dark" === r &&
                      "bg-codeblock text-gray-50 scrollbar-thumb-white/25 dark:scrollbar-thumb-white/10 codeblock-dark",
                  ),
                  children: (0, a.jsx)(p.z, { language: b?.language, children: b?.code }),
                }),
              ],
            })
          );
        }),
        eM = ({ snippets: e, dropdown: t, ...r }) =>
          (0, a.jsx)(l.l, {
            isSmallText: !0,
            ...r,
            dropdown: t,
            children: e.map(({ code: e, ...t }) =>
              (0, a.jsx)(
                o.N,
                {
                  language: t.language,
                  filename: t.filename,
                  hideCodeSnippetFeedbackButton: !0,
                  children: (0, a.jsx)(p.z, { language: t.language, children: e }),
                },
                t.filename,
              ),
            ),
          });
      var eB = r(40599),
        eH = r(12757),
        eU = r(48059);
      let ez = ({ snippets: e }) => {
          let t = (0, eA.e)(),
            { selectedLabel: r, setSelectedLabel: s } = m(),
            i = (0, eE.n)(),
            { setSelectedExampleIndex: o } = (0, eH.b)(),
            l = Object.keys(e),
            [d, c] = (0, n.useState)(l[0]),
            p = void 0 !== d ? e[d] : void 0,
            u = p ? Object.keys(p) : void 0,
            [h, x] = (0, n.useState)(u && u[0]),
            g = h && u?.includes(h) ? h : u?.[0],
            f = void 0 !== p && void 0 !== g ? p[g] : void 0;
          return (
            (0, n.useEffect)(() => {
              r && r !== g && u?.includes(r) && x(r);
            }, [r, u, g]),
            (0, a.jsxs)("div", {
              className: (0, y.cn)(
                "text-xs p-0.5 leading-6 rounded-2xl not-prose overflow-hidden relative max-w-full min-w-full flex flex-col",
                "system" === t &&
                  "bg-gray-50 dark:bg-white/5 border border-gray-950/10 dark:border-white/10",
                "dark" === t &&
                  "bg-codeblock dark:bg-white/5 ring-1 ring-transparent dark:ring-white/[0.14]",
              ),
              "data-testid": "code-group-select",
              children: [
                (0, a.jsxs)("div", {
                  className: "flex justify-between text-xs leading-6 rounded-t-2xl w-full",
                  children: [
                    (0, a.jsx)(eL, {
                      selectedOption: d,
                      setSelectedOption: (e) => {
                        c(e);
                      },
                      options: l,
                      "data-testid": "code-group-select-group",
                    }),
                    (0, a.jsxs)("div", {
                      className: "flex overflow-hidden",
                      children: [
                        u &&
                          (0, a.jsx)(eL, {
                            selectedOption: g,
                            setSelectedOption: (e) => {
                              (x(e), o(u?.indexOf(e) ?? 0), e !== r && s(e));
                            },
                            options: u,
                            "data-testid": "code-group-select-option",
                          }),
                        (0, a.jsxs)("div", {
                          className: "flex items-center gap-1.5 pr-2.5",
                          "data-testid": "code-group-select-copy-button",
                          children: [
                            (0, a.jsx)(eq, { code: f?.code ?? "" }),
                            (0, a.jsx)(eP.y, {
                              code: f?.code ?? "",
                              filename: f?.filename,
                              language: f?.language,
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                (0, a.jsx)("div", {
                  role: "region",
                  "aria-label": i["aria.codeSnippet"],
                  className: "flex flex-1 overflow-hidden",
                  children: (0, a.jsx)("div", {
                    className: "w-full min-w-full max-w-full h-full max-h-full relative",
                    children: (0, a.jsx)(eU.S7, {
                      isParentCodeGroup: !0,
                      isSmallText: !0,
                      language: f?.language,
                      children: f?.code,
                    }),
                  }),
                }),
              ],
            })
          );
        },
        eV = ({
          baseUrl: e,
          apiReferenceData: t,
          inputs: r,
          requestExampleLanguages: n,
          requiredOnly: s,
          selectedSecurityOptionIndex: i,
          selectedRequestBodyContentTypeIndex: o,
        }) => {
          let l = t.dependencies?.requestBody;
          if (!l) {
            return (0, a.jsx)(eK, {
              apiReferenceData: t,
              baseUrl: e,
              inputs: r,
              requestExampleLanguages: n,
              requiredOnly: s,
              selectedSecurityOptionIndex: i,
            });
          }
          let d = (0, k.cn)(l.content, o);
          if (!d) {
            return null;
          }
          let c = Object.entries(l.content).map(([e, t]) => ({
              contentType: e,
              examples: t.examples,
            })),
            p = c[o]?.examples,
            u = c[o]?.contentType;
          return Object.keys(p).length > 1
            ? (0, a.jsx)(eW, {
                apiReferenceData: t,
                selectedBodyContentType: u,
                baseUrl: e,
                inputs: r,
                examples: p,
                requestExampleLanguages: n,
                requiredOnly: s,
                selectedSecurityOptionIndex: i,
              })
            : (0, a.jsx)(eK, {
                apiReferenceData: t,
                selectedBodyContentType: u,
                baseUrl: e,
                inputs: r,
                exampleValue: d,
                requestExampleLanguages: n,
                requiredOnly: s,
                selectedSecurityOptionIndex: i,
              });
        },
        eK = ({
          baseUrl: e,
          apiReferenceData: t,
          inputs: r,
          selectedBodyContentType: n,
          exampleValue: s,
          requestExampleLanguages: i,
          requiredOnly: o,
          selectedSecurityOptionIndex: l,
        }) => {
          let d,
            c = _({
              baseUrl: e,
              apiReferenceData: t,
              inputs: r,
              selectedBodyContentType: n,
              exampleData: s,
              requiredOnly: o,
              selectedSecurityOptionIndex: l,
              exampleType: t.dependencies?.requestBody?.exampleType,
            }),
            p = i?.reduce((e, t) => {
              let r = j.t1[t];
              return (r && e.push(r), e);
            }, []);
          try {
            d = ew({ apiReferenceData: t, pathInputs: r.path, request: c, snippetPresets: p });
          } catch (e) {
            return (console.error(e), null);
          }
          return (0, a.jsx)(eM, { snippets: d, noMargins: !0, dropdown: !0 });
        },
        eW = ({
          baseUrl: e,
          apiReferenceData: t,
          inputs: r,
          selectedBodyContentType: n,
          examples: s,
          requestExampleLanguages: i,
          requiredOnly: o,
          selectedSecurityOptionIndex: l,
        }) => {
          let d = {},
            c = r.path,
            p = i?.reduce((e, t) => {
              let r = j.t1[t];
              return (r && e.push(r), e);
            }, []);
          for (let [a, { value: i }] of Object.entries(s)) {
            if (!i) {
              continue;
            }
            let s = _({
              baseUrl: e,
              apiReferenceData: t,
              inputs: r,
              selectedBodyContentType: n,
              exampleData: i,
              requiredOnly: o,
              selectedSecurityOptionIndex: l,
              exampleType: t.dependencies?.requestBody?.exampleType,
            });
            try {
              ew({
                apiReferenceData: t,
                pathInputs: c,
                request: s,
                snippetPresets: p,
                isMultipleRequest: !0,
              }).forEach((e) => {
                d[e.filename] = { ...d[e.filename], [a]: e };
              });
            } catch (e) {
              return (console.error(e), null);
            }
          }
          return (0, a.jsx)(ez, { snippets: d });
        },
        eG = (0, n.memo)(({ apiReferenceData: e, inputs: t = b.x4 }) => {
          let r = e.operation?.requestExamples,
            { selectedRequestBodyContentTypeIndex: n } = (0, eO.d)(),
            { selectedSecurityOptionIndex: s } = (0, e$.a)(),
            i = (0, eB.D)(),
            d = e.operation?.requestExampleLanguages,
            c = e.operation?.requiredOnlyExamples,
            { baseUrl: u } = (0, eS.b)();
          switch (e.operation?.requestExampleType) {
            case "mdx":
              if (!r) {
                return null;
              }
              let m = r.some((e) => e.dropdown ?? !1);
              return (0, a.jsx)(l.l, {
                isSmallText: !0,
                noMargins: !0,
                dropdown: m,
                children: r.map((e) =>
                  (0, a.jsx)(
                    o.N,
                    {
                      language: e.language,
                      filename: e.filename,
                      children: (0, a.jsx)("span", { children: e.code }),
                    },
                    e.filename,
                  ),
                ),
              });
            case "webhook":
              if (!r?.[0]?.code) {
                return null;
              }
              return (0, a.jsx)(l.l, {
                isSmallText: !0,
                noMargins: !0,
                hideCodeSnippetFeedbackButton: !0,
                children: (0, a.jsx)(o.N, {
                  language: "json",
                  filename: "Example Request Body",
                  children: (0, a.jsx)(p.z, { language: "json", children: r[0]?.code }),
                }),
              });
            case "codeSamples":
              if (!e.operation.codeSamples) {
                return null;
              }
              let h = (({
                codeSamples: e,
                apiReferenceData: t,
                baseUrl: r,
                inputs: a,
                apiPlaygroundMode: n,
                requestExampleLanguages: s,
                requiredOnly: i,
                selectedSecurityOptionIndex: o,
                selectedRequestBodyContentTypeIndex: l,
                disableCodeSampleGeneration: d,
              }) => {
                let c = !d && ((r && "none" !== n) || (r && s)),
                  p = s ?? [];
                return (
                  (e = e.map((e) => ({ ...e, lang: (0, j.mF)(e.lang) }))),
                  void 0 === s &&
                    (e.forEach((e) => {
                      p.includes(e.lang) || p.push(e.lang);
                    }),
                    c &&
                      v.forEach((e) => {
                        p.includes(e) || p.push(e);
                      })),
                  p.reduce((s, c) => {
                    let p = j.eR[c] ?? c,
                      u = e.filter((e) => e.lang === c),
                      m = s[p] ?? {};
                    if (0 === u.length) {
                      if (d) {
                        return s;
                      }
                      let e = (({
                        apiReferenceData: e,
                        baseUrl: t,
                        inputs: r,
                        apiPlaygroundMode: a,
                        lang: n,
                        requiredOnly: s,
                        selectedSecurityOptionIndex: i,
                        selectedRequestBodyContentTypeIndex: o,
                      }) => {
                        if (t && "none" !== a) {
                          let a = Object.keys(e.dependencies?.requestBody?.content ?? {})[o],
                            l = (0, k.cn)(e.dependencies?.requestBody?.content ?? {}, o);
                          try {
                            let o = _({
                                baseUrl: t,
                                apiReferenceData: e,
                                inputs: r,
                                exampleData: l,
                                selectedBodyContentType: a,
                                requiredOnly: s,
                                selectedSecurityOptionIndex: i,
                                exampleType: e.dependencies?.requestBody?.exampleType,
                              }),
                              d = j.t1[n];
                            if (void 0 == d) {
                              return;
                            }
                            let [c] = ew({
                              request: o,
                              pathInputs: r.path,
                              snippetPresets: [d],
                              apiReferenceData: e,
                            });
                            if (c) {
                              return {
                                label: "Interactive Example",
                                lang: c.language,
                                source: c.code,
                              };
                            }
                          } catch (e) {}
                        }
                      })({
                        baseUrl: r,
                        apiReferenceData: t,
                        inputs: a,
                        apiPlaygroundMode: n,
                        lang: c,
                        requiredOnly: i,
                        selectedSecurityOptionIndex: o,
                        selectedRequestBodyContentTypeIndex: l,
                      });
                      e && eC(e, c, p, m, !0);
                    } else {
                      u.forEach((e) => {
                        ((p = j.eR[c] ?? e.label ?? c), eC(e, c, p, m, !1));
                      });
                    }
                    return (Object.keys(m).length > 0 && (s[p] = m), s);
                  }, {})
                );
              })({
                apiReferenceData: e,
                codeSamples: e.operation.codeSamples,
                baseUrl: u,
                apiPlaygroundMode: i,
                requestExampleLanguages: d,
                requiredOnly: c,
                inputs: t,
                selectedSecurityOptionIndex: s,
                selectedRequestBodyContentTypeIndex: n,
                disableCodeSampleGeneration: e.operation.disableCodeSampleGeneration,
              });
              if (Object.values(h).every((e) => Object.keys(e).length <= 1)) {
                let e = Object.values(h).flatMap((e) => Object.values(e));
                return (
                  new Set(e.map((e) => e.filename)).size !== e.length &&
                    (e = e.map((e) => ({ ...e, filename: j.eR[e.language] ?? e.language }))),
                  (0, a.jsx)(eM, { snippets: e, noMargins: !0, dropdown: !0 })
                );
              }
              return (0, a.jsx)(eD, { snippets: h });
            case "generated":
              let x = u || "https://api.example.com";
              return (0, a.jsx)(eV, {
                apiReferenceData: e,
                baseUrl: x,
                inputs: t,
                selectedSecurityOptionIndex: s,
                requestExampleLanguages: d,
                requiredOnly: c,
                selectedRequestBodyContentTypeIndex: n,
              });
            default:
              return null;
          }
        });
      eG.displayName = "RequestExample";
      var eJ = r(61755);
      let eZ = ({ apiReferenceData: e }) => {
          let { selectedResponseContentTypeIndex: t } = (0, eJ.n)(),
            r = Object.values(e.dependencies?.responses ?? {});
          if (
            0 === Object.keys(r).length ||
            Object.values(r).every((e) => 0 === Object.keys(e).length)
          ) {
            return null;
          }
          let n = ((e, t) =>
            Object.entries(e)
              .toSorted()
              .reduce((e, [r, a]) => {
                let n = Object.keys(a),
                  s = void 0 !== t && n[t] ? a[n[t]] : a[n[0]];
                if (void 0 === s) {
                  return (
                    (e[r] = {
                      "": { filename: r, code: "This response has no body data.", language: "" },
                    }),
                    e
                  );
                }
                let i = s.examples,
                  o = i?.[0];
                if (o && "value" in o && void 0 === o.value) {
                  return (
                    (e[r] = {
                      "": {
                        filename: r,
                        code: "This response does not have an example.",
                        language: "",
                      },
                    }),
                    e
                  );
                }
                let l = Object.entries(i ?? {}).reduce((e, [t, a]) => {
                  let n = "value" in a ? a.value : a,
                    s = "title" in a && "string" == typeof a.title ? a.title : "",
                    i = JSON.stringify(n, null, 2);
                  return ((e[s] = { filename: r, language: "json", code: i }), e);
                }, {});
                return ((e[r] = l), e);
              }, {}))((0, $.F4)(e), t);
          if (Object.values(n).every((e) => Object.keys(e).length <= 1)) {
            let e = Object.values(n).flatMap((e) => Object.values(e));
            return (0, a.jsx)(eM, { snippets: e, noMargins: !0 });
          }
          return (0, a.jsx)(eD, { snippets: n });
        },
        eX = (0, n.memo)(({ apiReferenceData: e }) => {
          let t = e.operation?.responseExamples;
          if (e.operation?.responseExampleType !== "mdx") {
            return (0, a.jsx)(eZ, { apiReferenceData: e });
          }
          {
            if (!t) {
              return null;
            }
            let e = t.some((e) => e.dropdown ?? !1);
            return (0, a.jsx)(l.l, {
              isSmallText: !0,
              noMargins: !0,
              dropdown: e,
              children: t.map((e) =>
                (0, a.jsx)(
                  o.N,
                  {
                    language: e.language,
                    filename: e.filename,
                    children: (0, a.jsx)("span", { children: e.code }),
                  },
                  e.filename,
                ),
              ),
            });
          }
        });
      eX.displayName = "ResponseExample";
      let eY = ({ className: e, isModal: t = !1 }) => {
        let { apiReferenceData2: r } = (0, n.useContext)(h.ApiReferenceContext2),
          { isChatSheetOpen: i } = (0, n.useContext)(f.ChatAssistantContext),
          d = (0, s.tt)(100),
          [m, b] = (0, n.useState)(),
          v = (0, x.u)("request"),
          j = (0, x.u)("response"),
          k = (0, n.useMemo)(
            () =>
              (0, y.cn)(
                "w-full gap-6 grid grid-rows-[repeat(auto-fit,minmax(0,min-content))] grid-rows relative min-h-[18rem]",
                i ? "xl:w-auto" : "xl:w-[28rem]",
                t ? "max-h-[calc(100dvh-11rem)] overflow-y-auto" : "max-h-[calc(100%-32px)]",
                e,
              ),
            [e, t, i],
          );
        if (!r.operation) {
          if (r.schemaData && r.schemaData.example) {
            let e = r.schemaData.title || "Example",
              t = r.schemaData.example.value;
            return void 0 == t
              ? null
              : (0, a.jsx)("div", {
                  className: k,
                  children: (0, a.jsx)(l.l, {
                    isSmallText: !0,
                    noMargins: !0,
                    children: (0, a.jsx)(
                      o.N,
                      {
                        filename: e,
                        children: (0, a.jsx)(p.z, {
                          language: "json",
                          children: JSON.stringify(t, null, 2),
                        }),
                      },
                      "schema-example",
                    ),
                  }),
                });
          }
          return void 0 === v && void 0 === j
            ? null
            : (0, a.jsx)(u.Provider, {
                value: { selectedLabel: m, setSelectedLabel: b },
                children: (0, a.jsx)("div", {
                  className: k,
                  children: (0, a.jsxs)(g.A, {
                    children: [
                      void 0 !== v && (0, a.jsx)(c, { data: v }),
                      void 0 !== j && (0, a.jsx)(c, { data: j }),
                    ],
                  }),
                }),
              });
        }
        return (0, a.jsx)(u.Provider, {
          value: { selectedLabel: m, setSelectedLabel: b },
          children: (0, a.jsx)("div", {
            className: k,
            children: (0, a.jsxs)(g.A, {
              children: [
                (0, a.jsx)(eG, { apiReferenceData: r, inputs: d }),
                (0, a.jsx)(eX, { apiReferenceData: r }),
              ],
            }),
          }),
        });
      };
    },
    12158: (e, t, r) => {
      "use strict";
      (r.r(t),
        r.d(t, {
          ChatAssistantContext: () => et,
          DEBOUNCE_TIME_IN_MS: () => Q,
          DesktopSearchEntry: () => Y,
          SearchButton: () => Z,
          SearchContext: () => er,
          SearchProvider: () => ea,
        }));
      var a = r(54568),
        n = r(15146),
        s = r(64429),
        i = r(16207),
        o = r(43906),
        l = r.n(o),
        d = r(17635),
        c = r.n(d),
        p = r(65202),
        u = r(27541),
        m = r(7620),
        h = r(67908),
        x = r(30793),
        g = r(76829),
        f = r(98167),
        y = r(22153),
        b = r(65477),
        v = r(38637),
        j = r(27194),
        k = r(37113);
      let w = (e) => {
          let [t, r] = (0, m.useState)(!1);
          return (
            (0, m.useEffect)(() => {
              let t = (t) => {
                  switch (e) {
                    case "Meta":
                      return t.metaKey;
                    case "Control":
                      return t.ctrlKey;
                    case "Shift":
                      return t.shiftKey;
                    case "Alt":
                      return t.altKey;
                    default:
                      return !1;
                  }
                },
                a = (e) => {
                  t(e) && r(!0);
                },
                n = (e) => {
                  t(e) || r(!1);
                },
                s = () => {
                  r(!1);
                },
                i = (e) => {
                  r(t(e));
                };
              return (
                window.addEventListener("keydown", a),
                window.addEventListener("keyup", n),
                window.addEventListener("blur", s),
                window.addEventListener("mousedown", i),
                () => {
                  (window.removeEventListener("keydown", a),
                    window.removeEventListener("keyup", n),
                    window.removeEventListener("blur", s),
                    window.removeEventListener("mousedown", i));
                }
              );
            }, [e]),
            t
          );
        },
        N = "mintlify-recent-searches";
      var C = r(71826),
        S = r(35878),
        O = r(73205),
        $ = r(81325),
        T = r(66058),
        E = r(96924),
        A = r(16916),
        P = r(14486),
        I = r(94585),
        _ = r(68999);
      let q = ({ type: e, icon: t }) => {
          let r = "text-gray-500 dark:text-gray-400 h-4 w-4 shrink-0";
          return "api-playground" === e
            ? (0, a.jsx)(O.k3, { className: (0, $.cn)(r, "text-primary dark:text-primary-light") })
            : "section" === e
              ? (0, a.jsx)(O.y$, { className: r })
              : t
                ? (0, a.jsx)(_.ComponentIcon, {
                    icon: t,
                    iconType: "regular",
                    className: (0, $.cn)(r, "bg-gray-500 dark:bg-gray-400"),
                    overrideColor: !0,
                  })
                : (0, a.jsx)(O.Zw, { className: r });
        },
        F = "truncate text-sm leading-[18px] text-gray-800 dark:text-gray-200",
        R = "text-xs truncate w-full text-gray-500 [&_mark]:text-gray-500 [&_mark]:bg-transparent",
        L = "[&_mark]:bg-transparent",
        D = "[&_span.font-medium]:text-primary dark:[&_span.font-medium]:text-primary-light",
        M = (0, $.cn)(
          F,
          L,
          "[&_mark_b]:font-medium [&_mark_b]:text-md [&_mark_b]:text-primary dark:[&_mark_b]:text-primary-light",
          D,
        ),
        B = (0, $.cn)(
          F,
          L,
          "[&_mark_b]:font-medium [&_mark_b]:text-md [&_mark_b]:text-gray-800 dark:[&_mark_b]:text-gray-200",
          "[&_span.font-medium]:text-gray-800 dark:[&_span.font-medium]:text-gray-200",
        ),
        H = (0, $.cn)(
          R,
          "[&_mark_b]:font-normal [&_mark_b]:text-primary dark:[&_mark_b]:text-primary-light [&_b_mark]:font-normal [&_b_mark]:text-primary dark:[&_b_mark]:text-primary-light",
          D,
        ),
        U = (0, $.cn)(
          R,
          "[&_mark_b]:font-normal [&_mark_b]:text-gray-500 dark:[&_mark_b]:text-gray-400 [&_b_mark]:font-normal [&_b_mark]:text-gray-500 dark:[&_b_mark]:text-gray-400",
          "[&_span.font-medium]:text-gray-500 dark:[&_span.font-medium]:text-gray-400",
        ),
        z = (0, $.cn)(
          F,
          L,
          "[&_mark_b]:font-normal [&_mark_b]:text-md [&_mark_b]:text-gray-500 dark:[&_mark_b]:text-gray-400",
          "[&_span.font-medium]:text-gray-500 dark:[&_span.font-medium]:text-gray-400",
        );
      function V({
        isActive: e,
        header: t,
        description: r,
        metadata: n,
        duplicatedHeaders: s,
        commonBreadcrumbs: i,
        shouldHighlightContext: o = !0,
      }) {
        let l = n && "openapi" in n ? String(n.openapi) : void 0,
          d = l ? (0, A.sE)(l) : void 0,
          c = !!s?.has(t),
          p = n ? G(n, t, c, i) : [t];
        return (0, a.jsxs)("div", {
          className: (0, $.cn)(
            "cursor-pointer relative rounded-xl flex gap-3 px-2.5 py-2 items-center",
            e && "bg-[#F7F7F8] dark:bg-white/5",
          ),
          children: [
            (0, a.jsx)(q, {
              type: d ? "api-playground" : n?.hash ? "section" : "page",
              icon: n?.icon,
            }),
            (0, a.jsxs)("div", {
              className: "flex flex-col flex-1 min-w-0 gap-1",
              children: [
                (0, a.jsx)("div", {
                  className: "flex gap-1 items-center",
                  children: (0, a.jsx)(W, { crumbs: p, shouldHighlightContext: o }),
                }),
                (0, a.jsxs)("div", {
                  className: "flex gap-1 items-center text-gray-800 dark:text-gray-200",
                  children: [
                    d &&
                      (0, a.jsx)(I.l, {
                        method: d.method,
                        className: "text-xs font-mono rounded px-1 py-0",
                      }),
                    (0, a.jsx)("div", {
                      className: (0, $.cn)(o ? M : B, "font-medium"),
                      dangerouslySetInnerHTML: { __html: t.trim() },
                    }),
                  ],
                }),
                r &&
                  (0, a.jsx)("p", {
                    className: (0, $.cn)(o ? H : U),
                    dangerouslySetInnerHTML: { __html: r },
                  }),
              ],
            }),
            (0, a.jsx)(P.A, {
              size: 20,
              className: (0, $.cn)("text-transparent", e && "text-gray-500 dark:text-gray-400"),
            }),
          ],
        });
      }
      function K() {
        return (0, a.jsx)("svg", {
          xmlns: "http://www.w3.org/2000/svg",
          viewBox: "0 0 24 24",
          width: "16",
          height: "16",
          fill: "currentColor",
          className: "mx-0.5 flex-shrink-0 size-3 text-gray-500 dark:text-gray-400",
          children: (0, a.jsx)("path", {
            d: "M13.1717 12.0007L8.22192 7.05093L9.63614 5.63672L16.0001 12.0007L9.63614 18.3646L8.22192 16.9504L13.1717 12.0007Z",
          }),
        });
      }
      function W({ crumbs: e, shouldHighlightContext: t }) {
        return (0, a.jsx)("div", {
          className: "flex items-center min-w-0 flex-1",
          children: e.map((r, n) => {
            let s = n >= e.length - 2;
            return (0, a.jsxs)(
              "div",
              {
                className: (0, $.cn)(
                  "flex items-center",
                  s ? "min-w-0 flex-shrink" : "flex-shrink-0",
                ),
                children: [
                  !!n && (0, a.jsx)(K, {}),
                  (0, a.jsx)("div", {
                    className: (0, $.cn)(
                      t ? M : z,
                      "text-xs text-gray-500 dark:text-gray-400",
                      s ? "truncate" : "w-fit",
                    ),
                    dangerouslySetInnerHTML: { __html: r.trim() },
                  }),
                ],
              },
              n,
            );
          }),
        });
      }
      let G = (e, t, r, a) => {
        let n = "title" in e && "string" == typeof e.title ? e.title : void 0,
          s = "breadcrumbs" in e && Array.isArray(e.breadcrumbs) ? e.breadcrumbs : void 0;
        return s
          ? r
            ? (s.at(-1) === n ? s.slice(0, -1) : s).concat([t])
            : s.at(-1) !== n
              ? s.concat([t]).slice(-2)
              : s.filter((e) => !a?.has(e))
          : [t];
      };
      var J = r(24419);
      function Z({ className: e, children: t, id: r }) {
        let n = (0, g.n)(),
          s = (0, J.t)(),
          { onSearchModalOpen: i } = (0, m.useContext)(er);
        return (0, a.jsx)("button", {
          type: "button",
          onClick: i,
          className: e,
          id: r,
          "aria-label": n["aria.openSearch"],
          children: "function" == typeof t ? t({ actionKey: s }) : t,
        });
      }
      var X = r(62987);
      function Y({ className: e, searchButtonClassName: t, includeAskAiText: r }) {
        let n = (0, g.n)(),
          { searchPrompt: s, hasChatPermissions: i } = (0, m.useContext)(er),
          { onChatSheetToggle: o } = (0, m.useContext)(et),
          l = (0, J.t)(),
          d = (0, m.useMemo)(() => l[0]?.toUpperCase().trim() ?? "⌘", [l]);
        return (0, a.jsxs)("div", {
          className: (0, $.cn)(
            "relative hidden lg:flex items-center flex-1 z-20",
            i ? "gap-2.5" : "justify-center",
            e,
          ),
          children: [
            (0, a.jsx)(Z, {
              className: (0, $.cn)(
                "flex dark:bg-gray-900 pointer-events-auto rounded-xl w-full items-center text-sm leading-6 h-9 pl-3.5 pr-3 text-gray-500 dark:text-white/50 bg-background-light dark:bg-background-dark dark:brightness-[1.1] dark:ring-1 dark:hover:brightness-[1.25] ring-1 ring-gray-400/30 hover:ring-gray-600/30 dark:ring-gray-600/30 dark:hover:ring-gray-500/30 justify-between truncate gap-2 min-w-[43px]",
                t,
              ),
              id: S.V.SearchBarEntry,
              children: ({ actionKey: e }) =>
                (0, a.jsxs)(a.Fragment, {
                  children: [
                    (0, a.jsxs)("div", {
                      className: "flex items-center gap-2 min-w-[42px]",
                      children: [
                        (0, a.jsx)(p.A, {
                          size: 16,
                          className:
                            "min-w-4 flex-none text-gray-700 hover:text-gray-800 dark:text-gray-400 hover:dark:text-gray-200",
                        }),
                        (0, a.jsx)("div", { className: "truncate min-w-0", children: s }),
                      ],
                    }),
                    e &&
                      (0, a.jsxs)("span", {
                        className: "flex-none text-xs font-semibold",
                        children: [e[0], "K"],
                      }),
                  ],
                }),
            }),
            i &&
              (0, a.jsx)(X.Bc, {
                children: (0, a.jsxs)(X.m_, {
                  children: [
                    (0, a.jsx)(X.k$, {
                      asChild: !0,
                      children: (0, a.jsxs)("button", {
                        type: "button",
                        className: (0, $.cn)(
                          "flex-none hidden lg:flex items-center justify-center gap-1.5 pl-3 pr-3.5 h-9 rounded-xl shadow-sm bg-background-light dark:bg-background-dark dark:brightness-[1.1] dark:ring-1 dark:hover:brightness-[1.25] ring-1 ring-gray-400/20 hover:ring-gray-600/25 dark:ring-gray-600/30 dark:hover:ring-gray-500/30",
                          !r && "w-9 p-0",
                          t,
                        ),
                        onClick: () => o({ entryPoint: "topbar" }),
                        id: S.V.AssistantEntry,
                        "aria-label": n["aria.toggleAssistantPanel"],
                        children: [
                          (0, a.jsx)(O.BZ, {
                            className: (0, $.cn)(
                              "size-4",
                              "shrink-0 text-gray-700 hover:text-gray-800 dark:text-gray-400 hover:dark:text-gray-200",
                            ),
                          }),
                          r &&
                            (0, a.jsx)("span", {
                              className:
                                "text-sm text-gray-500 dark:text-white/50 whitespace-nowrap",
                              children: "Ask AI",
                            }),
                        ],
                      }),
                    }),
                    (0, a.jsxs)(X.ZI, {
                      size: "md",
                      side: r ? "bottom" : "right",
                      sideOffset: 8,
                      className:
                        "flex gap-2 items-center bg-white opacity-100 dark:bg-background-dark font-normal shadow-xl shadow-gray-500/5 dark:shadow-gray-500/5 rounded-xl",
                      children: [
                        (0, a.jsx)("p", {
                          className: "text-sm text-gray-500 dark:text-white/70 whitespace-nowrap",
                          children: "Toggle assistant panel",
                        }),
                        (0, a.jsxs)("span", {
                          className:
                            "flex items-center gap-1 text-sm text-gray-500 dark:text-white/50 whitespace-nowrap",
                          children: [
                            (0, a.jsx)("p", {
                              className:
                                "text-gray-500 dark:text-white/70 min-w-5 h-5 px-1 bg-gray-100 dark:bg-white/15 flex items-center justify-center rounded-md font-mono",
                              children: d,
                            }),
                            (0, a.jsx)("p", { children: "+" }),
                            (0, a.jsx)("span", {
                              className:
                                "text-gray-500 dark:text-white/70 w-5 h-5 bg-gray-100 dark:bg-white/15 flex items-center justify-center rounded-md font-mono text-xs",
                              children: "I",
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              }),
          ],
        });
      }
      let Q = 20,
        ee = "_mintlify-ask-ai-assistant",
        et = (0, m.createContext)({
          isChatSheetOpen: !1,
          shouldFocusChatSheet: !1,
          entryPoint: void 0,
          onChatSheetToggle: () => {},
          setShouldFocusChatSheet: (e) => {},
        }),
        er = (0, m.createContext)({
          onSearchModalOpen: () => {},
          hasChatPermissions: !1,
          assistantConfig: void 0,
          searchPrompt: "Search...",
          starterQuestions: void 0,
        });
      function ea({
        subdomain: e,
        hasChatPermissions: t = !1,
        assistantConfig: r,
        starterQuestions: o,
        children: d,
      }) {
        let A = (0, u.useRouter)(),
          { prefetch: P } = (0, E.B)(),
          { docsConfig: I } = (0, m.useContext)(x.DocsConfigContext),
          { trieve: _ } = (0, m.useContext)(x.DeploymentMetadataContext),
          { search: q, askAIAssistant: F, canYouTellMeAbout: R, recentSearches: L } = (0, g.n)(),
          D = I?.search?.prompt ?? q,
          [M, B] = (0, m.useState)(!1),
          [H, U] = (0, m.useState)(!1),
          [z, K] = (0, m.useState)(!1),
          [W, G] = (0, m.useState)(void 0),
          [J, Z] = (0, m.useState)(""),
          [X, Y] = (0, m.useState)([]),
          [ea, en] = (0, m.useState)(!1),
          [es, ei] = (0, m.useState)(),
          [eo, el] = (0, m.useState)(),
          ed = w("Meta"),
          ec = w("Control"),
          ep = w("Shift"),
          eu = (0, y.p)("docs.search.query"),
          em = (0, y.p)("docs.search.result_click"),
          eh = (0, y.p)("docs.search.close"),
          { append: ex } = (0, b.w)(),
          { recentSearches: eg, addRecentSearch: ef } = (function () {
            let [e, t] = (0, m.useState)([]);
            (0, m.useEffect)(() => {
              try {
                let e = localStorage.getItem(N);
                if (e) {
                  let r = JSON.parse(e);
                  if (Array.isArray(r)) {
                    let e = r.filter(
                      (e) =>
                        e &&
                        "object" == typeof e &&
                        "string" == typeof e.id &&
                        "string" == typeof e.query &&
                        "number" == typeof e.timestamp &&
                        e.searchHit &&
                        "object" == typeof e.searchHit &&
                        "string" == typeof e.searchHit.id,
                    );
                    t(e);
                  }
                }
              } catch (e) {
                (console.error("Failed to load recent searches from localStorage:", e), t([]));
              }
            }, []);
            let r = (0, m.useCallback)((e) => {
                try {
                  localStorage.setItem(N, JSON.stringify(e));
                } catch (e) {
                  console.error("Failed to save recent searches to localStorage:", e);
                }
              }, []),
              a = (0, m.useCallback)(
                (e, a) => {
                  e.trim() &&
                    a.id &&
                    t((t) => {
                      let n = t.filter((e) => e.searchHit.id !== a.id),
                        s = [
                          {
                            id: `${a.id}-${Date.now()}`,
                            query: e.trim(),
                            searchHit: a,
                            timestamp: Date.now(),
                          },
                          ...n,
                        ].slice(0, 8);
                      return (r(s), s);
                    });
                },
                [r],
              );
            return {
              recentSearches: e,
              addRecentSearch: a,
              removeRecentSearch: (0, m.useCallback)(
                (e) => {
                  t((t) => {
                    let a = t.filter((t) => t.id !== e);
                    return (r(a), a);
                  });
                },
                [r],
              ),
              clearRecentSearches: (0, m.useCallback)(() => {
                (t([]), r([]));
              }, [r]),
            };
          })(),
          ey = (0, u.useSearchParams)(),
          { search: eb } = (0, C.SQ)(),
          ev = (0, m.useRef)(null),
          ej = (0, m.useMemo)(
            () =>
              l()(() => {
                let e = ev.current;
                e?.searchId &&
                  e.query &&
                  eu({ searchId: e.searchId, query: e.query, numHits: e.numHits });
              }, 500),
            [eu],
          ),
          ek = (0, j.G)();
        (0, m.useEffect)(() => {
          let e = (0, v.m5)();
          if (!e || (e.path && e.path !== ek)) {
            return;
          }
          let t = null,
            r = null,
            a = () => {
              (t && (t.disconnect(), (t = null)), r && (window.clearTimeout(r), (r = null)));
            },
            n = () => {
              (0, v.Es)(e) && a();
            };
          return (
            n(),
            (t = new MutationObserver(() => {
              n();
            })).observe(document.body, { childList: !0, subtree: !0 }),
            (r = window.setTimeout(() => {
              a();
            }, 5e3)),
            a
          );
        }, [ek]);
        let ew = (0, T.r)(),
          eN = (0, m.useCallback)(
            (e, t) => {
              let r = new URLSearchParams(ey?.toString() ?? "");
              return (
                t ? r.set(e, t) : r.delete(e),
                window.history.replaceState({}, "", `${window.location.pathname}?${r.toString()}`),
                r.toString()
              );
            },
            [ey],
          ),
          eC = (0, m.useMemo)(
            () =>
              l()((e) => {
                eN("search", e || "");
              }, 500),
            [eN],
          ),
          eS = (0, m.useCallback)(() => {
            "algolia" !== e && (B(!0), eN("search", ""));
          }, [e, eN]),
          eO = (0, m.useCallback)(() => {
            "algolia" !== e &&
              B((e) => (e ? (eN("search", null), eC.cancel()) : eN("search", ""), !e));
          }, [e, eN, eC]),
          e$ = (0, m.useCallback)(
            (e) => {
              t &&
                U((t) => {
                  let r = !t;
                  return (K(r), t && eN("assistant", null), r && G(e?.entryPoint), r);
                });
            },
            [t, eN],
          ),
          [eT, eE] = (0, m.useState)(!1);
        ((0, k.f)({ key: "k", callback: eO }),
          (0, k.f)({ key: "i", callback: e$, isDisabled: !t }),
          (0, m.useEffect)(() => {
            M || eE(!1);
          }, [M]));
        let eA = (0, m.useMemo)(
          () =>
            l()(async (t) => {
              if ((Z(t), !t || null == e)) {
                (Y([]), (ev.current = null));
                return;
              }
              if (_?.datasetId) {
                try {
                  en(!0);
                  let e = await eb(t);
                  if (e === C.Jc) return;
                  (Y(e.results),
                    (ev.current = { searchId: e.id, query: t, numHits: e.results.length }),
                    e.id && ej(),
                    el(
                      ((e, t = !1) => {
                        if (e.length <= 1) return new Set();
                        for (let t of e) if (0 === t.length) return new Set();
                        let r = new Set(),
                          a = Math.min(...e.map((e) => e.length)),
                          n = t ? a - 1 : a;
                        for (let t = 0; t < n; t++) {
                          let a = e[0]?.[t];
                          if (void 0 === a) continue;
                          let n = !0;
                          for (let r = 1; r < e.length; r++)
                            if (e[r]?.[t] !== a) {
                              n = !1;
                              break;
                            }
                          n && r.add(a);
                        }
                        return r;
                      })(
                        e.results.map((e) =>
                          Array.isArray(e.metadata?.breadcrumbs) ? e.metadata.breadcrumbs : [],
                        ),
                        !0,
                      ),
                    ),
                    ei(
                      ((e) => {
                        let t = new Set(),
                          r = new Set();
                        for (let a of e) t.has(a) ? r.add(a) : t.add(a);
                        return r;
                      })(e.results.map((e) => e.header)),
                    ));
                } catch (e) {
                  (Y([]), console.error("Search request failed:", e));
                } finally {
                  en(!1);
                }
              }
            }, Q),
          [e, _?.datasetId, eb, ej],
        );
        (0, m.useEffect)(() => {
          let r = new URLSearchParams(window.location.search),
            a = r.get("assistant");
          null !== a &&
            t &&
            requestAnimationFrame(() => {
              (U(!0), K(!0), a && ex({ id: c()(), role: "user", content: a }));
            });
          let n = r.get("search");
          null !== n &&
            "algolia" !== e &&
            requestAnimationFrame(() => {
              (B(!0), n && (Z(n), eA(n)));
            });
        }, []);
        let eP = (0, m.useCallback)(
            (e) => (R.includes("{query}") ? R.replace("{query}", () => e) : `${R} ${e}?`),
            [R],
          ),
          eI = (0, m.useCallback)(
            (e) => {
              P(e.link, { source: "search", header: e.header, searchId: e.id });
            },
            [P],
          ),
          e_ = (0, m.useCallback)(
            async (e, t) => {
              (ej.cancel(), eC.cancel());
              let r = ev.current?.searchId;
              if (((ev.current = null), e === ee)) {
                (B(!1),
                  eN("search", null),
                  U(!0),
                  K(!0),
                  G("search-modal"),
                  ex({ id: c()(), role: "user", content: t }));
              } else {
                if (!e || "string" == typeof e) {
                  return;
                }
                let a = t || eg.find((t) => t.searchHit.id === e.id)?.query || "";
                (a && e.id && ef(a, e),
                  em({ query: a, searchId: r, path: e.link, section: e.header }),
                  ed || ec || ep
                    ? window.open(`${f.c.BASE_PATH}${e.link}`, "_blank", "noopener,noreferrer")
                    : (A.push(e.link),
                      B(!1),
                      eh({ query: a, numHits: X.length }).catch(console.error),
                      Z(""),
                      Y([])),
                  A.push(e.link),
                  B(!1),
                  eh({ searchId: r, query: t, numHits: X.length }).catch(console.error));
              }
            },
            [ex, em, A, eN, eh, X.length, ef, ed, ec, ep, eg, ej, eC],
          ),
          eq = (0, m.useMemo)(
            () => ({
              isChatSheetOpen: H,
              shouldFocusChatSheet: z,
              entryPoint: W,
              onChatSheetToggle: e$,
              setShouldFocusChatSheet: K,
            }),
            [H, z, W, e$, K],
          );
        return (0, a.jsxs)(a.Fragment, {
          children: [
            (0, a.jsx)(et.Provider, {
              value: eq,
              children: (0, a.jsx)(er.Provider, {
                value: (0, m.useMemo)(
                  () => ({
                    onSearchModalOpen: eS,
                    hasChatPermissions: t,
                    searchPrompt: D,
                    assistantConfig: r,
                    starterQuestions: o,
                  }),
                  [eS, t, D, r, o],
                ),
                children: d,
              }),
            }),
            (0, a.jsx)(n.e, {
              show: M,
              as: m.Fragment,
              afterLeave: () => {
                (Z(""), Y([]), ej.cancel(), eC.cancel(), (ev.current = null));
              },
              appear: !0,
              children: (0, a.jsxs)(s.lG, {
                as: "div",
                className: (0, $.cn)(h.f.Popup, "relative"),
                onClose: () => {
                  (B(!1), eN("search", null), ej.cancel(), eC.cancel(), (ev.current = null));
                },
                children: [
                  (0, a.jsx)(n._, {
                    as: m.Fragment,
                    enter: "ease-out duration-100",
                    enterFrom: "opacity-0",
                    enterTo: "opacity-100",
                    leave: "ease-in duration-50",
                    leaveFrom: "opacity-100",
                    leaveTo: "opacity-0",
                    children: (0, a.jsx)("div", {
                      className:
                        "fixed inset-0 bg-background-dark/20 transition-opacity backdrop-blur-sm",
                    }),
                  }),
                  (0, a.jsx)("div", {
                    className:
                      "fixed inset-0 w-screen h-screen z-10 overflow-y-auto p-4 sm:p-6 md:p-12",
                    onClick: () => {
                      (B(!1), eN("search", null), ej.cancel(), eC.cancel(), (ev.current = null));
                    },
                    children: (0, a.jsx)(n._, {
                      as: m.Fragment,
                      enter: "ease-out duration-100",
                      enterFrom: "opacity-0 scale-95",
                      enterTo: "opacity-100 scale-100",
                      leave: "ease-in duration-50",
                      leaveFrom: "opacity-100 scale-100",
                      leaveTo: "opacity-0 scale-95",
                      children: (0, a.jsx)(s.Lj, {
                        onClick: (e) => e.stopPropagation(),
                        className:
                          "flex flex-col mx-auto max-w-[640px] transform overflow-hidden border border-gray-200 dark:border-white/10 bg-background-light dark:bg-background-dark shadow-search rounded-search",
                        children: (0, a.jsxs)(i.G3, {
                          onChange: (e) => e_(e, J),
                          value: J,
                          children: [
                            (0, a.jsxs)("div", {
                              className: (0, $.cn)(
                                "p-1.5 relative z-10 border-b border-transparent h-14 transition",
                                eT && "border-gray-200 dark:border-white/10",
                              ),
                              children: [
                                ew
                                  ? (0, a.jsx)("div", {
                                      className:
                                        "flex items-center rounded-xl border border-gray-200 dark:border-white/10 bg-background-light dark:bg-background-dark h-full w-full outline-0 text-gray-950/50 dark:text-white/50 tracking-tight pl-12 pr-14",
                                      children: (0, a.jsx)("span", {
                                        children: "Not available on local preview",
                                      }),
                                    })
                                  : (0, a.jsx)(i.oK, {
                                      ref: (e) => e?.focus(),
                                      id: S.V.SearchInput,
                                      className: (0, $.cn)(
                                        "peer rounded-xl border outline-none border-gray-200 dark:border-white/10 bg-background-light dark:bg-background-dark h-full w-full outline-0 text-gray-950 dark:text-white placeholder:text-gray-400 placeholder:dark:text-white/50 tracking-tight pl-11 pr-14 focus:border-slate-950 dark:focus:border-white transition",
                                        !eT && J && "shadow-search",
                                      ),
                                      autoFocus: !0,
                                      placeholder: D,
                                      onChange: (e) => {
                                        let t = e.target.value;
                                        (eA(t), eC(t));
                                      },
                                      autoComplete: "off",
                                      onKeyDown: (e) => {
                                        let r =
                                          e.currentTarget.parentElement?.parentElement?.querySelector(
                                            '[role="listbox"]',
                                          );
                                        (!(function (e, t) {
                                          if (
                                            !e.isTrusted ||
                                            ("ArrowUp" !== e.key && "ArrowDown" !== e.key) ||
                                            !t
                                          ) {
                                            return;
                                          }
                                          let r = t.querySelectorAll('[role="option"]');
                                          if (0 === r.length) {
                                            return;
                                          }
                                          let a = t.querySelector(
                                              '[data-headlessui-state~="active"]',
                                            ),
                                            n = a ? Array.from(r).indexOf(a) : -1,
                                            s = n === r.length - 1;
                                          if (
                                            ("ArrowUp" === e.key && n <= 0) ||
                                            ("ArrowDown" === e.key && s)
                                          ) {
                                            e.preventDefault();
                                            let t = "ArrowUp" === e.key ? "ArrowDown" : "ArrowUp",
                                              a = r.length - 1;
                                            for (let r = 0; r < a; r++) {
                                              e.currentTarget.dispatchEvent(
                                                new KeyboardEvent("keydown", {
                                                  key: t,
                                                  code: t,
                                                  bubbles: !0,
                                                  cancelable: !0,
                                                }),
                                              );
                                            }
                                          }
                                        })(e, r ?? null),
                                          e.isTrusted &&
                                            ((X.length > 0 || eg.length > 0 || (J && t)) &&
                                              "Tab" === e.key &&
                                              (e.preventDefault(),
                                              e.currentTarget.setSelectionRange(
                                                e.currentTarget.value.length,
                                                e.currentTarget.value.length,
                                              )),
                                            "Enter" === e.key &&
                                              (e.metaKey || e.ctrlKey) &&
                                              (J && t && !X.length && !ea
                                                ? e_(ee, J)
                                                : X.length > 0 && X[0] && e_(X[0], J)),
                                            "Escape" === e.key &&
                                              (B(!1),
                                              eN("search", null),
                                              ej.cancel(),
                                              eC.cancel(),
                                              eh({
                                                searchId: ev.current?.searchId,
                                                query: J,
                                                numHits: X.length,
                                              }).catch(console.error),
                                              (ev.current = null))));
                                      },
                                    }),
                                (0, a.jsx)(p.A, {
                                  size: 18,
                                  className:
                                    "absolute left-5 top-1/2 -translate-y-1/2 text-gray-950 dark:text-white opacity-50 peer-focus:opacity-100 peer-disabled:opacity-30",
                                }),
                                J &&
                                  (0, a.jsx)("div", {
                                    className:
                                      "top-1/2 -translate-y-1/2 absolute right-6 flex items-center justify-center rounded-md gap-1 px-1.5 py-1.5 bg-gray-950/5 dark:bg-white/5 text-zinc-950/70 dark:text-white/70 font-medium text-xs leading-[9px]",
                                    children: "ESC",
                                  }),
                              ],
                            }),
                            (0, a.jsxs)(
                              i.Kc,
                              {
                                static: !0,
                                className: "max-h-[calc(100vh-10rem)] overflow-y-auto mx-1.5",
                                onScroll: (e) => {
                                  e.currentTarget.scrollTop ? eE(!0) : eE(!1);
                                },
                                children: [
                                  0 === X.length &&
                                    !J &&
                                    eg.length > 0 &&
                                    (0, a.jsxs)(a.Fragment, {
                                      children: [
                                        (0, a.jsx)("div", {
                                          className:
                                            "flex items-center justify-between px-2.5 py-2",
                                          children: (0, a.jsx)("span", {
                                            className: "text-gray-500 text-sm truncate",
                                            children: L,
                                          }),
                                        }),
                                        eg.map((e) =>
                                          (0, a.jsx)(
                                            i.jO,
                                            {
                                              value: e.searchHit,
                                              className: "last:mb-2 group",
                                              children: ({ focus: t }) => (
                                                t && eI(e.searchHit),
                                                (0, a.jsx)("div", {
                                                  onMouseEnter: () => eI(e.searchHit),
                                                  children: (0, a.jsx)(V, {
                                                    isActive: t,
                                                    header: e.searchHit.header,
                                                    description: e.searchHit.content,
                                                    metadata: e.searchHit.metadata,
                                                    duplicatedHeaders: es,
                                                    shouldHighlightContext: !1,
                                                  }),
                                                })
                                              ),
                                            },
                                            e.searchHit.id,
                                          ),
                                        ),
                                      ],
                                    }),
                                  !!J &&
                                    X.length > 0 &&
                                    (0, a.jsx)(a.Fragment, {
                                      children: X.map((e) =>
                                        (0, a.jsx)(
                                          i.jO,
                                          {
                                            value: e,
                                            className: "last:mb-2",
                                            children: ({ focus: t }) => (
                                              t && eI(e),
                                              (0, a.jsx)("div", {
                                                onMouseEnter: () => eI(e),
                                                children: (0, a.jsx)(V, {
                                                  isActive: t,
                                                  header: e.header,
                                                  description: e.content,
                                                  metadata: e.metadata,
                                                  duplicatedHeaders: es,
                                                  commonBreadcrumbs: eo,
                                                }),
                                              })
                                            ),
                                          },
                                          e.id,
                                        ),
                                      ),
                                    }),
                                  t &&
                                    J &&
                                    (0, a.jsxs)(a.Fragment, {
                                      children: [
                                        (0, a.jsx)("div", {
                                          className:
                                            "px-2.5 py-2 text-gray-500 text-sm truncate w-full",
                                          children: F,
                                        }),
                                        (0, a.jsx)(
                                          i.jO,
                                          {
                                            value: ee,
                                            className: "last:mb-2",
                                            children: ({ focus: e }) =>
                                              (0, a.jsxs)("div", {
                                                className: (0, $.cn)(
                                                  "flex items-center gap-2 px-2.5 py-2 w-full cursor-pointer rounded-xl",
                                                  e && "bg-[#F7F7F8] dark:bg-white/5",
                                                ),
                                                children: [
                                                  (0, a.jsx)(O.BZ, {
                                                    className:
                                                      "text-primary dark:text-primary-light h-4 w-4 shrink-0",
                                                  }),
                                                  " ",
                                                  (0, a.jsx)("span", {
                                                    className:
                                                      "font-medium text-gray-800 dark:text-gray-200 text-sm truncate",
                                                    children: eP(J),
                                                  }),
                                                ],
                                              }),
                                          },
                                          ee,
                                        ),
                                      ],
                                    }),
                                ],
                              },
                              "search-results-options",
                            ),
                          ],
                        }),
                      }),
                    }),
                  }),
                ],
              }),
            }),
          ],
        });
      }
      er.displayName = "SearchContext";
    },
    12192: (e, t, r) => {
      "use strict";
      r.d(t, { y: () => c, BannerProvider: () => p });
      var a = r(54568),
        n = r(7620);
      let s = "bannerDismissed",
        i = "data-banner-state";
      function o(e, t) {
        return void 0 !== e && void 0 !== t ? `lang:${t}_subdomain:${e}_${s}` : s;
      }
      function l(e, t, r) {
        let a = t[e];
        if (!a) {
          return;
        }
        let n = { ...a, lang: e };
        try {
          let t = o(r, e),
            s = localStorage.getItem(t),
            l = !s || s !== a.content;
          return (
            document.documentElement.setAttribute(i, l ? "visible" : "hidden"),
            l && s && localStorage.removeItem(t),
            l ? n : void 0
          );
        } catch (e) {
          return;
        }
      }
      var d = r(76829);
      let c = (0, n.createContext)({ banner: void 0, dismissBanner: () => {} }),
        p = ({ children: e, bannersByLocale: t, subdomain: r }) => {
          let { selectedLocale: s } = (0, n.useContext)(d.NavigationContext),
            p = (0, n.useMemo)(
              () => (s && t[s] ? { ...t[s], lang: s } : { ...t.global, lang: "global" }),
              [s, t],
            ),
            [u, m] = (0, n.useState)(() => l(p.lang, t, r));
          return (
            (0, n.useEffect)(() => {
              m(l(p.lang, t, r));
            }, [p, t, r]),
            (0, a.jsx)(c.Provider, {
              value: {
                banner: u,
                dismissBanner: u?.dismissible
                  ? () => {
                      if (u && u.dismissible && u.content) {
                        m(void 0);
                        try {
                          localStorage.setItem(o(r, u.lang), u.content);
                        } catch (e) {
                          console.error(e);
                        }
                        document.documentElement.setAttribute(i, "hidden");
                      }
                    }
                  : void 0,
              },
              children: e,
            })
          );
        };
    },
    12757: (e, t, r) => {
      "use strict";
      r.d(t, { b: () => n });
      var a = r(59705);
      let n = () => ({
        selectedExampleIndex: (0, a.jT)((e) => e.selectedExampleIndex),
        setSelectedExampleIndex: (0, a.jT)((e) => e.setSelectedExampleIndex),
      });
    },
    13435: (e, t, r) => {
      "use strict";
      r.d(t, { bJ: () => a, rh: () => n });
      let a = "docs.content.view",
        n = {
          "docs.expandable.open": "expandable_open",
          "docs.expandable.close": "expandable_close",
          "docs.accordion.open": "accordion_open",
          "docs.accordion.close": "accordion_close",
          "docs.navitem.click": "header_nav_item_click",
          "docs.navitem.cta_click": "cta_click",
          "docs.search.close": "search_close",
          "docs.api_playground.request": "api_playground_call",
          "docs.search.result_click": "search_result_click",
          "docs.code_block.copy": "code_block_copy",
          "docs.code_block.ask_ai": "ask_ai_code_block",
          "docs.footer.powered_by_mintlify_click": "powered_by_mintlify_click",
          "docs.assistant.enter": "chat_enter",
          "docs.assistant.completed": "chat_completed",
          "docs.assistant.shared": "chat_shared",
          "docs.assistant.source_click": "ai_chat_citation_click",
          "docs.assistant.thumbs_up": "ai_chat_feedback_positive_click",
          "docs.assistant.thumbs_down": "ai_chat_feedback_negative_click",
          "docs.assistant.spam_detected": "assistant.spam_detected",
        };
    },
    15209: (e, t, r) => {
      "use strict";
      r.d(t, { O: () => l, e: () => o });
      var a = r(56452),
        n = r(7620),
        s = r(30793),
        i = r(71252);
      let o = () => {
          let {
              isLivePreview: e,
              getDocsConfigOverrides: t,
              livePreviewUpdateId: r,
            } = (0, n.useContext)(i.K),
            { docsConfig: o } = (0, n.useContext)(s.DocsConfigContext);
          return (0, n.useMemo)(() => {
            let r = t(),
              n = r?.styling?.codeblocks,
              s = e && n ? n : o?.styling?.codeblocks;
            return (0, a.xE)(s);
          }, [e, t, r, o]);
        },
        l = () => {
          let {
              isLivePreview: e,
              getDocsConfigOverrides: t,
              livePreviewUpdateId: r,
            } = (0, n.useContext)(i.K),
            { docsConfig: a } = (0, n.useContext)(s.DocsConfigContext);
          return (0, n.useMemo)(() => {
            let r = t(),
              n = r?.styling?.codeblocks;
            return e && n ? n : a?.styling?.codeblocks;
          }, [e, t, r, a]);
        };
    },
    16530: (e, t, r) => {
      "use strict";
      r.d(t, { l: () => T, P: () => E });
      var a = r(54568),
        n = r(52648),
        s = r(27116),
        i = r(7620),
        o = r(62060),
        l = r(15209),
        d = r(65542),
        c = r(33052),
        p = r(68999),
        u = r(81325),
        m = r(49765),
        h = r(27833),
        x = r(67018),
        g = r(48059),
        f = r(87799),
        y = r(75968),
        b = r(81391),
        v = r(6472),
        j = r(54923),
        k = r(90280);
      let w = ({ language: e, className: t }) => {
          let r = ((e) => {
            let t = (0, j.bP)(e);
            return t ? `${k.M5}/devicon/${t}.svg` : null;
          })(e);
          return r
            ? (0, a.jsx)("svg", {
                className: (0, u.cn)("w-3.5 h-3.5 shrink-0", t),
                style: {
                  WebkitMaskImage: `url(${r})`,
                  WebkitMaskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskImage: `url(${r})`,
                  maskRepeat: "no-repeat",
                  maskPosition: "center",
                  maskSize: "100%",
                  backgroundColor: "currentColor",
                },
              })
            : null;
        },
        N = ({ selectedLanguage: e, setSelectedLanguage: t, languages: r }) => {
          let n = r.length > 1,
            s = (0, l.e)(),
            [o, d] = (0, i.useState)(!1);
          return (0, a.jsxs)(v.DropdownMenu, {
            open: o,
            onOpenChange: d,
            children: [
              (0, a.jsx)(v.DropdownMenuTrigger, {
                disabled: !n,
                className:
                  "select-none bg-transparent dark:bg-transparent pb-1 text-xs font-medium cursor-default",
                children: (0, a.jsxs)("div", {
                  className: (0, u.cn)(
                    "flex gap-1 items-center pl-2.5 pr-1.5 py-[5px] rounded-[10px] border text-gray-500 dark:text-gray-400",
                    n ? "cursor-pointer" : "cursor-default",
                    n &&
                      "system" === s &&
                      "hover:bg-gray-200/50 dark:hover:bg-gray-700/70 hover:text-primary dark:hover:text-primary-light",
                    n && "dark" === s && "hover:bg-gray-700/70 hover:text-primary-light",
                    o
                      ? "ring-1 dark:ring-gray-800/50 " +
                          ("system" === s ? "ring-gray-200/70 " : "ring-gray-800/50") +
                          " border-gray-600/50 dark:border-gray-400/50"
                      : "border-transparent",
                  ),
                  children: [
                    (0, a.jsx)(w, { language: e }),
                    (0, a.jsx)("p", { className: "truncate font-medium", children: (0, j.Mn)(e) }),
                    n && (0, a.jsx)(b.A, { className: "w-3.5 h-3.5 shrink-0" }),
                  ],
                }),
              }),
              (0, a.jsx)(v.DropdownMenuContent, {
                className: (0, u.cn)(
                  "p-1 overflow-y-auto min-w-[170px] border dark:border-white/10 dark:bg-codeblock",
                  "system" === s && "border-gray-200/70",
                  "dark" === s && "border-white/10 bg-codeblock",
                ),
                align: "end",
                sideOffset: 0,
                children: r.map((r, n) => {
                  let i = r === e;
                  return (0, a.jsxs)(
                    v._,
                    {
                      isSelected: i,
                      onSelect: () => t(r),
                      className: (0, u.cn)(
                        "flex items-center py-1.5 gap-1.5 text-xs",
                        "system" === s &&
                          "hover:text-primary hover:bg-primary/10 dark:hover:text-primary-light dark:hover:bg-primary-light/10",
                        "dark" === s &&
                          "text-primary-light dark:text-primary-light hover:text-primary-light hover:bg-primary-light/10",
                        r === e &&
                          "system" === s &&
                          "text-primary dark:text-primary-light font-medium",
                        r === e &&
                          "dark" === s &&
                          "text-primary-light dark:text-primary-light font-medium",
                        r !== e && "system" === s && "text-gray-500 dark:text-white/50",
                        r !== e && "dark" === s && "text-white/50",
                      ),
                      children: [
                        (0, a.jsx)(w, { language: r }),
                        (0, a.jsx)("div", {
                          className: "flex items-center min-w-0 flex-1 font-medium",
                          children: (0, j.Mn)(r),
                        }),
                      ],
                    },
                    n,
                  );
                }),
              }),
            ],
          });
        };
      var C = r(51874);
      let S = function ({
          children: e,
          onCopied: t,
          onChange: r,
          isSmallText: b,
          className: v,
          noMargins: j,
          dropdown: k,
          hideCodeSnippetFeedbackButton: w,
          ...S
        }) {
          let $ = (0, l.e)(),
            T = (0, i.useRef)(new Map()),
            E = Array.isArray(e) ? e : i.Children.toArray(e),
            A = (0, i.useCallback)((e) => (k ? e.props.language : e.props.filename), [k]),
            P = (0, i.useMemo)(() => E.map((e) => (0, n.Y)(A(e) ?? "")), [E, A]),
            I = (0, i.useMemo)(() => E.map((e) => A(e) ?? ""), [E, A]),
            { activeIndex: _, setActiveIndex: q } = (0, d.i)({
              tabIds: P,
              tabLabels: I,
              persistKey: "code",
              defaultIndex: 0,
              onIndexChange: r,
            }),
            F = (0, i.useCallback)(
              (e) => {
                let t = Number(e),
                  r = document.activeElement?.getAttribute("role") === "tab";
                (window.location.hash &&
                  window.history.replaceState(
                    null,
                    "",
                    window.location.pathname + window.location.search,
                  ),
                  q({ index: t, updateHash: !1 }),
                  r &&
                    requestAnimationFrame(() => {
                      let e = T.current.get(t);
                      e && e.focus();
                    }));
              },
              [q],
            );
          if (!e) {
            return null;
          }
          if (0 === E.length) {
            return (
              console.warn("CodeGroup has no children, expected at least one CodeBlock child."),
              null
            );
          }
          let R = Number(_),
            L = () =>
              (0, a.jsxs)("div", {
                className: "flex items-center gap-1.5 text-xs font-medium min-w-0",
                children: [
                  E[R]?.props.icon &&
                    "string" == typeof E[R]?.props.icon &&
                    (0, a.jsx)(p.ComponentIcon, {
                      icon: E[R]?.props.icon,
                      iconType: "regular",
                      className: (0, u.cn)(
                        "h-3.5 w-3.5 bg-gray-500 dark:bg-gray-400",
                        c.x.CodeBlockIcon,
                      ),
                      overrideColor: !0,
                    }),
                  (0, a.jsx)("span", {
                    className: (0, u.cn)(
                      "truncate",
                      "system" === $ && "text-gray-950 dark:text-gray-50",
                      "dark" === $ && "text-gray-50",
                    ),
                    children: E[R]?.props.filename,
                  }),
                ],
              }),
            D = () =>
              (0, a.jsx)(s.B8, {
                className: (0, u.cn)(
                  "flex-1 w-0 text-xs leading-6 rounded-tl-xl gap-1 flex overflow-x-auto overflow-y-hidden",
                  (0, h.O)($),
                ),
                children: E.map((e, t) =>
                  (0, a.jsxs)(
                    O,
                    {
                      value: String(t),
                      isSelected: R === t,
                      tabsLength: E.length,
                      codeBlockTheme: $,
                      ref: (e) => {
                        e && T.current.set(t, e);
                      },
                      children: [
                        e.props.icon &&
                          "string" == typeof e.props.icon &&
                          (0, a.jsx)(p.ComponentIcon, {
                            icon: e.props.icon,
                            iconType: "regular",
                            className: (0, u.cn)(
                              "h-3.5 w-3.5 bg-gray-500 dark:bg-gray-400",
                              "system" === $
                                ? "group-hover:bg-primary dark:group-hover:bg-primary-light"
                                : "group-hover:bg-gray-700/70 group-hover:text-primary-light",
                              c.x.CodeBlockIcon,
                            ),
                            color: R === t ? "currentColor" : void 0,
                            overrideColor: !0,
                          }),
                        e.props.filename,
                      ],
                    },
                    e.props.filename + "TabItem" + t,
                  ),
                ),
              });
          return (0, a.jsx)(o.R, {
            code: (0, C.O)(E[R]?.props?.children),
            hideCodeSnippetFeedbackButton: E[R]?.props.hideCodeSnippetFeedbackButton || w,
            ...(0, m.f)(E[R]?.props),
            children: ({ feedbackModalOpen: e, anchorRef: r }) =>
              (0, a.jsxs)(s.bL, {
                ref: r,
                value: String(_),
                onValueChange: F,
                className: (0, u.cn)(
                  c.x.CodeGroup,
                  "p-0.5 mt-5 mb-8 flex flex-col not-prose relative overflow-hidden rounded-2xl border border-gray-950/10 dark:border-white/10",
                  j && "my-0",
                  "system" === $ &&
                    "bg-gray-50 dark:bg-white/5 dark:codeblock-dark text-gray-950 dark:text-gray-50 codeblock-light",
                  "dark" === $ &&
                    "border-transparent bg-codeblock dark:bg-white/5 text-gray-50 codeblock-dark",
                  e && "border border-primary dark:border-primary-light",
                  v,
                ),
                ...S,
                asChild: !1,
                children: [
                  (0, a.jsxs)("div", {
                    className: (0, u.cn)(
                      "flex items-center justify-between gap-2 relative",
                      k ? "px-2.5" : "pr-2.5 *:first:*:ml-2.5",
                    ),
                    "data-component-part": "code-group-tab-bar",
                    children: [
                      k ? (0, a.jsx)(L, {}) : (0, a.jsx)(D, {}),
                      (0, a.jsxs)("div", {
                        className: "flex items-center justify-end shrink-0 gap-1.5",
                        children: [
                          k &&
                            (0, a.jsx)(N, {
                              selectedLanguage: E[R]?.props.language || "",
                              setSelectedLanguage: (e) => {
                                let t = E.findIndex((t) => t.props.language === e);
                                -1 !== t && F(String(t));
                              },
                              languages: E.map((e) => e.props.language || ""),
                            }),
                          (0, a.jsx)(y.k, {}),
                          (0, a.jsx)(f.TN, {
                            textToCopy: (0, C.O)(E[R]?.props?.children),
                            onCopied: t,
                          }),
                          (0, a.jsx)(x.y, {
                            code: (0, C.O)(E[R]?.props?.children),
                            ...(0, m.f)(E[R]?.props),
                          }),
                        ],
                      }),
                    ],
                  }),
                  (0, a.jsx)("div", {
                    className: "flex flex-1 overflow-hidden",
                    children: E.map((e, t) =>
                      (0, a.jsx)(
                        s.UC,
                        {
                          value: String(t),
                          className: "w-full min-w-full max-w-full h-full max-h-full relative",
                          tabIndex: -1,
                          children: (0, a.jsx)(g.S7, {
                            ...e.props,
                            isParentCodeGroup: !0,
                            isSmallText: b,
                            shouldHighlight: t === R,
                            expandable: e.props.expandable && t === R,
                          }),
                        },
                        e.props.filename + "Content" + t,
                      ),
                    ),
                  }),
                ],
              }),
          });
        },
        O = (0, i.forwardRef)(function (
          { children: e, value: t, isSelected: r, tabsLength: n, codeBlockTheme: i },
          o,
        ) {
          return (0, a.jsxs)(s.l9, {
            ref: o,
            value: t,
            className: (0, u.cn)(
              "group flex items-center relative gap-1.5 my-1 mb-1.5 outline-0 whitespace-nowrap font-medium !ml-0 first:!ml-2.5 focus:outline-2",
              r && "system" === i && "text-primary dark:text-primary-light",
              r && ("dark" === i || void 0 == i) && "text-primary-light",
              !r && "system" === i && "text-gray-500 dark:text-gray-400",
              !r && ("dark" === i || void 0 == i) && "text-gray-400",
            ),
            children: [
              (0, a.jsx)("div", {
                className: (0, u.cn)(
                  "flex items-center gap-1.5 px-1.5 rounded-lg z-10",
                  n > 1 &&
                    "system" === i &&
                    "group-hover:bg-gray-200/50 dark:group-hover:bg-gray-700/70 group-hover:text-primary dark:group-hover:text-primary-light",
                  n > 1 &&
                    ("dark" === i || void 0 == i) &&
                    "group-hover:bg-gray-700/70 group-hover:text-primary-light",
                ),
                children: e,
              }),
              r &&
                (0, a.jsx)("div", {
                  className:
                    "absolute -bottom-1.5 left-0 right-0 h-0.5 rounded-full bg-primary dark:bg-primary-light",
                }),
            ],
          });
        });
      var $ = r(22153);
      function T({
        dropdown: e,
        children: t,
        isSmallText: r,
        noMargins: n,
        hideCodeSnippetFeedbackButton: s,
      }) {
        let i = (0, $.p)("docs.code_block.copy");
        return (0, a.jsx)(S, {
          dropdown: e,
          isSmallText: r,
          noMargins: n,
          onCopied: (e, t) => i({ code: t }),
          hideCodeSnippetFeedbackButton: s,
          children: t,
        });
      }
      function E(e) {
        return (0, a.jsx)(T, { ...e });
      }
    },
    16916: (e, t, r) => {
      "use strict";
      r.d(t, { sE: () => n });
      let a = new Set(Object.values(r(86775).M5.HttpMethods).concat("webhook")),
        n = (e) => {
          let t,
            r,
            n,
            s = e.trim().split(/\s+/);
          if (!(s.length > 3)) {
            if (s[0] && s[1] && s[2]) [t, r, n] = s;
            else {
              if (!s[0] || !s[1]) return;
              [r, n] = s;
            }
            if (!r || ((r = r.toLowerCase()), a.has(r))) {
              return { method: r, endpoint: n, filename: t };
            }
          }
        };
    },
    19518: (e, t, r) => {
      "use strict";
      r.d(t, { z: () => s });
      var a = r(54568),
        n = r(150);
      let s = ({ name: e, channel: t }) => {
        let r = t.sendMessages.map((e) => ({
            type: "send",
            id: e.id,
            title: e.title ?? e.example ?? "",
            content: e.example,
          })),
          s = t.receiveMessages.map((e) => ({
            type: "receive",
            id: e.id,
            title: e.title ?? e.example ?? "",
            content: e.example,
          }));
        return (0, a.jsx)(n.X, { name: e, messages: [...r, ...s] });
      };
    },
    22153: (e, t, r) => {
      "use strict";
      r.d(t, { p: () => i });
      var a = r(13435),
        n = r(7620),
        s = r(42758);
      let i = (e) => {
        let { analyticsMediator: t } = (0, n.useContext)(s.A);
        return (0, n.useMemo)(() => {
          if (!t) {
            return (e) => Promise.resolve();
          }
          let r = t.createEventListener(e),
            n = (function (e) {
              if (a.rh.hasOwnProperty(e)) {
                return a.rh[e];
              }
            })(e);
          if (n) {
            let e = t.createEventListener(n);
            return (t) => Promise.all([r(t), e(t)]);
          }
          return r;
        }, [t, e]);
      };
    },
    23752: (e, t, r) => {
      "use strict";
      r.d(t, { O: () => i, i: () => o });
      var a = r(54568),
        n = r(7620),
        s = r(41574);
      let i = (0, n.createContext)({
        preferredCodeLanguage: "",
        setPreferredCodeLanguage: () => {},
      });
      i.displayName = "LocalStorageContext";
      let o = ({ cookiesEnabled: e, children: t }) => {
        let [r, n] = (0, s.Mj)("code", "");
        return (0, a.jsx)(i.Provider, {
          value: { preferredCodeLanguage: r, setPreferredCodeLanguage: n, cookiesEnabled: e },
          children: t,
        });
      };
    },
    24419: (e, t, r) => {
      "use strict";
      r.d(t, { t: () => i });
      var a = r(7620);
      let n = ["Ctrl ", "Control"],
        s = ["⌘", "Command"];
      function i() {
        let [e, t] = (0, a.useState)(s);
        return (
          (0, a.useEffect)(() => {
            "undefined" != typeof navigator &&
              (/(Mac|iPhone|iPod|iPad)/i.test(navigator.platform) ? t(s) : t(n));
          }, []),
          e
        );
      }
    },
    26859: (e, t, r) => {
      "use strict";
      r.d(t, { N: () => i });
      var a = r(54568),
        n = r(87799),
        s = r(22153);
      function i({ filename: e, children: t, expandable: r, ...i }) {
        let o = (0, s.p)("docs.code_block.copy");
        return (0, a.jsx)(n.NG, {
          filename: e,
          expandable: r?.toLowerCase() === "true",
          onCopied: (e, t) => o({ code: t }),
          ...i,
          children: t,
        });
      }
    },
    27833: (e, t, r) => {
      "use strict";
      r.d(t, { O: () => s });
      let a = "scrollbar-thin scrollbar-thumb-rounded",
        n = {
          dark: `${a} scrollbar-thumb-white/20 dark:scrollbar-thumb-white/20 hover:scrollbar-thumb-white/25 dark:hover:scrollbar-thumb-white/25 active:scrollbar-thumb-white/25 dark:active:scrollbar-thumb-white/25`,
          system: `${a} scrollbar-thumb-black/15 hover:scrollbar-thumb-black/20 active:scrollbar-thumb-black/20 dark:scrollbar-thumb-white/20 dark:hover:scrollbar-thumb-white/25 dark:active:scrollbar-thumb-white/25`,
        },
        s = (e) => ("system" === e ? n.system : n.dark);
    },
    28331: (e, t, r) => {
      "use strict";
      r.d(t, { Zk: () => i });
      var a = r(7620),
        n = r(30793),
        s = r(39282);
      let i = () => {
        let e = (() => {
            let {
              apiReferenceData: { endpoint: e },
            } = (0, a.useContext)(n.ApiReferenceContext);
            return e;
          })(),
          [{ endpoint: t }] = (0, s.O)();
        return (0, a.useMemo)(() => e ?? t, [e, t]);
      };
    },
    28835: (e, t, r) => {
      "use strict";
      r.d(t, { b: () => d });
      var a = r(54568),
        n = r(7620),
        s = r(76829),
        i = r(33052),
        o = r(68999),
        l = r(81325);
      let d = ({ options: e, selectedIndex: t, onSelectOption: r, noBackground: d }) => {
        let c = (0, s.n)(),
          p = (0, n.useId)(),
          u = `opt-dd-${p.replace(/:/g, "")}`,
          m = e
            .map(
              (e, t) =>
                `#${u}:has(option[value="${t}"]:checked) ~ [data-idx="${t}"] { display: flex; }`,
            )
            .join("\n");
        return (0, a.jsx)("div", {
          className: (0, l.cn)(i.x.OptionDropdown, "inline-flex relative !mr-0"),
          children: (0, a.jsxs)("div", {
            className: (0, l.cn)(
              "font-mono text-xs font-medium !inline-block !leading-4 items-center rounded-md space-x-1.5 text-gray-600 dark:text-gray-200 py-0.5",
              !d && "bg-gray-100/50 dark:bg-white/5",
            ),
            children: [
              (0, a.jsx)("style", { dangerouslySetInnerHTML: { __html: m } }),
              (0, a.jsxs)("div", {
                className: "group relative !inline-flex",
                children: [
                  (0, a.jsx)("select", {
                    id: u,
                    "aria-label": c["aria.selectSchemaType"],
                    className:
                      "absolute inset-0 w-full h-full flex opacity-0 cursor-pointer focus:outline-0",
                    onChange: (e) => r?.(e.target.selectedIndex),
                    value: t,
                    children: e.map((e, t) => (0, a.jsx)("option", { value: t, children: e }, t)),
                  }),
                  e.map((e, t) =>
                    (0, a.jsx)(
                      "span",
                      {
                        "data-idx": t,
                        "aria-hidden": "true",
                        className:
                          "hidden bg-transparent text-right pl-0.5 pr-8 group-hover:text-gray-950 dark:group-hover:text-white overflow-wrap-anywhere max-w-96",
                        children: e,
                      },
                      t,
                    ),
                  ),
                ],
              }),
              (0, a.jsx)(o.A, {
                icon: "angle-down",
                iconType: "solid",
                className:
                  "absolute top-1/2 -translate-y-1/2 right-4 h-2.5 w-2.5 shrink-0 bg-gray-500 dark:bg-gray-400 pointer-events-none",
              }),
            ],
          }),
        });
      };
    },
    33052: (e, t, r) => {
      "use strict";
      r.d(t, { x: () => a });
      let a = Object.fromEntries(
        Object.entries({
          Accordion: "accordion",
          AccordionGroup: "accordion-group",
          Callout: "callout",
          Card: "card",
          CardGroup: "card-group",
          CodeBlock: "code-block",
          CodeBlockIcon: "code-block-icon",
          CodeGroup: "code-group",
          Expandable: "expandable",
          Field: "field",
          Frame: "frame",
          Icon: "icon",
          Mermaid: "mermaid",
          Step: "step",
          Steps: "steps",
          Tab: "tab",
          Tabs: "tabs",
          TabIcon: "tab-icon",
          Update: "update",
          Tooltip: "tooltip",
          Panel: "panel",
          Prompt: "prompt",
          APISection: "api-section",
          APISectionHeading: "api-section-heading",
          APISectionHeadingTitle: "api-section-heading-title",
          APISectionHeadingSubtitle: "api-section-heading-subtitle",
          OptionDropdown: "option-dropdown",
          TryitButton: "tryit-button",
          MethodPill: "method-pill",
          MethodNavPill: "method-nav-pill",
          NavTagPill: "nav-tag-pill",
          NavTagPillText: "nav-tag-pill-text",
          Anchors: "nav-anchors",
          Anchor: "nav-anchor",
          TabsBar: "nav-tabs",
          TabsBarItem: "nav-tabs-item",
          MobileNavTabsBarItem: "mobile-nav-tabs-item",
          TableOfContents: "toc",
          TableOfContentsItem: "toc-item",
          Footer: "footer",
          AdvancedFooter: "advanced-footer",
          SidebarGroupIcon: "sidebar-group-icon",
          SidebarGroupHeader: "sidebar-group-header",
          SidebarTitle: "sidebar-title",
          SidebarGroup: "sidebar-group",
          SidebarNavGroupDivider: "sidebar-nav-group-divider",
          NavBarLink: "navbar-link",
          TopbarRightContainer: "topbar-right-container",
          Logo: "nav-logo",
          PaginationPrev: "pagination-prev",
          PaginationNext: "pagination-next",
          PaginationTitle: "pagination-title",
          FeedbackToolbar: "feedback-toolbar",
          Eyebrow: "eyebrow",
          BreadcrumbList: "breadcrumb-list",
          BreadcrumbItem: "breadcrumb-item",
          Content: "mdx-content",
          DropdownTrigger: "nav-dropdown-trigger",
          DropdownContent: "nav-dropdown-content",
          DropdownItem: "nav-dropdown-item",
          DropdownItemTextContainer: "nav-dropdown-item-text-container",
          DropdownItemTitle: "nav-dropdown-item-title",
          DropdownItemDescription: "nav-dropdown-item-description",
          DropdownItemIcon: "nav-dropdown-item-icon",
          ProductsSelectorTrigger: "nav-dropdown-products-selector-trigger",
          ProductsSelectorContent: "nav-dropdown-products-selector-content",
          ProductsSelectorItem: "nav-dropdown-products-selector-item",
          ProductsSelectorItemTitle: "nav-dropdown-products-selector-item-title",
          ProductsSelectorItemDescription: "nav-dropdown-products-selector-item-description",
          ProductsSelectorItemIcon: "nav-dropdown-products-selector-item-icon",
          Link: "link",
          AlmondLayout: "almond-layout",
          AlmondNavBottomSection: "almond-nav-bottom-section",
          AlmondNavBottomSectionDivider: "almond-nav-bottom-section-divider",
          ChatAssistantSheet: "chat-assistant-sheet",
          ChatAssistantSheetHeader: "chat-assistant-sheet-header",
          ChatAssistantSheetContent: "chat-assistant-sheet-content",
          ChatAssistantInput: "chat-assistant-input",
          ChatAssistantFloatingInput: "chat-assistant-floating-input",
          ChatAssistantSendButton: "chat-assistant-send-button",
          ChatAssistantDisclaimerText: "chat-assistant-disclaimer-text",
          ChatAssistantPayloadItem: "chat-assistant-payload-item",
          StarterQuestionText: "starter-question-text",
          LoginLink: "login-link",
          LogoutLink: "logout-link",
          ContextualFeedbackContainer: "contextual-feedback-container",
          ContextualFeedbackForm: "contextual-feedback-form",
          ContextualFeedbackFormTitle: "contextual-feedback-form-title",
          ContextualFeedbackFormInput: "contextual-feedback-input",
          ContextualFeedbackFormButton: "contextual-feedback-button",
          ContextualFeedbackFormSubmitButton: "contextual-feedback-form-submit-button",
          CodeSnippetFeedbackPopoverContent: "code-snippet-feedback-popover-content",
          CodeSnippetFeedbackForm: "code-snippet-feedback-form",
          CodeSnippetFeedbackButton: "code-snippet-feedback-button",
          CodeSnippetFeedbackTextArea: "code-snippet-feedback-textarea",
          CodeSnippetFeedbackFormTitle: "code-snippet-feedback-form-title",
          CodeSnippetFeedbackFormDescription: "code-snippet-feedback-form-description",
          CodeSnippetFeedbackFormSubmitButton: "code-snippet-feedback-form-submit-button",
          NotFoundContainer: "not-found-container",
          NotFoundStatusCode: "not-found-status-code",
          NotFoundTitle: "not-found-title",
          NotFoundDescription: "not-found-description",
          NotFoundLogo: "not-found-logo",
          NotFoundLogoContainer: "not-found-logo-container",
          NotFoundMessage: "not-found-message",
          NotFoundGoBackButton: "not-found-go-back-button",
          NotFoundGoBackArrow: "not-found-go-back-arrow",
          NotFoundGoBackText: "not-found-go-back-text",
          NotFoundRecommendedPagesList: "not-found-recommended-pages-list",
          NotFoundRecommendedPageLink: "not-found-recommended-page-link",
          MultiViewItem: "multi-view-item",
          MultiViewDropdown: "multi-view-dropdown",
          MultiViewDropdownTrigger: "multi-view-dropdown-trigger",
          MultiViewDropdownContent: "multi-view-dropdown-content",
          MultiViewDropdownItem: "multi-view-dropdown-item",
          Color: "color",
          ColorRow: "color-row",
          ColorItem: "color-item",
          Tile: "tile",
          Tree: "tree",
          TreeFolder: "tree-folder",
          TreeFile: "tree-file",
        }).map(([e, t]) => [e, `${t}`]),
      );
    },
    34972: (e, t, r) => {
      "use strict";
      r.d(t, { S: () => i });
      var a = r(7620),
        n = r(74092),
        s = r(16816);
      function i(e) {
        let t = (0, s.lu)(e),
          [r, i] = (0, a.useState)(t instanceof Promise ? void 0 : t);
        return (
          (0, n.E)(() => {
            if (!(t instanceof Promise)) {
              return void i(t);
            }
            let e = !1;
            return (
              (async function () {
                if (!(t instanceof Promise)) {
                  return i(t);
                }
                try {
                  let r = await t;
                  e || i(r);
                } catch (t) {
                  (console.error(t), e || i(void 0));
                }
              })(),
              () => {
                e = !0;
              }
            );
          }, [e, t]),
          r
        );
      }
    },
    35590: (e, t, r) => {
      "use strict";
      r.d(t, { AM: () => i, Wv: () => o, dT: () => d, hl: () => l });
      var a = r(54568),
        n = r(36915);
      r(7620);
      var s = r(81325);
      function i({ ...e }) {
        return (0, a.jsx)(n.bL, { "data-slot": "popover", ...e });
      }
      function o({ ...e }) {
        return (0, a.jsx)(n.l9, { "data-slot": "popover-trigger", ...e });
      }
      function l({ className: e, align: t = "center", sideOffset: r = 4, ...i }) {
        return (0, a.jsx)(n.ZL, {
          children: (0, a.jsx)(n.UC, {
            "data-slot": "popover-content",
            align: t,
            sideOffset: r,
            className: (0, s.cn)(
              "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-hidden",
              e,
            ),
            ...i,
          }),
        });
      }
      function d(e) {
        return (0, a.jsx)(n.Mz, { "data-slot": "popover-anchor", ...e });
      }
    },
    35878: (e, t, r) => {
      "use strict";
      r.d(t, { V: () => a });
      var a = (function (e) {
        return (
          (e.Navbar = "navbar"),
          (e.Header = "header"),
          (e.SearchBarEntry = "search-bar-entry"),
          (e.SearchBarEntryMobile = "search-bar-entry-mobile"),
          (e.AssistantEntry = "assistant-entry"),
          (e.AssistantEntryMobile = "assistant-entry-mobile"),
          (e.RequestExample = "request-example"),
          (e.ResponseExample = "response-example"),
          (e.TopbarCtaButton = "topbar-cta-button"),
          (e.Sidebar = "sidebar"),
          (e.Footer = "footer"),
          (e.Banner = "banner"),
          (e.ContentArea = "content-area"),
          (e.Content = "content"),
          (e.SidebarContent = "sidebar-content"),
          (e.NavBarTransition = "navbar-transition"),
          (e.NavigationItems = "navigation-items"),
          (e.ContentContainer = "content-container"),
          (e.ContentSideLayout = "content-side-layout"),
          (e.TableOfContents = "table-of-contents"),
          (e.TableOfContentsLayout = "table-of-contents-layout"),
          (e.TableOfContentsContent = "table-of-contents-content"),
          (e.ChangelogFilters = "changelog-filters"),
          (e.ChangelogFiltersContent = "changelog-filters-content"),
          (e.Pagination = "pagination"),
          (e.PageTitle = "page-title"),
          (e.PageContextMenu = "page-context-menu"),
          (e.PageContextMenuButton = "page-context-menu-button"),
          (e.Panel = "panel"),
          (e.ChatAssistantSheet = "chat-assistant-sheet"),
          (e.ChatAssistantTextArea = "chat-assistant-textarea"),
          (e.SearchInput = "search-input"),
          (e.APIPlaygroundInput = "api-playground-input"),
          (e.AskAiCodeBlockButton = "ask-ai-code-block-button"),
          (e.CodeSnippetFeedbackButton = "code-snippet-feedback-button"),
          (e.CodeSnippetFeedbackTextArea = "code-snippet-feedback-textarea"),
          (e.EndpointsMenuTrigger = "endpoints-menu-trigger"),
          (e.MobileNav = "mobile-nav"),
          (e.MobileNavContent = "mobile-nav-content"),
          (e.LocalizationSelectTrigger = "localization-select-trigger"),
          (e.LocalizationSelectContent = "localization-select-content"),
          (e.LocalizationSelectItem = "localization-select-item"),
          (e.AssistantBarPlaceholder = "assistant-bar-placeholder"),
          (e.MultiViewDropdown = "multi-view-dropdown"),
          (e.TextSelectionTooltip = "text-selection-tooltip"),
          (e.TextSelectionTooltipButton = "text-selection-tooltip-button"),
          (e.BodyContent = "body-content"),
          (e.FeedbackThumbsUp = "feedback-thumbs-up"),
          (e.FeedbackThumbsDown = "feedback-thumbs-down"),
          (e.FeedbackForm = "feedback-form"),
          (e.FeedbackFormInput = "feedback-form-input"),
          (e.FeedbackFormCancel = "feedback-form-cancel"),
          (e.FeedbackFormSubmit = "feedback-form-submit"),
          (e.AlmondBackground = "almond-background-color"),
          e
        );
      })({});
    },
    36140: (e, t, r) => {
      "use strict";
      r.d(t, { b: () => k });
      var a = r(54568),
        n = r(14571),
        s = r(55575),
        i = r(27541),
        o = r(7620),
        l = r.t(o, 2),
        d = r(9601),
        c = r(79634),
        p = r(7755),
        u = r(72179),
        m = r(71252),
        h = r(7603),
        x = r(97637),
        g = r(68429),
        f = r(46540),
        y = r(81325);
      let b = "rounded",
        v = {
          img: (e) => (0, a.jsx)(x.p, { ...e, className: (0, y.cn)(b, e.className) }),
          picture: (e) =>
            (0, a.jsx)(f.T, {
              ...e,
              children: (0, a.jsx)("picture", { className: (0, y.cn)(b, e.className) }),
            }),
          figure: (e) =>
            (0, a.jsx)(f.T, {
              ...e,
              children: (0, a.jsx)("figure", { ...e, className: (0, y.cn)(b, e.className) }),
            }),
          p: (e) => (0, a.jsx)("span", { "data-as": "p", ...e }),
          iframe: (e) => (0, a.jsx)(h.j, { ...e }),
          table: (e) => (0, a.jsx)(g.X, { ...e }),
        };
      function j() {
        return (0, a.jsxs)("div", {
          className: "animate-pulse space-y-6",
          children: [
            (0, a.jsx)("div", { className: "h-8 bg-gray-200 dark:bg-gray-700 rounded w-3/4" }),
            (0, a.jsxs)("div", {
              className: "space-y-3",
              children: [
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-full" }),
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-5/6" }),
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-4/6" }),
              ],
            }),
            (0, a.jsxs)("div", {
              className: "space-y-3",
              children: [
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-full" }),
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-3/4" }),
              ],
            }),
            (0, a.jsx)("div", { className: "h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/2" }),
            (0, a.jsxs)("div", {
              className: "space-y-3",
              children: [
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-full" }),
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-5/6" }),
                (0, a.jsx)("div", { className: "h-4 bg-gray-200 dark:bg-gray-700 rounded w-2/3" }),
              ],
            }),
          ],
        });
      }
      let k = ({
        mdxSource: e,
        mdxSourceWithNoJs: t,
        pageMetadata: r,
        userInfo: h,
        forceIsLoading: x,
      }) => {
        let [g, f] = (0, o.useState)(!1),
          y = (0, i.usePathname)(),
          {
            isLivePreview: b,
            getCompiledContent: k,
            livePreviewUpdateId: w,
            isPathLoading: N,
          } = (0, o.useContext)(m.K),
          C = (0, o.useMemo)(() => (y ? "/" + (0, u.Tn)(y).replace(/^\//, "") : ""), [y]),
          S = (0, o.useMemo)(() => {
            if (b && C) {
              return k(C);
            }
          }, [b, C, k, w]),
          O = x || (b && C && N(C));
        (0, o.useEffect)(() => {
          f(!0);
          let e = (e) => {
            if (3 === e.detail) {
              let t = e.target;
              if (t && t instanceof HTMLElement) {
                let r = t.closest(":not(pre) > code");
                if (r) {
                  e.preventDefault();
                  let t = window.getSelection(),
                    a = document.createRange();
                  (a.selectNodeContents(r), t?.removeAllRanges(), t?.addRange(a));
                }
              }
            }
          };
          return (
            document.addEventListener("mousedown", e),
            () => {
              document.removeEventListener("mousedown", e);
            }
          );
        }, []);
        let $ = S?.mdxSource ?? e,
          T = S?.mdxSourceWithNoJs ?? t;
        return O
          ? (0, a.jsx)(j, {})
          : (0, a.jsx)(n.x, {
              components: { a: c.DynamicLink, Heading: p.D, ...v },
              children: (0, a.jsx)(s.L, {
                components: d.A,
                compiledSource: g ? $.compiledSource : T.compiledSource,
                frontmatter: $.frontmatter,
                scope: {
                  pageMetadata: r,
                  user: h?.content ?? {},
                  ...(g
                    ? {
                        React: l,
                        useState: o.useState,
                        useEffect: o.useEffect,
                        useRef: o.useRef,
                        useCallback: o.useCallback,
                        useMemo: o.useMemo,
                        useReducer: o.useReducer,
                        useContext: o.useContext,
                        useLayoutEffect: o.useLayoutEffect,
                        useImperativeHandle: o.useImperativeHandle,
                        useDebugValue: o.useDebugValue,
                        useDeferredValue: o.useDeferredValue,
                        useTransition: o.useTransition,
                        useId: o.useId,
                        useSyncExternalStore: o.useSyncExternalStore,
                        useInsertionEffect: o.useInsertionEffect,
                      }
                    : {}),
                },
              }),
            });
      };
    },
    37113: (e, t, r) => {
      "use strict";
      r.d(t, { f: () => n });
      var a = r(7620);
      let n = ({
        key: e,
        callback: t,
        isSingleKey: r,
        excludedActiveElementId: n,
        excludedActiveElements: s,
        isDisabled: i,
      }) => {
        let o = (0, a.useCallback)(
          (a) => {
            if (i) {
              return;
            }
            let o = !1,
              l = document.activeElement;
            (n && (o = !!l?.id && n.includes(l.id)),
              s && !o && (o = s.includes(l?.tagName.toLowerCase())),
              a.key === e && (r || a.metaKey || a.ctrlKey) && !o && (a.preventDefault(), t?.()));
          },
          [t, e, r, n, s, i],
        );
        (0, a.useEffect)(
          () => (addEventListener("keydown", o), () => removeEventListener("keydown", o)),
          [o],
        );
      };
    },
    38637: (e, t, r) => {
      "use strict";
      r.d(t, { m5: () => l, Es: () => i, U_: () => o });
      var a = r(35878),
        n = r(33052);
      let s = "chat-payload-highlight",
        i = (e) => {
          if (e.elementId) {
            let t = e.elementId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              r = document.querySelector(`[data-chat-payload-element-id="${t}"]`),
              a = r?.closest(`.${n.x.CodeBlock}`) || r?.closest(`.${n.x.CodeGroup}`);
            if (a) {
              return (
                a.scrollIntoView({ behavior: "auto", block: "center" }),
                a.classList.add(
                  "ring-2",
                  "ring-offset-[-1px]",
                  "ring-primary",
                  "dark:ring-primary-light",
                ),
                setTimeout(() => {
                  let e = a.getBoundingClientRect(),
                    t = window.innerHeight;
                  Math.abs(e.top + e.height / 2 - t / 2) > 100 &&
                    a.scrollIntoView({ behavior: "auto", block: "center" });
                }, 200),
                setTimeout(() => {
                  a.classList.remove(
                    "ring-2",
                    "ring-offset-[-1px]",
                    "ring-primary",
                    "dark:ring-primary-light",
                  );
                }, 3e3),
                !0
              );
            }
          }
          if ("textSelection" === e.type && e.value) {
            try {
              let t = ((e, t) => {
                let r = document.getElementById(t);
                if (!r) return !1;
                let a = (e) => e.replace(/\s+/g, " ").trim(),
                  n = a(e);
                for (let e of r.querySelectorAll(
                  "p, span, li, h1, h2, h3, h4, h5, h6, td, th, a, code, pre, blockquote, dd, dt, label, figcaption, caption, summary, div",
                ))
                  if (a(e.textContent || "").includes(n)) {
                    let t;
                    e.scrollIntoView({ behavior: "auto", block: "center" });
                    let r = document.createRange(),
                      s = window.getSelection(),
                      i = [],
                      o = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
                    for (; (t = o.nextNode()); ) i.push(t);
                    let l = "",
                      d = [];
                    for (let e of i) {
                      let t = e.textContent;
                      if (t)
                        for (let r = 0; r < t.length; r++)
                          ((l += t[r]), d.push({ node: e, offset: r }));
                    }
                    let c = a(l),
                      p = c.indexOf(n);
                    if (-1 !== p) {
                      let t = p + n.length,
                        a = 0,
                        s = -1,
                        i = -1;
                      for (let e = 0; e < l.length; e++) {
                        let r = l[e];
                        if (!r) continue;
                        let n = /\s/.test(r);
                        if (
                          (a === p && -1 === s && (s = e),
                          n
                            ? a < c.length && " " === c[a] && a++
                            : a < c.length && c[a] === r && a++,
                          a === t && -1 === i)
                        ) {
                          i = e + 1;
                          break;
                        }
                      }
                      let o = -1 !== s ? d[s] : void 0,
                        u = -1 !== i ? d[i - 1] : void 0;
                      o && u
                        ? (r.setStart(o.node, o.offset), r.setEnd(u.node, u.offset + 1))
                        : r.selectNodeContents(e);
                    } else r.selectNodeContents(e);
                    return (s?.removeAllRanges(), s?.addRange(r), !0);
                  }
                return !1;
              })(e.value.trim(), a.V.Content);
              return (
                t &&
                  setTimeout(() => {
                    let e = window.getSelection();
                    if (e && e.rangeCount > 0) {
                      let t = e.getRangeAt(0),
                        r = t.getBoundingClientRect(),
                        a = window.innerHeight;
                      if (r.top < 100 || r.bottom > a - 100) {
                        let e = t.startContainer.parentElement;
                        e?.scrollIntoView({ behavior: "auto", block: "center" });
                      }
                    }
                  }, 200),
                !!t
              );
            } catch (e) {
              console.error("Error finding and selecting text:", e);
            }
          }
          return !1;
        },
        o = (e) => {
          try {
            sessionStorage.setItem(s, JSON.stringify(e));
          } catch (e) {
            console.error("Unable to schedule payload highlight:", e);
          }
        },
        l = () => {
          let e = null;
          try {
            e = sessionStorage.getItem(s);
          } catch {
            return null;
          }
          if (!e) {
            return null;
          }
          try {
            sessionStorage.removeItem(s);
          } catch {}
          try {
            return JSON.parse(e);
          } catch (e) {
            return (console.error("Unable to parse scheduled payload highlight:", e), null);
          }
        };
    },
    39282: (e, t, r) => {
      "use strict";
      r.d(t, { O: () => s });
      var a = r(7620),
        n = r(54808);
      let s = () => (0, a.useContext)(n.gl);
    },
    40599: (e, t, r) => {
      "use strict";
      r.d(t, { D: () => o });
      var a = r(7620),
        n = r(30793),
        s = r(71252),
        i = r(67377);
      let o = () => {
        let e,
          t = "interactive",
          { docsConfig: r } = (0, a.useContext)(n.DocsConfigContext),
          { isLivePreview: o, getDocsConfigOverrides: l } = (0, a.useContext)(s.K),
          d = l(),
          c = d?.api?.playground?.display,
          { pageMetadata: p } = (0, a.useContext)(n.PageContext),
          { apiReferenceData2: u } = (0, a.useContext)(n.ApiReferenceContext2),
          m = (0, i.f)();
        if (
          (u.operation && (e = u.operation.type),
          r?.api?.playground?.display && (t = r.api.playground.display),
          o && c && (t = c),
          p.playground && (t = p.playground),
          "auth" === t)
        ) {
          let e = p.groups && Array.isArray(p.groups),
            r = m && Array.isArray(m);
          t = (e && r && p.groups?.some((e) => m.includes(e))) || !e ? "interactive" : "none";
        }
        return ("webhook" === e && (t = "simple"), t);
      };
    },
    40711: (e, t, r) => {
      "use strict";
      r.d(t, { k: () => d });
      var a = r(54568),
        n = r(19664),
        s = r.n(n),
        i = r(81325),
        o = r(8239),
        l = r(41995);
      let d = ({
        href: e,
        onClick: t,
        title: r,
        titleContainerClassName: n,
        onInternalLinkClick: d,
      }) =>
        (0, o.K)(e)
          ? (0, a.jsx)(l.s, { href: e, onClick: t, title: r, className: "gap-1" })
          : (0, a.jsx)(s(), {
              href: e,
              onClick: () => {
                (d?.(), t());
              },
              children: (0, a.jsx)("span", {
                className: (0, i.cn)(
                  "flex items-center text-sm hover:brightness-[0.75] dark:hover:brightness-[1.35] text-primary dark:text-primary-light",
                  n,
                ),
                children: (0, a.jsx)("span", { className: "truncate font-medium", children: r }),
              }),
            });
    },
    41363: (e, t, r) => {
      "use strict";
      r.d(t, { z: () => l });
      var a = r(54568),
        n = r(7620),
        s = r(15209),
        i = r(65904),
        o = r(34972);
      let l = (0, n.memo)(function ({ language: e, children: t }) {
        let r = (0, s.O)();
        e = e ?? "text";
        let n = (0, o.S)({
          codeString: "string" == typeof t ? t : "",
          codeBlockTheme: r,
          language: e,
          opts: { structure: "inline" },
        });
        return "string" == typeof t && e && n
          ? (0, a.jsx)("pre", {
              className: i.SHIKI_CLASSNAME,
              suppressHydrationWarning: !0,
              children: (0, a.jsx)("code", {
                suppressHydrationWarning: !0,
                dangerouslySetInnerHTML: { __html: n },
              }),
            })
          : (0, a.jsx)("pre", {
              className: i.SHIKI_CLASSNAME,
              suppressHydrationWarning: !0,
              children: (0, a.jsx)("code", { suppressHydrationWarning: !0, children: t }),
            });
      });
    },
    41995: (e, t, r) => {
      "use strict";
      r.d(t, { s: () => i });
      var a = r(54568),
        n = r(34920),
        s = r(81325);
      let i = ({ href: e, onClick: t, title: r, className: i }) =>
        (0, a.jsx)("a", {
          href: e,
          onClick: t,
          target: "_blank",
          rel: "noopener noreferrer",
          className: "block",
          children: (0, a.jsxs)("span", {
            className: (0, s.cn)(
              "flex items-center text-sm hover:brightness-[0.75] dark:hover:brightness-[1.35] text-primary dark:text-primary-light",
              i,
            ),
            children: [
              (0, a.jsx)("span", { className: "truncate font-medium", children: r }),
              (0, a.jsx)(n.A, { size: 10, className: "flex-shrink-0 opacity-60" }),
            ],
          }),
        });
    },
    42758: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => i, y: () => s });
      var a = r(54568);
      let n = (0, r(7620).createContext)({});
      function s({ value: e, children: t }) {
        return (0, a.jsx)(n.Provider, { value: e ?? {}, children: t });
      }
      n.displayName = "AnalyticsContext";
      let i = n;
    },
    42945: (e, t, r) => {
      "use strict";
      r.d(t, { o: () => o, t: () => x });
      var a = r(54568),
        n = r(33052),
        s = r(68999),
        i = r(81325);
      function o({ title: e, isActive: t = !0, icon: r, iconType: o, children: l }) {
        return (0, a.jsxs)(a.Fragment, {
          children: [
            (0, a.jsxs)("div", {
              className: (0, i.cn)(
                "flex text-sm items-center gap-1.5 leading-6 font-semibold whitespace-nowrap pt-3 pb-2.5 -mb-px max-w-max border-b",
                t
                  ? "text-primary dark:text-primary-light border-current"
                  : "text-gray-900 border-transparent hover:border-gray-300 dark:text-gray-200 dark:hover:border-gray-700",
              ),
              "data-component-part": "tab-button",
              "data-active": t,
              "data-testid": `tab-${e}`,
              children: [
                r &&
                  (0, a.jsx)(s.ComponentIcon, {
                    icon: r,
                    iconType: o,
                    className: (0, i.cn)(
                      "h-4 w-4 shrink-0",
                      t ? "bg-primary dark:bg-primary-light" : "bg-gray-900 dark:bg-gray-200",
                      n.x.TabIcon,
                    ),
                    overrideColor: !0,
                  }),
                " ",
                e,
              ],
            }),
            l
              ? (0, a.jsx)("div", {
                  className: "prose dark:prose-dark",
                  "data-component-part": "tab-content",
                  children: l,
                })
              : null,
          ],
        });
      }
      var l = r(52648),
        d = r(54578),
        c = r(7620),
        p = r(84583),
        u = r(7844),
        m = r(65542);
      let h = "Tab Title";
      function x({
        children: e,
        defaultTabIndex: t = 0,
        onClickTab: r,
        className: s,
        borderBottom: x,
        sync: g = !0,
      }) {
        let f = (0, c.useRef)(null),
          y = (0, c.useRef)(null),
          b = (0, c.useRef)([]),
          v = (0, c.useMemo)(
            () => c.Children.toArray(e).filter((e) => (0, c.isValidElement)(e)),
            [e],
          ),
          j = (0, c.useMemo)(
            () =>
              v.map((e) => {
                if (e.props?.id) {
                  return e.props.id;
                }
                let t = e.props?.title || h;
                return (0, l.Y)(t);
              }),
            [v],
          ),
          k = (0, c.useMemo)(() => v.map((e) => e.props.title), [v]),
          w = (0, c.useCallback)((e) => {
            if (!y.current) {
              return null;
            }
            let t = CSS.escape(e),
              r = y.current.querySelector(`#${t}`);
            if (!r) {
              return null;
            }
            let a = y.current.children;
            for (let e = 0; e < a.length; e++) {
              let t = a[e];
              if (t?.contains(r)) {
                return e;
              }
            }
            return null;
          }, []),
          { activeIndex: N, setActiveIndex: C } = (0, m.i)({
            tabIds: j,
            tabLabels: k,
            defaultIndex: t,
            onIndexChange: r,
            findInPanels: w,
            sync: g,
          }),
          { hasScrolledToAnchorRef: S } = (0, c.useContext)(p.m$),
          O = (0, c.useRef)(!1);
        ((0, c.useEffect)(() => {
          if (O.current) {
            return;
          }
          let e = window.location.hash.substring(1);
          e &&
            ((O.current = !0),
            setTimeout(() => {
              (0, u.h)({
                shouldReturnEarly: !!S?.current,
                element: document.getElementById(e),
                postScrollCallback() {
                  S && (S.current = !0);
                },
              });
            }, 10));
        }, [S]),
          (0, c.useEffect)(() => {
            let e = () => {
              let e = window.location.hash.substring(1);
              e &&
                setTimeout(() => {
                  (0, u.h)({
                    shouldReturnEarly: !!S?.current,
                    element: document.getElementById(e),
                    postScrollCallback() {
                      S && (S.current = !0);
                    },
                  });
                }, 10);
            };
            return (
              window.addEventListener("hashchange", e),
              () => {
                window.removeEventListener("hashchange", e);
              }
            );
          }, [S]));
        let $ = (0, c.useCallback)(
          (e, t = !0) => {
            e !== N && C({ index: e, updateHash: t, updatePersist: !1 });
          },
          [N, C],
        );
        return (0, a.jsxs)("div", {
          className: (0, i.cn)(
            n.x.Tabs,
            "tabs tab-container",
            x && "border-b border-gray-200 dark:border-gray-200/10 pb-6",
          ),
          id: j[N],
          children: [
            (0, a.jsx)("ul", {
              ref: f,
              role: "tablist",
              className: (0, i.cn)(
                "not-prose mb-6 pb-[1px] flex-none min-w-full overflow-auto border-b border-gray-200 gap-x-6 flex dark:border-gray-200/10",
                s,
              ),
              "data-component-part": "tabs-list",
              children: v.map((e, t) =>
                (0, a.jsx)(
                  "li",
                  {
                    ref: (e) => {
                      b.current[t] = e;
                    },
                    id: j[t],
                    role: "tab",
                    "aria-selected": t === N,
                    "aria-controls": `panel-${j[t]}-${t}`,
                    tabIndex: t === N ? 0 : -1,
                    className: "cursor-pointer",
                    onClick: (e) => {
                      (e.stopPropagation(), $(t, e.isTrusted));
                    },
                    onKeyDown: (e) => {
                      if ("ArrowLeft" === e.key || "ArrowRight" === e.key) {
                        e.preventDefault();
                        let r =
                          "ArrowLeft" === e.key
                            ? (t - 1 + v.length) % v.length
                            : (t + 1) % v.length;
                        ($(r),
                          setTimeout(() => {
                            b.current[r]?.focus();
                          }, 0));
                      }
                    },
                    "data-child-tab-ids": e.props?.[d.r2],
                    "data-child-heading-ids": e.props?.[d.ki],
                    children: (0, a.jsx)(o, {
                      title: e.props?.title ?? h,
                      icon: e.props?.icon,
                      iconType: e.props?.iconType,
                      isActive: t === N,
                    }),
                  },
                  `${j[t]}-${t}`,
                ),
              ),
            }),
            (0, a.jsx)("div", {
              ref: y,
              children: v.map((e, t) =>
                (0, a.jsx)(
                  "div",
                  {
                    id: `panel-${j[t]}-${t}`,
                    role: "tabpanel",
                    "aria-labelledby": j[t],
                    className: (0, i.cn)(
                      'prose dark:prose-dark overflow-x-auto [&_[data-table-wrapper]]:![--page-padding:0px] [&_[role="listitem"]]:pl-4',
                      t !== N && "hidden",
                    ),
                    "data-component-part": "tab-content",
                    children: e.props?.children,
                  },
                  `${j[t]}-${t}`,
                ),
              ),
            }),
          ],
        });
      }
    },
    44564: (e, t, r) => {
      "use strict";
      r.d(t, { J: () => n, x: () => a });
      let a = (e, t) => e?.[t]?.status === "ENABLED",
        n = (e, t) => a(e, t) && e?.[t]?.enabled !== "DISABLED";
    },
    46540: (e, t, r) => {
      "use strict";
      r.d(t, { T: () => i });
      var a = r(54568),
        n = r(96442);
      r(7620);
      let s = (0, n.default)(
          () =>
            r
              .e(50528)
              .then(r.bind(r, 50528))
              .then((e) => e.default),
          { loadableGenerated: { webpack: () => [50528] } },
        ),
        i = ({ children: e, noZoom: t, zoomImg: r }) =>
          t
            ? (0, a.jsx)(a.Fragment, { children: e })
            : (0, a.jsx)(s, {
                wrapElement: (() => {
                  let e = window.navigator.userAgent;
                  return /Safari/.test(e) && !/Chrome/.test(e) && !/Chromium/.test(e);
                })()
                  ? "div"
                  : "span",
                zoomMargin: 50,
                zoomImg: r,
                children: e,
              });
    },
    47922: (e, t, r) => {
      "use strict";
      r.d(t, { _T: () => n, pC: () => s });
      var a = r(43967);
      let n = "mintlify-auth";
      async function s() {
        return (await (0, a.l$)(n, i)) ?? { query: {}, header: {}, cookie: {} };
      }
      let i = (e) =>
        "object" == typeof e &&
        null != e &&
        ["header", "cookie", "query"].every((t) => "object" == typeof e[t] && null != e[t]);
    },
    48059: (e, t, r) => {
      "use strict";
      r.d(t, { S7: () => x, pO: () => h });
      var a = r(54568),
        n = r(76441),
        s = r(7620),
        i = r(71252),
        o = r(15209),
        l = r(81325),
        d = r(27833),
        c = r(69494),
        p = r(34972),
        u = r(65904);
      let m = (e) => "transparent" === e || void 0 === e,
        h = 7,
        x = ({
          expandable: e = !1,
          shouldHighlight: t = !0,
          children: r,
          isParentCodeGroup: n,
          isSmallText: x,
          numberOfLines: f,
          ...y
        }) => {
          let { focus: b, highlight: v, lang: j, language: k, className: w, wrap: N, lines: C } = y,
            { isLivePreview: S } = (0, s.useContext)(i.K),
            O = (0, c.Fr)(r, y.className, S),
            $ = (0, o.e)(),
            T = (0, o.O)(),
            {
              isExpanded: E,
              calculatedHeight: A,
              contentRef: P,
              toggleExpanded: I,
            } = ((e, t) => {
              let [r, a] = (0, s.useState)(!1),
                [n, i] = (0, s.useState)(0),
                o = (0, s.useRef)(null);
              return (
                (0, s.useEffect)(() => {
                  null != o.current &&
                    e &&
                    requestAnimationFrame(() => {
                      null != o.current && i(o.current.scrollHeight + (t && t < h ? 30 : 40));
                    });
                }, [e, o.current?.scrollHeight, t]),
                {
                  isExpanded: r,
                  calculatedHeight: n,
                  contentRef: o,
                  toggleExpanded: () => a((e) => !e),
                }
              );
            })(e, f),
            _ = {},
            q = [],
            F = [];
          if (b) {
            try {
              q = JSON.parse(b);
            } catch {
              q = [];
            }
          }
          if (v) {
            try {
              F = JSON.parse(v);
            } catch {
              F = [];
            }
          }
          (F.length > 0 && (_.highlightedLines = F), q.length > 0 && (_.focusedLines = q));
          let R = j || k,
            L = (0, p.S)(
              R
                ? { codeString: O, codeBlockTheme: T, language: t ? R : "text", opts: _ }
                : { codeString: O, codeBlockTheme: T, className: t ? w : "lang-text", opts: _ },
            );
          f = (0, c.c$)(L, f);
          let D = ((e, t, r) => {
              let a =
                "dark" === e
                  ? { light: u.DEFAULT_DARK_BG, dark: u.DEFAULT_DARK_BG }
                  : { light: u.DEFAULT_LIGHT_BG, dark: u.DEFAULT_DARK_BG };
              return t
                ? ((e, t) => {
                    let r = e.split('style="');
                    if (r.length < 2) {
                      return t;
                    }
                    let a = r[1]?.split("background-color:")[1]?.split(";")[0],
                      n = r[1]?.split("--shiki-dark-bg:")[1]?.split(";")[0];
                    return { light: m(a) ? t.light : a, dark: m(n) ? t.dark : n };
                  })(t, a)
                : r
                  ? ((e, t) =>
                      e &&
                      "object" == typeof e &&
                      "props" in e &&
                      e.props &&
                      "object" == typeof e.props &&
                      "style" in e.props &&
                      "object" == typeof e.props.style &&
                      e.props.style &&
                      "object" == typeof e.props.style &&
                      "backgroundColor" in e.props.style &&
                      "string" == typeof e.props.style.backgroundColor &&
                      "--shiki-dark-bg" in e.props.style &&
                      "string" == typeof e.props.style["--shiki-dark-bg"]
                        ? {
                            light: m(e.props.style.backgroundColor)
                              ? t.light
                              : e.props.style.backgroundColor,
                            dark: m(e.props.style["--shiki-dark-bg"])
                              ? t.dark
                              : e.props.style["--shiki-dark-bg"],
                          }
                        : t)(r, a)
                  : a;
            })($, L, r),
            M = q.length > 0,
            B = F.length > 0;
          return (0, a.jsxs)(a.Fragment, {
            children: [
              (0, a.jsx)("div", {
                className: (0, l.cn)(
                  "w-0 min-w-full max-w-full py-3.5 px-4 h-full dark:bg-codeblock relative text-sm leading-6 children:!my-0 children:!shadow-none children:!bg-transparent",
                  "transition-[height] duration-300 ease-in-out overflow-x-auto code-block-background",
                  "[&_*]:ring-0 [&_*]:outline-0 [&_*]:focus:ring-0 [&_*]:focus:outline-0",
                  y.filename ? "rounded-xt" : "rounded-2xl",
                  "system" === $ ? "bg-white" : "bg-codeblock",
                  (e || n) && "overflow-auto",
                  e && (E ? "overflow-y-auto" : "overflow-y-hidden"),
                  N ? "code-block-wrap overflow-x-hidden whitespace-pre-wrap" : "overflow-x-auto",
                  C && "has-line-numbers",
                  M && "has-focused",
                  B && "has-highlighted",
                  (0, d.O)($),
                ),
                "data-component-part": "code-block-root",
                tabIndex: 0,
                style: {
                  fontVariantLigatures: "none",
                  height: e ? (E ? `${A}px` : `${f && f < h ? 45 : 190}px`) : n ? "100%" : "auto",
                  backgroundColor: D?.light,
                  "--shiki-dark-bg": D?.dark,
                },
                children: (0, a.jsx)(
                  () =>
                    L
                      ? (0, a.jsx)(
                          "div",
                          {
                            suppressHydrationWarning: !0,
                            ref: P,
                            className: (0, l.cn)(
                              "font-mono",
                              N ? "whitespace-pre-wrap" : "whitespace-pre",
                              n && "flex-none text-sm h-full",
                              x ? "text-xs leading-[1.35rem]" : "leading-6",
                            ),
                            ...(n && { "data-component-part": "code-group-tab-content" }),
                            dangerouslySetInnerHTML: { __html: L },
                          },
                          $,
                        )
                      : (0, a.jsx)("div", {
                          suppressHydrationWarning: !0,
                          ref: P,
                          className: (0, l.cn)(
                            "font-mono",
                            N ? "whitespace-pre-wrap" : "whitespace-pre",
                            n && "flex-none text-sm h-full",
                            x ? "text-xs leading-[1.35rem]" : "leading-6",
                          ),
                          ...(n && { "data-component-part": "code-group-tab-content" }),
                          children: r,
                        }),
                  {},
                ),
              }),
              !N &&
                !B &&
                !e &&
                0 === q.length &&
                (0, a.jsx)("div", {
                  "data-fade-overlay": !0,
                  "aria-hidden": !0,
                  style: { "--fade-color-light": D?.light, "--fade-color-dark": D?.dark },
                }),
              e && (0, a.jsx)(g, { isExpanded: E, toggleExpanded: I, numberOfLines: f }),
            ],
          });
        };
      function g({ numberOfLines: e, isExpanded: t, toggleExpanded: r }) {
        return e
          ? (0, a.jsx)("div", {
              "data-component-part": "code-block-footer",
              className:
                "px-3 py-1 flex items-center text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300",
              children: (0, a.jsxs)("button", {
                "data-component-part": "code-block-footer-button",
                className: "flex-1 gap-1.5 flex items-center py-1.5",
                onClick: r,
                children: [
                  (0, a.jsx)(n.A, {
                    className: "h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-gray-400",
                  }),
                  t ? "Collapse" : `See all ${e} line${1 === e ? "" : "s"}`,
                ],
              }),
            })
          : null;
      }
    },
    49765: (e, t, r) => {
      "use strict";
      r.d(t, { f: () => n });
      let a = {
          language: !0,
          filename: !0,
          icon: !0,
          lang: !0,
          lines: !0,
          wrap: !0,
          expandable: !0,
          highlight: !0,
          focus: !0,
          numberOfLines: !0,
          hideAskAiButton: !0,
          hideCodeSnippetFeedbackButton: !0,
          isSmallText: !0,
        },
        n = (e) => {
          if (!e) {
            return {};
          }
          let t = {};
          return (
            Object.keys(a).forEach((r) => {
              void 0 !== e[r] && (t[r] = e[r]);
            }),
            t
          );
        };
    },
    49897: (e, t, r) => {
      "use strict";
      (r.d(t, { rV: () => a, sb: () => n, s4: () => s }),
        r(7620),
        r(30793),
        r(98167),
        r(22153),
        r(60130),
        r(60996).Buffer);
      let a = (e, t) =>
          Object.entries(t).reduce(
            (e, [t, r]) =>
              void 0 == r ? e : e.replace(`{${t}}`, encodeURIComponent(r.toString())),
            e,
          ),
        n = (e, t) => {
          let r = e;
          return (
            Object.entries(t).forEach(([e, t]) => {
              t && (r = r.replace(`{${e}}`, t));
            }),
            r
          );
        },
        s = (e, t) => e.replace(/\/$/, "") + "/" + t.replace(/^\//, "");
    },
    49962: (e, t, r) => {
      "use strict";
      r.d(t, { a: () => o });
      var a = r(7620),
        n = r(30793),
        s = r(16903),
        i = r(59705);
      let o = () => {
        let { apiReferenceData2: e } = (0, a.useContext)(n.ApiReferenceContext2),
          t = (0, i.jT)((e) => e.selectedSecurityOptionIndex),
          r = (0, i.jT)((e) => e.setSelectedSecurityOptionIndex),
          o = (0, a.useRef)(t),
          l = e.dependencies?.processedSecurityOptions;
        return (
          (0, a.useEffect)(() => {
            if (o.current !== t) {
              let e = l?.[o.current],
                r = l?.[t];
              if (e && r) {
                let t = { ...i.jT.getState().inputs };
                (e.schemes.forEach(({ scheme: e, name: r }) => {
                  let a = (0, s.PY)({ scheme: e, name: r });
                  "http" === e.type && "basic" === e.scheme
                    ? (delete t[a + ".username"], delete t[a + ".password"])
                    : delete t[a];
                }),
                  r.schemes.forEach(({ scheme: e, schema: r, name: a }) => {
                    let n = (0, s.PY)({ scheme: e, name: a }),
                      i = "http" === e.type && "basic" === e.scheme,
                      o = (0, s.b9)(r);
                    i
                      ? o &&
                        "object" == typeof o &&
                        ((t[n + ".username"] =
                          "username" in o && "string" == typeof o.username ? o.username : ""),
                        (t[n + ".password"] =
                          "password" in o && "string" == typeof o.password ? o.password : ""))
                      : o && "string" == typeof o && (t[n] = o);
                  }),
                  i.jT.getState().replaceInputs(t));
              }
              o.current = t;
            }
          }, [t, l]),
          { selectedSecurityOptionIndex: t, setSelectedSecurityOptionIndex: r }
        );
      };
    },
    50519: (e, t, r) => {
      "use strict";
      r.d(t, { o: () => b, w: () => v });
      var a = r(54568),
        n = r(84487),
        s = r(87799);
      r(83592);
      var i = r(69494),
        o = r(34972);
      let l = ({ className: e, children: t, codeBlockTheme: r, ...n }) => {
        let s = (0, i.Fr)(t, e),
          l = (0, o.S)({
            codeString: s,
            codeBlockTheme: r,
            className: e,
            opts: { structure: "inline" },
          });
        return l
          ? (0, a.jsx)("code", { ...n, dangerouslySetInnerHTML: { __html: l } })
          : (0, a.jsx)("code", { ...n, className: e, children: t });
      };
      var d = r(51874),
        c = r(79634),
        p = r(68429),
        u = r(15209),
        m = r(22153),
        h = r(65477),
        x = r(40711);
      let g = ({ markdownLinks: e, handleClose: t }) => {
        let { threadId: r } = (0, h.w)(),
          n = (0, m.p)("docs.assistant.suggestion_click"),
          s = e
            .split("\n")
            .map((e) => {
              let t = e.match(/\(([^)]*)\)\[([^\]]*)\]/);
              if (t && t[1] && t[2]) {
                return { text: t[1], url: t[2], threadId: r };
              }
            })
            .filter((e) => void 0 !== e);
        return (0, a.jsx)("div", {
          className: "flex flex-col gap-3 not-prose",
          children: s.map((e) =>
            (0, a.jsx)(
              x.k,
              {
                href: e.url,
                onInternalLinkClick: t,
                onClick: () => {
                  n({ text: e.text, url: e.url }).catch(console.error);
                },
                title: e.text,
              },
              e.url,
            ),
          ),
        });
      };
      var f = r(81325),
        y = r(65904);
      function b({
        children: e,
        className: t,
        components: r,
        showCopyButton: i = !1,
        onInternalLinkClick: o,
        ...m
      }) {
        let h = (0, u.e)(),
          x = (0, u.O)();
        return (0, a.jsx)(n.jH, {
          components: {
            a: (e) => (0, a.jsx)(c.DynamicLink, { ...e, onInternalLinkClick: o }),
            p: ({ children: e }) =>
              (0, a.jsx)("p", { className: "whitespace-pre-line", children: e }),
            pre: ({ children: e, ...t }) => {
              if (
                "object" == typeof e &&
                null !== e &&
                "props" in e &&
                "object" == typeof e.props &&
                null !== e.props &&
                "className" in e.props &&
                "language-suggestions" === e.props.className
              ) {
                return e;
              }
              let r = (0, d.O)(e);
              return (0, a.jsxs)("div", {
                className: "relative",
                children: [
                  (0, a.jsx)("pre", {
                    ...t,
                    className: (0, f.cn)(
                      y.SHIKI_CLASSNAME,
                      "p-3 text-sm rounded-xl",
                      "system" === h &&
                        "text-gray-950 bg-white codeblock-light dark:codeblock-dark dark:bg-codeblock dark:text-gray-50 border border-gray-200/70 dark:border-white/[0.14]",
                      "dark" === h &&
                        "text-gray-50 bg-[#0F1117] dark:codeblock-dark dark:bg-codeblock border border-transparent dark:border-white/[0.14] codeblock-dark",
                      t.className,
                    ),
                    children: e,
                  }),
                  i &&
                    (0, a.jsx)("div", {
                      className: "absolute top-2 right-2",
                      children: (0, a.jsx)(s.TN, { textToCopy: r, showTooltip: !1 }),
                    }),
                ],
              });
            },
            code: ({ children: e, ...t }) => {
              if ("className" in t) {
                let r = /language-(\w+)/.exec(t.className || "");
                if ("suggestions" === (r ? r[1] : void 0) && "string" == typeof e) {
                  return (0, a.jsx)(g, { markdownLinks: e, handleClose: o });
                }
              }
              return (0, a.jsx)(l, {
                suppressHydrationWarning: !0,
                codeBlockTheme: x,
                ...t,
                children: e,
              });
            },
            table: p.X,
            ...r,
          },
          className: t,
          rehypePlugins: [...(n.XX.raw ? [n.XX.raw] : []), ...(n.XX.katex ? [n.XX.katex] : [])],
          ...m,
          children: e,
        });
      }
      let v = ({ children: e, className: t, ...r }) => {
        let n = "text-base font-medium";
        return (0, a.jsx)(b, {
          components: {
            h1: ({ children: e }) => (0, a.jsx)("h1", { className: n, children: e }),
            h2: ({ children: e }) => (0, a.jsx)("h2", { className: n, children: e }),
            h3: ({ children: e }) => (0, a.jsx)("h3", { className: n, children: e }),
            h4: ({ children: e }) => (0, a.jsx)("h4", { className: n, children: e }),
            h5: ({ children: e }) => (0, a.jsx)("h5", { className: n, children: e }),
            h6: ({ children: e }) => (0, a.jsx)("h6", { className: n, children: e }),
          },
          className: t,
          ...r,
          children: e,
        });
      };
    },
    51637: (e, t, r) => {
      "use strict";
      r.d(t, { V: () => x });
      var a = r(54568),
        n = r(7620),
        s = r(84583),
        i = r(76829),
        o = r(22153);
      let l = "user_toggled_expandables",
        d = () => {
          try {
            let e = sessionStorage.getItem(l);
            return e ? JSON.parse(e) : {};
          } catch (e) {
            return {};
          }
        };
      var c = r(33052),
        p = r(68999),
        u = r(81325),
        m = r(7844);
      let h = "expandable-content";
      function x({
        title: e,
        defaultOpen: t = !1,
        onChange: r,
        lazy: x,
        children: g,
        uniqueParamId: f,
      }) {
        let { hasScrolledToAnchorRef: y, anchor: b } = (0, n.useContext)(s.m$),
          v = (0, i.n)(),
          j = !!f,
          {
            isExpanded: k,
            onManualToggle: w,
            isInSessionStorage: N,
          } = ((e, t = !1) => {
            let r = (0, n.useRef)(null),
              [a, s] = (0, n.useState)(!1),
              [i, o] = (0, n.useState)(!1),
              [c, p] = (0, n.useState)(t);
            return (
              (0, n.useEffect)(() => {
                if (!e) {
                  return;
                }
                let t = d();
                e in t && (p(!!t[e]), s(!0), o(!0));
              }, [e]),
              (0, n.useEffect)(() => {
                let e = new IntersectionObserver(
                    (e) => {
                      e[0] && e[0].isIntersecting && !a && t && p((e) => !e || e);
                    },
                    { rootMargin: "100px", threshold: 0 },
                  ),
                  n = r.current;
                return (
                  n && e.observe(n),
                  () => {
                    n && e.unobserve(n);
                  }
                );
              }, [a, t]),
              {
                ref: r,
                isExpanded: c,
                onManualToggle: (0, n.useCallback)(
                  (t) => {
                    (p(t),
                      s(!0),
                      o(!0),
                      e &&
                        ((e, t) => {
                          try {
                            let r = { ...d(), [e]: t };
                            sessionStorage.setItem(l, JSON.stringify(r));
                          } catch (e) {}
                        })(e, t));
                  },
                  [e],
                ),
                isInSessionStorage: i,
              }
            );
          })(f || "", t),
          [C, S] = (0, n.useState)(t),
          O = !!(f && b?.includes(f)) && !y?.current,
          $ = j ? !!O || (N ? k : t) : C,
          [T, E] = (0, n.useState)($ || !x);
        (0, n.useLayoutEffect)(() => {
          $ && !T && E(!0);
        }, [$, T]);
        let A = (0, o.p)("docs.expandable.open"),
          P = (0, o.p)("docs.expandable.close"),
          I = (0, n.useRef)(null);
        return (
          (0, n.useEffect)(() => {
            let e = () => {
              (0, m.h)({
                shouldReturnEarly: !!y?.current,
                checkIfShouldScroll: (e) => !!I.current && I.current.contains(e),
                preScrollCallback(e) {
                  j ? w(!0) : S(!0);
                  let t = e.closest(`.${h}`);
                  for (; t; ) {
                    let e = t.previousElementSibling;
                    ("false" === e.getAttribute("aria-expanded") && e.click(),
                      (t = t.parentElement?.closest(`.${h}`) ?? null));
                  }
                },
                postScrollCallback() {
                  y && (y.current = !0);
                },
              });
            };
            return (
              e(),
              window.addEventListener("hashchange", e),
              () => {
                window.removeEventListener("hashchange", e);
              }
            );
          }, [j, w, y]),
          (0, a.jsxs)(
            "details",
            {
              ref: I,
              open: $,
              onToggle: (t) => {
                let a = t.currentTarget.open;
                a !== $ &&
                  (j ? w(a) : S(a), E(!0), r && r(a), a ? A({ title: e }) : P({ title: e }));
              },
              className: (0, u.cn)(c.x.Expandable, "mt-4 border-standard rounded-xl"),
              "data-testid": f + "-children",
              children: [
                (0, a.jsxs)("summary", {
                  className: (0, u.cn)(
                    "not-prose text-sm flex flex-row items-center content-center w-full cursor-pointer",
                    "text-gray-600 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-200 py-3 px-3.5 hover:bg-gray-50/50 dark:hover:bg-white/5 rounded-t-xl",
                    "list-none [&::-webkit-details-marker]:hidden",
                    !$ && "rounded-b-xl",
                  ),
                  "aria-controls": "Children attributes",
                  "aria-expanded": $,
                  "data-component-part": "expandable-button",
                  children: [
                    (0, a.jsx)(p.A, {
                      icon: "angle-right",
                      className: (0, u.cn)(
                        "h-2.5 w-2.5 bg-zinc-400 transition-transform",
                        $ && "rotate-90",
                      ),
                      "data-component-part": "expandable-icon",
                    }),
                    (0, a.jsx)("div", {
                      className: "ml-3 leading-tight text-left",
                      children: (0, a.jsxs)("p", {
                        className: "m-0",
                        contentEditable: !1,
                        children: [$ ? v.hide : v.show, " ", e || v.childAttributes],
                      }),
                    }),
                  ],
                }),
                (0, a.jsx)("div", {
                  id: e + "Children",
                  className: (0, u.cn)(
                    h,
                    "mx-3 px-2 border-t border-gray-100 dark:border-white/10",
                  ),
                  "data-component-part": h,
                  children: T && g,
                }),
              ],
            },
            e,
          )
        );
      }
    },
    51874: (e, t, r) => {
      "use strict";
      r.d(t, { O: () => a });
      let a = (e) =>
        "string" == typeof e || "number" == typeof e
          ? e.toString()
          : e instanceof Array
            ? e.map(a).join("")
            : e &&
                "object" == typeof e &&
                "props" in e &&
                e.props &&
                "object" == typeof e.props &&
                "children" in e.props
              ? a(e.props.children)
              : "";
    },
    52094: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => c });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        i = r(33052),
        o = r(6723),
        l = r(36140),
        d = r(81325);
      function c({ mobile: e }) {
        let {
            pageMetadata: t,
            panelMdxSource: r,
            panelMdxSourceWithNoJs: c,
          } = (0, n.useContext)(s.PageContext),
          { userInfo: p } = (0, n.useContext)(s.AuthContext);
        return r && c
          ? (0, a.jsx)("div", {
              className: (0, d.cn)(
                i.x.Panel,
                "w-full xl:w-[28rem] max-w-full mb-6 relative max-h-[calc(100%-32px)]",
                e ? "mt-8 lg:mt-0 flex flex-col gap-6 xl:hidden" : "overflow-y-auto",
              ),
              children: (0, a.jsx)(o.A, {
                children: (0, a.jsx)(l.b, {
                  mdxSource: r,
                  mdxSourceWithNoJs: c,
                  pageMetadata: t,
                  userInfo: p,
                }),
              }),
            })
          : null;
      }
    },
    52648: (e, t, r) => {
      "use strict";
      r.d(t, { Y: () => s });
      var a = r(59676),
        n = r(72849);
      function s(e, t = (0, a.a)()) {
        let r = (0, n.hT)(e);
        return /%[0-9A-F]{2}/.test(r)
          ? t(r, { decamelize: !1, preserveCharacters: ["%", "_"], lowercase: !1 })
          : t(r, { decamelize: !1, preserveCharacters: ["_"] });
      }
    },
    54578: (e, t, r) => {
      "use strict";
      r.d(t, { ki: () => n, r2: () => a });
      let a = "data-child-tab-ids",
        n = "data-child-heading-ids";
    },
    54808: (e, t, r) => {
      "use strict";
      r.d(t, { MB: () => u, gl: () => p });
      var a = r(54568),
        n = r(27541),
        s = r(7620),
        i = r(72179),
        o = r(30793),
        l = r(71252);
      let d = {
          headings: [],
          apiBaseIndex: 0,
          codeExamples: {},
          pageMetadata: {},
          selectedBodyContentType: void 0,
          selectedResponseContentType: void 0,
          tableOfContents: [],
          changelogFilters: [],
          multiViewItems: [],
        },
        c = (e, t) => {
          switch (t.type) {
            case "set_state":
              return { ...e, ...t.payload };
            case "register_heading":
              let { id: r, top: a } = t.payload;
              return {
                ...e,
                headings: [...e.headings.filter((e) => r !== e.id), { id: r, top: a }],
              };
            case "unregister_heading":
              return { ...e, headings: e.headings.filter((e) => t.payload !== e.id) };
            case "set_selected_body_content_type":
              return { ...e, selectedBodyContentType: t.payload };
            case "set_selected_response_content_type":
              return { ...e, selectedResponseContentType: t.payload };
            case "set_api_base_index":
              return { ...e, apiBaseIndex: t.payload };
            case "toggle_changelog_filter":
              let n = e.changelogFilters.findIndex((e) => e.tag === t.payload.tag);
              if (-1 !== n) {
                let r = [...e.changelogFilters];
                return ((r[n] = t.payload), { ...e, changelogFilters: r });
              }
              return { ...e, changelogFilters: [...e.changelogFilters, t.payload] };
            case "toggle_multi_view_change": {
              let r = e.multiViewItems.map((e) => ({ ...e, active: e.title === t.payload.title }));
              return { ...e, multiViewItems: r };
            }
          }
        },
        p = (0, s.createContext)([d, () => null]);
      function u({ children: e }) {
        let t = (function () {
          var e;
          let { pageMetadata: t, mdxExtracts: r } = (0, s.useContext)(o.PageContext),
            { isLivePreview: a, liveMetadata: p, livePreviewUpdateId: u } = (0, s.useContext)(l.K),
            m = (0, n.usePathname)(),
            h = Object.keys(r?.endpoint?.request.body ?? {})[0],
            x =
              ((e = {
                pageMetadata: (0, s.useMemo)(() => {
                  if (!a || !m) {
                    return t;
                  }
                  let e = "/" + (0, i.Tn)(m).replace(/^\//, ""),
                    r = p.get(e);
                  return r ? { ...t, ...r } : t;
                }, [a, m, t, p, u]),
                selectedBodyContentType: h,
                ...r,
              }),
              (0, s.useReducer)(c, e ?? {}, (e) => {
                let t = { ...d, ...e };
                if (t.multiViewItems.length > 0) {
                  try {
                    let e = window.localStorage.getItem("code");
                    if (e) {
                      let r = t.multiViewItems.findIndex((t) => t.title === e);
                      -1 !== r &&
                        (t.multiViewItems = t.multiViewItems.map((e, t) => ({
                          ...e,
                          active: t === r,
                        })));
                    }
                  } catch {
                    console.error("Error syncing multi view items with code language preference");
                  }
                }
                return t;
              }));
          return (0, s.useMemo)(() => x, [x]);
        })();
        return (0, a.jsx)(p.Provider, { value: t, children: e });
      }
      p.displayName = "MDXContentContext";
    },
    57303: (e, t, r) => {
      "use strict";
      r.d(t, { z: () => a });
      let a = (0, r(7620).createContext)({
        isSending: !1,
        selectedBaseUrlIndex: 0,
        isPlaygroundExpanded: !1,
        selectedExampleIndex: 0,
      });
    },
    57810: (e, t, r) => {
      "use strict";
      async function a(e) {
        e || console.warn("Called copyToClipboard() with empty text");
        try {
          return (await navigator.clipboard.writeText(e), "success");
        } catch (e) {
          return (console.error("Failed to copy: ", e), "error");
        }
      }
      r.d(t, { l: () => a });
    },
    59705: (e, t, r) => {
      "use strict";
      r.d(t, { Bh: () => p, jT: () => c, tt: () => u });
      var a = r(7620),
        n = r(4211),
        s = r(42469),
        i = r(47922),
        o = r(99424),
        l = r(43967),
        d = r(16903);
      let c = (0, n.v)((e, t) => ({
          inputs: {},
          apiReferenceData: void 0,
          initializeInputs: (t) => e({ inputs: { ...t } }),
          initializeApiReferenceData: (t) => e({ apiReferenceData: t }),
          setInput: (t, r) =>
            e((e) => {
              let a = { ...e.inputs, [t]: r },
                n = t.match(/^(.+)\.oneOf\.(\d+)$/);
              if (n) {
                let [, e] = n;
                Object.keys(a).forEach((r) => {
                  r !== t && r.startsWith(`${e}.oneOf.`) && delete a[r];
                });
              }
              return { inputs: a };
            }),
          setInputs: (t) => e((e) => ({ inputs: { ...e.inputs, ...t } })),
          replaceInputs: (t) => e({ inputs: t }),
          deleteInput: (t) =>
            e((e) => {
              let r = { ...e.inputs };
              delete r[t];
              let a = t + ".";
              return (
                Object.keys(r).forEach((e) => {
                  e.startsWith(a) && delete r[e];
                }),
                { inputs: r }
              );
            }),
          getInput: (e) => t().inputs[e],
          getApiPlaygroundInputs: () => (0, d.Df)(t().inputs),
          clear: () => e({ inputs: {} }),
          reset: () =>
            e({
              inputs: {},
              selectedSecurityOptionIndex: 0,
              selectedExampleIndex: 0,
              selectedRequestBodyContentTypeIndex: 0,
              selectedResponseContentTypeIndex: 0,
            }),
          updateLocalStorage: () =>
            void (async () => {
              await m({
                apiReferenceData: t().apiReferenceData,
                selectedBaseUrlIndex: t().selectedBaseUrlIndex,
                inputs: t().inputs,
                selectedSecurityOptionIndex: t().selectedSecurityOptionIndex,
              });
            })(),
          selectedBaseUrlIndex: 0,
          setSelectedBaseUrlIndex: (t) => e({ selectedBaseUrlIndex: t }),
          selectedSecurityOptionIndex: 0,
          setSelectedSecurityOptionIndex: (t) => e({ selectedSecurityOptionIndex: t }),
          selectedExampleIndex: 0,
          setSelectedExampleIndex: (t) => e({ selectedExampleIndex: t }),
          selectedRequestBodyContentTypeIndex: 0,
          setSelectedRequestBodyContentTypeIndex: (t) =>
            e({ selectedRequestBodyContentTypeIndex: t }),
          selectedResponseContentTypeIndex: 0,
          setSelectedResponseContentTypeIndex: (t) => e({ selectedResponseContentTypeIndex: t }),
        })),
        p = (e) => ({ value: c((t) => t.inputs[e]), setInput: c((e) => e.setInput) }),
        u = (e = 300) => {
          let t = c((0, s.k)((e) => e.inputs)),
            [r, n] = (0, a.useState)(t);
          return (
            (0, a.useEffect)(() => {
              let r = setTimeout(() => {
                n(t);
              }, e);
              return () => {
                clearTimeout(r);
              };
            }, [t, e]),
            (0, a.useMemo)(() => (0, d.Df)(r), [r])
          );
        },
        m = async ({
          apiReferenceData: e,
          selectedBaseUrlIndex: t,
          inputs: r,
          selectedSecurityOptionIndex: a,
        }) => {
          let n = e?.operation?.userInfoPlaygroundInputs,
            s = (0, d.Df)(r),
            c = (0, o.tn)(),
            p = { ...n?.server, ...s.server },
            u = e?.operation?.baseUrl ?? e?.operation?.baseUrlOptions[t] ?? "",
            m = JSON.stringify({ ...c, [u]: p });
          localStorage.setItem(o.to, m);
          let h = await (0, i.pC)(),
            x = e?.dependencies?.processedSecurityOptions?.[a],
            g = { query: { ...h.query }, header: { ...h.header }, cookie: { ...h.cookie } };
          if (x) {
            let e = "schemes" in x ? x.schemes : [x];
            if (e.length > 0) {
              for (let t of e) {
                let e = t.name,
                  r = "in" in t.scheme ? t.scheme.in : "header",
                  a = s[r][e];
                void 0 !== a && (g[r][e] = a);
              }
            }
          }
          await (0, l.gQ)(i._T, g);
        };
    },
    60130: (e, t, r) => {
      "use strict";
      r.d(t, { x4: () => n });
      var a = r(7620);
      let n = { server: {}, path: {}, query: {}, header: {}, cookie: {}, body: void 0 };
      (0, a.createContext)([n, () => null]).displayName = "ApiPlaygroundInputsContext";
    },
    61755: (e, t, r) => {
      "use strict";
      r.d(t, { n: () => n });
      var a = r(59705);
      let n = () => ({
        selectedResponseContentTypeIndex: (0, a.jT)((e) => e.selectedResponseContentTypeIndex),
        setSelectedResponseContentTypeIndex: (0, a.jT)(
          (e) => e.setSelectedResponseContentTypeIndex,
        ),
      });
    },
    62060: (e, t, r) => {
      "use strict";
      r.d(t, { j: () => j, R: () => k });
      var a = r(54568),
        n = r(7620),
        s = r(97509),
        i = r(41574),
        o = r(64286),
        l = r(31722),
        d = r(30793),
        c = r(76829),
        p = r(98167),
        u = r(27194),
        m = r(35878),
        h = r(33052),
        x = r(81325);
      let g = new o.d(),
        f = ({ code: e, ...t }) => {
          let r = (0, u.G)(),
            { subdomain: s } = (0, n.useContext)(d.DeploymentMetadataContext),
            {
              feedback: i,
              setFeedback: o,
              setFeedbackModalOpen: f,
              feedbackModalOpen: y,
              isCodeSnippetFeedbackEnabled: b,
            } = (0, n.useContext)(j),
            v = (0, n.useRef)(null),
            {
              reportIncorrectCode: k,
              pleaseProvideDetailsOfTheIncorrectCode: w,
              whatIsWrongWithThisCode: N,
              submit: C,
              cancel: S,
            } = (0, c.n)(),
            O = (0, n.useMemo)(() => !!(i.trim() && g.isProfane(i)), [i]),
            $ = (0, n.useMemo)(() => !b || !i || O, [b, i, O]);
          return (
            (0, n.useEffect)(() => {
              if (y) {
                let e = v.current;
                e && (e.focus(), e.setSelectionRange(e.value.length, e.value.length));
              } else {
                v.current?.blur();
              }
            }, [y]),
            (0, a.jsxs)("div", {
              className: (0, x.cn)("flex flex-col gap-y-3", h.x.CodeSnippetFeedbackForm),
              children: [
                (0, a.jsxs)("div", {
                  className: "flex flex-col gap-y-1",
                  children: [
                    (0, a.jsx)("span", {
                      className: (0, x.cn)(
                        h.x.CodeSnippetFeedbackFormTitle,
                        "text-sm font-medium text-gray-900 dark:text-gray-100",
                      ),
                      children: k,
                    }),
                    (0, a.jsx)("p", {
                      className: (0, x.cn)(
                        h.x.CodeSnippetFeedbackFormDescription,
                        "text-sm text-gray-600 dark:text-gray-400",
                      ),
                      children: w,
                    }),
                  ],
                }),
                (0, a.jsx)(l.A, {
                  id: m.V.CodeSnippetFeedbackTextArea,
                  ref: v,
                  autoComplete: "off",
                  placeholder: N,
                  value: i,
                  onChange: (e) => {
                    o(e.target.value);
                  },
                  cacheMeasurements: !1,
                  minRows: 3,
                  className: (0, x.cn)(
                    h.x.CodeSnippetFeedbackTextArea,
                    "my-2 text-sm w-full py-2 px-3 bg-background-light dark:bg-background-dark border border-gray-200 dark:border-gray-800 rounded-xt focus:outline-0 focus:border-gray-300 dark:focus:border-gray-700 text-gray-900 dark:text-gray-100 placeholder:text-gray-600/70 dark:placeholder:text-gray-400/70",
                  ),
                  maxRows: 8,
                  style: { resize: "none" },
                }),
                (0, a.jsxs)("div", {
                  className: "flex justify-end gap-2",
                  children: [
                    (0, a.jsx)("button", {
                      type: "button",
                      className:
                        "text-sm rounded-xl px-3 py-1.5 bg-background-light dark:bg-background-dark border border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700 text-gray-900 dark:text-gray-100",
                      onClick: () => {
                        (o(""), f(!1));
                      },
                      children: S,
                    }),
                    (0, a.jsx)("button", {
                      type: "button",
                      onClick: () => {
                        let a = i.trim();
                        if ($ || !s || !a || O) {
                          return;
                        }
                        let n = {
                          code: e,
                          filename: t.filename,
                          lang: t.language,
                          path: r,
                          feedback: a,
                        };
                        (fetch(`${p.c.BASE_PATH}/_mintlify/feedback/${s}/code-snippet-feedback`, {
                          method: "POST",
                          body: JSON.stringify(n),
                        }).catch(() => {}),
                          o(""),
                          f(!1));
                      },
                      disabled: $,
                      className: (0, x.cn)(
                        h.x.CodeSnippetFeedbackFormSubmitButton,
                        "text-white rounded-xl px-3 py-1.5 bg-primary dark:bg-primary-dark disabled:opacity-50 disabled:cursor-not-allowed",
                      ),
                      children: (0, a.jsx)("span", {
                        className: "text-sm text-white dark:text-white text-center font-medium",
                        children: C,
                      }),
                    }),
                  ],
                }),
              ],
            })
          );
        };
      var y = r(35590),
        b = r(67908),
        v = r(44564);
      let j = (0, n.createContext)({
          feedbackModalOpen: !1,
          setFeedbackModalOpen: () => {},
          isCodeSnippetFeedbackEnabled: !1,
          feedback: "",
          setFeedback: () => {},
        }),
        k = ({ children: e, code: t, ...r }) => {
          let [o, l] = (0, n.useState)(!1),
            [c, p] = (0, n.useState)(""),
            u = (0, i.Ub)("(max-width: 1024px)"),
            m = (0, n.useRef)(null),
            { entitlements: g } = (0, n.useContext)(d.DeploymentMetadataContext),
            k = (0, v.J)(g, "CODE_SNIPPET_FEEDBACK") && !r.hideCodeSnippetFeedbackButton && !!t,
            w = () => ("function" == typeof e ? e({ feedbackModalOpen: o, anchorRef: m }) : e);
          return k
            ? (0, a.jsxs)(j.Provider, {
                value: {
                  feedbackModalOpen: o,
                  setFeedbackModalOpen: l,
                  feedback: c,
                  setFeedback: p,
                  isCodeSnippetFeedbackEnabled: k,
                },
                children: [
                  w(),
                  "undefined" != typeof document &&
                    (0, s.createPortal)(
                      (0, a.jsxs)(y.AM, {
                        open: o,
                        onOpenChange: l,
                        children: [
                          (0, a.jsx)(y.dT, { virtualRef: m }),
                          (0, a.jsx)(y.hl, {
                            side: u ? "bottom" : "right",
                            align: u ? "center" : "start",
                            className: (0, x.cn)(
                              b.f.SecondaryNav,
                              h.x.CodeSnippetFeedbackPopoverContent,
                              "w-80 p-4 bg-white dark:bg-codeblock rounded-2xl border border-gray-950/10 dark:border-white/10",
                            ),
                            children: (0, a.jsx)(f, { code: t, ...r }),
                          }),
                        ],
                      }),
                      document.body,
                    ),
                ],
              })
            : w();
        };
    },
    62987: (e, t, r) => {
      "use strict";
      r.d(t, { Bc: () => l, PR: () => p, ZI: () => m, k$: () => c, m_: () => d });
      var a = r(54568),
        n = r(31002),
        s = r(97282),
        i = r(7620),
        o = r(81325);
      let l = n.Kq,
        d = n.bL,
        c = i.forwardRef(({ ...e }, t) => (0, a.jsx)(n.l9, { ref: t, ...e }));
      c.displayName = n.l9.displayName;
      let p = i.forwardRef(({ className: e, arrowBgClassName: t, ...r }, s) =>
        (0, a.jsx)(n.i3, {
          ref: s,
          asChild: !0,
          className: e,
          ...r,
          children: (0, a.jsxs)("div", {
            className: "absolute -translate-y-[2px] -translate-x-1/2",
            children: [
              (0, a.jsx)("div", {
                className: (0, o.cn)(
                  "top-0 left-0 right-0 w-full h-px bg-white dark:bg-background-dark absolute z-10",
                  t,
                ),
              }),
              (0, a.jsx)("svg", {
                width: "16",
                height: "6",
                viewBox: "0 0 16 6",
                fill: "none",
                xmlns: "http://www.w3.org/2000/svg",
                className:
                  "stroke-[1px] text-white dark:text-background-dark filter stroke-gray-400/20 dark:stroke-gray-600/30",
                children: (0, a.jsx)("path", {
                  d: "M15.0078 -0.5C15.4952 -0.0122439 15.0229 0.490129 15.0049 0.5C14.9992 0.500053 14.9231 0.499973 14.7764 0.5C13.1909 0.500305 11.5933 1.41218 10.3467 2.39355C9.73304 2.87665 9.22446 3.36099 8.86914 3.72461C8.69187 3.90602 8.55326 4.05671 8.45996 4.16113C8.41333 4.21333 8.37773 4.25423 8.35449 4.28125C8.34291 4.29472 8.33456 4.30506 8.3291 4.31152C8.3264 4.31472 8.3244 4.31697 8.32324 4.31836L8.32227 4.31934L7.94922 4.76855L7.5625 4.33105L7.56152 4.3291C7.56022 4.32764 7.55765 4.32557 7.55469 4.32227C7.54879 4.31568 7.53965 4.3055 7.52734 4.29199C7.50247 4.26468 7.46452 4.2234 7.41504 4.1709C7.31605 4.06586 7.1694 3.91458 6.9834 3.73242C6.61066 3.3674 6.08072 2.88124 5.45215 2.39648C4.17101 1.40851 2.57521 0.500515 1.09766 0.5H0.995117C0.978923 0.487615 0.506451 -0.00437714 0.984375 -0.499023C0.989411 -0.499154 0.995327 -0.499982 0.99707 -0.5H15.0078Z",
                  fill: "currentColor",
                }),
              }),
            ],
          }),
        }),
      );
      p.displayName = n.i3.displayName;
      let u = (0, s.F)(
          "z-50 overflow-hidden bg-white dark:bg-background-dark border border-gray-400/20 dark:border-gray-600/30 animate-fade-in",
          {
            variants: {
              size: {
                sm: "px-2 py-1 rounded",
                md: "px-3 py-2 rounded-[10px]",
                lg: "px-4 py-3 rounded-xl",
              },
            },
          },
        ),
        m = i.forwardRef(
          ({ className: e, headline: t, size: r, children: s, showArrow: i = !0, ...l }, d) => {
            r = t && !r ? "lg" : (r ?? "sm");
            let c = l.sideOffset ?? 4;
            return (0, a.jsx)(n.ZL, {
              children: (0, a.jsxs)(n.UC, {
                ref: d,
                onPointerDownOutside: (e) => e.preventDefault(),
                sideOffset: c,
                className: (0, o.cn)(u({ size: r }), t && "flex flex-col gap-1", e),
                ...l,
                children: [i && (0, a.jsx)(p, {}), t && (0, a.jsx)("div", { children: t }), s],
              }),
            });
          },
        );
      m.displayName = n.UC.displayName;
    },
    65477: (e, t, r) => {
      "use strict";
      r.d(t, { w: () => g });
      var a = r(58661),
        n = r(7620),
        s = r(83308),
        i = r(30793),
        o = r(76829);
      (r(90280), r(98167));
      let l = ({ userGroups: e, version: t, language: r }) => {
        let a = {};
        return (
          r && (a.language = r),
          e && (a.groups = e),
          t && (a.version = t),
          Object.keys(a).length > 0 ? { filter: a } : {}
        );
      };
      var d = r(22153),
        c = r(90723),
        p = r(67377);
      let u = [402, 403, 404, 413, 418, 429],
        m = {
          402: {
            type: "payment",
            message:
              "Usage of this feature is temporarily limited. Please try again later or contact the site owner to restore access.",
          },
          403: {
            type: "rate_limited",
            message: "You're sending too many messages. Please wait a moment and try again.",
          },
          404: { type: "not_found", message: "There was an error sending your message." },
          413: {
            type: "thread_limit",
            message:
              "You have reached the maximum number of messages in a thread. Please start a new thread to continue.",
          },
          418: {
            type: "blocked",
            message:
              "The assistant is unavailable from your network. If you are using a VPN, please turn it off and try again.",
          },
          429: {
            type: "rate_limited",
            message: "You're sending too many messages. Please wait a moment and try again.",
          },
        },
        h = {
          type: "unknown",
          message:
            "This feature is temporarily unavailable. Please try again later or contact the site owner to restore access.",
        },
        x = (e) => (e ? (m[e] ?? h) : h),
        g = () => {
          let { subdomain: e } = (0, n.useContext)(i.DeploymentMetadataContext),
            { userInfo: t } = (0, n.useContext)(i.AuthContext),
            {
              selectedVersion: r,
              selectedLocale: m,
              locales: h,
            } = (0, n.useContext)(o.NavigationContext),
            g = m ?? h?.[0],
            f = (0, p.f)(),
            y = (0, d.p)("docs.assistant.completed"),
            [b, v] = (0, n.useState)(""),
            j = (0, c.A)((e) => e.featureUnavailable),
            k = (0, c.A)((e) => e.setFeatureUnavailable),
            w = (0, n.useRef)(null),
            N = (0, n.useRef)(!1),
            {
              threadId: C,
              setThreadId: S,
              threadKey: O,
              setThreadKey: $,
              setMessageUlid: T,
              payloadInput: E,
              setPayloadInput: A,
            } = (0, c.A)();
          (0, n.useEffect)(() => {
            let e = sessionStorage.getItem("threadKey");
            e && !O && $(e);
          }, [O, $]);
          let {
            input: P,
            status: I,
            handleSubmit: _,
            setInput: q,
            messages: F,
            setMessages: R,
            append: L,
            data: D,
            setData: M,
            reload: B,
            stop: H,
            error: U,
          } = (0, a.Y_)({
            api: (0, s.F)({ subdomain: e ?? "", isAuthenticated: !!t }),
            id: e,
            body: {
              fp: e,
              threadId: C,
              threadKey: O,
              ...l({ userGroups: f, version: r, language: g }),
              context: E.context,
            },
            fetch: async (e, t) => {
              if (t?.body && "string" == typeof t.body) {
                let e = JSON.parse(t.body),
                  r = sessionStorage.getItem("threadKey");
                (r && (e.threadKey = r), (t = { ...t, body: JSON.stringify(e) }));
              }
              let r = await fetch(e, t),
                a = r.headers.get("x-thread-id"),
                n = r.headers.get("x-thread-key");
              (a && !N.current && S(a),
                n && !N.current && ($(n), sessionStorage.setItem("threadKey", n)));
              let s = r.headers.get("x-message-id");
              if ((s && (w.current = s), u.includes(r.status))) {
                let e = x(r.status);
                k({ unavailable: !0, type: e.type, message: e.message });
              } else {
                r.ok && j.unavailable && k({ unavailable: !1, type: null, message: "" });
              }
              return r;
            },
            sendExtraMessageFields: !0,
            initialMessages: [],
            streamProtocol: "data",
            onError: (e) => {
              let t =
                u.find((t) => e.message.includes(String(t))) ??
                (e.message.includes("Payment Required") ? 402 : void 0);
              if (t) {
                let e = x(t);
                k({ unavailable: !0, type: e.type, message: e.message });
              }
            },
            onFinish: (t) => {
              N.current ||
                (w.current && (T(t.id, w.current), (w.current = null)),
                y({
                  query: b,
                  content: t.content,
                  citations: ((e) => {
                    let t = [];
                    return (
                      e?.forEach((e) => {
                        "tool-invocation" === e.type &&
                          "result" === e.toolInvocation.state &&
                          "search" === e.toolInvocation.toolName &&
                          e.toolInvocation.result.results?.forEach((e) => {
                            t.push({ title: e.metadata.title, url: e.path });
                          });
                      }),
                      t
                    );
                  })(t.parts),
                  sessionId: t.id,
                  subdomain: e,
                }));
            },
          });
          ((0, n.useEffect)(() => {
            "" !== P && v(P);
          }, [P]),
            (0, n.useEffect)(() => {
              c.A.setState({ messages: F });
              let {
                pendingContext: e,
                setPendingContext: t,
                setMessageContext: r,
              } = c.A.getState();
              if (e && e.length > 0) {
                let a = F.filter((e) => "user" === e.role).pop();
                a && (r(a.id, e), t(void 0));
              }
            }, [F]),
            (0, n.useEffect)(() => {
              c.A.setState({ status: I });
            }, [I]));
          let z = "submitted" === I || ("streaming" === I && D && 0 === D.length),
            V = "submitted" === I || "streaming" === I,
            K = (0, n.useCallback)(() => {
              ((N.current = !0),
                c.A.getState().activeStop?.(),
                H(),
                R([]),
                M([]),
                S(void 0),
                $(void 0),
                sessionStorage.removeItem("threadKey"),
                c.A.setState({ messages: [], activeStop: void 0 }),
                k({ unavailable: !1, type: null, message: "" }));
            }, [H, R, M, S, $, k]);
          return {
            input: P,
            status: I,
            handleSubmit: (t) => {
              ((N.current = !1),
                c.A.setState({ activeStop: H }),
                _(t, {
                  body: {
                    fp: e,
                    threadId: C,
                    threadKey: O,
                    ...l({ userGroups: f, version: r, language: g }),
                    context: E.context,
                  },
                }));
            },
            setInput: q,
            messages: F,
            setMessages: R,
            append: (0, n.useCallback)(
              (...e) => ((N.current = !1), c.A.setState({ activeStop: H }), L(...e)),
              [L, H],
            ),
            isLoading: z,
            onClear: K,
            onReload: () => {
              (c.A.setState({ activeStop: H }), B());
            },
            stop: H,
            threadId: C,
            isInProgress: V,
            error: U,
            isFeatureUnavailable: j,
            payloadInput: E,
            setPayloadInput: A,
          };
        };
    },
    65542: (e, t, r) => {
      "use strict";
      r.d(t, { i: () => o });
      var a = r(54578),
        n = r(7620),
        s = r(23752),
        i = r(97870);
      function o({
        tabIds: e,
        tabLabels: t,
        persistKey: r,
        defaultIndex: o = 0,
        onIndexChange: l,
        findInPanels: d,
        sync: c = !0,
      }) {
        let { matchingIndex: p, setSelectedLabel: u } = (0, i.Y)(t, c),
          { preferredCodeLanguage: m, setPreferredCodeLanguage: h } = (0, n.useContext)(s.O),
          [x, g] = (0, n.useState)(() => {
            let a = window.location.hash.substring(1);
            if (a) {
              let t = e.indexOf(a);
              if (-1 !== t) {
                return t;
              }
            }
            if (c && r) {
              let e = window.localStorage.getItem("code");
              if (e) {
                let r = t.indexOf(e);
                if (-1 !== r) {
                  return r;
                }
              }
            }
            return o;
          }),
          f = (0, n.useRef)(x);
        f.current = x;
        let y = (0, n.useRef)(null),
          b = (0, n.useCallback)(
            ({ index: a, updateHash: n = !0, updateSync: s = !0, updatePersist: i = !0 }) => {
              if (a < 0 || a >= e.length) {
                return;
              }
              (g(a), l?.(a));
              let o = e[a],
                d = t[a];
              if (o && d) {
                if (n && 1) {
                  let e = new URL(window.location.href);
                  ((e.hash = o), window.history.pushState({}, "", e.toString()));
                }
                (s && c && u(d), i && c && r && h && h(d));
              }
            },
            [e, t, u, r, h, l, c],
          ),
          v = (0, n.useCallback)((e) => {
            let t = CSS.escape(e),
              r = document.querySelector(`#${t}`);
            if (!r) {
              return !1;
            }
            let a = r.closest('[role="tabpanel"]');
            if (!a) {
              return !1;
            }
            let n = document.querySelector(`[aria-controls="${a.id}"]`);
            return n instanceof HTMLElement && (n.click(), !0);
          }, []),
          j = (0, n.useCallback)(
            (e) => {
              if (v(e)) {
                return !0;
              }
              let t = (t) => {
                for (let r of Array.from(document.querySelectorAll(`[${t}]`))) {
                  let a = r.getAttribute(t);
                  if (a) {
                    try {
                      let t = JSON.parse(a);
                      if (Array.isArray(t) && t.includes(e) && r instanceof HTMLElement)
                        return (r.click(), !0);
                    } catch {
                      continue;
                    }
                  }
                }
                return !1;
              };
              return t(a.r2) || t(a.ki);
            },
            [v],
          );
        return (
          (0, n.useEffect)(() => {
            y.current = null;
            let t = null,
              r = (a = !1) => {
                let n = window.location.hash.substring(1);
                if (!n || y.current === n) {
                  return;
                }
                let s = f.current,
                  i = e.indexOf(n);
                if (-1 !== i) {
                  (i !== s && b({ index: i, updateHash: !1 }), (y.current = n));
                  return;
                }
                if (d) {
                  let e = d(n);
                  if (null !== e && e !== s) {
                    ((y.current = n),
                      b({ index: e, updateHash: !1, updateSync: !1, updatePersist: !1 }));
                    return;
                  }
                }
                j(n) ? (y.current = n) : a || (t = setTimeout(() => r(!0), 100));
              },
              a = () => r();
            return (
              r(),
              window.addEventListener("hashchange", a),
              () => {
                (window.removeEventListener("hashchange", a), null !== t && clearTimeout(t));
              }
            );
          }, [e, b, d, j]),
          (0, n.useEffect)(() => {
            let e = f.current;
            -1 !== p &&
              p !== e &&
              p < t.length &&
              b({ index: p, updateSync: !1, updateHash: !1, updatePersist: !1 });
          }, [p, b, t.length]),
          (0, n.useEffect)(() => {
            if (!c || !r || !m) {
              return;
            }
            let e = f.current,
              a = t.indexOf(m);
            -1 !== a &&
              a !== e &&
              b({ index: a, updatePersist: !1, updateSync: !1, updateHash: !1 });
          }, [c, r, m, t, b]),
          { activeIndex: x, setActiveIndex: b }
        );
      }
    },
    66058: (e, t, r) => {
      "use strict";
      r.d(t, { r: () => n });
      var a = r(98167);
      let n = () => "cli" === a.c.ENV;
    },
    66438: (e, t, r) => {
      "use strict";
      r.d(t, { U: () => c });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        i = r(35878),
        o = r(33052),
        l = r(81325),
        d = r(840);
      let c = ({ pageMetadata: e, children: t }) => {
        let { apiReferenceData2: r } = (0, n.useContext)(s.ApiReferenceContext2),
          { isCustom: c, isFrame: p } = (0, d.H)(e),
          u = e.openapi || e["openapi-schema"] || e.api,
          m = r.operation || r.schemaData;
        return u && m
          ? null
          : (0, a.jsx)("div", {
              className: (0, l.cn)(
                o.x.Content,
                "relative",
                !c &&
                  !p &&
                  "mt-8 mb-14 prose prose-gray dark:prose-invert [contain:inline-size] isolate",
              ),
              "data-page-title": e.title,
              "data-page-href": e.href,
              id: i.V.Content,
              children: t,
            });
      };
    },
    67018: (e, t, r) => {
      "use strict";
      r.d(t, { y: () => x });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        i = r(76829),
        o = r(22153),
        l = r(65477),
        d = r(15209),
        c = r(27194),
        p = r(35878),
        u = r(12158),
        m = r(81325),
        h = r(87799);
      function x({ code: e, className: t, ...r }) {
        let { hasChatPermissions: x, assistantConfig: g } = (0, n.useContext)(u.SearchContext),
          { isChatSheetOpen: f, onChatSheetToggle: y } = (0, n.useContext)(u.ChatAssistantContext),
          { subdomain: b } = (0, n.useContext)(s.DeploymentMetadataContext),
          v = (0, i.n)(),
          j = (0, d.e)(),
          k = (0, o.p)("docs.code_block.ask_ai"),
          w = (0, c.G)(),
          N = (0, n.useMemo)(() => {
            let t = r.language || r.lang || "",
              a = e ?? "";
            return `lang-${t}-code-${a.slice(0, 20)}`.replace(/[^a-zA-Z0-9_-]/g, "_");
          }, [r.language, r.lang, e]),
          { payloadInput: C, setPayloadInput: S, isInProgress: O } = (0, l.w)();
        return x && e && !r.hideAskAiButton && g?.askAiOnCodeBlock !== !1
          ? (0, a.jsxs)("div", {
              className: (0, m.cn)("z-10 relative select-none", t),
              children: [
                (0, a.jsx)("button", {
                  className:
                    "h-[26px] w-[26px] flex items-center justify-center rounded-md backdrop-blur peer group/ask-ai-button ",
                  id: p.V.AskAiCodeBlockButton,
                  "aria-label": v["aria.askAI"],
                  "data-chat-payload-element-id": N,
                  onClick: () => {
                    if (O || !e || !x) {
                      return;
                    }
                    f || y({ entryPoint: "code-block" });
                    let t = `\`\`\`${r.language || ""}
${e}
\`\`\``,
                      a = C.context || [];
                    a.some((e) => e.elementId === N) ||
                      (S({ context: [...a, { type: "code", value: t, path: w, elementId: N }] }),
                      k({ subdomain: b, query: t + "\n\nExplain this code snippet." }));
                  },
                  children: (0, a.jsxs)("svg", {
                    width: "18",
                    height: "18",
                    viewBox: "0 0 18 18",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    className: (0, m.cn)(
                      "w-4 h-4",
                      "system" === j &&
                        "text-gray-400 group-hover/ask-ai-button:text-gray-500 dark:text-white/40 dark:group-hover/ask-ai-button:text-white/60",
                      "dark" === j && "text-white/40 group-hover/ask-ai-button:text-white/60",
                    ),
                    children: [
                      (0, a.jsx)("path", {
                        d: "M3.51169 1.50098L3.92087 2.72754L3.99997 2.96387L5.49997 3.46387L4.23825 3.88477L4.00095 3.96387L3.92184 4.20117L3.50095 5.46191L3.49997 5.46387H3.49899L2.99899 3.96387L1.49899 3.46387L2.99899 2.96387L3.07809 2.72754L3.4863 1.50098C3.49031 1.50045 3.49522 1.5 3.49997 1.5C3.50416 1.50002 3.50807 1.50054 3.51169 1.50098Z",
                        stroke: "currentColor",
                      }),
                      (0, a.jsx)("path", {
                        d: "M9.5 2.75L11.412 7.587L16.25 9.5L11.412 11.413L9.5 16.25L7.587 11.413L2.75 9.5L7.587 7.587L9.5 2.75Z",
                        stroke: "currentColor",
                        strokeWidth: "1.5",
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      }),
                    ],
                  }),
                }),
                (0, a.jsx)(h.iG, { text: v["tooltip.askAI"] }),
              ],
            })
          : null;
      }
    },
    67908: (e, t, r) => {
      "use strict";
      r.d(t, { f: () => a });
      let a = {
        Overlay: "z-50",
        Popup: "z-40",
        PrimaryNav: "z-30",
        SecondaryNav: "z-20",
        Control: "z-10",
        Banner: "z-[45]",
      };
    },
    68429: (e, t, r) => {
      "use strict";
      r.d(t, { X: () => o });
      var a = r(54568),
        n = r(7620),
        s = r(30793),
        i = r(81325);
      function o({ children: e, className: t, ...r }) {
        let { docsConfig: o } = (0, n.useContext)(s.DocsConfigContext),
          l = o?.theme ?? "";
        return (0, a.jsx)("div", {
          "data-table-wrapper": !0,
          className: (0, i.cn)(
            t,
            ("mint" === l || "linden" === l || "aspen" === l) && "[--page-padding:20px]",
            ("maple" === l || "willow" === l) && "[--page-padding:16px]",
            "almond" === l && "[--page-padding:32px]",
            "palm" === l && "w-full -mx-0",
            "overflow-x-auto flex w-[calc(100%+(var(--page-padding)*2))] my-[1em] py-[1em] -mx-[var(--page-padding)] max-w-none [contain:inline-size]",
          ),
          ...r,
          children: (0, a.jsx)("div", {
            className: "px-[var(--page-padding)] grow max-w-none table",
            children: (0, a.jsx)("table", {
              className:
                "m-0 min-w-full w-full max-w-none table [&_td]:min-w-[150px] [&_th]:text-left [&_td[data-numeric]]:tabular-nums",
              children: e,
            }),
          }),
        });
      }
    },
    68999: (e, t, r) => {
      "use strict";
      r.d(t, { ComponentIcon: () => m, A: () => u });
      var a = r(54568),
        n = r(70785);
      let s = new Set([
        "brands",
        "duotone",
        "light",
        "regular",
        "sharp-duotone-solid",
        "sharp-light",
        "sharp-regular",
        "sharp-solid",
        "sharp-thin",
        "solid",
        "thin",
      ]);
      var i = r(7620),
        o = r(90280);
      let l = [
        "viadeo-square",
        "supple",
        "x-twitter",
        "bootstrap",
        "weixin",
        "connectdevelop",
        "medium",
        "square-facebook",
        "ioxhost",
        "snapchat-ghost",
        "fonticons",
        "figma",
        "reddit-alien",
        "angrycreative",
        "imdb",
        "steam",
        "square-xing",
        "d-and-d-beyond",
        "font-awesome-logo-full",
        "tumblr",
        "pied-piper-square",
        "bandcamp",
        "red-river",
        "square-lastfm",
        "stackpath",
        "square-hacker-news",
        "strava",
        "dropbox",
        "meta",
        "microsoft",
        "creative-commons-nd",
        "square-tumblr",
        "dyalog",
        "squarespace",
        "google-plus-square",
        "whatsapp-square",
        "accusoft",
        "lastfm",
        "phoenix-squadron",
        "square-snapchat",
        "yelp",
        "cloudflare",
        "deviantart",
        "airbnb",
        "usps",
        "envira",
        "fulcrum",
        "linux",
        "foursquare",
        "bilibili",
        "drupal",
        "cc-stripe",
        "square-youtube",
        "edge-legacy",
        "dev",
        "speakap",
        "android",
        "git-square",
        "ethereum",
        "shirtsinbulk",
        "black-tie",
        "odnoklassniki",
        "fonticons-fi",
        "cc-amex",
        "js",
        "galactic-senate",
        "reacteurope",
        "openid",
        "gitlab",
        "sourcetree",
        "gg",
        "joget",
        "weibo",
        "aws",
        "sass",
        "cc-paypal",
        "superpowers",
        "rust",
        "sellcast",
        "java",
        "orcid",
        "tencent-weibo",
        "trade-federation",
        "viber",
        "ello",
        "wix",
        "mizuni",
        "leanpub",
        "bitbucket",
        "pagelines",
        "creative-commons",
        "github",
        "viacoin",
        "freebsd",
        "rebel",
        "square-steam",
        "fedex",
        "usb",
        "empire",
        "simplybuilt",
        "google-drive",
        "microblog",
        "square-figma",
        "etsy",
        "bimobject",
        "app-store-ios",
        "gripfire",
        "500px",
        "speaker-deck",
        "deskpro",
        "critical-role",
        "square-github",
        "vimeo-v",
        "stripe-s",
        "keybase",
        "yandex-international",
        "umbraco",
        "joomla",
        "google-play",
        "uniregistry",
        "d-and-d",
        "vsco",
        "kaggle",
        "cash-app",
        "hubspot",
        "confluence",
        "square-gitlab",
        "tidal",
        "youtube-square",
        "servicestack",
        "reddit-square",
        "npm",
        "square-font-awesome",
        "tor-browser",
        "square-whatsapp",
        "creative-commons-nc",
        "galactic-republic",
        "square-instagram",
        "raspberry-pi",
        "instagram-square",
        "tumblr-square",
        "mastodon",
        "letterboxd",
        "square-git",
        "42-group",
        "angular",
        "untappd",
        "apper",
        "git-alt",
        "sitrox",
        "behance-square",
        "vk",
        "vimeo",
        "discourse",
        "hotjar",
        "symfony",
        "slack-hash",
        "square-odnoklassniki",
        "skyatlas",
        "hacker-news",
        "files-pinwheel",
        "flutter",
        "instagram",
        "y-combinator",
        "linktree",
        "shopify",
        "webflow",
        "mendeley",
        "odysee",
        "wodu",
        "fort-awesome-alt",
        "threads",
        "square-linkedin",
        "r-project",
        "edge",
        "yammer",
        "11ty",
        "bots",
        "fly",
        "openai",
        "safari",
        "square-behance",
        "pied-piper-hat",
        "audible",
        "yoast",
        "fort-awesome",
        "square-dribbble",
        "python",
        "pix",
        "cc-apple-pay",
        "docker",
        "git",
        "blogger",
        "itch-io",
        "opensuse",
        "nfc-symbol",
        "creative-commons-nc-eu",
        "schlix",
        "mailchimp",
        "neos",
        "creative-commons-pd",
        "pinterest-p",
        "square-letterboxd",
        "digg",
        "bitcoin",
        "whmcs",
        "delicious",
        "bluesky",
        "hackerrank",
        "vimeo-square",
        "disqus",
        "telegram",
        "cc-discover",
        "centercode",
        "erlang",
        "medrt",
        "salesforce",
        "notion",
        "meetup",
        "square-vimeo",
        "wizards-of-the-coast",
        "markdown",
        "instalod",
        "padlet",
        "goodreads",
        "dribbble-square",
        "unity",
        "creative-commons-sampling-plus",
        "invision",
        "mix",
        "square-x-twitter",
        "gratipay",
        "magento",
        "bluetooth",
        "houzz",
        "expeditedssl",
        "the-red-yeti",
        "canadian-maple-leaf",
        "sith",
        "algolia",
        "ussunnah",
        "tex",
        "sellsy",
        "jira",
        "spotify",
        "intercom",
        "wolf-pack-battalion",
        "square-twitter",
        "flipboard",
        "google-wallet",
        "shopware",
        "jxl",
        "phoenix-framework",
        "wirsindhandwerk",
        "kickstarter-k",
        "gitlab-square",
        "cc-jcb",
        "researchgate",
        "lyft",
        "wpressr",
        "lastfm-square",
        "octopus-deploy",
        "periscope",
        "modx",
        "kickstarter",
        "slideshare",
        "snapchat",
        "font-awesome",
        "buy-n-large",
        "readme",
        "creative-commons-nc-jp",
        "themeisle",
        "html5",
        "replyd",
        "cuttlefish",
        "rockrms",
        "ravelry",
        "stubber",
        "quora",
        "font-awesome-alt",
        "monero",
        "hire-a-helper",
        "github-alt",
        "creative-commons-share",
        "yarn",
        "cc-visa",
        "dochub",
        "github-square",
        "laravel",
        "digital-ocean",
        "xing-square",
        "earlybirds",
        "centos",
        "bluetooth-b",
        "teamspeak",
        "square-google-plus",
        "wpexplorer",
        "first-order-alt",
        "ubuntu",
        "opencart",
        "pied-piper",
        "paypal",
        "suse",
        "wpbeginner",
        "deezer",
        "blogger-b",
        "rocketchat",
        "unsplash",
        "draft2digital",
        "playstation",
        "facebook",
        "amazon-pay",
        "square-font-awesome-stroke",
        "amazon",
        "quinscape",
        "free-code-camp",
        "vine",
        "pinterest",
        "creative-commons-sa",
        "css",
        "creative-commons-pd-alt",
        "stack-overflow",
        "page4",
        "mdb",
        "osi",
        "yandex",
        "whatsapp",
        "google",
        "chromecast",
        "line",
        "battle-net",
        "affiliatetheme",
        "brave",
        "atlassian",
        "aviato",
        "bity",
        "php",
        "stumbleupon-circle",
        "stripe",
        "jedi-order",
        "think-peaks",
        "buromobelexperte",
        "phabricator",
        "apple-pay",
        "artstation",
        "font-awesome-flag",
        "scribd",
        "stack-exchange",
        "fedora",
        "jenkins",
        "studiovinari",
        "glide",
        "adn",
        "square-web-awesome",
        "pixelfed",
        "css3-alt",
        "xing",
        "medapps",
        "redhat",
        "uncharted",
        "fantasy-flight-games",
        "facebook-f",
        "perbyte",
        "hips",
        "google-pay",
        "twitch",
        "cc-diners-club",
        "supportnow",
        "windows",
        "rev",
        "btc",
        "creative-commons-zero",
        "elementor",
        "shoelace",
        "square-pied-piper",
        "mintbit",
        "youtube",
        "accessible-icon",
        "gg-circle",
        "lumon-drop",
        "app-store",
        "codiepie",
        "stumbleupon",
        "nutritionix",
        "linkedin-in",
        "jsfiddle",
        "yahoo",
        "grav",
        "firefox-browser",
        "sticker-mule",
        "kakao-talk",
        "goodreads-g",
        "uber",
        "sketch",
        "creative-commons-remix",
        "itunes-note",
        "gulp",
        "keycdn",
        "diaspora",
        "cotton-bureau",
        "reddit",
        "alipay",
        "google-scholar",
        "cloudscale",
        "buysellads",
        "steam-symbol",
        "asymmetrik",
        "angellist",
        "wpforms",
        "linode",
        "js-square",
        "guilded",
        "avianex",
        "evernote",
        "codepen",
        "dribbble",
        "cc-amazon-pay",
        "xbox",
        "trello",
        "adversal",
        "dhl",
        "hornbill",
        "square-bluesky",
        "themeco",
        "square-kickstarter",
        "google-plus",
        "contao",
        "linkedin",
        "ideal",
        "mandalorian",
        "hashnode",
        "old-republic",
        "qq",
        "vaadin",
        "uikit",
        "lumon",
        "react",
        "creative-commons-by",
        "square-pinterest",
        "watchman-monitoring",
        "optin-monster",
        "twitter",
        "less",
        "dailymotion",
        "patreon",
        "swift",
        "discord",
        "hacker-news-square",
        "opera",
        "gitter",
        "buffer",
        "css3",
        "renren",
        "square-reddit",
        "ns8",
        "sistrix",
        "rendact",
        "duolingo",
        "vuejs",
        "debian",
        "facebook-square",
        "eleventy",
        "mixcloud",
        "firstdraft",
        "slack",
        "zhihu",
        "soundcloud",
        "product-hunt",
        "wikipedia-w",
        "space-awesome",
        "pied-piper-pp",
        "creative-commons-sampling",
        "hooli",
        "first-order",
        "glide-g",
        "ember",
        "gitkraken",
        "dart-lang",
        "steam-square",
        "wsh",
        "square-threads",
        "skype",
        "gofore",
        "ebay",
        "cpanel",
        "wordpress",
        "square-upwork",
        "w3c",
        "korvue",
        "cloudversify",
        "square-web-awesome-stroke",
        "web-awesome",
        "grunt",
        "viadeo",
        "wordpress-simple",
        "blackberry",
        "facebook-messenger",
        "pushed",
        "hive",
        "pandora",
        "amilia",
        "pied-piper-alt",
        "nfc-directional",
        "innosoft",
        "cloudsmith",
        "chrome",
        "forumbee",
        "snapchat-square",
        "node-js",
        "maxcdn",
        "apple",
        "pixiv",
        "napster",
        "nimblr",
        "vnv",
        "waze",
        "telegram-plane",
        "odnoklassniki-square",
        "google-plus-g",
        "palfed",
        "screenpal",
        "weebly",
        "autoprefixer",
        "searchengin",
        "square-viadeo",
        "pinterest-square",
        "brave-reverse",
        "megaport",
        "typo3",
        "deploydog",
        "node",
        "cc-mastercard",
        "tiktok",
        "twitter-square",
        "dashcube",
        "get-pocket",
        "golang",
        "ups",
        "medium-m",
        "behance",
        "resolving",
        "internet-explorer",
        "signal-messenger",
        "staylinked",
        "cmplid",
        "firefox",
        "flickr",
        "mixer",
        "square-js",
        "upwork",
        "itunes",
        "linear",
      ];
      var d = r(30793),
        c = r(98167),
        p = r(81325);
      function u({ style: e, icon: t, iconType: r, iconLibrary: n, className: s, color: l }) {
        let { pageType: c } = (0, i.useContext)(d.PageContext),
          p = (function (e, t, r) {
            switch (!0) {
              case h(e):
                return `${o.M5}/v7.1.0/brands/${e}.svg`;
              case "lucide" === r:
                return `${o.M5}/lucide/v0.545.0/${e}.svg`;
              case "tabler" === r:
                return `${o.M5}/tabler/v3.36.1/${"solid" === t ? "filled" : "outline"}/${e}.svg`;
              default:
                return `${o.M5}/v7.1.0/${t ?? "regular"}/${e}.svg`;
            }
          })(t, r, n);
        return "pdf" === c
          ? (0, a.jsx)("img", {
              src: p,
              className: s,
              style: { backgroundColor: "transparent", ...e },
              alt: t,
            })
          : (0, a.jsx)("svg", {
              className: s,
              style: {
                WebkitMaskImage: `url(${p})`,
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskImage: `url(${p})`,
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: ("lucide" !== n && "tabler" !== n) || h(t) ? void 0 : "100%",
                backgroundColor: l,
                ...e,
              },
            });
      }
      function m({ icon: e, iconType: t, className: r, style: l, color: m, overrideColor: h }) {
        let { docsConfig: x } = (0, i.useContext)(d.DocsConfigContext),
          g = x?.icons?.library;
        if (t && !s.has(t)) {
          return (
            console.log(
              `Invalid iconType ${t} expected a string equal to one of: brands, duotone, light, regular, sharp-solid, solid, thin`,
            ),
            null
          );
        }
        if ("string" == typeof e && ((0, n.v)(e) || e.startsWith("/"))) {
          if (e.startsWith(o.M5) || e.startsWith("https://mintlify.b-cdn.net")) {
            return (0, a.jsx)("svg", {
              className: r,
              style: {
                WebkitMaskImage: `url(${e})`,
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskPosition: "center",
                maskImage: `url(${e})`,
                maskRepeat: "no-repeat",
                maskPosition: "center",
                maskSize: "100%",
                backgroundColor: "currentColor",
                ...l,
              },
            });
          }
          let t = e;
          return (
            e.startsWith("/") && c.c.BASE_PATH && (t = `${c.c.BASE_PATH}${e}`),
            (0, a.jsx)("img", {
              src: t,
              alt: e,
              className: (0, p.cn)(r, "bg-transparent dark:bg-transparent"),
              style: l,
            })
          );
        }
        return (0, a.jsx)(u, {
          icon: e.toLowerCase(),
          iconType: t,
          iconLibrary: g,
          className: (0, p.cn)(r, !m && !h && "bg-gray-800 dark:bg-gray-100"),
          style: l,
          color: m,
        });
      }
      function h(e) {
        return !!e && l.includes(e.toLowerCase());
      }
    },
    69494: (e, t, r) => {
      "use strict";
      r.d(t, { Fr: () => i, c$: () => o });
      var a = r(7620),
        n = r(51874),
        s = r(65904);
      function i(e, t, r = !1) {
        return (t?.includes(s.SHIKI_CLASSNAME) ||
          (function e(t) {
            if (!t || "object" != typeof t) {
              return !1;
            }
            if (Array.isArray(t)) {
              for (let r of t) {
                if (e(r)) return !0;
              }
            }
            if ("props" in t && t.props && "object" == typeof t.props) {
              if (
                "className" in t.props &&
                "string" == typeof t.props.className &&
                t.props.className.includes(s.SHIKI_CLASSNAME)
              ) {
                return !0;
              }
              if ("children" in t.props) {
                return e(t.props.children);
              }
            }
            return !1;
          })(e)) &&
          !r
          ? ""
          : (0, n.O)(e);
      }
      function o(e, t) {
        return (0, a.useMemo)(
          () =>
            void 0 !== t
              ? t
              : e
                ? (function (e) {
                    if (!e || "string" != typeof e) {
                      return 0;
                    }
                    let t = e.match(/<span class="line/g);
                    return t ? t.length : 0;
                  })(e)
                : void 0,
          [e, t],
        );
      }
    },
    70153: (e, t, r) => {
      "use strict";
      r.d(t, { T: () => i });
      var a = r(7620),
        n = r(30793),
        s = r(35878);
      function i(e) {
        let { docsConfig: t } = (0, a.useContext)(n.DocsConfigContext),
          [r, i] = (0, a.useState)(),
          o = e ? e.top : void 0,
          l = t?.theme === "almond";
        return (
          (0, a.useEffect)(() => {
            let e;
            if (void 0 !== o) {
              if (l) {
                let t = document.getElementById(s.V.ContentContainer);
                t && (e = o + t.scrollTop);
              } else {
                e = o + window.pageYOffset;
              }
              e && e !== r && i(e);
            }
          }, [o, r, l]),
          r
        );
      }
    },
    71826: (e, t, r) => {
      "use strict";
      r.d(t, { EO: () => y, Jc: () => v, Jm: () => f, SQ: () => j });
      var a = r(27277),
        n = r(7620),
        s = r(90280),
        i = r(30793),
        o = r(76829),
        l = r(98167),
        d = r(53457),
        c = r(59676);
      let p = async ({ datasetId: e, query: t, apiKey: r, filters: a, signal: n }) => {
          let s = 2 * t.trim().split(/\s+/).length,
            i = await fetch(
              "https://api.mintlifytrieve.com/api/chunk_group/group_oriented_autocomplete",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "TR-Dataset": e,
                  Authorization: r,
                  "X-API-Version": "V2",
                },
                signal: n,
                body: JSON.stringify({
                  query: t,
                  search_type: "fulltext",
                  extend_results: !0,
                  highlight_options: {
                    highlight_window: 10,
                    highlight_max_num: 1,
                    highlight_max_length: s,
                    highlight_strategy: "exactmatch",
                    highlight_delimiters: ["?", ",", ".", "!", "\n"],
                  },
                  score_threshold: 0.2,
                  filters: { must_not: [{ field: "tag_set", match: ["code"] }], ...x(a) },
                  page_size: 6,
                  group_size: 3,
                }),
              },
            ),
            o = await i.json();
          return { id: o.id, results: u(o) };
        },
        u = (e) =>
          "object" == typeof e && "results" in e && Array.isArray(e.results)
            ? m(
                e.results
                  .map((e) => {
                    if (!e.chunks || 0 === e.chunks.length) {
                      return;
                    }
                    let {
                      chunk: t,
                      highlights: r,
                      score: a,
                    } = e.chunks.reduce((e, t) => (e.score > t.score ? e : t));
                    if (!t.chunk_html || !t.link) {
                      return;
                    }
                    let n = t.chunk_html.indexOf("\n"),
                      s = t.chunk_html.substring(0, n),
                      i = t.chunk_html.substring(n + 1),
                      o = r[0];
                    return (
                      o?.startsWith(s) && (o = o.replace(s, "")),
                      {
                        id: t.id,
                        header: s,
                        content: o ? o.substring(0, 100) : i.substring(0, 100),
                        page: t.link,
                        link: h(t),
                        metadata: t.metadata,
                        score: a,
                      }
                    );
                  })
                  .filter((e) => void 0 !== e),
              )
            : [],
        m = (e) => {
          let t = new Map();
          for (let r of e) {
            r && (t.has(r.page) || t.set(r.page, r));
          }
          return [...t.values()];
        },
        h = (e) => {
          if (
            !(
              "metadata" in e &&
              e.metadata &&
              "title" in e.metadata &&
              "link" in e &&
              "string" == typeof e.link
            )
          ) {
            return "";
          }
          let t = e.metadata.title,
            r = (0, d.Mi)(e.link);
          if (t && "string" == typeof t) {
            return `${r}#${(0, c.A)(t, { decamelize: !1, preserveCharacters: ["_"] })}`;
          }
          return r;
        },
        x = (e) => {
          let { groups: t, language: r, version: a } = e;
          if (!t && !r && !a) {
            return {};
          }
          let n = [];
          return (
            t && n.push({ field: "tag_set", match_any: t.map((e) => `USERAUTH:${e}`) }),
            r && n.push({ field: "tag_set", match_any: [`LANGUAGE:${r}`, "LANGUAGE:*"] }),
            a && n.push({ field: "tag_set", match_any: [`VERSION:${a}`, "VERSION:*"] }),
            { must: n }
          );
        };
      var g = r(67377);
      let f = "search_api_key",
        y = "public_search_api_key",
        b = (e) => {
          let t = a.A.get(e ? f : y);
          if (!t) {
            return { key: null, expiresAt: null, locale: void 0, version: void 0 };
          }
          try {
            return JSON.parse(t);
          } catch {
            return { key: null, expiresAt: null, locale: void 0, version: void 0 };
          }
        },
        v = "SEARCH_ABORTED",
        j = () => {
          let { subdomain: e, trieve: t } = (0, n.useContext)(i.DeploymentMetadataContext),
            { userInfo: r, auth: d, isFetchingUserInfo: c } = (0, n.useContext)(i.AuthContext),
            u = (0, g.f)(),
            {
              selectedLocale: m,
              selectedVersion: h,
              isUpdatingCache: x,
            } = (0, n.useContext)(o.NavigationContext),
            [j, k] = (0, n.useState)(() => {
              if (!l.c.AUTH_ENABLED) {
                return l.c.TRIEVE_API_KEY || "";
              }
              let { key: e } = b(!!r);
              return e || "";
            }),
            w = (0, n.useRef)(0),
            N = (0, n.useRef)(null),
            [C, S] = (0, n.useState)(!1);
          return (
            (0, n.useEffect)(() => {
              let n;
              if (!l.c.AUTH_ENABLED || !t?.datasetId || c || x || C || w.current >= 3) {
                return;
              }
              let { key: i, expiresAt: o, locale: p, version: u } = b(!!r),
                g = p !== m || u !== h,
                v = !i || (o && Date.now() > o);
              !i || g || v || k(i);
              let j = async () => {
                if (l.c.AUTH_ENABLED) {
                  S(!0);
                  try {
                    let t =
                        d && !r
                          ? `${l.c.BASE_PATH}/_mintlify/api-public/${e}/search-api-key`
                          : `${l.c.BASE_PATH}/_mintlify/api/search-api-key`,
                      n = await fetch(t, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(
                          m || h
                            ? { filters: { language: m, version: h.length ? h : void 0 } }
                            : {},
                        ),
                      }),
                      i = await n.json(),
                      o = Date.now() + s.rQ;
                    (((e, t, r, n, s) => {
                      a.A.set(
                        r ? f : y,
                        JSON.stringify({ key: e, expiresAt: t, locale: n, version: s }),
                        { expires: new Date(t), secure: !0, sameSite: "strict" },
                      );
                    })(i.key, o, !!r, m, h),
                      k(i.key),
                      (w.current = 0));
                  } catch (e) {
                    (console.error("Failed to fetch search API key", e),
                      (w.current = w.current + 1));
                  } finally {
                    S(!1);
                  }
                }
              };
              (g || v) && j();
              let N = setTimeout(
                () => {
                  (j(), (n = setInterval(() => void j(), s.rQ - s.Az)));
                },
                Math.max(0, (o || Date.now() + s.rQ) - Date.now() - s.Az),
              );
              return () => {
                (clearTimeout(N), clearInterval(n));
              };
            }, [r, m, h, e, d, c, x, C, t?.datasetId]),
            (0, n.useEffect)(
              () => () => {
                N.current && N.current.abort();
              },
              [],
            ),
            {
              search: (0, n.useCallback)(
                async (e) => {
                  if (!t?.datasetId) {
                    return { id: void 0, results: [] };
                  }
                  N.current && N.current.abort();
                  let r = new AbortController();
                  N.current = r;
                  try {
                    return await p({
                      datasetId: t.datasetId,
                      query: e,
                      apiKey: j,
                      filters: { groups: u, version: "" !== h ? h : void 0, language: m },
                      signal: r.signal,
                    });
                  } catch (e) {
                    if (e instanceof Error && "AbortError" === e.name) {
                      return v;
                    }
                    throw e;
                  }
                },
                [t?.datasetId, j, u, h, m],
              ),
              apiKey: j,
            }
          );
        };
    },
    72849: (e, t, r) => {
      "use strict";
      function a(e) {
        return encodeURIComponent(e.toLowerCase().trim().replace(/\s+/g, "-"));
      }
      r.d(t, { hT: () => a });
    },
    74092: (e, t, r) => {
      "use strict";
      r.d(t, { E: () => a });
      let a = r(7620).useLayoutEffect;
    },
    75968: (e, t, r) => {
      "use strict";
      r.d(t, { k: () => p });
      var a = r(54568),
        n = r(7620),
        s = r(62060),
        i = r(76829),
        o = r(15209),
        l = r(35878),
        d = r(81325),
        c = r(87799);
      function p({ className: e }) {
        let t = (0, o.e)(),
          { isCodeSnippetFeedbackEnabled: r, setFeedbackModalOpen: p } = (0, n.useContext)(s.j),
          u = (0, i.n)();
        return r
          ? (0, a.jsxs)("div", {
              className: (0, d.cn)("z-10 relative select-none", e),
              children: [
                (0, a.jsx)("button", {
                  className:
                    "h-[26px] w-[26px] flex items-center justify-center rounded-md backdrop-blur peer group/code-snippet-feedback-button",
                  id: l.V.CodeSnippetFeedbackButton,
                  "aria-label": u["aria.reportIncorrectCode"],
                  onClick: () => p(!0),
                  children: (0, a.jsxs)("svg", {
                    width: "24",
                    height: "24",
                    viewBox: "0 0 24 24",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    stroke: "currentColor",
                    strokeWidth: "2",
                    strokeLinecap: "round",
                    strokeLinejoin: "round",
                    className: (0, d.cn)(
                      "w-4 h-4",
                      "system" === t &&
                        "text-gray-400 group-hover/code-snippet-feedback-button:text-gray-500 dark:text-white/40 dark:group-hover/code-snippet-feedback-button:text-white/60",
                      "dark" === t &&
                        "text-white/40 group-hover/code-snippet-feedback-button:text-white/60",
                    ),
                    children: [
                      (0, a.jsx)("path", { d: "M12 16h.01" }),
                      (0, a.jsx)("path", { d: "M12 8v4" }),
                      (0, a.jsx)("path", {
                        d: "M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z",
                      }),
                    ],
                  }),
                }),
                (0, a.jsx)(c.iG, { text: u["tooltip.reportIncorrectCode"] }),
              ],
            })
          : null;
      }
    },
    79634: (e, t, r) => {
      "use strict";
      r.d(t, { DynamicLink: () => l });
      var a = r(54568),
        n = r(19664),
        s = r.n(n);
      r(7620);
      var i = r(33052),
        o = r(81325);
      function l({
        href: e,
        ref: t,
        onMouseEnter: r,
        onMouseLeave: n,
        style: l,
        className: d,
        children: c,
        onClick: p,
        onInternalLinkClick: u,
        ...m
      }) {
        let h = (e) => {
          (u?.(), p?.(e));
        };
        return e?.startsWith("/")
          ? (0, a.jsx)(s(), {
              href: e,
              ref: t,
              passHref: !0,
              onMouseEnter: r,
              onMouseLeave: n,
              style: l,
              className: (0, o.cn)(i.x.Link, d),
              onClick: h,
              ...m,
              children: c,
            })
          : e?.startsWith("./") || e?.startsWith("../") || e?.startsWith("#")
            ? (0, a.jsx)("a", {
                href: e,
                ref: t,
                onMouseEnter: r,
                onMouseLeave: n,
                style: l,
                className: (0, o.cn)(i.x.Link, d),
                onClick: h,
                ...m,
                children: c,
              })
            : (0, a.jsx)("a", {
                href: e,
                target: "_blank",
                rel: "noreferrer",
                ref: t,
                onMouseEnter: r,
                onMouseLeave: n,
                style: l,
                className: (0, o.cn)(i.x.Link, d),
                onClick: p,
                ...m,
                children: c,
              });
      }
    },
    81817: (e, t, r) => {
      "use strict";
      r.d(t, { B: () => s });
      var a = r(7620),
        n = r(30793);
      let s = () => {
        let {
          apiReferenceData: { channel: e },
        } = (0, a.useContext)(n.ApiReferenceContext);
        return (0, a.useMemo)(() => e, [e]);
      };
    },
    83308: (e, t, r) => {
      "use strict";
      r.d(t, { F: () => s, c: () => i });
      var a = r(98167);
      let n = "/api/assistant";
      function s({ subdomain: e, isAuthenticated: t }) {
        if (a.c.AUTH_ENABLED) {
          if (t) return `${a.c.BASE_PATH}/_mintlify/api/assistant/message`;
          else return `${a.c.BASE_PATH}/_mintlify/api-public/assistant/${e}/message`;
        }
        let r = `${n}/${e}/message`;
        return `${a.c.AI_MESSAGE_HOST}${r}`;
      }
      function i({ subdomain: e, isAuthenticated: t, messageId: r, feedback: s }) {
        if (a.c.AUTH_ENABLED) {
          if (t)
            return `${a.c.BASE_PATH}/_mintlify/api/assistant/message/${r}/thumbs-feedback?feedback=${s}`;
          else
            return `${a.c.BASE_PATH}/_mintlify/api-public/assistant/${e}/message/${r}/thumbs-feedback?feedback=${s}`;
        }
        let i = `${n}/${e}/message/${r}/thumbs-feedback?feedback=${s}`;
        return `${a.c.AI_MESSAGE_HOST}${i}`;
      }
    },
    83592: () => {},
    84583: (e, t, r) => {
      "use strict";
      r.d(t, { m$: () => s, oW: () => o, ad: () => i });
      var a = r(54568),
        n = r(7620);
      let s = (0, n.createContext)({}),
        i = () => (0, n.useContext)(s);
      function o({ location: e, children: t }) {
        let r = (0, n.useRef)(!1),
          i = (() => {
            let [e, t] = (0, n.useState)(void 0);
            return (
              (0, n.useEffect)(() => {
                let e = () => {
                  let e = window.location.hash;
                  e && t(e);
                };
                return (
                  e(),
                  window.addEventListener("hashchange", e),
                  () => {
                    window.removeEventListener("hashchange", e);
                  }
                );
              }, []),
              e
            );
          })();
        return (0, a.jsx)(s.Provider, {
          value: { location: e, anchor: i, hasScrolledToAnchorRef: r },
          children: t,
        });
      }
      s.displayName = "EndpointLocationContext";
    },
    84941: (e, t, r) => {
      "use strict";
      r.d(t, { b: () => i });
      var a = r(7620),
        n = r(30793),
        s = r(59705);
      let i = () => {
        let e = (0, s.jT)((e) => e.selectedBaseUrlIndex),
          t = (0, s.jT)((e) => e.setSelectedBaseUrlIndex),
          { apiReferenceData2: r } = (0, a.useContext)(n.ApiReferenceContext2),
          i = r.operation?.baseUrl ?? r.operation?.baseUrlOptions[e] ?? "";
        return { selectedBaseUrlIndex: e, setSelectedBaseUrlIndex: t, baseUrl: i };
      };
    },
    86973: () => {},
    87799: (e, t, r) => {
      "use strict";
      r.d(t, { NG: () => f, TN: () => b, iG: () => j, rZ: () => v });
      var a = r(54568),
        n = r(7620),
        s = r(62060),
        i = r(76829),
        o = r(15209),
        l = r(33052),
        d = r(68999),
        c = r(81325),
        p = r(49765),
        u = r(57810),
        m = r(67018),
        h = r(48059),
        x = r(75968),
        g = r(51874);
      let f = function (e) {
        let {
            filename: t,
            onCopied: r,
            children: n,
            className: i,
            icon: d,
            isSmallText: u,
            hideAskAiButton: f,
            ...v
          } = e,
          j = (0, g.O)(n),
          k = (e) => (0, a.jsx)(b, { textToCopy: j, onCopied: r, ...e }),
          w = (0, o.e)(),
          N = !!t || !!d;
        return (0, a.jsx)(s.R, {
          code: j,
          ...(0, p.f)(e),
          children: ({ feedbackModalOpen: r, anchorRef: n }) =>
            (0, a.jsxs)("div", {
              className: (0, c.cn)(
                l.x.CodeBlock,
                "mt-5 mb-8 not-prose rounded-2xl relative group",
                "system" === w &&
                  "text-gray-950 bg-gray-50 dark:bg-white/5 dark:text-gray-50 codeblock-light border border-gray-950/10 dark:border-white/10 dark:twoslash-dark",
                "dark" === w &&
                  "text-gray-50 bg-codeblock dark:bg-white/5 ring-1 ring-transparent dark:ring-white/[0.14] codeblock-dark twoslash-dark dark:twoslash-dark",
                N ? "p-0.5" : "bg-transparent dark:bg-transparent",
                r && "border border-primary dark:border-primary-light",
                i,
              ),
              ref: n,
              ...v,
              children: [
                N
                  ? (0, a.jsxs)(y, {
                      filename: t,
                      icon: d,
                      children: [
                        (0, a.jsx)(x.k, {}),
                        (0, a.jsx)(k, {}),
                        (0, a.jsx)(m.y, { code: j, ...(0, p.f)(e) }),
                      ],
                    })
                  : (0, a.jsxs)("div", {
                      "data-floating-buttons": !0,
                      className: "absolute top-3 right-4 flex items-center gap-1.5",
                      children: [
                        (0, a.jsx)(x.k, {}),
                        (0, a.jsx)(k, {}),
                        (0, a.jsx)(m.y, { code: j, ...(0, p.f)(e) }),
                      ],
                    }),
                (0, a.jsx)(h.S7, { isSmallText: u, hideAskAiButton: f, ...e }),
              ],
            }),
        });
      };
      function y({ filename: e, icon: t, children: r }) {
        let n = (0, o.e)();
        return (0, a.jsxs)("div", {
          className:
            "flex text-gray-400 text-xs rounded-t-[14px] leading-6 font-medium pl-4 pr-2.5 py-1",
          "data-component-part": "code-block-header",
          children: [
            (0, a.jsxs)("div", {
              className: (0, c.cn)(
                "flex-grow-0 flex items-center gap-1.5 text-gray-700 dark:text-gray-300 min-w-0",
                "dark" === n && "text-gray-300",
              ),
              "data-component-part": "code-block-header-filename",
              children: [
                t &&
                  (0, a.jsx)(d.ComponentIcon, {
                    icon: t,
                    iconType: "regular",
                    className: (0, c.cn)(
                      "h-3.5 w-3.5 bg-gray-500 dark:bg-gray-400",
                      l.x.CodeBlockIcon,
                    ),
                    overrideColor: !0,
                  }),
                (0, a.jsx)("span", { className: "truncate min-w-0", children: e }),
              ],
            }),
            (0, a.jsx)("div", {
              className: "flex-1 flex items-center justify-end gap-1.5",
              children: r,
            }),
          ],
        });
      }
      function b({ textToCopy: e, onCopied: t, className: r, showTooltip: s = !0 }) {
        let i = e.trim(),
          [o, l] = (0, n.useState)(!1),
          [d, c] = (0, n.useState)(!1);
        if (
          ((0, n.useEffect)(() => {
            navigator.clipboard
              ? c(!1)
              : (console.warn(
                  "The browser's Clipboard API is unavailable. The Clipboard API is only available on HTTPS.",
                ),
                c(!0));
          }, []),
          !i || d)
        ) {
          return null;
        }
        let p = async () => {
          let e = await (0, u.l)(i);
          (t && t(e, i),
            "success" === e &&
              (l(!0),
              setTimeout(() => {
                l(!1);
              }, 2e3)));
        };
        return (0, a.jsx)(v, { onClick: p, isCopiedActive: o, className: r, showTooltip: s });
      }
      function v({ onClick: e, isCopiedActive: t, showTooltip: r = !0, className: n }) {
        let s = (0, i.n)(),
          l = (0, o.e)();
        return (0, a.jsxs)("div", {
          className: (0, c.cn)("z-10 relative select-none", n),
          children: [
            (0, a.jsx)("button", {
              className:
                "h-[26px] w-[26px] flex items-center justify-center rounded-md backdrop-blur peer group/copy-button ",
              onClick: e,
              "data-testid": "copy-code-button",
              "aria-label": s["aria.copyCodeBlock"],
              children: t
                ? (0, a.jsx)("svg", {
                    className: (0, c.cn)(
                      "system" === l && "fill-primary dark:fill-primary-light",
                      "dark" === l && "fill-primary-light",
                    ),
                    width: "16",
                    height: "11",
                    viewBox: "0 0 16 11",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    children: (0, a.jsx)("path", {
                      d: "M14.7813 1.21873C15.0751 1.51248 15.0751 1.98748 14.7813 2.2781L6.53135 10.5312C6.2376 10.825 5.7626 10.825 5.47197 10.5312L1.21885 6.28123C0.925098 5.98748 0.925098 5.51248 1.21885 5.22185C1.5126 4.93123 1.9876 4.9281 2.27822 5.22185L5.99697 8.9406L13.7188 1.21873C14.0126 0.924976 14.4876 0.924976 14.7782 1.21873H14.7813Z",
                    }),
                  })
                : (0, a.jsxs)("svg", {
                    width: "18",
                    height: "18",
                    viewBox: "0 0 18 18",
                    fill: "none",
                    xmlns: "http://www.w3.org/2000/svg",
                    className: (0, c.cn)(
                      "w-4 h-4",
                      "system" === l &&
                        "text-gray-400 group-hover/copy-button:text-gray-500 dark:text-white/40 dark:group-hover/copy-button:text-white/60",
                      "dark" === l && "text-white/40 group-hover/copy-button:text-white/60",
                    ),
                    children: [
                      (0, a.jsx)("path", {
                        d: "M14.25 5.25H7.25C6.14543 5.25 5.25 6.14543 5.25 7.25V14.25C5.25 15.3546 6.14543 16.25 7.25 16.25H14.25C15.3546 16.25 16.25 15.3546 16.25 14.25V7.25C16.25 6.14543 15.3546 5.25 14.25 5.25Z",
                        stroke: "currentColor",
                        strokeWidth: "1.5",
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      }),
                      (0, a.jsx)("path", {
                        d: "M2.80103 11.998L1.77203 5.07397C1.61003 3.98097 2.36403 2.96397 3.45603 2.80197L10.38 1.77297C11.313 1.63397 12.19 2.16297 12.528 3.00097",
                        stroke: "currentColor",
                        strokeWidth: "1.5",
                        strokeLinecap: "round",
                        strokeLinejoin: "round",
                      }),
                    ],
                  }),
            }),
            r && (0, a.jsx)(j, { text: t ? s["tooltip.copied"] : s["tooltip.copy"] }),
          ],
        });
      }
      function j({ text: e }) {
        return (0, a.jsx)("div", {
          "aria-hidden": !0,
          className:
            "absolute top-11 left-1/2 transform whitespace-nowrap -translate-x-1/2 -translate-y-1/2 peer-hover:opacity-100 opacity-0 text-tooltip-foreground rounded-lg px-1.5 py-0.5 text-xs bg-primary-dark",
          children: e,
        });
      }
    },
    90235: (e, t, r) => {
      "use strict";
      (r.r(t), r.d(t, { default: () => s }));
      var a = r(54568),
        n = r(3226);
      r(7620);
      let s = ({ children: e }) =>
        "object" == typeof e && "props" in e && e.props?.dangerouslySetInnerHTML
          ? (0, a.jsx)(a.Fragment, {
              children: e.props.dangerouslySetInnerHTML.__html
                ? (0, a.jsx)(n.A, { html: e.props.dangerouslySetInnerHTML.__html })
                : e,
            })
          : null;
    },
    90723: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => a });
      let a = (0, r(4211).v)((e, t) => ({
        status: "ready",
        messages: [],
        threadId: void 0,
        threadKey: void 0,
        messageIdToUlid: {},
        messageIdToContext: {},
        payloadInput: {},
        pendingContext: void 0,
        activeStop: void 0,
        featureUnavailable: { unavailable: !1, type: null, message: "" },
        setFeatureUnavailable: (t) => e({ featureUnavailable: t }),
        setThreadId: (t) => e({ threadId: t }),
        setThreadKey: (t) => e({ threadKey: t }),
        setMessageUlid: (t, r) => e((e) => ({ messageIdToUlid: { ...e.messageIdToUlid, [t]: r } })),
        getMessageUlid: (e) => t().messageIdToUlid[e],
        setPayloadInput: (t) => e({ payloadInput: t }),
        setPendingContext: (t) => e({ pendingContext: t }),
        setMessageContext: (t, r) =>
          e((e) => ({ messageIdToContext: { ...e.messageIdToContext, [t]: r } })),
        getMessageContext: (e) => t().messageIdToContext[e],
      }));
    },
    91619: (e, t, r) => {
      "use strict";
      r.d(t, { d: () => n });
      var a = r(59705);
      let n = () => ({
        selectedRequestBodyContentTypeIndex: (0, a.jT)(
          (e) => e.selectedRequestBodyContentTypeIndex,
        ),
        setSelectedRequestBodyContentTypeIndex: (0, a.jT)(
          (e) => e.setSelectedRequestBodyContentTypeIndex,
        ),
      });
    },
    92685: (e, t, r) => {
      "use strict";
      r.d(t, { r: () => a });
      let a = (e) => {
        let t = e.indexOf("?");
        t > -1 && (e = e.substring(0, t));
        let r = e.split("/"),
          a = r[r.length - 1].split("-").join(" ");
        return (a = a.split("_").join(" ")).charAt(0).toUpperCase() + a.slice(1);
      };
    },
    94585: (e, t, r) => {
      "use strict";
      r.d(t, { l: () => l });
      var a = r(54568),
        n = r(7620),
        s = r(33052),
        i = r(81325),
        o = r(5904);
      let l = n.forwardRef(
        ({ className: e, method: t, shortMethod: r = !1, active: n = !1, ...l }, d) => {
          let c = t.toUpperCase(),
            p = (0, o._)(c),
            {
              activeNavPillBg: u,
              activeNavPillText: m,
              inactiveNavPillText: h,
              inactiveNavPillBg: x,
            } = (0, o.H)(t);
          return (0, a.jsx)("div", {
            ref: d,
            className: (0, i.cn)(
              s.x.MethodPill,
              "rounded-lg font-bold px-1.5 py-0.5 text-sm leading-5",
              n ? `${u} ${m}` : `${x} ${h}`,
              e,
            ),
            ...l,
            children: r ? p : c,
          });
        },
      );
      l.displayName = "MethodPill";
    },
    96924: (e, t, r) => {
      "use strict";
      r.d(t, { PrefetchProvider: () => u, B: () => m });
      var a = r(54568),
        n = r(27541),
        s = r(7620),
        i = r(91052),
        o = r(66058);
      async function l(e) {
        if ((0, o.r)()) {
          return;
        }
        if (!i._.DATADOG_API_KEY) {
          return console.warn("[Datadog Alert] DATADOG_API_KEY not configured, skipping alert");
        }
        let t = {
          ddsource: "mintlify-client",
          service: e.service || "client",
          ddtags: [
            "env:production",
            `service:${e.service || "client"}`,
            "alert:critical",
            ...(e.tags || []),
          ].join(","),
          hostname: i._.VERCEL_URL,
          message: e.message,
          status: e.status || "error",
          ...e.metadata,
        };
        try {
          let e = await fetch("https://http-intake.logs.datadoghq.com/api/v2/logs", {
            method: "POST",
            headers: { "Content-Type": "application/json", "DD-API-KEY": i._.DATADOG_API_KEY },
            body: JSON.stringify(t),
          });
          e.ok || console.error("[Datadog Alert] Failed to send alert:", e.status, e.statusText);
        } catch (e) {
          console.error("[Datadog Alert] Error sending alert:", e);
        }
      }
      let d = "test" === i._.NODE_ENV || i._.STORYBOOK,
        c = (0, s.createContext)(null),
        p = { prefetch: () => {} },
        u = ({ children: e }) => {
          let t = (0, s.useRef)([]),
            r = (0, s.useRef)(0),
            i = (0, s.useRef)(new Set()),
            o = (0, n.useRouter)(),
            u = d ? p : o,
            m = (0, s.useMemo)(() => {
              let e = async (a) => {
                r.current++;
                try {
                  u.prefetch(a.href);
                } catch (e) {
                  l({
                    message: `Prefetch failed for route: ${a.href}`,
                    service: a.context?.source ? `client-${a.context.source}` : "client-navigation",
                    tags: ["prefetch-failure", "queued-prefetch"],
                    metadata: {
                      href: a.href,
                      error: e instanceof Error ? e.message : String(e),
                      ...a.context,
                    },
                  });
                } finally {
                  (r.current--,
                    (() => {
                      if (t.current.length > 0 && r.current < 8) {
                        let r = t.current.shift();
                        r && e(r);
                      }
                    })());
                }
              };
              return {
                prefetch: (a, n) => {
                  if (i.current.has(a)) {
                    return;
                  }
                  i.current.add(a);
                  let s = { href: a, context: n };
                  r.current < 8 ? e(s) : t.current.push(s);
                },
                getStats: () => ({
                  activeCount: r.current,
                  queuedCount: t.current.length,
                  prefetchedCount: i.current.size,
                }),
              };
            }, [u]);
          return (0, a.jsx)(c.Provider, { value: m, children: e });
        },
        m = () => {
          let e = (0, s.useContext)(c);
          if (!e) {
            throw Error("usePrefetch must be used within a PrefetchProvider");
          }
          return e;
        };
    },
    97637: (e, t, r) => {
      "use strict";
      r.d(t, { p: () => u });
      var a = r(54568),
        n = r(83335),
        s = r(7620),
        i = r(46540),
        o = r(30793),
        l = r(71252),
        d = r(81325),
        c = r(840);
      function p(e) {
        return "number" == typeof e
          ? { type: "pixel", value: e }
          : "string" == typeof e
            ? e.endsWith("%")
              ? { type: "percentage", value: e }
              : { type: "pixel", value: parseInt(e, 10) }
            : void 0;
      }
      function u({
        src: e,
        alt: t,
        className: r,
        class: u,
        priority: m,
        noZoom: h = !1,
        width: x,
        height: g,
        "data-optimize": f,
        "data-opv": y,
        "data-og-width": b,
        "data-og-height": v,
        style: j,
        srcset: k,
        ...w
      }) {
        let N = p(x),
          C = p(g),
          S = p(b),
          O = p(v),
          $ = (function () {
            let { docsConfig: e } = (0, s.useContext)(o.DocsConfigContext),
              { pageMetadata: t } = (0, s.useContext)(o.PageContext),
              r = e?.theme,
              { isCenter: a, isWide: n, isCustom: i, isFrame: l } = (0, c.H)(t);
            if (i) {
              return "100vw";
            }
            let d = (() => {
              if (a) {
                return 768;
              }
              switch (r) {
                case "aspen":
                  if (l) {
                    return 1152;
                  }
                  if (n) {
                    return 848;
                  }
                  return 704;
                case "palm":
                case "willow":
                  return n ? 1024 : 672;
                case "maple":
                  return n ? 2500 : 672;
                case "almond":
                  if (l || n) {
                    return 2500;
                  }
                  return 576;
                case "sequoia":
                  if (l) {
                    return 1152;
                  }
                  if (n) {
                    return 896;
                  }
                  return 600;
                default:
                  return n ? 1152 : 1024;
              }
            })();
            return `(max-width: ${a ? 768 : 1024}px) 100vw, ${d}px`;
          })(),
          { isLivePreview: T, liveImages: E } = (0, s.useContext)(l.K),
          A = (0, s.useMemo)(
            () => (e && "string" == typeof e && T && E.has(e) ? E.get(e) : e),
            [e, T, E],
          ),
          P =
            N?.type === "pixel" && C?.type === "pixel"
              ? `${N.value} / ${C.value}`
              : S?.type === "pixel" && O?.type === "pixel"
                ? `${S.value} / ${O.value}`
                : void 0;
        return (0, a.jsx)(i.T, {
          noZoom: h,
          zoomImg: { src: A, srcSet: "" },
          children:
            A && "string" == typeof A && "true" === f && (N || C)
              ? (0, a.jsx)("picture", {
                  className: "contents",
                  children: (0, a.jsx)(n._, {
                    ...w,
                    src: A,
                    alt: t,
                    className: (0, d.cn)("object-contain", u, r),
                    priority: !!m || void 0,
                    ...(N ? { width: N.value } : {}),
                    ...(C ? { height: C.value } : {}),
                    decoding: "async",
                    sizes: $,
                    srcSet: k,
                    "data-optimize": f,
                    style: { ...(P ? { aspectRatio: P } : {}), ...j },
                  }),
                })
              : (0, a.jsx)("img", {
                  ...w,
                  src: A,
                  alt: t,
                  className: (0, d.cn)(u, r),
                  srcSet: k,
                  style: j,
                  width: x,
                  height: g,
                  "data-optimize": f,
                }),
        });
      }
    },
    97870: (e, t, r) => {
      "use strict";
      r.d(t, { TabSyncContextProvider: () => d, Y: () => p });
      var a = r(54568),
        n = r(7620),
        s = r(49359),
        i = r(4211);
      let o = () =>
          (0, s.y)((e) => ({
            selectedLabel: void 0,
            setSelectedLabel: (t) => e({ selectedLabel: t }),
          })),
        l = (0, n.createContext)(null);
      function d({ children: e }) {
        let t = (0, n.useRef)(null);
        return (
          t.current || (t.current = o()), (0, a.jsx)(l.Provider, { value: t.current, children: e })
        );
      }
      let c = o();
      function p(e, t = !0) {
        let r = (0, n.useContext)(l) ?? c,
          a = (0, i.P)(r, (e) => (t ? e.selectedLabel : void 0)),
          s = (0, i.P)(r, (e) => e.setSelectedLabel),
          o = (0, n.useCallback)(
            (e) => {
              t && s(e);
            },
            [t, s],
          );
        return { matchingIndex: t && a ? e.findIndex((e) => e === a) : -1, setSelectedLabel: o };
      }
    },
    99424: (e, t, r) => {
      "use strict";
      r.d(t, { tn: () => n, to: () => a });
      let a = "mintlify-server-variables",
        n = () => {
          let e = localStorage.getItem(a);
          if (e) {
            try {
              let t = JSON.parse(e);
              if (
                ((e) =>
                  "object" == typeof e &&
                  null != e &&
                  Object.values(e).every(
                    (e) =>
                      "object" == typeof e &&
                      null !== e &&
                      Object.values(e).every((e) => "string" == typeof e),
                  ))(t)
              )
                return t;
            } catch (e) {
              console.log(`unable to parse stored server variables: ${e}`);
            }
          }
          return {};
        };
    },
  },
]);
