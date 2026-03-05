---
summary: "Troubleshoot cron and heartbeat scheduling and delivery"
read_when:
  - Cron did not run
  - Cron ran but no message was delivered
  - Heartbeat seems silent or skipped
  - nextRunAtMs stuck or wrong
  - Cron job late or skipped
  - Timezone issues with cron
title: "Automation Troubleshooting"
---

# Automation troubleshooting

Use this page for scheduler and delivery issues (`cron` + `heartbeat`).

## Command ladder

Start with the general health checks, then drill into automation:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Then run automation checks:

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
```

## Cron not firing

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Good output looks like:

- `cron status` reports enabled and a future `nextWakeAtMs`.
- Job is enabled and has a valid schedule/timezone.
- `cron runs` shows `ok` or explicit skip reason.

Common signatures:

| Log / output | Cause | Fix |
|---|---|---|
| `cron: scheduler disabled` | Cron disabled in config or env | `openclaw config set cron.enabled true` and restart gateway |
| `cron: timer tick failed` | Scheduler tick crashed | Inspect surrounding stack in logs; run `openclaw doctor` |
| `reason: not-due` in run output | Manual run without `--force` and job not due | Use `openclaw cron run <id>` (defaults to force mode) |
| Job enabled but no `nextRunAtMs` | Schedule expression invalid or could not compute next time | Check `cron list --json` for the job; verify expr/tz are valid |
| `cron: auto-disabled job after repeated schedule errors` | 3+ consecutive schedule computation failures | Fix the cron expression or timezone, then re-enable with `openclaw cron edit <id> --enable` |
| Job shows `lastStatus: skipped` | Execution skipped (e.g. empty payload, unsupported config) | Check `lastError` in `cron list --json` for the skip reason |

### nextRunAtMs stuck or wrong

If `nextRunAtMs` seems pinned to an unexpected time:

1. Verify the schedule and timezone are correct:
   ```bash
   openclaw cron list --json | jq '.[] | select(.id == "<jobId>") | {schedule, state}'
   ```

2. Check if the schedule was recently edited. Editing the schedule or timezone via `openclaw cron edit` recomputes `nextRunAtMs` automatically. If you edited `jobs.json` directly while the gateway was running, the in-memory state may be stale.

3. Restart the gateway. On startup, the scheduler recomputes `nextRunAtMs` for all jobs with missing or past-due values.

4. As a last resort, force a recompute by toggling the job:
   ```bash
   openclaw cron edit <id> --disable
   openclaw cron edit <id> --enable
   ```

### Job fires late

Cron jobs can fire later than scheduled for several reasons:

- **Gateway was offline** during the scheduled time. On restart, missed `cron` expression jobs are replayed if their previous run slot was missed.
- **Another job was running** and hit the concurrency limit. Check `cron.maxConcurrentRuns` (default: 1).
- **Error backoff** is active. After consecutive failures, the scheduler applies exponential backoff (30s, 1m, 5m, 15m, 60m). Check `consecutiveErrors` in `cron list --json`.
- **Stagger window** is configured. Cron expression jobs have a default stagger window to prevent all jobs from firing at the exact same second. Use `--exact` to disable.

## Cron fired but no delivery

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Good output looks like:

- Run status is `ok`.
- Delivery mode/target are set for isolated jobs.
- Channel probe reports target channel connected.

Common signatures:

| Log / output | Cause | Fix |
|---|---|---|
| Run succeeded, delivery mode `none` | No external message expected | Set `--announce` on the job if delivery is wanted |
| Delivery target missing/invalid | `channel`/`to` not configured | Edit job with `--channel <channel> --to <dest>` |
| `unauthorized`, `missing_scope`, `Forbidden` | Channel credentials/permissions issue | Re-authenticate the channel; check bot permissions |
| `lastDeliveryStatus: not-delivered` | Delivery attempted but failed | Check `lastDeliveryError` in `cron list --json` |
| Main session job, no visible output | Main jobs enqueue a system event for the next heartbeat | Ensure heartbeat is enabled and not in quiet hours |

### Main vs isolated delivery

- **Main session** jobs (`--session main`) enqueue a system event. The agent processes it on the next heartbeat. If `wakeMode` is `now`, a heartbeat runs immediately. If `next-heartbeat`, it waits for the regular interval.
- **Isolated** jobs (`--session isolated`) run a dedicated agent turn. Delivery happens via `--announce` to the specified channel/destination.

## Heartbeat suppressed or skipped

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Good output looks like:

- Heartbeat enabled with non-zero interval.
- Last heartbeat result is `ran` (or skip reason is understood).

Common signatures:

| Log / output | Cause | Fix |
|---|---|---|
| `reason=quiet-hours` | Outside configured `activeHours` | Adjust `activeHours` or timezone |
| `requests-in-flight` | Main lane busy; heartbeat deferred | Wait for current request to finish |
| `empty-heartbeat-file` | `HEARTBEAT.md` empty and no tagged cron events queued | Add content to `HEARTBEAT.md`, or use `wakeMode: now` for cron jobs |
| `alerts-disabled` | Visibility settings suppress outbound | Check heartbeat visibility config |
| Heartbeat runs but produces no output | Agent has nothing to do | Add system events or check `HEARTBEAT.md` instructions |

## Timezone and activeHours gotchas

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Quick rules:

- Cron expression jobs without `--tz` use the **gateway host timezone** (resolved via `Intl.DateTimeFormat`).
- One-shot `--at` schedules: ISO strings with an offset (e.g. `+08:00`) are unambiguous. Strings without offset and without `--tz` are treated as UTC.
- `Config path not found: agents.defaults.userTimezone` means the key is unset; heartbeat falls back to host timezone (or `activeHours.timezone` if set).
- Heartbeat `activeHours` uses configured timezone resolution (`user`, `local`, or explicit IANA tz).

Common signatures:

- Jobs run at the wrong wall-clock time after host timezone changes. Fix: set explicit `--tz` on cron jobs.
- Heartbeat always skipped during your daytime because `activeHours.timezone` is wrong. Fix: set the timezone explicitly.
- VPS/Docker host in UTC but you expect local time. Fix: always use `--tz` with an IANA timezone (e.g. `America/New_York`).

## Cron configuration path

Cron jobs are **not** configured in `openclaw.json`. Adding `cron.jobs` to the config file causes a validation error.

Jobs are managed via the CLI and stored at `~/.openclaw/cron/jobs.json`:

```bash
# Manage jobs
openclaw cron add ...
openclaw cron edit <id> ...
openclaw cron remove <id>

