-- 017_schema_alignment.sql
-- Aligns DB schema with ERP query function expectations.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.

BEGIN;

-- ============================================================
-- INVENTORY: stock_items missing columns + stock_movements table
-- ============================================================
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE erp.stock_items ADD COLUMN IF NOT EXISTS unit TEXT;

CREATE TABLE IF NOT EXISTS erp.stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_item_id UUID REFERENCES erp.stock_items(id),
  type TEXT NOT NULL CHECK (type IN ('in', 'out', 'adjustment')),
  quantity NUMERIC NOT NULL,
  reason TEXT,
  reference TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- ECOMMERCE: products missing columns, orders missing columns
-- ============================================================
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE erp.products ADD COLUMN IF NOT EXISTS stock_qty INTEGER DEFAULT 0;

ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC;
ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS tax NUMERIC;
ALTER TABLE erp.orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;

-- ============================================================
-- SUPPLY CHAIN: shipments missing columns + routes table
-- ============================================================
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS supplier_id UUID;
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS destination TEXT;
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS estimated_arrival TIMESTAMPTZ;
ALTER TABLE erp.shipments ADD COLUMN IF NOT EXISTS actual_arrival TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS erp.routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  legs JSONB DEFAULT '[]',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- COMPLIANCE: policies table + violations missing columns
-- ============================================================
CREATE TABLE IF NOT EXISTS erp.policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT,
  version TEXT DEFAULT '1.0',
  status TEXT DEFAULT 'draft',
  effective_date DATE,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE erp.violations ADD COLUMN IF NOT EXISTS policy_id UUID;
ALTER TABLE erp.violations ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
ALTER TABLE erp.violations ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE erp.violations ADD COLUMN IF NOT EXISTS reported_by TEXT;
ALTER TABLE erp.violations ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

-- ============================================================
-- MARKETING: campaigns missing columns + campaign_metrics table
-- ============================================================
ALTER TABLE erp.campaigns ADD COLUMN IF NOT EXISTS target_audience TEXT;
ALTER TABLE erp.campaigns ADD COLUMN IF NOT EXISTS channels JSONB DEFAULT '[]';

CREATE TABLE IF NOT EXISTS erp.campaign_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES erp.campaigns(id),
  metric_type TEXT NOT NULL,
  value NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE erp.kpis ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE erp.kpis ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- ============================================================
-- SUPPLIERS: missing terms column + purchase_orders table
-- ============================================================
ALTER TABLE erp.suppliers ADD COLUMN IF NOT EXISTS terms TEXT;

CREATE TABLE IF NOT EXISTS erp.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID REFERENCES erp.suppliers(id),
  items JSONB DEFAULT '[]',
  total_cost NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'draft',
  expected_delivery DATE,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================
-- ANALYTICS: reports table, data_snapshots table, dashboards columns
-- ============================================================
CREATE TABLE IF NOT EXISTS erp.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT,
  query TEXT,
  parameters JSONB DEFAULT '{}',
  schedule TEXT,
  status TEXT DEFAULT 'active',
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.data_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID REFERENCES erp.reports(id),
  data JSONB DEFAULT '{}',
  generated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE erp.dashboards ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE erp.dashboards ADD COLUMN IF NOT EXISTS widgets JSONB DEFAULT '[]';
ALTER TABLE erp.dashboards ADD COLUMN IF NOT EXISTS owner_id TEXT;

-- ============================================================
-- INDEXES for new tables
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_stock_movements_item ON erp.stock_movements(stock_item_id);
CREATE INDEX IF NOT EXISTS idx_campaign_metrics_campaign ON erp.campaign_metrics(campaign_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON erp.purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_data_snapshots_report ON erp.data_snapshots(report_id);
CREATE INDEX IF NOT EXISTS idx_policies_status ON erp.policies(status);
CREATE INDEX IF NOT EXISTS idx_routes_status ON erp.routes(status);

COMMIT;
