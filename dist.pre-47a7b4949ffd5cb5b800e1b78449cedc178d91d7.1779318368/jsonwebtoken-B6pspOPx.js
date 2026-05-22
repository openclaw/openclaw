import { i as __require, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { t as require_ms } from "./ms-B0TCC9QC.js";
import { t as require_jws } from "./jws-DMXXugcC.js";
import { t as require_semver } from "./semver-D7uDpNw9.js";
//#region node_modules/jsonwebtoken/decode.js
var require_decode = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var jws = require_jws();
	module.exports = function(jwt, options) {
		options = options || {};
		var decoded = jws.decode(jwt, options);
		if (!decoded) return null;
		var payload = decoded.payload;
		if (typeof payload === "string") try {
			var obj = JSON.parse(payload);
			if (obj !== null && typeof obj === "object") payload = obj;
		} catch (e) {}
		if (options.complete === true) return {
			header: decoded.header,
			payload,
			signature: decoded.signature
		};
		return payload;
	};
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/JsonWebTokenError.js
var require_JsonWebTokenError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var JsonWebTokenError = function(message, error) {
		Error.call(this, message);
		if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
		this.name = "JsonWebTokenError";
		this.message = message;
		if (error) this.inner = error;
	};
	JsonWebTokenError.prototype = Object.create(Error.prototype);
	JsonWebTokenError.prototype.constructor = JsonWebTokenError;
	module.exports = JsonWebTokenError;
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/NotBeforeError.js
var require_NotBeforeError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var JsonWebTokenError = require_JsonWebTokenError();
	var NotBeforeError = function(message, date) {
		JsonWebTokenError.call(this, message);
		this.name = "NotBeforeError";
		this.date = date;
	};
	NotBeforeError.prototype = Object.create(JsonWebTokenError.prototype);
	NotBeforeError.prototype.constructor = NotBeforeError;
	module.exports = NotBeforeError;
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/TokenExpiredError.js
var require_TokenExpiredError = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var JsonWebTokenError = require_JsonWebTokenError();
	var TokenExpiredError = function(message, expiredAt) {
		JsonWebTokenError.call(this, message);
		this.name = "TokenExpiredError";
		this.expiredAt = expiredAt;
	};
	TokenExpiredError.prototype = Object.create(JsonWebTokenError.prototype);
	TokenExpiredError.prototype.constructor = TokenExpiredError;
	module.exports = TokenExpiredError;
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/timespan.js
var require_timespan = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	var ms = require_ms();
	module.exports = function(time, iat) {
		var timestamp = iat || Math.floor(Date.now() / 1e3);
		if (typeof time === "string") {
			var milliseconds = ms(time);
			if (typeof milliseconds === "undefined") return;
			return Math.floor(timestamp + milliseconds / 1e3);
		} else if (typeof time === "number") return timestamp + time;
		else return;
	};
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/asymmetricKeyDetailsSupported.js
var require_asymmetricKeyDetailsSupported = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_semver().satisfies(process.version, ">=15.7.0");
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/rsaPssKeyDetailsSupported.js
var require_rsaPssKeyDetailsSupported = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_semver().satisfies(process.version, ">=16.9.0");
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/validateAsymmetricKey.js
var require_validateAsymmetricKey = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const ASYMMETRIC_KEY_DETAILS_SUPPORTED = require_asymmetricKeyDetailsSupported();
	const RSA_PSS_KEY_DETAILS_SUPPORTED = require_rsaPssKeyDetailsSupported();
	const allowedAlgorithmsForKeys = {
		"ec": [
			"ES256",
			"ES384",
			"ES512"
		],
		"rsa": [
			"RS256",
			"PS256",
			"RS384",
			"PS384",
			"RS512",
			"PS512"
		],
		"rsa-pss": [
			"PS256",
			"PS384",
			"PS512"
		]
	};
	const allowedCurves = {
		ES256: "prime256v1",
		ES384: "secp384r1",
		ES512: "secp521r1"
	};
	module.exports = function(algorithm, key) {
		if (!algorithm || !key) return;
		const keyType = key.asymmetricKeyType;
		if (!keyType) return;
		const allowedAlgorithms = allowedAlgorithmsForKeys[keyType];
		if (!allowedAlgorithms) throw new Error(`Unknown key type "${keyType}".`);
		if (!allowedAlgorithms.includes(algorithm)) throw new Error(`"alg" parameter for "${keyType}" key type must be one of: ${allowedAlgorithms.join(", ")}.`);
		/* istanbul ignore next */
		if (ASYMMETRIC_KEY_DETAILS_SUPPORTED) switch (keyType) {
			case "ec":
				const keyCurve = key.asymmetricKeyDetails.namedCurve;
				const allowedCurve = allowedCurves[algorithm];
				if (keyCurve !== allowedCurve) throw new Error(`"alg" parameter "${algorithm}" requires curve "${allowedCurve}".`);
				break;
			case "rsa-pss":
				if (RSA_PSS_KEY_DETAILS_SUPPORTED) {
					const length = parseInt(algorithm.slice(-3), 10);
					const { hashAlgorithm, mgf1HashAlgorithm, saltLength } = key.asymmetricKeyDetails;
					if (hashAlgorithm !== `sha${length}` || mgf1HashAlgorithm !== hashAlgorithm) throw new Error(`Invalid key for this operation, its RSA-PSS parameters do not meet the requirements of "alg" ${algorithm}.`);
					if (saltLength !== void 0 && saltLength > length >> 3) throw new Error(`Invalid key for this operation, its RSA-PSS parameter saltLength does not meet the requirements of "alg" ${algorithm}.`);
				}
				break;
		}
	};
}));
//#endregion
//#region node_modules/jsonwebtoken/lib/psSupported.js
var require_psSupported = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = require_semver().satisfies(process.version, "^6.12.0 || >=8.0.0");
}));
//#endregion
//#region node_modules/jsonwebtoken/verify.js
var require_verify = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const JsonWebTokenError = require_JsonWebTokenError();
	const NotBeforeError = require_NotBeforeError();
	const TokenExpiredError = require_TokenExpiredError();
	const decode = require_decode();
	const timespan = require_timespan();
	const validateAsymmetricKey = require_validateAsymmetricKey();
	const PS_SUPPORTED = require_psSupported();
	const jws = require_jws();
	const { KeyObject: KeyObject$1, createSecretKey: createSecretKey$1, createPublicKey } = __require("crypto");
	const PUB_KEY_ALGS = [
		"RS256",
		"RS384",
		"RS512"
	];
	const EC_KEY_ALGS = [
		"ES256",
		"ES384",
		"ES512"
	];
	const RSA_KEY_ALGS = [
		"RS256",
		"RS384",
		"RS512"
	];
	const HS_ALGS = [
		"HS256",
		"HS384",
		"HS512"
	];
	if (PS_SUPPORTED) {
		PUB_KEY_ALGS.splice(PUB_KEY_ALGS.length, 0, "PS256", "PS384", "PS512");
		RSA_KEY_ALGS.splice(RSA_KEY_ALGS.length, 0, "PS256", "PS384", "PS512");
	}
	module.exports = function(jwtString, secretOrPublicKey, options, callback) {
		if (typeof options === "function" && !callback) {
			callback = options;
			options = {};
		}
		if (!options) options = {};
		options = Object.assign({}, options);
		let done;
		if (callback) done = callback;
		else done = function(err, data) {
			if (err) throw err;
			return data;
		};
		if (options.clockTimestamp && typeof options.clockTimestamp !== "number") return done(new JsonWebTokenError("clockTimestamp must be a number"));
		if (options.nonce !== void 0 && (typeof options.nonce !== "string" || options.nonce.trim() === "")) return done(new JsonWebTokenError("nonce must be a non-empty string"));
		if (options.allowInvalidAsymmetricKeyTypes !== void 0 && typeof options.allowInvalidAsymmetricKeyTypes !== "boolean") return done(new JsonWebTokenError("allowInvalidAsymmetricKeyTypes must be a boolean"));
		const clockTimestamp = options.clockTimestamp || Math.floor(Date.now() / 1e3);
		if (!jwtString) return done(new JsonWebTokenError("jwt must be provided"));
		if (typeof jwtString !== "string") return done(new JsonWebTokenError("jwt must be a string"));
		const parts = jwtString.split(".");
		if (parts.length !== 3) return done(new JsonWebTokenError("jwt malformed"));
		let decodedToken;
		try {
			decodedToken = decode(jwtString, { complete: true });
		} catch (err) {
			return done(err);
		}
		if (!decodedToken) return done(new JsonWebTokenError("invalid token"));
		const header = decodedToken.header;
		let getSecret;
		if (typeof secretOrPublicKey === "function") {
			if (!callback) return done(new JsonWebTokenError("verify must be called asynchronous if secret or public key is provided as a callback"));
			getSecret = secretOrPublicKey;
		} else getSecret = function(header, secretCallback) {
			return secretCallback(null, secretOrPublicKey);
		};
		return getSecret(header, function(err, secretOrPublicKey) {
			if (err) return done(new JsonWebTokenError("error in secret or public key callback: " + err.message));
			const hasSignature = parts[2].trim() !== "";
			if (!hasSignature && secretOrPublicKey) return done(new JsonWebTokenError("jwt signature is required"));
			if (hasSignature && !secretOrPublicKey) return done(new JsonWebTokenError("secret or public key must be provided"));
			if (!hasSignature && !options.algorithms) return done(new JsonWebTokenError("please specify \"none\" in \"algorithms\" to verify unsigned tokens"));
			if (secretOrPublicKey != null && !(secretOrPublicKey instanceof KeyObject$1)) try {
				secretOrPublicKey = createPublicKey(secretOrPublicKey);
			} catch (_) {
				try {
					secretOrPublicKey = createSecretKey$1(typeof secretOrPublicKey === "string" ? Buffer.from(secretOrPublicKey) : secretOrPublicKey);
				} catch (_) {
					return done(new JsonWebTokenError("secretOrPublicKey is not valid key material"));
				}
			}
			if (!options.algorithms) if (secretOrPublicKey.type === "secret") options.algorithms = HS_ALGS;
			else if (["rsa", "rsa-pss"].includes(secretOrPublicKey.asymmetricKeyType)) options.algorithms = RSA_KEY_ALGS;
			else if (secretOrPublicKey.asymmetricKeyType === "ec") options.algorithms = EC_KEY_ALGS;
			else options.algorithms = PUB_KEY_ALGS;
			if (options.algorithms.indexOf(decodedToken.header.alg) === -1) return done(new JsonWebTokenError("invalid algorithm"));
			if (header.alg.startsWith("HS") && secretOrPublicKey.type !== "secret") return done(new JsonWebTokenError(`secretOrPublicKey must be a symmetric key when using ${header.alg}`));
			else if (/^(?:RS|PS|ES)/.test(header.alg) && secretOrPublicKey.type !== "public") return done(new JsonWebTokenError(`secretOrPublicKey must be an asymmetric key when using ${header.alg}`));
			if (!options.allowInvalidAsymmetricKeyTypes) try {
				validateAsymmetricKey(header.alg, secretOrPublicKey);
			} catch (e) {
				return done(e);
			}
			let valid;
			try {
				valid = jws.verify(jwtString, decodedToken.header.alg, secretOrPublicKey);
			} catch (e) {
				return done(e);
			}
			if (!valid) return done(new JsonWebTokenError("invalid signature"));
			const payload = decodedToken.payload;
			if (typeof payload.nbf !== "undefined" && !options.ignoreNotBefore) {
				if (typeof payload.nbf !== "number") return done(new JsonWebTokenError("invalid nbf value"));
				if (payload.nbf > clockTimestamp + (options.clockTolerance || 0)) return done(new NotBeforeError("jwt not active", /* @__PURE__ */ new Date(payload.nbf * 1e3)));
			}
			if (typeof payload.exp !== "undefined" && !options.ignoreExpiration) {
				if (typeof payload.exp !== "number") return done(new JsonWebTokenError("invalid exp value"));
				if (clockTimestamp >= payload.exp + (options.clockTolerance || 0)) return done(new TokenExpiredError("jwt expired", /* @__PURE__ */ new Date(payload.exp * 1e3)));
			}
			if (options.audience) {
				const audiences = Array.isArray(options.audience) ? options.audience : [options.audience];
				if (!(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).some(function(targetAudience) {
					return audiences.some(function(audience) {
						return audience instanceof RegExp ? audience.test(targetAudience) : audience === targetAudience;
					});
				})) return done(new JsonWebTokenError("jwt audience invalid. expected: " + audiences.join(" or ")));
			}
			if (options.issuer) {
				if (typeof options.issuer === "string" && payload.iss !== options.issuer || Array.isArray(options.issuer) && options.issuer.indexOf(payload.iss) === -1) return done(new JsonWebTokenError("jwt issuer invalid. expected: " + options.issuer));
			}
			if (options.subject) {
				if (payload.sub !== options.subject) return done(new JsonWebTokenError("jwt subject invalid. expected: " + options.subject));
			}
			if (options.jwtid) {
				if (payload.jti !== options.jwtid) return done(new JsonWebTokenError("jwt jwtid invalid. expected: " + options.jwtid));
			}
			if (options.nonce) {
				if (payload.nonce !== options.nonce) return done(new JsonWebTokenError("jwt nonce invalid. expected: " + options.nonce));
			}
			if (options.maxAge) {
				if (typeof payload.iat !== "number") return done(new JsonWebTokenError("iat required when maxAge is specified"));
				const maxAgeTimestamp = timespan(options.maxAge, payload.iat);
				if (typeof maxAgeTimestamp === "undefined") return done(new JsonWebTokenError("\"maxAge\" should be a number of seconds or string representing a timespan eg: \"1d\", \"20h\", 60"));
				if (clockTimestamp >= maxAgeTimestamp + (options.clockTolerance || 0)) return done(new TokenExpiredError("maxAge exceeded", /* @__PURE__ */ new Date(maxAgeTimestamp * 1e3)));
			}
			if (options.complete === true) {
				const signature = decodedToken.signature;
				return done(null, {
					header,
					payload,
					signature
				});
			}
			return done(null, payload);
		});
	};
}));
//#endregion
//#region node_modules/lodash.includes/index.js
var require_lodash_includes = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** Used as references for various `Number` constants. */
	var INFINITY = Infinity, MAX_SAFE_INTEGER = 9007199254740991, MAX_INTEGER = 17976931348623157e292, NAN = NaN;
	/** `Object#toString` result references. */
	var argsTag = "[object Arguments]", funcTag = "[object Function]", genTag = "[object GeneratorFunction]", stringTag = "[object String]", symbolTag = "[object Symbol]";
	/** Used to match leading and trailing whitespace. */
	var reTrim = /^\s+|\s+$/g;
	/** Used to detect bad signed hexadecimal string values. */
	var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
	/** Used to detect binary string values. */
	var reIsBinary = /^0b[01]+$/i;
	/** Used to detect octal string values. */
	var reIsOctal = /^0o[0-7]+$/i;
	/** Used to detect unsigned integer values. */
	var reIsUint = /^(?:0|[1-9]\d*)$/;
	/** Built-in method references without a dependency on `root`. */
	var freeParseInt = parseInt;
	/**
	* A specialized version of `_.map` for arrays without support for iteratee
	* shorthands.
	*
	* @private
	* @param {Array} [array] The array to iterate over.
	* @param {Function} iteratee The function invoked per iteration.
	* @returns {Array} Returns the new mapped array.
	*/
	function arrayMap(array, iteratee) {
		var index = -1, length = array ? array.length : 0, result = Array(length);
		while (++index < length) result[index] = iteratee(array[index], index, array);
		return result;
	}
	/**
	* The base implementation of `_.findIndex` and `_.findLastIndex` without
	* support for iteratee shorthands.
	*
	* @private
	* @param {Array} array The array to inspect.
	* @param {Function} predicate The function invoked per iteration.
	* @param {number} fromIndex The index to search from.
	* @param {boolean} [fromRight] Specify iterating from right to left.
	* @returns {number} Returns the index of the matched value, else `-1`.
	*/
	function baseFindIndex(array, predicate, fromIndex, fromRight) {
		var length = array.length, index = fromIndex + (fromRight ? 1 : -1);
		while (fromRight ? index-- : ++index < length) if (predicate(array[index], index, array)) return index;
		return -1;
	}
	/**
	* The base implementation of `_.indexOf` without `fromIndex` bounds checks.
	*
	* @private
	* @param {Array} array The array to inspect.
	* @param {*} value The value to search for.
	* @param {number} fromIndex The index to search from.
	* @returns {number} Returns the index of the matched value, else `-1`.
	*/
	function baseIndexOf(array, value, fromIndex) {
		if (value !== value) return baseFindIndex(array, baseIsNaN, fromIndex);
		var index = fromIndex - 1, length = array.length;
		while (++index < length) if (array[index] === value) return index;
		return -1;
	}
	/**
	* The base implementation of `_.isNaN` without support for number objects.
	*
	* @private
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is `NaN`, else `false`.
	*/
	function baseIsNaN(value) {
		return value !== value;
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
	* The base implementation of `_.values` and `_.valuesIn` which creates an
	* array of `object` property values corresponding to the property names
	* of `props`.
	*
	* @private
	* @param {Object} object The object to query.
	* @param {Array} props The property names to get values for.
	* @returns {Object} Returns the array of property values.
	*/
	function baseValues(object, props) {
		return arrayMap(props, function(key) {
			return object[key];
		});
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
	/** Used for built-in method references. */
	var objectProto = Object.prototype;
	/** Used to check objects for own properties. */
	var hasOwnProperty = objectProto.hasOwnProperty;
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = objectProto.toString;
	/** Built-in value references. */
	var propertyIsEnumerable = objectProto.propertyIsEnumerable;
	var nativeKeys = overArg(Object.keys, Object), nativeMax = Math.max;
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
	* Checks if `value` is in `collection`. If `collection` is a string, it's
	* checked for a substring of `value`, otherwise
	* [`SameValueZero`](http://ecma-international.org/ecma-262/7.0/#sec-samevaluezero)
	* is used for equality comparisons. If `fromIndex` is negative, it's used as
	* the offset from the end of `collection`.
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Collection
	* @param {Array|Object|string} collection The collection to inspect.
	* @param {*} value The value to search for.
	* @param {number} [fromIndex=0] The index to search from.
	* @param- {Object} [guard] Enables use as an iteratee for methods like `_.reduce`.
	* @returns {boolean} Returns `true` if `value` is found, else `false`.
	* @example
	*
	* _.includes([1, 2, 3], 1);
	* // => true
	*
	* _.includes([1, 2, 3], 1, 2);
	* // => false
	*
	* _.includes({ 'a': 1, 'b': 2 }, 1);
	* // => true
	*
	* _.includes('abcd', 'bc');
	* // => true
	*/
	function includes(collection, value, fromIndex, guard) {
		collection = isArrayLike(collection) ? collection : values(collection);
		fromIndex = fromIndex && !guard ? toInteger(fromIndex) : 0;
		var length = collection.length;
		if (fromIndex < 0) fromIndex = nativeMax(length + fromIndex, 0);
		return isString(collection) ? fromIndex <= length && collection.indexOf(value, fromIndex) > -1 : !!length && baseIndexOf(collection, value, fromIndex) > -1;
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
	* Checks if `value` is classified as a `String` primitive or object.
	*
	* @static
	* @since 0.1.0
	* @memberOf _
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a string, else `false`.
	* @example
	*
	* _.isString('abc');
	* // => true
	*
	* _.isString(1);
	* // => false
	*/
	function isString(value) {
		return typeof value == "string" || !isArray(value) && isObjectLike(value) && objectToString.call(value) == stringTag;
	}
	/**
	* Checks if `value` is classified as a `Symbol` primitive or object.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
	* @example
	*
	* _.isSymbol(Symbol.iterator);
	* // => true
	*
	* _.isSymbol('abc');
	* // => false
	*/
	function isSymbol(value) {
		return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
	}
	/**
	* Converts `value` to a finite number.
	*
	* @static
	* @memberOf _
	* @since 4.12.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted number.
	* @example
	*
	* _.toFinite(3.2);
	* // => 3.2
	*
	* _.toFinite(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toFinite(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toFinite('3.2');
	* // => 3.2
	*/
	function toFinite(value) {
		if (!value) return value === 0 ? value : 0;
		value = toNumber(value);
		if (value === INFINITY || value === -INFINITY) return (value < 0 ? -1 : 1) * MAX_INTEGER;
		return value === value ? value : 0;
	}
	/**
	* Converts `value` to an integer.
	*
	* **Note:** This method is loosely based on
	* [`ToInteger`](http://www.ecma-international.org/ecma-262/7.0/#sec-tointeger).
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted integer.
	* @example
	*
	* _.toInteger(3.2);
	* // => 3
	*
	* _.toInteger(Number.MIN_VALUE);
	* // => 0
	*
	* _.toInteger(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toInteger('3.2');
	* // => 3
	*/
	function toInteger(value) {
		var result = toFinite(value), remainder = result % 1;
		return result === result ? remainder ? result - remainder : result : 0;
	}
	/**
	* Converts `value` to a number.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to process.
	* @returns {number} Returns the number.
	* @example
	*
	* _.toNumber(3.2);
	* // => 3.2
	*
	* _.toNumber(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toNumber(Infinity);
	* // => Infinity
	*
	* _.toNumber('3.2');
	* // => 3.2
	*/
	function toNumber(value) {
		if (typeof value == "number") return value;
		if (isSymbol(value)) return NAN;
		if (isObject(value)) {
			var other = typeof value.valueOf == "function" ? value.valueOf() : value;
			value = isObject(other) ? other + "" : other;
		}
		if (typeof value != "string") return value === 0 ? value : +value;
		value = value.replace(reTrim, "");
		var isBinary = reIsBinary.test(value);
		return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
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
	* Creates an array of the own enumerable string keyed property values of `object`.
	*
	* **Note:** Non-object values are coerced to objects.
	*
	* @static
	* @since 0.1.0
	* @memberOf _
	* @category Object
	* @param {Object} object The object to query.
	* @returns {Array} Returns the array of property values.
	* @example
	*
	* function Foo() {
	*   this.a = 1;
	*   this.b = 2;
	* }
	*
	* Foo.prototype.c = 3;
	*
	* _.values(new Foo);
	* // => [1, 2] (iteration order is not guaranteed)
	*
	* _.values('hi');
	* // => ['h', 'i']
	*/
	function values(object) {
		return object ? baseValues(object, keys(object)) : [];
	}
	module.exports = includes;
}));
//#endregion
//#region node_modules/lodash.isboolean/index.js
var require_lodash_isboolean = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash 3.0.3 (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright 2012-2016 The Dojo Foundation <http://dojofoundation.org/>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright 2009-2016 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	* Available under MIT license <https://lodash.com/license>
	*/
	/** `Object#toString` result references. */
	var boolTag = "[object Boolean]";
	/**
	* Used to resolve the [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/**
	* Checks if `value` is classified as a boolean primitive or object.
	*
	* @static
	* @memberOf _
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is correctly classified, else `false`.
	* @example
	*
	* _.isBoolean(false);
	* // => true
	*
	* _.isBoolean(null);
	* // => false
	*/
	function isBoolean(value) {
		return value === true || value === false || isObjectLike(value) && objectToString.call(value) == boolTag;
	}
	/**
	* Checks if `value` is object-like. A value is object-like if it's not `null`
	* and has a `typeof` result of "object".
	*
	* @static
	* @memberOf _
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
	module.exports = isBoolean;
}));
//#endregion
//#region node_modules/lodash.isinteger/index.js
var require_lodash_isinteger = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** Used as references for various `Number` constants. */
	var INFINITY = Infinity, MAX_INTEGER = 17976931348623157e292, NAN = NaN;
	/** `Object#toString` result references. */
	var symbolTag = "[object Symbol]";
	/** Used to match leading and trailing whitespace. */
	var reTrim = /^\s+|\s+$/g;
	/** Used to detect bad signed hexadecimal string values. */
	var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
	/** Used to detect binary string values. */
	var reIsBinary = /^0b[01]+$/i;
	/** Used to detect octal string values. */
	var reIsOctal = /^0o[0-7]+$/i;
	/** Built-in method references without a dependency on `root`. */
	var freeParseInt = parseInt;
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/**
	* Checks if `value` is an integer.
	*
	* **Note:** This method is based on
	* [`Number.isInteger`](https://mdn.io/Number/isInteger).
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is an integer, else `false`.
	* @example
	*
	* _.isInteger(3);
	* // => true
	*
	* _.isInteger(Number.MIN_VALUE);
	* // => false
	*
	* _.isInteger(Infinity);
	* // => false
	*
	* _.isInteger('3');
	* // => false
	*/
	function isInteger(value) {
		return typeof value == "number" && value == toInteger(value);
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
	* Checks if `value` is classified as a `Symbol` primitive or object.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
	* @example
	*
	* _.isSymbol(Symbol.iterator);
	* // => true
	*
	* _.isSymbol('abc');
	* // => false
	*/
	function isSymbol(value) {
		return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
	}
	/**
	* Converts `value` to a finite number.
	*
	* @static
	* @memberOf _
	* @since 4.12.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted number.
	* @example
	*
	* _.toFinite(3.2);
	* // => 3.2
	*
	* _.toFinite(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toFinite(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toFinite('3.2');
	* // => 3.2
	*/
	function toFinite(value) {
		if (!value) return value === 0 ? value : 0;
		value = toNumber(value);
		if (value === INFINITY || value === -INFINITY) return (value < 0 ? -1 : 1) * MAX_INTEGER;
		return value === value ? value : 0;
	}
	/**
	* Converts `value` to an integer.
	*
	* **Note:** This method is loosely based on
	* [`ToInteger`](http://www.ecma-international.org/ecma-262/7.0/#sec-tointeger).
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted integer.
	* @example
	*
	* _.toInteger(3.2);
	* // => 3
	*
	* _.toInteger(Number.MIN_VALUE);
	* // => 0
	*
	* _.toInteger(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toInteger('3.2');
	* // => 3
	*/
	function toInteger(value) {
		var result = toFinite(value), remainder = result % 1;
		return result === result ? remainder ? result - remainder : result : 0;
	}
	/**
	* Converts `value` to a number.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to process.
	* @returns {number} Returns the number.
	* @example
	*
	* _.toNumber(3.2);
	* // => 3.2
	*
	* _.toNumber(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toNumber(Infinity);
	* // => Infinity
	*
	* _.toNumber('3.2');
	* // => 3.2
	*/
	function toNumber(value) {
		if (typeof value == "number") return value;
		if (isSymbol(value)) return NAN;
		if (isObject(value)) {
			var other = typeof value.valueOf == "function" ? value.valueOf() : value;
			value = isObject(other) ? other + "" : other;
		}
		if (typeof value != "string") return value === 0 ? value : +value;
		value = value.replace(reTrim, "");
		var isBinary = reIsBinary.test(value);
		return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
	}
	module.exports = isInteger;
}));
//#endregion
//#region node_modules/lodash.isnumber/index.js
var require_lodash_isnumber = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash 3.0.3 (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright 2012-2016 The Dojo Foundation <http://dojofoundation.org/>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright 2009-2016 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	* Available under MIT license <https://lodash.com/license>
	*/
	/** `Object#toString` result references. */
	var numberTag = "[object Number]";
	/**
	* Used to resolve the [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/**
	* Checks if `value` is object-like. A value is object-like if it's not `null`
	* and has a `typeof` result of "object".
	*
	* @static
	* @memberOf _
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
	* Checks if `value` is classified as a `Number` primitive or object.
	*
	* **Note:** To exclude `Infinity`, `-Infinity`, and `NaN`, which are classified
	* as numbers, use the `_.isFinite` method.
	*
	* @static
	* @memberOf _
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is correctly classified, else `false`.
	* @example
	*
	* _.isNumber(3);
	* // => true
	*
	* _.isNumber(Number.MIN_VALUE);
	* // => true
	*
	* _.isNumber(Infinity);
	* // => true
	*
	* _.isNumber('3');
	* // => false
	*/
	function isNumber(value) {
		return typeof value == "number" || isObjectLike(value) && objectToString.call(value) == numberTag;
	}
	module.exports = isNumber;
}));
//#endregion
//#region node_modules/lodash.isplainobject/index.js
var require_lodash_isplainobject = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** `Object#toString` result references. */
	var objectTag = "[object Object]";
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
	/** Used for built-in method references. */
	var funcProto = Function.prototype, objectProto = Object.prototype;
	/** Used to resolve the decompiled source of functions. */
	var funcToString = funcProto.toString;
	/** Used to check objects for own properties. */
	var hasOwnProperty = objectProto.hasOwnProperty;
	/** Used to infer the `Object` constructor. */
	var objectCtorString = funcToString.call(Object);
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = objectProto.toString;
	/** Built-in value references. */
	var getPrototype = overArg(Object.getPrototypeOf, Object);
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
	* Checks if `value` is a plain object, that is, an object created by the
	* `Object` constructor or one with a `[[Prototype]]` of `null`.
	*
	* @static
	* @memberOf _
	* @since 0.8.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a plain object, else `false`.
	* @example
	*
	* function Foo() {
	*   this.a = 1;
	* }
	*
	* _.isPlainObject(new Foo);
	* // => false
	*
	* _.isPlainObject([1, 2, 3]);
	* // => false
	*
	* _.isPlainObject({ 'x': 0, 'y': 0 });
	* // => true
	*
	* _.isPlainObject(Object.create(null));
	* // => true
	*/
	function isPlainObject(value) {
		if (!isObjectLike(value) || objectToString.call(value) != objectTag || isHostObject(value)) return false;
		var proto = getPrototype(value);
		if (proto === null) return true;
		var Ctor = hasOwnProperty.call(proto, "constructor") && proto.constructor;
		return typeof Ctor == "function" && Ctor instanceof Ctor && funcToString.call(Ctor) == objectCtorString;
	}
	module.exports = isPlainObject;
}));
//#endregion
//#region node_modules/lodash.isstring/index.js
var require_lodash_isstring = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash 4.0.1 (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright 2012-2016 The Dojo Foundation <http://dojofoundation.org/>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright 2009-2016 Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	* Available under MIT license <https://lodash.com/license>
	*/
	/** `Object#toString` result references. */
	var stringTag = "[object String]";
	/**
	* Used to resolve the [`toStringTag`](http://ecma-international.org/ecma-262/6.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/**
	* Checks if `value` is classified as an `Array` object.
	*
	* @static
	* @memberOf _
	* @type Function
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is correctly classified, else `false`.
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
	* Checks if `value` is object-like. A value is object-like if it's not `null`
	* and has a `typeof` result of "object".
	*
	* @static
	* @memberOf _
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
	* Checks if `value` is classified as a `String` primitive or object.
	*
	* @static
	* @memberOf _
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is correctly classified, else `false`.
	* @example
	*
	* _.isString('abc');
	* // => true
	*
	* _.isString(1);
	* // => false
	*/
	function isString(value) {
		return typeof value == "string" || !isArray(value) && isObjectLike(value) && objectToString.call(value) == stringTag;
	}
	module.exports = isString;
}));
//#endregion
//#region node_modules/lodash.once/index.js
var require_lodash_once = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	/**
	* lodash (Custom Build) <https://lodash.com/>
	* Build: `lodash modularize exports="npm" -o ./`
	* Copyright jQuery Foundation and other contributors <https://jquery.org/>
	* Released under MIT license <https://lodash.com/license>
	* Based on Underscore.js 1.8.3 <http://underscorejs.org/LICENSE>
	* Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors
	*/
	/** Used as the `TypeError` message for "Functions" methods. */
	var FUNC_ERROR_TEXT = "Expected a function";
	/** Used as references for various `Number` constants. */
	var INFINITY = Infinity, MAX_INTEGER = 17976931348623157e292, NAN = NaN;
	/** `Object#toString` result references. */
	var symbolTag = "[object Symbol]";
	/** Used to match leading and trailing whitespace. */
	var reTrim = /^\s+|\s+$/g;
	/** Used to detect bad signed hexadecimal string values. */
	var reIsBadHex = /^[-+]0x[0-9a-f]+$/i;
	/** Used to detect binary string values. */
	var reIsBinary = /^0b[01]+$/i;
	/** Used to detect octal string values. */
	var reIsOctal = /^0o[0-7]+$/i;
	/** Built-in method references without a dependency on `root`. */
	var freeParseInt = parseInt;
	/**
	* Used to resolve the
	* [`toStringTag`](http://ecma-international.org/ecma-262/7.0/#sec-object.prototype.tostring)
	* of values.
	*/
	var objectToString = Object.prototype.toString;
	/**
	* Creates a function that invokes `func`, with the `this` binding and arguments
	* of the created function, while it's called less than `n` times. Subsequent
	* calls to the created function return the result of the last `func` invocation.
	*
	* @static
	* @memberOf _
	* @since 3.0.0
	* @category Function
	* @param {number} n The number of calls at which `func` is no longer invoked.
	* @param {Function} func The function to restrict.
	* @returns {Function} Returns the new restricted function.
	* @example
	*
	* jQuery(element).on('click', _.before(5, addContactToList));
	* // => Allows adding up to 4 contacts to the list.
	*/
	function before(n, func) {
		var result;
		if (typeof func != "function") throw new TypeError(FUNC_ERROR_TEXT);
		n = toInteger(n);
		return function() {
			if (--n > 0) result = func.apply(this, arguments);
			if (n <= 1) func = void 0;
			return result;
		};
	}
	/**
	* Creates a function that is restricted to invoking `func` once. Repeat calls
	* to the function return the value of the first invocation. The `func` is
	* invoked with the `this` binding and arguments of the created function.
	*
	* @static
	* @memberOf _
	* @since 0.1.0
	* @category Function
	* @param {Function} func The function to restrict.
	* @returns {Function} Returns the new restricted function.
	* @example
	*
	* var initialize = _.once(createApplication);
	* initialize();
	* initialize();
	* // => `createApplication` is invoked once
	*/
	function once(func) {
		return before(2, func);
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
	* Checks if `value` is classified as a `Symbol` primitive or object.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to check.
	* @returns {boolean} Returns `true` if `value` is a symbol, else `false`.
	* @example
	*
	* _.isSymbol(Symbol.iterator);
	* // => true
	*
	* _.isSymbol('abc');
	* // => false
	*/
	function isSymbol(value) {
		return typeof value == "symbol" || isObjectLike(value) && objectToString.call(value) == symbolTag;
	}
	/**
	* Converts `value` to a finite number.
	*
	* @static
	* @memberOf _
	* @since 4.12.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted number.
	* @example
	*
	* _.toFinite(3.2);
	* // => 3.2
	*
	* _.toFinite(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toFinite(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toFinite('3.2');
	* // => 3.2
	*/
	function toFinite(value) {
		if (!value) return value === 0 ? value : 0;
		value = toNumber(value);
		if (value === INFINITY || value === -INFINITY) return (value < 0 ? -1 : 1) * MAX_INTEGER;
		return value === value ? value : 0;
	}
	/**
	* Converts `value` to an integer.
	*
	* **Note:** This method is loosely based on
	* [`ToInteger`](http://www.ecma-international.org/ecma-262/7.0/#sec-tointeger).
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to convert.
	* @returns {number} Returns the converted integer.
	* @example
	*
	* _.toInteger(3.2);
	* // => 3
	*
	* _.toInteger(Number.MIN_VALUE);
	* // => 0
	*
	* _.toInteger(Infinity);
	* // => 1.7976931348623157e+308
	*
	* _.toInteger('3.2');
	* // => 3
	*/
	function toInteger(value) {
		var result = toFinite(value), remainder = result % 1;
		return result === result ? remainder ? result - remainder : result : 0;
	}
	/**
	* Converts `value` to a number.
	*
	* @static
	* @memberOf _
	* @since 4.0.0
	* @category Lang
	* @param {*} value The value to process.
	* @returns {number} Returns the number.
	* @example
	*
	* _.toNumber(3.2);
	* // => 3.2
	*
	* _.toNumber(Number.MIN_VALUE);
	* // => 5e-324
	*
	* _.toNumber(Infinity);
	* // => Infinity
	*
	* _.toNumber('3.2');
	* // => 3.2
	*/
	function toNumber(value) {
		if (typeof value == "number") return value;
		if (isSymbol(value)) return NAN;
		if (isObject(value)) {
			var other = typeof value.valueOf == "function" ? value.valueOf() : value;
			value = isObject(other) ? other + "" : other;
		}
		if (typeof value != "string") return value === 0 ? value : +value;
		value = value.replace(reTrim, "");
		var isBinary = reIsBinary.test(value);
		return isBinary || reIsOctal.test(value) ? freeParseInt(value.slice(2), isBinary ? 2 : 8) : reIsBadHex.test(value) ? NAN : +value;
	}
	module.exports = once;
}));
//#endregion
//#region node_modules/jsonwebtoken/sign.js
var require_sign = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	const timespan = require_timespan();
	const PS_SUPPORTED = require_psSupported();
	const validateAsymmetricKey = require_validateAsymmetricKey();
	const jws = require_jws();
	const includes = require_lodash_includes();
	const isBoolean = require_lodash_isboolean();
	const isInteger = require_lodash_isinteger();
	const isNumber = require_lodash_isnumber();
	const isPlainObject = require_lodash_isplainobject();
	const isString = require_lodash_isstring();
	const once = require_lodash_once();
	const { KeyObject, createSecretKey, createPrivateKey } = __require("crypto");
	const SUPPORTED_ALGS = [
		"RS256",
		"RS384",
		"RS512",
		"ES256",
		"ES384",
		"ES512",
		"HS256",
		"HS384",
		"HS512",
		"none"
	];
	if (PS_SUPPORTED) SUPPORTED_ALGS.splice(3, 0, "PS256", "PS384", "PS512");
	const sign_options_schema = {
		expiresIn: {
			isValid: function(value) {
				return isInteger(value) || isString(value) && value;
			},
			message: "\"expiresIn\" should be a number of seconds or string representing a timespan"
		},
		notBefore: {
			isValid: function(value) {
				return isInteger(value) || isString(value) && value;
			},
			message: "\"notBefore\" should be a number of seconds or string representing a timespan"
		},
		audience: {
			isValid: function(value) {
				return isString(value) || Array.isArray(value);
			},
			message: "\"audience\" must be a string or array"
		},
		algorithm: {
			isValid: includes.bind(null, SUPPORTED_ALGS),
			message: "\"algorithm\" must be a valid string enum value"
		},
		header: {
			isValid: isPlainObject,
			message: "\"header\" must be an object"
		},
		encoding: {
			isValid: isString,
			message: "\"encoding\" must be a string"
		},
		issuer: {
			isValid: isString,
			message: "\"issuer\" must be a string"
		},
		subject: {
			isValid: isString,
			message: "\"subject\" must be a string"
		},
		jwtid: {
			isValid: isString,
			message: "\"jwtid\" must be a string"
		},
		noTimestamp: {
			isValid: isBoolean,
			message: "\"noTimestamp\" must be a boolean"
		},
		keyid: {
			isValid: isString,
			message: "\"keyid\" must be a string"
		},
		mutatePayload: {
			isValid: isBoolean,
			message: "\"mutatePayload\" must be a boolean"
		},
		allowInsecureKeySizes: {
			isValid: isBoolean,
			message: "\"allowInsecureKeySizes\" must be a boolean"
		},
		allowInvalidAsymmetricKeyTypes: {
			isValid: isBoolean,
			message: "\"allowInvalidAsymmetricKeyTypes\" must be a boolean"
		}
	};
	const registered_claims_schema = {
		iat: {
			isValid: isNumber,
			message: "\"iat\" should be a number of seconds"
		},
		exp: {
			isValid: isNumber,
			message: "\"exp\" should be a number of seconds"
		},
		nbf: {
			isValid: isNumber,
			message: "\"nbf\" should be a number of seconds"
		}
	};
	function validate(schema, allowUnknown, object, parameterName) {
		if (!isPlainObject(object)) throw new Error("Expected \"" + parameterName + "\" to be a plain object.");
		Object.keys(object).forEach(function(key) {
			const validator = schema[key];
			if (!validator) {
				if (!allowUnknown) throw new Error("\"" + key + "\" is not allowed in \"" + parameterName + "\"");
				return;
			}
			if (!validator.isValid(object[key])) throw new Error(validator.message);
		});
	}
	function validateOptions(options) {
		return validate(sign_options_schema, false, options, "options");
	}
	function validatePayload(payload) {
		return validate(registered_claims_schema, true, payload, "payload");
	}
	const options_to_payload = {
		"audience": "aud",
		"issuer": "iss",
		"subject": "sub",
		"jwtid": "jti"
	};
	const options_for_objects = [
		"expiresIn",
		"notBefore",
		"noTimestamp",
		"audience",
		"issuer",
		"subject",
		"jwtid"
	];
	module.exports = function(payload, secretOrPrivateKey, options, callback) {
		if (typeof options === "function") {
			callback = options;
			options = {};
		} else options = options || {};
		const isObjectPayload = typeof payload === "object" && !Buffer.isBuffer(payload);
		const header = Object.assign({
			alg: options.algorithm || "HS256",
			typ: isObjectPayload ? "JWT" : void 0,
			kid: options.keyid
		}, options.header);
		function failure(err) {
			if (callback) return callback(err);
			throw err;
		}
		if (!secretOrPrivateKey && options.algorithm !== "none") return failure(/* @__PURE__ */ new Error("secretOrPrivateKey must have a value"));
		if (secretOrPrivateKey != null && !(secretOrPrivateKey instanceof KeyObject)) try {
			secretOrPrivateKey = createPrivateKey(secretOrPrivateKey);
		} catch (_) {
			try {
				secretOrPrivateKey = createSecretKey(typeof secretOrPrivateKey === "string" ? Buffer.from(secretOrPrivateKey) : secretOrPrivateKey);
			} catch (_) {
				return failure(/* @__PURE__ */ new Error("secretOrPrivateKey is not valid key material"));
			}
		}
		if (header.alg.startsWith("HS") && secretOrPrivateKey.type !== "secret") return failure(/* @__PURE__ */ new Error(`secretOrPrivateKey must be a symmetric key when using ${header.alg}`));
		else if (/^(?:RS|PS|ES)/.test(header.alg)) {
			if (secretOrPrivateKey.type !== "private") return failure(/* @__PURE__ */ new Error(`secretOrPrivateKey must be an asymmetric key when using ${header.alg}`));
			if (!options.allowInsecureKeySizes && !header.alg.startsWith("ES") && secretOrPrivateKey.asymmetricKeyDetails !== void 0 && secretOrPrivateKey.asymmetricKeyDetails.modulusLength < 2048) return failure(/* @__PURE__ */ new Error(`secretOrPrivateKey has a minimum key size of 2048 bits for ${header.alg}`));
		}
		if (typeof payload === "undefined") return failure(/* @__PURE__ */ new Error("payload is required"));
		else if (isObjectPayload) {
			try {
				validatePayload(payload);
			} catch (error) {
				return failure(error);
			}
			if (!options.mutatePayload) payload = Object.assign({}, payload);
		} else {
			const invalid_options = options_for_objects.filter(function(opt) {
				return typeof options[opt] !== "undefined";
			});
			if (invalid_options.length > 0) return failure(/* @__PURE__ */ new Error("invalid " + invalid_options.join(",") + " option for " + typeof payload + " payload"));
		}
		if (typeof payload.exp !== "undefined" && typeof options.expiresIn !== "undefined") return failure(/* @__PURE__ */ new Error("Bad \"options.expiresIn\" option the payload already has an \"exp\" property."));
		if (typeof payload.nbf !== "undefined" && typeof options.notBefore !== "undefined") return failure(/* @__PURE__ */ new Error("Bad \"options.notBefore\" option the payload already has an \"nbf\" property."));
		try {
			validateOptions(options);
		} catch (error) {
			return failure(error);
		}
		if (!options.allowInvalidAsymmetricKeyTypes) try {
			validateAsymmetricKey(header.alg, secretOrPrivateKey);
		} catch (error) {
			return failure(error);
		}
		const timestamp = payload.iat || Math.floor(Date.now() / 1e3);
		if (options.noTimestamp) delete payload.iat;
		else if (isObjectPayload) payload.iat = timestamp;
		if (typeof options.notBefore !== "undefined") {
			try {
				payload.nbf = timespan(options.notBefore, timestamp);
			} catch (err) {
				return failure(err);
			}
			if (typeof payload.nbf === "undefined") return failure(/* @__PURE__ */ new Error("\"notBefore\" should be a number of seconds or string representing a timespan eg: \"1d\", \"20h\", 60"));
		}
		if (typeof options.expiresIn !== "undefined" && typeof payload === "object") {
			try {
				payload.exp = timespan(options.expiresIn, timestamp);
			} catch (err) {
				return failure(err);
			}
			if (typeof payload.exp === "undefined") return failure(/* @__PURE__ */ new Error("\"expiresIn\" should be a number of seconds or string representing a timespan eg: \"1d\", \"20h\", 60"));
		}
		Object.keys(options_to_payload).forEach(function(key) {
			const claim = options_to_payload[key];
			if (typeof options[key] !== "undefined") {
				if (typeof payload[claim] !== "undefined") return failure(/* @__PURE__ */ new Error("Bad \"options." + key + "\" option. The payload already has an \"" + claim + "\" property."));
				payload[claim] = options[key];
			}
		});
		const encoding = options.encoding || "utf8";
		if (typeof callback === "function") {
			callback = callback && once(callback);
			jws.createSign({
				header,
				privateKey: secretOrPrivateKey,
				payload,
				encoding
			}).once("error", callback).once("done", function(signature) {
				if (!options.allowInsecureKeySizes && /^(?:RS|PS)/.test(header.alg) && signature.length < 256) return callback(/* @__PURE__ */ new Error(`secretOrPrivateKey has a minimum key size of 2048 bits for ${header.alg}`));
				callback(null, signature);
			});
		} else {
			let signature = jws.sign({
				header,
				payload,
				secret: secretOrPrivateKey,
				encoding
			});
			if (!options.allowInsecureKeySizes && /^(?:RS|PS)/.test(header.alg) && signature.length < 256) throw new Error(`secretOrPrivateKey has a minimum key size of 2048 bits for ${header.alg}`);
			return signature;
		}
	};
}));
//#endregion
//#region node_modules/jsonwebtoken/index.js
var require_jsonwebtoken = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		decode: require_decode(),
		verify: require_verify(),
		sign: require_sign(),
		JsonWebTokenError: require_JsonWebTokenError(),
		NotBeforeError: require_NotBeforeError(),
		TokenExpiredError: require_TokenExpiredError()
	};
}));
//#endregion
export { require_jsonwebtoken as t };
