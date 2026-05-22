import { t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#region node_modules/bignumber.js/bignumber.js
var require_bignumber = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(function(globalObject) {
		"use strict";
		var BigNumber, isNumeric = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i, mathceil = Math.ceil, mathfloor = Math.floor, bignumberError = "[BigNumber Error] ", tooManyDigits = bignumberError + "Number primitive has more than 15 significant digits: ", BASE = 0x5af3107a4000, LOG_BASE = 14, MAX_SAFE_INTEGER = 9007199254740991, POWS_TEN = [
			1,
			10,
			100,
			1e3,
			1e4,
			1e5,
			1e6,
			1e7,
			1e8,
			1e9,
			1e10,
			1e11,
			0xe8d4a51000,
			0x9184e72a000
		], SQRT_BASE = 1e7, MAX = 1e9;
		function clone(configObject) {
			var div, convertBase, parseNumeric, P = BigNumber.prototype = {
				constructor: BigNumber,
				toString: null,
				valueOf: null
			}, ONE = new BigNumber(1), DECIMAL_PLACES = 20, ROUNDING_MODE = 4, TO_EXP_NEG = -7, TO_EXP_POS = 21, MIN_EXP = -1e7, MAX_EXP = 1e7, CRYPTO = false, MODULO_MODE = 1, POW_PRECISION = 0, FORMAT = {
				prefix: "",
				groupSize: 3,
				secondaryGroupSize: 0,
				groupSeparator: ",",
				decimalSeparator: ".",
				fractionGroupSize: 0,
				fractionGroupSeparator: "\xA0",
				suffix: ""
			}, ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz", alphabetHasNormalDecimalDigits = true;
			function BigNumber(v, b) {
				var alphabet, c, caseChanged, e, i, isNum, len, str, x = this;
				if (!(x instanceof BigNumber)) return new BigNumber(v, b);
				if (b == null) {
					if (v && v._isBigNumber === true) {
						x.s = v.s;
						if (!v.c || v.e > MAX_EXP) x.c = x.e = null;
						else if (v.e < MIN_EXP) x.c = [x.e = 0];
						else {
							x.e = v.e;
							x.c = v.c.slice();
						}
						return;
					}
					if ((isNum = typeof v == "number") && v * 0 == 0) {
						x.s = 1 / v < 0 ? (v = -v, -1) : 1;
						if (v === ~~v) {
							for (e = 0, i = v; i >= 10; i /= 10, e++);
							if (e > MAX_EXP) x.c = x.e = null;
							else {
								x.e = e;
								x.c = [v];
							}
							return;
						}
						str = String(v);
					} else {
						if (!isNumeric.test(str = String(v))) return parseNumeric(x, str, isNum);
						x.s = str.charCodeAt(0) == 45 ? (str = str.slice(1), -1) : 1;
					}
					if ((e = str.indexOf(".")) > -1) str = str.replace(".", "");
					if ((i = str.search(/e/i)) > 0) {
						if (e < 0) e = i;
						e += +str.slice(i + 1);
						str = str.substring(0, i);
					} else if (e < 0) e = str.length;
				} else {
					intCheck(b, 2, ALPHABET.length, "Base");
					if (b == 10 && alphabetHasNormalDecimalDigits) {
						x = new BigNumber(v);
						return round(x, DECIMAL_PLACES + x.e + 1, ROUNDING_MODE);
					}
					str = String(v);
					if (isNum = typeof v == "number") {
						if (v * 0 != 0) return parseNumeric(x, str, isNum, b);
						x.s = 1 / v < 0 ? (str = str.slice(1), -1) : 1;
						if (BigNumber.DEBUG && str.replace(/^0\.0*|\./, "").length > 15) throw Error(tooManyDigits + v);
					} else x.s = str.charCodeAt(0) === 45 ? (str = str.slice(1), -1) : 1;
					alphabet = ALPHABET.slice(0, b);
					e = i = 0;
					for (len = str.length; i < len; i++) if (alphabet.indexOf(c = str.charAt(i)) < 0) {
						if (c == ".") {
							if (i > e) {
								e = len;
								continue;
							}
						} else if (!caseChanged) {
							if (str == str.toUpperCase() && (str = str.toLowerCase()) || str == str.toLowerCase() && (str = str.toUpperCase())) {
								caseChanged = true;
								i = -1;
								e = 0;
								continue;
							}
						}
						return parseNumeric(x, String(v), isNum, b);
					}
					isNum = false;
					str = convertBase(str, b, 10, x.s);
					if ((e = str.indexOf(".")) > -1) str = str.replace(".", "");
					else e = str.length;
				}
				for (i = 0; str.charCodeAt(i) === 48; i++);
				for (len = str.length; str.charCodeAt(--len) === 48;);
				if (str = str.slice(i, ++len)) {
					len -= i;
					if (isNum && BigNumber.DEBUG && len > 15 && (v > MAX_SAFE_INTEGER || v !== mathfloor(v))) throw Error(tooManyDigits + x.s * v);
					if ((e = e - i - 1) > MAX_EXP) x.c = x.e = null;
					else if (e < MIN_EXP) x.c = [x.e = 0];
					else {
						x.e = e;
						x.c = [];
						i = (e + 1) % LOG_BASE;
						if (e < 0) i += LOG_BASE;
						if (i < len) {
							if (i) x.c.push(+str.slice(0, i));
							for (len -= LOG_BASE; i < len;) x.c.push(+str.slice(i, i += LOG_BASE));
							i = LOG_BASE - (str = str.slice(i)).length;
						} else i -= len;
						for (; i--; str += "0");
						x.c.push(+str);
					}
				} else x.c = [x.e = 0];
			}
			BigNumber.clone = clone;
			BigNumber.ROUND_UP = 0;
			BigNumber.ROUND_DOWN = 1;
			BigNumber.ROUND_CEIL = 2;
			BigNumber.ROUND_FLOOR = 3;
			BigNumber.ROUND_HALF_UP = 4;
			BigNumber.ROUND_HALF_DOWN = 5;
			BigNumber.ROUND_HALF_EVEN = 6;
			BigNumber.ROUND_HALF_CEIL = 7;
			BigNumber.ROUND_HALF_FLOOR = 8;
			BigNumber.EUCLID = 9;
			BigNumber.config = BigNumber.set = function(obj) {
				var p, v;
				if (obj != null) if (typeof obj == "object") {
					if (obj.hasOwnProperty(p = "DECIMAL_PLACES")) {
						v = obj[p];
						intCheck(v, 0, MAX, p);
						DECIMAL_PLACES = v;
					}
					if (obj.hasOwnProperty(p = "ROUNDING_MODE")) {
						v = obj[p];
						intCheck(v, 0, 8, p);
						ROUNDING_MODE = v;
					}
					if (obj.hasOwnProperty(p = "EXPONENTIAL_AT")) {
						v = obj[p];
						if (v && v.pop) {
							intCheck(v[0], -MAX, 0, p);
							intCheck(v[1], 0, MAX, p);
							TO_EXP_NEG = v[0];
							TO_EXP_POS = v[1];
						} else {
							intCheck(v, -MAX, MAX, p);
							TO_EXP_NEG = -(TO_EXP_POS = v < 0 ? -v : v);
						}
					}
					if (obj.hasOwnProperty(p = "RANGE")) {
						v = obj[p];
						if (v && v.pop) {
							intCheck(v[0], -MAX, -1, p);
							intCheck(v[1], 1, MAX, p);
							MIN_EXP = v[0];
							MAX_EXP = v[1];
						} else {
							intCheck(v, -MAX, MAX, p);
							if (v) MIN_EXP = -(MAX_EXP = v < 0 ? -v : v);
							else throw Error(bignumberError + p + " cannot be zero: " + v);
						}
					}
					if (obj.hasOwnProperty(p = "CRYPTO")) {
						v = obj[p];
						if (v === !!v) if (v) if (typeof crypto != "undefined" && crypto && (crypto.getRandomValues || crypto.randomBytes)) CRYPTO = v;
						else {
							CRYPTO = !v;
							throw Error(bignumberError + "crypto unavailable");
						}
						else CRYPTO = v;
						else throw Error(bignumberError + p + " not true or false: " + v);
					}
					if (obj.hasOwnProperty(p = "MODULO_MODE")) {
						v = obj[p];
						intCheck(v, 0, 9, p);
						MODULO_MODE = v;
					}
					if (obj.hasOwnProperty(p = "POW_PRECISION")) {
						v = obj[p];
						intCheck(v, 0, MAX, p);
						POW_PRECISION = v;
					}
					if (obj.hasOwnProperty(p = "FORMAT")) {
						v = obj[p];
						if (typeof v == "object") FORMAT = v;
						else throw Error(bignumberError + p + " not an object: " + v);
					}
					if (obj.hasOwnProperty(p = "ALPHABET")) {
						v = obj[p];
						if (typeof v == "string" && !/^.?$|[+\-.\s]|(.).*\1/.test(v)) {
							alphabetHasNormalDecimalDigits = v.slice(0, 10) == "0123456789";
							ALPHABET = v;
						} else throw Error(bignumberError + p + " invalid: " + v);
					}
				} else throw Error(bignumberError + "Object expected: " + obj);
				return {
					DECIMAL_PLACES,
					ROUNDING_MODE,
					EXPONENTIAL_AT: [TO_EXP_NEG, TO_EXP_POS],
					RANGE: [MIN_EXP, MAX_EXP],
					CRYPTO,
					MODULO_MODE,
					POW_PRECISION,
					FORMAT,
					ALPHABET
				};
			};
			BigNumber.isBigNumber = function(v) {
				if (!v || v._isBigNumber !== true) return false;
				if (!BigNumber.DEBUG) return true;
				var i, n, c = v.c, e = v.e, s = v.s;
				out: if ({}.toString.call(c) == "[object Array]") {
					if ((s === 1 || s === -1) && e >= -MAX && e <= MAX && e === mathfloor(e)) {
						if (c[0] === 0) {
							if (e === 0 && c.length === 1) return true;
							break out;
						}
						i = (e + 1) % LOG_BASE;
						if (i < 1) i += LOG_BASE;
						if (String(c[0]).length == i) {
							for (i = 0; i < c.length; i++) {
								n = c[i];
								if (n < 0 || n >= BASE || n !== mathfloor(n)) break out;
							}
							if (n !== 0) return true;
						}
					}
				} else if (c === null && e === null && (s === null || s === 1 || s === -1)) return true;
				throw Error(bignumberError + "Invalid BigNumber: " + v);
			};
			BigNumber.maximum = BigNumber.max = function() {
				return maxOrMin(arguments, -1);
			};
			BigNumber.minimum = BigNumber.min = function() {
				return maxOrMin(arguments, 1);
			};
			BigNumber.random = (function() {
				var pow2_53 = 9007199254740992;
				var random53bitInt = Math.random() * pow2_53 & 2097151 ? function() {
					return mathfloor(Math.random() * pow2_53);
				} : function() {
					return (Math.random() * 1073741824 | 0) * 8388608 + (Math.random() * 8388608 | 0);
				};
				return function(dp) {
					var a, b, e, k, v, i = 0, c = [], rand = new BigNumber(ONE);
					if (dp == null) dp = DECIMAL_PLACES;
					else intCheck(dp, 0, MAX);
					k = mathceil(dp / LOG_BASE);
					if (CRYPTO) if (crypto.getRandomValues) {
						a = crypto.getRandomValues(new Uint32Array(k *= 2));
						for (; i < k;) {
							v = a[i] * 131072 + (a[i + 1] >>> 11);
							if (v >= 9e15) {
								b = crypto.getRandomValues(new Uint32Array(2));
								a[i] = b[0];
								a[i + 1] = b[1];
							} else {
								c.push(v % 0x5af3107a4000);
								i += 2;
							}
						}
						i = k / 2;
					} else if (crypto.randomBytes) {
						a = crypto.randomBytes(k *= 7);
						for (; i < k;) {
							v = (a[i] & 31) * 281474976710656 + a[i + 1] * 1099511627776 + a[i + 2] * 4294967296 + a[i + 3] * 16777216 + (a[i + 4] << 16) + (a[i + 5] << 8) + a[i + 6];
							if (v >= 9e15) crypto.randomBytes(7).copy(a, i);
							else {
								c.push(v % 0x5af3107a4000);
								i += 7;
							}
						}
						i = k / 7;
					} else {
						CRYPTO = false;
						throw Error(bignumberError + "crypto unavailable");
					}
					if (!CRYPTO) for (; i < k;) {
						v = random53bitInt();
						if (v < 9e15) c[i++] = v % 0x5af3107a4000;
					}
					k = c[--i];
					dp %= LOG_BASE;
					if (k && dp) {
						v = POWS_TEN[LOG_BASE - dp];
						c[i] = mathfloor(k / v) * v;
					}
					for (; c[i] === 0; c.pop(), i--);
					if (i < 0) c = [e = 0];
					else {
						for (e = -1; c[0] === 0; c.splice(0, 1), e -= LOG_BASE);
						for (i = 1, v = c[0]; v >= 10; v /= 10, i++);
						if (i < LOG_BASE) e -= LOG_BASE - i;
					}
					rand.e = e;
					rand.c = c;
					return rand;
				};
			})();
			BigNumber.sum = function() {
				var i = 1, args = arguments, sum = new BigNumber(args[0]);
				for (; i < args.length;) sum = sum.plus(args[i++]);
				return sum;
			};
			convertBase = (function() {
				var decimal = "0123456789";
				function toBaseOut(str, baseIn, baseOut, alphabet) {
					var j, arr = [0], arrL, i = 0, len = str.length;
					for (; i < len;) {
						for (arrL = arr.length; arrL--; arr[arrL] *= baseIn);
						arr[0] += alphabet.indexOf(str.charAt(i++));
						for (j = 0; j < arr.length; j++) if (arr[j] > baseOut - 1) {
							if (arr[j + 1] == null) arr[j + 1] = 0;
							arr[j + 1] += arr[j] / baseOut | 0;
							arr[j] %= baseOut;
						}
					}
					return arr.reverse();
				}
				return function(str, baseIn, baseOut, sign, callerIsToString) {
					var alphabet, d, e, k, r, x, xc, y, i = str.indexOf("."), dp = DECIMAL_PLACES, rm = ROUNDING_MODE;
					if (i >= 0) {
						k = POW_PRECISION;
						POW_PRECISION = 0;
						str = str.replace(".", "");
						y = new BigNumber(baseIn);
						x = y.pow(str.length - i);
						POW_PRECISION = k;
						y.c = toBaseOut(toFixedPoint(coeffToString(x.c), x.e, "0"), 10, baseOut, decimal);
						y.e = y.c.length;
					}
					xc = toBaseOut(str, baseIn, baseOut, callerIsToString ? (alphabet = ALPHABET, decimal) : (alphabet = decimal, ALPHABET));
					e = k = xc.length;
					for (; xc[--k] == 0; xc.pop());
					if (!xc[0]) return alphabet.charAt(0);
					if (i < 0) --e;
					else {
						x.c = xc;
						x.e = e;
						x.s = sign;
						x = div(x, y, dp, rm, baseOut);
						xc = x.c;
						r = x.r;
						e = x.e;
					}
					d = e + dp + 1;
					i = xc[d];
					k = baseOut / 2;
					r = r || d < 0 || xc[d + 1] != null;
					r = rm < 4 ? (i != null || r) && (rm == 0 || rm == (x.s < 0 ? 3 : 2)) : i > k || i == k && (rm == 4 || r || rm == 6 && xc[d - 1] & 1 || rm == (x.s < 0 ? 8 : 7));
					if (d < 1 || !xc[0]) str = r ? toFixedPoint(alphabet.charAt(1), -dp, alphabet.charAt(0)) : alphabet.charAt(0);
					else {
						xc.length = d;
						if (r) for (--baseOut; ++xc[--d] > baseOut;) {
							xc[d] = 0;
							if (!d) {
								++e;
								xc = [1].concat(xc);
							}
						}
						for (k = xc.length; !xc[--k];);
						for (i = 0, str = ""; i <= k; str += alphabet.charAt(xc[i++]));
						str = toFixedPoint(str, e, alphabet.charAt(0));
					}
					return str;
				};
			})();
			div = (function() {
				function multiply(x, k, base) {
					var m, temp, xlo, xhi, carry = 0, i = x.length, klo = k % SQRT_BASE, khi = k / SQRT_BASE | 0;
					for (x = x.slice(); i--;) {
						xlo = x[i] % SQRT_BASE;
						xhi = x[i] / SQRT_BASE | 0;
						m = khi * xlo + xhi * klo;
						temp = klo * xlo + m % SQRT_BASE * SQRT_BASE + carry;
						carry = (temp / base | 0) + (m / SQRT_BASE | 0) + khi * xhi;
						x[i] = temp % base;
					}
					if (carry) x = [carry].concat(x);
					return x;
				}
				function compare(a, b, aL, bL) {
					var i, cmp;
					if (aL != bL) cmp = aL > bL ? 1 : -1;
					else for (i = cmp = 0; i < aL; i++) if (a[i] != b[i]) {
						cmp = a[i] > b[i] ? 1 : -1;
						break;
					}
					return cmp;
				}
				function subtract(a, b, aL, base) {
					var i = 0;
					for (; aL--;) {
						a[aL] -= i;
						i = a[aL] < b[aL] ? 1 : 0;
						a[aL] = i * base + a[aL] - b[aL];
					}
					for (; !a[0] && a.length > 1; a.splice(0, 1));
				}
				return function(x, y, dp, rm, base) {
					var cmp, e, i, more, n, prod, prodL, q, qc, rem, remL, rem0, xi, xL, yc0, yL, yz, s = x.s == y.s ? 1 : -1, xc = x.c, yc = y.c;
					if (!xc || !xc[0] || !yc || !yc[0]) return new BigNumber(!x.s || !y.s || (xc ? yc && xc[0] == yc[0] : !yc) ? NaN : xc && xc[0] == 0 || !yc ? s * 0 : s / 0);
					q = new BigNumber(s);
					qc = q.c = [];
					e = x.e - y.e;
					s = dp + e + 1;
					if (!base) {
						base = BASE;
						e = bitFloor(x.e / LOG_BASE) - bitFloor(y.e / LOG_BASE);
						s = s / LOG_BASE | 0;
					}
					for (i = 0; yc[i] == (xc[i] || 0); i++);
					if (yc[i] > (xc[i] || 0)) e--;
					if (s < 0) {
						qc.push(1);
						more = true;
					} else {
						xL = xc.length;
						yL = yc.length;
						i = 0;
						s += 2;
						n = mathfloor(base / (yc[0] + 1));
						if (n > 1) {
							yc = multiply(yc, n, base);
							xc = multiply(xc, n, base);
							yL = yc.length;
							xL = xc.length;
						}
						xi = yL;
						rem = xc.slice(0, yL);
						remL = rem.length;
						for (; remL < yL; rem[remL++] = 0);
						yz = yc.slice();
						yz = [0].concat(yz);
						yc0 = yc[0];
						if (yc[1] >= base / 2) yc0++;
						do {
							n = 0;
							cmp = compare(yc, rem, yL, remL);
							if (cmp < 0) {
								rem0 = rem[0];
								if (yL != remL) rem0 = rem0 * base + (rem[1] || 0);
								n = mathfloor(rem0 / yc0);
								if (n > 1) {
									if (n >= base) n = base - 1;
									prod = multiply(yc, n, base);
									prodL = prod.length;
									remL = rem.length;
									while (compare(prod, rem, prodL, remL) == 1) {
										n--;
										subtract(prod, yL < prodL ? yz : yc, prodL, base);
										prodL = prod.length;
										cmp = 1;
									}
								} else {
									if (n == 0) cmp = n = 1;
									prod = yc.slice();
									prodL = prod.length;
								}
								if (prodL < remL) prod = [0].concat(prod);
								subtract(rem, prod, remL, base);
								remL = rem.length;
								if (cmp == -1) while (compare(yc, rem, yL, remL) < 1) {
									n++;
									subtract(rem, yL < remL ? yz : yc, remL, base);
									remL = rem.length;
								}
							} else if (cmp === 0) {
								n++;
								rem = [0];
							}
							qc[i++] = n;
							if (rem[0]) rem[remL++] = xc[xi] || 0;
							else {
								rem = [xc[xi]];
								remL = 1;
							}
						} while ((xi++ < xL || rem[0] != null) && s--);
						more = rem[0] != null;
						if (!qc[0]) qc.splice(0, 1);
					}
					if (base == BASE) {
						for (i = 1, s = qc[0]; s >= 10; s /= 10, i++);
						round(q, dp + (q.e = i + e * LOG_BASE - 1) + 1, rm, more);
					} else {
						q.e = e;
						q.r = +more;
					}
					return q;
				};
			})();
			function format(n, i, rm, id) {
				var c0, e, ne, len, str;
				if (rm == null) rm = ROUNDING_MODE;
				else intCheck(rm, 0, 8);
				if (!n.c) return n.toString();
				c0 = n.c[0];
				ne = n.e;
				if (i == null) {
					str = coeffToString(n.c);
					str = id == 1 || id == 2 && (ne <= TO_EXP_NEG || ne >= TO_EXP_POS) ? toExponential(str, ne) : toFixedPoint(str, ne, "0");
				} else {
					n = round(new BigNumber(n), i, rm);
					e = n.e;
					str = coeffToString(n.c);
					len = str.length;
					if (id == 1 || id == 2 && (i <= e || e <= TO_EXP_NEG)) {
						for (; len < i; str += "0", len++);
						str = toExponential(str, e);
					} else {
						i -= ne + (id === 2 && e > ne);
						str = toFixedPoint(str, e, "0");
						if (e + 1 > len) {
							if (--i > 0) for (str += "."; i--; str += "0");
						} else {
							i += e - len;
							if (i > 0) {
								if (e + 1 == len) str += ".";
								for (; i--; str += "0");
							}
						}
					}
				}
				return n.s < 0 && c0 ? "-" + str : str;
			}
			function maxOrMin(args, n) {
				var k, y, i = 1, x = new BigNumber(args[0]);
				for (; i < args.length; i++) {
					y = new BigNumber(args[i]);
					if (!y.s || (k = compare(x, y)) === n || k === 0 && x.s === n) x = y;
				}
				return x;
			}
			function normalise(n, c, e) {
				var i = 1, j = c.length;
				for (; !c[--j]; c.pop());
				for (j = c[0]; j >= 10; j /= 10, i++);
				if ((e = i + e * LOG_BASE - 1) > MAX_EXP) n.c = n.e = null;
				else if (e < MIN_EXP) n.c = [n.e = 0];
				else {
					n.e = e;
					n.c = c;
				}
				return n;
			}
			parseNumeric = (function() {
				var basePrefix = /^(-?)0([xbo])(?=\w[\w.]*$)/i, dotAfter = /^([^.]+)\.$/, dotBefore = /^\.([^.]+)$/, isInfinityOrNaN = /^-?(Infinity|NaN)$/, whitespaceOrPlus = /^\s*\+(?=[\w.])|^\s+|\s+$/g;
				return function(x, str, isNum, b) {
					var base, s = isNum ? str : str.replace(whitespaceOrPlus, "");
					if (isInfinityOrNaN.test(s)) x.s = isNaN(s) ? null : s < 0 ? -1 : 1;
					else {
						if (!isNum) {
							s = s.replace(basePrefix, function(m, p1, p2) {
								base = (p2 = p2.toLowerCase()) == "x" ? 16 : p2 == "b" ? 2 : 8;
								return !b || b == base ? p1 : m;
							});
							if (b) {
								base = b;
								s = s.replace(dotAfter, "$1").replace(dotBefore, "0.$1");
							}
							if (str != s) return new BigNumber(s, base);
						}
						if (BigNumber.DEBUG) throw Error(bignumberError + "Not a" + (b ? " base " + b : "") + " number: " + str);
						x.s = null;
					}
					x.c = x.e = null;
				};
			})();
			function round(x, sd, rm, r) {
				var d, i, j, k, n, ni, rd, xc = x.c, pows10 = POWS_TEN;
				if (xc) {
					out: {
						for (d = 1, k = xc[0]; k >= 10; k /= 10, d++);
						i = sd - d;
						if (i < 0) {
							i += LOG_BASE;
							j = sd;
							n = xc[ni = 0];
							rd = mathfloor(n / pows10[d - j - 1] % 10);
						} else {
							ni = mathceil((i + 1) / LOG_BASE);
							if (ni >= xc.length) if (r) {
								for (; xc.length <= ni; xc.push(0));
								n = rd = 0;
								d = 1;
								i %= LOG_BASE;
								j = i - LOG_BASE + 1;
							} else break out;
							else {
								n = k = xc[ni];
								for (d = 1; k >= 10; k /= 10, d++);
								i %= LOG_BASE;
								j = i - LOG_BASE + d;
								rd = j < 0 ? 0 : mathfloor(n / pows10[d - j - 1] % 10);
							}
						}
						r = r || sd < 0 || xc[ni + 1] != null || (j < 0 ? n : n % pows10[d - j - 1]);
						r = rm < 4 ? (rd || r) && (rm == 0 || rm == (x.s < 0 ? 3 : 2)) : rd > 5 || rd == 5 && (rm == 4 || r || rm == 6 && (i > 0 ? j > 0 ? n / pows10[d - j] : 0 : xc[ni - 1]) % 10 & 1 || rm == (x.s < 0 ? 8 : 7));
						if (sd < 1 || !xc[0]) {
							xc.length = 0;
							if (r) {
								sd -= x.e + 1;
								xc[0] = pows10[(LOG_BASE - sd % LOG_BASE) % LOG_BASE];
								x.e = -sd || 0;
							} else xc[0] = x.e = 0;
							return x;
						}
						if (i == 0) {
							xc.length = ni;
							k = 1;
							ni--;
						} else {
							xc.length = ni + 1;
							k = pows10[LOG_BASE - i];
							xc[ni] = j > 0 ? mathfloor(n / pows10[d - j] % pows10[j]) * k : 0;
						}
						if (r) for (;;) if (ni == 0) {
							for (i = 1, j = xc[0]; j >= 10; j /= 10, i++);
							j = xc[0] += k;
							for (k = 1; j >= 10; j /= 10, k++);
							if (i != k) {
								x.e++;
								if (xc[0] == BASE) xc[0] = 1;
							}
							break;
						} else {
							xc[ni] += k;
							if (xc[ni] != BASE) break;
							xc[ni--] = 0;
							k = 1;
						}
						for (i = xc.length; xc[--i] === 0; xc.pop());
					}
					if (x.e > MAX_EXP) x.c = x.e = null;
					else if (x.e < MIN_EXP) x.c = [x.e = 0];
				}
				return x;
			}
			function valueOf(n) {
				var str, e = n.e;
				if (e === null) return n.toString();
				str = coeffToString(n.c);
				str = e <= TO_EXP_NEG || e >= TO_EXP_POS ? toExponential(str, e) : toFixedPoint(str, e, "0");
				return n.s < 0 ? "-" + str : str;
			}
			P.absoluteValue = P.abs = function() {
				var x = new BigNumber(this);
				if (x.s < 0) x.s = 1;
				return x;
			};
			P.comparedTo = function(y, b) {
				return compare(this, new BigNumber(y, b));
			};
			P.decimalPlaces = P.dp = function(dp, rm) {
				var c, n, v, x = this;
				if (dp != null) {
					intCheck(dp, 0, MAX);
					if (rm == null) rm = ROUNDING_MODE;
					else intCheck(rm, 0, 8);
					return round(new BigNumber(x), dp + x.e + 1, rm);
				}
				if (!(c = x.c)) return null;
				n = ((v = c.length - 1) - bitFloor(this.e / LOG_BASE)) * LOG_BASE;
				if (v = c[v]) for (; v % 10 == 0; v /= 10, n--);
				if (n < 0) n = 0;
				return n;
			};
			P.dividedBy = P.div = function(y, b) {
				return div(this, new BigNumber(y, b), DECIMAL_PLACES, ROUNDING_MODE);
			};
			P.dividedToIntegerBy = P.idiv = function(y, b) {
				return div(this, new BigNumber(y, b), 0, 1);
			};
			P.exponentiatedBy = P.pow = function(n, m) {
				var half, isModExp, i, k, more, nIsBig, nIsNeg, nIsOdd, y, x = this;
				n = new BigNumber(n);
				if (n.c && !n.isInteger()) throw Error(bignumberError + "Exponent not an integer: " + valueOf(n));
				if (m != null) m = new BigNumber(m);
				nIsBig = n.e > 14;
				if (!x.c || !x.c[0] || x.c[0] == 1 && !x.e && x.c.length == 1 || !n.c || !n.c[0]) {
					y = new BigNumber(Math.pow(+valueOf(x), nIsBig ? n.s * (2 - isOdd(n)) : +valueOf(n)));
					return m ? y.mod(m) : y;
				}
				nIsNeg = n.s < 0;
				if (m) {
					if (m.c ? !m.c[0] : !m.s) return new BigNumber(NaN);
					isModExp = !nIsNeg && x.isInteger() && m.isInteger();
					if (isModExp) x = x.mod(m);
				} else if (n.e > 9 && (x.e > 0 || x.e < -1 || (x.e == 0 ? x.c[0] > 1 || nIsBig && x.c[1] >= 24e7 : x.c[0] < 8e13 || nIsBig && x.c[0] <= 9999975e7))) {
					k = x.s < 0 && isOdd(n) ? -0 : 0;
					if (x.e > -1) k = 1 / k;
					return new BigNumber(nIsNeg ? 1 / k : k);
				} else if (POW_PRECISION) k = mathceil(POW_PRECISION / LOG_BASE + 2);
				if (nIsBig) {
					half = new BigNumber(.5);
					if (nIsNeg) n.s = 1;
					nIsOdd = isOdd(n);
				} else {
					i = Math.abs(+valueOf(n));
					nIsOdd = i % 2;
				}
				y = new BigNumber(ONE);
				for (;;) {
					if (nIsOdd) {
						y = y.times(x);
						if (!y.c) break;
						if (k) {
							if (y.c.length > k) y.c.length = k;
						} else if (isModExp) y = y.mod(m);
					}
					if (i) {
						i = mathfloor(i / 2);
						if (i === 0) break;
						nIsOdd = i % 2;
					} else {
						n = n.times(half);
						round(n, n.e + 1, 1);
						if (n.e > 14) nIsOdd = isOdd(n);
						else {
							i = +valueOf(n);
							if (i === 0) break;
							nIsOdd = i % 2;
						}
					}
					x = x.times(x);
					if (k) {
						if (x.c && x.c.length > k) x.c.length = k;
					} else if (isModExp) x = x.mod(m);
				}
				if (isModExp) return y;
				if (nIsNeg) y = ONE.div(y);
				return m ? y.mod(m) : k ? round(y, POW_PRECISION, ROUNDING_MODE, more) : y;
			};
			P.integerValue = function(rm) {
				var n = new BigNumber(this);
				if (rm == null) rm = ROUNDING_MODE;
				else intCheck(rm, 0, 8);
				return round(n, n.e + 1, rm);
			};
			P.isEqualTo = P.eq = function(y, b) {
				return compare(this, new BigNumber(y, b)) === 0;
			};
			P.isFinite = function() {
				return !!this.c;
			};
			P.isGreaterThan = P.gt = function(y, b) {
				return compare(this, new BigNumber(y, b)) > 0;
			};
			P.isGreaterThanOrEqualTo = P.gte = function(y, b) {
				return (b = compare(this, new BigNumber(y, b))) === 1 || b === 0;
			};
			P.isInteger = function() {
				return !!this.c && bitFloor(this.e / LOG_BASE) > this.c.length - 2;
			};
			P.isLessThan = P.lt = function(y, b) {
				return compare(this, new BigNumber(y, b)) < 0;
			};
			P.isLessThanOrEqualTo = P.lte = function(y, b) {
				return (b = compare(this, new BigNumber(y, b))) === -1 || b === 0;
			};
			P.isNaN = function() {
				return !this.s;
			};
			P.isNegative = function() {
				return this.s < 0;
			};
			P.isPositive = function() {
				return this.s > 0;
			};
			P.isZero = function() {
				return !!this.c && this.c[0] == 0;
			};
			P.minus = function(y, b) {
				var i, j, t, xLTy, x = this, a = x.s;
				y = new BigNumber(y, b);
				b = y.s;
				if (!a || !b) return new BigNumber(NaN);
				if (a != b) {
					y.s = -b;
					return x.plus(y);
				}
				var xe = x.e / LOG_BASE, ye = y.e / LOG_BASE, xc = x.c, yc = y.c;
				if (!xe || !ye) {
					if (!xc || !yc) return xc ? (y.s = -b, y) : new BigNumber(yc ? x : NaN);
					if (!xc[0] || !yc[0]) return yc[0] ? (y.s = -b, y) : new BigNumber(xc[0] ? x : ROUNDING_MODE == 3 ? -0 : 0);
				}
				xe = bitFloor(xe);
				ye = bitFloor(ye);
				xc = xc.slice();
				if (a = xe - ye) {
					if (xLTy = a < 0) {
						a = -a;
						t = xc;
					} else {
						ye = xe;
						t = yc;
					}
					t.reverse();
					for (b = a; b--; t.push(0));
					t.reverse();
				} else {
					j = (xLTy = (a = xc.length) < (b = yc.length)) ? a : b;
					for (a = b = 0; b < j; b++) if (xc[b] != yc[b]) {
						xLTy = xc[b] < yc[b];
						break;
					}
				}
				if (xLTy) {
					t = xc;
					xc = yc;
					yc = t;
					y.s = -y.s;
				}
				b = (j = yc.length) - (i = xc.length);
				if (b > 0) for (; b--; xc[i++] = 0);
				b = BASE - 1;
				for (; j > a;) {
					if (xc[--j] < yc[j]) {
						for (i = j; i && !xc[--i]; xc[i] = b);
						--xc[i];
						xc[j] += BASE;
					}
					xc[j] -= yc[j];
				}
				for (; xc[0] == 0; xc.splice(0, 1), --ye);
				if (!xc[0]) {
					y.s = ROUNDING_MODE == 3 ? -1 : 1;
					y.c = [y.e = 0];
					return y;
				}
				return normalise(y, xc, ye);
			};
			P.modulo = P.mod = function(y, b) {
				var q, s, x = this;
				y = new BigNumber(y, b);
				if (!x.c || !y.s || y.c && !y.c[0]) return new BigNumber(NaN);
				else if (!y.c || x.c && !x.c[0]) return new BigNumber(x);
				if (MODULO_MODE == 9) {
					s = y.s;
					y.s = 1;
					q = div(x, y, 0, 3);
					y.s = s;
					q.s *= s;
				} else q = div(x, y, 0, MODULO_MODE);
				y = x.minus(q.times(y));
				if (!y.c[0] && MODULO_MODE == 1) y.s = x.s;
				return y;
			};
			P.multipliedBy = P.times = function(y, b) {
				var c, e, i, j, k, m, xcL, xlo, xhi, ycL, ylo, yhi, zc, base, sqrtBase, x = this, xc = x.c, yc = (y = new BigNumber(y, b)).c;
				if (!xc || !yc || !xc[0] || !yc[0]) {
					if (!x.s || !y.s || xc && !xc[0] && !yc || yc && !yc[0] && !xc) y.c = y.e = y.s = null;
					else {
						y.s *= x.s;
						if (!xc || !yc) y.c = y.e = null;
						else {
							y.c = [0];
							y.e = 0;
						}
					}
					return y;
				}
				e = bitFloor(x.e / LOG_BASE) + bitFloor(y.e / LOG_BASE);
				y.s *= x.s;
				xcL = xc.length;
				ycL = yc.length;
				if (xcL < ycL) {
					zc = xc;
					xc = yc;
					yc = zc;
					i = xcL;
					xcL = ycL;
					ycL = i;
				}
				for (i = xcL + ycL, zc = []; i--; zc.push(0));
				base = BASE;
				sqrtBase = SQRT_BASE;
				for (i = ycL; --i >= 0;) {
					c = 0;
					ylo = yc[i] % sqrtBase;
					yhi = yc[i] / sqrtBase | 0;
					for (k = xcL, j = i + k; j > i;) {
						xlo = xc[--k] % sqrtBase;
						xhi = xc[k] / sqrtBase | 0;
						m = yhi * xlo + xhi * ylo;
						xlo = ylo * xlo + m % sqrtBase * sqrtBase + zc[j] + c;
						c = (xlo / base | 0) + (m / sqrtBase | 0) + yhi * xhi;
						zc[j--] = xlo % base;
					}
					zc[j] = c;
				}
				if (c) ++e;
				else zc.splice(0, 1);
				return normalise(y, zc, e);
			};
			P.negated = function() {
				var x = new BigNumber(this);
				x.s = -x.s || null;
				return x;
			};
			P.plus = function(y, b) {
				var t, x = this, a = x.s;
				y = new BigNumber(y, b);
				b = y.s;
				if (!a || !b) return new BigNumber(NaN);
				if (a != b) {
					y.s = -b;
					return x.minus(y);
				}
				var xe = x.e / LOG_BASE, ye = y.e / LOG_BASE, xc = x.c, yc = y.c;
				if (!xe || !ye) {
					if (!xc || !yc) return new BigNumber(a / 0);
					if (!xc[0] || !yc[0]) return yc[0] ? y : new BigNumber(xc[0] ? x : a * 0);
				}
				xe = bitFloor(xe);
				ye = bitFloor(ye);
				xc = xc.slice();
				if (a = xe - ye) {
					if (a > 0) {
						ye = xe;
						t = yc;
					} else {
						a = -a;
						t = xc;
					}
					t.reverse();
					for (; a--; t.push(0));
					t.reverse();
				}
				a = xc.length;
				b = yc.length;
				if (a - b < 0) {
					t = yc;
					yc = xc;
					xc = t;
					b = a;
				}
				for (a = 0; b;) {
					a = (xc[--b] = xc[b] + yc[b] + a) / BASE | 0;
					xc[b] = BASE === xc[b] ? 0 : xc[b] % BASE;
				}
				if (a) {
					xc = [a].concat(xc);
					++ye;
				}
				return normalise(y, xc, ye);
			};
			P.precision = P.sd = function(sd, rm) {
				var c, n, v, x = this;
				if (sd != null && sd !== !!sd) {
					intCheck(sd, 1, MAX);
					if (rm == null) rm = ROUNDING_MODE;
					else intCheck(rm, 0, 8);
					return round(new BigNumber(x), sd, rm);
				}
				if (!(c = x.c)) return null;
				v = c.length - 1;
				n = v * LOG_BASE + 1;
				if (v = c[v]) {
					for (; v % 10 == 0; v /= 10, n--);
					for (v = c[0]; v >= 10; v /= 10, n++);
				}
				if (sd && x.e + 1 > n) n = x.e + 1;
				return n;
			};
			P.shiftedBy = function(k) {
				intCheck(k, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER);
				return this.times("1e" + k);
			};
			P.squareRoot = P.sqrt = function() {
				var m, n, r, rep, t, x = this, c = x.c, s = x.s, e = x.e, dp = DECIMAL_PLACES + 4, half = new BigNumber("0.5");
				if (s !== 1 || !c || !c[0]) return new BigNumber(!s || s < 0 && (!c || c[0]) ? NaN : c ? x : Infinity);
				s = Math.sqrt(+valueOf(x));
				if (s == 0 || s == Infinity) {
					n = coeffToString(c);
					if ((n.length + e) % 2 == 0) n += "0";
					s = Math.sqrt(+n);
					e = bitFloor((e + 1) / 2) - (e < 0 || e % 2);
					if (s == Infinity) n = "5e" + e;
					else {
						n = s.toExponential();
						n = n.slice(0, n.indexOf("e") + 1) + e;
					}
					r = new BigNumber(n);
				} else r = new BigNumber(s + "");
				if (r.c[0]) {
					e = r.e;
					s = e + dp;
					if (s < 3) s = 0;
					for (;;) {
						t = r;
						r = half.times(t.plus(div(x, t, dp, 1)));
						if (coeffToString(t.c).slice(0, s) === (n = coeffToString(r.c)).slice(0, s)) {
							if (r.e < e) --s;
							n = n.slice(s - 3, s + 1);
							if (n == "9999" || !rep && n == "4999") {
								if (!rep) {
									round(t, t.e + DECIMAL_PLACES + 2, 0);
									if (t.times(t).eq(x)) {
										r = t;
										break;
									}
								}
								dp += 4;
								s += 4;
								rep = 1;
							} else {
								if (!+n || !+n.slice(1) && n.charAt(0) == "5") {
									round(r, r.e + DECIMAL_PLACES + 2, 1);
									m = !r.times(r).eq(x);
								}
								break;
							}
						}
					}
				}
				return round(r, r.e + DECIMAL_PLACES + 1, ROUNDING_MODE, m);
			};
			P.toExponential = function(dp, rm) {
				if (dp != null) {
					intCheck(dp, 0, MAX);
					dp++;
				}
				return format(this, dp, rm, 1);
			};
			P.toFixed = function(dp, rm) {
				if (dp != null) {
					intCheck(dp, 0, MAX);
					dp = dp + this.e + 1;
				}
				return format(this, dp, rm);
			};
			P.toFormat = function(dp, rm, format) {
				var str, x = this;
				if (format == null) if (dp != null && rm && typeof rm == "object") {
					format = rm;
					rm = null;
				} else if (dp && typeof dp == "object") {
					format = dp;
					dp = rm = null;
				} else format = FORMAT;
				else if (typeof format != "object") throw Error(bignumberError + "Argument not an object: " + format);
				str = x.toFixed(dp, rm);
				if (x.c) {
					var i, arr = str.split("."), g1 = +format.groupSize, g2 = +format.secondaryGroupSize, groupSeparator = format.groupSeparator || "", intPart = arr[0], fractionPart = arr[1], isNeg = x.s < 0, intDigits = isNeg ? intPart.slice(1) : intPart, len = intDigits.length;
					if (g2) {
						i = g1;
						g1 = g2;
						g2 = i;
						len -= i;
					}
					if (g1 > 0 && len > 0) {
						i = len % g1 || g1;
						intPart = intDigits.substr(0, i);
						for (; i < len; i += g1) intPart += groupSeparator + intDigits.substr(i, g1);
						if (g2 > 0) intPart += groupSeparator + intDigits.slice(i);
						if (isNeg) intPart = "-" + intPart;
					}
					str = fractionPart ? intPart + (format.decimalSeparator || "") + ((g2 = +format.fractionGroupSize) ? fractionPart.replace(new RegExp("\\d{" + g2 + "}\\B", "g"), "$&" + (format.fractionGroupSeparator || "")) : fractionPart) : intPart;
				}
				return (format.prefix || "") + str + (format.suffix || "");
			};
			P.toFraction = function(md) {
				var d, d0, d1, d2, e, exp, n, n0, n1, q, r, s, x = this, xc = x.c;
				if (md != null) {
					n = new BigNumber(md);
					if (!n.isInteger() && (n.c || n.s !== 1) || n.lt(ONE)) throw Error(bignumberError + "Argument " + (n.isInteger() ? "out of range: " : "not an integer: ") + valueOf(n));
				}
				if (!xc) return new BigNumber(x);
				d = new BigNumber(ONE);
				n1 = d0 = new BigNumber(ONE);
				d1 = n0 = new BigNumber(ONE);
				s = coeffToString(xc);
				e = d.e = s.length - x.e - 1;
				d.c[0] = POWS_TEN[(exp = e % LOG_BASE) < 0 ? LOG_BASE + exp : exp];
				md = !md || n.comparedTo(d) > 0 ? e > 0 ? d : n1 : n;
				exp = MAX_EXP;
				MAX_EXP = Infinity;
				n = new BigNumber(s);
				n0.c[0] = 0;
				for (;;) {
					q = div(n, d, 0, 1);
					d2 = d0.plus(q.times(d1));
					if (d2.comparedTo(md) == 1) break;
					d0 = d1;
					d1 = d2;
					n1 = n0.plus(q.times(d2 = n1));
					n0 = d2;
					d = n.minus(q.times(d2 = d));
					n = d2;
				}
				d2 = div(md.minus(d0), d1, 0, 1);
				n0 = n0.plus(d2.times(n1));
				d0 = d0.plus(d2.times(d1));
				n0.s = n1.s = x.s;
				e = e * 2;
				r = div(n1, d1, e, ROUNDING_MODE).minus(x).abs().comparedTo(div(n0, d0, e, ROUNDING_MODE).minus(x).abs()) < 1 ? [n1, d1] : [n0, d0];
				MAX_EXP = exp;
				return r;
			};
			P.toNumber = function() {
				return +valueOf(this);
			};
			P.toPrecision = function(sd, rm) {
				if (sd != null) intCheck(sd, 1, MAX);
				return format(this, sd, rm, 2);
			};
			P.toString = function(b) {
				var str, n = this, s = n.s, e = n.e;
				if (e === null) if (s) {
					str = "Infinity";
					if (s < 0) str = "-" + str;
				} else str = "NaN";
				else {
					if (b == null) str = e <= TO_EXP_NEG || e >= TO_EXP_POS ? toExponential(coeffToString(n.c), e) : toFixedPoint(coeffToString(n.c), e, "0");
					else if (b === 10 && alphabetHasNormalDecimalDigits) {
						n = round(new BigNumber(n), DECIMAL_PLACES + e + 1, ROUNDING_MODE);
						str = toFixedPoint(coeffToString(n.c), n.e, "0");
					} else {
						intCheck(b, 2, ALPHABET.length, "Base");
						str = convertBase(toFixedPoint(coeffToString(n.c), e, "0"), 10, b, s, true);
					}
					if (s < 0 && n.c[0]) str = "-" + str;
				}
				return str;
			};
			P.valueOf = P.toJSON = function() {
				return valueOf(this);
			};
			P._isBigNumber = true;
			if (configObject != null) BigNumber.set(configObject);
			return BigNumber;
		}
		function bitFloor(n) {
			var i = n | 0;
			return n > 0 || n === i ? i : i - 1;
		}
		function coeffToString(a) {
			var s, z, i = 1, j = a.length, r = a[0] + "";
			for (; i < j;) {
				s = a[i++] + "";
				z = LOG_BASE - s.length;
				for (; z--; s = "0" + s);
				r += s;
			}
			for (j = r.length; r.charCodeAt(--j) === 48;);
			return r.slice(0, j + 1 || 1);
		}
		function compare(x, y) {
			var a, b, xc = x.c, yc = y.c, i = x.s, j = y.s, k = x.e, l = y.e;
			if (!i || !j) return null;
			a = xc && !xc[0];
			b = yc && !yc[0];
			if (a || b) return a ? b ? 0 : -j : i;
			if (i != j) return i;
			a = i < 0;
			b = k == l;
			if (!xc || !yc) return b ? 0 : !xc ^ a ? 1 : -1;
			if (!b) return k > l ^ a ? 1 : -1;
			j = (k = xc.length) < (l = yc.length) ? k : l;
			for (i = 0; i < j; i++) if (xc[i] != yc[i]) return xc[i] > yc[i] ^ a ? 1 : -1;
			return k == l ? 0 : k > l ^ a ? 1 : -1;
		}
		function intCheck(n, min, max, name) {
			if (n < min || n > max || n !== mathfloor(n)) throw Error(bignumberError + (name || "Argument") + (typeof n == "number" ? n < min || n > max ? " out of range: " : " not an integer: " : " not a primitive number: ") + String(n));
		}
		function isOdd(n) {
			var k = n.c.length - 1;
			return bitFloor(n.e / LOG_BASE) == k && n.c[k] % 2 != 0;
		}
		function toExponential(str, e) {
			return (str.length > 1 ? str.charAt(0) + "." + str.slice(1) : str) + (e < 0 ? "e" : "e+") + e;
		}
		function toFixedPoint(str, e, z) {
			var len, zs;
			if (e < 0) {
				for (zs = z + "."; ++e; zs += z);
				str = zs + str;
			} else {
				len = str.length;
				if (++e > len) {
					for (zs = z, e -= len; --e; zs += z);
					str += zs;
				} else if (e < len) str = str.slice(0, e) + "." + str.slice(e);
			}
			return str;
		}
		BigNumber = clone();
		BigNumber["default"] = BigNumber.BigNumber = BigNumber;
		if (typeof define == "function" && define.amd) define(function() {
			return BigNumber;
		});
		else if (typeof module != "undefined" && module.exports) module.exports = BigNumber;
		else {
			if (!globalObject) globalObject = typeof self != "undefined" && self ? self : window;
			globalObject.BigNumber = BigNumber;
		}
	})(exports);
}));
//#endregion
//#region node_modules/json-bigint/lib/stringify.js
var require_stringify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var BigNumber = require_bignumber();
	var JSON = module.exports;
	(function() {
		"use strict";
		var escapable = /[\\\"\x00-\x1f\x7f-\x9f\u00ad\u0600-\u0604\u070f\u17b4\u17b5\u200c-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff0-\uffff]/g, gap, indent, meta = {
			"\b": "\\b",
			"	": "\\t",
			"\n": "\\n",
			"\f": "\\f",
			"\r": "\\r",
			"\"": "\\\"",
			"\\": "\\\\"
		}, rep;
		function quote(string) {
			escapable.lastIndex = 0;
			return escapable.test(string) ? "\"" + string.replace(escapable, function(a) {
				var c = meta[a];
				return typeof c === "string" ? c : "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
			}) + "\"" : "\"" + string + "\"";
		}
		function str(key, holder) {
			var i, k, v, length, mind = gap, partial, value = holder[key], isBigNumber = value != null && (value instanceof BigNumber || BigNumber.isBigNumber(value));
			if (value && typeof value === "object" && typeof value.toJSON === "function") value = value.toJSON(key);
			if (typeof rep === "function") value = rep.call(holder, key, value);
			switch (typeof value) {
				case "string": if (isBigNumber) return value;
				else return quote(value);
				case "number": return isFinite(value) ? String(value) : "null";
				case "boolean":
				case "null":
				case "bigint": return String(value);
				case "object":
					if (!value) return "null";
					gap += indent;
					partial = [];
					if (Object.prototype.toString.apply(value) === "[object Array]") {
						length = value.length;
						for (i = 0; i < length; i += 1) partial[i] = str(i, value) || "null";
						v = partial.length === 0 ? "[]" : gap ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]" : "[" + partial.join(",") + "]";
						gap = mind;
						return v;
					}
					if (rep && typeof rep === "object") {
						length = rep.length;
						for (i = 0; i < length; i += 1) if (typeof rep[i] === "string") {
							k = rep[i];
							v = str(k, value);
							if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
						}
					} else Object.keys(value).forEach(function(k) {
						var v = str(k, value);
						if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
					});
					v = partial.length === 0 ? "{}" : gap ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}" : "{" + partial.join(",") + "}";
					gap = mind;
					return v;
			}
		}
		if (typeof JSON.stringify !== "function") JSON.stringify = function(value, replacer, space) {
			var i;
			gap = "";
			indent = "";
			if (typeof space === "number") for (i = 0; i < space; i += 1) indent += " ";
			else if (typeof space === "string") indent = space;
			rep = replacer;
			if (replacer && typeof replacer !== "function" && (typeof replacer !== "object" || typeof replacer.length !== "number")) throw new Error("JSON.stringify");
			return str("", { "": value });
		};
	})();
}));
//#endregion
//#region node_modules/json-bigint/lib/parse.js
var require_parse = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var BigNumber = null;
	const suspectProtoRx = /(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])/;
	const suspectConstructorRx = /(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)/;
	var json_parse = function(options) {
		"use strict";
		var _options = {
			strict: false,
			storeAsString: false,
			alwaysParseAsBig: false,
			useNativeBigInt: false,
			protoAction: "error",
			constructorAction: "error"
		};
		if (options !== void 0 && options !== null) {
			if (options.strict === true) _options.strict = true;
			if (options.storeAsString === true) _options.storeAsString = true;
			_options.alwaysParseAsBig = options.alwaysParseAsBig === true ? options.alwaysParseAsBig : false;
			_options.useNativeBigInt = options.useNativeBigInt === true ? options.useNativeBigInt : false;
			if (typeof options.constructorAction !== "undefined") if (options.constructorAction === "error" || options.constructorAction === "ignore" || options.constructorAction === "preserve") _options.constructorAction = options.constructorAction;
			else throw new Error(`Incorrect value for constructorAction option, must be "error", "ignore" or undefined but passed ${options.constructorAction}`);
			if (typeof options.protoAction !== "undefined") if (options.protoAction === "error" || options.protoAction === "ignore" || options.protoAction === "preserve") _options.protoAction = options.protoAction;
			else throw new Error(`Incorrect value for protoAction option, must be "error", "ignore" or undefined but passed ${options.protoAction}`);
		}
		var at, ch, escapee = {
			"\"": "\"",
			"\\": "\\",
			"/": "/",
			b: "\b",
			f: "\f",
			n: "\n",
			r: "\r",
			t: "	"
		}, text, error = function(m) {
			throw {
				name: "SyntaxError",
				message: m,
				at,
				text
			};
		}, next = function(c) {
			if (c && c !== ch) error("Expected '" + c + "' instead of '" + ch + "'");
			ch = text.charAt(at);
			at += 1;
			return ch;
		}, number = function() {
			var number, string = "";
			if (ch === "-") {
				string = "-";
				next("-");
			}
			while (ch >= "0" && ch <= "9") {
				string += ch;
				next();
			}
			if (ch === ".") {
				string += ".";
				while (next() && ch >= "0" && ch <= "9") string += ch;
			}
			if (ch === "e" || ch === "E") {
				string += ch;
				next();
				if (ch === "-" || ch === "+") {
					string += ch;
					next();
				}
				while (ch >= "0" && ch <= "9") {
					string += ch;
					next();
				}
			}
			number = +string;
			if (!isFinite(number)) error("Bad number");
			else {
				if (BigNumber == null) BigNumber = require_bignumber();
				if (string.length > 15) return _options.storeAsString ? string : _options.useNativeBigInt ? BigInt(string) : new BigNumber(string);
				else return !_options.alwaysParseAsBig ? number : _options.useNativeBigInt ? BigInt(number) : new BigNumber(number);
			}
		}, string = function() {
			var hex, i, string = "", uffff;
			if (ch === "\"") {
				var startAt = at;
				while (next()) {
					if (ch === "\"") {
						if (at - 1 > startAt) string += text.substring(startAt, at - 1);
						next();
						return string;
					}
					if (ch === "\\") {
						if (at - 1 > startAt) string += text.substring(startAt, at - 1);
						next();
						if (ch === "u") {
							uffff = 0;
							for (i = 0; i < 4; i += 1) {
								hex = parseInt(next(), 16);
								if (!isFinite(hex)) break;
								uffff = uffff * 16 + hex;
							}
							string += String.fromCharCode(uffff);
						} else if (typeof escapee[ch] === "string") string += escapee[ch];
						else break;
						startAt = at;
					}
				}
			}
			error("Bad string");
		}, white = function() {
			while (ch && ch <= " ") next();
		}, word = function() {
			switch (ch) {
				case "t":
					next("t");
					next("r");
					next("u");
					next("e");
					return true;
				case "f":
					next("f");
					next("a");
					next("l");
					next("s");
					next("e");
					return false;
				case "n":
					next("n");
					next("u");
					next("l");
					next("l");
					return null;
			}
			error("Unexpected '" + ch + "'");
		}, value, array = function() {
			var array = [];
			if (ch === "[") {
				next("[");
				white();
				if (ch === "]") {
					next("]");
					return array;
				}
				while (ch) {
					array.push(value());
					white();
					if (ch === "]") {
						next("]");
						return array;
					}
					next(",");
					white();
				}
			}
			error("Bad array");
		}, object = function() {
			var key, object = Object.create(null);
			if (ch === "{") {
				next("{");
				white();
				if (ch === "}") {
					next("}");
					return object;
				}
				while (ch) {
					key = string();
					white();
					next(":");
					if (_options.strict === true && Object.hasOwnProperty.call(object, key)) error("Duplicate key \"" + key + "\"");
					if (suspectProtoRx.test(key) === true) if (_options.protoAction === "error") error("Object contains forbidden prototype property");
					else if (_options.protoAction === "ignore") value();
					else object[key] = value();
					else if (suspectConstructorRx.test(key) === true) if (_options.constructorAction === "error") error("Object contains forbidden constructor property");
					else if (_options.constructorAction === "ignore") value();
					else object[key] = value();
					else object[key] = value();
					white();
					if (ch === "}") {
						next("}");
						return object;
					}
					next(",");
					white();
				}
			}
			error("Bad object");
		};
		value = function() {
			white();
			switch (ch) {
				case "{": return object();
				case "[": return array();
				case "\"": return string();
				case "-": return number();
				default: return ch >= "0" && ch <= "9" ? number() : word();
			}
		};
		return function(source, reviver) {
			var result;
			text = source + "";
			at = 0;
			ch = " ";
			result = value();
			white();
			if (ch) error("Syntax error");
			return typeof reviver === "function" ? (function walk(holder, key) {
				var v, value = holder[key];
				if (value && typeof value === "object") Object.keys(value).forEach(function(k) {
					v = walk(value, k);
					if (v !== void 0) value[k] = v;
					else delete value[k];
				});
				return reviver.call(holder, key, value);
			})({ "": result }, "") : result;
		};
	};
	module.exports = json_parse;
}));
//#endregion
//#region node_modules/json-bigint/index.js
var require_json_bigint = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var json_stringify = require_stringify().stringify;
	var json_parse = require_parse();
	module.exports = function(options) {
		return {
			parse: json_parse(options),
			stringify: json_stringify
		};
	};
	module.exports.parse = json_parse();
	module.exports.stringify = json_stringify;
}));
//#endregion
export { require_json_bigint as t };
