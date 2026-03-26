# Fleet Coordination — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Sub-Project:** 3 of 5 (Fork-to-Upstream Migration)
**Author:** Jeff + Claude
**Depends on:** Sub-Project 1 (Extension SDK Bootstrap), Sub-Project 2 (Config/Secrets Migration)

---

## Problem

The custom OpenClaw fork runs a 5-node fleet (Gateway, Kubuntu, Pop!_OS, Mac, plus decommissioned Old VPS) coordinated through bespoke Python modules: `shared/fleet.py` for node discovery and health, `shared/fleet_coord.py` for Redis-based distributed locks and heartbeats, `shared/task_worker.py` for distributed task execution, `shared/task_lock.py` for claim arbitration, and `shared/worktree_manager.py` for git worktree isolation. A bash hook (`fleet-guard.sh`) blocks destructive operations and coordinates Docker locks through Redis.

Upstream OpenClaw has no fleet concept. It runs as a single-node gateway process. Sessions are local. There is no distributed task routing, no worker lifecycle, no health checking of remote nodes. Upstream does have ACP (Agent Client Protocol) for agent-to-agent dispatch, but it operates within a single gateway instance over stdio/WebSocket — it has no awareness of remote nodes or network topology.

Without porting fleet coordination, the migration to upstream would collapse the system from 10 concurrent worker threads across 4 nodes down to a single gateway process on one machine.

## Goal

Port fleet coordination as upstream-compatible OpenClaw extensions that:

1. Expose the fleet node registry to the agent runtime so agents can discover nodes, services, and capabilities
2. Enable distributed task execution across multiple nodes with claim arbitration and worktree isolation
3. Integrate fleet-redis for distributed locks, heartbeats, and presence detection
4. Enforce task routing rules (which node handles which task type) and scheduling constraints (Mac available 23:00-06:00 CST only)
5. Provide fleet health monitoring integrated with upstream's status system
6. Port fleet guard safety hooks to upstream's hook system
7. Preserve the current capacity: Gateway 2 threads, Kubuntu 4 threads, Pop!_OS 4 threads = 10 concurrent agents

## Solution

Two extensions plus a shared Redis integration layer:

- **`extensions/fleet-coordinator/`** — Fleet registry, health monitoring, task routing, scheduling, and guard hooks. This is the "brain" that knows about nodes and decides where work goes.
- **`extensions/distributed-workers/`** — Worker lifecycle, task polling, claim arbitration, worktree isolation, and execution. This is the "muscle" that runs on each node and executes tasks.
- **`extensions/shared/fleet-redis.ts`** — Shared Redis client module used by both extensions. Not a standalone extension; just a shared dependency.

The split reflects a real operational boundary: fleet-coordinator runs on the gateway (the single source of truth for fleet topology), while distributed-workers runs on every node that executes tasks.

---

## 1. Fleet Registry Architecture

### Current State (Fork)

`config/fleet.json` is a 239-line JSON file containing:
- **5 node definitions** with Tailscale IPs, SSH configs, roles, services (with ports, health endpoints, protocol), capabilities, and hardware profiles (GPU VRAM, CPU cores, RAM, model fit tables)
- **Scheduling rules** per node (available hours in CST, priority hours)
- **Task routing table** mapping 12 task types to primary/fallback nodes
- **Service lifecycle configs** for on-demand services (HumbleForge art pipeline on Kubuntu)

`shared/fleet.py` provides:
- `FleetNode` class with health checks (HTTP, TCP, SSH container), service URL resolution, SSH exec, on-demand service start/stop
- `Fleet` class for node lookup by role/capability/service, all-health scans
- `get_recommendation()` — VRAM-aware, load-aware node selection with hot-model detection
- `get_task_node()` — Time-of-day-aware task routing
- `is_node_preferred()` — Scheduling window enforcement

### Upstream Design

