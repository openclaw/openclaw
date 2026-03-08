import { evaluateApprovalGate, type ApprovalPolicy, type ApprovalRiskLevel } from "./approval-gates.js";
import { evaluateBudget, type BudgetPolicy, type BudgetUsage } from "./budget-guards.js";
import { isToolAllowed, type ToolAccessMatrix } from "./tool-access-matrix.js";

export type PolicyEngineInput = {
  toolName: string;
  risk: ApprovalRiskLevel;
  budgetUsage?: BudgetUsage;
};

export type PolicyEngineConfig = {
  tools: ToolAccessMatrix;
  approvals: ApprovalPolicy;
  budget?: BudgetPolicy;
};

export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reasons: string[];
};

export function evaluatePolicy(config: PolicyEngineConfig, input: PolicyEngineInput): PolicyDecision {
  const reasons: string[] = [];

  if (!isToolAllowed({ matrix: config.tools, toolName: input.toolName })) {
    reasons.push("tool_blocked_by_policy");
  }

  const approval = evaluateApprovalGate(config.approvals, {
    toolName: input.toolName,
    risk: input.risk,
  });
  if (!approval.allowed) {
    reasons.push(approval.reason);
  }

  if (config.budget && input.budgetUsage) {
    const budget = evaluateBudget(config.budget, input.budgetUsage);
    reasons.push(...budget.violations);
  }

  return {
    allowed: reasons.length === 0,
    requiresApproval: reasons.includes("approval_required"),
    reasons,
  };
}

