import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_campaign",
    description: "Create a new marketing campaign",
    params: {},
    handler: async (params, ctx) => {
      const campaign = await q.createCampaign(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "marketing",
        entityType: "campaign",
        entityId: campaign.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "marketing",
        entityType: "campaign",
        trigger: "create",
        record: campaign,
      });
      return { success: true, data: campaign };
    },
  },
  {
    name: "get_campaign",
    description: "Retrieve a campaign by ID",
    params: {},
    handler: async (params, ctx) => {
      const campaign = await q.getCampaign(ctx.pg, (params as any).id);
      return campaign ? { success: true, data: campaign } : { error: "Campaign not found" };
    },
  },
  {
    name: "list_campaigns",
    description: "List campaigns with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listCampaigns(ctx.pg, params as any) };
    },
  },
  {
    name: "update_campaign",
    description: "Update campaign fields",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const campaign = await q.updateCampaign(ctx.pg, id, rest);
      if (!campaign) return { error: "Campaign not found or no fields to update" };
      await writeAuditLog(ctx.pg, {
        domain: "marketing",
        entityType: "campaign",
        entityId: campaign.id,
        action: "update",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: campaign };
    },
  },
  {
    name: "record_metric",
    description: "Record a metric value for a campaign",
    params: {},
    handler: async (params, ctx) => {
      const metric = await q.recordMetric(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "marketing",
        entityType: "campaign_metric",
        entityId: metric.id,
        action: "record",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: metric };
    },
  },
  {
    name: "campaign_metrics",
    description: "Get metrics for a campaign",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.getCampaignMetrics(
          ctx.pg,
          (params as any).campaign_id,
          (params as any).limit,
        ),
      };
    },
  },
  {
    name: "create_kpi",
    description: "Create a marketing KPI",
    params: {},
    handler: async (params, ctx) => {
      const kpi = await q.createKpi(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "marketing",
        entityType: "kpi",
        entityId: kpi.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: kpi };
    },
  },
  {
    name: "list_kpis",
    description: "List KPIs with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listKpis(ctx.pg, params as any) };
    },
  },
  {
    name: "update_kpi",
    description: "Update KPI fields (e.g. current value)",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const kpi = await q.updateKpi(ctx.pg, id, rest);
      if (!kpi) return { error: "KPI not found or no fields to update" };
      await writeAuditLog(ctx.pg, {
        domain: "marketing",
        entityType: "kpi",
        entityId: kpi.id,
        action: "update",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: kpi };
    },
  },
];

export const marketingTool = createErpDomainTool({
  domain: "marketing",
  description:
    "Marketing management - campaigns, metrics, KPIs, audience targeting, channel coordination",
  actions,
});
