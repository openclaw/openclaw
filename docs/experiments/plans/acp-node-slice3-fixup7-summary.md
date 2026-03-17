# ACP Node Slice 3 Fixup 7 Summary

Reviewed head for this fixup:

- `2bca90109` `Docs: summarize ACP slice-3 fixup6`

## What changed

- node-host `acp.turn.cancel` now captures the active turn before awaiting `runtime.cancel()` and tolerates late cancel rejection after that turn has already settled
- that late-reject path now converges on the already-settled session state instead of crashing or writing bogus `state: "running"` back into the local record
- `settleCompletedTurn()` no longer clears `close_failed`; if close teardown already failed, later active-turn unwind now preserves `state: "error"` and the recorded `close_failed` details

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves late `runtime.cancel()` rejection after terminal settlement does not crash and leaves the session cleanly `idle` without a bogus active worker state
  - proves close failure during an active turn stays visible as `close_failed` / `state: "error"` even after the turn later settles, and that follow-up starts remain blocked
- the full required slice ACP suite remains green after the lifecycle fix landed

## Remaining non-blocking gaps

- broader replay / projector checkpoint work is still deferred beyond slice 3
- `acp.session.load` remains narrower than the full later-slice recovery design
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
