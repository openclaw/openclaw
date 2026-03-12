export type StreamingMode = "off" | "partial" | "block" | "progress";
export type DiscordPreviewStreamMode = "off" | "partial" | "block";
export type TelegramPreviewStreamMode = "off" | "partial" | "block";
export type SlackLegacyDraftStreamMode = "replace" | "status_final" | "append";
export declare function parseStreamingMode(value: unknown): StreamingMode | null;
export declare function parseDiscordPreviewStreamMode(value: unknown): DiscordPreviewStreamMode | null;
export declare function parseSlackLegacyDraftStreamMode(value: unknown): SlackLegacyDraftStreamMode | null;
export declare function mapSlackLegacyDraftStreamModeToStreaming(mode: SlackLegacyDraftStreamMode): StreamingMode;
export declare function mapStreamingModeToSlackLegacyDraftStreamMode(mode: StreamingMode): "replace" | "status_final" | "append";
export declare function resolveTelegramPreviewStreamMode(params?: {
    streamMode?: unknown;
    streaming?: unknown;
}): TelegramPreviewStreamMode;
export declare function resolveDiscordPreviewStreamMode(params?: {
    streamMode?: unknown;
    streaming?: unknown;
}): DiscordPreviewStreamMode;
export declare function resolveSlackStreamingMode(params?: {
    streamMode?: unknown;
    streaming?: unknown;
}): StreamingMode;
export declare function resolveSlackNativeStreaming(params?: {
    nativeStreaming?: unknown;
    streaming?: unknown;
}): boolean;
