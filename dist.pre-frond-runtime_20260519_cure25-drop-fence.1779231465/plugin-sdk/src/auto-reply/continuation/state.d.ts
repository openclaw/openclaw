/**
 * Continuation chain state tracking.
 *
 * Tracks per-session chain metadata (depth, start time, accumulated tokens)
 * and timer handle registration. NO generation guard — delayed delegates
 * survive channel noise by design.
 *
 * RFC: docs/design/continue-work-signal-v2.md §3.3
 */
type ContinuationTimerHandle = ReturnType<typeof setTimeout>;
export declare function hasDelegatePending(sessionKey: string): boolean;
/**
 * Increment the timer ref count for a session. Call when scheduling a
 * delayed continuation timer.
 */
export declare function retainContinuationTimerRef(sessionKey: string): void;
/**
 * Decrement the timer ref count. Call when a timer fires or is cancelled.
 */
export declare function releaseContinuationTimerRef(sessionKey: string): void;
export declare function hasLiveContinuationTimerRefs(sessionKey: string): boolean;
/**
 * Register a timer handle so it can be cleared on session reset.
 */
export declare function registerContinuationTimerHandle(sessionKey: string, handle: ContinuationTimerHandle): void;
/**
 * Unregister a timer handle after it fires or is cancelled.
 * Also releases the timer ref.
 */
export declare function unregisterContinuationTimerHandle(sessionKey: string, handle: ContinuationTimerHandle): boolean;
/**
 * Clear all tracked continuation timers for a session. Used on explicit
 * session reset (/new, /reset) — NOT on inbound noise.
 */
export declare function clearTrackedContinuationTimers(sessionKey: string): void;
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ChainState } from "./types.js";
/**
 * Structural subset of `SessionEntry` covering only the fields the
 * continuation-chain read path needs. Declared independently so callers
 * that want to avoid a static edge into `src/config/sessions/types.js`
 * (notably `subagent-announce.ts` — cycle-avoidance) can satisfy the
 * helper signature without an extra type import.
 */
export type ContinuationChainSource = {
    continuationChainCount?: number;
    continuationChainStartedAt?: number;
    continuationChainTokens?: number;
    continuationChainId?: string;
};
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
export declare function loadContinuationChainState(source: ContinuationChainSource | undefined, turnTokens?: number): ChainState;
/**
 * Persist continuation chain metadata to the session entry.
 * Called after scheduling to keep chain depth, start time, and token cost
 * in sync with the session store.
 */
export declare function persistContinuationChainState(params: {
    sessionEntry?: SessionEntry;
    count: number;
    startedAt: number;
    tokens: number;
}): void;
export declare function resetContinuationStateForTests(): void;
export {};
