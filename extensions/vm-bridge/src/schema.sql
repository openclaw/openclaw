-- VM-Bridge Orchestration Schema
-- Contacts live in the shared `contacts` table (project_ids TEXT[] column).
-- Only cos_projects, cos_intents, and cos_contracts are COS-specific.

CREATE TABLE IF NOT EXISTS cos_projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    vm_owner        TEXT NOT NULL,
    chrome_profile  TEXT DEFAULT 'default',
    repo_path       TEXT,
    domain          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cos_intents (
    id              SERIAL PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES cos_projects(id),
    description     TEXT NOT NULL,
    keywords        TEXT[] DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cos_intents_project ON cos_intents(project_id);

CREATE TABLE IF NOT EXISTS cos_contracts (
    id              SERIAL PRIMARY KEY,
    state           TEXT NOT NULL DEFAULT 'RAW'
                    CHECK (state IN ('RAW','PLANNING','IMPLEMENTING','DONE','STUCK','ABANDONED')),
    -- Logically complete: resolves WHO (names+emails), WHAT (action),
    -- WHERE (system/page), BOUNDARY (what not to change), VERIFICATION (pass/fail).
    intent          TEXT NOT NULL,
    -- Step-by-step QA for Chrome browser agent: where to navigate, what to check, pass/fail criteria.
    qa_doc          TEXT,
    owner           TEXT NOT NULL,
    project_id      TEXT REFERENCES cos_projects(id),
    claimed_by      TEXT,
    system_ref      JSONB DEFAULT '{}',

    -- Source
    message_id      TEXT,
    message_platform TEXT,
    message_account TEXT,
    sender_email    TEXT,
    sender_name     TEXT,
    attachment_ids  TEXT[] DEFAULT '{}',

    -- Execution
    attempt_count   INTEGER DEFAULT 0,
    max_attempts    INTEGER DEFAULT 3,
    qa_results      JSONB,
    execution_log   TEXT,

    -- Reply
    reply_sent      BOOLEAN DEFAULT FALSE,
    reply_draft_id  TEXT,
    reply_content   TEXT,

    -- Checkpoints
    checkpoint1_msg_id TEXT,
    checkpoint2_msg_id TEXT,

    -- Timestamps
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    claimed_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cos_contracts_state ON cos_contracts(state);
CREATE INDEX IF NOT EXISTS idx_cos_contracts_owner ON cos_contracts(owner);
CREATE INDEX IF NOT EXISTS idx_cos_contracts_poll
    ON cos_contracts(owner, state, claimed_by)
    WHERE state = 'PLANNING' AND claimed_by IS NULL;
