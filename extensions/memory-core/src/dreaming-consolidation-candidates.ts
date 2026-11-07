import type { PromotionCandidate } from "./short-term-promotion-types.js";
import { isShortTermSessionCorpusPath } from "./short-term-promotion-utils.js";

export function filterConsolidationCandidates(
  candidates: readonly PromotionCandidate[],
): PromotionCandidate[] {
  return candidates.filter(isConsolidationCandidateEligible);
}

export { isPromotionOriginBlocked } from "./short-term-promotion-utils.js";

export function isConsolidationCandidateEligible(candidate: PromotionCandidate): boolean {
  const trustedOrigin =
    candidate.provenance?.originClass === "owner" || candidate.provenance?.originClass === "agent";
  const normalizedPath = candidate.path.replaceAll("\\", "/");
  const sessionDerived =
    isShortTermSessionCorpusPath(normalizedPath) || normalizedPath.startsWith("sessions/");
  return trustedOrigin && (!sessionDerived || candidate.provenance?.sessionKind === "interactive");
}
