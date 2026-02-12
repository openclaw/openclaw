(self.webpackChunk_N_E = self.webpackChunk_N_E || []).push([
  [95999],
  {
    169: () => {},
    7877: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Diff", [
        ["path", { d: "M12 3v14", key: "7cf3v8" }],
        ["path", { d: "M5 10h14", key: "elsbfy" }],
        ["path", { d: "M5 21h14", key: "11awu3" }],
      ]);
    },
    9196: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Trash", [
        ["path", { d: "M3 6h18", key: "d0wm0j" }],
        ["path", { d: "M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6", key: "4alrt4" }],
        ["path", { d: "M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2", key: "v07s0e" }],
      ]);
    },
    10614: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Minus", [["path", { d: "M5 12h14", key: "1ays0h" }]]);
    },
    11339: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("CodeXml", [
        ["path", { d: "m18 16 4-4-4-4", key: "1inbqp" }],
        ["path", { d: "m6 8-4 4 4 4", key: "15zrgr" }],
        ["path", { d: "m14.5 4-5 16", key: "e7oirm" }],
      ]);
    },
    12494: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Plus", [
        ["path", { d: "M5 12h14", key: "1ays0h" }],
        ["path", { d: "M12 5v14", key: "s699le" }],
      ]);
    },
    31899: (e, t, n) => {
      "use strict";
      let r;
      n.d(t, { A: () => a });
      let i = {
          randomUUID:
            "undefined" != typeof crypto && crypto.randomUUID && crypto.randomUUID.bind(crypto),
        },
        s = new Uint8Array(16),
        o = [];
      for (let e = 0; e < 256; ++e) {
        o.push((e + 256).toString(16).slice(1));
      }
      let a = function (e, t, n) {
        if (i.randomUUID && !t && !e) {
          return i.randomUUID();
        }
        var a = e,
          u = n;
        let l =
          (a = a || {}).random ??
          a.rng?.() ??
          (function () {
            if (!r) {
              if ("undefined" == typeof crypto || !crypto.getRandomValues) {
                throw Error(
                  "crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported",
                );
              }
              r = crypto.getRandomValues.bind(crypto);
            }
            return r(s);
          })();
        if (l.length < 16) {
          throw Error("Random bytes length must be >= 16");
        }
        if (((l[6] = (15 & l[6]) | 64), (l[8] = (63 & l[8]) | 128), t)) {
          if ((u = u || 0) < 0 || u + 16 > t.length) {
            throw RangeError(`UUID byte range ${u}:${u + 15} is out of buffer bounds`);
          }
          for (let e = 0; e < 16; ++e) {
            t[u + e] = l[e];
          }
          return t;
        }
        return (function (e, t = 0) {
          return (
            o[e[t + 0]] +
            o[e[t + 1]] +
            o[e[t + 2]] +
            o[e[t + 3]] +
            "-" +
            o[e[t + 4]] +
            o[e[t + 5]] +
            "-" +
            o[e[t + 6]] +
            o[e[t + 7]] +
            "-" +
            o[e[t + 8]] +
            o[e[t + 9]] +
            "-" +
            o[e[t + 10]] +
            o[e[t + 11]] +
            o[e[t + 12]] +
            o[e[t + 13]] +
            o[e[t + 14]] +
            o[e[t + 15]]
          ).toLowerCase();
        })(l);
      };
    },
    34518: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("ThumbsDown", [
        ["path", { d: "M17 14V2", key: "8ymqnk" }],
        [
          "path",
          {
            d: "M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z",
            key: "m61m77",
          },
        ],
      ]);
    },
    39808: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("File", [
        [
          "path",
          { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z", key: "1rqfz7" },
        ],
        ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
      ]);
    },
    40999: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Maximize2", [
        ["polyline", { points: "15 3 21 3 21 9", key: "mznyad" }],
        ["polyline", { points: "9 21 3 21 3 15", key: "1avn1i" }],
        ["line", { x1: "21", x2: "14", y1: "3", y2: "10", key: "ota7mn" }],
        ["line", { x1: "3", x2: "10", y1: "21", y2: "14", key: "1atl0r" }],
      ]);
    },
    46707: (e, t, n) => {
      "use strict";
      var r = n(40459);
      n(169);
      var i = n(7620),
        s = (function (e) {
          return e && "object" == typeof e && "default" in e ? e : { default: e };
        })(i),
        o = void 0 !== r && r.env && !0,
        a = function (e) {
          return "[object String]" === Object.prototype.toString.call(e);
        },
        u = (function () {
          function e(e) {
            var t = void 0 === e ? {} : e,
              n = t.name,
              r = void 0 === n ? "stylesheet" : n,
              i = t.optimizeForSpeed,
              s = void 0 === i ? o : i;
            (l(a(r), "`name` must be a string"),
              (this._name = r),
              (this._deletedRulePlaceholder = "#" + r + "-deleted-rule____{}"),
              l("boolean" == typeof s, "`optimizeForSpeed` must be a boolean"),
              (this._optimizeForSpeed = s),
              (this._serverSheet = void 0),
              (this._tags = []),
              (this._injected = !1),
              (this._rulesCount = 0));
            var u =
              "undefined" != typeof window && document.querySelector('meta[property="csp-nonce"]');
            this._nonce = u ? u.getAttribute("content") : null;
          }
          var t,
            n = e.prototype;
          return (
            (n.setOptimizeForSpeed = function (e) {
              (l("boolean" == typeof e, "`setOptimizeForSpeed` accepts a boolean"),
                l(
                  0 === this._rulesCount,
                  "optimizeForSpeed cannot be when rules have already been inserted",
                ),
                this.flush(),
                (this._optimizeForSpeed = e),
                this.inject());
            }),
            (n.isOptimizeForSpeed = function () {
              return this._optimizeForSpeed;
            }),
            (n.inject = function () {
              var e = this;
              if (
                (l(!this._injected, "sheet already injected"),
                (this._injected = !0),
                "undefined" != typeof window && this._optimizeForSpeed)
              ) {
                ((this._tags[0] = this.makeStyleTag(this._name)),
                  (this._optimizeForSpeed = "insertRule" in this.getSheet()),
                  this._optimizeForSpeed ||
                    (o ||
                      console.warn(
                        "StyleSheet: optimizeForSpeed mode not supported falling back to standard mode.",
                      ),
                    this.flush(),
                    (this._injected = !0)));
                return;
              }
              this._serverSheet = {
                cssRules: [],
                insertRule: function (t, n) {
                  return (
                    "number" == typeof n
                      ? (e._serverSheet.cssRules[n] = { cssText: t })
                      : e._serverSheet.cssRules.push({ cssText: t }),
                    n
                  );
                },
                deleteRule: function (t) {
                  e._serverSheet.cssRules[t] = null;
                },
              };
            }),
            (n.getSheetForTag = function (e) {
              if (e.sheet) {
                return e.sheet;
              }
              for (var t = 0; t < document.styleSheets.length; t++) {
                if (document.styleSheets[t].ownerNode === e) return document.styleSheets[t];
              }
            }),
            (n.getSheet = function () {
              return this.getSheetForTag(this._tags[this._tags.length - 1]);
            }),
            (n.insertRule = function (e, t) {
              if ((l(a(e), "`insertRule` accepts only strings"), "undefined" == typeof window)) {
                return (
                  "number" != typeof t && (t = this._serverSheet.cssRules.length),
                  this._serverSheet.insertRule(e, t),
                  this._rulesCount++
                );
              }
              if (this._optimizeForSpeed) {
                var n = this.getSheet();
                "number" != typeof t && (t = n.cssRules.length);
                try {
                  n.insertRule(e, t);
                } catch (t) {
                  return (
                    o ||
                      console.warn(
                        "StyleSheet: illegal rule: \n\n" +
                          e +
                          "\n\nSee https://stackoverflow.com/q/20007992 for more info",
                      ),
                    -1
                  );
                }
              } else {
                var r = this._tags[t];
                this._tags.push(this.makeStyleTag(this._name, e, r));
              }
              return this._rulesCount++;
            }),
            (n.replaceRule = function (e, t) {
              if (this._optimizeForSpeed || "undefined" == typeof window) {
                var n = "undefined" != typeof window ? this.getSheet() : this._serverSheet;
                if ((t.trim() || (t = this._deletedRulePlaceholder), !n.cssRules[e])) {
                  return e;
                }
                n.deleteRule(e);
                try {
                  n.insertRule(t, e);
                } catch (r) {
                  (o ||
                    console.warn(
                      "StyleSheet: illegal rule: \n\n" +
                        t +
                        "\n\nSee https://stackoverflow.com/q/20007992 for more info",
                    ),
                    n.insertRule(this._deletedRulePlaceholder, e));
                }
              } else {
                var r = this._tags[e];
                (l(r, "old rule at index `" + e + "` not found"), (r.textContent = t));
              }
              return e;
            }),
            (n.deleteRule = function (e) {
              if ("undefined" == typeof window) {
                return void this._serverSheet.deleteRule(e);
              }
              if (this._optimizeForSpeed) {
                this.replaceRule(e, "");
              } else {
                var t = this._tags[e];
                (l(t, "rule at index `" + e + "` not found"),
                  t.parentNode.removeChild(t),
                  (this._tags[e] = null));
              }
            }),
            (n.flush = function () {
              ((this._injected = !1),
                (this._rulesCount = 0),
                "undefined" != typeof window
                  ? (this._tags.forEach(function (e) {
                      return e && e.parentNode.removeChild(e);
                    }),
                    (this._tags = []))
                  : (this._serverSheet.cssRules = []));
            }),
            (n.cssRules = function () {
              var e = this;
              return "undefined" == typeof window
                ? this._serverSheet.cssRules
                : this._tags.reduce(function (t, n) {
                    return (
                      n
                        ? (t = t.concat(
                            Array.prototype.map.call(e.getSheetForTag(n).cssRules, function (t) {
                              return t.cssText === e._deletedRulePlaceholder ? null : t;
                            }),
                          ))
                        : t.push(null),
                      t
                    );
                  }, []);
            }),
            (n.makeStyleTag = function (e, t, n) {
              t && l(a(t), "makeStyleTag accepts only strings as second parameter");
              var r = document.createElement("style");
              (this._nonce && r.setAttribute("nonce", this._nonce),
                (r.type = "text/css"),
                r.setAttribute("data-" + e, ""),
                t && r.appendChild(document.createTextNode(t)));
              var i = document.head || document.getElementsByTagName("head")[0];
              return (n ? i.insertBefore(r, n) : i.appendChild(r), r);
            }),
            (t = [
              {
                key: "length",
                get: function () {
                  return this._rulesCount;
                },
              },
            ]),
            (function (e, t) {
              for (var n = 0; n < t.length; n++) {
                var r = t[n];
                ((r.enumerable = r.enumerable || !1),
                  (r.configurable = !0),
                  "value" in r && (r.writable = !0),
                  Object.defineProperty(e, r.key, r));
              }
            })(e.prototype, t),
            e
          );
        })();
      function l(e, t) {
        if (!e) {
          throw Error("StyleSheet: " + t + ".");
        }
      }
      var c = function (e) {
          for (var t = 5381, n = e.length; n; ) {
            t = (33 * t) ^ e.charCodeAt(--n);
          }
          return t >>> 0;
        },
        d = {};
      function h(e, t) {
        if (!t) {
          return "jsx-" + e;
        }
        var n = String(t),
          r = e + n;
        return (d[r] || (d[r] = "jsx-" + c(e + "-" + n)), d[r]);
      }
      function p(e, t) {
        "undefined" == typeof window && (t = t.replace(/\/style/gi, "\\/style"));
        var n = e + t;
        return (d[n] || (d[n] = t.replace(/__jsx-style-dynamic-selector/g, e)), d[n]);
      }
      var m = (function () {
          function e(e) {
            var t = void 0 === e ? {} : e,
              n = t.styleSheet,
              r = void 0 === n ? null : n,
              i = t.optimizeForSpeed,
              s = void 0 !== i && i;
            ((this._sheet = r || new u({ name: "styled-jsx", optimizeForSpeed: s })),
              this._sheet.inject(),
              r &&
                "boolean" == typeof s &&
                (this._sheet.setOptimizeForSpeed(s),
                (this._optimizeForSpeed = this._sheet.isOptimizeForSpeed())),
              (this._fromServer = void 0),
              (this._indices = {}),
              (this._instancesCounts = {}));
          }
          var t = e.prototype;
          return (
            (t.add = function (e) {
              var t = this;
              (void 0 === this._optimizeForSpeed &&
                ((this._optimizeForSpeed = Array.isArray(e.children)),
                this._sheet.setOptimizeForSpeed(this._optimizeForSpeed),
                (this._optimizeForSpeed = this._sheet.isOptimizeForSpeed())),
                "undefined" == typeof window ||
                  this._fromServer ||
                  ((this._fromServer = this.selectFromServer()),
                  (this._instancesCounts = Object.keys(this._fromServer).reduce(function (e, t) {
                    return ((e[t] = 0), e);
                  }, {}))));
              var n = this.getIdAndRules(e),
                r = n.styleId,
                i = n.rules;
              if (r in this._instancesCounts) {
                this._instancesCounts[r] += 1;
                return;
              }
              var s = i
                .map(function (e) {
                  return t._sheet.insertRule(e);
                })
                .filter(function (e) {
                  return -1 !== e;
                });
              ((this._indices[r] = s), (this._instancesCounts[r] = 1));
            }),
            (t.remove = function (e) {
              var t = this,
                n = this.getIdAndRules(e).styleId;
              if (
                ((function (e, t) {
                  if (!e) {
                    throw Error("StyleSheetRegistry: " + t + ".");
                  }
                })(n in this._instancesCounts, "styleId: `" + n + "` not found"),
                (this._instancesCounts[n] -= 1),
                this._instancesCounts[n] < 1)
              ) {
                var r = this._fromServer && this._fromServer[n];
                (r
                  ? (r.parentNode.removeChild(r), delete this._fromServer[n])
                  : (this._indices[n].forEach(function (e) {
                      return t._sheet.deleteRule(e);
                    }),
                    delete this._indices[n]),
                  delete this._instancesCounts[n]);
              }
            }),
            (t.update = function (e, t) {
              (this.add(t), this.remove(e));
            }),
            (t.flush = function () {
              (this._sheet.flush(),
                this._sheet.inject(),
                (this._fromServer = void 0),
                (this._indices = {}),
                (this._instancesCounts = {}));
            }),
            (t.cssRules = function () {
              var e = this,
                t = this._fromServer
                  ? Object.keys(this._fromServer).map(function (t) {
                      return [t, e._fromServer[t]];
                    })
                  : [],
                n = this._sheet.cssRules();
              return t.concat(
                Object.keys(this._indices)
                  .map(function (t) {
                    return [
                      t,
                      e._indices[t]
                        .map(function (e) {
                          return n[e].cssText;
                        })
                        .join(e._optimizeForSpeed ? "" : "\n"),
                    ];
                  })
                  .filter(function (e) {
                    return !!e[1];
                  }),
              );
            }),
            (t.styles = function (e) {
              var t, n;
              return (
                (t = this.cssRules()),
                void 0 === (n = e) && (n = {}),
                t.map(function (e) {
                  var t = e[0],
                    r = e[1];
                  return s.default.createElement("style", {
                    id: "__" + t,
                    key: "__" + t,
                    nonce: n.nonce ? n.nonce : void 0,
                    dangerouslySetInnerHTML: { __html: r },
                  });
                })
              );
            }),
            (t.getIdAndRules = function (e) {
              var t = e.children,
                n = e.dynamic,
                r = e.id;
              if (n) {
                var i = h(r, n);
                return {
                  styleId: i,
                  rules: Array.isArray(t)
                    ? t.map(function (e) {
                        return p(i, e);
                      })
                    : [p(i, t)],
                };
              }
              return { styleId: h(r), rules: Array.isArray(t) ? t : [t] };
            }),
            (t.selectFromServer = function () {
              return Array.prototype.slice
                .call(document.querySelectorAll('[id^="__jsx-"]'))
                .reduce(function (e, t) {
                  return ((e[t.id.slice(2)] = t), e);
                }, {});
            }),
            e
          );
        })(),
        f = i.createContext(null);
      f.displayName = "StyleSheetContext";
      var y = s.default.useInsertionEffect || s.default.useLayoutEffect,
        v = "undefined" != typeof window ? new m() : void 0;
      function _(e) {
        var t = v || i.useContext(f);
        return (
          t &&
            ("undefined" == typeof window
              ? t.add(e)
              : y(
                  function () {
                    return (
                      t.add(e),
                      function () {
                        t.remove(e);
                      }
                    );
                  },
                  [e.id, String(e.dynamic)],
                )),
          null
        );
      }
      ((_.dynamic = function (e) {
        return e
          .map(function (e) {
            return h(e[0], e[1]);
          })
          .join(" ");
      }),
        (t.style = _));
    },
    73181: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("Minimize2", [
        ["polyline", { points: "4 14 10 14 10 20", key: "11kfnr" }],
        ["polyline", { points: "20 10 14 10 14 4", key: "rlmsce" }],
        ["line", { x1: "14", x2: "21", y1: "10", y2: "3", key: "o5lafz" }],
        ["line", { x1: "3", x2: "10", y1: "21", y2: "14", key: "1atl0r" }],
      ]);
    },
    74363: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("ThumbsUp", [
        ["path", { d: "M7 10v12", key: "1qc93n" }],
        [
          "path",
          {
            d: "M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z",
            key: "emmmcr",
          },
        ],
      ]);
    },
    90663: (e, t, n) => {
      "use strict";
      n.d(t, { F: () => v });
      var r = n(7620),
        i = Object.defineProperty,
        s = Object.getOwnPropertySymbols,
        o = Object.prototype.hasOwnProperty,
        a = Object.prototype.propertyIsEnumerable,
        u = (e, t, n) =>
          t in e
            ? i(e, t, { enumerable: !0, configurable: !0, writable: !0, value: n })
            : (e[t] = n),
        l = (e, t) => {
          for (var n in t || (t = {})) {
            o.call(t, n) && u(e, n, t[n]);
          }
          if (s) {
            for (var n of s(t)) a.call(t, n) && u(e, n, t[n]);
          }
          return e;
        },
        c = (e, t) => {
          let n = "[react-use-intercom]";
          switch (e) {
            case "info":
            default:
              console.log(`${n} ${t}`);
              break;
            case "warn":
              console.warn(`${n} ${t}`);
              break;
            case "error":
              console.error(`${n} ${t}`);
          }
        },
        d = "undefined" == typeof window,
        h = (e) => (
          Object.keys(e).forEach((t) => {
            e[t] && "object" == typeof e[t] ? h(e[t]) : void 0 === e[t] && delete e[t];
          }),
          e
        ),
        p = (e, ...t) => {
          if (!d && window.Intercom) {
            return window.Intercom.apply(null, [e, ...t]);
          }
          c("error", `${e} Intercom instance is not initalized yet`);
        },
        m = r.createContext(void 0),
        f = (e) =>
          l(
            {
              company_id: e.companyId,
              name: e.name,
              created_at: e.createdAt,
              plan: e.plan,
              monthly_spend: e.monthlySpend,
              user_count: e.userCount,
              size: e.size,
              website: e.website,
              industry: e.industry,
            },
            e.customAttributes,
          ),
        y = (e) =>
          h(
            l(
              l(
                {},
                ((e) => ({
                  custom_launcher_selector: e.customLauncherSelector,
                  alignment: e.alignment,
                  vertical_padding: e.verticalPadding,
                  horizontal_padding: e.horizontalPadding,
                  hide_default_launcher: e.hideDefaultLauncher,
                  session_duration: e.sessionDuration,
                  action_color: e.actionColor,
                  background_color: e.backgroundColor,
                }))(e),
              ),
              ((e) => {
                var t;
                return l(
                  {
                    email: e.email,
                    user_id: e.userId,
                    created_at: e.createdAt,
                    name: e.name,
                    phone: e.phone,
                    last_request_at: e.lastRequestAt,
                    unsubscribed_from_emails: e.unsubscribedFromEmails,
                    language_override: e.languageOverride,
                    utm_campaign: e.utmCampaign,
                    utm_content: e.utmContent,
                    utm_medium: e.utmMedium,
                    utm_source: e.utmSource,
                    utm_term: e.utmTerm,
                    avatar:
                      e.avatar && ((e) => ({ type: e.type, image_url: e.imageUrl }))(e.avatar),
                    user_hash: e.userHash,
                    company: e.company && f(e.company),
                    companies: null == (t = e.companies) ? void 0 : t.map(f),
                  },
                  e.customAttributes,
                );
              })(e),
            ),
          ),
        v = (e) => {
          var {
              appId: t,
              autoBoot: n = !1,
              autoBootProps: i,
              children: u,
              onHide: h,
              onShow: f,
              onUnreadCountChange: v,
              onUserEmailSupplied: _,
              shouldInitialize: w = !d,
              apiBase: S,
              initializeDelay: g,
            } = e,
            b = ((e, t) => {
              var n = {};
              for (var r in e) {
                o.call(e, r) && 0 > t.indexOf(r) && (n[r] = e[r]);
              }
              if (null != e && s) {
                for (var r of s(e)) 0 > t.indexOf(r) && a.call(e, r) && (n[r] = e[r]);
              }
              return n;
            })(e, [
              "appId",
              "autoBoot",
              "autoBootProps",
              "children",
              "onHide",
              "onShow",
              "onUnreadCountChange",
              "onUserEmailSupplied",
              "shouldInitialize",
              "apiBase",
              "initializeDelay",
            ]);
          let k = r.useRef(!1),
            C = r.useRef(!1),
            A = Object.keys(b).filter((e) => !e.startsWith("data-"));
          A.length > 0 &&
            c(
              "warn",
              `some invalid props were passed to IntercomProvider. Please check following props: ${A.join(", ")}.`,
            );
          let z = r.useCallback(
              (e) => {
                if (!window.Intercom && !w) {
                  return c(
                    "warn",
                    "Intercom instance is not initialized because `shouldInitialize` is set to `false` in `IntercomProvider`",
                  );
                }
                let n = l(l({ app_id: t }, S && { api_base: S }), e && y(e));
                ((window.intercomSettings = n), p("boot", n), (k.current = !0));
              },
              [S, t, w],
            ),
            [R, I] = r.useState(!1),
            F = r.useCallback(() => {
              (I(!1), h && h());
            }, [h, I]),
            j = r.useCallback(() => {
              (I(!0), f && f());
            }, [f, I]);
          d ||
            !w ||
            C.current ||
            (((e, t = 0) => {
              var n = window,
                r = n.Intercom;
              if ("function" == typeof r) {
                (r("reattach_activator"), r("update", n.intercomSettings));
              } else {
                var i = document,
                  s = function () {
                    s.c(arguments);
                  };
                ((s.q = []),
                  (s.c = function (e) {
                    s.q.push(e);
                  }),
                  (n.Intercom = s));
                var o = function () {
                  setTimeout(function () {
                    var t = i.createElement("script");
                    ((t.type = "text/javascript"),
                      (t.async = !0),
                      (t.src = "https://widget.intercom.io/widget/" + e));
                    var n = i.getElementsByTagName("script")[0];
                    n.parentNode.insertBefore(t, n);
                  }, t);
                };
                "complete" === document.readyState
                  ? o()
                  : n.attachEvent
                    ? n.attachEvent("onload", o)
                    : n.addEventListener("load", o, !1);
              }
            })(t, g),
            p("onHide", F),
            p("onShow", j),
            p("onUserEmailSupplied", _),
            v && p("onUnreadCountChange", v),
            n && z(i),
            (C.current = !0));
          let x = r.useCallback(
              (e, t) =>
                window.Intercom || w
                  ? k.current
                    ? t()
                    : c(
                        "warn",
                        `"${e}" was called but Intercom has not booted yet. Please call 'boot' before calling '${e}' or set 'autoBoot' to true in the IntercomProvider.`,
                      )
                  : c(
                      "warn",
                      "Intercom instance is not initialized because `shouldInitialize` is set to `false` in `IntercomProvider`",
                    ),
              [w],
            ),
            M = r.useCallback(() => {
              k.current && (p("shutdown"), delete window.intercomSettings, (k.current = !1));
            }, []),
            E = r.useCallback(() => {
              k.current &&
                (p("shutdown"),
                delete window.Intercom,
                delete window.intercomSettings,
                (k.current = !1));
            }, []),
            O = r.useCallback(() => {
              x("update", () => {
                p("update", { last_request_at: Math.floor(new Date().getTime() / 1e3) });
              });
            }, [x]),
            T = r.useCallback(
              (e) => {
                x("update", () => {
                  if (!e) {
                    return void O();
                  }
                  let t = y(e);
                  ((window.intercomSettings = l(l({}, window.intercomSettings), t)),
                    p("update", t));
                });
              },
              [x, O],
            ),
            U = r.useCallback(() => {
              x("hide", () => {
                p("hide");
              });
            }, [x]),
            P = r.useCallback(() => {
              x("show", () => p("show"));
            }, [x]),
            N = r.useCallback(() => {
              x("showMessages", () => {
                p("showMessages");
              });
            }, [x]),
            q = r.useCallback(
              (e) => {
                x("showNewMessage", () => {
                  e ? p("showNewMessage", e) : p("showNewMessage");
                });
              },
              [x],
            ),
            D = r.useCallback(() => x("getVisitorId", () => p("getVisitorId")), [x]),
            H = r.useCallback(
              (e) => {
                x("startTour", () => {
                  p("startTour", e);
                });
              },
              [x],
            ),
            $ = r.useCallback(
              (e) => {
                x("startChecklist", () => {
                  p("startChecklist", e);
                });
              },
              [x],
            ),
            B = r.useCallback(
              (e, t) => {
                x("trackEvent", () => {
                  t ? p("trackEvent", e, t) : p("trackEvent", e);
                });
              },
              [x],
            ),
            V = r.useCallback(
              (e) =>
                x("showArticle", () => {
                  p("showArticle", e);
                }),
              [x],
            ),
            L = r.useCallback(
              (e) =>
                x("showSpace", () => {
                  p("showSpace", e);
                }),
              [x],
            ),
            Z = r.useCallback(
              (e) => {
                x("startSurvey", () => {
                  p("startSurvey", e);
                });
              },
              [x],
            ),
            W = r.useCallback(
              (e) =>
                x("showNews", () => {
                  p("showNews", e);
                }),
              [x],
            ),
            X = r.useMemo(
              () => ({
                boot: z,
                shutdown: M,
                hardShutdown: E,
                update: T,
                hide: U,
                show: P,
                isOpen: R,
                showMessages: N,
                showNewMessage: q,
                getVisitorId: D,
                startTour: H,
                startChecklist: $,
                trackEvent: B,
                showArticle: V,
                startSurvey: Z,
                showSpace: L,
                showNews: W,
              }),
              [z, M, E, T, U, P, R, N, q, D, H, $, B, V, Z, L, W],
            );
          return r.createElement(m.Provider, { value: X }, u);
        };
    },
    91640: (e, t, n) => {
      "use strict";
      e.exports = n(46707).style;
    },
    93407: (e, t, n) => {
      "use strict";
      n.d(t, { A: () => r });
      let r = (0, n(92068).A)("FileSearch", [
        ["path", { d: "M14 2v4a2 2 0 0 0 2 2h4", key: "tnqrlb" }],
        [
          "path",
          {
            d: "M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3",
            key: "ms7g94",
          },
        ],
        ["path", { d: "m9 18-1.5-1.5", key: "1j6qii" }],
        ["circle", { cx: "5", cy: "14", r: "3", key: "ufru5t" }],
      ]);
    },
  },
]);
