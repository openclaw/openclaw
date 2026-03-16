# ACP Node Slice 3 Fixup 3 Summary

Reviewed head for this fixup:

- `10e95ec3b` `Docs: summarize ACP slice-3 fixup2`

## What changed

- node-host worker completion now settles into an explicit local `error` state when `acp.worker.terminal` transport fails after an accepted run already finished locally
- that failure path clears the stale active-turn marker instead of leaving the session falsely `running`
- node-host `acp.session.status` now reports `state: "error"` with `terminal_delivery_failed` details for that case
- node-host `acp.turn.start` now rejects further turns on that lease/session until explicit recovery replaces the broken handoff state

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves terminal-send failure after accepted completion no longer leaves a stale healthy `running` status
  - proves that same node-host session refuses a follow-up turn instead of silently moving on after the lost terminal handoff
- `src/gateway/server-node-events.acp.test.ts`
  - proves reconnect reconcile treats that `state: "error"` status as incoherent and marks the suspect lease `lost` with run recovery preserved
- the full required slice ACP suite remains green after the fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
