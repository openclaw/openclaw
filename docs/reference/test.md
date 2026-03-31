---
summary: "How to run tests locally (vitest) and when to use force/coverage modes"
read_when:
  - Running or fixing tests
title: "Tests"
---

# Tests

- Full testing kit (suites, live, Docker): [Testing](/help/testing)

- `pnpm test:force`: Kills any lingering gateway process holding the default control port, then runs the full Vitest suite with an isolated gateway port so server tests don’t collide with a running instance. Use this when a prior gateway run left port 18789 occupied.
- `pnpm test:coverage`: Runs the unit suite with V8 coverage (via `vitest.unit.config.ts`). Global thresholds are 70% lines/branches/functions/statements. Coverage excludes integration-heavy entrypoints (CLI wiring, gateway/telegram bridges, webchat static server) to keep the target focused on unit-testable logic.
- `pnpm test:coverage:changed`: Runs unit coverage only for files changed since `origin/main`.
- `pnpm test:changed`: runs the wrapper with `--changed origin/main`. The base Vitest config treats the wrapper manifests/config files as `forceRerunTriggers` so scheduler changes still rerun broadly when needed.
- `pnpm test`: runs the full wrapper. It keeps only a small behavioral override manifest in git, then uses a checked-in timing snapshot to peel the heaviest measured unit files into dedicated lanes.
- Unit files default to `threads` in the wrapper; keep fork-only exceptions documented in `test/fixtures/test-parallel.behavior.json`.
- `pnpm test:channels` now defaults to `threads` via `vitest.channels.config.ts`; the March 22, 2026 direct full-suite control run passed clean without channel-specific fork exceptions.
- `pnpm test:extensions` runs through the wrapper and keeps documented extension fork-only exceptions in `test/fixtures/test-parallel.behavior.json`; the shared extension lane still defaults to `threads`.
- `pnpm test:extensions`: runs extension/plugin suites.
- `pnpm test:perf:imports`: enables Vitest import-duration + import-breakdown reporting for the wrapper.
- `pnpm test:perf:imports:changed`: same import profiling, but only for files changed since `origin/main`.
- `pnpm test:perf:profile:main`: writes a CPU profile for the Vitest main thread (`.artifacts/vitest-main-profile`).
- `pnpm test:perf:profile:runner`: writes CPU + heap profiles for the unit runner (`.artifacts/vitest-runner-profile`).
- `pnpm test:perf:update-timings`: refreshes the checked-in slow-file timing snapshot used by `scripts/test-parallel.mjs`.
- Gateway integration: opt-in via `OPENCLAW_TEST_INCLUDE_GATEWAY=1 pnpm test` or `pnpm test:gateway`.
- `pnpm test:e2e`: Runs gateway end-to-end smoke tests (multi-instance WS/HTTP/node pairing). Defaults to `forks` + adaptive workers in `vitest.e2e.config.ts`; tune with `OPENCLAW_E2E_WORKERS=<n>` and set `OPENCLAW_E2E_VERBOSE=1` for verbose logs.
- `pnpm test:live`: Runs provider live tests (minimax/zai). Requires API keys and `LIVE=1` (or provider-specific `*_LIVE_TEST=1`) to unskip.
- `pnpm test:docker:openwebui`: Starts Dockerized OpenClaw + Open WebUI, signs in through Open WebUI, checks `/api/models`, then runs a real proxied chat through `/api/chat/completions`. Requires a usable live model key (for example OpenAI in `~/.profile`), pulls an external Open WebUI image, and is not expected to be CI-stable like the normal unit/e2e suites.
- `pnpm test:docker:mcp-channels`: Starts a seeded Gateway container and a second client container that spawns `openclaw mcp serve`, then verifies routed conversation discovery, transcript reads, attachment metadata, live event queue behavior, outbound send routing, and Claude-style channel + permission notifications over the real stdio bridge. The Claude notification assertion reads the raw stdio MCP frames directly so the smoke reflects what the bridge actually emits.

## Local PR gate

For local PR land/gate checks, run:

- `pnpm check`
- `pnpm build`
- `pnpm test`
- `pnpm check:docs`

If `pnpm test` flakes on a loaded host, rerun once before treating it as a regression, then isolate with `pnpm vitest run <path/to/test>`. For memory-constrained hosts, use:

- `OPENCLAW_TEST_PROFILE=low OPENCLAW_TEST_SERIAL_GATEWAY=1 pnpm test`
- `OPENCLAW_VITEST_FS_MODULE_CACHE_PATH=/tmp/openclaw-vitest-cache pnpm test:changed`

## Model latency bench (local keys)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Usage:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Optional env: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Default prompt: “Reply with a single word: ok. No punctuation or extra text.”

Last run (2025-12-31, 20 runs):

- minimax median 1279ms (min 1114, max 2431)
- opus median 2454ms (min 1224, max 3170)

## CLI startup bench

Script: [`scripts/bench-cli-startup.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-cli-startup.ts)

Usage:

- `pnpm test:startup:bench`
- `pnpm test:startup:bench:smoke`
- `pnpm test:startup:bench:save`
- `pnpm test:startup:bench:update`
- `pnpm test:startup:bench:check`
- `pnpm tsx scripts/bench-cli-startup.ts`
- `pnpm tsx scripts/bench-cli-startup.ts --runs 12`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case status --case gatewayStatus --runs 3`
- `pnpm tsx scripts/bench-cli-startup.ts --entry openclaw.mjs --entry-secondary dist/entry.js --preset all`
- `pnpm tsx scripts/bench-cli-startup.ts --preset all --output .artifacts/cli-startup-bench-all.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --case gatewayStatusJson --output .artifacts/cli-startup-bench-smoke.json`
- `pnpm tsx scripts/bench-cli-startup.ts --preset real --cpu-prof-dir .artifacts/cli-cpu`
- `pnpm tsx scripts/bench-cli-startup.ts --json`

Presets:

- `startup`: `--version`, `--help`, `health`, `health --json`, `status --json`, `status`
- `real`: `health`, `status`, `status --json`, `sessions`, `sessions --json`, `agents list --json`, `gateway status`, `gateway status --json`, `gateway health --json`, `config get gateway.port`
- `all`: both presets

Output includes avg, p50, p95, min/max, exit-code/signal distribution, and max RSS summaries for each command. Optional `--cpu-prof-dir` / `--heap-prof-dir` writes V8 profiles per run so timing and profile capture use the same harness.

Saved output conventions:

- `pnpm test:startup:bench:smoke` writes the targeted smoke artifact at `.artifacts/cli-startup-bench-smoke.json`
- `pnpm test:startup:bench:save` writes the full-suite artifact at `.artifacts/cli-startup-bench-all.json`
- `pnpm test:startup:bench:update` refreshes the checked-in baseline fixture at `test/fixtures/cli-startup-bench.json`

Checked-in fixture:

- `test/fixtures/cli-startup-bench.json`
- Refresh with `pnpm test:startup:bench:update`
- Compare current results against the fixture with `pnpm test:startup:bench:check`

## Onboarding E2E (Docker)

Docker is optional; this is only needed for containerized onboarding smoke tests.

Full cold-start flow in a clean Linux container:

```bash
scripts/e2e/onboard-docker.sh
```

This script drives the interactive wizard via a pseudo-tty, verifies config/workspace/session files, then starts the gateway and runs `openclaw health`.

## QR import smoke (Docker)

Ensures `qrcode-terminal` loads under the supported Docker Node runtimes (Node 24 default, Node 22 compatible):

```bash
pnpm test:docker:qr
```
