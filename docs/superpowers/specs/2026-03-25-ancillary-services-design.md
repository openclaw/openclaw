# Ancillary Services Integration — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Author:** Jeff + Claude
**Sub-Project:** 5 of 5 (Fleet Migration)

---

## Problem

The OpenClaw fork has six ancillary services that extend the core system: Archon (task management/RAG), HumbleForge (3D art pipeline), Unified Knowledge Layer (cross-system vector search), a custom cron framework, SOPS secrets management, and a fleet upgrade manager. These services were built as tightly coupled Python modules and shell scripts inside the fork. Migrating to upstream OpenClaw requires porting or adapting each one to work with upstream's extension architecture, MCP server protocol, credential storage, and built-in scheduling.

Some of these services (Archon, Knowledge Layer) are external processes that merely need a connection bridge. Others (HumbleForge lifecycle, cron jobs) are deeply integrated with the fork's custom code and need structural changes. The fleet upgrade manager was already ported in Sub-Project 4 and needs only minor updates for the new context.

## Goal

Integrate all six ancillary services with upstream OpenClaw such that:

1. Archon remains an external service, connected via its existing MCP server with zero changes to Archon itself.
2. HumbleForge is usable from chat and agents via tools, with GPU contention management preserved.
3. The Knowledge Layer is accessible as a searchable data source without duplicating its backend.
4. Cron jobs either migrate to upstream's scheduling or run alongside it without conflict.
5. SOPS continues to manage fleet secrets, outputting to upstream's expected format.
6. The fleet upgrade manager works with upstream's binary update mechanism.

## Solution

Each service maps to a different integration pattern based on its nature:

| Service | Integration Pattern | Runs On |
|---|---|---|
| Archon | MCP server (already exists) | Gateway VPS (no changes) |
| HumbleForge | Custom extension with tools | Kubuntu (remote via SSH) |
| Knowledge Layer | MCP server (new, thin wrapper) | Pop!_OS |
| Cron Framework | Hybrid — upstream scheduler + wrapper for custom jobs | All nodes |
| SOPS Secrets | Deployment script adaptation | Mac (dev), all nodes (deploy) |
| Fleet Upgrade Manager | Already ported (Sub-Project 4) | Mac + Gateway |

---

## 1. Archon Integration Strategy

### Current State

Archon is a standalone service on the Gateway VPS exposing:
- REST API on port 8181 (task management, project management, document management, RAG search)
- MCP server on port 8051 via SSE transport
- UI on port 3737

The fork connects to Archon MCP from every node using `ARCHON_SERVER_URL=http://100.69.32.10:8181`. The MCP server provides 17 tools (task CRUD, project CRUD, document CRUD, RAG search, health check, session info).

### Integration Approach: MCP Configuration Only

Archon already speaks MCP. Upstream OpenClaw already supports MCP servers. This is purely a configuration task.

**openclaw.toml MCP section:**

```toml
[mcp.archon]
transport = "sse"
url = "http://100.69.32.10:8051/sse"
```

No extension code needed. No changes to Archon itself.

### Node-Specific Considerations

- All nodes connect to the same Archon instance on Gateway over Tailscale.
- If Gateway is unreachable, Archon tools fail gracefully (MCP connection timeout). No fallback instance exists.
- The Archon MCP server uses SSE transport exclusively. Upstream's MCP client must be configured for SSE, not streamable-http — Archon's streamable-http handshake is incompatible with Claude Code's MCP client.

### Archon Upgrade/Replacement Decision

Archon should remain as-is for the migration. It is stable, provides unique value (project-scoped RAG, task tracking with status workflows), and replacing it would be a separate project. If upstream ever ships a native task management system, evaluate then.

### Dependencies

- Sub-Project 1 (Core Migration): `openclaw.toml` must exist and support `[mcp.*]` sections.

---

## 2. HumbleForge Extension Architecture

### Current State

The fork manages HumbleForge via:
- `config/fleet.json` — 5 service entries under `kubuntu.services` with lifecycle metadata (compose file path, compose service name, GPU requirements, always-on flag)
- `shared/fleet.py` — `start_service()`, `stop_service()`, `service_status()` methods that SSH into Kubuntu, run `docker compose` commands, and manage GPU contention via `LOCK_ART_PIPELINE`
- 3 Telegram chat tools: `pipeline_status`, `pipeline_start`, `pipeline_stop`
- GPU contention: When HumbleForge GPU services start, Ollama is paused (or vice versa) using the `LOCK_ART_PIPELINE` semaphore in fleet-redis

### Integration Approach: Custom Extension

