export type StreamingMode = "off" | "partial" | "block" | "progress";
export type SlackLegacyDraftStreamMode = "replace" | "status_final" | "append";
export declare function mapStreamingModeToSlackLegacyDraftStreamMode(mode: StreamingMode): "append" | "replace" | "status_final";
export declare function resolveSlackStreamingMode(params?: {
    streamMode?: unknown;
    streaming?: unknown;
}): StreamingMode;
export declare function resolveSlackNativeStreaming(params?: {
    nativeStreaming?: unknown;
    streaming?: unknown;
}): boolean;
