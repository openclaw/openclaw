/**
 * Governance module — budget control, audit logging, RBAC, LLM cost tracking.
 *
 * Wires together BudgetLedger, AuditLog, RbacEngine, governance tools,
 * HTTP routes, and lifecycle hooks for cost/audit tracking.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveWorkspaceDir } from "../tools/common.js";
import { AuditLog } from "./audit-log.js";
import { BudgetLedger } from "./budget-ledger.js";
import { RbacEngine, type RbacPolicy } from "./rbac.js";
import { registerGovernanceRoutes } from "./routes.js";
import { createGovernanceTools } from "./tools.js";
import type { GovernanceConfig } from "./types.js";

interface GovernanceModuleConfig {
  governanceEnabled?: boolean;
  governance?: GovernanceConfig;
}

/** Default RBAC policy with four roles. */
const DEFAULT_RBAC_POLICY: RbacPolicy = {
  roles: {
    admin: { permissions: ["*"] },
    operator: {
      permissions: ["budget:*", "audit:read", "tool:*", "agent:*"],
      deny: ["system:*"],
    },
    agent: {
      permissions: ["tool:*", "budget:read", "audit:read"],
      deny: ["budget:write", "system:*"],
    },
    viewer: {
      permissions: ["budget:read", "audit:read"],
    },
  },
};

/**
 * Estimate cost in USD for a model call based on token counts.
 * Prices are per-million tokens (input / output).
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
};

export function estimateTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Register the full governance module: tools, routes, hooks.
 */
export function registerGovernance(api: OpenClawPluginApi, config: GovernanceModuleConfig): void {
  const log = api.logger;
  const workspaceDir = resolveWorkspaceDir(api);
  const govDir = join(workspaceDir, "governance");

  // Ensure governance directory exists
  mkdirSync(govDir, { recursive: true });

  const govConfig = config.governance ?? {};
  const budgetDbPath = join(govDir, "budget.db");
  const auditDbPath = govConfig.audit?.dbPath ?? join(govDir, "audit.db");

  const ledger = new BudgetLedger(budgetDbPath);
  const audit = new AuditLog(auditDbPath);
  const rbac = new RbacEngine(DEFAULT_RBAC_POLICY);

  // Register governance tools
  const tools = createGovernanceTools(ledger, audit);
  for (const tool of tools) {
    api.registerTool(tool);
  }

  // Register governance HTTP routes
  registerGovernanceRoutes(api, ledger, audit);

  // Hook: track LLM output costs
  api.on("llm_output", async (ctx: any) => {
    try {
      const model = ctx.model ?? "unknown";
      const inputTokens = ctx.inputTokens ?? ctx.input_tokens ?? 0;
      const outputTokens = ctx.outputTokens ?? ctx.output_tokens ?? 0;
      const agentId = ctx.agentId ?? ctx.agent_id ?? "unknown";
      const companyId = ctx.companyId ?? ctx.company_id ?? "default";
      const costUsd = estimateTokenCost(model, inputTokens, outputTokens);

      if (costUsd > 0) {
        ledger.recordDirectCost({
          companyId,
          agentId,
          eventType: "llm_output",
          amountUsd: costUsd,
          model,
          inputTokens,
          outputTokens,
          sessionId: ctx.sessionId ?? null,
        });
      }
    } catch (err) {
      log.debug(`[governance] Failed to record LLM cost: ${err}`);
    }
  });

  // Hook: audit tool calls
  api.on("after_tool_call", async (ctx: any) => {
    try {
      audit.log({
        companyId: ctx.companyId ?? ctx.company_id ?? "default",
        actorType: ctx.actorType ?? "agent",
        actorId: ctx.agentId ?? ctx.agent_id ?? "unknown",
        action: `tool:${ctx.toolName ?? ctx.tool_name ?? "unknown"}`,
        resourceType: "tool",
        resourceId: ctx.toolName ?? ctx.tool_name ?? null,
        detail: ctx.error ? `error: ${ctx.error}` : null,
        outcome: ctx.error ? "error" : "success",
      });
    } catch (err) {
      log.debug(`[governance] Failed to audit tool call: ${err}`);
    }
  });

  log.info("[governance] Governance module initialized (budget + audit + RBAC + hooks)");
}

export { AuditLog } from "./audit-log.js";
export { BudgetLedger } from "./budget-ledger.js";
export { RbacEngine } from "./rbac.js";
export { estimateTokenCost as _estimateTokenCost };
