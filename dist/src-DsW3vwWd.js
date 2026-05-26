import { i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { t as require_src$1 } from "./src-BbQYZdr4.js";
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/digest.js
var require_digest = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$17 = __require("crypto");
	const digest = (algorithm, data) => (0, crypto_1$17.createHash)(algorithm).update(data).digest();
	exports.default = digest;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/buffer_utils.js
var require_buffer_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.concatKdf = exports.lengthAndInput = exports.uint32be = exports.uint64be = exports.p2s = exports.concat = exports.decoder = exports.encoder = void 0;
	const digest_js_1 = require_digest();
	exports.encoder = new TextEncoder();
	exports.decoder = new TextDecoder();
	const MAX_INT32 = 2 ** 32;
	function concat(...buffers) {
		const size = buffers.reduce((acc, { length }) => acc + length, 0);
		const buf = new Uint8Array(size);
		let i = 0;
		buffers.forEach((buffer) => {
			buf.set(buffer, i);
			i += buffer.length;
		});
		return buf;
	}
	exports.concat = concat;
	function p2s(alg, p2sInput) {
		return concat(exports.encoder.encode(alg), new Uint8Array([0]), p2sInput);
	}
	exports.p2s = p2s;
	function writeUInt32BE(buf, value, offset) {
		if (value < 0 || value >= MAX_INT32) throw new RangeError(`value must be >= 0 and <= ${MAX_INT32 - 1}. Received ${value}`);
		buf.set([
			value >>> 24,
			value >>> 16,
			value >>> 8,
			value & 255
		], offset);
	}
	function uint64be(value) {
		const high = Math.floor(value / MAX_INT32);
		const low = value % MAX_INT32;
		const buf = new Uint8Array(8);
		writeUInt32BE(buf, high, 0);
		writeUInt32BE(buf, low, 4);
		return buf;
	}
	exports.uint64be = uint64be;
	function uint32be(value) {
		const buf = new Uint8Array(4);
		writeUInt32BE(buf, value);
		return buf;
	}
	exports.uint32be = uint32be;
	function lengthAndInput(input) {
		return concat(uint32be(input.length), input);
	}
	exports.lengthAndInput = lengthAndInput;
	async function concatKdf(secret, bits, value) {
		const iterations = Math.ceil((bits >> 3) / 32);
		const res = new Uint8Array(iterations * 32);
		for (let iter = 0; iter < iterations; iter++) {
			const buf = new Uint8Array(4 + secret.length + value.length);
			buf.set(uint32be(iter + 1));
			buf.set(secret, 4);
			buf.set(value, 4 + secret.length);
			res.set(await (0, digest_js_1.default)("sha256", buf), iter * 32);
		}
		return res.slice(0, bits >> 3);
	}
	exports.concatKdf = concatKdf;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/base64url.js
var require_base64url$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decode = exports.encode = exports.encodeBase64 = exports.decodeBase64 = void 0;
	const buffer_1$5 = __require("buffer");
	const buffer_utils_js_1 = require_buffer_utils();
	function normalize(input) {
		let encoded = input;
		if (encoded instanceof Uint8Array) encoded = buffer_utils_js_1.decoder.decode(encoded);
		return encoded;
	}
	if (buffer_1$5.Buffer.isEncoding("base64url")) exports.encode = (input) => buffer_1$5.Buffer.from(input).toString("base64url");
	else exports.encode = (input) => buffer_1$5.Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	const decodeBase64 = (input) => buffer_1$5.Buffer.from(input, "base64");
	exports.decodeBase64 = decodeBase64;
	const encodeBase64 = (input) => buffer_1$5.Buffer.from(input).toString("base64");
	exports.encodeBase64 = encodeBase64;
	const decode = (input) => buffer_1$5.Buffer.from(normalize(input), "base64");
	exports.decode = decode;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/util/errors.js
var require_errors$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.JWSSignatureVerificationFailed = exports.JWKSTimeout = exports.JWKSMultipleMatchingKeys = exports.JWKSNoMatchingKey = exports.JWKSInvalid = exports.JWKInvalid = exports.JWTInvalid = exports.JWSInvalid = exports.JWEInvalid = exports.JWEDecompressionFailed = exports.JWEDecryptionFailed = exports.JOSENotSupported = exports.JOSEAlgNotAllowed = exports.JWTExpired = exports.JWTClaimValidationFailed = exports.JOSEError = void 0;
	var JOSEError = class extends Error {
		static get code() {
			return "ERR_JOSE_GENERIC";
		}
		constructor(message) {
			var _a;
			super(message);
			this.code = "ERR_JOSE_GENERIC";
			this.name = this.constructor.name;
			(_a = Error.captureStackTrace) === null || _a === void 0 || _a.call(Error, this, this.constructor);
		}
	};
	exports.JOSEError = JOSEError;
	var JWTClaimValidationFailed = class extends JOSEError {
		static get code() {
			return "ERR_JWT_CLAIM_VALIDATION_FAILED";
		}
		constructor(message, claim = "unspecified", reason = "unspecified") {
			super(message);
			this.code = "ERR_JWT_CLAIM_VALIDATION_FAILED";
			this.claim = claim;
			this.reason = reason;
		}
	};
	exports.JWTClaimValidationFailed = JWTClaimValidationFailed;
	var JWTExpired = class extends JOSEError {
		static get code() {
			return "ERR_JWT_EXPIRED";
		}
		constructor(message, claim = "unspecified", reason = "unspecified") {
			super(message);
			this.code = "ERR_JWT_EXPIRED";
			this.claim = claim;
			this.reason = reason;
		}
	};
	exports.JWTExpired = JWTExpired;
	var JOSEAlgNotAllowed = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JOSE_ALG_NOT_ALLOWED";
		}
		static get code() {
			return "ERR_JOSE_ALG_NOT_ALLOWED";
		}
	};
	exports.JOSEAlgNotAllowed = JOSEAlgNotAllowed;
	var JOSENotSupported = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JOSE_NOT_SUPPORTED";
		}
		static get code() {
			return "ERR_JOSE_NOT_SUPPORTED";
		}
	};
	exports.JOSENotSupported = JOSENotSupported;
	var JWEDecryptionFailed = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWE_DECRYPTION_FAILED";
			this.message = "decryption operation failed";
		}
		static get code() {
			return "ERR_JWE_DECRYPTION_FAILED";
		}
	};
	exports.JWEDecryptionFailed = JWEDecryptionFailed;
	var JWEDecompressionFailed = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWE_DECOMPRESSION_FAILED";
			this.message = "decompression operation failed";
		}
		static get code() {
			return "ERR_JWE_DECOMPRESSION_FAILED";
		}
	};
	exports.JWEDecompressionFailed = JWEDecompressionFailed;
	var JWEInvalid = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWE_INVALID";
		}
		static get code() {
			return "ERR_JWE_INVALID";
		}
	};
	exports.JWEInvalid = JWEInvalid;
	var JWSInvalid = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWS_INVALID";
		}
		static get code() {
			return "ERR_JWS_INVALID";
		}
	};
	exports.JWSInvalid = JWSInvalid;
	var JWTInvalid = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWT_INVALID";
		}
		static get code() {
			return "ERR_JWT_INVALID";
		}
	};
	exports.JWTInvalid = JWTInvalid;
	var JWKInvalid = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWK_INVALID";
		}
		static get code() {
			return "ERR_JWK_INVALID";
		}
	};
	exports.JWKInvalid = JWKInvalid;
	var JWKSInvalid = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWKS_INVALID";
		}
		static get code() {
			return "ERR_JWKS_INVALID";
		}
	};
	exports.JWKSInvalid = JWKSInvalid;
	var JWKSNoMatchingKey = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWKS_NO_MATCHING_KEY";
			this.message = "no applicable key found in the JSON Web Key Set";
		}
		static get code() {
			return "ERR_JWKS_NO_MATCHING_KEY";
		}
	};
	exports.JWKSNoMatchingKey = JWKSNoMatchingKey;
	var JWKSMultipleMatchingKeys = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
			this.message = "multiple matching keys found in the JSON Web Key Set";
		}
		static get code() {
			return "ERR_JWKS_MULTIPLE_MATCHING_KEYS";
		}
	};
	exports.JWKSMultipleMatchingKeys = JWKSMultipleMatchingKeys;
	var JWKSTimeout = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWKS_TIMEOUT";
			this.message = "request timed out";
		}
		static get code() {
			return "ERR_JWKS_TIMEOUT";
		}
	};
	exports.JWKSTimeout = JWKSTimeout;
	var JWSSignatureVerificationFailed = class extends JOSEError {
		constructor() {
			super(...arguments);
			this.code = "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
			this.message = "signature verification failed";
		}
		static get code() {
			return "ERR_JWS_SIGNATURE_VERIFICATION_FAILED";
		}
	};
	exports.JWSSignatureVerificationFailed = JWSSignatureVerificationFailed;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/random.js
var require_random = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = void 0;
	var crypto_1$16 = __require("crypto");
	Object.defineProperty(exports, "default", {
		enumerable: true,
		get: function() {
			return crypto_1$16.randomFillSync;
		}
	});
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/iv.js
var require_iv = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.bitLength = void 0;
	const errors_js_1 = require_errors$1();
	const random_js_1 = require_random();
	function bitLength(alg) {
		switch (alg) {
			case "A128GCM":
			case "A128GCMKW":
			case "A192GCM":
			case "A192GCMKW":
			case "A256GCM":
			case "A256GCMKW": return 96;
			case "A128CBC-HS256":
			case "A192CBC-HS384":
			case "A256CBC-HS512": return 128;
			default: throw new errors_js_1.JOSENotSupported(`Unsupported JWE Algorithm: ${alg}`);
		}
	}
	exports.bitLength = bitLength;
	exports.default = (alg) => (0, random_js_1.default)(new Uint8Array(bitLength(alg) >> 3));
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/check_iv_length.js
var require_check_iv_length = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	const iv_js_1 = require_iv();
	const checkIvLength = (enc, iv) => {
		if (iv.length << 3 !== (0, iv_js_1.bitLength)(enc)) throw new errors_js_1.JWEInvalid("Invalid Initialization Vector length");
	};
	exports.default = checkIvLength;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/is_key_object.js
var require_is_key_object = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$15 = __require("crypto");
	const util$1 = __require("util");
	exports.default = util$1.types.isKeyObject ? (obj) => util$1.types.isKeyObject(obj) : (obj) => obj != null && obj instanceof crypto_1$15.KeyObject;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/check_cek_length.js
var require_check_cek_length = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	const is_key_object_js_1 = require_is_key_object();
	const checkCekLength = (enc, cek) => {
		let expected;
		switch (enc) {
			case "A128CBC-HS256":
			case "A192CBC-HS384":
			case "A256CBC-HS512":
				expected = parseInt(enc.slice(-3), 10);
				break;
			case "A128GCM":
			case "A192GCM":
			case "A256GCM":
				expected = parseInt(enc.slice(1, 4), 10);
				break;
			default: throw new errors_js_1.JOSENotSupported(`Content Encryption Algorithm ${enc} is not supported either by JOSE or your javascript runtime`);
		}
		if (cek instanceof Uint8Array) {
			const actual = cek.byteLength << 3;
			if (actual !== expected) throw new errors_js_1.JWEInvalid(`Invalid Content Encryption Key length. Expected ${expected} bits, got ${actual} bits`);
			return;
		}
		if ((0, is_key_object_js_1.default)(cek) && cek.type === "secret") {
			const actual = cek.symmetricKeySize << 3;
			if (actual !== expected) throw new errors_js_1.JWEInvalid(`Invalid Content Encryption Key length. Expected ${expected} bits, got ${actual} bits`);
			return;
		}
		throw new TypeError("Invalid Content Encryption Key type");
	};
	exports.default = checkCekLength;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/timing_safe_equal.js
var require_timing_safe_equal = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = __require("crypto").timingSafeEqual;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/cbc_tag.js
var require_cbc_tag = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$14 = __require("crypto");
	const buffer_utils_js_1 = require_buffer_utils();
	function cbcTag(aad, iv, ciphertext, macSize, macKey, keySize) {
		const macData = (0, buffer_utils_js_1.concat)(aad, iv, ciphertext, (0, buffer_utils_js_1.uint64be)(aad.length << 3));
		const hmac = (0, crypto_1$14.createHmac)(`sha${macSize}`, macKey);
		hmac.update(macData);
		return hmac.digest().slice(0, keySize >> 3);
	}
	exports.default = cbcTag;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/webcrypto.js
var require_webcrypto = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isCryptoKey = void 0;
	const crypto$2 = __require("crypto");
	const util = __require("util");
	exports.default = crypto$2.webcrypto;
	exports.isCryptoKey = util.types.isCryptoKey ? (key) => util.types.isCryptoKey(key) : (key) => false;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/crypto_key.js
var require_crypto_key = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.checkEncCryptoKey = exports.checkSigCryptoKey = void 0;
	function unusable(name, prop = "algorithm.name") {
		return /* @__PURE__ */ new TypeError(`CryptoKey does not support this operation, its ${prop} must be ${name}`);
	}
	function isAlgorithm(algorithm, name) {
		return algorithm.name === name;
	}
	function getHashLength(hash) {
		return parseInt(hash.name.slice(4), 10);
	}
	function getNamedCurve(alg) {
		switch (alg) {
			case "ES256": return "P-256";
			case "ES384": return "P-384";
			case "ES512": return "P-521";
			default: throw new Error("unreachable");
		}
	}
	function checkUsage(key, usages) {
		if (usages.length && !usages.some((expected) => key.usages.includes(expected))) {
			let msg = "CryptoKey does not support this operation, its usages must include ";
			if (usages.length > 2) {
				const last = usages.pop();
				msg += `one of ${usages.join(", ")}, or ${last}.`;
			} else if (usages.length === 2) msg += `one of ${usages[0]} or ${usages[1]}.`;
			else msg += `${usages[0]}.`;
			throw new TypeError(msg);
		}
	}
	function checkSigCryptoKey(key, alg, ...usages) {
		switch (alg) {
			case "HS256":
			case "HS384":
			case "HS512": {
				if (!isAlgorithm(key.algorithm, "HMAC")) throw unusable("HMAC");
				const expected = parseInt(alg.slice(2), 10);
				if (getHashLength(key.algorithm.hash) !== expected) throw unusable(`SHA-${expected}`, "algorithm.hash");
				break;
			}
			case "RS256":
			case "RS384":
			case "RS512": {
				if (!isAlgorithm(key.algorithm, "RSASSA-PKCS1-v1_5")) throw unusable("RSASSA-PKCS1-v1_5");
				const expected = parseInt(alg.slice(2), 10);
				if (getHashLength(key.algorithm.hash) !== expected) throw unusable(`SHA-${expected}`, "algorithm.hash");
				break;
			}
			case "PS256":
			case "PS384":
			case "PS512": {
				if (!isAlgorithm(key.algorithm, "RSA-PSS")) throw unusable("RSA-PSS");
				const expected = parseInt(alg.slice(2), 10);
				if (getHashLength(key.algorithm.hash) !== expected) throw unusable(`SHA-${expected}`, "algorithm.hash");
				break;
			}
			case "EdDSA":
				if (key.algorithm.name !== "Ed25519" && key.algorithm.name !== "Ed448") throw unusable("Ed25519 or Ed448");
				break;
			case "ES256":
			case "ES384":
			case "ES512": {
				if (!isAlgorithm(key.algorithm, "ECDSA")) throw unusable("ECDSA");
				const expected = getNamedCurve(alg);
				if (key.algorithm.namedCurve !== expected) throw unusable(expected, "algorithm.namedCurve");
				break;
			}
			default: throw new TypeError("CryptoKey does not support this operation");
		}
		checkUsage(key, usages);
	}
	exports.checkSigCryptoKey = checkSigCryptoKey;
	function checkEncCryptoKey(key, alg, ...usages) {
		switch (alg) {
			case "A128GCM":
			case "A192GCM":
			case "A256GCM": {
				if (!isAlgorithm(key.algorithm, "AES-GCM")) throw unusable("AES-GCM");
				const expected = parseInt(alg.slice(1, 4), 10);
				if (key.algorithm.length !== expected) throw unusable(expected, "algorithm.length");
				break;
			}
			case "A128KW":
			case "A192KW":
			case "A256KW": {
				if (!isAlgorithm(key.algorithm, "AES-KW")) throw unusable("AES-KW");
				const expected = parseInt(alg.slice(1, 4), 10);
				if (key.algorithm.length !== expected) throw unusable(expected, "algorithm.length");
				break;
			}
			case "ECDH":
				switch (key.algorithm.name) {
					case "ECDH":
					case "X25519":
					case "X448": break;
					default: throw unusable("ECDH, X25519, or X448");
				}
				break;
			case "PBES2-HS256+A128KW":
			case "PBES2-HS384+A192KW":
			case "PBES2-HS512+A256KW":
				if (!isAlgorithm(key.algorithm, "PBKDF2")) throw unusable("PBKDF2");
				break;
			case "RSA-OAEP":
			case "RSA-OAEP-256":
			case "RSA-OAEP-384":
			case "RSA-OAEP-512": {
				if (!isAlgorithm(key.algorithm, "RSA-OAEP")) throw unusable("RSA-OAEP");
				const expected = parseInt(alg.slice(9), 10) || 1;
				if (getHashLength(key.algorithm.hash) !== expected) throw unusable(`SHA-${expected}`, "algorithm.hash");
				break;
			}
			default: throw new TypeError("CryptoKey does not support this operation");
		}
		checkUsage(key, usages);
	}
	exports.checkEncCryptoKey = checkEncCryptoKey;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/invalid_key_input.js
var require_invalid_key_input = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.withAlg = void 0;
	function message(msg, actual, ...types) {
		if (types.length > 2) {
			const last = types.pop();
			msg += `one of type ${types.join(", ")}, or ${last}.`;
		} else if (types.length === 2) msg += `one of type ${types[0]} or ${types[1]}.`;
		else msg += `of type ${types[0]}.`;
		if (actual == null) msg += ` Received ${actual}`;
		else if (typeof actual === "function" && actual.name) msg += ` Received function ${actual.name}`;
		else if (typeof actual === "object" && actual != null) {
			if (actual.constructor && actual.constructor.name) msg += ` Received an instance of ${actual.constructor.name}`;
		}
		return msg;
	}
	exports.default = (actual, ...types) => {
		return message("Key must be ", actual, ...types);
	};
	function withAlg(alg, actual, ...types) {
		return message(`Key for the ${alg} algorithm must be `, actual, ...types);
	}
	exports.withAlg = withAlg;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/ciphers.js
var require_ciphers = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$13 = __require("crypto");
	let ciphers;
	exports.default = (algorithm) => {
		ciphers || (ciphers = new Set((0, crypto_1$13.getCiphers)()));
		return ciphers.has(algorithm);
	};
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/is_key_like.js
var require_is_key_like = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.types = void 0;
	const webcrypto_js_1 = require_webcrypto();
	const is_key_object_js_1 = require_is_key_object();
	exports.default = (key) => (0, is_key_object_js_1.default)(key) || (0, webcrypto_js_1.isCryptoKey)(key);
	const types = ["KeyObject"];
	exports.types = types;
	if (globalThis.CryptoKey || (webcrypto_js_1.default === null || webcrypto_js_1.default === void 0 ? void 0 : webcrypto_js_1.default.CryptoKey)) types.push("CryptoKey");
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/decrypt.js
var require_decrypt$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$12 = __require("crypto");
	const check_iv_length_js_1 = require_check_iv_length();
	const check_cek_length_js_1 = require_check_cek_length();
	const buffer_utils_js_1 = require_buffer_utils();
	const errors_js_1 = require_errors$1();
	const timing_safe_equal_js_1 = require_timing_safe_equal();
	const cbc_tag_js_1 = require_cbc_tag();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const ciphers_js_1 = require_ciphers();
	const is_key_like_js_1 = require_is_key_like();
	function cbcDecrypt(enc, cek, ciphertext, iv, tag, aad) {
		const keySize = parseInt(enc.slice(1, 4), 10);
		if ((0, is_key_object_js_1.default)(cek)) cek = cek.export();
		const encKey = cek.subarray(keySize >> 3);
		const macKey = cek.subarray(0, keySize >> 3);
		const macSize = parseInt(enc.slice(-3), 10);
		const algorithm = `aes-${keySize}-cbc`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${enc} is not supported by your javascript runtime`);
		const expectedTag = (0, cbc_tag_js_1.default)(aad, iv, ciphertext, macSize, macKey, keySize);
		let macCheckPassed;
		try {
			macCheckPassed = (0, timing_safe_equal_js_1.default)(tag, expectedTag);
		} catch {}
		if (!macCheckPassed) throw new errors_js_1.JWEDecryptionFailed();
		let plaintext;
		try {
			const decipher = (0, crypto_1$12.createDecipheriv)(algorithm, encKey, iv);
			plaintext = (0, buffer_utils_js_1.concat)(decipher.update(ciphertext), decipher.final());
		} catch {}
		if (!plaintext) throw new errors_js_1.JWEDecryptionFailed();
		return plaintext;
	}
	function gcmDecrypt(enc, cek, ciphertext, iv, tag, aad) {
		const algorithm = `aes-${parseInt(enc.slice(1, 4), 10)}-gcm`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${enc} is not supported by your javascript runtime`);
		try {
			const decipher = (0, crypto_1$12.createDecipheriv)(algorithm, cek, iv, { authTagLength: 16 });
			decipher.setAuthTag(tag);
			if (aad.byteLength) decipher.setAAD(aad, { plaintextLength: ciphertext.length });
			const plaintext = decipher.update(ciphertext);
			decipher.final();
			return plaintext;
		} catch {
			throw new errors_js_1.JWEDecryptionFailed();
		}
	}
	const decrypt = (enc, cek, ciphertext, iv, tag, aad) => {
		let key;
		if ((0, webcrypto_js_1.isCryptoKey)(cek)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(cek, enc, "decrypt");
			key = crypto_1$12.KeyObject.from(cek);
		} else if (cek instanceof Uint8Array || (0, is_key_object_js_1.default)(cek)) key = cek;
		else throw new TypeError((0, invalid_key_input_js_1.default)(cek, ...is_key_like_js_1.types, "Uint8Array"));
		(0, check_cek_length_js_1.default)(enc, key);
		(0, check_iv_length_js_1.default)(enc, iv);
		switch (enc) {
			case "A128CBC-HS256":
			case "A192CBC-HS384":
			case "A256CBC-HS512": return cbcDecrypt(enc, key, ciphertext, iv, tag, aad);
			case "A128GCM":
			case "A192GCM":
			case "A256GCM": return gcmDecrypt(enc, key, ciphertext, iv, tag, aad);
			default: throw new errors_js_1.JOSENotSupported("Unsupported JWE Content Encryption Algorithm");
		}
	};
	exports.default = decrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/zlib.js
var require_zlib = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.deflate = exports.inflate = void 0;
	const util_1$5 = __require("util");
	const zlib_1 = __require("zlib");
	const errors_js_1 = require_errors$1();
	const inflateRaw = (0, util_1$5.promisify)(zlib_1.inflateRaw);
	const deflateRaw = (0, util_1$5.promisify)(zlib_1.deflateRaw);
	const inflate = (input) => inflateRaw(input, { maxOutputLength: 25e4 }).catch(() => {
		throw new errors_js_1.JWEDecompressionFailed();
	});
	exports.inflate = inflate;
	const deflate = (input) => deflateRaw(input);
	exports.deflate = deflate;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/is_disjoint.js
var require_is_disjoint = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const isDisjoint = (...headers) => {
		const sources = headers.filter(Boolean);
		if (sources.length === 0 || sources.length === 1) return true;
		let acc;
		for (const header of sources) {
			const parameters = Object.keys(header);
			if (!acc || acc.size === 0) {
				acc = new Set(parameters);
				continue;
			}
			for (const parameter of parameters) {
				if (acc.has(parameter)) return false;
				acc.add(parameter);
			}
		}
		return true;
	};
	exports.default = isDisjoint;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/is_object.js
var require_is_object = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	function isObjectLike(value) {
		return typeof value === "object" && value !== null;
	}
	function isObject(input) {
		if (!isObjectLike(input) || Object.prototype.toString.call(input) !== "[object Object]") return false;
		if (Object.getPrototypeOf(input) === null) return true;
		let proto = input;
		while (Object.getPrototypeOf(proto) !== null) proto = Object.getPrototypeOf(proto);
		return Object.getPrototypeOf(input) === proto;
	}
	exports.default = isObject;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/aeskw.js
var require_aeskw = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.unwrap = exports.wrap = void 0;
	const buffer_1$4 = __require("buffer");
	const crypto_1$11 = __require("crypto");
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const ciphers_js_1 = require_ciphers();
	const is_key_like_js_1 = require_is_key_like();
	function checkKeySize(key, alg) {
		if (key.symmetricKeySize << 3 !== parseInt(alg.slice(1, 4), 10)) throw new TypeError(`Invalid key size for alg: ${alg}`);
	}
	function ensureKeyObject(key, alg, usage) {
		if ((0, is_key_object_js_1.default)(key)) return key;
		if (key instanceof Uint8Array) return (0, crypto_1$11.createSecretKey)(key);
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(key, alg, usage);
			return crypto_1$11.KeyObject.from(key);
		}
		throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types, "Uint8Array"));
	}
	const wrap = (alg, key, cek) => {
		const algorithm = `aes${parseInt(alg.slice(1, 4), 10)}-wrap`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
		const keyObject = ensureKeyObject(key, alg, "wrapKey");
		checkKeySize(keyObject, alg);
		const cipher = (0, crypto_1$11.createCipheriv)(algorithm, keyObject, buffer_1$4.Buffer.alloc(8, 166));
		return (0, buffer_utils_js_1.concat)(cipher.update(cek), cipher.final());
	};
	exports.wrap = wrap;
	const unwrap = (alg, key, encryptedKey) => {
		const algorithm = `aes${parseInt(alg.slice(1, 4), 10)}-wrap`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
		const keyObject = ensureKeyObject(key, alg, "unwrapKey");
		checkKeySize(keyObject, alg);
		const cipher = (0, crypto_1$11.createDecipheriv)(algorithm, keyObject, buffer_1$4.Buffer.alloc(8, 166));
		return (0, buffer_utils_js_1.concat)(cipher.update(encryptedKey), cipher.final());
	};
	exports.unwrap = unwrap;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/get_named_curve.js
var require_get_named_curve = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.setCurve = exports.weakMap = void 0;
	const buffer_1$3 = __require("buffer");
	const crypto_1$10 = __require("crypto");
	const errors_js_1 = require_errors$1();
	const webcrypto_js_1 = require_webcrypto();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const p256 = buffer_1$3.Buffer.from([
		42,
		134,
		72,
		206,
		61,
		3,
		1,
		7
	]);
	const p384 = buffer_1$3.Buffer.from([
		43,
		129,
		4,
		0,
		34
	]);
	const p521 = buffer_1$3.Buffer.from([
		43,
		129,
		4,
		0,
		35
	]);
	const secp256k1 = buffer_1$3.Buffer.from([
		43,
		129,
		4,
		0,
		10
	]);
	exports.weakMap = /* @__PURE__ */ new WeakMap();
	const namedCurveToJOSE = (namedCurve) => {
		switch (namedCurve) {
			case "prime256v1": return "P-256";
			case "secp384r1": return "P-384";
			case "secp521r1": return "P-521";
			case "secp256k1": return "secp256k1";
			default: throw new errors_js_1.JOSENotSupported("Unsupported key curve for this operation");
		}
	};
	const getNamedCurve = (kee, raw) => {
		var _a;
		let key;
		if ((0, webcrypto_js_1.isCryptoKey)(kee)) key = crypto_1$10.KeyObject.from(kee);
		else if ((0, is_key_object_js_1.default)(kee)) key = kee;
		else throw new TypeError((0, invalid_key_input_js_1.default)(kee, ...is_key_like_js_1.types));
		if (key.type === "secret") throw new TypeError("only \"private\" or \"public\" type keys can be used for this operation");
		switch (key.asymmetricKeyType) {
			case "ed25519":
			case "ed448": return `Ed${key.asymmetricKeyType.slice(2)}`;
			case "x25519":
			case "x448": return `X${key.asymmetricKeyType.slice(1)}`;
			case "ec": {
				if (exports.weakMap.has(key)) return exports.weakMap.get(key);
				let namedCurve = (_a = key.asymmetricKeyDetails) === null || _a === void 0 ? void 0 : _a.namedCurve;
				if (!namedCurve && key.type === "private") namedCurve = getNamedCurve((0, crypto_1$10.createPublicKey)(key), true);
				else if (!namedCurve) {
					const buf = key.export({
						format: "der",
						type: "spki"
					});
					const i = buf[1] < 128 ? 14 : 15;
					const len = buf[i];
					const curveOid = buf.slice(i + 1, i + 1 + len);
					if (curveOid.equals(p256)) namedCurve = "prime256v1";
					else if (curveOid.equals(p384)) namedCurve = "secp384r1";
					else if (curveOid.equals(p521)) namedCurve = "secp521r1";
					else if (curveOid.equals(secp256k1)) namedCurve = "secp256k1";
					else throw new errors_js_1.JOSENotSupported("Unsupported key curve for this operation");
				}
				if (raw) return namedCurve;
				const curve = namedCurveToJOSE(namedCurve);
				exports.weakMap.set(key, curve);
				return curve;
			}
			default: throw new TypeError("Invalid asymmetric key type for this operation");
		}
	};
	function setCurve(keyObject, curve) {
		exports.weakMap.set(keyObject, curve);
	}
	exports.setCurve = setCurve;
	exports.default = getNamedCurve;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/ecdhes.js
var require_ecdhes = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ecdhAllowed = exports.generateEpk = exports.deriveKey = void 0;
	const crypto_1$9 = __require("crypto");
	const util_1$4 = __require("util");
	const get_named_curve_js_1 = require_get_named_curve();
	const buffer_utils_js_1 = require_buffer_utils();
	const errors_js_1 = require_errors$1();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const generateKeyPair = (0, util_1$4.promisify)(crypto_1$9.generateKeyPair);
	async function deriveKey(publicKee, privateKee, algorithm, keyLength, apu = new Uint8Array(0), apv = new Uint8Array(0)) {
		let publicKey;
		if ((0, webcrypto_js_1.isCryptoKey)(publicKee)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(publicKee, "ECDH");
			publicKey = crypto_1$9.KeyObject.from(publicKee);
		} else if ((0, is_key_object_js_1.default)(publicKee)) publicKey = publicKee;
		else throw new TypeError((0, invalid_key_input_js_1.default)(publicKee, ...is_key_like_js_1.types));
		let privateKey;
		if ((0, webcrypto_js_1.isCryptoKey)(privateKee)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(privateKee, "ECDH", "deriveBits");
			privateKey = crypto_1$9.KeyObject.from(privateKee);
		} else if ((0, is_key_object_js_1.default)(privateKee)) privateKey = privateKee;
		else throw new TypeError((0, invalid_key_input_js_1.default)(privateKee, ...is_key_like_js_1.types));
		const value = (0, buffer_utils_js_1.concat)((0, buffer_utils_js_1.lengthAndInput)(buffer_utils_js_1.encoder.encode(algorithm)), (0, buffer_utils_js_1.lengthAndInput)(apu), (0, buffer_utils_js_1.lengthAndInput)(apv), (0, buffer_utils_js_1.uint32be)(keyLength));
		const sharedSecret = (0, crypto_1$9.diffieHellman)({
			privateKey,
			publicKey
		});
		return (0, buffer_utils_js_1.concatKdf)(sharedSecret, keyLength, value);
	}
	exports.deriveKey = deriveKey;
	async function generateEpk(kee) {
		let key;
		if ((0, webcrypto_js_1.isCryptoKey)(kee)) key = crypto_1$9.KeyObject.from(kee);
		else if ((0, is_key_object_js_1.default)(kee)) key = kee;
		else throw new TypeError((0, invalid_key_input_js_1.default)(kee, ...is_key_like_js_1.types));
		switch (key.asymmetricKeyType) {
			case "x25519": return generateKeyPair("x25519");
			case "x448": return generateKeyPair("x448");
			case "ec": return generateKeyPair("ec", { namedCurve: (0, get_named_curve_js_1.default)(key) });
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported EPK");
		}
	}
	exports.generateEpk = generateEpk;
	const ecdhAllowed = (key) => [
		"P-256",
		"P-384",
		"P-521",
		"X25519",
		"X448"
	].includes((0, get_named_curve_js_1.default)(key));
	exports.ecdhAllowed = ecdhAllowed;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/check_p2s.js
