-- Migration 028: Optimization engines — offer angles, authority scheduler,
-- VSL retention, setter routing, retainer funnel
--
-- Adds tables for:
--   - offer_angle_combos: active combo tracking + fatigue state
--   - offer_angle_decisions: rotation decision audit log
--   - content_queue: authority scheduler content items
--   - content_calendar: weekly content schedule
--   - vsl_retention_metrics: per-variant retention data
--   - setter_routing_log: routing decision audit
--   - setter_lead_assignments: daily lead assignments
--   - retainer_candidates: detected retainer candidates
--   - retainer_sequence_steps: outreach sequence tracking

-- ── Offer Angle Rotation Matrix ──

CREATE TABLE IF NOT EXISTS offer_angle_combos (
    combo_id TEXT PRIMARY KEY,
    offer_id TEXT NOT NULL,
    angle_id TEXT NOT NULL,
    hook_id TEXT NOT NULL,
    cta_id TEXT NOT NULL,
    format_id TEXT NOT NULL,
    audience_id TEXT NOT NULL,
    brand TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',      -- active | paused | killed | rotated
    fatigue_group TEXT,
    impressions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    revenue_cents INTEGER DEFAULT 0,
    cpa_cents INTEGER DEFAULT 0,
    roas REAL DEFAULT 0.0,
    last_fatigue_check TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_offer_angle_combos_brand
    ON offer_angle_combos(brand, status);

CREATE TABLE IF NOT EXISTS offer_angle_decisions (
    id TEXT PRIMARY KEY,
    combo_id TEXT NOT NULL,
    brand TEXT NOT NULL,
    action TEXT NOT NULL,        -- hold | rotate | promote | kill
    reason TEXT NOT NULL,
    next_combo_id TEXT,
    metrics_json TEXT,           -- snapshot of metrics at decision time
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_offer_angle_decisions_combo
    ON offer_angle_decisions(combo_id, created_at);

-- Fatigue tracking per angle/group
CREATE TABLE IF NOT EXISTS angle_fatigue_log (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    fatigue_group TEXT NOT NULL,
    angle_id TEXT NOT NULL,
    frequency REAL,
    ctr_now REAL,
    ctr_prev REAL,
    cpc_now REAL,
    cpc_prev REAL,
    fatigued INTEGER NOT NULL DEFAULT 0,
    reasons_json TEXT,
    checked_at TEXT NOT NULL
);

-- ── Authority Content Scheduler ──

CREATE TABLE IF NOT EXISTS content_queue (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL,
    content_type TEXT NOT NULL,   -- case_study | hook | mechanism | social_proof | authority_post | cta | engagement
    format TEXT NOT NULL,         -- reel | carousel | story | email
    angle_id TEXT,
    offer_id TEXT,
    topic TEXT,
    source_asset_url TEXT,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft | review | scheduled | posted | skipped
    priority TEXT NOT NULL DEFAULT 'medium',
    due_date TEXT,
    owner TEXT,
    output_links_json TEXT,
    post_id TEXT,
    week_start TEXT,
    day_of_week INTEGER,
    idempotency_key TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_content_queue_brand_status
    ON content_queue(brand, status);

CREATE INDEX IF NOT EXISTS ix_content_queue_week
    ON content_queue(brand, week_start);

-- ── VSL Retention Metrics ──

CREATE TABLE IF NOT EXISTS vsl_retention_metrics (
    id TEXT PRIMARY KEY,
    vsl_id TEXT NOT NULL,
    variant_id TEXT NOT NULL,
    views INTEGER DEFAULT 0,
    avg_watch_pct REAL DEFAULT 0,
    p25_retention REAL DEFAULT 0,
    p50_retention REAL DEFAULT 0,
    p75_retention REAL DEFAULT 0,
    p90_retention REAL DEFAULT 0,
    retention_score REAL DEFAULT 0,
    drop_off_minute REAL DEFAULT 0,
    cta_clicks INTEGER DEFAULT 0,
    cta_click_rate REAL DEFAULT 0,
    bookings INTEGER DEFAULT 0,
    booking_rate REAL DEFAULT 0,
    applications INTEGER DEFAULT 0,
    application_rate REAL DEFAULT 0,
    conversions INTEGER DEFAULT 0,
    conversion_rate REAL DEFAULT 0,
    revenue_cents INTEGER DEFAULT 0,
    diagnosis TEXT,
    suggested_action TEXT,
    window_start TEXT,
    window_end TEXT,
    computed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_vsl_retention_vsl
    ON vsl_retention_metrics(vsl_id, variant_id);

-- ── Setter Routing ──

CREATE TABLE IF NOT EXISTS setter_routing_log (
    id TEXT PRIMARY KEY,
    lead_contact_key TEXT NOT NULL,
    brand TEXT NOT NULL,
    setter_id TEXT NOT NULL,
    setter_name TEXT,
    lead_quality_score REAL,
    setter_composite_score REAL,
    lead_tier TEXT,           -- high | standard | training
    offer_id TEXT,
    routing_reason TEXT,
    is_override INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_setter_routing_log_setter
    ON setter_routing_log(setter_id, created_at);

CREATE INDEX IF NOT EXISTS ix_setter_routing_log_lead
    ON setter_routing_log(lead_contact_key);

CREATE TABLE IF NOT EXISTS setter_lead_assignments (
    id TEXT PRIMARY KEY,
    setter_id TEXT NOT NULL,
    brand TEXT NOT NULL,
    date TEXT NOT NULL,
    assigned_count INTEGER DEFAULT 0,
    max_daily INTEGER DEFAULT 15,
    UNIQUE(setter_id, date)
);

-- ── Retainer Conversion Funnel ──

CREATE TABLE IF NOT EXISTS retainer_candidates (
    id TEXT PRIMARY KEY,
    client_contact_key TEXT NOT NULL,
    brand TEXT NOT NULL,
    total_spend_cents INTEGER DEFAULT 0,
    projects_completed INTEGER DEFAULT 0,
    days_since_first_purchase INTEGER DEFAULT 0,
    retainer_offer_id TEXT,
    status TEXT NOT NULL DEFAULT 'detected',  -- detected | assets_generated | outreach_queued | converted | dismissed
    assets_json TEXT,                          -- pitch doc, dm script, email, etc.
    detected_at TEXT NOT NULL,
    converted_at TEXT,
    idempotency_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS ix_retainer_candidates_status
    ON retainer_candidates(status, brand);

CREATE TABLE IF NOT EXISTS retainer_sequence_steps (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES retainer_candidates(id),
    seq_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    channel TEXT NOT NULL,       -- email | dm
    template TEXT NOT NULL,
    scheduled_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | skipped | approved
    sent_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_retainer_sequence_candidate
    ON retainer_sequence_steps(candidate_id, status);
