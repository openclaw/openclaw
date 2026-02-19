CREATE TABLE IF NOT EXISTS erp.contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  party TEXT,
  type TEXT,
  status TEXT DEFAULT 'draft',
  effective_date DATE,
  expiry_date DATE,
  terms JSONB DEFAULT '{}',
  document_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  approver_agent_id TEXT,
  status TEXT DEFAULT 'pending',
  comments TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
