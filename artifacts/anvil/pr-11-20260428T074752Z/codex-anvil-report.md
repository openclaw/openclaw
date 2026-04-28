Summary

Reviewed PR #11 locally as a config-contract foundation change. No local repair patch was produced; worktree is clean.

Vision

Add an optional top-level `instanceId` to `OpenClawConfig` so Bench/OpenClaw deployments can declare a stable, filesystem-safe instance identity before follow-up PRs scope wiki vaults, health snapshots, shard layouts, and cloud mirror state around it.

Acceptance Criteria

The PR needs to:

- Accept `instanceId` as a top-level config field while preserving configs without it.
- Reject unsafe path-component values: empty string, slash, traversal, or non-`[A-Za-z0-9_-]` characters.
- Keep TypeScript config types, Zod validation, generated JSON schema, field labels/help, and docs baseline hashes aligned.
- Avoid changing auth, billing, checkout, Firestore, UI runtime, or permission behavior.
- Include focused regression tests for accepted/absent/rejected values.

Verdict

PASS

Findings

No PR-caused blockers found.

The incidental generated-schema removal of `required: ["command"]` under CLI backends is consistent with `origin/main` source: `MemoryQmdSchema.command` is already optional there, while `origin/main`’s generated schema was stale. Current generated output is idempotent: `src/config/schema.base.generated.ts:3705`.

Repairs Attempted

None. No files were edited.

Verification

Passed:

- `pnpm install`
- `pnpm config:schema:check`
- `pnpm config:docs:check`
- `pnpm test src/config/config-misc.test.ts` passed, 54 tests
- `pnpm check`

Build gate:

- `pnpm build` failed with baseline/unrelated `UNRESOLVED_ENTRY`: cannot resolve `extensions/bench-reflective-dreaming/index.ts`.
- Evidence: PR changed only config/docs files; `origin/main` and `HEAD` both lack that entry under `extensions/bench-reflective-dreaming/`.

Remaining Risks

`pnpm build` is currently blocked by an existing bundled-extension entry issue outside this PR. It does not appear to mask this config change because `pnpm check`, schema checks, and scoped config tests all pass.

Recommended Repair Pass

No PR repair pass needed. Handle the unrelated build failure separately by fixing or excluding `extensions/bench-reflective-dreaming/index.ts` from the build entry set.

Handoff

PR #11 satisfies the reconstructed foundation scope. Next command:

`scripts/anvil_pr_ship.sh 11 --artifact /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-11-20260428T074752Z --dry-run`
