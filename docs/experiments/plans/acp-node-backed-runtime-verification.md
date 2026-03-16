---
summary: "Verification contract and test matrix for the ACP node-backed runtime architecture, covering store correctness, lease fencing, recovery, replay, and end-to-end worker execution"
read_when:
  - Planning tests for ACP node-backed runtime work
  - Deciding what proofs are required before implementation is considered done
  - Reviewing recovery/replay/fencing correctness claims
  - Designing fake-node harnesses and real node-host end-to-end tests
title: "ACP Node-Backed Runtime Verification Plan"
---

# ACP Node-Backed Runtime Verification Plan

## Purpose

This document defines the verification contract for implementing the ACP node-backed runtime architecture.

The intent is to prevent a superficially working implementation from being accepted without proving the behaviors that actually matter:

- durable event ownership on the gateway
- lease/fencing correctness
- deterministic terminal-result resolution
- recovery/replay after restart or reconnect
- correct node capability/policy integration

This plan is deliberately biased toward **execution-backed verification** rather than conceptual sign-off.

## Verification goals

The implementation is only acceptable if we can prove all of the following:

1. ACP durable state is gateway-owned
2. node-local execution can stream runtime events without becoming the source of truth
3. stale workers cannot win after failover
4. duplicate or replayed worker events do not duplicate delivery
5. gateway restart and node reconnect preserve correctness
6. the backend fits into existing ACP semantics cleanly
7. node policy/capability checks fail safely and clearly

## Locked v1 contract assumptions

These planning decisions are part of the verification contract:

- `acp.worker.terminal` is the only terminal wire authority; `acp.worker.event` must reject `done`
- ACP-capable nodes must advertise `acp:v1`
- worker payload `nodeId` must match the authenticated connection identity and active lease owner
- heartbeats are `node.event` messages only; pollable status uses `acp.session.status`
- disconnect or missed heartbeats move the lease to `suspect` and the run to `recovering`
- same-node reconnect within the grace window may keep the current epoch; v1 does not automatically fail over an in-flight run to another node

## Tiering model

### Tier 1 — Autonomous, required

Fully automated checks with deterministic pass/fail criteria.

These are required for:

- ACP store correctness
- lease epoch fencing
- duplicate event handling
- canonical terminal result resolution
- restart recovery from durable state
- node reconnect behavior where deterministic simulation is possible

### Tier 2 — Strong proxy, required where full Tier 1 is impractical

Automated checks with known limitations.

Allowed for:

- some real-node timing behaviors that are hard to make fully deterministic in CI
- some platform-specific node client details outside the headless node-host path

### Tier 3 — Human-minimal

Only acceptable for:

- one final smoke-validation artifact if needed on a real device UI path

Target review time:

- under 2 minutes

The first implementation should strive to keep almost everything in Tier 1 by using a fake ACP-capable node worker harness and at least one real headless node-host e2e.

## Deliverables and required proofs

## Deliverable A — ACP durable store

### Required proof

Tier 1 tests must prove:

1. sessions, runs, events, checkpoints, idempotency, and leases persist across reload
2. event append is deterministic and ordered
3. duplicate event ids or duplicate `(runId, seq)` do not corrupt state
4. recovery loaders reconstruct active/non-terminal state correctly

### Wrong-but-plausible implementation to guard against

- writes session metadata durably but leaves run events in memory
- persists events but not checkpoints, causing duplicate delivery after restart
- accepts duplicate `(runId, seq)` and silently appends duplicates

### Required tests

- create session/run/event/checkpoint, reload store, verify exact state
- append seq 1,2,3 then reject or idempotently absorb duplicate 2
- persist terminal result then reload and verify canonical state remains unchanged
- persist checkpoint before/after events and verify replay cursor is correct

## Deliverable B — Lease/fencing model

### Required proof

Tier 1 tests must prove:

1. only one active lease exists per session at a time
2. stale epoch events are rejected
3. stale lease ids are rejected
4. lost/replaced lease cannot produce canonical terminal state afterward

### Wrong-but-plausible implementation to guard against