var require_check_p2s = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	function checkP2s(p2s) {
		if (!(p2s instanceof Uint8Array) || p2s.length < 8) throw new errors_js_1.JWEInvalid("PBES2 Salt Input must be 8 or more octets");
	}
	exports.default = checkP2s;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/pbes2kw.js
var require_pbes2kw = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decrypt = exports.encrypt = void 0;
	const util_1$3 = __require("util");
	const crypto_1$8 = __require("crypto");
	const random_js_1 = require_random();
	const buffer_utils_js_1 = require_buffer_utils();
	const base64url_js_1 = require_base64url$1();
	const aeskw_js_1 = require_aeskw();
	const check_p2s_js_1 = require_check_p2s();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const pbkdf2 = (0, util_1$3.promisify)(crypto_1$8.pbkdf2);
	function getPassword(key, alg) {
		if ((0, is_key_object_js_1.default)(key)) return key.export();
		if (key instanceof Uint8Array) return key;
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(key, alg, "deriveBits", "deriveKey");
			return crypto_1$8.KeyObject.from(key).export();
		}
		throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types, "Uint8Array"));
	}
	const encrypt = async (alg, key, cek, p2c = 2048, p2s = (0, random_js_1.default)(new Uint8Array(16))) => {
		(0, check_p2s_js_1.default)(p2s);
		const salt = (0, buffer_utils_js_1.p2s)(alg, p2s);
		const keylen = parseInt(alg.slice(13, 16), 10) >> 3;
		const derivedKey = await pbkdf2(getPassword(key, alg), salt, p2c, keylen, `sha${alg.slice(8, 11)}`);
		return {
			encryptedKey: await (0, aeskw_js_1.wrap)(alg.slice(-6), derivedKey, cek),
			p2c,
			p2s: (0, base64url_js_1.encode)(p2s)
		};
	};
	exports.encrypt = encrypt;
	const decrypt = async (alg, key, encryptedKey, p2c, p2s) => {
		(0, check_p2s_js_1.default)(p2s);
		const salt = (0, buffer_utils_js_1.p2s)(alg, p2s);
		const keylen = parseInt(alg.slice(13, 16), 10) >> 3;
		const derivedKey = await pbkdf2(getPassword(key, alg), salt, p2c, keylen, `sha${alg.slice(8, 11)}`);
		return (0, aeskw_js_1.unwrap)(alg.slice(-6), derivedKey, encryptedKey);
	};
	exports.decrypt = decrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/check_modulus_length.js
var require_check_modulus_length = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.setModulusLength = exports.weakMap = void 0;
	exports.weakMap = /* @__PURE__ */ new WeakMap();
	const getLength = (buf, index) => {
		let len = buf.readUInt8(1);
		if ((len & 128) === 0) {
			if (index === 0) return len;
			return getLength(buf.subarray(2 + len), index - 1);
		}
		const num = len & 127;
		len = 0;
		for (let i = 0; i < num; i++) {
			len <<= 8;
			const j = buf.readUInt8(2 + i);
			len |= j;
		}
		if (index === 0) return len;
		return getLength(buf.subarray(2 + len), index - 1);
	};
	const getLengthOfSeqIndex = (sequence, index) => {
		const len = sequence.readUInt8(1);
		if ((len & 128) === 0) return getLength(sequence.subarray(2), index);
		const num = len & 127;
		return getLength(sequence.subarray(2 + num), index);
	};
	const getModulusLength = (key) => {
		var _a, _b;
		if (exports.weakMap.has(key)) return exports.weakMap.get(key);
		const modulusLength = (_b = (_a = key.asymmetricKeyDetails) === null || _a === void 0 ? void 0 : _a.modulusLength) !== null && _b !== void 0 ? _b : getLengthOfSeqIndex(key.export({
			format: "der",
			type: "pkcs1"
		}), key.type === "private" ? 1 : 0) - 1 << 3;
		exports.weakMap.set(key, modulusLength);
		return modulusLength;
	};
	const setModulusLength = (keyObject, modulusLength) => {
		exports.weakMap.set(keyObject, modulusLength);
	};
	exports.setModulusLength = setModulusLength;
	exports.default = (key, alg) => {
		if (getModulusLength(key) < 2048) throw new TypeError(`${alg} requires key modulusLength to be 2048 bits or larger`);
	};
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/rsaes.js
var require_rsaes = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decrypt = exports.encrypt = void 0;
	const crypto_1$7 = __require("crypto");
	const check_modulus_length_js_1 = require_check_modulus_length();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const checkKey = (key, alg) => {
		if (key.asymmetricKeyType !== "rsa") throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa");
		(0, check_modulus_length_js_1.default)(key, alg);
	};
	const resolvePadding = (alg) => {
		switch (alg) {
			case "RSA-OAEP":
			case "RSA-OAEP-256":
			case "RSA-OAEP-384":
			case "RSA-OAEP-512": return crypto_1$7.constants.RSA_PKCS1_OAEP_PADDING;
			case "RSA1_5": return crypto_1$7.constants.RSA_PKCS1_PADDING;
			default: return;
		}
	};
	const resolveOaepHash = (alg) => {
		switch (alg) {
			case "RSA-OAEP": return "sha1";
			case "RSA-OAEP-256": return "sha256";
			case "RSA-OAEP-384": return "sha384";
			case "RSA-OAEP-512": return "sha512";
			default: return;
		}
	};
	function ensureKeyObject(key, alg, ...usages) {
		if ((0, is_key_object_js_1.default)(key)) return key;
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(key, alg, ...usages);
			return crypto_1$7.KeyObject.from(key);
		}
		throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types));
	}
	const encrypt = (alg, key, cek) => {
		const padding = resolvePadding(alg);
		const oaepHash = resolveOaepHash(alg);
		const keyObject = ensureKeyObject(key, alg, "wrapKey", "encrypt");
		checkKey(keyObject, alg);
		return (0, crypto_1$7.publicEncrypt)({
			key: keyObject,
			oaepHash,
			padding
		}, cek);
	};
	exports.encrypt = encrypt;
	const decrypt = (alg, key, encryptedKey) => {
		const padding = resolvePadding(alg);
		const oaepHash = resolveOaepHash(alg);
		const keyObject = ensureKeyObject(key, alg, "unwrapKey", "decrypt");
		checkKey(keyObject, alg);
		return (0, crypto_1$7.privateDecrypt)({
			key: keyObject,
			oaepHash,
			padding
		}, encryptedKey);
	};
	exports.decrypt = decrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/cek.js
var require_cek = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.bitLength = void 0;
	const errors_js_1 = require_errors$1();
	const random_js_1 = require_random();
	function bitLength(alg) {
		switch (alg) {
			case "A128GCM": return 128;
			case "A192GCM": return 192;
			case "A256GCM":
			case "A128CBC-HS256": return 256;
			case "A192CBC-HS384": return 384;
			case "A256CBC-HS512": return 512;
			default: throw new errors_js_1.JOSENotSupported(`Unsupported JWE Algorithm: ${alg}`);
		}
	}
	exports.bitLength = bitLength;
	exports.default = (alg) => (0, random_js_1.default)(new Uint8Array(bitLength(alg) >> 3));
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/asn1.js
var require_asn1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.fromX509 = exports.fromSPKI = exports.fromPKCS8 = exports.toPKCS8 = exports.toSPKI = void 0;
	const crypto_1$6 = __require("crypto");
	const buffer_1$2 = __require("buffer");
	const webcrypto_js_1 = require_webcrypto();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const genericExport = (keyType, keyFormat, key) => {
		let keyObject;
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			if (!key.extractable) throw new TypeError("CryptoKey is not extractable");
			keyObject = crypto_1$6.KeyObject.from(key);
		} else if ((0, is_key_object_js_1.default)(key)) keyObject = key;
		else throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types));
		if (keyObject.type !== keyType) throw new TypeError(`key is not a ${keyType} key`);
		return keyObject.export({
			format: "pem",
			type: keyFormat
		});
	};
	const toSPKI = (key) => {
		return genericExport("public", "spki", key);
	};
	exports.toSPKI = toSPKI;
	const toPKCS8 = (key) => {
		return genericExport("private", "pkcs8", key);
	};
	exports.toPKCS8 = toPKCS8;
	const fromPKCS8 = (pem) => (0, crypto_1$6.createPrivateKey)({
		key: buffer_1$2.Buffer.from(pem.replace(/(?:-----(?:BEGIN|END) PRIVATE KEY-----|\s)/g, ""), "base64"),
		type: "pkcs8",
		format: "der"
	});
	exports.fromPKCS8 = fromPKCS8;
	const fromSPKI = (pem) => (0, crypto_1$6.createPublicKey)({
		key: buffer_1$2.Buffer.from(pem.replace(/(?:-----(?:BEGIN|END) PUBLIC KEY-----|\s)/g, ""), "base64"),
		type: "spki",
		format: "der"
	});
	exports.fromSPKI = fromSPKI;
	const fromX509 = (pem) => (0, crypto_1$6.createPublicKey)({
		key: pem,
		type: "spki",
		format: "pem"
	});
	exports.fromX509 = fromX509;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/asn1_sequence_encoder.js
var require_asn1_sequence_encoder = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const buffer_1$1 = __require("buffer");
	const errors_js_1 = require_errors$1();
	const tagInteger = 2;
	const tagBitStr = 3;
	const tagOctStr = 4;
	const tagSequence = 48;
	const bZero = buffer_1$1.Buffer.from([0]);
	const bTagInteger = buffer_1$1.Buffer.from([tagInteger]);
	const bTagBitStr = buffer_1$1.Buffer.from([tagBitStr]);
	const bTagSequence = buffer_1$1.Buffer.from([tagSequence]);
	const bTagOctStr = buffer_1$1.Buffer.from([tagOctStr]);
	const encodeLength = (len) => {
		if (len < 128) return buffer_1$1.Buffer.from([len]);
		const buffer = buffer_1$1.Buffer.alloc(5);
		buffer.writeUInt32BE(len, 1);
		let offset = 1;
		while (buffer[offset] === 0) offset++;
		buffer[offset - 1] = 128 | 5 - offset;
		return buffer.slice(offset - 1);
	};
	const oids = new Map([
		["P-256", buffer_1$1.Buffer.from("06 08 2A 86 48 CE 3D 03 01 07".replace(/ /g, ""), "hex")],
		["secp256k1", buffer_1$1.Buffer.from("06 05 2B 81 04 00 0A".replace(/ /g, ""), "hex")],
		["P-384", buffer_1$1.Buffer.from("06 05 2B 81 04 00 22".replace(/ /g, ""), "hex")],
		["P-521", buffer_1$1.Buffer.from("06 05 2B 81 04 00 23".replace(/ /g, ""), "hex")],
		["ecPublicKey", buffer_1$1.Buffer.from("06 07 2A 86 48 CE 3D 02 01".replace(/ /g, ""), "hex")],
		["X25519", buffer_1$1.Buffer.from("06 03 2B 65 6E".replace(/ /g, ""), "hex")],
		["X448", buffer_1$1.Buffer.from("06 03 2B 65 6F".replace(/ /g, ""), "hex")],
		["Ed25519", buffer_1$1.Buffer.from("06 03 2B 65 70".replace(/ /g, ""), "hex")],
		["Ed448", buffer_1$1.Buffer.from("06 03 2B 65 71".replace(/ /g, ""), "hex")]
	]);
	var DumbAsn1Encoder = class {
		constructor() {
			this.length = 0;
			this.elements = [];
		}
		oidFor(oid) {
			const bOid = oids.get(oid);
			if (!bOid) throw new errors_js_1.JOSENotSupported("Invalid or unsupported OID");
			this.elements.push(bOid);
			this.length += bOid.length;
		}
		zero() {
			this.elements.push(bTagInteger, buffer_1$1.Buffer.from([1]), bZero);
			this.length += 3;
		}
		one() {
			this.elements.push(bTagInteger, buffer_1$1.Buffer.from([1]), buffer_1$1.Buffer.from([1]));
			this.length += 3;
		}
		unsignedInteger(integer) {
			if (integer[0] & 128) {
				const len = encodeLength(integer.length + 1);
				this.elements.push(bTagInteger, len, bZero, integer);
				this.length += 2 + len.length + integer.length;
			} else {
				let i = 0;
				while (integer[i] === 0 && (integer[i + 1] & 128) === 0) i++;
				const len = encodeLength(integer.length - i);
				this.elements.push(bTagInteger, encodeLength(integer.length - i), integer.slice(i));
				this.length += 1 + len.length + integer.length - i;
			}
		}
		octStr(octStr) {
			const len = encodeLength(octStr.length);
			this.elements.push(bTagOctStr, encodeLength(octStr.length), octStr);
			this.length += 1 + len.length + octStr.length;
		}
		bitStr(bitS) {
			const len = encodeLength(bitS.length + 1);
			this.elements.push(bTagBitStr, encodeLength(bitS.length + 1), bZero, bitS);
			this.length += 1 + len.length + bitS.length + 1;
		}
		add(seq) {
			this.elements.push(seq);
			this.length += seq.length;
		}
		end(tag = bTagSequence) {
			const len = encodeLength(this.length);
			return buffer_1$1.Buffer.concat([
				tag,
				len,
				...this.elements
			], 1 + len.length + this.length);
		}
	};
	exports.default = DumbAsn1Encoder;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/flags.js
var require_flags = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.jwkImport = exports.jwkExport = exports.rsaPssParams = exports.oneShotCallback = void 0;
	const [major, minor] = process.versions.node.split(".").map((str) => parseInt(str, 10));
	exports.oneShotCallback = major >= 16 || major === 15 && minor >= 13;
	exports.rsaPssParams = !("electron" in process.versions) && (major >= 17 || major === 16 && minor >= 9);
	exports.jwkExport = major >= 16 || major === 15 && minor >= 9;
	exports.jwkImport = major >= 16 || major === 15 && minor >= 12;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/jwk_to_key.js
var require_jwk_to_key = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const buffer_1 = __require("buffer");
	const crypto_1$5 = __require("crypto");
	const base64url_js_1 = require_base64url$1();
	const errors_js_1 = require_errors$1();
	const get_named_curve_js_1 = require_get_named_curve();
	const check_modulus_length_js_1 = require_check_modulus_length();
	const asn1_sequence_encoder_js_1 = require_asn1_sequence_encoder();
	const flags_js_1 = require_flags();
	const parse = (jwk) => {
		if (flags_js_1.jwkImport && jwk.kty !== "oct") return jwk.d ? (0, crypto_1$5.createPrivateKey)({
			format: "jwk",
			key: jwk
		}) : (0, crypto_1$5.createPublicKey)({
			format: "jwk",
			key: jwk
		});
		switch (jwk.kty) {
			case "oct": return (0, crypto_1$5.createSecretKey)((0, base64url_js_1.decode)(jwk.k));
			case "RSA": {
				const enc = new asn1_sequence_encoder_js_1.default();
				const isPrivate = jwk.d !== void 0;
				const modulus = buffer_1.Buffer.from(jwk.n, "base64");
				const exponent = buffer_1.Buffer.from(jwk.e, "base64");
				if (isPrivate) {
					enc.zero();
					enc.unsignedInteger(modulus);
					enc.unsignedInteger(exponent);
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.d, "base64"));
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.p, "base64"));
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.q, "base64"));
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.dp, "base64"));
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.dq, "base64"));
					enc.unsignedInteger(buffer_1.Buffer.from(jwk.qi, "base64"));
				} else {
					enc.unsignedInteger(modulus);
					enc.unsignedInteger(exponent);
				}
				const createInput = {
					key: enc.end(),
					format: "der",
					type: "pkcs1"
				};
				const keyObject = isPrivate ? (0, crypto_1$5.createPrivateKey)(createInput) : (0, crypto_1$5.createPublicKey)(createInput);
				(0, check_modulus_length_js_1.setModulusLength)(keyObject, modulus.length << 3);
				return keyObject;
			}
			case "EC": {
				const enc = new asn1_sequence_encoder_js_1.default();
				const isPrivate = jwk.d !== void 0;
				const pub = buffer_1.Buffer.concat([
					buffer_1.Buffer.alloc(1, 4),
					buffer_1.Buffer.from(jwk.x, "base64"),
					buffer_1.Buffer.from(jwk.y, "base64")
				]);
				if (isPrivate) {
					enc.zero();
					const enc$1 = new asn1_sequence_encoder_js_1.default();
					enc$1.oidFor("ecPublicKey");
					enc$1.oidFor(jwk.crv);
					enc.add(enc$1.end());
					const enc$2 = new asn1_sequence_encoder_js_1.default();
					enc$2.one();
					enc$2.octStr(buffer_1.Buffer.from(jwk.d, "base64"));
					const enc$3 = new asn1_sequence_encoder_js_1.default();
					enc$3.bitStr(pub);
					const f2 = enc$3.end(buffer_1.Buffer.from([161]));
					enc$2.add(f2);
					const f = enc$2.end();
					const enc$4 = new asn1_sequence_encoder_js_1.default();
					enc$4.add(f);
					const f3 = enc$4.end(buffer_1.Buffer.from([4]));
					enc.add(f3);
					const der = enc.end();
					const keyObject = (0, crypto_1$5.createPrivateKey)({
						key: der,
						format: "der",
						type: "pkcs8"
					});
					(0, get_named_curve_js_1.setCurve)(keyObject, jwk.crv);
					return keyObject;
				}
				const enc$1 = new asn1_sequence_encoder_js_1.default();
				enc$1.oidFor("ecPublicKey");
				enc$1.oidFor(jwk.crv);
				enc.add(enc$1.end());
				enc.bitStr(pub);
				const der = enc.end();
				const keyObject = (0, crypto_1$5.createPublicKey)({
					key: der,
					format: "der",
					type: "spki"
				});
				(0, get_named_curve_js_1.setCurve)(keyObject, jwk.crv);
				return keyObject;
			}
			case "OKP": {
				const enc = new asn1_sequence_encoder_js_1.default();
				if (jwk.d !== void 0) {
					enc.zero();
					const enc$1 = new asn1_sequence_encoder_js_1.default();
					enc$1.oidFor(jwk.crv);
					enc.add(enc$1.end());
					const enc$2 = new asn1_sequence_encoder_js_1.default();
					enc$2.octStr(buffer_1.Buffer.from(jwk.d, "base64"));
					const f = enc$2.end(buffer_1.Buffer.from([4]));
					enc.add(f);
					const der = enc.end();
					return (0, crypto_1$5.createPrivateKey)({
						key: der,
						format: "der",
						type: "pkcs8"
					});
				}
				const enc$1 = new asn1_sequence_encoder_js_1.default();
				enc$1.oidFor(jwk.crv);
				enc.add(enc$1.end());
				enc.bitStr(buffer_1.Buffer.from(jwk.x, "base64"));
				const der = enc.end();
				return (0, crypto_1$5.createPublicKey)({
					key: der,
					format: "der",
					type: "spki"
				});
			}
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported JWK \"kty\" (Key Type) Parameter value");
		}
	};
	exports.default = parse;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/key/import.js
var require_import = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.importJWK = exports.importPKCS8 = exports.importX509 = exports.importSPKI = void 0;
	const base64url_js_1 = require_base64url$1();
	const asn1_js_1 = require_asn1();
	const jwk_to_key_js_1 = require_jwk_to_key();
	const errors_js_1 = require_errors$1();
	const is_object_js_1 = require_is_object();
	async function importSPKI(spki, alg, options) {
		if (typeof spki !== "string" || spki.indexOf("-----BEGIN PUBLIC KEY-----") !== 0) throw new TypeError("\"spki\" must be SPKI formatted string");
		return (0, asn1_js_1.fromSPKI)(spki, alg, options);
	}
	exports.importSPKI = importSPKI;
	async function importX509(x509, alg, options) {
		if (typeof x509 !== "string" || x509.indexOf("-----BEGIN CERTIFICATE-----") !== 0) throw new TypeError("\"x509\" must be X.509 formatted string");
		return (0, asn1_js_1.fromX509)(x509, alg, options);
	}
	exports.importX509 = importX509;
	async function importPKCS8(pkcs8, alg, options) {
		if (typeof pkcs8 !== "string" || pkcs8.indexOf("-----BEGIN PRIVATE KEY-----") !== 0) throw new TypeError("\"pkcs8\" must be PKCS#8 formatted string");
		return (0, asn1_js_1.fromPKCS8)(pkcs8, alg, options);
	}
	exports.importPKCS8 = importPKCS8;
	async function importJWK(jwk, alg, octAsKeyObject) {
		var _a;
		if (!(0, is_object_js_1.default)(jwk)) throw new TypeError("JWK must be an object");
		alg || (alg = jwk.alg);
		switch (jwk.kty) {
			case "oct":
				if (typeof jwk.k !== "string" || !jwk.k) throw new TypeError("missing \"k\" (Key Value) Parameter value");
				octAsKeyObject !== null && octAsKeyObject !== void 0 || (octAsKeyObject = jwk.ext !== true);
				if (octAsKeyObject) return (0, jwk_to_key_js_1.default)({
					...jwk,
					alg,
					ext: (_a = jwk.ext) !== null && _a !== void 0 ? _a : false
				});
				return (0, base64url_js_1.decode)(jwk.k);
			case "RSA": if (jwk.oth !== void 0) throw new errors_js_1.JOSENotSupported("RSA JWK \"oth\" (Other Primes Info) Parameter value is not supported");
			case "EC":
			case "OKP": return (0, jwk_to_key_js_1.default)({
				...jwk,
				alg
			});
			default: throw new errors_js_1.JOSENotSupported("Unsupported \"kty\" (Key Type) Parameter value");
		}
	}
	exports.importJWK = importJWK;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/check_key_type.js
var require_check_key_type = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const symmetricTypeCheck = (alg, key) => {
		if (key instanceof Uint8Array) return;
		if (!(0, is_key_like_js_1.default)(key)) throw new TypeError((0, invalid_key_input_js_1.withAlg)(alg, key, ...is_key_like_js_1.types, "Uint8Array"));
		if (key.type !== "secret") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for symmetric algorithms must be of type "secret"`);
	};
	const asymmetricTypeCheck = (alg, key, usage) => {
		if (!(0, is_key_like_js_1.default)(key)) throw new TypeError((0, invalid_key_input_js_1.withAlg)(alg, key, ...is_key_like_js_1.types));
		if (key.type === "secret") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for asymmetric algorithms must not be of type "secret"`);
		if (usage === "sign" && key.type === "public") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for asymmetric algorithm signing must be of type "private"`);
		if (usage === "decrypt" && key.type === "public") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for asymmetric algorithm decryption must be of type "private"`);
		if (key.algorithm && usage === "verify" && key.type === "private") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for asymmetric algorithm verifying must be of type "public"`);
		if (key.algorithm && usage === "encrypt" && key.type === "private") throw new TypeError(`${is_key_like_js_1.types.join(" or ")} instances for asymmetric algorithm encryption must be of type "public"`);
	};
	const checkKeyType = (alg, key, usage) => {
		if (alg.startsWith("HS") || alg === "dir" || alg.startsWith("PBES2") || /^A\d{3}(?:GCM)?KW$/.test(alg)) symmetricTypeCheck(alg, key);
		else asymmetricTypeCheck(alg, key, usage);
	};
	exports.default = checkKeyType;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/encrypt.js
var require_encrypt$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$4 = __require("crypto");
	const check_iv_length_js_1 = require_check_iv_length();
	const check_cek_length_js_1 = require_check_cek_length();
	const buffer_utils_js_1 = require_buffer_utils();
	const cbc_tag_js_1 = require_cbc_tag();
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const errors_js_1 = require_errors$1();
	const ciphers_js_1 = require_ciphers();
	const is_key_like_js_1 = require_is_key_like();
	function cbcEncrypt(enc, plaintext, cek, iv, aad) {
		const keySize = parseInt(enc.slice(1, 4), 10);
		if ((0, is_key_object_js_1.default)(cek)) cek = cek.export();
		const encKey = cek.subarray(keySize >> 3);
		const macKey = cek.subarray(0, keySize >> 3);
		const algorithm = `aes-${keySize}-cbc`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${enc} is not supported by your javascript runtime`);
		const cipher = (0, crypto_1$4.createCipheriv)(algorithm, encKey, iv);
		const ciphertext = (0, buffer_utils_js_1.concat)(cipher.update(plaintext), cipher.final());
		const macSize = parseInt(enc.slice(-3), 10);
		return {
			ciphertext,
			tag: (0, cbc_tag_js_1.default)(aad, iv, ciphertext, macSize, macKey, keySize)
		};
	}
	function gcmEncrypt(enc, plaintext, cek, iv, aad) {
		const algorithm = `aes-${parseInt(enc.slice(1, 4), 10)}-gcm`;
		if (!(0, ciphers_js_1.default)(algorithm)) throw new errors_js_1.JOSENotSupported(`alg ${enc} is not supported by your javascript runtime`);
		const cipher = (0, crypto_1$4.createCipheriv)(algorithm, cek, iv, { authTagLength: 16 });
		if (aad.byteLength) cipher.setAAD(aad, { plaintextLength: plaintext.length });
		const ciphertext = cipher.update(plaintext);
		cipher.final();
		return {
			ciphertext,
			tag: cipher.getAuthTag()
		};
	}
	const encrypt = (enc, plaintext, cek, iv, aad) => {
		let key;
		if ((0, webcrypto_js_1.isCryptoKey)(cek)) {
			(0, crypto_key_js_1.checkEncCryptoKey)(cek, enc, "encrypt");
			key = crypto_1$4.KeyObject.from(cek);
		} else if (cek instanceof Uint8Array || (0, is_key_object_js_1.default)(cek)) key = cek;
		else throw new TypeError((0, invalid_key_input_js_1.default)(cek, ...is_key_like_js_1.types, "Uint8Array"));
		(0, check_cek_length_js_1.default)(enc, key);
		(0, check_iv_length_js_1.default)(enc, iv);
		switch (enc) {
			case "A128CBC-HS256":
			case "A192CBC-HS384":
			case "A256CBC-HS512": return cbcEncrypt(enc, plaintext, key, iv, aad);
			case "A128GCM":
			case "A192GCM":
			case "A256GCM": return gcmEncrypt(enc, plaintext, key, iv, aad);
			default: throw new errors_js_1.JOSENotSupported("Unsupported JWE Content Encryption Algorithm");
		}
	};
	exports.default = encrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/aesgcmkw.js
var require_aesgcmkw = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.unwrap = exports.wrap = void 0;
	const encrypt_js_1 = require_encrypt$4();
	const decrypt_js_1 = require_decrypt$4();
	const iv_js_1 = require_iv();
	const base64url_js_1 = require_base64url$1();
	async function wrap(alg, key, cek, iv) {
		const jweAlgorithm = alg.slice(0, 7);
		iv || (iv = (0, iv_js_1.default)(jweAlgorithm));
		const { ciphertext: encryptedKey, tag } = await (0, encrypt_js_1.default)(jweAlgorithm, cek, key, iv, new Uint8Array(0));
		return {
			encryptedKey,
			iv: (0, base64url_js_1.encode)(iv),
			tag: (0, base64url_js_1.encode)(tag)
		};
	}
	exports.wrap = wrap;
	async function unwrap(alg, key, encryptedKey, iv, tag) {
		const jweAlgorithm = alg.slice(0, 7);
		return (0, decrypt_js_1.default)(jweAlgorithm, key, encryptedKey, iv, tag, new Uint8Array(0));
	}
	exports.unwrap = unwrap;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/decrypt_key_management.js
var require_decrypt_key_management = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const aeskw_js_1 = require_aeskw();
	const ECDH = require_ecdhes();
	const pbes2kw_js_1 = require_pbes2kw();
	const rsaes_js_1 = require_rsaes();
	const base64url_js_1 = require_base64url$1();
	const errors_js_1 = require_errors$1();
	const cek_js_1 = require_cek();
	const import_js_1 = require_import();
	const check_key_type_js_1 = require_check_key_type();
	const is_object_js_1 = require_is_object();
	const aesgcmkw_js_1 = require_aesgcmkw();
	async function decryptKeyManagement(alg, key, encryptedKey, joseHeader, options) {
		(0, check_key_type_js_1.default)(alg, key, "decrypt");
		switch (alg) {
			case "dir":
				if (encryptedKey !== void 0) throw new errors_js_1.JWEInvalid("Encountered unexpected JWE Encrypted Key");
				return key;
			case "ECDH-ES": if (encryptedKey !== void 0) throw new errors_js_1.JWEInvalid("Encountered unexpected JWE Encrypted Key");
			case "ECDH-ES+A128KW":
			case "ECDH-ES+A192KW":
			case "ECDH-ES+A256KW": {
				if (!(0, is_object_js_1.default)(joseHeader.epk)) throw new errors_js_1.JWEInvalid(`JOSE Header "epk" (Ephemeral Public Key) missing or invalid`);
				if (!ECDH.ecdhAllowed(key)) throw new errors_js_1.JOSENotSupported("ECDH with the provided key is not allowed or not supported by your javascript runtime");
				const epk = await (0, import_js_1.importJWK)(joseHeader.epk, alg);
				let partyUInfo;
				let partyVInfo;
				if (joseHeader.apu !== void 0) {
					if (typeof joseHeader.apu !== "string") throw new errors_js_1.JWEInvalid(`JOSE Header "apu" (Agreement PartyUInfo) invalid`);
					try {
						partyUInfo = (0, base64url_js_1.decode)(joseHeader.apu);
					} catch {
						throw new errors_js_1.JWEInvalid("Failed to base64url decode the apu");
					}
				}
				if (joseHeader.apv !== void 0) {
					if (typeof joseHeader.apv !== "string") throw new errors_js_1.JWEInvalid(`JOSE Header "apv" (Agreement PartyVInfo) invalid`);
					try {
						partyVInfo = (0, base64url_js_1.decode)(joseHeader.apv);
					} catch {
						throw new errors_js_1.JWEInvalid("Failed to base64url decode the apv");
					}
				}
				const sharedSecret = await ECDH.deriveKey(epk, key, alg === "ECDH-ES" ? joseHeader.enc : alg, alg === "ECDH-ES" ? (0, cek_js_1.bitLength)(joseHeader.enc) : parseInt(alg.slice(-5, -2), 10), partyUInfo, partyVInfo);
				if (alg === "ECDH-ES") return sharedSecret;
				if (encryptedKey === void 0) throw new errors_js_1.JWEInvalid("JWE Encrypted Key missing");
				return (0, aeskw_js_1.unwrap)(alg.slice(-6), sharedSecret, encryptedKey);
			}
			case "RSA1_5":
			case "RSA-OAEP":
			case "RSA-OAEP-256":
			case "RSA-OAEP-384":
			case "RSA-OAEP-512":
				if (encryptedKey === void 0) throw new errors_js_1.JWEInvalid("JWE Encrypted Key missing");
				return (0, rsaes_js_1.decrypt)(alg, key, encryptedKey);
			case "PBES2-HS256+A128KW":
			case "PBES2-HS384+A192KW":
			case "PBES2-HS512+A256KW": {
				if (encryptedKey === void 0) throw new errors_js_1.JWEInvalid("JWE Encrypted Key missing");
				if (typeof joseHeader.p2c !== "number") throw new errors_js_1.JWEInvalid(`JOSE Header "p2c" (PBES2 Count) missing or invalid`);
				const p2cLimit = (options === null || options === void 0 ? void 0 : options.maxPBES2Count) || 1e4;
				if (joseHeader.p2c > p2cLimit) throw new errors_js_1.JWEInvalid(`JOSE Header "p2c" (PBES2 Count) out is of acceptable bounds`);
				if (typeof joseHeader.p2s !== "string") throw new errors_js_1.JWEInvalid(`JOSE Header "p2s" (PBES2 Salt) missing or invalid`);
				let p2s;
				try {
					p2s = (0, base64url_js_1.decode)(joseHeader.p2s);
				} catch {
					throw new errors_js_1.JWEInvalid("Failed to base64url decode the p2s");
				}
				return (0, pbes2kw_js_1.decrypt)(alg, key, encryptedKey, joseHeader.p2c, p2s);
			}
			case "A128KW":
			case "A192KW":
			case "A256KW":
				if (encryptedKey === void 0) throw new errors_js_1.JWEInvalid("JWE Encrypted Key missing");
				return (0, aeskw_js_1.unwrap)(alg, key, encryptedKey);
			case "A128GCMKW":
			case "A192GCMKW":
			case "A256GCMKW": {
				if (encryptedKey === void 0) throw new errors_js_1.JWEInvalid("JWE Encrypted Key missing");
				if (typeof joseHeader.iv !== "string") throw new errors_js_1.JWEInvalid(`JOSE Header "iv" (Initialization Vector) missing or invalid`);
				if (typeof joseHeader.tag !== "string") throw new errors_js_1.JWEInvalid(`JOSE Header "tag" (Authentication Tag) missing or invalid`);
				let iv;
				try {
					iv = (0, base64url_js_1.decode)(joseHeader.iv);
				} catch {
					throw new errors_js_1.JWEInvalid("Failed to base64url decode the iv");
				}
				let tag;
				try {
					tag = (0, base64url_js_1.decode)(joseHeader.tag);
				} catch {
					throw new errors_js_1.JWEInvalid("Failed to base64url decode the tag");
				}
				return (0, aesgcmkw_js_1.unwrap)(alg, key, encryptedKey, iv, tag);
			}
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported \"alg\" (JWE Algorithm) header value");
		}
	}
	exports.default = decryptKeyManagement;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/validate_crit.js
