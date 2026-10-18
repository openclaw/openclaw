# Scripts Guide

Own local tooling, script wrappers, generated-artifact helper rules.

## Ownership Map

- Tests: `run-vitest.mjs`; follow [testing skill](../.agents/skills/openclaw-testing/SKILL.md) + [test-authoring skill](../.agents/skills/test-audit/SKILL.md).
- Lint/typecheck: `run-oxlint.mjs` + `run-tsgo.mjs` own repo-local runtime behavior; use them in package scripts and CI steps.
- Changed-file checks: `check-changed.mjs` owns execution; `changed-lanes.mjs` owns classification. Never copy path-scope rules into hooks/CI snippets.
- PR preparation: `pr` / `pr-lib` own source acquisition, correction reviews, gate bindings. Changing them: read [PR preparation](../docs/reference/scripts/pr-preparation.md).
- PR wrapper lifecycle: `pr` / `pr-lib` own supervision, locks, materialized dependencies. Changing/repairing them: read [PR wrapper tooling](../docs/reference/scripts/pr-tooling.md).
- GitHub transport: `pr-lib` owns observations + protected dispatch. Changing API/Octopool behavior: read [PR GitHub transport](../docs/reference/scripts/github-transport.md).
- Merge admission/recovery: `pr-lib` owns policy, retained outcomes, completion. Read [merge admission](../docs/reference/scripts/merge-admission.md), [merge recovery](../docs/reference/scripts/merge-recovery.md), or [prior-CI admin admission](../docs/reference/scripts/prior-ci.md) for that operation.
- Remote proof: `crabbox-wrapper.mjs` owns source capsules; `.github/actions/prepare-testbox-shell` owns shell/cwd. Changing them: read [remote gate contracts](../docs/reference/scripts/remote-gates.md). Operating boxes: use [Crabbox skill](../.agents/skills/crabbox/SKILL.md).
- Generated artifacts: align source generator, package script, verification command. Prefer `*:gen` / `*:check` pairs over undocumented one-offs.

## Wrapper Rules

- macOS-only Bash scripts: `#!/bin/bash`, Bash 3.2-compatible syntax. Invoke directly or with `/bin/bash`, including fixtures. Add new entrypoints to `nativeScripts` in `test/scripts/build-and-run-mac.test.ts`.
- Portable Bash entrypoints using heredocs/here-strings (including sourced helpers): copy the Darwin Bash 5.3+ re-exec guard from `test/scripts/build-and-run-mac.test.ts` before those operations (prevents heredoc pipe deadlocks) and add the file to `portableScripts`. stdin/sourced installers: request `/bin/bash` when replay impossible.
- Tests: run through `scripts/run-vitest.mjs` or root `pnpm test ...`; bare `vitest ...` starts local watch mode unless `run` or `--run` explicit.
- Lint (one/few files): direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>`, not sharded `pnpm lint`.

## TypeScript Syntax

- `scripts/**` TypeScript implementation files: erasable by Node without transformation; `pnpm check:script-erasability` enforces it.
- Native Node execution: opt-in per entrypoint + import closure, only when runtime imports stay Node-resolvable. Keep `tsx` for closures depending on source runtime trees, frozen checkouts, package aliases, or tsconfig/path resolution.

## PR Safety

- PR operations: follow [maintainer workflow](../.agents/skills/openclaw-pr-maintainer/SKILL.md). Gate modes: [landing](../.agents/skills/openclaw-pr-maintainer/references/landing.md). Default handoff: `merge-run --auto-merge`. Pending admission ≠ successful proof/merge completion.
- Landing subcommands require canonical/origin-main wrapper code. Never bypass wrapper trust, operation locks, exact-head review/gate bindings, live authority checks, or Octopool string rewrite protection; never select raw `gh` to get landing through.
- Before returning: join all PR-state-mutating children. Drained self-exited failures auto-release their operation lock; interrupted/uncertain locks stay held — verify no child tools remain before reported exact-OID `scripts/pr lock-recover` command. Never delete lock refs manually.
- Preserve transition journals, preparation evidence, outcome refs, captures. Never clear/push `refs/openclaw/pr-merge-outcomes/<PR>`, hand-edit receipts, or infer non-execution from failed command, elapsed time, absent process, or open PR.
- Accepted/pending/uncertain writes: investigate through [native recovery](../docs/reference/scripts/merge-recovery.md). Never blindly resubmit/switch transports. Existing land authority covers investigated same-scope recovery, not gate bypasses/new scope/method.
- Before comments/ownership-checked cleanup: confirm merge receipt. Completion comments: one attempt; reconcile uncertain comments by marker. Preserve worktrees/captures with unresolved outcome; never delete recreated branch by name.

## Execution Gotchas

- Fs-safe dependency trouble: follow [on-demand vendoring instructions](vendor-fs-safe.md); vendor contents local, registry dependencies default.
- Trusted normal checkout missing dependencies: `pnpm install --frozen-lockfile`, retry once before diagnosing code defect.
- Formatting: `pnpm format` defaults to oxfmt; `OPENCLAW_FORMAT_TOOL=bun` opts into the pinned fork. CI checks oxfmt/Bun parity. Generated-artifact gates retain oxfmt; see [caller inventory](README.md#formatting-and-lint-selection). Typechecking: repository `tsgo` lanes. Scope: `pnpm changed:lanes --json`; targeted tests/checks. Avoiding worktree reconciliation: `node scripts/run-vitest.mjs` with ready dependencies.
