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

## Notes

- This is intentionally scoped to a minimal phase-1 contribution.
- Follow-up work can relocate these scripts into final core paths once maintainers confirm preferred structure.
