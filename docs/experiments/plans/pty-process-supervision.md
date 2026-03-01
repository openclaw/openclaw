---
summary: "Production plan for reliable interactive process supervision (PTY + non-PTY) with explicit ownership, unified lifecycle, and deterministic cleanup"
read_when:
  - Working on exec/process lifecycle ownership and cleanup
  - Debugging PTY and non-PTY supervision behavior
owner: "openclaw"
status: "in-progress"
last_updated: "2026-02-15"
title: "PTY and Process Supervision Plan"
---

# PTY and Process Supervision Plan

## 1. Problem and goal

We need one reliable lifecycle for long-running command execution across:

- `exec` foreground runs
- `exec` background runs
- `process` follow up actions (`poll`, `log`, `send-keys`, `paste`, `submit`, `kill`, `remove`)
- CLI agent runner subprocesses

The goal is not just to support PTY. The goal is predictable ownership, cancellation, timeout, and cleanup with no unsafe process matching heuristics.

## 2. Scope and boundaries

- Keep implementation internal in `src/process/supervisor`.
- Do not create a new package for this.
- Keep current behavior compatibility where practical.
- Do not broaden scope to terminal replay or tmux style session persistence.

## 3. Implemented in this branch

### Supervisor baseline already present

- Supervisor module is in place under `src/process/supervisor/*`.
- Exec runtime and CLI runner are already routed through supervisor spawn and wait.
- Registry finalization is idempotent.

### This pass completed

1. Explicit PTY command contract

- `SpawnInput` is now a discriminated union in `src/process/supervisor/types.ts`.
- PTY runs require `ptyCommand` instead of reusing generic `argv`.
- Supervisor no longer rebuilds PTY command strings from argv joins in `src/process/supervisor/supervisor.ts`.
- Exec runtime now passes `ptyCommand` directly in `src/agents/bash-tools.exec-runtime.ts`.

2. Process layer type decoupling

- Supervisor types no longer import `SessionStdin` from agents.
- Process local stdin contract lives in `src/process/supervisor/types.ts` (`ManagedRunStdin`).
- Adapters now depend only on process level types:
  - `src/process/supervisor/adapters/child.ts`
  - `src/process/supervisor/adapters/pty.ts`

3. Process tool lifecycle ownership improvement

- `src/agents/bash-tools.process.ts` now requests cancellation through supervisor first.
- `process kill/remove` now use process-tree fallback termination when supervisor lookup misses.
- `remove` keeps deterministic remove behavior by dropping running session entries immediately after termination is requested.

4. Single source watchdog defaults

- Added shared defaults in `src/agents/cli-watchdog-defaults.ts`.
- `src/agents/cli-backends.ts` consumes the shared defaults.
- `src/agents/cli-runner/reliability.ts` consumes the same shared defaults.

5. Dead helper cleanup

- Removed unused `killSession` helper path from `src/agents/bash-tools.shared.ts`.

6. Direct supervisor path tests added

- Added `src/agents/bash-tools.process.supervisor.test.ts` to cover kill and remove routing through supervisor cancellation.

7. Reliability gap fixes completed

- `src/agents/bash-tools.process.ts` now falls back to real OS-level process termination when supervisor lookup misses.
- `src/process/supervisor/adapters/child.ts` now uses process-tree termination semantics for default cancel/timeout kill paths.
- Added shared process-tree utility in `src/process/kill-tree.ts`.

8. PTY contract edge-case coverage added

- Added `src/process/supervisor/supervisor.pty-command.test.ts` for verbatim PTY command forwarding and empty-command rejection.
- Added `src/process/supervisor/adapters/child.test.ts` for process-tree kill behavior in child adapter cancellation.

## 4. Remaining gaps and decisions

### Reliability status

The two required reliability gaps for this pass are now closed:

- `process kill/remove` now has a real OS termination fallback when supervisor lookup misses.
- child cancel/timeout now uses process-tree kill semantics for default kill path.
- Regression tests were added for both behaviors.

