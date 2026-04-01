#!/usr/bin/env npx tsx
/**
 * Bulk Shopify → ERP sync script.
 * Run: npx tsx mabos/erp/shopify-sync/bulk-sync.ts
 *
 * 1. Products (one row per variant)
 * 2. Customers → contacts
 * 3. Orders (resolves customer + line_item product IDs)
 * 4. Inventory levels → stock_items (creates supply_nodes for new locations)
 * 5. Cleanup: removes old seed-data rows with no shopify_*_id
 */

import { getErpPgPool, closeErpPgPool } from "../db/postgres.js";
import {
  mapProductVariant,
  mapCustomer,
  mapOrder,
  mapInventoryLevel,
  type ShopifyProduct,
  type ShopifyCustomer,
  type ShopifyOrder,
  type ShopifyVariant,
} from "./mapper.js";
import { fetchAllPages, fetchInventoryLevels, fetchLocations } from "./shopify-client.js";
import { upsertProduct, upsertContact, upsertOrder, upsertStockItem, logSync } from "./upsert.js";

async function main() {
  const pg = getErpPgPool();
  console.log("[bulk-sync] Starting Shopify → ERP sync...\n");

  // ── 1. Products ──────────────────────────────────────────────
  console.log("[bulk-sync] Fetching products...");
  const products = await fetchAllPages<ShopifyProduct>("/products.json", "products");
  console.log(`[bulk-sync] Got ${products.length} products from Shopify`);

  // Build variant→sku/name lookup for inventory step
  const variantInfo = new Map<number, { sku: string; name: string; inventoryItemId: number }>();
  let productCount = 0;

  for (const product of products) {
    for (const variant of product.variants) {
      const row = mapProductVariant(product, variant);
      const erpId = await upsertProduct(pg, row);
      await logSync(pg, "product", erpId, variant.id, "bulk_sync");
      variantInfo.set(variant.id, {
        sku: row.sku,
        name: row.name,
        inventoryItemId: variant.inventory_item_id,
      });
      productCount++;
    }
  }
  console.log(`[bulk-sync] Upserted ${productCount} product variants\n`);

  // ── 2. Customers → Contacts ──────────────────────────────────
  console.log("[bulk-sync] Fetching customers...");
  const customers = await fetchAllPages<ShopifyCustomer>("/customers.json", "customers");
  console.log(`[bulk-sync] Got ${customers.length} customers from Shopify`);

  // Build shopify_customer_id → erp_id lookup
  const customerIdMap = new Map<number, string>();
  let contactCount = 0;

  for (const customer of customers) {
    const row = mapCustomer(customer);
    const erpId = await upsertContact(pg, row);
    await logSync(pg, "contact", erpId, customer.id, "bulk_sync");
    customerIdMap.set(customer.id, erpId);
    contactCount++;
  }
  console.log(`[bulk-sync] Upserted ${contactCount} contacts\n`);

  // ── 3. Orders ────────────────────────────────────────────────
  console.log("[bulk-sync] Fetching orders...");
  const orders = await fetchAllPages<ShopifyOrder>("/orders.json?status=any", "orders");
  console.log(`[bulk-sync] Got ${orders.length} orders from Shopify`);

  // Build shopify_variant_id → erp_product_id lookup
  const variantToErpProduct = new Map<number, string>();
  const variantRows = await pg.query(
    `SELECT id, shopify_variant_id FROM erp.products WHERE shopify_variant_id IS NOT NULL`,
  );
  for (const r of variantRows.rows) {
    variantToErpProduct.set(Number(r.shopify_variant_id), r.id);
  }

  let orderCount = 0;
  for (const order of orders) {
    const mapped = mapOrder(order);

    // Resolve customer
    let customerId: string | null = null;
    if (mapped.shopify_customer_id) {
      customerId = customerIdMap.get(mapped.shopify_customer_id) ?? null;
    }

    // For guest checkouts, create a synthetic contact
    if (!customerId && order.customer?.id) {
      // Customer exists in Shopify but wasn't in our fetch — rare, upsert inline
      const guestRow = mapCustomer(order.customer as ShopifyCustomer);
      customerId = await upsertContact(pg, guestRow);
      customerIdMap.set(order.customer.id, customerId);
    } else if (!customerId) {
      // True guest checkout — create a placeholder contact
      const guestId = await upsertContact(pg, {
        shopify_customer_id: -order.id, // negative ID as synthetic marker
        name: "Guest Checkout",
        email: null,
        phone: null,
        company: null,
      });
      customerId = guestId;
    }

    // Resolve line items
    const resolvedItems = mapped.line_items.map((li) => ({
      product_id: (li.variant_id ? variantToErpProduct.get(li.variant_id) : null) ?? "unknown",
      quantity: li.quantity,
      unit_price: li.unit_price,
    }));

    const erpId = await upsertOrder(pg, mapped, customerId, resolvedItems);
    await logSync(pg, "order", erpId, order.id, "bulk_sync");
    orderCount++;
  }
  console.log(`[bulk-sync] Upserted ${orderCount} orders\n`);

  // ── 4. Inventory Levels → Stock Items ────────────────────────
  console.log("[bulk-sync] Fetching locations...");
  const locations = await fetchLocations();
  console.log(`[bulk-sync] Got ${locations.length} locations`);

  // Create/update warehouses + supply_nodes for each Shopify location.
  // stock_items.warehouse_id FK references erp.warehouses, so we must insert there.
  // We also mirror into erp.supply_nodes for supply-chain features.
  const locationToWarehouse = new Map<number, string>();
  for (const loc of locations) {
    const locationStr = `${loc.city || ""}, ${loc.country || ""}`.trim().replace(/^,\s*/, "");
    const meta = JSON.stringify({ shopify_location_id: String(loc.id) });

    // Check if warehouse already exists for this Shopify location
    const existing = await pg.query(
      `SELECT id FROM erp.warehouses WHERE metadata->>'shopify_location_id' = $1 LIMIT 1`,
      [String(loc.id)],
    );

    let warehouseId: string;
    if (existing.rows[0]) {
      warehouseId = existing.rows[0].id;
      await pg.query(
        `UPDATE erp.warehouses SET name = $1, location = $2, updated_at = now() WHERE id = $3`,
        [loc.name, locationStr, warehouseId],
      );
    } else {
      const ins = await pg.query(
        `INSERT INTO erp.warehouses (id, name, location, metadata)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        [loc.name, locationStr, meta],
      );
      warehouseId = ins.rows[0].id;
    }

    // Mirror into supply_nodes with the same UUID
    const snExists = await pg.query(`SELECT id FROM erp.supply_nodes WHERE id = $1`, [warehouseId]);
    if (snExists.rows[0]) {
      await pg.query(
        `UPDATE erp.supply_nodes SET name = $1, location = $2, metadata = $3, updated_at = now() WHERE id = $4`,
        [loc.name, locationStr, meta, warehouseId],
      );
    } else {
      await pg.query(
        `INSERT INTO erp.supply_nodes (id, name, type, location, metadata)
         VALUES ($1, $2, 'warehouse', $3, $4)`,
        [warehouseId, loc.name, locationStr, meta],
      );
    }

    locationToWarehouse.set(loc.id, warehouseId);
  }

  // Collect all inventory item IDs from synced products
  const inventoryItemIds = [...variantInfo.values()].map((v) => v.inventoryItemId);
  console.log(`[bulk-sync] Fetching inventory levels for ${inventoryItemIds.length} items...`);

  const levels = await fetchInventoryLevels(inventoryItemIds);
  console.log(`[bulk-sync] Got ${levels.length} inventory level entries`);

  // Build inventory_item_id → variant info lookup
  const invItemToVariant = new Map<number, { sku: string; name: string }>();
  for (const [, info] of variantInfo) {
    invItemToVariant.set(info.inventoryItemId, { sku: info.sku, name: info.name });
  }

  let stockCount = 0;
  for (const level of levels) {
    const info = invItemToVariant.get(level.inventory_item_id);
    const row = mapInventoryLevel(level, info?.sku ?? "unknown", info?.name ?? "unknown");
    const warehouseId = locationToWarehouse.get(level.location_id) ?? null;
    const erpId = await upsertStockItem(pg, row, warehouseId);
    await logSync(pg, "stock_item", erpId, level.inventory_item_id, "bulk_sync");
    stockCount++;
  }
  console.log(`[bulk-sync] Upserted ${stockCount} stock items\n`);

  // ── 5. Cleanup: remove old seed data ─────────────────────────
  console.log("[bulk-sync] Cleaning up seed data...");

  const delStock = await pg.query(
    `DELETE FROM erp.stock_items WHERE shopify_inventory_item_id IS NULL RETURNING id`,
  );
  console.log(`[bulk-sync]   Removed ${delStock.rowCount} seed stock_items`);

  const delOrders = await pg.query(
    `DELETE FROM erp.orders WHERE shopify_order_id IS NULL RETURNING id`,
  );
  console.log(`[bulk-sync]   Removed ${delOrders.rowCount} seed orders`);

  const delProducts = await pg.query(
    `DELETE FROM erp.products WHERE shopify_variant_id IS NULL RETURNING id`,
  );
  console.log(`[bulk-sync]   Removed ${delProducts.rowCount} seed products`);

  // Don't delete seed contacts that might have other ERP references
  // Only remove ones that aren't referenced by any remaining orders
  const delContacts = await pg.query(
    `DELETE FROM erp.contacts
     WHERE shopify_customer_id IS NULL
       AND id NOT IN (SELECT DISTINCT customer_id FROM erp.orders WHERE customer_id IS NOT NULL)
     RETURNING id`,
  );
  console.log(`[bulk-sync]   Removed ${delContacts.rowCount} orphan seed contacts`);

  console.log("\n[bulk-sync] Done!");
  console.log(`  Products:    ${productCount}`);
  console.log(`  Contacts:    ${contactCount}`);
  console.log(`  Orders:      ${orderCount}`);
  console.log(`  Stock Items: ${stockCount}`);

  await closeErpPgPool();
}

main().catch((err) => {
  console.error("[bulk-sync] Fatal error:", err);
  process.exit(1);
});
