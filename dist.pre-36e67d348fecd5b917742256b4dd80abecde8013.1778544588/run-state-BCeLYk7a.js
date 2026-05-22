import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DZyLAEQq.js";
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
		completeThen(afterClear) {
			operation.complete();
			afterClear();
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
export { waitForReplyRunEndBySessionId as _, EMBEDDED_RUN_WAITERS as a, abortActiveReplyRuns as c, forceClearReplyRunBySessionId as d, isReplyRunActiveForSessionId as f, resolveActiveReplyRunSessionId as g, replyRunRegistry as h, EMBEDDED_RUN_MODEL_SWITCH_REQUESTS as i, abortReplyRunBySessionId as l, queueReplyRunMessage as m, ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY as n, getActiveEmbeddedRunCount as o, isReplyRunStreamingForSessionId as p, ACTIVE_EMBEDDED_RUN_SNAPSHOTS as r, ReplyRunAlreadyActiveError as s, ACTIVE_EMBEDDED_RUNS as t, createReplyOperation as u };
