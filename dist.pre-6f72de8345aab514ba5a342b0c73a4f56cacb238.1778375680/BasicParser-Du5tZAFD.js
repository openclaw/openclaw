import { r as __exportAll, s as __toESM, t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#endregion
//#region node_modules/@borewit/text-codec/lib/index.js
var import_ieee754 = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
	/*! ieee754. BSD-3-Clause License. Feross Aboukhadijeh <https://feross.org/opensource> */
	exports.read = function(buffer, offset, isLE, mLen, nBytes) {
		var e, m;
		var eLen = nBytes * 8 - mLen - 1;
		var eMax = (1 << eLen) - 1;
		var eBias = eMax >> 1;
		var nBits = -7;
		var i = isLE ? nBytes - 1 : 0;
		var d = isLE ? -1 : 1;
		var s = buffer[offset + i];
		i += d;
		e = s & (1 << -nBits) - 1;
		s >>= -nBits;
		nBits += eLen;
		for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8);
		m = e & (1 << -nBits) - 1;
		e >>= -nBits;
		nBits += mLen;
		for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8);
		if (e === 0) e = 1 - eBias;
		else if (e === eMax) return m ? NaN : (s ? -1 : 1) * Infinity;
		else {
			m = m + Math.pow(2, mLen);
			e = e - eBias;
		}
		return (s ? -1 : 1) * m * Math.pow(2, e - mLen);
	};
	exports.write = function(buffer, value, offset, isLE, mLen, nBytes) {
		var e, m, c;
		var eLen = nBytes * 8 - mLen - 1;
		var eMax = (1 << eLen) - 1;
		var eBias = eMax >> 1;
		var rt = mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0;
		var i = isLE ? 0 : nBytes - 1;
		var d = isLE ? 1 : -1;
		var s = value < 0 || value === 0 && 1 / value < 0 ? 1 : 0;
		value = Math.abs(value);
		if (isNaN(value) || value === Infinity) {
			m = isNaN(value) ? 1 : 0;
			e = eMax;
		} else {
			e = Math.floor(Math.log(value) / Math.LN2);
			if (value * (c = Math.pow(2, -e)) < 1) {
				e--;
				c *= 2;
			}
			if (e + eBias >= 1) value += rt / c;
			else value += rt * Math.pow(2, 1 - eBias);
			if (value * c >= 2) {
				e++;
				c /= 2;
			}
			if (e + eBias >= eMax) {
				m = 0;
				e = eMax;
			} else if (e + eBias >= 1) {
				m = (value * c - 1) * Math.pow(2, mLen);
				e = e + eBias;
			} else {
				m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen);
				e = 0;
			}
		}
		for (; mLen >= 8; buffer[offset + i] = m & 255, i += d, m /= 256, mLen -= 8);
		e = e << mLen | m;
		eLen += mLen;
		for (; eLen > 0; buffer[offset + i] = e & 255, i += d, e /= 256, eLen -= 8);
		buffer[offset + i - d] |= s * 128;
	};
})))(), 1);
const WINDOWS_1252_EXTRA = {
	128: "€",
	130: "‚",
	131: "ƒ",
	132: "„",
	133: "…",
	134: "†",
	135: "‡",
	136: "ˆ",
	137: "‰",
	138: "Š",
	139: "‹",
	140: "Œ",
	142: "Ž",
	145: "‘",
	146: "’",
	147: "“",
	148: "”",
	149: "•",
	150: "–",
	151: "—",
	152: "˜",
	153: "™",
	154: "š",
	155: "›",
	156: "œ",
	158: "ž",
	159: "Ÿ"
};
const WINDOWS_1252_REVERSE = {};
for (const [code, char] of Object.entries(WINDOWS_1252_EXTRA)) WINDOWS_1252_REVERSE[char] = Number.parseInt(code, 10);
let _utf8Decoder;
let _utf8Encoder;
function utf8Decoder() {
	if (typeof globalThis.TextDecoder === "undefined") return void 0;
	return _utf8Decoder !== null && _utf8Decoder !== void 0 ? _utf8Decoder : _utf8Decoder = new globalThis.TextDecoder("utf-8");
}
function utf8Encoder() {
	if (typeof globalThis.TextEncoder === "undefined") return void 0;
	return _utf8Encoder !== null && _utf8Encoder !== void 0 ? _utf8Encoder : _utf8Encoder = new globalThis.TextEncoder();
}
const CHUNK = 32 * 1024;
const REPLACEMENT = 65533;
/**
* Decode text from binary data
*/
function textDecode(bytes, encoding = "utf-8") {
	switch (encoding.toLowerCase()) {
		case "utf-8":
		case "utf8": {
			const dec = utf8Decoder();
			return dec ? dec.decode(bytes) : decodeUTF8(bytes);
		}
		case "utf-16le": return decodeUTF16LE(bytes);
		case "us-ascii":
		case "ascii": return decodeASCII(bytes);
		case "latin1":
		case "iso-8859-1": return decodeLatin1(bytes);
		case "windows-1252": return decodeWindows1252(bytes);
		default: throw new RangeError(`Encoding '${encoding}' not supported`);
	}
}
function textEncode(input = "", encoding = "utf-8") {
	switch (encoding.toLowerCase()) {
		case "utf-8":
		case "utf8": {
			const enc = utf8Encoder();
			return enc ? enc.encode(input) : encodeUTF8(input);
		}
		case "utf-16le": return encodeUTF16LE(input);
		case "us-ascii":
		case "ascii": return encodeASCII(input);
		case "latin1":
		case "iso-8859-1": return encodeLatin1(input);
		case "windows-1252": return encodeWindows1252(input);
		default: throw new RangeError(`Encoding '${encoding}' not supported`);
	}
}
function flushChunk(parts, chunk) {
	if (chunk.length === 0) return;
	parts.push(String.fromCharCode.apply(null, chunk));
	chunk.length = 0;
}
function pushCodeUnit(parts, chunk, codeUnit) {
	chunk.push(codeUnit);
	if (chunk.length >= CHUNK) flushChunk(parts, chunk);
}
function pushCodePoint(parts, chunk, cp) {
	if (cp <= 65535) {
		pushCodeUnit(parts, chunk, cp);
		return;
	}
	cp -= 65536;
	pushCodeUnit(parts, chunk, 55296 + (cp >> 10));
	pushCodeUnit(parts, chunk, 56320 + (cp & 1023));
}
function decodeUTF8(bytes) {
	const parts = [];
	const chunk = [];
	let i = 0;
	if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) i = 3;
	while (i < bytes.length) {
		const b1 = bytes[i];
		if (b1 <= 127) {
			pushCodeUnit(parts, chunk, b1);
			i++;
			continue;
		}
		if (b1 < 194 || b1 > 244) {
			pushCodeUnit(parts, chunk, REPLACEMENT);
			i++;
			continue;
		}
		if (b1 <= 223) {
			if (i + 1 >= bytes.length) {
				pushCodeUnit(parts, chunk, REPLACEMENT);
				i++;
				continue;
			}
			const b2 = bytes[i + 1];
			if ((b2 & 192) !== 128) {
				pushCodeUnit(parts, chunk, REPLACEMENT);
				i++;
				continue;
			}
			pushCodeUnit(parts, chunk, (b1 & 31) << 6 | b2 & 63);
			i += 2;
			continue;
		}
		if (b1 <= 239) {
			if (i + 2 >= bytes.length) {
				pushCodeUnit(parts, chunk, REPLACEMENT);
				i++;
				continue;
			}
			const b2 = bytes[i + 1];
			const b3 = bytes[i + 2];
			if (!((b2 & 192) === 128 && (b3 & 192) === 128 && !(b1 === 224 && b2 < 160) && !(b1 === 237 && b2 >= 160))) {
				pushCodeUnit(parts, chunk, REPLACEMENT);
				i++;
				continue;
			}
			pushCodeUnit(parts, chunk, (b1 & 15) << 12 | (b2 & 63) << 6 | b3 & 63);
			i += 3;
			continue;
		}
		if (i + 3 >= bytes.length) {
			pushCodeUnit(parts, chunk, REPLACEMENT);
			i++;
			continue;
		}
		const b2 = bytes[i + 1];
		const b3 = bytes[i + 2];
		const b4 = bytes[i + 3];
		if (!((b2 & 192) === 128 && (b3 & 192) === 128 && (b4 & 192) === 128 && !(b1 === 240 && b2 < 144) && !(b1 === 244 && b2 > 143))) {
			pushCodeUnit(parts, chunk, REPLACEMENT);
			i++;
			continue;
		}
		pushCodePoint(parts, chunk, (b1 & 7) << 18 | (b2 & 63) << 12 | (b3 & 63) << 6 | b4 & 63);
		i += 4;
	}
	flushChunk(parts, chunk);
	return parts.join("");
}
function decodeUTF16LE(bytes) {
	const parts = [];
	const chunk = [];
	const len = bytes.length;
	let i = 0;
	while (i + 1 < len) {
		const u1 = bytes[i] | bytes[i + 1] << 8;
		i += 2;
		if (u1 >= 55296 && u1 <= 56319) {
			if (i + 1 < len) {
				const u2 = bytes[i] | bytes[i + 1] << 8;
				if (u2 >= 56320 && u2 <= 57343) {
					pushCodeUnit(parts, chunk, u1);
					pushCodeUnit(parts, chunk, u2);
					i += 2;
				} else pushCodeUnit(parts, chunk, REPLACEMENT);
			} else pushCodeUnit(parts, chunk, REPLACEMENT);
			continue;
		}
		if (u1 >= 56320 && u1 <= 57343) {
			pushCodeUnit(parts, chunk, REPLACEMENT);
			continue;
		}
		pushCodeUnit(parts, chunk, u1);
	}
	if (i < len) pushCodeUnit(parts, chunk, REPLACEMENT);
	flushChunk(parts, chunk);
	return parts.join("");
}
function decodeASCII(bytes) {
	const parts = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const end = Math.min(bytes.length, i + CHUNK);
		const codes = new Array(end - i);
		for (let j = i, k = 0; j < end; j++, k++) codes[k] = bytes[j] & 127;
		parts.push(String.fromCharCode.apply(null, codes));
	}
	return parts.join("");
}
function decodeLatin1(bytes) {
	const parts = [];
	for (let i = 0; i < bytes.length; i += CHUNK) {
		const end = Math.min(bytes.length, i + CHUNK);
		const codes = new Array(end - i);
		for (let j = i, k = 0; j < end; j++, k++) codes[k] = bytes[j];
		parts.push(String.fromCharCode.apply(null, codes));
	}
	return parts.join("");
}
function decodeWindows1252(bytes) {
	const parts = [];
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		const extra = b >= 128 && b <= 159 ? WINDOWS_1252_EXTRA[b] : void 0;
		out += extra !== null && extra !== void 0 ? extra : String.fromCharCode(b);
		if (out.length >= CHUNK) {
			parts.push(out);
			out = "";
		}
	}
	if (out) parts.push(out);
	return parts.join("");
}
function encodeUTF8(str) {
	const out = [];
	for (let i = 0; i < str.length; i++) {
		let cp = str.charCodeAt(i);
		if (cp >= 55296 && cp <= 56319) if (i + 1 < str.length) {
			const lo = str.charCodeAt(i + 1);
			if (lo >= 56320 && lo <= 57343) {
				cp = 65536 + (cp - 55296 << 10) + (lo - 56320);
				i++;
			} else cp = REPLACEMENT;
		} else cp = REPLACEMENT;
		else if (cp >= 56320 && cp <= 57343) cp = REPLACEMENT;
		if (cp < 128) out.push(cp);
		else if (cp < 2048) out.push(192 | cp >> 6, 128 | cp & 63);
		else if (cp < 65536) out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
		else out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
	}
	return new Uint8Array(out);
}
function encodeUTF16LE(str) {
	const units = [];
	for (let i = 0; i < str.length; i++) {
		const u = str.charCodeAt(i);
		if (u >= 55296 && u <= 56319) {
			if (i + 1 < str.length) {
				const lo = str.charCodeAt(i + 1);
				if (lo >= 56320 && lo <= 57343) {
					units.push(u, lo);
					i++;
				} else units.push(REPLACEMENT);
			} else units.push(REPLACEMENT);
			continue;
		}
		if (u >= 56320 && u <= 57343) {
			units.push(REPLACEMENT);
			continue;
		}
		units.push(u);
	}
	const out = new Uint8Array(units.length * 2);
	for (let i = 0; i < units.length; i++) {
		const code = units[i];
		const o = i * 2;
		out[o] = code & 255;
		out[o + 1] = code >>> 8;
	}
	return out;
}
function encodeASCII(str) {
	const out = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 127;
	return out;
}
function encodeLatin1(str) {
	const out = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
	return out;
}
function encodeWindows1252(str) {
	const out = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		const code = ch.charCodeAt(0);
		if (WINDOWS_1252_REVERSE[ch] !== void 0) {
			out[i] = WINDOWS_1252_REVERSE[ch];
			continue;
		}
		if (code >= 0 && code <= 127 || code >= 160 && code <= 255) {
			out[i] = code;
			continue;
		}
		out[i] = 63;
	}
	return out;
}
//#endregion
//#region node_modules/token-types/lib/index.js
var lib_exports = /* @__PURE__ */ __exportAll({
	AnsiStringType: () => AnsiStringType,
	Float16_BE: () => Float16_BE,
	Float16_LE: () => Float16_LE,
	Float32_BE: () => Float32_BE,
	Float32_LE: () => Float32_LE,
	Float64_BE: () => Float64_BE,
	Float64_LE: () => Float64_LE,
	Float80_BE: () => Float80_BE,
	Float80_LE: () => Float80_LE,
	INT16_BE: () => INT16_BE,
	INT16_LE: () => INT16_LE,
	INT24_BE: () => INT24_BE,
	INT24_LE: () => INT24_LE,
	INT32_BE: () => INT32_BE,
	INT32_LE: () => INT32_LE,
	INT64_BE: () => INT64_BE,
	INT64_LE: () => INT64_LE,
	INT8: () => INT8,
	IgnoreType: () => IgnoreType,
	StringType: () => StringType,
	UINT16_BE: () => UINT16_BE,
	UINT16_LE: () => UINT16_LE,
	UINT24_BE: () => UINT24_BE,
	UINT24_LE: () => UINT24_LE,
	UINT32_BE: () => UINT32_BE,
	UINT32_LE: () => UINT32_LE,
	UINT64_BE: () => UINT64_BE,
	UINT64_LE: () => UINT64_LE,
	UINT8: () => UINT8,
	Uint8ArrayType: () => Uint8ArrayType
});
function dv(array) {
	return new DataView(array.buffer, array.byteOffset);
}
const UINT8 = {
	len: 1,
	get(array, offset) {
		return dv(array).getUint8(offset);
	},
	put(array, offset, value) {
		dv(array).setUint8(offset, value);
		return offset + 1;
	}
};
/**
* 16-bit unsigned integer, Little Endian byte order
*/
const UINT16_LE = {
	len: 2,
	get(array, offset) {
		return dv(array).getUint16(offset, true);
	},
	put(array, offset, value) {
		dv(array).setUint16(offset, value, true);
		return offset + 2;
	}
};
/**
* 16-bit unsigned integer, Big Endian byte order
*/
const UINT16_BE = {
	len: 2,
	get(array, offset) {
		return dv(array).getUint16(offset);
	},
	put(array, offset, value) {
		dv(array).setUint16(offset, value);
		return offset + 2;
	}
};
/**
* 24-bit unsigned integer, Little Endian byte order
*/
const UINT24_LE = {
	len: 3,
	get(array, offset) {
		const dataView = dv(array);
		return dataView.getUint8(offset) + (dataView.getUint16(offset + 1, true) << 8);
	},
	put(array, offset, value) {
		const dataView = dv(array);
		dataView.setUint8(offset, value & 255);
		dataView.setUint16(offset + 1, value >> 8, true);
		return offset + 3;
	}
};
/**
* 24-bit unsigned integer, Big Endian byte order
*/
const UINT24_BE = {
	len: 3,
	get(array, offset) {
		const dataView = dv(array);
		return (dataView.getUint16(offset) << 8) + dataView.getUint8(offset + 2);
	},
	put(array, offset, value) {
		const dataView = dv(array);
		dataView.setUint16(offset, value >> 8);
		dataView.setUint8(offset + 2, value & 255);
		return offset + 3;
	}
};
/**
* 32-bit unsigned integer, Little Endian byte order
*/
const UINT32_LE = {
	len: 4,
	get(array, offset) {
		return dv(array).getUint32(offset, true);
	},
	put(array, offset, value) {
		dv(array).setUint32(offset, value, true);
		return offset + 4;
	}
};
/**
* 32-bit unsigned integer, Big Endian byte order
*/
const UINT32_BE = {
	len: 4,
	get(array, offset) {
		return dv(array).getUint32(offset);
	},
	put(array, offset, value) {
		dv(array).setUint32(offset, value);
		return offset + 4;
	}
};
/**
* 8-bit signed integer
*/
const INT8 = {
	len: 1,
	get(array, offset) {
		return dv(array).getInt8(offset);
	},
	put(array, offset, value) {
		dv(array).setInt8(offset, value);
		return offset + 1;
	}
};
/**
* 16-bit signed integer, Big Endian byte order
*/
const INT16_BE = {
	len: 2,
	get(array, offset) {
		return dv(array).getInt16(offset);
	},
	put(array, offset, value) {
		dv(array).setInt16(offset, value);
		return offset + 2;
	}
};
/**
* 16-bit signed integer, Little Endian byte order
*/
const INT16_LE = {
	len: 2,
	get(array, offset) {
		return dv(array).getInt16(offset, true);
	},
	put(array, offset, value) {
		dv(array).setInt16(offset, value, true);
		return offset + 2;
	}
};
/**
* 24-bit signed integer, Little Endian byte order
*/
const INT24_LE = {
	len: 3,
	get(array, offset) {
		const unsigned = UINT24_LE.get(array, offset);
		return unsigned > 8388607 ? unsigned - 16777216 : unsigned;
	},
	put(array, offset, value) {
		const dataView = dv(array);
		dataView.setUint8(offset, value & 255);
		dataView.setUint16(offset + 1, value >> 8, true);
		return offset + 3;
	}
};
/**
* 24-bit signed integer, Big Endian byte order
*/
const INT24_BE = {
	len: 3,
	get(array, offset) {
		const unsigned = UINT24_BE.get(array, offset);
		return unsigned > 8388607 ? unsigned - 16777216 : unsigned;
	},
	put(array, offset, value) {
		const dataView = dv(array);
		dataView.setUint16(offset, value >> 8);
		dataView.setUint8(offset + 2, value & 255);
		return offset + 3;
	}
};
/**
* 32-bit signed integer, Big Endian byte order
*/
const INT32_BE = {
	len: 4,
	get(array, offset) {
		return dv(array).getInt32(offset);
	},
	put(array, offset, value) {
		dv(array).setInt32(offset, value);
		return offset + 4;
	}
};
/**
* 32-bit signed integer, Big Endian byte order
*/
const INT32_LE = {
	len: 4,
	get(array, offset) {
		return dv(array).getInt32(offset, true);
	},
	put(array, offset, value) {
		dv(array).setInt32(offset, value, true);
		return offset + 4;
	}
};
/**
* 64-bit unsigned integer, Little Endian byte order
*/
const UINT64_LE = {
	len: 8,
	get(array, offset) {
		return dv(array).getBigUint64(offset, true);
	},
	put(array, offset, value) {
		dv(array).setBigUint64(offset, value, true);
		return offset + 8;
	}
};
/**
* 64-bit signed integer, Little Endian byte order
*/
const INT64_LE = {
	len: 8,
	get(array, offset) {
		return dv(array).getBigInt64(offset, true);
	},
	put(array, offset, value) {
		dv(array).setBigInt64(offset, value, true);
		return offset + 8;
	}
};
/**
* 64-bit unsigned integer, Big Endian byte order
*/
const UINT64_BE = {
	len: 8,
	get(array, offset) {
		return dv(array).getBigUint64(offset);
	},
	put(array, offset, value) {
		dv(array).setBigUint64(offset, value);
		return offset + 8;
	}
};
/**
* 64-bit signed integer, Big Endian byte order
*/
const INT64_BE = {
	len: 8,
	get(array, offset) {
		return dv(array).getBigInt64(offset);
	},
	put(array, offset, value) {
		dv(array).setBigInt64(offset, value);
		return offset + 8;
	}
};
/**
* IEEE 754 16-bit (half precision) float, big endian
*/
const Float16_BE = {
	len: 2,
	get(dataView, offset) {
		return import_ieee754.read(dataView, offset, false, 10, this.len);
	},
	put(dataView, offset, value) {
		import_ieee754.write(dataView, value, offset, false, 10, this.len);
		return offset + this.len;
	}
};
/**
* IEEE 754 16-bit (half precision) float, little endian
*/
const Float16_LE = {
	len: 2,
	get(array, offset) {
		return import_ieee754.read(array, offset, true, 10, this.len);
	},
	put(array, offset, value) {
		import_ieee754.write(array, value, offset, true, 10, this.len);
		return offset + this.len;
	}
};
/**
* IEEE 754 32-bit (single precision) float, big endian
*/
const Float32_BE = {
	len: 4,
	get(array, offset) {
		return dv(array).getFloat32(offset);
	},
	put(array, offset, value) {
		dv(array).setFloat32(offset, value);
		return offset + 4;
	}
};
/**
* IEEE 754 32-bit (single precision) float, little endian
*/
const Float32_LE = {
	len: 4,
	get(array, offset) {
		return dv(array).getFloat32(offset, true);
	},
	put(array, offset, value) {
		dv(array).setFloat32(offset, value, true);
		return offset + 4;
	}
};
/**
* IEEE 754 64-bit (double precision) float, big endian
*/
const Float64_BE = {
	len: 8,
	get(array, offset) {
		return dv(array).getFloat64(offset);
	},
	put(array, offset, value) {
		dv(array).setFloat64(offset, value);
		return offset + 8;
	}
};
/**
* IEEE 754 64-bit (double precision) float, little endian
*/
const Float64_LE = {
	len: 8,
	get(array, offset) {
		return dv(array).getFloat64(offset, true);
	},
	put(array, offset, value) {
		dv(array).setFloat64(offset, value, true);
		return offset + 8;
	}
};
/**
* IEEE 754 80-bit (extended precision) float, big endian
*/
const Float80_BE = {
	len: 10,
	get(array, offset) {
		return import_ieee754.read(array, offset, false, 63, this.len);
	},
	put(array, offset, value) {
		import_ieee754.write(array, value, offset, false, 63, this.len);
		return offset + this.len;
	}
};
/**
* IEEE 754 80-bit (extended precision) float, little endian
*/
const Float80_LE = {
	len: 10,
	get(array, offset) {
		return import_ieee754.read(array, offset, true, 63, this.len);
	},
	put(array, offset, value) {
		import_ieee754.write(array, value, offset, true, 63, this.len);
		return offset + this.len;
	}
};
/**
* Ignore a given number of bytes
*/
var IgnoreType = class {
	/**
	* @param len number of bytes to ignore
	*/
	constructor(len) {
		this.len = len;
	}
	get(_array, _off) {}
};
var Uint8ArrayType = class {
	constructor(len) {
		this.len = len;
	}
	get(array, offset) {
		return array.subarray(offset, offset + this.len);
	}
};
/**
* Consume a fixed number of bytes from the stream and return a string with a specified encoding.
* Supports all encodings supported by TextDecoder, plus 'windows-1252'.
*/
var StringType = class {
	constructor(len, encoding) {
		this.len = len;
		this.encoding = encoding;
	}
	get(data, offset = 0) {
		return textDecode(data.subarray(offset, offset + this.len), this.encoding);
	}
};
/**
* ANSI Latin 1 String using Windows-1252 (Code Page 1252)
* Windows-1252 is a superset of ISO 8859-1 / Latin-1.
*/
var AnsiStringType = class extends StringType {
	constructor(len) {
		super(len, "windows-1252");
	}
};
//#endregion
//#region node_modules/music-metadata/lib/ParseError.js
const makeParseError = (name) => {
	return class ParseError extends Error {
		constructor(message) {
			super(message);
			this.name = name;
		}
	};
};
var CouldNotDetermineFileTypeError = class extends makeParseError("CouldNotDetermineFileTypeError") {};
var UnsupportedFileTypeError = class extends makeParseError("UnsupportedFileTypeError") {};
var UnexpectedFileContentError = class extends makeParseError("UnexpectedFileContentError") {
	constructor(fileType, message) {
		super(message);
		this.fileType = fileType;
	}
	toString() {
		return `${this.name} (FileType: ${this.fileType}): ${this.message}`;
	}
};
var FieldDecodingError = class extends makeParseError("FieldDecodingError") {};
var InternalParserError = class extends makeParseError("InternalParserError") {};
const makeUnexpectedFileContentError = (fileType) => {
	return class extends UnexpectedFileContentError {
		constructor(message) {
			super(fileType, message);
		}
	};
};
//#endregion
//#region node_modules/music-metadata/lib/common/BasicParser.js
var BasicParser = class {
	/**
	* Initialize parser with output (metadata), input (tokenizer) & parsing options (options).
	* @param {INativeMetadataCollector} metadata Output
	* @param {ITokenizer} tokenizer Input
	* @param {IOptions} options Parsing options
	*/
	constructor(metadata, tokenizer, options) {
		this.metadata = metadata;
		this.tokenizer = tokenizer;
		this.options = options;
	}
};
//#endregion
export { textEncode as A, UINT32_LE as C, Uint8ArrayType as D, UINT8 as E, lib_exports as O, UINT32_BE as S, UINT64_LE as T, StringType as _, UnsupportedFileTypeError as a, UINT24_BE as b, Float32_BE as c, INT24_BE as d, INT32_BE as f, INT8 as g, INT64_LE as h, InternalParserError as i, textDecode as k, Float64_BE as l, INT64_BE as m, CouldNotDetermineFileTypeError as n, makeParseError as o, INT32_LE as p, FieldDecodingError as r, makeUnexpectedFileContentError as s, BasicParser as t, INT16_BE as u, UINT16_BE as v, UINT64_BE as w, UINT24_LE as x, UINT16_LE as y };
