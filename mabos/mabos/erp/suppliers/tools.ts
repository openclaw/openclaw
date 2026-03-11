import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_supplier",
    description: "Register a new supplier",
    params: {},
    handler: async (params, ctx) => {
      const supplier = await q.createSupplier(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "suppliers",
        entityType: "supplier",
        entityId: supplier.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: supplier };
    },
  },
  {
    name: "get_supplier",
    description: "Retrieve a supplier by ID",
    params: {},
    handler: async (params, ctx) => {
      const supplier = await q.getSupplier(ctx.pg, (params as any).id);
      return supplier ? { success: true, data: supplier } : { error: "Supplier not found" };
    },
  },
  {
    name: "list_suppliers",
    description: "List suppliers with optional status and category filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listSuppliers(ctx.pg, params as any) };
    },
  },
  {
    name: "update_supplier",
    description: "Update an existing supplier's information",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const supplier = await q.updateSupplier(ctx.pg, id, rest);
      if (!supplier) return { error: "Supplier not found or no changes" };
      await writeAuditLog(ctx.pg, {
        domain: "suppliers",
        entityType: "supplier",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "suppliers",
        entityType: "supplier",
        trigger: "update",
        record: supplier,
      });
      return { success: true, data: supplier };
    },
  },
  {
    name: "create_po",
    description: "Create a new purchase order for a supplier",
    params: {},
    handler: async (params, ctx) => {
      const po = await q.createPurchaseOrder(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "suppliers",
        entityType: "purchase_order",
        entityId: po.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: po };
    },
  },
  {
    name: "get_po",
    description: "Retrieve a purchase order by ID",
    params: {},
    handler: async (params, ctx) => {
      const po = await q.getPurchaseOrder(ctx.pg, (params as any).id);
      return po ? { success: true, data: po } : { error: "Purchase order not found" };
    },
  },
  {
    name: "list_pos",
    description: "List purchase orders with optional supplier and status filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listPurchaseOrders(ctx.pg, params as any) };
    },
  },
  {
    name: "receive_po",
    description: "Mark a purchase order as received",
    params: {},
    handler: async (params, ctx) => {
      const po = await q.receivePurchaseOrder(ctx.pg, (params as any).id);
      if (!po) return { error: "Purchase order not found" };
      await writeAuditLog(ctx.pg, {
        domain: "suppliers",
        entityType: "purchase_order",
        entityId: po.id,
        action: "receive",
        agentId: ctx.agentId,
        payload: { status: "received" },
      });
      return { success: true, data: po };
    },
  },
];

export const suppliersTool = createErpDomainTool({
  domain: "suppliers",
  description: "Supplier management - suppliers, purchase orders, procurement, and receiving",
  actions,
});
