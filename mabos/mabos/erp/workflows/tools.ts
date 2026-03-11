import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  /* ── Workflow definitions ─────────────────────────────────────────── */
  {
    name: "create_workflow",
    description: "Create a new workflow definition with trigger and steps",
    params: {},
    handler: async (params, ctx) => {
      const workflow = await q.createWorkflow(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow",
        entityId: workflow.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: workflow };
    },
  },
  {
    name: "get_workflow",
    description: "Retrieve a workflow by ID",
    params: {},
    handler: async (params, ctx) => {
      const workflow = await q.getWorkflow(ctx.pg, (params as any).id);
      return workflow ? { success: true, data: workflow } : { error: "Workflow not found" };
    },
  },
  {
    name: "list_workflows",
    description: "List workflows with optional status/trigger filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listWorkflows(ctx.pg, params as any) };
    },
  },
  {
    name: "update_workflow",
    description: "Update a workflow definition (auto-increments version)",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const workflow = await q.updateWorkflow(ctx.pg, id, rest);
      if (!workflow) return { error: "Workflow not found" };
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      return { success: true, data: workflow };
    },
  },

  /* ── Workflow runs ────────────────────────────────────────────────── */
  {
    name: "start_run",
    description: "Start a new workflow run",
    params: {},
    handler: async (params, ctx) => {
      const run = await q.createRun(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow_run",
        entityId: run.id,
        action: "start_run",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: run };
    },
  },
  {
    name: "get_run",
    description: "Retrieve a workflow run by ID",
    params: {},
    handler: async (params, ctx) => {
      const run = await q.getRun(ctx.pg, (params as any).id);
      return run ? { success: true, data: run } : { error: "Run not found" };
    },
  },
  {
    name: "list_runs",
    description: "List workflow runs with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listRuns(ctx.pg, params as any) };
    },
  },
  {
    name: "advance_step",
    description: "Advance a running workflow to the next step (auto-completes when all steps done)",
    params: {},
    handler: async (params, ctx) => {
      const run = await q.advanceStep(ctx.pg, (params as any).run_id);
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow_run",
        entityId: (params as any).run_id,
        action: "advance_step",
        agentId: ctx.agentId,
      });
      return { success: true, data: run };
    },
  },
  {
    name: "fail_run",
    description: "Mark a workflow run as failed with an error message",
    params: {},
    handler: async (params, ctx) => {
      const run = await q.failRun(ctx.pg, (params as any).run_id, (params as any).error);
      if (!run) return { error: "Run not found" };
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow_run",
        entityId: (params as any).run_id,
        action: "fail_run",
        agentId: ctx.agentId,
        payload: { error: (params as any).error },
      });
      return { success: true, data: run };
    },
  },
  {
    name: "complete_run",
    description: "Manually mark a workflow run as completed",
    params: {},
    handler: async (params, ctx) => {
      const run = await q.completeRun(ctx.pg, (params as any).run_id);
      if (!run) return { error: "Run not found" };
      await writeAuditLog(ctx.pg, {
        domain: "workflows",
        entityType: "workflow_run",
        entityId: (params as any).run_id,
        action: "complete_run",
        agentId: ctx.agentId,
      });
      return { success: true, data: run };
    },
  },
];

export const workflowsTool = createErpDomainTool({
  domain: "workflows",
  description:
    "Workflow automation — define multi-step workflows with triggers, start runs, advance through steps, and track execution status.",
  actions,
});
