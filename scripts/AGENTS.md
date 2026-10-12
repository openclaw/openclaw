# Scripts Guide

This directory owns local tooling, script wrappers, and generated-artifact helper rules. Keep repo-global policy in the root `AGENTS.md`; read only the references relevant to the task.

## Ownership Map

- Tests: `run-vitest.mjs`; follow the [testing skill](../.agents/skills/openclaw-testing/SKILL.md) and [test-authoring skill](../.agents/skills/test-audit/SKILL.md).
- Lint/typecheck: `run-oxlint.mjs` and `run-tsgo.mjs` own repo-local runtime behavior.
- Changed-file checks: `check-changed.mjs` owns execution; `changed-lanes.mjs` owns classification. Do not copy path-scope rules into hooks or CI snippets.
- PR preparation: `pr` / `pr-lib` own source acquisition, correction reviews, and gate bindings; read [PR preparation](../docs/reference/scripts/pr-preparation.md) when changing them.
- PR wrapper lifecycle: `pr` / `pr-lib` own supervision, locks, and materialized dependencies; read [PR wrapper tooling](../docs/reference/scripts/pr-tooling.md) when changing or repairing them.
- GitHub transport: `pr-lib` owns observations and protected dispatch; read [PR GitHub transport](../docs/reference/scripts/github-transport.md) when changing API or Octopool behavior.
- Merge admission and recovery: `pr-lib` owns policy, retained outcomes, and completion; read [merge admission](../docs/reference/scripts/merge-admission.md), [merge recovery](../docs/reference/scripts/merge-recovery.md), or [prior-CI admin admission](../docs/reference/scripts/prior-ci.md) for that operation.
- Remote proof: `crabbox-wrapper.mjs` owns source capsules; `.github/actions/prepare-testbox-shell` owns shell/cwd. Read [remote gate contracts](../docs/reference/scripts/remote-gates.md) when changing them; use the [Crabbox skill](../.agents/skills/crabbox/SKILL.md) to operate boxes.
- Generated artifacts: keep the source generator, package script, and verification command aligned; prefer `*:gen` / `*:check` pairs over undocumented one-offs.

## Wrapper Rules

- macOS-only Bash scripts use `#!/bin/bash` and Bash 3.2-compatible syntax; invoke them directly or with `/bin/bash`, including fixtures.
- Portable Bash entrypoints using heredocs/here-strings (including sourced helpers) carry the inline Darwin Bash 5.3+ re-exec guard before those operations to prevent heredoc pipe deadlocks; stdin/sourced installers must request `/bin/bash` when replay is impossible.
- Prefer existing wrappers over raw tool entrypoints when the repo already has a curated seam.
- For tests, prefer `scripts/run-vitest.mjs` or the root `pnpm test ...` entrypoints over raw `vitest run` calls.
- Never use bare `vitest ...` in automation; it starts local watch mode unless `run` or `--run` is explicit.
- For lint/typecheck flows, prefer `scripts/run-oxlint.mjs` and `scripts/run-tsgo.mjs` when adding or editing package scripts or CI steps that should honor repo-local runtime behavior.
- Inspect changed-file scope before running checks: `node scripts/check-changed.mjs --dry-run [--staged|-- <files...>]`.
- For one/few lint files, prefer direct `node scripts/run-oxlint.mjs --tsconfig <matching config> <files...>` over sharded `pnpm lint`; `check-changed.mjs` owns this targeting for core, extension, and script diffs.

## TypeScript Syntax

- Keep TypeScript implementation files under `scripts/**` erasable by Node without transformation. Do not use parameter properties, runtime enums or namespaces, import-equals, export-assignment, or other transform-required TypeScript syntax.
- This syntax rule does not make every script a plain-Node entrypoint. Keep `tsx` for closures that intentionally depend on source runtime trees, frozen checkouts, package aliases, or tsconfig/path resolution.
- Native Node execution is opt-in per entrypoint and import closure. Use it only when runtime imports remain Node-resolvable and do not pull broader source trees into this syntax policy.

## Proof Rules

- PR CI is the default broad proof. Open a ready PR as soon as the change builds and its focused tests pass; do not hold it back for pre-PR suite runs.
- Before the PR, prove locally and narrowly: touched tests (`pnpm test <file> --maxWorkers=1`) and targeted typecheck/lint/format. Local proof is the default for trusted work.
- Boxes are the exception: use Crabbox/Testbox only for what CI and the local machine cannot cover (another OS or device, live providers/channels, long E2E, heavy benchmarks), and only when granted immediately. If it queues, run locally instead. Never wait on a box queue or chain Testbox → AWS → Hetzner fallbacks.
- Do not rerun or re-push just for green. Fix real failures. Read CI's published failure classification (pre-existing on main vs new) before attributing a red.
- Keep untrusted contributor/fork code in secretless isolation. Credentialed execution needs maintainer authorization; scope live credentials and isolate Gateway/state.

## PR Safety

- Follow the [maintainer workflow](../.agents/skills/openclaw-pr-maintainer/SKILL.md) for PR operations. Use `OPENCLAW_PR_GATES_REMOTE=github` and `merge-run --auto-merge` for the default handoff; pending admission is not successful proof or merge completion.
- Landing subcommands require canonical/origin-main wrapper code. Never bypass wrapper trust, operation locks, exact-head review/gate bindings, live authority checks, or Octopool string rewrite protection; never select raw `gh` to get a landing through.
- Join all PR-state-mutating children before returning. Preserve failed/uncertain operation locks; verify no child tools remain before using the reported exact-OID `scripts/pr lock-recover` command. Never delete lock refs manually.
- Preserve transition journals, preparation evidence, outcome refs, and captures. Never clear or push `refs/openclaw/pr-merge-outcomes/<PR>`, edit receipts by hand, or infer non-execution from a failed command, elapsed time, absent process, or open PR.
- Investigate accepted, pending, or uncertain writes through [native recovery](../docs/reference/scripts/merge-recovery.md); never blindly resubmit or switch transports. Existing land authority covers investigated recovery in the same scope, not gate bypasses or a new scope/method.
- Confirm a merge receipt before comments or ownership-checked cleanup. Keep completion comments to one attempt; reconcile uncertain comments by their marker. Preserve worktrees/captures whose outcome is unresolved, and never delete a recreated branch by name.

## Execution Gotchas

These commands apply within the task's authority and safety boundaries. Local focused proof is the default for trusted work.

- For fs-safe dependency trouble, follow [on-demand vendoring instructions](vendor-fs-safe.md); keep vendor contents local and registry dependencies as the default.
- Restore missing dependencies in a trusted normal checkout with `pnpm install --frozen-lockfile`, then retry once before diagnosing a code defect. Never reconcile a shared/worktree install while other jobs use it.
- Run the CLI through `pnpm openclaw ...` or `pnpm dev`, never `node --import tsx src/index.ts`; the supported wrappers own build freshness and process setup.
- Use installed `oxfmt` for formatting and the repository's `tsgo` lanes for typechecking. Inspect scope with `pnpm changed:lanes --json`; use targeted tests/checks. When avoiding worktree reconciliation, use `node scripts/check-changed.mjs` or `node scripts/run-vitest.mjs` with ready dependencies.
