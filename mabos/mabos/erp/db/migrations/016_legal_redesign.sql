-- Legal Module Redesign: Partnership contracts, freelancer contracts,
-- corporate documents, legal structure, and compliance guardrails.

CREATE TABLE IF NOT EXISTS erp.partnership_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name TEXT NOT NULL,
  partner_type TEXT,
  ownership_pct NUMERIC(5,2),
  revenue_share_pct NUMERIC(5,2),
  status TEXT DEFAULT 'draft',
  start_date DATE,
  end_date DATE,
  terms TEXT,
  document_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.freelancer_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_name TEXT NOT NULL,
  scope_of_work TEXT,
  rate_type TEXT NOT NULL DEFAULT 'hourly' CHECK (rate_type IN ('hourly', 'fixed', 'retainer')),
  rate_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  status TEXT DEFAULT 'draft',
  start_date DATE,
  end_date DATE,
  deliverables JSONB DEFAULT '[]',
  document_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.corporate_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type TEXT NOT NULL,
  title TEXT,
  filing_date DATE,
  expiry_date DATE,
  jurisdiction TEXT,
  status TEXT DEFAULT 'active',
  document_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.legal_structure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  legal_name TEXT,
  entity_type TEXT NOT NULL DEFAULT 'llc',
  state_of_formation TEXT,
  ein TEXT,
  formation_date DATE,
  registered_agent TEXT,
  principal_address TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.compliance_guardrails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'operational',
  description TEXT,
  rule_expression TEXT,
  severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_partnership_contracts_status ON erp.partnership_contracts(status);
CREATE INDEX IF NOT EXISTS idx_freelancer_contracts_status ON erp.freelancer_contracts(status);
CREATE INDEX IF NOT EXISTS idx_corporate_documents_doc_type ON erp.corporate_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_legal_structure_entity_type ON erp.legal_structure(entity_type);
CREATE INDEX IF NOT EXISTS idx_compliance_guardrails_active ON erp.compliance_guardrails(active);
