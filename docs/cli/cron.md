---
summary: "CLI reference for `openclaw cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: "cron"
---

# `openclaw cron`

Manage cron jobs for the Gateway scheduler.

Related:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

Tip: run `openclaw cron --help` for the full command surface.

Note: isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

Note: one-shot (`--at`) jobs delete after success by default. Use `--keep-after-run` to keep them.

Note: `--session` supports `main`, `isolated`, `current`, and `session:<id>`.
Use `current` to bind to the active session at creation time, or `session:<id>` for
an explicit persistent session key.

Note: for one-shot CLI jobs, offset-less `--at` datetimes are treated as UTC unless you also pass
`--tz <iana>`, which interprets that local wall-clock time in the given timezone.

Note: recurring jobs now use exponential retry backoff after consecutive errors (30s → 1m → 5m → 15m → 60m), then return to normal schedule after the next successful run.

Note: `openclaw cron run` now returns as soon as the manual run is queued for execution. Successful responses include `{ ok: true, enqueued: true, runId }`; use `openclaw cron runs --id <job-id>` to follow the eventual outcome.

Note: `openclaw cron run <job-id>` force-runs by default. Use `--due` to keep the
older "only run if due" behavior.

Note: isolated cron turns suppress stale acknowledgement-only replies. If the
first result is just an interim status update and no descendant subagent run is
responsible for the eventual answer, cron re-prompts once for the real result
before delivery.

Note: `cron add|edit --model ...` uses that selected allowed model for the job.
If the model is not allowed, cron warns and falls back to the job's agent/default
model selection instead. Configured fallback chains still apply, but a plain
model override with no explicit per-job fallback list no longer appends the
agent primary as a hidden extra retry target.

Note: failure notifications use `delivery.failureDestination` first, then
global `cron.failureDestination`, and finally fall back to the job's primary
announce target when no explicit failure destination is configured.

Note: retention/pruning is controlled in config:

- `cron.sessionRetention` (default `24h`) prunes completed isolated run sessions.
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` prune `~/.openclaw/cron/runs/<jobId>.jsonl`.

Upgrade note: if you have older cron jobs from before the current delivery/store format, run
`openclaw doctor --fix`. Doctor now normalizes legacy cron fields (`jobId`, `schedule.cron`,
top-level delivery fields including legacy `threadId`, payload `provider` delivery aliases) and migrates simple
`notify: true` webhook fallback jobs to explicit webhook delivery when `cron.webhook` is
configured.

## Common edits

Update delivery settings without changing the message:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
openclaw cron edit <job-id> --no-deliver
```

Enable lightweight bootstrap context for an isolated job:

```bash
openclaw cron edit <job-id> --light-context
```

Announce to a specific channel:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

Create an isolated job with lightweight bootstrap context:

```bash
openclaw cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context` applies to isolated agent-turn jobs only. For cron runs, lightweight mode keeps bootstrap context empty instead of injecting the full workspace bootstrap set.

## Common admin commands

Manual run:

```bash
openclaw cron run <job-id>
openclaw cron run <job-id> --due
openclaw cron runs --id <job-id> --limit 50
```

Agent/session retargeting:

```bash
openclaw cron edit <job-id> --agent ops
openclaw cron edit <job-id> --clear-agent
openclaw cron edit <job-id> --session current
openclaw cron edit <job-id> --session "session:daily-brief"
```

Delivery tweaks:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
openclaw cron edit <job-id> --best-effort-deliver
openclaw cron edit <job-id> --no-best-effort-deliver
openclaw cron edit <job-id> --no-deliver
```

Failure-delivery note:

- `delivery.failureDestination` is supported for isolated jobs.
- Main-session jobs may only use `delivery.failureDestination` when primary
  delivery mode is `webhook`.
- If you do not set any failure destination and the job already announces to a
  channel, failure notifications reuse that same announce target.
