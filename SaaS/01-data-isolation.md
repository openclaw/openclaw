# OpenClaw SaaS — Data Isolation and PostgreSQL Schema Design

> **Document:** 01-data-isolation.md
> **Prerequisite:** 00-overview.md
> **Scope:** Tenant data model, full production-grade PostgreSQL DDL, RLS policies, indexes, partitioning, scaling roadmap

---

## 1. Design Parameters

```
╔══════════════════════════════════════════════════════════════╗
║         POSTGRESQL PRODUCTION SCHEMA DESIGN                  ║
╠══════════════════════════════════════════════════════════════╣
║ Domain:           Multi-channel AI gateway SaaS platform     ║
║ Scale Target:     10K tenants / 5M users / 50M sessions @12m ║
║ Tenancy Model:    Shared DB / Shared Schema + RLS            ║
║ ORM:              Drizzle ORM (TypeScript-native)            ║
║ Deployment:       Evolving — migrating from filesystem       ║
╠══════════════════════════════════════════════════════════════╣
║ Tables Designed:  14 core + 3 partitioned                    ║
║ Indexes:          42+                                        ║
║ RLS Policies:     28+ (2 per tenant-scoped table)            ║
║ Migrations:       Phased (see 03-migration-strategy.md)      ║
╚══════════════════════════════════════════════════════════════╝
```

### Inferences Made

- **Multi-tenant SaaS** — every tenant-scoped table carries `tenant_id UUID NOT NULL`
- **Append-only tables** (audit_logs, message_events) — partitioned by `created_at` from day one
- **Session data is high-churn** — aggressive autovacuum tuning applied
- **Secrets require encryption** — `encrypted_value` columns with envelope encryption (see 02-security-encryption.md)
- **Existing `accountId`** in OpenClaw maps to channel bot accounts within a tenant, not to SaaS tenants
- **Config is JSONB** — preserves flexibility of current JSON5 config while enabling DB-level queries
- **No financial/billing data** in this schema — billing tables covered separately in Phase 3

---

## 2. Extensions Required

```sql
-- Run once per database, by a superuser or rds_superuser
CREATE EXTENSION IF NOT EXISTS "pgcrypto";           -- gen_random_uuid(), pgp_sym_encrypt
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";  -- query performance monitoring
CREATE EXTENSION IF NOT EXISTS "pg_trgm";             -- trigram text search (session search, config search)
CREATE EXTENSION IF NOT EXISTS "vector";              -- pgvector for RAG/memory tenant isolation
```

---

## 3. Foundation Function

```sql
-- Shared updated_at trigger function (created once, used by all tables)
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

---

## 4. Schema DDL — Core Tables

### 4.1 tenants

```sql
-- ════════════════════════════════════
-- TABLE: tenants
-- Role: Root entity for multi-tenant isolation. Every SaaS customer is a tenant.
-- Scale class: BOUNDED (max ~100K tenants at extreme scale)
-- Write pattern: READ_HEAVY (written once, read on every request)
-- ════════════════════════════════════
CREATE TABLE tenants (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  slug            TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  plan            TEXT NOT NULL DEFAULT 'free',
  status          TEXT NOT NULL DEFAULT 'active',
  settings        JSONB NOT NULL DEFAULT '{}',

  -- Encryption key metadata (see 02-security-encryption.md)
  dek_id          UUID,                          -- references current data encryption key
  dek_version     INTEGER NOT NULL DEFAULT 1,

  -- Limits
  max_agents      INTEGER NOT NULL DEFAULT 5,
  max_channels    INTEGER NOT NULL DEFAULT 10,
  max_sessions    INTEGER NOT NULL DEFAULT 10000,

  -- Audit trail
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_tenants PRIMARY KEY (id),
  CONSTRAINT chk_tenants_plan CHECK (plan IN ('free', 'starter', 'pro', 'enterprise')),
  CONSTRAINT chk_tenants_status CHECK (status IN ('active', 'suspended', 'cancelled', 'pending')),
  CONSTRAINT chk_tenants_slug_length CHECK (length(slug) >= 3 AND length(slug) <= 63),
  CONSTRAINT chk_tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]*[a-z0-9]$')
);

