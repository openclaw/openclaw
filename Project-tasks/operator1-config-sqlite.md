# Operator1 SQLite Consolidation

**Status:** Implementation Guide (Approved Direction)
**Created:** 2026-03-05
**Updated:** 2026-03-11
**Author:** Operator1 (from Rohit's request)

---

## Summary

Consolidate Operator1's scattered config and state files into **two storage layers**:

1. **`openclaw.json`** — base config file (JSON5, kept for upstream compatibility during transition)
2. **`~/.openclaw/operator1.db`** — single SQLite database for everything else

**End goal:** potentially collapse into a single `operator1.db` file once the config migration path is proven.

**Fork strategy:** Operator1 is intentionally diverging from upstream OpenClaw. Dedicated developers will handle upstream merge reconciliation. This migration should not be constrained by upstream compatibility concerns.

**Cleanup policy:** No backward compatibility. After each phase, old JSON file I/O code is **removed** (not commented out, not kept as fallback). Each phase is a hard cutover — once data is migrated to SQLite, the JSON code paths are deleted and the source JSON files are removed. This keeps the codebase clean and avoids dual-path maintenance burden. The `openclaw state export` CLI (Phase 0) provides a JSON dump for debugging/emergency recovery if ever needed.

---

## Current State: The Problem

### 3 Config Formats Across 60+ Files

Operator1 currently has config and state spread across **3 formats in 60+ files**:

#### Layer 1: Main Config — `openclaw.json` (JSON5) [upstream]

- `src/config/io.ts` — 1400-line processing pipeline
- Features: JSON5 parsing, `${ENV_VAR}` substitution, `$include` directives, validation, defaults
- Written rarely (~20KB), read on startup

#### Layer 2: Config Includes — `$include` files (JSON5) [upstream]

- `src/config/includes.ts` — deep-merge multiple JSON5 files into main config
- Supports circular detection, max depth 10, max 2MB per file

#### Layer 3: Agent YAML Manifests — `agents/*/agent.yaml` [operator1]

- 30+ YAML agent manifest files (neo, trinity, morpheus, tank, etc.)
- Synced into `openclaw.json` `agents.list` at runtime via:
  - `src/config/agent-config-sync.ts` — drift detection, manifest → config reconciliation
  - `src/config/agent-manifest-validation.ts` — YAML schema validation
  - `src/config/agent-workspace-deploy.ts` — workspace deployment
  - `src/config/agent-registry-sync.ts` — registry sync
  - `src/config/zod-schema.agent-manifest.ts` — Zod schema for YAML

#### Layer 4: Runtime State — 30+ JSON/JSONL files [mostly upstream]

**High-frequency writes:**

| File Pattern                         | What                    | Write Freq       | Origin        |
| ------------------------------------ | ----------------------- | ---------------- | ------------- |
| `agents/{id}/sessions/sessions.json` | Session store index     | Every message    | upstream      |
| `agents/{id}/sessions/*.jsonl`       | Session transcripts     | Every message    | upstream      |
| `subagents/runs.json`                | Subagent run metadata   | On spawn/cleanup | upstream      |
| `delivery-queue/*.json`              | Outbound message queue  | Every outbound   | upstream      |
| `teams/teams.json`                   | Team runs/members/tasks | On team changes  | **operator1** |
| `cron/runs/{jobId}.jsonl`            | Cron job run logs       | Per execution    | upstream      |

**Medium-frequency writes:**

| File Pattern                            | What                   | Origin   |
| --------------------------------------- | ---------------------- | -------- |
| `agents/{id}/agent/auth-profiles.json`  | API keys, OAuth tokens | upstream |
| `credentials/{channel}-pairing.json`    | Channel pairing state  | upstream |
| `credentials/{channel}-allowFrom.json`  | DM allowlists          | upstream |
| `telegram/update-offset-{id}.json`      | Polling offset         | upstream |
| `telegram/thread-bindings-{id}.json`    | Thread-session maps    | upstream |
| `telegram/sticker-cache.json`           | Sticker metadata cache | upstream |
| `discord/thread-bindings.json`          | Thread-session maps    | upstream |
| `discord/model-picker-preferences.json` | User model picks       | upstream |

**Low-frequency / rarely written:**

| File Pattern                               | What                                        | Origin   |
| ------------------------------------------ | ------------------------------------------- | -------- |
| `credentials/oauth.json`                   | OAuth creds (deprecated)                    | upstream |
| `credentials/github-copilot.token.json`    | Copilot token cache                         | upstream |
| `identity/device.json`                     | Device identity                             | upstream |
| `identity/device-auth.json`                | Device auth state                           | upstream |
| `settings/voicewake.json`                  | Wake words config                           | upstream |
| `settings/tts.json`                        | TTS preferences                             | upstream |
| `node.json`                                | Pi node-host config                         | upstream |
| `update-check.json`                        | Last update timestamp                       | upstream |
| `restart-sentinel.json`                    | Restart metadata                            | upstream |
| `cron/jobs.json`                           | Cron job definitions                        | upstream |
| `push/apns-registrations.json`             | iOS push registrations                      | upstream |
| `exec-approvals.json`                      | Approved exec commands (security-sensitive) | upstream |
| `mpm/catalog.json`, `plugins/catalog.json` | Plugin catalog / registry                   | upstream |

**Per-workspace state (inside agent workspace dirs):**

| File Pattern                                      | What                                                                      | Origin        |
| ------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| `{workspace}/.openclaw/workspace-state.json`      | Workspace metadata, version, last-active                                  | upstream      |
| `{workspace}/.openclaw/clawhub/catalog.json`      | ClawHub skill catalog for this workspace                                  | **operator1** |
| `{workspace}/.openclaw/clawhub/clawhub.lock.json` | ClawHub install lock                                                      | **operator1** |
| `{workspace}/.openclaw/clawhub/previews/*.json`   | Cached skill preview metadata                                             | **operator1** |
| `{workspace}/memory/heartbeat-state.json`         | Memory subsystem heartbeat timestamps (qmd_keepalive, memory_maintenance) | **operator1** |

**Global runtime config:**

| File Pattern         | What                                                                                                | Origin        |
| -------------------- | --------------------------------------------------------------------------------------------------- | ------------- |
| `matrix-agents.json` | Matrix agent definitions (Operator1, Neo, Morpheus, Trinity, etc.) — runtime config, not a template | **operator1** |

**Stays as JSON/YAML (not migrated):**

| File Pattern       | What                                          | Why                                           |
| ------------------ | --------------------------------------------- | --------------------------------------------- |
| `mcp/servers.yaml` | MCP server definitions (may contain API keys) | Stays YAML — user-edited, MCP-specific format |

**Audit/debug logs (append-only JSONL):**

| File Pattern                       | What                     | Origin   |
| ---------------------------------- | ------------------------ | -------- |
| `logs/config-audit.jsonl`          | Config write audit trail | upstream |
| `logs/cache-trace.jsonl`           | Memory cache debug       | upstream |
| `logs/anthropic-payload-log.jsonl` | API payload debug        | upstream |

### Origin Breakdown

- **~35 global state file patterns** — upstream OpenClaw architecture (Peter Steinberger, Onur, etc.)
- **~6 files** — operator1 additions (teams, memory, clawhub catalog/lock/previews)
- **38 agent YAML manifests** — operator1 marketplace system
- **Config sync engine** (5 TS files) — operator1
- **Per-workspace state** — `workspace-state.json` (upstream) + clawhub files (operator1) per workspace
- **Total runtime JSON/JSONL/YAML file patterns: ~120+** (counting per-agent, per-workspace, per-channel variations)

### Current Config Flow

```
agents/*.yaml (30+ YAML manifests)  ──── operator1
        │
        ▼ agent-config-sync
openclaw.json + $include files (JSON5) ── upstream
        │
        ▼ io.ts pipeline (JSON5 → env vars → includes → validate → defaults)
Runtime OpenClawConfig object
        │
        ▼
Gateway RPC → UI / CLI / Agents
```

---

## Target State

### Two-layer architecture (transitional)

```
~/.openclaw/
├── openclaw.json              # Base config — JSON5 (kept during transition)
└── operator1.db               # Everything else — single SQLite file
```

### Single-layer architecture (end goal)

```
~/.openclaw/
└── operator1.db               # Everything — config + state + agents
```

### Table Naming Convention

All tables use **domain prefixes** for organization as the table count grows. Upstream-originated and operator1-specific tables are clearly separated:

**Upstream-originated domains** (migrated from OpenClaw core):

| Prefix       | Domain         | Tables                                                                                                            |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `core_`      | Infrastructure | `core_schema_version`, `core_config`, `core_settings`                                                             |
| `session_`   | Sessions       | `session_entries`                                                                                                 |
| `delivery_`  | Outbound       | `delivery_queue`                                                                                                  |
| `agent_`     | Agents         | `agent_subagent_runs`, `agent_auth_profiles`                                                                      |
| `channel_`   | Channels       | `channel_pairing`, `channel_allowlist_entries`, `channel_thread_bindings`, `channel_tg_state`, `channel_dc_state` |
| `cron_`      | Cron           | `cron_jobs`, `cron_runs`                                                                                          |
| `auth_`      | Auth           | `auth_credentials`                                                                                                |
| `security_`  | Security       | `security_exec_approvals`                                                                                         |
| `plugin_`    | Plugins        | `plugin_catalog`                                                                                                  |
| `workspace_` | Workspaces     | `workspace_state`                                                                                                 |
| `audit_`     | Audit          | `audit_state`, `audit_config`                                                                                     |

**Operator1-specific domain** (`op1_` prefix):

| Prefix         | Domain                   | Tables                                                                         |
| -------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `op1_team_`    | Teams                    | `op1_team_registry`, `op1_team_members`, `op1_team_tasks`, `op1_team_messages` |
| `op1_agent_`   | Agent marketplace        | `op1_agent_manifests`                                                          |
| `op1_clawhub_` | ClawHub skills           | `op1_clawhub_catalog`, `op1_clawhub_locks`                                     |
| `op1_`         | Other operator1 features | `op1_settings` (heartbeat, matrix_agents, future features)                     |

> **Convention:** All new operator1-specific features use the `op1_` prefix. This makes it
> immediately clear at the schema level what's ours vs what originated from upstream.
> Future feature domains (analytics, billing, marketplace transactions, etc.) go under
> `op1_analytics_*`, `op1_billing_*`, etc.

### What goes into `operator1.db`

**Upstream-originated state:**

| Table                           | Replaces                                                          | Priority                                     |
| ------------------------------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `session_entries`               | `agents/{id}/sessions/sessions.json`                              | P0 — highest pain                            |
| `delivery_queue`                | `delivery-queue/*.json`                                           | P0                                           |
| `agent_subagent_runs`           | `subagents/runs.json`                                             | P1                                           |
| `agent_auth_profiles`           | `agents/{id}/agent/auth-profiles.json`                            | P1                                           |
| `channel_pairing`               | `credentials/*-pairing.json`                                      | P1                                           |
| `channel_allowlist_entries`     | `credentials/*-allowFrom.json`                                    | P1                                           |
| `channel_thread_bindings`       | `telegram/thread-bindings-*.json`, `discord/thread-bindings.json` | P1                                           |
| `cron_jobs`                     | `cron/jobs.json`                                                  | P2                                           |
| `cron_runs`                     | `cron/runs/*.jsonl`                                               | P2                                           |
| `core_settings`                 | `settings/voicewake.json`, `settings/tts.json`                    | P2                                           |
| `core_settings` (scope=device)  | `identity/device.json`, `identity/device-auth.json`               | P2                                           |
| `auth_credentials`              | `credentials/oauth.json`, `github-copilot.token.json`             | P2                                           |
| `channel_tg_state`              | `telegram/update-offset-*.json`, `telegram/sticker-cache.json`    | P2                                           |
| `channel_dc_state`              | `discord/model-picker-preferences.json`                           | P2                                           |
| `core_settings` (scope=gateway) | `restart-sentinel.json`, `update-check.json`, `node.json`         | P2                                           |
| `core_settings` (scope=push)    | `push/apns-registrations.json`                                    | P2                                           |
| `security_exec_approvals`       | `exec-approvals.json`                                             | P2 (security-sensitive — add to audit scope) |
| `plugin_catalog`                | `mpm/catalog.json`, `plugins/catalog.json`                        | P2                                           |
| `workspace_state`               | `{workspace}/.openclaw/workspace-state.json`                      | P2                                           |
| `core_config`                   | `openclaw.json` (raw JSON5 blob initially)                        | P3 (end goal)                                |
| `audit_state`                   | `logs/config-audit.jsonl`                                         | Shared — all phases                          |

**Operator1-specific features:**

| Table                                                                          | Replaces                                                         | Priority                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `op1_team_registry`, `op1_team_members`, `op1_team_tasks`, `op1_team_messages` | `teams/teams.json`                                               | P0                                                       |
| `op1_clawhub_catalog`                                                          | `{workspace}/.openclaw/clawhub/catalog.json` + `previews/*.json` | P2                                                       |
| `op1_clawhub_locks`                                                            | `{workspace}/.openclaw/clawhub/clawhub.lock.json`                | P2                                                       |
| `op1_settings` (scope=`heartbeat`)                                             | `{workspace}/memory/heartbeat-state.json`                        | P2                                                       |
| `op1_settings` (scope=`matrix_agents`)                                         | `matrix-agents.json`                                             | P2 (temporary — migrates to `op1_agent_manifests` at P3) |
| `op1_agent_manifests`                                                          | `agents/*/agent.yaml` (38 manifests)                             | P3 (replaces YAML layer)                                 |

### What stays as files (permanently)

| File Pattern                       | Why                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `agents/{id}/sessions/*.jsonl`     | Append-only transcript logs — already optimal as sequential files |
| `logs/cache-trace.jsonl`           | Debug logs — optional, rotated, append-only                       |
| `logs/anthropic-payload-log.jsonl` | Debug logs — same                                                 |
| `mcp/servers.yaml`                 | MCP server definitions — user-edited YAML, MCP-specific format    |

---

## SQLite Schema

### Core Infrastructure

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;        -- Safe in WAL mode (no data loss on app crash; only OS crash risk, which WAL handles)
PRAGMA busy_timeout = 5000;         -- Wait up to 5s for write lock before returning SQLITE_BUSY (prevents hard errors on concurrent access)
PRAGMA wal_autocheckpoint = 1000;   -- Explicit: checkpoint after 1000 pages (tunable for high-frequency writes)
PRAGMA foreign_keys = ON;

-- Schema version tracking
CREATE TABLE core_schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER DEFAULT (unixepoch()),
  description TEXT
);
```

### P0 Tables — Sessions, Delivery Queue, Teams

```sql
-- Sessions (replaces per-agent sessions.json files)
CREATE TABLE session_entries (
  agent_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  session_id TEXT,
  session_file TEXT,
  channel TEXT,
  last_channel TEXT,
  last_to TEXT,
  last_account_id TEXT,
  last_thread_id TEXT,
  delivery_context_json TEXT,
  origin_json TEXT,
  display_name TEXT,
  group_name TEXT,
  model TEXT,
  department TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  extra_json TEXT,              -- Catch-all for fields we don't normalize
  PRIMARY KEY (agent_id, session_key)
);

