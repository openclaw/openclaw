import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/infra/heartbeat-reason.ts
function trimReason(reason) {
	return normalizeOptionalString(reason) ?? "";
}
function normalizeHeartbeatWakeReason(reason) {
	const trimmed = trimReason(reason);
	return trimmed.length > 0 ? trimmed : "requested";
}
//#endregion
//#region src/infra/heartbeat-wake.ts
const HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT = "requests-in-flight";
const HEARTBEAT_SKIP_CRON_IN_PROGRESS = "cron-in-progress";
const HEARTBEAT_SKIP_LANES_BUSY = "lanes-busy";
const RETRYABLE_BUSY_SKIP_REASONS = new Set([
	HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
	HEARTBEAT_SKIP_CRON_IN_PROGRESS,
	HEARTBEAT_SKIP_LANES_BUSY
]);
function isRetryableHeartbeatBusySkipReason(reason) {
	return RETRYABLE_BUSY_SKIP_REASONS.has(reason);
}
let heartbeatsEnabled = true;
function setHeartbeatsEnabled(enabled) {
	heartbeatsEnabled = enabled;
}
function areHeartbeatsEnabled() {
	return heartbeatsEnabled;
}
let handler = null;
let handlerGeneration = 0;
const pendingWakes = /* @__PURE__ */ new Map();
let scheduled = false;
let running = false;
let timer = null;
let timerDueAt = null;
let timerKind = null;
const DEFAULT_COALESCE_MS = 250;
const DEFAULT_RETRY_MS = 1e3;
const REASON_PRIORITY = {
	RETRY: 0,
	INTERVAL: 1,
	DEFAULT: 2,
	ACTION: 3
};
function resolveWakePriority(params) {
	if (params.intent === "manual" || params.intent === "immediate") return REASON_PRIORITY.ACTION;
	if (params.source === "retry" || params.reason === "retry") return REASON_PRIORITY.RETRY;
	if (params.intent === "scheduled" || params.source === "interval" || params.reason === "interval") return REASON_PRIORITY.INTERVAL;
	return REASON_PRIORITY.DEFAULT;
}
function normalizeWakeReason(reason) {
	return normalizeHeartbeatWakeReason(reason);
}
function normalizeWakeTarget(value) {
	return (normalizeOptionalString(value) ?? "") || void 0;
}
function getWakeTargetKey(params) {
	const agentId = normalizeWakeTarget(params.agentId);
	const sessionKey = normalizeWakeTarget(params.sessionKey);
	return `${agentId ?? ""}::${sessionKey ?? ""}`;
}
function queuePendingWakeReason(params) {
	const requestedAt = params.requestedAt ?? Date.now();
	const normalizedReason = normalizeWakeReason(params.reason);
	const normalizedAgentId = normalizeWakeTarget(params.agentId);
	const normalizedSessionKey = normalizeWakeTarget(params.sessionKey);
	const normalizedParentRunId = normalizeWakeTarget(params.parentRunId);
	const wakeTargetKey = getWakeTargetKey({
		agentId: normalizedAgentId,
		sessionKey: normalizedSessionKey
	});
	const next = {
		source: params.source,
		intent: params.intent,
		reason: normalizedReason,
		priority: resolveWakePriority({
			source: params.source,
			intent: params.intent,
			reason: normalizedReason
		}),
		requestedAt,
		agentId: normalizedAgentId,
		sessionKey: normalizedSessionKey,
		parentRunId: normalizedParentRunId,
		heartbeat: params.heartbeat
	};
	const previous = pendingWakes.get(wakeTargetKey);
	if (!previous) {
		pendingWakes.set(wakeTargetKey, next);
		return;
	}
	const merged = next.heartbeat ?? previous.heartbeat ?? next.parentRunId ? {
		...next,
		parentRunId: next.parentRunId,
		heartbeat: next.heartbeat ?? previous.heartbeat
	} : next;
	if (next.priority > previous.priority) {
		pendingWakes.set(wakeTargetKey, merged);
		return;
	}
	if (next.priority === previous.priority && next.requestedAt >= previous.requestedAt) pendingWakes.set(wakeTargetKey, merged);
}
function schedule(coalesceMs, kind = "normal") {
	const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : DEFAULT_COALESCE_MS;
	const dueAt = Date.now() + delay;
	if (timer) {
		if (timerKind === "retry") return;
		if (typeof timerDueAt === "number" && timerDueAt <= dueAt) return;
		clearTimeout(timer);
		timer = null;
		timerDueAt = null;
		timerKind = null;
	}
	timerDueAt = dueAt;
	timerKind = kind;
	timer = setTimeout(async () => {
		timer = null;
		timerDueAt = null;
		timerKind = null;
		scheduled = false;
		const active = handler;
		if (!active) return;
		if (running) {
			scheduled = true;
			schedule(delay, kind);
			return;
		}
		const pendingBatch = Array.from(pendingWakes.values());
		pendingWakes.clear();
		running = true;
		try {
			for (const pendingWake of pendingBatch) {
				const res = await active({
					source: pendingWake.source,
					intent: pendingWake.intent,
					reason: pendingWake.reason ?? void 0,
					...pendingWake.agentId ? { agentId: pendingWake.agentId } : {},
					...pendingWake.sessionKey ? { sessionKey: pendingWake.sessionKey } : {},
					...pendingWake.parentRunId ? { parentRunId: pendingWake.parentRunId } : {},
					...pendingWake.heartbeat ? { heartbeat: pendingWake.heartbeat } : {}
				});
				if (res.status === "skipped" && isRetryableHeartbeatBusySkipReason(res.reason)) {
					queuePendingWakeReason({
						source: pendingWake.source,
						intent: pendingWake.intent,
						reason: pendingWake.reason ?? "retry",
						agentId: pendingWake.agentId,
						sessionKey: pendingWake.sessionKey,
						parentRunId: pendingWake.parentRunId,
						heartbeat: pendingWake.heartbeat
					});
					schedule(DEFAULT_RETRY_MS, "retry");
				}
			}
		} catch {
			for (const pendingWake of pendingBatch) queuePendingWakeReason({
				source: pendingWake.source,
				intent: pendingWake.intent,
				reason: pendingWake.reason ?? "retry",
				agentId: pendingWake.agentId,
				sessionKey: pendingWake.sessionKey,
				parentRunId: pendingWake.parentRunId,
				heartbeat: pendingWake.heartbeat
			});
			schedule(DEFAULT_RETRY_MS, "retry");
		} finally {
			running = false;
			if (pendingWakes.size > 0 || scheduled) schedule(delay, "normal");
		}
	}, delay);
	timer.unref?.();
}
/**
* Register (or clear) the heartbeat wake handler.
* Returns a disposer function that clears this specific registration.
* Stale disposers (from previous registrations) are no-ops, preventing
* a race where an old runner's cleanup clears a newer runner's handler.
*/
function setHeartbeatWakeHandler(next) {
	handlerGeneration += 1;
	const generation = handlerGeneration;
	handler = next;
	if (next) {
		if (timer) clearTimeout(timer);
		timer = null;
		timerDueAt = null;
		timerKind = null;
		running = false;
		scheduled = false;
	}
	if (handler && pendingWakes.size > 0) schedule(DEFAULT_COALESCE_MS, "normal");
	return () => {
		if (handlerGeneration !== generation) return;
		if (handler !== next) return;
		handlerGeneration += 1;
		handler = null;
	};
}
function requestHeartbeat(opts) {
	queuePendingWakeReason({
		source: opts.source,
		intent: opts.intent,
		reason: opts.reason,
		agentId: opts.agentId,
		sessionKey: opts.sessionKey,
		parentRunId: opts.parentRunId,
		heartbeat: opts.heartbeat
	});
	schedule(opts.coalesceMs ?? DEFAULT_COALESCE_MS, "normal");
}
function requestHeartbeatNow(opts) {
	requestHeartbeat({
		source: opts?.source ?? "other",
		intent: opts?.intent ?? "immediate",
		reason: opts?.reason,
		coalesceMs: opts?.coalesceMs,
		agentId: opts?.agentId,
		sessionKey: opts?.sessionKey,
		parentRunId: opts?.parentRunId,
		heartbeat: opts?.heartbeat
	});
}
//#endregion
export { isRetryableHeartbeatBusySkipReason as a, setHeartbeatWakeHandler as c, areHeartbeatsEnabled as i, setHeartbeatsEnabled as l, HEARTBEAT_SKIP_LANES_BUSY as n, requestHeartbeat as o, HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT as r, requestHeartbeatNow as s, HEARTBEAT_SKIP_CRON_IN_PROGRESS as t };
