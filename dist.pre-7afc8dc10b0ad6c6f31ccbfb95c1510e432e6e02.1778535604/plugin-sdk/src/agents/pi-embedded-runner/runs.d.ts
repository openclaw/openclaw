import { type ActiveEmbeddedRunSnapshot, type EmbeddedPiQueueHandle, type EmbeddedPiQueueMessageOptions, type EmbeddedRunModelSwitchRequest } from "./run-state.js";
export { getActiveEmbeddedRunCount, type ActiveEmbeddedRunSnapshot, type EmbeddedPiQueueHandle, type EmbeddedPiQueueMessageOptions, type EmbeddedRunModelSwitchRequest, } from "./run-state.js";
export declare function queueEmbeddedPiMessage(sessionId: string, text: string, options?: EmbeddedPiQueueMessageOptions): boolean;
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
export declare const __testing: {
    resetActiveEmbeddedRuns(): void;
};
