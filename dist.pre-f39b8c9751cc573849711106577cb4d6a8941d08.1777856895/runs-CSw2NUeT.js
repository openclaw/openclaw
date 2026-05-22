import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as resolveGlobalSingleton } from "./global-singleton-COlWgaGc.js";
import { _ as markDiagnosticEmbeddedRunEnded, i as logMessageQueued, s as logSessionStateChange, v as markDiagnosticEmbeddedRunStarted } from "./diagnostic-5w-8kHIX.js";
import { t as diagnosticLogger } from "./diagnostic-runtime-BvYl76jm.js";
//#region src/auto-reply/reply/reply-run-registry.ts
const replyRunState = resolveGlobalSingleton(Symbol.for("openclaw.replyRunRegistry"), () => ({
	activeRunsByKey: /* @__PURE__ */ new Map(),
	activeSessionIdsByKey: /* @__PURE__ */ new Map(),
	activeKeysBySessionId: /* @__PURE__ */ new Map(),
	waitKeysBySessionId: /* @__PURE__ */ new Map(),
	waitersByKey: /* @__PURE__ */ new Map()
}));
var ReplyRunAlreadyActiveError = class extends Error {
	constructor(sessionKey) {
		super(`Reply run already active for ${sessionKey}`);
		this.name = "ReplyRunAlreadyActiveError";
	}
};
function createUserAbortError() {
	const err = /* @__PURE__ */ new Error("Reply operation aborted by user");
	err.name = "AbortError";
	return err;
}
function registerWaitSessionId(sessionKey, sessionId) {
	replyRunState.waitKeysBySessionId.set(sessionId, sessionKey);
}
function clearWaitSessionIds(sessionKey) {
	for (const [sessionId, mappedKey] of replyRunState.waitKeysBySessionId) if (mappedKey === sessionKey) replyRunState.waitKeysBySessionId.delete(sessionId);
}
function notifyReplyRunEnded(sessionKey) {
	const waiters = replyRunState.waitersByKey.get(sessionKey);
	if (!waiters || waiters.size === 0) return;
	replyRunState.waitersByKey.delete(sessionKey);
	for (const waiter of waiters) {
		clearTimeout(waiter.timer);
		waiter.resolve(true);
	}
}
function resolveReplyRunForCurrentSessionId(sessionId) {
	const normalizedSessionId = normalizeOptionalString(sessionId);
	if (!normalizedSessionId) return;
	const sessionKey = replyRunState.activeKeysBySessionId.get(normalizedSessionId);
	if (!sessionKey) return;
	return replyRunState.activeRunsByKey.get(sessionKey);
}
function resolveReplyRunWaitKey(sessionId) {
	const normalizedSessionId = normalizeOptionalString(sessionId);
	if (!normalizedSessionId) return;
	return replyRunState.activeKeysBySessionId.get(normalizedSessionId) ?? replyRunState.waitKeysBySessionId.get(normalizedSessionId);
}
function isReplyRunCompacting(operation) {
	if (operation.phase === "preflight_compacting" || operation.phase === "memory_flushing") return true;
	if (operation.phase !== "running") return false;
	return getAttachedBackend(operation)?.isCompacting?.() ?? false;
}
const attachedBackendByOperation = /* @__PURE__ */ new WeakMap();
function getAttachedBackend(operation) {
	return attachedBackendByOperation.get(operation);
}
function clearReplyRunState(params) {
	replyRunState.activeRunsByKey.delete(params.sessionKey);
	if (replyRunState.activeSessionIdsByKey.get(params.sessionKey) === params.sessionId) replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
	else replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
	if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) replyRunState.activeKeysBySessionId.delete(params.sessionId);
	clearWaitSessionIds(params.sessionKey);
	notifyReplyRunEnded(params.sessionKey);
}
function createReplyOperation(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	const sessionId = normalizeOptionalString(params.sessionId);
	if (!sessionKey) throw new Error("Reply operations require a canonical sessionKey");
	if (!sessionId) throw new Error("Reply operations require a sessionId");
	if (replyRunState.activeRunsByKey.has(sessionKey)) throw new ReplyRunAlreadyActiveError(sessionKey);
	const controller = new AbortController();
	let currentSessionId = sessionId;
	let phase = "queued";
	let result = null;
	let stateCleared = false;
	const clearState = () => {
		if (stateCleared) return;
		stateCleared = true;
		clearReplyRunState({
			sessionKey,
			sessionId: currentSessionId
		});
	};
	const abortInternally = (reason) => {
		if (!controller.signal.aborted) controller.abort(reason);
	};
	const abortWithReason = (reason, abortReason, opts) => {
		if (opts?.abortedCode && !result) result = {
			kind: "aborted",
			code: opts.abortedCode
		};
		phase = "aborted";
		abortInternally(abortReason);
		getAttachedBackend(operation)?.cancel(reason);
	};
	if (params.upstreamAbortSignal) if (params.upstreamAbortSignal.aborted) abortInternally(params.upstreamAbortSignal.reason);
	else params.upstreamAbortSignal.addEventListener("abort", () => {
		abortInternally(params.upstreamAbortSignal?.reason);
	}, { once: true });
	const operation = {
		get key() {
			return sessionKey;
		},
		get sessionId() {
			return currentSessionId;
		},
		get abortSignal() {
			return controller.signal;
		},
		get resetTriggered() {
			return params.resetTriggered;
		},
		get phase() {
			return phase;
		},
		get result() {
			return result;
		},
		setPhase(next) {
			if (result) return;
			phase = next;
		},
		updateSessionId(nextSessionId) {
			if (result) return;
			const normalizedNextSessionId = normalizeOptionalString(nextSessionId);
			if (!normalizedNextSessionId || normalizedNextSessionId === currentSessionId) return;
			if (replyRunState.activeKeysBySessionId.has(normalizedNextSessionId) && replyRunState.activeKeysBySessionId.get(normalizedNextSessionId) !== sessionKey) throw new Error(`Cannot rebind reply operation ${sessionKey} to active session ${normalizedNextSessionId}`);
			replyRunState.activeKeysBySessionId.delete(currentSessionId);
			registerWaitSessionId(sessionKey, currentSessionId);
			currentSessionId = normalizedNextSessionId;
			replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
			replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
			registerWaitSessionId(sessionKey, currentSessionId);
		},
		attachBackend(handle) {
			if (result) {
				handle.cancel(result.kind === "aborted" ? result.code === "aborted_for_restart" ? "restart" : "user_abort" : "superseded");
				return;
			}
			attachedBackendByOperation.set(operation, handle);
			if (controller.signal.aborted) handle.cancel("superseded");
		},
		detachBackend(handle) {
			if (getAttachedBackend(operation) === handle) attachedBackendByOperation.delete(operation);
		},
		complete() {
			if (!result) {
				result = { kind: "completed" };
				phase = "completed";
			}
			clearState();
		},
		fail(code, cause) {
			if (!result) {
				result = {
					kind: "failed",
					code,
					cause
				};
				phase = "failed";
			}
			clearState();
		},
		abortByUser() {
			const phaseBeforeAbort = phase;
			abortWithReason("user_abort", createUserAbortError(), { abortedCode: "aborted_by_user" });
			if (phaseBeforeAbort === "queued") clearState();
		},
		abortForRestart() {
			const phaseBeforeAbort = phase;
			abortWithReason("restart", /* @__PURE__ */ new Error("Reply operation aborted for restart"), { abortedCode: "aborted_for_restart" });
			if (phaseBeforeAbort === "queued") clearState();
		}
	};
	replyRunState.activeRunsByKey.set(sessionKey, operation);
	replyRunState.activeSessionIdsByKey.set(sessionKey, currentSessionId);
	replyRunState.activeKeysBySessionId.set(currentSessionId, sessionKey);
	registerWaitSessionId(sessionKey, currentSessionId);
	return operation;
}
const replyRunRegistry = {
	begin(params) {
		return createReplyOperation(params);
	},
	get(sessionKey) {
		const normalizedSessionKey = normalizeOptionalString(sessionKey);
		if (!normalizedSessionKey) return;
		return replyRunState.activeRunsByKey.get(normalizedSessionKey);
	},
	isActive(sessionKey) {
		const normalizedSessionKey = normalizeOptionalString(sessionKey);
		if (!normalizedSessionKey) return false;
		return replyRunState.activeRunsByKey.has(normalizedSessionKey);
	},
	isStreaming(sessionKey) {
		const operation = this.get(sessionKey);
		if (!operation || operation.phase !== "running") return false;
		return getAttachedBackend(operation)?.isStreaming() ?? false;
	},
	abort(sessionKey) {
		const operation = this.get(sessionKey);
		if (!operation) return false;
		operation.abortByUser();
		return true;
	},
	waitForIdle(sessionKey, timeoutMs = 15e3) {
		const normalizedSessionKey = normalizeOptionalString(sessionKey);
		if (!normalizedSessionKey || !replyRunState.activeRunsByKey.has(normalizedSessionKey)) return Promise.resolve(true);
		return new Promise((resolve) => {
			const waiters = replyRunState.waitersByKey.get(normalizedSessionKey) ?? /* @__PURE__ */ new Set();
			const waiter = {
				resolve,
				timer: setTimeout(() => {
					waiters.delete(waiter);
					if (waiters.size === 0) replyRunState.waitersByKey.delete(normalizedSessionKey);
					resolve(false);
				}, Math.max(100, timeoutMs))
			};
			waiters.add(waiter);
			replyRunState.waitersByKey.set(normalizedSessionKey, waiters);
			if (!replyRunState.activeRunsByKey.has(normalizedSessionKey)) {
				waiters.delete(waiter);
				if (waiters.size === 0) replyRunState.waitersByKey.delete(normalizedSessionKey);
				clearTimeout(waiter.timer);
				resolve(true);
			}
		});
	},
	resolveSessionId(sessionKey) {
		const normalizedSessionKey = normalizeOptionalString(sessionKey);
		if (!normalizedSessionKey) return;
		return replyRunState.activeSessionIdsByKey.get(normalizedSessionKey);
	}
};
function resolveActiveReplyRunSessionId(sessionKey) {
	return replyRunRegistry.resolveSessionId(sessionKey);
}
function isReplyRunActiveForSessionId(sessionId) {
	return resolveReplyRunForCurrentSessionId(sessionId) !== void 0;
}
function isReplyRunStreamingForSessionId(sessionId) {
	const operation = resolveReplyRunForCurrentSessionId(sessionId);
	if (!operation || operation.phase !== "running") return false;
	return getAttachedBackend(operation)?.isStreaming() ?? false;
}
function queueReplyRunMessage(sessionId, text) {
	const operation = resolveReplyRunForCurrentSessionId(sessionId);
	const backend = operation ? getAttachedBackend(operation) : void 0;
	if (!operation || operation.phase !== "running" || !backend?.queueMessage) return false;
	if (!backend.isStreaming()) return false;
	backend.queueMessage(text);
	return true;
}
function abortReplyRunBySessionId(sessionId) {
	const operation = resolveReplyRunForCurrentSessionId(sessionId);
	if (!operation) return false;
	operation.abortByUser();
	return true;
}
function forceClearReplyRunBySessionId(sessionId, cause) {
	const operation = resolveReplyRunForCurrentSessionId(sessionId);
	if (!operation) return false;
	operation.fail("run_failed", cause);
	return true;
}
function waitForReplyRunEndBySessionId(sessionId, timeoutMs = 15e3) {
	const waitKey = resolveReplyRunWaitKey(sessionId);
	if (!waitKey) return Promise.resolve(true);
	return replyRunRegistry.waitForIdle(waitKey, timeoutMs);
}
function abortActiveReplyRuns(opts) {
	let aborted = false;
	for (const operation of replyRunState.activeRunsByKey.values()) {
		if (opts.mode === "compacting" && !isReplyRunCompacting(operation)) continue;
		operation.abortForRestart();
		aborted = true;
	}
	return aborted;
}
function getActiveReplyRunCount() {
	return replyRunState.activeRunsByKey.size;
}
function listActiveReplyRunSessionIds() {
	return [...replyRunState.activeSessionIdsByKey.values()];
}
//#endregion
//#region src/agents/pi-embedded-runner/run-state.ts
const embeddedRunState = resolveGlobalSingleton(Symbol.for("openclaw.embeddedRunState"), () => ({
	activeRuns: /* @__PURE__ */ new Map(),
	snapshots: /* @__PURE__ */ new Map(),
	sessionIdsByKey: /* @__PURE__ */ new Map(),
	waiters: /* @__PURE__ */ new Map(),
	modelSwitchRequests: /* @__PURE__ */ new Map()
}));
const ACTIVE_EMBEDDED_RUNS = embeddedRunState.activeRuns ?? (embeddedRunState.activeRuns = /* @__PURE__ */ new Map());
const ACTIVE_EMBEDDED_RUN_SNAPSHOTS = embeddedRunState.snapshots ?? (embeddedRunState.snapshots = /* @__PURE__ */ new Map());
const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY = embeddedRunState.sessionIdsByKey ?? (embeddedRunState.sessionIdsByKey = /* @__PURE__ */ new Map());
const EMBEDDED_RUN_WAITERS = embeddedRunState.waiters ?? (embeddedRunState.waiters = /* @__PURE__ */ new Map());
const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS = embeddedRunState.modelSwitchRequests ?? (embeddedRunState.modelSwitchRequests = /* @__PURE__ */ new Map());
function getActiveEmbeddedRunCount() {
	let activeCount = ACTIVE_EMBEDDED_RUNS.size;
	for (const sessionId of listActiveReplyRunSessionIds()) if (!ACTIVE_EMBEDDED_RUNS.has(sessionId)) activeCount += 1;
	return Math.max(activeCount, getActiveReplyRunCount());
}
//#endregion
//#region src/agents/pi-embedded-runner/runs.ts
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
function queueEmbeddedPiMessage(sessionId, text, options) {
	const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
	if (!handle) {
		if (queueReplyRunMessage(sessionId, text)) {
			logMessageQueued({
				sessionId,
				source: "pi-embedded-runner"
			});
			return true;
		}
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=no_active_run`);
		return false;
	}
	if (!handle.isStreaming()) {
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=not_streaming`);
		return false;
	}
	if (handle.isCompacting()) {
		diagnosticLogger.debug(`queue message failed: sessionId=${sessionId} reason=compacting`);
		return false;
	}
	logMessageQueued({
		sessionId,
		source: "pi-embedded-runner"
	});
	handle.queueMessage(text, options ?? { steeringMode: "all" });
	return true;
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
export { ReplyRunAlreadyActiveError as _, getActiveEmbeddedRunSnapshot as a, isEmbeddedPiRunStreaming as c, resolveActiveEmbeddedRunSessionId as d, setActiveEmbeddedRun as f, getActiveEmbeddedRunCount as g, waitForEmbeddedPiRunEnd as h, forceClearEmbeddedPiRun as i, queueEmbeddedPiMessage as l, waitForActiveEmbeddedRuns as m, abortEmbeddedPiRun as n, isEmbeddedPiRunActive as o, updateActiveEmbeddedRunSnapshot as p, clearActiveEmbeddedRun as r, isEmbeddedPiRunHandleActive as s, abortAndDrainEmbeddedPiRun as t, resolveActiveEmbeddedRunHandleSessionId as u, createReplyOperation as v, replyRunRegistry as y };
