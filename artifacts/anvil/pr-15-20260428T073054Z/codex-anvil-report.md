Summary

Actual branch content is a one-file BenchAGI bundler stub, not the upstream-sync PR described by the title/body. `pnpm check` and `pnpm build` pass locally for the actual diff, but I would not ship this PR as-is because the stated scope is false and the script-runtime plugin packaging contract is incomplete.

Vision

The PR metadata says the vision is an upstream sync covering heartbeat refactoring, reply chunking, tau-rpc, media redirects, and agent improvements. The actual diff instead appears to aim at making `bench-reflective-dreaming` buildable by adding a no-op `index.ts` for a script-driven extension whose real behavior lives in install/uninstall scripts.

Acceptance Criteria

- Claimed upstream-sync behavior must be present in touched heartbeat, chunking, tau-rpc, media, and agent surfaces with matching tests.
- Actual stub behavior must let tsdown/build package the plugin without missing-entry failures.
- If the plugin manifest is shipped, its runtime assets must also ship, or the plugin must be explicitly excluded from packaged builds.
- No auth, billing, checkout, Firestore, or UI behavior should change.
- Docs/runbooks must match the actual merge scope.
- Relevant build/plugin contract checks must pass.

Verdict

BLOCK

Findings

- BLOCKER: PR metadata/handoff does not match the actual implementation. The only diff is `extensions/bench-reflective-dreaming/index.ts:1`; there are no heartbeat, chunking, tau-rpc, media, or agent changes matching the PR title/body. Shipping this would merge a different change than the reviewed product intent.

- BLOCKER: The new stub causes the plugin to build, but the packaged plugin is incomplete if it is meant to be shipped. `extensions/bench-reflective-dreaming/index.ts:2` says behavior lives in `scripts/install.mjs` and `scripts/uninstall.mjs`; `extensions/bench-reflective-dreaming/openclaw.plugin.json:7` advertises `"runtime": "scripts"`. The build artifact logic only requires/captures manifest and JS entries at `scripts/lib/bundled-plugin-build-entries.mjs:148`, and metadata copy only writes manifest/skill metadata at `scripts/copy-bundled-plugin-metadata.mjs:271`. After `pnpm build`, `dist/extensions/bench-reflective-dreaming` contained only `index.js` and `openclaw.plugin.json`, while the install path needs `assets`, `defaults`, and `scripts` per `extensions/bench-reflective-dreaming/scripts/install.mjs:32`.

Repairs Attempted

No source repair was made. The safe fix depends on the intended scope: either retitle/rebody this as a BenchAGI bundler-stub PR and decide whether the plugin is source-only, or implement a real packaging contract for script-runtime plugin assets.

Verification

- Harness deterministic checks: skipped by `--no-checks`; logs directory was empty, so there were no failing logs to classify.
- Initial scoped test command failed because `node_modules` was missing; ran `pnpm install`, then reran the exact command.
- Passed: `pnpm test test/scripts/bundled-plugin-build-entries.test.ts src/infra/tsdown-config.test.ts src/plugins/bundled-plugin-naming.test.ts`
- Passed: `pnpm build`
- Passed: `pnpm check`
- Worktree is clean after verification.

Remaining Risks

- Full `pnpm test` was not run.
- Packaged npm/runtime install of `bench-reflective-dreaming` was not proven because the build output omits the script/runtime assets.
- PR title/body and branch content are inconsistent enough to make external review state unreliable.

Recommended Repair Pass

1. Decide scope: upstream sync or BenchAGI bundler stub.
2. If upstream sync, replace/update the branch so the heartbeat/chunking/tau-rpc/media changes are actually present and rerun relevant tests.
3. If bundler stub, retitle/rebody the PR and either exclude `bench-reflective-dreaming` from packaged bundled plugins or extend build metadata copying to include its `scripts/`, `assets/`, and `defaults/` with tests.
4. Rerun `pnpm check`, `pnpm build`, and the targeted plugin build-entry tests above.

Handoff

Do not run the ship script yet. The next agent should first resolve the PR-scope mismatch, then make the smallest packaging decision for `bench-reflective-dreaming` and verify it with build plus plugin artifact tests.
