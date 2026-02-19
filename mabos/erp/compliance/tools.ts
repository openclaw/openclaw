import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_policy",
    description: "Create a new compliance policy",
    params: {},
    handler: async (params, ctx) => {
      const policy = await q.createPolicy(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "compliance",
        entityType: "policy",
        entityId: policy.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: policy };
    },
  },
  {
    name: "get_policy",
    description: "Retrieve a compliance policy by ID",
    params: {},
    handler: async (params, ctx) => {
      const policy = await q.getPolicy(ctx.pg, (params as any).id);
      return policy ? { success: true, data: policy } : { error: "Policy not found" };
    },
  },
  {
    name: "list_policies",
    description: "List compliance policies with optional status and category filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listPolicies(ctx.pg, params as any) };
    },
  },
  {
    name: "update_policy",
    description: "Update an existing compliance policy",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const policy = await q.updatePolicy(ctx.pg, id, rest);
      if (!policy) return { error: "Policy not found or no changes" };
      await writeAuditLog(ctx.pg, {
        domain: "compliance",
        entityType: "policy",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      return { success: true, data: policy };
    },
  },
  {
    name: "report_violation",
    description: "Report a new compliance violation",
    params: {},
    handler: async (params, ctx) => {
      const violation = await q.reportViolation(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "compliance",
        entityType: "violation",
        entityId: violation.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "compliance",
        entityType: "violation",
        trigger: "create",
        record: violation,
      });
      return { success: true, data: violation };
    },
  },
  {
    name: "get_violation",
    description: "Retrieve a violation by ID",
    params: {},
    handler: async (params, ctx) => {
      const violation = await q.getViolation(ctx.pg, (params as any).id);
      return violation ? { success: true, data: violation } : { error: "Violation not found" };
    },
  },
  {
    name: "list_violations",
    description: "List violations with optional status, severity, and policy filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listViolations(ctx.pg, params as any) };
    },
  },
  {
    name: "resolve_violation",
    description: "Resolve a compliance violation with resolution notes",
    params: {},
    handler: async (params, ctx) => {
      const { id, resolution } = params as any;
      const violation = await q.resolveViolation(ctx.pg, id, resolution);
      if (!violation) return { error: "Violation not found" };
      await writeAuditLog(ctx.pg, {
        domain: "compliance",
        entityType: "violation",
        entityId: id,
        action: "resolve",
        agentId: ctx.agentId,
        payload: { resolution },
      });
      return { success: true, data: violation };
    },
  },
];

export const complianceTool = createErpDomainTool({
  domain: "compliance",
  description: "Compliance management - policies, violations, reporting, and resolution tracking",
  actions,
});
