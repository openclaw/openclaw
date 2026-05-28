export type LearningPromotionStage = "staging" | "promoted" | "rolled_back";
export type LearningPromotionAction = "promote" | "rollback" | "block";

export type LearningPromotionMetrics = Readonly<{
  failureRate: number;
  timeoutRate: number;
  latencyP95Ms: number;
  adoptionRate: number;
  rollbackRate: number;
}>;

export type LearningPromotionThresholds = Readonly<{
  maxFailureRate: number;
  maxTimeoutRate: number;
  maxLatencyP95Ms: number;
  minAdoptionRate: number;
  maxRollbackRate: number;
}>;

export type LearningPromotionCandidate = Readonly<{
  decisionId: string;
  decisionVersion: number;
  source: string;
  stage: LearningPromotionStage;
  evidenceLocked: boolean;
  rollbackPointer?: unknown;
  metrics: LearningPromotionMetrics;
  thresholds?: Partial<LearningPromotionThresholds>;
}>;

export type LearningPromotionGateResult = Readonly<{
  allowed: boolean;
  action: LearningPromotionAction;
  nextStage: LearningPromotionStage;
  reason: string;
}>;

const DEFAULT_THRESHOLDS: LearningPromotionThresholds = {
  maxFailureRate: 0.05,
  maxTimeoutRate: 0.03,
  maxLatencyP95Ms: 30_000,
  minAdoptionRate: 0.1,
  maxRollbackRate: 0.02,
};

function resolveThresholds(
  thresholds: Partial<LearningPromotionThresholds> | undefined,
): LearningPromotionThresholds {
  return { ...DEFAULT_THRESHOLDS, ...thresholds };
}

function isFiniteRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function metricsAreValid(metrics: LearningPromotionMetrics): boolean {
  return (
    isFiniteRate(metrics.failureRate) &&
    isFiniteRate(metrics.timeoutRate) &&
    Number.isFinite(metrics.latencyP95Ms) &&
    metrics.latencyP95Ms >= 0 &&
    isFiniteRate(metrics.adoptionRate) &&
    isFiniteRate(metrics.rollbackRate)
  );
}

export function evaluateLearningPromotionGate(
  candidate: LearningPromotionCandidate,
): LearningPromotionGateResult {
  if (candidate.stage !== "staging") {
    return {
      allowed: false,
      action: "block",
      nextStage: candidate.stage,
      reason: "candidate-not-in-staging",
    };
  }
  if (!candidate.evidenceLocked) {
    return {
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "evidence-lock-missing",
    };
  }
  if (!candidate.rollbackPointer) {
    return {
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "rollback-pointer-missing",
    };
  }
  if (!metricsAreValid(candidate.metrics)) {
    return {
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "invalid-metrics",
    };
  }

  const thresholds = resolveThresholds(candidate.thresholds);
  if (candidate.metrics.failureRate > thresholds.maxFailureRate) {
    return {
      allowed: false,
      action: "rollback",
      nextStage: "rolled_back",
      reason: "failure-rate-threshold",
    };
  }
  if (candidate.metrics.timeoutRate > thresholds.maxTimeoutRate) {
    return {
      allowed: false,
      action: "rollback",
      nextStage: "rolled_back",
      reason: "timeout-rate-threshold",
    };
  }
  if (candidate.metrics.latencyP95Ms > thresholds.maxLatencyP95Ms) {
    return {
      allowed: false,
      action: "rollback",
      nextStage: "rolled_back",
      reason: "latency-threshold",
    };
  }
  if (candidate.metrics.rollbackRate > thresholds.maxRollbackRate) {
    return {
      allowed: false,
      action: "rollback",
      nextStage: "rolled_back",
      reason: "rollback-rate-threshold",
    };
  }
  if (candidate.metrics.adoptionRate < thresholds.minAdoptionRate) {
    return {
      allowed: false,
      action: "block",
      nextStage: "staging",
      reason: "adoption-rate-threshold",
    };
  }

  return {
    allowed: true,
    action: "promote",
    nextStage: "promoted",
    reason: "promotion-thresholds-passed",
  };
}
