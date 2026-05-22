import { n as __esmMin, r as __exportAll } from "./chunk-A-jGZS85.js";
import { createHash } from "node:crypto";
//#region node_modules/uuid/dist-node/max.js
var max_default;
var init_max = __esmMin((() => {
	max_default = "ffffffff-ffff-ffff-ffff-ffffffffffff";
}));
//#endregion
//#region node_modules/uuid/dist-node/nil.js
var nil_default;
var init_nil = __esmMin((() => {
	nil_default = "00000000-0000-0000-0000-000000000000";
}));
//#endregion
//#region node_modules/uuid/dist-node/regex.js
var regex_default;
var init_regex = __esmMin((() => {
	regex_default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
}));
//#endregion
//#region node_modules/uuid/dist-node/validate.js
function validate(uuid) {
	return typeof uuid === "string" && regex_default.test(uuid);
}
var init_validate = __esmMin((() => {
	init_regex();
}));
//#endregion
//#region node_modules/uuid/dist-node/parse.js
function parse(uuid) {
	if (!validate(uuid)) throw TypeError("Invalid UUID");
	let v;
	return Uint8Array.of((v = parseInt(uuid.slice(0, 8), 16)) >>> 24, v >>> 16 & 255, v >>> 8 & 255, v & 255, (v = parseInt(uuid.slice(9, 13), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(14, 18), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(19, 23), 16)) >>> 8, v & 255, (v = parseInt(uuid.slice(24, 36), 16)) / 1099511627776 & 255, v / 4294967296 & 255, v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
}
var init_parse = __esmMin((() => {
	init_validate();
}));
//#endregion
//#region node_modules/uuid/dist-node/stringify.js
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!validate(uuid)) throw TypeError("Stringified UUID is invalid");
	return uuid;
}
var byteToHex;
var init_stringify = __esmMin((() => {
	init_validate();
	byteToHex = [];
	for (let i = 0; i < 256; ++i) byteToHex.push((i + 256).toString(16).slice(1));
}));
//#endregion
//#region node_modules/uuid/dist-node/rng.js
function rng() {
	return crypto.getRandomValues(rnds8);
}
var rnds8;
var init_rng = __esmMin((() => {
	rnds8 = new Uint8Array(16);
}));
//#endregion
//#region node_modules/uuid/dist-node/v1.js
function v1(options, buf, offset) {
	let bytes;
	const isV6 = options?._v6 ?? false;
	if (options) {
		const optionsKeys = Object.keys(options);
		if (optionsKeys.length === 1 && optionsKeys[0] === "_v6") options = void 0;
	}
	if (options) bytes = v1Bytes(options.random ?? options.rng?.() ?? rng(), options.msecs, options.nsecs, options.clockseq, options.node, buf, offset);
	else {
		const now = Date.now();
		const rnds = rng();
		updateV1State(_state$1, now, rnds);
		bytes = v1Bytes(rnds, _state$1.msecs, _state$1.nsecs, isV6 ? void 0 : _state$1.clockseq, isV6 ? void 0 : _state$1.node, buf, offset);
	}
	return buf ?? unsafeStringify(bytes);
}
function updateV1State(state, now, rnds) {
	state.msecs ??= -Infinity;
	state.nsecs ??= 0;
	if (now === state.msecs) {
		state.nsecs++;
		if (state.nsecs >= 1e4) {
			state.node = void 0;
			state.nsecs = 0;
		}
	} else if (now > state.msecs) state.nsecs = 0;
	else if (now < state.msecs) state.node = void 0;
	if (!state.node) {
		state.node = rnds.slice(10, 16);
		state.node[0] |= 1;
		state.clockseq = (rnds[8] << 8 | rnds[9]) & 16383;
	}
	state.msecs = now;
	return state;
}
function v1Bytes(rnds, msecs, nsecs, clockseq, node, buf, offset = 0) {
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	if (!buf) {
		buf = new Uint8Array(16);
		offset = 0;
	} else if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
	msecs ??= Date.now();
	nsecs ??= 0;
	clockseq ??= (rnds[8] << 8 | rnds[9]) & 16383;
	node ??= rnds.slice(10, 16);
	msecs += 0xb1d069b5400;
	const tl = ((msecs & 268435455) * 1e4 + nsecs) % 4294967296;
	buf[offset++] = tl >>> 24 & 255;
	buf[offset++] = tl >>> 16 & 255;
	buf[offset++] = tl >>> 8 & 255;
	buf[offset++] = tl & 255;
	const tmh = msecs / 4294967296 * 1e4 & 268435455;
	buf[offset++] = tmh >>> 8 & 255;
	buf[offset++] = tmh & 255;
	buf[offset++] = tmh >>> 24 & 15 | 16;
	buf[offset++] = tmh >>> 16 & 255;
	buf[offset++] = clockseq >>> 8 | 128;
	buf[offset++] = clockseq & 255;
	for (let n = 0; n < 6; ++n) buf[offset++] = node[n];
	return buf;
}
var _state$1;
var init_v1 = __esmMin((() => {
	init_rng();
	init_stringify();
	_state$1 = {};
}));
//#endregion
//#region node_modules/uuid/dist-node/v1ToV6.js
function v1ToV6(uuid) {
	const v6Bytes = _v1ToV6(typeof uuid === "string" ? parse(uuid) : uuid);
	return typeof uuid === "string" ? unsafeStringify(v6Bytes) : v6Bytes;
}
function _v1ToV6(v1Bytes) {
	return Uint8Array.of((v1Bytes[6] & 15) << 4 | v1Bytes[7] >> 4 & 15, (v1Bytes[7] & 15) << 4 | (v1Bytes[4] & 240) >> 4, (v1Bytes[4] & 15) << 4 | (v1Bytes[5] & 240) >> 4, (v1Bytes[5] & 15) << 4 | (v1Bytes[0] & 240) >> 4, (v1Bytes[0] & 15) << 4 | (v1Bytes[1] & 240) >> 4, (v1Bytes[1] & 15) << 4 | (v1Bytes[2] & 240) >> 4, 96 | v1Bytes[2] & 15, v1Bytes[3], v1Bytes[8], v1Bytes[9], v1Bytes[10], v1Bytes[11], v1Bytes[12], v1Bytes[13], v1Bytes[14], v1Bytes[15]);
}
var init_v1ToV6 = __esmMin((() => {
	init_parse();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/md5.js
function md5(bytes) {
	if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
	else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
	return createHash("md5").update(bytes).digest();
}
var init_md5 = __esmMin((() => {}));
//#endregion
//#region node_modules/uuid/dist-node/v35.js
function stringToBytes(str) {
	str = unescape(encodeURIComponent(str));
	const bytes = new Uint8Array(str.length);
	for (let i = 0; i < str.length; ++i) bytes[i] = str.charCodeAt(i);
	return bytes;
}
function v35(version, hash, value, namespace, buf, offset) {
	const valueBytes = typeof value === "string" ? stringToBytes(value) : value;
	const namespaceBytes = typeof namespace === "string" ? parse(namespace) : namespace;
	if (typeof namespace === "string") namespace = parse(namespace);
	if (namespace?.length !== 16) throw TypeError("Namespace must be array-like (16 iterable integer values, 0-255)");
	let bytes = new Uint8Array(16 + valueBytes.length);
	bytes.set(namespaceBytes);
	bytes.set(valueBytes, namespaceBytes.length);
	bytes = hash(bytes);
	bytes[6] = bytes[6] & 15 | version;
	bytes[8] = bytes[8] & 63 | 128;
	if (buf) {
		offset ??= 0;
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; ++i) buf[offset + i] = bytes[i];
		return buf;
	}
	return unsafeStringify(bytes);
}
var DNS, URL;
var init_v35 = __esmMin((() => {
	init_parse();
	init_stringify();
	DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
	URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
}));
//#endregion
//#region node_modules/uuid/dist-node/v3.js
function v3(value, namespace, buf, offset) {
	return v35(48, md5, value, namespace, buf, offset);
}
var init_v3 = __esmMin((() => {
	init_md5();
	init_v35();
	v3.DNS = DNS;
	v3.URL = URL;
}));
//#endregion
//#region node_modules/uuid/dist-node/v4.js
function v4(options, buf, offset) {
	if (!buf && !options && crypto.randomUUID) return crypto.randomUUID();
	return _v4(options, buf, offset);
}
function _v4(options, buf, offset) {
	options = options || {};
	const rnds = options.random ?? options.rng?.() ?? rng();
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	rnds[6] = rnds[6] & 15 | 64;
	rnds[8] = rnds[8] & 63 | 128;
	if (buf) {
		offset = offset || 0;
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; ++i) buf[offset + i] = rnds[i];
		return buf;
	}
	return unsafeStringify(rnds);
}
var init_v4 = __esmMin((() => {
	init_rng();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/sha1.js
function sha1(bytes) {
	if (Array.isArray(bytes)) bytes = Buffer.from(bytes);
	else if (typeof bytes === "string") bytes = Buffer.from(bytes, "utf8");
	return createHash("sha1").update(bytes).digest();
}
var init_sha1 = __esmMin((() => {}));
//#endregion
//#region node_modules/uuid/dist-node/v5.js
function v5(value, namespace, buf, offset) {
	return v35(80, sha1, value, namespace, buf, offset);
}
var init_v5 = __esmMin((() => {
	init_sha1();
	init_v35();
	v5.DNS = DNS;
	v5.URL = URL;
}));
//#endregion
//#region node_modules/uuid/dist-node/v6.js
function v6(options, buf, offset) {
	options ??= {};
	offset ??= 0;
	let bytes = v1({
		...options,
		_v6: true
	}, new Uint8Array(16));
	bytes = v1ToV6(bytes);
	if (buf) {
		if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
		for (let i = 0; i < 16; i++) buf[offset + i] = bytes[i];
		return buf;
	}
	return unsafeStringify(bytes);
}
var init_v6 = __esmMin((() => {
	init_stringify();
	init_v1();
	init_v1ToV6();
}));
//#endregion
//#region node_modules/uuid/dist-node/v6ToV1.js
function v6ToV1(uuid) {
	const v1Bytes = _v6ToV1(typeof uuid === "string" ? parse(uuid) : uuid);
	return typeof uuid === "string" ? unsafeStringify(v1Bytes) : v1Bytes;
}
function _v6ToV1(v6Bytes) {
	return Uint8Array.of((v6Bytes[3] & 15) << 4 | v6Bytes[4] >> 4 & 15, (v6Bytes[4] & 15) << 4 | (v6Bytes[5] & 240) >> 4, (v6Bytes[5] & 15) << 4 | v6Bytes[6] & 15, v6Bytes[7], (v6Bytes[1] & 15) << 4 | (v6Bytes[2] & 240) >> 4, (v6Bytes[2] & 15) << 4 | (v6Bytes[3] & 240) >> 4, 16 | (v6Bytes[0] & 240) >> 4, (v6Bytes[0] & 15) << 4 | (v6Bytes[1] & 240) >> 4, v6Bytes[8], v6Bytes[9], v6Bytes[10], v6Bytes[11], v6Bytes[12], v6Bytes[13], v6Bytes[14], v6Bytes[15]);
}
var init_v6ToV1 = __esmMin((() => {
	init_parse();
	init_stringify();
}));
//#endregion
//#region node_modules/uuid/dist-node/v7.js
function v7(options, buf, offset) {
	let bytes;
	if (options) bytes = v7Bytes(options.random ?? options.rng?.() ?? rng(), options.msecs, options.seq, buf, offset);
	else {
		const now = Date.now();
		const rnds = rng();
		updateV7State(_state, now, rnds);
		bytes = v7Bytes(rnds, _state.msecs, _state.seq, buf, offset);
	}
	return buf ?? unsafeStringify(bytes);
}
function updateV7State(state, now, rnds) {
	state.msecs ??= -Infinity;
	state.seq ??= 0;
	if (now > state.msecs) {
		state.seq = rnds[6] << 23 | rnds[7] << 16 | rnds[8] << 8 | rnds[9];
		state.msecs = now;
	} else {
		state.seq = state.seq + 1 | 0;
		if (state.seq === 0) state.msecs++;
	}
	return state;
}
function v7Bytes(rnds, msecs, seq, buf, offset = 0) {
	if (rnds.length < 16) throw new Error("Random bytes length must be >= 16");
	if (!buf) {
		buf = new Uint8Array(16);
		offset = 0;
	} else if (offset < 0 || offset + 16 > buf.length) throw new RangeError(`UUID byte range ${offset}:${offset + 15} is out of buffer bounds`);
	msecs ??= Date.now();
	seq ??= rnds[6] * 127 << 24 | rnds[7] << 16 | rnds[8] << 8 | rnds[9];
	buf[offset++] = msecs / 1099511627776 & 255;
	buf[offset++] = msecs / 4294967296 & 255;
	buf[offset++] = msecs / 16777216 & 255;
	buf[offset++] = msecs / 65536 & 255;
	buf[offset++] = msecs / 256 & 255;
	buf[offset++] = msecs & 255;
	buf[offset++] = 112 | seq >>> 28 & 15;
	buf[offset++] = seq >>> 20 & 255;
	buf[offset++] = 128 | seq >>> 14 & 63;
	buf[offset++] = seq >>> 6 & 255;
	buf[offset++] = seq << 2 & 255 | rnds[10] & 3;
	buf[offset++] = rnds[11];
	buf[offset++] = rnds[12];
	buf[offset++] = rnds[13];
	buf[offset++] = rnds[14];
	buf[offset++] = rnds[15];
	return buf;
}
var _state;
var init_v7 = __esmMin((() => {
	init_rng();
	init_stringify();
	_state = {};
}));
//#endregion
//#region node_modules/uuid/dist-node/version.js
function version(uuid) {
	if (!validate(uuid)) throw TypeError("Invalid UUID");
	return parseInt(uuid.slice(14, 15), 16);
}
var init_version = __esmMin((() => {
	init_validate();
}));
//#endregion
//#region node_modules/uuid/dist-node/index.js
var dist_node_exports = /* @__PURE__ */ __exportAll({
	MAX: () => max_default,
	NIL: () => nil_default,
	parse: () => parse,
	stringify: () => stringify,
	v1: () => v1,
	v1ToV6: () => v1ToV6,
	v3: () => v3,
	v4: () => v4,
	v5: () => v5,
	v6: () => v6,
	v6ToV1: () => v6ToV1,
	v7: () => v7,
	validate: () => validate,
	version: () => version
});
var init_dist_node = __esmMin((() => {
	init_max();
	init_nil();
	init_parse();
	init_stringify();
	init_v1();
	init_v1ToV6();
	init_v3();
	init_v4();
	init_v5();
	init_v6();
	init_v6ToV1();
	init_v7();
	init_validate();
	init_version();
}));
//#endregion
export { init_dist_node as n, v7 as r, dist_node_exports as t };
