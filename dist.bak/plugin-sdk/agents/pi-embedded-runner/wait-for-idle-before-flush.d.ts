type IdleAwareAgent = {
    waitForIdle?: (() => Promise<void>) | undefined;
};
type ToolResultFlushManager = {
    flushPendingToolResults?: (() => void) | undefined;
};
export declare const DEFAULT_WAIT_FOR_IDLE_TIMEOUT_MS = 30000;
export declare function flushPendingToolResultsAfterIdle(opts: {
    agent: IdleAwareAgent | null | undefined;
    sessionManager: ToolResultFlushManager | null | undefined;
    timeoutMs?: number;
}): Promise<void>;
export {};
