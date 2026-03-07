PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS setter_daily_metrics (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  setter_id TEXT NOT NULL,

  dms_sent INTEGER NOT NULL DEFAULT 0,
  convos_started INTEGER NOT NULL DEFAULT 0,
  followups_sent INTEGER NOT NULL DEFAULT 0,
  booked_calls INTEGER NOT NULL DEFAULT 0,

  notes_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_setter_daily_metrics_date_setter ON setter_daily_metrics(date, setter_id);

CREATE TABLE IF NOT EXISTS lead_touch_log (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  channel TEXT NOT NULL,         -- dm | sms | email | call | other
  action TEXT NOT NULL,          -- sent_case_study | asked_question | booked | reschedule | etc.
  outcome TEXT,                  -- freeform
  note TEXT,
  correlation_id TEXT,
  created_at TEXT NOT NULL,

  FOREIGN KEY(lead_id) REFERENCES agencyu_leads(id)
);

CREATE INDEX IF NOT EXISTS idx_lead_touch_log_lead_id ON lead_touch_log(lead_id);
