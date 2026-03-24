---
summary: "CLI reference for `evox cron` (schedule and run background jobs)"
read_when:
  - You want scheduled jobs and wakeups
  - You’re debugging cron execution and logs
title: "cron"
---

# `evox cron`

Manage cron jobs for the Gateway scheduler.

Related:

- Cron jobs: [Cron jobs](/automation/cron-jobs)

Tip: run `evox cron --help` for the full command surface.

Note: isolated `cron add` jobs default to `--announce` delivery. Use `--no-deliver` to keep
output internal. `--deliver` remains as a deprecated alias for `--announce`.

Note: one-shot (`--at`) jobs delete after success by default. Use `--keep-after-run` to keep them.

Note: recurring jobs now use exponential retry backoff after consecutive errors (30s → 1m → 5m → 15m → 60m), then return to normal schedule after the next successful run.

Note: `evox cron run` now returns as soon as the manual run is queued for execution. Successful responses include `{ ok: true, enqueued: true, runId }`; use `evox cron runs --id <job-id>` to follow the eventual outcome.

Note: retention/pruning is controlled in config:

- `cron.sessionRetention` (default `24h`) prunes completed isolated run sessions.
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` prune `~/.openclaw/cron/runs/<jobId>.jsonl`.

Upgrade note: if you have older cron jobs from before the current delivery/store format, run
`evox doctor --fix`. Doctor now normalizes legacy cron fields (`jobId`, `schedule.cron`,
top-level delivery fields, payload `provider` delivery aliases) and migrates simple
`notify: true` webhook fallback jobs to explicit webhook delivery when `cron.webhook` is
configured.

## Common edits

Update delivery settings without changing the message:

```bash
evox cron edit <job-id> --announce --channel telegram --to "123456789"
```

Disable delivery for an isolated job:

```bash
evox cron edit <job-id> --no-deliver
```

Enable lightweight bootstrap context for an isolated job:

```bash
evox cron edit <job-id> --light-context
```

Announce to a specific channel:

```bash
evox cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```

Create an isolated job with lightweight bootstrap context:

```bash
evox cron add \
  --name "Lightweight morning brief" \
  --cron "0 7 * * *" \
  --session isolated \
  --message "Summarize overnight updates." \
  --light-context \
  --no-deliver
```

`--light-context` applies to isolated agent-turn jobs only. For cron runs, lightweight mode keeps bootstrap context empty instead of injecting the full workspace bootstrap set.
