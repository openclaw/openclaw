import type { BlockReplyPayload } from "./pi-embedded-payloads.js";
import type { EmbeddedRunLivenessState } from "./pi-embedded-runner/types.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
export type { BlockReplyChunking, SubscribeEmbeddedPiSessionParams, ToolResultFormat, } from "./pi-embedded-subscribe.types.js";
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
    }) => void;
    isCompacting: () => boolean;
    isCompactionInFlight: () => boolean;
    getMessagingToolSentTexts: () => string[];
    getMessagingToolSentMediaUrls: () => string[];
    getMessagingToolSentTargets: () => import("./pi-embedded-messaging.types.js").MessagingToolSend[];
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
    getItemLifecycle: () => {
        startedCount: number;
        completedCount: number;
        activeCount: number;
    };
    waitForCompactionRetry: () => Promise<void>;
};