# Cron-related config (in openclaw.json)
openclaw config set cron.enabled true
openclaw config set cron.maxConcurrentRuns 2
```

The `cron.*` keys in `openclaw.json` control scheduler behavior (enabled, concurrency, retry, failure alerts), not job definitions.

## System cron fallback

If the OpenClaw gateway is unreliable (frequent restarts, resource constraints), you can use your OS cron as a fallback to trigger jobs:

```bash
# Add to crontab (crontab -e)
0 7 * * * openclaw cron run <jobId> 2>&1 >> /tmp/openclaw-cron.log
```

This calls the CLI, which sends an RPC to the running gateway. The gateway must be running for this to work. Benefits:

- OS cron is more reliable for timing than in-process timers.
- Missed runs during gateway downtime are not replayed (use this when you prefer skip-on-miss).

For Pi or constrained environments, this can be more reliable than relying on the gateway's internal timer, especially if the gateway restarts frequently.

## Quick reference

| Symptom | First check |
|---|---|
| Job never fires | `openclaw cron status` (is cron enabled?) |
| Job fires but nothing happens | `openclaw cron runs --id <id>` (check status/error) |
| Delivery missing | `openclaw cron list --json` (check delivery config) |
| Wrong time | `openclaw cron list --json` (check tz and nextRunAtMs) |
| Job disabled unexpectedly | Check `lastError` for schedule errors or max retry exhaustion |
| Gateway restart lost schedule | Jobs persist in `~/.openclaw/cron/jobs.json`; verify file exists |

Related:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
