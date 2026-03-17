---
summary: "Gateway-owned ACP control plane with node-leased execution over the existing Gateway WebSocket, preserving migration/failover potential without turning nodes into mini-gateways"
read_when:
  - Designing a node-backed ACP runtime backend for OpenClaw
  - Replacing URL/header ACP relays with a node-native execution model
  - Planning durable ACP session/run/event storage on the gateway
  - Defining ACP-over-node WebSocket protocol, leases, replay, and failover
  - Preparing an upstreamable architecture + implementation plan for ACP on nodes
title: "ACP Node-Backed Runtime Architecture"
---

<!-- markdownlint-disable MD024 -->

# ACP Node-Backed Runtime Architecture

## Executive summary

This document proposes the long-term architecture for running ACP-capable runtimes on OpenClaw **nodes** while keeping **all durable ACP control-plane state on the OpenClaw gateway**.

The core idea is:

- the **gateway** owns ACP session identity, lifecycle, runs, event log, delivery checkpoints, idempotency, and policy
- a **node** temporarily hosts the runtime process and streams runtime events over the existing Gateway WebSocket connection
- the gateway treats the node as a **leased execution worker**, not as the authority for the ACP session
- session migration to another node is designed to be possible at the ACP/control-plane level, even if workspace portability remains deferred for now

This is the strongest future-facing shape because it:

- aligns with OpenClaw’s ACP backend abstraction
- aligns with the existing node pairing/registry/policy model
- avoids turning nodes into mini-gateways
- preserves the durability/replay/recovery goals already established in the remote ACP work
- keeps node transport an implementation detail of the backend rather than leaking transport concerns into user-visible ACP semantics

## Problem statement

OpenClaw already has two important building blocks:

1. **ACP runtime abstraction in core**
   - pluggable backends
   - ACP session metadata on the gateway
   - ACP routing, binding, and delivery concepts

2. **Node WebSocket transport**
   - paired peripheral devices and headless node hosts
   - claimed capabilities/commands
   - request/response invocation and event emission over the gateway WebSocket

Today, these two systems are adjacent but not unified.

The existing `acpx` backend is local-process-oriented. The recent remote ACP work (`acp-remote` + external ACP gateway) proved the value of separating transport/runtime execution from the gateway-owned ACP surface, but it bypasses the node system and uses direct URL/header transport instead of OpenClaw’s native node model.

The desired end-state is a first-class **node-backed ACP runtime** where:

- nodes are the execution substrate
- the gateway remains the durable orchestrator
- remote ACP execution is mediated through the existing node trust/pairing/policy model
- the ACP-facing behavior remains consistent with the local and remote backend story

## External ACP compatibility baseline

This architecture should explicitly anchor itself to the public ACP references:

- ACP docs / introduction: <https://agentclientprotocol.com>
- ACP TypeScript library page: <https://agentclientprotocol.com/libraries/typescript>
- ACP TypeScript SDK package: <https://www.npmjs.com/package/@agentclientprotocol/sdk>
- ACP TypeScript API reference: <https://agentclientprotocol.github.io/typescript-sdk>
- ACP docs index: <https://agentclientprotocol.com/llms.txt>

Interpretation for this project:

- on the **runtime-facing side**, we should reuse real ACP concepts and TypeScript SDK/client patterns wherever practical
- on the **OpenClaw-internal transport side**, we still need additional machinery that ACP does not fully standardize for this exact topology yet (node leases, fencing, durable gateway-owned replay/checkpoints, canonical terminal resolution)
- those OpenClaw-specific additions should be designed so they remain compatible with ACP’s base primitives and mental model rather than inventing a completely separate agent protocol

## Goals

### Primary goals

1. **Gateway-owned truth**
   - all durable ACP session/run/event state is stored on the gateway
   - node-local state is ephemeral or cache-like only

2. **Node-native transport**
   - use the existing gateway WebSocket / node connection model
   - do not require a separate remote HTTP endpoint for the node-backed design

3. **ACP backend parity**
   - fit cleanly into the existing ACP backend registry and manager model
   - preserve the current ACP-facing semantics for spawn, prompt, cancel, close, status, and delivery

4. **Recovery and replay**
   - gateway restart, node reconnect, duplicate delivery, and cancellation races must be handled explicitly
   - event and terminal-result replay semantics must be durable and deterministic

