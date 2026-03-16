---
summary: "Concrete OpenClaw code touchpoint map for implementing the ACP node-backed runtime, covering ACP control plane, gateway/node transport, node-host worker execution, config, diagnostics, tests, and a recommended first slice"
title: "ACP Node Runtime Touchpoint Map"
---

# ACP Node Runtime Touchpoint Map

## Scope

This map is based on:

- `docs/experiments/plans/acp-node-runtime-program.md`
- `docs/experiments/plans/acp-node-backed-runtime.md`
- `docs/experiments/plans/acp-node-backed-runtime-protocol.md`
- `docs/experiments/plans/acp-node-backed-runtime-verification.md`

and the current TypeScript implementation on `main`.

The goal here is not to restate the architecture docs. The goal is to answer:

- which existing files are the real implementation seams
- what each seam currently does
- what each seam would need for `acp-node`
- which new modules are missing entirely today
- where the risky migrations are
- what the best first implementation slice is

## Current-State Reality

Three current code facts dominate the implementation plan:

1. ACP runtime state is not durable today.
   - `src/acp/control-plane/manager.core.ts` manages live runtime handles, active turns, and session state.
   - `src/acp/runtime/session-meta.ts` persists only `SessionEntry.acp` inside the generic session JSON store.
   - There is no dedicated ACP store for runs, event logs, checkpoints, idempotency, or leases.

2. ACP delivery is live-streamed directly from the backend, not replayed from gateway-owned state.
   - `src/auto-reply/reply/dispatch-acp.ts` calls `AcpSessionManager.runTurn(...)` and forwards events straight into `src/auto-reply/reply/acp-projector.ts`.
   - That means there is no current durable projector/checkpoint boundary.

3. Node transport is generic and best-effort.
   - `src/gateway/node-registry.ts` only knows request/response `node.invoke`.
   - `src/gateway/server-methods/nodes.ts` treats `node.event` as a generic event ingress.
   - `src/node-host/invoke.ts` emits `node.event` best-effort and only supports `system.*` and browser commands today.

Those three facts mean the planned architecture cannot land as a narrow patch. The gateway-side ACP store and state machine are the real foundation.

## Recommendation On Ownership

Based on the current code layout, `acp-node` should be core-owned, not plugin-owned.

Why:

- ACP store, lease fencing, node selection, `node.invoke`, and `node.event` handling all live in core already.
- The plugin seam today is good for runtime adapters like `acpx`, but the node-backed design needs deep changes in gateway control-plane, gateway WS handlers, and node-host code.
- Keeping `acp-node` in core avoids expanding the plugin SDK just to reach core-only transport/state seams.

## Exact Touchpoints

### 1. ACP runtime abstractions and control-plane core

