CREATE TABLE IF NOT EXISTS erp.kpis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,
  name TEXT NOT NULL,
  query TEXT,
  target NUMERIC,
  current NUMERIC DEFAULT 0,
  unit TEXT,
  period TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.dashboards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_agent_id TEXT,
  layout JSONB DEFAULT '{}',
  kpi_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
