-- 026: Schedule & Goals — executive operating system tables
-- Adds: schedule_events, daily_plan_cache, goals
-- Supports unified schedule (Trello + GCal + GHL), goal tracking, daily plan snapshots.

-- ── Schedule events (unified from Trello, Google Calendar, GHL) ──

CREATE TABLE IF NOT EXISTS schedule_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('trello', 'gcal', 'ghl', 'manual', 'system')),
  external_key TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN ('deadline', 'meeting', 'focus_block', 'reminder', 'appointment')),
  title TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  all_day INTEGER NOT NULL DEFAULT 0,
  location TEXT,
  attendees_json TEXT,
  trello_card_id TEXT,
  gcal_event_id TEXT,
  ghl_appointment_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
  conflict_flag INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  synced_to_notion INTEGER NOT NULL DEFAULT 0,
  notion_page_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_key)
);

CREATE INDEX IF NOT EXISTS idx_schedule_events_brand_date
  ON schedule_events(brand, start_time);

CREATE INDEX IF NOT EXISTS idx_schedule_events_source
  ON schedule_events(source);

CREATE INDEX IF NOT EXISTS idx_schedule_events_external
  ON schedule_events(external_key);

CREATE INDEX IF NOT EXISTS idx_schedule_events_conflict
  ON schedule_events(conflict_flag) WHERE conflict_flag = 1;

-- ── Daily plan cache (one row per brand per day) ──

CREATE TABLE IF NOT EXISTS daily_plan_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  goal_chip TEXT,
  schedule_summary TEXT,
  top_priorities_json TEXT,
  blockers_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'reviewed', 'archived')),
  synced_to_notion INTEGER NOT NULL DEFAULT 0,
  notion_page_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand, plan_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_plan_cache_date
  ON daily_plan_cache(plan_date);

-- ── Goals (brand-level KPI targets) ──

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  brand TEXT NOT NULL,
  kpi_key TEXT NOT NULL CHECK (kpi_key IN ('calls_booked', 'trials', 'paid', 'revenue', 'close_rate')),
  cadence TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  target_value REAL NOT NULL,
  current_value REAL NOT NULL DEFAULT 0,
  progress_pct REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'achieved', 'dropped')),
  start_date TEXT,
  end_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand, kpi_key, cadence)
);

CREATE INDEX IF NOT EXISTS idx_goals_brand_status
  ON goals(brand, status);

-- ── Schedule sync run history (audits each sync job execution) ──

CREATE TABLE IF NOT EXISTS schedule_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'error')),
  source TEXT,
  brand TEXT,
  events_synced INTEGER NOT NULL DEFAULT 0,
  events_removed INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  details_json TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_schedule_sync_runs_job
  ON schedule_sync_runs(job_name, started_at);
