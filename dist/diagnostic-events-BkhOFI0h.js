import { t as isBlockedObjectKey } from "./prototype-keys-Dna4GplE.js";
import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/infra/diagnostic-trace-context.ts
const TRACEPARENT_VERSION = "00";
const DEFAULT_TRACE_FLAGS = "01";
const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;
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
	if (!TRACEPARENT_VERSION_RE.test(version) || version === "ff" || version === TRACEPARENT_VERSION && parts.length !== 4) return;
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
function formatDiagnosticTraceparent(context) {
	if (!context?.spanId) return;
	const traceId = normalizeTraceId(context.traceId);
	const spanId = normalizeSpanId(context.spanId);
	const traceFlags = normalizeTraceFlags(context.traceFlags) ?? DEFAULT_TRACE_FLAGS;
	if (!traceId || !spanId) return;
	return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${traceFlags}`;
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
//#region src/infra/diagnostic-events.ts
const MAX_ASYNC_DIAGNOSTIC_EVENTS = 1e4;
const DIAGNOSTIC_EVENTS_STATE_KEY = Symbol.for("openclaw.diagnosticEvents.state.v1");
const dispatchedTrustedDiagnosticMetadata = /* @__PURE__ */ new WeakSet();
const ASYNC_DIAGNOSTIC_EVENT_TYPES = new Set([
	"tool.execution.started",
	"tool.execution.completed",
	"tool.execution.error",
	"tool.execution.blocked",
	"exec.process.completed",
	"message.delivery.started",
	"message.delivery.completed",
	"message.delivery.error",
	"talk.event",
	"model.call.started",
	"model.call.completed",
	"model.call.error",
	"run.progress",
	"harness.run.started",
	"harness.run.completed",
	"harness.run.error",
	"context.assembled",
	"log.record"
]);
function createDiagnosticEventsState() {
	return {
		marker: DIAGNOSTIC_EVENTS_STATE_KEY,
		enabled: true,
		seq: 0,
		listeners: /* @__PURE__ */ new Set(),
		dispatchDepth: 0,
		asyncQueue: [],
		asyncDrainScheduled: false
	};
}
function isDiagnosticEventsState(value) {
	if (!value || typeof value !== "object") return false;
	const candidate = value;
	return candidate.marker === DIAGNOSTIC_EVENTS_STATE_KEY && typeof candidate.enabled === "boolean" && typeof candidate.seq === "number" && candidate.listeners instanceof Set && typeof candidate.dispatchDepth === "number" && Array.isArray(candidate.asyncQueue) && typeof candidate.asyncDrainScheduled === "boolean";
}
function getDiagnosticEventsState() {
	const existing = globalThis[DIAGNOSTIC_EVENTS_STATE_KEY];
	if (isDiagnosticEventsState(existing)) return existing;
	const state = createDiagnosticEventsState();
	Object.defineProperty(globalThis, DIAGNOSTIC_EVENTS_STATE_KEY, {
		configurable: true,
		enumerable: false,
		value: state,
		writable: false
	});
	return state;
}
function isDiagnosticsEnabled(config) {
	return config?.diagnostics?.enabled !== false;
}
function setDiagnosticsEnabledForProcess(enabled) {
	getDiagnosticEventsState().enabled = enabled;
}
function areDiagnosticsEnabledForProcess() {
	return getDiagnosticEventsState().enabled;
}
function dispatchDiagnosticEvent(state, enriched, metadata) {
	if (state.dispatchDepth > 100) {
		console.error(`[diagnostic-events] recursion guard tripped at depth=${state.dispatchDepth}, dropping type=${enriched.type}`);
		return;
	}
	state.dispatchDepth += 1;
	try {
		for (const listener of state.listeners) try {
			listener(cloneDiagnosticEventForListener(enriched), createDiagnosticMetadataForListener(metadata));
		} catch (err) {
			const errorMessage = err instanceof Error ? err.stack ?? err.message : typeof err === "string" ? err : String(err);
			console.error(`[diagnostic-events] listener error type=${enriched.type} seq=${enriched.seq}: ${errorMessage}`);
		}
	} finally {
		state.dispatchDepth -= 1;
	}
}
function createDiagnosticMetadataForListener(metadata) {
	const listenerMetadata = Object.freeze({ ...metadata });
	if (listenerMetadata.trusted) dispatchedTrustedDiagnosticMetadata.add(listenerMetadata);
	return listenerMetadata;
}
function cloneDiagnosticEventForListener(event) {
	return deepFreezeDiagnosticValue(structuredClone(event));
}
function deepFreezeDiagnosticValue(value, seen = /* @__PURE__ */ new WeakSet()) {
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return value;
	seen.add(value);
	if (Array.isArray(value)) {
		for (const item of value) deepFreezeDiagnosticValue(item, seen);
		return Object.freeze(value);
	}
	for (const nested of Object.values(value)) deepFreezeDiagnosticValue(nested, seen);
	return Object.freeze(value);
}
function scheduleAsyncDiagnosticDrain(state) {
	if (state.asyncDrainScheduled) return;
	state.asyncDrainScheduled = true;
	setImmediate(() => {
		state.asyncDrainScheduled = false;
		const batch = state.asyncQueue.splice(0);
		for (const entry of batch) dispatchDiagnosticEvent(state, entry.event, entry.metadata);
		if (state.asyncQueue.length > 0) scheduleAsyncDiagnosticDrain(state);
	});
}
function enrichDiagnosticEvent(state, event) {
	const enriched = {};
	for (const [key, value] of Object.entries(event)) {
		if (isBlockedObjectKey(key)) continue;
		enriched[key] = value;
	}
	enriched.trace ??= getActiveDiagnosticTraceContext();
	state.seq += 1;
	enriched.seq = state.seq;
	enriched.ts = Date.now();
	return enriched;
}
function emitDiagnosticEventWithTrust(event, trusted) {
	const state = getDiagnosticEventsState();
	if (!state.enabled) return;
	const enriched = enrichDiagnosticEvent(state, event);
	const metadata = { trusted };
	if (ASYNC_DIAGNOSTIC_EVENT_TYPES.has(enriched.type)) {
		if (state.asyncQueue.length >= MAX_ASYNC_DIAGNOSTIC_EVENTS) return;
		state.asyncQueue.push({
			event: enriched,
			metadata
		});
		scheduleAsyncDiagnosticDrain(state);
		return;
	}
	dispatchDiagnosticEvent(state, enriched, metadata);
}
function emitDiagnosticEvent(event) {
	emitDiagnosticEventWithTrust(event, false);
}
function emitTrustedDiagnosticEvent(event) {
	emitDiagnosticEventWithTrust(event, true);
}
function emitFailoverEvent(event) {
	emitTrustedDiagnosticEvent({
		type: "model.failover",
		...event
	});
}
function onInternalDiagnosticEvent(listener) {
	const state = getDiagnosticEventsState();
	state.listeners.add(listener);
	return () => {
		state.listeners.delete(listener);
	};
}
function onDiagnosticEvent(listener) {
	return onInternalDiagnosticEvent((event, metadata) => {
		if (metadata.trusted || event.type === "log.record") return;
		listener(event);
	});
}
function resetDiagnosticEventsForTest() {
	const state = getDiagnosticEventsState();
	state.enabled = true;
	state.seq = 0;
	state.listeners.clear();
	state.dispatchDepth = 0;
	state.asyncQueue = [];
	state.asyncDrainScheduled = false;
}
//#endregion
export { isValidDiagnosticTraceFlags as _, isDiagnosticsEnabled as a, runWithDiagnosticTraceContext as b, resetDiagnosticEventsForTest as c, createDiagnosticTraceContext as d, createDiagnosticTraceContextFromActiveScope as f, isValidDiagnosticSpanId as g, getActiveDiagnosticTraceContext as h, emitTrustedDiagnosticEvent as i, setDiagnosticsEnabledForProcess as l, freezeDiagnosticTraceContext as m, emitDiagnosticEvent as n, onDiagnosticEvent as o, formatDiagnosticTraceparent as p, emitFailoverEvent as r, onInternalDiagnosticEvent as s, areDiagnosticsEnabledForProcess as t, createChildDiagnosticTraceContext as u, isValidDiagnosticTraceId as v, parseDiagnosticTraceparent as y };
