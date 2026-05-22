import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type { EmbeddedRunLivenessState } from "./pi-embedded-runner/types.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
export type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
export declare function subscribeEmbeddedPiSession(params: SubscribeEmbeddedPiSessionParams): {
    assistantTexts: string[];
    toolMetas: {
        toolName?: string;
        meta?: string;
    }[];
    unsubscribe: () => void;
    setTerminalLifecycleMeta: (meta: {
        replayInvalid?: boolean;
        livenessState?: EmbeddedRunLivenessState;
        stopReason?: string;
        yielded?: boolean;
    }) => void;
    isCompacting: () => boolean;
    isCompactionInFlight: () => boolean;
    getMessagingToolSentTexts: () => string[];
    getMessagingToolSentMediaUrls: () => string[];
    getMessagingToolSentTargets: () => import("openclaw/plugin-sdk/agent-harness-runtime").MessagingToolSend[];
    getHeartbeatToolResponse: () => {
        outcome: "blocked" | "done" | "needs_attention" | "no_change" | "progress";
        notify: boolean;
        summary: string;
        notificationText?: string;
        reason?: string;
        priority?: "high" | "low" | "normal";
        nextCheck?: string;
    } | undefined;
    getPendingToolMediaReply: () => BlockReplyPayload | null;
    getSuccessfulCronAdds: () => number;
    getReplayState: () => {
        replayInvalid: boolean;
        hadPotentialSideEffects: boolean;
    };
    didSendViaMessagingTool: () => boolean;
    didSendDeterministicApprovalPrompt: () => boolean;
    getLastToolError: () => {
        toolName: string;
        meta?: string;
        error?: string;
        timedOut?: boolean;
        mutatingAction?: boolean;
        actionFingerprint?: string;
    } | undefined;
    getUsageTotals: () => {
        input: number | undefined;
        output: number | undefined;
        cacheRead: number | undefined;
        cacheWrite: number | undefined;
        total: number | undefined;
    } | undefined;
    getCompactionCount: () => number;
    getLastCompactionTokensAfter: () => number | undefined;
    getItemLifecycle: () => {
        startedCount: number;
        completedCount: number;
        activeCount: number;
    };
    waitForCompactionRetry: () => Promise<void>;
};
