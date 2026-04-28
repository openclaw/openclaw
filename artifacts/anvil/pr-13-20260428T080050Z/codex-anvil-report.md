Summary
Reviewed PR #13, found two bounded issues, repaired both locally, and verified the memory-wiki surface. The worktree is intentionally dirty with the repair patch content.

Vision
Phase D2.1 makes `instanceId` the default vault partition key for `memory-wiki`: Tier A stays on `~/.openclaw/wiki/main`, while Tier B/C instances use `~/.openclaw/wiki/{instanceId}` unless the user explicitly sets `vault.path`.

Acceptance Criteria

- Default vault path is instance-scoped when `instanceId` is valid.
- Missing or invalid `instanceId` safely falls back to `main`.
- Explicit `plugins.entries.memory-wiki.config.vault.path` still wins.
- Runtime plugin registration and CLI metadata both receive `appConfig.instanceId`.
- Instance IDs remain path-safe and aligned with the config schema regex.
- Docs/UI metadata must not encourage users to hard-code `main` and bypass isolation.
- No auth, billing, checkout, Firestore, or mobile UI behavior is affected.
- Scoped memory-wiki tests and repo local checks pass; build failures must be classified.

Verdict
REPAIR

Findings

- Medium, repaired: `extensions/memory-wiki/cli-metadata.ts:15` now passes `{ instanceId }` into `resolveMemoryWikiConfig`, but `extensions/memory-wiki/cli-metadata.test.ts` still asserted the old one-argument call. The scoped test failed exactly on that mismatch. Fixed at `extensions/memory-wiki/cli-metadata.test.ts:40` and `extensions/memory-wiki/cli-metadata.test.ts:70`.
- Medium, repaired: public memory-wiki examples still hard-coded `vault.path: "~/.openclaw/wiki/main"`, which would override the new instance-scoped default when copied into Tier B/C configs. Fixed at `extensions/memory-wiki/README.md:25`, `docs/plugins/memory-wiki.md:275`, and `extensions/memory-wiki/openclaw.plugin.json:11`.
- Low, baseline/build environment: `pnpm build` fails before this PR’s surface with `[UNRESOLVED_ENTRY] Cannot resolve entry module extensions/bench-reflective-dreaming/index.ts`. `origin/feat/config-instance-id` and `HEAD` both lack that file, and the PR diff only touches `extensions/memory-wiki/*`, so this is not PR-caused.

Repairs Attempted

- Updated CLI metadata test to prove `instanceId` is threaded into config resolution.
- Updated memory-wiki README/docs examples to omit `vault.path` by default and document custom paths as explicit overrides.
- Updated manifest UI help to state the instance-scoped default and override semantics.
- Repair patch: /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-13-20260428T080050Z/anvil-repair.patch

Verification

- Artifact deterministic checks: skipped by `--no-checks`; no failing logs were present.
- Installed missing deps with `pnpm install` after Vitest was unavailable.
- Pre-repair scoped test reproduced PR-caused failure in `extensions/memory-wiki/cli-metadata.test.ts`.
- Post-repair `pnpm test extensions/memory-wiki/src/config.test.ts extensions/memory-wiki/cli-metadata.test.ts extensions/memory-wiki/index.test.ts`: 3 files, 13 tests passed.
- `pnpm test extensions/memory-wiki`: 24 files, 116 tests passed.
- `pnpm check`: passed.
- `git diff --check`: passed.
- `pnpm build`: failed on unrelated missing `extensions/bench-reflective-dreaming/index.ts`.

Remaining Risks

- No migration helper exists for users who already have data in `~/.openclaw/wiki/main` and later set `instanceId`; they will see a fresh instance vault unless they migrate content manually.
- `INSTANCE_ID_PATTERN` remains a local copy of the top-level config schema regex, so future schema drift needs attention.
- Full build remains blocked by the baseline missing `bench-reflective-dreaming` entry.

Recommended Repair Pass
Apply the local repair patch to the PR branch, then rerun:

- `pnpm test extensions/memory-wiki`
- `pnpm check`
- `pnpm build` after the baseline `extensions/bench-reflective-dreaming/index.ts` build issue is fixed or intentionally removed from build entrypoints.

Handoff
Do not ship the PR branch as-is without the Anvil repair patch. After applying it, the PR-specific memory-wiki behavior is verified; the only remaining gate blocker I found is the unrelated baseline build entry issue.
