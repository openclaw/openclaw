# Bug: Cron Jobs Skip Scheduled Runs After Gateway Restart

## Summary

When the gateway restarts close to (but before) a scheduled cron run, that run may be skipped entirely. The job's `nextRunAtMs` jumps forward by an extra day/period.

## Reproduction

1. Have a daily cron job scheduled for 6:45 PM (18:45) with `tz: America/Chicago`
2. Job runs successfully on Day 1 at 6:45 PM
3. Gateway restarts on Day 2 around 11 AM (7+ hours before the scheduled run)
4. **Expected:** Job runs at 6:45 PM on Day 2
5. **Actual:** Job is scheduled for Day 3 at 6:45 PM (skips Day 2 entirely)

## Observed Behavior

```
Last run: Feb 4, 6:45 PM CST (epoch: 1770165900002)
Gateway restart: Feb 5, ~11 AM CST
Expected next run: Feb 5, 6:45 PM CST
Actual next run: Feb 6, 6:45 PM CST (epoch: 1770425100000)
```

## Technical Details

- Cron expression: `45 18 * * *`
- Timezone: `America/Chicago`
- The `recomputeNextRuns()` function in `src/cron/service/jobs.ts` is called on startup
- It calls `computeJobNextRunAtMs(job, now)` which uses the `croner` library
- Somehow the calculation produces a result 1 day further than expected

## Affected Jobs

- `mila-bedtime-start` (daily 6:45 PM)
- `mila-bedtime-monitor` (every 10 min during bedtime hours) - also missed runs
- Potentially any cron job near a gateway restart

## Workaround

Toggle the job (disable then re-enable) to force recalculation. This doesn't always fix it.

## Files to Investigate

- `src/cron/schedule.ts` - `computeNextRunAtMs()`
- `src/cron/service/jobs.ts` - `recomputeNextRuns()`, `computeJobNextRunAtMs()`
- `src/cron/service/ops.ts` - `start()`

## Environment

- OpenClaw version: 0.95.x
- Node.js: v25.3.0
- OS: macOS Darwin 24.6.0 (arm64)
- Timezone: America/Chicago (CST)

## Severity

**High** - Cron jobs are critical for automations. Missing bedtime routines, reminders, and scheduled tasks causes real-world impact.

## Related

- Discord WebSocket disconnection spam (possibly related to restart timing)
- Jobs with `wakeMode: now` may have different behavior than `next-heartbeat`
