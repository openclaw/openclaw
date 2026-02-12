(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [21246],
  {
    660: (e, t, n) => {
      "use strict";
      n.d(t, { o: () => i });
      var r = n(13546);
      class i extends Error {
        constructor(e, t, n) {
          (super(), "string" == typeof t && ((n = t), (t = void 0)));
          let i = "",
            a = {},
            o = !1;
          if (
            (t &&
              (a =
                ("line" in t && "column" in t) || ("start" in t && "end" in t)
                  ? { place: t }
                  : "type" in t
                    ? { ancestors: [t], place: t.position }
                    : { ...t }),
            "string" == typeof e
              ? (i = e)
              : !a.cause && e && ((o = !0), (i = e.message), (a.cause = e)),
            !a.ruleId && !a.source && "string" == typeof n)
          ) {
            let e = n.indexOf(":");
            -1 === e ? (a.ruleId = n) : ((a.source = n.slice(0, e)), (a.ruleId = n.slice(e + 1)));
          }
          if (!a.place && a.ancestors && a.ancestors) {
            let e = a.ancestors[a.ancestors.length - 1];
            e && (a.place = e.position);
          }
          let l = a.place && "start" in a.place ? a.place.start : a.place;
          ((this.ancestors = a.ancestors || void 0),
            (this.cause = a.cause || void 0),
            (this.column = l ? l.column : void 0),
            (this.fatal = void 0),
            this.file,
            (this.message = i),
            (this.line = l ? l.line : void 0),
            (this.name = (0, r.L)(a.place) || "1:1"),
            (this.place = a.place || void 0),
            (this.reason = this.message),
            (this.ruleId = a.ruleId || void 0),
            (this.source = a.source || void 0),
            (this.stack = o && a.cause && "string" == typeof a.cause.stack ? a.cause.stack : ""),
            this.actual,
            this.expected,
            this.note,
            this.url);
        }
      }
      ((i.prototype.file = ""),
        (i.prototype.name = ""),
        (i.prototype.reason = ""),
        (i.prototype.message = ""),
        (i.prototype.stack = ""),
        (i.prototype.column = void 0),
        (i.prototype.line = void 0),
        (i.prototype.ancestors = void 0),
        (i.prototype.cause = void 0),
        (i.prototype.fatal = void 0),
        (i.prototype.place = void 0),
        (i.prototype.ruleId = void 0),
        (i.prototype.source = void 0));
    },
    4110: (e, t, n) => {
      "use strict";
      n.d(t, { s: () => i });
      let r = document.createElement("i");
      function i(e) {
        let t = "&" + e + ";";
        r.innerHTML = t;
        let n = r.textContent;
        return (59 !== n.charCodeAt(n.length - 1) || "semi" === e) && n !== t && n;
      }
    },
    4501: (e, t, n) => {
      "use strict";
      function r(e, t, n) {
        return ">" + (n ? "" : " ") + e;
      }
      n.d(t, { p: () => b });
      var i = n(45984);
      function a(e, t, n, r) {
        let a = -1;
        for (; ++a < n.unsafe.length; ) {
          if ("\n" === n.unsafe[a].character && (0, i.q)(n.stack, n.unsafe[a]))
            return /[ \t]/.test(r.before) ? "" : " ";
        }
        return "\\\n";
      }
      var o = n(46991),
        l = n(17743);
      function s(e, t, n) {
        return (n ? "" : "    ") + e;
      }
      function c(e) {
        let t = e.options.quote || '"';
        if ('"' !== t && "'" !== t) {
          throw Error(
            "Cannot serialize title with `" + t + "` for `options.quote`, expected `\"`, or `'`",
          );
        }
        return t;
      }
      function u(e, t, n, r) {
        let i = (function (e) {
            let t = e.options.emphasis || "*";
            if ("*" !== t && "_" !== t) {
              throw Error(
                "Cannot serialize emphasis with `" +
                  t +
                  "` for `options.emphasis`, expected `*`, or `_`",
              );
            }
            return t;
          })(n),
          a = n.enter("emphasis"),
          o = n.createTracker(r),
          l = o.move(i);
        return (
          (l += o.move(n.containerPhrasing(e, { before: l, after: i, ...o.current() }))),
          (l += o.move(i)),
          a(),
          l
        );
      }
      u.peek = function (e, t, n) {
        return n.options.emphasis || "*";
      };
      var d = n(87274);
      function p(e) {
        return e.value || "";
      }
      function h(e, t, n, r) {
        let i = c(n),
          a = '"' === i ? "Quote" : "Apostrophe",
          o = n.enter("image"),
          l = n.enter("label"),
          s = n.createTracker(r),
          u = s.move("![");
        return (
          (u += s.move(n.safe(e.alt, { before: u, after: "]", ...s.current() }))),
          (u += s.move("](")),
          l(),
          (!e.url && e.title) || /[\0- \u007F]/.test(e.url)
            ? ((l = n.enter("destinationLiteral")),
              (u += s.move("<")),
              (u += s.move(n.safe(e.url, { before: u, after: ">", ...s.current() }))),
              (u += s.move(">")))
            : ((l = n.enter("destinationRaw")),
              (u += s.move(
                n.safe(e.url, { before: u, after: e.title ? " " : ")", ...s.current() }),
              ))),
          l(),
          e.title &&
            ((l = n.enter(`title${a}`)),
            (u += s.move(" " + i)),
            (u += s.move(n.safe(e.title, { before: u, after: i, ...s.current() }))),
            (u += s.move(i)),
            l()),
          (u += s.move(")")),
          o(),
          u
        );
      }
      function f(e, t, n, r) {
        let i = e.referenceType,
          a = n.enter("imageReference"),
          o = n.enter("label"),
          l = n.createTracker(r),
          s = l.move("!["),
          c = n.safe(e.alt, { before: s, after: "]", ...l.current() });
        ((s += l.move(c + "][")), o());
        let u = n.stack;
        ((n.stack = []), (o = n.enter("reference")));
        let d = n.safe(n.associationId(e), { before: s, after: "]", ...l.current() });
        return (
          o(),
          (n.stack = u),
          a(),
          "full" !== i && c && c === d
            ? "shortcut" === i
              ? (s = s.slice(0, -1))
              : (s += l.move("]"))
            : (s += l.move(d + "]")),
          s
        );
      }
      function m(e, t, n) {
        let r = e.value || "",
          i = "`",
          a = -1;
        for (; RegExp("(^|[^`])" + i + "([^`]|$)").test(r); ) {
          i += "`";
        }
        for (
          /[^ \r\n]/.test(r) &&
          ((/^[ \r\n]/.test(r) && /[ \r\n]$/.test(r)) || /^`|`$/.test(r)) &&
          (r = " " + r + " ");
          ++a < n.unsafe.length;
        ) {
          let e,
            t = n.unsafe[a],
            i = n.compilePattern(t);
          if (t.atBreak) {
            for (; (e = i.exec(r)); ) {
              let t = e.index;
              (10 === r.charCodeAt(t) && 13 === r.charCodeAt(t - 1) && t--,
                (r = r.slice(0, t) + " " + r.slice(e.index + 1)));
            }
          }
        }
        return i + r + i;
      }
      ((p.peek = function () {
        return "<";
      }),
        (h.peek = function () {
          return "!";
        }),
        (f.peek = function () {
          return "!";
        }),
        (m.peek = function () {
          return "`";
        }));
      var T = n(96018);
      function g(e, t) {
        let n = (0, T.d)(e);
        return !!(
          !t.options.resourceLink &&
          e.url &&
          !e.title &&
          e.children &&
          1 === e.children.length &&
          "text" === e.children[0].type &&
          (n === e.url || "mailto:" + n === e.url) &&
          /^[a-z][a-z+.-]+:/i.test(e.url) &&
          !/[\0- <>\u007F]/.test(e.url)
        );
      }
      function A(e, t, n, r) {
        let i,
          a,
          o = c(n),
          l = '"' === o ? "Quote" : "Apostrophe",
          s = n.createTracker(r);
        if (g(e, n)) {
          let t = n.stack;
          ((n.stack = []), (i = n.enter("autolink")));
          let r = s.move("<");
          return (
            (r += s.move(n.containerPhrasing(e, { before: r, after: ">", ...s.current() }))),
            (r += s.move(">")),
            i(),
            (n.stack = t),
            r
          );
        }
        ((i = n.enter("link")), (a = n.enter("label")));
        let u = s.move("[");
        return (
          (u += s.move(n.containerPhrasing(e, { before: u, after: "](", ...s.current() }))),
          (u += s.move("](")),
          a(),
          (!e.url && e.title) || /[\0- \u007F]/.test(e.url)
            ? ((a = n.enter("destinationLiteral")),
              (u += s.move("<")),
              (u += s.move(n.safe(e.url, { before: u, after: ">", ...s.current() }))),
              (u += s.move(">")))
            : ((a = n.enter("destinationRaw")),
              (u += s.move(
                n.safe(e.url, { before: u, after: e.title ? " " : ")", ...s.current() }),
              ))),
          a(),
          e.title &&
            ((a = n.enter(`title${l}`)),
            (u += s.move(" " + o)),
            (u += s.move(n.safe(e.title, { before: u, after: o, ...s.current() }))),
            (u += s.move(o)),
            a()),
          (u += s.move(")")),
          i(),
          u
        );
      }
      function E(e, t, n, r) {
        let i = e.referenceType,
          a = n.enter("linkReference"),
          o = n.enter("label"),
          l = n.createTracker(r),
          s = l.move("["),
          c = n.containerPhrasing(e, { before: s, after: "]", ...l.current() });
        ((s += l.move(c + "][")), o());
        let u = n.stack;
        ((n.stack = []), (o = n.enter("reference")));
        let d = n.safe(n.associationId(e), { before: s, after: "]", ...l.current() });
        return (
          o(),
          (n.stack = u),
          a(),
          "full" !== i && c && c === d
            ? "shortcut" === i
              ? (s = s.slice(0, -1))
              : (s += l.move("]"))
            : (s += l.move(d + "]")),
          s
        );
      }
      function I(e) {
        let t = e.options.bullet || "*";
        if ("*" !== t && "+" !== t && "-" !== t) {
          throw Error(
            "Cannot serialize items with `" +
              t +
              "` for `options.bullet`, expected `*`, `+`, or `-`",
          );
        }
        return t;
      }
      function _(e) {
        let t = e.options.rule || "*";
        if ("*" !== t && "-" !== t && "_" !== t) {
          throw Error(
            "Cannot serialize rules with `" + t + "` for `options.rule`, expected `*`, `-`, or `_`",
          );
        }
        return t;
      }
      ((A.peek = function (e, t, n) {
        return g(e, n) ? "<" : "[";
      }),
        (E.peek = function () {
          return "[";
        }));
      let k = (0, n(70333).C)([
        "break",
        "delete",
        "emphasis",
        "footnote",
        "footnoteReference",
        "image",
        "imageReference",
        "inlineCode",
        "link",
        "linkReference",
        "strong",
        "text",
      ]);
      function D(e, t, n, r) {
        let i = (function (e) {
            let t = e.options.strong || "*";
            if ("*" !== t && "_" !== t) {
              throw Error(
                "Cannot serialize strong with `" +
                  t +
                  "` for `options.strong`, expected `*`, or `_`",
              );
            }
            return t;
          })(n),
          a = n.enter("strong"),
          o = n.createTracker(r),
          l = o.move(i + i);
        return (
          (l += o.move(n.containerPhrasing(e, { before: l, after: i, ...o.current() }))),
          (l += o.move(i + i)),
          a(),
          l
        );
      }
      D.peek = function (e, t, n) {
        return n.options.strong || "*";
      };
      let b = {
        blockquote: function (e, t, n, i) {
          let a = n.enter("blockquote"),
            o = n.createTracker(i);
          (o.move("> "), o.shift(2));
          let l = n.indentLines(n.containerFlow(e, o.current()), r);
          return (a(), l);
        },
        break: a,
        code: function (e, t, n, r) {
          let i = (function (e) {
              let t = e.options.fence || "`";
              if ("`" !== t && "~" !== t) {
                throw Error(
                  "Cannot serialize code with `" +
                    t +
                    "` for `options.fence`, expected `` ` `` or `~`",
                );
              }
              return t;
            })(n),
            a = e.value || "",
            c = "`" === i ? "GraveAccent" : "Tilde";
          if ((0, l.m)(e, n)) {
            let e = n.enter("codeIndented"),
              t = n.indentLines(a, s);
            return (e(), t);
          }
          let u = n.createTracker(r),
            d = i.repeat(Math.max((0, o.D)(a, i) + 1, 3)),
            p = n.enter("codeFenced"),
            h = u.move(d);
          if (e.lang) {
            let t = n.enter(`codeFencedLang${c}`);
            ((h += u.move(
              n.safe(e.lang, { before: h, after: " ", encode: ["`"], ...u.current() }),
            )),
              t());
          }
          if (e.lang && e.meta) {
            let t = n.enter(`codeFencedMeta${c}`);
            ((h += u.move(" ")),
              (h += u.move(
                n.safe(e.meta, { before: h, after: "\n", encode: ["`"], ...u.current() }),
              )),
              t());
          }
          return ((h += u.move("\n")), a && (h += u.move(a + "\n")), (h += u.move(d)), p(), h);
        },
        definition: function (e, t, n, r) {
          let i = c(n),
            a = '"' === i ? "Quote" : "Apostrophe",
            o = n.enter("definition"),
            l = n.enter("label"),
            s = n.createTracker(r),
            u = s.move("[");
          return (
            (u += s.move(n.safe(n.associationId(e), { before: u, after: "]", ...s.current() }))),
            (u += s.move("]: ")),
            l(),
            !e.url || /[\0- \u007F]/.test(e.url)
              ? ((l = n.enter("destinationLiteral")),
                (u += s.move("<")),
                (u += s.move(n.safe(e.url, { before: u, after: ">", ...s.current() }))),
                (u += s.move(">")))
              : ((l = n.enter("destinationRaw")),
                (u += s.move(
                  n.safe(e.url, { before: u, after: e.title ? " " : "\n", ...s.current() }),
                ))),
            l(),
            e.title &&
              ((l = n.enter(`title${a}`)),
              (u += s.move(" " + i)),
              (u += s.move(n.safe(e.title, { before: u, after: i, ...s.current() }))),
              (u += s.move(i)),
              l()),
            o(),
            u
          );
        },
        emphasis: u,
        hardBreak: a,
        heading: function (e, t, n, r) {
          let i = Math.max(Math.min(6, e.depth || 1), 1),
            a = n.createTracker(r);
          if ((0, d.f)(e, n)) {
            let t = n.enter("headingSetext"),
              r = n.enter("phrasing"),
              o = n.containerPhrasing(e, { ...a.current(), before: "\n", after: "\n" });
            return (
              r(),
              t(),
              o +
                "\n" +
                (1 === i ? "=" : "-").repeat(
                  o.length - (Math.max(o.lastIndexOf("\r"), o.lastIndexOf("\n")) + 1),
                )
            );
          }
          let o = "#".repeat(i),
            l = n.enter("headingAtx"),
            s = n.enter("phrasing");
          a.move(o + " ");
          let c = n.containerPhrasing(e, { before: "# ", after: "\n", ...a.current() });
          return (
            /^[\t ]/.test(c) &&
              (c = "&#x" + c.charCodeAt(0).toString(16).toUpperCase() + ";" + c.slice(1)),
            (c = c ? o + " " + c : o),
            n.options.closeAtx && (c += " " + o),
            s(),
            l(),
            c
          );
        },
        html: p,
        image: h,
        imageReference: f,
        inlineCode: m,
        link: A,
        linkReference: E,
        list: function (e, t, n, r) {
          let i = n.enter("list"),
            a = n.bulletCurrent,
            o = e.ordered
              ? (function (e) {
                  let t = e.options.bulletOrdered || ".";
                  if ("." !== t && ")" !== t) {
                    throw Error(
                      "Cannot serialize items with `" +
                        t +
                        "` for `options.bulletOrdered`, expected `.` or `)`",
                    );
                  }
                  return t;
                })(n)
              : I(n),
            l = e.ordered
              ? "." === o
                ? ")"
                : "."
              : (function (e) {
                  let t = I(e),
                    n = e.options.bulletOther;
                  if (!n) {
                    return "*" === t ? "-" : "*";
                  }
                  if ("*" !== n && "+" !== n && "-" !== n) {
                    throw Error(
                      "Cannot serialize items with `" +
                        n +
                        "` for `options.bulletOther`, expected `*`, `+`, or `-`",
                    );
                  }
                  if (n === t) {
                    throw Error(
                      "Expected `bullet` (`" +
                        t +
                        "`) and `bulletOther` (`" +
                        n +
                        "`) to be different",
                    );
                  }
                  return n;
                })(n),
            s = !!t && !!n.bulletLastUsed && o === n.bulletLastUsed;
          if (!e.ordered) {
            let t = e.children ? e.children[0] : void 0;
            if (
              (("*" !== o && "-" !== o) ||
                !t ||
                (t.children && t.children[0]) ||
                "list" !== n.stack[n.stack.length - 1] ||
                "listItem" !== n.stack[n.stack.length - 2] ||
                "list" !== n.stack[n.stack.length - 3] ||
                "listItem" !== n.stack[n.stack.length - 4] ||
                0 !== n.indexStack[n.indexStack.length - 1] ||
                0 !== n.indexStack[n.indexStack.length - 2] ||
                0 !== n.indexStack[n.indexStack.length - 3] ||
                (s = !0),
              _(n) === o && t)
            ) {
              let t = -1;
              for (; ++t < e.children.length; ) {
                let n = e.children[t];
                if (
                  n &&
                  "listItem" === n.type &&
                  n.children &&
                  n.children[0] &&
                  "thematicBreak" === n.children[0].type
                ) {
                  s = !0;
                  break;
                }
              }
            }
          }
          (s && (o = l), (n.bulletCurrent = o));
          let c = n.containerFlow(e, r);
          return ((n.bulletLastUsed = o), (n.bulletCurrent = a), i(), c);
        },
        listItem: function (e, t, n, r) {
          let i = (function (e) {
              let t = e.options.listItemIndent || "one";
              if ("tab" !== t && "one" !== t && "mixed" !== t) {
                throw Error(
                  "Cannot serialize items with `" +
                    t +
                    "` for `options.listItemIndent`, expected `tab`, `one`, or `mixed`",
                );
              }
              return t;
            })(n),
            a = n.bulletCurrent || I(n);
          t &&
            "list" === t.type &&
            t.ordered &&
            (a =
              ("number" == typeof t.start && t.start > -1 ? t.start : 1) +
              (!1 === n.options.incrementListMarker ? 0 : t.children.indexOf(e)) +
              a);
          let o = a.length + 1;
          ("tab" === i || ("mixed" === i && ((t && "list" === t.type && t.spread) || e.spread))) &&
            (o = 4 * Math.ceil(o / 4));
          let l = n.createTracker(r);
          (l.move(a + " ".repeat(o - a.length)), l.shift(o));
          let s = n.enter("listItem"),
            c = n.indentLines(n.containerFlow(e, l.current()), function (e, t, n) {
              return t ? (n ? "" : " ".repeat(o)) + e : (n ? a : a + " ".repeat(o - a.length)) + e;
            });
          return (s(), c);
        },
        paragraph: function (e, t, n, r) {
          let i = n.enter("paragraph"),
            a = n.enter("phrasing"),
            o = n.containerPhrasing(e, r);
          return (a(), i(), o);
        },
        root: function (e, t, n, r) {
          return (
            e.children.some(function (e) {
              return k(e);
            })
              ? n.containerPhrasing
              : n.containerFlow
          ).call(n, e, r);
        },
        strong: D,
        text: function (e, t, n, r) {
          return n.safe(e.value, r);
        },
        thematicBreak: function (e, t, n) {
          let r = (_(n) + (n.options.ruleSpaces ? " " : "")).repeat(
            (function (e) {
              let t = e.options.ruleRepetition || 3;
              if (t < 3) {
                throw Error(
                  "Cannot serialize rules with repetition `" +
                    t +
                    "` for `options.ruleRepetition`, expected `3` or more",
                );
              }
              return t;
            })(n),
          );
          return n.options.ruleSpaces ? r.slice(0, -1) : r;
        },
      };
    },
    7199: (e, t, n) => {
      var r = n(36786),
        i = n(47275),
        a = n(16382),
        o = n(48545),
        l = 1 / 0,
        s = r ? r.prototype : void 0,
        c = s ? s.toString : void 0;
      e.exports = function e(t) {
        if ("string" == typeof t) {
          return t;
        }
        if (a(t)) {
          return i(t, e) + "";
        }
        if (o(t)) {
          return c ? c.call(t) : "";
        }
        var n = t + "";
        return "0" == n && 1 / t == -l ? "-0" : n;
      };
    },
    10937: (e, t, n) => {
      "use strict";
      n.d(t, { D: () => I });
      var r = n(74799),
        i = n(45579),
        a = n(83398),
        o = n(85397),
        l = n(47069),
        s = n(31109),
        c = n(68541);
      let u = new Set(["button", "menu", "reset", "submit"]),
        d = {}.hasOwnProperty;
      function p(e, t, n) {
        let r =
          n &&
          (function (e) {
            let t = {},
              n = -1;
            for (; ++n < e.length; ) {
              t[e[n].toLowerCase()] = e[n];
            }
            return t;
          })(n);
        return function (n, i, ...s) {
          let p,
            f = -1;
          if (null == n) {
            ((p = { type: "root", children: [] }), s.unshift(i));
          } else {
            var m, T;
            if (
              (((p = (0, o.P)(n, t)).tagName = p.tagName.toLowerCase()),
              r && d.call(r, p.tagName) && (p.tagName = r[p.tagName]),
              (m = i),
              (T = p.tagName),
              !(null == m || "object" != typeof m || Array.isArray(m)) &&
                ("input" === T ||
                  !m.type ||
                  "string" != typeof m.type ||
                  (!("children" in m && Array.isArray(m.children)) &&
                    ("button" === T ? u.has(m.type.toLowerCase()) : !("value" in m)))))
            ) {
              let t;
              for (t in i) {
                d.call(i, t) &&
                  (function (e, t, n, r) {
                    let i,
                      o = (0, l.I)(e, n),
                      s = -1;
                    if (null != r) {
                      if ("number" == typeof r) {
                        if (Number.isNaN(r)) return;
                        i = r;
                      } else
                        i =
                          "boolean" == typeof r
                            ? r
                            : "string" == typeof r
                              ? o.spaceSeparated
                                ? (0, c.q)(r)
                                : o.commaSeparated
                                  ? (0, a.q)(r)
                                  : o.commaOrSpaceSeparated
                                    ? (0, c.q)((0, a.q)(r).join(" "))
                                    : h(o, o.property, r)
                              : Array.isArray(r)
                                ? r.concat()
                                : "style" === o.property
                                  ? (function (e) {
                                      let t,
                                        n = [];
                                      for (t in e) d.call(e, t) && n.push([t, e[t]].join(": "));
                                      return n.join("; ");
                                    })(r)
                                  : String(r);
                      if (Array.isArray(i)) {
                        let e = [];
                        for (; ++s < i.length; ) {
                          let t = h(o, o.property, i[s]);
                          e[s] = t;
                        }
                        i = e;
                      }
                      if ("className" === o.property && Array.isArray(t.className)) {
                        let e = i;
                        i = t.className.concat(e);
                      }
                      t[o.property] = i;
                    }
                  })(e, p.properties, t, i[t]);
              }
            } else {
              s.unshift(i);
            }
          }
          for (; ++f < s.length; ) {
            !(function e(t, n) {
              let r = -1;
              if (null == n);
              else if ("string" == typeof n || "number" == typeof n)
                t.push({ type: "text", value: String(n) });
              else if (Array.isArray(n)) for (; ++r < n.length; ) e(t, n[r]);
              else if ("object" == typeof n && "type" in n)
                "root" === n.type ? e(t, n.children) : t.push(n);
              else throw Error("Expected node, nodes, or string, got `" + n + "`");
            })(p.children, s[f]);
          }
          return (
            "element" === p.type &&
              "template" === p.tagName &&
              ((p.content = { type: "root", children: p.children }), (p.children = [])),
            p
          );
        };
      }
      function h(e, t, n) {
        if ("string" == typeof n) {
          if (e.number && n && !Number.isNaN(Number(n))) {
            return Number(n);
          }
          if ((e.boolean || e.overloadedBoolean) && ("" === n || (0, s.S)(n) === (0, s.S)(t))) {
            return !0;
          }
        }
        return n;
      }
      let f = p(i.qy, "div"),
        m = p(i.JW, "g", [
          "altGlyph",
          "altGlyphDef",
          "altGlyphItem",
          "animateColor",
          "animateMotion",
          "animateTransform",
          "clipPath",
          "feBlend",
          "feColorMatrix",
          "feComponentTransfer",
          "feComposite",
          "feConvolveMatrix",
          "feDiffuseLighting",
          "feDisplacementMap",
          "feDistantLight",
          "feDropShadow",
          "feFlood",
          "feFuncA",
          "feFuncB",
          "feFuncG",
          "feFuncR",
          "feGaussianBlur",
          "feImage",
          "feMerge",
          "feMergeNode",
          "feMorphology",
          "feOffset",
          "fePointLight",
          "feSpecularLighting",
          "feSpotLight",
          "feTile",
          "feTurbulence",
          "foreignObject",
          "glyphRef",
          "linearGradient",
          "radialGradient",
          "solidColor",
          "textArea",
          "textPath",
        ]),
        T = /\r?\n|\r/g;
      var g = n(82873);
      let A = {}.hasOwnProperty,
        E = Object.prototype;
      function I(e, t) {
        let n = t || {};
        return _(
          {
            file: n.file || void 0,
            location: !1,
            schema: "svg" === n.space ? i.JW : i.qy,
            verbose: n.verbose || !1,
          },
          e,
        );
      }
      function _(e, t) {
        let n;
        switch (t.nodeName) {
          case "#comment":
            return ((n = { type: "comment", value: t.data }), D(e, t, n), n);
          case "#document":
          case "#document-fragment": {
            let i = "mode" in t && ("quirks" === t.mode || "limited-quirks" === t.mode);
            if (
              ((n = { type: "root", children: k(e, t.childNodes), data: { quirksMode: i } }),
              e.file && e.location)
            ) {
              let t = String(e.file),
                i = (function (e) {
                  let t = String(e),
                    n = [];
                  for (T.lastIndex = 0; T.test(t); ) {
                    n.push(T.lastIndex);
                  }
                  return (
                    n.push(t.length + 1),
                    {
                      toPoint: function (e) {
                        let t = -1;
                        if ("number" == typeof e && e > -1 && e < n[n.length - 1]) {
                          for (; ++t < n.length; ) {
                            if (n[t] > e)
                              return {
                                line: t + 1,
                                column: e - (t > 0 ? n[t - 1] : 0) + 1,
                                offset: e,
                              };
                          }
                        }
                      },
                      toOffset: function (e) {
                        let t = e && e.line,
                          r = e && e.column;
                        if (
                          "number" == typeof t &&
                          "number" == typeof r &&
                          !Number.isNaN(t) &&
                          !Number.isNaN(r) &&
                          t - 1 in n
                        ) {
                          let e = (n[t - 2] || 0) + r - 1 || 0;
                          if (e > -1 && e < n[n.length - 1]) {
                            return e;
                          }
                        }
                      },
                    }
                  );
                })(t),
                a = i.toPoint(0),
                o = i.toPoint(t.length);
              ((0, r.ok)(a, "expected `start`"),
                (0, r.ok)(o, "expected `end`"),
                (n.position = { start: a, end: o }));
            }
            return n;
          }
          case "#documentType":
            return (D(e, t, (n = { type: "doctype" })), n);
          case "#text":
            return ((n = { type: "text", value: t.value }), D(e, t, n), n);
          default:
            return (function (e, t) {
              let n = e.schema;
              e.schema = t.namespaceURI === g.t.svg ? i.JW : i.qy;
              let r = -1,
                a = {};
              for (; ++r < t.attrs.length; ) {
                let e = t.attrs[r],
                  n = (e.prefix ? e.prefix + ":" : "") + e.name;
                A.call(E, n) || (a[n] = e.value);
              }
              let o = ("svg" === e.schema.space ? m : f)(t.tagName, a, k(e, t.childNodes));
              if ((D(e, t, o), "template" === o.tagName)) {
                let n = t.sourceCodeLocation,
                  r = n && n.startTag && b(n.startTag),
                  i = n && n.endTag && b(n.endTag),
                  a = _(e, t.content);
                (r && i && e.file && (a.position = { start: r.end, end: i.start }),
                  (o.content = a));
              }
              return ((e.schema = n), o);
            })(e, t);
        }
      }
      function k(e, t) {
        let n = -1,
          r = [];
        for (; ++n < t.length; ) {
          let i = _(e, t[n]);
          r.push(i);
        }
        return r;
      }
      function D(e, t, n) {
        if ("sourceCodeLocation" in t && t.sourceCodeLocation && e.file) {
          let i = (function (e, t, n) {
            let i = b(n);
            if ("element" === t.type) {
              let a = t.children[t.children.length - 1];
              if (
                (i &&
                  !n.endTag &&
                  a &&
                  a.position &&
                  a.position.end &&
                  (i.end = Object.assign({}, a.position.end)),
                e.verbose)
              ) {
                let i,
                  a = {};
                if (n.attrs) {
                  for (i in n.attrs)
                    A.call(n.attrs, i) && (a[(0, l.I)(e.schema, i).property] = b(n.attrs[i]));
                }
                (0, r.ok)(n.startTag, "a start tag should exist");
                let o = b(n.startTag),
                  s = n.endTag ? b(n.endTag) : void 0,
                  c = { opening: o };
                (s && (c.closing = s), (c.properties = a), (t.data = { position: c }));
              }
            }
            return i;
          })(e, n, t.sourceCodeLocation);
          i && ((e.location = !0), (n.position = i));
        }
      }
      function b(e) {
        let t = y({ line: e.startLine, column: e.startCol, offset: e.startOffset }),
          n = y({ line: e.endLine, column: e.endCol, offset: e.endOffset });
        return t || n ? { start: t, end: n } : void 0;
      }
      function y(e) {
        return e.line && e.column ? e : void 0;
      }
    },
    11855: (e, t, n) => {
      "use strict";
      var r = n(16958);
      let i = new Map([
        [34, "&quot;"],
        [38, "&amp;"],
        [39, "&apos;"],
        [60, "&lt;"],
        [62, "&gt;"],
      ]);
      function a(e, t) {
        return function (n) {
          let r,
            i = 0,
            a = "";
          for (; (r = e.exec(n)); ) {
            (i !== r.index && (a += n.substring(i, r.index)),
              (a += t.get(r[0].charCodeAt(0))),
              (i = r.index + 1));
          }
          return a + n.substring(i);
        };
      }
      (null != String.prototype.codePointAt ||
        ((e, t) =>
          (64512 & e.charCodeAt(t)) == 55296
            ? (e.charCodeAt(t) - 55296) * 1024 + e.charCodeAt(t + 1) - 56320 + 65536
            : e.charCodeAt(t)),
        a(/[&<>'"]/g, i),
        a(
          /["&\u00A0]/g,
          new Map([
            [34, "&quot;"],
            [38, "&amp;"],
            [160, "&nbsp;"],
          ]),
        ),
        a(
          /[&<>\u00A0]/g,
          new Map([
            [38, "&amp;"],
            [60, "&lt;"],
            [62, "&gt;"],
            [160, "&nbsp;"],
          ]),
        ));
      var o = n(57920);
      (r.TAG_NAMES.AREA,
        r.TAG_NAMES.BASE,
        r.TAG_NAMES.BASEFONT,
        r.TAG_NAMES.BGSOUND,
        r.TAG_NAMES.BR,
        r.TAG_NAMES.COL,
        r.TAG_NAMES.EMBED,
        r.TAG_NAMES.FRAME,
        r.TAG_NAMES.HR,
        r.TAG_NAMES.IMG,
        r.TAG_NAMES.INPUT,
        r.TAG_NAMES.KEYGEN,
        r.TAG_NAMES.LINK,
        r.TAG_NAMES.META,
        r.TAG_NAMES.PARAM,
        r.TAG_NAMES.SOURCE,
        r.TAG_NAMES.TRACK,
        r.TAG_NAMES.WBR,
        o.j);
    },
    13546: (e, t, n) => {
      "use strict";
      function r(e) {
        return e && "object" == typeof e
          ? "position" in e || "type" in e
            ? a(e.position)
            : "start" in e || "end" in e
              ? a(e)
              : "line" in e || "column" in e
                ? i(e)
                : ""
          : "";
      }
      function i(e) {
        return o(e && e.line) + ":" + o(e && e.column);
      }
      function a(e) {
        return i(e && e.start) + "-" + i(e && e.end);
      }
      function o(e) {
        return e && "number" == typeof e ? e : 1;
      }
      n.d(t, { L: () => r });
    },
    15159: (e, t, n) => {
      "use strict";
      n.d(t, { E: () => o });
      var r = n(44735),
        i = n(49828);
      let a = Object.keys(i);
      class o extends r.R {
        constructor(e, t, n, r) {
          let o = -1;
          if (
            (super(e, t),
            (function (e, t, n) {
              n && (e[t] = n);
            })(this, "space", r),
            "number" == typeof n)
          ) {
            for (; ++o < a.length; ) {
              let e = a[o];
              !(function (e, t, n) {
                n && (e[t] = n);
              })(this, a[o], (n & i[e]) === i[e]);
            }
          }
        }
      }
      o.prototype.defined = !0;
    },
    17649: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => p });
      var r = n(74799),
        i = n(46991),
        a = n(32335),
        o = n(97058);
      let l = {
          tokenize: function (e, t, n) {
            let r = this,
              i = r.events[r.events.length - 1],
              l = i && "linePrefix" === i[1].type ? i[2].sliceSerialize(i[1], !0).length : 0,
              c = 0;
            return function (t) {
              return (
                e.enter("mathFlow"),
                e.enter("mathFlowFence"),
                e.enter("mathFlowFenceSequence"),
                (function t(r) {
                  return 36 === r
                    ? (e.consume(r), c++, t)
                    : c < 2
                      ? n(r)
                      : (e.exit("mathFlowFenceSequence"), (0, a.N)(e, u, "whitespace")(r));
                })(t)
              );
            };
            function u(t) {
              return null === t || (0, o.HP)(t)
                ? d(t)
                : (e.enter("mathFlowFenceMeta"),
                  e.enter("chunkString", { contentType: "string" }),
                  (function t(r) {
                    return null === r || (0, o.HP)(r)
                      ? (e.exit("chunkString"), e.exit("mathFlowFenceMeta"), d(r))
                      : 36 === r
                        ? n(r)
                        : (e.consume(r), t);
                  })(t));
            }
            function d(n) {
              return (e.exit("mathFlowFence"), r.interrupt) ? t(n) : e.attempt(s, p, m)(n);
            }
            function p(t) {
              return e.attempt({ tokenize: T, partial: !0 }, m, h)(t);
            }
            function h(t) {
              return (l ? (0, a.N)(e, f, "linePrefix", l + 1) : f)(t);
            }
            function f(t) {
              return null === t
                ? m(t)
                : (0, o.HP)(t)
                  ? e.attempt(s, p, m)(t)
                  : (e.enter("mathFlowValue"),
                    (function t(n) {
                      return null === n || (0, o.HP)(n)
                        ? (e.exit("mathFlowValue"), f(n))
                        : (e.consume(n), t);
                    })(t));
            }
            function m(n) {
              return (e.exit("mathFlow"), t(n));
            }
            function T(e, t, n) {
              let i = 0;
              return (0, a.N)(
                e,
                function (t) {
                  return (
                    e.enter("mathFlowFence"),
                    e.enter("mathFlowFenceSequence"),
                    (function t(r) {
                      return 36 === r
                        ? (i++, e.consume(r), t)
                        : i < c
                          ? n(r)
                          : (e.exit("mathFlowFenceSequence"), (0, a.N)(e, l, "whitespace")(r));
                    })(t)
                  );
                },
                "linePrefix",
                r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
              );
              function l(r) {
                return null === r || (0, o.HP)(r) ? (e.exit("mathFlowFence"), t(r)) : n(r);
              }
            }
          },
          concrete: !0,
          name: "mathFlow",
        },
        s = {
          tokenize: function (e, t, n) {
            let r = this;
            return function (n) {
              return null === n
                ? t(n)
                : (e.enter("lineEnding"), e.consume(n), e.exit("lineEnding"), i);
            };
            function i(e) {
              return r.parser.lazy[r.now().line] ? n(e) : t(e);
            }
          },
          partial: !0,
        };
      function c(e) {
        let t,
          n,
          r = e.length - 4,
          i = 3;
        if (
          ("lineEnding" === e[3][1].type || "space" === e[i][1].type) &&
          ("lineEnding" === e[r][1].type || "space" === e[r][1].type)
        ) {
          for (t = i; ++t < r; ) {
            if ("mathTextData" === e[t][1].type) {
              ((e[r][1].type = "mathTextPadding"),
                (e[i][1].type = "mathTextPadding"),
                (i += 2),
                (r -= 2));
              break;
            }
          }
        }
        for (t = i - 1, r++; ++t <= r; ) {
          void 0 === n
            ? t !== r && "lineEnding" !== e[t][1].type && (n = t)
            : (t === r || "lineEnding" === e[t][1].type) &&
              ((e[n][1].type = "mathTextData"),
              t !== n + 2 &&
                ((e[n][1].end = e[t - 1][1].end),
                e.splice(n + 2, t - n - 2),
                (r -= t - n - 2),
                (t = n + 2)),
              (n = void 0));
        }
        return e;
      }
      function u(e) {
        return 36 !== e || "characterEscape" === this.events[this.events.length - 1][1].type;
      }
      let d = {};
      function p(e) {
        let t,
          n = e || d,
          a = this.data(),
          s = a.micromarkExtensions || (a.micromarkExtensions = []),
          p = a.fromMarkdownExtensions || (a.fromMarkdownExtensions = []),
          h = a.toMarkdownExtensions || (a.toMarkdownExtensions = []);
        (s.push({
          flow: { 36: l },
          text: {
            36:
              (null == (t = (n || {}).singleDollarTextMath) && (t = !0),
              {
                tokenize: function (e, n, r) {
                  let i,
                    a,
                    l = 0;
                  return function (n) {
                    return (
                      e.enter("mathText"),
                      e.enter("mathTextSequence"),
                      (function n(i) {
                        return 36 === i
                          ? (e.consume(i), l++, n)
                          : l < 2 && !t
                            ? r(i)
                            : (e.exit("mathTextSequence"), s(i));
                      })(n)
                    );
                  };
                  function s(t) {
                    return null === t
                      ? r(t)
                      : 36 === t
                        ? ((a = e.enter("mathTextSequence")),
                          (i = 0),
                          (function t(r) {
                            return 36 === r
                              ? (e.consume(r), i++, t)
                              : i === l
                                ? (e.exit("mathTextSequence"), e.exit("mathText"), n(r))
                                : ((a.type = "mathTextData"), c(r));
                          })(t))
                        : 32 === t
                          ? (e.enter("space"), e.consume(t), e.exit("space"), s)
                          : (0, o.HP)(t)
                            ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), s)
                            : (e.enter("mathTextData"), c(t));
                  }
                  function c(t) {
                    return null === t || 32 === t || 36 === t || (0, o.HP)(t)
                      ? (e.exit("mathTextData"), s(t))
                      : (e.consume(t), c);
                  }
                },
                resolve: c,
                previous: u,
                name: "mathText",
              }),
          },
        }),
          p.push(
            (function () {
              return {
                enter: {
                  mathFlow: function (e) {
                    this.enter(
                      {
                        type: "math",
                        meta: null,
                        value: "",
                        data: {
                          hName: "pre",
                          hChildren: [
                            {
                              type: "element",
                              tagName: "code",
                              properties: { className: ["language-math", "math-display"] },
                              children: [],
                            },
                          ],
                        },
                      },
                      e,
                    );
                  },
                  mathFlowFenceMeta: function () {
                    this.buffer();
                  },
                  mathText: function (e) {
                    (this.enter(
                      {
                        type: "inlineMath",
                        value: "",
                        data: {
                          hName: "code",
                          hProperties: { className: ["language-math", "math-inline"] },
                          hChildren: [],
                        },
                      },
                      e,
                    ),
                      this.buffer());
                  },
                },
                exit: {
                  mathFlow: function (e) {
                    let t = this.resume().replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, ""),
                      n = this.stack[this.stack.length - 1];
                    ((0, r.ok)("math" === n.type), this.exit(e), (n.value = t));
                    let i = n.data.hChildren[0];
                    ((0, r.ok)("element" === i.type),
                      (0, r.ok)("code" === i.tagName),
                      i.children.push({ type: "text", value: t }),
                      (this.data.mathFlowInside = void 0));
                  },
                  mathFlowFence: function () {
                    this.data.mathFlowInside || (this.buffer(), (this.data.mathFlowInside = !0));
                  },
                  mathFlowFenceMeta: function () {
                    let e = this.resume(),
                      t = this.stack[this.stack.length - 1];
                    ((0, r.ok)("math" === t.type), (t.meta = e));
                  },
                  mathFlowValue: e,
                  mathText: function (e) {
                    let t = this.resume(),
                      n = this.stack[this.stack.length - 1];
                    ((0, r.ok)("inlineMath" === n.type),
                      this.exit(e),
                      (n.value = t),
                      n.data.hChildren.push({ type: "text", value: t }));
                  },
                  mathTextData: e,
                },
              };
              function e(e) {
                (this.config.enter.data.call(this, e), this.config.exit.data.call(this, e));
              }
            })(),
          ),
          h.push(
            (function (e) {
              let t = (e || {}).singleDollarTextMath;
              return (
                null == t && (t = !0),
                (n.peek = function () {
                  return "$";
                }),
                {
                  unsafe: [
                    { character: "\r", inConstruct: "mathFlowMeta" },
                    { character: "\n", inConstruct: "mathFlowMeta" },
                    { character: "$", after: t ? void 0 : "\\$", inConstruct: "phrasing" },
                    { character: "$", inConstruct: "mathFlowMeta" },
                    { atBreak: !0, character: "$", after: "\\$" },
                  ],
                  handlers: {
                    math: function (e, t, n, r) {
                      let a = e.value || "",
                        o = n.createTracker(r),
                        l = "$".repeat(Math.max((0, i.D)(a, "$") + 1, 2)),
                        s = n.enter("mathFlow"),
                        c = o.move(l);
                      if (e.meta) {
                        let t = n.enter("mathFlowMeta");
                        ((c += o.move(
                          n.safe(e.meta, { after: "\n", before: c, encode: ["$"], ...o.current() }),
                        )),
                          t());
                      }
                      return (
                        (c += o.move("\n")), a && (c += o.move(a + "\n")), (c += o.move(l)), s(), c
                      );
                    },
                    inlineMath: n,
                  },
                }
              );
              function n(e, n, r) {
                let i = e.value || "",
                  a = 1;
                for (!t && a++; RegExp("(^|[^$])" + "\\$".repeat(a) + "([^$]|$)").test(i); ) {
                  a++;
                }
                let o = "$".repeat(a);
                /[^ \r\n]/.test(i) &&
                  ((/^[ \r\n]/.test(i) && /[ \r\n]$/.test(i)) || /^\$|\$$/.test(i)) &&
                  (i = " " + i + " ");
                let l = -1;
                for (; ++l < r.unsafe.length; ) {
                  let e,
                    t = r.unsafe[l];
                  if (!t.atBreak) {
                    continue;
                  }
                  let n = r.compilePattern(t);
                  for (; (e = n.exec(i)); ) {
                    let t = e.index;
                    (10 === i.codePointAt(t) && 13 === i.codePointAt(t - 1) && t--,
                      (i = i.slice(0, t) + " " + i.slice(e.index + 1)));
                  }
                }
                return o + i + o;
              }
            })(n),
          ));
      }
    },
    17743: (e, t, n) => {
      "use strict";
      function r(e, t) {
        return !!(
          !1 === t.options.fences &&
          e.value &&
          !e.lang &&
          /[^ \r\n]/.test(e.value) &&
          !/^[\t ]*(?:[\r\n]|$)|(?:^|[\r\n])[\t ]*$/.test(e.value)
        );
      }
      n.d(t, { m: () => r });
    },
    18857: (e, t, n) => {
      "use strict";
      n.d(t, { _j: () => h, aq: () => p, ly: () => c, nv: () => f, pc: () => d, yY: () => u });
      var r = n(16958);
      let i = { TEXT_HTML: "text/html", APPLICATION_XML: "application/xhtml+xml" },
        a = new Map(
          [
            "attributeName",
            "attributeType",
            "baseFrequency",
            "baseProfile",
            "calcMode",
            "clipPathUnits",
            "diffuseConstant",
            "edgeMode",
            "filterUnits",
            "glyphRef",
            "gradientTransform",
            "gradientUnits",
            "kernelMatrix",
            "kernelUnitLength",
            "keyPoints",
            "keySplines",
            "keyTimes",
            "lengthAdjust",
            "limitingConeAngle",
            "markerHeight",
            "markerUnits",
            "markerWidth",
            "maskContentUnits",
            "maskUnits",
            "numOctaves",
            "pathLength",
            "patternContentUnits",
            "patternTransform",
            "patternUnits",
            "pointsAtX",
            "pointsAtY",
            "pointsAtZ",
            "preserveAlpha",
            "preserveAspectRatio",
            "primitiveUnits",
            "refX",
            "refY",
            "repeatCount",
            "repeatDur",
            "requiredExtensions",
            "requiredFeatures",
            "specularConstant",
            "specularExponent",
            "spreadMethod",
            "startOffset",
            "stdDeviation",
            "stitchTiles",
            "surfaceScale",
            "systemLanguage",
            "tableValues",
            "targetX",
            "targetY",
            "textLength",
            "viewBox",
            "viewTarget",
            "xChannelSelector",
            "yChannelSelector",
            "zoomAndPan",
          ].map((e) => [e.toLowerCase(), e]),
        ),
        o = new Map([
          ["xlink:actuate", { prefix: "xlink", name: "actuate", namespace: r.NS.XLINK }],
          ["xlink:arcrole", { prefix: "xlink", name: "arcrole", namespace: r.NS.XLINK }],
          ["xlink:href", { prefix: "xlink", name: "href", namespace: r.NS.XLINK }],
          ["xlink:role", { prefix: "xlink", name: "role", namespace: r.NS.XLINK }],
          ["xlink:show", { prefix: "xlink", name: "show", namespace: r.NS.XLINK }],
          ["xlink:title", { prefix: "xlink", name: "title", namespace: r.NS.XLINK }],
          ["xlink:type", { prefix: "xlink", name: "type", namespace: r.NS.XLINK }],
          ["xml:base", { prefix: "xml", name: "base", namespace: r.NS.XML }],
          ["xml:lang", { prefix: "xml", name: "lang", namespace: r.NS.XML }],
          ["xml:space", { prefix: "xml", name: "space", namespace: r.NS.XML }],
          ["xmlns", { prefix: "", name: "xmlns", namespace: r.NS.XMLNS }],
          ["xmlns:xlink", { prefix: "xmlns", name: "xlink", namespace: r.NS.XMLNS }],
        ]),
        l = new Map(
          [
            "altGlyph",
            "altGlyphDef",
            "altGlyphItem",
            "animateColor",
            "animateMotion",
            "animateTransform",
            "clipPath",
            "feBlend",
            "feColorMatrix",
            "feComponentTransfer",
            "feComposite",
            "feConvolveMatrix",
            "feDiffuseLighting",
            "feDisplacementMap",
            "feDistantLight",
            "feFlood",
            "feFuncA",
            "feFuncB",
            "feFuncG",
            "feFuncR",
            "feGaussianBlur",
            "feImage",
            "feMerge",
            "feMergeNode",
            "feMorphology",
            "feOffset",
            "fePointLight",
            "feSpecularLighting",
            "feSpotLight",
            "feTile",
            "feTurbulence",
            "foreignObject",
            "glyphRef",
            "linearGradient",
            "radialGradient",
            "textPath",
          ].map((e) => [e.toLowerCase(), e]),
        ),
        s = new Set([
          r.TAG_ID.B,
          r.TAG_ID.BIG,
          r.TAG_ID.BLOCKQUOTE,
          r.TAG_ID.BODY,
          r.TAG_ID.BR,
          r.TAG_ID.CENTER,
          r.TAG_ID.CODE,
          r.TAG_ID.DD,
          r.TAG_ID.DIV,
          r.TAG_ID.DL,
          r.TAG_ID.DT,
          r.TAG_ID.EM,
          r.TAG_ID.EMBED,
          r.TAG_ID.H1,
          r.TAG_ID.H2,
          r.TAG_ID.H3,
          r.TAG_ID.H4,
          r.TAG_ID.H5,
          r.TAG_ID.H6,
          r.TAG_ID.HEAD,
          r.TAG_ID.HR,
          r.TAG_ID.I,
          r.TAG_ID.IMG,
          r.TAG_ID.LI,
          r.TAG_ID.LISTING,
          r.TAG_ID.MENU,
          r.TAG_ID.META,
          r.TAG_ID.NOBR,
          r.TAG_ID.OL,
          r.TAG_ID.P,
          r.TAG_ID.PRE,
          r.TAG_ID.RUBY,
          r.TAG_ID.S,
          r.TAG_ID.SMALL,
          r.TAG_ID.SPAN,
          r.TAG_ID.STRONG,
          r.TAG_ID.STRIKE,
          r.TAG_ID.SUB,
          r.TAG_ID.SUP,
          r.TAG_ID.TABLE,
          r.TAG_ID.TT,
          r.TAG_ID.U,
          r.TAG_ID.UL,
          r.TAG_ID.VAR,
        ]);
      function c(e) {
        let t = e.tagID;
        return (
          (t === r.TAG_ID.FONT &&
            e.attrs.some(
              ({ name: e }) => e === r.ATTRS.COLOR || e === r.ATTRS.SIZE || e === r.ATTRS.FACE,
            )) ||
          s.has(t)
        );
      }
      function u(e) {
        for (let t = 0; t < e.attrs.length; t++) {
          if ("definitionurl" === e.attrs[t].name) {
            e.attrs[t].name = "definitionURL";
            break;
          }
        }
      }
      function d(e) {
        for (let t = 0; t < e.attrs.length; t++) {
          let n = a.get(e.attrs[t].name);
          null != n && (e.attrs[t].name = n);
        }
      }
      function p(e) {
        for (let t = 0; t < e.attrs.length; t++) {
          let n = o.get(e.attrs[t].name);
          n &&
            ((e.attrs[t].prefix = n.prefix),
            (e.attrs[t].name = n.name),
            (e.attrs[t].namespace = n.namespace));
        }
      }
      function h(e) {
        let t = l.get(e.tagName);
        null != t && ((e.tagName = t), (e.tagID = (0, r.getTagID)(e.tagName)));
      }
      function f(e, t, n, a) {
        return (
          ((!a || a === r.NS.HTML) &&
            (function (e, t, n) {
              if (t === r.NS.MATHML && e === r.TAG_ID.ANNOTATION_XML) {
                for (let e = 0; e < n.length; e++) {
                  if (n[e].name === r.ATTRS.ENCODING) {
                    let t = n[e].value.toLowerCase();
                    return t === i.TEXT_HTML || t === i.APPLICATION_XML;
                  }
                }
              }
              return (
                t === r.NS.SVG &&
                (e === r.TAG_ID.FOREIGN_OBJECT || e === r.TAG_ID.DESC || e === r.TAG_ID.TITLE)
              );
            })(e, t, n)) ||
          ((!a || a === r.NS.MATHML) &&
            t === r.NS.MATHML &&
            (e === r.TAG_ID.MI ||
              e === r.TAG_ID.MO ||
              e === r.TAG_ID.MN ||
              e === r.TAG_ID.MS ||
              e === r.TAG_ID.MTEXT))
        );
      }
    },
    19024: (e, t, n) => {
      "use strict";
      n.d(t, { _: () => k });
      var r = n(74799),
        i = n(20634),
        a = n(97058);
      function o(e) {
        let t = [],
          n = -1,
          r = 0,
          i = 0;
        for (; ++n < e.length; ) {
          let o = e.charCodeAt(n),
            l = "";
          if (37 === o && (0, a.lV)(e.charCodeAt(n + 1)) && (0, a.lV)(e.charCodeAt(n + 2))) {
            i = 2;
          } else if (o < 128) {
            /[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(o)) || (l = String.fromCharCode(o));
          } else if (o > 55295 && o < 57344) {
            let t = e.charCodeAt(n + 1);
            o < 56320 && t > 56319 && t < 57344
              ? ((l = String.fromCharCode(o, t)), (i = 1))
              : (l = "�");
          } else {
            l = String.fromCharCode(o);
          }
          (l && (t.push(e.slice(r, n), encodeURIComponent(l)), (r = n + i + 1), (l = "")),
            i && ((n += i), (i = 0)));
        }
        return t.join("") + e.slice(r);
      }
      function l(e, t) {
        let n = [{ type: "text", value: "↩" }];
        return (
          t > 1 &&
            n.push({
              type: "element",
              tagName: "sup",
              properties: {},
              children: [{ type: "text", value: String(t) }],
            }),
          n
        );
      }
      function s(e, t) {
        return "Back to reference " + (e + 1) + (t > 1 ? "-" + t : "");
      }
      var c = n(25478),
        u = n(27598);
      function d(e, t) {
        let n = t.referenceType,
          r = "]";
        if (
          ("collapsed" === n
            ? (r += "[]")
            : "full" === n && (r += "[" + (t.label || t.identifier) + "]"),
          "imageReference" === t.type)
        ) {
          return [{ type: "text", value: "![" + t.alt + r }];
        }
        let i = e.all(t),
          a = i[0];
        a && "text" === a.type
          ? (a.value = "[" + a.value)
          : i.unshift({ type: "text", value: "[" });
        let o = i[i.length - 1];
        return (o && "text" === o.type ? (o.value += r) : i.push({ type: "text", value: r }), i);
      }
      function p(e) {
        let t = e.spread;
        return null == t ? e.children.length > 1 : t;
      }
      function h(e, t, n) {
        let r = 0,
          i = e.length;
        if (t) {
          let t = e.codePointAt(r);
          for (; 9 === t || 32 === t; ) {
            (r++, (t = e.codePointAt(r)));
          }
        }
        if (n) {
          let t = e.codePointAt(i - 1);
          for (; 9 === t || 32 === t; ) {
            (i--, (t = e.codePointAt(i - 1)));
          }
        }
        return i > r ? e.slice(r, i) : "";
      }
      let f = {
        blockquote: function (e, t) {
          let n = {
            type: "element",
            tagName: "blockquote",
            properties: {},
            children: e.wrap(e.all(t), !0),
          };
          return (e.patch(t, n), e.applyData(t, n));
        },
        break: function (e, t) {
          let n = { type: "element", tagName: "br", properties: {}, children: [] };
          return (e.patch(t, n), [e.applyData(t, n), { type: "text", value: "\n" }]);
        },
        code: function (e, t) {
          let n = t.value ? t.value + "\n" : "",
            r = {};
          t.lang && (r.className = ["language-" + t.lang]);
          let i = {
            type: "element",
            tagName: "code",
            properties: r,
            children: [{ type: "text", value: n }],
          };
          return (
            t.meta && (i.data = { meta: t.meta }),
            e.patch(t, i),
            (i = {
              type: "element",
              tagName: "pre",
              properties: {},
              children: [(i = e.applyData(t, i))],
            }),
            e.patch(t, i),
            i
          );
        },
        delete: function (e, t) {
          let n = { type: "element", tagName: "del", properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        emphasis: function (e, t) {
          let n = { type: "element", tagName: "em", properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        footnoteReference: function (e, t) {
          let n,
            r =
              "string" == typeof e.options.clobberPrefix
                ? e.options.clobberPrefix
                : "user-content-",
            i = String(t.identifier).toUpperCase(),
            a = o(i.toLowerCase()),
            l = e.footnoteOrder.indexOf(i),
            s = e.footnoteCounts.get(i);
          (void 0 === s
            ? ((s = 0), e.footnoteOrder.push(i), (n = e.footnoteOrder.length))
            : (n = l + 1),
            (s += 1),
            e.footnoteCounts.set(i, s));
          let c = {
            type: "element",
            tagName: "a",
            properties: {
              href: "#" + r + "fn-" + a,
              id: r + "fnref-" + a + (s > 1 ? "-" + s : ""),
              dataFootnoteRef: !0,
              ariaDescribedBy: ["footnote-label"],
            },
            children: [{ type: "text", value: String(n) }],
          };
          e.patch(t, c);
          let u = { type: "element", tagName: "sup", properties: {}, children: [c] };
          return (e.patch(t, u), e.applyData(t, u));
        },
        heading: function (e, t) {
          let n = { type: "element", tagName: "h" + t.depth, properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        html: function (e, t) {
          if (e.options.allowDangerousHtml) {
            let n = { type: "raw", value: t.value };
            return (e.patch(t, n), e.applyData(t, n));
          }
        },
        imageReference: function (e, t) {
          let n = String(t.identifier).toUpperCase(),
            r = e.definitionById.get(n);
          if (!r) {
            return d(e, t);
          }
          let i = { src: o(r.url || ""), alt: t.alt };
          null !== r.title && void 0 !== r.title && (i.title = r.title);
          let a = { type: "element", tagName: "img", properties: i, children: [] };
          return (e.patch(t, a), e.applyData(t, a));
        },
        image: function (e, t) {
          let n = { src: o(t.url) };
          (null !== t.alt && void 0 !== t.alt && (n.alt = t.alt),
            null !== t.title && void 0 !== t.title && (n.title = t.title));
          let r = { type: "element", tagName: "img", properties: n, children: [] };
          return (e.patch(t, r), e.applyData(t, r));
        },
        inlineCode: function (e, t) {
          let n = { type: "text", value: t.value.replace(/\r?\n|\r/g, " ") };
          e.patch(t, n);
          let r = { type: "element", tagName: "code", properties: {}, children: [n] };
          return (e.patch(t, r), e.applyData(t, r));
        },
        linkReference: function (e, t) {
          let n = String(t.identifier).toUpperCase(),
            r = e.definitionById.get(n);
          if (!r) {
            return d(e, t);
          }
          let i = { href: o(r.url || "") };
          null !== r.title && void 0 !== r.title && (i.title = r.title);
          let a = { type: "element", tagName: "a", properties: i, children: e.all(t) };
          return (e.patch(t, a), e.applyData(t, a));
        },
        link: function (e, t) {
          let n = { href: o(t.url) };
          null !== t.title && void 0 !== t.title && (n.title = t.title);
          let r = { type: "element", tagName: "a", properties: n, children: e.all(t) };
          return (e.patch(t, r), e.applyData(t, r));
        },
        listItem: function (e, t, n) {
          let r = e.all(t),
            i = n
              ? (function (e) {
                  let t = !1;
                  if ("list" === e.type) {
                    t = e.spread || !1;
                    let n = e.children,
                      r = -1;
                    for (; !t && ++r < n.length; ) {
                      t = p(n[r]);
                    }
                  }
                  return t;
                })(n)
              : p(t),
            a = {},
            o = [];
          if ("boolean" == typeof t.checked) {
            let e,
              n = r[0];
            (n && "element" === n.type && "p" === n.tagName
              ? (e = n)
              : ((e = { type: "element", tagName: "p", properties: {}, children: [] }),
                r.unshift(e)),
              e.children.length > 0 && e.children.unshift({ type: "text", value: " " }),
              e.children.unshift({
                type: "element",
                tagName: "input",
                properties: { type: "checkbox", checked: t.checked, disabled: !0 },
                children: [],
              }),
              (a.className = ["task-list-item"]));
          }
          let l = -1;
          for (; ++l < r.length; ) {
            let e = r[l];
            ((i || 0 !== l || "element" !== e.type || "p" !== e.tagName) &&
              o.push({ type: "text", value: "\n" }),
              "element" !== e.type || "p" !== e.tagName || i ? o.push(e) : o.push(...e.children));
          }
          let s = r[r.length - 1];
          s &&
            (i || "element" !== s.type || "p" !== s.tagName) &&
            o.push({ type: "text", value: "\n" });
          let c = { type: "element", tagName: "li", properties: a, children: o };
          return (e.patch(t, c), e.applyData(t, c));
        },
        list: function (e, t) {
          let n = {},
            r = e.all(t),
            i = -1;
          for (
            "number" == typeof t.start && 1 !== t.start && (n.start = t.start);
            ++i < r.length;
          ) {
            let e = r[i];
            if (
              "element" === e.type &&
              "li" === e.tagName &&
              e.properties &&
              Array.isArray(e.properties.className) &&
              e.properties.className.includes("task-list-item")
            ) {
              n.className = ["contains-task-list"];
              break;
            }
          }
          let a = {
            type: "element",
            tagName: t.ordered ? "ol" : "ul",
            properties: n,
            children: e.wrap(r, !0),
          };
          return (e.patch(t, a), e.applyData(t, a));
        },
        paragraph: function (e, t) {
          let n = { type: "element", tagName: "p", properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        root: function (e, t) {
          let n = { type: "root", children: e.wrap(e.all(t)) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        strong: function (e, t) {
          let n = { type: "element", tagName: "strong", properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        table: function (e, t) {
          let n = e.all(t),
            r = n.shift(),
            i = [];
          if (r) {
            let n = {
              type: "element",
              tagName: "thead",
              properties: {},
              children: e.wrap([r], !0),
            };
            (e.patch(t.children[0], n), i.push(n));
          }
          if (n.length > 0) {
            let r = { type: "element", tagName: "tbody", properties: {}, children: e.wrap(n, !0) },
              a = (0, u.PW)(t.children[1]),
              o = (0, u.Y)(t.children[t.children.length - 1]);
            (a && o && (r.position = { start: a, end: o }), i.push(r));
          }
          let a = { type: "element", tagName: "table", properties: {}, children: e.wrap(i, !0) };
          return (e.patch(t, a), e.applyData(t, a));
        },
        tableCell: function (e, t) {
          let n = { type: "element", tagName: "td", properties: {}, children: e.all(t) };
          return (e.patch(t, n), e.applyData(t, n));
        },
        tableRow: function (e, t, n) {
          let r = n ? n.children : void 0,
            i = 0 === (r ? r.indexOf(t) : 1) ? "th" : "td",
            a = n && "table" === n.type ? n.align : void 0,
            o = a ? a.length : t.children.length,
            l = -1,
            s = [];
          for (; ++l < o; ) {
            let n = t.children[l],
              r = {},
              o = a ? a[l] : void 0;
            o && (r.align = o);
            let c = { type: "element", tagName: i, properties: r, children: [] };
            (n && ((c.children = e.all(n)), e.patch(n, c), (c = e.applyData(n, c))), s.push(c));
          }
          let c = { type: "element", tagName: "tr", properties: {}, children: e.wrap(s, !0) };
          return (e.patch(t, c), e.applyData(t, c));
        },
        text: function (e, t) {
          let n = {
            type: "text",
            value: (function (e) {
              let t = String(e),
                n = /\r?\n|\r/g,
                r = n.exec(t),
                i = 0,
                a = [];
              for (; r; ) {
                (a.push(h(t.slice(i, r.index), i > 0, !0), r[0]),
                  (i = r.index + r[0].length),
                  (r = n.exec(t)));
              }
              return (a.push(h(t.slice(i), i > 0, !1)), a.join(""));
            })(String(t.value)),
          };
          return (e.patch(t, n), e.applyData(t, n));
        },
        thematicBreak: function (e, t) {
          let n = { type: "element", tagName: "hr", properties: {}, children: [] };
          return (e.patch(t, n), e.applyData(t, n));
        },
        toml: m,
        yaml: m,
        definition: m,
        footnoteDefinition: m,
      };
      function m() {}
      let T = {}.hasOwnProperty,
        g = {};
      function A(e, t) {
        e.position && (t.position = (0, u.G1)(e));
      }
      function E(e, t) {
        let n = t;
        if (e && e.data) {
          let t = e.data.hName,
            r = e.data.hChildren,
            a = e.data.hProperties;
          ("string" == typeof t &&
            ("element" === n.type
              ? (n.tagName = t)
              : (n = {
                  type: "element",
                  tagName: t,
                  properties: {},
                  children: "children" in n ? n.children : [n],
                })),
            "element" === n.type && a && Object.assign(n.properties, (0, i.Ay)(a)),
            "children" in n && n.children && null != r && (n.children = r));
        }
        return n;
      }
      function I(e, t) {
        let n = [],
          r = -1;
        for (t && n.push({ type: "text", value: "\n" }); ++r < e.length; ) {
          (r && n.push({ type: "text", value: "\n" }), n.push(e[r]));
        }
        return (t && e.length > 0 && n.push({ type: "text", value: "\n" }), n);
      }
      function _(e) {
        let t = 0,
          n = e.charCodeAt(t);
        for (; 9 === n || 32 === n; ) {
          (t++, (n = e.charCodeAt(t)));
        }
        return e.slice(t);
      }
      function k(e, t) {
        let n = (function (e, t) {
            let n = t || g,
              r = new Map(),
              a = new Map(),
              o = {
                all: function (e) {
                  let t = [];
                  if ("children" in e) {
                    let n = e.children,
                      r = -1;
                    for (; ++r < n.length; ) {
                      let i = o.one(n[r], e);
                      if (i) {
                        if (
                          r &&
                          "break" === n[r - 1].type &&
                          (Array.isArray(i) || "text" !== i.type || (i.value = _(i.value)),
                          !Array.isArray(i) && "element" === i.type)
                        ) {
                          let e = i.children[0];
                          e && "text" === e.type && (e.value = _(e.value));
                        }
                        Array.isArray(i) ? t.push(...i) : t.push(i);
                      }
                    }
                  }
                  return t;
                },
                applyData: E,
                definitionById: r,
                footnoteById: a,
                footnoteCounts: new Map(),
                footnoteOrder: [],
                handlers: { ...f, ...n.handlers },
                one: function (e, t) {
                  let n = e.type,
                    r = o.handlers[n];
                  if (T.call(o.handlers, n) && r) {
                    return r(o, e, t);
                  }
                  if (o.options.passThrough && o.options.passThrough.includes(n)) {
                    if ("children" in e) {
                      let { children: t, ...n } = e,
                        r = (0, i.Ay)(n);
                      return ((r.children = o.all(e)), r);
                    }
                    return (0, i.Ay)(e);
                  }
                  return (
                    o.options.unknownHandler ||
                    function (e, t) {
                      let n = t.data || {},
                        r =
                          "value" in t && !(T.call(n, "hProperties") || T.call(n, "hChildren"))
                            ? { type: "text", value: t.value }
                            : {
                                type: "element",
                                tagName: "div",
                                properties: {},
                                children: e.all(t),
                              };
                      return (e.patch(t, r), e.applyData(t, r));
                    }
                  )(o, e, t);
                },
                options: n,
                patch: A,
                wrap: I,
              };
            return (
              (0, c.YR)(e, function (e) {
                if ("definition" === e.type || "footnoteDefinition" === e.type) {
                  let t = "definition" === e.type ? r : a,
                    n = String(e.identifier).toUpperCase();
                  t.has(n) || t.set(n, e);
                }
              }),
              o
            );
          })(e, t),
          a = n.one(e, void 0),
          u = (function (e) {
            let t =
                "string" == typeof e.options.clobberPrefix
                  ? e.options.clobberPrefix
                  : "user-content-",
              n = e.options.footnoteBackContent || l,
              r = e.options.footnoteBackLabel || s,
              a = e.options.footnoteLabel || "Footnotes",
              c = e.options.footnoteLabelTagName || "h2",
              u = e.options.footnoteLabelProperties || { className: ["sr-only"] },
              d = [],
              p = -1;
            for (; ++p < e.footnoteOrder.length; ) {
              let i = e.footnoteById.get(e.footnoteOrder[p]);
              if (!i) {
                continue;
              }
              let a = e.all(i),
                l = String(i.identifier).toUpperCase(),
                s = o(l.toLowerCase()),
                c = 0,
                u = [],
                h = e.footnoteCounts.get(l);
              for (; void 0 !== h && ++c <= h; ) {
                u.length > 0 && u.push({ type: "text", value: " " });
                let e = "string" == typeof n ? n : n(p, c);
                ("string" == typeof e && (e = { type: "text", value: e }),
                  u.push({
                    type: "element",
                    tagName: "a",
                    properties: {
                      href: "#" + t + "fnref-" + s + (c > 1 ? "-" + c : ""),
                      dataFootnoteBackref: "",
                      ariaLabel: "string" == typeof r ? r : r(p, c),
                      className: ["data-footnote-backref"],
                    },
                    children: Array.isArray(e) ? e : [e],
                  }));
              }
              let f = a[a.length - 1];
              if (f && "element" === f.type && "p" === f.tagName) {
                let e = f.children[f.children.length - 1];
                (e && "text" === e.type
                  ? (e.value += " ")
                  : f.children.push({ type: "text", value: " " }),
                  f.children.push(...u));
              } else {
                a.push(...u);
              }
              let m = {
                type: "element",
                tagName: "li",
                properties: { id: t + "fn-" + s },
                children: e.wrap(a, !0),
              };
              (e.patch(i, m), d.push(m));
            }
            if (0 !== d.length) {
              return {
                type: "element",
                tagName: "section",
                properties: { dataFootnotes: !0, className: ["footnotes"] },
                children: [
                  {
                    type: "element",
                    tagName: c,
                    properties: { ...(0, i.Ay)(u), id: "footnote-label" },
                    children: [{ type: "text", value: a }],
                  },
                  { type: "text", value: "\n" },
                  { type: "element", tagName: "ol", properties: {}, children: e.wrap(d, !0) },
                  { type: "text", value: "\n" },
                ],
              };
            }
          })(n),
          d = Array.isArray(a)
            ? { type: "root", children: a }
            : a || { type: "root", children: [] };
        return (
          u && ((0, r.ok)("children" in d), d.children.push({ type: "text", value: "\n" }, u)), d
        );
      }
    },
    20634: (e, t, n) => {
      "use strict";
      n.d(t, { Ay: () => u });
      let r = "object" == typeof self ? self : globalThis,
        i = (e) =>
          ((e, t) => {
            let n = (t, n) => (e.set(n, t), t),
              i = (a) => {
                if (e.has(a)) {
                  return e.get(a);
                }
                let [o, l] = t[a];
                switch (o) {
                  case 0:
                  case -1:
                    return n(l, a);
                  case 1: {
                    let e = n([], a);
                    for (let t of l) {
                      e.push(i(t));
                    }
                    return e;
                  }
                  case 2: {
                    let e = n({}, a);
                    for (let [t, n] of l) {
                      e[i(t)] = i(n);
                    }
                    return e;
                  }
                  case 3:
                    return n(new Date(l), a);
                  case 4: {
                    let { source: e, flags: t } = l;
                    return n(new RegExp(e, t), a);
                  }
                  case 5: {
                    let e = n(new Map(), a);
                    for (let [t, n] of l) {
                      e.set(i(t), i(n));
                    }
                    return e;
                  }
                  case 6: {
                    let e = n(new Set(), a);
                    for (let t of l) {
                      e.add(i(t));
                    }
                    return e;
                  }
                  case 7: {
                    let { name: e, message: t } = l;
                    return n(new r[e](t), a);
                  }
                  case 8:
                    return n(BigInt(l), a);
                  case "BigInt":
                    return n(Object(BigInt(l)), a);
                }
                return n(new r[o](l), a);
              };
            return i;
          })(
            new Map(),
            e,
          )(0),
        { toString: a } = {},
        { keys: o } = Object,
        l = (e) => {
          let t = typeof e;
          if ("object" !== t || !e) {
            return [0, t];
          }
          let n = a.call(e).slice(8, -1);
          switch (n) {
            case "Array":
              return [1, ""];
            case "Object":
              return [2, ""];
            case "Date":
              return [3, ""];
            case "RegExp":
              return [4, ""];
            case "Map":
              return [5, ""];
            case "Set":
              return [6, ""];
          }
          return n.includes("Array") ? [1, n] : n.includes("Error") ? [7, n] : [2, n];
        },
        s = ([e, t]) => 0 === e && ("function" === t || "symbol" === t),
        c = (e, { json: t, lossy: n } = {}) => {
          let r = [];
          return (
            ((e, t, n, r) => {
              let i = (e, t) => {
                  let i = r.push(e) - 1;
                  return (n.set(t, i), i);
                },
                a = (r) => {
                  if (n.has(r)) {
                    return n.get(r);
                  }
                  let [c, u] = l(r);
                  switch (c) {
                    case 0: {
                      let t = r;
                      switch (u) {
                        case "bigint":
                          ((c = 8), (t = r.toString()));
                          break;
                        case "function":
                        case "symbol":
                          if (e) {
                            throw TypeError("unable to serialize " + u);
                          }
                          t = null;
                          break;
                        case "undefined":
                          return i([-1], r);
                      }
                      return i([c, t], r);
                    }
                    case 1: {
                      if (u) {
                        return i([u, [...r]], r);
                      }
                      let e = [],
                        t = i([c, e], r);
                      for (let t of r) {
                        e.push(a(t));
                      }
                      return t;
                    }
                    case 2: {
                      if (u) {
                        switch (u) {
                          case "BigInt":
                            return i([u, r.toString()], r);
                          case "Boolean":
                          case "Number":
                          case "String":
                            return i([u, r.valueOf()], r);
                        }
                      }
                      if (t && "toJSON" in r) {
                        return a(r.toJSON());
                      }
                      let n = [],
                        d = i([c, n], r);
                      for (let t of o(r)) {
                        (e || !s(l(r[t]))) && n.push([a(t), a(r[t])]);
                      }
                      return d;
                    }
                    case 3:
                      return i([c, r.toISOString()], r);
                    case 4: {
                      let { source: e, flags: t } = r;
                      return i([c, { source: e, flags: t }], r);
                    }
                    case 5: {
                      let t = [],
                        n = i([c, t], r);
                      for (let [n, i] of r) {
                        (e || !(s(l(n)) || s(l(i)))) && t.push([a(n), a(i)]);
                      }
                      return n;
                    }
                    case 6: {
                      let t = [],
                        n = i([c, t], r);
                      for (let n of r) {
                        (e || !s(l(n))) && t.push(a(n));
                      }
                      return n;
                    }
                  }
                  let { message: d } = r;
                  return i([c, { name: u, message: d }], r);
                };
              return a;
            })(
              !(t || n),
              !!t,
              new Map(),
              r,
            )(e),
            r
          );
        },
        u =
          "function" == typeof structuredClone
            ? (e, t) => (t && ("json" in t || "lossy" in t) ? i(c(e, t)) : structuredClone(e))
            : (e, t) => i(c(e, t));
    },
    20728: (e, t, n) => {
      "use strict";
      function r(e) {
        return e
          .replace(/[\t\n\r ]+/g, " ")
          .replace(/^ | $/g, "")
          .toLowerCase()
          .toUpperCase();
      }
      n.d(t, { B: () => r });
    },
    23195: (e, t, n) => {
      "use strict";
      function r(e, t, n) {
        let r = [],
          i = -1;
        for (; ++i < e.length; ) {
          let a = e[i].resolveAll;
          a && !r.includes(a) && ((t = a(t, n)), r.push(a));
        }
        return t;
      }
      n.d(t, { W: () => r });
    },
    25478: (e, t, n) => {
      "use strict";
      n.d(t, { YR: () => i });
      var r = n(96541);
      function i(e, t, n, i) {
        let a, o, l;
        ("function" == typeof t && "function" != typeof n
          ? ((o = void 0), (l = t), (a = n))
          : ((o = t), (l = n), (a = i)),
          (0, r.VG)(
            e,
            o,
            function (e, t) {
              let n = t[t.length - 1],
                r = n ? n.children.indexOf(e) : void 0;
              return l(e, r, n);
            },
            a,
          ));
      }
    },
    27598: (e, t, n) => {
      "use strict";
      n.d(t, { G1: () => o, PW: () => i, Y: () => r });
      let r = a("end"),
        i = a("start");
      function a(e) {
        return function (t) {
          let n = (t && t.position && t.position[e]) || {};
          if (
            "number" == typeof n.line &&
            n.line > 0 &&
            "number" == typeof n.column &&
            n.column > 0
          ) {
            return {
              line: n.line,
              column: n.column,
              offset: "number" == typeof n.offset && n.offset > -1 ? n.offset : void 0,
            };
          }
        };
      }
      function o(e) {
        let t = i(e),
          n = r(e);
        if (t && n) {
          return { start: t, end: n };
        }
      }
    },
    28814: (e, t, n) => {
      "use strict";
      var r;
      n.d(t, {
        AM: () => r,
        CS: () => d,
        Fo: () => l,
        GQ: () => c,
        L4: () => a,
        NF: () => u,
        tO: () => o,
        tU: () => s,
      });
      let i = new Set([
          65534, 65535, 131070, 131071, 196606, 196607, 262142, 262143, 327678, 327679, 393214,
          393215, 458750, 458751, 524286, 524287, 589822, 589823, 655358, 655359, 720894, 720895,
          786430, 786431, 851966, 851967, 917502, 917503, 983038, 983039, 1048574, 1048575, 1114110,
          1114111,
        ]),
        a = "�";
      !(function (e) {
        ((e[(e.EOF = -1)] = "EOF"),
          (e[(e.NULL = 0)] = "NULL"),
          (e[(e.TABULATION = 9)] = "TABULATION"),
          (e[(e.CARRIAGE_RETURN = 13)] = "CARRIAGE_RETURN"),
          (e[(e.LINE_FEED = 10)] = "LINE_FEED"),
          (e[(e.FORM_FEED = 12)] = "FORM_FEED"),
          (e[(e.SPACE = 32)] = "SPACE"),
          (e[(e.EXCLAMATION_MARK = 33)] = "EXCLAMATION_MARK"),
          (e[(e.QUOTATION_MARK = 34)] = "QUOTATION_MARK"),
          (e[(e.NUMBER_SIGN = 35)] = "NUMBER_SIGN"),
          (e[(e.AMPERSAND = 38)] = "AMPERSAND"),
          (e[(e.APOSTROPHE = 39)] = "APOSTROPHE"),
          (e[(e.HYPHEN_MINUS = 45)] = "HYPHEN_MINUS"),
          (e[(e.SOLIDUS = 47)] = "SOLIDUS"),
          (e[(e.DIGIT_0 = 48)] = "DIGIT_0"),
          (e[(e.DIGIT_9 = 57)] = "DIGIT_9"),
          (e[(e.SEMICOLON = 59)] = "SEMICOLON"),
          (e[(e.LESS_THAN_SIGN = 60)] = "LESS_THAN_SIGN"),
          (e[(e.EQUALS_SIGN = 61)] = "EQUALS_SIGN"),
          (e[(e.GREATER_THAN_SIGN = 62)] = "GREATER_THAN_SIGN"),
          (e[(e.QUESTION_MARK = 63)] = "QUESTION_MARK"),
          (e[(e.LATIN_CAPITAL_A = 65)] = "LATIN_CAPITAL_A"),
          (e[(e.LATIN_CAPITAL_F = 70)] = "LATIN_CAPITAL_F"),
          (e[(e.LATIN_CAPITAL_X = 88)] = "LATIN_CAPITAL_X"),
          (e[(e.LATIN_CAPITAL_Z = 90)] = "LATIN_CAPITAL_Z"),
          (e[(e.RIGHT_SQUARE_BRACKET = 93)] = "RIGHT_SQUARE_BRACKET"),
          (e[(e.GRAVE_ACCENT = 96)] = "GRAVE_ACCENT"),
          (e[(e.LATIN_SMALL_A = 97)] = "LATIN_SMALL_A"),
          (e[(e.LATIN_SMALL_F = 102)] = "LATIN_SMALL_F"),
          (e[(e.LATIN_SMALL_X = 120)] = "LATIN_SMALL_X"),
          (e[(e.LATIN_SMALL_Z = 122)] = "LATIN_SMALL_Z"),
          (e[(e.REPLACEMENT_CHARACTER = 65533)] = "REPLACEMENT_CHARACTER"));
      })((r = r || (r = {})));
      let o = {
        DASH_DASH: "--",
        CDATA_START: "[CDATA[",
        DOCTYPE: "doctype",
        SCRIPT: "script",
        PUBLIC: "public",
        SYSTEM: "system",
      };
      function l(e) {
        return e >= 55296 && e <= 57343;
      }
      function s(e) {
        return e >= 56320 && e <= 57343;
      }
      function c(e, t) {
        return (e - 55296) * 1024 + 9216 + t;
      }
      function u(e) {
        return (
          (32 !== e && 10 !== e && 13 !== e && 9 !== e && 12 !== e && e >= 1 && e <= 31) ||
          (e >= 127 && e <= 159)
        );
      }
      function d(e) {
        return (e >= 64976 && e <= 65007) || i.has(e);
      }
    },
    30648: (e) => {
      "use strict";
      e.exports = Error;
    },
    31109: (e, t, n) => {
      "use strict";
      function r(e) {
        return e.toLowerCase();
      }
      n.d(t, { S: () => r });
    },
    32335: (e, t, n) => {
      "use strict";
      n.d(t, { N: () => i });
      var r = n(97058);
      function i(e, t, n, i) {
        let a = i ? i - 1 : 1 / 0,
          o = 0;
        return function (i) {
          return (0, r.On)(i)
            ? (e.enter(n),
              (function i(l) {
                return (0, r.On)(l) && o++ < a ? (e.consume(l), i) : (e.exit(n), t(l));
              })(i))
            : t(i);
        };
      }
    },
    36753: (e, t, n) => {
      "use strict";
      n.d(t, { S: () => i });
      var r = n(97058);
      function i(e) {
        return null === e || (0, r.Ee)(e) || (0, r.Ny)(e) ? 1 : (0, r.es)(e) ? 2 : void 0;
      }
    },
    41451: (e, t, n) => {
      "use strict";
      n.d(t, { y: () => a });
      var r = n(72805);
      let i = {}.hasOwnProperty;
      function a(e) {
        let t = {},
          n = -1;
        for (; ++n < e.length; ) {
          !(function (e, t) {
            let n;
            for (n in t) {
              let a,
                o = (i.call(e, n) ? e[n] : void 0) || (e[n] = {}),
                l = t[n];
              if (l)
                for (a in l) {
                  i.call(o, a) || (o[a] = []);
                  let e = l[a];
                  !(function (e, t) {
                    let n = -1,
                      i = [];
                    for (; ++n < t.length; ) ("after" === t[n].add ? e : i).push(t[n]);
                    (0, r.m)(e, 0, 0, i);
                  })(o[a], Array.isArray(e) ? e : e ? [e] : []);
                }
            }
          })(t, e[n]);
        }
        return t;
      }
    },
    41921: (e, t, n) => {
      var r = n(7199);
      e.exports = function (e) {
        return null == e ? "" : r(e);
      };
    },
    44735: (e, t, n) => {
      "use strict";
      n.d(t, { R: () => r });
      class r {
        constructor(e, t) {
          ((this.property = e), (this.attribute = t));
        }
      }
      ((r.prototype.space = null),
        (r.prototype.boolean = !1),
        (r.prototype.booleanish = !1),
        (r.prototype.overloadedBoolean = !1),
        (r.prototype.number = !1),
        (r.prototype.commaSeparated = !1),
        (r.prototype.spaceSeparated = !1),
        (r.prototype.commaOrSpaceSeparated = !1),
        (r.prototype.mustUseProperty = !1),
        (r.prototype.defined = !1));
    },
    45119: (e, t, n) => {
      "use strict";
      n.d(t, { i: () => O });
      var r,
        i,
        a = n(99819),
        o = n(16958);
      let l = new Set([
          o.TAG_ID.DD,
          o.TAG_ID.DT,
          o.TAG_ID.LI,
          o.TAG_ID.OPTGROUP,
          o.TAG_ID.OPTION,
          o.TAG_ID.P,
          o.TAG_ID.RB,
          o.TAG_ID.RP,
          o.TAG_ID.RT,
          o.TAG_ID.RTC,
        ]),
        s = new Set([
          ...l,
          o.TAG_ID.CAPTION,
          o.TAG_ID.COLGROUP,
          o.TAG_ID.TBODY,
          o.TAG_ID.TD,
          o.TAG_ID.TFOOT,
          o.TAG_ID.TH,
          o.TAG_ID.THEAD,
          o.TAG_ID.TR,
        ]),
        c = new Map([
          [o.TAG_ID.APPLET, o.NS.HTML],
          [o.TAG_ID.CAPTION, o.NS.HTML],
          [o.TAG_ID.HTML, o.NS.HTML],
          [o.TAG_ID.MARQUEE, o.NS.HTML],
          [o.TAG_ID.OBJECT, o.NS.HTML],
          [o.TAG_ID.TABLE, o.NS.HTML],
          [o.TAG_ID.TD, o.NS.HTML],
          [o.TAG_ID.TEMPLATE, o.NS.HTML],
          [o.TAG_ID.TH, o.NS.HTML],
          [o.TAG_ID.ANNOTATION_XML, o.NS.MATHML],
          [o.TAG_ID.MI, o.NS.MATHML],
          [o.TAG_ID.MN, o.NS.MATHML],
          [o.TAG_ID.MO, o.NS.MATHML],
          [o.TAG_ID.MS, o.NS.MATHML],
          [o.TAG_ID.MTEXT, o.NS.MATHML],
          [o.TAG_ID.DESC, o.NS.SVG],
          [o.TAG_ID.FOREIGN_OBJECT, o.NS.SVG],
          [o.TAG_ID.TITLE, o.NS.SVG],
        ]),
        u = [o.TAG_ID.H1, o.TAG_ID.H2, o.TAG_ID.H3, o.TAG_ID.H4, o.TAG_ID.H5, o.TAG_ID.H6],
        d = [o.TAG_ID.TR, o.TAG_ID.TEMPLATE, o.TAG_ID.HTML],
        p = [o.TAG_ID.TBODY, o.TAG_ID.TFOOT, o.TAG_ID.THEAD, o.TAG_ID.TEMPLATE, o.TAG_ID.HTML],
        h = [o.TAG_ID.TABLE, o.TAG_ID.TEMPLATE, o.TAG_ID.HTML],
        f = [o.TAG_ID.TD, o.TAG_ID.TH];
      class m {
        get currentTmplContentOrNode() {
          return this._isInTemplate()
            ? this.treeAdapter.getTemplateContent(this.current)
            : this.current;
        }
        constructor(e, t, n) {
          ((this.treeAdapter = t),
            (this.handler = n),
            (this.items = []),
            (this.tagIDs = []),
            (this.stackTop = -1),
            (this.tmplCount = 0),
            (this.currentTagId = o.TAG_ID.UNKNOWN),
            (this.current = e));
        }
        _indexOf(e) {
          return this.items.lastIndexOf(e, this.stackTop);
        }
        _isInTemplate() {
          return (
            this.currentTagId === o.TAG_ID.TEMPLATE &&
            this.treeAdapter.getNamespaceURI(this.current) === o.NS.HTML
          );
        }
        _updateCurrentElement() {
          ((this.current = this.items[this.stackTop]),
            (this.currentTagId = this.tagIDs[this.stackTop]));
        }
        push(e, t) {
          (this.stackTop++,
            (this.items[this.stackTop] = e),
            (this.current = e),
            (this.tagIDs[this.stackTop] = t),
            (this.currentTagId = t),
            this._isInTemplate() && this.tmplCount++,
            this.handler.onItemPush(e, t, !0));
        }
        pop() {
          let e = this.current;
          (this.tmplCount > 0 && this._isInTemplate() && this.tmplCount--,
            this.stackTop--,
            this._updateCurrentElement(),
            this.handler.onItemPop(e, !0));
        }
        replace(e, t) {
          let n = this._indexOf(e);
          ((this.items[n] = t), n === this.stackTop && (this.current = t));
        }
        insertAfter(e, t, n) {
          let r = this._indexOf(e) + 1;
          (this.items.splice(r, 0, t),
            this.tagIDs.splice(r, 0, n),
            this.stackTop++,
            r === this.stackTop && this._updateCurrentElement(),
            this.handler.onItemPush(this.current, this.currentTagId, r === this.stackTop));
        }
        popUntilTagNamePopped(e) {
          let t = this.stackTop + 1;
          do {
            t = this.tagIDs.lastIndexOf(e, t - 1);
          } while (t > 0 && this.treeAdapter.getNamespaceURI(this.items[t]) !== o.NS.HTML);
          this.shortenToLength(t < 0 ? 0 : t);
        }
        shortenToLength(e) {
          for (; this.stackTop >= e; ) {
            let t = this.current;
            (this.tmplCount > 0 && this._isInTemplate() && (this.tmplCount -= 1),
              this.stackTop--,
              this._updateCurrentElement(),
              this.handler.onItemPop(t, this.stackTop < e));
          }
        }
        popUntilElementPopped(e) {
          let t = this._indexOf(e);
          this.shortenToLength(t < 0 ? 0 : t);
        }
        popUntilPopped(e, t) {
          let n = this._indexOfTagNames(e, t);
          this.shortenToLength(n < 0 ? 0 : n);
        }
        popUntilNumberedHeaderPopped() {
          this.popUntilPopped(u, o.NS.HTML);
        }
        popUntilTableCellPopped() {
          this.popUntilPopped(f, o.NS.HTML);
        }
        popAllUpToHtmlElement() {
          ((this.tmplCount = 0), this.shortenToLength(1));
        }
        _indexOfTagNames(e, t) {
          for (let n = this.stackTop; n >= 0; n--) {
            if (e.includes(this.tagIDs[n]) && this.treeAdapter.getNamespaceURI(this.items[n]) === t)
              return n;
          }
          return -1;
        }
        clearBackTo(e, t) {
          let n = this._indexOfTagNames(e, t);
          this.shortenToLength(n + 1);
        }
        clearBackToTableContext() {
          this.clearBackTo(h, o.NS.HTML);
        }
        clearBackToTableBodyContext() {
          this.clearBackTo(p, o.NS.HTML);
        }
        clearBackToTableRowContext() {
          this.clearBackTo(d, o.NS.HTML);
        }
        remove(e) {
          let t = this._indexOf(e);
          t >= 0 &&
            (t === this.stackTop
              ? this.pop()
              : (this.items.splice(t, 1),
                this.tagIDs.splice(t, 1),
                this.stackTop--,
                this._updateCurrentElement(),
                this.handler.onItemPop(e, !1)));
        }
        tryPeekProperlyNestedBodyElement() {
          return this.stackTop >= 1 && this.tagIDs[1] === o.TAG_ID.BODY ? this.items[1] : null;
        }
        contains(e) {
          return this._indexOf(e) > -1;
        }
        getCommonAncestor(e) {
          let t = this._indexOf(e) - 1;
          return t >= 0 ? this.items[t] : null;
        }
        isRootHtmlElementCurrent() {
          return 0 === this.stackTop && this.tagIDs[0] === o.TAG_ID.HTML;
        }
        hasInScope(e) {
          for (let t = this.stackTop; t >= 0; t--) {
            let n = this.tagIDs[t],
              r = this.treeAdapter.getNamespaceURI(this.items[t]);
            if (n === e && r === o.NS.HTML) {
              break;
            }
            if (c.get(n) === r) {
              return !1;
            }
          }
          return !0;
        }
        hasNumberedHeaderInScope() {
          for (let e = this.stackTop; e >= 0; e--) {
            let t = this.tagIDs[e],
              n = this.treeAdapter.getNamespaceURI(this.items[e]);
            if ((0, o.isNumberedHeader)(t) && n === o.NS.HTML) {
              break;
            }
            if (c.get(t) === n) {
              return !1;
            }
          }
          return !0;
        }
        hasInListItemScope(e) {
          for (let t = this.stackTop; t >= 0; t--) {
            let n = this.tagIDs[t],
              r = this.treeAdapter.getNamespaceURI(this.items[t]);
            if (n === e && r === o.NS.HTML) {
              break;
            }
            if (((n === o.TAG_ID.UL || n === o.TAG_ID.OL) && r === o.NS.HTML) || c.get(n) === r) {
              return !1;
            }
          }
          return !0;
        }
        hasInButtonScope(e) {
          for (let t = this.stackTop; t >= 0; t--) {
            let n = this.tagIDs[t],
              r = this.treeAdapter.getNamespaceURI(this.items[t]);
            if (n === e && r === o.NS.HTML) {
              break;
            }
            if ((n === o.TAG_ID.BUTTON && r === o.NS.HTML) || c.get(n) === r) {
              return !1;
            }
          }
          return !0;
        }
        hasInTableScope(e) {
          for (let t = this.stackTop; t >= 0; t--) {
            let n = this.tagIDs[t];
            if (this.treeAdapter.getNamespaceURI(this.items[t]) === o.NS.HTML) {
              if (n === e) {
                return !0;
              }
              if (n === o.TAG_ID.TABLE || n === o.TAG_ID.TEMPLATE || n === o.TAG_ID.HTML) {
                return !1;
              }
            }
          }
          return !0;
        }
        hasTableBodyContextInTableScope() {
          for (let e = this.stackTop; e >= 0; e--) {
            let t = this.tagIDs[e];
            if (this.treeAdapter.getNamespaceURI(this.items[e]) === o.NS.HTML) {
              if (t === o.TAG_ID.TBODY || t === o.TAG_ID.THEAD || t === o.TAG_ID.TFOOT) {
                return !0;
              }
              if (t === o.TAG_ID.TABLE || t === o.TAG_ID.HTML) {
                return !1;
              }
            }
          }
          return !0;
        }
        hasInSelectScope(e) {
          for (let t = this.stackTop; t >= 0; t--) {
            let n = this.tagIDs[t];
            if (this.treeAdapter.getNamespaceURI(this.items[t]) === o.NS.HTML) {
              if (n === e) {
                return !0;
              }
              if (n !== o.TAG_ID.OPTION && n !== o.TAG_ID.OPTGROUP) {
                return !1;
              }
            }
          }
          return !0;
        }
        generateImpliedEndTags() {
          for (; l.has(this.currentTagId); ) {
            this.pop();
          }
        }
        generateImpliedEndTagsThoroughly() {
          for (; s.has(this.currentTagId); ) {
            this.pop();
          }
        }
        generateImpliedEndTagsWithExclusion(e) {
          for (; this.currentTagId !== e && s.has(this.currentTagId); ) {
            this.pop();
          }
        }
      }
      !(function (e) {
        ((e[(e.Marker = 0)] = "Marker"), (e[(e.Element = 1)] = "Element"));
      })((r = r || (r = {})));
      let T = { type: r.Marker };
      class g {
        constructor(e) {
          ((this.treeAdapter = e), (this.entries = []), (this.bookmark = null));
        }
        _getNoahArkConditionCandidates(e, t) {
          let n = [],
            i = t.length,
            a = this.treeAdapter.getTagName(e),
            o = this.treeAdapter.getNamespaceURI(e);
          for (let e = 0; e < this.entries.length; e++) {
            let t = this.entries[e];
            if (t.type === r.Marker) {
              break;
            }
            let { element: l } = t;
            if (this.treeAdapter.getTagName(l) === a && this.treeAdapter.getNamespaceURI(l) === o) {
              let t = this.treeAdapter.getAttrList(l);
              t.length === i && n.push({ idx: e, attrs: t });
            }
          }
          return n;
        }
        _ensureNoahArkCondition(e) {
          if (this.entries.length < 3) {
            return;
          }
          let t = this.treeAdapter.getAttrList(e),
            n = this._getNoahArkConditionCandidates(e, t);
          if (n.length < 3) {
            return;
          }
          let r = new Map(t.map((e) => [e.name, e.value])),
            i = 0;
          for (let e = 0; e < n.length; e++) {
            let t = n[e];
            t.attrs.every((e) => r.get(e.name) === e.value) &&
              (i += 1) >= 3 &&
              this.entries.splice(t.idx, 1);
          }
        }
        insertMarker() {
          this.entries.unshift(T);
        }
        pushElement(e, t) {
          (this._ensureNoahArkCondition(e),
            this.entries.unshift({ type: r.Element, element: e, token: t }));
        }
        insertElementAfterBookmark(e, t) {
          let n = this.entries.indexOf(this.bookmark);
          this.entries.splice(n, 0, { type: r.Element, element: e, token: t });
        }
        removeEntry(e) {
          let t = this.entries.indexOf(e);
          t >= 0 && this.entries.splice(t, 1);
        }
        clearToLastMarker() {
          let e = this.entries.indexOf(T);
          e >= 0 ? this.entries.splice(0, e + 1) : (this.entries.length = 0);
        }
        getElementEntryInScopeWithTagName(e) {
          let t = this.entries.find(
            (t) => t.type === r.Marker || this.treeAdapter.getTagName(t.element) === e,
          );
          return t && t.type === r.Element ? t : null;
        }
        getElementEntry(e) {
          return this.entries.find((t) => t.type === r.Element && t.element === e);
        }
      }
      var A = n(57920);
      let E = "html",
        I = [
          "+//silmaril//dtd html pro v0r11 19970101//",
          "-//as//dtd html 3.0 aswedit + extensions//",
          "-//advasoft ltd//dtd html 3.0 aswedit + extensions//",
          "-//ietf//dtd html 2.0 level 1//",
          "-//ietf//dtd html 2.0 level 2//",
          "-//ietf//dtd html 2.0 strict level 1//",
          "-//ietf//dtd html 2.0 strict level 2//",
          "-//ietf//dtd html 2.0 strict//",
          "-//ietf//dtd html 2.0//",
          "-//ietf//dtd html 2.1e//",
          "-//ietf//dtd html 3.0//",
          "-//ietf//dtd html 3.2 final//",
          "-//ietf//dtd html 3.2//",
          "-//ietf//dtd html 3//",
          "-//ietf//dtd html level 0//",
          "-//ietf//dtd html level 1//",
          "-//ietf//dtd html level 2//",
          "-//ietf//dtd html level 3//",
          "-//ietf//dtd html strict level 0//",
          "-//ietf//dtd html strict level 1//",
          "-//ietf//dtd html strict level 2//",
          "-//ietf//dtd html strict level 3//",
          "-//ietf//dtd html strict//",
          "-//ietf//dtd html//",
          "-//metrius//dtd metrius presentational//",
          "-//microsoft//dtd internet explorer 2.0 html strict//",
          "-//microsoft//dtd internet explorer 2.0 html//",
          "-//microsoft//dtd internet explorer 2.0 tables//",
          "-//microsoft//dtd internet explorer 3.0 html strict//",
          "-//microsoft//dtd internet explorer 3.0 html//",
          "-//microsoft//dtd internet explorer 3.0 tables//",
          "-//netscape comm. corp.//dtd html//",
          "-//netscape comm. corp.//dtd strict html//",
          "-//o'reilly and associates//dtd html 2.0//",
          "-//o'reilly and associates//dtd html extended 1.0//",
          "-//o'reilly and associates//dtd html extended relaxed 1.0//",
          "-//sq//dtd html 2.0 hotmetal + extensions//",
          "-//softquad software//dtd hotmetal pro 6.0::19990601::extensions to html 4.0//",
          "-//softquad//dtd hotmetal pro 4.0::19971010::extensions to html 4.0//",
          "-//spyglass//dtd html 2.0 extended//",
          "-//sun microsystems corp.//dtd hotjava html//",
          "-//sun microsystems corp.//dtd hotjava strict html//",
          "-//w3c//dtd html 3 1995-03-24//",
          "-//w3c//dtd html 3.2 draft//",
          "-//w3c//dtd html 3.2 final//",
          "-//w3c//dtd html 3.2//",
          "-//w3c//dtd html 3.2s draft//",
          "-//w3c//dtd html 4.0 frameset//",
          "-//w3c//dtd html 4.0 transitional//",
          "-//w3c//dtd html experimental 19960712//",
          "-//w3c//dtd html experimental 970421//",
          "-//w3c//dtd w3 html//",
          "-//w3o//dtd w3 html 3.0//",
          "-//webtechs//dtd mozilla html 2.0//",
          "-//webtechs//dtd mozilla html//",
        ],
        _ = [...I, "-//w3c//dtd html 4.01 frameset//", "-//w3c//dtd html 4.01 transitional//"],
        k = new Set([
          "-//w3o//dtd w3 html strict 3.0//en//",
          "-/w3c/dtd html 4.0 transitional/en",
          "html",
        ]),
        D = ["-//w3c//dtd xhtml 1.0 frameset//", "-//w3c//dtd xhtml 1.0 transitional//"],
        b = [...D, "-//w3c//dtd html 4.01 frameset//", "-//w3c//dtd html 4.01 transitional//"];
      function y(e, t) {
        return t.some((t) => e.startsWith(t));
      }
      var N = n(18857),
        S = n(51456),
        C = n(28814),
        x = n(63828);
      !(function (e) {
        ((e[(e.INITIAL = 0)] = "INITIAL"),
          (e[(e.BEFORE_HTML = 1)] = "BEFORE_HTML"),
          (e[(e.BEFORE_HEAD = 2)] = "BEFORE_HEAD"),
          (e[(e.IN_HEAD = 3)] = "IN_HEAD"),
          (e[(e.IN_HEAD_NO_SCRIPT = 4)] = "IN_HEAD_NO_SCRIPT"),
          (e[(e.AFTER_HEAD = 5)] = "AFTER_HEAD"),
          (e[(e.IN_BODY = 6)] = "IN_BODY"),
          (e[(e.TEXT = 7)] = "TEXT"),
          (e[(e.IN_TABLE = 8)] = "IN_TABLE"),
          (e[(e.IN_TABLE_TEXT = 9)] = "IN_TABLE_TEXT"),
          (e[(e.IN_CAPTION = 10)] = "IN_CAPTION"),
          (e[(e.IN_COLUMN_GROUP = 11)] = "IN_COLUMN_GROUP"),
          (e[(e.IN_TABLE_BODY = 12)] = "IN_TABLE_BODY"),
          (e[(e.IN_ROW = 13)] = "IN_ROW"),
          (e[(e.IN_CELL = 14)] = "IN_CELL"),
          (e[(e.IN_SELECT = 15)] = "IN_SELECT"),
          (e[(e.IN_SELECT_IN_TABLE = 16)] = "IN_SELECT_IN_TABLE"),
          (e[(e.IN_TEMPLATE = 17)] = "IN_TEMPLATE"),
          (e[(e.AFTER_BODY = 18)] = "AFTER_BODY"),
          (e[(e.IN_FRAMESET = 19)] = "IN_FRAMESET"),
          (e[(e.AFTER_FRAMESET = 20)] = "AFTER_FRAMESET"),
          (e[(e.AFTER_AFTER_BODY = 21)] = "AFTER_AFTER_BODY"),
          (e[(e.AFTER_AFTER_FRAMESET = 22)] = "AFTER_AFTER_FRAMESET"));
      })(i || (i = {}));
      let L = {
          startLine: -1,
          startCol: -1,
          startOffset: -1,
          endLine: -1,
          endCol: -1,
          endOffset: -1,
        },
        v = new Set([o.TAG_ID.TABLE, o.TAG_ID.TBODY, o.TAG_ID.TFOOT, o.TAG_ID.THEAD, o.TAG_ID.TR]),
        G = {
          scriptingEnabled: !0,
          sourceCodeLocationInfo: !1,
          treeAdapter: A.j,
          onParseError: null,
        };
      class O {
        constructor(e, t, n = null, r = null) {
          ((this.fragmentContext = n),
            (this.scriptHandler = r),
            (this.currentToken = null),
            (this.stopped = !1),
            (this.insertionMode = i.INITIAL),
            (this.originalInsertionMode = i.INITIAL),
            (this.headElement = null),
            (this.formElement = null),
            (this.currentNotInHTML = !1),
            (this.tmplInsertionModeStack = []),
            (this.pendingCharacterTokens = []),
            (this.hasNonWhitespacePendingCharacterToken = !1),
            (this.framesetOk = !0),
            (this.skipNextNewLine = !1),
            (this.fosterParentingEnabled = !1),
            (this.options = { ...G, ...e }),
            (this.treeAdapter = this.options.treeAdapter),
            (this.onParseError = this.options.onParseError),
            this.onParseError && (this.options.sourceCodeLocationInfo = !0),
            (this.document = null != t ? t : this.treeAdapter.createDocument()),
            (this.tokenizer = new a._(this.options, this)),
            (this.activeFormattingElements = new g(this.treeAdapter)),
            (this.fragmentContextID = n
              ? (0, o.getTagID)(this.treeAdapter.getTagName(n))
              : o.TAG_ID.UNKNOWN),
            this._setContextModes(null != n ? n : this.document, this.fragmentContextID),
            (this.openElements = new m(this.document, this.treeAdapter, this)));
        }
        static parse(e, t) {
          let n = new this(t);
          return (n.tokenizer.write(e, !0), n.document);
        }
        static getFragmentParser(e, t) {
          let n = { ...G, ...t };
          null != e || (e = n.treeAdapter.createElement(o.TAG_NAMES.TEMPLATE, o.NS.HTML, []));
          let r = n.treeAdapter.createElement("documentmock", o.NS.HTML, []),
            a = new this(n, r, e);
          return (
            a.fragmentContextID === o.TAG_ID.TEMPLATE &&
              a.tmplInsertionModeStack.unshift(i.IN_TEMPLATE),
            a._initTokenizerForFragmentParsing(),
            a._insertFakeRootElement(),
            a._resetInsertionMode(),
            a._findFormInFragmentContext(),
            a
          );
        }
        getFragment() {
          let e = this.treeAdapter.getFirstChild(this.document),
            t = this.treeAdapter.createDocumentFragment();
          return (this._adoptNodes(e, t), t);
        }
        _err(e, t, n) {
          var r;
          if (!this.onParseError) {
            return;
          }
          let i = null != (r = e.location) ? r : L,
            a = {
              code: t,
              startLine: i.startLine,
              startCol: i.startCol,
              startOffset: i.startOffset,
              endLine: n ? i.startLine : i.endLine,
              endCol: n ? i.startCol : i.endCol,
              endOffset: n ? i.startOffset : i.endOffset,
            };
          this.onParseError(a);
        }
        onItemPush(e, t, n) {
          var r, i;
          (null == (i = (r = this.treeAdapter).onItemPush) || i.call(r, e),
            n && this.openElements.stackTop > 0 && this._setContextModes(e, t));
        }
        onItemPop(e, t) {
          var n, r;
          if (
            (this.options.sourceCodeLocationInfo && this._setEndLocation(e, this.currentToken),
            null == (r = (n = this.treeAdapter).onItemPop) ||
              r.call(n, e, this.openElements.current),
            t)
          ) {
            let e, t;
            (0 === this.openElements.stackTop && this.fragmentContext
              ? ((e = this.fragmentContext), (t = this.fragmentContextID))
              : ({ current: e, currentTagId: t } = this.openElements),
              this._setContextModes(e, t));
          }
        }
        _setContextModes(e, t) {
          let n = e === this.document || this.treeAdapter.getNamespaceURI(e) === o.NS.HTML;
          ((this.currentNotInHTML = !n),
            (this.tokenizer.inForeignNode = !n && !this._isIntegrationPoint(t, e)));
        }
        _switchToTextParsing(e, t) {
          (this._insertElement(e, o.NS.HTML),
            (this.tokenizer.state = t),
            (this.originalInsertionMode = this.insertionMode),
            (this.insertionMode = i.TEXT));
        }
        switchToPlaintextParsing() {
          ((this.insertionMode = i.TEXT),
            (this.originalInsertionMode = i.IN_BODY),
            (this.tokenizer.state = a.V.PLAINTEXT));
        }
        _getAdjustedCurrentElement() {
          return 0 === this.openElements.stackTop && this.fragmentContext
            ? this.fragmentContext
            : this.openElements.current;
        }
        _findFormInFragmentContext() {
          let e = this.fragmentContext;
          for (; e; ) {
            if (this.treeAdapter.getTagName(e) === o.TAG_NAMES.FORM) {
              this.formElement = e;
              break;
            }
            e = this.treeAdapter.getParentNode(e);
          }
        }
        _initTokenizerForFragmentParsing() {
          if (
            this.fragmentContext &&
            this.treeAdapter.getNamespaceURI(this.fragmentContext) === o.NS.HTML
          ) {
            switch (this.fragmentContextID) {
              case o.TAG_ID.TITLE:
              case o.TAG_ID.TEXTAREA:
                this.tokenizer.state = a.V.RCDATA;
                break;
              case o.TAG_ID.STYLE:
              case o.TAG_ID.XMP:
              case o.TAG_ID.IFRAME:
              case o.TAG_ID.NOEMBED:
              case o.TAG_ID.NOFRAMES:
              case o.TAG_ID.NOSCRIPT:
                this.tokenizer.state = a.V.RAWTEXT;
                break;
              case o.TAG_ID.SCRIPT:
                this.tokenizer.state = a.V.SCRIPT_DATA;
                break;
              case o.TAG_ID.PLAINTEXT:
                this.tokenizer.state = a.V.PLAINTEXT;
            }
          }
        }
        _setDocumentType(e) {
          let t = e.name || "",
            n = e.publicId || "",
            r = e.systemId || "";
          if ((this.treeAdapter.setDocumentType(this.document, t, n, r), e.location)) {
            let t = this.treeAdapter
              .getChildNodes(this.document)
              .find((e) => this.treeAdapter.isDocumentTypeNode(e));
            t && this.treeAdapter.setNodeSourceCodeLocation(t, e.location);
          }
        }
        _attachElementToTree(e, t) {
          if (this.options.sourceCodeLocationInfo) {
            let n = t && { ...t, startTag: t };
            this.treeAdapter.setNodeSourceCodeLocation(e, n);
          }
          if (this._shouldFosterParentOnInsertion()) {
            this._fosterParentElement(e);
          } else {
            let t = this.openElements.currentTmplContentOrNode;
            this.treeAdapter.appendChild(t, e);
          }
        }
        _appendElement(e, t) {
          let n = this.treeAdapter.createElement(e.tagName, t, e.attrs);
          this._attachElementToTree(n, e.location);
        }
        _insertElement(e, t) {
          let n = this.treeAdapter.createElement(e.tagName, t, e.attrs);
          (this._attachElementToTree(n, e.location), this.openElements.push(n, e.tagID));
        }
        _insertFakeElement(e, t) {
          let n = this.treeAdapter.createElement(e, o.NS.HTML, []);
          (this._attachElementToTree(n, null), this.openElements.push(n, t));
        }
        _insertTemplate(e) {
          let t = this.treeAdapter.createElement(e.tagName, o.NS.HTML, e.attrs),
            n = this.treeAdapter.createDocumentFragment();
          (this.treeAdapter.setTemplateContent(t, n),
            this._attachElementToTree(t, e.location),
            this.openElements.push(t, e.tagID),
            this.options.sourceCodeLocationInfo &&
              this.treeAdapter.setNodeSourceCodeLocation(n, null));
        }
        _insertFakeRootElement() {
          let e = this.treeAdapter.createElement(o.TAG_NAMES.HTML, o.NS.HTML, []);
          (this.options.sourceCodeLocationInfo &&
            this.treeAdapter.setNodeSourceCodeLocation(e, null),
            this.treeAdapter.appendChild(this.openElements.current, e),
            this.openElements.push(e, o.TAG_ID.HTML));
        }
        _appendCommentNode(e, t) {
          let n = this.treeAdapter.createCommentNode(e.data);
          (this.treeAdapter.appendChild(t, n),
            this.options.sourceCodeLocationInfo &&
              this.treeAdapter.setNodeSourceCodeLocation(n, e.location));
        }
        _insertCharacters(e) {
          let t, n;
          if (
            (this._shouldFosterParentOnInsertion()
              ? (({ parent: t, beforeElement: n } = this._findFosterParentingLocation()),
                n
                  ? this.treeAdapter.insertTextBefore(t, e.chars, n)
                  : this.treeAdapter.insertText(t, e.chars))
              : ((t = this.openElements.currentTmplContentOrNode),
                this.treeAdapter.insertText(t, e.chars)),
            !e.location)
          ) {
            return;
          }
          let r = this.treeAdapter.getChildNodes(t),
            i = n ? r.lastIndexOf(n) : r.length,
            a = r[i - 1];
          if (this.treeAdapter.getNodeSourceCodeLocation(a)) {
            let { endLine: t, endCol: n, endOffset: r } = e.location;
            this.treeAdapter.updateNodeSourceCodeLocation(a, {
              endLine: t,
              endCol: n,
              endOffset: r,
            });
          } else {
            this.options.sourceCodeLocationInfo &&
              this.treeAdapter.setNodeSourceCodeLocation(a, e.location);
          }
        }
        _adoptNodes(e, t) {
          for (
            let n = this.treeAdapter.getFirstChild(e);
            n;
            n = this.treeAdapter.getFirstChild(e)
          ) {
            (this.treeAdapter.detachNode(n), this.treeAdapter.appendChild(t, n));
          }
        }
        _setEndLocation(e, t) {
          if (this.treeAdapter.getNodeSourceCodeLocation(e) && t.location) {
            let n = t.location,
              r = this.treeAdapter.getTagName(e),
              i =
                t.type === x.k.END_TAG && r === t.tagName
                  ? {
                      endTag: { ...n },
                      endLine: n.endLine,
                      endCol: n.endCol,
                      endOffset: n.endOffset,
                    }
                  : { endLine: n.startLine, endCol: n.startCol, endOffset: n.startOffset };
            this.treeAdapter.updateNodeSourceCodeLocation(e, i);
          }
        }
        shouldProcessStartTagTokenInForeignContent(e) {
          let t, n;
          return (
            !!this.currentNotInHTML &&
            (0 === this.openElements.stackTop && this.fragmentContext
              ? ((t = this.fragmentContext), (n = this.fragmentContextID))
              : ({ current: t, currentTagId: n } = this.openElements),
            (e.tagID !== o.TAG_ID.SVG ||
              this.treeAdapter.getTagName(t) !== o.TAG_NAMES.ANNOTATION_XML ||
              this.treeAdapter.getNamespaceURI(t) !== o.NS.MATHML) &&
              (this.tokenizer.inForeignNode ||
                ((e.tagID === o.TAG_ID.MGLYPH || e.tagID === o.TAG_ID.MALIGNMARK) &&
                  !this._isIntegrationPoint(n, t, o.NS.HTML))))
          );
        }
        _processToken(e) {
          switch (e.type) {
            case x.k.CHARACTER:
              this.onCharacter(e);
              break;
            case x.k.NULL_CHARACTER:
              this.onNullCharacter(e);
              break;
            case x.k.COMMENT:
              this.onComment(e);
              break;
            case x.k.DOCTYPE:
              this.onDoctype(e);
              break;
            case x.k.START_TAG:
              this._processStartTag(e);
              break;
            case x.k.END_TAG:
              this.onEndTag(e);
              break;
            case x.k.EOF:
              this.onEof(e);
              break;
            case x.k.WHITESPACE_CHARACTER:
              this.onWhitespaceCharacter(e);
          }
        }
        _isIntegrationPoint(e, t, n) {
          let r = this.treeAdapter.getNamespaceURI(t),
            i = this.treeAdapter.getAttrList(t);
          return N.nv(e, r, i, n);
        }
        _reconstructActiveFormattingElements() {
          let e = this.activeFormattingElements.entries.length;
          if (e) {
            let t = this.activeFormattingElements.entries.findIndex(
                (e) => e.type === r.Marker || this.openElements.contains(e.element),
              ),
              n = t < 0 ? e - 1 : t - 1;
            for (let e = n; e >= 0; e--) {
              let t = this.activeFormattingElements.entries[e];
              (this._insertElement(t.token, this.treeAdapter.getNamespaceURI(t.element)),
                (t.element = this.openElements.current));
            }
          }
        }
        _closeTableCell() {
          (this.openElements.generateImpliedEndTags(),
            this.openElements.popUntilTableCellPopped(),
            this.activeFormattingElements.clearToLastMarker(),
            (this.insertionMode = i.IN_ROW));
        }
        _closePElement() {
          (this.openElements.generateImpliedEndTagsWithExclusion(o.TAG_ID.P),
            this.openElements.popUntilTagNamePopped(o.TAG_ID.P));
        }
        _resetInsertionMode() {
          for (let e = this.openElements.stackTop; e >= 0; e--) {
            switch (
              0 === e && this.fragmentContext ? this.fragmentContextID : this.openElements.tagIDs[e]
            ) {
              case o.TAG_ID.TR:
                this.insertionMode = i.IN_ROW;
                return;
              case o.TAG_ID.TBODY:
              case o.TAG_ID.THEAD:
              case o.TAG_ID.TFOOT:
                this.insertionMode = i.IN_TABLE_BODY;
                return;
              case o.TAG_ID.CAPTION:
                this.insertionMode = i.IN_CAPTION;
                return;
              case o.TAG_ID.COLGROUP:
                this.insertionMode = i.IN_COLUMN_GROUP;
                return;
              case o.TAG_ID.TABLE:
                this.insertionMode = i.IN_TABLE;
                return;
              case o.TAG_ID.BODY:
                this.insertionMode = i.IN_BODY;
                return;
              case o.TAG_ID.FRAMESET:
                this.insertionMode = i.IN_FRAMESET;
                return;
              case o.TAG_ID.SELECT:
                return this._resetInsertionModeForSelect(e);
              case o.TAG_ID.TEMPLATE:
                this.insertionMode = this.tmplInsertionModeStack[0];
                return;
              case o.TAG_ID.HTML:
                this.insertionMode = this.headElement ? i.AFTER_HEAD : i.BEFORE_HEAD;
                return;
              case o.TAG_ID.TD:
              case o.TAG_ID.TH:
                if (e > 0) {
                  this.insertionMode = i.IN_CELL;
                  return;
                }
                break;
              case o.TAG_ID.HEAD:
                if (e > 0) {
                  this.insertionMode = i.IN_HEAD;
                  return;
                }
            }
          }
          this.insertionMode = i.IN_BODY;
        }
        _resetInsertionModeForSelect(e) {
          if (e > 0) {
            for (let t = e - 1; t > 0; t--) {
              let e = this.openElements.tagIDs[t];
              if (e === o.TAG_ID.TEMPLATE) break;
              if (e === o.TAG_ID.TABLE) {
                this.insertionMode = i.IN_SELECT_IN_TABLE;
                return;
              }
            }
          }
          this.insertionMode = i.IN_SELECT;
        }
        _isElementCausesFosterParenting(e) {
          return v.has(e);
        }
        _shouldFosterParentOnInsertion() {
          return (
            this.fosterParentingEnabled &&
            this._isElementCausesFosterParenting(this.openElements.currentTagId)
          );
        }
        _findFosterParentingLocation() {
          for (let e = this.openElements.stackTop; e >= 0; e--) {
            let t = this.openElements.items[e];
            switch (this.openElements.tagIDs[e]) {
              case o.TAG_ID.TEMPLATE:
                if (this.treeAdapter.getNamespaceURI(t) === o.NS.HTML) {
                  return { parent: this.treeAdapter.getTemplateContent(t), beforeElement: null };
                }
                break;
              case o.TAG_ID.TABLE: {
                let n = this.treeAdapter.getParentNode(t);
                if (n) {
                  return { parent: n, beforeElement: t };
                }
                return { parent: this.openElements.items[e - 1], beforeElement: null };
              }
            }
          }
          return { parent: this.openElements.items[0], beforeElement: null };
        }
        _fosterParentElement(e) {
          let t = this._findFosterParentingLocation();
          t.beforeElement
            ? this.treeAdapter.insertBefore(t.parent, e, t.beforeElement)
            : this.treeAdapter.appendChild(t.parent, e);
        }
        _isSpecialElement(e, t) {
          let n = this.treeAdapter.getNamespaceURI(e);
          return o.SPECIAL_ELEMENTS[n].has(t);
        }
        onCharacter(e) {
          if (((this.skipNextNewLine = !1), this.tokenizer.inForeignNode)) {
            var t, n;
            return void ((t = this), (n = e), t._insertCharacters(n), (t.framesetOk = !1));
          }
          switch (this.insertionMode) {
            case i.INITIAL:
              w(this, e);
              break;
            case i.BEFORE_HTML:
              F(this, e);
              break;
            case i.BEFORE_HEAD:
              H(this, e);
              break;
            case i.IN_HEAD:
              q(this, e);
              break;
            case i.IN_HEAD_NO_SCRIPT:
              z(this, e);
              break;
            case i.AFTER_HEAD:
              W(this, e);
              break;
            case i.IN_BODY:
            case i.IN_CAPTION:
            case i.IN_CELL:
            case i.IN_TEMPLATE:
              j(this, e);
              break;
            case i.TEXT:
            case i.IN_SELECT:
            case i.IN_SELECT_IN_TABLE:
              this._insertCharacters(e);
              break;
            case i.IN_TABLE:
            case i.IN_TABLE_BODY:
            case i.IN_ROW:
              en(this, e);
              break;
            case i.IN_TABLE_TEXT:
              el(this, e);
              break;
            case i.IN_COLUMN_GROUP:
              ed(this, e);
              break;
            case i.AFTER_BODY:
              eI(this, e);
              break;
            case i.AFTER_AFTER_BODY:
              e_(this, e);
          }
        }
        onNullCharacter(e) {
          if (((this.skipNextNewLine = !1), this.tokenizer.inForeignNode)) {
            var t, n;
            return ((t = this), ((n = e).chars = C.L4), t._insertCharacters(n));
          }
          switch (this.insertionMode) {
            case i.INITIAL:
              w(this, e);
              break;
            case i.BEFORE_HTML:
              F(this, e);
              break;
            case i.BEFORE_HEAD:
              H(this, e);
              break;
            case i.IN_HEAD:
              q(this, e);
              break;
            case i.IN_HEAD_NO_SCRIPT:
              z(this, e);
              break;
            case i.AFTER_HEAD:
              W(this, e);
              break;
            case i.TEXT:
              this._insertCharacters(e);
              break;
            case i.IN_TABLE:
            case i.IN_TABLE_BODY:
            case i.IN_ROW:
              en(this, e);
              break;
            case i.IN_COLUMN_GROUP:
              ed(this, e);
              break;
            case i.AFTER_BODY:
              eI(this, e);
              break;
            case i.AFTER_AFTER_BODY:
              e_(this, e);
          }
        }
        onComment(e) {
          var t, n, r, a;
          if (((this.skipNextNewLine = !1), this.currentNotInHTML)) {
            return R(this, e);
          }
          switch (this.insertionMode) {
            case i.INITIAL:
            case i.BEFORE_HTML:
            case i.BEFORE_HEAD:
            case i.IN_HEAD:
            case i.IN_HEAD_NO_SCRIPT:
            case i.AFTER_HEAD:
            case i.IN_BODY:
            case i.IN_TABLE:
            case i.IN_CAPTION:
            case i.IN_COLUMN_GROUP:
            case i.IN_TABLE_BODY:
            case i.IN_ROW:
            case i.IN_CELL:
            case i.IN_SELECT:
            case i.IN_SELECT_IN_TABLE:
            case i.IN_TEMPLATE:
            case i.IN_FRAMESET:
            case i.AFTER_FRAMESET:
              R(this, e);
              break;
            case i.IN_TABLE_TEXT:
              es(this, e);
              break;
            case i.AFTER_BODY:
              ((t = this), (n = e), t._appendCommentNode(n, t.openElements.items[0]));
              break;
            case i.AFTER_AFTER_BODY:
            case i.AFTER_AFTER_FRAMESET:
              ((r = this), (a = e), r._appendCommentNode(a, r.document));
          }
        }
        onDoctype(e) {
          switch (((this.skipNextNewLine = !1), this.insertionMode)) {
            case i.INITIAL:
              !(function (e, t) {
                e._setDocumentType(t);
                let n = t.forceQuirks
                  ? o.DOCUMENT_MODE.QUIRKS
                  : (function (e) {
                      if (e.name !== E) {
                        return o.DOCUMENT_MODE.QUIRKS;
                      }
                      let { systemId: t } = e;
                      if (
                        t &&
                        "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd" ===
                          t.toLowerCase()
                      ) {
                        return o.DOCUMENT_MODE.QUIRKS;
                      }
                      let { publicId: n } = e;
                      if (null !== n) {
                        if (((n = n.toLowerCase()), k.has(n))) {
                          return o.DOCUMENT_MODE.QUIRKS;
                        }
                        let e = null === t ? _ : I;
                        if (y(n, e)) {
                          return o.DOCUMENT_MODE.QUIRKS;
                        }
                        if (y(n, (e = null === t ? D : b))) {
                          return o.DOCUMENT_MODE.LIMITED_QUIRKS;
                        }
                      }
                      return o.DOCUMENT_MODE.NO_QUIRKS;
                    })(t);
                ((t.name !== E ||
                  null !== t.publicId ||
                  (null !== t.systemId && "about:legacy-compat" !== t.systemId)) &&
                  e._err(t, S.s.nonConformingDoctype),
                  e.treeAdapter.setDocumentMode(e.document, n),
                  (e.insertionMode = i.BEFORE_HTML));
              })(this, e);
              break;
            case i.BEFORE_HEAD:
            case i.IN_HEAD:
            case i.IN_HEAD_NO_SCRIPT:
            case i.AFTER_HEAD:
              this._err(e, S.s.misplacedDoctype);
              break;
            case i.IN_TABLE_TEXT:
              es(this, e);
          }
        }
        onStartTag(e) {
          ((this.skipNextNewLine = !1),
            (this.currentToken = e),
            this._processStartTag(e),
            e.selfClosing &&
              !e.ackSelfClosing &&
              this._err(e, S.s.nonVoidHtmlElementStartTagWithTrailingSolidus));
        }
        _processStartTag(e) {
          this.shouldProcessStartTagTokenInForeignContent(e)
            ? (function (e, t) {
                if (N.ly(t)) {
                  (ek(e), e._startTagOutsideForeignContent(t));
                } else {
                  let n = e._getAdjustedCurrentElement(),
                    r = e.treeAdapter.getNamespaceURI(n);
                  (r === o.NS.MATHML ? N.yY(t) : r === o.NS.SVG && (N._j(t), N.pc(t)),
                    N.aq(t),
                    t.selfClosing ? e._appendElement(t, r) : e._insertElement(t, r),
                    (t.ackSelfClosing = !0));
                }
              })(this, e)
            : this._startTagOutsideForeignContent(e);
        }
        _startTagOutsideForeignContent(e) {
          switch (this.insertionMode) {
            case i.INITIAL:
              w(this, e);
              break;
            case i.BEFORE_HTML:
              ((t = this),
                (n = e).tagID === o.TAG_ID.HTML
                  ? (t._insertElement(n, o.NS.HTML), (t.insertionMode = i.BEFORE_HEAD))
                  : F(t, n));
              break;
            case i.BEFORE_HEAD:
              var t,
                n,
                r,
                a,
                l,
                s,
                c = this,
                u = e;
              switch (u.tagID) {
                case o.TAG_ID.HTML:
                  J(c, u);
                  break;
                case o.TAG_ID.HEAD:
                  (c._insertElement(u, o.NS.HTML),
                    (c.headElement = c.openElements.current),
                    (c.insertionMode = i.IN_HEAD));
                  break;
                default:
                  H(c, u);
              }
              break;
            case i.IN_HEAD:
              B(this, e);
              break;
            case i.IN_HEAD_NO_SCRIPT:
              var d = this,
                p = e;
              switch (p.tagID) {
                case o.TAG_ID.HTML:
                  J(d, p);
                  break;
                case o.TAG_ID.BASEFONT:
                case o.TAG_ID.BGSOUND:
                case o.TAG_ID.HEAD:
                case o.TAG_ID.LINK:
                case o.TAG_ID.META:
                case o.TAG_ID.NOFRAMES:
                case o.TAG_ID.STYLE:
                  B(d, p);
                  break;
                case o.TAG_ID.NOSCRIPT:
                  d._err(p, S.s.nestedNoscriptInHead);
                  break;
                default:
                  z(d, p);
              }
              break;
            case i.AFTER_HEAD:
              var h = this,
                f = e;
              switch (f.tagID) {
                case o.TAG_ID.HTML:
                  J(h, f);
                  break;
                case o.TAG_ID.BODY:
                  (h._insertElement(f, o.NS.HTML),
                    (h.framesetOk = !1),
                    (h.insertionMode = i.IN_BODY));
                  break;
                case o.TAG_ID.FRAMESET:
                  (h._insertElement(f, o.NS.HTML), (h.insertionMode = i.IN_FRAMESET));
                  break;
                case o.TAG_ID.BASE:
                case o.TAG_ID.BASEFONT:
                case o.TAG_ID.BGSOUND:
                case o.TAG_ID.LINK:
                case o.TAG_ID.META:
                case o.TAG_ID.NOFRAMES:
                case o.TAG_ID.SCRIPT:
                case o.TAG_ID.STYLE:
                case o.TAG_ID.TEMPLATE:
                case o.TAG_ID.TITLE:
                  (h._err(f, S.s.abandonedHeadElementChild),
                    h.openElements.push(h.headElement, o.TAG_ID.HEAD),
                    B(h, f),
                    h.openElements.remove(h.headElement));
                  break;
                case o.TAG_ID.HEAD:
                  h._err(f, S.s.misplacedStartTagForHeadElement);
                  break;
                default:
                  W(h, f);
              }
              break;
            case i.IN_BODY:
              J(this, e);
              break;
            case i.IN_TABLE:
              er(this, e);
              break;
            case i.IN_TABLE_TEXT:
              es(this, e);
              break;
            case i.IN_CAPTION:
              var m = this,
                T = e;
              let g = T.tagID;
              ec.has(g)
                ? m.openElements.hasInTableScope(o.TAG_ID.CAPTION) &&
                  (m.openElements.generateImpliedEndTags(),
                  m.openElements.popUntilTagNamePopped(o.TAG_ID.CAPTION),
                  m.activeFormattingElements.clearToLastMarker(),
                  (m.insertionMode = i.IN_TABLE),
                  er(m, T))
                : J(m, T);
              break;
            case i.IN_COLUMN_GROUP:
              eu(this, e);
              break;
            case i.IN_TABLE_BODY:
              ep(this, e);
              break;
            case i.IN_ROW:
              ef(this, e);
              break;
            case i.IN_CELL:
              var A = this,
                E = e;
              let I = E.tagID;
              ec.has(I)
                ? (A.openElements.hasInTableScope(o.TAG_ID.TD) ||
                    A.openElements.hasInTableScope(o.TAG_ID.TH)) &&
                  (A._closeTableCell(), ef(A, E))
                : J(A, E);
              break;
            case i.IN_SELECT:
              eT(this, e);
              break;
            case i.IN_SELECT_IN_TABLE:
              var _ = this,
                k = e;
              let D = k.tagID;
              D === o.TAG_ID.CAPTION ||
              D === o.TAG_ID.TABLE ||
              D === o.TAG_ID.TBODY ||
              D === o.TAG_ID.TFOOT ||
              D === o.TAG_ID.THEAD ||
              D === o.TAG_ID.TR ||
              D === o.TAG_ID.TD ||
              D === o.TAG_ID.TH
                ? (_.openElements.popUntilTagNamePopped(o.TAG_ID.SELECT),
                  _._resetInsertionMode(),
                  _._processStartTag(k))
                : eT(_, k);
              break;
            case i.IN_TEMPLATE:
              var b = this,
                y = e;
              switch (y.tagID) {
                case o.TAG_ID.BASE:
                case o.TAG_ID.BASEFONT:
                case o.TAG_ID.BGSOUND:
                case o.TAG_ID.LINK:
                case o.TAG_ID.META:
                case o.TAG_ID.NOFRAMES:
                case o.TAG_ID.SCRIPT:
                case o.TAG_ID.STYLE:
                case o.TAG_ID.TEMPLATE:
                case o.TAG_ID.TITLE:
                  B(b, y);
                  break;
                case o.TAG_ID.CAPTION:
                case o.TAG_ID.COLGROUP:
                case o.TAG_ID.TBODY:
                case o.TAG_ID.TFOOT:
                case o.TAG_ID.THEAD:
                  ((b.tmplInsertionModeStack[0] = i.IN_TABLE),
                    (b.insertionMode = i.IN_TABLE),
                    er(b, y));
                  break;
                case o.TAG_ID.COL:
                  ((b.tmplInsertionModeStack[0] = i.IN_COLUMN_GROUP),
                    (b.insertionMode = i.IN_COLUMN_GROUP),
                    eu(b, y));
                  break;
                case o.TAG_ID.TR:
                  ((b.tmplInsertionModeStack[0] = i.IN_TABLE_BODY),
                    (b.insertionMode = i.IN_TABLE_BODY),
                    ep(b, y));
                  break;
                case o.TAG_ID.TD:
                case o.TAG_ID.TH:
                  ((b.tmplInsertionModeStack[0] = i.IN_ROW),
                    (b.insertionMode = i.IN_ROW),
                    ef(b, y));
                  break;
                default:
                  ((b.tmplInsertionModeStack[0] = i.IN_BODY),
                    (b.insertionMode = i.IN_BODY),
                    J(b, y));
              }
              break;
            case i.AFTER_BODY:
              ((r = this), (a = e).tagID === o.TAG_ID.HTML ? J(r, a) : eI(r, a));
              break;
            case i.IN_FRAMESET:
              var N = this,
                C = e;
              switch (C.tagID) {
                case o.TAG_ID.HTML:
                  J(N, C);
                  break;
                case o.TAG_ID.FRAMESET:
                  N._insertElement(C, o.NS.HTML);
                  break;
                case o.TAG_ID.FRAME:
                  (N._appendElement(C, o.NS.HTML), (C.ackSelfClosing = !0));
                  break;
                case o.TAG_ID.NOFRAMES:
                  B(N, C);
              }
              break;
            case i.AFTER_FRAMESET:
              var x = this,
                L = e;
              switch (L.tagID) {
                case o.TAG_ID.HTML:
                  J(x, L);
                  break;
                case o.TAG_ID.NOFRAMES:
                  B(x, L);
              }
              break;
            case i.AFTER_AFTER_BODY:
              ((l = this), (s = e).tagID === o.TAG_ID.HTML ? J(l, s) : e_(l, s));
              break;
            case i.AFTER_AFTER_FRAMESET:
              var v = this,
                G = e;
              switch (G.tagID) {
                case o.TAG_ID.HTML:
                  J(v, G);
                  break;
                case o.TAG_ID.NOFRAMES:
                  B(v, G);
              }
          }
        }
        onEndTag(e) {
          ((this.skipNextNewLine = !1),
            (this.currentToken = e),
            this.currentNotInHTML
              ? (function (e, t) {
                  if (t.tagID === o.TAG_ID.P || t.tagID === o.TAG_ID.BR) {
                    (ek(e), e._endTagOutsideForeignContent(t));
                    return;
                  }
                  for (let n = e.openElements.stackTop; n > 0; n--) {
                    let r = e.openElements.items[n];
                    if (e.treeAdapter.getNamespaceURI(r) === o.NS.HTML) {
                      e._endTagOutsideForeignContent(t);
                      break;
                    }
                    let i = e.treeAdapter.getTagName(r);
                    if (i.toLowerCase() === t.tagName) {
                      ((t.tagName = i), e.openElements.shortenToLength(n));
                      break;
                    }
                  }
                })(this, e)
              : this._endTagOutsideForeignContent(e));
        }
        _endTagOutsideForeignContent(e) {
          switch (this.insertionMode) {
            case i.INITIAL:
              w(this, e);
              break;
            case i.BEFORE_HTML:
              var t,
                n,
                r,
                a,
                l,
                s,
                c = this,
                u = e;
              let d = u.tagID;
              (d === o.TAG_ID.HTML ||
                d === o.TAG_ID.HEAD ||
                d === o.TAG_ID.BODY ||
                d === o.TAG_ID.BR) &&
                F(c, u);
              break;
            case i.BEFORE_HEAD:
              var p = this,
                h = e;
              let f = h.tagID;
              f === o.TAG_ID.HEAD || f === o.TAG_ID.BODY || f === o.TAG_ID.HTML || f === o.TAG_ID.BR
                ? H(p, h)
                : p._err(h, S.s.endTagWithoutMatchingOpenElement);
              break;
            case i.IN_HEAD:
              var m = this,
                T = e;
              switch (T.tagID) {
                case o.TAG_ID.HEAD:
                  (m.openElements.pop(), (m.insertionMode = i.AFTER_HEAD));
                  break;
                case o.TAG_ID.BODY:
                case o.TAG_ID.BR:
                case o.TAG_ID.HTML:
                  q(m, T);
                  break;
                case o.TAG_ID.TEMPLATE:
                  U(m, T);
                  break;
                default:
                  m._err(T, S.s.endTagWithoutMatchingOpenElement);
              }
              break;
            case i.IN_HEAD_NO_SCRIPT:
              var g = this,
                A = e;
              switch (A.tagID) {
                case o.TAG_ID.NOSCRIPT:
                  (g.openElements.pop(), (g.insertionMode = i.IN_HEAD));
                  break;
                case o.TAG_ID.BR:
                  z(g, A);
                  break;
                default:
                  g._err(A, S.s.endTagWithoutMatchingOpenElement);
              }
              break;
            case i.AFTER_HEAD:
              var E = this,
                I = e;
              switch (I.tagID) {
                case o.TAG_ID.BODY:
                case o.TAG_ID.HTML:
                case o.TAG_ID.BR:
                  W(E, I);
                  break;
                case o.TAG_ID.TEMPLATE:
                  U(E, I);
                  break;
                default:
                  E._err(I, S.s.endTagWithoutMatchingOpenElement);
              }
              break;
            case i.IN_BODY:
              ee(this, e);
              break;
            case i.TEXT:
              ((t = this),
                e.tagID === o.TAG_ID.SCRIPT &&
                  (null == (n = t.scriptHandler) || n.call(t, t.openElements.current)),
                t.openElements.pop(),
                (t.insertionMode = t.originalInsertionMode));
              break;
            case i.IN_TABLE:
              ei(this, e);
              break;
            case i.IN_TABLE_TEXT:
              es(this, e);
              break;
            case i.IN_CAPTION:
              var _ = this,
                k = e;
              let D = k.tagID;
              switch (D) {
                case o.TAG_ID.CAPTION:
                case o.TAG_ID.TABLE:
                  _.openElements.hasInTableScope(o.TAG_ID.CAPTION) &&
                    (_.openElements.generateImpliedEndTags(),
                    _.openElements.popUntilTagNamePopped(o.TAG_ID.CAPTION),
                    _.activeFormattingElements.clearToLastMarker(),
                    (_.insertionMode = i.IN_TABLE),
                    D === o.TAG_ID.TABLE && ei(_, k));
                  break;
                case o.TAG_ID.BODY:
                case o.TAG_ID.COL:
                case o.TAG_ID.COLGROUP:
                case o.TAG_ID.HTML:
                case o.TAG_ID.TBODY:
                case o.TAG_ID.TD:
                case o.TAG_ID.TFOOT:
                case o.TAG_ID.TH:
                case o.TAG_ID.THEAD:
                case o.TAG_ID.TR:
                  break;
                default:
                  ee(_, k);
              }
              break;
            case i.IN_COLUMN_GROUP:
              var b = this,
                y = e;
              switch (y.tagID) {
                case o.TAG_ID.COLGROUP:
                  b.openElements.currentTagId === o.TAG_ID.COLGROUP &&
                    (b.openElements.pop(), (b.insertionMode = i.IN_TABLE));
                  break;
                case o.TAG_ID.TEMPLATE:
                  U(b, y);
                  break;
                case o.TAG_ID.COL:
                  break;
                default:
                  ed(b, y);
              }
              break;
            case i.IN_TABLE_BODY:
              eh(this, e);
              break;
            case i.IN_ROW:
              em(this, e);
              break;
            case i.IN_CELL:
              var N = this,
                C = e;
              let x = C.tagID;
              switch (x) {
                case o.TAG_ID.TD:
                case o.TAG_ID.TH:
                  N.openElements.hasInTableScope(x) &&
                    (N.openElements.generateImpliedEndTags(),
                    N.openElements.popUntilTagNamePopped(x),
                    N.activeFormattingElements.clearToLastMarker(),
                    (N.insertionMode = i.IN_ROW));
                  break;
                case o.TAG_ID.TABLE:
                case o.TAG_ID.TBODY:
                case o.TAG_ID.TFOOT:
                case o.TAG_ID.THEAD:
                case o.TAG_ID.TR:
                  N.openElements.hasInTableScope(x) && (N._closeTableCell(), em(N, C));
                  break;
                case o.TAG_ID.BODY:
                case o.TAG_ID.CAPTION:
                case o.TAG_ID.COL:
                case o.TAG_ID.COLGROUP:
                case o.TAG_ID.HTML:
                  break;
                default:
                  ee(N, C);
              }
              break;
            case i.IN_SELECT:
              eg(this, e);
              break;
            case i.IN_SELECT_IN_TABLE:
              var L = this,
                v = e;
              let G = v.tagID;
              G === o.TAG_ID.CAPTION ||
              G === o.TAG_ID.TABLE ||
              G === o.TAG_ID.TBODY ||
              G === o.TAG_ID.TFOOT ||
              G === o.TAG_ID.THEAD ||
              G === o.TAG_ID.TR ||
              G === o.TAG_ID.TD ||
              G === o.TAG_ID.TH
                ? L.openElements.hasInTableScope(G) &&
                  (L.openElements.popUntilTagNamePopped(o.TAG_ID.SELECT),
                  L._resetInsertionMode(),
                  L.onEndTag(v))
                : eg(L, v);
              break;
            case i.IN_TEMPLATE:
              ((r = this), (a = e).tagID === o.TAG_ID.TEMPLATE && U(r, a));
              break;
            case i.AFTER_BODY:
              eE(this, e);
              break;
            case i.IN_FRAMESET:
              ((l = this),
                e.tagID === o.TAG_ID.FRAMESET &&
                  !l.openElements.isRootHtmlElementCurrent() &&
                  (l.openElements.pop(),
                  l.fragmentContext ||
                    l.openElements.currentTagId === o.TAG_ID.FRAMESET ||
                    (l.insertionMode = i.AFTER_FRAMESET)));
              break;
            case i.AFTER_FRAMESET:
              ((s = this), e.tagID === o.TAG_ID.HTML && (s.insertionMode = i.AFTER_AFTER_FRAMESET));
              break;
            case i.AFTER_AFTER_BODY:
              e_(this, e);
          }
        }
        onEof(e) {
          switch (this.insertionMode) {
            case i.INITIAL:
              w(this, e);
              break;
            case i.BEFORE_HTML:
              F(this, e);
              break;
            case i.BEFORE_HEAD:
              H(this, e);
              break;
            case i.IN_HEAD:
              q(this, e);
              break;
            case i.IN_HEAD_NO_SCRIPT:
              z(this, e);
              break;
            case i.AFTER_HEAD:
              W(this, e);
              break;
            case i.IN_BODY:
            case i.IN_TABLE:
            case i.IN_CAPTION:
            case i.IN_COLUMN_GROUP:
            case i.IN_TABLE_BODY:
            case i.IN_ROW:
            case i.IN_CELL:
            case i.IN_SELECT:
            case i.IN_SELECT_IN_TABLE:
              et(this, e);
              break;
            case i.TEXT:
              var t, n;
              ((t = this),
                (n = e),
                t._err(n, S.s.eofInElementThatCanContainOnlyText),
                t.openElements.pop(),
                (t.insertionMode = t.originalInsertionMode),
                t.onEof(n));
              break;
            case i.IN_TABLE_TEXT:
              es(this, e);
              break;
            case i.IN_TEMPLATE:
              eA(this, e);
              break;
            case i.AFTER_BODY:
            case i.IN_FRAMESET:
            case i.AFTER_FRAMESET:
            case i.AFTER_AFTER_BODY:
            case i.AFTER_AFTER_FRAMESET:
              P(this, e);
          }
        }
        onWhitespaceCharacter(e) {
          if (
            this.skipNextNewLine &&
            ((this.skipNextNewLine = !1), e.chars.charCodeAt(0) === C.AM.LINE_FEED)
          ) {
            if (1 === e.chars.length) {
              return;
            }
            e.chars = e.chars.substr(1);
          }
          if (this.tokenizer.inForeignNode) {
            return this._insertCharacters(e);
          }
          switch (this.insertionMode) {
            case i.IN_HEAD:
            case i.IN_HEAD_NO_SCRIPT:
            case i.AFTER_HEAD:
            case i.TEXT:
            case i.IN_COLUMN_GROUP:
            case i.IN_SELECT:
            case i.IN_SELECT_IN_TABLE:
            case i.IN_FRAMESET:
            case i.AFTER_FRAMESET:
              this._insertCharacters(e);
              break;
            case i.IN_BODY:
            case i.IN_CAPTION:
            case i.IN_CELL:
            case i.IN_TEMPLATE:
            case i.AFTER_BODY:
            case i.AFTER_AFTER_BODY:
            case i.AFTER_AFTER_FRAMESET:
              Y(this, e);
              break;
            case i.IN_TABLE:
            case i.IN_TABLE_BODY:
            case i.IN_ROW:
              en(this, e);
              break;
            case i.IN_TABLE_TEXT:
              eo(this, e);
          }
        }
      }
      function M(e, t) {
        for (let n = 0; n < 8; n++) {
          let n = (function (e, t) {
            let n = e.activeFormattingElements.getElementEntryInScopeWithTagName(t.tagName);
            return (
              n
                ? e.openElements.contains(n.element)
                  ? e.openElements.hasInScope(t.tagID) || (n = null)
                  : (e.activeFormattingElements.removeEntry(n), (n = null))
                : Z(e, t),
              n
            );
          })(e, t);
          if (!n) {
            break;
          }
          let r = (function (e, t) {
            let n = null,
              r = e.openElements.stackTop;
            for (; r >= 0; r--) {
              let i = e.openElements.items[r];
              if (i === t.element) {
                break;
              }
              e._isSpecialElement(i, e.openElements.tagIDs[r]) && (n = i);
            }
            return (
              n ||
                (e.openElements.shortenToLength(r < 0 ? 0 : r),
                e.activeFormattingElements.removeEntry(t)),
              n
            );
          })(e, n);
          if (!r) {
            break;
          }
          e.activeFormattingElements.bookmark = n;
          let i = (function (e, t, n) {
              let r = t,
                i = e.openElements.getCommonAncestor(t);
              for (let a = 0, o = i; o !== n; a++, o = i) {
                i = e.openElements.getCommonAncestor(o);
                let n = e.activeFormattingElements.getElementEntry(o),
                  l = n && a >= 3;
                !n || l
                  ? (l && e.activeFormattingElements.removeEntry(n), e.openElements.remove(o))
                  : ((o = (function (e, t) {
                      let n = e.treeAdapter.getNamespaceURI(t.element),
                        r = e.treeAdapter.createElement(t.token.tagName, n, t.token.attrs);
                      return (e.openElements.replace(t.element, r), (t.element = r), r);
                    })(e, n)),
                    r === t && (e.activeFormattingElements.bookmark = n),
                    e.treeAdapter.detachNode(r),
                    e.treeAdapter.appendChild(o, r),
                    (r = o));
              }
              return r;
            })(e, r, n.element),
            a = e.openElements.getCommonAncestor(n.element);
          (e.treeAdapter.detachNode(i),
            a &&
              (function (e, t, n) {
                let r = e.treeAdapter.getTagName(t),
                  i = (0, o.getTagID)(r);
                if (e._isElementCausesFosterParenting(i)) {
                  e._fosterParentElement(n);
                } else {
                  let r = e.treeAdapter.getNamespaceURI(t);
                  (i === o.TAG_ID.TEMPLATE &&
                    r === o.NS.HTML &&
                    (t = e.treeAdapter.getTemplateContent(t)),
                    e.treeAdapter.appendChild(t, n));
                }
              })(e, a, i));
          let l = e.treeAdapter.getNamespaceURI(n.element),
            { token: s } = n,
            c = e.treeAdapter.createElement(s.tagName, l, s.attrs);
          (e._adoptNodes(r, c),
            e.treeAdapter.appendChild(r, c),
            e.activeFormattingElements.insertElementAfterBookmark(c, s),
            e.activeFormattingElements.removeEntry(n),
            e.openElements.remove(n.element),
            e.openElements.insertAfter(r, c, s.tagID));
        }
      }
      function R(e, t) {
        e._appendCommentNode(t, e.openElements.currentTmplContentOrNode);
      }
      function P(e, t) {
        if (((e.stopped = !0), t.location)) {
          let n = 2 * !e.fragmentContext;
          for (let r = e.openElements.stackTop; r >= n; r--) {
            e._setEndLocation(e.openElements.items[r], t);
          }
          if (!e.fragmentContext && e.openElements.stackTop >= 0) {
            let n = e.openElements.items[0],
              r = e.treeAdapter.getNodeSourceCodeLocation(n);
            if (r && !r.endTag && (e._setEndLocation(n, t), e.openElements.stackTop >= 1)) {
              let n = e.openElements.items[1],
                r = e.treeAdapter.getNodeSourceCodeLocation(n);
              r && !r.endTag && e._setEndLocation(n, t);
            }
          }
        }
      }
      function w(e, t) {
        (e._err(t, S.s.missingDoctype, !0),
          e.treeAdapter.setDocumentMode(e.document, o.DOCUMENT_MODE.QUIRKS),
          (e.insertionMode = i.BEFORE_HTML),
          e._processToken(t));
      }
      function F(e, t) {
        (e._insertFakeRootElement(), (e.insertionMode = i.BEFORE_HEAD), e._processToken(t));
      }
      function H(e, t) {
        (e._insertFakeElement(o.TAG_NAMES.HEAD, o.TAG_ID.HEAD),
          (e.headElement = e.openElements.current),
          (e.insertionMode = i.IN_HEAD),
          e._processToken(t));
      }
      function B(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.HTML:
            J(e, t);
            break;
          case o.TAG_ID.BASE:
          case o.TAG_ID.BASEFONT:
          case o.TAG_ID.BGSOUND:
          case o.TAG_ID.LINK:
          case o.TAG_ID.META:
            (e._appendElement(t, o.NS.HTML), (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.TITLE:
            e._switchToTextParsing(t, a.V.RCDATA);
            break;
          case o.TAG_ID.NOSCRIPT:
            e.options.scriptingEnabled
              ? e._switchToTextParsing(t, a.V.RAWTEXT)
              : (e._insertElement(t, o.NS.HTML), (e.insertionMode = i.IN_HEAD_NO_SCRIPT));
            break;
          case o.TAG_ID.NOFRAMES:
          case o.TAG_ID.STYLE:
            e._switchToTextParsing(t, a.V.RAWTEXT);
            break;
          case o.TAG_ID.SCRIPT:
            e._switchToTextParsing(t, a.V.SCRIPT_DATA);
            break;
          case o.TAG_ID.TEMPLATE:
            (e._insertTemplate(t),
              e.activeFormattingElements.insertMarker(),
              (e.framesetOk = !1),
              (e.insertionMode = i.IN_TEMPLATE),
              e.tmplInsertionModeStack.unshift(i.IN_TEMPLATE));
            break;
          case o.TAG_ID.HEAD:
            e._err(t, S.s.misplacedStartTagForHeadElement);
            break;
          default:
            q(e, t);
        }
      }
      function U(e, t) {
        e.openElements.tmplCount > 0
          ? (e.openElements.generateImpliedEndTagsThoroughly(),
            e.openElements.currentTagId !== o.TAG_ID.TEMPLATE &&
              e._err(t, S.s.closingOfElementWithOpenChildElements),
            e.openElements.popUntilTagNamePopped(o.TAG_ID.TEMPLATE),
            e.activeFormattingElements.clearToLastMarker(),
            e.tmplInsertionModeStack.shift(),
            e._resetInsertionMode())
          : e._err(t, S.s.endTagWithoutMatchingOpenElement);
      }
      function q(e, t) {
        (e.openElements.pop(), (e.insertionMode = i.AFTER_HEAD), e._processToken(t));
      }
      function z(e, t) {
        let n =
          t.type === x.k.EOF ? S.s.openElementsLeftAfterEof : S.s.disallowedContentInNoscriptInHead;
        (e._err(t, n), e.openElements.pop(), (e.insertionMode = i.IN_HEAD), e._processToken(t));
      }
      function W(e, t) {
        (e._insertFakeElement(o.TAG_NAMES.BODY, o.TAG_ID.BODY),
          (e.insertionMode = i.IN_BODY),
          V(e, t));
      }
      function V(e, t) {
        switch (t.type) {
          case x.k.CHARACTER:
            j(e, t);
            break;
          case x.k.WHITESPACE_CHARACTER:
            Y(e, t);
            break;
          case x.k.COMMENT:
            R(e, t);
            break;
          case x.k.START_TAG:
            J(e, t);
            break;
          case x.k.END_TAG:
            ee(e, t);
            break;
          case x.k.EOF:
            et(e, t);
        }
      }
      function Y(e, t) {
        (e._reconstructActiveFormattingElements(), e._insertCharacters(t));
      }
      function j(e, t) {
        (e._reconstructActiveFormattingElements(), e._insertCharacters(t), (e.framesetOk = !1));
      }
      function X(e, t) {
        (e._reconstructActiveFormattingElements(),
          e._appendElement(t, o.NS.HTML),
          (e.framesetOk = !1),
          (t.ackSelfClosing = !0));
      }
      function K(e) {
        let t = (0, x.r)(e, o.ATTRS.TYPE);
        return null != t && "hidden" === t.toLowerCase();
      }
      function Q(e, t) {
        e._switchToTextParsing(t, a.V.RAWTEXT);
      }
      function $(e, t) {
        (e._reconstructActiveFormattingElements(), e._insertElement(t, o.NS.HTML));
      }
      function J(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.I:
          case o.TAG_ID.S:
          case o.TAG_ID.B:
          case o.TAG_ID.U:
          case o.TAG_ID.EM:
          case o.TAG_ID.TT:
          case o.TAG_ID.BIG:
          case o.TAG_ID.CODE:
          case o.TAG_ID.FONT:
          case o.TAG_ID.SMALL:
          case o.TAG_ID.STRIKE:
          case o.TAG_ID.STRONG:
            (e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML),
              e.activeFormattingElements.pushElement(e.openElements.current, t));
            break;
          case o.TAG_ID.A:
            let n = e.activeFormattingElements.getElementEntryInScopeWithTagName(o.TAG_NAMES.A);
            (n &&
              (M(e, t),
              e.openElements.remove(n.element),
              e.activeFormattingElements.removeEntry(n)),
              e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML),
              e.activeFormattingElements.pushElement(e.openElements.current, t));
            break;
          case o.TAG_ID.H1:
          case o.TAG_ID.H2:
          case o.TAG_ID.H3:
          case o.TAG_ID.H4:
          case o.TAG_ID.H5:
          case o.TAG_ID.H6:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              (0, o.isNumberedHeader)(e.openElements.currentTagId) && e.openElements.pop(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.P:
          case o.TAG_ID.DL:
          case o.TAG_ID.OL:
          case o.TAG_ID.UL:
          case o.TAG_ID.DIV:
          case o.TAG_ID.DIR:
          case o.TAG_ID.NAV:
          case o.TAG_ID.MAIN:
          case o.TAG_ID.MENU:
          case o.TAG_ID.ASIDE:
          case o.TAG_ID.CENTER:
          case o.TAG_ID.FIGURE:
          case o.TAG_ID.FOOTER:
          case o.TAG_ID.HEADER:
          case o.TAG_ID.HGROUP:
          case o.TAG_ID.DIALOG:
          case o.TAG_ID.DETAILS:
          case o.TAG_ID.ADDRESS:
          case o.TAG_ID.ARTICLE:
          case o.TAG_ID.SECTION:
          case o.TAG_ID.SUMMARY:
          case o.TAG_ID.FIELDSET:
          case o.TAG_ID.BLOCKQUOTE:
          case o.TAG_ID.FIGCAPTION:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.LI:
          case o.TAG_ID.DD:
          case o.TAG_ID.DT:
            e.framesetOk = !1;
            let r = t.tagID;
            for (let t = e.openElements.stackTop; t >= 0; t--) {
              let n = e.openElements.tagIDs[t];
              if (
                (r === o.TAG_ID.LI && n === o.TAG_ID.LI) ||
                ((r === o.TAG_ID.DD || r === o.TAG_ID.DT) &&
                  (n === o.TAG_ID.DD || n === o.TAG_ID.DT))
              ) {
                (e.openElements.generateImpliedEndTagsWithExclusion(n),
                  e.openElements.popUntilTagNamePopped(n));
                break;
              }
              if (
                n !== o.TAG_ID.ADDRESS &&
                n !== o.TAG_ID.DIV &&
                n !== o.TAG_ID.P &&
                e._isSpecialElement(e.openElements.items[t], n)
              ) {
                break;
              }
            }
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.BR:
          case o.TAG_ID.IMG:
          case o.TAG_ID.WBR:
          case o.TAG_ID.AREA:
          case o.TAG_ID.EMBED:
          case o.TAG_ID.KEYGEN:
            X(e, t);
            break;
          case o.TAG_ID.HR:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._appendElement(t, o.NS.HTML),
              (e.framesetOk = !1),
              (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.RB:
          case o.TAG_ID.RTC:
            (e.openElements.hasInScope(o.TAG_ID.RUBY) && e.openElements.generateImpliedEndTags(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.RT:
          case o.TAG_ID.RP:
            (e.openElements.hasInScope(o.TAG_ID.RUBY) &&
              e.openElements.generateImpliedEndTagsWithExclusion(o.TAG_ID.RTC),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.PRE:
          case o.TAG_ID.LISTING:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._insertElement(t, o.NS.HTML),
              (e.skipNextNewLine = !0),
              (e.framesetOk = !1));
            break;
          case o.TAG_ID.XMP:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._reconstructActiveFormattingElements(),
              (e.framesetOk = !1),
              e._switchToTextParsing(t, a.V.RAWTEXT));
            break;
          case o.TAG_ID.SVG:
            (e._reconstructActiveFormattingElements(),
              N.pc(t),
              N.aq(t),
              t.selfClosing ? e._appendElement(t, o.NS.SVG) : e._insertElement(t, o.NS.SVG),
              (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.HTML:
            0 === e.openElements.tmplCount &&
              e.treeAdapter.adoptAttributes(e.openElements.items[0], t.attrs);
            break;
          case o.TAG_ID.BASE:
          case o.TAG_ID.LINK:
          case o.TAG_ID.META:
          case o.TAG_ID.STYLE:
          case o.TAG_ID.TITLE:
          case o.TAG_ID.SCRIPT:
          case o.TAG_ID.BGSOUND:
          case o.TAG_ID.BASEFONT:
          case o.TAG_ID.TEMPLATE:
            B(e, t);
            break;
          case o.TAG_ID.BODY:
            let l = e.openElements.tryPeekProperlyNestedBodyElement();
            l &&
              0 === e.openElements.tmplCount &&
              ((e.framesetOk = !1), e.treeAdapter.adoptAttributes(l, t.attrs));
            break;
          case o.TAG_ID.FORM:
            let s = e.openElements.tmplCount > 0;
            (!e.formElement || s) &&
              (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._insertElement(t, o.NS.HTML),
              s || (e.formElement = e.openElements.current));
            break;
          case o.TAG_ID.NOBR:
            (e._reconstructActiveFormattingElements(),
              e.openElements.hasInScope(o.TAG_ID.NOBR) &&
                (M(e, t), e._reconstructActiveFormattingElements()),
              e._insertElement(t, o.NS.HTML),
              e.activeFormattingElements.pushElement(e.openElements.current, t));
            break;
          case o.TAG_ID.MATH:
            (e._reconstructActiveFormattingElements(),
              N.yY(t),
              N.aq(t),
              t.selfClosing ? e._appendElement(t, o.NS.MATHML) : e._insertElement(t, o.NS.MATHML),
              (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.TABLE:
            (e.treeAdapter.getDocumentMode(e.document) !== o.DOCUMENT_MODE.QUIRKS &&
              e.openElements.hasInButtonScope(o.TAG_ID.P) &&
              e._closePElement(),
              e._insertElement(t, o.NS.HTML),
              (e.framesetOk = !1),
              (e.insertionMode = i.IN_TABLE));
            break;
          case o.TAG_ID.INPUT:
            (e._reconstructActiveFormattingElements(),
              e._appendElement(t, o.NS.HTML),
              K(t) || (e.framesetOk = !1),
              (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.PARAM:
          case o.TAG_ID.TRACK:
          case o.TAG_ID.SOURCE:
            (e._appendElement(t, o.NS.HTML), (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.IMAGE:
            ((t.tagName = o.TAG_NAMES.IMG), (t.tagID = o.TAG_ID.IMG), X(e, t));
            break;
          case o.TAG_ID.BUTTON:
            (e.openElements.hasInScope(o.TAG_ID.BUTTON) &&
              (e.openElements.generateImpliedEndTags(),
              e.openElements.popUntilTagNamePopped(o.TAG_ID.BUTTON)),
              e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML),
              (e.framesetOk = !1));
            break;
          case o.TAG_ID.APPLET:
          case o.TAG_ID.OBJECT:
          case o.TAG_ID.MARQUEE:
            (e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML),
              e.activeFormattingElements.insertMarker(),
              (e.framesetOk = !1));
            break;
          case o.TAG_ID.IFRAME:
            ((e.framesetOk = !1), e._switchToTextParsing(t, a.V.RAWTEXT));
            break;
          case o.TAG_ID.SELECT:
            (e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML),
              (e.framesetOk = !1),
              (e.insertionMode =
                e.insertionMode === i.IN_TABLE ||
                e.insertionMode === i.IN_CAPTION ||
                e.insertionMode === i.IN_TABLE_BODY ||
                e.insertionMode === i.IN_ROW ||
                e.insertionMode === i.IN_CELL
                  ? i.IN_SELECT_IN_TABLE
                  : i.IN_SELECT));
            break;
          case o.TAG_ID.OPTION:
          case o.TAG_ID.OPTGROUP:
            (e.openElements.currentTagId === o.TAG_ID.OPTION && e.openElements.pop(),
              e._reconstructActiveFormattingElements(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.NOEMBED:
            Q(e, t);
            break;
          case o.TAG_ID.FRAMESET:
            let c = e.openElements.tryPeekProperlyNestedBodyElement();
            e.framesetOk &&
              c &&
              (e.treeAdapter.detachNode(c),
              e.openElements.popAllUpToHtmlElement(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_FRAMESET));
            break;
          case o.TAG_ID.TEXTAREA:
            (e._insertElement(t, o.NS.HTML),
              (e.skipNextNewLine = !0),
              (e.tokenizer.state = a.V.RCDATA),
              (e.originalInsertionMode = e.insertionMode),
              (e.framesetOk = !1),
              (e.insertionMode = i.TEXT));
            break;
          case o.TAG_ID.NOSCRIPT:
            e.options.scriptingEnabled ? Q(e, t) : $(e, t);
            break;
          case o.TAG_ID.PLAINTEXT:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) && e._closePElement(),
              e._insertElement(t, o.NS.HTML),
              (e.tokenizer.state = a.V.PLAINTEXT));
            break;
          case o.TAG_ID.COL:
          case o.TAG_ID.TH:
          case o.TAG_ID.TD:
          case o.TAG_ID.TR:
          case o.TAG_ID.HEAD:
          case o.TAG_ID.FRAME:
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COLGROUP:
            break;
          default:
            $(e, t);
        }
      }
      function Z(e, t) {
        let n = t.tagName,
          r = t.tagID;
        for (let t = e.openElements.stackTop; t > 0; t--) {
          let i = e.openElements.items[t],
            a = e.openElements.tagIDs[t];
          if (r === a && (r !== o.TAG_ID.UNKNOWN || e.treeAdapter.getTagName(i) === n)) {
            (e.openElements.generateImpliedEndTagsWithExclusion(r),
              e.openElements.stackTop >= t && e.openElements.shortenToLength(t));
            break;
          }
          if (e._isSpecialElement(i, a)) {
            break;
          }
        }
      }
      function ee(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.A:
          case o.TAG_ID.B:
          case o.TAG_ID.I:
          case o.TAG_ID.S:
          case o.TAG_ID.U:
          case o.TAG_ID.EM:
          case o.TAG_ID.TT:
          case o.TAG_ID.BIG:
          case o.TAG_ID.CODE:
          case o.TAG_ID.FONT:
          case o.TAG_ID.NOBR:
          case o.TAG_ID.SMALL:
          case o.TAG_ID.STRIKE:
          case o.TAG_ID.STRONG:
            M(e, t);
            break;
          case o.TAG_ID.P:
            (e.openElements.hasInButtonScope(o.TAG_ID.P) ||
              e._insertFakeElement(o.TAG_NAMES.P, o.TAG_ID.P),
              e._closePElement());
            break;
          case o.TAG_ID.DL:
          case o.TAG_ID.UL:
          case o.TAG_ID.OL:
          case o.TAG_ID.DIR:
          case o.TAG_ID.DIV:
          case o.TAG_ID.NAV:
          case o.TAG_ID.PRE:
          case o.TAG_ID.MAIN:
          case o.TAG_ID.MENU:
          case o.TAG_ID.ASIDE:
          case o.TAG_ID.BUTTON:
          case o.TAG_ID.CENTER:
          case o.TAG_ID.FIGURE:
          case o.TAG_ID.FOOTER:
          case o.TAG_ID.HEADER:
          case o.TAG_ID.HGROUP:
          case o.TAG_ID.DIALOG:
          case o.TAG_ID.ADDRESS:
          case o.TAG_ID.ARTICLE:
          case o.TAG_ID.DETAILS:
          case o.TAG_ID.SECTION:
          case o.TAG_ID.SUMMARY:
          case o.TAG_ID.LISTING:
          case o.TAG_ID.FIELDSET:
          case o.TAG_ID.BLOCKQUOTE:
          case o.TAG_ID.FIGCAPTION:
            let n = t.tagID;
            e.openElements.hasInScope(n) &&
              (e.openElements.generateImpliedEndTags(), e.openElements.popUntilTagNamePopped(n));
            break;
          case o.TAG_ID.LI:
            e.openElements.hasInListItemScope(o.TAG_ID.LI) &&
              (e.openElements.generateImpliedEndTagsWithExclusion(o.TAG_ID.LI),
              e.openElements.popUntilTagNamePopped(o.TAG_ID.LI));
            break;
          case o.TAG_ID.DD:
          case o.TAG_ID.DT:
            let r = t.tagID;
            e.openElements.hasInScope(r) &&
              (e.openElements.generateImpliedEndTagsWithExclusion(r),
              e.openElements.popUntilTagNamePopped(r));
            break;
          case o.TAG_ID.H1:
          case o.TAG_ID.H2:
          case o.TAG_ID.H3:
          case o.TAG_ID.H4:
          case o.TAG_ID.H5:
          case o.TAG_ID.H6:
            e.openElements.hasNumberedHeaderInScope() &&
              (e.openElements.generateImpliedEndTags(),
              e.openElements.popUntilNumberedHeaderPopped());
            break;
          case o.TAG_ID.BR:
            (e._reconstructActiveFormattingElements(),
              e._insertFakeElement(o.TAG_NAMES.BR, o.TAG_ID.BR),
              e.openElements.pop(),
              (e.framesetOk = !1));
            break;
          case o.TAG_ID.BODY:
            if (
              e.openElements.hasInScope(o.TAG_ID.BODY) &&
              ((e.insertionMode = i.AFTER_BODY), e.options.sourceCodeLocationInfo)
            ) {
              let n = e.openElements.tryPeekProperlyNestedBodyElement();
              n && e._setEndLocation(n, t);
            }
            break;
          case o.TAG_ID.HTML:
            e.openElements.hasInScope(o.TAG_ID.BODY) &&
              ((e.insertionMode = i.AFTER_BODY), eE(e, t));
            break;
          case o.TAG_ID.FORM:
            let a = e.openElements.tmplCount > 0,
              { formElement: l } = e;
            (a || (e.formElement = null),
              (l || a) &&
                e.openElements.hasInScope(o.TAG_ID.FORM) &&
                (e.openElements.generateImpliedEndTags(),
                a
                  ? e.openElements.popUntilTagNamePopped(o.TAG_ID.FORM)
                  : l && e.openElements.remove(l)));
            break;
          case o.TAG_ID.APPLET:
          case o.TAG_ID.OBJECT:
          case o.TAG_ID.MARQUEE:
            let s = t.tagID;
            e.openElements.hasInScope(s) &&
              (e.openElements.generateImpliedEndTags(),
              e.openElements.popUntilTagNamePopped(s),
              e.activeFormattingElements.clearToLastMarker());
            break;
          case o.TAG_ID.TEMPLATE:
            U(e, t);
            break;
          default:
            Z(e, t);
        }
      }
      function et(e, t) {
        e.tmplInsertionModeStack.length > 0 ? eA(e, t) : P(e, t);
      }
      function en(e, t) {
        if (v.has(e.openElements.currentTagId)) {
          switch (
            ((e.pendingCharacterTokens.length = 0),
            (e.hasNonWhitespacePendingCharacterToken = !1),
            (e.originalInsertionMode = e.insertionMode),
            (e.insertionMode = i.IN_TABLE_TEXT),
            t.type)
          ) {
            case x.k.CHARACTER:
              el(e, t);
              break;
            case x.k.WHITESPACE_CHARACTER:
              eo(e, t);
          }
        } else {
          ea(e, t);
        }
      }
      function er(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.TD:
          case o.TAG_ID.TH:
          case o.TAG_ID.TR:
            (e.openElements.clearBackToTableContext(),
              e._insertFakeElement(o.TAG_NAMES.TBODY, o.TAG_ID.TBODY),
              (e.insertionMode = i.IN_TABLE_BODY),
              ep(e, t));
            break;
          case o.TAG_ID.STYLE:
          case o.TAG_ID.SCRIPT:
          case o.TAG_ID.TEMPLATE:
            B(e, t);
            break;
          case o.TAG_ID.COL:
            (e.openElements.clearBackToTableContext(),
              e._insertFakeElement(o.TAG_NAMES.COLGROUP, o.TAG_ID.COLGROUP),
              (e.insertionMode = i.IN_COLUMN_GROUP),
              eu(e, t));
            break;
          case o.TAG_ID.FORM:
            e.formElement ||
              0 !== e.openElements.tmplCount ||
              (e._insertElement(t, o.NS.HTML),
              (e.formElement = e.openElements.current),
              e.openElements.pop());
            break;
          case o.TAG_ID.TABLE:
            e.openElements.hasInTableScope(o.TAG_ID.TABLE) &&
              (e.openElements.popUntilTagNamePopped(o.TAG_ID.TABLE),
              e._resetInsertionMode(),
              e._processStartTag(t));
            break;
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
            (e.openElements.clearBackToTableContext(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_TABLE_BODY));
            break;
          case o.TAG_ID.INPUT:
            (K(t) ? e._appendElement(t, o.NS.HTML) : ea(e, t), (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.CAPTION:
            (e.openElements.clearBackToTableContext(),
              e.activeFormattingElements.insertMarker(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_CAPTION));
            break;
          case o.TAG_ID.COLGROUP:
            (e.openElements.clearBackToTableContext(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_COLUMN_GROUP));
            break;
          default:
            ea(e, t);
        }
      }
      function ei(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.TABLE:
            e.openElements.hasInTableScope(o.TAG_ID.TABLE) &&
              (e.openElements.popUntilTagNamePopped(o.TAG_ID.TABLE), e._resetInsertionMode());
            break;
          case o.TAG_ID.TEMPLATE:
            U(e, t);
            break;
          case o.TAG_ID.BODY:
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COL:
          case o.TAG_ID.COLGROUP:
          case o.TAG_ID.HTML:
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TD:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.TH:
          case o.TAG_ID.THEAD:
          case o.TAG_ID.TR:
            break;
          default:
            ea(e, t);
        }
      }
      function ea(e, t) {
        let n = e.fosterParentingEnabled;
        ((e.fosterParentingEnabled = !0), V(e, t), (e.fosterParentingEnabled = n));
      }
      function eo(e, t) {
        e.pendingCharacterTokens.push(t);
      }
      function el(e, t) {
        (e.pendingCharacterTokens.push(t), (e.hasNonWhitespacePendingCharacterToken = !0));
      }
      function es(e, t) {
        let n = 0;
        if (e.hasNonWhitespacePendingCharacterToken) {
          for (; n < e.pendingCharacterTokens.length; n++) ea(e, e.pendingCharacterTokens[n]);
        } else {
          for (; n < e.pendingCharacterTokens.length; n++)
            e._insertCharacters(e.pendingCharacterTokens[n]);
        }
        ((e.insertionMode = e.originalInsertionMode), e._processToken(t));
      }
      let ec = new Set([
        o.TAG_ID.CAPTION,
        o.TAG_ID.COL,
        o.TAG_ID.COLGROUP,
        o.TAG_ID.TBODY,
        o.TAG_ID.TD,
        o.TAG_ID.TFOOT,
        o.TAG_ID.TH,
        o.TAG_ID.THEAD,
        o.TAG_ID.TR,
      ]);
      function eu(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.HTML:
            J(e, t);
            break;
          case o.TAG_ID.COL:
            (e._appendElement(t, o.NS.HTML), (t.ackSelfClosing = !0));
            break;
          case o.TAG_ID.TEMPLATE:
            B(e, t);
            break;
          default:
            ed(e, t);
        }
      }
      function ed(e, t) {
        e.openElements.currentTagId === o.TAG_ID.COLGROUP &&
          (e.openElements.pop(), (e.insertionMode = i.IN_TABLE), e._processToken(t));
      }
      function ep(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.TR:
            (e.openElements.clearBackToTableBodyContext(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_ROW));
            break;
          case o.TAG_ID.TH:
          case o.TAG_ID.TD:
            (e.openElements.clearBackToTableBodyContext(),
              e._insertFakeElement(o.TAG_NAMES.TR, o.TAG_ID.TR),
              (e.insertionMode = i.IN_ROW),
              ef(e, t));
            break;
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COL:
          case o.TAG_ID.COLGROUP:
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
            e.openElements.hasTableBodyContextInTableScope() &&
              (e.openElements.clearBackToTableBodyContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE),
              er(e, t));
            break;
          default:
            er(e, t);
        }
      }
      function eh(e, t) {
        let n = t.tagID;
        switch (t.tagID) {
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
            e.openElements.hasInTableScope(n) &&
              (e.openElements.clearBackToTableBodyContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE));
            break;
          case o.TAG_ID.TABLE:
            e.openElements.hasTableBodyContextInTableScope() &&
              (e.openElements.clearBackToTableBodyContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE),
              ei(e, t));
            break;
          case o.TAG_ID.BODY:
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COL:
          case o.TAG_ID.COLGROUP:
          case o.TAG_ID.HTML:
          case o.TAG_ID.TD:
          case o.TAG_ID.TH:
          case o.TAG_ID.TR:
            break;
          default:
            ei(e, t);
        }
      }
      function ef(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.TH:
          case o.TAG_ID.TD:
            (e.openElements.clearBackToTableRowContext(),
              e._insertElement(t, o.NS.HTML),
              (e.insertionMode = i.IN_CELL),
              e.activeFormattingElements.insertMarker());
            break;
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COL:
          case o.TAG_ID.COLGROUP:
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
          case o.TAG_ID.TR:
            e.openElements.hasInTableScope(o.TAG_ID.TR) &&
              (e.openElements.clearBackToTableRowContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE_BODY),
              ep(e, t));
            break;
          default:
            er(e, t);
        }
      }
      function em(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.TR:
            e.openElements.hasInTableScope(o.TAG_ID.TR) &&
              (e.openElements.clearBackToTableRowContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE_BODY));
            break;
          case o.TAG_ID.TABLE:
            e.openElements.hasInTableScope(o.TAG_ID.TR) &&
              (e.openElements.clearBackToTableRowContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE_BODY),
              eh(e, t));
            break;
          case o.TAG_ID.TBODY:
          case o.TAG_ID.TFOOT:
          case o.TAG_ID.THEAD:
            (e.openElements.hasInTableScope(t.tagID) ||
              e.openElements.hasInTableScope(o.TAG_ID.TR)) &&
              (e.openElements.clearBackToTableRowContext(),
              e.openElements.pop(),
              (e.insertionMode = i.IN_TABLE_BODY),
              eh(e, t));
            break;
          case o.TAG_ID.BODY:
          case o.TAG_ID.CAPTION:
          case o.TAG_ID.COL:
          case o.TAG_ID.COLGROUP:
          case o.TAG_ID.HTML:
          case o.TAG_ID.TD:
          case o.TAG_ID.TH:
            break;
          default:
            ei(e, t);
        }
      }
      function eT(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.HTML:
            J(e, t);
            break;
          case o.TAG_ID.OPTION:
            (e.openElements.currentTagId === o.TAG_ID.OPTION && e.openElements.pop(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.OPTGROUP:
            (e.openElements.currentTagId === o.TAG_ID.OPTION && e.openElements.pop(),
              e.openElements.currentTagId === o.TAG_ID.OPTGROUP && e.openElements.pop(),
              e._insertElement(t, o.NS.HTML));
            break;
          case o.TAG_ID.INPUT:
          case o.TAG_ID.KEYGEN:
          case o.TAG_ID.TEXTAREA:
          case o.TAG_ID.SELECT:
            e.openElements.hasInSelectScope(o.TAG_ID.SELECT) &&
              (e.openElements.popUntilTagNamePopped(o.TAG_ID.SELECT),
              e._resetInsertionMode(),
              t.tagID !== o.TAG_ID.SELECT && e._processStartTag(t));
            break;
          case o.TAG_ID.SCRIPT:
          case o.TAG_ID.TEMPLATE:
            B(e, t);
        }
      }
      function eg(e, t) {
        switch (t.tagID) {
          case o.TAG_ID.OPTGROUP:
            (e.openElements.stackTop > 0 &&
              e.openElements.currentTagId === o.TAG_ID.OPTION &&
              e.openElements.tagIDs[e.openElements.stackTop - 1] === o.TAG_ID.OPTGROUP &&
              e.openElements.pop(),
              e.openElements.currentTagId === o.TAG_ID.OPTGROUP && e.openElements.pop());
            break;
          case o.TAG_ID.OPTION:
            e.openElements.currentTagId === o.TAG_ID.OPTION && e.openElements.pop();
            break;
          case o.TAG_ID.SELECT:
            e.openElements.hasInSelectScope(o.TAG_ID.SELECT) &&
              (e.openElements.popUntilTagNamePopped(o.TAG_ID.SELECT), e._resetInsertionMode());
            break;
          case o.TAG_ID.TEMPLATE:
            U(e, t);
        }
      }
      function eA(e, t) {
        e.openElements.tmplCount > 0
          ? (e.openElements.popUntilTagNamePopped(o.TAG_ID.TEMPLATE),
            e.activeFormattingElements.clearToLastMarker(),
            e.tmplInsertionModeStack.shift(),
            e._resetInsertionMode(),
            e.onEof(t))
          : P(e, t);
      }
      function eE(e, t) {
        var n;
        if (t.tagID === o.TAG_ID.HTML) {
          if (
            (e.fragmentContext || (e.insertionMode = i.AFTER_AFTER_BODY),
            e.options.sourceCodeLocationInfo && e.openElements.tagIDs[0] === o.TAG_ID.HTML)
          ) {
            e._setEndLocation(e.openElements.items[0], t);
            let r = e.openElements.items[1];
            !r ||
              (null == (n = e.treeAdapter.getNodeSourceCodeLocation(r)) ? void 0 : n.endTag) ||
              e._setEndLocation(r, t);
          }
        } else {
          eI(e, t);
        }
      }
      function eI(e, t) {
        ((e.insertionMode = i.IN_BODY), V(e, t));
      }
      function e_(e, t) {
        ((e.insertionMode = i.IN_BODY), V(e, t));
      }
      function ek(e) {
        for (
          ;
          e.treeAdapter.getNamespaceURI(e.openElements.current) !== o.NS.HTML &&
          !e._isIntegrationPoint(e.openElements.currentTagId, e.openElements.current);
        ) {
          e.openElements.pop();
        }
      }
    },
    45579: (e, t, n) => {
      "use strict";
      n.d(t, { qy: () => A, JW: () => E });
      class r {
        constructor(e, t, n) {
          ((this.property = e), (this.normal = t), n && (this.space = n));
        }
      }
      function i(e, t) {
        let n = {},
          i = {},
          a = -1;
        for (; ++a < e.length; ) {
          (Object.assign(n, e[a].property), Object.assign(i, e[a].normal));
        }
        return new r(n, i, t);
      }
      ((r.prototype.property = {}), (r.prototype.normal = {}), (r.prototype.space = null));
      var a = n(31109),
        o = n(15159);
      let l = {}.hasOwnProperty;
      function s(e) {
        let t,
          n = {},
          i = {};
        for (t in e.properties) {
          if (l.call(e.properties, t)) {
            let r = e.properties[t],
              l = new o.E(t, e.transform(e.attributes || {}, t), r, e.space);
            (e.mustUseProperty && e.mustUseProperty.includes(t) && (l.mustUseProperty = !0),
              (n[t] = l),
              (i[(0, a.S)(t)] = t),
              (i[(0, a.S)(l.attribute)] = t));
          }
        }
        return new r(n, i, e.space);
      }
      let c = s({
          space: "xlink",
          transform: (e, t) => "xlink:" + t.slice(5).toLowerCase(),
          properties: {
            xLinkActuate: null,
            xLinkArcRole: null,
            xLinkHref: null,
            xLinkRole: null,
            xLinkShow: null,
            xLinkTitle: null,
            xLinkType: null,
          },
        }),
        u = s({
          space: "xml",
          transform: (e, t) => "xml:" + t.slice(3).toLowerCase(),
          properties: { xmlLang: null, xmlBase: null, xmlSpace: null },
        });
      function d(e, t) {
        return t in e ? e[t] : t;
      }
      function p(e, t) {
        return d(e, t.toLowerCase());
      }
      let h = s({
        space: "xmlns",
        attributes: { xmlnsxlink: "xmlns:xlink" },
        transform: p,
        properties: { xmlns: null, xmlnsXLink: null },
      });
      var f = n(49828);
      let m = s({
          transform: (e, t) => ("role" === t ? t : "aria-" + t.slice(4).toLowerCase()),
          properties: {
            ariaActiveDescendant: null,
            ariaAtomic: f.booleanish,
            ariaAutoComplete: null,
            ariaBusy: f.booleanish,
            ariaChecked: f.booleanish,
            ariaColCount: f.number,
            ariaColIndex: f.number,
            ariaColSpan: f.number,
            ariaControls: f.spaceSeparated,
            ariaCurrent: null,
            ariaDescribedBy: f.spaceSeparated,
            ariaDetails: null,
            ariaDisabled: f.booleanish,
            ariaDropEffect: f.spaceSeparated,
            ariaErrorMessage: null,
            ariaExpanded: f.booleanish,
            ariaFlowTo: f.spaceSeparated,
            ariaGrabbed: f.booleanish,
            ariaHasPopup: null,
            ariaHidden: f.booleanish,
            ariaInvalid: null,
            ariaKeyShortcuts: null,
            ariaLabel: null,
            ariaLabelledBy: f.spaceSeparated,
            ariaLevel: f.number,
            ariaLive: null,
            ariaModal: f.booleanish,
            ariaMultiLine: f.booleanish,
            ariaMultiSelectable: f.booleanish,
            ariaOrientation: null,
            ariaOwns: f.spaceSeparated,
            ariaPlaceholder: null,
            ariaPosInSet: f.number,
            ariaPressed: f.booleanish,
            ariaReadOnly: f.booleanish,
            ariaRelevant: null,
            ariaRequired: f.booleanish,
            ariaRoleDescription: f.spaceSeparated,
            ariaRowCount: f.number,
            ariaRowIndex: f.number,
            ariaRowSpan: f.number,
            ariaSelected: f.booleanish,
            ariaSetSize: f.number,
            ariaSort: null,
            ariaValueMax: f.number,
            ariaValueMin: f.number,
            ariaValueNow: f.number,
            ariaValueText: null,
            role: null,
          },
        }),
        T = s({
          space: "html",
          attributes: {
            acceptcharset: "accept-charset",
            classname: "class",
            htmlfor: "for",
            httpequiv: "http-equiv",
          },
          transform: p,
          mustUseProperty: ["checked", "multiple", "muted", "selected"],
          properties: {
            abbr: null,
            accept: f.commaSeparated,
            acceptCharset: f.spaceSeparated,
            accessKey: f.spaceSeparated,
            action: null,
            allow: null,
            allowFullScreen: f.boolean,
            allowPaymentRequest: f.boolean,
            allowUserMedia: f.boolean,
            alt: null,
            as: null,
            async: f.boolean,
            autoCapitalize: null,
            autoComplete: f.spaceSeparated,
            autoFocus: f.boolean,
            autoPlay: f.boolean,
            capture: f.boolean,
            charSet: null,
            checked: f.boolean,
            cite: null,
            className: f.spaceSeparated,
            cols: f.number,
            colSpan: null,
            content: null,
            contentEditable: f.booleanish,
            controls: f.boolean,
            controlsList: f.spaceSeparated,
            coords: f.number | f.commaSeparated,
            crossOrigin: null,
            data: null,
            dateTime: null,
            decoding: null,
            default: f.boolean,
            defer: f.boolean,
            dir: null,
            dirName: null,
            disabled: f.boolean,
            download: f.overloadedBoolean,
            draggable: f.booleanish,
            encType: null,
            enterKeyHint: null,
            form: null,
            formAction: null,
            formEncType: null,
            formMethod: null,
            formNoValidate: f.boolean,
            formTarget: null,
            headers: f.spaceSeparated,
            height: f.number,
            hidden: f.boolean,
            high: f.number,
            href: null,
            hrefLang: null,
            htmlFor: f.spaceSeparated,
            httpEquiv: f.spaceSeparated,
            id: null,
            imageSizes: null,
            imageSrcSet: null,
            inputMode: null,
            integrity: null,
            is: null,
            isMap: f.boolean,
            itemId: null,
            itemProp: f.spaceSeparated,
            itemRef: f.spaceSeparated,
            itemScope: f.boolean,
            itemType: f.spaceSeparated,
            kind: null,
            label: null,
            lang: null,
            language: null,
            list: null,
            loading: null,
            loop: f.boolean,
            low: f.number,
            manifest: null,
            max: null,
            maxLength: f.number,
            media: null,
            method: null,
            min: null,
            minLength: f.number,
            multiple: f.boolean,
            muted: f.boolean,
            name: null,
            nonce: null,
            noModule: f.boolean,
            noValidate: f.boolean,
            onAbort: null,
            onAfterPrint: null,
            onAuxClick: null,
            onBeforeMatch: null,
            onBeforePrint: null,
            onBeforeUnload: null,
            onBlur: null,
            onCancel: null,
            onCanPlay: null,
            onCanPlayThrough: null,
            onChange: null,
            onClick: null,
            onClose: null,
            onContextLost: null,
            onContextMenu: null,
            onContextRestored: null,
            onCopy: null,
            onCueChange: null,
            onCut: null,
            onDblClick: null,
            onDrag: null,
            onDragEnd: null,
            onDragEnter: null,
            onDragExit: null,
            onDragLeave: null,
            onDragOver: null,
            onDragStart: null,
            onDrop: null,
            onDurationChange: null,
            onEmptied: null,
            onEnded: null,
            onError: null,
            onFocus: null,
            onFormData: null,
            onHashChange: null,
            onInput: null,
            onInvalid: null,
            onKeyDown: null,
            onKeyPress: null,
            onKeyUp: null,
            onLanguageChange: null,
            onLoad: null,
            onLoadedData: null,
            onLoadedMetadata: null,
            onLoadEnd: null,
            onLoadStart: null,
            onMessage: null,
            onMessageError: null,
            onMouseDown: null,
            onMouseEnter: null,
            onMouseLeave: null,
            onMouseMove: null,
            onMouseOut: null,
            onMouseOver: null,
            onMouseUp: null,
            onOffline: null,
            onOnline: null,
            onPageHide: null,
            onPageShow: null,
            onPaste: null,
            onPause: null,
            onPlay: null,
            onPlaying: null,
            onPopState: null,
            onProgress: null,
            onRateChange: null,
            onRejectionHandled: null,
            onReset: null,
            onResize: null,
            onScroll: null,
            onScrollEnd: null,
            onSecurityPolicyViolation: null,
            onSeeked: null,
            onSeeking: null,
            onSelect: null,
            onSlotChange: null,
            onStalled: null,
            onStorage: null,
            onSubmit: null,
            onSuspend: null,
            onTimeUpdate: null,
            onToggle: null,
            onUnhandledRejection: null,
            onUnload: null,
            onVolumeChange: null,
            onWaiting: null,
            onWheel: null,
            open: f.boolean,
            optimum: f.number,
            pattern: null,
            ping: f.spaceSeparated,
            placeholder: null,
            playsInline: f.boolean,
            poster: null,
            preload: null,
            readOnly: f.boolean,
            referrerPolicy: null,
            rel: f.spaceSeparated,
            required: f.boolean,
            reversed: f.boolean,
            rows: f.number,
            rowSpan: f.number,
            sandbox: f.spaceSeparated,
            scope: null,
            scoped: f.boolean,
            seamless: f.boolean,
            selected: f.boolean,
            shape: null,
            size: f.number,
            sizes: null,
            slot: null,
            span: f.number,
            spellCheck: f.booleanish,
            src: null,
            srcDoc: null,
            srcLang: null,
            srcSet: null,
            start: f.number,
            step: null,
            style: null,
            tabIndex: f.number,
            target: null,
            title: null,
            translate: null,
            type: null,
            typeMustMatch: f.boolean,
            useMap: null,
            value: f.booleanish,
            width: f.number,
            wrap: null,
            align: null,
            aLink: null,
            archive: f.spaceSeparated,
            axis: null,
            background: null,
            bgColor: null,
            border: f.number,
            borderColor: null,
            bottomMargin: f.number,
            cellPadding: null,
            cellSpacing: null,
            char: null,
            charOff: null,
            classId: null,
            clear: null,
            code: null,
            codeBase: null,
            codeType: null,
            color: null,
            compact: f.boolean,
            declare: f.boolean,
            event: null,
            face: null,
            frame: null,
            frameBorder: null,
            hSpace: f.number,
            leftMargin: f.number,
            link: null,
            longDesc: null,
            lowSrc: null,
            marginHeight: f.number,
            marginWidth: f.number,
            noResize: f.boolean,
            noHref: f.boolean,
            noShade: f.boolean,
            noWrap: f.boolean,
            object: null,
            profile: null,
            prompt: null,
            rev: null,
            rightMargin: f.number,
            rules: null,
            scheme: null,
            scrolling: f.booleanish,
            standby: null,
            summary: null,
            text: null,
            topMargin: f.number,
            valueType: null,
            version: null,
            vAlign: null,
            vLink: null,
            vSpace: f.number,
            allowTransparency: null,
            autoCorrect: null,
            autoSave: null,
            disablePictureInPicture: f.boolean,
            disableRemotePlayback: f.boolean,
            prefix: null,
            property: null,
            results: f.number,
            security: null,
            unselectable: null,
          },
        }),
        g = s({
          space: "svg",
          attributes: {
            accentHeight: "accent-height",
            alignmentBaseline: "alignment-baseline",
            arabicForm: "arabic-form",
            baselineShift: "baseline-shift",
            capHeight: "cap-height",
            className: "class",
            clipPath: "clip-path",
            clipRule: "clip-rule",
            colorInterpolation: "color-interpolation",
            colorInterpolationFilters: "color-interpolation-filters",
            colorProfile: "color-profile",
            colorRendering: "color-rendering",
            crossOrigin: "crossorigin",
            dataType: "datatype",
            dominantBaseline: "dominant-baseline",
            enableBackground: "enable-background",
            fillOpacity: "fill-opacity",
            fillRule: "fill-rule",
            floodColor: "flood-color",
            floodOpacity: "flood-opacity",
            fontFamily: "font-family",
            fontSize: "font-size",
            fontSizeAdjust: "font-size-adjust",
            fontStretch: "font-stretch",
            fontStyle: "font-style",
            fontVariant: "font-variant",
            fontWeight: "font-weight",
            glyphName: "glyph-name",
            glyphOrientationHorizontal: "glyph-orientation-horizontal",
            glyphOrientationVertical: "glyph-orientation-vertical",
            hrefLang: "hreflang",
            horizAdvX: "horiz-adv-x",
            horizOriginX: "horiz-origin-x",
            horizOriginY: "horiz-origin-y",
            imageRendering: "image-rendering",
            letterSpacing: "letter-spacing",
            lightingColor: "lighting-color",
            markerEnd: "marker-end",
            markerMid: "marker-mid",
            markerStart: "marker-start",
            navDown: "nav-down",
            navDownLeft: "nav-down-left",
            navDownRight: "nav-down-right",
            navLeft: "nav-left",
            navNext: "nav-next",
            navPrev: "nav-prev",
            navRight: "nav-right",
            navUp: "nav-up",
            navUpLeft: "nav-up-left",
            navUpRight: "nav-up-right",
            onAbort: "onabort",
            onActivate: "onactivate",
            onAfterPrint: "onafterprint",
            onBeforePrint: "onbeforeprint",
            onBegin: "onbegin",
            onCancel: "oncancel",
            onCanPlay: "oncanplay",
            onCanPlayThrough: "oncanplaythrough",
            onChange: "onchange",
            onClick: "onclick",
            onClose: "onclose",
            onCopy: "oncopy",
            onCueChange: "oncuechange",
            onCut: "oncut",
            onDblClick: "ondblclick",
            onDrag: "ondrag",
            onDragEnd: "ondragend",
            onDragEnter: "ondragenter",
            onDragExit: "ondragexit",
            onDragLeave: "ondragleave",
            onDragOver: "ondragover",
            onDragStart: "ondragstart",
            onDrop: "ondrop",
            onDurationChange: "ondurationchange",
            onEmptied: "onemptied",
            onEnd: "onend",
            onEnded: "onended",
            onError: "onerror",
            onFocus: "onfocus",
            onFocusIn: "onfocusin",
            onFocusOut: "onfocusout",
            onHashChange: "onhashchange",
            onInput: "oninput",
            onInvalid: "oninvalid",
            onKeyDown: "onkeydown",
            onKeyPress: "onkeypress",
            onKeyUp: "onkeyup",
            onLoad: "onload",
            onLoadedData: "onloadeddata",
            onLoadedMetadata: "onloadedmetadata",
            onLoadStart: "onloadstart",
            onMessage: "onmessage",
            onMouseDown: "onmousedown",
            onMouseEnter: "onmouseenter",
            onMouseLeave: "onmouseleave",
            onMouseMove: "onmousemove",
            onMouseOut: "onmouseout",
            onMouseOver: "onmouseover",
            onMouseUp: "onmouseup",
            onMouseWheel: "onmousewheel",
            onOffline: "onoffline",
            onOnline: "ononline",
            onPageHide: "onpagehide",
            onPageShow: "onpageshow",
            onPaste: "onpaste",
            onPause: "onpause",
            onPlay: "onplay",
            onPlaying: "onplaying",
            onPopState: "onpopstate",
            onProgress: "onprogress",
            onRateChange: "onratechange",
            onRepeat: "onrepeat",
            onReset: "onreset",
            onResize: "onresize",
            onScroll: "onscroll",
            onSeeked: "onseeked",
            onSeeking: "onseeking",
            onSelect: "onselect",
            onShow: "onshow",
            onStalled: "onstalled",
            onStorage: "onstorage",
            onSubmit: "onsubmit",
            onSuspend: "onsuspend",
            onTimeUpdate: "ontimeupdate",
            onToggle: "ontoggle",
            onUnload: "onunload",
            onVolumeChange: "onvolumechange",
            onWaiting: "onwaiting",
            onZoom: "onzoom",
            overlinePosition: "overline-position",
            overlineThickness: "overline-thickness",
            paintOrder: "paint-order",
            panose1: "panose-1",
            pointerEvents: "pointer-events",
            referrerPolicy: "referrerpolicy",
            renderingIntent: "rendering-intent",
            shapeRendering: "shape-rendering",
            stopColor: "stop-color",
            stopOpacity: "stop-opacity",
            strikethroughPosition: "strikethrough-position",
            strikethroughThickness: "strikethrough-thickness",
            strokeDashArray: "stroke-dasharray",
            strokeDashOffset: "stroke-dashoffset",
            strokeLineCap: "stroke-linecap",
            strokeLineJoin: "stroke-linejoin",
            strokeMiterLimit: "stroke-miterlimit",
            strokeOpacity: "stroke-opacity",
            strokeWidth: "stroke-width",
            tabIndex: "tabindex",
            textAnchor: "text-anchor",
            textDecoration: "text-decoration",
            textRendering: "text-rendering",
            typeOf: "typeof",
            underlinePosition: "underline-position",
            underlineThickness: "underline-thickness",
            unicodeBidi: "unicode-bidi",
            unicodeRange: "unicode-range",
            unitsPerEm: "units-per-em",
            vAlphabetic: "v-alphabetic",
            vHanging: "v-hanging",
            vIdeographic: "v-ideographic",
            vMathematical: "v-mathematical",
            vectorEffect: "vector-effect",
            vertAdvY: "vert-adv-y",
            vertOriginX: "vert-origin-x",
            vertOriginY: "vert-origin-y",
            wordSpacing: "word-spacing",
            writingMode: "writing-mode",
            xHeight: "x-height",
            playbackOrder: "playbackorder",
            timelineBegin: "timelinebegin",
          },
          transform: d,
          properties: {
            about: f.commaOrSpaceSeparated,
            accentHeight: f.number,
            accumulate: null,
            additive: null,
            alignmentBaseline: null,
            alphabetic: f.number,
            amplitude: f.number,
            arabicForm: null,
            ascent: f.number,
            attributeName: null,
            attributeType: null,
            azimuth: f.number,
            bandwidth: null,
            baselineShift: null,
            baseFrequency: null,
            baseProfile: null,
            bbox: null,
            begin: null,
            bias: f.number,
            by: null,
            calcMode: null,
            capHeight: f.number,
            className: f.spaceSeparated,
            clip: null,
            clipPath: null,
            clipPathUnits: null,
            clipRule: null,
            color: null,
            colorInterpolation: null,
            colorInterpolationFilters: null,
            colorProfile: null,
            colorRendering: null,
            content: null,
            contentScriptType: null,
            contentStyleType: null,
            crossOrigin: null,
            cursor: null,
            cx: null,
            cy: null,
            d: null,
            dataType: null,
            defaultAction: null,
            descent: f.number,
            diffuseConstant: f.number,
            direction: null,
            display: null,
            dur: null,
            divisor: f.number,
            dominantBaseline: null,
            download: f.boolean,
            dx: null,
            dy: null,
            edgeMode: null,
            editable: null,
            elevation: f.number,
            enableBackground: null,
            end: null,
            event: null,
            exponent: f.number,
            externalResourcesRequired: null,
            fill: null,
            fillOpacity: f.number,
            fillRule: null,
            filter: null,
            filterRes: null,
            filterUnits: null,
            floodColor: null,
            floodOpacity: null,
            focusable: null,
            focusHighlight: null,
            fontFamily: null,
            fontSize: null,
            fontSizeAdjust: null,
            fontStretch: null,
            fontStyle: null,
            fontVariant: null,
            fontWeight: null,
            format: null,
            fr: null,
            from: null,
            fx: null,
            fy: null,
            g1: f.commaSeparated,
            g2: f.commaSeparated,
            glyphName: f.commaSeparated,
            glyphOrientationHorizontal: null,
            glyphOrientationVertical: null,
            glyphRef: null,
            gradientTransform: null,
            gradientUnits: null,
            handler: null,
            hanging: f.number,
            hatchContentUnits: null,
            hatchUnits: null,
            height: null,
            href: null,
            hrefLang: null,
            horizAdvX: f.number,
            horizOriginX: f.number,
            horizOriginY: f.number,
            id: null,
            ideographic: f.number,
            imageRendering: null,
            initialVisibility: null,
            in: null,
            in2: null,
            intercept: f.number,
            k: f.number,
            k1: f.number,
            k2: f.number,
            k3: f.number,
            k4: f.number,
            kernelMatrix: f.commaOrSpaceSeparated,
            kernelUnitLength: null,
            keyPoints: null,
            keySplines: null,
            keyTimes: null,
            kerning: null,
            lang: null,
            lengthAdjust: null,
            letterSpacing: null,
            lightingColor: null,
            limitingConeAngle: f.number,
            local: null,
            markerEnd: null,
            markerMid: null,
            markerStart: null,
            markerHeight: null,
            markerUnits: null,
            markerWidth: null,
            mask: null,
            maskContentUnits: null,
            maskUnits: null,
            mathematical: null,
            max: null,
            media: null,
            mediaCharacterEncoding: null,
            mediaContentEncodings: null,
            mediaSize: f.number,
            mediaTime: null,
            method: null,
            min: null,
            mode: null,
            name: null,
            navDown: null,
            navDownLeft: null,
            navDownRight: null,
            navLeft: null,
            navNext: null,
            navPrev: null,
            navRight: null,
            navUp: null,
            navUpLeft: null,
            navUpRight: null,
            numOctaves: null,
            observer: null,
            offset: null,
            onAbort: null,
            onActivate: null,
            onAfterPrint: null,
            onBeforePrint: null,
            onBegin: null,
            onCancel: null,
            onCanPlay: null,
            onCanPlayThrough: null,
            onChange: null,
            onClick: null,
            onClose: null,
            onCopy: null,
            onCueChange: null,
            onCut: null,
            onDblClick: null,
            onDrag: null,
            onDragEnd: null,
            onDragEnter: null,
            onDragExit: null,
            onDragLeave: null,
            onDragOver: null,
            onDragStart: null,
            onDrop: null,
            onDurationChange: null,
            onEmptied: null,
            onEnd: null,
            onEnded: null,
            onError: null,
            onFocus: null,
            onFocusIn: null,
            onFocusOut: null,
            onHashChange: null,
            onInput: null,
            onInvalid: null,
            onKeyDown: null,
            onKeyPress: null,
            onKeyUp: null,
            onLoad: null,
            onLoadedData: null,
            onLoadedMetadata: null,
            onLoadStart: null,
            onMessage: null,
            onMouseDown: null,
            onMouseEnter: null,
            onMouseLeave: null,
            onMouseMove: null,
            onMouseOut: null,
            onMouseOver: null,
            onMouseUp: null,
            onMouseWheel: null,
            onOffline: null,
            onOnline: null,
            onPageHide: null,
            onPageShow: null,
            onPaste: null,
            onPause: null,
            onPlay: null,
            onPlaying: null,
            onPopState: null,
            onProgress: null,
            onRateChange: null,
            onRepeat: null,
            onReset: null,
            onResize: null,
            onScroll: null,
            onSeeked: null,
            onSeeking: null,
            onSelect: null,
            onShow: null,
            onStalled: null,
            onStorage: null,
            onSubmit: null,
            onSuspend: null,
            onTimeUpdate: null,
            onToggle: null,
            onUnload: null,
            onVolumeChange: null,
            onWaiting: null,
            onZoom: null,
            opacity: null,
            operator: null,
            order: null,
            orient: null,
            orientation: null,
            origin: null,
            overflow: null,
            overlay: null,
            overlinePosition: f.number,
            overlineThickness: f.number,
            paintOrder: null,
            panose1: null,
            path: null,
            pathLength: f.number,
            patternContentUnits: null,
            patternTransform: null,
            patternUnits: null,
            phase: null,
            ping: f.spaceSeparated,
            pitch: null,
            playbackOrder: null,
            pointerEvents: null,
            points: null,
            pointsAtX: f.number,
            pointsAtY: f.number,
            pointsAtZ: f.number,
            preserveAlpha: null,
            preserveAspectRatio: null,
            primitiveUnits: null,
            propagate: null,
            property: f.commaOrSpaceSeparated,
            r: null,
            radius: null,
            referrerPolicy: null,
            refX: null,
            refY: null,
            rel: f.commaOrSpaceSeparated,
            rev: f.commaOrSpaceSeparated,
            renderingIntent: null,
            repeatCount: null,
            repeatDur: null,
            requiredExtensions: f.commaOrSpaceSeparated,
            requiredFeatures: f.commaOrSpaceSeparated,
            requiredFonts: f.commaOrSpaceSeparated,
            requiredFormats: f.commaOrSpaceSeparated,
            resource: null,
            restart: null,
            result: null,
            rotate: null,
            rx: null,
            ry: null,
            scale: null,
            seed: null,
            shapeRendering: null,
            side: null,
            slope: null,
            snapshotTime: null,
            specularConstant: f.number,
            specularExponent: f.number,
            spreadMethod: null,
            spacing: null,
            startOffset: null,
            stdDeviation: null,
            stemh: null,
            stemv: null,
            stitchTiles: null,
            stopColor: null,
            stopOpacity: null,
            strikethroughPosition: f.number,
            strikethroughThickness: f.number,
            string: null,
            stroke: null,
            strokeDashArray: f.commaOrSpaceSeparated,
            strokeDashOffset: null,
            strokeLineCap: null,
            strokeLineJoin: null,
            strokeMiterLimit: f.number,
            strokeOpacity: f.number,
            strokeWidth: null,
            style: null,
            surfaceScale: f.number,
            syncBehavior: null,
            syncBehaviorDefault: null,
            syncMaster: null,
            syncTolerance: null,
            syncToleranceDefault: null,
            systemLanguage: f.commaOrSpaceSeparated,
            tabIndex: f.number,
            tableValues: null,
            target: null,
            targetX: f.number,
            targetY: f.number,
            textAnchor: null,
            textDecoration: null,
            textRendering: null,
            textLength: null,
            timelineBegin: null,
            title: null,
            transformBehavior: null,
            type: null,
            typeOf: f.commaOrSpaceSeparated,
            to: null,
            transform: null,
            u1: null,
            u2: null,
            underlinePosition: f.number,
            underlineThickness: f.number,
            unicode: null,
            unicodeBidi: null,
            unicodeRange: null,
            unitsPerEm: f.number,
            values: null,
            vAlphabetic: f.number,
            vMathematical: f.number,
            vectorEffect: null,
            vHanging: f.number,
            vIdeographic: f.number,
            version: null,
            vertAdvY: f.number,
            vertOriginX: f.number,
            vertOriginY: f.number,
            viewBox: null,
            viewTarget: null,
            visibility: null,
            width: null,
            widths: null,
            wordSpacing: null,
            writingMode: null,
            x: null,
            x1: null,
            x2: null,
            xChannelSelector: null,
            xHeight: f.number,
            y: null,
            y1: null,
            y2: null,
            yChannelSelector: null,
            z: null,
            zoomAndPan: null,
          },
        }),
        A = i([u, c, h, m, T], "html"),
        E = i([u, c, h, m, g], "svg");
    },
    45984: (e, t, n) => {
      "use strict";
      function r(e, t) {
        return i(e, t.inConstruct, !0) && !i(e, t.notInConstruct, !1);
      }
      function i(e, t, n) {
        if (("string" == typeof t && (t = [t]), !t || 0 === t.length)) {
          return n;
        }
        let r = -1;
        for (; ++r < t.length; ) {
          if (e.includes(t[r])) return !0;
        }
        return !1;
      }
      n.d(t, { q: () => r });
    },
    46991: (e, t, n) => {
      "use strict";
      function r(e, t) {
        let n = String(e),
          r = n.indexOf(t),
          i = r,
          a = 0,
          o = 0;
        if ("string" != typeof t) {
          throw TypeError("Expected substring");
        }
        for (; -1 !== r; ) {
          (r === i ? ++a > o && (o = a) : (a = 1), (i = r + t.length), (r = n.indexOf(t, i)));
        }
        return o;
      }
      n.d(t, { D: () => r });
    },
    47069: (e, t, n) => {
      "use strict";
      n.d(t, { I: () => c });
      var r = n(31109),
        i = n(15159),
        a = n(44735);
      let o = /^data[-\w.:]+$/i,
        l = /-[a-z]/g,
        s = /[A-Z]/g;
      function c(e, t) {
        let n = (0, r.S)(t),
          c = t,
          p = a.R;
        if (n in e.normal) {
          return e.property[e.normal[n]];
        }
        if (n.length > 4 && "data" === n.slice(0, 4) && o.test(t)) {
          if ("-" === t.charAt(4)) {
            let e = t.slice(5).replace(l, d);
            c = "data" + e.charAt(0).toUpperCase() + e.slice(1);
          } else {
            let e = t.slice(4);
            if (!l.test(e)) {
              let n = e.replace(s, u);
              ("-" !== n.charAt(0) && (n = "-" + n), (t = "data" + n));
            }
          }
          p = i.E;
        }
        return new p(c, t);
      }
      function u(e) {
        return "-" + e.toLowerCase();
      }
      function d(e) {
        return e.charAt(1).toUpperCase();
      }
    },
    47275: (e) => {
      e.exports = function (e, t) {
        for (var n = -1, r = null == e ? 0 : e.length, i = Array(r); ++n < r; ) {
          i[n] = t(e[n], n, e);
        }
        return i;
      };
    },
    48545: (e, t, n) => {
      var r = n(81863),
        i = n(39913);
      e.exports = function (e) {
        return "symbol" == typeof e || (i(e) && "[object Symbol]" == r(e));
      };
    },
    49828: (e, t, n) => {
      "use strict";
      (n.r(t),
        n.d(t, {
          boolean: () => i,
          booleanish: () => a,
          commaOrSpaceSeparated: () => u,
          commaSeparated: () => c,
          number: () => l,
          overloadedBoolean: () => o,
          spaceSeparated: () => s,
        }));
      let r = 0,
        i = d(),
        a = d(),
        o = d(),
        l = d(),
        s = d(),
        c = d(),
        u = d();
      function d() {
        return 2 ** ++r;
      }
    },
    51072: (e, t, n) => {
      "use strict";
      n.d(t, { C: () => Q, H: () => $ });
      var r = n(60184),
        i = n(74799),
        a = n(97058),
        o = n(50451),
        l = n(96541),
        s = n(70333);
      let c = "phrasing",
        u = ["autolink", "link", "image", "label"];
      function d(e) {
        this.enter({ type: "link", title: null, url: "", children: [] }, e);
      }
      function p(e) {
        this.config.enter.autolinkProtocol.call(this, e);
      }
      function h(e) {
        this.config.exit.autolinkProtocol.call(this, e);
      }
      function f(e) {
        this.config.exit.data.call(this, e);
        let t = this.stack[this.stack.length - 1];
        ((0, i.ok)("link" === t.type), (t.url = "http://" + this.sliceSerialize(e)));
      }
      function m(e) {
        this.config.exit.autolinkEmail.call(this, e);
      }
      function T(e) {
        this.exit(e);
      }
      function g(e) {
        !(function (e, t, n) {
          let r = (0, s.C)((n || {}).ignore || []),
            i = (function (e) {
              let t = [];
              if (!Array.isArray(e)) {
                throw TypeError("Expected find and replace tuple or list of tuples");
              }
              let n = !e[0] || Array.isArray(e[0]) ? e : [e],
                r = -1;
              for (; ++r < n.length; ) {
                var i;
                let e = n[r];
                t.push([
                  "string" == typeof (i = e[0]) ? RegExp((0, o.A)(i), "g") : i,
                  (function (e) {
                    return "function" == typeof e
                      ? e
                      : function () {
                          return e;
                        };
                  })(e[1]),
                ]);
              }
              return t;
            })(t),
            a = -1;
          for (; ++a < i.length; ) {
            (0, l.VG)(e, "text", c);
          }
          function c(e, t) {
            let n,
              o = -1;
            for (; ++o < t.length; ) {
              let e = t[o],
                i = n ? n.children : void 0;
              if (r(e, i ? i.indexOf(e) : void 0, n)) {
                return;
              }
              n = e;
            }
            if (n) {
              return (function (e, t) {
                let n = t[t.length - 1],
                  r = i[a][0],
                  o = i[a][1],
                  l = 0,
                  s = n.children.indexOf(e),
                  c = !1,
                  u = [];
                r.lastIndex = 0;
                let d = r.exec(e.value);
                for (; d; ) {
                  let n = d.index,
                    i = { index: d.index, input: d.input, stack: [...t, e] },
                    a = o(...d, i);
                  if (
                    ("string" == typeof a &&
                      (a = a.length > 0 ? { type: "text", value: a } : void 0),
                    !1 === a
                      ? (r.lastIndex = n + 1)
                      : (l !== n && u.push({ type: "text", value: e.value.slice(l, n) }),
                        Array.isArray(a) ? u.push(...a) : a && u.push(a),
                        (l = n + d[0].length),
                        (c = !0)),
                    !r.global)
                  )
                    break;
                  d = r.exec(e.value);
                }
                return (
                  c
                    ? (l < e.value.length && u.push({ type: "text", value: e.value.slice(l) }),
                      n.children.splice(s, 1, ...u))
                    : (u = [e]),
                  s + u.length
                );
              })(e, t);
            }
          }
        })(
          e,
          [
            [/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi, A],
            [/(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu, E],
          ],
          { ignore: ["link", "linkReference"] },
        );
      }
      function A(e, t, n, i, a) {
        let o = "";
        if (
          !I(a) ||
          (/^w/i.test(t) && ((n = t + n), (t = ""), (o = "http://")),
          !(function (e) {
            let t = e.split(".");
            return !(
              t.length < 2 ||
              (t[t.length - 1] &&
                (/_/.test(t[t.length - 1]) || !/[a-zA-Z\d]/.test(t[t.length - 1]))) ||
              (t[t.length - 2] &&
                (/_/.test(t[t.length - 2]) || !/[a-zA-Z\d]/.test(t[t.length - 2])))
            );
          })(n))
        ) {
          return !1;
        }
        let l = (function (e) {
          let t = /[!"&'),.:;<>?\]}]+$/.exec(e);
          if (!t) {
            return [e, void 0];
          }
          e = e.slice(0, t.index);
          let n = t[0],
            i = n.indexOf(")"),
            a = (0, r.D)(e, "("),
            o = (0, r.D)(e, ")");
          for (; -1 !== i && a > o; ) {
            ((e += n.slice(0, i + 1)), (i = (n = n.slice(i + 1)).indexOf(")")), o++);
          }
          return [e, n];
        })(n + i);
        if (!l[0]) {
          return !1;
        }
        let s = {
          type: "link",
          title: null,
          url: o + t + l[0],
          children: [{ type: "text", value: t + l[0] }],
        };
        return l[1] ? [s, { type: "text", value: l[1] }] : s;
      }
      function E(e, t, n, r) {
        return (
          !(!I(r, !0) || /[-\d_]$/.test(n)) && {
            type: "link",
            title: null,
            url: "mailto:" + t + "@" + n,
            children: [{ type: "text", value: t + "@" + n }],
          }
        );
      }
      function I(e, t) {
        let n = e.input.charCodeAt(e.index - 1);
        return (0 === e.index || (0, a.Ny)(n) || (0, a.es)(n)) && (!t || 47 !== n);
      }
      var _ = n(20728);
      function k(e) {
        this.enter({ type: "footnoteDefinition", identifier: "", label: "", children: [] }, e);
      }
      function D() {
        this.buffer();
      }
      function b(e) {
        let t = this.resume(),
          n = this.stack[this.stack.length - 1];
        ((0, i.ok)("footnoteDefinition" === n.type),
          (n.label = t),
          (n.identifier = (0, _.B)(this.sliceSerialize(e)).toLowerCase()));
      }
      function y(e) {
        this.exit(e);
      }
      function N(e) {
        this.enter({ type: "footnoteReference", identifier: "", label: "" }, e);
      }
      function S() {
        this.buffer();
      }
      function C(e) {
        let t = this.resume(),
          n = this.stack[this.stack.length - 1];
        ((0, i.ok)("footnoteReference" === n.type),
          (n.label = t),
          (n.identifier = (0, _.B)(this.sliceSerialize(e)).toLowerCase()));
      }
      function x(e) {
        this.exit(e);
      }
      function L(e, t, n, r) {
        let i = n.createTracker(r),
          a = i.move("[^"),
          o = n.enter("footnoteReference"),
          l = n.enter("reference");
        return (
          (a += i.move(n.safe(n.associationId(e), { ...i.current(), before: a, after: "]" }))),
          l(),
          o(),
          (a += i.move("]"))
        );
      }
      function v(e, t, n, r) {
        let i = n.createTracker(r),
          a = i.move("[^"),
          o = n.enter("footnoteDefinition"),
          l = n.enter("label");
        return (
          (a += i.move(n.safe(n.associationId(e), { ...i.current(), before: a, after: "]" }))),
          l(),
          (a += i.move("]:" + (e.children && e.children.length > 0 ? " " : ""))),
          i.shift(4),
          (a += i.move(n.indentLines(n.containerFlow(e, i.current()), G))),
          o(),
          a
        );
      }
      function G(e, t, n) {
        return 0 === t ? e : (n ? "" : "    ") + e;
      }
      L.peek = function () {
        return "[";
      };
      let O = [
        "autolink",
        "destinationLiteral",
        "destinationRaw",
        "reference",
        "titleQuote",
        "titleApostrophe",
      ];
      function M(e) {
        this.enter({ type: "delete", children: [] }, e);
      }
      function R(e) {
        this.exit(e);
      }
      function P(e, t, n, r) {
        let i = n.createTracker(r),
          a = n.enter("strikethrough"),
          o = i.move("~~");
        return (
          (o += n.containerPhrasing(e, { ...i.current(), before: o, after: "~" })),
          (o += i.move("~~")),
          a(),
          o
        );
      }
      function w(e) {
        return e.length;
      }
      function F(e) {
        let t = "string" == typeof e ? e.codePointAt(0) : 0;
        return 67 === t || 99 === t
          ? 99
          : 76 === t || 108 === t
            ? 108
            : 114 * (82 === t || 114 === t);
      }
      P.peek = function () {
        return "~";
      };
      var H = n(4501);
      function B(e) {
        let t = e._align;
        ((0, i.ok)(t, "expected `_align` on table"),
          this.enter(
            {
              type: "table",
              align: t.map(function (e) {
                return "none" === e ? null : e;
              }),
              children: [],
            },
            e,
          ),
          (this.data.inTable = !0));
      }
      function U(e) {
        (this.exit(e), (this.data.inTable = void 0));
      }
      function q(e) {
        this.enter({ type: "tableRow", children: [] }, e);
      }
      function z(e) {
        this.exit(e);
      }
      function W(e) {
        this.enter({ type: "tableCell", children: [] }, e);
      }
      function V(e) {
        let t = this.resume();
        this.data.inTable && (t = t.replace(/\\([\\|])/g, Y));
        let n = this.stack[this.stack.length - 1];
        ((0, i.ok)("inlineCode" === n.type), (n.value = t), this.exit(e));
      }
      function Y(e, t) {
        return "|" === t ? t : e;
      }
      function j(e) {
        let t = this.stack[this.stack.length - 2];
        ((0, i.ok)("listItem" === t.type), (t.checked = "taskListCheckValueChecked" === e.type));
      }
      function X(e) {
        let t = this.stack[this.stack.length - 2];
        if (t && "listItem" === t.type && "boolean" == typeof t.checked) {
          let e = this.stack[this.stack.length - 1];
          (0, i.ok)("paragraph" === e.type);
          let n = e.children[0];
          if (n && "text" === n.type) {
            let r,
              i = t.children,
              a = -1;
            for (; ++a < i.length; ) {
              let e = i[a];
              if ("paragraph" === e.type) {
                r = e;
                break;
              }
            }
            r === e &&
              ((n.value = n.value.slice(1)),
              0 === n.value.length
                ? e.children.shift()
                : e.position &&
                  n.position &&
                  "number" == typeof n.position.start.offset &&
                  (n.position.start.column++,
                  n.position.start.offset++,
                  (e.position.start = Object.assign({}, n.position.start))));
          }
        }
        this.exit(e);
      }
      function K(e, t, n, r) {
        let i = e.children[0],
          a = "boolean" == typeof e.checked && i && "paragraph" === i.type,
          o = "[" + (e.checked ? "x" : " ") + "] ",
          l = n.createTracker(r);
        a && l.move(o);
        let s = H.p.listItem(e, t, n, { ...r, ...l.current() });
        return (
          a &&
            (s = s.replace(/^(?:[*+-]|\d+\.)([\r\n]| {1,3})/, function (e) {
              return e + o;
            })),
          s
        );
      }
      function Q() {
        return [
          {
            transforms: [g],
            enter: {
              literalAutolink: d,
              literalAutolinkEmail: p,
              literalAutolinkHttp: p,
              literalAutolinkWww: p,
            },
            exit: {
              literalAutolink: T,
              literalAutolinkEmail: m,
              literalAutolinkHttp: h,
              literalAutolinkWww: f,
            },
          },
          {
            enter: {
              gfmFootnoteDefinition: k,
              gfmFootnoteDefinitionLabelString: D,
              gfmFootnoteCall: N,
              gfmFootnoteCallString: S,
            },
            exit: {
              gfmFootnoteDefinition: y,
              gfmFootnoteDefinitionLabelString: b,
              gfmFootnoteCall: x,
              gfmFootnoteCallString: C,
            },
          },
          { canContainEols: ["delete"], enter: { strikethrough: M }, exit: { strikethrough: R } },
          {
            enter: { table: B, tableData: W, tableHeader: W, tableRow: q },
            exit: { codeText: V, table: U, tableData: z, tableHeader: z, tableRow: z },
          },
          { exit: { taskListCheckValueChecked: j, taskListCheckValueUnchecked: j, paragraph: X } },
        ];
      }
      function $(e) {
        return {
          extensions: [
            {
              unsafe: [
                {
                  character: "@",
                  before: "[+\\-.\\w]",
                  after: "[\\-.\\w]",
                  inConstruct: c,
                  notInConstruct: u,
                },
                {
                  character: ".",
                  before: "[Ww]",
                  after: "[\\-.\\w]",
                  inConstruct: c,
                  notInConstruct: u,
                },
                { character: ":", before: "[ps]", after: "\\/", inConstruct: c, notInConstruct: u },
              ],
            },
            {
              unsafe: [{ character: "[", inConstruct: ["phrasing", "label", "reference"] }],
              handlers: { footnoteDefinition: v, footnoteReference: L },
            },
            {
              unsafe: [{ character: "~", inConstruct: "phrasing", notInConstruct: O }],
              handlers: { delete: P },
            },
            (function (e) {
              let t = e || {},
                n = t.tableCellPadding,
                r = t.tablePipeAlign,
                i = t.stringLength,
                a = n ? " " : "|";
              return {
                unsafe: [
                  { character: "\r", inConstruct: "tableCell" },
                  { character: "\n", inConstruct: "tableCell" },
                  { atBreak: !0, character: "|", after: "[	 :-]" },
                  { character: "|", inConstruct: "tableCell" },
                  { atBreak: !0, character: ":", after: "-" },
                  { atBreak: !0, character: "-", after: "[:|-]" },
                ],
                handlers: {
                  inlineCode: function (e, t, n) {
                    let r = H.p.inlineCode(e, t, n);
                    return (n.stack.includes("tableCell") && (r = r.replace(/\|/g, "\\$&")), r);
                  },
                  table: function (e, t, n, r) {
                    return l(
                      (function (e, t, n) {
                        let r = e.children,
                          i = -1,
                          a = [],
                          o = t.enter("table");
                        for (; ++i < r.length; ) {
                          a[i] = s(r[i], t, n);
                        }
                        return (o(), a);
                      })(e, n, r),
                      e.align,
                    );
                  },
                  tableCell: o,
                  tableRow: function (e, t, n, r) {
                    let i = l([s(e, n, r)]);
                    return i.slice(0, i.indexOf("\n"));
                  },
                },
              };
              function o(e, t, n, r) {
                let i = n.enter("tableCell"),
                  o = n.enter("phrasing"),
                  l = n.containerPhrasing(e, { ...r, before: a, after: a });
                return (o(), i(), l);
              }
              function l(e, t) {
                return (function (e, t = {}) {
                  let n = (t.align || []).concat(),
                    r = t.stringLength || w,
                    i = [],
                    a = [],
                    o = [],
                    l = [],
                    s = 0,
                    c = -1;
                  for (; ++c < e.length; ) {
                    let n = [],
                      i = [],
                      d = -1;
                    for (e[c].length > s && (s = e[c].length); ++d < e[c].length; ) {
                      var u;
                      let a = null == (u = e[c][d]) ? "" : String(u);
                      if (!1 !== t.alignDelimiters) {
                        let e = r(a);
                        ((i[d] = e), (void 0 === l[d] || e > l[d]) && (l[d] = e));
                      }
                      n.push(a);
                    }
                    ((a[c] = n), (o[c] = i));
                  }
                  let d = -1;
                  if ("object" == typeof n && "length" in n) {
                    for (; ++d < s; ) i[d] = F(n[d]);
                  } else {
                    let e = F(n);
                    for (; ++d < s; ) {
                      i[d] = e;
                    }
                  }
                  d = -1;
                  let p = [],
                    h = [];
                  for (; ++d < s; ) {
                    let e = i[d],
                      n = "",
                      r = "";
                    99 === e
                      ? ((n = ":"), (r = ":"))
                      : 108 === e
                        ? (n = ":")
                        : 114 === e && (r = ":");
                    let a = !1 === t.alignDelimiters ? 1 : Math.max(1, l[d] - n.length - r.length),
                      o = n + "-".repeat(a) + r;
                    (!1 !== t.alignDelimiters &&
                      ((a = n.length + a + r.length) > l[d] && (l[d] = a), (h[d] = a)),
                      (p[d] = o));
                  }
                  (a.splice(1, 0, p), o.splice(1, 0, h), (c = -1));
                  let f = [];
                  for (; ++c < a.length; ) {
                    let e = a[c],
                      n = o[c];
                    d = -1;
                    let r = [];
                    for (; ++d < s; ) {
                      let a = e[d] || "",
                        o = "",
                        c = "";
                      if (!1 !== t.alignDelimiters) {
                        let e = l[d] - (n[d] || 0),
                          t = i[d];
                        114 === t
                          ? (o = " ".repeat(e))
                          : 99 === t
                            ? e % 2
                              ? ((o = " ".repeat(e / 2 + 0.5)), (c = " ".repeat(e / 2 - 0.5)))
                              : (c = o = " ".repeat(e / 2))
                            : (c = " ".repeat(e));
                      }
                      (!1 === t.delimiterStart || d || r.push("|"),
                        !1 !== t.padding &&
                          (!1 !== t.alignDelimiters || "" !== a) &&
                          (!1 !== t.delimiterStart || d) &&
                          r.push(" "),
                        !1 !== t.alignDelimiters && r.push(o),
                        r.push(a),
                        !1 !== t.alignDelimiters && r.push(c),
                        !1 !== t.padding && r.push(" "),
                        (!1 !== t.delimiterEnd || d !== s - 1) && r.push("|"));
                    }
                    f.push(!1 === t.delimiterEnd ? r.join("").replace(/ +$/, "") : r.join(""));
                  }
                  return f.join("\n");
                })(e, { align: t, alignDelimiters: r, padding: n, stringLength: i });
              }
              function s(e, t, n) {
                let r = e.children,
                  i = -1,
                  a = [],
                  l = t.enter("tableRow");
                for (; ++i < r.length; ) {
                  a[i] = o(r[i], e, t, n);
                }
                return (l(), a);
              }
            })(e),
            {
              unsafe: [{ atBreak: !0, character: "-", after: "[:|-]" }],
              handlers: { listItem: K },
            },
          ],
        };
      }
    },
    51456: (e, t, n) => {
      "use strict";
      var r;
      (n.d(t, { s: () => r }),
        (function (e) {
          ((e.controlCharacterInInputStream = "control-character-in-input-stream"),
            (e.noncharacterInInputStream = "noncharacter-in-input-stream"),
            (e.surrogateInInputStream = "surrogate-in-input-stream"),
            (e.nonVoidHtmlElementStartTagWithTrailingSolidus =
              "non-void-html-element-start-tag-with-trailing-solidus"),
            (e.endTagWithAttributes = "end-tag-with-attributes"),
            (e.endTagWithTrailingSolidus = "end-tag-with-trailing-solidus"),
            (e.unexpectedSolidusInTag = "unexpected-solidus-in-tag"),
            (e.unexpectedNullCharacter = "unexpected-null-character"),
            (e.unexpectedQuestionMarkInsteadOfTagName =
              "unexpected-question-mark-instead-of-tag-name"),
            (e.invalidFirstCharacterOfTagName = "invalid-first-character-of-tag-name"),
            (e.unexpectedEqualsSignBeforeAttributeName =
              "unexpected-equals-sign-before-attribute-name"),
            (e.missingEndTagName = "missing-end-tag-name"),
            (e.unexpectedCharacterInAttributeName = "unexpected-character-in-attribute-name"),
            (e.unknownNamedCharacterReference = "unknown-named-character-reference"),
            (e.missingSemicolonAfterCharacterReference =
              "missing-semicolon-after-character-reference"),
            (e.unexpectedCharacterAfterDoctypeSystemIdentifier =
              "unexpected-character-after-doctype-system-identifier"),
            (e.unexpectedCharacterInUnquotedAttributeValue =
              "unexpected-character-in-unquoted-attribute-value"),
            (e.eofBeforeTagName = "eof-before-tag-name"),
            (e.eofInTag = "eof-in-tag"),
            (e.missingAttributeValue = "missing-attribute-value"),
            (e.missingWhitespaceBetweenAttributes = "missing-whitespace-between-attributes"),
            (e.missingWhitespaceAfterDoctypePublicKeyword =
              "missing-whitespace-after-doctype-public-keyword"),
            (e.missingWhitespaceBetweenDoctypePublicAndSystemIdentifiers =
              "missing-whitespace-between-doctype-public-and-system-identifiers"),
            (e.missingWhitespaceAfterDoctypeSystemKeyword =
              "missing-whitespace-after-doctype-system-keyword"),
            (e.missingQuoteBeforeDoctypePublicIdentifier =
              "missing-quote-before-doctype-public-identifier"),
            (e.missingQuoteBeforeDoctypeSystemIdentifier =
              "missing-quote-before-doctype-system-identifier"),
            (e.missingDoctypePublicIdentifier = "missing-doctype-public-identifier"),
            (e.missingDoctypeSystemIdentifier = "missing-doctype-system-identifier"),
            (e.abruptDoctypePublicIdentifier = "abrupt-doctype-public-identifier"),
            (e.abruptDoctypeSystemIdentifier = "abrupt-doctype-system-identifier"),
            (e.cdataInHtmlContent = "cdata-in-html-content"),
            (e.incorrectlyOpenedComment = "incorrectly-opened-comment"),
            (e.eofInScriptHtmlCommentLikeText = "eof-in-script-html-comment-like-text"),
            (e.eofInDoctype = "eof-in-doctype"),
            (e.nestedComment = "nested-comment"),
            (e.abruptClosingOfEmptyComment = "abrupt-closing-of-empty-comment"),
            (e.eofInComment = "eof-in-comment"),
            (e.incorrectlyClosedComment = "incorrectly-closed-comment"),
            (e.eofInCdata = "eof-in-cdata"),
            (e.absenceOfDigitsInNumericCharacterReference =
              "absence-of-digits-in-numeric-character-reference"),
            (e.nullCharacterReference = "null-character-reference"),
            (e.surrogateCharacterReference = "surrogate-character-reference"),
            (e.characterReferenceOutsideUnicodeRange = "character-reference-outside-unicode-range"),
            (e.controlCharacterReference = "control-character-reference"),
            (e.noncharacterCharacterReference = "noncharacter-character-reference"),
            (e.missingWhitespaceBeforeDoctypeName = "missing-whitespace-before-doctype-name"),
            (e.missingDoctypeName = "missing-doctype-name"),
            (e.invalidCharacterSequenceAfterDoctypeName =
              "invalid-character-sequence-after-doctype-name"),
            (e.duplicateAttribute = "duplicate-attribute"),
            (e.nonConformingDoctype = "non-conforming-doctype"),
            (e.missingDoctype = "missing-doctype"),
            (e.misplacedDoctype = "misplaced-doctype"),
            (e.endTagWithoutMatchingOpenElement = "end-tag-without-matching-open-element"),
            (e.closingOfElementWithOpenChildElements =
              "closing-of-element-with-open-child-elements"),
            (e.disallowedContentInNoscriptInHead = "disallowed-content-in-noscript-in-head"),
            (e.openElementsLeftAfterEof = "open-elements-left-after-eof"),
            (e.abandonedHeadElementChild = "abandoned-head-element-child"),
            (e.misplacedStartTagForHeadElement = "misplaced-start-tag-for-head-element"),
            (e.nestedNoscriptInHead = "nested-noscript-in-head"),
            (e.eofInElementThatCanContainOnlyText = "eof-in-element-that-can-contain-only-text"));
        })((r = r || (r = {}))));
    },
    55397: (e) => {
      "use strict";
      e.exports = RangeError;
    },
    57920: (e, t, n) => {
      "use strict";
      n.d(t, { j: () => a });
      var r = n(16958);
      function i(e) {
        return { nodeName: "#text", value: e, parentNode: null };
      }
      let a = {
        createDocument: () => ({
          nodeName: "#document",
          mode: r.DOCUMENT_MODE.NO_QUIRKS,
          childNodes: [],
        }),
        createDocumentFragment: () => ({ nodeName: "#document-fragment", childNodes: [] }),
        createElement: (e, t, n) => ({
          nodeName: e,
          tagName: e,
          attrs: n,
          namespaceURI: t,
          childNodes: [],
          parentNode: null,
        }),
        createCommentNode: (e) => ({ nodeName: "#comment", data: e, parentNode: null }),
        appendChild(e, t) {
          (e.childNodes.push(t), (t.parentNode = e));
        },
        insertBefore(e, t, n) {
          let r = e.childNodes.indexOf(n);
          (e.childNodes.splice(r, 0, t), (t.parentNode = e));
        },
        setTemplateContent(e, t) {
          e.content = t;
        },
        getTemplateContent: (e) => e.content,
        setDocumentType(e, t, n, r) {
          let i = e.childNodes.find((e) => "#documentType" === e.nodeName);
          i
            ? ((i.name = t), (i.publicId = n), (i.systemId = r))
            : a.appendChild(e, {
                nodeName: "#documentType",
                name: t,
                publicId: n,
                systemId: r,
                parentNode: null,
              });
        },
        setDocumentMode(e, t) {
          e.mode = t;
        },
        getDocumentMode: (e) => e.mode,
        detachNode(e) {
          if (e.parentNode) {
            let t = e.parentNode.childNodes.indexOf(e);
            (e.parentNode.childNodes.splice(t, 1), (e.parentNode = null));
          }
        },
        insertText(e, t) {
          if (e.childNodes.length > 0) {
            let n = e.childNodes[e.childNodes.length - 1];
            if (a.isTextNode(n)) {
              n.value += t;
              return;
            }
          }
          a.appendChild(e, i(t));
        },
        insertTextBefore(e, t, n) {
          let r = e.childNodes[e.childNodes.indexOf(n) - 1];
          r && a.isTextNode(r) ? (r.value += t) : a.insertBefore(e, i(t), n);
        },
        adoptAttributes(e, t) {
          let n = new Set(e.attrs.map((e) => e.name));
          for (let r = 0; r < t.length; r++) {
            n.has(t[r].name) || e.attrs.push(t[r]);
          }
        },
        getFirstChild: (e) => e.childNodes[0],
        getChildNodes: (e) => e.childNodes,
        getParentNode: (e) => e.parentNode,
        getAttrList: (e) => e.attrs,
        getTagName: (e) => e.tagName,
        getNamespaceURI: (e) => e.namespaceURI,
        getTextNodeContent: (e) => e.value,
        getCommentNodeContent: (e) => e.data,
        getDocumentTypeNodeName: (e) => e.name,
        getDocumentTypeNodePublicId: (e) => e.publicId,
        getDocumentTypeNodeSystemId: (e) => e.systemId,
        isTextNode: (e) => "#text" === e.nodeName,
        isCommentNode: (e) => "#comment" === e.nodeName,
        isDocumentTypeNode: (e) => "#documentType" === e.nodeName,
        isElementNode: (e) => Object.prototype.hasOwnProperty.call(e, "tagName"),
        setNodeSourceCodeLocation(e, t) {
          e.sourceCodeLocation = t;
        },
        getNodeSourceCodeLocation: (e) => e.sourceCodeLocation,
        updateNodeSourceCodeLocation(e, t) {
          e.sourceCodeLocation = { ...e.sourceCodeLocation, ...t };
        },
      };
    },
    62479: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => e_ });
      var r = {};
      (n.r(r),
        n.d(r, {
          attentionMarkers: () => ep,
          contentInitial: () => eo,
          disable: () => eh,
          document: () => ea,
          flow: () => es,
          flowInitial: () => el,
          insideSpan: () => ed,
          string: () => ec,
          text: () => eu,
        }));
      var i = n(96018),
        a = n(72805);
      class o {
        constructor(e) {
          ((this.left = e ? [...e] : []), (this.right = []));
        }
        get(e) {
          if (e < 0 || e >= this.left.length + this.right.length) {
            throw RangeError(
              "Cannot access index `" +
                e +
                "` in a splice buffer of size `" +
                (this.left.length + this.right.length) +
                "`",
            );
          }
          return e < this.left.length
            ? this.left[e]
            : this.right[this.right.length - e + this.left.length - 1];
        }
        get length() {
          return this.left.length + this.right.length;
        }
        shift() {
          return (this.setCursor(0), this.right.pop());
        }
        slice(e, t) {
          let n = null == t ? 1 / 0 : t;
          return n < this.left.length
            ? this.left.slice(e, n)
            : e > this.left.length
              ? this.right
                  .slice(
                    this.right.length - n + this.left.length,
                    this.right.length - e + this.left.length,
                  )
                  .toReversed()
              : this.left
                  .slice(e)
                  .concat(this.right.slice(this.right.length - n + this.left.length).toReversed());
        }
        splice(e, t, n) {
          this.setCursor(Math.trunc(e));
          let r = this.right.splice(this.right.length - (t || 0), 1 / 0);
          return (n && l(this.left, n), r.toReversed());
        }
        pop() {
          return (this.setCursor(1 / 0), this.left.pop());
        }
        push(e) {
          (this.setCursor(1 / 0), this.left.push(e));
        }
        pushMany(e) {
          (this.setCursor(1 / 0), l(this.left, e));
        }
        unshift(e) {
          (this.setCursor(0), this.right.push(e));
        }
        unshiftMany(e) {
          (this.setCursor(0), l(this.right, e.toReversed()));
        }
        setCursor(e) {
          if (
            e !== this.left.length &&
            (!(e > this.left.length) || 0 !== this.right.length) &&
            (!(e < 0) || 0 !== this.left.length)
          ) {
            if (e < this.left.length) {
              let t = this.left.splice(e, 1 / 0);
              l(this.right, t.reverse());
            } else {
              let t = this.right.splice(this.left.length + this.right.length - e, 1 / 0);
              l(this.left, t.reverse());
            }
          }
        }
      }
      function l(e, t) {
        let n = 0;
        if (t.length < 1e4) {
          e.push(...t);
        } else {
          for (; n < t.length; ) (e.push(...t.slice(n, n + 1e4)), (n += 1e4));
        }
      }
      function s(e) {
        let t,
          n,
          r,
          i,
          l,
          s,
          c,
          u = {},
          d = -1,
          p = new o(e);
        for (; ++d < p.length; ) {
          for (; d in u; ) {
            d = u[d];
          }
          if (
            ((t = p.get(d)),
            d &&
              "chunkFlow" === t[1].type &&
              "listItemPrefix" === p.get(d - 1)[1].type &&
              ((r = 0) < (s = t[1]._tokenizer.events).length &&
                "lineEndingBlank" === s[r][1].type &&
                (r += 2),
              r < s.length && "content" === s[r][1].type))
          ) {
            for (; ++r < s.length && "content" !== s[r][1].type; )
              "chunkText" === s[r][1].type && ((s[r][1]._isInFirstContentOfListItem = !0), r++);
          }
          if ("enter" === t[0]) {
            t[1].contentType &&
              (Object.assign(
                u,
                (function (e, t) {
                  let n,
                    r,
                    i = e.get(t)[1],
                    a = e.get(t)[2],
                    o = t - 1,
                    l = [],
                    s = i._tokenizer || a.parser[i.contentType](i.start),
                    c = s.events,
                    u = [],
                    d = {},
                    p = -1,
                    h = i,
                    f = 0,
                    m = 0,
                    T = [0];
                  for (; h; ) {
                    for (; e.get(++o)[1] !== h; );
                    (l.push(o),
                      !h._tokenizer &&
                        ((n = a.sliceStream(h)),
                        h.next || n.push(null),
                        r && s.defineSkip(h.start),
                        h._isInFirstContentOfListItem &&
                          (s._gfmTasklistFirstContentOfListItem = !0),
                        s.write(n),
                        h._isInFirstContentOfListItem &&
                          (s._gfmTasklistFirstContentOfListItem = void 0)),
                      (r = h),
                      (h = h.next));
                  }
                  for (h = i; ++p < c.length; )
                    "exit" === c[p][0] &&
                      "enter" === c[p - 1][0] &&
                      c[p][1].type === c[p - 1][1].type &&
                      c[p][1].start.line !== c[p][1].end.line &&
                      ((m = p + 1),
                      T.push(m),
                      (h._tokenizer = void 0),
                      (h.previous = void 0),
                      (h = h.next));
                  for (
                    s.events = [],
                      h ? ((h._tokenizer = void 0), (h.previous = void 0)) : T.pop(),
                      p = T.length;
                    p--;
                  ) {
                    let t = c.slice(T[p], T[p + 1]),
                      n = l.pop();
                    (u.push([n, n + t.length - 1]), e.splice(n, 2, t));
                  }
                  for (u.reverse(), p = -1; ++p < u.length; )
                    ((d[f + u[p][0]] = f + u[p][1]), (f += u[p][1] - u[p][0] - 1));
                  return d;
                })(p, d),
              ),
              (d = u[d]),
              (c = !0));
          } else if (t[1]._container) {
            for (r = d, n = void 0; r--; ) {
              if ("lineEnding" === (i = p.get(r))[1].type || "lineEndingBlank" === i[1].type)
                "enter" === i[0] &&
                  (n && (p.get(n)[1].type = "lineEndingBlank"),
                  (i[1].type = "lineEnding"),
                  (n = r));
              else break;
            }
            n &&
              ((t[1].end = { ...p.get(n)[1].start }),
              (l = p.slice(n, d)).unshift(t),
              p.splice(n, d - n + 1, l));
          }
        }
        return ((0, a.m)(e, 0, 1 / 0, p.slice(0)), !c);
      }
      var c = n(41451),
        u = n(32335),
        d = n(97058);
      let p = {
          tokenize: function (e) {
            let t,
              n = e.attempt(
                this.parser.constructs.contentInitial,
                function (t) {
                  return null === t
                    ? void e.consume(t)
                    : (e.enter("lineEnding"),
                      e.consume(t),
                      e.exit("lineEnding"),
                      (0, u.N)(e, n, "linePrefix"));
                },
                function (n) {
                  return (
                    e.enter("paragraph"),
                    (function n(r) {
                      let i = e.enter("chunkText", { contentType: "text", previous: t });
                      return (
                        t && (t.next = i),
                        (t = i),
                        (function t(r) {
                          if (null === r) {
                            (e.exit("chunkText"), e.exit("paragraph"), e.consume(r));
                            return;
                          }
                          return (0, d.HP)(r)
                            ? (e.consume(r), e.exit("chunkText"), n)
                            : (e.consume(r), t);
                        })(r)
                      );
                    })(n)
                  );
                },
              );
            return n;
          },
        },
        h = {
          tokenize: function (e) {
            let t,
              n,
              r,
              i = this,
              o = [],
              l = 0;
            return s;
            function s(t) {
              if (l < o.length) {
                let n = o[l];
                return ((i.containerState = n[1]), e.attempt(n[0].continuation, c, u)(t));
              }
              return u(t);
            }
            function c(e) {
              if ((l++, i.containerState._closeFlow)) {
                let n;
                ((i.containerState._closeFlow = void 0), t && I());
                let r = i.events.length,
                  o = r;
                for (; o--; ) {
                  if ("exit" === i.events[o][0] && "chunkFlow" === i.events[o][1].type) {
                    n = i.events[o][1].end;
                    break;
                  }
                }
                E(l);
                let s = r;
                for (; s < i.events.length; ) {
                  ((i.events[s][1].end = Object.assign({}, n)), s++);
                }
                return (
                  (0, a.m)(i.events, o + 1, 0, i.events.slice(r)), (i.events.length = s), u(e)
                );
              }
              return s(e);
            }
            function u(n) {
              if (l === o.length) {
                if (!t) {
                  return m(n);
                }
                if (t.currentConstruct && t.currentConstruct.concrete) {
                  return g(n);
                }
                i.interrupt = !!(t.currentConstruct && !t._gfmTableDynamicInterruptHack);
              }
              return ((i.containerState = {}), e.check(f, p, h)(n));
            }
            function p(e) {
              return (t && I(), E(l), m(e));
            }
            function h(e) {
              return ((i.parser.lazy[i.now().line] = l !== o.length), (r = i.now().offset), g(e));
            }
            function m(t) {
              return ((i.containerState = {}), e.attempt(f, T, g)(t));
            }
            function T(e) {
              return (l++, o.push([i.currentConstruct, i.containerState]), m(e));
            }
            function g(r) {
              if (null === r) {
                (t && I(), E(0), e.consume(r));
                return;
              }
              return (
                (t = t || i.parser.flow(i.now())),
                e.enter("chunkFlow", { contentType: "flow", previous: n, _tokenizer: t }),
                (function t(n) {
                  if (null === n) {
                    (A(e.exit("chunkFlow"), !0), E(0), e.consume(n));
                    return;
                  }
                  return (0, d.HP)(n)
                    ? (e.consume(n), A(e.exit("chunkFlow")), (l = 0), (i.interrupt = void 0), s)
                    : (e.consume(n), t);
                })(r)
              );
            }
            function A(e, o) {
              let s = i.sliceStream(e);
              if (
                (o && s.push(null),
                (e.previous = n),
                n && (n.next = e),
                (n = e),
                t.defineSkip(e.start),
                t.write(s),
                i.parser.lazy[e.start.line])
              ) {
                let e,
                  n,
                  o = t.events.length;
                for (; o--; ) {
                  if (
                    t.events[o][1].start.offset < r &&
                    (!t.events[o][1].end || t.events[o][1].end.offset > r)
                  )
                    return;
                }
                let s = i.events.length,
                  c = s;
                for (; c--; ) {
                  if ("exit" === i.events[c][0] && "chunkFlow" === i.events[c][1].type) {
                    if (e) {
                      n = i.events[c][1].end;
                      break;
                    }
                    e = !0;
                  }
                }
                for (E(l), o = s; o < i.events.length; ) {
                  ((i.events[o][1].end = Object.assign({}, n)), o++);
                }
                ((0, a.m)(i.events, c + 1, 0, i.events.slice(s)), (i.events.length = o));
              }
            }
            function E(t) {
              let n = o.length;
              for (; n-- > t; ) {
                let t = o[n];
                ((i.containerState = t[1]), t[0].exit.call(i, e));
              }
              o.length = t;
            }
            function I() {
              (t.write([null]), (n = void 0), (t = void 0), (i.containerState._closeFlow = void 0));
            }
          },
        },
        f = {
          tokenize: function (e, t, n) {
            return (0, u.N)(
              e,
              e.attempt(this.parser.constructs.document, t, n),
              "linePrefix",
              this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
            );
          },
        };
      var m = n(78867);
      let T = {
          tokenize: function (e, t) {
            let n;
            return function (t) {
              return (
                e.enter("content"), (n = e.enter("chunkContent", { contentType: "content" })), r(t)
              );
            };
            function r(t) {
              return null === t ? i(t) : (0, d.HP)(t) ? e.check(g, a, i)(t) : (e.consume(t), r);
            }
            function i(n) {
              return (e.exit("chunkContent"), e.exit("content"), t(n));
            }
            function a(t) {
              return (
                e.consume(t),
                e.exit("chunkContent"),
                (n.next = e.enter("chunkContent", { contentType: "content", previous: n })),
                (n = n.next),
                r
              );
            }
          },
          resolve: function (e) {
            return (s(e), e);
          },
        },
        g = {
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (
                e.exit("chunkContent"),
                e.enter("lineEnding"),
                e.consume(t),
                e.exit("lineEnding"),
                (0, u.N)(e, i, "linePrefix")
              );
            };
            function i(i) {
              if (null === i || (0, d.HP)(i)) {
                return n(i);
              }
              let a = r.events[r.events.length - 1];
              return !r.parser.constructs.disable.null.includes("codeIndented") &&
                a &&
                "linePrefix" === a[1].type &&
                a[2].sliceSerialize(a[1], !0).length >= 4
                ? t(i)
                : e.interrupt(r.parser.constructs.flow, n, t)(i);
            }
          },
          partial: !0,
        },
        A = {
          tokenize: function (e) {
            let t = this,
              n = e.attempt(
                m.B,
                function (r) {
                  return null === r
                    ? void e.consume(r)
                    : (e.enter("lineEndingBlank"),
                      e.consume(r),
                      e.exit("lineEndingBlank"),
                      (t.currentConstruct = void 0),
                      n);
                },
                e.attempt(
                  this.parser.constructs.flowInitial,
                  r,
                  (0, u.N)(
                    e,
                    e.attempt(this.parser.constructs.flow, r, e.attempt(T, r)),
                    "linePrefix",
                  ),
                ),
              );
            return n;
            function r(r) {
              return null === r
                ? void e.consume(r)
                : (e.enter("lineEnding"),
                  e.consume(r),
                  e.exit("lineEnding"),
                  (t.currentConstruct = void 0),
                  n);
            }
          },
        },
        E = { resolveAll: D() },
        I = k("string"),
        _ = k("text");
      function k(e) {
        return {
          tokenize: function (t) {
            let n = this,
              r = this.parser.constructs[e],
              i = t.attempt(r, a, o);
            return a;
            function a(e) {
              return s(e) ? i(e) : o(e);
            }
            function o(e) {
              return null === e ? void t.consume(e) : (t.enter("data"), t.consume(e), l);
            }
            function l(e) {
              return s(e) ? (t.exit("data"), i(e)) : (t.consume(e), l);
            }
            function s(e) {
              if (null === e) {
                return !0;
              }
              let t = r[e],
                i = -1;
              if (t) {
                for (; ++i < t.length; ) {
                  let e = t[i];
                  if (!e.previous || e.previous.call(n, n.previous)) return !0;
                }
              }
              return !1;
            }
          },
          resolveAll: D("text" === e ? b : void 0),
        };
      }
      function D(e) {
        return function (t, n) {
          let r,
            i = -1;
          for (; ++i <= t.length; ) {
            void 0 === r
              ? t[i] && "data" === t[i][1].type && ((r = i), i++)
              : (t[i] && "data" === t[i][1].type) ||
                (i !== r + 2 &&
                  ((t[r][1].end = t[i - 1][1].end), t.splice(r + 2, i - r - 2), (i = r + 2)),
                (r = void 0));
          }
          return e ? e(t, n) : t;
        };
      }
      function b(e, t) {
        let n = 0;
        for (; ++n <= e.length; ) {
          if ((n === e.length || "lineEnding" === e[n][1].type) && "data" === e[n - 1][1].type) {
            let r,
              i = e[n - 1][1],
              a = t.sliceStream(i),
              o = a.length,
              l = -1,
              s = 0;
            for (; o--; ) {
              let e = a[o];
              if ("string" == typeof e) {
                for (l = e.length; 32 === e.charCodeAt(l - 1); ) (s++, l--);
                if (l) break;
                l = -1;
              } else if (-2 === e) ((r = !0), s++);
              else if (-1 === e);
              else {
                o++;
                break;
              }
            }
            if (s) {
              let a = {
                type: n === e.length || r || s < 2 ? "lineSuffix" : "hardBreakTrailing",
                start: {
                  line: i.end.line,
                  column: i.end.column - s,
                  offset: i.end.offset - s,
                  _index: i.start._index + o,
                  _bufferIndex: o ? l : i.start._bufferIndex + l,
                },
                end: Object.assign({}, i.end),
              };
              ((i.end = Object.assign({}, a.start)),
                i.start.offset === i.end.offset
                  ? Object.assign(i, a)
                  : (e.splice(n, 0, ["enter", a, t], ["exit", a, t]), (n += 2)));
            }
            n++;
          }
        }
        return e;
      }
      var y = n(23195);
      let N = {
          name: "thematicBreak",
          tokenize: function (e, t, n) {
            let r,
              i = 0;
            return function (a) {
              var o;
              return (
                e.enter("thematicBreak"),
                (r = o = a),
                (function a(o) {
                  return o === r
                    ? (e.enter("thematicBreakSequence"),
                      (function t(n) {
                        return n === r
                          ? (e.consume(n), i++, t)
                          : (e.exit("thematicBreakSequence"),
                            (0, d.On)(n) ? (0, u.N)(e, a, "whitespace")(n) : a(n));
                      })(o))
                    : i >= 3 && (null === o || (0, d.HP)(o))
                      ? (e.exit("thematicBreak"), t(o))
                      : n(o);
                })(o)
              );
            };
          },
        },
        S = {
          name: "list",
          tokenize: function (e, t, n) {
            let r = this,
              i = r.events[r.events.length - 1],
              a = i && "linePrefix" === i[1].type ? i[2].sliceSerialize(i[1], !0).length : 0,
              o = 0;
            return function (t) {
              let i =
                r.containerState.type ||
                (42 === t || 43 === t || 45 === t ? "listUnordered" : "listOrdered");
              if (
                "listUnordered" === i
                  ? !r.containerState.marker || t === r.containerState.marker
                  : (0, d.BM)(t)
              ) {
                if (
                  (r.containerState.type ||
                    ((r.containerState.type = i), e.enter(i, { _container: !0 })),
                  "listUnordered" === i)
                ) {
                  return (
                    e.enter("listItemPrefix"), 42 === t || 45 === t ? e.check(N, n, l)(t) : l(t)
                  );
                }
                if (!r.interrupt || 49 === t) {
                  return (
                    e.enter("listItemPrefix"),
                    e.enter("listItemValue"),
                    (function t(i) {
                      return (0, d.BM)(i) && ++o < 10
                        ? (e.consume(i), t)
                        : (!r.interrupt || o < 2) &&
                            (r.containerState.marker
                              ? i === r.containerState.marker
                              : 41 === i || 46 === i)
                          ? (e.exit("listItemValue"), l(i))
                          : n(i);
                    })(t)
                  );
                }
              }
              return n(t);
            };
            function l(t) {
              return (
                e.enter("listItemMarker"),
                e.consume(t),
                e.exit("listItemMarker"),
                (r.containerState.marker = r.containerState.marker || t),
                e.check(m.B, r.interrupt ? n : s, e.attempt(C, u, c))
              );
            }
            function s(e) {
              return ((r.containerState.initialBlankLine = !0), a++, u(e));
            }
            function c(t) {
              return (0, d.On)(t)
                ? (e.enter("listItemPrefixWhitespace"),
                  e.consume(t),
                  e.exit("listItemPrefixWhitespace"),
                  u)
                : n(t);
            }
            function u(n) {
              return (
                (r.containerState.size = a + r.sliceSerialize(e.exit("listItemPrefix"), !0).length),
                t(n)
              );
            }
          },
          continuation: {
            tokenize: function (e, t, n) {
              let r = this;
              return (
                (r.containerState._closeFlow = void 0),
                e.check(
                  m.B,
                  function (n) {
                    return (
                      (r.containerState.furtherBlankLines =
                        r.containerState.furtherBlankLines || r.containerState.initialBlankLine),
                      (0, u.N)(e, t, "listItemIndent", r.containerState.size + 1)(n)
                    );
                  },
                  function (n) {
                    return r.containerState.furtherBlankLines || !(0, d.On)(n)
                      ? ((r.containerState.furtherBlankLines = void 0),
                        (r.containerState.initialBlankLine = void 0),
                        i(n))
                      : ((r.containerState.furtherBlankLines = void 0),
                        (r.containerState.initialBlankLine = void 0),
                        e.attempt(x, t, i)(n));
                  },
                )
              );
              function i(i) {
                return (
                  (r.containerState._closeFlow = !0),
                  (r.interrupt = void 0),
                  (0, u.N)(
                    e,
                    e.attempt(S, t, n),
                    "linePrefix",
                    r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
                  )(i)
                );
              }
            },
          },
          exit: function (e) {
            e.exit(this.containerState.type);
          },
        },
        C = {
          tokenize: function (e, t, n) {
            let r = this;
            return (0, u.N)(
              e,
              function (e) {
                let i = r.events[r.events.length - 1];
                return !(0, d.On)(e) && i && "listItemPrefixWhitespace" === i[1].type ? t(e) : n(e);
              },
              "listItemPrefixWhitespace",
              r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 5,
            );
          },
          partial: !0,
        },
        x = {
          tokenize: function (e, t, n) {
            let r = this;
            return (0, u.N)(
              e,
              function (e) {
                let i = r.events[r.events.length - 1];
                return i &&
                  "listItemIndent" === i[1].type &&
                  i[2].sliceSerialize(i[1], !0).length === r.containerState.size
                  ? t(e)
                  : n(e);
              },
              "listItemIndent",
              r.containerState.size + 1,
            );
          },
          partial: !0,
        },
        L = {
          name: "blockQuote",
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              if (62 === t) {
                let n = r.containerState;
                return (
                  n.open || (e.enter("blockQuote", { _container: !0 }), (n.open = !0)),
                  e.enter("blockQuotePrefix"),
                  e.enter("blockQuoteMarker"),
                  e.consume(t),
                  e.exit("blockQuoteMarker"),
                  i
                );
              }
              return n(t);
            };
            function i(n) {
              return (0, d.On)(n)
                ? (e.enter("blockQuotePrefixWhitespace"),
                  e.consume(n),
                  e.exit("blockQuotePrefixWhitespace"),
                  e.exit("blockQuotePrefix"),
                  t)
                : (e.exit("blockQuotePrefix"), t(n));
            }
          },
          continuation: {
            tokenize: function (e, t, n) {
              let r = this;
              return function (t) {
                return (0, d.On)(t)
                  ? (0, u.N)(
                      e,
                      i,
                      "linePrefix",
                      r.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
                    )(t)
                  : i(t);
              };
              function i(r) {
                return e.attempt(L, t, n)(r);
              }
            },
          },
          exit: function (e) {
            e.exit("blockQuote");
          },
        };
      function v(e, t, n, r, i, a, o, l, s) {
        let c = s || 1 / 0,
          u = 0;
        return function (t) {
          return 60 === t
            ? (e.enter(r), e.enter(i), e.enter(a), e.consume(t), e.exit(a), p)
            : null === t || 32 === t || 41 === t || (0, d.JQ)(t)
              ? n(t)
              : (e.enter(r),
                e.enter(o),
                e.enter(l),
                e.enter("chunkString", { contentType: "string" }),
                m(t));
        };
        function p(n) {
          return 62 === n
            ? (e.enter(a), e.consume(n), e.exit(a), e.exit(i), e.exit(r), t)
            : (e.enter(l), e.enter("chunkString", { contentType: "string" }), h(n));
        }
        function h(t) {
          return 62 === t
            ? (e.exit("chunkString"), e.exit(l), p(t))
            : null === t || 60 === t || (0, d.HP)(t)
              ? n(t)
              : (e.consume(t), 92 === t ? f : h);
        }
        function f(t) {
          return 60 === t || 62 === t || 92 === t ? (e.consume(t), h) : h(t);
        }
        function m(i) {
          return !u && (null === i || 41 === i || (0, d.Ee)(i))
            ? (e.exit("chunkString"), e.exit(l), e.exit(o), e.exit(r), t(i))
            : u < c && 40 === i
              ? (e.consume(i), u++, m)
              : 41 === i
                ? (e.consume(i), u--, m)
                : null === i || 32 === i || 40 === i || (0, d.JQ)(i)
                  ? n(i)
                  : (e.consume(i), 92 === i ? T : m);
        }
        function T(t) {
          return 40 === t || 41 === t || 92 === t ? (e.consume(t), m) : m(t);
        }
      }
      function G(e, t, n, r, i, a) {
        let o,
          l = this,
          s = 0;
        return function (t) {
          return (e.enter(r), e.enter(i), e.consume(t), e.exit(i), e.enter(a), c);
        };
        function c(p) {
          return s > 999 ||
            null === p ||
            91 === p ||
            (93 === p && !o) ||
            (94 === p && !s && "_hiddenFootnoteSupport" in l.parser.constructs)
            ? n(p)
            : 93 === p
              ? (e.exit(a), e.enter(i), e.consume(p), e.exit(i), e.exit(r), t)
              : (0, d.HP)(p)
                ? (e.enter("lineEnding"), e.consume(p), e.exit("lineEnding"), c)
                : (e.enter("chunkString", { contentType: "string" }), u(p));
        }
        function u(t) {
          return null === t || 91 === t || 93 === t || (0, d.HP)(t) || s++ > 999
            ? (e.exit("chunkString"), c(t))
            : (e.consume(t), o || (o = !(0, d.On)(t)), 92 === t ? p : u);
        }
        function p(t) {
          return 91 === t || 92 === t || 93 === t ? (e.consume(t), s++, u) : u(t);
        }
      }
      function O(e, t, n, r, i, a) {
        let o;
        return function (t) {
          return 34 === t || 39 === t || 40 === t
            ? (e.enter(r), e.enter(i), e.consume(t), e.exit(i), (o = 40 === t ? 41 : t), l)
            : n(t);
        };
        function l(n) {
          return n === o ? (e.enter(i), e.consume(n), e.exit(i), e.exit(r), t) : (e.enter(a), s(n));
        }
        function s(t) {
          return t === o
            ? (e.exit(a), l(o))
            : null === t
              ? n(t)
              : (0, d.HP)(t)
                ? (e.enter("lineEnding"),
                  e.consume(t),
                  e.exit("lineEnding"),
                  (0, u.N)(e, s, "linePrefix"))
                : (e.enter("chunkString", { contentType: "string" }), c(t));
        }
        function c(t) {
          return t === o || null === t || (0, d.HP)(t)
            ? (e.exit("chunkString"), s(t))
            : (e.consume(t), 92 === t ? p : c);
        }
        function p(t) {
          return t === o || 92 === t ? (e.consume(t), c) : c(t);
        }
      }
      function M(e, t) {
        let n;
        return function r(i) {
          return (0, d.HP)(i)
            ? (e.enter("lineEnding"), e.consume(i), e.exit("lineEnding"), (n = !0), r)
            : (0, d.On)(i)
              ? (0, u.N)(e, r, n ? "linePrefix" : "lineSuffix")(i)
              : t(i);
        };
      }
      var R = n(20728);
      let P = {
          tokenize: function (e, t, n) {
            return function (t) {
              return (0, d.Ee)(t) ? M(e, r)(t) : n(t);
            };
            function r(t) {
              return O(
                e,
                i,
                n,
                "definitionTitle",
                "definitionTitleMarker",
                "definitionTitleString",
              )(t);
            }
            function i(t) {
              return (0, d.On)(t) ? (0, u.N)(e, a, "whitespace")(t) : a(t);
            }
            function a(e) {
              return null === e || (0, d.HP)(e) ? t(e) : n(e);
            }
          },
          partial: !0,
        },
        w = {
          name: "codeIndented",
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (e.enter("codeIndented"), (0, u.N)(e, i, "linePrefix", 5)(t));
            };
            function i(t) {
              let i = r.events[r.events.length - 1];
              return i && "linePrefix" === i[1].type && i[2].sliceSerialize(i[1], !0).length >= 4
                ? (function t(n) {
                    return null === n
                      ? a(n)
                      : (0, d.HP)(n)
                        ? e.attempt(F, t, a)(n)
                        : (e.enter("codeFlowValue"),
                          (function n(r) {
                            return null === r || (0, d.HP)(r)
                              ? (e.exit("codeFlowValue"), t(r))
                              : (e.consume(r), n);
                          })(n));
                  })(t)
                : n(t);
            }
            function a(n) {
              return (e.exit("codeIndented"), t(n));
            }
          },
        },
        F = {
          tokenize: function (e, t, n) {
            let r = this;
            return i;
            function i(t) {
              return r.parser.lazy[r.now().line]
                ? n(t)
                : (0, d.HP)(t)
                  ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), i)
                  : (0, u.N)(e, a, "linePrefix", 5)(t);
            }
            function a(e) {
              let a = r.events[r.events.length - 1];
              return a && "linePrefix" === a[1].type && a[2].sliceSerialize(a[1], !0).length >= 4
                ? t(e)
                : (0, d.HP)(e)
                  ? i(e)
                  : n(e);
            }
          },
          partial: !0,
        },
        H = {
          name: "setextUnderline",
          tokenize: function (e, t, n) {
            let r,
              i = this;
            return function (t) {
              var o;
              let l,
                s = i.events.length;
              for (; s--; ) {
                if (
                  "lineEnding" !== i.events[s][1].type &&
                  "linePrefix" !== i.events[s][1].type &&
                  "content" !== i.events[s][1].type
                ) {
                  l = "paragraph" === i.events[s][1].type;
                  break;
                }
              }
              return !i.parser.lazy[i.now().line] && (i.interrupt || l)
                ? (e.enter("setextHeadingLine"),
                  (r = t),
                  (o = t),
                  e.enter("setextHeadingLineSequence"),
                  (function t(n) {
                    return n === r
                      ? (e.consume(n), t)
                      : (e.exit("setextHeadingLineSequence"),
                        (0, d.On)(n) ? (0, u.N)(e, a, "lineSuffix")(n) : a(n));
                  })(o))
                : n(t);
            };
            function a(r) {
              return null === r || (0, d.HP)(r) ? (e.exit("setextHeadingLine"), t(r)) : n(r);
            }
          },
          resolveTo: function (e, t) {
            let n,
              r,
              i,
              a = e.length;
            for (; a--; ) {
              if ("enter" === e[a][0]) {
                if ("content" === e[a][1].type) {
                  n = a;
                  break;
                }
                "paragraph" === e[a][1].type && (r = a);
              } else
                ("content" === e[a][1].type && e.splice(a, 1),
                  i || "definition" !== e[a][1].type || (i = a));
            }
            let o = {
              type: "setextHeading",
              start: Object.assign({}, e[r][1].start),
              end: Object.assign({}, e[e.length - 1][1].end),
            };
            return (
              (e[r][1].type = "setextHeadingText"),
              i
                ? (e.splice(r, 0, ["enter", o, t]),
                  e.splice(i + 1, 0, ["exit", e[n][1], t]),
                  (e[n][1].end = Object.assign({}, e[i][1].end)))
                : (e[n][1] = o),
              e.push(["exit", o, t]),
              e
            );
          },
        },
        B = new Set([
          "address",
          "article",
          "aside",
          "base",
          "basefont",
          "blockquote",
          "body",
          "caption",
          "center",
          "col",
          "colgroup",
          "dd",
          "details",
          "dialog",
          "dir",
          "div",
          "dl",
          "dt",
          "fieldset",
          "figcaption",
          "figure",
          "footer",
          "form",
          "frame",
          "frameset",
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "head",
          "header",
          "hr",
          "html",
          "iframe",
          "legend",
          "li",
          "link",
          "main",
          "menu",
          "menuitem",
          "nav",
          "noframes",
          "ol",
          "optgroup",
          "option",
          "p",
          "param",
          "search",
          "section",
          "summary",
          "table",
          "tbody",
          "td",
          "tfoot",
          "th",
          "thead",
          "title",
          "tr",
          "track",
          "ul",
        ]),
        U = ["pre", "script", "style", "textarea"],
        q = {
          tokenize: function (e, t, n) {
            return function (r) {
              return (
                e.enter("lineEnding"), e.consume(r), e.exit("lineEnding"), e.attempt(m.B, t, n)
              );
            };
          },
          partial: !0,
        },
        z = {
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (0, d.HP)(t)
                ? (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), i)
                : n(t);
            };
            function i(e) {
              return r.parser.lazy[r.now().line] ? n(e) : t(e);
            }
          },
          partial: !0,
        },
        W = {
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return null === t
                ? n(t)
                : (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), i);
            };
            function i(e) {
              return r.parser.lazy[r.now().line] ? n(e) : t(e);
            }
          },
          partial: !0,
        },
        V = {
          name: "codeFenced",
          tokenize: function (e, t, n) {
            let r,
              i = this,
              a = {
                tokenize: function (e, t, n) {
                  let a = 0;
                  return function (t) {
                    return (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), o);
                  };
                  function o(t) {
                    return (
                      e.enter("codeFencedFence"),
                      (0, d.On)(t)
                        ? (0, u.N)(
                            e,
                            s,
                            "linePrefix",
                            i.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
                          )(t)
                        : s(t)
                    );
                  }
                  function s(t) {
                    return t === r
                      ? (e.enter("codeFencedFenceSequence"),
                        (function t(i) {
                          return i === r
                            ? (a++, e.consume(i), t)
                            : a >= l
                              ? (e.exit("codeFencedFenceSequence"),
                                (0, d.On)(i) ? (0, u.N)(e, c, "whitespace")(i) : c(i))
                              : n(i);
                        })(t))
                      : n(t);
                  }
                  function c(r) {
                    return null === r || (0, d.HP)(r) ? (e.exit("codeFencedFence"), t(r)) : n(r);
                  }
                },
                partial: !0,
              },
              o = 0,
              l = 0;
            return function (t) {
              var a = t;
              let c = i.events[i.events.length - 1];
              return (
                (o = c && "linePrefix" === c[1].type ? c[2].sliceSerialize(c[1], !0).length : 0),
                (r = a),
                e.enter("codeFenced"),
                e.enter("codeFencedFence"),
                e.enter("codeFencedFenceSequence"),
                (function t(i) {
                  return i === r
                    ? (l++, e.consume(i), t)
                    : l < 3
                      ? n(i)
                      : (e.exit("codeFencedFenceSequence"),
                        (0, d.On)(i) ? (0, u.N)(e, s, "whitespace")(i) : s(i));
                })(a)
              );
            };
            function s(a) {
              return null === a || (0, d.HP)(a)
                ? (e.exit("codeFencedFence"), i.interrupt ? t(a) : e.check(W, p, T)(a))
                : (e.enter("codeFencedFenceInfo"),
                  e.enter("chunkString", { contentType: "string" }),
                  (function t(i) {
                    return null === i || (0, d.HP)(i)
                      ? (e.exit("chunkString"), e.exit("codeFencedFenceInfo"), s(i))
                      : (0, d.On)(i)
                        ? (e.exit("chunkString"),
                          e.exit("codeFencedFenceInfo"),
                          (0, u.N)(e, c, "whitespace")(i))
                        : 96 === i && i === r
                          ? n(i)
                          : (e.consume(i), t);
                  })(a));
            }
            function c(t) {
              return null === t || (0, d.HP)(t)
                ? s(t)
                : (e.enter("codeFencedFenceMeta"),
                  e.enter("chunkString", { contentType: "string" }),
                  (function t(i) {
                    return null === i || (0, d.HP)(i)
                      ? (e.exit("chunkString"), e.exit("codeFencedFenceMeta"), s(i))
                      : 96 === i && i === r
                        ? n(i)
                        : (e.consume(i), t);
                  })(t));
            }
            function p(t) {
              return e.attempt(a, T, h)(t);
            }
            function h(t) {
              return (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), f);
            }
            function f(t) {
              return o > 0 && (0, d.On)(t) ? (0, u.N)(e, m, "linePrefix", o + 1)(t) : m(t);
            }
            function m(t) {
              return null === t || (0, d.HP)(t)
                ? e.check(W, p, T)(t)
                : (e.enter("codeFlowValue"),
                  (function t(n) {
                    return null === n || (0, d.HP)(n)
                      ? (e.exit("codeFlowValue"), m(n))
                      : (e.consume(n), t);
                  })(t));
            }
            function T(n) {
              return (e.exit("codeFenced"), t(n));
            }
          },
          concrete: !0,
        };
      var Y = n(4110);
      let j = {
          name: "characterReference",
          tokenize: function (e, t, n) {
            let r,
              i,
              a = this,
              o = 0;
            return function (t) {
              return (
                e.enter("characterReference"),
                e.enter("characterReferenceMarker"),
                e.consume(t),
                e.exit("characterReferenceMarker"),
                l
              );
            };
            function l(t) {
              return 35 === t
                ? (e.enter("characterReferenceMarkerNumeric"),
                  e.consume(t),
                  e.exit("characterReferenceMarkerNumeric"),
                  s)
                : (e.enter("characterReferenceValue"), (r = 31), (i = d.lV), c(t));
            }
            function s(t) {
              return 88 === t || 120 === t
                ? (e.enter("characterReferenceMarkerHexadecimal"),
                  e.consume(t),
                  e.exit("characterReferenceMarkerHexadecimal"),
                  e.enter("characterReferenceValue"),
                  (r = 6),
                  (i = d.ok),
                  c)
                : (e.enter("characterReferenceValue"), (r = 7), (i = d.BM), c(t));
            }
            function c(l) {
              if (59 === l && o) {
                let r = e.exit("characterReferenceValue");
                return i !== d.lV || (0, Y.s)(a.sliceSerialize(r))
                  ? (e.enter("characterReferenceMarker"),
                    e.consume(l),
                    e.exit("characterReferenceMarker"),
                    e.exit("characterReference"),
                    t)
                  : n(l);
              }
              return i(l) && o++ < r ? (e.consume(l), c) : n(l);
            }
          },
        },
        X = {
          name: "characterEscape",
          tokenize: function (e, t, n) {
            return function (t) {
              return (
                e.enter("characterEscape"),
                e.enter("escapeMarker"),
                e.consume(t),
                e.exit("escapeMarker"),
                r
              );
            };
            function r(r) {
              return (0, d.ol)(r)
                ? (e.enter("characterEscapeValue"),
                  e.consume(r),
                  e.exit("characterEscapeValue"),
                  e.exit("characterEscape"),
                  t)
                : n(r);
            }
          },
        },
        K = {
          name: "lineEnding",
          tokenize: function (e, t) {
            return function (n) {
              return (
                e.enter("lineEnding"),
                e.consume(n),
                e.exit("lineEnding"),
                (0, u.N)(e, t, "linePrefix")
              );
            };
          },
        },
        Q = {
          name: "labelEnd",
          tokenize: function (e, t, n) {
            let r,
              i,
              a = this,
              o = a.events.length;
            for (; o--; )
              if (
                ("labelImage" === a.events[o][1].type || "labelLink" === a.events[o][1].type) &&
                !a.events[o][1]._balanced
              ) {
                r = a.events[o][1];
                break;
              }
            return function (t) {
              return r
                ? r._inactive
                  ? u(t)
                  : ((i = a.parser.defined.includes(
                      (0, R.B)(a.sliceSerialize({ start: r.end, end: a.now() })),
                    )),
                    e.enter("labelEnd"),
                    e.enter("labelMarker"),
                    e.consume(t),
                    e.exit("labelMarker"),
                    e.exit("labelEnd"),
                    l)
                : n(t);
            };
            function l(t) {
              return 40 === t
                ? e.attempt($, c, i ? c : u)(t)
                : 91 === t
                  ? e.attempt(J, c, i ? s : u)(t)
                  : i
                    ? c(t)
                    : u(t);
            }
            function s(t) {
              return e.attempt(Z, c, u)(t);
            }
            function c(e) {
              return t(e);
            }
            function u(e) {
              return ((r._balanced = !0), n(e));
            }
          },
          resolveTo: function (e, t) {
            let n,
              r,
              i,
              o,
              l = e.length,
              s = 0;
            for (; l--; )
              if (((n = e[l][1]), r)) {
                if ("link" === n.type || ("labelLink" === n.type && n._inactive)) break;
                "enter" === e[l][0] && "labelLink" === n.type && (n._inactive = !0);
              } else if (i) {
                if (
                  "enter" === e[l][0] &&
                  ("labelImage" === n.type || "labelLink" === n.type) &&
                  !n._balanced &&
                  ((r = l), "labelLink" !== n.type)
                ) {
                  s = 2;
                  break;
                }
              } else "labelEnd" === n.type && (i = l);
            let c = {
                type: "labelLink" === e[r][1].type ? "link" : "image",
                start: Object.assign({}, e[r][1].start),
                end: Object.assign({}, e[e.length - 1][1].end),
              },
              u = {
                type: "label",
                start: Object.assign({}, e[r][1].start),
                end: Object.assign({}, e[i][1].end),
              },
              d = {
                type: "labelText",
                start: Object.assign({}, e[r + s + 2][1].end),
                end: Object.assign({}, e[i - 2][1].start),
              };
            return (
              (o = [
                ["enter", c, t],
                ["enter", u, t],
              ]),
              (o = (0, a.V)(o, e.slice(r + 1, r + s + 3))),
              (o = (0, a.V)(o, [["enter", d, t]])),
              (o = (0, a.V)(
                o,
                (0, y.W)(t.parser.constructs.insideSpan.null, e.slice(r + s + 4, i - 3), t),
              )),
              (o = (0, a.V)(o, [["exit", d, t], e[i - 2], e[i - 1], ["exit", u, t]])),
              (o = (0, a.V)(o, e.slice(i + 1))),
              (o = (0, a.V)(o, [["exit", c, t]])),
              (0, a.m)(e, r, e.length, o),
              e
            );
          },
          resolveAll: function (e) {
            let t = -1;
            for (; ++t < e.length; ) {
              let n = e[t][1];
              ("labelImage" === n.type || "labelLink" === n.type || "labelEnd" === n.type) &&
                (e.splice(t + 1, "labelImage" === n.type ? 4 : 2), (n.type = "data"), t++);
            }
            return e;
          },
        },
        $ = {
          tokenize: function (e, t, n) {
            return function (t) {
              return (
                e.enter("resource"),
                e.enter("resourceMarker"),
                e.consume(t),
                e.exit("resourceMarker"),
                r
              );
            };
            function r(t) {
              return (0, d.Ee)(t) ? M(e, i)(t) : i(t);
            }
            function i(t) {
              return 41 === t
                ? c(t)
                : v(
                    e,
                    a,
                    o,
                    "resourceDestination",
                    "resourceDestinationLiteral",
                    "resourceDestinationLiteralMarker",
                    "resourceDestinationRaw",
                    "resourceDestinationString",
                    32,
                  )(t);
            }
            function a(t) {
              return (0, d.Ee)(t) ? M(e, l)(t) : c(t);
            }
            function o(e) {
              return n(e);
            }
            function l(t) {
              return 34 === t || 39 === t || 40 === t
                ? O(e, s, n, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(t)
                : c(t);
            }
            function s(t) {
              return (0, d.Ee)(t) ? M(e, c)(t) : c(t);
            }
            function c(r) {
              return 41 === r
                ? (e.enter("resourceMarker"),
                  e.consume(r),
                  e.exit("resourceMarker"),
                  e.exit("resource"),
                  t)
                : n(r);
            }
          },
        },
        J = {
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return G.call(r, e, i, a, "reference", "referenceMarker", "referenceString")(t);
            };
            function i(e) {
              return r.parser.defined.includes(
                (0, R.B)(r.sliceSerialize(r.events[r.events.length - 1][1]).slice(1, -1)),
              )
                ? t(e)
                : n(e);
            }
            function a(e) {
              return n(e);
            }
          },
        },
        Z = {
          tokenize: function (e, t, n) {
            return function (t) {
              return (
                e.enter("reference"),
                e.enter("referenceMarker"),
                e.consume(t),
                e.exit("referenceMarker"),
                r
              );
            };
            function r(r) {
              return 93 === r
                ? (e.enter("referenceMarker"),
                  e.consume(r),
                  e.exit("referenceMarker"),
                  e.exit("reference"),
                  t)
                : n(r);
            }
          },
        },
        ee = {
          name: "labelStartImage",
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (
                e.enter("labelImage"),
                e.enter("labelImageMarker"),
                e.consume(t),
                e.exit("labelImageMarker"),
                i
              );
            };
            function i(t) {
              return 91 === t
                ? (e.enter("labelMarker"),
                  e.consume(t),
                  e.exit("labelMarker"),
                  e.exit("labelImage"),
                  a)
                : n(t);
            }
            function a(e) {
              return 94 === e && "_hiddenFootnoteSupport" in r.parser.constructs ? n(e) : t(e);
            }
          },
          resolveAll: Q.resolveAll,
        };
      var et = n(36753);
      let en = {
        name: "attention",
        tokenize: function (e, t) {
          let n,
            r = this.parser.constructs.attentionMarkers.null,
            i = this.previous,
            a = (0, et.S)(i);
          return function (o) {
            return (
              (n = o),
              e.enter("attentionSequence"),
              (function o(l) {
                if (l === n) return (e.consume(l), o);
                let s = e.exit("attentionSequence"),
                  c = (0, et.S)(l),
                  u = !c || (2 === c && a) || r.includes(l),
                  d = !a || (2 === a && c) || r.includes(i);
                return (
                  (s._open = !!(42 === n ? u : u && (a || !d))),
                  (s._close = !!(42 === n ? d : d && (c || !u))),
                  t(l)
                );
              })(o)
            );
          };
        },
        resolveAll: function (e, t) {
          let n,
            r,
            i,
            o,
            l,
            s,
            c,
            u,
            d = -1;
          for (; ++d < e.length; )
            if ("enter" === e[d][0] && "attentionSequence" === e[d][1].type && e[d][1]._close) {
              for (n = d; n--; )
                if (
                  "exit" === e[n][0] &&
                  "attentionSequence" === e[n][1].type &&
                  e[n][1]._open &&
                  t.sliceSerialize(e[n][1]).charCodeAt(0) ===
                    t.sliceSerialize(e[d][1]).charCodeAt(0)
                ) {
                  if (
                    (e[n][1]._close || e[d][1]._open) &&
                    (e[d][1].end.offset - e[d][1].start.offset) % 3 &&
                    !(
                      (e[n][1].end.offset -
                        e[n][1].start.offset +
                        e[d][1].end.offset -
                        e[d][1].start.offset) %
                      3
                    )
                  )
                    continue;
                  s =
                    e[n][1].end.offset - e[n][1].start.offset > 1 &&
                    e[d][1].end.offset - e[d][1].start.offset > 1
                      ? 2
                      : 1;
                  let p = Object.assign({}, e[n][1].end),
                    h = Object.assign({}, e[d][1].start);
                  (er(p, -s),
                    er(h, s),
                    (o = {
                      type: s > 1 ? "strongSequence" : "emphasisSequence",
                      start: p,
                      end: Object.assign({}, e[n][1].end),
                    }),
                    (l = {
                      type: s > 1 ? "strongSequence" : "emphasisSequence",
                      start: Object.assign({}, e[d][1].start),
                      end: h,
                    }),
                    (i = {
                      type: s > 1 ? "strongText" : "emphasisText",
                      start: Object.assign({}, e[n][1].end),
                      end: Object.assign({}, e[d][1].start),
                    }),
                    (r = {
                      type: s > 1 ? "strong" : "emphasis",
                      start: Object.assign({}, o.start),
                      end: Object.assign({}, l.end),
                    }),
                    (e[n][1].end = Object.assign({}, o.start)),
                    (e[d][1].start = Object.assign({}, l.end)),
                    (c = []),
                    e[n][1].end.offset - e[n][1].start.offset &&
                      (c = (0, a.V)(c, [
                        ["enter", e[n][1], t],
                        ["exit", e[n][1], t],
                      ])),
                    (c = (0, a.V)(c, [
                      ["enter", r, t],
                      ["enter", o, t],
                      ["exit", o, t],
                      ["enter", i, t],
                    ])),
                    (c = (0, a.V)(
                      c,
                      (0, y.W)(t.parser.constructs.insideSpan.null, e.slice(n + 1, d), t),
                    )),
                    (c = (0, a.V)(c, [
                      ["exit", i, t],
                      ["enter", l, t],
                      ["exit", l, t],
                      ["exit", r, t],
                    ])),
                    e[d][1].end.offset - e[d][1].start.offset
                      ? ((u = 2),
                        (c = (0, a.V)(c, [
                          ["enter", e[d][1], t],
                          ["exit", e[d][1], t],
                        ])))
                      : (u = 0),
                    (0, a.m)(e, n - 1, d - n + 3, c),
                    (d = n + c.length - u - 2));
                  break;
                }
            }
          for (d = -1; ++d < e.length; )
            "attentionSequence" === e[d][1].type && (e[d][1].type = "data");
          return e;
        },
      };
      function er(e, t) {
        ((e.column += t), (e.offset += t), (e._bufferIndex += t));
      }
      let ei = {
          name: "labelStartLink",
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (
                e.enter("labelLink"),
                e.enter("labelMarker"),
                e.consume(t),
                e.exit("labelMarker"),
                e.exit("labelLink"),
                i
              );
            };
            function i(e) {
              return 94 === e && "_hiddenFootnoteSupport" in r.parser.constructs ? n(e) : t(e);
            }
          },
          resolveAll: Q.resolveAll,
        },
        ea = {
          42: S,
          43: S,
          45: S,
          48: S,
          49: S,
          50: S,
          51: S,
          52: S,
          53: S,
          54: S,
          55: S,
          56: S,
          57: S,
          62: L,
        },
        eo = {
          91: {
            name: "definition",
            tokenize: function (e, t, n) {
              let r,
                i = this;
              return function (t) {
                var r;
                return (
                  e.enter("definition"),
                  (r = t),
                  G.call(
                    i,
                    e,
                    a,
                    n,
                    "definitionLabel",
                    "definitionLabelMarker",
                    "definitionLabelString",
                  )(r)
                );
              };
              function a(t) {
                return ((r = (0, R.B)(
                  i.sliceSerialize(i.events[i.events.length - 1][1]).slice(1, -1),
                )),
                58 === t)
                  ? (e.enter("definitionMarker"), e.consume(t), e.exit("definitionMarker"), o)
                  : n(t);
              }
              function o(t) {
                return (0, d.Ee)(t) ? M(e, l)(t) : l(t);
              }
              function l(t) {
                return v(
                  e,
                  s,
                  n,
                  "definitionDestination",
                  "definitionDestinationLiteral",
                  "definitionDestinationLiteralMarker",
                  "definitionDestinationRaw",
                  "definitionDestinationString",
                )(t);
              }
              function s(t) {
                return e.attempt(P, c, c)(t);
              }
              function c(t) {
                return (0, d.On)(t) ? (0, u.N)(e, p, "whitespace")(t) : p(t);
              }
              function p(a) {
                return null === a || (0, d.HP)(a)
                  ? (e.exit("definition"), i.parser.defined.push(r), t(a))
                  : n(a);
              }
            },
          },
        },
        el = { [-2]: w, [-1]: w, 32: w },
        es = {
          35: {
            name: "headingAtx",
            tokenize: function (e, t, n) {
              let r = 0;
              return function (i) {
                var a;
                return (
                  e.enter("atxHeading"),
                  (a = i),
                  e.enter("atxHeadingSequence"),
                  (function i(a) {
                    return 35 === a && r++ < 6
                      ? (e.consume(a), i)
                      : null === a || (0, d.Ee)(a)
                        ? (e.exit("atxHeadingSequence"),
                          (function n(r) {
                            return 35 === r
                              ? (e.enter("atxHeadingSequence"),
                                (function t(r) {
                                  return 35 === r
                                    ? (e.consume(r), t)
                                    : (e.exit("atxHeadingSequence"), n(r));
                                })(r))
                              : null === r || (0, d.HP)(r)
                                ? (e.exit("atxHeading"), t(r))
                                : (0, d.On)(r)
                                  ? (0, u.N)(e, n, "whitespace")(r)
                                  : (e.enter("atxHeadingText"),
                                    (function t(r) {
                                      return null === r || 35 === r || (0, d.Ee)(r)
                                        ? (e.exit("atxHeadingText"), n(r))
                                        : (e.consume(r), t);
                                    })(r));
                          })(a))
                        : n(a);
                  })(a)
                );
              };
            },
            resolve: function (e, t) {
              let n,
                r,
                i = e.length - 2,
                o = 3;
              return (
                "whitespace" === e[3][1].type && (o += 2),
                i - 2 > o && "whitespace" === e[i][1].type && (i -= 2),
                "atxHeadingSequence" === e[i][1].type &&
                  (o === i - 1 || (i - 4 > o && "whitespace" === e[i - 2][1].type)) &&
                  (i -= o + 1 === i ? 2 : 4),
                i > o &&
                  ((n = { type: "atxHeadingText", start: e[o][1].start, end: e[i][1].end }),
                  (r = {
                    type: "chunkText",
                    start: e[o][1].start,
                    end: e[i][1].end,
                    contentType: "text",
                  }),
                  (0, a.m)(e, o, i - o + 1, [
                    ["enter", n, t],
                    ["enter", r, t],
                    ["exit", r, t],
                    ["exit", n, t],
                  ])),
                e
              );
            },
          },
          42: N,
          45: [H, N],
          60: {
            name: "htmlFlow",
            tokenize: function (e, t, n) {
              let r,
                i,
                a,
                o,
                l,
                s = this;
              return function (t) {
                var n;
                return ((n = t), e.enter("htmlFlow"), e.enter("htmlFlowData"), e.consume(n), c);
              };
              function c(o) {
                return 33 === o
                  ? (e.consume(o), u)
                  : 47 === o
                    ? (e.consume(o), (i = !0), f)
                    : 63 === o
                      ? (e.consume(o), (r = 3), s.interrupt ? t : O)
                      : (0, d.CW)(o)
                        ? (e.consume(o), (a = String.fromCharCode(o)), m)
                        : n(o);
              }
              function u(i) {
                return 45 === i
                  ? (e.consume(i), (r = 2), p)
                  : 91 === i
                    ? (e.consume(i), (r = 5), (o = 0), h)
                    : (0, d.CW)(i)
                      ? (e.consume(i), (r = 4), s.interrupt ? t : O)
                      : n(i);
              }
              function p(r) {
                return 45 === r ? (e.consume(r), s.interrupt ? t : O) : n(r);
              }
              function h(r) {
                let i = "CDATA[";
                return r === i.charCodeAt(o++)
                  ? (e.consume(r), o === i.length)
                    ? s.interrupt
                      ? t
                      : y
                    : h
                  : n(r);
              }
              function f(t) {
                return (0, d.CW)(t) ? (e.consume(t), (a = String.fromCharCode(t)), m) : n(t);
              }
              function m(o) {
                if (null === o || 47 === o || 62 === o || (0, d.Ee)(o)) {
                  let l = 47 === o,
                    c = a.toLowerCase();
                  return !l && !i && U.includes(c)
                    ? ((r = 1), s.interrupt ? t(o) : y(o))
                    : B.has(a.toLowerCase())
                      ? ((r = 6), l)
                        ? (e.consume(o), T)
                        : s.interrupt
                          ? t(o)
                          : y(o)
                      : ((r = 7),
                        s.interrupt && !s.parser.lazy[s.now().line]
                          ? n(o)
                          : i
                            ? (function t(n) {
                                return (0, d.On)(n) ? (e.consume(n), t) : D(n);
                              })(o)
                            : g(o));
                }
                return 45 === o || (0, d.lV)(o)
                  ? (e.consume(o), (a += String.fromCharCode(o)), m)
                  : n(o);
              }
              function T(r) {
                return 62 === r ? (e.consume(r), s.interrupt ? t : y) : n(r);
              }
              function g(t) {
                return 47 === t
                  ? (e.consume(t), D)
                  : 58 === t || 95 === t || (0, d.CW)(t)
                    ? (e.consume(t), A)
                    : (0, d.On)(t)
                      ? (e.consume(t), g)
                      : D(t);
              }
              function A(t) {
                return 45 === t || 46 === t || 58 === t || 95 === t || (0, d.lV)(t)
                  ? (e.consume(t), A)
                  : E(t);
              }
              function E(t) {
                return 61 === t ? (e.consume(t), I) : (0, d.On)(t) ? (e.consume(t), E) : g(t);
              }
              function I(t) {
                return null === t || 60 === t || 61 === t || 62 === t || 96 === t
                  ? n(t)
                  : 34 === t || 39 === t
                    ? (e.consume(t), (l = t), _)
                    : (0, d.On)(t)
                      ? (e.consume(t), I)
                      : (function t(n) {
                          return null === n ||
                            34 === n ||
                            39 === n ||
                            47 === n ||
                            60 === n ||
                            61 === n ||
                            62 === n ||
                            96 === n ||
                            (0, d.Ee)(n)
                            ? E(n)
                            : (e.consume(n), t);
                        })(t);
              }
              function _(t) {
                return t === l
                  ? (e.consume(t), (l = null), k)
                  : null === t || (0, d.HP)(t)
                    ? n(t)
                    : (e.consume(t), _);
              }
              function k(e) {
                return 47 === e || 62 === e || (0, d.On)(e) ? g(e) : n(e);
              }
              function D(t) {
                return 62 === t ? (e.consume(t), b) : n(t);
              }
              function b(t) {
                return null === t || (0, d.HP)(t) ? y(t) : (0, d.On)(t) ? (e.consume(t), b) : n(t);
              }
              function y(t) {
                return 45 === t && 2 === r
                  ? (e.consume(t), x)
                  : 60 === t && 1 === r
                    ? (e.consume(t), L)
                    : 62 === t && 4 === r
                      ? (e.consume(t), M)
                      : 63 === t && 3 === r
                        ? (e.consume(t), O)
                        : 93 === t && 5 === r
                          ? (e.consume(t), G)
                          : (0, d.HP)(t) && (6 === r || 7 === r)
                            ? (e.exit("htmlFlowData"), e.check(q, R, N)(t))
                            : null === t || (0, d.HP)(t)
                              ? (e.exit("htmlFlowData"), N(t))
                              : (e.consume(t), y);
              }
              function N(t) {
                return e.check(z, S, R)(t);
              }
              function S(t) {
                return (e.enter("lineEnding"), e.consume(t), e.exit("lineEnding"), C);
              }
              function C(t) {
                return null === t || (0, d.HP)(t) ? N(t) : (e.enter("htmlFlowData"), y(t));
              }
              function x(t) {
                return 45 === t ? (e.consume(t), O) : y(t);
              }
              function L(t) {
                return 47 === t ? (e.consume(t), (a = ""), v) : y(t);
              }
              function v(t) {
                if (62 === t) {
                  let n = a.toLowerCase();
                  return U.includes(n) ? (e.consume(t), M) : y(t);
                }
                return (0, d.CW)(t) && a.length < 8
                  ? (e.consume(t), (a += String.fromCharCode(t)), v)
                  : y(t);
              }
              function G(t) {
                return 93 === t ? (e.consume(t), O) : y(t);
              }
              function O(t) {
                return 62 === t
                  ? (e.consume(t), M)
                  : 45 === t && 2 === r
                    ? (e.consume(t), O)
                    : y(t);
              }
              function M(t) {
                return null === t || (0, d.HP)(t)
                  ? (e.exit("htmlFlowData"), R(t))
                  : (e.consume(t), M);
              }
              function R(n) {
                return (e.exit("htmlFlow"), t(n));
              }
            },
            resolveTo: function (e) {
              let t = e.length;
              for (; t-- && ("enter" !== e[t][0] || "htmlFlow" !== e[t][1].type); ) {}
              return (
                t > 1 &&
                  "linePrefix" === e[t - 2][1].type &&
                  ((e[t][1].start = e[t - 2][1].start),
                  (e[t + 1][1].start = e[t - 2][1].start),
                  e.splice(t - 2, 2)),
                e
              );
            },
            concrete: !0,
          },
          61: H,
          95: N,
          96: V,
          126: V,
        },
        ec = { 38: j, 92: X },
        eu = {
          [-5]: K,
          [-4]: K,
          [-3]: K,
          33: ee,
          38: j,
          42: en,
          60: [
            {
              name: "autolink",
              tokenize: function (e, t, n) {
                let r = 0;
                return function (t) {
                  return (
                    e.enter("autolink"),
                    e.enter("autolinkMarker"),
                    e.consume(t),
                    e.exit("autolinkMarker"),
                    e.enter("autolinkProtocol"),
                    i
                  );
                };
                function i(t) {
                  return (0, d.CW)(t) ? (e.consume(t), a) : l(t);
                }
                function a(t) {
                  return 43 === t || 45 === t || 46 === t || (0, d.lV)(t)
                    ? ((r = 1),
                      (function t(n) {
                        return 58 === n
                          ? (e.consume(n), (r = 0), o)
                          : (43 === n || 45 === n || 46 === n || (0, d.lV)(n)) && r++ < 32
                            ? (e.consume(n), t)
                            : ((r = 0), l(n));
                      })(t))
                    : l(t);
                }
                function o(r) {
                  return 62 === r
                    ? (e.exit("autolinkProtocol"),
                      e.enter("autolinkMarker"),
                      e.consume(r),
                      e.exit("autolinkMarker"),
                      e.exit("autolink"),
                      t)
                    : null === r || 32 === r || 60 === r || (0, d.JQ)(r)
                      ? n(r)
                      : (e.consume(r), o);
                }
                function l(t) {
                  return 64 === t ? (e.consume(t), s) : (0, d.cx)(t) ? (e.consume(t), l) : n(t);
                }
                function s(i) {
                  return (0, d.lV)(i)
                    ? (function i(a) {
                        return 46 === a
                          ? (e.consume(a), (r = 0), s)
                          : 62 === a
                            ? ((e.exit("autolinkProtocol").type = "autolinkEmail"),
                              e.enter("autolinkMarker"),
                              e.consume(a),
                              e.exit("autolinkMarker"),
                              e.exit("autolink"),
                              t)
                            : (function t(a) {
                                if ((45 === a || (0, d.lV)(a)) && r++ < 63) {
                                  let n = 45 === a ? t : i;
                                  return (e.consume(a), n);
                                }
                                return n(a);
                              })(a);
                      })(i)
                    : n(i);
                }
              },
            },
            {
              name: "htmlText",
              tokenize: function (e, t, n) {
                let r,
                  i,
                  a,
                  o = this;
                return function (t) {
                  return (e.enter("htmlText"), e.enter("htmlTextData"), e.consume(t), l);
                };
                function l(t) {
                  return 33 === t
                    ? (e.consume(t), s)
                    : 47 === t
                      ? (e.consume(t), k)
                      : 63 === t
                        ? (e.consume(t), I)
                        : (0, d.CW)(t)
                          ? (e.consume(t), b)
                          : n(t);
                }
                function s(t) {
                  return 45 === t
                    ? (e.consume(t), c)
                    : 91 === t
                      ? (e.consume(t), (i = 0), m)
                      : (0, d.CW)(t)
                        ? (e.consume(t), E)
                        : n(t);
                }
                function c(t) {
                  return 45 === t ? (e.consume(t), f) : n(t);
                }
                function p(t) {
                  return null === t
                    ? n(t)
                    : 45 === t
                      ? (e.consume(t), h)
                      : (0, d.HP)(t)
                        ? ((a = p), G(t))
                        : (e.consume(t), p);
                }
                function h(t) {
                  return 45 === t ? (e.consume(t), f) : p(t);
                }
                function f(e) {
                  return 62 === e ? v(e) : 45 === e ? h(e) : p(e);
                }
                function m(t) {
                  let r = "CDATA[";
                  return t === r.charCodeAt(i++) ? (e.consume(t), i === r.length ? T : m) : n(t);
                }
                function T(t) {
                  return null === t
                    ? n(t)
                    : 93 === t
                      ? (e.consume(t), g)
                      : (0, d.HP)(t)
                        ? ((a = T), G(t))
                        : (e.consume(t), T);
                }
                function g(t) {
                  return 93 === t ? (e.consume(t), A) : T(t);
                }
                function A(t) {
                  return 62 === t ? v(t) : 93 === t ? (e.consume(t), A) : T(t);
                }
                function E(t) {
                  return null === t || 62 === t
                    ? v(t)
                    : (0, d.HP)(t)
                      ? ((a = E), G(t))
                      : (e.consume(t), E);
                }
                function I(t) {
                  return null === t
                    ? n(t)
                    : 63 === t
                      ? (e.consume(t), _)
                      : (0, d.HP)(t)
                        ? ((a = I), G(t))
                        : (e.consume(t), I);
                }
                function _(e) {
                  return 62 === e ? v(e) : I(e);
                }
                function k(t) {
                  return (0, d.CW)(t) ? (e.consume(t), D) : n(t);
                }
                function D(t) {
                  return 45 === t || (0, d.lV)(t)
                    ? (e.consume(t), D)
                    : (function t(n) {
                        return (0, d.HP)(n)
                          ? ((a = t), G(n))
                          : (0, d.On)(n)
                            ? (e.consume(n), t)
                            : v(n);
                      })(t);
                }
                function b(t) {
                  return 45 === t || (0, d.lV)(t)
                    ? (e.consume(t), b)
                    : 47 === t || 62 === t || (0, d.Ee)(t)
                      ? y(t)
                      : n(t);
                }
                function y(t) {
                  return 47 === t
                    ? (e.consume(t), v)
                    : 58 === t || 95 === t || (0, d.CW)(t)
                      ? (e.consume(t), N)
                      : (0, d.HP)(t)
                        ? ((a = y), G(t))
                        : (0, d.On)(t)
                          ? (e.consume(t), y)
                          : v(t);
                }
                function N(t) {
                  return 45 === t || 46 === t || 58 === t || 95 === t || (0, d.lV)(t)
                    ? (e.consume(t), N)
                    : (function t(n) {
                        return 61 === n
                          ? (e.consume(n), S)
                          : (0, d.HP)(n)
                            ? ((a = t), G(n))
                            : (0, d.On)(n)
                              ? (e.consume(n), t)
                              : y(n);
                      })(t);
                }
                function S(t) {
                  return null === t || 60 === t || 61 === t || 62 === t || 96 === t
                    ? n(t)
                    : 34 === t || 39 === t
                      ? (e.consume(t), (r = t), C)
                      : (0, d.HP)(t)
                        ? ((a = S), G(t))
                        : (0, d.On)(t)
                          ? (e.consume(t), S)
                          : (e.consume(t), x);
                }
                function C(t) {
                  return t === r
                    ? (e.consume(t), (r = void 0), L)
                    : null === t
                      ? n(t)
                      : (0, d.HP)(t)
                        ? ((a = C), G(t))
                        : (e.consume(t), C);
                }
                function x(t) {
                  return null === t || 34 === t || 39 === t || 60 === t || 61 === t || 96 === t
                    ? n(t)
                    : 47 === t || 62 === t || (0, d.Ee)(t)
                      ? y(t)
                      : (e.consume(t), x);
                }
                function L(e) {
                  return 47 === e || 62 === e || (0, d.Ee)(e) ? y(e) : n(e);
                }
                function v(r) {
                  return 62 === r
                    ? (e.consume(r), e.exit("htmlTextData"), e.exit("htmlText"), t)
                    : n(r);
                }
                function G(t) {
                  return (
                    e.exit("htmlTextData"),
                    e.enter("lineEnding"),
                    e.consume(t),
                    e.exit("lineEnding"),
                    O
                  );
                }
                function O(t) {
                  return (0, d.On)(t)
                    ? (0, u.N)(
                        e,
                        M,
                        "linePrefix",
                        o.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
                      )(t)
                    : M(t);
                }
                function M(t) {
                  return (e.enter("htmlTextData"), a(t));
                }
              },
            },
          ],
          91: ei,
          92: [
            {
              name: "hardBreakEscape",
              tokenize: function (e, t, n) {
                return function (t) {
                  return (e.enter("hardBreakEscape"), e.consume(t), r);
                };
                function r(r) {
                  return (0, d.HP)(r) ? (e.exit("hardBreakEscape"), t(r)) : n(r);
                }
              },
            },
            X,
          ],
          93: Q,
          95: en,
          96: {
            name: "codeText",
            tokenize: function (e, t, n) {
              let r,
                i,
                a = 0;
              return function (t) {
                return (
                  e.enter("codeText"),
                  e.enter("codeTextSequence"),
                  (function t(n) {
                    return 96 === n ? (e.consume(n), a++, t) : (e.exit("codeTextSequence"), o(n));
                  })(t)
                );
              };
              function o(s) {
                return null === s
                  ? n(s)
                  : 32 === s
                    ? (e.enter("space"), e.consume(s), e.exit("space"), o)
                    : 96 === s
                      ? ((i = e.enter("codeTextSequence")),
                        (r = 0),
                        (function n(o) {
                          return 96 === o
                            ? (e.consume(o), r++, n)
                            : r === a
                              ? (e.exit("codeTextSequence"), e.exit("codeText"), t(o))
                              : ((i.type = "codeTextData"), l(o));
                        })(s))
                      : (0, d.HP)(s)
                        ? (e.enter("lineEnding"), e.consume(s), e.exit("lineEnding"), o)
                        : (e.enter("codeTextData"), l(s));
              }
              function l(t) {
                return null === t || 32 === t || 96 === t || (0, d.HP)(t)
                  ? (e.exit("codeTextData"), o(t))
                  : (e.consume(t), l);
              }
            },
            resolve: function (e) {
              let t,
                n,
                r = e.length - 4,
                i = 3;
              if (
                ("lineEnding" === e[3][1].type || "space" === e[i][1].type) &&
                ("lineEnding" === e[r][1].type || "space" === e[r][1].type)
              ) {
                for (t = i; ++t < r; ) {
                  if ("codeTextData" === e[t][1].type) {
                    ((e[i][1].type = "codeTextPadding"),
                      (e[r][1].type = "codeTextPadding"),
                      (i += 2),
                      (r -= 2));
                    break;
                  }
                }
              }
              for (t = i - 1, r++; ++t <= r; ) {
                void 0 === n
                  ? t !== r && "lineEnding" !== e[t][1].type && (n = t)
                  : (t === r || "lineEnding" === e[t][1].type) &&
                    ((e[n][1].type = "codeTextData"),
                    t !== n + 2 &&
                      ((e[n][1].end = e[t - 1][1].end),
                      e.splice(n + 2, t - n - 2),
                      (r -= t - n - 2),
                      (t = n + 2)),
                    (n = void 0));
              }
              return e;
            },
            previous: function (e) {
              return 96 !== e || "characterEscape" === this.events[this.events.length - 1][1].type;
            },
          },
        },
        ed = { null: [en, E] },
        ep = { null: [42, 95] },
        eh = { null: [] },
        ef = /[\0\t\n\r]/g;
      var em = n(64651),
        eT = n(69465),
        eg = n(13546);
      let eA = {}.hasOwnProperty;
      function eE(e) {
        return { line: e.line, column: e.column, offset: e.offset };
      }
      function eI(e, t) {
        if (e) {
          throw Error(
            "Cannot close `" +
              e.type +
              "` (" +
              (0, eg.L)({ start: e.start, end: e.end }) +
              "): a different token (`" +
              t.type +
              "`, " +
              (0, eg.L)({ start: t.start, end: t.end }) +
              ") is open",
          );
        }
        throw Error(
          "Cannot close document, a token (`" +
            t.type +
            "`, " +
            (0, eg.L)({ start: t.start, end: t.end }) +
            ") is still open",
        );
      }
      function e_(e) {
        let t = this;
        t.parser = function (n) {
          var o, l;
          let u, f, m, T;
          return (
            "string" !=
              typeof (o = {
                ...t.data("settings"),
                ...e,
                extensions: t.data("micromarkExtensions") || [],
                mdastExtensions: t.data("fromMarkdownExtensions") || [],
              }) && ((l = o), (o = void 0)),
            (function (e) {
              let t = {
                transforms: [],
                canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
                enter: {
                  autolink: r(A),
                  autolinkProtocol: u,
                  autolinkEmail: u,
                  atxHeading: r(m),
                  blockQuote: r(function () {
                    return { type: "blockquote", children: [] };
                  }),
                  characterEscape: u,
                  characterReference: u,
                  codeFenced: r(f),
                  codeFencedFenceInfo: a,
                  codeFencedFenceMeta: a,
                  codeIndented: r(f, a),
                  codeText: r(function () {
                    return { type: "inlineCode", value: "" };
                  }, a),
                  codeTextData: u,
                  data: u,
                  codeFlowValue: u,
                  definition: r(function () {
                    return {
                      type: "definition",
                      identifier: "",
                      label: null,
                      title: null,
                      url: "",
                    };
                  }),
                  definitionDestinationString: a,
                  definitionLabelString: a,
                  definitionTitleString: a,
                  emphasis: r(function () {
                    return { type: "emphasis", children: [] };
                  }),
                  hardBreakEscape: r(T),
                  hardBreakTrailing: r(T),
                  htmlFlow: r(g, a),
                  htmlFlowData: u,
                  htmlText: r(g, a),
                  htmlTextData: u,
                  image: r(function () {
                    return { type: "image", title: null, url: "", alt: null };
                  }),
                  label: a,
                  link: r(A),
                  listItem: r(function (e) {
                    return { type: "listItem", spread: e._spread, checked: null, children: [] };
                  }),
                  listItemValue: function (e) {
                    this.data.expectingFirstListItemValue &&
                      ((this.stack[this.stack.length - 2].start = Number.parseInt(
                        this.sliceSerialize(e),
                        10,
                      )),
                      (this.data.expectingFirstListItemValue = void 0));
                  },
                  listOrdered: r(E, function () {
                    this.data.expectingFirstListItemValue = !0;
                  }),
                  listUnordered: r(E),
                  paragraph: r(function () {
                    return { type: "paragraph", children: [] };
                  }),
                  reference: function () {
                    this.data.referenceType = "collapsed";
                  },
                  referenceString: a,
                  resourceDestinationString: a,
                  resourceTitleString: a,
                  setextHeading: r(m),
                  strong: r(function () {
                    return { type: "strong", children: [] };
                  }),
                  thematicBreak: r(function () {
                    return { type: "thematicBreak" };
                  }),
                },
                exit: {
                  atxHeading: l(),
                  atxHeadingSequence: function (e) {
                    let t = this.stack[this.stack.length - 1];
                    t.depth || (t.depth = this.sliceSerialize(e).length);
                  },
                  autolink: l(),
                  autolinkEmail: function (e) {
                    (d.call(this, e),
                      (this.stack[this.stack.length - 1].url = "mailto:" + this.sliceSerialize(e)));
                  },
                  autolinkProtocol: function (e) {
                    (d.call(this, e),
                      (this.stack[this.stack.length - 1].url = this.sliceSerialize(e)));
                  },
                  blockQuote: l(),
                  characterEscapeValue: d,
                  characterReferenceMarkerHexadecimal: h,
                  characterReferenceMarkerNumeric: h,
                  characterReferenceValue: function (e) {
                    let t,
                      n = this.sliceSerialize(e),
                      r = this.data.characterReferenceType;
                    r
                      ? ((t = (0, em.C)(n, "characterReferenceMarkerNumeric" === r ? 10 : 16)),
                        (this.data.characterReferenceType = void 0))
                      : (t = (0, Y.s)(n));
                    let i = this.stack.pop();
                    ((i.value += t), (i.position.end = eE(e.end)));
                  },
                  codeFenced: l(function () {
                    let e = this.resume();
                    ((this.stack[this.stack.length - 1].value = e.replace(
                      /^(\r?\n|\r)|(\r?\n|\r)$/g,
                      "",
                    )),
                      (this.data.flowCodeInside = void 0));
                  }),
                  codeFencedFence: function () {
                    this.data.flowCodeInside || (this.buffer(), (this.data.flowCodeInside = !0));
                  },
                  codeFencedFenceInfo: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].lang = e;
                  },
                  codeFencedFenceMeta: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].meta = e;
                  },
                  codeFlowValue: d,
                  codeIndented: l(function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].value = e.replace(/(\r?\n|\r)$/g, "");
                  }),
                  codeText: l(function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].value = e;
                  }),
                  codeTextData: d,
                  data: d,
                  definition: l(),
                  definitionDestinationString: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].url = e;
                  },
                  definitionLabelString: function (e) {
                    let t = this.resume(),
                      n = this.stack[this.stack.length - 1];
                    ((n.label = t),
                      (n.identifier = (0, R.B)(this.sliceSerialize(e)).toLowerCase()));
                  },
                  definitionTitleString: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].title = e;
                  },
                  emphasis: l(),
                  hardBreakEscape: l(p),
                  hardBreakTrailing: l(p),
                  htmlFlow: l(function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].value = e;
                  }),
                  htmlFlowData: d,
                  htmlText: l(function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].value = e;
                  }),
                  htmlTextData: d,
                  image: l(function () {
                    let e = this.stack[this.stack.length - 1];
                    if (this.data.inReference) {
                      let t = this.data.referenceType || "shortcut";
                      ((e.type += "Reference"),
                        (e.referenceType = t),
                        delete e.url,
                        delete e.title);
                    } else {
                      (delete e.identifier, delete e.label);
                    }
                    this.data.referenceType = void 0;
                  }),
                  label: function () {
                    let e = this.stack[this.stack.length - 1],
                      t = this.resume(),
                      n = this.stack[this.stack.length - 1];
                    ((this.data.inReference = !0),
                      "link" === n.type ? (n.children = e.children) : (n.alt = t));
                  },
                  labelText: function (e) {
                    let t = this.sliceSerialize(e),
                      n = this.stack[this.stack.length - 2];
                    ((n.label = (0, eT.s)(t)), (n.identifier = (0, R.B)(t).toLowerCase()));
                  },
                  lineEnding: function (e) {
                    let n = this.stack[this.stack.length - 1];
                    if (this.data.atHardBreak) {
                      ((n.children[n.children.length - 1].position.end = eE(e.end)),
                        (this.data.atHardBreak = void 0));
                      return;
                    }
                    !this.data.setextHeadingSlurpLineEnding &&
                      t.canContainEols.includes(n.type) &&
                      (u.call(this, e), d.call(this, e));
                  },
                  link: l(function () {
                    let e = this.stack[this.stack.length - 1];
                    if (this.data.inReference) {
                      let t = this.data.referenceType || "shortcut";
                      ((e.type += "Reference"),
                        (e.referenceType = t),
                        delete e.url,
                        delete e.title);
                    } else {
                      (delete e.identifier, delete e.label);
                    }
                    this.data.referenceType = void 0;
                  }),
                  listItem: l(),
                  listOrdered: l(),
                  listUnordered: l(),
                  paragraph: l(),
                  referenceString: function (e) {
                    let t = this.resume(),
                      n = this.stack[this.stack.length - 1];
                    ((n.label = t),
                      (n.identifier = (0, R.B)(this.sliceSerialize(e)).toLowerCase()),
                      (this.data.referenceType = "full"));
                  },
                  resourceDestinationString: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].url = e;
                  },
                  resourceTitleString: function () {
                    let e = this.resume();
                    this.stack[this.stack.length - 1].title = e;
                  },
                  resource: function () {
                    this.data.inReference = void 0;
                  },
                  setextHeading: l(function () {
                    this.data.setextHeadingSlurpLineEnding = void 0;
                  }),
                  setextHeadingLineSequence: function (e) {
                    this.stack[this.stack.length - 1].depth =
                      61 === this.sliceSerialize(e).codePointAt(0) ? 1 : 2;
                  },
                  setextHeadingText: function () {
                    this.data.setextHeadingSlurpLineEnding = !0;
                  },
                  strong: l(),
                  thematicBreak: l(),
                },
              };
              !(function e(t, n) {
                let r = -1;
                for (; ++r < n.length; ) {
                  let i = n[r];
                  Array.isArray(i)
                    ? e(t, i)
                    : (function (e, t) {
                        let n;
                        for (n in t) {
                          if (eA.call(t, n))
                            switch (n) {
                              case "canContainEols": {
                                let r = t[n];
                                r && e[n].push(...r);
                                break;
                              }
                              case "transforms": {
                                let r = t[n];
                                r && e[n].push(...r);
                                break;
                              }
                              case "enter":
                              case "exit": {
                                let r = t[n];
                                r && Object.assign(e[n], r);
                              }
                            }
                        }
                      })(t, i);
                }
              })(t, (e || {}).mdastExtensions || []);
              let n = {};
              return function (e) {
                let r = { type: "root", children: [] },
                  i = {
                    stack: [r],
                    tokenStack: [],
                    config: t,
                    enter: o,
                    exit: s,
                    buffer: a,
                    resume: c,
                    data: n,
                  },
                  l = [],
                  u = -1;
                for (; ++u < e.length; ) {
                  ("listOrdered" === e[u][1].type || "listUnordered" === e[u][1].type) &&
                    ("enter" === e[u][0]
                      ? l.push(u)
                      : (u = (function (e, t, n) {
                          let r,
                            i,
                            a,
                            o,
                            l = t - 1,
                            s = -1,
                            c = !1;
                          for (; ++l <= n; ) {
                            let t = e[l];
                            switch (t[1].type) {
                              case "listUnordered":
                              case "listOrdered":
                              case "blockQuote":
                                ("enter" === t[0] ? s++ : s--, (o = void 0));
                                break;
                              case "lineEndingBlank":
                                "enter" === t[0] && (!r || o || s || a || (a = l), (o = void 0));
                                break;
                              case "linePrefix":
                              case "listItemValue":
                              case "listItemMarker":
                              case "listItemPrefix":
                              case "listItemPrefixWhitespace":
                                break;
                              default:
                                o = void 0;
                            }
                            if (
                              (!s && "enter" === t[0] && "listItemPrefix" === t[1].type) ||
                              (-1 === s &&
                                "exit" === t[0] &&
                                ("listUnordered" === t[1].type || "listOrdered" === t[1].type))
                            ) {
                              if (r) {
                                let o = l;
                                for (i = void 0; o--; ) {
                                  let t = e[o];
                                  if (
                                    "lineEnding" === t[1].type ||
                                    "lineEndingBlank" === t[1].type
                                  ) {
                                    if ("exit" === t[0]) continue;
                                    (i && ((e[i][1].type = "lineEndingBlank"), (c = !0)),
                                      (t[1].type = "lineEnding"),
                                      (i = o));
                                  } else if (
                                    "linePrefix" === t[1].type ||
                                    "blockQuotePrefix" === t[1].type ||
                                    "blockQuotePrefixWhitespace" === t[1].type ||
                                    "blockQuoteMarker" === t[1].type ||
                                    "listItemIndent" === t[1].type
                                  );
                                  else break;
                                }
                                (a && (!i || a < i) && (r._spread = !0),
                                  (r.end = Object.assign({}, i ? e[i][1].start : t[1].end)),
                                  e.splice(i || l, 0, ["exit", r, t[2]]),
                                  l++,
                                  n++);
                              }
                              if ("listItemPrefix" === t[1].type) {
                                let i = {
                                  type: "listItem",
                                  _spread: !1,
                                  start: Object.assign({}, t[1].start),
                                  end: void 0,
                                };
                                ((r = i),
                                  e.splice(l, 0, ["enter", i, t[2]]),
                                  l++,
                                  n++,
                                  (a = void 0),
                                  (o = !0));
                              }
                            }
                          }
                          return ((e[t][1]._spread = c), n);
                        })(e, l.pop(), u)));
                }
                for (u = -1; ++u < e.length; ) {
                  let n = t[e[u][0]];
                  eA.call(n, e[u][1].type) &&
                    n[e[u][1].type].call(
                      Object.assign({ sliceSerialize: e[u][2].sliceSerialize }, i),
                      e[u][1],
                    );
                }
                if (i.tokenStack.length > 0) {
                  let e = i.tokenStack[i.tokenStack.length - 1];
                  (e[1] || eI).call(i, void 0, e[0]);
                }
                for (
                  r.position = {
                    start: eE(e.length > 0 ? e[0][1].start : { line: 1, column: 1, offset: 0 }),
                    end: eE(
                      e.length > 0 ? e[e.length - 2][1].end : { line: 1, column: 1, offset: 0 },
                    ),
                  },
                    u = -1;
                  ++u < t.transforms.length;
                ) {
                  r = t.transforms[u](r) || r;
                }
                return r;
              };
              function r(e, t) {
                return function (n) {
                  (o.call(this, e(n), n), t && t.call(this, n));
                };
              }
              function a() {
                this.stack.push({ type: "fragment", children: [] });
              }
              function o(e, t, n) {
                (this.stack[this.stack.length - 1].children.push(e),
                  this.stack.push(e),
                  this.tokenStack.push([t, n]),
                  (e.position = { start: eE(t.start), end: void 0 }));
              }
              function l(e) {
                return function (t) {
                  (e && e.call(this, t), s.call(this, t));
                };
              }
              function s(e, t) {
                let n = this.stack.pop(),
                  r = this.tokenStack.pop();
                if (r) {
                  r[0].type !== e.type &&
                    (t ? t.call(this, e, r[0]) : (r[1] || eI).call(this, e, r[0]));
                } else {
                  throw Error(
                    "Cannot close `" +
                      e.type +
                      "` (" +
                      (0, eg.L)({ start: e.start, end: e.end }) +
                      "): it’s not open",
                  );
                }
                n.position.end = eE(e.end);
              }
              function c() {
                return (0, i.d)(this.stack.pop());
              }
              function u(e) {
                let t = this.stack[this.stack.length - 1].children,
                  n = t[t.length - 1];
                ((n && "text" === n.type) ||
                  (((n = { type: "text", value: "" }).position = {
                    start: eE(e.start),
                    end: void 0,
                  }),
                  t.push(n)),
                  this.stack.push(n));
              }
              function d(e) {
                let t = this.stack.pop();
                ((t.value += this.sliceSerialize(e)), (t.position.end = eE(e.end)));
              }
              function p() {
                this.data.atHardBreak = !0;
              }
              function h(e) {
                this.data.characterReferenceType = e.type;
              }
              function f() {
                return { type: "code", lang: null, meta: null, value: "" };
              }
              function m() {
                return { type: "heading", depth: 0, children: [] };
              }
              function T() {
                return { type: "break" };
              }
              function g() {
                return { type: "html", value: "" };
              }
              function A() {
                return { type: "link", title: null, url: "", children: [] };
              }
              function E(e) {
                return {
                  type: "list",
                  ordered: "listOrdered" === e.type,
                  start: null,
                  spread: e._spread,
                  children: [],
                };
              }
            })(l)(
              (function (e) {
                for (; !s(e); ) {}
                return e;
              })(
                (function (e) {
                  let t = {
                    defined: [],
                    lazy: {},
                    constructs: (0, c.y)([r, ...((e || {}).extensions || [])]),
                    content: n(p),
                    document: n(h),
                    flow: n(A),
                    string: n(I),
                    text: n(_),
                  };
                  return t;
                  function n(e) {
                    return function (n) {
                      return (function (e, t, n) {
                        let r = Object.assign(
                            n ? Object.assign({}, n) : { line: 1, column: 1, offset: 0 },
                            { _index: 0, _bufferIndex: -1 },
                          ),
                          i = {},
                          o = [],
                          l = [],
                          s = [],
                          c = {
                            consume: function (e) {
                              ((0, d.HP)(e)
                                ? (r.line++, (r.column = 1), (r.offset += -3 === e ? 2 : 1), A())
                                : -1 !== e && (r.column++, r.offset++),
                                r._bufferIndex < 0
                                  ? r._index++
                                  : (r._bufferIndex++,
                                    r._bufferIndex === l[r._index].length &&
                                      ((r._bufferIndex = -1), r._index++)),
                                (u.previous = e));
                            },
                            enter: function (e, t) {
                              let n = t || {};
                              return (
                                (n.type = e),
                                (n.start = f()),
                                u.events.push(["enter", n, u]),
                                s.push(n),
                                n
                              );
                            },
                            exit: function (e) {
                              let t = s.pop();
                              return ((t.end = f()), u.events.push(["exit", t, u]), t);
                            },
                            attempt: T(function (e, t) {
                              g(e, t.from);
                            }),
                            check: T(m),
                            interrupt: T(m, { interrupt: !0 }),
                          },
                          u = {
                            previous: null,
                            code: null,
                            containerState: {},
                            events: [],
                            parser: e,
                            sliceStream: h,
                            sliceSerialize: function (e, t) {
                              return (function (e, t) {
                                let n,
                                  r = -1,
                                  i = [];
                                for (; ++r < e.length; ) {
                                  let a,
                                    o = e[r];
                                  if ("string" == typeof o) {
                                    a = o;
                                  } else {
                                    switch (o) {
                                      case -5:
                                        a = "\r";
                                        break;
                                      case -4:
                                        a = "\n";
                                        break;
                                      case -3:
                                        a = "\r\n";
                                        break;
                                      case -2:
                                        a = t ? " " : "	";
                                        break;
                                      case -1:
                                        if (!t && n) continue;
                                        a = " ";
                                        break;
                                      default:
                                        a = String.fromCharCode(o);
                                    }
                                  }
                                  ((n = -2 === o), i.push(a));
                                }
                                return i.join("");
                              })(h(e), t);
                            },
                            now: f,
                            defineSkip: function (e) {
                              ((i[e.line] = e.column), A());
                            },
                            write: function (e) {
                              return ((l = (0, a.V)(l, e)),
                              (function () {
                                let e;
                                for (; r._index < l.length; ) {
                                  let n = l[r._index];
                                  if ("string" == typeof n) {
                                    for (
                                      e = r._index, r._bufferIndex < 0 && (r._bufferIndex = 0);
                                      r._index === e && r._bufferIndex < n.length;
                                    ) {
                                      var t;
                                      ((t = n.charCodeAt(r._bufferIndex)), (p = p(t)));
                                    }
                                  } else {
                                    p = p(n);
                                  }
                                }
                              })(),
                              null !== l[l.length - 1])
                                ? []
                                : (g(t, 0), (u.events = (0, y.W)(o, u.events, u)), u.events);
                            },
                          },
                          p = t.tokenize.call(u, c);
                        return (t.resolveAll && o.push(t), u);
                        function h(e) {
                          return (function (e, t) {
                            let n,
                              r = t.start._index,
                              i = t.start._bufferIndex,
                              a = t.end._index,
                              o = t.end._bufferIndex;
                            if (r === a) {
                              n = [e[r].slice(i, o)];
                            } else {
                              if (((n = e.slice(r, a)), i > -1)) {
                                let e = n[0];
                                "string" == typeof e ? (n[0] = e.slice(i)) : n.shift();
                              }
                              o > 0 && n.push(e[a].slice(0, o));
                            }
                            return n;
                          })(l, e);
                        }
                        function f() {
                          let { line: e, column: t, offset: n, _index: i, _bufferIndex: a } = r;
                          return { line: e, column: t, offset: n, _index: i, _bufferIndex: a };
                        }
                        function m(e, t) {
                          t.restore();
                        }
                        function T(e, t) {
                          return function (n, i, a) {
                            var o;
                            let l, d, p, h;
                            return Array.isArray(n)
                              ? m(n)
                              : "tokenize" in n
                                ? m([n])
                                : ((o = n),
                                  function (e) {
                                    let t = null !== e && o[e],
                                      n = null !== e && o.null;
                                    return m([
                                      ...(Array.isArray(t) ? t : t ? [t] : []),
                                      ...(Array.isArray(n) ? n : n ? [n] : []),
                                    ])(e);
                                  });
                            function m(e) {
                              return ((l = e), (d = 0), 0 === e.length) ? a : T(e[d]);
                            }
                            function T(e) {
                              return function (n) {
                                return ((h = (function () {
                                  let e = f(),
                                    t = u.previous,
                                    n = u.currentConstruct,
                                    i = u.events.length,
                                    a = Array.from(s);
                                  return {
                                    restore: function () {
                                      ((r = e),
                                        (u.previous = t),
                                        (u.currentConstruct = n),
                                        (u.events.length = i),
                                        (s = a),
                                        A());
                                    },
                                    from: i,
                                  };
                                })()),
                                (p = e),
                                e.partial || (u.currentConstruct = e),
                                e.name && u.parser.constructs.disable.null.includes(e.name))
                                  ? E(n)
                                  : e.tokenize.call(
                                      t ? Object.assign(Object.create(u), t) : u,
                                      c,
                                      g,
                                      E,
                                    )(n);
                              };
                            }
                            function g(t) {
                              return (e(p, h), i);
                            }
                            function E(e) {
                              return (h.restore(), ++d < l.length) ? T(l[d]) : a;
                            }
                          };
                        }
                        function g(e, t) {
                          (e.resolveAll && !o.includes(e) && o.push(e),
                            e.resolve &&
                              (0, a.m)(
                                u.events,
                                t,
                                u.events.length - t,
                                e.resolve(u.events.slice(t), u),
                              ),
                            e.resolveTo && (u.events = e.resolveTo(u.events, u)));
                        }
                        function A() {
                          r.line in i &&
                            r.column < 2 &&
                            ((r.column = i[r.line]), (r.offset += i[r.line] - 1));
                        }
                      })(t, e, n);
                    };
                  }
                })(l)
                  .document()
                  .write(
                    ((f = 1),
                    (m = ""),
                    (T = !0),
                    function (e, t, n) {
                      let r,
                        i,
                        a,
                        o,
                        l,
                        s = [];
                      for (
                        e =
                          m +
                          ("string" == typeof e
                            ? e.toString()
                            : new TextDecoder(t || void 0).decode(e)),
                          a = 0,
                          m = "",
                          T && (65279 === e.charCodeAt(0) && a++, (T = void 0));
                        a < e.length;
                      ) {
                        if (
                          ((ef.lastIndex = a),
                          (o = (r = ef.exec(e)) && void 0 !== r.index ? r.index : e.length),
                          (l = e.charCodeAt(o)),
                          !r)
                        ) {
                          m = e.slice(a);
                          break;
                        }
                        if (10 === l && a === o && u) {
                          (s.push(-3), (u = void 0));
                        } else {
                          switch (
                            (u && (s.push(-5), (u = void 0)),
                            a < o && (s.push(e.slice(a, o)), (f += o - a)),
                            l)
                          ) {
                            case 0:
                              (s.push(65533), f++);
                              break;
                            case 9:
                              for (i = 4 * Math.ceil(f / 4), s.push(-2); f++ < i; ) s.push(-1);
                              break;
                            case 10:
                              (s.push(-4), (f = 1));
                              break;
                            default:
                              ((u = !0), (f = 1));
                          }
                        }
                        a = o + 1;
                      }
                      return (n && (u && s.push(-5), m && s.push(m), s.push(null)), s);
                    })(n, o, !0),
                  ),
              ),
            )
          );
        };
      }
    },
    64651: (e, t, n) => {
      "use strict";
      function r(e, t) {
        let n = Number.parseInt(e, t);
        return n < 9 ||
          11 === n ||
          (n > 13 && n < 32) ||
          (n > 126 && n < 160) ||
          (n > 55295 && n < 57344) ||
          (n > 64975 && n < 65008) ||
          (65535 & n) == 65535 ||
          (65535 & n) == 65534 ||
          n > 1114111
          ? "�"
          : String.fromCodePoint(n);
      }
      n.d(t, { C: () => r });
    },
    65436: (e) => {
      "use strict";
      e.exports = TypeError;
    },
    67113: (e) => {
      "use strict";
      e.exports = ReferenceError;
    },
    69465: (e, t, n) => {
      "use strict";
      n.d(t, { s: () => o });
      var r = n(4110),
        i = n(64651);
      let a = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
      function o(e) {
        return e.replace(a, l);
      }
      function l(e, t, n) {
        if (t) {
          return t;
        }
        if (35 === n.charCodeAt(0)) {
          let e = n.charCodeAt(1),
            t = 120 === e || 88 === e;
          return (0, i.C)(n.slice(t ? 2 : 1), t ? 16 : 10);
        }
        return (0, r.s)(n) || e;
      }
    },
    70333: (e, t, n) => {
      "use strict";
      n.d(t, { C: () => r });
      let r = function (e) {
        var t, n;
        if (null == e) {
          return a;
        }
        if ("function" == typeof e) {
          return i(e);
        }
        if ("object" == typeof e) {
          return Array.isArray(e)
            ? (function (e) {
                let t = [],
                  n = -1;
                for (; ++n < e.length; ) {
                  t[n] = r(e[n]);
                }
                return i(function (...e) {
                  let n = -1;
                  for (; ++n < t.length; ) {
                    if (t[n].apply(this, e)) return !0;
                  }
                  return !1;
                });
              })(e)
            : ((t = e),
              i(function (e) {
                let n;
                for (n in t) {
                  if (e[n] !== t[n]) return !1;
                }
                return !0;
              }));
        }
        if ("string" == typeof e) {
          return (
            (n = e),
            i(function (e) {
              return e && e.type === n;
            })
          );
        }
        throw Error("Expected function, string, or object as test");
      };
      function i(e) {
        return function (t, n, r) {
          return !!(
            (function (e) {
              return null !== e && "object" == typeof e && "type" in e;
            })(t) && e.call(this, t, "number" == typeof n ? n : void 0, r || void 0)
          );
        };
      }
      function a() {
        return !0;
      }
    },
    72805: (e, t, n) => {
      "use strict";
      function r(e, t, n, r) {
        let i,
          a = e.length,
          o = 0;
        if (
          ((t = t < 0 ? (-t > a ? 0 : a + t) : t > a ? a : t), (n = n > 0 ? n : 0), r.length < 1e4)
        ) {
          ((i = Array.from(r)).unshift(t, n), e.splice(...i));
        } else {
          for (n && e.splice(t, n); o < r.length; )
            ((i = r.slice(o, o + 1e4)).unshift(t, 0), e.splice(...i), (o += 1e4), (t += 1e4));
        }
      }
      function i(e, t) {
        return e.length > 0 ? (r(e, e.length, 0, t), e) : t;
      }
      n.d(t, { V: () => i, m: () => r });
    },
    74799: (e, t, n) => {
      "use strict";
      function r() {}
      n.d(t, { ok: () => r });
    },
    75726: (e, t, n) => {
      "use strict";
      n.d(t, { i: () => a });
      var r = n(28814),
        i = n(51456);
      class a {
        constructor(e) {
          ((this.handler = e),
            (this.html = ""),
            (this.pos = -1),
            (this.lastGapPos = -2),
            (this.gapStack = []),
            (this.skipNextNewLine = !1),
            (this.lastChunkWritten = !1),
            (this.endOfChunkHit = !1),
            (this.bufferWaterline = 65536),
            (this.isEol = !1),
            (this.lineStartPos = 0),
            (this.droppedBufferSize = 0),
            (this.line = 1),
            (this.lastErrOffset = -1));
        }
        get col() {
          return this.pos - this.lineStartPos + Number(this.lastGapPos !== this.pos);
        }
        get offset() {
          return this.droppedBufferSize + this.pos;
        }
        getError(e) {
          let { line: t, col: n, offset: r } = this;
          return {
            code: e,
            startLine: t,
            endLine: t,
            startCol: n,
            endCol: n,
            startOffset: r,
            endOffset: r,
          };
        }
        _err(e) {
          this.handler.onParseError &&
            this.lastErrOffset !== this.offset &&
            ((this.lastErrOffset = this.offset), this.handler.onParseError(this.getError(e)));
        }
        _addGap() {
          (this.gapStack.push(this.lastGapPos), (this.lastGapPos = this.pos));
        }
        _processSurrogate(e) {
          if (this.pos !== this.html.length - 1) {
            let t = this.html.charCodeAt(this.pos + 1);
            if ((0, r.tU)(t)) {
              return (this.pos++, this._addGap(), (0, r.GQ)(e, t));
            }
          } else if (!this.lastChunkWritten) {
            return ((this.endOfChunkHit = !0), r.AM.EOF);
          }
          return (this._err(i.s.surrogateInInputStream), e);
        }
        willDropParsedChunk() {
          return this.pos > this.bufferWaterline;
        }
        dropParsedChunk() {
          this.willDropParsedChunk() &&
            ((this.html = this.html.substring(this.pos)),
            (this.lineStartPos -= this.pos),
            (this.droppedBufferSize += this.pos),
            (this.pos = 0),
            (this.lastGapPos = -2),
            (this.gapStack.length = 0));
        }
        write(e, t) {
          (this.html.length > 0 ? (this.html += e) : (this.html = e),
            (this.endOfChunkHit = !1),
            (this.lastChunkWritten = t));
        }
        insertHtmlAtCurrentPos(e) {
          ((this.html =
            this.html.substring(0, this.pos + 1) + e + this.html.substring(this.pos + 1)),
            (this.endOfChunkHit = !1));
        }
        startsWith(e, t) {
          if (this.pos + e.length > this.html.length) {
            return ((this.endOfChunkHit = !this.lastChunkWritten), !1);
          }
          if (t) {
            return this.html.startsWith(e, this.pos);
          }
          for (let t = 0; t < e.length; t++) {
            if ((32 | this.html.charCodeAt(this.pos + t)) !== e.charCodeAt(t)) return !1;
          }
          return !0;
        }
        peek(e) {
          let t = this.pos + e;
          if (t >= this.html.length) {
            return ((this.endOfChunkHit = !this.lastChunkWritten), r.AM.EOF);
          }
          let n = this.html.charCodeAt(t);
          return n === r.AM.CARRIAGE_RETURN ? r.AM.LINE_FEED : n;
        }
        advance() {
          if (
            (this.pos++,
            this.isEol && ((this.isEol = !1), this.line++, (this.lineStartPos = this.pos)),
            this.pos >= this.html.length)
          ) {
            return ((this.endOfChunkHit = !this.lastChunkWritten), r.AM.EOF);
          }
          let e = this.html.charCodeAt(this.pos);
          return e === r.AM.CARRIAGE_RETURN
            ? ((this.isEol = !0), (this.skipNextNewLine = !0), r.AM.LINE_FEED)
            : e === r.AM.LINE_FEED && ((this.isEol = !0), this.skipNextNewLine)
              ? (this.line--, (this.skipNextNewLine = !1), this._addGap(), this.advance())
              : ((this.skipNextNewLine = !1),
                (0, r.Fo)(e) && (e = this._processSurrogate(e)),
                null === this.handler.onParseError ||
                  (e > 31 && e < 127) ||
                  e === r.AM.LINE_FEED ||
                  e === r.AM.CARRIAGE_RETURN ||
                  (e > 159 && e < 64976) ||
                  this._checkForProblematicCharacters(e),
                e);
        }
        _checkForProblematicCharacters(e) {
          (0, r.NF)(e)
            ? this._err(i.s.controlCharacterInInputStream)
            : (0, r.CS)(e) && this._err(i.s.noncharacterInInputStream);
        }
        retreat(e) {
          for (this.pos -= e; this.pos < this.lastGapPos; ) {
            ((this.lastGapPos = this.gapStack.pop()), this.pos--);
          }
          this.isEol = !1;
        }
      }
    },
    77015: (e) => {
      "use strict";
      e.exports = SyntaxError;
    },
    78834: (e, t, n) => {
      "use strict";
      n.d(t, { T: () => U });
      var r = n(41451),
        i = n(97058);
      let a = {
          tokenize: function (e, t, n) {
            let r = 0;
            return function t(a) {
              return (87 === a || 119 === a) && r < 3
                ? (r++, e.consume(a), t)
                : 46 === a && 3 === r
                  ? (e.consume(a), i)
                  : n(a);
            };
            function i(e) {
              return null === e ? n(e) : t(e);
            }
          },
          partial: !0,
        },
        o = {
          tokenize: function (e, t, n) {
            let r, a, o;
            return l;
            function l(t) {
              return 46 === t || 95 === t
                ? e.check(s, u, c)(t)
                : null === t || (0, i.Ee)(t) || (0, i.Ny)(t) || (45 !== t && (0, i.es)(t))
                  ? u(t)
                  : ((o = !0), e.consume(t), l);
            }
            function c(t) {
              return (95 === t ? (r = !0) : ((a = r), (r = void 0)), e.consume(t), l);
            }
            function u(e) {
              return a || r || !o ? n(e) : t(e);
            }
          },
          partial: !0,
        },
        l = {
          tokenize: function (e, t) {
            let n = 0,
              r = 0;
            return a;
            function a(l) {
              return 40 === l
                ? (n++, e.consume(l), a)
                : 41 === l && r < n
                  ? o(l)
                  : 33 === l ||
                      34 === l ||
                      38 === l ||
                      39 === l ||
                      41 === l ||
                      42 === l ||
                      44 === l ||
                      46 === l ||
                      58 === l ||
                      59 === l ||
                      60 === l ||
                      63 === l ||
                      93 === l ||
                      95 === l ||
                      126 === l
                    ? e.check(s, t, o)(l)
                    : null === l || (0, i.Ee)(l) || (0, i.Ny)(l)
                      ? t(l)
                      : (e.consume(l), a);
            }
            function o(t) {
              return (41 === t && r++, e.consume(t), a);
            }
          },
          partial: !0,
        },
        s = {
          tokenize: function (e, t, n) {
            return r;
            function r(l) {
              return 33 === l ||
                34 === l ||
                39 === l ||
                41 === l ||
                42 === l ||
                44 === l ||
                46 === l ||
                58 === l ||
                59 === l ||
                63 === l ||
                95 === l ||
                126 === l
                ? (e.consume(l), r)
                : 38 === l
                  ? (e.consume(l), o)
                  : 93 === l
                    ? (e.consume(l), a)
                    : 60 === l || null === l || (0, i.Ee)(l) || (0, i.Ny)(l)
                      ? t(l)
                      : n(l);
            }
            function a(e) {
              return null === e || 40 === e || 91 === e || (0, i.Ee)(e) || (0, i.Ny)(e)
                ? t(e)
                : r(e);
            }
            function o(t) {
              return (0, i.CW)(t)
                ? (function t(a) {
                    return 59 === a ? (e.consume(a), r) : (0, i.CW)(a) ? (e.consume(a), t) : n(a);
                  })(t)
                : n(t);
            }
          },
          partial: !0,
        },
        c = {
          tokenize: function (e, t, n) {
            return function (t) {
              return (e.consume(t), r);
            };
            function r(e) {
              return (0, i.lV)(e) ? n(e) : t(e);
            }
          },
          partial: !0,
        },
        u = {
          name: "wwwAutolink",
          tokenize: function (e, t, n) {
            let r = this;
            return function (t) {
              return (87 !== t && 119 !== t) || !m.call(r, r.previous) || E(r.events)
                ? n(t)
                : (e.enter("literalAutolink"),
                  e.enter("literalAutolinkWww"),
                  e.check(a, e.attempt(o, e.attempt(l, i), n), n)(t));
            };
            function i(n) {
              return (e.exit("literalAutolinkWww"), e.exit("literalAutolink"), t(n));
            }
          },
          previous: m,
        },
        d = {
          name: "protocolAutolink",
          tokenize: function (e, t, n) {
            let r = this,
              a = "",
              s = !1;
            return function (t) {
              return (72 === t || 104 === t) && T.call(r, r.previous) && !E(r.events)
                ? (e.enter("literalAutolink"),
                  e.enter("literalAutolinkHttp"),
                  (a += String.fromCodePoint(t)),
                  e.consume(t),
                  c)
                : n(t);
            };
            function c(t) {
              if ((0, i.CW)(t) && a.length < 5) {
                return ((a += String.fromCodePoint(t)), e.consume(t), c);
              }
              if (58 === t) {
                let n = a.toLowerCase();
                if ("http" === n || "https" === n) {
                  return (e.consume(t), u);
                }
              }
              return n(t);
            }
            function u(t) {
              return 47 === t ? ((e.consume(t), s) ? d : ((s = !0), u)) : n(t);
            }
            function d(t) {
              return null === t || (0, i.JQ)(t) || (0, i.Ee)(t) || (0, i.Ny)(t) || (0, i.es)(t)
                ? n(t)
                : e.attempt(o, e.attempt(l, p), n)(t);
            }
            function p(n) {
              return (e.exit("literalAutolinkHttp"), e.exit("literalAutolink"), t(n));
            }
          },
          previous: T,
        },
        p = {
          name: "emailAutolink",
          tokenize: function (e, t, n) {
            let r,
              a,
              o = this;
            return function (t) {
              return !A(t) || !g.call(o, o.previous) || E(o.events)
                ? n(t)
                : (e.enter("literalAutolink"),
                  e.enter("literalAutolinkEmail"),
                  (function t(r) {
                    return A(r) ? (e.consume(r), t) : 64 === r ? (e.consume(r), l) : n(r);
                  })(t));
            };
            function l(t) {
              return 46 === t
                ? e.check(c, u, s)(t)
                : 45 === t || 95 === t || (0, i.lV)(t)
                  ? ((a = !0), e.consume(t), l)
                  : u(t);
            }
            function s(t) {
              return (e.consume(t), (r = !0), l);
            }
            function u(l) {
              return a && r && (0, i.CW)(o.previous)
                ? (e.exit("literalAutolinkEmail"), e.exit("literalAutolink"), t(l))
                : n(l);
            }
          },
          previous: g,
        },
        h = {},
        f = 48;
      for (; f < 123; ) {
        ((h[f] = p), 58 == ++f ? (f = 65) : 91 === f && (f = 97));
      }
      function m(e) {
        return (
          null === e ||
          40 === e ||
          42 === e ||
          95 === e ||
          91 === e ||
          93 === e ||
          126 === e ||
          (0, i.Ee)(e)
        );
      }
      function T(e) {
        return !(0, i.CW)(e);
      }
      function g(e) {
        return !(47 === e || A(e));
      }
      function A(e) {
        return 43 === e || 45 === e || 46 === e || 95 === e || (0, i.lV)(e);
      }
      function E(e) {
        let t = e.length,
          n = !1;
        for (; t--; ) {
          let r = e[t][1];
          if (("labelLink" === r.type || "labelImage" === r.type) && !r._balanced) {
            n = !0;
            break;
          }
          if (r._gfmAutolinkLiteralWalkedInto) {
            n = !1;
            break;
          }
        }
        return (e.length > 0 && !n && (e[e.length - 1][1]._gfmAutolinkLiteralWalkedInto = !0), n);
      }
      ((h[43] = p),
        (h[45] = p),
        (h[46] = p),
        (h[95] = p),
        (h[72] = [p, d]),
        (h[104] = [p, d]),
        (h[87] = [p, u]),
        (h[119] = [p, u]));
      var I = n(78867),
        _ = n(32335),
        k = n(20728);
      let D = {
        tokenize: function (e, t, n) {
          let r = this;
          return (0, _.N)(
            e,
            function (e) {
              let i = r.events[r.events.length - 1];
              return i &&
                "gfmFootnoteDefinitionIndent" === i[1].type &&
                4 === i[2].sliceSerialize(i[1], !0).length
                ? t(e)
                : n(e);
            },
            "gfmFootnoteDefinitionIndent",
            5,
          );
        },
        partial: !0,
      };
      function b(e, t, n) {
        let r,
          i = this,
          a = i.events.length,
          o = i.parser.gfmFootnotes || (i.parser.gfmFootnotes = []);
        for (; a--; ) {
          let e = i.events[a][1];
          if ("labelImage" === e.type) {
            r = e;
            break;
          }
          if (
            "gfmFootnoteCall" === e.type ||
            "labelLink" === e.type ||
            "label" === e.type ||
            "image" === e.type ||
            "link" === e.type
          ) {
            break;
          }
        }
        return function (a) {
          if (!r || !r._balanced) {
            return n(a);
          }
          let l = (0, k.B)(i.sliceSerialize({ start: r.end, end: i.now() }));
          return 94 === l.codePointAt(0) && o.includes(l.slice(1))
            ? (e.enter("gfmFootnoteCallLabelMarker"),
              e.consume(a),
              e.exit("gfmFootnoteCallLabelMarker"),
              t(a))
            : n(a);
        };
      }
      function y(e, t) {
        let n = e.length;
        for (; n--; ) {
          if ("labelImage" === e[n][1].type && "enter" === e[n][0]) {
            e[n][1];
            break;
          }
        }
        ((e[n + 1][1].type = "data"), (e[n + 3][1].type = "gfmFootnoteCallLabelMarker"));
        let r = {
            type: "gfmFootnoteCall",
            start: Object.assign({}, e[n + 3][1].start),
            end: Object.assign({}, e[e.length - 1][1].end),
          },
          i = {
            type: "gfmFootnoteCallMarker",
            start: Object.assign({}, e[n + 3][1].end),
            end: Object.assign({}, e[n + 3][1].end),
          };
        (i.end.column++, i.end.offset++, i.end._bufferIndex++);
        let a = {
            type: "gfmFootnoteCallString",
            start: Object.assign({}, i.end),
            end: Object.assign({}, e[e.length - 1][1].start),
          },
          o = {
            type: "chunkString",
            contentType: "string",
            start: Object.assign({}, a.start),
            end: Object.assign({}, a.end),
          },
          l = [
            e[n + 1],
            e[n + 2],
            ["enter", r, t],
            e[n + 3],
            e[n + 4],
            ["enter", i, t],
            ["exit", i, t],
            ["enter", a, t],
            ["enter", o, t],
            ["exit", o, t],
            ["exit", a, t],
            e[e.length - 2],
            e[e.length - 1],
            ["exit", r, t],
          ];
        return (e.splice(n, e.length - n + 1, ...l), e);
      }
      function N(e, t, n) {
        let r,
          a = this,
          o = a.parser.gfmFootnotes || (a.parser.gfmFootnotes = []),
          l = 0;
        return function (t) {
          return (
            e.enter("gfmFootnoteCall"),
            e.enter("gfmFootnoteCallLabelMarker"),
            e.consume(t),
            e.exit("gfmFootnoteCallLabelMarker"),
            s
          );
        };
        function s(t) {
          return 94 !== t
            ? n(t)
            : (e.enter("gfmFootnoteCallMarker"),
              e.consume(t),
              e.exit("gfmFootnoteCallMarker"),
              e.enter("gfmFootnoteCallString"),
              (e.enter("chunkString").contentType = "string"),
              c);
        }
        function c(s) {
          if (l > 999 || (93 === s && !r) || null === s || 91 === s || (0, i.Ee)(s)) {
            return n(s);
          }
          if (93 === s) {
            e.exit("chunkString");
            let r = e.exit("gfmFootnoteCallString");
            return o.includes((0, k.B)(a.sliceSerialize(r)))
              ? (e.enter("gfmFootnoteCallLabelMarker"),
                e.consume(s),
                e.exit("gfmFootnoteCallLabelMarker"),
                e.exit("gfmFootnoteCall"),
                t)
              : n(s);
          }
          return ((0, i.Ee)(s) || (r = !0), l++, e.consume(s), 92 === s ? u : c);
        }
        function u(t) {
          return 91 === t || 92 === t || 93 === t ? (e.consume(t), l++, c) : c(t);
        }
      }
      function S(e, t, n) {
        let r,
          a,
          o = this,
          l = o.parser.gfmFootnotes || (o.parser.gfmFootnotes = []),
          s = 0;
        return function (t) {
          return (
            (e.enter("gfmFootnoteDefinition")._container = !0),
            e.enter("gfmFootnoteDefinitionLabel"),
            e.enter("gfmFootnoteDefinitionLabelMarker"),
            e.consume(t),
            e.exit("gfmFootnoteDefinitionLabelMarker"),
            c
          );
        };
        function c(t) {
          return 94 === t
            ? (e.enter("gfmFootnoteDefinitionMarker"),
              e.consume(t),
              e.exit("gfmFootnoteDefinitionMarker"),
              e.enter("gfmFootnoteDefinitionLabelString"),
              (e.enter("chunkString").contentType = "string"),
              u)
            : n(t);
        }
        function u(t) {
          if (s > 999 || (93 === t && !a) || null === t || 91 === t || (0, i.Ee)(t)) {
            return n(t);
          }
          if (93 === t) {
            e.exit("chunkString");
            let n = e.exit("gfmFootnoteDefinitionLabelString");
            return (
              (r = (0, k.B)(o.sliceSerialize(n))),
              e.enter("gfmFootnoteDefinitionLabelMarker"),
              e.consume(t),
              e.exit("gfmFootnoteDefinitionLabelMarker"),
              e.exit("gfmFootnoteDefinitionLabel"),
              p
            );
          }
          return ((0, i.Ee)(t) || (a = !0), s++, e.consume(t), 92 === t ? d : u);
        }
        function d(t) {
          return 91 === t || 92 === t || 93 === t ? (e.consume(t), s++, u) : u(t);
        }
        function p(t) {
          return 58 === t
            ? (e.enter("definitionMarker"),
              e.consume(t),
              e.exit("definitionMarker"),
              l.includes(r) || l.push(r),
              (0, _.N)(e, h, "gfmFootnoteDefinitionWhitespace"))
            : n(t);
        }
        function h(e) {
          return t(e);
        }
      }
      function C(e, t, n) {
        return e.check(I.B, t, e.attempt(D, t, n));
      }
      function x(e) {
        e.exit("gfmFootnoteDefinition");
      }
      var L = n(72805),
        v = n(36753),
        G = n(23195);
      class O {
        constructor() {
          this.map = [];
        }
        add(e, t, n) {
          !(function (e, t, n, r) {
            let i = 0;
            if (0 !== n || 0 !== r.length) {
              for (; i < e.map.length; ) {
                if (e.map[i][0] === t) {
                  ((e.map[i][1] += n), e.map[i][2].push(...r));
                  return;
                }
                i += 1;
              }
              e.map.push([t, n, r]);
            }
          })(this, e, t, n);
        }
        consume(e) {
          if (
            (this.map.toSorted(function (e, t) {
              return e[0] - t[0];
            }),
            0 === this.map.length)
          ) {
            return;
          }
          let t = this.map.length,
            n = [];
          for (; t > 0; ) {
            ((t -= 1),
              n.push(e.slice(this.map[t][0] + this.map[t][1]), this.map[t][2]),
              (e.length = this.map[t][0]));
          }
          (n.push([...e]), (e.length = 0));
          let r = n.pop();
          for (; r; ) {
            (e.push(...r), (r = n.pop()));
          }
          this.map.length = 0;
        }
      }
      function M(e, t, n) {
        let r,
          a = this,
          o = 0,
          l = 0;
        return function (e) {
          let t = a.events.length - 1;
          for (; t > -1; ) {
            let e = a.events[t][1].type;
            if ("lineEnding" === e || "linePrefix" === e) {
              t--;
            } else {
              break;
            }
          }
          let r = t > -1 ? a.events[t][1].type : null,
            i = "tableHead" === r || "tableRow" === r ? E : s;
          return i === E && a.parser.lazy[a.now().line] ? n(e) : i(e);
        };
        function s(t) {
          var n;
          return (
            e.enter("tableHead"), e.enter("tableRow"), 124 === (n = t) || ((r = !0), (l += 1)), c(n)
          );
        }
        function c(t) {
          return null === t
            ? n(t)
            : (0, i.HP)(t)
              ? l > 1
                ? ((l = 0),
                  (a.interrupt = !0),
                  e.exit("tableRow"),
                  e.enter("lineEnding"),
                  e.consume(t),
                  e.exit("lineEnding"),
                  p)
                : n(t)
              : (0, i.On)(t)
                ? (0, _.N)(e, c, "whitespace")(t)
                : ((l += 1), r && ((r = !1), (o += 1)), 124 === t)
                  ? (e.enter("tableCellDivider"),
                    e.consume(t),
                    e.exit("tableCellDivider"),
                    (r = !0),
                    c)
                  : (e.enter("data"), u(t));
        }
        function u(t) {
          return null === t || 124 === t || (0, i.Ee)(t)
            ? (e.exit("data"), c(t))
            : (e.consume(t), 92 === t ? d : u);
        }
        function d(t) {
          return 92 === t || 124 === t ? (e.consume(t), u) : u(t);
        }
        function p(t) {
          return ((a.interrupt = !1), a.parser.lazy[a.now().line])
            ? n(t)
            : (e.enter("tableDelimiterRow"), (r = !1), (0, i.On)(t))
              ? (0, _.N)(
                  e,
                  h,
                  "linePrefix",
                  a.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4,
                )(t)
              : h(t);
        }
        function h(t) {
          return 45 === t || 58 === t
            ? m(t)
            : 124 === t
              ? ((r = !0), e.enter("tableCellDivider"), e.consume(t), e.exit("tableCellDivider"), f)
              : n(t);
        }
        function f(t) {
          return (0, i.On)(t) ? (0, _.N)(e, m, "whitespace")(t) : m(t);
        }
        function m(t) {
          return 58 === t
            ? ((l += 1),
              (r = !0),
              e.enter("tableDelimiterMarker"),
              e.consume(t),
              e.exit("tableDelimiterMarker"),
              T)
            : 45 === t
              ? ((l += 1), T(t))
              : null === t || (0, i.HP)(t)
                ? A(t)
                : n(t);
        }
        function T(t) {
          return 45 === t
            ? (e.enter("tableDelimiterFiller"),
              (function t(n) {
                return 45 === n
                  ? (e.consume(n), t)
                  : 58 === n
                    ? ((r = !0),
                      e.exit("tableDelimiterFiller"),
                      e.enter("tableDelimiterMarker"),
                      e.consume(n),
                      e.exit("tableDelimiterMarker"),
                      g)
                    : (e.exit("tableDelimiterFiller"), g(n));
              })(t))
            : n(t);
        }
        function g(t) {
          return (0, i.On)(t) ? (0, _.N)(e, A, "whitespace")(t) : A(t);
        }
        function A(a) {
          if (124 === a) {
            return h(a);
          }
          if (null === a || (0, i.HP)(a)) {
            return r && o === l ? (e.exit("tableDelimiterRow"), e.exit("tableHead"), t(a)) : n(a);
          }
          return n(a);
        }
        function E(t) {
          return (e.enter("tableRow"), I(t));
        }
        function I(n) {
          return 124 === n
            ? (e.enter("tableCellDivider"), e.consume(n), e.exit("tableCellDivider"), I)
            : null === n || (0, i.HP)(n)
              ? (e.exit("tableRow"), t(n))
              : (0, i.On)(n)
                ? (0, _.N)(e, I, "whitespace")(n)
                : (e.enter("data"), k(n));
        }
        function k(t) {
          return null === t || 124 === t || (0, i.Ee)(t)
            ? (e.exit("data"), I(t))
            : (e.consume(t), 92 === t ? D : k);
        }
        function D(t) {
          return 92 === t || 124 === t ? (e.consume(t), k) : k(t);
        }
      }
      function R(e, t) {
        let n,
          r,
          i,
          a = -1,
          o = !0,
          l = 0,
          s = [0, 0, 0, 0],
          c = [0, 0, 0, 0],
          u = !1,
          d = 0,
          p = new O();
        for (; ++a < e.length; ) {
          let h = e[a],
            f = h[1];
          "enter" === h[0]
            ? "tableHead" === f.type
              ? ((u = !1),
                0 !== d && (w(p, t, d, n, r), (r = void 0), (d = 0)),
                (n = {
                  type: "table",
                  start: Object.assign({}, f.start),
                  end: Object.assign({}, f.end),
                }),
                p.add(a, 0, [["enter", n, t]]))
              : "tableRow" === f.type || "tableDelimiterRow" === f.type
                ? ((o = !0),
                  (i = void 0),
                  (s = [0, 0, 0, 0]),
                  (c = [0, a + 1, 0, 0]),
                  u &&
                    ((u = !1),
                    (r = {
                      type: "tableBody",
                      start: Object.assign({}, f.start),
                      end: Object.assign({}, f.end),
                    }),
                    p.add(a, 0, [["enter", r, t]])),
                  (l = "tableDelimiterRow" === f.type ? 2 : r ? 3 : 1))
                : l &&
                    ("data" === f.type ||
                      "tableDelimiterMarker" === f.type ||
                      "tableDelimiterFiller" === f.type)
                  ? ((o = !1),
                    0 === c[2] &&
                      (0 !== s[1] &&
                        ((c[0] = c[1]), (i = P(p, t, s, l, void 0, i)), (s = [0, 0, 0, 0])),
                      (c[2] = a)))
                  : "tableCellDivider" === f.type &&
                    (o
                      ? (o = !1)
                      : (0 !== s[1] && ((c[0] = c[1]), (i = P(p, t, s, l, void 0, i))),
                        (c = [(s = c)[1], a, 0, 0])))
            : "tableHead" === f.type
              ? ((u = !0), (d = a))
              : "tableRow" === f.type || "tableDelimiterRow" === f.type
                ? ((d = a),
                  0 !== s[1]
                    ? ((c[0] = c[1]), (i = P(p, t, s, l, a, i)))
                    : 0 !== c[1] && (i = P(p, t, c, l, a, i)),
                  (l = 0))
                : l &&
                  ("data" === f.type ||
                    "tableDelimiterMarker" === f.type ||
                    "tableDelimiterFiller" === f.type) &&
                  (c[3] = a);
        }
        for (0 !== d && w(p, t, d, n, r), p.consume(t.events), a = -1; ++a < t.events.length; ) {
          let e = t.events[a];
          "enter" === e[0] &&
            "table" === e[1].type &&
            (e[1]._align = (function (e, t) {
              let n = !1,
                r = [];
              for (; t < e.length; ) {
                let i = e[t];
                if (n) {
                  if ("enter" === i[0]) {
                    "tableContent" === i[1].type &&
                      r.push("tableDelimiterMarker" === e[t + 1][1].type ? "left" : "none");
                  } else if ("tableContent" === i[1].type) {
                    if ("tableDelimiterMarker" === e[t - 1][1].type) {
                      let e = r.length - 1;
                      r[e] = "left" === r[e] ? "center" : "right";
                    }
                  } else if ("tableDelimiterRow" === i[1].type) {
                    break;
                  }
                } else {
                  "enter" === i[0] && "tableDelimiterRow" === i[1].type && (n = !0);
                }
                t += 1;
              }
              return r;
            })(t.events, a));
        }
        return e;
      }
      function P(e, t, n, r, i, a) {
        0 !== n[0] &&
          ((a.end = Object.assign({}, F(t.events, n[0]))), e.add(n[0], 0, [["exit", a, t]]));
        let o = F(t.events, n[1]);
        if (
          ((a = {
            type: 1 === r ? "tableHeader" : 2 === r ? "tableDelimiter" : "tableData",
            start: Object.assign({}, o),
            end: Object.assign({}, o),
          }),
          e.add(n[1], 0, [["enter", a, t]]),
          0 !== n[2])
        ) {
          let i = F(t.events, n[2]),
            a = F(t.events, n[3]),
            o = { type: "tableContent", start: Object.assign({}, i), end: Object.assign({}, a) };
          if ((e.add(n[2], 0, [["enter", o, t]]), 2 !== r)) {
            let r = t.events[n[2]],
              i = t.events[n[3]];
            if (
              ((r[1].end = Object.assign({}, i[1].end)),
              (r[1].type = "chunkText"),
              (r[1].contentType = "text"),
              n[3] > n[2] + 1)
            ) {
              let t = n[2] + 1,
                r = n[3] - n[2] - 1;
              e.add(t, r, []);
            }
          }
          e.add(n[3] + 1, 0, [["exit", o, t]]);
        }
        return (
          void 0 !== i &&
            ((a.end = Object.assign({}, F(t.events, i))),
            e.add(i, 0, [["exit", a, t]]),
            (a = void 0)),
          a
        );
      }
      function w(e, t, n, r, i) {
        let a = [],
          o = F(t.events, n);
        (i && ((i.end = Object.assign({}, o)), a.push(["exit", i, t])),
          (r.end = Object.assign({}, o)),
          a.push(["exit", r, t]),
          e.add(n + 1, 0, a));
      }
      function F(e, t) {
        let n = e[t],
          r = "enter" === n[0] ? "start" : "end";
        return n[1][r];
      }
      let H = {
        name: "tasklistCheck",
        tokenize: function (e, t, n) {
          let r = this;
          return function (t) {
            return null === r.previous && r._gfmTasklistFirstContentOfListItem
              ? (e.enter("taskListCheck"),
                e.enter("taskListCheckMarker"),
                e.consume(t),
                e.exit("taskListCheckMarker"),
                a)
              : n(t);
          };
          function a(t) {
            return (0, i.Ee)(t)
              ? (e.enter("taskListCheckValueUnchecked"),
                e.consume(t),
                e.exit("taskListCheckValueUnchecked"),
                o)
              : 88 === t || 120 === t
                ? (e.enter("taskListCheckValueChecked"),
                  e.consume(t),
                  e.exit("taskListCheckValueChecked"),
                  o)
                : n(t);
          }
          function o(t) {
            return 93 === t
              ? (e.enter("taskListCheckMarker"),
                e.consume(t),
                e.exit("taskListCheckMarker"),
                e.exit("taskListCheck"),
                l)
              : n(t);
          }
          function l(r) {
            return (0, i.HP)(r) ? t(r) : (0, i.On)(r) ? e.check({ tokenize: B }, t, n)(r) : n(r);
          }
        },
      };
      function B(e, t, n) {
        return (0, _.N)(
          e,
          function (e) {
            return null === e ? n(e) : t(e);
          },
          "whitespace",
        );
      }
      function U(e) {
        return (0, r.y)([
          { text: h },
          {
            document: {
              91: {
                name: "gfmFootnoteDefinition",
                tokenize: S,
                continuation: { tokenize: C },
                exit: x,
              },
            },
            text: {
              91: { name: "gfmFootnoteCall", tokenize: N },
              93: { name: "gfmPotentialFootnoteCall", add: "after", tokenize: b, resolveTo: y },
            },
          },
          (function (e) {
            let t = (e || {}).singleTilde,
              n = {
                name: "strikethrough",
                tokenize: function (e, n, r) {
                  let i = this.previous,
                    a = this.events,
                    o = 0;
                  return function (l) {
                    return 126 === i && "characterEscape" !== a[a.length - 1][1].type
                      ? r(l)
                      : (e.enter("strikethroughSequenceTemporary"),
                        (function a(l) {
                          let s = (0, v.S)(i);
                          if (126 === l) {
                            return o > 1 ? r(l) : (e.consume(l), o++, a);
                          }
                          if (o < 2 && !t) {
                            return r(l);
                          }
                          let c = e.exit("strikethroughSequenceTemporary"),
                            u = (0, v.S)(l);
                          return (
                            (c._open = !u || (2 === u && !!s)),
                            (c._close = !s || (2 === s && !!u)),
                            n(l)
                          );
                        })(l));
                  };
                },
                resolveAll: function (e, t) {
                  let n = -1;
                  for (; ++n < e.length; ) {
                    if (
                      "enter" === e[n][0] &&
                      "strikethroughSequenceTemporary" === e[n][1].type &&
                      e[n][1]._close
                    ) {
                      let r = n;
                      for (; r--; )
                        if (
                          "exit" === e[r][0] &&
                          "strikethroughSequenceTemporary" === e[r][1].type &&
                          e[r][1]._open &&
                          e[n][1].end.offset - e[n][1].start.offset ==
                            e[r][1].end.offset - e[r][1].start.offset
                        ) {
                          ((e[n][1].type = "strikethroughSequence"),
                            (e[r][1].type = "strikethroughSequence"));
                          let i = {
                              type: "strikethrough",
                              start: Object.assign({}, e[r][1].start),
                              end: Object.assign({}, e[n][1].end),
                            },
                            a = {
                              type: "strikethroughText",
                              start: Object.assign({}, e[r][1].end),
                              end: Object.assign({}, e[n][1].start),
                            },
                            o = [
                              ["enter", i, t],
                              ["enter", e[r][1], t],
                              ["exit", e[r][1], t],
                              ["enter", a, t],
                            ],
                            l = t.parser.constructs.insideSpan.null;
                          (l && (0, L.m)(o, o.length, 0, (0, G.W)(l, e.slice(r + 1, n), t)),
                            (0, L.m)(o, o.length, 0, [
                              ["exit", a, t],
                              ["enter", e[n][1], t],
                              ["exit", e[n][1], t],
                              ["exit", i, t],
                            ]),
                            (0, L.m)(e, r - 1, n - r + 3, o),
                            (n = r + o.length - 2));
                          break;
                        }
                    }
                  }
                  for (n = -1; ++n < e.length; ) {
                    "strikethroughSequenceTemporary" === e[n][1].type && (e[n][1].type = "data");
                  }
                  return e;
                },
              };
            return (
              null == t && (t = !0),
              { text: { 126: n }, insideSpan: { null: [n] }, attentionMarkers: { null: [126] } }
            );
          })(e),
          { flow: { null: { name: "table", tokenize: M, resolveAll: R } } },
          { text: { 91: H } },
        ]);
      }
    },
    78867: (e, t, n) => {
      "use strict";
      n.d(t, { B: () => a });
      var r = n(32335),
        i = n(97058);
      let a = {
        tokenize: function (e, t, n) {
          return function (t) {
            return (0, i.On)(t) ? (0, r.N)(e, a, "linePrefix")(t) : a(t);
          };
          function a(e) {
            return null === e || (0, i.HP)(e) ? t(e) : n(e);
          }
        },
        partial: !0,
      };
    },
    79482: (e) => {
      "use strict";
      e.exports = EvalError;
    },
    82873: (e, t, n) => {
      "use strict";
      n.d(t, { t: () => r });
      let r = {
        html: "http://www.w3.org/1999/xhtml",
        mathml: "http://www.w3.org/1998/Math/MathML",
        svg: "http://www.w3.org/2000/svg",
        xlink: "http://www.w3.org/1999/xlink",
        xml: "http://www.w3.org/XML/1998/namespace",
        xmlns: "http://www.w3.org/2000/xmlns/",
      };
    },
    85397: (e, t, n) => {
      "use strict";
      n.d(t, { P: () => i });
      let r = /[#.]/g;
      function i(e, t) {
        let n,
          i,
          a = e || "",
          o = {},
          l = 0;
        for (; l < a.length; ) {
          r.lastIndex = l;
          let e = r.exec(a),
            t = a.slice(l, e ? e.index : a.length);
          (t &&
            (n
              ? "#" === n
                ? (o.id = t)
                : Array.isArray(o.className)
                  ? o.className.push(t)
                  : (o.className = [t])
              : (i = t),
            (l += t.length)),
            e && ((n = e[0]), l++));
        }
        return { type: "element", tagName: i || t || "div", properties: o, children: [] };
      }
    },
    86775: (e, t) => {
      "use strict";
      ((t.Fr = t.M5 = void 0),
        (function (e) {
          var t;
          (((t = e.HttpMethods || (e.HttpMethods = {})).GET = "get"),
            (t.PUT = "put"),
            (t.POST = "post"),
            (t.DELETE = "delete"),
            (t.OPTIONS = "options"),
            (t.HEAD = "head"),
            (t.PATCH = "patch"),
            (t.TRACE = "trace"));
        })(t.M5 || (t.M5 = {})),
        (function (e) {
          var t;
          (((t = e.HttpMethods || (e.HttpMethods = {})).GET = "get"),
            (t.PUT = "put"),
            (t.POST = "post"),
            (t.DELETE = "delete"),
            (t.OPTIONS = "options"),
            (t.HEAD = "head"),
            (t.PATCH = "patch"));
        })(t.Fr || (t.Fr = {})));
    },
    87274: (e, t, n) => {
      "use strict";
      n.d(t, { f: () => o });
      var r = n(25478),
        i = n(96541),
        a = n(96018);
      function o(e, t) {
        let n = !1;
        return (
          (0, r.YR)(e, function (e) {
            if (("value" in e && /\r?\n|\r/.test(e.value)) || "break" === e.type) {
              return ((n = !0), i.dc);
            }
          }),
          !!((!e.depth || e.depth < 3) && (0, a.d)(e) && (t.options.setext || n))
        );
      }
    },
    90951: (e, t, n) => {
      "use strict";
      var r, i, a;
      n.d(t, { xA: () => a, E_: () => d, qN: () => o });
      let o = new Uint16Array(
          'ᵁ<\xd5ıʊҝջאٵ۞ޢߖࠏ੊ઑඡ๭༉༦჊ረዡᐕᒝᓃᓟᔥ\0\0\0\0\0\0ᕫᛍᦍᰒᷝ὾⁠↰⊍⏀⏻⑂⠤⤒ⴈ⹈⿎〖㊺㘹㞬㣾㨨㩱㫠㬮ࠀEMabcfglmnoprstu\\bfms\x7f\x84\x8b\x90\x95\x98\xa6\xb3\xb9\xc8\xcflig耻\xc6䃆P耻&䀦cute耻\xc1䃁reve;䄂Āiyx}rc耻\xc2䃂;䐐r;쀀\ud835\udd04rave耻\xc0䃀pha;䎑acr;䄀d;橓Āgp\x9d\xa1on;䄄f;쀀\ud835\udd38plyFunction;恡ing耻\xc5䃅Ācs\xbe\xc3r;쀀\ud835\udc9cign;扔ilde耻\xc3䃃ml耻\xc4䃄Ѐaceforsu\xe5\xfb\xfeėĜĢħĪĀcr\xea\xf2kslash;或Ŷ\xf6\xf8;櫧ed;挆y;䐑ƀcrtąċĔause;戵noullis;愬a;䎒r;쀀\ud835\udd05pf;쀀\ud835\udd39eve;䋘c\xf2ēmpeq;扎܀HOacdefhilorsuōőŖƀƞƢƵƷƺǜȕɳɸɾcy;䐧PY耻\xa9䂩ƀcpyŝŢźute;䄆Ā;iŧŨ拒talDifferentialD;慅leys;愭ȀaeioƉƎƔƘron;䄌dil耻\xc7䃇rc;䄈nint;戰ot;䄊ĀdnƧƭilla;䂸terDot;䂷\xf2ſi;䎧rcleȀDMPTǇǋǑǖot;抙inus;抖lus;投imes;抗oĀcsǢǸkwiseContourIntegral;戲eCurlyĀDQȃȏoubleQuote;思uote;怙ȀlnpuȞȨɇɕonĀ;eȥȦ户;橴ƀgitȯȶȺruent;扡nt;戯ourIntegral;戮ĀfrɌɎ;愂oduct;成nterClockwiseContourIntegral;戳oss;樯cr;쀀\ud835\udc9epĀ;Cʄʅ拓ap;才րDJSZacefiosʠʬʰʴʸˋ˗ˡ˦̳ҍĀ;oŹʥtrahd;椑cy;䐂cy;䐅cy;䐏ƀgrsʿ˄ˇger;怡r;憡hv;櫤Āayː˕ron;䄎;䐔lĀ;t˝˞戇a;䎔r;쀀\ud835\udd07Āaf˫̧Ācm˰̢riticalȀADGT̖̜̀̆cute;䂴oŴ̋̍;䋙bleAcute;䋝rave;䁠ilde;䋜ond;拄ferentialD;慆Ѱ̽\0\0\0͔͂\0Ѕf;쀀\ud835\udd3bƀ;DE͈͉͍䂨ot;惜qual;扐blèCDLRUVͣͲ΂ϏϢϸontourIntegra\xecȹoɴ͹\0\0ͻ\xbb͉nArrow;懓Āeo·ΤftƀARTΐΖΡrrow;懐ightArrow;懔e\xe5ˊngĀLRΫτeftĀARγιrrow;柸ightArrow;柺ightArrow;柹ightĀATϘϞrrow;懒ee;抨pɁϩ\0\0ϯrrow;懑ownArrow;懕erticalBar;戥ǹABLRTaВЪаўѿͼrrowƀ;BUНОТ憓ar;椓pArrow;懵reve;䌑eft˒к\0ц\0ѐightVector;楐eeVector;楞ectorĀ;Bљњ憽ar;楖ightǔѧ\0ѱeeVector;楟ectorĀ;BѺѻ懁ar;楗eeĀ;A҆҇护rrow;憧ĀctҒҗr;쀀\ud835\udc9frok;䄐ࠀNTacdfglmopqstuxҽӀӄӋӞӢӧӮӵԡԯԶՒ՝ՠեG;䅊H耻\xd0䃐cute耻\xc9䃉ƀaiyӒӗӜron;䄚rc耻\xca䃊;䐭ot;䄖r;쀀\ud835\udd08rave耻\xc8䃈ement;戈ĀapӺӾcr;䄒tyɓԆ\0\0ԒmallSquare;旻erySmallSquare;斫ĀgpԦԪon;䄘f;쀀\ud835\udd3csilon;䎕uĀaiԼՉlĀ;TՂՃ橵ilde;扂librium;懌Āci՗՚r;愰m;橳a;䎗ml耻\xcb䃋Āipժկsts;戃onentialE;慇ʀcfiosօֈ֍ֲ׌y;䐤r;쀀\ud835\udd09lledɓ֗\0\0֣mallSquare;旼erySmallSquare;斪Ͱֺ\0ֿ\0\0ׄf;쀀\ud835\udd3dAll;戀riertrf;愱c\xf2׋؀JTabcdfgorstר׬ׯ׺؀ؒؖ؛؝أ٬ٲcy;䐃耻>䀾mmaĀ;d׷׸䎓;䏜reve;䄞ƀeiy؇،ؐdil;䄢rc;䄜;䐓ot;䄠r;쀀\ud835\udd0a;拙pf;쀀\ud835\udd3eeater̀EFGLSTصلَٖٛ٦qualĀ;Lؾؿ扥ess;招ullEqual;执reater;檢ess;扷lantEqual;橾ilde;扳cr;쀀\ud835\udca2;扫ЀAacfiosuڅڋږڛڞڪھۊRDcy;䐪Āctڐڔek;䋇;䁞irc;䄤r;愌lbertSpace;愋ǰگ\0ڲf;愍izontalLine;攀Āctۃۅ\xf2کrok;䄦mpńېۘownHum\xf0įqual;扏܀EJOacdfgmnostuۺ۾܃܇܎ܚܞܡܨ݄ݸދޏޕcy;䐕lig;䄲cy;䐁cute耻\xcd䃍Āiyܓܘrc耻\xce䃎;䐘ot;䄰r;愑rave耻\xcc䃌ƀ;apܠܯܿĀcgܴܷr;䄪inaryI;慈lie\xf3ϝǴ݉\0ݢĀ;eݍݎ戬Āgrݓݘral;戫section;拂isibleĀCTݬݲomma;恣imes;恢ƀgptݿރވon;䄮f;쀀\ud835\udd40a;䎙cr;愐ilde;䄨ǫޚ\0ޞcy;䐆l耻\xcf䃏ʀcfosuެ޷޼߂ߐĀiyޱ޵rc;䄴;䐙r;쀀\ud835\udd0dpf;쀀\ud835\udd41ǣ߇\0ߌr;쀀\ud835\udca5rcy;䐈kcy;䐄΀HJacfosߤߨ߽߬߱ࠂࠈcy;䐥cy;䐌ppa;䎚Āey߶߻dil;䄶;䐚r;쀀\ud835\udd0epf;쀀\ud835\udd42cr;쀀\ud835\udca6րJTaceflmostࠥࠩࠬࡐࡣ঳সে্਷ੇcy;䐉耻<䀼ʀcmnpr࠷࠼ࡁࡄࡍute;䄹bda;䎛g;柪lacetrf;愒r;憞ƀaeyࡗ࡜ࡡron;䄽dil;䄻;䐛Āfsࡨ॰tԀACDFRTUVarࡾࢩࢱࣦ࣠ࣼयज़ΐ४Ānrࢃ࢏gleBracket;柨rowƀ;BR࢙࢚࢞憐ar;懤ightArrow;懆eiling;挈oǵࢷ\0ࣃbleBracket;柦nǔࣈ\0࣒eeVector;楡ectorĀ;Bࣛࣜ懃ar;楙loor;挊ightĀAV࣯ࣵrrow;憔ector;楎Āerँगeƀ;AVउऊऐ抣rrow;憤ector;楚iangleƀ;BEतथऩ抲ar;槏qual;抴pƀDTVषूौownVector;楑eeVector;楠ectorĀ;Bॖॗ憿ar;楘ectorĀ;B॥०憼ar;楒ight\xe1Μs̀EFGLSTॾঋকঝঢভqualGreater;拚ullEqual;扦reater;扶ess;檡lantEqual;橽ilde;扲r;쀀\ud835\udd0fĀ;eঽা拘ftarrow;懚idot;䄿ƀnpw৔ਖਛgȀLRlr৞৷ਂਐeftĀAR০৬rrow;柵ightArrow;柷ightArrow;柶eftĀarγਊight\xe1οight\xe1ϊf;쀀\ud835\udd43erĀLRਢਬeftArrow;憙ightArrow;憘ƀchtਾੀੂ\xf2ࡌ;憰rok;䅁;扪Ѐacefiosuਗ਼੝੠੷੼અઋ઎p;椅y;䐜Ādl੥੯iumSpace;恟lintrf;愳r;쀀\ud835\udd10nusPlus;戓pf;쀀\ud835\udd44c\xf2੶;䎜ҀJacefostuણધભીଔଙඑ඗ඞcy;䐊cute;䅃ƀaey઴હાron;䅇dil;䅅;䐝ƀgswે૰଎ativeƀMTV૓૟૨ediumSpace;怋hiĀcn૦૘\xeb૙eryThi\xee૙tedĀGL૸ଆreaterGreate\xf2ٳessLes\xf3ੈLine;䀊r;쀀\ud835\udd11ȀBnptଢନଷ଺reak;恠BreakingSpace;䂠f;愕ڀ;CDEGHLNPRSTV୕ୖ୪୼஡௫ఄ౞಄ದ೘ൡඅ櫬Āou୛୤ngruent;扢pCap;扭oubleVerticalBar;戦ƀlqxஃஊ஛ement;戉ualĀ;Tஒஓ扠ilde;쀀≂̸ists;戄reater΀;EFGLSTஶஷ஽௉௓௘௥扯qual;扱ullEqual;쀀≧̸reater;쀀≫̸ess;批lantEqual;쀀⩾̸ilde;扵umpń௲௽ownHump;쀀≎̸qual;쀀≏̸eĀfsఊధtTriangleƀ;BEచఛడ拪ar;쀀⧏̸qual;括s̀;EGLSTవశ఼ౄోౘ扮qual;扰reater;扸ess;쀀≪̸lantEqual;쀀⩽̸ilde;扴estedĀGL౨౹reaterGreater;쀀⪢̸essLess;쀀⪡̸recedesƀ;ESಒಓಛ技qual;쀀⪯̸lantEqual;拠ĀeiಫಹverseElement;戌ghtTriangleƀ;BEೋೌ೒拫ar;쀀⧐̸qual;拭ĀquೝഌuareSuĀbp೨೹setĀ;E೰ೳ쀀⊏̸qual;拢ersetĀ;Eഃആ쀀⊐̸qual;拣ƀbcpഓതൎsetĀ;Eഛഞ쀀⊂⃒qual;抈ceedsȀ;ESTലള഻െ抁qual;쀀⪰̸lantEqual;拡ilde;쀀≿̸ersetĀ;E൘൛쀀⊃⃒qual;抉ildeȀ;EFT൮൯൵ൿ扁qual;扄ullEqual;扇ilde;扉erticalBar;戤cr;쀀\ud835\udca9ilde耻\xd1䃑;䎝܀Eacdfgmoprstuvලෂ෉෕ෛ෠෧෼ขภยา฿ไlig;䅒cute耻\xd3䃓Āiy෎ීrc耻\xd4䃔;䐞blac;䅐r;쀀\ud835\udd12rave耻\xd2䃒ƀaei෮ෲ෶cr;䅌ga;䎩cron;䎟pf;쀀\ud835\udd46enCurlyĀDQฎบoubleQuote;怜uote;怘;橔Āclวฬr;쀀\ud835\udcaaash耻\xd8䃘iŬื฼de耻\xd5䃕es;樷ml耻\xd6䃖erĀBP๋๠Āar๐๓r;怾acĀek๚๜;揞et;掴arenthesis;揜Ҁacfhilors๿ງຊຏຒດຝະ໼rtialD;戂y;䐟r;쀀\ud835\udd13i;䎦;䎠usMinus;䂱Āipຢອncareplan\xe5ڝf;愙Ȁ;eio຺ູ໠໤檻cedesȀ;EST່້໏໚扺qual;檯lantEqual;扼ilde;找me;怳Ādp໩໮uct;戏ortionĀ;aȥ໹l;戝Āci༁༆r;쀀\ud835\udcab;䎨ȀUfos༑༖༛༟OT耻"䀢r;쀀\ud835\udd14pf;愚cr;쀀\ud835\udcac؀BEacefhiorsu༾གྷཇའཱིྦྷྪྭ႖ႩႴႾarr;椐G耻\xae䂮ƀcnrཎནབute;䅔g;柫rĀ;tཛྷཝ憠l;椖ƀaeyཧཬཱron;䅘dil;䅖;䐠Ā;vླྀཹ愜erseĀEUྂྙĀlq྇ྎement;戋uilibrium;懋pEquilibrium;楯r\xbbཹo;䎡ghtЀACDFTUVa࿁࿫࿳ဢဨၛႇϘĀnr࿆࿒gleBracket;柩rowƀ;BL࿜࿝࿡憒ar;懥eftArrow;懄eiling;按oǵ࿹\0စbleBracket;柧nǔည\0နeeVector;楝ectorĀ;Bဝသ懂ar;楕loor;挋Āerိ၃eƀ;AVဵံြ抢rrow;憦ector;楛iangleƀ;BEၐၑၕ抳ar;槐qual;抵pƀDTVၣၮၸownVector;楏eeVector;楜ectorĀ;Bႂႃ憾ar;楔ectorĀ;B႑႒懀ar;楓Āpuႛ႞f;愝ndImplies;楰ightarrow;懛ĀchႹႼr;愛;憱leDelayed;槴ڀHOacfhimoqstuფჱჷჽᄙᄞᅑᅖᅡᅧᆵᆻᆿĀCcჩხHcy;䐩y;䐨FTcy;䐬cute;䅚ʀ;aeiyᄈᄉᄎᄓᄗ檼ron;䅠dil;䅞rc;䅜;䐡r;쀀\ud835\udd16ortȀDLRUᄪᄴᄾᅉownArrow\xbbОeftArrow\xbb࢚ightArrow\xbb࿝pArrow;憑gma;䎣allCircle;战pf;쀀\ud835\udd4aɲᅭ\0\0ᅰt;戚areȀ;ISUᅻᅼᆉᆯ斡ntersection;抓uĀbpᆏᆞsetĀ;Eᆗᆘ抏qual;抑ersetĀ;Eᆨᆩ抐qual;抒nion;抔cr;쀀\ud835\udcaear;拆ȀbcmpᇈᇛሉላĀ;sᇍᇎ拐etĀ;Eᇍᇕqual;抆ĀchᇠህeedsȀ;ESTᇭᇮᇴᇿ扻qual;檰lantEqual;扽ilde;承Th\xe1ྌ;我ƀ;esሒሓሣ拑rsetĀ;Eሜም抃qual;抇et\xbbሓրHRSacfhiorsሾቄ቉ቕ቞ቱቶኟዂወዑORN耻\xde䃞ADE;愢ĀHc቎ቒcy;䐋y;䐦Ābuቚቜ;䀉;䎤ƀaeyብቪቯron;䅤dil;䅢;䐢r;쀀\ud835\udd17Āeiቻ኉ǲኀ\0ኇefore;戴a;䎘Ācn኎ኘkSpace;쀀  Space;怉ldeȀ;EFTካኬኲኼ戼qual;扃ullEqual;扅ilde;扈pf;쀀\ud835\udd4bipleDot;惛Āctዖዛr;쀀\ud835\udcafrok;䅦ૡዷጎጚጦ\0ጬጱ\0\0\0\0\0ጸጽ፷ᎅ\0᏿ᐄᐊᐐĀcrዻጁute耻\xda䃚rĀ;oጇገ憟cir;楉rǣጓ\0጖y;䐎ve;䅬Āiyጞጣrc耻\xdb䃛;䐣blac;䅰r;쀀\ud835\udd18rave耻\xd9䃙acr;䅪Ādiፁ፩erĀBPፈ፝Āarፍፐr;䁟acĀekፗፙ;揟et;掵arenthesis;揝onĀ;P፰፱拃lus;抎Āgp፻፿on;䅲f;쀀\ud835\udd4cЀADETadps᎕ᎮᎸᏄϨᏒᏗᏳrrowƀ;BDᅐᎠᎤar;椒ownArrow;懅ownArrow;憕quilibrium;楮eeĀ;AᏋᏌ报rrow;憥own\xe1ϳerĀLRᏞᏨeftArrow;憖ightArrow;憗iĀ;lᏹᏺ䏒on;䎥ing;䅮cr;쀀\ud835\udcb0ilde;䅨ml耻\xdc䃜ҀDbcdefosvᐧᐬᐰᐳᐾᒅᒊᒐᒖash;披ar;櫫y;䐒ashĀ;lᐻᐼ抩;櫦Āerᑃᑅ;拁ƀbtyᑌᑐᑺar;怖Ā;iᑏᑕcalȀBLSTᑡᑥᑪᑴar;戣ine;䁼eparator;杘ilde;所ThinSpace;怊r;쀀\ud835\udd19pf;쀀\ud835\udd4dcr;쀀\ud835\udcb1dash;抪ʀcefosᒧᒬᒱᒶᒼirc;䅴dge;拀r;쀀\ud835\udd1apf;쀀\ud835\udd4ecr;쀀\ud835\udcb2Ȁfiosᓋᓐᓒᓘr;쀀\ud835\udd1b;䎞pf;쀀\ud835\udd4fcr;쀀\ud835\udcb3ҀAIUacfosuᓱᓵᓹᓽᔄᔏᔔᔚᔠcy;䐯cy;䐇cy;䐮cute耻\xdd䃝Āiyᔉᔍrc;䅶;䐫r;쀀\ud835\udd1cpf;쀀\ud835\udd50cr;쀀\ud835\udcb4ml;䅸ЀHacdefosᔵᔹᔿᕋᕏᕝᕠᕤcy;䐖cute;䅹Āayᕄᕉron;䅽;䐗ot;䅻ǲᕔ\0ᕛoWidt\xe8૙a;䎖r;愨pf;愤cr;쀀\ud835\udcb5௡ᖃᖊᖐ\0ᖰᖶᖿ\0\0\0\0ᗆᗛᗫᙟ᙭\0ᚕ᚛ᚲᚹ\0ᚾcute耻\xe1䃡reve;䄃̀;Ediuyᖜᖝᖡᖣᖨᖭ戾;쀀∾̳;房rc耻\xe2䃢te肻\xb4̆;䐰lig耻\xe6䃦Ā;r\xb2ᖺ;쀀\ud835\udd1erave耻\xe0䃠ĀepᗊᗖĀfpᗏᗔsym;愵\xe8ᗓha;䎱ĀapᗟcĀclᗤᗧr;䄁g;樿ɤᗰ\0\0ᘊʀ;adsvᗺᗻᗿᘁᘇ戧nd;橕;橜lope;橘;橚΀;elmrszᘘᘙᘛᘞᘿᙏᙙ戠;榤e\xbbᘙsdĀ;aᘥᘦ戡ѡᘰᘲᘴᘶᘸᘺᘼᘾ;榨;榩;榪;榫;榬;榭;榮;榯tĀ;vᙅᙆ戟bĀ;dᙌᙍ抾;榝Āptᙔᙗh;戢\xbb\xb9arr;捼Āgpᙣᙧon;䄅f;쀀\ud835\udd52΀;Eaeiop዁ᙻᙽᚂᚄᚇᚊ;橰cir;橯;扊d;手s;䀧roxĀ;e዁ᚒ\xf1ᚃing耻\xe5䃥ƀctyᚡᚦᚨr;쀀\ud835\udcb6;䀪mpĀ;e዁ᚯ\xf1ʈilde耻\xe3䃣ml耻\xe4䃤Āciᛂᛈonin\xf4ɲnt;樑ࠀNabcdefiklnoprsu᛭ᛱᜰ᜼ᝃᝈ᝸᝽០៦ᠹᡐᜍ᤽᥈ᥰot;櫭Ācrᛶ᜞kȀcepsᜀᜅᜍᜓong;扌psilon;䏶rime;怵imĀ;e᜚᜛戽q;拍Ŷᜢᜦee;抽edĀ;gᜬᜭ挅e\xbbᜭrkĀ;t፜᜷brk;掶Āoyᜁᝁ;䐱quo;怞ʀcmprtᝓ᝛ᝡᝤᝨausĀ;eĊĉptyv;榰s\xe9ᜌno\xf5ēƀahwᝯ᝱ᝳ;䎲;愶een;扬r;쀀\ud835\udd1fg΀costuvwឍឝឳេ៕៛៞ƀaiuបពរ\xf0ݠrc;旯p\xbb፱ƀdptឤឨឭot;樀lus;樁imes;樂ɱឹ\0\0ើcup;樆ar;昅riangleĀdu៍្own;施p;斳plus;樄e\xe5ᑄ\xe5ᒭarow;植ƀako៭ᠦᠵĀcn៲ᠣkƀlst៺֫᠂ozenge;槫riangleȀ;dlr᠒᠓᠘᠝斴own;斾eft;旂ight;斸k;搣Ʊᠫ\0ᠳƲᠯ\0ᠱ;斒;斑4;斓ck;斈ĀeoᠾᡍĀ;qᡃᡆ쀀=⃥uiv;쀀≡⃥t;挐Ȁptwxᡙᡞᡧᡬf;쀀\ud835\udd53Ā;tᏋᡣom\xbbᏌtie;拈؀DHUVbdhmptuvᢅᢖᢪᢻᣗᣛᣬ᣿ᤅᤊᤐᤡȀLRlrᢎᢐᢒᢔ;敗;敔;敖;敓ʀ;DUduᢡᢢᢤᢦᢨ敐;敦;敩;敤;敧ȀLRlrᢳᢵᢷᢹ;敝;敚;敜;教΀;HLRhlrᣊᣋᣍᣏᣑᣓᣕ救;敬;散;敠;敫;敢;敟ox;槉ȀLRlrᣤᣦᣨᣪ;敕;敒;攐;攌ʀ;DUduڽ᣷᣹᣻᣽;敥;敨;攬;攴inus;抟lus;択imes;抠ȀLRlrᤙᤛᤝ᤟;敛;敘;攘;攔΀;HLRhlrᤰᤱᤳᤵᤷ᤻᤹攂;敪;敡;敞;攼;攤;攜Āevģ᥂bar耻\xa6䂦Ȁceioᥑᥖᥚᥠr;쀀\ud835\udcb7mi;恏mĀ;e᜚᜜lƀ;bhᥨᥩᥫ䁜;槅sub;柈Ŭᥴ᥾lĀ;e᥹᥺怢t\xbb᥺pƀ;Eeįᦅᦇ;檮Ā;qۜۛೡᦧ\0᧨ᨑᨕᨲ\0ᨷᩐ\0\0᪴\0\0᫁\0\0ᬡᬮ᭍᭒\0᯽\0ᰌƀcpr᦭ᦲ᧝ute;䄇̀;abcdsᦿᧀᧄ᧊᧕᧙戩nd;橄rcup;橉Āau᧏᧒p;橋p;橇ot;橀;쀀∩︀Āeo᧢᧥t;恁\xeeړȀaeiu᧰᧻ᨁᨅǰ᧵\0᧸s;橍on;䄍dil耻\xe7䃧rc;䄉psĀ;sᨌᨍ橌m;橐ot;䄋ƀdmnᨛᨠᨦil肻\xb8ƭptyv;榲t脀\xa2;eᨭᨮ䂢r\xe4Ʋr;쀀\ud835\udd20ƀceiᨽᩀᩍy;䑇ckĀ;mᩇᩈ朓ark\xbbᩈ;䏇r΀;Ecefms᩟᩠ᩢᩫ᪤᪪᪮旋;槃ƀ;elᩩᩪᩭ䋆q;扗eɡᩴ\0\0᪈rrowĀlr᩼᪁eft;憺ight;憻ʀRSacd᪒᪔᪖᪚᪟\xbbཇ;擈st;抛irc;抚ash;抝nint;樐id;櫯cir;槂ubsĀ;u᪻᪼晣it\xbb᪼ˬ᫇᫔᫺\0ᬊonĀ;eᫍᫎ䀺Ā;q\xc7\xc6ɭ᫙\0\0᫢aĀ;t᫞᫟䀬;䁀ƀ;fl᫨᫩᫫戁\xeeᅠeĀmx᫱᫶ent\xbb᫩e\xf3ɍǧ᫾\0ᬇĀ;dኻᬂot;橭n\xf4Ɇƀfryᬐᬔᬗ;쀀\ud835\udd54o\xe4ɔ脀\xa9;sŕᬝr;愗Āaoᬥᬩrr;憵ss;朗Ācuᬲᬷr;쀀\ud835\udcb8Ābpᬼ᭄Ā;eᭁᭂ櫏;櫑Ā;eᭉᭊ櫐;櫒dot;拯΀delprvw᭠᭬᭷ᮂᮬᯔ᯹arrĀlr᭨᭪;椸;椵ɰ᭲\0\0᭵r;拞c;拟arrĀ;p᭿ᮀ憶;椽̀;bcdosᮏᮐᮖᮡᮥᮨ截rcap;橈Āauᮛᮞp;橆p;橊ot;抍r;橅;쀀∪︀Ȁalrv᮵ᮿᯞᯣrrĀ;mᮼᮽ憷;椼yƀevwᯇᯔᯘqɰᯎ\0\0ᯒre\xe3᭳u\xe3᭵ee;拎edge;拏en耻\xa4䂤earrowĀlrᯮ᯳eft\xbbᮀight\xbbᮽe\xe4ᯝĀciᰁᰇonin\xf4Ƿnt;戱lcty;挭ঀAHabcdefhijlorstuwz᰸᰻᰿ᱝᱩᱵᲊᲞᲬᲷ᳻᳿ᴍᵻᶑᶫᶻ᷆᷍r\xf2΁ar;楥Ȁglrs᱈ᱍ᱒᱔ger;怠eth;愸\xf2ᄳhĀ;vᱚᱛ怐\xbbऊūᱡᱧarow;椏a\xe3̕Āayᱮᱳron;䄏;䐴ƀ;ao̲ᱼᲄĀgrʿᲁr;懊tseq;橷ƀglmᲑᲔᲘ耻\xb0䂰ta;䎴ptyv;榱ĀirᲣᲨsht;楿;쀀\ud835\udd21arĀlrᲳᲵ\xbbࣜ\xbbသʀaegsv᳂͸᳖᳜᳠mƀ;oș᳊᳔ndĀ;ș᳑uit;晦amma;䏝in;拲ƀ;io᳧᳨᳸䃷de脀\xf7;o᳧ᳰntimes;拇n\xf8᳷cy;䑒cɯᴆ\0\0ᴊrn;挞op;挍ʀlptuwᴘᴝᴢᵉᵕlar;䀤f;쀀\ud835\udd55ʀ;emps̋ᴭᴷᴽᵂqĀ;d͒ᴳot;扑inus;戸lus;戔quare;抡blebarwedg\xe5\xfanƀadhᄮᵝᵧownarrow\xf3ᲃarpoonĀlrᵲᵶef\xf4Ჴigh\xf4ᲶŢᵿᶅkaro\xf7གɯᶊ\0\0ᶎrn;挟op;挌ƀcotᶘᶣᶦĀryᶝᶡ;쀀\ud835\udcb9;䑕l;槶rok;䄑Ādrᶰᶴot;拱iĀ;fᶺ᠖斿Āah᷀᷃r\xf2Щa\xf2ྦangle;榦Āci᷒ᷕy;䑟grarr;柿ऀDacdefglmnopqrstuxḁḉḙḸոḼṉṡṾấắẽỡἪἷὄ὎὚ĀDoḆᴴo\xf4ᲉĀcsḎḔute耻\xe9䃩ter;橮ȀaioyḢḧḱḶron;䄛rĀ;cḭḮ扖耻\xea䃪lon;払;䑍ot;䄗ĀDrṁṅot;扒;쀀\ud835\udd22ƀ;rsṐṑṗ檚ave耻\xe8䃨Ā;dṜṝ檖ot;檘Ȁ;ilsṪṫṲṴ檙nters;揧;愓Ā;dṹṺ檕ot;檗ƀapsẅẉẗcr;䄓tyƀ;svẒẓẕ戅et\xbbẓpĀ1;ẝẤĳạả;怄;怅怃ĀgsẪẬ;䅋p;怂ĀgpẴẸon;䄙f;쀀\ud835\udd56ƀalsỄỎỒrĀ;sỊị拕l;槣us;橱iƀ;lvỚớở䎵on\xbbớ;䏵ȀcsuvỪỳἋἣĀioữḱrc\xbbḮɩỹ\0\0ỻ\xedՈantĀglἂἆtr\xbbṝess\xbbṺƀaeiἒ἖Ἒls;䀽st;扟vĀ;DȵἠD;橸parsl;槥ĀDaἯἳot;打rr;楱ƀcdiἾὁỸr;愯o\xf4͒ĀahὉὋ;䎷耻\xf0䃰Āmrὓὗl耻\xeb䃫o;悬ƀcipὡὤὧl;䀡s\xf4ծĀeoὬὴctatio\xeeՙnential\xe5չৡᾒ\0ᾞ\0ᾡᾧ\0\0ῆῌ\0ΐ\0ῦῪ \0 ⁚llingdotse\xf1Ṅy;䑄male;晀ƀilrᾭᾳ῁lig;耀ﬃɩᾹ\0\0᾽g;耀ﬀig;耀ﬄ;쀀\ud835\udd23lig;耀ﬁlig;쀀fjƀaltῙ῜ῡt;晭ig;耀ﬂns;斱of;䆒ǰ΅\0ῳf;쀀\ud835\udd57ĀakֿῷĀ;vῼ´拔;櫙artint;樍Āao‌⁕Ācs‑⁒α‚‰‸⁅⁈\0⁐β•‥‧‪‬\0‮耻\xbd䂽;慓耻\xbc䂼;慕;慙;慛Ƴ‴\0‶;慔;慖ʴ‾⁁\0\0⁃耻\xbe䂾;慗;慜5;慘ƶ⁌\0⁎;慚;慝8;慞l;恄wn;挢cr;쀀\ud835\udcbbࢀEabcdefgijlnorstv₂₉₟₥₰₴⃰⃵⃺⃿℃ℒℸ̗ℾ⅒↞Ā;lٍ₇;檌ƀcmpₐₕ₝ute;䇵maĀ;dₜ᳚䎳;檆reve;䄟Āiy₪₮rc;䄝;䐳ot;䄡Ȁ;lqsؾق₽⃉ƀ;qsؾٌ⃄lan\xf4٥Ȁ;cdl٥⃒⃥⃕c;檩otĀ;o⃜⃝檀Ā;l⃢⃣檂;檄Ā;e⃪⃭쀀⋛︀s;檔r;쀀\ud835\udd24Ā;gٳ؛mel;愷cy;䑓Ȁ;Eajٚℌℎℐ;檒;檥;檤ȀEaesℛℝ℩ℴ;扩pĀ;p℣ℤ檊rox\xbbℤĀ;q℮ℯ檈Ā;q℮ℛim;拧pf;쀀\ud835\udd58Āci⅃ⅆr;愊mƀ;el٫ⅎ⅐;檎;檐茀>;cdlqr׮ⅠⅪⅮⅳⅹĀciⅥⅧ;檧r;橺ot;拗Par;榕uest;橼ʀadelsↄⅪ←ٖ↛ǰ↉\0↎pro\xf8₞r;楸qĀlqؿ↖les\xf3₈i\xed٫Āen↣↭rtneqq;쀀≩︀\xc5↪ԀAabcefkosy⇄⇇⇱⇵⇺∘∝∯≨≽r\xf2ΠȀilmr⇐⇔⇗⇛rs\xf0ᒄf\xbb․il\xf4کĀdr⇠⇤cy;䑊ƀ;cwࣴ⇫⇯ir;楈;憭ar;意irc;䄥ƀalr∁∎∓rtsĀ;u∉∊晥it\xbb∊lip;怦con;抹r;쀀\ud835\udd25sĀew∣∩arow;椥arow;椦ʀamopr∺∾≃≞≣rr;懿tht;戻kĀlr≉≓eftarrow;憩ightarrow;憪f;쀀\ud835\udd59bar;怕ƀclt≯≴≸r;쀀\ud835\udcbdas\xe8⇴rok;䄧Ābp⊂⊇ull;恃hen\xbbᱛૡ⊣\0⊪\0⊸⋅⋎\0⋕⋳\0\0⋸⌢⍧⍢⍿\0⎆⎪⎴cute耻\xed䃭ƀ;iyݱ⊰⊵rc耻\xee䃮;䐸Ācx⊼⊿y;䐵cl耻\xa1䂡ĀfrΟ⋉;쀀\ud835\udd26rave耻\xec䃬Ȁ;inoܾ⋝⋩⋮Āin⋢⋦nt;樌t;戭fin;槜ta;愩lig;䄳ƀaop⋾⌚⌝ƀcgt⌅⌈⌗r;䄫ƀelpܟ⌏⌓in\xe5ގar\xf4ܠh;䄱f;抷ed;䆵ʀ;cfotӴ⌬⌱⌽⍁are;愅inĀ;t⌸⌹戞ie;槝do\xf4⌙ʀ;celpݗ⍌⍐⍛⍡al;抺Āgr⍕⍙er\xf3ᕣ\xe3⍍arhk;樗rod;樼Ȁcgpt⍯⍲⍶⍻y;䑑on;䄯f;쀀\ud835\udd5aa;䎹uest耻\xbf䂿Āci⎊⎏r;쀀\ud835\udcbenʀ;EdsvӴ⎛⎝⎡ӳ;拹ot;拵Ā;v⎦⎧拴;拳Ā;iݷ⎮lde;䄩ǫ⎸\0⎼cy;䑖l耻\xef䃯̀cfmosu⏌⏗⏜⏡⏧⏵Āiy⏑⏕rc;䄵;䐹r;쀀\ud835\udd27ath;䈷pf;쀀\ud835\udd5bǣ⏬\0⏱r;쀀\ud835\udcbfrcy;䑘kcy;䑔Ѐacfghjos␋␖␢␧␭␱␵␻ppaĀ;v␓␔䎺;䏰Āey␛␠dil;䄷;䐺r;쀀\ud835\udd28reen;䄸cy;䑅cy;䑜pf;쀀\ud835\udd5ccr;쀀\ud835\udcc0஀ABEHabcdefghjlmnoprstuv⑰⒁⒆⒍⒑┎┽╚▀♎♞♥♹♽⚚⚲⛘❝❨➋⟀⠁⠒ƀart⑷⑺⑼r\xf2৆\xf2Εail;椛arr;椎Ā;gঔ⒋;檋ar;楢ॣ⒥\0⒪\0⒱\0\0\0\0\0⒵Ⓔ\0ⓆⓈⓍ\0⓹ute;䄺mptyv;榴ra\xeeࡌbda;䎻gƀ;dlࢎⓁⓃ;榑\xe5ࢎ;檅uo耻\xab䂫rЀ;bfhlpst࢙ⓞⓦⓩ⓫⓮⓱⓵Ā;f࢝ⓣs;椟s;椝\xeb≒p;憫l;椹im;楳l;憢ƀ;ae⓿─┄檫il;椙Ā;s┉┊檭;쀀⪭︀ƀabr┕┙┝rr;椌rk;杲Āak┢┬cĀek┨┪;䁻;䁛Āes┱┳;榋lĀdu┹┻;榏;榍Ȁaeuy╆╋╖╘ron;䄾Ādi═╔il;䄼\xecࢰ\xe2┩;䐻Ȁcqrs╣╦╭╽a;椶uoĀ;rนᝆĀdu╲╷har;楧shar;楋h;憲ʀ;fgqs▋▌উ◳◿扤tʀahlrt▘▤▷◂◨rrowĀ;t࢙□a\xe9⓶arpoonĀdu▯▴own\xbbњp\xbb०eftarrows;懇ightƀahs◍◖◞rrowĀ;sࣴࢧarpoon\xf3྘quigarro\xf7⇰hreetimes;拋ƀ;qs▋ও◺lan\xf4বʀ;cdgsব☊☍☝☨c;檨otĀ;o☔☕橿Ā;r☚☛檁;檃Ā;e☢☥쀀⋚︀s;檓ʀadegs☳☹☽♉♋ppro\xf8Ⓠot;拖qĀgq♃♅\xf4উgt\xf2⒌\xf4ছi\xedলƀilr♕࣡♚sht;楼;쀀\ud835\udd29Ā;Eজ♣;檑š♩♶rĀdu▲♮Ā;l॥♳;楪lk;斄cy;䑙ʀ;achtੈ⚈⚋⚑⚖r\xf2◁orne\xf2ᴈard;楫ri;旺Āio⚟⚤dot;䅀ustĀ;a⚬⚭掰che\xbb⚭ȀEaes⚻⚽⛉⛔;扨pĀ;p⛃⛄檉rox\xbb⛄Ā;q⛎⛏檇Ā;q⛎⚻im;拦Ѐabnoptwz⛩⛴⛷✚✯❁❇❐Ānr⛮⛱g;柬r;懽r\xebࣁgƀlmr⛿✍✔eftĀar০✇ight\xe1৲apsto;柼ight\xe1৽parrowĀlr✥✩ef\xf4⓭ight;憬ƀafl✶✹✽r;榅;쀀\ud835\udd5dus;樭imes;樴š❋❏st;戗\xe1ፎƀ;ef❗❘᠀旊nge\xbb❘arĀ;l❤❥䀨t;榓ʀachmt❳❶❼➅➇r\xf2ࢨorne\xf2ᶌarĀ;d྘➃;業;怎ri;抿̀achiqt➘➝ੀ➢➮➻quo;怹r;쀀\ud835\udcc1mƀ;egল➪➬;檍;檏Ābu┪➳oĀ;rฟ➹;怚rok;䅂萀<;cdhilqrࠫ⟒☹⟜⟠⟥⟪⟰Āci⟗⟙;檦r;橹re\xe5◲mes;拉arr;楶uest;橻ĀPi⟵⟹ar;榖ƀ;ef⠀भ᠛旃rĀdu⠇⠍shar;楊har;楦Āen⠗⠡rtneqq;쀀≨︀\xc5⠞܀Dacdefhilnopsu⡀⡅⢂⢎⢓⢠⢥⢨⣚⣢⣤ઃ⣳⤂Dot;戺Ȁclpr⡎⡒⡣⡽r耻\xaf䂯Āet⡗⡙;時Ā;e⡞⡟朠se\xbb⡟Ā;sျ⡨toȀ;dluျ⡳⡷⡻ow\xeeҌef\xf4ए\xf0Ꮡker;斮Āoy⢇⢌mma;権;䐼ash;怔asuredangle\xbbᘦr;쀀\ud835\udd2ao;愧ƀcdn⢯⢴⣉ro耻\xb5䂵Ȁ;acdᑤ⢽⣀⣄s\xf4ᚧir;櫰ot肻\xb7Ƶusƀ;bd⣒ᤃ⣓戒Ā;uᴼ⣘;横ţ⣞⣡p;櫛\xf2−\xf0ઁĀdp⣩⣮els;抧f;쀀\ud835\udd5eĀct⣸⣽r;쀀\ud835\udcc2pos\xbbᖝƀ;lm⤉⤊⤍䎼timap;抸ఀGLRVabcdefghijlmoprstuvw⥂⥓⥾⦉⦘⧚⧩⨕⨚⩘⩝⪃⪕⪤⪨⬄⬇⭄⭿⮮ⰴⱧⱼ⳩Āgt⥇⥋;쀀⋙̸Ā;v⥐௏쀀≫⃒ƀelt⥚⥲⥶ftĀar⥡⥧rrow;懍ightarrow;懎;쀀⋘̸Ā;v⥻ే쀀≪⃒ightarrow;懏ĀDd⦎⦓ash;抯ash;抮ʀbcnpt⦣⦧⦬⦱⧌la\xbb˞ute;䅄g;쀀∠⃒ʀ;Eiop඄⦼⧀⧅⧈;쀀⩰̸d;쀀≋̸s;䅉ro\xf8඄urĀ;a⧓⧔普lĀ;s⧓ସǳ⧟\0⧣p肻\xa0ଷmpĀ;e௹ఀʀaeouy⧴⧾⨃⨐⨓ǰ⧹\0⧻;橃on;䅈dil;䅆ngĀ;dൾ⨊ot;쀀⩭̸p;橂;䐽ash;怓΀;Aadqsxஒ⨩⨭⨻⩁⩅⩐rr;懗rĀhr⨳⨶k;椤Ā;oᏲᏰot;쀀≐̸ui\xf6ୣĀei⩊⩎ar;椨\xed஘istĀ;s஠டr;쀀\ud835\udd2bȀEest௅⩦⩹⩼ƀ;qs஼⩭௡ƀ;qs஼௅⩴lan\xf4௢i\xed௪Ā;rஶ⪁\xbbஷƀAap⪊⪍⪑r\xf2⥱rr;憮ar;櫲ƀ;svྍ⪜ྌĀ;d⪡⪢拼;拺cy;䑚΀AEadest⪷⪺⪾⫂⫅⫶⫹r\xf2⥦;쀀≦̸rr;憚r;急Ȁ;fqs఻⫎⫣⫯tĀar⫔⫙rro\xf7⫁ightarro\xf7⪐ƀ;qs఻⪺⫪lan\xf4ౕĀ;sౕ⫴\xbbశi\xedౝĀ;rవ⫾iĀ;eచథi\xe4ඐĀpt⬌⬑f;쀀\ud835\udd5f膀\xac;in⬙⬚⬶䂬nȀ;Edvஉ⬤⬨⬮;쀀⋹̸ot;쀀⋵̸ǡஉ⬳⬵;拷;拶iĀ;vಸ⬼ǡಸ⭁⭃;拾;拽ƀaor⭋⭣⭩rȀ;ast୻⭕⭚⭟lle\xec୻l;쀀⫽⃥;쀀∂̸lint;樔ƀ;ceಒ⭰⭳u\xe5ಥĀ;cಘ⭸Ā;eಒ⭽\xf1ಘȀAait⮈⮋⮝⮧r\xf2⦈rrƀ;cw⮔⮕⮙憛;쀀⤳̸;쀀↝̸ghtarrow\xbb⮕riĀ;eೋೖ΀chimpqu⮽⯍⯙⬄୸⯤⯯Ȁ;cerല⯆ഷ⯉u\xe5൅;쀀\ud835\udcc3ortɭ⬅\0\0⯖ar\xe1⭖mĀ;e൮⯟Ā;q൴൳suĀbp⯫⯭\xe5೸\xe5ഋƀbcp⯶ⰑⰙȀ;Ees⯿ⰀഢⰄ抄;쀀⫅̸etĀ;eഛⰋqĀ;qണⰀcĀ;eലⰗ\xf1സȀ;EesⰢⰣൟⰧ抅;쀀⫆̸etĀ;e൘ⰮqĀ;qൠⰣȀgilrⰽⰿⱅⱇ\xecௗlde耻\xf1䃱\xe7ృiangleĀlrⱒⱜeftĀ;eచⱚ\xf1దightĀ;eೋⱥ\xf1೗Ā;mⱬⱭ䎽ƀ;esⱴⱵⱹ䀣ro;愖p;怇ҀDHadgilrsⲏⲔⲙⲞⲣⲰⲶⳓⳣash;抭arr;椄p;쀀≍⃒ash;抬ĀetⲨⲬ;쀀≥⃒;쀀>⃒nfin;槞ƀAetⲽⳁⳅrr;椂;쀀≤⃒Ā;rⳊⳍ쀀<⃒ie;쀀⊴⃒ĀAtⳘⳜrr;椃rie;쀀⊵⃒im;쀀∼⃒ƀAan⳰⳴ⴂrr;懖rĀhr⳺⳽k;椣Ā;oᏧᏥear;椧ቓ᪕\0\0\0\0\0\0\0\0\0\0\0\0\0ⴭ\0ⴸⵈⵠⵥ⵲ⶄᬇ\0\0ⶍⶫ\0ⷈⷎ\0ⷜ⸙⸫⸾⹃Ācsⴱ᪗ute耻\xf3䃳ĀiyⴼⵅrĀ;c᪞ⵂ耻\xf4䃴;䐾ʀabios᪠ⵒⵗǈⵚlac;䅑v;樸old;榼lig;䅓Ācr⵩⵭ir;榿;쀀\ud835\udd2cͯ⵹\0\0⵼\0ⶂn;䋛ave耻\xf2䃲;槁Ābmⶈ෴ar;榵Ȁacitⶕ⶘ⶥⶨr\xf2᪀Āir⶝ⶠr;榾oss;榻n\xe5๒;槀ƀaeiⶱⶵⶹcr;䅍ga;䏉ƀcdnⷀⷅǍron;䎿;榶pf;쀀\ud835\udd60ƀaelⷔ⷗ǒr;榷rp;榹΀;adiosvⷪⷫⷮ⸈⸍⸐⸖戨r\xf2᪆Ȁ;efmⷷⷸ⸂⸅橝rĀ;oⷾⷿ愴f\xbbⷿ耻\xaa䂪耻\xba䂺gof;抶r;橖lope;橗;橛ƀclo⸟⸡⸧\xf2⸁ash耻\xf8䃸l;折iŬⸯ⸴de耻\xf5䃵esĀ;aǛ⸺s;樶ml耻\xf6䃶bar;挽ૡ⹞\0⹽\0⺀⺝\0⺢⺹\0\0⻋ຜ\0⼓\0\0⼫⾼\0⿈rȀ;astЃ⹧⹲຅脀\xb6;l⹭⹮䂶le\xecЃɩ⹸\0\0⹻m;櫳;櫽y;䐿rʀcimpt⺋⺏⺓ᡥ⺗nt;䀥od;䀮il;怰enk;怱r;쀀\ud835\udd2dƀimo⺨⺰⺴Ā;v⺭⺮䏆;䏕ma\xf4੶ne;明ƀ;tv⺿⻀⻈䏀chfork\xbb´;䏖Āau⻏⻟nĀck⻕⻝kĀ;h⇴⻛;愎\xf6⇴sҀ;abcdemst⻳⻴ᤈ⻹⻽⼄⼆⼊⼎䀫cir;樣ir;樢Āouᵀ⼂;樥;橲n肻\xb1ຝim;樦wo;樧ƀipu⼙⼠⼥ntint;樕f;쀀\ud835\udd61nd耻\xa3䂣Ԁ;Eaceinosu່⼿⽁⽄⽇⾁⾉⾒⽾⾶;檳p;檷u\xe5໙Ā;c໎⽌̀;acens່⽙⽟⽦⽨⽾ppro\xf8⽃urlye\xf1໙\xf1໎ƀaes⽯⽶⽺pprox;檹qq;檵im;拨i\xedໟmeĀ;s⾈ຮ怲ƀEas⽸⾐⽺\xf0⽵ƀdfp໬⾙⾯ƀals⾠⾥⾪lar;挮ine;挒urf;挓Ā;t໻⾴\xef໻rel;抰Āci⿀⿅r;쀀\ud835\udcc5;䏈ncsp;怈̀fiopsu⿚⋢⿟⿥⿫⿱r;쀀\ud835\udd2epf;쀀\ud835\udd62rime;恗cr;쀀\ud835\udcc6ƀaeo⿸〉〓tĀei⿾々rnion\xf3ڰnt;樖stĀ;e【】䀿\xf1Ἑ\xf4༔઀ABHabcdefhilmnoprstux぀けさすムㄎㄫㅇㅢㅲㆎ㈆㈕㈤㈩㉘㉮㉲㊐㊰㊷ƀartぇおがr\xf2Ⴓ\xf2ϝail;検ar\xf2ᱥar;楤΀cdenqrtとふへみわゔヌĀeuねぱ;쀀∽̱te;䅕i\xe3ᅮmptyv;榳gȀ;del࿑らるろ;榒;榥\xe5࿑uo耻\xbb䂻rր;abcfhlpstw࿜ガクシスゼゾダッデナp;極Ā;f࿠ゴs;椠;椳s;椞\xeb≝\xf0✮l;楅im;楴l;憣;憝Āaiパフil;椚oĀ;nホボ戶al\xf3༞ƀabrョリヮr\xf2៥rk;杳ĀakンヽcĀekヹ・;䁽;䁝Āes㄂㄄;榌lĀduㄊㄌ;榎;榐Ȁaeuyㄗㄜㄧㄩron;䅙Ādiㄡㄥil;䅗\xec࿲\xe2ヺ;䑀Ȁclqsㄴㄷㄽㅄa;椷dhar;楩uoĀ;rȎȍh;憳ƀacgㅎㅟངlȀ;ipsླྀㅘㅛႜn\xe5Ⴛar\xf4ྩt;断ƀilrㅩဣㅮsht;楽;쀀\ud835\udd2fĀaoㅷㆆrĀduㅽㅿ\xbbѻĀ;l႑ㆄ;楬Ā;vㆋㆌ䏁;䏱ƀgns㆕ㇹㇼht̀ahlrstㆤㆰ㇂㇘㇤㇮rrowĀ;t࿜ㆭa\xe9トarpoonĀduㆻㆿow\xeeㅾp\xbb႒eftĀah㇊㇐rrow\xf3࿪arpoon\xf3Ցightarrows;應quigarro\xf7ニhreetimes;拌g;䋚ingdotse\xf1ἲƀahm㈍㈐㈓r\xf2࿪a\xf2Ց;怏oustĀ;a㈞㈟掱che\xbb㈟mid;櫮Ȁabpt㈲㈽㉀㉒Ānr㈷㈺g;柭r;懾r\xebဃƀafl㉇㉊㉎r;榆;쀀\ud835\udd63us;樮imes;樵Āap㉝㉧rĀ;g㉣㉤䀩t;榔olint;樒ar\xf2㇣Ȁachq㉻㊀Ⴜ㊅quo;怺r;쀀\ud835\udcc7Ābu・㊊oĀ;rȔȓƀhir㊗㊛㊠re\xe5ㇸmes;拊iȀ;efl㊪ၙᠡ㊫方tri;槎luhar;楨;愞ൡ㋕㋛㋟㌬㌸㍱\0㍺㎤\0\0㏬㏰\0㐨㑈㑚㒭㒱㓊㓱\0㘖\0\0㘳cute;䅛qu\xef➺Ԁ;Eaceinpsyᇭ㋳㋵㋿㌂㌋㌏㌟㌦㌩;檴ǰ㋺\0㋼;檸on;䅡u\xe5ᇾĀ;dᇳ㌇il;䅟rc;䅝ƀEas㌖㌘㌛;檶p;檺im;择olint;樓i\xedሄ;䑁otƀ;be㌴ᵇ㌵担;橦΀Aacmstx㍆㍊㍗㍛㍞㍣㍭rr;懘rĀhr㍐㍒\xeb∨Ā;oਸ਼਴t耻\xa7䂧i;䀻war;椩mĀin㍩\xf0nu\xf3\xf1t;朶rĀ;o㍶⁕쀀\ud835\udd30Ȁacoy㎂㎆㎑㎠rp;景Āhy㎋㎏cy;䑉;䑈rtɭ㎙\0\0㎜i\xe4ᑤara\xec⹯耻\xad䂭Āgm㎨㎴maƀ;fv㎱㎲㎲䏃;䏂Ѐ;deglnprካ㏅㏉㏎㏖㏞㏡㏦ot;橪Ā;q኱ኰĀ;E㏓㏔檞;檠Ā;E㏛㏜檝;檟e;扆lus;樤arr;楲ar\xf2ᄽȀaeit㏸㐈㐏㐗Āls㏽㐄lsetm\xe9㍪hp;樳parsl;槤Ādlᑣ㐔e;挣Ā;e㐜㐝檪Ā;s㐢㐣檬;쀀⪬︀ƀflp㐮㐳㑂tcy;䑌Ā;b㐸㐹䀯Ā;a㐾㐿槄r;挿f;쀀\ud835\udd64aĀdr㑍ЂesĀ;u㑔㑕晠it\xbb㑕ƀcsu㑠㑹㒟Āau㑥㑯pĀ;sᆈ㑫;쀀⊓︀pĀ;sᆴ㑵;쀀⊔︀uĀbp㑿㒏ƀ;esᆗᆜ㒆etĀ;eᆗ㒍\xf1ᆝƀ;esᆨᆭ㒖etĀ;eᆨ㒝\xf1ᆮƀ;afᅻ㒦ְrť㒫ֱ\xbbᅼar\xf2ᅈȀcemt㒹㒾㓂㓅r;쀀\ud835\udcc8tm\xee\xf1i\xec㐕ar\xe6ᆾĀar㓎㓕rĀ;f㓔ឿ昆Āan㓚㓭ightĀep㓣㓪psilo\xeeỠh\xe9⺯s\xbb⡒ʀbcmnp㓻㕞ሉ㖋㖎Ҁ;Edemnprs㔎㔏㔑㔕㔞㔣㔬㔱㔶抂;櫅ot;檽Ā;dᇚ㔚ot;櫃ult;櫁ĀEe㔨㔪;櫋;把lus;檿arr;楹ƀeiu㔽㕒㕕tƀ;en㔎㕅㕋qĀ;qᇚ㔏eqĀ;q㔫㔨m;櫇Ābp㕚㕜;櫕;櫓c̀;acensᇭ㕬㕲㕹㕻㌦ppro\xf8㋺urlye\xf1ᇾ\xf1ᇳƀaes㖂㖈㌛ppro\xf8㌚q\xf1㌗g;晪ڀ123;Edehlmnps㖩㖬㖯ሜ㖲㖴㗀㗉㗕㗚㗟㗨㗭耻\xb9䂹耻\xb2䂲耻\xb3䂳;櫆Āos㖹㖼t;檾ub;櫘Ā;dሢ㗅ot;櫄sĀou㗏㗒l;柉b;櫗arr;楻ult;櫂ĀEe㗤㗦;櫌;抋lus;櫀ƀeiu㗴㘉㘌tƀ;enሜ㗼㘂qĀ;qሢ㖲eqĀ;q㗧㗤m;櫈Ābp㘑㘓;櫔;櫖ƀAan㘜㘠㘭rr;懙rĀhr㘦㘨\xeb∮Ā;oਫ਩war;椪lig耻\xdf䃟௡㙑㙝㙠ዎ㙳㙹\0㙾㛂\0\0\0\0\0㛛㜃\0㜉㝬\0\0\0㞇ɲ㙖\0\0㙛get;挖;䏄r\xeb๟ƀaey㙦㙫㙰ron;䅥dil;䅣;䑂lrec;挕r;쀀\ud835\udd31Ȁeiko㚆㚝㚵㚼ǲ㚋\0㚑eĀ4fኄኁaƀ;sv㚘㚙㚛䎸ym;䏑Ācn㚢㚲kĀas㚨㚮ppro\xf8዁im\xbbኬs\xf0ኞĀas㚺㚮\xf0዁rn耻\xfe䃾Ǭ̟㛆⋧es膀\xd7;bd㛏㛐㛘䃗Ā;aᤏ㛕r;樱;樰ƀeps㛡㛣㜀\xe1⩍Ȁ;bcf҆㛬㛰㛴ot;挶ir;櫱Ā;o㛹㛼쀀\ud835\udd65rk;櫚\xe1㍢rime;怴ƀaip㜏㜒㝤d\xe5ቈ΀adempst㜡㝍㝀㝑㝗㝜㝟ngleʀ;dlqr㜰㜱㜶㝀㝂斵own\xbbᶻeftĀ;e⠀㜾\xf1म;扜ightĀ;e㊪㝋\xf1ၚot;旬inus;樺lus;樹b;槍ime;樻ezium;揢ƀcht㝲㝽㞁Āry㝷㝻;쀀\ud835\udcc9;䑆cy;䑛rok;䅧Āio㞋㞎x\xf4᝷headĀlr㞗㞠eftarro\xf7ࡏightarrow\xbbཝऀAHabcdfghlmoprstuw㟐㟓㟗㟤㟰㟼㠎㠜㠣㠴㡑㡝㡫㢩㣌㣒㣪㣶r\xf2ϭar;楣Ācr㟜㟢ute耻\xfa䃺\xf2ᅐrǣ㟪\0㟭y;䑞ve;䅭Āiy㟵㟺rc耻\xfb䃻;䑃ƀabh㠃㠆㠋r\xf2Ꭽlac;䅱a\xf2ᏃĀir㠓㠘sht;楾;쀀\ud835\udd32rave耻\xf9䃹š㠧㠱rĀlr㠬㠮\xbbॗ\xbbႃlk;斀Āct㠹㡍ɯ㠿\0\0㡊rnĀ;e㡅㡆挜r\xbb㡆op;挏ri;旸Āal㡖㡚cr;䅫肻\xa8͉Āgp㡢㡦on;䅳f;쀀\ud835\udd66̀adhlsuᅋ㡸㡽፲㢑㢠own\xe1ᎳarpoonĀlr㢈㢌ef\xf4㠭igh\xf4㠯iƀ;hl㢙㢚㢜䏅\xbbᏺon\xbb㢚parrows;懈ƀcit㢰㣄㣈ɯ㢶\0\0㣁rnĀ;e㢼㢽挝r\xbb㢽op;挎ng;䅯ri;旹cr;쀀\ud835\udccaƀdir㣙㣝㣢ot;拰lde;䅩iĀ;f㜰㣨\xbb᠓Āam㣯㣲r\xf2㢨l耻\xfc䃼angle;榧ހABDacdeflnoprsz㤜㤟㤩㤭㦵㦸㦽㧟㧤㧨㧳㧹㧽㨁㨠r\xf2ϷarĀ;v㤦㤧櫨;櫩as\xe8ϡĀnr㤲㤷grt;榜΀eknprst㓣㥆㥋㥒㥝㥤㦖app\xe1␕othin\xe7ẖƀhir㓫⻈㥙op\xf4⾵Ā;hᎷ㥢\xefㆍĀiu㥩㥭gm\xe1㎳Ābp㥲㦄setneqĀ;q㥽㦀쀀⊊︀;쀀⫋︀setneqĀ;q㦏㦒쀀⊋︀;쀀⫌︀Āhr㦛㦟et\xe1㚜iangleĀlr㦪㦯eft\xbbथight\xbbၑy;䐲ash\xbbံƀelr㧄㧒㧗ƀ;beⷪ㧋㧏ar;抻q;扚lip;拮Ābt㧜ᑨa\xf2ᑩr;쀀\ud835\udd33tr\xe9㦮suĀbp㧯㧱\xbbജ\xbb൙pf;쀀\ud835\udd67ro\xf0໻tr\xe9㦴Ācu㨆㨋r;쀀\ud835\udccbĀbp㨐㨘nĀEe㦀㨖\xbb㥾nĀEe㦒㨞\xbb㦐igzag;榚΀cefoprs㨶㨻㩖㩛㩔㩡㩪irc;䅵Ādi㩀㩑Ābg㩅㩉ar;機eĀ;qᗺ㩏;扙erp;愘r;쀀\ud835\udd34pf;쀀\ud835\udd68Ā;eᑹ㩦at\xe8ᑹcr;쀀\ud835\udcccૣណ㪇\0㪋\0㪐㪛\0\0㪝㪨㪫㪯\0\0㫃㫎\0㫘ៜ៟tr\xe9៑r;쀀\ud835\udd35ĀAa㪔㪗r\xf2σr\xf2৶;䎾ĀAa㪡㪤r\xf2θr\xf2৫a\xf0✓is;拻ƀdptឤ㪵㪾Āfl㪺ឩ;쀀\ud835\udd69im\xe5ឲĀAa㫇㫊r\xf2ώr\xf2ਁĀcq㫒ីr;쀀\ud835\udccdĀpt៖㫜r\xe9។Ѐacefiosu㫰㫽㬈㬌㬑㬕㬛㬡cĀuy㫶㫻te耻\xfd䃽;䑏Āiy㬂㬆rc;䅷;䑋n耻\xa5䂥r;쀀\ud835\udd36cy;䑗pf;쀀\ud835\udd6acr;쀀\ud835\udcceĀcm㬦㬩y;䑎l耻\xff䃿Ԁacdefhiosw㭂㭈㭔㭘㭤㭩㭭㭴㭺㮀cute;䅺Āay㭍㭒ron;䅾;䐷ot;䅼Āet㭝㭡tr\xe6ᕟa;䎶r;쀀\ud835\udd37cy;䐶grarr;懝pf;쀀\ud835\udd6bcr;쀀\ud835\udccfĀjn㮅㮇;怍j;怌'
            .split("")
            .map((e) => e.charCodeAt(0)),
        ),
        l = new Uint16Array(
          "Ȁaglq	\x15\x18\x1bɭ\x0f\0\0\x12p;䀦os;䀧t;䀾t;䀼uot;䀢"
            .split("")
            .map((e) => e.charCodeAt(0)),
        ),
        s = new Map([
          [0, 65533],
          [128, 8364],
          [130, 8218],
          [131, 402],
          [132, 8222],
          [133, 8230],
          [134, 8224],
          [135, 8225],
          [136, 710],
          [137, 8240],
          [138, 352],
          [139, 8249],
          [140, 338],
          [142, 381],
          [145, 8216],
          [146, 8217],
          [147, 8220],
          [148, 8221],
          [149, 8226],
          [150, 8211],
          [151, 8212],
          [152, 732],
          [153, 8482],
          [154, 353],
          [155, 8250],
          [156, 339],
          [158, 382],
          [159, 376],
        ]),
        c =
          null != (r = String.fromCodePoint)
            ? r
            : function (e) {
                let t = "";
                return (
                  e > 65535 &&
                    ((e -= 65536),
                    (t += String.fromCharCode(((e >>> 10) & 1023) | 55296)),
                    (e = 56320 | (1023 & e))),
                  (t += String.fromCharCode(e))
                );
              };
      function u(e) {
        return function (t, n) {
          let r = "",
            o = 0,
            l = 0;
          for (; (l = t.indexOf("&", l)) >= 0; ) {
            if (((r += t.slice(o, l)), (o = l), (l += 1), t.charCodeAt(l) === i.NUM)) {
              let e = l + 1,
                a = 10,
                u = t.charCodeAt(e);
              (u | i.To_LOWER_BIT) === i.LOWER_X && ((a = 16), (l += 1), (e += 1));
              do {
                u = t.charCodeAt(++l);
              } while (
                (u >= i.ZERO && u <= i.NINE) ||
                (16 === a && (u | i.To_LOWER_BIT) >= i.LOWER_A && (u | i.To_LOWER_BIT) <= i.LOWER_F)
              );
              if (e !== l) {
                let u = parseInt(t.substring(e, l), a);
                if (t.charCodeAt(l) === i.SEMI) {
                  l += 1;
                } else if (n) {
                  continue;
                }
                ((r += (function (e) {
                  var t;
                  return c(
                    (e >= 55296 && e <= 57343) || e > 1114111
                      ? 65533
                      : null != (t = s.get(e))
                        ? t
                        : e,
                  );
                })(u)),
                  (o = l));
              }
              continue;
            }
            let u = 0,
              p = 1,
              h = 0,
              f = e[0];
            for (; l < t.length && !((h = d(e, f, h + 1, t.charCodeAt(l))) < 0); l++, p++) {
              let r = (f = e[h]) & a.VALUE_LENGTH;
              if (r) {
                (n && t.charCodeAt(l) !== i.SEMI) || ((u = h), (p = 0));
                let e = (r >> 14) - 1;
                if (0 === e) {
                  break;
                }
                h += e;
              }
            }
            if (0 !== u) {
              let t = (e[u] & a.VALUE_LENGTH) >> 14;
              ((r +=
                1 === t
                  ? String.fromCharCode(e[u] & ~a.VALUE_LENGTH)
                  : 2 === t
                    ? String.fromCharCode(e[u + 1])
                    : String.fromCharCode(e[u + 1], e[u + 2])),
                (o = l - p + 1));
            }
          }
          return r + t.slice(o);
        };
      }
      function d(e, t, n, r) {
        let i = (t & a.BRANCH_LENGTH) >> 7,
          o = t & a.JUMP_TABLE;
        if (0 === i) {
          return 0 !== o && r === o ? n : -1;
        }
        if (o) {
          let t = r - o;
          return t < 0 || t >= i ? -1 : e[n + t] - 1;
        }
        let l = n,
          s = l + i - 1;
        for (; l <= s; ) {
          let t = (l + s) >>> 1,
            n = e[t];
          if (n < r) {
            l = t + 1;
          } else {
            if (!(n > r)) {
              return e[t + i];
            }
            s = t - 1;
          }
        }
        return -1;
      }
      (!(function (e) {
        ((e[(e.NUM = 35)] = "NUM"),
          (e[(e.SEMI = 59)] = "SEMI"),
          (e[(e.ZERO = 48)] = "ZERO"),
          (e[(e.NINE = 57)] = "NINE"),
          (e[(e.LOWER_A = 97)] = "LOWER_A"),
          (e[(e.LOWER_F = 102)] = "LOWER_F"),
          (e[(e.LOWER_X = 120)] = "LOWER_X"),
          (e[(e.To_LOWER_BIT = 32)] = "To_LOWER_BIT"));
      })(i || (i = {})),
        (function (e) {
          ((e[(e.VALUE_LENGTH = 49152)] = "VALUE_LENGTH"),
            (e[(e.BRANCH_LENGTH = 16256)] = "BRANCH_LENGTH"),
            (e[(e.JUMP_TABLE = 127)] = "JUMP_TABLE"));
        })(a || (a = {})),
        u(o),
        u(l));
    },
    96018: (e, t, n) => {
      "use strict";
      n.d(t, { d: () => i });
      let r = {};
      function i(e, t) {
        let n = t || r;
        return a(
          e,
          "boolean" != typeof n.includeImageAlt || n.includeImageAlt,
          "boolean" != typeof n.includeHtml || n.includeHtml,
        );
      }
      function a(e, t, n) {
        var r;
        if ((r = e) && "object" == typeof r) {
          if ("value" in e) {
            return "html" !== e.type || n ? e.value : "";
          }
          if (t && "alt" in e && e.alt) {
            return e.alt;
          }
          if ("children" in e) {
            return o(e.children, t, n);
          }
        }
        return Array.isArray(e) ? o(e, t, n) : "";
      }
      function o(e, t, n) {
        let r = [],
          i = -1;
        for (; ++i < e.length; ) {
          r[i] = a(e[i], t, n);
        }
        return r.join("");
      }
    },
    96541: (e, t, n) => {
      "use strict";
      n.d(t, { IN: () => a, dc: () => o, _Z: () => l, VG: () => s });
      var r = n(70333);
      let i = [],
        a = !0,
        o = !1,
        l = "skip";
      function s(e, t, n, s) {
        let c;
        "function" == typeof t && "function" != typeof n ? ((s = n), (n = t)) : (c = t);
        let u = (0, r.C)(c),
          d = s ? -1 : 1;
        (function e(r, c, p) {
          let h = r && "object" == typeof r ? r : {};
          if ("string" == typeof h.type) {
            let e =
              "string" == typeof h.tagName
                ? h.tagName
                : "string" == typeof h.name
                  ? h.name
                  : void 0;
            Object.defineProperty(f, "name", {
              value: "node (" + r.type + (e ? "<" + e + ">" : "") + ")",
            });
          }
          return f;
          function f() {
            var h;
            let f,
              m,
              T,
              g = i;
            if (
              (!t || u(r, c, p[p.length - 1] || void 0)) &&
              (g = Array.isArray((h = n(r, p)))
                ? h
                : "number" == typeof h
                  ? [a, h]
                  : null == h
                    ? i
                    : [h])[0] === o
            ) {
              return g;
            }
            if ("children" in r && r.children && r.children && g[0] !== l) {
              for (
                m = (s ? r.children.length : -1) + d, T = p.concat(r);
                m > -1 && m < r.children.length;
              ) {
                if ((f = e(r.children[m], m, T)())[0] === o) return f;
                m = "number" == typeof f[1] ? f[1] : m + d;
              }
            }
            return g;
          }
        })(e, void 0, [])();
      }
    },
    97058: (e, t, n) => {
      "use strict";
      n.d(t, {
        BM: () => s,
        CW: () => i,
        Ee: () => p,
        HP: () => d,
        JQ: () => l,
        Ny: () => m,
        On: () => h,
        cx: () => o,
        es: () => f,
        lV: () => a,
        ok: () => c,
        ol: () => u,
      });
      let r = T(/\p{P}/u),
        i = T(/[A-Za-z]/),
        a = T(/[\dA-Za-z]/),
        o = T(/[#-'*+\--9=?A-Z^-~]/);
      function l(e) {
        return null !== e && (e < 32 || 127 === e);
      }
      let s = T(/\d/),
        c = T(/[\dA-Fa-f]/),
        u = T(/[!-/:-@[-`{-~]/);
      function d(e) {
        return null !== e && e < -2;
      }
      function p(e) {
        return null !== e && (e < 0 || 32 === e);
      }
      function h(e) {
        return -2 === e || -1 === e || 32 === e;
      }
      function f(e) {
        return u(e) || r(e);
      }
      let m = T(/\s/);
      function T(e) {
        return function (t) {
          return null !== t && t > -1 && e.test(String.fromCharCode(t));
        };
      }
    },
    98770: (e) => {
      "use strict";
      e.exports = URIError;
    },
  },
]);
