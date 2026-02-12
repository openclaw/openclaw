(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [79845],
  {
    10904: (e, t, r) => {
      var n = r(97989),
        o = r(92937),
        i = r(87247),
        u = r(41921);
      e.exports = function (e) {
        return function (t) {
          var r = o((t = u(t))) ? i(t) : void 0,
            a = r ? r[0] : t.charAt(0),
            s = r ? n(r, 1).join("") : t.slice(1);
          return a[e]() + s;
        };
      };
    },
    12598: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("X", [
        ["path", { d: "M18 6 6 18", key: "1bl5f8" }],
        ["path", { d: "m6 6 12 12", key: "d8bk6v" }],
      ]);
    },
    14418: (e) => {
      var t = "\ud800-\udfff",
        r = "\\u2700-\\u27bf",
        n = "a-z\\xdf-\\xf6\\xf8-\\xff",
        o = "A-Z\\xc0-\\xd6\\xd8-\\xde",
        i =
          "\\xac\\xb1\\xd7\\xf7\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf\\u2000-\\u206f \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000",
        u = "['’]",
        a = "[" + i + "]",
        s = "[" + n + "]",
        l = "[^" + t + i + "\\d+" + r + n + o + "]",
        c = "(?:\ud83c[\udde6-\uddff]){2}",
        f = "[\ud800-\udbff][\udc00-\udfff]",
        d = "[" + o + "]",
        p = "(?:" + s + "|" + l + ")",
        h = "(?:" + d + "|" + l + ")",
        m = "(?:" + u + "(?:d|ll|m|re|s|t|ve))?",
        x = "(?:" + u + "(?:D|LL|M|RE|S|T|VE))?",
        v = "(?:[\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff]|\ud83c[\udffb-\udfff])?",
        g = "[\\ufe0e\\ufe0f]?",
        y = "(?:\\u200d(?:" + ["[^" + t + "]", c, f].join("|") + ")" + g + v + ")*",
        w = "(?:" + ["[" + r + "]", c, f].join("|") + ")" + (g + v + y),
        b = RegExp(
          [
            d + "?" + s + "+" + m + "(?=" + [a, d, "$"].join("|") + ")",
            h + "+" + x + "(?=" + [a, d + p, "$"].join("|") + ")",
            d + "?" + p + "+" + m,
            d + "+" + x,
            "\\d*(?:1ST|2ND|3RD|(?![123])\\dTH)(?=\\b|[a-z_])|\\d*(?:1st|2nd|3rd|(?![123])\\dth)(?=\\b|[A-Z_])|\\d+",
            w,
          ].join("|"),
          "g",
        );
      e.exports = function (e) {
        return e.match(b) || [];
      };
    },
    27015: (e, t, r) => {
      e.exports = r(10904)("toUpperCase");
    },
    27523: (e) => {
      e.exports = function (e, t, r) {
        var n = -1,
          o = e.length;
        (t < 0 && (t = -t > o ? 0 : o + t),
          (r = r > o ? o : r) < 0 && (r += o),
          (o = t > r ? 0 : (r - t) >>> 0),
          (t >>>= 0));
        for (var i = Array(o); ++n < o; ) {
          i[n] = e[n + t];
        }
        return i;
      };
    },
    34668: (e, t, r) => {
      "use strict";
      var n = r(35822),
        o = /(?:(?:[^:]+:)?[/][/])?(?:.+@)?([^/]+)([/][^?#]+)/;
      e.exports = function (e, t) {
        var r = {};
        if (((t = t || {}), !e || (e.url && (e = e.url), "string" != typeof e))) {
          return null;
        }
        var i = e.match(/^([\w-_]+)\/([\w-_.]+)(?:#([\w-_.]+))?$/),
          u = e.match(/^github:([\w-_]+)\/([\w-_.]+)(?:#([\w-_.]+))?$/),
          a = e.match(/^git@[\w-_.]+:([\w-_]+)\/([\w-_.]+)$/);
        if (i) {
          ((r.user = i[1]),
            (r.repo = i[2]),
            (r.branch = i[3] || "master"),
            (r.host = "github.com"));
        } else if (u) {
          ((r.user = u[1]),
            (r.repo = u[2]),
            (r.branch = u[3] || "master"),
            (r.host = "github.com"));
        } else if (a) {
          ((r.user = a[1]),
            (r.repo = a[2].replace(/\.git$/i, "")),
            (r.branch = "master"),
            (r.host = "github.com"));
        } else {
          if (!n((e = e.replace(/^git\+/, "")))) {
            return null;
          }
          var s = e.match(o) || [],
            l = s[1],
            c = s[2];
          if (!l || ("github.com" !== l && "www.github.com" !== l && !t.enterprise)) {
            return null;
          }
          var f = c.match(/^\/([\w-_]+)\/([\w-_.]+)(\/tree\/[%\w-_./]+)?(\/blob\/[%\w-_./]+)?/);
          if (!f) {
            return null;
          }
          if (
            ((r.user = f[1]),
            (r.repo = f[2].replace(/\.git$/i, "")),
            (r.host = l || "github.com"),
            f[3] && f[3].startsWith("/tree/master/"))
          ) {
            ((r.branch = "master"), (r.path = f[3].replace(/\/$/, "")));
          } else if (f[3]) {
            var d = f[3].replace(/^\/tree\//, "").match(/[%\w-_.]*\/?[%\w-_]+/);
            r.branch = d && d[0];
          } else if (f[4]) {
            var d = f[4].replace(/^\/blob\//, "").match(/[%\w-_.]*\/?[%\w-_]+/);
            r.branch = d && d[0];
          } else {
            r.branch = "master";
          }
        }
        return (
          "github.com" === r.host
            ? (r.apiHost = "api.github.com")
            : (r.apiHost = r.host + "/api/v3"),
          (r.tarball_url =
            "https://" + r.apiHost + "/repos/" + r.user + "/" + r.repo + "/tarball/" + r.branch),
          (r.clone_url = "https://" + r.host + "/" + r.user + "/" + r.repo),
          "master" === r.branch
            ? ((r.https_url = "https://" + r.host + "/" + r.user + "/" + r.repo),
              (r.travis_url = "https://travis-ci.org/" + r.user + "/" + r.repo),
              (r.zip_url =
                "https://" + r.host + "/" + r.user + "/" + r.repo + "/archive/master.zip"))
            : ((r.https_url =
                "https://" + r.host + "/" + r.user + "/" + r.repo + "/blob/" + r.branch),
              (r.travis_url =
                "https://travis-ci.org/" + r.user + "/" + r.repo + "?branch=" + r.branch),
              (r.zip_url =
                "https://" +
                r.host +
                "/" +
                r.user +
                "/" +
                r.repo +
                "/archive/" +
                r.branch +
                ".zip")),
          r.path && (r.https_url += r.path),
          (r.api_url = "https://" + r.apiHost + "/repos/" + r.user + "/" + r.repo),
          r
        );
      };
    },
    35612: (e, t, r) => {
      e.exports = r(86187)({
        À: "A",
        Á: "A",
        Â: "A",
        Ã: "A",
        Ä: "A",
        Å: "A",
        à: "a",
        á: "a",
        â: "a",
        ã: "a",
        ä: "a",
        å: "a",
        Ç: "C",
        ç: "c",
        Ð: "D",
        ð: "d",
        È: "E",
        É: "E",
        Ê: "E",
        Ë: "E",
        è: "e",
        é: "e",
        ê: "e",
        ë: "e",
        Ì: "I",
        Í: "I",
        Î: "I",
        Ï: "I",
        ì: "i",
        í: "i",
        î: "i",
        ï: "i",
        Ñ: "N",
        ñ: "n",
        Ò: "O",
        Ó: "O",
        Ô: "O",
        Õ: "O",
        Ö: "O",
        Ø: "O",
        ò: "o",
        ó: "o",
        ô: "o",
        õ: "o",
        ö: "o",
        ø: "o",
        Ù: "U",
        Ú: "U",
        Û: "U",
        Ü: "U",
        ù: "u",
        ú: "u",
        û: "u",
        ü: "u",
        Ý: "Y",
        ý: "y",
        ÿ: "y",
        Æ: "Ae",
        æ: "ae",
        Þ: "Th",
        þ: "th",
        ß: "ss",
        Ā: "A",
        Ă: "A",
        Ą: "A",
        ā: "a",
        ă: "a",
        ą: "a",
        Ć: "C",
        Ĉ: "C",
        Ċ: "C",
        Č: "C",
        ć: "c",
        ĉ: "c",
        ċ: "c",
        č: "c",
        Ď: "D",
        Đ: "D",
        ď: "d",
        đ: "d",
        Ē: "E",
        Ĕ: "E",
        Ė: "E",
        Ę: "E",
        Ě: "E",
        ē: "e",
        ĕ: "e",
        ė: "e",
        ę: "e",
        ě: "e",
        Ĝ: "G",
        Ğ: "G",
        Ġ: "G",
        Ģ: "G",
        ĝ: "g",
        ğ: "g",
        ġ: "g",
        ģ: "g",
        Ĥ: "H",
        Ħ: "H",
        ĥ: "h",
        ħ: "h",
        Ĩ: "I",
        Ī: "I",
        Ĭ: "I",
        Į: "I",
        İ: "I",
        ĩ: "i",
        ī: "i",
        ĭ: "i",
        į: "i",
        ı: "i",
        Ĵ: "J",
        ĵ: "j",
        Ķ: "K",
        ķ: "k",
        ĸ: "k",
        Ĺ: "L",
        Ļ: "L",
        Ľ: "L",
        Ŀ: "L",
        Ł: "L",
        ĺ: "l",
        ļ: "l",
        ľ: "l",
        ŀ: "l",
        ł: "l",
        Ń: "N",
        Ņ: "N",
        Ň: "N",
        Ŋ: "N",
        ń: "n",
        ņ: "n",
        ň: "n",
        ŋ: "n",
        Ō: "O",
        Ŏ: "O",
        Ő: "O",
        ō: "o",
        ŏ: "o",
        ő: "o",
        Ŕ: "R",
        Ŗ: "R",
        Ř: "R",
        ŕ: "r",
        ŗ: "r",
        ř: "r",
        Ś: "S",
        Ŝ: "S",
        Ş: "S",
        Š: "S",
        ś: "s",
        ŝ: "s",
        ş: "s",
        š: "s",
        Ţ: "T",
        Ť: "T",
        Ŧ: "T",
        ţ: "t",
        ť: "t",
        ŧ: "t",
        Ũ: "U",
        Ū: "U",
        Ŭ: "U",
        Ů: "U",
        Ű: "U",
        Ų: "U",
        ũ: "u",
        ū: "u",
        ŭ: "u",
        ů: "u",
        ű: "u",
        ų: "u",
        Ŵ: "W",
        ŵ: "w",
        Ŷ: "Y",
        ŷ: "y",
        Ÿ: "Y",
        Ź: "Z",
        Ż: "Z",
        Ž: "Z",
        ź: "z",
        ż: "z",
        ž: "z",
        Ĳ: "IJ",
        ĳ: "ij",
        Œ: "Oe",
        œ: "oe",
        ŉ: "'n",
        ſ: "s",
      });
    },
    35822: (e) => {
      e.exports = function (e) {
        if ("string" != typeof e) {
          return !1;
        }
        var o = e.match(t);
        if (!o) {
          return !1;
        }
        var i = o[1];
        return !!i && !!(r.test(i) || n.test(i));
      };
      var t = /^(?:\w+:)?\/\/(\S+)$/,
        r = /^localhost[:?\d]*(?:[^:?\d]\S*)?$/,
        n = /^[^\s.]+\.\S{2,}$/;
    },
    38615: (e, t, r) => {
      var n = r(35612),
        o = r(41921),
        i = /[\xc0-\xd6\xd8-\xf6\xf8-\xff\u0100-\u017f]/g,
        u = RegExp("[\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff]", "g");
      e.exports = function (e) {
        return (e = o(e)) && e.replace(i, n).replace(u, "");
      };
    },
    48805: (e) => {
      e.exports = function (e, t, r, n) {
        var o = -1,
          i = null == e ? 0 : e.length;
        for (n && i && (r = e[++o]); ++o < i; ) {
          r = t(r, e[o], o, e);
        }
        return r;
      };
    },
    51115: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("Moon", [
        ["path", { d: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z", key: "a7tn18" }],
      ]);
    },
    53085: (e) => {
      var t = "\ud800-\udfff",
        r = "[\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff]",
        n = "\ud83c[\udffb-\udfff]",
        o = "[^" + t + "]",
        i = "(?:\ud83c[\udde6-\uddff]){2}",
        u = "[\ud800-\udbff][\udc00-\udfff]",
        a = "(?:" + r + "|" + n + ")?",
        s = "[\\ufe0e\\ufe0f]?",
        l = "(?:\\u200d(?:" + [o, i, u].join("|") + ")" + s + a + ")*",
        c = RegExp(
          n +
            "(?=" +
            n +
            ")|" +
            ("(?:" + [o + r + "?", r, i, u, "[" + t + "]"].join("|")) +
            ")" +
            (s + a + l),
          "g",
        );
      e.exports = function (e) {
        return e.match(c) || [];
      };
    },
    58250: (e) => {
      var t = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;
      e.exports = function (e) {
        return e.match(t) || [];
      };
    },
    59955: (e, t, r) => {
      "use strict";
      r.d(t, { tz: () => e7, Ip: () => tt, kt: () => tr, JW: () => e4, Rc: () => e6 });
      var n = r(7620),
        o = r(47231),
        i = r(18107),
        u = r(21111),
        a = r(61715),
        s = r(54568);
      function l(e) {
        let t = (function (e) {
            let t = n.forwardRef((e, t) => {
              let { children: r, ...o } = e;
              if (n.isValidElement(r)) {
                var i;
                let e,
                  u,
                  s =
                    ((i = r),
                    (u =
                      (e = Object.getOwnPropertyDescriptor(i.props, "ref")?.get) &&
                      "isReactWarning" in e &&
                      e.isReactWarning)
                      ? i.ref
                      : (u =
                            (e = Object.getOwnPropertyDescriptor(i, "ref")?.get) &&
                            "isReactWarning" in e &&
                            e.isReactWarning)
                        ? i.props.ref
                        : i.props.ref || i.ref),
                  l = (function (e, t) {
                    let r = { ...t };
                    for (let n in t) {
                      let o = e[n],
                        i = t[n];
                      /^on[A-Z]/.test(n)
                        ? o && i
                          ? (r[n] = (...e) => {
                              let t = i(...e);
                              return (o(...e), t);
                            })
                          : o && (r[n] = o)
                        : "style" === n
                          ? (r[n] = { ...o, ...i })
                          : "className" === n && (r[n] = [o, i].filter(Boolean).join(" "));
                    }
                    return { ...e, ...r };
                  })(o, r.props);
                return (
                  r.type !== n.Fragment && (l.ref = t ? (0, a.t)(t, s) : s), n.cloneElement(r, l)
                );
              }
              return n.Children.count(r) > 1 ? n.Children.only(null) : null;
            });
            return ((t.displayName = `${e}.SlotClone`), t);
          })(e),
          r = n.forwardRef((e, r) => {
            let { children: o, ...i } = e,
              u = n.Children.toArray(o),
              a = u.find(f);
            if (a) {
              let e = a.props.children,
                o = u.map((t) =>
                  t !== a
                    ? t
                    : n.Children.count(e) > 1
                      ? n.Children.only(null)
                      : n.isValidElement(e)
                        ? e.props.children
                        : null,
                );
              return (0, s.jsx)(t, {
                ...i,
                ref: r,
                children: n.isValidElement(e) ? n.cloneElement(e, void 0, o) : null,
              });
            }
            return (0, s.jsx)(t, { ...i, ref: r, children: o });
          });
        return ((r.displayName = `${e}.Slot`), r);
      }
      var c = Symbol("radix.slottable");
      function f(e) {
        return (
          n.isValidElement(e) &&
          "function" == typeof e.type &&
          "__radixId" in e.type &&
          e.type.__radixId === c
        );
      }
      function d(e) {
        let t = e + "CollectionProvider",
          [r, o] = (0, i.A)(t),
          [u, c] = r(t, { collectionRef: { current: null }, itemMap: new Map() }),
          f = (e) => {
            let { scope: t, children: r } = e,
              o = n.useRef(null),
              i = n.useRef(new Map()).current;
            return (0, s.jsx)(u, { scope: t, itemMap: i, collectionRef: o, children: r });
          };
        f.displayName = t;
        let d = e + "CollectionSlot",
          p = l(d),
          h = n.forwardRef((e, t) => {
            let { scope: r, children: n } = e,
              o = c(d, r),
              i = (0, a.s)(t, o.collectionRef);
            return (0, s.jsx)(p, { ref: i, children: n });
          });
        h.displayName = d;
        let m = e + "CollectionItemSlot",
          x = "data-radix-collection-item",
          v = l(m),
          g = n.forwardRef((e, t) => {
            let { scope: r, children: o, ...i } = e,
              u = n.useRef(null),
              l = (0, a.s)(t, u),
              f = c(m, r);
            return (
              n.useEffect(
                () => (f.itemMap.set(u, { ref: u, ...i }), () => void f.itemMap.delete(u)),
              ),
              (0, s.jsx)(v, {
                [x]: "",
                ref: l,
                children: o,
              })
            );
          });
        return (
          (g.displayName = m),
          [
            { Provider: f, Slot: h, ItemSlot: g },
            function (t) {
              let r = c(e + "CollectionConsumer", t);
              return n.useCallback(() => {
                let e = r.collectionRef.current;
                if (!e) {
                  return [];
                }
                let t = Array.from(e.querySelectorAll(`[${x}]`));
                return Array.from(r.itemMap.values()).toSorted(
                  (e, r) => t.indexOf(e.ref.current) - t.indexOf(r.ref.current),
                );
              }, [r.collectionRef, r.itemMap]);
            },
            o,
          ]
        );
      }
      var p = new WeakMap();
      function h(e, t) {
        if ("at" in Array.prototype) {
          return Array.prototype.at.call(e, t);
        }
        let r = (function (e, t) {
          let r = e.length,
            n = m(t),
            o = n >= 0 ? n : r + n;
          return o < 0 || o >= r ? -1 : o;
        })(e, t);
        return -1 === r ? void 0 : e[r];
      }
      function m(e) {
        return e != e || 0 === e ? 0 : Math.trunc(e);
      }
      (class e extends Map {
        #e;
        constructor(e) {
          (super(e), (this.#e = [...super.keys()]), p.set(this, !0));
        }
        set(e, t) {
          return (
            p.get(this) && (this.has(e) ? (this.#e[this.#e.indexOf(e)] = e) : this.#e.push(e)),
            super.set(e, t),
            this
          );
        }
        insert(e, t, r) {
          let n,
            o = this.has(t),
            i = this.#e.length,
            u = m(e),
            a = u >= 0 ? u : i + u,
            s = a < 0 || a >= i ? -1 : a;
          if (s === this.size || (o && s === this.size - 1) || -1 === s) {
            return (this.set(t, r), this);
          }
          let l = this.size + +!o;
          u < 0 && a++;
          let c = [...this.#e],
            f = !1;
          for (let e = a; e < l; e++) {
            if (a === e) {
              let i = c[e];
              (c[e] === t && (i = c[e + 1]),
                o && this.delete(t),
                (n = this.get(i)),
                this.set(t, r));
            } else {
              f || c[e - 1] !== t || (f = !0);
              let r = c[f ? e : e - 1],
                o = n;
              ((n = this.get(r)), this.delete(r), this.set(r, o));
            }
          }
          return this;
        }
        with(t, r, n) {
          let o = new e(this);
          return (o.insert(t, r, n), o);
        }
        before(e) {
          let t = this.#e.indexOf(e) - 1;
          if (!(t < 0)) {
            return this.entryAt(t);
          }
        }
        setBefore(e, t, r) {
          let n = this.#e.indexOf(e);
          return -1 === n ? this : this.insert(n, t, r);
        }
        after(e) {
          let t = this.#e.indexOf(e);
          if (-1 !== (t = -1 === t || t === this.size - 1 ? -1 : t + 1)) {
            return this.entryAt(t);
          }
        }
        setAfter(e, t, r) {
          let n = this.#e.indexOf(e);
          return -1 === n ? this : this.insert(n + 1, t, r);
        }
        first() {
          return this.entryAt(0);
        }
        last() {
          return this.entryAt(-1);
        }
        clear() {
          return ((this.#e = []), super.clear());
        }
        delete(e) {
          let t = super.delete(e);
          return (t && this.#e.splice(this.#e.indexOf(e), 1), t);
        }
        deleteAt(e) {
          let t = this.keyAt(e);
          return void 0 !== t && this.delete(t);
        }
        at(e) {
          let t = h(this.#e, e);
          if (void 0 !== t) {
            return this.get(t);
          }
        }
        entryAt(e) {
          let t = h(this.#e, e);
          if (void 0 !== t) {
            return [t, this.get(t)];
          }
        }
        indexOf(e) {
          return this.#e.indexOf(e);
        }
        keyAt(e) {
          return h(this.#e, e);
        }
        from(e, t) {
          let r = this.indexOf(e);
          if (-1 === r) {
            return;
          }
          let n = r + t;
          return (n < 0 && (n = 0), n >= this.size && (n = this.size - 1), this.at(n));
        }
        keyFrom(e, t) {
          let r = this.indexOf(e);
          if (-1 === r) {
            return;
          }
          let n = r + t;
          return (n < 0 && (n = 0), n >= this.size && (n = this.size - 1), this.keyAt(n));
        }
        find(e, t) {
          let r = 0;
          for (let n of this) {
            if (Reflect.apply(e, t, [n, r, this])) {
              return n;
            }
            r++;
          }
        }
        findIndex(e, t) {
          let r = 0;
          for (let n of this) {
            if (Reflect.apply(e, t, [n, r, this])) {
              return r;
            }
            r++;
          }
          return -1;
        }
        filter(t, r) {
          let n = [],
            o = 0;
          for (let e of this) {
            (Reflect.apply(t, r, [e, o, this]) && n.push(e), o++);
          }
          return new e(n);
        }
        map(t, r) {
          let n = [],
            o = 0;
          for (let e of this) {
            (n.push([e[0], Reflect.apply(t, r, [e, o, this])]), o++);
          }
          return new e(n);
        }
        reduce(...e) {
          let [t, r] = e,
            n = 0,
            o = r ?? this.at(0);
          for (let r of this) {
            ((o = 0 === n && 1 === e.length ? r : Reflect.apply(t, this, [o, r, n, this])), n++);
          }
          return o;
        }
        reduceRight(...e) {
          let [t, r] = e,
            n = r ?? this.at(-1);
          for (let r = this.size - 1; r >= 0; r--) {
            let o = this.at(r);
            n = r === this.size - 1 && 1 === e.length ? o : Reflect.apply(t, this, [n, o, r, this]);
          }
          return n;
        }
        toSorted(t) {
          return new e([...this.entries()].toSorted(t));
        }
        toReversed() {
          let t = new e();
          for (let e = this.size - 1; e >= 0; e--) {
            let r = this.keyAt(e),
              n = this.get(r);
            t.set(r, n);
          }
          return t;
        }
        toSpliced(...t) {
          let r = [...this.entries()];
          return (r.splice(...t), new e(r));
        }
        slice(t, r) {
          let n = new e(),
            o = this.size - 1;
          if (void 0 === t) {
            return n;
          }
          (t < 0 && (t += this.size), void 0 !== r && r > 0 && (o = r - 1));
          for (let e = t; e <= o; e++) {
            let t = this.keyAt(e),
              r = this.get(t);
            n.set(t, r);
          }
          return n;
        }
        every(e, t) {
          let r = 0;
          for (let n of this) {
            if (!Reflect.apply(e, t, [n, r, this])) {
              return !1;
            }
            r++;
          }
          return !0;
        }
        some(e, t) {
          let r = 0;
          for (let n of this) {
            if (Reflect.apply(e, t, [n, r, this])) {
              return !0;
            }
            r++;
          }
          return !1;
        }
      });
      var x = n.createContext(void 0);
      function v(e) {
        let t = n.useContext(x);
        return e || t || "ltr";
      }
      var g = r(48966),
        y = r(26419),
        w = r(18249),
        b = r(1679),
        C = r(87237),
        R = r(14972),
        M = r(48787),
        _ = r(9111),
        k = r(54111),
        j = "rovingFocusGroup.onEntryFocus",
        A = { bubbles: !1, cancelable: !0 },
        E = "RovingFocusGroup",
        [P, I, O] = d(E),
        [S, D] = (0, i.A)(E, [O]),
        [K, T] = S(E),
        N = n.forwardRef((e, t) =>
          (0, s.jsx)(P.Provider, {
            scope: e.__scopeRovingFocusGroup,
            children: (0, s.jsx)(P.Slot, {
              scope: e.__scopeRovingFocusGroup,
              children: (0, s.jsx)(F, { ...e, ref: t }),
            }),
          }),
        );
      N.displayName = E;
      var F = n.forwardRef((e, t) => {
          let {
              __scopeRovingFocusGroup: r,
              orientation: i,
              loop: l = !1,
              dir: c,
              currentTabStopId: f,
              defaultCurrentTabStopId: d,
              onCurrentTabStopIdChange: p,
              onEntryFocus: h,
              preventScrollOnEntryFocus: m = !1,
              ...x
            } = e,
            g = n.useRef(null),
            y = (0, a.s)(t, g),
            w = v(c),
            [b, C] = (0, k.i)({ prop: f, defaultProp: d ?? null, onChange: p, caller: E }),
            [R, M] = n.useState(!1),
            P = (0, _.c)(h),
            O = I(r),
            S = n.useRef(!1),
            [D, T] = n.useState(0);
          return (
            n.useEffect(() => {
              let e = g.current;
              if (e) {
                return (e.addEventListener(j, P), () => e.removeEventListener(j, P));
              }
            }, [P]),
            (0, s.jsx)(K, {
              scope: r,
              orientation: i,
              dir: w,
              loop: l,
              currentTabStopId: b,
              onItemFocus: n.useCallback((e) => C(e), [C]),
              onItemShiftTab: n.useCallback(() => M(!0), []),
              onFocusableItemAdd: n.useCallback(() => T((e) => e + 1), []),
              onFocusableItemRemove: n.useCallback(() => T((e) => e - 1), []),
              children: (0, s.jsx)(u.sG.div, {
                tabIndex: R || 0 === D ? -1 : 0,
                "data-orientation": i,
                ...x,
                ref: y,
                style: { outline: "none", ...e.style },
                onMouseDown: (0, o.mK)(e.onMouseDown, () => {
                  S.current = !0;
                }),
                onFocus: (0, o.mK)(e.onFocus, (e) => {
                  let t = !S.current;
                  if (e.target === e.currentTarget && t && !R) {
                    let t = new CustomEvent(j, A);
                    if ((e.currentTarget.dispatchEvent(t), !t.defaultPrevented)) {
                      let e = O().filter((e) => e.focusable);
                      U(
                        [e.find((e) => e.active), e.find((e) => e.id === b), ...e]
                          .filter(Boolean)
                          .map((e) => e.ref.current),
                        m,
                      );
                    }
                  }
                  S.current = !1;
                }),
                onBlur: (0, o.mK)(e.onBlur, () => M(!1)),
              }),
            })
          );
        }),
        L = "RovingFocusGroupItem",
        z = n.forwardRef((e, t) => {
          let {
              __scopeRovingFocusGroup: r,
              focusable: i = !0,
              active: a = !1,
              tabStopId: l,
              children: c,
              ...f
            } = e,
            d = (0, b.B)(),
            p = l || d,
            h = T(L, r),
            m = h.currentTabStopId === p,
            x = I(r),
            { onFocusableItemAdd: v, onFocusableItemRemove: g, currentTabStopId: y } = h;
          return (
            n.useEffect(() => {
              if (i) {
                return (v(), () => g());
              }
            }, [i, v, g]),
            (0, s.jsx)(P.ItemSlot, {
              scope: r,
              id: p,
              focusable: i,
              active: a,
              children: (0, s.jsx)(u.sG.span, {
                tabIndex: m ? 0 : -1,
                "data-orientation": h.orientation,
                ...f,
                ref: t,
                onMouseDown: (0, o.mK)(e.onMouseDown, (e) => {
                  i ? h.onItemFocus(p) : e.preventDefault();
                }),
                onFocus: (0, o.mK)(e.onFocus, () => h.onItemFocus(p)),
                onKeyDown: (0, o.mK)(e.onKeyDown, (e) => {
                  if ("Tab" === e.key && e.shiftKey) {
                    return void h.onItemShiftTab();
                  }
                  if (e.target !== e.currentTarget) {
                    return;
                  }
                  let t = (function (e, t, r) {
                    var n;
                    let o =
                      ((n = e.key),
                      "rtl" !== r
                        ? n
                        : "ArrowLeft" === n
                          ? "ArrowRight"
                          : "ArrowRight" === n
                            ? "ArrowLeft"
                            : n);
                    if (
                      !("vertical" === t && ["ArrowLeft", "ArrowRight"].includes(o)) &&
                      !("horizontal" === t && ["ArrowUp", "ArrowDown"].includes(o))
                    ) {
                      return G[o];
                    }
                  })(e, h.orientation, h.dir);
                  if (void 0 !== t) {
                    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
                      return;
                    }
                    e.preventDefault();
                    let r = x()
                      .filter((e) => e.focusable)
                      .map((e) => e.ref.current);
                    if ("last" === t) {
                      r.reverse();
                    } else if ("prev" === t || "next" === t) {
                      "prev" === t && r.toReversed();
                      let n = r.indexOf(e.currentTarget);
                      r = h.loop
                        ? (function (e, t) {
                            return e.map((r, n) => e[(t + n) % e.length]);
                          })(r, n + 1)
                        : r.slice(n + 1);
                    }
                    setTimeout(() => U(r));
                  }
                }),
                children:
                  "function" == typeof c ? c({ isCurrentTabStop: m, hasTabStop: null != y }) : c,
              }),
            })
          );
        });
      z.displayName = L;
      var G = {
        ArrowLeft: "prev",
        ArrowUp: "prev",
        ArrowRight: "next",
        ArrowDown: "next",
        PageUp: "first",
        Home: "first",
        PageDown: "last",
        End: "last",
      };
      function U(e, t = !1) {
        let r = document.activeElement;
        for (let n of e) {
          if (n === r || (n.focus({ preventScroll: t }), document.activeElement !== r)) return;
        }
      }
      var V = Symbol("radix.slottable");
      function $(e) {
        return (
          n.isValidElement(e) &&
          "function" == typeof e.type &&
          "__radixId" in e.type &&
          e.type.__radixId === V
        );
      }
      var B = r(9702),
        Z = r(50580),
        W = ["Enter", " "],
        H = ["ArrowUp", "PageDown", "End"],
        X = ["ArrowDown", "PageUp", "Home", ...H],
        Y = { ltr: [...W, "ArrowRight"], rtl: [...W, "ArrowLeft"] },
        q = { ltr: ["ArrowLeft"], rtl: ["ArrowRight"] },
        J = "Menu",
        [Q, ee, et] = d(J),
        [er, en] = (0, i.A)(J, [et, C.Bk, D]),
        eo = (0, C.Bk)(),
        ei = D(),
        [eu, ea] = er(J),
        [es, el] = er(J),
        ec = (e) => {
          let {
              __scopeMenu: t,
              open: r = !1,
              children: o,
              dir: i,
              onOpenChange: u,
              modal: a = !0,
            } = e,
            l = eo(t),
            [c, f] = n.useState(null),
            d = n.useRef(!1),
            p = (0, _.c)(u),
            h = v(i);
          return (
            n.useEffect(() => {
              let e = () => {
                  ((d.current = !0),
                    document.addEventListener("pointerdown", t, { capture: !0, once: !0 }),
                    document.addEventListener("pointermove", t, { capture: !0, once: !0 }));
                },
                t = () => (d.current = !1);
              return (
                document.addEventListener("keydown", e, { capture: !0 }),
                () => {
                  (document.removeEventListener("keydown", e, { capture: !0 }),
                    document.removeEventListener("pointerdown", t, { capture: !0 }),
                    document.removeEventListener("pointermove", t, { capture: !0 }));
                }
              );
            }, []),
            (0, s.jsx)(C.bL, {
              ...l,
              children: (0, s.jsx)(eu, {
                scope: t,
                open: r,
                onOpenChange: p,
                content: c,
                onContentChange: f,
                children: (0, s.jsx)(es, {
                  scope: t,
                  onClose: n.useCallback(() => p(!1), [p]),
                  isUsingKeyboardRef: d,
                  dir: h,
                  modal: a,
                  children: o,
                }),
              }),
            })
          );
        };
      ec.displayName = J;
      var ef = n.forwardRef((e, t) => {
        let { __scopeMenu: r, ...n } = e,
          o = eo(r);
        return (0, s.jsx)(C.Mz, { ...o, ...n, ref: t });
      });
      ef.displayName = "MenuAnchor";
      var ed = "MenuPortal",
        [ep, eh] = er(ed, { forceMount: void 0 }),
        em = (e) => {
          let { __scopeMenu: t, forceMount: r, children: n, container: o } = e,
            i = ea(ed, t);
          return (0, s.jsx)(ep, {
            scope: t,
            forceMount: r,
            children: (0, s.jsx)(M.C, {
              present: r || i.open,
              children: (0, s.jsx)(R.Z, { asChild: !0, container: o, children: n }),
            }),
          });
        };
      em.displayName = ed;
      var ex = "MenuContent",
        [ev, eg] = er(ex),
        ey = n.forwardRef((e, t) => {
          let r = eh(ex, e.__scopeMenu),
            { forceMount: n = r.forceMount, ...o } = e,
            i = ea(ex, e.__scopeMenu),
            u = el(ex, e.__scopeMenu);
          return (0, s.jsx)(Q.Provider, {
            scope: e.__scopeMenu,
            children: (0, s.jsx)(M.C, {
              present: n || i.open,
              children: (0, s.jsx)(Q.Slot, {
                scope: e.__scopeMenu,
                children: u.modal
                  ? (0, s.jsx)(ew, { ...o, ref: t })
                  : (0, s.jsx)(eb, { ...o, ref: t }),
              }),
            }),
          });
        }),
        ew = n.forwardRef((e, t) => {
          let r = ea(ex, e.__scopeMenu),
            i = n.useRef(null),
            u = (0, a.s)(t, i);
          return (
            n.useEffect(() => {
              let e = i.current;
              if (e) {
                return (0, B.Eq)(e);
              }
            }, []),
            (0, s.jsx)(eR, {
              ...e,
              ref: u,
              trapFocus: r.open,
              disableOutsidePointerEvents: r.open,
              disableOutsideScroll: !0,
              onFocusOutside: (0, o.mK)(e.onFocusOutside, (e) => e.preventDefault(), {
                checkForDefaultPrevented: !1,
              }),
              onDismiss: () => r.onOpenChange(!1),
            })
          );
        }),
        eb = n.forwardRef((e, t) => {
          let r = ea(ex, e.__scopeMenu);
          return (0, s.jsx)(eR, {
            ...e,
            ref: t,
            trapFocus: !1,
            disableOutsidePointerEvents: !1,
            disableOutsideScroll: !1,
            onDismiss: () => r.onOpenChange(!1),
          });
        }),
        eC = (function (e) {
          let t = (function (e) {
              let t = n.forwardRef((e, t) => {
                let { children: r, ...o } = e;
                if (n.isValidElement(r)) {
                  var i;
                  let e,
                    u,
                    s =
                      ((i = r),
                      (u =
                        (e = Object.getOwnPropertyDescriptor(i.props, "ref")?.get) &&
                        "isReactWarning" in e &&
                        e.isReactWarning)
                        ? i.ref
                        : (u =
                              (e = Object.getOwnPropertyDescriptor(i, "ref")?.get) &&
                              "isReactWarning" in e &&
                              e.isReactWarning)
                          ? i.props.ref
                          : i.props.ref || i.ref),
                    l = (function (e, t) {
                      let r = { ...t };
                      for (let n in t) {
                        let o = e[n],
                          i = t[n];
                        /^on[A-Z]/.test(n)
                          ? o && i
                            ? (r[n] = (...e) => {
                                let t = i(...e);
                                return (o(...e), t);
                              })
                            : o && (r[n] = o)
                          : "style" === n
                            ? (r[n] = { ...o, ...i })
                            : "className" === n && (r[n] = [o, i].filter(Boolean).join(" "));
                      }
                      return { ...e, ...r };
                    })(o, r.props);
                  return (
                    r.type !== n.Fragment && (l.ref = t ? (0, a.t)(t, s) : s), n.cloneElement(r, l)
                  );
                }
                return n.Children.count(r) > 1 ? n.Children.only(null) : null;
              });
              return ((t.displayName = `${e}.SlotClone`), t);
            })(e),
            r = n.forwardRef((e, r) => {
              let { children: o, ...i } = e,
                u = n.Children.toArray(o),
                a = u.find($);
              if (a) {
                let e = a.props.children,
                  o = u.map((t) =>
                    t !== a
                      ? t
                      : n.Children.count(e) > 1
                        ? n.Children.only(null)
                        : n.isValidElement(e)
                          ? e.props.children
                          : null,
                  );
                return (0, s.jsx)(t, {
                  ...i,
                  ref: r,
                  children: n.isValidElement(e) ? n.cloneElement(e, void 0, o) : null,
                });
              }
              return (0, s.jsx)(t, { ...i, ref: r, children: o });
            });
          return ((r.displayName = `${e}.Slot`), r);
        })("MenuContent.ScrollLock"),
        eR = n.forwardRef((e, t) => {
          let {
              __scopeMenu: r,
              loop: i = !1,
              trapFocus: u,
              onOpenAutoFocus: l,
              onCloseAutoFocus: c,
              disableOutsidePointerEvents: f,
              onEntryFocus: d,
              onEscapeKeyDown: p,
              onPointerDownOutside: h,
              onFocusOutside: m,
              onInteractOutside: x,
              onDismiss: v,
              disableOutsideScroll: b,
              ...R
            } = e,
            M = ea(ex, r),
            _ = el(ex, r),
            k = eo(r),
            j = ei(r),
            A = ee(r),
            [E, P] = n.useState(null),
            I = n.useRef(null),
            O = (0, a.s)(t, I, M.onContentChange),
            S = n.useRef(0),
            D = n.useRef(""),
            K = n.useRef(0),
            T = n.useRef(null),
            F = n.useRef("right"),
            L = n.useRef(0),
            z = b ? Z.A : n.Fragment;
          (n.useEffect(() => () => window.clearTimeout(S.current), []), (0, y.Oh)());
          let G = n.useCallback(
            (e) =>
              F.current === T.current?.side &&
              (function (e, t) {
                return (
                  !!t &&
                  (function (e, t) {
                    let { x: r, y: n } = e,
                      o = !1;
                    for (let e = 0, i = t.length - 1; e < t.length; i = e++) {
                      let u = t[e],
                        a = t[i],
                        s = u.x,
                        l = u.y,
                        c = a.x,
                        f = a.y;
                      l > n != f > n && r < ((c - s) * (n - l)) / (f - l) + s && (o = !o);
                    }
                    return o;
                  })({ x: e.clientX, y: e.clientY }, t)
                );
              })(e, T.current?.area),
            [],
          );
          return (0, s.jsx)(ev, {
            scope: r,
            searchRef: D,
            onItemEnter: n.useCallback(
              (e) => {
                G(e) && e.preventDefault();
              },
              [G],
            ),
            onItemLeave: n.useCallback(
              (e) => {
                G(e) || (I.current?.focus(), P(null));
              },
              [G],
            ),
            onTriggerLeave: n.useCallback(
              (e) => {
                G(e) && e.preventDefault();
              },
              [G],
            ),
            pointerGraceTimerRef: K,
            onPointerGraceIntentChange: n.useCallback((e) => {
              T.current = e;
            }, []),
            children: (0, s.jsx)(z, {
              ...(b ? { as: eC, allowPinchZoom: !0 } : void 0),
              children: (0, s.jsx)(w.n, {
                asChild: !0,
                trapped: u,
                onMountAutoFocus: (0, o.mK)(l, (e) => {
                  (e.preventDefault(), I.current?.focus({ preventScroll: !0 }));
                }),
                onUnmountAutoFocus: c,
                children: (0, s.jsx)(g.qW, {
                  asChild: !0,
                  disableOutsidePointerEvents: f,
                  onEscapeKeyDown: p,
                  onPointerDownOutside: h,
                  onFocusOutside: m,
                  onInteractOutside: x,
                  onDismiss: v,
                  children: (0, s.jsx)(N, {
                    asChild: !0,
                    ...j,
                    dir: _.dir,
                    orientation: "vertical",
                    loop: i,
                    currentTabStopId: E,
                    onCurrentTabStopIdChange: P,
                    onEntryFocus: (0, o.mK)(d, (e) => {
                      _.isUsingKeyboardRef.current || e.preventDefault();
                    }),
                    preventScrollOnEntryFocus: !0,
                    children: (0, s.jsx)(C.UC, {
                      role: "menu",
                      "aria-orientation": "vertical",
                      "data-state": eY(M.open),
                      "data-radix-menu-content": "",
                      dir: _.dir,
                      ...k,
                      ...R,
                      ref: O,
                      style: { outline: "none", ...R.style },
                      onKeyDown: (0, o.mK)(R.onKeyDown, (e) => {
                        let t = e.target.closest("[data-radix-menu-content]") === e.currentTarget,
                          r = e.ctrlKey || e.altKey || e.metaKey,
                          n = 1 === e.key.length;
                        t &&
                          ("Tab" === e.key && e.preventDefault(),
                          !r &&
                            n &&
                            ((e) => {
                              let t = D.current + e,
                                r = A().filter((e) => !e.disabled),
                                n = document.activeElement,
                                o = r.find((e) => e.ref.current === n)?.textValue,
                                i = (function (e, t, r) {
                                  var n;
                                  let o =
                                      t.length > 1 && Array.from(t).every((e) => e === t[0])
                                        ? t[0]
                                        : t,
                                    i = r ? e.indexOf(r) : -1,
                                    u =
                                      ((n = Math.max(i, 0)),
                                      e.map((t, r) => e[(n + r) % e.length]));
                                  1 === o.length && (u = u.filter((e) => e !== r));
                                  let a = u.find((e) =>
                                    e.toLowerCase().startsWith(o.toLowerCase()),
                                  );
                                  return a !== r ? a : void 0;
                                })(
                                  r.map((e) => e.textValue),
                                  t,
                                  o,
                                ),
                                u = r.find((e) => e.textValue === i)?.ref.current;
                              (!(function e(t) {
                                ((D.current = t),
                                  window.clearTimeout(S.current),
                                  "" !== t && (S.current = window.setTimeout(() => e(""), 1e3)));
                              })(t),
                                u && setTimeout(() => u.focus()));
                            })(e.key));
                        let o = I.current;
                        if (e.target !== o || !X.includes(e.key)) {
                          return;
                        }
                        e.preventDefault();
                        let i = A()
                          .filter((e) => !e.disabled)
                          .map((e) => e.ref.current);
                        (H.includes(e.key) && i.toReversed(),
                          (function (e) {
                            let t = document.activeElement;
                            for (let r of e) {
                              if (r === t || (r.focus(), document.activeElement !== t)) return;
                            }
                          })(i));
                      }),
                      onBlur: (0, o.mK)(e.onBlur, (e) => {
                        e.currentTarget.contains(e.target) ||
                          (window.clearTimeout(S.current), (D.current = ""));
                      }),
                      onPointerMove: (0, o.mK)(
                        e.onPointerMove,
                        eQ((e) => {
                          let t = e.target,
                            r = L.current !== e.clientX;
                          e.currentTarget.contains(t) &&
                            r &&
                            ((F.current = e.clientX > L.current ? "right" : "left"),
                            (L.current = e.clientX));
                        }),
                      ),
                    }),
                  }),
                }),
              }),
            }),
          });
        });
      ey.displayName = ex;
      var eM = n.forwardRef((e, t) => {
        let { __scopeMenu: r, ...n } = e;
        return (0, s.jsx)(u.sG.div, { role: "group", ...n, ref: t });
      });
      eM.displayName = "MenuGroup";
      var e_ = n.forwardRef((e, t) => {
        let { __scopeMenu: r, ...n } = e;
        return (0, s.jsx)(u.sG.div, { ...n, ref: t });
      });
      e_.displayName = "MenuLabel";
      var ek = "MenuItem",
        ej = "menu.itemSelect",
        eA = n.forwardRef((e, t) => {
          let { disabled: r = !1, onSelect: i, ...l } = e,
            c = n.useRef(null),
            f = el(ek, e.__scopeMenu),
            d = eg(ek, e.__scopeMenu),
            p = (0, a.s)(t, c),
            h = n.useRef(!1);
          return (0, s.jsx)(eE, {
            ...l,
            ref: p,
            disabled: r,
            onClick: (0, o.mK)(e.onClick, () => {
              let e = c.current;
              if (!r && e) {
                let t = new CustomEvent(ej, { bubbles: !0, cancelable: !0 });
                (e.addEventListener(ej, (e) => i?.(e), { once: !0 }),
                  (0, u.hO)(e, t),
                  t.defaultPrevented ? (h.current = !1) : f.onClose());
              }
            }),
            onPointerDown: (t) => {
              (e.onPointerDown?.(t), (h.current = !0));
            },
            onPointerUp: (0, o.mK)(e.onPointerUp, (e) => {
              h.current || e.currentTarget?.click();
            }),
            onKeyDown: (0, o.mK)(e.onKeyDown, (e) => {
              let t = "" !== d.searchRef.current;
              r ||
                (t && " " === e.key) ||
                (W.includes(e.key) && (e.currentTarget.click(), e.preventDefault()));
            }),
          });
        });
      eA.displayName = ek;
      var eE = n.forwardRef((e, t) => {
          let { __scopeMenu: r, disabled: i = !1, textValue: l, ...c } = e,
            f = eg(ek, r),
            d = ei(r),
            p = n.useRef(null),
            h = (0, a.s)(t, p),
            [m, x] = n.useState(!1),
            [v, g] = n.useState("");
          return (
            n.useEffect(() => {
              let e = p.current;
              e && g((e.textContent ?? "").trim());
            }, [c.children]),
            (0, s.jsx)(Q.ItemSlot, {
              scope: r,
              disabled: i,
              textValue: l ?? v,
              children: (0, s.jsx)(z, {
                asChild: !0,
                ...d,
                focusable: !i,
                children: (0, s.jsx)(u.sG.div, {
                  role: "menuitem",
                  "data-highlighted": m ? "" : void 0,
                  "aria-disabled": i || void 0,
                  "data-disabled": i ? "" : void 0,
                  ...c,
                  ref: h,
                  onPointerMove: (0, o.mK)(
                    e.onPointerMove,
                    eQ((e) => {
                      i
                        ? f.onItemLeave(e)
                        : (f.onItemEnter(e),
                          e.defaultPrevented || e.currentTarget.focus({ preventScroll: !0 }));
                    }),
                  ),
                  onPointerLeave: (0, o.mK)(
                    e.onPointerLeave,
                    eQ((e) => f.onItemLeave(e)),
                  ),
                  onFocus: (0, o.mK)(e.onFocus, () => x(!0)),
                  onBlur: (0, o.mK)(e.onBlur, () => x(!1)),
                }),
              }),
            })
          );
        }),
        eP = n.forwardRef((e, t) => {
          let { checked: r = !1, onCheckedChange: n, ...i } = e;
          return (0, s.jsx)(eF, {
            scope: e.__scopeMenu,
            checked: r,
            children: (0, s.jsx)(eA, {
              role: "menuitemcheckbox",
              "aria-checked": eq(r) ? "mixed" : r,
              ...i,
              ref: t,
              "data-state": eJ(r),
              onSelect: (0, o.mK)(i.onSelect, () => n?.(!!eq(r) || !r), {
                checkForDefaultPrevented: !1,
              }),
            }),
          });
        });
      eP.displayName = "MenuCheckboxItem";
      var eI = "MenuRadioGroup",
        [eO, eS] = er(eI, { value: void 0, onValueChange: () => {} }),
        eD = n.forwardRef((e, t) => {
          let { value: r, onValueChange: n, ...o } = e,
            i = (0, _.c)(n);
          return (0, s.jsx)(eO, {
            scope: e.__scopeMenu,
            value: r,
            onValueChange: i,
            children: (0, s.jsx)(eM, { ...o, ref: t }),
          });
        });
      eD.displayName = eI;
      var eK = "MenuRadioItem",
        eT = n.forwardRef((e, t) => {
          let { value: r, ...n } = e,
            i = eS(eK, e.__scopeMenu),
            u = r === i.value;
          return (0, s.jsx)(eF, {
            scope: e.__scopeMenu,
            checked: u,
            children: (0, s.jsx)(eA, {
              role: "menuitemradio",
              "aria-checked": u,
              ...n,
              ref: t,
              "data-state": eJ(u),
              onSelect: (0, o.mK)(n.onSelect, () => i.onValueChange?.(r), {
                checkForDefaultPrevented: !1,
              }),
            }),
          });
        });
      eT.displayName = eK;
      var eN = "MenuItemIndicator",
        [eF, eL] = er(eN, { checked: !1 }),
        ez = n.forwardRef((e, t) => {
          let { __scopeMenu: r, forceMount: n, ...o } = e,
            i = eL(eN, r);
          return (0, s.jsx)(M.C, {
            present: n || eq(i.checked) || !0 === i.checked,
            children: (0, s.jsx)(u.sG.span, { ...o, ref: t, "data-state": eJ(i.checked) }),
          });
        });
      ez.displayName = eN;
      var eG = n.forwardRef((e, t) => {
        let { __scopeMenu: r, ...n } = e;
        return (0, s.jsx)(u.sG.div, {
          role: "separator",
          "aria-orientation": "horizontal",
          ...n,
          ref: t,
        });
      });
      eG.displayName = "MenuSeparator";
      var eU = n.forwardRef((e, t) => {
        let { __scopeMenu: r, ...n } = e,
          o = eo(r);
        return (0, s.jsx)(C.i3, { ...o, ...n, ref: t });
      });
      eU.displayName = "MenuArrow";
      var eV = "MenuSub",
        [e$, eB] = er(eV);
      var eZ = "MenuSubTrigger",
        eW = n.forwardRef((e, t) => {
          let r = ea(eZ, e.__scopeMenu),
            i = el(eZ, e.__scopeMenu),
            u = eB(eZ, e.__scopeMenu),
            l = eg(eZ, e.__scopeMenu),
            c = n.useRef(null),
            { pointerGraceTimerRef: f, onPointerGraceIntentChange: d } = l,
            p = { __scopeMenu: e.__scopeMenu },
            h = n.useCallback(() => {
              (c.current && window.clearTimeout(c.current), (c.current = null));
            }, []);
          return (
            n.useEffect(() => h, [h]),
            n.useEffect(() => {
              let e = f.current;
              return () => {
                (window.clearTimeout(e), d(null));
              };
            }, [f, d]),
            (0, s.jsx)(ef, {
              asChild: !0,
              ...p,
              children: (0, s.jsx)(eE, {
                id: u.triggerId,
                "aria-haspopup": "menu",
                "aria-expanded": r.open,
                "aria-controls": u.contentId,
                "data-state": eY(r.open),
                ...e,
                ref: (0, a.t)(t, u.onTriggerChange),
                onClick: (t) => {
                  (e.onClick?.(t),
                    e.disabled ||
                      t.defaultPrevented ||
                      (t.currentTarget.focus(), r.open || r.onOpenChange(!0)));
                },
                onPointerMove: (0, o.mK)(
                  e.onPointerMove,
                  eQ((t) => {
                    (l.onItemEnter(t),
                      !t.defaultPrevented &&
                        (e.disabled ||
                          r.open ||
                          c.current ||
                          (l.onPointerGraceIntentChange(null),
                          (c.current = window.setTimeout(() => {
                            (r.onOpenChange(!0), h());
                          }, 100)))));
                  }),
                ),
                onPointerLeave: (0, o.mK)(
                  e.onPointerLeave,
                  eQ((e) => {
                    h();
                    let t = r.content?.getBoundingClientRect();
                    if (t) {
                      let n = r.content?.dataset.side,
                        o = "right" === n,
                        i = t[o ? "left" : "right"],
                        u = t[o ? "right" : "left"];
                      (l.onPointerGraceIntentChange({
                        area: [
                          { x: e.clientX + (o ? -5 : 5), y: e.clientY },
                          { x: i, y: t.top },
                          { x: u, y: t.top },
                          { x: u, y: t.bottom },
                          { x: i, y: t.bottom },
                        ],
                        side: n,
                      }),
                        window.clearTimeout(f.current),
                        (f.current = window.setTimeout(
                          () => l.onPointerGraceIntentChange(null),
                          300,
                        )));
                    } else {
                      if ((l.onTriggerLeave(e), e.defaultPrevented)) {
                        return;
                      }
                      l.onPointerGraceIntentChange(null);
                    }
                  }),
                ),
                onKeyDown: (0, o.mK)(e.onKeyDown, (t) => {
                  let n = "" !== l.searchRef.current;
                  e.disabled ||
                    (n && " " === t.key) ||
                    (Y[i.dir].includes(t.key) &&
                      (r.onOpenChange(!0), r.content?.focus(), t.preventDefault()));
                }),
              }),
            })
          );
        });
      eW.displayName = eZ;
      var eH = "MenuSubContent",
        eX = n.forwardRef((e, t) => {
          let r = eh(ex, e.__scopeMenu),
            { forceMount: i = r.forceMount, ...u } = e,
            l = ea(ex, e.__scopeMenu),
            c = el(ex, e.__scopeMenu),
            f = eB(eH, e.__scopeMenu),
            d = n.useRef(null),
            p = (0, a.s)(t, d);
          return (0, s.jsx)(Q.Provider, {
            scope: e.__scopeMenu,
            children: (0, s.jsx)(M.C, {
              present: i || l.open,
              children: (0, s.jsx)(Q.Slot, {
                scope: e.__scopeMenu,
                children: (0, s.jsx)(eR, {
                  id: f.contentId,
                  "aria-labelledby": f.triggerId,
                  ...u,
                  ref: p,
                  align: "start",
                  side: "rtl" === c.dir ? "left" : "right",
                  disableOutsidePointerEvents: !1,
                  disableOutsideScroll: !1,
                  trapFocus: !1,
                  onOpenAutoFocus: (e) => {
                    (c.isUsingKeyboardRef.current && d.current?.focus(), e.preventDefault());
                  },
                  onCloseAutoFocus: (e) => e.preventDefault(),
                  onFocusOutside: (0, o.mK)(e.onFocusOutside, (e) => {
                    e.target !== f.trigger && l.onOpenChange(!1);
                  }),
                  onEscapeKeyDown: (0, o.mK)(e.onEscapeKeyDown, (e) => {
                    (c.onClose(), e.preventDefault());
                  }),
                  onKeyDown: (0, o.mK)(e.onKeyDown, (e) => {
                    let t = e.currentTarget.contains(e.target),
                      r = q[c.dir].includes(e.key);
                    t && r && (l.onOpenChange(!1), f.trigger?.focus(), e.preventDefault());
                  }),
                }),
              }),
            }),
          });
        });
      function eY(e) {
        return e ? "open" : "closed";
      }
      function eq(e) {
        return "indeterminate" === e;
      }
      function eJ(e) {
        return eq(e) ? "indeterminate" : e ? "checked" : "unchecked";
      }
      function eQ(e) {
        return (t) => ("mouse" === t.pointerType ? e(t) : void 0);
      }
      eX.displayName = eH;
      var e0 = "ContextMenu",
        [e1, e2] = (0, i.A)(e0, [en]),
        e8 = en(),
        [e3, e9] = e1(e0),
        e7 = (e) => {
          let { __scopeContextMenu: t, children: r, onOpenChange: o, dir: i, modal: u = !0 } = e,
            [a, l] = n.useState(!1),
            c = e8(t),
            f = (0, _.c)(o),
            d = n.useCallback(
              (e) => {
                (l(e), f(e));
              },
              [f],
            );
          return (0, s.jsx)(e3, {
            scope: t,
            open: a,
            onOpenChange: d,
            modal: u,
            children: (0, s.jsx)(ec, {
              ...c,
              dir: i,
              open: a,
              onOpenChange: d,
              modal: u,
              children: r,
            }),
          });
        };
      e7.displayName = e0;
      var e5 = "ContextMenuTrigger",
        e6 = n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, disabled: i = !1, ...a } = e,
            l = e9(e5, r),
            c = e8(r),
            f = n.useRef({ x: 0, y: 0 }),
            d = n.useRef({
              getBoundingClientRect: () => DOMRect.fromRect({ width: 0, height: 0, ...f.current }),
            }),
            p = n.useRef(0),
            h = n.useCallback(() => window.clearTimeout(p.current), []),
            m = (e) => {
              ((f.current = { x: e.clientX, y: e.clientY }), l.onOpenChange(!0));
            };
          return (
            n.useEffect(() => h, [h]),
            n.useEffect(() => void (i && h()), [i, h]),
            (0, s.jsxs)(s.Fragment, {
              children: [
                (0, s.jsx)(ef, { ...c, virtualRef: d }),
                (0, s.jsx)(u.sG.span, {
                  "data-state": l.open ? "open" : "closed",
                  "data-disabled": i ? "" : void 0,
                  ...a,
                  ref: t,
                  style: { WebkitTouchCallout: "none", ...e.style },
                  onContextMenu: i
                    ? e.onContextMenu
                    : (0, o.mK)(e.onContextMenu, (e) => {
                        (h(), m(e), e.preventDefault());
                      }),
                  onPointerDown: i
                    ? e.onPointerDown
                    : (0, o.mK)(
                        e.onPointerDown,
                        tn((e) => {
                          (h(), (p.current = window.setTimeout(() => m(e), 700)));
                        }),
                      ),
                  onPointerMove: i ? e.onPointerMove : (0, o.mK)(e.onPointerMove, tn(h)),
                  onPointerCancel: i ? e.onPointerCancel : (0, o.mK)(e.onPointerCancel, tn(h)),
                  onPointerUp: i ? e.onPointerUp : (0, o.mK)(e.onPointerUp, tn(h)),
                }),
              ],
            })
          );
        });
      e6.displayName = e5;
      var e4 = (e) => {
        let { __scopeContextMenu: t, ...r } = e,
          n = e8(t);
        return (0, s.jsx)(em, { ...n, ...r });
      };
      e4.displayName = "ContextMenuPortal";
      var te = "ContextMenuContent",
        tt = n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...o } = e,
            i = e9(te, r),
            u = e8(r),
            a = n.useRef(!1);
          return (0, s.jsx)(ey, {
            ...u,
            ...o,
            ref: t,
            side: "right",
            sideOffset: 2,
            align: "start",
            onCloseAutoFocus: (t) => {
              (e.onCloseAutoFocus?.(t),
                !t.defaultPrevented && a.current && t.preventDefault(),
                (a.current = !1));
            },
            onInteractOutside: (t) => {
              (e.onInteractOutside?.(t), t.defaultPrevented || i.modal || (a.current = !0));
            },
            style: {
              ...e.style,
              "--radix-context-menu-content-transform-origin":
                "var(--radix-popper-transform-origin)",
              "--radix-context-menu-content-available-width": "var(--radix-popper-available-width)",
              "--radix-context-menu-content-available-height":
                "var(--radix-popper-available-height)",
              "--radix-context-menu-trigger-width": "var(--radix-popper-anchor-width)",
              "--radix-context-menu-trigger-height": "var(--radix-popper-anchor-height)",
            },
          });
        });
      ((tt.displayName = te),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eM, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuGroup"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(e_, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuLabel"));
      var tr = n.forwardRef((e, t) => {
        let { __scopeContextMenu: r, ...n } = e,
          o = e8(r);
        return (0, s.jsx)(eA, { ...o, ...n, ref: t });
      });
      ((tr.displayName = "ContextMenuItem"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eP, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuCheckboxItem"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eD, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuRadioGroup"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eT, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuRadioItem"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(ez, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuItemIndicator"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eG, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuSeparator"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eU, { ...o, ...n, ref: t });
        }).displayName = "ContextMenuArrow"));
      function tn(e) {
        return (t) => ("mouse" !== t.pointerType ? e(t) : void 0);
      }
      ((n.forwardRef((e, t) => {
        let { __scopeContextMenu: r, ...n } = e,
          o = e8(r);
        return (0, s.jsx)(eW, { ...o, ...n, ref: t });
      }).displayName = "ContextMenuSubTrigger"),
        (n.forwardRef((e, t) => {
          let { __scopeContextMenu: r, ...n } = e,
            o = e8(r);
          return (0, s.jsx)(eX, {
            ...o,
            ...n,
            ref: t,
            style: {
              ...e.style,
              "--radix-context-menu-content-transform-origin":
                "var(--radix-popper-transform-origin)",
              "--radix-context-menu-content-available-width": "var(--radix-popper-available-width)",
              "--radix-context-menu-content-available-height":
                "var(--radix-popper-available-height)",
              "--radix-context-menu-trigger-width": "var(--radix-popper-anchor-width)",
              "--radix-context-menu-trigger-height": "var(--radix-popper-anchor-height)",
            },
          });
        }).displayName = "ContextMenuSubContent"));
    },
    60292: (e, t, r) => {
      var n = r(48805),
        o = r(38615),
        i = r(92534),
        u = RegExp("['’]", "g");
      e.exports = function (e) {
        return function (t) {
          return n(i(o(t).replace(u, "")), e, "");
        };
      };
    },
    64805: (e) => {
      e.exports = function (e) {
        return e.split("");
      };
    },
    77373: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("Square", [
        ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2", key: "afitv7" }],
      ]);
    },
    81715: (e, t, r) => {
      var n = r(60292),
        o = r(27015);
      e.exports = n(function (e, t, r) {
        return e + (r ? " " : "") + o(t);
      });
    },
    82075: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("ArrowUp", [
        ["path", { d: "m5 12 7-7 7 7", key: "hav0vg" }],
        ["path", { d: "M12 19V5", key: "x0mq9r" }],
      ]);
    },
    85973: (e, t, r) => {
      "use strict";
      r.d(t, { A: () => n });
      let n = (0, r(92068).A)("ChevronLeft", [["path", { d: "m15 18-6-6 6-6", key: "1wnfg3" }]]);
    },
    86187: (e) => {
      e.exports = function (e) {
        return function (t) {
          return null == e ? void 0 : e[t];
        };
      };
    },
    87247: (e, t, r) => {
      var n = r(64805),
        o = r(92937),
        i = r(53085);
      e.exports = function (e) {
        return o(e) ? i(e) : n(e);
      };
    },
    92534: (e, t, r) => {
      var n = r(58250),
        o = r(98733),
        i = r(41921),
        u = r(14418);
      e.exports = function (e, t, r) {
        return ((e = i(e)), void 0 === (t = r ? void 0 : t))
          ? o(e)
            ? u(e)
            : n(e)
          : e.match(t) || [];
      };
    },
    92937: (e) => {
      var t = RegExp(
        "[\\u200d\ud800-\udfff\\u0300-\\u036f\\ufe20-\\ufe2f\\u20d0-\\u20ff\\ufe0e\\ufe0f]",
      );
      e.exports = function (e) {
        return t.test(e);
      };
    },
    97989: (e, t, r) => {
      var n = r(27523);
      e.exports = function (e, t, r) {
        var o = e.length;
        return ((r = void 0 === r ? o : r), !t && r >= o ? e : n(e, t, r));
      };
    },
    98733: (e) => {
      var t = /[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;
      e.exports = function (e) {
        return t.test(e);
      };
    },
  },
]);