5. **Future mobility at the ACP layer**
   - the system must be designed so that the same ACP session can later continue on another node
   - node identity must not be the canonical ACP session identity

6. **Policy alignment with nodes**
   - pairing, capability claims, allowlists, and node targeting should use the existing node model rather than inventing a separate remote runtime trust path

### Non-goals for the first implementation

1. **Full cross-node workspace portability**
   - workspace/filesystem affinity is acknowledged but deferred
   - the design must not make future mobility impossible, but it does not need to solve portable workspaces now

2. **Turning nodes into standalone ACP gateways**
   - nodes should not own session identity, delivery checkpoints, or durable event logs

3. **Reusing generic `system.run` as the final ACP transport**
   - generic shell invocation may help prototypes, but it is not the target architecture

4. **Pretending internal node transport is a published ACP standard**
   - external ACP semantics should remain aligned with ACP concepts
   - the node worker transport is an internal OpenClaw protocol

## Current-state grounding

### ACP on current `main`

Current OpenClaw `main` already has:

- ACP runtime backend registry (`src/acp/runtime/registry.ts`)
- ACP runtime contract (`src/acp/runtime/types.ts`)
- ACP session manager / control plane (`src/acp/control-plane/manager*.ts`)
- ACP metadata projection in normal session store (`SessionEntry.acp`)
- local `acpx` plugin backend (`extensions/acpx`)

Important current properties:

- `SessionEntry.acp` stores ACP metadata such as backend, agent, runtime handle identity, mode, state, and runtime options
- runtime handles are cached in memory and TTL-evicted
- `acpx` executes local CLI commands like `sessions ensure`, `status`, `prompt`, `cancel`, `sessions close`
- the ACP thread-bound plan already argues that long-term durable lifecycle/run/event state should move into a dedicated ACP database rather than generic session JSON

### Nodes on current `main`

Current OpenClaw `main` already has:

- paired node concept over the gateway WebSocket
- node capability/command claims on connect
- `node.invoke` request/response flow via `node.invoke.request` and `node.invoke.result`
- `node.event` for reverse event emission from node to gateway
- node host mode for remote command execution
- command allowlist enforcement and node pairing/policy

Important current properties:

- node events are not a replayable durable transport today
- node invoke is request/response oriented and suited for peripherals, not for long-lived durable ACP event streams
- node subscriptions exist, but they are not a durable ACP run/event log

## Design principles

1. **Control plane and execution plane are different things**
   - gateway owns control plane
   - node owns execution plane only while leased

2. **Session identity must be transport-independent**
   - ACP session identity belongs to the gateway
   - node ids and node-local runtime session ids are secondary identifiers

3. **Node-local runtime state is replaceable**
   - if a node disappears, the session record remains meaningful
   - another node may later continue the session at the ACP layer

4. **Transport reliability must not depend on lucky timing**
   - explicit sequencing, checkpointing, replay, and terminal-result semantics are required

5. **Use the node model, not parallel infrastructure**
   - pairing, capability claims, policy, and node targeting should all go through the existing node architecture

6. **Preserve the ACP backend seam**
   - this should land as another backend, not as a one-off code path that bypasses ACP abstractions

## Proposed architecture

## Overview

Introduce a new ACP backend:

- **backend id:** `acp-node`

This backend runs inside the OpenClaw gateway process and uses the existing node WebSocket connection as its execution transport.

At a high level:

1. user or binding targets an ACP session in OpenClaw
2. ACP manager resolves session + backend = `acp-node`
3. gateway ACP control plane allocates or renews an **execution lease** on a selected node
4. gateway sends ACP worker commands to the node over the node WebSocket
5. node runs the local ACP-capable runtime and streams normalized ACP worker events back
6. gateway appends those events to durable ACP storage
7. gateway projects events into OpenClaw delivery (Discord, thread bindings, status lines, checkpoints, etc.)
8. on cancel/close/failure/reconnect, the gateway remains authoritative

The node becomes a **runtime host**, not an ACP authority.

## Data ownership model

### Durable gateway-owned data

The gateway must own and persist at least:

- ACP sessions
- ACP runs / turns
- ACP event log
- delivery checkpoints / projection checkpoints
- idempotency records
- current lease / executor assignment metadata
- historical executor assignments (optional but desirable)
- session runtime options / config state
- node selection policy snapshot relevant to the session
- canonical ACP session identity and backend handle identity

