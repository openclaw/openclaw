import { i as OpenClawConfig } from "./types.openclaw-CoVv5VQR.js";
import { S as MarkdownTableMode } from "./types.base-CN1BlTRP.js";
import { U as DiagnosticSessionActiveWorkKind, b as DiagnosticLivenessWarningReason, w as DiagnosticMemoryUsage } from "./diagnostic-events-vESIWy0l.js";
import { n as RuntimeEnv } from "./runtime-lEKWbTQa.js";
import { t as SubsystemLogger } from "./subsystem-DzIJaqs3.js";
//#region src/logger.d.ts
declare function logInfo(message: string, runtime?: RuntimeEnv): void;
declare function logWarn(message: string, runtime?: RuntimeEnv): void;
declare function logSuccess(message: string, runtime?: RuntimeEnv): void;
declare function logError(message: string, runtime?: RuntimeEnv): void;
declare function logDebug(message: string): void;
//#endregion
//#region src/logging/diagnostic-memory.d.ts
type DiagnosticMemoryThresholds = {
  rssWarningBytes?: number;
  rssCriticalBytes?: number;
  heapUsedWarningBytes?: number;
  heapUsedCriticalBytes?: number;
  rssGrowthWarningBytes?: number;
  rssGrowthCriticalBytes?: number;
  growthWindowMs?: number;
  pressureRepeatMs?: number;
};
declare function emitDiagnosticMemorySample(options?: {
  now?: number;
  memoryUsage?: NodeJS.MemoryUsage;
  uptimeMs?: number;
  thresholds?: DiagnosticMemoryThresholds;
  emitSample?: boolean;
}): DiagnosticMemoryUsage;
//#endregion
//#region src/logging/diagnostic-session-attention.d.ts
type SessionAttentionClassification = {
  eventType: "session.long_running";
  reason: string;
  classification: "long_running";
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  recoveryEligible: false;
} | {
  eventType: "session.stalled";
  reason: string;
  classification: "blocked_tool_call" | "stalled_agent_run";
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
  recoveryEligible: false;
} | {
  eventType: "session.stuck";
  reason: string;
  classification: "stale_session_state";
  activeWorkKind?: undefined;
  recoveryEligible: true;
};
//#endregion
//#region src/logging/diagnostic-session-recovery.d.ts
type DiagnosticSessionRecoverySkipReason = "active_embedded_run" | "active_reply_work" | "active_lane_task" | "already_in_flight" | "missing_session_ref" | "stale_session_state";
type DiagnosticSessionRecoveryNoopReason = "no_active_work";
type StuckSessionRecoveryRequest = {
  sessionId?: string;
  sessionKey?: string;
  ageMs: number;
  queueDepth?: number;
  allowActiveAbort?: boolean;
  stateGeneration?: number;
};
type DiagnosticSessionRecoveryBaseOutcome = {
  sessionId?: string;
  sessionKey?: string;
  activeSessionId?: string;
  lane?: string;
  activeWorkKind?: DiagnosticSessionActiveWorkKind;
};
type StuckSessionRecoveryOutcome = (DiagnosticSessionRecoveryBaseOutcome & {
  status: "aborted";
  action: "abort_embedded_run";
  aborted: boolean;
  drained: boolean;
  forceCleared: boolean;
  released: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "released";
  action: "release_lane";
  released: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "skipped";
  action: "observe_only" | "keep_lane";
  reason: DiagnosticSessionRecoverySkipReason;
  activeCount?: number;
  queuedCount?: number;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "noop";
  action: "none";
  reason: DiagnosticSessionRecoveryNoopReason;
}) | (DiagnosticSessionRecoveryBaseOutcome & {
  status: "failed";
  action: "none";
  reason: "exception";
  error: string;
});
//#endregion
//#region src/logging/diagnostic-session-recovery-coordinator.d.ts
type RecoverStuckSession = (params: StuckSessionRecoveryRequest) => void | StuckSessionRecoveryOutcome | Promise<void | StuckSessionRecoveryOutcome>;
//#endregion
//#region src/logging/diagnostic-session-state.d.ts
type SessionStateValue = "idle" | "processing" | "waiting";
type SessionRef = {
  sessionId?: string;
  sessionKey?: string;
};
//#endregion
//#region src/logging/diagnostic-runtime.d.ts
declare const diagnosticLogger: SubsystemLogger;
declare function logLaneEnqueue(lane: string, queueSize: number): void;
declare function logLaneDequeue(lane: string, waitMs: number, queueSize: number): void;
//#endregion
//#region src/logging/diagnostic.d.ts
type EmitDiagnosticMemorySample = typeof emitDiagnosticMemorySample;
type DiagnosticWorkSnapshot = {
  activeCount: number;
  waitingCount: number;
  queuedCount: number;
  activeLabels: string[];
  waitingLabels: string[];
  queuedLabels: string[];
};
type DiagnosticLivenessSample = {
  reasons: DiagnosticLivenessWarningReason[];
  intervalMs: number;
  eventLoopDelayP99Ms?: number;
  eventLoopDelayMaxMs?: number;
  eventLoopUtilization?: number;
  cpuUserMs?: number;
  cpuSystemMs?: number;
  cpuTotalMs?: number;
  cpuCoreRatio?: number;
};
type SampleDiagnosticLiveness = (now: number, work: DiagnosticWorkSnapshot) => DiagnosticLivenessSample | null;
type StartDiagnosticHeartbeatOptions = {
  getConfig?: () => OpenClawConfig;
  emitMemorySample?: EmitDiagnosticMemorySample;
  sampleLiveness?: SampleDiagnosticLiveness;
  recoverStuckSession?: RecoverStuckSession;
};
declare function resolveStuckSessionWarnMs(config?: OpenClawConfig): number;
declare function resolveStuckSessionAbortMs(config: OpenClawConfig | undefined, stuckSessionWarnMs: number): number;
declare function logWebhookReceived(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
}): void;
declare function logWebhookProcessed(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  durationMs?: number;
}): void;
declare function logWebhookError(params: {
  channel: string;
  updateType?: string;
  chatId?: number | string;
  error: string;
}): void;
declare function logMessageQueued(params: {
  sessionId?: string;
  sessionKey?: string;
  channel?: string;
  source: string;
}): void;
declare function logMessageProcessed(params: {
  channel: string;
  messageId?: number | string;
  chatId?: number | string;
  sessionId?: string;
  sessionKey?: string;
  durationMs?: number;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
  error?: string;
}): void;
declare function logSessionStateChange(params: SessionRef & {
  state: SessionStateValue;
  reason?: string;
}): void;
declare function markDiagnosticSessionProgress(params: SessionRef): void;
declare function logSessionAttention(params: SessionRef & {
  state: SessionStateValue;
  ageMs: number;
  thresholdMs: number;
  abortThresholdMs?: number;
}): SessionAttentionClassification | undefined;
declare function logRunAttempt(params: SessionRef & {
  runId: string;
  attempt: number;
}): void;
declare function logToolLoopAction(params: SessionRef & {
  toolName: string;
  level: "warning" | "critical";
  action: "warn" | "block";
  detector: "generic_repeat" | "unknown_tool_repeat" | "known_poll_no_progress" | "global_circuit_breaker" | "ping_pong";
  count: number;
  message: string;
  pairedToolName?: string;
}): void;
declare function logActiveRuns(): void;
declare function startDiagnosticHeartbeat(config?: OpenClawConfig, opts?: StartDiagnosticHeartbeatOptions): void;
declare function stopDiagnosticHeartbeat(): void;
declare function getDiagnosticSessionStateCountForTest(): number;
declare function resetDiagnosticStateForTest(): void;
//#endregion
//#region src/markdown/ir.d.ts
type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block" | "spoiler" | "blockquote";
type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
};
type MarkdownLinkSpan = {
  start: number;
  end: number;
  href: string;
};
type MarkdownIR = {
  text: string;
  styles: MarkdownStyleSpan[];
  links: MarkdownLinkSpan[];
};
type MarkdownTableData = {
  headers: string[];
  rows: string[][];
};
type MarkdownTableMeta = MarkdownTableData & {
  placeholderOffset: number;
};
type MarkdownParseOptions = {
  linkify?: boolean;
  enableSpoilers?: boolean;
  headingStyle?: "none" | "bold";
  blockquotePrefix?: string;
  autolink?: boolean; /** How to render tables (off|bullets|code|block). Default: off. */
  tableMode?: MarkdownTableMode;
};
declare function sliceMarkdownIR(ir: MarkdownIR, start: number, end: number): MarkdownIR;
declare function markdownToIR(markdown: string, options?: MarkdownParseOptions): MarkdownIR;
declare function markdownToIRWithMeta(markdown: string, options?: MarkdownParseOptions): {
  ir: MarkdownIR;
  hasTables: boolean;
  tables: MarkdownTableMeta[];
};
declare function chunkMarkdownIR(ir: MarkdownIR, limit: number): MarkdownIR[];
//#endregion
//#region src/markdown/render-aware-chunking.d.ts
type RenderedMarkdownChunk<TRendered> = {
  rendered: TRendered;
  source: MarkdownIR;
};
type RenderMarkdownIRChunksWithinLimitOptions<TRendered> = {
  ir: MarkdownIR;
  limit: number;
  measureRendered: (rendered: TRendered) => number;
  renderChunk: (ir: MarkdownIR) => TRendered;
};
declare function renderMarkdownIRChunksWithinLimit<TRendered>(options: RenderMarkdownIRChunksWithinLimitOptions<TRendered>): RenderedMarkdownChunk<TRendered>[];
//#endregion
//#region src/markdown/render.d.ts
type RenderStyleMarker = {
  open: string;
  close: string;
};
type RenderStyleMap = Partial<Record<MarkdownStyle, RenderStyleMarker>>;
type RenderLink = {
  start: number;
  end: number;
  open: string;
  close: string;
};
type RenderOptions = {
  styleMarkers: RenderStyleMap;
  escapeText: (text: string) => string;
  buildLink?: (link: MarkdownLinkSpan, text: string) => RenderLink | null;
};
declare function renderMarkdownWithMarkers(ir: MarkdownIR, options: RenderOptions): string;
//#endregion
//#region src/shared/record-coerce.d.ts
declare function asRecord(value: unknown): Record<string, unknown>;
declare function readStringField(record: Record<string, unknown> | null | undefined, key: string): string | undefined;
declare function asOptionalRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableRecord(value: unknown): Record<string, unknown> | null;
declare function asOptionalObjectRecord(value: unknown): Record<string, unknown> | undefined;
declare function asNullableObjectRecord(value: unknown): Record<string, unknown> | null;
//#endregion
//#region src/shared/string-sample.d.ts
declare function summarizeStringEntries(params: {
  entries?: ReadonlyArray<string> | null;
  limit?: number;
  emptyText?: string;
}): string;
//#endregion
//#region src/shared/text/code-regions.d.ts
interface CodeRegion {
  start: number;
  end: number;
}
declare function findCodeRegions(text: string): CodeRegion[];
declare function isInsideCode(pos: number, regions: CodeRegion[]): boolean;
//#endregion
//#region src/shared/text/reasoning-tags.d.ts
type ReasoningTagMode = "strict" | "preserve";
type ReasoningTagTrim = "none" | "start" | "both";
declare function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean;
declare function stripReasoningTagsFromText(text: string, options?: {
  mode?: ReasoningTagMode;
  trim?: ReasoningTagTrim;
}): string;
//#endregion
//#region src/shared/text/strip-markdown.d.ts
/**
 * Strip lightweight markdown formatting from text while preserving readable
 * plain-text structure for TTS and channel fallbacks.
 */
