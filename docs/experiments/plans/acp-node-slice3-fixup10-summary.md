# ACP Node Slice 3 Fixup 10 Summary

Reviewed head for this fixup:

- `1e9f7b6a9` `Docs: summarize ACP slice-3 fixup9`

## What changed

- node-host active `acp.session.close` no longer waits indefinitely for `activeTurn.completion` after best-effort `runtime.cancel()` returns
- the bridge now applies a bounded quiescence watchdog during active close; if the tracked worker turn does not settle in time, close records `close_failed`, returns failure, and keeps the session in explicit error state instead of hanging forever in `cancelling`
- the existing eventual-quiescence path remains intact: active close still returns `accepted: true` only after the tracked worker has actually settled and runtime close completes

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves active close still waits for real quiescence before returning success and deleting the session
  - proves the never-settles case no longer hangs forever: close returns `UNAVAILABLE`, runtime close is not called, and node-host status moves to explicit `close_failed` error state
  - proves that later settlement after the timeout does not clear the recorded close failure
- the full required slice ACP suite remains green after the bounded close fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still has only best-effort `cancel()` and `close()` semantics, so the node-host bridge still needs a local quiescence timeout watchdog; a dedicated runtime-side quiescence/recovery contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
