# Observability Platform Migration — Design Spec

**Date:** 2026-03-25
**Status:** Draft
**Author:** Jeff + Claude
**Sub-Project:** 4 of 5 (Fleet Migration)

## Problem

The OpenClaw fork has a custom observability stack spread across five independent components:

1. **AOP Server** (`aop-server/`): Bun/TypeScript service (port 3010) with SQLite, receiving events from all fleet nodes. 25+ route files, 26+ DB modules, custom router.
2. **Event Shipper** (`Dockerfile.shipper`): Python daemon that tails `all.jsonl` and `cron-log.db` on each node, batches events, and ships them to AOP via HTTP.
3. **Hook Emitter** (`shared/observability/hook_emitter.py`): Claude Code hook handler that captures 7 hook event types (SessionStart/End, PreToolUse/PostToolUse, SubagentStart/Stop, UserPromptSubmit) and writes structured events.
4. **Web Outpost** (`web_outpost.py`): FastAPI service (port 8082) serving 50+ Python viz cards for analytics dashboards, vault viewer, and data visualization.
5. **Control UI** (`control-ui/`): Lit.js SPA at `/control/` for fleet monitoring, session trace inspection, and investigation triggers.

This stack was built before upstream OpenClaw had a plugin SDK, hook system, diagnostic events, or built-in Control UI. It now duplicates upstream capabilities while missing the standardization benefits of the plugin architecture.

**Specific pain points:**

- Hook emitter uses a custom schema (`hooks.v1`) that does not align with upstream's `PluginHookName` types (`session_start`, `before_tool_call`, `after_tool_call`, `subagent_spawned`, `subagent_ended`, etc.)
- Event shipper is a separate Python daemon per node — overhead that upstream's in-process diagnostic event system eliminates
- AOP Server's 26 DB modules and 25 route files represent significant maintenance surface area
- Control UI (Lit.js) duplicates upstream's React-based UI which already has gateway integration, session management, and usage tracking
- Web Outpost's 50+ viz cards are tightly coupled to the fork's event schema
- No OpenTelemetry integration despite upstream shipping `diagnostics-otel` extension

## Goal

Port the observability stack to upstream-compatible extensions that leverage the native plugin hook system, diagnostic event bus, and OpenTelemetry integration. Reduce the number of independent services from 5 to 2 (AOP Server + upstream UI), eliminate the event shipper entirely, and consolidate dashboards into upstream's Control UI with custom panels.

## Solution

A three-layer architecture:

1. **`extensions/observability-aop/`** — Upstream extension that subscribes to all plugin hooks and diagnostic events, then forwards them to the AOP Server. Replaces both the hook emitter and event shipper.
2. **AOP Server** — Kept as standalone Bun service but with a simplified schema aligned to upstream's event types. Drops the custom router for a standard HTTP framework.
3. **Upstream Control UI + custom panels** — Retire the Lit.js Control UI and Web Outpost. Port key viz cards as React components embedded in upstream's UI via the plugin panel system.

---

## 1. Event Architecture

### Current Flow (Fork)

```
Claude Code hooks → hook_emitter.py → hook-events.jsonl
                                              ↓
shared/logger.py → all.jsonl ──→ shipper.py ──→ AOP Server (:3010)
                                              ↑
cron-wrapper.sh → cron-log.db ──→ shipper.py ─┘
```

Three separate data paths, two file-based intermediaries, one daemon per node.

### Target Flow (Upstream)

```
Upstream plugin hooks ──→ observability-aop extension ──→ AOP Server (:3010)
       ↓                          ↑
diagnostic events ────────────────┘
       ↓
diagnostics-otel extension ──→ OTLP collector (optional)
```

Single in-process data path, no file intermediaries, no shipper daemon.

### Hook Mapping

The fork's hook emitter handles 7 Claude Code hook types. Upstream provides 25+ plugin hook names that are a superset. The mapping:

