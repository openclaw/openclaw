-- Migration 030: Approvals queue for human-in-the-loop approval layer
-- Supports: Capacity override approvals, ad spend approvals, deploy approvals

CREATE TABLE IF NOT EXISTS approvals_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    approval_id TEXT NOT NULL UNIQUE,
    action_type TEXT NOT NULL,
    brand TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    risk_level TEXT NOT NULL,       -- low | medium | high
    summary TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | DENIED | EXPIRED | CANCELED
    requested_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT,
    decision_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_queue_status
    ON approvals_queue(status);

CREATE INDEX IF NOT EXISTS idx_approvals_queue_action
    ON approvals_queue(action_type);
