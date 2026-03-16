# ACP Node Slice 3 Summary

Reviewed head for this slice:

- `573aa1a58` `ACP: add real node-host worker bridge`

## What slice 3 changed

- replaced the slice-local ACP bookkeeping path in `src/node-host/invoke-acp.ts` with a real node-host worker bridge
- node-host `acp.session.ensure` and `acp.session.load` now acquire a real local ACP runtime handle instead of fabricating local session state
- node-host `acp.turn.start` now starts a real local runtime turn in the background, returns `accepted=true`, and emits canonical `acp.worker.event` and `acp.worker.terminal` payloads over the existing node event transport
- node-host `acp.turn.cancel`, `acp.session.status`, and `acp.session.close` now delegate to the real local runtime contract instead of mutating a fake local state machine
- the node-host ACP path now lazily bootstraps local ACP runtime services so a real backend such as `acpx` can back the worker contract
- added the carried-forward direct regression proof for the `requestCancel()` suppression branches in `src/acp/runtime/acp-node.ts`

## What this slice proves

- the accepted slice-2 gateway/runtime seam is now paired with a real node-host worker/runtime-backed command surface, not just gateway-side transport plumbing
- a node-hosted ACP turn can be ensured, started, streamed, cancelled, status-checked, and closed through the live worker protocol shape expected by the gateway
- `requestCancel()` now has committed direct coverage for both suppression branches:
  - negative cancel transport result after terminal persistence
  - non-accepted cancel payload after terminal persistence

Focused proofs added or updated:

- `src/node-host/invoke-acp.test.ts`
  - proves real runtime-backed ensure/start/status/event streaming
  - proves cancel and close delegate to the runtime and emit canonical worker terminal state
- `src/acp/store/gateway-events.test.ts`
  - directly proves both `requestCancel()` suppression branches in `src/acp/runtime/acp-node.ts`

## What remains for later slices

- broader replay/projector work is still not complete in this slice
- delivery checkpoint replay from the durable ACP store into normal ACP projection still needs its later dedicated slice
- restart/reconnect replay proofs beyond the currently accepted store/runtime coverage still remain future work
- node-host backend selection is still intentionally narrow and local-backend-oriented for this slice; broader backend/runtime policy can follow later
