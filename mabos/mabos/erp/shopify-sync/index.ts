/**
 * Shopify → ERP sync module.
 * Re-exports all sub-modules and provides webhook dispatch.
 */

export { fetchAllPages, fetchInventoryLevels, fetchLocations, fetchOne } from "./shopify-client.js";
export { mapProductVariant, mapOrder, mapCustomer, mapInventoryLevel } from "./mapper.js";
export type { ShopifyProduct, ShopifyVariant, ShopifyOrder, ShopifyCustomer } from "./mapper.js";
export type { ErpProductRow, ErpContactRow, ErpOrderRow, ErpStockItemRow } from "./mapper.js";
export { upsertProduct, upsertContact, upsertOrder, upsertStockItem, logSync } from "./upsert.js";

import type { PgClient } from "../db/postgres.js";
import type { ShopifyProduct, ShopifyOrder, ShopifyCustomer } from "./mapper.js";
import { mapProductVariant, mapOrder, mapCustomer, mapInventoryLevel } from "./mapper.js";
import { upsertProduct, upsertContact, upsertOrder, upsertStockItem, logSync } from "./upsert.js";

/**
 * Resolve a Shopify customer ID to an ERP contact UUID.
 * Returns null if not found.
 */
async function resolveCustomerId(pg: PgClient, shopifyCustomerId: number): Promise<string | null> {
  const result = await pg.query(
    `SELECT id FROM erp.contacts WHERE shopify_customer_id = $1 LIMIT 1`,
    [shopifyCustomerId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Resolve a Shopify variant ID to an ERP product UUID.
 */
async function resolveProductId(pg: PgClient, shopifyVariantId: number): Promise<string | null> {
  const result = await pg.query(
    `SELECT id FROM erp.products WHERE shopify_variant_id = $1 LIMIT 1`,
    [shopifyVariantId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Process an incoming Shopify webhook payload.
 * Called by the HTTP route handler in extensions/mabos/index.ts.
 */
export async function processShopifyWebhook(
  pg: PgClient,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    if (topic === "products/update" || topic === "products/create") {
      const product = payload as unknown as ShopifyProduct;
      for (const variant of product.variants ?? []) {
        const row = mapProductVariant(product, variant);
        const erpId = await upsertProduct(pg, row);
        await logSync(pg, "product", erpId, variant.id, "webhook_upsert", { topic });
      }
    } else if (topic === "orders/create" || topic === "orders/updated") {
      const order = payload as unknown as ShopifyOrder;

      // Resolve or create customer (orders.customer_id is NOT NULL)
      let customerId: string | null = null;
      if (order.customer?.id) {
        customerId = await resolveCustomerId(pg, order.customer.id);
        if (!customerId) {
          // Customer not yet synced — upsert inline
          const custRow = mapCustomer(order.customer as ShopifyCustomer);
          customerId = await upsertContact(pg, custRow);
        }
      }
      if (!customerId) {
        // Guest checkout — create synthetic contact
        customerId = await upsertContact(pg, {
          shopify_customer_id: -order.id,
          name: "Guest Checkout",
          email: null,
          phone: null,
          company: null,
        });
      }

      const mapped = mapOrder(order);
      const resolvedItems = [];
      for (const li of mapped.line_items) {
        const productId = li.variant_id ? await resolveProductId(pg, li.variant_id) : null;
        resolvedItems.push({
          product_id: productId ?? "unknown",
          quantity: li.quantity,
          unit_price: li.unit_price,
        });
      }

      const erpId = await upsertOrder(pg, mapped, customerId, resolvedItems);
      await logSync(pg, "order", erpId, order.id, "webhook_upsert", { topic });
    } else if (topic === "inventory_levels/update") {
      const level = payload as unknown as {
        inventory_item_id: number;
        location_id: number;
        available: number | null;
      };
      // Look up sku/name from existing product
      const existing = await pg.query(
        `SELECT sku, name FROM erp.stock_items WHERE shopify_inventory_item_id = $1 AND shopify_location_id = $2 LIMIT 1`,
        [level.inventory_item_id, level.location_id],
      );
      const sku = existing.rows[0]?.sku ?? "unknown";
      const name = existing.rows[0]?.name ?? "unknown";
      const row = mapInventoryLevel(level, sku, name);

      // Look up warehouse (stock_items.warehouse_id FK references erp.warehouses)
      const wh = await pg.query(
        `SELECT id FROM erp.warehouses WHERE metadata->>'shopify_location_id' = $1 LIMIT 1`,
        [String(level.location_id)],
      );
      const warehouseId = wh.rows[0]?.id ?? null;

      const erpId = await upsertStockItem(pg, row, warehouseId);
      await logSync(pg, "stock_item", erpId, level.inventory_item_id, "webhook_upsert", { topic });

      // Also update product stock_qty
      await pg.query(
        `UPDATE erp.products SET stock_qty = $1, updated_at = now()
         WHERE shopify_variant_id = (
           SELECT shopify_variant_id FROM erp.products
           WHERE shopify_product_id IN (
             SELECT shopify_product_id FROM erp.products p2
             JOIN erp.stock_items si ON si.sku = p2.sku
             WHERE si.shopify_inventory_item_id = $2
           )
           LIMIT 1
         )`,
        [level.available ?? 0, level.inventory_item_id],
      );
    }
  } catch (err) {
    console.error(`[shopify-sync] Webhook processing error (${topic}):`, err);
  }
}
