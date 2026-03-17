---
summary: "Builder-defense note for ACP node-runtime slice 1: proven behavior, deliberate deferrals, scope rationale, remaining risks, and review commits"
title: "ACP Node Foundation Slice 1 Builder Defense"
---

# ACP Node Foundation Slice 1 Builder Defense

## What this slice actually proves

This slice proves the gateway-side control-plane foundation for a node-backed ACP runtime in a minimal but real form.

Specifically, it proves:

- the gateway can durably persist ACP node-runtime session, run, event, lease, checkpoint, and idempotency state
- the gateway can reload that state from disk and preserve canonical run/session truth
- worker ingress is fenced by active `leaseId`, `leaseEpoch`, `nodeId`, and `runId`
- stale-epoch worker traffic is rejected before mutating durable state
- `acp.worker.event` is non-terminal only, and `done` is rejected
- `acp.worker.terminal` is the sole terminal wire authority and yields exactly one canonical terminal outcome per run
- a recoverable-state path exists: disconnect after start/lease ownership moves the lease to `suspect` and the run/session to `recovering`
- the gateway-side proof runs through the real node-event handler seam, not just an isolated store API

## What this slice intentionally does not do yet

This slice does not attempt to finish the full node-backed runtime.

It intentionally does not yet include:

- the real node-host ACP worker implementation
- ACP control operations over `node.invoke` such as real `acp.turn.start` orchestration
- projector replay from durable ACP state into normal user-facing ACP delivery
- manager-wide refactoring to make the dedicated ACP store the sole authority for all existing ACP runtime flows
- reconnect reconciliation beyond the first recoverable-state foundation
- operator-facing doctor/status surfacing for the new ACP node-runtime state

Those pieces are deferred because the first mergeable risk is gateway-owned correctness, not worker process orchestration.

## Why this scope and order are correct

The architecture docs lock the gateway as the durable source of truth and the node as a leased executor. That means the first meaningful slice has to prove gateway-owned persistence and fencing before a real worker is worth integrating.

Doing the work in this order is correct because:

- it validates the hardest invariants first: durability, stale-worker rejection, and canonical terminal resolution
- it avoids coupling the first proof to node-host process-management details
- it gives the future real node worker a concrete gateway contract to implement against
- it keeps the slice small enough to test deterministically
- it prevents a misleading “remote prompt worked once” milestone from being mistaken for architectural correctness

## Current remaining risks

The main remaining risks after this slice are:

- the ACP manager still needs to adopt the durable store more broadly instead of relying on existing live-runtime control flow
- durable projector/checkpoint replay into normal ACP delivery is not wired yet
- reconnect, retry, and cancel-vs-complete behavior still need broader end-to-end proofs once real `node.invoke` control operations exist
- the real node-host worker may surface protocol gaps that the fake worker does not
- build-health is not fully green yet because `pnpm build` currently fails in the existing Bun pipeline with `Cannot find module './cjs/index.cjs' from ''`

That last failure appears unrelated to this slice because it is a generic Bun/module-resolution failure, not a TypeScript or ACP-slice compile failure, and `pnpm tsgo` passes on the current branch.

## Final commits for review

Review this slice as these commits:

- `bf0d9761f` `ACP: add durable gateway store foundation`
- `9a2feff5d` `ACP: ingest worker node events on the gateway`
- `184e56d72` `ACP: tighten gateway store typing and tests`
- `791c75b9f` `ACP: add gateway worker ingress proofs`
