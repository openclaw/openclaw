# M13 ACP Startup-Reconcile Seam Checkpoint

Date: 2026-03-16 (UTC)

Checkpoint refresh: Prompt 31 after duplicate-discovery residual closure (Prompt 30).

## Mission Identity

- Mission: M13 (ACP-shaped Agent Registry, Run Orchestrator and Sessions)
- Seam: startup reconcile discovery, hydration, accounting, and isolation behavior
- Primary path: `AcpSessionManager.reconcilePendingSessionIdentities`
- Evidence sources:
  - `src/acp/control-plane/manager.test.ts`
  - `src/acp/control-plane/manager.core.ts`

## Scope Frozen at This Checkpoint

- Startup-reconcile seam only
- Test-focused proof work plus minimal supporting manager fix
- No runtime interface expansion
- No M11 or M12 contract changes
- No M14 or M15 work

## Startup-Reconcile Seam Map

### Covered Sibling Families

- Baseline pending identity reconcile (`checked/resolved/failed` truth).
- Already-resolved identity skip behavior.
- Mixed pending activation where one or more `ensureSession` paths fail while surviving entries continue correctly.
- Startup status-read failure tolerance in reconcile (`failOnStatusError: false`).
- Top-level discovery/list throw handling (`listAcpSessions` throw) as one top-level failure with no partial processing.
- Empty discovery list as clean no-op, distinct from top-level throw.
- Next-run recovery after top-level discovery throw.
- Malformed discovery rows:
  - missing `session.acp`
  - missing `sessionKey`
  - counted as safe skips, not failures.
- Mixed malformed + valid discovery isolation.
- Stale/unreadable hydrate paths during reconcile:
  - `readSessionEntry` returns `null`
  - `readSessionEntry` returns entry without `acp`.
- Mixed stale-read + malformed + valid pending + valid resolved isolation.
- Next-run recovery after stale-read skip-class conditions are corrected.
- Accounting boundary between skip-class stale reads and true activation failures.
- Exceptional per-entry read path:
  - `readSessionEntry` throw is isolated
  - distinct from stale-read skip-class behavior.
- Reconcile persistence degradation:
  - write failure does not falsely mark entry resolved
  - next-run recovery when persistence path is corrected.
- Duplicate discovery residual closure:
  - duplicate rows for same `sessionKey` are deduplicated in one reconcile pass
  - no double-processing, no inflated accounting
  - deterministic first-row precedence
  - next-run recovery when first-row stale/unreadable condition is corrected.

### Newly Closed Duplicate-Discovery Residuals

- Deterministic dedupe behavior for duplicate discovery rows keyed by normalized `sessionKey`.
- No double runtime work for duplicates (`readSessionEntry`, `ensureSession`, `getStatus`, metadata upsert stay single-pass).
- First-row precedence remains deterministic when duplicate rows conflict by readability.
- Recovery remains clean on next run once duplicate first-row stale condition is fixed.

### Residual Distinct Edge Cases

- Optional combo lane only:
  - one mixed startup batch containing both:
    - a per-entry `readSessionEntry` throw entry
    - a per-entry identity write-degradation entry
    - plus unaffected valid entries
  - explicit combined accounting and isolation proof in one batch.

### Deferred Low-Value / Diminishing-Return Edges

- Additional duplicate ordering permutations that do not change first-row precedence contract.
- Additional malformed row shape permutations that collapse to existing guard checks.
- Cosmetic variants of already-proven skip/fail accounting boundaries.

## What Is VERIFIED

- Startup reconcile accounting boundaries are locked across:
  - top-level discovery throw,
  - skip-class malformed/stale discovery rows,
  - true per-entry activation/read failures.
- Mixed-batch isolation is locked across malformed, stale, throw, and valid entries.
- No-poison and no-stale-carry behavior is locked for unaffected entries.
- Write-degradation behavior is locked:
  - no false resolved marking on degraded persistence,
  - clean recovery on subsequent run after correction.
- Duplicate-discovery behavior is now locked with deterministic dedupe and no double-processing.

## What Is LIKELY

- Startup reconcile behavior is robust for practical discovery/store irregularities under current M13 manager semantics because top-level, per-entry, skip-class, failure-class, and recovery-class boundaries are all exercised.

## What Remains UNKNOWN / TO VERIFY

- Only the optional combined mixed-batch lane (read-throw + write-degradation in one batch) remains unproven as a single integrated scenario.

## Validation Receipts Relied Upon

Latest validated receipts from Prompt 30 closure run:

- `pnpm format:fix src/acp/control-plane/manager.test.ts src/acp/control-plane/manager.core.ts src/config/sessions/types.ts`
  - `Finished in 66ms on 3 files using 16 threads.`
- `pnpm exec vitest run --config vitest.unit.config.ts src/acp/control-plane/manager.test.ts`
  - `Test Files  1 passed (1)`
  - `Tests  50 passed (50)`
- `pnpm exec vitest run --config vitest.unit.config.ts test/m12-route-law-proof.test.ts`
  - `Test Files  1 passed (1)`
  - `Tests  4 passed (4)`
- `pnpm build`
  - exited `0`
  - existing non-fatal repeated warning:
    `[MISSING_EXPORT] "getTelemetrySnapshot" is not exported by "src/logging/diagnostic.ts"`

## Why This Seam Is Checkpoint-Ready

- The startup-reconcile seam now has coherent proof coverage for discovery, hydration, accounting, isolation, exceptional per-entry behavior, and next-run recovery.
- Duplicate-discovery residuals, previously the highest remaining distinct gap, are now closed with deterministic semantics and recovery evidence.
- Remaining optional combo lane is additive and low-leverage relative to current evidence; deferring it does not materially weaken the seam checkpoint.

## Seam Exit Recommendation

Exit the startup-reconcile seam now.

Defer the optional combined read-throw plus write-degradation mixed-batch lane unless a future regression or product incident points directly to that exact combined path.

Move to the next substantive M13 seam outside startup-reconcile proof variants.

## Reusable PR / Handoff Summary

### Summary

Startup-reconcile seam is checkpointed after duplicate-discovery residual closure.

### Proven

- discovery throw vs empty discovery behavior
- malformed and stale-read skip-class boundaries
- per-entry activation/read/write exceptional paths and isolation
- truthful reconcile accounting across skip and failure classes
- next-run recovery after discovery, stale-read, and write-degradation issues
- deterministic duplicate-discovery dedupe with no double-processing

### Scope

- `src/acp/control-plane/manager.test.ts` proof additions
- minimal manager dedupe support in `src/acp/control-plane/manager.core.ts`
- no runtime interface changes and no M11 or M12 contract drift

### Recommendation

Treat startup-reconcile as complete for M13 checkpoint purposes and exit this seam.
