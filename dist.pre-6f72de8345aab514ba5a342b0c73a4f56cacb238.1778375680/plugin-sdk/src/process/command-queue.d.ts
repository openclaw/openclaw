import type { CommandQueueEnqueueOptions } from "./command-queue.types.js";
/**
 * Dedicated error type thrown when a queued command is rejected because
 * its lane was cleared.  Callers that fire-and-forget enqueued tasks can
 * catch (or ignore) this specific type to avoid unhandled-rejection noise.
 */
export declare class CommandLaneClearedError extends Error {
    constructor(lane?: string);
}
/**
 * Dedicated error type thrown when an active command exceeds its caller-owned
 * lane timeout. The underlying task may still be unwinding, but the lane is
 * released so queued work is not blocked forever.
 */
export declare class CommandLaneTaskTimeoutError extends Error {
    constructor(lane: string, timeoutMs: number);
}
/**
 * Dedicated error type thrown when a new command is rejected because the
 * gateway is currently draining for restart.
 */
export declare class GatewayDrainingError extends Error {
    constructor();
}
export type CommandLaneSnapshot = {
    lane: string;
    queuedCount: number;
    activeCount: number;
    maxConcurrent: number;
    draining: boolean;
    generation: number;
};
/**
 * Mark gateway as draining for restart so new enqueues fail fast with
 * `GatewayDrainingError` instead of being silently killed on shutdown.
 */
export declare function markGatewayDraining(): void;
export declare function setCommandLaneConcurrency(lane: string, maxConcurrent: number): void;
export declare function enqueueCommandInLane<T>(lane: string, task: () => Promise<T>, opts?: CommandQueueEnqueueOptions): Promise<T>;
export declare function enqueueCommand<T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions): Promise<T>;
export declare function getQueueSize(lane?: string): number;
export declare function getCommandLaneSnapshot(lane?: string): CommandLaneSnapshot;
export declare function getCommandLaneSnapshots(): CommandLaneSnapshot[];
export declare function getTotalQueueSize(): number;
export declare function clearCommandLane(lane?: string): number;
/**
 * Force a single lane back to idle and immediately pump any queued entries.
 * Used only by recovery paths after the owner has already attempted to abort
 * the active work; stale completions from the previous generation are ignored.
 */
export declare function resetCommandLane(lane?: string): number;
/**
 * Test-only hard reset that discards all queue state, including preserved
 * queued work from previous generations. Use this when a suite needs an
 * isolated baseline across shared-worker runs.
 */
export declare function resetCommandQueueStateForTest(): void;
/**
 * Reset all lane runtime state to idle. Used after SIGUSR1 in-process
 * restarts where interrupted tasks' finally blocks may not run, leaving
 * stale active task IDs that permanently block new work from draining.
 *
 * Bumps lane generation and clears execution counters so stale completions
 * from old in-flight tasks are ignored. Queued entries are intentionally
 * preserved — they represent pending user work that should still execute
 * after restart.
 *
 * After resetting, drains any lanes that still have queued entries so
 * preserved work is pumped immediately rather than waiting for a future
 * `enqueueCommandInLane()` call (which may never come).
 */
export declare function resetAllLanes(): void;
/**
 * Returns the total number of actively executing tasks across all lanes
 * (excludes queued-but-not-started entries).
 */
export declare function getActiveTaskCount(): number;
/**
 * Wait for all currently active tasks across all lanes to finish.
 * Polls at a short interval; resolves when no tasks are active or
 * when `timeoutMs` elapses (whichever comes first). If no timeout is passed,
 * waits indefinitely for the active set captured at call time.
 *
 * New tasks enqueued after this call are ignored — only tasks that are
 * already executing are waited on.
 */
export declare function waitForActiveTasks(timeoutMs?: number): Promise<{
    drained: boolean;
}>;
