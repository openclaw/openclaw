# ACP Node Slice 3 Fixup 6 Summary

Reviewed head for this fixup:

- `1908a4706` `Docs: summarize ACP slice-3 fixup5`

## What changed

- node-host terminal inference no longer lets cancel intent blanket-rewrite a later runtime outcome into `cancelled`
- a later `done` now resolves as:
  - `cancelled` only when the runtime stop reason is explicitly cancel-like
  - `failed` when the runtime already emitted a non-terminal `error` and the later `done` is not cancel-like
  - `completed` otherwise
- node-host close teardown failures now surface as `acp.session.close` failure instead of returning `accepted: true`
- close failure also preserves the local session record in explicit `state: "error"` with `close_failed` details instead of dropping it to `state: "missing"`

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves cancel intent does not rewrite a later runtime failure into canonical `cancelled`
  - proves an explicit cancel-like later `done` still resolves as `cancelled`
  - proves backend close failure is reported as a command failure and follow-up status exposes `close_failed` rather than `missing`
- the full required slice ACP suite remains green after the bridge fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
