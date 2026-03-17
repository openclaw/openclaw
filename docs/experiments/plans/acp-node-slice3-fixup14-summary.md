# ACP Node Slice 3 Fixup 14 Summary

Reviewed head for this fixup:

- `8b5c06708` `Docs: summarize ACP slice-3 fixup13`

## What changed

- node-host `acp.turn.cancel` no longer clears cancel intent just because the local cancel-ack watchdog timed out
- after a cancel-ack timeout, the session still rolls back out of `cancelling` so retry behavior stays coherent, but the active turn keeps its cancel intent so later terminal synthesis can still classify a late silent cancel correctly
- normal silent runtime exits without cancel intent still follow the existing synthetic `completed` fallback unchanged

## What is now proven

- `src/node-host/invoke-acp.test.ts`
  - proves cancel-ack timeout followed by a late silent runtime exit now resolves as canonical `cancelled` rather than synthetic `completed`
  - proves a normal silent runtime exit with no cancel intent still resolves as `completed`
- the full required slice ACP suite remains green after the cancel-intent fix landed

## Remaining non-blocking gaps

- `src/acp/runtime/types.ts` still exposes only best-effort `cancel()` and `close()`, so the node-host bridge still needs local timeout policy for cancel and close; splitting cancel intent from cancel acknowledgement more explicitly in the runtime contract may still be worth a later slice
- broader replay / projector checkpoint work is still deferred beyond slice 3
- `runtimeOptions` are still parsed on the node-host ACP wire but not yet forwarded into the local runtime contract
