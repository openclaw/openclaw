import type { PromotionCandidate, ShortTermRecallEntry } from "./short-term-promotion-types.js";
import { isShortTermSessionCorpusPath } from "./short-term-promotion-utils.js";

/** Reject machine-generated audit findings and pasted command listings as personal memories. */
export function isDreamingTraceNoise(
  entry: Pick<ShortTermRecallEntry, "path" | "snippet">,
): boolean {
  const sourcePath = entry.path.replaceAll("\\", "/");
  const snippet = entry.snippet.trim();
  return (
    /(?:^|\/)\d{4}-\d{2}-\d{2}-reconcile-report\.md$/i.test(sourcePath) ||
    /^(?:Broken Links?|Orphan Notes?|Duplicate Concepts?):/i.test(snippet) ||
    /(?:^|\\n|\n)\?\?\s+\S/.test(snippet) ||
    /^User:\s*loops\/cron-self-heal\/runs\//i.test(snippet)
  );
}

export function filterConsolidationCandidates(
  candidates: readonly PromotionCandidate[],
): PromotionCandidate[] {
  return candidates.filter(isConsolidationCandidateEligible);
}

/** Explicitly tainted origins must never promote through any durable write path. */
export function isPromotionOriginBlocked(
  candidate: Pick<PromotionCandidate, "provenance">,
): boolean {
  const originClass = candidate.provenance?.originClass;
  return originClass === "untrusted" || originClass === "system";
}

export function isConsolidationCandidateEligible(candidate: PromotionCandidate): boolean {
  const trustedOrigin =
    candidate.provenance?.originClass === "owner" || candidate.provenance?.originClass === "agent";
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const sessionDerived =
    isShortTermSessionCorpusPath(normalizedPath) || normalizedPath.startsWith("sessions/");
  return (
    trustedOrigin &&
    !isDreamingTraceNoise(candidate) &&
    (!sessionDerived || candidate.provenance?.sessionKind === "interactive")
  );
}