CREATE INDEX idx_session_entries_updated ON session_entries(updated_at);
CREATE INDEX idx_session_entries_channel ON session_entries(agent_id, channel);

-- Delivery queue (replaces delivery-queue/*.json ephemeral files)
CREATE TABLE delivery_queue (
  queue_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending, delivered, failed
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_attempt_at INTEGER,          -- Unix timestamp for retry backoff scheduling
  last_attempted_at INTEGER,        -- When the most recent attempt occurred
  created_at INTEGER DEFAULT (unixepoch()),
  delivered_at INTEGER,
  failed_at INTEGER,
  error TEXT
);

CREATE INDEX idx_delivery_queue_status ON delivery_queue(status);
CREATE INDEX idx_delivery_queue_retry ON delivery_queue(status, next_attempt_at)
  WHERE status = 'pending';

-- Teams (replaces teams/teams.json) — operator1 owned
-- Normalized: members, tasks, and messages are separate tables (queryable, not JSON blobs)
CREATE TABLE op1_team_registry (
  team_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT,
  config_json TEXT,               -- Team-level settings (non-queryable metadata)
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE op1_team_members (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role TEXT,                      -- 'lead', 'member', 'observer'
  joined_at INTEGER,
  PRIMARY KEY (team_id, agent_id),
  FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
);

CREATE TABLE op1_team_tasks (
  task_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT,
  status TEXT,                    -- 'pending', 'in_progress', 'completed', 'failed'
  assigned_to TEXT,               -- agent_id
  priority INTEGER DEFAULT 0,
  result_json TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
);

CREATE INDEX idx_op1_team_tasks_status ON op1_team_tasks(team_id, status);
CREATE INDEX idx_op1_team_tasks_assigned ON op1_team_tasks(assigned_to);

CREATE TABLE op1_team_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL,
  agent_id TEXT,
  role TEXT,                      -- 'user', 'assistant', 'system'
  content TEXT,
  metadata_json TEXT,
  created_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES op1_team_registry(team_id) ON DELETE CASCADE
);

CREATE INDEX idx_op1_team_messages_team ON op1_team_messages(team_id, created_at);
```

### P1 Tables — Auth, Pairing, Thread Bindings

```sql
-- Subagent runs (replaces subagents/runs.json)
CREATE TABLE agent_subagent_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  parent_agent_id TEXT,
  status TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  metadata_json TEXT
);

CREATE INDEX idx_agent_subagent_runs_agent ON agent_subagent_runs(agent_id);
CREATE INDEX idx_agent_subagent_runs_status ON agent_subagent_runs(status);

-- Auth profiles (replaces agents/{id}/agent/auth-profiles.json)
CREATE TABLE agent_auth_profiles (
  agent_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credentials_json TEXT,        -- Future: encrypted at rest
  version INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (agent_id, profile_id)
);

-- Channel pairing (replaces credentials/{channel}-pairing.json)
CREATE TABLE channel_pairing (
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  pairing_data_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (channel, account_id)
);

-- DM allowlists (replaces credentials/{channel}-allowFrom.json)
-- Normalized: one row per allowed sender for fast hot-path lookups
-- (every inbound DM checks this — no JSON blob deserialization)
CREATE TABLE channel_allowlist_entries (
  channel TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  allowed_id TEXT NOT NULL,         -- The sender ID that is allowed
  added_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (channel, account_id, allowed_id)
);

CREATE INDEX idx_channel_allowlist_lookup ON channel_allowlist_entries(channel, allowed_id);

-- Thread bindings (replaces telegram/discord thread-bindings JSON files)
CREATE TABLE channel_thread_bindings (
  channel TEXT NOT NULL,          -- 'telegram', 'discord'
  account_id TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL,
  session_key TEXT,
  binding_data_json TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (channel, account_id, thread_id)
);

CREATE INDEX idx_channel_thread_bindings_session ON channel_thread_bindings(session_key);
```

### P2 Tables — Settings, Cron, Channel State

```sql
-- Cron jobs (replaces cron/jobs.json)
CREATE TABLE cron_jobs (
  job_id TEXT PRIMARY KEY,
  schedule TEXT NOT NULL,
  command TEXT,
  config_json TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);

-- Cron runs (replaces cron/runs/{jobId}.jsonl)
-- Retention: capped at max_rows_per_job (default 500) via scheduled cleanup
CREATE TABLE cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  status TEXT,
  output TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  FOREIGN KEY (job_id) REFERENCES cron_jobs(job_id) ON DELETE CASCADE
);

CREATE INDEX idx_cron_runs_job ON cron_runs(job_id, started_at);

-- Key-value settings — upstream scopes only (replaces voicewake.json, tts.json, device.json, etc.)
CREATE TABLE core_settings (
  scope TEXT NOT NULL,             -- 'voicewake', 'tts', 'device', 'device-auth', 'gateway', 'push'
  key TEXT NOT NULL DEFAULT '',
  value_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (scope, key)
);

-- Operator1-specific settings (replaces heartbeat-state.json, matrix-agents.json, future op1 KV)
CREATE TABLE op1_settings (
  scope TEXT NOT NULL,             -- 'heartbeat', 'matrix_agents', future op1 features
  key TEXT NOT NULL DEFAULT '',
  value_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (scope, key)
);

-- Telegram-specific state (replaces update-offset, sticker-cache)
CREATE TABLE channel_tg_state (
  account_id TEXT NOT NULL,
  key TEXT NOT NULL,              -- 'update_offset', 'sticker_cache'
  value_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (account_id, key)
);

-- Discord-specific state (replaces model-picker-preferences)
CREATE TABLE channel_dc_state (
  key TEXT NOT NULL,              -- 'model_picker_preferences'
  scope TEXT NOT NULL DEFAULT '',
  value_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (key, scope)
);

-- Credentials (replaces oauth.json, github-copilot.token.json)
CREATE TABLE auth_credentials (
  provider TEXT PRIMARY KEY,      -- 'oauth', 'github-copilot'
  credentials_json TEXT,
  expires_at INTEGER,             -- Token expiry (OAuth, Copilot tokens have TTLs)
  updated_at INTEGER
);

-- Exec approvals (replaces exec-approvals.json) — security-sensitive, audited
CREATE TABLE security_exec_approvals (
  approval_id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  scope TEXT,                     -- 'always', 'session', etc.
  session_key TEXT,               -- Required when scope='session'; enables cleanup when session ends
  agent_id TEXT,
  approved_by TEXT,               -- 'user', 'gateway', 'node'
  created_at INTEGER DEFAULT (unixepoch()),
  expires_at INTEGER              -- NULL = permanent
);

CREATE INDEX idx_security_exec_approvals_command ON security_exec_approvals(command);
CREATE INDEX idx_security_exec_approvals_session ON security_exec_approvals(session_key)
  WHERE session_key IS NOT NULL;

-- Plugin catalog (replaces mpm/catalog.json, plugins/catalog.json)
CREATE TABLE plugin_catalog (
  plugin_id TEXT PRIMARY KEY,
  source TEXT,                    -- 'mpm', 'local', 'clawhub'
  metadata_json TEXT,
  installed_version TEXT,
  updated_at INTEGER
);

-- Workspace state (replaces {workspace}/.openclaw/workspace-state.json)
-- Uses workspace_id UUID as PK (paths change when workspaces are renamed/moved)
CREATE TABLE workspace_state (
  workspace_id TEXT PRIMARY KEY,    -- UUID, stable across renames
  workspace_path TEXT NOT NULL,     -- Current path (updated on detect)
  agent_id TEXT NOT NULL DEFAULT '',
  state_version INTEGER DEFAULT 1,
  state_json TEXT,                  -- Workspace metadata, last-active, etc.
  updated_at INTEGER
);

CREATE INDEX idx_workspace_state_path ON workspace_state(workspace_path);

-- ClawHub catalog (replaces {workspace}/.openclaw/clawhub/catalog.json + previews)
-- Operator1-owned. Lock state is separate to avoid row churn on install/uninstall.
CREATE TABLE op1_clawhub_catalog (
  workspace_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  version TEXT,
  metadata_json TEXT,             -- Full skill metadata (stable)
  preview_json TEXT,              -- Cached preview (stable, replaces previews/*.json)
  installed_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (workspace_id, skill_slug),
  FOREIGN KEY (workspace_id) REFERENCES workspace_state(workspace_id) ON DELETE CASCADE
);

-- Separate lock state — changes frequently on install/uninstall without churning catalog rows
CREATE TABLE op1_clawhub_locks (
  workspace_id TEXT NOT NULL,
  skill_slug TEXT NOT NULL,
  lock_state TEXT,                -- 'installing', 'uninstalling', NULL (idle)
  lock_data_json TEXT,
  locked_at INTEGER,
  PRIMARY KEY (workspace_id, skill_slug),
  FOREIGN KEY (workspace_id) REFERENCES workspace_state(workspace_id) ON DELETE CASCADE
);
```

### P3 Tables — Agents & Config (End Goal)

```sql
-- Agent manifests (replaces agents/*/agent.yaml — 30+ files)
-- Eliminates the YAML layer and the config-sync engine entirely
CREATE TABLE op1_agent_manifests (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department TEXT,
  role TEXT,
  tier TEXT,
  is_default INTEGER DEFAULT 0,
  identity_json TEXT,             -- { name, emoji, avatar, theme }
  subagents_json TEXT,            -- { allowAgents, model, thinking }
  skills_json TEXT,
  workspace TEXT,
  agent_dir TEXT,
  manifest_json TEXT,             -- Full original manifest for lossless round-trip
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX idx_op1_agent_manifests_department ON op1_agent_manifests(department);

-- Config (replaces openclaw.json — end goal)
-- Uses named scope key (extensible to multi-env configs, snapshots, etc.)
CREATE TABLE core_config (
  scope TEXT PRIMARY KEY DEFAULT 'main',  -- 'main', or future: 'staging', 'snapshot:2026-03-11'
  body TEXT NOT NULL,                      -- Raw JSON5 string (includes resolved inline)
  hash TEXT,                               -- Snapshot hash for conflict detection
  updated_at INTEGER
);

-- Config audit (replaces logs/config-audit.jsonl)
CREATE TABLE audit_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT DEFAULT 'main',
  body_before TEXT,
  body_after TEXT,
  source TEXT,                    -- 'cli', 'ui', 'gateway', 'agent'
  pid INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);