CREATE UNIQUE INDEX idx_tenants_slug_active
  ON tenants(slug)
  WHERE deleted_at IS NULL;

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- NOTE: tenants table does NOT have RLS — it is the root.
-- Access is controlled by the application layer (admin routes only).
```

### 4.2 users

```sql
-- ════════════════════════════════════
-- TABLE: users
-- Role: SaaS user accounts. A user belongs to one or more tenants via tenant_members.
-- Scale class: SLOW_GROWTH (1–5M at 12 months)
-- Write pattern: READ_HEAVY
-- ════════════════════════════════════
CREATE TABLE users (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  password_hash   TEXT,                          -- bcrypt/argon2; NULL if SSO-only
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  status          TEXT NOT NULL DEFAULT 'active',

  -- OIDC / SSO
  oidc_provider   TEXT,                          -- e.g. 'google', 'github', 'okta'
  oidc_subject    TEXT,                          -- provider-specific subject ID

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_users PRIMARY KEY (id),
  CONSTRAINT chk_users_status CHECK (status IN ('active', 'suspended', 'pending')),
  CONSTRAINT chk_users_email CHECK (email ~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$')
);

CREATE UNIQUE INDEX idx_users_email_active
  ON users(email)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_users_oidc_active
  ON users(oidc_provider, oidc_subject)
  WHERE oidc_provider IS NOT NULL AND oidc_subject IS NOT NULL AND deleted_at IS NULL;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- NOTE: users table does NOT have tenant-scoped RLS.
-- User-to-tenant mapping is via tenant_members.
```

### 4.3 tenant_members

```sql
-- ════════════════════════════════════
-- TABLE: tenant_members
-- Role: M:N join between users and tenants. Carries role within the tenant.
-- Scale class: SLOW_GROWTH
-- Write pattern: BALANCED
-- ════════════════════════════════════
CREATE TABLE tenant_members (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  user_id         UUID NOT NULL,
  role            TEXT NOT NULL DEFAULT 'member',
  invited_by      UUID,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_tenant_members PRIMARY KEY (id),
  CONSTRAINT fk_tenant_members_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_members_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_members_invited_by FOREIGN KEY (invited_by)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_tenant_members_role CHECK (role IN ('owner', 'admin', 'member', 'viewer'))
);

CREATE UNIQUE INDEX idx_tenant_members_active
  ON tenant_members(tenant_id, user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_tenant_members_user
  ON tenant_members(user_id);

CREATE TRIGGER trg_tenant_members_updated_at
  BEFORE UPDATE ON tenant_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: scoped to tenant
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_members FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_members
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON tenant_members
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 4.4 tenant_configs

```sql
-- ════════════════════════════════════
-- TABLE: tenant_configs
-- Role: Per-tenant OpenClaw configuration (replaces per-instance openclaw.json).
--       The config_data JSONB column holds the full OpenClawConfig structure.
-- Scale class: BOUNDED (one active config per tenant)
-- Write pattern: READ_HEAVY (read on every request; written on config changes)
-- ════════════════════════════════════
CREATE TABLE tenant_configs (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  config_data     JSONB NOT NULL DEFAULT '{}',
  config_hash     TEXT,                          -- SHA-256 of serialized config
  version         INTEGER NOT NULL DEFAULT 1,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by      UUID,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_tenant_configs PRIMARY KEY (id),
  CONSTRAINT fk_tenant_configs_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tenant_configs_updated_by FOREIGN KEY (updated_by)
    REFERENCES users(id) ON DELETE SET NULL
);

-- Only one active config per tenant
CREATE UNIQUE INDEX idx_tenant_configs_active
  ON tenant_configs(tenant_id)
  WHERE is_active = TRUE;

CREATE INDEX CONCURRENTLY idx_tenant_configs_tenant
  ON tenant_configs(tenant_id);

-- GIN index for JSONB key lookups (e.g. querying channel config)
CREATE INDEX CONCURRENTLY idx_tenant_configs_data_gin
  ON tenant_configs USING GIN(config_data);

CREATE TRIGGER trg_tenant_configs_updated_at
  BEFORE UPDATE ON tenant_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_configs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON tenant_configs
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 4.5 tenant_secrets

```sql
-- ════════════════════════════════════
-- TABLE: tenant_secrets
-- Role: Encrypted per-tenant secrets (API keys, tokens, channel credentials).
--       Never stores plaintext. See 02-security-encryption.md for envelope encryption design.
-- Scale class: SLOW_GROWTH (~50 secrets per tenant)
-- Write pattern: READ_HEAVY
-- ════════════════════════════════════
CREATE TABLE tenant_secrets (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  key             TEXT NOT NULL,                  -- semantic key: e.g. 'openai_api_key', 'telegram_bot_token'
  encrypted_value BYTEA NOT NULL,                 -- AES-256-GCM encrypted
  iv              BYTEA NOT NULL,                 -- initialization vector
  dek_version     INTEGER NOT NULL DEFAULT 1,     -- which DEK version encrypted this
  provider        TEXT,                            -- optional: which provider this belongs to
  metadata        JSONB NOT NULL DEFAULT '{}',    -- non-sensitive metadata (label, last rotated, etc.)
  expires_at      TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_tenant_secrets PRIMARY KEY (id),
  CONSTRAINT fk_tenant_secrets_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_tenant_secrets_key_length CHECK (length(key) >= 1 AND length(key) <= 255)
);

-- A tenant can have only one active secret per key
CREATE UNIQUE INDEX idx_tenant_secrets_key_active
  ON tenant_secrets(tenant_id, key)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_tenant_secrets_tenant
  ON tenant_secrets(tenant_id);

CREATE INDEX CONCURRENTLY idx_tenant_secrets_provider
  ON tenant_secrets(tenant_id, provider)
  WHERE provider IS NOT NULL;

CREATE TRIGGER trg_tenant_secrets_updated_at
  BEFORE UPDATE ON tenant_secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_secrets
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON tenant_secrets
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 4.6 agents

```sql
-- ════════════════════════════════════
-- TABLE: agents
-- Role: Per-tenant AI agent definitions (maps to current agents config).
-- Scale class: BOUNDED (~5-50 agents per tenant)
-- Write pattern: READ_HEAVY
-- ════════════════════════════════════
CREATE TABLE agents (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  agent_id        TEXT NOT NULL,                  -- human-readable slug, e.g. 'main', 'support-bot'
  display_name    TEXT,
  system_prompt   TEXT,
  model           TEXT,                           -- default model ID
  config_overlay  JSONB NOT NULL DEFAULT '{}',    -- agent-specific config overrides
  is_default      BOOLEAN NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_agents PRIMARY KEY (id),
  CONSTRAINT fk_agents_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_agents_agent_id CHECK (agent_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$')
);

CREATE UNIQUE INDEX idx_agents_tenant_agent_id
  ON agents(tenant_id, agent_id)
  WHERE deleted_at IS NULL;

-- Only one default agent per tenant
CREATE UNIQUE INDEX idx_agents_tenant_default
  ON agents(tenant_id)
  WHERE is_default = TRUE AND deleted_at IS NULL;

CREATE TRIGGER trg_agents_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agents
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON agents
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 4.7 channel_accounts

```sql
-- ════════════════════════════════════
-- TABLE: channel_accounts
-- Role: Per-tenant channel integrations (Telegram bot, Discord bot, Slack app, etc.)
--       Maps to the current per-channel config + credentials.
-- Scale class: BOUNDED (~1-20 per tenant)
-- Write pattern: READ_HEAVY
-- ════════════════════════════════════
CREATE TABLE channel_accounts (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  channel_type    TEXT NOT NULL,                  -- 'telegram', 'discord', 'slack', etc.
  account_id      TEXT NOT NULL,                  -- channel-specific account identifier
  display_name    TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  config          JSONB NOT NULL DEFAULT '{}',    -- channel-specific config (non-secret)
  secret_ids      UUID[] DEFAULT '{}',            -- references to tenant_secrets for this channel
  webhook_path    TEXT,                           -- unique webhook path for inbound messages
  dm_policy       TEXT NOT NULL DEFAULT 'pairing',
  group_policy    TEXT NOT NULL DEFAULT 'allowlist',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_channel_accounts PRIMARY KEY (id),
  CONSTRAINT fk_channel_accounts_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_channel_accounts_status CHECK (status IN ('active', 'inactive', 'error', 'pending')),
  CONSTRAINT chk_channel_accounts_dm_policy CHECK (dm_policy IN ('pairing', 'allowlist', 'open', 'disabled')),
  CONSTRAINT chk_channel_accounts_group_policy CHECK (group_policy IN ('open', 'disabled', 'allowlist'))
);

CREATE UNIQUE INDEX idx_channel_accounts_tenant_type_account
  ON channel_accounts(tenant_id, channel_type, account_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX idx_channel_accounts_webhook
  ON channel_accounts(webhook_path)
  WHERE webhook_path IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_channel_accounts_tenant
  ON channel_accounts(tenant_id);

CREATE TRIGGER trg_channel_accounts_updated_at
  BEFORE UPDATE ON channel_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE channel_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_accounts
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON channel_accounts
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 4.8 channel_allowlists

```sql
-- ════════════════════════════════════
-- TABLE: channel_allowlists
-- Role: Per-channel-account allowlist entries (replaces {channel}-allowFrom.json files).
-- Scale class: SLOW_GROWTH
-- Write pattern: BALANCED (written during pairing, read on every inbound message)
-- ════════════════════════════════════
CREATE TABLE channel_allowlists (
  id                UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id         UUID NOT NULL,
  channel_account_id UUID NOT NULL,
  sender_id         TEXT NOT NULL,                -- channel-specific sender identifier
  source            TEXT NOT NULL DEFAULT 'pairing',
  granted_by        UUID,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,

  CONSTRAINT pk_channel_allowlists PRIMARY KEY (id),
  CONSTRAINT fk_channel_allowlists_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_channel_allowlists_channel FOREIGN KEY (channel_account_id)
    REFERENCES channel_accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_channel_allowlists_granted_by FOREIGN KEY (granted_by)
    REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT chk_channel_allowlists_source CHECK (source IN ('pairing', 'config', 'manual', 'import'))
);

CREATE UNIQUE INDEX idx_channel_allowlists_sender
  ON channel_allowlists(channel_account_id, sender_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY idx_channel_allowlists_tenant
  ON channel_allowlists(tenant_id);

CREATE INDEX CONCURRENTLY idx_channel_allowlists_channel
  ON channel_allowlists(channel_account_id);

ALTER TABLE channel_allowlists ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_allowlists FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON channel_allowlists
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON channel_allowlists
  USING (current_setting('app.bypass_rls', true) = 'on');
```

---

## 5. Schema DDL — Session and Conversation Tables

### 5.1 sessions

```sql
-- ════════════════════════════════════
-- TABLE: sessions
-- Role: Conversation sessions (replaces the in-memory/JSON session store).
--       This is the highest-churn table in the system.
-- Scale class: FAST_GROWTH (10–50M rows at 12 months)
-- Write pattern: UPDATE_HEAVY (updated on every message exchange)
-- ════════════════════════════════════
CREATE TABLE sessions (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  session_key     TEXT NOT NULL,                  -- structured key: 'agent:{agentId}:{rest}'
  agent_id        TEXT NOT NULL DEFAULT 'main',
  channel_type    TEXT,
  channel_account_id UUID,
  peer_id         TEXT,                           -- channel-specific peer identifier
  peer_kind       TEXT DEFAULT 'direct',          -- 'direct', 'group', 'channel'

  -- Session state (mirrors current SessionEntry fields)
  model           TEXT,
  system_prompt   TEXT,
  messages        JSONB NOT NULL DEFAULT '[]',    -- conversation history
  delivery_context JSONB,                         -- last known delivery context
  metadata        JSONB NOT NULL DEFAULT '{}',    -- extensible session metadata

  -- Lifecycle
  status          TEXT NOT NULL DEFAULT 'active',
  message_count   INTEGER NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_sessions PRIMARY KEY (id),
  CONSTRAINT fk_sessions_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_channel FOREIGN KEY (channel_account_id)
    REFERENCES channel_accounts(id) ON DELETE SET NULL,
  CONSTRAINT chk_sessions_status CHECK (status IN ('active', 'archived', 'expired')),
  CONSTRAINT chk_sessions_peer_kind CHECK (peer_kind IN ('direct', 'group', 'channel'))
);

-- Primary lookup: tenant + session key
CREATE UNIQUE INDEX idx_sessions_tenant_key
  ON sessions(tenant_id, session_key)
  WHERE deleted_at IS NULL;

-- Agent-scoped queries
CREATE INDEX CONCURRENTLY idx_sessions_tenant_agent
  ON sessions(tenant_id, agent_id, last_activity_at DESC);

-- Channel-scoped queries
CREATE INDEX CONCURRENTLY idx_sessions_tenant_channel
  ON sessions(tenant_id, channel_account_id, last_activity_at DESC)
  WHERE channel_account_id IS NOT NULL;

-- Keyset pagination cursor
CREATE INDEX CONCURRENTLY idx_sessions_tenant_activity
  ON sessions(tenant_id, last_activity_at DESC, id DESC);

-- Stale session cleanup
CREATE INDEX CONCURRENTLY idx_sessions_last_activity
  ON sessions(last_activity_at)
  WHERE status = 'active';

-- Aggressive autovacuum for high-churn table
ALTER TABLE sessions SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_scale_factor = 0.005,
  fillfactor = 70
);

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON sessions
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 5.2 pairing_requests

```sql
-- ════════════════════════════════════
-- TABLE: pairing_requests
-- Role: Pending device/user pairing codes (replaces {channel}-pairing.json).
-- Scale class: BOUNDED (max 3 pending per channel account, TTL 1 hour)
-- Write pattern: BALANCED
-- ════════════════════════════════════
CREATE TABLE pairing_requests (
  id                UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id         UUID NOT NULL,
  channel_account_id UUID NOT NULL,
  code              TEXT NOT NULL,
  sender_id         TEXT NOT NULL,
  metadata          JSONB NOT NULL DEFAULT '{}',
  expires_at        TIMESTAMPTZ NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_pairing_requests PRIMARY KEY (id),
  CONSTRAINT fk_pairing_requests_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_pairing_requests_channel FOREIGN KEY (channel_account_id)
    REFERENCES channel_accounts(id) ON DELETE CASCADE,
  CONSTRAINT chk_pairing_code_length CHECK (length(code) = 8)
);

CREATE INDEX CONCURRENTLY idx_pairing_requests_channel_code
  ON pairing_requests(channel_account_id, code)
  WHERE expires_at > NOW();

CREATE INDEX CONCURRENTLY idx_pairing_requests_expiry
  ON pairing_requests(expires_at);

ALTER TABLE pairing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON pairing_requests
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON pairing_requests
  USING (current_setting('app.bypass_rls', true) = 'on');
```

---

## 6. Schema DDL — Partitioned Tables (Append-Only)

### 6.1 audit_logs (UNBOUNDED — partitioned from day one)

```sql
-- ════════════════════════════════════
-- TABLE: audit_logs
-- Role: Immutable audit trail for all sensitive operations.
-- Scale class: UNBOUNDED
-- Write pattern: INSERT_HEAVY (append-only, never updated)
-- Partition: RANGE on created_at (monthly)
-- ════════════════════════════════════
CREATE TABLE audit_logs (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  user_id         UUID,
  action          TEXT NOT NULL,                  -- e.g. 'secret.read', 'config.write', 'session.delete'
  resource_type   TEXT NOT NULL,                  -- e.g. 'tenant_secret', 'tenant_config', 'session'
  resource_id     UUID,
  details         JSONB NOT NULL DEFAULT '{}',    -- action-specific context
  ip_address      INET,
  user_agent      TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_audit_logs PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Initial partitions (create 3 months ahead; automate via cron)
CREATE TABLE audit_logs_y2026_m04
  PARTITION OF audit_logs
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE audit_logs_y2026_m05
  PARTITION OF audit_logs
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE audit_logs_y2026_m06
  PARTITION OF audit_logs
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Indexes on partitioned table
CREATE INDEX CONCURRENTLY idx_audit_logs_tenant_created
  ON audit_logs(tenant_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_audit_logs_action
  ON audit_logs(tenant_id, action, created_at DESC);

CREATE INDEX CONCURRENTLY idx_audit_logs_resource
  ON audit_logs(tenant_id, resource_type, resource_id);

-- Aggressive autovacuum
ALTER TABLE audit_logs SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay = 2
);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON audit_logs
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 6.2 message_events (UNBOUNDED — partitioned from day one)

```sql
-- ════════════════════════════════════
-- TABLE: message_events
-- Role: Inbound/outbound message log for analytics, debugging, and billing metering.
-- Scale class: UNBOUNDED
-- Write pattern: INSERT_HEAVY (append-only)
-- Partition: RANGE on created_at (monthly)
-- ════════════════════════════════════
CREATE TABLE message_events (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  session_id      UUID,
  channel_account_id UUID,
  direction       TEXT NOT NULL,                  -- 'inbound' or 'outbound'
  channel_type    TEXT,
  sender_id       TEXT,
  message_type    TEXT NOT NULL DEFAULT 'text',   -- 'text', 'media', 'command', 'system'
  content_hash    TEXT,                           -- SHA-256 of content (not content itself)
  token_count     INTEGER,                        -- LLM tokens consumed
  model           TEXT,                           -- model used for this interaction
  latency_ms      INTEGER,                        -- response latency
  metadata        JSONB NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT pk_message_events PRIMARY KEY (id, created_at),
  CONSTRAINT chk_message_events_direction CHECK (direction IN ('inbound', 'outbound')),
  CONSTRAINT chk_message_events_type CHECK (message_type IN ('text', 'media', 'command', 'system'))
) PARTITION BY RANGE (created_at);

-- Initial partitions
CREATE TABLE message_events_y2026_m04
  PARTITION OF message_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE message_events_y2026_m05
  PARTITION OF message_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE message_events_y2026_m06
  PARTITION OF message_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE INDEX CONCURRENTLY idx_message_events_tenant_created
  ON message_events(tenant_id, created_at DESC);

CREATE INDEX CONCURRENTLY idx_message_events_session
  ON message_events(tenant_id, session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX CONCURRENTLY idx_message_events_channel
  ON message_events(tenant_id, channel_account_id, created_at DESC)
  WHERE channel_account_id IS NOT NULL;

-- BRIN index for range scans on created_at (very efficient for time-series)
CREATE INDEX CONCURRENTLY idx_message_events_created_brin
  ON message_events USING BRIN(created_at);

ALTER TABLE message_events SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_delay = 2
);

ALTER TABLE message_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON message_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON message_events
  USING (current_setting('app.bypass_rls', true) = 'on');
```

### 6.3 memory_embeddings (pgvector — tenant-isolated RAG)

```sql
-- ════════════════════════════════════
-- TABLE: memory_embeddings
-- Role: Tenant-isolated vector store for RAG/memory (replaces LanceDB).
-- Scale class: FAST_GROWTH
-- Write pattern: INSERT_HEAVY (embeddings appended, rarely updated)
-- ════════════════════════════════════
CREATE TABLE memory_embeddings (
  id              UUID DEFAULT gen_random_uuid() NOT NULL,
  tenant_id       UUID NOT NULL,
  agent_id        TEXT NOT NULL DEFAULT 'main',
  source_type     TEXT NOT NULL,                  -- 'session', 'document', 'manual'
  source_id       TEXT,                           -- reference to source (session_id, doc path, etc.)
  content         TEXT NOT NULL,                  -- original text chunk
  embedding       vector(1536) NOT NULL,          -- OpenAI ada-002 dimensions; configurable
  metadata        JSONB NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ,

  CONSTRAINT pk_memory_embeddings PRIMARY KEY (id),
  CONSTRAINT fk_memory_embeddings_tenant FOREIGN KEY (tenant_id)
    REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_memory_embeddings_source CHECK (source_type IN ('session', 'document', 'manual'))
);

-- Tenant-scoped vector similarity search (IVFFlat for scale)
CREATE INDEX CONCURRENTLY idx_memory_embeddings_vector
  ON memory_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX CONCURRENTLY idx_memory_embeddings_tenant_agent
  ON memory_embeddings(tenant_id, agent_id);

CREATE INDEX CONCURRENTLY idx_memory_embeddings_tenant_source
  ON memory_embeddings(tenant_id, source_type, created_at DESC);

ALTER TABLE memory_embeddings SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01
);

ALTER TABLE memory_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON memory_embeddings
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);

CREATE POLICY service_bypass ON memory_embeddings
  USING (current_setting('app.bypass_rls', true) = 'on');
```

---

## 7. RLS Enforcement Contract

### 7.1 Application-Level RLS Setup

Every database query in the SaaS gateway **must** set the tenant context before executing:

```typescript
// Drizzle ORM middleware — runs before every query
async function withTenantContext<T>(
  db: DrizzleClient,
  tenantId: string,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // Set RLS context — this is the tenant isolation boundary
    await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`);
    return fn(tx);
  });
}

