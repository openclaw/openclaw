"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// node_modules/.pnpm/node-machine-id@1.1.12/node_modules/node-machine-id/dist/index.js
var require_dist = __commonJS({
  "node_modules/.pnpm/node-machine-id@1.1.12/node_modules/node-machine-id/dist/index.js"(exports2, module2) {
    !(function(t, n) {
      "object" == typeof exports2 && "object" == typeof module2 ? module2.exports = n(require("child_process"), require("crypto")) : "function" == typeof define && define.amd ? define(["child_process", "crypto"], n) : "object" == typeof exports2 ? exports2["electron-machine-id"] = n(require("child_process"), require("crypto")) : t["electron-machine-id"] = n(t.child_process, t.crypto);
    })(exports2, function(t, n) {
      return (function(t2) {
        function n2(e) {
          if (r[e]) return r[e].exports;
          var o = r[e] = { exports: {}, id: e, loaded: false };
          return t2[e].call(o.exports, o, o.exports, n2), o.loaded = true, o.exports;
        }
        var r = {};
        return n2.m = t2, n2.c = r, n2.p = "", n2(0);
      })([function(t2, n2, r) {
        t2.exports = r(34);
      }, function(t2, n2, r) {
        var e = r(29)("wks"), o = r(33), i = r(2).Symbol, c = "function" == typeof i, u = t2.exports = function(t3) {
          return e[t3] || (e[t3] = c && i[t3] || (c ? i : o)("Symbol." + t3));
        };
        u.store = e;
      }, function(t2, n2) {
        var r = t2.exports = "undefined" != typeof window && window.Math == Math ? window : "undefined" != typeof self && self.Math == Math ? self : Function("return this")();
        "number" == typeof __g && (__g = r);
      }, function(t2, n2, r) {
        var e = r(9);
        t2.exports = function(t3) {
          if (!e(t3)) throw TypeError(t3 + " is not an object!");
          return t3;
        };
      }, function(t2, n2, r) {
        t2.exports = !r(24)(function() {
          return 7 != Object.defineProperty({}, "a", { get: function() {
            return 7;
          } }).a;
        });
      }, function(t2, n2, r) {
        var e = r(12), o = r(17);
        t2.exports = r(4) ? function(t3, n3, r2) {
          return e.f(t3, n3, o(1, r2));
        } : function(t3, n3, r2) {
          return t3[n3] = r2, t3;
        };
      }, function(t2, n2) {
        var r = t2.exports = { version: "2.4.0" };
        "number" == typeof __e && (__e = r);
      }, function(t2, n2, r) {
        var e = r(14);
        t2.exports = function(t3, n3, r2) {
          if (e(t3), void 0 === n3) return t3;
          switch (r2) {
            case 1:
              return function(r3) {
                return t3.call(n3, r3);
              };
            case 2:
              return function(r3, e2) {
                return t3.call(n3, r3, e2);
              };
            case 3:
              return function(r3, e2, o) {
                return t3.call(n3, r3, e2, o);
              };
          }
          return function() {
            return t3.apply(n3, arguments);
          };
        };
      }, function(t2, n2) {
        var r = {}.hasOwnProperty;
        t2.exports = function(t3, n3) {
          return r.call(t3, n3);
        };
      }, function(t2, n2) {
        t2.exports = function(t3) {
          return "object" == typeof t3 ? null !== t3 : "function" == typeof t3;
        };
      }, function(t2, n2) {
        t2.exports = {};
      }, function(t2, n2) {
        var r = {}.toString;
        t2.exports = function(t3) {
          return r.call(t3).slice(8, -1);
        };
      }, function(t2, n2, r) {
        var e = r(3), o = r(26), i = r(32), c = Object.defineProperty;
        n2.f = r(4) ? Object.defineProperty : function(t3, n3, r2) {
          if (e(t3), n3 = i(n3, true), e(r2), o) try {
            return c(t3, n3, r2);
          } catch (t4) {
          }
          if ("get" in r2 || "set" in r2) throw TypeError("Accessors not supported!");
          return "value" in r2 && (t3[n3] = r2.value), t3;
        };
      }, function(t2, n2, r) {
        var e = r(42), o = r(15);
        t2.exports = function(t3) {
          return e(o(t3));
        };
      }, function(t2, n2) {
        t2.exports = function(t3) {
          if ("function" != typeof t3) throw TypeError(t3 + " is not a function!");
          return t3;
        };
      }, function(t2, n2) {
        t2.exports = function(t3) {
          if (void 0 == t3) throw TypeError("Can't call method on  " + t3);
          return t3;
        };
      }, function(t2, n2, r) {
        var e = r(9), o = r(2).document, i = e(o) && e(o.createElement);
        t2.exports = function(t3) {
          return i ? o.createElement(t3) : {};
        };
      }, function(t2, n2) {
        t2.exports = function(t3, n3) {
          return { enumerable: !(1 & t3), configurable: !(2 & t3), writable: !(4 & t3), value: n3 };
        };
      }, function(t2, n2, r) {
        var e = r(12).f, o = r(8), i = r(1)("toStringTag");
        t2.exports = function(t3, n3, r2) {
          t3 && !o(t3 = r2 ? t3 : t3.prototype, i) && e(t3, i, { configurable: true, value: n3 });
        };
      }, function(t2, n2, r) {
        var e = r(29)("keys"), o = r(33);
        t2.exports = function(t3) {
          return e[t3] || (e[t3] = o(t3));
        };
      }, function(t2, n2) {
        var r = Math.ceil, e = Math.floor;
        t2.exports = function(t3) {
          return isNaN(t3 = +t3) ? 0 : (t3 > 0 ? e : r)(t3);
        };
      }, function(t2, n2, r) {
        var e = r(11), o = r(1)("toStringTag"), i = "Arguments" == e(/* @__PURE__ */ (function() {
          return arguments;
        })()), c = function(t3, n3) {
          try {
            return t3[n3];
          } catch (t4) {
          }
        };
        t2.exports = function(t3) {
          var n3, r2, u;
          return void 0 === t3 ? "Undefined" : null === t3 ? "Null" : "string" == typeof (r2 = c(n3 = Object(t3), o)) ? r2 : i ? e(n3) : "Object" == (u = e(n3)) && "function" == typeof n3.callee ? "Arguments" : u;
        };
      }, function(t2, n2) {
        t2.exports = "constructor,hasOwnProperty,isPrototypeOf,propertyIsEnumerable,toLocaleString,toString,valueOf".split(",");
      }, function(t2, n2, r) {
        var e = r(2), o = r(6), i = r(7), c = r(5), u = "prototype", s = function(t3, n3, r2) {
          var f, a, p, l = t3 & s.F, v = t3 & s.G, h = t3 & s.S, d = t3 & s.P, y = t3 & s.B, _ = t3 & s.W, x = v ? o : o[n3] || (o[n3] = {}), m = x[u], w = v ? e : h ? e[n3] : (e[n3] || {})[u];
          v && (r2 = n3);
          for (f in r2) a = !l && w && void 0 !== w[f], a && f in x || (p = a ? w[f] : r2[f], x[f] = v && "function" != typeof w[f] ? r2[f] : y && a ? i(p, e) : _ && w[f] == p ? (function(t4) {
            var n4 = function(n5, r3, e2) {
              if (this instanceof t4) {
                switch (arguments.length) {
                  case 0:
                    return new t4();
                  case 1:
                    return new t4(n5);
                  case 2:
                    return new t4(n5, r3);
                }
                return new t4(n5, r3, e2);
              }
              return t4.apply(this, arguments);
            };
            return n4[u] = t4[u], n4;
          })(p) : d && "function" == typeof p ? i(Function.call, p) : p, d && ((x.virtual || (x.virtual = {}))[f] = p, t3 & s.R && m && !m[f] && c(m, f, p)));
        };
        s.F = 1, s.G = 2, s.S = 4, s.P = 8, s.B = 16, s.W = 32, s.U = 64, s.R = 128, t2.exports = s;
      }, function(t2, n2) {
        t2.exports = function(t3) {
          try {
            return !!t3();
          } catch (t4) {
            return true;
          }
        };
      }, function(t2, n2, r) {
        t2.exports = r(2).document && document.documentElement;
      }, function(t2, n2, r) {
        t2.exports = !r(4) && !r(24)(function() {
          return 7 != Object.defineProperty(r(16)("div"), "a", { get: function() {
            return 7;
          } }).a;
        });
      }, function(t2, n2, r) {
        "use strict";
        var e = r(28), o = r(23), i = r(57), c = r(5), u = r(8), s = r(10), f = r(45), a = r(18), p = r(52), l = r(1)("iterator"), v = !([].keys && "next" in [].keys()), h = "@@iterator", d = "keys", y = "values", _ = function() {
          return this;
        };
        t2.exports = function(t3, n3, r2, x, m, w, g) {
          f(r2, n3, x);
          var b, O, j, S = function(t4) {
            if (!v && t4 in T) return T[t4];
            switch (t4) {
              case d:
                return function() {
                  return new r2(this, t4);
                };
              case y:
                return function() {
                  return new r2(this, t4);
                };
            }
            return function() {
              return new r2(this, t4);
            };
          }, E = n3 + " Iterator", P = m == y, M = false, T = t3.prototype, A = T[l] || T[h] || m && T[m], k = A || S(m), C = m ? P ? S("entries") : k : void 0, I = "Array" == n3 ? T.entries || A : A;
          if (I && (j = p(I.call(new t3())), j !== Object.prototype && (a(j, E, true), e || u(j, l) || c(j, l, _))), P && A && A.name !== y && (M = true, k = function() {
            return A.call(this);
          }), e && !g || !v && !M && T[l] || c(T, l, k), s[n3] = k, s[E] = _, m) if (b = { values: P ? k : S(y), keys: w ? k : S(d), entries: C }, g) for (O in b) O in T || i(T, O, b[O]);
          else o(o.P + o.F * (v || M), n3, b);
          return b;
        };
      }, function(t2, n2) {
        t2.exports = true;
      }, function(t2, n2, r) {
        var e = r(2), o = "__core-js_shared__", i = e[o] || (e[o] = {});
        t2.exports = function(t3) {
          return i[t3] || (i[t3] = {});
        };
      }, function(t2, n2, r) {
        var e, o, i, c = r(7), u = r(41), s = r(25), f = r(16), a = r(2), p = a.process, l = a.setImmediate, v = a.clearImmediate, h = a.MessageChannel, d = 0, y = {}, _ = "onreadystatechange", x = function() {
          var t3 = +this;
          if (y.hasOwnProperty(t3)) {
            var n3 = y[t3];
            delete y[t3], n3();
          }
        }, m = function(t3) {
          x.call(t3.data);
        };
        l && v || (l = function(t3) {
          for (var n3 = [], r2 = 1; arguments.length > r2; ) n3.push(arguments[r2++]);
          return y[++d] = function() {
            u("function" == typeof t3 ? t3 : Function(t3), n3);
          }, e(d), d;
        }, v = function(t3) {
          delete y[t3];
        }, "process" == r(11)(p) ? e = function(t3) {
          p.nextTick(c(x, t3, 1));
        } : h ? (o = new h(), i = o.port2, o.port1.onmessage = m, e = c(i.postMessage, i, 1)) : a.addEventListener && "function" == typeof postMessage && !a.importScripts ? (e = function(t3) {
          a.postMessage(t3 + "", "*");
        }, a.addEventListener("message", m, false)) : e = _ in f("script") ? function(t3) {
          s.appendChild(f("script"))[_] = function() {
            s.removeChild(this), x.call(t3);
          };
        } : function(t3) {
          setTimeout(c(x, t3, 1), 0);
        }), t2.exports = { set: l, clear: v };
      }, function(t2, n2, r) {
        var e = r(20), o = Math.min;
        t2.exports = function(t3) {
          return t3 > 0 ? o(e(t3), 9007199254740991) : 0;
        };
      }, function(t2, n2, r) {
        var e = r(9);
        t2.exports = function(t3, n3) {
          if (!e(t3)) return t3;
          var r2, o;
          if (n3 && "function" == typeof (r2 = t3.toString) && !e(o = r2.call(t3))) return o;
          if ("function" == typeof (r2 = t3.valueOf) && !e(o = r2.call(t3))) return o;
          if (!n3 && "function" == typeof (r2 = t3.toString) && !e(o = r2.call(t3))) return o;
          throw TypeError("Can't convert object to primitive value");
        };
      }, function(t2, n2) {
        var r = 0, e = Math.random();
        t2.exports = function(t3) {
          return "Symbol(".concat(void 0 === t3 ? "" : t3, ")_", (++r + e).toString(36));
        };
      }, function(t2, n2, r) {
        "use strict";
        function e(t3) {
          return t3 && t3.__esModule ? t3 : { default: t3 };
        }
        function o() {
          return "win32" !== process.platform ? "" : "ia32" === process.arch && process.env.hasOwnProperty("PROCESSOR_ARCHITEW6432") ? "mixed" : "native";
        }
        function i(t3) {
          return (0, l.createHash)("sha256").update(t3).digest("hex");
        }
        function c(t3) {
          switch (h) {
            case "darwin":
              return t3.split("IOPlatformUUID")[1].split("\n")[0].replace(/\=|\s+|\"/gi, "").toLowerCase();
            case "win32":
              return t3.toString().split("REG_SZ")[1].replace(/\r+|\n+|\s+/gi, "").toLowerCase();
            case "linux":
              return t3.toString().replace(/\r+|\n+|\s+/gi, "").toLowerCase();
            case "freebsd":
              return t3.toString().replace(/\r+|\n+|\s+/gi, "").toLowerCase();
            default:
              throw new Error("Unsupported platform: " + process.platform);
          }
        }
        function u(t3) {
          var n3 = c((0, p.execSync)(y[h]).toString());
          return t3 ? n3 : i(n3);
        }
        function s(t3) {
          return new a.default(function(n3, r2) {
            return (0, p.exec)(y[h], {}, function(e2, o2, u2) {
              if (e2) return r2(new Error("Error while obtaining machine id: " + e2.stack));
              var s2 = c(o2.toString());
              return n3(t3 ? s2 : i(s2));
            });
          });
        }
        Object.defineProperty(n2, "__esModule", { value: true });
        var f = r(35), a = e(f);
        n2.machineIdSync = u, n2.machineId = s;
        var p = r(70), l = r(71), v = process, h = v.platform, d = { native: "%windir%\\System32", mixed: "%windir%\\sysnative\\cmd.exe /c %windir%\\System32" }, y = { darwin: "ioreg -rd1 -c IOPlatformExpertDevice", win32: d[o()] + "\\REG.exe QUERY HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid", linux: "( cat /var/lib/dbus/machine-id /etc/machine-id 2> /dev/null || hostname ) | head -n 1 || :", freebsd: "kenv -q smbios.system.uuid || sysctl -n kern.hostuuid" };
      }, function(t2, n2, r) {
        t2.exports = { default: r(36), __esModule: true };
      }, function(t2, n2, r) {
        r(66), r(68), r(69), r(67), t2.exports = r(6).Promise;
      }, function(t2, n2) {
        t2.exports = function() {
        };
      }, function(t2, n2) {
        t2.exports = function(t3, n3, r, e) {
          if (!(t3 instanceof n3) || void 0 !== e && e in t3) throw TypeError(r + ": incorrect invocation!");
          return t3;
        };
      }, function(t2, n2, r) {
        var e = r(13), o = r(31), i = r(62);
        t2.exports = function(t3) {
          return function(n3, r2, c) {
            var u, s = e(n3), f = o(s.length), a = i(c, f);
            if (t3 && r2 != r2) {
              for (; f > a; ) if (u = s[a++], u != u) return true;
            } else for (; f > a; a++) if ((t3 || a in s) && s[a] === r2) return t3 || a || 0;
            return !t3 && -1;
          };
        };
      }, function(t2, n2, r) {
        var e = r(7), o = r(44), i = r(43), c = r(3), u = r(31), s = r(64), f = {}, a = {}, n2 = t2.exports = function(t3, n3, r2, p, l) {
          var v, h, d, y, _ = l ? function() {
            return t3;
          } : s(t3), x = e(r2, p, n3 ? 2 : 1), m = 0;
          if ("function" != typeof _) throw TypeError(t3 + " is not iterable!");
          if (i(_)) {
            for (v = u(t3.length); v > m; m++) if (y = n3 ? x(c(h = t3[m])[0], h[1]) : x(t3[m]), y === f || y === a) return y;
          } else for (d = _.call(t3); !(h = d.next()).done; ) if (y = o(d, x, h.value, n3), y === f || y === a) return y;
        };
        n2.BREAK = f, n2.RETURN = a;
      }, function(t2, n2) {
        t2.exports = function(t3, n3, r) {
          var e = void 0 === r;
          switch (n3.length) {
            case 0:
              return e ? t3() : t3.call(r);
            case 1:
              return e ? t3(n3[0]) : t3.call(r, n3[0]);
            case 2:
              return e ? t3(n3[0], n3[1]) : t3.call(r, n3[0], n3[1]);
            case 3:
              return e ? t3(n3[0], n3[1], n3[2]) : t3.call(r, n3[0], n3[1], n3[2]);
            case 4:
              return e ? t3(n3[0], n3[1], n3[2], n3[3]) : t3.call(r, n3[0], n3[1], n3[2], n3[3]);
          }
          return t3.apply(r, n3);
        };
      }, function(t2, n2, r) {
        var e = r(11);
        t2.exports = Object("z").propertyIsEnumerable(0) ? Object : function(t3) {
          return "String" == e(t3) ? t3.split("") : Object(t3);
        };
      }, function(t2, n2, r) {
        var e = r(10), o = r(1)("iterator"), i = Array.prototype;
        t2.exports = function(t3) {
          return void 0 !== t3 && (e.Array === t3 || i[o] === t3);
        };
      }, function(t2, n2, r) {
        var e = r(3);
        t2.exports = function(t3, n3, r2, o) {
          try {
            return o ? n3(e(r2)[0], r2[1]) : n3(r2);
          } catch (n4) {
            var i = t3.return;
            throw void 0 !== i && e(i.call(t3)), n4;
          }
        };
      }, function(t2, n2, r) {
        "use strict";
        var e = r(49), o = r(17), i = r(18), c = {};
        r(5)(c, r(1)("iterator"), function() {
          return this;
        }), t2.exports = function(t3, n3, r2) {
          t3.prototype = e(c, { next: o(1, r2) }), i(t3, n3 + " Iterator");
        };
      }, function(t2, n2, r) {
        var e = r(1)("iterator"), o = false;
        try {
          var i = [7][e]();
          i.return = function() {
            o = true;
          }, Array.from(i, function() {
            throw 2;
          });
        } catch (t3) {
        }
        t2.exports = function(t3, n3) {
          if (!n3 && !o) return false;
          var r2 = false;
          try {
            var i2 = [7], c = i2[e]();
            c.next = function() {
              return { done: r2 = true };
            }, i2[e] = function() {
              return c;
            }, t3(i2);
          } catch (t4) {
          }
          return r2;
        };
      }, function(t2, n2) {
        t2.exports = function(t3, n3) {
          return { value: n3, done: !!t3 };
        };
      }, function(t2, n2, r) {
        var e = r(2), o = r(30).set, i = e.MutationObserver || e.WebKitMutationObserver, c = e.process, u = e.Promise, s = "process" == r(11)(c);
        t2.exports = function() {
          var t3, n3, r2, f = function() {
            var e2, o2;
            for (s && (e2 = c.domain) && e2.exit(); t3; ) {
              o2 = t3.fn, t3 = t3.next;
              try {
                o2();
              } catch (e3) {
                throw t3 ? r2() : n3 = void 0, e3;
              }
            }
            n3 = void 0, e2 && e2.enter();
          };
          if (s) r2 = function() {
            c.nextTick(f);
          };
          else if (i) {
            var a = true, p = document.createTextNode("");
            new i(f).observe(p, { characterData: true }), r2 = function() {
              p.data = a = !a;
            };
          } else if (u && u.resolve) {
            var l = u.resolve();
            r2 = function() {
              l.then(f);
            };
          } else r2 = function() {
            o.call(e, f);
          };
          return function(e2) {
            var o2 = { fn: e2, next: void 0 };
            n3 && (n3.next = o2), t3 || (t3 = o2, r2()), n3 = o2;
          };
        };
      }, function(t2, n2, r) {
        var e = r(3), o = r(50), i = r(22), c = r(19)("IE_PROTO"), u = function() {
        }, s = "prototype", f = function() {
          var t3, n3 = r(16)("iframe"), e2 = i.length, o2 = ">";
          for (n3.style.display = "none", r(25).appendChild(n3), n3.src = "javascript:", t3 = n3.contentWindow.document, t3.open(), t3.write("<script>document.F=Object</script" + o2), t3.close(), f = t3.F; e2--; ) delete f[s][i[e2]];
          return f();
        };
        t2.exports = Object.create || function(t3, n3) {
          var r2;
          return null !== t3 ? (u[s] = e(t3), r2 = new u(), u[s] = null, r2[c] = t3) : r2 = f(), void 0 === n3 ? r2 : o(r2, n3);
        };
      }, function(t2, n2, r) {
        var e = r(12), o = r(3), i = r(54);
        t2.exports = r(4) ? Object.defineProperties : function(t3, n3) {
          o(t3);
          for (var r2, c = i(n3), u = c.length, s = 0; u > s; ) e.f(t3, r2 = c[s++], n3[r2]);
          return t3;
        };
      }, function(t2, n2, r) {
        var e = r(55), o = r(17), i = r(13), c = r(32), u = r(8), s = r(26), f = Object.getOwnPropertyDescriptor;
        n2.f = r(4) ? f : function(t3, n3) {
          if (t3 = i(t3), n3 = c(n3, true), s) try {
            return f(t3, n3);
          } catch (t4) {
          }
          if (u(t3, n3)) return o(!e.f.call(t3, n3), t3[n3]);
        };
      }, function(t2, n2, r) {
        var e = r(8), o = r(63), i = r(19)("IE_PROTO"), c = Object.prototype;
        t2.exports = Object.getPrototypeOf || function(t3) {
          return t3 = o(t3), e(t3, i) ? t3[i] : "function" == typeof t3.constructor && t3 instanceof t3.constructor ? t3.constructor.prototype : t3 instanceof Object ? c : null;
        };
      }, function(t2, n2, r) {
        var e = r(8), o = r(13), i = r(39)(false), c = r(19)("IE_PROTO");
        t2.exports = function(t3, n3) {
          var r2, u = o(t3), s = 0, f = [];
          for (r2 in u) r2 != c && e(u, r2) && f.push(r2);
          for (; n3.length > s; ) e(u, r2 = n3[s++]) && (~i(f, r2) || f.push(r2));
          return f;
        };
      }, function(t2, n2, r) {
        var e = r(53), o = r(22);
        t2.exports = Object.keys || function(t3) {
          return e(t3, o);
        };
      }, function(t2, n2) {
        n2.f = {}.propertyIsEnumerable;
      }, function(t2, n2, r) {
        var e = r(5);
        t2.exports = function(t3, n3, r2) {
          for (var o in n3) r2 && t3[o] ? t3[o] = n3[o] : e(t3, o, n3[o]);
          return t3;
        };
      }, function(t2, n2, r) {
        t2.exports = r(5);
      }, function(t2, n2, r) {
        var e = r(9), o = r(3), i = function(t3, n3) {
          if (o(t3), !e(n3) && null !== n3) throw TypeError(n3 + ": can't set as prototype!");
        };
        t2.exports = { set: Object.setPrototypeOf || ("__proto__" in {} ? (function(t3, n3, e2) {
          try {
            e2 = r(7)(Function.call, r(51).f(Object.prototype, "__proto__").set, 2), e2(t3, []), n3 = !(t3 instanceof Array);
          } catch (t4) {
            n3 = true;
          }
          return function(t4, r2) {
            return i(t4, r2), n3 ? t4.__proto__ = r2 : e2(t4, r2), t4;
          };
        })({}, false) : void 0), check: i };
      }, function(t2, n2, r) {
        "use strict";
        var e = r(2), o = r(6), i = r(12), c = r(4), u = r(1)("species");
        t2.exports = function(t3) {
          var n3 = "function" == typeof o[t3] ? o[t3] : e[t3];
          c && n3 && !n3[u] && i.f(n3, u, { configurable: true, get: function() {
            return this;
          } });
        };
      }, function(t2, n2, r) {
        var e = r(3), o = r(14), i = r(1)("species");
        t2.exports = function(t3, n3) {
          var r2, c = e(t3).constructor;
          return void 0 === c || void 0 == (r2 = e(c)[i]) ? n3 : o(r2);
        };
      }, function(t2, n2, r) {
        var e = r(20), o = r(15);
        t2.exports = function(t3) {
          return function(n3, r2) {
            var i, c, u = String(o(n3)), s = e(r2), f = u.length;
            return s < 0 || s >= f ? t3 ? "" : void 0 : (i = u.charCodeAt(s), i < 55296 || i > 56319 || s + 1 === f || (c = u.charCodeAt(s + 1)) < 56320 || c > 57343 ? t3 ? u.charAt(s) : i : t3 ? u.slice(s, s + 2) : (i - 55296 << 10) + (c - 56320) + 65536);
          };
        };
      }, function(t2, n2, r) {
        var e = r(20), o = Math.max, i = Math.min;
        t2.exports = function(t3, n3) {
          return t3 = e(t3), t3 < 0 ? o(t3 + n3, 0) : i(t3, n3);
        };
      }, function(t2, n2, r) {
        var e = r(15);
        t2.exports = function(t3) {
          return Object(e(t3));
        };
      }, function(t2, n2, r) {
        var e = r(21), o = r(1)("iterator"), i = r(10);
        t2.exports = r(6).getIteratorMethod = function(t3) {
          if (void 0 != t3) return t3[o] || t3["@@iterator"] || i[e(t3)];
        };
      }, function(t2, n2, r) {
        "use strict";
        var e = r(37), o = r(47), i = r(10), c = r(13);
        t2.exports = r(27)(Array, "Array", function(t3, n3) {
          this._t = c(t3), this._i = 0, this._k = n3;
        }, function() {
          var t3 = this._t, n3 = this._k, r2 = this._i++;
          return !t3 || r2 >= t3.length ? (this._t = void 0, o(1)) : "keys" == n3 ? o(0, r2) : "values" == n3 ? o(0, t3[r2]) : o(0, [r2, t3[r2]]);
        }, "values"), i.Arguments = i.Array, e("keys"), e("values"), e("entries");
      }, function(t2, n2) {
      }, function(t2, n2, r) {
        "use strict";
        var e, o, i, c = r(28), u = r(2), s = r(7), f = r(21), a = r(23), p = r(9), l = (r(3), r(14)), v = r(38), h = r(40), d = (r(58).set, r(60)), y = r(30).set, _ = r(48)(), x = "Promise", m = u.TypeError, w = u.process, g = u[x], w = u.process, b = "process" == f(w), O = function() {
        }, j = !!(function() {
          try {
            var t3 = g.resolve(1), n3 = (t3.constructor = {})[r(1)("species")] = function(t4) {
              t4(O, O);
            };
            return (b || "function" == typeof PromiseRejectionEvent) && t3.then(O) instanceof n3;
          } catch (t4) {
          }
        })(), S = function(t3, n3) {
          return t3 === n3 || t3 === g && n3 === i;
        }, E = function(t3) {
          var n3;
          return !(!p(t3) || "function" != typeof (n3 = t3.then)) && n3;
        }, P = function(t3) {
          return S(g, t3) ? new M(t3) : new o(t3);
        }, M = o = function(t3) {
          var n3, r2;
          this.promise = new t3(function(t4, e2) {
            if (void 0 !== n3 || void 0 !== r2) throw m("Bad Promise constructor");
            n3 = t4, r2 = e2;
          }), this.resolve = l(n3), this.reject = l(r2);
        }, T = function(t3) {
          try {
            t3();
          } catch (t4) {
            return { error: t4 };
          }
        }, A = function(t3, n3) {
          if (!t3._n) {
            t3._n = true;
            var r2 = t3._c;
            _(function() {
              for (var e2 = t3._v, o2 = 1 == t3._s, i2 = 0, c2 = function(n4) {
                var r3, i3, c3 = o2 ? n4.ok : n4.fail, u2 = n4.resolve, s2 = n4.reject, f2 = n4.domain;
                try {
                  c3 ? (o2 || (2 == t3._h && I(t3), t3._h = 1), c3 === true ? r3 = e2 : (f2 && f2.enter(), r3 = c3(e2), f2 && f2.exit()), r3 === n4.promise ? s2(m("Promise-chain cycle")) : (i3 = E(r3)) ? i3.call(r3, u2, s2) : u2(r3)) : s2(e2);
                } catch (t4) {
                  s2(t4);
                }
              }; r2.length > i2; ) c2(r2[i2++]);
              t3._c = [], t3._n = false, n3 && !t3._h && k(t3);
            });
          }
        }, k = function(t3) {
          y.call(u, function() {
            var n3, r2, e2, o2 = t3._v;
            if (C(t3) && (n3 = T(function() {
              b ? w.emit("unhandledRejection", o2, t3) : (r2 = u.onunhandledrejection) ? r2({ promise: t3, reason: o2 }) : (e2 = u.console) && e2.error && e2.error("Unhandled promise rejection", o2);
            }), t3._h = b || C(t3) ? 2 : 1), t3._a = void 0, n3) throw n3.error;
          });
        }, C = function(t3) {
          if (1 == t3._h) return false;
          for (var n3, r2 = t3._a || t3._c, e2 = 0; r2.length > e2; ) if (n3 = r2[e2++], n3.fail || !C(n3.promise)) return false;
          return true;
        }, I = function(t3) {
          y.call(u, function() {
            var n3;
            b ? w.emit("rejectionHandled", t3) : (n3 = u.onrejectionhandled) && n3({ promise: t3, reason: t3._v });
          });
        }, R = function(t3) {
          var n3 = this;
          n3._d || (n3._d = true, n3 = n3._w || n3, n3._v = t3, n3._s = 2, n3._a || (n3._a = n3._c.slice()), A(n3, true));
        }, F = function(t3) {
          var n3, r2 = this;
          if (!r2._d) {
            r2._d = true, r2 = r2._w || r2;
            try {
              if (r2 === t3) throw m("Promise can't be resolved itself");
              (n3 = E(t3)) ? _(function() {
                var e2 = { _w: r2, _d: false };
                try {
                  n3.call(t3, s(F, e2, 1), s(R, e2, 1));
                } catch (t4) {
                  R.call(e2, t4);
                }
              }) : (r2._v = t3, r2._s = 1, A(r2, false));
            } catch (t4) {
              R.call({ _w: r2, _d: false }, t4);
            }
          }
        };
        j || (g = function(t3) {
          v(this, g, x, "_h"), l(t3), e.call(this);
          try {
            t3(s(F, this, 1), s(R, this, 1));
          } catch (t4) {
            R.call(this, t4);
          }
        }, e = function(t3) {
          this._c = [], this._a = void 0, this._s = 0, this._d = false, this._v = void 0, this._h = 0, this._n = false;
        }, e.prototype = r(56)(g.prototype, { then: function(t3, n3) {
          var r2 = P(d(this, g));
          return r2.ok = "function" != typeof t3 || t3, r2.fail = "function" == typeof n3 && n3, r2.domain = b ? w.domain : void 0, this._c.push(r2), this._a && this._a.push(r2), this._s && A(this, false), r2.promise;
        }, catch: function(t3) {
          return this.then(void 0, t3);
        } }), M = function() {
          var t3 = new e();
          this.promise = t3, this.resolve = s(F, t3, 1), this.reject = s(R, t3, 1);
        }), a(a.G + a.W + a.F * !j, { Promise: g }), r(18)(g, x), r(59)(x), i = r(6)[x], a(a.S + a.F * !j, x, { reject: function(t3) {
          var n3 = P(this), r2 = n3.reject;
          return r2(t3), n3.promise;
        } }), a(a.S + a.F * (c || !j), x, { resolve: function(t3) {
          if (t3 instanceof g && S(t3.constructor, this)) return t3;
          var n3 = P(this), r2 = n3.resolve;
          return r2(t3), n3.promise;
        } }), a(a.S + a.F * !(j && r(46)(function(t3) {
          g.all(t3).catch(O);
        })), x, { all: function(t3) {
          var n3 = this, r2 = P(n3), e2 = r2.resolve, o2 = r2.reject, i2 = T(function() {
            var r3 = [], i3 = 0, c2 = 1;
            h(t3, false, function(t4) {
              var u2 = i3++, s2 = false;
              r3.push(void 0), c2++, n3.resolve(t4).then(function(t5) {
                s2 || (s2 = true, r3[u2] = t5, --c2 || e2(r3));
              }, o2);
            }), --c2 || e2(r3);
          });
          return i2 && o2(i2.error), r2.promise;
        }, race: function(t3) {
          var n3 = this, r2 = P(n3), e2 = r2.reject, o2 = T(function() {
            h(t3, false, function(t4) {
              n3.resolve(t4).then(r2.resolve, e2);
            });
          });
          return o2 && e2(o2.error), r2.promise;
        } });
      }, function(t2, n2, r) {
        "use strict";
        var e = r(61)(true);
        r(27)(String, "String", function(t3) {
          this._t = String(t3), this._i = 0;
        }, function() {
          var t3, n3 = this._t, r2 = this._i;
          return r2 >= n3.length ? { value: void 0, done: true } : (t3 = e(n3, r2), this._i += t3.length, { value: t3, done: false });
        });
      }, function(t2, n2, r) {
        r(65);
        for (var e = r(2), o = r(5), i = r(10), c = r(1)("toStringTag"), u = ["NodeList", "DOMTokenList", "MediaList", "StyleSheetList", "CSSRuleList"], s = 0; s < 5; s++) {
          var f = u[s], a = e[f], p = a && a.prototype;
          p && !p[c] && o(p, c, f), i[f] = i.Array;
        }
      }, function(t2, n2) {
        t2.exports = require("child_process");
      }, function(t2, n2) {
        t2.exports = require("crypto");
      }]);
    });
  }
});

// index.ts
var index_exports = {};
__export(index_exports, {
  LOG_TAG: () => LOG_TAG,
  default: () => index_default
});
module.exports = __toCommonJS(index_exports);
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
var import_package = __toESM(require("./package.json"), 1);

// src/client.ts
var HttpError = class extends Error {
  constructor(message, status, statusText, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
};
var LLMShieldClient = class {
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 3e4;
    const fn = options.fetchFn ?? globalThis.fetch;
    if (!fn) {
      throw new Error("global fetch is unavailable. Please provide a fetch polyfill in your environment or pass an implementation via fetchFn.");
    }
    this.fetchFn = fn.bind(globalThis);
  }
  // -------- Internal utility methods --------
  async postJson(path3, body, extraHeaders) {
    const url = `${this.baseUrl}${path3}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          ...extraHeaders
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
      const text = await resp.text();
      if (resp.status !== 200) {
        let parsed = text;
        try {
          parsed = text ? JSON.parse(text) : text;
        } catch {
        }
        throw new HttpError(`Request failed with status ${resp.status}`, resp.status, resp.statusText, parsed);
      }
      try {
        return text ? JSON.parse(text) : {};
      } catch (e) {
        throw new Error(`JSON parsing failed: ${e.message}`, { cause: e });
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
  // -------- Public methods --------
  /**
   * Check endpoint connectivity
   */
  async ping() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5e3);
    try {
      const url = `${this.baseUrl}/v2/moderate`;
      const resp = await this.fetchFn(url, {
        method: "OPTIONS",
        // Use OPTIONS or a simple GET to check connectivity
        signal: controller.signal
      });
      return !!resp.status;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timeoutId);
    }
  }
  /**
   * Non-streaming moderation, corresponds to Go Client.Moderate.
   */
  async moderate(request, extraHeaders) {
    const body = request ?? {};
    return this.postJson("/v2/moderate", body, extraHeaders);
  }
};

// src/utils.ts
var import_node_os = __toESM(require("node:os"), 1);
var import_node_crypto = __toESM(require("node:crypto"), 1);
var import_node_machine_id = __toESM(require_dist(), 1);

// src/labels.ts
var LabelToTranslationMap = {
  "10102000": { zh: "\u654F\u611F\u5185\u5BB9", en: "Sensitive Content" },
  "10103005": { zh: "\u8C29\u9A82", en: "Abuse" },
  "10104000": { zh: "\u8272\u60C5", en: "Pornography" },
  "10107000": { zh: "\u654F\u611F\u5185\u5BB9", en: "Sensitive Content" },
  "10109000": { zh: "\u5546\u4E1A\u654F\u611F\u5185\u5BB9", en: "Commercial Sensitive Content" },
  "10112000": { zh: "\u6B67\u89C6", en: "Discrimination" },
  "10113002": { zh: "\u6BD2\u54C1", en: "Drugs" },
  "10113003": { zh: "\u8D4C\u535A", en: "Gambling" },
  "10113004": { zh: "\u8BC8\u9A97", en: "Fraud" },
  "10116000": { zh: "\u654F\u611F\u5185\u5BB9", en: "Sensitive Content" },
  "10302000": { zh: "\u94F6\u884C\u5361\u53F7", en: "Bank Card Number" },
  "10302100": { zh: "\u94F6\u884C\u5361\u53F7", en: "Bank Card Number" },
  "10302200": { zh: "\u94F6\u884C\u5361\u53F7", en: "Bank Card Number" },
  "10304000": { zh: "\u8EAB\u4EFD\u8BC1\u53F7", en: "ID Card Number" },
  "10304100": { zh: "\u8EAB\u4EFD\u8BC1\u53F7", en: "ID Card Number" },
  "10304200": { zh: "\u8EAB\u4EFD\u8BC1\u53F7", en: "ID Card Number" },
  "10310000": { zh: "\u7535\u5B50\u90AE\u7BB1", en: "Email Address" },
  "10310100": { zh: "\u7535\u5B50\u90AE\u7BB1", en: "Email Address" },
  "10310200": { zh: "\u7535\u5B50\u90AE\u7BB1", en: "Email Address" },
  "10313000": { zh: "\u7535\u8BDD\u53F7\u7801", en: "Phone Number" },
  "10313100": { zh: "\u7535\u8BDD\u53F7\u7801", en: "Phone Number" },
  "10313200": { zh: "\u7535\u8BDD\u53F7\u7801", en: "Phone Number" },
  "10322000": { zh: "\u9690\u79C1\u6570\u636E", en: "Privacy Data" },
  "10322100": { zh: "\u9690\u79C1\u6570\u636E", en: "Privacy Data" },
  "10322200": { zh: "\u9690\u79C1\u6570\u636E", en: "Privacy Data" },
  "10400000": { zh: "\u63D0\u793A\u8BCD\u653B\u51FB", en: "Prompt Attack" },
  "10400100": { zh: "\u63D0\u793A\u8BCD\u653B\u51FB", en: "Prompt Attack" },
  "10401001": { zh: "\u89D2\u8272\u626E\u6F14\u653B\u51FB", en: "Role Playing Attack" },
  "10401101": { zh: "\u89D2\u8272\u626E\u6F14\u653B\u51FB", en: "Role Playing Attack" },
  "10401002": { zh: "\u6743\u9650\u63D0\u5347\u653B\u51FB", en: "Privilege Escalation Attack" },
  "10401102": { zh: "\u6743\u9650\u63D0\u5347\u653B\u51FB", en: "Privilege Escalation Attack" },
  "10401003": { zh: "\u5BF9\u6297\u524D\u540E\u7F00\u653B\u51FB", en: "Adversarial Prefix/Suffix Attack" },
  "10401103": { zh: "\u5BF9\u6297\u524D\u540E\u7F00\u653B\u51FB", en: "Adversarial Prefix/Suffix Attack" },
  "10401004": { zh: "\u76EE\u6807\u52AB\u6301\u653B\u51FB", en: "Target Hijacking Attack" },
  "10401104": { zh: "\u76EE\u6807\u52AB\u6301\u653B\u51FB", en: "Target Hijacking Attack" },
  "10401005": { zh: "\u6DF7\u6DC6\u548C\u7F16\u7801\u653B\u51FB", en: "Obfuscation and Encoding Attack" },
  "10401105": { zh: "\u6DF7\u6DC6\u548C\u7F16\u7801\u653B\u51FB", en: "Obfuscation and Encoding Attack" },
  "10401008": { zh: "\u5C11\u91CF\u793A\u4F8B\u653B\u51FB", en: "Few-shot Example Attack" },
  "10401108": { zh: "\u5C11\u91CF\u793A\u4F8B\u653B\u51FB", en: "Few-shot Example Attack" },
  "10402003": { zh: "\u7A83\u53D6\u63D0\u793A\u8BCD", en: "Prompt Stealing" },
  "10402103": { zh: "\u7A83\u53D6\u63D0\u793A\u8BCD", en: "Prompt Stealing" },
  "10401013": { zh: "URL\u6E32\u67D3\u548C\u8BF7\u6C42\u653B\u51FB", en: "URL Rendering and Requesting Attack" },
  "10401007": { zh: "\u6307\u4EE4\u8865\u9F50\u653B\u51FB", en: "Instruction Completion Attack" },
  "10401107": { zh: "\u6307\u4EE4\u8865\u9F50\u653B\u51FB", en: "Instruction Completion Attack" },
  "10401011": { zh: "\u53CD\u5411\u8BF1\u5BFC\u653B\u51FB", en: "Reverse Induction Attack" },
  "10401111": { zh: "\u53CD\u5411\u8BF1\u5BFC\u653B\u51FB", en: "Reverse Induction Attack" },
  "10401012": { zh: "\u4EE3\u7801\u5316\u63CF\u8FF0\u653B\u51FB", en: "Coded Description Attack" },
  "10401112": { zh: "\u4EE3\u7801\u5316\u63CF\u8FF0\u653B\u51FB", en: "Coded Description Attack" },
  "10402001": { zh: "\u8BF1\u5BFC\u751F\u6210\u6709\u5BB3\u5185\u5BB9\u653B\u51FB", en: "Inducing Harmful Content Attack" },
  "10402101": { zh: "\u8BF1\u5BFC\u751F\u6210\u6709\u5BB3\u5185\u5BB9\u653B\u51FB", en: "Inducing Harmful Content Attack" },
  "10401014": { zh: "\u8FDC\u7A0B\u4EE3\u7801\u6267\u884C\u653B\u51FB", en: "Remote Code Execution Attack" },
  "10401114": { zh: "\u8FDC\u7A0B\u4EE3\u7801\u6267\u884C\u653B\u51FB", en: "Remote Code Execution Attack" },
  "10401015": { zh: "\u63D2\u4EF6\u6295\u6BD2\u653B\u51FB", en: "Plugin Poisoning Attack" },
  "10401115": { zh: "\u63D2\u4EF6\u6295\u6BD2\u653B\u51FB", en: "Plugin Poisoning Attack" },
  "10401016": { zh: "\u654F\u611F\u64CD\u4F5C", en: "Sensitive Actions" },
  "10401116": { zh: "\u654F\u611F\u64CD\u4F5C", en: "Sensitive Actions" },
  "10401017": { zh: "\u9759\u9ED8\u7A83\u53D6", en: "Silent Exfiltration" },
  "10401117": { zh: "\u9759\u9ED8\u7A83\u53D6", en: "Silent Exfiltration" }
};
var isUserDefinedLabel = (label) => {
  const labelNum = parseInt(label, 10);
  return labelNum >= 5e7 && labelNum <= 50099999;
};
var getLabelName = (label, lang = "en") => {
  if (LabelToTranslationMap[label]) {
    return LabelToTranslationMap[label][lang];
  }
  if (isUserDefinedLabel(label)) {
    return lang === "zh" ? "\u7528\u6237\u81EA\u5B9A\u4E49\u6807\u7B7E" : "User Defined Label";
  }
  return label;
};

// src/utils.ts
function getDeviceFingerprint() {
  return (0, import_node_machine_id.machineIdSync)();
}
function getLocalIP12() {
  const interfaces = import_node_os.default.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address.split(".").map((part) => part.padStart(3, "0")).join("");
      }
    }
  }
  return "000000000000";
}
function generateRequestId() {
  const now = /* @__PURE__ */ new Date();
  const dateStr = now.getFullYear().toString() + (now.getMonth() + 1).toString().padStart(2, "0") + now.getDate().toString().padStart(2, "0") + now.getHours().toString().padStart(2, "0") + now.getMinutes().toString().padStart(2, "0") + now.getSeconds().toString().padStart(2, "0");
  const ipStr = getLocalIP12();
  const msStr = now.getMilliseconds().toString().padStart(3, "0");
  const randStr = Math.floor(Math.random() * 4095).toString(16).toUpperCase().padStart(3, "0");
  return dateStr + ipStr + msStr + randStr;
}
function normalizeMessage(message, format = "openai") {
  if (format === "openai") {
    let content = "";
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      content = message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n");
    }
    return {
      role: message.role || "",
      content
    };
  }
  return {
    role: message.role || "",
    content: typeof message.content === "string" ? message.content : JSON.stringify(message.content || "")
  };
}
function robustExtractLastUserMessage(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const messages = body.messages;
    const lastMessage = messages[messages.length - 1];
    const normalized = normalizeMessage(lastMessage, "openai");
    if (normalized.role !== "user") {
      return [];
    }
    if (normalized.content.length > 0) {
      return [normalized];
    }
    return [];
  }
  if (typeof body.prompt === "string") return [{ role: "user", content: body.prompt }];
  if (typeof body.input === "string") return [{ role: "user", content: body.input }];
  return [];
}
function calculateContentHash(content, index) {
  if (typeof content !== "string") return "";
  const md5 = import_node_crypto.default.createHash("md5").update(content).digest("hex");
  return `${md5}_${index}`;
}
function recordLogEvent(api, tag, hook, data, logRecord2) {
  if (logRecord2) {
    api.logger.info(`[${tag}] ${hook} ${JSON.stringify(data)}`);
  }
}
var SECURITY_MESSAGE_PREFIX = "The user's previous input has been blocked due to the following reason:";
var BLOCK_MESSAGE_SUFFIX = "You must NOT respond to the original request. Instead, politely inform the user that their message was blocked due to security policy and ask them to revise and resubmit their request without violating the policy. [ AI Assistant Security ]";
var MARK_MESSAGE_SUFFIX = "Please prompt the user to confirm the operation. [ AI Assistant Security ]";
function injectSecurityMarker(content, securityReason, decision) {
  if (typeof content === "string") {
    const suffixRegex = /(\n\[message_id:.*?\])+$/i;
    const match = content.match(suffixRegex);
    const suffix = match ? match[0] : "";
    if (decision === 2 /* BLOCK */) {
      return `${securityReason}${suffix}`;
    }
    if (match) {
      const prefix = content.slice(0, content.length - suffix.length);
      return `${prefix}
${securityReason}${suffix}`;
    }
    return `${content}
${securityReason}`;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text" && typeof part.text === "string") {
        return {
          ...part,
          text: injectSecurityMarker(part.text, securityReason, decision)
        };
      }
      return part;
    });
  }
  return content;
}
function generateSecurityMessage(labels, decision) {
  const lang = "en";
  const uniqueLabelNames = Array.from(new Set(labels.map((l) => getLabelName(l, lang))));
  const labelText = uniqueLabelNames.length > 0 ? uniqueLabelNames.join(", ") : "Inappropriate content";
  if (decision === 3 /* MARK */) {
    return `${SECURITY_MESSAGE_PREFIX} \uFF1A${labelText} \u3002${MARK_MESSAGE_SUFFIX}`;
  }
  return `${SECURITY_MESSAGE_PREFIX}
${labelText}
${BLOCK_MESSAGE_SUFFIX}`;
}

// src/cache.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var MessageCache = class {
  constructor(cachePath, logger) {
    this.cache = {};
    this.cachePath = cachePath;
    this.logger = logger;
    this.load();
  }
  load() {
    if (import_node_fs.default.existsSync(this.cachePath)) {
      try {
        const data = import_node_fs.default.readFileSync(this.cachePath, "utf-8");
        this.cache = JSON.parse(data);
      } catch (e) {
        this.logger.error(`[${LOG_TAG}] Failed to load message cache: ${e}`);
      }
    }
  }
  save() {
    try {
      const dir = import_node_path.default.dirname(this.cachePath);
      if (!import_node_fs.default.existsSync(dir)) {
        import_node_fs.default.mkdirSync(dir, { recursive: true });
      }
      import_node_fs.default.writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (e) {
      this.logger.error(`[${LOG_TAG}] Failed to save message cache: ${e}`);
    }
  }
  get(key) {
    const entry = this.cache[key];
    if (entry) {
      return { reason: entry.reason, decision: entry.decision };
    }
    return void 0;
  }
  set(key, reason, decision) {
    this.cache[key] = {
      reason,
      decision,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.save();
  }
  cleanup(api) {
    this.logger.info(`[${LOG_TAG}] Starting message cache cleanup...`);
    const agentsDir = api.resolvePath("agents");
    if (!import_node_fs.default.existsSync(agentsDir)) {
      this.logger.warn(`[${LOG_TAG}] Agents directory not found at ${agentsDir}`);
      return;
    }
    this.logger.info(`[${LOG_TAG}] Agents directory: ${agentsDir}`);
    const activeKeys = /* @__PURE__ */ new Set();
    try {
      const agents = import_node_fs.default.readdirSync(agentsDir);
      for (const agentName of agents) {
        const agentPath = import_node_path.default.join(agentsDir, agentName);
        if (!import_node_fs.default.statSync(agentPath).isDirectory()) continue;
        const sessionsDir = import_node_path.default.join(agentPath, "sessions");
        const sessionsJsonPath = import_node_path.default.join(sessionsDir, "sessions.json");
        if (!import_node_fs.default.existsSync(sessionsJsonPath)) continue;
        const sessionsData = JSON.parse(import_node_fs.default.readFileSync(sessionsJsonPath, "utf-8"));
        const sessionFiles = [];
        if (Array.isArray(sessionsData)) {
          sessionsData.forEach((s) => {
            if (s.sessionFile) sessionFiles.push(s.sessionFile);
          });
        } else if (typeof sessionsData === "object" && sessionsData !== null) {
          Object.values(sessionsData).forEach((s) => {
            if (s.sessionFile) sessionFiles.push(s.sessionFile);
          });
        }
        for (const sessionFile of sessionFiles) {
          const fullSessionPath = import_node_path.default.isAbsolute(sessionFile) ? sessionFile : import_node_path.default.join(sessionsDir, sessionFile);
          if (!import_node_fs.default.existsSync(fullSessionPath)) continue;
          const content = import_node_fs.default.readFileSync(fullSessionPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line);
              if (item.type === "message" && item.message) {
                const normalized = normalizeMessage(item.message, "openai");
                if (normalized.role === "user" && normalized.content) {
                  const key = calculateContentHash(normalized.content, i);
                  if (key) activeKeys.add(key);
                }
              }
            } catch (e) {
            }
          }
        }
      }
      let removedCount = 0;
      for (const key in this.cache) {
        if (!activeKeys.has(key)) {
          delete this.cache[key];
          removedCount++;
        }
      }
      if (removedCount > 0) {
        this.save();
        this.logger.info(`[${LOG_TAG}] Cache cleanup completed. Removed ${removedCount} stale entries.`);
      } else {
        this.logger.info(`[${LOG_TAG}] Cache cleanup completed. No stale entries found.`);
      }
    } catch (e) {
      this.logger.error(`[${LOG_TAG}] Failed to cleanup message cache: ${e}`);
    }
  }
};

// src/security.ts
var isDegraded = false;
var isProbing = false;
var consecutiveFailures = 0;
var lastRetryTime = 0;
var failureThreshold = 3;
var baseRetryIntervalMs = 60 * 1e3;
var currentRetryIntervalMs = baseRetryIntervalMs;
var maxRetryIntervalMs = 3600 * 1e3;
var deviceFingerprint = "";
function setSecurityConfig(config) {
  if (config.failureThreshold !== void 0) failureThreshold = config.failureThreshold;
  if (config.baseRetryIntervalMs !== void 0) {
    baseRetryIntervalMs = config.baseRetryIntervalMs;
    currentRetryIntervalMs = baseRetryIntervalMs;
  }
  if (config.maxRetryIntervalMs !== void 0) maxRetryIntervalMs = config.maxRetryIntervalMs;
  if (config.deviceFingerprint !== void 0) deviceFingerprint = config.deviceFingerprint;
}
async function checkContentSecurity(api, client, sceneId, multiPart, role, source, enableLogging, history) {
  if (isDegraded) {
    const now = Date.now();
    if (now - lastRetryTime > currentRetryIntervalMs && !isProbing) {
      isProbing = true;
      api.logger.info(`[${LOG_TAG}] In degradation state, sending single probe request...`);
      try {
        await client.moderate(
          {
            Message: {
              Role: "user",
              MultiPart: [
                {
                  Content: "hello",
                  ContentType: 1 /* TEXT */
                }
              ]
            },
            Scene: sceneId
          },
          {
            "X-Ai-Device-Fingerprint": deviceFingerprint
          }
        );
        api.logger.info(`[${LOG_TAG}] Endpoint recovered, resetting degradation flag.`);
        isDegraded = false;
        isProbing = false;
        consecutiveFailures = 0;
        currentRetryIntervalMs = baseRetryIntervalMs;
      } catch (e) {
        lastRetryTime = Date.now();
        isProbing = false;
        currentRetryIntervalMs = Math.min(currentRetryIntervalMs * 2, maxRetryIntervalMs);
        api.logger.warn(
          `[${LOG_TAG}] Probe failed, next retry in ${Math.round(currentRetryIntervalMs / 1e3)}s.`
        );
        return { labels: [] };
      }
    } else {
      return { labels: [] };
    }
  }
  const requestId = generateRequestId();
  const loggedHistory = history?.map((m) => ({
    ...m,
    Content: m.Content && m.Content.length > 100 ? m.Content.substring(0, 100) + "..." : m.Content
  }));
  recordLogEvent(
    api,
    LOG_TAG,
    `${source}(check)`,
    { multiPart, role, appId: sceneId, requestId, history: loggedHistory },
    enableLogging
  );
  let attempt = 0;
  const maxAttempts = 2;
  while (attempt < maxAttempts) {
    try {
      const response = await client.moderate(
        {
          Message: {
            Role: role,
            MultiPart: multiPart
          },
          Scene: sceneId,
          History: history
        },
        {
          "X-Top-Request-Id": requestId,
          "X-Ai-Device-Fingerprint": deviceFingerprint
        }
      );
      recordLogEvent(api, LOG_TAG, `${source}(result)`, { response, requestId }, enableLogging);
      consecutiveFailures = 0;
      currentRetryIntervalMs = baseRetryIntervalMs;
      const decision = response.Result?.Decision?.DecisionType;
      const labels = response.Result?.RiskInfo?.Risks?.map((r) => r.Label) || [];
      return { decision, labels };
    } catch (error) {
      attempt++;
      const isTimeout = error?.name === "AbortError" || error?.message?.includes("timeout");
      const isTransient = isTimeout || error?.status >= 500 && error?.status < 600;
      const errorMsg = isTimeout ? "Moderation timed out" : String(error);
      if (isTransient && attempt < maxAttempts) {
        api.logger.warn(
          `[${LOG_TAG}] Transient error (${errorMsg}), retrying... (${attempt}/${maxAttempts - 1})`
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      consecutiveFailures++;
      recordLogEvent(
        api,
        LOG_TAG,
        `${source}(error)`,
        { error: errorMsg, requestId, consecutiveFailures },
        enableLogging
      );
      console.error(
        `Moderation failed (${source}) [RID:${requestId}] [Failures:${consecutiveFailures}]:`,
        errorMsg
      );
      if (consecutiveFailures >= failureThreshold) {
        isDegraded = true;
        lastRetryTime = Date.now();
        api.logger.error(
          `[${LOG_TAG}] Consecutive failures reached threshold (${failureThreshold}), entering degradation state. Next retry in ${Math.round(
            currentRetryIntervalMs / 1e3
          )}s.`
        );
      }
      return { labels: [] };
    }
  }
  return { labels: [] };
}

// src/interceptor.ts
var setupFetchInterceptor = (config) => {
  const { api, client, sceneId, enableLogging, messageCache, shieldEndpoint } = config;
  const originalFetch = global.fetch;
  const newFetch = async function(...args) {
    const url = args[0]?.toString() || "";
    const options = args[1] || {};
    if (shieldEndpoint && url.includes(shieldEndpoint)) {
      return originalFetch.apply(this, args);
    }
    if (options.body) {
      let messagesToModerate = [];
      let rawBody, jsonBody;
      let bodyChanged = false;
      if (typeof options.body === "string") {
        rawBody = options.body;
      } else if (options.body instanceof Uint8Array || options.body instanceof ArrayBuffer) {
        rawBody = new TextDecoder().decode(options.body);
      }
      if (rawBody) {
        try {
          jsonBody = JSON.parse(rawBody);
          if (jsonBody && Array.isArray(jsonBody.messages)) {
            jsonBody.messages.forEach((m, idx) => {
              const normalized = normalizeMessage(m, "openai");
              if (normalized.role === "user" && normalized.content) {
                const cacheKey = calculateContentHash(normalized.content, idx);
                if (cacheKey) {
                  const cached = messageCache.get(cacheKey);
                  if (cached) {
                    const newContent = injectSecurityMarker(m.content, cached.reason, cached.decision);
                    if (JSON.stringify(newContent) !== JSON.stringify(m.content)) {
                      m.content = newContent;
                      bodyChanged = true;
                    }
                  }
                }
              }
            });
          }
          messagesToModerate = robustExtractLastUserMessage(jsonBody);
        } catch (e) {
          recordLogEvent(api, LOG_TAG, "json_parse_failed", { url, error: String(e) }, enableLogging);
        }
      }
      if (messagesToModerate.length > 0) {
        const msg = messagesToModerate[0];
        let historyV2;
        if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 1) {
          const historyMessages = jsonBody.messages.slice(0, -1).filter((m) => m.role !== "system").slice(-5);
          historyV2 = historyMessages.map((m) => {
            const normalized = normalizeMessage(m, "openai");
            return {
              Role: normalized.role || "user",
              Content: normalized.content,
              ContentType: 1 /* TEXT */
            };
          });
        }
        const { decision, labels } = await checkContentSecurity(
          api,
          client,
          sceneId,
          [
            {
              Content: msg.content,
              ContentType: 1 /* TEXT */
            }
          ],
          msg.role,
          "llm_request",
          enableLogging,
          historyV2
        );
        if (decision === 2 /* BLOCK */ || decision === 3 /* MARK */) {
          const securityReason = generateSecurityMessage(labels, decision);
          const lastIndex = (jsonBody?.messages?.length || 1) - 1;
          const cacheKey = calculateContentHash(msg.content, lastIndex);
          if (cacheKey) {
            messageCache.set(cacheKey, securityReason, decision);
          }
          const logPrefix = decision === 2 /* BLOCK */ ? "block" : "mark";
          api.logger.error(`[${LOG_TAG}] llm_request ${logPrefix}: ${securityReason}`);
          recordLogEvent(
            api,
            LOG_TAG,
            `llm_request(${logPrefix})`,
            { securityReason, originalContent: msg.content },
            enableLogging
          );
          if (jsonBody && Array.isArray(jsonBody.messages) && jsonBody.messages.length > 0) {
            const lastMsg = jsonBody.messages[jsonBody.messages.length - 1];
            lastMsg.content = injectSecurityMarker(lastMsg.content, securityReason, decision);
            bodyChanged = true;
          } else if (jsonBody && typeof jsonBody.prompt === "string") {
            jsonBody.prompt = injectSecurityMarker(jsonBody.prompt, securityReason, decision);
            bodyChanged = true;
          } else if (jsonBody && typeof jsonBody.input === "string") {
            jsonBody.input = injectSecurityMarker(jsonBody.input, securityReason, decision);
            bodyChanged = true;
          }
        }
        if (bodyChanged) {
          options.body = JSON.stringify(jsonBody);
        }
      }
    }
    const resp = await originalFetch.apply(this, args);
    return resp;
  };
  global.fetch = newFetch;
};

// index.ts
var LOG_TAG = `${import_package.default.name} ${import_package.default.version}`;
var logRecord = false;
var enableFetch = true;
var enableBeforeToolCall = true;
var enableAfterToolCall = true;
var plugin = {
  id: "ai-assistant-security-openclaw",
  name: import_package.default.name,
  description: "AI Assistant Security plugin for OpenClaw, to protect your LLM models and Agent lifecycle (including tool calls) from harmful requests.",
  register(api) {
    let stateDir;
    const pluginCfg = api.pluginConfig ?? {};
    const { endpoint, apiKey, appId } = pluginCfg;
    if (pluginCfg.logRecord !== void 0) {
      logRecord = Boolean(pluginCfg.logRecord);
    }
    if (pluginCfg.openClawDir !== void 0) {
      stateDir = pluginCfg.openClawDir;
    } else {
      stateDir = api.runtime.state.resolveStateDir();
      api.logger.info(`[${LOG_TAG}] State directory: ${stateDir}`);
    }
    if (pluginCfg.enableFetch !== void 0) {
      enableFetch = Boolean(pluginCfg.enableFetch);
    }
    if (pluginCfg.enableBeforeToolCall !== void 0) {
      enableBeforeToolCall = Boolean(pluginCfg.enableBeforeToolCall);
    }
    if (pluginCfg.enableAfterToolCall !== void 0) {
      enableAfterToolCall = Boolean(pluginCfg.enableAfterToolCall);
    }
    if (!deviceFingerprint) {
      setSecurityConfig({ deviceFingerprint: getDeviceFingerprint() });
    }
    const messageCachePath = import_node_path2.default.join(stateDir, "ai-assistant-security-openclaw_cache.json");
    const messageCache = new MessageCache(messageCachePath, api.logger);
    setSecurityConfig({
      failureThreshold: pluginCfg.failureThreshold !== void 0 ? Number(pluginCfg.failureThreshold) : void 0,
      baseRetryIntervalMs: pluginCfg.retryInterval !== void 0 ? Number(pluginCfg.retryInterval) * 1e3 : void 0,
      maxRetryIntervalMs: pluginCfg.maxRetryInterval !== void 0 ? Number(pluginCfg.maxRetryInterval) * 1e3 : void 0
    });
    if (!apiKey || !appId || !endpoint) {
      api.logger.error(
        `[${LOG_TAG}] Registration failed: apiKey or appId or endpoint is empty, please check the configuration.`
      );
      return;
    }
    const client = new LLMShieldClient({
      baseUrl: endpoint,
      apiKey,
      timeoutMs: pluginCfg.timeoutMs ? Number(pluginCfg.timeoutMs) : void 0
    });
    (async () => {
      api.logger.info(`[${LOG_TAG}] Verifying configuration with moderate interface: ${endpoint}...`);
      try {
        await client.moderate(
          {
            Message: {
              Role: "user",
              MultiPart: [
                {
                  Content: "hello",
                  ContentType: 1 /* TEXT */
                }
              ]
            },
            Scene: appId
          },
          {
            "X-Ai-Device-Fingerprint": deviceFingerprint
          }
        );
      } catch (e) {
        api.logger.error(
          `[${LOG_TAG}] Registration failed: Verification failed for endpoint ${endpoint}. Please check your network, apiKey, or appId configuration. Error: ${e.message || e}`
        );
        return;
      }
      if (enableFetch) {
        setupFetchInterceptor({
          api,
          client,
          sceneId: appId,
          enableLogging: logRecord,
          messageCache,
          shieldEndpoint: endpoint
        });
      }
      if (enableBeforeToolCall) {
        api.on("before_tool_call", async (event, ctx) => {
          if (!ctx.agentId || !ctx.sessionKey) {
            return;
          }
          let historyV2 = [];
          let thinkingContent = "";
          try {
            if (stateDir && ctx.agentId && ctx.sessionKey) {
              const sessionsJsonPath = import_node_path2.default.join(stateDir, "agents", ctx.agentId, "sessions", "sessions.json");
              if (import_node_fs2.default.existsSync(sessionsJsonPath)) {
                const sessionsData = JSON.parse(import_node_fs2.default.readFileSync(sessionsJsonPath, "utf-8"));
                const sessionInfo = sessionsData[ctx.sessionKey];
                if (sessionInfo && sessionInfo.sessionFile) {
                  const sessionFile = sessionInfo.sessionFile;
                  const fullSessionPath = import_node_path2.default.isAbsolute(sessionFile) ? sessionFile : import_node_path2.default.join(import_node_path2.default.dirname(sessionsJsonPath), sessionFile);
                  if (import_node_fs2.default.existsSync(fullSessionPath)) {
                    const sessionContent = import_node_fs2.default.readFileSync(fullSessionPath, "utf-8");
                    const lines = sessionContent.split("\n").filter((l) => l.trim());
                    if (lines.length > 0) {
                      let lastUserText = "";
                      for (let i = lines.length - 1; i >= 0; i--) {
                        try {
                          const item = JSON.parse(lines[i]);
                          if (item.type === "message" && item.message) {
                            const msg = item.message;
                            if (!lastUserText) {
                              const normalized = normalizeMessage(msg, "openai");
                              if (normalized.role === "user") {
                                lastUserText = normalized.content;
                              }
                            }
                            if (!thinkingContent && msg.role === "assistant" && Array.isArray(msg.content)) {
                              const matchedToolCall = msg.content.find(
                                (c) => c.type === "toolCall" && c.name === event.toolName && JSON.stringify(c.arguments) === JSON.stringify(event.params)
                              );
                              const thinking = msg.content.find((c) => c.type === "thinking");
                              if (matchedToolCall && thinking) {
                                thinkingContent = thinking.thinking || "";
                              }
                            }
                            if (lastUserText && thinkingContent) {
                              break;
                            }
                          }
                        } catch (e) {
                        }
                      }
                      if (lastUserText) {
                        historyV2 = [
                          {
                            Role: "user",
                            Content: lastUserText,
                            ContentType: 1 /* TEXT */
                          }
                        ];
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {
            api.logger.error(`[${LOG_TAG}] Failed to extract session history: ${e}`);
          }
          let content = `Tool: ${event.toolName}, Params: ${JSON.stringify(event.params)}`;
          if (thinkingContent) {
            content = `${thinkingContent}
${content}`;
          }
          const { decision, labels } = await checkContentSecurity(
            api,
            client,
            appId,
            [
              {
                Content: content,
                ContentType: 1 /* TEXT */
              }
            ],
            "assistant",
            "before_tool_call",
            logRecord,
            historyV2.length > 0 ? historyV2 : void 0
          );
          if (decision === 2 /* BLOCK */) {
            const blockReason = generateSecurityMessage(labels, decision);
            recordLogEvent(
              api,
              LOG_TAG,
              "before_tool_call(block)",
              { blockReason, originalContent: content },
              logRecord
            );
            return { block: true, blockReason };
          }
        });
      }
      if (enableAfterToolCall) {
        api.on("after_tool_call", async (event, ctx) => {
          if (event.durationMs) {
            return;
          }
          const content = `ToolName:${event.toolName}
Params: ${JSON.stringify(
            event.params
          )}
Result: ${JSON.stringify(event.result)}`;
          const { decision, labels } = await checkContentSecurity(
            api,
            client,
            appId,
            [
              {
                Content: content,
                ContentType: 1 /* TEXT */
              }
            ],
            "tool",
            "after_tool_call",
            logRecord
          );
          if (decision === 2 /* BLOCK */) {
            const blockReason = generateSecurityMessage(labels, decision);
            recordLogEvent(
              api,
              LOG_TAG,
              "after_tool_call(block)",
              { blockReason, originalContent: content },
              logRecord
            );
            const interceptedData = {
              error: "Intercepted",
              message: "The result has been intercepted.",
              reason: blockReason
            };
            event.result.content = [
              {
                type: "text",
                text: JSON.stringify(interceptedData, null, 2)
              }
            ];
            event.result.details = interceptedData;
            return;
          }
        });
      }
      api.logger.info(
        `[${LOG_TAG}] Plugin successfully initialized and registered hook points (fetch:${enableFetch}, beforeToolCall:${enableBeforeToolCall}, afterToolCall:${enableAfterToolCall}).`
      );
    })();
  }
};
var index_default = plugin;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LOG_TAG
});
