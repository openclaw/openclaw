import { g as DEFAULT_ACCOUNT_ID, s as init_session_key, v as normalizeAccountId$1, y as normalizeOptionalAccountId } from "./session-key-BSZsryCD.js";
import { Wn as formatPairingApproveHint, Yn as AllowFromListSchema, Zn as buildChannelConfigSchema, fr as MarkdownConfigSchema, rr as DmPolicySchema } from "./resolve-route-CQsiaDZO.js";
import { Bu as setTopLevelChannelDmPolicyWithAllowFrom, Fm as mapAllowFromEntries, Hu as splitSetupEntries, Ou as mergeAllowFromEntries, Tu as formatDocsLink, Xd as createDefaultChannelRuntimeState, Yd as collectStatusIssuesFromLastError, ju as parseSetupEntriesWithParser, y as createPluginRuntimeStore, zu as setTopLevelChannelAllowFrom } from "./auth-profiles-B70DPAVa.js";
import { r as buildTrafficStatusSummary, t as buildPassiveChannelStatusSummary } from "./channel-status-summary-DPOZ4DXQ.js";
import path from "node:path";
import { z } from "zod";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs/promises";
//#region extensions/nostr/src/default-relays.ts
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/utils.js
/**
* Utilities for hex, bytes, CSPRNG.
* @module
*/
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes$2(a) {
	return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
/** Asserts something is positive integer. */
function anumber$2(n, title = "") {
	if (!Number.isSafeInteger(n) || n < 0) {
		const prefix = title && `"${title}" `;
		throw new Error(`${prefix}expected integer >= 0, got ${n}`);
	}
}
/** Asserts something is Uint8Array. */
function abytes$2(value, length, title = "") {
	const bytes = isBytes$2(value);
	const len = value?.length;
	const needsLen = length !== void 0;
	if (!bytes || needsLen && len !== length) {
		const prefix = title && `"${title}" `;
		const ofLen = needsLen ? ` of length ${length}` : "";
		const got = bytes ? `length=${len}` : `type=${typeof value}`;
		throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
	}
	return value;
}
/** Asserts something is hash */
function ahash(h) {
	if (typeof h !== "function" || typeof h.create !== "function") throw new Error("Hash must wrapped by utils.createHasher");
	anumber$2(h.outputLen);
	anumber$2(h.blockLen);
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists$1(instance, checkFinished = true) {
	if (instance.destroyed) throw new Error("Hash instance has been destroyed");
	if (checkFinished && instance.finished) throw new Error("Hash#digest() has already been called");
}
/** Asserts output is properly-sized byte array */
function aoutput$1(out, instance) {
	abytes$2(out, void 0, "digestInto() output");
	const min = instance.outputLen;
	if (out.length < min) throw new Error("\"digestInto() output\" expected to be of length >=" + min);
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean$1(...arrays) {
	for (let i = 0; i < arrays.length; i++) arrays[i].fill(0);
}
/** Create DataView of an array for easy byte-level manipulation. */
function createView$1(arr) {
	return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** The rotate right (circular right shift) operation for uint32 */
function rotr(word, shift) {
	return word << 32 - shift | word >>> shift;
}
new Uint8Array(new Uint32Array([287454020]).buffer)[0];
const hasHexBuiltin$2 = typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function";
const hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
/**
* Convert byte array to hex string. Uses built-in function, when available.
* @example bytesToHex(Uint8Array.from([0xca, 0xfe, 0x01, 0x23])) // 'cafe0123'
*/
function bytesToHex(bytes) {
	abytes$2(bytes);
	if (hasHexBuiltin$2) return bytes.toHex();
	let hex = "";
	for (let i = 0; i < bytes.length; i++) hex += hexes[bytes[i]];
	return hex;
}
const asciis = {
	_0: 48,
	_9: 57,
	A: 65,
	F: 70,
	a: 97,
	f: 102
};
function asciiToBase16(ch) {
	if (ch >= asciis._0 && ch <= asciis._9) return ch - asciis._0;
	if (ch >= asciis.A && ch <= asciis.F) return ch - (asciis.A - 10);
	if (ch >= asciis.a && ch <= asciis.f) return ch - (asciis.a - 10);
}
/**
* Convert hex string to byte array. Uses built-in function, when available.
* @example hexToBytes('cafe0123') // Uint8Array.from([0xca, 0xfe, 0x01, 0x23])
*/
function hexToBytes(hex) {
	if (typeof hex !== "string") throw new Error("hex string expected, got " + typeof hex);
	if (hasHexBuiltin$2) return Uint8Array.fromHex(hex);
	const hl = hex.length;
	const al = hl / 2;
	if (hl % 2) throw new Error("hex string expected, got unpadded hex of length " + hl);
	const array = new Uint8Array(al);
	for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
		const n1 = asciiToBase16(hex.charCodeAt(hi));
		const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
		if (n1 === void 0 || n2 === void 0) {
			const char = hex[hi] + hex[hi + 1];
			throw new Error("hex string expected, got non-hex character \"" + char + "\" at index " + hi);
		}
		array[ai] = n1 * 16 + n2;
	}
	return array;
}
/** Copies several Uint8Arrays into one. */
function concatBytes(...arrays) {
	let sum = 0;
	for (let i = 0; i < arrays.length; i++) {
		const a = arrays[i];
		abytes$2(a);
		sum += a.length;
	}
	const res = new Uint8Array(sum);
	for (let i = 0, pad = 0; i < arrays.length; i++) {
		const a = arrays[i];
		res.set(a, pad);
		pad += a.length;
	}
	return res;
}
/** Creates function with outputLen, blockLen, create properties from a class constructor. */
function createHasher$1(hashCons, info = {}) {
	const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
	const tmp = hashCons(void 0);
	hashC.outputLen = tmp.outputLen;
	hashC.blockLen = tmp.blockLen;
	hashC.create = (opts) => hashCons(opts);
	Object.assign(hashC, info);
	return Object.freeze(hashC);
}
/** Cryptographically secure PRNG. Uses internal OS-level `crypto.getRandomValues`. */
function randomBytes$1(bytesLength = 32) {
	const cr = typeof globalThis === "object" ? globalThis.crypto : null;
	if (typeof cr?.getRandomValues !== "function") throw new Error("crypto.getRandomValues must be defined");
	return cr.getRandomValues(new Uint8Array(bytesLength));
}
/** Creates OID opts for NIST hashes, with prefix 06 09 60 86 48 01 65 03 04 02. */
const oidNist = (suffix) => ({ oid: Uint8Array.from([
	6,
	9,
	96,
	134,
	72,
	1,
	101,
	3,
	4,
	2,
	suffix
]) });
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/_md.js
/**
* Internal Merkle-Damgard hash utils.
* @module
*/
/** Choice: a ? b : c */
function Chi(a, b, c) {
	return a & b ^ ~a & c;
}
/** Majority function, true if any two inputs is true. */
function Maj(a, b, c) {
	return a & b ^ a & c ^ b & c;
}
/**
* Merkle-Damgard hash construction base class.
* Could be used to create MD5, RIPEMD, SHA1, SHA2.
*/
var HashMD = class {
	blockLen;
	outputLen;
	padOffset;
	isLE;
	buffer;
	view;
	finished = false;
	length = 0;
	pos = 0;
	destroyed = false;
	constructor(blockLen, outputLen, padOffset, isLE) {
		this.blockLen = blockLen;
		this.outputLen = outputLen;
		this.padOffset = padOffset;
		this.isLE = isLE;
		this.buffer = new Uint8Array(blockLen);
		this.view = createView$1(this.buffer);
	}
	update(data) {
		aexists$1(this);
		abytes$2(data);
		const { view, buffer, blockLen } = this;
		const len = data.length;
		for (let pos = 0; pos < len;) {
			const take = Math.min(blockLen - this.pos, len - pos);
			if (take === blockLen) {
				const dataView = createView$1(data);
				for (; blockLen <= len - pos; pos += blockLen) this.process(dataView, pos);
				continue;
			}
			buffer.set(data.subarray(pos, pos + take), this.pos);
			this.pos += take;
			pos += take;
			if (this.pos === blockLen) {
				this.process(view, 0);
				this.pos = 0;
			}
		}
		this.length += data.length;
		this.roundClean();
		return this;
	}
	digestInto(out) {
		aexists$1(this);
		aoutput$1(out, this);
		this.finished = true;
		const { buffer, view, blockLen, isLE } = this;
		let { pos } = this;
		buffer[pos++] = 128;
		clean$1(this.buffer.subarray(pos));
		if (this.padOffset > blockLen - pos) {
			this.process(view, 0);
			pos = 0;
		}
		for (let i = pos; i < blockLen; i++) buffer[i] = 0;
		view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE);
		this.process(view, 0);
		const oview = createView$1(out);
		const len = this.outputLen;
		if (len % 4) throw new Error("_sha2: outputLen must be aligned to 32bit");
		const outLen = len / 4;
		const state = this.get();
		if (outLen > state.length) throw new Error("_sha2: outputLen bigger than state");
		for (let i = 0; i < outLen; i++) oview.setUint32(4 * i, state[i], isLE);
	}
	digest() {
		const { buffer, outputLen } = this;
		this.digestInto(buffer);
		const res = buffer.slice(0, outputLen);
		this.destroy();
		return res;
	}
	_cloneInto(to) {
		to ||= new this.constructor();
		to.set(...this.get());
		const { blockLen, buffer, length, finished, destroyed, pos } = this;
		to.destroyed = destroyed;
		to.finished = finished;
		to.length = length;
		to.pos = pos;
		if (length % blockLen) to.buffer.set(buffer);
		return to;
	}
	clone() {
		return this._cloneInto();
	}
};
/**
* Initial SHA-2 state: fractional parts of square roots of first 16 primes 2..53.
* Check out `test/misc/sha2-gen-iv.js` for recomputation guide.
*/
/** Initial SHA256 state. Bits 0..32 of frac part of sqrt of primes 2..19 */
const SHA256_IV = /* @__PURE__ */ Uint32Array.from([
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
]);
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/_u64.js
/**
* Internal helpers for u64. BigUint64Array is too slow as per 2025, so we implement it using Uint32Array.
* @todo re-check https://issues.chromium.org/issues/42212588
* @module
*/
const U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
const _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
	if (le) return {
		h: Number(n & U32_MASK64),
		l: Number(n >> _32n & U32_MASK64)
	};
	return {
		h: Number(n >> _32n & U32_MASK64) | 0,
		l: Number(n & U32_MASK64) | 0
	};
}
function split(lst, le = false) {
	const len = lst.length;
	let Ah = new Uint32Array(len);
	let Al = new Uint32Array(len);
	for (let i = 0; i < len; i++) {
		const { h, l } = fromBig(lst[i], le);
		[Ah[i], Al[i]] = [h, l];
	}
	return [Ah, Al];
}
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha2.js
/**
* SHA2 hash function. A.k.a. sha256, sha384, sha512, sha512_224, sha512_256.
* SHA256 is the fastest hash implementable in JS, even faster than Blake3.
* Check out [RFC 4634](https://www.rfc-editor.org/rfc/rfc4634) and
* [FIPS 180-4](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf).
* @module
*/
/**
* Round constants:
* First 32 bits of fractional parts of the cube roots of the first 64 primes 2..311)
*/
const SHA256_K = /* @__PURE__ */ Uint32Array.from([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]);
/** Reusable temporary buffer. "W" comes straight from spec. */
const SHA256_W = /* @__PURE__ */ new Uint32Array(64);
/** Internal 32-byte base SHA2 hash class. */
var SHA2_32B = class extends HashMD {
	constructor(outputLen) {
		super(64, outputLen, 8, false);
	}
	get() {
		const { A, B, C, D, E, F, G, H } = this;
		return [
			A,
			B,
			C,
			D,
			E,
			F,
			G,
			H
		];
	}
	set(A, B, C, D, E, F, G, H) {
		this.A = A | 0;
		this.B = B | 0;
		this.C = C | 0;
		this.D = D | 0;
		this.E = E | 0;
		this.F = F | 0;
		this.G = G | 0;
		this.H = H | 0;
	}
	process(view, offset) {
		for (let i = 0; i < 16; i++, offset += 4) SHA256_W[i] = view.getUint32(offset, false);
		for (let i = 16; i < 64; i++) {
			const W15 = SHA256_W[i - 15];
			const W2 = SHA256_W[i - 2];
			const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
			SHA256_W[i] = (rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10) + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
		}
		let { A, B, C, D, E, F, G, H } = this;
		for (let i = 0; i < 64; i++) {
			const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
			const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
			const T2 = (rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + Maj(A, B, C) | 0;
			H = G;
			G = F;
			F = E;
			E = D + T1 | 0;
			D = C;
			C = B;
			B = A;
			A = T1 + T2 | 0;
		}
		A = A + this.A | 0;
		B = B + this.B | 0;
		C = C + this.C | 0;
		D = D + this.D | 0;
		E = E + this.E | 0;
		F = F + this.F | 0;
		G = G + this.G | 0;
		H = H + this.H | 0;
		this.set(A, B, C, D, E, F, G, H);
	}
	roundClean() {
		clean$1(SHA256_W);
	}
	destroy() {
		this.set(0, 0, 0, 0, 0, 0, 0, 0);
		clean$1(this.buffer);
	}
};
/** Internal SHA2-256 hash class. */
var _SHA256 = class extends SHA2_32B {
	A = SHA256_IV[0] | 0;
	B = SHA256_IV[1] | 0;
	C = SHA256_IV[2] | 0;
	D = SHA256_IV[3] | 0;
	E = SHA256_IV[4] | 0;
	F = SHA256_IV[5] | 0;
	G = SHA256_IV[6] | 0;
	H = SHA256_IV[7] | 0;
	constructor() {
		super(32);
	}
};
const K512 = split([
	"0x428a2f98d728ae22",
	"0x7137449123ef65cd",
	"0xb5c0fbcfec4d3b2f",
	"0xe9b5dba58189dbbc",
	"0x3956c25bf348b538",
	"0x59f111f1b605d019",
	"0x923f82a4af194f9b",
	"0xab1c5ed5da6d8118",
	"0xd807aa98a3030242",
	"0x12835b0145706fbe",
	"0x243185be4ee4b28c",
	"0x550c7dc3d5ffb4e2",
	"0x72be5d74f27b896f",
	"0x80deb1fe3b1696b1",
	"0x9bdc06a725c71235",
	"0xc19bf174cf692694",
	"0xe49b69c19ef14ad2",
	"0xefbe4786384f25e3",
	"0x0fc19dc68b8cd5b5",
	"0x240ca1cc77ac9c65",
	"0x2de92c6f592b0275",
	"0x4a7484aa6ea6e483",
	"0x5cb0a9dcbd41fbd4",
	"0x76f988da831153b5",
	"0x983e5152ee66dfab",
	"0xa831c66d2db43210",
	"0xb00327c898fb213f",
	"0xbf597fc7beef0ee4",
	"0xc6e00bf33da88fc2",
	"0xd5a79147930aa725",
	"0x06ca6351e003826f",
	"0x142929670a0e6e70",
	"0x27b70a8546d22ffc",
	"0x2e1b21385c26c926",
	"0x4d2c6dfc5ac42aed",
	"0x53380d139d95b3df",
	"0x650a73548baf63de",
	"0x766a0abb3c77b2a8",
	"0x81c2c92e47edaee6",
	"0x92722c851482353b",
	"0xa2bfe8a14cf10364",
	"0xa81a664bbc423001",
	"0xc24b8b70d0f89791",
	"0xc76c51a30654be30",
	"0xd192e819d6ef5218",
	"0xd69906245565a910",
	"0xf40e35855771202a",
	"0x106aa07032bbd1b8",
	"0x19a4c116b8d2d0c8",
	"0x1e376c085141ab53",
	"0x2748774cdf8eeb99",
	"0x34b0bcb5e19b48a8",
	"0x391c0cb3c5c95a63",
	"0x4ed8aa4ae3418acb",
	"0x5b9cca4f7763e373",
	"0x682e6ff3d6b2b8a3",
	"0x748f82ee5defb2fc",
	"0x78a5636f43172f60",
	"0x84c87814a1f0ab72",
	"0x8cc702081a6439ec",
	"0x90befffa23631e28",
	"0xa4506cebde82bde9",
	"0xbef9a3f7b2c67915",
	"0xc67178f2e372532b",
	"0xca273eceea26619c",
	"0xd186b8c721c0c207",
	"0xeada7dd6cde0eb1e",
	"0xf57d4f7fee6ed178",
	"0x06f067aa72176fba",
	"0x0a637dc5a2c898a6",
	"0x113f9804bef90dae",
	"0x1b710b35131c471b",
	"0x28db77f523047d84",
	"0x32caab7b40c72493",
	"0x3c9ebe0a15c9bebc",
	"0x431d67c49c100d4c",
	"0x4cc5d4becb3e42b6",
	"0x597f299cfc657e2a",
	"0x5fcb6fab3ad6faec",
	"0x6c44198c4a475817"
].map((n) => BigInt(n)));
K512[0];
K512[1];
/**
* SHA2-256 hash function from RFC 4634. In JS it's the fastest: even faster than Blake3. Some info:
*
* - Trying 2^128 hashes would get 50% chance of collision, using birthday attack.
* - BTC network is doing 2^70 hashes/sec (2^95 hashes/year) as per 2025.
* - Each sha256 hash is executing 2^18 bit operations.
* - Good 2024 ASICs can do 200Th/sec with 3500 watts of power, corresponding to 2^36 hashes/joule.
*/
const sha256 = /* @__PURE__ */ createHasher$1(() => new _SHA256(), /* @__PURE__ */ oidNist(1));
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/utils.js
/**
* Hex, bytes and number utilities.
* @module
*/
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const _0n$4 = /* @__PURE__ */ BigInt(0);
const _1n$3 = /* @__PURE__ */ BigInt(1);
function abool$1(value, title = "") {
	if (typeof value !== "boolean") {
		const prefix = title && `"${title}" `;
		throw new Error(prefix + "expected boolean, got type=" + typeof value);
	}
	return value;
}
function abignumber(n) {
	if (typeof n === "bigint") {
		if (!isPosBig(n)) throw new Error("positive bigint expected, got " + n);
	} else anumber$2(n);
	return n;
}
function asafenumber(value, title = "") {
	if (!Number.isSafeInteger(value)) {
		const prefix = title && `"${title}" `;
		throw new Error(prefix + "expected safe integer, got type=" + typeof value);
	}
}
function numberToHexUnpadded(num) {
	const hex = abignumber(num).toString(16);
	return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
	if (typeof hex !== "string") throw new Error("hex string expected, got " + typeof hex);
	return hex === "" ? _0n$4 : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
	return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
	return hexToNumber(bytesToHex(copyBytes$1(abytes$2(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
	anumber$2(len);
	n = abignumber(n);
	const res = hexToBytes(n.toString(16).padStart(len * 2, "0"));
	if (res.length !== len) throw new Error("number too large");
	return res;
}
function numberToBytesLE(n, len) {
	return numberToBytesBE(n, len).reverse();
}
/**
* Copies Uint8Array. We can't use u8a.slice(), because u8a can be Buffer,
* and Buffer#slice creates mutable copy. Never use Buffers!
*/
function copyBytes$1(bytes) {
	return Uint8Array.from(bytes);
}
/**
* Decodes 7-bit ASCII string to Uint8Array, throws on non-ascii symbols
* Should be safe to use for things expected to be ASCII.
* Returns exact same result as `TextEncoder` for ASCII or throws.
*/
function asciiToBytes(ascii) {
	return Uint8Array.from(ascii, (c, i) => {
		const charCode = c.charCodeAt(0);
		if (c.length !== 1 || charCode > 127) throw new Error(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
		return charCode;
	});
}
const isPosBig = (n) => typeof n === "bigint" && _0n$4 <= n;
function inRange(n, min, max) {
	return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
/**
* Asserts min <= n < max. NOTE: It's < max and not <= max.
* @example
* aInRange('x', x, 1n, 256n); // would assume x is in (1n..255n)
*/
function aInRange(title, n, min, max) {
	if (!inRange(n, min, max)) throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
/**
* Calculates amount of bits in a bigint.
* Same as `n.toString(2).length`
* TODO: merge with nLength in modular
*/
function bitLen(n) {
	let len;
	for (len = 0; n > _0n$4; n >>= _1n$3, len += 1);
	return len;
}
/**
* Calculate mask for N bits. Not using ** operator with bigints because of old engines.
* Same as BigInt(`0b${Array(i).fill('1').join('')}`)
*/
const bitMask = (n) => (_1n$3 << BigInt(n)) - _1n$3;
/**
* Minimal HMAC-DRBG from NIST 800-90 for RFC6979 sigs.
* @returns function that will call DRBG until 2nd arg returns something meaningful
* @example
*   const drbg = createHmacDRBG<Key>(32, 32, hmac);
*   drbg(seed, bytesToKey); // bytesToKey must return Key or undefined
*/
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
	anumber$2(hashLen, "hashLen");
	anumber$2(qByteLen, "qByteLen");
	if (typeof hmacFn !== "function") throw new Error("hmacFn must be a function");
	const u8n = (len) => new Uint8Array(len);
	const NULL = Uint8Array.of();
	const byte0 = Uint8Array.of(0);
	const byte1 = Uint8Array.of(1);
	const _maxDrbgIters = 1e3;
	let v = u8n(hashLen);
	let k = u8n(hashLen);
	let i = 0;
	const reset = () => {
		v.fill(1);
		k.fill(0);
		i = 0;
	};
	const h = (...msgs) => hmacFn(k, concatBytes(v, ...msgs));
	const reseed = (seed = NULL) => {
		k = h(byte0, seed);
		v = h();
		if (seed.length === 0) return;
		k = h(byte1, seed);
		v = h();
	};
	const gen = () => {
		if (i++ >= _maxDrbgIters) throw new Error("drbg: tried max amount of iterations");
		let len = 0;
		const out = [];
		while (len < qByteLen) {
			v = h();
			const sl = v.slice();
			out.push(sl);
			len += v.length;
		}
		return concatBytes(...out);
	};
	const genUntil = (seed, pred) => {
		reset();
		reseed(seed);
		let res = void 0;
		while (!(res = pred(gen()))) reseed();
		reset();
		return res;
	};
	return genUntil;
}
function validateObject(object, fields = {}, optFields = {}) {
	if (!object || typeof object !== "object") throw new Error("expected valid options object");
	function checkField(fieldName, expectedType, isOpt) {
		const val = object[fieldName];
		if (isOpt && val === void 0) return;
		const current = typeof val;
		if (current !== expectedType || val === null) throw new Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
	}
	const iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
	iter(fields, false);
	iter(optFields, true);
}
/**
* Memoizes (caches) computation result.
* Uses WeakMap: the value is going auto-cleaned by GC after last reference is removed.
*/
function memoized(fn) {
	const map = /* @__PURE__ */ new WeakMap();
	return (arg, ...args) => {
		const val = map.get(arg);
		if (val !== void 0) return val;
		const computed = fn(arg, ...args);
		map.set(arg, computed);
		return computed;
	};
}
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/modular.js
/**
* Utils for modular division and fields.
* Field over 11 is a finite (Galois) field is integer number operations `mod 11`.
* There is no division: it is replaced by modular multiplicative inverse.
* @module
*/
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const _0n$3 = /* @__PURE__ */ BigInt(0), _1n$2 = /* @__PURE__ */ BigInt(1), _2n$2 = /* @__PURE__ */ BigInt(2);
const _3n$1 = /* @__PURE__ */ BigInt(3), _4n$1 = /* @__PURE__ */ BigInt(4), _5n = /* @__PURE__ */ BigInt(5);
const _7n = /* @__PURE__ */ BigInt(7), _8n = /* @__PURE__ */ BigInt(8), _9n = /* @__PURE__ */ BigInt(9);
const _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
	const result = a % b;
	return result >= _0n$3 ? result : b + result;
}
/** Does `x^(2^power)` mod p. `pow2(30, 4)` == `30^(2^4)` */
function pow2(x, power, modulo) {
	let res = x;
	while (power-- > _0n$3) {
		res *= res;
		res %= modulo;
	}
	return res;
}
/**
* Inverses number over modulo.
* Implemented using [Euclidean GCD](https://brilliant.org/wiki/extended-euclidean-algorithm/).
*/
function invert(number, modulo) {
	if (number === _0n$3) throw new Error("invert: expected non-zero number");
	if (modulo <= _0n$3) throw new Error("invert: expected positive modulus, got " + modulo);
	let a = mod(number, modulo);
	let b = modulo;
	let x = _0n$3, y = _1n$2, u = _1n$2, v = _0n$3;
	while (a !== _0n$3) {
		const q = b / a;
		const r = b % a;
		const m = x - u * q;
		const n = y - v * q;
		b = a, a = r, x = u, y = v, u = m, v = n;
	}
	if (b !== _1n$2) throw new Error("invert: does not exist");
	return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
	if (!Fp.eql(Fp.sqr(root), n)) throw new Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
	const p1div4 = (Fp.ORDER + _1n$2) / _4n$1;
	const root = Fp.pow(n, p1div4);
	assertIsSquare(Fp, root, n);
	return root;
}
function sqrt5mod8(Fp, n) {
	const p5div8 = (Fp.ORDER - _5n) / _8n;
	const n2 = Fp.mul(n, _2n$2);
	const v = Fp.pow(n2, p5div8);
	const nv = Fp.mul(n, v);
	const i = Fp.mul(Fp.mul(nv, _2n$2), v);
	const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
	assertIsSquare(Fp, root, n);
	return root;
}
function sqrt9mod16(P) {
	const Fp_ = Field(P);
	const tn = tonelliShanks(P);
	const c1 = tn(Fp_, Fp_.neg(Fp_.ONE));
	const c2 = tn(Fp_, c1);
	const c3 = tn(Fp_, Fp_.neg(c1));
	const c4 = (P + _7n) / _16n;
	return (Fp, n) => {
		let tv1 = Fp.pow(n, c4);
		let tv2 = Fp.mul(tv1, c1);
		const tv3 = Fp.mul(tv1, c2);
		const tv4 = Fp.mul(tv1, c3);
		const e1 = Fp.eql(Fp.sqr(tv2), n);
		const e2 = Fp.eql(Fp.sqr(tv3), n);
		tv1 = Fp.cmov(tv1, tv2, e1);
		tv2 = Fp.cmov(tv4, tv3, e2);
		const e3 = Fp.eql(Fp.sqr(tv2), n);
		const root = Fp.cmov(tv1, tv2, e3);
		assertIsSquare(Fp, root, n);
		return root;
	};
}
/**
* Tonelli-Shanks square root search algorithm.
* 1. https://eprint.iacr.org/2012/685.pdf (page 12)
* 2. Square Roots from 1; 24, 51, 10 to Dan Shanks
* @param P field order
* @returns function that takes field Fp (created from P) and number n
*/
function tonelliShanks(P) {
	if (P < _3n$1) throw new Error("sqrt is not defined for small field");
	let Q = P - _1n$2;
	let S = 0;
	while (Q % _2n$2 === _0n$3) {
		Q /= _2n$2;
		S++;
	}
	let Z = _2n$2;
	const _Fp = Field(P);
	while (FpLegendre(_Fp, Z) === 1) if (Z++ > 1e3) throw new Error("Cannot find square root: probably non-prime P");
	if (S === 1) return sqrt3mod4;
	let cc = _Fp.pow(Z, Q);
	const Q1div2 = (Q + _1n$2) / _2n$2;
	return function tonelliSlow(Fp, n) {
		if (Fp.is0(n)) return n;
		if (FpLegendre(Fp, n) !== 1) throw new Error("Cannot find square root");
		let M = S;
		let c = Fp.mul(Fp.ONE, cc);
		let t = Fp.pow(n, Q);
		let R = Fp.pow(n, Q1div2);
		while (!Fp.eql(t, Fp.ONE)) {
			if (Fp.is0(t)) return Fp.ZERO;
			let i = 1;
			let t_tmp = Fp.sqr(t);
			while (!Fp.eql(t_tmp, Fp.ONE)) {
				i++;
				t_tmp = Fp.sqr(t_tmp);
				if (i === M) throw new Error("Cannot find square root");
			}
			const exponent = _1n$2 << BigInt(M - i - 1);
			const b = Fp.pow(c, exponent);
			M = i;
			c = Fp.sqr(b);
			t = Fp.mul(t, c);
			R = Fp.mul(R, b);
		}
		return R;
	};
}
/**
* Square root for a finite field. Will try optimized versions first:
*
* 1. P ≡ 3 (mod 4)
* 2. P ≡ 5 (mod 8)
* 3. P ≡ 9 (mod 16)
* 4. Tonelli-Shanks algorithm
*
* Different algorithms can give different roots, it is up to user to decide which one they want.
* For example there is FpSqrtOdd/FpSqrtEven to choice root based on oddness (used for hash-to-curve).
*/
function FpSqrt(P) {
	if (P % _4n$1 === _3n$1) return sqrt3mod4;
	if (P % _8n === _5n) return sqrt5mod8;
	if (P % _16n === _9n) return sqrt9mod16(P);
	return tonelliShanks(P);
}
const FIELD_FIELDS = [
	"create",
	"isValid",
	"is0",
	"neg",
	"inv",
	"sqrt",
	"sqr",
	"eql",
	"add",
	"sub",
	"mul",
	"pow",
	"div",
	"addN",
	"subN",
	"mulN",
	"sqrN"
];
function validateField(field) {
	validateObject(field, FIELD_FIELDS.reduce((map, val) => {
		map[val] = "function";
		return map;
	}, {
		ORDER: "bigint",
		BYTES: "number",
		BITS: "number"
	}));
	return field;
}
/**
* Same as `pow` but for Fp: non-constant-time.
* Unsafe in some contexts: uses ladder, so can expose bigint bits.
*/
function FpPow(Fp, num, power) {
	if (power < _0n$3) throw new Error("invalid exponent, negatives unsupported");
	if (power === _0n$3) return Fp.ONE;
	if (power === _1n$2) return num;
	let p = Fp.ONE;
	let d = num;
	while (power > _0n$3) {
		if (power & _1n$2) p = Fp.mul(p, d);
		d = Fp.sqr(d);
		power >>= _1n$2;
	}
	return p;
}
/**
* Efficiently invert an array of Field elements.
* Exception-free. Will return `undefined` for 0 elements.
* @param passZero map 0 to 0 (instead of undefined)
*/
function FpInvertBatch(Fp, nums, passZero = false) {
	const inverted = new Array(nums.length).fill(passZero ? Fp.ZERO : void 0);
	const multipliedAcc = nums.reduce((acc, num, i) => {
		if (Fp.is0(num)) return acc;
		inverted[i] = acc;
		return Fp.mul(acc, num);
	}, Fp.ONE);
	const invertedAcc = Fp.inv(multipliedAcc);
	nums.reduceRight((acc, num, i) => {
		if (Fp.is0(num)) return acc;
		inverted[i] = Fp.mul(acc, inverted[i]);
		return Fp.mul(acc, num);
	}, invertedAcc);
	return inverted;
}
/**
* Legendre symbol.
* Legendre constant is used to calculate Legendre symbol (a | p)
* which denotes the value of a^((p-1)/2) (mod p).
*
* * (a | p) ≡ 1    if a is a square (mod p), quadratic residue
* * (a | p) ≡ -1   if a is not a square (mod p), quadratic non residue
* * (a | p) ≡ 0    if a ≡ 0 (mod p)
*/
function FpLegendre(Fp, n) {
	const p1mod2 = (Fp.ORDER - _1n$2) / _2n$2;
	const powered = Fp.pow(n, p1mod2);
	const yes = Fp.eql(powered, Fp.ONE);
	const zero = Fp.eql(powered, Fp.ZERO);
	const no = Fp.eql(powered, Fp.neg(Fp.ONE));
	if (!yes && !zero && !no) throw new Error("invalid Legendre symbol result");
	return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
	if (nBitLength !== void 0) anumber$2(nBitLength);
	const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
	return {
		nBitLength: _nBitLength,
		nByteLength: Math.ceil(_nBitLength / 8)
	};
}
var _Field = class {
	ORDER;
	BITS;
	BYTES;
	isLE;
	ZERO = _0n$3;
	ONE = _1n$2;
	_lengths;
	_sqrt;
	_mod;
	constructor(ORDER, opts = {}) {
		if (ORDER <= _0n$3) throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
		let _nbitLength = void 0;
		this.isLE = false;
		if (opts != null && typeof opts === "object") {
			if (typeof opts.BITS === "number") _nbitLength = opts.BITS;
			if (typeof opts.sqrt === "function") this.sqrt = opts.sqrt;
			if (typeof opts.isLE === "boolean") this.isLE = opts.isLE;
			if (opts.allowedLengths) this._lengths = opts.allowedLengths?.slice();
			if (typeof opts.modFromBytes === "boolean") this._mod = opts.modFromBytes;
		}
		const { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
		if (nByteLength > 2048) throw new Error("invalid field: expected ORDER of <= 2048 bytes");
		this.ORDER = ORDER;
		this.BITS = nBitLength;
		this.BYTES = nByteLength;
		this._sqrt = void 0;
		Object.preventExtensions(this);
	}
	create(num) {
		return mod(num, this.ORDER);
	}
	isValid(num) {
		if (typeof num !== "bigint") throw new Error("invalid field element: expected bigint, got " + typeof num);
		return _0n$3 <= num && num < this.ORDER;
	}
	is0(num) {
		return num === _0n$3;
	}
	isValidNot0(num) {
		return !this.is0(num) && this.isValid(num);
	}
	isOdd(num) {
		return (num & _1n$2) === _1n$2;
	}
	neg(num) {
		return mod(-num, this.ORDER);
	}
	eql(lhs, rhs) {
		return lhs === rhs;
	}
	sqr(num) {
		return mod(num * num, this.ORDER);
	}
	add(lhs, rhs) {
		return mod(lhs + rhs, this.ORDER);
	}
	sub(lhs, rhs) {
		return mod(lhs - rhs, this.ORDER);
	}
	mul(lhs, rhs) {
		return mod(lhs * rhs, this.ORDER);
	}
	pow(num, power) {
		return FpPow(this, num, power);
	}
	div(lhs, rhs) {
		return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
	}
	sqrN(num) {
		return num * num;
	}
	addN(lhs, rhs) {
		return lhs + rhs;
	}
	subN(lhs, rhs) {
		return lhs - rhs;
	}
	mulN(lhs, rhs) {
		return lhs * rhs;
	}
	inv(num) {
		return invert(num, this.ORDER);
	}
	sqrt(num) {
		if (!this._sqrt) this._sqrt = FpSqrt(this.ORDER);
		return this._sqrt(this, num);
	}
	toBytes(num) {
		return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
	}
	fromBytes(bytes, skipValidation = false) {
		abytes$2(bytes);
		const { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
		if (allowedLengths) {
			if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES) throw new Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
			const padded = new Uint8Array(BYTES);
			padded.set(bytes, isLE ? 0 : padded.length - bytes.length);
			bytes = padded;
		}
		if (bytes.length !== BYTES) throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
		let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
		if (modFromBytes) scalar = mod(scalar, ORDER);
		if (!skipValidation) {
			if (!this.isValid(scalar)) throw new Error("invalid field element: outside of range 0..ORDER");
		}
		return scalar;
	}
	invertBatch(lst) {
		return FpInvertBatch(this, lst);
	}
	cmov(a, b, condition) {
		return condition ? b : a;
	}
};
/**
* Creates a finite field. Major performance optimizations:
* * 1. Denormalized operations like mulN instead of mul.
* * 2. Identical object shape: never add or remove keys.
* * 3. `Object.freeze`.
* Fragile: always run a benchmark on a change.
* Security note: operations don't check 'isValid' for all elements for performance reasons,
* it is caller responsibility to check this.
* This is low-level code, please make sure you know what you're doing.
*
* Note about field properties:
* * CHARACTERISTIC p = prime number, number of elements in main subgroup.
* * ORDER q = similar to cofactor in curves, may be composite `q = p^m`.
*
* @param ORDER field order, probably prime, or could be composite
* @param bitLen how many bits the field consumes
* @param isLE (default: false) if encoding / decoding should be in little-endian
* @param redef optional faster redefinitions of sqrt and other methods
*/
function Field(ORDER, opts = {}) {
	return new _Field(ORDER, opts);
}
/**
* Returns total number of bytes consumed by the field element.
* For example, 32 bytes for usual 256-bit weierstrass curve.
* @param fieldOrder number of field elements, usually CURVE.n
* @returns byte length of field
*/
function getFieldBytesLength(fieldOrder) {
	if (typeof fieldOrder !== "bigint") throw new Error("field order must be bigint");
	const bitLength = fieldOrder.toString(2).length;
	return Math.ceil(bitLength / 8);
}
/**
* Returns minimal amount of bytes that can be safely reduced
* by field order.
* Should be 2^-128 for 128-bit curve such as P256.
* @param fieldOrder number of field elements, usually CURVE.n
* @returns byte length of target hash
*/
function getMinHashLength(fieldOrder) {
	const length = getFieldBytesLength(fieldOrder);
	return length + Math.ceil(length / 2);
}
/**
* "Constant-time" private key generation utility.
* Can take (n + n/2) or more bytes of uniform input e.g. from CSPRNG or KDF
* and convert them into private scalar, with the modulo bias being negligible.
* Needs at least 48 bytes of input for 32-byte private key.
* https://research.kudelskisecurity.com/2020/07/28/the-definitive-guide-to-modulo-bias-and-how-to-avoid-it/
* FIPS 186-5, A.2 https://csrc.nist.gov/publications/detail/fips/186/5/final
* RFC 9380, https://www.rfc-editor.org/rfc/rfc9380#section-5
* @param hash hash output from SHA3 or a similar function
* @param groupOrder size of subgroup - (e.g. secp256k1.Point.Fn.ORDER)
* @param isLE interpret hash bytes as LE num
* @returns valid private scalar
*/
function mapHashToField(key, fieldOrder, isLE = false) {
	abytes$2(key);
	const len = key.length;
	const fieldLen = getFieldBytesLength(fieldOrder);
	const minLen = getMinHashLength(fieldOrder);
	if (len < 16 || len < minLen || len > 1024) throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
	const reduced = mod(isLE ? bytesToNumberLE(key) : bytesToNumberBE(key), fieldOrder - _1n$2) + _1n$2;
	return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/curve.js
/**
* Methods for elliptic curve multiplication by scalars.
* Contains wNAF, pippenger.
* @module
*/
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const _0n$2 = /* @__PURE__ */ BigInt(0);
const _1n$1 = /* @__PURE__ */ BigInt(1);
function negateCt(condition, item) {
	const neg = item.negate();
	return condition ? neg : item;
}
/**
* Takes a bunch of Projective Points but executes only one
* inversion on all of them. Inversion is very slow operation,
* so this improves performance massively.
* Optimization: converts a list of projective points to a list of identical points with Z=1.
*/
function normalizeZ(c, points) {
	const invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
	return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
	if (!Number.isSafeInteger(W) || W <= 0 || W > bits) throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
	validateW(W, scalarBits);
	const windows = Math.ceil(scalarBits / W) + 1;
	const windowSize = 2 ** (W - 1);
	const maxNumber = 2 ** W;
	return {
		windows,
		windowSize,
		mask: bitMask(W),
		maxNumber,
		shiftBy: BigInt(W)
	};
}
function calcOffsets(n, window, wOpts) {
	const { windowSize, mask, maxNumber, shiftBy } = wOpts;
	let wbits = Number(n & mask);
	let nextN = n >> shiftBy;
	if (wbits > windowSize) {
		wbits -= maxNumber;
		nextN += _1n$1;
	}
	const offsetStart = window * windowSize;
	const offset = offsetStart + Math.abs(wbits) - 1;
	const isZero = wbits === 0;
	const isNeg = wbits < 0;
	const isNegF = window % 2 !== 0;
	return {
		nextN,
		offset,
		isZero,
		isNeg,
		isNegF,
		offsetF: offsetStart
	};
}
const pointPrecomputes = /* @__PURE__ */ new WeakMap();
const pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
	return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
	if (n !== _0n$2) throw new Error("invalid wNAF");
}
/**
* Elliptic curve multiplication of Point by scalar. Fragile.
* Table generation takes **30MB of ram and 10ms on high-end CPU**,
* but may take much longer on slow devices. Actual generation will happen on
* first call of `multiply()`. By default, `BASE` point is precomputed.
*
* Scalars should always be less than curve order: this should be checked inside of a curve itself.
* Creates precomputation tables for fast multiplication:
* - private scalar is split by fixed size windows of W bits
* - every window point is collected from window's table & added to accumulator
* - since windows are different, same point inside tables won't be accessed more than once per calc
* - each multiplication is 'Math.ceil(CURVE_ORDER / 𝑊) + 1' point additions (fixed for any scalar)
* - +1 window is neccessary for wNAF
* - wNAF reduces table size: 2x less memory + 2x faster generation, but 10% slower multiplication
*
* @todo Research returning 2d JS array of windows, instead of a single window.
* This would allow windows to be in different memory locations
*/
var wNAF = class {
	BASE;
	ZERO;
	Fn;
	bits;
	constructor(Point, bits) {
		this.BASE = Point.BASE;
		this.ZERO = Point.ZERO;
		this.Fn = Point.Fn;
		this.bits = bits;
	}
	_unsafeLadder(elm, n, p = this.ZERO) {
		let d = elm;
		while (n > _0n$2) {
			if (n & _1n$1) p = p.add(d);
			d = d.double();
			n >>= _1n$1;
		}
		return p;
	}
	/**
	* Creates a wNAF precomputation window. Used for caching.
	* Default window size is set by `utils.precompute()` and is equal to 8.
	* Number of precomputed points depends on the curve size:
	* 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
	* - 𝑊 is the window size
	* - 𝑛 is the bitlength of the curve order.
	* For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
	* @param point Point instance
	* @param W window size
	* @returns precomputed point tables flattened to a single array
	*/
	precomputeWindow(point, W) {
		const { windows, windowSize } = calcWOpts(W, this.bits);
		const points = [];
		let p = point;
		let base = p;
		for (let window = 0; window < windows; window++) {
			base = p;
			points.push(base);
			for (let i = 1; i < windowSize; i++) {
				base = base.add(p);
				points.push(base);
			}
			p = base.double();
		}
		return points;
	}
	/**
	* Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
	* More compact implementation:
	* https://github.com/paulmillr/noble-secp256k1/blob/47cb1669b6e506ad66b35fe7d76132ae97465da2/index.ts#L502-L541
	* @returns real and fake (for const-time) points
	*/
	wNAF(W, precomputes, n) {
		if (!this.Fn.isValid(n)) throw new Error("invalid scalar");
		let p = this.ZERO;
		let f = this.BASE;
		const wo = calcWOpts(W, this.bits);
		for (let window = 0; window < wo.windows; window++) {
			const { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
			n = nextN;
			if (isZero) f = f.add(negateCt(isNegF, precomputes[offsetF]));
			else p = p.add(negateCt(isNeg, precomputes[offset]));
		}
		assert0(n);
		return {
			p,
			f
		};
	}
	/**
	* Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
	* @param acc accumulator point to add result of multiplication
	* @returns point
	*/
	wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
		const wo = calcWOpts(W, this.bits);
		for (let window = 0; window < wo.windows; window++) {
			if (n === _0n$2) break;
			const { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
			n = nextN;
			if (isZero) continue;
			else {
				const item = precomputes[offset];
				acc = acc.add(isNeg ? item.negate() : item);
			}
		}
		assert0(n);
		return acc;
	}
	getPrecomputes(W, point, transform) {
		let comp = pointPrecomputes.get(point);
		if (!comp) {
			comp = this.precomputeWindow(point, W);
			if (W !== 1) {
				if (typeof transform === "function") comp = transform(comp);
				pointPrecomputes.set(point, comp);
			}
		}
		return comp;
	}
	cached(point, scalar, transform) {
		const W = getW(point);
		return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
	}
	unsafe(point, scalar, transform, prev) {
		const W = getW(point);
		if (W === 1) return this._unsafeLadder(point, scalar, prev);
		return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
	}
	createCache(P, W) {
		validateW(W, this.bits);
		pointWindowSizes.set(P, W);
		pointPrecomputes.delete(P);
	}
	hasCache(elm) {
		return getW(elm) !== 1;
	}
};
/**
* Endomorphism-specific multiplication for Koblitz curves.
* Cost: 128 dbl, 0-256 adds.
*/
function mulEndoUnsafe(Point, point, k1, k2) {
	let acc = point;
	let p1 = Point.ZERO;
	let p2 = Point.ZERO;
	while (k1 > _0n$2 || k2 > _0n$2) {
		if (k1 & _1n$1) p1 = p1.add(acc);
		if (k2 & _1n$1) p2 = p2.add(acc);
		acc = acc.double();
		k1 >>= _1n$1;
		k2 >>= _1n$1;
	}
	return {
		p1,
		p2
	};
}
function createField(order, field, isLE) {
	if (field) {
		if (field.ORDER !== order) throw new Error("Field.ORDER must match order: Fp == p, Fn == n");
		validateField(field);
		return field;
	} else return Field(order, { isLE });
}
/** Validates CURVE opts and creates fields */
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
	if (FpFnLE === void 0) FpFnLE = type === "edwards";
	if (!CURVE || typeof CURVE !== "object") throw new Error(`expected valid ${type} CURVE object`);
	for (const p of [
		"p",
		"n",
		"h"
	]) {
		const val = CURVE[p];
		if (!(typeof val === "bigint" && val > _0n$2)) throw new Error(`CURVE.${p} must be positive bigint`);
	}
	const Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE);
	const Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE);
	const params = [
		"Gx",
		"Gy",
		"a",
		type === "weierstrass" ? "b" : "d"
	];
	for (const p of params) if (!Fp.isValid(CURVE[p])) throw new Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
	CURVE = Object.freeze(Object.assign({}, CURVE));
	return {
		CURVE,
		Fp,
		Fn
	};
}
function createKeygen(randomSecretKey, getPublicKey) {
	return function keygen(seed) {
		const secretKey = randomSecretKey(seed);
		return {
			secretKey,
			publicKey: getPublicKey(secretKey)
		};
	};
}
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/hash-to-curve.js
const os2ip = bytesToNumberBE;
function i2osp(value, length) {
	asafenumber(value);
	asafenumber(length);
	if (value < 0 || value >= 1 << 8 * length) throw new Error("invalid I2OSP input: " + value);
	const res = Array.from({ length }).fill(0);
	for (let i = length - 1; i >= 0; i--) {
		res[i] = value & 255;
		value >>>= 8;
	}
	return new Uint8Array(res);
}
function strxor(a, b) {
	const arr = new Uint8Array(a.length);
	for (let i = 0; i < a.length; i++) arr[i] = a[i] ^ b[i];
	return arr;
}
function normDST(DST) {
	if (!isBytes$2(DST) && typeof DST !== "string") throw new Error("DST must be Uint8Array or ascii string");
	return typeof DST === "string" ? asciiToBytes(DST) : DST;
}
/**
* Produces a uniformly random byte string using a cryptographic hash function H that outputs b bits.
* [RFC 9380 5.3.1](https://www.rfc-editor.org/rfc/rfc9380#section-5.3.1).
*/
function expand_message_xmd(msg, DST, lenInBytes, H) {
	abytes$2(msg);
	asafenumber(lenInBytes);
	DST = normDST(DST);
	if (DST.length > 255) DST = H(concatBytes(asciiToBytes("H2C-OVERSIZE-DST-"), DST));
	const { outputLen: b_in_bytes, blockLen: r_in_bytes } = H;
	const ell = Math.ceil(lenInBytes / b_in_bytes);
	if (lenInBytes > 65535 || ell > 255) throw new Error("expand_message_xmd: invalid lenInBytes");
	const DST_prime = concatBytes(DST, i2osp(DST.length, 1));
	const Z_pad = i2osp(0, r_in_bytes);
	const l_i_b_str = i2osp(lenInBytes, 2);
	const b = new Array(ell);
	const b_0 = H(concatBytes(Z_pad, msg, l_i_b_str, i2osp(0, 1), DST_prime));
	b[0] = H(concatBytes(b_0, i2osp(1, 1), DST_prime));
	for (let i = 1; i <= ell; i++) b[i] = H(concatBytes(...[
		strxor(b_0, b[i - 1]),
		i2osp(i + 1, 1),
		DST_prime
	]));
	return concatBytes(...b).slice(0, lenInBytes);
}
/**
* Produces a uniformly random byte string using an extendable-output function (XOF) H.
* 1. The collision resistance of H MUST be at least k bits.
* 2. H MUST be an XOF that has been proved indifferentiable from
*    a random oracle under a reasonable cryptographic assumption.
* [RFC 9380 5.3.2](https://www.rfc-editor.org/rfc/rfc9380#section-5.3.2).
*/
function expand_message_xof(msg, DST, lenInBytes, k, H) {
	abytes$2(msg);
	asafenumber(lenInBytes);
	DST = normDST(DST);
	if (DST.length > 255) {
		const dkLen = Math.ceil(2 * k / 8);
		DST = H.create({ dkLen }).update(asciiToBytes("H2C-OVERSIZE-DST-")).update(DST).digest();
	}
	if (lenInBytes > 65535 || DST.length > 255) throw new Error("expand_message_xof: invalid lenInBytes");
	return H.create({ dkLen: lenInBytes }).update(msg).update(i2osp(lenInBytes, 2)).update(DST).update(i2osp(DST.length, 1)).digest();
}
/**
* Hashes arbitrary-length byte strings to a list of one or more elements of a finite field F.
* [RFC 9380 5.2](https://www.rfc-editor.org/rfc/rfc9380#section-5.2).
* @param msg a byte string containing the message to hash
* @param count the number of elements of F to output
* @param options `{DST: string, p: bigint, m: number, k: number, expand: 'xmd' | 'xof', hash: H}`, see above
* @returns [u_0, ..., u_(count - 1)], a list of field elements.
*/
function hash_to_field(msg, count, options) {
	validateObject(options, {
		p: "bigint",
		m: "number",
		k: "number",
		hash: "function"
	});
	const { p, k, m, hash, expand, DST } = options;
	asafenumber(hash.outputLen, "valid hash");
	abytes$2(msg);
	asafenumber(count);
	const log2p = p.toString(2).length;
	const L = Math.ceil((log2p + k) / 8);
	const len_in_bytes = count * m * L;
	let prb;
	if (expand === "xmd") prb = expand_message_xmd(msg, DST, len_in_bytes, hash);
	else if (expand === "xof") prb = expand_message_xof(msg, DST, len_in_bytes, k, hash);
	else if (expand === "_internal_pass") prb = msg;
	else throw new Error("expand must be \"xmd\" or \"xof\"");
	const u = new Array(count);
	for (let i = 0; i < count; i++) {
		const e = new Array(m);
		for (let j = 0; j < m; j++) {
			const elm_offset = L * (j + i * m);
			e[j] = mod(os2ip(prb.subarray(elm_offset, elm_offset + L)), p);
		}
		u[i] = e;
	}
	return u;
}
function isogenyMap(field, map) {
	const coeff = map.map((i) => Array.from(i).reverse());
	return (x, y) => {
		const [xn, xd, yn, yd] = coeff.map((val) => val.reduce((acc, i) => field.add(field.mul(acc, x), i)));
		const [xd_inv, yd_inv] = FpInvertBatch(field, [xd, yd], true);
		x = field.mul(xn, xd_inv);
		y = field.mul(y, field.mul(yn, yd_inv));
		return {
			x,
			y
		};
	};
}
const _DST_scalar = asciiToBytes("HashToScalar-");
/** Creates hash-to-curve methods from EC Point and mapToCurve function. See {@link H2CHasher}. */
function createHasher(Point, mapToCurve, defaults) {
	if (typeof mapToCurve !== "function") throw new Error("mapToCurve() must be defined");
	function map(num) {
		return Point.fromAffine(mapToCurve(num));
	}
	function clear(initial) {
		const P = initial.clearCofactor();
		if (P.equals(Point.ZERO)) return Point.ZERO;
		P.assertValidity();
		return P;
	}
	return {
		defaults: Object.freeze(defaults),
		Point,
		hashToCurve(msg, options) {
			const u = hash_to_field(msg, 2, Object.assign({}, defaults, options));
			const u0 = map(u[0]);
			const u1 = map(u[1]);
			return clear(u0.add(u1));
		},
		encodeToCurve(msg, options) {
			const optsDst = defaults.encodeDST ? { DST: defaults.encodeDST } : {};
			return clear(map(hash_to_field(msg, 1, Object.assign({}, defaults, optsDst, options))[0]));
		},
		mapToCurve(scalars) {
			if (defaults.m === 1) {
				if (typeof scalars !== "bigint") throw new Error("expected bigint (m=1)");
				return clear(map([scalars]));
			}
			if (!Array.isArray(scalars)) throw new Error("expected array of bigints");
			for (const i of scalars) if (typeof i !== "bigint") throw new Error("expected array of bigints");
			return clear(map(scalars));
		},
		hashToScalar(msg, options) {
			const N = Point.Fn.ORDER;
			return hash_to_field(msg, 1, Object.assign({}, defaults, {
				p: N,
				m: 1,
				DST: _DST_scalar
			}, options))[0][0];
		}
	};
}
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/hmac.js
/**
* HMAC: RFC2104 message authentication code.
* @module
*/
/** Internal class for HMAC. */
var _HMAC = class {
	oHash;
	iHash;
	blockLen;
	outputLen;
	finished = false;
	destroyed = false;
	constructor(hash, key) {
		ahash(hash);
		abytes$2(key, void 0, "key");
		this.iHash = hash.create();
		if (typeof this.iHash.update !== "function") throw new Error("Expected instance of class which extends utils.Hash");
		this.blockLen = this.iHash.blockLen;
		this.outputLen = this.iHash.outputLen;
		const blockLen = this.blockLen;
		const pad = new Uint8Array(blockLen);
		pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
		for (let i = 0; i < pad.length; i++) pad[i] ^= 54;
		this.iHash.update(pad);
		this.oHash = hash.create();
		for (let i = 0; i < pad.length; i++) pad[i] ^= 106;
		this.oHash.update(pad);
		clean$1(pad);
	}
	update(buf) {
		aexists$1(this);
		this.iHash.update(buf);
		return this;
	}
	digestInto(out) {
		aexists$1(this);
		abytes$2(out, this.outputLen, "output");
		this.finished = true;
		this.iHash.digestInto(out);
		this.oHash.update(out);
		this.oHash.digestInto(out);
		this.destroy();
	}
	digest() {
		const out = new Uint8Array(this.oHash.outputLen);
		this.digestInto(out);
		return out;
	}
	_cloneInto(to) {
		to ||= Object.create(Object.getPrototypeOf(this), {});
		const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
		to = to;
		to.finished = finished;
		to.destroyed = destroyed;
		to.blockLen = blockLen;
		to.outputLen = outputLen;
		to.oHash = oHash._cloneInto(to.oHash);
		to.iHash = iHash._cloneInto(to.iHash);
		return to;
	}
	clone() {
		return this._cloneInto();
	}
	destroy() {
		this.destroyed = true;
		this.oHash.destroy();
		this.iHash.destroy();
	}
};
/**
* HMAC: RFC2104 message authentication code.
* @param hash - function that would be used e.g. sha256
* @param key - message key
* @param message - message data
* @example
* import { hmac } from '@noble/hashes/hmac';
* import { sha256 } from '@noble/hashes/sha2';
* const mac1 = hmac(sha256, 'key', 'message');
*/
const hmac = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new _HMAC(hash, key);
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/weierstrass.js
/**
* Short Weierstrass curve methods. The formula is: y² = x³ + ax + b.
*
* ### Design rationale for types
*
* * Interaction between classes from different curves should fail:
*   `k256.Point.BASE.add(p256.Point.BASE)`
* * For this purpose we want to use `instanceof` operator, which is fast and works during runtime
* * Different calls of `curve()` would return different classes -
*   `curve(params) !== curve(params)`: if somebody decided to monkey-patch their curve,
*   it won't affect others
*
* TypeScript can't infer types for classes created inside a function. Classes is one instance
* of nominative types in TypeScript and interfaces only check for shape, so it's hard to create
* unique type for every function call.
*
* We can use generic types via some param, like curve opts, but that would:
*     1. Enable interaction between `curve(params)` and `curve(params)` (curves of same params)
*     which is hard to debug.
*     2. Params can be generic and we can't enforce them to be constant value:
*     if somebody creates curve from non-constant params,
*     it would be allowed to interact with other curves with non-constant params
*
* @todo https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-7.html#unique-symbol
* @module
*/
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n$1) / den;
/**
* Splits scalar for GLV endomorphism.
*/
function _splitEndoScalar(k, basis, n) {
	const [[a1, b1], [a2, b2]] = basis;
	const c1 = divNearest(b2 * k, n);
	const c2 = divNearest(-b1 * k, n);
	let k1 = k - c1 * a1 - c2 * a2;
	let k2 = -c1 * b1 - c2 * b2;
	const k1neg = k1 < _0n$1;
	const k2neg = k2 < _0n$1;
	if (k1neg) k1 = -k1;
	if (k2neg) k2 = -k2;
	const MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n;
	if (k1 < _0n$1 || k1 >= MAX_NUM || k2 < _0n$1 || k2 >= MAX_NUM) throw new Error("splitScalar (endomorphism): failed, k=" + k);
	return {
		k1neg,
		k1,
		k2neg,
		k2
	};
}
function validateSigFormat(format) {
	if (![
		"compact",
		"recovered",
		"der"
	].includes(format)) throw new Error("Signature format must be \"compact\", \"recovered\", or \"der\"");
	return format;
}
function validateSigOpts(opts, def) {
	const optsn = {};
	for (let optName of Object.keys(def)) optsn[optName] = opts[optName] === void 0 ? def[optName] : opts[optName];
	abool$1(optsn.lowS, "lowS");
	abool$1(optsn.prehash, "prehash");
	if (optsn.format !== void 0) validateSigFormat(optsn.format);
	return optsn;
}
var DERErr = class extends Error {
	constructor(m = "") {
		super(m);
	}
};
/**
* ASN.1 DER encoding utilities. ASN is very complex & fragile. Format:
*
*     [0x30 (SEQUENCE), bytelength, 0x02 (INTEGER), intLength, R, 0x02 (INTEGER), intLength, S]
*
* Docs: https://letsencrypt.org/docs/a-warm-welcome-to-asn1-and-der/, https://luca.ntop.org/Teaching/Appunti/asn1.html
*/
const DER = {
	Err: DERErr,
	_tlv: {
		encode: (tag, data) => {
			const { Err: E } = DER;
			if (tag < 0 || tag > 256) throw new E("tlv.encode: wrong tag");
			if (data.length & 1) throw new E("tlv.encode: unpadded data");
			const dataLen = data.length / 2;
			const len = numberToHexUnpadded(dataLen);
			if (len.length / 2 & 128) throw new E("tlv.encode: long form length too big");
			const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
			return numberToHexUnpadded(tag) + lenLen + len + data;
		},
		decode(tag, data) {
			const { Err: E } = DER;
			let pos = 0;
			if (tag < 0 || tag > 256) throw new E("tlv.encode: wrong tag");
			if (data.length < 2 || data[pos++] !== tag) throw new E("tlv.decode: wrong tlv");
			const first = data[pos++];
			const isLong = !!(first & 128);
			let length = 0;
			if (!isLong) length = first;
			else {
				const lenLen = first & 127;
				if (!lenLen) throw new E("tlv.decode(long): indefinite length not supported");
				if (lenLen > 4) throw new E("tlv.decode(long): byte length is too big");
				const lengthBytes = data.subarray(pos, pos + lenLen);
				if (lengthBytes.length !== lenLen) throw new E("tlv.decode: length bytes not complete");
				if (lengthBytes[0] === 0) throw new E("tlv.decode(long): zero leftmost byte");
				for (const b of lengthBytes) length = length << 8 | b;
				pos += lenLen;
				if (length < 128) throw new E("tlv.decode(long): not minimal encoding");
			}
			const v = data.subarray(pos, pos + length);
			if (v.length !== length) throw new E("tlv.decode: wrong value length");
			return {
				v,
				l: data.subarray(pos + length)
			};
		}
	},
	_int: {
		encode(num) {
			const { Err: E } = DER;
			if (num < _0n$1) throw new E("integer: negative integers are not allowed");
			let hex = numberToHexUnpadded(num);
			if (Number.parseInt(hex[0], 16) & 8) hex = "00" + hex;
			if (hex.length & 1) throw new E("unexpected DER parsing assertion: unpadded hex");
			return hex;
		},
		decode(data) {
			const { Err: E } = DER;
			if (data[0] & 128) throw new E("invalid signature integer: negative");
			if (data[0] === 0 && !(data[1] & 128)) throw new E("invalid signature integer: unnecessary leading zero");
			return bytesToNumberBE(data);
		}
	},
	toSig(bytes) {
		const { Err: E, _int: int, _tlv: tlv } = DER;
		const data = abytes$2(bytes, void 0, "signature");
		const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
		if (seqLeftBytes.length) throw new E("invalid signature: left bytes after parsing");
		const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
		const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
		if (sLeftBytes.length) throw new E("invalid signature: left bytes after parsing");
		return {
			r: int.decode(rBytes),
			s: int.decode(sBytes)
		};
	},
	hexFromSig(sig) {
		const { _tlv: tlv, _int: int } = DER;
		const seq = tlv.encode(2, int.encode(sig.r)) + tlv.encode(2, int.encode(sig.s));
		return tlv.encode(48, seq);
	}
};
const _0n$1 = BigInt(0), _1n = BigInt(1), _2n$1 = BigInt(2), _3n = BigInt(3), _4n = BigInt(4);
/**
* Creates weierstrass Point constructor, based on specified curve options.
*
* See {@link WeierstrassOpts}.
*
* @example
```js
const opts = {
p: 0xfffffffffffffffffffffffffffffffeffffac73n,
n: 0x100000000000000000001b8fa16dfab9aca16b6b3n,
h: 1n,
a: 0n,
b: 7n,
Gx: 0x3b4c382ce37aa192a4019e763036f4f5dd4d7ebbn,
Gy: 0x938cf935318fdced6bc28286531733c3f03c4feen,
};
const secp160k1_Point = weierstrass(opts);
```
*/
function weierstrass(params, extraOpts = {}) {
	const validated = createCurveFields("weierstrass", params, extraOpts);
	const { Fp, Fn } = validated;
	let CURVE = validated.CURVE;
	const { h: cofactor, n: CURVE_ORDER } = CURVE;
	validateObject(extraOpts, {}, {
		allowInfinityPoint: "boolean",
		clearCofactor: "function",
		isTorsionFree: "function",
		fromBytes: "function",
		toBytes: "function",
		endo: "object"
	});
	const { endo } = extraOpts;
	if (endo) {
		if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises)) throw new Error("invalid endo: expected \"beta\": bigint and \"basises\": array");
	}
	const lengths = getWLengths(Fp, Fn);
	function assertCompressionIsSupported() {
		if (!Fp.isOdd) throw new Error("compression is not supported: Field does not have .isOdd()");
	}
	function pointToBytes(_c, point, isCompressed) {
		const { x, y } = point.toAffine();
		const bx = Fp.toBytes(x);
		abool$1(isCompressed, "isCompressed");
		if (isCompressed) {
			assertCompressionIsSupported();
			return concatBytes(pprefix(!Fp.isOdd(y)), bx);
		} else return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
	}
	function pointFromBytes(bytes) {
		abytes$2(bytes, void 0, "Point");
		const { publicKey: comp, publicKeyUncompressed: uncomp } = lengths;
		const length = bytes.length;
		const head = bytes[0];
		const tail = bytes.subarray(1);
		if (length === comp && (head === 2 || head === 3)) {
			const x = Fp.fromBytes(tail);
			if (!Fp.isValid(x)) throw new Error("bad point: is not on curve, wrong x");
			const y2 = weierstrassEquation(x);
			let y;
			try {
				y = Fp.sqrt(y2);
			} catch (sqrtError) {
				const err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
				throw new Error("bad point: is not on curve, sqrt error" + err);
			}
			assertCompressionIsSupported();
			const evenY = Fp.isOdd(y);
			if ((head & 1) === 1 !== evenY) y = Fp.neg(y);
			return {
				x,
				y
			};
		} else if (length === uncomp && head === 4) {
			const L = Fp.BYTES;
			const x = Fp.fromBytes(tail.subarray(0, L));
			const y = Fp.fromBytes(tail.subarray(L, L * 2));
			if (!isValidXY(x, y)) throw new Error("bad point: is not on curve");
			return {
				x,
				y
			};
		} else throw new Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
	}
	const encodePoint = extraOpts.toBytes || pointToBytes;
	const decodePoint = extraOpts.fromBytes || pointFromBytes;
	function weierstrassEquation(x) {
		const x2 = Fp.sqr(x);
		const x3 = Fp.mul(x2, x);
		return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
	}
	/** Checks whether equation holds for given x, y: y² == x³ + ax + b */
	function isValidXY(x, y) {
		const left = Fp.sqr(y);
		const right = weierstrassEquation(x);
		return Fp.eql(left, right);
	}
	if (!isValidXY(CURVE.Gx, CURVE.Gy)) throw new Error("bad curve params: generator point");
	const _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n), _4n);
	const _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
	if (Fp.is0(Fp.add(_4a3, _27b2))) throw new Error("bad curve params: a or b");
	/** Asserts coordinate is valid: 0 <= n < Fp.ORDER. */
	function acoord(title, n, banZero = false) {
		if (!Fp.isValid(n) || banZero && Fp.is0(n)) throw new Error(`bad point coordinate ${title}`);
		return n;
	}
	function aprjpoint(other) {
		if (!(other instanceof Point)) throw new Error("Weierstrass Point expected");
	}
	function splitEndoScalarN(k) {
		if (!endo || !endo.basises) throw new Error("no endo");
		return _splitEndoScalar(k, endo.basises, Fn.ORDER);
	}
	const toAffineMemo = memoized((p, iz) => {
		const { X, Y, Z } = p;
		if (Fp.eql(Z, Fp.ONE)) return {
			x: X,
			y: Y
		};
		const is0 = p.is0();
		if (iz == null) iz = is0 ? Fp.ONE : Fp.inv(Z);
		const x = Fp.mul(X, iz);
		const y = Fp.mul(Y, iz);
		const zz = Fp.mul(Z, iz);
		if (is0) return {
			x: Fp.ZERO,
			y: Fp.ZERO
		};
		if (!Fp.eql(zz, Fp.ONE)) throw new Error("invZ was invalid");
		return {
			x,
			y
		};
	});
	const assertValidMemo = memoized((p) => {
		if (p.is0()) {
			if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y)) return;
			throw new Error("bad point: ZERO");
		}
		const { x, y } = p.toAffine();
		if (!Fp.isValid(x) || !Fp.isValid(y)) throw new Error("bad point: x or y not field elements");
		if (!isValidXY(x, y)) throw new Error("bad point: equation left != right");
		if (!p.isTorsionFree()) throw new Error("bad point: not in prime-order subgroup");
		return true;
	});
	function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
		k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z);
		k1p = negateCt(k1neg, k1p);
		k2p = negateCt(k2neg, k2p);
		return k1p.add(k2p);
	}
	/**
	* Projective Point works in 3d / projective (homogeneous) coordinates:(X, Y, Z) ∋ (x=X/Z, y=Y/Z).
	* Default Point works in 2d / affine coordinates: (x, y).
	* We're doing calculations in projective, because its operations don't require costly inversion.
	*/
	class Point {
		static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
		static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
		static Fp = Fp;
		static Fn = Fn;
		X;
		Y;
		Z;
		/** Does NOT validate if the point is valid. Use `.assertValidity()`. */
		constructor(X, Y, Z) {
			this.X = acoord("x", X);
			this.Y = acoord("y", Y, true);
			this.Z = acoord("z", Z);
			Object.freeze(this);
		}
		static CURVE() {
			return CURVE;
		}
		/** Does NOT validate if the point is valid. Use `.assertValidity()`. */
		static fromAffine(p) {
			const { x, y } = p || {};
			if (!p || !Fp.isValid(x) || !Fp.isValid(y)) throw new Error("invalid affine point");
			if (p instanceof Point) throw new Error("projective point not allowed");
			if (Fp.is0(x) && Fp.is0(y)) return Point.ZERO;
			return new Point(x, y, Fp.ONE);
		}
		static fromBytes(bytes) {
			const P = Point.fromAffine(decodePoint(abytes$2(bytes, void 0, "point")));
			P.assertValidity();
			return P;
		}
		static fromHex(hex) {
			return Point.fromBytes(hexToBytes(hex));
		}
		get x() {
			return this.toAffine().x;
		}
		get y() {
			return this.toAffine().y;
		}
		/**
		*
		* @param windowSize
		* @param isLazy true will defer table computation until the first multiplication
		* @returns
		*/
		precompute(windowSize = 8, isLazy = true) {
			wnaf.createCache(this, windowSize);
			if (!isLazy) this.multiply(_3n);
			return this;
		}
		/** A point on curve is valid if it conforms to equation. */
		assertValidity() {
			assertValidMemo(this);
		}
		hasEvenY() {
			const { y } = this.toAffine();
			if (!Fp.isOdd) throw new Error("Field doesn't support isOdd");
			return !Fp.isOdd(y);
		}
		/** Compare one point to another. */
		equals(other) {
			aprjpoint(other);
			const { X: X1, Y: Y1, Z: Z1 } = this;
			const { X: X2, Y: Y2, Z: Z2 } = other;
			const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
			const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
			return U1 && U2;
		}
		/** Flips point to one corresponding to (x, -y) in Affine coordinates. */
		negate() {
			return new Point(this.X, Fp.neg(this.Y), this.Z);
		}
		double() {
			const { a, b } = CURVE;
			const b3 = Fp.mul(b, _3n);
			const { X: X1, Y: Y1, Z: Z1 } = this;
			let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
			let t0 = Fp.mul(X1, X1);
			let t1 = Fp.mul(Y1, Y1);
			let t2 = Fp.mul(Z1, Z1);
			let t3 = Fp.mul(X1, Y1);
			t3 = Fp.add(t3, t3);
			Z3 = Fp.mul(X1, Z1);
			Z3 = Fp.add(Z3, Z3);
			X3 = Fp.mul(a, Z3);
			Y3 = Fp.mul(b3, t2);
			Y3 = Fp.add(X3, Y3);
			X3 = Fp.sub(t1, Y3);
			Y3 = Fp.add(t1, Y3);
			Y3 = Fp.mul(X3, Y3);
			X3 = Fp.mul(t3, X3);
			Z3 = Fp.mul(b3, Z3);
			t2 = Fp.mul(a, t2);
			t3 = Fp.sub(t0, t2);
			t3 = Fp.mul(a, t3);
			t3 = Fp.add(t3, Z3);
			Z3 = Fp.add(t0, t0);
			t0 = Fp.add(Z3, t0);
			t0 = Fp.add(t0, t2);
			t0 = Fp.mul(t0, t3);
			Y3 = Fp.add(Y3, t0);
			t2 = Fp.mul(Y1, Z1);
			t2 = Fp.add(t2, t2);
			t0 = Fp.mul(t2, t3);
			X3 = Fp.sub(X3, t0);
			Z3 = Fp.mul(t2, t1);
			Z3 = Fp.add(Z3, Z3);
			Z3 = Fp.add(Z3, Z3);
			return new Point(X3, Y3, Z3);
		}
		add(other) {
			aprjpoint(other);
			const { X: X1, Y: Y1, Z: Z1 } = this;
			const { X: X2, Y: Y2, Z: Z2 } = other;
			let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
			const a = CURVE.a;
			const b3 = Fp.mul(CURVE.b, _3n);
			let t0 = Fp.mul(X1, X2);
			let t1 = Fp.mul(Y1, Y2);
			let t2 = Fp.mul(Z1, Z2);
			let t3 = Fp.add(X1, Y1);
			let t4 = Fp.add(X2, Y2);
			t3 = Fp.mul(t3, t4);
			t4 = Fp.add(t0, t1);
			t3 = Fp.sub(t3, t4);
			t4 = Fp.add(X1, Z1);
			let t5 = Fp.add(X2, Z2);
			t4 = Fp.mul(t4, t5);
			t5 = Fp.add(t0, t2);
			t4 = Fp.sub(t4, t5);
			t5 = Fp.add(Y1, Z1);
			X3 = Fp.add(Y2, Z2);
			t5 = Fp.mul(t5, X3);
			X3 = Fp.add(t1, t2);
			t5 = Fp.sub(t5, X3);
			Z3 = Fp.mul(a, t4);
			X3 = Fp.mul(b3, t2);
			Z3 = Fp.add(X3, Z3);
			X3 = Fp.sub(t1, Z3);
			Z3 = Fp.add(t1, Z3);
			Y3 = Fp.mul(X3, Z3);
			t1 = Fp.add(t0, t0);
			t1 = Fp.add(t1, t0);
			t2 = Fp.mul(a, t2);
			t4 = Fp.mul(b3, t4);
			t1 = Fp.add(t1, t2);
			t2 = Fp.sub(t0, t2);
			t2 = Fp.mul(a, t2);
			t4 = Fp.add(t4, t2);
			t0 = Fp.mul(t1, t4);
			Y3 = Fp.add(Y3, t0);
			t0 = Fp.mul(t5, t4);
			X3 = Fp.mul(t3, X3);
			X3 = Fp.sub(X3, t0);
			t0 = Fp.mul(t3, t1);
			Z3 = Fp.mul(t5, Z3);
			Z3 = Fp.add(Z3, t0);
			return new Point(X3, Y3, Z3);
		}
		subtract(other) {
			return this.add(other.negate());
		}
		is0() {
			return this.equals(Point.ZERO);
		}
		/**
		* Constant time multiplication.
		* Uses wNAF method. Windowed method may be 10% faster,
		* but takes 2x longer to generate and consumes 2x memory.
		* Uses precomputes when available.
		* Uses endomorphism for Koblitz curves.
		* @param scalar by which the point would be multiplied
		* @returns New point
		*/
		multiply(scalar) {
			const { endo } = extraOpts;
			if (!Fn.isValidNot0(scalar)) throw new Error("invalid scalar: out of range");
			let point, fake;
			const mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
			/** See docs for {@link EndomorphismOpts} */
			if (endo) {
				const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar);
				const { p: k1p, f: k1f } = mul(k1);
				const { p: k2p, f: k2f } = mul(k2);
				fake = k1f.add(k2f);
				point = finishEndo(endo.beta, k1p, k2p, k1neg, k2neg);
			} else {
				const { p, f } = mul(scalar);
				point = p;
				fake = f;
			}
			return normalizeZ(Point, [point, fake])[0];
		}
		/**
		* Non-constant-time multiplication. Uses double-and-add algorithm.
		* It's faster, but should only be used when you don't care about
		* an exposed secret key e.g. sig verification, which works over *public* keys.
		*/
		multiplyUnsafe(sc) {
			const { endo } = extraOpts;
			const p = this;
			if (!Fn.isValid(sc)) throw new Error("invalid scalar: out of range");
			if (sc === _0n$1 || p.is0()) return Point.ZERO;
			if (sc === _1n) return p;
			if (wnaf.hasCache(this)) return this.multiply(sc);
			if (endo) {
				const { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc);
				const { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
				return finishEndo(endo.beta, p1, p2, k1neg, k2neg);
			} else return wnaf.unsafe(p, sc);
		}
		/**
		* Converts Projective point to affine (x, y) coordinates.
		* @param invertedZ Z^-1 (inverted zero) - optional, precomputation is useful for invertBatch
		*/
		toAffine(invertedZ) {
			return toAffineMemo(this, invertedZ);
		}
		/**
		* Checks whether Point is free of torsion elements (is in prime subgroup).
		* Always torsion-free for cofactor=1 curves.
		*/
		isTorsionFree() {
			const { isTorsionFree } = extraOpts;
			if (cofactor === _1n) return true;
			if (isTorsionFree) return isTorsionFree(Point, this);
			return wnaf.unsafe(this, CURVE_ORDER).is0();
		}
		clearCofactor() {
			const { clearCofactor } = extraOpts;
			if (cofactor === _1n) return this;
			if (clearCofactor) return clearCofactor(Point, this);
			return this.multiplyUnsafe(cofactor);
		}
		isSmallOrder() {
			return this.multiplyUnsafe(cofactor).is0();
		}
		toBytes(isCompressed = true) {
			abool$1(isCompressed, "isCompressed");
			this.assertValidity();
			return encodePoint(Point, this, isCompressed);
		}
		toHex(isCompressed = true) {
			return bytesToHex(this.toBytes(isCompressed));
		}
		toString() {
			return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
		}
	}
	const bits = Fn.BITS;
	const wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
	Point.BASE.precompute(8);
	return Point;
}
function pprefix(hasEvenY) {
	return Uint8Array.of(hasEvenY ? 2 : 3);
}
/**
* Implementation of the Shallue and van de Woestijne method for any weierstrass curve.
* TODO: check if there is a way to merge this with uvRatio in Edwards; move to modular.
* b = True and y = sqrt(u / v) if (u / v) is square in F, and
* b = False and y = sqrt(Z * (u / v)) otherwise.
* @param Fp
* @param Z
* @returns
*/
function SWUFpSqrtRatio(Fp, Z) {
	const q = Fp.ORDER;
	let l = _0n$1;
	for (let o = q - _1n; o % _2n$1 === _0n$1; o /= _2n$1) l += _1n;
	const c1 = l;
	const _2n_pow_c1_1 = _2n$1 << c1 - _1n - _1n;
	const _2n_pow_c1 = _2n_pow_c1_1 * _2n$1;
	const c2 = (q - _1n) / _2n_pow_c1;
	const c3 = (c2 - _1n) / _2n$1;
	const c4 = _2n_pow_c1 - _1n;
	const c5 = _2n_pow_c1_1;
	const c6 = Fp.pow(Z, c2);
	const c7 = Fp.pow(Z, (c2 + _1n) / _2n$1);
	let sqrtRatio = (u, v) => {
		let tv1 = c6;
		let tv2 = Fp.pow(v, c4);
		let tv3 = Fp.sqr(tv2);
		tv3 = Fp.mul(tv3, v);
		let tv5 = Fp.mul(u, tv3);
		tv5 = Fp.pow(tv5, c3);
		tv5 = Fp.mul(tv5, tv2);
		tv2 = Fp.mul(tv5, v);
		tv3 = Fp.mul(tv5, u);
		let tv4 = Fp.mul(tv3, tv2);
		tv5 = Fp.pow(tv4, c5);
		let isQR = Fp.eql(tv5, Fp.ONE);
		tv2 = Fp.mul(tv3, c7);
		tv5 = Fp.mul(tv4, tv1);
		tv3 = Fp.cmov(tv2, tv3, isQR);
		tv4 = Fp.cmov(tv5, tv4, isQR);
		for (let i = c1; i > _1n; i--) {
			let tv5 = i - _2n$1;
			tv5 = _2n$1 << tv5 - _1n;
			let tvv5 = Fp.pow(tv4, tv5);
			const e1 = Fp.eql(tvv5, Fp.ONE);
			tv2 = Fp.mul(tv3, tv1);
			tv1 = Fp.mul(tv1, tv1);
			tvv5 = Fp.mul(tv4, tv1);
			tv3 = Fp.cmov(tv2, tv3, e1);
			tv4 = Fp.cmov(tvv5, tv4, e1);
		}
		return {
			isValid: isQR,
			value: tv3
		};
	};
	if (Fp.ORDER % _4n === _3n) {
		const c1 = (Fp.ORDER - _3n) / _4n;
		const c2 = Fp.sqrt(Fp.neg(Z));
		sqrtRatio = (u, v) => {
			let tv1 = Fp.sqr(v);
			const tv2 = Fp.mul(u, v);
			tv1 = Fp.mul(tv1, tv2);
			let y1 = Fp.pow(tv1, c1);
			y1 = Fp.mul(y1, tv2);
			const y2 = Fp.mul(y1, c2);
			const tv3 = Fp.mul(Fp.sqr(y1), v);
			const isQR = Fp.eql(tv3, u);
			return {
				isValid: isQR,
				value: Fp.cmov(y2, y1, isQR)
			};
		};
	}
	return sqrtRatio;
}
/**
* Simplified Shallue-van de Woestijne-Ulas Method
* https://www.rfc-editor.org/rfc/rfc9380#section-6.6.2
*/
function mapToCurveSimpleSWU(Fp, opts) {
	validateField(Fp);
	const { A, B, Z } = opts;
	if (!Fp.isValid(A) || !Fp.isValid(B) || !Fp.isValid(Z)) throw new Error("mapToCurveSimpleSWU: invalid opts");
	const sqrtRatio = SWUFpSqrtRatio(Fp, Z);
	if (!Fp.isOdd) throw new Error("Field does not have .isOdd()");
	return (u) => {
		let tv1, tv2, tv3, tv4, tv5, tv6, x, y;
		tv1 = Fp.sqr(u);
		tv1 = Fp.mul(tv1, Z);
		tv2 = Fp.sqr(tv1);
		tv2 = Fp.add(tv2, tv1);
		tv3 = Fp.add(tv2, Fp.ONE);
		tv3 = Fp.mul(tv3, B);
		tv4 = Fp.cmov(Z, Fp.neg(tv2), !Fp.eql(tv2, Fp.ZERO));
		tv4 = Fp.mul(tv4, A);
		tv2 = Fp.sqr(tv3);
		tv6 = Fp.sqr(tv4);
		tv5 = Fp.mul(tv6, A);
		tv2 = Fp.add(tv2, tv5);
		tv2 = Fp.mul(tv2, tv3);
		tv6 = Fp.mul(tv6, tv4);
		tv5 = Fp.mul(tv6, B);
		tv2 = Fp.add(tv2, tv5);
		x = Fp.mul(tv1, tv3);
		const { isValid, value } = sqrtRatio(tv2, tv6);
		y = Fp.mul(tv1, u);
		y = Fp.mul(y, value);
		x = Fp.cmov(x, tv3, isValid);
		y = Fp.cmov(y, value, isValid);
		const e1 = Fp.isOdd(u) === Fp.isOdd(y);
		y = Fp.cmov(Fp.neg(y), y, e1);
		const tv4_inv = FpInvertBatch(Fp, [tv4], true)[0];
		x = Fp.mul(x, tv4_inv);
		return {
			x,
			y
		};
	};
}
function getWLengths(Fp, Fn) {
	return {
		secretKey: Fn.BYTES,
		publicKey: 1 + Fp.BYTES,
		publicKeyUncompressed: 1 + 2 * Fp.BYTES,
		publicKeyHasPrefix: true,
		signature: 2 * Fn.BYTES
	};
}
/**
* Sometimes users only need getPublicKey, getSharedSecret, and secret key handling.
* This helper ensures no signature functionality is present. Less code, smaller bundle size.
*/
function ecdh(Point, ecdhOpts = {}) {
	const { Fn } = Point;
	const randomBytes_ = ecdhOpts.randomBytes || randomBytes$1;
	const lengths = Object.assign(getWLengths(Point.Fp, Fn), { seed: getMinHashLength(Fn.ORDER) });
	function isValidSecretKey(secretKey) {
		try {
			const num = Fn.fromBytes(secretKey);
			return Fn.isValidNot0(num);
		} catch (error) {
			return false;
		}
	}
	function isValidPublicKey(publicKey, isCompressed) {
		const { publicKey: comp, publicKeyUncompressed } = lengths;
		try {
			const l = publicKey.length;
			if (isCompressed === true && l !== comp) return false;
			if (isCompressed === false && l !== publicKeyUncompressed) return false;
			return !!Point.fromBytes(publicKey);
		} catch (error) {
			return false;
		}
	}
	/**
	* Produces cryptographically secure secret key from random of size
	* (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
	*/
	function randomSecretKey(seed = randomBytes_(lengths.seed)) {
		return mapHashToField(abytes$2(seed, lengths.seed, "seed"), Fn.ORDER);
	}
	/**
	* Computes public key for a secret key. Checks for validity of the secret key.
	* @param isCompressed whether to return compact (default), or full key
	* @returns Public key, full when isCompressed=false; short when isCompressed=true
	*/
	function getPublicKey(secretKey, isCompressed = true) {
		return Point.BASE.multiply(Fn.fromBytes(secretKey)).toBytes(isCompressed);
	}
	/**
	* Quick and dirty check for item being public key. Does not validate hex, or being on-curve.
	*/
	function isProbPub(item) {
		const { secretKey, publicKey, publicKeyUncompressed } = lengths;
		if (!isBytes$2(item)) return void 0;
		if ("_lengths" in Fn && Fn._lengths || secretKey === publicKey) return void 0;
		const l = abytes$2(item, void 0, "key").length;
		return l === publicKey || l === publicKeyUncompressed;
	}
	/**
	* ECDH (Elliptic Curve Diffie Hellman).
	* Computes shared public key from secret key A and public key B.
	* Checks: 1) secret key validity 2) shared key is on-curve.
	* Does NOT hash the result.
	* @param isCompressed whether to return compact (default), or full key
	* @returns shared public key
	*/
	function getSharedSecret(secretKeyA, publicKeyB, isCompressed = true) {
		if (isProbPub(secretKeyA) === true) throw new Error("first arg must be private key");
		if (isProbPub(publicKeyB) === false) throw new Error("second arg must be public key");
		const s = Fn.fromBytes(secretKeyA);
		return Point.fromBytes(publicKeyB).multiply(s).toBytes(isCompressed);
	}
	const utils = {
		isValidSecretKey,
		isValidPublicKey,
		randomSecretKey
	};
	const keygen = createKeygen(randomSecretKey, getPublicKey);
	return Object.freeze({
		getPublicKey,
		getSharedSecret,
		keygen,
		Point,
		utils,
		lengths
	});
}
/**
* Creates ECDSA signing interface for given elliptic curve `Point` and `hash` function.
*
* @param Point created using {@link weierstrass} function
* @param hash used for 1) message prehash-ing 2) k generation in `sign`, using hmac_drbg(hash)
* @param ecdsaOpts rarely needed, see {@link ECDSAOpts}
*
* @example
* ```js
* const p256_Point = weierstrass(...);
* const p256_sha256 = ecdsa(p256_Point, sha256);
* const p256_sha224 = ecdsa(p256_Point, sha224);
* const p256_sha224_r = ecdsa(p256_Point, sha224, { randomBytes: (length) => { ... } });
* ```
*/
function ecdsa(Point, hash, ecdsaOpts = {}) {
	ahash(hash);
	validateObject(ecdsaOpts, {}, {
		hmac: "function",
		lowS: "boolean",
		randomBytes: "function",
		bits2int: "function",
		bits2int_modN: "function"
	});
	ecdsaOpts = Object.assign({}, ecdsaOpts);
	const randomBytes = ecdsaOpts.randomBytes || randomBytes$1;
	const hmac$1 = ecdsaOpts.hmac || ((key, msg) => hmac(hash, key, msg));
	const { Fp, Fn } = Point;
	const { ORDER: CURVE_ORDER, BITS: fnBits } = Fn;
	const { keygen, getPublicKey, getSharedSecret, utils, lengths } = ecdh(Point, ecdsaOpts);
	const defaultSigOpts = {
		prehash: true,
		lowS: typeof ecdsaOpts.lowS === "boolean" ? ecdsaOpts.lowS : true,
		format: "compact",
		extraEntropy: false
	};
	const hasLargeCofactor = CURVE_ORDER * _2n$1 < Fp.ORDER;
	function isBiggerThanHalfOrder(number) {
		return number > CURVE_ORDER >> _1n;
	}
	function validateRS(title, num) {
		if (!Fn.isValidNot0(num)) throw new Error(`invalid signature ${title}: out of range 1..Point.Fn.ORDER`);
		return num;
	}
	function assertSmallCofactor() {
		if (hasLargeCofactor) throw new Error("\"recovered\" sig type is not supported for cofactor >2 curves");
	}
	function validateSigLength(bytes, format) {
		validateSigFormat(format);
		const size = lengths.signature;
		return abytes$2(bytes, format === "compact" ? size : format === "recovered" ? size + 1 : void 0);
	}
	/**
	* ECDSA signature with its (r, s) properties. Supports compact, recovered & DER representations.
	*/
	class Signature {
		r;
		s;
		recovery;
		constructor(r, s, recovery) {
			this.r = validateRS("r", r);
			this.s = validateRS("s", s);
			if (recovery != null) {
				assertSmallCofactor();
				if (![
					0,
					1,
					2,
					3
				].includes(recovery)) throw new Error("invalid recovery id");
				this.recovery = recovery;
			}
			Object.freeze(this);
		}
		static fromBytes(bytes, format = defaultSigOpts.format) {
			validateSigLength(bytes, format);
			let recid;
			if (format === "der") {
				const { r, s } = DER.toSig(abytes$2(bytes));
				return new Signature(r, s);
			}
			if (format === "recovered") {
				recid = bytes[0];
				format = "compact";
				bytes = bytes.subarray(1);
			}
			const L = lengths.signature / 2;
			const r = bytes.subarray(0, L);
			const s = bytes.subarray(L, L * 2);
			return new Signature(Fn.fromBytes(r), Fn.fromBytes(s), recid);
		}
		static fromHex(hex, format) {
			return this.fromBytes(hexToBytes(hex), format);
		}
		assertRecovery() {
			const { recovery } = this;
			if (recovery == null) throw new Error("invalid recovery id: must be present");
			return recovery;
		}
		addRecoveryBit(recovery) {
			return new Signature(this.r, this.s, recovery);
		}
		recoverPublicKey(messageHash) {
			const { r, s } = this;
			const recovery = this.assertRecovery();
			const radj = recovery === 2 || recovery === 3 ? r + CURVE_ORDER : r;
			if (!Fp.isValid(radj)) throw new Error("invalid recovery id: sig.r+curve.n != R.x");
			const x = Fp.toBytes(radj);
			const R = Point.fromBytes(concatBytes(pprefix((recovery & 1) === 0), x));
			const ir = Fn.inv(radj);
			const h = bits2int_modN(abytes$2(messageHash, void 0, "msgHash"));
			const u1 = Fn.create(-h * ir);
			const u2 = Fn.create(s * ir);
			const Q = Point.BASE.multiplyUnsafe(u1).add(R.multiplyUnsafe(u2));
			if (Q.is0()) throw new Error("invalid recovery: point at infinify");
			Q.assertValidity();
			return Q;
		}
		hasHighS() {
			return isBiggerThanHalfOrder(this.s);
		}
		toBytes(format = defaultSigOpts.format) {
			validateSigFormat(format);
			if (format === "der") return hexToBytes(DER.hexFromSig(this));
			const { r, s } = this;
			const rb = Fn.toBytes(r);
			const sb = Fn.toBytes(s);
			if (format === "recovered") {
				assertSmallCofactor();
				return concatBytes(Uint8Array.of(this.assertRecovery()), rb, sb);
			}
			return concatBytes(rb, sb);
		}
		toHex(format) {
			return bytesToHex(this.toBytes(format));
		}
	}
	const bits2int = ecdsaOpts.bits2int || function bits2int_def(bytes) {
		if (bytes.length > 8192) throw new Error("input is too large");
		const num = bytesToNumberBE(bytes);
		const delta = bytes.length * 8 - fnBits;
		return delta > 0 ? num >> BigInt(delta) : num;
	};
	const bits2int_modN = ecdsaOpts.bits2int_modN || function bits2int_modN_def(bytes) {
		return Fn.create(bits2int(bytes));
	};
	const ORDER_MASK = bitMask(fnBits);
	/** Converts to bytes. Checks if num in `[0..ORDER_MASK-1]` e.g.: `[0..2^256-1]`. */
	function int2octets(num) {
		aInRange("num < 2^" + fnBits, num, _0n$1, ORDER_MASK);
		return Fn.toBytes(num);
	}
	function validateMsgAndHash(message, prehash) {
		abytes$2(message, void 0, "message");
		return prehash ? abytes$2(hash(message), void 0, "prehashed message") : message;
	}
	/**
	* Steps A, D of RFC6979 3.2.
	* Creates RFC6979 seed; converts msg/privKey to numbers.
	* Used only in sign, not in verify.
	*
	* Warning: we cannot assume here that message has same amount of bytes as curve order,
	* this will be invalid at least for P521. Also it can be bigger for P224 + SHA256.
	*/
	function prepSig(message, secretKey, opts) {
		const { lowS, prehash, extraEntropy } = validateSigOpts(opts, defaultSigOpts);
		message = validateMsgAndHash(message, prehash);
		const h1int = bits2int_modN(message);
		const d = Fn.fromBytes(secretKey);
		if (!Fn.isValidNot0(d)) throw new Error("invalid private key");
		const seedArgs = [int2octets(d), int2octets(h1int)];
		if (extraEntropy != null && extraEntropy !== false) {
			const e = extraEntropy === true ? randomBytes(lengths.secretKey) : extraEntropy;
			seedArgs.push(abytes$2(e, void 0, "extraEntropy"));
		}
		const seed = concatBytes(...seedArgs);
		const m = h1int;
		function k2sig(kBytes) {
			const k = bits2int(kBytes);
			if (!Fn.isValidNot0(k)) return;
			const ik = Fn.inv(k);
			const q = Point.BASE.multiply(k).toAffine();
			const r = Fn.create(q.x);
			if (r === _0n$1) return;
			const s = Fn.create(ik * Fn.create(m + r * d));
			if (s === _0n$1) return;
			let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n);
			let normS = s;
			if (lowS && isBiggerThanHalfOrder(s)) {
				normS = Fn.neg(s);
				recovery ^= 1;
			}
			return new Signature(r, normS, hasLargeCofactor ? void 0 : recovery);
		}
		return {
			seed,
			k2sig
		};
	}
	/**
	* Signs message hash with a secret key.
	*
	* ```
	* sign(m, d) where
	*   k = rfc6979_hmac_drbg(m, d)
	*   (x, y) = G × k
	*   r = x mod n
	*   s = (m + dr) / k mod n
	* ```
	*/
	function sign(message, secretKey, opts = {}) {
		const { seed, k2sig } = prepSig(message, secretKey, opts);
		return createHmacDrbg(hash.outputLen, Fn.BYTES, hmac$1)(seed, k2sig).toBytes(opts.format);
	}
	/**
	* Verifies a signature against message and public key.
	* Rejects lowS signatures by default: see {@link ECDSAVerifyOpts}.
	* Implements section 4.1.4 from https://www.secg.org/sec1-v2.pdf:
	*
	* ```
	* verify(r, s, h, P) where
	*   u1 = hs^-1 mod n
	*   u2 = rs^-1 mod n
	*   R = u1⋅G + u2⋅P
	*   mod(R.x, n) == r
	* ```
	*/
	function verify(signature, message, publicKey, opts = {}) {
		const { lowS, prehash, format } = validateSigOpts(opts, defaultSigOpts);
		publicKey = abytes$2(publicKey, void 0, "publicKey");
		message = validateMsgAndHash(message, prehash);
		if (!isBytes$2(signature)) {
			const end = signature instanceof Signature ? ", use sig.toBytes()" : "";
			throw new Error("verify expects Uint8Array signature" + end);
		}
		validateSigLength(signature, format);
		try {
			const sig = Signature.fromBytes(signature, format);
			const P = Point.fromBytes(publicKey);
			if (lowS && sig.hasHighS()) return false;
			const { r, s } = sig;
			const h = bits2int_modN(message);
			const is = Fn.inv(s);
			const u1 = Fn.create(h * is);
			const u2 = Fn.create(r * is);
			const R = Point.BASE.multiplyUnsafe(u1).add(P.multiplyUnsafe(u2));
			if (R.is0()) return false;
			return Fn.create(R.x) === r;
		} catch (e) {
			return false;
		}
	}
	function recoverPublicKey(signature, message, opts = {}) {
		const { prehash } = validateSigOpts(opts, defaultSigOpts);
		message = validateMsgAndHash(message, prehash);
		return Signature.fromBytes(signature, "recovered").recoverPublicKey(message).toBytes();
	}
	return Object.freeze({
		keygen,
		getPublicKey,
		getSharedSecret,
		utils,
		lengths,
		Point,
		sign,
		verify,
		recoverPublicKey,
		Signature,
		hash
	});
}
//#endregion
//#region node_modules/.pnpm/@noble+curves@2.0.1/node_modules/@noble/curves/secp256k1.js
/**
* SECG secp256k1. See [pdf](https://www.secg.org/sec2-v2.pdf).
*
* Belongs to Koblitz curves: it has efficiently-computable GLV endomorphism ψ,
* check out {@link EndomorphismOpts}. Seems to be rigid (not backdoored).
* @module
*/
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
const secp256k1_CURVE = {
	p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
	n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
	h: BigInt(1),
	a: BigInt(0),
	b: BigInt(7),
	Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
	Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
};
const secp256k1_ENDO = {
	beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
	basises: [[BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")], [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]
};
const _0n = /* @__PURE__ */ BigInt(0);
const _2n = /* @__PURE__ */ BigInt(2);
/**
* √n = n^((p+1)/4) for fields p = 3 mod 4. We unwrap the loop and multiply bit-by-bit.
* (P+1n/4n).toString(2) would produce bits [223x 1, 0, 22x 1, 4x 0, 11, 00]
*/
function sqrtMod(y) {
	const P = secp256k1_CURVE.p;
	const _3n = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
	const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
	const b2 = y * y * y % P;
	const b3 = b2 * b2 * y % P;
	const b11 = pow2(pow2(pow2(b3, _3n, P) * b3 % P, _3n, P) * b3 % P, _2n, P) * b2 % P;
	const b22 = pow2(b11, _11n, P) * b11 % P;
	const b44 = pow2(b22, _22n, P) * b22 % P;
	const b88 = pow2(b44, _44n, P) * b44 % P;
	const root = pow2(pow2(pow2(pow2(pow2(pow2(b88, _88n, P) * b88 % P, _44n, P) * b44 % P, _3n, P) * b3 % P, _23n, P) * b22 % P, _6n, P) * b2 % P, _2n, P);
	if (!Fpk1.eql(Fpk1.sqr(root), y)) throw new Error("Cannot find square root");
	return root;
}
const Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod });
const Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
	Fp: Fpk1,
	endo: secp256k1_ENDO
});
/**
* secp256k1 curve: ECDSA and ECDH methods.
*
* Uses sha256 to hash messages. To use a different hash,
* pass `{ prehash: false }` to sign / verify.
*
* @example
* ```js
* import { secp256k1 } from '@noble/curves/secp256k1.js';
* const { secretKey, publicKey } = secp256k1.keygen();
* // const publicKey = secp256k1.getPublicKey(secretKey);
* const msg = new TextEncoder().encode('hello noble');
* const sig = secp256k1.sign(msg, secretKey);
* const isValid = secp256k1.verify(sig, msg, publicKey);
* // const sigKeccak = secp256k1.sign(keccak256(msg), secretKey, { prehash: false });
* ```
*/
const secp256k1 = /* @__PURE__ */ ecdsa(Pointk1, sha256);
/** An object mapping tags to their tagged hash prefix of [SHA256(tag) | SHA256(tag)] */
const TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
	let tagP = TAGGED_HASH_PREFIXES[tag];
	if (tagP === void 0) {
		const tagH = sha256(asciiToBytes(tag));
		tagP = concatBytes(tagH, tagH);
		TAGGED_HASH_PREFIXES[tag] = tagP;
	}
	return sha256(concatBytes(tagP, ...messages));
}
const pointToBytes = (point) => point.toBytes(true).slice(1);
const hasEven = (y) => y % _2n === _0n;
function schnorrGetExtPubKey(priv) {
	const { Fn, BASE } = Pointk1;
	const d_ = Fn.fromBytes(priv);
	const p = BASE.multiply(d_);
	return {
		scalar: hasEven(p.y) ? d_ : Fn.neg(d_),
		bytes: pointToBytes(p)
	};
}
/**
* lift_x from BIP340. Convert 32-byte x coordinate to elliptic curve point.
* @returns valid point checked for being on-curve
*/
function lift_x(x) {
	const Fp = Fpk1;
	if (!Fp.isValidNot0(x)) throw new Error("invalid x: Fail if x ≥ p");
	const xx = Fp.create(x * x);
	const c = Fp.create(xx * x + BigInt(7));
	let y = Fp.sqrt(c);
	if (!hasEven(y)) y = Fp.neg(y);
	const p = Pointk1.fromAffine({
		x,
		y
	});
	p.assertValidity();
	return p;
}
const num = bytesToNumberBE;
/**
* Create tagged hash, convert it to bigint, reduce modulo-n.
*/
function challenge(...args) {
	return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
/**
* Schnorr public key is just `x` coordinate of Point as per BIP340.
*/
function schnorrGetPublicKey(secretKey) {
	return schnorrGetExtPubKey(secretKey).bytes;
}
/**
* Creates Schnorr signature as per BIP340. Verifies itself before returning anything.
* auxRand is optional and is not the sole source of k generation: bad CSPRNG won't be dangerous.
*/
function schnorrSign(message, secretKey, auxRand = randomBytes$1(32)) {
	const { Fn } = Pointk1;
	const m = abytes$2(message, void 0, "message");
	const { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey);
	const a = abytes$2(auxRand, 32, "auxRand");
	const { bytes: rx, scalar: k } = schnorrGetExtPubKey(taggedHash("BIP0340/nonce", Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a))), px, m));
	const e = challenge(rx, px, m);
	const sig = new Uint8Array(64);
	sig.set(rx, 0);
	sig.set(Fn.toBytes(Fn.create(k + e * d)), 32);
	if (!schnorrVerify(sig, m, px)) throw new Error("sign: Invalid signature produced");
	return sig;
}
/**
* Verifies Schnorr signature.
* Will swallow errors & return false except for initial type validation of arguments.
*/
function schnorrVerify(signature, message, publicKey) {
	const { Fp, Fn, BASE } = Pointk1;
	const sig = abytes$2(signature, 64, "signature");
	const m = abytes$2(message, void 0, "message");
	const pub = abytes$2(publicKey, 32, "publicKey");
	try {
		const P = lift_x(num(pub));
		const r = num(sig.subarray(0, 32));
		if (!Fp.isValidNot0(r)) return false;
		const s = num(sig.subarray(32, 64));
		if (!Fn.isValidNot0(s)) return false;
		const e = challenge(Fn.toBytes(r), pointToBytes(P), m);
		const R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e)));
		const { x, y } = R.toAffine();
		if (R.is0() || !hasEven(y) || x !== r) return false;
		return true;
	} catch (error) {
		return false;
	}
}
/**
* Schnorr signatures over secp256k1.
* https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
* @example
* ```js
* import { schnorr } from '@noble/curves/secp256k1.js';
* const { secretKey, publicKey } = schnorr.keygen();
* // const publicKey = schnorr.getPublicKey(secretKey);
* const msg = new TextEncoder().encode('hello');
* const sig = schnorr.sign(msg, secretKey);
* const isValid = schnorr.verify(sig, msg, publicKey);
* ```
*/
const schnorr = /* @__PURE__ */ (() => {
	const size = 32;
	const seedLength = 48;
	const randomSecretKey = (seed = randomBytes$1(seedLength)) => {
		return mapHashToField(seed, secp256k1_CURVE.n);
	};
	return {
		keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
		getPublicKey: schnorrGetPublicKey,
		sign: schnorrSign,
		verify: schnorrVerify,
		Point: Pointk1,
		utils: {
			randomSecretKey,
			taggedHash,
			lift_x,
			pointToBytes
		},
		lengths: {
			secretKey: size,
			publicKey: size,
			publicKeyHasPrefix: false,
			signature: size * 2,
			seed: seedLength
		}
	};
})();
const isoMap = isogenyMap(Fpk1, [
	[
		"0x8e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38daaaaa8c7",
		"0x7d3d4c80bc321d5b9f315cea7fd44c5d595d2fc0bf63b92dfff1044f17c6581",
		"0x534c328d23f234e6e2a413deca25caece4506144037c40314ecbd0b53d9dd262",
		"0x8e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38daaaaa88c"
	],
	[
		"0xd35771193d94918a9ca34ccbb7b640dd86cd409542f8487d9fe6b745781eb49b",
		"0xedadc6f64383dc1df7c4b2d51b54225406d36b641f5e41bbc52a56612a8c6d14",
		"0x0000000000000000000000000000000000000000000000000000000000000001"
	],
	[
		"0x4bda12f684bda12f684bda12f684bda12f684bda12f684bda12f684b8e38e23c",
		"0xc75e0c32d5cb7c0fa9d0a54b12a0a6d5647ab046d686da6fdffc90fc201d71a3",
		"0x29a6194691f91a73715209ef6512e576722830a201be2018a765e85a9ecee931",
		"0x2f684bda12f684bda12f684bda12f684bda12f684bda12f684bda12f38e38d84"
	],
	[
		"0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffff93b",
		"0x7a06534bb8bdb49fd5e9e6632722c2989467c1bfc8e8d978dfb425d2685c2573",
		"0x6484aa716545ca2cf3a70c3fa8fe337e0a3d21162f0d6299a7bf8192bfd2a76f",
		"0x0000000000000000000000000000000000000000000000000000000000000001"
	]
].map((i) => i.map((j) => BigInt(j))));
const mapSWU = mapToCurveSimpleSWU(Fpk1, {
	A: BigInt("0x3f8731abdd661adca08a5558f0f5d272e953d363cb6f0e5d405447c01a444533"),
	B: BigInt("1771"),
	Z: Fpk1.create(BigInt("-11"))
});
createHasher(Pointk1, (scalars) => {
	const { x, y } = mapSWU(Fpk1.create(scalars[0]));
	return isoMap(x, y);
}, {
	DST: "secp256k1_XMD:SHA-256_SSWU_RO_",
	encodeDST: "secp256k1_XMD:SHA-256_SSWU_NU_",
	p: Fpk1.ORDER,
	m: 1,
	k: 128,
	expand: "xmd",
	hash: sha256
});
//#endregion
//#region node_modules/.pnpm/@scure+base@2.0.0/node_modules/@scure/base/index.js
/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes$1(a) {
	return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
/** Asserts something is Uint8Array. */
function abytes$1(b) {
	if (!isBytes$1(b)) throw new Error("Uint8Array expected");
}
function isArrayOf(isString, arr) {
	if (!Array.isArray(arr)) return false;
	if (arr.length === 0) return true;
	if (isString) return arr.every((item) => typeof item === "string");
	else return arr.every((item) => Number.isSafeInteger(item));
}
function afn(input) {
	if (typeof input !== "function") throw new Error("function expected");
	return true;
}
function astr(label, input) {
	if (typeof input !== "string") throw new Error(`${label}: string expected`);
	return true;
}
function anumber$1(n) {
	if (!Number.isSafeInteger(n)) throw new Error(`invalid integer: ${n}`);
}
function aArr(input) {
	if (!Array.isArray(input)) throw new Error("array expected");
}
function astrArr(label, input) {
	if (!isArrayOf(true, input)) throw new Error(`${label}: array of strings expected`);
}
function anumArr(label, input) {
	if (!isArrayOf(false, input)) throw new Error(`${label}: array of numbers expected`);
}
/**
* @__NO_SIDE_EFFECTS__
*/
function chain(...args) {
	const id = (a) => a;
	const wrap = (a, b) => (c) => a(b(c));
	return {
		encode: args.map((x) => x.encode).reduceRight(wrap, id),
		decode: args.map((x) => x.decode).reduce(wrap, id)
	};
}
/**
* Encodes integer radix representation to array of strings using alphabet and back.
* Could also be array of strings.
* @__NO_SIDE_EFFECTS__
*/
function alphabet(letters) {
	const lettersA = typeof letters === "string" ? letters.split("") : letters;
	const len = lettersA.length;
	astrArr("alphabet", lettersA);
	const indexes = new Map(lettersA.map((l, i) => [l, i]));
	return {
		encode: (digits) => {
			aArr(digits);
			return digits.map((i) => {
				if (!Number.isSafeInteger(i) || i < 0 || i >= len) throw new Error(`alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`);
				return lettersA[i];
			});
		},
		decode: (input) => {
			aArr(input);
			return input.map((letter) => {
				astr("alphabet.decode", letter);
				const i = indexes.get(letter);
				if (i === void 0) throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
				return i;
			});
		}
	};
}
/**
* @__NO_SIDE_EFFECTS__
*/
function join$1(separator = "") {
	astr("join", separator);
	return {
		encode: (from) => {
			astrArr("join.decode", from);
			return from.join(separator);
		},
		decode: (to) => {
			astr("join.decode", to);
			return to.split(separator);
		}
	};
}
/**
* Pad strings array so it has integer number of bits
* @__NO_SIDE_EFFECTS__
*/
function padding(bits, chr = "=") {
	anumber$1(bits);
	astr("padding", chr);
	return {
		encode(data) {
			astrArr("padding.encode", data);
			while (data.length * bits % 8) data.push(chr);
			return data;
		},
		decode(input) {
			astrArr("padding.decode", input);
			let end = input.length;
			if (end * bits % 8) throw new Error("padding: invalid, string should have whole number of bytes");
			for (; end > 0 && input[end - 1] === chr; end--) if ((end - 1) * bits % 8 === 0) throw new Error("padding: invalid, string has too much padding");
			return input.slice(0, end);
		}
	};
}
/**
* @__NO_SIDE_EFFECTS__
*/
function normalize(fn) {
	afn(fn);
	return {
		encode: (from) => from,
		decode: (to) => fn(to)
	};
}
const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
const radix2carry = /* @__NO_SIDE_EFFECTS__ */ (from, to) => from + (to - gcd(from, to));
const powers = /* @__PURE__ */ (() => {
	let res = [];
	for (let i = 0; i < 40; i++) res.push(2 ** i);
	return res;
})();
/**
* Implemented with numbers, because BigInt is 5x slower
*/
function convertRadix2(data, from, to, padding) {
	aArr(data);
	if (from <= 0 || from > 32) throw new Error(`convertRadix2: wrong from=${from}`);
	if (to <= 0 || to > 32) throw new Error(`convertRadix2: wrong to=${to}`);
	if (/* @__PURE__ */ radix2carry(from, to) > 32) throw new Error(`convertRadix2: carry overflow from=${from} to=${to} carryBits=${/* @__PURE__ */ radix2carry(from, to)}`);
	let carry = 0;
	let pos = 0;
	const max = powers[from];
	const mask = powers[to] - 1;
	const res = [];
	for (const n of data) {
		anumber$1(n);
		if (n >= max) throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
		carry = carry << from | n;
		if (pos + from > 32) throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
		pos += from;
		for (; pos >= to; pos -= to) res.push((carry >> pos - to & mask) >>> 0);
		const pow = powers[pos];
		if (pow === void 0) throw new Error("invalid carry");
		carry &= pow - 1;
	}
	carry = carry << to - pos & mask;
	if (!padding && pos >= from) throw new Error("Excess padding");
	if (!padding && carry > 0) throw new Error(`Non-zero padding: ${carry}`);
	if (padding && pos > 0) res.push(carry >>> 0);
	return res;
}
/**
* If both bases are power of same number (like `2**8 <-> 2**64`),
* there is a linear algorithm. For now we have implementation for power-of-two bases only.
* @__NO_SIDE_EFFECTS__
*/
function radix2(bits, revPadding = false) {
	anumber$1(bits);
	if (bits <= 0 || bits > 32) throw new Error("radix2: bits should be in (0..32]");
	if (/* @__PURE__ */ radix2carry(8, bits) > 32 || /* @__PURE__ */ radix2carry(bits, 8) > 32) throw new Error("radix2: carry overflow");
	return {
		encode: (bytes) => {
			if (!isBytes$1(bytes)) throw new Error("radix2.encode input should be Uint8Array");
			return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
		},
		decode: (digits) => {
			anumArr("radix2.decode", digits);
			return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
		}
	};
}
function unsafeWrapper(fn) {
	afn(fn);
	return function(...args) {
		try {
			return fn.apply(null, args);
		} catch (e) {}
	};
}
chain(radix2(4), alphabet("0123456789ABCDEF"), join$1(""));
chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), padding(5), join$1(""));
chain(radix2(5), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"), join$1(""));
chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), padding(5), join$1(""));
chain(radix2(5), alphabet("0123456789ABCDEFGHIJKLMNOPQRSTUV"), join$1(""));
chain(radix2(5), alphabet("0123456789ABCDEFGHJKMNPQRSTVWXYZ"), join$1(""), normalize((s) => s.toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1")));
const hasBase64Builtin = typeof Uint8Array.from([]).toBase64 === "function" && typeof Uint8Array.fromBase64 === "function";
const decodeBase64Builtin = (s, isUrl) => {
	astr("base64", s);
	const re = isUrl ? /^[A-Za-z0-9=_-]+$/ : /^[A-Za-z0-9=+/]+$/;
	const alphabet = isUrl ? "base64url" : "base64";
	if (s.length > 0 && !re.test(s)) throw new Error("invalid base64");
	return Uint8Array.fromBase64(s, {
		alphabet,
		lastChunkHandling: "strict"
	});
};
/**
* base64 from RFC 4648. Padded.
* Use `base64nopad` for unpadded version.
* Also check out `base64url`, `base64urlnopad`.
* Falls back to built-in function, when available.
* @example
* ```js
* base64.encode(Uint8Array.from([0x12, 0xab]));
* // => 'Eqs='
* base64.decode('Eqs=');
* // => Uint8Array.from([0x12, 0xab])
* ```
*/
const base64 = hasBase64Builtin ? {
	encode(b) {
		abytes$1(b);
		return b.toBase64();
	},
	decode(s) {
		return decodeBase64Builtin(s, false);
	}
} : chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), padding(6), join$1(""));
chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"), join$1(""));
hasBase64Builtin || chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), padding(6), join$1(""));
chain(radix2(6), alphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"), join$1(""));
const BECH_ALPHABET = chain(alphabet("qpzry9x8gf2tvdw0s3jn54khce6mua7l"), join$1(""));
const POLYMOD_GENERATORS = [
	996825010,
	642813549,
	513874426,
	1027748829,
	705979059
];
function bech32Polymod(pre) {
	const b = pre >> 25;
	let chk = (pre & 33554431) << 5;
	for (let i = 0; i < POLYMOD_GENERATORS.length; i++) if ((b >> i & 1) === 1) chk ^= POLYMOD_GENERATORS[i];
	return chk;
}
function bechChecksum(prefix, words, encodingConst = 1) {
	const len = prefix.length;
	let chk = 1;
	for (let i = 0; i < len; i++) {
		const c = prefix.charCodeAt(i);
		if (c < 33 || c > 126) throw new Error(`Invalid prefix (${prefix})`);
		chk = bech32Polymod(chk) ^ c >> 5;
	}
	chk = bech32Polymod(chk);
	for (let i = 0; i < len; i++) chk = bech32Polymod(chk) ^ prefix.charCodeAt(i) & 31;
	for (let v of words) chk = bech32Polymod(chk) ^ v;
	for (let i = 0; i < 6; i++) chk = bech32Polymod(chk);
	chk ^= encodingConst;
	return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]], 30, 5, false));
}
/**
* @__NO_SIDE_EFFECTS__
*/
function genBech32(encoding) {
	const ENCODING_CONST = encoding === "bech32" ? 1 : 734539939;
	const _words = radix2(5);
	const fromWords = _words.decode;
	const toWords = _words.encode;
	const fromWordsUnsafe = unsafeWrapper(fromWords);
	function encode(prefix, words, limit = 90) {
		astr("bech32.encode prefix", prefix);
		if (isBytes$1(words)) words = Array.from(words);
		anumArr("bech32.encode", words);
		const plen = prefix.length;
		if (plen === 0) throw new TypeError(`Invalid prefix length ${plen}`);
		const actualLength = plen + 7 + words.length;
		if (limit !== false && actualLength > limit) throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
		const lowered = prefix.toLowerCase();
		const sum = bechChecksum(lowered, words, ENCODING_CONST);
		return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}`;
	}
	function decode(str, limit = 90) {
		astr("bech32.decode input", str);
		const slen = str.length;
		if (slen < 8 || limit !== false && slen > limit) throw new TypeError(`invalid string length: ${slen} (${str}). Expected (8..${limit})`);
		const lowered = str.toLowerCase();
		if (str !== lowered && str !== str.toUpperCase()) throw new Error(`String must be lowercase or uppercase`);
		const sepIndex = lowered.lastIndexOf("1");
		if (sepIndex === 0 || sepIndex === -1) throw new Error(`Letter "1" must be present between prefix and data only`);
		const prefix = lowered.slice(0, sepIndex);
		const data = lowered.slice(sepIndex + 1);
		if (data.length < 6) throw new Error("Data must be at least 6 characters long");
		const words = BECH_ALPHABET.decode(data).slice(0, -6);
		const sum = bechChecksum(prefix, words, ENCODING_CONST);
		if (!data.endsWith(sum)) throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
		return {
			prefix,
			words
		};
	}
	const decodeUnsafe = unsafeWrapper(decode);
	function decodeToBytes(str) {
		const { prefix, words } = decode(str, false);
		return {
			prefix,
			words,
			bytes: fromWords(words)
		};
	}
	function encodeFromBytes(prefix, bytes) {
		return encode(prefix, toWords(bytes));
	}
	return {
		encode,
		decode,
		encodeFromBytes,
		decodeToBytes,
		decodeUnsafe,
		fromWords,
		fromWordsUnsafe,
		toWords
	};
}
/**
* bech32 from BIP 173. Operates on words.
* For high-level, check out scure-btc-signer:
* https://github.com/paulmillr/scure-btc-signer.
*/
const bech32 = genBech32("bech32");
genBech32("bech32m");
typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function" || chain(radix2(4), alphabet("0123456789abcdef"), join$1(""), normalize((s) => {
	if (typeof s !== "string" || s.length % 2 !== 0) throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
	return s.toLowerCase();
}));
//#endregion
//#region node_modules/.pnpm/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/utils.js
/**
* Utilities for hex, bytes, CSPRNG.
* @module
*/
/*! noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com) */
/** Checks if something is Uint8Array. Be careful: nodejs Buffer will return true. */
function isBytes(a) {
	return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
/** Asserts something is boolean. */
function abool(b) {
	if (typeof b !== "boolean") throw new Error(`boolean expected, not ${b}`);
}
/** Asserts something is positive integer. */
function anumber(n) {
	if (!Number.isSafeInteger(n) || n < 0) throw new Error("positive integer expected, got " + n);
}
/** Asserts something is Uint8Array. */
function abytes(value, length, title = "") {
	const bytes = isBytes(value);
	const len = value?.length;
	const needsLen = length !== void 0;
	if (!bytes || needsLen && len !== length) {
		const prefix = title && `"${title}" `;
		const ofLen = needsLen ? ` of length ${length}` : "";
		const got = bytes ? `length=${len}` : `type=${typeof value}`;
		throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
	}
	return value;
}
/** Asserts a hash instance has not been destroyed / finished */
function aexists(instance, checkFinished = true) {
	if (instance.destroyed) throw new Error("Hash instance has been destroyed");
	if (checkFinished && instance.finished) throw new Error("Hash#digest() has already been called");
}
/** Asserts output is properly-sized byte array */
function aoutput(out, instance) {
	abytes(out, void 0, "output");
	const min = instance.outputLen;
	if (out.length < min) throw new Error("digestInto() expects output buffer of length at least " + min);
}
/** Cast u8 / u16 / u32 to u32. */
function u32(arr) {
	return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
/** Zeroize a byte array. Warning: JS provides no guarantees. */
function clean(...arrays) {
	for (let i = 0; i < arrays.length; i++) arrays[i].fill(0);
}
/** Create DataView of an array for easy byte-level manipulation. */
function createView(arr) {
	return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
/** Is current platform little-endian? Most are. Big-Endian platform: IBM */
const isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
typeof Uint8Array.from([]).toHex === "function" && Uint8Array.fromHex;
/**
* Checks if two U8A use same underlying buffer and overlaps.
* This is invalid and can corrupt data.
*/
function overlapBytes(a, b) {
	return a.buffer === b.buffer && a.byteOffset < b.byteOffset + b.byteLength && b.byteOffset < a.byteOffset + a.byteLength;
}
/**
* If input and output overlap and input starts before output, we will overwrite end of input before
* we start processing it, so this is not supported for most ciphers (except chacha/salse, which designed with this)
*/
function complexOverlapBytes(input, output) {
	if (overlapBytes(input, output) && input.byteOffset < output.byteOffset) throw new Error("complex overlap of input and output is not supported");
}
function checkOpts(defaults, opts) {
	if (opts == null || typeof opts !== "object") throw new Error("options must be defined");
	return Object.assign(defaults, opts);
}
/** Compares 2 uint8array-s in kinda constant time. */
function equalBytes(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}
/**
* Wraps a cipher: validates args, ensures encrypt() can only be called once.
* @__NO_SIDE_EFFECTS__
*/
const wrapCipher = (params, constructor) => {
	function wrappedCipher(key, ...args) {
		abytes(key, void 0, "key");
		if (!isLE) throw new Error("Non little-endian hardware is not yet supported");
		if (params.nonceLength !== void 0) {
			const nonce = args[0];
			abytes(nonce, params.varSizeNonce ? void 0 : params.nonceLength, "nonce");
		}
		const tagl = params.tagLength;
		if (tagl && args[1] !== void 0) abytes(args[1], void 0, "AAD");
		const cipher = constructor(key, ...args);
		const checkOutput = (fnLength, output) => {
			if (output !== void 0) {
				if (fnLength !== 2) throw new Error("cipher output not supported");
				abytes(output, void 0, "output");
			}
		};
		let called = false;
		return {
			encrypt(data, output) {
				if (called) throw new Error("cannot encrypt() twice with same key + nonce");
				called = true;
				abytes(data);
				checkOutput(cipher.encrypt.length, output);
				return cipher.encrypt(data, output);
			},
			decrypt(data, output) {
				abytes(data);
				if (tagl && data.length < tagl) throw new Error("\"ciphertext\" expected length bigger than tagLength=" + tagl);
				checkOutput(cipher.decrypt.length, output);
				return cipher.decrypt(data, output);
			}
		};
	}
	Object.assign(wrappedCipher, params);
	return wrappedCipher;
};
/**
* By default, returns u8a of length.
* When out is available, it checks it for validity and uses it.
*/
function getOutput(expectedLength, out, onlyAligned = true) {
	if (out === void 0) return new Uint8Array(expectedLength);
	if (out.length !== expectedLength) throw new Error("\"output\" expected Uint8Array of length " + expectedLength + ", got: " + out.length);
	if (onlyAligned && !isAligned32$1(out)) throw new Error("invalid output, must be aligned");
	return out;
}
function u64Lengths(dataLength, aadLength, isLE) {
	abool(isLE);
	const num = new Uint8Array(16);
	const view = createView(num);
	view.setBigUint64(0, BigInt(aadLength), isLE);
	view.setBigUint64(8, BigInt(dataLength), isLE);
	return num;
}
function isAligned32$1(bytes) {
	return bytes.byteOffset % 4 === 0;
}
function copyBytes(bytes) {
	return Uint8Array.from(bytes);
}
//#endregion
//#region node_modules/.pnpm/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/aes.js
const BLOCK_SIZE = 16;
const POLY = 283;
function validateKeyLength(key) {
	if (![
		16,
		24,
		32
	].includes(key.length)) throw new Error("\"aes key\" expected Uint8Array of length 16/24/32, got length=" + key.length);
}
function mul2(n) {
	return n << 1 ^ POLY & -(n >> 7);
}
function mul(a, b) {
	let res = 0;
	for (; b > 0; b >>= 1) {
		res ^= a & -(b & 1);
		a = mul2(a);
	}
	return res;
}
const sbox = /* @__PURE__ */ (() => {
	const t = new Uint8Array(256);
	for (let i = 0, x = 1; i < 256; i++, x ^= mul2(x)) t[i] = x;
	const box = new Uint8Array(256);
	box[0] = 99;
	for (let i = 0; i < 255; i++) {
		let x = t[255 - i];
		x |= x << 8;
		box[t[i]] = (x ^ x >> 4 ^ x >> 5 ^ x >> 6 ^ x >> 7 ^ 99) & 255;
	}
	clean(t);
	return box;
})();
const invSbox = /* @__PURE__ */ sbox.map((_, j) => sbox.indexOf(j));
const rotr32_8 = (n) => n << 24 | n >>> 8;
const rotl32_8 = (n) => n << 8 | n >>> 24;
function genTtable(sbox, fn) {
	if (sbox.length !== 256) throw new Error("Wrong sbox length");
	const T0 = new Uint32Array(256).map((_, j) => fn(sbox[j]));
	const T1 = T0.map(rotl32_8);
	const T2 = T1.map(rotl32_8);
	const T3 = T2.map(rotl32_8);
	const T01 = new Uint32Array(256 * 256);
	const T23 = new Uint32Array(256 * 256);
	const sbox2 = new Uint16Array(256 * 256);
	for (let i = 0; i < 256; i++) for (let j = 0; j < 256; j++) {
		const idx = i * 256 + j;
		T01[idx] = T0[i] ^ T1[j];
		T23[idx] = T2[i] ^ T3[j];
		sbox2[idx] = sbox[i] << 8 | sbox[j];
	}
	return {
		sbox,
		sbox2,
		T0,
		T1,
		T2,
		T3,
		T01,
		T23
	};
}
const tableEncoding = /* @__PURE__ */ genTtable(sbox, (s) => mul(s, 3) << 24 | s << 16 | s << 8 | mul(s, 2));
const tableDecoding = /* @__PURE__ */ genTtable(invSbox, (s) => mul(s, 11) << 24 | mul(s, 13) << 16 | mul(s, 9) << 8 | mul(s, 14));
const xPowers = /* @__PURE__ */ (() => {
	const p = new Uint8Array(16);
	for (let i = 0, x = 1; i < 16; i++, x = mul2(x)) p[i] = x;
	return p;
})();
/** Key expansion used in CTR. */
function expandKeyLE(key) {
	abytes(key);
	const len = key.length;
	validateKeyLength(key);
	const { sbox2 } = tableEncoding;
	const toClean = [];
	if (!isAligned32$1(key)) toClean.push(key = copyBytes(key));
	const k32 = u32(key);
	const Nk = k32.length;
	const subByte = (n) => applySbox(sbox2, n, n, n, n);
	const xk = new Uint32Array(len + 28);
	xk.set(k32);
	for (let i = Nk; i < xk.length; i++) {
		let t = xk[i - 1];
		if (i % Nk === 0) t = subByte(rotr32_8(t)) ^ xPowers[i / Nk - 1];
		else if (Nk > 6 && i % Nk === 4) t = subByte(t);
		xk[i] = xk[i - Nk] ^ t;
	}
	clean(...toClean);
	return xk;
}
function expandKeyDecLE(key) {
	const encKey = expandKeyLE(key);
	const xk = encKey.slice();
	const Nk = encKey.length;
	const { sbox2 } = tableEncoding;
	const { T0, T1, T2, T3 } = tableDecoding;
	for (let i = 0; i < Nk; i += 4) for (let j = 0; j < 4; j++) xk[i + j] = encKey[Nk - i - 4 + j];
	clean(encKey);
	for (let i = 4; i < Nk - 4; i++) {
		const x = xk[i];
		const w = applySbox(sbox2, x, x, x, x);
		xk[i] = T0[w & 255] ^ T1[w >>> 8 & 255] ^ T2[w >>> 16 & 255] ^ T3[w >>> 24];
	}
	return xk;
}
function apply0123(T01, T23, s0, s1, s2, s3) {
	return T01[s0 << 8 & 65280 | s1 >>> 8 & 255] ^ T23[s2 >>> 8 & 65280 | s3 >>> 24 & 255];
}
function applySbox(sbox2, s0, s1, s2, s3) {
	return sbox2[s0 & 255 | s1 & 65280] | sbox2[s2 >>> 16 & 255 | s3 >>> 16 & 65280] << 16;
}
function encrypt$2(xk, s0, s1, s2, s3) {
	const { sbox2, T01, T23 } = tableEncoding;
	let k = 0;
	s0 ^= xk[k++], s1 ^= xk[k++], s2 ^= xk[k++], s3 ^= xk[k++];
	const rounds = xk.length / 4 - 2;
	for (let i = 0; i < rounds; i++) {
		const t0 = xk[k++] ^ apply0123(T01, T23, s0, s1, s2, s3);
		const t1 = xk[k++] ^ apply0123(T01, T23, s1, s2, s3, s0);
		const t2 = xk[k++] ^ apply0123(T01, T23, s2, s3, s0, s1);
		const t3 = xk[k++] ^ apply0123(T01, T23, s3, s0, s1, s2);
		s0 = t0, s1 = t1, s2 = t2, s3 = t3;
	}
	return {
		s0: xk[k++] ^ applySbox(sbox2, s0, s1, s2, s3),
		s1: xk[k++] ^ applySbox(sbox2, s1, s2, s3, s0),
		s2: xk[k++] ^ applySbox(sbox2, s2, s3, s0, s1),
		s3: xk[k++] ^ applySbox(sbox2, s3, s0, s1, s2)
	};
}
function decrypt$2(xk, s0, s1, s2, s3) {
	const { sbox2, T01, T23 } = tableDecoding;
	let k = 0;
	s0 ^= xk[k++], s1 ^= xk[k++], s2 ^= xk[k++], s3 ^= xk[k++];
	const rounds = xk.length / 4 - 2;
	for (let i = 0; i < rounds; i++) {
		const t0 = xk[k++] ^ apply0123(T01, T23, s0, s3, s2, s1);
		const t1 = xk[k++] ^ apply0123(T01, T23, s1, s0, s3, s2);
		const t2 = xk[k++] ^ apply0123(T01, T23, s2, s1, s0, s3);
		const t3 = xk[k++] ^ apply0123(T01, T23, s3, s2, s1, s0);
		s0 = t0, s1 = t1, s2 = t2, s3 = t3;
	}
	return {
		s0: xk[k++] ^ applySbox(sbox2, s0, s3, s2, s1),
		s1: xk[k++] ^ applySbox(sbox2, s1, s0, s3, s2),
		s2: xk[k++] ^ applySbox(sbox2, s2, s1, s0, s3),
		s3: xk[k++] ^ applySbox(sbox2, s3, s2, s1, s0)
	};
}
function validateBlockDecrypt(data) {
	abytes(data);
	if (data.length % BLOCK_SIZE !== 0) throw new Error("aes-(cbc/ecb).decrypt ciphertext should consist of blocks with size " + BLOCK_SIZE);
}
function validateBlockEncrypt(plaintext, pcks5, dst) {
	abytes(plaintext);
	let outLen = plaintext.length;
	const remaining = outLen % BLOCK_SIZE;
	if (!pcks5 && remaining !== 0) throw new Error("aec/(cbc-ecb): unpadded plaintext with disabled padding");
	if (!isAligned32$1(plaintext)) plaintext = copyBytes(plaintext);
	const b = u32(plaintext);
	if (pcks5) {
		let left = BLOCK_SIZE - remaining;
		if (!left) left = BLOCK_SIZE;
		outLen = outLen + left;
	}
	dst = getOutput(outLen, dst);
	complexOverlapBytes(plaintext, dst);
	return {
		b,
		o: u32(dst),
		out: dst
	};
}
function validatePCKS(data, pcks5) {
	if (!pcks5) return data;
	const len = data.length;
	if (!len) throw new Error("aes/pcks5: empty ciphertext not allowed");
	const lastByte = data[len - 1];
	if (lastByte <= 0 || lastByte > 16) throw new Error("aes/pcks5: wrong padding");
	const out = data.subarray(0, -lastByte);
	for (let i = 0; i < lastByte; i++) if (data[len - i - 1] !== lastByte) throw new Error("aes/pcks5: wrong padding");
	return out;
}
function padPCKS(left) {
	const tmp = new Uint8Array(16);
	const tmp32 = u32(tmp);
	tmp.set(left);
	const paddingByte = BLOCK_SIZE - left.length;
	for (let i = BLOCK_SIZE - paddingByte; i < BLOCK_SIZE; i++) tmp[i] = paddingByte;
	return tmp32;
}
/**
* **CBC** (Cipher Block Chaining): Each plaintext block is XORed with the
* previous block of ciphertext before encryption.
* Hard to use: requires proper padding and an IV. Unauthenticated: needs MAC.
*/
const cbc = /* @__PURE__ */ wrapCipher({
	blockSize: 16,
	nonceLength: 16
}, function aescbc(key, iv, opts = {}) {
	const pcks5 = !opts.disablePadding;
	return {
		encrypt(plaintext, dst) {
			const xk = expandKeyLE(key);
			const { b, o, out: _out } = validateBlockEncrypt(plaintext, pcks5, dst);
			let _iv = iv;
			const toClean = [xk];
			if (!isAligned32$1(_iv)) toClean.push(_iv = copyBytes(_iv));
			const n32 = u32(_iv);
			let s0 = n32[0], s1 = n32[1], s2 = n32[2], s3 = n32[3];
			let i = 0;
			for (; i + 4 <= b.length;) {
				s0 ^= b[i + 0], s1 ^= b[i + 1], s2 ^= b[i + 2], s3 ^= b[i + 3];
				({s0, s1, s2, s3} = encrypt$2(xk, s0, s1, s2, s3));
				o[i++] = s0, o[i++] = s1, o[i++] = s2, o[i++] = s3;
			}
			if (pcks5) {
				const tmp32 = padPCKS(plaintext.subarray(i * 4));
				s0 ^= tmp32[0], s1 ^= tmp32[1], s2 ^= tmp32[2], s3 ^= tmp32[3];
				({s0, s1, s2, s3} = encrypt$2(xk, s0, s1, s2, s3));
				o[i++] = s0, o[i++] = s1, o[i++] = s2, o[i++] = s3;
			}
			clean(...toClean);
			return _out;
		},
		decrypt(ciphertext, dst) {
			validateBlockDecrypt(ciphertext);
			const xk = expandKeyDecLE(key);
			let _iv = iv;
			const toClean = [xk];
			if (!isAligned32$1(_iv)) toClean.push(_iv = copyBytes(_iv));
			const n32 = u32(_iv);
			dst = getOutput(ciphertext.length, dst);
			if (!isAligned32$1(ciphertext)) toClean.push(ciphertext = copyBytes(ciphertext));
			complexOverlapBytes(ciphertext, dst);
			const b = u32(ciphertext);
			const o = u32(dst);
			let s0 = n32[0], s1 = n32[1], s2 = n32[2], s3 = n32[3];
			for (let i = 0; i + 4 <= b.length;) {
				const ps0 = s0, ps1 = s1, ps2 = s2, ps3 = s3;
				s0 = b[i + 0], s1 = b[i + 1], s2 = b[i + 2], s3 = b[i + 3];
				const { s0: o0, s1: o1, s2: o2, s3: o3 } = decrypt$2(xk, s0, s1, s2, s3);
				o[i++] = o0 ^ ps0, o[i++] = o1 ^ ps1, o[i++] = o2 ^ ps2, o[i++] = o3 ^ ps3;
			}
			clean(...toClean);
			return validatePCKS(dst, pcks5);
		}
	};
});
function isBytes32(a) {
	return a instanceof Uint32Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint32Array";
}
function encryptBlock(xk, block) {
	abytes(block, 16, "block");
	if (!isBytes32(xk)) throw new Error("_encryptBlock accepts result of expandKeyLE");
	const b32 = u32(block);
	let { s0, s1, s2, s3 } = encrypt$2(xk, b32[0], b32[1], b32[2], b32[3]);
	b32[0] = s0, b32[1] = s1, b32[2] = s2, b32[3] = s3;
	return block;
}
/**
* Left-shift by one bit and conditionally XOR with 0x87:
* ```
* if MSB(L) is equal to 0
* then    K1 := L << 1;
* else    K1 := (L << 1) XOR const_Rb;
* ```
*
* Specs: [RFC 4493, Section 2.3](https://www.rfc-editor.org/rfc/rfc4493.html#section-2.3),
*        [RFC 5297 Section 2.3](https://datatracker.ietf.org/doc/html/rfc5297.html#section-2.3)
*
* @returns modified `block` (for chaining)
*/
function dbl(block) {
	let carry = 0;
	for (let i = BLOCK_SIZE - 1; i >= 0; i--) {
		const newCarry = (block[i] & 128) >>> 7;
		block[i] = block[i] << 1 | carry;
		carry = newCarry;
	}
	if (carry) block[BLOCK_SIZE - 1] ^= 135;
	return block;
}
/**
* `a XOR b`, running in-site on `a`.
* @param a left operand and output
* @param b right operand
* @returns `a` (for chaining)
*/
function xorBlock(a, b) {
	if (a.length !== b.length) throw new Error("xorBlock: blocks must have same length");
	for (let i = 0; i < a.length; i++) a[i] = a[i] ^ b[i];
	return a;
}
/**
* Internal CMAC class.
*/
var _CMAC = class {
	buffer;
	destroyed;
	k1;
	k2;
	xk;
	constructor(key) {
		abytes(key);
		validateKeyLength(key);
		this.xk = expandKeyLE(key);
		this.buffer = new Uint8Array(0);
		this.destroyed = false;
		const L = new Uint8Array(BLOCK_SIZE);
		encryptBlock(this.xk, L);
		this.k1 = dbl(L);
		this.k2 = dbl(new Uint8Array(this.k1));
	}
	update(data) {
		const { destroyed, buffer } = this;
		if (destroyed) throw new Error("CMAC instance was destroyed");
		abytes(data);
		const newBuffer = new Uint8Array(buffer.length + data.length);
		newBuffer.set(buffer);
		newBuffer.set(data, buffer.length);
		this.buffer = newBuffer;
		return this;
	}
	digest() {
		if (this.destroyed) throw new Error("CMAC instance was destroyed");
		const { buffer } = this;
		const msgLen = buffer.length;
		let n = Math.ceil(msgLen / BLOCK_SIZE);
		let flag;
		if (n === 0) {
			n = 1;
			flag = false;
		} else flag = msgLen % BLOCK_SIZE === 0;
		const lastBlockStart = (n - 1) * BLOCK_SIZE;
		const lastBlockData = buffer.subarray(lastBlockStart);
		let m_last;
		if (flag) m_last = xorBlock(new Uint8Array(lastBlockData), this.k1);
		else {
			const padded = new Uint8Array(BLOCK_SIZE);
			padded.set(lastBlockData);
			padded[lastBlockData.length] = 128;
			m_last = xorBlock(padded, this.k2);
		}
		let x = new Uint8Array(BLOCK_SIZE);
		for (let i = 0; i < n - 1; i++) {
			xorBlock(x, buffer.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE));
			encryptBlock(this.xk, x);
		}
		xorBlock(x, m_last);
		encryptBlock(this.xk, x);
		clean(m_last);
		return x;
	}
	destroy() {
		const { buffer, destroyed, xk, k1, k2 } = this;
		if (destroyed) return;
		this.destroyed = true;
		clean(buffer, xk, k1, k2);
	}
};
/**
* AES-CMAC (Cipher-based Message Authentication Code).
* Specs: [RFC 4493](https://www.rfc-editor.org/rfc/rfc4493.html).
*/
const cmac = (key, message) => new _CMAC(key).update(message).digest();
cmac.create = (key) => new _CMAC(key);
//#endregion
//#region node_modules/.pnpm/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/_arx.js
/**
* Basic utils for ARX (add-rotate-xor) salsa and chacha ciphers.

RFC8439 requires multi-step cipher stream, where
authKey starts with counter: 0, actual msg with counter: 1.

For this, we need a way to re-use nonce / counter:

const counter = new Uint8Array(4);
chacha(..., counter, ...); // counter is now 1
chacha(..., counter, ...); // counter is now 2

This is complicated:

- 32-bit counters are enough, no need for 64-bit: max ArrayBuffer size in JS is 4GB
- Original papers don't allow mutating counters
- Counter overflow is undefined [^1]
- Idea A: allow providing (nonce | counter) instead of just nonce, re-use it
- Caveat: Cannot be re-used through all cases:
- * chacha has (counter | nonce)
- * xchacha has (nonce16 | counter | nonce16)
- Idea B: separate nonce / counter and provide separate API for counter re-use
- Caveat: there are different counter sizes depending on an algorithm.
- salsa & chacha also differ in structures of key & sigma:
salsa20:      s[0] | k(4) | s[1] | nonce(2) | cnt(2) | s[2] | k(4) | s[3]
chacha:       s(4) | k(8) | cnt(1) | nonce(3)
chacha20orig: s(4) | k(8) | cnt(2) | nonce(2)
- Idea C: helper method such as `setSalsaState(key, nonce, sigma, data)`
- Caveat: we can't re-use counter array

xchacha [^2] uses the subkey and remaining 8 byte nonce with ChaCha20 as normal
(prefixed by 4 NUL bytes, since [RFC8439] specifies a 12-byte nonce).

[^1]: https://mailarchive.ietf.org/arch/msg/cfrg/gsOnTJzcbgG6OqD8Sc0GO5aR_tU/
[^2]: https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha#appendix-A.2

* @module
*/
const encodeStr = (str) => Uint8Array.from(str.split(""), (c) => c.charCodeAt(0));
const sigma16 = encodeStr("expand 16-byte k");
const sigma32 = encodeStr("expand 32-byte k");
const sigma16_32 = u32(sigma16);
const sigma32_32 = u32(sigma32);
/** Rotate left. */
function rotl(a, b) {
	return a << b | a >>> 32 - b;
}
function isAligned32(b) {
	return b.byteOffset % 4 === 0;
}
const BLOCK_LEN = 64;
const BLOCK_LEN32 = 16;
const MAX_COUNTER = 2 ** 32 - 1;
const U32_EMPTY = Uint32Array.of();
function runCipher(core, sigma, key, nonce, data, output, counter, rounds) {
	const len = data.length;
	const block = new Uint8Array(BLOCK_LEN);
	const b32 = u32(block);
	const isAligned = isAligned32(data) && isAligned32(output);
	const d32 = isAligned ? u32(data) : U32_EMPTY;
	const o32 = isAligned ? u32(output) : U32_EMPTY;
	for (let pos = 0; pos < len; counter++) {
		core(sigma, key, nonce, b32, counter, rounds);
		if (counter >= MAX_COUNTER) throw new Error("arx: counter overflow");
		const take = Math.min(BLOCK_LEN, len - pos);
		if (isAligned && take === BLOCK_LEN) {
			const pos32 = pos / 4;
			if (pos % 4 !== 0) throw new Error("arx: invalid block position");
			for (let j = 0, posj; j < BLOCK_LEN32; j++) {
				posj = pos32 + j;
				o32[posj] = d32[posj] ^ b32[j];
			}
			pos += BLOCK_LEN;
			continue;
		}
		for (let j = 0, posj; j < take; j++) {
			posj = pos + j;
			output[posj] = data[posj] ^ block[j];
		}
		pos += take;
	}
}
/** Creates ARX-like (ChaCha, Salsa) cipher stream from core function. */
function createCipher(core, opts) {
	const { allowShortKeys, extendNonceFn, counterLength, counterRight, rounds } = checkOpts({
		allowShortKeys: false,
		counterLength: 8,
		counterRight: false,
		rounds: 20
	}, opts);
	if (typeof core !== "function") throw new Error("core must be a function");
	anumber(counterLength);
	anumber(rounds);
	abool(counterRight);
	abool(allowShortKeys);
	return (key, nonce, data, output, counter = 0) => {
		abytes(key, void 0, "key");
		abytes(nonce, void 0, "nonce");
		abytes(data, void 0, "data");
		const len = data.length;
		if (output === void 0) output = new Uint8Array(len);
		abytes(output, void 0, "output");
		anumber(counter);
		if (counter < 0 || counter >= MAX_COUNTER) throw new Error("arx: counter overflow");
		if (output.length < len) throw new Error(`arx: output (${output.length}) is shorter than data (${len})`);
		const toClean = [];
		let l = key.length;
		let k;
		let sigma;
		if (l === 32) {
			toClean.push(k = copyBytes(key));
			sigma = sigma32_32;
		} else if (l === 16 && allowShortKeys) {
			k = new Uint8Array(32);
			k.set(key);
			k.set(key, 16);
			sigma = sigma16_32;
			toClean.push(k);
		} else {
			abytes(key, 32, "arx key");
			throw new Error("invalid key size");
		}
		if (!isAligned32(nonce)) toClean.push(nonce = copyBytes(nonce));
		const k32 = u32(k);
		if (extendNonceFn) {
			if (nonce.length !== 24) throw new Error(`arx: extended nonce must be 24 bytes`);
			extendNonceFn(sigma, k32, u32(nonce.subarray(0, 16)), k32);
			nonce = nonce.subarray(16);
		}
		const nonceNcLen = 16 - counterLength;
		if (nonceNcLen !== nonce.length) throw new Error(`arx: nonce must be ${nonceNcLen} or 16 bytes`);
		if (nonceNcLen !== 12) {
			const nc = new Uint8Array(12);
			nc.set(nonce, counterRight ? 0 : 12 - nonce.length);
			nonce = nc;
			toClean.push(nonce);
		}
		const n32 = u32(nonce);
		runCipher(core, sigma, k32, n32, data, output, counter, rounds);
		clean(...toClean);
		return output;
	};
}
//#endregion
//#region node_modules/.pnpm/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/_poly1305.js
/**
* Poly1305 ([PDF](https://cr.yp.to/mac/poly1305-20050329.pdf),
* [wiki](https://en.wikipedia.org/wiki/Poly1305))
* is a fast and parallel secret-key message-authentication code suitable for
* a wide variety of applications. It was standardized in
* [RFC 8439](https://www.rfc-editor.org/rfc/rfc8439) and is now used in TLS 1.3.
*
* Polynomial MACs are not perfect for every situation:
* they lack Random Key Robustness: the MAC can be forged, and can't be used in PAKE schemes.
* See [invisible salamanders attack](https://keymaterial.net/2020/09/07/invisible-salamanders-in-aes-gcm-siv/).
* To combat invisible salamanders, `hash(key)` can be included in ciphertext,
* however, this would violate ciphertext indistinguishability:
* an attacker would know which key was used - so `HKDF(key, i)`
* could be used instead.
*
* Check out [original website](https://cr.yp.to/mac.html).
* Based on Public Domain [poly1305-donna](https://github.com/floodyberry/poly1305-donna).
* @module
*/
function u8to16(a, i) {
	return a[i++] & 255 | (a[i++] & 255) << 8;
}
/** Poly1305 class. Prefer poly1305() function instead. */
var Poly1305 = class {
	blockLen = 16;
	outputLen = 16;
	buffer = new Uint8Array(16);
	r = new Uint16Array(10);
	h = new Uint16Array(10);
	pad = new Uint16Array(8);
	pos = 0;
	finished = false;
	constructor(key) {
		key = copyBytes(abytes(key, 32, "key"));
		const t0 = u8to16(key, 0);
		const t1 = u8to16(key, 2);
		const t2 = u8to16(key, 4);
		const t3 = u8to16(key, 6);
		const t4 = u8to16(key, 8);
		const t5 = u8to16(key, 10);
		const t6 = u8to16(key, 12);
		const t7 = u8to16(key, 14);
		this.r[0] = t0 & 8191;
		this.r[1] = (t0 >>> 13 | t1 << 3) & 8191;
		this.r[2] = (t1 >>> 10 | t2 << 6) & 7939;
		this.r[3] = (t2 >>> 7 | t3 << 9) & 8191;
		this.r[4] = (t3 >>> 4 | t4 << 12) & 255;
		this.r[5] = t4 >>> 1 & 8190;
		this.r[6] = (t4 >>> 14 | t5 << 2) & 8191;
		this.r[7] = (t5 >>> 11 | t6 << 5) & 8065;
		this.r[8] = (t6 >>> 8 | t7 << 8) & 8191;
		this.r[9] = t7 >>> 5 & 127;
		for (let i = 0; i < 8; i++) this.pad[i] = u8to16(key, 16 + 2 * i);
	}
	process(data, offset, isLast = false) {
		const hibit = isLast ? 0 : 2048;
		const { h, r } = this;
		const r0 = r[0];
		const r1 = r[1];
		const r2 = r[2];
		const r3 = r[3];
		const r4 = r[4];
		const r5 = r[5];
		const r6 = r[6];
		const r7 = r[7];
		const r8 = r[8];
		const r9 = r[9];
		const t0 = u8to16(data, offset + 0);
		const t1 = u8to16(data, offset + 2);
		const t2 = u8to16(data, offset + 4);
		const t3 = u8to16(data, offset + 6);
		const t4 = u8to16(data, offset + 8);
		const t5 = u8to16(data, offset + 10);
		const t6 = u8to16(data, offset + 12);
		const t7 = u8to16(data, offset + 14);
		let h0 = h[0] + (t0 & 8191);
		let h1 = h[1] + ((t0 >>> 13 | t1 << 3) & 8191);
		let h2 = h[2] + ((t1 >>> 10 | t2 << 6) & 8191);
		let h3 = h[3] + ((t2 >>> 7 | t3 << 9) & 8191);
		let h4 = h[4] + ((t3 >>> 4 | t4 << 12) & 8191);
		let h5 = h[5] + (t4 >>> 1 & 8191);
		let h6 = h[6] + ((t4 >>> 14 | t5 << 2) & 8191);
		let h7 = h[7] + ((t5 >>> 11 | t6 << 5) & 8191);
		let h8 = h[8] + ((t6 >>> 8 | t7 << 8) & 8191);
		let h9 = h[9] + (t7 >>> 5 | hibit);
		let c = 0;
		let d0 = c + h0 * r0 + h1 * (5 * r9) + h2 * (5 * r8) + h3 * (5 * r7) + h4 * (5 * r6);
		c = d0 >>> 13;
		d0 &= 8191;
		d0 += h5 * (5 * r5) + h6 * (5 * r4) + h7 * (5 * r3) + h8 * (5 * r2) + h9 * (5 * r1);
		c += d0 >>> 13;
		d0 &= 8191;
		let d1 = c + h0 * r1 + h1 * r0 + h2 * (5 * r9) + h3 * (5 * r8) + h4 * (5 * r7);
		c = d1 >>> 13;
		d1 &= 8191;
		d1 += h5 * (5 * r6) + h6 * (5 * r5) + h7 * (5 * r4) + h8 * (5 * r3) + h9 * (5 * r2);
		c += d1 >>> 13;
		d1 &= 8191;
		let d2 = c + h0 * r2 + h1 * r1 + h2 * r0 + h3 * (5 * r9) + h4 * (5 * r8);
		c = d2 >>> 13;
		d2 &= 8191;
		d2 += h5 * (5 * r7) + h6 * (5 * r6) + h7 * (5 * r5) + h8 * (5 * r4) + h9 * (5 * r3);
		c += d2 >>> 13;
		d2 &= 8191;
		let d3 = c + h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * (5 * r9);
		c = d3 >>> 13;
		d3 &= 8191;
		d3 += h5 * (5 * r8) + h6 * (5 * r7) + h7 * (5 * r6) + h8 * (5 * r5) + h9 * (5 * r4);
		c += d3 >>> 13;
		d3 &= 8191;
		let d4 = c + h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0;
		c = d4 >>> 13;
		d4 &= 8191;
		d4 += h5 * (5 * r9) + h6 * (5 * r8) + h7 * (5 * r7) + h8 * (5 * r6) + h9 * (5 * r5);
		c += d4 >>> 13;
		d4 &= 8191;
		let d5 = c + h0 * r5 + h1 * r4 + h2 * r3 + h3 * r2 + h4 * r1;
		c = d5 >>> 13;
		d5 &= 8191;
		d5 += h5 * r0 + h6 * (5 * r9) + h7 * (5 * r8) + h8 * (5 * r7) + h9 * (5 * r6);
		c += d5 >>> 13;
		d5 &= 8191;
		let d6 = c + h0 * r6 + h1 * r5 + h2 * r4 + h3 * r3 + h4 * r2;
		c = d6 >>> 13;
		d6 &= 8191;
		d6 += h5 * r1 + h6 * r0 + h7 * (5 * r9) + h8 * (5 * r8) + h9 * (5 * r7);
		c += d6 >>> 13;
		d6 &= 8191;
		let d7 = c + h0 * r7 + h1 * r6 + h2 * r5 + h3 * r4 + h4 * r3;
		c = d7 >>> 13;
		d7 &= 8191;
		d7 += h5 * r2 + h6 * r1 + h7 * r0 + h8 * (5 * r9) + h9 * (5 * r8);
		c += d7 >>> 13;
		d7 &= 8191;
		let d8 = c + h0 * r8 + h1 * r7 + h2 * r6 + h3 * r5 + h4 * r4;
		c = d8 >>> 13;
		d8 &= 8191;
		d8 += h5 * r3 + h6 * r2 + h7 * r1 + h8 * r0 + h9 * (5 * r9);
		c += d8 >>> 13;
		d8 &= 8191;
		let d9 = c + h0 * r9 + h1 * r8 + h2 * r7 + h3 * r6 + h4 * r5;
		c = d9 >>> 13;
		d9 &= 8191;
		d9 += h5 * r4 + h6 * r3 + h7 * r2 + h8 * r1 + h9 * r0;
		c += d9 >>> 13;
		d9 &= 8191;
		c = (c << 2) + c | 0;
		c = c + d0 | 0;
		d0 = c & 8191;
		c = c >>> 13;
		d1 += c;
		h[0] = d0;
		h[1] = d1;
		h[2] = d2;
		h[3] = d3;
		h[4] = d4;
		h[5] = d5;
		h[6] = d6;
		h[7] = d7;
		h[8] = d8;
		h[9] = d9;
	}
	finalize() {
		const { h, pad } = this;
		const g = new Uint16Array(10);
		let c = h[1] >>> 13;
		h[1] &= 8191;
		for (let i = 2; i < 10; i++) {
			h[i] += c;
			c = h[i] >>> 13;
			h[i] &= 8191;
		}
		h[0] += c * 5;
		c = h[0] >>> 13;
		h[0] &= 8191;
		h[1] += c;
		c = h[1] >>> 13;
		h[1] &= 8191;
		h[2] += c;
		g[0] = h[0] + 5;
		c = g[0] >>> 13;
		g[0] &= 8191;
		for (let i = 1; i < 10; i++) {
			g[i] = h[i] + c;
			c = g[i] >>> 13;
			g[i] &= 8191;
		}
		g[9] -= 8192;
		let mask = (c ^ 1) - 1;
		for (let i = 0; i < 10; i++) g[i] &= mask;
		mask = ~mask;
		for (let i = 0; i < 10; i++) h[i] = h[i] & mask | g[i];
		h[0] = (h[0] | h[1] << 13) & 65535;
		h[1] = (h[1] >>> 3 | h[2] << 10) & 65535;
		h[2] = (h[2] >>> 6 | h[3] << 7) & 65535;
		h[3] = (h[3] >>> 9 | h[4] << 4) & 65535;
		h[4] = (h[4] >>> 12 | h[5] << 1 | h[6] << 14) & 65535;
		h[5] = (h[6] >>> 2 | h[7] << 11) & 65535;
		h[6] = (h[7] >>> 5 | h[8] << 8) & 65535;
		h[7] = (h[8] >>> 8 | h[9] << 5) & 65535;
		let f = h[0] + pad[0];
		h[0] = f & 65535;
		for (let i = 1; i < 8; i++) {
			f = (h[i] + pad[i] | 0) + (f >>> 16) | 0;
			h[i] = f & 65535;
		}
		clean(g);
	}
	update(data) {
		aexists(this);
		abytes(data);
		data = copyBytes(data);
		const { buffer, blockLen } = this;
		const len = data.length;
		for (let pos = 0; pos < len;) {
			const take = Math.min(blockLen - this.pos, len - pos);
			if (take === blockLen) {
				for (; blockLen <= len - pos; pos += blockLen) this.process(data, pos);
				continue;
			}
			buffer.set(data.subarray(pos, pos + take), this.pos);
			this.pos += take;
			pos += take;
			if (this.pos === blockLen) {
				this.process(buffer, 0, false);
				this.pos = 0;
			}
		}
		return this;
	}
	destroy() {
		clean(this.h, this.r, this.buffer, this.pad);
	}
	digestInto(out) {
		aexists(this);
		aoutput(out, this);
		this.finished = true;
		const { buffer, h } = this;
		let { pos } = this;
		if (pos) {
			buffer[pos++] = 1;
			for (; pos < 16; pos++) buffer[pos] = 0;
			this.process(buffer, 0, true);
		}
		this.finalize();
		let opos = 0;
		for (let i = 0; i < 8; i++) {
			out[opos++] = h[i] >>> 0;
			out[opos++] = h[i] >>> 8;
		}
		return out;
	}
	digest() {
		const { buffer, outputLen } = this;
		this.digestInto(buffer);
		const res = buffer.slice(0, outputLen);
		this.destroy();
		return res;
	}
};
function wrapConstructorWithKey(hashCons) {
	const hashC = (msg, key) => hashCons(key).update(msg).digest();
	const tmp = hashCons(new Uint8Array(32));
	hashC.outputLen = tmp.outputLen;
	hashC.blockLen = tmp.blockLen;
	hashC.create = (key) => hashCons(key);
	return hashC;
}
/** Poly1305 MAC from RFC 8439. */
const poly1305 = wrapConstructorWithKey((key) => new Poly1305(key));
//#endregion
//#region node_modules/.pnpm/@noble+ciphers@2.1.1/node_modules/@noble/ciphers/chacha.js
/**
* ChaCha stream cipher, released
* in 2008. Developed after Salsa20, ChaCha aims to increase diffusion per round.
* It was standardized in [RFC 8439](https://www.rfc-editor.org/rfc/rfc8439) and
* is now used in TLS 1.3.
*
* [XChaCha20](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha)
* extended-nonce variant is also provided. Similar to XSalsa, it's safe to use with
* randomly-generated nonces.
*
* Check out [PDF](http://cr.yp.to/chacha/chacha-20080128.pdf) and
* [wiki](https://en.wikipedia.org/wiki/Salsa20) and
* [website](https://cr.yp.to/chacha.html).
*
* @module
*/
/** Identical to `chachaCore_small`. Unused. */
function chachaCore(s, k, n, out, cnt, rounds = 20) {
	let y00 = s[0], y01 = s[1], y02 = s[2], y03 = s[3], y04 = k[0], y05 = k[1], y06 = k[2], y07 = k[3], y08 = k[4], y09 = k[5], y10 = k[6], y11 = k[7], y12 = cnt, y13 = n[0], y14 = n[1], y15 = n[2];
	let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
	for (let r = 0; r < rounds; r += 2) {
		x00 = x00 + x04 | 0;
		x12 = rotl(x12 ^ x00, 16);
		x08 = x08 + x12 | 0;
		x04 = rotl(x04 ^ x08, 12);
		x00 = x00 + x04 | 0;
		x12 = rotl(x12 ^ x00, 8);
		x08 = x08 + x12 | 0;
		x04 = rotl(x04 ^ x08, 7);
		x01 = x01 + x05 | 0;
		x13 = rotl(x13 ^ x01, 16);
		x09 = x09 + x13 | 0;
		x05 = rotl(x05 ^ x09, 12);
		x01 = x01 + x05 | 0;
		x13 = rotl(x13 ^ x01, 8);
		x09 = x09 + x13 | 0;
		x05 = rotl(x05 ^ x09, 7);
		x02 = x02 + x06 | 0;
		x14 = rotl(x14 ^ x02, 16);
		x10 = x10 + x14 | 0;
		x06 = rotl(x06 ^ x10, 12);
		x02 = x02 + x06 | 0;
		x14 = rotl(x14 ^ x02, 8);
		x10 = x10 + x14 | 0;
		x06 = rotl(x06 ^ x10, 7);
		x03 = x03 + x07 | 0;
		x15 = rotl(x15 ^ x03, 16);
		x11 = x11 + x15 | 0;
		x07 = rotl(x07 ^ x11, 12);
		x03 = x03 + x07 | 0;
		x15 = rotl(x15 ^ x03, 8);
		x11 = x11 + x15 | 0;
		x07 = rotl(x07 ^ x11, 7);
		x00 = x00 + x05 | 0;
		x15 = rotl(x15 ^ x00, 16);
		x10 = x10 + x15 | 0;
		x05 = rotl(x05 ^ x10, 12);
		x00 = x00 + x05 | 0;
		x15 = rotl(x15 ^ x00, 8);
		x10 = x10 + x15 | 0;
		x05 = rotl(x05 ^ x10, 7);
		x01 = x01 + x06 | 0;
		x12 = rotl(x12 ^ x01, 16);
		x11 = x11 + x12 | 0;
		x06 = rotl(x06 ^ x11, 12);
		x01 = x01 + x06 | 0;
		x12 = rotl(x12 ^ x01, 8);
		x11 = x11 + x12 | 0;
		x06 = rotl(x06 ^ x11, 7);
		x02 = x02 + x07 | 0;
		x13 = rotl(x13 ^ x02, 16);
		x08 = x08 + x13 | 0;
		x07 = rotl(x07 ^ x08, 12);
		x02 = x02 + x07 | 0;
		x13 = rotl(x13 ^ x02, 8);
		x08 = x08 + x13 | 0;
		x07 = rotl(x07 ^ x08, 7);
		x03 = x03 + x04 | 0;
		x14 = rotl(x14 ^ x03, 16);
		x09 = x09 + x14 | 0;
		x04 = rotl(x04 ^ x09, 12);
		x03 = x03 + x04 | 0;
		x14 = rotl(x14 ^ x03, 8);
		x09 = x09 + x14 | 0;
		x04 = rotl(x04 ^ x09, 7);
	}
	let oi = 0;
	out[oi++] = y00 + x00 | 0;
	out[oi++] = y01 + x01 | 0;
	out[oi++] = y02 + x02 | 0;
	out[oi++] = y03 + x03 | 0;
	out[oi++] = y04 + x04 | 0;
	out[oi++] = y05 + x05 | 0;
	out[oi++] = y06 + x06 | 0;
	out[oi++] = y07 + x07 | 0;
	out[oi++] = y08 + x08 | 0;
	out[oi++] = y09 + x09 | 0;
	out[oi++] = y10 + x10 | 0;
	out[oi++] = y11 + x11 | 0;
	out[oi++] = y12 + x12 | 0;
	out[oi++] = y13 + x13 | 0;
	out[oi++] = y14 + x14 | 0;
	out[oi++] = y15 + x15 | 0;
}
/**
* hchacha hashes key and nonce into key' and nonce' for xchacha20.
* Identical to `hchacha_small`.
* Need to find a way to merge it with `chachaCore` without 25% performance hit.
*/
function hchacha(s, k, i, out) {
	let x00 = s[0], x01 = s[1], x02 = s[2], x03 = s[3], x04 = k[0], x05 = k[1], x06 = k[2], x07 = k[3], x08 = k[4], x09 = k[5], x10 = k[6], x11 = k[7], x12 = i[0], x13 = i[1], x14 = i[2], x15 = i[3];
	for (let r = 0; r < 20; r += 2) {
		x00 = x00 + x04 | 0;
		x12 = rotl(x12 ^ x00, 16);
		x08 = x08 + x12 | 0;
		x04 = rotl(x04 ^ x08, 12);
		x00 = x00 + x04 | 0;
		x12 = rotl(x12 ^ x00, 8);
		x08 = x08 + x12 | 0;
		x04 = rotl(x04 ^ x08, 7);
		x01 = x01 + x05 | 0;
		x13 = rotl(x13 ^ x01, 16);
		x09 = x09 + x13 | 0;
		x05 = rotl(x05 ^ x09, 12);
		x01 = x01 + x05 | 0;
		x13 = rotl(x13 ^ x01, 8);
		x09 = x09 + x13 | 0;
		x05 = rotl(x05 ^ x09, 7);
		x02 = x02 + x06 | 0;
		x14 = rotl(x14 ^ x02, 16);
		x10 = x10 + x14 | 0;
		x06 = rotl(x06 ^ x10, 12);
		x02 = x02 + x06 | 0;
		x14 = rotl(x14 ^ x02, 8);
		x10 = x10 + x14 | 0;
		x06 = rotl(x06 ^ x10, 7);
		x03 = x03 + x07 | 0;
		x15 = rotl(x15 ^ x03, 16);
		x11 = x11 + x15 | 0;
		x07 = rotl(x07 ^ x11, 12);
		x03 = x03 + x07 | 0;
		x15 = rotl(x15 ^ x03, 8);
		x11 = x11 + x15 | 0;
		x07 = rotl(x07 ^ x11, 7);
		x00 = x00 + x05 | 0;
		x15 = rotl(x15 ^ x00, 16);
		x10 = x10 + x15 | 0;
		x05 = rotl(x05 ^ x10, 12);
		x00 = x00 + x05 | 0;
		x15 = rotl(x15 ^ x00, 8);
		x10 = x10 + x15 | 0;
		x05 = rotl(x05 ^ x10, 7);
		x01 = x01 + x06 | 0;
		x12 = rotl(x12 ^ x01, 16);
		x11 = x11 + x12 | 0;
		x06 = rotl(x06 ^ x11, 12);
		x01 = x01 + x06 | 0;
		x12 = rotl(x12 ^ x01, 8);
		x11 = x11 + x12 | 0;
		x06 = rotl(x06 ^ x11, 7);
		x02 = x02 + x07 | 0;
		x13 = rotl(x13 ^ x02, 16);
		x08 = x08 + x13 | 0;
		x07 = rotl(x07 ^ x08, 12);
		x02 = x02 + x07 | 0;
		x13 = rotl(x13 ^ x02, 8);
		x08 = x08 + x13 | 0;
		x07 = rotl(x07 ^ x08, 7);
		x03 = x03 + x04 | 0;
		x14 = rotl(x14 ^ x03, 16);
		x09 = x09 + x14 | 0;
		x04 = rotl(x04 ^ x09, 12);
		x03 = x03 + x04 | 0;
		x14 = rotl(x14 ^ x03, 8);
		x09 = x09 + x14 | 0;
		x04 = rotl(x04 ^ x09, 7);
	}
	let oi = 0;
	out[oi++] = x00;
	out[oi++] = x01;
	out[oi++] = x02;
	out[oi++] = x03;
	out[oi++] = x12;
	out[oi++] = x13;
	out[oi++] = x14;
	out[oi++] = x15;
}
/**
* ChaCha stream cipher. Conforms to RFC 8439 (IETF, TLS). 12-byte nonce, 4-byte counter.
* With smaller nonce, it's not safe to make it random (CSPRNG), due to collision chance.
*/
const chacha20 = /* @__PURE__ */ createCipher(chachaCore, {
	counterRight: false,
	counterLength: 4,
	allowShortKeys: false
});
/**
* XChaCha eXtended-nonce ChaCha. With 24-byte nonce, it's safe to make it random (CSPRNG).
* See [IRTF draft](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha).
*/
const xchacha20 = /* @__PURE__ */ createCipher(chachaCore, {
	counterRight: false,
	counterLength: 8,
	extendNonceFn: hchacha,
	allowShortKeys: false
});
const ZEROS16 = /* @__PURE__ */ new Uint8Array(16);
const updatePadded = (h, msg) => {
	h.update(msg);
	const leftover = msg.length % 16;
	if (leftover) h.update(ZEROS16.subarray(leftover));
};
const ZEROS32 = /* @__PURE__ */ new Uint8Array(32);
function computeTag(fn, key, nonce, ciphertext, AAD) {
	if (AAD !== void 0) abytes(AAD, void 0, "AAD");
	const authKey = fn(key, nonce, ZEROS32);
	const lengths = u64Lengths(ciphertext.length, AAD ? AAD.length : 0, true);
	const h = poly1305.create(authKey);
	if (AAD) updatePadded(h, AAD);
	updatePadded(h, ciphertext);
	h.update(lengths);
	const res = h.digest();
	clean(authKey, lengths);
	return res;
}
/**
* AEAD algorithm from RFC 8439.
* Salsa20 and chacha (RFC 8439) use poly1305 differently.
* We could have composed them, but it's hard because of authKey:
* In salsa20, authKey changes position in salsa stream.
* In chacha, authKey can't be computed inside computeTag, it modifies the counter.
*/
const _poly1305_aead = (xorStream) => (key, nonce, AAD) => {
	const tagLength = 16;
	return {
		encrypt(plaintext, output) {
			const plength = plaintext.length;
			output = getOutput(plength + tagLength, output, false);
			output.set(plaintext);
			const oPlain = output.subarray(0, -tagLength);
			xorStream(key, nonce, oPlain, oPlain, 1);
			const tag = computeTag(xorStream, key, nonce, oPlain, AAD);
			output.set(tag, plength);
			clean(tag);
			return output;
		},
		decrypt(ciphertext, output) {
			output = getOutput(ciphertext.length - tagLength, output, false);
			const data = ciphertext.subarray(0, -tagLength);
			const passedTag = ciphertext.subarray(-tagLength);
			const tag = computeTag(xorStream, key, nonce, data, AAD);
			if (!equalBytes(passedTag, tag)) throw new Error("invalid tag");
			output.set(ciphertext.subarray(0, -tagLength));
			xorStream(key, nonce, output, output, 1);
			clean(tag);
			return output;
		}
	};
};
_poly1305_aead(chacha20);
_poly1305_aead(xchacha20);
//#endregion
//#region node_modules/.pnpm/@noble+hashes@2.0.1/node_modules/@noble/hashes/hkdf.js
/**
* HKDF (RFC 5869): extract + expand in one step.
* See https://soatok.blog/2021/11/17/understanding-hkdf/.
* @module
*/
/**
* HKDF-extract from spec. Less important part. `HKDF-Extract(IKM, salt) -> PRK`
* Arguments position differs from spec (IKM is first one, since it is not optional)
* @param hash - hash function that would be used (e.g. sha256)
* @param ikm - input keying material, the initial key
* @param salt - optional salt value (a non-secret random value)
*/
function extract(hash, ikm, salt) {
	ahash(hash);
	if (salt === void 0) salt = new Uint8Array(hash.outputLen);
	return hmac(hash, salt, ikm);
}
const HKDF_COUNTER = /* @__PURE__ */ Uint8Array.of(0);
const EMPTY_BUFFER = /* @__PURE__ */ Uint8Array.of();
/**
* HKDF-expand from the spec. The most important part. `HKDF-Expand(PRK, info, L) -> OKM`
* @param hash - hash function that would be used (e.g. sha256)
* @param prk - a pseudorandom key of at least HashLen octets (usually, the output from the extract step)
* @param info - optional context and application specific information (can be a zero-length string)
* @param length - length of output keying material in bytes
*/
function expand(hash, prk, info, length = 32) {
	ahash(hash);
	anumber$2(length, "length");
	const olen = hash.outputLen;
	if (length > 255 * olen) throw new Error("Length must be <= 255*HashLen");
	const blocks = Math.ceil(length / olen);
	if (info === void 0) info = EMPTY_BUFFER;
	else abytes$2(info, void 0, "info");
	const okm = new Uint8Array(blocks * olen);
	const HMAC = hmac.create(hash, prk);
	const HMACTmp = HMAC._cloneInto();
	const T = new Uint8Array(HMAC.outputLen);
	for (let counter = 0; counter < blocks; counter++) {
		HKDF_COUNTER[0] = counter + 1;
		HMACTmp.update(counter === 0 ? EMPTY_BUFFER : T).update(info).update(HKDF_COUNTER).digestInto(T);
		okm.set(T, olen * counter);
		HMAC._cloneInto(HMACTmp);
	}
	HMAC.destroy();
	HMACTmp.destroy();
	clean$1(T, HKDF_COUNTER);
	return okm.slice(0, length);
}
//#endregion
//#region node_modules/.pnpm/nostr-tools@2.23.3_typescript@5.9.3/node_modules/nostr-tools/lib/esm/index.js
var __defProp = Object.defineProperty;
var __export = (target, all) => {
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
};
var verifiedSymbol = Symbol("verified");
var isRecord = (obj) => obj instanceof Object;
function validateEvent(event) {
	if (!isRecord(event)) return false;
	if (typeof event.kind !== "number") return false;
	if (typeof event.content !== "string") return false;
	if (typeof event.created_at !== "number") return false;
	if (typeof event.pubkey !== "string") return false;
	if (!event.pubkey.match(/^[a-f0-9]{64}$/)) return false;
	if (!Array.isArray(event.tags)) return false;
	for (let i2 = 0; i2 < event.tags.length; i2++) {
		let tag = event.tags[i2];
		if (!Array.isArray(tag)) return false;
		for (let j = 0; j < tag.length; j++) if (typeof tag[j] !== "string") return false;
	}
	return true;
}
__export({}, {
	binarySearch: () => binarySearch,
	bytesToHex: () => bytesToHex,
	hexToBytes: () => hexToBytes,
	insertEventIntoAscendingList: () => insertEventIntoAscendingList,
	insertEventIntoDescendingList: () => insertEventIntoDescendingList,
	mergeReverseSortedLists: () => mergeReverseSortedLists,
	normalizeURL: () => normalizeURL,
	utf8Decoder: () => utf8Decoder$1,
	utf8Encoder: () => utf8Encoder$1
});
var utf8Decoder$1 = new TextDecoder("utf-8");
var utf8Encoder$1 = new TextEncoder();
function normalizeURL(url) {
	try {
		if (url.indexOf("://") === -1) url = "wss://" + url;
		let p = new URL(url);
		if (p.protocol === "http:") p.protocol = "ws:";
		else if (p.protocol === "https:") p.protocol = "wss:";
		p.pathname = p.pathname.replace(/\/+/g, "/");
		if (p.pathname.endsWith("/")) p.pathname = p.pathname.slice(0, -1);
		if (p.port === "80" && p.protocol === "ws:" || p.port === "443" && p.protocol === "wss:") p.port = "";
		p.searchParams.sort();
		p.hash = "";
		return p.toString();
	} catch (e) {
		throw new Error(`Invalid URL: ${url}`);
	}
}
function insertEventIntoDescendingList(sortedArray, event) {
	const [idx, found] = binarySearch(sortedArray, (b) => {
		if (event.id === b.id) return 0;
		if (event.created_at === b.created_at) return -1;
		return b.created_at - event.created_at;
	});
	if (!found) sortedArray.splice(idx, 0, event);
	return sortedArray;
}
function insertEventIntoAscendingList(sortedArray, event) {
	const [idx, found] = binarySearch(sortedArray, (b) => {
		if (event.id === b.id) return 0;
		if (event.created_at === b.created_at) return -1;
		return event.created_at - b.created_at;
	});
	if (!found) sortedArray.splice(idx, 0, event);
	return sortedArray;
}
function binarySearch(arr, compare) {
	let start = 0;
	let end = arr.length - 1;
	while (start <= end) {
		const mid = Math.floor((start + end) / 2);
		const cmp = compare(arr[mid]);
		if (cmp === 0) return [mid, true];
		if (cmp < 0) end = mid - 1;
		else start = mid + 1;
	}
	return [start, false];
}
function mergeReverseSortedLists(list1, list2) {
	const result = new Array(list1.length + list2.length);
	result.length = 0;
	let i1 = 0;
	let i2 = 0;
	let sameTimestampIds = [];
	while (i1 < list1.length && i2 < list2.length) {
		let next;
		if (list1[i1]?.created_at > list2[i2]?.created_at) {
			next = list1[i1];
			i1++;
		} else {
			next = list2[i2];
			i2++;
		}
		if (result.length > 0 && result[result.length - 1].created_at === next.created_at) {
			if (sameTimestampIds.includes(next.id)) continue;
		} else sameTimestampIds.length = 0;
		result.push(next);
		sameTimestampIds.push(next.id);
	}
	while (i1 < list1.length) {
		const next = list1[i1];
		i1++;
		if (result.length > 0 && result[result.length - 1].created_at === next.created_at) {
			if (sameTimestampIds.includes(next.id)) continue;
		} else sameTimestampIds.length = 0;
		result.push(next);
		sameTimestampIds.push(next.id);
	}
	while (i2 < list2.length) {
		const next = list2[i2];
		i2++;
		if (result.length > 0 && result[result.length - 1].created_at === next.created_at) {
			if (sameTimestampIds.includes(next.id)) continue;
		} else sameTimestampIds.length = 0;
		result.push(next);
		sameTimestampIds.push(next.id);
	}
	return result;
}
var JS = class {
	generateSecretKey() {
		return schnorr.utils.randomSecretKey();
	}
	getPublicKey(secretKey) {
		return bytesToHex(schnorr.getPublicKey(secretKey));
	}
	finalizeEvent(t, secretKey) {
		const event = t;
		event.pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
		event.id = getEventHash(event);
		event.sig = bytesToHex(schnorr.sign(hexToBytes(getEventHash(event)), secretKey));
		event[verifiedSymbol] = true;
		return event;
	}
	verifyEvent(event) {
		if (typeof event[verifiedSymbol] === "boolean") return event[verifiedSymbol];
		try {
			const hash = getEventHash(event);
			if (hash !== event.id) {
				event[verifiedSymbol] = false;
				return false;
			}
			const valid = schnorr.verify(hexToBytes(event.sig), hexToBytes(hash), hexToBytes(event.pubkey));
			event[verifiedSymbol] = valid;
			return valid;
		} catch (err) {
			event[verifiedSymbol] = false;
			return false;
		}
	}
};
function serializeEvent(evt) {
	if (!validateEvent(evt)) throw new Error("can't serialize event with wrong or missing properties");
	return JSON.stringify([
		0,
		evt.pubkey,
		evt.created_at,
		evt.kind,
		evt.tags,
		evt.content
	]);
}
function getEventHash(event) {
	return bytesToHex(sha256(utf8Encoder$1.encode(serializeEvent(event))));
}
var i = new JS();
var generateSecretKey = i.generateSecretKey;
var getPublicKey = i.getPublicKey;
var finalizeEvent = i.finalizeEvent;
var verifyEvent = i.verifyEvent;
__export({}, {
	Application: () => Application,
	BadgeAward: () => BadgeAward,
	BadgeDefinition: () => BadgeDefinition,
	BlockedRelaysList: () => BlockedRelaysList,
	BlossomServerList: () => BlossomServerList,
	BookmarkList: () => BookmarkList,
	Bookmarksets: () => Bookmarksets,
	Calendar: () => Calendar,
	CalendarEventRSVP: () => CalendarEventRSVP,
	ChannelCreation: () => ChannelCreation,
	ChannelHideMessage: () => ChannelHideMessage,
	ChannelMessage: () => ChannelMessage,
	ChannelMetadata: () => ChannelMetadata,
	ChannelMuteUser: () => ChannelMuteUser,
	ChatMessage: () => ChatMessage,
	ClassifiedListing: () => ClassifiedListing,
	ClientAuth: () => ClientAuth,
	Comment: () => Comment,
	CommunitiesList: () => CommunitiesList,
	CommunityDefinition: () => CommunityDefinition,
	CommunityPostApproval: () => CommunityPostApproval,
	Contacts: () => Contacts,
	CreateOrUpdateProduct: () => CreateOrUpdateProduct,
	CreateOrUpdateStall: () => CreateOrUpdateStall,
	Curationsets: () => Curationsets,
	Date: () => Date2,
	DirectMessageRelaysList: () => DirectMessageRelaysList,
	DraftClassifiedListing: () => DraftClassifiedListing,
	DraftLong: () => DraftLong,
	Emojisets: () => Emojisets,
	EncryptedDirectMessage: () => EncryptedDirectMessage,
	EventDeletion: () => EventDeletion,
	FavoriteRelays: () => FavoriteRelays,
	FileMessage: () => FileMessage,
	FileMetadata: () => FileMetadata,
	FileServerPreference: () => FileServerPreference,
	Followsets: () => Followsets,
	ForumThread: () => ForumThread,
	GenericRepost: () => GenericRepost,
	Genericlists: () => Genericlists,
	GiftWrap: () => GiftWrap,
	GroupMetadata: () => GroupMetadata,
	HTTPAuth: () => HTTPAuth,
	Handlerinformation: () => Handlerinformation,
	Handlerrecommendation: () => Handlerrecommendation,
	Highlights: () => Highlights,
	InterestsList: () => InterestsList,
	Interestsets: () => Interestsets,
	JobFeedback: () => JobFeedback,
	JobRequest: () => JobRequest,
	JobResult: () => JobResult,
	Label: () => Label,
	LightningPubRPC: () => LightningPubRPC,
	LiveChatMessage: () => LiveChatMessage,
	LiveEvent: () => LiveEvent,
	LongFormArticle: () => LongFormArticle,
	Metadata: () => Metadata,
	Mutelist: () => Mutelist,
	NWCWalletInfo: () => NWCWalletInfo,
	NWCWalletRequest: () => NWCWalletRequest,
	NWCWalletResponse: () => NWCWalletResponse,
	NormalVideo: () => NormalVideo,
	NostrConnect: () => NostrConnect,
	OpenTimestamps: () => OpenTimestamps,
	Photo: () => Photo,
	Pinlist: () => Pinlist,
	Poll: () => Poll,
	PollResponse: () => PollResponse,
	PrivateDirectMessage: () => PrivateDirectMessage,
	ProblemTracker: () => ProblemTracker,
	ProfileBadges: () => ProfileBadges,
	PublicChatsList: () => PublicChatsList,
	Reaction: () => Reaction,
	RecommendRelay: () => RecommendRelay,
	RelayList: () => RelayList,
	RelayReview: () => RelayReview,
	Relaysets: () => Relaysets,
	Report: () => Report,
	Reporting: () => Reporting,
	Repost: () => Repost,
	Seal: () => Seal,
	SearchRelaysList: () => SearchRelaysList,
	ShortTextNote: () => ShortTextNote,
	ShortVideo: () => ShortVideo,
	Time: () => Time,
	UserEmojiList: () => UserEmojiList,
	UserStatuses: () => UserStatuses,
	Voice: () => Voice,
	VoiceComment: () => VoiceComment,
	Zap: () => Zap,
	ZapGoal: () => ZapGoal,
	ZapRequest: () => ZapRequest,
	classifyKind: () => classifyKind,
	isAddressableKind: () => isAddressableKind,
	isEphemeralKind: () => isEphemeralKind,
	isKind: () => isKind,
	isRegularKind: () => isRegularKind,
	isReplaceableKind: () => isReplaceableKind
});
function isRegularKind(kind) {
	return kind < 1e4 && kind !== 0 && kind !== 3;
}
function isReplaceableKind(kind) {
	return kind === 0 || kind === 3 || 1e4 <= kind && kind < 2e4;
}
function isEphemeralKind(kind) {
	return 2e4 <= kind && kind < 3e4;
}
function isAddressableKind(kind) {
	return 3e4 <= kind && kind < 4e4;
}
function classifyKind(kind) {
	if (isRegularKind(kind)) return "regular";
	if (isReplaceableKind(kind)) return "replaceable";
	if (isEphemeralKind(kind)) return "ephemeral";
	if (isAddressableKind(kind)) return "parameterized";
	return "unknown";
}
function isKind(event, kind) {
	const kindAsArray = kind instanceof Array ? kind : [kind];
	return validateEvent(event) && kindAsArray.includes(event.kind) || false;
}
var Metadata = 0;
var ShortTextNote = 1;
var RecommendRelay = 2;
var Contacts = 3;
var EncryptedDirectMessage = 4;
var EventDeletion = 5;
var Repost = 6;
var Reaction = 7;
var BadgeAward = 8;
var ChatMessage = 9;
var ForumThread = 11;
var Seal = 13;
var PrivateDirectMessage = 14;
var FileMessage = 15;
var GenericRepost = 16;
var Photo = 20;
var NormalVideo = 21;
var ShortVideo = 22;
var ChannelCreation = 40;
var ChannelMetadata = 41;
var ChannelMessage = 42;
var ChannelHideMessage = 43;
var ChannelMuteUser = 44;
var OpenTimestamps = 1040;
var GiftWrap = 1059;
var Poll = 1068;
var FileMetadata = 1063;
var Comment = 1111;
var LiveChatMessage = 1311;
var Voice = 1222;
var VoiceComment = 1244;
var ProblemTracker = 1971;
var Report = 1984;
var Reporting = 1984;
var Label = 1985;
var CommunityPostApproval = 4550;
var JobRequest = 5999;
var JobResult = 6999;
var JobFeedback = 7e3;
var ZapGoal = 9041;
var ZapRequest = 9734;
var Zap = 9735;
var Highlights = 9802;
var PollResponse = 1018;
var Mutelist = 1e4;
var Pinlist = 10001;
var RelayList = 10002;
var BookmarkList = 10003;
var CommunitiesList = 10004;
var PublicChatsList = 10005;
var BlockedRelaysList = 10006;
var SearchRelaysList = 10007;
var FavoriteRelays = 10012;
var InterestsList = 10015;
var UserEmojiList = 10030;
var DirectMessageRelaysList = 10050;
var FileServerPreference = 10096;
var BlossomServerList = 10063;
var NWCWalletInfo = 13194;
var LightningPubRPC = 21e3;
var ClientAuth = 22242;
var NWCWalletRequest = 23194;
var NWCWalletResponse = 23195;
var NostrConnect = 24133;
var HTTPAuth = 27235;
var Followsets = 3e4;
var Genericlists = 30001;
var Relaysets = 30002;
var Bookmarksets = 30003;
var Curationsets = 30004;
var ProfileBadges = 30008;
var BadgeDefinition = 30009;
var Interestsets = 30015;
var CreateOrUpdateStall = 30017;
var CreateOrUpdateProduct = 30018;
var LongFormArticle = 30023;
var DraftLong = 30024;
var Emojisets = 30030;
var Application = 30078;
var LiveEvent = 30311;
var UserStatuses = 30315;
var ClassifiedListing = 30402;
var DraftClassifiedListing = 30403;
var Date2 = 31922;
var Time = 31923;
var Calendar = 31924;
var CalendarEventRSVP = 31925;
var RelayReview = 31987;
var Handlerrecommendation = 31989;
var Handlerinformation = 31990;
var CommunityDefinition = 34550;
var GroupMetadata = 39e3;
function matchFilter(filter, event) {
	if (filter.ids && filter.ids.indexOf(event.id) === -1) return false;
	if (filter.kinds && filter.kinds.indexOf(event.kind) === -1) return false;
	if (filter.authors && filter.authors.indexOf(event.pubkey) === -1) return false;
	for (let f in filter) if (f[0] === "#") {
		let values = filter[`#${f.slice(1)}`];
		if (values && !event.tags.find(([t, v]) => t === f.slice(1) && values.indexOf(v) !== -1)) return false;
	}
	if (filter.since && event.created_at < filter.since) return false;
	if (filter.until && event.created_at > filter.until) return false;
	return true;
}
function matchFilters(filters, event) {
	for (let i2 = 0; i2 < filters.length; i2++) if (matchFilter(filters[i2], event)) return true;
	return false;
}
__export({}, {
	getHex64: () => getHex64,
	getInt: () => getInt,
	getSubscriptionId: () => getSubscriptionId,
	matchEventId: () => matchEventId,
	matchEventKind: () => matchEventKind,
	matchEventPubkey: () => matchEventPubkey
});
function getHex64(json, field) {
	let len = field.length + 3;
	let idx = json.indexOf(`"${field}":`) + len;
	let s = json.slice(idx).indexOf(`"`) + idx + 1;
	return json.slice(s, s + 64);
}
function getInt(json, field) {
	let len = field.length;
	let idx = json.indexOf(`"${field}":`) + len + 3;
	let sliced = json.slice(idx);
	let end = Math.min(sliced.indexOf(","), sliced.indexOf("}"));
	return parseInt(sliced.slice(0, end), 10);
}
function getSubscriptionId(json) {
	let idx = json.slice(0, 22).indexOf(`"EVENT"`);
	if (idx === -1) return null;
	let pstart = json.slice(idx + 7 + 1).indexOf(`"`);
	if (pstart === -1) return null;
	let start = idx + 7 + 1 + pstart;
	let pend = json.slice(start + 1, 80).indexOf(`"`);
	if (pend === -1) return null;
	let end = start + 1 + pend;
	return json.slice(start + 1, end);
}
function matchEventId(json, id) {
	return id === getHex64(json, "id");
}
function matchEventPubkey(json, pubkey) {
	return pubkey === getHex64(json, "pubkey");
}
function matchEventKind(json, kind) {
	return kind === getInt(json, "kind");
}
__export({}, { makeAuthEvent: () => makeAuthEvent });
function makeAuthEvent(relayURL, challenge) {
	return {
		kind: ClientAuth,
		created_at: Math.floor(Date.now() / 1e3),
		tags: [["relay", relayURL], ["challenge", challenge]],
		content: ""
	};
}
var SendingOnClosedConnection = class extends Error {
	constructor(message, relay) {
		super(`Tried to send message '${message} on a closed connection to ${relay}.`);
		this.name = "SendingOnClosedConnection";
	}
};
var AbstractRelay = class {
	url;
	_connected = false;
	onclose = null;
	onnotice = (msg) => console.debug(`NOTICE from ${this.url}: ${msg}`);
	onauth;
	baseEoseTimeout = 4400;
	publishTimeout = 4400;
	pingFrequency = 29e3;
	pingTimeout = 2e4;
	resubscribeBackoff = [
		1e4,
		1e4,
		1e4,
		2e4,
		2e4,
		3e4,
		6e4
	];
	openSubs = /* @__PURE__ */ new Map();
	enablePing;
	enableReconnect;
	idleSince = Date.now();
	ongoingOperations = 0;
	reconnectTimeoutHandle;
	pingIntervalHandle;
	reconnectAttempts = 0;
	skipReconnection = false;
	connectionPromise;
	openCountRequests = /* @__PURE__ */ new Map();
	openEventPublishes = /* @__PURE__ */ new Map();
	ws;
	challenge;
	authPromise;
	serial = 0;
	verifyEvent;
	_WebSocket;
	constructor(url, opts) {
		this.url = normalizeURL(url);
		this.verifyEvent = opts.verifyEvent;
		this._WebSocket = opts.websocketImplementation || WebSocket;
		this.enablePing = opts.enablePing;
		this.enableReconnect = opts.enableReconnect || false;
	}
	static async connect(url, opts) {
		const relay = new AbstractRelay(url, opts);
		await relay.connect(opts);
		return relay;
	}
	closeAllSubscriptions(reason) {
		for (let [_, sub] of this.openSubs) sub.close(reason);
		this.openSubs.clear();
		for (let [_, ep] of this.openEventPublishes) ep.reject(new Error(reason));
		this.openEventPublishes.clear();
		for (let [_, cr] of this.openCountRequests) cr.reject(new Error(reason));
		this.openCountRequests.clear();
	}
	get connected() {
		return this._connected;
	}
	async reconnect() {
		const backoff = this.resubscribeBackoff[Math.min(this.reconnectAttempts, this.resubscribeBackoff.length - 1)];
		this.reconnectAttempts++;
		this.reconnectTimeoutHandle = setTimeout(async () => {
			try {
				await this.connect();
			} catch (err) {}
		}, backoff);
	}
	handleHardClose(reason) {
		if (this.pingIntervalHandle) {
			clearInterval(this.pingIntervalHandle);
			this.pingIntervalHandle = void 0;
		}
		this._connected = false;
		this.connectionPromise = void 0;
		this.idleSince = void 0;
		if (this.enableReconnect && !this.skipReconnection) this.reconnect();
		else {
			this.onclose?.();
			this.closeAllSubscriptions(reason);
		}
	}
	async connect(opts) {
		let connectionTimeoutHandle;
		if (this.connectionPromise) return this.connectionPromise;
		this.challenge = void 0;
		this.authPromise = void 0;
		this.skipReconnection = false;
		this.connectionPromise = new Promise((resolve, reject) => {
			if (opts?.timeout) connectionTimeoutHandle = setTimeout(() => {
				reject("connection timed out");
				this.connectionPromise = void 0;
				this.skipReconnection = true;
				this.onclose?.();
				this.handleHardClose("relay connection timed out");
			}, opts.timeout);
			if (opts?.abort) opts.abort.onabort = reject;
			try {
				this.ws = new this._WebSocket(this.url);
			} catch (err) {
				clearTimeout(connectionTimeoutHandle);
				reject(err);
				return;
			}
			this.ws.onopen = () => {
				if (this.reconnectTimeoutHandle) {
					clearTimeout(this.reconnectTimeoutHandle);
					this.reconnectTimeoutHandle = void 0;
				}
				clearTimeout(connectionTimeoutHandle);
				this._connected = true;
				const isReconnection = this.reconnectAttempts > 0;
				this.reconnectAttempts = 0;
				for (const sub of this.openSubs.values()) {
					sub.eosed = false;
					if (isReconnection) {
						for (let f = 0; f < sub.filters.length; f++) if (sub.lastEmitted) sub.filters[f].since = sub.lastEmitted + 1;
					}
					sub.fire();
				}
				if (this.enablePing) this.pingIntervalHandle = setInterval(() => this.pingpong(), this.pingFrequency);
				resolve();
			};
			this.ws.onerror = () => {
				clearTimeout(connectionTimeoutHandle);
				reject("connection failed");
				this.connectionPromise = void 0;
				this.skipReconnection = true;
				this.onclose?.();
				this.handleHardClose("relay connection failed");
			};
			this.ws.onclose = (ev) => {
				clearTimeout(connectionTimeoutHandle);
				reject(ev.message || "websocket closed");
				this.handleHardClose("relay connection closed");
			};
			this.ws.onmessage = this._onmessage.bind(this);
		});
		return this.connectionPromise;
	}
	waitForPingPong() {
		return new Promise((resolve) => {
			this.ws.once("pong", () => resolve(true));
			this.ws.ping();
		});
	}
	waitForDummyReq() {
		return new Promise((resolve, reject) => {
			if (!this.connectionPromise) return reject(/* @__PURE__ */ new Error(`no connection to ${this.url}, can't ping`));
			try {
				const sub = this.subscribe([{
					ids: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
					limit: 0
				}], {
					label: "<forced-ping>",
					oneose: () => {
						resolve(true);
						sub.close();
					},
					onclose() {
						resolve(true);
					},
					eoseTimeout: this.pingTimeout + 1e3
				});
			} catch (err) {
				reject(err);
			}
		});
	}
	async pingpong() {
		if (this.ws?.readyState === 1) {
			if (!await Promise.any([this.ws && this.ws.ping && this.ws.once ? this.waitForPingPong() : this.waitForDummyReq(), new Promise((res) => setTimeout(() => res(false), this.pingTimeout))])) {
				if (this.ws?.readyState === this._WebSocket.OPEN) this.ws?.close();
			}
		}
	}
	async send(message) {
		if (!this.connectionPromise) throw new SendingOnClosedConnection(message, this.url);
		this.connectionPromise.then(() => {
			this.ws?.send(message);
		});
	}
	async auth(signAuthEvent) {
		const challenge = this.challenge;
		if (!challenge) throw new Error("can't perform auth, no challenge was received");
		if (this.authPromise) return this.authPromise;
		this.authPromise = new Promise(async (resolve, reject) => {
			try {
				let evt = await signAuthEvent(makeAuthEvent(this.url, challenge));
				let timeout = setTimeout(() => {
					let ep = this.openEventPublishes.get(evt.id);
					if (ep) {
						ep.reject(/* @__PURE__ */ new Error("auth timed out"));
						this.openEventPublishes.delete(evt.id);
					}
				}, this.publishTimeout);
				this.openEventPublishes.set(evt.id, {
					resolve,
					reject,
					timeout
				});
				this.send("[\"AUTH\"," + JSON.stringify(evt) + "]");
			} catch (err) {
				console.warn("subscribe auth function failed:", err);
			}
		});
		return this.authPromise;
	}
	async publish(event) {
		this.idleSince = void 0;
		this.ongoingOperations++;
		const ret = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				const ep = this.openEventPublishes.get(event.id);
				if (ep) {
					ep.reject(/* @__PURE__ */ new Error("publish timed out"));
					this.openEventPublishes.delete(event.id);
				}
			}, this.publishTimeout);
			this.openEventPublishes.set(event.id, {
				resolve,
				reject,
				timeout
			});
		});
		this.send("[\"EVENT\"," + JSON.stringify(event) + "]");
		this.ongoingOperations--;
		if (this.ongoingOperations === 0) this.idleSince = Date.now();
		return ret;
	}
	async count(filters, params) {
		this.serial++;
		const id = params?.id || "count:" + this.serial;
		const ret = new Promise((resolve, reject) => {
			this.openCountRequests.set(id, {
				resolve,
				reject
			});
		});
		this.send("[\"COUNT\",\"" + id + "\"," + JSON.stringify(filters).substring(1));
		return ret;
	}
	subscribe(filters, params) {
		if (params.label !== "<forced-ping>") {
			this.idleSince = void 0;
			this.ongoingOperations++;
		}
		const sub = this.prepareSubscription(filters, params);
		sub.fire();
		if (params.abort) params.abort.onabort = () => sub.close(String(params.abort.reason || "<aborted>"));
		return sub;
	}
	prepareSubscription(filters, params) {
		this.serial++;
		const id = params.id || (params.label ? params.label + ":" : "sub:") + this.serial;
		const sub = new Subscription(this, id, filters, params);
		this.openSubs.set(id, sub);
		return sub;
	}
	close() {
		this.skipReconnection = true;
		if (this.reconnectTimeoutHandle) {
			clearTimeout(this.reconnectTimeoutHandle);
			this.reconnectTimeoutHandle = void 0;
		}
		if (this.pingIntervalHandle) {
			clearInterval(this.pingIntervalHandle);
			this.pingIntervalHandle = void 0;
		}
		this.closeAllSubscriptions("relay connection closed by us");
		this._connected = false;
		this.idleSince = void 0;
		this.onclose?.();
		if (this.ws?.readyState === this._WebSocket.OPEN) this.ws?.close();
	}
	_onmessage(ev) {
		const json = ev.data;
		if (!json) return;
		const subid = getSubscriptionId(json);
		if (subid) {
			const so = this.openSubs.get(subid);
			if (!so) return;
			const id = getHex64(json, "id");
			const alreadyHave = so.alreadyHaveEvent?.(id);
			so.receivedEvent?.(this, id);
			if (alreadyHave) return;
		}
		try {
			let data = JSON.parse(json);
			switch (data[0]) {
				case "EVENT": {
					const so = this.openSubs.get(data[1]);
					const event = data[2];
					if (this.verifyEvent(event) && matchFilters(so.filters, event)) so.onevent(event);
					else so.oninvalidevent?.(event);
					if (!so.lastEmitted || so.lastEmitted < event.created_at) so.lastEmitted = event.created_at;
					return;
				}
				case "COUNT": {
					const id = data[1];
					const payload = data[2];
					const cr = this.openCountRequests.get(id);
					if (cr) {
						cr.resolve(payload.count);
						this.openCountRequests.delete(id);
					}
					return;
				}
				case "EOSE": {
					const so = this.openSubs.get(data[1]);
					if (!so) return;
					so.receivedEose();
					return;
				}
				case "OK": {
					const id = data[1];
					const ok = data[2];
					const reason = data[3];
					const ep = this.openEventPublishes.get(id);
					if (ep) {
						clearTimeout(ep.timeout);
						if (ok) ep.resolve(reason);
						else ep.reject(new Error(reason));
						this.openEventPublishes.delete(id);
					}
					return;
				}
				case "CLOSED": {
					const id = data[1];
					const so = this.openSubs.get(id);
					if (!so) return;
					so.closed = true;
					so.close(data[2]);
					return;
				}
				case "NOTICE":
					this.onnotice(data[1]);
					return;
				case "AUTH":
					this.challenge = data[1];
					if (this.onauth) this.auth(this.onauth);
					return;
				default:
					this.openSubs.get(data[1])?.oncustom?.(data);
					return;
			}
		} catch (err) {
			try {
				const [_, __, event] = JSON.parse(json);
				console.warn(`[nostr] relay ${this.url} error processing message:`, err, event);
			} catch (_) {
				console.warn(`[nostr] relay ${this.url} error processing message:`, err);
			}
			return;
		}
	}
};
var Subscription = class {
	relay;
	id;
	lastEmitted;
	closed = false;
	eosed = false;
	filters;
	alreadyHaveEvent;
	receivedEvent;
	onevent;
	oninvalidevent;
	oneose;
	onclose;
	oncustom;
	eoseTimeout;
	eoseTimeoutHandle;
	constructor(relay, id, filters, params) {
		if (filters.length === 0) throw new Error("subscription can't be created with zero filters");
		this.relay = relay;
		this.filters = filters;
		this.id = id;
		this.alreadyHaveEvent = params.alreadyHaveEvent;
		this.receivedEvent = params.receivedEvent;
		this.eoseTimeout = params.eoseTimeout || relay.baseEoseTimeout;
		this.oneose = params.oneose;
		this.onclose = params.onclose;
		this.oninvalidevent = params.oninvalidevent;
		this.onevent = params.onevent || ((event) => {
			console.warn(`onevent() callback not defined for subscription '${this.id}' in relay ${this.relay.url}. event received:`, event);
		});
	}
	fire() {
		this.relay.send("[\"REQ\",\"" + this.id + "\"," + JSON.stringify(this.filters).substring(1));
		this.eoseTimeoutHandle = setTimeout(this.receivedEose.bind(this), this.eoseTimeout);
	}
	receivedEose() {
		if (this.eosed) return;
		clearTimeout(this.eoseTimeoutHandle);
		this.eosed = true;
		this.oneose?.();
	}
	close(reason = "closed by caller") {
		if (!this.closed && this.relay.connected) {
			try {
				this.relay.send("[\"CLOSE\"," + JSON.stringify(this.id) + "]");
			} catch (err) {
				if (err instanceof SendingOnClosedConnection) {} else throw err;
			}
			this.closed = true;
		}
		this.relay.openSubs.delete(this.id);
		this.relay.ongoingOperations--;
		if (this.relay.ongoingOperations === 0) this.relay.idleSince = Date.now();
		this.onclose?.(reason);
	}
};
try {
	WebSocket;
} catch {}
var alwaysTrue = (t) => {
	t[verifiedSymbol] = true;
	return true;
};
var AbstractSimplePool = class {
	relays = /* @__PURE__ */ new Map();
	seenOn = /* @__PURE__ */ new Map();
	trackRelays = false;
	verifyEvent;
	enablePing;
	enableReconnect;
	automaticallyAuth;
	trustedRelayURLs = /* @__PURE__ */ new Set();
	onRelayConnectionFailure;
	onRelayConnectionSuccess;
	allowConnectingToRelay;
	maxWaitForConnection;
	_WebSocket;
	constructor(opts) {
		this.verifyEvent = opts.verifyEvent;
		this._WebSocket = opts.websocketImplementation;
		this.enablePing = opts.enablePing;
		this.enableReconnect = opts.enableReconnect || false;
		this.automaticallyAuth = opts.automaticallyAuth;
		this.onRelayConnectionFailure = opts.onRelayConnectionFailure;
		this.onRelayConnectionSuccess = opts.onRelayConnectionSuccess;
		this.allowConnectingToRelay = opts.allowConnectingToRelay;
		this.maxWaitForConnection = opts.maxWaitForConnection || 3e3;
	}
	async ensureRelay(url, params) {
		url = normalizeURL(url);
		let relay = this.relays.get(url);
		if (!relay) {
			relay = new AbstractRelay(url, {
				verifyEvent: this.trustedRelayURLs.has(url) ? alwaysTrue : this.verifyEvent,
				websocketImplementation: this._WebSocket,
				enablePing: this.enablePing,
				enableReconnect: this.enableReconnect
			});
			relay.onclose = () => {
				this.relays.delete(url);
			};
			this.relays.set(url, relay);
		}
		if (this.automaticallyAuth) {
			const authSignerFn = this.automaticallyAuth(url);
			if (authSignerFn) relay.onauth = authSignerFn;
		}
		try {
			await relay.connect({
				timeout: params?.connectionTimeout,
				abort: params?.abort
			});
		} catch (err) {
			this.relays.delete(url);
			throw err;
		}
		return relay;
	}
	close(relays) {
		relays.map(normalizeURL).forEach((url) => {
			this.relays.get(url)?.close();
			this.relays.delete(url);
		});
	}
	subscribe(relays, filter, params) {
		const request = [];
		const uniqUrls = [];
		for (let i2 = 0; i2 < relays.length; i2++) {
			const url = normalizeURL(relays[i2]);
			if (!request.find((r) => r.url === url)) {
				if (uniqUrls.indexOf(url) === -1) {
					uniqUrls.push(url);
					request.push({
						url,
						filter
					});
				}
			}
		}
		return this.subscribeMap(request, params);
	}
	subscribeMany(relays, filter, params) {
		return this.subscribe(relays, filter, params);
	}
	subscribeMap(requests, params) {
		const grouped = /* @__PURE__ */ new Map();
		for (const req of requests) {
			const { url, filter } = req;
			if (!grouped.has(url)) grouped.set(url, []);
			grouped.get(url).push(filter);
		}
		const groupedRequests = Array.from(grouped.entries()).map(([url, filters]) => ({
			url,
			filters
		}));
		if (this.trackRelays) params.receivedEvent = (relay, id) => {
			let set = this.seenOn.get(id);
			if (!set) {
				set = /* @__PURE__ */ new Set();
				this.seenOn.set(id, set);
			}
			set.add(relay);
		};
		const _knownIds = /* @__PURE__ */ new Set();
		const subs = [];
		const eosesReceived = [];
		let handleEose = (i2) => {
			if (eosesReceived[i2]) return;
			eosesReceived[i2] = true;
			if (eosesReceived.filter((a) => a).length === groupedRequests.length) {
				params.oneose?.();
				handleEose = () => {};
			}
		};
		const closesReceived = [];
		let handleClose = (i2, reason) => {
			if (closesReceived[i2]) return;
			handleEose(i2);
			closesReceived[i2] = reason;
			if (closesReceived.filter((a) => a).length === groupedRequests.length) {
				params.onclose?.(closesReceived);
				handleClose = () => {};
			}
		};
		const localAlreadyHaveEventHandler = (id) => {
			if (params.alreadyHaveEvent?.(id)) return true;
			const have = _knownIds.has(id);
			_knownIds.add(id);
			return have;
		};
		const allOpened = Promise.all(groupedRequests.map(async ({ url, filters }, i2) => {
			if (this.allowConnectingToRelay?.(url, ["read", filters]) === false) {
				handleClose(i2, "connection skipped by allowConnectingToRelay");
				return;
			}
			let relay;
			try {
				relay = await this.ensureRelay(url, {
					connectionTimeout: this.maxWaitForConnection < (params.maxWait || 0) ? Math.max(params.maxWait * .8, params.maxWait - 1e3) : this.maxWaitForConnection,
					abort: params.abort
				});
			} catch (err) {
				this.onRelayConnectionFailure?.(url);
				handleClose(i2, err?.message || String(err));
				return;
			}
			this.onRelayConnectionSuccess?.(url);
			let subscription = relay.subscribe(filters, {
				...params,
				oneose: () => handleEose(i2),
				onclose: (reason) => {
					if (reason.startsWith("auth-required: ") && params.onauth) relay.auth(params.onauth).then(() => {
						relay.subscribe(filters, {
							...params,
							oneose: () => handleEose(i2),
							onclose: (reason2) => {
								handleClose(i2, reason2);
							},
							alreadyHaveEvent: localAlreadyHaveEventHandler,
							eoseTimeout: params.maxWait,
							abort: params.abort
						});
					}).catch((err) => {
						handleClose(i2, `auth was required and attempted, but failed with: ${err}`);
					});
					else handleClose(i2, reason);
				},
				alreadyHaveEvent: localAlreadyHaveEventHandler,
				eoseTimeout: params.maxWait,
				abort: params.abort
			});
			subs.push(subscription);
		}));
		return { async close(reason) {
			await allOpened;
			subs.forEach((sub) => {
				sub.close(reason);
			});
		} };
	}
	subscribeEose(relays, filter, params) {
		let subcloser;
		subcloser = this.subscribe(relays, filter, {
			...params,
			oneose() {
				const reason = "closed automatically on eose";
				if (subcloser) subcloser.close(reason);
				else params.onclose?.(relays.map((_) => reason));
			}
		});
		return subcloser;
	}
	subscribeManyEose(relays, filter, params) {
		return this.subscribeEose(relays, filter, params);
	}
	async querySync(relays, filter, params) {
		return new Promise(async (resolve) => {
			const events = [];
			this.subscribeEose(relays, filter, {
				...params,
				onevent(event) {
					events.push(event);
				},
				onclose(_) {
					resolve(events);
				}
			});
		});
	}
	async get(relays, filter, params) {
		filter.limit = 1;
		const events = await this.querySync(relays, filter, params);
		events.sort((a, b) => b.created_at - a.created_at);
		return events[0] || null;
	}
	publish(relays, event, params) {
		return relays.map(normalizeURL).map(async (url, i2, arr) => {
			if (arr.indexOf(url) !== i2) return Promise.reject("duplicate url");
			if (this.allowConnectingToRelay?.(url, ["write", event]) === false) return Promise.reject("connection skipped by allowConnectingToRelay");
			let r;
			try {
				r = await this.ensureRelay(url, {
					connectionTimeout: this.maxWaitForConnection < (params?.maxWait || 0) ? Math.max(params.maxWait * .8, params.maxWait - 1e3) : this.maxWaitForConnection,
					abort: params?.abort
				});
			} catch (err) {
				this.onRelayConnectionFailure?.(url);
				return String("connection failure: " + String(err));
			}
			return r.publish(event).catch(async (err) => {
				if (err instanceof Error && err.message.startsWith("auth-required: ") && params?.onauth) {
					await r.auth(params.onauth);
					return r.publish(event);
				}
				throw err;
			}).then((reason) => {
				if (this.trackRelays) {
					let set = this.seenOn.get(event.id);
					if (!set) {
						set = /* @__PURE__ */ new Set();
						this.seenOn.set(event.id, set);
					}
					set.add(r);
				}
				return reason;
			});
		});
	}
	listConnectionStatus() {
		const map = /* @__PURE__ */ new Map();
		this.relays.forEach((relay, url) => map.set(url, relay.connected));
		return map;
	}
	destroy() {
		this.relays.forEach((conn) => conn.close());
		this.relays = /* @__PURE__ */ new Map();
	}
	pruneIdleRelays(idleThresholdMs = 1e4) {
		const prunedUrls = [];
		for (const [url, relay] of this.relays) if (relay.idleSince && Date.now() - relay.idleSince >= idleThresholdMs) {
			this.relays.delete(url);
			prunedUrls.push(url);
			relay.close();
		}
		return prunedUrls;
	}
};
var _WebSocket2;
try {
	_WebSocket2 = WebSocket;
} catch {}
var SimplePool = class extends AbstractSimplePool {
	constructor(options) {
		super({
			verifyEvent,
			websocketImplementation: _WebSocket2,
			maxWaitForConnection: 3e3,
			...options
		});
	}
};
var nip19_exports = {};
__export(nip19_exports, {
	BECH32_REGEX: () => BECH32_REGEX,
	Bech32MaxSize: () => Bech32MaxSize,
	NostrTypeGuard: () => NostrTypeGuard,
	decode: () => decode,
	decodeNostrURI: () => decodeNostrURI,
	encodeBytes: () => encodeBytes,
	naddrEncode: () => naddrEncode,
	neventEncode: () => neventEncode,
	noteEncode: () => noteEncode,
	nprofileEncode: () => nprofileEncode,
	npubEncode: () => npubEncode,
	nsecEncode: () => nsecEncode
});
var NostrTypeGuard = {
	isNProfile: (value) => /^nprofile1[a-z\d]+$/.test(value || ""),
	isNEvent: (value) => /^nevent1[a-z\d]+$/.test(value || ""),
	isNAddr: (value) => /^naddr1[a-z\d]+$/.test(value || ""),
	isNSec: (value) => /^nsec1[a-z\d]{58}$/.test(value || ""),
	isNPub: (value) => /^npub1[a-z\d]{58}$/.test(value || ""),
	isNote: (value) => /^note1[a-z\d]+$/.test(value || ""),
	isNcryptsec: (value) => /^ncryptsec1[a-z\d]+$/.test(value || "")
};
var Bech32MaxSize = 5e3;
var BECH32_REGEX = /[\x21-\x7E]{1,83}1[023456789acdefghjklmnpqrstuvwxyz]{6,}/;
function integerToUint8Array(number) {
	const uint8Array = new Uint8Array(4);
	uint8Array[0] = number >> 24 & 255;
	uint8Array[1] = number >> 16 & 255;
	uint8Array[2] = number >> 8 & 255;
	uint8Array[3] = number & 255;
	return uint8Array;
}
function decodeNostrURI(nip19code) {
	try {
		if (nip19code.startsWith("nostr:")) nip19code = nip19code.substring(6);
		return decode(nip19code);
	} catch (_err) {
		return {
			type: "invalid",
			data: null
		};
	}
}
function decode(code) {
	let { prefix, words } = bech32.decode(code, Bech32MaxSize);
	let data = new Uint8Array(bech32.fromWords(words));
	switch (prefix) {
		case "nprofile": {
			let tlv = parseTLV(data);
			if (!tlv[0]?.[0]) throw new Error("missing TLV 0 for nprofile");
			if (tlv[0][0].length !== 32) throw new Error("TLV 0 should be 32 bytes");
			return {
				type: "nprofile",
				data: {
					pubkey: bytesToHex(tlv[0][0]),
					relays: tlv[1] ? tlv[1].map((d) => utf8Decoder$1.decode(d)) : []
				}
			};
		}
		case "nevent": {
			let tlv = parseTLV(data);
			if (!tlv[0]?.[0]) throw new Error("missing TLV 0 for nevent");
			if (tlv[0][0].length !== 32) throw new Error("TLV 0 should be 32 bytes");
			if (tlv[2] && tlv[2][0].length !== 32) throw new Error("TLV 2 should be 32 bytes");
			if (tlv[3] && tlv[3][0].length !== 4) throw new Error("TLV 3 should be 4 bytes");
			return {
				type: "nevent",
				data: {
					id: bytesToHex(tlv[0][0]),
					relays: tlv[1] ? tlv[1].map((d) => utf8Decoder$1.decode(d)) : [],
					author: tlv[2]?.[0] ? bytesToHex(tlv[2][0]) : void 0,
					kind: tlv[3]?.[0] ? parseInt(bytesToHex(tlv[3][0]), 16) : void 0
				}
			};
		}
		case "naddr": {
			let tlv = parseTLV(data);
			if (!tlv[0]?.[0]) throw new Error("missing TLV 0 for naddr");
			if (!tlv[2]?.[0]) throw new Error("missing TLV 2 for naddr");
			if (tlv[2][0].length !== 32) throw new Error("TLV 2 should be 32 bytes");
			if (!tlv[3]?.[0]) throw new Error("missing TLV 3 for naddr");
			if (tlv[3][0].length !== 4) throw new Error("TLV 3 should be 4 bytes");
			return {
				type: "naddr",
				data: {
					identifier: utf8Decoder$1.decode(tlv[0][0]),
					pubkey: bytesToHex(tlv[2][0]),
					kind: parseInt(bytesToHex(tlv[3][0]), 16),
					relays: tlv[1] ? tlv[1].map((d) => utf8Decoder$1.decode(d)) : []
				}
			};
		}
		case "nsec": return {
			type: prefix,
			data
		};
		case "npub":
		case "note": return {
			type: prefix,
			data: bytesToHex(data)
		};
		default: throw new Error(`unknown prefix ${prefix}`);
	}
}
function parseTLV(data) {
	let result = {};
	let rest = data;
	while (rest.length > 0) {
		let t = rest[0];
		let l = rest[1];
		let v = rest.slice(2, 2 + l);
		rest = rest.slice(2 + l);
		if (v.length < l) throw new Error(`not enough data to read on TLV ${t}`);
		result[t] = result[t] || [];
		result[t].push(v);
	}
	return result;
}
function nsecEncode(key) {
	return encodeBytes("nsec", key);
}
function npubEncode(hex) {
	return encodeBytes("npub", hexToBytes(hex));
}
function noteEncode(hex) {
	return encodeBytes("note", hexToBytes(hex));
}
function encodeBech32(prefix, data) {
	let words = bech32.toWords(data);
	return bech32.encode(prefix, words, Bech32MaxSize);
}
function encodeBytes(prefix, bytes) {
	return encodeBech32(prefix, bytes);
}
function nprofileEncode(profile) {
	return encodeBech32("nprofile", encodeTLV({
		0: [hexToBytes(profile.pubkey)],
		1: (profile.relays || []).map((url) => utf8Encoder$1.encode(url))
	}));
}
function neventEncode(event) {
	let kindArray;
	if (event.kind !== void 0) kindArray = integerToUint8Array(event.kind);
	return encodeBech32("nevent", encodeTLV({
		0: [hexToBytes(event.id)],
		1: (event.relays || []).map((url) => utf8Encoder$1.encode(url)),
		2: event.author ? [hexToBytes(event.author)] : [],
		3: kindArray ? [new Uint8Array(kindArray)] : []
	}));
}
function naddrEncode(addr) {
	let kind = /* @__PURE__ */ new ArrayBuffer(4);
	new DataView(kind).setUint32(0, addr.kind, false);
	return encodeBech32("naddr", encodeTLV({
		0: [utf8Encoder$1.encode(addr.identifier)],
		1: (addr.relays || []).map((url) => utf8Encoder$1.encode(url)),
		2: [hexToBytes(addr.pubkey)],
		3: [new Uint8Array(kind)]
	}));
}
function encodeTLV(tlv) {
	let entries = [];
	Object.entries(tlv).reverse().forEach(([t, vs]) => {
		vs.forEach((v) => {
			let entry = new Uint8Array(v.length + 2);
			entry.set([parseInt(t)], 0);
			entry.set([v.length], 1);
			entry.set(v, 2);
			entries.push(entry);
		});
	});
	return concatBytes(...entries);
}
__export({}, {
	decrypt: () => decrypt$1,
	encrypt: () => encrypt$1
});
function encrypt$1(secretKey, pubkey, text) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	const normalizedKey = getNormalizedX$1(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = Uint8Array.from(randomBytes$1(16));
	let plaintext = utf8Encoder$1.encode(text);
	let ciphertext = cbc(normalizedKey, iv).encrypt(plaintext);
	return `${base64.encode(new Uint8Array(ciphertext))}?iv=${base64.encode(new Uint8Array(iv.buffer))}`;
}
function decrypt$1(secretKey, pubkey, data) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	let [ctb64, ivb64] = data.split("?iv=");
	let normalizedKey = getNormalizedX$1(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = base64.decode(ivb64);
	let ciphertext = base64.decode(ctb64);
	let plaintext = cbc(normalizedKey, iv).decrypt(ciphertext);
	return utf8Decoder$1.decode(plaintext);
}
function getNormalizedX$1(key) {
	return key.slice(1, 33);
}
__export({}, {
	NIP05_REGEX: () => NIP05_REGEX,
	isNip05: () => isNip05,
	isValid: () => isValid,
	queryProfile: () => queryProfile,
	searchDomain: () => searchDomain,
	useFetchImplementation: () => useFetchImplementation
});
var NIP05_REGEX = /^(?:([\w.+-]+)@)?([\w_-]+(\.[\w_-]+)+)$/;
var isNip05 = (value) => NIP05_REGEX.test(value || "");
var _fetch;
try {
	_fetch = fetch;
} catch (_) {}
function useFetchImplementation(fetchImplementation) {
	_fetch = fetchImplementation;
}
async function searchDomain(domain, query = "") {
	try {
		const url = `https://${domain}/.well-known/nostr.json?name=${query}`;
		const res = await _fetch(url, { redirect: "manual" });
		if (res.status !== 200) throw Error("Wrong response code");
		return (await res.json()).names;
	} catch (_) {
		return {};
	}
}
async function queryProfile(fullname) {
	const match = fullname.match(NIP05_REGEX);
	if (!match) return null;
	const [, name = "_", domain] = match;
	try {
		const url = `https://${domain}/.well-known/nostr.json?name=${name}`;
		const res = await _fetch(url, { redirect: "manual" });
		if (res.status !== 200) throw Error("Wrong response code");
		const json = await res.json();
		const pubkey = json.names[name];
		return pubkey ? {
			pubkey,
			relays: json.relays?.[pubkey]
		} : null;
	} catch (_e) {
		return null;
	}
}
async function isValid(pubkey, nip05) {
	const res = await queryProfile(nip05);
	return res ? res.pubkey === pubkey : false;
}
__export({}, { parse: () => parse });
function parse(event) {
	const result = {
		reply: void 0,
		root: void 0,
		mentions: [],
		profiles: [],
		quotes: []
	};
	let maybeParent;
	let maybeRoot;
	for (let i2 = event.tags.length - 1; i2 >= 0; i2--) {
		const tag = event.tags[i2];
		if (tag[0] === "e" && tag[1]) {
			const [_, eTagEventId, eTagRelayUrl, eTagMarker, eTagAuthor] = tag;
			const eventPointer = {
				id: eTagEventId,
				relays: eTagRelayUrl ? [eTagRelayUrl] : [],
				author: eTagAuthor
			};
			if (eTagMarker === "root") {
				result.root = eventPointer;
				continue;
			}
			if (eTagMarker === "reply") {
				result.reply = eventPointer;
				continue;
			}
			if (eTagMarker === "mention") {
				result.mentions.push(eventPointer);
				continue;
			}
			if (!maybeParent) maybeParent = eventPointer;
			else maybeRoot = eventPointer;
			result.mentions.push(eventPointer);
			continue;
		}
		if (tag[0] === "q" && tag[1]) {
			const [_, eTagEventId, eTagRelayUrl] = tag;
			result.quotes.push({
				id: eTagEventId,
				relays: eTagRelayUrl ? [eTagRelayUrl] : []
			});
		}
		if (tag[0] === "p" && tag[1]) {
			result.profiles.push({
				pubkey: tag[1],
				relays: tag[2] ? [tag[2]] : []
			});
			continue;
		}
	}
	if (!result.root) result.root = maybeRoot || maybeParent || result.reply;
	if (!result.reply) result.reply = maybeParent || result.root;
	[result.reply, result.root].forEach((ref) => {
		if (!ref) return;
		let idx = result.mentions.indexOf(ref);
		if (idx !== -1) result.mentions.splice(idx, 1);
		if (ref.author) {
			let author = result.profiles.find((p) => p.pubkey === ref.author);
			if (author && author.relays) {
				if (!ref.relays) ref.relays = [];
				author.relays.forEach((url) => {
					if (ref.relays?.indexOf(url) === -1) ref.relays.push(url);
				});
				author.relays = ref.relays;
			}
		}
	});
	result.mentions.forEach((ref) => {
		if (ref.author) {
			let author = result.profiles.find((p) => p.pubkey === ref.author);
			if (author && author.relays) {
				if (!ref.relays) ref.relays = [];
				author.relays.forEach((url) => {
					if (ref.relays.indexOf(url) === -1) ref.relays.push(url);
				});
				author.relays = ref.relays;
			}
		}
	});
	return result;
}
__export({}, {
	fetchRelayInformation: () => fetchRelayInformation,
	useFetchImplementation: () => useFetchImplementation2
});
function useFetchImplementation2(fetchImplementation) {}
async function fetchRelayInformation(url) {
	return await (await fetch(url.replace("ws://", "http://").replace("wss://", "https://"), { headers: { Accept: "application/nostr+json" } })).json();
}
__export({}, {
	getPow: () => getPow,
	minePow: () => minePow
});
function getPow(hex) {
	let count = 0;
	for (let i2 = 0; i2 < 64; i2 += 8) {
		const nibble = parseInt(hex.substring(i2, i2 + 8), 16);
		if (nibble === 0) count += 32;
		else {
			count += Math.clz32(nibble);
			break;
		}
	}
	return count;
}
function getPowFromBytes(hash) {
	let count = 0;
	for (let i2 = 0; i2 < hash.length; i2++) {
		const byte = hash[i2];
		if (byte === 0) count += 8;
		else {
			count += Math.clz32(byte) - 24;
			break;
		}
	}
	return count;
}
function minePow(unsigned, difficulty) {
	let count = 0;
	const event = unsigned;
	const tag = [
		"nonce",
		count.toString(),
		difficulty.toString()
	];
	event.tags.push(tag);
	while (true) {
		const now2 = Math.floor((/* @__PURE__ */ new Date()).getTime() / 1e3);
		if (now2 !== event.created_at) {
			count = 0;
			event.created_at = now2;
		}
		tag[1] = (++count).toString();
		const hash = sha256(utf8Encoder$1.encode(JSON.stringify([
			0,
			event.pubkey,
			event.created_at,
			event.kind,
			event.tags,
			event.content
		])));
		if (getPowFromBytes(hash) >= difficulty) {
			event.id = bytesToHex(hash);
			break;
		}
	}
	return event;
}
__export({}, {
	unwrapEvent: () => unwrapEvent2,
	unwrapManyEvents: () => unwrapManyEvents2,
	wrapEvent: () => wrapEvent2,
	wrapManyEvents: () => wrapManyEvents2
});
__export({}, {
	createRumor: () => createRumor,
	createSeal: () => createSeal,
	createWrap: () => createWrap,
	unwrapEvent: () => unwrapEvent,
	unwrapManyEvents: () => unwrapManyEvents,
	wrapEvent: () => wrapEvent,
	wrapManyEvents: () => wrapManyEvents
});
__export({}, {
	decrypt: () => decrypt2,
	encrypt: () => encrypt2,
	getConversationKey: () => getConversationKey,
	v2: () => v2
});
var minPlaintextSize = 1;
var maxPlaintextSize = 65535;
function getConversationKey(privkeyA, pubkeyB) {
	return extract(sha256, secp256k1.getSharedSecret(privkeyA, hexToBytes("02" + pubkeyB)).subarray(1, 33), utf8Encoder$1.encode("nip44-v2"));
}
function getMessageKeys(conversationKey, nonce) {
	const keys = expand(sha256, conversationKey, nonce, 76);
	return {
		chacha_key: keys.subarray(0, 32),
		chacha_nonce: keys.subarray(32, 44),
		hmac_key: keys.subarray(44, 76)
	};
}
function calcPaddedLen(len) {
	if (!Number.isSafeInteger(len) || len < 1) throw new Error("expected positive integer");
	if (len <= 32) return 32;
	const nextPower = 1 << Math.floor(Math.log2(len - 1)) + 1;
	const chunk = nextPower <= 256 ? 32 : nextPower / 8;
	return chunk * (Math.floor((len - 1) / chunk) + 1);
}
function writeU16BE(num) {
	if (!Number.isSafeInteger(num) || num < minPlaintextSize || num > maxPlaintextSize) throw new Error("invalid plaintext size: must be between 1 and 65535 bytes");
	const arr = new Uint8Array(2);
	new DataView(arr.buffer).setUint16(0, num, false);
	return arr;
}
function pad(plaintext) {
	const unpadded = utf8Encoder$1.encode(plaintext);
	const unpaddedLen = unpadded.length;
	return concatBytes(writeU16BE(unpaddedLen), unpadded, new Uint8Array(calcPaddedLen(unpaddedLen) - unpaddedLen));
}
function unpad(padded) {
	const unpaddedLen = new DataView(padded.buffer).getUint16(0);
	const unpadded = padded.subarray(2, 2 + unpaddedLen);
	if (unpaddedLen < minPlaintextSize || unpaddedLen > maxPlaintextSize || unpadded.length !== unpaddedLen || padded.length !== 2 + calcPaddedLen(unpaddedLen)) throw new Error("invalid padding");
	return utf8Decoder$1.decode(unpadded);
}
function hmacAad(key, message, aad) {
	if (aad.length !== 32) throw new Error("AAD associated data must be 32 bytes");
	return hmac(sha256, key, concatBytes(aad, message));
}
function decodePayload(payload) {
	if (typeof payload !== "string") throw new Error("payload must be a valid string");
	const plen = payload.length;
	if (plen < 132 || plen > 87472) throw new Error("invalid payload length: " + plen);
	if (payload[0] === "#") throw new Error("unknown encryption version");
	let data;
	try {
		data = base64.decode(payload);
	} catch (error) {
		throw new Error("invalid base64: " + error.message);
	}
	const dlen = data.length;
	if (dlen < 99 || dlen > 65603) throw new Error("invalid data length: " + dlen);
	const vers = data[0];
	if (vers !== 2) throw new Error("unknown encryption version " + vers);
	return {
		nonce: data.subarray(1, 33),
		ciphertext: data.subarray(33, -32),
		mac: data.subarray(-32)
	};
}
function encrypt2(plaintext, conversationKey, nonce = randomBytes$1(32)) {
	const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
	const ciphertext = chacha20(chacha_key, chacha_nonce, pad(plaintext));
	const mac = hmacAad(hmac_key, ciphertext, nonce);
	return base64.encode(concatBytes(new Uint8Array([2]), nonce, ciphertext, mac));
}
function decrypt2(payload, conversationKey) {
	const { nonce, ciphertext, mac } = decodePayload(payload);
	const { chacha_key, chacha_nonce, hmac_key } = getMessageKeys(conversationKey, nonce);
	if (!equalBytes(hmacAad(hmac_key, ciphertext, nonce), mac)) throw new Error("invalid MAC");
	return unpad(chacha20(chacha_key, chacha_nonce, ciphertext));
}
var v2 = {
	utils: {
		getConversationKey,
		calcPaddedLen
	},
	encrypt: encrypt2,
	decrypt: decrypt2
};
var TWO_DAYS = 2880 * 60;
var now = () => Math.round(Date.now() / 1e3);
var randomNow = () => Math.round(now() - Math.random() * TWO_DAYS);
var nip44ConversationKey = (privateKey, publicKey) => getConversationKey(privateKey, publicKey);
var nip44Encrypt = (data, privateKey, publicKey) => encrypt2(JSON.stringify(data), nip44ConversationKey(privateKey, publicKey));
var nip44Decrypt = (data, privateKey) => JSON.parse(decrypt2(data.content, nip44ConversationKey(privateKey, data.pubkey)));
function createRumor(event, privateKey) {
	const rumor = {
		created_at: now(),
		content: "",
		tags: [],
		...event,
		pubkey: getPublicKey(privateKey)
	};
	rumor.id = getEventHash(rumor);
	return rumor;
}
function createSeal(rumor, privateKey, recipientPublicKey) {
	return finalizeEvent({
		kind: Seal,
		content: nip44Encrypt(rumor, privateKey, recipientPublicKey),
		created_at: randomNow(),
		tags: []
	}, privateKey);
}
function createWrap(seal, recipientPublicKey) {
	const randomKey = generateSecretKey();
	return finalizeEvent({
		kind: GiftWrap,
		content: nip44Encrypt(seal, randomKey, recipientPublicKey),
		created_at: randomNow(),
		tags: [["p", recipientPublicKey]]
	}, randomKey);
}
function wrapEvent(event, senderPrivateKey, recipientPublicKey) {
	return createWrap(createSeal(createRumor(event, senderPrivateKey), senderPrivateKey, recipientPublicKey), recipientPublicKey);
}
function wrapManyEvents(event, senderPrivateKey, recipientsPublicKeys) {
	if (!recipientsPublicKeys || recipientsPublicKeys.length === 0) throw new Error("At least one recipient is required.");
	const wrappeds = [wrapEvent(event, senderPrivateKey, getPublicKey(senderPrivateKey))];
	recipientsPublicKeys.forEach((recipientPublicKey) => {
		wrappeds.push(wrapEvent(event, senderPrivateKey, recipientPublicKey));
	});
	return wrappeds;
}
function unwrapEvent(wrap, recipientPrivateKey) {
	return nip44Decrypt(nip44Decrypt(wrap, recipientPrivateKey), recipientPrivateKey);
}
function unwrapManyEvents(wrappedEvents, recipientPrivateKey) {
	let unwrappedEvents = [];
	wrappedEvents.forEach((e) => {
		unwrappedEvents.push(unwrapEvent(e, recipientPrivateKey));
	});
	unwrappedEvents.sort((a, b) => a.created_at - b.created_at);
	return unwrappedEvents;
}
function createEvent(recipients, message, conversationTitle, replyTo) {
	const baseEvent = {
		created_at: Math.ceil(Date.now() / 1e3),
		kind: PrivateDirectMessage,
		tags: [],
		content: message
	};
	(Array.isArray(recipients) ? recipients : [recipients]).forEach(({ publicKey, relayUrl }) => {
		baseEvent.tags.push(relayUrl ? [
			"p",
			publicKey,
			relayUrl
		] : ["p", publicKey]);
	});
	if (replyTo) baseEvent.tags.push([
		"e",
		replyTo.eventId,
		replyTo.relayUrl || "",
		"reply"
	]);
	if (conversationTitle) baseEvent.tags.push(["subject", conversationTitle]);
	return baseEvent;
}
function wrapEvent2(senderPrivateKey, recipient, message, conversationTitle, replyTo) {
	return wrapEvent(createEvent(recipient, message, conversationTitle, replyTo), senderPrivateKey, recipient.publicKey);
}
function wrapManyEvents2(senderPrivateKey, recipients, message, conversationTitle, replyTo) {
	if (!recipients || recipients.length === 0) throw new Error("At least one recipient is required.");
	return [{ publicKey: getPublicKey(senderPrivateKey) }, ...recipients].map((recipient) => wrapEvent2(senderPrivateKey, recipient, message, conversationTitle, replyTo));
}
var unwrapEvent2 = unwrapEvent;
var unwrapManyEvents2 = unwrapManyEvents;
__export({}, {
	finishRepostEvent: () => finishRepostEvent,
	getRepostedEvent: () => getRepostedEvent,
	getRepostedEventPointer: () => getRepostedEventPointer
});
function finishRepostEvent(t, reposted, relayUrl, privateKey) {
	let kind;
	const tags = [
		...t.tags ?? [],
		[
			"e",
			reposted.id,
			relayUrl
		],
		["p", reposted.pubkey]
	];
	if (reposted.kind === ShortTextNote) kind = Repost;
	else {
		kind = GenericRepost;
		tags.push(["k", String(reposted.kind)]);
	}
	return finalizeEvent({
		kind,
		tags,
		content: t.content === "" || reposted.tags?.find((tag) => tag[0] === "-") ? "" : JSON.stringify(reposted),
		created_at: t.created_at
	}, privateKey);
}
function getRepostedEventPointer(event) {
	if (![Repost, GenericRepost].includes(event.kind)) return;
	let lastETag;
	let lastPTag;
	for (let i2 = event.tags.length - 1; i2 >= 0 && (lastETag === void 0 || lastPTag === void 0); i2--) {
		const tag = event.tags[i2];
		if (tag.length >= 2) {
			if (tag[0] === "e" && lastETag === void 0) lastETag = tag;
			else if (tag[0] === "p" && lastPTag === void 0) lastPTag = tag;
		}
	}
	if (lastETag === void 0) return;
	return {
		id: lastETag[1],
		relays: [lastETag[2], lastPTag?.[2]].filter((x) => typeof x === "string"),
		author: lastPTag?.[1]
	};
}
function getRepostedEvent(event, { skipVerification } = {}) {
	const pointer = getRepostedEventPointer(event);
	if (pointer === void 0 || event.content === "") return;
	let repostedEvent;
	try {
		repostedEvent = JSON.parse(event.content);
	} catch (error) {
		return;
	}
	if (repostedEvent.id !== pointer.id) return;
	if (!skipVerification && !verifyEvent(repostedEvent)) return;
	return repostedEvent;
}
__export({}, {
	NOSTR_URI_REGEX: () => NOSTR_URI_REGEX,
	parse: () => parse2,
	test: () => test
});
var NOSTR_URI_REGEX = new RegExp(`nostr:(${BECH32_REGEX.source})`);
function test(value) {
	return typeof value === "string" && new RegExp(`^${NOSTR_URI_REGEX.source}$`).test(value);
}
function parse2(uri) {
	const match = uri.match(new RegExp(`^${NOSTR_URI_REGEX.source}$`));
	if (!match) throw new Error(`Invalid Nostr URI: ${uri}`);
	return {
		uri: match[0],
		value: match[1],
		decoded: decode(match[1])
	};
}
__export({}, {
	finishReactionEvent: () => finishReactionEvent,
	getReactedEventPointer: () => getReactedEventPointer
});
function finishReactionEvent(t, reacted, privateKey) {
	const inheritedTags = reacted.tags.filter((tag) => tag.length >= 2 && (tag[0] === "e" || tag[0] === "p"));
	return finalizeEvent({
		...t,
		kind: Reaction,
		tags: [
			...t.tags ?? [],
			...inheritedTags,
			["e", reacted.id],
			["p", reacted.pubkey]
		],
		content: t.content ?? "+"
	}, privateKey);
}
function getReactedEventPointer(event) {
	if (event.kind !== Reaction) return;
	let lastETag;
	let lastPTag;
	for (let i2 = event.tags.length - 1; i2 >= 0 && (lastETag === void 0 || lastPTag === void 0); i2--) {
		const tag = event.tags[i2];
		if (tag.length >= 2) {
			if (tag[0] === "e" && lastETag === void 0) lastETag = tag;
			else if (tag[0] === "p" && lastPTag === void 0) lastPTag = tag;
		}
	}
	if (lastETag === void 0 || lastPTag === void 0) return;
	return {
		id: lastETag[1],
		relays: [lastETag[2], lastPTag[2]].filter((x) => x !== void 0),
		author: lastPTag[1]
	};
}
__export({}, { parse: () => parse3 });
var noCharacter = /\W/m;
var noURLCharacter = /[^\w\/] |[^\w\/]$|$|,| /m;
var MAX_HASHTAG_LENGTH = 42;
function* parse3(content) {
	let emojis = [];
	if (typeof content !== "string") {
		for (let i2 = 0; i2 < content.tags.length; i2++) {
			const tag = content.tags[i2];
			if (tag[0] === "emoji" && tag.length >= 3) emojis.push({
				type: "emoji",
				shortcode: tag[1],
				url: tag[2]
			});
		}
		content = content.content;
	}
	const max = content.length;
	let prevIndex = 0;
	let index = 0;
	mainloop: while (index < max) {
		const u = content.indexOf(":", index);
		const h = content.indexOf("#", index);
		if (u === -1 && h === -1) break mainloop;
		if (u === -1 || h >= 0 && h < u) {
			if (h === 0 || content[h - 1].match(noCharacter)) {
				const m = content.slice(h + 1, h + MAX_HASHTAG_LENGTH).match(noCharacter);
				const end = m ? h + 1 + m.index : max;
				yield {
					type: "text",
					text: content.slice(prevIndex, h)
				};
				yield {
					type: "hashtag",
					value: content.slice(h + 1, end)
				};
				index = end;
				prevIndex = index;
				continue mainloop;
			}
			index = h + 1;
			continue mainloop;
		}
		if (content.slice(u - 5, u) === "nostr") {
			const m = content.slice(u + 60).match(noCharacter);
			const end = m ? u + 60 + m.index : max;
			try {
				let pointer;
				let { data, type } = decode(content.slice(u + 1, end));
				switch (type) {
					case "npub":
						pointer = { pubkey: data };
						break;
					case "note":
						pointer = { id: data };
						break;
					case "nsec":
						index = end + 1;
						continue;
					default: pointer = data;
				}
				if (prevIndex !== u - 5) yield {
					type: "text",
					text: content.slice(prevIndex, u - 5)
				};
				yield {
					type: "reference",
					pointer
				};
				index = end;
				prevIndex = index;
				continue mainloop;
			} catch (_err) {
				index = u + 1;
				continue mainloop;
			}
		} else if (content.slice(u - 5, u) === "https" || content.slice(u - 4, u) === "http") {
			const m = content.slice(u + 4).match(noURLCharacter);
			const end = m ? u + 4 + m.index : max;
			const prefixLen = content[u - 1] === "s" ? 5 : 4;
			try {
				let url = new URL(content.slice(u - prefixLen, end));
				if (url.hostname.indexOf(".") === -1) throw new Error("invalid url");
				if (prevIndex !== u - prefixLen) yield {
					type: "text",
					text: content.slice(prevIndex, u - prefixLen)
				};
				if (/\.(png|jpe?g|gif|webp|heic|svg)$/i.test(url.pathname)) {
					yield {
						type: "image",
						url: url.toString()
					};
					index = end;
					prevIndex = index;
					continue mainloop;
				}
				if (/\.(mp4|avi|webm|mkv|mov)$/i.test(url.pathname)) {
					yield {
						type: "video",
						url: url.toString()
					};
					index = end;
					prevIndex = index;
					continue mainloop;
				}
				if (/\.(mp3|aac|ogg|opus|wav|flac)$/i.test(url.pathname)) {
					yield {
						type: "audio",
						url: url.toString()
					};
					index = end;
					prevIndex = index;
					continue mainloop;
				}
				yield {
					type: "url",
					url: url.toString()
				};
				index = end;
				prevIndex = index;
				continue mainloop;
			} catch (_err) {
				index = end + 1;
				continue mainloop;
			}
		} else if (content.slice(u - 3, u) === "wss" || content.slice(u - 2, u) === "ws") {
			const m = content.slice(u + 4).match(noURLCharacter);
			const end = m ? u + 4 + m.index : max;
			const prefixLen = content[u - 1] === "s" ? 3 : 2;
			try {
				let url = new URL(content.slice(u - prefixLen, end));
				if (url.hostname.indexOf(".") === -1) throw new Error("invalid ws url");
				if (prevIndex !== u - prefixLen) yield {
					type: "text",
					text: content.slice(prevIndex, u - prefixLen)
				};
				yield {
					type: "relay",
					url: url.toString()
				};
				index = end;
				prevIndex = index;
				continue mainloop;
			} catch (_err) {
				index = end + 1;
				continue mainloop;
			}
		} else {
			for (let e = 0; e < emojis.length; e++) {
				const emoji = emojis[e];
				if (content[u + emoji.shortcode.length + 1] === ":" && content.slice(u + 1, u + emoji.shortcode.length + 1) === emoji.shortcode) {
					if (prevIndex !== u) yield {
						type: "text",
						text: content.slice(prevIndex, u)
					};
					yield emoji;
					index = u + emoji.shortcode.length + 2;
					prevIndex = index;
					continue mainloop;
				}
			}
			index = u + 1;
			continue mainloop;
		}
	}
	if (prevIndex !== max) yield {
		type: "text",
		text: content.slice(prevIndex)
	};
}
__export({}, {
	channelCreateEvent: () => channelCreateEvent,
	channelHideMessageEvent: () => channelHideMessageEvent,
	channelMessageEvent: () => channelMessageEvent,
	channelMetadataEvent: () => channelMetadataEvent,
	channelMuteUserEvent: () => channelMuteUserEvent
});
var channelCreateEvent = (t, privateKey) => {
	let content;
	if (typeof t.content === "object") content = JSON.stringify(t.content);
	else if (typeof t.content === "string") content = t.content;
	else return;
	return finalizeEvent({
		kind: ChannelCreation,
		tags: [...t.tags ?? []],
		content,
		created_at: t.created_at
	}, privateKey);
};
var channelMetadataEvent = (t, privateKey) => {
	let content;
	if (typeof t.content === "object") content = JSON.stringify(t.content);
	else if (typeof t.content === "string") content = t.content;
	else return;
	return finalizeEvent({
		kind: ChannelMetadata,
		tags: [["e", t.channel_create_event_id], ...t.tags ?? []],
		content,
		created_at: t.created_at
	}, privateKey);
};
var channelMessageEvent = (t, privateKey) => {
	const tags = [[
		"e",
		t.channel_create_event_id,
		t.relay_url,
		"root"
	]];
	if (t.reply_to_channel_message_event_id) tags.push([
		"e",
		t.reply_to_channel_message_event_id,
		t.relay_url,
		"reply"
	]);
	return finalizeEvent({
		kind: ChannelMessage,
		tags: [...tags, ...t.tags ?? []],
		content: t.content,
		created_at: t.created_at
	}, privateKey);
};
var channelHideMessageEvent = (t, privateKey) => {
	let content;
	if (typeof t.content === "object") content = JSON.stringify(t.content);
	else if (typeof t.content === "string") content = t.content;
	else return;
	return finalizeEvent({
		kind: ChannelHideMessage,
		tags: [["e", t.channel_message_event_id], ...t.tags ?? []],
		content,
		created_at: t.created_at
	}, privateKey);
};
var channelMuteUserEvent = (t, privateKey) => {
	let content;
	if (typeof t.content === "object") content = JSON.stringify(t.content);
	else if (typeof t.content === "string") content = t.content;
	else return;
	return finalizeEvent({
		kind: ChannelMuteUser,
		tags: [["p", t.pubkey_to_mute], ...t.tags ?? []],
		content,
		created_at: t.created_at
	}, privateKey);
};
__export({}, {
	EMOJI_SHORTCODE_REGEX: () => EMOJI_SHORTCODE_REGEX,
	matchAll: () => matchAll,
	regex: () => regex,
	replaceAll: () => replaceAll
});
var EMOJI_SHORTCODE_REGEX = /:(\w+):/;
var regex = () => new RegExp(`\\B${EMOJI_SHORTCODE_REGEX.source}\\B`, "g");
function* matchAll(content) {
	const matches = content.matchAll(regex());
	for (const match of matches) try {
		const [shortcode, name] = match;
		yield {
			shortcode,
			name,
			start: match.index,
			end: match.index + shortcode.length
		};
	} catch (_e) {}
}
function replaceAll(content, replacer) {
	return content.replaceAll(regex(), (shortcode, name) => {
		return replacer({
			shortcode,
			name
		});
	});
}
__export({}, {
	useFetchImplementation: () => useFetchImplementation3,
	validateGithub: () => validateGithub
});
var _fetch3;
try {
	_fetch3 = fetch;
} catch {}
function useFetchImplementation3(fetchImplementation) {
	_fetch3 = fetchImplementation;
}
async function validateGithub(pubkey, username, proof) {
	try {
		return await (await _fetch3(`https://gist.github.com/${username}/${proof}/raw`)).text() === `Verifying that I control the following Nostr public key: ${pubkey}`;
	} catch (_) {
		return false;
	}
}
__export({}, {
	makeNwcRequestEvent: () => makeNwcRequestEvent,
	parseConnectionString: () => parseConnectionString
});
function parseConnectionString(connectionString) {
	const { host, pathname, searchParams } = new URL(connectionString);
	const pubkey = pathname || host;
	const relay = searchParams.get("relay");
	const secret = searchParams.get("secret");
	if (!pubkey || !relay || !secret) throw new Error("invalid connection string");
	return {
		pubkey,
		relay,
		secret
	};
}
async function makeNwcRequestEvent(pubkey, secretKey, invoice) {
	const content = {
		method: "pay_invoice",
		params: { invoice }
	};
	const encryptedContent = encrypt$1(secretKey, pubkey, JSON.stringify(content));
	return finalizeEvent({
		kind: NWCWalletRequest,
		created_at: Math.round(Date.now() / 1e3),
		content: encryptedContent,
		tags: [["p", pubkey]]
	}, secretKey);
}
__export({}, { normalizeIdentifier: () => normalizeIdentifier });
function normalizeIdentifier(name) {
	name = name.trim().toLowerCase();
	name = name.normalize("NFKC");
	return Array.from(name).map((char) => {
		if (/\p{Letter}/u.test(char) || /\p{Number}/u.test(char)) return char;
		return "-";
	}).join("");
}
__export({}, {
	getSatoshisAmountFromBolt11: () => getSatoshisAmountFromBolt11,
	getZapEndpoint: () => getZapEndpoint,
	makeZapReceipt: () => makeZapReceipt,
	makeZapRequest: () => makeZapRequest,
	useFetchImplementation: () => useFetchImplementation4,
	validateZapRequest: () => validateZapRequest
});
var _fetch4;
try {
	_fetch4 = fetch;
} catch {}
function useFetchImplementation4(fetchImplementation) {
	_fetch4 = fetchImplementation;
}
async function getZapEndpoint(metadata) {
	try {
		let lnurl = "";
		let { lud06, lud16 } = JSON.parse(metadata.content);
		if (lud16) {
			let [name, domain] = lud16.split("@");
			lnurl = new URL(`/.well-known/lnurlp/${name}`, `https://${domain}`).toString();
		} else if (lud06) {
			let { words } = bech32.decode(lud06, 1e3);
			let data = bech32.fromWords(words);
			lnurl = utf8Decoder$1.decode(data);
		} else return null;
		let body = await (await _fetch4(lnurl)).json();
		if (body.allowsNostr && body.nostrPubkey) return body.callback;
	} catch (err) {}
	return null;
}
function makeZapRequest(params) {
	let zr = {
		kind: 9734,
		created_at: Math.round(Date.now() / 1e3),
		content: params.comment || "",
		tags: [
			["p", "pubkey" in params ? params.pubkey : params.event.pubkey],
			["amount", params.amount.toString()],
			["relays", ...params.relays]
		]
	};
	if ("event" in params) {
		zr.tags.push(["e", params.event.id]);
		if (isReplaceableKind(params.event.kind)) {
			const a = ["a", `${params.event.kind}:${params.event.pubkey}:`];
			zr.tags.push(a);
		} else if (isAddressableKind(params.event.kind)) {
			let d = params.event.tags.find(([t, v]) => t === "d" && v);
			if (!d) throw new Error("d tag not found or is empty");
			const a = ["a", `${params.event.kind}:${params.event.pubkey}:${d[1]}`];
			zr.tags.push(a);
		}
		zr.tags.push(["k", params.event.kind.toString()]);
	}
	return zr;
}
function validateZapRequest(zapRequestString) {
	let zapRequest;
	try {
		zapRequest = JSON.parse(zapRequestString);
	} catch (err) {
		return "Invalid zap request JSON.";
	}
	if (!validateEvent(zapRequest)) return "Zap request is not a valid Nostr event.";
	if (!verifyEvent(zapRequest)) return "Invalid signature on zap request.";
	let p = zapRequest.tags.find(([t, v]) => t === "p" && v);
	if (!p) return "Zap request doesn't have a 'p' tag.";
	if (!p[1].match(/^[a-f0-9]{64}$/)) return "Zap request 'p' tag is not valid hex.";
	let e = zapRequest.tags.find(([t, v]) => t === "e" && v);
	if (e && !e[1].match(/^[a-f0-9]{64}$/)) return "Zap request 'e' tag is not valid hex.";
	if (!zapRequest.tags.find(([t, v]) => t === "relays" && v)) return "Zap request doesn't have a 'relays' tag.";
	return null;
}
function makeZapReceipt({ zapRequest, preimage, bolt11, paidAt }) {
	let zr = JSON.parse(zapRequest);
	let tagsFromZapRequest = zr.tags.filter(([t]) => t === "e" || t === "p" || t === "a");
	let zap = {
		kind: 9735,
		created_at: Math.round(paidAt.getTime() / 1e3),
		content: "",
		tags: [
			...tagsFromZapRequest,
			["P", zr.pubkey],
			["bolt11", bolt11],
			["description", zapRequest]
		]
	};
	if (preimage) zap.tags.push(["preimage", preimage]);
	return zap;
}
function getSatoshisAmountFromBolt11(bolt11) {
	if (bolt11.length < 50) return 0;
	bolt11 = bolt11.substring(0, 50);
	const idx = bolt11.lastIndexOf("1");
	if (idx === -1) return 0;
	const hrp = bolt11.substring(0, idx);
	if (!hrp.startsWith("lnbc")) return 0;
	const amount = hrp.substring(4);
	if (amount.length < 1) return 0;
	const char = amount[amount.length - 1];
	const digit = char.charCodeAt(0) - "0".charCodeAt(0);
	const isDigit = digit >= 0 && digit <= 9;
	let cutPoint = amount.length - 1;
	if (isDigit) cutPoint++;
	if (cutPoint < 1) return 0;
	const num = parseInt(amount.substring(0, cutPoint));
	switch (char) {
		case "m": return num * 1e5;
		case "u": return num * 100;
		case "n": return num / 10;
		case "p": return num / 1e4;
		default: return num * 1e8;
	}
}
__export({}, {
	Negentropy: () => Negentropy,
	NegentropyStorageVector: () => NegentropyStorageVector,
	NegentropySync: () => NegentropySync
});
var PROTOCOL_VERSION = 97;
var ID_SIZE = 32;
var FINGERPRINT_SIZE = 16;
var Mode = {
	Skip: 0,
	Fingerprint: 1,
	IdList: 2
};
var WrappedBuffer = class {
	_raw;
	length;
	constructor(buffer) {
		if (typeof buffer === "number") {
			this._raw = new Uint8Array(buffer);
			this.length = 0;
		} else if (buffer instanceof Uint8Array) {
			this._raw = new Uint8Array(buffer);
			this.length = buffer.length;
		} else {
			this._raw = new Uint8Array(512);
			this.length = 0;
		}
	}
	unwrap() {
		return this._raw.subarray(0, this.length);
	}
	get capacity() {
		return this._raw.byteLength;
	}
	extend(buf) {
		if (buf instanceof WrappedBuffer) buf = buf.unwrap();
		if (typeof buf.length !== "number") throw Error("bad length");
		const targetSize = buf.length + this.length;
		if (this.capacity < targetSize) {
			const oldRaw = this._raw;
			const newCapacity = Math.max(this.capacity * 2, targetSize);
			this._raw = new Uint8Array(newCapacity);
			this._raw.set(oldRaw);
		}
		this._raw.set(buf, this.length);
		this.length += buf.length;
	}
	shift() {
		const first = this._raw[0];
		this._raw = this._raw.subarray(1);
		this.length--;
		return first;
	}
	shiftN(n = 1) {
		const firstSubarray = this._raw.subarray(0, n);
		this._raw = this._raw.subarray(n);
		this.length -= n;
		return firstSubarray;
	}
};
function decodeVarInt(buf) {
	let res = 0;
	while (1) {
		if (buf.length === 0) throw Error("parse ends prematurely");
		let byte = buf.shift();
		res = res << 7 | byte & 127;
		if ((byte & 128) === 0) break;
	}
	return res;
}
function encodeVarInt(n) {
	if (n === 0) return new WrappedBuffer(new Uint8Array([0]));
	let o = [];
	while (n !== 0) {
		o.push(n & 127);
		n >>>= 7;
	}
	o.reverse();
	for (let i2 = 0; i2 < o.length - 1; i2++) o[i2] |= 128;
	return new WrappedBuffer(new Uint8Array(o));
}
function getByte(buf) {
	return getBytes(buf, 1)[0];
}
function getBytes(buf, n) {
	if (buf.length < n) throw Error("parse ends prematurely");
	return buf.shiftN(n);
}
var Accumulator = class {
	buf;
	constructor() {
		this.setToZero();
	}
	setToZero() {
		this.buf = new Uint8Array(ID_SIZE);
	}
	add(otherBuf) {
		let currCarry = 0, nextCarry = 0;
		let p = new DataView(this.buf.buffer);
		let po = new DataView(otherBuf.buffer);
		for (let i2 = 0; i2 < 8; i2++) {
			let offset = i2 * 4;
			let orig = p.getUint32(offset, true);
			let otherV = po.getUint32(offset, true);
			let next = orig;
			next += currCarry;
			next += otherV;
			if (next > 4294967295) nextCarry = 1;
			p.setUint32(offset, next & 4294967295, true);
			currCarry = nextCarry;
			nextCarry = 0;
		}
	}
	negate() {
		let p = new DataView(this.buf.buffer);
		for (let i2 = 0; i2 < 8; i2++) {
			let offset = i2 * 4;
			p.setUint32(offset, ~p.getUint32(offset, true));
		}
		let one = new Uint8Array(ID_SIZE);
		one[0] = 1;
		this.add(one);
	}
	getFingerprint(n) {
		let input = new WrappedBuffer();
		input.extend(this.buf);
		input.extend(encodeVarInt(n));
		return sha256(input.unwrap()).subarray(0, FINGERPRINT_SIZE);
	}
};
var NegentropyStorageVector = class {
	items;
	sealed;
	constructor() {
		this.items = [];
		this.sealed = false;
	}
	insert(timestamp, id) {
		if (this.sealed) throw Error("already sealed");
		const idb = hexToBytes(id);
		if (idb.byteLength !== ID_SIZE) throw Error("bad id size for added item");
		this.items.push({
			timestamp,
			id: idb
		});
	}
	seal() {
		if (this.sealed) throw Error("already sealed");
		this.sealed = true;
		this.items.sort(itemCompare);
		for (let i2 = 1; i2 < this.items.length; i2++) if (itemCompare(this.items[i2 - 1], this.items[i2]) === 0) throw Error("duplicate item inserted");
	}
	unseal() {
		this.sealed = false;
	}
	size() {
		this._checkSealed();
		return this.items.length;
	}
	getItem(i2) {
		this._checkSealed();
		if (i2 >= this.items.length) throw Error("out of range");
		return this.items[i2];
	}
	iterate(begin, end, cb) {
		this._checkSealed();
		this._checkBounds(begin, end);
		for (let i2 = begin; i2 < end; ++i2) if (!cb(this.items[i2], i2)) break;
	}
	findLowerBound(begin, end, bound) {
		this._checkSealed();
		this._checkBounds(begin, end);
		return this._binarySearch(this.items, begin, end, (a) => itemCompare(a, bound) < 0);
	}
	fingerprint(begin, end) {
		let out = new Accumulator();
		out.setToZero();
		this.iterate(begin, end, (item) => {
			out.add(item.id);
			return true;
		});
		return out.getFingerprint(end - begin);
	}
	_checkSealed() {
		if (!this.sealed) throw Error("not sealed");
	}
	_checkBounds(begin, end) {
		if (begin > end || end > this.items.length) throw Error("bad range");
	}
	_binarySearch(arr, first, last, cmp) {
		let count = last - first;
		while (count > 0) {
			let it = first;
			let step = Math.floor(count / 2);
			it += step;
			if (cmp(arr[it])) {
				first = ++it;
				count -= step + 1;
			} else count = step;
		}
		return first;
	}
};
var Negentropy = class {
	storage;
	frameSizeLimit;
	lastTimestampIn;
	lastTimestampOut;
	constructor(storage, frameSizeLimit = 6e4) {
		if (frameSizeLimit < 4096) throw Error("frameSizeLimit too small");
		this.storage = storage;
		this.frameSizeLimit = frameSizeLimit;
		this.lastTimestampIn = 0;
		this.lastTimestampOut = 0;
	}
	_bound(timestamp, id) {
		return {
			timestamp,
			id: id || new Uint8Array(0)
		};
	}
	initiate() {
		let output = new WrappedBuffer();
		output.extend(new Uint8Array([PROTOCOL_VERSION]));
		this.splitRange(0, this.storage.size(), this._bound(Number.MAX_VALUE), output);
		return bytesToHex(output.unwrap());
	}
	reconcile(queryMsg, onhave, onneed) {
		const query = new WrappedBuffer(hexToBytes(queryMsg));
		this.lastTimestampIn = this.lastTimestampOut = 0;
		let fullOutput = new WrappedBuffer();
		fullOutput.extend(new Uint8Array([PROTOCOL_VERSION]));
		let protocolVersion = getByte(query);
		if (protocolVersion < 96 || protocolVersion > 111) throw Error("invalid negentropy protocol version byte");
		if (protocolVersion !== PROTOCOL_VERSION) throw Error("unsupported negentropy protocol version requested: " + (protocolVersion - 96));
		let storageSize = this.storage.size();
		let prevBound = this._bound(0);
		let prevIndex = 0;
		let skip = false;
		while (query.length !== 0) {
			let o = new WrappedBuffer();
			let doSkip = () => {
				if (skip) {
					skip = false;
					o.extend(this.encodeBound(prevBound));
					o.extend(encodeVarInt(Mode.Skip));
				}
			};
			let currBound = this.decodeBound(query);
			let mode = decodeVarInt(query);
			let lower = prevIndex;
			let upper = this.storage.findLowerBound(prevIndex, storageSize, currBound);
			if (mode === Mode.Skip) skip = true;
			else if (mode === Mode.Fingerprint) if (compareUint8Array(getBytes(query, FINGERPRINT_SIZE), this.storage.fingerprint(lower, upper)) !== 0) {
				doSkip();
				this.splitRange(lower, upper, currBound, o);
			} else skip = true;
			else if (mode === Mode.IdList) {
				let numIds = decodeVarInt(query);
				let theirElems = {};
				for (let i2 = 0; i2 < numIds; i2++) {
					let e = getBytes(query, ID_SIZE);
					theirElems[bytesToHex(e)] = e;
				}
				skip = true;
				this.storage.iterate(lower, upper, (item) => {
					let k = item.id;
					const id = bytesToHex(k);
					if (!theirElems[id]) onhave?.(id);
					else delete theirElems[bytesToHex(k)];
					return true;
				});
				if (onneed) for (let v of Object.values(theirElems)) onneed(bytesToHex(v));
			} else throw Error("unexpected mode");
			if (this.exceededFrameSizeLimit(fullOutput.length + o.length)) {
				let remainingFingerprint = this.storage.fingerprint(upper, storageSize);
				fullOutput.extend(this.encodeBound(this._bound(Number.MAX_VALUE)));
				fullOutput.extend(encodeVarInt(Mode.Fingerprint));
				fullOutput.extend(remainingFingerprint);
				break;
			} else fullOutput.extend(o);
			prevIndex = upper;
			prevBound = currBound;
		}
		return fullOutput.length === 1 ? null : bytesToHex(fullOutput.unwrap());
	}
	splitRange(lower, upper, upperBound, o) {
		let numElems = upper - lower;
		let buckets = 16;
		if (numElems < buckets * 2) {
			o.extend(this.encodeBound(upperBound));
			o.extend(encodeVarInt(Mode.IdList));
			o.extend(encodeVarInt(numElems));
			this.storage.iterate(lower, upper, (item) => {
				o.extend(item.id);
				return true;
			});
		} else {
			let itemsPerBucket = Math.floor(numElems / buckets);
			let bucketsWithExtra = numElems % buckets;
			let curr = lower;
			for (let i2 = 0; i2 < buckets; i2++) {
				let bucketSize = itemsPerBucket + (i2 < bucketsWithExtra ? 1 : 0);
				let ourFingerprint = this.storage.fingerprint(curr, curr + bucketSize);
				curr += bucketSize;
				let nextBound;
				if (curr === upper) nextBound = upperBound;
				else {
					let prevItem;
					let currItem;
					this.storage.iterate(curr - 1, curr + 1, (item, index) => {
						if (index === curr - 1) prevItem = item;
						else currItem = item;
						return true;
					});
					nextBound = this.getMinimalBound(prevItem, currItem);
				}
				o.extend(this.encodeBound(nextBound));
				o.extend(encodeVarInt(Mode.Fingerprint));
				o.extend(ourFingerprint);
			}
		}
	}
	exceededFrameSizeLimit(n) {
		return n > this.frameSizeLimit - 200;
	}
	decodeTimestampIn(encoded) {
		let timestamp = decodeVarInt(encoded);
		timestamp = timestamp === 0 ? Number.MAX_VALUE : timestamp - 1;
		if (this.lastTimestampIn === Number.MAX_VALUE || timestamp === Number.MAX_VALUE) {
			this.lastTimestampIn = Number.MAX_VALUE;
			return Number.MAX_VALUE;
		}
		timestamp += this.lastTimestampIn;
		this.lastTimestampIn = timestamp;
		return timestamp;
	}
	decodeBound(encoded) {
		let timestamp = this.decodeTimestampIn(encoded);
		let len = decodeVarInt(encoded);
		if (len > ID_SIZE) throw Error("bound key too long");
		return {
			timestamp,
			id: getBytes(encoded, len)
		};
	}
	encodeTimestampOut(timestamp) {
		if (timestamp === Number.MAX_VALUE) {
			this.lastTimestampOut = Number.MAX_VALUE;
			return encodeVarInt(0);
		}
		let temp = timestamp;
		timestamp -= this.lastTimestampOut;
		this.lastTimestampOut = temp;
		return encodeVarInt(timestamp + 1);
	}
	encodeBound(key) {
		let output = new WrappedBuffer();
		output.extend(this.encodeTimestampOut(key.timestamp));
		output.extend(encodeVarInt(key.id.length));
		output.extend(key.id);
		return output;
	}
	getMinimalBound(prev, curr) {
		if (curr.timestamp !== prev.timestamp) return this._bound(curr.timestamp);
		else {
			let sharedPrefixBytes = 0;
			let currKey = curr.id;
			let prevKey = prev.id;
			for (let i2 = 0; i2 < ID_SIZE; i2++) {
				if (currKey[i2] !== prevKey[i2]) break;
				sharedPrefixBytes++;
			}
			return this._bound(curr.timestamp, curr.id.subarray(0, sharedPrefixBytes + 1));
		}
	}
};
function compareUint8Array(a, b) {
	for (let i2 = 0; i2 < a.byteLength; i2++) {
		if (a[i2] < b[i2]) return -1;
		if (a[i2] > b[i2]) return 1;
	}
	if (a.byteLength > b.byteLength) return 1;
	if (a.byteLength < b.byteLength) return -1;
	return 0;
}
function itemCompare(a, b) {
	if (a.timestamp === b.timestamp) return compareUint8Array(a.id, b.id);
	return a.timestamp - b.timestamp;
}
var NegentropySync = class {
	relay;
	storage;
	neg;
	filter;
	subscription;
	onhave;
	onneed;
	constructor(relay, storage, filter, params = {}) {
		this.relay = relay;
		this.storage = storage;
		this.neg = new Negentropy(storage);
		this.onhave = params.onhave;
		this.onneed = params.onneed;
		this.filter = filter;
		this.subscription = this.relay.prepareSubscription([{}], { label: params.label || "negentropy" });
		this.subscription.oncustom = (data) => {
			switch (data[0]) {
				case "NEG-MSG":
					if (data.length < 3) console.warn(`got invalid NEG-MSG from ${this.relay.url}: ${data}`);
					try {
						const response = this.neg.reconcile(data[2], this.onhave, this.onneed);
						if (response) this.relay.send(`["NEG-MSG", "${this.subscription.id}", "${response}"]`);
						else {
							this.close();
							params.onclose?.();
						}
					} catch (error) {
						console.error("negentropy reconcile error:", error);
						params?.onclose?.(`reconcile error: ${error}`);
					}
					break;
				case "NEG-CLOSE": {
					const reason = data[2];
					console.warn("negentropy error:", reason);
					params.onclose?.(reason);
					break;
				}
				case "NEG-ERR": params.onclose?.();
			}
		};
	}
	async start() {
		const initMsg = this.neg.initiate();
		this.relay.send(`["NEG-OPEN","${this.subscription.id}",${JSON.stringify(this.filter)},"${initMsg}"]`);
	}
	close() {
		this.relay.send(`["NEG-CLOSE","${this.subscription.id}"]`);
		this.subscription.close();
	}
};
__export({}, {
	getToken: () => getToken,
	hashPayload: () => hashPayload,
	unpackEventFromToken: () => unpackEventFromToken,
	validateEvent: () => validateEvent2,
	validateEventKind: () => validateEventKind,
	validateEventMethodTag: () => validateEventMethodTag,
	validateEventPayloadTag: () => validateEventPayloadTag,
	validateEventTimestamp: () => validateEventTimestamp,
	validateEventUrlTag: () => validateEventUrlTag,
	validateToken: () => validateToken
});
var _authorizationScheme = "Nostr ";
async function getToken(loginUrl, httpMethod, sign, includeAuthorizationScheme = false, payload) {
	const event = {
		kind: HTTPAuth,
		tags: [["u", loginUrl], ["method", httpMethod]],
		created_at: Math.round((/* @__PURE__ */ new Date()).getTime() / 1e3),
		content: ""
	};
	if (payload) event.tags.push(["payload", hashPayload(payload)]);
	const signedEvent = await sign(event);
	return (includeAuthorizationScheme ? _authorizationScheme : "") + base64.encode(utf8Encoder$1.encode(JSON.stringify(signedEvent)));
}
async function validateToken(token, url, method) {
	return await validateEvent2(await unpackEventFromToken(token).catch((error) => {
		throw error;
	}), url, method).catch((error) => {
		throw error;
	});
}
async function unpackEventFromToken(token) {
	if (!token) throw new Error("Missing token");
	token = token.replace(_authorizationScheme, "");
	const eventB64 = utf8Decoder$1.decode(base64.decode(token));
	if (!eventB64 || eventB64.length === 0 || !eventB64.startsWith("{")) throw new Error("Invalid token");
	return JSON.parse(eventB64);
}
function validateEventTimestamp(event) {
	if (!event.created_at) return false;
	return Math.round((/* @__PURE__ */ new Date()).getTime() / 1e3) - event.created_at < 60;
}
function validateEventKind(event) {
	return event.kind === HTTPAuth;
}
function validateEventUrlTag(event, url) {
	const urlTag = event.tags.find((t) => t[0] === "u");
	if (!urlTag) return false;
	return urlTag.length > 0 && urlTag[1] === url;
}
function validateEventMethodTag(event, method) {
	const methodTag = event.tags.find((t) => t[0] === "method");
	if (!methodTag) return false;
	return methodTag.length > 0 && methodTag[1].toLowerCase() === method.toLowerCase();
}
function hashPayload(payload) {
	return bytesToHex(sha256(utf8Encoder$1.encode(JSON.stringify(payload))));
}
function validateEventPayloadTag(event, payload) {
	const payloadTag = event.tags.find((t) => t[0] === "payload");
	if (!payloadTag) return false;
	const payloadHash = hashPayload(payload);
	return payloadTag.length > 0 && payloadTag[1] === payloadHash;
}
async function validateEvent2(event, url, method, body) {
	if (!verifyEvent(event)) throw new Error("Invalid nostr event, signature invalid");
	if (!validateEventKind(event)) throw new Error("Invalid nostr event, kind invalid");
	if (!validateEventTimestamp(event)) throw new Error("Invalid nostr event, created_at timestamp invalid");
	if (!validateEventUrlTag(event, url)) throw new Error("Invalid nostr event, url tag invalid");
	if (!validateEventMethodTag(event, method)) throw new Error("Invalid nostr event, method tag invalid");
	if (Boolean(body) && typeof body === "object" && Object.keys(body).length > 0) {
		if (!validateEventPayloadTag(event, body)) throw new Error("Invalid nostr event, payload tag does not match request body hash");
	}
	return true;
}
//#endregion
//#region node_modules/.pnpm/nostr-tools@2.23.3_typescript@5.9.3/node_modules/nostr-tools/lib/esm/nip04.js
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
function encrypt(secretKey, pubkey, text) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	const normalizedKey = getNormalizedX(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = Uint8Array.from(randomBytes$1(16));
	let plaintext = utf8Encoder.encode(text);
	let ciphertext = cbc(normalizedKey, iv).encrypt(plaintext);
	return `${base64.encode(new Uint8Array(ciphertext))}?iv=${base64.encode(new Uint8Array(iv.buffer))}`;
}
function decrypt(secretKey, pubkey, data) {
	const privkey = secretKey instanceof Uint8Array ? secretKey : hexToBytes(secretKey);
	let [ctb64, ivb64] = data.split("?iv=");
	let normalizedKey = getNormalizedX(secp256k1.getSharedSecret(privkey, hexToBytes("02" + pubkey)));
	let iv = base64.decode(ivb64);
	let ciphertext = base64.decode(ctb64);
	let plaintext = cbc(normalizedKey, iv).decrypt(ciphertext);
	return utf8Decoder.decode(plaintext);
}
function getNormalizedX(key) {
	return key.slice(1, 33);
}
//#endregion
//#region extensions/nostr/src/metrics.ts
/**
* Create a metrics collector instance.
* Optionally pass an onMetric callback to receive real-time metric events.
*/
function createMetrics(onMetric) {
	let eventsReceived = 0;
	let eventsProcessed = 0;
	let eventsDuplicate = 0;
	const eventsRejected = {
		invalidShape: 0,
		wrongKind: 0,
		stale: 0,
		future: 0,
		rateLimited: 0,
		invalidSignature: 0,
		oversizedCiphertext: 0,
		oversizedPlaintext: 0,
		decryptFailed: 0,
		selfMessage: 0
	};
	const relays = /* @__PURE__ */ new Map();
	const rateLimiting = {
		perSenderHits: 0,
		globalHits: 0
	};
	const decrypt = {
		success: 0,
		failure: 0
	};
	const memory = {
		seenTrackerSize: 0,
		rateLimiterEntries: 0
	};
	function getOrCreateRelay(url) {
		let relay = relays.get(url);
		if (!relay) {
			relay = {
				connects: 0,
				disconnects: 0,
				reconnects: 0,
				errors: 0,
				messagesReceived: {
					event: 0,
					eose: 0,
					closed: 0,
					notice: 0,
					ok: 0,
					auth: 0
				},
				circuitBreakerState: "closed",
				circuitBreakerOpens: 0,
				circuitBreakerCloses: 0
			};
			relays.set(url, relay);
		}
		return relay;
	}
	function emit(name, value = 1, labels) {
		if (onMetric) onMetric({
			name,
			value,
			timestamp: Date.now(),
			labels
		});
		const relayUrl = labels?.relay;
		switch (name) {
			case "event.received":
				eventsReceived += value;
				break;
			case "event.processed":
				eventsProcessed += value;
				break;
			case "event.duplicate":
				eventsDuplicate += value;
				break;
			case "event.rejected.invalid_shape":
				eventsRejected.invalidShape += value;
				break;
			case "event.rejected.wrong_kind":
				eventsRejected.wrongKind += value;
				break;
			case "event.rejected.stale":
				eventsRejected.stale += value;
				break;
			case "event.rejected.future":
				eventsRejected.future += value;
				break;
			case "event.rejected.rate_limited":
				eventsRejected.rateLimited += value;
				break;
			case "event.rejected.invalid_signature":
				eventsRejected.invalidSignature += value;
				break;
			case "event.rejected.oversized_ciphertext":
				eventsRejected.oversizedCiphertext += value;
				break;
			case "event.rejected.oversized_plaintext":
				eventsRejected.oversizedPlaintext += value;
				break;
			case "event.rejected.decrypt_failed":
				eventsRejected.decryptFailed += value;
				break;
			case "event.rejected.self_message":
				eventsRejected.selfMessage += value;
				break;
			case "relay.connect":
				if (relayUrl) getOrCreateRelay(relayUrl).connects += value;
				break;
			case "relay.disconnect":
				if (relayUrl) getOrCreateRelay(relayUrl).disconnects += value;
				break;
			case "relay.reconnect":
				if (relayUrl) getOrCreateRelay(relayUrl).reconnects += value;
				break;
			case "relay.error":
				if (relayUrl) getOrCreateRelay(relayUrl).errors += value;
				break;
			case "relay.message.event":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.event += value;
				break;
			case "relay.message.eose":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.eose += value;
				break;
			case "relay.message.closed":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.closed += value;
				break;
			case "relay.message.notice":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.notice += value;
				break;
			case "relay.message.ok":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.ok += value;
				break;
			case "relay.message.auth":
				if (relayUrl) getOrCreateRelay(relayUrl).messagesReceived.auth += value;
				break;
			case "relay.circuit_breaker.open":
				if (relayUrl) {
					const r = getOrCreateRelay(relayUrl);
					r.circuitBreakerState = "open";
					r.circuitBreakerOpens += value;
				}
				break;
			case "relay.circuit_breaker.close":
				if (relayUrl) {
					const r = getOrCreateRelay(relayUrl);
					r.circuitBreakerState = "closed";
					r.circuitBreakerCloses += value;
				}
				break;
			case "relay.circuit_breaker.half_open":
				if (relayUrl) getOrCreateRelay(relayUrl).circuitBreakerState = "half_open";
				break;
			case "rate_limit.per_sender":
				rateLimiting.perSenderHits += value;
				break;
			case "rate_limit.global":
				rateLimiting.globalHits += value;
				break;
			case "decrypt.success":
				decrypt.success += value;
				break;
			case "decrypt.failure":
				decrypt.failure += value;
				break;
			case "memory.seen_tracker_size":
				memory.seenTrackerSize = value;
				break;
			case "memory.rate_limiter_entries":
				memory.rateLimiterEntries = value;
				break;
		}
	}
	function getSnapshot() {
		const relaysObj = {};
		for (const [url, stats] of relays) relaysObj[url] = {
			...stats,
			messagesReceived: { ...stats.messagesReceived }
		};
		return {
			eventsReceived,
			eventsProcessed,
			eventsDuplicate,
			eventsRejected: { ...eventsRejected },
			relays: relaysObj,
			rateLimiting: { ...rateLimiting },
			decrypt: { ...decrypt },
			memory: { ...memory },
			snapshotAt: Date.now()
		};
	}
	function reset() {
		eventsReceived = 0;
		eventsProcessed = 0;
		eventsDuplicate = 0;
		Object.assign(eventsRejected, {
			invalidShape: 0,
			wrongKind: 0,
			stale: 0,
			future: 0,
			rateLimited: 0,
			invalidSignature: 0,
			oversizedCiphertext: 0,
			oversizedPlaintext: 0,
			decryptFailed: 0,
			selfMessage: 0
		});
		relays.clear();
		rateLimiting.perSenderHits = 0;
		rateLimiting.globalHits = 0;
		decrypt.success = 0;
		decrypt.failure = 0;
		memory.seenTrackerSize = 0;
		memory.rateLimiterEntries = 0;
	}
	return {
		emit,
		getSnapshot,
		reset
	};
}
/**
* Create a no-op metrics instance (for when metrics are disabled).
*/
function createNoopMetrics() {
	const emptySnapshot = {
		eventsReceived: 0,
		eventsProcessed: 0,
		eventsDuplicate: 0,
		eventsRejected: {
			invalidShape: 0,
			wrongKind: 0,
			stale: 0,
			future: 0,
			rateLimited: 0,
			invalidSignature: 0,
			oversizedCiphertext: 0,
			oversizedPlaintext: 0,
			decryptFailed: 0,
			selfMessage: 0
		},
		relays: {},
		rateLimiting: {
			perSenderHits: 0,
			globalHits: 0
		},
		decrypt: {
			success: 0,
			failure: 0
		},
		memory: {
			seenTrackerSize: 0,
			rateLimiterEntries: 0
		},
		snapshotAt: 0
	};
	return {
		emit: () => {},
		getSnapshot: () => ({
			...emptySnapshot,
			snapshotAt: Date.now()
		}),
		reset: () => {}
	};
}
//#endregion
//#region extensions/nostr/src/config-schema.ts
/**
* Validates https:// URLs only (no javascript:, data:, file:, etc.)
*/
const safeUrlSchema = z.string().url().refine((url) => {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}, { message: "URL must use https:// protocol" });
/**
* NIP-01 profile metadata schema
* https://github.com/nostr-protocol/nips/blob/master/01.md
*/
const NostrProfileSchema = z.object({
	name: z.string().max(256).optional(),
	displayName: z.string().max(256).optional(),
	about: z.string().max(2e3).optional(),
	picture: safeUrlSchema.optional(),
	banner: safeUrlSchema.optional(),
	website: safeUrlSchema.optional(),
	nip05: z.string().optional(),
	lud16: z.string().optional()
});
/**
* Zod schema for channels.nostr.* configuration
*/
const NostrConfigSchema = z.object({
	name: z.string().optional(),
	defaultAccount: z.string().optional(),
	enabled: z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	privateKey: z.string().optional(),
	relays: z.array(z.string()).optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	profile: NostrProfileSchema.optional()
});
buildChannelConfigSchema(NostrConfigSchema);
//#endregion
//#region extensions/nostr/src/nostr-profile.ts
/**
* Nostr Profile Management (NIP-01 kind:0)
*
* Profile events are "replaceable" - the latest created_at wins.
* This module handles profile event creation and publishing.
*/
/**
* Convert our config profile schema to NIP-01 content format.
* Strips undefined fields and validates URLs.
*/
function profileToContent(profile) {
	const validated = NostrProfileSchema.parse(profile);
	const content = {};
	if (validated.name !== void 0) content.name = validated.name;
	if (validated.displayName !== void 0) content.display_name = validated.displayName;
	if (validated.about !== void 0) content.about = validated.about;
	if (validated.picture !== void 0) content.picture = validated.picture;
	if (validated.banner !== void 0) content.banner = validated.banner;
	if (validated.website !== void 0) content.website = validated.website;
	if (validated.nip05 !== void 0) content.nip05 = validated.nip05;
	if (validated.lud16 !== void 0) content.lud16 = validated.lud16;
	return content;
}
/**
* Convert NIP-01 content format back to our config profile schema.
* Useful for importing existing profiles from relays.
*/
function contentToProfile(content) {
	const profile = {};
	if (content.name !== void 0) profile.name = content.name;
	if (content.display_name !== void 0) profile.displayName = content.display_name;
	if (content.about !== void 0) profile.about = content.about;
	if (content.picture !== void 0) profile.picture = content.picture;
	if (content.banner !== void 0) profile.banner = content.banner;
	if (content.website !== void 0) profile.website = content.website;
	if (content.nip05 !== void 0) profile.nip05 = content.nip05;
	if (content.lud16 !== void 0) profile.lud16 = content.lud16;
	return profile;
}
/**
* Create a signed kind:0 profile event.
*
* @param sk - Private key as Uint8Array (32 bytes)
* @param profile - Profile data to include
* @param lastPublishedAt - Previous profile timestamp (for monotonic guarantee)
* @returns Signed Nostr event
*/
function createProfileEvent(sk, profile, lastPublishedAt) {
	const content = profileToContent(profile);
	const contentJson = JSON.stringify(content);
	const now = Math.floor(Date.now() / 1e3);
	return finalizeEvent({
		kind: 0,
		content: contentJson,
		tags: [],
		created_at: lastPublishedAt !== void 0 ? Math.max(now, lastPublishedAt + 1) : now
	}, sk);
}
/** Per-relay publish timeout (ms) */
const RELAY_PUBLISH_TIMEOUT_MS = 5e3;
/**
* Publish a profile event to multiple relays.
*
* Best-effort: publishes to all relays in parallel, reports per-relay results.
* Does NOT retry automatically - caller should handle retries if needed.
*
* @param pool - SimplePool instance for relay connections
* @param relays - Array of relay WebSocket URLs
* @param event - Signed profile event (kind:0)
* @returns Publish results with successes and failures
*/
async function publishProfileEvent(pool, relays, event) {
	const successes = [];
	const failures = [];
	const publishPromises = relays.map(async (relay) => {
		try {
			const timeoutPromise = new Promise((_, reject) => {
				setTimeout(() => reject(/* @__PURE__ */ new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
			});
			await Promise.race([pool.publish([relay], event), timeoutPromise]);
			successes.push(relay);
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			failures.push({
				relay,
				error: errorMessage
			});
		}
	});
	await Promise.all(publishPromises);
	return {
		eventId: event.id,
		successes,
		failures,
		createdAt: event.created_at
	};
}
/**
* Create and publish a profile event in one call.
*
* @param pool - SimplePool instance
* @param sk - Private key as Uint8Array
* @param relays - Array of relay URLs
* @param profile - Profile data
* @param lastPublishedAt - Previous timestamp for monotonic ordering
* @returns Publish results
*/
async function publishProfile(pool, sk, relays, profile, lastPublishedAt) {
	return publishProfileEvent(pool, relays, createProfileEvent(sk, profile, lastPublishedAt));
}
//#endregion
//#region extensions/nostr/src/runtime.ts
const { setRuntime: setNostrRuntime, getRuntime: getNostrRuntime } = createPluginRuntimeStore("Nostr runtime not initialized");
//#endregion
//#region extensions/nostr/src/nostr-state-store.ts
const STORE_VERSION = 2;
const PROFILE_STATE_VERSION = 1;
function normalizeAccountId(accountId) {
	const trimmed = accountId?.trim();
	if (!trimmed) return "default";
	return trimmed.replace(/[^a-z0-9._-]+/gi, "_");
}
function resolveNostrStatePath(accountId, env = process.env) {
	const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "nostr", `bus-state-${normalized}.json`);
}
function resolveNostrProfileStatePath(accountId, env = process.env) {
	const stateDir = getNostrRuntime().state.resolveStateDir(env, os.homedir);
	const normalized = normalizeAccountId(accountId);
	return path.join(stateDir, "nostr", `profile-state-${normalized}.json`);
}
function safeParseState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.version === 2) return {
			version: 2,
			lastProcessedAt: typeof parsed.lastProcessedAt === "number" ? parsed.lastProcessedAt : null,
			gatewayStartedAt: typeof parsed.gatewayStartedAt === "number" ? parsed.gatewayStartedAt : null,
			recentEventIds: Array.isArray(parsed.recentEventIds) ? parsed.recentEventIds.filter((x) => typeof x === "string") : []
		};
		if (parsed?.version === 1) return {
			version: 2,
			lastProcessedAt: typeof parsed.lastProcessedAt === "number" ? parsed.lastProcessedAt : null,
			gatewayStartedAt: typeof parsed.gatewayStartedAt === "number" ? parsed.gatewayStartedAt : null,
			recentEventIds: []
		};
		return null;
	} catch {
		return null;
	}
}
async function readNostrBusState(params) {
	const filePath = resolveNostrStatePath(params.accountId, params.env);
	try {
		return safeParseState(await fs.readFile(filePath, "utf-8"));
	} catch (err) {
		if (err.code === "ENOENT") return null;
		return null;
	}
}
async function writeNostrBusState(params) {
	const filePath = resolveNostrStatePath(params.accountId, params.env);
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	const payload = {
		version: STORE_VERSION,
		lastProcessedAt: params.lastProcessedAt,
		gatewayStartedAt: params.gatewayStartedAt,
		recentEventIds: (params.recentEventIds ?? []).filter((x) => typeof x === "string")
	};
	await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8" });
	await fs.chmod(tmp, 384);
	await fs.rename(tmp, filePath);
}
/**
* Determine the `since` timestamp for subscription.
* Returns the later of: lastProcessedAt or gatewayStartedAt (both from disk),
* falling back to `now` for fresh starts.
*/
function computeSinceTimestamp(state, nowSec = Math.floor(Date.now() / 1e3)) {
	if (!state) return nowSec;
	const candidates = [state.lastProcessedAt, state.gatewayStartedAt].filter((t) => t !== null && t > 0);
	if (candidates.length === 0) return nowSec;
	return Math.max(...candidates);
}
function safeParseProfileState(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed?.version === 1) return {
			version: 1,
			lastPublishedAt: typeof parsed.lastPublishedAt === "number" ? parsed.lastPublishedAt : null,
			lastPublishedEventId: typeof parsed.lastPublishedEventId === "string" ? parsed.lastPublishedEventId : null,
			lastPublishResults: parsed.lastPublishResults && typeof parsed.lastPublishResults === "object" ? parsed.lastPublishResults : null
		};
		return null;
	} catch {
		return null;
	}
}
async function readNostrProfileState(params) {
	const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
	try {
		return safeParseProfileState(await fs.readFile(filePath, "utf-8"));
	} catch (err) {
		if (err.code === "ENOENT") return null;
		return null;
	}
}
async function writeNostrProfileState(params) {
	const filePath = resolveNostrProfileStatePath(params.accountId, params.env);
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
	const payload = {
		version: PROFILE_STATE_VERSION,
		lastPublishedAt: params.lastPublishedAt,
		lastPublishedEventId: params.lastPublishedEventId,
		lastPublishResults: params.lastPublishResults
	};
	await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8" });
	await fs.chmod(tmp, 384);
	await fs.rename(tmp, filePath);
}
//#endregion
//#region extensions/nostr/src/seen-tracker.ts
/**
* Create a new seen tracker with LRU eviction and TTL expiration.
*/
function createSeenTracker(options) {
	const maxEntries = options?.maxEntries ?? 1e5;
	const ttlMs = options?.ttlMs ?? 3600 * 1e3;
	const pruneIntervalMs = options?.pruneIntervalMs ?? 600 * 1e3;
	const entries = /* @__PURE__ */ new Map();
	let head = null;
	let tail = null;
	function moveToFront(id) {
		const entry = entries.get(id);
		if (!entry) return;
		if (head === id) return;
		if (entry.prev) {
			const prevEntry = entries.get(entry.prev);
			if (prevEntry) prevEntry.next = entry.next;
		}
		if (entry.next) {
			const nextEntry = entries.get(entry.next);
			if (nextEntry) nextEntry.prev = entry.prev;
		}
		if (tail === id) tail = entry.prev;
		entry.prev = null;
		entry.next = head;
		if (head) {
			const headEntry = entries.get(head);
			if (headEntry) headEntry.prev = id;
		}
		head = id;
		if (!tail) tail = id;
	}
	function removeFromList(id) {
		const entry = entries.get(id);
		if (!entry) return;
		if (entry.prev) {
			const prevEntry = entries.get(entry.prev);
			if (prevEntry) prevEntry.next = entry.next;
		} else head = entry.next;
		if (entry.next) {
			const nextEntry = entries.get(entry.next);
			if (nextEntry) nextEntry.prev = entry.prev;
		} else tail = entry.prev;
	}
	function evictLRU() {
		if (!tail) return;
		const idToEvict = tail;
		removeFromList(idToEvict);
		entries.delete(idToEvict);
	}
	function insertAtFront(id, seenAt) {
		const newEntry = {
			seenAt,
			prev: null,
			next: head
		};
		if (head) {
			const headEntry = entries.get(head);
			if (headEntry) headEntry.prev = id;
		}
		entries.set(id, newEntry);
		head = id;
		if (!tail) tail = id;
	}
	function pruneExpired() {
		const now = Date.now();
		const toDelete = [];
		for (const [id, entry] of entries) if (now - entry.seenAt > ttlMs) toDelete.push(id);
		for (const id of toDelete) {
			removeFromList(id);
			entries.delete(id);
		}
	}
	let pruneTimer;
	if (pruneIntervalMs > 0) {
		pruneTimer = setInterval(pruneExpired, pruneIntervalMs);
		if (pruneTimer.unref) pruneTimer.unref();
	}
	function add(id) {
		const now = Date.now();
		const existing = entries.get(id);
		if (existing) {
			existing.seenAt = now;
			moveToFront(id);
			return;
		}
		while (entries.size >= maxEntries) evictLRU();
		insertAtFront(id, now);
	}
	function has(id) {
		const entry = entries.get(id);
		if (!entry) {
			add(id);
			return false;
		}
		if (Date.now() - entry.seenAt > ttlMs) {
			removeFromList(id);
			entries.delete(id);
			add(id);
			return false;
		}
		entry.seenAt = Date.now();
		moveToFront(id);
		return true;
	}
	function peek(id) {
		const entry = entries.get(id);
		if (!entry) return false;
		if (Date.now() - entry.seenAt > ttlMs) {
			removeFromList(id);
			entries.delete(id);
			return false;
		}
		return true;
	}
	function deleteEntry(id) {
		if (entries.has(id)) {
			removeFromList(id);
			entries.delete(id);
		}
	}
	function clear() {
		entries.clear();
		head = null;
		tail = null;
	}
	function size() {
		return entries.size;
	}
	function stop() {
		if (pruneTimer) {
			clearInterval(pruneTimer);
			pruneTimer = void 0;
		}
	}
	function seed(ids) {
		const now = Date.now();
		for (let i = ids.length - 1; i >= 0; i--) {
			const id = ids[i];
			if (!entries.has(id) && entries.size < maxEntries) insertAtFront(id, now);
		}
	}
	return {
		has,
		add,
		peek,
		delete: deleteEntry,
		clear,
		size,
		stop,
		seed
	};
}
//#endregion
//#region extensions/nostr/src/nostr-bus.ts
const STARTUP_LOOKBACK_SEC = 120;
const MAX_PERSISTED_EVENT_IDS = 5e3;
const STATE_PERSIST_DEBOUNCE_MS = 5e3;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 3e4;
const HEALTH_WINDOW_MS = 6e4;
function createCircuitBreaker(relay, metrics, threshold = CIRCUIT_BREAKER_THRESHOLD, resetMs = CIRCUIT_BREAKER_RESET_MS) {
	const state = {
		state: "closed",
		failures: 0,
		lastFailure: 0,
		lastSuccess: Date.now()
	};
	return {
		canAttempt() {
			if (state.state === "closed") return true;
			if (state.state === "open") {
				if (Date.now() - state.lastFailure >= resetMs) {
					state.state = "half_open";
					metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
					return true;
				}
				return false;
			}
			return true;
		},
		recordSuccess() {
			if (state.state === "half_open") {
				state.state = "closed";
				state.failures = 0;
				metrics.emit("relay.circuit_breaker.close", 1, { relay });
			} else if (state.state === "closed") state.failures = 0;
			state.lastSuccess = Date.now();
		},
		recordFailure() {
			state.failures++;
			state.lastFailure = Date.now();
			if (state.state === "half_open") {
				state.state = "open";
				metrics.emit("relay.circuit_breaker.open", 1, { relay });
			} else if (state.state === "closed" && state.failures >= threshold) {
				state.state = "open";
				metrics.emit("relay.circuit_breaker.open", 1, { relay });
			}
		},
		getState() {
			return state.state;
		}
	};
}
function createRelayHealthTracker() {
	const stats = /* @__PURE__ */ new Map();
	function getOrCreate(relay) {
		let s = stats.get(relay);
		if (!s) {
			s = {
				successCount: 0,
				failureCount: 0,
				latencySum: 0,
				latencyCount: 0,
				lastSuccess: 0,
				lastFailure: 0
			};
			stats.set(relay, s);
		}
		return s;
	}
	return {
		recordSuccess(relay, latencyMs) {
			const s = getOrCreate(relay);
			s.successCount++;
			s.latencySum += latencyMs;
			s.latencyCount++;
			s.lastSuccess = Date.now();
		},
		recordFailure(relay) {
			const s = getOrCreate(relay);
			s.failureCount++;
			s.lastFailure = Date.now();
		},
		getScore(relay) {
			const s = stats.get(relay);
			if (!s) return .5;
			const total = s.successCount + s.failureCount;
			if (total === 0) return .5;
			const successRate = s.successCount / total;
			const now = Date.now();
			const recencyBonus = s.lastSuccess > s.lastFailure ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * .2 : 0;
			const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1e3;
			const latencyPenalty = Math.min(.2, avgLatency / 1e4);
			return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
		},
		getSortedRelays(relays) {
			return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
		}
	};
}
/**
* Validate and normalize a private key (accepts hex or nsec format)
*/
function validatePrivateKey(key) {
	const trimmed = key.trim();
	if (trimmed.startsWith("nsec1")) {
		const decoded = nip19_exports.decode(trimmed);
		if (decoded.type !== "nsec") throw new Error("Invalid nsec key: wrong type");
		return decoded.data;
	}
	if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("Private key must be 64 hex characters or nsec bech32 format");
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
/**
* Get public key from private key (hex or nsec format)
*/
function getPublicKeyFromPrivate(privateKey) {
	return getPublicKey(validatePrivateKey(privateKey));
}
/**
* Start the Nostr DM bus - subscribes to NIP-04 encrypted DMs
*/
async function startNostrBus(options) {
	const { privateKey, relays = DEFAULT_RELAYS, onMessage, onError, onEose, onMetric, maxSeenEntries = 1e5, seenTtlMs = 3600 * 1e3 } = options;
	const sk = validatePrivateKey(privateKey);
	const pk = getPublicKey(sk);
	const pool = new SimplePool();
	const accountId = options.accountId ?? pk.slice(0, 16);
	const gatewayStartedAt = Math.floor(Date.now() / 1e3);
	const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();
	const seen = createSeenTracker({
		maxEntries: maxSeenEntries,
		ttlMs: seenTtlMs
	});
	const circuitBreakers = /* @__PURE__ */ new Map();
	const healthTracker = createRelayHealthTracker();
	for (const relay of relays) circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
	const state = await readNostrBusState({ accountId });
	const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
	const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);
	if (state?.recentEventIds?.length) seen.seed(state.recentEventIds);
	await writeNostrBusState({
		accountId,
		lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
		gatewayStartedAt,
		recentEventIds: state?.recentEventIds ?? []
	});
	let pendingWrite;
	let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
	let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);
	function scheduleStatePersist(eventCreatedAt, eventId) {
		lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
		recentEventIds.push(eventId);
		if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
		if (pendingWrite) clearTimeout(pendingWrite);
		pendingWrite = setTimeout(() => {
			writeNostrBusState({
				accountId,
				lastProcessedAt,
				gatewayStartedAt,
				recentEventIds
			}).catch((err) => onError?.(err, "persist state"));
		}, STATE_PERSIST_DEBOUNCE_MS);
	}
	const inflight = /* @__PURE__ */ new Set();
	async function handleEvent(event) {
		try {
			metrics.emit("event.received");
			if (seen.peek(event.id) || inflight.has(event.id)) {
				metrics.emit("event.duplicate");
				return;
			}
			inflight.add(event.id);
			if (event.pubkey === pk) {
				metrics.emit("event.rejected.self_message");
				return;
			}
			if (event.created_at < since) {
				metrics.emit("event.rejected.stale");
				return;
			}
			let targetsUs = false;
			for (const t of event.tags) if (t[0] === "p" && t[1] === pk) {
				targetsUs = true;
				break;
			}
			if (!targetsUs) {
				metrics.emit("event.rejected.wrong_kind");
				return;
			}
			if (!verifyEvent(event)) {
				metrics.emit("event.rejected.invalid_signature");
				onError?.(/* @__PURE__ */ new Error("Invalid signature"), `event ${event.id}`);
				return;
			}
			seen.add(event.id);
			metrics.emit("memory.seen_tracker_size", seen.size());
			let plaintext;
			try {
				plaintext = decrypt(sk, event.pubkey, event.content);
				metrics.emit("decrypt.success");
			} catch (err) {
				metrics.emit("decrypt.failure");
				metrics.emit("event.rejected.decrypt_failed");
				onError?.(err, `decrypt from ${event.pubkey}`);
				return;
			}
			const replyTo = async (text) => {
				await sendEncryptedDm(pool, sk, event.pubkey, text, relays, metrics, circuitBreakers, healthTracker, onError);
			};
			await onMessage(event.pubkey, plaintext, replyTo);
			metrics.emit("event.processed");
			scheduleStatePersist(event.created_at, event.id);
		} catch (err) {
			onError?.(err, `event ${event.id}`);
		} finally {
			inflight.delete(event.id);
		}
	}
	const sub = pool.subscribeMany(relays, [{
		kinds: [4],
		"#p": [pk],
		since
	}], {
		onevent: handleEvent,
		oneose: () => {
			for (const relay of relays) metrics.emit("relay.message.eose", 1, { relay });
			onEose?.(relays.join(", "));
		},
		onclose: (reason) => {
			for (const relay of relays) {
				metrics.emit("relay.message.closed", 1, { relay });
				options.onDisconnect?.(relay);
			}
			onError?.(/* @__PURE__ */ new Error(`Subscription closed: ${reason.join(", ")}`), "subscription");
		}
	});
	const sendDm = async (toPubkey, text) => {
		await sendEncryptedDm(pool, sk, toPubkey, text, relays, metrics, circuitBreakers, healthTracker, onError);
	};
	const publishProfile$1 = async (profile) => {
		const result = await publishProfile(pool, sk, relays, profile, (await readNostrProfileState({ accountId }))?.lastPublishedAt ?? void 0);
		const publishResults = {};
		for (const relay of result.successes) publishResults[relay] = "ok";
		for (const { relay, error } of result.failures) publishResults[relay] = error === "timeout" ? "timeout" : "failed";
		await writeNostrProfileState({
			accountId,
			lastPublishedAt: result.createdAt,
			lastPublishedEventId: result.eventId,
			lastPublishResults: publishResults
		});
		return result;
	};
	const getProfileState = async () => {
		const state = await readNostrProfileState({ accountId });
		return {
			lastPublishedAt: state?.lastPublishedAt ?? null,
			lastPublishedEventId: state?.lastPublishedEventId ?? null,
			lastPublishResults: state?.lastPublishResults ?? null
		};
	};
	return {
		close: () => {
			sub.close();
			seen.stop();
			if (pendingWrite) {
				clearTimeout(pendingWrite);
				writeNostrBusState({
					accountId,
					lastProcessedAt,
					gatewayStartedAt,
					recentEventIds
				}).catch((err) => onError?.(err, "persist state on close"));
			}
		},
		publicKey: pk,
		sendDm,
		getMetrics: () => metrics.getSnapshot(),
		publishProfile: publishProfile$1,
		getProfileState
	};
}
/**
* Send an encrypted DM to a pubkey
*/
async function sendEncryptedDm(pool, sk, toPubkey, text, relays, metrics, circuitBreakers, healthTracker, onError) {
	const reply = finalizeEvent({
		kind: 4,
		content: encrypt(sk, toPubkey, text),
		tags: [["p", toPubkey]],
		created_at: Math.floor(Date.now() / 1e3)
	}, sk);
	const sortedRelays = healthTracker.getSortedRelays(relays);
	let lastError;
	for (const relay of sortedRelays) {
		const cb = circuitBreakers.get(relay);
		if (cb && !cb.canAttempt()) continue;
		const startTime = Date.now();
		try {
			await pool.publish([relay], reply);
			const latency = Date.now() - startTime;
			cb?.recordSuccess();
			healthTracker.recordSuccess(relay, latency);
			return;
		} catch (err) {
			lastError = err;
			const latency = Date.now() - startTime;
			cb?.recordFailure();
			healthTracker.recordFailure(relay);
			metrics.emit("relay.error", 1, {
				relay,
				latency
			});
			onError?.(lastError, `publish to ${relay}`);
		}
	}
	throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
}
/**
* Normalize a pubkey to hex format (accepts npub or hex)
*/
function normalizePubkey(input) {
	const trimmed = input.trim();
	if (trimmed.startsWith("npub1")) {
		const decoded = nip19_exports.decode(trimmed);
		if (decoded.type !== "npub") throw new Error("Invalid npub key");
		return Array.from(decoded.data).map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error("Pubkey must be 64 hex characters or npub format");
	return trimmed.toLowerCase();
}
//#endregion
//#region extensions/nostr/src/types.ts
function resolveConfiguredDefaultNostrAccountId(cfg) {
	const nostrCfg = cfg.channels?.nostr;
	return normalizeOptionalAccountId(nostrCfg?.defaultAccount);
}
/**
* List all configured Nostr account IDs
*/
function listNostrAccountIds(cfg) {
	if ((cfg.channels?.nostr)?.privateKey) return [resolveConfiguredDefaultNostrAccountId(cfg) ?? "default"];
	return [];
}
/**
* Get the default account ID
*/
function resolveDefaultNostrAccountId(cfg) {
	const preferred = resolveConfiguredDefaultNostrAccountId(cfg);
	if (preferred) return preferred;
	const ids = listNostrAccountIds(cfg);
	if (ids.includes("default")) return DEFAULT_ACCOUNT_ID;
	return ids[0] ?? "default";
}
/**
* Resolve a Nostr account from config
*/
function resolveNostrAccount(opts) {
	const accountId = normalizeAccountId$1(opts.accountId ?? resolveDefaultNostrAccountId(opts.cfg));
	const nostrCfg = opts.cfg.channels?.nostr;
	const baseEnabled = nostrCfg?.enabled !== false;
	const privateKey = nostrCfg?.privateKey ?? "";
	const configured = Boolean(privateKey.trim());
	let publicKey = "";
	if (configured) try {
		publicKey = getPublicKeyFromPrivate(privateKey);
	} catch {}
	return {
		accountId,
		name: nostrCfg?.name?.trim() || void 0,
		enabled: baseEnabled,
		configured,
		privateKey,
		publicKey,
		relays: nostrCfg?.relays ?? DEFAULT_RELAYS,
		profile: nostrCfg?.profile,
		config: {
			enabled: nostrCfg?.enabled,
			name: nostrCfg?.name,
			privateKey: nostrCfg?.privateKey,
			relays: nostrCfg?.relays,
			dmPolicy: nostrCfg?.dmPolicy,
			allowFrom: nostrCfg?.allowFrom,
			profile: nostrCfg?.profile
		}
	};
}
//#endregion
//#region extensions/nostr/src/setup-surface.ts
init_session_key();
const channel = "nostr";
const NOSTR_SETUP_HELP_LINES = [
	"Use a Nostr private key in nsec or 64-character hex format.",
	"Relay URLs are optional. Leave blank to keep the default relay set.",
	"Env vars supported: NOSTR_PRIVATE_KEY (default account only).",
	`Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`
];
const NOSTR_ALLOW_FROM_HELP_LINES = [
	"Allowlist Nostr DMs by npub or hex pubkey.",
	"Examples:",
	"- npub1...",
	"- nostr:npub1...",
	"- 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"Multiple entries: comma-separated.",
	`Docs: ${formatDocsLink("/channels/nostr", "channels/nostr")}`
];
function patchNostrConfig(params) {
	const nextNostr = { ...params.cfg.channels?.nostr ?? {} };
	for (const field of params.clearFields ?? []) delete nextNostr[field];
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			nostr: {
				...nextNostr,
				...params.enabled ? { enabled: true } : {},
				...params.patch
			}
		}
	};
}
function setNostrDmPolicy(cfg, dmPolicy) {
	return setTopLevelChannelDmPolicyWithAllowFrom({
		cfg,
		channel,
		dmPolicy
	});
}
function setNostrAllowFrom(cfg, allowFrom) {
	return setTopLevelChannelAllowFrom({
		cfg,
		channel,
		allowFrom
	});
}
function parseRelayUrls(raw) {
	const entries = splitSetupEntries(raw);
	const relays = [];
	for (const entry of entries) {
		try {
			const parsed = new URL(entry);
			if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return {
				relays: [],
				error: `Relay must use ws:// or wss:// (${entry})`
			};
		} catch {
			return {
				relays: [],
				error: `Invalid relay URL: ${entry}`
			};
		}
		relays.push(entry);
	}
	return { relays: [...new Set(relays)] };
}
function parseNostrAllowFrom(raw) {
	return parseSetupEntriesWithParser(raw, (entry) => {
		const cleaned = entry.replace(/^nostr:/i, "").trim();
		try {
			return { value: normalizePubkey(cleaned) };
		} catch {
			return { error: `Invalid Nostr pubkey: ${entry}` };
		}
	});
}
async function promptNostrAllowFrom(params) {
	const existing = params.cfg.channels?.nostr?.allowFrom ?? [];
	await params.prompter.note(NOSTR_ALLOW_FROM_HELP_LINES.join("\n"), "Nostr allowlist");
	const entry = await params.prompter.text({
		message: "Nostr allowFrom",
		placeholder: "npub1..., 0123abcd...",
		initialValue: existing[0] ? String(existing[0]) : void 0,
		validate: (value) => {
			const raw = String(value ?? "").trim();
			if (!raw) return "Required";
			return parseNostrAllowFrom(raw).error;
		}
	});
	const parsed = parseNostrAllowFrom(String(entry));
	return setNostrAllowFrom(params.cfg, mergeAllowFromEntries(existing, parsed.entries));
}
const nostrDmPolicy = {
	label: "Nostr",
	channel,
	policyKey: "channels.nostr.dmPolicy",
	allowFromKey: "channels.nostr.allowFrom",
	getCurrent: (cfg) => cfg.channels?.nostr?.dmPolicy ?? "pairing",
	setPolicy: (cfg, policy) => setNostrDmPolicy(cfg, policy),
	promptAllowFrom: promptNostrAllowFrom
};
const nostrSetupAdapter = {
	resolveAccountId: () => DEFAULT_ACCOUNT_ID,
	applyAccountName: ({ cfg, name }) => patchNostrConfig({
		cfg,
		patch: name?.trim() ? { name: name.trim() } : {}
	}),
	validateInput: ({ input }) => {
		const typedInput = input;
		if (!typedInput.useEnv) {
			const privateKey = typedInput.privateKey?.trim();
			if (!privateKey) return "Nostr requires --private-key or --use-env.";
			try {
				getPublicKeyFromPrivate(privateKey);
			} catch {
				return "Nostr private key must be valid nsec or 64-character hex.";
			}
		}
		if (typedInput.relayUrls?.trim()) return parseRelayUrls(typedInput.relayUrls).error ?? null;
		return null;
	},
	applyAccountConfig: ({ cfg, input }) => {
		const typedInput = input;
		const relayResult = typedInput.relayUrls?.trim() ? parseRelayUrls(typedInput.relayUrls) : { relays: [] };
		return patchNostrConfig({
			cfg,
			enabled: true,
			clearFields: typedInput.useEnv ? ["privateKey"] : void 0,
			patch: {
				...typedInput.useEnv ? {} : { privateKey: typedInput.privateKey?.trim() },
				...relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}
			}
		});
	}
};
const nostrSetupWizard = {
	channel,
	resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
	resolveShouldPromptAccountIds: () => false,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs private key",
		configuredHint: "configured",
		unconfiguredHint: "needs private key",
		configuredScore: 1,
		unconfiguredScore: 0,
		resolveConfigured: ({ cfg }) => resolveNostrAccount({ cfg }).configured,
		resolveStatusLines: ({ cfg, configured }) => {
			const account = resolveNostrAccount({ cfg });
			return [`Nostr: ${configured ? "configured" : "needs private key"}`, `Relays: ${account.relays.length || DEFAULT_RELAYS.length}`];
		}
	},
	introNote: {
		title: "Nostr setup",
		lines: NOSTR_SETUP_HELP_LINES
	},
	envShortcut: {
		prompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
		preferredEnvVar: "NOSTR_PRIVATE_KEY",
		isAvailable: ({ cfg, accountId }) => accountId === "default" && Boolean(process.env.NOSTR_PRIVATE_KEY?.trim()) && !resolveNostrAccount({
			cfg,
			accountId
		}).config.privateKey?.trim(),
		apply: async ({ cfg }) => patchNostrConfig({
			cfg,
			enabled: true,
			clearFields: ["privateKey"],
			patch: {}
		})
	},
	credentials: [{
		inputKey: "privateKey",
		providerHint: channel,
		credentialLabel: "private key",
		preferredEnvVar: "NOSTR_PRIVATE_KEY",
		helpTitle: "Nostr private key",
		helpLines: NOSTR_SETUP_HELP_LINES,
		envPrompt: "NOSTR_PRIVATE_KEY detected. Use env var?",
		keepPrompt: "Nostr private key already configured. Keep it?",
		inputPrompt: "Nostr private key (nsec... or hex)",
		allowEnv: ({ accountId }) => accountId === DEFAULT_ACCOUNT_ID,
		inspect: ({ cfg, accountId }) => {
			const account = resolveNostrAccount({
				cfg,
				accountId
			});
			return {
				accountConfigured: account.configured,
				hasConfiguredValue: Boolean(account.config.privateKey?.trim()),
				resolvedValue: account.config.privateKey?.trim(),
				envValue: process.env.NOSTR_PRIVATE_KEY?.trim()
			};
		},
		applyUseEnv: async ({ cfg }) => patchNostrConfig({
			cfg,
			enabled: true,
			clearFields: ["privateKey"],
			patch: {}
		}),
		applySet: async ({ cfg, resolvedValue }) => patchNostrConfig({
			cfg,
			enabled: true,
			patch: { privateKey: resolvedValue }
		})
	}],
	textInputs: [{
		inputKey: "relayUrls",
		message: "Relay URLs (comma-separated, optional)",
		placeholder: DEFAULT_RELAYS.join(", "),
		required: false,
		applyEmptyValue: true,
		helpTitle: "Nostr relays",
		helpLines: ["Use ws:// or wss:// relay URLs.", "Leave blank to keep the default relay set."],
		currentValue: ({ cfg, accountId }) => {
			const account = resolveNostrAccount({
				cfg,
				accountId
			});
			return (cfg.channels?.nostr?.relays && cfg.channels.nostr.relays.length > 0 ? account.relays : []).join(", ");
		},
		keepPrompt: (value) => `Relay URLs set (${value}). Keep them?`,
		validate: ({ value }) => parseRelayUrls(value).error,
		applySet: async ({ cfg, value }) => {
			const relayResult = parseRelayUrls(value);
			return patchNostrConfig({
				cfg,
				enabled: true,
				clearFields: relayResult.relays.length > 0 ? void 0 : ["relays"],
				patch: relayResult.relays.length > 0 ? { relays: relayResult.relays } : {}
			});
		}
	}],
	dmPolicy: nostrDmPolicy,
	disable: (cfg) => patchNostrConfig({
		cfg,
		patch: { enabled: false }
	})
};
//#endregion
//#region src/plugin-sdk/nostr.ts
init_session_key();
//#endregion
//#region extensions/nostr/src/channel.ts
const activeBuses = /* @__PURE__ */ new Map();
const metricsSnapshots = /* @__PURE__ */ new Map();
const nostrPlugin = {
	id: "nostr",
	meta: {
		id: "nostr",
		label: "Nostr",
		selectionLabel: "Nostr",
		docsPath: "/channels/nostr",
		docsLabel: "nostr",
		blurb: "Decentralized DMs via Nostr relays (NIP-04)",
		order: 100
	},
	capabilities: {
		chatTypes: ["direct"],
		media: false
	},
	reload: { configPrefixes: ["channels.nostr"] },
	configSchema: buildChannelConfigSchema(NostrConfigSchema),
	setup: nostrSetupAdapter,
	setupWizard: nostrSetupWizard,
	config: {
		listAccountIds: (cfg) => listNostrAccountIds(cfg),
		resolveAccount: (cfg, accountId) => resolveNostrAccount({
			cfg,
			accountId
		}),
		defaultAccountId: (cfg) => resolveDefaultNostrAccountId(cfg),
		isConfigured: (account) => account.configured,
		describeAccount: (account) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			publicKey: account.publicKey
		}),
		resolveAllowFrom: ({ cfg, accountId }) => mapAllowFromEntries(resolveNostrAccount({
			cfg,
			accountId
		}).config.allowFrom),
		formatAllowFrom: ({ allowFrom }) => allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => {
			if (entry === "*") return "*";
			try {
				return normalizePubkey(entry);
			} catch {
				return entry;
			}
		}).filter(Boolean)
	},
	pairing: {
		idLabel: "nostrPubkey",
		normalizeAllowEntry: (entry) => {
			try {
				return normalizePubkey(entry.replace(/^nostr:/i, ""));
			} catch {
				return entry;
			}
		},
		notifyApproval: async ({ id }) => {
			const bus = activeBuses.get(DEFAULT_ACCOUNT_ID);
			if (bus) await bus.sendDm(id, "Your pairing request has been approved!");
		}
	},
	security: { resolveDmPolicy: ({ account }) => {
		return {
			policy: account.config.dmPolicy ?? "pairing",
			allowFrom: account.config.allowFrom ?? [],
			policyPath: "channels.nostr.dmPolicy",
			allowFromPath: "channels.nostr.allowFrom",
			approveHint: formatPairingApproveHint("nostr"),
			normalizeEntry: (raw) => {
				try {
					return normalizePubkey(raw.replace(/^nostr:/i, "").trim());
				} catch {
					return raw.trim();
				}
			}
		};
	} },
	messaging: {
		normalizeTarget: (target) => {
			const cleaned = target.replace(/^nostr:/i, "").trim();
			try {
				return normalizePubkey(cleaned);
			} catch {
				return cleaned;
			}
		},
		targetResolver: {
			looksLikeId: (input) => {
				const trimmed = input.trim();
				return trimmed.startsWith("npub1") || /^[0-9a-fA-F]{64}$/.test(trimmed);
			},
			hint: "<npub|hex pubkey|nostr:npub...>"
		}
	},
	outbound: {
		deliveryMode: "direct",
		textChunkLimit: 4e3,
		sendText: async ({ cfg, to, text, accountId }) => {
			const core = getNostrRuntime();
			const aid = accountId ?? "default";
			const bus = activeBuses.get(aid);
			if (!bus) throw new Error(`Nostr bus not running for account ${aid}`);
			const tableMode = core.channel.text.resolveMarkdownTableMode({
				cfg,
				channel: "nostr",
				accountId: aid
			});
			const message = core.channel.text.convertMarkdownTables(text ?? "", tableMode);
			const normalizedTo = normalizePubkey(to);
			await bus.sendDm(normalizedTo, message);
			return {
				channel: "nostr",
				to: normalizedTo,
				messageId: `nostr-${Date.now()}`
			};
		}
	},
	status: {
		defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
		collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
		buildChannelSummary: ({ snapshot }) => buildPassiveChannelStatusSummary(snapshot, { publicKey: snapshot.publicKey ?? null }),
		buildAccountSnapshot: ({ account, runtime }) => ({
			accountId: account.accountId,
			name: account.name,
			enabled: account.enabled,
			configured: account.configured,
			publicKey: account.publicKey,
			profile: account.profile,
			running: runtime?.running ?? false,
			lastStartAt: runtime?.lastStartAt ?? null,
			lastStopAt: runtime?.lastStopAt ?? null,
			lastError: runtime?.lastError ?? null,
			...buildTrafficStatusSummary(runtime)
		})
	},
	gateway: { startAccount: async (ctx) => {
		const account = ctx.account;
		ctx.setStatus({
			accountId: account.accountId,
			publicKey: account.publicKey
		});
		ctx.log?.info(`[${account.accountId}] starting Nostr provider (pubkey: ${account.publicKey})`);
		if (!account.configured) throw new Error("Nostr private key not configured");
		const runtime = getNostrRuntime();
		let busHandle = null;
		const bus = await startNostrBus({
			accountId: account.accountId,
			privateKey: account.privateKey,
			relays: account.relays,
			onMessage: async (senderPubkey, text, reply) => {
				ctx.log?.debug?.(`[${account.accountId}] DM from ${senderPubkey}: ${text.slice(0, 50)}...`);
				await runtime.channel.reply.handleInboundMessage?.({
					channel: "nostr",
					accountId: account.accountId,
					senderId: senderPubkey,
					chatType: "direct",
					chatId: senderPubkey,
					text,
					reply: async (responseText) => {
						await reply(responseText);
					}
				});
			},
			onError: (error, context) => {
				ctx.log?.error?.(`[${account.accountId}] Nostr error (${context}): ${error.message}`);
			},
			onConnect: (relay) => {
				ctx.log?.debug?.(`[${account.accountId}] Connected to relay: ${relay}`);
			},
			onDisconnect: (relay) => {
				ctx.log?.debug?.(`[${account.accountId}] Disconnected from relay: ${relay}`);
			},
			onEose: (relays) => {
				ctx.log?.debug?.(`[${account.accountId}] EOSE received from relays: ${relays}`);
			},
			onMetric: (event) => {
				if (event.name.startsWith("event.rejected.")) ctx.log?.debug?.(`[${account.accountId}] Metric: ${event.name} ${JSON.stringify(event.labels)}`);
				else if (event.name === "relay.circuit_breaker.open") ctx.log?.warn?.(`[${account.accountId}] Circuit breaker opened for relay: ${event.labels?.relay}`);
				else if (event.name === "relay.circuit_breaker.close") ctx.log?.info?.(`[${account.accountId}] Circuit breaker closed for relay: ${event.labels?.relay}`);
				else if (event.name === "relay.error") ctx.log?.debug?.(`[${account.accountId}] Relay error: ${event.labels?.relay}`);
				if (busHandle) metricsSnapshots.set(account.accountId, busHandle.getMetrics());
			}
		});
		busHandle = bus;
		activeBuses.set(account.accountId, bus);
		ctx.log?.info(`[${account.accountId}] Nostr provider started, connected to ${account.relays.length} relay(s)`);
		return { stop: () => {
			bus.close();
			activeBuses.delete(account.accountId);
			metricsSnapshots.delete(account.accountId);
			ctx.log?.info(`[${account.accountId}] Nostr provider stopped`);
		} };
	} }
};
/**
* Publish a profile (kind:0) for a Nostr account.
* @param accountId - Account ID (defaults to "default")
* @param profile - Profile data to publish
* @returns Publish results with successes and failures
* @throws Error if account is not running
*/
async function publishNostrProfile(accountId = DEFAULT_ACCOUNT_ID, profile) {
	const bus = activeBuses.get(accountId);
	if (!bus) throw new Error(`Nostr bus not running for account ${accountId}`);
	return bus.publishProfile(profile);
}
/**
* Get profile publish state for a Nostr account.
* @param accountId - Account ID (defaults to "default")
* @returns Profile publish state or null if account not running
*/
async function getNostrProfileState(accountId = DEFAULT_ACCOUNT_ID) {
	const bus = activeBuses.get(accountId);
	if (!bus) return null;
	return bus.getProfileState();
}
//#endregion
export { getNostrRuntime as a, NostrProfileSchema as c, resolveNostrAccount as i, SimplePool as l, nostrPlugin as n, setNostrRuntime as o, publishNostrProfile as r, contentToProfile as s, getNostrProfileState as t, verifyEvent as u };
