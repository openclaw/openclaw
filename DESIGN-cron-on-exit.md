# feat(cron): `on-exit` schedule — fire a job when a watched command/process exits

## Problem

Event-driven wakes that start a fresh agent turn already work (the `wake`/`system event` RPC). But an agent cannot reliably arm "wake me when this command/process exits" itself: CLI backends run each turn as a supervisor-spawned **detached process group** that is `signalProcessTree(SIGTERM→SIGKILL)`'d at turn end (`src/process/supervisor/adapters/child.ts`, intentional, #71662). Any process the agent backgrounds via `exec` is in that tree and dies with the turn. The only escape (`setsid` + raw `node dist/entry.js system event …`) is hand-rolled, fragile, and observed to take down the host. Applies to **all** spawn-and-kill CLI backends (claude-cli verified), not the TLS proxy.

## Design

A new cron **schedule kind** `on-exit`, executed by a **gateway-supervisor-owned watcher** — independent of #83738 (rides the existing main-session cron run pipeline, not the manual wake path).

- `CronSchedule` gains `{ kind: "on-exit"; command: string; cwd?: string }` (PID-watch variant deferred).
- `computeNextRunAtMs()` returns `undefined` for `on-exit` → the time-based timer never fires it.
- `buildGatewayCronService` injects a `watchExit(job)` dep backed by `getProcessSupervisor()`:
  - On job add/load with an `on-exit` schedule + `enabled`, spawn the command via `supervisor.spawn({ mode:"child", scopeKey:"cron-watch:<jobId>", argv:["bash","-lc",command], captureOutput:true })`.
  - The watcher lives under the **gateway** supervisor tree, so per-turn teardown never touches it.
  - `await run.wait()` → on exit, call existing `enqueueRun(jobId)`; the job's `payload.text` is augmented with the exit code + last output lines so the woken turn sees the result.
  - Job `remove`/`disable` → `supervisor.cancelScope("cron-watch:<jobId>")`.
- Delivery to the originating conversation is the **existing** `executeMainSessionCronJob` path (`resolveMainSessionCronDeliveryContext`) — already correct on main; no dependency on #83738.

## Reuse / no new delivery code

Everything after "process exited" is the current cron run→system-event→delivery pipeline. The only new surface: the schedule kind, its validation, the watcher lifecycle, and the tool/schema plumbing to create such a job.

## Out of scope

- PID-watch (`{ kind:"on-exit"; pid }`) — follow-up.
- Re-arm/repeat on each exit — v1 is one-shot (job disables after firing, like a one-shot `at`).
- This PR **stacks on #83738** and reuses its origin-aware wake as the firing
  mechanism; it adds only the process-exit _trigger_ (the supervisor watcher).
