# ACP Node Slice 3 Fixup 13 Summary

Reviewed head for this fixup:

- `b14884451` `Docs: summarize ACP slice-3 fixup12`

## What changed

- node-host `acp.turn.cancel` now uses a bounded cancel-acknowledgement policy instead of waiting indefinitely on `runtime.cancel()`
- if backend cancel acknowledgement does not arrive within the allowed cancel window, the command now returns failure and rolls the node-host session out of `cancelling` back to live-run state instead of wedging indefinitely
- the cancel timeout is test-overridable through the existing `src/node-host/invoke-acp.ts` test seam, so slow-success and stuck-cancel branches can both be proven without shrinking the production policy

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves a healthy slower cancel acknowledgement still succeeds after more than 100 ms
  - proves a stuck backend cancel no longer leaves `acp.turn.cancel` unresolved forever; it returns `UNAVAILABLE`, the session does not stay wedged in `cancelling`, and a later retry can still succeed
- the full required slice ACP suite remains green after the bounded cancel fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge still needs local timeout policy for cancel and close; a dedicated runtime-side cancel-timeout/quiescence contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
