CREATE TABLE IF NOT EXISTS erp.compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT,
  name TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'medium',
  check_query TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES erp.compliance_rules(id),
  status TEXT DEFAULT 'pending',
  findings JSONB DEFAULT '{}',
  auditor_agent_id TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID REFERENCES erp.compliance_rules(id),
  entity_type TEXT,
  entity_id UUID,
  severity TEXT DEFAULT 'medium',
  resolution TEXT,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
