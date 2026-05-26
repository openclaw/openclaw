import crypto from "node:crypto";
//#region src/infra/diagnostic-error-metadata.ts
const HTTP_STATUS_MIN = 100;
const HTTP_STATUS_MAX = 599;
const REQUEST_ID_HASH_PREFIX_LEN = 12;
const PROVIDER_REQUEST_ID_KEYS = [
	"upstreamRequestId",
	"providerRequestId",
	"requestId",
	"request_id"
];
const PROVIDER_REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u;
const PROVIDER_REQUEST_ID_TEXT_PATTERNS = [/\b(?:x-request-id|request-id|request_id|requestId|trace-id|trace_id)\b["'\s:=([]+([A-Za-z0-9._:-]{1,128})/i, /\((?:request_id|trace_id)\s*:\s*([A-Za-z0-9._:-]{1,128})\)/i];
function isObjectLike(value) {
	return (typeof value === "object" || typeof value === "function") && value !== null;
}
function readOwnDataProperty(value, key) {
	if (!isObjectLike(value)) return;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : void 0;
	} catch {
		return;
	}
}
function findDiagnosticErrorProperty(err, reader, seen = /* @__PURE__ */ new Set()) {
	const direct = reader(err);
	if (direct !== void 0) return direct;
	if (!isObjectLike(err) || seen.has(err)) return;
	seen.add(err);
	return findDiagnosticErrorProperty(readOwnDataProperty(err, "error"), reader, seen) ?? findDiagnosticErrorProperty(readOwnDataProperty(err, "cause"), reader, seen);
}
function isHttpStatusCode(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= HTTP_STATUS_MIN && value <= HTTP_STATUS_MAX;
}
function normalizeProviderRequestId(value) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return PROVIDER_REQUEST_ID_RE.test(trimmed) ? trimmed : void 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		const normalized = String(value);
		return PROVIDER_REQUEST_ID_RE.test(normalized) ? normalized : void 0;
	}
	if (typeof value === "bigint") {
		const normalized = String(value);
		return PROVIDER_REQUEST_ID_RE.test(normalized) ? normalized : void 0;
	}
}
function hashDiagnosticIdentifier(value) {
	return `sha256:${crypto.createHash("sha256").update(value).digest("hex").slice(0, REQUEST_ID_HASH_PREFIX_LEN)}`;
}
function readDirectProviderRequestId(err) {
	for (const key of PROVIDER_REQUEST_ID_KEYS) {
		const normalized = normalizeProviderRequestId(readOwnDataProperty(err, key));
		if (normalized) return normalized;
	}
}
function readDirectMessage(err) {
	if (typeof err === "string") return err;
	const message = readOwnDataProperty(err, "message");
	return typeof message === "string" ? message : void 0;
}
function readDirectCode(err) {
	const code = readOwnDataProperty(err, "code");
	return typeof code === "string" ? code : void 0;
}
function extractProviderRequestIdFromText(text) {
	if (!text) return;
	for (const pattern of PROVIDER_REQUEST_ID_TEXT_PATTERNS) {
		const normalized = normalizeProviderRequestId(text.match(pattern)?.[1]);
		if (normalized) return normalized;
	}
}
function diagnosticErrorCategory(err) {
	try {
		if (err instanceof TypeError) return "TypeError";
		if (err instanceof RangeError) return "RangeError";
		if (err instanceof ReferenceError) return "ReferenceError";
		if (err instanceof SyntaxError) return "SyntaxError";
		if (err instanceof URIError) return "URIError";
		if (typeof AggregateError !== "undefined" && err instanceof AggregateError) return "AggregateError";
		if (err instanceof Error) return "Error";
	} catch {
		return "unknown";
	}
	if (err === null) return "null";
	return typeof err;
}
function diagnosticHttpStatusCode(err) {
	const status = readOwnDataProperty(err, "status");
	if (isHttpStatusCode(status)) return String(status);
	const statusCode = readOwnDataProperty(err, "statusCode");
	if (isHttpStatusCode(statusCode)) return String(statusCode);
}
function diagnosticErrorFailureKind(err) {
	switch (findDiagnosticErrorProperty(err, readDirectCode)?.trim().toUpperCase()) {
		case void 0: break;
		case "ABORT_ERR":
		case "ECONNABORTED":
		case "ERR_ABORTED": return "aborted";
		case "ECONNRESET": return "connection_reset";
		case "ERR_STREAM_PREMATURE_CLOSE":
		case "UND_ERR_SOCKET": return "connection_closed";
		case "ETIMEDOUT":
		case "ERR_SOCKET_CONNECTION_TIMEOUT": return "timeout";
	}
	const message = findDiagnosticErrorProperty(err, readDirectMessage);
	if (!message) return;
	if (/\b(?:terminated|sigkill|sigterm)\b/i.test(message)) return "terminated";
	if (/\b(?:econnreset|connection reset)\b/i.test(message)) return "connection_reset";
	if (/\b(?:socket hang up|premature close|connection closed|other side closed)\b/i.test(message)) return "connection_closed";
	if (/\b(?:timed out|timeout|etimedout)\b/i.test(message)) return "timeout";
	if (/\b(?:aborted|abort_err|operation was aborted)\b/i.test(message)) return "aborted";
}
function diagnosticProviderRequestIdHash(err) {
	const fromProperty = findDiagnosticErrorProperty(err, readDirectProviderRequestId);
	if (fromProperty) return hashDiagnosticIdentifier(fromProperty);
	const fromMessage = findDiagnosticErrorProperty(err, (candidate) => extractProviderRequestIdFromText(readDirectMessage(candidate)));
	return fromMessage ? hashDiagnosticIdentifier(fromMessage) : void 0;
}
//#endregion
export { diagnosticProviderRequestIdHash as i, diagnosticErrorFailureKind as n, diagnosticHttpStatusCode as r, diagnosticErrorCategory as t };
