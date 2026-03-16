import type { TranscriptTailSignal } from "./transcript-tail-detector.js";

export type GuardThresholds = {
  warnUsageRatio: number;
  riskUsageRatio: number;
  forceUsageRatio: number;
  repeatedToolFailureThreshold: number;
  duplicateAssistantThreshold: number;
  staleSystemRecurrenceThreshold: number;
  noGroundedReplyTurnsThreshold: number;
};

export type GuardAction = "none" | "warn" | "compact" | "recommend-reset" | "reset-candidate";

export type SessionGuardSignal = {
  usageRatio: number;
  repeatedToolFailures: TranscriptTailSignal["repeatedToolFailures"];
  duplicateAssistantClusters: number;
  staleSystemRecurrences: number;
  noGroundedReplyTurns: number;
  score: number;
  action: GuardAction;
  reasons: string[];
};

const DEFAULT_GUARD_THRESHOLDS: GuardThresholds = {
  warnUsageRatio: 0.85,
  riskUsageRatio: 0.9,
  forceUsageRatio: 0.95,
  repeatedToolFailureThreshold: 3,
  duplicateAssistantThreshold: 2,
  staleSystemRecurrenceThreshold: 2,
  noGroundedReplyTurnsThreshold: 4,
};

const REASONS = {
  usageWarn: "usage>=warn",
  usageRisk: "usage>=risk",
  usageForce: "usage>=force",
  repeatedToolFailures: "repeatedToolFailures>=threshold",
  duplicateAssistantClusters: "duplicateAssistantClusters>=threshold",
  staleSystemRecurrences: "staleSystemRecurrences>=threshold",
  noGroundedReplyTurns: "noGroundedReplyTurns>=threshold",
} as const;

export function resolveDefaultGuardThresholds(): GuardThresholds {
  return { ...DEFAULT_GUARD_THRESHOLDS };
}

export function scoreCompactionGuard(params: {
  usageRatio: number;
  transcript: TranscriptTailSignal;
  thresholds?: Partial<GuardThresholds>;
}): SessionGuardSignal {
  const thresholds = resolveGuardThresholds(params.thresholds);
  const reasons: string[] = [];
  let score = 0;

  score += scoreUsagePressure(params.usageRatio, thresholds, reasons);
  score += scoreLoopSignals(params.transcript, thresholds, reasons);

  return {
    usageRatio: params.usageRatio,
    repeatedToolFailures: params.transcript.repeatedToolFailures.map((failure) => ({
      ...failure,
    })),
    duplicateAssistantClusters: params.transcript.duplicateAssistantClusters,
    staleSystemRecurrences: params.transcript.staleSystemRecurrences,
    noGroundedReplyTurns: params.transcript.noGroundedReplyTurns,
    score,
    action: resolveGuardAction(score, params.usageRatio, thresholds),
    reasons,
  };
}

function resolveGuardThresholds(thresholds?: Partial<GuardThresholds>): GuardThresholds {
  return {
    ...DEFAULT_GUARD_THRESHOLDS,
    ...thresholds,
  };
}

function scoreUsagePressure(
  usageRatio: number,
  thresholds: GuardThresholds,
  reasons: string[],
): number {
  let score = 0;

  if (usageRatio >= thresholds.warnUsageRatio) {
    score += 1;
    reasons.push(REASONS.usageWarn);
  }

  if (usageRatio >= thresholds.riskUsageRatio) {
    score += 2;
    reasons.push(REASONS.usageRisk);
  }

  if (usageRatio >= thresholds.forceUsageRatio) {
    score += 2;
    reasons.push(REASONS.usageForce);
  }

  return score;
}

function scoreLoopSignals(
  transcript: TranscriptTailSignal,
  thresholds: GuardThresholds,
  reasons: string[],
): number {
  let score = 0;

  // Count repeated tool failures once so one noisy tool loop does not multiply
  // into multiple risk buckets just because several signatures crossed the line.
  if (
    transcript.repeatedToolFailures.some(
      ({ count }) => count >= thresholds.repeatedToolFailureThreshold,
    )
  ) {
    score += 2;
    reasons.push(REASONS.repeatedToolFailures);
  }

  if (transcript.duplicateAssistantClusters >= thresholds.duplicateAssistantThreshold) {
    score += 1;
    reasons.push(REASONS.duplicateAssistantClusters);
  }

  if (transcript.staleSystemRecurrences >= thresholds.staleSystemRecurrenceThreshold) {
    score += 2;
    reasons.push(REASONS.staleSystemRecurrences);
  }

  if (transcript.noGroundedReplyTurns >= thresholds.noGroundedReplyTurnsThreshold) {
    score += 2;
    reasons.push(REASONS.noGroundedReplyTurns);
  }

  return score;
}

function resolveGuardAction(
  score: number,
  usageRatio: number,
  thresholds: GuardThresholds,
): GuardAction {
  if (score >= 8) {
    return usageRatio >= thresholds.forceUsageRatio ? "reset-candidate" : "recommend-reset";
  }

  if (score >= 5) {
    return "compact";
  }

  if (score >= 3) {
    return "warn";
  }

  return "none";
}
