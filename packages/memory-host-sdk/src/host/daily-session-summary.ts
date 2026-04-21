export const SESSION_SUMMARY_DAILY_MEMORY_SENTINEL = "<!-- openclaw:session-memory-summary -->";

const LEGACY_SESSION_SUMMARY_HEADER_RE =
  /^# Session: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?: [A-Za-z0-9_+\-/:]+)?$/m;
const LEGACY_SESSION_SUMMARY_REQUIRED_MARKERS = [
  "- **Session Key**:",
  "- **Session ID**:",
  "- **Source**:",
] as const;
const LEGACY_SESSION_SUMMARY_GENERATED_SESSION_KEY_RE = /^- \*\*Session Key\*\*: .+:.+$/m;
const LEGACY_SESSION_SUMMARY_NON_NOTES_SOURCE_RE = /^- \*\*Source\*\*: (?!notes\b)\S+/im;
const LEGACY_SESSION_SUMMARY_CONVERSATION_BLOCK_RE = /(?:^|\n)## Conversation Summary(?:\n|$)/;
const LEGACY_SESSION_SUMMARY_TRANSCRIPT_LINE_RE = /^(?:assistant|user|system):\s+\S/m;

function isLegacySessionSummaryDailyMemory(raw: string): boolean {
  if (!LEGACY_SESSION_SUMMARY_HEADER_RE.test(raw)) {
    return false;
  }
  // Older pre-sentinel session-memory notes sometimes omitted the conversation block when
  // transcript recovery failed, but they still retained the structured session metadata.
  if (!LEGACY_SESSION_SUMMARY_REQUIRED_MARKERS.every((marker) => raw.includes(marker))) {
    return false;
  }
  if (
    LEGACY_SESSION_SUMMARY_CONVERSATION_BLOCK_RE.test(raw) ||
    LEGACY_SESSION_SUMMARY_TRANSCRIPT_LINE_RE.test(raw)
  ) {
    return true;
  }
  return (
    LEGACY_SESSION_SUMMARY_GENERATED_SESSION_KEY_RE.test(raw) &&
    LEGACY_SESSION_SUMMARY_NON_NOTES_SOURCE_RE.test(raw)
  );
}

export function isSessionSummaryDailyMemory(raw: string): boolean {
  return (
    raw.includes(SESSION_SUMMARY_DAILY_MEMORY_SENTINEL) || isLegacySessionSummaryDailyMemory(raw)
  );
}