var require_validate_crit = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	function validateCrit(Err, recognizedDefault, recognizedOption, protectedHeader, joseHeader) {
		if (joseHeader.crit !== void 0 && protectedHeader.crit === void 0) throw new Err("\"crit\" (Critical) Header Parameter MUST be integrity protected");
		if (!protectedHeader || protectedHeader.crit === void 0) return /* @__PURE__ */ new Set();
		if (!Array.isArray(protectedHeader.crit) || protectedHeader.crit.length === 0 || protectedHeader.crit.some((input) => typeof input !== "string" || input.length === 0)) throw new Err("\"crit\" (Critical) Header Parameter MUST be an array of non-empty strings when present");
		let recognized;
		if (recognizedOption !== void 0) recognized = new Map([...Object.entries(recognizedOption), ...recognizedDefault.entries()]);
		else recognized = recognizedDefault;
		for (const parameter of protectedHeader.crit) {
			if (!recognized.has(parameter)) throw new errors_js_1.JOSENotSupported(`Extension Header Parameter "${parameter}" is not recognized`);
			if (joseHeader[parameter] === void 0) throw new Err(`Extension Header Parameter "${parameter}" is missing`);
			else if (recognized.get(parameter) && protectedHeader[parameter] === void 0) throw new Err(`Extension Header Parameter "${parameter}" MUST be integrity protected`);
		}
		return new Set(protectedHeader.crit);
	}
	exports.default = validateCrit;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/validate_algorithms.js
var require_validate_algorithms = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const validateAlgorithms = (option, algorithms) => {
		if (algorithms !== void 0 && (!Array.isArray(algorithms) || algorithms.some((s) => typeof s !== "string"))) throw new TypeError(`"${option}" option must be an array of strings`);
		if (!algorithms) return;
		return new Set(algorithms);
	};
	exports.default = validateAlgorithms;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/flattened/decrypt.js
var require_decrypt$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.flattenedDecrypt = void 0;
	const base64url_js_1 = require_base64url$1();
	const decrypt_js_1 = require_decrypt$4();
	const zlib_js_1 = require_zlib();
	const errors_js_1 = require_errors$1();
	const is_disjoint_js_1 = require_is_disjoint();
	const is_object_js_1 = require_is_object();
	const decrypt_key_management_js_1 = require_decrypt_key_management();
	const buffer_utils_js_1 = require_buffer_utils();
	const cek_js_1 = require_cek();
	const validate_crit_js_1 = require_validate_crit();
	const validate_algorithms_js_1 = require_validate_algorithms();
	async function flattenedDecrypt(jwe, key, options) {
		var _a;
		if (!(0, is_object_js_1.default)(jwe)) throw new errors_js_1.JWEInvalid("Flattened JWE must be an object");
		if (jwe.protected === void 0 && jwe.header === void 0 && jwe.unprotected === void 0) throw new errors_js_1.JWEInvalid("JOSE Header missing");
		if (typeof jwe.iv !== "string") throw new errors_js_1.JWEInvalid("JWE Initialization Vector missing or incorrect type");
		if (typeof jwe.ciphertext !== "string") throw new errors_js_1.JWEInvalid("JWE Ciphertext missing or incorrect type");
		if (typeof jwe.tag !== "string") throw new errors_js_1.JWEInvalid("JWE Authentication Tag missing or incorrect type");
		if (jwe.protected !== void 0 && typeof jwe.protected !== "string") throw new errors_js_1.JWEInvalid("JWE Protected Header incorrect type");
		if (jwe.encrypted_key !== void 0 && typeof jwe.encrypted_key !== "string") throw new errors_js_1.JWEInvalid("JWE Encrypted Key incorrect type");
		if (jwe.aad !== void 0 && typeof jwe.aad !== "string") throw new errors_js_1.JWEInvalid("JWE AAD incorrect type");
		if (jwe.header !== void 0 && !(0, is_object_js_1.default)(jwe.header)) throw new errors_js_1.JWEInvalid("JWE Shared Unprotected Header incorrect type");
		if (jwe.unprotected !== void 0 && !(0, is_object_js_1.default)(jwe.unprotected)) throw new errors_js_1.JWEInvalid("JWE Per-Recipient Unprotected Header incorrect type");
		let parsedProt;
		if (jwe.protected) try {
			const protectedHeader = (0, base64url_js_1.decode)(jwe.protected);
			parsedProt = JSON.parse(buffer_utils_js_1.decoder.decode(protectedHeader));
		} catch {
			throw new errors_js_1.JWEInvalid("JWE Protected Header is invalid");
		}
		if (!(0, is_disjoint_js_1.default)(parsedProt, jwe.header, jwe.unprotected)) throw new errors_js_1.JWEInvalid("JWE Protected, JWE Unprotected Header, and JWE Per-Recipient Unprotected Header Parameter names must be disjoint");
		const joseHeader = {
			...parsedProt,
			...jwe.header,
			...jwe.unprotected
		};
		(0, validate_crit_js_1.default)(errors_js_1.JWEInvalid, /* @__PURE__ */ new Map(), options === null || options === void 0 ? void 0 : options.crit, parsedProt, joseHeader);
		if (joseHeader.zip !== void 0) {
			if (!parsedProt || !parsedProt.zip) throw new errors_js_1.JWEInvalid("JWE \"zip\" (Compression Algorithm) Header MUST be integrity protected");
			if (joseHeader.zip !== "DEF") throw new errors_js_1.JOSENotSupported("Unsupported JWE \"zip\" (Compression Algorithm) Header Parameter value");
		}
		const { alg, enc } = joseHeader;
		if (typeof alg !== "string" || !alg) throw new errors_js_1.JWEInvalid("missing JWE Algorithm (alg) in JWE Header");
		if (typeof enc !== "string" || !enc) throw new errors_js_1.JWEInvalid("missing JWE Encryption Algorithm (enc) in JWE Header");
		const keyManagementAlgorithms = options && (0, validate_algorithms_js_1.default)("keyManagementAlgorithms", options.keyManagementAlgorithms);
		const contentEncryptionAlgorithms = options && (0, validate_algorithms_js_1.default)("contentEncryptionAlgorithms", options.contentEncryptionAlgorithms);
		if (keyManagementAlgorithms && !keyManagementAlgorithms.has(alg)) throw new errors_js_1.JOSEAlgNotAllowed("\"alg\" (Algorithm) Header Parameter not allowed");
		if (contentEncryptionAlgorithms && !contentEncryptionAlgorithms.has(enc)) throw new errors_js_1.JOSEAlgNotAllowed("\"enc\" (Encryption Algorithm) Header Parameter not allowed");
		let encryptedKey;
		if (jwe.encrypted_key !== void 0) try {
			encryptedKey = (0, base64url_js_1.decode)(jwe.encrypted_key);
		} catch {
			throw new errors_js_1.JWEInvalid("Failed to base64url decode the encrypted_key");
		}
		let resolvedKey = false;
		if (typeof key === "function") {
			key = await key(parsedProt, jwe);
			resolvedKey = true;
		}
		let cek;
		try {
			cek = await (0, decrypt_key_management_js_1.default)(alg, key, encryptedKey, joseHeader, options);
		} catch (err) {
			if (err instanceof TypeError || err instanceof errors_js_1.JWEInvalid || err instanceof errors_js_1.JOSENotSupported) throw err;
			cek = (0, cek_js_1.default)(enc);
		}
		let iv;
		let tag;
		try {
			iv = (0, base64url_js_1.decode)(jwe.iv);
		} catch {
			throw new errors_js_1.JWEInvalid("Failed to base64url decode the iv");
		}
		try {
			tag = (0, base64url_js_1.decode)(jwe.tag);
		} catch {
			throw new errors_js_1.JWEInvalid("Failed to base64url decode the tag");
		}
		const protectedHeader = buffer_utils_js_1.encoder.encode((_a = jwe.protected) !== null && _a !== void 0 ? _a : "");
		let additionalData;
		if (jwe.aad !== void 0) additionalData = (0, buffer_utils_js_1.concat)(protectedHeader, buffer_utils_js_1.encoder.encode("."), buffer_utils_js_1.encoder.encode(jwe.aad));
		else additionalData = protectedHeader;
		let ciphertext;
		try {
			ciphertext = (0, base64url_js_1.decode)(jwe.ciphertext);
		} catch {
			throw new errors_js_1.JWEInvalid("Failed to base64url decode the ciphertext");
		}
		let plaintext = await (0, decrypt_js_1.default)(enc, cek, ciphertext, iv, tag, additionalData);
		if (joseHeader.zip === "DEF") plaintext = await ((options === null || options === void 0 ? void 0 : options.inflateRaw) || zlib_js_1.inflate)(plaintext);
		const result = { plaintext };
		if (jwe.protected !== void 0) result.protectedHeader = parsedProt;
		if (jwe.aad !== void 0) try {
			result.additionalAuthenticatedData = (0, base64url_js_1.decode)(jwe.aad);
		} catch {
			throw new errors_js_1.JWEInvalid("Failed to base64url decode the aad");
		}
		if (jwe.unprotected !== void 0) result.sharedUnprotectedHeader = jwe.unprotected;
		if (jwe.header !== void 0) result.unprotectedHeader = jwe.header;
		if (resolvedKey) return {
			...result,
			key
		};
		return result;
	}
	exports.flattenedDecrypt = flattenedDecrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/compact/decrypt.js
var require_decrypt$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.compactDecrypt = void 0;
	const decrypt_js_1 = require_decrypt$3();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	async function compactDecrypt(jwe, key, options) {
		if (jwe instanceof Uint8Array) jwe = buffer_utils_js_1.decoder.decode(jwe);
		if (typeof jwe !== "string") throw new errors_js_1.JWEInvalid("Compact JWE must be a string or Uint8Array");
		const { 0: protectedHeader, 1: encryptedKey, 2: iv, 3: ciphertext, 4: tag, length } = jwe.split(".");
		if (length !== 5) throw new errors_js_1.JWEInvalid("Invalid Compact JWE");
		const decrypted = await (0, decrypt_js_1.flattenedDecrypt)({
			ciphertext,
			iv: iv || void 0,
			protected: protectedHeader || void 0,
			tag: tag || void 0,
			encrypted_key: encryptedKey || void 0
		}, key, options);
		const result = {
			plaintext: decrypted.plaintext,
			protectedHeader: decrypted.protectedHeader
		};
		if (typeof key === "function") return {
			...result,
			key: decrypted.key
		};
		return result;
	}
	exports.compactDecrypt = compactDecrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/general/decrypt.js
var require_decrypt$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.generalDecrypt = void 0;
	const decrypt_js_1 = require_decrypt$3();
	const errors_js_1 = require_errors$1();
	const is_object_js_1 = require_is_object();
	async function generalDecrypt(jwe, key, options) {
		if (!(0, is_object_js_1.default)(jwe)) throw new errors_js_1.JWEInvalid("General JWE must be an object");
		if (!Array.isArray(jwe.recipients) || !jwe.recipients.every(is_object_js_1.default)) throw new errors_js_1.JWEInvalid("JWE Recipients missing or incorrect type");
		if (!jwe.recipients.length) throw new errors_js_1.JWEInvalid("JWE Recipients has no members");
		for (const recipient of jwe.recipients) try {
			return await (0, decrypt_js_1.flattenedDecrypt)({
				aad: jwe.aad,
				ciphertext: jwe.ciphertext,
				encrypted_key: recipient.encrypted_key,
				header: recipient.header,
				iv: jwe.iv,
				protected: jwe.protected,
				tag: jwe.tag,
				unprotected: jwe.unprotected
			}, key, options);
		} catch {}
		throw new errors_js_1.JWEDecryptionFailed();
	}
	exports.generalDecrypt = generalDecrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/asn1_sequence_decoder.js
var require_asn1_sequence_decoder = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const tagInteger = 2;
	const tagSequence = 48;
	var Asn1SequenceDecoder = class {
		constructor(buffer) {
			if (buffer[0] !== tagSequence) throw new TypeError();
			this.buffer = buffer;
			this.offset = 1;
			if (this.decodeLength() !== buffer.length - this.offset) throw new TypeError();
		}
		decodeLength() {
			let length = this.buffer[this.offset++];
			if (length & 128) {
				const nBytes = length & -129;
				length = 0;
				for (let i = 0; i < nBytes; i++) length = length << 8 | this.buffer[this.offset + i];
				this.offset += nBytes;
			}
			return length;
		}
		unsignedInteger() {
			if (this.buffer[this.offset++] !== tagInteger) throw new TypeError();
			let length = this.decodeLength();
			if (this.buffer[this.offset] === 0) {
				this.offset++;
				length--;
			}
			const result = this.buffer.slice(this.offset, this.offset + length);
			this.offset += length;
			return result;
		}
		end() {
			if (this.offset !== this.buffer.length) throw new TypeError();
		}
	};
	exports.default = Asn1SequenceDecoder;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/key_to_jwk.js
var require_key_to_jwk = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$3 = __require("crypto");
	const base64url_js_1 = require_base64url$1();
	const asn1_sequence_decoder_js_1 = require_asn1_sequence_decoder();
	const errors_js_1 = require_errors$1();
	const get_named_curve_js_1 = require_get_named_curve();
	const webcrypto_js_1 = require_webcrypto();
	const is_key_object_js_1 = require_is_key_object();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	const flags_js_1 = require_flags();
	const keyToJWK = (key) => {
		let keyObject;
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			if (!key.extractable) throw new TypeError("CryptoKey is not extractable");
			keyObject = crypto_1$3.KeyObject.from(key);
		} else if ((0, is_key_object_js_1.default)(key)) keyObject = key;
		else if (key instanceof Uint8Array) return {
			kty: "oct",
			k: (0, base64url_js_1.encode)(key)
		};
		else throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types, "Uint8Array"));
		if (flags_js_1.jwkExport) {
			if (keyObject.type !== "secret" && ![
				"rsa",
				"ec",
				"ed25519",
				"x25519",
				"ed448",
				"x448"
			].includes(keyObject.asymmetricKeyType)) throw new errors_js_1.JOSENotSupported("Unsupported key asymmetricKeyType");
			return keyObject.export({ format: "jwk" });
		}
		switch (keyObject.type) {
			case "secret": return {
				kty: "oct",
				k: (0, base64url_js_1.encode)(keyObject.export())
			};
			case "private":
			case "public": switch (keyObject.asymmetricKeyType) {
				case "rsa": {
					const der = keyObject.export({
						format: "der",
						type: "pkcs1"
					});
					const dec = new asn1_sequence_decoder_js_1.default(der);
					if (keyObject.type === "private") dec.unsignedInteger();
					const n = (0, base64url_js_1.encode)(dec.unsignedInteger());
					const e = (0, base64url_js_1.encode)(dec.unsignedInteger());
					let jwk;
					if (keyObject.type === "private") jwk = {
						d: (0, base64url_js_1.encode)(dec.unsignedInteger()),
						p: (0, base64url_js_1.encode)(dec.unsignedInteger()),
						q: (0, base64url_js_1.encode)(dec.unsignedInteger()),
						dp: (0, base64url_js_1.encode)(dec.unsignedInteger()),
						dq: (0, base64url_js_1.encode)(dec.unsignedInteger()),
						qi: (0, base64url_js_1.encode)(dec.unsignedInteger())
					};
					dec.end();
					return {
						kty: "RSA",
						n,
						e,
						...jwk
					};
				}
				case "ec": {
					const crv = (0, get_named_curve_js_1.default)(keyObject);
					let len;
					let offset;
					let correction;
					switch (crv) {
						case "secp256k1":
							len = 64;
							offset = 33;
							correction = -1;
							break;
						case "P-256":
							len = 64;
							offset = 36;
							correction = -1;
							break;
						case "P-384":
							len = 96;
							offset = 35;
							correction = -3;
							break;
						case "P-521":
							len = 132;
							offset = 35;
							correction = -3;
							break;
						default: throw new errors_js_1.JOSENotSupported("Unsupported curve");
					}
					if (keyObject.type === "public") {
						const der = keyObject.export({
							type: "spki",
							format: "der"
						});
						return {
							kty: "EC",
							crv,
							x: (0, base64url_js_1.encode)(der.subarray(-len, -len / 2)),
							y: (0, base64url_js_1.encode)(der.subarray(-len / 2))
						};
					}
					const der = keyObject.export({
						type: "pkcs8",
						format: "der"
					});
					if (der.length < 100) offset += correction;
					return {
						...keyToJWK((0, crypto_1$3.createPublicKey)(keyObject)),
						d: (0, base64url_js_1.encode)(der.subarray(offset, offset + len / 2))
					};
				}
				case "ed25519":
				case "x25519": {
					const crv = (0, get_named_curve_js_1.default)(keyObject);
					if (keyObject.type === "public") {
						const der = keyObject.export({
							type: "spki",
							format: "der"
						});
						return {
							kty: "OKP",
							crv,
							x: (0, base64url_js_1.encode)(der.subarray(-32))
						};
					}
					const der = keyObject.export({
						type: "pkcs8",
						format: "der"
					});
					return {
						...keyToJWK((0, crypto_1$3.createPublicKey)(keyObject)),
						d: (0, base64url_js_1.encode)(der.subarray(-32))
					};
				}
				case "ed448":
				case "x448": {
					const crv = (0, get_named_curve_js_1.default)(keyObject);
					if (keyObject.type === "public") {
						const der = keyObject.export({
							type: "spki",
							format: "der"
						});
						return {
							kty: "OKP",
							crv,
							x: (0, base64url_js_1.encode)(der.subarray(crv === "Ed448" ? -57 : -56))
						};
					}
					const der = keyObject.export({
						type: "pkcs8",
						format: "der"
					});
					return {
						...keyToJWK((0, crypto_1$3.createPublicKey)(keyObject)),
						d: (0, base64url_js_1.encode)(der.subarray(crv === "Ed448" ? -57 : -56))
					};
				}
				default: throw new errors_js_1.JOSENotSupported("Unsupported key asymmetricKeyType");
			}
			default: throw new errors_js_1.JOSENotSupported("Unsupported key type");
		}
	};
	exports.default = keyToJWK;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/key/export.js
var require_export = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.exportJWK = exports.exportPKCS8 = exports.exportSPKI = void 0;
	const asn1_js_1 = require_asn1();
	const asn1_js_2 = require_asn1();
	const key_to_jwk_js_1 = require_key_to_jwk();
	async function exportSPKI(key) {
		return (0, asn1_js_1.toSPKI)(key);
	}
	exports.exportSPKI = exportSPKI;
	async function exportPKCS8(key) {
		return (0, asn1_js_2.toPKCS8)(key);
	}
	exports.exportPKCS8 = exportPKCS8;
	async function exportJWK(key) {
		return (0, key_to_jwk_js_1.default)(key);
	}
	exports.exportJWK = exportJWK;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/encrypt_key_management.js
var require_encrypt_key_management = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const aeskw_js_1 = require_aeskw();
	const ECDH = require_ecdhes();
	const pbes2kw_js_1 = require_pbes2kw();
	const rsaes_js_1 = require_rsaes();
	const base64url_js_1 = require_base64url$1();
	const cek_js_1 = require_cek();
	const errors_js_1 = require_errors$1();
	const export_js_1 = require_export();
	const check_key_type_js_1 = require_check_key_type();
	const aesgcmkw_js_1 = require_aesgcmkw();
	async function encryptKeyManagement(alg, enc, key, providedCek, providedParameters = {}) {
		let encryptedKey;
		let parameters;
		let cek;
		(0, check_key_type_js_1.default)(alg, key, "encrypt");
		switch (alg) {
			case "dir":
				cek = key;
				break;
			case "ECDH-ES":
			case "ECDH-ES+A128KW":
			case "ECDH-ES+A192KW":
			case "ECDH-ES+A256KW": {
				if (!ECDH.ecdhAllowed(key)) throw new errors_js_1.JOSENotSupported("ECDH with the provided key is not allowed or not supported by your javascript runtime");
				const { apu, apv } = providedParameters;
				let { epk: ephemeralKey } = providedParameters;
				ephemeralKey || (ephemeralKey = (await ECDH.generateEpk(key)).privateKey);
				const { x, y, crv, kty } = await (0, export_js_1.exportJWK)(ephemeralKey);
				const sharedSecret = await ECDH.deriveKey(key, ephemeralKey, alg === "ECDH-ES" ? enc : alg, alg === "ECDH-ES" ? (0, cek_js_1.bitLength)(enc) : parseInt(alg.slice(-5, -2), 10), apu, apv);
				parameters = { epk: {
					x,
					crv,
					kty
				} };
				if (kty === "EC") parameters.epk.y = y;
				if (apu) parameters.apu = (0, base64url_js_1.encode)(apu);
				if (apv) parameters.apv = (0, base64url_js_1.encode)(apv);
				if (alg === "ECDH-ES") {
					cek = sharedSecret;
					break;
				}
				cek = providedCek || (0, cek_js_1.default)(enc);
				const kwAlg = alg.slice(-6);
				encryptedKey = await (0, aeskw_js_1.wrap)(kwAlg, sharedSecret, cek);
				break;
			}
			case "RSA1_5":
			case "RSA-OAEP":
			case "RSA-OAEP-256":
			case "RSA-OAEP-384":
			case "RSA-OAEP-512":
				cek = providedCek || (0, cek_js_1.default)(enc);
				encryptedKey = await (0, rsaes_js_1.encrypt)(alg, key, cek);
				break;
			case "PBES2-HS256+A128KW":
			case "PBES2-HS384+A192KW":
			case "PBES2-HS512+A256KW": {
				cek = providedCek || (0, cek_js_1.default)(enc);
				const { p2c, p2s } = providedParameters;
				({encryptedKey, ...parameters} = await (0, pbes2kw_js_1.encrypt)(alg, key, cek, p2c, p2s));
				break;
			}
			case "A128KW":
			case "A192KW":
			case "A256KW":
				cek = providedCek || (0, cek_js_1.default)(enc);
				encryptedKey = await (0, aeskw_js_1.wrap)(alg, key, cek);
				break;
			case "A128GCMKW":
			case "A192GCMKW":
			case "A256GCMKW": {
				cek = providedCek || (0, cek_js_1.default)(enc);
				const { iv } = providedParameters;
				({encryptedKey, ...parameters} = await (0, aesgcmkw_js_1.wrap)(alg, key, cek, iv));
				break;
			}
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported \"alg\" (JWE Algorithm) header value");
		}
		return {
			cek,
			encryptedKey,
			parameters
		};
	}
	exports.default = encryptKeyManagement;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/flattened/encrypt.js
var require_encrypt$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FlattenedEncrypt = exports.unprotected = void 0;
	const base64url_js_1 = require_base64url$1();
	const encrypt_js_1 = require_encrypt$4();
	const zlib_js_1 = require_zlib();
	const iv_js_1 = require_iv();
	const encrypt_key_management_js_1 = require_encrypt_key_management();
	const errors_js_1 = require_errors$1();
	const is_disjoint_js_1 = require_is_disjoint();
	const buffer_utils_js_1 = require_buffer_utils();
	const validate_crit_js_1 = require_validate_crit();
	exports.unprotected = Symbol();
	var FlattenedEncrypt = class {
		constructor(plaintext) {
			if (!(plaintext instanceof Uint8Array)) throw new TypeError("plaintext must be an instance of Uint8Array");
			this._plaintext = plaintext;
		}
		setKeyManagementParameters(parameters) {
			if (this._keyManagementParameters) throw new TypeError("setKeyManagementParameters can only be called once");
			this._keyManagementParameters = parameters;
			return this;
		}
		setProtectedHeader(protectedHeader) {
			if (this._protectedHeader) throw new TypeError("setProtectedHeader can only be called once");
			this._protectedHeader = protectedHeader;
			return this;
		}
		setSharedUnprotectedHeader(sharedUnprotectedHeader) {
			if (this._sharedUnprotectedHeader) throw new TypeError("setSharedUnprotectedHeader can only be called once");
			this._sharedUnprotectedHeader = sharedUnprotectedHeader;
			return this;
		}
		setUnprotectedHeader(unprotectedHeader) {
			if (this._unprotectedHeader) throw new TypeError("setUnprotectedHeader can only be called once");
			this._unprotectedHeader = unprotectedHeader;
			return this;
		}
		setAdditionalAuthenticatedData(aad) {
			this._aad = aad;
			return this;
		}
		setContentEncryptionKey(cek) {
			if (this._cek) throw new TypeError("setContentEncryptionKey can only be called once");
			this._cek = cek;
			return this;
		}
		setInitializationVector(iv) {
			if (this._iv) throw new TypeError("setInitializationVector can only be called once");
			this._iv = iv;
			return this;
		}
		async encrypt(key, options) {
			if (!this._protectedHeader && !this._unprotectedHeader && !this._sharedUnprotectedHeader) throw new errors_js_1.JWEInvalid("either setProtectedHeader, setUnprotectedHeader, or sharedUnprotectedHeader must be called before #encrypt()");
			if (!(0, is_disjoint_js_1.default)(this._protectedHeader, this._unprotectedHeader, this._sharedUnprotectedHeader)) throw new errors_js_1.JWEInvalid("JWE Protected, JWE Shared Unprotected and JWE Per-Recipient Header Parameter names must be disjoint");
			const joseHeader = {
				...this._protectedHeader,
				...this._unprotectedHeader,
				...this._sharedUnprotectedHeader
			};
			(0, validate_crit_js_1.default)(errors_js_1.JWEInvalid, /* @__PURE__ */ new Map(), options === null || options === void 0 ? void 0 : options.crit, this._protectedHeader, joseHeader);
			if (joseHeader.zip !== void 0) {
				if (!this._protectedHeader || !this._protectedHeader.zip) throw new errors_js_1.JWEInvalid("JWE \"zip\" (Compression Algorithm) Header MUST be integrity protected");
				if (joseHeader.zip !== "DEF") throw new errors_js_1.JOSENotSupported("Unsupported JWE \"zip\" (Compression Algorithm) Header Parameter value");
			}
			const { alg, enc } = joseHeader;
			if (typeof alg !== "string" || !alg) throw new errors_js_1.JWEInvalid("JWE \"alg\" (Algorithm) Header Parameter missing or invalid");
			if (typeof enc !== "string" || !enc) throw new errors_js_1.JWEInvalid("JWE \"enc\" (Encryption Algorithm) Header Parameter missing or invalid");
			let encryptedKey;
			if (alg === "dir") {
				if (this._cek) throw new TypeError("setContentEncryptionKey cannot be called when using Direct Encryption");
			} else if (alg === "ECDH-ES") {
				if (this._cek) throw new TypeError("setContentEncryptionKey cannot be called when using Direct Key Agreement");
			}
			let cek;
			{
				let parameters;
				({cek, encryptedKey, parameters} = await (0, encrypt_key_management_js_1.default)(alg, enc, key, this._cek, this._keyManagementParameters));
				if (parameters) if (options && exports.unprotected in options) if (!this._unprotectedHeader) this.setUnprotectedHeader(parameters);
				else this._unprotectedHeader = {
					...this._unprotectedHeader,
					...parameters
				};
				else if (!this._protectedHeader) this.setProtectedHeader(parameters);
				else this._protectedHeader = {
					...this._protectedHeader,
					...parameters
				};
			}
			this._iv || (this._iv = (0, iv_js_1.default)(enc));
			let additionalData;
			let protectedHeader;
			let aadMember;
			if (this._protectedHeader) protectedHeader = buffer_utils_js_1.encoder.encode((0, base64url_js_1.encode)(JSON.stringify(this._protectedHeader)));
			else protectedHeader = buffer_utils_js_1.encoder.encode("");
			if (this._aad) {
				aadMember = (0, base64url_js_1.encode)(this._aad);
				additionalData = (0, buffer_utils_js_1.concat)(protectedHeader, buffer_utils_js_1.encoder.encode("."), buffer_utils_js_1.encoder.encode(aadMember));
			} else additionalData = protectedHeader;
			let ciphertext;
			let tag;
			if (joseHeader.zip === "DEF") {
				const deflated = await ((options === null || options === void 0 ? void 0 : options.deflateRaw) || zlib_js_1.deflate)(this._plaintext);
				({ciphertext, tag} = await (0, encrypt_js_1.default)(enc, deflated, cek, this._iv, additionalData));
			} else ({ciphertext, tag} = await (0, encrypt_js_1.default)(enc, this._plaintext, cek, this._iv, additionalData));
			const jwe = {
				ciphertext: (0, base64url_js_1.encode)(ciphertext),
				iv: (0, base64url_js_1.encode)(this._iv),
				tag: (0, base64url_js_1.encode)(tag)
			};
			if (encryptedKey) jwe.encrypted_key = (0, base64url_js_1.encode)(encryptedKey);
			if (aadMember) jwe.aad = aadMember;
			if (this._protectedHeader) jwe.protected = buffer_utils_js_1.decoder.decode(protectedHeader);
			if (this._sharedUnprotectedHeader) jwe.unprotected = this._sharedUnprotectedHeader;
			if (this._unprotectedHeader) jwe.header = this._unprotectedHeader;
			return jwe;
		}
	};
	exports.FlattenedEncrypt = FlattenedEncrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/general/encrypt.js
