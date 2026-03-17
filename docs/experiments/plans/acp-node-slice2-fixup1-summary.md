# ACP Node Slice 2 Fixup 1 Summary

This fixup closes the slice-2 blockers without widening scope past the live control/reconnect seams.

## What changed

- added a real `acp-node` ACP runtime backend in `src/acp/runtime/acp-node.ts` and registered it from `src/gateway/server.impl.ts`, so the ACP manager/runtime path can now issue live `acp.session.ensure`, `acp.session.status`, `acp.turn.start`, `acp.turn.cancel`, and `acp.session.close` calls over the node transport
- reconnect reconcile now preserves worker-reported `cancelling` state instead of collapsing it back to `running`
- failed or malformed `acp.session.status` reconcile now fails safe to `lost` plus `status_mismatch` instead of leaving the lease stuck `suspect`
- unsupported `acp.worker.status` is now rejected explicitly on the live RPC seam
- RPC error classification now distinguishes gateway durability faults (`ACP_NODE_STORE_READ_FAILED` / `ACP_NODE_STORE_WRITE_FAILED`) from client-invalid ACP worker payloads

## What is now proven

- the live `acp-node` backend path can drive ensure/status/start/cancel/close through the real gateway runtime/backend seam
- reconnect recovery keeps `cancelling` when the worker reports it
- fatal status reconcile failures demote the lease to `lost`
- `acp.worker.status` is not silently acked and dropped
- store write/read failures surface as RPC `UNAVAILABLE`, while validation faults remain `INVALID_REQUEST`

## Remaining non-blocking gap

- the node-host ACP command module still uses scoped in-memory bookkeeping rather than the final real worker/runtime implementation, so the manager/backend seam is now live but the node-side worker execution path still needs a later slice