HumbleForge is unique to this fleet and has no upstream equivalent. It belongs as a custom extension that registers tools.

**Extension ID:** `humbleforge-pipeline`
**Extension Kind:** `tools` (registers custom tools, no memory/channel behavior)

### Extension Responsibilities

1. **Tool Registration** — Three tools matching current Telegram bot capabilities:
   - `humbleforge_status` — Query all 5 services for running/stopped state via SSH + `docker compose ps`
   - `humbleforge_start` — Start specified service(s), handle GPU contention lock
   - `humbleforge_stop` — Stop specified service(s), release GPU lock, optionally resume Ollama

2. **GPU Contention Manager** — Before starting any GPU-required service:
   - Acquire `LOCK_ART_PIPELINE` in fleet-redis (`100.93.214.109:6380` db=2)
   - If Ollama is serving a request, wait up to 30 seconds for completion, then pause Ollama
   - On stop, release lock and unpause Ollama if no other GPU services are running

3. **Service Topology** — Read from `config/fleet.json` `kubuntu.services.forge_*` entries. The extension does not hardcode service names or compose paths.

### File Structure

```
extensions/humbleforge-pipeline/
  package.json              # @openclaw/humbleforge-pipeline
  openclaw.plugin.json      # kind: "tools"
  index.ts                  # definePluginEntry, register 3 tools
  lib/
    ssh-executor.ts         # SSH command execution to Kubuntu
    gpu-contention.ts       # Redis lock acquire/release, Ollama pause/unpause
    service-topology.ts     # Parse fleet.json for HumbleForge services
```

### Key Design Decisions

- **SSH, not HTTP:** HumbleForge services do not expose a management API. All lifecycle operations go through SSH to Kubuntu and run `docker compose` commands. The extension needs the SSH key path from config.
- **Fleet-redis dependency:** GPU contention locks require Redis connectivity. If fleet-redis is unreachable, the extension should refuse to start GPU services (fail-safe, not fail-open).
- **Not an MCP server:** An MCP server would add an unnecessary process. The tools are simple enough to implement as direct extension tools.
- **Kubuntu-only:** The extension only operates on Kubuntu. If the node is unreachable, tools return an error explaining the node is offline.

### Extension Configuration

```toml
[extensions.humbleforge-pipeline]
enabled = true
kubuntu_ssh = "ssh -i ~/.ssh/openclaw_local jeff@100.93.214.109"
fleet_redis_url = "redis://100.93.214.109:6380/2"
compose_file = "/home/jeff/Dev_Projects/HumbleForge/docker-compose.humbleforge.yml"
```

### Dependencies

- Sub-Project 1 (Core Migration): Extension loading and `openclaw.plugin.json` support.
- Sub-Project 2 (Fleet Coordinator): Fleet-redis connectivity shared with fleet coordinator extension.

---

## 3. Knowledge Layer MCP Server

### Current State

The Unified Knowledge Layer is a FastAPI service on Pop!_OS (:8890) backed by:
- Postgres + pgvector for entity storage and vector search
- Qdrant for cross-system semantic search
- Bridges OpenClaw and Obsidian Organizer data

Code is complete (2026-03-22) but NOT YET DEPLOYED. The fork planned to integrate via Python imports from `shared/`.

### Integration Approach: MCP Server

The Knowledge Layer is a separate Python process with its own database dependencies. It should NOT be embedded inside the OpenClaw TypeScript extension system. An MCP server is the correct boundary:

1. The Knowledge API already runs as a FastAPI service.
2. Add an MCP SSE endpoint to the existing FastAPI app.
3. Configure OpenClaw to connect to it like any other MCP server.

### MCP Server Tools

The Knowledge API should expose these tools via MCP:

| Tool | Description |
|---|---|
| `knowledge_search` | Semantic vector search across all entities (OpenClaw + Obsidian) |
| `knowledge_get_entity` | Retrieve a specific entity by ID with full metadata |
| `knowledge_list_sources` | List available knowledge sources and their entity counts |
| `knowledge_ingest` | Queue a document/URL for ingestion into the knowledge store |

### MCP Endpoint Addition

Add to the existing FastAPI app:

```
GET /mcp/sse  — SSE transport endpoint
POST /mcp/messages — SSE message endpoint
```

This is a thin wrapper that translates MCP tool calls to existing Knowledge API endpoints. No new business logic.

### OpenClaw Configuration

```toml
[mcp.knowledge]
transport = "sse"
url = "http://100.119.126.67:8890/mcp/sse"
```

### Relationship to Upstream Memory

Upstream OpenClaw has `memory-core` (file-backed memory search) and `memory-lancedb` (vector memory). The Knowledge Layer does NOT replace these — it serves a different purpose:

- **Upstream memory:** Per-project, file-scoped, conversation context
- **Knowledge Layer:** Cross-system, entity-scoped, persistent knowledge graph (people, projects, papers, concepts bridging OpenClaw and Obsidian Organizer)

Both should coexist. The Knowledge Layer MCP tools appear alongside memory tools, and the agent decides which to use based on the query.

### Deployment Sequence

1. Deploy Knowledge API to Pop!_OS (Ansible, separate from this spec)
2. Add MCP endpoint to Knowledge API codebase
3. Configure `openclaw.toml` on all nodes to connect to it
4. Verify tools appear in tool list

### Dependencies

- Sub-Project 1 (Core Migration): MCP server configuration in `openclaw.toml`.
- External: Knowledge API must be deployed to Pop!_OS first (Ansible playbook, separate work).

---

## 4. Cron Framework Migration

### Current State

The fork has a mature cron system:
- `scripts/cron-wrapper.sh` — PID locking, signal traps, configurable timeout, SQLite logging to `data/cron-log.db`, JSONL logging to `data/logs/cron.jsonl`
- `config/cron-schedule.json` — 25 declared jobs (17 enabled)
- System crontab entries that call `cron-wrapper.sh` with job name, timeout, and command
- Jobs range from simple (heartbeat every 30 min) to complex (coding-task-poll every 15 min, council every 6 hours)

### Upstream's Scheduling

Upstream OpenClaw has a built-in scheduling system accessible from the Control UI. It supports:
- Cron expressions for scheduling
- Job registration via extension hooks
- Status tracking in the Control UI dashboard
- No PID locking or SQLite logging

### Migration Strategy: Hybrid

Not all jobs can move to upstream's scheduler. The split:

**Move to upstream scheduler (6 jobs):**
These are simple, stateless, and benefit from Control UI visibility:
- `heartbeat` — health checks
- `log-rotation` — file rotation
- `stale-cleanup` — mark stale jobs
- `permission-check` — file permission audit
- `auth-refresh` — token refresh
- `library-sync` — pull library updates

**Keep on cron-wrapper.sh (11 jobs):**
These are complex, long-running, or have dependencies that upstream's scheduler cannot handle:
- `council` — runs Claude Code agents, needs PID locking and 10-min timeout
- `coding-task-poll` — polls Archon, runs Codex sandboxes, needs 30-min timeout
- `news-blogger` — AI summarization pipeline, 20-min timeout
- `feed-poll` — external RSS/Atom polling with retry logic
- `database-backup` — needs GPG, manifest generation, 10-min timeout
- `backup-integrity-drill` — monthly, needs SQLite logging for audit
- `dev-status-digest` — cross-system status aggregation
- `memory-distillation` — runs LLM summarization
- `git-sync` — auto-commit with conflict handling
- `vault-sync` — Obsidian vault sync
- `autoresearch` — autonomous skill improvement, complex LLM workflow

**Disabled / Evaluate (8 jobs):**
Already disabled in fork or candidates for upstream replacement:
- `memory-synthesis` (disabled, superseded)
- `email-poll` (disabled)
- `content-catalog-refresh` (disabled)
- `content-weekly-summary` (disabled)
- `notification-flush-*` (3 jobs — evaluate if upstream has notification batching)
- `knowledge-db-backup` (depends on Knowledge Layer deployment)

### Cron-Wrapper Preservation

`scripts/cron-wrapper.sh` continues to exist and run for complex jobs. It gains no new features. The script is infrastructure, not application code — it does not need to become an extension.

### Upstream Scheduler Integration

For jobs moved to upstream, register them via an extension that uses upstream's scheduling API:

```
extensions/cron-bridge/
  package.json
  openclaw.plugin.json      # kind: "lifecycle"
  index.ts                  # Register jobs with upstream scheduler
```

The `cron-bridge` extension registers the 6 simple jobs on startup. Each job invokes the same underlying script but through upstream's execution model rather than system crontab.

### SQLite Logging Coexistence

`cron-wrapper.sh` logs to `data/cron-log.db`. Upstream's scheduler logs to its own store. The observability extension (Sub-Project 3) should query both sources to present a unified view.

### Dependencies

- Sub-Project 1 (Core Migration): Extension lifecycle hooks for job registration.
- Sub-Project 3 (Observability): Unified cron log visibility.

---

## 5. Secrets Management Adaptation

### Current State

