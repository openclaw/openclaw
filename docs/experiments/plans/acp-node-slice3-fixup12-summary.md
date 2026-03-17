# ACP Node Slice 3 Fixup 12 Summary

Reviewed head for this fixup:

- `21e23b952` `Docs: summarize ACP slice-3 fixup11`

## What changed

- node-host active `acp.session.close` now applies the same bounded-close policy to the full active-close path, not just post-cancel quiescence
- the close watchdog now covers both `runtime.cancel()` acknowledgement and later worker quiescence, so a stuck cancel call fails closed instead of leaving the session wedged forever in `cancelling`
- lease replacement now uses the same guarded close path as explicit session close; if the prior lease cannot cancel and quiesce coherently, replacement ensure fails and the old session record stays authoritative instead of being replaced under a still-live worker

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves active close fails closed when `runtime.cancel()` never resolves, returning `UNAVAILABLE` and latching `close_failed`
  - proves lease replacement cannot report a new lease ready, and a new run cannot be accepted, while the old lease's worker is still alive
  - proves replacement can succeed afterward once the old worker actually settles
- the full required slice ACP suite remains green after the close/replacement fencing fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge still has to enforce bounded close and lease-replacement fencing locally; a stronger runtime-side cancel/quiescence contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
