# ACP Node Slice 3 Fixup 8 Summary

Reviewed head for this fixup:

- `2e25a3f72` `Docs: summarize ACP slice-3 fixup7`

## What changed

- node-host `acp.session.close` no longer treats active-session cancel failure as best-effort success
- if active close cannot confirm cancel or backend teardown, the session now stays present in explicit `state: "error"` with `close_failed` details instead of being dropped as if cleanup succeeded
- completed-turn replay retention is no longer capped to the most recent eight runs, so an old exact duplicate `acp.turn.start` cannot silently fall out of idempotency memory and relaunch a worker later
- the node-host runtime test harness now pins wait/cancel helpers to a single turn snapshot so fast settle paths do not race onto a fresh unresolved turn during verification

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves active `acp.session.close` returns failure when `runtime.cancel()` fails and that later worker traffic can still arrive while the session remains explicitly `close_failed`
  - proves an exact replay of the first completed run stays idempotent even after many later runs on the same ensured session and does not launch a tenth worker
- the full required slice ACP suite remains green after the close/replay fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
