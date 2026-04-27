import type { SubscribeEmbeddedPiSessionParams } from "../../pi-embedded-subscribe.types.js";
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
        clearPendingOnTimeout?: boolean;
    }) => Promise<void>;
    session?: {
        agent?: unknown;
        dispose(): void;
    };
    sessionManager: unknown;
    releaseWsSession: (sessionId: string, options?: {
        allowPool?: boolean;
    }) => void;
    allowWsSessionPool?: boolean;
    sessionId: string;
    bundleMcpRuntime?: {
        dispose(): Promise<void> | void;
    };
    bundleLspRuntime?: {
        dispose(): Promise<void> | void;
    };
    sessionLock: {
        release(): Promise<void> | void;
    };
}): Promise<void>;
export {};
