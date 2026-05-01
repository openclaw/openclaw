/**
 * approvals.ts — before_tool_call hook for the `payment` tool.
 *
 * Only fires for the `payment` tool. Returns requireApproval for
 * issue_virtual_card (severity: warning) and execute_machine_payment
 * (severity: critical). Read-only actions return void.
 *
 * Note on severity mapping:
 *   The SDK's PluginHookBeforeToolCallResult.requireApproval.severity accepts
 *   "info" | "warning" | "critical". The feature plan refers to "high" for
 *   issue_virtual_card — we map that to "warning" (the closest SDK equivalent).
 *   execute_machine_payment maps to "critical" as specified.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

// ---------------------------------------------------------------------------
// Description builders (exported for testability)
// ---------------------------------------------------------------------------

type IssueVirtualCardParams = {
  providerId: string;
  amount: { amountCents: number; currency: string };
  merchant: { name: string; url?: string };
  fundingSourceId: string;
};

type ExecuteMachinePaymentParams = {
  providerId: string;
  targetUrl: string;
  method: string;
  fundingSourceId: string;
};

function formatAmount(amountCents: number, currency: string): string {
  const major = (amountCents / 100).toFixed(2);
  return `$${major} ${currency.toUpperCase()}`;
}

export function describeIssueApproval(params: IssueVirtualCardParams): string {
  const amountStr = formatAmount(params.amount.amountCents, params.amount.currency);
  const merchantStr = params.merchant.url
    ? `'${params.merchant.name}' (${params.merchant.url})`
    : `'${params.merchant.name}'`;
  return (
    `Issue a virtual card via ${params.providerId} for ${amountStr} at merchant ${merchantStr}. ` +
    `Funding source: ${params.fundingSourceId}. ` +
    `This will trigger a Stripe Link approval on your phone.`
  );
}

export function describeExecuteApproval(params: ExecuteMachinePaymentParams): string {
  return (
    `Execute machine payment via ${params.providerId} to ${params.targetUrl} (${params.method}). ` +
    `Funding source: ${params.fundingSourceId}. ` +
    `**This is irreversible** once settled.`
  );
}

// ---------------------------------------------------------------------------
// Hook handler
// ---------------------------------------------------------------------------

type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

type BeforeToolCallResult = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    pluginId?: string;
  };
};

function handleBeforeToolCall(event: BeforeToolCallEvent): BeforeToolCallResult | void {
  // Only gate the payment tool
  if (event.toolName !== "payment") {
    return;
  }

  const params = event.params as Record<string, unknown>;
  const action = params["action"];

  if (action === "issue_virtual_card") {
    const issueParams: IssueVirtualCardParams = {
      providerId: String(params["providerId"] ?? "unknown"),
      amount: {
        amountCents: Number((params["amount"] as Record<string, unknown>)?.["amountCents"] ?? 0),
        currency: String((params["amount"] as Record<string, unknown>)?.["currency"] ?? "usd"),
      },
      merchant: {
        name: String((params["merchant"] as Record<string, unknown>)?.["name"] ?? "unknown"),
        url:
          (params["merchant"] as Record<string, unknown>)?.["url"] !== undefined
            ? String((params["merchant"] as Record<string, unknown>)?.["url"])
            : undefined,
      },
      fundingSourceId: String(params["fundingSourceId"] ?? "unknown"),
    };

    return {
      requireApproval: {
        severity: "warning",
        title: "Issue virtual card",
        description: describeIssueApproval(issueParams),
        timeoutBehavior: "deny",
      },
    };
  }

  if (action === "execute_machine_payment") {
    const executeParams: ExecuteMachinePaymentParams = {
      providerId: String(params["providerId"] ?? "unknown"),
      targetUrl: String(params["targetUrl"] ?? "unknown"),
      method: String(params["method"] ?? "POST"),
      fundingSourceId: String(params["fundingSourceId"] ?? "unknown"),
    };

    return {
      requireApproval: {
        severity: "critical",
        title: "Execute machine payment",
        description: describeExecuteApproval(executeParams),
        timeoutBehavior: "deny",
      },
    };
  }

  // Read-only actions: setup_status, list_funding_sources, get_payment_status
  return;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPaymentApprovalsHook(api: OpenClawPluginApi): void {
  api.on("before_tool_call", (event, _ctx) => {
    return handleBeforeToolCall(event);
  });
}
