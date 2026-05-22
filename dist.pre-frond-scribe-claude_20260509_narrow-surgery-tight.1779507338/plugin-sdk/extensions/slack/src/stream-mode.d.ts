import { type SlackLegacyDraftStreamMode, type StreamingMode } from "./streaming-compat.js";
type SlackStreamMode = SlackLegacyDraftStreamMode;
type SlackStreamingMode = StreamingMode;
export declare function resolveSlackStreamMode(raw: unknown): SlackStreamMode;
export declare function resolveSlackStreamingConfig(params: {
    streaming?: unknown;
    streamMode?: unknown;
    nativeStreaming?: unknown;
}): {
    mode: SlackStreamingMode;
    nativeStreaming: boolean;
    draftMode: SlackStreamMode;
};
export declare function applyAppendOnlyStreamUpdate(params: {
    incoming: string;
    rendered: string;
    source: string;
}): {
    rendered: string;
    source: string;
    changed: boolean;
};
export declare function buildStatusFinalPreviewText(updateCount: number): string;
export {};