declare function stripMarkdown(text: string): string;
//#endregion
//#region src/utils/directive-tags.d.ts
type InlineDirectiveParseResult = {
  text: string;
  audioAsVoice: boolean;
  replyToId?: string;
  replyToExplicitId?: string;
  replyToCurrent: boolean;
  hasAudioTag: boolean;
  hasReplyTag: boolean;
};
type InlineDirectiveParseOptions = {
  currentMessageId?: string;
  stripAudioTag?: boolean;
  stripReplyTags?: boolean;
};
type StripInlineDirectiveTagsResult = {
  text: string;
  changed: boolean;
};
type DisplayMessageWithContent = {
  content?: unknown;
} & Record<string, unknown>;
declare function stripInlineDirectiveTagsForDisplay(text: string): StripInlineDirectiveTagsResult;
declare function sanitizeReplyDirectiveId(rawReplyToId?: string): string | undefined;
declare function stripInlineDirectiveTagsForDelivery(text: string): StripInlineDirectiveTagsResult;
/**
 * Strips inline directive tags from message text blocks while preserving message shape.
 * Empty post-strip text stays empty-string to preserve caller semantics.
 */
declare function stripInlineDirectiveTagsFromMessageForDisplay(message: DisplayMessageWithContent | undefined): DisplayMessageWithContent | undefined;
declare function parseInlineDirectives(text?: string, options?: InlineDirectiveParseOptions): InlineDirectiveParseResult;
//#endregion
//#region src/utils/chunk-items.d.ts
declare function chunkItems<T>(items: readonly T[], size: number): T[][];
//#endregion
export { logWebhookReceived as $, RenderedMarkdownChunk as A, markdownToIR as B, readStringField as C, RenderStyleMarker as D, RenderStyleMap as E, MarkdownStyle as F, logMessageProcessed as G, sliceMarkdownIR as H, MarkdownStyleSpan as I, logSessionAttention as J, logMessageQueued as K, MarkdownTableData as L, MarkdownIR as M, MarkdownLinkSpan as N, renderMarkdownWithMarkers as O, MarkdownParseOptions as P, logWebhookProcessed as Q, MarkdownTableMeta as R, asRecord as S, RenderOptions as T, getDiagnosticSessionStateCountForTest as U, markdownToIRWithMeta as V, logActiveRuns as W, logToolLoopAction as X, logSessionStateChange as Y, logWebhookError as Z, summarizeStringEntries as _, sanitizeReplyDirectiveId as a, stopDiagnosticHeartbeat as at, asOptionalObjectRecord as b, stripInlineDirectiveTagsFromMessageForDisplay as c, logLaneEnqueue as ct, ReasoningTagTrim as d, logInfo as dt, markDiagnosticSessionProgress as et, hasOrphanReasoningCloseBoundary as f, logSuccess as ft, isInsideCode as g, findCodeRegions as h, parseInlineDirectives as i, startDiagnosticHeartbeat as it, renderMarkdownIRChunksWithinLimit as j, RenderMarkdownIRChunksWithinLimitOptions as k, stripMarkdown as l, logDebug as lt, CodeRegion as m, DisplayMessageWithContent as n, resolveStuckSessionAbortMs as nt, stripInlineDirectiveTagsForDelivery as o, diagnosticLogger as ot, stripReasoningTagsFromText as p, logWarn as pt, logRunAttempt as q, InlineDirectiveParseResult as r, resolveStuckSessionWarnMs as rt, stripInlineDirectiveTagsForDisplay as s, logLaneDequeue as st, chunkItems as t, resetDiagnosticStateForTest as tt, ReasoningTagMode as u, logError as ut, asNullableObjectRecord as v, RenderLink as w, asOptionalRecord as x, asNullableRecord as y, chunkMarkdownIR as z };