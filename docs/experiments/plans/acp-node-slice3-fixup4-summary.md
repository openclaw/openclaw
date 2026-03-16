# ACP Node Slice 3 Fixup 4 Summary

Reviewed head for this fixup:

- `ac757fbd5` `Docs: summarize ACP slice-3 fixup3`

## What changed

- node-host `runWorkerTurn()` now forwards runtime `error` as a real non-terminal `acp.worker.event`
- once a runtime `error` event has been observed, a later `done` no longer rewrites the run into a canonical `completed` terminal
- cancel intent still wins deterministically, so `error` followed by `done` after cancel remains `cancelled` instead of `completed`

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves runtime `error` followed by later `done` emits the `error` as `acp.worker.event` and resolves the terminal as `failed`, not `completed`
  - proves the same event shape after cancel still resolves the terminal as `cancelled`, not `completed`
- the full required slice ACP suite remains green after the bridge fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