```

### Audit Table

```sql
-- State audit — security-sensitive tables only
-- Scoped to: auth_credentials, agent_auth_profiles, channel_pairing, channel_allowlist_entries, security_exec_approvals, core_config
-- Routine high-frequency tables (session_entries, delivery_queue, cron_runs) are excluded
-- to avoid noise and unbounded growth
CREATE TABLE audit_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  record_key TEXT,
  action TEXT NOT NULL,           -- INSERT, UPDATE, DELETE
  old_value TEXT,
  new_value TEXT,
  source TEXT,                    -- 'gateway', 'cli', 'agent', 'migration'
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX idx_audit_state_table ON audit_state(table_name, created_at);
```

### Retention / Cleanup (runs on gateway startup + daily schedule)

All retention logic runs from TypeScript (`src/infra/state-db/retention.ts`), not raw SQL, to avoid performance traps with correlated subqueries.

```typescript
// retention.ts — pseudocode for cleanup jobs

// Cron runs: keep last 500 per job
// Done per-job in a loop to avoid O(n²) correlated subquery
for (const { job_id } of db.prepare("SELECT DISTINCT job_id FROM cron_runs").all()) {
  db.prepare(
    `
    DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
      SELECT id FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 500
    )
  `,
  ).run(job_id, job_id);
}

