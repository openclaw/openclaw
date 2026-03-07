-- Migration 031: Two-step approvals + signed callback nonces
-- Supports: Two-step approval flow for very high risk actions
-- Status values: PENDING | APPROVED_STEP1 | APPROVED | DENIED | EXPIRED | CANCELED

ALTER TABLE approvals_queue ADD COLUMN step INTEGER NOT NULL DEFAULT 1;
ALTER TABLE approvals_queue ADD COLUMN requires_two_step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approvals_queue ADD COLUMN confirm_expires_at TEXT;

-- One-time-use nonces for signed Telegram callback buttons (anti-replay)
CREATE TABLE IF NOT EXISTS callback_nonces (
    nonce TEXT PRIMARY KEY,
    approval_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_callback_nonces_approval
    ON callback_nonces(approval_id);
