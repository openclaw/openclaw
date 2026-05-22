import { c as normalizeTraceId, l as parseDiagnosticTraceparent, o as normalizeSpanId, s as normalizeTraceFlags } from "./diagnostic-trace-context-pure-DiETCmyi.js";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/infra/diagnostic-trace-context.ts
const DEFAULT_TRACE_FLAGS = "01";
const DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");
function randomHex(bytes) {
	return randomBytes(bytes).toString("hex");
}
function isNonZeroHex(value) {
	return !/^0+$/.test(value);
}
function randomTraceId() {
	let traceId = randomHex(16);
	while (!isNonZeroHex(traceId)) traceId = randomHex(16);
	return traceId;
}
function randomSpanId() {
	let spanId = randomHex(8);
	while (!isNonZeroHex(spanId)) spanId = randomHex(8);
	return spanId;
}
function createDiagnosticTraceScopeState() {
	return {
		marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY,
		storage: new AsyncLocalStorage()
	};
}
function isDiagnosticTraceScopeState(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.marker === DIAGNOSTIC_TRACE_SCOPE_STATE_KEY && candidate.storage instanceof AsyncLocalStorage;
}
function getDiagnosticTraceScopeState() {
	const existing = globalThis[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
	if (isDiagnosticTraceScopeState(existing)) return existing;
	const state = createDiagnosticTraceScopeState();
	Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
		configurable: true,
		enumerable: false,
		value: state,
		writable: false
	});
	return state;
}
function formatDiagnosticTraceparent(context) {
	if (!context?.spanId) return;
	const traceId = normalizeTraceId(context.traceId);
	const spanId = normalizeSpanId(context.spanId);
	const traceFlags = normalizeTraceFlags(context.traceFlags) ?? DEFAULT_TRACE_FLAGS;
	if (!traceId || !spanId) return;
	return `00-${traceId}-${spanId}-${traceFlags}`;
}
function createDiagnosticTraceContext(input = {}) {
	const parsed = parseDiagnosticTraceparent(input.traceparent);
	const traceId = normalizeTraceId(input.traceId) ?? parsed?.traceId ?? randomTraceId();
	const explicitSpanId = normalizeSpanId(input.spanId);
	const spanId = explicitSpanId ?? parsed?.spanId ?? randomSpanId();
	const parentSpanId = normalizeSpanId(input.parentSpanId);
	const spanIdSource = input.spanIdSource === "remote" || !explicitSpanId && parsed?.spanId ? "remote" : void 0;
	const parentSpanIdSource = input.parentSpanIdSource === "remote" ? "remote" : void 0;
	return {
		traceId,
		spanId,
		...parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {},
		traceFlags: normalizeTraceFlags(input.traceFlags) ?? parsed?.traceFlags ?? DEFAULT_TRACE_FLAGS,
		...spanIdSource ? { spanIdSource } : {},
		...parentSpanIdSource && parentSpanId && parentSpanId !== spanId ? { parentSpanIdSource } : {}
	};
}
function createChildDiagnosticTraceContext(parent, input = {}) {
	const parentSpanId = normalizeSpanId(input.parentSpanId) ?? normalizeSpanId(parent.spanId);
	return createDiagnosticTraceContext({
		traceId: parent.traceId,
		spanId: input.spanId,
		parentSpanId,
		traceFlags: input.traceFlags ?? parent.traceFlags,
		parentSpanIdSource: input.parentSpanIdSource ?? parent.spanIdSource
	});
}
function freezeDiagnosticTraceContext(context) {
	return Object.freeze({
		traceId: context.traceId,
		...context.spanId ? { spanId: context.spanId } : {},
		...context.parentSpanId ? { parentSpanId: context.parentSpanId } : {},
		...context.traceFlags ? { traceFlags: context.traceFlags } : {},
		...context.spanIdSource ? { spanIdSource: context.spanIdSource } : {},
		...context.parentSpanIdSource ? { parentSpanIdSource: context.parentSpanIdSource } : {}
	});
}
function getActiveDiagnosticTraceContext() {
	return getDiagnosticTraceScopeState().storage.getStore();
}
function runWithDiagnosticTraceContext(trace, callback) {
	return getDiagnosticTraceScopeState().storage.run(freezeDiagnosticTraceContext(trace), callback);
}
function runWithDiagnosticTraceparent(traceparent, callback) {
	if (!parseDiagnosticTraceparent(traceparent)?.spanId) return callback();
	return runWithDiagnosticTraceContext(createDiagnosticTraceContext({ traceparent }), callback);
}
//#endregion
export { getActiveDiagnosticTraceContext as a, freezeDiagnosticTraceContext as i, createDiagnosticTraceContext as n, runWithDiagnosticTraceContext as o, formatDiagnosticTraceparent as r, runWithDiagnosticTraceparent as s, createChildDiagnosticTraceContext as t };
