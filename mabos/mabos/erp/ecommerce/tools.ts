import { writeAuditLog } from "../shared/audit.js";
import { createErpDomainTool } from "../shared/tool-factory.js";
import type { ErpAction } from "../shared/tool-factory.js";
import * as q from "./queries.js";

const actions: ErpAction[] = [
  {
    name: "create_product",
    description: "Create a new product listing",
    params: {},
    handler: async (params, ctx) => {
      const product = await q.createProduct(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "ecommerce",
        entityType: "product",
        entityId: product.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      return { success: true, data: product };
    },
  },
  {
    name: "get_product",
    description: "Retrieve a product by ID",
    params: {},
    handler: async (params, ctx) => {
      const product = await q.getProduct(ctx.pg, (params as any).id);
      return product ? { success: true, data: product } : { error: "Product not found" };
    },
  },
  {
    name: "list_products",
    description: "List products with optional category and status filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listProducts(ctx.pg, params as any) };
    },
  },
  {
    name: "update_product",
    description: "Update an existing product",
    params: {},
    handler: async (params, ctx) => {
      const { id, ...rest } = params as any;
      const product = await q.updateProduct(ctx.pg, id, rest);
      if (!product) return { error: "Product not found or no changes" };
      await writeAuditLog(ctx.pg, {
        domain: "ecommerce",
        entityType: "product",
        entityId: id,
        action: "update",
        agentId: ctx.agentId,
        payload: rest,
      });
      return { success: true, data: product };
    },
  },
  {
    name: "create_order",
    description: "Create a new customer order with automatic tax calculation",
    params: {},
    handler: async (params, ctx) => {
      const order = await q.createOrder(ctx.pg, params as any);
      await writeAuditLog(ctx.pg, {
        domain: "ecommerce",
        entityType: "order",
        entityId: order.id,
        action: "create",
        agentId: ctx.agentId,
        payload: params as any,
      });
      await ctx.syncEngine?.syncErpToBdi({
        agentDir: ctx.agentDir,
        agentId: ctx.agentId,
        domain: "ecommerce",
        entityType: "order",
        trigger: "create",
        record: order,
      });
      return { success: true, data: order };
    },
  },
  {
    name: "get_order",
    description: "Retrieve an order by ID",
    params: {},
    handler: async (params, ctx) => {
      const order = await q.getOrder(ctx.pg, (params as any).id);
      return order ? { success: true, data: order } : { error: "Order not found" };
    },
  },
  {
    name: "list_orders",
    description: "List orders with optional status and customer filters",
    params: {},
    handler: async (params, ctx) => {
      return { success: true, data: await q.listOrders(ctx.pg, params as any) };
    },
  },
  {
    name: "update_order_status",
    description: "Update the status of an order (auto-sets shipped_at when status is 'shipped')",
    params: {},
    handler: async (params, ctx) => {
      const { id, status } = params as any;
      const order = await q.updateOrderStatus(ctx.pg, id, status);
      if (!order) return { error: "Order not found" };
      await writeAuditLog(ctx.pg, {
        domain: "ecommerce",
        entityType: "order",
        entityId: id,
        action: "status_change",
        agentId: ctx.agentId,
        payload: { status },
      });
      return { success: true, data: order };
    },
  },
];

export const ecommerceTool = createErpDomainTool({
  domain: "ecommerce",
  description: "E-commerce management - products, orders, inventory, and order fulfillment",
  actions,
});
