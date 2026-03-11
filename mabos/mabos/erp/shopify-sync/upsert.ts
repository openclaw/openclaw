/**
 * PostgreSQL upsert functions for Shopify → ERP sync.
 * Uses ON CONFLICT with the shopify_*_id unique indexes from migration 019.
 */

import type { PgClient } from "../db/postgres.js";
import type { ErpProductRow, ErpContactRow, ErpOrderRow, ErpStockItemRow } from "./mapper.js";

/**
 * Upsert a product row keyed by shopify_variant_id.
 * Returns the ERP UUID of the upserted row.
 */
export async function upsertProduct(pg: PgClient, row: ErpProductRow): Promise<string> {
  const result = await pg.query(
    `INSERT INTO erp.products
       (id, shopify_product_id, shopify_variant_id, shopify_handle, sku, name, description, price, currency, category, stock_qty, status, shopify_synced_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (shopify_variant_id) DO UPDATE SET
       shopify_product_id = EXCLUDED.shopify_product_id,
       shopify_handle = EXCLUDED.shopify_handle,
       sku = EXCLUDED.sku,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       price = EXCLUDED.price,
       currency = EXCLUDED.currency,
       category = EXCLUDED.category,
       stock_qty = EXCLUDED.stock_qty,
       status = EXCLUDED.status,
       shopify_synced_at = now(),
       updated_at = now()
     RETURNING id`,
    [
      row.shopify_product_id,
      row.shopify_variant_id,
      row.shopify_handle,
      row.sku,
      row.name,
      row.description,
      row.price,
      row.currency,
      row.category,
      row.stock_qty,
      row.status,
    ],
  );
  return result.rows[0].id;
}

/**
 * Upsert a contact row keyed by shopify_customer_id.
 * Returns the ERP UUID.
 */
export async function upsertContact(pg: PgClient, row: ErpContactRow): Promise<string> {
  const result = await pg.query(
    `INSERT INTO erp.contacts
       (id, shopify_customer_id, name, email, phone, company, lifecycle_stage, shopify_synced_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, 'customer', now())
     ON CONFLICT (shopify_customer_id) DO UPDATE SET
       name = EXCLUDED.name,
       email = EXCLUDED.email,
       phone = EXCLUDED.phone,
       company = EXCLUDED.company,
       shopify_synced_at = now(),
       updated_at = now()
     RETURNING id`,
    [row.shopify_customer_id, row.name, row.email, row.phone, row.company],
  );
  return result.rows[0].id;
}

/**
 * Upsert an order row keyed by shopify_order_id.
 * Requires customer_id (ERP UUID) and resolved line_items with ERP product_ids.
 */
export async function upsertOrder(
  pg: PgClient,
  row: ErpOrderRow,
  customerId: string | null,
  resolvedLineItems: Array<{ product_id: string; quantity: number; unit_price: number }>,
): Promise<string> {
  const result = await pg.query(
    `INSERT INTO erp.orders
       (id, shopify_order_id, shopify_order_number, customer_id, status, total, subtotal, tax, currency, line_items, shipping_address, shopify_synced_at, created_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11::timestamptz)
     ON CONFLICT (shopify_order_id) DO UPDATE SET
       shopify_order_number = EXCLUDED.shopify_order_number,
       customer_id = EXCLUDED.customer_id,
       status = EXCLUDED.status,
       total = EXCLUDED.total,
       subtotal = EXCLUDED.subtotal,
       tax = EXCLUDED.tax,
       line_items = EXCLUDED.line_items,
       shipping_address = EXCLUDED.shipping_address,
       shopify_synced_at = now(),
       updated_at = now()
     RETURNING id`,
    [
      row.shopify_order_id,
      row.shopify_order_number,
      customerId,
      row.status,
      row.total,
      row.subtotal,
      row.tax,
      row.currency,
      JSON.stringify(resolvedLineItems),
      row.shipping_address ? JSON.stringify(row.shipping_address) : null,
      row.created_at,
    ],
  );
  return result.rows[0].id;
}

/**
 * Upsert a stock item keyed by (shopify_inventory_item_id, shopify_location_id).
 */
export async function upsertStockItem(
  pg: PgClient,
  row: ErpStockItemRow,
  warehouseId: string | null,
): Promise<string> {
  const result = await pg.query(
    `INSERT INTO erp.stock_items
       (id, shopify_inventory_item_id, shopify_location_id, sku, name, quantity, warehouse_id, status, shopify_synced_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'active', now())
     ON CONFLICT (shopify_inventory_item_id, shopify_location_id) DO UPDATE SET
       sku = EXCLUDED.sku,
       name = EXCLUDED.name,
       quantity = EXCLUDED.quantity,
       warehouse_id = EXCLUDED.warehouse_id,
       shopify_synced_at = now(),
       updated_at = now()
     RETURNING id`,
    [
      row.shopify_inventory_item_id,
      row.shopify_location_id,
      row.sku,
      row.name,
      row.quantity,
      warehouseId,
    ],
  );
  return result.rows[0].id;
}

/**
 * Log a sync action to erp.shopify_sync_log.
 */
export async function logSync(
  pg: PgClient,
  entityType: string,
  entityId: string | null,
  shopifyId: number,
  action: string,
  details?: Record<string, unknown>,
): Promise<void> {
  await pg.query(
    `INSERT INTO erp.shopify_sync_log (entity_type, entity_id, shopify_id, action, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [entityType, entityId, shopifyId, action, JSON.stringify(details ?? {})],
  );
}
