# Fleet Upgrade Manager — Design Spec

**Date:** 2026-03-25
**Status:** Approved
**Author:** Jeff + Claude

## Problem

The OpenClaw fleet (Gateway, Kubuntu, Pop!_OS, Mac) runs a custom fork at version `0.1.0` with 11 custom capabilities built on top. Upstream OpenClaw is at `v2026.3.1` with daily releases, a mature plugin SDK, and features that overlap or supersede several custom capabilities. There is no formal version tracking, no upgrade process, and no rollback capability. The gap will only widen without a dedicated system to manage it.

**Note:** The "home" / Old VPS node (`100.85.159.3`) is **decommissioned** as of 2026-03-22 with data unrecoverable. It still appears in `config/fleet.json` but is excluded from all upgrade operations. The agent must skip this node during fleet inventory and flag it if encountered.

## Goal

Migrate to upstream OpenClaw as the base, port custom capabilities as upstream-compatible plugins/extensions, and establish a proactive autonomous upgrade system that keeps the fleet within 1-2 releases of upstream going forward.

## Solution

A single monolithic agent (`fleet-upgrade-manager`) with an accompanying skill (`/upgrade-manager`) that owns the entire upgrade domain: version tracking, changelog analysis, capability audit, plugin compatibility testing, rolling deployment, and rollback.

---

## 1. Agent Identity & Delegation Model

**Agent name:** `fleet-upgrade-manager`

**Description:** Autonomous agent that monitors upstream OpenClaw releases, analyzes impact against the fleet's custom plugin inventory, and manages rolling upgrades across all nodes. All upgrade-related tasks from other agents are routed here.

### Triggering Conditions

The agent activates when:
- Another agent encounters upgrade/version/compatibility questions
- User asks about OpenClaw versions, upgrades, or release notes
- Scheduled cron fires (daily upstream check)
- User invokes `/upgrade-manager` skill directly

### Delegation Contract

Other agents should hand off to this agent when they encounter:
- "What version is running on [node]?"
- "Is [feature] available in our OpenClaw?"
- "Upgrade/update/migrate" anything related to OpenClaw core
- Compatibility questions between upstream features and the fleet

### Autonomy Rules

- **Autonomous:** Pull upstream tags/changelogs, run compatibility analysis, test in worktrees, deploy to Kubuntu/Pop!_OS/Mac
- **Gated (requires human approval):** Deploy to Gateway, modify Ansible playbooks, change plugin interfaces, any breaking-change adoption
- **Never:** Force-push, delete data volumes, modify secrets, touch Supabase schema without approval

---

## 2. State Management & Version Tracking

**State file:** `config/upgrade-state.json`

The example below shows **pre-migration state** (nodes at commit hash, not yet on upstream versions):

```json
{
  "active_upgrade": null,
  "blocked_versions": [],
  "upstream": {
    "latest_stable": "v2026.3.1",
    "latest_checked": "2026-03-25T00:00:00Z",
    "tracking_branch": "main"
  },
  "fleet": {
    "gateway": {
      "current_version": "227e469",
      "target_version": "v2026.3.1",
      "last_upgraded": null,
      "status": "pending_migration",
      "locked_by": null
    },
    "kubuntu": {
      "current_version": "227e469",
      "target_version": "v2026.3.1",
      "last_upgraded": null,
      "status": "pending_migration",
      "locked_by": null
    },
    "pop-os": {
      "current_version": "227e469",
      "target_version": "v2026.3.1",
      "last_upgraded": null,
      "status": "pending_migration",
      "locked_by": null
    },
    "mac": {
      "current_version": "227e469",
      "target_version": "v2026.3.1",
      "last_upgraded": null,
      "status": "pending_migration",
      "locked_by": null
    },
    "home": {
      "current_version": null,
      "target_version": null,
      "last_upgraded": null,
      "status": "decommissioned",
      "locked_by": null
    }
  },
  "plugins": {
    "fleet-coordinator": {
      "path": "extensions/fleet-coordinator/",
      "type": "custom",
      "replaces_upstream": null,
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "archon-integration": {
      "path": "extensions/archon-integration/",
      "type": "custom",
      "replaces_upstream": null,
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "telegram-bot": {
      "path": "extensions/telegram-agentic/",
      "type": "hybrid",
      "replaces_upstream": "channels.telegram (partial)",
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "observability-aop": {
      "path": "extensions/observability-aop/",
      "type": "hybrid",
      "replaces_upstream": "plugin hooks (session_start/end, message:sent/transcribed)",
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "humbleforge-pipeline": {
      "path": "extensions/humbleforge-pipeline/",
      "type": "custom",
      "replaces_upstream": null,
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "distributed-workers": {
      "path": "extensions/distributed-workers/",
      "type": "custom",
      "replaces_upstream": null,
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    },
    "knowledge-layer": {
      "path": "services/knowledge_api/",
      "type": "hybrid",
      "replaces_upstream": "memorySearch (partial — Ollama embeddings)",
      "compatible_through": null,
      "last_tested": null,
      "status": "pending_migration"
    }
  },
  "pending_upgrades": [],
  "history": []
}
```

