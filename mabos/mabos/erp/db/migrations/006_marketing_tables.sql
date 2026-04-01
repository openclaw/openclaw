CREATE TABLE IF NOT EXISTS erp.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  type TEXT,
  channel TEXT,
  budget NUMERIC(15,2),
  start_date DATE,
  end_date DATE,
  target_segment TEXT,
  goals JSONB DEFAULT '[]',
  metrics JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.funnels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES erp.campaigns(id),
  name TEXT NOT NULL,
  stages JSONB DEFAULT '[]',
  conversion_rates JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
