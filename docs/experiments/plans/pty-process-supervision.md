---
summary: "Design the long term process supervision model for PTY and CLI runs with explicit ownership, unified cancellation, and deterministic cleanup"
owner: "openclaw"
status: "proposed"
last_updated: "2026-02-11"
title: "PTY Process Supervision Architecture"
---

# PTY Process Supervision Architecture

## Context

We hit repeated resume failures where long running CLI sessions stalled and cleanup behavior was unsafe or too broad.

Observed symptoms:

- Resume attempts appeared stuck with no writes for minutes.
- PTY backed runs were at risk during long silent periods.
- Broad cleanup patterns (`pkill -f`) could kill unrelated processes.
- Timeout handling mixed multiple failure modes into one bucket.

This proposal is written for the pre-rewrite baseline.

Current baseline problems:

- Cleanup relies on process table and command text matching, which is heuristic.
- PTY and non PTY lifecycle handling is split, increasing drift and leaks.
- Timeout and cancel paths are not unified under a single cancellation primitive.
- Failure reasons are not normalized enough for reliable ops and incident triage.
- There is no durable ownership model for spawned runs.

## Why A Full Rewrite

Incremental fixes can reduce immediate incidents, but they do not remove the root issue:
we do not have deterministic ownership and supervision for processes.

Without ownership, cleanup becomes guesswork.
Without one lifecycle, edge cases multiply.
Without one cancellation model, timeout races remain.

## North Star

The target is simple:

`Only kill processes that OpenClaw owns. Never guess from process table strings.`

That requires one supervisor model for PTY and non PTY execution.

## Design Principles

1. Ownership first: every spawned run is registered with durable identity.
2. One lifecycle model: PTY and non PTY share the same state machine.
3. One cancel model: manual cancel, no output timeout, and overall timeout all converge.
4. Deterministic cleanup: kill by tracked pid or process group, never by text matching.
5. Observable by default: structured events for spawn, output heartbeats, cancel, exit, cleanup.
6. Portable behavior: OS specific mechanics hidden behind a narrow interface.

## Target Architecture

### Core Components

1. `ProcessSupervisor`
   - Public API for spawn, cancel, heartbeat updates, and reconciliation.
2. `RunRegistry`
   - Durable run ownership records keyed by `runId` (and session metadata).
3. `ExecutionAdapter`
   - Transport specific I/O adapters (PTY and non PTY) with the same control contract.
4. `TerminationController`
   - Unified cancellation logic using `AbortController` and reasoned deadlines.
5. `ProcessReaper`
   - OS aware targeted termination for owned process trees.

### Proposed Interfaces

```ts
type RunState = "starting" | "running" | "exiting" | "exited";

type TerminationReason =
  | "manual-cancel"
  | "overall-timeout"
  | "no-output-timeout"
  | "spawn-error"
  | "signal"
  | "exit";

type RunRecord = {
  runId: string;
  sessionId: string;
  backendId: string;
  pid: number;
  processGroupId?: number; // POSIX
  jobId?: string; // Windows abstraction
  startedAtMs: number;
  lastOutputAtMs: number;
  state: RunState;
};

interface ProcessSupervisor {
  spawn(input: SpawnInput): Promise<ManagedRun>;
  cancel(runId: string, reason: TerminationReason): Promise<void>;
  reconcileOrphans(): Promise<void>;
}

interface ManagedRun {
  runId: string;
  pid: number;
  wait(): Promise<RunExit>;
  writeStdin?(chunk: string): void;
}
```

### State Machine

`starting -> running -> exiting -> exited`

Rules:

- `starting` becomes `running` only after successful spawn and registry commit.
- Any timeout or manual cancel transitions to `exiting` with explicit reason.
- `exited` is terminal and removes active leases.
- Duplicate cancel requests are idempotent.

## Timeout and Watchdog Model

Use one `AbortController` tree per run:

- Root signal: manual cancel.
- Child deadline: overall timeout.
- Child deadline: no output timeout (re armed on output heartbeat).

All timeout paths produce structured `TerminationReason` and flow through the same exit finalizer.

## Cleanup Model

### Spawn Time

- Register run ownership immediately after spawn.
- On POSIX, prefer dedicated process group ownership.
- On Windows, place process in a managed job boundary abstraction.

### Exit Time

- Mark run exiting.
- Dispose transport listeners once.
- Send targeted termination to owned pid or process group only when needed.
- Finalize registry state and emit exit event once.

### Recovery Path

On startup or supervisor crash recovery:

- Read active `RunRecord`s.
- Verify liveness by exact pid lookup.
- Reconcile stale records and terminate owned orphans deterministically.

## Why This Is Better Than `ps` Regex Cleanup

- No false positives from command line similarities.
- No accidental kill of unrelated operator processes.
- Deterministic behavior across backends and sessions.
- Easier reasoning in incidents because ownership is explicit.
- Better portability because platform details are isolated.

## Migration Plan

### Phase 1

- Introduce explicit run ownership (`RunRegistry`) and lifecycle telemetry.
- Add normalized termination reasons for all exits.
- Keep existing behavior operational while recording enough data to validate migration.

### Phase 2

- Route all new cancel and timeout paths through `TerminationController` (`AbortController`).
- Move PTY and non PTY execution behind one supervisor contract.
- Use targeted pid or process group termination for owned runs.

### Phase 3

- Enable orphan reconciliation from the registry at startup.
- Remove default heuristic process matching cleanup.
- Retain heuristic fallback only behind an emergency feature flag.

### Phase 4

- Harden cross platform adapters (POSIX process groups, Windows job boundary abstraction).
- Finalize policy modules and remove legacy lifecycle paths.

## Testing Strategy

Focus on non performative tests that validate behavior contracts:

1. Unit tests
   - Termination reason mapping.
   - Watchdog deadline computation.
   - Registry state transitions and idempotency.
2. Integration tests
   - Real child process with no output timeout.
   - Real child process with overall timeout.
   - PTY and non PTY parity for cancel and exit paths.
3. Failure tests
   - Supervisor restart with stale `RunRecord`.
   - Race between exit and timeout.
   - Duplicate cancel and duplicate finalize calls.

## Operational Metrics

Add counters and structured events:

- `run_spawn_total`
- `run_exit_total{reason=...}`
- `run_timeout_total{type=no_output|overall}`
- `run_cleanup_kill_total{mode=pid|pgid|fallback}`
- `run_reconcile_orphans_total`

These make regression detection and incident triage straightforward.

## Decision Summary

Long term elegant implementation is a supervisor architecture with explicit ownership, one lifecycle model, one cancellation model, and deterministic cleanup. That is the path that removes process matching heuristics and makes PTY reliability truly production grade.
