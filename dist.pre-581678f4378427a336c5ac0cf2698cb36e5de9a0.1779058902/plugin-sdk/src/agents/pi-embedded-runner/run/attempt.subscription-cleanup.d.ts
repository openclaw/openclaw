import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";
export declare const EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: number;
type IdleAwareAgent = {
    waitForIdle?: (() => Promise<void>) | undefined;
};
type ToolResultFlushManager = {
    flushPendingToolResults?: (() => void) | undefined;
    clearPendingToolResults?: (() => void) | undefined;
};
export declare function buildEmbeddedSubscriptionParams(params: SubscribeEmbeddedPiSessionParams): SubscribeEmbeddedPiSessionParams;
export declare function cleanupEmbeddedAttemptResources(params: {
    removeToolResultContextGuard?: () => void;
    flushPendingToolResultsAfterIdle: (params: {
        agent: IdleAwareAgent | null | undefined;
        sessionManager: ToolResultFlushManager | null | undefined;
        timeoutMs?: number;
    }) => Promise<void>;
    session?: {
        agent?: unknown;
        dispose(): void;
    };
    sessionManager: unknown;
    bundleMcpRuntime?: {
        dispose(): Promise<void> | void;
    };
    bundleLspRuntime?: {
        dispose(): Promise<void> | void;
    };
    sessionLock: {
        release(): Promise<void> | void;
    };
    aborted?: boolean;
    abortSettlePromise?: Promise<unknown> | null;
    skipSessionFlush?: boolean;
    runId?: string;
    sessionId?: string;
}): Promise<void>;
export {};
