---
title: CI Pipeline
summary: "CI job graph, scope gates, and local command equivalents"
read_when:
  - You need to understand why a CI job did or did not run
  - You are debugging failing GitHub Actions checks
---

# CI Pipeline

The CI runs on every push to `main` and every pull request. It uses smart scoping to skip expensive jobs when only unrelated areas changed.

## Job Overview

| Job                              | Purpose                                                                                      | When it runs                        |
| -------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
| `preflight`                      | Detect docs-only changes, changed scopes, changed extensions, and build the CI manifest      | Always on non-draft pushes and PRs  |
| `security-scm-fast`              | Private key detection and workflow audit via `zizmor`                                        | Always on non-draft pushes and PRs  |
| `security-dependency-audit`      | Dependency-free production lockfile audit against npm advisories                             | Always on non-draft pushes and PRs  |
| `security-fast`                  | Required aggregate for the fast security jobs                                                | Always on non-draft pushes and PRs  |
| `build-artifacts`                | Build `dist/` and the Control UI once, upload reusable artifacts for downstream jobs         | Node-relevant changes               |
| `checks-fast-core`               | Fast Linux correctness lanes such as bundled/plugin-contract/protocol checks                 | Node-relevant changes               |
| `checks-fast-contracts-channels` | Sharded channel contract checks with a stable aggregate check result                         | Node-relevant changes               |
| `checks-node-extensions`         | Full bundled-plugin test shards across the extension suite                                   | Node-relevant changes               |
| `checks-node-core-test`          | Core Node test shards, excluding channel, bundled, contract, and extension lanes             | Node-relevant changes               |
| `extension-fast`                 | Focused tests for only the changed bundled plugins                                           | When extension changes are detected |
| `check`                          | Sharded main local gate equivalent: prod types, lint, guards, test types, and strict smoke   | Node-relevant changes               |
| `check-additional`               | Architecture, boundary, extension-surface guards, package-boundary, and gateway-watch shards | Node-relevant changes               |
| `build-smoke`                    | Built-CLI smoke tests and startup-memory smoke                                               | Node-relevant changes               |
| `checks`                         | Remaining Linux Node lanes: channel tests and push-only Node 22 compatibility                | Node-relevant changes               |
| `check-docs`                     | Docs formatting, lint, and broken-link checks                                                | Docs changed                        |
| `skills-python`                  | Ruff + pytest for Python-backed skills                                                       | Python-skill-relevant changes       |
| `checks-windows`                 | Windows-specific test lanes                                                                  | Windows-relevant changes            |
| `macos-node`                     | macOS TypeScript test lane using the shared built artifacts                                  | macOS-relevant changes              |
| `macos-swift`                    | Swift lint, build, and tests for the macOS app                                               | macOS-relevant changes              |
| `android`                        | Android build and test matrix                                                                | Android-relevant changes            |

## Fail-Fast Order

Jobs are ordered so cheap checks fail before expensive ones run:

1. `preflight` decides which lanes exist at all. The `docs-scope` and `changed-scope` logic are steps inside this job, not standalone jobs.
2. `security-scm-fast`, `security-dependency-audit`, `security-fast`, `check`, `check-additional`, `check-docs`, and `skills-python` fail quickly without waiting on the heavier artifact and platform matrix jobs.
3. `build-artifacts` overlaps with the fast Linux lanes so downstream consumers can start as soon as the shared build is ready.
4. Heavier platform and runtime lanes fan out after that: `checks-fast-core`, `checks-fast-contracts-channels`, `checks-node-extensions`, `checks-node-core-test`, `extension-fast`, `checks`, `checks-windows`, `macos-node`, `macos-swift`, and `android`.

Scope logic lives in `scripts/ci-changed-scope.mjs` and is covered by unit tests in `src/scripts/ci-changed-scope.test.ts`.
CI workflow edits validate the Node CI graph plus workflow linting, but do not force Windows, Android, or macOS native builds by themselves; those platform lanes stay scoped to platform source changes.
Windows Node checks are scoped to Windows-specific process/path wrappers, npm/pnpm/UI runner helpers, package manager config, and the CI workflow surfaces that execute that lane; unrelated source, plugin, install-smoke, and test-only changes stay on the Linux Node lanes so they do not reserve a 16-vCPU Windows worker for coverage that is already exercised by the normal test shards.
The separate `install-smoke` workflow reuses the same scope script through its own `preflight` job. It computes `run_install_smoke` from the narrower changed-smoke signal, so Docker/install smoke only runs for install, packaging, and container-relevant changes. Its QR package smoke forces the Docker `pnpm install` layer to rerun while preserving the BuildKit pnpm store cache, so it still exercises installation without redownloading dependencies on every run. Its gateway-network e2e reuses the runtime image built earlier in the job, so it adds real container-to-container WebSocket coverage without adding another Docker build.

