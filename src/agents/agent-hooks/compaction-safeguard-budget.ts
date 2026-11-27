/** Fits a generated summary body and its suffix sections into one bounded compaction artifact. */

import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  capCompactionSummary,
  SUMMARY_TRUNCATED_MARKER,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { createSummaryQualityRetentionPlan } from "./compaction-safeguard-quality.js";

export const CONTEXT_TRUNCATED_MARKER =
  "\n\n[Earlier compaction context truncated to fit budget]\n\n";

export type CompactionSuffix = {
  text: string;
  // Keep producer segment boundaries after later suffix sections are appended;
  // otherwise the final tail cap can split an assistant tool-call/result group.
  contextRanges: Array<{ start: number; end: number; segmentStarts: number[] }>;
};

export type SummaryQualityRetention = Parameters<typeof createSummaryQualityRetentionPlan>[2];

function resolveSuffixTailStart(suffix: CompactionSuffix, tailBudget: number): number {
  const desiredStart = Math.max(0, suffix.text.length - tailBudget);
  const containingRange = suffix.contextRanges.find(
    (range) => desiredStart > range.start && desiredStart < range.end,
  );
  if (!containingRange) {
    return desiredStart;
  }
  return (
    containingRange.segmentStarts.find((segmentStart) => segmentStart >= desiredStart) ??
    containingRange.end
  );
}

function capCompactionSuffix(suffix: CompactionSuffix, maxChars: number): string {
  if (suffix.text.length <= maxChars) {
    return suffix.text;
  }
  if (maxChars <= 0) {
    return "";
  }
  if (maxChars < CONTEXT_TRUNCATED_MARKER.length) {
    const start = resolveSuffixTailStart(suffix, maxChars);
    return sliceUtf16Safe(suffix.text, start);
  }
  const tailBudget = maxChars - CONTEXT_TRUNCATED_MARKER.length;
  const start = resolveSuffixTailStart(suffix, tailBudget);
  // A cut inside a context section keeps its heading so the retained turns stay labeled.
  const cutRange = suffix.contextRanges.find(
    (range) =>
      start > range.start && start < range.end && (range.segmentStarts[0] ?? range.end) <= start,
  );
  if (cutRange) {
    // Ranges start after leading separators, so restore one before the heading.
    const heading = `\n\n${suffix.text.slice(cutRange.start, cutRange.segmentStarts[0]).trim()}`;
    const headedStart = resolveSuffixTailStart(suffix, tailBudget - heading.length);
    if (tailBudget > heading.length && headedStart < cutRange.end) {
      return `${heading}${CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(suffix.text, headedStart)}`;
    }
  }
  return tailBudget > 0
    ? `${CONTEXT_TRUNCATED_MARKER}${sliceUtf16Safe(suffix.text, start)}`
    : CONTEXT_TRUNCATED_MARKER;
}

export function budgetCompactionSummary(
  summaryBody: string,
  suffix: CompactionSuffix,
  maxChars: number,
  qualityRetention?: SummaryQualityRetention,
) {
  const joined = `${summaryBody}${suffix.text}`;
  // A body that fits still goes through the retention plan when it omits an
  // audited identifier or lets an audit section outgrow its cap; both would
  // re-distill into the next summary otherwise.
  const retentionPlan = qualityRetention
    ? createSummaryQualityRetentionPlan(summaryBody, SUMMARY_TRUNCATED_MARKER, qualityRetention)
    : null;
  if (maxChars <= 0 || (joined.length <= maxChars && !retentionPlan?.needsRebuild(maxChars))) {
    return {
      summary: joined,
      structuralSummary: summaryBody,
      bodyBudget: maxChars,
      bodyTrimmed: false,
      suffixTrimmed: false,
    };
  }

  // The fitter must search above the retention minimum, not price an unrelated
  // head cut whose CJK density can exceed a larger candidate that keeps the facts.
  if (retentionPlan && retentionPlan.minimumChars > maxChars) {
    return undefined;
  }

  const bodyCapacity = retentionPlan ? maxChars : summaryBody.length;
  const bodyFloor = Math.min(
    bodyCapacity,
    maxChars,
    Math.max(1, Math.ceil(maxChars / 2), retentionPlan?.minimumChars ?? 0),
  );
  // Verbatim context sections are the overflow: they yield to the generated body,
  // which only reserves room for the suffix's required sections.
  const contextChars = suffix.contextRanges.reduce(
    (sum, range) => sum + range.end - range.start,
    0,
  );
  const suffixReservation = Math.min(suffix.text.length - contextChars, maxChars);
  const bodySlot = Math.min(bodyCapacity, Math.max(bodyFloor, maxChars - suffixReservation));
  const rendered = retentionPlan?.render(bodySlot);
  const cappedBody = rendered?.text ?? capCompactionSummary(summaryBody, bodySlot);
  const suffixBudget = Math.max(0, maxChars - cappedBody.length);
  const cappedSuffix = capCompactionSuffix(suffix, suffixBudget);
  return {
    summary: `${cappedBody}${cappedSuffix}`,
    structuralSummary: cappedBody,
    bodyBudget: bodySlot,
    bodyTrimmed: rendered ? rendered.trimmed : cappedBody.length < summaryBody.length,
    suffixTrimmed: cappedSuffix.length < suffix.text.length,
  };
}
