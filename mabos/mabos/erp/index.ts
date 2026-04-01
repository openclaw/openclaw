/**
 * ERP Domain Tools – Barrel Export & Registry
 *
 * Registers all 13 domain tools and provides the BDI sync heartbeat
 * that keeps cognitive-layer markdown in sync with ERP state.
 */

import { analyticsTool } from "./analytics/tools.js";
import { complianceTool } from "./compliance/tools.js";
// ── Domain tools ──────────────────────────────────────────────────────
import { customersTool } from "./customers/tools.js";
// ── Shared infrastructure ─────────────────────────────────────────────
import { getErpPgPool, closeErpPgPool } from "./db/postgres.js";
import { ecommerceTool } from "./ecommerce/tools.js";
import { financeTool } from "./finance/tools.js";
import { hrTool } from "./hr/tools.js";
import { inventoryTool } from "./inventory/tools.js";
import { legalTool } from "./legal/tools.js";
import { marketingTool } from "./marketing/tools.js";
import { projectsTool } from "./projects/tools.js";
import { BdiSyncEngine } from "./shared/bdi-sync.js";
import type { ErpTool, ErpToolContext } from "./shared/tool-factory.js";
import { suppliersTool } from "./suppliers/tools.js";
import { supplyChainTool } from "./supply-chain/tools.js";
import { workflowsTool } from "./workflows/tools.js";

// ── Tool registry ─────────────────────────────────────────────────────
export const ERP_TOOLS: ErpTool[] = [
  customersTool,
  financeTool,
  hrTool,
  ecommerceTool,
  suppliersTool,
  legalTool,
  complianceTool,
  inventoryTool,
  supplyChainTool,
  projectsTool,
  marketingTool,
  analyticsTool,
  workflowsTool,
];

// ── Context factory ───────────────────────────────────────────────────
export function createErpContext(agentId: string, agentDir: string): ErpToolContext {
  const pg = getErpPgPool();
  const syncEngine = new BdiSyncEngine(pg);
  return { pg, agentId, agentDir, syncEngine };
}

// ── BDI heartbeat ─────────────────────────────────────────────────────
export function startErpHeartbeat(ctx: ErpToolContext, intervalMs = 30_000): { stop: () => void } {
  let previousState: Record<string, string> = {};

  const timer = setInterval(async () => {
    try {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");

      const currentState: Record<string, string> = {};
      for (const file of ["Desires.md", "Goals.md", "Intentions.md"]) {
        try {
          currentState[file] = await readFile(join(ctx.agentDir, file), "utf-8");
        } catch {
          currentState[file] = "";
        }
      }

      if (Object.keys(previousState).length > 0) {
        await ctx.syncEngine?.syncBdiToErp({
          agentDir: ctx.agentDir,
          agentId: ctx.agentId,
          previousState: {
            desires: previousState["Desires.md"] ?? "",
            goals: previousState["Goals.md"] ?? "",
            intentions: previousState["Intentions.md"] ?? "",
          },
          currentState: {
            desires: currentState["Desires.md"] ?? "",
            goals: currentState["Goals.md"] ?? "",
            intentions: currentState["Intentions.md"] ?? "",
          },
        });
      }

      previousState = currentState;
    } catch (err) {
      console.error("[erp-heartbeat] sync error:", err);
    }
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      closeErpPgPool();
    },
  };
}

// ── Re-exports ────────────────────────────────────────────────────────
export type { ErpTool, ErpToolContext } from "./shared/tool-factory.js";
export type { ErpAction } from "./shared/tool-factory.js";
export type { BdiSyncEngine } from "./shared/bdi-sync.js";
export { getErpPgPool, closeErpPgPool } from "./db/postgres.js";
export { writeAuditLog, queryAuditLog } from "./shared/audit.js";
