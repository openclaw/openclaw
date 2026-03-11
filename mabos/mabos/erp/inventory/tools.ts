import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_item",
    description: "Create a new stock item in inventory",
    params: {},
    handler: async (params, ctx) => {
      const item = await q.createStockItem(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "inventory",
        entityType: "stock_item",
        entityId: item.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: item };
    },
  },
  {
    name: "get_item",
    description: "Retrieve a stock item by ID",
    params: {},
    handler: async (params, ctx) => {
      const item = await q.getStockItem(ctx.pg, (params as any).id);
      return item ? { success: true, data: item } : { error: "Stock item not found" };
    },
  },
  {
    name: "list_items",
    description: "List stock items with optional filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listStockItems(ctx.pg, params as any) };
    },
  },
  {
    name: "adjust_stock",
    description: "Record a stock movement (in, out, or adjustment) and update quantity",
    params: {},
    handler: async (params, ctx) => {
      const movement = await q.adjustStock(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "inventory",
        entityType: "stock_movement",
        entityId: movement.id,
        action: "adjust",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: movement };
    },
  },
  {
    name: "low_stock_alerts",
    description: "Get items at or below their reorder point (or custom threshold)",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.lowStockAlerts(ctx.pg, (params as any).threshold),
      };
    },
  },
  {
    name: "stock_movements",
    description: "Get movement history for a stock item",
    params: {},
    handler: async (params, ctx) => {
      return {
        success: true,
        data: await q.getStockMovements(
          ctx.pg,
          (params as any).stock_item_id,
          (params as any).limit,
        ),
      };
    },
  },
];

export const inventoryTool = createErpDomainTool({
  domain: "inventory",
  description: "Inventory management - stock items, movements, adjustments, low-stock alerts",
  actions,
});
