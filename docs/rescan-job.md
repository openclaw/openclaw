# Daily Re-Scan Job

## Purpose

The re-scan job revisits active skills and refreshes trust signals for their existing package hashes.

## Intended Flow

1. iterate active skill versions
2. look up each package by SHA-256
3. if cached provider result exists, refresh from lookup
4. if lookup misses and bundle path exists, re-submit locally
5. store the new scan record
6. compare previous verdict vs new verdict
7. emit warnings on downgrade
8. append audit entries

## Output

The scaffold returns:

- processed count
- rescanned count
- warnings list

## Current Scaffold

Implementation lives in:

- `src/jobs/rescan-skills.ts`

This scaffold is intentionally local and safe. It does not schedule itself yet; it defines the job logic so a scheduler can be attached later.

## Future Wiring

Possible future schedulers:

- internal cron / heartbeat job
- gateway-managed scheduled task
- external worker calling a protected API

Whatever scheduler is chosen, it should remain:

- authenticated
- observable
- deterministic
- rate-limited
