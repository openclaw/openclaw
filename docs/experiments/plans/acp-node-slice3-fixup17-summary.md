# ACP Node Slice 3 Fixup 17 Summary

Reviewed head for this fixup:

- `107c5543b` `Docs: summarize ACP slice-3 fixup16`

## What changed

- gateway-side reconnect/status handling now treats worker-reported `cancelling` as trustworthy only when the durable store already contains cancel intent for the active run
- `src/acp/runtime/acp-node.ts` now normalizes `acp.session.status` and suspect-lease reconcile status through that durable-cancel gate, so a failed `acp.turn.cancel` transport cannot leave runtime status or reconnect reporting false `cancelling`
- `src/acp/store/gateway-events.ts` and `src/acp/store/store.ts` now apply the same rule at reconnect/reactivation time, so a reconnecting worker cannot rehydrate `cancelling` while `cancelRequestedAt` is still absent

## What is now proven

- `src/acp/store/gateway-events.test.ts`
  - proves a gateway-side `acp.turn.cancel` transport failure after node-side cancel acceptance but before `recordCancelRequested()` lands still reports runtime status as `running`
- `src/gateway/server-node-events.acp.test.ts`
  - proves same-node reconnect does not revive a run as `cancelling` when durable cancel intent never landed
  - keeps the durable-cancel proof where reconnect still preserves `cancelling` when `cancelRequestedAt` exists
- the full required slice ACP suite remains green after tightening the gateway-side cancel-status trust boundary

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge and gateway runtime still need local timeout policy instead of an explicit runtime-side cancel/quiescence contract
- if later slices need to distinguish "node probably accepted cancel but the gateway transport failed before durability" from ordinary running state, that likely needs an explicit durable gateway-to-node cancel handshake marker rather than reconnect inference
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