### Ephemeral or cache-like node-owned data

A node may own temporarily:

- live runtime process
- local pipes/sockets/subprocess handles
- node-local runtime session handle / pid
- node-local warm caches
- temp files / local artifacts

These are never the authoritative record.

## Execution lease model

### Why leases exist

A node should not “own” an ACP session. It should merely hold a lease to execute it.

This enables:

- failover
- reconnect recovery
- stale-worker fencing
- future cross-node continuation

### Lease requirements

Each ACP session may have zero or one active execution lease.

A lease record should include:

- `leaseId`
- `leaseEpoch` (monotonic fence)
- `sessionKey`
- `runId` or current active run reference when relevant
- `nodeId`
- `state` (`acquiring | active | suspect | lost | releasing | released`)
- `acquiredAt`
- `lastHeartbeatAt`
- `expiresAt`
- optional node-local runtime identifiers
  - `nodeRuntimeSessionId`
  - `nodeWorkerRunId`
- optional node capability snapshot

### Fencing rule

Every node-originated ACP worker event must carry the lease epoch. The gateway rejects events from stale epochs.

This is mandatory to prevent:

- old node processes finishing after failover
- duplicate terminal results from stale executors
- split-brain delivery after reconnects

### Conservative v1 lease-expiry and reconnect policy

For v1, use the simplest policy that keeps fencing deterministic:

- node disconnect or missed heartbeats move the lease from `active` to `suspect`
- the associated non-terminal run moves to `recovering`; do not guess success or failure
- while a configurable reconnect grace window is open, the gateway does **not** mint a new epoch and does **not** auto-reassign the run to another node
- the same authenticated node may resume the same `leaseId` + `leaseEpoch` only after `acp.session.status` proves the runtime state is still coherent
- if the grace window expires or status reconcile is missing or incoherent, mark the lease `lost`
- v1 does not do automatic cross-node failover for an in-flight run; any replacement lease is an explicit recovery action that mints a new epoch and uses `acp.session.load`

## ACP storage model

## Required direction

For the node-backed architecture, the gateway needs a dedicated ACP store. `SessionEntry.acp` should remain as a compatibility projection and routing hint, not the long-term source of truth.

The ACP thread-bound plan already points in this direction. For node-backed ACP, it becomes a hard requirement.

## Suggested tables / records

At minimum:

### `acp_sessions`

- `session_key` (pk)
- `backend`
- `agent`
- `mode`
- `state` (`creating | idle | lease_acquiring | lease_active | recovering | error | closed`)
- `cwd`
- `created_at`
- `updated_at`
- `last_error`
- `active_lease_id` nullable
- `recovery_reason` nullable
- `preferred_node_selector` nullable

### `acp_runs`

- `run_id` (pk)
- `session_key`
- `request_id` / idempotency key
- `state` (`queued | acquiring_worker | starting | running | cancelling | recovering | completed | failed | cancelled`)
- `active_lease_epoch` nullable
- `started_at`
- `ended_at`
- `cancel_requested_at` nullable
- `stop_reason`
- `error_code`
- `error_message`
- `recovery_reason` nullable
- `canonical_terminal_event_id` nullable
- `final_seq` nullable

### `acp_events`

- `session_key`
- `run_id`
- `seq`
- `kind`
- `payload_json`
- `lease_epoch`
- `created_at`

Unique on `(run_id, seq)`.

### `acp_delivery_checkpoints`

- `run_id`
- `projector_id` / destination key
- `last_seq`
- `last_message_id` nullable
- `updated_at`

### `acp_idempotency`

- `scope`
- `idempotency_key`
- `result_json`
- `created_at`

### `acp_leases`

- `lease_id` (pk)
- `session_key`
- `run_id` nullable
- `lease_epoch`
- `node_id`
- `state`
- `acquired_at`
- `last_heartbeat_at`
- `suspect_at` nullable
- `released_at` nullable
- `release_reason` nullable
- node-local runtime identifiers nullable

## `SessionEntry.acp` compatibility projection

Retain a projection with fields like:

- backend
- agent
- runtimeSessionName
- mode
- state
- lastActivityAt
- identity

But do **not** rely on it as the authoritative source for run/event durability.

## Protocol model

## External ACP semantics