**Config file:** `config/fleet.json` (same location, same schema — Sub-Project 2 handles config migration)

**Extension:** `extensions/fleet-coordinator/`

The fleet-coordinator extension exposes fleet data to the agent runtime through:

1. **Runtime API** — TypeScript module (`fleet-registry.ts`) that loads `fleet.json` at startup, provides typed access to nodes, services, capabilities, and routing rules. Equivalent to the Python `Fleet` class but in upstream's TypeScript runtime.

2. **Health Monitor** — Background service (`health-monitor.ts`) that periodically checks all registered services. Uses HTTP health endpoints, TCP socket probes, and SSH container checks (via `node-ssh` or subprocess). Results are cached and exposed through the runtime API and the gateway's `/status` endpoint.

3. **MCP Tools** — Agent-callable tools registered via the plugin SDK:
   - `fleet_nodes` — List all nodes with roles, capabilities, health status
   - `fleet_health` — Full health check across all nodes and services
   - `fleet_service_url` — Resolve a service URL on a specific node
   - `fleet_recommendation` — Get the best node for a task type (VRAM-aware, load-aware, schedule-aware)
   - `fleet_ssh_exec` — Execute a command on a remote node via SSH

4. **Service Lifecycle** — Port the on-demand start/stop logic for services with `lifecycle` configs (HumbleForge pipeline services). Exposed as MCP tools: `fleet_service_start`, `fleet_service_stop`, `fleet_service_status`.

### Key Decisions

**Why an extension, not core?** Fleet coordination is deployment-specific. Most OpenClaw users run single-node. Making it an extension means zero overhead for single-node users and clean separation of fleet-specific logic.

**Why keep `fleet.json` as static config?** The fork's fleet.json has proven stable — node topology changes rarely (last change: decommissioning Old VPS on 2026-03-22). Dynamic discovery adds complexity without clear benefit for a 4-node fleet. The health monitor provides the dynamic layer on top.

**Why MCP tools instead of automatic routing?** Agents should be aware of fleet topology — they make better decisions when they can reason about where to run work. Automatic routing at the session level would hide this from the agent. The `fleet_recommendation` tool lets the agent ask "where should this run?" and get a reasoned answer, but the agent makes the final call.

---

## 2. Distributed Worker Architecture

### Current State (Fork)

`shared/task_worker.py` implements:
- `TaskPoller` — Polls Archon API for `todo`-status tasks every 30s, filters by `target_node` metadata field
- `TaskExecutor` — Full lifecycle: generate plan (via Claude LLM), execute steps in worktree, push branch, report to Archon and Telegram
- Main loop with `ThreadPoolExecutor(max_workers=MAX_WORKERS)`, graceful shutdown on SIGTERM/SIGINT
- Startup recovery: detects stale worktrees from crashes, marks orphaned tasks as failed
- Periodic stale worktree cleanup (hourly, 2-hour max age)

`shared/task_lock.py` implements:
- `claim_task()` — Redis SETNX with 10s TTL, re-reads task inside lock to verify still claimable, updates Archon status to `doing` with `claimed_by` metadata

`shared/worktree_manager.py` implements:
- `WorktreeManager` — Creates git worktrees at `/repo/worktrees/task-{id}`, pushes branches as `task/{id}`, cleans up on completion or stale timeout

### Upstream Design

**Extension:** `extensions/distributed-workers/`

This extension runs on every fleet node that executes tasks. It replaces the fork's Python `task_worker.py` with a TypeScript implementation that integrates with upstream's runtime.

#### Worker Lifecycle

```
Node boot → Worker extension loads → Connects to fleet-redis → Registers presence
         → Enters poll loop:
             1. Query task backend for pending tasks (status: todo)
             2. Filter tasks by target_node (this node or "any")
             3. For each claimable task:
                a. Attempt Redis SETNX claim lock (10s TTL)
                b. Re-read task to verify still todo
                c. Update task status to "doing", set claimed_by
                d. Submit to thread pool
             4. Wait POLL_INTERVAL (30s default)
         → On shutdown: drain thread pool, clean up worktrees
```

