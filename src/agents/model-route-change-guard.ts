import type { ModelAuthMode } from "./model-auth.js";

export type ModelRouteBillingMode = "metered" | "subscription" | "local" | "unknown";
export type ModelRouteGuardEnforcement = "dry-run" | "block";
export type ModelRouteGuardAction = "allow" | "escalate" | "block";

export type ModelRouteApproval = {
  approved?: boolean;
  budgetCapUsd?: number;
  approvalId?: string;
};

export type ModelRouteChangeGuardInput = {
  selectedProvider: string;
  selectedModel: string;
  activeProvider: string;
  activeModel: string;
  selectedAuthMode?: ModelAuthMode;
  activeAuthMode?: ModelAuthMode;
  enforcement?: ModelRouteGuardEnforcement;
  approval?: ModelRouteApproval;
};

export type ModelRouteChangeGuardResult = {
  changed: boolean;
  action: ModelRouteGuardAction;
  enforcement: ModelRouteGuardEnforcement;
  escalationRequired: boolean;
  selected: {
    provider: string;
    model: string;
    authMode: ModelAuthMode | "unknown";
    billingMode: ModelRouteBillingMode;
  };
  active: {
    provider: string;
    model: string;
    authMode: ModelAuthMode | "unknown";
    billingMode: ModelRouteBillingMode;
  };
  reason?: string;
  approval?: {
    approved: boolean;
    hasBudgetCap: boolean;
    approvalId?: string;
  };
};

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

export function resolveModelRouteBillingMode(params: {
  provider?: string;
  authMode?: ModelAuthMode;
}): ModelRouteBillingMode {
  const provider = clean(params.provider).toLowerCase();
  if (!provider) {
    return "unknown";
  }
  if (
    provider === "local" ||
    provider === "ollama" ||
    provider.includes("local") ||
    provider.includes("lmstudio")
  ) {
    return "local";
  }
  switch (params.authMode) {
    case "api-key":
    case "token":
    case "aws-sdk":
      return "metered";
    case "oauth":
      return "subscription";
    case "mixed":
    case "unknown":
    case undefined:
      return "unknown";
  }
  return "unknown";
}

function hasApprovalAndBudgetCap(approval: ModelRouteApproval | undefined): boolean {
  return (
    approval?.approved === true &&
    typeof approval.budgetCapUsd === "number" &&
    approval.budgetCapUsd > 0
  );
}

function describeEscalationReason(params: {
  selectedBilling: ModelRouteBillingMode;
  activeBilling: ModelRouteBillingMode;
  selectedProvider: string;
  activeProvider: string;
  selectedAuthMode: ModelAuthMode | "unknown";
  activeAuthMode: ModelAuthMode | "unknown";
}): string | undefined {
  if (params.activeBilling === "metered" && params.selectedBilling !== "metered") {
    return `model route changed into metered billing (${params.selectedProvider} → ${params.activeProvider})`;
  }
  if (params.activeBilling === "metered" && params.selectedProvider !== params.activeProvider) {
    return `provider fallback changed into metered billing (${params.selectedProvider} → ${params.activeProvider})`;
  }
  if (params.activeBilling === "metered" && params.selectedAuthMode !== params.activeAuthMode) {
    return `auth profile changed into metered billing (${params.selectedAuthMode} → ${params.activeAuthMode})`;
  }
  return undefined;
}

export function evaluateModelRouteChangeGuard(
  input: ModelRouteChangeGuardInput,
): ModelRouteChangeGuardResult {
  const selectedProvider = clean(input.selectedProvider);
  const selectedModel = clean(input.selectedModel);
  const activeProvider = clean(input.activeProvider);
  const activeModel = clean(input.activeModel);
  const selectedAuthMode = input.selectedAuthMode ?? "unknown";
  const activeAuthMode = input.activeAuthMode ?? "unknown";
  const selectedBilling = resolveModelRouteBillingMode({
    provider: selectedProvider,
    authMode: input.selectedAuthMode,
  });
  const activeBilling = resolveModelRouteBillingMode({
    provider: activeProvider,
    authMode: input.activeAuthMode,
  });
  const changed = selectedProvider !== activeProvider || selectedModel !== activeModel;
  const enforcement = input.enforcement ?? "dry-run";
  const reason = changed
    ? describeEscalationReason({
        selectedBilling,
        activeBilling,
        selectedProvider,
        activeProvider,
        selectedAuthMode,
        activeAuthMode,
      })
    : undefined;
  const approvalSatisfied = hasApprovalAndBudgetCap(input.approval);
  const escalationRequired = Boolean(reason && !approvalSatisfied);
  const action: ModelRouteGuardAction = escalationRequired
    ? enforcement === "block"
      ? "block"
      : "escalate"
    : "allow";

  return {
    changed,
    action,
    enforcement,
    escalationRequired,
    selected: {
      provider: selectedProvider,
      model: selectedModel,
      authMode: selectedAuthMode,
      billingMode: selectedBilling,
    },
    active: {
      provider: activeProvider,
      model: activeModel,
      authMode: activeAuthMode,
      billingMode: activeBilling,
    },
    ...(reason ? { reason } : {}),
    ...(input.approval
      ? {
          approval: {
            approved: input.approval.approved === true,
            hasBudgetCap:
              typeof input.approval.budgetCapUsd === "number" && input.approval.budgetCapUsd > 0,
            ...(input.approval.approvalId ? { approvalId: input.approval.approvalId } : {}),
          },
        }
      : {}),
  };
}

export function buildModelRouteChangeGuardNotice(
  result: ModelRouteChangeGuardResult,
): string | undefined {
  if (!result.escalationRequired || !result.reason) {
    return undefined;
  }
  const prefix = result.action === "block" ? "⛔" : "⚠️";
  return `${prefix} Model route guard: ${result.reason}; approval with a budget cap is required before enforcing this transition.`;
}
