import { B as StreamingMode, V as TextChunkMode, c as ChannelStreamingConfig, n as BlockStreamingChunkConfig, r as BlockStreamingCoalesceConfig, s as ChannelStreamingCommandTextMode, u as ChannelStreamingProgressConfig } from "./types.base-DCoxbfrn.js";

//#region src/plugin-sdk/channel-streaming.d.ts
type StreamingCompatEntry = {
  streaming?: unknown;
  streamMode?: unknown;
  chunkMode?: unknown;
  blockStreaming?: unknown;
  draftChunk?: unknown;
  blockStreamingCoalesce?: unknown;
  nativeStreaming?: unknown;
};
declare const DEFAULT_PROGRESS_DRAFT_LABELS: readonly ["Thinking...", "Shelling...", "Scuttling...", "Clawing...", "Pinching...", "Molting...", "Bubbling...", "Tiding...", "Reefing...", "Cracking...", "Sifting...", "Brining...", "Nautiling...", "Krilling...", "Barnacling...", "Lobstering...", "Tidepooling...", "Pearling...", "Snapping...", "Surfacing..."];
declare const DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS = 5000;
declare function isChannelProgressDraftWorkToolName(name: string | null | undefined): boolean;
type ChannelProgressLineOptions = {
  markdown?: boolean;
  detailMode?: "explain" | "raw";
  commandText?: ChannelStreamingCommandTextMode;
};
type ChannelProgressDraftRenderMode = "text" | "rich";
type ChannelProgressDraftLineInput = {
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
type ChannelProgressDraftLineKind = ChannelProgressDraftLineInput["event"];
type ChannelProgressDraftLine = {
  kind: ChannelProgressDraftLineKind;
  text: string;
  label: string;
  icon?: string;
  detail?: string;
  status?: string;
  toolName?: string;
};
declare function formatChannelProgressDraftLine(input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): string | undefined;
declare function resolveChannelProgressDraftLineOptions(entry: StreamingCompatEntry | null | undefined, options?: ChannelProgressLineOptions): ChannelProgressLineOptions;
declare function buildChannelProgressDraftLineForEntry(entry: StreamingCompatEntry | null | undefined, input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): ChannelProgressDraftLine | undefined;
declare function formatChannelProgressDraftLineForEntry(entry: StreamingCompatEntry | null | undefined, input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): string | undefined;
declare function buildChannelProgressDraftLine(input: ChannelProgressDraftLineInput, options?: ChannelProgressLineOptions): ChannelProgressDraftLine | undefined;
declare function createChannelProgressDraftGate(params: {
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
declare function getChannelStreamingConfigObject(entry: StreamingCompatEntry | null | undefined): ChannelStreamingConfig | undefined;
declare function resolveChannelStreamingChunkMode(entry: StreamingCompatEntry | null | undefined): TextChunkMode | undefined;
declare function resolveChannelStreamingBlockEnabled(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
declare function resolveChannelStreamingBlockCoalesce(entry: StreamingCompatEntry | null | undefined): BlockStreamingCoalesceConfig | undefined;
declare function resolveChannelStreamingPreviewChunk(entry: StreamingCompatEntry | null | undefined): BlockStreamingChunkConfig | undefined;
declare function resolveChannelStreamingPreviewToolProgress(entry: StreamingCompatEntry | null | undefined, defaultValue?: boolean): boolean;
declare function resolveChannelStreamingPreviewCommandText(entry: StreamingCompatEntry | null | undefined, defaultValue?: ChannelStreamingCommandTextMode): ChannelStreamingCommandTextMode;
declare function resolveChannelStreamingSuppressDefaultToolProgressMessages(entry: StreamingCompatEntry | null | undefined, options?: {
  draftStreamActive?: boolean;
  previewToolProgressEnabled?: boolean;
  previewStreamingEnabled?: boolean;
}): boolean;
declare function resolveChannelStreamingNativeTransport(entry: StreamingCompatEntry | null | undefined): boolean | undefined;
declare function resolveChannelPreviewStreamMode(entry: StreamingCompatEntry | null | undefined, defaultMode: "off" | "partial"): StreamingMode;
declare function resolveChannelProgressDraftConfig(entry: StreamingCompatEntry | null | undefined): ChannelStreamingProgressConfig;
declare function resolveChannelProgressDraftLabel(params: {
  entry?: StreamingCompatEntry | null;
  seed?: string;
  random?: () => number;
}): string | undefined;
declare function resolveChannelProgressDraftMaxLines(entry: StreamingCompatEntry | null | undefined, defaultValue?: number): number;
declare function resolveChannelProgressDraftRender(entry: StreamingCompatEntry | null | undefined, defaultValue?: ChannelProgressDraftRenderMode): ChannelProgressDraftRenderMode;
declare function formatChannelProgressDraftText(params: {
  entry?: StreamingCompatEntry | null;
  lines: Array<string | ChannelProgressDraftLine>;
  seed?: string;
  random?: () => number;
  formatLine?: (line: string) => string;
  bullet?: string;
}): string;
//#endregion
export { resolveChannelStreamingBlockEnabled as C, resolveChannelStreamingPreviewCommandText as D, resolveChannelStreamingPreviewChunk as E, resolveChannelStreamingPreviewToolProgress as O, resolveChannelStreamingBlockCoalesce as S, resolveChannelStreamingNativeTransport as T, resolveChannelProgressDraftConfig as _, ChannelProgressLineOptions as a, resolveChannelProgressDraftMaxLines as b, buildChannelProgressDraftLine as c, formatChannelProgressDraftLine as d, formatChannelProgressDraftLineForEntry as f, resolveChannelPreviewStreamMode as g, isChannelProgressDraftWorkToolName as h, ChannelProgressDraftRenderMode as i, resolveChannelStreamingSuppressDefaultToolProgressMessages as k, buildChannelProgressDraftLineForEntry as l, getChannelStreamingConfigObject as m, ChannelProgressDraftLineInput as n, DEFAULT_PROGRESS_DRAFT_INITIAL_DELAY_MS as o, formatChannelProgressDraftText as p, ChannelProgressDraftLineKind as r, DEFAULT_PROGRESS_DRAFT_LABELS as s, ChannelProgressDraftLine as t, createChannelProgressDraftGate as u, resolveChannelProgressDraftLabel as v, resolveChannelStreamingChunkMode as w, resolveChannelProgressDraftRender as x, resolveChannelProgressDraftLineOptions as y };