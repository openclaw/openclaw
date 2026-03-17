# ACP Node Slice 3 Fixup 15 Summary

Reviewed head for this fixup:

- `d9de51723` `Docs: summarize ACP slice-3 fixup14`

## What changed

- cancel-ack timeout no longer rewinds node-host session status back to plain `running` while cancel intent is still latched
- after a timed-out `acp.turn.cancel`, node-host `acp.session.status` continues to report `cancelling`, which keeps same-node reconnect/reconcile aligned with the gateway store's durable cancel intent
- healthy non-cancelling running sessions still reconcile as `running` through the unchanged reconnect path

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves timed-out `acp.turn.cancel` now leaves node-host status in `cancelling` rather than regressing to `running`
- `src/gateway/server-node-events.acp.test.ts`
  - proves a durably cancelling run stays `cancelling` through same-node reconnect/status reconcile
  - keeps the existing proof that healthy non-cancelling running sessions reconcile as `running`
- the full required slice ACP suite remains green after the reconnect-status fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge still needs local timeout policy for cancel and close; a more explicit cancel-pending versus running status model in the runtime contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