### Key Design Decisions

- **Per-node version tracking** — each node can be at a different version during rolling upgrades
- **Concurrency guard** — `active_upgrade` field holds the current upgrade session ID (or null). Per-node `locked_by` prevents concurrent upgrades to the same node. The agent acquires a fleet-redis distributed lock (`upgrade:lock:{node}`) before writing to the state file. **Note:** The distributed lock module does not exist yet — it must be created as part of implementation (a thin wrapper around `redis.set(key, value, nx=True, ex=300)` on fleet-redis at `100.93.214.109:6380` db=2)
- **Atomic writes** — state file updates use write-to-temp-then-rename to prevent corruption from partial writes or crashes
- **Plugin compatibility matrix** — each custom capability records path, type, upstream equivalent, and which version it's been tested against
- **Version hold** — `blocked_versions` list allows skipping known-bad upstream releases
- **History log** — append-only record with schema: `{timestamp, node, from_version, to_version, result, duration_ms, error}`
- **Decommissioned nodes** — nodes with `status: "decommissioned"` are skipped in all operations
- **Version format** — upstream uses date-based versioning (`vYYYY.M.D`) with optional beta suffixes (`v2026.2.15-beta.1`). "Within 1-2 releases" means within 2 tagged stable releases (not calendar days). Version comparison should use date-based sorting (`v2026.3.2 > v2026.3.1`), skipping beta tags unless explicitly opted in. The upstream `src/infra/update-check.ts` has a `compareSemverStrings` utility — reference its logic rather than inventing a new comparator
- **History rotation** — keep the last 100 entries in the `history` array. On each write, truncate older entries to prevent unbounded growth
- **Version source of truth:** Upstream versions from `openclaw-repo/` directory (a git clone, not a submodule — there is no `.gitmodules` file). The implementation must verify this directory exists and is a valid git repo. Fleet node versions from this state file, validated by SSH health checks

---

## 3. Custom Capability Audit & Plugin Migration Strategy

The agent maintains a capability inventory mapping each custom capability to its upstream status.

### Initial Capability Audit

| Custom Capability | Upstream Equivalent | Migration Strategy |
|---|---|---|
| **Fleet coordination** (fleet.json, fleet.py, fleet-redis) | None | **Keep as custom plugin.** `extensions/fleet-coordinator/` |
| **Archon integration** (task mgmt, MCP, Supabase) | None | **Keep as custom plugin.** `extensions/archon-integration/` |
| **Telegram bot** (agentic loop, 27 tools, delegation) | `src/telegram` + Plugin SDK hooks | **Hybrid.** Adopt upstream Telegram runtime. Port agentic loop as plugin using session/message lifecycle hooks |
| **Observability/AOP** (event shipper, aop-server) | Plugin hooks (`session_start/end`, `message:sent/transcribed`) | **Hybrid.** Use upstream hook events as data sources, keep aop-server as consumer. Retire custom event emission where upstream hooks provide same data |
| **Web outpost** (data viz, vault) | `gateway.controlUi` | **Evaluate.** Compare upstream Control UI features — may retire custom outpost for upstream + dashboard plugin |
| **Control UI** (Lit.js SPA) | Upstream Control UI (React) | **Evaluate.** May supersede or complement |
| **HumbleForge art pipeline** | None | **Keep as custom plugin.** `extensions/humbleforge-pipeline/` |
| **Ansible IaC** | None (upstream uses npm global install) | **Keep entirely.** Adapt playbooks to deploy upstream + extensions |
| **Cron framework** (PID locking, SQLite) | Upstream cron system + Control UI cron management | **Evaluate.** May adopt upstream cron runtime, keep SQLite logging as plugin hook |
| **Secrets/SOPS** | `~/.openclaw/credentials/` | **Keep as deployment layer.** SOPS manages fleet secrets; upstream handles runtime auth. Different layers |
| **Worker fleet** (distributed workers, git worktree) | None | **Keep as custom plugin.** `extensions/distributed-workers/` |
| **Knowledge layer** (unified knowledge API) | `memorySearch` with Ollama embeddings | **Hybrid.** Upstream now supports Ollama embeddings. Evaluate if upstream memory replaces knowledge API or if cross-system scope (OpenClaw + Obsidian) requires the custom layer |

### Per-Upgrade-Cycle Agent Workflow

1. Parse upstream changelog for the new release
2. Check each entry against the capability inventory
3. Flag overlaps: "upstream now does X, which your custom Y also does"
4. Recommend: adopt upstream, keep custom, or hybrid
5. Update `compatible_through` after testing

