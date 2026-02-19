CREATE TABLE IF NOT EXISTS erp.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku TEXT UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price NUMERIC(15,2),
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL,
  status TEXT DEFAULT 'pending',
  total NUMERIC(15,2),
  currency TEXT DEFAULT 'USD',
  line_items JSONB DEFAULT '[]',
  shipping_address JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID,
  items JSONB DEFAULT '[]',
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
