"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [18697],
  {
    2811: (e, a, i) => {
      i.d(a, { y: () => t });
      let t = (e) => e.hasOwnProperty("href") && e.hasOwnProperty("title");
    },
    5693: (e, a, i) => {
      function t(e) {
        return "string" == typeof e;
      }
      function r(e) {
        let a = Number(e);
        return "number" == typeof a && !isNaN(a);
      }
      function o(e) {
        let a = Number(e);
        return "number" == typeof a && !isNaN(a) && a % 1 == 0;
      }
      function n(e) {
        return !!e && "object" == typeof e && !Array.isArray(e);
      }
      function s(e) {
        return !!e && "object" == typeof e && Array.isArray(e);
      }
      function p(e) {
        return "boolean" == typeof e;
      }
      function d(e) {
        return null === e;
      }
      function l(e) {
        return e instanceof File;
      }
      i.d(a, {
        Et: () => r,
        Fq: () => o,
        Gv: () => n,
        Kg: () => t,
        Lm: () => p,
        cy: () => s,
        fo: () => l,
        kZ: () => d,
      });
    },
    7844: (e, a, i) => {
      i.d(a, { h: () => o });
      var t = i(72179),
        r = i(29917);
      function o({
        id: e,
        shouldReturnEarly: a,
        element: i,
        getElement: n,
        checkIfShouldScroll: s,
        preScrollCallback: p,
        postScrollCallback: d,
      } = {}) {
        if (a) {
          return;
        }
        let l = window.location.hash.substring(1);
        if (!l && !e) {
          return;
        }
        let c = i ?? n?.(e ?? l) ?? document.getElementById(e ?? l);
        c &&
          (s?.(c, l) ?? !0) &&
          (p?.(c),
          requestAnimationFrame(() => {
            if (
              (function () {
                if ("true" === new URLSearchParams(window.location.search).get(t.ax)) {
                  return !0;
                }
                try {
                  return "true" === (0, r.Gq)(t.nY);
                } catch {
                  return !1;
                }
              })()
            ) {
              let e = c.getBoundingClientRect(),
                a = (function () {
                  let e = getComputedStyle(document.documentElement).getPropertyValue(
                      "--scroll-mt",
                    ),
                    a = e.match(/[\d.]+/);
                  if (!a) {
                    return 0;
                  }
                  let i = parseFloat(a[0]);
                  return e.includes("rem") ? 16 * i : i;
                })(),
                i = window.scrollY + e.top - a;
              window.scrollTo({ top: i, behavior: "instant" });
            } else {
              c.scrollIntoView();
            }
            d?.();
          }));
      }
    },
    9537: (e, a, i) => {
      i.d(a, { A: () => p, o: () => s });
      var t = i(27277),
        r = i(15214),
        o = i(90280),
        n = i(98167);
      let s = "mintlify-pkce-code-verifier";
      async function p(e) {
        let { code_challenge: a, code_verifier: i } = await (0, r.Ay)(),
          p = new URL(e.authorizationUrl);
        (p.searchParams.append("response_type", "code"),
          p.searchParams.append("client_id", e.clientId),
          p.searchParams.append("redirect_uri", window.location.origin + n.c.BASE_PATH + o.AX),
          e.scopes.length && p.searchParams.append("scope", e.scopes.join(" ")),
          p.searchParams.append("code_challenge", a),
          p.searchParams.append("code_challenge_method", "S256"));
        let d = new Date(Date.now() + 10 * o.Az);
        (t.A.set(s, i, { secure: !0, expires: d }), (window.location.href = p.href));
      }
    },
    10897: (e, a, i) => {
      i.d(a, {
        Eo: () => c,
        JT: () => g,
        N9: () => o,
        Ob: () => s,
        _x: () => d,
        ab: () => p,
        uu: () => u,
      });
      var t = i(62969),
        r = i(55317);
      let o = (e) => {
          try {
            let a = (0, r.A)(e);
            return `${a.red} ${a.green} ${a.blue}`;
          } catch (e) {
            return "0 0 0";
          }
        },
        n = (e) => `${e.r} ${e.g} ${e.b}`,
        s = (e) =>
          `#${e.r.toString(16).padStart(2, "0")}${e.g.toString(16).padStart(2, "0")}${e.b.toString(16).padStart(2, "0")}`,
        p = (e, a, i) => {
          if (a) {
            return i ? a : o(a);
          }
          let t = d("#09090b", 1, e, 0.02);
          return i ? s(t) : n(t);
        },
        d = (e, a, i, o) => {
          let n = (0, r.A)(e),
            s = (0, r.A)(i);
          return (0, t.qb)(
            { r: n.red, g: n.green, b: n.blue, a: a },
            { r: s.red, g: s.green, b: s.blue, a: o },
          );
        },
        l = (e, a) => {
          let i = (0, r.A)(a);
          return n(
            (0, t.qb)(
              { r: e.red, g: e.green, b: e.blue, a: 0.6 },
              { r: i.red, g: i.green, b: i.blue, a: 0.95 },
            ),
          );
        },
        c = (e) => {
          let a = {
              50: "#fafafa",
              100: "#f5f5f5",
              200: "#e5e5e5",
              300: "#d4d4d4",
              400: "#a3a3a3",
              500: "#737373",
              600: "#525252",
              700: "#404040",
              800: "#262626",
              900: "#171717",
              950: "#0a0a0a",
            },
            i = (0, r.A)(e);
          return {
            50: l(i, a[50]),
            100: l(i, a[100]),
            200: l(i, a[200]),
            300: l(i, a[300]),
            400: l(i, a[400]),
            500: l(i, a[500]),
            600: l(i, a[600]),
            700: l(i, a[700]),
            800: l(i, a[800]),
            900: l(i, a[900]),
            950: l(i, a[950]),
          };
        },
        u = (e) => e.split(" ").join(", ");
      function g(e) {
        var a, i, t, r, n, l, c, u, g, m, h, f, v;
        let y = (null == e ? void 0 : e.colors.primary) || "#16A34A",
          k = null != (a = null == e ? void 0 : e.colors.light) ? a : "#4ADE80";
        (null == e ? void 0 : e.theme) === "linden" &&
          (e.background = Object.assign(Object.assign({}, e.background), {
            color: {
              light:
                (null == (t = null == (i = e.background) ? void 0 : i.color) ? void 0 : t.light) ||
                s(d("#FFFFFF", 1, y, 0.03)),
              dark:
                (null == (n = null == (r = e.background) ? void 0 : r.color) ? void 0 : n.dark) ||
                s(d("#09090B", 1, k, 0.03)),
            },
          }));
        let C =
            null !=
            (u =
              null == (c = null == (l = null == e ? void 0 : e.background) ? void 0 : l.color)
                ? void 0
                : c.light)
              ? u
              : "#ffffff",
          b = o(C),
          P = p(
            k,
            null == (m = null == (g = null == e ? void 0 : e.background) ? void 0 : g.color)
              ? void 0
              : m.dark,
          );
        return {
          light: b,
          dark: P,
          lightHex: C,
          darkHex: p(
            k,
            null == (f = null == (h = null == e ? void 0 : e.background) ? void 0 : h.color)
              ? void 0
              : f.dark,
            !0,
          ),
          background: null == (v = null == e ? void 0 : e.thumbnails) ? void 0 : v.background,
        };
      }
    },
    16816: (e, a, i) => {
      let t, r, o;
      i.d(a, {
        G4: () => C,
        lu: () =>
          function e(a) {
            let s, p;
            if (!a.codeString || void 0 !== o) {
              return;
            }
            if (void 0 === r) {
              if (a.opts?.noAsync || y) {
                return;
              }
              return k.then(() => e(a)).catch(() => void 0);
            }
            if (!b) {
              if (a.opts?.noAsync) {
                return;
              }
              return P()
                .then(() => e(a))
                .catch(() => void 0);
            }
            if ("language" in a) {
              if ("text" === a.language) {
                return;
              }
              s = a.language;
            } else {
              if ("lang-text" === a.className) {
                return;
              }
              s = C(a.className, a.fileName);
            }
            if (a.codeString.length > 5 * c.S5) {
              return;
            }
            if (a.codeString.length > c.S5) {
              if (a.opts?.noAsync === !0) {
                return;
              }
              try {
                let e = (function () {
                  if ("undefined" == typeof Worker) {
                    return;
                  }
                  if (t) {
                    return t;
                  }
                  let e = new Worker(i.tu(new URL(i.p + i.u(56486), i.b)), { type: void 0 });
                  return (t = (0, m.LV)(e));
                })();
                return void 0 == e ? void 0 : e.highlight(a);
              } catch {
                return;
              }
            }
            if (s) {
              try {
                let e =
                    a.opts?.highlightedLines?.length || a.opts?.focusedLines?.length
                      ? "codeToHast"
                      : "codeToHtml",
                  i = a.codeString.trim(),
                  t = (0, n.lb)(a.codeBlockTheme);
                p = r[e](i, {
                  lang: (function (e) {
                    let a = "text";
                    if (void 0 === e) return a;
                    let i = Number(e);
                    if (!isNaN(i) && i > 99 && i < 600) return "json";
                    let t = e.toLowerCase(),
                      r = (0, u.gC)(t);
                    return g.shikiLangMap[r] ?? g.shikiLangMap[t] ?? a;
                  })(s),
                  ...t,
                  colorReplacements: { ...g.shikiColorReplacements },
                  transformers: f,
                  tabindex: !1,
                  ...a.opts,
                });
              } catch {}
            }
            if ("object" != typeof p) {
              return p;
            }
            let l = p.children[0];
            if (l) {
              return (
                "element" === l.type &&
                  "pre" === l.tagName &&
                  l.children[0].children
                    .filter((e) => "element" === e.type && "span" === e.tagName)
                    .forEach((e, i) => {
                      let t = i + 1;
                      "string" == typeof e.properties.class
                        ? (a.opts?.highlightedLines?.includes(t) &&
                            (e.properties.class += ` ${g.LINE_HIGHLIGHT_CLASS_NAME}`),
                          a.opts?.focusedLines?.includes(t) &&
                            (e.properties.class += ` ${g.LINE_FOCUS_CLASS_NAME}`))
                        : Array.isArray(e.properties.class) &&
                          (a.opts?.highlightedLines?.includes(t) &&
                            e.properties.class.push(g.LINE_HIGHLIGHT_CLASS_NAME),
                          a.opts?.focusedLines?.includes(t) &&
                            e.properties.class.push(g.LINE_FOCUS_CLASS_NAME));
                    }),
                (0, d.jx)(p)
              );
            }
          },
        px: () => P,
      });
      var n = i(56452),
        s = i(71636),
        p = i(57562),
        d = i(14987),
        l = i(69528),
        c = i(90280),
        u = i(54923),
        g = i(65904),
        m = i(98160);
      let h = { matchAlgorithm: "v3" },
        f = [
          (0, s.transformerMetaHighlight)({ className: g.LINE_HIGHLIGHT_CLASS_NAME }),
          (0, s.transformerNotationHighlight)({
            ...h,
            classActiveLine: g.LINE_HIGHLIGHT_CLASS_NAME,
          }),
          (0, s.transformerNotationFocus)({ ...h, classActiveLine: g.LINE_FOCUS_CLASS_NAME }),
          (0, s.transformerNotationDiff)({
            ...h,
            classLineAdd: g.LINE_DIFF_ADD_CLASS_NAME,
            classLineRemove: g.LINE_DIFF_REMOVE_CLASS_NAME,
          }),
        ],
        v = (0, l.l)({ forgiving: !0, cache: new Map() }),
        y = !1,
        k = (0, p.O_)({ themes: [], langs: g.LANGS, engine: v })
          .then((e) => {
            r = e;
          })
          .catch((e) => {
            (console.error(e), (o = e ?? Error("Unknown error occurred initializing highlighter")));
          })
          .finally(() => {
            y = !0;
          });
      function C(e, a) {
        let i = /language-(\w+)/.exec(e ?? "");
        return i ? (i[1] ?? "text") : (a ?? "text");
      }
      let b = !1;
      async function P(e, a) {
        if ((await k, (b && !a) || !r)) {
          return;
        }
        if ("string" == typeof e || !e) {
          ("system" !== e && e
            ? await r.loadTheme("dark-plus")
            : await r.loadTheme("dark-plus", "github-light-default"),
            (b = !0));
          return;
        }
        let { theme: i } = e;
        ("string" == typeof i && "css-variables" !== i
          ? await r.loadTheme(i)
          : "object" == typeof i &&
            ("css-variables" !== i.dark && "css-variables" !== i.light
              ? await r.loadTheme(i.dark, i.light)
              : "css-variables" !== i.dark
                ? await r.loadTheme(i.dark)
                : "css-variables" !== i.light && (await r.loadTheme(i.light))),
          (b = !0));
      }
    },
    16903: (e, a, i) => {
      i.d(a, {
        Ls: () => V,
        gY: () => w,
        lq: () => L,
        EG: () => T,
        vN: () => x,
        FJ: () => N,
        fo: () => D,
        cY: () => O,
        zP: () => U,
        HA: () => f,
        v9: () => A,
        tO: () => P,
        ib: () => q,
        pI: () => I,
        b9: () => S,
        vt: () => y,
        PY: () => j,
        z5: () => F,
        B2: () => g,
        DZ: () => m,
        Zt: () => B,
        FS: () => l,
        GG: () => v,
        TU: () => C,
        Rr: () => h,
        Fy: () => u,
        z4: () => k,
        eV: () => M,
        F4: () => b,
        Df: () => E,
      });
      var t = i(5693),
        r = i(59676),
        o = i(37914);
      let n = ({ schema: e, example: a }) =>
        (function e(a, i, t, r = []) {
          let o = {};
          if (null == i) {
            return o;
          }
          if (a.oneOf && Array.isArray(a.oneOf)) {
            let n = null;
            for (let e of a.oneOf) {
              if (
                u(e) &&
                (function e(a, i) {
                  let t = typeof i;
                  if (a.oneOf && Array.isArray(a.oneOf))
                    return a.oneOf.some((a) => !!u(a) && e(a, i));
                  if (a.enum && Array.isArray(a.enum)) return a.enum.includes(i);
                  if ("string" === a.type && "string" === t && a.pattern && "string" == typeof i)
                    try {
                      return new RegExp(a.pattern).test(i);
                    } catch {
                      return !1;
                    }
                  if ("object" === a.type && "object" === t && null !== i && !Array.isArray(i)) {
                    if (a.properties && "object" == typeof a.properties) {
                      let t = Object.keys(i),
                        r = Object.keys(a.properties);
                      if (
                        a.required &&
                        Array.isArray(a.required) &&
                        a.required.some((e) => "string" == typeof e && !t.includes(e))
                      )
                        return !1;
                      for (let o of t)
                        if (r.includes(o)) {
                          let t = a.properties[o],
                            r = i[o];
                          if (
                            u(t) &&
                            !(function a(i, t) {
                              if (i.enum && Array.isArray(i.enum)) return i.enum.includes(t);
                              if (i.oneOf && Array.isArray(i.oneOf))
                                return i.oneOf.some((a) => !!u(a) && e(a, t));
                              let r = typeof t;
                              if (
                                ("string" === i.type && "string" !== r) ||
                                ("number" === i.type && "number" !== r) ||
                                ("integer" === i.type &&
                                  ("number" !== r || !Number.isInteger(t))) ||
                                ("boolean" === i.type && "boolean" !== r) ||
                                ("array" === i.type && !Array.isArray(t)) ||
                                ("object" === i.type &&
                                  ("object" !== r || null === t || Array.isArray(t)))
                              )
                                return !1;
                              if ("array" === i.type && Array.isArray(t) && u(i.items)) {
                                for (let a of t) if (!e(i.items, a)) return !1;
                              }
                              if (
                                "object" === i.type &&
                                null !== t &&
                                "object" == typeof t &&
                                !Array.isArray(t) &&
                                i.properties
                              ) {
                                for (let [e, r] of Object.entries(i.properties))
                                  if (e in t && u(r) && !a(r, t[e])) return !1;
                              }
                              return !0;
                            })(t, r)
                          )
                            return !1;
                        }
                      if (t.length > 0 && r.length > 0) return t.some((e) => r.includes(e));
                      if (0 === t.length)
                        return !(a.required && Array.isArray(a.required) && a.required.length > 0);
                    }
                    return !0;
                  }
                  return !!(
                    ("string" === a.type && "string" === t) ||
                    ("number" === a.type && "number" === t) ||
                    ("integer" === a.type && "number" === t && Number.isInteger(i)) ||
                    ("boolean" === a.type && "boolean" === t) ||
                    ("array" === a.type && Array.isArray(i))
                  );
                })(e, i)
              ) {
                let a = (function (e, a) {
                  if (
                    "object" === e.type &&
                    "object" == typeof a &&
                    null !== a &&
                    !Array.isArray(a) &&
                    e.properties &&
                    "object" == typeof e.properties
                  ) {
                    let i = Object.keys(a),
                      t = Object.keys(e.properties);
                    return i.filter((e) => t.includes(e)).length;
                  }
                  return 1;
                })(e, i);
                (null === n || a > n.matchCount) && (n = { variant: e, matchCount: a });
              }
            }
            let p = n?.variant ?? (a.oneOf.length > 0 && u(a.oneOf[0]) ? a.oneOf[0] : null);
            if (p) {
              if ("object" !== p.type && "array" !== p.type) {
                if (p.uniqueKey) {
                  let e = s(p.uniqueKey, r);
                  o[`${t}.${e}`] = i;
                }
                return o;
              }
              return e(p, i, t, r);
            }
          }
          if ("object" === a.type && a.properties && "object" == typeof i && !Array.isArray(i)) {
            for (let [n, p] of Object.entries(a.properties)) {
              if (!u(p)) continue;
              let a = i[n];
              if (void 0 !== a) {
                if ("object" === p.type || "array" === p.type || p.oneOf)
                  Object.assign(o, e(p, a, t, r));
                else if (p.uniqueKey) {
                  let e = s(p.uniqueKey, r);
                  o[`${t}.${e}`] = a;
                }
              }
            }
          }
          if ("array" === a.type && Array.isArray(i) && "items" in a && u(a.items)) {
            let n = a.items;
            i.forEach((a, i) => {
              Object.assign(o, e(n, a, t, [...r, i]));
            });
          }
          if (
            !a.properties &&
            !a.oneOf &&
            "array" !== a.type &&
            "object" !== a.type &&
            a.uniqueKey
          ) {
            let e = s(a.uniqueKey, r);
            o[`${t}.${e}`] = i;
          }
          return o;
        })(e, a, o.gw.body);
      function s(e, a) {
        let i = e;
        return (
          a.forEach((e) => {
            i = i.replace("[INDEX]", e.toString());
          }),
          i
        );
      }
      var p = i(54548),
        d = i(60996).Buffer;
      function l(e) {
        return "object" == typeof e && null !== e && o.aZ in e && "string" == typeof e[o.aZ];
      }
      let c = (e) => "object" == typeof e && null !== e && !Array.isArray(e),
        u = (e) =>
          !!c(e) &&
          ("type" in e ||
            "properties" in e ||
            "oneOf" in e ||
            "anyOf" in e ||
            "allOf" in e ||
            "items" in e ||
            "additionalProperties" in e ||
            "enum" in e ||
            "const" in e ||
            "format" in e ||
            "pattern" in e ||
            "minimum" in e ||
            "maximum" in e ||
            "minLength" in e ||
            "maxLength" in e ||
            "minItems" in e ||
            "maxItems" in e ||
            "minProperties" in e ||
            "maxProperties" in e ||
            "required" in e ||
            "nullable" in e ||
            "description" in e),
        g = (e) =>
          !!u(e) &&
          ((!!e.properties && Object.keys(e.properties).length > 0) ||
            (!!e.additionalProperties && Object.keys(e.additionalProperties).length > 0)),
        m = (e) => u(e) && "array" === e.type,
        h = (e) => m(e) && u(e.items) && "object" === e.items.type,
        f = (e) => {
          if (e.oneOf) {
            return "oneOf";
          }
          if (e.enum) {
            switch (e.type) {
              case "string":
                return "enum<string>";
              case "number":
                return "enum<number>";
              case "integer":
                return "enum<integer>";
              default:
                return e.type;
            }
          }
          return e.format && o.Ao.includes(e.format) ? "file" : e.type;
        },
        v = (e) => "enum" in e && void 0 !== e.enum,
        y = (e) =>
          "placeholder" in e && "string" == typeof e.placeholder ? e.placeholder : void 0,
        k = (e) => "string" === e.type,
        C = (e) => "number" === e.type || "integer" === e.type,
        b = (e) => {
          let a = {};
          return (
            Object.entries(e.operation?.responses ?? {}).forEach(([i, t]) => {
              let r = e.dependencies?.responses?.[t];
              r && r.content && (a[i] = r.content);
            }),
            a
          );
        },
        P = (e) => {
          let a = e.dependencies?.requestBody?.content;
          if (void 0 === a) {
            return [];
          }
          let i = Object.keys(a)[0];
          if (!i) {
            return [];
          }
          let t = a[i],
            r = t?.schema;
          if (!u(r)) {
            return [];
          }
          let o = Object.values(t?.examples ?? {});
          if (0 === o.length) {
            return [];
          }
          let s = [];
          for (let e of o) {
            if ("value" in e) {
              let a = n({ schema: r, example: e.value });
              s.push(a);
            }
          }
          return s;
        },
        A = (e) => {
          let a = e.dependencies?.parameters;
          if (a) {
            let e = Object.values(a),
              i = e.filter((e) => !("in" in e) || "header" === e.in),
              t = e.filter((e) => "cookie" === e.in);
            return {
              header: i,
              path: e.filter((e) => "path" === e.in),
              query: e.filter((e) => "query" === e.in),
              cookie: t,
            };
          }
          return { header: [], path: [], query: [], cookie: [] };
        },
        S = (e) => {
          let a;
          if (e) {
            return (
              "object" == typeof e && "default" in e && (a = e.default),
              "object" == typeof e && "x-default" in e && (a = e["x-default"]),
              a
            );
          }
        },
        w = () => ({
          oneOf: [
            { type: "string" },
            { type: "number" },
            { type: "boolean" },
            { type: "object", properties: {} },
            {
              type: "array",
              items: {
                oneOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "object", properties: {} },
                  { type: "array", items: {} },
                  { type: "null" },
                ],
              },
            },
            { type: "null" },
          ],
        }),
        I = (e, a) => {
          let i = e.dependencies?.requestBody?.content;
          if (void 0 !== i) {
            return Object.keys(i)[a];
          }
        },
        T = (e) => e.replace(/\./g, "\\."),
        M = (e) => {
          switch (e) {
            case "header":
            default:
              return o.gw.header;
            case "path":
              return o.gw.path;
            case "query":
              return o.gw.query;
            case "cookie":
              return o.gw.cookie;
          }
        },
        E = (e) => {
          let a = { server: {}, header: {}, path: {}, query: {}, cookie: {}, body: void 0 };
          return (
            Object.entries(e).forEach(([e, i]) => {
              if (null == i) {
                return;
              }
              let t = e.split(/(?<!\\)\./).map((e) => e.replace(/\\\./g, "."));
              if (t.length < 2) {
                "body" === e && (a.body = i);
                return;
              }
              let [r, ...n] = t,
                s = Object.values(o.gw);
              r &&
                s.includes(r) &&
                (r !== o.gw.body
                  ? z(a[r], [...n], i)
                  : 0 == [...n].length
                    ? (a.body = i)
                    : ((void 0 === a.body || "object" != typeof a.body) && (a.body = {}),
                      z(a.body, n, i)));
            }),
            R(a)
          );
        },
        R = (e) => {
          if (null == e || (0, t.fo)(e) || e instanceof FileList) {
            return e;
          }
          if (Array.isArray(e)) {
            return e.map(R);
          }
          if (c(e)) {
            if (
              ((e) => {
                if (!c(e)) {
                  return !1;
                }
                let a = Object.keys(e);
                return 0 !== a.length && a.every((e) => null !== (0, p.gz)(e));
              })(e)
            ) {
              let a = [];
              for (let [i, t] of Object.entries(e)) {
                let e = (0, p.gz)(i);
                null !== e && a.push({ index: e, value: R(t) });
              }
              return (a.toSorted((e, a) => e.index - a.index), a.map((e) => e.value));
            }
            if (
              ((e) => {
                if (!c(e)) {
                  return !1;
                }
                let a = Object.keys(e);
                return 0 !== a.length && a.every((e) => /^\d+$/.test(e));
              })(e)
            ) {
              return Object.keys(e)
                .sort((e, a) => Number(e) - Number(a))
                .map((a) => e[a])
                .map(R);
            }
            let a = {};
            for (let [i, t] of Object.entries(e)) {
              a[i] = R(t);
            }
            return a;
          }
          return e;
        },
        z = (e, a, i) => {
          let t = [];
          for (let e = 0; e < a.length; e++) {
            let i = a[e];
            if ("oneOf" === i) {
              e++;
              continue;
            }
            if ("items" === i) {
              let i = a[e + 1];
              if (void 0 !== i && /^\d+$/.test(i)) {
                continue;
              }
            }
            "additionalProperties" !== i && i && t.push(i);
          }
          let r = e;
          for (let e = 0; e < t.length; e++) {
            let a = t[e];
            e === t.length - 1
              ? a && (r[a] = i)
              : (a && (!r[a] || "object" != typeof r[a]) && (r[a] = {}), a && (r = r[a]));
          }
        },
        x = (e) =>
          e.filter((e) => !("enum" in e) || !e.enum || !("const" in e) || e.enum.includes(e.const)),
        O = (e, a = 0) => {
          let i = {};
          if ("uniqueKey" in e && void 0 !== e.uniqueKey) {
            let a = S(e);
            if (void 0 !== a) {
              let t = `${o.gw.body}.${e.uniqueKey}`;
              i[(t = t.replaceAll("[INDEX]", "0"))] = a;
            }
          }
          if ("oneOf" in e && Array.isArray(e.oneOf) && e.oneOf.length > 0) {
            let t = a < e.oneOf.length ? a : 0,
              r = e.oneOf[t];
            u(r) && Object.assign(i, O(r, 0));
          }
          return (
            "object" === e.type &&
              e.properties &&
              Object.values(e.properties).forEach((e) => {
                u(e) && Object.assign(i, O(e, 0));
              }),
            e.additionalProperties &&
              "object" == typeof e.additionalProperties &&
              u(e.additionalProperties) &&
              Object.assign(i, O(e.additionalProperties, 0)),
            i
          );
        },
        j = (e) => {
          let a = "schemes" in e ? e.schemes[0]?.scheme : e.scheme;
          if (!a) {
            return "header.Authorization";
          }
          let i = "in" in a ? a.in : "header",
            t = "name" in a ? a.name : F(a);
          return `${M(i)}.${T(t)}`;
        },
        B = (e) => e && "type" in e && "http" === e.type && "basic" === e.scheme,
        F = (e) => (e && "type" in e && "apiKey" === e.type ? e.name : "Authorization"),
        L = (e, a) => d.from(`${e ?? ""}:${a ?? ""}`).toString("base64"),
        D = (e) => {
          let a = e.typeLabel,
            i = "type" in e && "string" == typeof e.type ? e.type : void 0;
          return a ?? i ?? "unknown";
        },
        N = (e) => {
          if (e.length <= 1) {
            return e.map((e) => D(e));
          }
          let a = e.every((e) => "object" === e.type),
            i = e.map((e) => D(e));
          return a
            ? e.map((e, a) => e.title ?? `Option ${a + 1}`)
            : new Set(i).size === i.length
              ? i
              : i.map((a, i) => (e[i]?.title ?? `Option ${i + 1}`) + " \xb7 " + a);
        },
        V = (e, a, i, t) =>
          (0, r.A)(`${e ? `${e}-` : ""}${i ? `${i}-` : ""}${a || ""}-${t || ""}`, {
            decamelize: !0,
          }),
        q = (e, a) => (e ? `${a ? `${a}` : ""}${e}.` : ""),
        U = (e, a) => (e ? (a ? `${a}${e}][` : `${e}[`) : "");
    },
    17644: (e, a, i) => {
      i.d(a, { FontScript: () => f, H: () => h });
      var t = i(54568),
        r = i(7620),
        o = i(71252);
      let n = { fonts: { body: { family: "Google Sans" }, heading: { family: "Google Sans" } } },
        s = { fonts: { body: { family: "Geist Mono" }, heading: { family: "Geist Mono" } } },
        p = { title: "font-semibold", headings: "font-semibold" },
        d = { headings: "font-medium" };
      var l = i(20533),
        c = i(90280);
      function u({ font: e, subdomain: a }) {
        if (!e) {
          return null;
        }
        if (e.source) {
          let i = (function (e, a) {
              let i = e.startsWith("fonts/"),
                t = e.startsWith("http://") || e.startsWith("https://");
              return i
                ? `/${e}`
                : t
                  ? e
                  : a
                    ? ((e, a, i = {}) => {
                        if (a.startsWith("http://") || a.startsWith("https://")) {
                          return a;
                        }
                        let t = l.join(e, a),
                          r = new URL(
                            ((e = {}) =>
                              `https://${e.bucketName ? e.bucketName : "mintlify"}.s3.${e.region ? e.region : "us-west-1"}.amazonaws.com`)(
                              i,
                            ),
                          );
                        return new URL(t, r).toString();
                      })(a, e)
                    : `/${e}`;
            })(e.source, a),
            r = (function (e) {
              switch (e?.toLowerCase()) {
                case "woff":
                  return "font/woff";
                case "truetype":
                case "ttf":
                  return "font/ttf";
                case "opentype":
                case "otf":
                  return "font/otf";
                default:
                  return "font/woff2";
              }
            })(e.format);
          return (0, t.jsxs)(t.Fragment, {
            children: [
              (0, t.jsx)("link", {
                rel: "preload",
                href: i,
                as: "font",
                type: r,
                crossOrigin: "anonymous",
              }),
              (0, t.jsx)("style", {
                children: `@font-face {
  font-family: '${e.family}';
  src: url('${i}') format('${e.format}');
  font-weight: ${e.weight};
  font-display: swap;
}`,
              }),
            ],
          });
        }
        let i = (e.weight ?? "400;500;600;700;800").toString().split(";"),
          r = [...i.map((e) => `0,${e}`), ...i.map((e) => `1,${e}`)].join(";");
        return (0, t.jsxs)(t.Fragment, {
          children: [
            (0, t.jsx)("link", { rel: "preconnect", href: "https://fonts.googleapis.com" }),
            (0, t.jsx)("link", {
              rel: "preconnect",
              href: "https://fonts.gstatic.com",
              crossOrigin: "anonymous",
            }),
            (0, t.jsx)("link", {
              href: `https://fonts.googleapis.com/css2?family=${e.family.replace(/\s+/g, "+")}:ital,wght@${r}&display=swap`,
              rel: "stylesheet",
            }),
          ],
        });
      }
      function g({ heading: e, body: a }) {
        return (0, t.jsx)("style", {
          children: `:root {
  ${e?.family ? `--font-family-headings-custom: "${e.family}", ${c.zl};` : ""}
  ${e?.weight ? `--font-weight-headings-custom: ${e.weight};` : ""}
  ${a?.family ? `--font-family-body-custom: "${a.family}", ${c.zl};` : ""}
  ${a?.weight ? `--font-weight-body-custom: ${a.weight};` : ""}
}`,
        });
      }
      var m = i(79627);
      function h(e) {
        return "maple" === e
          ? p
          : "linden" === e
            ? s
            : "almond" === e
              ? n
              : "sequoia" === e
                ? d
                : {};
      }
      function f({ theme: e, fonts: a, subdomain: i }) {
        let {
            isLivePreview: n,
            getDocsConfigOverrides: s,
            livePreviewUpdateId: p,
          } = (0, r.useContext)(o.K),
          d = s(),
          l = d?.theme,
          c = h(n && l ? l : e).fonts,
          f = d?.fonts;
        if (!a && !c && !f) {
          return null;
        }
        let v = n && f ? f : (a ?? c),
          y = (0, m.W)(v, "heading"),
          k = (0, m.W)(v, "body");
        return (0, t.jsxs)(
          r.Fragment,
          {
            children: [
              (0, t.jsx)(u, { font: y, subdomain: i }),
              (0, t.jsx)(u, { font: k, subdomain: i }),
              (0, t.jsx)(g, { heading: y, body: k }),
            ],
          },
          p,
        );
      }
    },
    18423: (e, a, i) => {
      i.d(a, { f: () => t });
      function t(e) {
        return !e || e.endsWith("/") ? e.slice(0, -1) : e;
      }
    },
    22459: (e) => {
      let a = ["-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "system-ui", "sans-serif"];
      e.exports = { SYSTEM_FONT_FALLBACK_ARRAY: a, SYSTEM_FONT_FALLBACK_STRING: a.join(", ") };
    },
    22652: (e, a, i) => {
      i.d(a, { Gb: () => s, ZZ: () => n, pY: () => o });
      var t = i(59676),
        r = i(16903);
      let o = (e, a = "") => {
          if (!(0, r.Fy)(e)) {
            return e;
          }
          let i = { ...e, uniqueKey: a };
          if (
            (i.oneOf &&
              Array.isArray(i.oneOf) &&
              (i.oneOf = i.oneOf.map((e, i) =>
                (0, r.Fy)(e) ? o(e, a ? `${a}.oneOf.${i}` : `oneOf.${i}`) : e,
              )),
            "object" === i.type && i.properties)
          ) {
            let e = {};
            (Object.entries(i.properties).forEach(([i, t]) => {
              if ((0, r.Fy)(t)) {
                let n = a ? `${a}.${(0, r.EG)(i)}` : (0, r.EG)(i);
                e[i] = o(t, n);
              } else {
                e[i] = t;
              }
            }),
              (i.properties = e));
          }
          if (
            i.additionalProperties &&
            "object" == typeof i.additionalProperties &&
            (0, r.Fy)(i.additionalProperties)
          ) {
            let e = a ? `${a}.additionalProperties` : "additionalProperties";
            i.additionalProperties = o(i.additionalProperties, e);
          }
          if ("array" === i.type && "items" in i && (0, r.Fy)(i.items)) {
            let e = a ? `${a}.items` : "items";
            i.items = o(i.items, e + ".[INDEX]");
          }
          return i;
        },
        n = (e, a, i, t) => {
          if (!a.uniqueKey) {
            return e;
          }
          {
            let o = a.uniqueKey;
            return (
              i?.forEach((e) => {
                o = o.replace("[INDEX]", e.toString());
              }),
              `${e ? e + "." : ""}${o}${void 0 !== t ? "." + (0, r.EG)(t) : ""}`
            );
          }
        },
        s = (e, a, i, o) => {
          if (!e.uniqueKey) {
            return (0, r.Ls)(a, i, o);
          }
          let n = e.uniqueKey.replace(/\[INDEX\]/g, ""),
            s = a ? `${a}-${n}` : n;
          return (0, t.A)(s, { decamelize: !0 });
        };
    },
    27194: (e, a, i) => {
      i.d(a, { G: () => n });
      var t = i(27541),
        r = i(7620),
        o = i(84342);
      function n() {
        let e = (0, t.useParams)()?.slug;
        return (0, r.useMemo)(() => {
          let a =
            "string" == typeof e
              ? decodeURIComponent(e)
              : ((e) => {
                  if (e) {
                    return e.map((e) => decodeURIComponent(e));
                  }
                })(e)?.join("/");
          return (0, o.M)(a ?? "");
        }, [e]);
      }
    },
    28838: (e, a, i) => {
      i.d(a, { O: () => s, Y: () => p });
      var t = i(7620),
        r = i(30793),
        o = i(98167),
        n = i(27194);
      let s = "mintlify-navigation-cache";
      function p(e) {
        let [a, i] = (0, t.useState)(),
          p = (0, n.G)(),
          { buildId: d } = (0, t.useContext)(r.DeploymentMetadataContext),
          [l, c] = (0, t.useState)(!1);
        (0, t.useEffect)(() => {
          i(e);
        }, [e]);
        let u = (0, t.useCallback)(async () => {
          c(!0);
          try {
            c(!0);
            let a = localStorage.getItem(s);
            if (a) {
              let e = JSON.parse(a);
              if (!Array.isArray(e.navigation)) {
                let a = Date.now() - e.timestamp > 9e5,
                  t = e.buildId === d;
                if (!a && t) {
                  (i(e.navigation), c(!1));
                  return;
                }
                localStorage.removeItem(s);
              }
            }
            let t = await fetch(`${o.c.BASE_PATH}/_mintlify/navigation`);
            if (401 === t.status) {
              (i(e), c(!1));
              return;
            }
            let r = (await t.json()).docsDecoratedNav;
            if (!r) {
              (i(e), c(!1));
              return;
            }
            let n = { navigation: r, timestamp: Date.now(), buildId: d ?? "PLACEHOLDER" };
            (localStorage.setItem(s, JSON.stringify(n)), i(r));
          } catch (a) {
            (console.error("Error fetching navigation:", a), i(e));
          } finally {
            c(!1);
          }
        }, [e, p, s]);
        return { navigationData: a, updateCache: u, isUpdatingCache: l };
      }
    },
    29917: (e, a, i) => {
      i.d(a, { Ai: () => d, Gq: () => n, SO: () => p, U9: () => s });
      var t = i(72179);
      function r() {
        try {
          return (window.sessionStorage.getItem("test"), !1);
        } catch {
          return !0;
        }
      }
      function o() {
        return window.location.ancestorOrigins[0] || window.location.origin;
      }
      let n = (e) => (r() ? null : window.sessionStorage.getItem(e)),
        s = async (e) => {
          if (r()) {
            return new Promise((a) => {
              let i = Math.random().toString(36).substring(7),
                r = (e) => {
                  t.ti.includes(e.origin) &&
                    e.data?.type === t.Mp &&
                    e.data?.requestId === i &&
                    (window.removeEventListener("message", r), a(e.data.value));
                };
              (window.addEventListener("message", r),
                setTimeout(() => {
                  (window.removeEventListener("message", r), a(null));
                }, 5e3),
                window.parent.postMessage({ type: t.ec, key: e, requestId: i }, o()));
            });
          }
          return window.sessionStorage.getItem(e);
        },
        p = (e, a) => {
          if (r()) {
            return window.parent.postMessage({ type: t.UD, key: e, value: a }, o());
          }
          window.sessionStorage.setItem(e, a);
        },
        d = (e) => {
          if (r()) {
            return window.parent.postMessage({ type: t.iN, key: e }, o());
          }
          window.sessionStorage.removeItem(e);
        };
    },
    30793: (e, a, i) => {
      (i.r(a),
        i.d(a, {
          ApiReferenceContext: () => U,
          ApiReferenceContext2: () => _,
          ApiReferenceProvider: () => $,
          ApiReferenceProvider2: () => Y,
          AuthContext: () => q,
          AuthProvider: () => W,
          DeploymentMetadataContext: () => N,
          DeploymentMetadataProvider: () => K,
          DocsConfigContext: () => V,
          DocsConfigProvider: () => H,
          PageContext: () => D,
          PageProvider: () => G,
        }));
      var t = i(54568),
        r = i(76075),
        o = i(7620),
        n = i(54923),
        s = i(20388);
      let p = (e) => {
        let a = (e) => {
          let a,
            i = {};
          if (
            ((a =
              "enum<string>" === e.type
                ? "string"
                : "enum<number>" === e.type
                  ? "number"
                  : "enum<integer>" === e.type
                    ? "integer"
                    : "file" === e.type
                      ? "string"
                      : "any" === e.type
                        ? void 0
                        : e.type) && (i.type = a),
            e.title && (i.title = e.title),
            e.description && (i.description = e.description),
            void 0 !== e.default && (i.default = e.default),
            void 0 !== e.example && (i.example = e.example),
            e.deprecated && (i.deprecated = e.deprecated),
            e.readOnly && (i.readOnly = e.readOnly),
            e.writeOnly && (i.writeOnly = e.writeOnly),
            ("enum<string>" === e.type ||
              "enum<number>" === e.type ||
              "enum<integer>" === e.type) &&
              (i.enum = e.enum),
            "string" === e.type)
          ) {
            (e.format && (i.format = e.format),
              e.pattern && (i.pattern = e.pattern),
              e.maxLength && (i.maxLength = e.maxLength),
              e.minLength && (i.minLength = e.minLength),
              "const" in e && void 0 !== e.const && (i.const = e.const));
          } else if ("number" === e.type || "integer" === e.type) {
            (void 0 !== e.minimum && (i.minimum = e.minimum),
              void 0 !== e.maximum && (i.maximum = e.maximum),
              e.multipleOf && (i.multipleOf = e.multipleOf),
              "const" in e && void 0 !== e.const && (i.const = e.const));
          } else if ("array" === e.type) {
            (e.maxItems && (i.maxItems = e.maxItems),
              e.minItems && (i.minItems = e.minItems),
              e.uniqueItems && (i.uniqueItems = e.uniqueItems),
              e.items && (i.items = p(e.items)));
          } else if ("object" === e.type) {
            if (
              (e.maxProperties && (i.maxProperties = e.maxProperties),
              e.minProperties && (i.minProperties = e.minProperties),
              e.properties)
            ) {
              i.properties = {};
              let a = [];
              (Object.entries(e.properties).forEach(([e, t]) => {
                ((i.properties[e] = p(t)), Array.isArray(t) && t[0]?.required && a.push(e));
              }),
                a.length > 0 && (i.required = a));
            }
            void 0 !== e.additionalProperties &&
              ("boolean" == typeof e.additionalProperties
                ? (i.additionalProperties = e.additionalProperties)
                : (i.additionalProperties = p(e.additionalProperties)));
          } else {
            "file" === e.type && (i.format = e.contentEncoding || "binary");
          }
          return i;
        };
        return 1 === e.length ? a(e[0]) : { oneOf: e.map((e) => a(e)) };
      };
      var d = i(37914),
        l = i(54548),
        c = i(16903);
      let u = (e) => {
          let a = e.type;
          if ("string" === e.type && e.format && d.Ao.includes(e.format)) {
            return "file";
          }
          if (Array.isArray(a)) {
            return a[0] ?? "string";
          }
          if (!a) {
            if (e.oneOf && Array.isArray(e.oneOf)) {
              let a = e.oneOf
                .map((e) => ((0, c.Fy)(e) && "typeLabel" in e ? e.typeLabel : void 0))
                .filter((e) => void 0 !== e);
              if (a.length > 0) {
                let e = new Set(a);
                if (1 === e.size) {
                  let a = Array.from(e)[0];
                  if (a) {
                    return a;
                  }
                }
                let i = e.size === a.length ? " | " : " \xb7 ";
                return a.join(i);
              }
            }
            return "any";
          }
          switch (a) {
            case "null":
              return "null";
            case "object":
              if ((0, l.k$)(e)) {
                if (e.title) {
                  return `${e.title} \xb7 tuple`;
                }
                return "tuple";
              }
              if (e.title) {
                return `${e.title} \xb7 object`;
              }
              return "object";
            case "array":
              if ("items" in e && e.items && (0, c.Fy)(e.items)) {
                let a =
                    "typeLabel" in e.items && "string" == typeof e.items.typeLabel
                      ? e.items.typeLabel
                      : u(e.items),
                  i = a.includes(" | ") ? `(${a})` : a;
                if ("object" === a && e.title) {
                  return `${e.title} \xb7 object[]`;
                }
                return `${i}[]`;
              }
              if (e.title) {
                return `${e.title} \xb7 array`;
              }
              return "array";
            default:
              if ("enum" in e && void 0 !== e.enum) {
                return `enum<${a}>`;
              }
              return "format" in e && "string" == typeof e.format ? `${a}<${e.format}>` : a;
          }
        },
        g = (e) => {
          if (!(0, c.Fy)(e)) {
            return e;
          }
          let a = { ...e };
          if (
            (a.oneOf &&
              Array.isArray(a.oneOf) &&
              (a.oneOf = a.oneOf.map((e) => ((0, c.Fy)(e) ? g(e) : e))),
            "object" === a.type && a.properties)
          ) {
            let e = {};
            (Object.entries(a.properties).forEach(([a, i]) => {
              (0, c.Fy)(i) ? (e[a] = g(i)) : (e[a] = i);
            }),
              (a.properties = e));
          }
          return (
            a.additionalProperties &&
              "object" == typeof a.additionalProperties &&
              (0, c.Fy)(a.additionalProperties) &&
              (a.additionalProperties = g(a.additionalProperties)),
            "array" === a.type && "items" in a && (0, c.Fy)(a.items) && (a.items = g(a.items)),
            (a.typeLabel = u(a)),
            a
          );
        };
      var m = i(22652);
      let h = (e) => {
          if (!(0, c.Fy)(e)) {
            return e;
          }
          if (e.oneOf && Array.isArray(e.oneOf) && e.oneOf.length > 0) {
            return {
              ...e,
              oneOf: e.oneOf
                .map((a) => (e.isRequired ? { ...a, isRequired: !0 } : a))
                .map((e) => ((0, c.Fy)(e) ? h(e) : e)),
            };
          }
          if (
            ("object" === e.type &&
              e.additionalProperties &&
              (0, c.Fy)(e.additionalProperties) &&
              (e.additionalProperties = h(e.additionalProperties)),
            "object" === e.type && e.properties)
          ) {
            let a = new Set(Array.isArray(e.required) ? e.required : []),
              i = Object.entries(e.properties)
                .filter((e) => (0, c.Fy)(e[1]))
                .toSorted(([e], [i]) => {
                  let t = a.has(e);
                  return t === a.has(i) ? 0 : t ? -1 : 1;
                }),
              t = {};
            return (
              i.forEach(([e, i]) => {
                let r = a.has(e) ? { ...i, isRequired: !0 } : i,
                  o = (0, c.Fy)(r) ? h(r) : r;
                t[e] = o;
              }),
              { ...e, properties: t }
            );
          }
          return "array" === e.type && (0, c.Fy)(e.items) ? { ...e, items: h(e.items) } : e;
        },
        f = (e) => {
          let a = h(e);
          return g((0, m.pY)(a, ""));
        };
      var v = i(53812);
      let y = new Set(["apiKey", "http", "oauth2"]);
      var k = i(22300),
        C = i.n(k);
      let b = (e) =>
          "x-mint" in e &&
          e["x-mint"] &&
          "object" == typeof e["x-mint"] &&
          "groups" in e["x-mint"] &&
          Array.isArray(e["x-mint"].groups),
        P = (e) =>
          "x-mint" in e &&
          e["x-mint"] &&
          "object" == typeof e["x-mint"] &&
          "groups" in e["x-mint"] &&
          Array.isArray(e["x-mint"].groups)
            ? e["x-mint"].groups
            : [],
        A = (e, a) => {
          let i = { ...e };
          if (i.properties && "object" == typeof i.properties) {
            let e = {};
            for (let [t, r] of Object.entries(i.properties))
              if ((0, c.Fy)(r))
                if (b(r)) {
                  if (P(r).some((e) => a.includes(e))) {
                    let i = A(r, a);
                    i && (e[t] = i);
                  }
                } else {
                  let i = A(r, a);
                  i && (e[t] = i);
                }
              else e[t] = r;
            i.properties = e;
          }
          if ("items" in i && i.items && "object" == typeof i.items && (0, c.Fy)(i.items))
            if (b(i.items))
              if (P(i.items).some((e) => a.includes(e))) {
                let e = A(i.items, a);
                e ? (i.items = e) : delete i.items;
              } else delete i.items;
            else {
              let e = A(i.items, a);
              e ? (i.items = e) : delete i.items;
            }
          if ("oneOf" in i && i.oneOf && Array.isArray(i.oneOf)) {
            let e = [];
            (i.oneOf.forEach((i) => {
              if ((0, c.Fy)(i))
                if (b(i)) {
                  if (P(i).some((e) => a.includes(e))) {
                    let t = A(i, a);
                    t && e.push(t);
                  }
                } else {
                  let t = A(i, a);
                  t && e.push(t);
                }
            }),
              (i.oneOf = e));
          }
          if (
            i.additionalProperties &&
            "object" == typeof i.additionalProperties &&
            (0, c.Fy)(i.additionalProperties)
          ) {
            let e = A(i.additionalProperties, a);
            e ? (i.additionalProperties = e) : delete i.additionalProperties;
          }
          if (b(i)) return P(i).some((e) => a.includes(e)) ? i : void 0;
          if ("x-mint-enum" in i && i.enum) {
            let e = i.enum,
              t = [];
            (Object.entries(i["x-mint-enum"] ?? {}).forEach(([e, i]) => {
              (Array.isArray(i) && i.some((e) => a.includes(e))) || t.push(e);
            }),
              (i.enum = e.filter((e) => !t.includes(e))));
          }
          return ((i.typeLabel = u(i)), i);
        };
      var S = i(90280),
        w = i(72179),
        I = i(71252),
        T = i(76829),
        M = i(84525);
      function E(e) {
        return null !== e && "object" == typeof e && !Array.isArray(e);
      }
      let R = r.J.filter((e) => "menu" !== e).map((e) => (e.endsWith("s") ? e.slice(0, -1) : e));
      function z(e, a) {
        let i = [e];
        for (let e of R) {
          let t = a[e];
          t && i.unshift(`${e}:${t}`);
        }
        return i.join("|");
      }
      function x(e, a) {
        let i = a;
        for (let a of R) a in e && "string" == typeof e[a] && (i = { ...i, [a]: e[a] });
        return i;
      }
      function O(e, a, i) {
        let t = "string" == typeof e ? e : String(e.path || ""),
          r = t.startsWith("/") ? t : "/" + t,
          o = i.get(r),
          n = a.get(r),
          s = o?.title,
          p = o?.sidebarTitle,
          d = {
            href: r,
            title:
              ("string" == typeof s ? s : void 0) ??
              ("string" == typeof p ? p : void 0) ??
              n?.title ??
              (function (e) {
                let a = e.split("/").filter(Boolean);
                return (a[a.length - 1] || "")
                  .replace(/-/g, " ")
                  .replace(/_/g, " ")
                  .replace(/\b\w/g, (e) => e.toUpperCase());
              })(r),
          },
          l = o?.sidebarTitle ?? n?.sidebarTitle;
        "string" == typeof l && (d.sidebarTitle = l);
        let c = o?.description ?? n?.description;
        "string" == typeof c && (d.description = c);
        let u = o?.icon ?? n?.icon;
        for (let e of ("string" == typeof u && (d.icon = u),
        [
          "api",
          "openapi",
          "asyncapi",
          "contentType",
          "authMethod",
          "auth",
          "version",
          "mode",
          "hideFooterPagination",
          "authors",
          "lastUpdatedDate",
          "createdDate",
          "openapi-schema",
          "tag",
          "url",
          "hideApiMarker",
          "noindex",
          "isPublic",
          "public",
          "deprecated",
        ])) {
          let a = o?.[e] ?? n?.[e];
          void 0 !== a && (d[e] = a);
        }
        return d;
      }
      function j(e, a, i, t) {
        return e.map((e) => {
          if ("string" == typeof e) return O(e, a.pageMetadata, i);
          if (E(e)) {
            if ("group" in e) return B(e, a, i, t);
            if ("path" in e) return O(e, a.pageMetadata, i);
          }
          return e;
        });
      }
      function B(e, a, i, t) {
        let r = { ...e },
          o = z("string" == typeof r.group ? r.group : "", t),
          n = ("openapi" in r || "asyncapi" in r) && !("pages" in r && r.pages);
        if ("pages" in r && Array.isArray(r.pages)) r.pages = j(r.pages, a, i, t);
        else if (n) {
          let e = a.groupPages.get(o);
          e && e.length > 0 ? (r.pages = e) : (r.pages = []);
        } else "group" in r && (r.pages = []);
        return (
          "root" in r &&
            r.root &&
            ("string" == typeof r.root
              ? (r.root = O(r.root, a.pageMetadata, i))
              : E(r.root) && (r.root = O(r.root, a.pageMetadata, i))),
          r
        );
      }
      function F(e, a, i, t) {
        return e.map((e) => (E(e) ? B(e, a, i, t) : e));
      }
      var L = i(29917);
      let D = (0, o.createContext)({ pageMetadata: {} }),
        N = (0, o.createContext)({}),
        V = (0, o.createContext)({}),
        q = (0, o.createContext)({}),
        U = (0, o.createContext)({ apiReferenceData: {} }),
        _ = (0, o.createContext)({ apiReferenceData2: {} });
      function G({ value: e, children: a }) {
        let { setPageMetadata: i } = (0, o.useContext)(T.NavigationContext);
        return (
          (0, o.useEffect)(() => {
            i(e.pageMetadata);
          }, [e.pageMetadata, i]),
          (0, t.jsx)(D.Provider, { value: e, children: a })
        );
      }
      function K({ value: e, children: a }) {
        return (0, t.jsx)(N.Provider, { value: e, children: a });
      }
      function H({ value: e, children: a }) {
        let {
            isLivePreview: i,
            livePreviewUpdateId: n,
            getDocsConfigOverrides: s,
            getNavigationOverride: p,
            liveMetadata: d,
          } = (0, o.useContext)(I.K),
          l = (0, o.useMemo)(() => {
            let a, t, o;
            if (!i && !S.HL) return e;
            if (i) ((a = s()), (t = p()));
            else
              try {
                let e = (0, L.Gq)(w.Ug);
                if (e)
                  try {
                    a = JSON.parse(e);
                  } catch {}
              } catch {}
            return ((o = a?.navigation
              ? (function (e, a, i) {
                  let t = (function (e) {
                      let a = new Map(),
                        i = new Map();
                      if (!e) return { pageMetadata: a, groupPages: i };
                      let t = (e, o) => {
                        if (null == e) return;
                        if (Array.isArray(e)) return e.forEach((e) => t(e, o));
                        if (!E(e)) return;
                        if ("href" in e && "string" == typeof e.href) {
                          let { href: i, ...t } = e;
                          a.set(i, t);
                        }
                        if ("group" in e && "string" == typeof e.group) {
                          let a = z(e.group, o);
                          "pages" in e && Array.isArray(e.pages) && i.set(a, e.pages);
                        }
                        let n = x(e, o);
                        for (let a of [...r.J, "groups", "pages"]) {
                          let i = e[a];
                          a in e && Array.isArray(i) && i.forEach((e) => t(e, n));
                        }
                        "root" in e && e.root && "object" == typeof e.root && t(e.root, n);
                      };
                      return (t(e, {}), { pageMetadata: a, groupPages: i });
                    })(a),
                    o = {};
                  "global" in e && e.global && (o.global = e.global);
                  let n = [...r.J, "groups", "pages"],
                    s = {};
                  for (let a of n)
                    if (a in e) {
                      let n = e[a];
                      Array.isArray(n) &&
                        ("pages" === a
                          ? (o[a] = j(n, t, i, s))
                          : "groups" === a
                            ? (o[a] = F(n, t, i, s))
                            : (o[a] = (function e(a, i, t, o) {
                                return a.map((a) => {
                                  if (!E(a)) return a;
                                  let n = { ...a },
                                    s = x(n, o);
                                  for (let a of ("pages" in n &&
                                    Array.isArray(n.pages) &&
                                    (n.pages = j(n.pages, i, t, s)),
                                  "groups" in n &&
                                    Array.isArray(n.groups) &&
                                    (n.groups = F(n.groups, i, t, s)),
                                  r.J)) {
                                    let r = n[a];
                                    a in n && Array.isArray(r) && (n[a] = e(r, i, t, s));
                                  }
                                  return n;
                                });
                              })(n, t, i, s)));
                    }
                  return o;
                })(a.navigation, e.docsNavWithMetadata, d)
              : (function (e, a) {
                  if (!e || 0 === a.size) return e;
                  let i = (e) => {
                    if (null == e) return e;
                    if (Array.isArray(e)) return e.map(i);
                    if ("object" != typeof e) return e;
                    let t = Object.assign({}, e);
                    if ("href" in t && "string" == typeof t.href) {
                      let e = a.get(t.href);
                      e && Object.assign(t, e, { href: t.href });
                    }
                    for (let e of [...r.J, "groups", "pages"])
                      e in t && Array.isArray(t[e]) && (t[e] = t[e].map(i));
                    return t;
                  };
                  return i(e);
                })(t ?? e.docsNavWithMetadata, d)),
            a || o)
              ? {
                  ...e,
                  docsConfig: a ? { ...e.docsConfig, ...a } : e.docsConfig,
                  docsNavWithMetadata: o ?? e.docsNavWithMetadata,
                }
              : e;
          }, [S.HL, i, n, e, s, p, d]);
        return (0, t.jsx)(V.Provider, { value: l, children: a });
      }
      function W({ value: e, children: a }) {
        let { userInfo: i, isFetchingUserInfo: r } = (0, M.P)(e.userAuth);
        return (0, t.jsx)(q.Provider, {
          value: { ...e, userInfo: i, isFetchingUserInfo: r },
          children: a,
        });
      }
      function $({ value: e, children: a }) {
        return (0, t.jsx)(U.Provider, { value: e, children: a });
      }
      function Y({
        pageMetadata: e,
        docsConfig: a,
        mdxExtracts: i,
        apiReferenceData2: r,
        children: d,
      }) {
        let { docsConfig: l } = (0, o.useContext)(V),
          u = (({ pageMetadata: e, apiReferenceData2: a, mdxExtracts: i, docsConfig: t }) => {
            let r = a ?? { operation: void 0 };
            if (!a && i?.endpoint) {
              let {
                dependencies: e,
                parameterUuids: a,
                requestBodyUuid: t,
                responseUuids: o,
              } = ((e) => {
                let a,
                  i,
                  t = {},
                  r = [];
                ["query", "header", "cookie", "path"].forEach((a) => {
                  Object.entries(e.request.parameters[a]).forEach(([e, i]) => {
                    let o = (0, s.A)();
                    r.push(o);
                    let n = "path" === a || !!i.schema[0].required,
                      d = p(i.schema),
                      l = i.schema[0].description,
                      c = f({ ...d, isRequired: n });
                    t[o] = {
                      name: e,
                      in: a,
                      required: n,
                      ...(l && { description: l }),
                      schema: c,
                      ...(i.style && { style: i.style }),
                      ...(void 0 !== i.explode && { explode: i.explode }),
                    };
                  });
                });
                let o = Object.keys(e.request.body);
                if (o.length > 0) {
                  i = (0, s.A)();
                  let t = {};
                  (o.forEach((a) => {
                    let i = e.request.body[a];
                    if (!i) return;
                    let r = { schema: f(p(i.schemaArray)) };
                    if (
                      (i.description && (r.description = i.description),
                      Object.keys(i.examples).length > 0)
                    ) {
                      let e = {};
                      (Object.entries(i.examples).forEach(([a, i]) => {
                        e[a] = {
                          ...(i.summary && { summary: i.summary }),
                          ...(i.description && { description: i.description }),
                          value: i.value,
                        };
                      }),
                        (r.examples = e));
                    }
                    t[a] = r;
                  }),
                    (a = { content: t, required: !0 }));
                }
                let n = {},
                  d = {};
                return (
                  Object.entries(e.response).forEach(([e, a]) => {
                    let i = (0, s.A)();
                    d[e] = i;
                    let t = {};
                    (Object.entries(a).forEach(([e, a]) => {
                      if (!a) return;
                      let i = { schema: f(p(a.schemaArray)) };
                      if (
                        (a.description && (i.description = a.description),
                        Object.keys(a.examples).length > 0)
                      ) {
                        let e = {};
                        (Object.entries(a.examples).forEach(([a, i]) => {
                          e[a] = {
                            ...(i.summary && { summary: i.summary }),
                            ...(i.description && { description: i.description }),
                            value: i.value,
                          };
                        }),
                          (i.examples = e));
                      }
                      t[e] = i;
                    }),
                      (n[i] = { description: `Response ${e}`, content: t }));
                  }),
                  {
                    dependencies: {
                      parameters: Object.keys(t).length > 0 ? t : void 0,
                      requestBody: a,
                      responses: Object.keys(n).length > 0 ? n : void 0,
                      servers: {},
                      security: {},
                      processedSecurityOptions: [],
                      schemas: {},
                    },
                    parameterUuids: r,
                    requestBodyUuid: i,
                    responseUuids: d,
                  }
                );
              })(i.endpoint);
              ((r.dependencies = e),
                (r.operation = ((e, a) => {
                  let i,
                    t = e.servers?.map((e) => e.url) ?? [];
                  1 === t.length && (i = t[0]);
                  let r = {
                    path: e.path,
                    method: e.method,
                    title: e.title ?? "",
                    description: e.description ?? "",
                    type: e.type ?? "path",
                    baseUrl: i,
                    baseUrlOptions: t,
                    deprecated: e.deprecated,
                  };
                  return (
                    a?.parameterUuids &&
                      a.parameterUuids.length > 0 &&
                      (r.parameters = a.parameterUuids),
                    a?.requestBodyUuid && (r.requestBody = a.requestBodyUuid),
                    a?.responseUuids &&
                      Object.keys(a.responseUuids).length > 0 &&
                      (r.responses = a.responseUuids),
                    r
                  );
                })(i.endpoint, { parameterUuids: a, requestBodyUuid: t, responseUuids: o })));
            }
            if (
              (e.description && r.operation && (r.operation.description = e.description),
              !r.operation)
            )
              return r;
            let o = t?.api?.mdx?.server,
              d = t?.api?.mdx?.auth,
              l = r.operation.baseUrl || r.operation.baseUrlOptions.length > 0;
            "string" != typeof o || l
              ? Array.isArray(o) &&
                !l &&
                (o.length > 1 ? (r.operation.baseUrlOptions = o) : (r.operation.baseUrl = o[0]))
              : (r.operation.baseUrl = o);
            let u = Object.values(r.dependencies?.parameters ?? {}).some(
              (e) => "Authorization" === e.name && "header" === e.in,
            );
            if (d && 0 === Object.keys(r.dependencies?.security ?? {}).length) {
              let e = (({ method: e, name: a }) => {
                let i,
                  t = (0, s.A)();
                switch (e) {
                  case "basic":
                    i = {
                      [t]: {
                        Authorization: {
                          type: "http",
                          scheme: "basic",
                          description:
                            "Basic authentication header of the form `Basic <encoded-value>`, where `<encoded-value>` is the base64-encoded string `username:password`.",
                        },
                      },
                    };
                    break;
                  case "bearer":
                    i = {
                      [t]: {
                        Authorization: {
                          type: "http",
                          scheme: "bearer",
                          description:
                            "Bearer authentication header of the form `Bearer <token>`, where `<token>` is your auth token.",
                        },
                      },
                    };
                    break;
                  case "cobo":
                    i = { [t]: { CoboAuth: { type: "apiKey", in: "header", name: "API-SECRET" } } };
                    break;
                  case "key":
                    i = { [t]: { Key: { name: a ?? "Key", type: "apiKey", in: "header" } } };
                }
                return i;
              })({ method: d.method, name: d.name });
              e &&
                !u &&
                (r.dependencies || (r.dependencies = { servers: {}, security: {} }),
                (r.dependencies.security = { ...e }));
            }
            let g = i?.codeExamples?.request,
              m = i?.codeExamples?.response,
              h = t?.api?.examples?.languages?.map(n.mF);
            r.operation.requestExampleLanguages = h;
            let y = t?.api?.examples?.defaults === "required";
            r.operation.requiredOnlyExamples = y;
            let k = t?.api?.examples?.autogenerate !== !1;
            (k || (r.operation.disableCodeSampleGeneration = !0),
              g
                ? ((r.operation.requestExamples = (0, v.NN)(g)),
                  (r.operation.requestExampleType = "mdx"))
                : "webhook" === r.operation.type
                  ? ((r.operation.requestExamples = (0, v.M8)(r, 0)),
                    (r.operation.requestExampleType = "webhook"))
                  : r.operation.codeSamples && r.operation.codeSamples.length > 0
                    ? (r.operation.requestExampleType = "codeSamples")
                    : k && (r.operation.requestExampleType = "generated"),
              m
                ? ((r.operation.responseExamples = (0, v.NN)(m)),
                  (r.operation.responseExampleType = "mdx"))
                : (r.operation.responseExampleType = "generated"));
            let C = r.operation.baseUrl || r.operation.baseUrlOptions.length > 0,
              b = t?.api?.examples?.prefill && C;
            return (
              b &&
                ((r.operation.prefillPlaygroundWithExample = !!b),
                (r.operation.prefillPlaygroundExamples = (0, c.tO)(r))),
              t?.api?.mdx?.auth?.method === "cobo" && (r.operation.isCobo = !0),
              t?.api?.playground?.proxy === !1 && (r.operation.disableProxy = !0),
              r
            );
          })({ apiReferenceData2: r, mdxExtracts: i, docsConfig: l ?? a, pageMetadata: e }),
          g = ((e) => {
            let a = e.dependencies?.security ?? {};
            if (0 === Object.keys(a).length) return [];
            let i = [];
            return (
              Object.entries(a).forEach(([e, a]) => {
                let t = [];
                if (
                  (Object.entries(a).forEach(([e, a]) => {
                    if (y.has(a.type)) {
                      let i = (0, c.z5)(a),
                        r = ((e) => {
                          switch (e.type) {
                            case "apiKey":
                              return {
                                title: e.name,
                                type: "string",
                                description: e.description,
                                isRequired: !0,
                                default: e["x-default"],
                                typeLabel: "string",
                              };
                            case "http":
                              return "basic" === e.scheme
                                ? {
                                    title: "Basic Auth",
                                    type: "object",
                                    description:
                                      e.description ??
                                      "Basic authentication header of the form `Basic <encoded-value>`, where `<encoded-value>` is the base64-encoded string `username:password`.",
                                    isRequired: !0,
                                    properties: {
                                      username: {
                                        type: "string",
                                        uniqueKey: "username",
                                        isRequired: !0,
                                        typeLabel: "string",
                                      },
                                      password: {
                                        type: "string",
                                        uniqueKey: "password",
                                        isRequired: !0,
                                        typeLabel: "string",
                                      },
                                    },
                                    additionalProperties: !1,
                                    default: e["x-default"],
                                  }
                                : {
                                    title: "Bearer Auth",
                                    type: "string",
                                    isRequired: !0,
                                    description:
                                      e.description ??
                                      "Bearer authentication header of the form `Bearer <token>`, where `<token>` is your auth token.",
                                    format: "bearer",
                                    default: e["x-default"],
                                    typeLabel: "string<bearer>",
                                  };
                            case "oauth2":
                              return {
                                title: "OAuth2 Auth",
                                type: "string",
                                isRequired: !0,
                                description:
                                  e.description ??
                                  "The access token received from the authorization server in the OAuth 2.0 flow.",
                                format: "bearer",
                                typeLabel: "string<bearer>",
                              };
                            default:
                              return;
                          }
                        })(a);
                      r && t.push({ scheme: a, schema: r, schemeName: e, name: i });
                    }
                  }),
                  t.length > 0)
                ) {
                  let e = t.map((e) => e.schemeName).join(" & ");
                  i.push({ schemes: t, title: e });
                }
              }),
              i
            );
          })(u);
        g.length > 0 &&
          (u.dependencies ||
            (u.dependencies = { servers: {}, security: {}, processedSecurityOptions: [] }),
          (u.dependencies.processedSecurityOptions = g));
        let { userInfo: m, isFetchingUserInfo: h } = (0, o.useContext)(q);
        m?.apiPlaygroundInputs &&
          u.operation &&
          (u.operation.userInfoPlaygroundInputs = m.apiPlaygroundInputs);
        let k = (0, o.useMemo)(() => {
          let e = h ? [] : (m?.groups ?? []);
          if (u.schemaData) {
            let a = ((e, a) => {
              let i = A(C()(e), a);
              return i || e;
            })(u.schemaData, e);
            return { ...u, schemaData: a };
          }
          return (({ apiReferenceData: e, groups: a }) => {
            let { dependencies: i } = e;
            if (!i) {
              return e;
            }
            let t = C()(i);
            if (
              (t.parameters &&
                Object.keys(t.parameters).length > 0 &&
                Object.entries(t.parameters).forEach(([e, i]) => {
                  if (i.schema && "object" == typeof i.schema && (0, c.Fy)(i.schema)) {
                    let e = A(i.schema, a);
                    e && (i.schema = e);
                  }
                }),
              t.requestBody &&
                Object.keys(t.requestBody.content).length > 0 &&
                Object.entries(t.requestBody.content).forEach(([e, i]) => {
                  if (i.schema) {
                    let r = A(i.schema, a);
                    r && ((i.schema = r), t.requestBody && (t.requestBody.content[e] = i));
                  }
                }),
              t.responses &&
                Object.keys(t.responses).length > 0 &&
                Object.entries(t.responses).forEach(([e, i]) => {
                  i.content &&
                    Object.entries(i.content).forEach(([e, t]) => {
                      if (t.schema) {
                        let r = A(t.schema, a);
                        r && ((t.schema = r), i.content && (i.content[e] = t));
                      }
                    });
                }),
              t.requestBody?.exampleType === "generated" && t.requestBody?.content)
            ) {
              Object.values(t.requestBody.content).forEach((e) => {
                (delete e.examples, delete e.example);
              });
              let { content: e, exampleType: a } = (0, v.MU)(t.requestBody.content);
              ((t.requestBody.content = e), (t.requestBody.exampleType = a));
            }
            return (
              t.responses &&
                Object.values(t.responses).forEach((e) => {
                  if ("generated" === e.exampleType && e.content) {
                    Object.values(e.content).forEach((e) => {
                      (delete e.examples, delete e.example);
                    });
                    let { content: a, exampleType: i } = (0, v.MU)(e.content);
                    ((e.content = a), (e.exampleType = i));
                  }
                }),
              { ...e, dependencies: t }
            );
          })({ apiReferenceData: u, groups: e });
        }, [u, m, h]);
        return (0, t.jsx)(_.Provider, { value: { apiReferenceData2: k }, children: d });
      }
      ((D.displayName = "PageContext"),
        (N.displayName = "DeploymentMetadataContext"),
        (V.displayName = "DocsConfigContext"),
        (q.displayName = "AuthContext"),
        (U.displayName = "ApiReferenceContext"));
    },
    34639: (e, a, i) => {
      i.d(a, { q: () => t });
      function t(e) {
        var a;
        return e
          ? !(a = e.startsWith("/") ? e : `/${e}`) || a.endsWith("/")
            ? a.slice(0, -1)
            : a
          : "";
      }
    },
    37914: (e, a, i) => {
      i.d(a, { Ao: () => r, aZ: () => t, gw: () => n, x4: () => o });
      let t = "$circularRef",
        r = ["binary", "base64"],
        o = { server: {}, path: {}, query: {}, header: {}, cookie: {}, body: void 0 },
        n = {
          server: "server",
          path: "path",
          query: "query",
          header: "header",
          cookie: "cookie",
          body: "body",
        };
    },
    43967: (e, a, i) => {
      i.d(a, { gQ: () => l, l$: () => c, zC: () => n });
      var t = i(27277),
        r = i(20043),
        o = i.n(r);
      let n = "mintlify-auth-key",
        s = (e) => {
          if (!/^[0-9a-fA-F]+$/.test(e) || e.length % 2 != 0) {
            throw Error("Invalid hex key format");
          }
          let a = new Uint8Array(e.length / 2);
          for (let i = 0; i < a.length; i++) {
            a[i] = parseInt(e.slice(2 * i, 2 * i + 2), 16);
          }
          return a;
        };
      async function p(e, a) {
        let i = crypto.getRandomValues(new Uint8Array(12)),
          t = await crypto.subtle.importKey("raw", s(a), { name: "AES-GCM" }, !1, ["encrypt"]),
          r = new TextEncoder().encode(e),
          o = await crypto.subtle.encrypt({ name: "AES-GCM", iv: i }, t, r);
        return JSON.stringify({ iv: Array.from(i), ct: Array.from(new Uint8Array(o)) });
      }
      async function d(e, a) {
        let { iv: i, ct: t } = JSON.parse(e),
          r = s(a),
          o = await crypto.subtle.importKey("raw", r, { name: "AES-GCM" }, !1, ["decrypt"]),
          n = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(i) },
            o,
            new Uint8Array(t),
          );
        return new TextDecoder().decode(n);
      }
      async function l(e, a) {
        try {
          let i = u(),
            t = JSON.stringify(a),
            r = await p(t, i);
          localStorage.setItem(e, r);
        } catch {
          console.log("unable to encrypt credentials");
        }
      }
      async function c(e, a) {
        try {
          let i = u(),
            t = localStorage.getItem(e);
          if (!t) {
            return;
          }
          try {
            let e = await d(t, i),
              r = JSON.parse(e);
            if (!a || a(r)) {
              return r;
            }
          } catch (a) {
            (localStorage.removeItem(e), console.log(`unable to decrypt stored credentials: ${a}`));
          }
        } catch {
          return;
        }
      }
      let u = () => {
        let e = t.A.get(n);
        if (void 0 !== e) {
          return e;
        }
        let a = o()();
        return (t.A.set(n, a, { secure: "https:" === location.protocol, sameSite: "strict" }), a);
      };
    },
    52286: (e, a, i) => {
      i.d(a, { FC: () => t });
      let t = (e) => e.startsWith("https:") || e.startsWith("http:");
    },
    52927: (e, a, i) => {
      i.d(a, { J: () => z, U: () => x });
      let t = {
          language: "العربية",
          yes: "نعم",
          no: "لا",
          wasThisPageHelpful: "هل كانت هذه الصفحة مفيدة؟",
          onThisPage: "في هذه الصفحة",
          suggestEdits: "اقترح تعديلات",
          raiseIssue: "اطرح مشكلة",
          search: "...ابحث",
          poweredBy: "مدعوم من",
          filters: "المرشحات",
          clear: "مسح",
          previous: "السابق",
          next: "التالي",
          copyPage: "نسخ الصفحة",
          copying: "جارٍ النسخ...",
          viewAsMarkdown: "عرض بصيغة Markdown",
          openInChatGPT: "فتح في ChatGPT",
          openInClaude: "فتح في Claude",
          openInPerplexity: "فتح في Perplexity",
          openInGrok: "فتح في Grok",
          copyPageAsMarkdown: "نسخ الصفحة بصيغة Markdown لـ LLMs",
          viewPageAsMarkdown: "عرض هذه الصفحة كنص عادي",
          askQuestionsAboutPage: "اطرح أسئلة حول هذه الصفحة",
          copyMCPServer: "نسخ MCP Server",
          copyMCPServerDescription: "نسخ MCP Server URL إلى الحافظة",
          copyAddMCPCommand: "نسخ أمر تثبيت MCP",
          copyAddMCPCommandDescription: "نسخ أمر npx لتثبيت خادم MCP",
          connectToCursor: "الاتصال بـ Cursor",
          installMCPServerOnCursor: "تثبيت MCP Server على Cursor",
          connectToVSCode: "الاتصال بـ VS Code",
          installMCPServerOnVSCode: "تثبيت MCP Server على VS Code",
          assistant: "المساعد",
          addToAssistant: "أضف إلى المساعد",
          askAQuestion: "اسأل سؤال...",
          askAIAssistant: "اسأل المساعد الذكي",
          askAI: "اسأل الذكاء الاصطناعي",
          canYouTellMeAbout: "هل يمكنك أن تخبرني عن",
          recentSearches: "البحث الأخير",
          reportIncorrectCode: "الإبلاغ عن كود خاطئ",
          pleaseProvideDetailsOfTheIncorrectCode: "يرجى تقديم وصف مفصل للكود الخاطئ.",
          whatIsWrongWithThisCode: "ما هو الخطأ في هذا الكود؟",
          submit: "إرسال",
          cancel: "إلغاء",
          "feedback.greatWhatWorkedBest": "رائع! ما الذي عمل بشكل أفضل بالنسبة لك؟",
          "feedback.howCanWeImprove": "كيف يمكننا تحسين منتجنا؟",
          "feedback.placeholder": "(اختياري) هل يمكنك مشاركة المزيد عن تجربتك؟",
          "feedback.emailPlaceholder": "(اختياري) البريد الإلكتروني",
          "feedback.invalidEmail": "يرجى إدخال عنوان بريد إلكتروني صالح",
          "feedback.cancel": "إلغاء",
          "feedback.submit": "إرسال التعليقات",
          "feedback.positive.workedAsExpected": "عمل الدليل كما هو متوقع",
          "feedback.positive.easyToFind": "كان من السهل العثور على المعلومات التي أحتاجها",
          "feedback.positive.easyToUnderstand": "كان من السهل فهم المنتج والميزات",
          "feedback.positive.upToDate": "الوثائق محدثة",
          "feedback.positive.somethingElse": "شيء آخر",
          "feedback.negative.getStartedFaster": "ساعدني في البدء بشكل أسرع",
          "feedback.negative.easierToFind": "اجعل العثور على ما أبحث عنه أسهل",
          "feedback.negative.easierToUnderstand": "اجعل فهم المنتج والميزات أسهل",
          "feedback.negative.updateDocs": "حدث هذه الوثائق",
          "feedback.negative.somethingElse": "شيء آخر",
          "aria.openSearch": "فتح البحث",
          "aria.toggleAssistantPanel": "تبديل لوحة المساعد",
          "aria.searchForEndpoint": "البحث عن نقطة نهاية",
          "aria.deleteItem": "حذف العنصر",
          "aria.toggleSection": "تبديل قسم {section}",
          "aria.additionalFeedback": "تعليقات إضافية (اختياري)",
          "aria.emailAddress": "عنوان البريد الإلكتروني",
          "aria.enterValue": "أدخل {name}",
          "aria.selectOption": "اختر {name}",
          "aria.sendMessage": "إرسال رسالة",
          "aria.viewPayloadItem": "عرض {type}: {value}",
          "aria.removePayloadItem": "إزالة {type}: {value}",
          "aria.fileUploadButton": "زر رفع الملف",
          "aria.expandMessageSection": "توسيع قسم مثال الرسالة",
          "aria.moreActions": "المزيد من الإجراءات",
          "aria.openRssFeed": "فتح موجز RSS",
          "aria.info": "معلومات",
          "aria.warning": "تحذير",
          "aria.danger": "خطر",
          "aria.tip": "نصيحة",
          "aria.note": "ملاحظة",
          "aria.check": "فحص",
          "aria.toggleDarkMode": "تبديل الوضع المظلم",
          "aria.expandInputSection": "توسيع قسم الإدخال",
          "aria.reloadChat": "إعادة تحميل المحادثة",
          "aria.reloadLastChat": "إعادة تحميل آخر محادثة",
          "aria.copyChatResponse": "نسخ رد المحادثة",
          "aria.voteGood": "التصويت بأن الرد كان جيداً",
          "aria.voteBad": "التصويت بأن الرد لم يكن جيداً",
          "aria.navigateToHeader": "الانتقال إلى الرأس",
          "aria.navigateToChangelog": "الانتقال إلى سجل التغييرات",
          "aria.copyCodeBlock": "نسخ محتويات كتلة الكود",
          "aria.askAI": "اسأل الذكاء الاصطناعي",
          "aria.reportIncorrectCode": "الإبلاغ عن كود خاطئ",
          "aria.skipToMainContent": "الانتقال إلى المحتوى الرئيسي",
          "aria.switchToTheme": "التبديل إلى {theme} الموضوع",
          "aria.codeSnippet": "مقتطف الكود",
          "aria.messageContent": "محتوى الرسالة",
          "aria.basePathSelector": "اختر المسار الأساسي",
          "aria.selectBaseUrl": "اختر عنوان URL الأساسي",
          "aria.dismissBanner": "إغلاق الشعار",
          "aria.selectResponseSection": "اختر قسم الاستجابة",
          "aria.sendingRequest": "إرسال الطلب...",
          "aria.selectSchemaType": "اختر نوع المخطط",
          "aria.minimizeResponse": "تصغير الاستجابة",
          "aria.expandResponse": "توسيع الاستجابة",
          "aria.responseContent": "محتوى الاستجابة",
          "aria.fileDownloaded": "تم تنزيل الملف",
          "aria.downloadResponseFile": "تنزيل ملف الاستجابة",
          "tooltip.copy": "نسخ",
          "tooltip.copied": "تم النسخ!",
          "tooltip.askAI": "اسأل الذكاء الاصطناعي",
          "tooltip.reportIncorrectCode": "الإبلاغ عن كود خاطئ",
          "tooltip.download": "تنزيل",
          "assistant.suggestions": "اقتراحات",
          availableOptions: "الخيارات المتاحة",
          requiredRange: "النطاق المطلوب",
          hide: "إخفاء",
          show: "إظهار",
          childAttributes: "السمات الفرعية",
          copied: "تم النسخ",
          copyFailed: "فشل النسخ",
          "assistant.createSupportTicket": "اتصل بالدعم",
          "assistant.disclaimer": "يتم إنشاء الإجابات بواسطة الذكاء الاصطناعي وقد تحتوي على أخطاء.",
          generating: "جاري الإنشاء",
          searchingFor: "البحث عن",
          searched: "تم البحث",
          foundResultsFor: "تم العثور على نتائج لـ",
          tryIt: "جربه",
          send: "إرسال",
          "api.headers": "الترويسات",
          "api.pathParameters": "معلمات المسار",
          "api.queryParameters": "معلمات الاستعلام",
          "api.cookies": "ملفات تعريف الارتباط",
          "api.body": "الجسم",
          "api.response": "الاستجابة",
          "api.authorizations": "التفويضات",
          "api.header": "الترويسة",
          "api.path": "المسار",
          "api.query": "الاستعلام",
          "api.cookie": "ملف تعريف الارتباط",
          "api.authorization": "التفويض",
          "api.required": "مطلوب",
          "api.deprecated": "مهمل",
          "api.default": "افتراضي:",
          "api.noHeadersReceived": "لم يتم استلام ترويسات من الخادم",
          "api.noBodyReceived": "لم يتم استلام بيانات الجسم من الخادم",
          "api.noCookiesReceived": "لم يتم استلام ملفات تعريف الارتباط من الخادم",
          "api.example": "مثال",
          "api.examples": "أمثلة",
          "api.addNewProperty": "إضافة خاصية جديدة",
          "api.enterPropertyKey": "أدخل مفتاح الخاصية الجديدة",
          "api.addItem": "إضافة عنصر",
          "api.searchEndpoint": "البحث عن نقطة النهاية...",
          "api.connect": "اتصال",
          "api.disconnect": "قطع الاتصال",
          "api.connected": "متصل",
          "api.notConnected": "غير متصل",
          "api.sendMessage": "إرسال رسالة",
          "api.receive": "استقبال",
          "api.requestError": "حدث خطأ أثناء تقديم الطلب:",
          "api.mustBeMultipleOf": "يجب أن يكون من مضاعفات",
          "api.title": "العنوان",
          "api.const": "ثابت",
          "api.enterValue": "أدخل {name}",
          "api.enterValueCapitalized": "أدخل {name}",
          "api.selectOption": "حدد {name}",
          "api.enterBearerToken": "أدخل رمز Bearer",
          "api.value": "قيمة",
          "api.option": "خيار",
          "prompt.copyPrompt": "نسخ الأمر",
          "prompt.openInCursor": "فتح في Cursor",
        },
        r = {
          language: "Čeština",
          yes: "Ano",
          no: "Ne",
          wasThisPageHelpful: "Byla tato str\xe1nka užitečn\xe1?",
          onThisPage: "Na t\xe9to str\xe1nce",
          suggestEdits: "Navrhnout \xfapravy",
          raiseIssue: "Nahl\xe1sit probl\xe9m",
          search: "Hledat...",
          poweredBy: "Použ\xedv\xe1",
          filters: "Filtry",
          clear: "Vymazat",
          previous: "Předchoz\xed",
          next: "Dalš\xed",
          copyPage: "Kop\xedrovat str\xe1nku",
          copying: "Kop\xedrov\xe1n\xed...",
          viewAsMarkdown: "Zobrazit jako Markdown",
          openInChatGPT: "Otevř\xedt v ChatGPT",
          openInClaude: "Otevř\xedt v Claude",
          openInPerplexity: "Otevř\xedt v Perplexity",
          openInGrok: "Otevř\xedt v Grok",
          copyPageAsMarkdown: "Kop\xedrovat str\xe1nku jako Markdown pro LLM",
          viewPageAsMarkdown: "Zobrazit tuto str\xe1nku jako prost\xfd text",
          askQuestionsAboutPage: "Kl\xe1st ot\xe1zky o t\xe9to str\xe1nce",
          copyMCPServer: "Kop\xedrovat MCP Server",
          copyMCPServerDescription: "Kop\xedrovat URL MCP Serveru do schr\xe1nky",
          copyAddMCPCommand: "Kop\xedrovat př\xedkaz pro instalaci MCP",
          copyAddMCPCommandDescription: "Kop\xedrovat př\xedkaz npx pro instalaci MCP serveru",
          connectToCursor: "Připojit k Cursor",
          installMCPServerOnCursor: "Instalovat MCP Server na Cursor",
          connectToVSCode: "Připojit k VS Code",
          installMCPServerOnVSCode: "Instalovat MCP Server na VS Code",
          assistant: "Asistent",
          addToAssistant: "Přidat k asistentovi",
          askAQuestion: "Položit ot\xe1zku...",
          askAIAssistant: "Zeptat se AI asistenta",
          askAI: "Zeptat se AI",
          canYouTellMeAbout: "Můžeš mi ř\xedct o",
          recentSearches: "Ned\xe1vn\xe1 vyhled\xe1v\xe1n\xed",
          reportIncorrectCode: "Nahl\xe1sit nespr\xe1vn\xfd k\xf3d",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Pros\xedm, poskytněte podrobn\xfd popis nespr\xe1vn\xe9ho k\xf3du.",
          whatIsWrongWithThisCode: "Co je špatn\xe9ho na tomto k\xf3du?",
          submit: "Odeslat",
          cancel: "Zrušit",
          "feedback.greatWhatWorkedBest": "Skvěl\xe9! Co fungovalo nejl\xe9pe?",
          "feedback.howCanWeImprove": "Jak můžeme n\xe1š produkt vylepšit?",
          "feedback.placeholder":
            "(Voliteln\xe9) Můžete n\xe1m ř\xedci v\xedce o sv\xe9 zkušenosti?",
          "feedback.emailPlaceholder": "(Voliteln\xe9) E-mail",
          "feedback.invalidEmail": "Zadejte platnou e-mailovou adresu",
          "feedback.cancel": "Zrušit",
          "feedback.submit": "Odeslat zpětnou vazbu",
          "feedback.positive.workedAsExpected": "Průvodce fungoval podle oček\xe1v\xe1n\xed",
          "feedback.positive.easyToFind":
            "Bylo snadn\xe9 naj\xedt informace, kter\xe9 jsem potřeboval",
          "feedback.positive.easyToUnderstand": "Bylo snadn\xe9 porozumět produktu a funkc\xedm",
          "feedback.positive.upToDate": "Dokumentace je aktu\xe1ln\xed",
          "feedback.positive.somethingElse": "Něco jin\xe9ho",
          "feedback.negative.getStartedFaster": "Pomozte mi zač\xedt rychleji",
          "feedback.negative.easierToFind": "Usnadněte hled\xe1n\xed toho, co hled\xe1m",
          "feedback.negative.easierToUnderstand": "Usnadněte pochopen\xed produktu a funkc\xed",
          "feedback.negative.updateDocs": "Aktualizujte tuto dokumentaci",
          "feedback.negative.somethingElse": "Něco jin\xe9ho",
          "aria.openSearch": "Otevř\xedt vyhled\xe1v\xe1n\xed",
          "aria.toggleAssistantPanel": "Přepnout panel asistenta",
          "aria.searchForEndpoint": "Hledat endpoint",
          "aria.deleteItem": "Smazat položku",
          "aria.toggleSection": "Přepnout sekci {section}",
          "aria.additionalFeedback": "Dalš\xed zpětn\xe1 vazba (voliteln\xe9)",
          "aria.emailAddress": "E-mailov\xe1 adresa",
          "aria.enterValue": "Zadat {name}",
          "aria.selectOption": "Vybrat {name}",
          "aria.sendMessage": "Odeslat zpr\xe1vu",
          "aria.viewPayloadItem": "Zobrazit {type}: {value}",
          "aria.removePayloadItem": "Odebrat {type}: {value}",
          "aria.fileUploadButton": "Tlač\xedtko nahr\xe1n\xed souboru",
          "aria.expandMessageSection": "Rozbalit sekci př\xedkladu zpr\xe1vy",
          "aria.moreActions": "V\xedce akc\xed",
          "aria.openRssFeed": "Otevř\xedt RSS kan\xe1l",
          "aria.info": "Informace",
          "aria.warning": "Upozorněn\xed",
          "aria.danger": "Nebezpeč\xed",
          "aria.tip": "Tip",
          "aria.note": "Pozn\xe1mka",
          "aria.check": "Zkontrolovat",
          "aria.toggleDarkMode": "Přepnout tmav\xfd režim",
          "aria.expandInputSection": "Rozbalit sekci vstupů",
          "aria.reloadChat": "Znovu nač\xedst chat",
          "aria.reloadLastChat": "Znovu nač\xedst posledn\xed chat",
          "aria.copyChatResponse": "Kop\xedrovat odpověď chatu",
          "aria.voteGood": "Hlasovat, že odpověď byla dobr\xe1",
          "aria.voteBad": "Hlasovat, že odpověď nebyla dobr\xe1",
          "aria.navigateToHeader": "Navigovat na z\xe1hlav\xed",
          "aria.navigateToChangelog": "Navigovat na seznam změn",
          "aria.copyCodeBlock": "Kop\xedrovat obsah z bloku k\xf3du",
          "aria.askAI": "Zeptat se AI",
          "aria.reportIncorrectCode": "Nahl\xe1sit nespr\xe1vn\xfd k\xf3d",
          "aria.skipToMainContent": "Přej\xedt na hlavn\xed obsah",
          "aria.switchToTheme": "Přepnout na {theme} t\xe9ma",
          "aria.codeSnippet": "\xdaryvek k\xf3du",
          "aria.messageContent": "Obsah zpr\xe1vy",
          "aria.basePathSelector": "Vybrat z\xe1kladn\xed cestu",
          "aria.selectBaseUrl": "Vybrat z\xe1kladn\xed URL",
          "aria.dismissBanner": "Zavř\xedt banner",
          "aria.selectResponseSection": "Vybrat sekci odpovědi",
          "aria.sendingRequest": "Odes\xedl\xe1n\xed požadavku...",
          "aria.selectSchemaType": "Vybrat typ sch\xe9matu",
          "aria.minimizeResponse": "Minimalizovat odpověď",
          "aria.expandResponse": "Rozbalit odpověď",
          "aria.responseContent": "Obsah odpovědi",
          "aria.fileDownloaded": "Soubor stažen",
          "aria.downloadResponseFile": "St\xe1hnout soubor odpovědi",
          "tooltip.copy": "Kop\xedrovat",
          "tooltip.copied": "Zkop\xedrov\xe1no!",
          "tooltip.askAI": "Zeptat se AI",
          "tooltip.reportIncorrectCode": "Nahl\xe1sit nespr\xe1vn\xfd k\xf3d",
          "tooltip.download": "St\xe1hnout",
          "assistant.suggestions": "N\xe1vrhy",
          availableOptions: "Dostupn\xe9 možnosti",
          requiredRange: "Požadovan\xfd rozsah",
          hide: "Skr\xfdt",
          show: "Zobrazit",
          childAttributes: "podř\xedzen\xe9 atributy",
          copied: "Zkop\xedrov\xe1no",
          copyFailed: "Kop\xedrov\xe1n\xed selhalo",
          "assistant.createSupportTicket": "Kontaktovat podporu",
          "assistant.disclaimer": "Odpovědi jsou generov\xe1ny AI a mohou obsahovat chyby.",
          generating: "Generov\xe1n\xed",
          searchingFor: "Vyhled\xe1v\xe1n\xed",
          searched: "Vyhled\xe1no",
          foundResultsFor: "Nalezen\xe9 v\xfdsledky pro",
          tryIt: "Vyzkoušet",
          send: "Odeslat",
          "api.headers": "Hlavičky",
          "api.pathParameters": "Parametry cesty",
          "api.queryParameters": "Parametry dotazu",
          "api.cookies": "Cookies",
          "api.body": "Tělo",
          "api.response": "Odpověď",
          "api.authorizations": "Autorizace",
          "api.header": "Hlavička",
          "api.path": "Cesta",
          "api.query": "Dotaz",
          "api.cookie": "Cookie",
          "api.authorization": "Autorizace",
          "api.required": "povinn\xe9",
          "api.deprecated": "zastaral\xe9",
          "api.default": "v\xfdchoz\xed:",
          "api.noHeadersReceived": "Ze serveru nebyly přijaty ž\xe1dn\xe9 hlavičky",
          "api.noBodyReceived": "Ze serveru nebyla přijata ž\xe1dn\xe1 data těla",
          "api.noCookiesReceived": "Ze serveru nebyly přijaty ž\xe1dn\xe9 cookies",
          "api.example": "Př\xedklad",
          "api.examples": "Př\xedklady",
          "api.addNewProperty": "Přidat novou vlastnost",
          "api.enterPropertyKey": "Zadejte kl\xedč nov\xe9 vlastnosti",
          "api.addItem": "Přidat položku",
          "api.searchEndpoint": "Hledat endpoint...",
          "api.connect": "Připojit",
          "api.disconnect": "Odpojit",
          "api.connected": "Připojeno",
          "api.notConnected": "Nepřipojeno",
          "api.sendMessage": "Odeslat zpr\xe1vu",
          "api.receive": "Přijmout",
          "api.requestError": "Při prov\xe1děn\xed požadavku došlo k chybě:",
          "api.mustBeMultipleOf": "Mus\xed b\xfdt n\xe1sobkem",
          "api.title": "N\xe1zev",
          "api.const": "Konstanta",
          "api.enterValue": "zadejte {name}",
          "api.enterValueCapitalized": "Zadejte {name}",
          "api.selectOption": "vyberte {name}",
          "api.enterBearerToken": "zadejte bearer token",
          "api.value": "hodnota",
          "api.option": "možnost",
          "prompt.copyPrompt": "Kop\xedrovat prompt",
          "prompt.openInCursor": "Otevř\xedt v Cursor",
        },
        o = {
          language: "Deutsch",
          yes: "Ja",
          no: "Nein",
          wasThisPageHelpful: "War diese Seite hilfreich?",
          onThisPage: "Auf dieser Seite",
          suggestEdits: "\xc4nderungen vorschlagen",
          raiseIssue: "Problem melden",
          search: "Suchen...",
          poweredBy: "Bereitgestellt von",
          filters: "Filter",
          clear: "L\xf6schen",
          previous: "Zur\xfcck",
          next: "Weiter",
          copyPage: "Seite kopieren",
          copying: "Kopiere...",
          viewAsMarkdown: "Als Markdown anzeigen",
          openInChatGPT: "In ChatGPT \xf6ffnen",
          openInClaude: "In Claude \xf6ffnen",
          openInPerplexity: "In Perplexity \xf6ffnen",
          openInGrok: "In Grok \xf6ffnen",
          copyPageAsMarkdown: "Seite als Markdown f\xfcr LLMs kopieren",
          viewPageAsMarkdown: "Diese Seite als Klartext anzeigen",
          askQuestionsAboutPage: "Fragen zu dieser Seite stellen",
          copyMCPServer: "MCP Server kopieren",
          copyMCPServerDescription: "MCP Server URL in die Zwischenablage kopieren",
          copyAddMCPCommand: "MCP-Installationsbefehl kopieren",
          copyAddMCPCommandDescription: "npx-Befehl zum Installieren des MCP-Servers kopieren",
          connectToCursor: "Mit Cursor verbinden",
          installMCPServerOnCursor: "MCP Server in Cursor installieren",
          connectToVSCode: "Mit VS Code verbinden",
          installMCPServerOnVSCode: "MCP Server in VS Code installieren",
          assistant: "Assistent",
          addToAssistant: "Zum Assistenten hinzuf\xfcgen",
          askAQuestion: "Frage stellen...",
          askAIAssistant: "Frage den AI-Assistenten",
          askAI: "KI fragen",
          canYouTellMeAbout: "Kannst du mir erkl\xe4ren, was",
          recentSearches: "Zuletzt gesucht",
          reportIncorrectCode: "Falschen Code melden",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Bitte geben Sie eine detaillierte Beschreibung des falschen Codes an.",
          whatIsWrongWithThisCode: "Was ist falsch an diesem Code?",
          submit: "Absenden",
          cancel: "Abbrechen",
          "feedback.greatWhatWorkedBest":
            "Gro\xdfartig! Was hat am besten f\xfcr Sie funktioniert?",
          "feedback.howCanWeImprove": "Wie k\xf6nnen wir unser Produkt verbessern?",
          "feedback.placeholder":
            "(Optional) K\xf6nnten Sie mehr \xfcber Ihre Erfahrung erz\xe4hlen?",
          "feedback.emailPlaceholder": "(Optional) E-Mail",
          "feedback.invalidEmail": "Bitte geben Sie eine g\xfcltige E-Mail-Adresse ein",
          "feedback.cancel": "Abbrechen",
          "feedback.submit": "Feedback senden",
          "feedback.positive.workedAsExpected": "Die Anleitung funktionierte wie erwartet",
          "feedback.positive.easyToFind":
            "Es war einfach, die ben\xf6tigten Informationen zu finden",
          "feedback.positive.easyToUnderstand":
            "Es war einfach, das Produkt und die Funktionen zu verstehen",
          "feedback.positive.upToDate": "Die Dokumentation ist aktuell",
          "feedback.positive.somethingElse": "Etwas anderes",
          "feedback.negative.getStartedFaster": "Helfen Sie mir, schneller anzufangen",
          "feedback.negative.easierToFind": "Machen Sie es einfacher zu finden, was ich suche",
          "feedback.negative.easierToUnderstand":
            "Machen Sie es einfach, das Produkt und die Funktionen zu verstehen",
          "feedback.negative.updateDocs": "Diese Dokumentation aktualisieren",
          "feedback.negative.somethingElse": "Etwas anderes",
          "aria.openSearch": "Suche \xf6ffnen",
          "aria.toggleAssistantPanel": "Assistenten-Panel umschalten",
          "aria.searchForEndpoint": "Nach Endpunkt suchen",
          "aria.deleteItem": "Element l\xf6schen",
          "aria.toggleSection": "Bereich {section} umschalten",
          "aria.additionalFeedback": "Zus\xe4tzliches Feedback (optional)",
          "aria.emailAddress": "E-Mail-Adresse",
          "aria.enterValue": "{name} eingeben",
          "aria.selectOption": "{name} ausw\xe4hlen",
          "aria.sendMessage": "Nachricht senden",
          "aria.viewPayloadItem": "{type} anzeigen: {value}",
          "aria.removePayloadItem": "{type} entfernen: {value}",
          "aria.fileUploadButton": "Datei-Upload-Schaltfl\xe4che",
          "aria.expandMessageSection": "Nachrichtenbeispiel-Bereich erweitern",
          "aria.moreActions": "Weitere Aktionen",
          "aria.openRssFeed": "RSS-Feed \xf6ffnen",
          "aria.info": "Information",
          "aria.warning": "Warnung",
          "aria.danger": "Gefahr",
          "aria.tip": "Tipp",
          "aria.note": "Notiz",
          "aria.check": "Pr\xfcfen",
          "aria.toggleDarkMode": "Dunklen Modus umschalten",
          "aria.expandInputSection": "Eingabebereich erweitern",
          "aria.reloadChat": "Chat neu laden",
          "aria.reloadLastChat": "Letzten Chat neu laden",
          "aria.copyChatResponse": "Chat-Antwort kopieren",
          "aria.voteGood": "Bewerten, dass die Antwort gut war",
          "aria.voteBad": "Bewerten, dass die Antwort nicht gut war",
          "aria.navigateToHeader": "Zur Kopfzeile navigieren",
          "aria.navigateToChangelog": "Zum \xc4nderungsprotokoll navigieren",
          "aria.copyCodeBlock": "Inhalt des Codeblocks kopieren",
          "aria.askAI": "KI fragen",
          "aria.reportIncorrectCode": "Falschen Code melden",
          "aria.skipToMainContent": "Zum Hauptinhalt springen",
          "aria.switchToTheme": "Zu {theme}-Design wechseln",
          "aria.codeSnippet": "Code-Schnipsel",
          "aria.messageContent": "Nachrichteninhalt",
          "aria.basePathSelector": "Basispfad ausw\xe4hlen",
          "aria.selectBaseUrl": "Basis-URL ausw\xe4hlen",
          "aria.dismissBanner": "Banner schlie\xdfen",
          "aria.selectResponseSection": "Antwortabschnitt ausw\xe4hlen",
          "aria.sendingRequest": "Anfrage wird gesendet...",
          "aria.selectSchemaType": "Schema-Typ ausw\xe4hlen",
          "aria.minimizeResponse": "Antwort minimieren",
          "aria.expandResponse": "Antwort erweitern",
          "aria.responseContent": "Antwortinhalt",
          "aria.fileDownloaded": "Datei heruntergeladen",
          "aria.downloadResponseFile": "Antwortdatei herunterladen",
          "tooltip.copy": "Kopieren",
          "tooltip.copied": "Kopiert!",
          "tooltip.askAI": "KI fragen",
          "tooltip.reportIncorrectCode": "Falschen Code melden",
          "tooltip.download": "Herunterladen",
          "assistant.suggestions": "Vorschl\xe4ge",
          availableOptions: "Verf\xfcgbare Optionen",
          requiredRange: "Erforderlicher Bereich",
          hide: "Ausblenden",
          show: "Anzeigen",
          childAttributes: "untergeordnete attribute",
          copied: "Kopiert",
          copyFailed: "Kopieren fehlgeschlagen",
          "assistant.createSupportTicket": "Support kontaktieren",
          "assistant.disclaimer":
            "Antworten werden von KI generiert und k\xf6nnen Fehler enthalten.",
          generating: "Wird generiert",
          searchingFor: "Suche nach",
          searched: "Gesucht",
          foundResultsFor: "Ergebnisse gefunden f\xfcr",
          tryIt: "Ausprobieren",
          send: "Senden",
          "api.headers": "Header",
          "api.pathParameters": "Pfadparameter",
          "api.queryParameters": "Abfrageparameter",
          "api.cookies": "Cookies",
          "api.body": "Body",
          "api.response": "Antwort",
          "api.authorizations": "Autorisierungen",
          "api.header": "Header",
          "api.path": "Pfad",
          "api.query": "Abfrage",
          "api.cookie": "Cookie",
          "api.authorization": "Autorisierung",
          "api.required": "erforderlich",
          "api.deprecated": "veraltet",
          "api.default": "Standard:",
          "api.noHeadersReceived": "Keine Header vom Server empfangen",
          "api.noBodyReceived": "Keine Body-Daten vom Server empfangen",
          "api.noCookiesReceived": "Keine Cookies vom Server empfangen",
          "api.example": "Beispiel",
          "api.examples": "Beispiele",
          "api.addNewProperty": "Neue Eigenschaft hinzuf\xfcgen",
          "api.enterPropertyKey": "Schl\xfcssel der neuen Eigenschaft eingeben",
          "api.addItem": "Element hinzuf\xfcgen",
          "api.searchEndpoint": "Endpunkt suchen...",
          "api.connect": "Verbinden",
          "api.disconnect": "Trennen",
          "api.connected": "Verbunden",
          "api.notConnected": "Nicht verbunden",
          "api.sendMessage": "Nachricht senden",
          "api.receive": "Empfangen",
          "api.requestError": "Bei der Anfrage ist ein Fehler aufgetreten:",
          "api.mustBeMultipleOf": "Muss ein Vielfaches sein von",
          "api.title": "Titel",
          "api.const": "Konstante",
          "api.enterValue": "{name} eingeben",
          "api.enterValueCapitalized": "{name} eingeben",
          "api.selectOption": "{name} ausw\xe4hlen",
          "api.enterBearerToken": "Bearer-Token eingeben",
          "api.value": "Wert",
          "api.option": "Option",
          "prompt.copyPrompt": "Prompt kopieren",
          "prompt.openInCursor": "In Cursor \xf6ffnen",
        },
        n = {
          language: "English",
          yes: "Yes",
          no: "No",
          wasThisPageHelpful: "Was this page helpful?",
          onThisPage: "On this page",
          suggestEdits: "Suggest edits",
          raiseIssue: "Raise issue",
          search: "Search...",
          poweredBy: "Powered by",
          filters: "Filters",
          clear: "Clear",
          previous: "Previous",
          next: "Next",
          copyPage: "Copy page",
          copying: "Copying...",
          viewAsMarkdown: "View as Markdown",
          openInChatGPT: "Open in ChatGPT",
          openInClaude: "Open in Claude",
          openInPerplexity: "Open in Perplexity",
          openInGrok: "Open in Grok",
          copyPageAsMarkdown: "Copy page as Markdown for LLMs",
          viewPageAsMarkdown: "View this page as plain text",
          askQuestionsAboutPage: "Ask questions about this page",
          copyMCPServer: "Copy MCP Server",
          copyMCPServerDescription: "Copy MCP Server URL to clipboard",
          copyAddMCPCommand: "Copy MCP install command",
          copyAddMCPCommandDescription: "Copy npx command to install MCP server",
          connectToCursor: "Connect to Cursor",
          installMCPServerOnCursor: "Install MCP Server on Cursor",
          connectToVSCode: "Connect to VS Code",
          installMCPServerOnVSCode: "Install MCP Server on VS Code",
          assistant: "Assistant",
          addToAssistant: "Add to assistant",
          askAQuestion: "Ask a question...",
          askAIAssistant: "Ask AI assistant",
          askAI: "Ask AI",
          canYouTellMeAbout: "Can you tell me about",
          recentSearches: "Recent searches",
          reportIncorrectCode: "Report incorrect code",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Please provide a detailed description of the incorrect code.",
          whatIsWrongWithThisCode: "What's wrong with this code?",
          submit: "Submit",
          cancel: "Cancel",
          "feedback.greatWhatWorkedBest": "Great! What worked best for you?",
          "feedback.howCanWeImprove": "How can we improve our product?",
          "feedback.placeholder": "(Optional) Could you share more about your experience?",
          "feedback.emailPlaceholder": "(Optional) Email",
          "feedback.invalidEmail": "Please enter a valid email address",
          "feedback.cancel": "Cancel",
          "feedback.submit": "Submit feedback",
          "feedback.positive.workedAsExpected": "The guide worked as expected",
          "feedback.positive.easyToFind": "It was easy to find the information I needed",
          "feedback.positive.easyToUnderstand":
            "It was easy to understand the product and features",
          "feedback.positive.upToDate": "The documentation is up to date",
          "feedback.positive.somethingElse": "Something else",
          "feedback.negative.getStartedFaster": "Help me get started faster",
          "feedback.negative.easierToFind": "Make it easier to find what I'm looking for",
          "feedback.negative.easierToUnderstand":
            "Make it easy to understand the product and features",
          "feedback.negative.updateDocs": "Update this documentation",
          "feedback.negative.somethingElse": "Something else",
          "aria.openSearch": "Open search",
          "aria.toggleAssistantPanel": "Toggle assistant panel",
          "aria.searchForEndpoint": "Search for endpoint",
          "aria.deleteItem": "Delete item",
          "aria.toggleSection": "Toggle {section} section",
          "aria.additionalFeedback": "Additional feedback (optional)",
          "aria.emailAddress": "Email address",
          "aria.enterValue": "Enter {name}",
          "aria.selectOption": "Select {name}",
          "aria.sendMessage": "Send message",
          "aria.viewPayloadItem": "View {type}: {value}",
          "aria.removePayloadItem": "Remove {type}: {value}",
          "aria.fileUploadButton": "File upload button",
          "aria.expandMessageSection": "Expand message example section",
          "aria.moreActions": "More actions",
          "aria.openRssFeed": "Open RSS feed",
          "aria.info": "Info",
          "aria.warning": "Warning",
          "aria.danger": "Danger",
          "aria.tip": "Tip",
          "aria.note": "Note",
          "aria.check": "Check",
          "aria.toggleDarkMode": "Toggle dark mode",
          "aria.expandInputSection": "Expand input section",
          "aria.reloadChat": "Reload chat",
          "aria.reloadLastChat": "Reload last chat",
          "aria.copyChatResponse": "Copy chat response",
          "aria.voteGood": "Vote that response was good",
          "aria.voteBad": "Vote that response was not good",
          "aria.navigateToHeader": "Navigate to header",
          "aria.navigateToChangelog": "Navigate to changelog",
          "aria.copyCodeBlock": "Copy the contents from the code block",
          "aria.askAI": "Ask AI",
          "aria.reportIncorrectCode": "Report incorrect code",
          "aria.skipToMainContent": "Skip to main content",
          "aria.switchToTheme": "Switch to {theme} theme",
          "aria.codeSnippet": "Code snippet",
          "aria.messageContent": "Message content",
          "aria.basePathSelector": "Select base path",
          "aria.selectBaseUrl": "Select base URL",
          "aria.dismissBanner": "Dismiss banner",
          "aria.selectResponseSection": "Select response section",
          "aria.sendingRequest": "Sending request...",
          "aria.selectSchemaType": "Select schema type",
          "aria.minimizeResponse": "Minimize response",
          "aria.expandResponse": "Expand response",
          "aria.responseContent": "Response content",
          "aria.fileDownloaded": "File downloaded",
          "aria.downloadResponseFile": "Download response file",
          "tooltip.copy": "Copy",
          "tooltip.copied": "Copied!",
          "tooltip.askAI": "Ask AI",
          "tooltip.reportIncorrectCode": "Report incorrect code",
          "tooltip.download": "Download",
          "assistant.suggestions": "Suggestions",
          availableOptions: "Available options",
          requiredRange: "Required range",
          hide: "Hide",
          show: "Show",
          childAttributes: "child attributes",
          copied: "Copied",
          copyFailed: "Copy failed",
          "assistant.createSupportTicket": "Contact support",
          "assistant.disclaimer": "Responses are generated using AI and may contain mistakes.",
          generating: "Generating",
          searchingFor: "Searching for",
          searched: "Searched",
          foundResultsFor: "Found results for",
          tryIt: "Try it",
          send: "Send",
          "api.headers": "Headers",
          "api.pathParameters": "Path Parameters",
          "api.queryParameters": "Query Parameters",
          "api.cookies": "Cookies",
          "api.body": "Body",
          "api.response": "Response",
          "api.authorizations": "Authorizations",
          "api.header": "Header",
          "api.path": "Path",
          "api.query": "Query",
          "api.cookie": "Cookie",
          "api.authorization": "Authorization",
          "api.required": "required",
          "api.deprecated": "deprecated",
          "api.default": "default:",
          "api.noHeadersReceived": "No headers received from the server",
          "api.noBodyReceived": "No body data received from the server",
          "api.noCookiesReceived": "No cookies received from the server",
          "api.example": "Example",
          "api.examples": "Examples",
          "api.addNewProperty": "Add new property",
          "api.enterPropertyKey": "Enter key of new property",
          "api.addItem": "Add an item",
          "api.searchEndpoint": "Search for endpoint...",
          "api.connect": "Connect",
          "api.disconnect": "Disconnect",
          "api.connected": "Connected",
          "api.notConnected": "Not Connected",
          "api.sendMessage": "Send message",
          "api.receive": "Receive",
          "api.requestError": "An error occurred while making the request:",
          "api.mustBeMultipleOf": "Must be a multiple of",
          "api.title": "Title",
          "api.const": "Const",
          "api.enterValue": "enter {name}",
          "api.enterValueCapitalized": "Enter {name}",
          "api.selectOption": "select {name}",
          "api.enterBearerToken": "enter bearer token",
          "api.value": "value",
          "api.option": "option",
          "prompt.copyPrompt": "Copy prompt",
          "prompt.openInCursor": "Open in Cursor",
        },
        s = {
          language: "Espa\xf1ol",
          yes: "S\xed",
          no: "No",
          wasThisPageHelpful: "\xbfEsta p\xe1gina le ayud\xf3?",
          onThisPage: "En esta p\xe1gina",
          suggestEdits: "Sugerir cambios",
          raiseIssue: "Reportar problema",
          search: "Buscar...",
          poweredBy: "Impulsado por",
          filters: "Filtros",
          clear: "Limpiar",
          previous: "Anterior",
          next: "Siguiente",
          copyPage: "Copiar p\xe1gina",
          copying: "Copiando...",
          viewAsMarkdown: "Ver como Markdown",
          openInChatGPT: "Abrir en ChatGPT",
          openInClaude: "Abrir en Claude",
          openInPerplexity: "Abrir en Perplexity",
          openInGrok: "Abrir en Grok",
          copyPageAsMarkdown: "Copiar p\xe1gina como Markdown para LLMs",
          viewPageAsMarkdown: "Ver esta p\xe1gina como texto plano",
          askQuestionsAboutPage: "Hacer preguntas sobre esta p\xe1gina",
          copyMCPServer: "Copiar MCP Server",
          copyMCPServerDescription: "Copiar URL del MCP Server al portapapeles",
          copyAddMCPCommand: "Copiar comando de instalaci\xf3n MCP",
          copyAddMCPCommandDescription: "Copiar comando npx para instalar el servidor MCP",
          connectToCursor: "Conectar a Cursor",
          installMCPServerOnCursor: "Instalar MCP Server en Cursor",
          connectToVSCode: "Conectar a VS Code",
          installMCPServerOnVSCode: "Instalar MCP Server en VS Code",
          assistant: "Asistente",
          addToAssistant: "Agregar al asistente",
          askAQuestion: "Hacer una pregunta...",
          askAIAssistant: "Hacer una pregunta al asistente",
          askAI: "Preguntar a la IA",
          canYouTellMeAbout: "\xbfPuedes decirme sobre",
          recentSearches: "Busquedas recientes",
          reportIncorrectCode: "Reportar c\xf3digo incorrecto",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Por favor, proporcione una descripci\xf3n detallada del c\xf3digo incorrecto.",
          whatIsWrongWithThisCode: "\xbfQu\xe9 est\xe1 mal con este c\xf3digo?",
          submit: "Enviar",
          cancel: "Cancelar",
          "feedback.greatWhatWorkedBest": "\xa1Excelente! \xbfQu\xe9 funcion\xf3 mejor para ti?",
          "feedback.howCanWeImprove": "\xbfC\xf3mo podemos mejorar nuestro producto?",
          "feedback.placeholder":
            "(Opcional) \xbfPodr\xedas compartir m\xe1s sobre tu experiencia?",
          "feedback.emailPlaceholder": "(Opcional) Correo electr\xf3nico",
          "feedback.invalidEmail": "Ingrese una direcci\xf3n de correo electr\xf3nico v\xe1lida",
          "feedback.cancel": "Cancelar",
          "feedback.submit": "Enviar comentarios",
          "feedback.positive.workedAsExpected": "La gu\xeda funcion\xf3 como se esperaba",
          "feedback.positive.easyToFind": "Fue f\xe1cil encontrar la informaci\xf3n que necesitaba",
          "feedback.positive.easyToUnderstand": "Fue f\xe1cil entender el producto y las funciones",
          "feedback.positive.upToDate": "La documentaci\xf3n est\xe1 actualizada",
          "feedback.positive.somethingElse": "Algo m\xe1s",
          "feedback.negative.getStartedFaster": "Ay\xfadame a comenzar m\xe1s r\xe1pido",
          "feedback.negative.easierToFind": "Hacer m\xe1s f\xe1cil encontrar lo que busco",
          "feedback.negative.easierToUnderstand":
            "Hacer m\xe1s f\xe1cil entender el producto y las funciones",
          "feedback.negative.updateDocs": "Actualizar esta documentaci\xf3n",
          "feedback.negative.somethingElse": "Algo m\xe1s",
          "aria.openSearch": "Abrir b\xfasqueda",
          "aria.toggleAssistantPanel": "Alternar panel del asistente",
          "aria.searchForEndpoint": "Buscar endpoint",
          "aria.deleteItem": "Eliminar elemento",
          "aria.toggleSection": "Alternar secci\xf3n {section}",
          "aria.additionalFeedback": "Comentarios adicionales (opcional)",
          "aria.emailAddress": "Direcci\xf3n de correo electr\xf3nico",
          "aria.enterValue": "Ingresar {name}",
          "aria.selectOption": "Seleccionar {name}",
          "aria.sendMessage": "Enviar mensaje",
          "aria.viewPayloadItem": "Ver {type}: {value}",
          "aria.removePayloadItem": "Eliminar {type}: {value}",
          "aria.fileUploadButton": "Bot\xf3n de carga de archivos",
          "aria.expandMessageSection": "Expandir secci\xf3n de ejemplo de mensaje",
          "aria.moreActions": "M\xe1s acciones",
          "aria.openRssFeed": "Abrir feed RSS",
          "aria.info": "Informaci\xf3n",
          "aria.warning": "Advertencia",
          "aria.danger": "Peligro",
          "aria.tip": "Consejo",
          "aria.note": "Nota",
          "aria.check": "Verificar",
          "aria.toggleDarkMode": "Alternar modo oscuro",
          "aria.expandInputSection": "Expandir secci\xf3n de entrada",
          "aria.reloadChat": "Recargar chat",
          "aria.reloadLastChat": "Recargar \xfaltimo chat",
          "aria.copyChatResponse": "Copiar respuesta del chat",
          "aria.voteGood": "Votar que la respuesta fue buena",
          "aria.voteBad": "Votar que la respuesta no fue buena",
          "aria.navigateToHeader": "Navegar al encabezado",
          "aria.navigateToChangelog": "Navegar al registro de cambios",
          "aria.copyCodeBlock": "Copiar el contenido del bloque de c\xf3digo",
          "aria.askAI": "Preguntar a la IA",
          "aria.reportIncorrectCode": "Reportar c\xf3digo incorrecto",
          "aria.skipToMainContent": "Saltar al contenido principal",
          "aria.switchToTheme": "Cambiar al tema {theme}",
          "aria.codeSnippet": "Fragmento de c\xf3digo",
          "aria.messageContent": "Contenido del mensaje",
          "aria.basePathSelector": "Seleccionar ruta base",
          "aria.selectBaseUrl": "Seleccionar URL base",
          "aria.dismissBanner": "Cerrar banner",
          "aria.selectResponseSection": "Seleccionar secci\xf3n de respuesta",
          "aria.sendingRequest": "Enviando solicitud...",
          "aria.selectSchemaType": "Seleccionar tipo de esquema",
          "aria.minimizeResponse": "Minimizar respuesta",
          "aria.expandResponse": "Expandir respuesta",
          "aria.responseContent": "Contenido de respuesta",
          "aria.fileDownloaded": "Archivo descargado",
          "aria.downloadResponseFile": "Descargar archivo de respuesta",
          "tooltip.copy": "Copiar",
          "tooltip.copied": "\xa1Copiado!",
          "tooltip.askAI": "Preguntar a la IA",
          "tooltip.reportIncorrectCode": "Reportar c\xf3digo incorrecto",
          "tooltip.download": "Descargar",
          "assistant.suggestions": "Sugerencias",
          availableOptions: "Opciones disponibles",
          requiredRange: "Rango requerido",
          hide: "Ocultar",
          show: "Mostrar",
          childAttributes: "atributos secundarios",
          copied: "Copiado",
          copyFailed: "Error al copiar",
          "assistant.createSupportTicket": "Contactar soporte",
          "assistant.disclaimer": "Las respuestas son generadas por IA y pueden contener errores.",
          generating: "Generando",
          searchingFor: "Buscando",
          searched: "Buscado",
          foundResultsFor: "Resultados encontrados para",
          tryIt: "Pru\xe9balo",
          send: "Enviar",
          "api.headers": "Encabezados",
          "api.pathParameters": "Par\xe1metros de ruta",
          "api.queryParameters": "Par\xe1metros de consulta",
          "api.cookies": "Cookies",
          "api.body": "Cuerpo",
          "api.response": "Respuesta",
          "api.authorizations": "Autorizaciones",
          "api.header": "Encabezado",
          "api.path": "Ruta",
          "api.query": "Consulta",
          "api.cookie": "Cookie",
          "api.authorization": "Autorizaci\xf3n",
          "api.required": "requerido",
          "api.deprecated": "obsoleto",
          "api.default": "predeterminado:",
          "api.noHeadersReceived": "No se recibieron encabezados del servidor",
          "api.noBodyReceived": "No se recibieron datos del cuerpo del servidor",
          "api.noCookiesReceived": "No se recibieron cookies del servidor",
          "api.example": "Ejemplo",
          "api.examples": "Ejemplos",
          "api.addNewProperty": "Agregar nueva propiedad",
          "api.enterPropertyKey": "Ingrese clave de nueva propiedad",
          "api.addItem": "Agregar un elemento",
          "api.searchEndpoint": "Buscar endpoint...",
          "api.connect": "Conectar",
          "api.disconnect": "Desconectar",
          "api.connected": "Conectado",
          "api.notConnected": "No conectado",
          "api.sendMessage": "Enviar mensaje",
          "api.receive": "Recibir",
          "api.requestError": "Se produjo un error al realizar la solicitud:",
          "api.mustBeMultipleOf": "Debe ser un m\xfaltiplo de",
          "api.title": "T\xedtulo",
          "api.const": "Constante",
          "api.enterValue": "ingresar {name}",
          "api.enterValueCapitalized": "Ingresar {name}",
          "api.selectOption": "seleccionar {name}",
          "api.enterBearerToken": "ingresar token de portador",
          "api.value": "valor",
          "api.option": "opci\xf3n",
          "prompt.copyPrompt": "Copiar prompt",
          "prompt.openInCursor": "Abrir en Cursor",
        },
        p = {
          language: "Fran\xe7ais",
          yes: "Oui",
          no: "Non",
          wasThisPageHelpful: "Cette page vous a-t-elle \xe9t\xe9 utile ?",
          onThisPage: "Sur cette page",
          suggestEdits: "Sugg\xe9rer des modifications",
          raiseIssue: "Signaler un probl\xe8me",
          search: "Rechercher...",
          poweredBy: "Propuls\xe9 par",
          filters: "Filtres",
          clear: "Effacer",
          previous: "Pr\xe9c\xe9dent",
          next: "Suivant",
          copyPage: "Copier la page",
          copying: "Copie en cours...",
          viewAsMarkdown: "Voir en Markdown",
          openInChatGPT: "Ouvrir dans ChatGPT",
          openInClaude: "Ouvrir dans Claude",
          openInPerplexity: "Ouvrir dans Perplexity",
          openInGrok: "Ouvrir dans Grok",
          copyPageAsMarkdown: "Copier la page en Markdown pour les LLMs",
          viewPageAsMarkdown: "Voir cette page en texte brut",
          askQuestionsAboutPage: "Poser des questions sur cette page",
          copyMCPServer: "Copier MCP Server",
          copyMCPServerDescription: "Copier l'URL du MCP Server dans le presse-papiers",
          copyAddMCPCommand: "Copier la commande d'installation MCP",
          copyAddMCPCommandDescription: "Copier la commande npx pour installer le serveur MCP",
          connectToCursor: "Se connecter \xe0 Cursor",
          installMCPServerOnCursor: "Installer MCP Server sur Cursor",
          connectToVSCode: "Se connecter \xe0 VS Code",
          installMCPServerOnVSCode: "Installer MCP Server sur VS Code",
          assistant: "Assistant",
          addToAssistant: "Ajouter \xe0 l'assistant",
          askAQuestion: "Poser une question...",
          askAIAssistant: "Poser une question \xe0 l'assistant",
          askAI: "Demander \xe0 l'IA",
          canYouTellMeAbout: "Peux-tu me parler de",
          recentSearches: "Recherches r\xe9centes",
          reportIncorrectCode: "Signaler un code incorrect",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Veuillez fournir une description d\xe9taill\xe9e du code incorrect.",
          whatIsWrongWithThisCode: "Qu'est-ce qui ne va pas avec ce code ?",
          submit: "Soumettre",
          cancel: "Annuler",
          "feedback.greatWhatWorkedBest":
            "Excellent ! Qu'est-ce qui a le mieux fonctionn\xe9 pour vous ?",
          "feedback.howCanWeImprove": "Comment pouvons-nous am\xe9liorer notre produit ?",
          "feedback.placeholder":
            "(Facultatif) Pourriez-vous partager davantage sur votre exp\xe9rience ?",
          "feedback.emailPlaceholder": "(Facultatif) E-mail",
          "feedback.invalidEmail": "Veuillez saisir une adresse e-mail valide",
          "feedback.cancel": "Annuler",
          "feedback.submit": "Envoyer les commentaires",
          "feedback.positive.workedAsExpected": "Le guide a fonctionn\xe9 comme pr\xe9vu",
          "feedback.positive.easyToFind":
            "Il \xe9tait facile de trouver les informations dont j'avais besoin",
          "feedback.positive.easyToUnderstand":
            "Il \xe9tait facile de comprendre le produit et les fonctionnalit\xe9s",
          "feedback.positive.upToDate": "La documentation est \xe0 jour",
          "feedback.positive.somethingElse": "Autre chose",
          "feedback.negative.getStartedFaster": "Aidez-moi \xe0 commencer plus rapidement",
          "feedback.negative.easierToFind": "Rendre plus facile de trouver ce que je cherche",
          "feedback.negative.easierToUnderstand":
            "Rendre plus facile de comprendre le produit et les fonctionnalit\xe9s",
          "feedback.negative.updateDocs": "Mettre \xe0 jour cette documentation",
          "feedback.negative.somethingElse": "Autre chose",
          "aria.openSearch": "Ouvrir la recherche",
          "aria.toggleAssistantPanel": "Basculer le panneau de l'assistant",
          "aria.searchForEndpoint": "Rechercher un endpoint",
          "aria.deleteItem": "Supprimer un \xe9l\xe9ment",
          "aria.toggleSection": "Basculer la section {section}",
          "aria.additionalFeedback": "Commentaires suppl\xe9mentaires (facultatif)",
          "aria.emailAddress": "Adresse e-mail",
          "aria.enterValue": "Saisir {name}",
          "aria.selectOption": "S\xe9lectionner {name}",
          "aria.sendMessage": "Envoyer un message",
          "aria.viewPayloadItem": "Voir {type}: {value}",
          "aria.removePayloadItem": "Supprimer {type}: {value}",
          "aria.fileUploadButton": "Bouton de t\xe9l\xe9chargement de fichier",
          "aria.expandMessageSection": "D\xe9velopper la section d'exemple de message",
          "aria.moreActions": "Plus d'actions",
          "aria.openRssFeed": "Ouvrir le flux RSS",
          "aria.info": "Information",
          "aria.warning": "Avertissement",
          "aria.danger": "Danger",
          "aria.tip": "Conseil",
          "aria.note": "Note",
          "aria.check": "V\xe9rifier",
          "aria.toggleDarkMode": "Basculer le mode sombre",
          "aria.expandInputSection": "D\xe9velopper la section d'entr\xe9e",
          "aria.reloadChat": "Recharger le chat",
          "aria.reloadLastChat": "Recharger le dernier chat",
          "aria.copyChatResponse": "Copier la r\xe9ponse du chat",
          "aria.voteGood": "Voter que la r\xe9ponse \xe9tait bonne",
          "aria.voteBad": "Voter que la r\xe9ponse n'\xe9tait pas bonne",
          "aria.navigateToHeader": "Naviguer vers l'en-t\xeate",
          "aria.navigateToChangelog": "Naviguer vers le journal des modifications",
          "aria.copyCodeBlock": "Copier le contenu du bloc de code",
          "aria.askAI": "Demander \xe0 l'IA",
          "aria.reportIncorrectCode": "Signaler un code incorrect",
          "aria.skipToMainContent": "Passer au contenu principal",
          "aria.switchToTheme": "Passer au th\xe8me {theme}",
          "aria.codeSnippet": "Extrait de code",
          "aria.messageContent": "Contenu du message",
          "aria.basePathSelector": "S\xe9lectionner le chemin de base",
          "aria.selectBaseUrl": "S\xe9lectionner l'URL de base",
          "aria.dismissBanner": "Fermer la banni\xe8re",
          "aria.selectResponseSection": "S\xe9lectionner la section de r\xe9ponse",
          "aria.sendingRequest": "Envoi de la demande...",
          "aria.selectSchemaType": "S\xe9lectionner le type de sch\xe9ma",
          "aria.minimizeResponse": "Minimiser la r\xe9ponse",
          "aria.expandResponse": "D\xe9velopper la r\xe9ponse",
          "aria.responseContent": "Contenu de la r\xe9ponse",
          "aria.fileDownloaded": "Fichier t\xe9l\xe9charg\xe9",
          "aria.downloadResponseFile": "T\xe9l\xe9charger le fichier de r\xe9ponse",
          "tooltip.copy": "Copier",
          "tooltip.copied": "Copi\xe9!",
          "tooltip.askAI": "Demander \xe0 l'IA",
          "tooltip.reportIncorrectCode": "Signaler un code incorrect",
          "tooltip.download": "T\xe9l\xe9charger",
          "assistant.suggestions": "Suggestions",
          availableOptions: "Options disponibles",
          requiredRange: "Plage requise",
          hide: "Masquer",
          show: "Afficher",
          childAttributes: "attributs enfants",
          copied: "Copi\xe9",
          copyFailed: "\xc9chec de la copie",
          "assistant.createSupportTicket": "Contacter le support",
          "assistant.disclaimer":
            "Les r\xe9ponses sont g\xe9n\xe9r\xe9es par IA et peuvent contenir des erreurs.",
          generating: "G\xe9n\xe9ration",
          searchingFor: "Recherche de",
          searched: "Recherch\xe9",
          foundResultsFor: "R\xe9sultats trouv\xe9s pour",
          tryIt: "Essayer",
          send: "Envoyer",
          "api.headers": "En-t\xeates",
          "api.pathParameters": "Param\xe8tres de chemin",
          "api.queryParameters": "Param\xe8tres de requ\xeate",
          "api.cookies": "Cookies",
          "api.body": "Corps",
          "api.response": "R\xe9ponse",
          "api.authorizations": "Autorisations",
          "api.header": "En-t\xeate",
          "api.path": "Chemin",
          "api.query": "Requ\xeate",
          "api.cookie": "Cookie",
          "api.authorization": "Autorisation",
          "api.required": "requis",
          "api.deprecated": "obsol\xe8te",
          "api.default": "d\xe9faut:",
          "api.noHeadersReceived": "Aucun en-t\xeate re\xe7u du serveur",
          "api.noBodyReceived": "Aucune donn\xe9e de corps re\xe7ue du serveur",
          "api.noCookiesReceived": "Aucun cookie re\xe7u du serveur",
          "api.example": "Exemple",
          "api.examples": "Exemples",
          "api.addNewProperty": "Ajouter une nouvelle propri\xe9t\xe9",
          "api.enterPropertyKey": "Entrez la cl\xe9 de la nouvelle propri\xe9t\xe9",
          "api.addItem": "Ajouter un \xe9l\xe9ment",
          "api.searchEndpoint": "Rechercher un endpoint...",
          "api.connect": "Connecter",
          "api.disconnect": "D\xe9connecter",
          "api.connected": "Connect\xe9",
          "api.notConnected": "Non connect\xe9",
          "api.sendMessage": "Envoyer un message",
          "api.receive": "Recevoir",
          "api.requestError": "Une erreur s'est produite lors de la requ\xeate:",
          "api.mustBeMultipleOf": "Doit \xeatre un multiple de",
          "api.title": "Titre",
          "api.const": "Constante",
          "api.enterValue": "entrer {name}",
          "api.enterValueCapitalized": "Entrer {name}",
          "api.selectOption": "s\xe9lectionner {name}",
          "api.enterBearerToken": "entrer le jeton porteur",
          "api.value": "valeur",
          "api.option": "option",
          "prompt.copyPrompt": "Copier le prompt",
          "prompt.openInCursor": "Ouvrir dans Cursor",
        },
        d = {
          language: "Fran\xe7ais canadien",
          yes: "Oui",
          no: "Non",
          wasThisPageHelpful: "Cette page vous a-t-elle \xe9t\xe9 utile ?",
          onThisPage: "Sur cette page",
          suggestEdits: "Sugg\xe9rer des modifications",
          raiseIssue: "Signaler un probl\xe8me",
          search: "Rechercher...",
          poweredBy: "Propuls\xe9 par",
          filters: "Filtres",
          clear: "Effacer",
          previous: "Pr\xe9c\xe9dent",
          next: "Suivant",
          copyPage: "Copier la page",
          copying: "Copie en cours...",
          viewAsMarkdown: "Voir en Markdown",
          openInChatGPT: "Ouvrir dans ChatGPT",
          openInClaude: "Ouvrir dans Claude",
          openInPerplexity: "Ouvrir dans Perplexity",
          openInGrok: "Ouvrir dans Grok",
          copyPageAsMarkdown: "Copier la page en Markdown pour les LLMs",
          viewPageAsMarkdown: "Voir cette page en texte brut",
          askQuestionsAboutPage: "Poser des questions sur cette page",
          copyMCPServer: "Copier MCP Server",
          copyMCPServerDescription: "Copier l'URL du MCP Server dans le presse-papiers",
          copyAddMCPCommand: "Copier la commande d'installation MCP",
          copyAddMCPCommandDescription: "Copier la commande npx pour installer le serveur MCP",
          connectToCursor: "Se connecter \xe0 Cursor",
          installMCPServerOnCursor: "Installer MCP Server sur Cursor",
          connectToVSCode: "Se connecter \xe0 VS Code",
          installMCPServerOnVSCode: "Installer MCP Server sur VS Code",
          assistant: "Assistant",
          addToAssistant: "Ajouter \xe0 l'assistant",
          askAQuestion: "Poser une question...",
          askAIAssistant: "Poser une question \xe0 l'assistant",
          askAI: "Demander \xe0 l'IA",
          canYouTellMeAbout: "Peux-tu me parler de",
          recentSearches: "Recherches r\xe9centes",
          reportIncorrectCode: "Signaler un code incorrect",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Veuillez fournir une description d\xe9taill\xe9e du code incorrect.",
          whatIsWrongWithThisCode: "Qu'est-ce qui ne va pas avec ce code ?",
          submit: "Soumettre",
          cancel: "Annuler",
          "feedback.greatWhatWorkedBest":
            "Excellent ! Qu'est-ce qui a le mieux fonctionn\xe9 pour vous ?",
          "feedback.howCanWeImprove": "Comment pouvons-nous am\xe9liorer notre produit ?",
          "feedback.placeholder":
            "(Facultatif) Pourriez-vous partager davantage sur votre exp\xe9rience ?",
          "feedback.emailPlaceholder": "(Facultatif) Courriel",
          "feedback.invalidEmail": "Veuillez entrer une adresse courriel valide",
          "feedback.cancel": "Annuler",
          "feedback.submit": "Envoyer les commentaires",
          "feedback.positive.workedAsExpected": "Le guide a fonctionn\xe9 comme pr\xe9vu",
          "feedback.positive.easyToFind":
            "Il \xe9tait facile de trouver les informations dont j'avais besoin",
          "feedback.positive.easyToUnderstand":
            "Il \xe9tait facile de comprendre le produit et les fonctionnalit\xe9s",
          "feedback.positive.upToDate": "La documentation est \xe0 jour",
          "feedback.positive.somethingElse": "Autre chose",
          "feedback.negative.getStartedFaster": "Aidez-moi \xe0 commencer plus rapidement",
          "feedback.negative.easierToFind": "Rendre plus facile de trouver ce que je cherche",
          "feedback.negative.easierToUnderstand":
            "Rendre plus facile de comprendre le produit et les fonctionnalit\xe9s",
          "feedback.negative.updateDocs": "Mettre \xe0 jour cette documentation",
          "feedback.negative.somethingElse": "Autre chose",
          "aria.openSearch": "Ouvrir la recherche",
          "aria.toggleAssistantPanel": "Basculer le panneau de l'assistant",
          "aria.searchForEndpoint": "Rechercher un endpoint",
          "aria.deleteItem": "Supprimer un \xe9l\xe9ment",
          "aria.toggleSection": "Basculer la section {section}",
          "aria.additionalFeedback": "Commentaires suppl\xe9mentaires (facultatif)",
          "aria.emailAddress": "Adresse courriel",
          "aria.enterValue": "Saisir {name}",
          "aria.selectOption": "S\xe9lectionner {name}",
          "aria.sendMessage": "Envoyer un message",
          "aria.viewPayloadItem": "Voir {type}: {value}",
          "aria.removePayloadItem": "Supprimer {type}: {value}",
          "aria.fileUploadButton": "Bouton de t\xe9l\xe9versement de fichier",
          "aria.expandMessageSection": "D\xe9velopper la section d'exemple de message",
          "aria.moreActions": "Plus d'actions",
          "aria.openRssFeed": "Ouvrir le flux RSS",
          "aria.info": "Information",
          "aria.warning": "Avertissement",
          "aria.danger": "Danger",
          "aria.tip": "Conseil",
          "aria.note": "Note",
          "aria.check": "V\xe9rifier",
          "aria.toggleDarkMode": "Basculer le mode sombre",
          "aria.expandInputSection": "D\xe9velopper la section d'entr\xe9e",
          "aria.reloadChat": "Recharger le clavardage",
          "aria.reloadLastChat": "Recharger le dernier clavardage",
          "aria.copyChatResponse": "Copier la r\xe9ponse du clavardage",
          "aria.voteGood": "Voter que la r\xe9ponse \xe9tait bonne",
          "aria.voteBad": "Voter que la r\xe9ponse n'\xe9tait pas bonne",
          "aria.navigateToHeader": "Naviguer vers l'en-t\xeate",
          "aria.navigateToChangelog": "Naviguer vers le journal des modifications",
          "aria.copyCodeBlock": "Copier le contenu du bloc de code",
          "aria.askAI": "Demander \xe0 l'IA",
          "aria.reportIncorrectCode": "Signaler un code incorrect",
          "aria.skipToMainContent": "Passer au contenu principal",
          "aria.switchToTheme": "Passer au th\xe8me {theme}",
          "aria.codeSnippet": "Extrait de code",
          "aria.messageContent": "Contenu du message",
          "aria.basePathSelector": "S\xe9lectionner le chemin de base",
          "aria.selectBaseUrl": "S\xe9lectionner l'URL de base",
          "aria.dismissBanner": "Fermer la banni\xe8re",
          "aria.selectResponseSection": "S\xe9lectionner la section de r\xe9ponse",
          "aria.sendingRequest": "Envoi de la demande...",
          "aria.selectSchemaType": "S\xe9lectionner le type de sch\xe9ma",
          "aria.minimizeResponse": "Minimiser la r\xe9ponse",
          "aria.expandResponse": "D\xe9velopper la r\xe9ponse",
          "aria.responseContent": "Contenu de la r\xe9ponse",
          "aria.fileDownloaded": "Fichier t\xe9l\xe9charg\xe9",
          "aria.downloadResponseFile": "T\xe9l\xe9charger le fichier de r\xe9ponse",
          "tooltip.copy": "Copier",
          "tooltip.copied": "Copi\xe9!",
          "tooltip.askAI": "Demander \xe0 l'IA",
          "tooltip.reportIncorrectCode": "Signaler un code incorrect",
          "tooltip.download": "T\xe9l\xe9charger",
          "assistant.suggestions": "Suggestions",
          availableOptions: "Options disponibles",
          requiredRange: "Plage requise",
          hide: "Masquer",
          show: "Afficher",
          childAttributes: "attributs enfants",
          copied: "Copi\xe9",
          copyFailed: "\xc9chec de la copie",
          "assistant.createSupportTicket": "Contacter le support",
          "assistant.disclaimer":
            "Les r\xe9ponses sont g\xe9n\xe9r\xe9es par IA et peuvent contenir des erreurs.",
          generating: "G\xe9n\xe9ration",
          searchingFor: "Recherche de",
          searched: "Recherch\xe9",
          foundResultsFor: "R\xe9sultats trouv\xe9s pour",
          tryIt: "Essayer",
          send: "Envoyer",
          "api.headers": "En-t\xeates",
          "api.pathParameters": "Param\xe8tres de chemin",
          "api.queryParameters": "Param\xe8tres de requ\xeate",
          "api.cookies": "Cookies",
          "api.body": "Corps",
          "api.response": "R\xe9ponse",
          "api.authorizations": "Autorisations",
          "api.header": "En-t\xeate",
          "api.path": "Chemin",
          "api.query": "Requ\xeate",
          "api.cookie": "Cookie",
          "api.authorization": "Autorisation",
          "api.required": "requis",
          "api.deprecated": "obsol\xe8te",
          "api.default": "d\xe9faut:",
          "api.noHeadersReceived": "Aucun en-t\xeate re\xe7u du serveur",
          "api.noBodyReceived": "Aucune donn\xe9e de corps re\xe7ue du serveur",
          "api.noCookiesReceived": "Aucun cookie re\xe7u du serveur",
          "api.example": "Exemple",
          "api.examples": "Exemples",
          "api.addNewProperty": "Ajouter une nouvelle propri\xe9t\xe9",
          "api.enterPropertyKey": "Entrez la cl\xe9 de la nouvelle propri\xe9t\xe9",
          "api.addItem": "Ajouter un \xe9l\xe9ment",
          "api.searchEndpoint": "Rechercher un endpoint...",
          "api.connect": "Connecter",
          "api.disconnect": "D\xe9connecter",
          "api.connected": "Connect\xe9",
          "api.notConnected": "Non connect\xe9",
          "api.sendMessage": "Envoyer un message",
          "api.receive": "Recevoir",
          "api.requestError": "Une erreur s'est produite lors de la requ\xeate:",
          "api.mustBeMultipleOf": "Doit \xeatre un multiple de",
          "api.title": "Titre",
          "api.const": "Constante",
          "api.enterValue": "entrer {name}",
          "api.enterValueCapitalized": "Entrer {name}",
          "api.selectOption": "s\xe9lectionner {name}",
          "api.enterBearerToken": "entrer le jeton porteur",
          "api.value": "valeur",
          "api.option": "option",
          "prompt.copyPrompt": "Copier le prompt",
          "prompt.openInCursor": "Ouvrir dans Cursor",
        },
        l = {
          language: "עברית",
          yes: "כן",
          no: "לא",
          wasThisPageHelpful: "האם דף זה היה מועיל?",
          onThisPage: "בדף זה",
          suggestEdits: "הצע עריכות",
          raiseIssue: "דווח על בעיה",
          search: "חיפוש...",
          poweredBy: "מופעל על ידי",
          filters: "מסננים",
          clear: "נקה",
          previous: "הקודם",
          next: "הבא",
          copyPage: "העתק דף",
          copying: "מעתיק...",
          viewAsMarkdown: "הצג כ-Markdown",
          openInChatGPT: "פתח ב-ChatGPT",
          openInClaude: "פתח ב-Claude",
          openInPerplexity: "פתח ב-Perplexity",
          openInGrok: "פתח ב-Grok",
          copyPageAsMarkdown: "העתק דף כ-Markdown עבור LLM",
          viewPageAsMarkdown: "הצג דף זה כטקסט רגיל",
          askQuestionsAboutPage: "שאל שאלות על דף זה",
          copyMCPServer: "העתק שרת MCP",
          copyMCPServerDescription: "העתק URL של שרת MCP ללוח",
          copyAddMCPCommand: "העתק פקודת התקנת MCP",
          copyAddMCPCommandDescription: "העתק פקודת npx להתקנת שרת MCP",
          connectToCursor: "התחבר ל-Cursor",
          installMCPServerOnCursor: "התקן שרת MCP על Cursor",
          connectToVSCode: "התחבר ל-VS Code",
          installMCPServerOnVSCode: "התקן שרת MCP על VS Code",
          assistant: "עוזר",
          addToAssistant: "הוסף לעוזר",
          askAQuestion: "שאל שאלה...",
          askAIAssistant: "שאל את עוזר ה-AI",
          askAI: "שאל AI",
          canYouTellMeAbout: "האם תוכל לספר לי על",
          recentSearches: "חיפושים אחרונים",
          reportIncorrectCode: "דווח על קוד שגוי",
          pleaseProvideDetailsOfTheIncorrectCode: "אנא ספק תיאור מפורט של הקוד השגוי.",
          whatIsWrongWithThisCode: "מה לא בסדר עם הקוד הזה?",
          submit: "שלח",
          cancel: "בטל",
          "feedback.greatWhatWorkedBest": "מצוין! מה עבד הכי טוב?",
          "feedback.howCanWeImprove": "איך נוכל לשפר את המוצר שלנו?",
          "feedback.placeholder": "(אופציונלי) האם תוכל לשתף יותר על החוויה שלך?",
          "feedback.emailPlaceholder": '(אופציונלי) דוא"ל',
          "feedback.invalidEmail": 'אנא הזן כתובת דוא"ל תקינה',
          "feedback.cancel": "בטל",
          "feedback.submit": "שלח משוב",
          "feedback.positive.workedAsExpected": "המדריך עבד כצפוי",
          "feedback.positive.easyToFind": "היה קל למצוא את המידע שהייתי צריך",
          "feedback.positive.easyToUnderstand": "היה קל להבין את המוצר והתכונות",
          "feedback.positive.upToDate": "התיעוד מעודכן",
          "feedback.positive.somethingElse": "משהו אחר",
          "feedback.negative.getStartedFaster": "עזור לי להתחיל מהר יותר",
          "feedback.negative.easierToFind": "הקל למצוא את מה שאני מחפש",
          "feedback.negative.easierToUnderstand": "הקל להבין את המוצר והתכונות",
          "feedback.negative.updateDocs": "עדכן את התיעוד הזה",
          "feedback.negative.somethingElse": "משהו אחר",
          "aria.openSearch": "פתח חיפוש",
          "aria.toggleAssistantPanel": "החלף פאנל עוזר",
          "aria.searchForEndpoint": "חפש נקודת קצה",
          "aria.deleteItem": "מחק פריט",
          "aria.toggleSection": "החלף קטע {section}",
          "aria.additionalFeedback": "משוב נוסף (אופציונלי)",
          "aria.emailAddress": "כתובת אימייל",
          "aria.enterValue": "הזן {name}",
          "aria.selectOption": "בחר {name}",
          "aria.sendMessage": "שלח הודעה",
          "aria.viewPayloadItem": "הצג {type}: {value}",
          "aria.removePayloadItem": "הסר {type}: {value}",
          "aria.fileUploadButton": "כפתור העלאת קובץ",
          "aria.expandMessageSection": "הרחב קטע דוגמת הודעה",
          "aria.moreActions": "פעולות נוספות",
          "aria.openRssFeed": "פתח הזנת RSS",
          "aria.info": "מידע",
          "aria.warning": "אזהרה",
          "aria.danger": "סכנה",
          "aria.tip": "טיפ",
          "aria.note": "הערה",
          "aria.check": "בדוק",
          "aria.toggleDarkMode": "החלף מצב כהה",
          "aria.expandInputSection": "הרחב קטע קלט",
          "aria.reloadChat": "טען מחדש צ'אט",
          "aria.reloadLastChat": "טען מחדש צ'אט אחרון",
          "aria.copyChatResponse": "העתק תגובת צ'אט",
          "aria.voteGood": "הצבע שהתגובה הייתה טובה",
          "aria.voteBad": "הצבע שהתגובה לא הייתה טובה",
          "aria.navigateToHeader": "נווט לכותרת",
          "aria.navigateToChangelog": "נווט ליומן שינויים",
          "aria.copyCodeBlock": "העתק תוכן מבלוק קוד",
          "aria.askAI": "שאל AI",
          "aria.reportIncorrectCode": "דווח על קוד שגוי",
          "aria.skipToMainContent": "דלג לתוכן הראשי",
          "aria.switchToTheme": "עבור לערכת נושא {theme}",
          "aria.codeSnippet": "קטע קוד",
          "aria.messageContent": "תוכן הודעה",
          "aria.basePathSelector": "בחר נתיב בסיס",
          "aria.selectBaseUrl": "בחר URL בסיס",
          "aria.dismissBanner": "סגור באנר",
          "aria.selectResponseSection": "בחר קטע תגובה",
          "aria.sendingRequest": "שולח בקשה...",
          "aria.selectSchemaType": "בחר סוג סכמה",
          "aria.minimizeResponse": "מזער תגובה",
          "aria.expandResponse": "הרחב תגובה",
          "aria.responseContent": "תוכן תגובה",
          "aria.fileDownloaded": "קובץ הורד",
          "aria.downloadResponseFile": "הורד קובץ תגובה",
          "tooltip.copy": "העתק",
          "tooltip.copied": "הועתק!",
          "tooltip.askAI": "שאל AI",
          "tooltip.reportIncorrectCode": "דווח על קוד שגוי",
          "tooltip.download": "הורד",
          "assistant.suggestions": "הצעות",
          availableOptions: "אפשרויות זמינות",
          requiredRange: "טווח נדרש",
          hide: "הסתר",
          show: "הצג",
          childAttributes: "תכונות ילד",
          copied: "הועתק",
          copyFailed: "ההעתקה נכשלה",
          "assistant.createSupportTicket": "צור קשר עם התמיכה",
          "assistant.disclaimer": "תגובות נוצרות באמצעות AI ועלולות להכיל טעויות.",
          generating: "מייצר",
          searchingFor: "מחפש",
          searched: "נחפש",
          foundResultsFor: "נמצאו תוצאות עבור",
          tryIt: "נסה זאת",
          send: "שלח",
          "api.headers": "כותרות",
          "api.pathParameters": "פרמטרי נתיב",
          "api.queryParameters": "פרמטרי שאילתה",
          "api.cookies": "עוגיות",
          "api.body": "גוף",
          "api.response": "תגובה",
          "api.authorizations": "הרשאות",
          "api.header": "כותרת",
          "api.path": "נתיב",
          "api.query": "שאילתה",
          "api.cookie": "עוגיה",
          "api.authorization": "הרשאה",
          "api.required": "נדרש",
          "api.deprecated": "מיושן",
          "api.default": "ברירת מחדל:",
          "api.noHeadersReceived": "לא התקבלו כותרות מהשרת",
          "api.noBodyReceived": "לא התקבלו נתוני גוף מהשרת",
          "api.noCookiesReceived": "לא התקבלו עוגיות מהשרת",
          "api.example": "דוגמה",
          "api.examples": "דוגמאות",
          "api.addNewProperty": "הוסף מאפיין חדש",
          "api.enterPropertyKey": "הזן מפתח מאפיין חדש",
          "api.addItem": "הוסף פריט",
          "api.searchEndpoint": "חפש נקודת קצה...",
          "api.connect": "התחבר",
          "api.disconnect": "התנתק",
          "api.connected": "מחובר",
          "api.notConnected": "לא מחובר",
          "api.sendMessage": "שלח הודעה",
          "api.receive": "קבל",
          "api.requestError": "אירעה שגיאה בעת ביצוע הבקשה:",
          "api.mustBeMultipleOf": "חייב להיות כפולה של",
          "api.title": "כותרת",
          "api.const": "קבוע",
          "api.enterValue": "הזן {name}",
          "api.enterValueCapitalized": "הזן {name}",
          "api.selectOption": "בחר {name}",
          "api.enterBearerToken": "הזן Bearer token",
          "api.value": "ערך",
          "api.option": "אפשרות",
          "prompt.copyPrompt": "העתק פרומפט",
          "prompt.openInCursor": "פתח ב-Cursor",
        },
        c = {
          language: "Hindi",
          yes: "यस",
          no: "नो",
          wasThisPageHelpful: "वाज़ दिस पेज हेल्पफुल",
          onThisPage: "ऑन दिस पेज",
          suggestEdits: "सजेस्ट एडिट्स",
          raiseIssue: "रेज़ इश्यू",
          search: "सर्च...",
          poweredBy: "पावर्ड बाय",
          filters: "फिल्टर्स",
          clear: "क्लियर फिल्टर्स",
          previous: "प्रीवियस",
          next: "नेक्स्ट",
          copyPage: "कॉपी पेज",
          copying: "कॉपी हो रहा है...",
          viewAsMarkdown: "व्यू एज़ मार्कडाउन",
          openInChatGPT: "ओपन इन चैटजीपीटी",
          openInClaude: "ओपन इन क्लॉड",
          openInPerplexity: "ओपन इन पर्प्लेक्सिटी",
          openInGrok: "ओपन इन ग्रोक",
          copyPageAsMarkdown: "कॉपी पेज एज़ मार्कडाउन",
          viewPageAsMarkdown: "व्यू पेज एज़ मार्कडाउन",
          askQuestionsAboutPage: "आस्क क्वेश्चन्स अबाउट पेज",
          copyMCPServer: "MCP Server कॉपी करें",
          copyMCPServerDescription: "MCP Server URL को क्लिपबोर्ड में कॉपी करें",
          copyAddMCPCommand: "MCP इंस्टॉल कमांड कॉपी करें",
          copyAddMCPCommandDescription: "MCP सर्वर इंस्टॉल करने के लिए npx कमांड कॉपी करें",
          connectToCursor: "Cursor से कनेक्ट करें",
          installMCPServerOnCursor: "Cursor में MCP Server इंस्टॉल करें",
          connectToVSCode: "VS Code से कनेक्ट करें",
          installMCPServerOnVSCode: "VS Code में MCP Server इंस्टॉल करें",
          assistant: "असिस्टेंट",
          addToAssistant: "असिस्टेंट में जोड़ें",
          askAQuestion: "आस्क अ क्वेश्चन...",
          askAIAssistant: "आस्क एआई असिस्टेंट",
          askAI: "AI से पूछें",
          canYouTellMeAbout: "कैन यू टेल मी अबाउट",
          recentSearches: "हालिया खोज",
          reportIncorrectCode: "गलत कोड की रिपोर्ट करें",
          pleaseProvideDetailsOfTheIncorrectCode: "कृपया गलत कोड का विस्तृत विवरण प्रदान करें।",
          whatIsWrongWithThisCode: "इस कोड में क्या गलत है?",
          submit: "सबमिट करें",
          cancel: "रद्द करें",
          "feedback.greatWhatWorkedBest": "शानदार! आपके लिए क्या सबसे अच्छा काम किया?",
          "feedback.howCanWeImprove": "हम अपने प्रोडक्ट को कैसे इम्प्रूव कर सकते हैं?",
          "feedback.placeholder": "(वैकल्पिक) क्या आप अपने अनुभव के बारे में और बता सकते हैं?",
          "feedback.emailPlaceholder": "(वैकल्पिक) ईमेल",
          "feedback.invalidEmail": "कृपया एक मान्य ईमेल पता दर्ज करें",
          "feedback.cancel": "कैंसल",
          "feedback.submit": "फीडबैक भेजें",
          "feedback.positive.workedAsExpected": "गाइड उम्मीद के मुताबिक काम किया",
          "feedback.positive.easyToFind": "जो जानकारी चाहिए थी वो आसानी से मिल गई",
          "feedback.positive.easyToUnderstand": "प्रोडक्ट और फीचर्स समझना आसान था",
          "feedback.positive.upToDate": "डॉक्यूमेंटेशन अप-टू-डेट है",
          "feedback.positive.somethingElse": "कुछ और",
          "feedback.negative.getStartedFaster": "मुझे जल्दी शुरू करने में मदद करें",
          "feedback.negative.easierToFind": "जो मैं ढूंढ रहा हूं वो खोजना आसान बनाएं",
          "feedback.negative.easierToUnderstand": "प्रोडक्ट और फीचर्स समझना आसान बनाएं",
          "feedback.negative.updateDocs": "इस डॉक्यूमेंटेशन को अपडेट करें",
          "feedback.negative.somethingElse": "कुछ और",
          "aria.openSearch": "खोज खोलें",
          "aria.toggleAssistantPanel": "असिस्टेंट पैनल टॉगल करें",
          "aria.searchForEndpoint": "एंडपौइंट खोजें",
          "aria.deleteItem": "आइटम डिलीट करें",
          "aria.toggleSection": "{section} सेक्शन टॉगल करें",
          "aria.additionalFeedback": "अतिरिक्त फीडबैक (वैकल्पिक)",
          "aria.emailAddress": "ईमेल पता",
          "aria.enterValue": "{name} दर्ज करें",
          "aria.selectOption": "{name} सेलेक्ट करें",
          "aria.sendMessage": "मेसेज भेजें",
          "aria.viewPayloadItem": "{type} देखें: {value}",
          "aria.removePayloadItem": "{type} हटाएं: {value}",
          "aria.fileUploadButton": "फाइल अपलोड बटन",
          "aria.expandMessageSection": "मैसेज उदाहरण सेक्शन विस्तार करें",
          "aria.moreActions": "अधिक कार्य",
          "aria.openRssFeed": "RSS फ़ीड खोलें",
          "aria.info": "जानकारी",
          "aria.warning": "चेतावनी",
          "aria.danger": "खतरा",
          "aria.tip": "टिप",
          "aria.note": "नोट",
          "aria.check": "चेक करें",
          "aria.toggleDarkMode": "डार्क मोड टॉगल करें",
          "aria.expandInputSection": "इनपुट सेक्शन विस्तार करें",
          "aria.reloadChat": "चैट रीलोड करें",
          "aria.reloadLastChat": "आखिरी चैट रीलोड करें",
          "aria.copyChatResponse": "चैट रिस्पांस कॉपी करें",
          "aria.voteGood": "वोट करें कि रिस्पांस अच्छा था",
          "aria.voteBad": "वोट करें कि रिस्पांस अच्छा नहीं था",
          "aria.navigateToHeader": "हेडर पर नेविगेट करें",
          "aria.navigateToChangelog": "चेंजलॉग पर नेविगेट करें",
          "aria.copyCodeBlock": "कोड ब्लॉक से कॉन्टेंट कॉपी करें",
          "aria.askAI": "AI से पूछें",
          "aria.reportIncorrectCode": "गलत कोड की रिपोर्ट करें",
          "aria.skipToMainContent": "मुख्य सामग्री पर जाएं",
          "aria.switchToTheme": "{theme} थीम पर स्विच करें",
          "aria.codeSnippet": "कोड स्निपेट",
          "aria.messageContent": "मेसेज कॉन्टेंट",
          "aria.basePathSelector": "बेस पाथ सेलेक्ट करें",
          "aria.selectBaseUrl": "बेस URL सेलेक्ट करें",
          "aria.dismissBanner": "बैनर बंद करें",
          "aria.selectResponseSection": "रिस्पांस सेक्शन सेलेक्ट करें",
          "aria.sendingRequest": "रिक्वेस्ट भेजी जा रही है...",
          "aria.selectSchemaType": "स्कीमा टाइप सेलेक्ट करें",
          "aria.minimizeResponse": "रिस्पांस को मिनिमाइज़ करें",
          "aria.expandResponse": "रिस्पांस को एक्सपैंड करें",
          "aria.responseContent": "रिस्पांस कॉन्टेंट",
          "aria.fileDownloaded": "फाइल डाउनलोड हो गई",
          "aria.downloadResponseFile": "रिस्पांस फाइल डाउनलोड करें",
          "tooltip.copy": "कॉपी करें",
          "tooltip.copied": "कॉपी हो गया!",
          "tooltip.askAI": "AI से पूछें",
          "tooltip.reportIncorrectCode": "गलत कोड की रिपोर्ट करें",
          "tooltip.download": "डाउनलोड करें",
          "assistant.suggestions": "सुझाव",
          availableOptions: "उपलब्ध विकल्प",
          requiredRange: "आवश्यक सीमा",
          hide: "छुपाएं",
          show: "दिखाएं",
          childAttributes: "चाइल्ड एट्रिब्यूट्स",
          copied: "कॉपी हो गया",
          copyFailed: "कॉपी विफल",
          "assistant.createSupportTicket": "सहायता से संपर्क करें",
          "assistant.disclaimer": "एआई द्वारा उत्पन्न उत्तरों में त्रुटियां हो सकती हैं।",
          generating: "जनरेट हो रहा है",
          searchingFor: "खोज रहा है",
          searched: "खोजा गया",
          foundResultsFor: "परिणाम मिले",
          tryIt: "आज़माएं",
          send: "भेजें",
          "api.headers": "हेडर",
          "api.pathParameters": "पथ पैरामीटर",
          "api.queryParameters": "क्वेरी पैरामीटर",
          "api.cookies": "कुकीज़",
          "api.body": "बॉडी",
          "api.response": "प्रतिक्रिया",
          "api.authorizations": "प्राधिकरण",
          "api.header": "हेडर",
          "api.path": "पथ",
          "api.query": "क्वेरी",
          "api.cookie": "कुकी",
          "api.authorization": "प्राधिकरण",
          "api.required": "आवश्यक",
          "api.deprecated": "अप्रचलित",
          "api.default": "डिफ़ॉल्ट:",
          "api.noHeadersReceived": "सर्वर से कोई हेडर प्राप्त नहीं हुआ",
          "api.noBodyReceived": "सर्वर से कोई बॉडी डेटा प्राप्त नहीं हुआ",
          "api.noCookiesReceived": "सर्वर से कोई कुकीज़ प्राप्त नहीं हुई",
          "api.example": "उदाहरण",
          "api.examples": "उदाहरण",
          "api.addNewProperty": "नई प्रॉपर्टी जोड़ें",
          "api.enterPropertyKey": "नई प्रॉपर्टी की कुंजी दर्ज करें",
          "api.addItem": "आइटम जोड़ें",
          "api.searchEndpoint": "एंडपॉइंट खोजें...",
          "api.connect": "कनेक्ट करें",
          "api.disconnect": "डिस्कनेक्ट करें",
          "api.connected": "कनेक्ट किया गया",
          "api.notConnected": "कनेक्ट नहीं है",
          "api.sendMessage": "संदेश भेजें",
          "api.receive": "प्राप्त करें",
          "api.requestError": "अनुरोध करते समय एक त्रुटि हुई:",
          "api.mustBeMultipleOf": "इसका गुणज होना चाहिए",
          "api.title": "शीर्षक",
          "api.const": "स्थिरांक",
          "api.enterValue": "{name} दर्ज करें",
          "api.enterValueCapitalized": "{name} दर्ज करें",
          "api.selectOption": "{name} चुनें",
          "api.enterBearerToken": "बियरर टोकन दर्ज करें",
          "api.value": "मान",
          "api.option": "विकल्प",
          "prompt.copyPrompt": "प्रॉम्प्ट कॉपी करें",
          "prompt.openInCursor": "Cursor में खोलें",
        },
        u = {
          language: "Bahasa Indonesia",
          yes: "Ya",
          no: "Tidak",
          wasThisPageHelpful: "Apakah halaman ini membantu?",
          onThisPage: "Di halaman ini",
          suggestEdits: "Sarankan suntingan",
          raiseIssue: "Ajukan masalah",
          search: "Cari...",
          poweredBy: "Didukung oleh",
          filters: "Filter",
          clear: "Hapus",
          previous: "Sebelumnya",
          next: "Selanjutnya",
          copyPage: "Salin halaman",
          copying: "Menyalin...",
          viewAsMarkdown: "Lihat sebagai Markdown",
          openInChatGPT: "Buka di ChatGPT",
          openInClaude: "Buka di Claude",
          openInPerplexity: "Buka di Perplexity",
          openInGrok: "Buka di Grok",
          copyPageAsMarkdown: "Salin halaman sebagai Markdown untuk LLMs",
          viewPageAsMarkdown: "Lihat halaman ini sebagai teks biasa",
          askQuestionsAboutPage: "Ajukan pertanyaan tentang halaman ini",
          copyMCPServer: "Salin MCP Server",
          copyMCPServerDescription: "Salin URL MCP Server ke clipboard",
          copyAddMCPCommand: "Salin perintah instal MCP",
          copyAddMCPCommandDescription: "Salin perintah npx untuk menginstal server MCP",
          connectToCursor: "Hubungkan ke Cursor",
          installMCPServerOnCursor: "Instal MCP Server di Cursor",
          connectToVSCode: "Hubungkan ke VS Code",
          installMCPServerOnVSCode: "Instal MCP Server di VS Code",
          assistant: "Asisten",
          addToAssistant: "Tambahkan ke asisten",
          askAQuestion: "Ajukan pertanyaan...",
          askAIAssistant: "Ajukan pertanyaan ke asisten",
          askAI: "Tanya AI",
          canYouTellMeAbout: "Bisakah kamu memberitahu saya tentang",
          recentSearches: "Pencarian terbaru",
          reportIncorrectCode: "Laporkan kode yang salah",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Harap berikan deskripsi detail tentang kode yang salah.",
          whatIsWrongWithThisCode: "Apa yang salah dengan kode ini?",
          submit: "Kirim",
          cancel: "Batal",
          "feedback.greatWhatWorkedBest": "Hebat! Apa yang paling berhasil untuk Anda?",
          "feedback.howCanWeImprove": "Bagaimana kami bisa meningkatkan produk kami?",
          "feedback.placeholder":
            "(Opsional) Bisakah Anda berbagi lebih banyak tentang pengalaman Anda?",
          "feedback.emailPlaceholder": "(Opsional) Email",
          "feedback.invalidEmail": "Masukkan alamat email yang valid",
          "feedback.cancel": "Batal",
          "feedback.submit": "Kirim umpan balik",
          "feedback.positive.workedAsExpected": "Panduan bekerja sesuai harapan",
          "feedback.positive.easyToFind": "Mudah menemukan informasi yang saya butuhkan",
          "feedback.positive.easyToUnderstand": "Mudah memahami produk dan fitur",
          "feedback.positive.upToDate": "Dokumentasi sudah terkini",
          "feedback.positive.somethingElse": "Lainnya",
          "feedback.negative.getStartedFaster": "Bantu saya memulai lebih cepat",
          "feedback.negative.easierToFind": "Buat lebih mudah menemukan yang saya cari",
          "feedback.negative.easierToUnderstand": "Buat lebih mudah memahami produk dan fitur",
          "feedback.negative.updateDocs": "Perbarui dokumentasi ini",
          "feedback.negative.somethingElse": "Lainnya",
          "aria.openSearch": "Buka pencarian",
          "aria.toggleAssistantPanel": "Toggle panel asisten",
          "aria.searchForEndpoint": "Cari endpoint",
          "aria.deleteItem": "Hapus item",
          "aria.toggleSection": "Toggle bagian {section}",
          "aria.additionalFeedback": "Umpan balik tambahan (opsional)",
          "aria.emailAddress": "Alamat email",
          "aria.enterValue": "Masukkan {name}",
          "aria.selectOption": "Pilih {name}",
          "aria.sendMessage": "Kirim pesan",
          "aria.viewPayloadItem": "Lihat {type}: {value}",
          "aria.removePayloadItem": "Hapus {type}: {value}",
          "aria.fileUploadButton": "Tombol unggah file",
          "aria.expandMessageSection": "Perluas bagian contoh pesan",
          "aria.moreActions": "Tindakan lainnya",
          "aria.openRssFeed": "Buka feed RSS",
          "aria.info": "Informasi",
          "aria.warning": "Peringatan",
          "aria.danger": "Bahaya",
          "aria.tip": "Tips",
          "aria.note": "Catatan",
          "aria.check": "Periksa",
          "aria.toggleDarkMode": "Beralih ke mode gelap",
          "aria.expandInputSection": "Perluas bagian input",
          "aria.reloadChat": "Muat ulang chat",
          "aria.reloadLastChat": "Muat ulang chat terakhir",
          "aria.copyChatResponse": "Salin respons chat",
          "aria.voteGood": "Beri suara bahwa respons itu bagus",
          "aria.voteBad": "Beri suara bahwa respons itu tidak bagus",
          "aria.navigateToHeader": "Navigasi ke header",
          "aria.navigateToChangelog": "Navigasi ke changelog",
          "aria.copyCodeBlock": "Salin konten dari blok kode",
          "aria.askAI": "Tanya AI",
          "aria.reportIncorrectCode": "Laporkan kode yang salah",
          "aria.skipToMainContent": "Langsung ke konten utama",
          "aria.switchToTheme": "Beralih ke tema {theme}",
          "aria.codeSnippet": "Cuplikan kode",
          "aria.messageContent": "Konten pesan",
          "aria.basePathSelector": "Pilih jalur dasar",
          "aria.selectBaseUrl": "Pilih URL dasar",
          "aria.dismissBanner": "Tutup banner",
          "aria.selectResponseSection": "Pilih bagian respons",
          "aria.sendingRequest": "Mengirim permintaan...",
          "aria.selectSchemaType": "Pilih tipe skema",
          "aria.minimizeResponse": "Minimalkan respons",
          "aria.expandResponse": "Perluas respons",
          "aria.responseContent": "Konten respons",
          "aria.fileDownloaded": "File diunduh",
          "aria.downloadResponseFile": "Unduh file respons",
          "tooltip.copy": "Salin",
          "tooltip.copied": "Disalin!",
          "tooltip.askAI": "Tanya AI",
          "tooltip.reportIncorrectCode": "Laporkan kode yang salah",
          "tooltip.download": "Unduh",
          "assistant.suggestions": "Saran",
          availableOptions: "Opsi yang tersedia",
          requiredRange: "Rentang yang diperlukan",
          hide: "Sembunyikan",
          show: "Tampilkan",
          childAttributes: "atribut turunan",
          copied: "Disalin",
          copyFailed: "Gagal menyalin",
          "assistant.createSupportTicket": "Hubungi dukungan",
          "assistant.disclaimer": "Respons dihasilkan oleh AI dan mungkin mengandung kesalahan.",
          generating: "Menghasilkan",
          searchingFor: "Mencari",
          searched: "Dicari",
          foundResultsFor: "Hasil ditemukan untuk",
          tryIt: "Coba",
          send: "Kirim",
          "api.headers": "Header",
          "api.pathParameters": "Parameter Path",
          "api.queryParameters": "Parameter Query",
          "api.cookies": "Cookie",
          "api.body": "Body",
          "api.response": "Respons",
          "api.authorizations": "Otorisasi",
          "api.header": "Header",
          "api.path": "Path",
          "api.query": "Query",
          "api.cookie": "Cookie",
          "api.authorization": "Otorisasi",
          "api.required": "wajib",
          "api.deprecated": "usang",
          "api.default": "default:",
          "api.noHeadersReceived": "Tidak ada header yang diterima dari server",
          "api.noBodyReceived": "Tidak ada data body yang diterima dari server",
          "api.noCookiesReceived": "Tidak ada cookie yang diterima dari server",
          "api.example": "Contoh",
          "api.examples": "Contoh",
          "api.addNewProperty": "Tambah properti baru",
          "api.enterPropertyKey": "Masukkan kunci properti baru",
          "api.addItem": "Tambah item",
          "api.searchEndpoint": "Cari endpoint...",
          "api.connect": "Hubungkan",
          "api.disconnect": "Putuskan",
          "api.connected": "Terhubung",
          "api.notConnected": "Tidak terhubung",
          "api.sendMessage": "Kirim pesan",
          "api.receive": "Terima",
          "api.requestError": "Terjadi kesalahan saat membuat permintaan:",
          "api.mustBeMultipleOf": "Harus merupakan kelipatan dari",
          "api.title": "Judul",
          "api.const": "Konstanta",
          "api.enterValue": "masukkan {name}",
          "api.enterValueCapitalized": "Masukkan {name}",
          "api.selectOption": "pilih {name}",
          "api.enterBearerToken": "masukkan bearer token",
          "api.value": "nilai",
          "api.option": "pilihan",
          "prompt.copyPrompt": "Salin prompt",
          "prompt.openInCursor": "Buka di Cursor",
        },
        g = {
          language: "Italiano",
          yes: "S\xec",
          no: "No",
          wasThisPageHelpful: "Questa pagina \xe8 stata utile?",
          onThisPage: "In questa pagina",
          suggestEdits: "Suggerisci modifiche",
          raiseIssue: "Segnala un problema",
          search: "Cerca...",
          poweredBy: "Offerto da",
          filters: "Filtri",
          clear: "Cancella",
          previous: "Precedente",
          next: "Successivo",
          copyPage: "Copia pagina",
          copying: "Copiando...",
          viewAsMarkdown: "Visualizza come Markdown",
          openInChatGPT: "Apri in ChatGPT",
          openInClaude: "Apri in Claude",
          openInPerplexity: "Apri in Perplexity",
          openInGrok: "Apri in Grok",
          copyPageAsMarkdown: "Copia pagina come Markdown per LLMs",
          viewPageAsMarkdown: "Visualizza questa pagina come testo semplice",
          askQuestionsAboutPage: "Fai domande su questa pagina",
          copyMCPServer: "Copia MCP Server",
          copyMCPServerDescription: "Copia URL del MCP Server negli appunti",
          copyAddMCPCommand: "Copia comando di installazione MCP",
          copyAddMCPCommandDescription: "Copia il comando npx per installare il server MCP",
          connectToCursor: "Connetti a Cursor",
          installMCPServerOnCursor: "Installa MCP Server su Cursor",
          connectToVSCode: "Connetti a VS Code",
          installMCPServerOnVSCode: "Installa MCP Server su VS Code",
          assistant: "Assistente",
          addToAssistant: "Aggiungi all'assistente",
          askAQuestion: "Fai una domanda...",
          askAIAssistant: "Fai una domanda all'assistente",
          askAI: "Chiedi all'IA",
          canYouTellMeAbout: "Puoi spiegarmi cosa",
          recentSearches: "Cerca recenti",
          reportIncorrectCode: "Segnala codice errato",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Si prega di fornire una descrizione dettagliata del codice errato.",
          whatIsWrongWithThisCode: "Cosa c'\xe8 di sbagliato in questo codice?",
          submit: "Invia",
          cancel: "Annulla",
          "feedback.greatWhatWorkedBest": "Ottimo! Cosa ha funzionato meglio per te?",
          "feedback.howCanWeImprove": "Come possiamo migliorare il nostro prodotto?",
          "feedback.placeholder":
            "(Facoltativo) Potresti condividere di pi\xf9 sulla tua esperienza?",
          "feedback.emailPlaceholder": "(Facoltativo) E-mail",
          "feedback.invalidEmail": "Inserisci un indirizzo e-mail valido",
          "feedback.cancel": "Annulla",
          "feedback.submit": "Invia feedback",
          "feedback.positive.workedAsExpected": "La guida ha funzionato come previsto",
          "feedback.positive.easyToFind":
            "\xc8 stato facile trovare le informazioni di cui avevo bisogno",
          "feedback.positive.easyToUnderstand":
            "\xc8 stato facile capire il prodotto e le funzionalit\xe0",
          "feedback.positive.upToDate": "La documentazione \xe8 aggiornata",
          "feedback.positive.somethingElse": "Qualcos'altro",
          "feedback.negative.getStartedFaster": "Aiutami a iniziare pi\xf9 velocemente",
          "feedback.negative.easierToFind": "Rendere pi\xf9 facile trovare quello che sto cercando",
          "feedback.negative.easierToUnderstand":
            "Rendere facile capire il prodotto e le funzionalit\xe0",
          "feedback.negative.updateDocs": "Aggiorna questa documentazione",
          "feedback.negative.somethingElse": "Qualcos'altro",
          "aria.openSearch": "Apri ricerca",
          "aria.toggleAssistantPanel": "Commuta pannello dell'assistente",
          "aria.searchForEndpoint": "Cerca endpoint",
          "aria.deleteItem": "Elimina elemento",
          "aria.toggleSection": "Commuta sezione {section}",
          "aria.additionalFeedback": "Feedback aggiuntivo (facoltativo)",
          "aria.emailAddress": "Indirizzo email",
          "aria.enterValue": "Inserisci {name}",
          "aria.selectOption": "Seleziona {name}",
          "aria.sendMessage": "Invia messaggio",
          "aria.viewPayloadItem": "Visualizza {type}: {value}",
          "aria.removePayloadItem": "Rimuovi {type}: {value}",
          "aria.fileUploadButton": "Pulsante di caricamento file",
          "aria.expandMessageSection": "Espandi sezione di esempio del messaggio",
          "aria.moreActions": "Pi\xf9 azioni",
          "aria.openRssFeed": "Apri feed RSS",
          "aria.info": "Informazione",
          "aria.warning": "Avviso",
          "aria.danger": "Pericolo",
          "aria.tip": "Suggerimento",
          "aria.note": "Nota",
          "aria.check": "Verifica",
          "aria.toggleDarkMode": "Attiva/disattiva modalit\xe0 scura",
          "aria.expandInputSection": "Espandi sezione di input",
          "aria.reloadChat": "Ricarica chat",
          "aria.reloadLastChat": "Ricarica ultima chat",
          "aria.copyChatResponse": "Copia risposta della chat",
          "aria.voteGood": "Vota che la risposta era buona",
          "aria.voteBad": "Vota che la risposta non era buona",
          "aria.navigateToHeader": "Vai all'intestazione",
          "aria.navigateToChangelog": "Vai al registro delle modifiche",
          "aria.copyCodeBlock": "Copia il contenuto del blocco di codice",
          "aria.askAI": "Chiedi all'IA",
          "aria.reportIncorrectCode": "Segnala codice errato",
          "aria.skipToMainContent": "Vai al contenuto principale",
          "aria.switchToTheme": "Passa al tema {theme}",
          "aria.codeSnippet": "Frammento di codice",
          "aria.messageContent": "Contenuto del messaggio",
          "aria.basePathSelector": "Seleziona percorso base",
          "aria.selectBaseUrl": "Seleziona URL base",
          "aria.dismissBanner": "Chiudi banner",
          "aria.selectResponseSection": "Seleziona sezione di risposta",
          "aria.sendingRequest": "Invio richiesta...",
          "aria.selectSchemaType": "Seleziona tipo di schema",
          "aria.minimizeResponse": "Minimizza risposta",
          "aria.expandResponse": "Espandi risposta",
          "aria.responseContent": "Contenuto della risposta",
          "aria.fileDownloaded": "File scaricato",
          "aria.downloadResponseFile": "Scarica file di risposta",
          "tooltip.copy": "Copia",
          "tooltip.copied": "Copiato!",
          "tooltip.askAI": "Chiedi all'IA",
          "tooltip.reportIncorrectCode": "Segnala codice errato",
          "tooltip.download": "Scarica",
          "assistant.suggestions": "Suggerimenti",
          availableOptions: "Opzioni disponibili",
          requiredRange: "Intervallo richiesto",
          hide: "Nascondi",
          show: "Mostra",
          childAttributes: "attributi figli",
          copied: "Copiato",
          copyFailed: "Copia fallita",
          "assistant.createSupportTicket": "Contatta il supporto",
          "assistant.disclaimer": "Le risposte sono generate da IA e possono contenere errori.",
          generating: "Generazione",
          searchingFor: "Ricerca di",
          searched: "Cercato",
          foundResultsFor: "Risultati trovati per",
          tryIt: "Provalo",
          send: "Invia",
          "api.headers": "Intestazioni",
          "api.pathParameters": "Parametri del percorso",
          "api.queryParameters": "Parametri della query",
          "api.cookies": "Cookie",
          "api.body": "Corpo",
          "api.response": "Risposta",
          "api.authorizations": "Autorizzazioni",
          "api.header": "Intestazione",
          "api.path": "Percorso",
          "api.query": "Query",
          "api.cookie": "Cookie",
          "api.authorization": "Autorizzazione",
          "api.required": "obbligatorio",
          "api.deprecated": "deprecato",
          "api.default": "predefinito:",
          "api.noHeadersReceived": "Nessuna intestazione ricevuta dal server",
          "api.noBodyReceived": "Nessun dato del corpo ricevuto dal server",
          "api.noCookiesReceived": "Nessun cookie ricevuto dal server",
          "api.example": "Esempio",
          "api.examples": "Esempi",
          "api.addNewProperty": "Aggiungi nuova propriet\xe0",
          "api.enterPropertyKey": "Inserisci chiave nuova propriet\xe0",
          "api.addItem": "Aggiungi un elemento",
          "api.searchEndpoint": "Cerca endpoint...",
          "api.connect": "Connetti",
          "api.disconnect": "Disconnetti",
          "api.connected": "Connesso",
          "api.notConnected": "Non connesso",
          "api.sendMessage": "Invia messaggio",
          "api.receive": "Ricevi",
          "api.requestError": "Si \xe8 verificato un errore durante la richiesta:",
          "api.mustBeMultipleOf": "Deve essere un multiplo di",
          "api.title": "Titolo",
          "api.const": "Costante",
          "api.enterValue": "inserisci {name}",
          "api.enterValueCapitalized": "Inserisci {name}",
          "api.selectOption": "seleziona {name}",
          "api.enterBearerToken": "inserisci token bearer",
          "api.value": "valore",
          "api.option": "opzione",
          "prompt.copyPrompt": "Copia prompt",
          "prompt.openInCursor": "Apri in Cursor",
        },
        m = {
          language: "日本語",
          yes: "はい",
          no: "いいえ",
          wasThisPageHelpful: "このページは役に立ちましたか？",
          onThisPage: "このページの内容",
          suggestEdits: "編集を提案",
          raiseIssue: "問題を報告",
          search: "検索...",
          poweredBy: "Powered by",
          filters: "フィルター",
          clear: "クリア",
          previous: "前へ",
          next: "次へ",
          copyPage: "ページをコピー",
          copying: "コピー中...",
          viewAsMarkdown: "マークダウンで表示",
          openInChatGPT: "ChatGPTで開く",
          openInClaude: "Claudeで開く",
          openInPerplexity: "Perplexityで開く",
          openInGrok: "Grokで開く",
          copyPageAsMarkdown: "LLMs用にMarkdownでページをコピー",
          viewPageAsMarkdown: "このページをプレーンテキストで表示",
          askQuestionsAboutPage: "このページについて質問する",
          copyMCPServer: "MCPサーバーをコピー",
          copyMCPServerDescription: "MCP Server URLをクリップボードにコピー",
          copyAddMCPCommand: "MCPインストールコマンドをコピー",
          copyAddMCPCommandDescription: "MCPサーバーをインストールするnpxコマンドをコピー",
          connectToCursor: "Cursorに接続",
          installMCPServerOnCursor: "CursorにMCP Serverをインストール",
          connectToVSCode: "VS Codeに接続",
          installMCPServerOnVSCode: "VS CodeにMCP Serverをインストール",
          assistant: "アシスタント",
          addToAssistant: "アシスタントに追加",
          askAQuestion: "質問する...",
          askAIAssistant: "AIアシスタントに質問する",
          askAI: "AIに質問",
          canYouTellMeAbout: "{query}について教えてください",
          recentSearches: "最近の検索",
          reportIncorrectCode: "不正なコードを報告",
          pleaseProvideDetailsOfTheIncorrectCode: "不正なコードの詳細な説明を提供してください。",
          whatIsWrongWithThisCode: "このコードの何が間違っていますか？",
          submit: "送信",
          cancel: "キャンセル",
          "feedback.greatWhatWorkedBest": "素晴らしい！何が一番うまくいきましたか？",
          "feedback.howCanWeImprove": "製品を改善するにはどうすればよいでしょうか？",
          "feedback.placeholder": "（任意）あなたの体験についてもう少し教えていただけますか？",
          "feedback.emailPlaceholder": "（任意）メールアドレス",
          "feedback.invalidEmail": "有効なメールアドレスを入力してください",
          "feedback.cancel": "キャンセル",
          "feedback.submit": "フィードバックを送信",
          "feedback.positive.workedAsExpected": "ガイドが期待通りに機能した",
          "feedback.positive.easyToFind": "必要な情報を簡単に見つけることができた",
          "feedback.positive.easyToUnderstand": "製品と機能を理解しやすかった",
          "feedback.positive.upToDate": "ドキュメントが最新である",
          "feedback.positive.somethingElse": "その他",
          "feedback.negative.getStartedFaster": "より早く始められるように手伝ってください",
          "feedback.negative.easierToFind": "探しているものをより見つけやすくしてください",
          "feedback.negative.easierToUnderstand": "製品と機能をより理解しやすくしてください",
          "feedback.negative.updateDocs": "このドキュメントを更新してください",
          "feedback.negative.somethingElse": "その他",
          "aria.openSearch": "検索を開く",
          "aria.toggleAssistantPanel": "アシスタントパネルを切り替え",
          "aria.searchForEndpoint": "エンドポイントを検索",
          "aria.deleteItem": "アイテムを削除",
          "aria.toggleSection": "{section}セクションを切り替え",
          "aria.additionalFeedback": "追加のフィードバック（任意）",
          "aria.emailAddress": "メールアドレス",
          "aria.enterValue": "{name}を入力",
          "aria.selectOption": "{name}を選択",
          "aria.sendMessage": "メッセージを送信",
          "aria.viewPayloadItem": "{type}を表示: {value}",
          "aria.removePayloadItem": "{type}を削除: {value}",
          "aria.fileUploadButton": "ファイルアップロードボタン",
          "aria.expandMessageSection": "メッセージ例セクションを展開",
          "aria.moreActions": "その他のアクション",
          "aria.openRssFeed": "RSSフィードを開く",
          "aria.info": "情報",
          "aria.warning": "警告",
          "aria.danger": "危険",
          "aria.tip": "ヒント",
          "aria.note": "ノート",
          "aria.check": "チェック",
          "aria.toggleDarkMode": "ダークモードを切り替え",
          "aria.expandInputSection": "入力セクションを展開",
          "aria.reloadChat": "チャットをリロード",
          "aria.reloadLastChat": "最後のチャットをリロード",
          "aria.copyChatResponse": "チャットの応答をコピー",
          "aria.voteGood": "応答が良かったと投票",
          "aria.voteBad": "応答が良くなかったと投票",
          "aria.navigateToHeader": "ヘッダーに移動",
          "aria.navigateToChangelog": "変更履歴に移動",
          "aria.copyCodeBlock": "コードブロックの内容をコピー",
          "aria.askAI": "AIに質問",
          "aria.reportIncorrectCode": "不正なコードを報告",
          "aria.skipToMainContent": "メインコンテンツへスキップ",
          "aria.switchToTheme": "{theme}テーマに切り替え",
          "aria.codeSnippet": "コードスニペット",
          "aria.messageContent": "メッセージの内容",
          "aria.basePathSelector": "ベースパスを選択",
          "aria.selectBaseUrl": "ベースURLを選択",
          "aria.dismissBanner": "バナーを閉じる",
          "aria.selectResponseSection": "レスポンスセクションを選択",
          "aria.sendingRequest": "リクエストを送信中...",
          "aria.selectSchemaType": "スキーマタイプを選択",
          "aria.minimizeResponse": "レスポンスを最小化",
          "aria.expandResponse": "レスポンスを展開",
          "aria.responseContent": "レスポンスの内容",
          "aria.fileDownloaded": "ファイルがダウンロードされました",
          "aria.downloadResponseFile": "レスポンスファイルをダウンロード",
          "tooltip.copy": "コピー",
          "tooltip.copied": "コピーしました!",
          "tooltip.askAI": "AIに質問",
          "tooltip.reportIncorrectCode": "不正なコードを報告",
          "tooltip.download": "ダウンロード",
          "assistant.suggestions": "提案",
          availableOptions: "利用可能なオプション",
          requiredRange: "必須範囲",
          hide: "非表示",
          show: "表示",
          childAttributes: "子属性",
          copied: "コピーしました",
          copyFailed: "コピーに失敗しました",
          "assistant.createSupportTicket": "サポートに連絡",
          "assistant.disclaimer": "AIにより生成された回答には誤りが含まれる可能性があります。",
          generating: "生成中",
          searchingFor: "検索中",
          searched: "検索済み",
          foundResultsFor: "検索結果",
          tryIt: "試す",
          send: "送信",
          "api.headers": "ヘッダー",
          "api.pathParameters": "パスパラメータ",
          "api.queryParameters": "クエリパラメータ",
          "api.cookies": "Cookie",
          "api.body": "ボディ",
          "api.response": "レスポンス",
          "api.authorizations": "承認",
          "api.header": "ヘッダー",
          "api.path": "パス",
          "api.query": "クエリ",
          "api.cookie": "Cookie",
          "api.authorization": "承認",
          "api.required": "必須",
          "api.deprecated": "非推奨",
          "api.default": "デフォルト:",
          "api.noHeadersReceived": "サーバーからヘッダーを受信しませんでした",
          "api.noBodyReceived": "サーバーからボディデータを受信しませんでした",
          "api.noCookiesReceived": "サーバーからCookieを受信しませんでした",
          "api.example": "例",
          "api.examples": "例",
          "api.addNewProperty": "新しいプロパティを追加",
          "api.enterPropertyKey": "新しいプロパティのキーを入力",
          "api.addItem": "アイテムを追加",
          "api.searchEndpoint": "エンドポイントを検索...",
          "api.connect": "接続",
          "api.disconnect": "切断",
          "api.connected": "接続済み",
          "api.notConnected": "未接続",
          "api.sendMessage": "メッセージを送信",
          "api.receive": "受信",
          "api.requestError": "リクエスト中にエラーが発生しました:",
          "api.mustBeMultipleOf": "次の倍数である必要があります",
          "api.title": "タイトル",
          "api.const": "定数",
          "api.enterValue": "{name} を入力",
          "api.enterValueCapitalized": "{name} を入力",
          "api.selectOption": "{name} を選択",
          "api.enterBearerToken": "Bearer トークンを入力",
          "api.value": "値",
          "api.option": "オプション",
          "prompt.copyPrompt": "プロンプトをコピー",
          "prompt.openInCursor": "Cursorで開く",
        },
        h = {
          language: "한국어",
          yes: "예",
          no: "아니오",
          wasThisPageHelpful: "이 페이지가 도움이 되었나요?",
          onThisPage: "이 페이지에서",
          suggestEdits: "수정 제안",
          raiseIssue: "문제 보고",
          search: "검색...",
          poweredBy: "Powered by",
          filters: "필터",
          clear: "지우기",
          previous: "이전",
          next: "다음",
          copyPage: "페이지 복사",
          copying: "복사 중...",
          viewAsMarkdown: "Markdown으로 보기",
          openInChatGPT: "ChatGPT에서 열기",
          openInClaude: "Claude에서 열기",
          openInPerplexity: "Perplexity에서 열기",
          openInGrok: "Grok에서 열기",
          copyPageAsMarkdown: "LLMs용 Markdown으로 페이지 복사",
          viewPageAsMarkdown: "이 페이지를 일반 텍스트로 보기",
          askQuestionsAboutPage: "이 페이지에 대해 질문하기",
          copyMCPServer: "MCP Server 복사",
          copyMCPServerDescription: "MCP Server URL을 클립보드에 복사",
          copyAddMCPCommand: "MCP 설치 명령어 복사",
          copyAddMCPCommandDescription: "MCP 서버 설치를 위한 npx 명령어 복사",
          connectToCursor: "Cursor에 연결",
          installMCPServerOnCursor: "Cursor에 MCP Server 설치",
          connectToVSCode: "VS Code에 연결",
          installMCPServerOnVSCode: "VS Code에 MCP Server 설치",
          assistant: "어시스턴트",
          addToAssistant: "어시스턴트에 추가",
          askAQuestion: "질문하기...",
          askAIAssistant: "AI 어시스턴트에 질문하기",
          askAI: "AI에게 묻기",
          canYouTellMeAbout: "이 페이지에 대해 설명해주세요",
          recentSearches: "최근 검색",
          reportIncorrectCode: "잘못된 코드 신고",
          pleaseProvideDetailsOfTheIncorrectCode: "잘못된 코드에 대한 자세한 설명을 제공해 주세요.",
          whatIsWrongWithThisCode: "이 코드의 무엇이 잘못되었나요?",
          submit: "제출",
          cancel: "취소",
          "feedback.greatWhatWorkedBest": "훌륭해요! 무엇이 가장 잘 작동했나요?",
          "feedback.howCanWeImprove": "저희 제품을 어떻게 개선할 수 있을까요?",
          "feedback.placeholder": "(선택사항) 귀하의 경험에 대해 더 자세히 알려주시겠어요?",
          "feedback.emailPlaceholder": "(선택사항) 이메일",
          "feedback.invalidEmail": "유효한 이메일 주소를 입력해주세요",
          "feedback.cancel": "취소",
          "feedback.submit": "피드백 제출",
          "feedback.positive.workedAsExpected": "가이드가 예상대로 작동했습니다",
          "feedback.positive.easyToFind": "필요한 정보를 쉽게 찾을 수 있었습니다",
          "feedback.positive.easyToUnderstand": "제품과 기능을 이해하기 쉬웠습니다",
          "feedback.positive.upToDate": "문서가 최신 상태입니다",
          "feedback.positive.somethingElse": "기타",
          "feedback.negative.getStartedFaster": "더 빨리 시작할 수 있도록 도와주세요",
          "feedback.negative.easierToFind": "찾고 있는 것을 더 쉽게 찾을 수 있도록 해주세요",
          "feedback.negative.easierToUnderstand": "제품과 기능을 더 쉽게 이해할 수 있도록 해주세요",
          "feedback.negative.updateDocs": "이 문서를 업데이트해 주세요",
          "feedback.negative.somethingElse": "기타",
          "aria.openSearch": "검색 열기",
          "aria.toggleAssistantPanel": "어시스턴트 패널 토글",
          "aria.searchForEndpoint": "엔드포인트 검색",
          "aria.deleteItem": "항목 삭제",
          "aria.toggleSection": "{section} 섹션 토글",
          "aria.additionalFeedback": "추가 피드백 (선택사항)",
          "aria.emailAddress": "이메일 주소",
          "aria.enterValue": "{name} 입력",
          "aria.selectOption": "{name} 선택",
          "aria.sendMessage": "메시지 보내기",
          "aria.viewPayloadItem": "{type} 보기: {value}",
          "aria.removePayloadItem": "{type} 제거: {value}",
          "aria.fileUploadButton": "파일 업로드 버튼",
          "aria.expandMessageSection": "메시지 예제 섹션 확장",
          "aria.moreActions": "더 많은 작업",
          "aria.openRssFeed": "RSS 피드 열기",
          "aria.info": "정보",
          "aria.warning": "경고",
          "aria.danger": "위험",
          "aria.tip": "팁",
          "aria.note": "참고",
          "aria.check": "확인",
          "aria.toggleDarkMode": "다크 모드 전환",
          "aria.expandInputSection": "입력 섹션 확장",
          "aria.reloadChat": "채팅 다시 로드",
          "aria.reloadLastChat": "마지막 채팅 다시 로드",
          "aria.copyChatResponse": "채팅 응답 복사",
          "aria.voteGood": "응답이 좋았다고 투표",
          "aria.voteBad": "응답이 좋지 않았다고 투표",
          "aria.navigateToHeader": "헤더로 이동",
          "aria.navigateToChangelog": "변경 로그로 이동",
          "aria.copyCodeBlock": "코드 블록에서 내용 복사",
          "aria.askAI": "AI에게 묻기",
          "aria.reportIncorrectCode": "잘못된 코드 신고",
          "aria.skipToMainContent": "메인 콘텐츠로 건너뛰기",
          "aria.switchToTheme": "{theme} 테마로 전환",
          "aria.codeSnippet": "코드 스니펫",
          "aria.messageContent": "메시지 내용",
          "aria.basePathSelector": "기본 경로 선택",
          "aria.selectBaseUrl": "기본 URL 선택",
          "aria.dismissBanner": "배너 닫기",
          "aria.selectResponseSection": "응답 섹션 선택",
          "aria.sendingRequest": "요청 전송 중...",
          "aria.selectSchemaType": "스키마 유형 선택",
          "aria.minimizeResponse": "응답 최소화",
          "aria.expandResponse": "응답 확장",
          "aria.responseContent": "응답 내용",
          "aria.fileDownloaded": "파일 다운로드됨",
          "aria.downloadResponseFile": "응답 파일 다운로드",
          "tooltip.copy": "복사",
          "tooltip.copied": "복사됨!",
          "tooltip.askAI": "AI에게 묻기",
          "tooltip.reportIncorrectCode": "잘못된 코드 신고",
          "tooltip.download": "다운로드",
          "assistant.suggestions": "제안",
          availableOptions: "사용 가능한 옵션",
          requiredRange: "필수 범위",
          hide: "숨기기",
          show: "표시",
          childAttributes: "하위 속성",
          copied: "복사됨",
          copyFailed: "복사 실패",
          "assistant.createSupportTicket": "지원팀 문의",
          "assistant.disclaimer": "AI가 생성한 답변에는 오류가 포함될 수 있습니다.",
          generating: "생성 중",
          searchingFor: "검색 중",
          searched: "검색됨",
          foundResultsFor: "검색 결과",
          tryIt: "시도하기",
          send: "전송",
          "api.headers": "헤더",
          "api.pathParameters": "경로 매개변수",
          "api.queryParameters": "쿼리 매개변수",
          "api.cookies": "Cookie",
          "api.body": "본문",
          "api.response": "응답",
          "api.authorizations": "인증",
          "api.header": "헤더",
          "api.path": "경로",
          "api.query": "쿼리",
          "api.cookie": "Cookie",
          "api.authorization": "인증",
          "api.required": "필수",
          "api.deprecated": "지원 중단",
          "api.default": "기본값:",
          "api.noHeadersReceived": "서버에서 헤더를 수신하지 못했습니다",
          "api.noBodyReceived": "서버에서 본문 데이터를 수신하지 못했습니다",
          "api.noCookiesReceived": "서버에서 Cookie를 수신하지 못했습니다",
          "api.example": "예시",
          "api.examples": "예시",
          "api.addNewProperty": "새 속성 추가",
          "api.enterPropertyKey": "새 속성 키 입력",
          "api.addItem": "항목 추가",
          "api.searchEndpoint": "엔드포인트 검색...",
          "api.connect": "연결",
          "api.disconnect": "연결 해제",
          "api.connected": "연결됨",
          "api.notConnected": "연결되지 않음",
          "api.sendMessage": "메시지 보내기",
          "api.receive": "수신",
          "api.requestError": "요청 중 오류가 발생했습니다:",
          "api.mustBeMultipleOf": "다음의 배수여야 합니다",
          "api.title": "제목",
          "api.const": "상수",
          "api.enterValue": "{name} 입력",
          "api.enterValueCapitalized": "{name} 입력",
          "api.selectOption": "{name} 선택",
          "api.enterBearerToken": "Bearer 토큰 입력",
          "api.value": "값",
          "api.option": "옵션",
          "prompt.copyPrompt": "프롬프트 복사",
          "prompt.openInCursor": "Cursor에서 열기",
        },
        f = {
          language: "Latviešu",
          yes: "Jā",
          no: "Nē",
          wasThisPageHelpful: "Vai šī lapa bija noderīga?",
          onThisPage: "Šajā lapā",
          suggestEdits: "Ieteikt labojumus",
          raiseIssue: "Ziņot par problēmu",
          search: "Meklēt...",
          poweredBy: "Darbina",
          filters: "Filtri",
          clear: "Notīrīt",
          previous: "Iepriekšējā",
          next: "Nākamā",
          copyPage: "Kopēt lapu",
          copying: "Kopē...",
          viewAsMarkdown: "Skatīt kā Markdown",
          openInChatGPT: "Atvērt ChatGPT",
          openInClaude: "Atvērt Claude",
          openInPerplexity: "Atvērt Perplexity",
          openInGrok: "Atvērt Grok",
          copyPageAsMarkdown: "Kopēt lapu kā Markdown LLM",
          viewPageAsMarkdown: "Skatīt šo lapu kā vienkāršu tekstu",
          askQuestionsAboutPage: "Uzdot jautājumus par šo lapu",
          copyMCPServer: "Kopēt MCP serveri",
          copyMCPServerDescription: "Kopēt MCP servera URL starpliktuvē",
          copyAddMCPCommand: "Kopēt MCP instalēšanas komandu",
          copyAddMCPCommandDescription: "Kopēt npx komandu MCP servera instalēšanai",
          connectToCursor: "Savienot ar Cursor",
          installMCPServerOnCursor: "Instalēt MCP serveri uz Cursor",
          connectToVSCode: "Savienot ar VS Code",
          installMCPServerOnVSCode: "Instalēt MCP serveri uz VS Code",
          assistant: "Asistents",
          addToAssistant: "Pievienot asistentam",
          askAQuestion: "Uzdot jautājumu...",
          askAIAssistant: "Jautāt AI asistentam",
          askAI: "Jautāt AI",
          canYouTellMeAbout: "Vai jūs varat pastāstīt par",
          recentSearches: "Pēdējie meklējumi",
          reportIncorrectCode: "Ziņot par nepareizu kodu",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Lūdzu, sniedziet detalizētu nepareizā koda aprakstu.",
          whatIsWrongWithThisCode: "Kas ir nepareizi ar šo kodu?",
          submit: "Iesniegt",
          cancel: "Atcelt",
          "feedback.greatWhatWorkedBest": "Lieliski! Kas jums vislabāk strādāja?",
          "feedback.howCanWeImprove": "Kā mēs varam uzlabot mūsu produktu?",
          "feedback.placeholder": "(Neobligāti) Vai varētu dalīties ar savu pieredzi?",
          "feedback.emailPlaceholder": "(Neobligāti) E-pasts",
          "feedback.invalidEmail": "Lūdzu, ievadiet derīgu e-pasta adresi",
          "feedback.cancel": "Atcelt",
          "feedback.submit": "Iesniegt atsauksmi",
          "feedback.positive.workedAsExpected": "Rokasgrāmata strādāja kā paredzēts",
          "feedback.positive.easyToFind": "Bija viegli atrast nepieciešamo informāciju",
          "feedback.positive.easyToUnderstand": "Bija viegli saprast produktu un funkcijas",
          "feedback.positive.upToDate": "Dokumentācija ir aktuāla",
          "feedback.positive.somethingElse": "Kaut kas cits",
          "feedback.negative.getStartedFaster": "Palīdziet man sākt ātrāk",
          "feedback.negative.easierToFind": "Padariet vieglāk atrast to, ko meklēju",
          "feedback.negative.easierToUnderstand": "Padariet viegli saprotamu produktu un funkcijas",
          "feedback.negative.updateDocs": "Atjauniniet šo dokumentāciju",
          "feedback.negative.somethingElse": "Kaut kas cits",
          "aria.openSearch": "Atvērt meklēšanu",
          "aria.toggleAssistantPanel": "Pārslēgt asistenta paneli",
          "aria.searchForEndpoint": "Meklēt galapunktu",
          "aria.deleteItem": "Dzēst vienumu",
          "aria.toggleSection": "Pārslēgt {section} sadaļu",
          "aria.additionalFeedback": "Papildu atsauksmes (neobligāti)",
          "aria.emailAddress": "E-pasta adrese",
          "aria.enterValue": "Ievadiet {name}",
          "aria.selectOption": "Atlasiet {name}",
          "aria.sendMessage": "Nosūtīt ziņojumu",
          "aria.viewPayloadItem": "Skatīt {type}: {value}",
          "aria.removePayloadItem": "Noņemt {type}: {value}",
          "aria.fileUploadButton": "Faila augšupielādes poga",
          "aria.expandMessageSection": "Izvērst ziņojuma piemēra sadaļu",
          "aria.moreActions": "Vairāk darbību",
          "aria.openRssFeed": "Atvērt RSS plūsmu",
          "aria.info": "Informācija",
          "aria.warning": "Brīdinājums",
          "aria.danger": "Briesmas",
          "aria.tip": "Padoms",
          "aria.note": "Piezīme",
          "aria.check": "Pārbaudīt",
          "aria.toggleDarkMode": "Pārslēgt tumšo režīmu",
          "aria.expandInputSection": "Izvērst ievades sadaļu",
          "aria.reloadChat": "Pārlādēt tērzēšanu",
          "aria.reloadLastChat": "Pārlādēt pēdējo tērzēšanu",
          "aria.copyChatResponse": "Kopēt tērzēšanas atbildi",
          "aria.voteGood": "Balsot, ka atbilde bija laba",
          "aria.voteBad": "Balsot, ka atbilde nebija laba",
          "aria.navigateToHeader": "Pāriet uz galveni",
          "aria.navigateToChangelog": "Pāriet uz izmaiņu žurnālu",
          "aria.copyCodeBlock": "Kopēt saturu no koda bloka",
          "aria.askAI": "Jautāt AI",
          "aria.reportIncorrectCode": "Ziņot par nepareizu kodu",
          "aria.skipToMainContent": "Pāriet uz galveno saturu",
          "aria.switchToTheme": "Pārslēgties uz {theme} tēmu",
          "aria.codeSnippet": "Koda fragments",
          "aria.messageContent": "Ziņojuma saturs",
          "aria.basePathSelector": "Atlasīt pamata ceļu",
          "aria.selectBaseUrl": "Atlasīt pamata URL",
          "aria.dismissBanner": "Aizvērt baneri",
          "aria.selectResponseSection": "Atlasīt atbildes sadaļu",
          "aria.sendingRequest": "Nosūta pieprasījumu...",
          "aria.selectSchemaType": "Atlasīt shēmas tipu",
          "aria.minimizeResponse": "Minimizēt atbildi",
          "aria.expandResponse": "Izvērst atbildi",
          "aria.responseContent": "Atbildes saturs",
          "aria.fileDownloaded": "Fails lejupielādēts",
          "aria.downloadResponseFile": "Lejupielādēt atbildes failu",
          "tooltip.copy": "Kopēt",
          "tooltip.copied": "Nokopēts!",
          "tooltip.askAI": "Jautāt AI",
          "tooltip.reportIncorrectCode": "Ziņot par nepareizu kodu",
          "tooltip.download": "Lejupielādēt",
          "assistant.suggestions": "Ieteikumi",
          availableOptions: "Pieejamās opcijas",
          requiredRange: "Nepieciešamais diapazons",
          hide: "Paslēpt",
          show: "Rādīt",
          childAttributes: "pakārtotie atribūti",
          copied: "Nokopēts",
          copyFailed: "Kopēšana neizdevās",
          "assistant.createSupportTicket": "Sazināties ar atbalstu",
          "assistant.disclaimer": "Atbildes ģenerē AI un tās var saturēt kļūdas.",
          generating: "Ģenerē",
          searchingFor: "Meklē",
          searched: "Meklēts",
          foundResultsFor: "Atrasti rezultāti",
          tryIt: "Izmēģināt",
          send: "Sūtīt",
          "api.headers": "Galvenes",
          "api.pathParameters": "Ceļa parametri",
          "api.queryParameters": "Vaicājuma parametri",
          "api.cookies": "Sīkfaili",
          "api.body": "Ķermenis",
          "api.response": "Atbilde",
          "api.authorizations": "Autorizācijas",
          "api.header": "Galvene",
          "api.path": "Ceļš",
          "api.query": "Vaicājums",
          "api.cookie": "Sīkfails",
          "api.authorization": "Autorizācija",
          "api.required": "obligāts",
          "api.deprecated": "novecojis",
          "api.default": "noklusējums:",
          "api.noHeadersReceived": "No servera nav saņemtas galvenes",
          "api.noBodyReceived": "No servera nav saņemti ķermeņa dati",
          "api.noCookiesReceived": "No servera nav saņemti sīkfaili",
          "api.example": "Piemērs",
          "api.examples": "Piemēri",
          "api.addNewProperty": "Pievienot jaunu īpašību",
          "api.enterPropertyKey": "Ievadiet jaunās īpašības atslēgu",
          "api.addItem": "Pievienot vienumu",
          "api.searchEndpoint": "Meklēt galapunktu...",
          "api.connect": "Savienot",
          "api.disconnect": "Atvienot",
          "api.connected": "Savienots",
          "api.notConnected": "Nav savienots",
          "api.sendMessage": "Sūtīt ziņojumu",
          "api.receive": "Saņemt",
          "api.requestError": "Veicot pieprasījumu, radās kļūda:",
          "api.mustBeMultipleOf": "Jābūt reizinātam ar",
          "api.title": "Nosaukums",
          "api.const": "Konstante",
          "api.enterValue": "ievadiet {name}",
          "api.enterValueCapitalized": "Ievadiet {name}",
          "api.selectOption": "izvēlieties {name}",
          "api.enterBearerToken": "ievadiet bearer token",
          "api.value": "vērtība",
          "api.option": "opcija",
          "prompt.copyPrompt": "Kopēt uzvedni",
          "prompt.openInCursor": "Atvērt Cursor",
        },
        v = {
          language: "Nederlands",
          yes: "Ja",
          no: "Nee",
          wasThisPageHelpful: "Was deze pagina nuttig?",
          onThisPage: "Op deze pagina",
          suggestEdits: "Wijzigingen voorstellen",
          raiseIssue: "Probleem melden",
          search: "Zoeken...",
          poweredBy: "Aangedreven door",
          filters: "Filters",
          clear: "Wissen",
          previous: "Vorige",
          next: "Volgende",
          copyPage: "Pagina kopi\xebren",
          copying: "Kopi\xebren...",
          viewAsMarkdown: "Bekijken als Markdown",
          openInChatGPT: "Openen in ChatGPT",
          openInClaude: "Openen in Claude",
          openInPerplexity: "Openen in Perplexity",
          openInGrok: "Openen in Grok",
          copyPageAsMarkdown: "Pagina kopi\xebren als Markdown voor LLM's",
          viewPageAsMarkdown: "Deze pagina bekijken als platte tekst",
          askQuestionsAboutPage: "Vragen stellen over deze pagina",
          copyMCPServer: "MCP Server kopi\xebren",
          copyMCPServerDescription: "MCP Server URL naar klembord kopi\xebren",
          copyAddMCPCommand: "MCP-installatieopdracht kopi\xebren",
          copyAddMCPCommandDescription: "npx-opdracht kopi\xebren om MCP-server te installeren",
          connectToCursor: "Verbinden met Cursor",
          installMCPServerOnCursor: "MCP Server installeren op Cursor",
          connectToVSCode: "Verbinden met VS Code",
          installMCPServerOnVSCode: "MCP Server installeren op VS Code",
          assistant: "Assistent",
          addToAssistant: "Toevoegen aan assistent",
          askAQuestion: "Een vraag stellen...",
          askAIAssistant: "AI-assistent vragen",
          askAI: "AI vragen",
          canYouTellMeAbout: "Kun je me vertellen over",
          recentSearches: "Recente zoekopdrachten",
          reportIncorrectCode: "Onjuiste code melden",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Geef alstublieft een gedetailleerde beschrijving van de onjuiste code.",
          whatIsWrongWithThisCode: "Wat is er verkeerd aan deze code?",
          submit: "Verzenden",
          cancel: "Annuleren",
          "feedback.greatWhatWorkedBest": "Geweldig! Wat werkte het beste voor jou?",
          "feedback.howCanWeImprove": "Hoe kunnen we ons product verbeteren?",
          "feedback.placeholder": "(Optioneel) Kun je meer vertellen over je ervaring?",
          "feedback.emailPlaceholder": "(Optioneel) E-mail",
          "feedback.invalidEmail": "Voer een geldig e-mailadres in",
          "feedback.cancel": "Annuleren",
          "feedback.submit": "Feedback verzenden",
          "feedback.positive.workedAsExpected": "De gids werkte zoals verwacht",
          "feedback.positive.easyToFind":
            "Het was gemakkelijk om de informatie te vinden die ik nodig had",
          "feedback.positive.easyToUnderstand":
            "Het was gemakkelijk om het product en de functies te begrijpen",
          "feedback.positive.upToDate": "De documentatie is up-to-date",
          "feedback.positive.somethingElse": "Iets anders",
          "feedback.negative.getStartedFaster": "Help me sneller aan de slag te gaan",
          "feedback.negative.easierToFind": "Maak het gemakkelijker om te vinden wat ik zoek",
          "feedback.negative.easierToUnderstand":
            "Maak het gemakkelijk om het product en de functies te begrijpen",
          "feedback.negative.updateDocs": "Deze documentatie bijwerken",
          "feedback.negative.somethingElse": "Iets anders",
          "aria.openSearch": "Zoekopdracht openen",
          "aria.toggleAssistantPanel": "Assistentenpaneel in-/uitschakelen",
          "aria.searchForEndpoint": "Zoeken naar endpoint",
          "aria.deleteItem": "Item verwijderen",
          "aria.toggleSection": "{section} sectie in-/uitschakelen",
          "aria.additionalFeedback": "Aanvullende feedback (optioneel)",
          "aria.emailAddress": "E-mailadres",
          "aria.enterValue": "{name} invoeren",
          "aria.selectOption": "{name} selecteren",
          "aria.sendMessage": "Bericht verzenden",
          "aria.viewPayloadItem": "Bekijk {type}: {value}",
          "aria.removePayloadItem": "Verwijder {type}: {value}",
          "aria.fileUploadButton": "Bestand uploadknop",
          "aria.expandMessageSection": "Berichtvoorbeeld sectie uitvouwen",
          "aria.moreActions": "Meer acties",
          "aria.openRssFeed": "RSS-feed openen",
          "aria.info": "Info",
          "aria.warning": "Waarschuwing",
          "aria.danger": "Gevaar",
          "aria.tip": "Tip",
          "aria.note": "Opmerking",
          "aria.check": "Controleren",
          "aria.toggleDarkMode": "Donkere modus in-/uitschakelen",
          "aria.expandInputSection": "Invoersectie uitvouwen",
          "aria.reloadChat": "Chat herladen",
          "aria.reloadLastChat": "Laatste chat herladen",
          "aria.copyChatResponse": "Chatantwoord kopi\xebren",
          "aria.voteGood": "Stemmen dat het antwoord goed was",
          "aria.voteBad": "Stemmen dat het antwoord niet goed was",
          "aria.navigateToHeader": "Naar koptekst navigeren",
          "aria.navigateToChangelog": "Naar wijzigingslogboek navigeren",
          "aria.copyCodeBlock": "Inhoud van codeblok kopi\xebren",
          "aria.askAI": "AI vragen",
          "aria.reportIncorrectCode": "Onjuiste code melden",
          "aria.skipToMainContent": "Naar hoofdinhoud gaan",
          "aria.switchToTheme": "Overschakelen naar {theme} thema",
          "aria.codeSnippet": "Codefragment",
          "aria.messageContent": "Berichtinhoud",
          "aria.basePathSelector": "Basispad selecteren",
          "aria.selectBaseUrl": "Basis-URL selecteren",
          "aria.dismissBanner": "Banner sluiten",
          "aria.selectResponseSection": "Antwoordsectie selecteren",
          "aria.sendingRequest": "Verzoek wordt verzonden...",
          "aria.selectSchemaType": "Schematype selecteren",
          "aria.minimizeResponse": "Antwoord minimaliseren",
          "aria.expandResponse": "Antwoord uitvouwen",
          "aria.responseContent": "Antwoordinhoud",
          "aria.fileDownloaded": "Bestand gedownload",
          "aria.downloadResponseFile": "Antwoordbestand downloaden",
          "tooltip.copy": "Kopi\xebren",
          "tooltip.copied": "Gekopieerd!",
          "tooltip.askAI": "AI vragen",
          "tooltip.reportIncorrectCode": "Onjuiste code melden",
          "tooltip.download": "Downloaden",
          "assistant.suggestions": "Suggesties",
          availableOptions: "Beschikbare opties",
          requiredRange: "Vereist bereik",
          hide: "Verbergen",
          show: "Tonen",
          childAttributes: "onderliggende attributen",
          copied: "Gekopieerd",
          copyFailed: "Kopi\xebren mislukt",
          "assistant.createSupportTicket": "Contact opnemen met ondersteuning",
          "assistant.disclaimer":
            "Antwoorden worden gegenereerd door AI en kunnen fouten bevatten.",
          generating: "Genereren",
          searchingFor: "Zoeken naar",
          searched: "Gezocht",
          foundResultsFor: "Resultaten gevonden voor",
          tryIt: "Probeer het",
          send: "Verzenden",
          "api.headers": "Headers",
          "api.pathParameters": "Padparameters",
          "api.queryParameters": "Queryparameters",
          "api.cookies": "Cookies",
          "api.body": "Body",
          "api.response": "Respons",
          "api.authorizations": "Autorisaties",
          "api.header": "Header",
          "api.path": "Pad",
          "api.query": "Query",
          "api.cookie": "Cookie",
          "api.authorization": "Autorisatie",
          "api.required": "vereist",
          "api.deprecated": "verouderd",
          "api.default": "standaard:",
          "api.noHeadersReceived": "Geen headers ontvangen van de server",
          "api.noBodyReceived": "Geen body-gegevens ontvangen van de server",
          "api.noCookiesReceived": "Geen cookies ontvangen van de server",
          "api.example": "Voorbeeld",
          "api.examples": "Voorbeelden",
          "api.addNewProperty": "Nieuwe eigenschap toevoegen",
          "api.enterPropertyKey": "Voer sleutel van nieuwe eigenschap in",
          "api.addItem": "Item toevoegen",
          "api.searchEndpoint": "Zoek endpoint...",
          "api.connect": "Verbinden",
          "api.disconnect": "Verbreken",
          "api.connected": "Verbonden",
          "api.notConnected": "Niet verbonden",
          "api.sendMessage": "Bericht verzenden",
          "api.receive": "Ontvangen",
          "api.requestError": "Er is een fout opgetreden bij het verzoek:",
          "api.mustBeMultipleOf": "Moet een veelvoud zijn van",
          "api.title": "Titel",
          "api.const": "Constante",
          "api.enterValue": "voer {name} in",
          "api.enterValueCapitalized": "Voer {name} in",
          "api.selectOption": "selecteer {name}",
          "api.enterBearerToken": "voer bearer-token in",
          "api.value": "waarde",
          "api.option": "optie",
          "prompt.copyPrompt": "Prompt kopi\xebren",
          "prompt.openInCursor": "Openen in Cursor",
        },
        y = {
          language: "Norsk",
          yes: "Ja",
          no: "Nei",
          wasThisPageHelpful: "Var denne siden nyttig?",
          onThisPage: "P\xe5 denne siden",
          suggestEdits: "Foresl\xe5 endringer",
          raiseIssue: "Rapporter problem",
          search: "S\xf8k...",
          poweredBy: "Drevet av",
          filters: "Filtre",
          clear: "T\xf8m",
          previous: "Forrige",
          next: "Neste",
          copyPage: "Kopier side",
          copying: "Kopierer...",
          viewAsMarkdown: "Vis som Markdown",
          openInChatGPT: "\xc5pne i ChatGPT",
          openInClaude: "\xc5pne i Claude",
          openInPerplexity: "\xc5pne i Perplexity",
          openInGrok: "\xc5pne i Grok",
          copyPageAsMarkdown: "Kopier side som Markdown for LLM-er",
          viewPageAsMarkdown: "Vis denne siden som ren tekst",
          askQuestionsAboutPage: "Still sp\xf8rsm\xe5l om denne siden",
          copyMCPServer: "Kopier MCP Server",
          copyMCPServerDescription: "Kopier MCP Server URL til utklippstavle",
          copyAddMCPCommand: "Kopier MCP-installasjonskommando",
          copyAddMCPCommandDescription: "Kopier npx-kommando for \xe5 installere MCP-server",
          connectToCursor: "Koble til Cursor",
          installMCPServerOnCursor: "Installer MCP Server p\xe5 Cursor",
          connectToVSCode: "Koble til VS Code",
          installMCPServerOnVSCode: "Installer MCP Server p\xe5 VS Code",
          assistant: "Assistent",
          addToAssistant: "Legg til i assistent",
          askAQuestion: "Still et sp\xf8rsm\xe5l...",
          askAIAssistant: "Sp\xf8r AI-assistent",
          askAI: "Sp\xf8r AI",
          canYouTellMeAbout: "Kan du fortelle meg om",
          recentSearches: "Nylige s\xf8k",
          reportIncorrectCode: "Rapporter feil kode",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Vennligst gi en detaljert beskrivelse av den feilaktige koden.",
          whatIsWrongWithThisCode: "Hva er galt med denne koden?",
          submit: "Send inn",
          cancel: "Avbryt",
          "feedback.greatWhatWorkedBest": "Flott! Hva fungerte best for deg?",
          "feedback.howCanWeImprove": "Hvordan kan vi forbedre produktet v\xe5rt?",
          "feedback.placeholder": "(Valgfritt) Kan du dele mer om opplevelsen din?",
          "feedback.emailPlaceholder": "(Valgfritt) E-post",
          "feedback.invalidEmail": "Vennligst skriv inn en gyldig e-postadresse",
          "feedback.cancel": "Avbryt",
          "feedback.submit": "Send tilbakemelding",
          "feedback.positive.workedAsExpected": "Guiden fungerte som forventet",
          "feedback.positive.easyToFind": "Det var lett \xe5 finne informasjonen jeg trengte",
          "feedback.positive.easyToUnderstand":
            "Det var lett \xe5 forst\xe5 produktet og funksjonene",
          "feedback.positive.upToDate": "Dokumentasjonen er oppdatert",
          "feedback.positive.somethingElse": "Noe annet",
          "feedback.negative.getStartedFaster": "Hjelp meg \xe5 komme i gang raskere",
          "feedback.negative.easierToFind": "Gj\xf8r det lettere \xe5 finne det jeg leter etter",
          "feedback.negative.easierToUnderstand":
            "Gj\xf8r det lett \xe5 forst\xe5 produktet og funksjonene",
          "feedback.negative.updateDocs": "Oppdater denne dokumentasjonen",
          "feedback.negative.somethingElse": "Noe annet",
          "aria.openSearch": "\xc5pne s\xf8k",
          "aria.toggleAssistantPanel": "Veksle assistentpanel",
          "aria.searchForEndpoint": "S\xf8k etter endepunkt",
          "aria.deleteItem": "Slett element",
          "aria.toggleSection": "Veksle {section} seksjon",
          "aria.additionalFeedback": "Ytterligere tilbakemelding (valgfritt)",
          "aria.emailAddress": "E-postadresse",
          "aria.enterValue": "Skriv inn {name}",
          "aria.selectOption": "Velg {name}",
          "aria.sendMessage": "Send melding",
          "aria.viewPayloadItem": "Vis {type}: {value}",
          "aria.removePayloadItem": "Fjern {type}: {value}",
          "aria.fileUploadButton": "Filopplastingsknapp",
          "aria.expandMessageSection": "Utvid meldingseksempel seksjon",
          "aria.moreActions": "Flere handlinger",
          "aria.openRssFeed": "\xc5pne RSS-feed",
          "aria.info": "Info",
          "aria.warning": "Advarsel",
          "aria.danger": "Fare",
          "aria.tip": "Tips",
          "aria.note": "Merk",
          "aria.check": "Sjekk",
          "aria.toggleDarkMode": "Veksle m\xf8rk modus",
          "aria.expandInputSection": "Utvid inndataseksjon",
          "aria.reloadChat": "Last inn chat p\xe5 nytt",
          "aria.reloadLastChat": "Last inn siste chat p\xe5 nytt",
          "aria.copyChatResponse": "Kopier chat-svar",
          "aria.voteGood": "Stem at svaret var bra",
          "aria.voteBad": "Stem at svaret ikke var bra",
          "aria.navigateToHeader": "Naviger til overskrift",
          "aria.navigateToChangelog": "Naviger til endringslogg",
          "aria.copyCodeBlock": "Kopier innholdet fra kodeblokken",
          "aria.askAI": "Sp\xf8r AI",
          "aria.reportIncorrectCode": "Rapporter feil kode",
          "aria.skipToMainContent": "Hopp til hovedinnhold",
          "aria.switchToTheme": "Bytt til {theme} tema",
          "aria.codeSnippet": "Kodebit",
          "aria.messageContent": "Meldingsinnhold",
          "aria.basePathSelector": "Velg basissti",
          "aria.selectBaseUrl": "Velg basis-URL",
          "aria.dismissBanner": "Lukk banner",
          "aria.selectResponseSection": "Velg svarsseksjon",
          "aria.sendingRequest": "Sender foresp\xf8rsel...",
          "aria.selectSchemaType": "Velg skjematype",
          "aria.minimizeResponse": "Minimer svar",
          "aria.expandResponse": "Utvid svar",
          "aria.responseContent": "Svarsinnhold",
          "aria.fileDownloaded": "Fil lastet ned",
          "aria.downloadResponseFile": "Last ned svarsfil",
          "tooltip.copy": "Kopier",
          "tooltip.copied": "Kopiert!",
          "tooltip.askAI": "Sp\xf8r AI",
          "tooltip.reportIncorrectCode": "Rapporter feil kode",
          "tooltip.download": "Last ned",
          "assistant.suggestions": "Forslag",
          availableOptions: "Tilgjengelige alternativer",
          requiredRange: "N\xf8dvendig omr\xe5de",
          hide: "Skjul",
          show: "Vis",
          childAttributes: "underordnede attributter",
          copied: "Kopiert",
          copyFailed: "Kopiering mislyktes",
          "assistant.createSupportTicket": "Kontakt support",
          "assistant.disclaimer": "Svar genereres av AI og kan inneholde feil.",
          generating: "Genererer",
          searchingFor: "S\xf8ker etter",
          searched: "S\xf8kt",
          foundResultsFor: "Fant resultater for",
          tryIt: "Pr\xf8v",
          send: "Send",
          "api.headers": "Overskrifter",
          "api.pathParameters": "Stien-parametere",
          "api.queryParameters": "Sp\xf8rring-parametere",
          "api.cookies": "Informasjonskapsler",
          "api.body": "Kropp",
          "api.response": "Svar",
          "api.authorizations": "Autorisasjoner",
          "api.header": "Overskrift",
          "api.path": "Sti",
          "api.query": "Sp\xf8rring",
          "api.cookie": "Informasjonskapsel",
          "api.authorization": "Autorisasjon",
          "api.required": "p\xe5krevd",
          "api.deprecated": "utdatert",
          "api.default": "standard:",
          "api.noHeadersReceived": "Ingen overskrifter mottatt fra serveren",
          "api.noBodyReceived": "Ingen kroppsdata mottatt fra serveren",
          "api.noCookiesReceived": "Ingen informasjonskapsler mottatt fra serveren",
          "api.example": "Eksempel",
          "api.examples": "Eksempler",
          "api.addNewProperty": "Legg til ny egenskap",
          "api.enterPropertyKey": "Skriv inn n\xf8kkel for ny egenskap",
          "api.addItem": "Legg til element",
          "api.searchEndpoint": "S\xf8k etter endepunkt...",
          "api.connect": "Koble til",
          "api.disconnect": "Koble fra",
          "api.connected": "Tilkoblet",
          "api.notConnected": "Ikke tilkoblet",
          "api.sendMessage": "Send melding",
          "api.receive": "Motta",
          "api.requestError": "Det oppstod en feil under foresp\xf8rselen:",
          "api.mustBeMultipleOf": "M\xe5 v\xe6re et multiplum av",
          "api.title": "Tittel",
          "api.const": "Konstant",
          "api.enterValue": "skriv inn {name}",
          "api.enterValueCapitalized": "Skriv inn {name}",
          "api.selectOption": "velg {name}",
          "api.enterBearerToken": "skriv inn bearer-token",
          "api.value": "verdi",
          "api.option": "alternativ",
          "prompt.copyPrompt": "Kopier prompt",
          "prompt.openInCursor": "\xc5pne i Cursor",
        },
        k = {
          language: "Polski",
          yes: "Tak",
          no: "Nie",
          wasThisPageHelpful: "Czy ta strona była pomocna?",
          onThisPage: "Na tej stronie",
          suggestEdits: "Zaproponuj edycje",
          raiseIssue: "Zgłoś problem",
          search: "Szukaj...",
          poweredBy: "Napędzane przez",
          filters: "Filtry",
          clear: "Wyczyść",
          previous: "Poprzedni",
          next: "Następny",
          copyPage: "Kopiuj stronę",
          copying: "Kopiowanie...",
          viewAsMarkdown: "Wyświetl jako Markdown",
          openInChatGPT: "Otw\xf3rz w ChatGPT",
          openInClaude: "Otw\xf3rz w Claude",
          openInPerplexity: "Otw\xf3rz w Perplexity",
          openInGrok: "Otw\xf3rz w Grok",
          copyPageAsMarkdown: "Kopiuj stronę jako Markdown dla LLM",
          viewPageAsMarkdown: "Wyświetl tę stronę jako zwykły tekst",
          askQuestionsAboutPage: "Zadaj pytania o tę stronę",
          copyMCPServer: "Kopiuj serwer MCP",
          copyMCPServerDescription: "Kopiuj URL serwera MCP do schowka",
          copyAddMCPCommand: "Kopiuj polecenie instalacji MCP",
          copyAddMCPCommandDescription: "Kopiuj polecenie npx do instalacji serwera MCP",
          connectToCursor: "Połącz z Cursor",
          installMCPServerOnCursor: "Zainstaluj serwer MCP na Cursor",
          connectToVSCode: "Połącz z VS Code",
          installMCPServerOnVSCode: "Zainstaluj serwer MCP na VS Code",
          assistant: "Asystent",
          addToAssistant: "Dodaj do asystenta",
          askAQuestion: "Zadaj pytanie...",
          askAIAssistant: "Zapytaj asystenta AI",
          askAI: "Zapytaj AI",
          canYouTellMeAbout: "Czy możesz mi powiedzieć o",
          recentSearches: "Ostatnie wyszukiwania",
          reportIncorrectCode: "Zgłoś nieprawidłowy kod",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Proszę podać szczeg\xf3łowy opis nieprawidłowego kodu.",
          whatIsWrongWithThisCode: "Co jest nie tak z tym kodem?",
          submit: "Wyślij",
          cancel: "Anuluj",
          "feedback.greatWhatWorkedBest": "Świetnie! Co działało najlepiej?",
          "feedback.howCanWeImprove": "Jak możemy poprawić nasz produkt?",
          "feedback.placeholder":
            "(Opcjonalnie) Czy możesz podzielić się więcej o swoim doświadczeniu?",
          "feedback.emailPlaceholder": "(Opcjonalnie) E-mail",
          "feedback.invalidEmail": "Proszę podać prawidłowy adres e-mail",
          "feedback.cancel": "Anuluj",
          "feedback.submit": "Wyślij opinię",
          "feedback.positive.workedAsExpected": "Przewodnik działał zgodnie z oczekiwaniami",
          "feedback.positive.easyToFind": "Łatwo znalazłem potrzebne informacje",
          "feedback.positive.easyToUnderstand": "Łatwo było zrozumieć produkt i funkcje",
          "feedback.positive.upToDate": "Dokumentacja jest aktualna",
          "feedback.positive.somethingElse": "Coś innego",
          "feedback.negative.getStartedFaster": "Pom\xf3ż mi zacząć szybciej",
          "feedback.negative.easierToFind": "Ułatw znalezienie tego, czego szukam",
          "feedback.negative.easierToUnderstand": "Ułatw zrozumienie produktu i funkcji",
          "feedback.negative.updateDocs": "Zaktualizuj tę dokumentację",
          "feedback.negative.somethingElse": "Coś innego",
          "aria.openSearch": "Otw\xf3rz wyszukiwanie",
          "aria.toggleAssistantPanel": "Przełącz panel asystenta",
          "aria.searchForEndpoint": "Szukaj endpointu",
          "aria.deleteItem": "Usuń element",
          "aria.toggleSection": "Przełącz sekcję {section}",
          "aria.additionalFeedback": "Dodatkowa opinia (opcjonalnie)",
          "aria.emailAddress": "Adres e-mail",
          "aria.enterValue": "Wprowadź {name}",
          "aria.selectOption": "Wybierz {name}",
          "aria.sendMessage": "Wyślij wiadomość",
          "aria.viewPayloadItem": "Zobacz {type}: {value}",
          "aria.removePayloadItem": "Usuń {type}: {value}",
          "aria.fileUploadButton": "Przycisk przesyłania pliku",
          "aria.expandMessageSection": "Rozwiń sekcję przykładu wiadomości",
          "aria.moreActions": "Więcej działań",
          "aria.openRssFeed": "Otw\xf3rz kanał RSS",
          "aria.info": "Info",
          "aria.warning": "Ostrzeżenie",
          "aria.danger": "Niebezpieczeństwo",
          "aria.tip": "Wskaz\xf3wka",
          "aria.note": "Uwaga",
          "aria.check": "Sprawdź",
          "aria.toggleDarkMode": "Przełącz tryb ciemny",
          "aria.expandInputSection": "Rozwiń sekcję wejścia",
          "aria.reloadChat": "Przeładuj czat",
          "aria.reloadLastChat": "Przeładuj ostatni czat",
          "aria.copyChatResponse": "Kopiuj odpowiedź czatu",
          "aria.voteGood": "Zagłosuj, że odpowiedź była dobra",
          "aria.voteBad": "Zagłosuj, że odpowiedź nie była dobra",
          "aria.navigateToHeader": "Przejdź do nagł\xf3wka",
          "aria.navigateToChangelog": "Przejdź do dziennika zmian",
          "aria.copyCodeBlock": "Kopiuj zawartość z bloku kodu",
          "aria.askAI": "Zapytaj AI",
          "aria.reportIncorrectCode": "Zgłoś nieprawidłowy kod",
          "aria.skipToMainContent": "Przejdź do gł\xf3wnej treści",
          "aria.switchToTheme": "Przełącz na motyw {theme}",
          "aria.codeSnippet": "Fragment kodu",
          "aria.messageContent": "Treść wiadomości",
          "aria.basePathSelector": "Wybierz ścieżkę bazową",
          "aria.selectBaseUrl": "Wybierz bazowy URL",
          "aria.dismissBanner": "Zamknij baner",
          "aria.selectResponseSection": "Wybierz sekcję odpowiedzi",
          "aria.sendingRequest": "Wysyłanie żądania...",
          "aria.selectSchemaType": "Wybierz typ schematu",
          "aria.minimizeResponse": "Minimalizuj odpowiedź",
          "aria.expandResponse": "Rozwiń odpowiedź",
          "aria.responseContent": "Treść odpowiedzi",
          "aria.fileDownloaded": "Plik pobrany",
          "aria.downloadResponseFile": "Pobierz plik odpowiedzi",
          "tooltip.copy": "Kopiuj",
          "tooltip.copied": "Skopiowano!",
          "tooltip.askAI": "Zapytaj AI",
          "tooltip.reportIncorrectCode": "Zgłoś nieprawidłowy kod",
          "tooltip.download": "Pobierz",
          "assistant.suggestions": "Sugestie",
          availableOptions: "Dostępne opcje",
          requiredRange: "Wymagany zakres",
          hide: "Ukryj",
          show: "Pokaż",
          childAttributes: "atrybuty podrzędne",
          copied: "Skopiowano",
          copyFailed: "Kopiowanie nie powiodło się",
          "assistant.createSupportTicket": "Skontaktuj się ze wsparciem",
          "assistant.disclaimer": "Odpowiedzi są generowane przy użyciu AI i mogą zawierać błędy.",
          generating: "Generowanie",
          searchingFor: "Wyszukiwanie",
          searched: "Wyszukano",
          foundResultsFor: "Znaleziono wyniki dla",
          tryIt: "Wypr\xf3buj",
          send: "Wyślij",
          "api.headers": "Nagł\xf3wki",
          "api.pathParameters": "Parametry ścieżki",
          "api.queryParameters": "Parametry zapytania",
          "api.cookies": "Ciasteczka",
          "api.body": "Treść",
          "api.response": "Odpowiedź",
          "api.authorizations": "Autoryzacje",
          "api.header": "Nagł\xf3wek",
          "api.path": "Ścieżka",
          "api.query": "Zapytanie",
          "api.cookie": "Ciasteczko",
          "api.authorization": "Autoryzacja",
          "api.required": "wymagane",
          "api.deprecated": "przestarzałe",
          "api.default": "domyślnie:",
          "api.noHeadersReceived": "Nie otrzymano nagł\xf3wk\xf3w z serwera",
          "api.noBodyReceived": "Nie otrzymano danych treści z serwera",
          "api.noCookiesReceived": "Nie otrzymano ciasteczek z serwera",
          "api.example": "Przykład",
          "api.examples": "Przykłady",
          "api.addNewProperty": "Dodaj nową właściwość",
          "api.enterPropertyKey": "Wprowadź klucz nowej właściwości",
          "api.addItem": "Dodaj element",
          "api.searchEndpoint": "Szukaj endpointu...",
          "api.connect": "Połącz",
          "api.disconnect": "Rozłącz",
          "api.connected": "Połączono",
          "api.notConnected": "Nie połączono",
          "api.sendMessage": "Wyślij wiadomość",
          "api.receive": "Odbierz",
          "api.requestError": "Wystąpił błąd podczas wykonywania żądania:",
          "api.mustBeMultipleOf": "Musi być wielokrotnością",
          "api.title": "Tytuł",
          "api.const": "Stała",
          "api.enterValue": "wprowadź {name}",
          "api.enterValueCapitalized": "Wprowadź {name}",
          "api.selectOption": "wybierz {name}",
          "api.enterBearerToken": "wprowadź token bearer",
          "api.value": "wartość",
          "api.option": "opcja",
          "prompt.copyPrompt": "Kopiuj prompt",
          "prompt.openInCursor": "Otw\xf3rz w Cursor",
        },
        C = {
          language: "Portugu\xeas",
          yes: "Sim",
          no: "N\xe3o",
          wasThisPageHelpful: "Esta p\xe1gina foi \xfatil?",
          onThisPage: "Nesta p\xe1gina",
          suggestEdits: "Sugerir edi\xe7\xf5es",
          raiseIssue: "Reportar problema",
          search: "Pesquisar...",
          poweredBy: "Suportado por",
          filters: "Filtros",
          clear: "Limpar",
          previous: "Anterior",
          next: "Pr\xf3ximo",
          copyPage: "Copiar p\xe1gina",
          copying: "Copiando...",
          viewAsMarkdown: "Ver como Markdown",
          openInChatGPT: "Abrir no ChatGPT",
          openInClaude: "Abrir no Claude",
          openInPerplexity: "Abrir no Perplexity",
          openInGrok: "Abrir no Grok",
          copyPageAsMarkdown: "Copiar p\xe1gina como Markdown para LLMs",
          viewPageAsMarkdown: "Ver esta p\xe1gina como texto simples",
          askQuestionsAboutPage: "Fazer perguntas sobre esta p\xe1gina",
          copyMCPServer: "Copiar MCP Server",
          copyMCPServerDescription: "Copiar URL do MCP Server para a \xe1rea de transfer\xeancia",
          copyAddMCPCommand: "Copiar comando de instala\xe7\xe3o MCP",
          copyAddMCPCommandDescription: "Copiar comando npx para instalar o servidor MCP",
          connectToCursor: "Ligar ao Cursor",
          installMCPServerOnCursor: "Instalar MCP Server no Cursor",
          connectToVSCode: "Ligar ao VS Code",
          installMCPServerOnVSCode: "Instalar MCP Server no VS Code",
          assistant: "Assistente",
          addToAssistant: "Adicionar ao assistente",
          askAQuestion: "Fazer uma pergunta...",
          askAIAssistant: "Fazer uma pergunta ao assistente",
          askAI: "Perguntar \xe0 IA",
          canYouTellMeAbout: "Voc\xea pode me falar sobre",
          recentSearches: "Pesquisas recentes",
          reportIncorrectCode: "Reportar c\xf3digo incorreto",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Por favor, forne\xe7a uma descri\xe7\xe3o detalhada do c\xf3digo incorreto.",
          whatIsWrongWithThisCode: "O que est\xe1 errado com este c\xf3digo?",
          submit: "Enviar",
          cancel: "Cancelar",
          "feedback.greatWhatWorkedBest": "\xd3timo! O que funcionou melhor para voc\xea?",
          "feedback.howCanWeImprove": "Como podemos melhorar o nosso produto?",
          "feedback.placeholder": "(Opcional) Poderia partilhar mais sobre a sua experi\xeancia?",
          "feedback.emailPlaceholder": "(Opcional) E-mail",
          "feedback.invalidEmail": "Por favor, insira um endere\xe7o de e-mail v\xe1lido",
          "feedback.cancel": "Cancelar",
          "feedback.submit": "Enviar coment\xe1rios",
          "feedback.positive.workedAsExpected": "O guia funcionou como esperado",
          "feedback.positive.easyToFind":
            "Foi f\xe1cil encontrar a informa\xe7\xe3o de que precisava",
          "feedback.positive.easyToUnderstand":
            "Foi f\xe1cil compreender o produto e as funcionalidades",
          "feedback.positive.upToDate": "A documenta\xe7\xe3o est\xe1 atualizada",
          "feedback.positive.somethingElse": "Outra coisa",
          "feedback.negative.getStartedFaster": "Ajudem-me a come\xe7ar mais rapidamente",
          "feedback.negative.easierToFind": "Tornar mais f\xe1cil encontrar o que procuro",
          "feedback.negative.easierToUnderstand":
            "Tornar mais f\xe1cil compreender o produto e as funcionalidades",
          "feedback.negative.updateDocs": "Atualizar esta documenta\xe7\xe3o",
          "feedback.negative.somethingElse": "Outra coisa",
          "aria.openSearch": "Abrir pesquisa",
          "aria.toggleAssistantPanel": "Alternar painel do assistente",
          "aria.searchForEndpoint": "Pesquisar endpoint",
          "aria.deleteItem": "Eliminar item",
          "aria.toggleSection": "Alternar sec\xe7\xe3o {section}",
          "aria.additionalFeedback": "Coment\xe1rios adicionais (opcional)",
          "aria.emailAddress": "Endere\xe7o de e-mail",
          "aria.enterValue": "Inserir {name}",
          "aria.selectOption": "Seleccionar {name}",
          "aria.sendMessage": "Enviar mensagem",
          "aria.viewPayloadItem": "Ver {type}: {value}",
          "aria.removePayloadItem": "Remover {type}: {value}",
          "aria.fileUploadButton": "Bot\xe3o de carregamento de ficheiro",
          "aria.expandMessageSection": "Expandir se\xe7\xe3o de exemplo de mensagem",
          "aria.moreActions": "Mais a\xe7\xf5es",
          "aria.openRssFeed": "Abrir feed RSS",
          "aria.info": "Informa\xe7\xe3o",
          "aria.warning": "Aviso",
          "aria.danger": "Perigo",
          "aria.tip": "Dica",
          "aria.note": "Nota",
          "aria.check": "Verificar",
          "aria.toggleDarkMode": "Alternar modo escuro",
          "aria.expandInputSection": "Expandir se\xe7\xe3o de entrada",
          "aria.reloadChat": "Recarregar chat",
          "aria.reloadLastChat": "Recarregar \xfaltimo chat",
          "aria.copyChatResponse": "Copiar resposta do chat",
          "aria.voteGood": "Votar que a resposta foi boa",
          "aria.voteBad": "Votar que a resposta n\xe3o foi boa",
          "aria.navigateToHeader": "Navegar para cabe\xe7alho",
          "aria.navigateToChangelog": "Navegar para registo de altera\xe7\xf5es",
          "aria.copyCodeBlock": "Copiar conte\xfado do bloco de c\xf3digo",
          "aria.askAI": "Perguntar \xe0 IA",
          "aria.reportIncorrectCode": "Reportar c\xf3digo incorreto",
          "aria.skipToMainContent": "Saltar para o conte\xfado principal",
          "aria.switchToTheme": "Mudar para tema {theme}",
          "aria.codeSnippet": "Fragmento de c\xf3digo",
          "aria.messageContent": "Conte\xfado da mensagem",
          "aria.basePathSelector": "Selecionar caminho base",
          "aria.selectBaseUrl": "Selecionar URL base",
          "aria.dismissBanner": "Fechar banner",
          "aria.selectResponseSection": "Selecionar sec\xe7\xe3o de resposta",
          "aria.sendingRequest": "A enviar pedido...",
          "aria.selectSchemaType": "Selecionar tipo de esquema",
          "aria.minimizeResponse": "Minimizar resposta",
          "aria.expandResponse": "Expandir resposta",
          "aria.responseContent": "Conte\xfado da resposta",
          "aria.fileDownloaded": "Ficheiro transferido",
          "aria.downloadResponseFile": "Transferir ficheiro de resposta",
          "tooltip.copy": "Copiar",
          "tooltip.copied": "Copiado!",
          "tooltip.askAI": "Perguntar \xe0 IA",
          "tooltip.reportIncorrectCode": "Reportar c\xf3digo incorreto",
          "tooltip.download": "Transferir",
          "assistant.suggestions": "Sugest\xf5es",
          availableOptions: "Op\xe7\xf5es dispon\xedveis",
          requiredRange: "Intervalo necess\xe1rio",
          hide: "Ocultar",
          show: "Mostrar",
          childAttributes: "atributos filhos",
          copied: "Copiado",
          copyFailed: "Falha ao copiar",
          "assistant.createSupportTicket": "Contactar suporte",
          "assistant.disclaimer": "As respostas s\xe3o geradas por IA e podem conter erros.",
          generating: "Gerando",
          searchingFor: "Pesquisando",
          searched: "Pesquisado",
          foundResultsFor: "Resultados encontrados para",
          tryIt: "Experimentar",
          send: "Enviar",
          "api.headers": "Cabe\xe7alhos",
          "api.pathParameters": "Par\xe2metros de caminho",
          "api.queryParameters": "Par\xe2metros de consulta",
          "api.cookies": "Cookies",
          "api.body": "Corpo",
          "api.response": "Resposta",
          "api.authorizations": "Autoriza\xe7\xf5es",
          "api.header": "Cabe\xe7alho",
          "api.path": "Caminho",
          "api.query": "Consulta",
          "api.cookie": "Cookie",
          "api.authorization": "Autoriza\xe7\xe3o",
          "api.required": "obrigat\xf3rio",
          "api.deprecated": "obsoleto",
          "api.default": "padr\xe3o:",
          "api.noHeadersReceived": "Nenhum cabe\xe7alho recebido do servidor",
          "api.noBodyReceived": "Nenhum dado do corpo recebido do servidor",
          "api.noCookiesReceived": "Nenhum cookie recebido do servidor",
          "api.example": "Exemplo",
          "api.examples": "Exemplos",
          "api.addNewProperty": "Adicionar nova propriedade",
          "api.enterPropertyKey": "Insira a chave da nova propriedade",
          "api.addItem": "Adicionar um item",
          "api.searchEndpoint": "Pesquisar endpoint...",
          "api.connect": "Conectar",
          "api.disconnect": "Desconectar",
          "api.connected": "Conectado",
          "api.notConnected": "N\xe3o conectado",
          "api.sendMessage": "Enviar mensagem",
          "api.receive": "Receber",
          "api.requestError": "Ocorreu um erro ao fazer a solicita\xe7\xe3o:",
          "api.mustBeMultipleOf": "Deve ser um m\xfaltiplo de",
          "api.title": "T\xedtulo",
          "api.const": "Constante",
          "api.enterValue": "inserir {name}",
          "api.enterValueCapitalized": "Inserir {name}",
          "api.selectOption": "selecionar {name}",
          "api.enterBearerToken": "inserir token bearer",
          "api.value": "valor",
          "api.option": "op\xe7\xe3o",
          "prompt.copyPrompt": "Copiar prompt",
          "prompt.openInCursor": "Abrir no Cursor",
        },
        b = {
          language: "Portugu\xeas (BR)",
          yes: "Sim",
          no: "N\xe3o",
          wasThisPageHelpful: "Esta p\xe1gina foi \xfatil?",
          onThisPage: "Na p\xe1gina",
          suggestEdits: "Sugerir edi\xe7\xf5es",
          raiseIssue: "Reportar problema",
          search: "Pesquisar...",
          poweredBy: "Suportado por",
          filters: "Filtro",
          clear: "Limpar",
          previous: "Anterior",
          next: "Pr\xf3ximo",
          copyPage: "Copiar p\xe1gina",
          copying: "Copiando...",
          viewAsMarkdown: "Ver como Markdown",
          openInChatGPT: "Abrir no ChatGPT",
          openInClaude: "Abrir no Claude",
          openInPerplexity: "Abrir no Perplexity",
          openInGrok: "Abrir no Grok",
          copyPageAsMarkdown: "Copiar p\xe1gina como Markdown para LLMs",
          viewPageAsMarkdown: "Ver esta p\xe1gina como texto simples",
          askQuestionsAboutPage: "Fazer perguntas sobre esta p\xe1gina",
          copyMCPServer: "Copiar MCP Server",
          copyMCPServerDescription: "Copiar URL do MCP Server para a \xe1rea de transfer\xeancia",
          copyAddMCPCommand: "Copiar comando de instala\xe7\xe3o MCP",
          copyAddMCPCommandDescription: "Copiar comando npx para instalar o servidor MCP",
          connectToCursor: "Conectar ao Cursor",
          installMCPServerOnCursor: "Instalar MCP Server no Cursor",
          connectToVSCode: "Conectar ao VS Code",
          installMCPServerOnVSCode: "Instalar MCP Server no VS Code",
          assistant: "Assistente",
          addToAssistant: "Adicionar ao assistente",
          askAQuestion: "Fazer uma pergunta...",
          askAIAssistant: "Fazer uma pergunta ao assistente",
          askAI: "Perguntar \xe0 IA",
          canYouTellMeAbout: "Voc\xea pode me falar sobre",
          recentSearches: "Pesquisas recentes",
          reportIncorrectCode: "Reportar c\xf3digo incorreto",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Por favor, forne\xe7a uma descri\xe7\xe3o detalhada do c\xf3digo incorreto.",
          whatIsWrongWithThisCode: "O que h\xe1 de errado com este c\xf3digo?",
          submit: "Enviar",
          cancel: "Cancelar",
          "feedback.greatWhatWorkedBest": "\xd3timo! O que funcionou melhor para voc\xea?",
          "feedback.howCanWeImprove": "Como podemos melhorar nosso produto?",
          "feedback.placeholder":
            "(Opcional) Voc\xea poderia compartilhar mais sobre sua experi\xeancia?",
          "feedback.emailPlaceholder": "(Opcional) E-mail",
          "feedback.invalidEmail": "Por favor, insira um endere\xe7o de e-mail v\xe1lido",
          "feedback.cancel": "Cancelar",
          "feedback.submit": "Enviar feedback",
          "feedback.positive.workedAsExpected": "O guia funcionou como esperado",
          "feedback.positive.easyToFind":
            "Foi f\xe1cil encontrar a informa\xe7\xe3o que eu precisava",
          "feedback.positive.easyToUnderstand":
            "Foi f\xe1cil entender o produto e as funcionalidades",
          "feedback.positive.upToDate": "A documenta\xe7\xe3o est\xe1 atualizada",
          "feedback.positive.somethingElse": "Outra coisa",
          "feedback.negative.getStartedFaster": "Me ajude a come\xe7ar mais rapidamente",
          "feedback.negative.easierToFind": "Torne mais f\xe1cil encontrar o que estou procurando",
          "feedback.negative.easierToUnderstand":
            "Torne mais f\xe1cil entender o produto e as funcionalidades",
          "feedback.negative.updateDocs": "Atualizar esta documenta\xe7\xe3o",
          "feedback.negative.somethingElse": "Outra coisa",
          "aria.openSearch": "Abrir pesquisa",
          "aria.toggleAssistantPanel": "Alternar painel do assistente",
          "aria.searchForEndpoint": "Pesquisar endpoint",
          "aria.deleteItem": "Excluir item",
          "aria.toggleSection": "Alternar se\xe7\xe3o {section}",
          "aria.additionalFeedback": "Feedback adicional (opcional)",
          "aria.emailAddress": "Endere\xe7o de e-mail",
          "aria.enterValue": "Inserir {name}",
          "aria.selectOption": "Selecionar {name}",
          "aria.sendMessage": "Enviar mensagem",
          "aria.viewPayloadItem": "Ver {type}: {value}",
          "aria.removePayloadItem": "Remover {type}: {value}",
          "aria.fileUploadButton": "Bot\xe3o de upload de arquivo",
          "aria.expandMessageSection": "Expandir se\xe7\xe3o de exemplo de mensagem",
          "aria.moreActions": "Mais a\xe7\xf5es",
          "aria.openRssFeed": "Abrir feed RSS",
          "aria.info": "Informa\xe7\xe3o",
          "aria.warning": "Aviso",
          "aria.danger": "Perigo",
          "aria.tip": "Dica",
          "aria.note": "Nota",
          "aria.check": "Verificar",
          "aria.toggleDarkMode": "Alternar modo escuro",
          "aria.expandInputSection": "Expandir se\xe7\xe3o de entrada",
          "aria.reloadChat": "Recarregar chat",
          "aria.reloadLastChat": "Recarregar \xfaltimo chat",
          "aria.copyChatResponse": "Copiar resposta do chat",
          "aria.voteGood": "Votar que a resposta foi boa",
          "aria.voteBad": "Votar que a resposta n\xe3o foi boa",
          "aria.navigateToHeader": "Navegar para cabe\xe7alho",
          "aria.navigateToChangelog": "Navegar para log de mudan\xe7as",
          "aria.copyCodeBlock": "Copiar conte\xfado do bloco de c\xf3digo",
          "aria.askAI": "Perguntar \xe0 IA",
          "aria.reportIncorrectCode": "Reportar c\xf3digo incorreto",
          "aria.skipToMainContent": "Pular para o conte\xfado principal",
          "aria.switchToTheme": "Mudar para tema {theme}",
          "aria.codeSnippet": "Trecho de c\xf3digo",
          "aria.messageContent": "Conte\xfado da mensagem",
          "aria.basePathSelector": "Selecionar caminho base",
          "aria.selectBaseUrl": "Selecionar URL base",
          "aria.dismissBanner": "Fechar banner",
          "aria.selectResponseSection": "Selecionar se\xe7\xe3o de resposta",
          "aria.sendingRequest": "Enviando solicita\xe7\xe3o...",
          "aria.selectSchemaType": "Selecionar tipo de esquema",
          "aria.minimizeResponse": "Minimizar resposta",
          "aria.expandResponse": "Expandir resposta",
          "aria.responseContent": "Conte\xfado da resposta",
          "aria.fileDownloaded": "Arquivo baixado",
          "aria.downloadResponseFile": "Baixar arquivo de resposta",
          "tooltip.copy": "Copiar",
          "tooltip.copied": "Copiado!",
          "tooltip.askAI": "Perguntar \xe0 IA",
          "tooltip.reportIncorrectCode": "Reportar c\xf3digo incorreto",
          "tooltip.download": "Baixar",
          "assistant.suggestions": "Sugest\xf5es",
          availableOptions: "Op\xe7\xf5es dispon\xedveis",
          requiredRange: "Intervalo obrigat\xf3rio",
          hide: "Ocultar",
          show: "Mostrar",
          childAttributes: "atributos filhos",
          copied: "Copiado",
          copyFailed: "Falha ao copiar",
          "assistant.createSupportTicket": "Contatar suporte",
          "assistant.disclaimer": "As respostas s\xe3o geradas por IA e podem conter erros.",
          generating: "Gerando",
          searchingFor: "Pesquisando",
          searched: "Pesquisado",
          foundResultsFor: "Resultados encontrados para",
          tryIt: "Experimentar",
          send: "Enviar",
          "api.headers": "Cabe\xe7alhos",
          "api.pathParameters": "Par\xe2metros de caminho",
          "api.queryParameters": "Par\xe2metros de consulta",
          "api.cookies": "Cookies",
          "api.body": "Corpo",
          "api.response": "Resposta",
          "api.authorizations": "Autoriza\xe7\xf5es",
          "api.header": "Cabe\xe7alho",
          "api.path": "Caminho",
          "api.query": "Consulta",
          "api.cookie": "Cookie",
          "api.authorization": "Autoriza\xe7\xe3o",
          "api.required": "obrigat\xf3rio",
          "api.deprecated": "obsoleto",
          "api.default": "padr\xe3o:",
          "api.noHeadersReceived": "Nenhum cabe\xe7alho recebido do servidor",
          "api.noBodyReceived": "Nenhum dado do corpo recebido do servidor",
          "api.noCookiesReceived": "Nenhum cookie recebido do servidor",
          "api.example": "Exemplo",
          "api.examples": "Exemplos",
          "api.addNewProperty": "Adicionar nova propriedade",
          "api.enterPropertyKey": "Digite a chave da nova propriedade",
          "api.addItem": "Adicionar um item",
          "api.searchEndpoint": "Pesquisar endpoint...",
          "api.connect": "Conectar",
          "api.disconnect": "Desconectar",
          "api.connected": "Conectado",
          "api.notConnected": "N\xe3o conectado",
          "api.sendMessage": "Enviar mensagem",
          "api.receive": "Receber",
          "api.requestError": "Ocorreu um erro ao fazer a requisi\xe7\xe3o:",
          "api.mustBeMultipleOf": "Deve ser um m\xfaltiplo de",
          "api.title": "T\xedtulo",
          "api.const": "Constante",
          "api.enterValue": "digite {name}",
          "api.enterValueCapitalized": "Digite {name}",
          "api.selectOption": "selecione {name}",
          "api.enterBearerToken": "digite token bearer",
          "api.value": "valor",
          "api.option": "op\xe7\xe3o",
          "prompt.copyPrompt": "Copiar prompt",
          "prompt.openInCursor": "Abrir no Cursor",
        },
        P = {
          language: "Rom\xe2nă",
          yes: "Da",
          no: "Nu",
          wasThisPageHelpful: "A fost această pagină utilă?",
          onThisPage: "Pe această pagină",
          suggestEdits: "Sugerează modificări",
          raiseIssue: "Raportează o problemă",
          search: "Căutare...",
          poweredBy: "Dezvoltat cu",
          filters: "Filtre",
          clear: "Șterge",
          previous: "Anterior",
          next: "Următor",
          copyPage: "Copiază pagina",
          copying: "Se copiază...",
          viewAsMarkdown: "Vezi ca Markdown",
          openInChatGPT: "Deschide \xeen ChatGPT",
          openInClaude: "Deschide \xeen Claude",
          openInPerplexity: "Deschide \xeen Perplexity",
          openInGrok: "Deschide \xeen Grok",
          copyPageAsMarkdown: "Copiază pagina ca Markdown pentru LLM-uri",
          viewPageAsMarkdown: "Vezi această pagină ca text simplu",
          askQuestionsAboutPage: "Pune \xeentrebări despre această pagină",
          copyMCPServer: "Copiază Server MCP",
          copyMCPServerDescription: "Copiază URL-ul Server MCP \xeen clipboard",
          copyAddMCPCommand: "Copiază comanda de instalare MCP",
          copyAddMCPCommandDescription: "Copiază comanda npx pentru instalarea serverului MCP",
          connectToCursor: "Conectează la Cursor",
          installMCPServerOnCursor: "Instalează Server MCP pe Cursor",
          connectToVSCode: "Conectează la VS Code",
          installMCPServerOnVSCode: "Instalează Server MCP pe VS Code",
          assistant: "Asistent",
          addToAssistant: "Adaugă la asistent",
          askAQuestion: "Pune o \xeentrebare...",
          askAIAssistant: "\xcentreabă asistentul AI",
          askAI: "\xcentreabă AI",
          canYouTellMeAbout: "Poți să-mi spui despre",
          recentSearches: "Căutări recente",
          reportIncorrectCode: "Raportează codul incorect",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Te rugăm să furnizezi o descriere detaliată a codului incorect.",
          whatIsWrongWithThisCode: "Ce este greșit la acest cod?",
          submit: "Trimite",
          cancel: "Anulează",
          "feedback.greatWhatWorkedBest": "Excelent! Ce a funcționat cel mai bine pentru tine?",
          "feedback.howCanWeImprove": "Cum putem \xeembunătăți produsul nostru?",
          "feedback.placeholder": "(Opțional) Ai putea să ne spui mai multe despre experiența ta?",
          "feedback.emailPlaceholder": "(Opțional) E-mail",
          "feedback.invalidEmail": "Introduceți o adresă de e-mail validă",
          "feedback.cancel": "Anulează",
          "feedback.submit": "Trimite feedback",
          "feedback.positive.workedAsExpected": "Ghidul a funcționat conform așteptărilor",
          "feedback.positive.easyToFind": "A fost ușor să găsesc informațiile de care aveam nevoie",
          "feedback.positive.easyToUnderstand":
            "A fost ușor să \xeențeleg produsul și caracteristicile",
          "feedback.positive.upToDate": "Documentația este actualizată",
          "feedback.positive.somethingElse": "Altceva",
          "feedback.negative.getStartedFaster": "Ajută-mă să \xeencep mai rapid",
          "feedback.negative.easierToFind": "Fă-o mai ușor să găsesc ceea ce caut",
          "feedback.negative.easierToUnderstand":
            "Fă-o mai ușor să \xeențeleg produsul și caracteristicile",
          "feedback.negative.updateDocs": "Actualizează această documentație",
          "feedback.negative.somethingElse": "Altceva",
          "aria.openSearch": "Deschide căutarea",
          "aria.toggleAssistantPanel": "Comută panoul asistentului",
          "aria.searchForEndpoint": "Caută endpoint",
          "aria.deleteItem": "Șterge elementul",
          "aria.toggleSection": "Comută secțiunea {section}",
          "aria.additionalFeedback": "Feedback adițional (opțional)",
          "aria.emailAddress": "Adresă de email",
          "aria.enterValue": "Introdu {name}",
          "aria.selectOption": "Selectează {name}",
          "aria.sendMessage": "Trimite mesajul",
          "aria.viewPayloadItem": "Vezi {type}: {value}",
          "aria.removePayloadItem": "Elimină {type}: {value}",
          "aria.fileUploadButton": "Buton de \xeencărcare fișier",
          "aria.expandMessageSection": "Extinde secțiunea de exemplu de mesaj",
          "aria.moreActions": "Mai multe acțiuni",
          "aria.openRssFeed": "Deschide feed RSS",
          "aria.info": "Informație",
          "aria.warning": "Avertisment",
          "aria.danger": "Pericol",
          "aria.tip": "Sfat",
          "aria.note": "Notă",
          "aria.check": "Verifică",
          "aria.toggleDarkMode": "Comută modul \xeentunecat",
          "aria.expandInputSection": "Extinde secțiunea de intrare",
          "aria.reloadChat": "Re\xeencarcă chat-ul",
          "aria.reloadLastChat": "Re\xeencarcă ultimul chat",
          "aria.copyChatResponse": "Copiază răspunsul chat-ului",
          "aria.voteGood": "Votează că răspunsul a fost bun",
          "aria.voteBad": "Votează că răspunsul nu a fost bun",
          "aria.navigateToHeader": "Navighează la antet",
          "aria.navigateToChangelog": "Navighează la jurnalul de modificări",
          "aria.copyCodeBlock": "Copiază conținutul blocului de cod",
          "aria.askAI": "\xcentreabă AI",
          "aria.reportIncorrectCode": "Raportează codul incorect",
          "aria.skipToMainContent": "Salt la conținutul principal",
          "aria.switchToTheme": "Comută la tema {theme}",
          "aria.codeSnippet": "Fragment de cod",
          "aria.messageContent": "Conținut mesaj",
          "aria.basePathSelector": "Selectează calea de bază",
          "aria.selectBaseUrl": "Selectează URL-ul de bază",
          "aria.dismissBanner": "\xcenchide bannerul",
          "aria.selectResponseSection": "Selectează secțiunea de răspuns",
          "aria.sendingRequest": "Se trimite cererea...",
          "aria.selectSchemaType": "Selectează tipul de schemă",
          "aria.minimizeResponse": "Minimizează răspunsul",
          "aria.expandResponse": "Extinde răspunsul",
          "aria.responseContent": "Conținut răspuns",
          "aria.fileDownloaded": "Fișier descărcat",
          "aria.downloadResponseFile": "Descarcă fișierul de răspuns",
          "tooltip.copy": "Copiază",
          "tooltip.copied": "Copiat!",
          "tooltip.askAI": "\xcentreabă AI",
          "tooltip.reportIncorrectCode": "Raportează codul incorect",
          "tooltip.download": "Descarcă",
          "assistant.suggestions": "Sugestii",
          availableOptions: "Opțiuni disponibile",
          requiredRange: "Interval necesar",
          hide: "Ascunde",
          show: "Afișează",
          childAttributes: "atribute copil",
          copied: "Copiat",
          copyFailed: "Copierea a eșuat",
          "assistant.createSupportTicket": "Contactează suportul",
          "assistant.disclaimer": "Răspunsurile sunt generate de AI și pot conține erori.",
          generating: "Se generează",
          searchingFor: "Căutare pentru",
          searched: "Căutat",
          foundResultsFor: "Rezultate găsite pentru",
          tryIt: "\xcencearcă",
          send: "Trimite",
          "api.headers": "Anteturi",
          "api.pathParameters": "Parametri cale",
          "api.queryParameters": "Parametri interogare",
          "api.cookies": "Cookie-uri",
          "api.body": "Corp",
          "api.response": "Răspuns",
          "api.authorizations": "Autorizări",
          "api.header": "Antet",
          "api.path": "Cale",
          "api.query": "Interogare",
          "api.cookie": "Cookie",
          "api.authorization": "Autorizare",
          "api.required": "obligatoriu",
          "api.deprecated": "depreciat",
          "api.default": "implicit:",
          "api.noHeadersReceived": "Nu s-au primit anteturi de la server",
          "api.noBodyReceived": "Nu s-au primit date corp de la server",
          "api.noCookiesReceived": "Nu s-au primit cookie-uri de la server",
          "api.example": "Exemplu",
          "api.examples": "Exemple",
          "api.addNewProperty": "Adaugă proprietate nouă",
          "api.enterPropertyKey": "Introduceți cheia noii proprietăți",
          "api.addItem": "Adaugă un element",
          "api.searchEndpoint": "Caută endpoint...",
          "api.connect": "Conectează",
          "api.disconnect": "Deconectează",
          "api.connected": "Conectat",
          "api.notConnected": "Neconectat",
          "api.sendMessage": "Trimite mesaj",
          "api.receive": "Primește",
          "api.requestError": "A apărut o eroare la efectuarea cererii:",
          "api.mustBeMultipleOf": "Trebuie să fie un multiplu de",
          "api.title": "Titlu",
          "api.const": "Constantă",
          "api.enterValue": "introduceți {name}",
          "api.enterValueCapitalized": "Introduceți {name}",
          "api.selectOption": "selectați {name}",
          "api.enterBearerToken": "introduceți token bearer",
          "api.value": "valoare",
          "api.option": "opțiune",
          "prompt.copyPrompt": "Copiază promptul",
          "prompt.openInCursor": "Deschide \xeen Cursor",
        },
        A = {
          language: "Русский",
          yes: "Да",
          no: "Нет",
          wasThisPageHelpful: "Была ли эта страница полезной?",
          onThisPage: "На этой странице",
          suggestEdits: "Предложить правки",
          raiseIssue: "Поднять вопрос",
          search: "Поиск...",
          poweredBy: "Работает на",
          filters: "Фильтры",
          clear: "Очистить",
          previous: "Предыдущий",
          next: "Следующий",
          copyPage: "Копировать страницу",
          copying: "Копирование...",
          viewAsMarkdown: "Просмотр в формате Markdown",
          openInChatGPT: "Открыть в ChatGPT",
          openInClaude: "Открыть в Claude",
          openInPerplexity: "Открыть в Perplexity",
          openInGrok: "Открыть в Grok",
          copyPageAsMarkdown: "Копировать страницу в формате Markdown для LLMs",
          viewPageAsMarkdown: "Просмотреть эту страницу как обычный текст",
          askQuestionsAboutPage: "Задать вопросы об этой странице",
          copyMCPServer: "Копировать MCP Server",
          copyMCPServerDescription: "Копировать URL MCP Server в буфер обмена",
          copyAddMCPCommand: "Копировать команду установки MCP",
          copyAddMCPCommandDescription: "Копировать команду npx для установки MCP сервера",
          connectToCursor: "Подключиться к Cursor",
          installMCPServerOnCursor: "Установить MCP Server в Cursor",
          connectToVSCode: "Подключиться к VS Code",
          installMCPServerOnVSCode: "Установить MCP Server в VS Code",
          assistant: "Помощник",
          addToAssistant: "Добавить к помощнику",
          askAQuestion: "Задать вопрос...",
          askAIAssistant: "Задать вопрос AI-помощнику",
          askAI: "Спросить AI",
          canYouTellMeAbout: "Можете рассказать мне о",
          recentSearches: "Последние поиски",
          reportIncorrectCode: "Сообщить о неправильном коде",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Пожалуйста, предоставьте подробное описание неправильного кода.",
          whatIsWrongWithThisCode: "Что не так с этим кодом?",
          submit: "Отправить",
          cancel: "Отмена",
          "feedback.greatWhatWorkedBest": "Отлично! Что лучше всего сработало для вас?",
          "feedback.howCanWeImprove": "Как мы можем улучшить наш продукт?",
          "feedback.placeholder": "(Необязательно) Не могли бы вы рассказать больше о своём опыте?",
          "feedback.emailPlaceholder": "(Необязательно) Электронная почта",
          "feedback.invalidEmail": "Пожалуйста, введите действительный адрес электронной почты",
          "feedback.cancel": "Отмена",
          "feedback.submit": "Отправить отзыв",
          "feedback.positive.workedAsExpected": "Руководство сработало как ожидалось",
          "feedback.positive.easyToFind": "Было легко найти нужную информацию",
          "feedback.positive.easyToUnderstand": "Было легко понять продукт и функции",
          "feedback.positive.upToDate": "Документация актуальна",
          "feedback.positive.somethingElse": "Что-то ещё",
          "feedback.negative.getStartedFaster": "Помогите мне начать быстрее",
          "feedback.negative.easierToFind": "Сделайте проще поиск того, что я ищу",
          "feedback.negative.easierToUnderstand": "Сделайте проще понимание продукта и функций",
          "feedback.negative.updateDocs": "Обновите эту документацию",
          "feedback.negative.somethingElse": "Что-то ещё",
          "aria.openSearch": "Открыть поиск",
          "aria.toggleAssistantPanel": "Переключить панель помощника",
          "aria.searchForEndpoint": "Поиск эндпойнта",
          "aria.deleteItem": "Удалить элемент",
          "aria.toggleSection": "Переключить раздел {section}",
          "aria.additionalFeedback": "Дополнительный отзыв (необязательно)",
          "aria.emailAddress": "Адрес электронной почты",
          "aria.enterValue": "Введите {name}",
          "aria.selectOption": "Выберите {name}",
          "aria.sendMessage": "Отправить сообщение",
          "aria.viewPayloadItem": "Посмотреть {type}: {value}",
          "aria.removePayloadItem": "Удалить {type}: {value}",
          "aria.fileUploadButton": "Кнопка загрузки файла",
          "aria.expandMessageSection": "Развернуть раздел примера сообщения",
          "aria.moreActions": "Дополнительные действия",
          "aria.openRssFeed": "Открыть RSS-ленту",
          "aria.info": "Информация",
          "aria.warning": "Предупреждение",
          "aria.danger": "Опасность",
          "aria.tip": "Совет",
          "aria.note": "Примечание",
          "aria.check": "Проверить",
          "aria.toggleDarkMode": "Переключить темный режим",
          "aria.expandInputSection": "Развернуть раздел ввода",
          "aria.reloadChat": "Перезагрузить чат",
          "aria.reloadLastChat": "Перезагрузить последний чат",
          "aria.copyChatResponse": "Скопировать ответ чата",
          "aria.voteGood": "Проголосовать, что ответ был хорошим",
          "aria.voteBad": "Проголосовать, что ответ был плохим",
          "aria.navigateToHeader": "Перейти к заголовку",
          "aria.navigateToChangelog": "Перейти к журналу изменений",
          "aria.copyCodeBlock": "Скопировать содержимое блока кода",
          "aria.askAI": "Спросить AI",
          "aria.reportIncorrectCode": "Сообщить о неправильном коде",
          "aria.skipToMainContent": "Перейти к основному содержанию",
          "aria.switchToTheme": "Переключиться на тему {theme}",
          "aria.codeSnippet": "Фрагмент кода",
          "aria.messageContent": "Содержимое сообщения",
          "aria.basePathSelector": "Выбрать базовый путь",
          "aria.selectBaseUrl": "Выбрать базовый URL",
          "aria.dismissBanner": "Закрыть баннер",
          "aria.selectResponseSection": "Выбрать раздел ответа",
          "aria.sendingRequest": "Отправка запроса...",
          "aria.selectSchemaType": "Выбрать тип схемы",
          "aria.minimizeResponse": "Свернуть ответ",
          "aria.expandResponse": "Развернуть ответ",
          "aria.responseContent": "Содержимое ответа",
          "aria.fileDownloaded": "Файл загружен",
          "aria.downloadResponseFile": "Загрузить файл ответа",
          "tooltip.copy": "Копировать",
          "tooltip.copied": "Скопировано!",
          "tooltip.askAI": "Спросить AI",
          "tooltip.reportIncorrectCode": "Сообщить о неправильном коде",
          "tooltip.download": "Загрузить",
          "assistant.suggestions": "Предложения",
          availableOptions: "Доступные опции",
          requiredRange: "Требуемый диапазон",
          hide: "Скрыть",
          show: "Показать",
          childAttributes: "дочерние атрибуты",
          copied: "Скопировано",
          copyFailed: "Ошибка копирования",
          "assistant.createSupportTicket": "Связаться с поддержкой",
          "assistant.disclaimer": "Ответы генерируются ИИ и могут содержать ошибки.",
          generating: "Генерация",
          searchingFor: "Поиск",
          searched: "Найдено",
          foundResultsFor: "Найдены результаты для",
          tryIt: "Попробовать",
          send: "Отправить",
          "api.headers": "Заголовки",
          "api.pathParameters": "Параметры пути",
          "api.queryParameters": "Параметры запроса",
          "api.cookies": "Cookies",
          "api.body": "Тело",
          "api.response": "Ответ",
          "api.authorizations": "Авторизации",
          "api.header": "Заголовок",
          "api.path": "Путь",
          "api.query": "Запрос",
          "api.cookie": "Cookie",
          "api.authorization": "Авторизация",
          "api.required": "обязательно",
          "api.deprecated": "устарело",
          "api.default": "по умолчанию:",
          "api.noHeadersReceived": "Заголовки не получены от сервера",
          "api.noBodyReceived": "Данные тела не получены от сервера",
          "api.noCookiesReceived": "Cookies не получены от сервера",
          "api.example": "Пример",
          "api.examples": "Примеры",
          "api.addNewProperty": "Добавить новое свойство",
          "api.enterPropertyKey": "Введите ключ нового свойства",
          "api.addItem": "Добавить элемент",
          "api.searchEndpoint": "Поиск ендпоинта...",
          "api.connect": "Подключить",
          "api.disconnect": "Отключить",
          "api.connected": "Подключено",
          "api.notConnected": "Не подключено",
          "api.sendMessage": "Отправить сообщение",
          "api.receive": "Получить",
          "api.requestError": "Произошла ошибка при выполнении запроса:",
          "api.mustBeMultipleOf": "Должно быть кратно",
          "api.title": "Заголовок",
          "api.const": "Константа",
          "api.enterValue": "введите {name}",
          "api.enterValueCapitalized": "Введите {name}",
          "api.selectOption": "выберите {name}",
          "api.enterBearerToken": "введите Bearer-токен",
          "api.value": "значение",
          "api.option": "опция",
          "prompt.copyPrompt": "Копировать промпт",
          "prompt.openInCursor": "Открыть в Cursor",
        },
        S = {
          language: "Svenska",
          yes: "Ja",
          no: "Nej",
          wasThisPageHelpful: "Var denna sida till hj\xe4lp?",
          onThisPage: "P\xe5 denna sida",
          suggestEdits: "F\xf6resl\xe5 redigeringar",
          raiseIssue: "Rapportera problem",
          search: "S\xf6k...",
          poweredBy: "Drivs av",
          filters: "Filter",
          clear: "Rensa",
          previous: "F\xf6reg\xe5ende",
          next: "N\xe4sta",
          copyPage: "Kopiera sida",
          copying: "Kopierar...",
          viewAsMarkdown: "Visa som Markdown",
          openInChatGPT: "\xd6ppna i ChatGPT",
          openInClaude: "\xd6ppna i Claude",
          openInPerplexity: "\xd6ppna i Perplexity",
          openInGrok: "\xd6ppna i Grok",
          copyPageAsMarkdown: "Kopiera sida som Markdown f\xf6r LLM:er",
          viewPageAsMarkdown: "Visa denna sida som ren text",
          askQuestionsAboutPage: "St\xe4ll fr\xe5gor om denna sida",
          copyMCPServer: "Kopiera MCP Server",
          copyMCPServerDescription: "Kopiera MCP Server URL till urklipp",
          copyAddMCPCommand: "Kopiera MCP-installationskommando",
          copyAddMCPCommandDescription: "Kopiera npx-kommando f\xf6r att installera MCP-server",
          connectToCursor: "Anslut till Cursor",
          installMCPServerOnCursor: "Installera MCP Server p\xe5 Cursor",
          connectToVSCode: "Anslut till VS Code",
          installMCPServerOnVSCode: "Installera MCP Server p\xe5 VS Code",
          assistant: "Assistent",
          addToAssistant: "L\xe4gg till i assistent",
          askAQuestion: "St\xe4ll en fr\xe5ga...",
          askAIAssistant: "Fr\xe5ga AI-assistent",
          askAI: "Fr\xe5ga AI",
          canYouTellMeAbout: "Kan du ber\xe4tta om",
          recentSearches: "Senaste s\xf6kningar",
          reportIncorrectCode: "Rapportera felaktig kod",
          pleaseProvideDetailsOfTheIncorrectCode:
            "V\xe4nligen ge en detaljerad beskrivning av den felaktiga koden.",
          whatIsWrongWithThisCode: "Vad \xe4r fel med denna kod?",
          submit: "Skicka",
          cancel: "Avbryt",
          "feedback.greatWhatWorkedBest": "Fantastiskt! Vad fungerade b\xe4st f\xf6r dig?",
          "feedback.howCanWeImprove": "Hur kan vi f\xf6rb\xe4ttra v\xe5r produkt?",
          "feedback.placeholder": "(Valfritt) Kan du dela mer om din upplevelse?",
          "feedback.emailPlaceholder": "(Valfritt) E-post",
          "feedback.invalidEmail": "Ange en giltig e-postadress",
          "feedback.cancel": "Avbryt",
          "feedback.submit": "Skicka feedback",
          "feedback.positive.workedAsExpected": "Guiden fungerade som f\xf6rv\xe4ntat",
          "feedback.positive.easyToFind": "Det var l\xe4tt att hitta informationen jag beh\xf6vde",
          "feedback.positive.easyToUnderstand":
            "Det var l\xe4tt att f\xf6rst\xe5 produkten och funktionerna",
          "feedback.positive.upToDate": "Dokumentationen \xe4r aktuell",
          "feedback.positive.somethingElse": "N\xe5got annat",
          "feedback.negative.getStartedFaster": "Hj\xe4lp mig komma ig\xe5ng snabbare",
          "feedback.negative.easierToFind": "G\xf6r det l\xe4ttare att hitta det jag letar efter",
          "feedback.negative.easierToUnderstand":
            "G\xf6r det l\xe4tt att f\xf6rst\xe5 produkten och funktionerna",
          "feedback.negative.updateDocs": "Uppdatera denna dokumentation",
          "feedback.negative.somethingElse": "N\xe5got annat",
          "aria.openSearch": "\xd6ppna s\xf6kning",
          "aria.toggleAssistantPanel": "V\xe4xla assistentpanel",
          "aria.searchForEndpoint": "S\xf6k efter endpoint",
          "aria.deleteItem": "Ta bort objekt",
          "aria.toggleSection": "V\xe4xla {section} sektion",
          "aria.additionalFeedback": "Ytterligare feedback (valfritt)",
          "aria.emailAddress": "E-postadress",
          "aria.enterValue": "Ange {name}",
          "aria.selectOption": "V\xe4lj {name}",
          "aria.sendMessage": "Skicka meddelande",
          "aria.viewPayloadItem": "Visa {type}: {value}",
          "aria.removePayloadItem": "Ta bort {type}: {value}",
          "aria.fileUploadButton": "Filuppladdningsknapp",
          "aria.expandMessageSection": "Expandera meddelandeexempel sektion",
          "aria.moreActions": "Fler \xe5tg\xe4rder",
          "aria.openRssFeed": "\xd6ppna RSS-fl\xf6de",
          "aria.info": "Info",
          "aria.warning": "Varning",
          "aria.danger": "Fara",
          "aria.tip": "Tips",
          "aria.note": "Notering",
          "aria.check": "Kontrollera",
          "aria.toggleDarkMode": "V\xe4xla m\xf6rkt l\xe4ge",
          "aria.expandInputSection": "Expandera indatasektion",
          "aria.reloadChat": "Ladda om chatt",
          "aria.reloadLastChat": "Ladda om senaste chatt",
          "aria.copyChatResponse": "Kopiera chattsvar",
          "aria.voteGood": "R\xf6sta att svaret var bra",
          "aria.voteBad": "R\xf6sta att svaret inte var bra",
          "aria.navigateToHeader": "Navigera till rubrik",
          "aria.navigateToChangelog": "Navigera till \xe4ndringslogg",
          "aria.copyCodeBlock": "Kopiera inneh\xe5llet fr\xe5n kodblocket",
          "aria.askAI": "Fr\xe5ga AI",
          "aria.reportIncorrectCode": "Rapportera felaktig kod",
          "aria.skipToMainContent": "Hoppa till huvudinneh\xe5ll",
          "aria.switchToTheme": "Byt till {theme} tema",
          "aria.codeSnippet": "Kodavsnitt",
          "aria.messageContent": "Meddelandeinneh\xe5ll",
          "aria.basePathSelector": "V\xe4lj bass\xf6kv\xe4g",
          "aria.selectBaseUrl": "V\xe4lj bas-URL",
          "aria.dismissBanner": "St\xe4ng banner",
          "aria.selectResponseSection": "V\xe4lj svarssektion",
          "aria.sendingRequest": "Skickar beg\xe4ran...",
          "aria.selectSchemaType": "V\xe4lj schematyp",
          "aria.minimizeResponse": "Minimera svar",
          "aria.expandResponse": "Expandera svar",
          "aria.responseContent": "Svarsinneh\xe5ll",
          "aria.fileDownloaded": "Fil nedladdad",
          "aria.downloadResponseFile": "Ladda ner svarsfil",
          "tooltip.copy": "Kopiera",
          "tooltip.copied": "Kopierad!",
          "tooltip.askAI": "Fr\xe5ga AI",
          "tooltip.reportIncorrectCode": "Rapportera felaktig kod",
          "tooltip.download": "Ladda ner",
          "assistant.suggestions": "F\xf6rslag",
          availableOptions: "Tillg\xe4ngliga alternativ",
          requiredRange: "Obligatoriskt intervall",
          hide: "D\xf6lj",
          show: "Visa",
          childAttributes: "underordnade attribut",
          copied: "Kopierad",
          copyFailed: "Kopiering misslyckades",
          "assistant.createSupportTicket": "Kontakta support",
          "assistant.disclaimer": "Svar genereras av AI och kan inneh\xe5lla fel.",
          generating: "Genererar",
          searchingFor: "S\xf6ker efter",
          searched: "S\xf6kt",
          foundResultsFor: "Hittade resultat f\xf6r",
          tryIt: "Prova",
          send: "Skicka",
          "api.headers": "Rubriker",
          "api.pathParameters": "S\xf6kv\xe4gsparametrar",
          "api.queryParameters": "Fr\xe5geparametrar",
          "api.cookies": "Cookies",
          "api.body": "Kropp",
          "api.response": "Svar",
          "api.authorizations": "Auktoriseringar",
          "api.header": "Rubrik",
          "api.path": "S\xf6kv\xe4g",
          "api.query": "Fr\xe5ga",
          "api.cookie": "Cookie",
          "api.authorization": "Auktorisering",
          "api.required": "obligatorisk",
          "api.deprecated": "f\xf6r\xe5ldrad",
          "api.default": "standard:",
          "api.noHeadersReceived": "Inga rubriker mottagna fr\xe5n servern",
          "api.noBodyReceived": "Inga kroppsdata mottagna fr\xe5n servern",
          "api.noCookiesReceived": "Inga cookies mottagna fr\xe5n servern",
          "api.example": "Exempel",
          "api.examples": "Exempel",
          "api.addNewProperty": "L\xe4gg till ny egenskap",
          "api.enterPropertyKey": "Ange nyckel f\xf6r ny egenskap",
          "api.addItem": "L\xe4gg till ett objekt",
          "api.searchEndpoint": "S\xf6k endpoint...",
          "api.connect": "Anslut",
          "api.disconnect": "Koppla fr\xe5n",
          "api.connected": "Ansluten",
          "api.notConnected": "Inte ansluten",
          "api.sendMessage": "Skicka meddelande",
          "api.receive": "Ta emot",
          "api.requestError": "Ett fel uppstod vid f\xf6rfr\xe5gan:",
          "api.mustBeMultipleOf": "M\xe5ste vara en multipel av",
          "api.title": "Titel",
          "api.const": "Konstant",
          "api.enterValue": "ange {name}",
          "api.enterValueCapitalized": "Ange {name}",
          "api.selectOption": "v\xe4lj {name}",
          "api.enterBearerToken": "ange bearer-token",
          "api.value": "v\xe4rde",
          "api.option": "alternativ",
          "prompt.copyPrompt": "Kopiera prompt",
          "prompt.openInCursor": "\xd6ppna i Cursor",
        },
        w = {
          language: "T\xfcrk\xe7e",
          yes: "Evet",
          no: "Hayır",
          wasThisPageHelpful: "Bu sayfa yararlı mıydı?",
          onThisPage: "Bu sayfada",
          suggestEdits: "D\xfczenleme \xf6ner",
          raiseIssue: "Sorun oluştur",
          search: "Ara...",
          poweredBy: "Powered by",
          filters: "Filtreler",
          clear: "Temizle",
          previous: "\xd6nceki",
          next: "Sonraki",
          copyPage: "Sayfayı kopyala",
          copying: "Kopyalanıyor...",
          viewAsMarkdown: "Markdown olarak g\xf6r\xfcnt\xfcle",
          openInChatGPT: "ChatGPT'de a\xe7",
          openInClaude: "Claude'da a\xe7",
          openInPerplexity: "Perplexity'de a\xe7",
          openInGrok: "Grok'da a\xe7",
          copyPageAsMarkdown: "Sayfayı LLMs i\xe7in Markdown olarak kopyala",
          viewPageAsMarkdown: "Bu sayfayı d\xfcz metin olarak g\xf6r\xfcnt\xfcle",
          askQuestionsAboutPage: "Bu sayfa hakkında sorular sor",
          copyMCPServer: "MCP Server'ı Kopyala",
          copyMCPServerDescription: "MCP Server URL'sini panoya kopyala",
          copyAddMCPCommand: "MCP Kurulum Komutunu Kopyala",
          copyAddMCPCommandDescription: "MCP sunucusunu kurmak i\xe7in npx komutunu kopyala",
          connectToCursor: "Cursor'a Bağlan",
          installMCPServerOnCursor: "Cursor'a MCP Server kur",
          connectToVSCode: "VS Code'a Bağlan",
          installMCPServerOnVSCode: "VS Code'a MCP Server kur",
          assistant: "Asistan",
          addToAssistant: "Asistana ekle",
          askAQuestion: "Bir soru sor...",
          askAIAssistant: "AI asistanına sor",
          askAI: "AI'ya sor",
          canYouTellMeAbout: "Bana bu sayfa hakkında bilgi ver",
          recentSearches: "Son aramalar",
          reportIncorrectCode: "Yanlış kodu bildir",
          pleaseProvideDetailsOfTheIncorrectCode:
            "L\xfctfen yanlış kodun ayrıntılı bir a\xe7ıklamasını sağlayın.",
          whatIsWrongWithThisCode: "Bu kodda neyin yanlış olduğu?",
          submit: "G\xf6nder",
          cancel: "İptal",
          "feedback.greatWhatWorkedBest": "Harika! Sizin i\xe7in en iyi \xe7alışan neydi?",
          "feedback.howCanWeImprove": "\xdcr\xfcn\xfcm\xfcz\xfc nasıl geliştirebiliriz?",
          "feedback.placeholder":
            "(Opsiyonel) Deneyiminiz hakkında daha fazla bilgi paylaşabilir misiniz?",
          "feedback.emailPlaceholder": "(Opsiyonel) E-posta",
          "feedback.invalidEmail": "L\xfctfen ge\xe7erli bir e-posta adresi girin",
          "feedback.cancel": "İptal",
          "feedback.submit": "Geri bildirim g\xf6nder",
          "feedback.positive.workedAsExpected": "Kılavuz beklen\xealdiği gibi \xe7alıştı",
          "feedback.positive.easyToFind": "İhtiyacım olan bilgiyi bulmak kolaydı",
          "feedback.positive.easyToUnderstand": "\xdcr\xfcn\xfc ve \xf6zellikleri anlamak kolaydı",
          "feedback.positive.upToDate": "Dokumantasyon g\xfcncel",
          "feedback.positive.somethingElse": "Başka bir şey",
          "feedback.negative.getStartedFaster": "Daha hızlı başlamama yardım edin",
          "feedback.negative.easierToFind": "Aradığımı bulmayı kolaylaştırın",
          "feedback.negative.easierToUnderstand":
            "\xdcr\xfcn\xfc ve \xf6zellikleri anlamayı kolaylaştırın",
          "feedback.negative.updateDocs": "Bu dokumantasyonu g\xfcncelleyin",
          "feedback.negative.somethingElse": "Başka bir şey",
          "aria.openSearch": "Aramayı a\xe7",
          "aria.toggleAssistantPanel": "Asistan panelini değiştir",
          "aria.searchForEndpoint": "Endpoint ara",
          "aria.deleteItem": "\xd6ğeyi sil",
          "aria.toggleSection": "{section} b\xf6l\xfcm\xfcn\xfc değiştir",
          "aria.additionalFeedback": "Ek geri bildirim (opsiyonel)",
          "aria.emailAddress": "E-posta adresi",
          "aria.enterValue": "{name} girin",
          "aria.selectOption": "{name} se\xe7in",
          "aria.sendMessage": "Mesaj g\xf6nder",
          "aria.viewPayloadItem": "{type} g\xf6r\xfcnt\xfcle: {value}",
          "aria.removePayloadItem": "{type} kaldır: {value}",
          "aria.fileUploadButton": "Dosya y\xfckleme butonu",
          "aria.expandMessageSection": "Mesaj \xf6rneği b\xf6l\xfcm\xfcn\xfc genişlet",
          "aria.moreActions": "Daha fazla eylem",
          "aria.openRssFeed": "RSS beslemesini a\xe7",
          "aria.info": "Bilgi",
          "aria.warning": "Uyarı",
          "aria.danger": "Tehlike",
          "aria.tip": "İpucu",
          "aria.note": "Not",
          "aria.check": "Kontrol et",
          "aria.toggleDarkMode": "Karanlık modu değiştir",
          "aria.expandInputSection": "Giriş b\xf6l\xfcm\xfcn\xfc genişlet",
          "aria.reloadChat": "Sohbeti yeniden y\xfckle",
          "aria.reloadLastChat": "Son sohbeti yeniden y\xfckle",
          "aria.copyChatResponse": "Sohbet yanıtını kopyala",
          "aria.voteGood": "Yanıtın iyi olduğuna oy ver",
          "aria.voteBad": "Yanıtın iyi olmadığına oy ver",
          "aria.navigateToHeader": "Başlığa git",
          "aria.navigateToChangelog": "Değişiklik g\xfcnl\xfcğ\xfcne git",
          "aria.copyCodeBlock": "Kod bloğundan i\xe7eriği kopyala",
          "aria.askAI": "AI'ya sor",
          "aria.reportIncorrectCode": "Yanlış kodu bildir",
          "aria.skipToMainContent": "Ana i\xe7eriğe atla",
          "aria.switchToTheme": "{theme} temasına ge\xe7",
          "aria.codeSnippet": "Kod par\xe7acığı",
          "aria.messageContent": "Mesaj i\xe7eriği",
          "aria.basePathSelector": "Temel yolu se\xe7",
          "aria.selectBaseUrl": "Temel URL se\xe7",
          "aria.dismissBanner": "Afişi kapat",
          "aria.selectResponseSection": "Yanıt b\xf6l\xfcm\xfcn\xfc se\xe7",
          "aria.sendingRequest": "İstek g\xf6nderiliyor...",
          "aria.selectSchemaType": "Şema t\xfcr\xfcn\xfc se\xe7",
          "aria.minimizeResponse": "Yanıtı k\xfc\xe7\xfclt",
          "aria.expandResponse": "Yanıtı genişlet",
          "aria.responseContent": "Yanıt i\xe7eriği",
          "aria.fileDownloaded": "Dosya indirildi",
          "aria.downloadResponseFile": "Yanıt dosyasını indir",
          "tooltip.copy": "Kopyala",
          "tooltip.copied": "Kopyalandı!",
          "tooltip.askAI": "AI'ya sor",
          "tooltip.reportIncorrectCode": "Yanlış kodu bildir",
          "tooltip.download": "İndir",
          "assistant.suggestions": "\xd6neriler",
          availableOptions: "Mevcut se\xe7enekler",
          requiredRange: "Gerekli aralık",
          hide: "Gizle",
          show: "G\xf6ster",
          childAttributes: "alt \xf6zellikler",
          copied: "Kopyalandı",
          copyFailed: "Kopyalama başarısız",
          "assistant.createSupportTicket": "Destek ile iletişime ge\xe7",
          "assistant.disclaimer":
            "Yanıtlar yapay zeka tarafından oluşturulur ve hatalar i\xe7erebilir.",
          generating: "Oluşturuluyor",
          searchingFor: "Aranıyor",
          searched: "Arandı",
          foundResultsFor: "Sonu\xe7lar bulundu",
          tryIt: "Dene",
          send: "G\xf6nder",
          "api.headers": "Başlıklar",
          "api.pathParameters": "Yol Parametreleri",
          "api.queryParameters": "Sorgu Parametreleri",
          "api.cookies": "\xc7erezler",
          "api.body": "G\xf6vde",
          "api.response": "Yanıt",
          "api.authorizations": "Yetkilendirmeler",
          "api.header": "Başlık",
          "api.path": "Yol",
          "api.query": "Sorgu",
          "api.cookie": "\xc7erez",
          "api.authorization": "Yetkilendirme",
          "api.required": "gerekli",
          "api.deprecated": "kullanımdan kaldırıldı",
          "api.default": "varsayılan:",
          "api.noHeadersReceived": "Sunucudan başlık alınamadı",
          "api.noBodyReceived": "Sunucudan g\xf6vde verisi alınamadı",
          "api.noCookiesReceived": "Sunucudan \xe7erez alınamadı",
          "api.example": "\xd6rnek",
          "api.examples": "\xd6rnekler",
          "api.addNewProperty": "Yeni \xf6zellik ekle",
          "api.enterPropertyKey": "Yeni \xf6zellik anahtarını girin",
          "api.addItem": "\xd6ğe ekle",
          "api.searchEndpoint": "Endpoint ara...",
          "api.connect": "Bağlan",
          "api.disconnect": "Bağlantıyı kes",
          "api.connected": "Bağlı",
          "api.notConnected": "Bağlı değil",
          "api.sendMessage": "Mesaj g\xf6nder",
          "api.receive": "Al",
          "api.requestError": "İstek yapılırken bir hata oluştu:",
          "api.mustBeMultipleOf": "Şunun katı olmalıdır",
          "api.title": "Başlık",
          "api.const": "Sabit",
          "api.enterValue": "{name} girin",
          "api.enterValueCapitalized": "{name} girin",
          "api.selectOption": "{name} se\xe7in",
          "api.enterBearerToken": "bearer token girin",
          "api.value": "değer",
          "api.option": "se\xe7enek",
          "prompt.copyPrompt": "Promptu kopyala",
          "prompt.openInCursor": "Cursor'da a\xe7",
        },
        I = {
          language: "Українська",
          yes: "Так",
          no: "Ні",
          wasThisPageHelpful: "Чи була ця сторінка корисною?",
          onThisPage: "На цій сторінці",
          suggestEdits: "Запропонувати зміни",
          raiseIssue: "Повідомити про проблему",
          search: "Пошук...",
          poweredBy: "Працює на",
          filters: "Фільтри",
          clear: "Очистити",
          previous: "Попередня",
          next: "Наступна",
          copyPage: "Скопіювати сторінку",
          copying: "Копіювання...",
          viewAsMarkdown: "Переглянути як Markdown",
          openInChatGPT: "Відкрити в ChatGPT",
          openInClaude: "Відкрити в Claude",
          openInPerplexity: "Відкрити в Perplexity",
          openInGrok: "Відкрити в Grok",
          copyPageAsMarkdown: "Скопіювати сторінку як Markdown для LLMs",
          viewPageAsMarkdown: "Переглянути цю сторінку як звичайний текст",
          askQuestionsAboutPage: "Задати питання про цю сторінку",
          copyMCPServer: "Скопіювати MCP Server",
          copyMCPServerDescription: "Скопіювати посилання на MCP Server в буфер обміну",
          copyAddMCPCommand: "Копіювати команду встановлення MCP",
          copyAddMCPCommandDescription: "Копіювати команду npx для встановлення MCP сервера",
          connectToCursor: "З'єднати з Cursor",
          installMCPServerOnCursor: "Встановити MCP Server в Cursor",
          connectToVSCode: "З'єднати з VS Code",
          installMCPServerOnVSCode: "Встановити MCP Server в VS Code",
          assistant: "Асистент",
          addToAssistant: "Додати до асистента",
          askAQuestion: "Задати питання...",
          askAIAssistant: "Задати питання ШІ-асистенту",
          askAI: "Запитати ШІ",
          canYouTellMeAbout: "Можете розповісти мені про",
          recentSearches: "Недавні пошуки",
          reportIncorrectCode: "Повідомити про неправильний код",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Будь ласка, надайте детальний опис неправильного коду.",
          whatIsWrongWithThisCode: "Що не так з цим кодом?",
          submit: "Підтвердити",
          cancel: "Скасувати",
          "feedback.greatWhatWorkedBest": "Чудово! Що працювало найкраще для вас?",
          "feedback.howCanWeImprove": "Як ми можемо покращити наш продукт?",
          "feedback.placeholder": "(Опціонально) Могли б ви поділитися більше про свою досвід?",
          "feedback.emailPlaceholder": "(Опціонально) Електронна пошта",
          "feedback.invalidEmail": "Будь ласка, введіть дійсну адресу електронної пошти",
          "feedback.cancel": "Скасувати",
          "feedback.submit": "Надіслати відгук",
          "feedback.positive.workedAsExpected": "Посібник спрацював як очікувалося",
          "feedback.positive.easyToFind": "Було легко знайти інформацію, яку я потребував",
          "feedback.positive.easyToUnderstand": "Було легко зрозуміти продукт і функції",
          "feedback.positive.upToDate": "Документація є актуальною",
          "feedback.positive.somethingElse": "Щось інше",
          "feedback.negative.getStartedFaster": "Допоможіть мені розпочати швидше",
          "feedback.negative.easierToFind": "Зробіть легше знайти те, що я шукаю",
          "feedback.negative.easierToUnderstand": "Зробіть легше зрозуміти продукт і функції",
          "feedback.negative.updateDocs": "Оновити цю документацію",
          "feedback.negative.somethingElse": "Щось інше",
          "aria.openSearch": "Відкрити пошук",
          "aria.toggleAssistantPanel": "Перемкнути панель асистента",
          "aria.searchForEndpoint": "Шукати кінцеву точку",
          "aria.deleteItem": "Видалити елемент",
          "aria.toggleSection": "Перемкнути розділ {section}",
          "aria.additionalFeedback": "Додатковий відгук (опціонально)",
          "aria.emailAddress": "Адреса електронної пошти",
          "aria.enterValue": "Введіть {name}",
          "aria.selectOption": "Виберіть {name}",
          "aria.sendMessage": "Надіслати повідомлення",
          "aria.viewPayloadItem": "Переглянути {type}: {value}",
          "aria.removePayloadItem": "Видалити {type}: {value}",
          "aria.fileUploadButton": "Кнопка завантаження файлу",
          "aria.expandMessageSection": "Розгорнути розділ прикладу повідомлення",
          "aria.moreActions": "Більше дій",
          "aria.openRssFeed": "Відкрити RSS-канал",
          "aria.info": "Інформація",
          "aria.warning": "Попередження",
          "aria.danger": "Небезпека",
          "aria.tip": "Порада",
          "aria.note": "Примітка",
          "aria.check": "Перевірити",
          "aria.toggleDarkMode": "Перемкнути темний режим",
          "aria.expandInputSection": "Розгорнути розділ введення",
          "aria.reloadChat": "Перезавантажити чат",
          "aria.reloadLastChat": "Перезавантажити останній чат",
          "aria.copyChatResponse": "Скопіювати відповідь чату",
          "aria.voteGood": "Проголосувати, що відповідь була хорошою",
          "aria.voteBad": "Проголосувати, що відповідь була поганою",
          "aria.navigateToHeader": "Перейти до заголовка",
          "aria.navigateToChangelog": "Перейти до журналу змін",
          "aria.copyCodeBlock": "Скопіювати вміст з блоку коду",
          "aria.askAI": "Запитати ШІ",
          "aria.reportIncorrectCode": "Повідомити про неправильний код",
          "aria.skipToMainContent": "Перейти до основного вмісту",
          "aria.switchToTheme": "Переключитися на тему {theme}",
          "aria.codeSnippet": "Фрагмент коду",
          "aria.messageContent": "Вміст повідомлення",
          "aria.basePathSelector": "Вибрати базовий шлях",
          "aria.selectBaseUrl": "Вибрати базову URL-адресу",
          "aria.dismissBanner": "Закрити банер",
          "aria.selectResponseSection": "Вибрати розділ відповіді",
          "aria.sendingRequest": "Надсилання запиту...",
          "aria.selectSchemaType": "Вибрати тип схеми",
          "aria.minimizeResponse": "Згорнути відповідь",
          "aria.expandResponse": "Розгорнути відповідь",
          "aria.responseContent": "Вміст відповіді",
          "aria.fileDownloaded": "Файл завантажено",
          "aria.downloadResponseFile": "Завантажити файл відповіді",
          "tooltip.copy": "Скопіювати",
          "tooltip.copied": "Скопійовано!",
          "tooltip.askAI": "Запитати ШІ",
          "tooltip.reportIncorrectCode": "Повідомити про неправильний код",
          "tooltip.download": "Завантажити",
          "assistant.suggestions": "Пропозиції",
          availableOptions: "Доступні опції",
          requiredRange: "Необхідний діапазон",
          hide: "Приховати",
          show: "Показати",
          childAttributes: "дочірні атрибути",
          copied: "Скопійовано",
          copyFailed: "Помилка копіювання",
          "assistant.createSupportTicket": "Зв'язатися з підтримкою",
          "assistant.disclaimer": "Відповіді генеруються ШІ та можуть містити помилки.",
          generating: "Генерація",
          searchingFor: "Пошук",
          searched: "Знайдено",
          foundResultsFor: "Знайдено результати для",
          tryIt: "Спробувати",
          send: "Надіслати",
          "api.headers": "Заголовки",
          "api.pathParameters": "Параметри шляху",
          "api.queryParameters": "Параметри запиту",
          "api.cookies": "Cookies",
          "api.body": "Тіло",
          "api.response": "Відповідь",
          "api.authorizations": "Авторизації",
          "api.header": "Заголовок",
          "api.path": "Шлях",
          "api.query": "Запит",
          "api.cookie": "Cookie",
          "api.authorization": "Авторизація",
          "api.required": "обов'язково",
          "api.deprecated": "застаріло",
          "api.default": "за замовчуванням:",
          "api.noHeadersReceived": "Заголовки не отримані з сервера",
          "api.noBodyReceived": "Дані тіла не отримані з сервера",
          "api.noCookiesReceived": "Cookies не отримані з сервера",
          "api.example": "Приклад",
          "api.examples": "Приклади",
          "api.addNewProperty": "Додати нову властивість",
          "api.enterPropertyKey": "Введіть ключ нової властивості",
          "api.addItem": "Додати елемент",
          "api.searchEndpoint": "Шукати ендпоінт...",
          "api.connect": "Підключити",
          "api.disconnect": "Відключити",
          "api.connected": "Підключено",
          "api.notConnected": "Не підключено",
          "api.sendMessage": "Надіслати повідомлення",
          "api.receive": "Отримати",
          "api.requestError": "Під час виконання запиту сталася помилка:",
          "api.mustBeMultipleOf": "Повинно бути кратним",
          "api.title": "Заголовок",
          "api.const": "Константа",
          "api.enterValue": "введіть {name}",
          "api.enterValueCapitalized": "Введіть {name}",
          "api.selectOption": "виберіть {name}",
          "api.enterBearerToken": "введіть Bearer-токен",
          "api.value": "значення",
          "api.option": "опція",
          "prompt.copyPrompt": "Скопіювати промпт",
          "prompt.openInCursor": "Відкрити в Cursor",
        },
        T = {
          language: "O'zbekcha",
          yes: "Ha",
          no: "Yo'q",
          wasThisPageHelpful: "Bu sahifa foydali bo'ldimi?",
          onThisPage: "Ushbu sahifada",
          suggestEdits: "Tahrirlash taklifi",
          raiseIssue: "Muammo bildirish",
          search: "Qidirish...",
          poweredBy: "Powered by",
          filters: "Filtrlar",
          clear: "Tozalash",
          previous: "Oldingi",
          next: "Keyingi",
          copyPage: "Sahifani nusxalash",
          copying: "Nusxalanmoqda...",
          viewAsMarkdown: "Markdown sifatida ko'rish",
          openInChatGPT: "ChatGPT da ochish",
          openInClaude: "Claude da ochish",
          openInPerplexity: "Perplexity da ochish",
          openInGrok: "Grok da ochish",
          copyPageAsMarkdown: "Sahifani LLM uchun Markdown sifatida nusxalash",
          viewPageAsMarkdown: "Ushbu sahifani oddiy matn sifatida ko'rish",
          askQuestionsAboutPage: "Ushbu sahifa haqida savol bering",
          copyMCPServer: "MCP Serverni nusxalash",
          copyMCPServerDescription: "MCP Server URL ni klipbordga nusxalash",
          copyAddMCPCommand: "MCP o'rnatish buyrug'ini nusxalash",
          copyAddMCPCommandDescription: "MCP serverni o'rnatish uchun npx buyrug'ini nusxalash",
          connectToCursor: "Cursor ga ulash",
          installMCPServerOnCursor: "MCP Serverni Cursor ga o'rnatish",
          connectToVSCode: "VS Code ga ulash",
          installMCPServerOnVSCode: "MCP Serverni VS Code ga o'rnatish",
          assistant: "Yordamchi",
          addToAssistant: "Yordamchiga qo'shish",
          askAQuestion: "Savol bering...",
          askAIAssistant: "AI yordamchidan so'rang",
          askAI: "AI dan so'rash",
          canYouTellMeAbout: "Menga ... haqida aytib bera olasizmi",
          recentSearches: "So'nggi qidiruvlar",
          reportIncorrectCode: "Noto'g'ri kod haqida xabar berish",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Iltimos, noto'g'ri kod haqida batafsil ma'lumot bering.",
          whatIsWrongWithThisCode: "Bu kodda nima noto'g'ri?",
          submit: "Yuborish",
          cancel: "Bekor qilish",
          "feedback.greatWhatWorkedBest": "Ajoyib! Sizga eng yaxshi nima yoqdi?",
          "feedback.howCanWeImprove": "Mahsulotimizni qanday yaxshilashimiz mumkin?",
          "feedback.placeholder": "(Ixtiyoriy) Tajribangiz haqida batafsil ma'lumot berasizmi?",
          "feedback.emailPlaceholder": "(Ixtiyoriy) Elektron pochta",
          "feedback.invalidEmail": "Iltimos, to'g'ri elektron pochta manzilini kiriting",
          "feedback.cancel": "Bekor qilish",
          "feedback.submit": "Fikr-mulohaza yuborish",
          "feedback.positive.workedAsExpected": "Qo'llanma kutilganidek ishladi",
          "feedback.positive.easyToFind": "Kerakli ma'lumotni topish oson edi",
          "feedback.positive.easyToUnderstand": "Mahsulot va xususiyatlarni tushunish oson edi",
          "feedback.positive.upToDate": "Hujjatlar yangilangan",
          "feedback.positive.somethingElse": "Boshqa narsa",
          "feedback.negative.getStartedFaster": "Tezroq boshlashimga yordam bering",
          "feedback.negative.easierToFind": "Qidirayotgan narsani topishni osonlashtiring",
          "feedback.negative.easierToUnderstand":
            "Mahsulot va xususiyatlarni tushunishni osonlashtiring",
          "feedback.negative.updateDocs": "Ushbu hujjatlarni yangilang",
          "feedback.negative.somethingElse": "Boshqa narsa",
          "aria.openSearch": "Qidiruvni ochish",
          "aria.toggleAssistantPanel": "Yordamchi panelini o'zgartirish",
          "aria.searchForEndpoint": "Endpoint ni qidirish",
          "aria.deleteItem": "Elementni o'chirish",
          "aria.toggleSection": "{section} bo'limini o'zgartirish",
          "aria.additionalFeedback": "Qo'shimcha fikr-mulohaza (ixtiyoriy)",
          "aria.emailAddress": "Elektron pochta manzili",
          "aria.enterValue": "{name} ni kiriting",
          "aria.selectOption": "{name} ni tanlang",
          "aria.sendMessage": "Xabar yuborish",
          "aria.viewPayloadItem": "{type} ni ko'rish: {value}",
          "aria.removePayloadItem": "{type} ni o'chirish: {value}",
          "aria.fileUploadButton": "Fayl yuklash tugmasi",
          "aria.expandMessageSection": "Xabar namunasi bo'limini kengaytirish",
          "aria.moreActions": "Boshqa harakatlar",
          "aria.openRssFeed": "RSS tasmani ochish",
          "aria.info": "Ma'lumot",
          "aria.warning": "Ogohlantirish",
          "aria.danger": "Xavf",
          "aria.tip": "Maslahat",
          "aria.note": "Eslatma",
          "aria.check": "Tekshirish",
          "aria.toggleDarkMode": "Qorong'u rejimni o'zgartirish",
          "aria.expandInputSection": "Kiritish bo'limini kengaytirish",
          "aria.reloadChat": "Chatni qayta yuklash",
          "aria.reloadLastChat": "Oxirgi chatni qayta yuklash",
          "aria.copyChatResponse": "Chat javobini nusxalash",
          "aria.voteGood": "Javob yaxshi ekanligiga ovoz bering",
          "aria.voteBad": "Javob yaxshi emasligiga ovoz bering",
          "aria.navigateToHeader": "Sarlavhaga o'tish",
          "aria.navigateToChangelog": "O'zgarishlar jurnalga o'tish",
          "aria.copyCodeBlock": "Kod blokidan mazmunni nusxalash",
          "aria.askAI": "AI dan so'rash",
          "aria.reportIncorrectCode": "Noto'g'ri kod haqida xabar berish",
          "aria.skipToMainContent": "Asosiy tarkibga o'tish",
          "aria.switchToTheme": "{theme} mavzusiga o'tish",
          "aria.codeSnippet": "Kod parchalari",
          "aria.messageContent": "Xabar tarkibi",
          "aria.basePathSelector": "Asosiy yo'lni tanlash",
          "aria.selectBaseUrl": "Asosiy URL ni tanlash",
          "aria.dismissBanner": "Bannerni yopish",
          "aria.selectResponseSection": "Javob bo'limini tanlash",
          "aria.sendingRequest": "So'rov yuborilmoqda...",
          "aria.selectSchemaType": "Sxema turini tanlash",
          "aria.minimizeResponse": "Javobni minimizatsiya qilish",
          "aria.expandResponse": "Javobni kengaytirish",
          "aria.responseContent": "Javob tarkibi",
          "aria.fileDownloaded": "Fayl yuklandi",
          "aria.downloadResponseFile": "Javob faylini yuklash",
          "tooltip.copy": "Nusxalash",
          "tooltip.copied": "Nusxalandi!",
          "tooltip.askAI": "AI dan so'rash",
          "tooltip.reportIncorrectCode": "Noto'g'ri kod haqida xabar berish",
          "tooltip.download": "Yuklash",
          "assistant.suggestions": "Takliflar",
          availableOptions: "Mavjud variantlar",
          requiredRange: "Talab qilinadigan diapazon",
          hide: "Yashirish",
          show: "Ko'rsatish",
          childAttributes: "bola atributlari",
          copied: "Nusxalandi",
          copyFailed: "Nusxalash muvaffaqiyatsiz",
          "assistant.createSupportTicket": "Qo'llab-quvvatlash bilan bog'lanish",
          "assistant.disclaimer":
            "Javoblar AI yordamida yaratilgan va xatolarga yo'l qo'yilishi mumkin.",
          generating: "Yaratilmoqda",
          searchingFor: "Qidirilmoqda",
          searched: "Qidirildi",
          foundResultsFor: "Natijalar topildi",
          tryIt: "Sinab ko'ring",
          send: "Yuborish",
          "api.headers": "Sarlavhalar",
          "api.pathParameters": "Yo'l parametrlari",
          "api.queryParameters": "So'rov parametrlari",
          "api.cookies": "Cookie-lar",
          "api.body": "Tanasi",
          "api.response": "Javob",
          "api.authorizations": "Avtorizatsiyalar",
          "api.header": "Sarlavha",
          "api.path": "Yo'l",
          "api.query": "So'rov",
          "api.cookie": "Cookie",
          "api.authorization": "Avtorizatsiya",
          "api.required": "talab qilinadi",
          "api.deprecated": "eskirgan",
          "api.default": "standart:",
          "api.noHeadersReceived": "Serverdan sarlavhalar olinmadi",
          "api.noBodyReceived": "Serverdan tana ma'lumotlari olinmadi",
          "api.noCookiesReceived": "Serverdan cookie-lar olinmadi",
          "api.example": "Misol",
          "api.examples": "Misollar",
          "api.addNewProperty": "Yangi xususiyat qo'shish",
          "api.enterPropertyKey": "Yangi xususiyat kalitini kiriting",
          "api.addItem": "Element qo'shish",
          "api.searchEndpoint": "Oxirgi nuqtani qidirish...",
          "api.connect": "Ulanish",
          "api.disconnect": "Uzish",
          "api.connected": "Ulangan",
          "api.notConnected": "Ulanmagan",
          "api.sendMessage": "Xabar jo'natish",
          "api.receive": "Qabul qilish",
          "api.requestError": "So'rov yuborishda xatolik yuz berdi:",
          "api.mustBeMultipleOf": "Quyidagining ko'paytmasi bo'lishi kerak",
          "api.title": "Sarlavha",
          "api.const": "Doimiy qiymat",
          "api.enterValue": "{name} kiriting",
          "api.enterValueCapitalized": "{name} kiriting",
          "api.selectOption": "{name} tanlang",
          "api.enterBearerToken": "bearer tokenni kiriting",
          "api.value": "qiymat",
          "api.option": "variant",
          "prompt.copyPrompt": "Promptni nusxalash",
          "prompt.openInCursor": "Cursor da ochish",
        },
        M = {
          language: "Tiếng Việt",
          yes: "C\xf3",
          no: "Kh\xf4ng",
          wasThisPageHelpful: "Trang n\xe0y c\xf3 hữu \xedch kh\xf4ng?",
          onThisPage: "Tr\xean trang n\xe0y",
          suggestEdits: "Đề xuất chỉnh sửa",
          raiseIssue: "B\xe1o c\xe1o vấn đề",
          search: "T\xecm kiếm...",
          poweredBy: "Được cung cấp bởi",
          filters: "Bộ lọc",
          clear: "X\xf3a",
          previous: "Trước",
          next: "Tiếp theo",
          copyPage: "Sao ch\xe9p trang",
          copying: "Đang sao ch\xe9p...",
          viewAsMarkdown: "Xem dưới dạng Markdown",
          openInChatGPT: "Mở trong ChatGPT",
          openInClaude: "Mở trong Claude",
          openInPerplexity: "Mở trong Perplexity",
          openInGrok: "Mở trong Grok",
          copyPageAsMarkdown: "Sao ch\xe9p trang dưới dạng Markdown cho LLMs",
          viewPageAsMarkdown: "Xem trang n\xe0y dưới dạng văn bản thuần",
          askQuestionsAboutPage: "Đặt c\xe2u hỏi về trang n\xe0y",
          copyMCPServer: "Sao ch\xe9p MCP Server",
          copyMCPServerDescription: "Sao ch\xe9p URL MCP Server v\xe0o clipboard",
          copyAddMCPCommand: "Sao ch\xe9p lệnh c\xe0i đặt MCP",
          copyAddMCPCommandDescription: "Sao ch\xe9p lệnh npx để c\xe0i đặt m\xe1y chủ MCP",
          connectToCursor: "Kết nối với Cursor",
          installMCPServerOnCursor: "C\xe0i đặt MCP Server tr\xean Cursor",
          connectToVSCode: "Kết nối với VS Code",
          installMCPServerOnVSCode: "C\xe0i đặt MCP Server tr\xean VS Code",
          assistant: "Trợ l\xfd",
          addToAssistant: "Th\xeam v\xe0o trợ l\xfd",
          askAQuestion: "Đặt c\xe2u hỏi...",
          askAIAssistant: "Hỏi trợ l\xfd AI",
          askAI: "Hỏi AI",
          canYouTellMeAbout: "Bạn c\xf3 thể cho t\xf4i biết về",
          recentSearches: "T\xecm kiếm gần đ\xe2y",
          reportIncorrectCode: "B\xe1o c\xe1o m\xe3 kh\xf4ng ch\xednh x\xe1c",
          pleaseProvideDetailsOfTheIncorrectCode:
            "Vui l\xf2ng cung cấp m\xf4 tả chi tiết về m\xe3 kh\xf4ng ch\xednh x\xe1c.",
          whatIsWrongWithThisCode: "M\xe3 n\xe0y c\xf3 vấn đề g\xec?",
          submit: "Gửi",
          cancel: "Hủy",
          "feedback.greatWhatWorkedBest": "Tuyệt vời! Điều g\xec hiệu quả nhất với bạn?",
          "feedback.howCanWeImprove":
            "Ch\xfang t\xf4i c\xf3 thể cải thiện sản phẩm như thế n\xe0o?",
          "feedback.placeholder":
            "(T\xf9y chọn) Bạn c\xf3 thể chia sẻ th\xeam về trải nghiệm của m\xecnh kh\xf4ng?",
          "feedback.emailPlaceholder": "(T\xf9y chọn) Email",
          "feedback.invalidEmail": "Vui l\xf2ng nhập địa chỉ email hợp lệ",
          "feedback.cancel": "Hủy",
          "feedback.submit": "Gửi phản hồi",
          "feedback.positive.workedAsExpected": "Hướng dẫn hoạt động như mong đợi",
          "feedback.positive.easyToFind": "Dễ d\xe0ng t\xecm thấy th\xf4ng tin t\xf4i cần",
          "feedback.positive.easyToUnderstand": "Dễ hiểu về sản phẩm v\xe0 t\xednh năng",
          "feedback.positive.upToDate": "T\xe0i liệu được cập nhật",
          "feedback.positive.somethingElse": "Điều kh\xe1c",
          "feedback.negative.getStartedFaster": "Gi\xfap t\xf4i bắt đầu nhanh hơn",
          "feedback.negative.easierToFind":
            "L\xe0m cho dễ t\xecm hơn những g\xec t\xf4i đang t\xecm",
          "feedback.negative.easierToUnderstand":
            "L\xe0m cho dễ hiểu hơn về sản phẩm v\xe0 t\xednh năng",
          "feedback.negative.updateDocs": "Cập nhật t\xe0i liệu n\xe0y",
          "feedback.negative.somethingElse": "Điều kh\xe1c",
          "aria.openSearch": "Mở t\xecm kiếm",
          "aria.toggleAssistantPanel": "Bật/tắt bảng trợ l\xfd",
          "aria.searchForEndpoint": "T\xecm kiếm endpoint",
          "aria.deleteItem": "X\xf3a mục",
          "aria.toggleSection": "Bật/tắt phần {section}",
          "aria.additionalFeedback": "Phản hồi bổ sung (t\xf9y chọn)",
          "aria.emailAddress": "Địa chỉ email",
          "aria.enterValue": "Nhập {name}",
          "aria.selectOption": "Chọn {name}",
          "aria.sendMessage": "Gửi tin nhắn",
          "aria.viewPayloadItem": "Xem {type}: {value}",
          "aria.removePayloadItem": "X\xf3a {type}: {value}",
          "aria.fileUploadButton": "N\xfat tải l\xean tệp",
          "aria.expandMessageSection": "Mở rộng phần v\xed dụ tin nhắn",
          "aria.moreActions": "Th\xeam h\xe0nh động",
          "aria.openRssFeed": "Mở RSS feed",
          "aria.info": "Th\xf4ng tin",
          "aria.warning": "Cảnh b\xe1o",
          "aria.danger": "Nguy hiểm",
          "aria.tip": "Mẹo",
          "aria.note": "Ghi ch\xfa",
          "aria.check": "Kiểm tra",
          "aria.toggleDarkMode": "Bật/tắt chế độ tối",
          "aria.expandInputSection": "Mở rộng phần nhập liệu",
          "aria.reloadChat": "Tải lại cuộc tr\xf2 chuyện",
          "aria.reloadLastChat": "Tải lại cuộc tr\xf2 chuyện gần nhất",
          "aria.copyChatResponse": "Sao ch\xe9p phản hồi tr\xf2 chuyện",
          "aria.voteGood": "B\xecnh chọn phản hồi tốt",
          "aria.voteBad": "B\xecnh chọn phản hồi kh\xf4ng tốt",
          "aria.navigateToHeader": "Điều hướng đến ti\xeau đề",
          "aria.navigateToChangelog": "Điều hướng đến nhật k\xfd thay đổi",
          "aria.copyCodeBlock": "Sao ch\xe9p nội dung từ khối m\xe3",
          "aria.askAI": "Hỏi AI",
          "aria.reportIncorrectCode": "B\xe1o c\xe1o m\xe3 kh\xf4ng ch\xednh x\xe1c",
          "aria.skipToMainContent": "Chuyển đến nội dung ch\xednh",
          "aria.switchToTheme": "Chuyển sang giao diện {theme}",
          "aria.codeSnippet": "Đoạn m\xe3",
          "aria.messageContent": "Nội dung tin nhắn",
          "aria.basePathSelector": "Chọn đường dẫn cơ sở",
          "aria.selectBaseUrl": "Chọn URL cơ sở",
          "aria.dismissBanner": "Đ\xf3ng biểu ngữ",
          "aria.selectResponseSection": "Chọn phần phản hồi",
          "aria.sendingRequest": "Đang gửi y\xeau cầu...",
          "aria.selectSchemaType": "Chọn loại schema",
          "aria.minimizeResponse": "Thu nhỏ phản hồi",
          "aria.expandResponse": "Mở rộng phản hồi",
          "aria.responseContent": "Nội dung phản hồi",
          "aria.fileDownloaded": "Đ\xe3 tải xuống tệp",
          "aria.downloadResponseFile": "Tải xuống tệp phản hồi",
          "tooltip.copy": "Sao ch\xe9p",
          "tooltip.copied": "Đ\xe3 sao ch\xe9p!",
          "tooltip.askAI": "Hỏi AI",
          "tooltip.reportIncorrectCode": "B\xe1o c\xe1o m\xe3 kh\xf4ng ch\xednh x\xe1c",
          "tooltip.download": "Tải xuống",
          "assistant.suggestions": "Gợi \xfd",
          availableOptions: "T\xf9y chọn c\xf3 sẵn",
          requiredRange: "Phạm vi bắt buộc",
          hide: "Ẩn",
          show: "Hiện",
          childAttributes: "thuộc t\xednh con",
          copied: "Đ\xe3 sao ch\xe9p",
          copyFailed: "Sao ch\xe9p thất bại",
          "assistant.createSupportTicket": "Li\xean hệ hỗ trợ",
          "assistant.disclaimer": "C\xe1c phản hồi được tạo bằng AI v\xe0 c\xf3 thể chứa lỗi.",
          generating: "Đang tạo",
          searchingFor: "Đang t\xecm kiếm",
          searched: "Đ\xe3 t\xecm kiếm",
          foundResultsFor: "T\xecm thấy kết quả cho",
          tryIt: "Thử nghiệm",
          send: "Gửi",
          "api.headers": "Ti\xeau đề",
          "api.pathParameters": "Tham số đường dẫn",
          "api.queryParameters": "Tham số truy vấn",
          "api.cookies": "Cookie",
          "api.body": "Nội dung",
          "api.response": "Phản hồi",
          "api.authorizations": "Ủy quyền",
          "api.header": "Ti\xeau đề",
          "api.path": "Đường dẫn",
          "api.query": "Truy vấn",
          "api.cookie": "Cookie",
          "api.authorization": "Ủy quyền",
          "api.required": "bắt buộc",
          "api.deprecated": "kh\xf4ng c\xf2n sử dụng",
          "api.default": "mặc định:",
          "api.noHeadersReceived": "Kh\xf4ng nhận được ti\xeau đề từ m\xe1y chủ",
          "api.noBodyReceived": "Kh\xf4ng nhận được dữ liệu nội dung từ m\xe1y chủ",
          "api.noCookiesReceived": "Kh\xf4ng nhận được cookie từ m\xe1y chủ",
          "api.example": "V\xed dụ",
          "api.examples": "V\xed dụ",
          "api.addNewProperty": "Th\xeam thuộc t\xednh mới",
          "api.enterPropertyKey": "Nhập kh\xf3a thuộc t\xednh mới",
          "api.addItem": "Th\xeam mục",
          "api.searchEndpoint": "T\xecm kiếm endpoint...",
          "api.connect": "Kết nối",
          "api.disconnect": "Ngắt kết nối",
          "api.connected": "Đ\xe3 kết nối",
          "api.notConnected": "Chưa kết nối",
          "api.sendMessage": "Gửi tin nhắn",
          "api.receive": "Nhận",
          "api.requestError": "Đ\xe3 xảy ra lỗi khi thực hiện y\xeau cầu:",
          "api.mustBeMultipleOf": "Phải l\xe0 bội số của",
          "api.title": "Ti\xeau đề",
          "api.const": "Hằng số",
          "api.enterValue": "nhập {name}",
          "api.enterValueCapitalized": "Nhập {name}",
          "api.selectOption": "chọn {name}",
          "api.enterBearerToken": "nhập bearer token",
          "api.value": "gi\xe1 trị",
          "api.option": "t\xf9y chọn",
          "prompt.copyPrompt": "Sao ch\xe9p prompt",
          "prompt.openInCursor": "Mở trong Cursor",
        },
        E = {
          language: "简体中文",
          yes: "是",
          no: "否",
          wasThisPageHelpful: "此页面对您有帮助吗？",
          onThisPage: "在此页面",
          suggestEdits: "建议编辑",
          raiseIssue: "提出问题",
          search: "搜索...",
          poweredBy: "技术支持",
          filters: "筛选",
          clear: "清除",
          previous: "上一页",
          next: "下一页",
          copyPage: "复制页面",
          copying: "复制中...",
          viewAsMarkdown: "以 Markdown 格式查看",
          openInChatGPT: "在 ChatGPT 中打开",
          openInClaude: "在 Claude 中打开",
          openInPerplexity: "在 Perplexity 中打开",
          openInGrok: "在 Grok 中打开",
          copyPageAsMarkdown: "将页面以 Markdown 格式复制给 LLMs",
          viewPageAsMarkdown: "以纯文本查看此页面",
          askQuestionsAboutPage: "询问有关此页面的问题",
          copyMCPServer: "复制MCP Server",
          copyMCPServerDescription: "复制 MCP Server URL 到剪贴板",
          copyAddMCPCommand: "复制 MCP 安装命令",
          copyAddMCPCommandDescription: "复制 npx 命令以安装 MCP 服务器",
          connectToCursor: "连接到Cursor",
          installMCPServerOnCursor: "在 Cursor 中安装 MCP Server",
          connectToVSCode: "连接到VS Code",
          installMCPServerOnVSCode: "在 VS Code 中安装 MCP Server",
          assistant: "助手",
          addToAssistant: "添加到助手",
          askAQuestion: "提出问题...",
          askAIAssistant: "询问 AI 助手",
          askAI: "询问AI",
          canYouTellMeAbout: "您能告诉我关于",
          recentSearches: "最近搜索",
          reportIncorrectCode: "报告错误代码",
          pleaseProvideDetailsOfTheIncorrectCode: "请提供错误代码的详细描述。",
          whatIsWrongWithThisCode: "这段代码有什么问题？",
          submit: "提交",
          cancel: "取消",
          "feedback.greatWhatWorkedBest": "太好了！什么对您最有用？",
          "feedback.howCanWeImprove": "我们如何改进我们的产品？",
          "feedback.placeholder": "（可选）您能分享更多关于您体验的信息吗？",
          "feedback.emailPlaceholder": "（可选）电子邮箱",
          "feedback.invalidEmail": "请输入有效的电子邮箱地址",
          "feedback.cancel": "取消",
          "feedback.submit": "提交反馈",
          "feedback.positive.workedAsExpected": "指南按预期工作",
          "feedback.positive.easyToFind": "很容易找到我需要的信息",
          "feedback.positive.easyToUnderstand": "很容易理解产品和功能",
          "feedback.positive.upToDate": "文档是最新的",
          "feedback.positive.somethingElse": "其他",
          "feedback.negative.getStartedFaster": "帮助我更快开始",
          "feedback.negative.easierToFind": "让我更容易找到我要找的内容",
          "feedback.negative.easierToUnderstand": "让我更容易理解产品和功能",
          "feedback.negative.updateDocs": "更新此文档",
          "feedback.negative.somethingElse": "其他",
          "aria.openSearch": "打开搜索",
          "aria.toggleAssistantPanel": "切换助手面板",
          "aria.searchForEndpoint": "搜索端点",
          "aria.deleteItem": "删除项目",
          "aria.toggleSection": "切换{section}部分",
          "aria.additionalFeedback": "附加反馈（可选）",
          "aria.emailAddress": "电子邮件地址",
          "aria.enterValue": "输入{name}",
          "aria.selectOption": "选择{name}",
          "aria.sendMessage": "发送消息",
          "aria.viewPayloadItem": "查看 {type}: {value}",
          "aria.removePayloadItem": "移除 {type}: {value}",
          "aria.fileUploadButton": "文件上传按钮",
          "aria.expandMessageSection": "展开消息示例部分",
          "aria.moreActions": "更多操作",
          "aria.openRssFeed": "打开 RSS 订阅",
          "aria.info": "信息",
          "aria.warning": "警告",
          "aria.danger": "危险",
          "aria.tip": "提示",
          "aria.note": "注意",
          "aria.check": "检查",
          "aria.toggleDarkMode": "切换深色模式",
          "aria.expandInputSection": "展开输入部分",
          "aria.reloadChat": "重新加载聊天",
          "aria.reloadLastChat": "重新加载最后一次聊天",
          "aria.copyChatResponse": "复制聊天响应",
          "aria.voteGood": "投票认为响应很好",
          "aria.voteBad": "投票认为响应不好",
          "aria.navigateToHeader": "导航到标题",
          "aria.navigateToChangelog": "导航到更新日志",
          "aria.copyCodeBlock": "复制代码块内容",
          "aria.askAI": "询问AI",
          "aria.reportIncorrectCode": "报告错误代码",
          "aria.skipToMainContent": "跳转到主要内容",
          "aria.switchToTheme": "切换到{theme}主题",
          "aria.codeSnippet": "代码片段",
          "aria.messageContent": "消息内容",
          "aria.basePathSelector": "选择基本路径",
          "aria.selectBaseUrl": "选择基础URL",
          "aria.dismissBanner": "关闭横幅",
          "aria.selectResponseSection": "选择响应部分",
          "aria.sendingRequest": "正在发送请求...",
          "aria.selectSchemaType": "选择架构类型",
          "aria.minimizeResponse": "最小化响应",
          "aria.expandResponse": "展开响应",
          "aria.responseContent": "响应内容",
          "aria.fileDownloaded": "文件已下载",
          "aria.downloadResponseFile": "下载响应文件",
          "tooltip.copy": "复制",
          "tooltip.copied": "已复制!",
          "tooltip.askAI": "询问AI",
          "tooltip.reportIncorrectCode": "报告错误代码",
          "tooltip.download": "下载",
          "assistant.suggestions": "建议",
          availableOptions: "可用选项",
          requiredRange: "必填范围",
          hide: "隐藏",
          show: "显示",
          childAttributes: "子属性",
          copied: "已复制",
          copyFailed: "复制失败",
          "assistant.createSupportTicket": "联系支持",
          "assistant.disclaimer": "AI生成的回答可能包含错误。",
          generating: "生成中",
          searchingFor: "正在搜索",
          searched: "已搜索",
          foundResultsFor: "搜索结果",
          tryIt: "试一试",
          send: "发送",
          "api.headers": "请求头",
          "api.pathParameters": "路径参数",
          "api.queryParameters": "查询参数",
          "api.cookies": "Cookie",
          "api.body": "请求体",
          "api.response": "响应",
          "api.authorizations": "授权",
          "api.header": "请求头",
          "api.path": "路径",
          "api.query": "查询",
          "api.cookie": "Cookie",
          "api.authorization": "授权",
          "api.required": "必填",
          "api.deprecated": "已弃用",
          "api.default": "默认值:",
          "api.noHeadersReceived": "未从服务器接收到请求头",
          "api.noBodyReceived": "未从服务器接收到响应体数据",
          "api.noCookiesReceived": "未从服务器接收到Cookie",
          "api.example": "示例",
          "api.examples": "示例",
          "api.addNewProperty": "添加新属性",
          "api.enterPropertyKey": "输入新属性键",
          "api.addItem": "添加项目",
          "api.searchEndpoint": "搜索端点...",
          "api.connect": "连接",
          "api.disconnect": "断开连接",
          "api.connected": "已连接",
          "api.notConnected": "未连接",
          "api.sendMessage": "发送消息",
          "api.receive": "接收",
          "api.requestError": "请求时发生错误:",
          "api.mustBeMultipleOf": "必须是以下数值的倍数",
          "api.title": "标题",
          "api.const": "常量",
          "api.enterValue": "输入 {name}",
          "api.enterValueCapitalized": "输入 {name}",
          "api.selectOption": "选择 {name}",
          "api.enterBearerToken": "输入 Bearer 令牌",
          "api.value": "值",
          "api.option": "选项",
          "prompt.copyPrompt": "复制提示词",
          "prompt.openInCursor": "在 Cursor 中打开",
        },
        R = {
          language: "繁體中文",
          yes: "是",
          no: "否",
          wasThisPageHelpful: "這個頁面有幫助嗎?",
          onThisPage: "在此頁",
          suggestEdits: "建議編輯",
          raiseIssue: "問問題",
          search: "搜尋...",
          poweredBy: "技術支援",
          filters: "篩選",
          clear: "清除",
          previous: "上一頁",
          next: "下一頁",
          copyPage: "複製頁面",
          copying: "複製中...",
          viewAsMarkdown: "以 Markdown 格式檢視",
          openInChatGPT: "在 ChatGPT 中開啟",
          openInClaude: "在 Claude 中開啟",
          openInPerplexity: "在 Perplexity 中開啟",
          openInGrok: "在 Grok 中開啟",
          copyPageAsMarkdown: "將頁面以 Markdown 格式複製給 LLMs",
          viewPageAsMarkdown: "以純文字檢視此頁面",
          askQuestionsAboutPage: "詢問有關此頁面的問題",
          copyMCPServer: "複製MCP Server",
          copyMCPServerDescription: "複製 MCP Server URL 到剪貼板",
          copyAddMCPCommand: "複製 MCP 安裝命令",
          copyAddMCPCommandDescription: "複製 npx 命令以安裝 MCP 伺服器",
          connectToCursor: "連接到Cursor",
          installMCPServerOnCursor: "在 Cursor 中安裝 MCP Server",
          connectToVSCode: "連接到VS Code",
          installMCPServerOnVSCode: "在 VS Code 中安裝 MCP Server",
          assistant: "助手",
          addToAssistant: "添加到助手",
          askAQuestion: "提出問題...",
          askAIAssistant: "詢問 AI 助手",
          askAI: "詢問AI",
          canYouTellMeAbout: "您能告訴我關於",
          recentSearches: "最近搜索",
          reportIncorrectCode: "回報錯誤代碼",
          pleaseProvideDetailsOfTheIncorrectCode: "請提供錯誤代碼的詳細描述。",
          whatIsWrongWithThisCode: "這段代碼有什麼問題？",
          submit: "提交",
          cancel: "取消",
          "feedback.greatWhatWorkedBest": "太好了！什麼對您最有用？",
          "feedback.howCanWeImprove": "我們如何改進我們的產品？",
          "feedback.placeholder": "（可選）您能分享更多關於您體驗的資訊嗎？",
          "feedback.emailPlaceholder": "（可選）電子郵箱",
          "feedback.invalidEmail": "請輸入有效的電子郵箱地址",
          "feedback.cancel": "取消",
          "feedback.submit": "提交回饋",
          "feedback.positive.workedAsExpected": "指南按預期工作",
          "feedback.positive.easyToFind": "很容易找到我需要的資訊",
          "feedback.positive.easyToUnderstand": "很容易理解產品和功能",
          "feedback.positive.upToDate": "文件是最新的",
          "feedback.positive.somethingElse": "其他",
          "feedback.negative.getStartedFaster": "幫助我更快開始",
          "feedback.negative.easierToFind": "讓我更容易找到我要找的內容",
          "feedback.negative.easierToUnderstand": "讓我更容易理解產品和功能",
          "feedback.negative.updateDocs": "更新此文件",
          "feedback.negative.somethingElse": "其他",
          "aria.openSearch": "打開搜尋",
          "aria.toggleAssistantPanel": "切換助手面板",
          "aria.searchForEndpoint": "搜尋端點",
          "aria.deleteItem": "刪除項目",
          "aria.toggleSection": "切換{section}部分",
          "aria.additionalFeedback": "附加回馴（可選）",
          "aria.emailAddress": "電子郵件地址",
          "aria.enterValue": "輸入{name}",
          "aria.selectOption": "選擇{name}",
          "aria.sendMessage": "發送訊息",
          "aria.viewPayloadItem": "查看 {type}: {value}",
          "aria.removePayloadItem": "移除 {type}: {value}",
          "aria.fileUploadButton": "檔案上傳按鈕",
          "aria.expandMessageSection": "展開訊息範例部分",
          "aria.moreActions": "更多操作",
          "aria.openRssFeed": "開啟 RSS 摘要",
          "aria.info": "資訊",
          "aria.warning": "警告",
          "aria.danger": "危險",
          "aria.tip": "提示",
          "aria.note": "註記",
          "aria.check": "檢查",
          "aria.toggleDarkMode": "切換深色模式",
          "aria.expandInputSection": "展開輸入部分",
          "aria.reloadChat": "重新載入聊天",
          "aria.reloadLastChat": "重新載入最後聊天",
          "aria.copyChatResponse": "複製聊天回應",
          "aria.voteGood": "投票認為回應良好",
          "aria.voteBad": "投票認為回應不佳",
          "aria.navigateToHeader": "導航到標題",
          "aria.navigateToChangelog": "導航到變更日誌",
          "aria.copyCodeBlock": "複製程式碼區塊內容",
          "aria.askAI": "詢問AI",
          "aria.reportIncorrectCode": "回報錯誤代碼",
          "aria.skipToMainContent": "跳轉到主要內容",
          "aria.switchToTheme": "切換到{theme}主題",
          "aria.codeSnippet": "程式碼片段",
          "aria.messageContent": "訊息內容",
          "aria.basePathSelector": "選擇基本路徑",
          "aria.selectBaseUrl": "選擇基礎URL",
          "aria.dismissBanner": "關閉橫幅",
          "aria.selectResponseSection": "選擇回應部分",
          "aria.sendingRequest": "正在傳送請求...",
          "aria.selectSchemaType": "選擇架構類型",
          "aria.minimizeResponse": "最小化回應",
          "aria.expandResponse": "展開回應",
          "aria.responseContent": "回應內容",
          "aria.fileDownloaded": "檔案已下載",
          "aria.downloadResponseFile": "下載回應檔案",
          "tooltip.copy": "複製",
          "tooltip.copied": "已複製!",
          "tooltip.askAI": "詢問AI",
          "tooltip.reportIncorrectCode": "回報錯誤代碼",
          "tooltip.download": "下載",
          "assistant.suggestions": "建議",
          availableOptions: "可用選項",
          requiredRange: "必填範圍",
          hide: "隱藏",
          show: "顯示",
          childAttributes: "子屬性",
          copied: "已複製",
          copyFailed: "複製失敗",
          "assistant.createSupportTicket": "聯繫支援",
          "assistant.disclaimer": "AI生成的回答可能包含錯誤。",
          generating: "生成中",
          searchingFor: "正在搜尋",
          searched: "已搜尋",
          foundResultsFor: "搜尋結果",
          tryIt: "試一試",
          send: "傳送",
          "api.headers": "標頭",
          "api.pathParameters": "路徑參數",
          "api.queryParameters": "查詢參數",
          "api.cookies": "Cookie",
          "api.body": "主體",
          "api.response": "回應",
          "api.authorizations": "授權",
          "api.header": "標頭",
          "api.path": "路徑",
          "api.query": "查詢",
          "api.cookie": "Cookie",
          "api.authorization": "授權",
          "api.required": "必填",
          "api.deprecated": "已棄用",
          "api.default": "預設值:",
          "api.noHeadersReceived": "未從伺服器接收到標頭",
          "api.noBodyReceived": "未從伺服器接收到主體資料",
          "api.noCookiesReceived": "未從伺服器接收到Cookie",
          "api.example": "範例",
          "api.examples": "範例",
          "api.addNewProperty": "新增屬性",
          "api.enterPropertyKey": "輸入新屬性鍵",
          "api.addItem": "新增項目",
          "api.searchEndpoint": "搜尋端點...",
          "api.connect": "連接",
          "api.disconnect": "中斷連接",
          "api.connected": "已連接",
          "api.notConnected": "未連接",
          "api.sendMessage": "傳送訊息",
          "api.receive": "接收",
          "api.requestError": "請求時發生錯誤:",
          "api.mustBeMultipleOf": "必須是以下數值的倍數",
          "api.title": "標題",
          "api.const": "常數",
          "api.enterValue": "輸入 {name}",
          "api.enterValueCapitalized": "輸入 {name}",
          "api.selectOption": "選擇 {name}",
          "api.enterBearerToken": "輸入 Bearer 權杖",
          "api.value": "值",
          "api.option": "選項",
          "prompt.copyPrompt": "複製提示詞",
          "prompt.openInCursor": "在 Cursor 中開啟",
        },
        z = (e) => {
          switch (e) {
            case "en":
            default:
              return n;
            case "cn":
            case "zh":
            case "zh-Hans":
              return E;
            case "zh-Hant":
              return R;
            case "es":
              return s;
            case "ja":
            case "jp":
            case "ja-jp":
              return m;
            case "pt":
              return C;
            case "fr":
              return p;
            case "fr-ca":
            case "fr-CA":
              return d;
            case "pt-BR":
              return b;
            case "de":
              return o;
            case "ko":
              return h;
            case "it":
              return g;
            case "ru":
              return A;
            case "ro":
              return P;
            case "cs":
              return r;
            case "id":
              return u;
            case "ar":
              return t;
            case "tr":
              return w;
            case "hi":
              return c;
            case "sv":
              return S;
            case "no":
              return y;
            case "lv":
              return f;
            case "nl":
              return v;
            case "uk":
              return I;
            case "vi":
              return M;
            case "pl":
              return k;
            case "uz":
              return T;
            case "he":
              return l;
          }
        },
        x = (e) => {
          switch (e) {
            case "en":
            default:
              return "en-US";
            case "es":
              return "es-ES";
            case "cn":
            case "zh":
            case "zh-Hans":
            case "zh-Hant":
              return "zh-CN";
            case "jp":
            case "ja":
              return "ja-JP";
            case "pt":
              return "pt-PT";
            case "fr":
              return "fr-FR";
            case "fr-ca":
            case "fr-CA":
              return "fr-CA";
            case "pt-BR":
              return "pt-BR";
            case "de":
              return "de-DE";
            case "ko":
              return "ko-KR";
            case "it":
              return "it-IT";
            case "ru":
              return "ru-RU";
            case "ro":
              return "ro-RO";
            case "cs":
              return "cs-CZ";
            case "id":
              return "id-ID";
            case "ar":
              return "ar-SA";
            case "tr":
              return "tr-TR";
            case "hi":
              return "hi-IN";
            case "sv":
              return "sv-SE";
            case "no":
              return "no-NO";
            case "lv":
              return "lv-LV";
            case "nl":
              return "nl-NL";
            case "uk":
              return "uk-UA";
            case "vi":
              return "vi-VN";
            case "pl":
              return "pl-PL";
            case "uz":
              return "uz-UZ";
            case "he":
              return "he-IL";
          }
        };
    },
    53457: (e, a, i) => {
      i.d(a, { Mi: () => r });
      var t = i(52286);
      function r(e) {
        return e.startsWith("/") || (0, t.FC)(e) ? e : "/" + e;
      }
    },
    53812: (e, a, i) => {
      i.d(a, { M8: () => u, MU: () => s, NN: () => n, cn: () => c });
      var t = i(1612),
        r = i(54548),
        o = i(16903);
      let n = (e) => {
          let a = [],
            i = e.attributes?.some((e) => "dropdown" === e.name && "false" !== e.value);
          return (
            e.children?.map((e) => {
              let r = (0, t.Ay)(e.html ?? ""),
                o =
                  "object" != typeof r || Array.isArray(r) || "pre" !== r.type
                    ? void 0
                    : (r.props.language ??
                      (function (e, a) {
                        let i = /language-(\w+)/.exec(e ?? "");
                        return i ? (i[1] ?? "text") : (a ?? "text");
                      })(r.props.className, e.filename));
              a.push({ dropdown: i, language: o, code: r, filename: e.filename });
            }),
            a
          );
        },
        s = (e) => {
          let a = "generated";
          return (
            Object.entries(e).forEach(([i, t]) => {
              let r = {};
              t.examples && Object.keys(t.examples).length > 0
                ? (Object.entries(t.examples).forEach(([e, a]) => {
                    "$ref" in a ||
                      (r[e] = { title: e, description: a.description, value: a.value });
                  }),
                  e[i] && (e[i].examples = r),
                  (a = "examples"))
                : t.example
                  ? ((r.Example = { title: "Example", value: t.example }),
                    e[i] && (e[i].examples = r),
                    (a = "examples"))
                  : (0, o.Fy)(t.schema) &&
                    ((r.Example = p(t.schema)), e[i] && (e[i].examples = r), (a = "generated"));
            }),
            { content: e, exampleType: a }
          );
        },
        p = (e) => {
          let a = { title: "Example", value: void 0 };
          if (void 0 !== e.example) {
            return ((a.value = e.example), a);
          }
          if (void 0 !== e.default) {
            return ((a.value = e.default), a);
          }
          if (e.enum) {
            return ((a.value = e.enum[0]), a);
          }
          if (e.oneOf && Array.isArray(e.oneOf) && e.oneOf.length > 0) {
            let a = e.oneOf[0];
            if ((0, o.Fy)(a)) {
              return p(a);
            }
          }
          switch (e.type) {
            case "string":
              return ((a.value = l(e)), a);
            case "boolean":
              return ((a.value = !0), a);
            case "number":
            case "integer":
              return ((a.value = d(e)), a);
            case "object":
              let i = Object.fromEntries(
                Object.entries(e.properties ?? {}).map(([e, a]) =>
                  (0, o.Fy)(a) ? [e, p(a).value] : [e, "<object>"],
                ),
              );
              return ((a.value = (0, r.k$)(e) ? (0, r.bB)(i) : i), a);
            case "array":
              return (
                (0, o.Fy)(e.items) ? (a.value = [p(e.items).value]) : (a.value = "<array>"), a
              );
            default:
              return ((a.value = "<unknown>"), a);
          }
        },
        d = (e) => {
          let a = "integer" === e.type ? Math.floor : (e) => e;
          return void 0 !== e.minimum && void 0 !== e.maximum
            ? a((e.minimum + e.maximum) / 2)
            : void 0 !== e.minimum
              ? a(e.minimum + 1)
              : void 0 !== e.maximum
                ? 123 < e.maximum
                  ? 123
                  : a(e.maximum - 1)
                : 123;
        },
        l = (e) => {
          switch (e.format?.toLowerCase()) {
            case "byte":
            case "base64":
              return "aSDinaTvuI8gbWludGxpZnk=";
            case "date":
              return "2023-12-25";
            case "date-time":
              return "2023-11-07T05:31:56Z";
            case "email":
              return "jsmith@example.com";
            case "uuid":
              return "3c90c3cc-0d44-4b50-8888-8dd25736052a";
            case "ipv4":
              return "127.0.0.1";
            case "ipv6":
              return "2606:4700:3108::ac42:2835";
            default:
              return "<string>";
          }
        },
        c = (e, a) => {
          let i = Object.keys(e)[a];
          if (i) {
            let a = e[i],
              t = Object.values(a?.examples ?? {})[0];
            if (t && "value" in t) {
              return t.value;
            }
          }
        },
        u = (e, a) => {
          let i = [];
          if (e.dependencies?.requestBody?.content) {
            let t = c(e.dependencies.requestBody.content, a);
            t &&
              i.push({
                language: "json",
                filename: "Example Request Body",
                code: JSON.stringify(t, null, 2),
              });
          }
          return i;
        };
    },
    54548: (e, a, i) => {
      (i.d(a, { bB: () => n, gz: () => o, k$: () => r }), i(16903));
      let t = "_tupleOriginal",
        r = (e) => t in e && !0 === e[t],
        o = (e) => {
          let a = e.match(/^\[(\d+)\]$/);
          return a && void 0 !== a[1] ? parseInt(a[1], 10) : null;
        },
        n = (e) => {
          let a = [];
          for (let [i, t] of Object.entries(e)) {
            let e = o(i);
            null !== e && a.push({ index: e, value: t });
          }
          return (a.toSorted((e, a) => e.index - a.index), a.map((e) => e.value));
        };
    },
    54923: (e, a, i) => {
      i.d(a, {
        Mn: () => n,
        SR: () => d,
        bP: () => s,
        eR: () => u,
        gC: () => p,
        mF: () => c,
        t1: () => l,
      });
      let t = [
          {
            key: "bash",
            aliases: ["curl", "sh", "shell"],
            displayName: "cURL",
            shikiLanguage: "bash",
            httpSnippet: { target: "shell" },
          },
          {
            key: "python",
            aliases: ["py"],
            displayName: "Python",
            shikiLanguage: "python",
            httpSnippet: { target: "python", client: "requests" },
          },
          {
            key: "javascript",
            aliases: ["js"],
            displayName: "JavaScript",
            shikiLanguage: "javascript",
            httpSnippet: { target: "javascript", client: "fetch" },
          },
          {
            key: "node",
            aliases: ["nodejs", "node.js"],
            displayName: "Node.js",
            iconKey: "node",
            shikiLanguage: "javascript",
            httpSnippet: { target: "node", client: "fetch" },
          },
          {
            key: "php",
            displayName: "PHP",
            shikiLanguage: "php",
            httpSnippet: { target: "php", client: "curl" },
          },
          {
            key: "go",
            aliases: ["golang"],
            displayName: "Go",
            shikiLanguage: "go",
            httpSnippet: { target: "go" },
          },
          {
            key: "java",
            displayName: "Java",
            shikiLanguage: "java",
            httpSnippet: { target: "java" },
          },
          {
            key: "ruby",
            aliases: ["rb"],
            displayName: "Ruby",
            shikiLanguage: "ruby",
            httpSnippet: { target: "ruby" },
          },
          {
            key: "powershell",
            displayName: "PowerShell",
            shikiLanguage: "bash",
            httpSnippet: { target: "powershell" },
          },
          {
            key: "swift",
            displayName: "Swift",
            shikiLanguage: "swift",
            httpSnippet: { target: "swift" },
          },
          {
            key: "csharp",
            aliases: ["c#"],
            displayName: "C#",
            shikiLanguage: "csharp",
            httpSnippet: { target: "csharp", client: "restsharp" },
          },
          {
            key: "dotnet",
            aliases: [".net", ".NET", "dotnet", "dot-net"],
            displayName: ".NET",
            iconKey: "dot-net",
            shikiLanguage: "csharp",
            httpSnippet: { target: "csharp", client: "restsharp" },
          },
          {
            key: "typescript",
            aliases: ["ts"],
            displayName: "TypeScript",
            shikiLanguage: "typescript",
            httpSnippet: { target: "javascript", client: "fetch" },
          },
          { key: "c", displayName: "C", shikiLanguage: "c", httpSnippet: { target: "c" } },
          {
            key: "c++",
            aliases: ["cpp"],
            displayName: "C++",
            shikiLanguage: "c++",
            iconKey: "cplusplus",
            httpSnippet: { target: "c" },
          },
          {
            key: "kotlin",
            aliases: ["kt"],
            displayName: "Kotlin",
            shikiLanguage: "kotlin",
            httpSnippet: { target: "kotlin" },
          },
          {
            key: "rust",
            aliases: ["rs"],
            displayName: "Rust",
            shikiLanguage: "rust",
            httpSnippet: { target: "rust" },
          },
          {
            key: "dart",
            aliases: ["flutter"],
            displayName: "Dart",
            shikiLanguage: "dart",
            httpSnippet: { target: "dart" },
          },
        ],
        r = new Map();
      for (let e of t) {
        for (let a of (r.set(e.key.toLowerCase(), e), e.aliases ?? [])) r.set(a.toLowerCase(), e);
      }
      let o = (e) => r.get(e.toLowerCase()),
        n = (e) => o(e)?.displayName ?? e,
        s = (e) => {
          let a = o(e);
          return a ? (a.iconKey ?? a.key) : e.toLowerCase();
        },
        p = (e) => o(e)?.shikiLanguage ?? e,
        d = t.filter((e) =>
          ["bash", "python", "javascript", "php", "go", "java", "ruby"].includes(e.key),
        ),
        l = Object.fromEntries(
          t.flatMap((e) => [[e.key, e], ...(e.aliases ?? []).map((a) => [a, e])]),
        ),
        c = (e) => o(e)?.key ?? e.toLowerCase(),
        u = Object.fromEntries(
          t.flatMap((e) => [
            [e.key, e.displayName],
            ...(e.aliases ?? []).map((a) => [a, e.displayName]),
          ]),
        );
    },
    56452: (e, a, i) => {
      i.d(a, { HB: () => t, Lu: () => r, lb: () => o, xE: () => n });
      let t = "dark-plus",
        r = "github-light-default",
        o = (e) =>
          "object" == typeof e && "theme" in e && "object" == typeof e.theme
            ? { themes: e.theme }
            : "object" == typeof e && "theme" in e && "string" == typeof e.theme
              ? { themes: { light: e.theme, dark: e.theme } }
              : "dark" === e
                ? { themes: { light: t, dark: t } }
                : { themes: { light: r, dark: t } },
        n = (e) =>
          "system" === e || "dark" === e
            ? e
            : "object" == typeof e && "theme" in e && "object" == typeof e.theme
              ? "system"
              : "object" == typeof e && "theme" in e && "string" == typeof e.theme
                ? [
                    "catppuccin-latte",
                    "everforest-light",
                    "github-light",
                    "github-light-default",
                    "github-light-high-contrast",
                    "gruvbox-light-hard",
                    "gruvbox-light-medium",
                    "gruvbox-light-soft",
                    "kanagawa-lotus",
                    "light-plus",
                    "material-theme-lighter",
                    "min-light",
                    "one-light",
                    "rose-pine-dawn",
                    "slack-ochin",
                    "snazzy-light",
                    "solarized-light",
                    "vitesse-light",
                  ].includes(e.theme)
                  ? "system"
                  : "dark"
                : "system";
    },
    56991: (e, a, i) => {
      i.d(a, { $A: () => o, Mj: () => s, ql: () => n });
      var t = i(90280),
        r = i(43967);
      let o = "mintlify-user-info";
      async function n(e) {
        if (!e) {
          return null;
        }
        let a = await (0, r.l$)(o, p);
        if (!a) {
          return null;
        }
        let i = "shared-session" === e.type ? t.yU : t.eP,
          n = a.data.expiresAt ? 1e3 * a.data.expiresAt : a.retrievedAt + i;
        return Date.now() > n || (e.invalidatedAt && e.invalidatedAt > a.retrievedAt)
          ? null
          : a.data;
      }
      function s(e) {
        return (
          !!e &&
          "object" == typeof e &&
          (!("expiresAt" in e) || "number" == typeof e.expiresAt) &&
          (!("groups" in e) ||
            (Array.isArray(e.groups) && e.groups.every((e) => "string" == typeof e))) &&
          (!("content" in e) || (!!e.content && "object" == typeof e.content)) &&
          (!("apiPlaygroundInputs" in e) ||
            (!!e.apiPlaygroundInputs &&
              "object" == typeof e.apiPlaygroundInputs &&
              (!("header" in e.apiPlaygroundInputs) ||
                (!!e.apiPlaygroundInputs.header &&
                  "object" == typeof e.apiPlaygroundInputs.header)) &&
              (!("cookie" in e.apiPlaygroundInputs) ||
                (!!e.apiPlaygroundInputs.cookie &&
                  "object" == typeof e.apiPlaygroundInputs.cookie)) &&
              (!("query" in e.apiPlaygroundInputs) ||
                (!!e.apiPlaygroundInputs.query &&
                  "object" == typeof e.apiPlaygroundInputs.query)) &&
              (!("server" in e.apiPlaygroundInputs) ||
                (!!e.apiPlaygroundInputs.server &&
                  "object" == typeof e.apiPlaygroundInputs.server))))
        );
      }
      function p(e) {
        return (
          !!e &&
          "object" == typeof e &&
          "retrievedAt" in e &&
          "number" == typeof e.retrievedAt &&
          "data" in e &&
          s(e.data)
        );
      }
    },
    65904: (e, a, i) => {
      i.d(a, {
        DEFAULT_DARK_BG: () => l,
        DEFAULT_LIGHT_BG: () => c,
        LANGS: () => g,
        LINE_DIFF_ADD_CLASS_NAME: () => s,
        LINE_DIFF_REMOVE_CLASS_NAME: () => p,
        LINE_FOCUS_CLASS_NAME: () => n,
        LINE_HIGHLIGHT_CLASS_NAME: () => o,
        SHIKI_CLASSNAME: () => f,
        shikiColorReplacements: () => m,
        shikiLangMap: () => h,
      });
      var t = i(56452),
        r = i(58208);
      let o = "line-highlight",
        n = "line-focus",
        s = "line-diff line-add",
        p = "line-diff line-remove",
        d = r.CE.filter((e) => "css-variables" !== e && e !== t.HB && e !== t.Lu),
        l = "#0B0C0E",
        c = "#FFFFFF",
        u = [t.HB, t.Lu, ...d],
        g = [
          "bash",
          "c",
          "c++",
          "dart",
          "go",
          "java",
          "javascript",
          "json",
          "kotlin",
          "php",
          "python",
          "ruby",
          "rust",
          "swift",
          "csharp",
          "typescript",
          "tsx",
          "yaml",
        ],
        m = { [u[0]]: { "#1e1e1e": l } };
      (u[0], u[1]);
      let h = {
          curl: "bash",
          bash: "bash",
          sh: "bash",
          shell: "bash",
          zsh: "bash",
          shellscript: "bash",
          c: "c",
          csharp: "csharp",
          "c++": "c++",
          cpp: "c++",
          cc: "c++",
          go: "go",
          golang: "go",
          java: "java",
          javascript: "javascript",
          js: "javascript",
          node: "javascript",
          nodejs: "javascript",
          json: "json",
          jsonc: "json",
          json5: "json",
          php: "php",
          python: "python",
          py: "python",
          typescript: "typescript",
          ts: "typescript",
          tsx: "tsx",
          react: "tsx",
          reactts: "tsx",
          "react-ts": "tsx",
          jsx: "tsx",
          ruby: "ruby",
          rb: "ruby",
          rust: "rust",
          rs: "rust",
          rustc: "rust",
          swift: "swift",
          kotlin: "kotlin",
          kt: "kotlin",
          dart: "dart",
          flutter: "dart",
          yaml: "yaml",
          yml: "yaml",
          toml: "yaml",
        },
        f = "shiki shiki-themes";
    },
    66740: (e, a, i) => {
      i.d(a, { wC: () => d, V: () => c, yY: () => l });
      var t = i(7620),
        r = i(98167),
        o = i(80841),
        n = i(27194);
      let s = 3e4;
      class p extends Error {
        constructor(e = "Copy operation timed out") {
          (super(e), (this.name = "CopyTimeoutError"));
        }
      }
      let d = ({ pathname: e, onSuccess: a, onFail: i, timeout: t = s }) =>
        (function (e, a, i) {
          let t;
          return Promise.race([
            e,
            new Promise((e, r) => {
              t = setTimeout(() => {
                r(new p(i));
              }, a);
            }),
          ]).finally(() => {
            clearTimeout(t);
          });
        })(
          c(e, t).then(
            (e) =>
              new Promise((t) => {
                setTimeout(() => {
                  try {
                    let r = new ClipboardItem({
                      "text/plain": new Blob([e], { type: "text/plain" }),
                    });
                    navigator.clipboard
                      .write([r])
                      .then(() => {
                        (a?.(), t(!0));
                      })
                      .catch((e) => {
                        (i?.(e), t(!1));
                      });
                  } catch (e) {
                    (i?.(e), t(!1));
                  }
                }, 0);
              }),
          ),
          t,
          "Copy to clipboard timed out",
        ).catch((e) => (console.error("Failed to copy markdown:", e), i?.(e), !1));
      function l(e) {
        let a = (0, n.G)();
        (0, t.useEffect)(() => {
          let e = !1,
            i = async (i) => {
              let t = i.metaKey || i.ctrlKey;
              if (t && "a" === i.key) {
                e = !0;
                return;
              }
              if ("c" !== i.key && !t) {
                e = !1;
                return;
              }
              if (t && "c" === i.key) {
                let i = window.getSelection();
                if (i && i.toString().length > 0 && !e) {
                  return;
                }
                (d({ pathname: a }), (e = !1));
              }
            },
            t = () => {
              e = !1;
            };
          return (
            window.addEventListener("keydown", i),
            window.addEventListener("mousedown", t),
            () => {
              (window.removeEventListener("keydown", i),
                window.removeEventListener("mousedown", t));
            }
          );
        }, [a, e]);
      }
      async function c(e, a = s) {
        var i;
        let t = (i = (0, o.$)(e)) ? `/${i}` : "",
          n = "" === t || t.endsWith("/") ? `${t}index.md` : `${t}.md`,
          d = `${r.c.BASE_PATH}${n}`,
          l = new AbortController(),
          u = setTimeout(() => l.abort(), a);
        try {
          let e = await fetch(d, { signal: l.signal });
          if ((clearTimeout(u), !e.ok)) {
            throw Error(`Failed to fetch markdown: ${e.status} ${e.statusText}`);
          }
          return await e.text();
        } catch (e) {
          if ((clearTimeout(u), e instanceof Error && "AbortError" === e.name)) {
            throw (console.error("Fetch markdown timed out"), new p("Fetch markdown timed out"));
          }
          return (console.error("Error fetching markdown:", e), "");
        }
      }
    },
    67377: (e, a, i) => {
      i.d(a, { f: () => n });
      var t = i(7620),
        r = i(30793),
        o = i(98167);
      let n = () => {
        let { userAuth: e, auth: a, userInfo: i } = (0, t.useContext)(r.AuthContext);
        return (0, t.useMemo)(
          () =>
            ("cli" === o.c.ENV || "development" === o.c.ENV) && i?.groups && i.groups.length > 0
              ? [...i.groups, "*"]
              : e || a
                ? [...(i?.groups ?? []), "*"]
                : void 0,
          [a, e, i?.groups],
        );
      };
    },
    67793: (e, a, i) => {
      i.d(a, { N: () => s });
      var t = i(84514),
        r = i(80841),
        o = i(18423);
      function n(e) {
        if ("" === e) {
          return "index";
        }
        if ("index" === e) {
          return e;
        }
        if (e.endsWith("/index")) {
          let a = (0, t.C)(e);
          return "" === a ? "index" : a;
        }
        return e;
      }
      function s(e, a) {
        if (null == e || null == a || "string" != typeof e || "string" != typeof a) {
          return !1;
        }
        let i = (0, o.f)((0, r.$)(e)),
          t = (0, o.f)((0, r.$)(a));
        return n(i) === n(t);
      }
    },
    70785: (e, a, i) => {
      i.d(a, { v: () => t });
      let t = (e) => {
        if (!e || "string" != typeof e) {
          return !1;
        }
        try {
          return URL.canParse(e);
        } catch (e) {
          return !1;
        }
      };
    },
    71252: (e, a, i) => {
      i.d(a, { K: () => l, LivePreviewProvider: () => g });
      var t = i(54568),
        r = i(27541),
        o = i(7620),
        n = i(20388),
        s = i(72179),
        p = i(29917);
      function d() {
        let e = Array.from(window.location.ancestorOrigins ?? []).find((e) => (0, s.$$)(e)) ?? null;
        if (e) {
          return e;
        }
        if (window.parent === window) {
          return null;
        }
        try {
          let e = document.referrer;
          if (e) {
            let a = new URL(e).origin;
            if ((0, s.$$)(a)) {
              return a;
            }
          }
        } catch {}
        return null;
      }
      let l = (0, o.createContext)({
        isLivePreview: !1,
        livePreviewUpdateId: null,
        getDocsConfigOverrides: () => void 0,
        getNavigationOverride: () => void 0,
        clearDocsConfigOverrides: () => {},
        liveContent: new Map(),
        liveImages: new Map(),
        compiledContent: new Map(),
        getCompiledContent: () => void 0,
        liveMetadata: new Map(),
        loadingPaths: new Set(),
        isPathLoading: () => !1,
      });
      function c() {
        try {
          let e = new URL(window.location.href);
          return "true" === e.searchParams.get(s.ax) || window.location.pathname.includes(s.uV);
        } catch {
          return !1;
        }
      }
      function u() {
        if (!c()) {
          return new Set();
        }
        let e = window.location.pathname;
        return new Set(["/" + (0, s.Tn)(e).replace(/^\//, "")]);
      }
      function g({ children: e, isLivePreviewRoute: a = !1 }) {
        let i = (0, r.useRouter)(),
          [g, m] = (0, o.useState)(c),
          [h, f] = (0, o.useState)(!1),
          v = (0, o.useMemo)(() => a || g || h || null !== d(), [a, g, h]);
        (0, o.useRef)(v).current = v;
        let [y, k] = (0, o.useState)(null),
          [C, b] = (0, o.useState)(void 0),
          P = (0, o.useRef)(C);
        P.current = C;
        let [A, S] = (0, o.useState)(new Map()),
          [w, I] = (0, o.useState)(new Map()),
          [T, M] = (0, o.useState)(new Map()),
          [E, R] = (0, o.useState)(new Map()),
          [z, x] = (0, o.useState)(void 0),
          [O, j] = (0, o.useState)(u),
          B = (0, o.useRef)(new Map()),
          F = (0, o.useCallback)(
            (e) => {
              let a = "/" + e.replace(/^\//, "");
              return O.has(a);
            },
            [O],
          ),
          L = (0, o.useCallback)((e) => {
            let a = "/" + e.replace(/^\//, "");
            j((e) => {
              let i = new Set(e);
              return (i.add(a), i);
            });
          }, []),
          D = (0, o.useCallback)((e) => {
            let a = "/" + e.replace(/^\//, ""),
              i = B.current.get(a);
            (i && (clearTimeout(i), B.current.delete(a)),
              j((e) => {
                let i = new Set(e);
                return (i.delete(a), i);
              }));
          }, []),
          N = (0, o.useCallback)(
            (e) => {
              let a = "/" + e.replace(/^\//, "");
              L(a);
              let i = B.current.get(a);
              i && clearTimeout(i);
              let t = setTimeout(() => {
                (B.current.delete(a),
                  j((e) => {
                    let i = new Set(e);
                    return (i.delete(a), i);
                  }));
              }, 500);
              B.current.set(a, t);
            },
            [L],
          ),
          V = (0, o.useCallback)(
            (e) => {
              let a = "/" + e.path.replace(/^\//, "");
              (M((i) => {
                let t = new Map(i);
                return (t.set(a, { ...e, path: a }), t);
              }),
                R((i) => {
                  let t = new Map(i);
                  return (t.set(a, e.metadata), t);
                }),
                D(a),
                k((0, n.A)()));
            },
            [D],
          ),
          q = (0, o.useCallback)((e) => T.get(e), [T]),
          U = (0, o.useRef)(!1);
        (0, o.useEffect)(() => {
          let e = (function () {
            try {
              let e = new URLSearchParams(window.location.search);
              return "true" === e.get(s.ax);
            } catch {
              return !1;
            }
          })();
          (e && !g && m(!0),
            U.current ||
              (async () => {
                let a = await (0, p.U9)(s.nY);
                if (("true" !== a || h || f(!0), e || "true" === a)) {
                  let e = await (0, p.U9)(s.Ug);
                  if (e) {
                    try {
                      let a = JSON.parse(e);
                      a && "object" == typeof a && (b(a), k((0, n.A)()));
                    } catch {
                      b(void 0);
                    }
                  }
                }
                U.current = !0;
              })());
        }, []);
        let _ = (0, o.useCallback)(() => C, [C]),
          G = (0, o.useCallback)(() => z, [z]),
          K = (0, o.useCallback)(() => {
            ((0, p.Ai)(s.Ug), (0, p.Ai)(s.nY), b(void 0), x(void 0));
          }, []);
        return (
          (0, o.useEffect)(() => {
            if ((g && (0, p.SO)(s.nY, "true"), !v)) {
              return;
            }
            let e = (e) => {
              if ((0, s.$$)(e.origin)) {
                if (e.data.type === s.mT) {
                  let a = e.data.docsJson,
                    i = !0 === e.data.replace;
                  if (a && "object" == typeof a) {
                    let e = i ? a : { ...P.current, ...a };
                    ((0, p.SO)(s.Ug, JSON.stringify(e)), b(e), k((0, n.A)()));
                  }
                }
                if (e.data.type === s.he) {
                  let {
                    path: a,
                    mdxSource: i,
                    mdxSourceWithNoJs: t,
                    metadata: r,
                    images: o,
                  } = e.data;
                  ("string" == typeof a &&
                    a.startsWith("/") &&
                    !a.includes("..") &&
                    i &&
                    t &&
                    V({ path: a, mdxSource: i, mdxSourceWithNoJs: t, metadata: r || {} }),
                    Array.isArray(o) &&
                      I((e) => {
                        let a = new Map(e);
                        for (let e of o) {
                          "object" == typeof e &&
                            null !== e &&
                            "imagePath" in e &&
                            "dataUrl" in e &&
                            "string" == typeof e.imagePath &&
                            "string" == typeof e.dataUrl &&
                            a.set(e.imagePath, e.dataUrl);
                        }
                        return a;
                      }));
                }
                if (e.data.type === s.E4) {
                  let a = e.data.navigation;
                  a && "object" == typeof a && (x(a), k((0, n.A)()));
                }
                if (
                  (e.data.type === s.TR && (K(), k((0, n.A)())),
                  e.data.type === s.zt && window.history.back(),
                  e.data.type === s.$N && window.history.forward(),
                  e.data.type === s.F2 && window.location.reload(),
                  e.data.type === s.Fk && e.data.url && "string" == typeof e.data.url)
                ) {
                  try {
                    let a = new URL(e.data.url.trim().replaceAll(" ", "+"), window.location.origin);
                    (a.searchParams.set(s.ax, "true"),
                      a.pathname !== window.location.pathname && i.push(a.pathname + a.search));
                  } catch {}
                }
              }
            };
            window.addEventListener("message", e);
            let a = () => {
              let e = d();
              if (e) {
                return (window.parent.postMessage({ type: s.Dn }, e), !0);
              }
              if (window.parent !== window) {
                let e = (function () {
                  let e = [...s.qu];
                  try {
                    let a = document.referrer;
                    if (a) {
                      let i = new URL(a).origin;
                      (0, s.$$)(i) && !e.includes(i) && e.unshift(i);
                    }
                  } catch {}
                  for (let a of Array.from(window.location.ancestorOrigins ?? [])) {
                    (0, s.$$)(a) && !e.includes(a) && e.unshift(a);
                  }
                  return e;
                })();
                for (let a of e) {
                  try {
                    window.parent.postMessage({ type: s.Dn }, a);
                  } catch {}
                }
                return e.length > 0;
              }
              return !1;
            };
            a();
            let t = 0,
              r = setInterval(() => {
                if (++t >= 3) {
                  return clearInterval(r);
                }
                a();
              }, 500);
            return () => {
              (window.removeEventListener("message", e), clearInterval(r));
            };
          }, [v, g, K, i, V, L]),
          (0, o.useEffect)(() => {
            if (!v) {
              return;
            }
            let e = d();
            if (!e) {
              return;
            }
            let a = null,
              i = (i) => {
                let t = (0, s.Tn)(i),
                  r = "/" + t.replace(/^\//, "");
                r !== a && ((a = r), N(t), window.parent.postMessage({ type: s.X1, path: t }, e));
              },
              t = (0, s.Tn)(window.location.pathname),
              r = window.location.href.replace(s.uV, "");
            (window.parent.postMessage({ type: s.mm, url: r, isBackForward: !1 }, e), i(t));
            let o = (a) => {
                let t = window.location.pathname,
                  r = (0, s.Tn)(t),
                  o = window.location.href.replace(s.uV, "");
                (window.parent.postMessage({ type: s.mm, url: o, isBackForward: a }, e), i(r));
              },
              n = () => {
                o(!0);
              };
            window.addEventListener("popstate", n);
            let p = window.history.pushState,
              l = window.history.replaceState;
            return (
              (window.history.pushState = function (...e) {
                (p.apply(window.history, e), o(!1));
              }),
              (window.history.replaceState = function (...e) {
                (l.apply(window.history, e), o(!1));
              }),
              () => {
                (window.removeEventListener("popstate", n),
                  (window.history.pushState = p),
                  (window.history.replaceState = l));
              }
            );
          }, [v, N]),
          (0, o.useEffect)(() => {
            if (!v) {
              return;
            }
            let e = window.location.origin,
              a = (a) => {
                let i = a.target;
                if (!(i instanceof Element)) {
                  return;
                }
                let t = i.closest("a");
                if (!t) {
                  return;
                }
                let r = t.getAttribute("href");
                if (
                  !(!r || r.startsWith("/") || r.startsWith("#") || r.startsWith("?")) &&
                  !(r.startsWith("mailto:") || r.startsWith("tel:") || r.startsWith("sms:"))
                ) {
                  try {
                    if (new URL(r, e).origin === e) {
                      return;
                    }
                  } catch {
                    return;
                  }
                  (a.preventDefault(), a.stopPropagation());
                }
              },
              i = (a) => {
                let i = document.activeElement?.getAttribute("href");
                if (i) {
                  try {
                    new URL(i, e).origin !== e && a.preventDefault();
                  } catch {
                    return;
                  }
                }
              };
            return (
              document.addEventListener("click", a, !0),
              window.addEventListener("beforeunload", i),
              () => {
                (document.removeEventListener("click", a, !0),
                  window.removeEventListener("beforeunload", i));
              }
            );
          }, [v]),
          (0, t.jsx)(l.Provider, {
            value: {
              isLivePreview: v,
              livePreviewUpdateId: y,
              getDocsConfigOverrides: _,
              getNavigationOverride: G,
              clearDocsConfigOverrides: K,
              liveContent: A,
              liveImages: w,
              compiledContent: T,
              getCompiledContent: q,
              liveMetadata: E,
              loadingPaths: O,
              isPathLoading: F,
            },
            children: e,
          })
        );
      }
    },
    72179: (e, a, i) => {
      i.d(a, {
        $$: () => w,
        $N: () => u,
        Dn: () => s,
        E4: () => v,
        F2: () => m,
        Fk: () => g,
        Mp: () => C,
        TR: () => d,
        Tn: () => T,
        UD: () => b,
        Ug: () => r,
        X1: () => y,
        ax: () => n,
        ec: () => k,
        he: () => f,
        iN: () => P,
        mT: () => p,
        mm: () => l,
        nY: () => h,
        qu: () => A,
        ti: () => I,
        uV: () => o,
        yv: () => M,
        zt: () => c,
      });
      var t = i(90280);
      let r = "docs-config-overrides",
        o = "/_live-preview",
        n = "_mintlify-live-preview",
        s = "livePreviewReady",
        p = "livePreviewDocsJsonOverride",
        d = "livePreviewReset",
        l = "LIVE_PREVIEW_URL_CHANGE",
        c = "LIVE_PREVIEW_NAVIGATE_BACK",
        u = "LIVE_PREVIEW_NAVIGATE_FORWARD",
        g = "LIVE_PREVIEW_NAVIGATE_TO_URL",
        m = "LIVE_PREVIEW_REFRESH",
        h = "livePreviewMode",
        f = "livePreviewCompiledContentUpdate",
        v = "livePreviewNavigationUpdate",
        y = "livePreviewRequestContent",
        k = "LIVE_PREVIEW_SESSIONSTORAGE_GET",
        C = "LIVE_PREVIEW_SESSIONSTORAGE_GET_RESPONSE",
        b = "LIVE_PREVIEW_SESSIONSTORAGE_SET",
        P = "LIVE_PREVIEW_SESSIONSTORAGE_REMOVE",
        A = t.HL ? ["http://localhost:3000"] : ["https://dashboard.mintlify.com"],
        S = [/^https:\/\/[a-z0-9-]+\.mintlify\.review$/];
      function w(e) {
        return !!A.includes(e) || S.some((a) => a.test(e));
      }
      let I = A;
      function T(e) {
        return e.includes(o) ? e.replace(o, "") || "/" : e;
      }
      function M(e) {
        if (
          !e ||
          e.startsWith("http://") ||
          e.startsWith("https://") ||
          e.startsWith("//") ||
          e.startsWith("mailto:") ||
          e.startsWith("tel:") ||
          e.includes(n)
        ) {
          return e;
        }
        let a = e.indexOf("#"),
          i = -1 !== a,
          t = i ? e.slice(0, a) : e,
          r = i ? e.slice(a) : "",
          o = t.includes("?") ? "&" : "?";
        return `${t}${o}${n}=true${r}`;
      }
    },
    76075: (e, a, i) => {
      i.d(a, { J: () => t });
      let t = ["anchors", "dropdowns", "languages", "tabs", "versions", "menu", "products"];
    },
    76829: (e, a, i) => {
      i.d(a, { NavigationContext: () => K, NavigationContextController: () => H, n: () => W });
      var t = i(54568),
        r = i(76075),
        o = i(2811);
      function n(e) {
        return "/" === e.charAt(0) ? e.substring(1) : e;
      }
      function s(e, a, i) {
        if ("pages" in a) {
          ("root" in a && "object" == typeof a.root && s(e, a.root, i),
            a.pages.forEach((a) => s(e, a, i)));
        } else if ("href" in a) {
          let t = n(a.href),
            r = e.get(t);
          e.has(t) ? r !== i && void 0 !== r && e.set(t, void 0) : e.set(t, i);
        }
      }
      var p = i(27541),
        d = i(7620),
        l = i(27194),
        c = i(66740),
        u = i(28838),
        g = i(67377),
        m = i(52927);
      function h(e, a, i = !1, t = !0) {
        if (i) {
          return !0;
        }
        if (t && e.hidden) {
          return !1;
        }
        let r =
          Array.isArray(e.groups) && e.groups.every((e) => "string" == typeof e)
            ? e.groups
            : void 0;
        return !r || r.some((e) => a.has(e));
      }
      var f = i(53457),
        v = i(84514);
      function y(e, a, i = !1, t = !1) {
        if (e && "object" == typeof e) {
          if ((0, o.y)(e)) {
            if (i && a && !h(e, a, t)) {
              return;
            }
            return ((e.href = (0, v.C)(e.href)), e);
          }
          if ("pages" in e) {
            if ("root" in e && "object" == typeof e.root) {
              let r = y(e.root, a, i, t);
              if (r) {
                return ((r.href = (0, v.C)(r.href)), r);
              }
            }
            for (let r of e.pages) {
              if ("object" == typeof r) {
                let e = y(r, a, i, t);
                if (e) return ((e.href = (0, v.C)(e.href)), e);
              }
            }
          }
          if ("groups" in e) {
            for (let r of e.groups) {
              if (r.hidden) continue;
              let e = y(r, a, i, t);
              if (e) return ((e.href = (0, v.C)(e.href)), e);
            }
          }
          for (let o of r.J) {
            if (o in e) {
              let r = e[o];
              if (Array.isArray(r))
                for (let e of r) {
                  if ("object" == typeof e && "hidden" in e && e.hidden) continue;
                  let r = y(e, a, i, t);
                  if (r) return ((r.href = (0, v.C)(r.href)), r);
                }
            }
          }
        }
      }
      var k = i(70785),
        C = i(67793);
      let b = new Set([
          "en",
          "cn",
          "zh",
          "zh-Hans",
          "zh-Hant",
          "es",
          "fr",
          "fr-CA",
          "fr-ca",
          "ja",
          "jp",
          "ja-jp",
          "pt",
          "pt-BR",
          "de",
          "ko",
          "it",
          "ru",
          "ro",
          "cs",
          "id",
          "ar",
          "tr",
          "hi",
          "sv",
          "no",
          "lv",
          "nl",
          "uk",
          "vi",
          "pl",
          "uz",
          "he",
        ]),
        P = {
          en: "English",
          cn: "Chinese",
          zh: "Chinese",
          "zh-Hans": "Simplified Chinese",
          "zh-Hant": "Traditional Chinese",
          es: "Spanish",
          fr: "French",
          "fr-CA": "Canadian French",
          "fr-ca": "Canadian French",
          ja: "Japanese",
          jp: "Japanese",
          "ja-jp": "Japanese",
          pt: "Portuguese",
          "pt-BR": "Brazilian Portuguese",
          de: "German",
          ko: "Korean",
          it: "Italian",
          ru: "Russian",
          ro: "Romanian",
          cs: "Czech",
          id: "Indonesian",
          ar: "Arabic",
          tr: "Turkish",
          hi: "Hindi",
          sv: "Swedish",
          no: "Norwegian",
          lv: "Latvian",
          nl: "Dutch",
          uk: "Ukrainian",
          vi: "Vietnamese",
          pl: "Polish",
          uz: "Uzbek",
          he: "Hebrew",
        },
        A = Object.keys(P),
        S = Object.values(P),
        w = Object.values({
          en: "\uD83C\uDDFA\uD83C\uDDF8",
          cn: "\uD83C\uDDE8\uD83C\uDDF3",
          zh: "\uD83C\uDDE8\uD83C\uDDF3",
          "zh-Hans": "\uD83C\uDDE8\uD83C\uDDF3",
          "zh-Hant": "\uD83C\uDDF9\uD83C\uDDFC",
          es: "\uD83C\uDDEA\uD83C\uDDF8",
          fr: "\uD83C\uDDEB\uD83C\uDDF7",
          "fr-CA": "\uD83C\uDDE8\uD83C\uDDE6",
          "fr-ca": "\uD83C\uDDE8\uD83C\uDDE6",
          ja: "\uD83C\uDDEF\uD83C\uDDF5",
          jp: "\uD83C\uDDEF\uD83C\uDDF5",
          "ja-jp": "\uD83C\uDDE8\uD83C\uDDE6",
          pt: "\uD83C\uDDE7\uD83C\uDDF7",
          "pt-BR": "\uD83C\uDDE7\uD83C\uDDF7",
          de: "\uD83C\uDDE9\uD83C\uDDEA",
          ko: "\uD83C\uDDF0\uD83C\uDDF7",
          it: "\uD83C\uDDEE\uD83C\uDDF9",
          ru: "\uD83C\uDDF7\uD83C\uDDFA",
          ro: "\uD83C\uDDF7\uD83C\uDDF4",
          cs: "\uD83C\uDDE8\uD83C\uDDFF",
          id: "\uD83C\uDDEE\uD83C\uDDE9",
          ar: "\uD83C\uDDF8\uD83C\uDDE6",
          tr: "\uD83C\uDDF9\uD83C\uDDF7",
          hi: "\uD83C\uDDEE\uD83C\uDDF3",
          sv: "\uD83C\uDDF8\uD83C\uDDEA",
          no: "\uD83C\uDDF3\uD83C\uDDF4",
          lv: "\uD83C\uDDF1\uD83C\uDDFB",
          nl: "\uD83C\uDDF3\uD83C\uDDF1",
          uk: "\uD83C\uDDFA\uD83C\uDDE6",
          vi: "\uD83C\uDDFB\uD83C\uDDF3",
          pl: "\uD83C\uDDF5\uD83C\uDDF1",
          uz: "\uD83C\uDDFA\uD83C\uDDFF",
          he: "\uD83C\uDDEE\uD83C\uDDF1",
        }),
        I = ["jp", "cn", "zh", "zh-Hans", "zh-Hant"];
      (A.filter((e) => !I.includes(e)),
        S.filter((e) => "Chinese" !== e),
        w.filter((e) => "\uD83C\uDDE8\uD83C\uDDF3" !== e));
      var T = (function (e) {
        return (
          (e[(e.EXACT = 0)] = "EXACT"),
          (e[(e.PATH = 1)] = "PATH"),
          (e[(e.GROUP = 2)] = "GROUP"),
          (e[(e.DIVISION = 3)] = "DIVISION"),
          (e[(e.NONE = 4)] = "NONE"),
          e
        );
      })({});
      let M = ["docs", "doc", "documentation", "help"];
      function E({
        type: e,
        currentPath: a,
        entry: i,
        parentGroups: t,
        nearestDivisionValue: n,
        isActiveGroup: s,
        inActiveDivision: p,
        currentDivisionValue: d,
        allDivisionValues: l,
        firstHrefInDivision: c,
        navigationDivisions: u,
        isHiddenPage: g,
      }) {
        if ("object" == typeof i) {
          if (
            ((0, o.y)(i) &&
              (function (e, a, i, t, r, o, n, s, p, d) {
                let l = void 0 !== i ? [i] : (s ?? []);
                if ((a = a || "/") === o) {
                  for (let e of l) p.set(e, { href: a, matchLevel: 0 });
                  return;
                }
                if (
                  (d && void 0 !== n && p.set(n, { href: o, matchLevel: 0 }),
                  void 0 !== n && void 0 !== i)
                ) {
                  let t = p.get(i);
                  (void 0 === t || 1 < t.matchLevel) &&
                    (function (e, a, i) {
                      let t = e.split("/").filter(Boolean),
                        r = a.split("/").filter(Boolean);
                      if ("language" === i) {
                        let e = t[0] && M.includes(t[0]),
                          a = r[0] && M.includes(r[0]),
                          i = +!!e,
                          o = +!!a,
                          n = t[i] && b.has(t[i]),
                          s = r[o] && b.has(r[o]),
                          p = t.slice(e ? (n ? 2 : 1) : +!!n),
                          d = r.slice(a ? (s ? 2 : 1) : +!!s);
                        if (
                          ("index" === p.at(-1) && (p = p.slice(0, -1)),
                          "index" === d.at(-1) && (d = d.slice(0, -1)),
                          p.length !== d.length)
                        ) {
                          return !1;
                        }
                        for (let e = 0; e < p.length; e++) {
                          if (p[e] !== d[e]) return !1;
                        }
                        return e === a && (n !== s || (n && s && t[i] !== r[o]));
                      }
                      if (t.length !== r.length || t.length < 2 || t.at(-1) !== r.at(-1)) {
                        return !1;
                      }
                      let o = !1;
                      for (let e = 0; e < t.length - 1; e++) {
                        if (t[e] !== r[e]) {
                          if (o) return !1;
                          o = !0;
                        }
                      }
                      return !0;
                    })(a, o, e) &&
                    p.set(i, { href: a, matchLevel: 1 });
                }
                if (t) {
                  for (let e of l) {
                    let i = p.get(e);
                    (void 0 === i || 2 < i.matchLevel) && p.set(e, { href: a, matchLevel: 2 });
                  }
                  return;
                }
                if (r) {
                  for (let e of l) {
                    let i = p.get(e);
                    (void 0 === i || 3 < i.matchLevel) && p.set(e, { href: a, matchLevel: 3 });
                  }
                  return;
                }
                for (let e of l) {
                  p.has(e) || p.set(e, { href: a, matchLevel: 4 });
                }
              })(e, i.href, n, s, p, a, d, l, c, g),
            "pages" in i && Array.isArray(i.pages))
          ) {
            let r = "root" in i && null != i.root && "object" == typeof i.root ? i.root : void 0,
              s = void 0 !== r && (0, o.y)(r) && (0, C.N)(r.href, a) && d === n,
              m = i.pages.some((e) => (0, o.y)(e) && (0, C.N)(e.href, a)) && d === n;
            for (let o of (void 0 !== r &&
              E({
                type: e,
                currentPath: a,
                entry: r,
                parentGroups: t.length ? t : i.pages,
                nearestDivisionValue: n,
                isActiveGroup: m || s,
                inActiveDivision: p,
                currentDivisionValue: d,
                allDivisionValues: l,
                firstHrefInDivision: c,
                navigationDivisions: u,
                isHiddenPage: g,
              }),
            i.pages)) {
              "object" == typeof o &&
                E({
                  type: e,
                  currentPath: a,
                  entry: o,
                  parentGroups: t.length ? t : i.pages,
                  nearestDivisionValue: n,
                  isActiveGroup: m || s,
                  inActiveDivision: p,
                  currentDivisionValue: d,
                  allDivisionValues: l,
                  firstHrefInDivision: c,
                  navigationDivisions: u,
                  isHiddenPage: g,
                });
            }
          }
          if ("groups" in i && !(0, o.y)(i)) {
            for (let t of i.groups) {
              if ("object" != typeof t) continue;
              let r =
                (function e(a, i) {
                  if ((0, o.y)(a)) return (0, C.N)(a.href, i);
                  if ("pages" in a) {
                    if ("root" in a && "object" == typeof a.root && e(a.root, i)) return !0;
                    for (let t of a.pages) if (e(t, i)) return !0;
                  }
                  return !1;
                })(t, a) && d === n;
              E({
                type: e,
                currentPath: a,
                entry: t,
                parentGroups: i.groups,
                nearestDivisionValue: n,
                isActiveGroup: r,
                inActiveDivision: p,
                currentDivisionValue: d,
                allDivisionValues: l,
                firstHrefInDivision: c,
                navigationDivisions: u,
                isHiddenPage: g,
              });
            }
          }
          for (let o of [...r.J, "groups"]) {
            if (o in i) {
              let r = i[o];
              if (Array.isArray(r)) {
                let p = !1;
                for (let m of (l &&
                  l.length &&
                  ("version" === e && "versions" === o
                    ? (p = r.every((e) => l.includes(e.version)))
                    : "language" === e &&
                      "languages" === o &&
                      (p = r.every((e) => l.includes(e.language)))),
                r)) {
                  let r;
                  ("version" === e && "versions" === o
                    ? (r = "version" in m ? m.version : void 0)
                    : "language" === e &&
                      "languages" === o &&
                      (r = "language" in m ? m.language : void 0),
                    E({
                      type: e,
                      currentPath: a,
                      entry: m,
                      parentGroups: "groups" === o && "groups" in i ? i.groups : t,
                      nearestDivisionValue: r ?? n,
                      isActiveGroup: s,
                      inActiveDivision: p,
                      currentDivisionValue: d,
                      allDivisionValues: l,
                      firstHrefInDivision: c,
                      navigationDivisions: u,
                      isHiddenPage: g,
                    }));
                }
              }
            }
          }
        }
      }
      let R = {
          tabs: "tab",
          anchors: "anchor",
          versions: "version",
          languages: "language",
          dropdowns: "dropdown",
          menu: "item",
          products: "product",
        },
        z = ({
          currentPath: e,
          currentVersion: a,
          currentLanguage: i,
          decoratedNav: t,
          userGroups: n,
          shouldUseDivisionMatch: s = !0,
          cache: p,
          isPreview: d = !1,
        }) => {
          let l = {
              tabs: [],
              anchors: [],
              versions: [],
              languages: [],
              dropdowns: [],
              menu: [],
              products: [],
            },
            c = new Map(),
            u = new Map(),
            g = [],
            { page: m, groupsOrPages: f } = (function e({
              currentPath: t,
              entry: d,
              parentGroups: c,
              isPreview: u = !1,
              ancestorDivisionNames: g = [],
            }) {
              if ("object" != typeof d) {
                return { page: void 0, groupsOrPages: void 0 };
              }
              if ((0, o.y)(d)) {
                return h(d, n, u) && (0, C.N)(d.href, t)
                  ? { page: d, groupsOrPages: c }
                  : { page: void 0, groupsOrPages: void 0 };
              }
              if ("pages" in d) {
                if ("root" in d && "object" == typeof d.root) {
                  let a = c.length ? c : d.pages.map((e) => F(e, n, u)).filter((e) => void 0 !== e),
                    { page: i, groupsOrPages: r } = e({
                      currentPath: t,
                      entry: d.root,
                      parentGroups: a,
                      isPreview: u,
                      ancestorDivisionNames: g,
                    });
                  if (i) {
                    return { page: i, groupsOrPages: r };
                  }
                }
                for (let a of d.pages) {
                  if ("object" == typeof a) {
                    let i = d.pages.map((e) => F(e, n, u)).filter((e) => void 0 !== e),
                      { page: r, groupsOrPages: o } = e({
                        currentPath: t,
                        entry: a,
                        parentGroups: c.length ? c : i,
                        isPreview: u,
                        ancestorDivisionNames: g,
                      });
                    if (r) return { page: r, groupsOrPages: o };
                  }
                }
              }
              if ("groups" in d) {
                let a = B(d.groups, n, u);
                for (let i of a) {
                  let { page: r, groupsOrPages: o } = e({
                    currentPath: t,
                    entry: i,
                    parentGroups: a,
                    isPreview: u,
                    ancestorDivisionNames: g,
                  });
                  if (r) {
                    return { page: r, groupsOrPages: o };
                  }
                }
              }
              for (let o of r.J) {
                if (o in d) {
                  let r = d[o];
                  if (Array.isArray(r))
                    for (let d of r) {
                      if (
                        s &&
                        N({
                          subDivision: d,
                          key: o,
                          currentVersion: a,
                          currentLanguage: i,
                          subDivisions: r,
                        })
                      )
                        continue;
                      let m = j(d),
                        {
                          page: h,
                          groupsOrPages: f,
                          menuDivision: v,
                        } = e({
                          currentPath: t,
                          entry: d,
                          parentGroups: c,
                          isPreview: u,
                          ancestorDivisionNames: m ? [...g, m] : g,
                        });
                      if (h) {
                        let e = r
                          .filter((e) => L(e, n, u))
                          .map((e) => {
                            let a = D(e, d);
                            if (!("hidden" in e) || !e.hidden || a)
                              return O({
                                item: e,
                                isActive: a,
                                cache: p,
                                userGroups: n,
                                divisionKey: o,
                                menuDivision: v,
                                isPreview: u,
                                parentDivisionNames: g,
                              });
                          })
                          .filter(Boolean);
                        if (("global" in d && x(l, d.global), e.length))
                          return (
                            l[o].push(...e),
                            { page: h, groupsOrPages: f, menuDivision: "menu" === o ? e : void 0 }
                          );
                      }
                    }
                }
              }
              return { page: void 0, groupsOrPages: void 0 };
            })({
              currentPath: "/" === e || "" === e ? y(t)?.href || "" : e,
              entry: t,
              parentGroups: [],
              isPreview: d,
            });
          if (!m && t) {
            let { divisions: c, groupsOrPages: u } = (function (e, a, i, t, n, s, p, d = !1) {
              let l,
                c,
                u = {
                  tabs: [],
                  anchors: [],
                  versions: [],
                  languages: [],
                  dropdowns: [],
                  menu: [],
                  products: [],
                },
                g = !0;
              if (
                (!(function a(p, u) {
                  if ("object" == typeof p) {
                    if ((0, o.y)(p)) {
                      if (!(0, C.N)(e, p.href) && h(p, n, d)) {
                        let a = (function (e, a) {
                            let i = Math.min(e.length, a.length),
                              t = 0;
                            for (let r = 0; r < i && e[r] === a[r]; r++) t++;
                            return e.substring(0, t);
                          })(e, p.href),
                          i = a.length > (c?.length || 0),
                          t = a === c;
                        i ? ((c = a), (l = u)) : t && "/" === c && !l && (l = u);
                      } else (0, C.N)(e, p.href) && (g = h(p, n, d, !1));
                    }
                    if ("pages" in p && Array.isArray(p.pages)) {
                      let e = u.length
                        ? u
                        : p.pages.map((e) => F(e, n, d)).filter((e) => void 0 !== e);
                      for (let i of ("root" in p && "object" == typeof p.root && a(p.root, e),
                      p.pages)) {
                        "object" == typeof i && a(i, e);
                      }
                    }
                    if ("groups" in p && !(0, o.y)(p)) {
                      let e = B(p.groups, n, d);
                      for (let i of p.groups) {
                        a(i, e);
                      }
                    }
                    for (let e of r.J) {
                      if (e in p) {
                        let r = p[e];
                        if (Array.isArray(r))
                          for (let o of r)
                            (s &&
                              N({
                                subDivision: o,
                                key: e,
                                currentVersion: i,
                                currentLanguage: t,
                                subDivisions: r,
                              })) ||
                              a(o, u);
                      }
                    }
                  }
                })(a, []),
                (l = g ? l : []))
              ) {
                let e = (e) =>
                  JSON.stringify(structuredClone(l)) === JSON.stringify(structuredClone(e));
                !(function a(l, c, m = []) {
                  if ("object" != typeof l) {
                    return !1;
                  }
                  if ("pages" in l && Array.isArray(l.pages)) {
                    return e(
                      c.length ? c : l.pages.map((e) => F(e, n, d)).filter((e) => void 0 !== e),
                    );
                  }
                  if ("groups" in l && !(0, o.y)(l)) {
                    return e(B(l.groups, n, d));
                  }
                  for (let e of r.J) {
                    if (e in l) {
                      let r = l[e];
                      if (Array.isArray(r))
                        for (let o of r) {
                          if (
                            s &&
                            N({
                              subDivision: o,
                              key: e,
                              currentVersion: i,
                              currentLanguage: t,
                              subDivisions: r,
                            })
                          )
                            continue;
                          let l = j(o);
                          if (a(o, c, l ? [...m, l] : m) || !g) {
                            let a = r
                              .filter((e) => L(e, n, d))
                              .map((a) => {
                                let i = D(a, o) && !0 === g;
                                if (!a.hidden || i)
                                  return O({
                                    item: a,
                                    isActive: i,
                                    cache: p,
                                    userGroups: n,
                                    divisionKey: e,
                                    isPreview: d,
                                    parentDivisionNames: m,
                                  });
                              })
                              .filter(Boolean);
                            return (u[e].push(...a), !0);
                          }
                        }
                    }
                  }
                  return !1;
                })(a, [], []);
              }
              return { divisions: u, groupsOrPages: l || [] };
            })(e, t, a, i, n, s, p, d);
            ((l = c), (g = u));
          }
          return (
            f && f.length && (g = f),
            l.versions.length &&
              E({
                type: "version",
                currentPath: e,
                entry: t,
                parentGroups: [],
                nearestDivisionValue: void 0,
                isActiveGroup: !1,
                inActiveDivision: !1,
                currentDivisionValue: l.versions.find((e) => e.isActive)?.name,
                allDivisionValues: l.versions.map((e) => e.name),
                firstHrefInDivision: c,
                navigationDivisions: l,
                isHiddenPage: void 0 === m,
              }),
            l.languages.length &&
              E({
                type: "language",
                currentPath: e,
                entry: t,
                parentGroups: [],
                nearestDivisionValue: void 0,
                isActiveGroup: !1,
                inActiveDivision: !1,
                currentDivisionValue: l.languages.find((e) => e.isActive)?.language,
                allDivisionValues: l.languages.map((e) => e.language),
                firstHrefInDivision: u,
                navigationDivisions: l,
                isHiddenPage: void 0 === m,
              }),
            t && "global" in t && t.global && x(l, t.global),
            {
              tabs: l.tabs,
              anchors: l.anchors,
              versions: l.versions,
              languages: l.languages,
              dropdowns: l.dropdowns,
              products: l.products,
              groupsOrPages: g,
              firstHrefInVersion: c,
              firstHrefInLanguage: u,
            }
          );
        };
      function x(e, a) {
        a &&
          Object.entries(e).forEach(([e, i]) => {
            if (e in a) {
              let t = a[e];
              if (t) {
                let e = t.filter((e) => !e.hidden);
                i.push(
                  ...e.map((e) => ({ name: j(e), ...e, href: e.href, isActive: !1, isGlobal: !0 })),
                );
              }
            }
          });
      }
      function O(e) {
        let {
            item: a,
            isActive: i,
            cache: t,
            userGroups: o,
            divisionKey: n,
            menuDivision: s,
            isPreview: p = !1,
            parentDivisionNames: d = [],
          } = e,
          { dropdownCache: l } = t,
          c = "";
        if (l.size && "dropdowns" in a) {
          let e = V(a.dropdowns, [...d, j(a)].filter(Boolean).join(":") || void 0),
            i = l.get(e);
          e && i && (c = (0, f.Mi)(i));
        }
        let u = y(a, o, !!o, p),
          g = new Set([...r.J, "groups", "pages"]),
          m = Object.fromEntries(Object.entries(a).filter(([e]) => !g.has(e)));
        if (!c) {
          let e = "href" in a && (0, k.v)(a.href);
          ((c = e ? a.href : u?.href || "/"), e || "languages" !== n || (c = ""));
        }
        let h = { name: j(a), ...m, href: c, isActive: i, isGlobal: !1 };
        if ("tabs" === n && "menu" in a) {
          if (i && s?.length) {
            return { ...h, menu: s };
          }
          let e = j(a),
            r = a.menu
              .filter((e) => L(e, o || new Set(), p))
              .map((a) => {
                if (!a.hidden) {
                  return O({
                    item: a,
                    isActive: !1,
                    cache: t,
                    userGroups: o,
                    divisionKey: "menu",
                    isPreview: p,
                    parentDivisionNames: [...d, ...(e ? [e] : [])],
                  });
                }
              })
              .filter((e) => void 0 !== e);
          return { ...h, menu: r };
        }
        return h;
      }
      function j(e) {
        if ("name" in e && "string" == typeof e.name) {
          return e.name;
        }
        let a = Object.values(R).find((a) => a in e);
        if (a) {
          let i = e[a];
          if ("string" == typeof i) {
            return i;
          }
        }
        return "";
      }
      function B(e, a, i = !1) {
        return Array.isArray(e) && e.length
          ? e.map((e) => F(e, a, i)).filter((e) => void 0 !== e && !e.hidden)
          : [];
      }
      function F(e, a, i = !1) {
        if ("object" != typeof e) {
          return;
        }
        if ((0, o.y)(e)) {
          return h(e, a, i) ? e : void 0;
        }
        if (e.hidden) {
          return;
        }
        let t = { ...e };
        if ("pages" in e) {
          let r = e.pages.map((e) => F(e, a, i)).filter((e) => void 0 !== e),
            o = !1;
          if (
            ("root" in e &&
              "object" == typeof e.root &&
              (F(e.root, a, i) ? (o = !0) : (t.root = void 0)),
            0 === r.length && !o)
          ) {
            return;
          }
          t.pages = r;
        }
        return t;
      }
      function L(e, a, i = !1) {
        if (i) {
          return !0;
        }
        if ("object" != typeof e) {
          return !1;
        }
        if ((0, o.y)(e)) {
          return h(e, a, i);
        }
        if ("pages" in e) {
          if ("root" in e && "object" == typeof e.root && L(e.root, a, i)) {
            return !0;
          }
          if (0 === e.pages.length) {
            return !1;
          }
          let t = !1;
          for (let r of e.pages) {
            if ("object" == typeof r && L(r, a, i)) {
              t = !0;
              break;
            }
          }
          if (!t) {
            return !1;
          }
        }
        if ("groups" in e) {
          if (0 === e.groups.length || e.groups.every((e) => e.hidden)) {
            return !1;
          }
          let t = !1;
          for (let r of e.groups) {
            if (L(r, a, i)) {
              t = !0;
              break;
            }
          }
          if (!t) {
            return !1;
          }
        }
        for (let t of r.J) {
          if (t in e) {
            let r = e[t];
            if (r.every((e) => e.hidden) || !r.some((e) => L(e, a, i))) return !1;
          }
        }
        return !0;
      }
      let D = (e, a) => JSON.stringify(structuredClone(e)) === JSON.stringify(structuredClone(a));
      function N({
        subDivision: e,
        key: a,
        currentVersion: i,
        currentLanguage: t,
        subDivisions: r,
      }) {
        let o = "versions" === a && !!i,
          n = "languages" === a && !!t;
        if (o) {
          let a = r.map((e) => e.version);
          return e.version !== i && a.includes(i);
        }
        if (n) {
          let a = r.map((e) => e.language);
          return e.language !== t && a.includes(t);
        }
        return !1;
      }
      function V(e, a) {
        let i = e[0];
        if (!i) {
          return "";
        }
        let t = Object.values(R).find((e) => e in i);
        if (!t) {
          return "";
        }
        let r = e.reduce((e, a) => e + a[t], "");
        return a ? `${a}:${r}` : r;
      }
      function q(e, a, i, t, n) {
        let s = (function e(a, i, t, n, s, p) {
            let d = "version" === a ? "" : void 0;
            if ("object" != typeof i) {
              return d;
            }
            if ((0, o.y)(i)) {
              if (!(0, C.N)(i.href, n)) return d;
              else
                return (function (e, a) {
                  let i = { value: 0 };
                  return (
                    (function e(a, i, t) {
                      if ("object" == typeof a) {
                        for (let n of ((0, o.y)(a) && (0, C.N)(a.href, i) && t.value++,
                        [...r.J, "groups", "pages"]))
                          if (n in a) {
                            "pages" === n &&
                              "root" in a &&
                              "object" == typeof a.root &&
                              e(a.root, i, t);
                            let r = a[n];
                            if (Array.isArray(r)) for (let a of r) e(a, i, t);
                          }
                      }
                    })(e, a, i),
                    i.value > 1
                  );
                })(t, n) &&
                  s &&
                  s !== p
                  ? d
                  : "version" === a
                    ? (i.version ?? p)
                    : p;
            }
            for (let o of [...r.J, "groups", "pages"]) {
              if (o in i) {
                let r = i[o];
                if (
                  ("pages" === o &&
                    "root" in i &&
                    "object" == typeof i.root &&
                    (r = [i.root, ...r]),
                  Array.isArray(r))
                )
                  for (let i of r) {
                    let r;
                    r =
                      "version" === a
                        ? "version" in i
                          ? i.version
                          : void 0
                        : "language" in i
                          ? i.language
                          : void 0;
                    let o = e(a, i, t, n, s, r ?? p);
                    if (o && o !== d) return o;
                  }
              }
            }
            return d;
          })(e, a, a, i, t, void 0),
          p = t || n;
        return s || p;
      }
      var U = i(80841),
        _ = i(7844),
        G = i(30793);
      let K = (0, d.createContext)({
          selectedVersion: "",
          setSelectedVersion: () => {},
          navIsOpen: !1,
          setNavIsOpen: () => !1,
          selectedLocale: void 0,
          setSelectedLocale: () => {},
          isUpdatingCache: !1,
          divisions: {
            tabs: [],
            anchors: [],
            versions: [],
            languages: [],
            dropdowns: [],
            groupsOrPages: [],
            products: [],
          },
          hasAdvancedTabs: !1,
          pageMetadata: {},
          setPageMetadata: () => {},
        }),
        H = ({ children: e }) => {
          let a = (0, d.useRef)(!1),
            i = (0, l.G)(),
            { docsNavWithMetadata: m } = (0, d.useContext)(G.DocsConfigContext),
            { actualSubdomain: h, preview: f } = (0, d.useContext)(G.DeploymentMetadataContext),
            { auth: v, isFetchingUserInfo: y } = (0, d.useContext)(G.AuthContext),
            { navigationData: k, updateCache: C, isUpdatingCache: b } = (0, u.Y)(m),
            P = (0, d.useRef)(!0),
            A = (0, p.useRouter)(),
            S = (0, g.f)(),
            [w, I] = (0, d.useState)(!1);
          (0, c.yY)(h);
          let M = (0, d.useMemo)(() => v ?? void 0, [v]),
            E = !!M,
            { initialLocale: R, initialVersion: x } = (0, d.useMemo)(() => {
              if (!m) {
                return { initialLocale: void 0, initialVersion: void 0 };
              }
              let e = z({
                currentPath: i,
                decoratedNav: E ? k : m,
                userGroups: new Set(S),
                currentVersion: void 0,
                currentLanguage: void 0,
                shouldUseDivisionMatch: !1,
                cache: { dropdownCache: new Map() },
                isPreview: !!f,
              });
              if (0 === e.languages.length && 0 === e.versions.length) {
                return { initialLocale: void 0, initialVersion: void 0 };
              }
              let a = e.versions.find((e) => e.default)?.version,
                t = e.languages.find((e) => e.default)?.language,
                r = E ? (k ?? m) : m,
                o = q("version", r, i, a, e.versions[0]?.name ?? "");
              return {
                initialLocale: q("language", r, i, t, e.languages[0]?.language ?? void 0) || void 0,
                initialVersion: o || "",
              };
            }, [m, i, E, k, S, f]),
            O = (0, d.useMemo)(
              () =>
                m
                  ? (function (e) {
                      let a = new Map();
                      return (
                        (function e(a, i, t) {
                          if ("object" == typeof i) {
                            if ((0, o.y)(i)) {
                              let e = n(i.href),
                                r = a.get(e);
                              a.has(e) ? void 0 !== r && r !== t && a.set(e, void 0) : a.set(e, t);
                            }
                            if ("pages" in i && Array.isArray(i.pages)) {
                              for (let r of ("root" in i &&
                                "object" == typeof i.root &&
                                e(a, i.root, t),
                              i.pages))
                                "object" == typeof r && e(a, r, t);
                            }
                            for (let o of ["groups", ...r.J]) {
                              if (o in i) {
                                let r = i[o];
                                if (Array.isArray(r))
                                  for (let i of r) {
                                    let r = t;
                                    ("versions" === o && (r = i.version), e(a, i, r));
                                  }
                              }
                            }
                          }
                        })(a, e),
                        a
                      );
                    })(m)
                  : new Map(),
              [m],
            ),
            j = (0, d.useMemo)(
              () =>
                m
                  ? (function (e) {
                      let a = new Map();
                      return (
                        (function e(a, i, t) {
                          let o = "language" in i ? i.language : t;
                          if ("pages" in i) {
                            ("root" in i && "object" == typeof i.root && s(a, i.root, o),
                              i.pages.forEach((e) => s(a, e, o)));
                            return;
                          }
                          for (let t of ["groups", ...r.J]) {
                            t in i && Array.isArray(i[t]) && i[t].forEach((i) => e(a, i, o));
                          }
                        })(a, e, void 0),
                        a
                      );
                    })(m)
                  : new Map(),
              [m],
            ),
            [B, F] = (0, d.useState)(R),
            [L, D] = (0, d.useState)(x ?? ""),
            [N, H] = (0, d.useState)({}),
            [W, $] = (0, d.useState)(new Map());
          (0, d.useEffect)(() => {
            y && (F(R), D(x ?? ""));
          }, [R, x, y]);
          let Y = (0, d.useMemo)(() => {
              let e = (0, U.$)(i),
                a = O.get(e) ?? L,
                t = j.get(e) ?? B;
              return z({
                currentPath: i,
                decoratedNav: E ? k : m,
                userGroups: new Set(S),
                currentVersion: a,
                currentLanguage: t,
                shouldUseDivisionMatch: P.current,
                cache: { dropdownCache: W },
                isPreview: !!f,
              });
            }, [i, O, L, j, B, E, k, m, S, W, f]),
            Q = (0, d.useRef)(i);
          ((0, d.useEffect)(() => {
            let e = (0, U.$)(i),
              a = O.get(e) ?? L,
              t = j.get(e) ?? B;
            (a !== L && a && e !== Q.current && D(a),
              t !== B && t && e !== Q.current && F(t),
              (Q.current = e));
          }, [i, O, j, L, B]),
            (0, d.useEffect)(() => {
              E && C();
            }, [M, C, E]));
          let J = (0, d.useCallback)(
              (e) => {
                if (e === L) {
                  return;
                }
                D(e);
                let a = Y.firstHrefInVersion.get(e),
                  t = a?.href;
                null != t &&
                  (t != i && (a?.matchLevel || 0) <= T.DIVISION
                    ? (P.current = !1)
                    : (P.current = !0),
                  A.push(t));
              },
              [L, Y.firstHrefInVersion, i, A],
            ),
            Z = (0, d.useCallback)(
              (e) => {
                if (e === B) {
                  return;
                }
                F(e);
                let a = Y.firstHrefInLanguage.get(e),
                  t = a?.href;
                null != t &&
                  (t != i && (a?.matchLevel || 0) <= T.DIVISION
                    ? (P.current = !1)
                    : (P.current = !0),
                  A.push(t));
              },
              [B, Y.firstHrefInLanguage, i, A],
            );
          ((0, d.useEffect)(() => {
            let e = Y.versions.length > 0 && !Y.versions.some((e) => e.name === L),
              a = Y.languages.length > 0 && !Y.languages.some((e) => e.language === B);
            if (!y && !b) {
              if (e) {
                let e = Y.versions.find((e) => e.default)?.name,
                  a = Y.versions[0]?.name;
                J(e ?? a ?? "");
              }
              if (a && Y.languages[0]?.language) {
                let e = Y.languages.find((e) => e.default)?.language,
                  a = Y.languages[0]?.language;
                Z(e ?? a);
              }
            }
          }, [Y.versions, L, Y.languages, B, J, Z, b, y]),
            (0, d.useEffect)(() => {
              let e = Y.dropdowns;
              if (0 === e.length) {
                return;
              }
              let a = (e) => e.find((e) => e.isActive)?.name,
                i = V(
                  e,
                  [a(Y.versions), a(Y.languages), a(Y.products), a(Y.anchors), a(Y.tabs)]
                    .filter(Boolean)
                    .join(":") || void 0,
                ),
                t = e.find((e) => e.isActive);
              if (!t || !i) {
                return;
              }
              let r = (0, U.$)(t.href);
              if (W.get(i) === r) {
                return;
              }
              let o = new Map(W);
              (o.set(i, r), $(o));
            }, [Y.dropdowns, Y.products, Y.versions, Y.languages, Y.anchors, Y.tabs, W, i]),
            (0, d.useEffect)(() => {
              if ((I(!1), !a.current)) {
                a.current = !0;
                return;
              }
              setTimeout(() => (0, _.h)(), 0);
            }, [i]));
          let X = (0, d.useMemo)(() => Y.tabs.some((e) => e.menu?.length), [Y.tabs]);
          return (0, t.jsx)(K.Provider, {
            value: {
              navIsOpen: w,
              setNavIsOpen: I,
              selectedVersion: L,
              setSelectedVersion: J,
              selectedLocale: B,
              setSelectedLocale: Z,
              isUpdatingCache: b,
              locales: Y.languages.map((e) => e.language),
              divisions: Y,
              hasAdvancedTabs: X,
              pageMetadata: N,
              setPageMetadata: H,
            },
            children: e,
          });
        };
      function W() {
        let { selectedLocale: e } = (0, d.useContext)(K);
        return (0, d.useMemo)(() => (0, m.J)(e), [e]);
      }
      K.displayName = "NavigationContext";
    },
    79627: (e, a, i) => {
      i.d(a, { W: () => t });
      function t(e, a) {
        if (e) {
          if ("family" in e) {
            return e;
          } else if (a in e) {
            let i = e[a];
            return "string" == typeof i ? { family: i } : i;
          }
        }
      }
    },
    80841: (e, a, i) => {
      i.d(a, { $: () => t });
      function t(e) {
        return !e || e.startsWith("/") ? e.substring(1) : e;
      }
    },
    81325: (e, a, i) => {
      i.d(a, { cn: () => o });
      var t = i(72902),
        r = i(13714);
      function o(...e) {
        return (0, r.QP)((0, t.$)(e));
      }
    },
    84342: (e, a, i) => {
      i.d(a, { M: () => t });
      function t(e) {
        return e.startsWith("/") ? e : `/${e}`;
      }
    },
    84514: (e, a, i) => {
      i.d(a, { C: () => t });
      function t(e) {
        return "string" != typeof e
          ? e
          : e.endsWith("/index")
            ? e.slice(0, -6)
            : "index" === e
              ? ""
              : e;
      }
    },
    84525: (e, a, i) => {
      i.d(a, { P: () => f });
      var t = i(27541),
        r = i(7620),
        o = i(98167),
        n = i(43967),
        s = i(56991);
      async function p(e, a, t) {
        let r,
          [o, n] = (function (e) {
            if (d(e)) {
              return [e, null];
            }
            let a = new URLSearchParams(e),
              i = a.get("jwt");
            return i && d(i) ? [i, a.get("anchor")] : [null, null];
          })(location.hash.slice(1));
        if (!o) {
          let a = await (0, s.ql)(e);
          if (a) {
            return void (await t(a));
          }
          try {
            localStorage.removeItem(s.$A);
          } catch {}
          return;
        }
        let { importSPKI: p, jwtVerify: l } = await i.e(45652).then(i.bind(i, 45652));
        for (let a of e.signingKeys) {
          try {
            let e = 178 === a.publicKey.length ? "ES256" : "EdDSA",
              i = await p(a.publicKey, e),
              { payload: t } = await l(o, i);
            for (let e of ["aud", "exp", "iat", "iss", "jti", "nbf", "sub"]) delete t[e];
            r = t;
            break;
          } catch (e) {
            console.error(e);
          }
        }
        (0, s.Mj)(r) && (await t(r));
        let c = n ? `#${n}` : "";
        a.replace(`${location.pathname}${location.search}${c}`);
      }
      function d(e) {
        return e.startsWith("ey") && e.match(/\./g)?.length === 2;
      }
      var l = i(27277),
        c = i(9537);
      async function u(e, a, i) {
        let t = new URL(window.location.href),
          r = t.searchParams.get("code");
        if (!r) {
          let a = await (0, s.ql)(e);
          if (a) {
            return void (await i(a));
          }
          try {
            localStorage.removeItem(s.$A);
          } catch {}
          return;
        }
        let o = await g(e, r);
        ((0, s.Mj)(o) && (await i(o)), (t.search = ""), a.push(t.toString()));
      }
      async function g(e, a) {
        let i,
          t,
          r = l.A.get(c.o);
        if (!r) {
          return console.error("missing code verifier");
        }
        try {
          i = await m(e, a, r);
        } catch (e) {
          console.error(`unable to complete oauth exchange request: ${e}`);
          return;
        }
        try {
          let a = await fetch(e.apiUrl, { headers: { Authorization: `Bearer ${i}` } });
          t = await a.json();
        } catch (e) {
          console.error(`unable to complete oauth api request: ${e}`);
          return;
        }
        return t;
      }
      async function m(e, a, i) {
        let t = new URL(e.tokenUrl);
        (t.searchParams.append("grant_type", "authorization_code"),
          t.searchParams.append("client_id", e.clientId),
          t.searchParams.append("redirect_uri", window.location.origin),
          t.searchParams.append("code", a),
          t.searchParams.append("code_verifier", i));
        let r = await fetch(t, { method: "POST" }),
          { access_token: o } = await r.json();
        if ("string" != typeof o) {
          throw Error("unable to parse access_token from oauth exchange response");
        }
        return o;
      }
      async function h(e, a) {
        let i,
          t = await (0, s.ql)(e);
        if (t) {
          return void (await a(t));
        }
        try {
          localStorage.removeItem(s.$A);
        } catch {}
        try {
          let a = await fetch(e.apiUrl, { credentials: "include" });
          if (!a.ok) {
            return;
          }
          i = await a.json();
        } catch {
          return;
        }
        (0, s.Mj)(i) && (await a(i));
      }
      function f(e) {
        let a = (0, t.useRouter)(),
          [i, d] = (0, r.useState)(),
          [l, c] = (0, r.useState)(!0),
          [g, m] = (0, r.useState)(!0);
        return (
          (0, r.useEffect)(() => {
            let i = async (e) => {
                d(e);
                let a = { retrievedAt: Date.now(), data: e };
                await (0, n.gQ)(s.$A, a);
              },
              t = async () => {
                try {
                  c(!0);
                  let e = await fetch(`${o.c.BASE_PATH}/_mintlify/api/user`),
                    a = await e.json();
                  null != a.user && (await i(a.user));
                } catch {
                } finally {
                  c(!1);
                }
              };
            (o.c.AUTH_ENABLED || "cli" === o.c.ENV || "development" === o.c.ENV ? t() : c(!1),
              (async () => {
                m(!0);
                try {
                  switch (e?.type) {
                    case "shared-session":
                      return await h(e, i);
                    case "jwt":
                      return await p(e, a, i);
                    case "oauth":
                      return await u(e, a, i);
                    case void 0:
                      try {
                        localStorage.removeItem(s.$A);
                      } catch {}
                      return;
                  }
                } finally {
                  m(!1);
                }
              })());
          }, []),
          { userInfo: i, isFetchingUserInfo: l || g }
        );
      }
    },
    90280: (e, a, i) => {
      i.d(a, {
        AX: () => u,
        Az: () => p,
        HL: () => n,
        M5: () => m,
        S5: () => g,
        W7: () => s,
        db: () => o,
        eP: () => l,
        rQ: () => c,
        yU: () => d,
        zl: () => r.SYSTEM_FONT_FALLBACK_STRING,
      });
      var t = i(91052),
        r = i(22459);
      let o = "production" === t._.NODE_ENV,
        n = "development" === t._.NODE_ENV,
        s = "test" === t._.NODE_ENV,
        p = 6e4,
        d = 864e5,
        l = 12096e5,
        c = 36e5,
        u = "/mintlify-oauth-callback",
        g = 5e4,
        m = "https://d3gk2c5xim1je2.cloudfront.net";
    },
    91052: (e, a, i) => {
      i.d(a, { f: () => u, _: () => c });
      var t = i(30996);
      let r = t.z.enum(["mint", "maple", "palm", "willow", "linden", "almond", "aspen", "sequoia"]);
      var o = i(34783),
        n = i(34639),
        s = i(40459);
      let p = t.z
          .enum(["true", "false", "1", "0"])
          .or(t.z.number())
          .optional()
          .transform((e) => null != e && !!JSON.parse(String(e))),
        d = t.z.string().optional(),
        l = t.z
          .string()
          .optional()
          .transform((e) => e ?? ""),
        c = (0, o.w)({
          shared: {
            BASE_PATH: d.transform((e) => (0, n.q)(e)),
            HOST_NAME: l,
            NODE_ENV: t.z
              .enum(["development", "production", "test"])
              .optional()
              .transform((e) => e ?? "development"),
            DEV_PROD: p,
            TRACKED_ASSET_WORKER_URL: d,
            SKILL_MD_EXCLUDE_SUBDOMAINS: l,
            THEME: r.optional(),
            STORYBOOK: p,
            CACHE_TOOLBAR: p,
            REACT_GRAB: p,
          },
          server: {
            CLOUDFRONT_IMAGE_URL: d,
            REVALIDATION_TOKEN: d,
            API_PERF_TOKEN: l,
            EXPORT_TOKEN: d,
            SHIELD_SECRET: l,
            VERCEL_DEPLOYMENT_ID: d.transform((e) => e ?? "dpl_localhost"),
            VERCEL_PROJECT_ID: d,
            VERCEL_URL: d.transform((e) => e ?? "localhost"),
            IS_MULTI_TENANT: p,
            VERCEL: p,
            TRACKED_ASSET_WORKER_SIGNING_SECRET: d,
            PROJECT_NAME: l,
            ROOT_HOST: l,
            DATADOG_API_KEY: d,
            AXIOM_DOMAIN: d,
            AXIOM_API_TOKEN: d,
            AXIOM_DATASET_NAME: d,
            OTEL_ENABLED: p,
            END_USER_AUTH_PUBLIC_KEY: d,
            ANALYTICS_AUTH_TOKEN: d,
          },
          client: {
            NEXT_PUBLIC_ENV: d.transform((e) => e ?? "local"),
            NEXT_PUBLIC_TRIEVE_API_KEY: d,
            NEXT_PUBLIC_POSTHOG_KEY: d,
            NEXT_PUBLIC_AUTH_ENABLED: d,
            NEXT_PUBLIC_CUSTOM_JS_DISABLED: d,
            NEXT_PUBLIC_ASSET_PREFIX: l,
            NEXT_PUBLIC_AI_MESSAGE_HOST: d,
            NEXT_PUBLIC_BASE_PATH: l,
            NEXT_PUBLIC_IS_LOCAL_CLIENT: l,
          },
          experimental__runtimeEnv: {
            NEXT_PUBLIC_ENV: "production",
            NEXT_PUBLIC_TRIEVE_API_KEY: "tr-T6JLeTkFXeNbNPyhijtI9XhIncydQQ3O",
            NEXT_PUBLIC_POSTHOG_KEY: "phc_eNuN6Ojnk9O7uWfC17z12AK85fNR0BY6IiGVy0Gfwzw",
            NEXT_PUBLIC_AUTH_ENABLED: s.env.NEXT_PUBLIC_AUTH_ENABLED,
            NEXT_PUBLIC_CUSTOM_JS_DISABLED: s.env.NEXT_PUBLIC_CUSTOM_JS_DISABLED,
            NEXT_PUBLIC_ASSET_PREFIX: "/mintlify-assets",
            NEXT_PUBLIC_AI_MESSAGE_HOST: "https://leaves.mintlify.com",
            NEXT_PUBLIC_BASE_PATH: s.env.NEXT_PUBLIC_BASE_PATH,
            NEXT_PUBLIC_IS_LOCAL_CLIENT: s.env.NEXT_PUBLIC_IS_LOCAL_CLIENT,
            BASE_PATH: s.env.BASE_PATH,
            HOST_NAME: s.env.HOST_NAME,
            NODE_ENV: "production",
            DEV_PROD: s.env.DEV_PROD,
            TRACKED_ASSET_WORKER_URL: s.env.TRACKED_ASSET_WORKER_URL,
            SKILL_MD_EXCLUDE_SUBDOMAINS: s.env.SKILL_MD_EXCLUDE_SUBDOMAINS,
            THEME: s.env.THEME,
            STORYBOOK: s.env.STORYBOOK,
            CACHE_TOOLBAR: s.env.CACHE_TOOLBAR,
            REACT_GRAB: s.env.REACT_GRAB,
          },
          emptyStringAsUndefined: !0,
          skipValidation: !!s.env.SKIP_ENV_VALIDATION,
        }),
        u = "0.0.2479";
    },
    98167: (e, a, i) => {
      i.d(a, { c: () => o });
      var t = i(91052),
        r = i(34639);
      let o = {
        ENV: t._.NEXT_PUBLIC_ENV,
        TRIEVE_API_KEY: t._.NEXT_PUBLIC_TRIEVE_API_KEY,
        POSTHOG_KEY: t._.NEXT_PUBLIC_POSTHOG_KEY,
        AUTH_ENABLED: t._.NEXT_PUBLIC_AUTH_ENABLED,
        CUSTOM_JS_DISABLED: t._.NEXT_PUBLIC_CUSTOM_JS_DISABLED,
        ASSET_PREFIX: t._.NEXT_PUBLIC_ASSET_PREFIX,
        AI_MESSAGE_HOST: t._.NEXT_PUBLIC_AI_MESSAGE_HOST,
        BASE_PATH: (0, r.q)(t._.NEXT_PUBLIC_BASE_PATH),
        IS_LOCAL_CLIENT: "true" === t._.NEXT_PUBLIC_IS_LOCAL_CLIENT,
      };
    },
  },
]);