| File | Current role | What `acp-node` needs here |
| --- | --- | --- |
| `src/acp/runtime/types.ts` | Defines the backend contract: `ensureSession`, `runTurn`, `cancel`, `close`, optional status/capabilities/doctor, and opaque runtime handles. | Keep the backend seam, but decide how much node/lease/run metadata belongs in `AcpRuntimeHandle` or `AcpRuntimeStatus`. Current contract assumes a live async event stream is the backend truth; `acp-node` needs that stream to be gateway-persisted before projection. |
| `src/acp/runtime/registry.ts` | Global backend registry with healthy-backend fallback. | Register a core `acp-node` backend here. Likely small change only. |
| `src/acp/control-plane/manager.core.ts` | The main ACP coordinator. Caches runtime handles in memory, serializes per-session actions, mutates `SessionEntry.acp`, tracks active turns, and calls backend methods directly. | This is the biggest refactor. It needs to stop treating live runtime state as authoritative and instead orchestrate durable ACP sessions, runs, events, checkpoints, leases, recovery state, and canonical terminal resolution. It also needs node selection + lease acquisition + worker event append paths. |
| `src/acp/control-plane/manager.types.ts` | Defines manager inputs/deps and currently injects only session-meta and runtime-registry seams. | Expand deps to include the new ACP store, lease manager, node selector, projector/checkpoint writer, clock/id sources, and recovery/replay helpers. |
| `src/acp/control-plane/manager.types.ts` + `src/acp/control-plane/manager.core.ts` | The manager only passes `sessionKey`, `agent`, `mode`, and `cwd` into `runtime.ensureSession(...)`, even though the runtime contract already has an optional `env` field. | If `acp-node` needs per-session bootstrap env or lease-scoped environment material, the manager API must grow; the runtime seam alone is not enough today. |
| `src/acp/control-plane/manager.runtime-controls.ts` | Applies `session/set_mode` and `session/set_config_option` to the live runtime handle. | Keep this seam, but make it work through lease-bound node control commands when the backend is `acp-node`. Control failures also need durable state consequences. |
| `src/acp/control-plane/runtime-cache.ts` | In-memory cache of backend handles. | Still useful as an execution-handle cache, but it must stop being mistaken for session/run authority. It may need to carry executor node/lease metadata, or be reduced to a warm-handle cache only. |
| `src/acp/control-plane/runtime-options.ts` | Validates and normalizes ACP runtime options like `cwd`, `model`, `permissionProfile`, `timeoutSeconds`, and backend extras. | Extend only if node-backed execution truly needs additional runtime options. A likely seam is node-selection preferences, but those should not leak into generic ACP config casually. |
| `src/acp/control-plane/manager.identity-reconcile.ts` | Refreshes ACP identity from runtime status after ensure/turns/startup reconcile. | Needs to work with node-backed runtime identity without ACPX-specific assumptions. |
| `src/acp/runtime/session-identity.ts` | Normalizes ACP identity and currently uses `acpxRecordId` and `acpxSessionId` naming. | Generalize this. The current naming is ACPX-specific and will become confusing if reused for gateway-owned ACP sessions plus node-local runtime identifiers. |
| `src/acp/runtime/session-meta.ts` | Reads/writes ACP projection into the generic session store. | Demote this to a compatibility/projection layer on top of the new ACP store. It should not remain the source of truth for node-backed runs/events/leases. |
| `src/acp/control-plane/manager.utils.ts` | Session-key normalization, missing-meta errors, idle TTL, legacy identity detection. | Update helpers for new recovery/lease semantics and projection behavior. |
| `src/acp/control-plane/session-actor-queue.ts` | Per-session serialization queue. | Keep. It is still the right place to serialize lease mutations, turn transitions, and projector checkpoint advancement per session/run. |
| `src/acp/control-plane/spawn.ts` | Failed ACP spawn cleanup path. | Update cleanup to understand durable run/lease state and recoverable close semantics. |

### 2. ACP metadata projection, delivery, lifecycle, and diagnostics

