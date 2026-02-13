-- 001_init.sql
-- Postgres schema for v0 dispatch-api (starter)
-- NOTE: This is a template. Review constraints and enums for your domain.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ticket_state') THEN
    CREATE TYPE ticket_state AS ENUM (
      'NEW','NEEDS_INFO','TRIAGED','APPROVAL_REQUIRED','READY_TO_SCHEDULE',
      'SCHEDULE_PROPOSED','SCHEDULED','DISPATCHED','ON_SITE','IN_PROGRESS',
      'ON_HOLD','COMPLETED_PENDING_VERIFICATION','VERIFIED','INVOICED','CLOSED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'priority_level') THEN
    CREATE TYPE priority_level AS ENUM ('EMERGENCY','URGENT','ROUTINE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'actor_type') THEN
    CREATE TYPE actor_type AS ENUM ('HUMAN','AGENT','SERVICE','SYSTEM');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_status') THEN
    CREATE TYPE approval_status AS ENUM ('PENDING','APPROVED','DENIED','CANCELLED');
  END IF;
END $$;

-- Accounts/Sites/Contacts (minimal)
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sites (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  address1 text NOT NULL,
  address2 text,
  city text NOT NULL,
  region text,
  postal_code text,
  country text DEFAULT 'US',
  timezone text DEFAULT 'America/Los_Angeles',
  access_instructions text,
  hours_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id uuid REFERENCES sites(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  phone text,
  email text,
  role text,
  escalation_level int,
  is_authorized_requester boolean DEFAULT false,
  is_authorized_approver boolean DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Assets (door-centric, optional)
CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  asset_tag text,
  asset_type text, -- e.g., "AUTO_DOOR", "CLOSER", "LOCKSET"
  make text,
  model text,
  serial text,
  install_date date,
  warranty_end_date date,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Tickets
CREATE TABLE IF NOT EXISTS tickets (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,

  state ticket_state NOT NULL DEFAULT 'NEW',
  priority priority_level NOT NULL DEFAULT 'ROUTINE',
  incident_type text, -- versioned template key, e.g., "DOOR_WONT_LATCH_V1"
  summary text NOT NULL,
  description text,

  nte_cents bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',

  scheduled_start timestamptz,
  scheduled_end timestamptz,

  assigned_provider_id uuid, -- provider table deferred v0; use uuid placeholder
  assigned_tech_id uuid,     -- tech/user table deferred v0; use uuid placeholder

  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_state ON tickets(state);
CREATE INDEX IF NOT EXISTS idx_tickets_site ON tickets(site_id);
CREATE INDEX IF NOT EXISTS idx_tickets_account ON tickets(account_id);

-- Audit events (append-only)
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,

  actor_type actor_type NOT NULL,
  actor_id text NOT NULL, -- user id / service id
  actor_role text,        -- dispatcher/tech/finance/etc.

  tool_name text NOT NULL,
  request_id uuid NOT NULL,
  correlation_id text,
  trace_id text,

  before_state ticket_state,
  after_state ticket_state,

  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_ticket ON audit_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

-- State transitions
CREATE TABLE IF NOT EXISTS ticket_state_transitions (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  from_state ticket_state,
  to_state ticket_state NOT NULL,
  audit_event_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transitions_ticket ON ticket_state_transitions(ticket_id);

-- Idempotency
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id text NOT NULL,
  endpoint text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  response_code int NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, endpoint, request_id)
);

-- Approvals
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  status approval_status NOT NULL DEFAULT 'PENDING',
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by text,
  decided_at timestamptz,

  approval_type text NOT NULL, -- e.g., "NTE_INCREASE", "PROPOSAL"
  amount_delta_cents bigint,
  reason text,
  evidence jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_approvals_ticket ON approvals(ticket_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- Evidence items
CREATE TABLE IF NOT EXISTS evidence_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind text NOT NULL, -- "PHOTO_BEFORE", "PHOTO_AFTER", "SIGNATURE", etc.
  uri text NOT NULL,
  checksum text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_evidence_ticket ON evidence_items(ticket_id);

-- Messages (comms)
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  direction text NOT NULL, -- "INBOUND" / "OUTBOUND"
  channel text NOT NULL,   -- "SMS" / "EMAIL" / "PHONE" / "CHAT"
  to_addr text,
  from_addr text,
  body text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
