import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { n as markDiagnosticEmbeddedRunEnded, r as markDiagnosticEmbeddedRunStarted } from "./diagnostic-run-activity-b7xVOYWO.js";
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
	replyRunState.activeSessionIdsByKey.delete(params.sessionKey);
	if (replyRunState.activeKeysBySessionId.get(params.sessionId) === params.sessionKey) replyRunState.activeKeysBySessionId.delete(params.sessionId);
	clearWaitSessionIds(params.sessionKey);
	notifyReplyRunEnded(params.sessionKey);
}
function replyRunDiagnosticWorkKey(sessionKey) {
	return `reply:${sessionKey}`;
}
function markReplyRunDiagnosticWorkStarted(params) {
	markDiagnosticEmbeddedRunStarted({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workKey: replyRunDiagnosticWorkKey(params.sessionKey)
	});
}
function markReplyRunDiagnosticWorkEnded(params) {
	markDiagnosticEmbeddedRunEnded({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workKey: replyRunDiagnosticWorkKey(params.sessionKey),
		clearRunActivity: false
	});
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
		markReplyRunDiagnosticWorkEnded({
			sessionKey,
			sessionId: currentSessionId
		});
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
			markReplyRunDiagnosticWorkStarted({
				sessionKey,
				sessionId: currentSessionId
			});
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
	markReplyRunDiagnosticWorkStarted({
		sessionKey,
		sessionId: currentSessionId
	});
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
function listActiveReplyRunSessionKeys() {
	return [...replyRunState.activeSessionIdsByKey.keys()];
}
//#endregion
export { forceClearReplyRunBySessionId as a, isReplyRunStreamingForSessionId as c, queueReplyRunMessage as d, replyRunRegistry as f, createReplyOperation as i, listActiveReplyRunSessionIds as l, waitForReplyRunEndBySessionId as m, abortActiveReplyRuns as n, getActiveReplyRunCount as o, resolveActiveReplyRunSessionId as p, abortReplyRunBySessionId as r, isReplyRunActiveForSessionId as s, ReplyRunAlreadyActiveError as t, listActiveReplyRunSessionKeys as u };
