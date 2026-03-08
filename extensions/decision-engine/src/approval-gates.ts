export type ApprovalRiskLevel = "low" | "medium" | "high" | "critical";

export type ApprovalPolicy = {
  requireApprovalAtOrAbove: ApprovalRiskLevel;
  sideEffectTools: string[];
};

export type ApprovalEvaluationInput = {
  toolName: string;
  risk: ApprovalRiskLevel;
  actorId?: string;
};

export type ApprovalEvaluationResult = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
};

const RISK_ORDER: Record<ApprovalRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function evaluateApprovalGate(
  policy: ApprovalPolicy,
  input: ApprovalEvaluationInput,
): ApprovalEvaluationResult {
  const threshold = RISK_ORDER[policy.requireApprovalAtOrAbove];
  const incoming = RISK_ORDER[input.risk];
  const sideEffect = policy.sideEffectTools.includes(input.toolName);
  const requiresApproval = sideEffect && incoming >= threshold;
  if (requiresApproval) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: "approval_required",
    };
  }
  return {
    allowed: true,
    requiresApproval: false,
    reason: "auto_allowed",
  };
}

