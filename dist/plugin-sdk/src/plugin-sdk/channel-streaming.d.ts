import type { BlockStreamingChunkConfig, BlockStreamingCoalesceConfig, ChannelStreamingCommandTextMode, ChannelStreamingProgressConfig, ChannelStreamingConfig, StreamingMode, TextChunkMode } from "../config/types.base.js";
export type { ChannelDeliveryStreamingConfig, ChannelPreviewStreamingConfig, ChannelStreamingBlockConfig, ChannelStreamingCommandTextMode, ChannelStreamingConfig, ChannelStreamingProgressConfig, ChannelStreamingPreviewConfig, SlackChannelStreamingConfig, StreamingMode, TextChunkMode, } from "../config/types.base.js";
type StreamingCompatEntry = {
    streaming?: unknown;
    streamMode?: unknown;
    chunkMode?: unknown;
    blockStreaming?: unknown;
    draftChunk?: unknown;
    blockStreamingCoalesce?: unknown;
    nativeStreaming?: unknown;
};
export declare const DEFAULT_PROGRESS_DRAFT_LABELS: readonly ["Thinking...", "Shelling...", "Scuttling...", "Clawing...", "Pinching...", "Molting...", "Bubbling...", "Tiding...", "Reefing...", "Cracking...", "Sifting...", "Brining...", "Nautiling...", "Krilling...", "Barnacling...", "Lobstering...", "Tidepooling...", "Pearling...", "Snapping...", "Surfacing..."];
export declare const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 5000;
export declare function isChannelProgressDraftWorkToolName(name: string | null | undefined): boolean;
export type ChannelProgressLineOptions = {
    markdown?: boolean;
    detailMode?: "explain" | "raw";
    commandText?: ChannelStreamingCommandTextMode;
};
export type ChannelProgressDraftRenderMode = "text" | "rich";
export type ChannelProgressDraftLineInput = {
    event: "tool";
    name?: string;
    phase?: string;
    args?: Record<string, unknown>;
} | {
    event: "item";
    itemKind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
    summary?: string;
    progressText?: string;
    meta?: string;
} | {
    event: "plan";
    phase?: string;
    title?: string;
    explanation?: string;
    steps?: string[];
} | {
    event: "approval";
    phase?: string;
    title?: string;
    command?: string;
    reason?: string;
    message?: string;
} | {
    event: "command-output";
    phase?: string;
    title?: string;
    name?: string;
    status?: string;
    exitCode?: number | null;
} | {
    event: "patch";
    phase?: string;
    title?: string;
    name?: string;
    added?: string[];
    modified?: string[];
    deleted?: string[];
    summary?: string;
};
export type ChannelProgressDraftLineKind = ChannelProgressDraftLineInput["event"];
export type ChannelProgressDraftLine = {
    kind: ChannelProgressDraftLineKind;
    text: string;
    label: string;
    icon?: string;
    detail?: string;
    status?: string;
    toolName?: string;
};
export declare function formatChannelProgressDraftLine(input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): string | undefined;
export declare function resolveChannelProgressDraftLineOptions(entry: StreamingCompatEntry | null | undefined, options?: ChannelProgressLineOptions): ChannelProgressLineOptions;
export declare function buildChannelProgressDraftLineForEntry(entry: StreamingCompatEntry | null | undefined, input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): ChannelProgressDraftLine | undefined;
export declare function formatChannelProgressDraftLineForEntry(entry: StreamingCompatEntry | null | undefined, input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): string | undefined;
export declare function buildChannelProgressDraftLine(input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): ChannelProgressDraftLine | undefined;
export declare function createChannelProgressDraftGate(params: {
    onStart: () => void | Promise<void>;
    initialDelayMs?: number;
    setTimeoutFn?: typeof setTimeout;
    clearTimeoutFn?: typeof clearTimeout;
}): {
    readonly hasStarted: boolean;
    readonly workEvents: number;
    noteWork(): Promise<boolean>;
    startNow(): Promise<void>;
    cancel(): void;
};
export declare function getChannelStreamingConfigObject(entry: StreamingCompatEntry | null | undefined): ChannelStreamingConfig | undefined;
export declare function resolveChannelStreamingChunkMode(entry: StreamingCompatEntry | null | undefined): TextChunkMode | undefined;
export declare function resolveChannelStreamingBlockEnabled(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
export declare function resolveChannelStreamingBlockCoalesce(entry: StreamingCompatEntry | null | undefined): BlockStreamingCoalesceConfig | undefined;
export declare function resolveChannelStreamingPreviewChunk(entry: StreamingCompatEntry | null | undefined): BlockStreamingChunkConfig | undefined;
export declare function resolveChannelStreamingPreviewToolProgress(entry: StreamingCompatEntry | null | undefined, defaultValue?: boolean): boolean;
export declare function resolveChannelStreamingPreviewCommandText(entry: StreamingCompatEntry | null | undefined, defaultValue?: ChannelStreamingCommandTextMode): ChannelStreamingCommandTextMode;
export declare function resolveChannelStreamingSuppressDefaultToolProgressMessages(entry: StreamingCompatEntry | null | undefined, options?: {
    draftStreamActive?: boolean;
    previewToolProgressEnabled?: boolean;
    previewStreamingEnabled?: boolean;
}): boolean;
export declare function resolveChannelStreamingNativeTransport(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
export declare function resolveChannelPreviewStreamMode(entry: StreamingCompatEntry | null | undefined, defaultMode: "off" | "partial"): StreamingMode;
export declare function resolveChannelProgressDraftConfig(entry: StreamingCompatEntry | null | undefined): ChannelStreamingProgressConfig;
export declare function resolveChannelProgressDraftLabel(params: {
    entry?: StreamingCompatEntry | null;
    seed?: string;
    random?: () => number;
}): string | undefined;
export declare function resolveChannelProgressDraftMaxLines(entry: StreamingCompatEntry | null | undefined, defaultValue?: number): number;
export declare function resolveChannelProgressDraftRender(entry: StreamingCompatEntry | null | undefined, defaultValue?: ChannelProgressDraftRenderMode): ChannelProgressDraftRenderMode;
export declare function formatChannelProgressDraftText(params: {
    entry?: StreamingCompatEntry | null;
    lines: Array<string | ChannelProgressDraftLine>;
    seed?: string;
    random?: () => number;
    formatLine?: (line: string) => string;
    bullet?: string;
}): string;
