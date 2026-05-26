import { _ as waitForReplyRunEndBySessionId, a as EMBEDDED_RUN_WAITERS, c as abortActiveReplyRuns, d as forceClearReplyRunBySessionId, f as isReplyRunActiveForSessionId, g as resolveActiveReplyRunSessionId, i as EMBEDDED_RUN_MODEL_SWITCH_REQUESTS, l as abortReplyRunBySessionId, m as queueReplyRunMessage, n as ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY, o as getActiveEmbeddedRunCount, p as isReplyRunStreamingForSessionId, r as ACTIVE_EMBEDDED_RUN_SNAPSHOTS, t as ACTIVE_EMBEDDED_RUNS } from "./run-state-BvIK-BSF.js";
import { S as markDiagnosticEmbeddedRunStarted, i as logMessageQueued, s as logSessionStateChange, x as markDiagnosticEmbeddedRunEnded } from "./diagnostic-DrGtZgCh.js";
import { t as diagnosticLogger } from "./diagnostic-runtime-BO7pkiQC.js";
//#region src/agents/pi-embedded-runner/runs.ts
function createQueueFailureOutcome(sessionId, reason) {
	return {
		queued: false,
		sessionId,
		reason,
		gatewayHealth: "live"
	};
}
function formatEmbeddedPiQueueFailureSummary(outcome) {
	if (outcome.queued) return;
	return `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=${outcome.gatewayHealth}`;
}
function setActiveRunSessionKey(sessionKey, sessionId) {
	const normalizedSessionKey = sessionKey?.trim();
	if (!normalizedSessionKey) return;
	ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.set(normalizedSessionKey, sessionId);
}
function clearActiveRunSessionKeys(sessionId, sessionKey) {
	const normalizedSessionKey = sessionKey?.trim();
	if (normalizedSessionKey) {
		if (ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey) === sessionId) ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(normalizedSessionKey);
		return;
	}
	for (const [key, activeSessionId] of ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY) if (activeSessionId === sessionId) ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.delete(key);
}
/**
* @deprecated Use queueEmbeddedPiMessageWithOutcome so callers preserve failure reasons.
*/
function queueEmbeddedPiMessage(sessionId, text, options) {
	return queueEmbeddedPiMessageWithOutcome(sessionId, text, options).queued;
}
function queueEmbeddedPiMessageWithOutcome(sessionId, text, options) {
	const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
	if (!handle) {
		if (queueReplyRunMessage(sessionId, text)) {
			logMessageQueued({
				sessionId,
				source: "pi-embedded-runner"
			});
			return {
				queued: true,
				sessionId,
				target: "reply_run",
				gatewayHealth: "live"
			};
		}
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
		return createQueueFailureOutcome(sessionId, "no_active_run");
	}
	if (!handle.isStreaming()) {
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
		return createQueueFailureOutcome(sessionId, "not_streaming");
	}
	if (handle.isCompacting()) {
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
		return createQueueFailureOutcome(sessionId, "compacting");
	}
	logMessageQueued({
		sessionId,
		source: "pi-embedded-runner"
	});
	handle.queueMessage(text, options ?? { steeringMode: "all" });
	return {
		queued: true,
		sessionId,
		target: "embedded_run",
		gatewayHealth: "live"
	};
}
function abortEmbeddedPiRun(sessionId, opts) {
	if (typeof sessionId === "string" && sessionId.length > 0) {
		const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
		if (!handle) {
			if (abortReplyRunBySessionId(sessionId)) return true;
			diagnosticLogger.debug(`abort failed: sessionId=${sessionId} reason=no_active_run`);
			return false;
		}
		diagnosticLogger.debug(`aborting run: sessionId=${sessionId}`);
		try {
			handle.abort();
		} catch (err) {
			diagnosticLogger.warn(`abort failed: sessionId=${sessionId} err=${String(err)}`);
			return false;
		}
		return true;
	}
	const mode = opts?.mode;
	if (mode === "compacting") {
		let aborted = false;
		for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
			if (!handle.isCompacting()) continue;
			diagnosticLogger.debug(`aborting compacting run: sessionId=${id}`);
			try {
				handle.abort();
				aborted = true;
			} catch (err) {
				diagnosticLogger.warn(`abort failed: sessionId=${id} err=${String(err)}`);
			}
		}
		return abortActiveReplyRuns({ mode }) || aborted;
	}
	if (mode === "all") {
		let aborted = false;
		for (const [id, handle] of ACTIVE_EMBEDDED_RUNS) {
			diagnosticLogger.debug(`aborting run: sessionId=${id}`);
			try {
				handle.abort();
				aborted = true;
			} catch (err) {
				diagnosticLogger.warn(`abort failed: sessionId=${id} err=${String(err)}`);
			}
		}
		return abortActiveReplyRuns({ mode }) || aborted;
	}
	return false;
}
function isEmbeddedPiRunActive(sessionId) {
	const active = ACTIVE_EMBEDDED_RUNS.has(sessionId) || isReplyRunActiveForSessionId(sessionId);
	if (active) diagnosticLogger.debug(`run active check: sessionId=${sessionId} active=true`);
	return active;
}
function isEmbeddedPiRunHandleActive(sessionId) {
	const active = ACTIVE_EMBEDDED_RUNS.has(sessionId);
	if (active) diagnosticLogger.debug(`run handle active check: sessionId=${sessionId} active=true`);
	return active;
}
function isEmbeddedPiRunStreaming(sessionId) {
	const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
	if (!handle) return isReplyRunStreamingForSessionId(sessionId);
	return handle.isStreaming();
}
function resolveActiveEmbeddedRunHandleSessionId(sessionKey) {
	const normalizedSessionKey = sessionKey.trim();
	if (!normalizedSessionKey) return;
	return ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
}
function resolveActiveEmbeddedRunSessionId(sessionKey) {
	const normalizedSessionKey = sessionKey.trim();
	if (!normalizedSessionKey) return;
	return resolveActiveReplyRunSessionId(normalizedSessionKey) ?? ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY.get(normalizedSessionKey);
}
function getActiveEmbeddedRunSnapshot(sessionId) {
	return ACTIVE_EMBEDDED_RUN_SNAPSHOTS.get(sessionId);
}
/**
* Wait for active embedded runs to drain.
*
* Used during restarts so in-flight runs can release session write locks before
* the next lifecycle starts. If no timeout is passed, waits indefinitely.
*/
async function waitForActiveEmbeddedRuns(timeoutMs, opts) {
	const pollMsRaw = opts?.pollMs ?? 250;
	const pollMs = Math.max(10, Math.floor(pollMsRaw));
	if (timeoutMs !== void 0 && timeoutMs <= 0) return { drained: getActiveEmbeddedRunCount() === 0 };
	const maxWaitMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? Math.max(pollMs, Math.floor(timeoutMs)) : void 0;
	const startedAt = Date.now();
	while (true) {
		if (getActiveEmbeddedRunCount() === 0) return { drained: true };
		const elapsedMs = Date.now() - startedAt;
		if (maxWaitMs !== void 0 && elapsedMs >= maxWaitMs) {
			diagnosticLogger.warn(`wait for active embedded runs timed out: activeRuns=${getActiveEmbeddedRunCount()} timeoutMs=${maxWaitMs}`);
			return { drained: false };
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
function waitForEmbeddedPiRunEnd(sessionId, timeoutMs = 15e3) {
	if (!sessionId) return Promise.resolve(true);
	if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) return waitForReplyRunEndBySessionId(sessionId, timeoutMs);
	diagnosticLogger.debug(`waiting for run end: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
	return new Promise((resolve) => {
		const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? /* @__PURE__ */ new Set();
		const waiter = {
			resolve,
			timer: setTimeout(() => {
				waiters.delete(waiter);
				if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
				diagnosticLogger.warn(`wait timeout: sessionId=${sessionId} timeoutMs=${timeoutMs}`);
				resolve(false);
			}, Math.max(100, timeoutMs))
		};
		waiters.add(waiter);
		EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
		if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
			waiters.delete(waiter);
			if (waiters.size === 0) EMBEDDED_RUN_WAITERS.delete(sessionId);
			clearTimeout(waiter.timer);
			resolve(true);
		}
	});
}
async function abortAndDrainEmbeddedPiRun(params) {
	const settleMs = params.settleMs ?? 15e3;
	const aborted = abortEmbeddedPiRun(params.sessionId);
	const drained = aborted ? await waitForEmbeddedPiRunEnd(params.sessionId, settleMs) : false;
	return {
		aborted,
		drained,
		forceCleared: params.forceClear === true && (!aborted || !drained) ? forceClearEmbeddedPiRun(params.sessionId, params.sessionKey, params.reason) : false
	};
}
function notifyEmbeddedRunEnded(sessionId) {
	const waiters = EMBEDDED_RUN_WAITERS.get(sessionId);
	if (!waiters || waiters.size === 0) return;
	EMBEDDED_RUN_WAITERS.delete(sessionId);
	diagnosticLogger.debug(`notifying waiters: sessionId=${sessionId} waiterCount=${waiters.size}`);
	for (const waiter of waiters) {
		clearTimeout(waiter.timer);
		waiter.resolve(true);
	}
}
function setActiveEmbeddedRun(sessionId, handle, sessionKey) {
	const wasActive = ACTIVE_EMBEDDED_RUNS.has(sessionId);
	ACTIVE_EMBEDDED_RUNS.set(sessionId, handle);
	setActiveRunSessionKey(sessionKey, sessionId);
	logSessionStateChange({
		sessionId,
		sessionKey,
		state: "processing",
		reason: wasActive ? "run_replaced" : "run_started"
	});
	markDiagnosticEmbeddedRunStarted({
		sessionId,
		sessionKey
	});
	if (!sessionId.startsWith("probe-")) diagnosticLogger.debug(`run registered: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
}
function updateActiveEmbeddedRunSnapshot(sessionId, snapshot) {
	if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) return;
	ACTIVE_EMBEDDED_RUN_SNAPSHOTS.set(sessionId, snapshot);
}
function clearActiveEmbeddedRun(sessionId, handle, sessionKey) {
	if (ACTIVE_EMBEDDED_RUNS.get(sessionId) === handle) {
		ACTIVE_EMBEDDED_RUNS.delete(sessionId);
		ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
		EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(sessionId);
		clearActiveRunSessionKeys(sessionId, sessionKey);
		logSessionStateChange({
			sessionId,
			sessionKey,
			state: "idle",
			reason: "run_completed"
		});
		markDiagnosticEmbeddedRunEnded({
			sessionId,
			sessionKey
		});
		if (!sessionId.startsWith("probe-")) diagnosticLogger.debug(`run cleared: sessionId=${sessionId} totalActive=${ACTIVE_EMBEDDED_RUNS.size}`);
		notifyEmbeddedRunEnded(sessionId);
	} else diagnosticLogger.debug(`run clear skipped: sessionId=${sessionId} reason=handle_mismatch`);
}
function forceClearEmbeddedPiRun(sessionId, sessionKey, reason = "stuck_recovery") {
	let cleared = false;
	if (ACTIVE_EMBEDDED_RUNS.has(sessionId)) {
		ACTIVE_EMBEDDED_RUNS.delete(sessionId);
		ACTIVE_EMBEDDED_RUN_SNAPSHOTS.delete(sessionId);
		EMBEDDED_RUN_MODEL_SWITCH_REQUESTS.delete(sessionId);
		clearActiveRunSessionKeys(sessionId, sessionKey);
		logSessionStateChange({
			sessionId,
			sessionKey,
			state: "idle",
			reason
		});
		markDiagnosticEmbeddedRunEnded({
			sessionId,
			sessionKey
		});
		notifyEmbeddedRunEnded(sessionId);
		cleared = true;
	}
	return forceClearReplyRunBySessionId(sessionId, /* @__PURE__ */ new Error(`Embedded run force-cleared by ${reason}`)) || cleared;
}
//#endregion
export { waitForEmbeddedPiRunEnd as _, formatEmbeddedPiQueueFailureSummary as a, isEmbeddedPiRunHandleActive as c, queueEmbeddedPiMessageWithOutcome as d, resolveActiveEmbeddedRunHandleSessionId as f, waitForActiveEmbeddedRuns as g, updateActiveEmbeddedRunSnapshot as h, forceClearEmbeddedPiRun as i, isEmbeddedPiRunStreaming as l, setActiveEmbeddedRun as m, abortEmbeddedPiRun as n, getActiveEmbeddedRunSnapshot as o, resolveActiveEmbeddedRunSessionId as p, clearActiveEmbeddedRun as r, isEmbeddedPiRunActive as s, abortAndDrainEmbeddedPiRun as t, queueEmbeddedPiMessage as u };
