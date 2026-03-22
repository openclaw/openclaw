-- OpenClaw workspace seed schema + sample data
-- Used to pre-build workspace.duckdb for new workspace onboarding.

-- ── nanoid32 macro ──
CREATE OR REPLACE MACRO nanoid32() AS (
  SELECT string_agg(
    substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
      (floor(random() * 64) + 1)::int, 1), '')
  FROM generate_series(1, 32)
);

-- ── Core tables ──

CREATE TABLE IF NOT EXISTS objects (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  name VARCHAR NOT NULL,
  description VARCHAR,
  icon VARCHAR,
  default_view VARCHAR DEFAULT 'table',
  parent_document_id VARCHAR,
  sort_order INTEGER DEFAULT 0,
  source_app VARCHAR,
  immutable BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(name)
);

CREATE TABLE IF NOT EXISTS fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  description VARCHAR,
  type VARCHAR NOT NULL,
  required BOOLEAN DEFAULT false,
  default_value VARCHAR,
  related_object_id VARCHAR REFERENCES objects(id),
  relationship_type VARCHAR,
  enum_values JSON,
  enum_colors JSON,
  enum_multiple BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS entries (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entry_fields (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  entry_id VARCHAR NOT NULL REFERENCES entries(id),
  field_id VARCHAR NOT NULL REFERENCES fields(id),
  value VARCHAR,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entry_id, field_id)
);

