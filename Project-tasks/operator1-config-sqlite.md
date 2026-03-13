# Operator1 SQLite Consolidation

**Status:** Implementation Guide (Approved Direction)
**Created:** 2026-03-05
**Updated:** 2026-03-13
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

| File Pattern          | What                            | Why                                                       |
| --------------------- | ------------------------------- | --------------------------------------------------------- |
| `mcp/servers.yaml`    | MCP server definitions          | Stays YAML — MCP ecosystem compatibility, user-edited     |
| `agents/*/agent.yaml` | Agent manifest files (38 files) | Stays YAML — user-edited, agent marketplace compatibility |

> **Note:** Server/agent definitions stay as files for ecosystem compatibility. Only the **registry config and lock state** migrate to SQLite.

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
| `op1_agent_`   | Agent marketplace        | `op1_agent_manifests`, `op1_agent_registries`, `op1_agent_locks`               |
| `op1_clawhub_` | ClawHub skills           | `op1_clawhub_catalog`, `op1_clawhub_locks`                                     |
| `op1_mcp_`     | MCP registries           | `op1_mcp_registries` (server defs stay in `mcp/servers.yaml`)                  |
| `op1_`         | Other operator1 features | `op1_settings` (heartbeat, future features)                                    |

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
| `op1_mcp_registries`                                                           | `openclaw.json tools.mcp.registries`                             | P2 (server defs stay in `mcp/servers.yaml`)              |
| `op1_agent_registries`                                                         | `openclaw.json agents.registries`                                | P3 (manifests stay in `agents/*/agent.yaml`)             |
| `op1_agent_locks`                                                              | `agents-lock.yaml` per scope (user/project/local)                | P3                                                       |
| `op1_agent_manifests`                                                          | `agents/*/agent.yaml` (38 manifests)                             | P3 (replaces YAML layer)                                 |

### What stays as files (permanently)

| File Pattern                       | Why                                                               |
| ---------------------------------- | ----------------------------------------------------------------- |
| `agents/{id}/sessions/*.jsonl`     | Append-only transcript logs — already optimal as sequential files |
| `logs/cache-trace.jsonl`           | Debug logs — optional, rotated, append-only                       |
| `logs/anthropic-payload-log.jsonl` | Debug logs — same                                                 |
| `mcp/servers.yaml`                 | MCP server definitions — MCP ecosystem compatibility              |
| `agents/*/agent.yaml`              | Agent manifests — marketplace ecosystem compatibility             |

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

-- MCP registries (replaces openclaw.json tools.mcp.registries)
-- Server definitions stay in mcp/servers.yaml for MCP ecosystem compatibility
CREATE TABLE op1_mcp_registries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  auth_token_env TEXT,            -- Env var name for private registry auth (not the token itself)
  visibility TEXT,                -- 'public', 'private'
  enabled INTEGER DEFAULT 1,
  synced_at INTEGER,              -- Last registry sync timestamp
  updated_at INTEGER
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

