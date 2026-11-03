import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CompactionError, err, ok, type Result } from "../types.js";

// Persisted summaries replay on every later request, so their owner enforces
// this provider-independent 16K hard bound.
export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
export const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";

export function capCompactionSummary(
  summary: string,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
  preservedSuffix = "",
) {
  if (maxChars <= 0 || summary.length <= maxChars) {
    return summary;
  }
  const suffix = preservedSuffix && summary.endsWith(preservedSuffix) ? preservedSuffix : "";
  if (maxChars < SUMMARY_TRUNCATED_MARKER.length + suffix.length) {
    return truncateUtf16Safe(summary, maxChars);
  }
  const budget = maxChars - SUMMARY_TRUNCATED_MARKER.length - suffix.length;
  const prefix = suffix ? summary.slice(0, -suffix.length) : summary;
  return `${truncateUtf16Safe(prefix, budget)}${SUMMARY_TRUNCATED_MARKER}${suffix}`;
}

/** Let each summary owner preserve its structure before checking the foreground token budget. */
export function fitCompactionSummary<T extends { summary: string }>(
  tokenBudget: number | undefined,
  render: (maxChars: number) => T | undefined,
): Result<T, CompactionError> {
  const fits = (candidate: T) =>
    tokenBudget === undefined ||
    estimateStringChars(candidate.summary) / CHARS_PER_TOKEN_ESTIMATE <= tokenBudget;
  const full = render(MAX_COMPACTION_SUMMARY_CHARS);
  if (full && fits(full)) {
    return ok(full);
  }
  let low = 1;
  let high = MAX_COMPACTION_SUMMARY_CHARS - 1;
  let fitted: T | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = render(mid);
    if (!candidate) {
      low = mid + 1;
    } else if (fits(candidate)) {
      fitted = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return fitted
    ? ok(fitted)
    : err(
        new CompactionError(
          "summarization_failed",
          "The compaction summary cannot fit beside the foreground prompt and retained history.",
        ),
      );
}
