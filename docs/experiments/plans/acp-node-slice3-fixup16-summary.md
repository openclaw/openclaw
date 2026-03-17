# ACP Node Slice 3 Fixup 16 Summary

Reviewed head for this fixup:

- `5236b76aa` `Docs: summarize ACP slice-3 fixup15`

## What changed

- node-host cancel failure handling now distinguishes cancel-ack timeout from hard cancel RPC failure
- timed-out `acp.turn.cancel` still preserves local `cancelling` status so same-node reconnect stays aligned with the gateway store's durable cancel intent
- non-timeout cancel RPC failure now rolls node-host session state back to `running` and clears local cancel intent, so reconnect cannot synthesize `cancelling` without a durably accepted cancel request

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves cancel RPC failure with no durable cancel acceptance rolls node-host status back to `running`
  - keeps the timeout proof where accepted cancel intent remains reconnect-visible as `cancelling`
- `src/gateway/server-node-events.acp.test.ts`
  - proves a healthy non-cancelling run still reconciles as `running` through same-node reconnect
  - proves a durably cancelling run still reconciles as `cancelling` through same-node reconnect after cancel-ack timeout
- the full required slice ACP suite remains green after tightening the cancel-status trust boundary

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge still needs local timeout policy for cancel and close; a stronger runtime-side cancel/quiescence contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
