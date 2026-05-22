/**
 * Continuation delegate store — pure TaskFlow-backed.
 *
 * Every delegate operation goes through TaskFlow (SQLite persistence).
 * Zero volatile Maps. Delegates survive gateway restarts by design.
 *
 * Adds Zod validation on state payloads, a `releasedAt` audit trail, and
 * `failFlow` for corrupt records on top of the base TaskFlow store.
 *
 * RFC: docs/design/continue-work-signal-v2.md §5.4
 */
import type { DelayedContinuationReservation, PendingContinuationDelegate, StagedPostCompactionDelegate } from "./types.js";
export declare const CONTINUATION_DELEGATE_CONTROLLER_ID = "core/continuation-delegate";
export declare const CONTINUATION_POST_COMPACTION_CONTROLLER_ID = "core/continuation-post-compaction";
export type ContinuationDelegateQueueDepths = {
    pendingQueued: number;
    pendingRunnable: number;
    pendingScheduled: number;
    stagedPostCompaction: number;
    totalQueued: number;
};
/**
 * Enqueue a delegate from the `continue_delegate` tool.
 */
export declare function enqueuePendingDelegate(sessionKey: string, delegate: PendingContinuationDelegate): void;
/**
 * Consume pending delegates for a session whose `delayMs` horizon has matured.
 *
 * Filters by `Date.now() >= flow.createdAt + (state.delayMs ?? 0)`. Matured
 * entries are finished with the `releasedAt` audit trail and returned in FIFO
 * order. Unmatured entries are left in `queued` state to be re-checked on the
 * next consume cycle (filter-at-consume; preserves `mode=silent` no-wake
 * semantics so a quiet-channel session is not woken solely to drain a delegate
 * whose horizon has not yet matured).
 *
 * Skips corrupt payloads via `failFlow`. Only pushes delegates where
 * `finishFlow` was applied (concurrency-safe).
 *
 * Callers that need to know when to retry the consume cycle in a quiet channel
 * should call `peekSoonestUnmaturedDelegateDueAt(sessionKey)` immediately after
 * this returns. Pairing avoids a separate query path.
 *
 * Maturity contract for downstream callers: each returned delegate has
 * already passed its `createdAt + delayMs` horizon. The `delayMs` field on
 * the returned object is historical metadata — useful for telemetry
 * discriminators — and MUST NOT be used as a fresh scheduling instruction.
 * Re-arming a `setTimeout(delayMs)` against a consumed delegate charges the
 * wait twice and drifts recipient drains by approximately the original delay.
 */
export declare function consumePendingDelegates(sessionKey: string): PendingContinuationDelegate[];
/**
 * Peek the soonest `dueAt` (createdAt + delayMs) across queued, unmatured
 * pending delegates for a session.
 *
 * Returns `undefined` if there are no unmatured entries. Used by
 * `dispatchToolDelegates` to arm a hedge `setTimeout` so unmatured entries
 * still fire in fully-quiet channels where no further response-finalize
 * arrives.
 */
export declare function peekSoonestUnmaturedDelegateDueAt(sessionKey: string): number | undefined;
/**
 * Count pending delegates without consuming them.
 */
export declare function pendingDelegateCount(sessionKey: string): number;
export declare function getContinuationDelegateQueueDepths(sessionKey: string, now?: number): ContinuationDelegateQueueDepths;
/**
 * Cancel all pending delegates for a session (both regular and post-compaction).
 */
export declare function cancelPendingDelegates(sessionKey: string): void;
/**
 * Stage a delegate for release after compaction.
 */
export declare function stagePostCompactionDelegate(sessionKey: string, delegate: StagedPostCompactionDelegate): void;
/**
 * Consume staged post-compaction delegates. Same lifecycle as consumePendingDelegates.
 */
export declare function consumeStagedPostCompactionDelegates(sessionKey: string): PendingContinuationDelegate[];
export declare function stagedPostCompactionDelegateCount(sessionKey: string): number;
export declare function addDelayedContinuationReservation(sessionKey: string, reservation: DelayedContinuationReservation): void;
export declare function takeDelayedContinuationReservation(sessionKey: string, reservationId: string): DelayedContinuationReservation | null;
export declare function delayedContinuationReservationCount(sessionKey: string): number;
export declare function highestDelayedContinuationReservationHop(sessionKey: string): number;
export declare function clearDelayedContinuationReservations(sessionKey: string): void;
export declare function listDelayedContinuationReservations(sessionKey: string): DelayedContinuationReservation[];
export declare function removeDelayedContinuationReservation(sessionKey: string, reservationId: string): boolean;
export declare function resetDelegateStoreForTests(): void;