---

## 4. Upgrade Lifecycle & Node Risk Assessment

### Daily Polling Cycle

1. `git -C openclaw-repo fetch --tags` — check for new upstream tags
2. Compare latest tag against `upgrade-state.json` `upstream.latest_stable`
3. If new release found:
   - Parse changelog
   - Run capability impact analysis against plugin inventory
   - Classify release: **routine** (no breaking changes, no overlaps), **notable** (new features overlapping custom capabilities), or **breaking** (breaking changes affecting plugins)
   - Notify via Telegram with summary and classification

### Node Risk Assessment Model

| Factor | Weight | Rationale |
|---|---|---|
| **Public-facing** | High | Gateway serves external traffic, downtime is visible |
| **Dependency count** | Medium | More services = more breakage surface |
| **GPU workloads** | Low | Art pipeline is on-demand, can be paused |
| **Worker threads** | Medium | Active workers need graceful drain |
| **Unique services** | High | Single-host services (Archon on Gateway, Obsidian on Pop!_OS) have no fallback |

### Default Upgrade Order (agent adjusts per assessment)

1. **Mac** — dev workstation, no production impact, fastest feedback
2. **Kubuntu** — GPU node, workers drainable, no unique critical services
3. **Pop!_OS** — utility node, unique services but not public-facing
4. **Gateway** — last, always gated, public-facing, runs Archon/Supabase/nginx

### Per-Node Upgrade Steps

1. Acquire fleet-redis lock `upgrade:lock:{node}` and set `locked_by` in state file
2. Drain active workers (wait for in-flight tasks to complete, timeout 5 min)
3. Snapshot current state:
   - `docker compose config > /tmp/pre-upgrade-{node}-compose.bak`
   - Tag all running images: `docker tag {image} {image}:pre-upgrade-{date}` (so old images survive rebuild)
   - Record git commit ref: `git rev-parse HEAD`
4. Respect scheduling constraints — check `fleet.json` scheduling windows (e.g., Mac only 23:00-06:00 CST). Defer if outside window.
5. Update code to target version via SSH:
   - `ssh {node} "cd {openclaw_root} && git fetch origin main && git checkout {target_tag}"`
   - `ssh {node} "cd {openclaw_root} && git submodule update --init openclaw-repo"`
6. Run plugin compatibility tests in a git worktree on the target node
7. `ssh {node} "cd {openclaw_root} && docker compose build"`
8. `ssh {node} "cd {openclaw_root} && docker compose up -d"`
9. Health check all services:
   - Required services (must pass): use health endpoints from `fleet.json` where defined, fall back to `docker inspect --format='{{.State.Health.Status}}'`
   - Optional services (warn only): services without health endpoints (e.g., `forge_blender`, `fleet_redis` with `health: null`)
   - Timeout: 60s per service, 3 retries with 10s backoff
   - All required services must report healthy within 5 minutes total
10. If health check fails: automatic rollback (see below)
11. Release fleet-redis lock, update `upgrade-state.json` with new version and timestamp
12. Notify via Telegram: success or rollback with details

### Rollback Mechanism

On health check failure or any error after step 7:
1. `ssh {node} "cd {openclaw_root} && git checkout {previous_commit_ref}"`
2. `ssh {node} "cd {openclaw_root} && docker compose down"`
3. Retag pre-upgrade images back: `docker tag {image}:pre-upgrade-{date} {image}:latest`
4. `ssh {node} "cd {openclaw_root} && docker compose up -d"` (uses old code + old images)
5. Verify rollback health checks pass
6. Set node status to `rollback_failed` if health checks still fail (requires human intervention)
7. Release fleet-redis lock
8. Log rollback to history with error details

### Dry-Run Mode

The skill accepts a `--dry-run` flag that runs the full analysis and compatibility check (steps 1-6) but stops before `docker compose build`. Outputs a report of what would happen without making changes. Useful for building trust in the system and previewing breaking-change impact.

### Gateway Gate

After all non-production nodes succeed:
> "Upgrade to vYYYY.M.D complete on mac, kubuntu, pop-os. All health checks passing. Gateway upgrade ready — reply 'approve gateway' to proceed or 'hold' to defer."

---

## 5. File Structure & Integration

### Files

```
skills/
  upgrade-manager/
    upgrade-manager.md          # Skill — invoked via /upgrade-manager
agents/
  fleet-upgrade-manager.md      # Agent — autonomous, schedulable, delegatable
config/
  upgrade-state.json            # State — version tracking, plugin inventory
```

### Skill (`upgrade-manager.md`)

User-invocable via `/upgrade-manager`. Provides instructions for:
- Checking current fleet versions
- Running an on-demand upgrade check
- Viewing the capability audit
- Forcing an upgrade of a specific node

