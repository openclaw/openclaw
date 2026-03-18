export function evaluatePolicy(plan, context) {
  if (context.mode === "read-only") {
    return { allowed: false, reason: "READ_ONLY_MODE" };
  }

  if (context.mode === "suggest-only") {
    return { allowed: false, reason: "SUGGEST_ONLY" };
  }

  if (plan.risk === "HIGH") {
    return { allowed: false, requiresApproval: true };
  }

  if (context.mode === "approval-required") {
    return { allowed: false, requiresApproval: true };
  }

  return { allowed: true };
}
