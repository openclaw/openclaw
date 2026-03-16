# ACP Node Slice 3 Fixup 5 Summary

Reviewed head for this fixup:

- `8e10033b8` `Docs: summarize ACP slice-3 fixup4`

## What changed

- node-host worker-event sequencing now advances only after a non-terminal `acp.worker.event` send succeeds
- node-host `acp.worker.terminal` now derives `finalSeq` from the last successfully delivered non-terminal event rather than the last attempted one
- if a streamed worker event send fails, the bridge can still converge on a canonical failed terminal instead of producing an impossible `finalSeq` that the gateway rejects

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves a dropped first non-terminal worker event leads to a failed terminal with `finalSeq: 0`, not an impossible `finalSeq: 1`
  - proves that branch leaves the session in coherent `idle` state instead of falling into `terminal_delivery_failed`
- the full required slice ACP suite remains green after the sequencing fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
