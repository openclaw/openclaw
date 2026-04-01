/**
 * Governance plugin hooks — wires budget reservation, RBAC enforcement,
 * audit logging, and LLM cost tracking into the agent lifecycle.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLog } from "./audit-log.js";
import type { BudgetLedger } from "./budget-ledger.js";
import { resolveCompanyId } from "./company-scope.js";
import { estimateTokenCost } from "./index.js";
import type { RbacEngine } from "./rbac.js";
import type { GovernanceConfig } from "./types.js";

interface GovernanceHookDeps {
  ledger: BudgetLedger;
  audit: AuditLog;
  rbac: RbacEngine;
  config: GovernanceConfig;
}

/**
 * Register all governance lifecycle hooks on the plugin API.
 */
export function registerGovernanceHooks(api: OpenClawPluginApi, deps: GovernanceHookDeps): void {
  const { ledger, audit, rbac, config } = deps;
  const log = api.logger;

  // 1. Before every tool call: RBAC check + budget reservation + audit
  api.on("before_tool_call", async (ctx: any) => {
    const companyId = resolveCompanyId({
      companyId: ctx.companyId,
      agentMeta: ctx.agentMeta,
    });
    const agentId = ctx.agentId ?? "unknown";
    const role = ctx.agentRole ?? ctx.senderRole ?? config.rbac?.defaultRole ?? "agent";

    // RBAC enforcement
    if (config.rbac?.enabled !== false) {
      const action = `tool:${ctx.toolName}`;
      if (!rbac.isAllowed(role, action)) {
        audit.log({
          companyId,
          actorType: "agent",
          actorId: agentId,
          action: "tool_call",
          resourceType: "tool",
          resourceId: ctx.toolName,
          detail: JSON.stringify({ role, denied: true }),
          outcome: "denied",
        });
        log.warn(`[governance] RBAC denied: role "${role}" cannot call "${ctx.toolName}"`);
        return {
          blocked: true,
          reason: `Permission denied: role "${role}" cannot perform "tool:${ctx.toolName}"`,
        };
      }
    }

    // Budget reservation
    if (config.budget?.enabled !== false) {
      const hardCeiling = config.budget?.hardCeilingUsd ?? 100;
      const approvalThreshold = config.budget?.requireApprovalAboveUsd ?? hardCeiling;

      // Estimate cost for the tool call (heuristic: $0.001 per tool call baseline)
      const estimatedCost = 0.001;

      if (estimatedCost > 0) {
        try {
          const reservationId = ledger.reserveBudget({
            companyId,
            agentId,
            estimatedCostUsd: estimatedCost,
            sessionId: ctx.sessionId ?? null,
            toolName: ctx.toolName ?? null,
          });

          // Store reservation ID for settlement in after_tool_call
          ctx.meta = ctx.meta ?? {};
          ctx.meta.budgetReservationId = reservationId;
          ctx.meta.budgetCompanyId = companyId;
        } catch (err: any) {
          if (err.name === "BudgetExhaustedError") {
            audit.log({
              companyId,
              actorType: "agent",
              actorId: agentId,
              action: "budget_exhausted",
              resourceType: "tool",
              resourceId: ctx.toolName,
              detail: err.message,
              outcome: "denied",
            });
            return { blocked: true, reason: err.message };
          }
          throw err;
        }
      }
    }

    // Audit the tool call attempt
    audit.log({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "tool_call",
      resourceType: "tool",
      resourceId: ctx.toolName,
      detail: null,
      outcome: "success",
    });
  });

  // 2. After every tool call: settle budget reservation
  api.on("after_tool_call", async (ctx: any) => {
    if (ctx.meta?.budgetReservationId) {
      try {
        const actualCost = ctx.actualCost ?? 0;
        ledger.settleReservation(ctx.meta.budgetReservationId, actualCost);
      } catch (err) {
        log.warn(`[governance] Failed to settle reservation: ${err}`);
      }
    }
  });

  // 3. After LLM output: track token costs
  api.on("llm_output", async (ctx: any) => {
    if (config.budget?.enabled === false) return;

    const companyId = resolveCompanyId({
      companyId: ctx.companyId,
      agentMeta: ctx.agentMeta,
    });
    const agentId = ctx.agentId ?? "unknown";
    const model = ctx.model ?? "unknown";
    const inputTokens = ctx.inputTokens ?? 0;
    const outputTokens = ctx.outputTokens ?? 0;

    const cost = estimateTokenCost(model, inputTokens, outputTokens);
    if (cost > 0) {
      ledger.recordDirectCost({
        companyId,
        agentId,
        eventType: "llm_output",
        amountUsd: cost,
        sessionId: ctx.sessionId ?? null,
        model,
        inputTokens,
        outputTokens,
      });
    }
  });

  log.info("[governance] Hooks registered (RBAC + budget reservation + audit + LLM cost tracking)");
}
