# scripts/ — Developer Scripts

This directory contains helper scripts for building, testing, deploying, and maintaining OpenClaw.

> **Total files**: 663 (as of 2026-05-12). The breakdown below is organized by functional category.
> For a complete file listing, browse the subdirectories directly.

## Check / Validation

Scripts for linting, static analysis, import-boundary enforcement, and code-quality checks.

| Path | Description |
|------|-------------|
| `check*.mjs` / `check*.ts` | Static analysis and boundary checks (~60 files) |
| `check-duplicates.mjs` | Find duplicate code patterns |
| `run-oxlint.mjs` | Run oxlint across the codebase |
| `run-opengrep.sh` | Run OpenGrep code scanning |
| `check.mjs` | Primary check orchestrator |

## Test / Benchmark

Test runners, live-environment tests, Docker-based integration tests, and performance benchmarks.

| Path | Description |
|------|-------------|
| `test-live*.mjs` / `test-live*.ts` / `test-live*.sh` | Live-environment tests |
| `test-docker*.sh` / `test-docker*.mjs` | Docker integration test suites |
| `test-projects.mjs` | Project-level test orchestration |
| `bench-*.ts` | Performance benchmarks (CLI startup, gateway, model) |
| `run-vitest.mjs` | Vitest test runner |
| `docker-e2e*.mjs` | End-to-end Docker test orchestration |

## CI / Orchestration

CI pipeline helpers, timing analyzers, scope detection, and retry logic.

| Path | Description |
|------|-------------|
| `ci-*.sh` / `ci-*.mjs` | CI helpers (auth hydration, retry, scope detection) |
| `changed-lanes.mjs` | Detect changed CI lanes |
| `ci-run-timings.mjs` | Analyze CI run durations |

## Build

Build orchestrators, bundlers, stamp generators, and packaging scripts.

| Path | Description |
|------|-------------|
| `build-all.mjs` | Full build orchestrator |
| `build-stamp.mjs` | Build metadata stamp |
| `bundle-a2ui.mjs` / `bundle-a2ui.sh` | A2UI bundler |
| `build-docs-list.mjs` | Generate docs file list |
| `build_icon.sh` | macOS app icon build |

## Plugin / SDK

Plugin release, boundary checks, inventory, and SDK surface reports.

| Path | Description |
|------|-------------|
| `plugin-*.mjs` / `plugin-*.ts` / `plugin-*.sh` | Plugin build, publish, release planning |
| `plugin-sdk-surface-report.mjs` | SDK surface area report |
| `postinstall-bundled-plugins.mjs` | Post-install plugin bundler |
| `sync-plugin-versions.ts` | Plugin version synchronization |
| `stage-bundled-plugin-runtime.mjs` | Stage bundled plugins |

## Config / Generation

Config schema generation, metadata baselines, and protocol generators.

| Path | Description |
|------|-------------|
| `generate-*.ts` / `generate-*.mjs` | Config schema, metadata, and snapshot generators |
| `load-channel-config-surface.ts` | Channel config surface loader |
| `protocol-gen.ts` / `protocol-gen-swift.ts` | Protocol code generators |

## Release / Deployment

Release preflight, packaging, notarization, and deployment scripts.

| Path | Description |
|------|-------------|
| `release-*.ts` / `release-*.mjs` | Release validation and preflight |
| `package-*.sh` / `package-*.mjs` | Packaging scripts (macOS, Docker, npm) |
| `notarize-mac-artifact.sh` | macOS code notarization |
| `codesign-mac-app.sh` | macOS code signing |
| `install.sh` / `install.ps1` | Installer scripts |
| `install-cli.sh` | CLI installer |

## Docs

Documentation generation, link auditing, spell-checking, and i18n.

| Path | Description |
|------|-------------|
| `docs-*.mjs` / `docs-*.js` / `docs-*.sh` | Docs generation and auditing |
| `format-docs.mjs` | Documentation formatter |
| `changelog-*.ts` / `changelog-*.sh` | Changelog utilities |
| `docs-i18n/` | Internationalization resources (~47 files) |

## Docker / Container

Container setup, sandbox images, and Docker-based testing infrastructure.

| Path | Description |
|------|-------------|
| `docker/` | Dockerfiles and setup scripts (~14 files) |
| `podman/` | Podman container support (~2 files) |
| `clawdock/` | ClawDock configuration (~2 files) |

## E2E Testing

End-to-end test suites for tool execution, gateway, and plugin workflows.

| Path | Description |
|------|-------------|
| `e2e/` | E2E test fixtures and runners (~162 files) |

## GitHub / PR Automation

PR management, issue labeling, and GitHub API helpers.

| Path | Description |
|------|-------------|
| `github/` | GitHub automation scripts (~5 files) |
| `pr-lib/` | PR review and preparation library (~8 files) |
| `mantis/` | PR evidence builders (~2 files) |

## Dev / Utilities

General-purpose dev utilities, node runners, and environment helpers.

| Path | Description |
|------|-------------|
| `dev/` | Development utilities (~7 files) |
| `lib/` | Shared script libraries (~97 files) |
| `run-node.mjs` / `watch-node.mjs` | Node.js runners with hot-reload |
| `pnpm-runner.mjs` / `npm-runner.mjs` | Package manager runners |
| `sandbox-*.sh` | Sandbox environment setup |

## Kubernetes

| Path | Description |
|------|-------------|
| `k8s/` | Kubernetes deployment configs (~7 files) |

## Platform-Specific

| Path | Description |
|------|-------------|
| `pre-commit/` | Git pre-commit hooks (~3 files) |
| `systemd/` | systemd service files (~2 files) |
| `android/` (in e2e) | Android build/test scripts |
| `ios-*.sh` / `ios-*.ts` | iOS build, signing, and release scripts |

---

> **Tip**: Use `just --list` from the repo root to see available developer shortcuts.
