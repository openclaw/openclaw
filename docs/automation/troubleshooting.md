---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Troubleshoot cron and heartbeat scheduling and delivery"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cron did not run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cron ran but no message was delivered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Heartbeat seems silent or skipped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Automation Troubleshooting"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Automation troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use this page for scheduler and delivery issues (`cron` + `heartbeat`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command ladder（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then run automation checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system heartbeat last（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron not firing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <jobId> --limit 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron status` reports enabled and a future `nextWakeAtMs`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Job is enabled and has a valid schedule/timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron runs` shows `ok` or explicit skip reason.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron: scheduler disabled; jobs will not run automatically` → cron disabled in config/env.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cron: timer tick failed` → scheduler tick crashed; inspect surrounding stack/log context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `reason: not-due` in run output → manual run called without `--force` and job not due yet.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cron fired but no delivery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron runs --id <jobId> --limit 20（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run status is `ok`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delivery mode/target are set for isolated jobs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel probe reports target channel connected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run succeeded but delivery mode is `none` → no external message is expected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Delivery target missing/invalid (`channel`/`to`) → run may succeed internally but skip outbound.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Channel auth errors (`unauthorized`, `missing_scope`, `Forbidden`) → delivery blocked by channel credentials/permissions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Heartbeat suppressed or skipped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system heartbeat last（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.defaults.heartbeat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Good output looks like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat enabled with non-zero interval.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Last heartbeat result is `ran` (or skip reason is understood).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `heartbeat skipped` with `reason=quiet-hours` → outside `activeHours`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requests-in-flight` → main lane busy; heartbeat deferred.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `empty-heartbeat-file` → `HEARTBEAT.md` exists but has no actionable content.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `alerts-disabled` → visibility settings suppress outbound heartbeat messages.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Timezone and activeHours gotchas（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.defaults.heartbeat.activeHours（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.defaults.heartbeat.activeHours.timezone（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw cron list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw logs --follow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick rules:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Config path not found: agents.defaults.userTimezone` means the key is unset; heartbeat falls back to host timezone (or `activeHours.timezone` if set).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Cron without `--tz` uses gateway host timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat `activeHours` uses configured timezone resolution (`user`, `local`, or explicit IANA tz).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- ISO timestamps without timezone are treated as UTC for cron `at` schedules.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common signatures:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Jobs run at the wrong wall-clock time after host timezone changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat always skipped during your daytime because `activeHours.timezone` is wrong.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/automation/cron-jobs](/automation/cron-jobs)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/gateway/heartbeat](/gateway/heartbeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [/concepts/timezone](/concepts/timezone)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
