-- ClaWorks production PostgreSQL schema (canonical; see schema-bootstrap.sql.ts)
-- Apply: CLAWORKS_DATABASE_URL=postgresql://... pnpm claworks:migrate

CREATE TABLE IF NOT EXISTS cw_objects (
  id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, type_name)
);
CREATE INDEX IF NOT EXISTS idx_cw_objects_type ON cw_objects(type_name);

CREATE TABLE IF NOT EXISTS cw_playbook_runs (
  id TEXT PRIMARY KEY,
  playbook_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  steps TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  payload TEXT NOT NULL,
  correlation_id TEXT,
  timestamp BIGINT NOT NULL,
  subject_id TEXT,
  subject_type TEXT,
  idempotency_key TEXT
);

CREATE TABLE IF NOT EXISTS cw_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at BIGINT NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL,
  is_dead INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;

CREATE TABLE IF NOT EXISTS cw_kb_documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT,
  layer TEXT NOT NULL DEFAULT 'L2',
  doc_type TEXT,
  namespace TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  revision INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  published_at BIGINT
);

CREATE TABLE IF NOT EXISTS cw_kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  citation TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  source_path TEXT,
  folder_path TEXT,
  namespace TEXT,
  layer TEXT,
  doc_type TEXT,
  report TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  completed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_status ON cw_kb_documents(status);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_layer ON cw_kb_documents(layer);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_namespace ON cw_kb_documents(namespace);
CREATE INDEX IF NOT EXISTS idx_cw_kb_chunks_document ON cw_kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_cw_kb_ingest_jobs_status ON cw_kb_ingest_jobs(status);
