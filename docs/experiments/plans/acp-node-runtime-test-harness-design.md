---
summary: "Concrete test-harness design for the ACP node-backed runtime, including fake worker strategy, restart/recovery harness, failure injection, exact test locations, and the first proof-producing slice"
read_when:
  - Implementing tests for the ACP node-backed runtime project
  - Deciding where fake ACP worker, restart, and e2e tests should live
  - Reviewing what must be built before node-backed ACP claims are believable
title: "ACP Node Runtime Test Harness Design"
---

# ACP Node Runtime Test Harness Design

## Purpose

This document defines the exact test-harness strategy for the ACP node-backed runtime effort.

It is intentionally concrete about:

- which test layers should exist
- where those tests should live
- which existing OpenClaw test patterns should be reused
- what new helpers/harnesses are worth creating
- how restart/recovery and failure injection should be tested
- what the first proof-producing slice should be

The goal is to keep the implementation honest:

> gateway-owned durability and lease fencing must be proven with deterministic tests before a real node-host smoke test is treated as meaningful.

## Existing repo patterns to reuse

We should build on the repo’s existing patterns instead of introducing a parallel test framework.

### ACP/runtime patterns already present

- `src/acp/control-plane/manager.test.ts`
  - good model for manager-focused state-transition tests using explicit dependency seams
- `src/acp/runtime/adapter-contract.testkit.ts`
  - good model for backend contract conformance tests
- `extensions/acpx/src/runtime.test.ts`
  - good model for runtime tests backed by a deterministic mock CLI
- `extensions/acpx/src/test-utils/runtime-fixtures.ts`
  - best existing pattern for a scripted subprocess-backed fixture that emits ACP-shaped events

### Gateway/node integration patterns already present

- `src/gateway/server.e2e-ws-harness.ts`
  - simple reusable gateway server harness
- `src/gateway/test-helpers.e2e.ts`
  - reusable real WebSocket client connection helpers, including node-role connections
- `src/gateway/server.roles-allowlist-update.test.ts`
  - strongest current example of real gateway plus node-role client interaction over `node.invoke` and `node.event`
- `src/gateway/server-node-events.test.ts`
  - good pattern for handler-level node event validation tests

### Restart/replay/temp-store patterns already present

- `src/test-utils/temp-dir.ts`
  - minimal temp-dir helper worth reusing directly
- `test/helpers/temp-home.ts`
  - strongest existing helper for isolated `HOME` and `OPENCLAW_STATE_DIR`
- `test/helpers/import-fresh.ts`
  - standard pattern for simulating reloads with a fresh module instance
- `extensions/voice-call/src/manager.restore.test.ts`
  - good pattern for restoring manager state from persisted disk state
- `extensions/nextcloud-talk/src/monitor.replay.test.ts`
  - good pattern for replay/idempotency assertions
- `extensions/voice-call/src/manager.test-harness.ts`
  - good pattern for a tiny domain-specific persistence harness

### Real e2e anchors already present

- `test/helpers/gateway-e2e-harness.ts`
  - strongest existing subprocess harness for spawning a real gateway process
- `test/gateway.multi.e2e.test.ts`
  - strongest existing proof that the repo already supports process-level gateway plus node-role pairing tests

Important note:

- `src/cli/program.nodes-basic.e2e.test.ts` and `src/cli/program.nodes-media.e2e.test.ts` are CLI-shaping tests backed by mocked `callGateway`; they are not the right anchor for ACP transport proof

## Test layering

The harness should be split into four layers.

### Layer 1: ACP store and state machine tests

Purpose:

- prove gateway-owned durability
- prove lease and terminal rules without transport noise

Location:

- `src/acp/store/*.test.ts`
- `src/acp/control-plane/manager.node-backed.*.test.ts`

Examples:

- `src/acp/store/store.persistence.test.ts`
- `src/acp/store/store.idempotency.test.ts`
- `src/acp/store/store.checkpoints.test.ts`
- `src/acp/store/store.leases.test.ts`
- `src/acp/control-plane/manager.node-backed.leases.test.ts`
- `src/acp/control-plane/manager.node-backed.terminal.test.ts`
- `src/acp/control-plane/manager.node-backed.recovery.test.ts`

These should be Tier 1 and almost fully in-process.

### Layer 2: Protocol integration tests with a fake ACP-capable node worker

