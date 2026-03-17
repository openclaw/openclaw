---
summary: "Concise summary of the second slice-1 fixup closing stale-heartbeat, gateway disconnect/reconnect, and lease-expiry gaps"
title: "ACP Node Foundation Slice 1 Fixup 2 Summary"
---

# ACP Node Foundation Slice 1 Fixup 2 Summary

## What changed

- heartbeats now refresh lease metadata only for the session's current active or recoverable run; stale heartbeats from an older completed run are rejected before they can extend the lease or overwrite worker metadata
- gateway node disconnects now enter ACP recovery through the real websocket-close path, and same-node heartbeat ingress can reactivate a suspect lease and resume the current run without using the fake worker harness helper path
- suspect leases now have an implemented grace-expiry transition to `lost`, recording `lease_expired` on the session and non-terminal run and rejecting later reconcile attempts

## What is now proven

Focused suites:

- `src/acp/store/store.test.ts`
- `src/acp/store/gateway-events.test.ts`
- `src/gateway/server-node-events.acp.test.ts`

Targeted proofs added or tightened:

- stale heartbeat from a completed prior run is rejected and does not mutate the active lease
- gateway disconnect plus worker heartbeat reconnect recovers the run through the gateway seam before terminal acceptance resumes
- grace expiry moves a `suspect` lease to `lost` without auto-failover and blocks later reconcile on that lease

## Remaining non-blocking gaps

- slice 1 still has no background sweeper that automatically calls lease-expiry settlement on a timer; expiry is now implemented at the store boundary and enforced on relevant worker/reconcile traffic
- full `acp.session.status`-driven reconcile remains deferred beyond this slice; the current proof uses the live disconnect path plus heartbeat-backed same-node resume
