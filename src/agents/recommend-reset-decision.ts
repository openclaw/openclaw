import type { SessionGuardSignal } from "./compaction-guard.js";
import type { PostCompactionValidation } from "./post-compaction-validator.js";

export type RecommendResetDecision = {
  recommended: boolean;
  severity: "none" | "warn" | "recommend-reset";
  reasons: string[];
};

export function resolveRecommendResetDecision(params: {
  guardEnabled?: boolean;
  escalationMode?: string;
  signalBefore: SessionGuardSignal;
  validation: PostCompactionValidation;
}): RecommendResetDecision {
  if (params.guardEnabled !== true || params.escalationMode !== "recommend-reset") {
    return {
      recommended: false,
      severity: "none",
      reasons: [],
    };
  }

  if (params.validation.ok) {
    return {
      recommended: false,
      severity: "none",
      reasons: [],
    };
  }

  const reasons = uniqueReasons([...params.signalBefore.reasons, ...params.validation.reasons]);
  const severeSignal = isRecommendResetCandidate(params.signalBefore);

  if (!severeSignal || !params.validation.shouldRecommendReset) {
    return {
      recommended: false,
      severity: "warn",
      reasons,
    };
  }

  return {
    recommended: true,
    severity: "recommend-reset",
    reasons,
  };
}

function isRecommendResetCandidate(signal: SessionGuardSignal): boolean {
  return (
    signal.action === "recommend-reset" || signal.action === "reset-candidate" || signal.score >= 8
  );
}

function uniqueReasons(reasons: string[]): string[] {
  return Array.from(new Set(reasons.filter((reason) => reason.trim().length > 0)));
}
