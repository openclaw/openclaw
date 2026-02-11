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

Root cause in one sentence: We had no reliable process ownership model, so resume runs could be killed by heuristic cleanup or timeout/PTY races instead of deterministic lifecycle control.

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

## Platform Execution Contract

These rules are mandatory for the one go rewrite. If any rule is not met on a platform, the merge is blocked.

### POSIX Contract (Linux and macOS)

- Every run must own a dedicated process group.
- Spawn must ensure a stable group leader (`pid == pgid`) for the run root process.
- Termination must target the run process group, not only the direct child.
- Graceful termination sequence:
  - send `SIGTERM` to process group,
  - wait `graceMs`,
  - send `SIGKILL` to remaining members.
- Liveness checks must use pid plus start time fingerprint to avoid pid reuse bugs.
- Reconciliation must not rely on command text matching.

### Linux Specific Contract

- Process tree resolution should use `/proc` metadata where available.
- Reconciliation must verify pid start time from `/proc/<pid>/stat` (or equivalent robust source).
- Child and grandchild cleanup must work for `bash -lc`, `npm`, and direct exec runs.

### macOS Specific Contract

- Process tree resolution should use system process APIs (`libproc` or equivalent) and not assume `/proc`.
- Reconciliation must verify pid start time via OS level process metadata.
- Child and grandchild cleanup must work for PTY and non PTY runs, including shell wrapped commands.

### Windows Contract

- Every run must be attached to a dedicated Job Object (or equivalent abstraction with same guarantees).
- Job must be configured to terminate the full job tree when cancelled.
- Termination sequence:
  - request graceful stop when possible (`CTRL_BREAK` style path for console processes),
  - force terminate via job termination after `graceMs`.
- Reconciliation after supervisor restart must terminate the exact recorded root tree using pid plus start time validation.
- No reliance on command line text parsing for ownership or kill decisions.

## Process Tree Ownership Contract

### Shell Wrapper Rules

- Shell wrappers are allowed only if ownership is preserved.
- Wrapper must `exec` target command where possible so wrapper does not become a stale middle process.
- If wrapper cannot `exec`, supervisor must still track and terminate the full process group or job tree.
- Wrapper generated grandchildren are considered part of the run and must be terminated on cancel.

### Child and Grandchild Rules

- Direct child, grandchildren, and deeper descendants must remain within the run ownership boundary.
- If a subprocess intentionally detaches and escapes ownership boundary, run is marked failed with explicit reason (`ownership-escape`).
- Background daemons spawned by a run are forbidden unless explicitly declared and adopted by a different owner workflow.

## Run Registry and Reconciliation Contract

### Run Record Requirements

`RunRecord` must include enough data to safely reconcile across restarts:

- `runId`, `sessionId`, `backendId`
- `pid`
- process root fingerprint (`startTime` or equivalent)
- ownership scope (`processGroupId` on POSIX, `jobId` abstraction on Windows)
- state (`starting|running|exiting|exited`)
- `createdAtMs`, `updatedAtMs`, `lastOutputAtMs`
- `ownerInstanceId`
- `leaseExpiresAtMs`

### Lease and Ownership Rules

- Only one supervisor instance may own an active run lease at a time.
- Lease heartbeat updates must happen on a fixed interval.
- A stale lease may be stolen only after `leaseExpiresAtMs`.
- Lease steal must be atomic and recorded before termination attempts begin.

### Reconciliation Rules

On startup:

1. Load non exited records.
2. Validate pid plus fingerprint:
   - if missing or mismatched, mark exited as reconciled stale record.
3. For live matching records:
   - if lease owned by this instance, continue supervision.
   - if lease expired, atomically steal lease and terminate or adopt based on policy.
   - if lease healthy and owned by another instance, do not touch.
4. Emit structured reconciliation events for every decision.

## Why This Is Better Than `ps` Regex Cleanup