var require_encrypt$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GeneralEncrypt = void 0;
	const encrypt_js_1 = require_encrypt$3();
	const errors_js_1 = require_errors$1();
	const cek_js_1 = require_cek();
	const is_disjoint_js_1 = require_is_disjoint();
	const encrypt_key_management_js_1 = require_encrypt_key_management();
	const base64url_js_1 = require_base64url$1();
	const validate_crit_js_1 = require_validate_crit();
	var IndividualRecipient = class {
		constructor(enc, key, options) {
			this.parent = enc;
			this.key = key;
			this.options = options;
		}
		setUnprotectedHeader(unprotectedHeader) {
			if (this.unprotectedHeader) throw new TypeError("setUnprotectedHeader can only be called once");
			this.unprotectedHeader = unprotectedHeader;
			return this;
		}
		addRecipient(...args) {
			return this.parent.addRecipient(...args);
		}
		encrypt(...args) {
			return this.parent.encrypt(...args);
		}
		done() {
			return this.parent;
		}
	};
	var GeneralEncrypt = class {
		constructor(plaintext) {
			this._recipients = [];
			this._plaintext = plaintext;
		}
		addRecipient(key, options) {
			const recipient = new IndividualRecipient(this, key, { crit: options === null || options === void 0 ? void 0 : options.crit });
			this._recipients.push(recipient);
			return recipient;
		}
		setProtectedHeader(protectedHeader) {
			if (this._protectedHeader) throw new TypeError("setProtectedHeader can only be called once");
			this._protectedHeader = protectedHeader;
			return this;
		}
		setSharedUnprotectedHeader(sharedUnprotectedHeader) {
			if (this._unprotectedHeader) throw new TypeError("setSharedUnprotectedHeader can only be called once");
			this._unprotectedHeader = sharedUnprotectedHeader;
			return this;
		}
		setAdditionalAuthenticatedData(aad) {
			this._aad = aad;
			return this;
		}
		async encrypt(options) {
			var _a, _b, _c;
			if (!this._recipients.length) throw new errors_js_1.JWEInvalid("at least one recipient must be added");
			options = { deflateRaw: options === null || options === void 0 ? void 0 : options.deflateRaw };
			if (this._recipients.length === 1) {
				const [recipient] = this._recipients;
				const flattened = await new encrypt_js_1.FlattenedEncrypt(this._plaintext).setAdditionalAuthenticatedData(this._aad).setProtectedHeader(this._protectedHeader).setSharedUnprotectedHeader(this._unprotectedHeader).setUnprotectedHeader(recipient.unprotectedHeader).encrypt(recipient.key, {
					...recipient.options,
					...options
				});
				let jwe = {
					ciphertext: flattened.ciphertext,
					iv: flattened.iv,
					recipients: [{}],
					tag: flattened.tag
				};
				if (flattened.aad) jwe.aad = flattened.aad;
				if (flattened.protected) jwe.protected = flattened.protected;
				if (flattened.unprotected) jwe.unprotected = flattened.unprotected;
				if (flattened.encrypted_key) jwe.recipients[0].encrypted_key = flattened.encrypted_key;
				if (flattened.header) jwe.recipients[0].header = flattened.header;
				return jwe;
			}
			let enc;
			for (let i = 0; i < this._recipients.length; i++) {
				const recipient = this._recipients[i];
				if (!(0, is_disjoint_js_1.default)(this._protectedHeader, this._unprotectedHeader, recipient.unprotectedHeader)) throw new errors_js_1.JWEInvalid("JWE Protected, JWE Shared Unprotected and JWE Per-Recipient Header Parameter names must be disjoint");
				const joseHeader = {
					...this._protectedHeader,
					...this._unprotectedHeader,
					...recipient.unprotectedHeader
				};
				const { alg } = joseHeader;
				if (typeof alg !== "string" || !alg) throw new errors_js_1.JWEInvalid("JWE \"alg\" (Algorithm) Header Parameter missing or invalid");
				if (alg === "dir" || alg === "ECDH-ES") throw new errors_js_1.JWEInvalid("\"dir\" and \"ECDH-ES\" alg may only be used with a single recipient");
				if (typeof joseHeader.enc !== "string" || !joseHeader.enc) throw new errors_js_1.JWEInvalid("JWE \"enc\" (Encryption Algorithm) Header Parameter missing or invalid");
				if (!enc) enc = joseHeader.enc;
				else if (enc !== joseHeader.enc) throw new errors_js_1.JWEInvalid("JWE \"enc\" (Encryption Algorithm) Header Parameter must be the same for all recipients");
				(0, validate_crit_js_1.default)(errors_js_1.JWEInvalid, /* @__PURE__ */ new Map(), recipient.options.crit, this._protectedHeader, joseHeader);
				if (joseHeader.zip !== void 0) {
					if (!this._protectedHeader || !this._protectedHeader.zip) throw new errors_js_1.JWEInvalid("JWE \"zip\" (Compression Algorithm) Header MUST be integrity protected");
				}
			}
			const cek = (0, cek_js_1.default)(enc);
			let jwe = {
				ciphertext: "",
				iv: "",
				recipients: [],
				tag: ""
			};
			for (let i = 0; i < this._recipients.length; i++) {
				const recipient = this._recipients[i];
				const target = {};
				jwe.recipients.push(target);
				const p2c = {
					...this._protectedHeader,
					...this._unprotectedHeader,
					...recipient.unprotectedHeader
				}.alg.startsWith("PBES2") ? 2048 + i : void 0;
				if (i === 0) {
					const flattened = await new encrypt_js_1.FlattenedEncrypt(this._plaintext).setAdditionalAuthenticatedData(this._aad).setContentEncryptionKey(cek).setProtectedHeader(this._protectedHeader).setSharedUnprotectedHeader(this._unprotectedHeader).setUnprotectedHeader(recipient.unprotectedHeader).setKeyManagementParameters({ p2c }).encrypt(recipient.key, {
						...recipient.options,
						...options,
						[encrypt_js_1.unprotected]: true
					});
					jwe.ciphertext = flattened.ciphertext;
					jwe.iv = flattened.iv;
					jwe.tag = flattened.tag;
					if (flattened.aad) jwe.aad = flattened.aad;
					if (flattened.protected) jwe.protected = flattened.protected;
					if (flattened.unprotected) jwe.unprotected = flattened.unprotected;
					target.encrypted_key = flattened.encrypted_key;
					if (flattened.header) target.header = flattened.header;
					continue;
				}
				const { encryptedKey, parameters } = await (0, encrypt_key_management_js_1.default)(((_a = recipient.unprotectedHeader) === null || _a === void 0 ? void 0 : _a.alg) || ((_b = this._protectedHeader) === null || _b === void 0 ? void 0 : _b.alg) || ((_c = this._unprotectedHeader) === null || _c === void 0 ? void 0 : _c.alg), enc, recipient.key, cek, { p2c });
				target.encrypted_key = (0, base64url_js_1.encode)(encryptedKey);
				if (recipient.unprotectedHeader || parameters) target.header = {
					...recipient.unprotectedHeader,
					...parameters
				};
			}
			return jwe;
		}
	};
	exports.GeneralEncrypt = GeneralEncrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/dsa_digest.js
var require_dsa_digest = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	function dsaDigest(alg) {
		switch (alg) {
			case "PS256":
			case "RS256":
			case "ES256":
			case "ES256K": return "sha256";
			case "PS384":
			case "RS384":
			case "ES384": return "sha384";
			case "PS512":
			case "RS512":
			case "ES512": return "sha512";
			case "EdDSA": return;
			default: throw new errors_js_1.JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
		}
	}
	exports.default = dsaDigest;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/node_key.js
var require_node_key = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$2 = __require("crypto");
	const get_named_curve_js_1 = require_get_named_curve();
	const errors_js_1 = require_errors$1();
	const check_modulus_length_js_1 = require_check_modulus_length();
	const flags_js_1 = require_flags();
	const PSS = {
		padding: crypto_1$2.constants.RSA_PKCS1_PSS_PADDING,
		saltLength: crypto_1$2.constants.RSA_PSS_SALTLEN_DIGEST
	};
	const ecCurveAlgMap = new Map([
		["ES256", "P-256"],
		["ES256K", "secp256k1"],
		["ES384", "P-384"],
		["ES512", "P-521"]
	]);
	function keyForCrypto(alg, key) {
		switch (alg) {
			case "EdDSA":
				if (!["ed25519", "ed448"].includes(key.asymmetricKeyType)) throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be ed25519 or ed448");
				return key;
			case "RS256":
			case "RS384":
			case "RS512":
				if (key.asymmetricKeyType !== "rsa") throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa");
				(0, check_modulus_length_js_1.default)(key, alg);
				return key;
			case flags_js_1.rsaPssParams && "PS256":
			case flags_js_1.rsaPssParams && "PS384":
			case flags_js_1.rsaPssParams && "PS512":
				if (key.asymmetricKeyType === "rsa-pss") {
					const { hashAlgorithm, mgf1HashAlgorithm, saltLength } = key.asymmetricKeyDetails;
					const length = parseInt(alg.slice(-3), 10);
					if (hashAlgorithm !== void 0 && (hashAlgorithm !== `sha${length}` || mgf1HashAlgorithm !== hashAlgorithm)) throw new TypeError(`Invalid key for this operation, its RSA-PSS parameters do not meet the requirements of "alg" ${alg}`);
					if (saltLength !== void 0 && saltLength > length >> 3) throw new TypeError(`Invalid key for this operation, its RSA-PSS parameter saltLength does not meet the requirements of "alg" ${alg}`);
				} else if (key.asymmetricKeyType !== "rsa") throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa or rsa-pss");
				(0, check_modulus_length_js_1.default)(key, alg);
				return {
					key,
					...PSS
				};
			case !flags_js_1.rsaPssParams && "PS256":
			case !flags_js_1.rsaPssParams && "PS384":
			case !flags_js_1.rsaPssParams && "PS512":
				if (key.asymmetricKeyType !== "rsa") throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be rsa");
				(0, check_modulus_length_js_1.default)(key, alg);
				return {
					key,
					...PSS
				};
			case "ES256":
			case "ES256K":
			case "ES384":
			case "ES512": {
				if (key.asymmetricKeyType !== "ec") throw new TypeError("Invalid key for this operation, its asymmetricKeyType must be ec");
				const actual = (0, get_named_curve_js_1.default)(key);
				const expected = ecCurveAlgMap.get(alg);
				if (actual !== expected) throw new TypeError(`Invalid key curve for the algorithm, its curve must be ${expected}, got ${actual}`);
				return {
					dsaEncoding: "ieee-p1363",
					key
				};
			}
			default: throw new errors_js_1.JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
		}
	}
	exports.default = keyForCrypto;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/hmac_digest.js
var require_hmac_digest = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	function hmacDigest(alg) {
		switch (alg) {
			case "HS256": return "sha256";
			case "HS384": return "sha384";
			case "HS512": return "sha512";
			default: throw new errors_js_1.JOSENotSupported(`alg ${alg} is not supported either by JOSE or your javascript runtime`);
		}
	}
	exports.default = hmacDigest;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/get_sign_verify_key.js
var require_get_sign_verify_key = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto_1$1 = __require("crypto");
	const webcrypto_js_1 = require_webcrypto();
	const crypto_key_js_1 = require_crypto_key();
	const invalid_key_input_js_1 = require_invalid_key_input();
	const is_key_like_js_1 = require_is_key_like();
	function getSignVerifyKey(alg, key, usage) {
		if (key instanceof Uint8Array) {
			if (!alg.startsWith("HS")) throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types));
			return (0, crypto_1$1.createSecretKey)(key);
		}
		if (key instanceof crypto_1$1.KeyObject) return key;
		if ((0, webcrypto_js_1.isCryptoKey)(key)) {
			(0, crypto_key_js_1.checkSigCryptoKey)(key, alg, usage);
			return crypto_1$1.KeyObject.from(key);
		}
		throw new TypeError((0, invalid_key_input_js_1.default)(key, ...is_key_like_js_1.types, "Uint8Array"));
	}
	exports.default = getSignVerifyKey;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/sign.js
var require_sign$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto$1 = __require("crypto");
	const util_1$2 = __require("util");
	const dsa_digest_js_1 = require_dsa_digest();
	const hmac_digest_js_1 = require_hmac_digest();
	const node_key_js_1 = require_node_key();
	const get_sign_verify_key_js_1 = require_get_sign_verify_key();
	let oneShotSign;
	if (crypto$1.sign.length > 3) oneShotSign = (0, util_1$2.promisify)(crypto$1.sign);
	else oneShotSign = crypto$1.sign;
	const sign = async (alg, key, data) => {
		const keyObject = (0, get_sign_verify_key_js_1.default)(alg, key, "sign");
		if (alg.startsWith("HS")) {
			const hmac = crypto$1.createHmac((0, hmac_digest_js_1.default)(alg), keyObject);
			hmac.update(data);
			return hmac.digest();
		}
		return oneShotSign((0, dsa_digest_js_1.default)(alg), data, (0, node_key_js_1.default)(alg, keyObject));
	};
	exports.default = sign;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/verify.js
var require_verify$4 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const crypto = __require("crypto");
	const util_1$1 = __require("util");
	const dsa_digest_js_1 = require_dsa_digest();
	const node_key_js_1 = require_node_key();
	const sign_js_1 = require_sign$4();
	const get_sign_verify_key_js_1 = require_get_sign_verify_key();
	const flags_js_1 = require_flags();
	let oneShotVerify;
	if (crypto.verify.length > 4 && flags_js_1.oneShotCallback) oneShotVerify = (0, util_1$1.promisify)(crypto.verify);
	else oneShotVerify = crypto.verify;
	const verify = async (alg, key, signature, data) => {
		const keyObject = (0, get_sign_verify_key_js_1.default)(alg, key, "verify");
		if (alg.startsWith("HS")) {
			const expected = await (0, sign_js_1.default)(alg, keyObject, data);
			const actual = signature;
			try {
				return crypto.timingSafeEqual(actual, expected);
			} catch {
				return false;
			}
		}
		const algorithm = (0, dsa_digest_js_1.default)(alg);
		const keyInput = (0, node_key_js_1.default)(alg, keyObject);
		try {
			return await oneShotVerify(algorithm, data, keyInput, signature);
		} catch {
			return false;
		}
	};
	exports.default = verify;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/flattened/verify.js
var require_verify$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.flattenedVerify = void 0;
	const base64url_js_1 = require_base64url$1();
	const verify_js_1 = require_verify$4();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const is_disjoint_js_1 = require_is_disjoint();
	const is_object_js_1 = require_is_object();
	const check_key_type_js_1 = require_check_key_type();
	const validate_crit_js_1 = require_validate_crit();
	const validate_algorithms_js_1 = require_validate_algorithms();
	async function flattenedVerify(jws, key, options) {
		var _a;
		if (!(0, is_object_js_1.default)(jws)) throw new errors_js_1.JWSInvalid("Flattened JWS must be an object");
		if (jws.protected === void 0 && jws.header === void 0) throw new errors_js_1.JWSInvalid("Flattened JWS must have either of the \"protected\" or \"header\" members");
		if (jws.protected !== void 0 && typeof jws.protected !== "string") throw new errors_js_1.JWSInvalid("JWS Protected Header incorrect type");
		if (jws.payload === void 0) throw new errors_js_1.JWSInvalid("JWS Payload missing");
		if (typeof jws.signature !== "string") throw new errors_js_1.JWSInvalid("JWS Signature missing or incorrect type");
		if (jws.header !== void 0 && !(0, is_object_js_1.default)(jws.header)) throw new errors_js_1.JWSInvalid("JWS Unprotected Header incorrect type");
		let parsedProt = {};
		if (jws.protected) try {
			const protectedHeader = (0, base64url_js_1.decode)(jws.protected);
			parsedProt = JSON.parse(buffer_utils_js_1.decoder.decode(protectedHeader));
		} catch {
			throw new errors_js_1.JWSInvalid("JWS Protected Header is invalid");
		}
		if (!(0, is_disjoint_js_1.default)(parsedProt, jws.header)) throw new errors_js_1.JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
		const joseHeader = {
			...parsedProt,
			...jws.header
		};
		const extensions = (0, validate_crit_js_1.default)(errors_js_1.JWSInvalid, new Map([["b64", true]]), options === null || options === void 0 ? void 0 : options.crit, parsedProt, joseHeader);
		let b64 = true;
		if (extensions.has("b64")) {
			b64 = parsedProt.b64;
			if (typeof b64 !== "boolean") throw new errors_js_1.JWSInvalid("The \"b64\" (base64url-encode payload) Header Parameter must be a boolean");
		}
		const { alg } = joseHeader;
		if (typeof alg !== "string" || !alg) throw new errors_js_1.JWSInvalid("JWS \"alg\" (Algorithm) Header Parameter missing or invalid");
		const algorithms = options && (0, validate_algorithms_js_1.default)("algorithms", options.algorithms);
		if (algorithms && !algorithms.has(alg)) throw new errors_js_1.JOSEAlgNotAllowed("\"alg\" (Algorithm) Header Parameter not allowed");
		if (b64) {
			if (typeof jws.payload !== "string") throw new errors_js_1.JWSInvalid("JWS Payload must be a string");
		} else if (typeof jws.payload !== "string" && !(jws.payload instanceof Uint8Array)) throw new errors_js_1.JWSInvalid("JWS Payload must be a string or an Uint8Array instance");
		let resolvedKey = false;
		if (typeof key === "function") {
			key = await key(parsedProt, jws);
			resolvedKey = true;
		}
		(0, check_key_type_js_1.default)(alg, key, "verify");
		const data = (0, buffer_utils_js_1.concat)(buffer_utils_js_1.encoder.encode((_a = jws.protected) !== null && _a !== void 0 ? _a : ""), buffer_utils_js_1.encoder.encode("."), typeof jws.payload === "string" ? buffer_utils_js_1.encoder.encode(jws.payload) : jws.payload);
		let signature;
		try {
			signature = (0, base64url_js_1.decode)(jws.signature);
		} catch {
			throw new errors_js_1.JWSInvalid("Failed to base64url decode the signature");
		}
		if (!await (0, verify_js_1.default)(alg, key, signature, data)) throw new errors_js_1.JWSSignatureVerificationFailed();
		let payload;
		if (b64) try {
			payload = (0, base64url_js_1.decode)(jws.payload);
		} catch {
			throw new errors_js_1.JWSInvalid("Failed to base64url decode the payload");
		}
		else if (typeof jws.payload === "string") payload = buffer_utils_js_1.encoder.encode(jws.payload);
		else payload = jws.payload;
		const result = { payload };
		if (jws.protected !== void 0) result.protectedHeader = parsedProt;
		if (jws.header !== void 0) result.unprotectedHeader = jws.header;
		if (resolvedKey) return {
			...result,
			key
		};
		return result;
	}
	exports.flattenedVerify = flattenedVerify;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/compact/verify.js
var require_verify$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.compactVerify = void 0;
	const verify_js_1 = require_verify$3();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	async function compactVerify(jws, key, options) {
		if (jws instanceof Uint8Array) jws = buffer_utils_js_1.decoder.decode(jws);
		if (typeof jws !== "string") throw new errors_js_1.JWSInvalid("Compact JWS must be a string or Uint8Array");
		const { 0: protectedHeader, 1: payload, 2: signature, length } = jws.split(".");
		if (length !== 3) throw new errors_js_1.JWSInvalid("Invalid Compact JWS");
		const verified = await (0, verify_js_1.flattenedVerify)({
			payload,
			protected: protectedHeader,
			signature
		}, key, options);
		const result = {
			payload: verified.payload,
			protectedHeader: verified.protectedHeader
		};
		if (typeof key === "function") return {
			...result,
			key: verified.key
		};
		return result;
	}
	exports.compactVerify = compactVerify;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/general/verify.js
var require_verify$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.generalVerify = void 0;
	const verify_js_1 = require_verify$3();
	const errors_js_1 = require_errors$1();
	const is_object_js_1 = require_is_object();
	async function generalVerify(jws, key, options) {
		if (!(0, is_object_js_1.default)(jws)) throw new errors_js_1.JWSInvalid("General JWS must be an object");
		if (!Array.isArray(jws.signatures) || !jws.signatures.every(is_object_js_1.default)) throw new errors_js_1.JWSInvalid("JWS Signatures missing or incorrect type");
		for (const signature of jws.signatures) try {
			return await (0, verify_js_1.flattenedVerify)({
				header: signature.header,
				payload: jws.payload,
				protected: signature.protected,
				signature: signature.signature
			}, key, options);
		} catch {}
		throw new errors_js_1.JWSSignatureVerificationFailed();
	}
	exports.generalVerify = generalVerify;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/epoch.js
