# Heartbeat Runtime Safety (Phase-1 Extraction Draft)

This folder stages a minimal upstream-ready extraction of three components:

1. `preflight.sh`
2. `guard.sh`
3. `freshness.sh`

## Design Goals
- No workspace-specific absolute paths
- Configurable thresholds via env vars/flags
- Deterministic markdown report outputs

## Usage (draft)
```bash
./preflight.sh
./guard.sh
MAX_AGE_MIN=15 ./freshness.sh
./test.sh
```

## Phase-1 Validation
- Run `./test.sh` to verify the phase-1 scripts execute in sequence.
- Confirm reports are deterministic and free of machine-specific absolute paths.
- Confirm freshness checks can be tuned with `MAX_AGE_MIN`.

## Proposed Promotion Gate (to core)
- Maintainer-approved destination path and naming.
- Smoke-test wiring in CI.
- No behavior regressions in existing heartbeat cycles.