Purpose:

- prove that gateway control operations map onto node traffic correctly
- prove worker event validation, sequence handling, fencing, and replay behavior

Location:

- `src/gateway/server-node-events.acp.test.ts`
- `src/gateway/server-methods/nodes.acp.test.ts`
- `src/acp/control-plane/manager.node-backed.protocol.test.ts`

These should use a scripted fake worker, not `vi.fn()` chains for every event.

### Layer 3: Restart/recovery harness tests

Purpose:

- prove restart semantics against a real on-disk ACP store
- prove exact crash-window behavior around event append, checkpoint writes, and terminal resolution

Location:

- `src/acp/control-plane/manager.node-backed.restart.test.ts`
- `src/acp/store/store.restart.test.ts`

These should recreate manager/store instances from disk, not merely clear in-memory maps.

### Layer 4: Real headless node-host e2e

Purpose:

- prove at least one path traverses the real gateway WS server, real node-role client, real `node.invoke`, and real `node.event`

Location:

- `src/node-host/acp-worker.e2e.test.ts`

This should be the only layer that treats the node host as a real running transport participant.

## Proposed new helpers and where they should live

### Shared ACP test helpers

Create a small ACP-specific test helper area:

- `src/acp/test-harness/fake-acp-node-worker.ts`
- `src/acp/test-harness/restart-harness.ts`
- `src/acp/test-harness/failpoints.ts`
- `src/acp/test-harness/store-harness.ts`

Keep this small and ACP-specific. Do not create a giant generic integration framework.

### `fake-acp-node-worker.ts`

Responsibility:

- deterministic fake worker brain
- understands ACP worker commands
- emits scripted `acp.worker.event`, `acp.worker.terminal`, disconnects, heartbeats, and duplicate/stale traffic

Recommended API shape:

```ts
type FakeWorkerScenarioStep =
  | { kind: "invokeResult"; command: string; payload: unknown }
  | {
      kind: "workerEvent";
      event: "acp.worker.event" | "acp.worker.terminal" | "acp.worker.heartbeat";
      payload: unknown;
    }
  | { kind: "disconnect" }
  | { kind: "reconnect" }
  | { kind: "delay"; ms: number };

type FakeAcpNodeWorker = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  enqueueScenario(sessionKey: string, steps: FakeWorkerScenarioStep[]): void;
  sentInvokes: Array<{ command: string; params: unknown }>;
  sentEvents: Array<{ event: string; payload: unknown }>;
};
```

Important rule:

- the fake worker should speak the same gateway-facing protocol as the real node host
- it should not bypass `node.invoke.request`, `node.invoke.result`, or `node.event`
- its event payloads should include the hardened v1 fields, especially `nodeId`, `terminalEventId`, `finalSeq`, and `workerProtocolVersion` where applicable

That is the difference between a useful fake and a misleading mock.

### `restart-harness.ts`

Responsibility:

- create a temp ACP store on disk
- boot ACP manager + gateway-side ACP pieces against that store
- stop them
- recreate them from the same store path
- let tests inject failures at named crash points

Recommended API shape:

```ts
type AcpRestartHarness = {
  storeDir: string;
  boot(): Promise<BootedHarness>;
  restart(): Promise<BootedHarness>;
  close(): Promise<void>;
};
```

Where `BootedHarness` exposes:

- current manager instance
- current store instance
- projector/checkpoint observer
- fake worker attachment helpers
- state snapshot helpers

Implementation note:

- when a test specifically needs a fresh module graph instead of a fresh instance, use `test/helpers/import-fresh.ts`

### `failpoints.ts`

Responsibility:

- deterministic crash/failure injection
- keep failure naming centralized and easy to audit

Recommended shape:

```ts
type AcpFailpointName =
  | "after-event-append"
  | "before-checkpoint-write"
  | "after-terminal-persist"
  | "after-cancel-accepted";
```

Implementation guidance:

- production code gets a noop failpoint controller by default
- tests inject an active controller through constructor deps
- avoid env-var failpoints and avoid `vi.spyOn(...).mockImplementationOnce(...)` as the main mechanism

### `store-harness.ts`

Responsibility:

- create test sessions/runs/leases/events/checkpoints against the real ACP store
- provide concise assertions for snapshots after reload

This should be a thin convenience layer, not a fake store.

## First proof-producing slice after hardening

