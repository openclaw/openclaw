import type pg from "pg";
import type { Logger } from "./db.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS audit_events (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  event_type TEXT NOT NULL,
  session_key TEXT,
  session_id TEXT,
  channel TEXT,
  provider TEXT,
  model TEXT,
  tokens_input INT,
  tokens_output INT,
  tokens_total INT,
  cost_usd NUMERIC(10,6),
  duration_ms INT,
  payload JSONB
);

CREATE TABLE IF NOT EXISTS compound_learnings (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  session_key TEXT,
  session_id TEXT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT,
  solution TEXT,
  tags TEXT[],
  relevance_score FLOAT DEFAULT 1.0,
  times_injected INT DEFAULT 0,
  last_injected_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_learnings_tags ON compound_learnings USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_learnings_category ON compound_learnings(category);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_key, ts);
`;

export async function ensureSchema(pool: pg.Pool, logger: Logger): Promise<void> {
  try {
    await pool.query(SCHEMA_SQL);
    logger.info("compound-postgres: schema verified");
  } catch (err) {
    logger.warn(`compound-postgres: could not ensure schema: ${err}`);
  }
}