### Durability and startup reconciliation

Restart behavior is now explicitly defined as in-memory lifecycle only.

- `reconcileOrphans()` remains a no-op in `src/process/supervisor/supervisor.ts` by design.
- Active runs are not recovered after process restart.
- This boundary is intentional for this implementation pass to avoid partial persistence risks.

### Maintainability follow-ups

1. `runExecProcess` in `src/agents/bash-tools.exec-runtime.ts` still handles multiple responsibilities and can be split into focused helpers in a follow-up.

## 5. Implementation plan

The implementation pass for required reliability and contract items is complete.

Completed:

- `process kill/remove` fallback real termination
- process-tree cancellation for child adapter default kill path
- regression tests for fallback kill and child adapter kill path
- PTY command edge-case tests under explicit `ptyCommand`
- explicit in-memory restart boundary with `reconcileOrphans()` no-op by design

Optional follow-up:

- split `runExecProcess` into focused helpers with no behavior drift

## 6. File map

### Process supervisor

- `src/process/supervisor/types.ts` updated with discriminated spawn input and process local stdin contract.
- `src/process/supervisor/supervisor.ts` updated to use explicit `ptyCommand`.
- `src/process/supervisor/adapters/child.ts` and `src/process/supervisor/adapters/pty.ts` decoupled from agent types.
- `src/process/supervisor/registry.ts` idempotent finalize unchanged and retained.

### Exec and process integration

- `src/agents/bash-tools.exec-runtime.ts` updated to pass PTY command explicitly and keep fallback path.
- `src/agents/bash-tools.process.ts` updated to cancel via supervisor with real process-tree fallback termination.
- `src/agents/bash-tools.shared.ts` removed direct kill helper path.

### CLI reliability

- `src/agents/cli-watchdog-defaults.ts` added as shared baseline.
- `src/agents/cli-backends.ts` and `src/agents/cli-runner/reliability.ts` now consume same defaults.

## 7. Validation run in this pass

Unit tests:

- `pnpm vitest src/process/supervisor/registry.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.pty-command.test.ts`
- `pnpm vitest src/process/supervisor/adapters/child.test.ts`
- `pnpm vitest src/agents/cli-backends.test.ts`
- `pnpm vitest src/agents/bash-tools.exec.pty-cleanup.test.ts`
- `pnpm vitest src/agents/bash-tools.process.poll-timeout.test.ts`
- `pnpm vitest src/agents/bash-tools.process.supervisor.test.ts`
- `pnpm vitest src/process/exec.test.ts`

E2E targets:

- `pnpm vitest src/agents/cli-runner.test.ts`
- `pnpm vitest run src/agents/bash-tools.exec.pty-fallback.test.ts src/agents/bash-tools.exec.background-abort.test.ts src/agents/bash-tools.process.send-keys.test.ts`

Typecheck note:

- Use `pnpm build` (and `pnpm check` for full lint/docs gate) in this repo. Older notes that mention `pnpm tsgo` are obsolete.

## 8. Operational guarantees preserved

- Exec env hardening behavior is unchanged.
- Approval and allowlist flow is unchanged.
- Output sanitization and output caps are unchanged.
- PTY adapter still guarantees wait settlement on forced kill and listener disposal.

## 9. Definition of done

1. Supervisor is lifecycle owner for managed runs.
2. PTY spawn uses explicit command contract with no argv reconstruction.
3. Process layer has no type dependency on agent layer for supervisor stdin contracts.
4. Watchdog defaults are single source.
5. Targeted unit and e2e tests remain green.
6. Restart durability boundary is explicitly documented or fully implemented.

## 10. Summary

The branch now has a coherent and safer supervision shape:

- explicit PTY contract
- cleaner process layering
- supervisor driven cancellation path for process operations
- real fallback termination when supervisor lookup misses
- process-tree cancellation for child-run default kill paths
- unified watchdog defaults
- explicit in-memory restart boundary (no orphan reconciliation across restart in this pass)
