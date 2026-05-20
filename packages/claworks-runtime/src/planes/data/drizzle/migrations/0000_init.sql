-- ClaWorks production PostgreSQL schema (apply via pnpm claworks:migrate)
CREATE TABLE IF NOT EXISTS cw_objects (
  id TEXT NOT NULL,
  type_name TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (id, type_name)
);

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
  timestamp BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cw_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at BIGINT NOT NULL,
  last_error TEXT,
  created_at BIGINT NOT NULL
);
