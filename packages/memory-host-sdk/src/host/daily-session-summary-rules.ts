import { parseDailyMemoryPathInfo } from "./daily-paths.js";

const SESSION_SUMMARY_SNIPPET_TRANSCRIPT_LINE_RE = /^(?:assistant|user|system):\s+\S/;
const LEGACY_SESSION_SUMMARY_TRANSCRIPT_START_LINE_MIN = 8;

export function normalizeSessionSummarySnippet(rawSnippet: string | undefined): string {
  return rawSnippet?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function hasExplicitSessionSummaryMetadataSnippetMarkers(snippet: string): boolean {
  return (
    hasStrongSessionSummaryMetadataSnippetMarkers(snippet) ||
    snippet.includes("## conversation summary")
  );
}

function hasStrongSessionSummaryMetadataSnippetMarkers(snippet: string): boolean {
  return (
    snippet.includes("# session:") ||
    /\bsession key\s*:/i.test(snippet) ||
    /\bsession id\s*:/i.test(snippet)
  );
}

function hasTranscriptLikeSessionSummarySnippet(snippet: string): boolean {
  return SESSION_SUMMARY_SNIPPET_TRANSCRIPT_LINE_RE.test(snippet);
}

export function isLikelySessionSummaryDailyMemorySnippet(snippet?: string): boolean {
  const normalizedSnippet = normalizeSessionSummarySnippet(snippet);
  return (
    hasExplicitSessionSummaryMetadataSnippetMarkers(normalizedSnippet) ||
    hasTranscriptLikeSessionSummarySnippet(normalizedSnippet)
  );
}

export function isLikelyMissingSessionSummaryDailyMemory(params: {
  filePath: string;
  snippet?: string;
  startLine?: number;
  hasSiblingVariantMatch?: boolean;
  rememberedSessionSummary?: boolean;
  allowLegacySemanticSlugTranscriptFallback?: boolean;
}): boolean {
  const parsed = parseDailyMemoryPathInfo(params.filePath);
  if (!parsed) {
    return false;
  }
  if (params.rememberedSessionSummary) {
    return true;
  }
  const snippet = normalizeSessionSummarySnippet(params.snippet);
  if (parsed.canonical) {
    return hasStrongSessionSummaryMetadataSnippetMarkers(snippet);
  }
  if (params.hasSiblingVariantMatch) {
    return false;
  }
  const startLine = Math.max(1, Math.floor(params.startLine ?? 0));
  const hasLegacySemanticSlugTranscriptFallback =
    params.allowLegacySemanticSlugTranscriptFallback === true &&
    startLine >= LEGACY_SESSION_SUMMARY_TRANSCRIPT_START_LINE_MIN &&
    hasTranscriptLikeSessionSummarySnippet(snippet);
  return (
    hasStrongSessionSummaryMetadataSnippetMarkers(snippet) ||
    hasLegacySemanticSlugTranscriptFallback
  );
}
