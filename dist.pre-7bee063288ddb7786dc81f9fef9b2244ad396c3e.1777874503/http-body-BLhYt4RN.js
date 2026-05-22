import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { clearTimeout, setTimeout } from "node:timers";
//#region src/infra/http-body.ts
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_WEBHOOK_BODY_TIMEOUT_MS = 3e4;
const DEFAULT_ERROR_MESSAGE = {
	PAYLOAD_TOO_LARGE: "PayloadTooLarge",
	REQUEST_BODY_TIMEOUT: "RequestBodyTimeout",
	CONNECTION_CLOSED: "RequestBodyConnectionClosed"
};
const DEFAULT_ERROR_STATUS_CODE = {
	PAYLOAD_TOO_LARGE: 413,
	REQUEST_BODY_TIMEOUT: 408,
	CONNECTION_CLOSED: 400
};
const DEFAULT_RESPONSE_MESSAGE = {
	PAYLOAD_TOO_LARGE: "Payload too large",
	REQUEST_BODY_TIMEOUT: "Request body timeout",
	CONNECTION_CLOSED: "Connection closed"
};
var RequestBodyLimitError = class extends Error {
	constructor(init) {
		super(init.message ?? DEFAULT_ERROR_MESSAGE[init.code]);
		this.name = "RequestBodyLimitError";
		this.code = init.code;
		this.statusCode = DEFAULT_ERROR_STATUS_CODE[init.code];
	}
};
function isRequestBodyLimitError(error, code) {
	if (!(error instanceof RequestBodyLimitError)) return false;
	if (!code) return true;
	return error.code === code;
}
function requestBodyErrorToText(code) {
	return DEFAULT_RESPONSE_MESSAGE[code];
}
function parseContentLengthHeader(req) {
	const header = req.headers["content-length"];
	const raw = Array.isArray(header) ? header[0] : header;
	if (typeof raw !== "string") return null;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return null;
	return parsed;
}
function resolveRequestBodyLimitValues(options) {
	return {
		maxBytes: Number.isFinite(options.maxBytes) ? Math.max(1, Math.floor(options.maxBytes)) : 1,
		timeoutMs: typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.floor(options.timeoutMs)) : DEFAULT_WEBHOOK_BODY_TIMEOUT_MS
	};
}
function advanceRequestBodyChunk(chunk, totalBytes, maxBytes) {
	const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	const nextTotalBytes = totalBytes + buffer.length;
	return {
		buffer,
		totalBytes: nextTotalBytes,
		exceeded: nextTotalBytes > maxBytes
	};
}
async function readRequestBodyWithLimit(req, options) {
	const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
	const encoding = options.encoding ?? "utf-8";
	const declaredLength = parseContentLengthHeader(req);
	if (declaredLength !== null && declaredLength > maxBytes) {
		const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
		if (!req.destroyed) req.destroy();
		throw error;
	}
	return await new Promise((resolve, reject) => {
		let done = false;
		let ended = false;
		let totalBytes = 0;
		const chunks = [];
		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
			req.removeListener("close", onClose);
			clearTimeout(timer);
		};
		const finish = (cb) => {
			if (done) return;
			done = true;
			cleanup();
			cb();
		};
		const fail = (error) => {
			finish(() => reject(error));
		};
		const timer = setTimeout(() => {
			const error = new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" });
			if (!req.destroyed) req.destroy();
			fail(error);
		}, timeoutMs);
		const onData = (chunk) => {
			if (done) return;
			const progress = advanceRequestBodyChunk(chunk, totalBytes, maxBytes);
			totalBytes = progress.totalBytes;
			if (progress.exceeded) {
				const error = new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" });
				if (!req.destroyed) req.destroy();
				fail(error);
				return;
			}
			chunks.push(progress.buffer);
		};
		const onEnd = () => {
			ended = true;
			finish(() => resolve(Buffer.concat(chunks).toString(encoding)));
		};
		const onError = (error) => {
			if (done) return;
			fail(error);
		};
		const onClose = () => {
			if (done || ended) return;
			fail(new RequestBodyLimitError({ code: "CONNECTION_CLOSED" }));
		};
		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
		req.on("close", onClose);
	});
}
async function readJsonBodyWithLimit(req, options) {
	try {
		const trimmed = (await readRequestBodyWithLimit(req, options)).trim();
		if (!trimmed) {
			if (options.emptyObjectOnEmpty === false) return {
				ok: false,
				code: "INVALID_JSON",
				error: "empty payload"
			};
			return {
				ok: true,
				value: {}
			};
		}
		try {
			return {
				ok: true,
				value: JSON.parse(trimmed)
			};
		} catch (error) {
			return {
				ok: false,
				code: "INVALID_JSON",
				error: formatErrorMessage(error)
			};
		}
	} catch (error) {
		if (isRequestBodyLimitError(error)) return {
			ok: false,
			code: error.code,
			error: requestBodyErrorToText(error.code)
		};
		return {
			ok: false,
			code: "INVALID_JSON",
			error: formatErrorMessage(error)
		};
	}
}
function installRequestBodyLimitGuard(req, res, options) {
	const { maxBytes, timeoutMs } = resolveRequestBodyLimitValues(options);
	const responseFormat = options.responseFormat ?? "json";
	const customText = options.responseText ?? {};
	let tripped = false;
	let reason = null;
	let done = false;
	let ended = false;
	let totalBytes = 0;
	const cleanup = () => {
		req.removeListener("data", onData);
		req.removeListener("end", onEnd);
		req.removeListener("close", onClose);
		req.removeListener("error", onError);
		clearTimeout(timer);
	};
	const finish = () => {
		if (done) return;
		done = true;
		cleanup();
	};
	const respond = (error) => {
		const text = customText[error.code] ?? requestBodyErrorToText(error.code);
		if (!res.headersSent) {
			res.statusCode = error.statusCode;
			if (responseFormat === "text") {
				res.setHeader("Content-Type", "text/plain; charset=utf-8");
				res.end(text);
			} else {
				res.setHeader("Content-Type", "application/json; charset=utf-8");
				res.end(JSON.stringify({ error: text }));
			}
		}
	};
	const trip = (error) => {
		if (tripped) return;
		tripped = true;
		reason = error.code;
		finish();
		respond(error);
		if (!req.destroyed) req.destroy();
	};
	const onData = (chunk) => {
		if (done) return;
		const progress = advanceRequestBodyChunk(chunk, totalBytes, maxBytes);
		totalBytes = progress.totalBytes;
		if (progress.exceeded) trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
	};
	const onEnd = () => {
		ended = true;
		finish();
	};
	const onClose = () => {
		if (done || ended) return;
		finish();
	};
	const onError = () => {
		finish();
	};
	const timer = setTimeout(() => {
		trip(new RequestBodyLimitError({ code: "REQUEST_BODY_TIMEOUT" }));
	}, timeoutMs);
	req.on("data", onData);
	req.on("end", onEnd);
	req.on("close", onClose);
	req.on("error", onError);
	const declaredLength = parseContentLengthHeader(req);
	if (declaredLength !== null && declaredLength > maxBytes) trip(new RequestBodyLimitError({ code: "PAYLOAD_TOO_LARGE" }));
	return {
		dispose: finish,
		isTripped: () => tripped,
		code: () => reason
	};
}
//#endregion
export { isRequestBodyLimitError as a, requestBodyErrorToText as c, installRequestBodyLimitGuard as i, DEFAULT_WEBHOOK_MAX_BODY_BYTES as n, readJsonBodyWithLimit as o, RequestBodyLimitError as r, readRequestBodyWithLimit as s, DEFAULT_WEBHOOK_BODY_TIMEOUT_MS as t };
