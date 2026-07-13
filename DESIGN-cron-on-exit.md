# feat(cron): `on-exit` schedule — fire a job when a watched command/process exits

## Problem

Event-driven wakes that start a fresh agent turn already work (the `wake`/`system event` RPC). But an agent cannot reliably arm "wake me when this command/process exits" itself: CLI backends run each turn as a supervisor-spawned **detached process group** that is `signalProcessTree(SIGTERM→SIGKILL)`'d at turn end (`src/process/supervisor/adapters/child.ts`, intentional, #71662). Any process the agent backgrounds via `exec` is in that tree and dies with the turn. The only escape (`setsid` + raw `node dist/entry.js system event …`) is hand-rolled, fragile, and observed to take down the host. Applies to **all** spawn-and-kill CLI backends (claude-cli verified), not the TLS proxy.

## Design

A new cron **schedule kind** `on-exit`, executed by a **gateway-supervisor-owned watcher** — independent of #83738 (rides the existing main-session cron run pipeline, not the manual wake path).

- `CronSchedule` gains `{ kind: "on-exit"; command: string; cwd?: string }` (PID-watch variant deferred).
- `computeNextRunAtMs()` returns `undefined` for `on-exit` → the time-based timer never fires it.
- `createCronExitWatchers()` (extracted into `src/gateway/cron-exit-watchers.ts`, wired from `buildGatewayCronService` via `reconcileExitWatchers()` / `stopExitWatchers()`) owns the watcher lifecycle, backed by `getProcessSupervisor()`. It exposes `reconcile(jobs) / cancel(jobId) / cancelAll() / activeJobIds()`.
  - On reconcile, each enabled `on-exit` job reserves a watcher slot synchronously (with an `armToken`), then spawns the command via `supervisor.spawn({ mode:"child", scopeKey:"cron-exit:<jobId>", replaceExistingScope:true, argv:[shell.command, ...shell.argsFor(command)], cwd?, captureOutput:true })`. The shell is platform-aware via `resolveExitWatchShell()`: `cmd.exe /d /s /c` on Windows, `bash -lc` on POSIX.
  - The watcher lives under the **gateway** supervisor tree, so per-turn CLI teardown never touches it. An async spawn/wait that loses ownership (job cancelled or re-armed for a changed command/cwd) is a no-op via the `armToken`/slot-identity check.
  - `await run.wait()` → on exit, the one-shot completion is **persisted (the job disabled in the store) BEFORE the job fires**, fail-closed: if the store write or `run.wait()` rejects, the job does NOT fire — so a gateway restart cannot re-arm and double-fire the same exit. Only then does it fire via the existing cron run pipeline; the woken turn sees the exit code + last output lines.
  - Job `remove`/`disable`, or a changed command/cwd → `reconcile()` cancels or re-arms the watcher (`cancel(jobId)`; `cancelAll()` on shutdown).
- Delivery to the originating conversation is the **existing** `executeMainSessionCronJob` path (`resolveMainSessionCronDeliveryContext`) — already correct on main; no dependency on #83738.

## Reuse / no new delivery code

Everything after "process exited" is the current cron run→system-event→delivery pipeline. The only new surface: the schedule kind, its validation, the watcher lifecycle, and the tool/schema plumbing to create such a job.

## Out of scope

- PID-watch (`{ kind:"on-exit"; pid }`) — follow-up.
- Re-arm/repeat on each exit — v1 is one-shot (job disables after firing, like a one-shot `at`).
- This PR **stacks on #83738** and reuses its origin-aware wake as the firing
  mechanism; it adds only the process-exit _trigger_ (the supervisor watcher).
