-- Migration 029: Capacity state table + brand guard audit
-- Supports: Patch 1 (capacity gate) + Patch 2 (brand consistency guard)

-- Capacity state for scaling gate decisions
CREATE TABLE IF NOT EXISTS capacity_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,                         -- fulldigital | cutmv
    period_start TEXT NOT NULL,                  -- ISO date
    period_end TEXT NOT NULL,                    -- ISO date
    total_hours REAL NOT NULL DEFAULT 0,
    committed_hours REAL NOT NULL DEFAULT 0,
    free_hours REAL NOT NULL DEFAULT 0,
    headroom_ratio REAL NOT NULL DEFAULT 0,      -- free/total
    computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capacity_state_brand_time
    ON capacity_state(brand, computed_at);

-- Brand guard violation log (tracks blocked publish/generation attempts)
CREATE TABLE IF NOT EXISTS brand_guard_violations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand TEXT NOT NULL,
    content_type TEXT NOT NULL,
    offer_id TEXT,
    angle_id TEXT,
    voice_profile_id TEXT,
    violation_type TEXT NOT NULL,                -- invalid_brand | invalid_voice | offer_mismatch | missing_header
    detail TEXT,
    correlation_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_brand_guard_violations_brand
    ON brand_guard_violations(brand, created_at);
