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

The recent hardening PR improved this by:

- Replacing broad kill patterns with targeted PID cleanup via parsed `ps` output.
- Adding no output watchdog behavior.
- Distinguishing termination causes (`timeout`, `no-output-timeout`, `signal`, `exit`).
- Improving PTY lifecycle cleanup across exit paths.
- Adding backend reliability knobs for watchdog and stale resume cleanup.

This is a strong production hardening step. It is not the final architecture.

## What Is Good Now

- Better safety: we no longer blast kill by loose command patterns.
- Better diagnostics: termination reasons are explicit and logged.
- Better control: watchdog and stale cleanup are configurable per backend.
- Better PTY hygiene: listeners and PTY handles are cleaned up consistently.

## Current Caveats

The current design still depends on process table string matching:

- `ps` parsing is platform sensitive and can be brittle.
- Command line regex matching is still heuristic.
- Cleanup and policy logic live in the same module, which mixes concerns.
- Timeout and cancel flow still uses ad hoc timers, not one cancellation primitive.

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

- Keep current behavior.
- Introduce `RunRegistry` and register new runs in parallel.
- Emit lifecycle telemetry without changing kill semantics.

### Phase 2

- Route all new cancel and timeout paths through `TerminationController`.
- Start using targeted pid or process group kills for registered runs.
- Keep `ps` based cleanup as fallback only.

### Phase 3

- Enable orphan reconciliation from registry.
- Remove default `ps` regex cleanup path.
- Retain fallback behind emergency flag only.

### Phase 4

- Consolidate PTY and non PTY execution into shared supervisor entry points.
- Move reliability policy into config driven policy modules.

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

Short term hardening was correct and necessary.

Long term elegant implementation is a supervisor architecture with explicit ownership, one lifecycle model, one cancellation model, and deterministic cleanup. That is the path that removes process matching heuristics and makes PTY reliability truly production grade.
