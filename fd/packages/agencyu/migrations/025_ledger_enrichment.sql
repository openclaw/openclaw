-- 025: Ledger enrichment — normalization rules, materialized rollups, indexes
-- Adds: event_normalization_rules, mv_combo_daily, mv_setter_daily,
--        mv_creative_daily, mv_chain_latest
-- Also adds idempotency_key + normalized_stage to attribution_events.

-- ── Idempotency + normalization columns on attribution_events ──

-- idempotency_key: SHA-256 based dedup key (INSERT OR IGNORE pattern)
-- normalized_stage: canonical stage name after normalization rules applied
ALTER TABLE attribution_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE attribution_events ADD COLUMN normalized_stage TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attr_events_idempotency
  ON attribution_events(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_attr_events_stage
  ON attribution_events(stage);

CREATE INDEX IF NOT EXISTS idx_attr_events_ts
  ON attribution_events(ts);

-- ── Event normalization rules ──

CREATE TABLE IF NOT EXISTS event_normalization_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  raw_stage TEXT NOT NULL,
  normalized_stage TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, raw_stage)
);

-- Seed canonical normalization rules
INSERT OR IGNORE INTO event_normalization_rules (source, raw_stage, normalized_stage, priority)
VALUES
  ('ghl', 'appointmentScheduled', 'booking_complete', 10),
  ('ghl', 'appointment_scheduled', 'booking_complete', 10),
  ('ghl', 'appointmentCompleted', 'call_showed', 20),
  ('ghl', 'appointment_completed', 'call_showed', 20),
  ('ghl', 'call_attended', 'call_showed', 20),
  ('ghl', 'appointment_attended', 'call_showed', 20),
  ('ghl', 'noShow', 'call_no_show', 30),
  ('ghl', 'no_show', 'call_no_show', 30),
  ('stripe', 'checkout.session.completed', 'checkout_paid', 40),
  ('stripe', 'payment_intent.succeeded', 'checkout_paid', 40),
  ('stripe', 'charge.refunded', 'refund_issued', 50),
  ('clickfunnels', 'purchase', 'checkout_paid', 40),
  ('clickfunnels', 'form_submit', 'application_submit', 15),
  ('meta', 'lead', 'lead_captured', 5);

-- ── Materialized view: combo daily rollup ──

CREATE TABLE IF NOT EXISTS mv_combo_daily (
  combo_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  spend_usd REAL NOT NULL DEFAULT 0.0,
  calls_booked INTEGER NOT NULL DEFAULT 0,
  calls_showed INTEGER NOT NULL DEFAULT 0,
  closes INTEGER NOT NULL DEFAULT 0,
  gross_revenue_usd REAL NOT NULL DEFAULT 0.0,
  refunds_usd REAL NOT NULL DEFAULT 0.0,
  applications INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (combo_id, brand, day)
);

CREATE INDEX IF NOT EXISTS idx_mv_combo_daily_brand_day
  ON mv_combo_daily(brand, day);

-- ── Materialized view: setter daily rollup ──

CREATE TABLE IF NOT EXISTS mv_setter_daily (
  setter_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  closes INTEGER NOT NULL DEFAULT 0,
  revenue_usd REAL NOT NULL DEFAULT 0.0,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (setter_id, brand, day)
);

-- ── Materialized view: creative daily rollup (Meta retention) ──

CREATE TABLE IF NOT EXISTS mv_creative_daily (
  creative_id TEXT NOT NULL,
  brand TEXT NOT NULL,
  day TEXT NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0,
  thruplay_count INTEGER NOT NULL DEFAULT 0,
  thruplay_rate REAL NOT NULL DEFAULT 0.0,
  view_3s_count INTEGER NOT NULL DEFAULT 0,
  view_3s_rate REAL NOT NULL DEFAULT 0.0,
  avg_watch_pct REAL NOT NULL DEFAULT 0.0,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (creative_id, brand, day)
);

-- ── Materialized view: chain latest stage ──

CREATE TABLE IF NOT EXISTS mv_chain_latest (
  chain_id TEXT PRIMARY KEY,
  brand TEXT NOT NULL,
  combo_id TEXT NOT NULL,
  latest_stage TEXT NOT NULL,
  latest_ts TEXT NOT NULL,
  total_events INTEGER NOT NULL DEFAULT 0,
  has_showed INTEGER NOT NULL DEFAULT 0,
  has_closed INTEGER NOT NULL DEFAULT 0,
  has_refunded INTEGER NOT NULL DEFAULT 0,
  refreshed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mv_chain_latest_combo
  ON mv_chain_latest(combo_id);

CREATE INDEX IF NOT EXISTS idx_mv_chain_latest_brand
  ON mv_chain_latest(brand);