From the ACP-facing side, the gateway should continue to present normal ACP semantics:

- initialize
- new/load session
- prompt/steer turn
- cancel
- close
- status
- session mode/config updates

The ACP translator / external ACP-facing implementation should not need to know whether the runtime is local `acpx`, remote HTTP, or node-backed.

## Internal node worker transport

The node transport should be OpenClaw-native and additive to the existing node protocol.

### Why not just use `system.run`

`system.run` is useful for shell execution but is the wrong long-term contract for ACP because it lacks:

- durable run identity
- lease fencing
- structured replay
- session-level control semantics
- explicit terminal-result protocol
- fine-grained ACP event typing

### Recommended node commands

At node connect time, a capable node advertises:

- cap: `acp:v1`
- commands:
  - `acp.session.ensure`
  - `acp.session.load`
  - `acp.turn.start`
  - `acp.turn.cancel`
  - `acp.session.close`
  - `acp.session.status`

These are node worker commands, not end-user ACP commands.

### Normative connect contract

For v1, one connect contract is authoritative:

- the authenticated gateway connection identity is the source of truth for `nodeId`
- the node must advertise `acp:v1` in `caps`
- unrelated caps such as `system` may also be present, but `acp:v1` is the compatibility marker the gateway selects on
- every ACP worker `node.event` payload must echo `nodeId`, and the gateway rejects mismatches between payload identity, lease owner, and authenticated connection identity
- `acp.worker.heartbeat` is an event, not a command; polling uses `acp.session.status`

### Recommended request/response flow

Use `node.invoke` for control operations:

- `acp.session.ensure`
- `acp.session.load`
- `acp.turn.start`
- `acp.turn.cancel`
- `acp.session.close`
- `acp.session.status`

Use `node.event` for streaming and state changes:

- `acp.worker.event`
- `acp.worker.terminal`
- `acp.worker.heartbeat`
- `acp.worker.status`

### Core payload requirements

Every ACP worker payload must include:

- `sessionKey`
- `runId` when run-scoped
- `leaseId`
- `leaseEpoch`
- `nodeId`
- `(runId, seq)` for non-terminal events
- `terminalEventId` + `finalSeq` for terminal candidates

### Event sequencing

For each run, the worker must emit monotonically increasing `seq` values.

The gateway appends events durably and only advances delivery checkpoints after successful persistence.

### Replay model

Unlike generic gateway events, ACP worker events must support replay semantics.

Recommended model:

- gateway is the durable store of worker events
- node does not need to be the replay authority
- after disconnect/reconnect, the gateway either:
  - resumes the active worker stream if still valid, or
  - reconstructs from durable event log and worker status

This means replay happens from the gateway ACP store, not from the node WebSocket layer itself.

## Lease lifecycle

## Session-level lifecycle

A session goes through control-plane states such as:

- `creating`
- `idle`
- `lease_acquiring`
- `lease_active`
- `recovering`
- `error`
- `closed`

## Run-level lifecycle

A run goes through:

- `queued`
- `acquiring_worker`
- `starting`
- `running`
- `cancelling`
- `recovering`
- `completed`
- `failed`
- `cancelled`

## Node lease lifecycle

A lease goes through:

- `acquiring`
- `active`
- `suspect`
- `lost`
- `releasing`
- `released`

## Important rules

1. there is at most one active run per ACP session
2. there is at most one active lease per ACP session at a time
3. a run may continue only on the lease epoch that started it
4. terminal delivery happens exactly once from durable gateway state
5. stale worker terminal events are rejected by lease epoch fencing

## Required recovery transitions

The store and state machine must name the recoverable cases explicitly.

- if `acp.turn.start` is accepted but the gateway loses the node before the first worker event, move the run to `recovering` with `recovery_reason=start_accepted_no_events` and move the lease to `suspect`
- if the gateway restarts while a run is non-terminal, reload it as `recovering` with `recovery_reason=gateway_restart_reconcile`
- if the node reconnects within the grace window and reports the same runtime state for the same `leaseId` + `leaseEpoch`, move the lease back to `active` and resume the run
- if the grace window expires or the node reports missing or mismatched runtime state, move the lease to `lost` and keep the run in `recovering`
- if an explicit recovery action rebinds the session to a new node, mint a new epoch, call `acp.session.load`, and keep the run in `recovering` until the gateway durably records the recovered runtime status

