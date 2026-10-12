---
name: openclaw-testing
description: Choose proportional OpenClaw tests and checks, diagnose failures, and route environment-sensitive or release proof to its owner.
---

# OpenClaw Testing

## Proof policy

- **PR CI is the default broad proof.** Open a ready PR once the change builds
  and focused tests pass. Let CI run broad suites; do not delay a PR for
  pre-PR suite runs.
- **Before the PR, prove locally and narrowly:** touched tests with
  `pnpm test <file> --maxWorkers=1`, targeted typecheck, lint, and format.
  Local proof is the default for trusted work.
- **Boxes are the exception.** Use Crabbox/Testbox only for what CI and the local
  machine cannot cover: another OS/device, live providers/channels, long E2E,
  or heavy benchmarks. Use a box only when granted right away. If it queues,
  stop the queued task-owned allocation and run locally instead. Never wait on
  a box queue or chain Testbox → AWS → Hetzner fallbacks. If the local machine
  cannot cover the contract safely, record the gap; do not fake that proof.
- **Do not rerun or re-push just for green.** Fix real failures; read the CI
  failure classification when present before attributing a red.

Prove the changed contract, complete required gates, then finish. Broaden or
repeat only for changed inputs, failures, or a named unresolved risk. Follow
scoped `AGENTS.md`; use the [boundary guide](../../../docs/help/testing/writing-tests.md#prove-behavior-at-the-owning-boundary)
and [test-audit](../test-audit/SKILL.md) when authoring or reviewing tests.

## Select the proof

- Runtime defect: reproduce the real entry point, then rerun it and relevant siblings.
- Trusted source: `pnpm changed:lanes --json`, `pnpm check:changed`, focused tests.
- Public SDK/plugin contract: add representative consumers, not an all-plugin sweep.
- Build output, lazy imports, package boundaries: include `pnpm build`.
- Workflow: `git diff --check` and `pnpm check:workflows`.
- Docs only: relevant docs/link/format checks and `git diff --check`; no runtime tests.

Read on demand: [local commands](../../../docs/reference/test.md),
[Crabbox](../crabbox/SKILL.md) and [OpenClaw remote setup](../../../docs/reference/test/remote-proof.md),
[package/Docker proof](references/package-and-docker.md),
[release CI](../release-openclaw-ci/SKILL.md),
[plugin release matrix](../release-openclaw-plugin-testing/SKILL.md),
[Docker authoring](../openclaw-docker-e2e-authoring/SKILL.md), or the channel skill/
[Control UI E2E](../control-ui-e2e/SKILL.md). Mock-Gateway boundary proof is valid;
state live gaps. Release proof preserves candidate/Tooling SHAs and never grants
publication authority.

## Source and state boundaries

- Never execute untrusted contributor/fork code, wrappers, or config locally.
  Use secretless fork CI or sanitized direct AWS through Crabbox, never
  credential-hydrated Testbox. Credentialed execution needs maintainer approval
  after review; never hydrate an untrusted lease.
- Use isolated state and a free port. Never restart, edit, or test an operator
  Gateway or real data without explicit per-task approval. Preserve unrelated
  processes and shared dependency installs.
- Concurrent test/check commands must use separate
  `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH` values or run serially; checks can run
  Vitest too. Use repository wrappers, not raw Vitest. In prepared linked
  worktrees, `node scripts/check-changed.mjs` and
  `node scripts/run-vitest.mjs <file> --maxWorkers=1` avoid pnpm reconciliation.

## CI failures

Bind diagnosis to the exact SHA and job. Fetch failed logs once; prefer exact
run/job state to stale PR rollups. Distinguish product, harness, infrastructure,
credentials, and superseded-run cancellation. For snapshots passing on macOS
but failing in CI, reproduce Linux/Node bytes before regenerating.

### Test failure policy

Treat failures as defects. Make a bounded attempt to reproduce (same shard
order first), identify the owner, and fix product, fixture, shared-state, or
ordering bugs. Add a regression for a proven repair; cite another owner's fix
when applicable. If a safe fix cannot be established or completed, record the
original failure, attempts, evidence, and uncertainty in the PR, then continue
under normal CI/review gates. An unresolved failure alone neither blocks landing
nor requires extra approval. A passing replay does not prove a fix. Never hide
failures with retries, longer timeouts, weaker assertions, broader mocks, or
altered baselines.