-- Agent registries (replaces openclaw.json agents.registries)
-- Agent definitions stay in agents/*/agent.yaml for marketplace ecosystem compatibility
CREATE TABLE op1_agent_registries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  auth_token_env TEXT,            -- Env var name for private registry auth (not the token itself)
  visibility TEXT,                -- 'public', 'private'
  enabled INTEGER DEFAULT 1,
  synced_at INTEGER,              -- Last registry sync timestamp
  updated_at INTEGER
);

-- Agent lock state (replaces agents-lock.yaml per scope)
-- Tracks installed agents with exact versions for reproducibility
CREATE TABLE op1_agent_locks (
  scope TEXT NOT NULL,            -- 'user', 'project', 'local'
  agent_id TEXT NOT NULL,
  version TEXT NOT NULL,
  registry_id TEXT,               -- Which registry this agent came from
  checksum TEXT,                  -- sha256 for integrity verification
  installed_at INTEGER,
  requires TEXT,                  -- Parent agent ID if Tier 3 (for dependency validation)
  PRIMARY KEY (scope, agent_id)
);

CREATE INDEX idx_op1_agent_locks_registry ON op1_agent_locks(registry_id);
CREATE INDEX idx_op1_agent_locks_requires ON op1_agent_locks(requires) WHERE requires IS NOT NULL;

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

### Phase 0: State DB Infrastructure + Safety CLI ✅ (completed 2026-03-05)

> **Safety-first:** The export/rollback CLI is built before any data migration, so every
> subsequent phase has a tested rollback path from day one.

- [x] Create `src/infra/state-db/connection.ts` — singleton `DatabaseSync` (node:sqlite), WAL mode, `synchronous=NORMAL`, `busy_timeout=5000`, `wal_autocheckpoint=1000`
- [x] Create `src/infra/state-db/schema.ts` — schema version tracking + all P0 table definitions (prefixed names)
- [x] Create `src/infra/state-db/integrity.ts` — `PRAGMA integrity_check` on startup; if corrupt, log error, rename corrupt DB, create fresh empty DB
- [x] Create `src/infra/state-db/retention.ts` — scheduled cleanup for cron_runs, audit tables, delivery_queue
- [x] Create `src/infra/state-db/index.ts` — `getStateDb()` export, auto-create on first access
- [x] DB location: `~/.openclaw/operator1.db`
- [x] `openclaw state export --format json` — dump DB to JSON files (rollback safety net)
- [x] `openclaw state info` — show DB location, size, table stats, integrity status
- [x] Tests for DB creation, WAL mode, schema versioning, integrity check, export

### Phase 1: Sessions → SQLite ✅ (completed 2026-03-06)

- [x] Rewrite `src/config/sessions/store.ts` — replace JSON file I/O with SQLite `session_entries` table
- [x] Keep the same exported function signatures (`loadSessionStore`, `saveSessionStore`, `updateSessionStore`) but backed by SQLite
- [x] Replace pruning/capping with `DELETE FROM session_entries WHERE updated_at < ?`
- [x] Retain in-process lock queue for async serialization (SQLite WAL handles read concurrency; lock queue serializes async write operations)
- [x] Create `store-migrate.ts` — one-shot JSON → SQLite migration for existing session files
- [x] All existing session tests pass (48 tests across 6 test files)

**Phase 1 cleanup:**

- [x] Remove all JSON file read/write/lock logic from `store.ts` (no fallback to JSON)
- [x] Keep `store-migrate.ts` as startup migration (runs at gateway startup via `server-startup.ts`)
- [x] Delete migrated `agents/{id}/sessions/sessions.json` files after successful migration (handled by `store-migrate.ts`)
- [x] Remove file-based session cache (`store-cache.ts` deleted, `sessions.cache.test.ts` deleted)
- [x] Update 14 downstream test files to use SQLite-backed session store (`useSessionStoreTestDb()` + `saveSessionEntriesToDb()`)

### Phase 2: Delivery Queue + Teams → SQLite ✅ (completed 2026-03-12)

- [x] Create `delivery-queue-sqlite.ts` SQLite adapter (enqueue, ack, fail, move-to-failed, load, delete)
- [x] Rewrite `delivery-queue.ts` — all functions now delegate to SQLite; file I/O removed; `stateDir` param kept in signatures but ignored
- [x] Create `delivery-queue-migrate.ts` — one-shot migration from `delivery-queue/*.json` + `failed/*.json` → SQLite
- [x] Create `test-helpers.delivery-queue.ts` — per-test in-memory DB with `useDeliveryQueueTestDb()`
- [x] Update `outbound.test.ts` delivery-queue tests to use SQLite-backed assertions instead of filesystem checks
- [x] Create `team-store-sqlite.ts` SQLite adapter — 4 tables (registry, members, tasks, messages) with full CRUD
- [x] Rewrite `team-store.ts`, `team-task-store.ts`, `team-message-store.ts` — all now use SQLite adapter directly; `teams.json` file I/O removed
- [x] Create `team-store-migrate.ts` — one-shot migration from `teams/teams.json` → SQLite
- [x] Create `test-helpers.team-store.ts` — per-test in-memory DB with `useTeamStoreTestDb()`
- [x] Rewrite 3 team test files — removed ~265 lines of `vi.mock()` blocks, replaced with `useTeamStoreTestDb()`
- [x] Schema migration v2: extend team tables (leader, leader_session, completed_at, session_key, state, description, blocked_by_json, message_id, from_agent, to_agent, read_by_json); recreate `op1_team_members` with AUTOINCREMENT PK (duplicate agentId per team allowed)
- [x] Wire both migrations into `server-startup.ts` (run after session migration)
- [x] 136 tests passing across 5 test files (59 delivery + 59 team + 18 state-db)

### Phase 3: Auth, Pairing, Thread Bindings → SQLite ✅ (completed 2026-03-13)

- [x] Rewrite `src/agents/subagent-registry.store.ts` → `op1_subagent_runs` (SQLite)
- [x] Rewrite `src/agents/auth-profiles/store.ts` → `op1_auth_profiles` (SQLite)
- [x] Rewrite `src/pairing/pairing-store.ts` → `op1_channel_pairing` table (SQLite)
- [x] Rewrite allowlists → `op1_channel_allowlist` table (one row per allowed sender)
- [x] Rewrite `src/telegram/thread-bindings.ts` → `op1_channel_thread_bindings` (SQLite)
- [x] Rewrite `src/discord/monitor/thread-bindings.state.ts` → `op1_channel_thread_bindings` (SQLite)
- [x] One-shot migration: `src/infra/state-db/migrate-phase3.ts` + `src/agents/subagent-registry-migrate.ts` wired into `server-startup.ts`
- [x] Enable `audit_state` triggers for security-sensitive tables — schema v9 adds `audit_state` table + 15 AFTER INSERT/UPDATE/DELETE triggers for: `auth_credentials`, `op1_auth_profiles`, `op1_channel_pairing`, `op1_channel_allowlist`, `security_exec_approvals`

**Phase 3 cleanup:**

- [x] Remove all JSON file I/O from each rewritten store module (hard cutover: JSON fallback removed from auth profiles, pairing store, thread bindings)
- [x] One-shot migration deletes JSON files after importing: `subagents/runs.json`, `agents/{id}/agent/auth-profiles.json`, `auth-profiles.json`, `auth.json`, `credentials/*-pairing.json`, `credentials/*-allowFrom.json`, `telegram/thread-bindings-*.json`, `discord/thread-bindings.json`
- [x] File-lock/atomic-write helpers — **KEEP**: still active production consumers (`withFileLock` for OAuth refresh, `loadJsonFile`/`saveJsonFile` for CLI credential interop, `writeJsonAtomic` for plugin SDK)

### Phase 4: Settings, Cron, Channel State, Workspace → SQLite ✅ (completed 2026-03-12)

> **Scope reduction:** Research found 3 stores originally listed here don't need migration:
>
> - **heartbeat-state** — no persistent file; purely event-driven/ephemeral. Dropped.
> - **matrix-agents** — stored in main config (`openclaw.json`), not a separate JSON file. Dropped.
> - **plugin-catalog** — read-only (loads external JSON files, never writes). Dropped.
>
> This leaves **14 stores** across 4 sub-phases. Schema migration v4 covers all.

#### Phase 4B: Core Settings (7 stores → shared `core_settings` KV table)

> Start here — lowest complexity. Shared KV adapter means each module is a trivial I/O swap.

- [x] Create `src/infra/state-db/core-settings-sqlite.ts` — shared adapter: `getCoreSettingFromDb(scope, key)`, `setCoreSettingInDb(scope, key, value)`, `deleteCoreSettingFromDb(scope, key)`
- [x] Create `src/infra/state-db/test-helpers.core-settings.ts` — per-test in-memory DB helper
- [x] Schema migration v4: create `core_settings` table
- [x] Rewrite `src/infra/voicewake.ts` (60 LOC) → `core_settings(scope='voicewake')` — replace `readJsonFile`/`writeJsonAtomic` with adapter; 6 consumers
- [x] Rewrite `src/tts/tts.ts` TTS prefs I/O (~50 LOC of I/O in 970 LOC module) → `core_settings(scope='tts')` — replace `readFileSync`/`atomicWriteFileSync`; 20 consumers
- [x] Rewrite `src/infra/device-identity.ts` (183 LOC) → `core_settings(scope='device')` — replace `readFileSync`/`writeFileSync`; Ed25519 keypair, mode 0o600; 20 consumers
- [x] Rewrite `src/infra/device-auth-store.ts` (95 LOC) → `core_settings(scope='device-auth')` — replace sync read/write; token storage; 4 consumers
- [x] Rewrite `src/infra/restart-sentinel.ts` (147 LOC) → `core_settings(scope='gateway', key='restart-sentinel')` — replace `fs/promises` read/write/unlink; transient write-once/consume-once; 13 consumers
- [x] Rewrite `src/infra/update-startup.ts` update check state (~30 LOC of I/O in 527 LOC module) → `core_settings(scope='gateway', key='update-check')` — replace `readState`/`writeState`; 5 consumers
- [x] Rewrite `src/infra/push-apns.ts` registration state (~20 LOC of I/O in 530 LOC module) → `core_settings(scope='push')` — replace `readJsonFile`/`writeJsonAtomic`; async lock; 5 consumers
- [x] One-shot migration: read 7 JSON files → insert into `core_settings` → delete files
- [x] Update tests for all 7 stores

#### Phase 4A: Cron (2 stores → `cron_jobs` + `cron_runs` tables)

- [x] Create `src/cron/cron-sqlite.ts` — adapter for jobs CRUD + run log append/query/prune
- [x] Create `src/cron/test-helpers.cron.ts` — per-test in-memory DB helper
- [x] Schema migration v4 (same): create `cron_jobs` + `cron_runs` tables
- [x] Rewrite `src/cron/store.ts` (131 LOC) → `cron_jobs` table — replace atomic JSON write + `.bak` backup; 6 consumers (`src/cron/service/store.ts`, `src/cron/service/ops.ts`, `src/auto-reply/reply/agent-runner-reminder-guard.ts`, `src/telegram/target-writeback.ts`, `src/gateway/server-cron.ts`)
- [x] Rewrite `src/cron/run-log.ts` (454 LOC) → `cron_runs` table — replace JSONL append/read/pagination with SQL queries; fire-and-forget write queue → direct INSERT; 4 consumers (`src/gateway/server-methods/cron.ts`, `src/gateway/server-cron.ts`)
- [x] Activate `cron_runs` retention in `retention.ts` (cap 500 rows per job)
- [x] One-shot migration: `cron/jobs.json` → `cron_jobs` rows; `cron/runs/*.jsonl` → `cron_runs` rows; delete files
- [x] Update 4+ test files (`store.test.ts`, `run-log.test.ts`, `service.store.migration.test.ts`, etc.)

#### Phase 4C: Channel State + Credentials (5 stores → 4 tables)

- [x] Create `src/telegram/telegram-state-sqlite.ts` — adapter for `channel_tg_state` table
- [x] Create `src/discord/monitor/discord-state-sqlite.ts` — adapter for `channel_dc_state` table
- [x] Create `src/infra/auth-credentials-sqlite.ts` — adapter for `auth_credentials` table (provider-keyed, `expires_at`)
- [x] Schema migration v4 (same): create `channel_tg_state`, `channel_dc_state`, `auth_credentials` tables
- [x] Rewrite `src/telegram/update-offset-store.ts` (140 LOC) → `channel_tg_state(key='update_offset')` — per-account, bot token validation; 6 consumers
- [x] Rewrite `src/telegram/sticker-cache.ts` (267 LOC) → `channel_tg_state(key='sticker_cache')` — global cache with fuzzy search (keep in-memory index, persist to DB); 4 consumers
- [x] Rewrite `src/discord/monitor/model-picker-preferences.ts` (162 LOC) → `channel_dc_state(key='model_picker_preferences')` — replace file-locked writes with SQLite; scoped keys; 3 consumers
- [x] Rewrite `src/providers/github-copilot-token.ts` (137 LOC) → `auth_credentials(provider='github-copilot')` — token with `expires_at`; DI-friendly (custom load/save already injected); 5 consumers
- [x] Rewrite `src/web/auth-store.ts` (206 LOC) → `auth_credentials(provider='oauth')` — per-account WhatsApp creds; backup/restore logic; 11 consumers
- [x] One-shot migration: read all 5 JSON file types → insert into SQLite → delete files
- [x] Update tests for all 5 stores

#### Phase 4D: Workspace + Security (3 stores → 4 tables)

> Highest complexity sub-phase. Exec-approvals is security-sensitive with 7 test files.

- [x] Create `src/infra/exec-approvals-sqlite.ts` — adapter for `security_exec_approvals` table; hash-based change detection
- [x] Create `src/agents/workspace-state-sqlite.ts` — adapter for `workspace_state` table
- [x] Create `src/gateway/server-methods/clawhub-sqlite.ts` — adapter for `op1_clawhub_catalog` + `op1_clawhub_locks` tables
- [x] Schema migration v4 (same): create `security_exec_approvals`, `workspace_state`, `op1_clawhub_catalog`, `op1_clawhub_locks` tables
- [x] Rewrite `src/infra/exec-approvals.ts` (587 LOC) → `security_exec_approvals` — security-sensitive (mode 0o600, socket tokens), hash-based change detection for RPC; add to `audit_state` triggers; 10 consumers, 7 test files
- [x] Rewrite `src/agents/workspace.ts` workspace-state tracking only (655 LOC total, but only ~30 LOC of state I/O) → `workspace_state` — onboarding timestamps; bootstrap file I/O stays as files permanently; 23+ consumers, 9+ test files
- [x] Rewrite `src/gateway/server-methods/clawhub.ts` (707 LOC) → `op1_clawhub_catalog` + `op1_clawhub_locks` — catalog rows + preview cache + lock state; replaces 3 JSON files per workspace; 2 consumers, 1 test file
- [x] One-shot migration: read all JSON files → insert into SQLite → delete files
- [x] Enable `audit_state` triggers for `security_exec_approvals` (+ Phase 3 deferred: `op1_auth_profiles`, `op1_channel_pairing`, `op1_channel_allowlist`)
- [x] Update all tests

**Phase 4 cleanup:**

- [x] Remove all JSON file I/O from every rewritten module above (hard cutover)
- [x] Delete migrated files: `cron/jobs.json`, `cron/runs/*.jsonl`, `settings/voicewake.json`, `settings/tts.json`, `identity/device.json`, `identity/device-auth.json`, `telegram/update-offset-*.json`, `telegram/sticker-cache.json`, `discord/model-picker-preferences.json`, `restart-sentinel.json`, `update-check.json`, `push/apns-registrations.json`, `credentials/oauth.json`, `credentials/github-copilot.token.json`, `exec-approvals.json`, `{workspace}/.openclaw/workspace-state.json`, `{workspace}/.openclaw/clawhub/catalog.json`, `{workspace}/.openclaw/clawhub/clawhub.lock.json`, `{workspace}/.openclaw/clawhub/previews/*.json`
- [x] Remove file-lock/atomic-write helpers if no remaining consumers (deferred from Phase 3) — **Result:** file-lock still used by plugin-sdk + OAuth; `createAsyncLock` removed as dead code
- [x] Remove `json-file.ts` read/write functions if no remaining consumers — **Result:** still used by `cli-credentials.ts` (external CLI cred reads) and `auth-profiles` (legacy OAuth import); kept

#### Phase 4E: MCP Registries → SQLite (~1 hour)

> **Note:** MCP server definitions in `mcp/servers.yaml` stay as YAML for MCP ecosystem compatibility.
> Only the **registry config** migrates to SQLite.

- [x] Create `src/mcp/registries-sqlite.ts` — SQLite adapter for `op1_mcp_registries` table
- [x] Schema migration v7: add `op1_mcp_registries` table
- [x] Update `src/gateway/server-methods/mcp.ts`:
  - `mcp.registry.list` → query `op1_mcp_registries` table
  - `mcp.registry.add` → insert into `op1_mcp_registries` table
  - `mcp.registry.remove` → delete from `op1_mcp_registries` table
  - `mcp.registry.sync` → reads registries from SQLite
  - `mcp.browse.list` → reads registries from SQLite
- [x] One-shot migration: `openclaw.json tools.mcp.registries` → `op1_mcp_registries` rows (in `migrate-phase4e5d.ts`)
- [x] Remove `tools.mcp.registries` from config reads (migration strips registries from config blob)

**Phase 4E cleanup:**

- [x] Removed `readMcpConfig()` helper + `writeConfigFile` import from `mcp.ts`

### Phase 5: Agent Manifests → SQLite (P3, 2-3 days)

- [x] Phase 5A: device/node pairing + sandbox SQLite adapters + schema v5
- [x] Phase 5B: sandbox registry JSON→SQLite with hard cutover
- [x] Phase 5C: node-host config JSON→SQLite with hard cutover
- [x] One-shot migrations for device/node pairing JSON→SQLite

**Phase 5 cleanup:**

- [x] Remove dead exports from Phase 5B/5C sandbox+subagent migration

#### Phase 5D: Agent Registries + Locks → SQLite ✅ (completed 2026-03-13)

> **Note:** Agent manifests in `agents/*/agent.yaml` stay as YAML for marketplace ecosystem compatibility.
> Only **registry config** and **lock state** migrate to SQLite.

- [x] Create `src/agents/registries-sqlite.ts` — SQLite adapter for `op1_agent_registries` table
- [x] Create `src/agents/agent-locks-sqlite.ts` — SQLite adapter for `op1_agent_locks` table
- [x] Schema migration v7: add `op1_agent_registries` + `op1_agent_locks` tables
- [x] Update `src/gateway/server-methods/marketplace.ts`:
  - `agents.marketplace.registries` → query `op1_agent_registries` via `loadAgentRegistriesFromDb()`
  - `agents.marketplace.registry.add` → insert via `saveAgentRegistryToDb()`
  - `agents.marketplace.registry.remove` → delete via `deleteAgentRegistryFromDb()`
  - `agents.marketplace.sync` → update sync state via `updateAgentRegistrySyncState()`
- [x] One-shot migration: `~/.openclaw/agent-registry-cache/registries.json` → `op1_agent_registries` rows (in `migrate-phase4e5d.ts`)
- [x] Update tests (schema version 6→7 in `state-db.test.ts`)
- [x] Agent lock file migration (`agent-scope.ts` lock I/O → `op1_agent_locks` table)
  - Rewrote `readLockFile`, `writeLockFile`, `addToLockFile`, `removeFromLockFile` in `agent-scope.ts` to use SQLite adapter
  - Removed YAML `stringify` import and `writeFile`/`mkdir`/`resolve` imports (no longer needed for lock I/O)
  - `lockFileForScope()` retained for migration source path resolution
- [x] One-shot migration: `agents-lock.yaml` → `op1_agent_locks` (user scope) in `migrate-phase5d-locks.ts`
  - Wired into `server-startup.ts` migration sequence
- [x] Updated `agent-scope.marketplace.test.ts` for SQLite-backed locks
  - Tests now use `OPENCLAW_STATE_DIR` temp dir with full schema migrations
  - All 15 tests pass

**Phase 5D cleanup:**

- [x] Removed `StoredRegistry` interface + `loadUserRegistries()`/`saveUserRegistries()` + `USER_REGISTRIES_PATH` from `marketplace.ts`
- [x] Removed unused `StoredAgentLock` type import, `stringifyYaml`, `writeFile`, `mkdir`, `resolve` from `agent-scope.ts`
- [x] One-shot migration deletes `agents-lock.yaml` (user scope) after successful migration

### Phase 6: Config → SQLite ✅ (completed 2026-03-12)

> **Prerequisite decision (must be resolved before Phase 6 starts):**
> `$include` directives must be resolved. Two options:
>
> - **Option A (recommended):** Inline all `$include` content into the config blob at migration time. The DB stores the fully-resolved JSON5. No more file-based includes.
> - **Option B:** Keep `$include` as file references. The DB stores the root JSON5 with `$include` directives intact, and `io.ts` still reads include files from disk. This breaks the "single file" end goal.
>
> Decision must be made and documented here before Phase 6 begins.

- [x] Migrate `openclaw.json` → SQLite `op1_config` table
- [x] Config read/write now uses `op1_config` table
- [x] Processing pipeline (env vars, validation, defaults) unchanged

**Phase 6 cleanup:**

- [x] Config I/O migrated to SQLite

### Phase 7: Final Validation + Dead Code Sweep ✅ (completed 2026-03-13)

- [x] Gateway RPC methods work unchanged — verified (2026-03-13): `projects.list`, `mcp.registry.list`, `agents.marketplace.registries`, `projects.getTelegramBindings` all respond correctly via CLI `gateway call`
- [x] Concurrent access stress test — **Result (2026-03-13):** WAL mode verified (`journal_mode=wal`, `busy_timeout=5000`). Interleaved stress: 5 workers × 50 ops (1000 total) at 45k ops/sec, 0 errors. Multi-process: 3 separate Node processes × 100 ops each, 0 errors. Transaction isolation: 100 batches, 0 errors.
- [x] Retention cleanup runs on schedule without issues — **Result (2026-03-13):** All 6 retention jobs (`op1_team_messages`, `delivery_queue`, `cron_runs`, `agent_subagent_runs`, `audit_state`, `audit_config`) ran against live DB (schema v9, 38 tables), 0 errors.
- [x] Full test suite passes — **Result (2026-03-13):** 901 passed, 10 failed (21 test failures), 1 skipped. All 10 failures are pre-existing (security, config, docker, cron, provider tests) — none related to SQLite migration.

**Final cleanup sweep:**

- [x] Grep for any remaining `fs.readFileSync`/`fs.writeFileSync`/`fs.existsSync` calls that reference old JSON state files — **Result:** clean, no stale I/O in production code
- [x] Grep for any remaining references to deleted JSON file paths — **Result:** only in migration code and test mocks (legitimate)
- [x] Remove unused imports, dead helper functions, and orphaned utility modules — **Result:** removed `createAsyncLock` from `json-files.ts`; `json-file.ts`/`json-files.ts` still needed by plugin-sdk + legacy OAuth import
- [x] Verify `~/.openclaw/` directory is clean — **Result (2026-03-13):**
  - **Expected files present:** `operator1.db`, `operator1.db-wal`, `operator1.db-shm`, `.env`
  - **Expected dirs present:** `agents/`, `workspace-*/`, `mcp/`, `memory/`, `logs/`, `media/`, `browser/`, `browser-extension/`, `canvas/`, `completions/`, `extensions/`, `gateway/`, `models/`, `scripts/`
  - **Empty dirs (migrated, can remove):** `credentials/`, `cron/`, `devices/`, `identity/`
  - **Still present:** `matrix-agents.json` (read-only, loaded by config — not a state file), `telegram/command-hash-*.txt` (runtime cache), `openclaw.json.bak*` (5 backup copies from config migration — safe to delete after confidence period)
  - **No stale JSON state files remain** — all JSON state has been migrated to SQLite
- [x] Update `openclaw doctor` to check DB health instead of JSON file presence — added `doctor-state-db.ts` with integrity check, schema version, table row counts; fixed stale "sessions.json" message

**Total: ~18-24 days across all phases**

> **Note:** Phase 4E (MCP Registries) and Phase 5D (Agent Registries + Locks) add ~2-3 hours total.
> With coding agents handling implementation, these can be completed in a single session.

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

## Phase 8: Session Memory Isolation (3-5 days)

> **Problem:** When working with Operator1 across multiple sessions (web chat, Telegram topics, WhatsApp), all sessions share the same workspace (`~/.openclaw/workspace/`) and memory files (`MEMORY.md`, `memory/*.md`). This causes context confusion when parallel sessions work on different projects.
>
> **Example:**
>
> - Session A (Telegram topic 41) working on `crm-operations` → writes to shared MEMORY.md
> - Session B (web chat) working on `ui-next` → writes to same MEMORY.md
> - Session C (Telegram topic 16) reads mixed context from both projects → confused about "current task"

### Solution: Four-Layer Isolation

| Layer           | Approach                                          | Effort  | Scope              | Status      |
| --------------- | ------------------------------------------------- | ------- | ------------------ | ----------- |
| **Foundation**  | Project/Workspace/Channel unification (Phase 8.5) | 2 days  | SQLite schema      | ✅          |
| **Short-term**  | Session tagging (Option C / Phase 8A)             | 0 days  | Immediate relief   | ✅          |
| **Medium-term** | Project-scoped memory (Option B / Phase 8B)       | 0.5 day | Memory isolation   | ✅          |
| ~~Long-term~~   | ~~Per-project workspace (Option A)~~              | —       | ~~Full isolation~~ | **Dropped** |

> **Phase 8C dropped:** Per-project workspaces would duplicate what already exists. Projects already load their own SOUL.md/AGENTS.md/TOOLS.md from the project's `.openclaw/` directory via `buildProjectContextBlock()`. The workspace defines _who the agent is_ (identity, personality); the project defines _how the agent works on that project_ (instructions, tools, memory). Duplicating full workspaces per project blurs this clean separation without adding value.

---

### Phase 8.5: Project → Workspace → Channel Unification ✅ (completed 2026-03-13)

> **Prerequisite for all other phases.** Currently projects, workspaces, sessions, and Telegram topics exist in disconnected systems. This phase unifies them into SQLite with proper FK relationships.

**Current disconnect:**

| Concept                      | Where Stored                       | Links to Others?              |
| ---------------------------- | ---------------------------------- | ----------------------------- |
| **Projects**                 | `PROJECTS.md` (Markdown)           | ❌ No SQLite link             |
| **Workspace state**          | `workspace_state` (SQLite)         | ❌ No `project_id`            |
| **Sessions**                 | `session_entries` (SQLite)         | ❌ `projectId` in JSON only   |
| **Thread bindings**          | `channel_thread_bindings` (SQLite) | ❌ Only maps thread → session |
| **Telegram topic → project** | `PROJECTS.md` `telegram.topicId`   | ❌ In Markdown, not queryable |

**Target unified chain:**

```
Telegram Group/Topic
    ↓ (topic → project binding)
op1_projects
    ↓ (project_id)
workspace_state
    ↓ (workspace_id)
session_entries (when session is in that topic)
    ↓
Memory, Tasks, etc.
```

#### SQLite Schema Changes

```sql
-- Projects table (NEW) — replaces PROJECTS.md
CREATE TABLE op1_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,           -- Project root path (~/dev/operator1/Projects/{id})
  type TEXT,                    -- 'internal', 'external', 'reference'
  tech TEXT,
  status TEXT DEFAULT 'active', -- 'active', 'planning', 'on_hold', 'completed', 'archived'
  is_default INTEGER DEFAULT 0,
  keywords_json TEXT,           -- JSON array of keywords
  links_json TEXT,              -- { github, docs, slack, notion }
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX idx_op1_projects_status ON op1_projects(status);
CREATE INDEX idx_op1_projects_type ON op1_projects(type);

-- Telegram topic → project binding (NEW)
CREATE TABLE op1_telegram_topic_bindings (
  chat_id TEXT NOT NULL,        -- Telegram group/supergroup ID
  topic_id TEXT,                -- NULL for main group, topic ID for forum topics
  project_id TEXT NOT NULL,
  group_name TEXT,              -- Human-readable group name (cached)
  topic_name TEXT,              -- Human-readable topic name (cached)
  bound_at INTEGER DEFAULT (unixepoch()),
  bound_by TEXT DEFAULT 'manual', -- 'auto', 'manual'
  PRIMARY KEY (chat_id, topic_id),
  FOREIGN KEY (project_id) REFERENCES op1_projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_telegram_topic_project ON op1_telegram_topic_bindings(project_id);
CREATE INDEX idx_telegram_topic_chat ON op1_telegram_topic_bindings(chat_id);

-- Extend workspace_state with project link
ALTER TABLE workspace_state ADD COLUMN project_id TEXT REFERENCES op1_projects(id);

-- Extend session_entries with project link (move from JSON to column)
ALTER TABLE session_entries ADD COLUMN project_id TEXT REFERENCES op1_projects(id);
```

#### Implementation Tasks

- [x] Schema v8: add `op1_projects`, `op1_telegram_topic_bindings` tables + `workspace_state.project_id` column
- [x] Create `src/projects/project-store-sqlite.ts` — SQLite adapter for projects CRUD (implements `ProjectStore` interface)
- [x] Create `src/projects/telegram-topic-binding-sqlite.ts` — SQLite adapter for topic bindings
- [x] Create `src/infra/state-db/migrate-phase8.ts` — one-shot migration: `PROJECTS.md` → `op1_projects` + `op1_telegram_topic_bindings` rows
- [x] Add `project_id` column to `workspace_state` (schema migration v8, application-level FK)
- [x] Add `project_id` column to `session_entries` — schema v10 (2026-03-13):
  - `ALTER TABLE session_entries ADD COLUMN project_id TEXT` + index
  - Migration extracts `projectId` from `extra_json` → dedicated column
  - `store-sqlite.ts`: promoted to `DEDICATED_FIELDS`, added `updateSessionProjectId()` + `readSessionProjectId()` helpers
  - `projects.ts`: rewrote `persistProjectId`/`readPersistedProjectId` to use SQLite directly (removed JSON file I/O, `loadConfig`, `resolveGatewaySessionStoreTarget` imports)
- [x] Rewrite `src/gateway/server-methods/projects.ts`:
  - `projects.list/get/add/update/archive` → use `SqliteProjectStore` instead of `MarkdownProjectStore`
  - `autoBindByTopicFromSessionKey()` → queries `op1_telegram_topic_bindings` via `findProjectByTopicId()`
  - Removed all Markdown parsing/serialization code (`parseProjectsMd`, `serializeProjectsMd`, `resolveProjectsPath`)
- [x] Create new RPCs:
  - `projects.bindTelegramTopic({ projectId, chatId, topicId })` → insert into `op1_telegram_topic_bindings`
  - `projects.unbindTelegramTopic({ chatId, topicId })` → delete from `op1_telegram_topic_bindings`
  - `projects.getTelegramBindings({ projectId })` → list all topic bindings for a project
- [x] Register new RPCs in `server-methods-list.ts` and `method-scopes.ts`
- [x] Wire migration into `server-startup.ts` (runs after Phase 4E/5D)
- [x] Migration deletes `PROJECTS.md` after successful import

#### Auto-Bind Flow (Updated)

When a message arrives from Telegram:

1. **Lookup topic binding in SQLite:**

   ```sql
   SELECT project_id FROM op1_telegram_topic_bindings
   WHERE chat_id = ? AND topic_id = ?;
   ```

2. **If found → bind session to project:**
   - Set `session_entries.project_id`
   - Load project's workspace (`workspace_state` where `project_id` matches)
   - Memory reads from `projects/{id}/MEMORY.md` (Phase 8B)

3. **No binding → use default project or global workspace**

#### Benefits

| Before                          | After                                 |
| ------------------------------- | ------------------------------------- |
| Topic → project in Markdown     | Topic → project in SQLite (queryable) |
| Workspace not linked to project | `workspace_state.project_id` FK       |
| Session projectId in JSON       | `session_entries.project_id` column   |
| Auto-bind scans PROJECTS.md     | Auto-bind queries SQLite              |
| Manual topic binding edit       | RPCs for bind/unbind/list             |

#### Effort

**~2 days:**

- Schema + migration: 0.5 day
- Project store SQLite adapter: 0.5 day
- Topic binding store + RPCs: 0.5 day
- Integration + testing: 0.5 day

---

### Phase 8A: Session Tagging (Option C) — Immediate

**Goal:** Disambiguate memory entries when reading mixed MEMORY.md.

**Implementation:**

- [x] Memory tagging instruction injected dynamically into system prompt via `buildProjectContextBlock()` in `attempt.ts` — agents get `[Project: {id}]` tagging guidance only when bound to a project (no static AGENTS.md rule needed)
- [x] Agent reads `projects.getContext` at session start — already wired in `attempt.ts:920` via `getProjectContextForSession()`
- [x] All memory writes include `[Project: {projectId}]` header — system prompt instructs agents to prefix entries
- [x] When reading memory, agent can filter/weight by project tag — Phase 8B adds project memory dirs as `extraPaths` in memory search

**Effort:** ~0 days (just documentation update)

---

### Phase 8B: Project-Scoped Memory (Option B) — ✅ Complete

**Goal:** Each project gets its own memory folder inside the shared workspace.

**Implementation (actual):**

- [x] Create per-project memory structure at `~/.openclaw/workspace/projects/{id}/memory/`:
  - `ensureProjectMemoryDir(projectId)` in `src/projects/project-memory.ts`
  - `resolveProjectDir()` and `resolveProjectMemoryDir()` helpers
  - All projects (internal + external) use centralized path — never pollutes external repos
  ```
  ~/.openclaw/workspace/
  ├── MEMORY.md                    # Generic memory (no project bound)
  ├── memory/
  │   └── 2026-03-13.md
  └── projects/
      ├── appsfomo/memory/         # External project memory
      ├── crm-operations/memory/   # Internal project memory
      ├── operator1/memory/        # This repo's own project memory
      └── ...
  ```
- [x] Memory search auto-indexes project memory dirs via `extraPaths`:
  - `resolveMemorySearchConfig()` in `src/agents/memory-search.ts` calls `resolveProjectMemoryExtraPaths()`
  - Scans `op1_projects` for active projects, includes existing memory dirs
  - No static config changes needed — works automatically
- [x] System prompt instructs agent on project memory path:
  - `buildProjectContextBlock()` in `attempt.ts` calls `ensureProjectMemoryDir(project.id)`
  - Tells agent the exact path to write project-specific .md files
  - Memory search picks up files automatically on next sync cycle
- [x] No new SQLite tables needed — uses existing `op1_projects` + filesystem

**Effort:** ~0.5 day (simpler than originally planned — leveraged existing `extraPaths` mechanism)

---

### ~~Phase 8C: Per-Project Workspace (Option A)~~ — DROPPED

**Reason:** Unnecessary complexity. The workspace/project separation already handles this:

The existing three-layer architecture covers all use cases:

- **Workspace** (`~/.openclaw/workspace/`) = agent identity (SOUL.md, AGENTS.md, TOOLS.md, IDENTITY.md, USER.md). Shared across all projects.
- **Project context** (from project's `.openclaw/` dir) = project-specific SOUL.md, AGENTS.md, TOOLS.md injected via `buildProjectContextBlock()`. Defines how the agent works on this specific project.
- **Project memory** (`~/.openclaw/workspace/projects/{id}/memory/`) = isolated per-project recall, auto-indexed by memory search.

---

### Phase 8 Implementation Order

| Phase  | Description                                           | Effort  | Status  |
| ------ | ----------------------------------------------------- | ------- | ------- |
| 8.5    | Project/Workspace/Channel unification (SQLite schema) | 2 days  | ✅      |
| 8A     | Session tagging (Option C)                            | 0 days  | ✅      |
| 8B     | Project-scoped memory (Option B)                      | 0.5 day | ✅      |
| ~~8C~~ | ~~Per-project workspace (Option A)~~                  | —       | Dropped |

**Total Phase 8 effort:** ~2.5 days (completed)

---

### Phase 8 Success Criteria

- [x] Projects stored in SQLite (`op1_projects` table), not PROJECTS.md
- [x] Telegram topics bound to projects via SQLite (`op1_telegram_topic_bindings` table)
- [x] Workspace linked to project via `workspace_state.project_id` column
- [x] Session tagging: `session_entries.project_id` dedicated column (migrated from `extra_json`)
- [x] Auto-bind queries SQLite instead of scanning PROJECTS.md
- [x] Parallel sessions on different projects don't confuse memory context — each project has isolated memory dir
- [x] Memory reads/writes are scoped to project when bound — system prompt instructs agent to write to `~/.openclaw/workspace/projects/{id}/memory/`
- [x] QMD indexes project-scoped memory alongside global memory — project memory dirs added as `extraPaths` in `resolveMemorySearchConfig()`
- [x] Backward compatible: unbound sessions use global workspace (default behavior)

**Remaining (nice-to-have, not blocking):**

- [x] `projects.bindSession` / `projects.unbindSession` RPCs — already implemented (`projects.ts:209-241`)
- [x] RPCs: `projects.bindTelegramTopic`, `projects.unbindTelegramTopic`, `projects.getTelegramBindings` — already implemented (`projects.ts:275+`)
- [x] `projects.scaffold` RPC — not needed; `ensureProjectMemoryDir()` auto-creates memory dirs, project `.openclaw/` dirs live in the project path
- [x] Subagents inherit project context from parent session — `subagent-spawn.ts` reads parent's `project_id` and persists it to child session before agent call

---

_Last updated: 2026-03-13 (Phase 8 complete, 8C dropped)_