var require_epoch = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = (date) => Math.floor(date.getTime() / 1e3);
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/secs.js
var require_secs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const minute = 60;
	const hour = minute * 60;
	const day = hour * 24;
	const week = day * 7;
	const year = day * 365.25;
	const REGEX = /^(\d+|\d+\.\d+) ?(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)$/i;
	exports.default = (str) => {
		const matched = REGEX.exec(str);
		if (!matched) throw new TypeError("Invalid time period format");
		const value = parseFloat(matched[1]);
		switch (matched[2].toLowerCase()) {
			case "sec":
			case "secs":
			case "second":
			case "seconds":
			case "s": return Math.round(value);
			case "minute":
			case "minutes":
			case "min":
			case "mins":
			case "m": return Math.round(value * minute);
			case "hour":
			case "hours":
			case "hr":
			case "hrs":
			case "h": return Math.round(value * hour);
			case "day":
			case "days":
			case "d": return Math.round(value * day);
			case "week":
			case "weeks":
			case "w": return Math.round(value * week);
			default: return Math.round(value * year);
		}
	};
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/lib/jwt_claims_set.js
var require_jwt_claims_set = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const epoch_js_1 = require_epoch();
	const secs_js_1 = require_secs();
	const is_object_js_1 = require_is_object();
	const normalizeTyp = (value) => value.toLowerCase().replace(/^application\//, "");
	const checkAudiencePresence = (audPayload, audOption) => {
		if (typeof audPayload === "string") return audOption.includes(audPayload);
		if (Array.isArray(audPayload)) return audOption.some(Set.prototype.has.bind(new Set(audPayload)));
		return false;
	};
	exports.default = (protectedHeader, encodedPayload, options = {}) => {
		const { typ } = options;
		if (typ && (typeof protectedHeader.typ !== "string" || normalizeTyp(protectedHeader.typ) !== normalizeTyp(typ))) throw new errors_js_1.JWTClaimValidationFailed("unexpected \"typ\" JWT header value", "typ", "check_failed");
		let payload;
		try {
			payload = JSON.parse(buffer_utils_js_1.decoder.decode(encodedPayload));
		} catch {}
		if (!(0, is_object_js_1.default)(payload)) throw new errors_js_1.JWTInvalid("JWT Claims Set must be a top-level JSON object");
		const { requiredClaims = [], issuer, subject, audience, maxTokenAge } = options;
		if (maxTokenAge !== void 0) requiredClaims.push("iat");
		if (audience !== void 0) requiredClaims.push("aud");
		if (subject !== void 0) requiredClaims.push("sub");
		if (issuer !== void 0) requiredClaims.push("iss");
		for (const claim of new Set(requiredClaims.reverse())) if (!(claim in payload)) throw new errors_js_1.JWTClaimValidationFailed(`missing required "${claim}" claim`, claim, "missing");
		if (issuer && !(Array.isArray(issuer) ? issuer : [issuer]).includes(payload.iss)) throw new errors_js_1.JWTClaimValidationFailed("unexpected \"iss\" claim value", "iss", "check_failed");
		if (subject && payload.sub !== subject) throw new errors_js_1.JWTClaimValidationFailed("unexpected \"sub\" claim value", "sub", "check_failed");
		if (audience && !checkAudiencePresence(payload.aud, typeof audience === "string" ? [audience] : audience)) throw new errors_js_1.JWTClaimValidationFailed("unexpected \"aud\" claim value", "aud", "check_failed");
		let tolerance;
		switch (typeof options.clockTolerance) {
			case "string":
				tolerance = (0, secs_js_1.default)(options.clockTolerance);
				break;
			case "number":
				tolerance = options.clockTolerance;
				break;
			case "undefined":
				tolerance = 0;
				break;
			default: throw new TypeError("Invalid clockTolerance option type");
		}
		const { currentDate } = options;
		const now = (0, epoch_js_1.default)(currentDate || /* @__PURE__ */ new Date());
		if ((payload.iat !== void 0 || maxTokenAge) && typeof payload.iat !== "number") throw new errors_js_1.JWTClaimValidationFailed("\"iat\" claim must be a number", "iat", "invalid");
		if (payload.nbf !== void 0) {
			if (typeof payload.nbf !== "number") throw new errors_js_1.JWTClaimValidationFailed("\"nbf\" claim must be a number", "nbf", "invalid");
			if (payload.nbf > now + tolerance) throw new errors_js_1.JWTClaimValidationFailed("\"nbf\" claim timestamp check failed", "nbf", "check_failed");
		}
		if (payload.exp !== void 0) {
			if (typeof payload.exp !== "number") throw new errors_js_1.JWTClaimValidationFailed("\"exp\" claim must be a number", "exp", "invalid");
			if (payload.exp <= now - tolerance) throw new errors_js_1.JWTExpired("\"exp\" claim timestamp check failed", "exp", "check_failed");
		}
		if (maxTokenAge) {
			const age = now - payload.iat;
			const max = typeof maxTokenAge === "number" ? maxTokenAge : (0, secs_js_1.default)(maxTokenAge);
			if (age - tolerance > max) throw new errors_js_1.JWTExpired("\"iat\" claim timestamp check failed (too far in the past)", "iat", "check_failed");
			if (age < 0 - tolerance) throw new errors_js_1.JWTClaimValidationFailed("\"iat\" claim timestamp check failed (it should be in the past)", "iat", "check_failed");
		}
		return payload;
	};
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/verify.js
var require_verify = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.jwtVerify = void 0;
	const verify_js_1 = require_verify$2();
	const jwt_claims_set_js_1 = require_jwt_claims_set();
	const errors_js_1 = require_errors$1();
	async function jwtVerify(jwt, key, options) {
		var _a;
		const verified = await (0, verify_js_1.compactVerify)(jwt, key, options);
		if (((_a = verified.protectedHeader.crit) === null || _a === void 0 ? void 0 : _a.includes("b64")) && verified.protectedHeader.b64 === false) throw new errors_js_1.JWTInvalid("JWTs MUST NOT use unencoded payload");
		const result = {
			payload: (0, jwt_claims_set_js_1.default)(verified.protectedHeader, verified.payload, options),
			protectedHeader: verified.protectedHeader
		};
		if (typeof key === "function") return {
			...result,
			key: verified.key
		};
		return result;
	}
	exports.jwtVerify = jwtVerify;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/decrypt.js
var require_decrypt = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.jwtDecrypt = void 0;
	const decrypt_js_1 = require_decrypt$2();
	const jwt_claims_set_js_1 = require_jwt_claims_set();
	const errors_js_1 = require_errors$1();
	async function jwtDecrypt(jwt, key, options) {
		const decrypted = await (0, decrypt_js_1.compactDecrypt)(jwt, key, options);
		const payload = (0, jwt_claims_set_js_1.default)(decrypted.protectedHeader, decrypted.plaintext, options);
		const { protectedHeader } = decrypted;
		if (protectedHeader.iss !== void 0 && protectedHeader.iss !== payload.iss) throw new errors_js_1.JWTClaimValidationFailed("replicated \"iss\" claim header parameter mismatch", "iss", "mismatch");
		if (protectedHeader.sub !== void 0 && protectedHeader.sub !== payload.sub) throw new errors_js_1.JWTClaimValidationFailed("replicated \"sub\" claim header parameter mismatch", "sub", "mismatch");
		if (protectedHeader.aud !== void 0 && JSON.stringify(protectedHeader.aud) !== JSON.stringify(payload.aud)) throw new errors_js_1.JWTClaimValidationFailed("replicated \"aud\" claim header parameter mismatch", "aud", "mismatch");
		const result = {
			payload,
			protectedHeader
		};
		if (typeof key === "function") return {
			...result,
			key: decrypted.key
		};
		return result;
	}
	exports.jwtDecrypt = jwtDecrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwe/compact/encrypt.js
var require_encrypt$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CompactEncrypt = void 0;
	const encrypt_js_1 = require_encrypt$3();
	var CompactEncrypt = class {
		constructor(plaintext) {
			this._flattened = new encrypt_js_1.FlattenedEncrypt(plaintext);
		}
		setContentEncryptionKey(cek) {
			this._flattened.setContentEncryptionKey(cek);
			return this;
		}
		setInitializationVector(iv) {
			this._flattened.setInitializationVector(iv);
			return this;
		}
		setProtectedHeader(protectedHeader) {
			this._flattened.setProtectedHeader(protectedHeader);
			return this;
		}
		setKeyManagementParameters(parameters) {
			this._flattened.setKeyManagementParameters(parameters);
			return this;
		}
		async encrypt(key, options) {
			const jwe = await this._flattened.encrypt(key, options);
			return [
				jwe.protected,
				jwe.encrypted_key,
				jwe.iv,
				jwe.ciphertext,
				jwe.tag
			].join(".");
		}
	};
	exports.CompactEncrypt = CompactEncrypt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/flattened/sign.js
var require_sign$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FlattenedSign = void 0;
	const base64url_js_1 = require_base64url$1();
	const sign_js_1 = require_sign$4();
	const is_disjoint_js_1 = require_is_disjoint();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const check_key_type_js_1 = require_check_key_type();
	const validate_crit_js_1 = require_validate_crit();
	var FlattenedSign = class {
		constructor(payload) {
			if (!(payload instanceof Uint8Array)) throw new TypeError("payload must be an instance of Uint8Array");
			this._payload = payload;
		}
		setProtectedHeader(protectedHeader) {
			if (this._protectedHeader) throw new TypeError("setProtectedHeader can only be called once");
			this._protectedHeader = protectedHeader;
			return this;
		}
		setUnprotectedHeader(unprotectedHeader) {
			if (this._unprotectedHeader) throw new TypeError("setUnprotectedHeader can only be called once");
			this._unprotectedHeader = unprotectedHeader;
			return this;
		}
		async sign(key, options) {
			if (!this._protectedHeader && !this._unprotectedHeader) throw new errors_js_1.JWSInvalid("either setProtectedHeader or setUnprotectedHeader must be called before #sign()");
			if (!(0, is_disjoint_js_1.default)(this._protectedHeader, this._unprotectedHeader)) throw new errors_js_1.JWSInvalid("JWS Protected and JWS Unprotected Header Parameter names must be disjoint");
			const joseHeader = {
				...this._protectedHeader,
				...this._unprotectedHeader
			};
			const extensions = (0, validate_crit_js_1.default)(errors_js_1.JWSInvalid, new Map([["b64", true]]), options === null || options === void 0 ? void 0 : options.crit, this._protectedHeader, joseHeader);
			let b64 = true;
			if (extensions.has("b64")) {
				b64 = this._protectedHeader.b64;
				if (typeof b64 !== "boolean") throw new errors_js_1.JWSInvalid("The \"b64\" (base64url-encode payload) Header Parameter must be a boolean");
			}
			const { alg } = joseHeader;
			if (typeof alg !== "string" || !alg) throw new errors_js_1.JWSInvalid("JWS \"alg\" (Algorithm) Header Parameter missing or invalid");
			(0, check_key_type_js_1.default)(alg, key, "sign");
			let payload = this._payload;
			if (b64) payload = buffer_utils_js_1.encoder.encode((0, base64url_js_1.encode)(payload));
			let protectedHeader;
			if (this._protectedHeader) protectedHeader = buffer_utils_js_1.encoder.encode((0, base64url_js_1.encode)(JSON.stringify(this._protectedHeader)));
			else protectedHeader = buffer_utils_js_1.encoder.encode("");
			const data = (0, buffer_utils_js_1.concat)(protectedHeader, buffer_utils_js_1.encoder.encode("."), payload);
			const signature = await (0, sign_js_1.default)(alg, key, data);
			const jws = {
				signature: (0, base64url_js_1.encode)(signature),
				payload: ""
			};
			if (b64) jws.payload = buffer_utils_js_1.decoder.decode(payload);
			if (this._unprotectedHeader) jws.header = this._unprotectedHeader;
			if (this._protectedHeader) jws.protected = buffer_utils_js_1.decoder.decode(protectedHeader);
			return jws;
		}
	};
	exports.FlattenedSign = FlattenedSign;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/compact/sign.js
var require_sign$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CompactSign = void 0;
	const sign_js_1 = require_sign$3();
	var CompactSign = class {
		constructor(payload) {
			this._flattened = new sign_js_1.FlattenedSign(payload);
		}
		setProtectedHeader(protectedHeader) {
			this._flattened.setProtectedHeader(protectedHeader);
			return this;
		}
		async sign(key, options) {
			const jws = await this._flattened.sign(key, options);
			if (jws.payload === void 0) throw new TypeError("use the flattened module for creating JWS with b64: false");
			return `${jws.protected}.${jws.payload}.${jws.signature}`;
		}
	};
	exports.CompactSign = CompactSign;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jws/general/sign.js
var require_sign$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GeneralSign = void 0;
	const sign_js_1 = require_sign$3();
	const errors_js_1 = require_errors$1();
	var IndividualSignature = class {
		constructor(sig, key, options) {
			this.parent = sig;
			this.key = key;
			this.options = options;
		}
		setProtectedHeader(protectedHeader) {
			if (this.protectedHeader) throw new TypeError("setProtectedHeader can only be called once");
			this.protectedHeader = protectedHeader;
			return this;
		}
		setUnprotectedHeader(unprotectedHeader) {
			if (this.unprotectedHeader) throw new TypeError("setUnprotectedHeader can only be called once");
			this.unprotectedHeader = unprotectedHeader;
			return this;
		}
		addSignature(...args) {
			return this.parent.addSignature(...args);
		}
		sign(...args) {
			return this.parent.sign(...args);
		}
		done() {
			return this.parent;
		}
	};
	var GeneralSign = class {
		constructor(payload) {
			this._signatures = [];
			this._payload = payload;
		}
		addSignature(key, options) {
			const signature = new IndividualSignature(this, key, options);
			this._signatures.push(signature);
			return signature;
		}
		async sign() {
			if (!this._signatures.length) throw new errors_js_1.JWSInvalid("at least one signature must be added");
			const jws = {
				signatures: [],
				payload: ""
			};
			for (let i = 0; i < this._signatures.length; i++) {
				const signature = this._signatures[i];
				const flattened = new sign_js_1.FlattenedSign(this._payload);
				flattened.setProtectedHeader(signature.protectedHeader);
				flattened.setUnprotectedHeader(signature.unprotectedHeader);
				const { payload, ...rest } = await flattened.sign(signature.key, signature.options);
				if (i === 0) jws.payload = payload;
				else if (jws.payload !== payload) throw new errors_js_1.JWSInvalid("inconsistent use of JWS Unencoded Payload (RFC7797)");
				jws.signatures.push(rest);
			}
			return jws;
		}
	};
	exports.GeneralSign = GeneralSign;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/produce.js
var require_produce = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ProduceJWT = void 0;
	const epoch_js_1 = require_epoch();
	const is_object_js_1 = require_is_object();
	const secs_js_1 = require_secs();
	var ProduceJWT = class {
		constructor(payload) {
			if (!(0, is_object_js_1.default)(payload)) throw new TypeError("JWT Claims Set MUST be an object");
			this._payload = payload;
		}
		setIssuer(issuer) {
			this._payload = {
				...this._payload,
				iss: issuer
			};
			return this;
		}
		setSubject(subject) {
			this._payload = {
				...this._payload,
				sub: subject
			};
			return this;
		}
		setAudience(audience) {
			this._payload = {
				...this._payload,
				aud: audience
			};
			return this;
		}
		setJti(jwtId) {
			this._payload = {
				...this._payload,
				jti: jwtId
			};
			return this;
		}
		setNotBefore(input) {
			if (typeof input === "number") this._payload = {
				...this._payload,
				nbf: input
			};
			else this._payload = {
				...this._payload,
				nbf: (0, epoch_js_1.default)(/* @__PURE__ */ new Date()) + (0, secs_js_1.default)(input)
			};
			return this;
		}
		setExpirationTime(input) {
			if (typeof input === "number") this._payload = {
				...this._payload,
				exp: input
			};
			else this._payload = {
				...this._payload,
				exp: (0, epoch_js_1.default)(/* @__PURE__ */ new Date()) + (0, secs_js_1.default)(input)
			};
			return this;
		}
		setIssuedAt(input) {
			if (typeof input === "undefined") this._payload = {
				...this._payload,
				iat: (0, epoch_js_1.default)(/* @__PURE__ */ new Date())
			};
			else this._payload = {
				...this._payload,
				iat: input
			};
			return this;
		}
	};
	exports.ProduceJWT = ProduceJWT;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/sign.js
var require_sign = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SignJWT = void 0;
	const sign_js_1 = require_sign$2();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const produce_js_1 = require_produce();
	var SignJWT = class extends produce_js_1.ProduceJWT {
		setProtectedHeader(protectedHeader) {
			this._protectedHeader = protectedHeader;
			return this;
		}
		async sign(key, options) {
			var _a;
			const sig = new sign_js_1.CompactSign(buffer_utils_js_1.encoder.encode(JSON.stringify(this._payload)));
			sig.setProtectedHeader(this._protectedHeader);
			if (Array.isArray((_a = this._protectedHeader) === null || _a === void 0 ? void 0 : _a.crit) && this._protectedHeader.crit.includes("b64") && this._protectedHeader.b64 === false) throw new errors_js_1.JWTInvalid("JWTs MUST NOT use unencoded payload");
			return sig.sign(key, options);
		}
	};
	exports.SignJWT = SignJWT;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/encrypt.js
var require_encrypt = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EncryptJWT = void 0;
	const encrypt_js_1 = require_encrypt$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const produce_js_1 = require_produce();
	var EncryptJWT = class extends produce_js_1.ProduceJWT {
		setProtectedHeader(protectedHeader) {
			if (this._protectedHeader) throw new TypeError("setProtectedHeader can only be called once");
			this._protectedHeader = protectedHeader;
			return this;
		}
		setKeyManagementParameters(parameters) {
			if (this._keyManagementParameters) throw new TypeError("setKeyManagementParameters can only be called once");
			this._keyManagementParameters = parameters;
			return this;
		}
		setContentEncryptionKey(cek) {
			if (this._cek) throw new TypeError("setContentEncryptionKey can only be called once");
			this._cek = cek;
			return this;
		}
		setInitializationVector(iv) {
			if (this._iv) throw new TypeError("setInitializationVector can only be called once");
			this._iv = iv;
			return this;
		}
		replicateIssuerAsHeader() {
			this._replicateIssuerAsHeader = true;
			return this;
		}
		replicateSubjectAsHeader() {
			this._replicateSubjectAsHeader = true;
			return this;
		}
		replicateAudienceAsHeader() {
			this._replicateAudienceAsHeader = true;
			return this;
		}
		async encrypt(key, options) {
			const enc = new encrypt_js_1.CompactEncrypt(buffer_utils_js_1.encoder.encode(JSON.stringify(this._payload)));
			if (this._replicateIssuerAsHeader) this._protectedHeader = {
				...this._protectedHeader,
				iss: this._payload.iss
			};
			if (this._replicateSubjectAsHeader) this._protectedHeader = {
				...this._protectedHeader,
				sub: this._payload.sub
			};
			if (this._replicateAudienceAsHeader) this._protectedHeader = {
				...this._protectedHeader,
				aud: this._payload.aud
			};
			enc.setProtectedHeader(this._protectedHeader);
			if (this._iv) enc.setInitializationVector(this._iv);
			if (this._cek) enc.setContentEncryptionKey(this._cek);
			if (this._keyManagementParameters) enc.setKeyManagementParameters(this._keyManagementParameters);
			return enc.encrypt(key, options);
		}
	};
	exports.EncryptJWT = EncryptJWT;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwk/thumbprint.js
var require_thumbprint = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.calculateJwkThumbprintUri = exports.calculateJwkThumbprint = void 0;
	const digest_js_1 = require_digest();
	const base64url_js_1 = require_base64url$1();
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const is_object_js_1 = require_is_object();
	const check = (value, description) => {
		if (typeof value !== "string" || !value) throw new errors_js_1.JWKInvalid(`${description} missing or invalid`);
	};
	async function calculateJwkThumbprint(jwk, digestAlgorithm) {
		if (!(0, is_object_js_1.default)(jwk)) throw new TypeError("JWK must be an object");
		digestAlgorithm !== null && digestAlgorithm !== void 0 || (digestAlgorithm = "sha256");
		if (digestAlgorithm !== "sha256" && digestAlgorithm !== "sha384" && digestAlgorithm !== "sha512") throw new TypeError("digestAlgorithm must one of \"sha256\", \"sha384\", or \"sha512\"");
		let components;
		switch (jwk.kty) {
			case "EC":
				check(jwk.crv, "\"crv\" (Curve) Parameter");
				check(jwk.x, "\"x\" (X Coordinate) Parameter");
				check(jwk.y, "\"y\" (Y Coordinate) Parameter");
				components = {
					crv: jwk.crv,
					kty: jwk.kty,
					x: jwk.x,
					y: jwk.y
				};
				break;
			case "OKP":
				check(jwk.crv, "\"crv\" (Subtype of Key Pair) Parameter");
				check(jwk.x, "\"x\" (Public Key) Parameter");
				components = {
					crv: jwk.crv,
					kty: jwk.kty,
					x: jwk.x
				};
				break;
			case "RSA":
				check(jwk.e, "\"e\" (Exponent) Parameter");
				check(jwk.n, "\"n\" (Modulus) Parameter");
				components = {
					e: jwk.e,
					kty: jwk.kty,
					n: jwk.n
				};
				break;
			case "oct":
				check(jwk.k, "\"k\" (Key Value) Parameter");
				components = {
					k: jwk.k,
					kty: jwk.kty
				};
				break;
			default: throw new errors_js_1.JOSENotSupported("\"kty\" (Key Type) Parameter missing or unsupported");
		}
		const data = buffer_utils_js_1.encoder.encode(JSON.stringify(components));
		return (0, base64url_js_1.encode)(await (0, digest_js_1.default)(digestAlgorithm, data));
	}
	exports.calculateJwkThumbprint = calculateJwkThumbprint;
	async function calculateJwkThumbprintUri(jwk, digestAlgorithm) {
		digestAlgorithm !== null && digestAlgorithm !== void 0 || (digestAlgorithm = "sha256");
		const thumbprint = await calculateJwkThumbprint(jwk, digestAlgorithm);
		return `urn:ietf:params:oauth:jwk-thumbprint:sha-${digestAlgorithm.slice(-3)}:${thumbprint}`;
	}
	exports.calculateJwkThumbprintUri = calculateJwkThumbprintUri;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwk/embedded.js
var require_embedded = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EmbeddedJWK = void 0;
	const import_js_1 = require_import();
	const is_object_js_1 = require_is_object();
	const errors_js_1 = require_errors$1();
	async function EmbeddedJWK(protectedHeader, token) {
		const joseHeader = {
			...protectedHeader,
			...token === null || token === void 0 ? void 0 : token.header
		};
		if (!(0, is_object_js_1.default)(joseHeader.jwk)) throw new errors_js_1.JWSInvalid("\"jwk\" (JSON Web Key) Header Parameter must be a JSON object");
		const key = await (0, import_js_1.importJWK)({
			...joseHeader.jwk,
			ext: true
		}, joseHeader.alg, true);
		if (key instanceof Uint8Array || key.type !== "public") throw new errors_js_1.JWSInvalid("\"jwk\" (JSON Web Key) Header Parameter must be a public key");
		return key;
	}
	exports.EmbeddedJWK = EmbeddedJWK;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwks/local.js
var require_local = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createLocalJWKSet = exports.LocalJWKSet = exports.isJWKSLike = void 0;
	const import_js_1 = require_import();
	const errors_js_1 = require_errors$1();
	const is_object_js_1 = require_is_object();
	function getKtyFromAlg(alg) {
		switch (typeof alg === "string" && alg.slice(0, 2)) {
			case "RS":
			case "PS": return "RSA";
			case "ES": return "EC";
			case "Ed": return "OKP";
			default: throw new errors_js_1.JOSENotSupported("Unsupported \"alg\" value for a JSON Web Key Set");
		}
	}
	function isJWKSLike(jwks) {
		return jwks && typeof jwks === "object" && Array.isArray(jwks.keys) && jwks.keys.every(isJWKLike);
	}
	exports.isJWKSLike = isJWKSLike;
	function isJWKLike(key) {
		return (0, is_object_js_1.default)(key);
	}
	function clone(obj) {
		if (typeof structuredClone === "function") return structuredClone(obj);
		return JSON.parse(JSON.stringify(obj));
	}
	var LocalJWKSet = class {
		constructor(jwks) {
			this._cached = /* @__PURE__ */ new WeakMap();
			if (!isJWKSLike(jwks)) throw new errors_js_1.JWKSInvalid("JSON Web Key Set malformed");
			this._jwks = clone(jwks);
		}
		async getKey(protectedHeader, token) {
			const { alg, kid } = {
				...protectedHeader,
				...token === null || token === void 0 ? void 0 : token.header
			};
			const kty = getKtyFromAlg(alg);
			const candidates = this._jwks.keys.filter((jwk) => {
				let candidate = kty === jwk.kty;
				if (candidate && typeof kid === "string") candidate = kid === jwk.kid;
				if (candidate && typeof jwk.alg === "string") candidate = alg === jwk.alg;
				if (candidate && typeof jwk.use === "string") candidate = jwk.use === "sig";
				if (candidate && Array.isArray(jwk.key_ops)) candidate = jwk.key_ops.includes("verify");
				if (candidate && alg === "EdDSA") candidate = jwk.crv === "Ed25519" || jwk.crv === "Ed448";
				if (candidate) switch (alg) {
					case "ES256":
						candidate = jwk.crv === "P-256";
						break;
					case "ES256K":
						candidate = jwk.crv === "secp256k1";
						break;
					case "ES384":
						candidate = jwk.crv === "P-384";
						break;
					case "ES512":
						candidate = jwk.crv === "P-521";
						break;
				}
				return candidate;
			});
			const { 0: jwk, length } = candidates;
			if (length === 0) throw new errors_js_1.JWKSNoMatchingKey();
			else if (length !== 1) {
				const error = new errors_js_1.JWKSMultipleMatchingKeys();
				const { _cached } = this;
				error[Symbol.asyncIterator] = async function* () {
					for (const jwk of candidates) try {
						yield await importWithAlgCache(_cached, jwk, alg);
					} catch {
						continue;
					}
				};
				throw error;
			}
			return importWithAlgCache(this._cached, jwk, alg);
		}
	};
	exports.LocalJWKSet = LocalJWKSet;
	async function importWithAlgCache(cache, jwk, alg) {
		const cached = cache.get(jwk) || cache.set(jwk, {}).get(jwk);
		if (cached[alg] === void 0) {
			const key = await (0, import_js_1.importJWK)({
				...jwk,
				ext: true
			}, alg);
			if (key instanceof Uint8Array || key.type !== "public") throw new errors_js_1.JWKSInvalid("JSON Web Key Set members must be public keys");
			cached[alg] = key;
		}
		return cached[alg];
	}
	function createLocalJWKSet(jwks) {
		const set = new LocalJWKSet(jwks);
		return async function(protectedHeader, token) {
			return set.getKey(protectedHeader, token);
		};
	}
	exports.createLocalJWKSet = createLocalJWKSet;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/fetch_jwks.js
var require_fetch_jwks = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	const http$1 = __require("http");
	const https$1 = __require("https");
	const events_1$2 = __require("events");
	const errors_js_1 = require_errors$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const fetchJwks = async (url, timeout, options) => {
		let get;
		switch (url.protocol) {
			case "https:":
				get = https$1.get;
				break;
			case "http:":
				get = http$1.get;
				break;
			default: throw new TypeError("Unsupported URL protocol.");
		}
		const { agent, headers } = options;
		const req = get(url.href, {
			agent,
			timeout,
			headers
		});
		const [response] = await Promise.race([(0, events_1$2.once)(req, "response"), (0, events_1$2.once)(req, "timeout")]);
		if (!response) {
			req.destroy();
			throw new errors_js_1.JWKSTimeout();
		}
		if (response.statusCode !== 200) throw new errors_js_1.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
		const parts = [];
		for await (const part of response) parts.push(part);
		try {
			return JSON.parse(buffer_utils_js_1.decoder.decode((0, buffer_utils_js_1.concat)(...parts)));
		} catch {
			throw new errors_js_1.JOSEError("Failed to parse the JSON Web Key Set HTTP response as JSON");
		}
	};
	exports.default = fetchJwks;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwks/remote.js
var require_remote = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createRemoteJWKSet = void 0;
	const fetch_jwks_js_1 = require_fetch_jwks();
	const errors_js_1 = require_errors$1();
	const local_js_1 = require_local();
	function isCloudflareWorkers() {
		return typeof WebSocketPair !== "undefined" || typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers" || typeof EdgeRuntime !== "undefined" && EdgeRuntime === "vercel";
	}
	var RemoteJWKSet = class extends local_js_1.LocalJWKSet {
		constructor(url, options) {
			super({ keys: [] });
			this._jwks = void 0;
			if (!(url instanceof URL)) throw new TypeError("url must be an instance of URL");
			this._url = new URL(url.href);
			this._options = {
				agent: options === null || options === void 0 ? void 0 : options.agent,
				headers: options === null || options === void 0 ? void 0 : options.headers
			};
			this._timeoutDuration = typeof (options === null || options === void 0 ? void 0 : options.timeoutDuration) === "number" ? options === null || options === void 0 ? void 0 : options.timeoutDuration : 5e3;
			this._cooldownDuration = typeof (options === null || options === void 0 ? void 0 : options.cooldownDuration) === "number" ? options === null || options === void 0 ? void 0 : options.cooldownDuration : 3e4;
			this._cacheMaxAge = typeof (options === null || options === void 0 ? void 0 : options.cacheMaxAge) === "number" ? options === null || options === void 0 ? void 0 : options.cacheMaxAge : 6e5;
		}
		coolingDown() {
			return typeof this._jwksTimestamp === "number" ? Date.now() < this._jwksTimestamp + this._cooldownDuration : false;
		}
		fresh() {
			return typeof this._jwksTimestamp === "number" ? Date.now() < this._jwksTimestamp + this._cacheMaxAge : false;
		}
		async getKey(protectedHeader, token) {
			if (!this._jwks || !this.fresh()) await this.reload();
			try {
				return await super.getKey(protectedHeader, token);
			} catch (err) {
				if (err instanceof errors_js_1.JWKSNoMatchingKey) {
					if (this.coolingDown() === false) {
						await this.reload();
						return super.getKey(protectedHeader, token);
					}
				}
				throw err;
			}
		}
		async reload() {
			if (this._pendingFetch && isCloudflareWorkers()) this._pendingFetch = void 0;
			this._pendingFetch || (this._pendingFetch = (0, fetch_jwks_js_1.default)(this._url, this._timeoutDuration, this._options).then((json) => {
				if (!(0, local_js_1.isJWKSLike)(json)) throw new errors_js_1.JWKSInvalid("JSON Web Key Set malformed");
				this._jwks = { keys: json.keys };
				this._jwksTimestamp = Date.now();
				this._pendingFetch = void 0;
			}).catch((err) => {
				this._pendingFetch = void 0;
				throw err;
			}));
			await this._pendingFetch;
		}
	};
	function createRemoteJWKSet(url, options) {
		const set = new RemoteJWKSet(url, options);
		return async function(protectedHeader, token) {
			return set.getKey(protectedHeader, token);
		};
	}
	exports.createRemoteJWKSet = createRemoteJWKSet;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/jwt/unsecured.js
var require_unsecured = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.UnsecuredJWT = void 0;
	const base64url = require_base64url$1();
	const buffer_utils_js_1 = require_buffer_utils();
	const errors_js_1 = require_errors$1();
	const jwt_claims_set_js_1 = require_jwt_claims_set();
	const produce_js_1 = require_produce();
	var UnsecuredJWT = class extends produce_js_1.ProduceJWT {
		encode() {
			return `${base64url.encode(JSON.stringify({ alg: "none" }))}.${base64url.encode(JSON.stringify(this._payload))}.`;
		}
		static decode(jwt, options) {
			if (typeof jwt !== "string") throw new errors_js_1.JWTInvalid("Unsecured JWT must be a string");
			const { 0: encodedHeader, 1: encodedPayload, 2: signature, length } = jwt.split(".");
			if (length !== 3 || signature !== "") throw new errors_js_1.JWTInvalid("Invalid Unsecured JWT");
			let header;
			try {
				header = JSON.parse(buffer_utils_js_1.decoder.decode(base64url.decode(encodedHeader)));
				if (header.alg !== "none") throw new Error();
			} catch {
				throw new errors_js_1.JWTInvalid("Invalid Unsecured JWT");
			}
			return {
				payload: (0, jwt_claims_set_js_1.default)(header, base64url.decode(encodedPayload), options),
				header
			};
		}
	};
	exports.UnsecuredJWT = UnsecuredJWT;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/util/base64url.js
var require_base64url = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decode = exports.encode = void 0;
	const base64url = require_base64url$1();
	exports.encode = base64url.encode;
	exports.decode = base64url.decode;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/util/decode_protected_header.js
var require_decode_protected_header = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decodeProtectedHeader = void 0;
	const base64url_js_1 = require_base64url();
	const buffer_utils_js_1 = require_buffer_utils();
	const is_object_js_1 = require_is_object();
	function decodeProtectedHeader(token) {
		let protectedB64u;
		if (typeof token === "string") {
			const parts = token.split(".");
			if (parts.length === 3 || parts.length === 5) [protectedB64u] = parts;
		} else if (typeof token === "object" && token) if ("protected" in token) protectedB64u = token.protected;
		else throw new TypeError("Token does not contain a Protected Header");
		try {
			if (typeof protectedB64u !== "string" || !protectedB64u) throw new Error();
			const result = JSON.parse(buffer_utils_js_1.decoder.decode((0, base64url_js_1.decode)(protectedB64u)));
			if (!(0, is_object_js_1.default)(result)) throw new Error();
			return result;
		} catch {
			throw new TypeError("Invalid Token or Protected Header formatting");
		}
	}
	exports.decodeProtectedHeader = decodeProtectedHeader;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/util/decode_jwt.js
var require_decode_jwt = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decodeJwt = void 0;
	const base64url_js_1 = require_base64url();
	const buffer_utils_js_1 = require_buffer_utils();
	const is_object_js_1 = require_is_object();
	const errors_js_1 = require_errors$1();
	function decodeJwt(jwt) {
		if (typeof jwt !== "string") throw new errors_js_1.JWTInvalid("JWTs must use Compact JWS serialization, JWT must be a string");
		const { 1: payload, length } = jwt.split(".");
		if (length === 5) throw new errors_js_1.JWTInvalid("Only JWTs using Compact JWS serialization can be decoded");
		if (length !== 3) throw new errors_js_1.JWTInvalid("Invalid JWT");
		if (!payload) throw new errors_js_1.JWTInvalid("JWTs must contain a payload");
		let decoded;
		try {
			decoded = (0, base64url_js_1.decode)(payload);
		} catch {
			throw new errors_js_1.JWTInvalid("Failed to base64url decode the payload");
		}
		let result;
		try {
			result = JSON.parse(buffer_utils_js_1.decoder.decode(decoded));
		} catch {
			throw new errors_js_1.JWTInvalid("Failed to parse the decoded payload as JSON");
		}
		if (!(0, is_object_js_1.default)(result)) throw new errors_js_1.JWTInvalid("Invalid JWT Claims Set");
		return result;
	}
	exports.decodeJwt = decodeJwt;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/generate.js
var require_generate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.generateKeyPair = exports.generateSecret = void 0;
	const crypto_1 = __require("crypto");
	const util_1 = __require("util");
	const random_js_1 = require_random();
	const check_modulus_length_js_1 = require_check_modulus_length();
	const errors_js_1 = require_errors$1();
	const generate = (0, util_1.promisify)(crypto_1.generateKeyPair);
	async function generateSecret(alg, options) {
		let length;
		switch (alg) {
			case "HS256":
			case "HS384":
			case "HS512":
			case "A128CBC-HS256":
			case "A192CBC-HS384":
			case "A256CBC-HS512":
				length = parseInt(alg.slice(-3), 10);
				break;
			case "A128KW":
			case "A192KW":
			case "A256KW":
			case "A128GCMKW":
			case "A192GCMKW":
			case "A256GCMKW":
			case "A128GCM":
			case "A192GCM":
			case "A256GCM":
				length = parseInt(alg.slice(1, 4), 10);
				break;
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported JWK \"alg\" (Algorithm) Parameter value");
		}
		return (0, crypto_1.createSecretKey)((0, random_js_1.default)(new Uint8Array(length >> 3)));
	}
	exports.generateSecret = generateSecret;
	async function generateKeyPair(alg, options) {
		var _a, _b;
		switch (alg) {
			case "RS256":
			case "RS384":
			case "RS512":
			case "PS256":
			case "PS384":
			case "PS512":
			case "RSA-OAEP":
			case "RSA-OAEP-256":
			case "RSA-OAEP-384":
			case "RSA-OAEP-512":
			case "RSA1_5": {
				const modulusLength = (_a = options === null || options === void 0 ? void 0 : options.modulusLength) !== null && _a !== void 0 ? _a : 2048;
				if (typeof modulusLength !== "number" || modulusLength < 2048) throw new errors_js_1.JOSENotSupported("Invalid or unsupported modulusLength option provided, 2048 bits or larger keys must be used");
				const keypair = await generate("rsa", {
					modulusLength,
					publicExponent: 65537
				});
				(0, check_modulus_length_js_1.setModulusLength)(keypair.privateKey, modulusLength);
				(0, check_modulus_length_js_1.setModulusLength)(keypair.publicKey, modulusLength);
				return keypair;
			}
			case "ES256": return generate("ec", { namedCurve: "P-256" });
			case "ES256K": return generate("ec", { namedCurve: "secp256k1" });
			case "ES384": return generate("ec", { namedCurve: "P-384" });
			case "ES512": return generate("ec", { namedCurve: "P-521" });
			case "EdDSA": switch (options === null || options === void 0 ? void 0 : options.crv) {
				case void 0:
				case "Ed25519": return generate("ed25519");
				case "Ed448": return generate("ed448");
				default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported crv option provided, supported values are Ed25519 and Ed448");
			}
			case "ECDH-ES":
			case "ECDH-ES+A128KW":
			case "ECDH-ES+A192KW":
			case "ECDH-ES+A256KW":
				const crv = (_b = options === null || options === void 0 ? void 0 : options.crv) !== null && _b !== void 0 ? _b : "P-256";
				switch (crv) {
					case void 0:
					case "P-256":
					case "P-384":
					case "P-521": return generate("ec", { namedCurve: crv });
					case "X25519": return generate("x25519");
					case "X448": return generate("x448");
					default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported crv option provided, supported values are P-256, P-384, P-521, X25519, and X448");
				}
			default: throw new errors_js_1.JOSENotSupported("Invalid or unsupported JWK \"alg\" (Algorithm) Parameter value");
		}
	}
	exports.generateKeyPair = generateKeyPair;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/key/generate_key_pair.js
var require_generate_key_pair = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.generateKeyPair = void 0;
	const generate_js_1 = require_generate();
	async function generateKeyPair(alg, options) {
		return (0, generate_js_1.generateKeyPair)(alg, options);
	}
	exports.generateKeyPair = generateKeyPair;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/key/generate_secret.js
var require_generate_secret = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.generateSecret = void 0;
	const generate_js_1 = require_generate();
	async function generateSecret(alg, options) {
		return (0, generate_js_1.generateSecret)(alg, options);
	}
	exports.generateSecret = generateSecret;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/runtime/runtime.js
var require_runtime$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = "node:crypto";
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/util/runtime.js
var require_runtime = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.default = require_runtime$1().default;
}));
//#endregion
//#region node_modules/jwks-rsa/node_modules/jose/dist/node/cjs/index.js
var require_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.cryptoRuntime = exports.base64url = exports.generateSecret = exports.generateKeyPair = exports.errors = exports.decodeJwt = exports.decodeProtectedHeader = exports.importJWK = exports.importX509 = exports.importPKCS8 = exports.importSPKI = exports.exportJWK = exports.exportSPKI = exports.exportPKCS8 = exports.UnsecuredJWT = exports.createRemoteJWKSet = exports.createLocalJWKSet = exports.EmbeddedJWK = exports.calculateJwkThumbprintUri = exports.calculateJwkThumbprint = exports.EncryptJWT = exports.SignJWT = exports.GeneralSign = exports.FlattenedSign = exports.CompactSign = exports.FlattenedEncrypt = exports.CompactEncrypt = exports.jwtDecrypt = exports.jwtVerify = exports.generalVerify = exports.flattenedVerify = exports.compactVerify = exports.GeneralEncrypt = exports.generalDecrypt = exports.flattenedDecrypt = exports.compactDecrypt = void 0;
	var decrypt_js_1 = require_decrypt$2();
	Object.defineProperty(exports, "compactDecrypt", {
		enumerable: true,
		get: function() {
			return decrypt_js_1.compactDecrypt;
		}
	});
	var decrypt_js_2 = require_decrypt$3();
	Object.defineProperty(exports, "flattenedDecrypt", {
		enumerable: true,
		get: function() {
			return decrypt_js_2.flattenedDecrypt;
		}
	});
	var decrypt_js_3 = require_decrypt$1();
	Object.defineProperty(exports, "generalDecrypt", {
		enumerable: true,
		get: function() {
			return decrypt_js_3.generalDecrypt;
		}
	});
	var encrypt_js_1 = require_encrypt$2();
	Object.defineProperty(exports, "GeneralEncrypt", {
		enumerable: true,
		get: function() {
			return encrypt_js_1.GeneralEncrypt;
		}
	});
	var verify_js_1 = require_verify$2();
	Object.defineProperty(exports, "compactVerify", {
		enumerable: true,
		get: function() {
			return verify_js_1.compactVerify;
		}
	});
	var verify_js_2 = require_verify$3();
	Object.defineProperty(exports, "flattenedVerify", {
		enumerable: true,
		get: function() {
			return verify_js_2.flattenedVerify;
		}
	});
	var verify_js_3 = require_verify$1();
	Object.defineProperty(exports, "generalVerify", {
		enumerable: true,
		get: function() {
			return verify_js_3.generalVerify;
		}
	});
	var verify_js_4 = require_verify();
	Object.defineProperty(exports, "jwtVerify", {
		enumerable: true,
		get: function() {
			return verify_js_4.jwtVerify;
		}
	});
	var decrypt_js_4 = require_decrypt();
	Object.defineProperty(exports, "jwtDecrypt", {
		enumerable: true,
		get: function() {
			return decrypt_js_4.jwtDecrypt;
		}
	});
	var encrypt_js_2 = require_encrypt$1();
	Object.defineProperty(exports, "CompactEncrypt", {
		enumerable: true,
		get: function() {
			return encrypt_js_2.CompactEncrypt;
		}
	});
	var encrypt_js_3 = require_encrypt$3();
	Object.defineProperty(exports, "FlattenedEncrypt", {
		enumerable: true,
		get: function() {
			return encrypt_js_3.FlattenedEncrypt;
		}
	});
	var sign_js_1 = require_sign$2();
	Object.defineProperty(exports, "CompactSign", {
		enumerable: true,
		get: function() {
			return sign_js_1.CompactSign;
		}
	});
	var sign_js_2 = require_sign$3();
	Object.defineProperty(exports, "FlattenedSign", {
		enumerable: true,
		get: function() {
			return sign_js_2.FlattenedSign;
		}
	});
	var sign_js_3 = require_sign$1();
	Object.defineProperty(exports, "GeneralSign", {
		enumerable: true,
		get: function() {
			return sign_js_3.GeneralSign;
		}
	});
	var sign_js_4 = require_sign();
	Object.defineProperty(exports, "SignJWT", {
		enumerable: true,
		get: function() {
			return sign_js_4.SignJWT;
		}
	});
	var encrypt_js_4 = require_encrypt();
	Object.defineProperty(exports, "EncryptJWT", {
		enumerable: true,
		get: function() {
			return encrypt_js_4.EncryptJWT;
		}
	});
	var thumbprint_js_1 = require_thumbprint();
	Object.defineProperty(exports, "calculateJwkThumbprint", {
		enumerable: true,
		get: function() {
			return thumbprint_js_1.calculateJwkThumbprint;
		}
	});
	Object.defineProperty(exports, "calculateJwkThumbprintUri", {
		enumerable: true,
		get: function() {
			return thumbprint_js_1.calculateJwkThumbprintUri;
		}
	});
	var embedded_js_1 = require_embedded();
	Object.defineProperty(exports, "EmbeddedJWK", {
		enumerable: true,
		get: function() {
			return embedded_js_1.EmbeddedJWK;
		}
	});
	var local_js_1 = require_local();
	Object.defineProperty(exports, "createLocalJWKSet", {
		enumerable: true,
		get: function() {
			return local_js_1.createLocalJWKSet;
		}
	});
	var remote_js_1 = require_remote();
	Object.defineProperty(exports, "createRemoteJWKSet", {
		enumerable: true,
		get: function() {
			return remote_js_1.createRemoteJWKSet;
		}
	});
	var unsecured_js_1 = require_unsecured();
	Object.defineProperty(exports, "UnsecuredJWT", {
		enumerable: true,
		get: function() {
			return unsecured_js_1.UnsecuredJWT;
		}
	});
	var export_js_1 = require_export();
	Object.defineProperty(exports, "exportPKCS8", {
		enumerable: true,
		get: function() {
			return export_js_1.exportPKCS8;
		}
	});
	Object.defineProperty(exports, "exportSPKI", {
		enumerable: true,
		get: function() {
			return export_js_1.exportSPKI;
		}
	});
	Object.defineProperty(exports, "exportJWK", {
		enumerable: true,
		get: function() {
			return export_js_1.exportJWK;
		}
	});
	var import_js_1 = require_import();
	Object.defineProperty(exports, "importSPKI", {
		enumerable: true,
		get: function() {
			return import_js_1.importSPKI;
		}
	});
	Object.defineProperty(exports, "importPKCS8", {
		enumerable: true,
		get: function() {
			return import_js_1.importPKCS8;
		}
	});
	Object.defineProperty(exports, "importX509", {
		enumerable: true,
		get: function() {
			return import_js_1.importX509;
		}
	});
	Object.defineProperty(exports, "importJWK", {
		enumerable: true,
		get: function() {
			return import_js_1.importJWK;
		}
	});
	var decode_protected_header_js_1 = require_decode_protected_header();
	Object.defineProperty(exports, "decodeProtectedHeader", {
		enumerable: true,
		get: function() {
			return decode_protected_header_js_1.decodeProtectedHeader;
		}
	});
	var decode_jwt_js_1 = require_decode_jwt();
	Object.defineProperty(exports, "decodeJwt", {
		enumerable: true,
		get: function() {
			return decode_jwt_js_1.decodeJwt;
		}
	});
	exports.errors = require_errors$1();
	var generate_key_pair_js_1 = require_generate_key_pair();
	Object.defineProperty(exports, "generateKeyPair", {
		enumerable: true,
		get: function() {
			return generate_key_pair_js_1.generateKeyPair;
		}
	});
	var generate_secret_js_1 = require_generate_secret();
	Object.defineProperty(exports, "generateSecret", {
		enumerable: true,
		get: function() {
			return generate_secret_js_1.generateSecret;
		}
	});
	exports.base64url = require_base64url();
	var runtime_js_1 = require_runtime();
	Object.defineProperty(exports, "cryptoRuntime", {
		enumerable: true,
		get: function() {
			return runtime_js_1.default;
		}
	});
}));
//#endregion
//#region node_modules/jwks-rsa/src/errors/JwksError.js
var require_JwksError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function JwksError(message) {
		Error.call(this, message);
		Error.captureStackTrace(this, this.constructor);
		this.name = "JwksError";
		this.message = message;
	}
	JwksError.prototype = Object.create(Error.prototype);
	JwksError.prototype.constructor = JwksError;
	module.exports = JwksError;
}));
//#endregion
//#region node_modules/jwks-rsa/src/utils.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const jose = require_cjs();
	const JwksError = require_JwksError();
	function resolveAlg(jwk) {
		if (jwk.alg) return jwk.alg;
		if (jwk.kty === "RSA") return "RS256";
		if (jwk.kty === "EC") switch (jwk.crv) {
			case "P-256": return "ES256";
			case "secp256k1": return "ES256K";
			case "P-384": return "ES384";
			case "P-521": return "ES512";
		}
		if (jwk.kty === "OKP") switch (jwk.crv) {
			case "Ed25519":
			case "Ed448": return "EdDSA";
		}
		throw new JwksError("Unsupported JWK");
	}
	async function retrieveSigningKeys(jwks) {
		const results = [];
		jwks = jwks.filter(({ use }) => use === "sig" || use === void 0).filter(({ kty }) => kty === "RSA" || kty === "EC" || kty === "OKP");
		for (const jwk of jwks) try {
			const key = await jose.importJWK({
				...jwk,
				ext: true
			}, resolveAlg(jwk));
			if (key.type !== "public") continue;
			let getSpki;
			switch (key[Symbol.toStringTag]) {
				case "CryptoKey": {
					const spki = await jose.exportSPKI(key);
					getSpki = () => spki;
					break;
				}
				default: getSpki = () => key.export({
					format: "pem",
					type: "spki"
				});
			}
			results.push({
				get publicKey() {
					return getSpki();
				},
				get rsaPublicKey() {
					return getSpki();
				},
				getPublicKey() {
					return getSpki();
				},
				...typeof jwk.kid === "string" && jwk.kid ? { kid: jwk.kid } : void 0,
				...typeof jwk.alg === "string" && jwk.alg ? { alg: jwk.alg } : void 0
			});
		} catch (err) {
			continue;
		}
		return results;
	}
	module.exports = { retrieveSigningKeys };
}));
//#endregion
//#region node_modules/jwks-rsa/src/errors/ArgumentError.js
var require_ArgumentError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function ArgumentError(message) {
		Error.call(this, message);
		Error.captureStackTrace(this, this.constructor);
		this.name = "ArgumentError";
		this.message = message;
	}
	ArgumentError.prototype = Object.create(Error.prototype);
	ArgumentError.prototype.constructor = ArgumentError;
	module.exports = ArgumentError;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/request.js
