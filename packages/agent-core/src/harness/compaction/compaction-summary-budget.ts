import { estimateStringTokenPressure } from "@openclaw/normalization-core/cjk-chars";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CompactionError, err, ok, type Result } from "../types.js";

// Persisted summaries replay on every later request, so their owner enforces
// this provider-independent default unless the operator chooses another ceiling.
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

/**
 * The foreground token budget is the room the compacted request leaves before the output
 * reserve, which is where automatic compaction triggers. An artifact that fills it puts the next
 * turn over again, so summaries target half of it.
 */
export function compactionSummaryTargetTokens(tokenBudget: number | undefined) {
  return tokenBudget === undefined ? undefined : Math.floor(tokenBudget / 2);
}

/**
 * Let each summary owner preserve its structure before checking the foreground token budget.
 * The summary uses the second half of the budget only when its required parts cannot fit in the
 * target.
 */
export function fitCompactionSummary<T extends { summary: string }>(
  tokenBudget: number | undefined,
  render: (maxChars: number) => T | undefined,
  maxChars = MAX_COMPACTION_SUMMARY_CHARS,
): Result<T, CompactionError> {
  const fitted =
    largestFittingSummary(compactionSummaryTargetTokens(tokenBudget), render, maxChars) ??
    (tokenBudget === undefined ? undefined : largestFittingSummary(tokenBudget, render, maxChars));
  return fitted
    ? ok(fitted)
    : err(
        new CompactionError(
          "summarization_failed",
          "The compaction summary cannot fit beside the foreground prompt and retained history.",
        ),
      );
}

/** The largest rendering within the token budget, or undefined when none fits. */
export function largestFittingSummary<T extends { summary: string }>(
  tokenBudget: number | undefined,
  render: (maxChars: number) => T | undefined,
  maxChars: number,
): T | undefined {
  const fits = (candidate: T) =>
    tokenBudget === undefined || estimateStringTokenPressure(candidate.summary) <= tokenBudget;
  const full = render(maxChars);
  if (full && fits(full)) {
    return full;
  }
  let low = 1;
  let high = maxChars - 1;
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
  return fitted;
}