// Subagent runs: delete finished runs older than 30 days
db.prepare(
  `
  DELETE FROM agent_subagent_runs
  WHERE status IN ('completed', 'failed', 'cancelled')
  AND finished_at < unixepoch() - (30 * 86400)
`,
).run();

// Team messages: keep last 2000 per team
for (const { team_id } of db.prepare("SELECT DISTINCT team_id FROM op1_team_messages").all()) {
  db.prepare(
    `
    DELETE FROM op1_team_messages WHERE team_id = ? AND id NOT IN (
      SELECT id FROM op1_team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT 2000
    )
  `,
  ).run(team_id, team_id);
}

// Exec approvals: clean up expired session-scoped approvals
db.prepare(
  `
  DELETE FROM security_exec_approvals
  WHERE scope = 'session' AND session_key IS NOT NULL
  AND session_key NOT IN (SELECT session_key FROM session_entries)
`,
).run();
```

```sql
-- Audit state: keep last 90 days
DELETE FROM audit_state WHERE created_at < unixepoch() - (90 * 86400);

-- Audit config: keep last 90 days
DELETE FROM audit_config WHERE created_at < unixepoch() - (90 * 86400);

-- Delivery queue: purge delivered/failed older than 7 days
DELETE FROM delivery_queue
  WHERE status IN ('delivered', 'failed')
  AND created_at < unixepoch() - (7 * 86400);

