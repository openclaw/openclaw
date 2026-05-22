const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;
const DIAGNOSTIC_TRACEPARENT_PATTERN = "^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$";
const DIAGNOSTIC_TRACEPARENT_RE = new RegExp(DIAGNOSTIC_TRACEPARENT_PATTERN);
function isNonZeroHex(value) {
	return !/^0+$/.test(value);
}
function isValidDiagnosticTraceId(value) {
	return typeof value === "string" && TRACE_ID_RE.test(value) && isNonZeroHex(value);
}
function isValidDiagnosticSpanId(value) {
	return typeof value === "string" && SPAN_ID_RE.test(value) && isNonZeroHex(value);
}
function isValidDiagnosticTraceFlags(value) {
	return typeof value === "string" && TRACE_FLAGS_RE.test(value);
}
function normalizeTraceId(value) {
	if (typeof value !== "string") return;
	const normalized = value.toLowerCase();
	return isValidDiagnosticTraceId(normalized) ? normalized : void 0;
}
function normalizeSpanId(value) {
	if (typeof value !== "string") return;
	const normalized = value.toLowerCase();
	return isValidDiagnosticSpanId(normalized) ? normalized : void 0;
}
function normalizeTraceFlags(value) {
	if (typeof value !== "string") return;
	const normalized = value.toLowerCase();
	return isValidDiagnosticTraceFlags(normalized) ? normalized : void 0;
}
function parseDiagnosticTraceparent(traceparent) {
	if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) return;
	const parts = traceparent.trim().toLowerCase().split("-");
	if (!parts || parts.length < 4) return;
	const [version, traceId, spanId, traceFlags] = parts;
	if (!TRACEPARENT_VERSION_RE.test(version) || version === "ff" || version === "00" && parts.length !== 4) return;
	const normalizedTraceId = normalizeTraceId(traceId);
	const normalizedSpanId = normalizeSpanId(spanId);
	const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
	if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) return;
	return {
		traceId: normalizedTraceId,
		spanId: normalizedSpanId,
		traceFlags: normalizedTraceFlags
	};
}
function normalizeDiagnosticTraceparent(traceparent) {
	if (typeof traceparent !== "string") return;
	const normalized = traceparent.trim().toLowerCase();
	if (!DIAGNOSTIC_TRACEPARENT_RE.test(normalized)) return;
	return parseDiagnosticTraceparent(normalized) ? normalized : void 0;
}
//#endregion
export { normalizeDiagnosticTraceparent as a, normalizeTraceId as c, isValidDiagnosticTraceId as i, parseDiagnosticTraceparent as l, isValidDiagnosticSpanId as n, normalizeSpanId as o, isValidDiagnosticTraceFlags as r, normalizeTraceFlags as s, DIAGNOSTIC_TRACEPARENT_PATTERN as t };
