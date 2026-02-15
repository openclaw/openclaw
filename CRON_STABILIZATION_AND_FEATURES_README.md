# OpenClaw Cron: Stability + Feature Update Notes

This document summarizes the implemented work for roadmap priorities:

- `1` Cron stability fixes
- `2` Cron enhancements (multi-schedule, per-job timeout hardening, isolated announce reliability)
- `3` Security, orchestration, and memory-quality guardrails

## Priority 1: Stability Fixes

### 1) Windows cron store write resilience (`EBUSY`/`EPERM`/`ENOTEMPTY`)

- Added atomic rename retry with backoff for cron store writes.
- Added temp-file cleanup in `finally` to avoid leftover `.tmp` files on failures.

Files:

- `openclaw/src/cron/store.ts`
- `openclaw/src/cron/store.test.ts`

### 2) Timer re-arm and spin-loop prevention improvements

- `nextWakeAtMs` now ignores jobs currently marked `runningAtMs`.
- When all enabled jobs are blocked by `runningAtMs`, scheduler now arms a maintenance tick (60s) instead of skipping/spinning.

Files:

- `openclaw/src/cron/service/jobs.ts`
- `openclaw/src/cron/service/timer.ts`
- `openclaw/src/cron/service.rearm-timer-when-running.test.ts`

## Priority 2: Enhancements

### 1) Multi-schedule support per job (`schedules[]`)

- Added support for multiple schedules on a single job while preserving backward compatibility with `schedule`.
- `nextRunAtMs` now resolves to the earliest next run across all configured schedules.
- Update path supports patching `schedules[]`.
- Store migration/normalization keeps `schedule` and `schedules[0]` in sync for compatibility.
- Protocol schema now accepts `schedules[]` in add/update payloads.

Files:

- `openclaw/src/cron/types.ts`
- `openclaw/src/cron/service/jobs.ts`
- `openclaw/src/cron/service/ops.ts`
- `openclaw/src/cron/service/store.ts`
- `openclaw/src/cron/normalize.ts`
- `openclaw/src/gateway/protocol/schema/cron.ts`
- `openclaw/src/cron/service.issue-regressions.test.ts`
- `openclaw/src/cron/normalize.test.ts`

### 2) Per-job timeout hardening

- Added timeout normalization/clamping in timer execution path:
  - minimum: 1 second
  - maximum cap: 24 hours
  - default fallback remains 10 minutes when unset/invalid

Files:

- `openclaw/src/cron/service/timer.ts`

### 3) Isolated announce reliability fallback

- When subagent announce flow fails, isolated cron now attempts one direct outbound fallback delivery before failing.
- This improves reliability for cases where announce orchestration fails but direct delivery can still succeed.

Files:

- `openclaw/src/cron/isolated-agent/run.ts`

## Priority 3: Security + Intelligence Guardrails

### 1) Secrets manager integration (`op://` and `vault://`)

- Added config-time secret URI resolution support:
  - `op://...` via `op read <ref>`
  - `vault://path#field` via `vault kv get -field=<field> <path>`
- Resolution runs during config load, after `${ENV}` substitution.

Files:

- `openclaw/src/config/secret-resolver.ts`
- `openclaw/src/config/io.ts`
- `openclaw/src/config/secret-resolver.test.ts`

### 2) Membrane-style tool boundary enforcement

- Added optional pre-tool-call membrane checks:
  - hard deny specific tools
  - deny exec calls containing blocked command substrings
- Denials include explicit membrane tags in block reasons.

Files:

- `openclaw/src/agents/pi-tools.before-tool-call.ts`
- `openclaw/src/agents/pi-tools.ts`
- `openclaw/src/config/types.tools.ts`
- `openclaw/src/config/zod-schema.agent-runtime.ts`
- `openclaw/src/agents/pi-tools.before-tool-call.e2e.test.ts`

### 3) Smart model routing (simple vs complex messages)

- Added optional per-agent routing config to select cheaper model for simple tasks and stronger model for complex tasks.
- Integrated into isolated cron agent-turn model selection path.

Files:

- `openclaw/src/agents/model-routing.ts`
- `openclaw/src/agents/model-routing.test.ts`
- `openclaw/src/config/types.agent-defaults.ts`
- `openclaw/src/config/zod-schema.agent-defaults.ts`
- `openclaw/src/cron/isolated-agent/run.ts`

### 4) Fact-check gate for session-memory hook writes

- Added optional hook-level fact-check thresholds before writing session memory snapshots.
- Can require minimum user/assistant evidence before persisting.

Files:

- `openclaw/src/hooks/bundled/session-memory/handler.ts`
- `openclaw/src/hooks/bundled/session-memory/handler.test.ts`

## Validation

Executed targeted tests:

```powershell
pnpm -C openclaw test:fast -- `
  src/cron/store.test.ts `
  src/cron/service.rearm-timer-when-running.test.ts `
  src/cron/service.issue-13992-regression.test.ts `
  src/cron/service.issue-16156-list-skips-cron.test.ts `
  src/cron/service.issue-regressions.test.ts
```

```powershell
pnpm -C openclaw test:fast -- `
  src/cron/service.issue-regressions.test.ts `
  src/cron/normalize.test.ts `
  src/cron/store.test.ts `
  src/cron/service.store-migration.test.ts `
  src/cron/service.store.migration.test.ts `
  src/cron/service.delivery-plan.test.ts
```

All passed in the latest run.

Additional priority-3 verification:

```powershell
pnpm -C openclaw test:fast -- `
  src/config/secret-resolver.test.ts `
  src/hooks/bundled/session-memory/handler.test.ts `
  src/agents/model-routing.test.ts
```

```powershell
pnpm -C openclaw exec vitest run --config vitest.e2e.config.ts `
  src/agents/pi-tools.before-tool-call.e2e.test.ts
```
