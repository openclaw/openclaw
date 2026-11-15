import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

// Covers truncation and elision markers for any UTF-16 length.
export const ELISION_MARKER_RESERVE_CHARS = 64;
const IMPORTANT_TOOL_RESULT_TAIL =
  /(error|exception|failed|fatal|traceback|panic|stack trace|errno|exit code)/i;

export function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const tailChars = Math.min(Math.floor(maxChars * 0.3), 600);
  const diagnosticSearch = sliceUtf16Safe(text, -maxChars);
  const diagnosticMatches = [
    ...diagnosticSearch.matchAll(new RegExp(IMPORTANT_TOOL_RESULT_TAIL.source, "gi")),
  ];
  const diagnosticMatch =
    diagnosticMatches.findLast((match) =>
      /^(error|exception|fatal|panic|errno)$/i.test(match[0]),
    ) ?? diagnosticMatches.at(-1);
  if (diagnosticMatch) {
    const head = truncateUtf16Safe(text, maxChars - tailChars);
    const displacedHead = sliceUtf16Safe(text, Math.max(0, head.length - 32), maxChars);
    // A routine footer can match failure words. Never shorten the original
    // retained head when doing so would discard an existing diagnostic.
    if (!IMPORTANT_TOOL_RESULT_TAIL.test(displacedHead)) {
      const diagnosticOffset = text.length - diagnosticSearch.length + (diagnosticMatch.index ?? 0);
      const tailStart = Math.min(diagnosticOffset, text.length - tailChars);
      // An early diagnostic already lives in the retained prefix; reusing it
      // as a tail would overlap the head and miscount omitted characters.
      if (tailStart >= head.length) {
        const tail = sliceUtf16Safe(text, tailStart, tailStart + tailChars);
        const truncatedChars = text.length - head.length - tail.length;
        const omissionPosition = tailStart + tail.length < text.length ? "middle/trailing" : "more";
        // Commands usually report their actual failure last; preserve that tail
        // so branch and ordinary compaction summaries can explain what failed.
        return `${head}\n\n[... ${truncatedChars} ${omissionPosition} characters truncated]\n\n${tail}`;
      }
    }
  }
  const headBudget = maxChars - tailChars - ELISION_MARKER_RESERVE_CHARS;
  const prefix = truncateUtf16Safe(text, maxChars);
  // Preserve diagnostics the old prefix already held; ordinary results also
  // need their terminal facts, with the marker inside the same budget.
  const tail = IMPORTANT_TOOL_RESULT_TAIL.test(prefix) ? "" : sliceUtf16Safe(text, -tailChars);
  const head = tail ? truncateUtf16Safe(prefix, headBudget) : prefix;
  const truncatedChars = text.length - head.length - tail.length;
  return `${head}\n\n[... ${truncatedChars} more characters truncated]${tail ? `\n\n${tail}` : ""}`;
}