| File | Current role | What `acp-node` needs here |
| --- | --- | --- |
| `src/config/sessions/types.ts` | Defines `SessionEntry.acp` and `SessionAcpMeta` with backend, agent, runtime session name, identity, mode, runtime options, state, and last error. | Keep this as projection state only. Add only the minimal projected operator-facing fields needed for node-backed sessions, such as executor node summary, lease epoch snapshot, or recovery state. Do not turn it into the durable run/event store. |
| `src/auto-reply/reply/dispatch-acp.ts` | Runs ACP turns and forwards backend events directly into the reply projector. | Needs a store-first path. The final shape should be “append accepted worker events durably, then project from durable state,” not “project what the runtime iterator yields right now.” |
| `src/auto-reply/reply/acp-projector.ts` | Live formatter/chunker for ACP runtime events. | The rendering logic is still useful, but it needs a durable projector wrapper with projection checkpoints and replay. |
| `src/auto-reply/reply/commands-acp/diagnostics.ts` | Implements `/acp doctor`, `/acp install`, and `/acp sessions`. Today it shows configured backend, runtime-cache stats, and projected session rows. | Add store health, active leases, executor node ids, recoverable runs, replay cursor/checkpoint visibility, and node capability failures. |
| `src/commands/doctor.ts` | Top-level `openclaw doctor` flow. | It is ACP-blind today. If the node-backed runtime is meant to be operable outside chat commands, add an ACP doctor section or a gateway RPC-backed ACP health probe here. |
| `src/commands/status.command.ts`, `src/commands/status.scan.ts`, `src/commands/status.summary.ts`, `src/commands/status.types.ts`, `src/commands/status-json.ts` | Top-level CLI status flow and JSON payloads. | Also ACP-blind today. Add summary/status JSON for backend registration, active leases, recoverable runs, queue depth, error-code counts, and selected executor nodes. |
| `src/gateway/server-methods/doctor.ts` | Gateway-side doctor RPCs. | Add an ACP runtime/store health RPC if top-level CLI doctor/status should be able to surface node-backed ACP health remotely. |
| `src/commands/agent.ts` | Routes ACP-shaped sessions through `AcpSessionManager`. | Update only as needed for changed turn semantics and durable result delivery. |
| `src/auto-reply/reply/abort.ts` | ACP cancel entry point used by `/stop`-style flows. | Needs deterministic interaction with durable cancel-vs-terminal resolution instead of just forwarding cancel to the live runtime. |
| `src/gateway/session-reset-service.ts` | Resets/deletes sessions and already tries ACP cancel + close. | Must handle node-backed recoverable states, backend unavailability, and durable lease cleanup without corrupting the ACP store. |
| `src/acp/persistent-bindings.lifecycle.ts` | Ensures/reset ACP sessions for configured bindings. | Needs to respect the new authoritative ACP store and projection model. |
| `src/gateway/server-startup.ts` | On startup, runs ACP identity reconcile when ACP is enabled. | Needs startup recovery for durable ACP sessions/runs/leases/checkpoints, not just identity repair. |
| `src/acp/runtime/session-identifiers.ts` | User-facing session-id/rendering helpers and thread intro detail lines. | Generalize the output so it can show node-backed identity cleanly without ACPX-only labels. |

### 3. Gateway node registry, protocol, and event ingestion

| File | Current role | What `acp-node` needs here |
| --- | --- | --- |
| `src/gateway/protocol/schema/nodes.ts` | Generic `node.invoke`, `node.invoke.result`, and `node.event` schemas. `node.event` only validates `event` plus raw payload JSON. | Add ACP worker payload validation somewhere adjacent to this schema layer. The transport can stay generic, but `acp.worker.event`, `acp.worker.terminal`, `acp.worker.heartbeat`, and `acp.worker.status` need strict structural validation before any state mutation. |
| `src/gateway/node-registry.ts` | Tracks connected nodes and pending request/response invokes. | Add ACP selection helpers around caps/commands/platform metadata. The core request/response invoke path can stay, but gateway-side ACP selection logic needs a real home. |
| `src/gateway/server/ws-connection/message-handler.ts` | Registers connected nodes, stores caps/commands/pathEnv, updates paired metadata, refreshes remote bins, and sends initial node snapshots. | Validate ACP capability advertisement and record ACP worker protocol support/version. This is also where mismatched or incomplete ACP command declarations should fail early or at least surface cleanly. |
| `src/gateway/server-methods/nodes.ts` | Generic node RPC entrypoints including `node.invoke`, `node.invoke.result`, and `node.event`. | Route ACP worker events into a dedicated ACP handler, reject malformed ACP payloads early, and possibly expose ACP-aware node diagnostics. |
| `src/gateway/server-node-events.ts` | Monolithic node event handler for voice, exec, notifications, and subscriptions. | Do not pile ACP run/lease logic directly into the existing monolith. Prefer a new ACP-specific event submodule and dispatch from here. |
| `src/gateway/server-node-events-types.ts` | Context passed into node event handlers. | Extend the context so ACP event handlers can append events, mutate leases, and trigger projector/replay work. |
| `src/gateway/server-methods/nodes.handlers.invoke-result.ts` | Completes generic pending invokes and ignores late results. | Likely minimal change, but ACP tests need to pin down the expected behavior for `acp.turn.start` acceptance results versus later worker events. |
| `src/gateway/server-methods-list.ts` | Advertises methods/events. | Probably no change if ACP stays layered on existing `node.invoke` and `node.event`. |
| `src/gateway/server-node-subscriptions.ts` | Ephemeral per-node session subscription fanout. | Keep separate from ACP durability. This is not the place for ACP replay or checkpoints. |
| `src/infra/node-commands.ts` | Shared node command constants for node-host advertising. | Add ACP command constants so gateway and node-host stay aligned. |

