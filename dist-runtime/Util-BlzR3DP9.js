import { _ as StringType, r as FieldDecodingError } from "./BasicParser-8KWEbE2n.js";
//#region node_modules/.pnpm/uint8array-extras@1.5.0/node_modules/uint8array-extras/index.js
const objectToString = Object.prototype.toString;
const uint8ArrayStringified = "[object Uint8Array]";
function isType(value, typeConstructor, typeStringified) {
	if (!value) return false;
	if (value.constructor === typeConstructor) return true;
	return objectToString.call(value) === typeStringified;
}
function isUint8Array(value) {
	return isType(value, Uint8Array, uint8ArrayStringified);
}
function assertUint8Array(value) {
	if (!isUint8Array(value)) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof value}\``);
}
new globalThis.TextDecoder("utf8");
new globalThis.TextEncoder();
const byteToHexLookupTable = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, "0"));
function uint8ArrayToHex(array) {
	assertUint8Array(array);
	let hexString = "";
	for (let index = 0; index < array.length; index++) hexString += byteToHexLookupTable[array[index]];
	return hexString;
}
/**
@param {DataView} view
@returns {number}
*/
function getUintBE(view) {
	const { byteLength } = view;
	if (byteLength === 6) return view.getUint16(0) * 2 ** 32 + view.getUint32(2);
	if (byteLength === 5) return view.getUint8(0) * 2 ** 32 + view.getUint32(1);
	if (byteLength === 4) return view.getUint32(0);
	if (byteLength === 3) return view.getUint8(0) * 2 ** 16 + view.getUint16(1);
	if (byteLength === 2) return view.getUint16(0);
	if (byteLength === 1) return view.getUint8(0);
}
//#endregion
//#region node_modules/.pnpm/music-metadata@11.12.1/node_modules/music-metadata/lib/common/Util.js
function getBit(buf, off, bit) {
	return (buf[off] & 1 << bit) !== 0;
}
/**
* Find delimiting zero in uint8Array
* @param uint8Array Uint8Array to find the zero delimiter in
* @param encoding The string encoding used
* @return position in uint8Array where zero found, or uint8Array.length if not found
*/
function findZero(uint8Array, encoding) {
	const len = uint8Array.length;
	if (encoding === "utf-16le") {
		for (let i = 0; i + 1 < len; i += 2) if (uint8Array[i] === 0 && uint8Array[i + 1] === 0) return i;
		return len;
	}
	for (let i = 0; i < len; i++) if (uint8Array[i] === 0) return i;
	return len;
}
function trimRightNull(x) {
	const pos0 = x.indexOf("\0");
	return pos0 === -1 ? x : x.substring(0, pos0);
}
function swapBytes(uint8Array) {
	const l = uint8Array.length;
	if ((l & 1) !== 0) throw new FieldDecodingError("Buffer length must be even");
	for (let i = 0; i < l; i += 2) {
		const a = uint8Array[i];
		uint8Array[i] = uint8Array[i + 1];
		uint8Array[i + 1] = a;
	}
	return uint8Array;
}
/**
* Decode string
*/
function decodeString(uint8Array, encoding) {
	if (uint8Array[0] === 255 && uint8Array[1] === 254) return decodeString(uint8Array.subarray(2), encoding);
	if (encoding === "utf-16le" && uint8Array[0] === 254 && uint8Array[1] === 255) {
		if ((uint8Array.length & 1) !== 0) throw new FieldDecodingError("Expected even number of octets for 16-bit unicode string");
		return decodeString(swapBytes(uint8Array), encoding);
	}
	return new StringType(uint8Array.length, encoding).get(uint8Array, 0);
}
function stripNulls(str) {
	str = str.replace(/^\x00+/g, "");
	str = str.replace(/\x00+$/g, "");
	return str;
}
/**
* Read bit-aligned number start from buffer
* Total offset in bits = byteOffset * 8 + bitOffset
* @param source Byte buffer
* @param byteOffset Starting offset in bytes
* @param bitOffset Starting offset in bits: 0 = lsb
* @param len Length of number in bits
* @return Decoded bit aligned number
*/
function getBitAllignedNumber(source, byteOffset, bitOffset, len) {
	const byteOff = byteOffset + ~~(bitOffset / 8);
	const bitOff = bitOffset % 8;
	let value = source[byteOff];
	value &= 255 >> bitOff;
	const bitsRead = 8 - bitOff;
	const bitsLeft = len - bitsRead;
	if (bitsLeft < 0) value >>= 8 - bitOff - len;
	else if (bitsLeft > 0) {
		value <<= bitsLeft;
		value |= getBitAllignedNumber(source, byteOffset, bitOffset + bitsRead, bitsLeft);
	}
	return value;
}
/**
* Read bit-aligned number start from buffer
* Total offset in bits = byteOffset * 8 + bitOffset
* @param source Byte Uint8Array
* @param byteOffset Starting offset in bytes
* @param bitOffset Starting offset in bits: 0 = most significant bit, 7 is the least significant bit
* @return True if bit is set
*/
function isBitSet(source, byteOffset, bitOffset) {
	return getBitAllignedNumber(source, byteOffset, bitOffset, 1) === 1;
}
function a2hex(str) {
	const arr = [];
	for (let i = 0, l = str.length; i < l; i++) {
		const hex = Number(str.charCodeAt(i)).toString(16);
		arr.push(hex.length === 1 ? `0${hex}` : hex);
	}
	return arr.join(" ");
}
/**
* Convert power ratio to DB
* ratio: [0..1]
*/
function ratioToDb(ratio) {
	return 10 * Math.log10(ratio);
}
/**
* Convert dB to ratio
* db Decibels
*/
function dbToRatio(dB) {
	return 10 ** (dB / 10);
}
/**
* Convert replay gain to ratio and Decibel
* @param value string holding a ratio like '0.034' or '-7.54 dB'
*/
function toRatio(value) {
	const ps = value.split(" ").map((p) => p.trim().toLowerCase());
	if (ps.length >= 1) {
		const v = Number.parseFloat(ps[0]);
		return ps.length === 2 && ps[1] === "db" ? {
			dB: v,
			ratio: dbToRatio(v)
		} : {
			dB: ratioToDb(v),
			ratio: v
		};
	}
}
/**
* Decode a big-endian unsigned integer from a Uint8Array.
* Supports dynamic length (1–8 bytes).
*/
function decodeUintBE(uint8Array) {
	if (uint8Array.length === 0) throw new Error("decodeUintBE: empty Uint8Array");
	return getUintBE(new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength));
}
//#endregion
export { getBit as a, stripNulls as c, uint8ArrayToHex as d, findZero as i, toRatio as l, decodeString as n, getBitAllignedNumber as o, decodeUintBE as r, isBitSet as s, a2hex as t, trimRightNull as u };