SOPS + age encrypts environment variables per node:
- `secrets/{node}.env.enc.json` — encrypted JSON, one file per node
- `scripts/sops-env.sh` — decrypt, diff, deploy commands
- Decrypted output is flat `KEY=VALUE` format written to `.env` files on target nodes
- Runtime auth handled by `shared/auth_manager.py` (Codex OAuth refresh, Claude OAuth token)
- Fleet nodes use SOPS-deployed secrets only; Mac uses interactive auth

### Upstream's Credential Storage

Upstream uses `~/.openclaw/credentials/` for runtime credentials:
- `~/.openclaw/credentials/anthropic.json` — Anthropic API key or OAuth token
- `~/.openclaw/credentials/openai.json` — OpenAI API key
- Individual files per provider

Upstream also reads `openclaw.toml` for non-secret configuration.

### Migration Strategy: Adapt Output Format

SOPS remains the source of truth for all secrets across the fleet. What changes is the output format and deployment targets.

### Changes to sops-env.sh

The `deploy` command currently writes a single `.env` file. After migration, it writes to multiple targets:

1. **`.env`** — Still needed for docker compose services (Supabase, Archon, HumbleForge, AOP server) that read environment variables.
2. **`~/.openclaw/credentials/`** — New target for OpenClaw-specific credentials (Anthropic token, OpenAI key).
3. **`openclaw.toml` secrets section** — For any secrets that upstream reads from config (e.g., MCP server auth tokens).

The script gains a `--format` flag:

```bash
# Current (unchanged):
bash scripts/sops-env.sh deploy gateway        # writes .env

# New additional targets:
bash scripts/sops-env.sh deploy gateway --credentials  # writes ~/.openclaw/credentials/
bash scripts/sops-env.sh deploy gateway --all          # writes .env + credentials + toml
```

### Auth Manager Migration

`shared/auth_manager.py` handles autonomous token refresh for Codex and Claude subscriptions. In upstream:

- Codex OAuth (`~/.codex/auth.json`) — unchanged, Codex is a separate tool.
- Claude Code OAuth — upstream reads from `~/.openclaw/credentials/anthropic.json`. The auth manager must write to this path instead of setting `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.

The auth manager is a Python script that runs hourly via cron. It does not need to become an extension. It continues running as a cron job (via cron-wrapper.sh) and writes to the new credential paths.

### Secret Categories After Migration

| Category | Source | Deployed To | Read By |
|---|---|---|---|
| LLM API keys | SOPS | `~/.openclaw/credentials/` | OpenClaw core |
| Docker service env vars | SOPS | `.env` | docker compose |
| MCP server tokens | SOPS | `openclaw.toml` | OpenClaw MCP client |
| OAuth refresh tokens | auth_manager.py | `~/.openclaw/credentials/` | OpenClaw core |
| Telegram bot token | SOPS | `.env` | Telegram extension |
| Supabase keys | SOPS | `.env` | Supabase containers |

### Dependencies

- Sub-Project 1 (Core Migration): `openclaw.toml` format must be finalized so SOPS knows where to write secrets.
- Sub-Project 3 (Observability): AOP server credentials in `.env` unchanged.

---

## 6. Fleet Upgrade Manager Updates

### Current State

The fleet upgrade manager was designed and ported in Sub-Project 4. Files exist in this repo:
- `.claude/agents/fleet-upgrade-manager.md`
- `skills/upgrade-manager/upgrade-manager.md`
- `config/upgrade-state.json`
- `shared/upgrade_lock.py`, `shared/upgrade_state.py`, `shared/upgrade_changelog.py`
- `scripts/upgrade-check.sh`

### What Needs Updating

The upgrade manager was designed for the fork's deployment model (git pull + docker compose rebuild). Upstream OpenClaw uses a different update mechanism:

1. **Upstream's `update-runner.ts`** — Handles single-node binary updates via git fetch/checkout or npm update. The fleet upgrade manager should invoke this on each node rather than reimplementing git checkout steps.

2. **Extension compatibility** — After an upstream update, custom extensions in `extensions/` may need rebuild. The upgrade manager must run `pnpm install` after updating to ensure extension dependencies resolve against the new upstream version.

3. **Version format** — Already handled. Upstream uses `vYYYY.M.D` tags which the existing state file schema supports.

### Specific Changes

| Component | Change |
|---|---|
| Agent instructions | Update SSH deploy steps to invoke upstream's update-runner instead of raw git commands. Add `pnpm install` step after checkout. |
| `upgrade-check.sh` | No changes needed — already fetches tags from upstream remote |
| `upgrade_state.py` | Add `extensions_rebuilt` boolean to per-node state for tracking post-update extension builds |
| `upgrade_changelog.py` | No changes — already parses upstream CHANGELOG.md format |
| `upgrade_lock.py` | No changes — fleet-redis locking is infrastructure-level |

### Dependencies

- Sub-Project 4 (Fleet Upgrade Manager): Must be fully implemented before these updates apply.
- Sub-Project 1 (Core Migration): pnpm workspace structure must be set up for extension builds.

---

## Extension File Structures Summary

After all ancillary services are integrated, the `extensions/` directory gains:

```
extensions/
  humbleforge-pipeline/
    package.json                # @openclaw/humbleforge-pipeline
    openclaw.plugin.json        # kind: "tools"
    index.ts                    # Tool registration
    lib/
      ssh-executor.ts
      gpu-contention.ts
      service-topology.ts
    index.test.ts
  cron-bridge/
    package.json                # @openclaw/cron-bridge
    openclaw.plugin.json        # kind: "lifecycle"
    index.ts                    # Register simple cron jobs with upstream scheduler
    index.test.ts