- checks `nodeId` only and forgets epoch fencing
- replaces lease record but still accepts old buffered events
- cancels old worker but allows late completion to mark run completed

### Required tests

- acquire lease epoch 1, replace with epoch 2, send epoch 1 event → reject
- epoch 2 terminal accepted, epoch 1 terminal later arrives → reject/ignore as stale
- two overlapping lease acquisitions race → exactly one wins, other is not active

## Deliverable C — ACP-over-node protocol integration

### Required proof

Tier 1 tests must prove:

1. node capability advertisement gates backend availability
2. gateway control operations map correctly onto node invokes
3. worker events are normalized and persisted correctly
4. malformed or incomplete worker payloads fail safe

### Wrong-but-plausible implementation to guard against

- silently falls back to non-ACP node behavior
- accepts worker events without run/session/lease identifiers
- persists events before validating fencing metadata

### Required tests

- node without `acp:v1` cap cannot be selected for `acp-node`
- node with missing required command set is rejected clearly
- worker payload with mismatched `nodeId` is rejected before state mutation
- `acp.worker.event` with `done` type is rejected before persistence
- malformed `acp.worker.event` payload returns structured error and does not mutate state
- `acp.turn.start` accepted result without follow-up events leaves run in recoverable state, not falsely completed

## Deliverable D — Canonical terminal-result resolution

### Required proof

Tier 1 tests must prove:

1. a run has exactly one canonical terminal outcome
2. duplicate terminal signals do not duplicate projector/delivery behavior
3. cancel-vs-complete races resolve deterministically
4. stale-terminal events are rejected

### Wrong-but-plausible implementation to guard against

- whichever terminal arrives last wins
- both cancel and complete paths publish terminal delivery
- terminal event updates run state in memory only and not durably

### Required tests

- complete then duplicate complete → one canonical terminal only
- terminal without `terminalEventId` or `finalSeq` is rejected
- duplicate terminal with same `terminalEventId` is idempotent
- conflicting terminal with different `terminalEventId` after canonical winner exists is rejected
- cancel request then valid complete from active epoch → deterministic result according to chosen policy
- stale epoch complete after new lease → rejected
- terminal persisted before delivery checkpoint update, restart, replay → no duplicate final message

## Deliverable E — Recovery and replay

### Required proof

Tier 1 tests must prove:

1. gateway restart during a non-terminal run reloads recoverable state correctly
2. delivery replay resumes from durable checkpoints
3. node reconnect does not duplicate previously accepted events
4. unknown worker state after disconnect transitions to explicit recovery path

### Wrong-but-plausible implementation to guard against

- restart forgets active run and marks session idle
- replay starts from seq 1 again despite existing checkpoint
- reconnecting node replays buffered events that duplicate prior accepted output
- disconnect mid-run gets converted into success because no error was received

### Required tests

- persist run/events/checkpoint, restart manager, verify resumed state and replay cursor
- reconnect node and resend already-accepted seqs → no duplicated append or projection
- disconnect after `acp.turn.start` accepted but before first event → run becomes `recovering` with explicit reason, never completed
- same-node reconnect within grace window keeps the lease epoch after successful status reconcile
- grace-window expiry marks lease `lost` and does not auto-reassign the in-flight run to a different node
- restart after event append but before projector checkpoint → projector replays exactly missing suffix

## Deliverable F — Headless node-host worker e2e

### Required proof

At least one Tier 1 or strong Tier 2 end-to-end flow must prove:

1. paired node host advertises ACP capability
2. gateway selects it for `acp-node`
3. one real turn executes remotely
4. output is projected through normal OpenClaw ACP flow
5. cancel and close work end-to-end

### Wrong-but-plausible implementation to guard against

- fake integration that never really traverses node invoke/event path
- local fallback accidentally executes instead of the node worker
- node worker works only for prompt, but status/cancel/close silently no-op

### Required tests

- real headless node-host starts and connects with ACP commands
- one prompt turn returns streamed output and canonical terminal result
- cancel path stops the turn and produces deterministic terminal state
- session close tears down worker-side runtime state

## Harness requirements

## Fake ACP node worker harness

