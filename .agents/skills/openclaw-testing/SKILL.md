---
name: openclaw-testing
description: Choose proportional OpenClaw tests/checks, diagnose failures, route environment-sensitive or release proof to its owner.
---

# OpenClaw Testing

## Proof policy

- **PR CI = default broad proof.** Change builds + focused tests pass → open
  ready PR. CI runs broad suites; never delay PR for pre-PR suite runs.
- **Before PR, prove narrowly:** touched tests with
  `pnpm test <file> --maxWorkers=1`, targeted typecheck, lint, format.
  Prefer local proof for trusted, bounded work when dependencies and current
  host capacity are qualified. Local execution is optional: a focused command
  can still load a large compiler graph or expand to broad lanes.
- **Choose remote proof deliberately.** Use PR CI for broad proof; Crabbox/Testbox
  may cover expensive checks, a busy or unqualified local host, another OS/device,
  live providers/channels, long E2E, or heavy benchmarks. Acquire only when the
  command is ready and capacity is granted promptly. If queued, stop only the
  task-owned allocation; use PR CI or a safe local scope. Keep uncovered
  platform-specific proof pending. Never force heavy work onto a busy machine
  or chain providers. Use the smallest profile proven for the selected workload.
- **Never rerun or re-push just for green.** Fix real failures; read available
  CI failure classification before attributing red.

- Prove changed contract, complete required gates, finish. Broaden/repeat only for
  changed inputs, failures, or named unresolved risk.
- Follow scoped `AGENTS.md`; authoring/reviewing tests: use
  [boundary guide](../../../docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary)
  and [test-audit](../test-audit/SKILL.md).

## Select the proof

- Runtime defect: reproduce real entry point; rerun it + relevant siblings.
- Trusted source: `pnpm changed:lanes --json`, focused tests + targeted typecheck/lint/format; `pnpm check:changed` = optional smart local check.
- Public SDK/plugin contract: representative consumers, not all-plugin sweep.
- Build output, lazy imports, package boundaries: include `pnpm build`.
- Workflow: `git diff --check` + `pnpm check:workflows`.
- Docs only: relevant docs/link/format checks + `git diff --check`; no runtime tests.

- Read on demand: [local commands](../../../docs/reference/test.md),
  [Crabbox](../crabbox/SKILL.md), [OpenClaw remote setup](../../../docs/reference/test/remote-proof.md),
  [package/Docker proof](references/package-and-docker.md),
  [release CI](../release-openclaw-ci/SKILL.md),
  [plugin release matrix](../release-openclaw-plugin-testing/SKILL.md),
  [Docker authoring](../openclaw-docker-e2e-authoring/SKILL.md), channel skill/
  [Control UI E2E](../control-ui-e2e/SKILL.md).
- Mock-Gateway boundary proof valid; state live gaps.
- Release proof: preserve candidate/Tooling SHAs; never grants publication authority.

## Source and state boundaries

- Never execute untrusted contributor/fork code, wrappers, config locally.
  Use secretless fork CI or sanitized direct AWS through Crabbox; never
  credential-hydrated Testbox. Credentialed execution: maintainer approval after
  review required; never hydrate untrusted lease.
- Isolated state + free port. Never restart, edit, or test operator Gateway/real
  data without explicit per-task approval. Preserve unrelated processes and
  shared dependency installs.
- Concurrent test/check commands: separate `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH`
  values or run serially; checks can run Vitest too. Repository wrappers only,
  never raw Vitest. Prepared linked worktrees: `node scripts/check-changed.mjs`
  and `node scripts/run-vitest.mjs <file> --maxWorkers=1` avoid pnpm reconciliation.

## CI failures

- PR CI fails → `pnpm test:ci-failed <pr>`; read pre-existing/new/unknown classification.
- Fix new failures; investigate unknown → `pnpm test:ci-failed <pr> --run` until selected tests pass locally → push once.
- Pre-existing failures: [failure-table landing rule](../openclaw-pr-maintainer/references/landing.md#red-main-and-inherited-failures). Matching signatures ≠ job-name-only attribution.
- Never `gh run rerun` to chase green; never local full suite for CI repair.
- Bind diagnosis to exact SHA + job. Fetch failed logs once; prefer exact run/job
  state over stale PR rollups.
- Distinguish product, harness, infrastructure, credentials, superseded-run
  cancellation. Snapshots pass macOS/fail CI: reproduce Linux/Node bytes before
  regenerating.

### Test failure policy

- Failures = defects. Bounded reproduction attempt (same shard order first);
  identify owner; fix product, fixture, shared-state, ordering bugs.
- Proven repair: add regression; cite another owner's fix when applicable.
- Safe fix cannot be established/completed: record original failure, attempts,
  evidence, uncertainty in PR; continue under normal CI/review gates.
- Unresolved failure alone neither blocks landing nor requires extra approval.
  Passing replay ≠ proven fix.
- Never hide failures with retries, longer timeouts, weaker assertions, broader
  mocks, altered baselines.