```

The Knowledge Layer does NOT get an extension directory — it runs as an external MCP server on Pop!_OS. Archon also has no extension directory — it is configured as an MCP server in `openclaw.toml`.

### MCP Servers in openclaw.toml

```toml
[mcp.archon]
transport = "sse"
url = "http://100.69.32.10:8051/sse"

[mcp.knowledge]
transport = "sse"
url = "http://100.119.126.67:8890/mcp/sse"
```

### Scripts Retained (Not Ported to Extensions)

```
scripts/
  cron-wrapper.sh               # Unchanged — PID locking, SQLite logging
  sops-env.sh                   # Updated — new --credentials and --all flags
  upgrade-check.sh              # Unchanged — daily tag fetch
  refresh-tokens.sh             # Updated — write to ~/.openclaw/credentials/
  backup.sh                     # Unchanged
  backup-drill.sh               # Unchanged
  run-council.sh                # Unchanged
  run-news-blogger.sh           # Unchanged
  coding-task-poll.sh           # Unchanged
  (and other complex cron jobs)
```

---

## Dependencies on Sub-Projects 1-4

| Sub-Project | What This Spec Depends On |
|---|---|
| **1 — Core Migration** | `openclaw.toml` config format, MCP server configuration, extension loading via `openclaw.plugin.json`, pnpm workspace for custom extensions |
| **2 — Fleet Coordinator** | Fleet-redis connectivity (shared with HumbleForge GPU contention), `config/fleet.json` schema (shared with HumbleForge service topology) |
| **3 — Observability (AOP)** | Unified cron log query across upstream scheduler + cron-wrapper.sh SQLite, extension lifecycle events for monitoring |
| **4 — Fleet Upgrade Manager** | Already ported; this spec defines minor updates to agent instructions and state schema |

### Implementation Order Within This Sub-Project

1. **Archon MCP config** — Zero code, just `openclaw.toml` entry. Can be done immediately after Sub-Project 1.
2. **SOPS adaptation** — Update `sops-env.sh` output format. Needed before deploying anything to nodes.
3. **Cron bridge extension** — Simple extension, low risk. Validates extension loading works.
4. **HumbleForge extension** — Medium complexity (SSH, Redis, GPU contention). Requires fleet-redis from Sub-Project 2.
5. **Knowledge Layer MCP** — Requires Knowledge API deployment to Pop!_OS first (external dependency). Can proceed in parallel with items 3-4 once API is deployed.
6. **Upgrade manager updates** — Last, depends on Sub-Project 4 completion.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Knowledge API not yet deployed | Knowledge MCP blocked | Proceed with other services; Knowledge MCP is independent and can ship later |
| Upstream scheduler lacks PID locking | Complex jobs could overlap | Keep complex jobs on cron-wrapper.sh; only move simple/stateless jobs to upstream |
| SOPS output format change breaks existing deploys | Nodes lose credentials | Add `--all` flag alongside existing behavior; old `.env` deploy still works |
| HumbleForge SSH from extension process | Security: SSH key access from OpenClaw runtime | Use same key already deployed for fleet operations; no new key material |
| Archon MCP SSE transport regression | All task management tools break | Pin Archon version; SSE transport is stable and tested |
| Fleet-redis unavailability blocks HumbleForge | Cannot start GPU services | Fail-safe by design — refuse to start GPU services without lock confirmation |

---

## Out of Scope

- Upgrading or replacing Archon itself
- Deploying the Knowledge API to Pop!_OS (separate Ansible work)
- Rewriting cron-wrapper.sh or cron-log.db schema
- Adding new cron jobs (only migrating existing ones)
- forge-curator API integration for pipeline job submission (future work noted in HumbleForge section)
- Obsidian Organizer changes (separate project, separate repo)
