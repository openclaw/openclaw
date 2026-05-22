import { a as __require, t as __commonJSMin } from "./chunk-A-jGZS85.js";
//#region node_modules/@smithy/is-array-buffer/dist-cjs/index.js
var require_dist_cjs$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	const isArrayBuffer = (arg) => typeof ArrayBuffer === "function" && arg instanceof ArrayBuffer || Object.prototype.toString.call(arg) === "[object ArrayBuffer]";
	exports.isArrayBuffer = isArrayBuffer;
}));
//#endregion
//#region node_modules/@smithy/util-buffer-from/dist-cjs/index.js
var require_dist_cjs$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var isArrayBuffer = require_dist_cjs$2();
	var buffer = __require("buffer");
	const fromArrayBuffer = (input, offset = 0, length = input.byteLength - offset) => {
		if (!isArrayBuffer.isArrayBuffer(input)) throw new TypeError(`The "input" argument must be ArrayBuffer. Received type ${typeof input} (${input})`);
		return buffer.Buffer.from(input, offset, length);
	};
	const fromString = (input, encoding) => {
		if (typeof input !== "string") throw new TypeError(`The "input" argument must be of type string. Received type ${typeof input} (${input})`);
		return encoding ? buffer.Buffer.from(input, encoding) : buffer.Buffer.from(input);
	};
	exports.fromArrayBuffer = fromArrayBuffer;
	exports.fromString = fromString;
}));
//#endregion
//#region node_modules/@smithy/util-utf8/dist-cjs/index.js
var require_dist_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	var utilBufferFrom = require_dist_cjs$1();
	const fromUtf8 = (input) => {
		const buf = utilBufferFrom.fromString(input, "utf8");
		return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength / Uint8Array.BYTES_PER_ELEMENT);
	};
	const toUint8Array = (data) => {
		if (typeof data === "string") return fromUtf8(data);
		if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength / Uint8Array.BYTES_PER_ELEMENT);
		return new Uint8Array(data);
	};
	const toUtf8 = (input) => {
		if (typeof input === "string") return input;
		if (typeof input !== "object" || typeof input.byteOffset !== "number" || typeof input.byteLength !== "number") throw new Error("@smithy/util-utf8: toUtf8 encoder function only accepts string | Uint8Array.");
		return utilBufferFrom.fromArrayBuffer(input.buffer, input.byteOffset, input.byteLength).toString("utf8");
	};
	exports.fromUtf8 = fromUtf8;
	exports.toUint8Array = toUint8Array;
	exports.toUtf8 = toUtf8;
}));
//#endregion
export { require_dist_cjs$1 as n, require_dist_cjs$2 as r, require_dist_cjs as t };