#### Components

1. **Task Poller** (`task-poller.ts`) — Polls the task backend (Archon API initially, potentially upstream's own task system later) for pending tasks. Configurable poll interval and task filtering.

2. **Claim Arbitrator** (`claim-arbitrator.ts`) — Redis-based distributed claim using SETNX pattern. Prevents race conditions when multiple workers poll simultaneously. Identical semantics to fork's `task_lock.py`:
   - SET key with NX (only if not exists) and EX (10s expiry)
   - Inside lock window: re-read task, verify status is still `todo`
   - Update task status to `doing` with `claimed_by = node_name`
   - Delete lock key (other workers can now proceed on other tasks)

3. **Task Executor** (`task-executor.ts`) — Executes a claimed task:
   - Phase 1 (Plan): Call LLM to generate execution plan from user request
   - Phase 2 (Execute): Create worktree, execute steps sequentially with retry (3 attempts), push branch
   - Phase 3 (Report): Mark task complete, notify user via Telegram, write vault report
   - On failure: mark task failed, notify user, clean up worktree

4. **Worktree Manager** (`worktree-manager.ts`) — Git worktree lifecycle:
   - `create(taskId)` — `git worktree add /repo/worktrees/task-{id} -b task/{id}`
   - `remove(taskId)` — `git worktree remove --force` + `git branch -D`
   - `pushBranch(taskId)` — `git push origin task/{id}`
   - `cleanupStale(maxAgeHours)` — Remove worktrees older than threshold
   - `listWorktrees()` — List current worktree task IDs

5. **Step Executor** (`step-executor.ts`) — Executes individual plan steps. Step types:
   - `ssh` — Shell command via subprocess (runs locally in worktree, not remote SSH)
   - `claude_code` — Invoke Claude Code CLI in worktree directory
   - `codex` — Invoke Codex CLI in worktree directory
   - `auto` — LLM decides which executor to use

### Key Decisions

**Each node runs its own gateway, or workers connect to central gateway?**

Each node runs its own OpenClaw process with the distributed-workers extension loaded. Workers execute locally — they do not SSH into other nodes to run code. The gateway node coordinates (assigns tasks, tracks status), but execution is local to each worker node. This matches the fork's current architecture where each node has its own `openclaw` container.

**Task backend: Archon API or upstream's own?**

Initially, keep Archon as the task backend. The `task-poller.ts` module abstracts the task API behind an interface so it can be swapped later if upstream develops its own task system. The Archon client is configured via `ARCHON_SERVER_URL` environment variable (always `http://100.69.32.10:8181`).

**Thread pool vs. process pool?**

Thread pool, matching the fork. Node.js worker threads for CPU isolation if needed. The fork uses Python's `ThreadPoolExecutor` and it works well — tasks are I/O-bound (LLM calls, git operations, SSH) not CPU-bound.

---

## 3. Fleet Redis Role

### Current Usage in Fork

Fleet Redis (redis:7.2-alpine on Kubuntu, port 6380, db=2) serves four purposes:

| Purpose | Redis Pattern | TTL | Module |
|---------|--------------|-----|--------|
| Agent heartbeats | `agent:{agent_id}` hash | 120s | `fleet_coord.py` |
| Distributed locks | `lock:{resource}` string (SETNX) | 300s | `fleet_coord.py` |
| Task claim locks | `task-claim:{task_id}` string (SETNX) | 10s | `task_lock.py` |
| Fleet node state | `fleet:{node_id}` hash | 120s (stale filter) | `fleet.py` |
| Pub/sub alerts | `fleet:alerts` channel | N/A | `fleet_coord.py` |

### What Stays as Fleet Redis

All of it. Fleet Redis serves a fundamentally different purpose than upstream's memory system:

- **Upstream memory** is per-session, per-agent context storage (conversation history, agent state). It is local to the gateway.
- **Fleet Redis** is cross-node coordination state (locks, heartbeats, presence). It must be accessible from all nodes over Tailscale.

There is no overlap. Fleet Redis stays as an external service on Kubuntu:6380/db=2.

### What Upstream Could Replace (Future)

If upstream ever adds a distributed coordination primitive (e.g., a shared state store for multi-gateway deployments), some fleet-redis functionality could migrate. But today, upstream has no such concept.

### Integration Design

**Shared module:** `extensions/shared/fleet-redis.ts`

- Lazy singleton Redis connection using `ioredis` (Node.js Redis client)
- Configuration via environment variables: `FLEET_REDIS_HOST`, `FLEET_REDIS_PORT`, `FLEET_REDIS_DB`
- Fail-open pattern: if Redis is unreachable, fleet coordination degrades gracefully (no locks acquired, heartbeats silently fail, task claims fall back to Archon-only)
- Connection reset on error with automatic reconnect
- Used by both `fleet-coordinator` and `distributed-workers` extensions

### Lock Categories (Ported from Fork)

| Lock Template | Use Case | Default TTL |
|--------------|----------|-------------|
| `{node}:docker` | Docker build/restart operations | 300s |
| `{node}:gpu` | GPU/CUDA workloads | 300s |
| `{node}:heavy-cpu` | Compilation, large builds | 300s |
| `{node}:deploy` | Deployment operations | 300s |
| `repo:{name}` | Git push/rebase | 300s |
| `{node}:art-pipeline` | HumbleForge GPU pipeline | 300s |
| `task-claim:{task_id}` | Task claim arbitration | 10s |

---

## 4. Task Routing Strategy

### Current Routing Table (Fork)

```
coding_project    → mac (fallback: kubuntu, pop-os)
automated_coding  → kubuntu (fallback: pop-os, mac)
docker_ops        → kubuntu (fallback: home, gateway)
web_deploy        → home (fallback: gateway)
gpu_work          → kubuntu (no fallback)
obsidian_ops      → pop-os (fallback: kubuntu)
vault_write       → pop-os (fallback: home, kubuntu)
youtube_data      → pop-os (no fallback)
art_pipeline      → kubuntu (no fallback)
3d_asset          → kubuntu (no fallback)
texture_gen       → kubuntu (no fallback)
image_gen         → kubuntu (no fallback)
```

**Note:** `home` (Old VPS) is decommissioned. Routes with `home` as primary or fallback must be updated in the migrated `fleet.json` — this is a Sub-Project 2 concern.

### Upstream Routing Design

Task routing is an MCP tool (`fleet_recommendation`) exposed by the fleet-coordinator extension, not automatic middleware. The agent calls it when deciding where to dispatch work.

The routing algorithm (ported from `get_recommendation()` and `get_task_node()`):

1. **Explicit node override** — If the task specifies a target node, use it
2. **Hot model check** — For GPU tasks: if the requested model is already loaded on a node's Ollama, prefer that node (avoids cold-start latency)
3. **VRAM fit check** — For GPU tasks with a model: find node with enough free VRAM, prefer the one with most free VRAM
4. **CPU load check** — For CPU-bound tasks: find node with lowest 1-minute load average and at least 2GB free RAM
5. **Schedule preference** — Deprioritize nodes outside their preferred hours (Mac outside 23:00-06:00 CST)
6. **Task type primary/fallback** — Use the routing table from `fleet.json` as the final tiebreaker
7. **Deferrable tasks** — If all candidates are busy and task is deferrable, recommend waiting 30s
8. **Cloud fallback** — If all candidates are busy and task is immediate, recommend cloud API

The routing response includes:
- `node`: recommended node ID (or `"cloud"` for API fallback)
- `confidence`: `"preferred"` | `"fallback"` | `"last_resort"`
- `reason`: human-readable explanation
- `waitSeconds`: deferral recommendation (null if immediate)

### ACP Integration Possibility

Upstream's ACP supports agent-scoped session keys (`agent:main:main`, `agent:design:main`). A future enhancement could map fleet nodes to ACP agent scopes, allowing the gateway to route ACP sessions to remote nodes. This is out of scope for the initial port but noted as a natural evolution point.

The bridge would look like:
- ACP session `agent:kubuntu-worker:task-123` routes to the Kubuntu node's gateway
- The gateway on Kubuntu picks up the session and executes locally
- Results flow back through ACP to the originating gateway

This requires each node to run its own gateway (which is already the plan) and a session-routing layer in the gateway that forwards ACP sessions based on node prefix. Not trivial, but architecturally clean.

---

## 5. Worker Execution Model

### How Workers Execute Tasks

Each worker node runs its own OpenClaw gateway process with the `distributed-workers` extension. The execution model is fully local:

```
Gateway (coordinator)                   Worker Node (executor)
=====================                   ====================
Archon DB has task                      Worker polls Archon
  status: todo                          Sees task, claims via Redis
  target_node: kubuntu                  Creates git worktree locally
                                        Generates plan via LLM
                                        Executes steps in worktree
                                        Pushes branch to origin
                                        Updates task status in Archon
                                        Cleans up worktree
```

Workers never SSH into other nodes to execute code. The fleet-guard hook prevents workers from doing destructive operations on remote nodes, but the normal execution path is entirely local.

### Worker Configuration

Per-node configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_NODE_NAME` | `unknown` | This node's fleet ID (e.g., `kubuntu`) |
| `WORKER_MAX_THREADS` | `4` | Max concurrent task threads |
| `WORKER_POLL_INTERVAL` | `30` | Seconds between task polls |
| `WORKTREE_BASE_DIR` | `/repo/worktrees` | Where git worktrees are created |
| `WORKTREE_REPO_DIR` | `/repo` | Git repo root for worktree operations |
| `ARCHON_SERVER_URL` | `http://100.69.32.10:8181` | Archon API endpoint |
| `ARCHON_PROJECT_ID` | (required) | Project ID for task queries |

### Worker Capacity Plan

| Node | MAX_THREADS | Rationale |
|------|-------------|-----------|
| Gateway | 2 | Limited RAM (16GB), primary role is web/coordination |
| Kubuntu | 4 | 64GB RAM, 24 cores, GPU — heaviest worker |
| Pop!_OS | 4 | 32GB RAM, 8 cores — utility workloads |
| Mac | 0 (not a worker) | Dev workstation, tasks routed here only during off-hours via scheduling |

Mac does not run the distributed-workers extension. Tasks routed to Mac are dispatched via SSH from the gateway (matching the fork's behavior where Mac is a `coding_project` target but not a worker node).

---

## 6. Git Worktree Isolation

### Design

Each task gets its own git worktree, providing:
- **Filesystem isolation** — Concurrent tasks cannot interfere with each other's file changes
- **Branch isolation** — Each task works on `task/{task_id}` branch, pushed independently
- **Clean rollback** — If a task fails, `git worktree remove --force` discards all changes

### Worktree Lifecycle

```
create(taskId):
  git worktree add /repo/worktrees/task-{taskId} -b task/{taskId}
  → returns /repo/worktrees/task-{taskId}

execute steps in worktree...

pushBranch(taskId):
  cd /repo/worktrees/task-{taskId}
  git push origin task/{taskId}

remove(taskId):
  git worktree remove /repo/worktrees/task-{taskId} --force
  git branch -D task/{taskId}
```

### Stale Worktree Recovery

On worker startup:
1. List all directories in `WORKTREE_BASE_DIR` matching `task-*`
2. For each: check if the corresponding Archon task is still `doing`
3. If task is stale (status is `doing` but worktree exists from a previous crash), mark task as `failed` with crash recovery metadata
4. Remove the stale worktree

Periodic cleanup (every hour):
- Remove worktrees older than 2 hours regardless of task status
- Log each removal as a warning event

### Constraints

- Worktree base directory must be on the same filesystem as the git repo (git limitation)
- The Docker volume mount separates `/app` (OpenClaw code from image) from `/repo` (git repo for worktree ops) — this must be preserved in the upstream containerization
- Maximum concurrent worktrees per node = `WORKER_MAX_THREADS` (enforced by thread pool, not worktree manager)

---

## 7. Fleet Guard Hooks

### Current Hook (Fork)

`.claude/hooks/fleet-guard.sh` is a PreToolUse hook that:

1. **Hard blocks** (exit 1):
   - Destructive Docker: `docker rm -f`, `docker rmi`, `docker system prune`, `docker volume rm`
   - Force push: `git push --force` or `git push -f`
   - Catastrophic delete: `rm -rf /` or `rm -rf ~`
   - Docker lock conflict: if another agent holds the `{node}:docker` lock in Redis

2. **Warnings** (stderr, exit 0):
   - Active agents on target node (queries Redis `agent:*` keys)
   - High load on target node (>20 load average)

3. **Coordination** (transparent):
   - Auto-acquires Docker lock when running docker compose/build/stop/restart
   - Fail-open: if Redis is unreachable, allows all operations with a warning

### Upstream Hook Design

Upstream OpenClaw uses git-hooks (`git-hooks/pre-commit`) for repository hooks. For agent runtime hooks (PreToolUse), the upstream system uses the plugin SDK's hook registration.

The fleet-coordinator extension registers a PreToolUse hook that ports fleet-guard.sh logic:

```
extensions/fleet-coordinator/hooks/fleet-guard.ts
```

**Hook registration** via `openclaw.plugin.json`:
```json
{
  "hooks": {
    "PreToolUse": ["./hooks/fleet-guard.ts"]
  }
}
```

**Ported logic:**

| Check | Action | Redis Required |
|-------|--------|----------------|
| Destructive Docker ops | Block (exit 1) | No |
| Force push | Block (exit 1) | No |
| Catastrophic rm | Block (exit 1) | No |
| Docker lock held by other agent | Block (exit 1) | Yes (fail-open) |
| Active agents on target node | Warn (stderr) | Yes (fail-open) |
| High load on target node | Warn (stderr) | No (SSH probe) |
| Docker compose/build/stop | Auto-acquire lock | Yes (fail-open) |

**Post-operation cleanup** (PostToolUse hook):
- Release Docker locks acquired during PreToolUse
- Port of `.claude/hooks/fleet-release.sh`

### Fail-Open Philosophy

All Redis-dependent checks fail open. If Redis is unreachable, the hook logs a warning and allows the operation. This prevents Redis outages from blocking all fleet operations. The hard blocks (destructive Docker, force push, catastrophic rm) do not depend on Redis and always fire.

---

## 8. Health Monitoring

### Current State (Fork)

`fleet.py` provides `all_health()` which iterates all nodes and services, checking:
- **HTTP services**: GET to health endpoint, status < 400 or 401/403 = healthy
- **TCP services**: Socket connection test (Redis, FalkorDB)
- **Container services**: SSH exec of health command inside container

Results are consumed by:
- Telegram bot `fleet_health` tool (user-facing)
- Fleet recommendation engine (for node selection)
- AOP dashboard (Control UI)

### Upstream Design

The fleet-coordinator extension runs a `HealthMonitor` background service:

1. **Periodic full scan** — Every 60s, check all services on all nodes. Cache results.
2. **On-demand check** — `fleet_health` MCP tool triggers immediate re-check.
3. **Status endpoint** — Extend upstream's `/status` API to include fleet health summary.
4. **Event emission** — Publish health state changes as events for the observability pipeline (AOP).

**Health check types** (ported from fork):

| Type | Method | Timeout |
|------|--------|---------|
| HTTP | GET health endpoint | 5s |
| TCP | Socket connect | 5s |
| Container | SSH exec health_cmd | 10s |
| Node reachability | TCP connect to port 22 | 3s |

**Degradation signals:**
- Node unreachable → remove from task routing candidates
- Service unhealthy → exclude from capability-based lookups
- All services on a node unhealthy → mark node as degraded in fleet state

**Integration with fleet-redis:**
- Health results are published to `fleet:{node_id}` Redis hash (same schema as fork's `get_fleet_state()`)
- Other nodes can read fleet state from Redis for distributed awareness
- Stale entries (>120s old) are filtered out by readers

---

## 9. Node Scheduling

### Current State (Fork)

`fleet.json` defines scheduling windows:
- Mac: available hours 23, 0-6 CST (user active 7am-11pm)
- All other nodes: always available

`fleet.py` provides:
- `is_node_available(node_id)` — Always returns True (nodes are never hard-blocked)
- `is_node_preferred(node_id)` — Returns False for Mac during 7am-11pm CST
- `get_task_node(task_type, explicit_node)` — Skips deprioritized nodes, falls through to fallback

### Upstream Design

Scheduling is part of the fleet-coordinator extension's routing logic, not a separate system.

**Schedule enforcement:**
- `fleet_recommendation` tool checks scheduling windows before recommending a node
- Deprioritized nodes are still selectable if explicitly requested or if no other node can handle the task type
- The agent sees the scheduling constraint in the recommendation reason (e.g., "Mac deprioritized: user active hours")

**Configuration** stays in `fleet.json` under the `scheduling` key, same schema as the fork.

**Timezone handling:** Uses `Intl.DateTimeFormat` with `America/Chicago` timezone (upstream is TypeScript/Node.js, so no Python `zoneinfo` needed).

---

## 10. Extension File Structure

```
extensions/
  fleet-coordinator/
    openclaw.plugin.json       # Extension manifest
    package.json               # Dependencies (ioredis, node-ssh)
    index.ts                   # Extension entry point, registers tools and hooks
    fleet-registry.ts          # Fleet.json loader, node/service/capability lookups
    health-monitor.ts          # Background health check service
    task-router.ts             # Routing algorithm (VRAM, load, schedule, fallback)
    service-lifecycle.ts       # On-demand service start/stop (HumbleForge etc.)
    hooks/
      fleet-guard.ts           # PreToolUse hook: block destructive ops, coordinate locks
      fleet-release.ts         # PostToolUse hook: release locks
    types.ts                   # Shared TypeScript types for fleet config schema

  distributed-workers/
    openclaw.plugin.json       # Extension manifest
    package.json               # Dependencies (ioredis)
    index.ts                   # Extension entry point, starts worker loop
    task-poller.ts             # Polls task backend for pending work
    claim-arbitrator.ts        # Redis SETNX claim locking
    task-executor.ts           # Full task lifecycle: plan → execute → report
    step-executor.ts           # Individual step execution (ssh, claude_code, codex)
    worktree-manager.ts        # Git worktree create/remove/push/cleanup
    types.ts                   # Task, Plan, Step type definitions

  shared/
    fleet-redis.ts             # Shared Redis client (lazy singleton, fail-open)
    ... (existing shared modules)
```

### Plugin Manifests

**fleet-coordinator/openclaw.plugin.json:**
```json
{
  "id": "fleet-coordinator",
  "name": "Fleet Coordinator",
  "description": "Multi-node fleet registry, health monitoring, task routing, and guard hooks.",
  "configSchema": {
    "type": "object",
    "properties": {
      "fleetConfigPath": {
        "type": "string",
        "description": "Path to fleet.json (default: config/fleet.json)"
      },
      "healthCheckIntervalMs": {
        "type": "number",
        "description": "Health check interval in ms (default: 60000)"
      }
    }
  }
}
```

**distributed-workers/openclaw.plugin.json:**
```json
{
  "id": "distributed-workers",
  "name": "Distributed Workers",
  "description": "Multi-node task execution with claim arbitration and worktree isolation.",
  "configSchema": {
    "type": "object",
    "properties": {
      "nodeName": { "type": "string" },
      "maxThreads": { "type": "number" },
      "pollIntervalMs": { "type": "number" },
      "worktreeBaseDir": { "type": "string" },
      "repoDir": { "type": "string" }
    }
  }
}
```

---

## 11. Dependencies on Sub-Projects 1 and 2

### Sub-Project 1: Extension SDK Bootstrap

Fleet coordination depends on:
- **Plugin SDK** — `openclaw.plugin.json` manifest schema, tool registration API, hook registration API
- **Runtime lifecycle** — Extension startup/shutdown hooks for health monitor and worker loop
- **Background services** — Ability to run long-lived background tasks (health monitor, task poller) within an extension

If the plugin SDK does not support background services at launch, the health monitor and task poller can run as separate processes (matching the fork's architecture where `task_worker.py` is a separate container entry point).

### Sub-Project 2: Config/Secrets Migration

Fleet coordination depends on:
- **`config/fleet.json`** — Must be migrated to the upstream repo with updated routes (remove `home` node references)
- **Environment variables** — `FLEET_REDIS_HOST`, `FLEET_REDIS_PORT`, `FLEET_REDIS_DB`, `WORKER_NODE_NAME`, `WORKER_MAX_THREADS`, `ARCHON_SERVER_URL`, `ARCHON_PROJECT_ID` must be in the migrated secrets/env system
- **SSH keys** — Fleet nodes need SSH access to each other for health checks and service lifecycle management. Key paths are in `fleet.json` SSH configs.

### Sub-Projects 4 and 5 (Downstream)

- **Sub-Project 4 (Observability)** — Consumes fleet health events, worker task events, and lock events for visualization
- **Sub-Project 5 (Agentic Loop)** — Uses `fleet_recommendation`, `fleet_ssh_exec`, and `fleet_service_start/stop` tools from the Telegram bot's agentic tool-calling loop

---

## Open Questions

1. **Worker on Mac:** The fork routes `coding_project` tasks to Mac during off-hours but Mac is not a worker node. Should Mac run the distributed-workers extension during its available window, or should the gateway SSH-dispatch to Mac? The fork uses SSH dispatch. Keeping SSH dispatch is simpler and avoids requiring OpenClaw to be always-running on the dev workstation.

2. **Archon as task backend:** The fork is tightly coupled to Archon for task management (create, list, update status). Should the distributed-workers extension abstract the task backend so it could use upstream's own task/workflow system if one emerges? Recommendation: yes, define a `TaskBackend` interface and implement `ArchonTaskBackend` as the initial concrete class.

3. **Fleet-redis failover:** Currently fleet-redis runs on a single Kubuntu instance with no replication. If Kubuntu goes down, all distributed coordination degrades to fail-open. Is this acceptable? For a 4-node fleet, yes — the blast radius is limited and fail-open is safe. Document this as a known limitation.

4. **Extension loading on non-worker nodes:** Should the distributed-workers extension be loaded on nodes that should not execute tasks (e.g., if Mac were running OpenClaw but should not be a worker)? Recommendation: make worker activation conditional on `WORKER_MAX_THREADS > 0` — if set to 0, the extension loads but the poll loop does not start.

5. **Hook system compatibility:** The fork's fleet-guard.sh is a bash script that reads JSON from stdin. Upstream's hook system may have a different interface (TypeScript function, different input format). The exact hook API depends on Sub-Project 1's plugin SDK design. The logic ports cleanly regardless of interface.
