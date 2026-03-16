# ACP Node Slice 3 Fixup 11 Summary

Reviewed head for this fixup:

- `cfc46c72d` `Docs: summarize ACP slice-3 fixup10`

## What changed

- node-host active `acp.session.close` no longer uses the unsound hardcoded `100` ms quiescence watchdog
- the bridge now uses a realistic bounded-close policy with a 30-second production close window, matching the existing ACP lease/recovery time scale closely enough to avoid falsely failing a healthy but slightly delayed shutdown
- tests now override that close window through `src/node-host/invoke-acp.ts` test seams so the bounded-close behavior stays fast to verify without shrinking the production contract
- the fail-closed timeout path remains intact: a worker that never settles still leaves the session in explicit `close_failed` error state and prevents premature `runtime.close()`

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves a healthy active close still succeeds when the worker settles after more than 100 ms but before the intended bounded-close window, and that `runtime.close()` still runs
  - proves the truly never-settling worker still fails closed eventually, returning `UNAVAILABLE` and keeping the session latched in `close_failed`
- the full required slice ACP suite remains green after the close-window fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`; the node-host bridge now uses a sounder bounded watchdog, but a dedicated configurable runtime-side quiescence/close-timeout contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
