/**
 * Configurable bound for a persisted compaction summary.
 *
 * Persisted summaries replay on every later request, so their owner enforces
 * this provider-independent hard bound. Operators can raise it for long-context
 * models via compaction settings; the default stays 16K. The foreground
 * token-budget check in `fitCompactionSummary` remains the safety net for
 * large values.
 */
import { estimateStringTokenPressure } from "@openclaw/normalization-core/cjk-chars";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { CompactionError, err, ok, type Result } from "../types.js";

export const MAX_COMPACTION_SUMMARY_CHARS = 16_000;
export const DEFAULT_COMPACTION_SUMMARY_CHARS = MAX_COMPACTION_SUMMARY_CHARS;
export const MIN_COMPACTION_SUMMARY_CHARS = 1_000;
export const MAX_COMPACTION_SUMMARY_CHARS_CAP = 200_000;

export const SUMMARY_TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";

/**
 * Resolve a configured summary char cap to a valid bound. Non-finite or
 * non-positive values fall back to the default; finite values are floored and
 * clamped to the supported range so a misconfigured value cannot disable the
 * cap or overflow the foreground window.
 */
export function resolveCompactionSummaryMaxChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_COMPACTION_SUMMARY_CHARS;
  }
  return Math.min(
    MAX_COMPACTION_SUMMARY_CHARS_CAP,
    Math.max(MIN_COMPACTION_SUMMARY_CHARS, Math.floor(value)),
  );
}

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
  maxSummaryChars: number = MAX_COMPACTION_SUMMARY_CHARS,
): Result<T, CompactionError> {
  const resolvedMaxChars = resolveCompactionSummaryMaxChars(maxSummaryChars);
  const fits = (candidate: T) =>
    tokenBudget === undefined || estimateStringTokenPressure(candidate.summary) <= tokenBudget;
  const full = render(resolvedMaxChars);
  if (full && fits(full)) {
    return ok(full);
  }
  let low = 1;
  let high = resolvedMaxChars - 1;
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
