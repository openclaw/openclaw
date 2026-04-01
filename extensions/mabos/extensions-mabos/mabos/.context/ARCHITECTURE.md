# MABOS Extension — Architecture

## Overview

MABOS is an OpenClaw plugin (99 tools, 21 modules) that implements a BDI-based multi-agent business operating system. It registers tools via the OpenClaw plugin SDK, serves a React dashboard via HTTP routes, and optionally syncs to a TypeDB knowledge graph.

## Tool Factory Pattern

Each module exports a `create*Tools(api: OpenClawPluginApi)` function that returns an array of `AnyAgentTool`. The plugin entry point (`index.ts`) iterates all 21 factories, calling `api.registerTool()` for each tool.

```
index.ts
  └─ for factory of [createBdiTools, createPlanningTools, ...]
       └─ factory(api) → AnyAgentTool[]
            └─ api.registerTool(tool)
```

Shared helpers (`src/tools/common.ts`):

- `httpRequest()` — HTTP client with timeout and retry
- `textResult()` — Wraps text in `AgentToolResult` format
- `resolveWorkspaceDir()` — Gets workspace path from plugin config

## HTTP Route Registration

Two methods are used:

1. **`api.registerHttpRoute({ path, handler })`** — Exact path matching for fixed routes
2. **`registerParamRoute(pattern, handler)`** — Regex-based matching for parameterized routes (`:id` segments)

All responses use `Content-Type: application/json`. Error responses follow `{ error: string }`.

### Key Endpoints

| Method | Path                               | Response Shape                                                                                                    |
| ------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/mabos/api/status`                | `{ product, version, bdiHeartbeat, bdiIntervalMinutes, agents, businessCount, workspaceDir, reasoningToolCount }` |
| GET    | `/mabos/api/decisions`             | `{ decisions: Decision[] }`                                                                                       |
| GET    | `/mabos/api/businesses`            | `{ businesses: Business[] }`                                                                                      |
| GET    | `/mabos/api/contractors`           | `{ contractors: Contractor[] }`                                                                                   |
| GET    | `/mabos/api/businesses/:id/tasks`  | `{ tasks: Task[] }`                                                                                               |
| GET    | `/mabos/api/businesses/:id/agents` | `{ agents: AgentListItem[] }`                                                                                     |
| GET    | `/mabos/api/businesses/:id/goals`  | `TroposGoalModel` (unwrapped)                                                                                     |
| GET    | `/mabos/api/metrics/:business`     | `{ business, metrics }`                                                                                           |

## BDI Heartbeat Lifecycle

1. On plugin init, a `setInterval` is created at `bdiIntervalMinutes` (default 30)
2. Each tick dynamically imports the BDI runtime (`bdi-runtime.mjs`) from the workspace
3. `discoverAgents()` finds all agent directories
4. For each agent: `readAgentCognitiveState()` → `runMaintenanceCycle()`
5. Errors are logged but do not stop the heartbeat
6. `/mabos/api/status` reports `bdiHeartbeat: "active"` when the interval is running

## TypeDB Fallback

TypeDB integration is **best-effort**:

- `getTypeDBClient()` returns a shared client instance (singleton)
- `.connect()` is called on init; failures are silently caught
- Rule engine write-through: creates rules in TypeDB after local JSON write
- SBVR sync: pushes schema to TypeDB; falls back to local `sbvr-export.json`
- `isAvailable()` can be used to check connection state before queries

## File-Based Storage

All state is stored as JSON/Markdown in the workspace directory:

```
{workspace}/
  businesses/
    {business_id}/
      manifest.json           # Business metadata
      decision-queue.json     # Pending decisions
      metrics.json            # KPI data points
      agents/
        {agent_id}/
          config.json         # Agent config (autonomy, thresholds)
          Persona.md          # 10 cognitive files
          Beliefs.md
          Desires.md
          Goals.md
          Intentions.md
          Plans.md
          Capabilities.md
          Memory.md
          Cases.md
          Playbook.md
          inbox.json          # ACL message inbox
          cases.json          # CBR case base
          facts.json          # SPO triple store
          rules.json          # Rule engine rules
  contractors.json            # Global contractor pool
  channels/                   # Communication channel configs
```