- No false positives from command line similarities.
- No accidental kill of unrelated operator processes.
- Deterministic behavior across backends and sessions.
- Easier reasoning in incidents because ownership is explicit.
- Better portability because platform details are isolated.

## One Go Implementation Plan

Ship the rewrite as one cohesive change set behind a short lived feature flag, then flip it as default in the same PR once tests pass.

1. Lock contracts first:
   - finalize platform execution contract, process ownership contract, and reconciliation contract in this document.
   - add explicit constants for `graceMs`, lease timings, and timeout defaults.
2. Build the full supervisor path:
   - `ProcessSupervisor`, `RunRegistry`, `ExecutionAdapter`, `TerminationController`, `ProcessReaper`.
   - PTY and non PTY run paths both use this shared contract.
3. Implement ownership based termination only:
   - kill by tracked pid or process group or job boundary.
   - no command line text matching in the new path.
4. Implement recovery and orphan reconciliation:
   - on startup, reconcile every active `RunRecord`.
   - clean stale owned runs deterministically.
5. Replace old execution wiring completely:
   - route all spawn, timeout, no output watchdog, manual cancel, and exit finalization through supervisor.
   - remove legacy cleanup paths from runtime flow.
6. Add full regression coverage before cutover:
   - unit, integration, and failure tests listed below must pass.
7. Cutover in one go:
   - enable supervisor path by default.
   - delete dead code and old fallback interfaces in same change set.

Acceptance criteria for merge:

- No runtime dependency on heuristic `ps` command matching.
- PTY and non PTY share one lifecycle implementation.
- Timeout reasons are normalized and observable.
- Startup reconciliation is deterministic.
- Platform contracts above are implemented and verified on Linux, macOS, and Windows.
- All targeted tests pass on supported OS environments.

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
   - Shell wrapped run (`bash -lc`/`sh -lc`/`pwsh -Command`) kills full tree.
   - Direct child plus grandchild tree cleanup works identically across PTY and non PTY.
   - PID reuse guard (`pid` changed but id reused) does not kill unrelated process.
3. Failure tests
   - Supervisor restart with stale `RunRecord`.
   - Race between exit and timeout.
   - Duplicate cancel and duplicate finalize calls.
   - Lease steal race between two supervisor instances.
   - Ownership escape attempt marks run failed.

## OS Matrix Test Plan

Run this matrix in CI (or gated pre merge runners) for Linux, macOS, and Windows:

1. `direct-exit`
   - simple command exits normally.
   - assert `termination=exit`, registry finalized.
2. `manual-cancel`
   - long running command canceled by API.
   - assert tree termination and deterministic exit reason.
3. `overall-timeout`
   - command exceeds timeout.
   - assert reason mapping and cleanup.
4. `no-output-timeout`
   - silent command with watchdog.
   - assert reason mapping and cleanup.
5. `pty-interactive`
   - PTY command emits intermittent output.
   - assert watchdog rearm and no false timeout.
6. `shell-wrapper-tree`
   - wrapper spawns child plus grandchild.
   - assert no descendant remains after cancel.
7. `restart-reconcile`
   - crash supervisor mid run, restart, reconcile.
   - assert stale records resolved and owned processes handled deterministically.
8. `lease-contention`
   - two supervisors compete for same run.
   - assert single owner and no double kill.

## Operational Metrics

Add counters and structured events:

- `run_spawn_total`
- `run_exit_total{reason=...}`
- `run_timeout_total{type=no_output|overall}`
- `run_cleanup_kill_total{mode=pid|pgid|job}`
- `run_reconcile_orphans_total`
- `run_lease_steal_total`
- `run_ownership_escape_total`

These make regression detection and incident triage straightforward.

## Decision Summary

Long term elegant implementation is a supervisor architecture with explicit ownership, one lifecycle model, one cancellation model, and deterministic cleanup. That is the path that removes process matching heuristics and makes PTY reliability truly production grade.