var require_request = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const http = __require("http");
	const https = __require("https");
	const ArgumentError = require_ArgumentError();
	module.exports.default = (options) => {
		if (options.fetcher) return options.fetcher(options.uri);
		return new Promise((resolve, reject) => {
			let url;
			try {
				url = new URL(options.uri);
			} catch (err) {
				throw new ArgumentError("Invalid JWKS URI: The provided URI is not a valid URL.");
			}
			const { hostname, port, protocol, pathname, search } = url;
			const requestOptions = {
				hostname,
				path: pathname + search,
				port,
				method: "GET",
				...options.headers && { headers: { ...options.headers } },
				...options.timeout && { timeout: options.timeout },
				...options.agent && { agent: options.agent }
			};
			const httpRequest = (protocol === "https:" ? https : http).request(requestOptions, (res) => {
				let rawData = "";
				res.setEncoding("utf8");
				res.on("data", (chunk) => {
					rawData += chunk;
				});
				res.on("end", () => {
					if (res.statusCode < 200 || res.statusCode >= 300) reject({ errorMsg: res.body && (res.body.message || res.body) || res.statusMessage || `Http Error ${res.statusCode}` });
					else try {
						resolve(rawData && JSON.parse(rawData));
					} catch (error) {
						reject(error);
					}
				});
			});
			httpRequest.on("timeout", () => httpRequest.destroy()).on("error", (e) => reject(e)).end();
		});
	};
}));
//#endregion
//#region node_modules/lru-memoizer/node_modules/yallist/iterator.js
var require_iterator = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = function(Yallist) {
		Yallist.prototype[Symbol.iterator] = function* () {
			for (let walker = this.head; walker; walker = walker.next) yield walker.value;
		};
	};
}));
//#endregion
//#region node_modules/lru-memoizer/node_modules/yallist/yallist.js
var require_yallist = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = Yallist;
	Yallist.Node = Node;
	Yallist.create = Yallist;
	function Yallist(list) {
		var self = this;
		if (!(self instanceof Yallist)) self = new Yallist();
		self.tail = null;
		self.head = null;
		self.length = 0;
		if (list && typeof list.forEach === "function") list.forEach(function(item) {
			self.push(item);
		});
		else if (arguments.length > 0) for (var i = 0, l = arguments.length; i < l; i++) self.push(arguments[i]);
		return self;
	}
	Yallist.prototype.removeNode = function(node) {
		if (node.list !== this) throw new Error("removing node which does not belong to this list");
		var next = node.next;
		var prev = node.prev;
		if (next) next.prev = prev;
		if (prev) prev.next = next;
		if (node === this.head) this.head = next;
		if (node === this.tail) this.tail = prev;
		node.list.length--;
		node.next = null;
		node.prev = null;
		node.list = null;
		return next;
	};
	Yallist.prototype.unshiftNode = function(node) {
		if (node === this.head) return;
		if (node.list) node.list.removeNode(node);
		var head = this.head;
		node.list = this;
		node.next = head;
		if (head) head.prev = node;
		this.head = node;
		if (!this.tail) this.tail = node;
		this.length++;
	};
	Yallist.prototype.pushNode = function(node) {
		if (node === this.tail) return;
		if (node.list) node.list.removeNode(node);
		var tail = this.tail;
		node.list = this;
		node.prev = tail;
		if (tail) tail.next = node;
		this.tail = node;
		if (!this.head) this.head = node;
		this.length++;
	};
	Yallist.prototype.push = function() {
		for (var i = 0, l = arguments.length; i < l; i++) push(this, arguments[i]);
		return this.length;
	};
	Yallist.prototype.unshift = function() {
		for (var i = 0, l = arguments.length; i < l; i++) unshift(this, arguments[i]);
		return this.length;
	};
	Yallist.prototype.pop = function() {
		if (!this.tail) return;
		var res = this.tail.value;
		this.tail = this.tail.prev;
		if (this.tail) this.tail.next = null;
		else this.head = null;
		this.length--;
		return res;
	};
	Yallist.prototype.shift = function() {
		if (!this.head) return;
		var res = this.head.value;
		this.head = this.head.next;
		if (this.head) this.head.prev = null;
		else this.tail = null;
		this.length--;
		return res;
	};
	Yallist.prototype.forEach = function(fn, thisp) {
		thisp = thisp || this;
		for (var walker = this.head, i = 0; walker !== null; i++) {
			fn.call(thisp, walker.value, i, this);
			walker = walker.next;
		}
	};
	Yallist.prototype.forEachReverse = function(fn, thisp) {
		thisp = thisp || this;
		for (var walker = this.tail, i = this.length - 1; walker !== null; i--) {
			fn.call(thisp, walker.value, i, this);
			walker = walker.prev;
		}
	};
	Yallist.prototype.get = function(n) {
		for (var i = 0, walker = this.head; walker !== null && i < n; i++) walker = walker.next;
		if (i === n && walker !== null) return walker.value;
	};
	Yallist.prototype.getReverse = function(n) {
		for (var i = 0, walker = this.tail; walker !== null && i < n; i++) walker = walker.prev;
		if (i === n && walker !== null) return walker.value;
	};
	Yallist.prototype.map = function(fn, thisp) {
		thisp = thisp || this;
		var res = new Yallist();
		for (var walker = this.head; walker !== null;) {
			res.push(fn.call(thisp, walker.value, this));
			walker = walker.next;
		}
		return res;
	};
	Yallist.prototype.mapReverse = function(fn, thisp) {
		thisp = thisp || this;
		var res = new Yallist();
		for (var walker = this.tail; walker !== null;) {
			res.push(fn.call(thisp, walker.value, this));
			walker = walker.prev;
		}
		return res;
	};
	Yallist.prototype.reduce = function(fn, initial) {
		var acc;
		var walker = this.head;
		if (arguments.length > 1) acc = initial;
		else if (this.head) {
			walker = this.head.next;
			acc = this.head.value;
		} else throw new TypeError("Reduce of empty list with no initial value");
		for (var i = 0; walker !== null; i++) {
			acc = fn(acc, walker.value, i);
			walker = walker.next;
		}
		return acc;
	};
	Yallist.prototype.reduceReverse = function(fn, initial) {
		var acc;
		var walker = this.tail;
		if (arguments.length > 1) acc = initial;
		else if (this.tail) {
			walker = this.tail.prev;
			acc = this.tail.value;
		} else throw new TypeError("Reduce of empty list with no initial value");
		for (var i = this.length - 1; walker !== null; i--) {
			acc = fn(acc, walker.value, i);
			walker = walker.prev;
		}
		return acc;
	};
	Yallist.prototype.toArray = function() {
		var arr = new Array(this.length);
		for (var i = 0, walker = this.head; walker !== null; i++) {
			arr[i] = walker.value;
			walker = walker.next;
		}
		return arr;
	};
	Yallist.prototype.toArrayReverse = function() {
		var arr = new Array(this.length);
		for (var i = 0, walker = this.tail; walker !== null; i++) {
			arr[i] = walker.value;
			walker = walker.prev;
		}
		return arr;
	};
	Yallist.prototype.slice = function(from, to) {
		to = to || this.length;
		if (to < 0) to += this.length;
		from = from || 0;
		if (from < 0) from += this.length;
		var ret = new Yallist();
		if (to < from || to < 0) return ret;
		if (from < 0) from = 0;
		if (to > this.length) to = this.length;
		for (var i = 0, walker = this.head; walker !== null && i < from; i++) walker = walker.next;
		for (; walker !== null && i < to; i++, walker = walker.next) ret.push(walker.value);
		return ret;
	};
	Yallist.prototype.sliceReverse = function(from, to) {
		to = to || this.length;
		if (to < 0) to += this.length;
		from = from || 0;
		if (from < 0) from += this.length;
		var ret = new Yallist();
		if (to < from || to < 0) return ret;
		if (from < 0) from = 0;
		if (to > this.length) to = this.length;
		for (var i = this.length, walker = this.tail; walker !== null && i > to; i--) walker = walker.prev;
		for (; walker !== null && i > from; i--, walker = walker.prev) ret.push(walker.value);
		return ret;
	};
	Yallist.prototype.splice = function(start, deleteCount, ...nodes) {
		if (start > this.length) start = this.length - 1;
		if (start < 0) start = this.length + start;
		for (var i = 0, walker = this.head; walker !== null && i < start; i++) walker = walker.next;
		var ret = [];
		for (var i = 0; walker && i < deleteCount; i++) {
			ret.push(walker.value);
			walker = this.removeNode(walker);
		}
		if (walker === null) walker = this.tail;
		if (walker !== this.head && walker !== this.tail) walker = walker.prev;
		for (var i = 0; i < nodes.length; i++) walker = insert(this, walker, nodes[i]);
		return ret;
	};
	Yallist.prototype.reverse = function() {
		var head = this.head;
		var tail = this.tail;
		for (var walker = head; walker !== null; walker = walker.prev) {
			var p = walker.prev;
			walker.prev = walker.next;
			walker.next = p;
		}
		this.head = tail;
		this.tail = head;
		return this;
	};
	function insert(self, node, value) {
		var inserted = node === self.head ? new Node(value, null, node, self) : new Node(value, node, node.next, self);
		if (inserted.next === null) self.tail = inserted;
		if (inserted.prev === null) self.head = inserted;
		self.length++;
		return inserted;
	}
	function push(self, item) {
		self.tail = new Node(item, self.tail, null, self);
		if (!self.head) self.head = self.tail;
		self.length++;
	}
	function unshift(self, item) {
		self.head = new Node(item, null, self.head, self);
		if (!self.tail) self.tail = self.head;
		self.length++;
	}
	function Node(value, prev, next, list) {
		if (!(this instanceof Node)) return new Node(value, prev, next, list);
		this.list = list;
		this.value = value;
		if (prev) {
			prev.next = this;
			this.prev = prev;
		} else this.prev = null;
		if (next) {
			next.prev = this;
			this.next = next;
		} else this.next = null;
	}
	try {
		require_iterator()(Yallist);
	} catch (er) {}
}));
//#endregion
//#region node_modules/lru-memoizer/node_modules/lru-cache/index.js
var require_lru_cache = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const Yallist = require_yallist();
	const MAX = Symbol("max");
	const LENGTH = Symbol("length");
	const LENGTH_CALCULATOR = Symbol("lengthCalculator");
	const ALLOW_STALE = Symbol("allowStale");
	const MAX_AGE = Symbol("maxAge");
	const DISPOSE = Symbol("dispose");
	const NO_DISPOSE_ON_SET = Symbol("noDisposeOnSet");
	const LRU_LIST = Symbol("lruList");
	const CACHE = Symbol("cache");
	const UPDATE_AGE_ON_GET = Symbol("updateAgeOnGet");
	const naiveLength = () => 1;
	var LRUCache = class {
		constructor(options) {
			if (typeof options === "number") options = { max: options };
			if (!options) options = {};
			if (options.max && (typeof options.max !== "number" || options.max < 0)) throw new TypeError("max must be a non-negative number");
			this[MAX] = options.max || Infinity;
			const lc = options.length || naiveLength;
			this[LENGTH_CALCULATOR] = typeof lc !== "function" ? naiveLength : lc;
			this[ALLOW_STALE] = options.stale || false;
			if (options.maxAge && typeof options.maxAge !== "number") throw new TypeError("maxAge must be a number");
			this[MAX_AGE] = options.maxAge || 0;
			this[DISPOSE] = options.dispose;
			this[NO_DISPOSE_ON_SET] = options.noDisposeOnSet || false;
			this[UPDATE_AGE_ON_GET] = options.updateAgeOnGet || false;
			this.reset();
		}
		set max(mL) {
			if (typeof mL !== "number" || mL < 0) throw new TypeError("max must be a non-negative number");
			this[MAX] = mL || Infinity;
			trim(this);
		}
		get max() {
			return this[MAX];
		}
		set allowStale(allowStale) {
			this[ALLOW_STALE] = !!allowStale;
		}
		get allowStale() {
			return this[ALLOW_STALE];
		}
		set maxAge(mA) {
			if (typeof mA !== "number") throw new TypeError("maxAge must be a non-negative number");
			this[MAX_AGE] = mA;
			trim(this);
		}
		get maxAge() {
			return this[MAX_AGE];
		}
		set lengthCalculator(lC) {
			if (typeof lC !== "function") lC = naiveLength;
			if (lC !== this[LENGTH_CALCULATOR]) {
				this[LENGTH_CALCULATOR] = lC;
				this[LENGTH] = 0;
				this[LRU_LIST].forEach((hit) => {
					hit.length = this[LENGTH_CALCULATOR](hit.value, hit.key);
					this[LENGTH] += hit.length;
				});
			}
			trim(this);
		}
		get lengthCalculator() {
			return this[LENGTH_CALCULATOR];
		}
		get length() {
			return this[LENGTH];
		}
		get itemCount() {
			return this[LRU_LIST].length;
		}
		rforEach(fn, thisp) {
			thisp = thisp || this;
			for (let walker = this[LRU_LIST].tail; walker !== null;) {
				const prev = walker.prev;
				forEachStep(this, fn, walker, thisp);
				walker = prev;
			}
		}
		forEach(fn, thisp) {
			thisp = thisp || this;
			for (let walker = this[LRU_LIST].head; walker !== null;) {
				const next = walker.next;
				forEachStep(this, fn, walker, thisp);
				walker = next;
			}
		}
		keys() {
			return this[LRU_LIST].toArray().map((k) => k.key);
		}
		values() {
			return this[LRU_LIST].toArray().map((k) => k.value);
		}
		reset() {
			if (this[DISPOSE] && this[LRU_LIST] && this[LRU_LIST].length) this[LRU_LIST].forEach((hit) => this[DISPOSE](hit.key, hit.value));
			this[CACHE] = /* @__PURE__ */ new Map();
			this[LRU_LIST] = new Yallist();
			this[LENGTH] = 0;
		}
		dump() {
			return this[LRU_LIST].map((hit) => isStale(this, hit) ? false : {
				k: hit.key,
				v: hit.value,
				e: hit.now + (hit.maxAge || 0)
			}).toArray().filter((h) => h);
		}
		dumpLru() {
			return this[LRU_LIST];
		}
		set(key, value, maxAge) {
			maxAge = maxAge || this[MAX_AGE];
			if (maxAge && typeof maxAge !== "number") throw new TypeError("maxAge must be a number");
			const now = maxAge ? Date.now() : 0;
			const len = this[LENGTH_CALCULATOR](value, key);
			if (this[CACHE].has(key)) {
				if (len > this[MAX]) {
					del(this, this[CACHE].get(key));
					return false;
				}
				const item = this[CACHE].get(key).value;
				if (this[DISPOSE]) {
					if (!this[NO_DISPOSE_ON_SET]) this[DISPOSE](key, item.value);
				}
				item.now = now;
				item.maxAge = maxAge;
				item.value = value;
				this[LENGTH] += len - item.length;
				item.length = len;
				this.get(key);
				trim(this);
				return true;
			}
			const hit = new Entry(key, value, len, now, maxAge);
			if (hit.length > this[MAX]) {
				if (this[DISPOSE]) this[DISPOSE](key, value);
				return false;
			}
			this[LENGTH] += hit.length;
			this[LRU_LIST].unshift(hit);
			this[CACHE].set(key, this[LRU_LIST].head);
			trim(this);
			return true;
		}
		has(key) {
			if (!this[CACHE].has(key)) return false;
			const hit = this[CACHE].get(key).value;
			return !isStale(this, hit);
		}
		get(key) {
			return get(this, key, true);
		}
		peek(key) {
			return get(this, key, false);
		}
		pop() {
			const node = this[LRU_LIST].tail;
			if (!node) return null;
			del(this, node);
			return node.value;
		}
		del(key) {
			del(this, this[CACHE].get(key));
		}
		load(arr) {
			this.reset();
			const now = Date.now();
			for (let l = arr.length - 1; l >= 0; l--) {
				const hit = arr[l];
				const expiresAt = hit.e || 0;
				if (expiresAt === 0) this.set(hit.k, hit.v);
				else {
					const maxAge = expiresAt - now;
					if (maxAge > 0) this.set(hit.k, hit.v, maxAge);
				}
			}
		}
		prune() {
			this[CACHE].forEach((value, key) => get(this, key, false));
		}
	};
	const get = (self, key, doUse) => {
		const node = self[CACHE].get(key);
		if (node) {
			const hit = node.value;
			if (isStale(self, hit)) {
				del(self, node);
				if (!self[ALLOW_STALE]) return void 0;
			} else if (doUse) {
				if (self[UPDATE_AGE_ON_GET]) node.value.now = Date.now();
				self[LRU_LIST].unshiftNode(node);
			}
			return hit.value;
		}
	};
	const isStale = (self, hit) => {
		if (!hit || !hit.maxAge && !self[MAX_AGE]) return false;
		const diff = Date.now() - hit.now;
		return hit.maxAge ? diff > hit.maxAge : self[MAX_AGE] && diff > self[MAX_AGE];
	};
	const trim = (self) => {
		if (self[LENGTH] > self[MAX]) for (let walker = self[LRU_LIST].tail; self[LENGTH] > self[MAX] && walker !== null;) {
			const prev = walker.prev;
			del(self, walker);
			walker = prev;
		}
	};
	const del = (self, node) => {
		if (node) {
			const hit = node.value;
			if (self[DISPOSE]) self[DISPOSE](hit.key, hit.value);
			self[LENGTH] -= hit.length;
			self[CACHE].delete(hit.key);
			self[LRU_LIST].removeNode(node);
		}
	};
	var Entry = class {
		constructor(key, value, length, now, maxAge) {
			this.key = key;
			this.value = value;
			this.length = length;
			this.now = now;
			this.maxAge = maxAge || 0;
		}
	};
	const forEachStep = (self, fn, node, thisp) => {
		let hit = node.value;
		if (isStale(self, hit)) {
			del(self, node);
			if (!self[ALLOW_STALE]) hit = void 0;
		}
		if (hit) fn.call(thisp, hit.value, hit.key, self);
	};
	module.exports = LRUCache;
}));
//#endregion
//#region node_modules/lodash.clonedeep/index.js
var require_lodash_clonedeep = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** Used as the size to enable large array optimizations. */
	var LARGE_ARRAY_SIZE = 200;
	/** Used to stand-in for `undefined` hash values. */
	var HASH_UNDEFINED = "__lodash_hash_undefined__";
	/** Used as references for various `Number` constants. */
	var MAX_SAFE_INTEGER = 9007199254740991;
	/** `Object#toString` result references. */
	var argsTag = "[object Arguments]", arrayTag = "[object Array]", boolTag = "[object Boolean]", dateTag = "[object Date]", errorTag = "[object Error]", funcTag = "[object Function]", genTag = "[object GeneratorFunction]", mapTag = "[object Map]", numberTag = "[object Number]", objectTag = "[object Object]", promiseTag = "[object Promise]", regexpTag = "[object RegExp]", setTag = "[object Set]", stringTag = "[object String]", symbolTag = "[object Symbol]", weakMapTag = "[object WeakMap]";
	var arrayBufferTag = "[object ArrayBuffer]", dataViewTag = "[object DataView]", float32Tag = "[object Float32Array]", float64Tag = "[object Float64Array]", int8Tag = "[object Int8Array]", int16Tag = "[object Int16Array]", int32Tag = "[object Int32Array]", uint8Tag = "[object Uint8Array]", uint8ClampedTag = "[object Uint8ClampedArray]", uint16Tag = "[object Uint16Array]", uint32Tag = "[object Uint32Array]";
	/**
	* Used to match `RegExp`
	* [syntax characters](http://ecma-international.org/ecma-262/7.0/#sec-patterns).
	*/
	var reRegExpChar = /[\\^$.*+?()[\]{}|]/g;
	/** Used to match `RegExp` flags from their coerced string values. */
	var reFlags = /\w*$/;
	/** Used to detect host constructors (Safari). */
	var reIsHostCtor = /^\[object .+?Constructor\]$/;
	/** Used to detect unsigned integer values. */
	var reIsUint = /^(?:0|[1-9]\d*)$/;
	/** Used to identify `toStringTag` values supported by `_.clone`. */
	var cloneableTags = {};
	cloneableTags[argsTag] = cloneableTags[arrayTag] = cloneableTags[arrayBufferTag] = cloneableTags[dataViewTag] = cloneableTags[boolTag] = cloneableTags[dateTag] = cloneableTags[float32Tag] = cloneableTags[float64Tag] = cloneableTags[int8Tag] = cloneableTags[int16Tag] = cloneableTags[int32Tag] = cloneableTags[mapTag] = cloneableTags[numberTag] = cloneableTags[objectTag] = cloneableTags[regexpTag] = cloneableTags[setTag] = cloneableTags[stringTag] = cloneableTags[symbolTag] = cloneableTags[uint8Tag] = cloneableTags[uint8ClampedTag] = cloneableTags[uint16Tag] = cloneableTags[uint32Tag] = true;
	cloneableTags[errorTag] = cloneableTags[funcTag] = cloneableTags[weakMapTag] = false;
	/** Detect free variable `global` from Node.js. */
	var freeGlobal = typeof global == "object" && global && global.Object === Object && global;
	/** Detect free variable `self`. */
	var freeSelf = typeof self == "object" && self && self.Object === Object && self;
	/** Used as a reference to the global object. */
	var root = freeGlobal || freeSelf || Function("return this")();
	/** Detect free variable `exports`. */
	var freeExports = typeof exports == "object" && exports && !exports.nodeType && exports;
	/** Detect free variable `module`. */
	var freeModule = freeExports && typeof module == "object" && module && !module.nodeType && module;
	/** Detect the popular CommonJS extension `module.exports`. */
	var moduleExports = freeModule && freeModule.exports === freeExports;
	/**
	* Adds the key-value `pair` to `map`.
	*
	* @private
	* @param {Object} map The map to modify.
	* @param {Array} pair The key-value pair to add.
	* @returns {Object} Returns `map`.
	*/
	function addMapEntry(map, pair) {
		map.set(pair[0], pair[1]);
		return map;
	}
	/**
	* Adds `value` to `set`.
	*
	* @private
	* @param {Object} set The set to modify.
	* @param {*} value The value to add.
	* @returns {Object} Returns `set`.
	*/
	function addSetEntry(set, value) {
		set.add(value);
		return set;
	}
	/**
	* A specialized version of `_.forEach` for arrays without support for
	* iteratee shorthands.
	*
	* @private
	* @param {Array} [array] The array to iterate over.
	* @param {Function} iteratee The function invoked per iteration.
	* @returns {Array} Returns `array`.
	*/
	function arrayEach(array, iteratee) {
		var index = -1, length = array ? array.length : 0;
		while (++index < length) if (iteratee(array[index], index, array) === false) break;
		return array;
	}
	/**
	* Appends the elements of `values` to `array`.
	*
	* @private
	* @param {Array} array The array to modify.
	* @param {Array} values The values to append.
	* @returns {Array} Returns `array`.
	*/
	function arrayPush(array, values) {
		var index = -1, length = values.length, offset = array.length;
		while (++index < length) array[offset + index] = values[index];
		return array;
	}
	/**
	* A specialized version of `_.reduce` for arrays without support for
	* iteratee shorthands.
	*
	* @private
	* @param {Array} [array] The array to iterate over.
	* @param {Function} iteratee The function invoked per iteration.
	* @param {*} [accumulator] The initial value.
	* @param {boolean} [initAccum] Specify using the first element of `array` as
	*  the initial value.
	* @returns {*} Returns the accumulated value.
	*/
	function arrayReduce(array, iteratee, accumulator, initAccum) {
		var index = -1, length = array ? array.length : 0;
		if (initAccum && length) accumulator = array[++index];
		while (++index < length) accumulator = iteratee(accumulator, array[index], index, array);
		return accumulator;
	}
	/**
	* The base implementation of `_.times` without support for iteratee shorthands
	* or max array length checks.
	*
	* @private
	* @param {number} n The number of times to invoke `iteratee`.
	* @param {Function} iteratee The function invoked per iteration.
	* @returns {Array} Returns the array of results.
	*/
	function baseTimes(n, iteratee) {
		var index = -1, result = Array(n);
		while (++index < n) result[index] = iteratee(index);
		return result;
	}
	/**
	* Gets the value at `key` of `object`.
	*
	* @private
	* @param {Object} [object] The object to query.
	* @param {string} key The key of the property to get.
	* @returns {*} Returns the property value.
	*/
	function getValue(object, key) {
		return object == null ? void 0 : object[key];
	}
	/**
	* Checks if `value` is a host object in IE < 9.
	*
	* @private
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a host object, else `false`.
	*/
	function isHostObject(value) {
		var result = false;
		if (value != null && typeof value.toString != "function") try {
			result = !!(value + "");
		} catch (e) {}
		return result;
	}
	/**
	* Converts `map` to its key-value pairs.
	*
	* @private
	* @param {Object} map The map to convert.
	* @returns {Array} Returns the key-value pairs.
	*/
	function mapToArray(map) {
		var index = -1, result = Array(map.size);
		map.forEach(function(value, key) {
			result[++index] = [key, value];
		});
		return result;
	}
	/**
	* Creates a unary function that invokes `func` with its argument transformed.
	*
	* @private
	* @param {Function} func The function to wrap.
	* @param {Function} transform The argument transform.
	* @returns {Function} Returns the new function.
	*/
	function overArg(func, transform) {
		return function(arg) {
			return func(transform(arg));
		};
	}
	/**
	* Converts `set` to an array of its values.
	*
	* @private
	* @param {Object} set The set to convert.
	* @returns {Array} Returns the values.
	*/
	function setToArray(set) {
		var index = -1, result = Array(set.size);
		set.forEach(function(value) {
			result[++index] = value;
		});
		return result;
	}
	/** Used for built-in method references. */
	var arrayProto = Array.prototype, funcProto = Function.prototype, objectProto = Object.prototype;
	/** Used to detect overreaching core-js shims. */
	var coreJsData = root["__core-js_shared__"];
	/** Used to detect methods masquerading as native. */
	var maskSrcKey = function() {
		var uid = /[^.]+$/.exec(coreJsData && coreJsData.keys && coreJsData.keys.IE_PROTO || "");
		return uid ? "Symbol(src)_1." + uid : "";
	}();
	/** Used to resolve the decompiled source of functions. */
	var funcToString = funcProto.toString;
	/** Used to check objects for own properties. */
	var hasOwnProperty = objectProto.hasOwnProperty;
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = objectProto.toString;
	/** Used to detect if a method is native. */
	var reIsNative = RegExp("^" + funcToString.call(hasOwnProperty).replace(reRegExpChar, "\\$&").replace(/hasOwnProperty|(function).*?(?=\\\()| for .+?(?=\\\])/g, "$1.*?") + "$");
	/** Built-in value references. */
	var Buffer = moduleExports ? root.Buffer : void 0, Symbol = root.Symbol, Uint8Array = root.Uint8Array, getPrototype = overArg(Object.getPrototypeOf, Object), objectCreate = Object.create, propertyIsEnumerable = objectProto.propertyIsEnumerable, splice = arrayProto.splice;
	var nativeGetSymbols = Object.getOwnPropertySymbols, nativeIsBuffer = Buffer ? Buffer.isBuffer : void 0, nativeKeys = overArg(Object.keys, Object);
	var DataView = getNative(root, "DataView"), Map = getNative(root, "Map"), Promise = getNative(root, "Promise"), Set = getNative(root, "Set"), WeakMap = getNative(root, "WeakMap"), nativeCreate = getNative(Object, "create");
	/** Used to detect maps, sets, and weakmaps. */
	var dataViewCtorString = toSource(DataView), mapCtorString = toSource(Map), promiseCtorString = toSource(Promise), setCtorString = toSource(Set), weakMapCtorString = toSource(WeakMap);
	/** Used to convert symbols to primitives and strings. */
	var symbolProto = Symbol ? Symbol.prototype : void 0, symbolValueOf = symbolProto ? symbolProto.valueOf : void 0;
	/**
	* Creates a hash object.
	*
	* @private
	* @constructor
	* @param {Array} [entries] The key-value pairs to cache.
	*/
	function Hash(entries) {
		var index = -1, length = entries ? entries.length : 0;
		this.clear();
		while (++index < length) {
			var entry = entries[index];
			this.set(entry[0], entry[1]);
		}
	}
	/**
	* Removes all key-value entries from the hash.
	*
	* @private
	* @name clear
	* @memberOf Hash
	*/
	function hashClear() {
		this.__data__ = nativeCreate ? nativeCreate(null) : {};
	}
	/**
	* Removes `key` and its value from the hash.
	*
	* @private
	* @name delete
	* @memberOf Hash
	* @param {Object} hash The hash to modify.
	* @param {string} key The key of the value to remove.
	* @returns {boolean} Returns `true` if the entry was removed, else `false`.
	*/
	function hashDelete(key) {
		return this.has(key) && delete this.__data__[key];
	}
	/**
	* Gets the hash value for `key`.
	*
	* @private
	* @name get
	* @memberOf Hash
	* @param {string} key The key of the value to get.
	* @returns {*} Returns the entry value.
	*/
	function hashGet(key) {
		var data = this.__data__;
		if (nativeCreate) {
			var result = data[key];
			return result === HASH_UNDEFINED ? void 0 : result;
		}
		return hasOwnProperty.call(data, key) ? data[key] : void 0;
	}
	/**
	* Checks if a hash value for `key` exists.
	*
	* @private
	* @name has
	* @memberOf Hash
	* @param {string} key The key of the entry to check.
	* @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
	*/
	function hashHas(key) {
		var data = this.__data__;
		return nativeCreate ? data[key] !== void 0 : hasOwnProperty.call(data, key);
	}
	/**
	* Sets the hash `key` to `value`.
	*
	* @private
	* @name set
	* @memberOf Hash
	* @param {string} key The key of the value to set.
	* @param {*} value The value to set.
	* @returns {Object} Returns the hash instance.
	*/
	function hashSet(key, value) {
		var data = this.__data__;
		data[key] = nativeCreate && value === void 0 ? HASH_UNDEFINED : value;
		return this;
	}
	Hash.prototype.clear = hashClear;
	Hash.prototype["delete"] = hashDelete;
	Hash.prototype.get = hashGet;
	Hash.prototype.has = hashHas;
	Hash.prototype.set = hashSet;
	/**
	* Creates an list cache object.
	*
	* @private
	* @constructor
	* @param {Array} [entries] The key-value pairs to cache.
	*/
	function ListCache(entries) {
		var index = -1, length = entries ? entries.length : 0;
		this.clear();
		while (++index < length) {
			var entry = entries[index];
			this.set(entry[0], entry[1]);
		}
	}
	/**
	* Removes all key-value entries from the list cache.
	*
	* @private
	* @name clear
	* @memberOf ListCache
	*/
	function listCacheClear() {
		this.__data__ = [];
	}
	/**
	* Removes `key` and its value from the list cache.
	*
	* @private
	* @name delete
	* @memberOf ListCache
	* @param {string} key The key of the value to remove.
	* @returns {boolean} Returns `true` if the entry was removed, else `false`.
	*/
	function listCacheDelete(key) {
		var data = this.__data__, index = assocIndexOf(data, key);
		if (index < 0) return false;
		if (index == data.length - 1) data.pop();
		else splice.call(data, index, 1);
		return true;
	}
	/**
	* Gets the list cache value for `key`.
	*
	* @private
	* @name get
	* @memberOf ListCache
	* @param {string} key The key of the value to get.
	* @returns {*} Returns the entry value.
	*/
	function listCacheGet(key) {
		var data = this.__data__, index = assocIndexOf(data, key);
		return index < 0 ? void 0 : data[index][1];
	}
	/**
	* Checks if a list cache value for `key` exists.
	*
	* @private
	* @name has
	* @memberOf ListCache
	* @param {string} key The key of the entry to check.
	* @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
	*/
	function listCacheHas(key) {
		return assocIndexOf(this.__data__, key) > -1;
	}
	/**
	* Sets the list cache `key` to `value`.
	*
	* @private
	* @name set
	* @memberOf ListCache
	* @param {string} key The key of the value to set.
	* @param {*} value The value to set.
	* @returns {Object} Returns the list cache instance.
	*/
	function listCacheSet(key, value) {
		var data = this.__data__, index = assocIndexOf(data, key);
		if (index < 0) data.push([key, value]);
		else data[index][1] = value;
		return this;
	}
	ListCache.prototype.clear = listCacheClear;
	ListCache.prototype["delete"] = listCacheDelete;
	ListCache.prototype.get = listCacheGet;
	ListCache.prototype.has = listCacheHas;
	ListCache.prototype.set = listCacheSet;
	/**
	* Creates a map cache object to store key-value pairs.
	*
	* @private
	* @constructor
	* @param {Array} [entries] The key-value pairs to cache.
	*/
	function MapCache(entries) {
		var index = -1, length = entries ? entries.length : 0;
		this.clear();
		while (++index < length) {
			var entry = entries[index];
			this.set(entry[0], entry[1]);
		}
	}
	/**
	* Removes all key-value entries from the map.
	*
	* @private
	* @name clear
	* @memberOf MapCache
	*/
	function mapCacheClear() {
		this.__data__ = {
			"hash": new Hash(),
			"map": new (Map || ListCache)(),
			"string": new Hash()
		};
	}
	/**
	* Removes `key` and its value from the map.
	*
	* @private
	* @name delete
	* @memberOf MapCache
	* @param {string} key The key of the value to remove.
	* @returns {boolean} Returns `true` if the entry was removed, else `false`.
	*/
	function mapCacheDelete(key) {
		return getMapData(this, key)["delete"](key);
	}
	/**
	* Gets the map value for `key`.
	*
	* @private
	* @name get
	* @memberOf MapCache
	* @param {string} key The key of the value to get.
	* @returns {*} Returns the entry value.
	*/
	function mapCacheGet(key) {
		return getMapData(this, key).get(key);
	}
	/**
	* Checks if a map value for `key` exists.
	*
	* @private
	* @name has
	* @memberOf MapCache
	* @param {string} key The key of the entry to check.
	* @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
	*/
	function mapCacheHas(key) {
		return getMapData(this, key).has(key);
	}
	/**
	* Sets the map `key` to `value`.
	*
	* @private
	* @name set
	* @memberOf MapCache
	* @param {string} key The key of the value to set.
	* @param {*} value The value to set.
	* @returns {Object} Returns the map cache instance.
	*/
	function mapCacheSet(key, value) {
		getMapData(this, key).set(key, value);
		return this;
	}
	MapCache.prototype.clear = mapCacheClear;
	MapCache.prototype["delete"] = mapCacheDelete;
	MapCache.prototype.get = mapCacheGet;
	MapCache.prototype.has = mapCacheHas;
	MapCache.prototype.set = mapCacheSet;
	/**
	* Creates a stack cache object to store key-value pairs.
	*
	* @private
	* @constructor
	* @param {Array} [entries] The key-value pairs to cache.
	*/
	function Stack(entries) {
		this.__data__ = new ListCache(entries);
	}
	/**
	* Removes all key-value entries from the stack.
	*
	* @private
	* @name clear
	* @memberOf Stack
	*/
	function stackClear() {
		this.__data__ = new ListCache();
	}
	/**
	* Removes `key` and its value from the stack.
	*
	* @private
	* @name delete
	* @memberOf Stack
	* @param {string} key The key of the value to remove.
	* @returns {boolean} Returns `true` if the entry was removed, else `false`.
	*/
	function stackDelete(key) {
		return this.__data__["delete"](key);
	}
	/**
	* Gets the stack value for `key`.
	*
	* @private
	* @name get
	* @memberOf Stack
	* @param {string} key The key of the value to get.
	* @returns {*} Returns the entry value.
	*/
	function stackGet(key) {
		return this.__data__.get(key);
	}
	/**
	* Checks if a stack value for `key` exists.
	*
	* @private
	* @name has
	* @memberOf Stack
	* @param {string} key The key of the entry to check.
	* @returns {boolean} Returns `true` if an entry for `key` exists, else `false`.
	*/
	function stackHas(key) {
		return this.__data__.has(key);
	}
	/**
	* Sets the stack `key` to `value`.
	*
	* @private
	* @name set
	* @memberOf Stack
	* @param {string} key The key of the value to set.
	* @param {*} value The value to set.
	* @returns {Object} Returns the stack cache instance.
	*/
	function stackSet(key, value) {
		var cache = this.__data__;
		if (cache instanceof ListCache) {
			var pairs = cache.__data__;
			if (!Map || pairs.length < LARGE_ARRAY_SIZE - 1) {
				pairs.push([key, value]);
				return this;
			}
			cache = this.__data__ = new MapCache(pairs);
		}
		cache.set(key, value);
		return this;
	}
	Stack.prototype.clear = stackClear;
	Stack.prototype["delete"] = stackDelete;
	Stack.prototype.get = stackGet;
	Stack.prototype.has = stackHas;
	Stack.prototype.set = stackSet;
	/**
	* Creates an array of the enumerable property names of the array-like `value`.
	*
	* @private
	* @param {*} value The value to query.
	* @param {boolean} inherited Specify returning inherited property names.
	* @returns {Array} Returns the array of property names.
	*/
	function arrayLikeKeys(value, inherited) {
		var result = isArray(value) || isArguments(value) ? baseTimes(value.length, String) : [];
		var length = result.length, skipIndexes = !!length;
		for (var key in value) if ((inherited || hasOwnProperty.call(value, key)) && !(skipIndexes && (key == "length" || isIndex(key, length)))) result.push(key);
		return result;
	}
	/**
	* Assigns `value` to `key` of `object` if the existing value is not equivalent
	* using [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
	* for equality comparisons.
	*
	* @private
	* @param {Object} object The object to modify.
	* @param {string} key The key of the property to assign.
	* @param {*} value The value to assign.
	*/
	function assignValue(object, key, value) {
		var objValue = object[key];
		if (!(hasOwnProperty.call(object, key) && eq(objValue, value)) || value === void 0 && !(key in object)) object[key] = value;
	}
	/**
	* Gets the index at which the `key` is found in `array` of key-value pairs.
	*
	* @private
	* @param {Array} array The array to inspect.
	* @param {*} key The key to search for.
	* @returns {number} Returns the index of the matched value, else `-1`.
	*/
	function assocIndexOf(array, key) {
		var length = array.length;
		while (length--) if (eq(array[length][0], key)) return length;
		return -1;
	}
	/**
	* The base implementation of `_.assign` without support for multiple sources
	* or `customizer` functions.
	*
	* @private
	* @param {Object} object The destination object.
	* @param {Object} source The source object.
	* @returns {Object} Returns `object`.
	*/
	function baseAssign(object, source) {
		return object && copyObject(source, keys(source), object);
	}
	/**
	* The base implementation of `_.clone` and `_.cloneDeep` which tracks
	* traversed objects.
	*
	* @private
	* @param {*} value The value to clone.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @param {boolean} [isFull] Specify a clone including symbols.
	* @param {Function} [customizer] The function to customize cloning.
	* @param {string} [key] The key of `value`.
	* @param {Object} [object] The parent object of `value`.
	* @param {Object} [stack] Tracks traversed objects and their clone counterparts.
	* @returns {*} Returns the cloned value.
	*/
	function baseClone(value, isDeep, isFull, customizer, key, object, stack) {
		var result;
		if (customizer) result = object ? customizer(value, key, object, stack) : customizer(value);
		if (result !== void 0) return result;
		if (!isObject(value)) return value;
		var isArr = isArray(value);
		if (isArr) {
			result = initCloneArray(value);
			if (!isDeep) return copyArray(value, result);
		} else {
			var tag = getTag(value), isFunc = tag == funcTag || tag == genTag;
			if (isBuffer(value)) return cloneBuffer(value, isDeep);
			if (tag == objectTag || tag == argsTag || isFunc && !object) {
				if (isHostObject(value)) return object ? value : {};
				result = initCloneObject(isFunc ? {} : value);
				if (!isDeep) return copySymbols(value, baseAssign(result, value));
			} else {
				if (!cloneableTags[tag]) return object ? value : {};
				result = initCloneByTag(value, tag, baseClone, isDeep);
			}
		}
		stack || (stack = new Stack());
		var stacked = stack.get(value);
		if (stacked) return stacked;
		stack.set(value, result);
		if (!isArr) var props = isFull ? getAllKeys(value) : keys(value);
		arrayEach(props || value, function(subValue, key) {
			if (props) {
				key = subValue;
				subValue = value[key];
			}
			assignValue(result, key, baseClone(subValue, isDeep, isFull, customizer, key, value, stack));
		});
		return result;
	}
	/**
	* The base implementation of `_.create` without support for assigning
	* properties to the created object.
	*
	* @private
	* @param {Object} prototype The object to inherit from.
	* @returns {Object} Returns the new object.
	*/
	function baseCreate(proto) {
		return isObject(proto) ? objectCreate(proto) : {};
	}
	/**
	* The base implementation of `getAllKeys` and `getAllKeysIn` which uses
	* `keysFunc` and `symbolsFunc` to get the enumerable property names and
	* symbols of `object`.
	*
	* @private
	* @param {Object} object The object to query.
	* @param {Function} keysFunc The function to get the keys of `object`.
	* @param {Function} symbolsFunc The function to get the symbols of `object`.
	* @returns {Array} Returns the array of property names and symbols.
	*/
	function baseGetAllKeys(object, keysFunc, symbolsFunc) {
		var result = keysFunc(object);
		return isArray(object) ? result : arrayPush(result, symbolsFunc(object));
	}
	/**
	* The base implementation of `getTag`.
	*
	* @private
	* @param {*} value The value to query.
	* @returns {string} Returns the `toStringTag`.
	*/
	function baseGetTag(value) {
		return objectToString.call(value);
	}
	/**
	* The base implementation of `_.isNative` without bad shim checks.
	*
	* @private
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a native function,
	*  else `false`.
	*/
	function baseIsNative(value) {
		if (!isObject(value) || isMasked(value)) return false;
		return (isFunction(value) || isHostObject(value) ? reIsNative : reIsHostCtor).test(toSource(value));
	}
	/**
	* The base implementation of `_.keys` which doesn't treat sparse arrays as dense.
	*
	* @private
	* @param {Object} object The object to query.
	* @returns {Array} Returns the array of property names.
	*/
	function baseKeys(object) {
		if (!isPrototype(object)) return nativeKeys(object);
		var result = [];
		for (var key in Object(object)) if (hasOwnProperty.call(object, key) && key != "constructor") result.push(key);
		return result;
	}
	/**
	* Creates a clone of  `buffer`.
	*
	* @private
	* @param {Buffer} buffer The buffer to clone.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Buffer} Returns the cloned buffer.
	*/
	function cloneBuffer(buffer, isDeep) {
		if (isDeep) return buffer.slice();
		var result = new buffer.constructor(buffer.length);
		buffer.copy(result);
		return result;
	}
	/**
	* Creates a clone of `arrayBuffer`.
	*
	* @private
	* @param {ArrayBuffer} arrayBuffer The array buffer to clone.
	* @returns {ArrayBuffer} Returns the cloned array buffer.
	*/
	function cloneArrayBuffer(arrayBuffer) {
		var result = new arrayBuffer.constructor(arrayBuffer.byteLength);
		new Uint8Array(result).set(new Uint8Array(arrayBuffer));
		return result;
	}
	/**
	* Creates a clone of `dataView`.
	*
	* @private
	* @param {Object} dataView The data view to clone.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Object} Returns the cloned data view.
	*/
	function cloneDataView(dataView, isDeep) {
		var buffer = isDeep ? cloneArrayBuffer(dataView.buffer) : dataView.buffer;
		return new dataView.constructor(buffer, dataView.byteOffset, dataView.byteLength);
	}
	/**
	* Creates a clone of `map`.
	*
	* @private
	* @param {Object} map The map to clone.
	* @param {Function} cloneFunc The function to clone values.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Object} Returns the cloned map.
	*/
	function cloneMap(map, isDeep, cloneFunc) {
		return arrayReduce(isDeep ? cloneFunc(mapToArray(map), true) : mapToArray(map), addMapEntry, new map.constructor());
	}
	/**
	* Creates a clone of `regexp`.
	*
	* @private
	* @param {Object} regexp The regexp to clone.
	* @returns {Object} Returns the cloned regexp.
	*/
	function cloneRegExp(regexp) {
		var result = new regexp.constructor(regexp.source, reFlags.exec(regexp));
		result.lastIndex = regexp.lastIndex;
		return result;
	}
	/**
	* Creates a clone of `set`.
	*
	* @private
	* @param {Object} set The set to clone.
	* @param {Function} cloneFunc The function to clone values.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Object} Returns the cloned set.
	*/
	function cloneSet(set, isDeep, cloneFunc) {
		return arrayReduce(isDeep ? cloneFunc(setToArray(set), true) : setToArray(set), addSetEntry, new set.constructor());
	}
	/**
	* Creates a clone of the `symbol` object.
	*
	* @private
	* @param {Object} symbol The symbol object to clone.
	* @returns {Object} Returns the cloned symbol object.
	*/
	function cloneSymbol(symbol) {
		return symbolValueOf ? Object(symbolValueOf.call(symbol)) : {};
	}
	/**
	* Creates a clone of `typedArray`.
	*
	* @private
	* @param {Object} typedArray The typed array to clone.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Object} Returns the cloned typed array.
	*/
	function cloneTypedArray(typedArray, isDeep) {
		var buffer = isDeep ? cloneArrayBuffer(typedArray.buffer) : typedArray.buffer;
		return new typedArray.constructor(buffer, typedArray.byteOffset, typedArray.length);
	}
	/**
	* Copies the values of `source` to `array`.
	*
	* @private
	* @param {Array} source The array to copy values from.
	* @param {Array} [array=[]] The array to copy values to.
	* @returns {Array} Returns `array`.
	*/
	function copyArray(source, array) {
		var index = -1, length = source.length;
		array || (array = Array(length));
		while (++index < length) array[index] = source[index];
		return array;
	}
	/**
	* Copies properties of `source` to `object`.
	*
	* @private
	* @param {Object} source The object to copy properties from.
	* @param {Array} props The property identifiers to copy.
	* @param {Object} [object={}] The object to copy properties to.
	* @param {Function} [customizer] The function to customize copied values.
	* @returns {Object} Returns `object`.
	*/
	function copyObject(source, props, object, customizer) {
		object || (object = {});
		var index = -1, length = props.length;
		while (++index < length) {
			var key = props[index];
			var newValue = customizer ? customizer(object[key], source[key], key, object, source) : void 0;
			assignValue(object, key, newValue === void 0 ? source[key] : newValue);
		}
		return object;
	}
	/**
	* Copies own symbol properties of `source` to `object`.
	*
	* @private
	* @param {Object} source The object to copy symbols from.
	* @param {Object} [object={}] The object to copy symbols to.
	* @returns {Object} Returns `object`.
	*/
	function copySymbols(source, object) {
		return copyObject(source, getSymbols(source), object);
	}
	/**
	* Creates an array of own enumerable property names and symbols of `object`.
	*
	* @private
	* @param {Object} object The object to query.
	* @returns {Array} Returns the array of property names and symbols.
	*/
	function getAllKeys(object) {
		return baseGetAllKeys(object, keys, getSymbols);
	}
	/**
	* Gets the data for `map`.
	*
	* @private
	* @param {Object} map The map to query.
	* @param {string} key The reference key.
	* @returns {*} Returns the map data.
	*/
	function getMapData(map, key) {
		var data = map.__data__;
		return isKeyable(key) ? data[typeof key == "string" ? "string" : "hash"] : data.map;
	}
	/**
	* Gets the native function at `key` of `object`.
	*
	* @private
	* @param {Object} object The object to query.
	* @param {string} key The key of the method to get.
	* @returns {*} Returns the function if it's native, else `undefined`.
	*/
	function getNative(object, key) {
		var value = getValue(object, key);
		return baseIsNative(value) ? value : void 0;
	}
	/**
	* Creates an array of the own enumerable symbol properties of `object`.
	*
	* @private
	* @param {Object} object The object to query.
	* @returns {Array} Returns the array of symbols.
	*/
	var getSymbols = nativeGetSymbols ? overArg(nativeGetSymbols, Object) : stubArray;
	/**
	* Gets the `toStringTag` of `value`.
	*
	* @private
	* @param {*} value The value to query.
	* @returns {string} Returns the `toStringTag`.
	*/
	var getTag = baseGetTag;
	if (DataView && getTag(new DataView(/* @__PURE__ */ new ArrayBuffer(1))) != dataViewTag || Map && getTag(new Map()) != mapTag || Promise && getTag(Promise.resolve()) != promiseTag || Set && getTag(new Set()) != setTag || WeakMap && getTag(new WeakMap()) != weakMapTag) getTag = function(value) {
		var result = objectToString.call(value), Ctor = result == objectTag ? value.constructor : void 0, ctorString = Ctor ? toSource(Ctor) : void 0;
		if (ctorString) switch (ctorString) {
			case dataViewCtorString: return dataViewTag;
			case mapCtorString: return mapTag;
			case promiseCtorString: return promiseTag;
			case setCtorString: return setTag;
			case weakMapCtorString: return weakMapTag;
		}
		return result;
	};
	/**
	* Initializes an array clone.
	*
	* @private
	* @param {Array} array The array to clone.
	* @returns {Array} Returns the initialized clone.
	*/
	function initCloneArray(array) {
		var length = array.length, result = array.constructor(length);
		if (length && typeof array[0] == "string" && hasOwnProperty.call(array, "index")) {
			result.index = array.index;
			result.input = array.input;
		}
		return result;
	}
	/**
	* Initializes an object clone.
	*
	* @private
	* @param {Object} object The object to clone.
	* @returns {Object} Returns the initialized clone.
	*/
	function initCloneObject(object) {
		return typeof object.constructor == "function" && !isPrototype(object) ? baseCreate(getPrototype(object)) : {};
	}
	/**
	* Initializes an object clone based on its `toStringTag`.
	*
	* **Note:** This function only supports cloning values with tags of
	* `Boolean`, `Date`, `Error`, `Number`, `RegExp`, or `String`.
	*
	* @private
	* @param {Object} object The object to clone.
	* @param {string} tag The `toStringTag` of the object to clone.
	* @param {Function} cloneFunc The function to clone values.
	* @param {boolean} [isDeep] Specify a deep clone.
	* @returns {Object} Returns the initialized clone.
	*/
	function initCloneByTag(object, tag, cloneFunc, isDeep) {
		var Ctor = object.constructor;
		switch (tag) {
			case arrayBufferTag: return cloneArrayBuffer(object);
			case boolTag:
			case dateTag: return new Ctor(+object);
			case dataViewTag: return cloneDataView(object, isDeep);
			case float32Tag:
			case float64Tag:
			case int8Tag:
			case int16Tag:
			case int32Tag:
			case uint8Tag:
			case uint8ClampedTag:
			case uint16Tag:
			case uint32Tag: return cloneTypedArray(object, isDeep);
			case mapTag: return cloneMap(object, isDeep, cloneFunc);
			case numberTag:
			case stringTag: return new Ctor(object);
			case regexpTag: return cloneRegExp(object);
			case setTag: return cloneSet(object, isDeep, cloneFunc);
			case symbolTag: return cloneSymbol(object);
		}
	}
	/**
	* Checks if `value` is a valid array-like index.
	*
	* @private
	* @param {*} value The value to check.
	* @param {number} [length=MAX_SAFE_INTEGER] The upper bounds of a valid index.
	* @returns {boolean} Returns `true` if `value` is a valid index, else `false`.
	*/
	function isIndex(value, length) {
		length = length == null ? MAX_SAFE_INTEGER : length;
		return !!length && (typeof value == "number" || reIsUint.test(value)) && value > -1 && value % 1 == 0 && value < length;
	}
	/**
	* Checks if `value` is suitable for use as unique object key.
	*
	* @private
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is suitable, else `false`.
	*/
	function isKeyable(value) {
		var type = typeof value;
		return type == "string" || type == "number" || type == "symbol" || type == "boolean" ? value !== "__proto__" : value === null;
	}
	/**
	* Checks if `func` has its source masked.
	*
	* @private
	* @param {Function} func The function to check.
	* @returns {boolean} Returns `true` if `func` is masked, else `false`.
	*/
	function isMasked(func) {
		return !!maskSrcKey && maskSrcKey in func;
	}
	/**
	* Checks if `value` is likely a prototype object.
	*
	* @private
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a prototype, else `false`.
	*/
	function isPrototype(value) {
		var Ctor = value && value.constructor;
		return value === (typeof Ctor == "function" && Ctor.prototype || objectProto);
	}
	/**
	* Converts `func` to its source code.
	*
	* @private
	* @param {Function} func The function to process.
	* @returns {string} Returns the source code.
	*/
	function toSource(func) {
		if (func != null) {
			try {
				return funcToString.call(func);
			} catch (e) {}
			try {
				return func + "";
			} catch (e) {}
		}
		return "";
	}
	/**
	* This method is like `_.clone` except that it recursively clones `value`.
	*
	* @static
	* @memberOf _
	* @since 1.0.0
	* @category Lang
	* @param {*} value The value to recursively clone.
	* @returns {*} Returns the deep cloned value.
	* @see _.clone
	* @example
	*
	* var objects = [{ 'a': 1 }, { 'b': 2 }];
	*
	* var deep = _.cloneDeep(objects);
	* console.log(deep[0] === objects[0]);
	* // => false
	*/
	function cloneDeep(value) {
		return baseClone(value, true, true);
	}
	/**
	* Performs a
	* [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
	* comparison between two values to determine if they are equivalent.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to compare.
	* @param {*} other The other value to compare.
	* @returns {boolean} Returns `true` if the values are equivalent, else `false`.
	* @example
	*
	* var object = { 'a': 1 };
	* var other = { 'a': 1 };
	*
	* _.eq(object, object);
	* // => true
	*
	* _.eq(object, other);
	* // => false
	*
	* _.eq('a', 'a');
	* // => true
	*
	* _.eq('a', Object('a'));
	* // => false
	*
	* _.eq(NaN, NaN);
	* // => true
	*/
	function eq(value, other) {
		return value === other || value !== value && other !== other;
	}
	/**
	* Checks if `value` is likely an `arguments` object.
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is an `arguments` object,
	*  else `false`.
	* @example
	*
	* _.isArguments(function() { return arguments; }());
	* // => true
	*
	* _.isArguments([1, 2, 3]);
	* // => false
	*/
	function isArguments(value) {
		return isArrayLikeObject(value) && hasOwnProperty.call(value, "callee") && (!propertyIsEnumerable.call(value, "callee") || objectToString.call(value) == argsTag);
	}
	/**
	* Checks if `value` is classified as an `Array` object.
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is an array, else `false`.
	* @example
	*
	* _.isArray([1, 2, 3]);
	* // => true
	*
	* _.isArray(document.body.children);
	* // => false
	*
	* _.isArray('abc');
	* // => false
	*
	* _.isArray(_.noop);
	* // => false
	*/
	var isArray = Array.isArray;
	/**
	* Checks if `value` is array-like. A value is considered array-like if it's
	* not a function and has a `value.length` that's an integer greater than or
	* equal to `0` and less than or equal to `Number.MAX_SAFE_INTEGER`.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is array-like, else `false`.
	* @example
	*
	* _.isArrayLike([1, 2, 3]);
	* // => true
	*
	* _.isArrayLike(document.body.children);
	* // => true
	*
	* _.isArrayLike('abc');
	* // => true
	*
	* _.isArrayLike(_.noop);
	* // => false
	*/
	function isArrayLike(value) {
		return value != null && isLength(value.length) && !isFunction(value);
	}
	/**
	* This method is like `_.isArrayLike` except that it also checks if `value`
	* is an object.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is an array-like object,
	*  else `false`.
	* @example
	*
	* _.isArrayLikeObject([1, 2, 3]);
	* // => true
	*
	* _.isArrayLikeObject(document.body.children);
	* // => true
	*
	* _.isArrayLikeObject('abc');
	* // => false
	*
	* _.isArrayLikeObject(_.noop);
	* // => false
	*/
	function isArrayLikeObject(value) {
		return isObjectLike(value) && isArrayLike(value);
	}
	/**
	* Checks if `value` is a buffer.
	*
	* @static
	* @memberOf _
	* @since 4.3.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a buffer, else `false`.
	* @example
	*
	* _.isBuffer(new Buffer(2));
	* // => true
	*
	* _.isBuffer(new Uint8Array(2));
	* // => false
	*/
	var isBuffer = nativeIsBuffer || stubFalse;
	/**
	* Checks if `value` is classified as a `Function` object.
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a function, else `false`.
	* @example
	*
	* _.isFunction(_);
	* // => true
	*
	* _.isFunction(/abc/);
	* // => false
	*/
	function isFunction(value) {
		var tag = isObject(value) ? objectToString.call(value) : "";
		return tag == funcTag || tag == genTag;
	}
	/**
	* Checks if `value` is a valid array-like length.
	*
	* **Note:** This method is loosely based on
	* [`ToLength`](http://ecma-international.org/ecma-262/7.0/#sec-tolength).
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a valid length, else `false`.
	* @example
	*
	* _.isLength(3);
	* // => true
	*
	* _.isLength(Number.MIN_VALUE);
	* // => false
	*
	* _.isLength(Infinity);
	* // => false
	*
	* _.isLength('3');
	* // => false
	*/
	function isLength(value) {
		return typeof value == "number" && value > -1 && value % 1 == 0 && value <= MAX_SAFE_INTEGER;
	}
	/**
	* Checks if `value` is the
	* [language type](http://www.ecma-international.org/ecma-262/7.0/#sec-ecmascript-language-types)
	* of `Object`. (e.g. arrays, functions, objects, regexes, `new Number(0)`, and `new String('')`)
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is an object, else `false`.
	* @example
	*
	* _.isObject({});
	* // => true
	*
	* _.isObject([1, 2, 3]);
	* // => true
	*
	* _.isObject(_.noop);
	* // => true
	*
	* _.isObject(null);
	* // => false
	*/
	function isObject(value) {
		var type = typeof value;
		return !!value && (type == "object" || type == "function");
	}
	/**
	* Checks if `value` is object-like. A value is object-like if it's not `null`
	* and has a `typeof` result of "object".
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is object-like, else `false`.
	* @example
	*
	* _.isObjectLike({});
	* // => true
	*
	* _.isObjectLike([1, 2, 3]);
	* // => true
	*
	* _.isObjectLike(_.noop);
	* // => false
	*
	* _.isObjectLike(null);
	* // => false
	*/
	function isObjectLike(value) {
		return !!value && typeof value == "object";
	}
	/**
	* Creates an array of the own enumerable property names of `object`.
	*
	* **Note:** Non-object values are coerced to objects. See the
	* [ES spec](http://ecma-international.org/ecma-262/7.0/#sec-object.keys)
	* for more details.
	*
	* @static
	* @since 0.1.0
	* @memberOf _
	* @category Object
	* @param {Object} object The object to query.
	* @returns {Array} Returns the array of property names.
	* @example
	*
	* function Foo() {
	*   this.a = 1;
	*   this.b = 2;
	* }
	*
	* Foo.prototype.c = 3;
	*
	* _.keys(new Foo);
	* // => ['a', 'b'] (iteration order is not guaranteed)
	*
	* _.keys('hi');
	* // => ['0', '1']
	*/
	function keys(object) {
		return isArrayLike(object) ? arrayLikeKeys(object) : baseKeys(object);
	}
	/**
	* This method returns a new empty array.
	*
	* @static
	* @memberOf _
	* @since 4.13.0
	* @category Util
	* @returns {Array} Returns the new empty array.
	* @example
	*
	* var arrays = _.times(2, _.stubArray);
	*
	* console.log(arrays);
	* // => [[], []]
	*
	* console.log(arrays[0] === arrays[1]);
	* // => false
	*/
	function stubArray() {
		return [];
	}
	/**
	* This method returns `false`.
	*
	* @static
	* @memberOf _
	* @since 4.13.0
	* @category Util
	* @returns {boolean} Returns `false`.
	* @example
	*
	* _.times(2, _.stubFalse);
	* // => [false, false]
	*/
	function stubFalse() {
		return false;
	}
	module.exports = cloneDeep;
}));
//#endregion
//#region node_modules/lru-memoizer/lib/freeze.js
var require_freeze = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.deepFreeze = void 0;
	function deepFreeze(o) {
		if (o) {
			Object.freeze(o);
			Object.getOwnPropertyNames(o).forEach(function(prop) {
				if (o.hasOwnProperty(prop) && o[prop] !== null && (typeof o[prop] === "object" || typeof o[prop] === "function") && o[prop].constructor !== Buffer && !Object.isFrozen(o[prop])) deepFreeze(o[prop]);
			});
		}
		return o;
	}
	exports.deepFreeze = deepFreeze;
}));
//#endregion
//#region node_modules/lru-memoizer/lib/sync.js
var require_sync = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __read = exports && exports.__read || function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	var __spread = exports && exports.__spread || function() {
		for (var ar = [], i = 0; i < arguments.length; i++) ar = ar.concat(__read(arguments[i]));
		return ar;
	};
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.syncMemoizer = void 0;
	var lru_cache_1 = __importDefault(require_lru_cache());
	var events_1$1 = __require("events");
	var lodash_clonedeep_1 = __importDefault(require_lodash_clonedeep());
	var freeze_1 = require_freeze();
	function syncMemoizer(options) {
		var cache = new lru_cache_1.default(options);
		var load = options.load;
		var hash = options.hash;
		var bypass = options.bypass;
		var itemMaxAge = options.itemMaxAge;
		var freeze = options.freeze;
		var clone = options.clone;
		var emitter = new events_1$1.EventEmitter();
		var defaultResult = Object.assign({
			del,
			reset: function() {
				return cache.reset();
			},
			keys: cache.keys.bind(cache),
			on: emitter.on.bind(emitter),
			once: emitter.once.bind(emitter)
		}, options);
		if (options.disable) return Object.assign(load, defaultResult);
		function del() {
			var key = hash.apply(void 0, __spread(arguments));
			cache.del(key);
		}
		function emit(event) {
			var parameters = [];
			for (var _i = 1; _i < arguments.length; _i++) parameters[_i - 1] = arguments[_i];
			emitter.emit.apply(emitter, __spread([event], parameters));
		}
		function isPromise(result) {
			return result && result.then && typeof result.then === "function";
		}
		function processResult(result) {
			var res = result;
			if (clone) if (isPromise(res)) res = res.then(lodash_clonedeep_1.default);
			else res = lodash_clonedeep_1.default(res);
			if (freeze) if (isPromise(res)) res = res.then(freeze_1.deepFreeze);
			else freeze_1.deepFreeze(res);
			return res;
		}
		var result = function() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			if (bypass && bypass.apply(void 0, __spread(args))) {
				emit.apply(void 0, __spread(["miss"], args));
				return load.apply(void 0, __spread(args));
			}
			var key = hash.apply(void 0, __spread(args));
			var fromCache = cache.get(key);
			if (fromCache) {
				emit.apply(void 0, __spread(["hit"], args));
				return processResult(fromCache);
			}
			emit.apply(void 0, __spread(["miss"], args));
			var result = load.apply(void 0, __spread(args));
			if (itemMaxAge) cache.set(key, result, itemMaxAge.apply(void 0, __spread(args.concat([result]))));
			else cache.set(key, result);
			return processResult(result);
		};
		return Object.assign(result, defaultResult);
	}
	exports.syncMemoizer = syncMemoizer;
}));
//#endregion
//#region node_modules/lru-memoizer/lib/async.js
var require_async = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __read = exports && exports.__read || function(o, n) {
		var m = typeof Symbol === "function" && o[Symbol.iterator];
		if (!m) return o;
		var i = m.call(o), r, ar = [], e;
		try {
			while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
		} catch (error) {
			e = { error };
		} finally {
			try {
				if (r && !r.done && (m = i["return"])) m.call(i);
			} finally {
				if (e) throw e.error;
			}
		}
		return ar;
	};
	var __spread = exports && exports.__spread || function() {
		for (var ar = [], i = 0; i < arguments.length; i++) ar = ar.concat(__read(arguments[i]));
		return ar;
	};
	var __values = exports && exports.__values || function(o) {
		var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
		if (m) return m.call(o);
		if (o && typeof o.length === "number") return { next: function() {
			if (o && i >= o.length) o = void 0;
			return {
				value: o && o[i++],
				done: !o
			};
		} };
		throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
	};
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.asyncMemoizer = void 0;
	var lru_cache_1 = __importDefault(require_lru_cache());
	var events_1 = __require("events");
	var lodash_clonedeep_1 = __importDefault(require_lodash_clonedeep());
	var freeze_1 = require_freeze();
	var sync_1 = require_sync();
	function asyncMemoizer(options) {
		var cache = new lru_cache_1.default(options);
		var load = options.load;
		var hash = options.hash;
		var bypass = options.bypass;
		var itemMaxAge = options.itemMaxAge;
		var freeze = options.freeze;
		var clone = options.clone;
		var queueMaxAge = options.queueMaxAge || 1e3;
		var loading = /* @__PURE__ */ new Map();
		var emitter = new events_1.EventEmitter();
		var memoizerMethods = Object.assign({
			del,
			reset: function() {
				return cache.reset();
			},
			keys: cache.keys.bind(cache),
			on: emitter.on.bind(emitter),
			once: emitter.once.bind(emitter)
		}, options);
		if (options.disable) return Object.assign(load, memoizerMethods);
		function del() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			var key = hash.apply(void 0, __spread(args));
			cache.del(key);
		}
		function add(key, parameters, result) {
			if (freeze) result.forEach(freeze_1.deepFreeze);
			if (itemMaxAge) cache.set(key, result, itemMaxAge.apply(void 0, __spread(parameters.concat(result))));
			else cache.set(key, result);
		}
		function runCallbacks(callbacks, args) {
			var e_1, _a;
			try {
				for (var callbacks_1 = __values(callbacks), callbacks_1_1 = callbacks_1.next(); !callbacks_1_1.done; callbacks_1_1 = callbacks_1.next()) {
					var callback = callbacks_1_1.value;
					if (clone) setImmediate.apply(void 0, __spread([callback], args.map(lodash_clonedeep_1.default)));
					else setImmediate.apply(void 0, __spread([callback], args));
				}
			} catch (e_1_1) {
				e_1 = { error: e_1_1 };
			} finally {
				try {
					if (callbacks_1_1 && !callbacks_1_1.done && (_a = callbacks_1.return)) _a.call(callbacks_1);
				} finally {
					if (e_1) throw e_1.error;
				}
			}
		}
		function emit(event) {
			var parameters = [];
			for (var _i = 1; _i < arguments.length; _i++) parameters[_i - 1] = arguments[_i];
			emitter.emit.apply(emitter, __spread([event], parameters));
		}
		function memoizedFunction() {
			var args = [];
			for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
			var parameters = args.slice(0, -1);
			var callback = args.slice(-1).pop();
			var key;
			if (bypass && bypass.apply(void 0, __spread(parameters))) {
				emit.apply(void 0, __spread(["miss"], parameters));
				return load.apply(void 0, __spread(args));
			}
			if (parameters.length === 0 && !hash) key = "_";
			else key = hash.apply(void 0, __spread(parameters));
			var fromCache = cache.get(key);
			if (fromCache) {
				emit.apply(void 0, __spread(["hit"], parameters));
				return runCallbacks([callback], [null].concat(fromCache));
			}
			var pendingLoad = loading.get(key);
			if (pendingLoad && pendingLoad.expiresAt > Date.now()) {
				pendingLoad.queue.push(callback);
				emit.apply(void 0, __spread(["queue"], parameters));
				return;
			}
			emit.apply(void 0, __spread(["miss"], parameters));
			var started = Date.now();
			var queue = [callback];
			loading.set(key, {
				queue,
				expiresAt: started + queueMaxAge
			});
			var loadHandler = function() {
				var args = [];
				for (var _i = 0; _i < arguments.length; _i++) args[_i] = arguments[_i];
				if (!args[0]) add(key, parameters, args.slice(1));
				loading.delete(key);
				emit.apply(void 0, __spread(["loaded", Date.now() - started], parameters));
				runCallbacks(queue, args);
			};
			load.apply(void 0, __spread(parameters, [loadHandler]));
		}
		return Object.assign(memoizedFunction, memoizerMethods);
	}
	exports.asyncMemoizer = asyncMemoizer;
	asyncMemoizer.sync = sync_1.syncMemoizer;
}));
//#endregion
//#region node_modules/lru-memoizer/lib/index.js
var require_lib = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_async().asyncMemoizer;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/cache.js
var require_cache = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const logger = require_src$1()("jwks");
	const memoizer = require_lib();
	const { promisify, callbackify: callbackify$1 } = __require("util");
	function cacheWrapper(client, { cacheMaxEntries = 5, cacheMaxAge = 6e5 }) {
		logger(`Configured caching of signing keys. Max: ${cacheMaxEntries} / Age: ${cacheMaxAge}`);
		return promisify(memoizer({
			hash: (kid) => kid,
			load: callbackify$1(client.getSigningKey.bind(client)),
			maxAge: cacheMaxAge,
			max: cacheMaxEntries
		}));
	}
	module.exports.default = cacheWrapper;
}));
//#endregion
//#region node_modules/limiter/lib/tokenBucket.js
var require_tokenBucket = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* A hierarchical token bucket for rate limiting. See
	* http://en.wikipedia.org/wiki/Token_bucket for more information.
	* @author John Hurliman <jhurliman@cull.tv>
	*
	* @param {Number} bucketSize Maximum number of tokens to hold in the bucket.
	*  Also known as the burst rate.
	* @param {Number} tokensPerInterval Number of tokens to drip into the bucket
	*  over the course of one interval.
	* @param {String|Number} interval The interval length in milliseconds, or as
	*  one of the following strings: 'second', 'minute', 'hour', day'.
	* @param {TokenBucket} parentBucket Optional. A token bucket that will act as
	*  the parent of this bucket.
	*/
	var TokenBucket = function(bucketSize, tokensPerInterval, interval, parentBucket) {
		this.bucketSize = bucketSize;
		this.tokensPerInterval = tokensPerInterval;
		if (typeof interval === "string") switch (interval) {
			case "sec":
			case "second":
				this.interval = 1e3;
				break;
			case "min":
			case "minute":
				this.interval = 1e3 * 60;
				break;
			case "hr":
			case "hour":
				this.interval = 1e3 * 60 * 60;
				break;
			case "day":
				this.interval = 1e3 * 60 * 60 * 24;
				break;
			default: throw new Error("Invaid interval " + interval);
		}
		else this.interval = interval;
		this.parentBucket = parentBucket;
		this.content = 0;
		this.lastDrip = +/* @__PURE__ */ new Date();
	};
	TokenBucket.prototype = {
		bucketSize: 1,
		tokensPerInterval: 1,
		interval: 1e3,
		parentBucket: null,
		content: 0,
		lastDrip: 0,
		/**
		* Remove the requested number of tokens and fire the given callback. If the
		* bucket (and any parent buckets) contains enough tokens this will happen
		* immediately. Otherwise, the removal and callback will happen when enough
		* tokens become available.
		* @param {Number} count The number of tokens to remove.
		* @param {Function} callback(err, remainingTokens)
		* @returns {Boolean} True if the callback was fired immediately, otherwise
		*  false.
		*/
		removeTokens: function(count, callback) {
			var self = this;
			if (!this.bucketSize) {
				process.nextTick(callback.bind(null, null, count, Number.POSITIVE_INFINITY));
				return true;
			}
			if (count > this.bucketSize) {
				process.nextTick(callback.bind(null, "Requested tokens " + count + " exceeds bucket size " + this.bucketSize, null));
				return false;
			}
			this.drip();
			if (count > this.content) return comeBackLater();
			if (this.parentBucket) return this.parentBucket.removeTokens(count, function(err, remainingTokens) {
				if (err) return callback(err, null);
				if (count > self.content) return comeBackLater();
				self.content -= count;
				callback(null, Math.min(remainingTokens, self.content));
			});
			else {
				this.content -= count;
				process.nextTick(callback.bind(null, null, this.content));
				return true;
			}
			function comeBackLater() {
				var waitInterval = Math.ceil((count - self.content) * (self.interval / self.tokensPerInterval));
				setTimeout(function() {
					self.removeTokens(count, callback);
				}, waitInterval);
				return false;
			}
		},
		/**
		* Attempt to remove the requested number of tokens and return immediately.
		* If the bucket (and any parent buckets) contains enough tokens this will
		* return true, otherwise false is returned.
		* @param {Number} count The number of tokens to remove.
		* @param {Boolean} True if the tokens were successfully removed, otherwise
		*  false.
		*/
		tryRemoveTokens: function(count) {
			if (!this.bucketSize) return true;
			if (count > this.bucketSize) return false;
			this.drip();
			if (count > this.content) return false;
			if (this.parentBucket && !this.parentBucket.tryRemoveTokens(count)) return false;
			this.content -= count;
			return true;
		},
		/**
		* Add any new tokens to the bucket since the last drip.
		* @returns {Boolean} True if new tokens were added, otherwise false.
		*/
		drip: function() {
			if (!this.tokensPerInterval) {
				this.content = this.bucketSize;
				return;
			}
			var now = +/* @__PURE__ */ new Date();
			var deltaMS = Math.max(now - this.lastDrip, 0);
			this.lastDrip = now;
			var dripAmount = deltaMS * (this.tokensPerInterval / this.interval);
			this.content = Math.min(this.content + dripAmount, this.bucketSize);
		}
	};
	module.exports = TokenBucket;
}));
//#endregion
//#region node_modules/limiter/lib/clock.js
var require_clock = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var getMilliseconds = function() {
		if (typeof process !== "undefined" && process.hrtime) {
			var hrtime = process.hrtime();
			var seconds = hrtime[0];
			var nanoseconds = hrtime[1];
			return seconds * 1e3 + Math.floor(nanoseconds / 1e6);
		}
		return (/* @__PURE__ */ new Date()).getTime();
	};
	module.exports = getMilliseconds;
}));
//#endregion
//#region node_modules/limiter/lib/rateLimiter.js
var require_rateLimiter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var TokenBucket = require_tokenBucket();
	var getMilliseconds = require_clock();
	/**
	* A generic rate limiter. Underneath the hood, this uses a token bucket plus
	* an additional check to limit how many tokens we can remove each interval.
	* @author John Hurliman <jhurliman@jhurliman.org>
	*
	* @param {Number} tokensPerInterval Maximum number of tokens that can be
	*  removed at any given moment and over the course of one interval.
	* @param {String|Number} interval The interval length in milliseconds, or as
	*  one of the following strings: 'second', 'minute', 'hour', day'.
	* @param {Boolean} fireImmediately Optional. Whether or not the callback
	*  will fire immediately when rate limiting is in effect (default is false).
	*/
	var RateLimiter = function(tokensPerInterval, interval, fireImmediately) {
		this.tokenBucket = new TokenBucket(tokensPerInterval, tokensPerInterval, interval, null);
		this.tokenBucket.content = tokensPerInterval;
		this.curIntervalStart = getMilliseconds();
		this.tokensThisInterval = 0;
		this.fireImmediately = fireImmediately;
	};
	RateLimiter.prototype = {
		tokenBucket: null,
		curIntervalStart: 0,
		tokensThisInterval: 0,
		fireImmediately: false,
		/**
		* Remove the requested number of tokens and fire the given callback. If the
		* rate limiter contains enough tokens and we haven't spent too many tokens
		* in this interval already, this will happen immediately. Otherwise, the
		* removal and callback will happen when enough tokens become available.
		* @param {Number} count The number of tokens to remove.
		* @param {Function} callback(err, remainingTokens)
		* @returns {Boolean} True if the callback was fired immediately, otherwise
		*  false.
		*/
		removeTokens: function(count, callback) {
			if (count > this.tokenBucket.bucketSize) {
				process.nextTick(callback.bind(null, "Requested tokens " + count + " exceeds maximum tokens per interval " + this.tokenBucket.bucketSize, null));
				return false;
			}
			var self = this;
			var now = getMilliseconds();
			if (now < this.curIntervalStart || now - this.curIntervalStart >= this.tokenBucket.interval) {
				this.curIntervalStart = now;
				this.tokensThisInterval = 0;
			}
			if (count > this.tokenBucket.tokensPerInterval - this.tokensThisInterval) {
				if (this.fireImmediately) process.nextTick(callback.bind(null, null, -1));
				else {
					var waitInterval = Math.ceil(this.curIntervalStart + this.tokenBucket.interval - now);
					setTimeout(function() {
						self.tokenBucket.removeTokens(count, afterTokensRemoved);
					}, waitInterval);
				}
				return false;
			}
			return this.tokenBucket.removeTokens(count, afterTokensRemoved);
			function afterTokensRemoved(err, tokensRemaining) {
				if (err) return callback(err, null);
				self.tokensThisInterval += count;
				callback(null, tokensRemaining);
			}
		},
		/**
		* Attempt to remove the requested number of tokens and return immediately.
		* If the bucket (and any parent buckets) contains enough tokens and we
		* haven't spent too many tokens in this interval already, this will return
		* true. Otherwise, false is returned.
		* @param {Number} count The number of tokens to remove.
		* @param {Boolean} True if the tokens were successfully removed, otherwise
		*  false.
		*/
		tryRemoveTokens: function(count) {
			if (count > this.tokenBucket.bucketSize) return false;
			var now = getMilliseconds();
			if (now < this.curIntervalStart || now - this.curIntervalStart >= this.tokenBucket.interval) {
				this.curIntervalStart = now;
				this.tokensThisInterval = 0;
			}
			if (count > this.tokenBucket.tokensPerInterval - this.tokensThisInterval) return false;
			var removed = this.tokenBucket.tryRemoveTokens(count);
			if (removed) this.tokensThisInterval += count;
			return removed;
		},
		/**
		* Returns the number of tokens remaining in the TokenBucket.
		* @returns {Number} The number of tokens remaining.
		*/
		getTokensRemaining: function() {
			this.tokenBucket.drip();
			return this.tokenBucket.content;
		}
	};
	module.exports = RateLimiter;
}));
//#endregion
//#region node_modules/limiter/index.js
var require_limiter = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.RateLimiter = require_rateLimiter();
	exports.TokenBucket = require_tokenBucket();
}));
//#endregion
//#region node_modules/jwks-rsa/src/errors/JwksRateLimitError.js
var require_JwksRateLimitError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function JwksRateLimitError(message) {
		Error.call(this, message);
		Error.captureStackTrace(this, this.constructor);
		this.name = "JwksRateLimitError";
		this.message = message;
	}
	JwksRateLimitError.prototype = Object.create(Error.prototype);
	JwksRateLimitError.prototype.constructor = JwksRateLimitError;
	module.exports = JwksRateLimitError;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/rateLimit.js