One transport-specific seam is worth calling out explicitly: the live routing identity for a node currently prefers `connect.device.id`, while the node-host runner sends its configured node-host id as `instanceId`. The handshake updates paired metadata for both values. `acp-node` needs to choose which identity owns leases and diagnostics up front so it does not mix physical device ids and logical host ids later.

### 4. Node-host runner and worker execution path

| File | Current role | What `acp-node` needs here |
| --- | --- | --- |
| `src/node-host/runner.ts` | Connects node-host to the gateway, advertises `system` and optional `browser` capability, and forwards `node.invoke.request` to `handleInvoke(...)`. | Advertise `acp` capability and the ACP worker command set, initialize ACP worker runtime support, and keep gateway/node-host command lists in sync. |
| `src/node-host/invoke.ts` | Dispatches `system.execApprovals.*`, `system.which`, `browser.proxy`, `system.run.prepare`, and `system.run`; emits best-effort `node.event`. | Add ACP command handling, likely by factoring ACP logic into a dedicated worker module. Every ACP worker event needs lease/run/session metadata and normalized payloads. |
| `src/node-host/config.ts` | Stores node-host identity/gateway connection config. | Extend only if ACP worker behavior is configurable here. |
| `src/config/types.node-host.ts` | Node-host config schema currently only covers browser proxy settings. | Add ACP worker config if needed, such as enablement, heartbeat cadence, allowed agents, or runtime command configuration. |
| `src/gateway/client.ts` | Generic gateway WS client used by the node host. | Probably no structural blocker, but ACP worker traffic volume and heartbeat patterns warrant review of request timeout/backoff assumptions. |
| `extensions/acpx/src/runtime.ts` | Reference ACP runtime backend for local CLI-backed ACP execution. | Likely reused conceptually or wrapped from the node-host worker path; useful as the behavioral reference for session ensure/status/turn/cancel/close. |
| `extensions/acpx/src/service.ts` | Registers the ACPX backend into the runtime registry. | Useful reference for how `acp-node` should register itself if kept in the same backend registry. |

### 5. Config and agent runtime surfaces

| File | Current role | What `acp-node` needs here |
| --- | --- | --- |
| `src/config/types.acp.ts` | ACP config shape: enablement, backend id, agent allowlist, stream config, runtime TTL/install command. | Add only global `acp-node` settings that truly belong at the ACP level, such as node selection policy or lease/recovery timing. |
| `src/config/zod-schema.ts` | Runtime validation for ACP config. | Mirror any new `acp-node` config added in `types.acp.ts`. |
| `src/config/types.agents.ts` | Agent runtime config already allows `runtime.type="acp"` and arbitrary ACP backend strings. | No schema blocker exists for `backend: "acp-node"`, but agent-level docs/tests may need updates once the backend exists. |
| `src/agents/acp-spawn.ts` | ACP spawn flow used by session/tool-based ACP session creation. | Mostly uses manager + backend config already, but worth reviewing once `acp-node` is selectable by agent defaults. |

## New Modules Likely Required

The current tree is missing durable ACP runtime/store modules entirely. A clean implementation probably needs at least:

- `src/acp/store/schema.ts`
  - shared store record types and serialization helpers
- `src/acp/store/sessions.ts`
  - durable ACP session records
