-- ops.db schema v1
-- OpenClaw operational database for coding-agent context sharing
-- Provides queryable history of health, config changes, incidents, and tasks

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Health snapshots: periodic model/provider state captures
CREATE TABLE IF NOT EXISTS health_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    provider TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('healthy', 'rate-limited', 'quarantined', 'disabled')),
    reason TEXT DEFAULT 'none',
    failure_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    last_used TEXT,
    meta TEXT  -- JSON blob for extra fields
);

CREATE INDEX IF NOT EXISTS idx_health_ts ON health_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_health_provider ON health_snapshots(provider);

-- Config changes: tracks openclaw.json modifications
CREATE TABLE IF NOT EXISTS config_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    source TEXT,
    event TEXT,
    previous_hash TEXT,
    next_hash TEXT,
    previous_bytes INTEGER,
    next_bytes INTEGER,
    gateway_mode TEXT,
    suspicious TEXT,  -- JSON array
    result TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_ts ON config_changes(ts);

-- Incidents: operational issues with lifecycle tracking
CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    closed_at TEXT,
    provider TEXT,
    severity TEXT CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    title TEXT NOT NULL,
    description TEXT,
    github_issue_url TEXT,
    resolution TEXT,
    meta TEXT  -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(closed_at) WHERE closed_at IS NULL;

-- Tasks: structured handoff between agents and coding tools
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    agent TEXT NOT NULL,
    urgency TEXT DEFAULT 'routine' CHECK (urgency IN ('routine', 'blocking', 'critical')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'cancelled')),
    task TEXT NOT NULL,
    context TEXT,
    files TEXT,       -- JSON array of file paths
    errors TEXT,
    outcome TEXT,
    result TEXT,      -- JSON blob from coding tool response
    meta TEXT         -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);

-- Notifications: model health and system notifications
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    type TEXT NOT NULL CHECK (type IN ('failure', 'recovery', 'degraded', 'info')),
    provider TEXT,
    reason TEXT,
    message TEXT NOT NULL,
    delivered INTEGER DEFAULT 0,
    meta TEXT  -- JSON blob
);

CREATE INDEX IF NOT EXISTS idx_notif_delivered ON notifications(delivered) WHERE delivered = 0;
CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(ts);

-- Key-value store for cursors, flags, and lightweight state
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Convenience views
CREATE VIEW IF NOT EXISTS v_open_incidents AS
    SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC;

CREATE VIEW IF NOT EXISTS v_pending_tasks AS
    SELECT * FROM tasks WHERE status IN ('pending', 'in_progress') ORDER BY
        CASE urgency WHEN 'critical' THEN 0 WHEN 'blocking' THEN 1 ELSE 2 END,
        created_at ASC;

CREATE VIEW IF NOT EXISTS v_undelivered_notifications AS
    SELECT * FROM notifications WHERE delivered = 0 ORDER BY ts ASC;

CREATE VIEW IF NOT EXISTS v_latest_health AS
    SELECT h.* FROM health_snapshots h
    INNER JOIN (
        SELECT provider, MAX(ts) as max_ts FROM health_snapshots GROUP BY provider
    ) latest ON h.provider = latest.provider AND h.ts = latest.max_ts;

-- Seed metadata
INSERT OR REPLACE INTO kv (key, value) VALUES ('schema_version', '1');
INSERT OR REPLACE INTO kv (key, value) VALUES ('created_at', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
