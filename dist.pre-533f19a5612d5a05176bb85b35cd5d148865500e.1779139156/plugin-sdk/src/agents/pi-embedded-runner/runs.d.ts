import { type ActiveEmbeddedRunSnapshot, type EmbeddedPiQueueHandle, type EmbeddedPiQueueMessageOptions, type EmbeddedRunModelSwitchRequest } from "./run-state.js";
export { getActiveEmbeddedRunCount, listActiveEmbeddedRunSessionIds, listActiveEmbeddedRunSessionKeys, type ActiveEmbeddedRunSnapshot, type EmbeddedPiQueueHandle, type EmbeddedPiQueueMessageOptions, type EmbeddedRunModelSwitchRequest, } from "./run-state.js";
export type EmbeddedPiQueueFailureReason = "no_active_run" | "not_streaming" | "compacting" | "source_reply_delivery_mode_mismatch" | "transcript_commit_wait_unsupported" | "runtime_rejected";
export type EmbeddedPiQueueMessageOutcome = {
    queued: true;
    sessionId: string;
    target: "embedded_run" | "reply_run";
    gatewayHealth: "live";
    deliveredAtMs?: number;
    enqueuedAtMs?: number;
} | {
    queued: false;
    sessionId: string;
    reason: EmbeddedPiQueueFailureReason;
    gatewayHealth: "live";
    errorMessage?: string;
};
export declare function formatEmbeddedPiQueueFailureSummary(outcome: EmbeddedPiQueueMessageOutcome): string | undefined;
/**
 * @deprecated Use queueEmbeddedPiMessageWithOutcomeAsync for delivery decisions.
 * This boolean helper only reports immediate queue eligibility; it cannot surface
 * async runtime rejection from the active run.
 */
export declare function queueEmbeddedPiMessage(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): boolean;
/**
 * @deprecated Prefer queueEmbeddedPiMessageWithOutcomeAsync when callers need to
 * know whether steering was accepted. This sync helper is fire-and-forget after
 * initial eligibility and only logs later runtime rejection.
 */
export declare function queueEmbeddedPiMessageWithOutcome(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): EmbeddedPiQueueMessageOutcome;
export declare function queueEmbeddedPiMessageWithOutcomeAsync(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): Promise<EmbeddedPiQueueMessageOutcome>;
/**
 * Abort embedded PI runs.
 *
 * - With a sessionId, aborts that single run.
 * - With no sessionId, supports targeted abort modes (for example, compacting runs only).
 */
export declare function abortEmbeddedPiRun(sessionId: string): boolean;
export declare function abortEmbeddedPiRun(sessionId: undefined, opts: {
    mode: "all" | "compacting";
}): boolean;
export declare function isEmbeddedPiRunActive(sessionId: string): boolean;
export declare function isEmbeddedPiRunHandleActive(sessionId: string): boolean;
export declare function isEmbeddedPiRunStreaming(sessionId: string): boolean;
export declare function resolveActiveEmbeddedRunHandleSessionId(sessionKey: string): string | undefined;
export declare function resolveActiveEmbeddedRunSessionId(sessionKey: string): string | undefined;
export declare function getActiveEmbeddedRunSnapshot(sessionId: string): ActiveEmbeddedRunSnapshot | undefined;
export declare function requestEmbeddedRunModelSwitch(sessionId: string, request: EmbeddedRunModelSwitchRequest): boolean;
export declare function consumeEmbeddedRunModelSwitch(sessionId: string): EmbeddedRunModelSwitchRequest | undefined;
/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight runs can release session write locks before
 * the next lifecycle starts. If no timeout is passed, waits indefinitely.
 */
export declare function waitForActiveEmbeddedRuns(timeoutMs?: number, opts?: {
    pollMs?: number;
}): Promise<{
    drained: boolean;
}>;
export declare function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs?: number): Promise<boolean>;
export type AbortAndDrainEmbeddedPiRunResult = {
    aborted: boolean;
    drained: boolean;
    forceCleared: boolean;
};
export declare function abortAndDrainEmbeddedPiRun(params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
}): Promise<AbortAndDrainEmbeddedPiRunResult>;
export declare function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export declare function updateActiveEmbeddedRunSnapshot(sessionId: string, snapshot: ActiveEmbeddedRunSnapshot): void;
export declare function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export declare function forceClearEmbeddedPiRun(sessionId: string, sessionKey?: string, reason?: string): boolean;
export declare const testing: {
    resetActiveEmbeddedRuns(): void;
};
export { testing as __testing };
