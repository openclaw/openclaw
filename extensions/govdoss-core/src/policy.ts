export type PolicyDecision = {
  allowed: boolean;
  requiresApproval?: boolean;
  reason?: string;
};

export function evaluateGovdossPolicy(input: {
  risk?: string;
  mode?: string;
}) : PolicyDecision {
  if (input.mode === "read-only") {
    return { allowed: false, reason: "READ_ONLY" };
  }

  if (input.mode === "suggest-only") {
    return { allowed: false, reason: "SUGGEST_ONLY" };
  }

  if (input.risk === "HIGH") {
    return { allowed: false, requiresApproval: true };
  }

  if (input.mode === "approval-required") {
    return { allowed: false, requiresApproval: true };
  }

  return { allowed: true };
}

export function requiresApproval(decision: PolicyDecision) {
  return decision.requiresApproval === true;
}
