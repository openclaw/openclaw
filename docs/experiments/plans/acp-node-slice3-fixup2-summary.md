# ACP Node Slice 3 Fixup 2 Summary

Reviewed head for this fixup:

- `ddeeb0612` `Docs: summarize ACP slice-3 fixup1`

## What changed

- node-host `acp.turn.start` now rejects a different `requestId` for the same still-active `runId`
- exact active duplicate start requests remain idempotent, but conflicting active replays no longer overwrite the current worker handle or launch a second runtime turn

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves a same-`runId`, different-`requestId` replay during an active turn returns `INVALID_REQUEST`
  - proves that branch does not launch a second local worker and does not create any extra worker event or terminal path
- the full required slice ACP suite remains green after the guard landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
