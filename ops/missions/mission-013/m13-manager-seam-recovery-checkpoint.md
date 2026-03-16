# M13 ACP Manager-Seam Recovery Family Checkpoint

Date: 2026-03-16 (UTC)

## Mission Identity

- Mission: M13 (ACP-shaped Agent Registry, Run Orchestrator & Sessions)
- Checkpoint topic: manager-seam recovery family
- Family pattern: same-key reject -> fresh-manager rehydrate (`getSessionStatus`) -> immediate clean retry

## Scope Frozen at This Checkpoint

- Test seam only (`src/acp/control-plane/manager.test.ts`)
- No runtime interface expansion
- No M11/M12 contract changes
- No M14/M15 boundary work

## Evidence Sources

- `src/acp/control-plane/manager.test.ts`
- `test/m12-route-law-proof.test.ts`

## What Was Proven

For each covered lane below, the test asserts:

1. Bad attempt rejects before `runtime.ensureSession`
2. Fresh-manager `getSessionStatus` rehydrate on the same key stays clean:
   - `state: "idle"`
   - `runtimeOptions: {}`
   - `lastError: undefined`
   - no metadata write on rehydrate
3. Immediate same-key clean retry with:
   - `CLEAN_ROUTE_DECISION_JSON`
   - `CLEAN_COUSIN_TICKET_JSON`
     succeeds and calls `ensureSession`
4. Post-retry metadata matches clean contract truth with no stale carry-over

## Covered Recovery Sibling Lanes

- known-bad M12 verdict reject (`BAD_ROUTE_DECISION_JSON`)
- top-level schema-invalid `routeDecision`
- schema-invalid `cousinTicket`
- missing `cousinTicket`
- cousinTicket decisionId binding mismatch
- cousinTicket ticketId mismatch
- cousinTicket digest mismatch
- routeDecision-side cousinTicket ticketId mismatch
- routeDecision-side cousinTicket ticketDigest mismatch
- routeDecision-side cousinTicket decisionId mismatch
- routeDecision-side schema-invalid cousinTicket binding shape

## Validation Receipts Relied Upon

Latest validated pack receipts (no failures):

- `pnpm format:fix src/acp/control-plane/manager.test.ts src/acp/control-plane/manager.core.ts src/config/sessions/types.ts`
  - `Finished in 56ms on 3 files using 16 threads.`
- `pnpm exec vitest run --config vitest.unit.config.ts src/acp/control-plane/manager.test.ts`
  - `Test Files  1 passed (1)`
  - `Tests  27 passed (27)`
- `pnpm exec vitest run --config vitest.unit.config.ts test/m12-route-law-proof.test.ts`
  - `Test Files  1 passed (1)`
  - `Tests  4 passed (4)`
- `pnpm build`
  - exited 0
  - existing non-fatal repeated warning:
    `[MISSING_EXPORT] "getTelemetrySnapshot" is not exported by "src/logging/diagnostic.ts"`

## Out of Scope / Unknown (Explicit)

- Cross-process/live-runtime behavior outside this manager unit seam
- Rehydrate failure-injection lanes (for example backend unavailable during `getSessionStatus`)
- Any behavior not represented by the covered sibling lanes above

## Why This Family Is Checkpoint-Ready

- Recovery recipe is now exercised across schema and non-schema reject classes, including routeDecision-side and cousinTicket-side variants.
- Each lane enforces both safety (reject-before-ensure, no stale writes) and liveness (same-key clean retry succeeds).
- Assertions are consistent and aggregate counts are kept honest in the suite.

## Recommended Next Seam for M13

Move from manager-seam recovery permutations to a concise M13 closure pass:

- finalize checkpoint notes + PR summary
- gate on current passing receipts
- shift next engineering lane to a distinct seam (not another sibling recovery permutation)

## PR Summary (Reusable)

### Summary

This checkpoint freezes the M13 ACP manager-seam recovery family for same-key reject -> rehydrate -> clean-retry behavior.

### Proven

- reject-before-ensure across covered schema/non-schema lanes
- restart-style rehydrate remains clean (`idle`, empty runtime options, no sticky `lastError`)
- immediate same-key clean retry succeeds with clean route-law metadata and no stale carry-over

### Scope

- test-only (`src/acp/control-plane/manager.test.ts`)
- no runtime interface changes
- no M11/M12 contract drift

### Validation

- manager unit suite: pass
- M12 route-law proof suite: pass
- build: pass (with existing non-fatal telemetry export warning)