## Node selection model

Node selection should be policy-driven and explicit.

### Inputs

Selection may consider:

- requested node id
- preferred node id or selector on session
- backend/agent support on node
- claimed ACP capability
- runtime health
- platform tags
- allowlist / admin policy
- whether the node already has a warm lease for the session

### Future-proofing

Node selection must be a separate component rather than embedded into runtime code so that future policies can add:

- affinity
- failover priority
- user override
- health scoring
- maintenance draining

## Relationship to session mobility

Workspace portability is deferred, but the ACP architecture should still allow future mobility.

That means:

- the gateway session identity remains canonical
- node-local identifiers are secondary
- the lease model does not assume a fixed node forever
- the run/event log is independent of node identity
- `session/load` or equivalent reconstruction semantics are the expected recovery mechanism

For early implementations, policy may still decide:

- “resume on same node only unless operator explicitly resets or rebinds”

That is acceptable as an implementation policy so long as the architecture does not hardcode node ownership into ACP session identity.

## Component boundaries and where implementation belongs

## Core ACP control plane

These areas should remain in or move into core:

- `src/acp/runtime/types.ts`
- `src/acp/runtime/registry.ts`
- `src/acp/control-plane/*`
- ACP store implementation (new)
- ACP projector / delivery checkpoint logic
- ACP session/run/lease state transitions
- node-backed ACP backend registration entry point

## Gateway node layer

These areas are the right place for transport and policy integration:

- `src/gateway/node-registry.ts`
- `src/gateway/server-methods/nodes.ts`
- `src/gateway/server-node-events.ts`
- node allowlist/policy helpers
- node capability validation

Likely new code here:

- ACP-specific node event handling
- node ACP lease coordination helpers
- node ACP command allowlist integration

## Node host / node app side

These areas should host the worker runtime adapter:

- `src/node-host/*` for headless node host support
- platform app node clients where applicable

Likely new code here:

- ACP worker host loop
- local runtime adapter to `acpx` or future ACP-capable runtime
- worker heartbeats and event emission
- local cancel/close/status plumbing

## ACP backend plugin / module

Recommended new backend module:

- `src/acp/runtime/node-backed.ts` or equivalent core-owned implementation
- alternatively a plugin if node-backed ACP is intended to be optional, but core ownership is likely cleaner because it depends heavily on core gateway/node internals

Recommendation:

- **core-owned backend** is the cleanest long-term shape
- plugin ownership is better for foreign runtime transports like `acpx` or external relays
- node-backed ACP is deeply tied to gateway internals, node policy, and ACP store semantics

## Required architectural changes

## 1. Dedicated ACP store must become real

This is the biggest prerequisite.

Without a durable ACP store for runs/events/checkpoints/leases, a node-backed backend will either:

- regress reliability, or
- reinvent an external mini-gateway, which defeats the point

### Decision

Make the ACP DB the source of truth.
Keep `SessionEntry.acp` only as compatibility projection and routing helper.

## 2. ACP manager must own run/event durability

The manager already owns session lifecycle directionally, but for node-backed ACP it must clearly own:

- event append
- terminal result resolution
- checkpoint advancement
- lease acquisition / release
- recovery after restart or reconnect

### Decision

Do not let the node backend be the authoritative event log.
The backend feeds normalized events into a gateway-owned durable path.

## 3. Node WS needs ACP-native transport messages

Current generic node invoke/events are not enough by themselves.

### Decision

Extend the node protocol additively with ACP worker commands/events while continuing to use the same WebSocket and pairing model.

## 4. Stale-worker fencing is mandatory

### Decision

Introduce lease epochs and reject stale worker events. No exceptions.

## 5. Terminal-result semantics must be gateway-resolved

### Decision

The gateway determines the winning terminal state for a run based on durable ordering and lease/fencing checks.
Nodes report status; the gateway decides what becomes canonical.

## Recommended implementation phases

## Phase 0 — Design alignment and ADRs

Deliverables:

1. this architecture doc
2. ADR: gateway-owned ACP control plane with node-leased execution
3. ADR: ACP-over-node transport is OpenClaw-internal, not a separate external ACP gateway
4. ADR: ACP durable store is required before node-backed backend reaches production quality

Acceptance criteria:

- architecture and invariants are agreed
- no unresolved ambiguity on ownership, leases, or replay authority

