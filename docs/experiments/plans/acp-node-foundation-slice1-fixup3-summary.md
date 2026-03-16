---
summary: "Concise summary of the third slice-1 fixup closing the restart grace-window and durable lost-state ingress gaps"
title: "ACP Node Foundation Slice 1 Fixup 3 Summary"
---

# ACP Node Foundation Slice 1 Fixup 3 Summary

## What changed

- restart recovery now refreshes the reconnect grace window for `suspect` leases, so a non-terminal run reloaded as `recovering` can still accept same-node reconcile or heartbeat resume after restart
- worker ingress now durably records `lost` / `lease_expired` before rethrowing the lease-expired rejection, so a failed heartbeat or reconcile can no longer leave persisted state stuck at `suspect`
- the focused restart proofs were tightened to cover fresh post-restart grace, same-node reconcile after restart, heartbeat resume after restart, and the previously missed path where expiry was enforced transiently but not persisted

## What is now proven

Focused suites:

- `src/acp/store/store.test.ts`
- `src/acp/store/gateway-events.test.ts`
- `src/gateway/server-node-events.acp.test.ts`

Targeted proofs added or tightened:

- restart reload gives a fresh grace window and same-node reconcile succeeds within that window
- same-node `acp.worker.heartbeat` resume succeeds after restart through worker ingress
- ingress-detected expiry writes durable `lost` / `lease_expired` state before rejecting the expired heartbeat

## Remaining non-blocking gaps

- slice 1 still does not have a background sweeper that advances expired `suspect` leases on a timer; expiry is now correct on restart load, explicit expiry sweep, and real ingress paths
- full `acp.session.status`-driven reconcile remains deferred beyond this slice; the current slice proves restart and reconnect behavior through the existing reconcile and heartbeat seams
