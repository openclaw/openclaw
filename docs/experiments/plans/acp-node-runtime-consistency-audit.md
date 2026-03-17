---
summary: "Post-synthesis consistency audit of the ACP node-backed runtime planning package, recording the resolved hardening decisions and the remaining intentionally deferred questions"
title: "ACP Node Runtime Consistency Audit"
---

# ACP Node Runtime Consistency Audit

## Scope

Audited together:

- `docs/experiments/plans/acp-node-runtime-program.md`
- `docs/experiments/plans/acp-node-backed-runtime.md`
- `docs/experiments/plans/acp-node-backed-runtime-protocol.md`
- `docs/experiments/plans/acp-node-backed-runtime-verification.md`

Overall assessment:

- the package is now internally coherent on the high-risk seams
- the remaining open items are deliberately about implementation tradeoffs, not protocol ambiguity

## Resolved hardening decisions

1. Terminal authority is now singular and deterministic.

- `acp.worker.event` is explicitly non-terminal
- `done` is rejected in v1
- `acp.worker.terminal` is the only terminal wire authority
- terminal candidates now carry `terminalEventId` and `finalSeq`
- canonical outcome is defined as the first valid terminal durably persisted for the run

2. Recoverable states and transitions are now explicit.

- session state includes `recovering`
- run state includes `starting` and `recovering`
- lease state includes `suspect`
- restart, disconnect-before-first-event, reconnect mismatch, and grace-window expiry all have named transitions and recovery reasons

3. The connect contract is now normalized.

- ACP nodes advertise `acp:v1`
- worker payloads must echo `nodeId`
- authenticated connection identity is the source of truth for lease ownership
- heartbeat is classified once as `node.event`, with polling delegated to `acp.session.status`

4. The v1 lease-expiry policy is now locked.

- disconnects and missed heartbeats move the lease to `suspect`
- same-node reconnect within a grace window may retain the current epoch after status reconcile
- the gateway does not auto-mint a new epoch during the grace window
- v1 does not automatically fail over an in-flight run to a different node

5. The first implementation slice now matches the proof bar.

- terminal resolution is no longer deferred out of the first real slice
- one explicit recoverable-state path is required in the first mergeable delivery
- the verification plan names the exact proof gate for the first serious implementation slice

## Remaining intentionally deferred questions

These are still open, but they are no longer blockers for implementation planning:

1. exact durable store backend and migration shape
2. how operator-facing recovery commands should surface in CLI/chat diagnostics
3. how aggressive node-selection heuristics should become after v1
4. how much of `acp.session.load` remains a wrapper over `ensure` in the first implementation while keeping the wire contract stable

## What Is Strong And Should Stay

1. The gateway-owned control-plane principle is consistently reinforced across the package and is the clearest strength of the design. The program, architecture, protocol, and verification docs all converge on the same durable-authority story instead of drifting into “smart node” semantics.

2. The implementation sequencing is still coherent. Store first, then leases/terminal rules, then transport, then worker, then backend integration, then recovery remains a defensible order.

3. The verification doc remains the strongest quality bar in the package. The failure-point injection section and the “wrong-but-plausible implementation” framing should stay intact.

## Recommended Edit Discipline

1. Preserve the locked terminal contract exactly as written.
2. Implement store and state-machine types with the explicit recoverable states already named in the docs.
3. Keep handshake validation strict around `acp:v1`, `nodeId`, and heartbeat semantics.
4. Treat the conservative v1 lease policy as normative until a later ADR changes it.
5. Hold the first mergeable implementation slice to the verification proof gate rather than the happy-path demo bar.