CREATE TABLE IF NOT EXISTS statuses (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  object_id VARCHAR NOT NULL REFERENCES objects(id),
  name VARCHAR NOT NULL,
  color VARCHAR DEFAULT '#94a3b8',
  sort_order INTEGER DEFAULT 0,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(object_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  title VARCHAR DEFAULT 'Untitled',
  icon VARCHAR,
  cover_image VARCHAR,
  file_path VARCHAR NOT NULL UNIQUE,
  parent_id VARCHAR REFERENCES documents(id),
  parent_object_id VARCHAR REFERENCES objects(id),
  entry_id VARCHAR REFERENCES entries(id),
  sort_order INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_runs (
  id VARCHAR PRIMARY KEY DEFAULT (gen_random_uuid()::VARCHAR),
  action_id VARCHAR NOT NULL,
  field_id VARCHAR NOT NULL,
  entry_id VARCHAR NOT NULL,
  object_id VARCHAR NOT NULL,
  status VARCHAR NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ,
  result VARCHAR,
  error VARCHAR,
  stdout VARCHAR,
  exit_code INTEGER
);

-- ── Seed: people ──

INSERT INTO objects (id, name, description, icon, default_view, immutable, sort_order)
VALUES ('seed_obj_people_00000000000000', 'people', 'Contact management', 'users', 'table', true, 0);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_people_fullname_000000', 'seed_obj_people_00000000000000', 'Full Name', 'text', true, 0),
  ('seed_fld_people_email_000000000', 'seed_obj_people_00000000000000', 'Email Address', 'email', true, 1),
  ('seed_fld_people_phone_000000000', 'seed_obj_people_00000000000000', 'Phone Number', 'phone', false, 2),
  ('seed_fld_people_company_0000000', 'seed_obj_people_00000000000000', 'Company', 'text', false, 3);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_people_status_00000000', 'seed_obj_people_00000000000000', 'Status', 'enum', false,
   '["Active","Inactive","Lead"]'::JSON, '["#22c55e","#94a3b8","#3b82f6"]'::JSON, 4);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_people_notes_000000000', 'seed_obj_people_00000000000000', 'Notes', 'richtext', false, 5);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_james_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_maria_000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_alex_0000000000', 'seed_obj_people_00000000000000'),
  ('seed_ent_people_priya_000000000', 'seed_obj_people_00000000000000');

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_fullname_000000', 'Sarah Chen'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_email_000000000', 'sarah@acmecorp.com'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 234-5678'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_company_0000000', 'Acme Corp'),
  ('seed_ent_people_sarah_000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_fullname_000000', 'James Wilson'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_email_000000000', 'james@techcorp.io'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 876-5432'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_company_0000000', 'TechCorp Industries'),
  ('seed_ent_people_james_000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_fullname_000000', 'Maria Garcia'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_email_000000000', 'maria@innovate.co'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 345-6789'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_company_0000000', 'Innovate Co'),
  ('seed_ent_people_maria_000000000', 'seed_fld_people_status_00000000', 'Lead'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_fullname_000000', 'Alex Thompson'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_email_000000000', 'alex@designstudio.io'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_phone_000000000', '+1 (555) 567-8901'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_company_0000000', 'Design Studio'),
  ('seed_ent_people_alex_0000000000', 'seed_fld_people_status_00000000', 'Active'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_fullname_000000', 'Priya Patel'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_email_000000000', 'priya@cloudnine.dev'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_phone_000000000', '+1 (555) 789-0123'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_company_0000000', 'CloudNine'),
  ('seed_ent_people_priya_000000000', 'seed_fld_people_status_00000000', 'Lead');

CREATE OR REPLACE VIEW v_people AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_people_00000000000000'
) ON field_name IN ('Full Name', 'Email Address', 'Phone Number', 'Company', 'Status', 'Notes') USING first(value);

-- ── Seed: company ──

INSERT INTO objects (id, name, description, icon, default_view, immutable, sort_order)
VALUES ('seed_obj_company_0000000000000', 'company', 'Company tracking', 'building-2', 'table', true, 1);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_name_000000000', 'seed_obj_company_0000000000000', 'Company Name', 'text', true, 0);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_company_industry_00000', 'seed_obj_company_0000000000000', 'Industry', 'enum', false,
   '["Technology","Finance","Healthcare","Education","Retail","Other"]'::JSON,
   '["#3b82f6","#22c55e","#ef4444","#f59e0b","#8b5cf6","#94a3b8"]'::JSON, 1);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_website_000000', 'seed_obj_company_0000000000000', 'Website', 'text', false, 2);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_company_type_000000000', 'seed_obj_company_0000000000000', 'Type', 'enum', false,
   '["Client","Partner","Vendor","Prospect"]'::JSON,
   '["#22c55e","#3b82f6","#f59e0b","#94a3b8"]'::JSON, 3);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_company_notes_00000000', 'seed_obj_company_0000000000000', 'Notes', 'richtext', false, 4);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_company_acme_000000000', 'seed_obj_company_0000000000000'),
  ('seed_ent_company_tech_000000000', 'seed_obj_company_0000000000000'),
  ('seed_ent_company_innov_00000000', 'seed_obj_company_0000000000000');

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_company_acme_000000000', 'seed_fld_company_name_000000000', 'Acme Corp'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_industry_00000', 'Technology'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_website_000000', 'https://acmecorp.com'),
  ('seed_ent_company_acme_000000000', 'seed_fld_company_type_000000000', 'Client'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_name_000000000', 'TechCorp Industries'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_industry_00000', 'Finance'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_website_000000', 'https://techcorp.io'),
  ('seed_ent_company_tech_000000000', 'seed_fld_company_type_000000000', 'Partner'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_name_000000000', 'Innovate Co'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_industry_00000', 'Healthcare'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_website_000000', 'https://innovate.co'),
  ('seed_ent_company_innov_00000000', 'seed_fld_company_type_000000000', 'Prospect');

CREATE OR REPLACE VIEW v_company AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_company_0000000000000'
) ON field_name IN ('Company Name', 'Industry', 'Website', 'Type', 'Notes') USING first(value);

-- ── Seed: task ──

INSERT INTO objects (id, name, description, icon, default_view, sort_order)
VALUES ('seed_obj_task_000000000000000', 'task', 'Task tracking board', 'check-square', 'kanban', 2);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_task_title_00000000000', 'seed_obj_task_000000000000000', 'Title', 'text', true, 0),
  ('seed_fld_task_desc_000000000000', 'seed_obj_task_000000000000000', 'Description', 'text', false, 1);

INSERT INTO fields (id, object_id, name, type, required, enum_values, enum_colors, sort_order) VALUES
  ('seed_fld_task_status_0000000000', 'seed_obj_task_000000000000000', 'Status', 'enum', false,
   '["In Queue","In Progress","Done"]'::JSON, '["#94a3b8","#3b82f6","#22c55e"]'::JSON, 2),
  ('seed_fld_task_priority_00000000', 'seed_obj_task_000000000000000', 'Priority', 'enum', false,
   '["Low","Medium","High"]'::JSON, '["#94a3b8","#f59e0b","#ef4444"]'::JSON, 3);

INSERT INTO fields (id, object_id, name, type, required, sort_order) VALUES
  ('seed_fld_task_duedate_000000000', 'seed_obj_task_000000000000000', 'Due Date', 'date', false, 4),
  ('seed_fld_task_notes_00000000000', 'seed_obj_task_000000000000000', 'Notes', 'richtext', false, 5);

INSERT INTO statuses (id, object_id, name, color, sort_order, is_default) VALUES
  ('seed_sts_task_queue_00000000000', 'seed_obj_task_000000000000000', 'In Queue', '#94a3b8', 0, true),
  ('seed_sts_task_progress_00000000', 'seed_obj_task_000000000000000', 'In Progress', '#3b82f6', 1, false),
  ('seed_sts_task_done_000000000000', 'seed_obj_task_000000000000000', 'Done', '#22c55e', 2, false);

INSERT INTO entries (id, object_id) VALUES
  ('seed_ent_task_review_0000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_onboard_000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_retro_00000000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_investor_00000000', 'seed_obj_task_000000000000000'),
  ('seed_ent_task_dashperf_00000000', 'seed_obj_task_000000000000000');

INSERT INTO entry_fields (entry_id, field_id, value) VALUES
  ('seed_ent_task_review_0000000000', 'seed_fld_task_title_00000000000', 'Review Q1 reports'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_desc_000000000000', 'Review and summarize Q1 financial reports'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_status_0000000000', 'In Progress'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_priority_00000000', 'High'),
  ('seed_ent_task_review_0000000000', 'seed_fld_task_duedate_000000000', '2026-03-15'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_title_00000000000', 'Update client onboarding docs'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_desc_000000000000', 'Refresh the onboarding documentation with latest screenshots'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_status_0000000000', 'In Queue'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_priority_00000000', 'Medium'),
  ('seed_ent_task_onboard_000000000', 'seed_fld_task_duedate_000000000', '2026-03-20'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_title_00000000000', 'Schedule team retrospective'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_desc_000000000000', 'Organize end-of-sprint retro for the team'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_status_0000000000', 'Done'),
  ('seed_ent_task_retro_00000000000', 'seed_fld_task_priority_00000000', 'Low'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_title_00000000000', 'Prepare investor deck'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_desc_000000000000', 'Create presentation for upcoming investor meeting'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_status_0000000000', 'In Queue'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_priority_00000000', 'High'),
  ('seed_ent_task_investor_00000000', 'seed_fld_task_duedate_000000000', '2026-04-01'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_title_00000000000', 'Fix dashboard performance'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_desc_000000000000', 'Investigate and resolve slow loading on analytics dashboard'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_status_0000000000', 'In Progress'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_priority_00000000', 'Medium'),
  ('seed_ent_task_dashperf_00000000', 'seed_fld_task_duedate_000000000', '2026-03-10');

CREATE OR REPLACE VIEW v_task AS
PIVOT (
  SELECT e.id as entry_id, e.created_at, e.updated_at,
         f.name as field_name, ef.value
  FROM entries e
  JOIN entry_fields ef ON ef.entry_id = e.id
  JOIN fields f ON f.id = ef.field_id
  WHERE e.object_id = 'seed_obj_task_000000000000000'
) ON field_name IN ('Title', 'Description', 'Status', 'Priority', 'Due Date', 'Notes') USING first(value);
