import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { n as isAbortRequestText } from "./abort-primitives-BPrDmF9O.js";
//#region src/gateway/chat-abort.ts
const DEFAULT_CHAT_RUN_ABORT_GRACE_MS = 6e4;
function isChatStopCommandText(text) {
	return isAbortRequestText(text);
}
function resolveChatRunExpiresAtMs(params) {
	const { now, timeoutMs, graceMs = DEFAULT_CHAT_RUN_ABORT_GRACE_MS, minMs = 2 * 6e4, maxMs = 1440 * 6e4 } = params;
	const target = now + Math.max(0, timeoutMs) + graceMs;
	const min = now + minMs;
	const max = now + maxMs;
	return Math.min(max, Math.max(min, target));
}
function resolveAgentRunExpiresAtMs(params) {
	const graceMs = Math.max(0, params.graceMs ?? DEFAULT_CHAT_RUN_ABORT_GRACE_MS);
	return resolveChatRunExpiresAtMs({
		now: params.now,
		timeoutMs: params.timeoutMs,
		graceMs,
		minMs: graceMs,
		maxMs: Math.max(0, params.timeoutMs) + graceMs
	});
}
function registerChatAbortController(params) {
	const controller = new AbortController();
	const cleanup = () => {
		if (params.chatAbortControllers.get(params.runId)?.controller === controller) params.chatAbortControllers.delete(params.runId);
	};
	if (!params.sessionKey || params.chatAbortControllers.has(params.runId)) return {
		controller,
		registered: false,
		cleanup
	};
	const now = params.now ?? Date.now();
	const entry = {
		controller,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		startedAtMs: now,
		expiresAtMs: params.expiresAtMs ?? resolveChatRunExpiresAtMs({
			now,
			timeoutMs: params.timeoutMs
		}),
		ownerConnId: params.ownerConnId,
		ownerDeviceId: params.ownerDeviceId,
		providerId: normalizeProviderIdForActiveRun(params.providerId),
		authProviderId: normalizeProviderIdForActiveRun(params.authProviderId),
		kind: params.kind
	};
	params.chatAbortControllers.set(params.runId, entry);
	return {
		controller,
		registered: true,
		entry,
		cleanup
	};
}
function normalizeProviderIdForActiveRun(providerId) {
	return providerId?.trim().toLowerCase() || void 0;
}
function broadcastChatAborted(ops, params) {
	const { runId, sessionKey, stopReason, partialText } = params;
	const payload = {
		runId,
		sessionKey,
		seq: (ops.agentRunSeq.get(runId) ?? 0) + 1,
		state: "aborted",
		stopReason,
		message: partialText ? {
			role: "assistant",
			content: [{
				type: "text",
				text: partialText
			}],
			timestamp: Date.now()
		} : void 0
	};
	ops.broadcast("chat", payload);
	ops.nodeSendToSession(sessionKey, "chat", payload);
}
function abortChatRunById(ops, params) {
	const { runId, sessionKey, stopReason } = params;
	const active = ops.chatAbortControllers.get(runId);
	if (!active) return { aborted: false };
	if (active.sessionKey !== sessionKey) return { aborted: false };
	const bufferedText = ops.chatRunBuffers.get(runId);
	const partialText = bufferedText && bufferedText.trim() ? bufferedText : void 0;
	ops.chatAbortedRuns.set(runId, Date.now());
	if (stopReason) active.abortStopReason = stopReason;
	active.controller.abort();
	ops.chatAbortControllers.delete(runId);
	ops.chatRunBuffers.delete(runId);
	ops.chatDeltaSentAt.delete(runId);
	ops.chatDeltaLastBroadcastLen.delete(runId);
	ops.chatDeltaLastBroadcastText.delete(runId);
	ops.agentDeltaSentAt.delete(runId);
	ops.agentDeltaSentAt.delete(`${runId}:assistant`);
	ops.agentDeltaSentAt.delete(`${runId}:thinking`);
	ops.bufferedAgentEvents.delete(runId);
	ops.bufferedAgentEvents.delete(`${runId}:assistant`);
	ops.bufferedAgentEvents.delete(`${runId}:thinking`);
	const removed = ops.removeChatRun(runId, runId, sessionKey);
	broadcastChatAborted(ops, {
		runId,
		sessionKey,
		stopReason,
		partialText
	});
	emitAgentEvent({
		runId,
		sessionKey,
		stream: "lifecycle",
		data: {
			phase: "end",
			status: "cancelled",
			aborted: true,
			stopReason,
			startedAt: active.startedAtMs,
			endedAt: Date.now()
		}
	});
	ops.agentRunSeq.delete(runId);
	if (removed?.clientRunId) ops.agentRunSeq.delete(removed.clientRunId);
	return { aborted: true };
}
function updateChatRunProvider(chatAbortControllers, params) {
	const entry = chatAbortControllers.get(params.runId);
	if (!entry) return false;
	entry.providerId = normalizeProviderIdForActiveRun(params.providerId);
	entry.authProviderId = normalizeProviderIdForActiveRun(params.authProviderId);
	return true;
}
function abortChatRunsForProvider(ops, params) {
	const providerId = normalizeProviderIdForActiveRun(params.providerId);
	if (!providerId) return { runIds: [] };
	const matches = [...ops.chatAbortControllers.entries()].filter(([, entry]) => normalizeProviderIdForActiveRun(entry.authProviderId) === providerId || normalizeProviderIdForActiveRun(entry.providerId) === providerId);
	const runIds = [];
	for (const [runId, entry] of matches) if (abortChatRunById(ops, {
		runId,
		sessionKey: entry.sessionKey,
		stopReason: params.stopReason
	}).aborted) runIds.push(runId);
	return { runIds };
}
//#endregion
export { resolveAgentRunExpiresAtMs as a, registerChatAbortController as i, abortChatRunsForProvider as n, updateChatRunProvider as o, isChatStopCommandText as r, abortChatRunById as t };