## Phase 1 — ACP durable store foundation

Deliverables:

1. implement ACP DB/store for sessions, runs, events, checkpoints, idempotency, leases
2. dual-write or migrate from `SessionEntry.acp` projection where needed
3. add recovery loaders for active/non-terminal sessions and runs
4. add diagnostics/doctor support for ACP store health

Acceptance criteria:

- ACP sessions/runs/events survive gateway restart
- delivery checkpointing is durable
- `SessionEntry.acp` remains compatible but non-authoritative

## Phase 2 — Lease model and state machine hardening

Deliverables:

1. add lease allocation and release primitives
2. add lease epoch fencing rules
3. add run-state and lease-state transition guards
4. implement canonical terminal-state resolution rules

Acceptance criteria:

- stale executor events are rejected
- duplicate terminal races resolve deterministically
- cancel-vs-complete races have explicit winning semantics

## Phase 3 — Node ACP transport extension

Deliverables:

1. extend node protocol with ACP worker commands/events
2. add ACP cap/command declarations to node host/client
3. add gateway-side ACP node event handlers
4. add allowlist/policy wiring for ACP node commands

Acceptance criteria:

- node can advertise ACP support
- gateway can invoke ACP worker commands safely
- worker events arrive with required lease/run/session metadata

## Phase 4 — Headless node ACP worker implementation

Deliverables:

1. implement ACP worker loop on headless node host
2. adapt local runtime (`acpx` initially) to ACP worker command/event contract
3. implement status, cancel, close, and heartbeat on node
4. return normalized worker events to gateway

Acceptance criteria:

- a headless node host can execute ACP turns as a worker
- gateway receives structured event stream and terminal result
- cancel/close/status paths work end-to-end

## Phase 5 — `acp-node` backend integration in ACP manager

Deliverables:

1. register `acp-node` backend
2. integrate lease acquisition and node selection into session/run flow
3. append worker events into ACP store
4. project durable events through existing ACP delivery path

Acceptance criteria:

- ACP session can run through a node-backed backend with the same user-facing semantics as other ACP backends
- gateway remains authoritative through restart and reconnect scenarios

## Phase 6 — Recovery and replay hardening

Deliverables:

1. reconnect handling for active node leases
2. gateway restart recovery for active runs
3. delivery replay from checkpoints
4. explicit behavior for lost node mid-turn

Acceptance criteria:

- no duplicate final delivery after reconnect or restart
- recovery behavior is deterministic and documented

## Phase 7 — Node policy, targeting, and UX

Deliverables:

1. configuration for preferred node / target selector
2. diagnostics (`/acp doctor`, `/acp sessions`, node/lease visibility)
3. operator-facing errors for unsupported or unavailable nodes
4. docs for pairing, capability requirements, and troubleshooting

Acceptance criteria:

- operators can understand where ACP is running and why
- misconfiguration fails clearly

## Initial scoping recommendations

To keep the first implementation strong and future-proof without solving every hard problem at once:

1. support **headless node host** first
   - easiest to control and test
   - clearest command/capability model

2. support **single active executor per session**
   - no speculative multi-node execution

3. keep **cross-node continuation architecturally possible** but policy-constrained
   - do not promise automatic mobility in v1

4. treat **workspace portability as deferred policy**, not an architectural blocker

5. prefer **core-owned implementation** for gateway-side ACP-node backend and store
   - because this is really an ACP + gateway + node integration feature, not an optional bolt-on

## Detailed protocol sketch

## Node connect claims

A node with ACP worker support declares:

```json
{
  "role": "node",
  "caps": ["system", "acp:v1"],
  "commands": [
    "acp.session.ensure",
    "acp.session.load",
    "acp.turn.start",
    "acp.turn.cancel",
    "acp.session.close",
    "acp.session.status"
  ]
}
```

## Gateway → node control invokes

### `acp.session.ensure`

Purpose:

- ensure or create node-local worker/runtime session material for a gateway session + lease

Payload sketch:

```json
{
  "sessionKey": "agent:main:acp:...",
  "leaseId": "...",
  "leaseEpoch": 3,
  "agent": "codex",
  "mode": "persistent",
  "cwd": "/workspace/path",
  "resume": {
    "kind": "none | gateway-log | runtime-id",
    "runtimeSessionId": "optional"
  }
}
```

