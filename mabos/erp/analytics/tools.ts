import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  /* ── Reports ──────────────────────────────────────────────────────── */
  {
    name: "create_report",
    description: "Create a new analytics report definition",
    params: {},
    handler: async (params, ctx) => {
      const report = await q.createReport(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "analytics",
        entityType: "report",
        entityId: report.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: report };
    },
  },
  {
    name: "get_report",
    description: "Retrieve a report by ID",
    params: {},
    handler: async (params, ctx) => {
      const report = await q.getReport(ctx.pg, (params as any).id);
      return report ? { success: true, data: report } : { error: "Report not found" };
    },
  },
  {
    name: "list_reports",
    description: "List reports with optional type/status filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listReports(ctx.pg, params as any) };
    },
  },
  {
    name: "run_report",
    description: "Execute a report query and store the resulting snapshot",
    params: {},
    handler: async (params, ctx) => {
      const snapshot = await q.runReport(ctx.pg, (params as any).report_id);
      await writeAuditLog(ctx.pg, {
        domain: "analytics",
        entityType: "report",
        entityId: (params as any).report_id,
        action: "run_report",
        agentId: ctx.agentId,
      });
      return { success: true, data: snapshot };
    },
  },
  {
    name: "delete_report",
    description: "Soft-delete (archive) a report",
    params: {},
    handler: async (params, ctx) => {
      const report = await q.deleteReport(ctx.pg, (params as any).id);
      if (!report) return { error: "Report not found" };
      await writeAuditLog(ctx.pg, {
        domain: "analytics",
        entityType: "report",
        entityId: (params as any).id,
        action: "delete",
        agentId: ctx.agentId,
      });
      return { success: true, data: report };
    },
  },

  /* ── Dashboards ───────────────────────────────────────────────────── */
  {
    name: "create_dashboard",
    description: "Create a new dashboard with widget layout",
    params: {},
    handler: async (params, ctx) => {
      const dashboard = await q.createDashboard(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "analytics",
        entityType: "dashboard",
        entityId: dashboard.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: dashboard };
    },
  },
  {
    name: "get_dashboard",
    description: "Retrieve a dashboard by ID",
    params: {},
    handler: async (params, ctx) => {
      const dashboard = await q.getDashboard(ctx.pg, (params as any).id);
      return dashboard ? { success: true, data: dashboard } : { error: "Dashboard not found" };
    },
  },
  {
    name: "list_dashboards",
    description: "List dashboards with optional owner filter",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listDashboards(ctx.pg, params as any) };
    },
  },

  /* ── Snapshots ────────────────────────────────────────────────────── */
  {
    name: "report_snapshots",
    description: "Get recent data snapshots for a report",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.getSnapshots(ctx.pg, (params as any).report_id, (params as any).limit),
      };
    },
  },
];

export const analyticsTool = createErpDomainTool({
  domain: "analytics",
  description:
    "Analytics and reporting — create reports, execute queries, manage dashboards, and browse historical snapshots.",
  actions,
});