A deterministic fake worker is required.

It should support scripted scenarios such as:

- happy-path streaming
- worker error before first event
- disconnect after accepted start
- duplicate event replay
- stale epoch event emission
- double terminal emission
- delayed completion after cancel request
- reconnect followed by replay of old buffered events

This fake worker is the backbone of Tier 1 verification.

## Persistence/restart harness

A restart harness is required that can:

- start gateway ACP manager with temp ACP store
- execute scenario up to a controlled crash point
- fully recreate manager/store from disk
- continue scenario after restart
- assert exact resulting state and replay behavior

## Required failure-point injection

We need explicit crash/failure injection points for:

1. after event append, before checkpoint update
2. after checkpoint update intent, before durable checkpoint write
3. after terminal persistence, before projector notify
4. after cancel request accepted, before worker terminal response

Without these, restart/replay claims will be weak.

## Test matrix

## Store matrix

- [ ] session persists
- [ ] run persists
- [ ] event persists
- [ ] checkpoint persists
- [ ] lease persists
- [ ] idempotency replay works

## Lease matrix

- [ ] acquire active lease
- [ ] replace active lease
- [ ] move active lease to `suspect`
- [ ] reject stale epoch event
- [ ] reject stale lease id event
- [ ] same-node reconnect within grace keeps epoch
- [ ] grace expiry marks lease lost without auto-failover
- [ ] release active lease
- [ ] recover lost lease state

## Event matrix

- [ ] seq starts at 1
- [ ] seq monotonic append
- [ ] duplicate seq idempotent/rejected as designed
- [ ] malformed event rejected
- [ ] wrong runId rejected
- [ ] wrong sessionKey rejected

## Terminal matrix

- [ ] complete once
- [ ] duplicate complete
- [ ] fail once
- [ ] cancel once
- [ ] cancel-vs-complete race
- [ ] stale terminal after lease replacement

## Recovery matrix

- [ ] restart while idle lease exists
- [ ] restart during running turn
- [ ] restart after last event before checkpoint
- [ ] restart after terminal before projector completion
- [ ] node reconnect same epoch
- [ ] node reconnect stale epoch
- [ ] node disconnect before first event

## Policy matrix

- [ ] node lacks `acp` cap
- [ ] node lacks one required ACP command
- [ ] node policy disallows selected command
- [ ] requested node unavailable
- [ ] requested node connected but lease acquisition fails

## Human-minimal review artifact (only if needed)

If one final manual check is still desired, the artifact should be:

- one log or transcript showing:
  - selected node id
  - accepted `acp.turn.start`
  - worker event stream
  - canonical terminal result
  - no duplicate final projection after replay/reconnect test

Pass criteria:

1. all expected steps appear once
2. selected node is clearly shown
3. terminal result appears once
4. replay/reconnect scenario does not duplicate final output

Estimated human review time:

- under 2 minutes

## Blocking conditions

The feature must not be considered done if any of the following are missing:

1. no deterministic stale-epoch rejection test
2. no restart/recovery test around checkpoints
3. no duplicate-terminal test
4. no end-to-end headless node-host test
5. no proof that the gateway, not the node, is the durable replay authority

## Recommended test implementation order

1. ACP store unit tests
2. lease/fencing unit tests
3. fake worker protocol integration tests
4. terminal race tests
5. restart/recovery tests
6. real headless node-host e2e

## First merge slice proof gate

The first serious implementation slice is not ready to merge unless it proves all of the following:

1. durable ACP store reload for sessions, runs, events, checkpoints, and leases
2. stale epoch and stale `nodeId` rejection before mutation
3. `acp.worker.event` rejects `done`
4. canonical terminal uniqueness with `terminalEventId` + `finalSeq`
5. deterministic cancel-vs-complete handling
6. one explicit recoverable-state path for disconnect before first event
7. one restart-after-checkpoint-gap replay proof

## Final verification principle

> **Do not accept “it streamed on my machine once” as proof.**
>
> The implementation is only done when restart, reconnect, duplication, stale-worker, and cancel-race behavior are all execution-backed and deterministic.
