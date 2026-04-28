# pendingFinalDelivery Deploy / Cutover Plan (2026-04-11)

## Goal

Ship the durable `pendingFinalDelivery` fix safely, with explicit validation and rollback.

## Artifacts

### Patch artifact for the v2026.3.24 line

- `pending-final-delivery-v2026.3.24-full.patch`

This patch currently covers:

- `src/agents/subagent-registry.types.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/subagent-registry.test.ts`
- `src/agents/subagent-registry.persistence.test.ts`

### Audit / reasoning notes

- `pending-final-delivery-upstream-audit-2026-04-11.md`

## Important environment note

Current local OpenClaw runtime is **2026.4.9**, not `v2026.3.24`.

Confirmed via `openclaw status`:

- app version: `2026.4.9`
- git: `253ecd2a`
- gateway service: running

So the `v2026.3.24` patch is useful as a branch-aligned artifact, but **it is not the exact version currently running locally**.

## What changed functionally

- durable pending-final-delivery payload is persisted on the run record
- resume / retry cleanup uses the durable payload instead of mutable live fields
- found and fixed a concrete bug where failed retry could overwrite the durable payload with stale live values
- restart/persistence test coverage was added

## Recommendation

### Best practical deployment path

If the target gateway is truly the currently running local instance, deploy from the **2026.4.9 code line**.

Why:

- it matches the live runtime
- it avoids version skew during cutover
- the same durability fix is already applied and validated in `openclaw-src`

### When to use the v2026.3.24 patch

Use `pending-final-delivery-v2026.3.24-full.patch` only if:

- there is a separate environment pinned to `v2026.3.24`, or
- you explicitly want a branch-aligned backport artifact

## Pre-cutover checklist

1. Confirm the actual target runtime version.
2. Snapshot the target install / checkout before patching.
3. Confirm there are no active critical background tasks.
4. Save a copy of current subagent run state if you want fast rollback of in-flight durability state.
5. Re-run the targeted tests on the exact target checkout.

## Cutover plan

### Path A: deploy to a v2026.3.24 checkout

1. Start from a clean `v2026.3.24` checkout.
2. Apply `pending-final-delivery-v2026.3.24-full.patch`.
3. Run targeted tests:
   - `pnpm --dir <repo> exec vitest run src/agents/subagent-registry.persistence.test.ts src/agents/subagent-registry.test.ts --reporter=dot`
4. Build / package using the normal OpenClaw release flow for that environment.
5. Restart gateway.
6. Run post-cutover verification.

### Path B: deploy to the currently running local 2026.4.9 line

1. Use `/home/mertb/.openclaw/workspace/openclaw-src` as the source of truth.
2. Keep only the validated `pendingFinalDelivery` changes you want to ship.
3. Run targeted tests:
   - `pnpm --dir /home/mertb/.openclaw/workspace/openclaw-src exec vitest run src/agents/subagent-registry.persistence.test.ts src/agents/subagent-registry.test.ts src/agents/subagent-registry-lifecycle.test.ts --reporter=dot`
4. Build / package according to the normal update flow.
5. Restart gateway with:
   - `openclaw gateway restart`
6. Run post-cutover verification.

## Post-cutover verification

### Functional checks

- `openclaw status`
- verify gateway is reachable and healthy
- verify no immediate task / event errors appear

### Targeted behavior checks

Simulate or observe at least one subagent completion flow where:

- completion delivery is attempted
- delivery is deferred or fails once
- cleanup retry uses the original durable payload
- final state clears `pendingFinalDelivery*` after successful delivery

### Regression checks

- no duplicate final delivery
- no missing final delivery after reconnect / retry
- delete-mode runs still clean up correctly
- keep-mode runs retain expected metadata

## Rollback plan

1. Stop or restart the gateway back onto the previous build / package.
2. Restore the pre-patch checkout or reinstall the prior version.
3. If necessary, restore the saved run-state snapshot.
4. Re-run `openclaw status` and confirm gateway health.

## Risk notes

- The biggest practical risk is **deploying a `v2026.3.24` patch onto a live `2026.4.9` runtime expectation**.
- The safest cutover is version-matched deployment.
- The bug fixed here is narrow and high-value: it affects retry durability and can lead to stale payload reuse.

## Suggested immediate next move

- If the real target is the local gateway, switch deployment planning to the `2026.4.9` line.
- Keep the `v2026.3.24` patch as a clean backport artifact.
