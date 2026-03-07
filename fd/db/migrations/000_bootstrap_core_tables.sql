PRAGMA foreign_keys = ON;

-- =========================
-- attribution_events
-- =========================
CREATE TABLE IF NOT EXISTS attribution_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- ISO-8601 datetime (UTC recommended)
  event_ts TEXT NOT NULL,

  -- brand keys: "fulldigital" | "cutmv"
  brand TEXT NOT NULL,

  -- attribution combo identifier (must be consistent across systems)
  combo_id TEXT NOT NULL,

  -- normalized event name
  -- examples: meta_spend, call_booked, call_showed, booking_complete,
  --           application_submit, trial_started, trial_paid, purchase,
  --           stripe_paid, refund_issued, pipeline_quality
  event_name TEXT NOT NULL,

  -- raw source identifier
  -- examples: "meta", "ghl", "calendly", "stripe", "clickfunnels", "notion"
  source TEXT NOT NULL DEFAULT 'unknown',

  -- provider event id / external key (optional)
  external_id TEXT,

  -- JSON payload for extra context (combo metadata, setter_id, amounts, etc.)
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_attr_events_brand_combo_ts
ON attribution_events (brand, combo_id, event_ts);

CREATE INDEX IF NOT EXISTS idx_attr_events_event_ts
ON attribution_events (event_name, event_ts);

CREATE INDEX IF NOT EXISTS idx_attr_events_external
ON attribution_events (source, external_id);

-- Dedupe: prevent duplicate webhook/event inserts per source
-- Optional because some sources don't guarantee uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attr_dedupe
ON attribution_events (source, external_id)
WHERE external_id IS NOT NULL;


-- =========================
-- ledger_revenue
-- Stripe paid only, refunds excluded via net_usd <= 0
-- =========================
CREATE TABLE IF NOT EXISTS ledger_revenue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  brand TEXT NOT NULL,
  combo_id TEXT NOT NULL,

  -- Stripe identifiers (store whichever is most stable for you)
  payment_id TEXT NOT NULL,      -- charge/payment_intent/invoice id
  event_ts TEXT NOT NULL,        -- ISO datetime

  gross_usd REAL NOT NULL DEFAULT 0,
  refund_usd REAL NOT NULL DEFAULT 0,
  net_usd REAL NOT NULL DEFAULT 0,   -- gross - refund (can be 0)

  currency TEXT NOT NULL DEFAULT 'USD',

  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_revenue_payment
ON ledger_revenue (payment_id);

CREATE INDEX IF NOT EXISTS idx_ledger_revenue_combo_ts
ON ledger_revenue (brand, combo_id, event_ts);

CREATE INDEX IF NOT EXISTS idx_ledger_revenue_ts
ON ledger_revenue (event_ts);


-- =========================
-- angle_fatigue_scores
-- keep empty initially; views expect it to exist
-- =========================
CREATE TABLE IF NOT EXISTS angle_fatigue_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  as_of_ts TEXT NOT NULL,
  brand TEXT NOT NULL,
  combo_id TEXT NOT NULL,

  fatigue_score REAL NOT NULL DEFAULT 0,  -- 0..1

  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_fatigue_combo_ts
ON angle_fatigue_scores (brand, combo_id, as_of_ts);


-- =========================
-- scheduled_actions
-- minimal queue table for v1
-- =========================
CREATE TABLE IF NOT EXISTS scheduled_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  run_at TEXT NOT NULL,   -- when the job is eligible to run (UTC)

  status TEXT NOT NULL DEFAULT 'PENDING',
  -- statuses: PENDING | RUNNING | DONE | FAILED | SKIPPED

  action_type TEXT NOT NULL,
  brand TEXT,             -- optional
  correlation_id TEXT,    -- used for traceability

  payload_json TEXT NOT NULL DEFAULT '{}',

  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sched_actions_status_runat
ON scheduled_actions (status, run_at);

CREATE INDEX IF NOT EXISTS idx_sched_actions_actiontype
ON scheduled_actions (action_type);

CREATE INDEX IF NOT EXISTS idx_sched_actions_corr
ON scheduled_actions (correlation_id);


-- =========================
-- Optional: helper views require JSON1
-- If JSON1 isn't available, keep payload_json but don't use json_extract views.
-- =========================