### Agent (`fleet-upgrade-manager.md`)

System prompt encodes: fleet topology, plugin inventory, upgrade lifecycle, risk assessment model, autonomy rules.

Tools: Bash (git, docker, SSH), Read, Write, Edit, Grep, Glob, Agent (for dispatching node-specific work).

Triggered by: cron schedule, other agent delegation, user invocation.

### Cron Integration

New cron entry using existing `scripts/cron-wrapper.sh` pattern, runs daily at 02:00 CST (within Mac's available window for canary upgrades):

```bash
# In crontab on Gateway VPS:
0 2 * * * /home/appbox/apps/openclaw/scripts/cron-wrapper.sh upgrade-check \
  "cd /home/appbox/apps/openclaw && git -C openclaw-repo fetch --tags 2>&1 | head -20"
```

The cron job only fetches tags and checks for new versions. If a new version is detected, it writes a marker file (`/tmp/openclaw-upgrade-pending`) and sends a Telegram notification. The full upgrade agent is then triggered via the Telegram bot's `delegate_task` tool, which can invoke Claude Code with the fleet-upgrade-manager agent.

This avoids the problem of `claude-code --agent` not being a real CLI interface — the existing Telegram bot delegation pattern handles agent invocation.

### Ansible Sync Strategy

Ansible and the upgrade manager must stay in sync. The upgrade manager owns runtime upgrades (docker compose up/down). Ansible owns infrastructure-level config (nginx, firewall, system packages, volume mounts). To prevent drift:
- After a successful upgrade, the agent updates `infra/ansible/inventory/group_vars/` with the new version tag so the next Ansible run is compatible
- Ansible playbooks check `upgrade-state.json` to determine the expected version before deploying
- If Ansible detects a version mismatch (state file says v2026.3.2 but compose is on v2026.3.1), it defers to the state file and rebuilds to match

### Data Migration Awareness

Upstream upgrades may change database schemas, config formats, or volume mount paths. The agent must:
- Check upstream release notes for migration instructions (look for "BREAKING" and "migration" keywords)
- Compare Dockerfile VOLUME directives and entrypoint scripts between versions
- If data migration is detected, classify the upgrade as **breaking** and require human approval even for non-production nodes
- Run migration scripts (if provided by upstream) as part of the upgrade steps, after build but before health checks

### Upstream Update Runner Coexistence

Upstream OpenClaw has a built-in update runner (`src/infra/update-runner.ts`) that handles single-node self-updates via git or npm. Our fleet upgrade manager does NOT replace this — it wraps it at the fleet level. The relationship:
- **Upstream update-runner:** single-node, handles git fetch/checkout/build on the local machine
- **Our fleet-upgrade-manager:** multi-node orchestrator that SSHs into each node and coordinates the upgrade order, rollback, and health checks

Where possible, the implementation should invoke upstream's update-runner on each node rather than reimplementing git/build steps. If upstream's runner is insufficient (e.g., no pre-upgrade image tagging, no fleet-redis lock awareness), extend it via wrapper scripts rather than bypassing it entirely.

### Plugin Directory Conventions

Custom plugins in `extensions/` must follow upstream's workspace package structure:
- Each plugin gets its own `package.json` as a pnpm workspace member
- Runtime deps in `dependencies`, OpenClaw SDK in `devDependencies` or `peerDependencies`
- No `workspace:*` in `dependencies` (breaks npm install)
- Follow naming convention: `@openclaw/{plugin-name}`

This ensures custom plugins are compatible with upstream's plugin loading, lifecycle hooks, and SDK APIs.

### Fleet Configuration Source

**Note:** `config/fleet.json` currently exists at `config/fleet.json` in the repo. If this file is missing at implementation time, it must be created from the fleet topology documented in this spec and in memory. The agent reads fleet topology from this file and scheduling windows from the `scheduling` section within it.

### Cron-to-Agent Handoff

The cron marker file is written to `/tmp/openclaw-upgrade-available-{tag}` (e.g., `/tmp/openclaw-upgrade-available-v2026.3.2`). The Telegram notification includes the tag. The bot's `delegate_task` handler checks for marker files matching `/tmp/openclaw-upgrade-available-*` and passes the tag to the fleet-upgrade-manager agent. After the agent processes the upgrade (or defers it), the marker file is deleted.

### State File Seeding

On first run, the agent:
1. Inventories the fleet from `config/fleet.json`, `docker-compose*.yml`, Ansible host_vars
2. Marks "home" node as `decommissioned` (present in fleet.json but offline since 2026-03-22)
3. Populates plugin inventory from the capability audit table with full schema
4. Sets all active nodes to current commit hash (`git rev-parse HEAD`) as their version
5. After initial migration to upstream, versions switch to proper upstream tags