| Fork Event | Upstream Hook | Notes |
|---|---|---|
| `SessionStart` → `session.start` | `session_start` | Direct equivalent. Upstream provides `PluginHookSessionStartEvent` with `agentId`, `sessionKey`, `sessionId`, `workspaceDir`, `trigger`, `channelId`. |
| `SessionEnd` → `session.end` | `session_end` | Direct equivalent. Upstream provides `PluginHookSessionEndEvent`. |
| `PreToolUse` → `tool.call.before` | `before_tool_call` | Upstream provides `PluginHookBeforeToolCallEvent` with tool name, args, and context. |
| `PostToolUse` → `tool.call.after` | `after_tool_call` | Upstream provides `PluginHookAfterToolCallEvent` with result data. |
| `SubagentStart` → `subagent.start` | `subagent_spawned` | Upstream splits this into `subagent_spawning` (before) and `subagent_spawned` (after). |
| `SubagentStop` → `subagent.stop` | `subagent_ended` | Direct equivalent. |
| `UserPromptSubmit` → `user.prompt.received` | `message_received` | Upstream `message_received` is the closest analogue. |

**New hooks available in upstream (not captured by fork):**

- `before_model_resolve` — model routing decisions (replaces fork's model routing logger)
- `before_prompt_build` — prompt construction observability
- `llm_input` / `llm_output` — raw LLM request/response capture
- `before_compaction` / `after_compaction` — context window management events
- `gateway_start` / `gateway_stop` — gateway lifecycle
- `before_dispatch` — message dispatch decisions
- `subagent_spawning` / `subagent_delivery_target` — pre-spawn decisions

### Diagnostic Event Types

Upstream's `diagnostics-otel` extension already handles these event types via `onDiagnosticEvent`:

- `model.usage` — token counts, cost, duration, context window
- `webhook.received` / `webhook.processed` / `webhook.error`
- `message.queued` / `message.processed`
- `queue.lane.enqueue` / `queue.lane.dequeue`
- `session.state` / `session.stuck`
- `run.attempt`
- `diagnostic.heartbeat`

The observability-aop extension subscribes to the same event bus, so both OTLP export and AOP ingestion coexist.

### Event Schema Migration

**Fork schema** (from `shared/observability/schema.py`):

```
timestamp, event_type, source_node, source_service, success,
session_id, parent_session_id, archon_task_id, archon_project_id,
duration_ms, tokens_in, tokens_out, tokens_cache, cost_usd,
model_used, safety_tier, error, trace_id, span_id,
parent_span_id, span_name, service_name, payload, tags
```

**Target schema** (aligned to upstream concepts):

```
timestamp, event_type, source_node, channel_id,
session_key, session_id, agent_id, workspace_dir,
trigger, parent_session_id,
duration_ms, tokens_input, tokens_output, tokens_cache_read,
tokens_cache_write, cost_usd, model, provider,
success, error,
archon_task_id, archon_project_id,
payload, tags
```

Key changes:
- `source_service` → `channel_id` (upstream concept)
- Add `session_key` (upstream's stable session identifier, separate from ephemeral `session_id`)
- Add `agent_id`, `workspace_dir`, `trigger`, `provider` (from upstream hook context)
- `tokens_cache` splits into `tokens_cache_read` + `tokens_cache_write`
- Remove `trace_id`, `span_id`, `parent_span_id`, `span_name`, `service_name` — these belong in the OTLP layer via `diagnostics-otel`, not the AOP event store

---

## 2. AOP Server Strategy

**Decision: Keep as standalone Bun service.**

Rationale:
- AOP Server handles cross-node event aggregation — it receives events from Gateway, Kubuntu, Pop!_OS, and Mac. Upstream's gateway is per-node, not fleet-wide.
- SQLite is the right storage engine for this workload (append-heavy, read-moderate, single-writer). Upstream's gateway uses its own session store format.
- The AOP Server's investigation and analytics features (auto-trigger engine, recommendations, insights) are custom business logic that does not belong in upstream core.

**Changes needed:**

1. **Schema migration** — Update the `events` table to match the target schema above. Add migration script for existing data.
2. **Simplify ingestion** — The `/events` and `/events/batch` endpoints stay. Drop the `hooks.v1` schema validation (replaced by upstream-aligned schema).
3. **Drop shipper compatibility** — The shipper's `transform_log_event` and `transform_cron_row` functions are no longer needed. AOP receives events directly from the extension.
4. **Keep REST API** — The query endpoints (`/sessions`, `/events`, `/agents`, `/skills`, etc.) remain for dashboard consumption. Align response shapes with upstream's session/agent concepts where they overlap.
5. **Health endpoint** — Keep `/health`. Register with upstream's gateway health aggregation if available.

**What gets removed from AOP Server:**

- The `hooks.v1` event normalization layer (fork-specific)
- The `pending_spawns` correlation table (upstream's `subagent_spawning` → `subagent_spawned` → `subagent_ended` lifecycle gives us this natively)
- Custom router (`router.ts`) — replace with a lightweight framework or keep the custom router (it works fine; low priority)

---

## 3. Dashboard Strategy

### Web Outpost: Retire

The Web Outpost (`web_outpost.py`) serves two functions:

1. **Intelligence feed** — articles/vault viewer from `outpost.db`
2. **Analytics dashboards** — 50+ viz cards rendering platform telemetry

**Decision:** Split these concerns.

- **Intelligence feed**: Moves to a dedicated extension or stays as a standalone service. Not part of the observability migration. (Out of scope for this spec.)
- **Analytics dashboards**: Port to upstream Control UI as custom panels (see below).

### Control UI: Migrate to Upstream

The fork's Lit.js Control UI (`control-ui/`) provides:
- Fleet node status grid
- Session list with filtering
- Session detail with event timeline
- Investigation triggers (Phase 3, not yet implemented)
- Pending: Gantt/waterfall session timeline

Upstream's React-based Control UI already provides:
- Gateway connection management
- Session/chat management
- Usage tracking (tokens, cost)
- Cron job management
- Model selection
- Settings/config UI

**Decision:** Adopt upstream's Control UI. Port the fork-specific panels as custom React components injected via upstream's UI extension points.

**Panels to port:**

| Fork Panel | Priority | Strategy |
|---|---|---|
| Fleet node status grid | P0 | New panel — upstream has no fleet concept |
| Session event timeline | P0 | Enhance upstream's session view with AOP event data |
| Session Gantt/waterfall | P1 | New panel — the pending feature from the fork |
| Investigation triggers | P2 | New panel — was Phase 3 in fork, not yet implemented |

---

## 4. Analytics Cards Migration

The fork has 50+ viz cards in `shared/analytics/viz_cards/`. These are Python functions that query the AOP SQLite DB and return HTML/JS chart snippets (Chart.js, D3, vanilla SVG).

### Tiering

**Tier 1 — Port as upstream UI panels (React + fetch from AOP API):**

- `session_timeline.py` — Session activity over time
- `model_routing.py` — Model selection distribution
- `task_routing.py` — Task assignment patterns
- `fleet_map.py` — Node status topology
- `active_sessions.py` — Live session grid
- `cron_status.py` — Cron job health
- `tool_usage.py` — Tool call frequency/duration
- `error_timeline.py` — Error rate trends

**Tier 2 — Keep as AOP Server API endpoints, render in UI panels:**

- `trace_waterfall.py` — Trace visualization (complex rendering)
- `trace_sankey.py` — Event flow diagrams
- `session_galaxy.py` — Session relationship graph
- `tool_chord.py` — Tool co-occurrence chord diagram
- `entity_network.py` — Knowledge entity graph

**Tier 3 — Defer or drop:**

- `archon_activity.py`, `archon_tasks.py`, `archon_throughput.py` — Archon-specific; keep as AOP API but no UI priority
- `platform_sunburst.py`, `platform_reflections.py` — Experimental/aspirational
- `feed_health.py`, `source_treemap.py`, `ingestion_timeline.py` — Web Outpost intelligence feed specific (out of scope)
- Remaining cards — evaluate after Tier 1+2 are operational

### Rendering Strategy

The fork's viz cards render server-side HTML with embedded Chart.js/D3. In the upstream UI:

- **Data**: AOP Server exposes JSON API endpoints. No server-side HTML rendering.
- **Charts**: Use upstream's existing charting dependencies or add a lightweight library (e.g., `recharts` which is already common in React ecosystems).
- **Layout**: Register panels via upstream's UI plugin system. Each panel fetches data from AOP API and renders client-side.

---

## 5. Session Tracing

### Current State

The fork's session tracing works through:
1. Hook emitter captures tool calls and subagent events
2. Shipper forwards to AOP
3. AOP correlates events by `session_id` and `parent_session_id`
4. Control UI renders timeline and event detail views

### Target State

Upstream provides two powerful tracing primitives:

1. **`runtime.events.onAgentEvent`** — Subscribes to all agent lifecycle events (model calls, tool use, errors, completions). This is richer than the fork's hook emitter.
2. **`runtime.events.onSessionTranscriptUpdate`** — Fires on every transcript mutation with `sessionFile`, `sessionKey`, `message`, `messageId`.

The observability-aop extension subscribes to both:

- `onAgentEvent` captures the high-level flow (what the agent did)
- `onSessionTranscriptUpdate` captures the content flow (what was said)
- Plugin hooks (`before_tool_call`, `after_tool_call`, etc.) capture the detail (tool inputs/outputs, model decisions)

Together, these three streams give deeper tracing than the fork's hook emitter alone.

### Session Correlation

Upstream uses two identifiers:
- `sessionKey` — Stable across resets/resumes. Use for long-term session tracking.
- `sessionId` — Ephemeral, regenerated on `/new` and `/reset`. Use for per-conversation isolation.

The fork uses only `session_id`. The migration must:
1. Map the fork's `session_id` to upstream's `sessionId`
2. Add `sessionKey` as a new dimension in the AOP schema
3. Update session list/detail views to group by `sessionKey` with `sessionId` as sub-sessions

### Subagent Tracing

The fork tracks subagent spawns via a `pending_spawns` table that correlates `Task` tool calls with `SubagentStop` events. Upstream provides a cleaner model:

- `subagent_spawning` → fired before spawn, includes spawn config
- `subagent_spawned` → fired after spawn, includes child session identity
- `subagent_delivery_target` → routing decision
- `subagent_ended` → completion with result

This eliminates the need for the `pending_spawns` correlation table entirely.

---

## 6. Cron Monitoring Integration

### Current State

The fork uses `scripts/cron-wrapper.sh` which logs to `data/cron-log.db` (SQLite). The shipper polls this DB and forwards events to AOP. Cron status is visualized via `cron_status.py` viz card.

### Upstream Cron System

Upstream has a full cron service (`src/cron/service.ts`) with:
- Job scheduling with `schedule.ts` and `stagger.ts`
- Run logging via `run-log.ts`
- Session reaper (`session-reaper.ts`)
- Heartbeat policy (`heartbeat-policy.ts`)
- Store persistence (`store.ts`) with migrations

### Integration Strategy

**Decision:** Adopt upstream's cron system as the primary scheduler. Port custom cron jobs as upstream cron job definitions.

The observability-aop extension captures cron events through:
1. Plugin hooks — `gateway_start`/`gateway_stop` bracket the cron service lifecycle
2. Diagnostic events — `diagnostic.heartbeat` includes queue depth
3. Direct subscription — if upstream exposes cron run events on the diagnostic bus (needs verification), subscribe there

For cron jobs that cannot migrate to upstream's scheduler (e.g., shell scripts that run outside the Node.js process), keep `cron-wrapper.sh` but have it POST directly to the AOP Server instead of writing to SQLite. This eliminates the shipper dependency.

**Migration path:**
1. Identify which fork cron jobs have upstream equivalents (likely: session reaper, heartbeat)
2. Port remaining jobs as upstream cron definitions
3. For un-portable jobs, add a `curl` POST to `cron-wrapper.sh` that hits `AOP_URL/events`
4. Drop `cron-log.db` polling from shipper (shipper itself is being eliminated)

---

## 7. Extension File Structure

```
extensions/observability-aop/
  index.ts                    # Plugin entry — definePluginEntry
  package.json                # Dependencies: none beyond openclaw/plugin-sdk
  openclaw.plugin.json        # Plugin manifest
  src/
    service.ts                # Main service — subscribes to hooks + diagnostic events
    aop-client.ts             # HTTP client for AOP Server communication
    event-mapper.ts           # Maps upstream events to AOP schema
    config.ts                 # Extension configuration (AOP URL, node name, batch settings)
    types.ts                  # Shared types
  test/
    service.test.ts
    event-mapper.test.ts
```

### Extension Registration

```typescript
// index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createObservabilityAopService } from "./src/service.js";

export default definePluginEntry({
  id: "observability-aop",
  name: "AOP Observability",
  description: "Ships hook events and diagnostics to AOP Server",
  register(api) {
    api.registerService(createObservabilityAopService());
  },
});
```

### Service Lifecycle

The service:
1. On `start(ctx)` — reads config (AOP URL, node name, batch interval), subscribes to all plugin hooks via `api.on(...)`, subscribes to `runtime.events.onAgentEvent` and `runtime.events.onSessionTranscriptUpdate` via the plugin runtime, subscribes to diagnostic events via `onDiagnosticEvent`.
2. On each event — maps to AOP schema via `event-mapper.ts`, adds to batch buffer.
3. On flush interval (default 5s) — ships batch to `AOP_URL/events/batch`. On failure, buffers locally (in-memory ring buffer, not file).
4. On `stop()` — flushes remaining buffer, unsubscribes from all listeners.

### Configuration

Extension config lives in the OpenClaw config file under `extensions.observability-aop`:

```yaml
extensions:
  observability-aop:
    enabled: true
    aopUrl: "http://100.69.32.10:3010"
    nodeName: "gateway"      # or kubuntu, pop_os, mac
    batchIntervalMs: 5000
    batchSize: 100
    bufferMaxSize: 10000     # in-memory ring buffer limit
    captureToolOutput: true  # include truncated tool output in events
    captureTranscripts: false # include transcript updates (verbose)
```

---

## 8. OpenTelemetry Strategy

**Decision:** Adopt `diagnostics-otel` extension alongside `observability-aop`.

The two extensions serve different purposes:
- `diagnostics-otel` → Exports metrics, traces, and logs to an OTLP-compatible backend (Grafana, Jaeger, etc.) for standard observability tooling.
- `observability-aop` → Ships structured events to AOP Server for custom fleet analytics, session tracing, and the investigation system.

They coexist on the same diagnostic event bus without conflict. The `diagnostics-otel` extension handles the "industry standard" observability path while `observability-aop` handles the "custom fleet intelligence" path.

**Phase 1:** Deploy `observability-aop` only (matches current fork capability).
**Phase 2:** Add `diagnostics-otel` pointing to a Grafana/Loki/Tempo stack on Gateway. This gives us standard dashboards for free.

---

## 9. Dependencies on Sub-Projects 1, 2, 3

### Sub-Project 1: Plugin SDK Migration

**Hard dependency.** The observability-aop extension uses `definePluginEntry`, `api.registerService`, and `api.on(hookName, handler)` from the plugin SDK. This must be complete before the extension can be built.

Specifically needed:
- Plugin entry registration
- Service lifecycle (`start`/`stop`)
- Hook subscription (`api.on` for all `PluginHookName` types)
- Access to `runtime.events.onAgentEvent` and `runtime.events.onSessionTranscriptUpdate`
- Access to `onDiagnosticEvent` from the diagnostics SDK

### Sub-Project 2: Fleet Coordination Migration

**Soft dependency.** The `nodeName` config value in the extension comes from the fleet identity system. If Sub-Project 2 provides a `runtime.fleet.nodeId` or equivalent, use that. Otherwise, fall back to an explicit config value.

The AOP Server's fleet status endpoints also depend on fleet coordination being in place for accurate node health reporting.

### Sub-Project 3: Task/Agent Migration

**Soft dependency.** The `archon_task_id` and `archon_project_id` fields in the event schema come from the Archon integration. If Sub-Project 3 migrates task tracking to a new system, the AOP schema must be updated to match.

Session tracing views in the UI need to understand the agent/task hierarchy that Sub-Project 3 defines.

---

## 10. Migration Plan

### Phase 1: Extension + Schema (Week 1)

1. Create `extensions/observability-aop/` with service skeleton
2. Implement `event-mapper.ts` with hook-to-schema mapping
3. Implement `aop-client.ts` with batch shipping and retry
4. Update AOP Server schema (migration script for existing SQLite data)
5. Deploy extension to Mac (dev node) alongside existing shipper
6. Verify event parity between shipper and extension

### Phase 2: Eliminate Shipper (Week 2)

1. Deploy extension to all fleet nodes
2. Run dual-write (extension + shipper) for 48 hours
3. Validate event completeness via AOP analytics
4. Disable shipper on each node
5. Remove `Dockerfile.shipper`, `shared/observability/shipper.py`, `shared/observability/hook_emitter.py`

### Phase 3: Dashboard Migration (Weeks 3-4)

1. Port Tier 1 viz cards as React panels for upstream UI
2. Wire panels to AOP Server JSON API
3. Implement fleet status panel
4. Implement session Gantt/waterfall timeline
5. Retire Web Outpost analytics routes (keep intelligence feed if still needed)
6. Retire Lit.js Control UI

### Phase 4: Advanced Features (Week 5+)

1. Port investigation triggers to upstream UI
2. Enable `diagnostics-otel` extension
3. Add cron monitoring integration
4. Implement auto-trigger engine as upstream cron job

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Upstream hook coverage gaps — some fork events may not have upstream equivalents | Lost telemetry for specific operations | Map all fork events before starting. For gaps, use `onAgentEvent` as a catch-all. |
| AOP Server schema migration breaks existing analytics | Dashboard downtime | Run side-by-side tables during migration. Old schema readable, new schema writable. |
| Upstream UI extension points insufficient for custom panels | Cannot embed fleet-specific views | Fall back to standalone React app at `/control/` served by AOP Server, with links from upstream UI. |
| Event volume increase from richer upstream hooks | AOP Server storage/performance | Add sampling config to extension. Capture `llm_input`/`llm_output` only when explicitly enabled. |
| Dual-write period causes duplicate events | Inflated analytics | Dedup by event hash (already implemented in `schema.py`). |

---

## 12. What Gets Deleted

After migration completes, these fork-specific files are removed:

- `shared/observability/hook_emitter.py` — Replaced by extension hook subscriptions
- `shared/observability/shipper.py` — Replaced by extension's direct AOP client
- `shared/observability/schema.py` — Schema logic moves to `event-mapper.ts` in extension
- `shared/observability/telemetry.py` — Upstream diagnostic events replace this
- `Dockerfile.shipper` — No shipper service needed
- `control-ui/` — Entire directory (Lit.js SPA replaced by upstream UI)
- `shared/analytics/viz_cards/*.py` — Python viz cards replaced by React panels (Tier 1) or AOP API endpoints (Tier 2)

**Kept (modified):**
- `aop-server/` — Schema updated, ingestion simplified, routes maintained
- `web_outpost.py` — Intelligence feed portion only (analytics routes removed)
