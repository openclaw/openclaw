---
title: CI Pipeline
description: How the OpenClaw CI pipeline works and why jobs are ordered the way they are.
---

# CI Pipeline

OpenClaw uses a tiered CI pipeline that fails fast on cheap checks before
running expensive builds and tests. This saves runner minutes and reduces
GitHub API pressure.

## Pipeline Tiers

```
Tier 0 — Scope detection (~12 s, free runners)
  docs-scope → changed-scope

Tier 1 — Cheapest gates (parallel, ~43 s)
  check-format     secrets

Tier 2 — After format (parallel, ~2 min)
  check-lint       code-size

Tier 3 — Build (~3 min)
  build-artifacts   install-check

Tier 4 — Tests (~5 min)
  checks (node tsgo / test / protocol, bun test)
  checks-windows (lint / test / protocol)

Tier 5 — Platform (most expensive)
  macos (TS tests + Swift lint/build/test)
  android (test + build)
  ios (disabled)
```

## Dependency Graph

```
docs-scope ──► changed-scope ──┐
                                │
check-format ──► check-lint  ──►├──► build-artifacts ──► checks-windows
             ├─► code-size  ──►├──► install-check
                                ├──► checks
                                ├──► macos
                                └──► android
secrets (independent)
```

## Job Details

### Tier 0 — Scope Detection

| Job             | Runner          | Purpose                                                                 |
| --------------- | --------------- | ----------------------------------------------------------------------- |
| `docs-scope`    | `ubuntu-latest` | Detects docs-only PRs to skip heavy jobs                                |
| `changed-scope` | `ubuntu-latest` | Detects which areas changed (node/macos/android) to skip unrelated jobs |

### Tier 1 — Cheapest Gates

| Job            | Runner            | Purpose                                     |
| -------------- | ----------------- | ------------------------------------------- |
| `check-format` | Blacksmith 4 vCPU | Runs `pnpm format` — cheapest gate (~43 s)  |
| `secrets`      | Blacksmith 4 vCPU | Runs `detect-secrets` scan against baseline |

### Tier 2 — After Format

| Job          | Runner            | Depends on     | Purpose                                                     |
| ------------ | ----------------- | -------------- | ----------------------------------------------------------- |
| `check-lint` | Blacksmith 4 vCPU | `check-format` | Runs `pnpm lint` — cleaner output after format passes       |
| `code-size`  | Blacksmith 4 vCPU | `check-format` | Checks LOC thresholds — accurate counts need formatted code |

### Tier 3 — Build

| Job               | Runner            | Depends on                | Purpose                               |
| ----------------- | ----------------- | ------------------------- | ------------------------------------- |
| `build-artifacts` | Blacksmith 4 vCPU | `check-lint`, `code-size` | Builds dist and uploads artifact      |
| `install-check`   | Blacksmith 4 vCPU | `check-lint`, `code-size` | Verifies `pnpm install` works cleanly |

### Tier 4+ — Tests and Platform

| Job              | Runner             | Depends on                                   | Purpose                                                |
| ---------------- | ------------------ | -------------------------------------------- | ------------------------------------------------------ |
| `checks`         | Blacksmith 4 vCPU  | `check-lint`, `code-size`                    | TypeScript checks, tests (Node + Bun), protocol checks |
| `checks-windows` | Blacksmith Windows | `build-artifacts`, `check-lint`, `code-size` | Windows-specific lint, tests, protocol checks          |
| `macos`          | `macos-latest`     | `check-lint`, `code-size`                    | TS tests + Swift lint/build/test (PR only)             |
| `android`        | Blacksmith 4 vCPU  | `check-lint`, `code-size`                    | Gradle test + build                                    |

## Code-Size Gate

The `code-size` job runs `scripts/analyze_code_files.py` on PRs to catch:

1. **Threshold crossings** — files that grew past 1000 lines in the PR
2. **Already-large files growing** — files already over 1000 lines that got bigger
3. **Duplicate function regressions** — new duplicate functions introduced by the PR

When `--strict` is set, any violation fails the job and blocks all downstream
work. On push to `main`, the code-size steps are skipped (the job passes as a
no-op) so pushes still run the full test suite.

### Excluded Directories

The analysis skips: `node_modules`, `dist`, `vendor`, `.git`, `coverage`,
`Swabble`, `skills`, `.pi` and other non-source directories. See the
`SKIP_DIRS` set in `scripts/analyze_code_files.py` for the full list.

## Fail-Fast Behavior

**Bad PR (formatting violations):**

- `check-format` fails at ~43 s
- `check-lint`, `code-size`, and all downstream jobs never start
- Total cost: ~1 runner-minute

**Bad PR (lint or LOC violations, good format):**

- `check-format` passes → `check-lint` and `code-size` run in parallel
- One or both fail → all downstream jobs skipped
- Total cost: ~3 runner-minutes

**Good PR:**

- Critical path: `check-format` (43 s) → `check-lint` (1m 46 s) → `build-artifacts` → `checks`
- `code-size` runs in parallel with `check-lint`, adding no latency

## Composite Action

The `setup-node-env` composite action (`.github/actions/setup-node-env/`)
handles the shared setup boilerplate:

- Submodule init/update with retry (5 attempts, exponential backoff)
- Node.js 22 setup
- pnpm via corepack + store cache
- Optional Bun install
- `pnpm install` with retry

The `macos` job also caches SwiftPM packages (`~/Library/Caches/org.swift.swiftpm`)
to speed up dependency resolution.

This eliminates ~40 lines of duplicated YAML per job.

## Push vs PR Behavior

| Trigger        | `code-size`                   | Downstream jobs       |
| -------------- | ----------------------------- | --------------------- |
| Push to `main` | Steps skipped (job passes)    | Run normally          |
| Pull request   | Full analysis with `--strict` | Blocked on violations |

## Runners

| Name                            | OS           | vCPUs | Used by          |
| ------------------------------- | ------------ | ----- | ---------------- |
| `blacksmith-4vcpu-ubuntu-2404`  | Ubuntu 24.04 | 4     | Most jobs        |
| `blacksmith-4vcpu-windows-2025` | Windows 2025 | 4     | `checks-windows` |
| `macos-latest`                  | macOS        | —     | `macos`, `ios`   |
| `ubuntu-latest`                 | Ubuntu       | 2     | Scope detection  |
