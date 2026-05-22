import { a as __require, t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#region node_modules/@protobufjs/aspromise/index.js
var require_aspromise = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = asPromise;
	/**
	* Callback as used by {@link util.asPromise}.
	* @typedef asPromiseCallback
	* @type {function}
	* @param {Error|null} error Error, if any
	* @param {...*} params Additional arguments
	* @returns {undefined}
	*/
	/**
	* Returns a promise from a node-style callback function.
	* @memberof util
	* @param {asPromiseCallback} fn Function to call
	* @param {*} ctx Function context
	* @param {...*} params Function arguments
	* @returns {Promise<*>} Promisified function
	*/
	function asPromise(fn, ctx) {
		var params = new Array(arguments.length - 1), offset = 0, index = 2, pending = true;
		while (index < arguments.length) params[offset++] = arguments[index++];
		return new Promise(function executor(resolve, reject) {
			params[offset] = function callback(err) {
				if (pending) {
					pending = false;
					if (err) reject(err);
					else {
						var params = new Array(arguments.length - 1), offset = 0;
						while (offset < params.length) params[offset++] = arguments[offset];
						resolve.apply(null, params);
					}
				}
			};
			try {
				fn.apply(ctx || null, params);
			} catch (err) {
				if (pending) {
					pending = false;
					reject(err);
				}
			}
		});
	}
}));
//#endregion
//#region node_modules/@protobufjs/base64/index.js
var require_base64 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* A minimal base64 implementation for number arrays.
	* @memberof util
	* @namespace
	*/
	var base64 = exports;
	/**
	* Calculates the byte length of a base64 encoded string.
	* @param {string} string Base64 encoded string
	* @returns {number} Byte length
	*/
	base64.length = function length(string) {
		var p = string.length;
		if (!p) return 0;
		var n = 0;
		while (--p % 4 > 1 && string.charAt(p) === "=") ++n;
		return Math.ceil(string.length * 3) / 4 - n;
	};
	var b64 = new Array(64);
	var s64 = new Array(123);
	for (var i = 0; i < 64;) s64[b64[i] = i < 26 ? i + 65 : i < 52 ? i + 71 : i < 62 ? i - 4 : i - 59 | 43] = i++;
	/**
	* Encodes a buffer to a base64 encoded string.
	* @param {Uint8Array} buffer Source buffer
	* @param {number} start Source start
	* @param {number} end Source end
	* @returns {string} Base64 encoded string
	*/
	base64.encode = function encode(buffer, start, end) {
		var parts = null, chunk = [];
		var i = 0, j = 0, t;
		while (start < end) {
			var b = buffer[start++];
			switch (j) {
				case 0:
					chunk[i++] = b64[b >> 2];
					t = (b & 3) << 4;
					j = 1;
					break;
				case 1:
					chunk[i++] = b64[t | b >> 4];
					t = (b & 15) << 2;
					j = 2;
					break;
				case 2:
					chunk[i++] = b64[t | b >> 6];
					chunk[i++] = b64[b & 63];
					j = 0;
					break;
			}
			if (i > 8191) {
				(parts || (parts = [])).push(String.fromCharCode.apply(String, chunk));
				i = 0;
			}
		}
		if (j) {
			chunk[i++] = b64[t];
			chunk[i++] = 61;
			if (j === 1) chunk[i++] = 61;
		}
		if (parts) {
			if (i) parts.push(String.fromCharCode.apply(String, chunk.slice(0, i)));
			return parts.join("");
		}
		return String.fromCharCode.apply(String, chunk.slice(0, i));
	};
	var invalidEncoding = "invalid encoding";
	/**
	* Decodes a base64 encoded string to a buffer.
	* @param {string} string Source string
	* @param {Uint8Array} buffer Destination buffer
	* @param {number} offset Destination offset
	* @returns {number} Number of bytes written
	* @throws {Error} If encoding is invalid
	*/
	base64.decode = function decode(string, buffer, offset) {
		var start = offset;
		var j = 0, t;
		for (var i = 0; i < string.length;) {
			var c = string.charCodeAt(i++);
			if (c === 61 && j > 1) break;
			if ((c = s64[c]) === void 0) throw Error(invalidEncoding);
			switch (j) {
				case 0:
					t = c;
					j = 1;
					break;
				case 1:
					buffer[offset++] = t << 2 | (c & 48) >> 4;
					t = c;
					j = 2;
					break;
				case 2:
					buffer[offset++] = (t & 15) << 4 | (c & 60) >> 2;
					t = c;
					j = 3;
					break;
				case 3:
					buffer[offset++] = (t & 3) << 6 | c;
					j = 0;
					break;
			}
		}
		if (j === 1) throw Error(invalidEncoding);
		return offset - start;
	};
	/**
	* Tests if the specified string appears to be base64 encoded.
	* @param {string} string String to test
	* @returns {boolean} `true` if probably base64 encoded, otherwise false
	*/
	base64.test = function test(string) {
		return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(string);
	};
}));
//#endregion
//#region node_modules/@protobufjs/eventemitter/index.js
var require_eventemitter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = EventEmitter;
	/**
	* Constructs a new event emitter instance.
	* @classdesc A minimal event emitter.
	* @memberof util
	* @constructor
	*/
	function EventEmitter() {
		/**
		* Registered listeners.
		* @type {Object.<string,*>}
		* @private
		*/
		this._listeners = {};
	}
	/**
	* Registers an event listener.
	* @param {string} evt Event name
	* @param {function} fn Listener
	* @param {*} [ctx] Listener context
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.on = function on(evt, fn, ctx) {
		(this._listeners[evt] || (this._listeners[evt] = [])).push({
			fn,
			ctx: ctx || this
		});
		return this;
	};
	/**
	* Removes an event listener or any matching listeners if arguments are omitted.
	* @param {string} [evt] Event name. Removes all listeners if omitted.
	* @param {function} [fn] Listener to remove. Removes all listeners of `evt` if omitted.
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.off = function off(evt, fn) {
		if (evt === void 0) this._listeners = {};
		else if (fn === void 0) this._listeners[evt] = [];
		else {
			var listeners = this._listeners[evt];
			for (var i = 0; i < listeners.length;) if (listeners[i].fn === fn) listeners.splice(i, 1);
			else ++i;
		}
		return this;
	};
	/**
	* Emits an event by calling its listeners with the specified arguments.
	* @param {string} evt Event name
	* @param {...*} args Arguments
	* @returns {util.EventEmitter} `this`
	*/
	EventEmitter.prototype.emit = function emit(evt) {
		var listeners = this._listeners[evt];
		if (listeners) {
			var args = [], i = 1;
			for (; i < arguments.length;) args.push(arguments[i++]);
			for (i = 0; i < listeners.length;) listeners[i].fn.apply(listeners[i++].ctx, args);
		}
		return this;
	};
}));
//#endregion
//#region node_modules/@protobufjs/float/index.js
var require_float = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = factory(factory);
	/**
	* Reads / writes floats / doubles from / to buffers.
	* @name util.float
	* @namespace
	*/
	/**
	* Writes a 32 bit float to a buffer using little endian byte order.
	* @name util.float.writeFloatLE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Writes a 32 bit float to a buffer using big endian byte order.
	* @name util.float.writeFloatBE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Reads a 32 bit float from a buffer using little endian byte order.
	* @name util.float.readFloatLE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Reads a 32 bit float from a buffer using big endian byte order.
	* @name util.float.readFloatBE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Writes a 64 bit double to a buffer using little endian byte order.
	* @name util.float.writeDoubleLE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Writes a 64 bit double to a buffer using big endian byte order.
	* @name util.float.writeDoubleBE
	* @function
	* @param {number} val Value to write
	* @param {Uint8Array} buf Target buffer
	* @param {number} pos Target buffer offset
	* @returns {undefined}
	*/
	/**
	* Reads a 64 bit double from a buffer using little endian byte order.
	* @name util.float.readDoubleLE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	/**
	* Reads a 64 bit double from a buffer using big endian byte order.
	* @name util.float.readDoubleBE
	* @function
	* @param {Uint8Array} buf Source buffer
	* @param {number} pos Source buffer offset
	* @returns {number} Value read
	*/
	function factory(exports$1) {
		if (typeof Float32Array !== "undefined") (function() {
			var f32 = new Float32Array([-0]), f8b = new Uint8Array(f32.buffer), le = f8b[3] === 128;
			function writeFloat_f32_cpy(val, buf, pos) {
				f32[0] = val;
				buf[pos] = f8b[0];
				buf[pos + 1] = f8b[1];
				buf[pos + 2] = f8b[2];
				buf[pos + 3] = f8b[3];
			}
			function writeFloat_f32_rev(val, buf, pos) {
				f32[0] = val;
				buf[pos] = f8b[3];
				buf[pos + 1] = f8b[2];
				buf[pos + 2] = f8b[1];
				buf[pos + 3] = f8b[0];
			}
			/* istanbul ignore next */
			exports$1.writeFloatLE = le ? writeFloat_f32_cpy : writeFloat_f32_rev;
			/* istanbul ignore next */
			exports$1.writeFloatBE = le ? writeFloat_f32_rev : writeFloat_f32_cpy;
			function readFloat_f32_cpy(buf, pos) {
				f8b[0] = buf[pos];
				f8b[1] = buf[pos + 1];
				f8b[2] = buf[pos + 2];
				f8b[3] = buf[pos + 3];
				return f32[0];
			}
			function readFloat_f32_rev(buf, pos) {
				f8b[3] = buf[pos];
				f8b[2] = buf[pos + 1];
				f8b[1] = buf[pos + 2];
				f8b[0] = buf[pos + 3];
				return f32[0];
			}
			/* istanbul ignore next */
			exports$1.readFloatLE = le ? readFloat_f32_cpy : readFloat_f32_rev;
			/* istanbul ignore next */
			exports$1.readFloatBE = le ? readFloat_f32_rev : readFloat_f32_cpy;
		})();
		else (function() {
			function writeFloat_ieee754(writeUint, val, buf, pos) {
				var sign = val < 0 ? 1 : 0;
				if (sign) val = -val;
				if (val === 0) writeUint(1 / val > 0 ? 0 : 2147483648, buf, pos);
				else if (isNaN(val)) writeUint(2143289344, buf, pos);
				else if (val > 34028234663852886e22) writeUint((sign << 31 | 2139095040) >>> 0, buf, pos);
				else if (val < 11754943508222875e-54) writeUint((sign << 31 | Math.round(val / 1401298464324817e-60)) >>> 0, buf, pos);
				else {
					var exponent = Math.floor(Math.log(val) / Math.LN2), mantissa = Math.round(val * Math.pow(2, -exponent) * 8388608) & 8388607;
					writeUint((sign << 31 | exponent + 127 << 23 | mantissa) >>> 0, buf, pos);
				}
			}
			exports$1.writeFloatLE = writeFloat_ieee754.bind(null, writeUintLE);
			exports$1.writeFloatBE = writeFloat_ieee754.bind(null, writeUintBE);
			function readFloat_ieee754(readUint, buf, pos) {
				var uint = readUint(buf, pos), sign = (uint >> 31) * 2 + 1, exponent = uint >>> 23 & 255, mantissa = uint & 8388607;
				return exponent === 255 ? mantissa ? NaN : sign * Infinity : exponent === 0 ? sign * 1401298464324817e-60 * mantissa : sign * Math.pow(2, exponent - 150) * (mantissa + 8388608);
			}
			exports$1.readFloatLE = readFloat_ieee754.bind(null, readUintLE);
			exports$1.readFloatBE = readFloat_ieee754.bind(null, readUintBE);
		})();
		if (typeof Float64Array !== "undefined") (function() {
			var f64 = new Float64Array([-0]), f8b = new Uint8Array(f64.buffer), le = f8b[7] === 128;
			function writeDouble_f64_cpy(val, buf, pos) {
				f64[0] = val;
				buf[pos] = f8b[0];
				buf[pos + 1] = f8b[1];
				buf[pos + 2] = f8b[2];
				buf[pos + 3] = f8b[3];
				buf[pos + 4] = f8b[4];
				buf[pos + 5] = f8b[5];
				buf[pos + 6] = f8b[6];
				buf[pos + 7] = f8b[7];
			}
			function writeDouble_f64_rev(val, buf, pos) {
				f64[0] = val;
				buf[pos] = f8b[7];
				buf[pos + 1] = f8b[6];
				buf[pos + 2] = f8b[5];
				buf[pos + 3] = f8b[4];
				buf[pos + 4] = f8b[3];
				buf[pos + 5] = f8b[2];
				buf[pos + 6] = f8b[1];
				buf[pos + 7] = f8b[0];
			}
			/* istanbul ignore next */
			exports$1.writeDoubleLE = le ? writeDouble_f64_cpy : writeDouble_f64_rev;
			/* istanbul ignore next */
			exports$1.writeDoubleBE = le ? writeDouble_f64_rev : writeDouble_f64_cpy;
			function readDouble_f64_cpy(buf, pos) {
				f8b[0] = buf[pos];
				f8b[1] = buf[pos + 1];
				f8b[2] = buf[pos + 2];
				f8b[3] = buf[pos + 3];
				f8b[4] = buf[pos + 4];
				f8b[5] = buf[pos + 5];
				f8b[6] = buf[pos + 6];
				f8b[7] = buf[pos + 7];
				return f64[0];
			}
			function readDouble_f64_rev(buf, pos) {
				f8b[7] = buf[pos];
				f8b[6] = buf[pos + 1];
				f8b[5] = buf[pos + 2];
				f8b[4] = buf[pos + 3];
				f8b[3] = buf[pos + 4];
				f8b[2] = buf[pos + 5];
				f8b[1] = buf[pos + 6];
				f8b[0] = buf[pos + 7];
				return f64[0];
			}
			/* istanbul ignore next */
			exports$1.readDoubleLE = le ? readDouble_f64_cpy : readDouble_f64_rev;
			/* istanbul ignore next */
			exports$1.readDoubleBE = le ? readDouble_f64_rev : readDouble_f64_cpy;
		})();
		else (function() {
			function writeDouble_ieee754(writeUint, off0, off1, val, buf, pos) {
				var sign = val < 0 ? 1 : 0;
				if (sign) val = -val;
				if (val === 0) {
					writeUint(0, buf, pos + off0);
					writeUint(1 / val > 0 ? 0 : 2147483648, buf, pos + off1);
				} else if (isNaN(val)) {
					writeUint(0, buf, pos + off0);
					writeUint(2146959360, buf, pos + off1);
				} else if (val > 17976931348623157e292) {
					writeUint(0, buf, pos + off0);
					writeUint((sign << 31 | 2146435072) >>> 0, buf, pos + off1);
				} else {
					var mantissa;
					if (val < 22250738585072014e-324) {
						mantissa = val / 5e-324;
						writeUint(mantissa >>> 0, buf, pos + off0);
						writeUint((sign << 31 | mantissa / 4294967296) >>> 0, buf, pos + off1);
					} else {
						var exponent = Math.floor(Math.log(val) / Math.LN2);
						if (exponent === 1024) exponent = 1023;
						mantissa = val * Math.pow(2, -exponent);
						writeUint(mantissa * 4503599627370496 >>> 0, buf, pos + off0);
						writeUint((sign << 31 | exponent + 1023 << 20 | mantissa * 1048576 & 1048575) >>> 0, buf, pos + off1);
					}
				}
			}
			exports$1.writeDoubleLE = writeDouble_ieee754.bind(null, writeUintLE, 0, 4);
			exports$1.writeDoubleBE = writeDouble_ieee754.bind(null, writeUintBE, 4, 0);
			function readDouble_ieee754(readUint, off0, off1, buf, pos) {
				var lo = readUint(buf, pos + off0), hi = readUint(buf, pos + off1);
				var sign = (hi >> 31) * 2 + 1, exponent = hi >>> 20 & 2047, mantissa = 4294967296 * (hi & 1048575) + lo;
				return exponent === 2047 ? mantissa ? NaN : sign * Infinity : exponent === 0 ? sign * 5e-324 * mantissa : sign * Math.pow(2, exponent - 1075) * (mantissa + 4503599627370496);
			}
			exports$1.readDoubleLE = readDouble_ieee754.bind(null, readUintLE, 0, 4);
			exports$1.readDoubleBE = readDouble_ieee754.bind(null, readUintBE, 4, 0);
		})();
		return exports$1;
	}
	function writeUintLE(val, buf, pos) {
		buf[pos] = val & 255;
		buf[pos + 1] = val >>> 8 & 255;
		buf[pos + 2] = val >>> 16 & 255;
		buf[pos + 3] = val >>> 24;
	}
	function writeUintBE(val, buf, pos) {
		buf[pos] = val >>> 24;
		buf[pos + 1] = val >>> 16 & 255;
		buf[pos + 2] = val >>> 8 & 255;
		buf[pos + 3] = val & 255;
	}
	function readUintLE(buf, pos) {
		return (buf[pos] | buf[pos + 1] << 8 | buf[pos + 2] << 16 | buf[pos + 3] << 24) >>> 0;
	}
	function readUintBE(buf, pos) {
		return (buf[pos] << 24 | buf[pos + 1] << 16 | buf[pos + 2] << 8 | buf[pos + 3]) >>> 0;
	}
}));
//#endregion
//#region node_modules/@protobufjs/inquire/index.js
var require_inquire = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = inquire;
	/**
	* Requires a module only if available.
	* @memberof util
	* @param {string} moduleName Module to require
	* @returns {?Object} Required module if available and not empty, otherwise `null`
	*/
	function inquire(moduleName) {
		try {
			if (typeof __require !== "function") return null;
			var mod = __require(moduleName);
			if (mod && (mod.length || Object.keys(mod).length)) return mod;
			return null;
		} catch (err) {
			return null;
		}
	}
}));
//#endregion
//#region node_modules/@protobufjs/utf8/index.js
var require_utf8 = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* A minimal UTF8 implementation for number arrays.
	* @memberof util
	* @namespace
	*/
	var utf8 = exports, replacementChar = "�";
	/**
	* Calculates the UTF8 byte length of a string.
	* @param {string} string String
	* @returns {number} Byte length
	*/
	utf8.length = function utf8_length(string) {
		var len = 0, c = 0;
		for (var i = 0; i < string.length; ++i) {
			c = string.charCodeAt(i);
			if (c < 128) len += 1;
			else if (c < 2048) len += 2;
			else if ((c & 64512) === 55296 && (string.charCodeAt(i + 1) & 64512) === 56320) {
				++i;
				len += 4;
			} else len += 3;
		}
		return len;
	};
	/**
	* Reads UTF8 bytes as a string.
	* @param {Uint8Array} buffer Source buffer
	* @param {number} start Source start
	* @param {number} end Source end
	* @returns {string} String read
	*/
	utf8.read = function utf8_read(buffer, start, end) {
		if (end - start < 1) return "";
		var str = "";
		for (var i = start; i < end;) {
			var t = buffer[i++];
			if (t <= 127) str += String.fromCharCode(t);
			else if (t >= 192 && t < 224) {
				var c2 = (t & 31) << 6 | buffer[i++] & 63;
				str += c2 >= 128 ? String.fromCharCode(c2) : replacementChar;
			} else if (t >= 224 && t < 240) {
				var c3 = (t & 15) << 12 | (buffer[i++] & 63) << 6 | buffer[i++] & 63;
				str += c3 >= 2048 ? String.fromCharCode(c3) : replacementChar;
			} else if (t >= 240) {
				var t2 = (t & 7) << 18 | (buffer[i++] & 63) << 12 | (buffer[i++] & 63) << 6 | buffer[i++] & 63;
				if (t2 < 65536 || t2 > 1114111) str += replacementChar;
				else {
					t2 -= 65536;
					str += String.fromCharCode(55296 + (t2 >> 10));
					str += String.fromCharCode(56320 + (t2 & 1023));
				}
			}
		}
		return str;
	};
	/**
	* Writes a string as UTF8 bytes.
	* @param {string} string Source string
	* @param {Uint8Array} buffer Destination buffer
	* @param {number} offset Destination offset
	* @returns {number} Bytes written
	*/
	utf8.write = function utf8_write(string, buffer, offset) {
		var start = offset, c1, c2;
		for (var i = 0; i < string.length; ++i) {
			c1 = string.charCodeAt(i);
			if (c1 < 128) buffer[offset++] = c1;
			else if (c1 < 2048) {
				buffer[offset++] = c1 >> 6 | 192;
				buffer[offset++] = c1 & 63 | 128;
			} else if ((c1 & 64512) === 55296 && ((c2 = string.charCodeAt(i + 1)) & 64512) === 56320) {
				c1 = 65536 + ((c1 & 1023) << 10) + (c2 & 1023);
				++i;
				buffer[offset++] = c1 >> 18 | 240;
				buffer[offset++] = c1 >> 12 & 63 | 128;
				buffer[offset++] = c1 >> 6 & 63 | 128;
				buffer[offset++] = c1 & 63 | 128;
			} else {
				buffer[offset++] = c1 >> 12 | 224;
				buffer[offset++] = c1 >> 6 & 63 | 128;
				buffer[offset++] = c1 & 63 | 128;
			}
		}
		return offset - start;
	};
}));
//#endregion
//#region node_modules/@protobufjs/pool/index.js
var require_pool = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = pool;
	/**
	* An allocator as used by {@link util.pool}.
	* @typedef PoolAllocator
	* @type {function}
	* @param {number} size Buffer size
	* @returns {Uint8Array} Buffer
	*/
	/**
	* A slicer as used by {@link util.pool}.
	* @typedef PoolSlicer
	* @type {function}
	* @param {number} start Start offset
	* @param {number} end End offset
	* @returns {Uint8Array} Buffer slice
	* @this {Uint8Array}
	*/
	/**
	* A general purpose buffer pool.
	* @memberof util
	* @function
	* @param {PoolAllocator} alloc Allocator
	* @param {PoolSlicer} slice Slicer
	* @param {number} [size=8192] Slab size
	* @returns {PoolAllocator} Pooled allocator
	*/
	function pool(alloc, slice, size) {
		var SIZE = size || 8192;
		var MAX = SIZE >>> 1;
		var slab = null;
		var offset = SIZE;
		return function pool_alloc(size) {
			if (size < 1 || size > MAX) return alloc(size);
			if (offset + size > SIZE) {
				slab = alloc(SIZE);
				offset = 0;
			}
			var buf = slice.call(slab, offset, offset += size);
			if (offset & 7) offset = (offset | 7) + 1;
			return buf;
		};
	}
}));
//#endregion
//#region node_modules/protobufjs/src/util/longbits.js
var require_longbits = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = LongBits;
	var util = require_minimal$1();
	/**
	* Constructs new long bits.
	* @classdesc Helper class for working with the low and high bits of a 64 bit value.
	* @memberof util
	* @constructor
	* @param {number} lo Low 32 bits, unsigned
	* @param {number} hi High 32 bits, unsigned
	*/
	function LongBits(lo, hi) {
		/**
		* Low bits.
		* @type {number}
		*/
		this.lo = lo >>> 0;
		/**
		* High bits.
		* @type {number}
		*/
		this.hi = hi >>> 0;
	}
	/**
	* Zero bits.
	* @memberof util.LongBits
	* @type {util.LongBits}
	*/
	var zero = LongBits.zero = new LongBits(0, 0);
	zero.toNumber = function() {
		return 0;
	};
	zero.zzEncode = zero.zzDecode = function() {
		return this;
	};
	zero.length = function() {
		return 1;
	};
	/**
	* Zero hash.
	* @memberof util.LongBits
	* @type {string}
	*/
	var zeroHash = LongBits.zeroHash = "\0\0\0\0\0\0\0\0";
	/**
	* Constructs new long bits from the specified number.
	* @param {number} value Value
	* @returns {util.LongBits} Instance
	*/
	LongBits.fromNumber = function fromNumber(value) {
		if (value === 0) return zero;
		var sign = value < 0;
		if (sign) value = -value;
		var lo = value >>> 0, hi = (value - lo) / 4294967296 >>> 0;
		if (sign) {
			hi = ~hi >>> 0;
			lo = ~lo >>> 0;
			if (++lo > 4294967295) {
				lo = 0;
				if (++hi > 4294967295) hi = 0;
			}
		}
		return new LongBits(lo, hi);
	};
	/**
	* Constructs new long bits from a number, long or string.
	* @param {Long|number|string} value Value
	* @returns {util.LongBits} Instance
	*/
	LongBits.from = function from(value) {
		if (typeof value === "number") return LongBits.fromNumber(value);
		if (util.isString(value))
 /* istanbul ignore else */
		if (util.Long) value = util.Long.fromString(value);
		else return LongBits.fromNumber(parseInt(value, 10));
		return value.low || value.high ? new LongBits(value.low >>> 0, value.high >>> 0) : zero;
	};
	/**
	* Converts this long bits to a possibly unsafe JavaScript number.
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {number} Possibly unsafe number
	*/
	LongBits.prototype.toNumber = function toNumber(unsigned) {
		if (!unsigned && this.hi >>> 31) {
			var lo = ~this.lo + 1 >>> 0, hi = ~this.hi >>> 0;
			if (!lo) hi = hi + 1 >>> 0;
			return -(lo + hi * 4294967296);
		}
		return this.lo + this.hi * 4294967296;
	};
	/**
	* Converts this long bits to a long.
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {Long} Long
	*/
	LongBits.prototype.toLong = function toLong(unsigned) {
		return util.Long ? new util.Long(this.lo | 0, this.hi | 0, Boolean(unsigned)) : {
			low: this.lo | 0,
			high: this.hi | 0,
			unsigned: Boolean(unsigned)
		};
	};
	var charCodeAt = String.prototype.charCodeAt;
	/**
	* Constructs new long bits from the specified 8 characters long hash.
	* @param {string} hash Hash
	* @returns {util.LongBits} Bits
	*/
	LongBits.fromHash = function fromHash(hash) {
		if (hash === zeroHash) return zero;
		return new LongBits((charCodeAt.call(hash, 0) | charCodeAt.call(hash, 1) << 8 | charCodeAt.call(hash, 2) << 16 | charCodeAt.call(hash, 3) << 24) >>> 0, (charCodeAt.call(hash, 4) | charCodeAt.call(hash, 5) << 8 | charCodeAt.call(hash, 6) << 16 | charCodeAt.call(hash, 7) << 24) >>> 0);
	};
	/**
	* Converts this long bits to a 8 characters long hash.
	* @returns {string} Hash
	*/
	LongBits.prototype.toHash = function toHash() {
		return String.fromCharCode(this.lo & 255, this.lo >>> 8 & 255, this.lo >>> 16 & 255, this.lo >>> 24, this.hi & 255, this.hi >>> 8 & 255, this.hi >>> 16 & 255, this.hi >>> 24);
	};
	/**
	* Zig-zag encodes this long bits.
	* @returns {util.LongBits} `this`
	*/
	LongBits.prototype.zzEncode = function zzEncode() {
		var mask = this.hi >> 31;
		this.hi = ((this.hi << 1 | this.lo >>> 31) ^ mask) >>> 0;
		this.lo = (this.lo << 1 ^ mask) >>> 0;
		return this;
	};
	/**
	* Zig-zag decodes this long bits.
	* @returns {util.LongBits} `this`
	*/
	LongBits.prototype.zzDecode = function zzDecode() {
		var mask = -(this.lo & 1);
		this.lo = ((this.lo >>> 1 | this.hi << 31) ^ mask) >>> 0;
		this.hi = (this.hi >>> 1 ^ mask) >>> 0;
		return this;
	};
	/**
	* Calculates the length of this longbits when encoded as a varint.
	* @returns {number} Length
	*/
	LongBits.prototype.length = function length() {
		var part0 = this.lo, part1 = (this.lo >>> 28 | this.hi << 4) >>> 0, part2 = this.hi >>> 24;
		return part2 === 0 ? part1 === 0 ? part0 < 16384 ? part0 < 128 ? 1 : 2 : part0 < 2097152 ? 3 : 4 : part1 < 16384 ? part1 < 128 ? 5 : 6 : part1 < 2097152 ? 7 : 8 : part2 < 128 ? 9 : 10;
	};
}));
//#endregion
//#region node_modules/protobufjs/src/util/minimal.js
var require_minimal$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var util = exports;
	util.asPromise = require_aspromise();
	util.base64 = require_base64();
	util.EventEmitter = require_eventemitter();
	util.float = require_float();
	util.inquire = require_inquire();
	util.utf8 = require_utf8();
	util.pool = require_pool();
	util.LongBits = require_longbits();
	/**
	* Whether running within node or not.
	* @memberof util
	* @type {boolean}
	*/
	util.isNode = Boolean(typeof global !== "undefined" && global && global.process && global.process.versions && global.process.versions.node);
	/**
	* Global object reference.
	* @memberof util
	* @type {Object}
	*/
	util.global = util.isNode && global || typeof window !== "undefined" && window || typeof self !== "undefined" && self || exports;
	/**
	* An immuable empty array.
	* @memberof util
	* @type {Array.<*>}
	* @const
	*/
	util.emptyArray = Object.freeze ? Object.freeze([]) : 	/* istanbul ignore next */ [];
	/**
	* An immutable empty object.
	* @type {Object}
	* @const
	*/
	util.emptyObject = Object.freeze ? Object.freeze({}) : 	/* istanbul ignore next */ {};
	/**
	* Tests if the specified value is an integer.
	* @function
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is an integer
	*/
	util.isInteger = Number.isInteger || function isInteger(value) {
		return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
	};
	/**
	* Tests if the specified value is a string.
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is a string
	*/
	util.isString = function isString(value) {
		return typeof value === "string" || value instanceof String;
	};
	/**
	* Tests if the specified value is a non-null object.
	* @param {*} value Value to test
	* @returns {boolean} `true` if the value is a non-null object
	*/
	util.isObject = function isObject(value) {
		return value && typeof value === "object";
	};
	/**
	* Checks if a property on a message is considered to be present.
	* This is an alias of {@link util.isSet}.
	* @function
	* @param {Object} obj Plain object or message instance
	* @param {string} prop Property name
	* @returns {boolean} `true` if considered to be present, otherwise `false`
	*/
	util.isset = util.isSet = function isSet(obj, prop) {
		var value = obj[prop];
		if (value != null && obj.hasOwnProperty(prop)) return typeof value !== "object" || (Array.isArray(value) ? value.length : Object.keys(value).length) > 0;
		return false;
	};
	/**
	* Any compatible Buffer instance.
	* This is a minimal stand-alone definition of a Buffer instance. The actual type is that exported by node's typings.
	* @interface Buffer
	* @extends Uint8Array
	*/
	/**
	* Node's Buffer class if available.
	* @type {Constructor<Buffer>}
	*/
	util.Buffer = (function() {
		try {
			var Buffer = util.inquire("buffer").Buffer;
			return Buffer.prototype.utf8Write ? Buffer : 			/* istanbul ignore next */ null;
		} catch (e) {
			/* istanbul ignore next */
			return null;
		}
	})();
	util._Buffer_from = null;
	util._Buffer_allocUnsafe = null;
	/**
	* Creates a new buffer of whatever type supported by the environment.
	* @param {number|number[]} [sizeOrArray=0] Buffer size or number array
	* @returns {Uint8Array|Buffer} Buffer
	*/
	util.newBuffer = function newBuffer(sizeOrArray) {
		/* istanbul ignore next */
		return typeof sizeOrArray === "number" ? util.Buffer ? util._Buffer_allocUnsafe(sizeOrArray) : new util.Array(sizeOrArray) : util.Buffer ? util._Buffer_from(sizeOrArray) : typeof Uint8Array === "undefined" ? sizeOrArray : new Uint8Array(sizeOrArray);
	};
	/**
	* Array implementation used in the browser. `Uint8Array` if supported, otherwise `Array`.
	* @type {Constructor<Uint8Array>}
	*/
	util.Array = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
	/**
	* Any compatible Long instance.
	* This is a minimal stand-alone definition of a Long instance. The actual type is that exported by long.js.
	* @interface Long
	* @property {number} low Low bits
	* @property {number} high High bits
	* @property {boolean} unsigned Whether unsigned or not
	*/
	/**
	* Long.js's Long class if available.
	* @type {Constructor<Long>}
	*/
	util.Long = util.global.dcodeIO && util.global.dcodeIO.Long || util.global.Long || util.inquire("long");
	/**
	* Regular expression used to verify 2 bit (`bool`) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key2Re = /^true|false|0|1$/;
	/**
	* Regular expression used to verify 32 bit (`int32` etc.) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key32Re = /^-?(?:0|[1-9][0-9]*)$/;
	/**
	* Regular expression used to verify 64 bit (`int64` etc.) map keys.
	* @type {RegExp}
	* @const
	*/
	util.key64Re = /^(?:[\\x00-\\xff]{8}|-?(?:0|[1-9][0-9]*))$/;
	/**
	* Converts a number or long to an 8 characters long hash string.
	* @param {Long|number} value Value to convert
	* @returns {string} Hash
	*/
	util.longToHash = function longToHash(value) {
		return value ? util.LongBits.from(value).toHash() : util.LongBits.zeroHash;
	};
	/**
	* Converts an 8 characters long hash string to a long or number.
	* @param {string} hash Hash
	* @param {boolean} [unsigned=false] Whether unsigned or not
	* @returns {Long|number} Original value
	*/
	util.longFromHash = function longFromHash(hash, unsigned) {
		var bits = util.LongBits.fromHash(hash);
		if (util.Long) return util.Long.fromBits(bits.lo, bits.hi, unsigned);
		return bits.toNumber(Boolean(unsigned));
	};
	/**
	* Merges the properties of the source object into the destination object.
	* @memberof util
	* @param {Object.<string,*>} dst Destination object
	* @param {Object.<string,*>} src Source object
	* @param {boolean} [ifNotSet=false] Merges only if the key is not already set
	* @returns {Object.<string,*>} Destination object
	*/
	function merge(dst, src, ifNotSet) {
		for (var keys = Object.keys(src), i = 0; i < keys.length; ++i) if (dst[keys[i]] === void 0 || !ifNotSet) dst[keys[i]] = src[keys[i]];
		return dst;
	}
	util.merge = merge;
	/**
	* Converts the first character of a string to lower case.
	* @param {string} str String to convert
	* @returns {string} Converted string
	*/
	util.lcFirst = function lcFirst(str) {
		return str.charAt(0).toLowerCase() + str.substring(1);
	};
	/**
	* Creates a custom error constructor.
	* @memberof util
	* @param {string} name Error name
	* @returns {Constructor<Error>} Custom error constructor
	*/
	function newError(name) {
		function CustomError(message, properties) {
			if (!(this instanceof CustomError)) return new CustomError(message, properties);
			Object.defineProperty(this, "message", { get: function() {
				return message;
			} });
			/* istanbul ignore next */
			if (Error.captureStackTrace) Error.captureStackTrace(this, CustomError);
			else Object.defineProperty(this, "stack", { value: (/* @__PURE__ */ new Error()).stack || "" });
			if (properties) merge(this, properties);
		}
		CustomError.prototype = Object.create(Error.prototype, {
			constructor: {
				value: CustomError,
				writable: true,
				enumerable: false,
				configurable: true
			},
			name: {
				get: function get() {
					return name;
				},
				set: void 0,
				enumerable: false,
				configurable: true
			},
			toString: {
				value: function value() {
					return this.name + ": " + this.message;
				},
				writable: true,
				enumerable: false,
				configurable: true
			}
		});
		return CustomError;
	}
	util.newError = newError;
	/**
	* Constructs a new protocol error.
	* @classdesc Error subclass indicating a protocol specifc error.
	* @memberof util
	* @extends Error
	* @template T extends Message<T>
	* @constructor
	* @param {string} message Error message
	* @param {Object.<string,*>} [properties] Additional properties
	* @example
	* try {
	*     MyMessage.decode(someBuffer); // throws if required fields are missing
	* } catch (e) {
	*     if (e instanceof ProtocolError && e.instance)
	*         console.log("decoded so far: " + JSON.stringify(e.instance));
	* }
	*/
	util.ProtocolError = newError("ProtocolError");
	/**
	* So far decoded message instance.
	* @name util.ProtocolError#instance
	* @type {Message<T>}
	*/
	/**
	* A OneOf getter as returned by {@link util.oneOfGetter}.
	* @typedef OneOfGetter
	* @type {function}
	* @returns {string|undefined} Set field name, if any
	*/
	/**
	* Builds a getter for a oneof's present field name.
	* @param {string[]} fieldNames Field names
	* @returns {OneOfGetter} Unbound getter
	*/
	util.oneOfGetter = function getOneOf(fieldNames) {
		var fieldMap = {};
		for (var i = 0; i < fieldNames.length; ++i) fieldMap[fieldNames[i]] = 1;
		/**
		* @returns {string|undefined} Set field name, if any
		* @this Object
		* @ignore
		*/
		return function() {
			for (var keys = Object.keys(this), i = keys.length - 1; i > -1; --i) if (fieldMap[keys[i]] === 1 && this[keys[i]] !== void 0 && this[keys[i]] !== null) return keys[i];
		};
	};
	/**
	* A OneOf setter as returned by {@link util.oneOfSetter}.
	* @typedef OneOfSetter
	* @type {function}
	* @param {string|undefined} value Field name
	* @returns {undefined}
	*/
	/**
	* Builds a setter for a oneof's present field name.
	* @param {string[]} fieldNames Field names
	* @returns {OneOfSetter} Unbound setter
	*/
	util.oneOfSetter = function setOneOf(fieldNames) {
		/**
		* @param {string} name Field name
		* @returns {undefined}
		* @this Object
		* @ignore
		*/
		return function(name) {
			for (var i = 0; i < fieldNames.length; ++i) if (fieldNames[i] !== name) delete this[fieldNames[i]];
		};
	};
	/**
	* Default conversion options used for {@link Message#toJSON} implementations.
	*
	* These options are close to proto3's JSON mapping with the exception that internal types like Any are handled just like messages. More precisely:
	*
	* - Longs become strings
	* - Enums become string keys
	* - Bytes become base64 encoded strings
	* - (Sub-)Messages become plain objects
	* - Maps become plain objects with all string keys
	* - Repeated fields become arrays
	* - NaN and Infinity for float and double fields become strings
	*
	* @type {IConversionOptions}
	* @see https://developers.google.com/protocol-buffers/docs/proto3?hl=en#json
	*/
	util.toJSONOptions = {
		longs: String,
		enums: String,
		bytes: String,
		json: true
	};
	util._configure = function() {
		var Buffer = util.Buffer;
		/* istanbul ignore if */
		if (!Buffer) {
			util._Buffer_from = util._Buffer_allocUnsafe = null;
			return;
		}
		util._Buffer_from = Buffer.from !== Uint8Array.from && Buffer.from || function Buffer_from(value, encoding) {
			return new Buffer(value, encoding);
		};
		util._Buffer_allocUnsafe = Buffer.allocUnsafe || function Buffer_allocUnsafe(size) {
			return new Buffer(size);
		};
	};
}));
//#endregion
//#region node_modules/protobufjs/src/writer.js
var require_writer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Writer;
	var util = require_minimal$1();
	var BufferWriter;
	var LongBits = util.LongBits, base64 = util.base64, utf8 = util.utf8;
	/**
	* Constructs a new writer operation instance.
	* @classdesc Scheduled writer operation.
	* @constructor
	* @param {function(*, Uint8Array, number)} fn Function to call
	* @param {number} len Value byte length
	* @param {*} val Value to write
	* @ignore
	*/
	function Op(fn, len, val) {
		/**
		* Function to call.
		* @type {function(Uint8Array, number, *)}
		*/
		this.fn = fn;
		/**
		* Value byte length.
		* @type {number}
		*/
		this.len = len;
		/**
		* Next operation.
		* @type {Writer.Op|undefined}
		*/
		this.next = void 0;
		/**
		* Value to write.
		* @type {*}
		*/
		this.val = val;
	}
	/* istanbul ignore next */
	function noop() {}
	/**
	* Constructs a new writer state instance.
	* @classdesc Copied writer state.
	* @memberof Writer
	* @constructor
	* @param {Writer} writer Writer to copy state from
	* @ignore
	*/
	function State(writer) {
		/**
		* Current head.
		* @type {Writer.Op}
		*/
		this.head = writer.head;
		/**
		* Current tail.
		* @type {Writer.Op}
		*/
		this.tail = writer.tail;
		/**
		* Current buffer length.
		* @type {number}
		*/
		this.len = writer.len;
		/**
		* Next state.
		* @type {State|null}
		*/
		this.next = writer.states;
	}
	/**
	* Constructs a new writer instance.
	* @classdesc Wire format writer using `Uint8Array` if available, otherwise `Array`.
	* @constructor
	*/
	function Writer() {
		/**
		* Current length.
		* @type {number}
		*/
		this.len = 0;
		/**
		* Operations head.
		* @type {Object}
		*/
		this.head = new Op(noop, 0, 0);
		/**
		* Operations tail
		* @type {Object}
		*/
		this.tail = this.head;
		/**
		* Linked forked states.
		* @type {Object|null}
		*/
		this.states = null;
	}
	var create = function create() {
		return util.Buffer ? function create_buffer_setup() {
			return (Writer.create = function create_buffer() {
				return new BufferWriter();
			})();
		} : function create_array() {
			return new Writer();
		};
	};
	/**
	* Creates a new writer.
	* @function
	* @returns {BufferWriter|Writer} A {@link BufferWriter} when Buffers are supported, otherwise a {@link Writer}
	*/
	Writer.create = create();
	/**
	* Allocates a buffer of the specified size.
	* @param {number} size Buffer size
	* @returns {Uint8Array} Buffer
	*/
	Writer.alloc = function alloc(size) {
		return new util.Array(size);
	};
	/* istanbul ignore else */
	if (util.Array !== Array) Writer.alloc = util.pool(Writer.alloc, util.Array.prototype.subarray);
	/**
	* Pushes a new operation to the queue.
	* @param {function(Uint8Array, number, *)} fn Function to call
	* @param {number} len Value byte length
	* @param {number} val Value to write
	* @returns {Writer} `this`
	* @private
	*/
	Writer.prototype._push = function push(fn, len, val) {
		this.tail = this.tail.next = new Op(fn, len, val);
		this.len += len;
		return this;
	};
	function writeByte(val, buf, pos) {
		buf[pos] = val & 255;
	}
	function writeVarint32(val, buf, pos) {
		while (val > 127) {
			buf[pos++] = val & 127 | 128;
			val >>>= 7;
		}
		buf[pos] = val;
	}
	/**
	* Constructs a new varint writer operation instance.
	* @classdesc Scheduled varint writer operation.
	* @extends Op
	* @constructor
	* @param {number} len Value byte length
	* @param {number} val Value to write
	* @ignore
	*/
	function VarintOp(len, val) {
		this.len = len;
		this.next = void 0;
		this.val = val;
	}
	VarintOp.prototype = Object.create(Op.prototype);
	VarintOp.prototype.fn = writeVarint32;
	/**
	* Writes an unsigned 32 bit value as a varint.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.uint32 = function write_uint32(value) {
		this.len += (this.tail = this.tail.next = new VarintOp((value = value >>> 0) < 128 ? 1 : value < 16384 ? 2 : value < 2097152 ? 3 : value < 268435456 ? 4 : 5, value)).len;
		return this;
	};
	/**
	* Writes a signed 32 bit value as a varint.
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.int32 = function write_int32(value) {
		return value < 0 ? this._push(writeVarint64, 10, LongBits.fromNumber(value)) : this.uint32(value);
	};
	/**
	* Writes a 32 bit value as a varint, zig-zag encoded.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.sint32 = function write_sint32(value) {
		return this.uint32((value << 1 ^ value >> 31) >>> 0);
	};
	function writeVarint64(val, buf, pos) {
		while (val.hi) {
			buf[pos++] = val.lo & 127 | 128;
			val.lo = (val.lo >>> 7 | val.hi << 25) >>> 0;
			val.hi >>>= 7;
		}
		while (val.lo > 127) {
			buf[pos++] = val.lo & 127 | 128;
			val.lo = val.lo >>> 7;
		}
		buf[pos++] = val.lo;
	}
	/**
	* Writes an unsigned 64 bit value as a varint.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.uint64 = function write_uint64(value) {
		var bits = LongBits.from(value);
		return this._push(writeVarint64, bits.length(), bits);
	};
	/**
	* Writes a signed 64 bit value as a varint.
	* @function
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.int64 = Writer.prototype.uint64;
	/**
	* Writes a signed 64 bit value as a varint, zig-zag encoded.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.sint64 = function write_sint64(value) {
		var bits = LongBits.from(value).zzEncode();
		return this._push(writeVarint64, bits.length(), bits);
	};
	/**
	* Writes a boolish value as a varint.
	* @param {boolean} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.bool = function write_bool(value) {
		return this._push(writeByte, 1, value ? 1 : 0);
	};
	function writeFixed32(val, buf, pos) {
		buf[pos] = val & 255;
		buf[pos + 1] = val >>> 8 & 255;
		buf[pos + 2] = val >>> 16 & 255;
		buf[pos + 3] = val >>> 24;
	}
	/**
	* Writes an unsigned 32 bit value as fixed 32 bits.
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.fixed32 = function write_fixed32(value) {
		return this._push(writeFixed32, 4, value >>> 0);
	};
	/**
	* Writes a signed 32 bit value as fixed 32 bits.
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.sfixed32 = Writer.prototype.fixed32;
	/**
	* Writes an unsigned 64 bit value as fixed 64 bits.
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.fixed64 = function write_fixed64(value) {
		var bits = LongBits.from(value);
		return this._push(writeFixed32, 4, bits.lo)._push(writeFixed32, 4, bits.hi);
	};
	/**
	* Writes a signed 64 bit value as fixed 64 bits.
	* @function
	* @param {Long|number|string} value Value to write
	* @returns {Writer} `this`
	* @throws {TypeError} If `value` is a string and no long library is present.
	*/
	Writer.prototype.sfixed64 = Writer.prototype.fixed64;
	/**
	* Writes a float (32 bit).
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.float = function write_float(value) {
		return this._push(util.float.writeFloatLE, 4, value);
	};
	/**
	* Writes a double (64 bit float).
	* @function
	* @param {number} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.double = function write_double(value) {
		return this._push(util.float.writeDoubleLE, 8, value);
	};
	var writeBytes = util.Array.prototype.set ? function writeBytes_set(val, buf, pos) {
		buf.set(val, pos);
	} : function writeBytes_for(val, buf, pos) {
		for (var i = 0; i < val.length; ++i) buf[pos + i] = val[i];
	};
	/**
	* Writes a sequence of bytes.
	* @param {Uint8Array|string} value Buffer or base64 encoded string to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.bytes = function write_bytes(value) {
		var len = value.length >>> 0;
		if (!len) return this._push(writeByte, 1, 0);
		if (util.isString(value)) {
			var buf = Writer.alloc(len = base64.length(value));
			base64.decode(value, buf, 0);
			value = buf;
		}
		return this.uint32(len)._push(writeBytes, len, value);
	};
	/**
	* Writes a string.
	* @param {string} value Value to write
	* @returns {Writer} `this`
	*/
	Writer.prototype.string = function write_string(value) {
		var len = utf8.length(value);
		return len ? this.uint32(len)._push(utf8.write, len, value) : this._push(writeByte, 1, 0);
	};
	/**
	* Forks this writer's state by pushing it to a stack.
	* Calling {@link Writer#reset|reset} or {@link Writer#ldelim|ldelim} resets the writer to the previous state.
	* @returns {Writer} `this`
	*/
	Writer.prototype.fork = function fork() {
		this.states = new State(this);
		this.head = this.tail = new Op(noop, 0, 0);
		this.len = 0;
		return this;
	};
	/**
	* Resets this instance to the last state.
	* @returns {Writer} `this`
	*/
	Writer.prototype.reset = function reset() {
		if (this.states) {
			this.head = this.states.head;
			this.tail = this.states.tail;
			this.len = this.states.len;
			this.states = this.states.next;
		} else {
			this.head = this.tail = new Op(noop, 0, 0);
			this.len = 0;
		}
		return this;
	};
	/**
	* Resets to the last state and appends the fork state's current write length as a varint followed by its operations.
	* @returns {Writer} `this`
	*/
	Writer.prototype.ldelim = function ldelim() {
		var head = this.head, tail = this.tail, len = this.len;
		this.reset().uint32(len);
		if (len) {
			this.tail.next = head.next;
			this.tail = tail;
			this.len += len;
		}
		return this;
	};
	/**
	* Finishes the write operation.
	* @returns {Uint8Array} Finished buffer
	*/
	Writer.prototype.finish = function finish() {
		var head = this.head.next, buf = this.constructor.alloc(this.len), pos = 0;
		while (head) {
			head.fn(head.val, buf, pos);
			pos += head.len;
			head = head.next;
		}
		return buf;
	};
	Writer._configure = function(BufferWriter_) {
		BufferWriter = BufferWriter_;
		Writer.create = create();
		BufferWriter._configure();
	};
}));
//#endregion
//#region node_modules/protobufjs/src/writer_buffer.js
var require_writer_buffer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = BufferWriter;
	var Writer = require_writer();
	(BufferWriter.prototype = Object.create(Writer.prototype)).constructor = BufferWriter;
	var util = require_minimal$1();
	/**
	* Constructs a new buffer writer instance.
	* @classdesc Wire format writer using node buffers.
	* @extends Writer
	* @constructor
	*/
	function BufferWriter() {
		Writer.call(this);
	}
	BufferWriter._configure = function() {
		/**
		* Allocates a buffer of the specified size.
		* @function
		* @param {number} size Buffer size
		* @returns {Buffer} Buffer
		*/
		BufferWriter.alloc = util._Buffer_allocUnsafe;
		BufferWriter.writeBytesBuffer = util.Buffer && util.Buffer.prototype instanceof Uint8Array && util.Buffer.prototype.set.name === "set" ? function writeBytesBuffer_set(val, buf, pos) {
			buf.set(val, pos);
		} : function writeBytesBuffer_copy(val, buf, pos) {
			if (val.copy) val.copy(buf, pos, 0, val.length);
			else for (var i = 0; i < val.length;) buf[pos++] = val[i++];
		};
	};
	/**
	* @override
	*/
	BufferWriter.prototype.bytes = function write_bytes_buffer(value) {
		if (util.isString(value)) value = util._Buffer_from(value, "base64");
		var len = value.length >>> 0;
		this.uint32(len);
		if (len) this._push(BufferWriter.writeBytesBuffer, len, value);
		return this;
	};
	function writeStringBuffer(val, buf, pos) {
		if (val.length < 40) util.utf8.write(val, buf, pos);
		else if (buf.utf8Write) buf.utf8Write(val, pos);
		else buf.write(val, pos);
	}
	/**
	* @override
	*/
	BufferWriter.prototype.string = function write_string_buffer(value) {
		var len = util.Buffer.byteLength(value);
		this.uint32(len);
		if (len) this._push(writeStringBuffer, len, value);
		return this;
	};
	/**
	* Finishes the write operation.
	* @name BufferWriter#finish
	* @function
	* @returns {Buffer} Finished buffer
	*/
	BufferWriter._configure();
}));
//#endregion
//#region node_modules/protobufjs/src/reader.js
var require_reader = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Reader;
	var util = require_minimal$1();
	var BufferReader;
	var LongBits = util.LongBits, utf8 = util.utf8;
	/* istanbul ignore next */
	function indexOutOfRange(reader, writeLength) {
		return RangeError("index out of range: " + reader.pos + " + " + (writeLength || 1) + " > " + reader.len);
	}
	/**
	* Constructs a new reader instance using the specified buffer.
	* @classdesc Wire format reader using `Uint8Array` if available, otherwise `Array`.
	* @constructor
	* @param {Uint8Array} buffer Buffer to read from
	*/
	function Reader(buffer) {
		/**
		* Read buffer.
		* @type {Uint8Array}
		*/
		this.buf = buffer;
		/**
		* Read buffer position.
		* @type {number}
		*/
		this.pos = 0;
		/**
		* Read buffer length.
		* @type {number}
		*/
		this.len = buffer.length;
	}
	var create_array = typeof Uint8Array !== "undefined" ? function create_typed_array(buffer) {
		if (buffer instanceof Uint8Array || Array.isArray(buffer)) return new Reader(buffer);
		throw Error("illegal buffer");
	} : function create_array(buffer) {
		if (Array.isArray(buffer)) return new Reader(buffer);
		throw Error("illegal buffer");
	};
	var create = function create() {
		return util.Buffer ? function create_buffer_setup(buffer) {
			return (Reader.create = function create_buffer(buffer) {
				return util.Buffer.isBuffer(buffer) ? new BufferReader(buffer) : create_array(buffer);
			})(buffer);
		} : create_array;
	};
	/**
	* Creates a new reader using the specified buffer.
	* @function
	* @param {Uint8Array|Buffer} buffer Buffer to read from
	* @returns {Reader|BufferReader} A {@link BufferReader} if `buffer` is a Buffer, otherwise a {@link Reader}
	* @throws {Error} If `buffer` is not a valid buffer
	*/
	Reader.create = create();
	Reader.prototype._slice = util.Array.prototype.subarray || util.Array.prototype.slice;
	/**
	* Reads a varint as an unsigned 32 bit value.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.uint32 = (function read_uint32_setup() {
		var value = 4294967295;
		return function read_uint32() {
			value = (this.buf[this.pos] & 127) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 7) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 14) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 127) << 21) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			value = (value | (this.buf[this.pos] & 15) << 28) >>> 0;
			if (this.buf[this.pos++] < 128) return value;
			/* istanbul ignore if */
			if ((this.pos += 5) > this.len) {
				this.pos = this.len;
				throw indexOutOfRange(this, 10);
			}
			return value;
		};
	})();
	/**
	* Reads a varint as a signed 32 bit value.
	* @returns {number} Value read
	*/
	Reader.prototype.int32 = function read_int32() {
		return this.uint32() | 0;
	};
	/**
	* Reads a zig-zag encoded varint as a signed 32 bit value.
	* @returns {number} Value read
	*/
	Reader.prototype.sint32 = function read_sint32() {
		var value = this.uint32();
		return value >>> 1 ^ -(value & 1) | 0;
	};
	function readLongVarint() {
		var bits = new LongBits(0, 0);
		var i = 0;
		if (this.len - this.pos > 4) {
			for (; i < 4; ++i) {
				bits.lo = (bits.lo | (this.buf[this.pos] & 127) << i * 7) >>> 0;
				if (this.buf[this.pos++] < 128) return bits;
			}
			bits.lo = (bits.lo | (this.buf[this.pos] & 127) << 28) >>> 0;
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) >> 4) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
			i = 0;
		} else {
			for (; i < 3; ++i) {
				/* istanbul ignore if */
				if (this.pos >= this.len) throw indexOutOfRange(this);
				bits.lo = (bits.lo | (this.buf[this.pos] & 127) << i * 7) >>> 0;
				if (this.buf[this.pos++] < 128) return bits;
			}
			bits.lo = (bits.lo | (this.buf[this.pos++] & 127) << i * 7) >>> 0;
			return bits;
		}
		if (this.len - this.pos > 4) for (; i < 5; ++i) {
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) << i * 7 + 3) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
		}
		else for (; i < 5; ++i) {
			/* istanbul ignore if */
			if (this.pos >= this.len) throw indexOutOfRange(this);
			bits.hi = (bits.hi | (this.buf[this.pos] & 127) << i * 7 + 3) >>> 0;
			if (this.buf[this.pos++] < 128) return bits;
		}
		/* istanbul ignore next */
		throw Error("invalid varint encoding");
	}
	/**
	* Reads a varint as a signed 64 bit value.
	* @name Reader#int64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a varint as an unsigned 64 bit value.
	* @name Reader#uint64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a zig-zag encoded varint as a signed 64 bit value.
	* @name Reader#sint64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a varint as a boolean.
	* @returns {boolean} Value read
	*/
	Reader.prototype.bool = function read_bool() {
		return this.uint32() !== 0;
	};
	function readFixed32_end(buf, end) {
		return (buf[end - 4] | buf[end - 3] << 8 | buf[end - 2] << 16 | buf[end - 1] << 24) >>> 0;
	}
	/**
	* Reads fixed 32 bits as an unsigned 32 bit integer.
	* @returns {number} Value read
	*/
	Reader.prototype.fixed32 = function read_fixed32() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		return readFixed32_end(this.buf, this.pos += 4);
	};
	/**
	* Reads fixed 32 bits as a signed 32 bit integer.
	* @returns {number} Value read
	*/
	Reader.prototype.sfixed32 = function read_sfixed32() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		return readFixed32_end(this.buf, this.pos += 4) | 0;
	};
	function readFixed64() {
		/* istanbul ignore if */
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 8);
		return new LongBits(readFixed32_end(this.buf, this.pos += 4), readFixed32_end(this.buf, this.pos += 4));
	}
	/**
	* Reads fixed 64 bits.
	* @name Reader#fixed64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads zig-zag encoded fixed 64 bits.
	* @name Reader#sfixed64
	* @function
	* @returns {Long} Value read
	*/
	/**
	* Reads a float (32 bit) as a number.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.float = function read_float() {
		/* istanbul ignore if */
		if (this.pos + 4 > this.len) throw indexOutOfRange(this, 4);
		var value = util.float.readFloatLE(this.buf, this.pos);
		this.pos += 4;
		return value;
	};
	/**
	* Reads a double (64 bit float) as a number.
	* @function
	* @returns {number} Value read
	*/
	Reader.prototype.double = function read_double() {
		/* istanbul ignore if */
		if (this.pos + 8 > this.len) throw indexOutOfRange(this, 4);
		var value = util.float.readDoubleLE(this.buf, this.pos);
		this.pos += 8;
		return value;
	};
	/**
	* Reads a sequence of bytes preceeded by its length as a varint.
	* @returns {Uint8Array} Value read
	*/
	Reader.prototype.bytes = function read_bytes() {
		var length = this.uint32(), start = this.pos, end = this.pos + length;
		/* istanbul ignore if */
		if (end > this.len) throw indexOutOfRange(this, length);
		this.pos += length;
		if (Array.isArray(this.buf)) return this.buf.slice(start, end);
		if (start === end) {
			var nativeBuffer = util.Buffer;
			return nativeBuffer ? nativeBuffer.alloc(0) : new this.buf.constructor(0);
		}
		return this._slice.call(this.buf, start, end);
	};
	/**
	* Reads a string preceeded by its byte length as a varint.
	* @returns {string} Value read
	*/
	Reader.prototype.string = function read_string() {
		var bytes = this.bytes();
		return utf8.read(bytes, 0, bytes.length);
	};
	/**
	* Skips the specified number of bytes if specified, otherwise skips a varint.
	* @param {number} [length] Length if known, otherwise a varint is assumed
	* @returns {Reader} `this`
	*/
	Reader.prototype.skip = function skip(length) {
		if (typeof length === "number") {
			/* istanbul ignore if */
			if (this.pos + length > this.len) throw indexOutOfRange(this, length);
			this.pos += length;
		} else do
			/* istanbul ignore if */
			if (this.pos >= this.len) throw indexOutOfRange(this);
		while (this.buf[this.pos++] & 128);
		return this;
	};
	/**
	* Skips the next element of the specified wire type.
	* @param {number} wireType Wire type received
	* @returns {Reader} `this`
	*/
	Reader.prototype.skipType = function(wireType) {
		switch (wireType) {
			case 0:
				this.skip();
				break;
			case 1:
				this.skip(8);
				break;
			case 2:
				this.skip(this.uint32());
				break;
			case 3:
				while ((wireType = this.uint32() & 7) !== 4) this.skipType(wireType);
				break;
			case 5:
				this.skip(4);
				break;
			/* istanbul ignore next */
			default: throw Error("invalid wire type " + wireType + " at offset " + this.pos);
		}
		return this;
	};
	Reader._configure = function(BufferReader_) {
		BufferReader = BufferReader_;
		Reader.create = create();
		BufferReader._configure();
		var fn = util.Long ? "toLong" : 		/* istanbul ignore next */ "toNumber";
		util.merge(Reader.prototype, {
			int64: function read_int64() {
				return readLongVarint.call(this)[fn](false);
			},
			uint64: function read_uint64() {
				return readLongVarint.call(this)[fn](true);
			},
			sint64: function read_sint64() {
				return readLongVarint.call(this).zzDecode()[fn](false);
			},
			fixed64: function read_fixed64() {
				return readFixed64.call(this)[fn](true);
			},
			sfixed64: function read_sfixed64() {
				return readFixed64.call(this)[fn](false);
			}
		});
	};
}));
//#endregion
//#region node_modules/protobufjs/src/reader_buffer.js
var require_reader_buffer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = BufferReader;
	var Reader = require_reader();
	(BufferReader.prototype = Object.create(Reader.prototype)).constructor = BufferReader;
	var util = require_minimal$1();
	/**
	* Constructs a new buffer reader instance.
	* @classdesc Wire format reader using node buffers.
	* @extends Reader
	* @constructor
	* @param {Buffer} buffer Buffer to read from
	*/
	function BufferReader(buffer) {
		Reader.call(this, buffer);
		/**
		* Read buffer.
		* @name BufferReader#buf
		* @type {Buffer}
		*/
	}
	BufferReader._configure = function() {
		/* istanbul ignore else */
		if (util.Buffer) BufferReader.prototype._slice = util.Buffer.prototype.slice;
	};
	/**
	* @override
	*/
	BufferReader.prototype.string = function read_string_buffer() {
		var len = this.uint32();
		return this.buf.utf8Slice ? this.buf.utf8Slice(this.pos, this.pos = Math.min(this.pos + len, this.len)) : this.buf.toString("utf-8", this.pos, this.pos = Math.min(this.pos + len, this.len));
	};
	/**
	* Reads a sequence of bytes preceeded by its length as a varint.
	* @name BufferReader#bytes
	* @function
	* @returns {Buffer} Value read
	*/
	BufferReader._configure();
}));
//#endregion
//#region node_modules/protobufjs/src/rpc/service.js
var require_service = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Service;
	var util = require_minimal$1();
	(Service.prototype = Object.create(util.EventEmitter.prototype)).constructor = Service;
	/**
	* A service method callback as used by {@link rpc.ServiceMethod|ServiceMethod}.
	*
	* Differs from {@link RPCImplCallback} in that it is an actual callback of a service method which may not return `response = null`.
	* @typedef rpc.ServiceMethodCallback
	* @template TRes extends Message<TRes>
	* @type {function}
	* @param {Error|null} error Error, if any
	* @param {TRes} [response] Response message
	* @returns {undefined}
	*/
	/**
	* A service method part of a {@link rpc.Service} as created by {@link Service.create}.
	* @typedef rpc.ServiceMethod
	* @template TReq extends Message<TReq>
	* @template TRes extends Message<TRes>
	* @type {function}
	* @param {TReq|Properties<TReq>} request Request message or plain object
	* @param {rpc.ServiceMethodCallback<TRes>} [callback] Node-style callback called with the error, if any, and the response message
	* @returns {Promise<Message<TRes>>} Promise if `callback` has been omitted, otherwise `undefined`
	*/
	/**
	* Constructs a new RPC service instance.
	* @classdesc An RPC service as returned by {@link Service#create}.
	* @exports rpc.Service
	* @extends util.EventEmitter
	* @constructor
	* @param {RPCImpl} rpcImpl RPC implementation
	* @param {boolean} [requestDelimited=false] Whether requests are length-delimited
	* @param {boolean} [responseDelimited=false] Whether responses are length-delimited
	*/
	function Service(rpcImpl, requestDelimited, responseDelimited) {
		if (typeof rpcImpl !== "function") throw TypeError("rpcImpl must be a function");
		util.EventEmitter.call(this);
		/**
		* RPC implementation. Becomes `null` once the service is ended.
		* @type {RPCImpl|null}
		*/
		this.rpcImpl = rpcImpl;
		/**
		* Whether requests are length-delimited.
		* @type {boolean}
		*/
		this.requestDelimited = Boolean(requestDelimited);
		/**
		* Whether responses are length-delimited.
		* @type {boolean}
		*/
		this.responseDelimited = Boolean(responseDelimited);
	}
	/**
	* Calls a service method through {@link rpc.Service#rpcImpl|rpcImpl}.
	* @param {Method|rpc.ServiceMethod<TReq,TRes>} method Reflected or static method
	* @param {Constructor<TReq>} requestCtor Request constructor
	* @param {Constructor<TRes>} responseCtor Response constructor
	* @param {TReq|Properties<TReq>} request Request message or plain object
	* @param {rpc.ServiceMethodCallback<TRes>} callback Service callback
	* @returns {undefined}
	* @template TReq extends Message<TReq>
	* @template TRes extends Message<TRes>
	*/
	Service.prototype.rpcCall = function rpcCall(method, requestCtor, responseCtor, request, callback) {
		if (!request) throw TypeError("request must be specified");
		var self = this;
		if (!callback) return util.asPromise(rpcCall, self, method, requestCtor, responseCtor, request);
		if (!self.rpcImpl) {
			setTimeout(function() {
				callback(Error("already ended"));
			}, 0);
			return;
		}
		try {
			return self.rpcImpl(method, requestCtor[self.requestDelimited ? "encodeDelimited" : "encode"](request).finish(), function rpcCallback(err, response) {
				if (err) {
					self.emit("error", err, method);
					return callback(err);
				}
				if (response === null) {
					self.end(true);
					return;
				}
				if (!(response instanceof responseCtor)) try {
					response = responseCtor[self.responseDelimited ? "decodeDelimited" : "decode"](response);
				} catch (err) {
					self.emit("error", err, method);
					return callback(err);
				}
				self.emit("data", response, method);
				return callback(null, response);
			});
		} catch (err) {
			self.emit("error", err, method);
			setTimeout(function() {
				callback(err);
			}, 0);
			return;
		}
	};
	/**
	* Ends this service and emits the `end` event.
	* @param {boolean} [endedByRPC=false] Whether the service has been ended by the RPC implementation.
	* @returns {rpc.Service} `this`
	*/
	Service.prototype.end = function end(endedByRPC) {
		if (this.rpcImpl) {
			if (!endedByRPC) this.rpcImpl(null, null, null);
			this.rpcImpl = null;
			this.emit("end").off();
		}
		return this;
	};
}));
//#endregion
//#region node_modules/protobufjs/src/rpc.js
var require_rpc = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Streaming RPC helpers.
	* @namespace
	*/
	var rpc = exports;
	/**
	* RPC implementation passed to {@link Service#create} performing a service request on network level, i.e. by utilizing http requests or websockets.
	* @typedef RPCImpl
	* @type {function}
	* @param {Method|rpc.ServiceMethod<Message<{}>,Message<{}>>} method Reflected or static method being called
	* @param {Uint8Array} requestData Request data
	* @param {RPCImplCallback} callback Callback function
	* @returns {undefined}
	* @example
	* function rpcImpl(method, requestData, callback) {
	*     if (protobuf.util.lcFirst(method.name) !== "myMethod") // compatible with static code
	*         throw Error("no such method");
	*     asynchronouslyObtainAResponse(requestData, function(err, responseData) {
	*         callback(err, responseData);
	*     });
	* }
	*/
	/**
	* Node-style callback as used by {@link RPCImpl}.
	* @typedef RPCImplCallback
	* @type {function}
	* @param {Error|null} error Error, if any, otherwise `null`
	* @param {Uint8Array|null} [response] Response data or `null` to signal end of stream, if there hasn't been an error
	* @returns {undefined}
	*/
	rpc.Service = require_service();
}));
//#endregion
//#region node_modules/protobufjs/src/roots.js
var require_roots = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {};
}));
/**
* Named roots.
* This is where pbjs stores generated structures (the option `-r, --root` specifies a name).
* Can also be used manually to make roots available across modules.
* @name roots
* @type {Object.<string,Root>}
* @example
* // pbjs -r myroot -o compiled.js ...
*
* // in another module:
* require("./compiled.js");
*
* // in any subsequent module:
* var root = protobuf.roots["myroot"];
*/
//#endregion
//#region node_modules/protobufjs/src/index-minimal.js
var require_index_minimal = /* @__PURE__ */ __commonJSMin(((exports) => {
	var protobuf = exports;
	/**
	* Build type, one of `"full"`, `"light"` or `"minimal"`.
	* @name build
	* @type {string}
	* @const
	*/
	protobuf.build = "minimal";
	protobuf.Writer = require_writer();
	protobuf.BufferWriter = require_writer_buffer();
	protobuf.Reader = require_reader();
	protobuf.BufferReader = require_reader_buffer();
	protobuf.util = require_minimal$1();
	protobuf.rpc = require_rpc();
	protobuf.roots = require_roots();
	protobuf.configure = configure;
	/* istanbul ignore next */
	/**
	* Reconfigures the library according to the environment.
	* @returns {undefined}
	*/
	function configure() {
		protobuf.util._configure();
		protobuf.Writer._configure(protobuf.BufferWriter);
		protobuf.Reader._configure(protobuf.BufferReader);
	}
	configure();
}));
//#endregion
//#region node_modules/protobufjs/minimal.js
var require_minimal = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_index_minimal();
}));
//#endregion
export { require_reader as a, require_inquire as c, require_rpc as i, require_aspromise as l, require_index_minimal as n, require_writer as o, require_roots as r, require_minimal$1 as s, require_minimal as t };
