# Heartbeat Runtime Safety (Phase 1 Draft)

This draft introduces a minimal runtime safety layer for autonomous heartbeat cycles:

- preflight checks
- failure guard checks
- artifact freshness checks

## Current Draft Location

Prototype scripts currently live under:

- `contrib/heartbeat-runtime-safety/preflight.sh`
- `contrib/heartbeat-runtime-safety/guard.sh`
- `contrib/heartbeat-runtime-safety/freshness.sh`
- `contrib/heartbeat-runtime-safety/test.sh`

## Why This Exists

Long-running autonomous loops benefit from explicit runtime validation and drift/failure visibility before normal task execution.

## Draft Usage

```bash
./contrib/heartbeat-runtime-safety/preflight.sh
./contrib/heartbeat-runtime-safety/guard.sh
MAX_AGE_MIN=15 ./contrib/heartbeat-runtime-safety/freshness.sh
./contrib/heartbeat-runtime-safety/test.sh
```

## Acceptance Criteria (Phase 1)

A phase-1 extraction is considered successful when:

1. Scripts execute without workspace-specific path assumptions.
2. `preflight.sh`, `guard.sh`, and `freshness.sh` emit deterministic markdown artifacts.
3. Freshness threshold is configurable via `MAX_AGE_MIN`.
4. `test.sh` validates basic invocation flow for all phase-1 scripts.

## Integration Plan (Contrib → Core)

1. Maintainers confirm final target paths and naming conventions.
2. Port scripts from `contrib/heartbeat-runtime-safety/` into approved core automation paths.
3. Wire into existing heartbeat cadence entry points.
4. Add CI checks for runtime-safety script smoke tests.
5. Remove contrib staging copy once core integration is complete.

## Reviewer Validation Notes

Quick smoke test:

```bash
./contrib/heartbeat-runtime-safety/preflight.sh
./contrib/heartbeat-runtime-safety/guard.sh
MAX_AGE_MIN=15 ./contrib/heartbeat-runtime-safety/freshness.sh
./contrib/heartbeat-runtime-safety/test.sh
```

Expected result:
- clean exit status in healthy environments,
- deterministic markdown output for downstream report indexing,
- clear failure signals when prerequisites are missing or artifacts are stale.

## Notes

- This is intentionally scoped to a minimal phase-1 contribution.
- Follow-up work relocates these scripts into final core paths after maintainer approval.
