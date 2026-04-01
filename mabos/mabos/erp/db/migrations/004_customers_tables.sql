CREATE TABLE IF NOT EXISTS erp.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  segment TEXT,
  lifecycle_stage TEXT DEFAULT 'lead',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES erp.contacts(id),
  channel TEXT,
  type TEXT,
  summary TEXT,
  sentiment NUMERIC(3,2),
  agent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