The first mergeable test harness should be able to prove all of the following before a real node-host worker is in scope:

- `acp.worker.event` rejects `done`
- terminal uniqueness works through `terminalEventId` + `finalSeq`
- cancel-vs-complete is deterministic
- disconnect after accepted start moves the run to explicit `recovering`
- same-node reconnect within the grace window can retain the lease epoch after status reconcile
- restart after event append but before checkpoint write replays only the missing suffix

## Fake ACP-capable node worker design

The fake worker is the backbone of Tier 1 and Tier 2 testing.

### What it should emulate

It should emulate four things only:

1. ACP control invoke handling
2. worker event streaming
3. lease-epoch behavior
4. connection lifecycle

It does not need to emulate a full node host OS environment.

### Commands it must handle

- `acp.session.ensure`
- `acp.session.load`
- `acp.turn.start`
- `acp.turn.cancel`
- `acp.session.close`
- `acp.session.status`

### Events it must emit

- `acp.worker.event`
- `acp.worker.terminal`
- `acp.worker.heartbeat`

### Scenarios it must support

- happy-path stream: `seq=1..N` then terminal complete
- malformed payload
- duplicate `(runId, seq)`
- conflicting duplicate `(runId, seq)` with different payload
- stale epoch event after lease replacement
- stale lease id event
- duplicate terminal
- completion after cancel accepted
- disconnect before first event
- reconnect and replay old buffered events
- heartbeat from wrong epoch

### Why this should be scripted instead of mock-function-driven

The gateway behavior we need to prove is event-order-sensitive.

A scripted worker:

- makes order explicit
- makes failures reproducible
- is easier to reuse across many tests
- is much closer to the real `node.invoke`/`node.event` path

## Restart and recovery harness design

The restart harness should test real persisted state, not simulated “reload” on the same object graph.

### Minimum persisted artifacts that tests must observe

- ACP session record
- ACP run record
- accepted worker events
- lease record
- delivery checkpoint
- canonical terminal result
- idempotency record when relevant

### Required restart scenarios

- restart after lease acquisition but before turn starts
- restart during a non-terminal run
- restart after event append but before checkpoint write
- restart after terminal persistence but before projector notification
- restart after cancel accepted but before worker terminal arrives

### Assertion style

After restart, tests should assert both:

1. durable state is correct on disk reload
2. behavior after restart is correct when the worker reconnects or retries

Examples:

- old buffered `seq=2` is ignored after it was already persisted pre-restart
- missing projector checkpoint causes only the missing suffix to replay
- stale worker terminal after lease replacement is rejected

## Failure injection points

These should be explicit test seams in the implementation, because they are core to the architecture docs.

### Required failpoints

1. `after-event-append`
   - event is durable
   - projector checkpoint is not yet advanced

2. `before-checkpoint-write`
   - checkpoint update intent exists
   - durable checkpoint write has not happened yet

3. `after-terminal-persist`
   - canonical terminal is durable
   - final projector notification has not happened yet

4. `after-cancel-accepted`
   - gateway has recorded cancel intent / accepted worker cancel RPC
   - worker terminal resolution has not arrived yet

### Strongly recommended additional failpoints

- `after-lease-activate`
- `after-lease-replace`
- `before-stale-event-reject-log`

The first four are mandatory because they map directly to the verification plan’s required crash windows.

## Exact test placement

### ACP store tests

Place under:

- `src/acp/store/`

Recommended files:

- `src/acp/store/store.persistence.test.ts`
- `src/acp/store/store.leases.test.ts`
- `src/acp/store/store.events.test.ts`
- `src/acp/store/store.checkpoints.test.ts`
- `src/acp/store/store.restart.test.ts`

### ACP manager node-backed tests

Place under:

- `src/acp/control-plane/`

Recommended files:

- `src/acp/control-plane/manager.node-backed.protocol.test.ts`
- `src/acp/control-plane/manager.node-backed.leases.test.ts`
- `src/acp/control-plane/manager.node-backed.terminal.test.ts`
- `src/acp/control-plane/manager.node-backed.restart.test.ts`

### Gateway node transport tests

Place under:

- `src/gateway/`
- `src/gateway/server-methods/`

Recommended files:

- `src/gateway/server-node-events.acp.test.ts`
- `src/gateway/server-methods/nodes.acp.test.ts`