- `src/acp/store/runs.ts`
  - durable run lifecycle and canonical terminal state
- `src/acp/store/events.ts`
  - append-only worker event log with `(runId, seq)` handling
- `src/acp/store/checkpoints.ts`
  - projector/delivery checkpoints
- `src/acp/store/leases.ts`
  - lease acquisition, replacement, release, and fencing metadata
- `src/acp/store/idempotency.ts`
  - request and terminal idempotency records
- `src/acp/store/recovery.ts`
  - startup reload/recovery helpers
- `src/acp/control-plane/lease-manager.ts`
  - single-session lease state machine
- `src/acp/control-plane/terminal-resolution.ts`
  - canonical terminal winner logic
- `src/acp/control-plane/projector.ts`
  - durable event-to-delivery projection with checkpoints/replay
- `src/acp/runtime/acp-node.ts`
  - the core node-backed backend implementation
- `src/gateway/server-node-events-acp.ts`
  - ACP-specific `node.event` ingestion/validation
- `src/node-host/acp-worker.ts`
  - node-side ACP worker command handling
- `src/node-host/acp-session-runner.ts`
  - node-local runtime session binding and turn execution
- `src/acp/testing/fake-node-worker.ts`
  - deterministic fake worker harness for Tier 1 verification
- `src/acp/testing/restart-harness.ts`
  - controlled restart/replay tests

## Risky Seams

These are the places most likely to cause churn or regressions:

1. `SessionEntry.acp` is both route hint and effective truth today.
   - Moving to a dedicated ACP store without breaking `/acp sessions`, persistent bindings, reset, and old sessions will require a careful projection strategy.

2. `AcpSessionManager.runTurn(...)` is built around a live iterator contract.
   - `acp-node` needs accepted-start plus later worker events plus durable terminal resolution. That is not just a backend swap.

3. ACP identity is currently ACPX-shaped.
   - The `acpxRecordId` / `acpxSessionId` fields in `src/acp/runtime/session-identity.ts` and `src/config/sessions/types.ts` will become misleading if reused for node-backed execution.

4. `node.event` is currently generic and loosely validated.
   - ACP worker messages cannot mutate durable run/lease state until they are validated against lease/run/session/seq rules.

5. Node-host event emission is best-effort.
   - `sendNodeEvent(...)` in `src/node-host/invoke.ts` does not provide delivery guarantees, so gateway recovery/reconcile logic must assume partial loss.

6. Late invoke results are ignored today.
   - `src/gateway/node-registry.ts` drops late `node.invoke.result` frames after timeout. ACP command/result semantics must be designed so that this is harmless, especially for `acp.turn.start`.

7. Session reset/delete/abort flows are spread across multiple call sites.
   - `src/auto-reply/reply/abort.ts`, `src/gateway/session-reset-service.ts`, `src/acp/persistent-bindings.lifecycle.ts`, and `src/commands/agent.ts` all assume current close/cancel behavior.

8. Runtime-cache eviction currently closes idle backends opportunistically.
   - That is fine for `acpx`, but with leased nodes it must not become accidental lease-release logic unless explicitly modeled that way.

## Recommended First Implementation Slice

The first slice should be gateway-heavy, not node-host-heavy.

### Slice goal

Prove the hard invariants first:

- durable gateway-owned ACP runs/events/checkpoints/leases
- lease epoch fencing
- canonical terminal resolution
- projector replay/checkpoint correctness
- fake-node transport integration over existing `node.invoke` + `node.event`

### Why this is the right first slice

- It attacks the actual architectural gap in current code: missing gateway-owned ACP durability.
- It avoids coupling the first merge to remote process-management details on the node host.
- It gives the future real node-host worker a stable contract to implement against.
- It aligns best with the hardened verification plan, which now also requires canonical terminal resolution and one explicit recoverable-state path in the first mergeable slice.

### Concrete first-slice edit set

Modify:

