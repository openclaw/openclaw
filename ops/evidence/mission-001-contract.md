# Mission 001 Contract — Gate Receipt Auto-Archival (v1)

## Goal

Each successful GO/NO-GO run MUST produce an auditable receipt in `ops/ledger/` (repo-tracked), without leaking secrets.

## Receipt artifacts (per run)

1. `ops/ledger/gate_<UTC_TS>_<run_id>.md` (human-readable summary)
2. `ops/ledger/gate_<UTC_TS>_<run_id>_health.json` (raw health payloads)
3. `ops/ledger/gate_<UTC_TS>_<run_id>_alpha.json` (raw alpha payloads)
4. Optional: `ops/ledger/gate_<UTC_TS>_<run_id>_files.txt` (list of /tmp receipts captured)

## Naming rules

- `<UTC_TS>` format: `YYYYMMDD_HHMMSSZ`
- `<run_id>` must match the printed run_id from `strike_echo` and `alpha_smoke`
- Never overwrite: if a filename exists, create a new one (append `_n2`, `_n3`, etc.)

## Mandatory fields (in the .md summary)

- UTC timestamp
- git branch + HEAD SHA
- gate result: PASS/FAIL
- strike_echo run_id + PASS line excerpt + PIN_OK
- alpha_smoke run_id + PASS line excerpt
- paths to any /tmp receipts captured

## Safety / Stop conditions

- If any token/secret appears in outputs/logs => FAIL and do NOT archive (write `ops/evidence/mission-001-stop.md` and halt).
- If archival fails for any reason => overall gate must FAIL (no silent success).
