import { d as pendingDelegateCount, o as delayedContinuationReservationCount, p as stagedPostCompactionDelegateCount } from "./delegate-store-BkZAXeom.js";
//#region src/auto-reply/continuation/state.ts
const continuationTimerHandles = /* @__PURE__ */ new Map();
const continuationTimerRefs = /* @__PURE__ */ new Map();
function hasDelegatePending(sessionKey) {
	return pendingDelegateCount(sessionKey) > 0 || stagedPostCompactionDelegateCount(sessionKey) > 0 || delayedContinuationReservationCount(sessionKey) > 0;
}
/**
* Increment the timer ref count for a session. Call when scheduling a
* delayed continuation timer.
*/
function retainContinuationTimerRef(sessionKey) {
	continuationTimerRefs.set(sessionKey, (continuationTimerRefs.get(sessionKey) ?? 0) + 1);
}
/**
* Decrement the timer ref count. Call when a timer fires or is cancelled.
*/
function releaseContinuationTimerRef(sessionKey) {
	const current = continuationTimerRefs.get(sessionKey) ?? 0;
	if (current <= 1) continuationTimerRefs.delete(sessionKey);
	else continuationTimerRefs.set(sessionKey, current - 1);
}
function hasLiveContinuationTimerRefs(sessionKey) {
	return (continuationTimerRefs.get(sessionKey) ?? 0) > 0;
}
/**
* Register a timer handle so it can be cleared on session reset.
*/
function registerContinuationTimerHandle(sessionKey, handle) {
	const existing = continuationTimerHandles.get(sessionKey);
	if (existing) {
		existing.add(handle);
		return;
	}
	continuationTimerHandles.set(sessionKey, new Set([handle]));
}
/**
* Unregister a timer handle after it fires or is cancelled.
* Also releases the timer ref.
*/
function unregisterContinuationTimerHandle(sessionKey, handle) {
	const existing = continuationTimerHandles.get(sessionKey);
	if (!existing?.delete(handle)) return false;
	if (existing.size === 0) continuationTimerHandles.delete(sessionKey);
	releaseContinuationTimerRef(sessionKey);
	return true;
}
/**
* Clear all tracked continuation timers for a session. Used on explicit
* session reset (/new, /reset) — NOT on inbound noise.
*/
function clearTrackedContinuationTimers(sessionKey) {
	const existing = continuationTimerHandles.get(sessionKey);
	if (!existing || existing.size === 0) return;
	continuationTimerHandles.delete(sessionKey);
	for (const handle of existing) {
		clearTimeout(handle);
		setTimeout(() => {
			releaseContinuationTimerRef(sessionKey);
		}, 0).unref();
	}
}
/**
* Read continuation chain state from a SessionEntry with safe defaults.
*
* Collapses the scattered `?? 0` / `?? Date.now()` sentinel pattern from
* 6+ call sites (agent-runner, followup-runner, subagent-announce) into
* one canonical adapter. The returned ChainState has `turnTokens` folded
* into `accumulatedChainTokens` so callers don't repeat the addition.
*
* - `undefined` source → zeroed chain, `chainStartedAt = Date.now()`
* - missing `continuationChainStartedAt` → `Date.now()` (the chain appears
*   to start fresh this turn; matches historical sentinel behavior).
*
* Accepts any shape compatible with `ContinuationChainSource`, including
* `SessionEntry` (structural compatibility).
*/
function loadContinuationChainState(source, turnTokens = 0) {
	return {
		currentChainCount: source?.continuationChainCount ?? 0,
		chainStartedAt: source?.continuationChainStartedAt ?? Date.now(),
		accumulatedChainTokens: (source?.continuationChainTokens ?? 0) + turnTokens
	};
}
/**
* Persist continuation chain metadata to the session entry.
* Called after scheduling to keep chain depth, start time, and token cost
* in sync with the session store.
*/
function persistContinuationChainState(params) {
	if (!params.sessionEntry) return;
	params.sessionEntry.continuationChainCount = params.count;
	params.sessionEntry.continuationChainStartedAt = params.startedAt;
	params.sessionEntry.continuationChainTokens = params.tokens;
}
function resetContinuationStateForTests() {
	continuationTimerHandles.clear();
	continuationTimerRefs.clear();
}
//#endregion
export { persistContinuationChainState as a, resetContinuationStateForTests as c, loadContinuationChainState as i, retainContinuationTimerRef as l, hasDelegatePending as n, registerContinuationTimerHandle as o, hasLiveContinuationTimerRefs as r, releaseContinuationTimerRef as s, clearTrackedContinuationTimers as t, unregisterContinuationTimerHandle as u };
