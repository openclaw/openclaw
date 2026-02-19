CREATE TABLE IF NOT EXISTS erp.supply_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT,
  location TEXT,
  capacity JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.shipments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  origin_node_id UUID REFERENCES erp.supply_nodes(id),
  dest_node_id UUID REFERENCES erp.supply_nodes(id),
  order_id UUID,
  status TEXT DEFAULT 'pending',
  carrier TEXT,
  tracking JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
