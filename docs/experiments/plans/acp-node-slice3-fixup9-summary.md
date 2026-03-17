# ACP Node Slice 3 Fixup 9 Summary

Reviewed head for this fixup:

- `d9407e107` `Docs: summarize ACP slice-3 fixup8`

## What changed

- node-host active `acp.session.close` no longer reports success just because best-effort `runtime.cancel()` returned
- when a close hits an active turn, the bridge now marks the run cancelling, waits for the tracked worker turn to actually settle, and only then issues runtime close and deletes the node-host session
- if the worker never reaches a coherent settled state during close, or if terminal delivery failed while closing, the bridge fails closed and keeps the session record instead of claiming successful teardown
- the node-host fake runtime now has an explicit mode where `cancel()` can return without releasing the active worker turn, so close-quiescence timing is proven directly

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves active close stays pending and leaves the session visible as `cancelling` when `runtime.cancel()` returns before the worker has actually stopped
  - proves active close only returns `accepted: true` after the worker has emitted its terminal and gone quiescent, after which status becomes `missing` and no later worker traffic arrives
  - keeps the existing regression that active close failure still reports `close_failed` if cancel itself errors
- the full required slice ACP suite remains green after the lifecycle fix landed

## Remaining non-blocking gaps

- the underlying runtime contract in `src/acp/runtime/types.ts` is still best-effort for `cancel()` and `close()`; the node-host bridge now compensates by waiting on its tracked turn, but a stronger explicit quiescence contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
