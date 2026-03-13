type EmbeddedPiQueueHandle = {
    queueMessage: (text: string) => Promise<void>;
    isStreaming: () => boolean;
    isCompacting: () => boolean;
    abort: () => void;
};
export declare function queueEmbeddedPiMessage(sessionId: string, text: string): boolean;
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
export declare function isEmbeddedPiRunStreaming(sessionId: string): boolean;
export declare function getActiveEmbeddedRunCount(): number;
/**
 * Wait for active embedded runs to drain.
 *
 * Used during restarts so in-flight compaction runs can release session write
 * locks before the next lifecycle starts.
 */
export declare function waitForActiveEmbeddedRuns(timeoutMs?: number, opts?: {
    pollMs?: number;
}): Promise<{
    drained: boolean;
}>;
export declare function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs?: number): Promise<boolean>;
export declare function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export declare function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export declare const __testing: {
    resetActiveEmbeddedRuns(): void;
};
export type { EmbeddedPiQueueHandle };
