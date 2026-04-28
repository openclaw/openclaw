Summary

Final local forge pass found no blocking runtime issue, but I made a small repair patch to tighten the contract around the new optional `instanceId`.

Vision

Phase D2.1 should let relay/heartbeat tooling identify which Bench instance a harness belongs to from the health snapshot itself, without rereading config. Tier A single-user installs must continue omitting `instanceId` entirely.

Acceptance Criteria

- `getHealthSnapshot()` includes `instanceId` only when `OpenClawConfig.instanceId` is set.
- Unset Tier A configs omit the property, not `instanceId: undefined`.
- Typed health consumers accept the additive optional field.
- Gateway auth scope and exposure do not expand.
- No Firestore, billing, checkout, or mobile UI effects.
- Regression tests prove present and absent behavior.

Verdict

REPAIR

Findings

- Low, fixed: `src/commands/health.snapshot.test.ts:351` only checked `snap.instanceId === undefined`, which would not catch an accidental `instanceId: undefined` property. Repaired with an explicit absence assertion at `src/commands/health.snapshot.test.ts:352`.
- Low, fixed: `ui/src/ui/types.ts:687` defines the Control UI’s typed gateway `HealthSummary` but did not include the new optional field. Repaired at `ui/src/ui/types.ts:691`.

Repairs Attempted

- Added an explicit `"instanceId" in snap` false assertion for the Tier A health snapshot test.
- Added `instanceId?: string` to the UI-facing gateway `HealthSummary` type.

Repair patch: /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-12-20260428T080048Z/anvil-repair.patch

Verification

- Artifact deterministic checks: skipped by `--no-checks`; logs directory contained no failed check logs to classify.
- Initial `pnpm test src/commands/health.snapshot.test.ts` failed because `node_modules` was missing, classified as environment/setup.
- Ran `pnpm install`, then reran the exact test command: passed, 1 file / 6 tests.
- Ran `pnpm check`: passed, including `tsgo`, lint, webhook/auth lint guards, and import-cycle checks.

Remaining Risks

The sibling BenchAGI relay currently parses gateway health as loose JSON and only reads `payload?.ok !== false`, so this additive field is tolerated. It does not yet consume `payload.instanceId`; that broader relay identification behavior remains downstream work.

Recommended Repair Pass

Apply the local Anvil repair patch to the PR branch, then rerun:

```bash
pnpm test src/commands/health.snapshot.test.ts
pnpm check
```

Handoff

Merge should wait for the repair patch to be applied. The temp worktree is intentionally dirty only in `src/commands/health.snapshot.test.ts` and `ui/src/ui/types.ts`.