These should validate:

- capability gating
- command allowlist behavior
- malformed ACP worker events rejected before state mutation
- caller node id and lease ownership enforcement

### Node-host worker tests

Place under:

- `src/node-host/`

Recommended files:

- `src/node-host/acp-worker.test.ts`
- `src/node-host/acp-worker.runtime.test.ts`
- `src/node-host/acp-worker.e2e.test.ts`

The first two are unit/integration.
The last one is the real headless node-host path.

## Real headless node-host e2e path

The real e2e should prove the transport path, not necessarily a live external model provider.

### What should be real

- real gateway server
- real WebSocket connection
- real node-role client behavior
- real `node.invoke.request`
- real `node.invoke.result`
- real `node.event`
- real ACP manager/store path

### What can stay deterministic

- the local ACP-capable runtime under the node host

Best approach:

- reuse the `extensions/acpx/src/test-utils/runtime-fixtures.ts` pattern
- run the real node-host ACP worker against a deterministic mock ACP runtime fixture underneath

That gives:

- real gateway/node transport
- real node-host command dispatch and event emission
- deterministic local runtime output

### Recommended e2e file

- `src/node-host/acp-worker.e2e.test.ts`

### Recommended e2e shape

1. start gateway via `src/gateway/server.e2e-ws-harness.ts`
2. start a real headless node-host ACP worker loop in-process
3. have it connect with:
   - cap `acp`
   - commands `acp.session.ensure`, `acp.session.load`, `acp.turn.start`, `acp.turn.cancel`, `acp.session.close`, `acp.session.status`
4. configure it to use a deterministic mock ACP runtime fixture
5. run one prompt
6. assert streamed output and exactly one canonical terminal
7. run cancel
8. run close

This should be enough for the required real headless node-host proof.

### Optional later process-level lane

Once the in-process e2e is green, add a slower process-level lane using:

- `test/helpers/gateway-e2e-harness.ts`
- `test/gateway.multi.e2e.test.ts`

That lane is useful for final confidence, but it should not block the first proof-producing slice.

### What this e2e should not try to prove first

- restart crash-window correctness
- stale epoch races
- duplicate terminal handling

Those belong in the deterministic fake-worker and restart harness layers first.

## First proof-producing test slice

The first slice should not be the full e2e.

The first slice should prove the core claim:

> the gateway, not the node, is the durable authority for accepted ACP worker events and final delivery.

### First slice contents

Build this exact slice first:

1. real ACP store persistence test
2. fake worker happy-path manager integration test
3. restart-after-event-append test
4. stale-epoch rejection test

### Exact target files

- `src/acp/store/store.persistence.test.ts`
- `src/acp/control-plane/manager.node-backed.protocol.test.ts`
- `src/acp/control-plane/manager.node-backed.restart.test.ts`

### Exact scenarios

#### Scenario A: happy path with durable append

- acquire lease epoch 1
- `acp.turn.start` accepted
- worker emits `seq=1`, `seq=2`, terminal complete
- assert:
  - events persisted in order
  - terminal persisted once
  - checkpoint advanced once

#### Scenario B: restart after event append before checkpoint

- worker emits `seq=1`
- fail at `after-event-append`
- recreate manager/store
- replay projector
- assert:
  - `seq=1` is not duplicated in store
  - missing checkpoint causes exactly one replay of the missing suffix
  - final delivery still happens once

#### Scenario C: stale epoch rejection

- lease epoch 1 accepted
- lease replaced with epoch 2
- old worker emits event and terminal from epoch 1
- assert:
  - stale messages rejected
  - epoch 2 remains authoritative

### Why this is the right first slice

It proves the hardest architectural claims early:

- durable gateway ownership
- replay correctness
- lease fencing
- terminal uniqueness foundation

If this slice is weak, a later e2e will be mostly theater.

## Implementation order

1. Add ACP store test harness and persistence tests.
2. Add failpoint controller and restart harness.
3. Add fake ACP node worker and manager protocol tests.
4. Add gateway node ACP validation tests.
5. Add real headless node-host e2e.

## Final recommendation

Use one deterministic fake worker harness for most proof and one real node-host e2e for transport confidence.

Do not lead with the e2e.
Lead with the durable store, failpoints, and stale-worker tests, then add the real node-host lane once the gateway-owned control plane is already proven.
