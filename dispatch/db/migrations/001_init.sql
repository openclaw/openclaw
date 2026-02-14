-- 001_init.sql
-- Core Postgres schema for Real Dispatch v0 enforcement layer.
-- This migration establishes source-of-truth state, idempotency,
-- auditability, and evidence references required by P0 stories.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_state') THEN
    CREATE TYPE ticket_state AS ENUM (
      'NEW',
      'NEEDS_INFO',
      'TRIAGED',
      'APPROVAL_REQUIRED',
      'READY_TO_SCHEDULE',
      'SCHEDULE_PROPOSED',
      'SCHEDULED',
      'DISPATCHED',
      'ON_SITE',
      'IN_PROGRESS',
      'ON_HOLD',
      'COMPLETED_PENDING_VERIFICATION',
      'VERIFIED',
      'INVOICED',
      'CLOSED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'priority_level') THEN
    CREATE TYPE priority_level AS ENUM ('EMERGENCY', 'URGENT', 'ROUTINE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_type') THEN
    CREATE TYPE actor_type AS ENUM ('HUMAN', 'AGENT', 'SERVICE', 'SYSTEM');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_status') THEN
    CREATE TYPE approval_status AS ENUM ('PENDING', 'APPROVED', 'DENIED', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  address1 text NOT NULL CHECK (length(trim(address1)) > 0),
  address2 text,
  city text NOT NULL CHECK (length(trim(city)) > 0),
  region text,
  postal_code text,
  country text NOT NULL DEFAULT 'US',
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  access_instructions text,
  hours_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  phone text,
  email text,
  role text,
  escalation_level int CHECK (escalation_level IS NULL OR escalation_level >= 0),
  is_authorized_requester boolean NOT NULL DEFAULT false,
  is_authorized_approver boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  asset_tag text,
  asset_type text,
  make text,
  model text,
  serial text,
  install_date date,
  warranty_end_date date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  state ticket_state NOT NULL DEFAULT 'NEW',
  priority priority_level NOT NULL DEFAULT 'ROUTINE',
  incident_type text,
  summary text NOT NULL CHECK (length(trim(summary)) > 0),
  description text,
  nte_cents bigint NOT NULL DEFAULT 0 CHECK (nte_cents >= 0),
  customer_name text,
  customer_phone text,
  customer_email text,
  identity_signature text,
  identity_confidence int CHECK (identity_confidence IS NULL OR (identity_confidence >= 0 AND identity_confidence <= 100)),
  classification_confidence int CHECK (
    classification_confidence IS NULL OR
    (classification_confidence >= 0 AND classification_confidence <= 100)
  ),
  sop_handoff_required boolean NOT NULL DEFAULT false,
  sop_handoff_acknowledged boolean NOT NULL DEFAULT false,
  sop_handoff_prompt text,
  currency text NOT NULL DEFAULT 'USD' CHECK (length(trim(currency)) = 3),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  assigned_provider_id uuid,
  assigned_tech_id uuid,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    scheduled_start IS NULL
    OR scheduled_end IS NULL
    OR scheduled_end > scheduled_start
  )
);

CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_tickets_site ON tickets(site_id);
CREATE INDEX IF NOT EXISTS idx_tickets_account ON tickets(account_id);
CREATE INDEX IF NOT EXISTS idx_tickets_blind_intake_signature_created ON tickets(
  account_id,
  site_id,
  identity_signature,
  created_at
);
CREATE INDEX IF NOT EXISTS idx_tickets_state_priority_created ON tickets(state, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_state_schedule ON tickets(state, scheduled_start);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  actor_type actor_type NOT NULL,
  actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
  actor_role text,
  tool_name text NOT NULL CHECK (length(trim(tool_name)) > 0),
  request_id uuid NOT NULL,
  correlation_id text,
  trace_id text,
  before_state ticket_state,
  after_state ticket_state,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_ticket_created ON audit_events(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_tool_created ON audit_events(tool_name, created_at);

CREATE TABLE IF NOT EXISTS ticket_state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_state ticket_state,
  to_state ticket_state NOT NULL,
  audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ticket_state_transition_valid CHECK (
    (from_state IS NULL AND to_state = 'NEW')
    OR (from_state IS NULL AND to_state IN ('TRIAGED', 'READY_TO_SCHEDULE'))
    OR (from_state = 'NEW' AND to_state IN ('NEEDS_INFO', 'TRIAGED'))
    OR (from_state = 'NEEDS_INFO' AND to_state = 'TRIAGED')
    OR (
      from_state = 'TRIAGED'
      AND to_state IN ('APPROVAL_REQUIRED', 'READY_TO_SCHEDULE', 'DISPATCHED')
    )
    OR (
      from_state = 'APPROVAL_REQUIRED'
      AND to_state IN ('READY_TO_SCHEDULE', 'TRIAGED', 'IN_PROGRESS')
    )
    OR (from_state = 'READY_TO_SCHEDULE' AND to_state = 'SCHEDULE_PROPOSED')
    OR (from_state = 'SCHEDULE_PROPOSED' AND to_state = 'SCHEDULED')
    OR (from_state = 'SCHEDULED' AND to_state = 'DISPATCHED')
    OR (from_state = 'DISPATCHED' AND to_state = 'ON_SITE')
    OR (from_state = 'ON_SITE' AND to_state = 'IN_PROGRESS')
    OR (
      from_state = 'IN_PROGRESS'
      AND to_state IN ('ON_HOLD', 'COMPLETED_PENDING_VERIFICATION', 'APPROVAL_REQUIRED')
    )
    OR (from_state = 'ON_HOLD' AND to_state IN ('READY_TO_SCHEDULE', 'IN_PROGRESS'))
    OR (from_state = 'COMPLETED_PENDING_VERIFICATION' AND to_state = 'VERIFIED')
    OR (from_state = 'VERIFIED' AND to_state = 'INVOICED')
    OR (from_state = 'INVOICED' AND to_state = 'CLOSED')
  )
);

CREATE INDEX IF NOT EXISTS idx_transitions_ticket_created ON ticket_state_transitions(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transitions_from_to ON ticket_state_transitions(from_state, to_state);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id text NOT NULL CHECK (length(trim(actor_id)) > 0),
  endpoint text NOT NULL CHECK (length(trim(endpoint)) > 0),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (length(trim(request_hash)) > 0),
  response_code int NOT NULL CHECK (response_code >= 100 AND response_code <= 599),
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, endpoint, request_id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
CREATE INDEX IF NOT EXISTS idx_idempotency_actor_endpoint ON idempotency_keys(actor_id, endpoint);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  status approval_status NOT NULL DEFAULT 'PENDING',
  requested_by text NOT NULL CHECK (length(trim(requested_by)) > 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,
  approval_type text NOT NULL CHECK (length(trim(approval_type)) > 0),
  amount_delta_cents bigint CHECK (amount_delta_cents IS NULL OR amount_delta_cents >= 0),
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('APPROVED', 'DENIED', 'CANCELLED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_approvals_ticket_requested ON approvals(ticket_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS evidence_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (length(trim(kind)) > 0),
  uri text NOT NULL CHECK (length(trim(uri)) > 0),
  checksum text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_ticket_created ON evidence_items(ticket_id, created_at);
CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence_items(kind);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  channel text NOT NULL CHECK (length(trim(channel)) > 0),
  to_addr text,
  from_addr text,
  body text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket_created ON messages(ticket_id, created_at);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tickets_set_updated_at ON tickets;

CREATE TRIGGER trg_tickets_set_updated_at
BEFORE UPDATE ON tickets
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
