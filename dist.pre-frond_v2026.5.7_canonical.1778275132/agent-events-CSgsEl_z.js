import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
import { n as registerListener, t as notifyListeners } from "./listeners-CIyaoVUu.js";
//#region src/infra/agent-events.ts
const AGENT_EVENT_STATE_KEY = Symbol.for("openclaw.agentEvents.state");
function getAgentEventState() {
	return resolveGlobalSingleton(AGENT_EVENT_STATE_KEY, () => ({
		seqByRun: /* @__PURE__ */ new Map(),
		listeners: /* @__PURE__ */ new Set(),
		runContextById: /* @__PURE__ */ new Map()
	}));
}
function registerAgentRunContext(runId, context) {
	if (!runId) return;
	const state = getAgentEventState();
	const existing = state.runContextById.get(runId);
	if (!existing) {
		state.runContextById.set(runId, {
			...context,
			registeredAt: context.registeredAt ?? Date.now()
		});
		return;
	}
	if (context.sessionKey && existing.sessionKey !== context.sessionKey) existing.sessionKey = context.sessionKey;
	if (context.verboseLevel && existing.verboseLevel !== context.verboseLevel) existing.verboseLevel = context.verboseLevel;
	if (context.isControlUiVisible !== void 0) existing.isControlUiVisible = context.isControlUiVisible;
	if (context.isHeartbeat !== void 0 && existing.isHeartbeat !== context.isHeartbeat) existing.isHeartbeat = context.isHeartbeat;
	if (context.registeredAt !== void 0) existing.registeredAt = context.registeredAt;
	if (context.lastActiveAt !== void 0) existing.lastActiveAt = context.lastActiveAt;
}
function getAgentRunContext(runId) {
	return getAgentEventState().runContextById.get(runId);
}
function clearAgentRunContext(runId) {
	const state = getAgentEventState();
	state.runContextById.delete(runId);
	state.seqByRun.delete(runId);
}
/**
* Sweep stale run contexts that exceeded the given TTL.
* Guards against orphaned entries when lifecycle "end"/"error" events are missed.
*/
function sweepStaleRunContexts(maxAgeMs = 1800 * 1e3) {
	const state = getAgentEventState();
	const now = Date.now();
	let swept = 0;
	for (const [runId, ctx] of state.runContextById.entries()) {
		const lastSeen = ctx.lastActiveAt ?? ctx.registeredAt;
		if ((lastSeen ? now - lastSeen : Infinity) > maxAgeMs) {
			state.runContextById.delete(runId);
			state.seqByRun.delete(runId);
			swept++;
		}
	}
	return swept;
}
function emitAgentEvent(event) {
	const state = getAgentEventState();
	const nextSeq = (state.seqByRun.get(event.runId) ?? 0) + 1;
	state.seqByRun.set(event.runId, nextSeq);
	const context = state.runContextById.get(event.runId);
	if (context) context.lastActiveAt = Date.now();
	const isControlUiVisible = context?.isControlUiVisible ?? true;
	const eventSessionKey = typeof event.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey : void 0;
	const sessionKey = isControlUiVisible || event.stream === "lifecycle" ? eventSessionKey ?? context?.sessionKey : void 0;
	const enriched = {
		...event,
		sessionKey,
		seq: nextSeq,
		ts: Date.now()
	};
	notifyListeners(state.listeners, enriched);
}
function emitAgentItemEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "item",
		data: params.data,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitAgentPlanEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "plan",
		data: params.data,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitAgentApprovalEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "approval",
		data: params.data,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitAgentCommandOutputEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "command_output",
		data: params.data,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function emitAgentPatchSummaryEvent(params) {
	emitAgentEvent({
		runId: params.runId,
		stream: "patch",
		data: params.data,
		...params.sessionKey ? { sessionKey: params.sessionKey } : {}
	});
}
function onAgentEvent(listener) {
	return registerListener(getAgentEventState().listeners, listener);
}
function resetAgentEventsForTest() {
	const state = getAgentEventState();
	state.seqByRun.clear();
	state.listeners.clear();
	state.runContextById.clear();
}
//#endregion
export { emitAgentItemEvent as a, getAgentRunContext as c, resetAgentEventsForTest as d, sweepStaleRunContexts as f, emitAgentEvent as i, onAgentEvent as l, emitAgentApprovalEvent as n, emitAgentPatchSummaryEvent as o, emitAgentCommandOutputEvent as r, emitAgentPlanEvent as s, clearAgentRunContext as t, registerAgentRunContext as u };
