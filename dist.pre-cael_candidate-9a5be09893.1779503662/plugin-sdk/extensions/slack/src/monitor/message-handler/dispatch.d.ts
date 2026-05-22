import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { PreparedSlackMessage } from "./types.js";
export declare function isSlackStreamingEnabled(params: {
    mode: "off" | "partial" | "block" | "progress";
    nativeStreaming: boolean;
}): boolean;
export declare function shouldEnableSlackPreviewStreaming(params: {
    mode: "off" | "partial" | "block" | "progress";
}): boolean;
export declare function shouldInitializeSlackDraftStream(params: {
    previewStreamingEnabled: boolean;
    useStreaming: boolean;
}): boolean;
export declare function resolveSlackDisableBlockStreaming(params: {
    useStreaming: boolean;
    shouldUseDraftStream: boolean;
    blockStreamingEnabled: boolean | undefined;
}): boolean | undefined;
export declare function resolveSlackStreamingThreadHint(params: {
    replyToMode: "off" | "first" | "all" | "batched";
    incomingThreadTs: string | undefined;
    messageTs: string | undefined;
    isThreadReply?: boolean;
}): string | undefined;
type SlackEventDeliveryAttempt = {
    kind: ReplyDispatchKind;
    payload: ReplyPayload;
    threadTs?: string;
    textOverride?: string;
};
export declare function resetSlackStreamRecipientTeamCacheForTests(): void;
export declare function createSlackEventDeliveryTracker(): {
    hasDelivered(params: SlackEventDeliveryAttempt): boolean;
    markDelivered(params: SlackEventDeliveryAttempt): void;
};
export declare function resolveSlackStreamRecipientTeamId(params: {
    client: Pick<PreparedSlackMessage["ctx"]["app"]["client"], "users">;
    token: string;
    userId?: PreparedSlackMessage["message"]["user"];
    fallbackTeamId?: string;
}): Promise<string | undefined>;
export declare function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage): Promise<void>;
export {};
