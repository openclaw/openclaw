# ACP Node Slice 2 Fixup 5 Summary

This fixup stays narrowly on the slice-2 runtime abort/cancel seam and closes the remaining stale-snapshot race.

## What changed

- `src/acp/runtime/acp-node.ts` now re-reads a fresh delivery snapshot before issuing abort-triggered cancel
- if that fresh snapshot already contains the canonical terminal, `runTurn()` now converges on that terminal immediately instead of trying to cancel a run that has already finished
- `requestCancel()` now also re-checks the run record before surfacing a cancel failure; if the run already has a persisted terminal, it suppresses the cancel error and lets the runtime continue on the canonical outcome
- `src/acp/store/gateway-events.test.ts` adds a focused proof for the abort-after-snapshot / terminal-before-cancel interleaving, and proves the runtime now returns the canonical terminal instead of throwing

## What is now proven

- abort/cancel no longer turns a stale non-terminal delivery snapshot into a fatal `"already completed"` style error after the gateway has already persisted the canonical terminal
- the runtime now converges on the stored terminal outcome for that interleaving instead of reporting a conflicting cancel failure

## Verification

- `pnpm test -- src/node-host/invoke-acp.test.ts src/acp/store/store.test.ts src/acp/store/gateway-events.test.ts src/gateway/server-node-events.acp.test.ts src/gateway/server-methods/nodes.acp.test.ts`
- `pnpm tsgo`
- `pnpm build`
  - still fails with the same unchanged Bun/module-resolution error: `Cannot find module './cjs/index.cjs' from ''`

## Remaining non-blocking gap

- slice 2 now has coherent delivery and abort/terminal convergence for the reviewed stale-snapshot races, but broader runtime recovery behavior still depends on the later slices that replace the slice-local node bookkeeping path with the full worker/runtime implementation
