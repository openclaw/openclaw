import { a as __toCommonJS, n as __esmMin, r as __exportAll, t as __commonJSMin } from "./chunk-CNf5ZN-e.js";
import { C as memoizeIdentityProvider, S as isIdentityExpired, Z as setCredentialFeature, b as doesIdentityRequireRefresh, k as normalizeProvider, n as init_client, y as init_dist_es } from "./client-Du4bZd9P.js";
import { A as protocols_exports$1, B as HttpInterceptingShapeSerializer, C as TypeRegistry, Cn as parseEpochTimestamp, En as expectUnion, H as HttpInterceptingShapeDeserializer, Hn as getSmithyContext, In as deref, K as determineTimestampFormat, Mn as fromUtf8, Pn as fromBase64, Q as HttpBindingProtocol, T as NormalizedSchema, Tn as parseRfc7231DateTime, W as FromStringShapeDeserializer, X as RpcProtocol, _n as _parseEpochTimestamp, a as getValueFromTextNode, an as ProviderError, ct as collectBody, dt as init_serde, et as HttpResponse, ft as serde_exports, gn as nv, h as decorateServiceException, it as SerdeContext, jn as toBase64, k as init_protocols$1, kn as toUtf8, mn as NumericValue, n as init_client$1, nt as HttpRequest, ot as extendedEncodeURIComponent, t as client_exports, ut as generateIdempotencyToken, wn as parseRfc3339DateTimeWithOffset, x as init_schema, xn as dateToUtcString, yn as LazyJsonString, zt as init_config } from "./client-hKay7jF9.js";
//#region node_modules/@smithy/core/dist-es/submodules/cbor/cbor-types.js
function alloc(size) {
	return typeof Buffer !== "undefined" ? Buffer.alloc(size) : new Uint8Array(size);
}
function tag(data) {
	data[tagSymbol] = true;
	return data;
}
var tagSymbol;
var init_cbor_types = __esmMin((() => {
	tagSymbol = Symbol("@smithy/core/cbor::tagSymbol");
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/cbor-decode.js
function setPayload(bytes) {
	payload = bytes;
	dataView$1 = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
}
function decode(at, to) {
	if (at >= to) throw new Error("unexpected end of (decode) payload.");
	const major = (payload[at] & 224) >> 5;
	const minor = payload[at] & 31;
	switch (major) {
		case 0:
		case 1:
		case 6:
			let unsignedInt;
			let offset;
			if (minor < 24) {
				unsignedInt = minor;
				offset = 1;
			} else switch (minor) {
				case 24:
				case 25:
				case 26:
				case 27:
					const countLength = minorValueToArgumentLength[minor];
					const countOffset = countLength + 1;
					offset = countOffset;
					if (to - at < countOffset) throw new Error(`countLength ${countLength} greater than remaining buf len.`);
					const countIndex = at + 1;
					if (countLength === 1) unsignedInt = payload[countIndex];
					else if (countLength === 2) unsignedInt = dataView$1.getUint16(countIndex);
					else if (countLength === 4) unsignedInt = dataView$1.getUint32(countIndex);
					else unsignedInt = dataView$1.getBigUint64(countIndex);
					break;
				default: throw new Error(`unexpected minor value ${minor}.`);
			}
			if (major === 0) {
				_offset = offset;
				return castBigInt(unsignedInt);
			} else if (major === 1) {
				let negativeInt;
				if (typeof unsignedInt === "bigint") negativeInt = BigInt(-1) - unsignedInt;
				else negativeInt = -1 - unsignedInt;
				_offset = offset;
				return castBigInt(negativeInt);
			} else if (minor === 2 || minor === 3) {
				const length = decodeCount(at + offset, to);
				let b = BigInt(0);
				const start = at + offset + _offset;
				for (let i = start; i < start + length; ++i) b = b << BigInt(8) | BigInt(payload[i]);
				_offset = offset + _offset + length;
				return minor === 3 ? -b - BigInt(1) : b;
			} else if (minor === 4) {
				const [exponent, mantissa] = decode(at + offset, to);
				const normalizer = mantissa < 0 ? -1 : 1;
				const mantissaStr = "0".repeat(Math.abs(exponent) + 1) + String(BigInt(normalizer) * BigInt(mantissa));
				let numericString;
				const sign = mantissa < 0 ? "-" : "";
				numericString = exponent === 0 ? mantissaStr : mantissaStr.slice(0, mantissaStr.length + exponent) + "." + mantissaStr.slice(exponent);
				numericString = numericString.replace(/^0+/g, "");
				if (numericString === "") numericString = "0";
				if (numericString[0] === ".") numericString = "0" + numericString;
				numericString = sign + numericString;
				_offset = offset + _offset;
				return nv(numericString);
			} else {
				const value = decode(at + offset, to);
				_offset = offset + _offset;
				return tag({
					tag: castBigInt(unsignedInt),
					value
				});
			}
		case 3:
		case 5:
		case 4:
		case 2: if (minor === 31) switch (major) {
			case 3: return decodeUtf8StringIndefinite(at, to);
			case 5: return decodeMapIndefinite(at, to);
			case 4: return decodeListIndefinite(at, to);
			case 2: return decodeUnstructuredByteStringIndefinite(at, to);
		}
		else switch (major) {
			case 3: return decodeUtf8String(at, to);
			case 5: return decodeMap(at, to);
			case 4: return decodeList(at, to);
			case 2: return decodeUnstructuredByteString(at, to);
		}
		default: return decodeSpecial(at, to);
	}
}
function bytesToUtf8(bytes, at, to) {
	if (USE_BUFFER$1 && bytes.constructor?.name === "Buffer") return bytes.toString("utf-8", at, to);
	if (textDecoder) return textDecoder.decode(bytes.subarray(at, to));
	return toUtf8(bytes.subarray(at, to));
}
function demote(bigInteger) {
	const num = Number(bigInteger);
	if (num < Number.MIN_SAFE_INTEGER || Number.MAX_SAFE_INTEGER < num) console.warn(/* @__PURE__ */ new Error(`@smithy/core/cbor - truncating BigInt(${bigInteger}) to ${num} with loss of precision.`));
	return num;
}
function bytesToFloat16(a, b) {
	const sign = a >> 7;
	const exponent = (a & 124) >> 2;
	const fraction = (a & 3) << 8 | b;
	const scalar = sign === 0 ? 1 : -1;
	let exponentComponent;
	let summation;
	if (exponent === 0) if (fraction === 0) return 0;
	else {
		exponentComponent = Math.pow(2, -14);
		summation = 0;
	}
	else if (exponent === 31) if (fraction === 0) return scalar * Infinity;
	else return NaN;
	else {
		exponentComponent = Math.pow(2, exponent - 15);
		summation = 1;
	}
	summation += fraction / 1024;
	return scalar * (exponentComponent * summation);
}
function decodeCount(at, to) {
	const minor = payload[at] & 31;
	if (minor < 24) {
		_offset = 1;
		return minor;
	}
	if (minor === 24 || minor === 25 || minor === 26 || minor === 27) {
		const countLength = minorValueToArgumentLength[minor];
		_offset = countLength + 1;
		if (to - at < _offset) throw new Error(`countLength ${countLength} greater than remaining buf len.`);
		const countIndex = at + 1;
		if (countLength === 1) return payload[countIndex];
		else if (countLength === 2) return dataView$1.getUint16(countIndex);
		else if (countLength === 4) return dataView$1.getUint32(countIndex);
		return demote(dataView$1.getBigUint64(countIndex));
	}
	throw new Error(`unexpected minor value ${minor}.`);
}
function decodeUtf8String(at, to) {
	const length = decodeCount(at, to);
	const offset = _offset;
	at += offset;
	if (to - at < length) throw new Error(`string len ${length} greater than remaining buf len.`);
	const value = bytesToUtf8(payload, at, at + length);
	_offset = offset + length;
	return value;
}
function decodeUtf8StringIndefinite(at, to) {
	at += 1;
	const vector = [];
	for (const base = at; at < to;) {
		if (payload[at] === 255) {
			const data = alloc(vector.length);
			data.set(vector, 0);
			_offset = at - base + 2;
			return bytesToUtf8(data, 0, data.length);
		}
		const major = (payload[at] & 224) >> 5;
		const minor = payload[at] & 31;
		if (major !== 3) throw new Error(`unexpected major type ${major} in indefinite string.`);
		if (minor === 31) throw new Error("nested indefinite string.");
		const bytes = decodeUnstructuredByteString(at, to);
		at += _offset;
		for (let i = 0; i < bytes.length; ++i) vector.push(bytes[i]);
	}
	throw new Error("expected break marker.");
}
function decodeUnstructuredByteString(at, to) {
	const length = decodeCount(at, to);
	const offset = _offset;
	at += offset;
	if (to - at < length) throw new Error(`unstructured byte string len ${length} greater than remaining buf len.`);
	const value = payload.subarray(at, at + length);
	_offset = offset + length;
	return value;
}
function decodeUnstructuredByteStringIndefinite(at, to) {
	at += 1;
	const vector = [];
	for (const base = at; at < to;) {
		if (payload[at] === 255) {
			const data = alloc(vector.length);
			data.set(vector, 0);
			_offset = at - base + 2;
			return data;
		}
		const major = (payload[at] & 224) >> 5;
		const minor = payload[at] & 31;
		if (major !== 2) throw new Error(`unexpected major type ${major} in indefinite string.`);
		if (minor === 31) throw new Error("nested indefinite string.");
		const bytes = decodeUnstructuredByteString(at, to);
		at += _offset;
		for (let i = 0; i < bytes.length; ++i) vector.push(bytes[i]);
	}
	throw new Error("expected break marker.");
}
function decodeList(at, to) {
	const listDataLength = decodeCount(at, to);
	const offset = _offset;
	at += offset;
	const base = at;
	const list = Array(listDataLength);
	for (let i = 0; i < listDataLength; ++i) {
		const item = decode(at, to);
		const itemOffset = _offset;
		list[i] = item;
		at += itemOffset;
	}
	_offset = offset + (at - base);
	return list;
}
function decodeListIndefinite(at, to) {
	at += 1;
	const list = [];
	for (const base = at; at < to;) {
		if (payload[at] === 255) {
			_offset = at - base + 2;
			return list;
		}
		const item = decode(at, to);
		at += _offset;
		list.push(item);
	}
	throw new Error("expected break marker.");
}
function decodeMap(at, to) {
	const mapDataLength = decodeCount(at, to);
	const offset = _offset;
	at += offset;
	const base = at;
	const map = {};
	for (let i = 0; i < mapDataLength; ++i) {
		if (at >= to) throw new Error("unexpected end of map payload.");
		const major = (payload[at] & 224) >> 5;
		if (major !== 3) throw new Error(`unexpected major type ${major} for map key at index ${at}.`);
		const key = decode(at, to);
		at += _offset;
		const value = decode(at, to);
		at += _offset;
		map[key] = value;
	}
	_offset = offset + (at - base);
	return map;
}
function decodeMapIndefinite(at, to) {
	at += 1;
	const base = at;
	const map = {};
	for (; at < to;) {
		if (at >= to) throw new Error("unexpected end of map payload.");
		if (payload[at] === 255) {
			_offset = at - base + 2;
			return map;
		}
		const major = (payload[at] & 224) >> 5;
		if (major !== 3) throw new Error(`unexpected major type ${major} for map key.`);
		const key = decode(at, to);
		at += _offset;
		const value = decode(at, to);
		at += _offset;
		map[key] = value;
	}
	throw new Error("expected break marker.");
}
function decodeSpecial(at, to) {
	const minor = payload[at] & 31;
	switch (minor) {
		case 21:
		case 20:
			_offset = 1;
			return minor === 21;
		case 22:
			_offset = 1;
			return null;
		case 23:
			_offset = 1;
			return null;
		case 25:
			if (to - at < 3) throw new Error("incomplete float16 at end of buf.");
			_offset = 3;
			return bytesToFloat16(payload[at + 1], payload[at + 2]);
		case 26:
			if (to - at < 5) throw new Error("incomplete float32 at end of buf.");
			_offset = 5;
			return dataView$1.getFloat32(at + 1);
		case 27:
			if (to - at < 9) throw new Error("incomplete float64 at end of buf.");
			_offset = 9;
			return dataView$1.getFloat64(at + 1);
		default: throw new Error(`unexpected minor value ${minor}.`);
	}
}
function castBigInt(bigInt) {
	if (typeof bigInt === "number") return bigInt;
	const num = Number(bigInt);
	if (Number.MIN_SAFE_INTEGER <= num && num <= Number.MAX_SAFE_INTEGER) return num;
	return bigInt;
}
var USE_TEXT_DECODER, USE_BUFFER$1, payload, dataView$1, textDecoder, _offset, minorValueToArgumentLength;
var init_cbor_decode = __esmMin((() => {
	init_serde();
	init_cbor_types();
	USE_TEXT_DECODER = typeof TextDecoder !== "undefined";
	USE_BUFFER$1 = typeof Buffer !== "undefined";
	payload = alloc(0);
	dataView$1 = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	textDecoder = USE_TEXT_DECODER ? new TextDecoder() : null;
	_offset = 0;
	minorValueToArgumentLength = {
		[24]: 1,
		[25]: 2,
		[26]: 4,
		[27]: 8
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/cbor-encode.js
function ensureSpace(bytes) {
	if (data.byteLength - cursor < bytes) if (cursor < 16e6) resize(Math.max(data.byteLength * 4, data.byteLength + bytes));
	else resize(data.byteLength + bytes + 16e6);
}
function toUint8Array() {
	const out = alloc(cursor);
	out.set(data.subarray(0, cursor), 0);
	cursor = 0;
	return out;
}
function resize(size) {
	const old = data;
	data = alloc(size);
	if (old) if (old.copy) old.copy(data, 0, 0, old.byteLength);
	else data.set(old, 0);
	dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function encodeHeader(major, value) {
	if (value < 24) data[cursor++] = major << 5 | value;
	else if (value < 256) {
		data[cursor++] = major << 5 | 24;
		data[cursor++] = value;
	} else if (value < 65536) {
		data[cursor++] = major << 5 | 25;
		dataView.setUint16(cursor, value);
		cursor += 2;
	} else if (value < 2 ** 32) {
		data[cursor++] = major << 5 | 26;
		dataView.setUint32(cursor, value);
		cursor += 4;
	} else {
		data[cursor++] = major << 5 | 27;
		dataView.setBigUint64(cursor, typeof value === "bigint" ? value : BigInt(value));
		cursor += 8;
	}
}
function encode(_input) {
	const encodeStack = [_input];
	while (encodeStack.length) {
		const input = encodeStack.pop();
		ensureSpace(typeof input === "string" ? input.length * 4 : 64);
		if (typeof input === "string") {
			if (USE_BUFFER) {
				encodeHeader(3, Buffer.byteLength(input));
				cursor += data.write(input, cursor);
			} else {
				const bytes = fromUtf8(input);
				encodeHeader(3, bytes.byteLength);
				data.set(bytes, cursor);
				cursor += bytes.byteLength;
			}
			continue;
		} else if (typeof input === "number") {
			if (Number.isInteger(input)) {
				const nonNegative = input >= 0;
				const major = nonNegative ? 0 : 1;
				const value = nonNegative ? input : -input - 1;
				if (value < 24) data[cursor++] = major << 5 | value;
				else if (value < 256) {
					data[cursor++] = major << 5 | 24;
					data[cursor++] = value;
				} else if (value < 65536) {
					data[cursor++] = major << 5 | 25;
					data[cursor++] = value >> 8;
					data[cursor++] = value;
				} else if (value < 4294967296) {
					data[cursor++] = major << 5 | 26;
					dataView.setUint32(cursor, value);
					cursor += 4;
				} else {
					data[cursor++] = major << 5 | 27;
					dataView.setBigUint64(cursor, BigInt(value));
					cursor += 8;
				}
				continue;
			}
			data[cursor++] = 251;
			dataView.setFloat64(cursor, input);
			cursor += 8;
			continue;
		} else if (typeof input === "bigint") {
			const nonNegative = input >= 0;
			const major = nonNegative ? 0 : 1;
			const value = nonNegative ? input : -input - BigInt(1);
			const n = Number(value);
			if (n < 24) data[cursor++] = major << 5 | n;
			else if (n < 256) {
				data[cursor++] = major << 5 | 24;
				data[cursor++] = n;
			} else if (n < 65536) {
				data[cursor++] = major << 5 | 25;
				data[cursor++] = n >> 8;
				data[cursor++] = n & 255;
			} else if (n < 4294967296) {
				data[cursor++] = major << 5 | 26;
				dataView.setUint32(cursor, n);
				cursor += 4;
			} else if (value < BigInt("18446744073709551616")) {
				data[cursor++] = major << 5 | 27;
				dataView.setBigUint64(cursor, value);
				cursor += 8;
			} else {
				const binaryBigInt = value.toString(2);
				const bigIntBytes = new Uint8Array(Math.ceil(binaryBigInt.length / 8));
				let b = value;
				let i = 0;
				while (bigIntBytes.byteLength - ++i >= 0) {
					bigIntBytes[bigIntBytes.byteLength - i] = Number(b & BigInt(255));
					b >>= BigInt(8);
				}
				ensureSpace(bigIntBytes.byteLength * 2);
				data[cursor++] = nonNegative ? 194 : 195;
				if (USE_BUFFER) encodeHeader(2, Buffer.byteLength(bigIntBytes));
				else encodeHeader(2, bigIntBytes.byteLength);
				data.set(bigIntBytes, cursor);
				cursor += bigIntBytes.byteLength;
			}
			continue;
		} else if (input === null) {
			data[cursor++] = 246;
			continue;
		} else if (typeof input === "boolean") {
			data[cursor++] = 224 | (input ? 21 : 20);
			continue;
		} else if (typeof input === "undefined") throw new Error("@smithy/core/cbor: client may not serialize undefined value.");
		else if (Array.isArray(input)) {
			for (let i = input.length - 1; i >= 0; --i) encodeStack.push(input[i]);
			encodeHeader(4, input.length);
			continue;
		} else if (typeof input.byteLength === "number") {
			ensureSpace(input.length * 2);
			encodeHeader(2, input.length);
			data.set(input, cursor);
			cursor += input.byteLength;
			continue;
		} else if (typeof input === "object") {
			if (input instanceof NumericValue) {
				const decimalIndex = input.string.indexOf(".");
				const exponent = decimalIndex === -1 ? 0 : decimalIndex - input.string.length + 1;
				const mantissa = BigInt(input.string.replace(".", ""));
				data[cursor++] = 196;
				encodeStack.push(mantissa);
				encodeStack.push(exponent);
				encodeHeader(4, 2);
				continue;
			}
			if (input[tagSymbol]) if ("tag" in input && "value" in input) {
				encodeStack.push(input.value);
				encodeHeader(6, input.tag);
				continue;
			} else throw new Error("tag encountered with missing fields, need 'tag' and 'value', found: " + JSON.stringify(input));
			const keys = Object.keys(input);
			for (let i = keys.length - 1; i >= 0; --i) {
				const key = keys[i];
				encodeStack.push(input[key]);
				encodeStack.push(key);
			}
			encodeHeader(5, keys.length);
			continue;
		}
		throw new Error(`data type ${input?.constructor?.name ?? typeof input} not compatible for encoding.`);
	}
}
var USE_BUFFER, data, dataView, cursor;
var init_cbor_encode = __esmMin((() => {
	init_serde();
	init_cbor_types();
	USE_BUFFER = typeof Buffer !== "undefined";
	data = alloc(2048);
	dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
	cursor = 0;
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/cbor.js
var cbor;
var init_cbor$1 = __esmMin((() => {
	init_cbor_decode();
	init_cbor_encode();
	cbor = {
		deserialize(payload) {
			setPayload(payload);
			return decode(0, payload.length);
		},
		serialize(input) {
			try {
				encode(input);
				return toUint8Array();
			} catch (e) {
				toUint8Array();
				throw e;
			}
		},
		resizeEncodingBuffer(size) {
			resize(size);
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/parseCborBody.js
var dateToTag, loadSmithyRpcV2CborErrorCode;
var init_parseCborBody = __esmMin((() => {
	init_cbor_types();
	dateToTag = (date) => {
		return tag({
			tag: 1,
			value: date.getTime() / 1e3
		});
	};
	loadSmithyRpcV2CborErrorCode = (output, data) => {
		const sanitizeErrorCode = (rawValue) => {
			let cleanValue = rawValue;
			if (typeof cleanValue === "number") cleanValue = cleanValue.toString();
			if (cleanValue.indexOf(",") >= 0) cleanValue = cleanValue.split(",")[0];
			if (cleanValue.indexOf(":") >= 0) cleanValue = cleanValue.split(":")[0];
			if (cleanValue.indexOf("#") >= 0) cleanValue = cleanValue.split("#")[1];
			return cleanValue;
		};
		if (data["__type"] !== void 0) return sanitizeErrorCode(data["__type"]);
		let codeKey;
		for (const key in data) if (key.toLowerCase() === "code") {
			codeKey = key;
			break;
		}
		if (codeKey && data[codeKey] !== void 0) return sanitizeErrorCode(data[codeKey]);
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/CborCodec.js
var CborCodec, CborShapeSerializer, CborShapeDeserializer;
var init_CborCodec = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_serde();
	init_cbor$1();
	init_parseCborBody();
	CborCodec = class extends SerdeContext {
		createSerializer() {
			const serializer = new CborShapeSerializer();
			serializer.setSerdeContext(this.serdeContext);
			return serializer;
		}
		createDeserializer() {
			const deserializer = new CborShapeDeserializer();
			deserializer.setSerdeContext(this.serdeContext);
			return deserializer;
		}
	};
	CborShapeSerializer = class extends SerdeContext {
		value;
		write(schema, value) {
			this.value = this.serialize(schema, value);
		}
		serialize(schema, source) {
			const ns = NormalizedSchema.of(schema);
			if (source == null) {
				if (ns.isIdempotencyToken()) return generateIdempotencyToken();
				return source;
			}
			if (ns.isBlobSchema()) {
				if (typeof source === "string") return (this.serdeContext?.base64Decoder ?? fromBase64)(source);
				return source;
			}
			if (ns.isTimestampSchema()) {
				if (typeof source === "number" || typeof source === "bigint") return dateToTag(/* @__PURE__ */ new Date(Number(source) / 1e3 | 0));
				return dateToTag(source);
			}
			if (typeof source === "function" || typeof source === "object") {
				const sourceObject = source;
				if (ns.isListSchema() && Array.isArray(sourceObject)) {
					const sparse = !!ns.getMergedTraits().sparse;
					const newArray = [];
					let i = 0;
					for (const item of sourceObject) {
						const value = this.serialize(ns.getValueSchema(), item);
						if (value != null || sparse) newArray[i++] = value;
					}
					return newArray;
				}
				if (sourceObject instanceof Date) return dateToTag(sourceObject);
				const newObject = {};
				if (ns.isMapSchema()) {
					const sparse = !!ns.getMergedTraits().sparse;
					for (const key in sourceObject) {
						const value = this.serialize(ns.getValueSchema(), sourceObject[key]);
						if (value != null || sparse) newObject[key] = value;
					}
				} else if (ns.isStructSchema()) {
					for (const [key, memberSchema] of ns.structIterator()) {
						const value = this.serialize(memberSchema, sourceObject[key]);
						if (value != null) newObject[key] = value;
					}
					if (ns.isUnionSchema() && Array.isArray(sourceObject.$unknown)) {
						const [k, v] = sourceObject.$unknown;
						newObject[k] = v;
					} else if (typeof sourceObject.__type === "string") {
						for (const k in sourceObject) if (!(k in newObject)) newObject[k] = this.serialize(15, sourceObject[k]);
					}
				} else if (ns.isDocumentSchema()) for (const key in sourceObject) newObject[key] = this.serialize(ns.getValueSchema(), sourceObject[key]);
				else if (ns.isBigDecimalSchema()) return sourceObject;
				return newObject;
			}
			return source;
		}
		flush() {
			const buffer = cbor.serialize(this.value);
			this.value = void 0;
			return buffer;
		}
	};
	CborShapeDeserializer = class extends SerdeContext {
		read(schema, bytes) {
			const data = cbor.deserialize(bytes);
			return this.readValue(schema, data);
		}
		readValue(_schema, value) {
			const ns = NormalizedSchema.of(_schema);
			if (ns.isTimestampSchema()) {
				if (typeof value === "number") return _parseEpochTimestamp(value);
				if (typeof value === "object") {
					if (value.tag === 1 && "value" in value) return _parseEpochTimestamp(value.value);
				}
			}
			if (ns.isBlobSchema()) {
				if (typeof value === "string") return (this.serdeContext?.base64Decoder ?? fromBase64)(value);
				return value;
			}
			if (typeof value === "undefined" || typeof value === "boolean" || typeof value === "number" || typeof value === "string" || typeof value === "bigint" || typeof value === "symbol") return value;
			else if (typeof value === "object") {
				if (value === null) return null;
				if ("byteLength" in value) return value;
				if (value instanceof Date) return value;
				if (ns.isDocumentSchema()) return value;
				if (ns.isListSchema()) {
					const newArray = [];
					const memberSchema = ns.getValueSchema();
					for (const item of value) {
						const itemValue = this.readValue(memberSchema, item);
						newArray.push(itemValue);
					}
					return newArray;
				}
				const newObject = {};
				if (ns.isMapSchema()) {
					const targetSchema = ns.getValueSchema();
					for (const key in value) newObject[key] = this.readValue(targetSchema, value[key]);
				} else if (ns.isStructSchema()) {
					const isUnion = ns.isUnionSchema();
					let keys;
					if (isUnion) {
						keys = /* @__PURE__ */ new Set();
						for (const k in value) if (k !== "__type") keys.add(k);
					}
					for (const [key, memberSchema] of ns.structIterator()) {
						if (isUnion) keys.delete(key);
						if (value[key] != null) newObject[key] = this.readValue(memberSchema, value[key]);
					}
					if (isUnion && keys?.size === 1) {
						let newObjectEmpty = true;
						for (const _ in newObject) {
							newObjectEmpty = false;
							break;
						}
						if (newObjectEmpty) {
							const k = keys.values().next().value;
							newObject.$unknown = [k, value[k]];
						}
					} else if (typeof value.__type === "string") {
						for (const k in value) if (!(k in newObject)) newObject[k] = value[k];
					}
				} else if (value instanceof NumericValue) return value;
				return newObject;
			} else return value;
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/SmithyRpcV2CborProtocol.js
var SmithyRpcV2CborProtocol;
var init_SmithyRpcV2CborProtocol = __esmMin((() => {
	init_client$1();
	init_protocols$1();
	init_schema();
	init_CborCodec();
	init_parseCborBody();
	SmithyRpcV2CborProtocol = class extends RpcProtocol {
		codec = new CborCodec();
		serializer = this.codec.createSerializer();
		deserializer = this.codec.createDeserializer();
		constructor({ defaultNamespace, errorTypeRegistries }) {
			super({
				defaultNamespace,
				errorTypeRegistries
			});
		}
		getShapeId() {
			return "smithy.protocols#rpcv2Cbor";
		}
		getPayloadCodec() {
			return this.codec;
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			Object.assign(request.headers, {
				"content-type": this.getDefaultContentType(),
				"smithy-protocol": "rpc-v2-cbor",
				accept: this.getDefaultContentType()
			});
			if (deref(operationSchema.input) === "unit") {
				delete request.body;
				delete request.headers["content-type"];
			} else {
				if (!request.body) {
					this.serializer.write(15, {});
					request.body = this.serializer.flush();
				}
				try {
					request.headers["content-length"] = String(request.body.byteLength);
				} catch (e) {}
			}
			const { service, operation } = getSmithyContext(context);
			const path = `/service/${service}/operation/${operation}`;
			if (request.path.endsWith("/")) request.path += path.slice(1);
			else request.path += path;
			return request;
		}
		async deserializeResponse(operationSchema, context, response) {
			return super.deserializeResponse(operationSchema, context, response);
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			const errorName = loadSmithyRpcV2CborErrorCode(response, dataObject) ?? "Unknown";
			const errorMetadata = {
				$metadata: metadata,
				$fault: response.statusCode <= 500 ? "client" : "server"
			};
			let namespace = this.options.defaultNamespace;
			if (errorName.includes("#")) [namespace] = errorName.split("#");
			const registry = this.compositeErrorRegistry;
			const nsRegistry = TypeRegistry.for(namespace);
			registry.copyFrom(nsRegistry);
			let errorSchema;
			try {
				errorSchema = registry.getSchema(errorName);
			} catch (e) {
				if (dataObject.Message) dataObject.message = dataObject.Message;
				const syntheticRegistry = TypeRegistry.for("smithy.ts.sdk.synthetic." + namespace);
				registry.copyFrom(syntheticRegistry);
				const baseExceptionSchema = registry.getBaseException();
				if (baseExceptionSchema) {
					const ErrorCtor = registry.getErrorCtor(baseExceptionSchema);
					throw Object.assign(new ErrorCtor({ name: errorName }), errorMetadata, dataObject);
				}
				throw Object.assign(new Error(errorName), errorMetadata, dataObject);
			}
			const ns = NormalizedSchema.of(errorSchema);
			const ErrorCtor = registry.getErrorCtor(errorSchema);
			const message = dataObject.message ?? dataObject.Message ?? "Unknown";
			const exception = new ErrorCtor({});
			const output = {};
			for (const [name, member] of ns.structIterator()) output[name] = this.deserializer.readValue(member, dataObject[name]);
			throw Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output);
		}
		getDefaultContentType() {
			return "application/cbor";
		}
	};
}));
//#endregion
//#region node_modules/@smithy/core/dist-es/submodules/cbor/index.js
var init_cbor = __esmMin((() => {
	init_cbor$1();
	init_cbor_types();
	init_parseCborBody();
	init_SmithyRpcV2CborProtocol();
	init_CborCodec();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/ProtocolLib.js
var ProtocolLib;
var init_ProtocolLib = __esmMin((() => {
	init_client$1();
	init_schema();
	ProtocolLib = class {
		queryCompat;
		errorRegistry;
		constructor(queryCompat = false) {
			this.queryCompat = queryCompat;
		}
		resolveRestContentType(defaultContentType, inputSchema) {
			const members = inputSchema.getMemberSchemas();
			const httpPayloadMember = Object.values(members).find((m) => {
				return !!m.getMergedTraits().httpPayload;
			});
			if (httpPayloadMember) {
				const mediaType = httpPayloadMember.getMergedTraits().mediaType;
				if (mediaType) return mediaType;
				else if (httpPayloadMember.isStringSchema()) return "text/plain";
				else if (httpPayloadMember.isBlobSchema()) return "application/octet-stream";
				else return defaultContentType;
			} else if (!inputSchema.isUnitSchema()) {
				if (Object.values(members).find((m) => {
					const { httpQuery, httpQueryParams, httpHeader, httpLabel, httpPrefixHeaders } = m.getMergedTraits();
					return !httpQuery && !httpQueryParams && !httpHeader && !httpLabel && httpPrefixHeaders === void 0;
				})) return defaultContentType;
			}
		}
		async getErrorSchemaOrThrowBaseException(errorIdentifier, defaultNamespace, response, dataObject, metadata, getErrorSchema) {
			let errorName = errorIdentifier;
			if (errorIdentifier.includes("#")) [, errorName] = errorIdentifier.split("#");
			const errorMetadata = {
				$metadata: metadata,
				$fault: response.statusCode < 500 ? "client" : "server"
			};
			if (!this.errorRegistry) throw new Error("@aws-sdk/core/protocols - error handler not initialized.");
			try {
				return {
					errorSchema: getErrorSchema?.(this.errorRegistry, errorName) ?? this.errorRegistry.getSchema(errorIdentifier),
					errorMetadata
				};
			} catch (e) {
				dataObject.message = dataObject.message ?? dataObject.Message ?? "UnknownError";
				const synthetic = this.errorRegistry;
				const baseExceptionSchema = synthetic.getBaseException();
				if (baseExceptionSchema) {
					const ErrorCtor = synthetic.getErrorCtor(baseExceptionSchema) ?? Error;
					throw this.decorateServiceException(Object.assign(new ErrorCtor({ name: errorName }), errorMetadata), dataObject);
				}
				const d = dataObject;
				const message = d?.message ?? d?.Message ?? d?.Error?.Message ?? d?.Error?.message;
				throw this.decorateServiceException(Object.assign(new Error(message), { name: errorName }, errorMetadata), dataObject);
			}
		}
		compose(composite, errorIdentifier, defaultNamespace) {
			let namespace = defaultNamespace;
			if (errorIdentifier.includes("#")) [namespace] = errorIdentifier.split("#");
			const staticRegistry = TypeRegistry.for(namespace);
			const defaultSyntheticRegistry = TypeRegistry.for("smithy.ts.sdk.synthetic." + defaultNamespace);
			composite.copyFrom(staticRegistry);
			composite.copyFrom(defaultSyntheticRegistry);
			this.errorRegistry = composite;
		}
		decorateServiceException(exception, additions = {}) {
			if (this.queryCompat) {
				const msg = exception.Message ?? additions.Message;
				const error = decorateServiceException(exception, additions);
				if (msg) error.message = msg;
				const errorObj = error.Error ?? {};
				errorObj.Type = error.Error?.Type;
				errorObj.Code = error.Error?.Code;
				errorObj.Message = error.Error?.message ?? error.Error?.Message ?? msg;
				error.Error = errorObj;
				const reqId = error.$metadata.requestId;
				if (reqId) error.RequestId = reqId;
				return error;
			}
			return decorateServiceException(exception, additions);
		}
		setQueryCompatError(output, response) {
			const queryErrorHeader = response.headers?.["x-amzn-query-error"];
			if (output !== void 0 && queryErrorHeader != null) {
				const [Code, Type] = queryErrorHeader.split(";");
				const keys = Object.keys(output);
				const Error = {
					Code,
					Type
				};
				output.Code = Code;
				output.Type = Type;
				for (let i = 0; i < keys.length; i++) {
					const k = keys[i];
					Error[k === "message" ? "Message" : k] = output[k];
				}
				delete Error.__type;
				output.Error = Error;
			}
		}
		queryCompatOutput(queryCompatErrorData, errorData) {
			if (queryCompatErrorData.Error) errorData.Error = queryCompatErrorData.Error;
			if (queryCompatErrorData.Type) errorData.Type = queryCompatErrorData.Type;
			if (queryCompatErrorData.Code) errorData.Code = queryCompatErrorData.Code;
		}
		findQueryCompatibleError(registry, errorName) {
			try {
				return registry.getSchema(errorName);
			} catch (e) {
				return registry.find((schema) => NormalizedSchema.of(schema).getMergedTraits().awsQueryError?.[0] === errorName);
			}
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/cbor/AwsSmithyRpcV2CborProtocol.js
var AwsSmithyRpcV2CborProtocol;
var init_AwsSmithyRpcV2CborProtocol = __esmMin((() => {
	init_cbor();
	init_schema();
	init_ProtocolLib();
	AwsSmithyRpcV2CborProtocol = class extends SmithyRpcV2CborProtocol {
		awsQueryCompatible;
		mixin;
		constructor({ defaultNamespace, errorTypeRegistries, awsQueryCompatible }) {
			super({
				defaultNamespace,
				errorTypeRegistries
			});
			this.awsQueryCompatible = !!awsQueryCompatible;
			this.mixin = new ProtocolLib(this.awsQueryCompatible);
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			if (this.awsQueryCompatible) request.headers["x-amzn-query-mode"] = "true";
			return request;
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			if (this.awsQueryCompatible) this.mixin.setQueryCompatError(dataObject, response);
			const errorName = (() => {
				const compatHeader = response.headers["x-amzn-query-error"];
				if (compatHeader && this.awsQueryCompatible) return compatHeader.split(";")[0];
				return loadSmithyRpcV2CborErrorCode(response, dataObject) ?? "Unknown";
			})();
			this.mixin.compose(this.compositeErrorRegistry, errorName, this.options.defaultNamespace);
			const { errorSchema, errorMetadata } = await this.mixin.getErrorSchemaOrThrowBaseException(errorName, this.options.defaultNamespace, response, dataObject, metadata, this.awsQueryCompatible ? this.mixin.findQueryCompatibleError : void 0);
			const ns = NormalizedSchema.of(errorSchema);
			const message = dataObject.message ?? dataObject.Message ?? "UnknownError";
			const exception = new ((this.compositeErrorRegistry.getErrorCtor(errorSchema)) ?? Error)({});
			const output = {};
			for (const [name, member] of ns.structIterator()) if (dataObject[name] != null) output[name] = this.deserializer.readValue(member, dataObject[name]);
			if (this.awsQueryCompatible) this.mixin.queryCompatOutput(dataObject, output);
			throw this.mixin.decorateServiceException(Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output), dataObject);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/coercing-serializers.js
var _toStr, _toBool, _toNum;
var init_coercing_serializers = __esmMin((() => {
	_toStr = (val) => {
		if (val == null) return val;
		if (typeof val === "number" || typeof val === "bigint") {
			const warning = /* @__PURE__ */ new Error(`Received number ${val} where a string was expected.`);
			warning.name = "Warning";
			console.warn(warning);
			return String(val);
		}
		if (typeof val === "boolean") {
			const warning = /* @__PURE__ */ new Error(`Received boolean ${val} where a string was expected.`);
			warning.name = "Warning";
			console.warn(warning);
			return String(val);
		}
		return val;
	};
	_toBool = (val) => {
		if (val == null) return val;
		if (typeof val === "number") {}
		if (typeof val === "string") {
			const lowercase = val.toLowerCase();
			if (val !== "" && lowercase !== "false" && lowercase !== "true") {
				const warning = /* @__PURE__ */ new Error(`Received string "${val}" where a boolean was expected.`);
				warning.name = "Warning";
				console.warn(warning);
			}
			return val !== "" && lowercase !== "false";
		}
		return val;
	};
	_toNum = (val) => {
		if (val == null) return val;
		if (typeof val === "boolean") {}
		if (typeof val === "string") {
			const num = Number(val);
			if (num.toString() !== val) {
				const warning = /* @__PURE__ */ new Error(`Received string "${val}" where a number was expected.`);
				warning.name = "Warning";
				console.warn(warning);
				return val;
			}
			return num;
		}
		return val;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/ConfigurableSerdeContext.js
var SerdeContextConfig;
var init_ConfigurableSerdeContext = __esmMin((() => {
	SerdeContextConfig = class {
		serdeContext;
		setSerdeContext(serdeContext) {
			this.serdeContext = serdeContext;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/UnionSerde.js
var UnionSerde;
var init_UnionSerde = __esmMin((() => {
	UnionSerde = class {
		from;
		to;
		keys;
		constructor(from, to) {
			this.from = from;
			this.to = to;
			const keys = Object.keys(this.from);
			const set = new Set(keys);
			set.delete("__type");
			this.keys = set;
		}
		mark(key) {
			this.keys.delete(key);
		}
		hasUnknown() {
			return this.keys.size === 1 && Object.keys(this.to).length === 0;
		}
		writeUnknown() {
			if (this.hasUnknown()) {
				const k = this.keys.values().next().value;
				const v = this.from[k];
				this.to.$unknown = [k, v];
			}
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/jsonReviver.js
function jsonReviver(key, value, context) {
	if (context?.source) {
		const numericString = context.source;
		if (typeof value === "number") {
			if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER || numericString !== String(value)) if (numericString.includes(".")) return new NumericValue(numericString, "bigDecimal");
			else return BigInt(numericString);
		}
	}
	return value;
}
var init_jsonReviver = __esmMin((() => {
	init_serde();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/common.js
var collectBodyString;
var init_common = __esmMin((() => {
	init_protocols$1();
	init_serde();
	collectBodyString = (streamBody, context) => collectBody(streamBody, context).then((body) => (context?.utf8Encoder ?? toUtf8)(body));
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/parseJsonBody.js
var parseJsonBody, parseJsonErrorBody, findKey, sanitizeErrorCode, loadRestJsonErrorCode, loadJsonRpcErrorCode, loadErrorCode;
var init_parseJsonBody = __esmMin((() => {
	init_common();
	parseJsonBody = (streamBody, context) => collectBodyString(streamBody, context).then((encoded) => {
		if (encoded.length) try {
			return JSON.parse(encoded);
		} catch (e) {
			if (e?.name === "SyntaxError") Object.defineProperty(e, "$responseBodyText", { value: encoded });
			throw e;
		}
		return {};
	});
	parseJsonErrorBody = async (errorBody, context) => {
		const value = await parseJsonBody(errorBody, context);
		value.message = value.message ?? value.Message;
		return value;
	};
	findKey = (object, key) => Object.keys(object).find((k) => k.toLowerCase() === key.toLowerCase());
	sanitizeErrorCode = (rawValue) => {
		let cleanValue = rawValue;
		if (typeof cleanValue === "number") cleanValue = cleanValue.toString();
		if (cleanValue.indexOf(",") >= 0) cleanValue = cleanValue.split(",")[0];
		if (cleanValue.indexOf(":") >= 0) cleanValue = cleanValue.split(":")[0];
		if (cleanValue.indexOf("#") >= 0) cleanValue = cleanValue.split("#")[1];
		return cleanValue;
	};
	loadRestJsonErrorCode = (output, data) => {
		return loadErrorCode(output, data, [
			"header",
			"code",
			"type"
		]);
	};
	loadJsonRpcErrorCode = (output, data, queryCompat = false) => {
		return loadErrorCode(output, data, queryCompat ? [
			"code",
			"header",
			"type"
		] : [
			"type",
			"code",
			"header"
		]);
	};
	loadErrorCode = ({ headers }, data, order) => {
		while (order.length > 0) switch (order.shift()) {
			case "header":
				const headerKey = findKey(headers ?? {}, "x-amzn-errortype");
				if (headerKey !== void 0) return sanitizeErrorCode(headers[headerKey]);
				break;
			case "code":
				const codeKey = findKey(data ?? {}, "code");
				if (codeKey && data[codeKey] !== void 0) return sanitizeErrorCode(data[codeKey]);
				break;
			case "type":
				if (data?.__type !== void 0) return sanitizeErrorCode(data.__type);
				break;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/JsonShapeDeserializer.js
var JsonShapeDeserializer;
var init_JsonShapeDeserializer = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_serde();
	init_ConfigurableSerdeContext();
	init_UnionSerde();
	init_jsonReviver();
	init_parseJsonBody();
	JsonShapeDeserializer = class extends SerdeContextConfig {
		settings;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		async read(schema, data) {
			return this._read(schema, typeof data === "string" ? JSON.parse(data, jsonReviver) : await parseJsonBody(data, this.serdeContext));
		}
		readObject(schema, data) {
			return this._read(schema, data);
		}
		_read(schema, value) {
			const isObject = value !== null && typeof value === "object";
			const ns = NormalizedSchema.of(schema);
			if (isObject) {
				if (ns.isStructSchema()) {
					const record = value;
					const union = ns.isUnionSchema();
					const out = {};
					let nameMap = void 0;
					const { jsonName } = this.settings;
					if (jsonName) nameMap = {};
					let unionSerde;
					if (union) unionSerde = new UnionSerde(record, out);
					for (const [memberName, memberSchema] of ns.structIterator()) {
						let fromKey = memberName;
						if (jsonName) {
							fromKey = memberSchema.getMergedTraits().jsonName ?? fromKey;
							nameMap[fromKey] = memberName;
						}
						if (union) unionSerde.mark(fromKey);
						if (record[fromKey] != null) out[memberName] = this._read(memberSchema, record[fromKey]);
					}
					if (union) unionSerde.writeUnknown();
					else if (typeof record.__type === "string") for (const k in record) {
						const v = record[k];
						const t = jsonName ? nameMap[k] ?? k : k;
						if (!(t in out)) out[t] = v;
					}
					return out;
				}
				if (Array.isArray(value) && ns.isListSchema()) {
					const listMember = ns.getValueSchema();
					const out = [];
					for (const item of value) out.push(this._read(listMember, item));
					return out;
				}
				if (ns.isMapSchema()) {
					const mapMember = ns.getValueSchema();
					const out = {};
					for (const _k in value) out[_k] = this._read(mapMember, value[_k]);
					return out;
				}
			}
			if (ns.isBlobSchema() && typeof value === "string") return fromBase64(value);
			const mediaType = ns.getMergedTraits().mediaType;
			if (ns.isStringSchema() && typeof value === "string" && mediaType) {
				if (mediaType === "application/json" || mediaType.endsWith("+json")) return LazyJsonString.from(value);
				return value;
			}
			if (ns.isTimestampSchema() && value != null) switch (determineTimestampFormat(ns, this.settings)) {
				case 5: return parseRfc3339DateTimeWithOffset(value);
				case 6: return parseRfc7231DateTime(value);
				case 7: return parseEpochTimestamp(value);
				default:
					console.warn("Missing timestamp format, parsing value with Date constructor:", value);
					return new Date(value);
			}
			if (ns.isBigIntegerSchema() && (typeof value === "number" || typeof value === "string")) return BigInt(value);
			if (ns.isBigDecimalSchema() && value != void 0) {
				if (value instanceof NumericValue) return value;
				const untyped = value;
				if (untyped.type === "bigDecimal" && "string" in untyped) return new NumericValue(untyped.string, untyped.type);
				return new NumericValue(String(value), "bigDecimal");
			}
			if (ns.isNumericSchema() && typeof value === "string") {
				switch (value) {
					case "Infinity": return Infinity;
					case "-Infinity": return -Infinity;
					case "NaN": return NaN;
				}
				return value;
			}
			if (ns.isDocumentSchema()) if (isObject) {
				const out = Array.isArray(value) ? [] : {};
				for (const k in value) {
					const v = value[k];
					if (v instanceof NumericValue) out[k] = v;
					else out[k] = this._read(ns, v);
				}
				return out;
			} else return structuredClone(value);
			return value;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/jsonReplacer.js
var JsonReplacer;
var init_jsonReplacer = __esmMin((() => {
	init_serde();
	JsonReplacer = class {
		values = /* @__PURE__ */ new Map();
		counter = 0;
		stage = 0;
		createReplacer() {
			if (this.stage === 1) throw new Error("@aws-sdk/core/protocols - JsonReplacer already created.");
			if (this.stage === 2) throw new Error("@aws-sdk/core/protocols - JsonReplacer exhausted.");
			this.stage = 1;
			return (key, value) => {
				if (value instanceof NumericValue) {
					const v = `${"Νnv" + this.counter++}_` + value.string;
					this.values.set(`"${v}"`, value.string);
					return v;
				}
				if (typeof value === "bigint") {
					const s = value.toString();
					const v = `${"Νb" + this.counter++}_` + s;
					this.values.set(`"${v}"`, s);
					return v;
				}
				return value;
			};
		}
		replaceInJson(json) {
			if (this.stage === 0) throw new Error("@aws-sdk/core/protocols - JsonReplacer not created yet.");
			if (this.stage === 2) throw new Error("@aws-sdk/core/protocols - JsonReplacer exhausted.");
			this.stage = 2;
			if (this.counter === 0) return json;
			for (const [key, value] of this.values) json = json.replace(key, value);
			return json;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/JsonShapeSerializer.js
var JsonShapeSerializer;
var init_JsonShapeSerializer = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_serde();
	init_ConfigurableSerdeContext();
	init_jsonReplacer();
	JsonShapeSerializer = class extends SerdeContextConfig {
		settings;
		buffer;
		useReplacer = false;
		rootSchema;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		write(schema, value) {
			this.rootSchema = NormalizedSchema.of(schema);
			this.buffer = this._write(this.rootSchema, value);
		}
		flush() {
			const { rootSchema, useReplacer } = this;
			this.rootSchema = void 0;
			this.useReplacer = false;
			if (rootSchema?.isStructSchema() || rootSchema?.isDocumentSchema()) {
				if (!useReplacer) return JSON.stringify(this.buffer);
				const replacer = new JsonReplacer();
				return replacer.replaceInJson(JSON.stringify(this.buffer, replacer.createReplacer(), 0));
			}
			return this.buffer;
		}
		writeDiscriminatedDocument(schema, value) {
			this.write(schema, value);
			if (typeof this.buffer === "object") this.buffer.__type = NormalizedSchema.of(schema).getName(true);
		}
		_write(schema, value, container) {
			const isObject = value !== null && typeof value === "object";
			const ns = NormalizedSchema.of(schema);
			if (isObject) {
				if (ns.isStructSchema()) {
					const record = value;
					const out = {};
					const { jsonName } = this.settings;
					let nameMap = void 0;
					if (jsonName) nameMap = {};
					let outCount = 0;
					for (const [memberName, memberSchema] of ns.structIterator()) {
						const serializableValue = this._write(memberSchema, record[memberName], ns);
						if (serializableValue !== void 0) {
							let targetKey = memberName;
							if (jsonName) {
								targetKey = memberSchema.getMergedTraits().jsonName ?? memberName;
								nameMap[memberName] = targetKey;
							}
							out[targetKey] = serializableValue;
							outCount++;
						}
					}
					if (ns.isUnionSchema() && outCount === 0) {
						const { $unknown } = record;
						if (Array.isArray($unknown)) {
							const [k, v] = $unknown;
							out[k] = this._write(15, v);
						}
					} else if (typeof record.__type === "string") for (const k in record) {
						const v = record[k];
						const targetKey = jsonName ? nameMap[k] ?? k : k;
						if (!(targetKey in out)) out[targetKey] = this._write(15, v);
					}
					return out;
				}
				if (Array.isArray(value) && ns.isListSchema()) {
					const listMember = ns.getValueSchema();
					const out = [];
					const sparse = !!ns.getMergedTraits().sparse;
					for (const item of value) if (sparse || item != null) out.push(this._write(listMember, item));
					return out;
				}
				if (ns.isMapSchema()) {
					const mapMember = ns.getValueSchema();
					const out = {};
					const sparse = !!ns.getMergedTraits().sparse;
					for (const _k in value) {
						const _v = value[_k];
						if (sparse || _v != null) out[_k] = this._write(mapMember, _v);
					}
					return out;
				}
				if (value instanceof Uint8Array && (ns.isBlobSchema() || ns.isDocumentSchema())) {
					if (ns === this.rootSchema) return value;
					return (this.serdeContext?.base64Encoder ?? toBase64)(value);
				}
				if (value instanceof Date && (ns.isTimestampSchema() || ns.isDocumentSchema())) switch (determineTimestampFormat(ns, this.settings)) {
					case 5: return value.toISOString().replace(".000Z", "Z");
					case 6: return dateToUtcString(value);
					case 7: return value.getTime() / 1e3;
					default:
						console.warn("Missing timestamp format, using epoch seconds", value);
						return value.getTime() / 1e3;
				}
				if (value instanceof NumericValue) this.useReplacer = true;
			}
			if (value === null && container?.isStructSchema()) return;
			if (ns.isStringSchema()) {
				if (typeof value === "undefined" && ns.isIdempotencyToken()) return generateIdempotencyToken();
				const mediaType = ns.getMergedTraits().mediaType;
				if (value != null && mediaType) {
					if (mediaType === "application/json" || mediaType.endsWith("+json")) return LazyJsonString.from(value);
				}
				return value;
			}
			if (typeof value === "number" && ns.isNumericSchema()) {
				if (Math.abs(value) === Infinity || isNaN(value)) return String(value);
				return value;
			}
			if (typeof value === "string" && ns.isBlobSchema()) {
				if (ns === this.rootSchema) return value;
				return (this.serdeContext?.base64Encoder ?? toBase64)(value);
			}
			if (typeof value === "bigint") this.useReplacer = true;
			if (ns.isDocumentSchema()) if (isObject) {
				const out = Array.isArray(value) ? [] : {};
				for (const k in value) {
					const v = value[k];
					if (v instanceof NumericValue) {
						this.useReplacer = true;
						out[k] = v;
					} else out[k] = this._write(ns, v);
				}
				return out;
			} else return structuredClone(value);
			return value;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/JsonCodec.js
var JsonCodec;
var init_JsonCodec = __esmMin((() => {
	init_ConfigurableSerdeContext();
	init_JsonShapeDeserializer();
	init_JsonShapeSerializer();
	JsonCodec = class extends SerdeContextConfig {
		settings;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		createSerializer() {
			const serializer = new JsonShapeSerializer(this.settings);
			serializer.setSerdeContext(this.serdeContext);
			return serializer;
		}
		createDeserializer() {
			const deserializer = new JsonShapeDeserializer(this.settings);
			deserializer.setSerdeContext(this.serdeContext);
			return deserializer;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/AwsJsonRpcProtocol.js
var AwsJsonRpcProtocol;
var init_AwsJsonRpcProtocol = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_ProtocolLib();
	init_JsonCodec();
	init_parseJsonBody();
	AwsJsonRpcProtocol = class extends RpcProtocol {
		serializer;
		deserializer;
		serviceTarget;
		codec;
		mixin;
		awsQueryCompatible;
		constructor({ defaultNamespace, errorTypeRegistries, serviceTarget, awsQueryCompatible, jsonCodec }) {
			super({
				defaultNamespace,
				errorTypeRegistries
			});
			this.serviceTarget = serviceTarget;
			this.codec = jsonCodec ?? new JsonCodec({
				timestampFormat: {
					useTrait: true,
					default: 7
				},
				jsonName: false
			});
			this.serializer = this.codec.createSerializer();
			this.deserializer = this.codec.createDeserializer();
			this.awsQueryCompatible = !!awsQueryCompatible;
			this.mixin = new ProtocolLib(this.awsQueryCompatible);
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			if (!request.path.endsWith("/")) request.path += "/";
			request.headers["content-type"] = `application/x-amz-json-${this.getJsonRpcVersion()}`;
			request.headers["x-amz-target"] = `${this.serviceTarget}.${operationSchema.name}`;
			if (this.awsQueryCompatible) request.headers["x-amzn-query-mode"] = "true";
			if (deref(operationSchema.input) === "unit" || !request.body) request.body = "{}";
			return request;
		}
		getPayloadCodec() {
			return this.codec;
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			const { awsQueryCompatible } = this;
			if (awsQueryCompatible) this.mixin.setQueryCompatError(dataObject, response);
			const errorIdentifier = loadJsonRpcErrorCode(response, dataObject, awsQueryCompatible) ?? "Unknown";
			this.mixin.compose(this.compositeErrorRegistry, errorIdentifier, this.options.defaultNamespace);
			const { errorSchema, errorMetadata } = await this.mixin.getErrorSchemaOrThrowBaseException(errorIdentifier, this.options.defaultNamespace, response, dataObject, metadata, awsQueryCompatible ? this.mixin.findQueryCompatibleError : void 0);
			const ns = NormalizedSchema.of(errorSchema);
			const message = dataObject.message ?? dataObject.Message ?? "UnknownError";
			const exception = new ((this.compositeErrorRegistry.getErrorCtor(errorSchema)) ?? Error)({});
			const output = {};
			const errorDeserializer = this.codec.createDeserializer();
			for (const [name, member] of ns.structIterator()) if (dataObject[name] != null) output[name] = errorDeserializer.readObject(member, dataObject[name]);
			if (awsQueryCompatible) this.mixin.queryCompatOutput(dataObject, output);
			throw this.mixin.decorateServiceException(Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output), dataObject);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/AwsJson1_0Protocol.js
var AwsJson1_0Protocol;
var init_AwsJson1_0Protocol = __esmMin((() => {
	init_AwsJsonRpcProtocol();
	AwsJson1_0Protocol = class extends AwsJsonRpcProtocol {
		constructor({ defaultNamespace, errorTypeRegistries, serviceTarget, awsQueryCompatible, jsonCodec }) {
			super({
				defaultNamespace,
				errorTypeRegistries,
				serviceTarget,
				awsQueryCompatible,
				jsonCodec
			});
		}
		getShapeId() {
			return "aws.protocols#awsJson1_0";
		}
		getJsonRpcVersion() {
			return "1.0";
		}
		getDefaultContentType() {
			return "application/x-amz-json-1.0";
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/AwsJson1_1Protocol.js
var AwsJson1_1Protocol;
var init_AwsJson1_1Protocol = __esmMin((() => {
	init_AwsJsonRpcProtocol();
	AwsJson1_1Protocol = class extends AwsJsonRpcProtocol {
		constructor({ defaultNamespace, errorTypeRegistries, serviceTarget, awsQueryCompatible, jsonCodec }) {
			super({
				defaultNamespace,
				errorTypeRegistries,
				serviceTarget,
				awsQueryCompatible,
				jsonCodec
			});
		}
		getShapeId() {
			return "aws.protocols#awsJson1_1";
		}
		getJsonRpcVersion() {
			return "1.1";
		}
		getDefaultContentType() {
			return "application/x-amz-json-1.1";
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/AwsRestJsonProtocol.js
var AwsRestJsonProtocol;
var init_AwsRestJsonProtocol = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_ProtocolLib();
	init_JsonCodec();
	init_parseJsonBody();
	AwsRestJsonProtocol = class extends HttpBindingProtocol {
		serializer;
		deserializer;
		codec;
		mixin = new ProtocolLib();
		constructor({ defaultNamespace, errorTypeRegistries }) {
			super({
				defaultNamespace,
				errorTypeRegistries
			});
			const settings = {
				timestampFormat: {
					useTrait: true,
					default: 7
				},
				httpBindings: true,
				jsonName: true
			};
			this.codec = new JsonCodec(settings);
			this.serializer = new HttpInterceptingShapeSerializer(this.codec.createSerializer(), settings);
			this.deserializer = new HttpInterceptingShapeDeserializer(this.codec.createDeserializer(), settings);
		}
		getShapeId() {
			return "aws.protocols#restJson1";
		}
		getPayloadCodec() {
			return this.codec;
		}
		setSerdeContext(serdeContext) {
			this.codec.setSerdeContext(serdeContext);
			super.setSerdeContext(serdeContext);
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			const inputSchema = NormalizedSchema.of(operationSchema.input);
			if (!request.headers["content-type"]) {
				const contentType = this.mixin.resolveRestContentType(this.getDefaultContentType(), inputSchema);
				if (contentType) request.headers["content-type"] = contentType;
			}
			if (request.body == null && request.headers["content-type"] === this.getDefaultContentType()) request.body = "{}";
			return request;
		}
		async deserializeResponse(operationSchema, context, response) {
			const output = await super.deserializeResponse(operationSchema, context, response);
			const outputSchema = NormalizedSchema.of(operationSchema.output);
			for (const [name, member] of outputSchema.structIterator()) if (member.getMemberTraits().httpPayload && !(name in output)) output[name] = null;
			return output;
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			const errorIdentifier = loadRestJsonErrorCode(response, dataObject) ?? "Unknown";
			this.mixin.compose(this.compositeErrorRegistry, errorIdentifier, this.options.defaultNamespace);
			const { errorSchema, errorMetadata } = await this.mixin.getErrorSchemaOrThrowBaseException(errorIdentifier, this.options.defaultNamespace, response, dataObject, metadata);
			const ns = NormalizedSchema.of(errorSchema);
			const message = dataObject.message ?? dataObject.Message ?? "UnknownError";
			const exception = new ((this.compositeErrorRegistry.getErrorCtor(errorSchema)) ?? Error)({});
			await this.deserializeHttpMessage(errorSchema, context, response, dataObject);
			const output = {};
			const errorDeserializer = this.codec.createDeserializer();
			for (const [name, member] of ns.structIterator()) {
				const target = member.getMergedTraits().jsonName ?? name;
				output[name] = errorDeserializer.readObject(member, dataObject[target]);
			}
			throw this.mixin.decorateServiceException(Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output), dataObject);
		}
		getDefaultContentType() {
			return "application/json";
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/json/awsExpectUnion.js
var awsExpectUnion;
var init_awsExpectUnion = __esmMin((() => {
	init_serde();
	awsExpectUnion = (value) => {
		if (value == null) return;
		if (typeof value === "object" && "__type" in value) delete value.__type;
		return expectUnion(value);
	};
}));
//#endregion
//#region node_modules/fast-xml-parser/lib/fxp.cjs
var require_fxp = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	(() => {
		"use strict";
		var t = {
			d: (e, n) => {
				for (var i in n) t.o(n, i) && !t.o(e, i) && Object.defineProperty(e, i, {
					enumerable: !0,
					get: n[i]
				});
			},
			o: (t, e) => Object.prototype.hasOwnProperty.call(t, e),
			r: (t) => {
				"undefined" != typeof Symbol && Symbol.toStringTag && Object.defineProperty(t, Symbol.toStringTag, { value: "Module" }), Object.defineProperty(t, "__esModule", { value: !0 });
			}
		}, e = {};
		t.r(e), t.d(e, {
			XMLBuilder: () => Bt,
			XMLParser: () => Tt,
			XMLValidator: () => Ut
		});
		const i = /* @__PURE__ */ new RegExp("^[:A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD][:A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\-.\\d\\u00B7\\u0300-\\u036F\\u203F-\\u2040]*$");
		function s(t, e) {
			const n = [];
			let i = e.exec(t);
			for (; i;) {
				const s = [];
				s.startIndex = e.lastIndex - i[0].length;
				const r = i.length;
				for (let t = 0; t < r; t++) s.push(i[t]);
				n.push(s), i = e.exec(t);
			}
			return n;
		}
		const r = function(t) {
			return !(null == i.exec(t));
		}, o = [
			"hasOwnProperty",
			"toString",
			"valueOf",
			"__defineGetter__",
			"__defineSetter__",
			"__lookupGetter__",
			"__lookupSetter__"
		], a = [
			"__proto__",
			"constructor",
			"prototype"
		], h = {
			allowBooleanAttributes: !1,
			unpairedTags: []
		};
		function l(t, e) {
			e = Object.assign({}, h, e);
			const n = [];
			let i = !1, s = !1;
			"﻿" === t[0] && (t = t.substr(1));
			for (let r = 0; r < t.length; r++) if ("<" === t[r] && "?" === t[r + 1]) {
				if (r += 2, r = p(t, r), r.err) return r;
			} else {
				if ("<" !== t[r]) {
					if (u(t[r])) continue;
					return b("InvalidChar", "char '" + t[r] + "' is not expected.", w(t, r));
				}
				{
					let o = r;
					if (r++, "!" === t[r]) {
						r = c(t, r);
						continue;
					}
					{
						let a = !1;
						"/" === t[r] && (a = !0, r++);
						let h = "";
						for (; r < t.length && ">" !== t[r] && " " !== t[r] && "	" !== t[r] && "\n" !== t[r] && "\r" !== t[r]; r++) h += t[r];
						if (h = h.trim(), "/" === h[h.length - 1] && (h = h.substring(0, h.length - 1), r--), !E(h)) {
							let e;
							return e = 0 === h.trim().length ? "Invalid space after '<'." : "Tag '" + h + "' is an invalid name.", b("InvalidTag", e, w(t, r));
						}
						const l = g(t, r);
						if (!1 === l) return b("InvalidAttr", "Attributes for '" + h + "' have open quote.", w(t, r));
						let d = l.value;
						if (r = l.index, "/" === d[d.length - 1]) {
							const n = r - d.length;
							d = d.substring(0, d.length - 1);
							const s = x(d, e);
							if (!0 !== s) return b(s.err.code, s.err.msg, w(t, n + s.err.line));
							i = !0;
						} else if (a) {
							if (!l.tagClosed) return b("InvalidTag", "Closing tag '" + h + "' doesn't have proper closing.", w(t, r));
							if (d.trim().length > 0) return b("InvalidTag", "Closing tag '" + h + "' can't have attributes or invalid starting.", w(t, o));
							if (0 === n.length) return b("InvalidTag", "Closing tag '" + h + "' has not been opened.", w(t, o));
							{
								const e = n.pop();
								if (h !== e.tagName) {
									let n = w(t, e.tagStartPos);
									return b("InvalidTag", "Expected closing tag '" + e.tagName + "' (opened in line " + n.line + ", col " + n.col + ") instead of closing tag '" + h + "'.", w(t, o));
								}
								0 == n.length && (s = !0);
							}
						} else {
							const a = x(d, e);
							if (!0 !== a) return b(a.err.code, a.err.msg, w(t, r - d.length + a.err.line));
							if (!0 === s) return b("InvalidXml", "Multiple possible root nodes found.", w(t, r));
							-1 !== e.unpairedTags.indexOf(h) || n.push({
								tagName: h,
								tagStartPos: o
							}), i = !0;
						}
						for (r++; r < t.length; r++) if ("<" === t[r]) {
							if ("!" === t[r + 1]) {
								r++, r = c(t, r);
								continue;
							}
							if ("?" !== t[r + 1]) break;
							if (r = p(t, ++r), r.err) return r;
						} else if ("&" === t[r]) {
							const e = N(t, r);
							if (-1 == e) return b("InvalidChar", "char '&' is not expected.", w(t, r));
							r = e;
						} else if (!0 === s && !u(t[r])) return b("InvalidXml", "Extra text at the end", w(t, r));
						"<" === t[r] && r--;
					}
				}
			}
			return i ? 1 == n.length ? b("InvalidTag", "Unclosed tag '" + n[0].tagName + "'.", w(t, n[0].tagStartPos)) : !(n.length > 0) || b("InvalidXml", "Invalid '" + JSON.stringify(n.map((t) => t.tagName), null, 4).replace(/\r?\n/g, "") + "' found.", {
				line: 1,
				col: 1
			}) : b("InvalidXml", "Start tag expected.", 1);
		}
		function u(t) {
			return " " === t || "	" === t || "\n" === t || "\r" === t;
		}
		function p(t, e) {
			const n = e;
			for (; e < t.length; e++) if ("?" == t[e] || " " == t[e]) {
				const i = t.substr(n, e - n);
				if (e > 5 && "xml" === i) return b("InvalidXml", "XML declaration allowed only at the start of the document.", w(t, e));
				if ("?" == t[e] && ">" == t[e + 1]) {
					e++;
					break;
				}
				continue;
			}
			return e;
		}
		function c(t, e) {
			if (t.length > e + 5 && "-" === t[e + 1] && "-" === t[e + 2]) {
				for (e += 3; e < t.length; e++) if ("-" === t[e] && "-" === t[e + 1] && ">" === t[e + 2]) {
					e += 2;
					break;
				}
			} else if (t.length > e + 8 && "D" === t[e + 1] && "O" === t[e + 2] && "C" === t[e + 3] && "T" === t[e + 4] && "Y" === t[e + 5] && "P" === t[e + 6] && "E" === t[e + 7]) {
				let n = 1;
				for (e += 8; e < t.length; e++) if ("<" === t[e]) n++;
				else if (">" === t[e] && (n--, 0 === n)) break;
			} else if (t.length > e + 9 && "[" === t[e + 1] && "C" === t[e + 2] && "D" === t[e + 3] && "A" === t[e + 4] && "T" === t[e + 5] && "A" === t[e + 6] && "[" === t[e + 7]) {
				for (e += 8; e < t.length; e++) if ("]" === t[e] && "]" === t[e + 1] && ">" === t[e + 2]) {
					e += 2;
					break;
				}
			}
			return e;
		}
		const d = "\"", f = "'";
		function g(t, e) {
			let n = "", i = "", s = !1;
			for (; e < t.length; e++) {
				if (t[e] === d || t[e] === f) "" === i ? i = t[e] : i !== t[e] || (i = "");
				else if (">" === t[e] && "" === i) {
					s = !0;
					break;
				}
				n += t[e];
			}
			return "" === i && {
				value: n,
				index: e,
				tagClosed: s
			};
		}
		const m = /* @__PURE__ */ new RegExp("(\\s*)([^\\s=]+)(\\s*=)?(\\s*(['\"])(([\\s\\S])*?)\\5)?", "g");
		function x(t, e) {
			const n = s(t, m), i = {};
			for (let t = 0; t < n.length; t++) {
				if (0 === n[t][1].length) return b("InvalidAttr", "Attribute '" + n[t][2] + "' has no space in starting.", v(n[t]));
				if (void 0 !== n[t][3] && void 0 === n[t][4]) return b("InvalidAttr", "Attribute '" + n[t][2] + "' is without value.", v(n[t]));
				if (void 0 === n[t][3] && !e.allowBooleanAttributes) return b("InvalidAttr", "boolean attribute '" + n[t][2] + "' is not allowed.", v(n[t]));
				const s = n[t][2];
				if (!y(s)) return b("InvalidAttr", "Attribute '" + s + "' is an invalid name.", v(n[t]));
				if (Object.prototype.hasOwnProperty.call(i, s)) return b("InvalidAttr", "Attribute '" + s + "' is repeated.", v(n[t]));
				i[s] = 1;
			}
			return !0;
		}
		function N(t, e) {
			if (";" === t[++e]) return -1;
			if ("#" === t[e]) return function(t, e) {
				let n = /\d/;
				for ("x" === t[e] && (e++, n = /[\da-fA-F]/); e < t.length; e++) {
					if (";" === t[e]) return e;
					if (!t[e].match(n)) break;
				}
				return -1;
			}(t, ++e);
			let n = 0;
			for (; e < t.length; e++, n++) if (!(t[e].match(/\w/) && n < 20)) {
				if (";" === t[e]) break;
				return -1;
			}
			return e;
		}
		function b(t, e, n) {
			return { err: {
				code: t,
				msg: e,
				line: n.line || n,
				col: n.col
			} };
		}
		function y(t) {
			return r(t);
		}
		function E(t) {
			return r(t);
		}
		function w(t, e) {
			const n = t.substring(0, e).split(/\r?\n/);
			return {
				line: n.length,
				col: n[n.length - 1].length + 1
			};
		}
		function v(t) {
			return t.startIndex + t[1].length;
		}
		const S = (t) => o.includes(t) ? "__" + t : t, _ = {
			preserveOrder: !1,
			attributeNamePrefix: "@_",
			attributesGroupName: !1,
			textNodeName: "#text",
			ignoreAttributes: !0,
			removeNSPrefix: !1,
			allowBooleanAttributes: !1,
			parseTagValue: !0,
			parseAttributeValue: !1,
			trimValues: !0,
			cdataPropName: !1,
			numberParseOptions: {
				hex: !0,
				leadingZeros: !0,
				eNotation: !0
			},
			tagValueProcessor: function(t, e) {
				return e;
			},
			attributeValueProcessor: function(t, e) {
				return e;
			},
			stopNodes: [],
			alwaysCreateTextNode: !1,
			isArray: () => !1,
			commentPropName: !1,
			unpairedTags: [],
			processEntities: !0,
			htmlEntities: !1,
			entityDecoder: null,
			ignoreDeclaration: !1,
			ignorePiTags: !1,
			transformTagName: !1,
			transformAttributeName: !1,
			updateTag: function(t, e, n) {
				return t;
			},
			captureMetaData: !1,
			maxNestedTags: 100,
			strictReservedNames: !0,
			jPath: !0,
			onDangerousProperty: S
		};
		function A(t, e) {
			if ("string" != typeof t) return;
			const n = t.toLowerCase();
			if (o.some((t) => n === t.toLowerCase())) throw new Error(`[SECURITY] Invalid ${e}: "${t}" is a reserved JavaScript keyword that could cause prototype pollution`);
			if (a.some((t) => n === t.toLowerCase())) throw new Error(`[SECURITY] Invalid ${e}: "${t}" is a reserved JavaScript keyword that could cause prototype pollution`);
		}
		function T(t, e) {
			return "boolean" == typeof t ? {
				enabled: t,
				maxEntitySize: 1e4,
				maxExpansionDepth: 1e4,
				maxTotalExpansions: Infinity,
				maxExpandedLength: 1e5,
				maxEntityCount: 1e3,
				allowedTags: null,
				tagFilter: null,
				appliesTo: "all"
			} : "object" == typeof t && null !== t ? {
				enabled: !1 !== t.enabled,
				maxEntitySize: Math.max(1, t.maxEntitySize ?? 1e4),
				maxExpansionDepth: Math.max(1, t.maxExpansionDepth ?? 1e4),
				maxTotalExpansions: Math.max(1, t.maxTotalExpansions ?? Infinity),
				maxExpandedLength: Math.max(1, t.maxExpandedLength ?? 1e5),
				maxEntityCount: Math.max(1, t.maxEntityCount ?? 1e3),
				allowedTags: t.allowedTags ?? null,
				tagFilter: t.tagFilter ?? null,
				appliesTo: t.appliesTo ?? "all"
			} : T(!0);
		}
		const C = function(t) {
			const e = Object.assign({}, _, t), n = [
				{
					value: e.attributeNamePrefix,
					name: "attributeNamePrefix"
				},
				{
					value: e.attributesGroupName,
					name: "attributesGroupName"
				},
				{
					value: e.textNodeName,
					name: "textNodeName"
				},
				{
					value: e.cdataPropName,
					name: "cdataPropName"
				},
				{
					value: e.commentPropName,
					name: "commentPropName"
				}
			];
			for (const { value: t, name: e } of n) t && A(t, e);
			return null === e.onDangerousProperty && (e.onDangerousProperty = S), e.processEntities = T(e.processEntities, e.htmlEntities), e.unpairedTagsSet = new Set(e.unpairedTags), e.stopNodes && Array.isArray(e.stopNodes) && (e.stopNodes = e.stopNodes.map((t) => "string" == typeof t && t.startsWith("*.") ? ".." + t.substring(2) : t)), e;
		};
		let P;
		P = "function" != typeof Symbol ? "@@xmlMetadata" : Symbol("XML Node Metadata");
		class O {
			constructor(t) {
				this.tagname = t, this.child = [], this[":@"] = Object.create(null);
			}
			add(t, e) {
				"__proto__" === t && (t = "#__proto__"), this.child.push({ [t]: e });
			}
			addChild(t, e) {
				"__proto__" === t.tagname && (t.tagname = "#__proto__"), t[":@"] && Object.keys(t[":@"]).length > 0 ? this.child.push({
					[t.tagname]: t.child,
					":@": t[":@"]
				}) : this.child.push({ [t.tagname]: t.child }), void 0 !== e && (this.child[this.child.length - 1][P] = { startIndex: e });
			}
			static getMetaDataSymbol() {
				return P;
			}
		}
		class $ {
			constructor(t) {
				this.suppressValidationErr = !t, this.options = t;
			}
			readDocType(t, e) {
				const n = Object.create(null);
				let i = 0;
				if ("O" !== t[e + 3] || "C" !== t[e + 4] || "T" !== t[e + 5] || "Y" !== t[e + 6] || "P" !== t[e + 7] || "E" !== t[e + 8]) throw new Error("Invalid Tag instead of DOCTYPE");
				{
					e += 9;
					let s = 1, r = !1, o = !1, a = "";
					for (; e < t.length; e++) if ("<" !== t[e] || o) if (">" === t[e]) {
						if (o ? "-" === t[e - 1] && "-" === t[e - 2] && (o = !1, s--) : s--, 0 === s) break;
					} else "[" === t[e] ? r = !0 : a += t[e];
					else {
						if (r && D(t, "!ENTITY", e)) {
							let s, r;
							if (e += 7, [s, r, e] = this.readEntityExp(t, e + 1, this.suppressValidationErr), -1 === r.indexOf("&")) {
								if (!1 !== this.options.enabled && null != this.options.maxEntityCount && i >= this.options.maxEntityCount) throw new Error(`Entity count (${i + 1}) exceeds maximum allowed (${this.options.maxEntityCount})`);
								n[s] = r, i++;
							}
						} else if (r && D(t, "!ELEMENT", e)) {
							e += 8;
							const { index: n } = this.readElementExp(t, e + 1);
							e = n;
						} else if (r && D(t, "!ATTLIST", e)) e += 8;
						else if (r && D(t, "!NOTATION", e)) {
							e += 9;
							const { index: n } = this.readNotationExp(t, e + 1, this.suppressValidationErr);
							e = n;
						} else {
							if (!D(t, "!--", e)) throw new Error("Invalid DOCTYPE");
							o = !0;
						}
						s++, a = "";
					}
					if (0 !== s) throw new Error("Unclosed DOCTYPE");
				}
				return {
					entities: n,
					i: e
				};
			}
			readEntityExp(t, e) {
				const n = e = I(t, e);
				for (; e < t.length && !/\s/.test(t[e]) && "\"" !== t[e] && "'" !== t[e];) e++;
				let i = t.substring(n, e);
				if (M(i), e = I(t, e), !this.suppressValidationErr) {
					if ("SYSTEM" === t.substring(e, e + 6).toUpperCase()) throw new Error("External entities are not supported");
					if ("%" === t[e]) throw new Error("Parameter entities are not supported");
				}
				let s = "";
				if ([e, s] = this.readIdentifierVal(t, e, "entity"), !1 !== this.options.enabled && null != this.options.maxEntitySize && s.length > this.options.maxEntitySize) throw new Error(`Entity "${i}" size (${s.length}) exceeds maximum allowed size (${this.options.maxEntitySize})`);
				return [
					i,
					s,
					--e
				];
			}
			readNotationExp(t, e) {
				const n = e = I(t, e);
				for (; e < t.length && !/\s/.test(t[e]);) e++;
				let i = t.substring(n, e);
				!this.suppressValidationErr && M(i), e = I(t, e);
				const s = t.substring(e, e + 6).toUpperCase();
				if (!this.suppressValidationErr && "SYSTEM" !== s && "PUBLIC" !== s) throw new Error(`Expected SYSTEM or PUBLIC, found "${s}"`);
				e += s.length, e = I(t, e);
				let r = null, o = null;
				if ("PUBLIC" === s) [e, r] = this.readIdentifierVal(t, e, "publicIdentifier"), "\"" !== t[e = I(t, e)] && "'" !== t[e] || ([e, o] = this.readIdentifierVal(t, e, "systemIdentifier"));
				else if ("SYSTEM" === s && ([e, o] = this.readIdentifierVal(t, e, "systemIdentifier"), !this.suppressValidationErr && !o)) throw new Error("Missing mandatory system identifier for SYSTEM notation");
				return {
					notationName: i,
					publicIdentifier: r,
					systemIdentifier: o,
					index: --e
				};
			}
			readIdentifierVal(t, e, n) {
				let i = "";
				const s = t[e];
				if ("\"" !== s && "'" !== s) throw new Error(`Expected quoted string, found "${s}"`);
				const r = ++e;
				for (; e < t.length && t[e] !== s;) e++;
				if (i = t.substring(r, e), t[e] !== s) throw new Error(`Unterminated ${n} value`);
				return [++e, i];
			}
			readElementExp(t, e) {
				const n = e = I(t, e);
				for (; e < t.length && !/\s/.test(t[e]);) e++;
				let i = t.substring(n, e);
				if (!this.suppressValidationErr && !r(i)) throw new Error(`Invalid element name: "${i}"`);
				let s = "";
				if ("E" === t[e = I(t, e)] && D(t, "MPTY", e)) e += 4;
				else if ("A" === t[e] && D(t, "NY", e)) e += 2;
				else if ("(" === t[e]) {
					const n = ++e;
					for (; e < t.length && ")" !== t[e];) e++;
					if (s = t.substring(n, e), ")" !== t[e]) throw new Error("Unterminated content model");
				} else if (!this.suppressValidationErr) throw new Error(`Invalid Element Expression, found "${t[e]}"`);
				return {
					elementName: i,
					contentModel: s.trim(),
					index: e
				};
			}
			readAttlistExp(t, e) {
				let n = e = I(t, e);
				for (; e < t.length && !/\s/.test(t[e]);) e++;
				let i = t.substring(n, e);
				for (M(i), n = e = I(t, e); e < t.length && !/\s/.test(t[e]);) e++;
				let s = t.substring(n, e);
				if (!M(s)) throw new Error(`Invalid attribute name: "${s}"`);
				e = I(t, e);
				let r = "";
				if ("NOTATION" === t.substring(e, e + 8).toUpperCase()) {
					if (r = "NOTATION", "(" !== t[e = I(t, e += 8)]) throw new Error(`Expected '(', found "${t[e]}"`);
					e++;
					let n = [];
					for (; e < t.length && ")" !== t[e];) {
						const i = e;
						for (; e < t.length && "|" !== t[e] && ")" !== t[e];) e++;
						let s = t.substring(i, e);
						if (s = s.trim(), !M(s)) throw new Error(`Invalid notation name: "${s}"`);
						n.push(s), "|" === t[e] && (e++, e = I(t, e));
					}
					if (")" !== t[e]) throw new Error("Unterminated list of notations");
					e++, r += " (" + n.join("|") + ")";
				} else {
					const n = e;
					for (; e < t.length && !/\s/.test(t[e]);) e++;
					r += t.substring(n, e);
					if (!this.suppressValidationErr && ![
						"CDATA",
						"ID",
						"IDREF",
						"IDREFS",
						"ENTITY",
						"ENTITIES",
						"NMTOKEN",
						"NMTOKENS"
					].includes(r.toUpperCase())) throw new Error(`Invalid attribute type: "${r}"`);
				}
				e = I(t, e);
				let o = "";
				return "#REQUIRED" === t.substring(e, e + 8).toUpperCase() ? (o = "#REQUIRED", e += 8) : "#IMPLIED" === t.substring(e, e + 7).toUpperCase() ? (o = "#IMPLIED", e += 7) : [e, o] = this.readIdentifierVal(t, e, "ATTLIST"), {
					elementName: i,
					attributeName: s,
					attributeType: r,
					defaultValue: o,
					index: e
				};
			}
		}
		const I = (t, e) => {
			for (; e < t.length && /\s/.test(t[e]);) e++;
			return e;
		};
		function D(t, e, n) {
			for (let i = 0; i < e.length; i++) if (e[i] !== t[n + i + 1]) return !1;
			return !0;
		}
		function M(t) {
			if (r(t)) return t;
			throw new Error(`Invalid entity name ${t}`);
		}
		const j = /^[-+]?0x[a-fA-F0-9]+$/, V = /^([\-\+])?(0*)([0-9]*(\.[0-9]*)?)$/, L = {
			hex: !0,
			leadingZeros: !0,
			decimalPoint: ".",
			eNotation: !0,
			infinity: "original"
		};
		const k = /^([-+])?(0*)(\d*(\.\d*)?[eE][-\+]?\d+)$/;
		class F {
			constructor(t) {
				this._matcher = t;
			}
			get separator() {
				return this._matcher.separator;
			}
			getCurrentTag() {
				const t = this._matcher.path;
				return t.length > 0 ? t[t.length - 1].tag : void 0;
			}
			getCurrentNamespace() {
				const t = this._matcher.path;
				return t.length > 0 ? t[t.length - 1].namespace : void 0;
			}
			getAttrValue(t) {
				const e = this._matcher.path;
				if (0 !== e.length) return e[e.length - 1].values?.[t];
			}
			hasAttr(t) {
				const e = this._matcher.path;
				if (0 === e.length) return !1;
				const n = e[e.length - 1];
				return void 0 !== n.values && t in n.values;
			}
			getPosition() {
				const t = this._matcher.path;
				return 0 === t.length ? -1 : t[t.length - 1].position ?? 0;
			}
			getCounter() {
				const t = this._matcher.path;
				return 0 === t.length ? -1 : t[t.length - 1].counter ?? 0;
			}
			getIndex() {
				return this.getPosition();
			}
			getDepth() {
				return this._matcher.path.length;
			}
			toString(t, e = !0) {
				return this._matcher.toString(t, e);
			}
			toArray() {
				return this._matcher.path.map((t) => t.tag);
			}
			matches(t) {
				return this._matcher.matches(t);
			}
			matchesAny(t) {
				return t.matchesAny(this._matcher);
			}
		}
		class R {
			constructor(t = {}) {
				this.separator = t.separator || ".", this.path = [], this.siblingStacks = [], this._pathStringCache = null, this._view = new F(this);
			}
			push(t, e = null, n = null) {
				this._pathStringCache = null, this.path.length > 0 && (this.path[this.path.length - 1].values = void 0);
				const i = this.path.length;
				this.siblingStacks[i] || (this.siblingStacks[i] = /* @__PURE__ */ new Map());
				const s = this.siblingStacks[i], r = n ? `${n}:${t}` : t, o = s.get(r) || 0;
				let a = 0;
				for (const t of s.values()) a += t;
				s.set(r, o + 1);
				const h = {
					tag: t,
					position: a,
					counter: o
				};
				null != n && (h.namespace = n), null != e && (h.values = e), this.path.push(h);
			}
			pop() {
				if (0 === this.path.length) return;
				this._pathStringCache = null;
				const t = this.path.pop();
				return this.siblingStacks.length > this.path.length + 1 && (this.siblingStacks.length = this.path.length + 1), t;
			}
			updateCurrent(t) {
				if (this.path.length > 0) {
					const e = this.path[this.path.length - 1];
					null != t && (e.values = t);
				}
			}
			getCurrentTag() {
				return this.path.length > 0 ? this.path[this.path.length - 1].tag : void 0;
			}
			getCurrentNamespace() {
				return this.path.length > 0 ? this.path[this.path.length - 1].namespace : void 0;
			}
			getAttrValue(t) {
				if (0 !== this.path.length) return this.path[this.path.length - 1].values?.[t];
			}
			hasAttr(t) {
				if (0 === this.path.length) return !1;
				const e = this.path[this.path.length - 1];
				return void 0 !== e.values && t in e.values;
			}
			getPosition() {
				return 0 === this.path.length ? -1 : this.path[this.path.length - 1].position ?? 0;
			}
			getCounter() {
				return 0 === this.path.length ? -1 : this.path[this.path.length - 1].counter ?? 0;
			}
			getIndex() {
				return this.getPosition();
			}
			getDepth() {
				return this.path.length;
			}
			toString(t, e = !0) {
				const n = t || this.separator;
				if (n === this.separator && !0 === e) {
					if (null !== this._pathStringCache) return this._pathStringCache;
					const t = this.path.map((t) => t.namespace ? `${t.namespace}:${t.tag}` : t.tag).join(n);
					return this._pathStringCache = t, t;
				}
				return this.path.map((t) => e && t.namespace ? `${t.namespace}:${t.tag}` : t.tag).join(n);
			}
			toArray() {
				return this.path.map((t) => t.tag);
			}
			reset() {
				this._pathStringCache = null, this.path = [], this.siblingStacks = [];
			}
			matches(t) {
				const e = t.segments;
				return 0 !== e.length && (t.hasDeepWildcard() ? this._matchWithDeepWildcard(e) : this._matchSimple(e));
			}
			_matchSimple(t) {
				if (this.path.length !== t.length) return !1;
				for (let e = 0; e < t.length; e++) if (!this._matchSegment(t[e], this.path[e], e === this.path.length - 1)) return !1;
				return !0;
			}
			_matchWithDeepWildcard(t) {
				let e = this.path.length - 1, n = t.length - 1;
				for (; n >= 0 && e >= 0;) {
					const i = t[n];
					if ("deep-wildcard" === i.type) {
						if (n--, n < 0) return !0;
						const i = t[n];
						let s = !1;
						for (let t = e; t >= 0; t--) if (this._matchSegment(i, this.path[t], t === this.path.length - 1)) {
							e = t - 1, n--, s = !0;
							break;
						}
						if (!s) return !1;
					} else {
						if (!this._matchSegment(i, this.path[e], e === this.path.length - 1)) return !1;
						e--, n--;
					}
				}
				return n < 0;
			}
			_matchSegment(t, e, n) {
				if ("*" !== t.tag && t.tag !== e.tag) return !1;
				if (void 0 !== t.namespace && "*" !== t.namespace && t.namespace !== e.namespace) return !1;
				if (void 0 !== t.attrName) {
					if (!n) return !1;
					if (!e.values || !(t.attrName in e.values)) return !1;
					if (void 0 !== t.attrValue && String(e.values[t.attrName]) !== String(t.attrValue)) return !1;
				}
				if (void 0 !== t.position) {
					if (!n) return !1;
					const i = e.counter ?? 0;
					if ("first" === t.position && 0 !== i) return !1;
					if ("odd" === t.position && i % 2 != 1) return !1;
					if ("even" === t.position && i % 2 != 0) return !1;
					if ("nth" === t.position && i !== t.positionValue) return !1;
				}
				return !0;
			}
			matchesAny(t) {
				return t.matchesAny(this);
			}
			snapshot() {
				return {
					path: this.path.map((t) => ({ ...t })),
					siblingStacks: this.siblingStacks.map((t) => new Map(t))
				};
			}
			restore(t) {
				this._pathStringCache = null, this.path = t.path.map((t) => ({ ...t })), this.siblingStacks = t.siblingStacks.map((t) => new Map(t));
			}
			readOnly() {
				return this._view;
			}
		}
		class G {
			constructor(t, e = {}, n) {
				this.pattern = t, this.separator = e.separator || ".", this.segments = this._parse(t), this.data = n, this._hasDeepWildcard = this.segments.some((t) => "deep-wildcard" === t.type), this._hasAttributeCondition = this.segments.some((t) => void 0 !== t.attrName), this._hasPositionSelector = this.segments.some((t) => void 0 !== t.position);
			}
			_parse(t) {
				const e = [];
				let n = 0, i = "";
				for (; n < t.length;) t[n] === this.separator ? n + 1 < t.length && t[n + 1] === this.separator ? (i.trim() && (e.push(this._parseSegment(i.trim())), i = ""), e.push({ type: "deep-wildcard" }), n += 2) : (i.trim() && e.push(this._parseSegment(i.trim())), i = "", n++) : (i += t[n], n++);
				return i.trim() && e.push(this._parseSegment(i.trim())), e;
			}
			_parseSegment(t) {
				const e = { type: "tag" };
				let n = null, i = t;
				const s = t.match(/^([^\[]+)(\[[^\]]*\])(.*)$/);
				if (s && (i = s[1] + s[3], s[2])) {
					const t = s[2].slice(1, -1);
					t && (n = t);
				}
				let r, o, a = i;
				if (i.includes("::")) {
					const e = i.indexOf("::");
					if (r = i.substring(0, e).trim(), a = i.substring(e + 2).trim(), !r) throw new Error(`Invalid namespace in pattern: ${t}`);
				}
				let h = null;
				if (a.includes(":")) {
					const t = a.lastIndexOf(":"), e = a.substring(0, t).trim(), n = a.substring(t + 1).trim();
					[
						"first",
						"last",
						"odd",
						"even"
					].includes(n) || /^nth\(\d+\)$/.test(n) ? (o = e, h = n) : o = a;
				} else o = a;
				if (!o) throw new Error(`Invalid segment pattern: ${t}`);
				if (e.tag = o, r && (e.namespace = r), n) if (n.includes("=")) {
					const t = n.indexOf("=");
					e.attrName = n.substring(0, t).trim(), e.attrValue = n.substring(t + 1).trim();
				} else e.attrName = n.trim();
				if (h) {
					const t = h.match(/^nth\((\d+)\)$/);
					t ? (e.position = "nth", e.positionValue = parseInt(t[1], 10)) : e.position = h;
				}
				return e;
			}
			get length() {
				return this.segments.length;
			}
			hasDeepWildcard() {
				return this._hasDeepWildcard;
			}
			hasAttributeCondition() {
				return this._hasAttributeCondition;
			}
			hasPositionSelector() {
				return this._hasPositionSelector;
			}
			toString() {
				return this.pattern;
			}
		}
		class B {
			constructor() {
				this._byDepthAndTag = /* @__PURE__ */ new Map(), this._wildcardByDepth = /* @__PURE__ */ new Map(), this._deepWildcards = [], this._patterns = /* @__PURE__ */ new Set(), this._sealed = !1;
			}
			add(t) {
				if (this._sealed) throw new TypeError("ExpressionSet is sealed. Create a new ExpressionSet to add more expressions.");
				if (this._patterns.has(t.pattern)) return this;
				if (this._patterns.add(t.pattern), t.hasDeepWildcard()) return this._deepWildcards.push(t), this;
				const e = t.length, i = t.segments[t.segments.length - 1]?.tag;
				if (i && "*" !== i) {
					const n = `${e}:${i}`;
					this._byDepthAndTag.has(n) || this._byDepthAndTag.set(n, []), this._byDepthAndTag.get(n).push(t);
				} else this._wildcardByDepth.has(e) || this._wildcardByDepth.set(e, []), this._wildcardByDepth.get(e).push(t);
				return this;
			}
			addAll(t) {
				for (const e of t) this.add(e);
				return this;
			}
			has(t) {
				return this._patterns.has(t.pattern);
			}
			get size() {
				return this._patterns.size;
			}
			seal() {
				return this._sealed = !0, this;
			}
			get isSealed() {
				return this._sealed;
			}
			matchesAny(t) {
				return null !== this.findMatch(t);
			}
			findMatch(t) {
				const e = t.getDepth(), n = `${e}:${t.getCurrentTag()}`, i = this._byDepthAndTag.get(n);
				if (i) {
					for (let e = 0; e < i.length; e++) if (t.matches(i[e])) return i[e];
				}
				const s = this._wildcardByDepth.get(e);
				if (s) {
					for (let e = 0; e < s.length; e++) if (t.matches(s[e])) return s[e];
				}
				for (let e = 0; e < this._deepWildcards.length; e++) if (t.matches(this._deepWildcards[e])) return this._deepWildcards[e];
				return null;
			}
		}
		const U = {
			cent: "¢",
			pound: "£",
			curren: "¤",
			yen: "¥",
			euro: "€",
			dollar: "$",
			euro: "€",
			fnof: "ƒ",
			inr: "₹",
			af: "؋",
			birr: "ብር",
			peso: "₱",
			rub: "₽",
			won: "₩",
			yuan: "¥",
			cedil: "¸"
		}, W = {
			amp: "&",
			apos: "'",
			gt: ">",
			lt: "<",
			quot: "\""
		}, X = {
			nbsp: "\xA0",
			copy: "©",
			reg: "®",
			trade: "™",
			mdash: "—",
			ndash: "–",
			hellip: "…",
			laquo: "«",
			raquo: "»",
			lsquo: "‘",
			rsquo: "’",
			ldquo: "“",
			rdquo: "”",
			bull: "•",
			para: "¶",
			sect: "§",
			deg: "°",
			frac12: "½",
			frac14: "¼",
			frac34: "¾"
		}, Y = /* @__PURE__ */ new Set("!?\\\\/[]$%{}^&*()<>|+");
		function z(t) {
			if ("#" === t[0]) throw new Error(`[EntityReplacer] Invalid character '#' in entity name: "${t}"`);
			for (const e of t) if (Y.has(e)) throw new Error(`[EntityReplacer] Invalid character '${e}' in entity name: "${t}"`);
			return t;
		}
		function q(...t) {
			const e = Object.create(null);
			for (const n of t) if (n) for (const t of Object.keys(n)) {
				const i = n[t];
				if ("string" == typeof i) e[t] = i;
				else if (i && "object" == typeof i && void 0 !== i.val) {
					const n = i.val;
					"string" == typeof n && (e[t] = n);
				}
			}
			return e;
		}
		const Z = "external", J = "base", K = "all", Q = Object.freeze({
			allow: 0,
			leave: 1,
			remove: 2,
			throw: 3
		}), H = new Set([
			9,
			10,
			13
		]);
		class tt {
			constructor(t = {}) {
				var e;
				this._limit = t.limit || {}, this._maxTotalExpansions = this._limit.maxTotalExpansions || 0, this._maxExpandedLength = this._limit.maxExpandedLength || 0, this._postCheck = "function" == typeof t.postCheck ? t.postCheck : (t) => t, this._limitTiers = (e = this._limit.applyLimitsTo ?? Z) && e !== Z ? e === K ? new Set([K]) : e === J ? new Set([J]) : Array.isArray(e) ? new Set(e) : new Set([Z]) : new Set([Z]), this._numericAllowed = t.numericAllowed ?? !0, this._baseMap = q(W, t.namedEntities || null), this._externalMap = Object.create(null), this._inputMap = Object.create(null), this._totalExpansions = 0, this._expandedLength = 0, this._removeSet = new Set(t.remove && Array.isArray(t.remove) ? t.remove : []), this._leaveSet = new Set(t.leave && Array.isArray(t.leave) ? t.leave : []);
				const n = function(t) {
					if (!t) return {
						xmlVersion: 1,
						onLevel: Q.allow,
						nullLevel: Q.remove
					};
					const e = 1.1 === t.xmlVersion ? 1.1 : 1, n = Q[t.onNCR] ?? Q.allow, i = Q[t.nullNCR] ?? Q.remove;
					return {
						xmlVersion: e,
						onLevel: n,
						nullLevel: Math.max(i, Q.remove)
					};
				}(t.ncr);
				this._ncrXmlVersion = n.xmlVersion, this._ncrOnLevel = n.onLevel, this._ncrNullLevel = n.nullLevel;
			}
			setExternalEntities(t) {
				if (t) for (const e of Object.keys(t)) z(e);
				this._externalMap = q(t);
			}
			addExternalEntity(t, e) {
				z(t), "string" == typeof e && -1 === e.indexOf("&") && (this._externalMap[t] = e);
			}
			addInputEntities(t) {
				this._totalExpansions = 0, this._expandedLength = 0, this._inputMap = q(t);
			}
			reset() {
				return this._inputMap = Object.create(null), this._totalExpansions = 0, this._expandedLength = 0, this;
			}
			setXmlVersion(t) {
				this._ncrXmlVersion = 1.1 === t ? 1.1 : 1;
			}
			decode(t) {
				if ("string" != typeof t || 0 === t.length) return t;
				const e = t, n = [], i = t.length;
				let s = 0, r = 0;
				const o = this._maxTotalExpansions > 0, a = this._maxExpandedLength > 0, h = o || a;
				for (; r < i;) {
					if (38 !== t.charCodeAt(r)) {
						r++;
						continue;
					}
					let e = r + 1;
					for (; e < i && 59 !== t.charCodeAt(e) && e - r <= 32;) e++;
					if (e >= i || 59 !== t.charCodeAt(e)) {
						r++;
						continue;
					}
					const l = t.slice(r + 1, e);
					if (0 === l.length) {
						r++;
						continue;
					}
					let u, p;
					if (this._removeSet.has(l)) u = "", void 0 === p && (p = Z);
					else {
						if (this._leaveSet.has(l)) {
							r++;
							continue;
						}
						if (35 === l.charCodeAt(0)) {
							const t = this._resolveNCR(l);
							if (void 0 === t) {
								r++;
								continue;
							}
							u = t, p = J;
						} else {
							const t = this._resolveName(l);
							u = t?.value, p = t?.tier;
						}
					}
					if (void 0 !== u) {
						if (r > s && n.push(t.slice(s, r)), n.push(u), s = e + 1, r = s, h && this._tierCounts(p)) {
							if (o && (this._totalExpansions++, this._totalExpansions > this._maxTotalExpansions)) throw new Error(`[EntityReplacer] Entity expansion count limit exceeded: ${this._totalExpansions} > ${this._maxTotalExpansions}`);
							if (a) {
								const t = u.length - (l.length + 2);
								if (t > 0 && (this._expandedLength += t, this._expandedLength > this._maxExpandedLength)) throw new Error(`[EntityReplacer] Expanded content length limit exceeded: ${this._expandedLength} > ${this._maxExpandedLength}`);
							}
						}
					} else r++;
				}
				s < i && n.push(t.slice(s));
				const l = 0 === n.length ? t : n.join("");
				return this._postCheck(l, e);
			}
			_tierCounts(t) {
				return !!this._limitTiers.has(K) || this._limitTiers.has(t);
			}
			_resolveName(t) {
				return t in this._inputMap ? {
					value: this._inputMap[t],
					tier: Z
				} : t in this._externalMap ? {
					value: this._externalMap[t],
					tier: Z
				} : t in this._baseMap ? {
					value: this._baseMap[t],
					tier: J
				} : void 0;
			}
			_classifyNCR(t) {
				return 0 === t ? this._ncrNullLevel : t >= 55296 && t <= 57343 || 1 === this._ncrXmlVersion && t >= 1 && t <= 31 && !H.has(t) ? Q.remove : -1;
			}
			_applyNCRAction(t, e, n) {
				switch (t) {
					case Q.allow: return String.fromCodePoint(n);
					case Q.remove: return "";
					case Q.leave: return;
					case Q.throw: throw new Error(`[EntityDecoder] Prohibited numeric character reference &${e}; (U+${n.toString(16).toUpperCase().padStart(4, "0")})`);
					default: return String.fromCodePoint(n);
				}
			}
			_resolveNCR(t) {
				const e = t.charCodeAt(1);
				let n;
				if (n = 120 === e || 88 === e ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10), Number.isNaN(n) || n < 0 || n > 1114111) return;
				const i = this._classifyNCR(n);
				if (!this._numericAllowed && i < Q.remove) return;
				const s = -1 === i ? this._ncrOnLevel : Math.max(this._ncrOnLevel, i);
				return this._applyNCRAction(s, t, n);
			}
		}
		function et(t, e) {
			if (!t) return {};
			const n = e.attributesGroupName ? t[e.attributesGroupName] : t;
			if (!n) return {};
			const i = {};
			for (const t in n) t.startsWith(e.attributeNamePrefix) ? i[t.substring(e.attributeNamePrefix.length)] = n[t] : i[t] = n[t];
			return i;
		}
		function nt(t) {
			if (!t || "string" != typeof t) return;
			const e = t.indexOf(":");
			if (-1 !== e && e > 0) {
				const n = t.substring(0, e);
				if ("xmlns" !== n) return n;
			}
		}
		class it {
			constructor(t) {
				var e;
				this.options = t, this.currentNode = null, this.tagsNodeStack = [], this.parseXml = ht, this.parseTextData = st, this.resolveNameSpace = rt, this.buildAttributesMap = at, this.isItStopNode = ct, this.replaceEntitiesValue = ut, this.readStopNodeData = mt, this.saveTextToParentTag = pt, this.addChild = lt, this.ignoreAttributesFn = "function" == typeof (e = this.options.ignoreAttributes) ? e : Array.isArray(e) ? (t) => {
					for (const n of e) {
						if ("string" == typeof n && t === n) return !0;
						if (n instanceof RegExp && n.test(t)) return !0;
					}
				} : () => !1, this.entityExpansionCount = 0, this.currentExpandedLength = 0;
				let n = { ...W };
				this.options.entityDecoder ? this.entityDecoder = this.options.entityDecoder : ("object" == typeof this.options.htmlEntities ? n = this.options.htmlEntities : !0 === this.options.htmlEntities && (n = {
					...X,
					...U
				}), this.entityDecoder = new tt({
					namedEntities: n,
					numericAllowed: this.options.htmlEntities,
					limit: {
						maxTotalExpansions: this.options.processEntities.maxTotalExpansions,
						maxExpandedLength: this.options.processEntities.maxExpandedLength,
						applyLimitsTo: this.options.processEntities.appliesTo
					}
				})), this.matcher = new R(), this.readonlyMatcher = this.matcher.readOnly(), this.isCurrentNodeStopNode = !1, this.stopNodeExpressionsSet = new B();
				const i = this.options.stopNodes;
				if (i && i.length > 0) {
					for (let t = 0; t < i.length; t++) {
						const e = i[t];
						"string" == typeof e ? this.stopNodeExpressionsSet.add(new G(e)) : e instanceof G && this.stopNodeExpressionsSet.add(e);
					}
					this.stopNodeExpressionsSet.seal();
				}
			}
		}
		function st(t, e, n, i, s, r, o) {
			const a = this.options;
			if (void 0 !== t && (a.trimValues && !i && (t = t.trim()), t.length > 0)) {
				o || (t = this.replaceEntitiesValue(t, e, n));
				const i = a.jPath ? n.toString() : n, h = a.tagValueProcessor(e, t, i, s, r);
				return null == h ? t : typeof h != typeof t || h !== t ? h : a.trimValues || t.trim() === t ? xt(t, a.parseTagValue, a.numberParseOptions) : t;
			}
		}
		function rt(t) {
			if (this.options.removeNSPrefix) {
				const e = t.split(":"), n = "/" === t.charAt(0) ? "/" : "";
				if ("xmlns" === e[0]) return "";
				2 === e.length && (t = n + e[1]);
			}
			return t;
		}
		const ot = /* @__PURE__ */ new RegExp("([^\\s=]+)\\s*(=\\s*(['\"])([\\s\\S]*?)\\3)?", "gm");
		function at(t, e, n, i = !1) {
			const r = this.options;
			if (!0 === i || !0 !== r.ignoreAttributes && "string" == typeof t) {
				const i = s(t, ot), o = i.length, a = {}, h = new Array(o);
				let l = !1;
				const u = {};
				for (let t = 0; t < o; t++) {
					const e = this.resolveNameSpace(i[t][1]), s = i[t][4];
					if (e.length && void 0 !== s) {
						let i = s;
						r.trimValues && (i = i.trim()), i = this.replaceEntitiesValue(i, n, this.readonlyMatcher), h[t] = i, u[e] = i, l = !0;
					}
				}
				l && "object" == typeof e && e.updateCurrent && e.updateCurrent(u);
				const p = r.jPath ? e.toString() : this.readonlyMatcher;
				let c = !1;
				for (let t = 0; t < o; t++) {
					const e = this.resolveNameSpace(i[t][1]);
					if (this.ignoreAttributesFn(e, p)) continue;
					let n = r.attributeNamePrefix + e;
					if (e.length) if (r.transformAttributeName && (n = r.transformAttributeName(n)), n = bt(n, r), void 0 !== i[t][4]) {
						const i = h[t], s = r.attributeValueProcessor(e, i, p);
						a[n] = null == s ? i : typeof s != typeof i || s !== i ? s : xt(i, r.parseAttributeValue, r.numberParseOptions), c = !0;
					} else r.allowBooleanAttributes && (a[n] = !0, c = !0);
				}
				if (!c) return;
				if (r.attributesGroupName) {
					const t = {};
					return t[r.attributesGroupName] = a, t;
				}
				return a;
			}
		}
		const ht = function(t) {
			t = t.replace(/\r\n?/g, "\n");
			const e = new O("!xml");
			let n = e, i = "";
			this.matcher.reset(), this.entityDecoder.reset(), this.entityExpansionCount = 0, this.currentExpandedLength = 0;
			const s = this.options, r = new $(s.processEntities), o = t.length;
			for (let a = 0; a < o; a++) if ("<" === t[a]) {
				const h = t.charCodeAt(a + 1);
				if (47 === h) {
					const e = dt(t, ">", a, "Closing Tag is not closed.");
					let r = t.substring(a + 2, e).trim();
					if (s.removeNSPrefix) {
						const t = r.indexOf(":");
						-1 !== t && (r = r.substr(t + 1));
					}
					r = Nt(s.transformTagName, r, "", s).tagName, n && (i = this.saveTextToParentTag(i, n, this.readonlyMatcher));
					const o = this.matcher.getCurrentTag();
					if (r && s.unpairedTagsSet.has(r)) throw new Error(`Unpaired tag can not be used as closing tag: </${r}>`);
					o && s.unpairedTagsSet.has(o) && (this.matcher.pop(), this.tagsNodeStack.pop()), this.matcher.pop(), this.isCurrentNodeStopNode = !1, n = this.tagsNodeStack.pop(), i = "", a = e;
				} else if (63 === h) {
					let e = gt(t, a, !1, "?>");
					if (!e) throw new Error("Pi Tag is not closed.");
					i = this.saveTextToParentTag(i, n, this.readonlyMatcher);
					const r = this.buildAttributesMap(e.tagExp, this.matcher, e.tagName, !0);
					if (r) {
						const t = r[this.options.attributeNamePrefix + "version"];
						this.entityDecoder.setXmlVersion(Number(t) || 1);
					}
					if (s.ignoreDeclaration && "?xml" === e.tagName || s.ignorePiTags);
					else {
						const t = new O(e.tagName);
						t.add(s.textNodeName, ""), e.tagName !== e.tagExp && e.attrExpPresent && !0 !== s.ignoreAttributes && (t[":@"] = r), this.addChild(n, t, this.readonlyMatcher, a);
					}
					a = e.closeIndex + 1;
				} else if (33 === h && 45 === t.charCodeAt(a + 2) && 45 === t.charCodeAt(a + 3)) {
					const e = dt(t, "-->", a + 4, "Comment is not closed.");
					if (s.commentPropName) {
						const r = t.substring(a + 4, e - 2);
						i = this.saveTextToParentTag(i, n, this.readonlyMatcher), n.add(s.commentPropName, [{ [s.textNodeName]: r }]);
					}
					a = e;
				} else if (33 === h && 68 === t.charCodeAt(a + 2)) {
					const e = r.readDocType(t, a);
					this.entityDecoder.addInputEntities(e.entities), a = e.i;
				} else if (33 === h && 91 === t.charCodeAt(a + 2)) {
					const e = dt(t, "]]>", a, "CDATA is not closed.") - 2, r = t.substring(a + 9, e);
					i = this.saveTextToParentTag(i, n, this.readonlyMatcher);
					let o = this.parseTextData(r, n.tagname, this.readonlyMatcher, !0, !1, !0, !0);
					o ??= "", s.cdataPropName ? n.add(s.cdataPropName, [{ [s.textNodeName]: r }]) : n.add(s.textNodeName, o), a = e + 2;
				} else {
					let r = gt(t, a, s.removeNSPrefix);
					if (!r) {
						const e = t.substring(Math.max(0, a - 50), Math.min(o, a + 50));
						throw new Error(`readTagExp returned undefined at position ${a}. Context: "${e}"`);
					}
					let h = r.tagName;
					const l = r.rawTagName;
					let u = r.tagExp, p = r.attrExpPresent, c = r.closeIndex;
					if ({tagName: h, tagExp: u} = Nt(s.transformTagName, h, u, s), s.strictReservedNames && (h === s.commentPropName || h === s.cdataPropName || h === s.textNodeName || h === s.attributesGroupName)) throw new Error(`Invalid tag name: ${h}`);
					n && i && "!xml" !== n.tagname && (i = this.saveTextToParentTag(i, n, this.readonlyMatcher, !1));
					const d = n;
					d && s.unpairedTagsSet.has(d.tagname) && (n = this.tagsNodeStack.pop(), this.matcher.pop());
					let f = !1;
					u.length > 0 && u.lastIndexOf("/") === u.length - 1 && (f = !0, "/" === h[h.length - 1] ? (h = h.substr(0, h.length - 1), u = h) : u = u.substr(0, u.length - 1), p = h !== u);
					let g, m = null;
					g = nt(l), h !== e.tagname && this.matcher.push(h, {}, g), h !== u && p && (m = this.buildAttributesMap(u, this.matcher, h), m && et(m, s)), h !== e.tagname && (this.isCurrentNodeStopNode = this.isItStopNode());
					const N = a;
					if (this.isCurrentNodeStopNode) {
						let e = "";
						if (f) a = r.closeIndex;
						else if (s.unpairedTagsSet.has(h)) a = r.closeIndex;
						else {
							const n = this.readStopNodeData(t, l, c + 1);
							if (!n) throw new Error(`Unexpected end of ${l}`);
							a = n.i, e = n.tagContent;
						}
						const i = new O(h);
						m && (i[":@"] = m), i.add(s.textNodeName, e), this.matcher.pop(), this.isCurrentNodeStopNode = !1, this.addChild(n, i, this.readonlyMatcher, N);
					} else {
						if (f) {
							({tagName: h, tagExp: u} = Nt(s.transformTagName, h, u, s));
							const t = new O(h);
							m && (t[":@"] = m), this.addChild(n, t, this.readonlyMatcher, N), this.matcher.pop(), this.isCurrentNodeStopNode = !1;
						} else {
							if (s.unpairedTagsSet.has(h)) {
								const t = new O(h);
								m && (t[":@"] = m), this.addChild(n, t, this.readonlyMatcher, N), this.matcher.pop(), this.isCurrentNodeStopNode = !1, a = r.closeIndex;
								continue;
							}
							{
								const t = new O(h);
								if (this.tagsNodeStack.length > s.maxNestedTags) throw new Error("Maximum nested tags exceeded");
								this.tagsNodeStack.push(n), m && (t[":@"] = m), this.addChild(n, t, this.readonlyMatcher, N), n = t;
							}
						}
						i = "", a = c;
					}
				}
			} else i += t[a];
			return e.child;
		};
		function lt(t, e, n, i) {
			this.options.captureMetaData || (i = void 0);
			const s = this.options.jPath ? n.toString() : n, r = this.options.updateTag(e.tagname, s, e[":@"]);
			!1 === r || ("string" == typeof r ? (e.tagname = r, t.addChild(e, i)) : t.addChild(e, i));
		}
		function ut(t, e, n) {
			const i = this.options.processEntities;
			if (!i || !i.enabled) return t;
			if (i.allowedTags) {
				const s = this.options.jPath ? n.toString() : n;
				if (!(Array.isArray(i.allowedTags) ? i.allowedTags.includes(e) : i.allowedTags(e, s))) return t;
			}
			if (i.tagFilter) {
				const s = this.options.jPath ? n.toString() : n;
				if (!i.tagFilter(e, s)) return t;
			}
			return this.entityDecoder.decode(t);
		}
		function pt(t, e, n, i) {
			return t && (void 0 === i && (i = 0 === e.child.length), void 0 !== (t = this.parseTextData(t, e.tagname, n, !1, !!e[":@"] && 0 !== Object.keys(e[":@"]).length, i)) && "" !== t && e.add(this.options.textNodeName, t), t = ""), t;
		}
		function ct() {
			return 0 !== this.stopNodeExpressionsSet.size && this.matcher.matchesAny(this.stopNodeExpressionsSet);
		}
		function dt(t, e, n, i) {
			const s = t.indexOf(e, n);
			if (-1 === s) throw new Error(i);
			return s + e.length - 1;
		}
		function ft(t, e, n, i) {
			const s = t.indexOf(e, n);
			if (-1 === s) throw new Error(i);
			return s;
		}
		function gt(t, e, n, i = ">") {
			const s = function(t, e, n = ">") {
				let i = 0;
				const s = [], r = t.length, o = n.charCodeAt(0), a = n.length > 1 ? n.charCodeAt(1) : -1;
				for (let n = e; n < r; n++) {
					const e = t.charCodeAt(n);
					if (i) e === i && (i = 0);
					else if (34 === e || 39 === e) i = e;
					else if (e === o) {
						if (-1 === a) return {
							data: String.fromCharCode(...s),
							index: n
						};
						if (t.charCodeAt(n + 1) === a) return {
							data: String.fromCharCode(...s),
							index: n
						};
					} else if (9 === e) {
						s.push(32);
						continue;
					}
					s.push(e);
				}
			}(t, e + 1, i);
			if (!s) return;
			let r = s.data;
			const o = s.index, a = r.search(/\s/);
			let h = r, l = !0;
			-1 !== a && (h = r.substring(0, a), r = r.substring(a + 1).trimStart());
			const u = h;
			if (n) {
				const t = h.indexOf(":");
				-1 !== t && (h = h.substr(t + 1), l = h !== s.data.substr(t + 1));
			}
			return {
				tagName: h,
				tagExp: r,
				closeIndex: o,
				attrExpPresent: l,
				rawTagName: u
			};
		}
		function mt(t, e, n) {
			const i = n;
			let s = 1;
			const r = t.length;
			for (; n < r; n++) if ("<" === t[n]) {
				const r = t.charCodeAt(n + 1);
				if (47 === r) {
					const r = ft(t, ">", n, `${e} is not closed`);
					if (t.substring(n + 2, r).trim() === e && (s--, 0 === s)) return {
						tagContent: t.substring(i, n),
						i: r
					};
					n = r;
				} else if (63 === r) n = dt(t, "?>", n + 1, "StopNode is not closed.");
				else if (33 === r && 45 === t.charCodeAt(n + 2) && 45 === t.charCodeAt(n + 3)) n = dt(t, "-->", n + 3, "StopNode is not closed.");
				else if (33 === r && 91 === t.charCodeAt(n + 2)) n = dt(t, "]]>", n, "StopNode is not closed.") - 2;
				else {
					const i = gt(t, n, ">");
					i && ((i && i.tagName) === e && "/" !== i.tagExp[i.tagExp.length - 1] && s++, n = i.closeIndex);
				}
			}
		}
		function xt(t, e, n) {
			if (e && "string" == typeof t) {
				const e = t.trim();
				return "true" === e || "false" !== e && function(t, e = {}) {
					if (e = Object.assign({}, L, e), !t || "string" != typeof t) return t;
					let n = t.trim();
					if (0 === n.length) return t;
					if (void 0 !== e.skipLike && e.skipLike.test(n)) return t;
					if ("0" === n) return 0;
					if (e.hex && j.test(n)) return function(t) {
						if (parseInt) return parseInt(t, 16);
						if (Number.parseInt) return Number.parseInt(t, 16);
						if (window && window.parseInt) return window.parseInt(t, 16);
						throw new Error("parseInt, Number.parseInt, window.parseInt are not supported");
					}(n);
					if (isFinite(n)) {
						if (n.includes("e") || n.includes("E")) return function(t, e, n) {
							if (!n.eNotation) return t;
							const i = e.match(k);
							if (i) {
								let s = i[1] || "";
								const r = -1 === i[3].indexOf("e") ? "E" : "e", o = i[2], a = s ? t[o.length + 1] === r : t[o.length] === r;
								return o.length > 1 && a ? t : (1 !== o.length || !i[3].startsWith(`.${r}`) && i[3][0] !== r) && o.length > 0 ? n.leadingZeros && !a ? (e = (i[1] || "") + i[3], Number(e)) : t : Number(e);
							}
							return t;
						}(t, n, e);
						{
							const s = V.exec(n);
							if (s) {
								const r = s[1] || "", o = s[2];
								let a = (i = s[3]) && -1 !== i.indexOf(".") ? ("." === (i = i.replace(/0+$/, "")) ? i = "0" : "." === i[0] ? i = "0" + i : "." === i[i.length - 1] && (i = i.substring(0, i.length - 1)), i) : i;
								const h = r ? "." === t[o.length + 1] : "." === t[o.length];
								if (!e.leadingZeros && (o.length > 1 || 1 === o.length && !h)) return t;
								{
									const i = Number(n), s = String(i);
									if (0 === i) return i;
									if (-1 !== s.search(/[eE]/)) return e.eNotation ? i : t;
									if (-1 !== n.indexOf(".")) return "0" === s || s === a || s === `${r}${a}` ? i : t;
									let h = o ? a : n;
									return o ? h === s || r + h === s ? i : t : h === s || h === r + s ? i : t;
								}
							}
							return t;
						}
					}
					var i;
					return function(t, e, n) {
						const i = e === Infinity;
						switch (n.infinity.toLowerCase()) {
							case "null": return null;
							case "infinity": return e;
							case "string": return i ? "Infinity" : "-Infinity";
							default: return t;
						}
					}(t, Number(n), e);
				}(t, n);
			}
			return void 0 !== t ? t : "";
		}
		function Nt(t, e, n, i) {
			if (t) {
				const i = t(e);
				n === e && (n = i), e = i;
			}
			return {
				tagName: e = bt(e, i),
				tagExp: n
			};
		}
		function bt(t, e) {
			if (a.includes(t)) throw new Error(`[SECURITY] Invalid name: "${t}" is a reserved JavaScript keyword that could cause prototype pollution`);
			return o.includes(t) ? e.onDangerousProperty(t) : t;
		}
		const yt = O.getMetaDataSymbol();
		function Et(t, e) {
			if (!t || "object" != typeof t) return {};
			if (!e) return t;
			const n = {};
			for (const i in t) i.startsWith(e) ? n[i.substring(e.length)] = t[i] : n[i] = t[i];
			return n;
		}
		function wt(t, e, n, i) {
			return vt(t, e, n, i);
		}
		function vt(t, e, n, i) {
			let s;
			const r = {};
			for (let o = 0; o < t.length; o++) {
				const a = t[o], h = St(a);
				if (void 0 !== h && h !== e.textNodeName) {
					const t = Et(a[":@"] || {}, e.attributeNamePrefix);
					n.push(h, t);
				}
				if (h === e.textNodeName) void 0 === s ? s = a[h] : s += "" + a[h];
				else {
					if (void 0 === h) continue;
					if (a[h]) {
						let t = vt(a[h], e, n, i);
						const s = At(t, e);
						if (a[":@"] ? _t(t, a[":@"], i, e) : 1 !== Object.keys(t).length || void 0 === t[e.textNodeName] || e.alwaysCreateTextNode ? 0 === Object.keys(t).length && (e.alwaysCreateTextNode ? t[e.textNodeName] = "" : t = "") : t = t[e.textNodeName], void 0 !== a[yt] && "object" == typeof t && null !== t && (t[yt] = a[yt]), void 0 !== r[h] && Object.prototype.hasOwnProperty.call(r, h)) Array.isArray(r[h]) || (r[h] = [r[h]]), r[h].push(t);
						else {
							const n = e.jPath ? i.toString() : i;
							e.isArray(h, n, s) ? r[h] = [t] : r[h] = t;
						}
						void 0 !== h && h !== e.textNodeName && n.pop();
					}
				}
			}
			return "string" == typeof s ? s.length > 0 && (r[e.textNodeName] = s) : void 0 !== s && (r[e.textNodeName] = s), r;
		}
		function St(t) {
			const e = Object.keys(t);
			for (let t = 0; t < e.length; t++) {
				const n = e[t];
				if (":@" !== n) return n;
			}
		}
		function _t(t, e, n, i) {
			if (e) {
				const s = Object.keys(e), r = s.length;
				for (let o = 0; o < r; o++) {
					const r = s[o], a = r.startsWith(i.attributeNamePrefix) ? r.substring(i.attributeNamePrefix.length) : r, h = i.jPath ? n.toString() + "." + a : n;
					i.isArray(r, h, !0, !0) ? t[r] = [e[r]] : t[r] = e[r];
				}
			}
		}
		function At(t, e) {
			const { textNodeName: n } = e, i = Object.keys(t).length;
			return 0 === i || !(1 !== i || !t[n] && "boolean" != typeof t[n] && 0 !== t[n]);
		}
		class Tt {
			constructor(t) {
				this.externalEntities = {}, this.options = C(t);
			}
			parse(t, e) {
				if ("string" != typeof t && t.toString) t = t.toString();
				else if ("string" != typeof t) throw new Error("XML data is accepted in String or Bytes[] form.");
				if (e) {
					!0 === e && (e = {});
					const n = l(t, e);
					if (!0 !== n) throw Error(`${n.err.msg}:${n.err.line}:${n.err.col}`);
				}
				const n = new it(this.options);
				n.entityDecoder.setExternalEntities(this.externalEntities);
				const i = n.parseXml(t);
				return this.options.preserveOrder || void 0 === i ? i : wt(i, this.options, n.matcher, n.readonlyMatcher);
			}
			addEntity(t, e) {
				if (-1 !== e.indexOf("&")) throw new Error("Entity value can't have '&'");
				if (-1 !== t.indexOf("&") || -1 !== t.indexOf(";")) throw new Error("An entity must be set without '&' and ';'. Eg. use '#xD' for '&#xD;'");
				if ("&" === e) throw new Error("An entity with value '&' is not permitted");
				this.externalEntities[t] = e;
			}
			static getMetaDataSymbol() {
				return O.getMetaDataSymbol();
			}
		}
		function Ct(t, e) {
			let n = "";
			e.format && e.indentBy.length > 0 && (n = "\n");
			const i = [];
			if (e.stopNodes && Array.isArray(e.stopNodes)) for (let t = 0; t < e.stopNodes.length; t++) {
				const n = e.stopNodes[t];
				"string" == typeof n ? i.push(new G(n)) : n instanceof G && i.push(n);
			}
			return Pt(t, e, n, new R(), i);
		}
		function Pt(t, e, n, i, s) {
			let r = "", o = !1;
			if (e.maxNestedTags && i.getDepth() > e.maxNestedTags) throw new Error("Maximum nested tags exceeded");
			if (!Array.isArray(t)) {
				if (null != t) {
					let n = t.toString();
					return n = Vt(n, e), n;
				}
				return "";
			}
			for (let a = 0; a < t.length; a++) {
				const h = t[a], l = Dt(h);
				if (void 0 === l) continue;
				const u = Ot(h[":@"], e);
				i.push(l, u);
				const p = jt(i, s);
				if (l === e.textNodeName) {
					let t = h[l];
					p || (t = e.tagValueProcessor(l, t), t = Vt(t, e)), o && (r += n), r += t, o = !1, i.pop();
					continue;
				}
				if (l === e.cdataPropName) {
					o && (r += n);
					const t = h[l][0][e.textNodeName];
					r += `<![CDATA[${String(t).replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`, o = !1, i.pop();
					continue;
				}
				if (l === e.commentPropName) {
					const t = h[l][0][e.textNodeName];
					r += n + `\x3c!--${String(t).replace(/--/g, "- -").replace(/-$/, "- ")}--\x3e`, o = !0, i.pop();
					continue;
				}
				if ("?" === l[0]) {
					const t = Mt(h[":@"], e, p), s = "?xml" === l ? "" : n;
					let a = h[l][0][e.textNodeName];
					a = 0 !== a.length ? " " + a : "", r += s + `<${l}${a}${t}?>`, o = !0, i.pop();
					continue;
				}
				let c = n;
				"" !== c && (c += e.indentBy);
				const d = n + `<${l}${Mt(h[":@"], e, p)}`;
				let f;
				f = p ? $t(h[l], e) : Pt(h[l], e, c, i, s), -1 !== e.unpairedTags.indexOf(l) ? e.suppressUnpairedNode ? r += d + ">" : r += d + "/>" : f && 0 !== f.length || !e.suppressEmptyNode ? f && f.endsWith(">") ? r += d + `>${f}${n}</${l}>` : (r += d + ">", f && "" !== n && (f.includes("/>") || f.includes("</")) ? r += n + e.indentBy + f + n : r += f, r += `</${l}>`) : r += d + "/>", o = !0, i.pop();
			}
			return r;
		}
		function Ot(t, e) {
			if (!t || e.ignoreAttributes) return null;
			const n = {};
			let i = !1;
			for (let s in t) Object.prototype.hasOwnProperty.call(t, s) && (n[s.startsWith(e.attributeNamePrefix) ? s.substr(e.attributeNamePrefix.length) : s] = t[s], i = !0);
			return i ? n : null;
		}
		function $t(t, e) {
			if (!Array.isArray(t)) return null != t ? t.toString() : "";
			let n = "";
			for (let i = 0; i < t.length; i++) {
				const s = t[i], r = Dt(s);
				if (r === e.textNodeName) n += s[r];
				else if (r === e.cdataPropName) n += s[r][0][e.textNodeName];
				else if (r === e.commentPropName) n += s[r][0][e.textNodeName];
				else {
					if (r && "?" === r[0]) continue;
					if (r) {
						const t = It(s[":@"], e), i = $t(s[r], e);
						i && 0 !== i.length ? n += `<${r}${t}>${i}</${r}>` : n += `<${r}${t}/>`;
					}
				}
			}
			return n;
		}
		function It(t, e) {
			let n = "";
			if (t && !e.ignoreAttributes) for (let i in t) {
				if (!Object.prototype.hasOwnProperty.call(t, i)) continue;
				let s = t[i];
				!0 === s && e.suppressBooleanAttributes ? n += ` ${i.substr(e.attributeNamePrefix.length)}` : n += ` ${i.substr(e.attributeNamePrefix.length)}="${s}"`;
			}
			return n;
		}
		function Dt(t) {
			const e = Object.keys(t);
			for (let n = 0; n < e.length; n++) {
				const i = e[n];
				if (Object.prototype.hasOwnProperty.call(t, i) && ":@" !== i) return i;
			}
		}
		function Mt(t, e, n) {
			let i = "";
			if (t && !e.ignoreAttributes) for (let s in t) {
				if (!Object.prototype.hasOwnProperty.call(t, s)) continue;
				let r;
				n ? r = t[s] : (r = e.attributeValueProcessor(s, t[s]), r = Vt(r, e)), !0 === r && e.suppressBooleanAttributes ? i += ` ${s.substr(e.attributeNamePrefix.length)}` : i += ` ${s.substr(e.attributeNamePrefix.length)}="${r}"`;
			}
			return i;
		}
		function jt(t, e) {
			if (!e || 0 === e.length) return !1;
			for (let n = 0; n < e.length; n++) if (t.matches(e[n])) return !0;
			return !1;
		}
		function Vt(t, e) {
			if (t && t.length > 0 && e.processEntities) for (let n = 0; n < e.entities.length; n++) {
				const i = e.entities[n];
				t = t.replace(i.regex, i.val);
			}
			return t;
		}
		const Lt = {
			attributeNamePrefix: "@_",
			attributesGroupName: !1,
			textNodeName: "#text",
			ignoreAttributes: !0,
			cdataPropName: !1,
			format: !1,
			indentBy: "  ",
			suppressEmptyNode: !1,
			suppressUnpairedNode: !0,
			suppressBooleanAttributes: !0,
			tagValueProcessor: function(t, e) {
				return e;
			},
			attributeValueProcessor: function(t, e) {
				return e;
			},
			preserveOrder: !1,
			commentPropName: !1,
			unpairedTags: [],
			entities: [
				{
					regex: /* @__PURE__ */ new RegExp("&", "g"),
					val: "&amp;"
				},
				{
					regex: /* @__PURE__ */ new RegExp(">", "g"),
					val: "&gt;"
				},
				{
					regex: /* @__PURE__ */ new RegExp("<", "g"),
					val: "&lt;"
				},
				{
					regex: /* @__PURE__ */ new RegExp("'", "g"),
					val: "&apos;"
				},
				{
					regex: /* @__PURE__ */ new RegExp("\"", "g"),
					val: "&quot;"
				}
			],
			processEntities: !0,
			stopNodes: [],
			oneListGroup: !1,
			maxNestedTags: 100,
			jPath: !0
		};
		function kt(t) {
			if (this.options = Object.assign({}, Lt, t), this.options.stopNodes && Array.isArray(this.options.stopNodes) && (this.options.stopNodes = this.options.stopNodes.map((t) => "string" == typeof t && t.startsWith("*.") ? ".." + t.substring(2) : t)), this.stopNodeExpressions = [], this.options.stopNodes && Array.isArray(this.options.stopNodes)) for (let t = 0; t < this.options.stopNodes.length; t++) {
				const e = this.options.stopNodes[t];
				"string" == typeof e ? this.stopNodeExpressions.push(new G(e)) : e instanceof G && this.stopNodeExpressions.push(e);
			}
			var e;
			!0 === this.options.ignoreAttributes || this.options.attributesGroupName ? this.isAttribute = function() {
				return !1;
			} : (this.ignoreAttributesFn = "function" == typeof (e = this.options.ignoreAttributes) ? e : Array.isArray(e) ? (t) => {
				for (const n of e) {
					if ("string" == typeof n && t === n) return !0;
					if (n instanceof RegExp && n.test(t)) return !0;
				}
			} : () => !1, this.attrPrefixLen = this.options.attributeNamePrefix.length, this.isAttribute = Gt), this.processTextOrObjNode = Ft, this.options.format ? (this.indentate = Rt, this.tagEndChar = ">\n", this.newLine = "\n") : (this.indentate = function() {
				return "";
			}, this.tagEndChar = ">", this.newLine = "");
		}
		function Ft(t, e, n, i) {
			const s = this.extractAttributes(t);
			if (i.push(e, s), this.checkStopNode(i)) {
				const s = this.buildRawContent(t), r = this.buildAttributesForStopNode(t);
				return i.pop(), this.buildObjectNode(s, e, r, n);
			}
			const r = this.j2x(t, n + 1, i);
			return i.pop(), void 0 !== t[this.options.textNodeName] && 1 === Object.keys(t).length ? this.buildTextValNode(t[this.options.textNodeName], e, r.attrStr, n, i) : this.buildObjectNode(r.val, e, r.attrStr, n);
		}
		function Rt(t) {
			return this.options.indentBy.repeat(t);
		}
		function Gt(t) {
			return !(!t.startsWith(this.options.attributeNamePrefix) || t === this.options.textNodeName) && t.substr(this.attrPrefixLen);
		}
		kt.prototype.build = function(t) {
			if (this.options.preserveOrder) return Ct(t, this.options);
			{
				Array.isArray(t) && this.options.arrayNodeName && this.options.arrayNodeName.length > 1 && (t = { [this.options.arrayNodeName]: t });
				const e = new R();
				return this.j2x(t, 0, e).val;
			}
		}, kt.prototype.j2x = function(t, e, n) {
			let i = "", s = "";
			if (this.options.maxNestedTags && n.getDepth() >= this.options.maxNestedTags) throw new Error("Maximum nested tags exceeded");
			const r = this.options.jPath ? n.toString() : n, o = this.checkStopNode(n);
			for (let a in t) if (Object.prototype.hasOwnProperty.call(t, a)) if (void 0 === t[a]) this.isAttribute(a) && (s += "");
			else if (null === t[a]) this.isAttribute(a) || a === this.options.cdataPropName ? s += "" : "?" === a[0] ? s += this.indentate(e) + "<" + a + "?" + this.tagEndChar : s += this.indentate(e) + "<" + a + "/" + this.tagEndChar;
			else if (t[a] instanceof Date) s += this.buildTextValNode(t[a], a, "", e, n);
			else if ("object" != typeof t[a]) {
				const h = this.isAttribute(a);
				if (h && !this.ignoreAttributesFn(h, r)) i += this.buildAttrPairStr(h, "" + t[a], o);
				else if (!h) if (a === this.options.textNodeName) {
					let e = this.options.tagValueProcessor(a, "" + t[a]);
					s += this.replaceEntitiesValue(e);
				} else {
					n.push(a);
					const i = this.checkStopNode(n);
					if (n.pop(), i) {
						const n = "" + t[a];
						s += "" === n ? this.indentate(e) + "<" + a + this.closeTag(a) + this.tagEndChar : this.indentate(e) + "<" + a + ">" + n + "</" + a + this.tagEndChar;
					} else s += this.buildTextValNode(t[a], a, "", e, n);
				}
			} else if (Array.isArray(t[a])) {
				const i = t[a].length;
				let r = "", o = "";
				for (let h = 0; h < i; h++) {
					const i = t[a][h];
					if (void 0 === i);
					else if (null === i) "?" === a[0] ? s += this.indentate(e) + "<" + a + "?" + this.tagEndChar : s += this.indentate(e) + "<" + a + "/" + this.tagEndChar;
					else if ("object" == typeof i) if (this.options.oneListGroup) {
						n.push(a);
						const t = this.j2x(i, e + 1, n);
						n.pop(), r += t.val, this.options.attributesGroupName && i.hasOwnProperty(this.options.attributesGroupName) && (o += t.attrStr);
					} else r += this.processTextOrObjNode(i, a, e, n);
					else if (this.options.oneListGroup) {
						let t = this.options.tagValueProcessor(a, i);
						t = this.replaceEntitiesValue(t), r += t;
					} else {
						n.push(a);
						const t = this.checkStopNode(n);
						if (n.pop(), t) {
							const t = "" + i;
							r += "" === t ? this.indentate(e) + "<" + a + this.closeTag(a) + this.tagEndChar : this.indentate(e) + "<" + a + ">" + t + "</" + a + this.tagEndChar;
						} else r += this.buildTextValNode(i, a, "", e, n);
					}
				}
				this.options.oneListGroup && (r = this.buildObjectNode(r, a, o, e)), s += r;
			} else if (this.options.attributesGroupName && a === this.options.attributesGroupName) {
				const e = Object.keys(t[a]), n = e.length;
				for (let s = 0; s < n; s++) i += this.buildAttrPairStr(e[s], "" + t[a][e[s]], o);
			} else s += this.processTextOrObjNode(t[a], a, e, n);
			return {
				attrStr: i,
				val: s
			};
		}, kt.prototype.buildAttrPairStr = function(t, e, n) {
			return n || (e = this.options.attributeValueProcessor(t, "" + e), e = this.replaceEntitiesValue(e)), this.options.suppressBooleanAttributes && "true" === e ? " " + t : " " + t + "=\"" + e + "\"";
		}, kt.prototype.extractAttributes = function(t) {
			if (!t || "object" != typeof t) return null;
			const e = {};
			let n = !1;
			if (this.options.attributesGroupName && t[this.options.attributesGroupName]) {
				const i = t[this.options.attributesGroupName];
				for (let t in i) Object.prototype.hasOwnProperty.call(i, t) && (e[t.startsWith(this.options.attributeNamePrefix) ? t.substring(this.options.attributeNamePrefix.length) : t] = i[t], n = !0);
			} else for (let i in t) {
				if (!Object.prototype.hasOwnProperty.call(t, i)) continue;
				const s = this.isAttribute(i);
				s && (e[s] = t[i], n = !0);
			}
			return n ? e : null;
		}, kt.prototype.buildRawContent = function(t) {
			if ("string" == typeof t) return t;
			if ("object" != typeof t || null === t) return String(t);
			if (void 0 !== t[this.options.textNodeName]) return t[this.options.textNodeName];
			let e = "";
			for (let n in t) {
				if (!Object.prototype.hasOwnProperty.call(t, n)) continue;
				if (this.isAttribute(n)) continue;
				if (this.options.attributesGroupName && n === this.options.attributesGroupName) continue;
				const i = t[n];
				if (n === this.options.textNodeName) e += i;
				else if (Array.isArray(i)) {
					for (let t of i) if ("string" == typeof t || "number" == typeof t) e += `<${n}>${t}</${n}>`;
					else if ("object" == typeof t && null !== t) {
						const i = this.buildRawContent(t), s = this.buildAttributesForStopNode(t);
						e += "" === i ? `<${n}${s}/>` : `<${n}${s}>${i}</${n}>`;
					}
				} else if ("object" == typeof i && null !== i) {
					const t = this.buildRawContent(i), s = this.buildAttributesForStopNode(i);
					e += "" === t ? `<${n}${s}/>` : `<${n}${s}>${t}</${n}>`;
				} else e += `<${n}>${i}</${n}>`;
			}
			return e;
		}, kt.prototype.buildAttributesForStopNode = function(t) {
			if (!t || "object" != typeof t) return "";
			let e = "";
			if (this.options.attributesGroupName && t[this.options.attributesGroupName]) {
				const n = t[this.options.attributesGroupName];
				for (let t in n) {
					if (!Object.prototype.hasOwnProperty.call(n, t)) continue;
					const i = t.startsWith(this.options.attributeNamePrefix) ? t.substring(this.options.attributeNamePrefix.length) : t, s = n[t];
					!0 === s && this.options.suppressBooleanAttributes ? e += " " + i : e += " " + i + "=\"" + s + "\"";
				}
			} else for (let n in t) {
				if (!Object.prototype.hasOwnProperty.call(t, n)) continue;
				const i = this.isAttribute(n);
				if (i) {
					const s = t[n];
					!0 === s && this.options.suppressBooleanAttributes ? e += " " + i : e += " " + i + "=\"" + s + "\"";
				}
			}
			return e;
		}, kt.prototype.buildObjectNode = function(t, e, n, i) {
			if ("" === t) return "?" === e[0] ? this.indentate(i) + "<" + e + n + "?" + this.tagEndChar : this.indentate(i) + "<" + e + n + this.closeTag(e) + this.tagEndChar;
			{
				let s = "</" + e + this.tagEndChar, r = "";
				return "?" === e[0] && (r = "?", s = ""), !n && "" !== n || -1 !== t.indexOf("<") ? !1 !== this.options.commentPropName && e === this.options.commentPropName && 0 === r.length ? this.indentate(i) + `\x3c!--${t}--\x3e` + this.newLine : this.indentate(i) + "<" + e + n + r + this.tagEndChar + t + this.indentate(i) + s : this.indentate(i) + "<" + e + n + r + ">" + t + s;
			}
		}, kt.prototype.closeTag = function(t) {
			let e = "";
			return -1 !== this.options.unpairedTags.indexOf(t) ? this.options.suppressUnpairedNode || (e = "/") : e = this.options.suppressEmptyNode ? "/" : `></${t}`, e;
		}, kt.prototype.checkStopNode = function(t) {
			if (!this.stopNodeExpressions || 0 === this.stopNodeExpressions.length) return !1;
			for (let e = 0; e < this.stopNodeExpressions.length; e++) if (t.matches(this.stopNodeExpressions[e])) return !0;
			return !1;
		}, kt.prototype.buildTextValNode = function(t, e, n, i, s) {
			if (!1 !== this.options.cdataPropName && e === this.options.cdataPropName) {
				const e = String(t).replace(/\]\]>/g, "]]]]><![CDATA[>");
				return this.indentate(i) + `<![CDATA[${e}]]>` + this.newLine;
			}
			if (!1 !== this.options.commentPropName && e === this.options.commentPropName) {
				const e = String(t).replace(/--/g, "- -").replace(/-$/, "- ");
				return this.indentate(i) + `\x3c!--${e}--\x3e` + this.newLine;
			}
			if ("?" === e[0]) return this.indentate(i) + "<" + e + n + "?" + this.tagEndChar;
			{
				let s = this.options.tagValueProcessor(e, t);
				return s = this.replaceEntitiesValue(s), "" === s ? this.indentate(i) + "<" + e + n + this.closeTag(e) + this.tagEndChar : this.indentate(i) + "<" + e + n + ">" + s + "</" + e + this.tagEndChar;
			}
		}, kt.prototype.replaceEntitiesValue = function(t) {
			if (t && t.length > 0 && this.options.processEntities) for (let e = 0; e < this.options.entities.length; e++) {
				const n = this.options.entities[e];
				t = t.replace(n.regex, n.val);
			}
			return t;
		};
		const Bt = kt, Ut = { validate: l };
		module.exports = e;
	})();
}));
//#endregion
//#region node_modules/@aws-sdk/xml-builder/dist-cjs/xml-external/nodable_entities.js
var require_nodable_entities = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.EntityDecoderImpl = exports.CURRENCY = exports.COMMON_HTML = exports.XML = void 0;
	exports.XML = {
		amp: "&",
		apos: "'",
		gt: ">",
		lt: "<",
		quot: "\""
	};
	exports.COMMON_HTML = {
		nbsp: "\xA0",
		copy: "©",
		reg: "®",
		trade: "™",
		mdash: "—",
		ndash: "–",
		hellip: "…",
		laquo: "«",
		raquo: "»",
		lsquo: "‘",
		rsquo: "’",
		ldquo: "“",
		rdquo: "”",
		bull: "•",
		para: "¶",
		sect: "§",
		deg: "°",
		frac12: "½",
		frac14: "¼",
		frac34: "¾"
	};
	exports.CURRENCY = {
		cent: "¢",
		pound: "£",
		curren: "¤",
		yen: "¥",
		euro: "€",
		dollar: "$",
		fnof: "ƒ",
		inr: "₹",
		af: "؋",
		birr: "ብር",
		peso: "₱",
		rub: "₽",
		won: "₩",
		yuan: "¥",
		cedil: "¸"
	};
	const SPECIAL_CHARS = /* @__PURE__ */ new Set("!?\\/[]$%{}^&*()<>|+");
	function validateEntityName(name) {
		if (name[0] === "#") throw new Error(`[EntityReplacer] Invalid character '#' in entity name: "${name}"`);
		for (const ch of name) if (SPECIAL_CHARS.has(ch)) throw new Error(`[EntityReplacer] Invalid character '${ch}' in entity name: "${name}"`);
		return name;
	}
	function mergeEntityMaps(...maps) {
		const out = Object.create(null);
		for (const map of maps) {
			if (!map) continue;
			for (const key of Object.keys(map)) {
				const raw = map[key];
				if (typeof raw === "string") out[key] = raw;
				else if (raw && typeof raw === "object" && raw.val !== void 0) {
					const val = raw.val;
					if (typeof val === "string") out[key] = val;
				}
			}
		}
		return out;
	}
	const LIMIT_TIER_EXTERNAL = "external";
	const LIMIT_TIER_BASE = "base";
	const LIMIT_TIER_ALL = "all";
	function parseLimitTiers(raw) {
		if (!raw || raw === LIMIT_TIER_EXTERNAL) return new Set([LIMIT_TIER_EXTERNAL]);
		if (raw === LIMIT_TIER_ALL) return new Set([LIMIT_TIER_ALL]);
		if (raw === LIMIT_TIER_BASE) return new Set([LIMIT_TIER_BASE]);
		if (Array.isArray(raw)) return new Set(raw);
		return new Set([LIMIT_TIER_EXTERNAL]);
	}
	const NCR_LEVEL = Object.freeze({
		allow: 0,
		leave: 1,
		remove: 2,
		throw: 3
	});
	const XML10_ALLOWED_C0 = new Set([
		9,
		10,
		13
	]);
	function parseNCRConfig(ncr) {
		if (!ncr) return {
			xmlVersion: 1,
			onLevel: NCR_LEVEL.allow,
			nullLevel: NCR_LEVEL.remove
		};
		const xmlVersion = ncr.xmlVersion === 1.1 ? 1.1 : 1;
		const onLevel = NCR_LEVEL[ncr.onNCR ?? "allow"] ?? NCR_LEVEL.allow;
		const nullLevel = NCR_LEVEL[ncr.nullNCR ?? "remove"] ?? NCR_LEVEL.remove;
		return {
			xmlVersion,
			onLevel,
			nullLevel: Math.max(nullLevel, NCR_LEVEL.remove)
		};
	}
	exports.EntityDecoderImpl = class EntityDecoderImpl {
		_limit;
		_maxTotalExpansions;
		_maxExpandedLength;
		_postCheck;
		_limitTiers;
		_numericAllowed;
		_baseMap;
		_externalMap;
		_inputMap;
		_totalExpansions;
		_expandedLength;
		_removeSet;
		_leaveSet;
		_ncrXmlVersion;
		_ncrOnLevel;
		_ncrNullLevel;
		constructor(options = {}) {
			this._limit = options.limit || {};
			this._maxTotalExpansions = this._limit.maxTotalExpansions || 0;
			this._maxExpandedLength = this._limit.maxExpandedLength || 0;
			this._postCheck = typeof options.postCheck === "function" ? options.postCheck : (r) => r;
			this._limitTiers = parseLimitTiers(this._limit.applyLimitsTo ?? LIMIT_TIER_EXTERNAL);
			this._numericAllowed = options.numericAllowed ?? true;
			this._baseMap = mergeEntityMaps(exports.XML, options.namedEntities || null);
			this._externalMap = Object.create(null);
			this._inputMap = Object.create(null);
			this._totalExpansions = 0;
			this._expandedLength = 0;
			this._removeSet = new Set(options.remove && Array.isArray(options.remove) ? options.remove : []);
			this._leaveSet = new Set(options.leave && Array.isArray(options.leave) ? options.leave : []);
			const ncrCfg = parseNCRConfig(options.ncr);
			this._ncrXmlVersion = ncrCfg.xmlVersion;
			this._ncrOnLevel = ncrCfg.onLevel;
			this._ncrNullLevel = ncrCfg.nullLevel;
		}
		setExternalEntities(map) {
			if (map) for (const key of Object.keys(map)) validateEntityName(key);
			this._externalMap = mergeEntityMaps(map);
		}
		addExternalEntity(key, value) {
			validateEntityName(key);
			if (typeof value === "string" && value.indexOf("&") === -1) this._externalMap[key] = value;
		}
		addInputEntities(map) {
			this._totalExpansions = 0;
			this._expandedLength = 0;
			this._inputMap = mergeEntityMaps(map);
		}
		reset() {
			this._inputMap = Object.create(null);
			this._totalExpansions = 0;
			this._expandedLength = 0;
			return this;
		}
		setXmlVersion(version) {
			this._ncrXmlVersion = version === "1.1" || version === 1.1 ? 1.1 : 1;
		}
		decode(str) {
			if (typeof str !== "string" || str.length === 0) return str;
			const original = str;
			const chunks = [];
			const len = str.length;
			let last = 0;
			let i = 0;
			const limitExpansions = this._maxTotalExpansions > 0;
			const limitLength = this._maxExpandedLength > 0;
			const checkLimits = limitExpansions || limitLength;
			while (i < len) {
				if (str.charCodeAt(i) !== 38) {
					i++;
					continue;
				}
				let j = i + 1;
				while (j < len && str.charCodeAt(j) !== 59 && j - i <= 32) j++;
				if (j >= len || str.charCodeAt(j) !== 59) {
					i++;
					continue;
				}
				const token = str.slice(i + 1, j);
				if (token.length === 0) {
					i++;
					continue;
				}
				let replacement;
				let tier;
				if (this._removeSet.has(token)) {
					replacement = "";
					if (tier === void 0) tier = LIMIT_TIER_EXTERNAL;
				} else if (this._leaveSet.has(token)) {
					i++;
					continue;
				} else if (token.charCodeAt(0) === 35) {
					const ncrResult = this._resolveNCR(token);
					if (ncrResult === void 0) {
						i++;
						continue;
					}
					replacement = ncrResult;
					tier = LIMIT_TIER_BASE;
				} else {
					const resolved = this._resolveName(token);
					replacement = resolved?.value;
					tier = resolved?.tier;
				}
				if (replacement === void 0) {
					i++;
					continue;
				}
				if (i > last) chunks.push(str.slice(last, i));
				chunks.push(replacement);
				last = j + 1;
				i = last;
				if (checkLimits && this._tierCounts(tier)) {
					if (limitExpansions) {
						this._totalExpansions++;
						if (this._totalExpansions > this._maxTotalExpansions) throw new Error(`[EntityReplacer] Entity expansion count limit exceeded: ${this._totalExpansions} > ${this._maxTotalExpansions}`);
					}
					if (limitLength) {
						const delta = replacement.length - (token.length + 2);
						if (delta > 0) {
							this._expandedLength += delta;
							if (this._expandedLength > this._maxExpandedLength) throw new Error(`[EntityReplacer] Expanded content length limit exceeded: ${this._expandedLength} > ${this._maxExpandedLength}`);
						}
					}
				}
			}
			if (last < len) chunks.push(str.slice(last));
			const result = chunks.length === 0 ? str : chunks.join("");
			return this._postCheck(result, original);
		}
		_tierCounts(tier) {
			if (this._limitTiers.has(LIMIT_TIER_ALL)) return true;
			return this._limitTiers.has(tier);
		}
		_resolveName(name) {
			if (name in this._inputMap) return {
				value: this._inputMap[name],
				tier: LIMIT_TIER_EXTERNAL
			};
			if (name in this._externalMap) return {
				value: this._externalMap[name],
				tier: LIMIT_TIER_EXTERNAL
			};
			if (name in this._baseMap) return {
				value: this._baseMap[name],
				tier: LIMIT_TIER_BASE
			};
		}
		_classifyNCR(cp) {
			if (cp === 0) return this._ncrNullLevel;
			if (cp >= 55296 && cp <= 57343) return NCR_LEVEL.remove;
			if (this._ncrXmlVersion === 1) {
				if (cp >= 1 && cp <= 31 && !XML10_ALLOWED_C0.has(cp)) return NCR_LEVEL.remove;
			}
			return -1;
		}
		_applyNCRAction(action, token, cp) {
			switch (action) {
				case NCR_LEVEL.allow: return String.fromCodePoint(cp);
				case NCR_LEVEL.remove: return "";
				case NCR_LEVEL.leave: return;
				case NCR_LEVEL.throw: throw new Error(`[EntityDecoder] Prohibited numeric character reference &${token}; (U+${cp.toString(16).toUpperCase().padStart(4, "0")})`);
				default: return String.fromCodePoint(cp);
			}
		}
		_resolveNCR(token) {
			const second = token.charCodeAt(1);
			let cp;
			if (second === 120 || second === 88) cp = parseInt(token.slice(2), 16);
			else cp = parseInt(token.slice(1), 10);
			if (Number.isNaN(cp) || cp < 0 || cp > 1114111) return;
			const minimum = this._classifyNCR(cp);
			if (!this._numericAllowed && minimum < NCR_LEVEL.remove) return;
			const effective = minimum === -1 ? this._ncrOnLevel : Math.max(this._ncrOnLevel, minimum);
			return this._applyNCRAction(effective, token, cp);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/xml-builder/dist-cjs/xml-parser.js
var require_xml_parser = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.parseXML = parseXML;
	const fast_xml_parser_1 = require_fxp();
	const nodable_entities_1 = require_nodable_entities();
	const entityDecoder = new nodable_entities_1.EntityDecoderImpl({
		namedEntities: {
			...nodable_entities_1.XML,
			...nodable_entities_1.COMMON_HTML,
			...nodable_entities_1.CURRENCY
		},
		numericAllowed: true,
		limit: { maxTotalExpansions: Infinity },
		ncr: { xmlVersion: 1.1 }
	});
	const parser = new fast_xml_parser_1.XMLParser({
		attributeNamePrefix: "",
		processEntities: {
			enabled: true,
			maxTotalExpansions: Infinity
		},
		htmlEntities: true,
		entityDecoder: {
			setExternalEntities: (entities) => {
				entityDecoder.setExternalEntities(entities);
			},
			addInputEntities: (entities) => {
				entityDecoder.addInputEntities(entities);
			},
			reset: () => {
				entityDecoder.reset();
			},
			decode: (text) => {
				return entityDecoder.decode(text);
			},
			setXmlVersion: (version) => void 0
		},
		ignoreAttributes: false,
		ignoreDeclaration: true,
		parseTagValue: false,
		trimValues: false,
		tagValueProcessor: (_, val) => val.trim() === "" && val.includes("\n") ? "" : void 0,
		maxNestedTags: Infinity
	});
	function parseXML(xmlString) {
		return parser.parse(xmlString, true);
	}
}));
//#endregion
//#region node_modules/@aws-sdk/xml-builder/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var xmlParser = require_xml_parser();
	const ATTR_ESCAPE_RE = /[&<>"]/g;
	const ATTR_ESCAPE_MAP = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;"
	};
	function escapeAttribute(value) {
		return value.replace(ATTR_ESCAPE_RE, (ch) => ATTR_ESCAPE_MAP[ch]);
	}
	const ELEMENT_ESCAPE_RE = /[&"'<>\r\n\u0085\u2028]/g;
	const ELEMENT_ESCAPE_MAP = {
		"&": "&amp;",
		"\"": "&quot;",
		"'": "&apos;",
		"<": "&lt;",
		">": "&gt;",
		"\r": "&#x0D;",
		"\n": "&#x0A;",
		"": "&#x85;",
		"\u2028": "&#x2028;"
	};
	function escapeElement(value) {
		return value.replace(ELEMENT_ESCAPE_RE, (ch) => ELEMENT_ESCAPE_MAP[ch]);
	}
	var XmlText = class {
		value;
		constructor(value) {
			this.value = value;
		}
		toString() {
			return escapeElement("" + this.value);
		}
	};
	var XmlNode = class XmlNode {
		name;
		children;
		attributes = {};
		static of(name, childText, withName) {
			const node = new XmlNode(name);
			if (childText !== void 0) node.addChildNode(new XmlText(childText));
			if (withName !== void 0) node.withName(withName);
			return node;
		}
		constructor(name, children = []) {
			this.name = name;
			this.children = children;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		addAttribute(name, value) {
			this.attributes[name] = value;
			return this;
		}
		addChildNode(child) {
			this.children.push(child);
			return this;
		}
		removeAttribute(name) {
			delete this.attributes[name];
			return this;
		}
		n(name) {
			this.name = name;
			return this;
		}
		c(child) {
			this.children.push(child);
			return this;
		}
		a(name, value) {
			if (value != null) this.attributes[name] = value;
			return this;
		}
		cc(input, field, withName = field) {
			if (input[field] != null) {
				const node = XmlNode.of(field, input[field]).withName(withName);
				this.c(node);
			}
		}
		l(input, listName, memberName, valueProvider) {
			if (input[listName] != null) valueProvider().map((node) => {
				node.withName(memberName);
				this.c(node);
			});
		}
		lc(input, listName, memberName, valueProvider) {
			if (input[listName] != null) {
				const nodes = valueProvider();
				const containerNode = new XmlNode(memberName);
				nodes.map((node) => {
					containerNode.c(node);
				});
				this.c(containerNode);
			}
		}
		toString() {
			const hasChildren = Boolean(this.children.length);
			let xmlText = `<${this.name}`;
			const attributes = this.attributes;
			for (const attributeName of Object.keys(attributes)) {
				const attribute = attributes[attributeName];
				if (attribute != null) xmlText += ` ${attributeName}="${escapeAttribute("" + attribute)}"`;
			}
			return xmlText += !hasChildren ? "/>" : `>${this.children.map((c) => c.toString()).join("")}</${this.name}>`;
		}
	};
	exports.parseXML = xmlParser.parseXML;
	exports.XmlNode = XmlNode;
	exports.XmlText = XmlText;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/xml/XmlShapeDeserializer.js
var import_dist_cjs$3, XmlShapeDeserializer;
var init_XmlShapeDeserializer = __esmMin((() => {
	import_dist_cjs$3 = require_dist_cjs$1();
	init_client$1();
	init_protocols$1();
	init_schema();
	init_serde();
	init_ConfigurableSerdeContext();
	init_UnionSerde();
	XmlShapeDeserializer = class extends SerdeContextConfig {
		settings;
		stringDeserializer;
		constructor(settings) {
			super();
			this.settings = settings;
			this.stringDeserializer = new FromStringShapeDeserializer(settings);
		}
		setSerdeContext(serdeContext) {
			this.serdeContext = serdeContext;
			this.stringDeserializer.setSerdeContext(serdeContext);
		}
		read(schema, bytes, key) {
			const ns = NormalizedSchema.of(schema);
			const memberSchemas = ns.getMemberSchemas();
			if (ns.isStructSchema() && ns.isMemberSchema() && !!Object.values(memberSchemas).find((memberNs) => {
				return !!memberNs.getMemberTraits().eventPayload;
			})) {
				const output = {};
				const memberName = Object.keys(memberSchemas)[0];
				if (memberSchemas[memberName].isBlobSchema()) output[memberName] = bytes;
				else output[memberName] = this.read(memberSchemas[memberName], bytes);
				return output;
			}
			const xmlString = (this.serdeContext?.utf8Encoder ?? toUtf8)(bytes);
			const parsedObject = this.parseXml(xmlString);
			return this.readSchema(schema, key ? parsedObject[key] : parsedObject);
		}
		readSchema(_schema, value) {
			const ns = NormalizedSchema.of(_schema);
			if (ns.isUnitSchema()) return;
			const traits = ns.getMergedTraits();
			if (ns.isListSchema() && !Array.isArray(value)) return this.readSchema(ns, [value]);
			if (value == null) return value;
			if (typeof value === "object") {
				const flat = !!traits.xmlFlattened;
				if (ns.isListSchema()) {
					const listValue = ns.getValueSchema();
					const buffer = [];
					const sourceKey = listValue.getMergedTraits().xmlName ?? "member";
					const source = flat ? value : (value[0] ?? value)[sourceKey];
					if (source == null) return buffer;
					const sourceArray = Array.isArray(source) ? source : [source];
					for (const v of sourceArray) buffer.push(this.readSchema(listValue, v));
					return buffer;
				}
				const buffer = {};
				if (ns.isMapSchema()) {
					const keyNs = ns.getKeySchema();
					const memberNs = ns.getValueSchema();
					let entries;
					if (flat) entries = Array.isArray(value) ? value : [value];
					else entries = Array.isArray(value.entry) ? value.entry : [value.entry];
					const keyProperty = keyNs.getMergedTraits().xmlName ?? "key";
					const valueProperty = memberNs.getMergedTraits().xmlName ?? "value";
					for (const entry of entries) {
						const key = entry[keyProperty];
						const value = entry[valueProperty];
						buffer[key] = this.readSchema(memberNs, value);
					}
					return buffer;
				}
				if (ns.isStructSchema()) {
					const union = ns.isUnionSchema();
					let unionSerde;
					if (union) unionSerde = new UnionSerde(value, buffer);
					for (const [memberName, memberSchema] of ns.structIterator()) {
						const memberTraits = memberSchema.getMergedTraits();
						const xmlObjectKey = !memberTraits.httpPayload ? memberSchema.getMemberTraits().xmlName ?? memberName : memberTraits.xmlName ?? memberSchema.getName();
						if (union) unionSerde.mark(xmlObjectKey);
						if (value[xmlObjectKey] != null) buffer[memberName] = this.readSchema(memberSchema, value[xmlObjectKey]);
					}
					if (union) unionSerde.writeUnknown();
					return buffer;
				}
				if (ns.isDocumentSchema()) return value;
				throw new Error(`@aws-sdk/core/protocols - xml deserializer unhandled schema type for ${ns.getName(true)}`);
			}
			if (ns.isListSchema()) return [];
			if (ns.isMapSchema() || ns.isStructSchema()) return {};
			return this.stringDeserializer.read(ns, value);
		}
		parseXml(xml) {
			if (xml.length) {
				let parsedObj;
				try {
					parsedObj = (0, import_dist_cjs$3.parseXML)(xml);
				} catch (e) {
					if (e && typeof e === "object") Object.defineProperty(e, "$responseBodyText", { value: xml });
					throw e;
				}
				const textNodeName = "#text";
				const key = Object.keys(parsedObj)[0];
				const parsedObjToReturn = parsedObj[key];
				if (parsedObjToReturn[textNodeName]) {
					parsedObjToReturn[key] = parsedObjToReturn[textNodeName];
					delete parsedObjToReturn[textNodeName];
				}
				return getValueFromTextNode(parsedObjToReturn);
			}
			return {};
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/query/QueryShapeSerializer.js
var QueryShapeSerializer;
var init_QueryShapeSerializer = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_serde();
	init_ConfigurableSerdeContext();
	QueryShapeSerializer = class extends SerdeContextConfig {
		settings;
		buffer;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		write(schema, value, prefix = "") {
			if (this.buffer === void 0) this.buffer = "";
			const ns = NormalizedSchema.of(schema);
			if (prefix && !prefix.endsWith(".")) prefix += ".";
			if (ns.isBlobSchema()) {
				if (typeof value === "string" || value instanceof Uint8Array) {
					this.writeKey(prefix);
					this.writeValue((this.serdeContext?.base64Encoder ?? toBase64)(value));
				}
			} else if (ns.isBooleanSchema() || ns.isNumericSchema() || ns.isStringSchema()) {
				if (value != null) {
					this.writeKey(prefix);
					this.writeValue(String(value));
				} else if (ns.isIdempotencyToken()) {
					this.writeKey(prefix);
					this.writeValue(generateIdempotencyToken());
				}
			} else if (ns.isBigIntegerSchema()) {
				if (value != null) {
					this.writeKey(prefix);
					this.writeValue(String(value));
				}
			} else if (ns.isBigDecimalSchema()) {
				if (value != null) {
					this.writeKey(prefix);
					this.writeValue(value instanceof NumericValue ? value.string : String(value));
				}
			} else if (ns.isTimestampSchema()) {
				if (value instanceof Date) {
					this.writeKey(prefix);
					switch (determineTimestampFormat(ns, this.settings)) {
						case 5:
							this.writeValue(value.toISOString().replace(".000Z", "Z"));
							break;
						case 6:
							this.writeValue(dateToUtcString(value));
							break;
						case 7:
							this.writeValue(String(value.getTime() / 1e3));
							break;
					}
				}
			} else if (ns.isDocumentSchema()) if (Array.isArray(value)) this.write(79, value, prefix);
			else if (value instanceof Date) this.write(4, value, prefix);
			else if (value instanceof Uint8Array) this.write(21, value, prefix);
			else if (value && typeof value === "object") this.write(143, value, prefix);
			else {
				this.writeKey(prefix);
				this.writeValue(String(value));
			}
			else if (ns.isListSchema()) {
				if (Array.isArray(value)) if (value.length === 0) {
					if (this.settings.serializeEmptyLists) {
						this.writeKey(prefix);
						this.writeValue("");
					}
				} else {
					const member = ns.getValueSchema();
					const flat = this.settings.flattenLists || ns.getMergedTraits().xmlFlattened;
					let i = 1;
					for (const item of value) {
						if (item == null) continue;
						const traits = member.getMergedTraits();
						const suffix = this.getKey("member", traits.xmlName, traits.ec2QueryName);
						const key = flat ? `${prefix}${i}` : `${prefix}${suffix}.${i}`;
						this.write(member, item, key);
						++i;
					}
				}
			} else if (ns.isMapSchema()) {
				if (value && typeof value === "object") {
					const keySchema = ns.getKeySchema();
					const memberSchema = ns.getValueSchema();
					const flat = ns.getMergedTraits().xmlFlattened;
					let i = 1;
					for (const k in value) {
						const v = value[k];
						if (v == null) continue;
						const keyTraits = keySchema.getMergedTraits();
						const keySuffix = this.getKey("key", keyTraits.xmlName, keyTraits.ec2QueryName);
						const key = flat ? `${prefix}${i}.${keySuffix}` : `${prefix}entry.${i}.${keySuffix}`;
						const valTraits = memberSchema.getMergedTraits();
						const valueSuffix = this.getKey("value", valTraits.xmlName, valTraits.ec2QueryName);
						const valueKey = flat ? `${prefix}${i}.${valueSuffix}` : `${prefix}entry.${i}.${valueSuffix}`;
						this.write(keySchema, k, key);
						this.write(memberSchema, v, valueKey);
						++i;
					}
				}
			} else if (ns.isStructSchema()) {
				if (value && typeof value === "object") {
					let didWriteMember = false;
					for (const [memberName, member] of ns.structIterator()) {
						if (value[memberName] == null && !member.isIdempotencyToken()) continue;
						const traits = member.getMergedTraits();
						const suffix = this.getKey(memberName, traits.xmlName, traits.ec2QueryName, "struct");
						const key = `${prefix}${suffix}`;
						this.write(member, value[memberName], key);
						didWriteMember = true;
					}
					if (!didWriteMember && ns.isUnionSchema()) {
						const { $unknown } = value;
						if (Array.isArray($unknown)) {
							const [k, v] = $unknown;
							const key = `${prefix}${k}`;
							this.write(15, v, key);
						}
					}
				}
			} else if (ns.isUnitSchema()) {} else throw new Error(`@aws-sdk/core/protocols - QuerySerializer unrecognized schema type ${ns.getName(true)}`);
		}
		flush() {
			if (this.buffer === void 0) throw new Error("@aws-sdk/core/protocols - QuerySerializer cannot flush with nothing written to buffer.");
			const str = this.buffer;
			delete this.buffer;
			return str;
		}
		getKey(memberName, xmlName, ec2QueryName, keySource) {
			const { ec2, capitalizeKeys } = this.settings;
			if (ec2 && ec2QueryName) return ec2QueryName;
			const key = xmlName ?? memberName;
			if (capitalizeKeys && keySource === "struct") return key[0].toUpperCase() + key.slice(1);
			return key;
		}
		writeKey(key) {
			if (key.endsWith(".")) key = key.slice(0, key.length - 1);
			this.buffer += `&${extendedEncodeURIComponent(key)}=`;
		}
		writeValue(value) {
			this.buffer += extendedEncodeURIComponent(value);
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/query/AwsQueryProtocol.js
var AwsQueryProtocol;
var init_AwsQueryProtocol = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_ProtocolLib();
	init_XmlShapeDeserializer();
	init_QueryShapeSerializer();
	AwsQueryProtocol = class extends RpcProtocol {
		options;
		serializer;
		deserializer;
		mixin = new ProtocolLib();
		constructor(options) {
			super({
				defaultNamespace: options.defaultNamespace,
				errorTypeRegistries: options.errorTypeRegistries
			});
			this.options = options;
			const settings = {
				timestampFormat: {
					useTrait: true,
					default: 5
				},
				httpBindings: false,
				xmlNamespace: options.xmlNamespace,
				serviceNamespace: options.defaultNamespace,
				serializeEmptyLists: true
			};
			this.serializer = new QueryShapeSerializer(settings);
			this.deserializer = new XmlShapeDeserializer(settings);
		}
		getShapeId() {
			return "aws.protocols#awsQuery";
		}
		setSerdeContext(serdeContext) {
			this.serializer.setSerdeContext(serdeContext);
			this.deserializer.setSerdeContext(serdeContext);
		}
		getPayloadCodec() {
			throw new Error("AWSQuery protocol has no payload codec.");
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			if (!request.path.endsWith("/")) request.path += "/";
			request.headers["content-type"] = "application/x-www-form-urlencoded";
			if (deref(operationSchema.input) === "unit" || !request.body) request.body = "";
			request.body = `Action=${operationSchema.name.split("#")[1] ?? operationSchema.name}&Version=${this.options.version}` + request.body;
			if (request.body.endsWith("&")) request.body = request.body.slice(-1);
			return request;
		}
		async deserializeResponse(operationSchema, context, response) {
			const deserializer = this.deserializer;
			const ns = NormalizedSchema.of(operationSchema.output);
			const dataObject = {};
			if (response.statusCode >= 300) {
				const bytes = await collectBody(response.body, context);
				if (bytes.byteLength > 0) Object.assign(dataObject, await deserializer.read(15, bytes));
				await this.handleError(operationSchema, context, response, dataObject, this.deserializeMetadata(response));
			}
			for (const header in response.headers) {
				const value = response.headers[header];
				delete response.headers[header];
				response.headers[header.toLowerCase()] = value;
			}
			const shortName = operationSchema.name.split("#")[1] ?? operationSchema.name;
			const awsQueryResultKey = ns.isStructSchema() && this.useNestedResult() ? shortName + "Result" : void 0;
			const bytes = await collectBody(response.body, context);
			if (bytes.byteLength > 0) Object.assign(dataObject, await deserializer.read(ns, bytes, awsQueryResultKey));
			dataObject.$metadata = this.deserializeMetadata(response);
			return dataObject;
		}
		useNestedResult() {
			return true;
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			const errorIdentifier = this.loadQueryErrorCode(response, dataObject) ?? "Unknown";
			this.mixin.compose(this.compositeErrorRegistry, errorIdentifier, this.options.defaultNamespace);
			const errorData = this.loadQueryError(dataObject) ?? {};
			const message = this.loadQueryErrorMessage(dataObject);
			errorData.message = message;
			errorData.Error = {
				Type: errorData.Type,
				Code: errorData.Code,
				Message: message
			};
			const { errorSchema, errorMetadata } = await this.mixin.getErrorSchemaOrThrowBaseException(errorIdentifier, this.options.defaultNamespace, response, errorData, metadata, this.mixin.findQueryCompatibleError);
			const ns = NormalizedSchema.of(errorSchema);
			const exception = new ((this.compositeErrorRegistry.getErrorCtor(errorSchema)) ?? Error)({});
			const output = {
				Type: errorData.Error.Type,
				Code: errorData.Error.Code,
				Error: errorData.Error
			};
			for (const [name, member] of ns.structIterator()) {
				const target = member.getMergedTraits().xmlName ?? name;
				const value = errorData[target] ?? dataObject[target];
				output[name] = this.deserializer.readSchema(member, value);
			}
			throw this.mixin.decorateServiceException(Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output), dataObject);
		}
		loadQueryErrorCode(output, data) {
			const code = (data.Errors?.[0]?.Error ?? data.Errors?.Error ?? data.Error)?.Code;
			if (code !== void 0) return code;
			if (output.statusCode == 404) return "NotFound";
		}
		loadQueryError(data) {
			return data.Errors?.[0]?.Error ?? data.Errors?.Error ?? data.Error;
		}
		loadQueryErrorMessage(data) {
			const errorData = this.loadQueryError(data);
			return errorData?.message ?? errorData?.Message ?? data.message ?? data.Message ?? "Unknown";
		}
		getDefaultContentType() {
			return "application/x-www-form-urlencoded";
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/query/AwsEc2QueryProtocol.js
var AwsEc2QueryProtocol;
var init_AwsEc2QueryProtocol = __esmMin((() => {
	init_AwsQueryProtocol();
	AwsEc2QueryProtocol = class extends AwsQueryProtocol {
		options;
		constructor(options) {
			super(options);
			this.options = options;
			Object.assign(this.serializer.settings, {
				capitalizeKeys: true,
				flattenLists: true,
				serializeEmptyLists: false,
				ec2: true
			});
		}
		getShapeId() {
			return "aws.protocols#ec2Query";
		}
		useNestedResult() {
			return false;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/query/QuerySerializerSettings.js
var init_QuerySerializerSettings = __esmMin((() => {}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/xml/parseXmlBody.js
var import_dist_cjs$2, parseXmlBody, parseXmlErrorBody, loadRestXmlErrorCode;
var init_parseXmlBody = __esmMin((() => {
	import_dist_cjs$2 = require_dist_cjs$1();
	init_client$1();
	init_common();
	parseXmlBody = (streamBody, context) => collectBodyString(streamBody, context).then((encoded) => {
		if (encoded.length) {
			let parsedObj;
			try {
				parsedObj = (0, import_dist_cjs$2.parseXML)(encoded);
			} catch (e) {
				if (e && typeof e === "object") Object.defineProperty(e, "$responseBodyText", { value: encoded });
				throw e;
			}
			const textNodeName = "#text";
			const key = Object.keys(parsedObj)[0];
			const parsedObjToReturn = parsedObj[key];
			if (parsedObjToReturn[textNodeName]) {
				parsedObjToReturn[key] = parsedObjToReturn[textNodeName];
				delete parsedObjToReturn[textNodeName];
			}
			return getValueFromTextNode(parsedObjToReturn);
		}
		return {};
	});
	parseXmlErrorBody = async (errorBody, context) => {
		const value = await parseXmlBody(errorBody, context);
		if (value.Error) value.Error.message = value.Error.message ?? value.Error.Message;
		return value;
	};
	loadRestXmlErrorCode = (output, data) => {
		if (data?.Error?.Code !== void 0) return data.Error.Code;
		if (data?.Code !== void 0) return data.Code;
		if (output.statusCode == 404) return "NotFound";
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/xml/XmlShapeSerializer.js
var import_dist_cjs$1, XmlShapeSerializer;
var init_XmlShapeSerializer = __esmMin((() => {
	import_dist_cjs$1 = require_dist_cjs$1();
	init_protocols$1();
	init_schema();
	init_serde();
	init_ConfigurableSerdeContext();
	XmlShapeSerializer = class extends SerdeContextConfig {
		settings;
		stringBuffer;
		byteBuffer;
		buffer;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		write(schema, value) {
			const ns = NormalizedSchema.of(schema);
			if (ns.isStringSchema() && typeof value === "string") this.stringBuffer = value;
			else if (ns.isBlobSchema()) this.byteBuffer = "byteLength" in value ? value : (this.serdeContext?.base64Decoder ?? fromBase64)(value);
			else {
				this.buffer = this.writeStruct(ns, value, void 0);
				const traits = ns.getMergedTraits();
				if (traits.httpPayload && !traits.xmlName) this.buffer.withName(ns.getName());
			}
		}
		flush() {
			if (this.byteBuffer !== void 0) {
				const bytes = this.byteBuffer;
				delete this.byteBuffer;
				return bytes;
			}
			if (this.stringBuffer !== void 0) {
				const str = this.stringBuffer;
				delete this.stringBuffer;
				return str;
			}
			const buffer = this.buffer;
			if (this.settings.xmlNamespace) {
				if (!buffer?.attributes?.["xmlns"]) buffer.addAttribute("xmlns", this.settings.xmlNamespace);
			}
			delete this.buffer;
			return buffer.toString();
		}
		writeStruct(ns, value, parentXmlns) {
			const traits = ns.getMergedTraits();
			const name = ns.isMemberSchema() && !traits.httpPayload ? ns.getMemberTraits().xmlName ?? ns.getMemberName() : traits.xmlName ?? ns.getName();
			if (!name || !ns.isStructSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write struct with empty name or non-struct, schema=${ns.getName(true)}.`);
			const structXmlNode = import_dist_cjs$1.XmlNode.of(name);
			const [xmlnsAttr, xmlns] = this.getXmlnsAttribute(ns, parentXmlns);
			for (const [memberName, memberSchema] of ns.structIterator()) {
				const val = value[memberName];
				if (val != null || memberSchema.isIdempotencyToken()) {
					if (memberSchema.getMergedTraits().xmlAttribute) {
						structXmlNode.addAttribute(memberSchema.getMergedTraits().xmlName ?? memberName, this.writeSimple(memberSchema, val));
						continue;
					}
					if (memberSchema.isListSchema()) this.writeList(memberSchema, val, structXmlNode, xmlns);
					else if (memberSchema.isMapSchema()) this.writeMap(memberSchema, val, structXmlNode, xmlns);
					else if (memberSchema.isStructSchema()) structXmlNode.addChildNode(this.writeStruct(memberSchema, val, xmlns));
					else {
						const memberNode = import_dist_cjs$1.XmlNode.of(memberSchema.getMergedTraits().xmlName ?? memberSchema.getMemberName());
						this.writeSimpleInto(memberSchema, val, memberNode, xmlns);
						structXmlNode.addChildNode(memberNode);
					}
				}
			}
			const { $unknown } = value;
			if ($unknown && ns.isUnionSchema() && Array.isArray($unknown) && Object.keys(value).length === 1) {
				const [k, v] = $unknown;
				const node = import_dist_cjs$1.XmlNode.of(k);
				if (typeof v !== "string") if (value instanceof import_dist_cjs$1.XmlNode || value instanceof import_dist_cjs$1.XmlText) structXmlNode.addChildNode(value);
				else throw new Error("@aws-sdk - $unknown union member in XML requires value of type string, @aws-sdk/xml-builder::XmlNode or XmlText.");
				this.writeSimpleInto(0, v, node, xmlns);
				structXmlNode.addChildNode(node);
			}
			if (xmlns) structXmlNode.addAttribute(xmlnsAttr, xmlns);
			return structXmlNode;
		}
		writeList(listMember, array, container, parentXmlns) {
			if (!listMember.isMemberSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write non-member list: ${listMember.getName(true)}`);
			const listTraits = listMember.getMergedTraits();
			const listValueSchema = listMember.getValueSchema();
			const listValueTraits = listValueSchema.getMergedTraits();
			const sparse = !!listValueTraits.sparse;
			const flat = !!listTraits.xmlFlattened;
			const [xmlnsAttr, xmlns] = this.getXmlnsAttribute(listMember, parentXmlns);
			const writeItem = (container, value) => {
				if (listValueSchema.isListSchema()) this.writeList(listValueSchema, Array.isArray(value) ? value : [value], container, xmlns);
				else if (listValueSchema.isMapSchema()) this.writeMap(listValueSchema, value, container, xmlns);
				else if (listValueSchema.isStructSchema()) {
					const struct = this.writeStruct(listValueSchema, value, xmlns);
					container.addChildNode(struct.withName(flat ? listTraits.xmlName ?? listMember.getMemberName() : listValueTraits.xmlName ?? "member"));
				} else {
					const listItemNode = import_dist_cjs$1.XmlNode.of(flat ? listTraits.xmlName ?? listMember.getMemberName() : listValueTraits.xmlName ?? "member");
					this.writeSimpleInto(listValueSchema, value, listItemNode, xmlns);
					container.addChildNode(listItemNode);
				}
			};
			if (flat) {
				for (const value of array) if (sparse || value != null) writeItem(container, value);
			} else {
				const listNode = import_dist_cjs$1.XmlNode.of(listTraits.xmlName ?? listMember.getMemberName());
				if (xmlns) listNode.addAttribute(xmlnsAttr, xmlns);
				for (const value of array) if (sparse || value != null) writeItem(listNode, value);
				container.addChildNode(listNode);
			}
		}
		writeMap(mapMember, map, container, parentXmlns, containerIsMap = false) {
			if (!mapMember.isMemberSchema()) throw new Error(`@aws-sdk/core/protocols - xml serializer, cannot write non-member map: ${mapMember.getName(true)}`);
			const mapTraits = mapMember.getMergedTraits();
			const mapKeySchema = mapMember.getKeySchema();
			const keyTag = mapKeySchema.getMergedTraits().xmlName ?? "key";
			const mapValueSchema = mapMember.getValueSchema();
			const mapValueTraits = mapValueSchema.getMergedTraits();
			const valueTag = mapValueTraits.xmlName ?? "value";
			const sparse = !!mapValueTraits.sparse;
			const flat = !!mapTraits.xmlFlattened;
			const [xmlnsAttr, xmlns] = this.getXmlnsAttribute(mapMember, parentXmlns);
			const addKeyValue = (entry, key, val) => {
				const keyNode = import_dist_cjs$1.XmlNode.of(keyTag, key);
				const [keyXmlnsAttr, keyXmlns] = this.getXmlnsAttribute(mapKeySchema, xmlns);
				if (keyXmlns) keyNode.addAttribute(keyXmlnsAttr, keyXmlns);
				entry.addChildNode(keyNode);
				let valueNode = import_dist_cjs$1.XmlNode.of(valueTag);
				if (mapValueSchema.isListSchema()) this.writeList(mapValueSchema, val, valueNode, xmlns);
				else if (mapValueSchema.isMapSchema()) this.writeMap(mapValueSchema, val, valueNode, xmlns, true);
				else if (mapValueSchema.isStructSchema()) valueNode = this.writeStruct(mapValueSchema, val, xmlns);
				else this.writeSimpleInto(mapValueSchema, val, valueNode, xmlns);
				entry.addChildNode(valueNode);
			};
			if (flat) for (const key in map) {
				const val = map[key];
				if (sparse || val != null) {
					const entry = import_dist_cjs$1.XmlNode.of(mapTraits.xmlName ?? mapMember.getMemberName());
					addKeyValue(entry, key, val);
					container.addChildNode(entry);
				}
			}
			else {
				let mapNode;
				if (!containerIsMap) {
					mapNode = import_dist_cjs$1.XmlNode.of(mapTraits.xmlName ?? mapMember.getMemberName());
					if (xmlns) mapNode.addAttribute(xmlnsAttr, xmlns);
					container.addChildNode(mapNode);
				}
				for (const key in map) {
					const val = map[key];
					if (sparse || val != null) {
						const entry = import_dist_cjs$1.XmlNode.of("entry");
						addKeyValue(entry, key, val);
						(containerIsMap ? container : mapNode).addChildNode(entry);
					}
				}
			}
		}
		writeSimple(_schema, value) {
			if (null === value) throw new Error("@aws-sdk/core/protocols - (XML serializer) cannot write null value.");
			const ns = NormalizedSchema.of(_schema);
			let nodeContents = null;
			if (value && typeof value === "object") if (ns.isBlobSchema()) nodeContents = (this.serdeContext?.base64Encoder ?? toBase64)(value);
			else if (ns.isTimestampSchema() && value instanceof Date) switch (determineTimestampFormat(ns, this.settings)) {
				case 5:
					nodeContents = value.toISOString().replace(".000Z", "Z");
					break;
				case 6:
					nodeContents = dateToUtcString(value);
					break;
				case 7:
					nodeContents = String(value.getTime() / 1e3);
					break;
				default:
					console.warn("Missing timestamp format, using http date", value);
					nodeContents = dateToUtcString(value);
					break;
			}
			else if (ns.isBigDecimalSchema() && value) {
				if (value instanceof NumericValue) return value.string;
				return String(value);
			} else if (ns.isMapSchema() || ns.isListSchema()) throw new Error("@aws-sdk/core/protocols - xml serializer, cannot call _write() on List/Map schema, call writeList or writeMap() instead.");
			else throw new Error(`@aws-sdk/core/protocols - xml serializer, unhandled schema type for object value and schema: ${ns.getName(true)}`);
			if (ns.isBooleanSchema() || ns.isNumericSchema() || ns.isBigIntegerSchema() || ns.isBigDecimalSchema()) nodeContents = String(value);
			if (ns.isStringSchema()) if (value === void 0 && ns.isIdempotencyToken()) nodeContents = generateIdempotencyToken();
			else nodeContents = String(value);
			if (nodeContents === null) throw new Error(`Unhandled schema-value pair ${ns.getName(true)}=${value}`);
			return nodeContents;
		}
		writeSimpleInto(_schema, value, into, parentXmlns) {
			const nodeContents = this.writeSimple(_schema, value);
			const ns = NormalizedSchema.of(_schema);
			const content = new import_dist_cjs$1.XmlText(nodeContents);
			const [xmlnsAttr, xmlns] = this.getXmlnsAttribute(ns, parentXmlns);
			if (xmlns) into.addAttribute(xmlnsAttr, xmlns);
			into.addChildNode(content);
		}
		getXmlnsAttribute(ns, parentXmlns) {
			const [prefix, xmlns] = ns.getMergedTraits().xmlNamespace ?? [];
			if (xmlns && xmlns !== parentXmlns) return [prefix ? `xmlns:${prefix}` : "xmlns", xmlns];
			return [void 0, void 0];
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/xml/XmlCodec.js
var XmlCodec;
var init_XmlCodec = __esmMin((() => {
	init_ConfigurableSerdeContext();
	init_XmlShapeDeserializer();
	init_XmlShapeSerializer();
	XmlCodec = class extends SerdeContextConfig {
		settings;
		constructor(settings) {
			super();
			this.settings = settings;
		}
		createSerializer() {
			const serializer = new XmlShapeSerializer(this.settings);
			serializer.setSerdeContext(this.serdeContext);
			return serializer;
		}
		createDeserializer() {
			const deserializer = new XmlShapeDeserializer(this.settings);
			deserializer.setSerdeContext(this.serdeContext);
			return deserializer;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/xml/AwsRestXmlProtocol.js
var AwsRestXmlProtocol;
var init_AwsRestXmlProtocol = __esmMin((() => {
	init_protocols$1();
	init_schema();
	init_ProtocolLib();
	init_parseXmlBody();
	init_XmlCodec();
	AwsRestXmlProtocol = class extends HttpBindingProtocol {
		codec;
		serializer;
		deserializer;
		mixin = new ProtocolLib();
		constructor(options) {
			super(options);
			const settings = {
				timestampFormat: {
					useTrait: true,
					default: 5
				},
				httpBindings: true,
				xmlNamespace: options.xmlNamespace,
				serviceNamespace: options.defaultNamespace
			};
			this.codec = new XmlCodec(settings);
			this.serializer = new HttpInterceptingShapeSerializer(this.codec.createSerializer(), settings);
			this.deserializer = new HttpInterceptingShapeDeserializer(this.codec.createDeserializer(), settings);
		}
		getPayloadCodec() {
			return this.codec;
		}
		getShapeId() {
			return "aws.protocols#restXml";
		}
		async serializeRequest(operationSchema, input, context) {
			const request = await super.serializeRequest(operationSchema, input, context);
			const inputSchema = NormalizedSchema.of(operationSchema.input);
			if (!request.headers["content-type"]) {
				const contentType = this.mixin.resolveRestContentType(this.getDefaultContentType(), inputSchema);
				if (contentType) request.headers["content-type"] = contentType;
			}
			if (typeof request.body === "string" && request.headers["content-type"] === this.getDefaultContentType() && !request.body.startsWith("<?xml ") && !this.hasUnstructuredPayloadBinding(inputSchema)) request.body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" + request.body;
			return request;
		}
		async deserializeResponse(operationSchema, context, response) {
			return super.deserializeResponse(operationSchema, context, response);
		}
		async handleError(operationSchema, context, response, dataObject, metadata) {
			const errorIdentifier = loadRestXmlErrorCode(response, dataObject) ?? "Unknown";
			this.mixin.compose(this.compositeErrorRegistry, errorIdentifier, this.options.defaultNamespace);
			if (dataObject.Error && typeof dataObject.Error === "object") for (const key of Object.keys(dataObject.Error)) {
				dataObject[key] = dataObject.Error[key];
				if (key.toLowerCase() === "message") dataObject.message = dataObject.Error[key];
			}
			if (dataObject.RequestId && !metadata.requestId) metadata.requestId = dataObject.RequestId;
			const { errorSchema, errorMetadata } = await this.mixin.getErrorSchemaOrThrowBaseException(errorIdentifier, this.options.defaultNamespace, response, dataObject, metadata);
			const ns = NormalizedSchema.of(errorSchema);
			const message = dataObject.Error?.message ?? dataObject.Error?.Message ?? dataObject.message ?? dataObject.Message ?? "UnknownError";
			const exception = new ((this.compositeErrorRegistry.getErrorCtor(errorSchema)) ?? Error)({});
			await this.deserializeHttpMessage(errorSchema, context, response, dataObject);
			const output = {};
			const errorDeserializer = this.codec.createDeserializer();
			for (const [name, member] of ns.structIterator()) {
				const target = member.getMergedTraits().xmlName ?? name;
				const value = dataObject.Error?.[target] ?? dataObject[target];
				output[name] = errorDeserializer.readSchema(member, value);
			}
			throw this.mixin.decorateServiceException(Object.assign(exception, errorMetadata, {
				$fault: ns.getMergedTraits().error,
				message
			}, output), dataObject);
		}
		getDefaultContentType() {
			return "application/xml";
		}
		hasUnstructuredPayloadBinding(ns) {
			for (const [, member] of ns.structIterator()) if (member.getMergedTraits().httpPayload) return !(member.isStructSchema() || member.isMapSchema() || member.isListSchema());
			return false;
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/protocols/index.js
var protocols_exports = /* @__PURE__ */ __exportAll({
	AwsEc2QueryProtocol: () => AwsEc2QueryProtocol,
	AwsJson1_0Protocol: () => AwsJson1_0Protocol,
	AwsJson1_1Protocol: () => AwsJson1_1Protocol,
	AwsJsonRpcProtocol: () => AwsJsonRpcProtocol,
	AwsQueryProtocol: () => AwsQueryProtocol,
	AwsRestJsonProtocol: () => AwsRestJsonProtocol,
	AwsRestXmlProtocol: () => AwsRestXmlProtocol,
	AwsSmithyRpcV2CborProtocol: () => AwsSmithyRpcV2CborProtocol,
	JsonCodec: () => JsonCodec,
	JsonShapeDeserializer: () => JsonShapeDeserializer,
	JsonShapeSerializer: () => JsonShapeSerializer,
	QueryShapeSerializer: () => QueryShapeSerializer,
	XmlCodec: () => XmlCodec,
	XmlShapeDeserializer: () => XmlShapeDeserializer,
	XmlShapeSerializer: () => XmlShapeSerializer,
	_toBool: () => _toBool,
	_toNum: () => _toNum,
	_toStr: () => _toStr,
	awsExpectUnion: () => awsExpectUnion,
	loadJsonRpcErrorCode: () => loadJsonRpcErrorCode,
	loadRestJsonErrorCode: () => loadRestJsonErrorCode,
	loadRestXmlErrorCode: () => loadRestXmlErrorCode,
	parseJsonBody: () => parseJsonBody,
	parseJsonErrorBody: () => parseJsonErrorBody,
	parseXmlBody: () => parseXmlBody,
	parseXmlErrorBody: () => parseXmlErrorBody
});
var init_protocols = __esmMin((() => {
	init_AwsSmithyRpcV2CborProtocol();
	init_coercing_serializers();
	init_AwsJson1_0Protocol();
	init_AwsJson1_1Protocol();
	init_AwsJsonRpcProtocol();
	init_AwsRestJsonProtocol();
	init_JsonCodec();
	init_JsonShapeDeserializer();
	init_JsonShapeSerializer();
	init_awsExpectUnion();
	init_parseJsonBody();
	init_AwsEc2QueryProtocol();
	init_AwsQueryProtocol();
	init_QuerySerializerSettings();
	init_QueryShapeSerializer();
	init_AwsRestXmlProtocol();
	init_XmlCodec();
	init_XmlShapeDeserializer();
	init_XmlShapeSerializer();
	init_parseXmlBody();
}));
//#endregion
//#region node_modules/@smithy/signature-v4/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var serde = (init_serde(), __toCommonJS(serde_exports));
	var client = (init_client$1(), __toCommonJS(client_exports));
	var protocols = (init_protocols$1(), __toCommonJS(protocols_exports$1));
	var HeaderFormatter = class {
		format(headers) {
			const chunks = [];
			for (const headerName of Object.keys(headers)) {
				const bytes = serde.fromUtf8(headerName);
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
					const utf8Bytes = serde.fromUtf8(header.value);
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
					uuidBytes.set(serde.fromHex(header.value.replace(/\-/g, "")), 1);
					return uuidBytes;
			}
		}
	};
	var HEADER_VALUE_TYPE;
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
	const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
	var Int64 = class Int64 {
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
			return parseInt(serde.toHex(bytes), 16) * (negative ? -1 : 1);
		}
		toString() {
			return String(this.valueOf());
		}
	};
	function negate(bytes) {
		for (let i = 0; i < 8; i++) bytes[i] ^= 255;
		for (let i = 7; i > -1; i--) {
			bytes[i]++;
			if (bytes[i] !== 0) break;
		}
	}
	const ALGORITHM_QUERY_PARAM = "X-Amz-Algorithm";
	const CREDENTIAL_QUERY_PARAM = "X-Amz-Credential";
	const AMZ_DATE_QUERY_PARAM = "X-Amz-Date";
	const SIGNED_HEADERS_QUERY_PARAM = "X-Amz-SignedHeaders";
	const EXPIRES_QUERY_PARAM = "X-Amz-Expires";
	const SIGNATURE_QUERY_PARAM = "X-Amz-Signature";
	const TOKEN_QUERY_PARAM = "X-Amz-Security-Token";
	const REGION_SET_PARAM = "X-Amz-Region-Set";
	const AUTH_HEADER = "authorization";
	const AMZ_DATE_HEADER = AMZ_DATE_QUERY_PARAM.toLowerCase();
	const DATE_HEADER = "date";
	const GENERATED_HEADERS = [
		AUTH_HEADER,
		AMZ_DATE_HEADER,
		DATE_HEADER
	];
	const SIGNATURE_HEADER = SIGNATURE_QUERY_PARAM.toLowerCase();
	const SHA256_HEADER = "x-amz-content-sha256";
	const TOKEN_HEADER = TOKEN_QUERY_PARAM.toLowerCase();
	const HOST_HEADER = "host";
	const ALWAYS_UNSIGNABLE_HEADERS = {
		authorization: true,
		"cache-control": true,
		connection: true,
		expect: true,
		from: true,
		"keep-alive": true,
		"max-forwards": true,
		pragma: true,
		referer: true,
		te: true,
		trailer: true,
		"transfer-encoding": true,
		upgrade: true,
		"user-agent": true,
		"x-amzn-trace-id": true
	};
	const PROXY_HEADER_PATTERN = /^proxy-/;
	const SEC_HEADER_PATTERN = /^sec-/;
	const UNSIGNABLE_PATTERNS = [/^proxy-/i, /^sec-/i];
	const ALGORITHM_IDENTIFIER = "AWS4-HMAC-SHA256";
	const ALGORITHM_IDENTIFIER_V4A = "AWS4-ECDSA-P256-SHA256";
	const EVENT_ALGORITHM_IDENTIFIER = "AWS4-HMAC-SHA256-PAYLOAD";
	const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
	const MAX_CACHE_SIZE = 50;
	const KEY_TYPE_IDENTIFIER = "aws4_request";
	const MAX_PRESIGNED_TTL = 3600 * 24 * 7;
	const getCanonicalQuery = ({ query = {} }) => {
		const keys = [];
		const serialized = {};
		for (const key of Object.keys(query)) {
			if (key.toLowerCase() === SIGNATURE_HEADER) continue;
			const encodedKey = protocols.escapeUri(key);
			keys.push(encodedKey);
			const value = query[key];
			if (typeof value === "string") serialized[encodedKey] = `${encodedKey}=${protocols.escapeUri(value)}`;
			else if (Array.isArray(value)) serialized[encodedKey] = value.slice(0).reduce((encoded, value) => encoded.concat([`${encodedKey}=${protocols.escapeUri(value)}`]), []).sort().join("&");
		}
		return keys.sort().map((key) => serialized[key]).filter((serialized) => serialized).join("&");
	};
	const iso8601 = (time) => toDate(time).toISOString().replace(/\.\d{3}Z$/, "Z");
	const toDate = (time) => {
		if (typeof time === "number") return /* @__PURE__ */ new Date(time * 1e3);
		if (typeof time === "string") {
			if (Number(time)) return /* @__PURE__ */ new Date(Number(time) * 1e3);
			return new Date(time);
		}
		return time;
	};
	var SignatureV4Base = class {
		service;
		regionProvider;
		credentialProvider;
		sha256;
		uriEscapePath;
		applyChecksum;
		constructor({ applyChecksum, credentials, region, service, sha256, uriEscapePath = true }) {
			this.service = service;
			this.sha256 = sha256;
			this.uriEscapePath = uriEscapePath;
			this.applyChecksum = typeof applyChecksum === "boolean" ? applyChecksum : true;
			this.regionProvider = client.normalizeProvider(region);
			this.credentialProvider = client.normalizeProvider(credentials);
		}
		createCanonicalRequest(request, canonicalHeaders, payloadHash) {
			const sortedHeaders = Object.keys(canonicalHeaders).sort();
			return `${request.method}
${this.getCanonicalPath(request)}
${getCanonicalQuery(request)}
${sortedHeaders.map((name) => `${name}:${canonicalHeaders[name]}`).join("\n")}

${sortedHeaders.join(";")}
${payloadHash}`;
		}
		async createStringToSign(longDate, credentialScope, canonicalRequest, algorithmIdentifier) {
			const hash = new this.sha256();
			hash.update(serde.toUint8Array(canonicalRequest));
			const hashedRequest = await hash.digest();
			return `${algorithmIdentifier}
${longDate}
${credentialScope}
${serde.toHex(hashedRequest)}`;
		}
		getCanonicalPath({ path }) {
			if (this.uriEscapePath) {
				const normalizedPathSegments = [];
				for (const pathSegment of path.split("/")) {
					if (pathSegment?.length === 0) continue;
					if (pathSegment === ".") continue;
					if (pathSegment === "..") normalizedPathSegments.pop();
					else normalizedPathSegments.push(pathSegment);
				}
				const normalizedPath = `${path?.startsWith("/") ? "/" : ""}${normalizedPathSegments.join("/")}${normalizedPathSegments.length > 0 && path?.endsWith("/") ? "/" : ""}`;
				return protocols.escapeUri(normalizedPath).replace(/%2F/g, "/");
			}
			return path;
		}
		validateResolvedCredentials(credentials) {
			if (typeof credentials !== "object" || typeof credentials.accessKeyId !== "string" || typeof credentials.secretAccessKey !== "string") throw new Error("Resolved credential object is not valid");
		}
		formatDate(now) {
			const longDate = iso8601(now).replace(/[\-:]/g, "");
			return {
				longDate,
				shortDate: longDate.slice(0, 8)
			};
		}
		getCanonicalHeaderList(headers) {
			return Object.keys(headers).sort().join(";");
		}
	};
	const signingKeyCache = {};
	const cacheQueue = [];
	const createScope = (shortDate, region, service) => `${shortDate}/${region}/${service}/${KEY_TYPE_IDENTIFIER}`;
	const getSigningKey = async (sha256Constructor, credentials, shortDate, region, service) => {
		const credsHash = await hmac(sha256Constructor, credentials.secretAccessKey, credentials.accessKeyId);
		const cacheKey = `${shortDate}:${region}:${service}:${serde.toHex(credsHash)}:${credentials.sessionToken}`;
		if (cacheKey in signingKeyCache) return signingKeyCache[cacheKey];
		cacheQueue.push(cacheKey);
		while (cacheQueue.length > MAX_CACHE_SIZE) delete signingKeyCache[cacheQueue.shift()];
		let key = `AWS4${credentials.secretAccessKey}`;
		for (const signable of [
			shortDate,
			region,
			service,
			KEY_TYPE_IDENTIFIER
		]) key = await hmac(sha256Constructor, key, signable);
		return signingKeyCache[cacheKey] = key;
	};
	const clearCredentialCache = () => {
		cacheQueue.length = 0;
		Object.keys(signingKeyCache).forEach((cacheKey) => {
			delete signingKeyCache[cacheKey];
		});
	};
	const hmac = (ctor, secret, data) => {
		const hash = new ctor(secret);
		hash.update(serde.toUint8Array(data));
		return hash.digest();
	};
	const getCanonicalHeaders = ({ headers }, unsignableHeaders, signableHeaders) => {
		const canonical = {};
		for (const headerName of Object.keys(headers).sort()) {
			if (headers[headerName] == void 0) continue;
			const canonicalHeaderName = headerName.toLowerCase();
			if (canonicalHeaderName in ALWAYS_UNSIGNABLE_HEADERS || unsignableHeaders?.has(canonicalHeaderName) || PROXY_HEADER_PATTERN.test(canonicalHeaderName) || SEC_HEADER_PATTERN.test(canonicalHeaderName)) {
				if (!signableHeaders || signableHeaders && !signableHeaders.has(canonicalHeaderName)) continue;
			}
			canonical[canonicalHeaderName] = headers[headerName].trim().replace(/\s+/g, " ");
		}
		return canonical;
	};
	const getPayloadHash = async ({ headers, body }, hashConstructor) => {
		for (const headerName of Object.keys(headers)) if (headerName.toLowerCase() === SHA256_HEADER) return headers[headerName];
		if (body == void 0) return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
		else if (typeof body === "string" || ArrayBuffer.isView(body) || serde.isArrayBuffer(body)) {
			const hashCtor = new hashConstructor();
			hashCtor.update(serde.toUint8Array(body));
			return serde.toHex(await hashCtor.digest());
		}
		return UNSIGNED_PAYLOAD;
	};
	const hasHeader = (soughtHeader, headers) => {
		soughtHeader = soughtHeader.toLowerCase();
		for (const headerName of Object.keys(headers)) if (soughtHeader === headerName.toLowerCase()) return true;
		return false;
	};
	const moveHeadersToQuery = (request, options = {}) => {
		const { headers, query = {} } = protocols.HttpRequest.clone(request);
		for (const name of Object.keys(headers)) {
			const lname = name.toLowerCase();
			if (lname.slice(0, 6) === "x-amz-" && !options.unhoistableHeaders?.has(lname) || options.hoistableHeaders?.has(lname)) {
				query[name] = headers[name];
				delete headers[name];
			}
		}
		return {
			...request,
			headers,
			query
		};
	};
	const prepareRequest = (request) => {
		request = protocols.HttpRequest.clone(request);
		for (const headerName of Object.keys(request.headers)) if (GENERATED_HEADERS.indexOf(headerName.toLowerCase()) > -1) delete request.headers[headerName];
		return request;
	};
	var SignatureV4 = class extends SignatureV4Base {
		headerFormatter = new HeaderFormatter();
		constructor({ applyChecksum, credentials, region, service, sha256, uriEscapePath = true }) {
			super({
				applyChecksum,
				credentials,
				region,
				service,
				sha256,
				uriEscapePath
			});
		}
		async presign(originalRequest, options = {}) {
			const { signingDate = /* @__PURE__ */ new Date(), expiresIn = 3600, unsignableHeaders, unhoistableHeaders, signableHeaders, hoistableHeaders, signingRegion, signingService } = options;
			const credentials = await this.credentialProvider();
			this.validateResolvedCredentials(credentials);
			const region = signingRegion ?? await this.regionProvider();
			const { longDate, shortDate } = this.formatDate(signingDate);
			if (expiresIn > MAX_PRESIGNED_TTL) return Promise.reject("Signature version 4 presigned URLs must have an expiration date less than one week in the future");
			const scope = createScope(shortDate, region, signingService ?? this.service);
			const request = moveHeadersToQuery(prepareRequest(originalRequest), {
				unhoistableHeaders,
				hoistableHeaders
			});
			if (credentials.sessionToken) request.query[TOKEN_QUERY_PARAM] = credentials.sessionToken;
			request.query[ALGORITHM_QUERY_PARAM] = ALGORITHM_IDENTIFIER;
			request.query[CREDENTIAL_QUERY_PARAM] = `${credentials.accessKeyId}/${scope}`;
			request.query[AMZ_DATE_QUERY_PARAM] = longDate;
			request.query[EXPIRES_QUERY_PARAM] = expiresIn.toString(10);
			const canonicalHeaders = getCanonicalHeaders(request, unsignableHeaders, signableHeaders);
			request.query[SIGNED_HEADERS_QUERY_PARAM] = this.getCanonicalHeaderList(canonicalHeaders);
			request.query[SIGNATURE_QUERY_PARAM] = await this.getSignature(longDate, scope, this.getSigningKey(credentials, region, shortDate, signingService), this.createCanonicalRequest(request, canonicalHeaders, await getPayloadHash(originalRequest, this.sha256)));
			return request;
		}
		async sign(toSign, options) {
			if (typeof toSign === "string") return this.signString(toSign, options);
			else if (toSign.headers && toSign.payload) return this.signEvent(toSign, options);
			else if (toSign.message) return this.signMessage(toSign, options);
			else return this.signRequest(toSign, options);
		}
		async signEvent({ headers, payload }, { signingDate = /* @__PURE__ */ new Date(), priorSignature, signingRegion, signingService, eventStreamCredentials }) {
			const region = signingRegion ?? await this.regionProvider();
			const { shortDate, longDate } = this.formatDate(signingDate);
			const scope = createScope(shortDate, region, signingService ?? this.service);
			const hashedPayload = await getPayloadHash({
				headers: {},
				body: payload
			}, this.sha256);
			const hash = new this.sha256();
			hash.update(headers);
			const stringToSign = [
				EVENT_ALGORITHM_IDENTIFIER,
				longDate,
				scope,
				priorSignature,
				serde.toHex(await hash.digest()),
				hashedPayload
			].join("\n");
			return this.signString(stringToSign, {
				signingDate,
				signingRegion: region,
				signingService,
				eventStreamCredentials
			});
		}
		async signMessage(signableMessage, { signingDate = /* @__PURE__ */ new Date(), signingRegion, signingService, eventStreamCredentials }) {
			return this.signEvent({
				headers: this.headerFormatter.format(signableMessage.message.headers),
				payload: signableMessage.message.body
			}, {
				signingDate,
				signingRegion,
				signingService,
				priorSignature: signableMessage.priorSignature,
				eventStreamCredentials
			}).then((signature) => {
				return {
					message: signableMessage.message,
					signature
				};
			});
		}
		async signString(stringToSign, { signingDate = /* @__PURE__ */ new Date(), signingRegion, signingService, eventStreamCredentials } = {}) {
			const credentials = eventStreamCredentials ?? await this.credentialProvider();
			this.validateResolvedCredentials(credentials);
			const region = signingRegion ?? await this.regionProvider();
			const { shortDate } = this.formatDate(signingDate);
			const hash = new this.sha256(await this.getSigningKey(credentials, region, shortDate, signingService));
			hash.update(serde.toUint8Array(stringToSign));
			return serde.toHex(await hash.digest());
		}
		async signRequest(requestToSign, { signingDate = /* @__PURE__ */ new Date(), signableHeaders, unsignableHeaders, signingRegion, signingService } = {}) {
			const credentials = await this.credentialProvider();
			this.validateResolvedCredentials(credentials);
			const region = signingRegion ?? await this.regionProvider();
			const request = prepareRequest(requestToSign);
			const { longDate, shortDate } = this.formatDate(signingDate);
			const scope = createScope(shortDate, region, signingService ?? this.service);
			request.headers[AMZ_DATE_HEADER] = longDate;
			if (credentials.sessionToken) request.headers[TOKEN_HEADER] = credentials.sessionToken;
			const payloadHash = await getPayloadHash(request, this.sha256);
			if (!hasHeader(SHA256_HEADER, request.headers) && this.applyChecksum) request.headers[SHA256_HEADER] = payloadHash;
			const canonicalHeaders = getCanonicalHeaders(request, unsignableHeaders, signableHeaders);
			const signature = await this.getSignature(longDate, scope, this.getSigningKey(credentials, region, shortDate, signingService), this.createCanonicalRequest(request, canonicalHeaders, payloadHash));
			request.headers[AUTH_HEADER] = `${ALGORITHM_IDENTIFIER} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${this.getCanonicalHeaderList(canonicalHeaders)}, Signature=${signature}`;
			return request;
		}
		async getSignature(longDate, credentialScope, keyPromise, canonicalRequest) {
			const stringToSign = await this.createStringToSign(longDate, credentialScope, canonicalRequest, ALGORITHM_IDENTIFIER);
			const hash = new this.sha256(await keyPromise);
			hash.update(serde.toUint8Array(stringToSign));
			return serde.toHex(await hash.digest());
		}
		getSigningKey(credentials, region, shortDate, service) {
			return getSigningKey(this.sha256, credentials, shortDate, region, service || this.service);
		}
	};
	const signatureV4aContainer = { SignatureV4a: null };
	exports.ALGORITHM_IDENTIFIER = ALGORITHM_IDENTIFIER;
	exports.ALGORITHM_IDENTIFIER_V4A = ALGORITHM_IDENTIFIER_V4A;
	exports.ALGORITHM_QUERY_PARAM = ALGORITHM_QUERY_PARAM;
	exports.ALWAYS_UNSIGNABLE_HEADERS = ALWAYS_UNSIGNABLE_HEADERS;
	exports.AMZ_DATE_HEADER = AMZ_DATE_HEADER;
	exports.AMZ_DATE_QUERY_PARAM = AMZ_DATE_QUERY_PARAM;
	exports.AUTH_HEADER = AUTH_HEADER;
	exports.CREDENTIAL_QUERY_PARAM = CREDENTIAL_QUERY_PARAM;
	exports.DATE_HEADER = DATE_HEADER;
	exports.EVENT_ALGORITHM_IDENTIFIER = EVENT_ALGORITHM_IDENTIFIER;
	exports.EXPIRES_QUERY_PARAM = EXPIRES_QUERY_PARAM;
	exports.GENERATED_HEADERS = GENERATED_HEADERS;
	exports.HOST_HEADER = HOST_HEADER;
	exports.KEY_TYPE_IDENTIFIER = KEY_TYPE_IDENTIFIER;
	exports.MAX_CACHE_SIZE = MAX_CACHE_SIZE;
	exports.MAX_PRESIGNED_TTL = MAX_PRESIGNED_TTL;
	exports.PROXY_HEADER_PATTERN = PROXY_HEADER_PATTERN;
	exports.REGION_SET_PARAM = REGION_SET_PARAM;
	exports.SEC_HEADER_PATTERN = SEC_HEADER_PATTERN;
	exports.SHA256_HEADER = SHA256_HEADER;
	exports.SIGNATURE_HEADER = SIGNATURE_HEADER;
	exports.SIGNATURE_QUERY_PARAM = SIGNATURE_QUERY_PARAM;
	exports.SIGNED_HEADERS_QUERY_PARAM = SIGNED_HEADERS_QUERY_PARAM;
	exports.SignatureV4 = SignatureV4;
	exports.SignatureV4Base = SignatureV4Base;
	exports.TOKEN_HEADER = TOKEN_HEADER;
	exports.TOKEN_QUERY_PARAM = TOKEN_QUERY_PARAM;
	exports.UNSIGNABLE_PATTERNS = UNSIGNABLE_PATTERNS;
	exports.UNSIGNED_PAYLOAD = UNSIGNED_PAYLOAD;
	exports.clearCredentialCache = clearCredentialCache;
	exports.createScope = createScope;
	exports.getCanonicalHeaders = getCanonicalHeaders;
	exports.getCanonicalQuery = getCanonicalQuery;
	exports.getPayloadHash = getPayloadHash;
	exports.getSigningKey = getSigningKey;
	exports.hasHeader = hasHeader;
	exports.moveHeadersToQuery = moveHeadersToQuery;
	exports.prepareRequest = prepareRequest;
	exports.signatureV4aContainer = signatureV4aContainer;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/getDateHeader.js
var getDateHeader;
var init_getDateHeader = __esmMin((() => {
	init_protocols$1();
	getDateHeader = (response) => HttpResponse.isInstance(response) ? response.headers?.date ?? response.headers?.Date : void 0;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/getSkewCorrectedDate.js
var getSkewCorrectedDate;
var init_getSkewCorrectedDate = __esmMin((() => {
	getSkewCorrectedDate = (systemClockOffset) => new Date(Date.now() + systemClockOffset);
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/isClockSkewed.js
var isClockSkewed;
var init_isClockSkewed = __esmMin((() => {
	init_getSkewCorrectedDate();
	isClockSkewed = (clockTime, systemClockOffset) => Math.abs(getSkewCorrectedDate(systemClockOffset).getTime() - clockTime) >= 3e5;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/getUpdatedSystemClockOffset.js
var getUpdatedSystemClockOffset;
var init_getUpdatedSystemClockOffset = __esmMin((() => {
	init_isClockSkewed();
	getUpdatedSystemClockOffset = (clockTime, currentSystemClockOffset) => {
		const clockTimeInMs = Date.parse(clockTime);
		if (isClockSkewed(clockTimeInMs, currentSystemClockOffset)) return clockTimeInMs - Date.now();
		return currentSystemClockOffset;
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/index.js
var init_utils = __esmMin((() => {
	init_getDateHeader();
	init_getSkewCorrectedDate();
	init_getUpdatedSystemClockOffset();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/AwsSdkSigV4Signer.js
var throwSigningPropertyError, validateSigningProperties, AwsSdkSigV4Signer, AWSSDKSigV4Signer;
var init_AwsSdkSigV4Signer = __esmMin((() => {
	init_protocols$1();
	init_utils();
	throwSigningPropertyError = (name, property) => {
		if (!property) throw new Error(`Property \`${name}\` is not resolved for AWS SDK SigV4Auth`);
		return property;
	};
	validateSigningProperties = async (signingProperties) => {
		const context = throwSigningPropertyError("context", signingProperties.context);
		const config = throwSigningPropertyError("config", signingProperties.config);
		const authScheme = context.endpointV2?.properties?.authSchemes?.[0];
		return {
			config,
			signer: await throwSigningPropertyError("signer", config.signer)(authScheme),
			signingRegion: signingProperties?.signingRegion,
			signingRegionSet: signingProperties?.signingRegionSet,
			signingName: signingProperties?.signingName
		};
	};
	AwsSdkSigV4Signer = class {
		async sign(httpRequest, identity, signingProperties) {
			if (!HttpRequest.isInstance(httpRequest)) throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
			const validatedProps = await validateSigningProperties(signingProperties);
			const { config, signer } = validatedProps;
			let { signingRegion, signingName } = validatedProps;
			const handlerExecutionContext = signingProperties.context;
			if (handlerExecutionContext?.authSchemes?.length ?? false) {
				const [first, second] = handlerExecutionContext.authSchemes;
				if (first?.name === "sigv4a" && second?.name === "sigv4") {
					signingRegion = second?.signingRegion ?? signingRegion;
					signingName = second?.signingName ?? signingName;
				}
			}
			return await signer.sign(httpRequest, {
				signingDate: getSkewCorrectedDate(config.systemClockOffset),
				signingRegion,
				signingService: signingName
			});
		}
		errorHandler(signingProperties) {
			return (error) => {
				const serverTime = error.ServerTime ?? getDateHeader(error.$response);
				if (serverTime) {
					const config = throwSigningPropertyError("config", signingProperties.config);
					const initialSystemClockOffset = config.systemClockOffset;
					config.systemClockOffset = getUpdatedSystemClockOffset(serverTime, config.systemClockOffset);
					if (config.systemClockOffset !== initialSystemClockOffset && error.$metadata) error.$metadata.clockSkewCorrected = true;
				}
				throw error;
			};
		}
		successHandler(httpResponse, signingProperties) {
			const dateHeader = getDateHeader(httpResponse);
			if (dateHeader) {
				const config = throwSigningPropertyError("config", signingProperties.config);
				config.systemClockOffset = getUpdatedSystemClockOffset(dateHeader, config.systemClockOffset);
			}
		}
	};
	AWSSDKSigV4Signer = AwsSdkSigV4Signer;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/AwsSdkSigV4ASigner.js
var AwsSdkSigV4ASigner;
var init_AwsSdkSigV4ASigner = __esmMin((() => {
	init_protocols$1();
	init_utils();
	init_AwsSdkSigV4Signer();
	AwsSdkSigV4ASigner = class extends AwsSdkSigV4Signer {
		async sign(httpRequest, identity, signingProperties) {
			if (!HttpRequest.isInstance(httpRequest)) throw new Error("The request is not an instance of `HttpRequest` and cannot be signed");
			const { config, signer, signingRegion, signingRegionSet, signingName } = await validateSigningProperties(signingProperties);
			const multiRegionOverride = (await config.sigv4aSigningRegionSet?.() ?? signingRegionSet ?? [signingRegion]).join(",");
			return await signer.sign(httpRequest, {
				signingDate: getSkewCorrectedDate(config.systemClockOffset),
				signingRegion: multiRegionOverride,
				signingService: signingName
			});
		}
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/getArrayForCommaSeparatedString.js
var getArrayForCommaSeparatedString;
var init_getArrayForCommaSeparatedString = __esmMin((() => {
	getArrayForCommaSeparatedString = (str) => typeof str === "string" && str.length > 0 ? str.split(",").map((item) => item.trim()) : [];
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/utils/getBearerTokenEnvKey.js
var getBearerTokenEnvKey;
var init_getBearerTokenEnvKey = __esmMin((() => {
	getBearerTokenEnvKey = (signingName) => `AWS_BEARER_TOKEN_${signingName.replace(/[\s-]/g, "_").toUpperCase()}`;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/NODE_AUTH_SCHEME_PREFERENCE_OPTIONS.js
var NODE_AUTH_SCHEME_PREFERENCE_ENV_KEY, NODE_AUTH_SCHEME_PREFERENCE_CONFIG_KEY, NODE_AUTH_SCHEME_PREFERENCE_OPTIONS;
var init_NODE_AUTH_SCHEME_PREFERENCE_OPTIONS = __esmMin((() => {
	init_getArrayForCommaSeparatedString();
	init_getBearerTokenEnvKey();
	NODE_AUTH_SCHEME_PREFERENCE_ENV_KEY = "AWS_AUTH_SCHEME_PREFERENCE";
	NODE_AUTH_SCHEME_PREFERENCE_CONFIG_KEY = "auth_scheme_preference";
	NODE_AUTH_SCHEME_PREFERENCE_OPTIONS = {
		environmentVariableSelector: (env, options) => {
			if (options?.signingName) {
				if (getBearerTokenEnvKey(options.signingName) in env) return ["httpBearerAuth"];
			}
			if (!(NODE_AUTH_SCHEME_PREFERENCE_ENV_KEY in env)) return void 0;
			return getArrayForCommaSeparatedString(env[NODE_AUTH_SCHEME_PREFERENCE_ENV_KEY]);
		},
		configFileSelector: (profile) => {
			if (!(NODE_AUTH_SCHEME_PREFERENCE_CONFIG_KEY in profile)) return void 0;
			return getArrayForCommaSeparatedString(profile[NODE_AUTH_SCHEME_PREFERENCE_CONFIG_KEY]);
		},
		default: []
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/resolveAwsSdkSigV4AConfig.js
var resolveAwsSdkSigV4AConfig, NODE_SIGV4A_CONFIG_OPTIONS;
var init_resolveAwsSdkSigV4AConfig = __esmMin((() => {
	init_dist_es();
	init_config();
	resolveAwsSdkSigV4AConfig = (config) => {
		config.sigv4aSigningRegionSet = normalizeProvider(config.sigv4aSigningRegionSet);
		return config;
	};
	NODE_SIGV4A_CONFIG_OPTIONS = {
		environmentVariableSelector(env) {
			if (env.AWS_SIGV4A_SIGNING_REGION_SET) return env.AWS_SIGV4A_SIGNING_REGION_SET.split(",").map((_) => _.trim());
			throw new ProviderError("AWS_SIGV4A_SIGNING_REGION_SET not set in env.", { tryNextLink: true });
		},
		configFileSelector(profile) {
			if (profile.sigv4a_signing_region_set) return (profile.sigv4a_signing_region_set ?? "").split(",").map((_) => _.trim());
			throw new ProviderError("sigv4a_signing_region_set not set in profile.", { tryNextLink: true });
		},
		default: void 0
	};
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/resolveAwsSdkSigV4Config.js
function normalizeCredentialProvider(config, { credentials, credentialDefaultProvider }) {
	let credentialsProvider;
	if (credentials) if (!credentials?.memoized) credentialsProvider = memoizeIdentityProvider(credentials, isIdentityExpired, doesIdentityRequireRefresh);
	else credentialsProvider = credentials;
	else if (credentialDefaultProvider) credentialsProvider = normalizeProvider(credentialDefaultProvider(Object.assign({}, config, { parentClientConfig: config })));
	else credentialsProvider = async () => {
		throw new Error("@aws-sdk/core::resolveAwsSdkSigV4Config - `credentials` not provided and no credentialDefaultProvider was configured.");
	};
	credentialsProvider.memoized = true;
	return credentialsProvider;
}
function bindCallerConfig(config, credentialsProvider) {
	if (credentialsProvider.configBound) return credentialsProvider;
	const fn = async (options) => credentialsProvider({
		...options,
		callerClientConfig: config
	});
	fn.memoized = credentialsProvider.memoized;
	fn.configBound = true;
	return fn;
}
var import_dist_cjs, resolveAwsSdkSigV4Config, resolveAWSSDKSigV4Config;
var init_resolveAwsSdkSigV4Config = __esmMin((() => {
	init_client();
	init_dist_es();
	import_dist_cjs = require_dist_cjs();
	resolveAwsSdkSigV4Config = (config) => {
		let inputCredentials = config.credentials;
		let isUserSupplied = !!config.credentials;
		let resolvedCredentials = void 0;
		Object.defineProperty(config, "credentials", {
			set(credentials) {
				if (credentials && credentials !== inputCredentials && credentials !== resolvedCredentials) isUserSupplied = true;
				inputCredentials = credentials;
				const boundProvider = bindCallerConfig(config, normalizeCredentialProvider(config, {
					credentials: inputCredentials,
					credentialDefaultProvider: config.credentialDefaultProvider
				}));
				if (isUserSupplied && !boundProvider.attributed) {
					const isCredentialObject = typeof inputCredentials === "object" && inputCredentials !== null;
					resolvedCredentials = async (options) => {
						const attributedCreds = await boundProvider(options);
						if (isCredentialObject && (!attributedCreds.$source || Object.keys(attributedCreds.$source).length === 0)) return setCredentialFeature(attributedCreds, "CREDENTIALS_CODE", "e");
						return attributedCreds;
					};
					resolvedCredentials.memoized = boundProvider.memoized;
					resolvedCredentials.configBound = boundProvider.configBound;
					resolvedCredentials.attributed = true;
				} else resolvedCredentials = boundProvider;
			},
			get() {
				return resolvedCredentials;
			},
			enumerable: true,
			configurable: true
		});
		config.credentials = inputCredentials;
		const { signingEscapePath = true, systemClockOffset = config.systemClockOffset || 0, sha256 } = config;
		let signer;
		if (config.signer) signer = normalizeProvider(config.signer);
		else if (config.regionInfoProvider) signer = () => normalizeProvider(config.region)().then(async (region) => [await config.regionInfoProvider(region, {
			useFipsEndpoint: await config.useFipsEndpoint(),
			useDualstackEndpoint: await config.useDualstackEndpoint()
		}) || {}, region]).then(([regionInfo, region]) => {
			const { signingRegion, signingService } = regionInfo;
			config.signingRegion = config.signingRegion || signingRegion || region;
			config.signingName = config.signingName || signingService || config.serviceId;
			const params = {
				...config,
				credentials: config.credentials,
				region: config.signingRegion,
				service: config.signingName,
				sha256,
				uriEscapePath: signingEscapePath
			};
			return new (config.signerConstructor || import_dist_cjs.SignatureV4)(params);
		});
		else signer = async (authScheme) => {
			authScheme = Object.assign({}, {
				name: "sigv4",
				signingName: config.signingName || config.defaultSigningName,
				signingRegion: await normalizeProvider(config.region)(),
				properties: {}
			}, authScheme);
			const signingRegion = authScheme.signingRegion;
			const signingService = authScheme.signingName;
			config.signingRegion = config.signingRegion || signingRegion;
			config.signingName = config.signingName || signingService || config.serviceId;
			const params = {
				...config,
				credentials: config.credentials,
				region: config.signingRegion,
				service: config.signingName,
				sha256,
				uriEscapePath: signingEscapePath
			};
			return new (config.signerConstructor || import_dist_cjs.SignatureV4)(params);
		};
		return Object.assign(config, {
			systemClockOffset,
			signingEscapePath,
			signer
		});
	};
	resolveAWSSDKSigV4Config = resolveAwsSdkSigV4Config;
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/aws_sdk/index.js
var init_aws_sdk = __esmMin((() => {
	init_AwsSdkSigV4Signer();
	init_AwsSdkSigV4ASigner();
	init_NODE_AUTH_SCHEME_PREFERENCE_OPTIONS();
	init_resolveAwsSdkSigV4AConfig();
	init_resolveAwsSdkSigV4Config();
}));
//#endregion
//#region node_modules/@aws-sdk/core/dist-es/submodules/httpAuthSchemes/index.js
var httpAuthSchemes_exports = /* @__PURE__ */ __exportAll({
	AWSSDKSigV4Signer: () => AWSSDKSigV4Signer,
	AwsSdkSigV4ASigner: () => AwsSdkSigV4ASigner,
	AwsSdkSigV4Signer: () => AwsSdkSigV4Signer,
	NODE_AUTH_SCHEME_PREFERENCE_OPTIONS: () => NODE_AUTH_SCHEME_PREFERENCE_OPTIONS,
	NODE_SIGV4A_CONFIG_OPTIONS: () => NODE_SIGV4A_CONFIG_OPTIONS,
	getBearerTokenEnvKey: () => getBearerTokenEnvKey,
	resolveAWSSDKSigV4Config: () => resolveAWSSDKSigV4Config,
	resolveAwsSdkSigV4AConfig: () => resolveAwsSdkSigV4AConfig,
	resolveAwsSdkSigV4Config: () => resolveAwsSdkSigV4Config,
	validateSigningProperties: () => validateSigningProperties
});
var init_httpAuthSchemes = __esmMin((() => {
	init_aws_sdk();
	init_getBearerTokenEnvKey();
}));
//#endregion
export { AwsQueryProtocol as _, NODE_SIGV4A_CONFIG_OPTIONS as a, init_AwsRestJsonProtocol as b, NODE_AUTH_SCHEME_PREFERENCE_OPTIONS as c, init_AwsSdkSigV4ASigner as d, AwsSdkSigV4Signer as f, protocols_exports as g, init_protocols as h, resolveAwsSdkSigV4Config as i, init_NODE_AUTH_SCHEME_PREFERENCE_OPTIONS as l, require_dist_cjs as m, init_httpAuthSchemes as n, init_resolveAwsSdkSigV4AConfig as o, init_AwsSdkSigV4Signer as p, init_resolveAwsSdkSigV4Config as r, resolveAwsSdkSigV4AConfig as s, httpAuthSchemes_exports as t, AwsSdkSigV4ASigner as u, init_AwsQueryProtocol as v, AwsRestJsonProtocol as y };
