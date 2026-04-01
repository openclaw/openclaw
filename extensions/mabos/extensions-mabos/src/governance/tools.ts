/**
 * Governance agent tools — budget status, budget requests, audit queries.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult } from "../tools/common.js";
import type { AuditLog } from "./audit-log.js";
import type { BudgetLedger } from "./budget-ledger.js";

const BudgetStatusParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID to check budget for" }),
  company_id: Type.Optional(Type.String({ description: "Company ID (defaults to 'default')" })),
});

const BudgetRequestParams = Type.Object({
  agent_id: Type.String({ description: "Agent requesting the budget" }),
  reason: Type.String({ description: "Reason for the budget request" }),
  requested_amount_usd: Type.Number({ description: "Amount requested in USD" }),
});

const AuditQueryParams = Type.Object({
  company_id: Type.Optional(Type.String({ description: "Filter by company ID" })),
  action: Type.Optional(Type.String({ description: "Filter by action type" })),
  actor_id: Type.Optional(Type.String({ description: "Filter by actor ID" })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)" })),
});

function formatBudgetPeriod(
  label: string,
  period: { limit: number; spent: number; reserved: number; remaining: number } | null,
): string {
  if (!period) return `${label}: No allocation`;
  return [
    `${label}:`,
    `  Limit:     $${period.limit.toFixed(2)}`,
    `  Spent:     $${period.spent.toFixed(2)}`,
    `  Reserved:  $${period.reserved.toFixed(2)}`,
    `  Remaining: $${period.remaining.toFixed(2)}`,
  ].join("\n");
}

export function createGovernanceTools(ledger: BudgetLedger, audit: AuditLog): AnyAgentTool[] {
  const budgetStatus: AnyAgentTool = {
    name: "budget_status",
    label: "Budget Status",
    description:
      "Check the current budget status for an agent, including daily and monthly limits, spend, and remaining balance.",
    parameters: BudgetStatusParams,
    execute: async (args: Static<typeof BudgetStatusParams>) => {
      const companyId = args.company_id ?? "default";
      const status = ledger.getBudgetStatus(companyId, args.agent_id);

      const lines = [
        `Budget Status for agent "${status.agentId}":`,
        "",
        formatBudgetPeriod("Daily", status.daily),
        formatBudgetPeriod("Monthly", status.monthly),
        "",
        `Can Spend: ${status.canSpend ? "Yes" : "No"}`,
      ];
      return textResult(lines.join("\n"));
    },
  };

  const budgetRequest: AnyAgentTool = {
    name: "budget_request",
    label: "Budget Request",
    description: "Submit a budget request for approval. Logs the request as a pending audit entry.",
    parameters: BudgetRequestParams,
    execute: async (args: Static<typeof BudgetRequestParams>) => {
      audit.log({
        actorType: "agent",
        actorId: args.agent_id,
        action: "budget_request",
        resourceType: "budget",
        detail: JSON.stringify({
          reason: args.reason,
          requested_amount_usd: args.requested_amount_usd,
        }),
        outcome: "pending",
      });
      return textResult(
        `Budget request submitted: $${args.requested_amount_usd.toFixed(2)} for "${args.reason}" (status: pending)`,
      );
    },
  };

  const auditQuery: AnyAgentTool = {
    name: "audit_query",
    label: "Audit Query",
    description:
      "Query the governance audit log with optional filters for company, action, actor, and result limit.",
    parameters: AuditQueryParams,
    execute: async (args: Static<typeof AuditQueryParams>) => {
      const entries = audit.query({
        companyId: args.company_id,
        action: args.action,
        actorId: args.actor_id,
        limit: args.limit ?? 50,
      });

      if (entries.length === 0) {
        return textResult("No audit entries found matching the query.");
      }

      const lines = entries.map(
        (e) =>
          `[${e.timestamp}] ${e.actorType}:${e.actorId} — ${e.action} → ${e.outcome}${e.detail ? ` (${e.detail})` : ""}`,
      );
      return textResult(`Audit Log (${entries.length} entries):\n${lines.join("\n")}`);
    },
  };

  return [budgetStatus, budgetRequest, auditQuery];
}
