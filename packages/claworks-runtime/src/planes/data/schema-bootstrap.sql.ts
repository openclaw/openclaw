/**
 * Canonical ClaWorks DDL (SQLite + PostgreSQL).
 * Keep in sync with drizzle/migrations/0000_init.sql and db-migrate.ts indexes.
 */
export const CW_SCHEMA_BOOTSTRAP_SQL = `
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
CREATE INDEX IF NOT EXISTS idx_cw_objects_type_created ON cw_objects(type_name, created_at DESC);

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

CREATE TABLE IF NOT EXISTS cw_hitl_pending (
  token TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  message TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_hooks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  event_pattern TEXT NOT NULL,
  condition_expr TEXT,
  action_kind TEXT NOT NULL,
  action_channel TEXT,
  action_url TEXT,
  action_playbook_id TEXT,
  action_template TEXT NOT NULL,
  action_headers TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_cbr_cases (
  id TEXT PRIMARY KEY,
  problem TEXT NOT NULL,
  solution TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success',
  similarity_keys TEXT NOT NULL DEFAULT '[]',
  use_count INTEGER NOT NULL DEFAULT 0,
  last_used_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  playbook_id TEXT,
  run_id TEXT
);

CREATE TABLE IF NOT EXISTS cw_notify_preferences (
  user_id TEXT PRIMARY KEY,
  channels TEXT NOT NULL DEFAULT '[]',
  subscriptions TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_notify_bindings (
  subject_key TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_ids TEXT NOT NULL DEFAULT '[]',
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_robot_identity (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_memory (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cw_evolution_pending_promotions (
  promotion_id TEXT PRIMARY KEY,
  pack_json TEXT NOT NULL,
  playbook_ids TEXT NOT NULL,
  simulation_results TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  registered_at BIGINT NOT NULL
);
`;

export const CW_SCHEMA_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_playbook ON cw_playbook_runs(playbook_id);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_status ON cw_playbook_runs(status);
CREATE INDEX IF NOT EXISTS idx_cw_playbook_runs_started ON cw_playbook_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cw_events_type ON cw_events(type);
CREATE INDEX IF NOT EXISTS idx_cw_events_timestamp ON cw_events(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_cw_outbox_due ON cw_outbox(next_attempt_at) WHERE is_dead = 0;
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_status ON cw_kb_documents(status);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_layer ON cw_kb_documents(layer);
CREATE INDEX IF NOT EXISTS idx_cw_kb_documents_namespace ON cw_kb_documents(namespace);
CREATE INDEX IF NOT EXISTS idx_cw_kb_chunks_document ON cw_kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_cw_kb_ingest_jobs_status ON cw_kb_ingest_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cw_hitl_pending_run ON cw_hitl_pending(run_id);
CREATE INDEX IF NOT EXISTS idx_cw_hooks_enabled ON cw_hooks(enabled);
CREATE INDEX IF NOT EXISTS idx_cw_cbr_cases_outcome ON cw_cbr_cases(outcome);
CREATE INDEX IF NOT EXISTS idx_cw_cbr_cases_use_count ON cw_cbr_cases(use_count DESC);
CREATE INDEX IF NOT EXISTS idx_cw_notify_bindings_subject_type ON cw_notify_bindings(subject_type);
CREATE INDEX IF NOT EXISTS idx_cw_memory_expires ON cw_memory(expires_at);
CREATE INDEX IF NOT EXISTS idx_cw_evolution_pending_status ON cw_evolution_pending_promotions(status);
`;

export function execSchemaBootstrap(db: { exec: (sql: string) => void }): void {
  for (const stmt of CW_SCHEMA_BOOTSTRAP_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    db.exec(stmt);
  }
  for (const stmt of CW_SCHEMA_INDEX_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    db.exec(stmt);
  }
}
