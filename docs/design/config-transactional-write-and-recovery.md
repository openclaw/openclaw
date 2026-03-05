# Transactional Config Writes and Restart Recovery

## Context

OpenClaw allows config mutation through multiple surfaces:

- CLI commands (`openclaw config set`, model auth flows, hooks, plugins, etc.)
- Gateway RPC methods (`config.set`, `config.patch`, `config.apply`)
- Internal maintenance paths (`security fix`, `secrets apply`)

Historically, a bad config write could be followed by a restart attempt that made the gateway unavailable until manual repair.

This design introduces a closed-loop safety model:

1. Validate candidate config in isolation before touching production config.
2. Commit atomically.
3. Re-verify committed state.
4. Roll back automatically if post-commit verification fails.
5. Block restart on invalid config and attempt backup recovery first.

## Goals

- Prevent invalid config from being committed by default.
- Prevent restart from proceeding with known-invalid config.
- Recover automatically from valid backups when possible.
- Keep normal runtime performance unchanged (write path only).
- Keep behavior consistent across all config-write entry points.

## Non-goals

- Distributed transactions across remote nodes.
- Full multi-resource two-phase commit across every side file.
- Changing normal message handling/runtime hot paths.

## Design Overview

### 1. Transaction Engine

`runConfigWriteTransaction` implements:

- `prepare`: isolated write+validation into a staging config path.
- `commit`: write target config.
- `verify`: re-read committed snapshot and validate.
- `rollback`: restore pre-transaction raw snapshot atomically if verification fails.

If verification fails and rollback succeeds, the caller gets a structured error with:

- transaction id
- failed stage
- rollback status
- validation issues (if available)

### 2. Backup Recovery

`recoverConfigFromBackups` scans:

- `<config>.bak`
- `<config>.bak.1...N`

It picks the first valid backup snapshot and restores it atomically.

### 3. Default Write Path Safety

`config.writeConfigFile` now routes through `runConfigWriteTransaction` by default.  
This ensures most existing call sites get transactional safety without per-call refactoring.

### 4. Gateway RPC Safety

`config.set`, `config.patch`, and `config.apply` now:

- commit via transaction
- return transaction metadata on success
- return structured transaction failure details on error
- avoid scheduling restart for failed writes

### 5. Restart Preflight Safety

`openclaw gateway restart` preflight now:

- reads config snapshot
- if invalid, tries backup recovery first
- blocks restart if still invalid

### 6. Config Guard Safety

CLI preaction config guard now:

- attempts backup recovery when config is invalid
- proceeds if recovery succeeds
- otherwise reports recovery failure details and exits for non-allowlisted commands

## Coverage Matrix

The following write paths are covered by transactional writes:

- Generic config writes via `config.writeConfigFile`
- Model auth/profile updates (through shared model config updater)
- Hooks CLI writes
- Telegram config writeback paths
- Gateway RPC config mutation methods
- Secrets apply config write phase
- Security fix config write phase

Remaining direct low-level writes in `config/io.ts` are intentional internals used by the transaction engine itself.

## Failure Semantics

### Commit failure

- No post-commit verification attempt.
- Caller receives stage=`commit`.

### Verify failure

- Rollback attempted automatically.
- Caller receives stage=`verify` + rollback status.

### Rollback failure

- Caller receives stage=`rollback`.
- Error includes rollback failure detail.

### Restart preflight failure

- Restart is blocked with actionable hints (`config validate`, `doctor`).

## Performance Notes

- Additional work happens only on config write paths.
- Runtime read and message-processing paths are unchanged.
- Local micro-benchmark on small configs shows transactional writes are slower than direct writes (expected due to extra isolation+verification), but this does not affect steady-state gateway operation.

## Verification Strategy

Added tests cover:

- transaction commit/verify/rollback behavior
- isolated prepare-stage rejection for invalid config
- backup recovery selection behavior
- gateway restart preflight recovery and block behavior
- config-guard auto-recovery behavior
- model shared update path preserving file on invalid mutation
- existing CLI/gateway/telegram/secrets/security regression suites

## Risks and Mitigations

- Risk: write path latency increase.
  - Mitigation: limited to config mutation workflows, not hot runtime paths.
- Risk: missed legacy write path bypassing transaction wrapper.
  - Mitigation: direct import/path audit and conversion to transactional entry points.
- Risk: rollback mismatch edge cases.
  - Mitigation: hash comparison against pre-transaction snapshot and explicit rollback stage reporting.

## Future Hardening

- Add file lock / CAS generation checks to improve concurrent write semantics.
- Add WAL/journal for multi-resource recovery orchestration.
- Add optional restart-time health-verified automatic rollback to last-known-good config.
