type IdleAwareAgent = {
    waitForIdle?: (() => Promise<void>) | undefined;
};
type ToolResultFlushManager = {
    flushPendingToolResults?: (() => void) | undefined;
    clearPendingToolResults?: (() => void) | undefined;
};
export declare function flushPendingToolResultsAfterIdle(opts: {
    agent: IdleAwareAgent | null | undefined;
    sessionManager: ToolResultFlushManager | null | undefined;
    timeoutMs?: number;
    clearPendingOnTimeout?: boolean;
}): Promise<void>;
export {};
