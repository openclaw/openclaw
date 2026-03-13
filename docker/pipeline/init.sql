-- OpenClaw Pipeline Schema
-- Multi-agent workflow: Market Analyzer -> Trend Finder -> Brainstormer -> Product Architect -> Software Engineer

CREATE TABLE IF NOT EXISTS trends (
    id              BIGSERIAL PRIMARY KEY,
    title           TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',
    source_type     TEXT NOT NULL DEFAULT 'manual',
    source_ref      TEXT,
    why_it_matters  TEXT,
    confidence_score NUMERIC(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
    novelty_score   NUMERIC(3,2) CHECK (novelty_score BETWEEN 0 AND 1),
    momentum_score  NUMERIC(3,2) CHECK (momentum_score BETWEEN 0 AND 1),
    tags_json       JSONB NOT NULL DEFAULT '[]',
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status          TEXT NOT NULL DEFAULT 'new'
                    CHECK (status IN ('new', 'reviewed', 'used', 'archived')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trends_status ON trends (status);
CREATE INDEX idx_trends_detected_at ON trends (detected_at DESC);

CREATE TABLE IF NOT EXISTS ideas (
    id                BIGSERIAL PRIMARY KEY,
    trend_id          BIGINT REFERENCES trends(id) ON DELETE SET NULL,
    title             TEXT NOT NULL,
    pitch             TEXT NOT NULL DEFAULT '',
    target_user       TEXT,
    problem           TEXT,
    why_now           TEXT,
    monetization      TEXT,
    opportunity_score NUMERIC(3,2) CHECK (opportunity_score BETWEEN 0 AND 1),
    status            TEXT NOT NULL DEFAULT 'generated'
                      CHECK (status IN ('generated', 'shortlisted', 'selected', 'rejected')),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ideas_status ON ideas (status);
CREATE INDEX idx_ideas_trend_id ON ideas (trend_id);

CREATE TABLE IF NOT EXISTS product_specs (
    id                  BIGSERIAL PRIMARY KEY,
    idea_id             BIGINT REFERENCES ideas(id) ON DELETE SET NULL,
    title               TEXT NOT NULL,
    problem_statement   TEXT,
    solution_summary    TEXT,
    target_user         TEXT,
    mvp_scope           TEXT,
    features_json       JSONB NOT NULL DEFAULT '[]',
    non_goals_json      JSONB NOT NULL DEFAULT '[]',
    architecture_json   JSONB NOT NULL DEFAULT '{}',
    risks_json          JSONB NOT NULL DEFAULT '[]',
    rollout_phases_json JSONB NOT NULL DEFAULT '[]',
    status              TEXT NOT NULL DEFAULT 'drafted'
                        CHECK (status IN ('drafted', 'approved', 'ready_for_engineering', 'archived')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_specs_status ON product_specs (status);
CREATE INDEX idx_product_specs_idea_id ON product_specs (idea_id);

CREATE TABLE IF NOT EXISTS engineering_tasks (
    id              BIGSERIAL PRIMARY KEY,
    product_spec_id BIGINT REFERENCES product_specs(id) ON DELETE SET NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    priority        TEXT NOT NULL DEFAULT 'medium'
                    CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    task_type       TEXT NOT NULL DEFAULT 'feature'
                    CHECK (task_type IN ('feature', 'infra', 'api', 'schema', 'test', 'docs', 'devops')),
    status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned', 'in_progress', 'blocked', 'completed')),
    sequence_order  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_engineering_tasks_status ON engineering_tasks (status);
CREATE INDEX idx_engineering_tasks_spec_id ON engineering_tasks (product_spec_id);

CREATE TABLE IF NOT EXISTS agent_runs (
    id              BIGSERIAL PRIMARY KEY,
    agent_name      TEXT NOT NULL,
    input_ref_type  TEXT,
    input_ref_id    BIGINT,
    output_ref_type TEXT,
    output_ref_id   BIGINT,
    summary         TEXT,
    status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_agent_runs_agent ON agent_runs (agent_name, started_at DESC);

-- Trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_trends_updated BEFORE UPDATE ON trends
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ideas_updated BEFORE UPDATE ON ideas
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_product_specs_updated BEFORE UPDATE ON product_specs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_engineering_tasks_updated BEFORE UPDATE ON engineering_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
