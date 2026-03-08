export type BudgetPolicy = {
  maxUsd?: number;
  maxTokens?: number;
  maxRuntimeMs?: number;
};

export type BudgetUsage = {
  usd?: number;
  tokens?: number;
  runtimeMs?: number;
};

export type BudgetEvaluation = {
  allowed: boolean;
  violations: string[];
};

export function evaluateBudget(policy: BudgetPolicy, usage: BudgetUsage): BudgetEvaluation {
  const violations: string[] = [];
  if (typeof policy.maxUsd === "number" && typeof usage.usd === "number" && usage.usd > policy.maxUsd) {
    violations.push("max_usd_exceeded");
  }
  if (
    typeof policy.maxTokens === "number" &&
    typeof usage.tokens === "number" &&
    usage.tokens > policy.maxTokens
  ) {
    violations.push("max_tokens_exceeded");
  }
  if (
    typeof policy.maxRuntimeMs === "number" &&
    typeof usage.runtimeMs === "number" &&
    usage.runtimeMs > policy.maxRuntimeMs
  ) {
    violations.push("max_runtime_exceeded");
  }
  return { allowed: violations.length === 0, violations };
}

