import type { PreparedSlackMessage } from "./types.js";
export declare function isSlackStreamingEnabled(params: {
    mode: "off" | "partial" | "block" | "progress";
    nativeStreaming: boolean;
}): boolean;
export declare function resolveSlackStreamingThreadHint(params: {
    replyToMode: "off" | "first" | "all";
    incomingThreadTs: string | undefined;
    messageTs: string | undefined;
    isThreadReply?: boolean;
}): string | undefined;
export declare function shouldForceSlackDraftBoundary(params: {
    hasStreamedMessage: boolean;
    draftMode: "replace" | "status_final" | "append";
}): boolean;
export declare function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage): Promise<void>;
