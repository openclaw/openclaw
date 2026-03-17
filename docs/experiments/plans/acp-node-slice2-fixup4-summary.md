# ACP Node Slice 2 Fixup 4 Summary

This fixup stays tightly on the slice-2 runtime delivery seam and closes the remaining late-event race.

## What changed

- `src/acp/store/store.ts` now exposes `getRunDeliveryState(...)`, which returns the undelivered event suffix and current run snapshot under one store lock
- `src/acp/runtime/acp-node.ts` now drives `runTurn()` from that atomic delivery snapshot instead of separate `listRunEvents()` and `getRun()` reads
- this removes the window where a late same-lease worker event could be durably accepted after the event read but before the terminal read, causing the runtime to emit only `done` and silently drop accepted output
- `src/acp/store/gateway-events.test.ts` now adds focused proofs for:
  - the code-less unknown `acp.turn.start` failure branch remaining recoverable
  - the late-event interleaving race, using a stale first delivery snapshot followed by a coherent second snapshot containing both the accepted event and terminal

## What is now proven

- once the gateway durably accepts a late same-lease worker event and terminal, the runtime yields the accepted event suffix before returning the canonical terminal
- code-less unknown start failures still follow the recoverable path instead of being forced into a false failed terminal

## Verification

- `pnpm test -- src/node-host/invoke-acp.test.ts src/acp/store/store.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
- `pnpm tsgo`
- `pnpm build`
  - still fails with the same unchanged Bun/module-resolution error: `Cannot find module './cjs/index.cjs' from ''`

## Remaining non-blocking gap

- slice 2 now preserves both classification and delivery for unknown-start late output, but longer-term runtime recovery still relies on the existing explicit reconnect/recovery paths when a start remains uncertain and no later worker event or terminal arrives
