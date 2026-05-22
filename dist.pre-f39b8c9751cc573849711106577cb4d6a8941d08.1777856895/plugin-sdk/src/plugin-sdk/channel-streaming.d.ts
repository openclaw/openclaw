import type { BlockStreamingChunkConfig, BlockStreamingCoalesceConfig, ChannelStreamingConfig, TextChunkMode } from "../config/types.base.js";
export type { ChannelDeliveryStreamingConfig, ChannelPreviewStreamingConfig, ChannelStreamingBlockConfig, ChannelStreamingConfig, ChannelStreamingPreviewConfig, SlackChannelStreamingConfig, StreamingMode, TextChunkMode, } from "../config/types.base.js";
type StreamingCompatEntry = {
    streaming?: unknown;
    streamMode?: unknown;
    chunkMode?: unknown;
    blockStreaming?: unknown;
    draftChunk?: unknown;
    blockStreamingCoalesce?: unknown;
    nativeStreaming?: unknown;
};
export declare function getChannelStreamingConfigObject(entry: StreamingCompatEntry | null | undefined): ChannelStreamingConfig | undefined;
export declare function resolveChannelStreamingChunkMode(entry: StreamingCompatEntry | null | undefined): TextChunkMode | undefined;
export declare function resolveChannelStreamingBlockEnabled(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
export declare function resolveChannelStreamingBlockCoalesce(entry: StreamingCompatEntry | null | undefined): BlockStreamingCoalesceConfig | undefined;
export declare function resolveChannelStreamingPreviewChunk(entry: StreamingCompatEntry | null | undefined): BlockStreamingChunkConfig | undefined;
export declare function resolveChannelStreamingPreviewToolProgress(entry: StreamingCompatEntry | null | undefined, defaultValue?: boolean): boolean;
export declare function resolveChannelStreamingNativeTransport(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
export declare function resolveChannelPreviewStreamMode(entry: StreamingCompatEntry | null | undefined, defaultMode: "off" | "partial"): "off" | "partial" | "block";