- `src/acp/control-plane/manager.core.ts`
- `src/acp/control-plane/manager.types.ts`
- `src/acp/runtime/session-meta.ts`
- `src/config/sessions/types.ts`
- `src/auto-reply/reply/dispatch-acp.ts`
- `src/auto-reply/reply/commands-acp/diagnostics.ts`
- `src/gateway/server-methods/nodes.ts`
- `src/gateway/server-node-events.ts`
- `src/gateway/server-node-events-types.ts`
- `src/gateway/protocol/schema/nodes.ts`

Add:

- `src/acp/store/*`
- `src/acp/control-plane/lease-manager.ts`
- `src/acp/control-plane/terminal-resolution.ts`
- `src/acp/control-plane/projector.ts`
- `src/acp/runtime/acp-node.ts`
- `src/gateway/server-node-events-acp.ts`
- `src/acp/testing/fake-node-worker.ts`
- targeted tests for store/fencing/replay/ACP node events

First-slice behaviors that should be treated as in-scope, not deferred:

- explicit `recovering` / `suspect` state persistence and reload
- `acp.worker.terminal` as the only terminal authority
- `acp:v1` capability and `nodeId` validation at ACP event ingress
- one reconnect or disconnect recovery path that proves the conservative v1 lease policy

Defer until slice 2:

- real ACP command advertisement in `src/node-host/runner.ts`
- real ACP worker command handling in `src/node-host/invoke.ts`
- node-host ACP config additions

## Files That Likely Do Not Need Initial Changes

These are easy places to over-touch early:

- `src/gateway/server-node-subscriptions.ts`
  - useful for ephemeral fanout, not for ACP durability
- `src/gateway/node-pending-work.ts`
  - unrelated unless ACP later wants mobile foreground queueing
- `src/plugin-sdk/acpx.ts`
  - no reason to expand plugin SDK if `acp-node` stays core-owned
- `src/gateway/server-methods-list.ts`
  - likely unchanged because the protocol is layered on existing node methods
- `src/gateway/android-node.capabilities.live.test.ts`
  - good pattern for later live testing, but not part of the first code slice

## Suggested Test Plan Mapping

Existing tests worth extending directly:

- `src/acp/control-plane/manager.test.ts`
- `src/auto-reply/reply/dispatch-acp.test.ts`
- `src/auto-reply/reply/acp-projector.test.ts`
- `src/gateway/server-methods/nodes.invoke-wake.test.ts`
- `src/gateway/server-node-events.test.ts`
- `src/node-host/invoke.sanitize-env.test.ts`

New tests that should exist as first-class suites:

- `src/acp/store/store.test.ts`
  - persistence/reload of sessions/runs/events/checkpoints/leases
- `src/acp/control-plane/lease-manager.test.ts`
  - single active lease, replacement, stale epoch rejection
- `src/acp/control-plane/terminal-resolution.test.ts`
  - duplicate terminals, cancel-vs-complete, stale terminal rejection
- `src/acp/control-plane/replay.test.ts`
  - restart after append-before-checkpoint and restart after terminal-before-projector
- `src/gateway/server-node-events-acp.test.ts`
  - payload validation, malformed payload rejection, seq/lease/run matching
- `src/node-host/acp-worker.test.ts`
  - node-side ensure/start/cancel/close/status and event emission rules
- `src/acp/e2e/fake-node-runtime.test.ts`
  - fake worker happy path, duplicate event replay, stale epoch, reconnect replay

## Bottom Line

The minimal real touchpoint set is not “just add a new backend.”

The implementation centers are:

- `src/acp/control-plane/manager.core.ts`
- a brand-new durable ACP store under `src/acp/store/`
- ACP-specific gateway node-event ingestion
- a core `src/acp/runtime/acp-node.ts`
- later, a real ACP worker path in `src/node-host/runner.ts` and `src/node-host/invoke.ts`

If the first slice starts with node-host worker code before the gateway store/fencing/replay foundation exists, it will create demoable behavior without landing the architecture the planning docs actually require.