### `acp.turn.start`

Purpose:

- start one ACP turn for an existing leased session

Payload sketch:

```json
{
  "sessionKey": "...",
  "runId": "...",
  "leaseId": "...",
  "leaseEpoch": 3,
  "requestId": "idempotency-key",
  "mode": "prompt | steer",
  "text": "...",
  "attachments": []
}
```

### `acp.turn.cancel`

Purpose:

- cancel the active run tied to the lease epoch

### `acp.session.close`

Purpose:

- close/release node-local runtime session resources

### `acp.session.status`

Purpose:

- ask node for current runtime-side status and identifiers

## Node → gateway worker events

### `acp.worker.event`

Purpose:

- streamed event append candidate

Payload sketch:

```json
{
  "nodeId": "node-123",
  "sessionKey": "...",
  "runId": "...",
  "leaseId": "...",
  "leaseEpoch": 3,
  "seq": 17,
  "event": {
    "type": "text_delta | status | tool_call | error",
    "...": "normalized payload"
  }
}
```

Important rule:

- `acp.worker.event` is non-terminal only
- `done` is not a valid v1 event type and must be rejected

### `acp.worker.terminal`

Purpose:

- explicit terminal signal from worker

Note:

- gateway still decides canonical terminal outcome after fencing + idempotency + race checks

Payload sketch:

```json
{
  "nodeId": "node-123",
  "sessionKey": "...",
  "runId": "...",
  "leaseId": "...",
  "leaseEpoch": 3,
  "terminalEventId": "term-123",
  "finalSeq": 17,
  "terminal": {
    "kind": "completed | failed | cancelled",
    "stopReason": "optional",
    "errorCode": "optional",
    "errorMessage": "optional"
  }
}
```

Terminal rules:

- `acp.worker.terminal` is the only terminal wire authority for v1
- `finalSeq` must match the last accepted non-terminal event sequence for the run, or `0` when the worker emitted no non-terminal events
- after emitting `acp.worker.terminal`, the worker must emit no further `acp.worker.event` messages for that run

### `acp.worker.heartbeat`

Purpose:

- lease liveness and optional runtime status snapshot

Rules:

- heartbeat is event-driven only; polling remains `acp.session.status`
- heartbeat must include `nodeId` and `workerProtocolVersion`
- heartbeat never decides terminal state by itself

## Recovery and reconnect behavior

## Gateway restart

On startup, gateway loads:

- non-terminal sessions
- non-terminal runs
- active or recently active leases
- delivery checkpoints

For each affected session/run:

- if node is connected and lease still valid, reconcile runtime status and allow same-epoch resume
- if node is absent or uncertain, move the lease to `suspect` and move the run to explicit recovery state
- if the grace window expires or reconcile proves the runtime state is gone, mark the lease lost
- do not fabricate completion from missing worker state

## Node reconnect

On reconnect, gateway compares:

- node identity
- declared ACP support
- outstanding lease records
- worker-reported runtime status

Possible outcomes:

- **lease resumes**: same node, same epoch, active run still valid
- **lease replaced**: gateway already moved on; stale events from old epoch rejected
- **recovery required**: node reconnects without enough runtime state; gateway determines next action

## Why this is better than direct remote ACP gateway for this use case

A standalone remote ACP gateway is still valuable where a plain network transport is the right tool, but for OpenClaw-native remote execution the node-backed design has major advantages:

- uses existing node pairing and trust model
- integrates naturally with node capabilities and targeting
- keeps remote execution under the same gateway authority as other node features
- avoids splitting remote runtime trust between “node system” and “ACP gateway system”
- allows mixed-capability devices in the future (camera + canvas + ACP worker on one node)

## Open questions

These do not block the architecture but must be answered during detailed design:

1. Should `acp-node` be core-owned or plugin-owned?
   - recommendation: core-owned

2. How much of current ACP manager API must change once durable run/event store becomes real?
   - likely some internal reshaping is required, but external ACP-facing behavior should remain stable

3. How much runtime detail should `acp.session.status` expose during reconcile?
   - enough to prove lease/runtime coherence without turning status into a second event stream

4. Should node selection be resolved at session creation, run start, or both?
   - likely session preference + per-run resolution

## Testing strategy

The testing bar must be high because this architecture is mostly about correctness under failure.

## Unit tests

### ACP store