// Service/migration bypass (admin-only, never from user-facing code paths)
async function withServiceBypass<T>(
  db: DrizzleClient,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.bypass_rls = 'on'`);
    return fn(tx);
  });
}
```

### 7.2 Defense-in-Depth

RLS is the **primary** isolation mechanism. The application layer adds a **secondary** check:

```typescript
// Every query helper also includes tenant_id in WHERE clause
// This is belt-and-suspenders — RLS catches it if application code misses it
function getSessionsByTenant(tenantId: string) {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.tenant_id, tenantId)) // Application-level filter
    .orderBy(desc(sessions.last_activity_at));
  // RLS also enforces tenant_id match — double barrier
}
```

### 7.3 RLS Verification Test

```sql
-- Must be run as part of CI/CD and penetration testing
-- Attempt to read another tenant's data without RLS context
SET app.current_tenant_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- This must return 0 rows (tenant BBB data invisible to tenant AAA)
SELECT count(*) FROM sessions
WHERE tenant_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
-- Expected: 0

-- This must also return 0 rows (even without WHERE clause)
SELECT count(*) FROM tenant_secrets;
-- Expected: only tenant AAA's secrets
```

---

## 8. Data Flow: Filesystem to Database Mapping

| Current Filesystem Path                       | Database Table                           | Migration Strategy                                          |
| --------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `~/.openclaw/openclaw.json`                   | `tenant_configs.config_data`             | Parse JSON5 → validate → store as JSONB                     |
| `~/.openclaw/sessions/*.json`                 | `sessions`                               | Dual-write Phase 1; batch migrate existing                  |
| `~/.openclaw/credentials/{ch}-allowFrom.json` | `channel_allowlists`                     | Import entries; create channel_accounts first               |
| `~/.openclaw/credentials/{ch}-pairing.json`   | `pairing_requests`                       | Import pending; expired entries discarded                   |
| `~/.openclaw/credentials/oauth.json`          | `tenant_secrets` (encrypted)             | Encrypt → store; destroy plaintext                          |
| `~/.openclaw/auth-profiles.json`              | `tenant_secrets` + `tenant_configs.auth` | Split credentials from config                               |
| Env vars (`OPENAI_API_KEY`, etc.)             | `tenant_secrets`                         | Encrypt on import; env vars remain fallback for self-hosted |
| LanceDB vector files                          | `memory_embeddings`                      | Re-embed or bulk-insert existing vectors                    |

---

## 9. Scaling Roadmap

### At Current Design (10K tenants, 50M sessions)

- Shared schema + RLS handles isolation efficiently
- Partitioned tables (audit_logs, message_events) enable archival
- Connection pooling via PgBouncer handles horizontal gateway scaling

### At 10x Scale (100K tenants, 500M sessions)

- **sessions**: Consider partitioning by `tenant_id` hash (list partitioning) if single-tenant query patterns dominate
- **memory_embeddings**: Migrate IVFFlat to HNSW index for better recall at scale; increase `lists` parameter
- **Read replicas**: Route read-heavy queries (session list, config read) to replicas
- **Connection pool**: Scale PgBouncer to multiple instances behind HAProxy

### At 100x Scale (1M tenants)

- **Schema-per-tenant** for enterprise tier (compliance requirement)
- **CQRS**: Separate write DB from read/analytics DB
- **Materialized views** for dashboard aggregations
- **Dedicated DB** option for top-tier enterprise customers
- **Sharding**: Consider Citus or application-level sharding by tenant_id

---

## 10. Connection Pool Recommendation

```
CONNECTION POOL RECOMMENDATION
------------------------------
Deployment type: Containerized (Docker/K8s)

Required: PgBouncer in transaction mode
  pool_mode = transaction
  max_client_conn = 2000
  default_pool_size = 25
  reserve_pool_size = 5
  reserve_pool_timeout = 3

PostgreSQL settings:
  max_connections = 200
  statement_timeout = '30s'
  idle_in_transaction_session_timeout = '10s'
  lock_timeout = '5s'

Per gateway instance:
  Pool size = (vCPU_count * 2) + 1
  Example: 4 vCPU instance → pool_size = 9

RLS compatibility note:
  PgBouncer transaction mode resets session state (including SET LOCAL)
  between transactions. This is CORRECT for RLS — each transaction
  must explicitly SET LOCAL app.current_tenant_id.
  Do NOT use session mode with RLS.
```

---

## 11. Design Decisions Log

| #   | Decision                                                      | Reason                                                                             | Trade-off                                                                              |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | TEXT + CHECK over ENUM for status fields                      | ENUM requires non-transactional `ALTER TYPE` to extend                             | Slightly less type safety at DB level; CHECK compensates                               |
| 2   | JSONB for config_data instead of normalized columns           | Preserves 1:1 compatibility with OpenClawConfig type; schema evolves independently | Deep queries require JSONB operators; GIN index mitigates                              |
| 3   | JSONB for session messages instead of separate messages table | Matches current SessionEntry.messages array; avoids N+1 on conversation load       | Large sessions may hit TOAST; content pruning needed at application layer              |
| 4   | UUID PKs everywhere                                           | No sequential ID enumeration; required for public-facing APIs                      | 16 bytes vs 8 bytes per key; negligible at this scale                                  |
| 5   | Partitioned audit_logs from day one                           | Append-only unbounded table; retroactive partitioning requires downtime            | Partition key (created_at) must be in PK; cross-partition queries include created_at   |
| 6   | pgvector over separate LanceDB                                | Eliminates operational dependency; tenant isolation via RLS                        | pgvector IVFFlat recall slightly lower than HNSW at extreme scale; upgrade path exists |
| 7   | Envelope encryption for tenant_secrets                        | Per-tenant key rotation without re-encrypting all secrets globally                 | Application must manage DEK lifecycle; adds ~2ms per decrypt                           |
| 8   | channel_allowlists as separate table vs JSONB array           | Enables per-entry audit, source tracking, and partial updates                      | More JOINs for allowlist checks; cached at application layer                           |
| 9   | Separate tenant_configs table vs config columns on tenants    | Config versioning, audit trail, and potential rollback to previous config          | Extra JOIN; mitigated by unique active index + caching                                 |
| 10  | fillfactor = 70 on sessions table                             | High UPDATE rate benefits from HOT updates; reduces bloat by 30-40%                | 30% more disk space per page; acceptable trade-off for write performance               |
