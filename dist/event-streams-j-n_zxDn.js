import { a as __toCommonJS, i as __require, n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { c as tslib_es6_exports, s as init_tslib_es6 } from "./tslib.es6-DJxJwErw.js";
import { Mn as fromUtf8, dn as fromHex, dt as init_serde, kn as toUtf8, pn as toHex } from "./client-hKay7jF9.js";
import { Readable } from "node:stream";
//#region node_modules/@smithy/is-array-buffer/dist-cjs/index.js
var require_dist_cjs$2 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __name = (target, value) => __defProp(target, "name", {
		value,
		configurable: true
	});
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var src_exports = {};
	__export(src_exports, { isArrayBuffer: () => isArrayBuffer });
	module.exports = __toCommonJS(src_exports);
	var isArrayBuffer = /* @__PURE__ */ __name((arg) => typeof ArrayBuffer === "function" && arg instanceof ArrayBuffer || Object.prototype.toString.call(arg) === "[object ArrayBuffer]", "isArrayBuffer");
}));
//#endregion
//#region node_modules/@smithy/util-buffer-from/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __name = (target, value) => __defProp(target, "name", {
		value,
		configurable: true
	});
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var src_exports = {};
	__export(src_exports, {
		fromArrayBuffer: () => fromArrayBuffer,
		fromString: () => fromString
	});
	module.exports = __toCommonJS(src_exports);
	var import_is_array_buffer = require_dist_cjs$2();
	var import_buffer = __require("buffer");
	var fromArrayBuffer = /* @__PURE__ */ __name((input, offset = 0, length = input.byteLength - offset) => {
		if (!(0, import_is_array_buffer.isArrayBuffer)(input)) throw new TypeError(`The "input" argument must be ArrayBuffer. Received type ${typeof input} (${input})`);
		return import_buffer.Buffer.from(input, offset, length);
	}, "fromArrayBuffer");
	var fromString = /* @__PURE__ */ __name((input, encoding) => {
		if (typeof input !== "string") throw new TypeError(`The "input" argument must be of type string. Received type ${typeof input} (${input})`);
		return encoding ? import_buffer.Buffer.from(input, encoding) : import_buffer.Buffer.from(input);
	}, "fromString");
}));
//#endregion
//#region node_modules/@smithy/util-utf8/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var __defProp = Object.defineProperty;
	var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
	var __getOwnPropNames = Object.getOwnPropertyNames;
	var __hasOwnProp = Object.prototype.hasOwnProperty;
	var __name = (target, value) => __defProp(target, "name", {
		value,
		configurable: true
	});
	var __export = (target, all) => {
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
	};
	var __copyProps = (to, from, except, desc) => {
		if (from && typeof from === "object" || typeof from === "function") {
			for (let key of __getOwnPropNames(from)) if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
				get: () => from[key],
				enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
			});
		}
		return to;
	};
	var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
	var src_exports = {};
	__export(src_exports, {
		fromUtf8: () => fromUtf8,
		toUint8Array: () => toUint8Array,
		toUtf8: () => toUtf8
	});
	module.exports = __toCommonJS(src_exports);
	var import_util_buffer_from = require_dist_cjs$1();
	var fromUtf8 = /* @__PURE__ */ __name((input) => {
		const buf = (0, import_util_buffer_from.fromString)(input, "utf8");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint8Array.BYTES_PER_ELEMENT);
	}, "fromUtf8");
	var toUint8Array = /* @__PURE__ */ __name((data) => {
		if (typeof data === "string") return fromUtf8(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
		return new Uint8Array(data);
	}, "toUint8Array");
	var toUtf8 = /* @__PURE__ */ __name((input) => {
		if (typeof input === "string") return input;
		if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
		return (0, import_util_buffer_from.fromArrayBuffer)(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
	}, "toUtf8");
}));
//#endregion
//#region node_modules/@aws-crypto/util/build/main/convertToBuffer.js
var require_convertToBuffer = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.convertToBuffer = void 0;
	var util_utf8_1 = require_dist_cjs();
	var fromUtf8 = typeof Buffer !== "undefined" && Buffer.from ? function(input) {
		return Buffer.from(input, "utf8");
	} : util_utf8_1.fromUtf8;
	function convertToBuffer(data) {
		if (data instanceof Uint8Array) return data;
		if (typeof data === "string") return fromUtf8(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
		return new Uint8Array(data);
	}
	exports.convertToBuffer = convertToBuffer;
}));
//#endregion
//#region node_modules/@aws-crypto/util/build/main/isEmptyData.js
var require_isEmptyData = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isEmptyData = void 0;
	function isEmptyData(data) {
		if (typeof data === "string") return data.length === 0;
		return data.byteLength === 0;
	}
	exports.isEmptyData = isEmptyData;
}));
//#endregion
//#region node_modules/@aws-crypto/util/build/main/numToUint8.js
var require_numToUint8 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.numToUint8 = void 0;
	function numToUint8(num) {
		return new Uint8Array([
			(num & 4278190080) >> 24,
			(num & 16711680) >> 16,
			(num & 65280) >> 8,
			num & 255
		]);
	}
	exports.numToUint8 = numToUint8;
}));
//#endregion
//#region node_modules/@aws-crypto/util/build/main/uint32ArrayFrom.js
var require_uint32ArrayFrom = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.uint32ArrayFrom = void 0;
	function uint32ArrayFrom(a_lookUpTable) {
		if (!Uint32Array.from) {
			var return_array = new Uint32Array(a_lookUpTable.length);
			var a_index = 0;
			while (a_index < a_lookUpTable.length) {
				return_array[a_index] = a_lookUpTable[a_index];
				a_index += 1;
			}
			return return_array;
		}
		return Uint32Array.from(a_lookUpTable);
	}
	exports.uint32ArrayFrom = uint32ArrayFrom;
}));
//#endregion
//#region node_modules/@aws-crypto/util/build/main/index.js
var require_main$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.uint32ArrayFrom = exports.numToUint8 = exports.isEmptyData = exports.convertToBuffer = void 0;
	var convertToBuffer_1 = require_convertToBuffer();
	Object.defineProperty(exports, "convertToBuffer", {
		enumerable: true,
		get: function() {
			return convertToBuffer_1.convertToBuffer;
		}
	});
	var isEmptyData_1 = require_isEmptyData();
	Object.defineProperty(exports, "isEmptyData", {
		enumerable: true,
		get: function() {
			return isEmptyData_1.isEmptyData;
		}
	});
	var numToUint8_1 = require_numToUint8();
	Object.defineProperty(exports, "numToUint8", {
		enumerable: true,
		get: function() {
			return numToUint8_1.numToUint8;
		}
	});
	var uint32ArrayFrom_1 = require_uint32ArrayFrom();
	Object.defineProperty(exports, "uint32ArrayFrom", {
		enumerable: true,
		get: function() {
			return uint32ArrayFrom_1.uint32ArrayFrom;
		}
	});
}));
//#endregion
//#region node_modules/@aws-crypto/crc32/build/main/aws_crc32.js
var require_aws_crc32 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsCrc32 = void 0;
	var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	var util_1 = require_main$1();
	var index_1 = require_main();
	exports.AwsCrc32 = function() {
		function AwsCrc32() {
			this.crc32 = new index_1.Crc32();
		}
		AwsCrc32.prototype.update = function(toHash) {
			if ((0, util_1.isEmptyData)(toHash)) return;
			this.crc32.update((0, util_1.convertToBuffer)(toHash));
		};
		AwsCrc32.prototype.digest = function() {
			return tslib_1.__awaiter(this, void 0, void 0, function() {
				return tslib_1.__generator(this, function(_a) {
					return [2, (0, util_1.numToUint8)(this.crc32.digest())];
				});
			});
		};
		AwsCrc32.prototype.reset = function() {
			this.crc32 = new index_1.Crc32();
		};
		return AwsCrc32;
	}();
}));
//#endregion
//#region node_modules/@aws-crypto/crc32/build/main/index.js
var require_main = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsCrc32 = exports.Crc32 = exports.crc32 = void 0;
	var tslib_1 = (init_tslib_es6(), __toCommonJS(tslib_es6_exports));
	var util_1 = require_main$1();
	function crc32(data) {
		return new Crc32().update(data).digest();
	}
	exports.crc32 = crc32;
	var Crc32 = function() {
		function Crc32() {
			this.checksum = 4294967295;
		}
		Crc32.prototype.update = function(data) {
			var e_1, _a;
			try {
				for (var data_1 = tslib_1.__values(data), data_1_1 = data_1.next(); !data_1_1.done; data_1_1 = data_1.next()) {
					var byte = data_1_1.value;
					this.checksum = this.checksum >>> 8 ^ lookupTable[(this.checksum ^ byte) & 255];
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (data_1_1 && !data_1_1.done && (_a = data_1.return)) _a.call(data_1);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
			return this;
		};
		Crc32.prototype.digest = function() {
			return (this.checksum ^ 4294967295) >>> 0;
		};
		return Crc32;
	}();
	exports.Crc32 = Crc32;
	var lookupTable = (0, util_1.uint32ArrayFrom)([
		0,
		1996959894,
		3993919788,
		2567524794,
		124634137,
		1886057615,
		3915621685,
		2657392035,
		249268274,
		2044508324,
		3772115230,
		2547177864,
		162941995,
		2125561021,
		3887607047,
		2428444049,
		498536548,
		1789927666,
		4089016648,
		2227061214,
		450548861,
		1843258603,
		4107580753,
		2211677639,
		325883990,
		1684777152,
		4251122042,
		2321926636,
		335633487,
		1661365465,
		4195302755,
		2366115317,
		997073096,
		1281953886,
		3579855332,
		2724688242,
		1006888145,
		1258607687,
		3524101629,
		2768942443,
		901097722,
		1119000684,
		3686517206,
		2898065728,
		853044451,
		1172266101,
		3705015759,
		2882616665,
		651767980,
		1373503546,
		3369554304,
		3218104598,
		565507253,
		1454621731,
		3485111705,
		3099436303,
		671266974,
		1594198024,
		3322730930,
		2970347812,
		795835527,
		1483230225,
		3244367275,
		3060149565,
		1994146192,
		31158534,
		2563907772,
		4023717930,
		1907459465,
		112637215,
		2680153253,
		3904427059,
		2013776290,
		251722036,
		2517215374,
		3775830040,
		2137656763,
		141376813,
		2439277719,
		3865271297,
		1802195444,
		476864866,
		2238001368,
		4066508878,
		1812370925,
		453092731,
		2181625025,
		4111451223,
		1706088902,
		314042704,
		2344532202,
		4240017532,
		1658658271,
		366619977,
		2362670323,
		4224994405,
		1303535960,
		984961486,
		2747007092,
		3569037538,
		1256170817,
		1037604311,
		2765210733,
		3554079995,
		1131014506,
		879679996,
		2909243462,
		3663771856,
		1141124467,
		855842277,
		2852801631,
		3708648649,
		1342533948,
		654459306,
		3188396048,
		3373015174,
		1466479909,
		544179635,
		3110523913,
		3462522015,
		1591671054,
		702138776,
		2966460450,
		3352799412,
		1504918807,
		783551873,
		3082640443,
		3233442989,
		3988292384,
		2596254646,
		62317068,
		1957810842,
		3939845945,
		2647816111,
		81470997,
		1943803523,
		3814918930,
		2489596804,
		225274430,
		2053790376,
		3826175755,
		2466906013,
		167816743,
		2097651377,
		4027552580,
		2265490386,
		503444072,
		1762050814,
		4150417245,
		2154129355,
		426522225,
		1852507879,
		4275313526,
		2312317920,
		282753626,
		1742555852,
		4189708143,
		2394877945,
		397917763,
		1622183637,
		3604390888,
		2714866558,
		953729732,
		1340076626,
		3518719985,
		2797360999,
		1068828381,
		1219638859,
		3624741850,
		2936675148,
		906185462,
		1090812512,
		3747672003,
		2825379669,
		829329135,
		1181335161,
		3412177804,
		3160834842,
		628085408,
		1382605366,
		3423369109,
		3138078467,
		570562233,
		1426400815,
		3317316542,
		2998733608,
		733239954,
		1555261956,
		3268935591,
		3050360625,
		752459403,
		1541320221,
		2607071920,
		3965973030,
		1969922972,
		40735498,
		2617837225,
		3943577151,
		1913087877,
		83908371,
		2512341634,
		3803740692,
		2075208622,
		213261112,
		2463272603,
		3855990285,
		2094854071,
		198958881,
		2262029012,
		4057260610,
		1759359992,
		534414190,
		2176718541,
		4139329115,
		1873836001,
		414664567,
		2282248934,
		4279200368,
		1711684554,
		285281116,
		2405801727,
		4167216745,
		1634467795,
		376229701,
		2685067896,
		3608007406,
		1308918612,
		956543938,
		2808555105,
		3495958263,
		1231636301,
		1047427035,
		2932959818,
		3654703836,
		1088359270,
		936918e3,
		2847714899,
		3736837829,
		1202900863,
		817233897,
		3183342108,
		3401237130,
		1404277552,
		615818150,
		3134207493,
		3453421203,
		1423857449,
		601450431,
		3009837614,
		3294710456,
		1567103746,
		711928724,
		3020668471,
		3272380065,
		1510334235,
		755167117
	]);
	var aws_crc32_1 = require_aws_crc32();
	Object.defineProperty(exports, "AwsCrc32", {
		enumerable: true,
		get: function() {
			return aws_crc32_1.AwsCrc32;
		}
	});
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/Int64.js
function negate(bytes) {
	for (let i = 0; i < 8; i++) bytes[i] ^= 255;
	for (let i = 7; i > -1; i--) {
		bytes[i]++;
		if (bytes[i] !== 0) break;
	}
}
var Int64;
var init_Int64 = __esmMin((() => {
	init_serde();
	Int64 = class Int64 {
		bytes;
		constructor(bytes) {
			this.bytes = bytes;
			if (bytes.byteLength !== 8) throw new Error("Int64 buffers must be exactly 8 bytes");
		}
		static fromNumber(number) {
			if (number > 0x8000000000000000 || number < -0x8000000000000000) throw new Error(`${number} is too large (or, if negative, too small) to represent as an Int64`);
			const bytes = new Uint8Array(8);
			for (let i = 7, remaining = Math.abs(Math.round(number)); i > -1 && remaining > 0; i--, remaining /= 256) bytes[i] = remaining;
			if (number < 0) negate(bytes);
			return new Int64(bytes);
		}
		valueOf() {
			const bytes = this.bytes.slice(0);
			const negative = bytes[0] & 128;
			if (negative) negate(bytes);
			return parseInt(toHex(bytes), 16) * (negative ? -1 : 1);
		}
		toString() {
			return String(this.valueOf());
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/HeaderMarshaller.js
var HeaderMarshaller, HEADER_VALUE_TYPE, BOOLEAN_TAG, BYTE_TAG, SHORT_TAG, INT_TAG, LONG_TAG, BINARY_TAG, STRING_TAG, TIMESTAMP_TAG, UUID_TAG, UUID_PATTERN;
var init_HeaderMarshaller = __esmMin((() => {
	init_serde();
	init_Int64();
	HeaderMarshaller = class {
		toUtf8;
		fromUtf8;
		constructor(toUtf8, fromUtf8) {
			this.toUtf8 = toUtf8;
			this.fromUtf8 = fromUtf8;
		}
		format(headers) {
			const chunks = [];
			for (const headerName of Object.keys(headers)) {
				const bytes = this.fromUtf8(headerName);
				chunks.push(Uint8Array.from([bytes.byteLength]), bytes, this.formatHeaderValue(headers[headerName]));
			}
			const out = new Uint8Array(chunks.reduce((carry, bytes) => carry + bytes.byteLength, 0));
			let position = 0;
			for (const chunk of chunks) {
				out.set(chunk, position);
				position += chunk.byteLength;
			}
			return out;
		}
		formatHeaderValue(header) {
			switch (header.type) {
				case "boolean": return Uint8Array.from([header.value ? 0 : 1]);
				case "byte": return Uint8Array.from([2, header.value]);
				case "short":
					const shortView = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(3));
					shortView.setUint8(0, 3);
					shortView.setInt16(1, header.value, false);
					return new Uint8Array(shortView.buffer);
				case "integer":
					const intView = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(5));
					intView.setUint8(0, 4);
					intView.setInt32(1, header.value, false);
					return new Uint8Array(intView.buffer);
				case "long":
					const longBytes = new Uint8Array(9);
					longBytes[0] = 5;
					longBytes.set(header.value.bytes, 1);
					return longBytes;
				case "binary":
					const binView = new DataView(new ArrayBuffer(3 + header.value.byteLength));
					binView.setUint8(0, 6);
					binView.setUint16(1, header.value.byteLength, false);
					const binBytes = new Uint8Array(binView.buffer);
					binBytes.set(header.value, 3);
					return binBytes;
				case "string":
					const utf8Bytes = this.fromUtf8(header.value);
					const strView = new DataView(new ArrayBuffer(3 + utf8Bytes.byteLength));
					strView.setUint8(0, 7);
					strView.setUint16(1, utf8Bytes.byteLength, false);
					const strBytes = new Uint8Array(strView.buffer);
					strBytes.set(utf8Bytes, 3);
					return strBytes;
				case "timestamp":
					const tsBytes = new Uint8Array(9);
					tsBytes[0] = 8;
					tsBytes.set(Int64.fromNumber(header.value.valueOf()).bytes, 1);
					return tsBytes;
				case "uuid":
					if (!UUID_PATTERN.test(header.value)) throw new Error(`Invalid UUID received: ${header.value}`);
					const uuidBytes = new Uint8Array(17);
					uuidBytes[0] = 9;
					uuidBytes.set(fromHex(header.value.replace(/\-/g, "")), 1);
					return uuidBytes;
			}
		}
		parse(headers) {
			const out = {};
			let position = 0;
			while (position < headers.byteLength) {
				const nameLength = headers.getUint8(position++);
				const name = this.toUtf8(new Uint8Array(headers.buffer, headers.byteOffset + position, nameLength));
				position += nameLength;
				switch (headers.getUint8(position++)) {
					case 0:
						out[name] = {
							type: BOOLEAN_TAG,
							value: true
						};
						break;
					case 1:
						out[name] = {
							type: BOOLEAN_TAG,
							value: false
						};
						break;
					case 2:
						out[name] = {
							type: BYTE_TAG,
							value: headers.getInt8(position++)
						};
						break;
					case 3:
						out[name] = {
							type: SHORT_TAG,
							value: headers.getInt16(position, false)
						};
						position += 2;
						break;
					case 4:
						out[name] = {
							type: INT_TAG,
							value: headers.getInt32(position, false)
						};
						position += 4;
						break;
					case 5:
						out[name] = {
							type: LONG_TAG,
							value: new Int64(new Uint8Array(headers.buffer, headers.byteOffset + position, 8))
						};
						position += 8;
						break;
					case 6:
						const binaryLength = headers.getUint16(position, false);
						position += 2;
						out[name] = {
							type: BINARY_TAG,
							value: new Uint8Array(headers.buffer, headers.byteOffset + position, binaryLength)
						};
						position += binaryLength;
						break;
					case 7:
						const stringLength = headers.getUint16(position, false);
						position += 2;
						out[name] = {
							type: STRING_TAG,
							value: this.toUtf8(new Uint8Array(headers.buffer, headers.byteOffset + position, stringLength))
						};
						position += stringLength;
						break;
					case 8:
						out[name] = {
							type: TIMESTAMP_TAG,
							value: new Date(new Int64(new Uint8Array(headers.buffer, headers.byteOffset + position, 8)).valueOf())
						};
						position += 8;
						break;
					case 9:
						const uuidBytes = new Uint8Array(headers.buffer, headers.byteOffset + position, 16);
						position += 16;
						out[name] = {
							type: UUID_TAG,
							value: `${toHex(uuidBytes.subarray(0, 4))}-${toHex(uuidBytes.subarray(4, 6))}-${toHex(uuidBytes.subarray(6, 8))}-${toHex(uuidBytes.subarray(8, 10))}-${toHex(uuidBytes.subarray(10))}`
						};
						break;
					default: throw new Error(`Unrecognized header type tag`);
				}
			}
			return out;
		}
	};
	(function(HEADER_VALUE_TYPE) {
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolTrue"] = 0] = "boolTrue";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["boolFalse"] = 1] = "boolFalse";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byte"] = 2] = "byte";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["short"] = 3] = "short";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["integer"] = 4] = "integer";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["long"] = 5] = "long";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["byteArray"] = 6] = "byteArray";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["string"] = 7] = "string";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["timestamp"] = 8] = "timestamp";
		HEADER_VALUE_TYPE[HEADER_VALUE_TYPE["uuid"] = 9] = "uuid";
	})(HEADER_VALUE_TYPE || (HEADER_VALUE_TYPE = {}));
	BOOLEAN_TAG = "boolean";
	BYTE_TAG = "byte";
	SHORT_TAG = "short";
	INT_TAG = "integer";
	LONG_TAG = "long";
	BINARY_TAG = "binary";
	STRING_TAG = "string";
	TIMESTAMP_TAG = "timestamp";
	UUID_TAG = "uuid";
	UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/splitMessage.js
