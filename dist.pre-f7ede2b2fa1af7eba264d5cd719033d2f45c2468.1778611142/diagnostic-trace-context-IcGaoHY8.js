import { c as normalizeTraceId, i as isValidDiagnosticTraceId, l as parseDiagnosticTraceparent, n as isValidDiagnosticSpanId, o as normalizeSpanId, r as isValidDiagnosticTraceFlags, s as normalizeTraceFlags } from "./diagnostic-trace-context-pure-DT_YEIKj.js";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { context, trace } from "@opentelemetry/api";
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
function formatOtelTraceFlags(traceFlags) {
	if (!Number.isFinite(traceFlags)) return;
	const traceFlagsHex = (traceFlags & 255).toString(16).padStart(2, "0");
	return isValidDiagnosticTraceFlags(traceFlagsHex) ? traceFlagsHex : void 0;
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
function deriveTraceparentFromActiveSpan() {
	const activeSpanContext = trace.getActiveSpan()?.spanContext();
	if (!activeSpanContext) return;
	const traceId = activeSpanContext.traceId.toLowerCase();
	const spanId = activeSpanContext.spanId.toLowerCase();
	const traceFlags = formatOtelTraceFlags(activeSpanContext.traceFlags);
	if (!isValidDiagnosticTraceId(traceId) || !isValidDiagnosticSpanId(spanId) || !traceFlags) return;
	return `00-${traceId}-${spanId}-${traceFlags}`;
}
function runWithActiveOtelTraceparent(traceparent, callback) {
	const parsed = parseDiagnosticTraceparent(traceparent);
	if (!parsed?.spanId || !parsed.traceFlags) return callback();
	const traceFlags = Number.parseInt(parsed.traceFlags, 16) & 255;
	const parentContext = trace.setSpanContext(context.active(), {
		traceId: parsed.traceId,
		spanId: parsed.spanId,
		traceFlags,
		isRemote: true
	});
	return context.with(parentContext, callback);
}
function createDiagnosticTraceContext(input = {}) {
	const parsed = parseDiagnosticTraceparent(input.traceparent);
	const traceId = normalizeTraceId(input.traceId) ?? parsed?.traceId ?? randomTraceId();
	const spanId = normalizeSpanId(input.spanId) ?? parsed?.spanId ?? randomSpanId();
	const parentSpanId = normalizeSpanId(input.parentSpanId);
	return {
		traceId,
		spanId,
		...parentSpanId && parentSpanId !== spanId ? { parentSpanId } : {},
		traceFlags: normalizeTraceFlags(input.traceFlags) ?? parsed?.traceFlags ?? DEFAULT_TRACE_FLAGS
	};
}
function createChildDiagnosticTraceContext(parent, input = {}) {
	const parentSpanId = normalizeSpanId(input.parentSpanId) ?? normalizeSpanId(parent.spanId);
	return createDiagnosticTraceContext({
		traceId: parent.traceId,
		spanId: input.spanId,
		parentSpanId,
		traceFlags: input.traceFlags ?? parent.traceFlags
	});
}
function createDiagnosticTraceContextFromActiveScope(input = {}) {
	const active = getActiveDiagnosticTraceContext();
	if (!active) return createDiagnosticTraceContext(input);
	return createChildDiagnosticTraceContext(active, input);
}
function freezeDiagnosticTraceContext(context) {
	return Object.freeze({
		traceId: context.traceId,
		...context.spanId ? { spanId: context.spanId } : {},
		...context.parentSpanId ? { parentSpanId: context.parentSpanId } : {},
		...context.traceFlags ? { traceFlags: context.traceFlags } : {}
	});
}
function getActiveDiagnosticTraceContext() {
	return getDiagnosticTraceScopeState().storage.getStore();
}
function runWithDiagnosticTraceContext(trace, callback) {
	return getDiagnosticTraceScopeState().storage.run(freezeDiagnosticTraceContext(trace), callback);
}
//#endregion
export { formatDiagnosticTraceparent as a, runWithActiveOtelTraceparent as c, deriveTraceparentFromActiveSpan as i, runWithDiagnosticTraceContext as l, createDiagnosticTraceContext as n, freezeDiagnosticTraceContext as o, createDiagnosticTraceContextFromActiveScope as r, getActiveDiagnosticTraceContext as s, createChildDiagnosticTraceContext as t };
