# Scripts Guide

Own local tooling, script wrappers, generated-artifact helper rules. Repo-global policy: root `AGENTS.md`; read only task-relevant references.

## Ownership Map

- Tests: `run-vitest.mjs`; follow [testing skill](../.agents/skills/openclaw-testing/SKILL.md) + [test-authoring skill](../.agents/skills/test-audit/SKILL.md).
- Lint/typecheck: `run-oxlint.mjs` + `run-tsgo.mjs` own repo-local runtime behavior.
- Changed-file checks: `check-changed.mjs` owns execution; `changed-lanes.mjs` owns classification. Never copy path-scope rules into hooks/CI snippets.
- PR preparation: `pr` / `pr-lib` own source acquisition, correction reviews, gate bindings. Changing them: read [PR preparation](../docs/reference/scripts/pr-preparation.md).
- PR wrapper lifecycle: `pr` / `pr-lib` own supervision, locks, materialized dependencies. Changing/repairing them: read [PR wrapper tooling](../docs/reference/scripts/pr-tooling.md).
- GitHub transport: `pr-lib` owns observations + protected dispatch. Changing API/Octopool behavior: read [PR GitHub transport](../docs/reference/scripts/github-transport.md).
- Merge admission/recovery: `pr-lib` owns policy, retained outcomes, completion. Read [merge admission](../docs/reference/scripts/merge-admission.md), [merge recovery](../docs/reference/scripts/merge-recovery.md), or [prior-CI admin admission](../docs/reference/scripts/prior-ci.md) for that operation.
- Remote proof: `crabbox-wrapper.mjs` owns source capsules; `.github/actions/prepare-testbox-shell` owns shell/cwd. Changing them: read [remote gate contracts](../docs/reference/scripts/remote-gates.md). Operating boxes: use [Crabbox skill](../.agents/skills/crabbox/SKILL.md).
- Generated artifacts: align source generator, package script, verification command. Prefer `*:gen` / `*:check` pairs over undocumented one-offs.

## Wrapper Rules

- macOS-only Bash scripts: `#!/bin/bash`, Bash 3.2-compatible syntax. Invoke directly or with `/bin/bash`, including fixtures.
- Portable Bash entrypoints using heredocs/here-strings (including sourced helpers): inline Darwin Bash 5.3+ re-exec guard before those operations prevents heredoc pipe deadlocks. stdin/sourced installers: request `/bin/bash` when replay impossible.
- Existing curated repo seam: prefer wrappers over raw tool entrypoints.
- Tests: prefer `scripts/run-vitest.mjs` or root `pnpm test ...` entrypoints over raw `vitest run` calls.
- Never bare `vitest ...` in automation: starts local watch mode unless `run` or `--run` explicit.
- Adding/editing package scripts or CI steps honoring repo-local lint/typecheck runtime behavior: prefer `scripts/run-oxlint.mjs` + `scripts/run-tsgo.mjs`.
- Before checks, inspect changed-file scope: `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]`.
- Lint (one/few files): prefer direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>` over sharded `pnpm lint`. `check-changed.mjs` owns targeting for core, extension, script diffs.

## TypeScript Syntax

- `scripts/**` TypeScript implementation files: erasable by Node without transformation. No parameter properties, runtime enums/namespaces, import-equals, export-assignment, or other transform-required TypeScript syntax.
- Syntax rule ≠ every script a plain-Node entrypoint. Keep `tsx` for closures intentionally depending on source runtime trees, frozen checkouts, package aliases, or tsconfig/path resolution.
- Native Node execution: opt-in per entrypoint + import closure. Only when runtime imports stay Node-resolvable; never pull broader source trees into this syntax policy.

## Proof Rules

- PR CI = default broad proof. Change builds + focused tests pass → open ready PR; never hold for pre-PR suite runs.
- Before PR: narrow proof — touched tests (`pnpm test <file> --maxWorkers=1`) + targeted typecheck/lint/format. Prefer local execution for trusted, bounded work when dependencies and current host capacity are qualified; local execution is optional.
- Boxes: deliberate remote proof for expensive checks, a busy/unqualified local host, another OS/device, live providers/channels, long E2E or heavy benchmarks. Acquire when the command is ready; use the smallest proven profile. Queued → stop only task-owned allocation, use PR CI or a safe local scope; keep platform-specific gaps pending. Never force heavy local checks or chain provider fallbacks.
- CI fails → `pnpm test:ci-failed <pr>`; read published classification (pre-existing on main vs new). Fix new failures → `pnpm test:ci-failed <pr> --run` until local pass → push once. Pre-existing: failure-table landing rule. Never rerun/re-push just for green (`gh run rerun` included); never local full suite for CI repair.
- Untrusted contributor/fork code: secretless isolation. Credentialed execution needs maintainer authorization; scope live credentials + isolate Gateway/state.

## PR Safety

- PR operations: follow [maintainer workflow](../.agents/skills/openclaw-pr-maintainer/SKILL.md). Unset `OPENCLAW_PR_GATES_REMOTE` = GitHub default; explicit `OPENCLAW_PR_GATES_REMOTE=github` equivalent. Default handoff: `merge-run --auto-merge`. Old full local gates: explicit `OPENCLAW_PR_GATES_REMOTE=local`. `OPENCLAW_TESTBOX=1` + unset remote selector retains hosted mode. Pending admission ≠ successful proof/merge completion.
- Landing subcommands require canonical/origin-main wrapper code. Never bypass wrapper trust, operation locks, exact-head review/gate bindings, live authority checks, or Octopool string rewrite protection; never select raw `gh` to get landing through.
- Before returning: join all PR-state-mutating children. Drained self-exited failures auto-release their operation lock; interrupted/uncertain locks stay held — verify no child tools remain before reported exact-OID `scripts/pr lock-recover` command. Never delete lock refs manually.
- Preserve transition journals, preparation evidence, outcome refs, captures. Never clear/push `refs/openclaw/pr-merge-outcomes/<PR>`, hand-edit receipts, or infer non-execution from failed command, elapsed time, absent process, or open PR.
- Accepted/pending/uncertain writes: investigate through [native recovery](../docs/reference/scripts/merge-recovery.md). Never blindly resubmit/switch transports. Existing land authority covers investigated same-scope recovery, not gate bypasses/new scope/method.
- Before comments/ownership-checked cleanup: confirm merge receipt. Completion comments: one attempt; reconcile uncertain comments by marker. Preserve worktrees/captures with unresolved outcome; never delete recreated branch by name.

## Execution Gotchas

Commands apply within task authority/safety boundaries. Prefer bounded local proof when dependencies and current host capacity are qualified.

- Fs-safe dependency trouble: follow [on-demand vendoring instructions](vendor-fs-safe.md); vendor contents local, registry dependencies default.
- Trusted normal checkout missing dependencies: `pnpm install --frozen-lockfile`, retry once before diagnosing code defect. Never reconcile shared/worktree install while other jobs use it.
- CLI: `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`; supported wrappers own build freshness + process setup.
- Formatting: installed `oxfmt`; typechecking: repository `tsgo` lanes. Scope: `pnpm changed:lanes --json`; targeted tests/checks. Avoiding worktree reconciliation: `node scripts/check-changed.mjs` or `node scripts/run-vitest.mjs` with ready dependencies.