- append events in sequence
- reject duplicate `(runId, seq)`
- checkpoint persistence and reload
- idempotency reserve/replay behavior

### Lease model

- acquire lease
- renew lease
- release lease
- reject stale epoch
- replace lost lease

### State transitions

- session state guards
- run state guards
- cancel-vs-complete deterministic resolution
- duplicate terminal result handling

## Integration tests

### Fake node worker transport

Introduce a deterministic fake node ACP worker to simulate:

- normal streaming turn
- worker error
- disconnect mid-turn
- reconnect and resume
- duplicate terminal events
- stale-epoch late events

### Gateway + ACP manager + node worker

Scenarios:

1. create session on node-backed backend and run a normal turn
2. cancel active turn
3. close session
4. gateway restart during active run
5. node disconnect during run
6. node reconnect with same epoch
7. stale node event after replacement lease
8. replay delivery from checkpoints without duplicate final message

## E2E tests

Target at least one real headless node-host flow:

- paired node host with ACP commands advertised
- gateway selects node
- ACP turn executes remotely via node
- output appears through normal OpenClaw delivery/projection

## Required adversarial test cases

These are mandatory because naive testing will miss them:

1. **stale worker wins the race unless fenced**
2. **terminal event arrives twice**
3. **cancel and completion cross in flight**
4. **gateway crashes after event persistence but before delivery checkpoint update**
5. **gateway crashes after delivery checkpoint update attempt but before ack**
6. **node reconnects and replays old buffered events from prior epoch**
7. **two node leases accidentally overlap**

## Implementation checklist

### Architecture / design

- [ ] Confirm gateway-owned ACP control-plane direction
- [ ] Confirm dedicated ACP store as required prerequisite
- [ ] Confirm node-backed backend id and ownership model (`acp-node`, core-owned recommended)
- [ ] Confirm lease/fencing model
- [ ] Confirm internal node ACP transport shape

### ACP store

- [ ] Implement sessions/runs/events/checkpoints/idempotency/leases store
- [ ] Add migrations
- [ ] Add recovery loaders
- [ ] Keep `SessionEntry.acp` compatibility projection

### ACP manager

- [ ] Integrate durable run/event persistence
- [ ] Integrate lease acquisition/release
- [ ] Integrate terminal result resolution
- [ ] Integrate recovery on startup

### Node transport

- [ ] Extend node command allowlist with ACP commands
- [ ] Add ACP node invoke commands
- [ ] Add ACP worker event handling on gateway
- [ ] Add lease epoch validation

### Node host / worker

- [ ] Add ACP capability advertisement
- [ ] Add local ACP worker host loop
- [ ] Adapt local runtime (`acpx`) to worker contract
- [ ] Add cancel/close/status/heartbeat support

### Backend integration

- [ ] Implement `acp-node` backend
- [ ] Register backend in runtime registry
- [ ] Add config wiring for backend selection and preferred node targeting

### Diagnostics / UX

- [ ] Add ACP doctor coverage for node-backed backend
- [ ] Add session/lease visibility in diagnostics
- [ ] Add clear operator errors for node selection / unsupported capability / lease loss

### Tests

- [ ] Unit tests for ACP store
- [ ] Unit tests for lease/fencing rules
- [ ] Integration tests with fake node worker
- [ ] Restart/recovery tests
- [ ] Duplicate terminal / cancel race tests
- [ ] One real end-to-end headless node-host flow

## Recommended next documents

After this document, the next design artifacts should be:

1. **ADR: Gateway-owned ACP with node-leased execution**
2. **ADR: ACP store as source of truth**
3. **Wire protocol spec: ACP-over-node worker commands/events**
4. **Detailed state machine spec: sessions, runs, leases, terminal resolution**
5. **Verification plan: exact test matrix and pass/fail proof strategy**

## Final recommendation

If OpenClaw wants the strongest possible long-term architecture for remote ACP execution, the target should be:

> **Gateway-owned ACP control plane, node-leased runtime execution, durable gateway event log, and ACP-native worker transport over the existing node WebSocket.**

That gives OpenClaw:

- a clean ACP backend story
- full alignment with the node model
- durable recovery/replay semantics
- policy-consistent remote execution
- future cross-node continuation potential without forcing node ownership into ACP session identity

It is the best high-level architecture to aim for before implementation begins.
