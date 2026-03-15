import { i as __require, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { t as require_safe_buffer } from "./safe-buffer-C7LiycEn.js";
//#region node_modules/.pnpm/ecdsa-sig-formatter@1.0.11/node_modules/ecdsa-sig-formatter/src/param-bytes-for-alg.js
var require_param_bytes_for_alg = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	function getParamSize(keySize) {
		return (keySize / 8 | 0) + (keySize % 8 === 0 ? 0 : 1);
	}
	var paramBytesForAlg = {
		ES256: getParamSize(256),
		ES384: getParamSize(384),
		ES512: getParamSize(521)
	};
	function getParamBytesForAlg(alg) {
		var paramBytes = paramBytesForAlg[alg];
		if (paramBytes) {return paramBytes;}
		throw new Error("Unknown algorithm \"" + alg + "\"");
	}
	module.exports = getParamBytesForAlg;
}));
//#endregion
//#region node_modules/.pnpm/ecdsa-sig-formatter@1.0.11/node_modules/ecdsa-sig-formatter/src/ecdsa-sig-formatter.js
var require_ecdsa_sig_formatter = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = require_safe_buffer().Buffer;
	var getParamBytesForAlg = require_param_bytes_for_alg();
	var MAX_OCTET = 128, CLASS_UNIVERSAL = 0, PRIMITIVE_BIT = 32, TAG_SEQ = 16, TAG_INT = 2, ENCODED_TAG_SEQ = TAG_SEQ | PRIMITIVE_BIT | CLASS_UNIVERSAL << 6, ENCODED_TAG_INT = TAG_INT | CLASS_UNIVERSAL << 6;
	function base64Url(base64) {
		return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	}
	function signatureAsBuffer(signature) {
		if (Buffer.isBuffer(signature)) {return signature;}
		else if ("string" === typeof signature) {return Buffer.from(signature, "base64");}
		throw new TypeError("ECDSA signature must be a Base64 string or a Buffer");
	}
	function derToJose(signature, alg) {
		signature = signatureAsBuffer(signature);
		var paramBytes = getParamBytesForAlg(alg);
		var maxEncodedParamLength = paramBytes + 1;
		var inputLength = signature.length;
		var offset = 0;
		if (signature[offset++] !== ENCODED_TAG_SEQ) {throw new Error("Could not find expected \"seq\"");}
		var seqLength = signature[offset++];
		if (seqLength === (MAX_OCTET | 1)) {seqLength = signature[offset++];}
		if (inputLength - offset < seqLength) {throw new Error("\"seq\" specified length of \"" + seqLength + "\", only \"" + (inputLength - offset) + "\" remaining");}
		if (signature[offset++] !== ENCODED_TAG_INT) {throw new Error("Could not find expected \"int\" for \"r\"");}
		var rLength = signature[offset++];
		if (inputLength - offset - 2 < rLength) {throw new Error("\"r\" specified length of \"" + rLength + "\", only \"" + (inputLength - offset - 2) + "\" available");}
		if (maxEncodedParamLength < rLength) {throw new Error("\"r\" specified length of \"" + rLength + "\", max of \"" + maxEncodedParamLength + "\" is acceptable");}
		var rOffset = offset;
		offset += rLength;
		if (signature[offset++] !== ENCODED_TAG_INT) {throw new Error("Could not find expected \"int\" for \"s\"");}
		var sLength = signature[offset++];
		if (inputLength - offset !== sLength) {throw new Error("\"s\" specified length of \"" + sLength + "\", expected \"" + (inputLength - offset) + "\"");}
		if (maxEncodedParamLength < sLength) {throw new Error("\"s\" specified length of \"" + sLength + "\", max of \"" + maxEncodedParamLength + "\" is acceptable");}
		var sOffset = offset;
		offset += sLength;
		if (offset !== inputLength) {throw new Error("Expected to consume entire buffer, but \"" + (inputLength - offset) + "\" bytes remain");}
		var rPadding = paramBytes - rLength, sPadding = paramBytes - sLength;
		var dst = Buffer.allocUnsafe(rPadding + rLength + sPadding + sLength);
		for (offset = 0; offset < rPadding; ++offset) {dst[offset] = 0;}
		signature.copy(dst, offset, rOffset + Math.max(-rPadding, 0), rOffset + rLength);
		offset = paramBytes;
		for (var o = offset; offset < o + sPadding; ++offset) {dst[offset] = 0;}
		signature.copy(dst, offset, sOffset + Math.max(-sPadding, 0), sOffset + sLength);
		dst = dst.toString("base64");
		dst = base64Url(dst);
		return dst;
	}
	function countPadding(buf, start, stop) {
		var padding = 0;
		while (start + padding < stop && buf[start + padding] === 0) {++padding;}
		if (buf[start + padding] >= MAX_OCTET) {--padding;}
		return padding;
	}
	function joseToDer(signature, alg) {
		signature = signatureAsBuffer(signature);
		var paramBytes = getParamBytesForAlg(alg);
		var signatureBytes = signature.length;
		if (signatureBytes !== paramBytes * 2) {throw new TypeError("\"" + alg + "\" signatures must be \"" + paramBytes * 2 + "\" bytes, saw \"" + signatureBytes + "\"");}
		var rPadding = countPadding(signature, 0, paramBytes);
		var sPadding = countPadding(signature, paramBytes, signature.length);
		var rLength = paramBytes - rPadding;
		var sLength = paramBytes - sPadding;
		var rsBytes = 2 + rLength + 1 + 1 + sLength;
		var shortLength = rsBytes < MAX_OCTET;
		var dst = Buffer.allocUnsafe((shortLength ? 2 : 3) + rsBytes);
		var offset = 0;
		dst[offset++] = ENCODED_TAG_SEQ;
		if (shortLength) {dst[offset++] = rsBytes;}
		else {
			dst[offset++] = MAX_OCTET | 1;
			dst[offset++] = rsBytes & 255;
		}
		dst[offset++] = ENCODED_TAG_INT;
		dst[offset++] = rLength;
		if (rPadding < 0) {
			dst[offset++] = 0;
			offset += signature.copy(dst, offset, 0, paramBytes);
		} else {offset += signature.copy(dst, offset, rPadding, paramBytes);}
		dst[offset++] = ENCODED_TAG_INT;
		dst[offset++] = sLength;
		if (sPadding < 0) {
			dst[offset++] = 0;
			signature.copy(dst, offset, paramBytes);
		} else {signature.copy(dst, offset, paramBytes + sPadding);}
		return dst;
	}
	module.exports = {
		derToJose,
		joseToDer
	};
}));
//#endregion
//#region node_modules/.pnpm/jws@4.0.1/node_modules/jws/lib/data-stream.js
var require_data_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = require_safe_buffer().Buffer;
	var Stream$2 = __require("stream");
	var util$3 = __require("util");
	function DataStream(data) {
		this.buffer = null;
		this.writable = true;
		this.readable = true;
		if (!data) {
			this.buffer = Buffer.alloc(0);
			return this;
		}
		if (typeof data.pipe === "function") {
			this.buffer = Buffer.alloc(0);
			data.pipe(this);
			return this;
		}
		if (data.length || typeof data === "object") {
			this.buffer = data;
			this.writable = false;
			process.nextTick(function() {
				this.emit("end", data);
				this.readable = false;
				this.emit("close");
			}.bind(this));
			return this;
		}
		throw new TypeError("Unexpected data type (" + typeof data + ")");
	}
	util$3.inherits(DataStream, Stream$2);
	DataStream.prototype.write = function write(data) {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(data)]);
		this.emit("data", data);
	};
	DataStream.prototype.end = function end(data) {
		if (data) {this.write(data);}
		this.emit("end", data);
		this.emit("close");
		this.writable = false;
		this.readable = false;
	};
	module.exports = DataStream;
}));
//#endregion
//#region node_modules/.pnpm/buffer-equal-constant-time@1.0.1/node_modules/buffer-equal-constant-time/index.js
var require_buffer_equal_constant_time = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer$1 = __require("buffer").Buffer;
	var SlowBuffer = __require("buffer").SlowBuffer;
	module.exports = bufferEq;
	function bufferEq(a, b) {
		if (!Buffer$1.isBuffer(a) || !Buffer$1.isBuffer(b)) {return false;}
		if (a.length !== b.length) {return false;}
		var c = 0;
		for (var i = 0; i < a.length; i++) {c |= a[i] ^ b[i];}
		return c === 0;
	}
	bufferEq.install = function() {
		Buffer$1.prototype.equal = SlowBuffer.prototype.equal = function equal(that) {
			return bufferEq(this, that);
		};
	};
	var origBufEqual = Buffer$1.prototype.equal;
	var origSlowBufEqual = SlowBuffer.prototype.equal;
	bufferEq.restore = function() {
		Buffer$1.prototype.equal = origBufEqual;
		SlowBuffer.prototype.equal = origSlowBufEqual;
	};
}));
//#endregion
//#region node_modules/.pnpm/jwa@2.0.1/node_modules/jwa/index.js
var require_jwa = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = require_safe_buffer().Buffer;
	var crypto = __require("crypto");
	var formatEcdsa = require_ecdsa_sig_formatter();
	var util$2 = __require("util");
	var MSG_INVALID_ALGORITHM = "\"%s\" is not a valid algorithm.\n  Supported algorithms are:\n  \"HS256\", \"HS384\", \"HS512\", \"RS256\", \"RS384\", \"RS512\", \"PS256\", \"PS384\", \"PS512\", \"ES256\", \"ES384\", \"ES512\" and \"none\".";
	var MSG_INVALID_SECRET = "secret must be a string or buffer";
	var MSG_INVALID_VERIFIER_KEY = "key must be a string or a buffer";
	var MSG_INVALID_SIGNER_KEY = "key must be a string, a buffer or an object";
	var supportsKeyObjects = typeof crypto.createPublicKey === "function";
	if (supportsKeyObjects) {
		MSG_INVALID_VERIFIER_KEY += " or a KeyObject";
		MSG_INVALID_SECRET += "or a KeyObject";
	}
	function checkIsPublicKey(key) {
		if (Buffer.isBuffer(key)) {return;}
		if (typeof key === "string") {return;}
		if (!supportsKeyObjects) {throw typeError(MSG_INVALID_VERIFIER_KEY);}
		if (typeof key !== "object") {throw typeError(MSG_INVALID_VERIFIER_KEY);}
		if (typeof key.type !== "string") {throw typeError(MSG_INVALID_VERIFIER_KEY);}
		if (typeof key.asymmetricKeyType !== "string") {throw typeError(MSG_INVALID_VERIFIER_KEY);}
		if (typeof key.export !== "function") {throw typeError(MSG_INVALID_VERIFIER_KEY);}
	}
	function checkIsPrivateKey(key) {
		if (Buffer.isBuffer(key)) {return;}
		if (typeof key === "string") {return;}
		if (typeof key === "object") {return;}
		throw typeError(MSG_INVALID_SIGNER_KEY);
	}
	function checkIsSecretKey(key) {
		if (Buffer.isBuffer(key)) {return;}
		if (typeof key === "string") {return key;}
		if (!supportsKeyObjects) {throw typeError(MSG_INVALID_SECRET);}
		if (typeof key !== "object") {throw typeError(MSG_INVALID_SECRET);}
		if (key.type !== "secret") {throw typeError(MSG_INVALID_SECRET);}
		if (typeof key.export !== "function") {throw typeError(MSG_INVALID_SECRET);}
	}
	function fromBase64(base64) {
		return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	}
	function toBase64(base64url) {
		base64url = base64url.toString();
		var padding = 4 - base64url.length % 4;
		if (padding !== 4) {for (var i = 0; i < padding; ++i) base64url += "=";}
		return base64url.replace(/-/g, "+").replace(/_/g, "/");
	}
	function typeError(template) {
		var args = [].slice.call(arguments, 1);
		var errMsg = util$2.format.bind(util$2, template).apply(null, args);
		return new TypeError(errMsg);
	}
	function bufferOrString(obj) {
		return Buffer.isBuffer(obj) || typeof obj === "string";
	}
	function normalizeInput(thing) {
		if (!bufferOrString(thing)) {thing = JSON.stringify(thing);}
		return thing;
	}
	function createHmacSigner(bits) {
		return function sign(thing, secret) {
			checkIsSecretKey(secret);
			thing = normalizeInput(thing);
			var hmac = crypto.createHmac("sha" + bits, secret);
			return fromBase64((hmac.update(thing), hmac.digest("base64")));
		};
	}
	var bufferEqual;
	var timingSafeEqual = "timingSafeEqual" in crypto ? function timingSafeEqual(a, b) {
		if (a.byteLength !== b.byteLength) {return false;}
		return crypto.timingSafeEqual(a, b);
	} : function timingSafeEqual(a, b) {
		if (!bufferEqual) {bufferEqual = require_buffer_equal_constant_time();}
		return bufferEqual(a, b);
	};
	function createHmacVerifier(bits) {
		return function verify(thing, signature, secret) {
			var computedSig = createHmacSigner(bits)(thing, secret);
			return timingSafeEqual(Buffer.from(signature), Buffer.from(computedSig));
		};
	}
	function createKeySigner(bits) {
		return function sign(thing, privateKey) {
			checkIsPrivateKey(privateKey);
			thing = normalizeInput(thing);
			var signer = crypto.createSign("RSA-SHA" + bits);
			return fromBase64((signer.update(thing), signer.sign(privateKey, "base64")));
		};
	}
	function createKeyVerifier(bits) {
		return function verify(thing, signature, publicKey) {
			checkIsPublicKey(publicKey);
			thing = normalizeInput(thing);
			signature = toBase64(signature);
			var verifier = crypto.createVerify("RSA-SHA" + bits);
			verifier.update(thing);
			return verifier.verify(publicKey, signature, "base64");
		};
	}
	function createPSSKeySigner(bits) {
		return function sign(thing, privateKey) {
			checkIsPrivateKey(privateKey);
			thing = normalizeInput(thing);
			var signer = crypto.createSign("RSA-SHA" + bits);
			return fromBase64((signer.update(thing), signer.sign({
				key: privateKey,
				padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
				saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
			}, "base64")));
		};
	}
	function createPSSKeyVerifier(bits) {
		return function verify(thing, signature, publicKey) {
			checkIsPublicKey(publicKey);
			thing = normalizeInput(thing);
			signature = toBase64(signature);
			var verifier = crypto.createVerify("RSA-SHA" + bits);
			verifier.update(thing);
			return verifier.verify({
				key: publicKey,
				padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
				saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
			}, signature, "base64");
		};
	}
	function createECDSASigner(bits) {
		var inner = createKeySigner(bits);
		return function sign() {
			var signature = inner.apply(null, arguments);
			signature = formatEcdsa.derToJose(signature, "ES" + bits);
			return signature;
		};
	}
	function createECDSAVerifer(bits) {
		var inner = createKeyVerifier(bits);
		return function verify(thing, signature, publicKey) {
			signature = formatEcdsa.joseToDer(signature, "ES" + bits).toString("base64");
			return inner(thing, signature, publicKey);
		};
	}
	function createNoneSigner() {
		return function sign() {
			return "";
		};
	}
	function createNoneVerifier() {
		return function verify(thing, signature) {
			return signature === "";
		};
	}
	module.exports = function jwa(algorithm) {
		var signerFactories = {
			hs: createHmacSigner,
			rs: createKeySigner,
			ps: createPSSKeySigner,
			es: createECDSASigner,
			none: createNoneSigner
		};
		var verifierFactories = {
			hs: createHmacVerifier,
			rs: createKeyVerifier,
			ps: createPSSKeyVerifier,
			es: createECDSAVerifer,
			none: createNoneVerifier
		};
		var match = algorithm.match(/^(RS|PS|ES|HS)(256|384|512)$|^(none)$/);
		if (!match) {throw typeError(MSG_INVALID_ALGORITHM, algorithm);}
		var algo = (match[1] || match[3]).toLowerCase();
		var bits = match[2];
		return {
			sign: signerFactories[algo](bits),
			verify: verifierFactories[algo](bits)
		};
	};
}));
//#endregion
//#region node_modules/.pnpm/jws@4.0.1/node_modules/jws/lib/tostring.js
var require_tostring = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = __require("buffer").Buffer;
	module.exports = function toString(obj) {
		if (typeof obj === "string") {return obj;}
		if (typeof obj === "number" || Buffer.isBuffer(obj)) {return obj.toString();}
		return JSON.stringify(obj);
	};
}));
//#endregion
//#region node_modules/.pnpm/jws@4.0.1/node_modules/jws/lib/sign-stream.js
var require_sign_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = require_safe_buffer().Buffer;
	var DataStream = require_data_stream();
	var jwa = require_jwa();
	var Stream$1 = __require("stream");
	var toString = require_tostring();
	var util$1 = __require("util");
	function base64url(string, encoding) {
		return Buffer.from(string, encoding).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	}
	function jwsSecuredInput(header, payload, encoding) {
		encoding = encoding || "utf8";
		var encodedHeader = base64url(toString(header), "binary");
		var encodedPayload = base64url(toString(payload), encoding);
		return util$1.format("%s.%s", encodedHeader, encodedPayload);
	}
	function jwsSign(opts) {
		var header = opts.header;
		var payload = opts.payload;
		var secretOrKey = opts.secret || opts.privateKey;
		var encoding = opts.encoding;
		var algo = jwa(header.alg);
		var securedInput = jwsSecuredInput(header, payload, encoding);
		var signature = algo.sign(securedInput, secretOrKey);
		return util$1.format("%s.%s", securedInput, signature);
	}
	function SignStream(opts) {
		var secret = opts.secret;
		secret = secret == null ? opts.privateKey : secret;
		secret = secret == null ? opts.key : secret;
		if (/^hs/i.test(opts.header.alg) && secret == null) {throw new TypeError("secret must be a string or buffer or a KeyObject");}
		var secretStream = new DataStream(secret);
		this.readable = true;
		this.header = opts.header;
		this.encoding = opts.encoding;
		this.secret = this.privateKey = this.key = secretStream;
		this.payload = new DataStream(opts.payload);
		this.secret.once("close", function() {
			if (!this.payload.writable && this.readable) {this.sign();}
		}.bind(this));
		this.payload.once("close", function() {
			if (!this.secret.writable && this.readable) {this.sign();}
		}.bind(this));
	}
	util$1.inherits(SignStream, Stream$1);
	SignStream.prototype.sign = function sign() {
		try {
			var signature = jwsSign({
				header: this.header,
				payload: this.payload.buffer,
				secret: this.secret.buffer,
				encoding: this.encoding
			});
			this.emit("done", signature);
			this.emit("data", signature);
			this.emit("end");
			this.readable = false;
			return signature;
		} catch (e) {
			this.readable = false;
			this.emit("error", e);
			this.emit("close");
		}
	};
	SignStream.sign = jwsSign;
	module.exports = SignStream;
}));
//#endregion
//#region node_modules/.pnpm/jws@4.0.1/node_modules/jws/lib/verify-stream.js
var require_verify_stream = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var Buffer = require_safe_buffer().Buffer;
	var DataStream = require_data_stream();
	var jwa = require_jwa();
	var Stream = __require("stream");
	var toString = require_tostring();
	var util = __require("util");
	var JWS_REGEX = /^[a-zA-Z0-9\-_]+?\.[a-zA-Z0-9\-_]+?\.([a-zA-Z0-9\-_]+)?$/;
	function isObject(thing) {
		return Object.prototype.toString.call(thing) === "[object Object]";
	}
	function safeJsonParse(thing) {
		if (isObject(thing)) {return thing;}
		try {
			return JSON.parse(thing);
		} catch (e) {
			return;
		}
	}
	function headerFromJWS(jwsSig) {
		var encodedHeader = jwsSig.split(".", 1)[0];
		return safeJsonParse(Buffer.from(encodedHeader, "base64").toString("binary"));
	}
	function securedInputFromJWS(jwsSig) {
		return jwsSig.split(".", 2).join(".");
	}
	function signatureFromJWS(jwsSig) {
		return jwsSig.split(".")[2];
	}
	function payloadFromJWS(jwsSig, encoding) {
		encoding = encoding || "utf8";
		var payload = jwsSig.split(".")[1];
		return Buffer.from(payload, "base64").toString(encoding);
	}
	function isValidJws(string) {
		return JWS_REGEX.test(string) && !!headerFromJWS(string);
	}
	function jwsVerify(jwsSig, algorithm, secretOrKey) {
		if (!algorithm) {
			var err = /* @__PURE__ */ new Error("Missing algorithm parameter for jws.verify");
			err.code = "MISSING_ALGORITHM";
			throw err;
		}
		jwsSig = toString(jwsSig);
		var signature = signatureFromJWS(jwsSig);
		var securedInput = securedInputFromJWS(jwsSig);
		return jwa(algorithm).verify(securedInput, signature, secretOrKey);
	}
	function jwsDecode(jwsSig, opts) {
		opts = opts || {};
		jwsSig = toString(jwsSig);
		if (!isValidJws(jwsSig)) {return null;}
		var header = headerFromJWS(jwsSig);
		if (!header) {return null;}
		var payload = payloadFromJWS(jwsSig);
		if (header.typ === "JWT" || opts.json) {payload = JSON.parse(payload, opts.encoding);}
		return {
			header,
			payload,
			signature: signatureFromJWS(jwsSig)
		};
	}
	function VerifyStream(opts) {
		opts = opts || {};
		var secretOrKey = opts.secret;
		secretOrKey = secretOrKey == null ? opts.publicKey : secretOrKey;
		secretOrKey = secretOrKey == null ? opts.key : secretOrKey;
		if (/^hs/i.test(opts.algorithm) && secretOrKey == null) {throw new TypeError("secret must be a string or buffer or a KeyObject");}
		var secretStream = new DataStream(secretOrKey);
		this.readable = true;
		this.algorithm = opts.algorithm;
		this.encoding = opts.encoding;
		this.secret = this.publicKey = this.key = secretStream;
		this.signature = new DataStream(opts.signature);
		this.secret.once("close", function() {
			if (!this.signature.writable && this.readable) {this.verify();}
		}.bind(this));
		this.signature.once("close", function() {
			if (!this.secret.writable && this.readable) {this.verify();}
		}.bind(this));
	}
	util.inherits(VerifyStream, Stream);
	VerifyStream.prototype.verify = function verify() {
		try {
			var valid = jwsVerify(this.signature.buffer, this.algorithm, this.key.buffer);
			var obj = jwsDecode(this.signature.buffer, this.encoding);
			this.emit("done", valid, obj);
			this.emit("data", valid);
			this.emit("end");
			this.readable = false;
			return valid;
		} catch (e) {
			this.readable = false;
			this.emit("error", e);
			this.emit("close");
		}
	};
	VerifyStream.decode = jwsDecode;
	VerifyStream.isValid = isValidJws;
	VerifyStream.verify = jwsVerify;
	module.exports = VerifyStream;
}));
//#endregion
//#region node_modules/.pnpm/jws@4.0.1/node_modules/jws/index.js
var require_jws = /* @__PURE__ */ __commonJSMin(((exports) => {
	var SignStream = require_sign_stream();
	var VerifyStream = require_verify_stream();
	exports.ALGORITHMS = [
		"HS256",
		"HS384",
		"HS512",
		"RS256",
		"RS384",
		"RS512",
		"PS256",
		"PS384",
		"PS512",
		"ES256",
		"ES384",
		"ES512"
	];
	exports.sign = SignStream.sign;
	exports.verify = VerifyStream.verify;
	exports.decode = VerifyStream.decode;
	exports.isValid = VerifyStream.isValid;
	exports.createSign = function createSign(opts) {
		return new SignStream(opts);
	};
	exports.createVerify = function createVerify(opts) {
		return new VerifyStream(opts);
	};
}));
//#endregion
export { require_ecdsa_sig_formatter as n, require_jws as t };
