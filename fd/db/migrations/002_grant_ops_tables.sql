-- GrantOps tables: opportunities, drafts, submissions
-- Finance sub-module for automated grant discovery and application tracking

CREATE TABLE IF NOT EXISTS grant_opportunities (
    id              TEXT PRIMARY KEY,
    external_id     TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    funder          TEXT NOT NULL DEFAULT '',
    deadline        TEXT,
    amount_min_usd  REAL,
    amount_max_usd  REAL,
    fit_score       REAL DEFAULT 0.0,
    effort_score    REAL DEFAULT 0.0,
    priority        TEXT DEFAULT 'medium',
    status          TEXT DEFAULT 'new',
    portal_type     TEXT DEFAULT 'guided',
    portal_url      TEXT DEFAULT '',
    source          TEXT DEFAULT 'manual',
    brand           TEXT DEFAULT 'fulldigital',
    tags_json       TEXT DEFAULT '[]',
    raw_data_json   TEXT DEFAULT '{}',
    discovered_at   TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    content_hash    TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_grant_opps_status ON grant_opportunities(status);
CREATE INDEX IF NOT EXISTS idx_grant_opps_deadline ON grant_opportunities(deadline);
CREATE INDEX IF NOT EXISTS idx_grant_opps_fit ON grant_opportunities(fit_score);
CREATE INDEX IF NOT EXISTS idx_grant_opps_external ON grant_opportunities(external_id);

CREATE TABLE IF NOT EXISTS grant_drafts (
    id                TEXT PRIMARY KEY,
    opportunity_id    TEXT NOT NULL REFERENCES grant_opportunities(id),
    name              TEXT NOT NULL,
    status            TEXT DEFAULT 'requirements_extracted',
    narrative         TEXT DEFAULT '',
    budget_json       TEXT DEFAULT '{}',
    timeline_json     TEXT DEFAULT '[]',
    attachments_ready INTEGER DEFAULT 0,
    reviewer          TEXT DEFAULT '',
    review_notes      TEXT DEFAULT '',
    manifest_json     TEXT DEFAULT '{}',
    vault_snapshot_id TEXT DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_grant_drafts_status ON grant_drafts(status);
CREATE INDEX IF NOT EXISTS idx_grant_drafts_opp ON grant_drafts(opportunity_id);

CREATE TABLE IF NOT EXISTS grant_submissions (
    id                TEXT PRIMARY KEY,
    opportunity_id    TEXT NOT NULL REFERENCES grant_opportunities(id),
    draft_id          TEXT REFERENCES grant_drafts(id),
    name              TEXT NOT NULL,
    method            TEXT DEFAULT 'guided_submit',
    status            TEXT DEFAULT 'pending',
    submitted_at      TEXT,
    confirmation_id   TEXT DEFAULT '',
    blocker_reason    TEXT DEFAULT '',
    follow_up_date    TEXT,
    outcome           TEXT DEFAULT 'pending',
    award_amount_usd  REAL,
    notes             TEXT DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    content_hash      TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_grant_subs_status ON grant_submissions(status);
CREATE INDEX IF NOT EXISTS idx_grant_subs_followup ON grant_submissions(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_grant_subs_outcome ON grant_submissions(outcome);
