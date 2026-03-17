---
summary: "Concise synthesis summary for the ACP node-backed runtime planning hardening pass, including the locked decisions, remaining open items, and the exact recommended first implementation slice"
title: "ACP Node Runtime Synthesis"
---

# ACP Node Runtime Synthesis

## What changed

The planning set now locks the five seams that were still too loose for implementation:

1. terminal authority is singular: `acp.worker.terminal` is the only terminal wire signal in v1, `done` is rejected, and canonical terminal identity is based on `terminalEventId` plus `finalSeq`
2. recoverable states are explicit: session `recovering`, run `recovering`, and lease `suspect` are now part of the state machine and storage shape
3. the connect contract is normalized: ACP nodes advertise `acp:v1`, worker payloads echo `nodeId`, authenticated connection identity owns the lease, and heartbeat is event-only while polling remains `acp.session.status`
4. the v1 lease policy is conservative and deterministic: same-node reconnect may retain the epoch inside a grace window, but there is no automatic cross-node failover for an in-flight run
5. the first serious implementation slice is stronger: it must include terminal resolution, one recoverable-state flow, and proof-oriented tests rather than only happy-path event append

## What remains open

These are still open by design, but they are no longer blockers for implementation planning:

- exact durable store backend and migration details
- the operator-facing recovery surface in CLI/chat diagnostics
- post-v1 node-selection heuristics and richer failover policy
- how much `acp.session.load` can alias `ensure` internally in the first implementation while preserving the wire contract

## Recommended exact first implementation slice

Implement the smallest mergeable slice that proves gateway-owned correctness:

- durable ACP store for sessions, runs, events, checkpoints, idempotency, and leases
- explicit `recovering` / `suspect` state persistence plus restart loaders
- lease epoch fencing and `nodeId` validation at ACP event ingress
- `acp.worker.terminal` canonical resolution with `terminalEventId` + `finalSeq`
- fake ACP-capable node worker harness speaking real `node.invoke` / `node.event`
- proof tests for stale-epoch rejection, `done` rejection, duplicate-terminal idempotency, cancel-vs-complete determinism, disconnect-before-first-event recovery, and restart-after-checkpoint-gap replay

Defer real node-host ACP worker bring-up to the next slice. The gateway-side durable control plane needs to be proven first.
