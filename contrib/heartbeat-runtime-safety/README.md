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
```
