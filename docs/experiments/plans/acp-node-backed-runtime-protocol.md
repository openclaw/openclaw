---
summary: "Detailed OpenClaw-internal ACP-over-node worker protocol built on node.invoke + node.event, with leases, fencing, sequencing, terminal semantics, and recovery rules"
read_when:
  - Implementing the node-backed ACP worker transport
  - Extending node.invoke / node.event for ACP-native execution
  - Designing lease epochs, sequence numbering, and terminal-result rules
  - Writing fake-node integration tests for ACP-over-node
  - Reviewing protocol invariants before implementation
title: "ACP Node-Backed Runtime Protocol"
---

# ACP Node-Backed Runtime Protocol

## Purpose

This document specifies the **internal OpenClaw transport contract** between the gateway ACP control plane and a node-hosted ACP worker.

It is intentionally **not** an external public ACP transport standard. The external ACP-facing semantics remain whatever OpenClaw exposes through its ACP translator/server. This protocol only governs how the gateway and nodes coordinate ACP execution over the existing Gateway WebSocket.

## Scope

This protocol covers:

- node capability advertisement for ACP worker support
- gateway-to-node worker control messages
- node-to-gateway worker event messages
- lease and fence semantics
- sequencing and replay authority
- terminal-result rules
- heartbeat and recovery behavior

It does **not** cover:

- user-facing ACP API design
- workspace portability semantics
- OpenClaw delivery projector format
- general-purpose node event transport outside ACP worker execution

## Transport substrate

Use the existing Gateway WebSocket protocol and node role.

No new frame types are required.

### Existing frames used

- gateway → node control: existing `node.invoke.request` event produced by `node.invoke`
- node → gateway RPC result: existing `node.invoke.result`
- node → gateway worker stream/status signals: existing `node.event`

This means the ACP-over-node protocol is layered on top of:

- `node.invoke`
- `node.invoke.result`
- `node.event`

## Capability advertisement

A node that supports ACP worker execution must connect with:

```json
{
  "role": "node",
  "caps": ["acp"],
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

Optional future commands:

- `acp.session.release`
- `acp.session.snapshot`
- `acp.worker.heartbeat`
- `acp.runtime.doctor`

## Shared identifiers

The following identifiers are used throughout the protocol.

### `sessionKey`

The canonical OpenClaw ACP session identity.

Properties:

- assigned by gateway
- globally authoritative from the gateway perspective
- never derived from node-local runtime identity

### `runId`

The canonical gateway-owned ACP run/turn identity.

Properties:

- assigned by gateway
- unique per session turn
- used for event stream partitioning and deduplication

### `leaseId`

Opaque identifier for a node execution lease.

Properties:

- assigned by gateway
- unique per lease acquisition
- node must echo it on every lease-bound event

### `leaseEpoch`

Monotonic integer fence for the session executor.

Properties:

- gateway-assigned
- increments whenever the gateway replaces or re-acquires execution ownership
- all node worker messages for a leased session must carry this value
- stale epochs are rejected

### `requestId`

Gateway-side idempotency key for a turn or control operation.

### `seq`

Monotonic integer sequence number within a single `runId` event stream.

Properties:

- starts at `1` for the first emitted worker event of a run
- strictly increasing
- unique within `(runId, seq)`

## Control operations

All control operations are sent via `node.invoke`.

General form:

```json
{
  "nodeId": "...",
  "command": "acp.*",
  "params": { ... },
  "idempotencyKey": "..."
}
```

## `acp.session.ensure`

### Purpose

Ensure that the node has local runtime-side state for the gateway session and active lease. This may create a local runtime session or re-bind to existing local session material.

### Gateway request payload

```json
{
  "sessionKey": "agent:main:acp:...",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "agent": "main",
  "mode": "persistent",
  "cwd": "/workspace/path",
  "runtimeOptions": {
    "runtimeMode": "plan",
    "model": "...",
    "permissionProfile": "...",
    "timeoutSeconds": 120
  },
  "resume": {
    "kind": "none | node-runtime-id | gateway-reconstruct",
    "runtimeSessionId": "optional"
  }
}
```

### Node result payload

```json
{
  "ok": true,
  "sessionKey": "...",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "nodeRuntimeSessionId": "local-runtime-id",
  "nodeRuntimeInfo": {
    "kind": "acpx",
    "cwd": "/workspace/path",
    "capabilities": {
      "supportsCancel": true,
      "supportsStatus": true,
      "supportsMode": true,
      "supportsConfigOptions": true
    }
  }
}
```

### Invariants

- node must bind local runtime state to the exact `leaseId` + `leaseEpoch`
- node must not accept events from older leases for the same `sessionKey`
- gateway treats the result as advisory until stored durably

## `acp.session.load`

### Purpose

Reconstruct node-local runtime state for an existing gateway session when resuming or moving execution.

### Notes

This is separate from `ensure` so future implementations can explicitly distinguish:

- create-or-bind local runtime state
- reconstruct from gateway authority

First implementation may internally alias `load` to `ensure` if needed, but the protocol should reserve both concepts.

## `acp.turn.start`

### Purpose

Start exactly one run on an ensured leased session.

### Gateway request payload

```json
{
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "requestId": "idem-123",
  "mode": "prompt",
  "text": "...",
  "attachments": [
    {
      "mediaType": "image/png",
      "data": "base64..."
    }
  ]
}
```

### Node result payload

This is only the immediate RPC result, not the final turn result.

```json
{
  "ok": true,
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "accepted": true,
  "nodeWorkerRunId": "worker-run-abc"
}
```

### Invariants

- `acp.turn.start` returning `accepted=true` means the node accepted responsibility to emit worker events or a terminal failure
- it does **not** mean the run completed
- at most one active run is allowed per session unless future protocol revision explicitly supports more

## `acp.turn.cancel`

### Purpose

Request cancellation of the active run associated with the given lease epoch.

### Gateway request payload

```json
{
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "reason": "abort-signal"
}
```

### Node result payload

```json
{
  "ok": true,
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "accepted": true
}
```

### Important rule

Cancellation acceptance does not decide the canonical terminal result. The gateway resolves whether the run ends as `cancelled`, `completed`, or `failed`.

## `acp.session.close`

### Purpose

Release node-local runtime resources for the given session and lease.

### Important rule

Closing local runtime resources does not delete gateway session records.

## `acp.session.status`

### Purpose

Obtain runtime-side status and identity hints during reconcile/recovery.

### Node result payload sketch

```json
{
  "ok": true,
  "sessionKey": "...",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "state": "idle | running | missing | error",
  "nodeRuntimeSessionId": "...",
  "nodeWorkerRunId": "...",
  "details": {
    "summary": "..."
  }
}
```

## Worker event emission

Nodes emit worker events using `node.event`.

General form:

```json
{
  "event": "acp.worker.event | acp.worker.terminal | acp.worker.heartbeat | acp.worker.status",
  "payload": { ... }
}
```

## `acp.worker.event`

### Purpose

Stream append-only ACP run events to the gateway.

### Payload

```json
{
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "seq": 7,
  "event": {
    "type": "text_delta",
    "stream": "output",
    "text": "hello"
  }
}
```

### Accepted event types

Initial normalized event set should match the ACP runtime event vocabulary already present in core as closely as possible:

- `text_delta`
- `status`
- `tool_call`
- `error`
- `done`

### Invariants

- events must be in-order by `seq`
- gateway persists each event before advancing projector checkpoints
- duplicate `(runId, seq)` may be ignored idempotently if payload matches, otherwise rejected as corruption

## `acp.worker.terminal`

### Purpose

Emit an explicit terminal outcome candidate for the run.

### Payload

```json
{
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "terminal": {
    "kind": "completed | failed | cancelled",
    "stopReason": "optional",
    "errorCode": "optional",
    "errorMessage": "optional"
  }
}
```

### Important rule

The gateway does **not** accept this blindly.

The gateway determines whether this terminal event becomes canonical based on:

- lease epoch validity
- run state
- prior terminal result existence
- cancel-vs-complete resolution rules
- any required final event ordering checks

## `acp.worker.heartbeat`

### Purpose

Keep the lease alive and expose node runtime liveness.

### Payload

```json
{
  "sessionKey": "...",
  "runId": "run-123",
  "leaseId": "lease-123",
  "leaseEpoch": 4,
  "state": "idle | running | cancelling",
  "nodeRuntimeSessionId": "...",
  "nodeWorkerRunId": "...",
  "ts": 1740000000000
}
```

### Rules

- heartbeat extends the lease liveness window
- heartbeat does not append to the ACP user-visible transcript
- heartbeat may trigger reconcile logic if gateway state disagrees with worker state

## `acp.worker.status`

### Purpose

Push an asynchronous runtime status update outside normal run-event flow.

This is optional and lower priority than `acp.worker.event` and `acp.worker.heartbeat`.

## Fencing rules

These are non-negotiable.

## Rule 1 — stale epoch rejection

If `leaseEpoch` in a worker message is not the currently active epoch for the session/run, the gateway rejects the message.

## Rule 2 — stale lease id rejection

If `leaseId` does not match the active lease for the epoch, reject.

## Rule 3 — run binding

A worker event with `runId` must belong to the active or recoverable run known by the gateway. Unknown runs are rejected unless the gateway is explicitly in a reconcile flow that expects them.

## Rule 4 — sequence monotonicity

For a given run:

- first accepted event must be `seq=1`
- subsequent events must be next expected sequence unless the gateway is explicitly replaying/repairing
- duplicates may be tolerated only if byte-equivalent / payload-equivalent

## Rule 5 — terminal uniqueness

A run has at most one canonical terminal outcome.

Later terminal candidates from the same or stale lease may be:

- ignored as duplicates
- rejected as stale
- logged as conflict

## Canonical terminal resolution

### Why this matters

Workers can race with:

- cancel requests
  n- reconnects
- gateway restart
- stale workers finishing late

So the gateway must have deterministic terminal resolution rules.

## Recommended precedence rules

1. reject any terminal candidate from stale lease epoch
2. if canonical terminal already exists, ignore duplicates unless they conflict, in which case log conflict
3. if cancel has been requested but no terminal decided yet:
   - accept the earliest valid durable winner according to persisted ordering/rules
   - do not special-case cancellation into always winning unless policy explicitly says so
4. persist canonical terminal before marking run done to projectors

## Idempotency rules

## Gateway control operations

`node.invoke` calls for ACP worker commands must use idempotency keys.

These keys prevent duplicate worker-start and cancel operations during retry.

## Event append idempotency

Use `(runId, seq)` as the primary idempotency identity for worker events.

## Terminal idempotency

Terminal outcome should be idempotent on `(runId, leaseEpoch, terminal-kind, final-seq?)` or a dedicated terminal event id.

## Recovery model

## Replay authority

The **gateway ACP store** is the replay authority.

This is critical.

The node transport itself does not become a replay layer. The gateway stores accepted worker events durably and replays from there to projectors or ACP-facing consumers.

## Gateway restart

After restart, the gateway reloads:

- open sessions
- non-terminal runs
- active/recent leases
- event log and delivery checkpoints

Then it reconciles with connected nodes via `acp.session.status` or lease heartbeat state.

## Node reconnect

When a node reconnects, the gateway may:

- resume accepting heartbeat and events if lease is still current
- mark the node stale and reject old worker events if lease has been replaced
- ask for status and decide whether to continue, recover, or abandon the lease

## Error model

### Recoverable transport errors

Examples:

- node temporarily disconnected
- invoke timeout with unknown worker state
- duplicate event from retry

These should push the run into explicit recoverable states, not silent failure.

### Non-recoverable worker errors

Examples:

- worker rejects required command
- node no longer advertises ACP capability for the leased session
- malformed event payloads
- repeated sequence corruption

These should transition run/session to explicit error states and surface diagnostic information.

## Versioning strategy

The ACP-over-node protocol should be versioned explicitly.

Recommended shape:

- include protocol version in ACP worker capability advertisement, e.g. `acp:v1`
- reserve room for `workerProtocolVersion` in status payloads

This avoids hidden breakage between gateway and node releases.

## Backward-compatibility strategy

Node ACP worker support is additive.

Nodes without ACP capability continue working normally for existing node features.

Gateway behavior:

- if selected node lacks ACP support, fail with clear backend-unavailable / capability-missing error
- do not silently fall back to `system.run` as a production transport

## Security and policy requirements

1. node must be paired and authenticated through existing gateway node model
2. node claimed ACP commands are still subject to server-side allowlist/policy validation
3. gateway remains the authority on which node may run ACP for a given session
4. worker messages are accepted only from the connected node that owns the active lease

## Test-critical protocol cases

The protocol is not ready unless these cases are implemented and tested:

1. duplicate `acp.turn.start` retry with same idempotency key
2. duplicate `(runId, seq)` worker event
3. stale `leaseEpoch` worker event after failover
4. `acp.worker.terminal` received twice
5. `acp.turn.cancel` and terminal completion race
6. node disconnect after accepted start but before first event
7. gateway restart after persisting events but before projector checkpoint update
8. node reconnect with old buffered events from a prior epoch

## Recommended implementation order

1. versioned protocol structs/types
2. lease epoch validation
3. event append + sequence enforcement
4. terminal resolution path
5. heartbeats and reconcile flows
6. diagnostics / structured logging

## Final protocol principle

> **The node reports runtime activity; the gateway decides what is canonical.**

That principle should guide every message type, recovery rule, and race-resolution decision in this protocol.
