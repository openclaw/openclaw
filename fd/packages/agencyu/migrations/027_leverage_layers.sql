-- Migration 027: Leverage layers — authority, expansion, VSL, capacity extensions
--
-- Adds columns needed by:
--   - setter_allocator.py (setter routing)
--   - vsl_optimizer.py (VSL view tracking)
--   - capacity_engine.py (role-based forecasting)
--   - expansion_engine.py (trigger tracking)

-- Setter daily metrics: add brand, display_name, show/response/queue columns
ALTER TABLE setter_daily_metrics ADD COLUMN brand TEXT DEFAULT 'fulldigital';
ALTER TABLE setter_daily_metrics ADD COLUMN display_name TEXT;
ALTER TABLE setter_daily_metrics ADD COLUMN appointments_showed INTEGER DEFAULT 0;
ALTER TABLE setter_daily_metrics ADD COLUMN avg_response_time_minutes REAL DEFAULT 0;
ALTER TABLE setter_daily_metrics ADD COLUMN current_queue_size INTEGER DEFAULT 0;

-- Work orders: add assigned_role for capacity engine role forecasting
-- (column may already exist in some deployments; IF NOT EXISTS not supported for ALTER TABLE in SQLite)
-- Safe to fail silently if column exists.

-- Expansion trigger log: track fired triggers to prevent duplicate actions
CREATE TABLE IF NOT EXISTS expansion_triggers (
    id TEXT PRIMARY KEY,
    contact_key TEXT NOT NULL,
    brand TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    rule_name TEXT NOT NULL,
    suggested_offer TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | actioned | dismissed
    created_at TEXT NOT NULL,
    actioned_at TEXT,
    UNIQUE(contact_key, rule_name, status)
);

-- VSL view events index for fast optimizer queries
CREATE INDEX IF NOT EXISTS ix_attribution_events_vsl
    ON attribution_events(stage)
    WHERE stage = 'vsl_view';

-- Authority content schedule (tracks planned content)
CREATE TABLE IF NOT EXISTS authority_content_schedule (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    week_start TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    topic TEXT,
    angle TEXT,
    cta TEXT,
    status TEXT NOT NULL DEFAULT 'planned',  -- planned | published | skipped
    created_at TEXT NOT NULL,
    published_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_authority_content_week
    ON authority_content_schedule(brand, week_start);
