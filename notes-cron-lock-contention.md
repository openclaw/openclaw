# Draft: cron lock contention blocks cron.list/status during long-running jobs

## Summary
Clawdbot cron service currently holds a per-storePath async lock (`cron/service/locked.ts`) for the entire duration of job execution. If a job takes minutes (e.g. isolated agent work or main-lane heartbeat wake), then *all* cron RPCs that use `locked(...)` (`cron.list`, `cron.status`, `cron.add/update/remove/run`, plus the timer tick) are blocked until the job completes.

This manifests as gateway RPC latency/backpressure and frequent client-side timeouts for `cron.list/status` (e.g. 60–110s).

## Evidence
### Code
- `src/cron/service/locked.ts` chains `state.op` and a per-`storePath` promise.
- `src/cron/service/timer.ts:onTimer()`:
  - `await locked(state, async () => { ... await runDueJobs(state); ... })`
  - `runDueJobs()` loops: `await executeJob(...)`
  - `executeJob()` can await long work:
    - `runIsolatedAgentJob(...)` (isolated session agent turn)
    - `runHeartbeatOnce(...)` (main lane), including polling up to 2 minutes on `requests-in-flight`
- `src/cron/service/ops.ts:run()` similarly does `await locked(...)` then `await executeJob(...)`.

So one long job blocks reads like `cron.list/status` for minutes.

### Observed behavior
- `cron.list` sometimes takes 50–110s even when successful; often times out at 10s/60s.
- cron job runs recorded as 168s, 220s, 246s, 400s etc (even when status=ok).

## Proposed fix (high level)
Don’t hold the store lock across the awaited job execution.

Split execution into phases:
1) Under lock:
   - load store
   - select due jobs
   - mark each due job as running (`runningAtMs`, clear `lastError`)
   - persist
   - arm timer / recompute next runs as appropriate
2) Outside lock:
   - run the job payload (agent work / heartbeat wake)
3) Under lock:
   - re-load store (or use in-memory store) and apply finish state (`lastStatus`, `lastDurationMs`, `nextRunAtMs`, disable/delete)
   - persist
   - arm timer

This allows `cron.list/status` to remain responsive while jobs run.

## Notes / edge cases
- **Update/remove while running** (now possible because we release the lock during execution):
  - safest: reject update/remove when `runningAtMs` is set (return a clear error)
  - acceptable: allow update/remove, but “finish” phase must tolerate job missing and/or treat patch as “next run only”.
  - if removed while running: finish phase should no-op if job not found.
- **Crash safety / restart**: once `runningAtMs` is persisted, a restart can leave jobs “stuck running” forever unless we:
  - clear `runningAtMs` on boot if older than a threshold, or
  - treat `runningAtMs` as advisory and allow list/status to show it but still permit rescheduling.
- **Timer drift / recompute**: if we recompute `nextRunAtMs` too early, a late timer tick can skip intended runs (#9788). The current phase-1 flow intentionally loads with `skipRecompute`.
- **RPC tool timeouts from inside cron jobs**: calling cron.* management operations from within a cron-triggered agent turn can still time out even with large timeouts because the cron service lock can be held by the executing job. This is exactly what the patch is meant to fix; until then, avoid cron management inside cron jobs.

## Why this matters
Cron is often used for delivery/notifications. If the management RPCs are blocked by long jobs, it becomes difficult to observe and operate the scheduler, and leads to cascading tool timeouts/backpressure at the gateway.
