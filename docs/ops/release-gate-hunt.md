---
title: "Release-Gate Hunt"
summary: "Per-release dual-lane hunt runbook for OpenClaw updates"
---

# Release-Gate Hunt

Use this runbook for every OpenClaw release update. The goal is to catch regressions quickly, classify findings, and ship upstream issues/PRs when needed.

## Model

- `Lane A: prod-observe`
  - Safe checks only on live runtime.
  - No deliberate fault injection.
- `Lane B: staging-chaos`
  - Dedicated isolated port/home/config.
  - Uses `gateway.mode=local` for isolated start guard compatibility.
  - Fault injection and resilience checks.

Default cadence: run this gate for every release update.

Baseline reference used as first release-gate anchor:

- captured at: `2026-02-18T10:03:53Z`
- `slack_listeners_crash`: `98`
- `memory_module_not_available`: `72`
- `extraction_llm_unavailable`: `26`
- `config_invalid`: `0`

## Scripts

- `pnpm hunt:collect`
  - Collects deterministic runtime snapshot:
    - `openclaw --version`
    - `openclaw gateway status`
    - listener probe (`lsof`)
    - signature counts from `gateway.err.log` and `openclaw.log` in a lookback window.
- `pnpm hunt:staging-chaos`
  - Runs isolated chaos checks against staging lane:
    - port collision guard
    - already-running guard
    - `SIGUSR1` restart stability
    - missing binary/env behavior
    - transient network fault simulation
- `pnpm hunt:release-gate`
  - Full orchestration:
    - T0 preflight snapshot
    - T1 update/restart/verify (`openclaw update --no-restart`, LaunchAgent-safe restart, verify)
    - T2 critical unit/e2e bundles
    - T3 staging chaos
    - report build + classification

## Quick Start

Run a full gate (default behavior):

```bash
pnpm hunt:release-gate -- --release 2026.2.17
```

Safe dry-ish pass (no update, no tests, no chaos):

```bash
pnpm hunt:release-gate -- --release 2026.2.17 --skip-update --skip-tests --skip-chaos
```

Run chaos lane only:

```bash
pnpm hunt:staging-chaos -- --release 2026.2.17
```

Collect runtime only:

```bash
pnpm hunt:collect -- --label baseline --window-minutes 120 --output ./artifacts/hunt/baseline.json
```

## Nimbus-safe restart override

If your environment requires a custom restart path, override restart command:

```bash
pnpm hunt:release-gate -- \
  --release 2026.2.17 \
  --restart-command "~/clawd/scripts/gateway-restart.sh"
```

## Outputs

Every gate writes artifacts under `artifacts/hunt/release-gate-<timestamp>/`:

- `preflight-runtime.json`
- `post-runtime.json`
- `checks/*.json` + `checks/*.log`
- `known-issues/*.json`
- `staging-chaos/` (if enabled)
- `report-input.json`
- `hunt-report.json`
- `hunt-report.md`
- `gate-status.txt` (`pass`, `warn`, `fail`)

## Classification Rules

- `core`
  - reproducible OpenClaw bug without private modifications
  - open issue + PR with tests by default
- `plugin-private`
  - private plugin/system behavior (for example private Gigabrain repo)
  - keep private
- `ops`
  - runbook, deployment, restart sequencing, environment drift

## Gate Failure Rules

Gate returns `fail` when either is true:

- strict check failed (`status=fail`), or
- new/regressed `p0` classification found (for example non-allowlisted crash signature).

Gate can return `warn` for known issues and degradations that are triaged but not promoted as hard blockers.

## Notes

- Keep known-issue allowlist explicit and versioned in the hunt scripts.
- Update signature mappings when upstream issues/PRs merge.
- For high-frequency releases, run the gate quickly per release rather than batching across a week.
