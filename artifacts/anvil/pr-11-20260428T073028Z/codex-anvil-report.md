Summary

Reviewed the handoff, refs, local diff, and checks. The worktree is not the media/identity PR described by the title/body. It is BenchAGI `origin` PR 11 at `29fc0eb4a7`, adding top-level `instanceId` config support. I made one bounded local repair for that actual local diff: refreshed the config docs baseline hash.

Vision

Stated PR vision: fix media replies by following Twilio media redirects, preserving media IDs/extensions via MIME sniffing, and making Claude identity prefix handling user-agnostic and session-correct.

Actual worktree vision: add an optional, validated top-level `instanceId` config key for per-Bench-instance scoping.

Acceptance Criteria

For the stated media PR: redirects capped safely, MIME/extension handling correct, media serving IDs stable, Claude identity prefix sent once on the first session message, no auth widening, no billing/checkout effects, and regression tests cover redirects, MIME detection, serving, and identity flags.

For the actual config diff: `instanceId` remains optional, rejects path traversal/empty values, is represented in Zod/types/schema/help/labels/generated schema, config doc hash is updated, existing configs still validate, and no auth/payment/UI behavior changes.

Verdict

BLOCK

Findings

- BLOCKER: The PR metadata and local worktree refer to different PRs. The artifact metadata points to `fix/media-replies` at `d7420ac5e4` and `pr.json` says that PR is closed; this worktree is `origin/feat/config-instance-id` at `29fc0eb4a7`. The local implementation only touches config surfaces such as `src/config/zod-schema.ts:257`, `src/config/types.openclaw.ts:41`, and `src/config/config-misc.test.ts:43`. The media/identity implementation is not present, so the stated PR cannot be verified or shipped from this worktree.
- REPAIRED: The local config diff changed the public config surface but omitted the tracked docs baseline hash. `pnpm config:docs:check` failed with `docs/.generated/config-baseline.sha256` drift. I updated `docs/.generated/config-baseline.sha256:1`.
- NON-PR BASELINE: `pnpm build` fails on missing `extensions/bench-reflective-dreaming/index.ts`. `origin/main` has the same missing path, and the local PR diff does not touch extensions/build config, so this is likely baseline branch state, not caused by the config change. It still means the build gate is not green in this worktree.

Repairs Attempted

Ran `pnpm config:docs:gen` and left only `docs/.generated/config-baseline.sha256` dirty.

Repair patch: /Users/coryshelton/clawd/openclaw/artifacts/anvil/pr-11-20260428T073028Z/anvil-repair.patch

Verification

- `pnpm install` after missing `node_modules`
- `pnpm test src/config/config-misc.test.ts -t "instanceId"` passed
- `pnpm check:base-config-schema` passed
- `pnpm config:docs:check` failed before repair, passed after repair
- `pnpm test src/config/schema.help.quality.test.ts` passed
- `pnpm check` passed
- `pnpm build` failed on baseline missing bundled plugin entry

Remaining Risks

The media/identity PR has not been verified in this worktree. The local config branch also lacks a green build because of an unrelated baseline build failure.

Recommended Repair Pass

Regenerate the Anvil worktree/artifacts from one consistent target:

- For BenchAGI PR 11, use `origin/pull/11/head` and metadata matching `feat(config): top-level instanceId field`; apply the repair patch and handle the baseline build blocker separately.
- For openclaw/openclaw PR 11, checkout `upstream/pr/11` against `upstream/main`, discard this config hash patch, and run media/identity-specific tests.

Handoff

Do not ship this PR from the current artifacts. The branch under review and the stated PR are mismatched, and the target PR metadata says closed.
