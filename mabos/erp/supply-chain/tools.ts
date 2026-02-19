import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_shipment",
    description: "Create a new shipment",
    params: {},
    handler: async (params, ctx) => {
      const shipment = await q.createShipment(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "supply-chain",
        entityType: "shipment",
        entityId: shipment.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: shipment };
    },
  },
  {
    name: "get_shipment",
    description: "Retrieve a shipment by ID",
    params: {},
    handler: async (params, ctx) => {
      const shipment = await q.getShipment(ctx.pg, (params as any).id);
      return shipment ? { success: true, data: shipment } : { error: "Shipment not found" };
    },
  },
  {
    name: "list_shipments",
    description: "List shipments with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listShipments(ctx.pg, params as any) };
    },
  },
  {
    name: "update_shipment_status",
    description: "Update the status of a shipment",
    params: {},
    handler: async (params, ctx) => {
      const shipment = await q.updateShipmentStatus(
        ctx.pg,
        (params as any).id,
        (params as any).status,
      );
      if (!shipment) return { error: "Shipment not found" };
      await writeAuditLog(ctx.pg, {
        domain: "supply-chain",
        entityType: "shipment",
        entityId: shipment.id,
        action: "status_change",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "supply-chain",
        entityType: "shipment",
        trigger: "status_change",
        record: shipment,
      });
      return { success: true, data: shipment };
    },
  },
  {
    name: "track_shipment",
    description: "Track a shipment by tracking number",
    params: {},
    handler: async (params, ctx) => {
      const shipment = await q.trackShipment(ctx.pg, (params as any).tracking_number);
      return shipment
        ? { success: true, data: shipment }
        : { error: "No shipment found for that tracking number" };
    },
  },
  {
    name: "create_route",
    description: "Create a supply-chain route with legs",
    params: {},
    handler: async (params, ctx) => {
      const route = await q.createRoute(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "supply-chain",
        entityType: "route",
        entityId: route.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: route };
    },
  },
  {
    name: "list_routes",
    description: "List supply-chain routes",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listRoutes(ctx.pg, params as any) };
    },
  },
  {
    name: "get_route",
    description: "Retrieve a route by ID",
    params: {},
    handler: async (params, ctx) => {
      const route = await q.getRoute(ctx.pg, (params as any).id);
      return route ? { success: true, data: route } : { error: "Route not found" };
    },
  },
];

export const supplyChainTool = createErpDomainTool({
  domain: "supply-chain",
  description: "Supply-chain management - shipments, tracking, routes, carrier coordination",
  actions,
});
