CREATE TABLE IF NOT EXISTS erp.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT DEFAULT 'draft',
  owner_agent_id TEXT,
  start_date DATE,
  end_date DATE,
  budget NUMERIC(15,2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES erp.projects(id),
  title TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  assigned_agent_id TEXT,
  priority INTEGER DEFAULT 0,
  due_date DATE,
  dependencies JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS erp.milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES erp.projects(id),
  title TEXT NOT NULL,
  target_date DATE,
  status TEXT DEFAULT 'pending',
  kpi_targets JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
