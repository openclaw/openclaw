/**
 * Governance HTTP routes — budget summary and audit log endpoints.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { AuditLog } from "./audit-log.js";
import type { BudgetLedger } from "./budget-ledger.js";

/**
 * Register governance HTTP routes on the plugin API.
 */
export function registerGovernanceRoutes(
  api: OpenClawPluginApi,
  ledger: BudgetLedger,
  audit: AuditLog,
): void {
  // GET /mabos/governance/budget/summary
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/governance/budget/summary",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const agentId = url.searchParams.get("agent_id") ?? "default";
        const companyId = url.searchParams.get("company_id") ?? "default";

        const status = ledger.getBudgetStatus(companyId, agentId);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });

  // GET /mabos/governance/audit
  api.registerHttpRoute({
    auth: "gateway",
    path: "/mabos/governance/audit",
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const params: Record<string, string | number | undefined> = {};

        const companyId = url.searchParams.get("company_id");
        if (companyId) params.companyId = companyId;

        const action = url.searchParams.get("action");
        if (action) params.action = action;

        const actorId = url.searchParams.get("actor_id");
        if (actorId) params.actorId = actorId;

        const from = url.searchParams.get("from");
        if (from) params.from = from;

        const to = url.searchParams.get("to");
        if (to) params.to = to;

        const limitStr = url.searchParams.get("limit");
        if (limitStr) params.limit = parseInt(limitStr, 10) || 100;

        const entries = audit.query(params as any);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ entries, count: entries.length }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    },
  });
}
