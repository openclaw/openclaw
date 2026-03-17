# ACP Node Slice 2 Fixup 2 Summary

This fixup stays on the slice-2 backend path and closes the remaining adversary blockers without widening scope past the runtime/store seam.

## What changed

- `src/acp/runtime/acp-node.ts` no longer reuses `suspect` leases blindly:
  - same-node reuse now requires a successful `acp.session.status` reconcile plus durable `reconcileSuspectLease(...)`
  - incoherent or failed status reconcile now marks the lease `lost` with `status_mismatch` and fails `ensureSession()` instead of returning an unusable handle
  - `suspect` leases are not silently reassigned to a different node during `ensureSession()`
- rejected or failed `acp.turn.start` now settles the already-created durable run through a synthetic failed terminal, so the session returns to idle and later turns are not wedged behind a zombie `accepted` run
- active-turn cancel now records durable cancel intent before terminal resolution:
  - `src/acp/store/store.ts` adds `recordCancelRequested(...)` to move the run to `cancelling` and stamp `cancelRequestedAt`
  - `src/acp/runtime/acp-node.ts` uses that path after accepted `acp.turn.cancel`
  - `runTurn()` no longer converts the manager’s active-turn cancel abort into an immediate `ACP operation aborted.` failure; it waits for the canonical terminal outcome

## What is now proven

- `ensureSession()` only reuses a reconnecting lease after coherent same-node status reconcile, and fails safe when reconcile is missing or incoherent
- rejected `acp.turn.start` produces a durable failed terminal and leaves the session able to start a later turn
- active-turn cancel reaches `cancelling` durably and completes on the worker’s cancelled terminal instead of surfacing an abort-style runtime error

## Verification

- `pnpm test -- src/node-host/invoke-acp.test.ts src/acp/store/store.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
- `pnpm tsgo`
- `pnpm build`
  - still fails with the same unchanged Bun/module-resolution error: `Cannot find module './cjs/index.cjs' from ''`

## Remaining non-blocking gap

- the node-host ACP command surface is still a slice-local bookkeeping implementation rather than the later full worker/runtime backend, but the slice-2 gateway/backend path no longer has the three blocking lifecycle holes from the adversary review
