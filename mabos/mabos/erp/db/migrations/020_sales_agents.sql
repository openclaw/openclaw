-- 020_sales_agents.sql
-- Sales Agents: outreach sequences, messages, and handoff tracking

-- ── ALTER contacts ────────────────────────────────────────────────────
ALTER TABLE erp.contacts
  ADD COLUMN IF NOT EXISTS apollo_person_id TEXT,
  ADD COLUMN IF NOT EXISTS linkedin_url TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_apollo_person_id
  ON erp.contacts (apollo_person_id) WHERE apollo_person_id IS NOT NULL;

-- ── Outreach Sequences ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.outreach_sequences (
  id            TEXT PRIMARY KEY DEFAULT 'SEQ-' || substr(md5(random()::text), 1, 12),
  contact_id    UUID NOT NULL REFERENCES erp.contacts(id) ON DELETE CASCADE,
  sequence_type TEXT NOT NULL CHECK (sequence_type IN ('cold_outreach', 'warm_nurture', 're_engage', 'follow_up', 'onboarding')),
  current_step  INTEGER NOT NULL DEFAULT 1,
  total_steps   INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'stopped')),
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'instagram_dm', 'whatsapp', 'multi')),
  next_action_at TIMESTAMPTZ,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_sequences_next_action
  ON erp.outreach_sequences (next_action_at) WHERE status = 'active';

-- ── Outreach Messages ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.outreach_messages (
  id              TEXT PRIMARY KEY DEFAULT 'MSG-' || substr(md5(random()::text), 1, 12),
  sequence_id     TEXT REFERENCES erp.outreach_sequences(id) ON DELETE SET NULL,
  contact_id      UUID NOT NULL REFERENCES erp.contacts(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'instagram_dm', 'whatsapp')),
  direction       TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
  content_preview TEXT,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'sent', 'delivered', 'opened', 'clicked', 'replied', 'bounced')),
  sentiment       TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  agent_id        TEXT,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outreach_messages_contact
  ON erp.outreach_messages (contact_id);

-- ── Sales Handoffs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS erp.sales_handoffs (
  id              TEXT PRIMARY KEY DEFAULT 'HO-' || substr(md5(random()::text), 1, 12),
  contact_id      UUID NOT NULL REFERENCES erp.contacts(id) ON DELETE CASCADE,
  from_agent      TEXT NOT NULL,
  to_agent        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  context_summary TEXT,
  deal_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
