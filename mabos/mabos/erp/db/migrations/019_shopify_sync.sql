-- 019_shopify_sync.sql
-- Adds Shopify tracking columns to ERP tables for product/order/customer/inventory sync.
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.

BEGIN;

-- ============================================================
-- PRODUCTS: Shopify variant-level tracking
-- ============================================================
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS shopify_product_id BIGINT;
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS shopify_variant_id BIGINT;
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS shopify_handle TEXT;
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shopify_variant_id
  ON erp.products (shopify_variant_id);

-- Drop the original sku UNIQUE constraint so Shopify variants with
-- null/duplicate SKUs don't collide before hitting shopify_variant_id conflict.
ALTER TABLE erp.products DROP CONSTRAINT IF EXISTS products_sku_key;
DROP INDEX IF EXISTS products_sku_key;

-- ============================================================
-- ORDERS: Shopify order tracking
-- ============================================================
ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS shopify_order_id BIGINT;
ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS shopify_order_number TEXT;
ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_shopify_order_id
  ON erp.orders (shopify_order_id);

-- ============================================================
-- CONTACTS: Shopify customer tracking
-- ============================================================
ALTER TABLE erp.contacts ADD COLUMN IF NOT EXISTS shopify_customer_id BIGINT;
ALTER TABLE erp.contacts ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_shopify_customer_id
  ON erp.contacts (shopify_customer_id);

-- ============================================================
-- STOCK_ITEMS: Shopify inventory tracking
-- ============================================================
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS shopify_inventory_item_id BIGINT;
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS shopify_location_id BIGINT;
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS shopify_synced_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_shopify_inv
  ON erp.stock_items (shopify_inventory_item_id, shopify_location_id)
;

-- ============================================================
-- SYNC LOG: Audit trail for sync operations
-- ============================================================
CREATE TABLE IF NOT EXISTS erp.shopify_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  shopify_id BIGINT,
  action TEXT NOT NULL,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_entity ON erp.shopify_sync_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_shopify_sync_log_created ON erp.shopify_sync_log(created_at);

COMMIT;
