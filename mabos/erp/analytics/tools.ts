import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  /* ── Reports ──────────────────────────────────────────────────────── */
  {
    name: "create_report",
    description: "Create a new analytics report definition",
    params: ["name", "type", "query", "parameters?", "schedule?"],
    handler: async (pg, params) => {
      const report = await q.createReport(pg, params);
      await writeAuditLog(pg, "analytics", "create_report", report.id, params);
      return report;
    },
  },
  {
    name: "get_report",
    description: "Retrieve a report by ID",
    params: ["id"],
    handler: async (pg, { id }) => q.getReport(pg, id),
  },
  {
    name: "list_reports",
    description: "List reports with optional type/status filters",
    params: ["type?", "status?", "limit?"],
    handler: async (pg, params) => q.listReports(pg, params),
  },
  {
    name: "run_report",
    description: "Execute a report query and store the resulting snapshot",
    params: ["report_id"],
    handler: async (pg, { report_id }) => {
      const snapshot = await q.runReport(pg, report_id);
      await writeAuditLog(pg, "analytics", "run_report", report_id, {});
      return snapshot;
    },
  },
  {
    name: "delete_report",
    description: "Soft-delete (archive) a report",
    params: ["id"],
    handler: async (pg, { id }) => {
      const report = await q.deleteReport(pg, id);
      await writeAuditLog(pg, "analytics", "delete_report", id, {});
      return report;
    },
  },

  /* ── Dashboards ───────────────────────────────────────────────────── */
  {
    name: "create_dashboard",
    description: "Create a new dashboard with widget layout",
    params: ["name", "description?", "widgets?", "owner_id?"],
    handler: async (pg, params) => {
      const dashboard = await q.createDashboard(pg, params);
      await writeAuditLog(pg, "analytics", "create_dashboard", dashboard.id, params);
      return dashboard;
    },
  },
  {
    name: "get_dashboard",
    description: "Retrieve a dashboard by ID",
    params: ["id"],
    handler: async (pg, { id }) => q.getDashboard(pg, id),
  },
  {
    name: "list_dashboards",
    description: "List dashboards with optional owner filter",
    params: ["owner_id?", "limit?"],
    handler: async (pg, params) => q.listDashboards(pg, params),
  },

  /* ── Snapshots ────────────────────────────────────────────────────── */
  {
    name: "report_snapshots",
    description: "Get recent data snapshots for a report",
    params: ["report_id", "limit?"],
    handler: async (pg, { report_id, limit }) => q.getSnapshots(pg, report_id, limit),
  },
];

export const analyticsTool = createErpDomainTool({
  domain: "analytics",
  description:
    "Analytics and reporting — create reports, execute queries, manage dashboards, and browse historical snapshots.",
  actions,
});
