import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  /* ── Workflow definitions ─────────────────────────────────────────── */
  {
    name: "create_workflow",
    description: "Create a new workflow definition with trigger and steps",
    params: ["name", "description?", "trigger", "steps", "status?"],
    handler: async (pg, params) => {
      const workflow = await q.createWorkflow(pg, params);
      await writeAuditLog(pg, "workflows", "create_workflow", workflow.id, params);
      return workflow;
    },
  },
  {
    name: "get_workflow",
    description: "Retrieve a workflow by ID",
    params: ["id"],
    handler: async (pg, { id }) => q.getWorkflow(pg, id),
  },
  {
    name: "list_workflows",
    description: "List workflows with optional status/trigger filters",
    params: ["status?", "trigger?", "limit?"],
    handler: async (pg, params) => q.listWorkflows(pg, params),
  },
  {
    name: "update_workflow",
    description: "Update a workflow definition (auto-increments version)",
    params: ["id", "name?", "description?", "trigger?", "steps?", "status?"],
    handler: async (pg, { id, ...rest }) => {
      const workflow = await q.updateWorkflow(pg, id, rest);
      await writeAuditLog(pg, "workflows", "update_workflow", id, rest);
      return workflow;
    },
  },

  /* ── Workflow runs ────────────────────────────────────────────────── */
  {
    name: "start_run",
    description: "Start a new workflow run",
    params: ["workflow_id", "context?"],
    handler: async (pg, params) => {
      const run = await q.createRun(pg, params);
      await writeAuditLog(pg, "workflows", "start_run", run.id, params);
      return run;
    },
  },
  {
    name: "get_run",
    description: "Retrieve a workflow run by ID",
    params: ["id"],
    handler: async (pg, { id }) => q.getRun(pg, id),
  },
  {
    name: "list_runs",
    description: "List workflow runs with optional filters",
    params: ["workflow_id?", "status?", "limit?"],
    handler: async (pg, params) => q.listRuns(pg, params),
  },
  {
    name: "advance_step",
    description: "Advance a running workflow to the next step (auto-completes when all steps done)",
    params: ["run_id"],
    handler: async (pg, { run_id }) => {
      const run = await q.advanceStep(pg, run_id);
      await writeAuditLog(pg, "workflows", "advance_step", run_id, {});
      return run;
    },
  },
  {
    name: "fail_run",
    description: "Mark a workflow run as failed with an error message",
    params: ["run_id", "error"],
    handler: async (pg, { run_id, error }) => {
      const run = await q.failRun(pg, run_id, error);
      await writeAuditLog(pg, "workflows", "fail_run", run_id, { error });
      return run;
    },
  },
  {
    name: "complete_run",
    description: "Manually mark a workflow run as completed",
    params: ["run_id"],
    handler: async (pg, { run_id }) => {
      const run = await q.completeRun(pg, run_id);
      await writeAuditLog(pg, "workflows", "complete_run", run_id, {});
      return run;
    },
  },
];

export const workflowsTool = createErpDomainTool({
  domain: "workflows",
  description:
    "Workflow automation — define multi-step workflows with triggers, start runs, advance through steps, and track execution status.",
  actions,
});