var require_rateLimit = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const logger = require_src$1()("jwks");
	const { RateLimiter } = require_limiter();
	const JwksRateLimitError = require_JwksRateLimitError();
	function rateLimitWrapper(client, { jwksRequestsPerMinute = 10 }) {
		const getSigningKey = client.getSigningKey.bind(client);
		const limiter = new RateLimiter(jwksRequestsPerMinute, "minute", true);
		logger(`Configured rate limiting to JWKS endpoint at ${jwksRequestsPerMinute}/minute`);
		return async (kid) => await new Promise((resolve, reject) => {
			limiter.removeTokens(1, async (err, remaining) => {
				if (err) reject(err);
				logger("Requests to the JWKS endpoint available for the next minute:", remaining);
				if (remaining < 0) {
					logger("Too many requests to the JWKS endpoint");
					reject(new JwksRateLimitError("Too many requests to the JWKS endpoint"));
				} else try {
					resolve(await getSigningKey(kid));
				} catch (error) {
					reject(error);
				}
			});
		});
	}
	module.exports.default = rateLimitWrapper;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/interceptor.js
var require_interceptor = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const retrieveSigningKeys = require_utils().retrieveSigningKeys;
	/**
	* Uses getKeysInterceptor to allow users to retrieve keys from a file,
	* external cache, or provided object before falling back to the jwksUri endpoint
	*/
	function getKeysInterceptor(client, { getKeysInterceptor }) {
		const getSigningKey = client.getSigningKey.bind(client);
		return async (kid) => {
			const keys = await getKeysInterceptor();
			let signingKeys;
			if (keys && keys.length) signingKeys = await retrieveSigningKeys(keys);
			if (signingKeys && signingKeys.length) {
				const key = signingKeys.find((k) => !kid || k.kid === kid);
				if (key) return key;
			}
			return getSigningKey(kid);
		};
	}
	module.exports.default = getKeysInterceptor;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/callbackSupport.js