Local changed-lane logic lives in `scripts/changed-lanes.mjs` and is executed by `scripts/check-changed.mjs`. That local gate is stricter about architecture boundaries than the broad CI platform scope: core production changes run core prod typecheck plus core tests, core test-only changes run only core test typecheck/tests, extension production changes run extension prod typecheck plus extension tests, and extension test-only changes run only extension test typecheck/tests. Public Plugin SDK or plugin-contract changes expand to extension validation because extensions depend on those core contracts. Release metadata-only version bumps run targeted version/config/root-dependency checks. Unknown root/config changes fail safe to all lanes.

On pushes, the `checks` matrix adds the push-only `compat-node22` lane. On pull requests, that lane is skipped and the matrix stays focused on the normal test/channel lanes.

The slowest Node test families are split or balanced so each job stays small: channel contracts split registry and core coverage into eight weighted shards each, bundled plugin tests balance across six extension workers, auto-reply runs as three balanced workers instead of six tiny workers, and agentic gateway/plugin configs are spread across the existing source-only agentic Node jobs instead of waiting on built artifacts. `check-additional` keeps package-boundary compile/canary work together and separates it from runtime topology gateway/architecture work; the boundary guard shard runs its small independent guards concurrently inside one job, and the gateway watch regression uses the minimal `gatewayWatch` build profile instead of rebuilding the full CI artifact sidecar set.

GitHub may mark superseded jobs as `cancelled` when a newer push lands on the same PR or `main` ref. Treat that as CI noise unless the newest run for the same ref is also failing. Aggregate shard checks use `!cancelled() && always()` so they still report normal shard failures but do not queue after the whole workflow has already been superseded.
The CI concurrency key is versioned (`CI-v6-*`) so a GitHub-side zombie in an old queue group cannot indefinitely block newer main runs.

## Runners

| Runner                           | Jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ubuntu-24.04`                   | `preflight`, fast security jobs and aggregates (`security-scm-fast`, `security-dependency-audit`, `security-fast`), fast protocol/contract/bundled checks, sharded channel contract checks, `check` shards except lint, `check-additional` shards and aggregates, Node test aggregate verifiers, docs checks, Python skills, workflow-sanity, labeler, auto-response; install-smoke preflight also uses GitHub-hosted Ubuntu so the Blacksmith matrix can queue earlier |
| `blacksmith-8vcpu-ubuntu-2404`   | `build-artifacts`, build-smoke, Linux Node test shards, bundled plugin test shards, remaining built-artifact consumers, `android`                                                                                                                                                                                                                                                                                                                                       |
| `blacksmith-16vcpu-ubuntu-2404`  | `check-lint`, which remains CPU-sensitive enough that 8 vCPU cost more than it saved; install-smoke Docker builds, where 32-vCPU queue time cost more than it saved                                                                                                                                                                                                                                                                                                     |
| `blacksmith-16vcpu-windows-2025` | `checks-windows`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blacksmith-6vcpu-macos-latest`  | `macos-node` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `blacksmith-12vcpu-macos-latest` | `macos-swift` on `openclaw/openclaw`; forks fall back to `macos-latest`                                                                                                                                                                                                                                                                                                                                                                                                 |

## Local Equivalents

```bash
pnpm changed:lanes   # inspect the local changed-lane classifier for origin/main...HEAD
pnpm check:changed   # smart local gate: changed typecheck/lint/tests by boundary lane
pnpm check          # fast local gate: production tsgo + sharded lint + parallel fast guards
pnpm check:test-types
pnpm check:timed    # same gate with per-stage timings
pnpm build:strict-smoke
pnpm check:architecture
pnpm test:gateway:watch-regression
pnpm test           # vitest tests
pnpm test:channels
pnpm test:contracts:channels
pnpm check:docs     # docs format + lint + broken links
pnpm build          # build dist when CI artifact/build-smoke lanes matter
```
