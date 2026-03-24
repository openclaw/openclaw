import type { PreparedSlackMessage } from "./types.js";
export declare function isSlackStreamingEnabled(params: {
    mode: "off" | "partial" | "block" | "progress";
    nativeStreaming: boolean;
}): boolean;
/**
 * Resolves Slack reply streaming behavior from normalized channel policy.
 * Incident-root-only channels disable previews, native partial streaming, and
 * progress acks so no partial reasoning leaks into incident threads.
 */
export declare function resolveSlackReplyStreamingPolicy(params: {
    mode: "off" | "partial" | "block" | "progress";
    nativeStreaming: boolean;
    incidentRootOnly?: boolean;
}): {
    previewStreamingEnabled: boolean;
    streamingEnabled: boolean;
    sendProgressAck: boolean;
};
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