function splitMessage({ byteLength, byteOffset, buffer }) {
	if (byteLength < MINIMUM_MESSAGE_LENGTH) throw new Error("Provided message too short to accommodate event stream message overhead");
	const view = new DataView(buffer, byteOffset, byteLength);
	const messageLength = view.getUint32(0, false);
	if (byteLength !== messageLength) throw new Error("Reported message length does not match received message length");
	const headerLength = view.getUint32(PRELUDE_MEMBER_LENGTH, false);
	const expectedPreludeChecksum = view.getUint32(PRELUDE_LENGTH, false);
	const expectedMessageChecksum = view.getUint32(byteLength - CHECKSUM_LENGTH, false);
	const checksummer = new import_main$1.Crc32().update(new Uint8Array(buffer, byteOffset, PRELUDE_LENGTH));
	if (expectedPreludeChecksum !== checksummer.digest()) throw new Error(`The prelude checksum specified in the message (${expectedPreludeChecksum}) does not match the calculated CRC32 checksum (${checksummer.digest()})`);
	checksummer.update(new Uint8Array(buffer, byteOffset + PRELUDE_LENGTH, byteLength - 12));
	if (expectedMessageChecksum !== checksummer.digest()) throw new Error(`The message checksum (${checksummer.digest()}) did not match the expected value of ${expectedMessageChecksum}`);
	return {
		headers: new DataView(buffer, byteOffset + PRELUDE_LENGTH + CHECKSUM_LENGTH, headerLength),
		body: new Uint8Array(buffer, byteOffset + PRELUDE_LENGTH + CHECKSUM_LENGTH + headerLength, messageLength - headerLength - 16)
	};
}
var import_main$1, PRELUDE_MEMBER_LENGTH, PRELUDE_LENGTH, CHECKSUM_LENGTH, MINIMUM_MESSAGE_LENGTH;
var init_splitMessage = __esmMin((() => {
	import_main$1 = require_main();
	PRELUDE_MEMBER_LENGTH = 4;
	PRELUDE_LENGTH = PRELUDE_MEMBER_LENGTH * 2;
	CHECKSUM_LENGTH = 4;
	MINIMUM_MESSAGE_LENGTH = 16;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/EventStreamCodec.js
var import_main, EventStreamCodec;
var init_EventStreamCodec = __esmMin((() => {
	import_main = require_main();
	init_HeaderMarshaller();
	init_splitMessage();
	EventStreamCodec = class {
		headerMarshaller;
		messageBuffer;
		isEndOfStream;
		constructor(toUtf8, fromUtf8) {
			this.headerMarshaller = new HeaderMarshaller(toUtf8, fromUtf8);
			this.messageBuffer = [];
			this.isEndOfStream = false;
		}
		feed(message) {
			this.messageBuffer.push(this.decode(message));
		}
		endOfStream() {
			this.isEndOfStream = true;
		}
		getMessage() {
			const message = this.messageBuffer.pop();
			const isEndOfStream = this.isEndOfStream;
			return {
				getMessage() {
					return message;
				},
				isEndOfStream() {
					return isEndOfStream;
				}
			};
		}
		getAvailableMessages() {
			const messages = this.messageBuffer;
			this.messageBuffer = [];
			const isEndOfStream = this.isEndOfStream;
			return {
				getMessages() {
					return messages;
				},
				isEndOfStream() {
					return isEndOfStream;
				}
			};
		}
		encode({ headers: rawHeaders, body }) {
			const headers = this.headerMarshaller.format(rawHeaders);
			const length = headers.byteLength + body.byteLength + 16;
			const out = new Uint8Array(length);
			const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
			const checksum = new import_main.Crc32();
			view.setUint32(0, length, false);
			view.setUint32(4, headers.byteLength, false);
			view.setUint32(8, checksum.update(out.subarray(0, 8)).digest(), false);
			out.set(headers, 12);
			out.set(body, headers.byteLength + 12);
			view.setUint32(length - 4, checksum.update(out.subarray(8, length - 4)).digest(), false);
			return out;
		}
		decode(message) {
			const { headers, body } = splitMessage(message);
			return {
				headers: this.headerMarshaller.parse(headers),
				body
			};
		}
		formatHeaders(rawHeaders) {
			return this.headerMarshaller.format(rawHeaders);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/MessageDecoderStream.js
var MessageDecoderStream;
var init_MessageDecoderStream = __esmMin((() => {
	MessageDecoderStream = class {
		options;
		constructor(options) {
			this.options = options;
		}
		[Symbol.asyncIterator]() {
			return this.asyncIterator();
		}
		async *asyncIterator() {
			for await (const bytes of this.options.inputStream) yield this.options.decoder.decode(bytes);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/MessageEncoderStream.js
var MessageEncoderStream;
var init_MessageEncoderStream = __esmMin((() => {
	MessageEncoderStream = class {
		options;
		constructor(options) {
			this.options = options;
		}
		[Symbol.asyncIterator]() {
			return this.asyncIterator();
		}
		async *asyncIterator() {
			for await (const msg of this.options.messageStream) yield this.options.encoder.encode(msg);
			if (this.options.includeEndFrame) yield new Uint8Array(0);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/SmithyMessageDecoderStream.js
var SmithyMessageDecoderStream;
var init_SmithyMessageDecoderStream = __esmMin((() => {
	SmithyMessageDecoderStream = class {
		options;
		constructor(options) {
			this.options = options;
		}
		[Symbol.asyncIterator]() {
			return this.asyncIterator();
		}
		async *asyncIterator() {
			for await (const message of this.options.messageStream) {
				const deserialized = await this.options.deserializer(message);
				if (deserialized === void 0) continue;
				yield deserialized;
			}
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-codec/SmithyMessageEncoderStream.js
var SmithyMessageEncoderStream;
var init_SmithyMessageEncoderStream = __esmMin((() => {
	SmithyMessageEncoderStream = class {
		options;
		constructor(options) {
			this.options = options;
		}
		[Symbol.asyncIterator]() {
			return this.asyncIterator();
		}
		async *asyncIterator() {
			for await (const chunk of this.options.inputStream) yield this.options.serializer(chunk);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde-universal/getChunkedStream.js
function getChunkedStream(source) {
	let currentMessageTotalLength = 0;
	let currentMessagePendingLength = 0;
	let currentMessage = null;
	let messageLengthBuffer = null;
	const allocateMessage = (size) => {
		if (typeof size !== "number") throw new Error("Attempted to allocate an event message where size was not a number: " + size);
		currentMessageTotalLength = size;
		currentMessagePendingLength = 4;
		currentMessage = new Uint8Array(size);
		new DataView(currentMessage.buffer).setUint32(0, size, false);
	};
	const iterator = async function* () {
		const sourceIterator = source[Symbol.asyncIterator]();
		while (true) {
			const { value, done } = await sourceIterator.next();
			if (done) {
				if (!currentMessageTotalLength) return;
				else if (currentMessageTotalLength === currentMessagePendingLength) yield currentMessage;
				else throw new Error("Truncated event message received.");
				return;
			}
			const chunkLength = value.length;
			let currentOffset = 0;
			while (currentOffset < chunkLength) {
				if (!currentMessage) {
					const bytesRemaining = chunkLength - currentOffset;
					if (!messageLengthBuffer) messageLengthBuffer = new Uint8Array(4);
					const numBytesForTotal = Math.min(4 - currentMessagePendingLength, bytesRemaining);
					messageLengthBuffer.set(value.slice(currentOffset, currentOffset + numBytesForTotal), currentMessagePendingLength);
					currentMessagePendingLength += numBytesForTotal;
					currentOffset += numBytesForTotal;
					if (currentMessagePendingLength < 4) break;
					allocateMessage(new DataView(messageLengthBuffer.buffer).getUint32(0, false));
					messageLengthBuffer = null;
				}
				const numBytesToWrite = Math.min(currentMessageTotalLength - currentMessagePendingLength, chunkLength - currentOffset);
				currentMessage.set(value.slice(currentOffset, currentOffset + numBytesToWrite), currentMessagePendingLength);
				currentMessagePendingLength += numBytesToWrite;
				currentOffset += numBytesToWrite;
				if (currentMessageTotalLength && currentMessageTotalLength === currentMessagePendingLength) {
					yield currentMessage;
					currentMessage = null;
					currentMessageTotalLength = 0;
					currentMessagePendingLength = 0;
				}
			}
		}
	};
	return { [Symbol.asyncIterator]: iterator };
}
var init_getChunkedStream = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde-universal/getUnmarshalledStream.js
function getUnmarshalledStream(source, options) {
	const messageUnmarshaller = getMessageUnmarshaller(options.deserializer, options.toUtf8);
	return { [Symbol.asyncIterator]: async function* () {
		for await (const chunk of source) {
			const type = await messageUnmarshaller(options.eventStreamCodec.decode(chunk));
			if (type === void 0) continue;
			yield type;
		}
	} };
}
function getMessageUnmarshaller(deserializer, toUtf8) {
	return async function(message) {
		const { value: messageType } = message.headers[":message-type"];
		if (messageType === "error") {
			const unmodeledError = new Error(message.headers[":error-message"].value || "UnknownError");
			unmodeledError.name = message.headers[":error-code"].value;
			throw unmodeledError;
		} else if (messageType === "exception") {
			const code = message.headers[":exception-type"].value;
			const deserializedException = await deserializer({ [code]: message });
			if (deserializedException.$unknown) {
				const error = new Error(toUtf8(message.body));
				error.name = code;
				throw error;
			}
			throw deserializedException[code];
		} else if (messageType === "event") {
			const deserialized = await deserializer({ [message.headers[":event-type"].value]: message });
			if (deserialized.$unknown) return;
			return deserialized;
		} else throw Error(`Unrecognizable event type: ${message.headers[":event-type"].value}`);
	};
}
var init_getUnmarshalledStream = __esmMin((() => {}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde-universal/EventStreamMarshaller.js
var EventStreamMarshaller$1, eventStreamSerdeProvider$1;
var init_EventStreamMarshaller$1 = __esmMin((() => {
	init_EventStreamCodec();
	init_MessageDecoderStream();
	init_MessageEncoderStream();
	init_SmithyMessageDecoderStream();
	init_SmithyMessageEncoderStream();
	init_getChunkedStream();
	init_getUnmarshalledStream();
	EventStreamMarshaller$1 = class {
		eventStreamCodec;
		utfEncoder;
		constructor({ utf8Encoder, utf8Decoder }) {
			this.eventStreamCodec = new EventStreamCodec(utf8Encoder, utf8Decoder);
			this.utfEncoder = utf8Encoder;
		}
		deserialize(body, deserializer) {
			return new SmithyMessageDecoderStream({
				messageStream: new MessageDecoderStream({
					inputStream: getChunkedStream(body),
					decoder: this.eventStreamCodec
				}),
				deserializer: getMessageUnmarshaller(deserializer, this.utfEncoder)
			});
		}
		serialize(inputStream, serializer) {
			return new MessageEncoderStream({
				messageStream: new SmithyMessageEncoderStream({
					inputStream,
					serializer
				}),
				encoder: this.eventStreamCodec,
				includeEndFrame: true
			});
		}
	};
	eventStreamSerdeProvider$1 = (options) => new EventStreamMarshaller$1(options);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde/EventStreamMarshaller.js
async function* readableToIterable(readStream) {
	let streamEnded = false;
	let generationEnded = false;
	const records = new Array();
	readStream.on("error", (err) => {
		if (!streamEnded) streamEnded = true;
		if (err) throw err;
	});
	readStream.on("data", (data) => {
		records.push(data);
	});
	readStream.on("end", () => {
		streamEnded = true;
	});
	while (!generationEnded) {
		const value = await new Promise((resolve) => setTimeout(() => resolve(records.shift()), 0));
		if (value) yield value;
		generationEnded = streamEnded && records.length === 0;
	}
}
var EventStreamMarshaller, eventStreamSerdeProvider;
var init_EventStreamMarshaller = __esmMin((() => {
	init_EventStreamMarshaller$1();
	EventStreamMarshaller = class {
		universalMarshaller;
		constructor({ utf8Encoder, utf8Decoder }) {
			this.universalMarshaller = new EventStreamMarshaller$1({
				utf8Decoder,
				utf8Encoder
			});
		}
		deserialize(body, deserializer) {
			const bodyIterable = typeof body[Symbol.asyncIterator] === "function" ? body : readableToIterable(body);
			return this.universalMarshaller.deserialize(bodyIterable, deserializer);
		}
		serialize(input, serializer) {
			return Readable.from(this.universalMarshaller.serialize(input, serializer));
		}
	};
	eventStreamSerdeProvider = (options) => new EventStreamMarshaller(options);
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde/utils.js
var readableStreamToIterable, iterableToReadableStream;
var init_utils = __esmMin((() => {
	readableStreamToIterable = (readableStream) => ({ [Symbol.asyncIterator]: async function* () {
		const reader = readableStream.getReader();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) return;
				yield value;
			}
		} finally {
			reader.releaseLock();
		}
	} });
	iterableToReadableStream = (asyncIterable) => {
		const iterator = asyncIterable[Symbol.asyncIterator]();
		return new ReadableStream({ async pull(controller) {
			const { done, value } = await iterator.next();
			if (done) return controller.close();
			controller.enqueue(value);
		} });
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/eventstream-serde-config-resolver/EventStreamSerdeConfig.js
var resolveEventStreamSerdeConfig;
var init_EventStreamSerdeConfig = __esmMin((() => {
	resolveEventStreamSerdeConfig = (input) => Object.assign(input, { eventStreamMarshaller: input.eventStreamSerdeProvider(input) });
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/EventStreamSerde.js
var EventStreamSerde;
var init_EventStreamSerde = __esmMin((() => {
	init_serde();
	EventStreamSerde = class {
		marshaller;
		serializer;
		deserializer;
		serdeContext;
		defaultContentType;
		constructor({ marshaller, serializer, deserializer, serdeContext, defaultContentType }) {
			this.marshaller = marshaller;
			this.serializer = serializer;
			this.deserializer = deserializer;
			this.serdeContext = serdeContext;
			this.defaultContentType = defaultContentType;
		}
		async serializeEventStream({ eventStream, requestSchema, initialRequest }) {
			const marshaller = this.marshaller;
			const eventStreamMember = requestSchema.getEventStreamMember();
			const unionSchema = requestSchema.getMemberSchema(eventStreamMember);
			const serializer = this.serializer;
			const defaultContentType = this.defaultContentType;
			const initialRequestMarker = Symbol("initialRequestMarker");
			const eventStreamIterable = { async *[Symbol.asyncIterator]() {
				if (initialRequest) {
					const headers = {
						":event-type": {
							type: "string",
							value: "initial-request"
						},
						":message-type": {
							type: "string",
							value: "event"
						},
						":content-type": {
							type: "string",
							value: defaultContentType
						}
					};
					serializer.write(requestSchema, initialRequest);
					const body = serializer.flush();
					yield {
						[initialRequestMarker]: true,
						headers,
						body
					};
				}
				for await (const page of eventStream) yield page;
			} };
			return marshaller.serialize(eventStreamIterable, (event) => {
				if (event[initialRequestMarker]) return {
					headers: event.headers,
					body: event.body
				};
				let unionMember = "";
				for (const key in event) if (key !== "__type") {
					unionMember = key;
					break;
				}
				const { additionalHeaders, body, eventType, explicitPayloadContentType } = this.writeEventBody(unionMember, unionSchema, event);
				return {
					headers: {
						":event-type": {
							type: "string",
							value: eventType
						},
						":message-type": {
							type: "string",
							value: "event"
						},
						":content-type": {
							type: "string",
							value: explicitPayloadContentType ?? defaultContentType
						},
						...additionalHeaders
					},
					body
				};
			});
		}
		async deserializeEventStream({ response, responseSchema, initialResponseContainer }) {
			const marshaller = this.marshaller;
			const eventStreamMember = responseSchema.getEventStreamMember();
			const memberSchemas = responseSchema.getMemberSchema(eventStreamMember).getMemberSchemas();
			const initialResponseMarker = Symbol("initialResponseMarker");
			const asyncIterable = marshaller.deserialize(response.body, async (event) => {
				let unionMember = "";
				for (const key in event) if (key !== "__type") {
					unionMember = key;
					break;
				}
				const body = event[unionMember].body;
				if (unionMember === "initial-response") {
					const dataObject = await this.deserializer.read(responseSchema, body);
					delete dataObject[eventStreamMember];
					return {
						[initialResponseMarker]: true,
						...dataObject
					};
				} else if (unionMember in memberSchemas) {
					const eventStreamSchema = memberSchemas[unionMember];
					if (eventStreamSchema.isStructSchema()) {
						const out = {};
						let hasBindings = false;
						for (const [name, member] of eventStreamSchema.structIterator()) {
							const { eventHeader, eventPayload } = member.getMergedTraits();
							hasBindings = hasBindings || Boolean(eventHeader || eventPayload);
							if (eventPayload) {
								if (member.isBlobSchema()) out[name] = body;
								else if (member.isStringSchema()) out[name] = (this.serdeContext?.utf8Encoder ?? toUtf8)(body);
								else if (member.isStructSchema()) out[name] = await this.deserializer.read(member, body);
							} else if (eventHeader) {
								const value = event[unionMember].headers[name]?.value;
								if (value != null) if (member.isNumericSchema()) if (value && typeof value === "object" && "bytes" in value) out[name] = BigInt(value.toString());
								else out[name] = Number(value);
								else out[name] = value;
							}
						}
						if (hasBindings) return { [unionMember]: out };
						if (body.byteLength === 0) return { [unionMember]: {} };
					}
					return { [unionMember]: await this.deserializer.read(eventStreamSchema, body) };
				} else return { $unknown: event };
			});
			const asyncIterator = asyncIterable[Symbol.asyncIterator]();
			const firstEvent = await asyncIterator.next();
			if (firstEvent.done) return asyncIterable;
			if (firstEvent.value?.[initialResponseMarker]) {
				if (!responseSchema) throw new Error("@smithy::core/protocols - initial-response event encountered in event stream but no response schema given.");
				for (const key in firstEvent.value) initialResponseContainer[key] = firstEvent.value[key];
			}
			return { async *[Symbol.asyncIterator]() {
				if (!firstEvent?.value?.[initialResponseMarker]) yield firstEvent.value;
				while (true) {
					const { done, value } = await asyncIterator.next();
					if (done) break;
					yield value;
				}
			} };
		}
		writeEventBody(unionMember, unionSchema, event) {
			const serializer = this.serializer;
			let eventType = unionMember;
			let explicitPayloadMember = null;
			let explicitPayloadContentType;
			const isKnownSchema = unionSchema.getSchema()[4].includes(unionMember);
			const additionalHeaders = {};
			if (!isKnownSchema) {
				const [type, value] = event[unionMember];
				eventType = type;
				serializer.write(15, value);
			} else {
				const eventSchema = unionSchema.getMemberSchema(unionMember);
				if (eventSchema.isStructSchema()) {
					for (const [memberName, memberSchema] of eventSchema.structIterator()) {
						const { eventHeader, eventPayload } = memberSchema.getMergedTraits();
						if (eventPayload) explicitPayloadMember = memberName;
						else if (eventHeader) {
							const value = event[unionMember][memberName];
							let type = "binary";
							if (memberSchema.isNumericSchema()) if ((-2) ** 31 <= value && value <= 2 ** 31 - 1) type = "integer";
							else type = "long";
							else if (memberSchema.isTimestampSchema()) type = "timestamp";
							else if (memberSchema.isStringSchema()) type = "string";
							else if (memberSchema.isBooleanSchema()) type = "boolean";
							if (value != null) {
								additionalHeaders[memberName] = {
									type,
									value
								};
								delete event[unionMember][memberName];
							}
						}
					}
					if (explicitPayloadMember !== null) {
						const payloadSchema = eventSchema.getMemberSchema(explicitPayloadMember);
						if (payloadSchema.isBlobSchema()) explicitPayloadContentType = "application/octet-stream";
						else if (payloadSchema.isStringSchema()) explicitPayloadContentType = "text/plain";
						serializer.write(payloadSchema, event[unionMember][explicitPayloadMember]);
					} else serializer.write(eventSchema, event[unionMember]);
				} else if (eventSchema.isUnitSchema()) serializer.write(eventSchema, {});
				else throw new Error("@smithy/core/event-streams - non-struct member not supported in event stream union.");
			}
			const messageSerialization = serializer.flush() ?? new Uint8Array();
			return {
				body: typeof messageSerialization === "string" ? (this.serdeContext?.utf8Decoder ?? fromUtf8)(messageSerialization) : messageSerialization,
				eventType,
				explicitPayloadContentType,
				additionalHeaders
			};
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/event-streams/index.js
var event_streams_exports = /* @__PURE__ */ __exportAll({
	EventStreamCodec: () => EventStreamCodec,
	EventStreamMarshaller: () => EventStreamMarshaller,
	EventStreamSerde: () => EventStreamSerde,
	HeaderMarshaller: () => HeaderMarshaller,
	Int64: () => Int64,
	MessageDecoderStream: () => MessageDecoderStream,
	MessageEncoderStream: () => MessageEncoderStream,
	SmithyMessageDecoderStream: () => SmithyMessageDecoderStream,
	SmithyMessageEncoderStream: () => SmithyMessageEncoderStream,
	UniversalEventStreamMarshaller: () => EventStreamMarshaller$1,
	eventStreamSerdeProvider: () => eventStreamSerdeProvider,
	getChunkedStream: () => getChunkedStream,
	getMessageUnmarshaller: () => getMessageUnmarshaller,
	getUnmarshalledStream: () => getUnmarshalledStream,
	iterableToReadableStream: () => iterableToReadableStream,
	readableStreamToIterable: () => readableStreamToIterable,
	resolveEventStreamSerdeConfig: () => resolveEventStreamSerdeConfig,
	universalEventStreamSerdeProvider: () => eventStreamSerdeProvider$1
});
var init_event_streams = __esmMin((() => {
	init_EventStreamCodec();
	init_HeaderMarshaller();
	init_Int64();
	init_MessageDecoderStream();
	init_MessageEncoderStream();
	init_SmithyMessageDecoderStream();
	init_SmithyMessageEncoderStream();
	init_EventStreamMarshaller();
	init_utils();
	init_EventStreamMarshaller$1();
	init_getChunkedStream();
	init_getUnmarshalledStream();
	init_EventStreamSerdeConfig();
	init_EventStreamSerde();
}));
//#endregion
export { init_EventStreamCodec as A, SmithyMessageDecoderStream as C, MessageDecoderStream as D, init_MessageEncoderStream as E, require_main as F, require_main$1 as I, init_HeaderMarshaller as M, Int64 as N, init_MessageDecoderStream as O, init_Int64 as P, init_SmithyMessageEncoderStream as S, MessageEncoderStream as T, getUnmarshalledStream as _, init_EventStreamSerdeConfig as a, init_getChunkedStream as b, iterableToReadableStream as c, eventStreamSerdeProvider as d, init_EventStreamMarshaller as f, getMessageUnmarshaller as g, init_EventStreamMarshaller$1 as h, init_EventStreamSerde as i, HeaderMarshaller as j, EventStreamCodec as k, readableStreamToIterable as l, eventStreamSerdeProvider$1 as m, init_event_streams as n, resolveEventStreamSerdeConfig as o, EventStreamMarshaller$1 as p, EventStreamSerde as r, init_utils as s, event_streams_exports as t, EventStreamMarshaller as u, init_getUnmarshalledStream as v, init_SmithyMessageDecoderStream as w, SmithyMessageEncoderStream as x, getChunkedStream as y };
