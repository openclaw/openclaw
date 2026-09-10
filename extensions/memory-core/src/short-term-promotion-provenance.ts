import { resolveDailyRangeProvenance, type DailyProvenanceRecord } from "./daily-provenance.js";
import { isPromotionOriginBlocked } from "./dreaming-consolidation-candidates.js";
import type { PromotionCandidate } from "./short-term-promotion-types.js";

export function withAuthoritativeProvenance(
  candidate: PromotionCandidate,
  provenance: PromotionCandidate["provenance"],
): PromotionCandidate {
  if (isPromotionOriginBlocked(candidate)) {
    return candidate;
  }
  const next = { ...candidate };
  if (provenance) {
    next.provenance = provenance;
  } else {
    delete next.provenance;
  }
  return next;
}

export function withDailyRangeQuarantine(
  candidate: PromotionCandidate,
  record: DailyProvenanceRecord | undefined,
  content: string | undefined,
): PromotionCandidate {
  if (record?.originClass !== "untrusted") {
    return candidate;
  }
  const provenance = content
    ? resolveDailyRangeProvenance({
        content,
        record,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        defaultObservedAt: record.observedAt,
      })
    : {
        originClass: "untrusted" as const,
        sessionKind: "unknown" as const,
        observedAt: record.observedAt,
      };
  return provenance.originClass === "untrusted" ? { ...candidate, provenance } : candidate;
}

export function isRelocatedRangeUntrusted(params: {
  record: DailyProvenanceRecord | undefined;
  content: string | undefined;
  ranges: readonly { startLine: number; endLine: number }[] | undefined;
}): boolean {
  const record = params.record;
  const content = params.content;
  const ranges = params.ranges;
  if (record?.originClass !== "untrusted") {
    return false;
  }
  if (!content || !ranges) {
    return true;
  }
  return ranges.some(
    (range) =>
      resolveDailyRangeProvenance({
        content,
        record,
        startLine: range.startLine,
        endLine: range.endLine,
        defaultObservedAt: record.observedAt,
      }).originClass === "untrusted",
  );
}