var require_callbackSupport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { callbackify } = __require("util");
	const callbackSupport = (client) => {
		const getSigningKey = client.getSigningKey.bind(client);
		return (kid, cb) => {
			if (cb) return callbackify(getSigningKey)(kid, cb);
			return getSigningKey(kid);
		};
	};
	module.exports.default = callbackSupport;
}));
//#endregion
//#region node_modules/jwks-rsa/src/wrappers/index.js
var require_wrappers = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		request: require_request().default,
		cacheSigningKey: require_cache().default,
		rateLimitSigningKey: require_rateLimit().default,
		getKeysInterceptor: require_interceptor().default,
		callbackSupport: require_callbackSupport().default
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/errors/SigningKeyNotFoundError.js
var require_SigningKeyNotFoundError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function SigningKeyNotFoundError(message) {
		Error.call(this, message);
		Error.captureStackTrace(this, this.constructor);
		this.name = "SigningKeyNotFoundError";
		this.message = message;
	}
	SigningKeyNotFoundError.prototype = Object.create(Error.prototype);
	SigningKeyNotFoundError.prototype.constructor = SigningKeyNotFoundError;
	module.exports = SigningKeyNotFoundError;
}));
//#endregion
//#region node_modules/jwks-rsa/src/JwksClient.js
var require_JwksClient = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const logger = require_src$1()("jwks");
	const { retrieveSigningKeys } = require_utils();
	const { request, cacheSigningKey, rateLimitSigningKey, getKeysInterceptor, callbackSupport } = require_wrappers();
	const JwksError = require_JwksError();
	const SigningKeyNotFoundError = require_SigningKeyNotFoundError();
	var JwksClient = class {
		constructor(options) {
			this.options = {
				rateLimit: false,
				cache: true,
				timeout: 3e4,
				...options
			};
			if (this.options.getKeysInterceptor) this.getSigningKey = getKeysInterceptor(this, options);
			if (this.options.rateLimit) this.getSigningKey = rateLimitSigningKey(this, options);
			if (this.options.cache) this.getSigningKey = cacheSigningKey(this, options);
			this.getSigningKey = callbackSupport(this, options);
		}
		async getKeys() {
			logger(`Fetching keys from '${this.options.jwksUri}'`);
			try {
				const res = await request({
					uri: this.options.jwksUri,
					headers: this.options.requestHeaders,
					agent: this.options.requestAgent,
					timeout: this.options.timeout,
					fetcher: this.options.fetcher
				});
				logger("Keys:", res.keys);
				return res.keys;
			} catch (err) {
				const { errorMsg } = err;
				logger("Failure:", errorMsg || err);
				throw errorMsg ? new JwksError(errorMsg) : err;
			}
		}
		async getSigningKeys() {
			const keys = await this.getKeys();
			if (!keys || !keys.length) throw new JwksError("The JWKS endpoint did not contain any keys");
			const signingKeys = await retrieveSigningKeys(keys);
			if (!signingKeys.length) throw new JwksError("The JWKS endpoint did not contain any signing keys");
			logger("Signing Keys:", signingKeys);
			return signingKeys;
		}
		async getSigningKey(kid) {
			logger(`Fetching signing key for '${kid}'`);
			const keys = await this.getSigningKeys();
			const kidDefined = kid !== void 0 && kid !== null;
			if (!kidDefined && keys.length > 1) {
				logger("No KID specified and JWKS endpoint returned more than 1 key");
				throw new SigningKeyNotFoundError("No KID specified and JWKS endpoint returned more than 1 key");
			}
			const key = keys.find((k) => !kidDefined || k.kid === kid);
			if (key) return key;
			else {
				logger(`Unable to find a signing key that matches '${kid}'`);
				throw new SigningKeyNotFoundError(`Unable to find a signing key that matches '${kid}'`);
			}
		}
	};
	module.exports = { JwksClient };
}));
//#endregion
//#region node_modules/jwks-rsa/src/errors/index.js
var require_errors = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		ArgumentError: require_ArgumentError(),
		JwksError: require_JwksError(),
		JwksRateLimitError: require_JwksRateLimitError(),
		SigningKeyNotFoundError: require_SigningKeyNotFoundError()
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/integrations/config.js
var require_config = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = [
		"RS256",
		"RS384",
		"RS512",
		"PS256",
		"PS384",
		"PS512",
		"ES256",
		"ES256K",
		"ES384",
		"ES512",
		"EdDSA"
	];
}));
//#endregion
//#region node_modules/jwks-rsa/src/integrations/hapi.js
var require_hapi = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { ArgumentError } = require_errors();
	const { JwksClient } = require_JwksClient();
	const supportedAlg = require_config();
	const handleSigningKeyError = (err, cb) => {
		if (err && err.name === "SigningKeyNotFoundError") return cb(err, null, null);
		if (err) return cb(err, null, null);
	};
	/**
	* Call hapiJwt2Key as a Promise
	* @param {object} options 
	* @returns {Promise}
	*/
	module.exports.hapiJwt2KeyAsync = (options) => {
		const secretProvider = module.exports.hapiJwt2Key(options);
		return function(decoded) {
			return new Promise((resolve, reject) => {
				const cb = (err, key) => {
					!key || err ? reject(err) : resolve({ key });
				};
				secretProvider(decoded, cb);
			});
		};
	};
	module.exports.hapiJwt2Key = function(options) {
		if (options === null || options === void 0) throw new ArgumentError("An options object must be provided when initializing hapiJwt2Key");
		const client = new JwksClient(options);
		const onError = options.handleSigningKeyError || handleSigningKeyError;
		return function secretProvider(decoded, cb) {
			if (!decoded || !decoded.header) return cb(/* @__PURE__ */ new Error("Cannot find a signing certificate if there is no header"), null, null);
			if (!supportedAlg.includes(decoded.header.alg)) return cb(/* @__PURE__ */ new Error("Unsupported algorithm " + decoded.header.alg + " supplied."), null, null);
			client.getSigningKey(decoded.header.kid).then((key) => {
				return cb(null, key.publicKey || key.rsaPublicKey, key);
			}).catch((err) => {
				return onError(err, (newError) => cb(newError, null, null));
			});
		};
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/integrations/express.js
var require_express = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { ArgumentError } = require_errors();
	const { JwksClient } = require_JwksClient();
	const supportedAlg = require_config();
	const handleSigningKeyError = (err, cb) => {
		if (err && err.name === "SigningKeyNotFoundError") return cb(null);
		if (err) return cb(err);
	};
	module.exports.expressJwtSecret = function(options) {
		if (options === null || options === void 0) throw new ArgumentError("An options object must be provided when initializing expressJwtSecret");
		const client = new JwksClient(options);
		const onError = options.handleSigningKeyError || handleSigningKeyError;
		const expressJwt7Provider = async (req, token) => {
			if (!token) return;
			const header = token.header;
			if (!header || !supportedAlg.includes(header.alg)) return;
			try {
				const key = await client.getSigningKey(header.kid);
				return key.publicKey || key.rsaPublicKey;
			} catch (err) {
				return new Promise((resolve, reject) => {
					onError(err, (newError) => {
						if (!newError) return resolve();
						reject(newError);
					});
				});
			}
		};
		return function secretProvider(req, header, payload, cb) {
			if (arguments.length === 4) {
				expressJwt7Provider(req, { header }).then((key) => {
					setImmediate(cb, null, key);
				}).catch((err) => {
					setImmediate(cb, err);
				});
				return;
			}
			return expressJwt7Provider(req, arguments[1]);
		};
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/integrations/koa.js
var require_koa = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { ArgumentError } = require_errors();
	const { JwksClient } = require_JwksClient();
	const supportedAlg = require_config();
	module.exports.koaJwtSecret = function(options = {}) {
		if (!options.jwksUri) throw new ArgumentError("No JWKS provided. Please provide a jwksUri");
		const client = new JwksClient(options);
		return function secretProvider({ alg, kid } = {}) {
			return new Promise((resolve, reject) => {
				if (!supportedAlg.includes(alg)) return reject(/* @__PURE__ */ new Error("Missing / invalid token algorithm"));
				client.getSigningKey(kid).then((key) => {
					resolve(key.publicKey || key.rsaPublicKey);
				}).catch((err) => {
					if (options.handleSigningKeyError) return options.handleSigningKeyError(err).then(reject);
					return reject(err);
				});
			});
		};
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/integrations/passport.js
var require_passport = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const jose = require_cjs();
	const { ArgumentError } = require_errors();
	const { JwksClient } = require_JwksClient();
	const supportedAlg = require_config();
	const handleSigningKeyError = (err, cb) => {
		if (err && err.name === "SigningKeyNotFoundError") return cb(null);
		if (err) return cb(err);
	};
	module.exports.passportJwtSecret = function(options) {
		if (options === null || options === void 0) throw new ArgumentError("An options object must be provided when initializing passportJwtSecret");
		if (!options.jwksUri) throw new ArgumentError("No JWKS provided. Please provide a jwksUri");
		const client = new JwksClient(options);
		const onError = options.handleSigningKeyError || handleSigningKeyError;
		return function secretProvider(req, rawJwtToken, cb) {
			let decoded;
			try {
				decoded = {
					payload: jose.decodeJwt(rawJwtToken),
					header: jose.decodeProtectedHeader(rawJwtToken)
				};
			} catch (err) {
				decoded = null;
			}
			if (!decoded || !supportedAlg.includes(decoded.header.alg)) return cb(null, null);
			client.getSigningKey(decoded.header.kid).then((key) => {
				cb(null, key.publicKey || key.rsaPublicKey);
			}).catch((err) => {
				onError(err, (newError) => cb(newError, null));
			});
		};
	};
}));
//#endregion
//#region node_modules/jwks-rsa/src/index.js
var require_src = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const { JwksClient } = require_JwksClient();
	const errors = require_errors();
	const { hapiJwt2Key, hapiJwt2KeyAsync } = require_hapi();
	const { expressJwtSecret } = require_express();
	const { koaJwtSecret } = require_koa();
	const { passportJwtSecret } = require_passport();
	module.exports = (options) => {
		return new JwksClient(options);
	};
	module.exports.JwksClient = JwksClient;
	module.exports.ArgumentError = errors.ArgumentError;
	module.exports.JwksError = errors.JwksError;
	module.exports.JwksRateLimitError = errors.JwksRateLimitError;
	module.exports.SigningKeyNotFoundError = errors.SigningKeyNotFoundError;
	module.exports.expressJwtSecret = expressJwtSecret;
	module.exports.hapiJwt2Key = hapiJwt2Key;
	module.exports.hapiJwt2KeyAsync = hapiJwt2KeyAsync;
	module.exports.koaJwtSecret = koaJwtSecret;
	module.exports.passportJwtSecret = passportJwtSecret;
}));
//#endregion
export { require_src as t };
