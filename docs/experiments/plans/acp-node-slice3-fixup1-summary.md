# ACP Node Slice 3 Fixup 1 Summary

Reviewed head for this fixup:

- `320ca0fc4` `Docs: summarize ACP slice 3`

## What changed

- node-host `acp.turn.start` now remembers recently completed `runId` / `requestId` pairs and treats an exact replay as idempotent instead of launching a second local runtime turn
- node-host `acp.turn.start` now rejects a reused `runId` with a different `requestId` after the run already completed on that node
- node-host terminal classification now treats any runtime `done` after cancel intent as `cancelled`, even if the backend returns a bare `done` or a non-cancel stop reason
- node-host `acp.session.status` now fails closed when backend status is unavailable or throws, instead of returning a locally synthesized healthy payload

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves a fast-finished duplicate `acp.turn.start` with the same `runId` / `requestId` is accepted idempotently without rerunning the local runtime
  - proves bare `done` after cancel intent emits a canonical `cancelled` terminal
  - proves backend status failure returns `ok: false` / `UNAVAILABLE` instead of a false healthy state
- the existing gateway reconnect proof surface remains green, so node-host status failure now composes with the already accepted fail-safe reconnect behavior in the gateway suites

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond this fixup
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