-- Periodic VACUUM to reclaim space (run weekly or on-demand)
-- VACUUM;
```

---

## Architecture Changes

### State DB Layer (Phase 0)

```
src/infra/state-db/
├── connection.ts               # NEW: Singleton DB connection, WAL setup, migrations
├── schema.ts                   # NEW: All CREATE TABLE statements + version tracking
├── retention.ts                # NEW: Scheduled cleanup (cron_runs, audit, delivery_queue)
├── integrity.ts                # NEW: PRAGMA integrity_check on startup, corruption fallback
├── migrate-json.ts             # NEW: One-shot JSON → SQLite migration per subsystem
└── index.ts                    # NEW: Exports getStateDb(), runMigrations()
```

### Session Store (Phase 1 — replaces JSON entirely)

```
src/config/sessions/
├── store.ts                    # REWRITTEN: SQLite implementation (replaces JSON)
├── store-migrate.ts            # NEW: One-shot JSON → SQLite migration (run once, then delete old files)
└── store.test.ts               # UPDATED: Tests target SQLite store
```

### Config Flow — After P0-P2 (sessions/state in SQLite)

```
agents/*.yaml (30+ YAML manifests)
        │
        ▼ agent-config-sync (unchanged)
openclaw.json + $include files (JSON5, unchanged)
        │
        ▼ io.ts pipeline (unchanged)
Runtime OpenClawConfig object
        │
        ▼
Gateway RPC → UI / CLI / Agents
        │
        ▼ (session_entries, delivery_queue, op1_team_*, agent_*, etc.)
operator1.db (SQLite — NEW)
```

### Config Flow — After P3 (everything in SQLite, end goal)

```
operator1.db
├── core_config table (raw JSON5 blob, $include content inlined at migration time)
│       │
│       ▼ io.ts pipeline (JSON5 → env vars → validate → defaults)
│   Runtime OpenClawConfig object
│
├── op1_agent_manifests table (replaces YAML manifests + config-sync engine)
│
├── session_entries, delivery_queue, op1_team_*, agent_auth_profiles, ...
│
└── audit_state, audit_config
        │
        ▼
Gateway RPC → UI / CLI / Agents
```

---

## Implementation Phases

### Phase 0: State DB Infrastructure + Safety CLI (2 days)

> **Safety-first:** The export/rollback CLI is built before any data migration, so every
> subsequent phase has a tested rollback path from day one.

- [ ] Create `src/infra/state-db/connection.ts` — singleton `DatabaseSync` (node:sqlite), WAL mode, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint=1000`
- [ ] Create `src/infra/state-db/schema.ts` — schema version tracking + all P0 table definitions (prefixed names)
- [ ] Create `src/infra/state-db/integrity.ts` — `PRAGMA integrity_check` on startup; if corrupt, log error, rename corrupt DB, create fresh empty DB
- [ ] Create `src/infra/state-db/retention.ts` — scheduled cleanup for cron_runs, audit tables, delivery_queue
- [ ] Create `src/infra/state-db/index.ts` — `getStateDb()` export, auto-create on first access
- [ ] DB location: `~/.openclaw/operator1.db`
- [ ] `openclaw state export --format json` — dump DB to JSON files (rollback safety net)
- [ ] `openclaw state info` — show DB location, size, table stats, integrity status
- [ ] Tests for DB creation, WAL mode, schema versioning, integrity check, export

### Phase 1: Sessions → SQLite (P0, 2-3 days)

- [ ] Rewrite `src/config/sessions/store.ts` — replace JSON file I/O with SQLite `session_entries` table
- [ ] Keep the same exported function signatures (`loadSessionStore`, `saveSessionStore`, `updateSessionStore`) but backed by SQLite
- [ ] Replace pruning/capping with `DELETE FROM session_entries WHERE updated_at < ?`
- [ ] Eliminate in-process lock queue (SQLite WAL handles read concurrency; see Technical Notes for write contention)
- [ ] Create `store-migrate.ts` — one-shot JSON → SQLite migration for existing session files
- [ ] All existing session tests pass

**Phase 1 cleanup:**

- [ ] Remove all JSON file read/write/lock logic from `store.ts` (no fallback to JSON)
- [ ] Delete `src/config/sessions/store-migrate.ts` after migration runs successfully (or keep as a CLI-only utility)
- [ ] Delete migrated `agents/{id}/sessions/sessions.json` files after successful migration
- [ ] Remove any file-lock utilities that were only used by the session store (check for other consumers first)

### Phase 2: Delivery Queue + Teams → SQLite (P0, 2-3 days)

- [ ] Rewrite `src/infra/outbound/delivery-queue.ts` — replace file-per-message with `delivery_queue` table
- [ ] Implement retry backoff using `next_attempt_at` column (poll: `WHERE status = 'pending' AND next_attempt_at <= unixepoch()`)
- [ ] Rewrite `src/teams/team-store.ts` — replace `teams.json` with normalized SQLite tables
- [ ] Normalize teams into `op1_team_registry` + `op1_team_members` + `op1_team_tasks` + `op1_team_messages` tables
- [ ] One-shot migration: read existing `delivery-queue/*.json` + `teams/teams.json` → insert into SQLite

**Phase 2 cleanup:**

- [ ] Remove all file-based delivery queue logic (file creation, scanning, cleanup, globbing)
- [ ] Remove `teams/teams.json` file I/O from `team-store.ts`
- [ ] Delete migrated `delivery-queue/*.json` files and `teams/teams.json` after successful migration
- [ ] Remove ephemeral delivery-queue file cleanup logic (retention.ts replaces it)

### Phase 3: Auth, Pairing, Thread Bindings → SQLite (P1, 2-3 days)

- [ ] Rewrite `src/agents/subagent-registry.store.ts` → `agent_subagent_runs` (SQLite)
- [ ] Rewrite `src/agents/auth-profiles/store.ts` → `agent_auth_profiles` (SQLite)
- [ ] Rewrite `src/pairing/pairing-store.ts` → `channel_pairing` table (SQLite)
- [ ] Rewrite allowlists → normalized `channel_allowlist_entries` table (one row per allowed sender)
- [ ] Rewrite `src/telegram/thread-bindings.ts` → `channel_thread_bindings` (SQLite)
- [ ] Rewrite `src/discord/monitor/thread-bindings.state.ts` → `channel_thread_bindings` (SQLite)
- [ ] One-shot migration: read existing JSON files → insert into SQLite tables
- [ ] Enable `audit_state` triggers for security-sensitive tables (`auth_credentials`, `agent_auth_profiles`, `channel_pairing`, `channel_allowlist_entries`, `security_exec_approvals`)

**Phase 3 cleanup:**

- [ ] Remove all JSON file I/O from each rewritten store module
- [ ] Delete migrated files: `subagents/runs.json`, `agents/{id}/agent/auth-profiles.json`, `credentials/*-pairing.json`, `credentials/*-allowFrom.json`, `telegram/thread-bindings-*.json`, `discord/thread-bindings.json`
- [ ] Remove file-lock/atomic-write helpers if no longer used by any remaining module

### Phase 4: Settings, Cron, Channel State, Workspace → SQLite (P2, 3-4 days)

- [ ] Rewrite `src/cron/store.ts` + `src/cron/run-log.ts` → `cron_jobs` + `cron_runs` (SQLite)
- [ ] Activate cron_runs retention (cap 500 per job) in `retention.ts`
- [ ] Rewrite `src/infra/voicewake.ts`, `src/tts/tts.ts` → `core_settings` table (SQLite)
- [ ] Rewrite `src/infra/device-identity.ts`, `src/infra/device-auth-store.ts` → `core_settings` (SQLite)
- [ ] Rewrite `src/telegram/update-offset-store.ts`, `src/telegram/sticker-cache.ts` → `channel_tg_state` (SQLite)
- [ ] Rewrite `src/discord/monitor/model-picker-preferences.ts` → `channel_dc_state` (SQLite)
- [ ] Rewrite `src/infra/restart-sentinel.ts`, `src/infra/update-startup.ts` → `core_settings` (SQLite)
- [ ] Rewrite `src/infra/push-apns.ts` → `core_settings` (SQLite)
- [ ] Rewrite `src/providers/github-copilot-token.ts` (with `expires_at`) → `auth_credentials` (SQLite)
- [ ] Rewrite `src/web/auth-store.ts`, `credentials/oauth.json` (with `expires_at`) → `auth_credentials` (SQLite)
- [ ] Rewrite `src/infra/exec-approvals.ts` → `security_exec_approvals` (SQLite, add to audit scope)
- [ ] Rewrite `src/channels/plugins/catalog.ts` → `plugin_catalog` (SQLite)
- [ ] Rewrite `src/agents/workspace.ts` workspace-state → `workspace_state` (SQLite)
- [ ] Rewrite `src/gateway/server-methods/clawhub.ts` catalog/previews/lock → `op1_clawhub_catalog` + `op1_clawhub_locks` (SQLite)
- [ ] Rewrite heartbeat-state → `op1_settings` (scope=`heartbeat`) (SQLite)
- [ ] Rewrite matrix-agents → `op1_settings` (scope=`matrix_agents`, temporary) (SQLite)
- [ ] One-shot migration: read all existing JSON files for this phase → insert into SQLite

**Phase 4 cleanup:**

- [ ] Remove all JSON file I/O from every rewritten module above
- [ ] Delete migrated files: `cron/jobs.json`, `cron/runs/*.jsonl`, `settings/voicewake.json`, `settings/tts.json`, `identity/device.json`, `identity/device-auth.json`, `telegram/update-offset-*.json`, `telegram/sticker-cache.json`, `discord/model-picker-preferences.json`, `restart-sentinel.json`, `update-check.json`, `node.json`, `push/apns-registrations.json`, `credentials/oauth.json`, `credentials/github-copilot.token.json`, `exec-approvals.json`, `mpm/catalog.json`, `plugins/catalog.json`, `{workspace}/.openclaw/workspace-state.json`, `{workspace}/.openclaw/clawhub/catalog.json`, `{workspace}/.openclaw/clawhub/clawhub.lock.json`, `{workspace}/.openclaw/clawhub/previews/*.json`, `{workspace}/memory/heartbeat-state.json`, `matrix-agents.json`
- [ ] Remove file-based helpers (`json-file.ts` read/write functions, etc.) if no remaining consumers

### Phase 5: Agent Manifests → SQLite (P3, 2-3 days)

- [ ] Import 30+ `agents/*/agent.yaml` into `op1_agent_manifests` table (one-shot migration)
- [ ] Migrate matrix-agents from `op1_settings(scope=matrix_agents)` blob into `op1_agent_manifests` table (proper rows)
- [ ] Agent CRUD now goes directly through SQLite, no YAML round-trip
- [ ] UI agent management reads/writes DB directly via gateway RPC

**Phase 5 cleanup:**

- [ ] Delete `src/config/agent-config-sync.ts` (no more YAML ↔ JSON drift detection)
- [ ] Delete `src/config/agent-manifest-validation.ts` (validation moves to SQLite insert path)
- [ ] Delete `src/config/agent-registry-sync.ts` (no more registry sync)
- [ ] Delete `src/config/agent-workspace-deploy.ts` (workspace deploy reads from DB)
- [ ] Delete `agents/*/agent.yaml` manifest files (38 files) — data now lives in `op1_agent_manifests` table
- [ ] Remove `op1_settings(scope=matrix_agents)` blob row (data migrated to proper table)
- [ ] Remove YAML parsing dependencies if no longer used elsewhere (`js-yaml`, etc.)

### Phase 6: Config → SQLite (P3, 2-3 days)

> **Prerequisite decision (must be resolved before Phase 6 starts):**
> `$include` directives must be resolved. Two options:
>
> - **Option A (recommended):** Inline all `$include` content into the config blob at migration time. The DB stores the fully-resolved JSON5. No more file-based includes.
> - **Option B:** Keep `$include` as file references. The DB stores the root JSON5 with `$include` directives intact, and `io.ts` still reads include files from disk. This breaks the "single file" end goal.
>
> Decision must be made and documented here before Phase 6 begins.

- [ ] Resolve `$include` strategy (Option A or B above)
- [ ] Store config in `core_config` table with `scope = 'main'`
- [ ] Rewrite `io.ts` read path: `db.prepare("SELECT body FROM core_config WHERE scope = ?").get('main')` instead of `fs.readFileSync()`
- [ ] Rewrite `io.ts` write path: `db.prepare("UPDATE core_config SET body = ?, hash = ? WHERE scope = ?").run()` instead of atomic file write
- [ ] All processing pipeline (env vars, validation, defaults) stays identical
- [ ] Config audit moves from `config-audit.jsonl` to `audit_config` table

**Phase 6 cleanup:**

- [ ] Delete `openclaw.json` (data now in `core_config` table)
- [ ] Delete all `$include` target files (content inlined into DB at migration time, assuming Option A)
- [ ] Delete `src/config/includes.ts` (no more file-based includes)
- [ ] Remove `fs.readFileSync`/`fs.writeFileSync` config paths from `io.ts`
- [ ] Delete `logs/config-audit.jsonl` (audit now in `audit_config` table)

### Phase 7: Final Validation + Dead Code Sweep (1-2 days)

- [ ] Gateway RPC methods work unchanged across old UI, new UI, CLI
- [ ] Concurrent access stress test (gateway + CLI + multiple agents)
- [ ] Retention cleanup runs on schedule without issues
- [ ] Full test suite passes

**Final cleanup sweep:**

- [ ] Grep for any remaining `fs.readFileSync`/`fs.writeFileSync`/`fs.existsSync` calls that reference old JSON state files — remove them
- [ ] Grep for any remaining references to deleted JSON file paths (e.g., `sessions.json`, `teams.json`, `runs.json`) — remove them
- [ ] Remove unused imports, dead helper functions, and orphaned utility modules
- [ ] Verify `~/.openclaw/` directory is clean: only `operator1.db`, `operator1.db-wal`, `operator1.db-shm`, session JSONL files, and `mcp/servers.yaml` remain
- [ ] Update `openclaw doctor` to check DB health instead of JSON file presence

**Total: ~18-24 days across all phases**

---

## Technical Notes

### SQLite Engine

**Use `node:sqlite` (Node 22+ built-in DatabaseSync API)** — already proven in this codebase at `src/memory/manager.ts`. No `better-sqlite3` dependency needed.

### WAL Mode and Concurrency

Enable WAL (Write-Ahead Logging) for concurrent reads + writes from gateway, CLI, and agents simultaneously.

**Multi-process write contention:** `node:sqlite` `DatabaseSync` is synchronous/blocking. WAL allows concurrent readers, but **concurrent writers serialize** — only one process can write at a time. `PRAGMA busy_timeout = 5000` ensures waiting writers retry for up to 5 seconds before returning `SQLITE_BUSY` (without this, concurrent writes fail immediately). This is acceptable because:

- Most writes are fast (single-row UPDATE/INSERT)
- The current JSON approach has the same single-writer constraint (file locks)
- WAL is still a net improvement over file-lock contention

If multi-process write throughput becomes a bottleneck (unlikely for this workload), the mitigation is to route all writes through the gateway process and have CLI/agents send write requests via RPC.

Connection pragmas set in `connection.ts`:

- `PRAGMA wal_autocheckpoint = 1000` — checkpoint after 1000 pages (tunable for high-frequency session writes)
- `PRAGMA synchronous = NORMAL` — safe in WAL mode, significantly faster than default `FULL`
- `PRAGMA busy_timeout = 5000` — wait up to 5s for write lock before failing

### Config Blob Strategy (Phase 6)

The `core_config` table stores the **raw JSON5 string** as a single blob with a named `scope` key (not a `CHECK id = 1` singleton). The `scope` key defaults to `'main'` but is extensible to future use cases (config snapshots, multi-environment, etc.).

The entire `io.ts` processing pipeline (JSON5 parse → env var substitution → validation → defaults → runtime overrides) runs unchanged on the blob. This means:

- No normalized config tables (no upstream merge pain from schema drift)
- Env var references like `${OPENAI_API_KEY}` work exactly as before
- Snapshot hashing for conflict detection works the same way
- `$include` content is inlined at migration time (recommended Option A)

### Startup Integrity Check

On gateway startup, run `PRAGMA integrity_check` (quick mode) against `operator1.db`. If corruption is detected:

1. Log an error with details
2. Rename corrupt DB to `operator1.db.corrupt.{timestamp}`
3. Create a fresh empty DB and run migrations (starts with empty state — user must restore from `openclaw state export` backup if needed)
4. Surface the issue in `openclaw doctor` output

> **No JSON fallback.** Since old JSON files are deleted after each phase, there is no file-based
> backend to fall back to. The recovery path is: restore from a prior `openclaw state export` dump,
> or start fresh. This is acceptable because SQLite corruption is extremely rare in practice.

### Audit Table Scope

`audit_state` is scoped to **security-sensitive tables only**: `auth_credentials`, `agent_auth_profiles`, `channel_pairing`, `channel_allowlist_entries`, `security_exec_approvals`, and `core_config`. High-frequency tables (`session_entries`, `delivery_queue`, `cron_runs`, `op1_team_messages`) are excluded to avoid unbounded growth and noise. If per-session audit is needed, use the existing session transcript JSONL files.

### Migration Atomicity

Each subsystem migration (JSON → SQLite) must be atomic per-subsystem:

1. Read all JSON source files for the subsystem
2. Begin SQLite transaction
3. Insert all rows
4. Commit transaction
5. Only after successful commit: **delete** source JSON files

If step 4 fails, the migration aborts and the JSON files remain. The developer should fix the issue and re-run. There is no dual-mode operation — once a phase is complete, the JSON files are gone and only SQLite is used.

> **Pre-migration safety:** Before running any phase's migration, the developer should run
> `openclaw state export` to create a JSON backup. This is manual and intentional — no automatic
> dual-write or shadow-read complexity.

### Session Transcript JSONL Files

Session transcript files (`agents/{id}/sessions/{sessionId}.jsonl`) **stay as files permanently**. They are append-only sequential logs — the optimal format for this access pattern. SQLite adds overhead for append-only writes with no query benefit.

---

## Recovery Plan

> **No backward compatibility.** There is no JSON fallback. Each phase is a hard cutover.

Recovery options if something goes wrong:

1. **Pre-migration backup:** Before each phase, run `openclaw state export` to dump current DB to JSON files. This is the developer's responsibility before running migration code.
2. **Git revert:** Each phase is committed and pushed independently. If a phase causes issues, `git revert` the phase commit and restore data from the pre-migration export.
3. **Corruption recovery:** Startup integrity check detects corruption → renames corrupt DB → creates fresh empty DB. Restore data from last `openclaw state export` backup.
4. **Export CLI available from Phase 0** — the recovery tool is built before any data migration begins.

---

## Open Questions

1. **DB location:** `~/.openclaw/operator1.db` (proposed) — confirmed?
2. **Encryption at rest:** Should `agent_auth_profiles.credentials_json` be encrypted? (Future consideration)
3. **`$include` resolution (P3 blocker):** Option A (inline at migration) vs Option B (keep file refs) — must decide before Phase 6
4. **Session transcript consolidation:** Keep JSONL files (recommended) or move into SQLite too?
5. **Retention tuning:** cron_runs cap 500/job, agent_subagent_runs 30 days, op1_team_messages 2000/team, audit 90 days, delivery_queue 7 days — confirm defaults
6. **Backup strategy:** On-demand via `openclaw state export` only (no scheduled `.backup` API — adds complexity without clear need; the export CLI already covers rollback and debugging)

---

## Success Criteria

- [ ] Single `operator1.db` file replaces 30+ scattered JSON files
- [ ] All tables use domain-prefixed names (core*, session*, op1*team*, agent*, channel*, etc.)
- [ ] All old JSON state files deleted (no dual-mode, no fallback)
- [ ] All gateway RPC methods work unchanged
- [ ] Old UI + new UI + CLI all function correctly
- [ ] No data loss during migration
- [ ] Concurrent access from gateway + CLI + agents works correctly
- [ ] Session pruning/capping works via SQL
- [ ] Allowlist checks are fast (normalized rows, no JSON deserialization on hot path)
- [ ] Team data is queryable (normalized tables, not JSON blobs)
- [ ] Delivery queue retries use backoff scheduling (next_attempt_at)
- [ ] Retention cleanup runs automatically (cron_runs, audit, delivery_queue)
- [ ] Integrity check detects corruption and falls back gracefully
- [ ] Agent management no longer requires YAML ↔ JSON sync (Phase 5+)
- [ ] Export to JSON available for debugging and rollback from day one

---

## References

### Source Files (Current — to be migrated)

| Category          | Key Files                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config IO         | `src/config/io.ts` (1400 LOC), `src/config/config.ts`                                                                                                    |
| Config includes   | `src/config/includes.ts`                                                                                                                                 |
| Agent sync        | `src/config/agent-config-sync.ts`, `agent-manifest-validation.ts`, `agent-registry-sync.ts`, `agent-workspace-deploy.ts`, `zod-schema.agent-manifest.ts` |
| Sessions          | `src/config/sessions/store.ts` (880 LOC)                                                                                                                 |
| Delivery queue    | `src/infra/outbound/delivery-queue.ts`                                                                                                                   |
| Teams             | `src/teams/team-store.ts`                                                                                                                                |
| Subagent registry | `src/agents/subagent-registry.store.ts`                                                                                                                  |
| Auth profiles     | `src/agents/auth-profiles/store.ts`                                                                                                                      |
| Pairing           | `src/pairing/pairing-store.ts`                                                                                                                           |
| Thread bindings   | `src/telegram/thread-bindings.ts`, `src/discord/monitor/thread-bindings.state.ts`                                                                        |
| Cron              | `src/cron/store.ts`, `src/cron/run-log.ts`                                                                                                               |
| Settings          | `src/infra/voicewake.ts`, `src/tts/tts.ts`                                                                                                               |
| Device            | `src/infra/device-identity.ts`, `src/infra/device-auth-store.ts`                                                                                         |
| Telegram          | `src/telegram/update-offset-store.ts`, `src/telegram/sticker-cache.ts`                                                                                   |
| Discord           | `src/discord/monitor/model-picker-preferences.ts`                                                                                                        |
| Gateway           | `src/infra/restart-sentinel.ts`, `src/infra/update-startup.ts`                                                                                           |
| Push              | `src/infra/push-apns.ts`                                                                                                                                 |
| Credentials       | `src/providers/github-copilot-token.ts`, `src/web/auth-store.ts`                                                                                         |
| Exec approvals    | `src/infra/exec-approvals.ts`                                                                                                                            |
| Plugin catalog    | `src/channels/plugins/catalog.ts`                                                                                                                        |
| Workspace state   | `src/agents/workspace.ts`                                                                                                                                |
| ClawHub           | `src/gateway/server-methods/clawhub.ts`                                                                                                                  |
| MCP (stays YAML)  | `src/mcp/scope.ts`, `src/gateway/server-methods/mcp.ts`                                                                                                  |
| Existing SQLite   | `src/memory/manager.ts` (node:sqlite DatabaseSync — reference implementation)                                                                            |

---

_Last updated: 2026-03-11_
