# ACP Node Slice 2 Fixup 3 Summary

This fixup stays narrowly on the slice-2 runtime/store seam and closes the remaining start-failure classification blocker.

## What changed

- `src/acp/runtime/acp-node.ts` now distinguishes definitive start rejection from recoverable unknown transport outcomes:
  - explicit non-accept or hard non-recoverable start errors still settle through the synthetic failed terminal path
  - `TIMEOUT`, `UNAVAILABLE`, and other code-less unknown start failures no longer write a canonical failed terminal
- unknown `acp.turn.start` transport outcomes now move the durable run/session into explicit recovery instead of false failure:
  - `src/acp/store/store.ts` adds `markRunRecovering(...)`
  - `src/acp/store/types.ts` adds the explicit recovery reason `start_unknown_transport`
  - the active lease stays usable so same-lease late worker output can still be durably accepted and become canonical
- `src/acp/store/gateway-events.test.ts` now proves both sides of the split:
  - definitive rejected start still produces a durable failed terminal
  - unknown start timeout leaves the run recoverable, and late worker output plus terminal still complete the run successfully

## What is now proven

- the runtime no longer treats every `acp.turn.start` failure as a definitive rejected start
- recoverable transport timeout / unknown-state failures preserve the possibility of late worker progress instead of fencing it off behind a false failed terminal
- explicit rejected starts still do not wedge later turns

## Verification

- `pnpm test -- src/node-host/invoke-acp.test.ts src/acp/store/store.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
- `pnpm tsgo`
- `pnpm build`
  - still fails with the same unchanged Bun/module-resolution error: `Cannot find module './cjs/index.cjs' from ''`

## Remaining non-blocking gap

- unknown start transport failures now remain recoverable instead of falsely terminal, but v1 still relies on the existing external recovery/cancel paths if a start stays uncertain and no later worker event or terminal arrives
