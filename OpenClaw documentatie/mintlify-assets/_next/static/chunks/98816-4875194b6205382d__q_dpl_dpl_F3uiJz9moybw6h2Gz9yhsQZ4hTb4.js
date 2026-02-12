"use strict";
(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [98816],
  {
    862: (e, t, r) => {
      r.d(t, { J: () => n });
      class n {
        constructor(e, t = {}) {
          ((this.patterns = e), (this.options = t));
          let { forgiving: r = !1, cache: n, regexConstructor: a } = t;
          if (!a) {
            throw Error("Option `regexConstructor` is not provided");
          }
          this.regexps = e.map((e) => {
            if ("string" != typeof e) {
              return e;
            }
            let t = n?.get(e);
            if (t) {
              if (t instanceof RegExp) {
                return t;
              }
              if (r) {
                return null;
              }
              throw t;
            }
            try {
              let t = a(e);
              return (n?.set(e, t), t);
            } catch (t) {
              if ((n?.set(e, t), r)) {
                return null;
              }
              throw t;
            }
          });
        }
        regexps;
        findNextMatchSync(e, t, r) {
          let n = "string" == typeof e ? e : e.content,
            a = [];
          function o(e, t, r = 0) {
            return {
              index: e,
              captureIndices: t.indices.map((e) =>
                null == e
                  ? { start: 0xffffffff, end: 0xffffffff, length: 0 }
                  : { start: e[0] + r, end: e[1] + r, length: e[1] - e[0] },
              ),
            };
          }
          for (let e = 0; e < this.regexps.length; e++) {
            let r = this.regexps[e];
            if (r) {
              try {
                r.lastIndex = t;
                let i = r.exec(n);
                if (!i) continue;
                if (i.index === t) return o(e, i, 0);
                a.push([e, i, 0]);
              } catch (e) {
                if (this.options.forgiving) continue;
                throw e;
              }
            }
          }
          if (a.length) {
            let e = Math.min(...a.map((e) => e[1].index));
            for (let [t, r, n] of a) {
              if (r.index === e) return o(t, r, n);
            }
          }
          return null;
        }
      }
    },
    66711: (e, t, r) => {
      function n(e) {
        if (1 != [...e].length) {
          throw Error(`Expected "${e}" to be a single code point`);
        }
        return e.codePointAt(0);
      }
      r.d(t, { vr: () => e3 });
      let a = new Set([
          "alnum",
          "alpha",
          "ascii",
          "blank",
          "cntrl",
          "digit",
          "graph",
          "lower",
          "print",
          "punct",
          "space",
          "upper",
          "word",
          "xdigit",
        ]),
        o = String.raw;
      function i(e, t) {
        if (null == e) {
          throw Error(t ?? "Value expected");
        }
        return e;
      }
      let s = o`\[\^?`,
        l = `c.? | C(?:-.?)?|${o`[pP]\{(?:\^?[-\x20_]*[A-Za-z][-\x20\w]*\})?`}|${o`x[89A-Fa-f]\p{AHex}(?:\\x[89A-Fa-f]\p{AHex})*`}|${o`u(?:\p{AHex}{4})? | x\{[^\}]*\}? | x\p{AHex}{0,2}`}|${o`o\{[^\}]*\}?`}|${o`\d{1,3}`}`,
        u = /[?*+][?+]?|\{(?:\d+(?:,\d*)?|,\d+)\}\??/,
        p = RegExp(
          o`
  \\ (?:
    ${l}
    | [gk]<[^>]*>?
    | [gk]'[^']*'?
    | .
  )
  | \( (?:
    \? (?:
      [:=!>({]
      | <[=!]
      | <[^>]*>
      | '[^']*'
      | ~\|?
      | #(?:[^)\\]|\\.?)*
      | [^:)]*[:)]
    )?
    | \*[^\)]*\)?
  )?
  | (?:${u.source})+
  | ${s}
  | .
`.replace(/\s+/g, ""),
          "gsu",
        ),
        c = RegExp(
          o`
  \\ (?:
    ${l}
    | .
  )
  | \[:(?:\^?\p{Alpha}+|\^):\]
  | ${s}
  | &&
  | .
`.replace(/\s+/g, ""),
          "gsu",
        );
      function d(e, { inCharClass: t }) {
        let r = e[1];
        if ("c" === r || "C" === r) {
          var a = e;
          let t = "c" === a[1] ? a[2] : a[3];
          if (!t || !/[A-Za-z]/.test(t)) {
            throw Error(`Unsupported control character "${a}"`);
          }
          return h(n(t.toUpperCase()) - 64, a);
        }
        if ("dDhHsSwW".includes(r)) {
          var i = e;
          let t = i[1].toLowerCase();
          return m({ d: "digit", h: "hex", s: "space", w: "word" }[t], i, { negate: i[1] !== t });
        }
        if (e.startsWith(o`\o{`)) {
          throw Error(`Incomplete, invalid, or unsupported octal code point "${e}"`);
        }
        if (/^\\[pP]\{/.test(e)) {
          if (3 === e.length) {
            throw Error(`Incomplete or invalid Unicode property "${e}"`);
          }
          var s = e;
          let {
            p: t,
            neg: r,
            value: n,
          } = /^\\(?<p>[pP])\{(?<neg>\^?)(?<value>[^}]+)/.exec(s).groups;
          return m("property", s, { value: n, negate: ("P" === t && !r) || ("p" === t && !!r) });
        }
        if (/^\\x[89A-Fa-f]\p{AHex}/u.test(e)) {
          try {
            let t = e
                .split(/\\x/)
                .slice(1)
                .map((e) => parseInt(e, 16)),
              r = new TextDecoder("utf-8", { ignoreBOM: !0, fatal: !0 }).decode(new Uint8Array(t)),
              a = new TextEncoder();
            return [...r].map((e) => {
              let t = [...a.encode(e)].map((e) => `\\x${e.toString(16)}`).join("");
              return h(n(e), t);
            });
          } catch {
            throw Error(`Multibyte code "${e}" incomplete or invalid in Oniguruma`);
          }
        }
        if ("u" === r || "x" === r) {
          return h(
            (function (e) {
              if (/^(?:\\u(?!\p{AHex}{4})|\\x(?!\p{AHex}{1,2}|\{\p{AHex}{1,8}\}))/u.test(e))
                throw Error(`Incomplete or invalid escape "${e}"`);
              return parseInt(
                "{" === e[2] ? /^\\x\{\s*(?<hex>\p{AHex}+)/u.exec(e).groups.hex : e.slice(2),
                16,
              );
            })(e),
            e,
          );
        }
        if (x.has(r)) {
          return h(x.get(r), e);
        }
        if (/\d/.test(r)) {
          return { type: "EscapedNumber", inCharClass: t, raw: e };
        }
        if ("\\" === e) {
          throw Error(o`Incomplete escape "\"`);
        }
        if ("M" === r) {
          throw Error(`Unsupported meta "${e}"`);
        }
        if (2 == [...e].length) {
          return h(e.codePointAt(1), e);
        }
        throw Error(`Unexpected escape "${e}"`);
      }
      function f(e, t) {
        return { type: "Assertion", kind: e, raw: t };
      }
      function g(e) {
        return { type: "Backreference", raw: e };
      }
      function h(e, t) {
        return { type: "Character", value: e, raw: t };
      }
      function y(e, t) {
        return { type: "CharacterClassOpen", negate: e, raw: t };
      }
      function m(e, t, r = {}) {
        return { type: "CharacterSet", kind: e, ...r, raw: t };
      }
      function b(e, t, r = {}) {
        return "keep" === e
          ? { type: "Directive", kind: e, raw: t }
          : { type: "Directive", kind: e, flags: i(r.flags), raw: t };
      }
      function C(e, t, r = {}) {
        return { type: "GroupOpen", kind: e, ...r, raw: t };
      }
      let w = new Set(["COUNT", "CMP", "ERROR", "FAIL", "MAX", "MISMATCH", "SKIP", "TOTAL_COUNT"]),
        x = new Map([
          ["a", 7],
          ["b", 8],
          ["e", 27],
          ["f", 12],
          ["n", 10],
          ["r", 13],
          ["t", 9],
          ["v", 11],
        ]);
      function k(e) {
        let t = null,
          r,
          n;
        if ("{" === e[0]) {
          let { minStr: a, maxStr: o } = /^\{(?<minStr>\d*)(?:,(?<maxStr>\d*))?/.exec(e).groups;
          if (+a > 1e5 || (o && +o > 1e5)) {
            throw Error("Quantifier value unsupported in Oniguruma");
          }
          if (
            ((r = +a) > (n = void 0 === o ? +a : "" === o ? 1 / 0 : +o) &&
              ((t = "possessive"), ([r, n] = [n, r])),
            e.endsWith("?"))
          ) {
            if ("possessive" === t) {
              throw Error('Unsupported possessive interval quantifier chain with "?"');
            }
            t = "lazy";
          } else {
            t || (t = "greedy");
          }
        } else {
          ((r = +("+" === e[0])),
            (n = "?" === e[0] ? 1 : 1 / 0),
            (t = "+" === e[1] ? "possessive" : "?" === e[1] ? "lazy" : "greedy"));
        }
        return { type: "Quantifier", kind: t, min: r, max: n, raw: e };
      }
      function E(e) {
        let t = {};
        return (
          e.includes("i") && (t.ignoreCase = !0),
          e.includes("m") && (t.dotAll = !0),
          e.includes("x") && (t.extended = !0),
          Object.keys(t).length ? t : null
        );
      }
      function $(e, t) {
        if (!Array.isArray(e.body)) {
          throw Error("Expected node with body array");
        }
        if (1 !== e.body.length) {
          return !1;
        }
        let r = e.body[0];
        return !t || Object.keys(t).every((e) => t[e] === r[e]);
      }
      let A = new Set([
        "AbsenceFunction",
        "Backreference",
        "CapturingGroup",
        "Character",
        "CharacterClass",
        "CharacterSet",
        "Group",
        "Quantifier",
        "Subroutine",
      ]);
      function I(e, t = {}) {
        var r;
        let s = {
            flags: "",
            normalizeUnknownPropertyNames: !1,
            skipBackrefValidation: !1,
            skipLookbehindValidation: !1,
            skipPropertyNameValidation: !1,
            unicodePropertyMap: null,
            ...t,
            rules: { captureGroup: !1, singleline: !1, ...t.rules },
          },
          l = (function (e, t = {}) {
            let r = { flags: "", ...t, rules: { captureGroup: !1, singleline: !1, ...t.rules } };
            if ("string" != typeof e) {
              throw Error("String expected as pattern");
            }
            let i = (function (e) {
                let t = {
                  ignoreCase: !1,
                  dotAll: !1,
                  extended: !1,
                  digitIsAscii: !1,
                  posixIsAscii: !1,
                  spaceIsAscii: !1,
                  wordIsAscii: !1,
                  textSegmentMode: null,
                };
                for (let r = 0; r < e.length; r++) {
                  let n = e[r];
                  if (!"imxDPSWy".includes(n)) {
                    throw Error(`Invalid flag "${n}"`);
                  }
                  if ("y" === n) {
                    if (!/^y{[gw]}/.test(e.slice(r))) {
                      throw Error('Invalid or unspecified flag "y" mode');
                    }
                    ((t.textSegmentMode = "g" === e[r + 2] ? "grapheme" : "word"), (r += 3));
                    continue;
                  }
                  t[
                    {
                      i: "ignoreCase",
                      m: "dotAll",
                      x: "extended",
                      D: "digitIsAscii",
                      P: "posixIsAscii",
                      S: "spaceIsAscii",
                      W: "wordIsAscii",
                    }[n]
                  ] = !0;
                }
                return t;
              })(r.flags),
              s = [i.extended],
              l = {
                captureGroup: r.rules.captureGroup,
                getCurrentModX: () => s.at(-1),
                numOpenGroups: 0,
                popModX() {
                  s.pop();
                },
                pushModX(e) {
                  s.push(e);
                },
                replaceCurrentModX(e) {
                  s[s.length - 1] = e;
                },
                singleline: r.rules.singleline,
              },
              x = [],
              $;
            for (p.lastIndex = 0; ($ = p.exec(e)); ) {
              let t = (function (e, t, r, i) {
                let [s, l] = r;
                if ("[" === r || "[^" === r) {
                  let e = (function (e, t, r) {
                    let o = [y("^" === t[1], t)],
                      i = 1,
                      s;
                    for (c.lastIndex = r; (s = c.exec(e)); ) {
                      let e = s[0];
                      if ("[" === e[0] && ":" !== e[1]) {
                        (i++, o.push(y("^" === e[1], e)));
                      } else if ("]" === e) {
                        if ("CharacterClassOpen" === o.at(-1).type) {
                          o.push(h(93, e));
                        } else if ((i--, o.push({ type: "CharacterClassClose", raw: e }), !i)) {
                          break;
                        }
                      } else {
                        let t = (function (e) {
                          if ("\\" === e[0]) {
                            return d(e, { inCharClass: !0 });
                          }
                          if ("[" === e[0]) {
                            let t = /\[:(?<negate>\^?)(?<name>[a-z]+):\]/.exec(e);
                            if (!t || !a.has(t.groups.name)) {
                              throw Error(`Invalid POSIX class "${e}"`);
                            }
                            return m("posix", e, {
                              value: t.groups.name,
                              negate: !!t.groups.negate,
                            });
                          }
                          return "-" === e
                            ? { type: "CharacterClassHyphen", raw: e }
                            : "&&" === e
                              ? { type: "CharacterClassIntersector", raw: e }
                              : h(n(e), e);
                        })(e);
                        Array.isArray(t) ? o.push(...t) : o.push(t);
                      }
                    }
                    return { tokens: o, lastIndex: c.lastIndex || e.length };
                  })(t, r, i);
                  return { tokens: e.tokens, lastIndex: e.lastIndex };
                }
                if ("\\" === s) {
                  if ("AbBGyYzZ".includes(l)) {
                    return { token: f(r, r) };
                  }
                  if (/^\\g[<']/.test(r)) {
                    if (!/^\\g(?:<[^>]+>|'[^']+')$/.test(r)) {
                      throw Error(`Invalid group name "${r}"`);
                    }
                    return { token: { type: "Subroutine", raw: r } };
                  }
                  if (/^\\k[<']/.test(r)) {
                    if (!/^\\k(?:<[^>]+>|'[^']+')$/.test(r)) {
                      throw Error(`Invalid group name "${r}"`);
                    }
                    return { token: g(r) };
                  }
                  if ("K" === l) {
                    return { token: b("keep", r) };
                  }
                  if ("N" === l || "R" === l) {
                    return { token: m("newline", r, { negate: "N" === l }) };
                  }
                  if ("O" === l) {
                    return { token: m("any", r) };
                  }
                  if ("X" === l) {
                    return { token: m("text_segment", r) };
                  }
                  let e = d(r, { inCharClass: !1 });
                  return Array.isArray(e) ? { tokens: e } : { token: e };
                }
                if ("(" === s) {
                  if ("*" === l) {
                    return {
                      token: (function (e) {
                        let t =
                          /\(\*(?<name>[A-Za-z_]\w*)?(?:\[(?<tag>(?:[A-Za-z_]\w*)?)\])?(?:\{(?<args>[^}]*)\})?\)/.exec(
                            e,
                          );
                        if (!t) throw Error(`Incomplete or invalid named callout "${e}"`);
                        let { name: r, tag: n, args: a } = t.groups;
                        if (!r) throw Error(`Invalid named callout "${e}"`);
                        if ("" === n)
                          throw Error(`Named callout tag with empty value not allowed "${e}"`);
                        let o = a
                            ? a
                                .split(",")
                                .filter((e) => "" !== e)
                                .map((e) => (/^[+-]?\d+$/.test(e) ? +e : e))
                            : [],
                          [i, s, l] = o,
                          u = w.has(r) ? r.toLowerCase() : "custom";
                        switch (u) {
                          case "fail":
                          case "mismatch":
                          case "skip":
                            if (o.length > 0)
                              throw Error(`Named callout arguments not allowed "${o}"`);
                            break;
                          case "error":
                            if (o.length > 1)
                              throw Error(`Named callout allows only one argument "${o}"`);
                            if ("string" == typeof i)
                              throw Error(`Named callout argument must be a number "${i}"`);
                            break;
                          case "max":
                            if (!o.length || o.length > 2)
                              throw Error(`Named callout must have one or two arguments "${o}"`);
                            if ("string" == typeof i && !/^[A-Za-z_]\w*$/.test(i))
                              throw Error(
                                `Named callout argument one must be a tag or number "${i}"`,
                              );
                            if (2 === o.length && ("number" == typeof s || !/^[<>X]$/.test(s)))
                              throw Error(
                                `Named callout optional argument two must be '<', '>', or 'X' "${s}"`,
                              );
                            break;
                          case "count":
                          case "total_count":
                            if (o.length > 1)
                              throw Error(`Named callout allows only one argument "${o}"`);
                            if (1 === o.length && ("number" == typeof i || !/^[<>X]$/.test(i)))
                              throw Error(
                                `Named callout optional argument must be '<', '>', or 'X' "${i}"`,
                              );
                            break;
                          case "cmp":
                            if (3 !== o.length)
                              throw Error(`Named callout must have three arguments "${o}"`);
                            if ("string" == typeof i && !/^[A-Za-z_]\w*$/.test(i))
                              throw Error(
                                `Named callout argument one must be a tag or number "${i}"`,
                              );
                            if ("number" == typeof s || !/^(?:[<>!=]=|[<>])$/.test(s))
                              throw Error(
                                `Named callout argument two must be '==', '!=', '>', '<', '>=', or '<=' "${s}"`,
                              );
                            if ("string" == typeof l && !/^[A-Za-z_]\w*$/.test(l))
                              throw Error(
                                `Named callout argument three must be a tag or number "${l}"`,
                              );
                            break;
                          case "custom":
                            throw Error(`Undefined callout name "${r}"`);
                          default:
                            throw Error(`Unexpected named callout kind "${u}"`);
                        }
                        return {
                          type: "NamedCallout",
                          kind: u,
                          tag: n ?? null,
                          arguments: a?.split(",") ?? null,
                          raw: e,
                        };
                      })(r),
                    };
                  }
                  if ("(?{" === r) {
                    throw Error(`Unsupported callout "${r}"`);
                  }
                  if (r.startsWith("(?#")) {
                    if (")" !== t[i]) {
                      throw Error('Unclosed comment group "(?#"');
                    }
                    return { lastIndex: i + 1 };
                  }
                  if (/^\(\?[-imx]+[:)]$/.test(r)) {
                    return {
                      token: (function (e, t) {
                        let { on: r, off: n } = /^\(\?(?<on>[imx]*)(?:-(?<off>[-imx]*))?/.exec(
                          e,
                        ).groups;
                        n ??= "";
                        let a = (t.getCurrentModX() || r.includes("x")) && !n.includes("x"),
                          o = E(r),
                          i = E(n),
                          s = {};
                        if ((o && (s.enable = o), i && (s.disable = i), e.endsWith(")")))
                          return (t.replaceCurrentModX(a), b("flags", e, { flags: s }));
                        if (e.endsWith(":"))
                          return (
                            t.pushModX(a),
                            t.numOpenGroups++,
                            C("group", e, { ...((o || i) && { flags: s }) })
                          );
                        throw Error(`Unexpected flag modifier "${e}"`);
                      })(r, e),
                    };
                  }
                  if (
                    (e.pushModX(e.getCurrentModX()),
                    e.numOpenGroups++,
                    ("(" === r && !e.captureGroup) || "(?:" === r)
                  ) {
                    return { token: C("group", r) };
                  }
                  if ("(?>" === r) {
                    return { token: C("atomic", r) };
                  }
                  if ("(?=" === r || "(?!" === r || "(?<=" === r || "(?<!" === r) {
                    return {
                      token: C("<" === r[2] ? "lookbehind" : "lookahead", r, {
                        negate: r.endsWith("!"),
                      }),
                    };
                  }
                  if (
                    ("(" === r && e.captureGroup) ||
                    (r.startsWith("(?<") && r.endsWith(">")) ||
                    (r.startsWith("(?'") && r.endsWith("'"))
                  ) {
                    return {
                      token: C("capturing", r, { ...("(" !== r && { name: r.slice(3, -1) }) }),
                    };
                  }
                  if (r.startsWith("(?~")) {
                    if ("(?~|" === r) {
                      throw Error(`Unsupported absence function kind "${r}"`);
                    }
                    return { token: C("absence_repeater", r) };
                  }
                  throw "(?(" === r
                    ? Error(`Unsupported conditional "${r}"`)
                    : Error(`Invalid or unsupported group option "${r}"`);
                }
                if (")" === r) {
                  if ((e.popModX(), e.numOpenGroups--, e.numOpenGroups < 0)) {
                    throw Error('Unmatched ")"');
                  }
                  return { token: { type: "GroupClose", raw: r } };
                }
                if (e.getCurrentModX()) {
                  if ("#" === r) {
                    let e = t.indexOf(
                      `
`,
                      i,
                    );
                    return { lastIndex: -1 === e ? t.length : e };
                  }
                  if (/^\s$/.test(r)) {
                    let e = /\s+/y;
                    return ((e.lastIndex = i), { lastIndex: e.exec(t) ? e.lastIndex : i });
                  }
                }
                return "." === r
                  ? { token: m("dot", r) }
                  : "^" === r || "$" === r
                    ? { token: f(e.singleline ? { "^": o`\A`, $: o`\Z` }[r] : r, r) }
                    : "|" === r
                      ? { token: { type: "Alternator", raw: r } }
                      : u.test(r)
                        ? {
                            tokens: (function (e) {
                              let t,
                                r = [],
                                n = RegExp(u, "gy");
                              for (; (t = n.exec(e)); ) {
                                let e = t[0];
                                if ("{" === e[0]) {
                                  let t = /^\{(?<min>\d+),(?<max>\d+)\}\??$/.exec(e);
                                  if (t) {
                                    let { min: a, max: o } = t.groups;
                                    if (+a > +o && e.endsWith("?")) {
                                      (n.lastIndex--, r.push(k(e.slice(0, -1))));
                                      continue;
                                    }
                                  }
                                }
                                r.push(k(e));
                              }
                              return r;
                            })(r),
                          }
                        : { token: h(n(r), r) };
              })(l, e, $[0], p.lastIndex);
              (t.tokens ? x.push(...t.tokens) : t.token && x.push(t.token),
                void 0 !== t.lastIndex && (p.lastIndex = t.lastIndex));
            }
            let A = [],
              I = 0;
            (x
              .filter((e) => "GroupOpen" === e.type)
              .forEach((e) => {
                "capturing" === e.kind ? (e.number = ++I) : "(" === e.raw && A.push(e);
              }),
              I ||
                A.forEach((e, t) => {
                  ((e.kind = "capturing"), (e.number = t + 1));
                }));
            let v = I || A.length;
            return {
              tokens: x.flatMap((e) =>
                "EscapedNumber" === e.type
                  ? (function (e, t) {
                      let { raw: r, inCharClass: a } = e,
                        i = r.slice(1);
                      if (!a && (("0" !== i && 1 === i.length) || ("0" !== i[0] && +i <= t)))
                        return [g(r)];
                      let s = [],
                        l = i.match(/^[0-7]+|\d/g);
                      for (let e = 0; e < l.length; e++) {
                        let t,
                          a = l[e];
                        if (0 === e && "8" !== a && "9" !== a) {
                          if ((t = parseInt(a, 8)) > 127)
                            throw Error(o`Octal encoded byte above 177 unsupported "${r}"`);
                        } else t = n(a);
                        s.push(h(t, (0 === e ? "\\" : "") + a));
                      }
                      return s;
                    })(e, v)
                  : e,
              ),
              flags: i,
            };
          })(e, {
            flags: s.flags,
            rules: { captureGroup: s.rules.captureGroup, singleline: s.rules.singleline },
          }),
          x = (e, t) => {
            let r = l.tokens[$.nextIndex];
            switch ((($.parent = e), $.nextIndex++, r.type)) {
              case "Alternator":
                return v();
              case "Assertion":
                return (function ({ kind: e }) {
                  return _(
                    i(
                      {
                        "^": "line_start",
                        $: "line_end",
                        "\\A": "string_start",
                        "\\b": "word_boundary",
                        "\\B": "word_boundary",
                        "\\G": "search_start",
                        "\\y": "text_segment_boundary",
                        "\\Y": "text_segment_boundary",
                        "\\z": "string_end",
                        "\\Z": "string_end_newline",
                      }[e],
                      `Unexpected assertion kind "${e}"`,
                    ),
                    { negate: e === o`\B` || e === o`\Y` },
                  );
                })(r);
              case "Backreference":
                return (function ({ raw: e }, t) {
                  let r = /^\\k[<']/.test(e),
                    n = r ? e.slice(3, -1) : e.slice(1),
                    a = (r, n = !1) => {
                      let a = t.capturingGroups.length,
                        o = !1;
                      if (r > a) {
                        if (t.skipBackrefValidation) o = !0;
                        else throw Error(`Not enough capturing groups defined to the left "${e}"`);
                      }
                      return ((t.hasNumberedRef = !0), S(n ? a + 1 - r : r, { orphan: o }));
                    };
                  if (r) {
                    let r = /^(?<sign>-?)0*(?<num>[1-9]\d*)$/.exec(n);
                    if (r) {
                      return a(+r.groups.num, !!r.groups.sign);
                    }
                    if (/[-+]/.test(n)) {
                      throw Error(`Invalid backref name "${e}"`);
                    }
                    if (!t.namedGroupsByName.has(n)) {
                      throw Error(`Group name not defined to the left "${e}"`);
                    }
                    return S(n);
                  }
                  return a(+n);
                })(r, $);
              case "Character":
                return N(r.value, { useLastValid: !!t.isCheckingRangeEnd });
              case "CharacterClassHyphen":
                return (function (e, t, r) {
                  let { tokens: a, walk: o } = t,
                    i = t.parent,
                    s = i.body.at(-1),
                    l = a[t.nextIndex];
                  if (
                    !r.isCheckingRangeEnd &&
                    s &&
                    "CharacterClass" !== s.type &&
                    "CharacterClassRange" !== s.type &&
                    l &&
                    "CharacterClassOpen" !== l.type &&
                    "CharacterClassClose" !== l.type &&
                    "CharacterClassIntersector" !== l.type
                  ) {
                    let e = o(i, { ...r, isCheckingRangeEnd: !0 });
                    if ("Character" === s.type && "Character" === e.type) {
                      return (
                        i.body.pop(),
                        (function (e, t) {
                          if (t.value < e.value) throw Error("Character class range out of order");
                          return { type: "CharacterClassRange", min: e, max: t };
                        })(s, e)
                      );
                    }
                    throw Error("Invalid character class range");
                  }
                  return N(n("-"));
                })(0, $, t);
              case "CharacterClassOpen":
                return (function ({ negate: e }, t, r) {
                  let { tokens: n, walk: a } = t,
                    o = n[t.nextIndex],
                    i = [L()],
                    s = V(o);
                  for (; "CharacterClassClose" !== s.type; ) {
                    if ("CharacterClassIntersector" === s.type) {
                      (i.push(L()), t.nextIndex++);
                    } else {
                      let e = i.at(-1);
                      e.body.push(a(e, r));
                    }
                    s = V(n[t.nextIndex], o);
                  }
                  let l = L({ negate: e });
                  return (
                    1 === i.length
                      ? (l.body = i[0].body)
                      : ((l.kind = "intersection"),
                        (l.body = i.map((e) => (1 === e.body.length ? e.body[0] : e)))),
                    t.nextIndex++,
                    l
                  );
                })(r, $, t);
              case "CharacterSet":
                return (function ({ kind: e, negate: t, value: r }, n) {
                  let {
                    normalizeUnknownPropertyNames: o,
                    skipPropertyNameValidation: i,
                    unicodePropertyMap: s,
                  } = n;
                  if ("property" === e) {
                    let n = z(r);
                    if (!a.has(n) || s?.has(n)) {
                      return D(r, {
                        negate: t,
                        normalizeUnknownPropertyNames: o,
                        skipPropertyNameValidation: i,
                        unicodePropertyMap: s,
                      });
                    }
                    ((e = "posix"), (r = n));
                  }
                  return "posix" === e
                    ? (function (e, t) {
                        let r = !!t?.negate;
                        if (!a.has(e)) {
                          throw Error(`Invalid POSIX class "${e}"`);
                        }
                        return { type: "CharacterSet", kind: "posix", value: e, negate: r };
                      })(r, { negate: t })
                    : F(e, { negate: t });
                })(r, $);
              case "Directive":
                return (function (e, t = {}) {
                  if ("keep" === e) {
                    return { type: "Directive", kind: e };
                  }
                  if ("flags" === e) {
                    return { type: "Directive", kind: e, flags: i(t.flags) };
                  }
                  throw Error(`Unexpected directive kind "${e}"`);
                })(r.kind, { flags: r.flags });
              case "GroupOpen":
                return (function (e, t, r) {
                  var n, a;
                  let {
                      tokens: o,
                      capturingGroups: i,
                      namedGroupsByName: s,
                      skipLookbehindValidation: l,
                      walk: u,
                    } = t,
                    p = (function ({ flags: e, kind: t, name: r, negate: n, number: a }) {
                      switch (t) {
                        case "absence_repeater":
                          var o = "repeater";
                          !1;
                          return { type: "AbsenceFunction", kind: o, body: B(void 0) };
                        case "atomic":
                          return P({ atomic: !0 });
                        case "capturing":
                          return M(a, { name: r });
                        case "group":
                          return P({ flags: e });
                        case "lookahead":
                        case "lookbehind":
                          return U({ behind: "lookbehind" === t, negate: n });
                        default:
                          throw Error(`Unexpected group kind "${t}"`);
                      }
                    })(e),
                    c = "AbsenceFunction" === p.type,
                    d = W(p),
                    f = d && p.negate;
                  if (
                    ("CapturingGroup" === p.type &&
                      (i.push(p),
                      p.name &&
                        ((n = p.name), (a = []), s.has(n) || s.set(n, a), s.get(n)).push(p)),
                    c && r.isInAbsenceFunction)
                  ) {
                    throw Error("Nested absence function not supported by Oniguruma");
                  }
                  let g = j(o[t.nextIndex]);
                  for (; "GroupClose" !== g.type; ) {
                    if ("Alternator" === g.type) {
                      (p.body.push(v()), t.nextIndex++);
                    } else {
                      let e = p.body.at(-1),
                        t = u(e, {
                          ...r,
                          isInAbsenceFunction: r.isInAbsenceFunction || c,
                          isInLookbehind: r.isInLookbehind || d,
                          isInNegLookbehind: r.isInNegLookbehind || f,
                        });
                      if ((e.body.push(t), (d || r.isInLookbehind) && !l)) {
                        let e = "Lookbehind includes a pattern not allowed by Oniguruma";
                        if (f || r.isInNegLookbehind) {
                          if (T(t) || "CapturingGroup" === t.type) {
                            throw Error(e);
                          }
                        } else if (T(t) || (W(t) && t.negate)) {
                          throw Error(e);
                        }
                      }
                    }
                    g = j(o[t.nextIndex]);
                  }
                  return (t.nextIndex++, p);
                })(r, $, t);
              case "NamedCallout":
                var s, u;
                return (
                  (s = r.kind),
                  (u = r.tag),
                  { type: "NamedCallout", kind: s, tag: u, arguments: r.arguments }
                );
              case "Quantifier":
                return (function ({ kind: e, min: t, max: r }, n) {
                  let a = n.parent,
                    o = a.body.at(-1);
                  if (!o || !A.has(o.type)) {
                    throw Error("Quantifier requires a repeatable token");
                  }
                  let i = R(e, t, r, o);
                  return (a.body.pop(), i);
                })(r, $);
              case "Subroutine":
                return (function ({ raw: e }, t) {
                  let { capturingGroups: r, subroutines: n } = t,
                    a = e.slice(3, -1),
                    o = /^(?<sign>[-+]?)0*(?<num>[1-9]\d*)$/.exec(a);
                  if (o) {
                    let e = +o.groups.num,
                      n = r.length;
                    if (
                      ((t.hasNumberedRef = !0),
                      (a = { "": e, "+": n + e, "-": n + 1 - e }[o.groups.sign]) < 1)
                    ) {
                      throw Error("Invalid subroutine number");
                    }
                  } else {
                    "0" === a && (a = 0);
                  }
                  let i = G(a);
                  return (n.push(i), i);
                })(r, $);
              default:
                throw Error(`Unexpected token type "${r.type}"`);
            }
          },
          $ = {
            capturingGroups: [],
            hasNumberedRef: !1,
            namedGroupsByName: new Map(),
            nextIndex: 0,
            normalizeUnknownPropertyNames: s.normalizeUnknownPropertyNames,
            parent: null,
            skipBackrefValidation: s.skipBackrefValidation,
            skipLookbehindValidation: s.skipLookbehindValidation,
            skipPropertyNameValidation: s.skipPropertyNameValidation,
            subroutines: [],
            tokens: l.tokens,
            unicodePropertyMap: s.unicodePropertyMap,
            walk: x,
          },
          O = ((r = { type: "Flags", ...l.flags }), { type: "Regex", body: B(void 0), flags: r }),
          H = O.body[0];
        for (; $.nextIndex < l.tokens.length; ) {
          let e = x(H, {});
          "Alternative" === e.type ? (O.body.push(e), (H = e)) : H.body.push(e);
        }
        let { capturingGroups: X, hasNumberedRef: Z, namedGroupsByName: Q, subroutines: q } = $;
        if (Z && Q.size && !s.rules.captureGroup) {
          throw Error("Numbered backref/subroutine not allowed when using named capture");
        }
        for (let { ref: e } of q) {
          if ("number" == typeof e) {
            if (e > X.length) throw Error("Subroutine uses a group number that's not defined");
            e && (X[e - 1].isSubroutined = !0);
          } else if (Q.has(e)) {
            if (Q.get(e).length > 1)
              throw Error(o`Subroutine uses a duplicate group name "\g<${e}>"`);
            Q.get(e)[0].isSubroutined = !0;
          } else throw Error(o`Subroutine uses a group name that's not defined "\g<${e}>"`);
        }
        return O;
      }
      function v(e) {
        return { type: "Alternative", body: O(e?.body) };
      }
      function _(e, t) {
        let r = { type: "Assertion", kind: e };
        return (
          ("word_boundary" === e || "text_segment_boundary" === e) && (r.negate = !!t?.negate), r
        );
      }
      function S(e, t) {
        let r = !!t?.orphan;
        return { type: "Backreference", ref: e, ...(r && { orphan: r }) };
      }
      function M(e, t) {
        var r;
        let n = { name: void 0, isSubroutined: !1, ...t };
        if (void 0 !== n.name && ((r = n.name), !/^[\p{Alpha}\p{Pc}][^)]*$/u.test(r))) {
          throw Error(`Group name "${n.name}" invalid in Oniguruma`);
        }
        return {
          type: "CapturingGroup",
          number: e,
          ...(n.name && { name: n.name }),
          ...(n.isSubroutined && { isSubroutined: n.isSubroutined }),
          body: B(t?.body),
        };
      }
      function N(e, t) {
        let r = { useLastValid: !1, ...t };
        if (e > 1114111) {
          let t = e.toString(16);
          if (r.useLastValid) {
            e = 1114111;
          } else {
            throw e > 1310719
              ? Error(`Invalid code point out of range "\\x{${t}}"`)
              : Error(`Invalid code point out of range in JS "\\x{${t}}"`);
          }
        }
        return { type: "Character", value: e };
      }
      function L(e) {
        let t = { kind: "union", negate: !1, ...e };
        return { type: "CharacterClass", kind: t.kind, negate: t.negate, body: O(e?.body) };
      }
      function F(e, t) {
        let r = !!t?.negate,
          n = { type: "CharacterSet", kind: e };
        return (
          ("digit" === e || "hex" === e || "newline" === e || "space" === e || "word" === e) &&
            (n.negate = r),
          ("text_segment" !== e && ("newline" !== e || r)) || (n.variableLength = !0),
          n
        );
      }
      function P(e) {
        let t = e?.atomic,
          r = e?.flags;
        if (t && r) {
          throw Error("Atomic group cannot have flags");
        }
        return { type: "Group", ...(t && { atomic: t }), ...(r && { flags: r }), body: B(e?.body) };
      }
      function U(e) {
        let t = { behind: !1, negate: !1, ...e };
        return {
          type: "LookaroundAssertion",
          kind: t.behind ? "lookbehind" : "lookahead",
          negate: t.negate,
          body: B(e?.body),
        };
      }
      function R(e, t, r, n) {
        if (t > r) {
          throw Error("Invalid reversed quantifier range");
        }
        return { type: "Quantifier", kind: e, min: t, max: r, body: n };
      }
      function G(e) {
        return { type: "Subroutine", ref: e };
      }
      function D(e, t) {
        let r = {
            negate: !1,
            normalizeUnknownPropertyNames: !1,
            skipPropertyNameValidation: !1,
            unicodePropertyMap: null,
            ...t,
          },
          n = r.unicodePropertyMap?.get(z(e));
        if (!n) {
          if (r.normalizeUnknownPropertyNames) {
            n = e
              .trim()
              .replace(/[- _]+/g, "_")
              .replace(/[A-Z][a-z]+(?=[A-Z])/g, "$&_")
              .replace(/[A-Za-z]+/g, (e) => e[0].toUpperCase() + e.slice(1).toLowerCase());
          } else if (r.unicodePropertyMap && !r.skipPropertyNameValidation) {
            throw Error(o`Invalid Unicode property "\p{${e}}"`);
          }
        }
        return { type: "CharacterSet", kind: "property", value: n ?? e, negate: r.negate };
      }
      function B(e) {
        if (void 0 === e) {
          e = [v()];
        } else if (!Array.isArray(e) || !e.length || !e.every((e) => "Alternative" === e.type)) {
          throw Error("Invalid body; expected array of one or more Alternative nodes");
        }
        return e;
      }
      function O(e) {
        if (void 0 === e) {
          e = [];
        } else if (!Array.isArray(e) || !e.every((e) => !!e.type)) {
          throw Error("Invalid body; expected array of nodes");
        }
        return e;
      }
      function T(e) {
        return "LookaroundAssertion" === e.type && "lookahead" === e.kind;
      }
      function W(e) {
        return "LookaroundAssertion" === e.type && "lookbehind" === e.kind;
      }
      function z(e) {
        return e.replace(/[- _]+/g, "").toLowerCase();
      }
      function V(e, t) {
        return i(
          e,
          `${t?.type === "Character" && 93 === t.value ? "Empty" : "Unclosed"} character class`,
        );
      }
      function j(e) {
        return i(e, "Unclosed group");
      }
      function H(e, t, r = null) {
        function n(e, t) {
          for (let r = 0; r < e.length; r++) {
            let n = a(e[r], t, r, e);
            r = Math.max(-1, r + n);
          }
        }
        function a(o, s = null, l = null, u = null) {
          let p = 0,
            c = !1,
            d = {
              node: o,
              parent: s,
              key: l,
              container: u,
              root: e,
              remove() {
                (X(u).splice(Math.max(0, Z(l) + p), 1), p--, (c = !0));
              },
              removeAllNextSiblings: () => X(u).splice(Z(l) + 1),
              removeAllPrevSiblings() {
                let e = Z(l) + p;
                return ((p -= e), X(u).splice(0, Math.max(0, e)));
              },
              replaceWith(e, t = {}) {
                let r = !!t.traverse;
                (u ? (u[Math.max(0, Z(l) + p)] = e) : (i(s, "Can't replace root node")[l] = e),
                  r && a(e, s, l, u),
                  (c = !0));
              },
              replaceWithMultiple(e, t = {}) {
                let r = !!t.traverse;
                if ((X(u).splice(Math.max(0, Z(l) + p), 1, ...e), (p += e.length - 1), r)) {
                  let t = 0;
                  for (let r = 0; r < e.length; r++) {
                    t += a(e[r], s, Z(l) + r + t, u);
                  }
                }
                c = !0;
              },
              skip() {
                c = !0;
              },
            },
            { type: f } = o,
            g = t["*"],
            h = t[f],
            y = "function" == typeof g ? g : g?.enter,
            m = "function" == typeof h ? h : h?.enter;
          if ((y?.(d, r), m?.(d, r), !c)) {
            switch (f) {
              case "AbsenceFunction":
              case "CapturingGroup":
              case "Group":
              case "Alternative":
              case "CharacterClass":
              case "LookaroundAssertion":
                n(o.body, o);
                break;
              case "Assertion":
              case "Backreference":
              case "Character":
              case "CharacterSet":
              case "Directive":
              case "Flags":
              case "NamedCallout":
              case "Subroutine":
                break;
              case "CharacterClassRange":
                (a(o.min, o, "min"), a(o.max, o, "max"));
                break;
              case "Quantifier":
                a(o.body, o, "body");
                break;
              case "Regex":
                (n(o.body, o), a(o.flags, o, "flags"));
                break;
              default:
                throw Error(`Unexpected node type "${f}"`);
            }
          }
          return (h?.exit?.(d, r), g?.exit?.(d, r), p);
        }
        return (a(e), e);
      }
      function X(e) {
        if (!Array.isArray(e)) {
          throw Error("Container expected");
        }
        return e;
      }
      function Z(e) {
        if ("number" != typeof e) {
          throw Error("Numeric key expected");
        }
        return e;
      }
      let Q = String.raw`\(\?(?:[:=!>A-Za-z\-]|<[=!]|\(DEFINE\))`,
        q = Object.freeze({ DEFAULT: "DEFAULT", CHAR_CLASS: "CHAR_CLASS" });
      function K(e, t, r, n) {
        let a = RegExp(String.raw`${t}|(?<$skip>\[\^?|\\?.)`, "gsu"),
          o = [!1],
          i = 0,
          s = "";
        for (let t of e.matchAll(a)) {
          let {
            0: e,
            groups: { $skip: a },
          } = t;
          if (!a && (!n || (n === q.DEFAULT) == !i)) {
            r instanceof Function
              ? (s += r(t, { context: i ? q.CHAR_CLASS : q.DEFAULT, negated: o[o.length - 1] }))
              : (s += r);
            continue;
          }
          ("[" === e[0] ? (i++, o.push("^" === e[1])) : "]" === e && i && (i--, o.pop()), (s += e));
        }
        return s;
      }
      function J(e, t, r) {
        return !!(function (e, t, r = 0, n) {
          let a;
          if (!RegExp(t, "su").test(e)) {
            return null;
          }
          let o = RegExp(`${t}|(?<$skip>\\\\?.)`, "gsu");
          o.lastIndex = r;
          let i = 0;
          for (; (a = o.exec(e)); ) {
            let {
              0: e,
              groups: { $skip: t },
            } = a;
            if (!t && (!n || (n === q.DEFAULT) == !i)) {
              return a;
            }
            ("[" === e ? i++ : "]" === e && i && i--, o.lastIndex == a.index && o.lastIndex++);
          }
          return null;
        })(e, t, 0, r);
      }
      let Y = RegExp(
          String.raw`(?<noncapturingStart>${Q})|(?<capturingStart>\((?:\?<[^>]+>)?)|\\?.`,
          "gsu",
        ),
        ee = String.raw`(?:[?*+]|\{\d+(?:,\d*)?\})`,
        et = RegExp(
          String.raw`
\\(?: \d+
  | c[A-Za-z]
  | [gk]<[^>]+>
  | [pPu]\{[^\}]+\}
  | u[A-Fa-f\d]{4}
  | x[A-Fa-f\d]{2}
  )
| \((?: \? (?: [:=!>]
  | <(?:[=!]|[^>]+>)
  | [A-Za-z\-]+:
  | \(DEFINE\)
  ))?
| (?<qBase>${ee})(?<qMod>[?+]?)(?<invalidQ>[?*+\{]?)
| \\?.
`.replace(/\s+/g, ""),
          "gsu",
        ),
        er = String.raw,
        en = er`\\g<(?<gRNameOrNum>[^>&]+)&R=(?<gRDepth>[^>]+)>`,
        ea = er`\(\?R=(?<rDepth>[^\)]+)\)|${en}`,
        eo = er`\(\?<(?![=!])(?<captureName>[^>]+)>`,
        ei = er`${eo}|(?<unnamed>\()(?!\?)`,
        es = RegExp(er`${eo}|${ea}|\(\?|\\?.`, "gsu"),
        el = "Cannot use multiple overlapping recursions";
      function eu(e) {
        let t = `Max depth must be integer between 2 and 100; used ${e}`;
        if (!/^[1-9]\d*$/.test(e) || (e *= 1) < 2 || e > 100) {
          throw Error(t);
        }
      }
      function ep(e, t, r, n, a, o, i) {
        let s = new Set();
        n &&
          K(
            e + t,
            eo,
            ({ groups: { captureName: e } }) => {
              s.add(e);
            },
            q.DEFAULT,
          );
        let l = [r, n ? s : null, a, o, i];
        return `${e}${ec(`(?:${e}`, "forward", ...l)}(?:)${ec(`${t})`, "backward", ...l)}${t}`;
      }
      function ec(e, t, r, n, a, o, i) {
        let s = (e) => ("forward" === t ? e + 2 : r - e + 2 - 1),
          l = "";
        for (let t = 0; t < r; t++) {
          let r = s(t);
          l += K(
            e,
            er`${ei}|\\k<(?<backref>[^>]+)>`,
            ({ 0: e, groups: { captureName: t, unnamed: s, backref: l } }) => {
              if (l && n && !n.has(l)) {
                return e;
              }
              let u = `_$${r}`;
              if (s || t) {
                let r = i + o.length + 1;
                return (
                  o.push(r),
                  (function (e, t) {
                    for (let r = 0; r < e.length; r++) {
                      e[r] >= t && e[r]++;
                    }
                  })(a, r),
                  s ? e : `(?<${t}${u}>`
                );
              }
              return er`\k<${l}${u}>`;
            },
            q.DEFAULT,
          );
        }
        return l;
      }
      function ed(e, t, r, n, a, o) {
        if (e.size && n) {
          let i = 0;
          K(t, ei, () => i++, q.DEFAULT);
          let s = o - i + a,
            l = new Map();
          return (
            e.forEach((e, t) => {
              let a = (n - i * r) / r,
                o = i * r,
                u = t > s + i ? t + n : t,
                p = [];
              for (let t of e) {
                if (t <= s) p.push(t);
                else if (t > s + i + a) p.push(t + n);
                else if (t <= s + i) for (let e = 0; e <= r; e++) p.push(t + i * e);
                else for (let e = 0; e <= r; e++) p.push(t + o + a * e);
              }
              l.set(u, p);
            }),
            l
          );
        }
        return e;
      }
      var ef = String.fromCodePoint,
        eg = String.raw,
        eh = {
          flagGroups: (() => {
            try {
              RegExp("(?i:)");
            } catch {
              return !1;
            }
            return !0;
          })(),
          unicodeSets: (() => {
            try {
              RegExp("[[]]", "v");
            } catch {
              return !1;
            }
            return !0;
          })(),
        };
      function ey(e, { enable: t, disable: r }) {
        return {
          dotAll: !r?.dotAll && !!(t?.dotAll || e.dotAll),
          ignoreCase: !r?.ignoreCase && !!(t?.ignoreCase || e.ignoreCase),
        };
      }
      function em(e, t, r) {
        return (e.has(t) || e.set(t, r), e.get(t));
      }
      ((eh.bugFlagVLiteralHyphenIsRange =
        !!eh.unicodeSets &&
        (() => {
          try {
            RegExp(eg`[\d\-a]`, "v");
          } catch {
            return !0;
          }
          return !1;
        })()),
        (eh.bugNestedClassIgnoresNegation = eh.unicodeSets && RegExp("[[^a]]", "v").test("a")));
      var eb = { ES2025: 2025, ES2024: 2024, ES2018: 2018 },
        eC = { auto: "auto", ES2025: "ES2025", ES2024: "ES2024", ES2018: "ES2018" };
      function ew(e = {}) {
        if ("[object Object]" !== {}.toString.call(e)) {
          throw Error("Unexpected options");
        }
        if (void 0 !== e.target && !eC[e.target]) {
          throw Error(`Unexpected target "${e.target}"`);
        }
        let t = {
          accuracy: "default",
          avoidSubclass: !1,
          flags: "",
          global: !1,
          hasIndices: !1,
          lazyCompileLength: 1 / 0,
          target: "auto",
          verbose: !1,
          ...e,
          rules: {
            allowOrphanBackrefs: !1,
            asciiWordBoundaries: !1,
            captureGroup: !1,
            recursionLimit: 20,
            singleline: !1,
            ...e.rules,
          },
        };
        return (
          "auto" === t.target &&
            (t.target = eh.flagGroups ? "ES2025" : eh.unicodeSets ? "ES2024" : "ES2018"),
          t
        );
      }
      var ex = new Set([ef(304), ef(305)]),
        ek = eg`[\p{L}\p{M}\p{N}\p{Pc}]`;
      function eE(e) {
        if (ex.has(e)) {
          return [e];
        }
        let t = new Set(),
          r = e.toLowerCase(),
          n = r.toUpperCase(),
          a = ev.get(r),
          o = eA.get(r),
          i = eI.get(r);
        return (
          1 == [...n].length && t.add(n),
          i && t.add(i),
          a && t.add(a),
          t.add(r),
          o && t.add(o),
          [...t]
        );
      }
      var e$ = new Map(
          `C Other
Cc Control cntrl
Cf Format
Cn Unassigned
Co Private_Use
Cs Surrogate
L Letter
LC Cased_Letter
Ll Lowercase_Letter
Lm Modifier_Letter
Lo Other_Letter
Lt Titlecase_Letter
Lu Uppercase_Letter
M Mark Combining_Mark
Mc Spacing_Mark
Me Enclosing_Mark
Mn Nonspacing_Mark
N Number
Nd Decimal_Number digit
Nl Letter_Number
No Other_Number
P Punctuation punct
Pc Connector_Punctuation
Pd Dash_Punctuation
Pe Close_Punctuation
Pf Final_Punctuation
Pi Initial_Punctuation
Po Other_Punctuation
Ps Open_Punctuation
S Symbol
Sc Currency_Symbol
Sk Modifier_Symbol
Sm Math_Symbol
So Other_Symbol
Z Separator
Zl Line_Separator
Zp Paragraph_Separator
Zs Space_Separator
ASCII
ASCII_Hex_Digit AHex
Alphabetic Alpha
Any
Assigned
Bidi_Control Bidi_C
Bidi_Mirrored Bidi_M
Case_Ignorable CI
Cased
Changes_When_Casefolded CWCF
Changes_When_Casemapped CWCM
Changes_When_Lowercased CWL
Changes_When_NFKC_Casefolded CWKCF
Changes_When_Titlecased CWT
Changes_When_Uppercased CWU
Dash
Default_Ignorable_Code_Point DI
Deprecated Dep
Diacritic Dia
Emoji
Emoji_Component EComp
Emoji_Modifier EMod
Emoji_Modifier_Base EBase
Emoji_Presentation EPres
Extended_Pictographic ExtPict
Extender Ext
Grapheme_Base Gr_Base
Grapheme_Extend Gr_Ext
Hex_Digit Hex
IDS_Binary_Operator IDSB
IDS_Trinary_Operator IDST
ID_Continue IDC
ID_Start IDS
Ideographic Ideo
Join_Control Join_C
Logical_Order_Exception LOE
Lowercase Lower
Math
Noncharacter_Code_Point NChar
Pattern_Syntax Pat_Syn
Pattern_White_Space Pat_WS
Quotation_Mark QMark
Radical
Regional_Indicator RI
Sentence_Terminal STerm
Soft_Dotted SD
Terminal_Punctuation Term
Unified_Ideograph UIdeo
Uppercase Upper
Variation_Selector VS
White_Space space
XID_Continue XIDC
XID_Start XIDS`
            .split(/\s/)
            .map((e) => [z(e), e]),
        ),
        eA = new Map([
          ["s", ef(383)],
          [ef(383), "s"],
        ]),
        eI = new Map([
          [ef(223), ef(7838)],
          [ef(107), ef(8490)],
          [ef(229), ef(8491)],
          [ef(969), ef(8486)],
        ]),
        ev = new Map([
          eS(453),
          eS(456),
          eS(459),
          eS(498),
          ...eM(8072, 8079),
          ...eM(8088, 8095),
          ...eM(8104, 8111),
          eS(8124),
          eS(8140),
          eS(8188),
        ]),
        e_ = new Map([
          ["alnum", eg`[\p{Alpha}\p{Nd}]`],
          ["alpha", eg`\p{Alpha}`],
          ["ascii", eg`\p{ASCII}`],
          ["blank", eg`[\p{Zs}\t]`],
          ["cntrl", eg`\p{Cc}`],
          ["digit", eg`\p{Nd}`],
          ["graph", eg`[\P{space}&&\P{Cc}&&\P{Cn}&&\P{Cs}]`],
          ["lower", eg`\p{Lower}`],
          ["print", eg`[[\P{space}&&\P{Cc}&&\P{Cn}&&\P{Cs}]\p{Zs}]`],
          ["punct", eg`[\p{P}\p{S}]`],
          ["space", eg`\p{space}`],
          ["upper", eg`\p{Upper}`],
          ["word", eg`[\p{Alpha}\p{M}\p{Nd}\p{Pc}]`],
          ["xdigit", eg`\p{AHex}`],
        ]);
      function eS(e) {
        let t = ef(e);
        return [t.toLowerCase(), t];
      }
      function eM(e, t) {
        return (function (e, t) {
          let r = [];
          for (let n = e; n <= t; n++) {
            r.push(n);
          }
          return r;
        })(e, t).map((e) => eS(e));
      }
      var eN = new Set([
          "Lower",
          "Lowercase",
          "Upper",
          "Uppercase",
          "Ll",
          "Lowercase_Letter",
          "Lt",
          "Titlecase_Letter",
          "Lu",
          "Uppercase_Letter",
        ]),
        eL = {
          AbsenceFunction({ node: e, parent: t, replaceWith: r }) {
            let { body: n, kind: a } = e;
            if ("repeater" === a) {
              let e = P();
              e.body[0].body.push(U({ negate: !0, body: n }), D("Any"));
              let a = P();
              (a.body[0].body.push(R("greedy", 0, 1 / 0, e)), r(eV(a, t), { traverse: !0 }));
            } else {
              throw Error('Unsupported absence function "(?~|"');
            }
          },
          Alternative: {
            enter({ node: e, parent: t, key: r }, { flagDirectivesByAlt: n }) {
              let a = e.body.filter((e) => "flags" === e.kind);
              for (let e = r + 1; e < t.body.length; e++) {
                em(n, t.body[e], []).push(...a);
              }
            },
            exit({ node: e }, { flagDirectivesByAlt: t }) {
              if (t.get(e)?.length) {
                let r = eD(t.get(e));
                if (r) {
                  let t = P({ flags: r });
                  ((t.body[0].body = e.body), (e.body = [eV(t, e)]));
                }
              }
            },
          },
          Assertion(
            { node: e, parent: t, key: r, container: n, root: a, remove: o, replaceWith: i },
            s,
          ) {
            let { kind: l, negate: u } = e,
              { asciiWordBoundaries: p, avoidSubclass: c, supportedGNodes: d, wordIsAscii: f } = s;
            if ("text_segment_boundary" === l) {
              throw Error(`Unsupported text segment boundary "\\${u ? "Y" : "y"}"`);
            }
            if ("line_end" === l) {
              i(eV(U({ body: [v({ body: [_("string_end")] }), v({ body: [N(10)] })] }), t));
            } else if ("line_start" === l) {
              i(eV(eT(eg`(?<=\A|\n(?!\z))`, { skipLookbehindValidation: !0 }), t));
            } else if ("search_start" === l) {
              if (d.has(e)) ((a.flags.sticky = !0), o());
              else {
                let e = n[r - 1];
                if (
                  e &&
                  (function (e) {
                    let t = ["Character", "CharacterClass", "CharacterSet"];
                    return (
                      t.includes(e.type) ||
                      ("Quantifier" === e.type && e.min && t.includes(e.body.type))
                    );
                  })(e)
                )
                  i(eV(U({ negate: !0 }), t));
                else if (c) throw Error(eg`Uses "\G" in a way that requires a subclass`);
                else (i(ez(_("string_start"), t)), (s.strategy = "clip_search"));
              }
            } else if ("string_end" === l || "string_start" === l) {
            } else if ("string_end_newline" === l) {
              i(eV(eT(eg`(?=\n?\z)`), t));
            } else if ("word_boundary" === l) {
              if (!f && !p) {
                let e = `(?:(?<=${ek})(?!${ek})|(?<!${ek})(?=${ek}))`,
                  r = `(?:(?<=${ek})(?=${ek})|(?<!${ek})(?!${ek}))`;
                i(eV(eT(u ? r : e), t));
              }
            } else {
              throw Error(`Unexpected assertion kind "${l}"`);
            }
          },
          Backreference({ node: e }, { jsGroupNameMap: t }) {
            let { ref: r } = e;
            "string" != typeof r || eO(r) || (e.ref = r = eG(r, t));
          },
          CapturingGroup({ node: e }, { jsGroupNameMap: t, subroutineRefMap: r }) {
            let { name: n } = e;
            (n && !eO(n) && (e.name = n = eG(n, t)), r.set(e.number, e), n && r.set(n, e));
          },
          CharacterClassRange({ node: e, parent: t, replaceWith: r }) {
            "intersection" === t.kind && r(eV(L({ body: [e] }), t), { traverse: !0 });
          },
          CharacterSet(
            { node: e, parent: t, replaceWith: r },
            { accuracy: n, minTargetEs2024: a, digitIsAscii: o, spaceIsAscii: i, wordIsAscii: s },
          ) {
            let { kind: l, negate: u, value: p } = e;
            if (o && ("digit" === l || "digit" === p)) {
              return void r(ez(F("digit", { negate: u }), t));
            }
            if (i && ("space" === l || "space" === p)) {
              return void r(eV(eW(eT("[	-\r ]"), u), t));
            }
            if (s && ("word" === l || "word" === p)) {
              return void r(ez(F("word", { negate: u }), t));
            }
            if ("any" === l) {
              r(ez(D("Any"), t));
            } else if ("digit" === l) {
              r(ez(D("Nd", { negate: u }), t));
            } else if ("dot" === l) {
            } else if ("text_segment" === l) {
              if ("strict" === n) {
                throw Error(eg`Use of "\X" requires non-strict accuracy`);
              }
              let e = "\\p{Emoji}(?:\\p{EMod}|\\uFE0F\\u20E3?|[\\x{E0020}-\\x{E007E}]+\\x{E007F})?",
                o = eg`\p{RI}{2}|${e}(?:\u200D${e})*`;
              r(
                eV(
                  eT(eg`(?>\r\n|${a ? eg`\p{RGI_Emoji}` : o}|\P{M}\p{M}*)`, {
                    skipPropertyNameValidation: !0,
                  }),
                  t,
                ),
              );
            } else if ("hex" === l) {
              r(ez(D("AHex", { negate: u }), t));
            } else if ("newline" === l) {
              r(eV(eT(u ? "[^\n]" : "(?>\r\n?|[\n\v\f\x85\u2028\u2029])"), t));
            } else if ("posix" === l) {
              if (a || ("graph" !== p && "print" !== p)) r(eV(eW(eT(e_.get(p)), u), t));
              else {
                if ("strict" === n)
                  throw Error(
                    `POSIX class "${p}" requires min target ES2024 or non-strict accuracy`,
                  );
                let e = { graph: "!-~", print: " -~" }[p];
                (u && (e = `\0-${ef(e.codePointAt(0) - 1)}${ef(e.codePointAt(2) + 1)}-\u{10FFFF}`),
                  r(eV(eT(`[${e}]`), t)));
              }
            } else if ("property" === l) {
              e$.has(z(p)) || (e.key = "sc");
            } else if ("space" === l) {
              r(ez(D("space", { negate: u }), t));
            } else if ("word" === l) {
              r(eV(eW(eT(ek), u), t));
            } else {
              throw Error(`Unexpected character set kind "${l}"`);
            }
          },
          Directive({
            node: e,
            parent: t,
            root: r,
            remove: n,
            replaceWith: a,
            removeAllPrevSiblings: o,
            removeAllNextSiblings: i,
          }) {
            let { kind: s, flags: l } = e;
            if ("flags" === s) {
              if (l.enable || l.disable) {
                let e = P({ flags: l });
                ((e.body[0].body = i()), a(eV(e, t), { traverse: !0 }));
              } else n();
            } else if ("keep" === s) {
              let e = r.body[0],
                n =
                  1 === r.body.length && $(e, { type: "Group" }) && 1 === e.body[0].body.length
                    ? e.body[0]
                    : r;
              if (t.parent !== n || n.body.length > 1) {
                throw Error(eg`Uses "\K" in a way that's unsupported`);
              }
              let i = U({ behind: !0 });
              ((i.body[0].body = o()), a(eV(i, t)));
            } else {
              throw Error(`Unexpected directive kind "${s}"`);
            }
          },
          Flags({ node: e, parent: t }) {
            if (e.posixIsAscii) {
              throw Error('Unsupported flag "P"');
            }
            if ("word" === e.textSegmentMode) {
              throw Error('Unsupported flag "y{w}"');
            }
            ([
              "digitIsAscii",
              "extended",
              "posixIsAscii",
              "spaceIsAscii",
              "wordIsAscii",
              "textSegmentMode",
            ].forEach((t) => delete e[t]),
              Object.assign(e, {
                global: !1,
                hasIndices: !1,
                multiline: !1,
                sticky: e.sticky ?? !1,
              }),
              (t.options = { disable: { x: !0, n: !0 }, force: { v: !0 } }));
          },
          Group({ node: e }) {
            if (!e.flags) {
              return;
            }
            let { enable: t, disable: r } = e.flags;
            (t?.extended && delete t.extended,
              r?.extended && delete r.extended,
              t?.dotAll && r?.dotAll && delete t.dotAll,
              t?.ignoreCase && r?.ignoreCase && delete t.ignoreCase,
              t && !Object.keys(t).length && delete e.flags.enable,
              r && !Object.keys(r).length && delete e.flags.disable,
              e.flags.enable || e.flags.disable || delete e.flags);
          },
          LookaroundAssertion({ node: e }, t) {
            let { kind: r } = e;
            "lookbehind" === r && (t.passedLookbehind = !0);
          },
          NamedCallout({ node: e, parent: t, replaceWith: r }) {
            let { kind: n } = e;
            if ("fail" === n) {
              r(eV(U({ negate: !0 }), t));
            } else {
              throw Error(`Unsupported named callout "(*${n.toUpperCase()}"`);
            }
          },
          Quantifier({ node: e }) {
            if ("Quantifier" === e.body.type) {
              let t = P();
              (t.body[0].body.push(e.body), (e.body = eV(t, e)));
            }
          },
          Regex: {
            enter({ node: e }, { supportedGNodes: t }) {
              let r = [],
                n = !1,
                a = !1;
              for (let t of e.body) {
                if (1 === t.body.length && "search_start" === t.body[0].kind) t.body.pop();
                else {
                  let e = (function e(t) {
                    let r = t.find(
                      (e) =>
                        "search_start" === e.kind ||
                        (function (e, t) {
                          let r = { negate: null, ...t };
                          return (
                            "LookaroundAssertion" === e.type &&
                            (null === r.negate || e.negate === r.negate) &&
                            1 === e.body.length &&
                            $(e.body[0], { type: "Assertion", kind: "search_start" })
                          );
                        })(e, { negate: !1 }) ||
                        !(function ({ type: e }) {
                          return (
                            "Assertion" === e || "Directive" === e || "LookaroundAssertion" === e
                          );
                        })(e),
                    );
                    if (!r) return null;
                    if ("search_start" === r.kind) return r;
                    if ("LookaroundAssertion" === r.type) return r.body[0].body[0];
                    if ("CapturingGroup" === r.type || "Group" === r.type) {
                      let t = [];
                      for (let n of r.body) {
                        let r = e(n.body);
                        if (!r) return null;
                        Array.isArray(r) ? t.push(...r) : t.push(r);
                      }
                      return t;
                    }
                    return null;
                  })(t.body);
                  e ? ((n = !0), Array.isArray(e) ? r.push(...e) : r.push(e)) : (a = !0);
                }
              }
              n && !a && r.forEach((e) => t.add(e));
            },
            exit(e, { accuracy: t, passedLookbehind: r, strategy: n }) {
              if ("strict" === t && r && n) {
                throw Error(eg`Uses "\G" in a way that requires non-strict accuracy`);
              }
            },
          },
          Subroutine({ node: e }, { jsGroupNameMap: t }) {
            let { ref: r } = e;
            "string" != typeof r || eO(r) || (e.ref = r = eG(r, t));
          },
        },
        eF = {
          Backreference(
            { node: e },
            { multiplexCapturesToLeftByRef: t, reffedNodesByReferencer: r },
          ) {
            let { orphan: n, ref: a } = e;
            n ||
              r.set(
                e,
                t.get(a).map(({ node: e }) => e),
              );
          },
          CapturingGroup: {
            enter(
              { node: e, parent: t, replaceWith: r, skip: n },
              {
                groupOriginByCopy: a,
                groupsByName: o,
                multiplexCapturesToLeftByRef: i,
                openRefs: s,
                reffedNodesByReferencer: l,
              },
            ) {
              let u = a.get(e);
              if (u && s.has(e.number)) {
                let n = ez(eR(e.number), t);
                (l.set(n, s.get(e.number)), r(n));
                return;
              }
              (s.set(e.number, e), i.set(e.number, []), e.name && em(i, e.name, []));
              let p = i.get(e.name ?? e.number);
              for (let t = 0; t < p.length; t++) {
                let r = p[t];
                if (u === r.node || (u && u === r.origin) || e === r.origin) {
                  p.splice(t, 1);
                  break;
                }
              }
              if (
                (i.get(e.number).push({ node: e, origin: u }),
                e.name && i.get(e.name).push({ node: e, origin: u }),
                e.name)
              ) {
                let t = em(o, e.name, new Map()),
                  r = !1;
                if (u) {
                  r = !0;
                } else {
                  for (let e of t.values())
                    if (!e.hasDuplicateNameToRemove) {
                      r = !0;
                      break;
                    }
                }
                o.get(e.name).set(e, { node: e, hasDuplicateNameToRemove: r });
              }
            },
            exit({ node: e }, { openRefs: t }) {
              t.delete(e.number);
            },
          },
          Group: {
            enter({ node: e }, t) {
              ((t.prevFlags = t.currentFlags),
                e.flags && (t.currentFlags = ey(t.currentFlags, e.flags)));
            },
            exit(e, t) {
              t.currentFlags = t.prevFlags;
            },
          },
          Subroutine({ node: e, parent: t, replaceWith: r }, n) {
            let { isRecursive: a, ref: o } = e;
            if (a) {
              let r = t;
              for (
                ;
                (r = r.parent) && ("CapturingGroup" !== r.type || (r.name !== o && r.number !== o));
              ) {}
              n.reffedNodesByReferencer.set(e, r);
              return;
            }
            let i = n.subroutineRefMap.get(o),
              s = 0 === o,
              l = s
                ? eR(0)
                : (function e(t, r, n, a) {
                    let o = Array.isArray(t) ? [] : {};
                    for (let [i, s] of Object.entries(t)) {
                      "parent" === i
                        ? (o.parent = Array.isArray(n) ? a : n)
                        : s && "object" == typeof s
                          ? (o[i] = e(s, r, o, n))
                          : ("type" === i && "CapturingGroup" === s && r.set(o, r.get(t) ?? t),
                            (o[i] = s));
                    }
                    return o;
                  })(i, n.groupOriginByCopy, null),
              u = l;
            if (!s) {
              var p, c;
              let e = eD(
                  (function (e, t) {
                    let r = [];
                    for (; (e = e.parent); ) {
                      (!t || t(e)) && r.push(e);
                    }
                    return r;
                  })(i, (e) => "Group" === e.type && !!e.flags),
                ),
                t = e ? ey(n.globalFlags, e) : n.globalFlags;
              ((p = t),
                (c = n.currentFlags),
                (p.dotAll !== c.dotAll || p.ignoreCase !== c.ignoreCase) &&
                  (u = P({
                    flags: (function ({ dotAll: e, ignoreCase: t }) {
                      let r = {};
                      return (
                        (e || t) &&
                          ((r.enable = {}),
                          e && (r.enable.dotAll = !0),
                          t && (r.enable.ignoreCase = !0)),
                        (e && t) ||
                          ((r.disable = {}),
                          e || (r.disable.dotAll = !0),
                          t || (r.disable.ignoreCase = !0)),
                        r
                      );
                    })(t),
                  })).body[0].body.push(l));
            }
            r(eV(u, t), { traverse: !s });
          },
        },
        eP = {
          Backreference({ node: e, parent: t, replaceWith: r }, n) {
            if (e.orphan) {
              n.highestOrphanBackref = Math.max(n.highestOrphanBackref, e.ref);
              return;
            }
            let a = n.reffedNodesByReferencer.get(e).filter((t) =>
              (function (e, t) {
                let r = t;
                do {
                  if ("Regex" === r.type) {
                    return !1;
                  }
                  if ("Alternative" === r.type) {
                    continue;
                  }
                  if (r === e) {
                    return !1;
                  }
                  for (let t of eB(r.parent)) {
                    if (t === r) {
                      break;
                    }
                    if (
                      t === e ||
                      (function e(t, r) {
                        for (let n of eB(t) ?? []) {
                          if (n === r || e(n, r)) return !0;
                        }
                        return !1;
                      })(t, e)
                    ) {
                      return !0;
                    }
                  }
                } while ((r = r.parent));
                throw Error("Unexpected path");
              })(t, e),
            );
            a.length
              ? a.length > 1
                ? r(
                    eV(
                      P({
                        atomic: !0,
                        body: a.toReversed().map((e) => v({ body: [S(e.number)] })),
                      }),
                      t,
                    ),
                  )
                : (e.ref = a[0].number)
              : r(eV(U({ negate: !0 }), t));
          },
          CapturingGroup({ node: e }, t) {
            ((e.number = ++t.numCapturesToLeft),
              e.name &&
                t.groupsByName.get(e.name).get(e).hasDuplicateNameToRemove &&
                delete e.name);
          },
          Regex: {
            exit({ node: e }, t) {
              let r = Math.max(t.highestOrphanBackref - t.numCapturesToLeft, 0);
              for (let t = 0; t < r; t++) {
                let t = M();
                e.body.at(-1).body.push(t);
              }
            },
          },
          Subroutine({ node: e }, t) {
            e.isRecursive && 0 !== e.ref && (e.ref = t.reffedNodesByReferencer.get(e).number);
          },
        };
      function eU(e) {
        H(e, {
          "*"({ node: e, parent: t }) {
            e.parent = t;
          },
        });
      }
      function eR(e) {
        let t = G(e);
        return ((t.isRecursive = !0), t);
      }
      function eG(e, t) {
        if (t.has(e)) {
          return t.get(e);
        }
        let r = `$${t.size}_${e.replace(/^[^$_\p{IDS}]|[^$\u200C\u200D\p{IDC}]/gu, "_")}`;
        return (t.set(e, r), r);
      }
      function eD(e) {
        let t = ["dotAll", "ignoreCase"],
          r = { enable: {}, disable: {} };
        return (e.forEach(({ flags: e }) => {
          t.forEach((t) => {
            (e.enable?.[t] && (delete r.disable[t], (r.enable[t] = !0)),
              e.disable?.[t] && (r.disable[t] = !0));
          });
        }),
        Object.keys(r.enable).length || delete r.enable,
        Object.keys(r.disable).length || delete r.disable,
        r.enable || r.disable)
          ? r
          : null;
      }
      function eB(e) {
        if (!e) {
          throw Error("Node expected");
        }
        let { body: t } = e;
        return Array.isArray(t) ? t : t ? [t] : null;
      }
      function eO(e) {
        return /^[$_\p{IDS}][$\u200C\u200D\p{IDC}]*$/u.test(e);
      }
      function eT(e, t) {
        let r = I(e, { ...t, unicodePropertyMap: e$ }).body;
        return r.length > 1 || r[0].body.length > 1 ? P({ body: r }) : r[0].body[0];
      }
      function eW(e, t) {
        return ((e.negate = t), e);
      }
      function ez(e, t) {
        return ((e.parent = t), e);
      }
      function eV(e, t) {
        return (eU(e), (e.parent = t), e);
      }
      var ej = {
          "*": {
            enter({ node: e }, t) {
              if (e1(e)) {
                let r = t.getCurrentModI();
                t.pushModI(e.flags ? ey({ ignoreCase: r }, e.flags).ignoreCase : r);
              }
            },
            exit({ node: e }, t) {
              e1(e) && t.popModI();
            },
          },
          Backreference(e, t) {
            t.setHasCasedChar();
          },
          Character({ node: e }, t) {
            eJ(ef(e.value)) && t.setHasCasedChar();
          },
          CharacterClassRange({ node: e, skip: t }, r) {
            (t(), eY(e, { firstOnly: !0 }).length && r.setHasCasedChar());
          },
          CharacterSet({ node: e }, t) {
            "property" === e.kind && eN.has(e.value) && t.setHasCasedChar();
          },
        },
        eH = {
          Alternative: ({ body: e }, t, r) => e.map(r).join(""),
          Assertion({ kind: e, negate: t }) {
            if ("string_end" === e) {
              return "$";
            }
            if ("string_start" === e) {
              return "^";
            }
            if ("word_boundary" === e) {
              return t ? eg`\B` : eg`\b`;
            }
            throw Error(`Unexpected assertion kind "${e}"`);
          },
          Backreference({ ref: e }, t) {
            if ("number" != typeof e) {
              throw Error("Unexpected named backref in transformed AST");
            }
            if (
              !t.useFlagMods &&
              "strict" === t.accuracy &&
              t.currentFlags.ignoreCase &&
              !t.captureMap.get(e).ignoreCase
            ) {
              throw Error(
                "Use of case-insensitive backref to case-sensitive group requires target ES2025 or non-strict accuracy",
              );
            }
            return "\\" + e;
          },
          CapturingGroup(e, t, r) {
            let { body: n, name: a, number: o } = e,
              i = { ignoreCase: t.currentFlags.ignoreCase },
              s = t.originMap.get(e);
            return (
              s && ((i.hidden = !0), o > s.number && (i.transferTo = s.number)),
              t.captureMap.set(o, i),
              `(${a ? `?<${a}>` : ""}${n.map(r).join("|")})`
            );
          },
          Character({ value: e }, t) {
            let r = ef(e),
              n = e0(e, {
                escDigit: "Backreference" === t.lastNode.type,
                inCharClass: t.inCharClass,
                useFlagV: t.useFlagV,
              });
            if (n !== r) {
              return n;
            }
            if (t.useAppliedIgnoreCase && t.currentFlags.ignoreCase && eJ(r)) {
              let e = eE(r);
              return t.inCharClass ? e.join("") : e.length > 1 ? `[${e.join("")}]` : e[0];
            }
            return r;
          },
          CharacterClass(e, t, r) {
            let { kind: n, negate: a, parent: o } = e,
              { body: i } = e;
            if ("intersection" === n && !t.useFlagV) {
              throw Error("Use of character class intersection requires min target ES2024");
            }
            eh.bugFlagVLiteralHyphenIsRange &&
              t.useFlagV &&
              i.some(e2) &&
              (i = [N(45), ...i.filter((e) => !e2(e))]);
            let s = () => `[${a ? "^" : ""}${i.map(r).join("intersection" === n ? "&&" : "")}]`;
            if (!t.inCharClass) {
              if ((!t.useFlagV || eh.bugNestedClassIgnoresNegation) && !a) {
                let t = i.filter(
                  (e) => "CharacterClass" === e.type && "union" === e.kind && e.negate,
                );
                if (t.length) {
                  let n = P(),
                    a = n.body[0];
                  return (
                    (n.parent = o),
                    (a.parent = n),
                    (e.body = i = i.filter((e) => !t.includes(e))),
                    i.length ? ((e.parent = a), a.body.push(e)) : n.body.pop(),
                    t.forEach((e) => {
                      let t = v({ body: [e] });
                      ((e.parent = t), (t.parent = n), n.body.push(t));
                    }),
                    r(n)
                  );
                }
              }
              t.inCharClass = !0;
              let n = s();
              return ((t.inCharClass = !1), n);
            }
            let l = i[0];
            if (
              "union" === n &&
              !a &&
              l &&
              (((!t.useFlagV || !t.verbose) &&
                "union" === o.kind &&
                !(eh.bugFlagVLiteralHyphenIsRange && t.useFlagV)) ||
                (!t.verbose &&
                  "intersection" === o.kind &&
                  1 === i.length &&
                  "CharacterClassRange" !== l.type))
            ) {
              return i.map(r).join("");
            }
            if (!t.useFlagV && "CharacterClass" === o.type) {
              throw Error("Uses nested character class in a way that requires min target ES2024");
            }
            return s();
          },
          CharacterClassRange(e, t) {
            let r = e.min.value,
              n = e.max.value,
              a = { escDigit: !1, inCharClass: !0, useFlagV: t.useFlagV },
              o = e0(r, a),
              i = e0(n, a),
              s = new Set();
            return (
              t.useAppliedIgnoreCase &&
                t.currentFlags.ignoreCase &&
                (function (e) {
                  let t = e.map((e) => e.codePointAt(0)).toSorted((e, t) => e - t),
                    r = [],
                    n = null;
                  for (let e = 0; e < t.length; e++) {
                    t[e + 1] === t[e] + 1
                      ? (n ??= t[e])
                      : null === n
                        ? r.push(t[e])
                        : (r.push([n, t[e]]), (n = null));
                  }
                  return r;
                })(eY(e)).forEach((e) => {
                  s.add(Array.isArray(e) ? `${e0(e[0], a)}-${e0(e[1], a)}` : e0(e, a));
                }),
              `${o}-${i}${[...s].join("")}`
            );
          },
          CharacterSet({ kind: e, negate: t, value: r, key: n }, a) {
            if ("dot" === e) {
              return a.currentFlags.dotAll
                ? a.appliedGlobalFlags.dotAll || a.useFlagMods
                  ? "."
                  : "[^]"
                : eg`[^\n]`;
            }
            if ("digit" === e) {
              return t ? eg`\D` : eg`\d`;
            }
            if ("property" === e) {
              if (a.useAppliedIgnoreCase && a.currentFlags.ignoreCase && eN.has(r)) {
                throw Error(
                  `Unicode property "${r}" can't be case-insensitive when other chars have specific case`,
                );
              }
              return `${t ? eg`\P` : eg`\p`}{${n ? `${n}=` : ""}${r}}`;
            }
            if ("word" === e) {
              return t ? eg`\W` : eg`\w`;
            }
            throw Error(`Unexpected character set kind "${e}"`);
          },
          Flags: (e, t) =>
            (t.appliedGlobalFlags.ignoreCase ? "i" : "") +
            (e.dotAll ? "s" : "") +
            (e.sticky ? "y" : ""),
          Group({ atomic: e, body: t, flags: r, parent: n }, a, o) {
            let i = a.currentFlags;
            r && (a.currentFlags = ey(i, r));
            let s = t.map(o).join("|"),
              l =
                a.verbose || 1 !== t.length || "Quantifier" === n.type || e || (a.useFlagMods && r)
                  ? `(?${(function (e, t, r) {
                      if (e) {
                        return ">";
                      }
                      let n = "";
                      if (t && r) {
                        let { enable: e, disable: r } = t;
                        n =
                          (e?.ignoreCase ? "i" : "") +
                          (e?.dotAll ? "s" : "") +
                          (r ? "-" : "") +
                          (r?.ignoreCase ? "i" : "") +
                          (r?.dotAll ? "s" : "");
                      }
                      return `${n}:`;
                    })(e, r, a.useFlagMods)}${s})`
                  : s;
            return ((a.currentFlags = i), l);
          },
          LookaroundAssertion({ body: e, kind: t, negate: r }, n, a) {
            let o = `${"lookahead" === t ? "" : "<"}${r ? "!" : "="}`;
            return `(?${o}${e.map(a).join("|")})`;
          },
          Quantifier: (e, t, r) =>
            r(e.body) +
            (function ({ kind: e, max: t, min: r }) {
              return (
                (r || 1 !== t
                  ? r || t !== 1 / 0
                    ? 1 === r && t === 1 / 0
                      ? "+"
                      : r === t
                        ? `{${r}}`
                        : `{${r},${t === 1 / 0 ? "" : t}}`
                    : "*"
                  : "?") + { greedy: "", lazy: "?", possessive: "+" }[e]
              );
            })(e),
          Subroutine({ isRecursive: e, ref: t }, r) {
            if (!e) {
              throw Error("Unexpected non-recursive subroutine in transformed AST");
            }
            let n = r.recursionLimit;
            return 0 === t ? `(?R=${n})` : eg`\g<${t}&R=${n}>`;
          },
        },
        eX = new Set(["$", "(", ")", "*", "+", ".", "?", "[", "\\", "]", "^", "{", "|", "}"]),
        eZ = new Set(["-", "\\", "]", "^", "["]),
        eQ = new Set([
          "(",
          ")",
          "-",
          "/",
          "[",
          "\\",
          "]",
          "^",
          "{",
          "|",
          "}",
          "!",
          "#",
          "$",
          "%",
          "&",
          "*",
          "+",
          ",",
          ".",
          ":",
          ";",
          "<",
          "=",
          ">",
          "?",
          "@",
          "`",
          "~",
        ]),
        eq = new Map([
          [9, eg`\t`],
          [10, eg`\n`],
          [11, eg`\v`],
          [12, eg`\f`],
          [13, eg`\r`],
          [8232, eg`\u2028`],
          [8233, eg`\u2029`],
          [65279, eg`\uFEFF`],
        ]),
        eK = /^\p{Cased}$/u;
      function eJ(e) {
        return eK.test(e);
      }
      function eY(e, t) {
        let r = !!t?.firstOnly,
          n = e.min.value,
          a = e.max.value,
          o = [];
        if ((n < 65 && (65535 === a || a >= 131071)) || (65536 === n && a >= 131071)) {
          return o;
        }
        for (let e = n; e <= a; e++) {
          let t = ef(e);
          if (!eJ(t)) {
            continue;
          }
          let i = eE(t).filter((e) => {
            let t = e.codePointAt(0);
            return t < n || t > a;
          });
          if (i.length && (o.push(...i), r)) {
            break;
          }
        }
        return o;
      }
      function e0(e, { escDigit: t, inCharClass: r, useFlagV: n }) {
        var a;
        if (eq.has(e)) {
          return eq.get(e);
        }
        if (e < 32 || (e > 126 && e < 160) || e > 262143 || (t && (a = e) > 47 && a < 58)) {
          return e > 255
            ? `\\u{${e.toString(16).toUpperCase()}}`
            : `\\x${e.toString(16).toUpperCase().padStart(2, "0")}`;
        }
        let o = ef(e);
        return ((r ? (n ? eQ : eZ) : eX).has(o) ? "\\" : "") + o;
      }
      function e1({ type: e }) {
        return "CapturingGroup" === e || "Group" === e || "LookaroundAssertion" === e;
      }
      function e2({ type: e, value: t }) {
        return "Character" === e && 45 === t;
      }
      var e8 = class e extends RegExp {
        #e = new Map();
        #t = null;
        #r;
        #n = null;
        #a = null;
        rawOptions = {};
        get source() {
          return this.#r || "(?:)";
        }
        constructor(t, r, n) {
          let a = !!n?.lazyCompile;
          if (t instanceof RegExp) {
            if (n) {
              throw Error("Cannot provide options when copying a regexp");
            }
            (super(t, r),
              (this.#r = t.source),
              t instanceof e &&
                ((this.#e = t.#e),
                (this.#n = t.#n),
                (this.#a = t.#a),
                (this.rawOptions = t.rawOptions)));
          } else {
            let e = { hiddenCaptures: [], strategy: null, transfers: [], ...n };
            (super(a ? "" : t, r),
              (this.#r = t),
              (this.#e = (function (e, t) {
                let r = new Map();
                for (let t of e) {
                  r.set(t, { hidden: !0 });
                }
                for (let [e, n] of t) {
                  for (let t of n) em(r, t, {}).transferTo = e;
                }
                return r;
              })(e.hiddenCaptures, e.transfers)),
              (this.#a = e.strategy),
              (this.rawOptions = n ?? {}));
          }
          a || (this.#t = this);
        }
        exec(t) {
          if (!this.#t) {
            let { lazyCompile: t, ...r } = this.rawOptions;
            this.#t = new e(this.#r, this.flags, r);
          }
          let r = this.global || this.sticky,
            n = this.lastIndex;
          if ("clip_search" === this.#a && r && n) {
            this.lastIndex = 0;
            let e = this.#o(t.slice(n));
            return (
              e &&
                ((function (e, t, r, n) {
                  if (((e.index += t), (e.input = r), n)) {
                    let r = e.indices;
                    for (let e = 0; e < r.length; e++) {
                      let n = r[e];
                      n && (r[e] = [n[0] + t, n[1] + t]);
                    }
                    let n = r.groups;
                    n &&
                      Object.keys(n).forEach((e) => {
                        let r = n[e];
                        r && (n[e] = [r[0] + t, r[1] + t]);
                      });
                  }
                })(e, n, t, this.hasIndices),
                (this.lastIndex += n)),
              e
            );
          }
          return this.#o(t);
        }
        #o(e) {
          let t;
          this.#t.lastIndex = this.lastIndex;
          let r = super.exec.call(this.#t, e);
          if (((this.lastIndex = this.#t.lastIndex), !r || !this.#e.size)) {
            return r;
          }
          let n = [...r];
          ((r.length = 1), this.hasIndices && ((t = [...r.indices]), (r.indices.length = 1)));
          let a = [0];
          for (let e = 1; e < n.length; e++) {
            let { hidden: o, transferTo: i } = this.#e.get(e) ?? {};
            if (
              (o
                ? a.push(null)
                : (a.push(r.length), r.push(n[e]), this.hasIndices && r.indices.push(t[e])),
              i && void 0 !== n[e])
            ) {
              let o = a[i];
              if (!o) {
                throw Error(`Invalid capture transfer to "${o}"`);
              }
              if (((r[o] = n[e]), this.hasIndices && (r.indices[o] = t[e]), r.groups)) {
                this.#n ||
                  (this.#n = (function (e) {
                    let t,
                      r = /(?<capture>\((?:\?<(?![=!])(?<name>[^>]+)>|(?!\?)))|\\?./gsu,
                      n = new Map(),
                      a = 0,
                      o = 0;
                    for (; (t = r.exec(e)); ) {
                      let {
                        0: e,
                        groups: { capture: r, name: i },
                      } = t;
                      "[" === e ? a++ : a ? "]" === e && a-- : r && (o++, i && n.set(o, i));
                    }
                    return n;
                  })(this.source));
                let a = this.#n.get(i);
                a && ((r.groups[a] = n[e]), this.hasIndices && (r.indices.groups[a] = t[e]));
              }
            }
          }
          return r;
        }
      };
      function e3(e, t) {
        let r = (function (e, t) {
          let r = ew(t),
            n = (function (e, t) {
              let r = {
                accuracy: "default",
                asciiWordBoundaries: !1,
                avoidSubclass: !1,
                bestEffortTarget: "ES2025",
                ...t,
              };
              eU(e);
              let n = {
                accuracy: r.accuracy,
                asciiWordBoundaries: r.asciiWordBoundaries,
                avoidSubclass: r.avoidSubclass,
                flagDirectivesByAlt: new Map(),
                jsGroupNameMap: new Map(),
                minTargetEs2024: eb[r.bestEffortTarget] >= eb.ES2024,
                passedLookbehind: !1,
                strategy: null,
                subroutineRefMap: new Map(),
                supportedGNodes: new Set(),
                digitIsAscii: e.flags.digitIsAscii,
                spaceIsAscii: e.flags.spaceIsAscii,
                wordIsAscii: e.flags.wordIsAscii,
              };
              H(e, eL, n);
              let a = { dotAll: e.flags.dotAll, ignoreCase: e.flags.ignoreCase },
                o = {
                  currentFlags: a,
                  prevFlags: null,
                  globalFlags: a,
                  groupOriginByCopy: new Map(),
                  groupsByName: new Map(),
                  multiplexCapturesToLeftByRef: new Map(),
                  openRefs: new Map(),
                  reffedNodesByReferencer: new Map(),
                  subroutineRefMap: n.subroutineRefMap,
                };
              return (
                H(e, eF, o),
                H(e, eP, {
                  groupsByName: o.groupsByName,
                  highestOrphanBackref: 0,
                  numCapturesToLeft: 0,
                  reffedNodesByReferencer: o.reffedNodesByReferencer,
                }),
                (e._originMap = o.groupOriginByCopy),
                (e._strategy = n.strategy),
                e
              );
            })(
              I(e, {
                flags: r.flags,
                normalizeUnknownPropertyNames: !0,
                rules: { captureGroup: r.rules.captureGroup, singleline: r.rules.singleline },
                skipBackrefValidation: r.rules.allowOrphanBackrefs,
                unicodePropertyMap: e$,
              }),
              {
                accuracy: r.accuracy,
                asciiWordBoundaries: r.rules.asciiWordBoundaries,
                avoidSubclass: r.avoidSubclass,
                bestEffortTarget: r.target,
              },
            ),
            a = (function (e, t) {
              let r = ew(t),
                n = eb[r.target] >= eb.ES2024,
                a = eb[r.target] >= eb.ES2025,
                o = r.rules.recursionLimit;
              if (!Number.isInteger(o) || o < 2 || o > 20) {
                throw Error("Invalid recursionLimit; use 2-20");
              }
              let i = null,
                s = null;
              if (!a) {
                let t = [e.flags.ignoreCase];
                H(e, ej, {
                  getCurrentModI: () => t.at(-1),
                  popModI() {
                    t.pop();
                  },
                  pushModI(e) {
                    t.push(e);
                  },
                  setHasCasedChar() {
                    t.at(-1) ? (i = !0) : (s = !0);
                  },
                });
              }
              let l = { dotAll: e.flags.dotAll, ignoreCase: !!((e.flags.ignoreCase || i) && !s) },
                u = e,
                p = {
                  accuracy: r.accuracy,
                  appliedGlobalFlags: l,
                  captureMap: new Map(),
                  currentFlags: { dotAll: e.flags.dotAll, ignoreCase: e.flags.ignoreCase },
                  inCharClass: !1,
                  lastNode: u,
                  originMap: e._originMap,
                  recursionLimit: o,
                  useAppliedIgnoreCase: !!(!a && i && s),
                  useFlagMods: a,
                  useFlagV: n,
                  verbose: r.verbose,
                };
              function c(e) {
                return (
                  (p.lastNode = u),
                  (u = e),
                  (function (e, t) {
                    if (null == e) {
                      throw Error(t ?? "Value expected");
                    }
                    return e;
                  })(eH[e.type], `Unexpected node type "${e.type}"`)(e, p, c)
                );
              }
              let d = {
                pattern: e.body.map(c).join("|"),
                flags: c(e.flags),
                options: { ...e.options },
              };
              return (
                n ||
                  (delete d.options.force.v,
                  (d.options.disable.v = !0),
                  (d.options.unicodeSetsPlugin = null)),
                (d._captureTransfers = new Map()),
                (d._hiddenCaptures = []),
                p.captureMap.forEach((e, t) => {
                  (e.hidden && d._hiddenCaptures.push(t),
                    e.transferTo && em(d._captureTransfers, e.transferTo, []).push(t));
                }),
                d
              );
            })(n, r),
            o = (function (e, t) {
              let r,
                { hiddenCaptures: n, mode: a } = { hiddenCaptures: [], mode: "plugin", ...t },
                o = t?.captureTransfers ?? new Map();
              if (!RegExp(ea, "su").test(e)) {
                return { pattern: e, captureTransfers: o, hiddenCaptures: n };
              }
              if ("plugin" === a && J(e, er`\(\?\(DEFINE\)`, q.DEFAULT)) {
                throw Error("DEFINE groups cannot be used with recursion");
              }
              let i = [],
                s = J(e, er`\\[1-9]`, q.DEFAULT),
                l = new Map(),
                u = [],
                p = !1,
                c = 0,
                d = 0;
              for (es.lastIndex = 0; (r = es.exec(e)); ) {
                let {
                  0: t,
                  groups: { captureName: f, rDepth: g, gRNameOrNum: h, gRDepth: y },
                } = r;
                if ("[" === t) {
                  c++;
                } else if (c) {
                  "]" === t && c--;
                } else if (g) {
                  if ((eu(g), p)) {
                    throw Error(el);
                  }
                  if (s) {
                    throw Error(
                      `${"external" === a ? "Backrefs" : "Numbered backrefs"} cannot be used with global recursion`,
                    );
                  }
                  let t = e.slice(0, r.index),
                    l = e.slice(es.lastIndex);
                  if (J(l, ea, q.DEFAULT)) {
                    throw Error(el);
                  }
                  let u = g - 1;
                  ((e = ep(t, l, u, !1, n, i, d)), (o = ed(o, t, u, i.length, 0, d)));
                  break;
                } else if (h) {
                  eu(y);
                  let c = !1;
                  for (let e of u) {
                    if (e.name === h || e.num === +h) {
                      if (((c = !0), e.hasRecursedWithin)) throw Error(el);
                      break;
                    }
                  }
                  if (!c) {
                    throw Error(
                      er`Recursive \g cannot be used outside the referenced group "${"external" === a ? h : er`\g<${h}&R=${y}>`}"`,
                    );
                  }
                  let f = l.get(h),
                    g = (function (e, t) {
                      let r,
                        n = /\\?./gsu;
                      n.lastIndex = t;
                      let a = e.length,
                        o = 0,
                        i = 1;
                      for (; (r = n.exec(e)); ) {
                        let [e] = r;
                        if ("[" === e) {
                          o++;
                        } else if (o) {
                          "]" === e && o--;
                        } else if ("(" === e) {
                          i++;
                        } else if (")" === e && !--i) {
                          a = r.index;
                          break;
                        }
                      }
                      return e.slice(t, a);
                    })(e, f);
                  if (s && J(g, er`${eo}|\((?!\?)`, q.DEFAULT)) {
                    throw Error(
                      `${"external" === a ? "Backrefs" : "Numbered backrefs"} cannot be used with recursion of capturing groups`,
                    );
                  }
                  let m = e.slice(f, r.index),
                    b = g.slice(m.length + t.length),
                    C = i.length,
                    w = y - 1,
                    x = ep(m, b, w, !0, n, i, d);
                  o = ed(o, m, w, i.length - C, C, d);
                  let k = e.slice(0, f),
                    E = e.slice(f + g.length);
                  ((e = `${k}${x}${E}`),
                    (es.lastIndex += x.length - t.length - m.length - b.length),
                    u.forEach((e) => (e.hasRecursedWithin = !0)),
                    (p = !0));
                } else if (f) {
                  (d++,
                    l.set(String(d), es.lastIndex),
                    l.set(f, es.lastIndex),
                    u.push({ num: d, name: f }));
                } else if ("(" === t[0]) {
                  let e = "(" === t;
                  (e && (d++, l.set(String(d), es.lastIndex)), u.push(e ? { num: d } : {}));
                } else {
                  ")" === t && u.pop();
                }
              }
              return (n.push(...i), { pattern: e, captureTransfers: o, hiddenCaptures: n });
            })(a.pattern, {
              captureTransfers: a._captureTransfers,
              hiddenCaptures: a._hiddenCaptures,
              mode: "external",
            }),
            i = (function (e, t) {
              let r,
                n = t?.hiddenCaptures ?? [],
                a = t?.captureTransfers ?? new Map();
              if (!/\(\?>/.test(e)) {
                return { pattern: e, captureTransfers: a, hiddenCaptures: n };
              }
              let o = "(?:(?=(",
                i = [0],
                s = [],
                l = 0,
                u = 0,
                p = NaN;
              do {
                let t;
                r = !1;
                let c = 0,
                  d = 0,
                  f = !1;
                for (Y.lastIndex = Number.isNaN(p) ? 0 : p + o.length; (t = Y.exec(e)); ) {
                  let {
                    0: g,
                    index: h,
                    groups: { capturingStart: y, noncapturingStart: m },
                  } = t;
                  if ("[" === g) {
                    c++;
                  } else if (c) {
                    "]" === g && c--;
                  } else if ("(?>" !== g || f) {
                    if (f && m) {
                      d++;
                    } else if (y) {
                      f ? d++ : (l++, i.push(l + u));
                    } else if (")" === g && f) {
                      if (!d) {
                        let t = l + ++u;
                        ((e = `${e.slice(0, p)}${o}${e.slice(p + 3, h)}))<$$${t}>)${e.slice(h + 1)}`),
                          (r = !0),
                          s.push(t));
                        for (let e = 0; e < n.length; e++) {
                          n[e] >= t && n[e]++;
                        }
                        if (a.size) {
                          let e = new Map();
                          (a.forEach((r, n) => {
                            e.set(
                              n >= t ? n + 1 : n,
                              r.map((e) => (e >= t ? e + 1 : e)),
                            );
                          }),
                            (a = e));
                        }
                        break;
                      }
                      d--;
                    }
                  } else {
                    ((p = h), (f = !0));
                  }
                }
              } while (r);
              return (
                n.push(...s),
                {
                  pattern: (e = K(
                    e,
                    String.raw`\\(?<backrefNum>[1-9]\d*)|<\$\$(?<wrappedBackrefNum>\d+)>`,
                    ({ 0: e, groups: { backrefNum: t, wrappedBackrefNum: r } }) => {
                      if (t) {
                        let r = +t;
                        if (r > i.length - 1) {
                          throw Error(`Backref "${e}" greater than number of captures`);
                        }
                        return `\\${i[r]}`;
                      }
                      return `\\${r}`;
                    },
                    q.DEFAULT,
                  )),
                  captureTransfers: a,
                  hiddenCaptures: n,
                }
              );
            })(
              (function (e) {
                let t;
                if (!RegExp(`${ee}\\+`).test(e)) {
                  return { pattern: e };
                }
                let r = [],
                  n = null,
                  a = null,
                  o = "",
                  i = 0;
                for (et.lastIndex = 0; (t = et.exec(e)); ) {
                  let {
                    0: u,
                    index: p,
                    groups: { qBase: c, qMod: d, invalidQ: f },
                  } = t;
                  if ("[" === u) {
                    (i || (a = p), i++);
                  } else if ("]" === u) {
                    i ? i-- : (a = null);
                  } else if (!i) {
                    if ("+" === d && o && !o.startsWith("(")) {
                      if (f) throw Error(`Invalid quantifier "${u}"`);
                      let t = -1;
                      if (/^\{\d+\}$/.test(c)) {
                        var s, l;
                        ((s = e),
                          (l = p + c.length),
                          (e = s.slice(0, l) + "" + s.slice(l + d.length)));
                      } else {
                        if (")" === o || "]" === o) {
                          let t = ")" === o ? n : a;
                          if (null === t) throw Error(`Invalid unmatched "${o}"`);
                          e = `${e.slice(0, t)}(?>${e.slice(t, p)}${c})${e.slice(p + u.length)}`;
                        } else
                          e = `${e.slice(0, p - o.length)}(?>${o}${c})${e.slice(p + u.length)}`;
                        t += 4;
                      }
                      et.lastIndex += t;
                    } else "(" === u[0] ? r.push(p) : ")" === u && (n = r.length ? r.pop() : null);
                  }
                  o = u;
                }
                return { pattern: e };
              })(o.pattern).pattern,
              { captureTransfers: o.captureTransfers, hiddenCaptures: o.hiddenCaptures },
            ),
            s = {
              pattern: i.pattern,
              flags: `${r.hasIndices ? "d" : ""}${r.global ? "g" : ""}${a.flags}${a.options.disable.v ? "u" : "v"}`,
            };
          if (r.avoidSubclass) {
            if (r.lazyCompileLength !== 1 / 0) {
              throw Error("Lazy compilation requires subclass");
            }
          } else {
            let e = i.hiddenCaptures.toSorted((e, t) => e - t),
              t = Array.from(i.captureTransfers),
              a = n._strategy,
              o = s.pattern.length >= r.lazyCompileLength;
            (e.length || t.length || a || o) &&
              (s.options = {
                ...(e.length && { hiddenCaptures: e }),
                ...(t.length && { transfers: t }),
                ...(a && { strategy: a }),
                ...(o && { lazyCompile: o }),
              });
          }
          return s;
        })(e, t);
        return r.options ? new e8(r.pattern, r.flags, r.options) : new RegExp(r.pattern, r.flags);
      }
    },
  },
]);
