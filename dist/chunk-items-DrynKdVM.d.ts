import { S as MarkdownTableMode } from "./types.base-DS--yneR.js";

//#region src/markdown/ir.d.ts
type MarkdownStyle = "bold" | "italic" | "strikethrough" | "code" | "code_block" | "spoiler" | "blockquote";
type MarkdownStyleSpan = {
  start: number;
  end: number;
  style: MarkdownStyle;
  language?: string;
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
  open: string | ((span: MarkdownStyleSpan) => string);
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
export { MarkdownTableData as A, RenderedMarkdownChunk as C, MarkdownParseOptions as D, MarkdownLinkSpan as E, sliceMarkdownIR as F, chunkMarkdownIR as M, markdownToIR as N, MarkdownStyle as O, markdownToIRWithMeta as P, RenderMarkdownIRChunksWithinLimitOptions as S, MarkdownIR as T, RenderLink as _, sanitizeReplyDirectiveId as a, RenderStyleMarker as b, stripInlineDirectiveTagsFromMessageForDisplay as c, ReasoningTagTrim as d, hasOrphanReasoningCloseBoundary as f, isInsideCode as g, findCodeRegions as h, parseInlineDirectives as i, MarkdownTableMeta as j, MarkdownStyleSpan as k, stripMarkdown as l, CodeRegion as m, DisplayMessageWithContent as n, stripInlineDirectiveTagsForDelivery as o, stripReasoningTagsFromText as p, InlineDirectiveParseResult as r, stripInlineDirectiveTagsForDisplay as s, chunkItems as t, ReasoningTagMode as u, RenderOptions as v, renderMarkdownIRChunksWithinLimit as w, renderMarkdownWithMarkers as x, RenderStyleMap as y };