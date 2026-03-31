---
summary: "Cron jobs + wakeups for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring automation that should run with or alongside heartbeats
  - Deciding between heartbeat and cron for scheduled tasks
title: "Cron Jobs"
---

# Cron jobs (Gateway scheduler)

> **Cron vs Heartbeat?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.

Cron is the Gateway’s built-in scheduler. It persists jobs, wakes the agent at
the right time, and can optionally deliver output back to a chat.

All cron executions create [background task](/automation/tasks) records. The key difference is visibility:

- `sessionTarget: "main"` creates a task with `silent` notify policy — it schedules a system event for the main session and heartbeat flow but does not generate notifications.
- `sessionTarget: "isolated"` or `sessionTarget: "session:..."` creates a visible task that shows up in `openclaw tasks` with delivery notifications.

If you want _“run this every morning”_ or _“poke the agent in 20 minutes”_,
cron is the mechanism.

Troubleshooting: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron runs **inside the Gateway** (not inside the model).
- Jobs persist under `~/.openclaw/cron/` so restarts don’t lose schedules.
- Two execution styles:
  - **Main session**: enqueue a system event, then run on the next heartbeat.
  - **Isolated**: run a dedicated agent turn in `cron:<jobId>` or a custom session, with delivery (announce by default or none).
  - **Current session**: bind to the session where the cron is created (`sessionTarget: "current"`).
  - **Custom session**: run in a persistent named session (`sessionTarget: "session:custom-id"`).
- Wakeups are first-class: a job can request “wake now” vs “next heartbeat”.
- Webhook posting is per job via `delivery.mode = "webhook"` + `delivery.to = "<url>"`.
- Legacy fallback remains for stored jobs with `notify: true` when `cron.webhook` is set, migrate those jobs to webhook delivery mode.
- For upgrades, `openclaw doctor --fix` can normalize legacy cron store fields before the scheduler touches them.

## Quick start (actionable)

Create a one-shot reminder, verify it exists, and run it immediately:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Schedule a recurring isolated job with delivery:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Tool-call equivalents (Gateway cron tool)

For the canonical JSON shapes and examples, see [JSON schema for tool calls](/automation/cron-jobs#json-schema-for-tool-calls).

## Where cron jobs are stored

Cron jobs are persisted on the Gateway host at `~/.openclaw/cron/jobs.json` by default.
The Gateway loads the file into memory and writes it back on changes, so manual edits
are only safe when the Gateway is stopped. Prefer `openclaw cron add/edit` or the cron
tool call API for changes.

## Beginner-friendly overview

Think of a cron job as: **when** to run + **what** to do.

1. **Choose a schedule**
   - One-shot reminder → `schedule.kind = "at"` (CLI: `--at`)
   - Repeating job → `schedule.kind = "every"` or `schedule.kind = "cron"`
   - If your ISO timestamp omits a timezone, it is treated as **UTC**.

2. **Choose where it runs**
   - `sessionTarget: "main"` → run during the next heartbeat with main context.
   - `sessionTarget: "isolated"` → run a dedicated agent turn in `cron:<jobId>`.
   - `sessionTarget: "current"` → bind to the current session (resolved at creation time to `session:<sessionKey>`).
   - `sessionTarget: "session:custom-id"` → run in a persistent named session that maintains context across runs.

   Default behavior (unchanged):
   - `systemEvent` payloads default to `main`
   - `agentTurn` payloads default to `isolated`

   To use current session binding, explicitly set `sessionTarget: "current"`.

3. **Choose the payload**
   - Main session → `payload.kind = "systemEvent"`
   - Isolated session → `payload.kind = "agentTurn"`

Optional: one-shot jobs (`schedule.kind = "at"`) delete after success by default. Set
`deleteAfterRun: false` to keep them (they will disable after success).

## Concepts

### Jobs

A cron job is a stored record with:

- a **schedule** (when it should run),
- a **payload** (what it should do),
- optional **delivery mode** (`announce`, `webhook`, or `none`).
- optional **agent binding** (`agentId`): run the job under a specific agent; if
  missing or unknown, the gateway falls back to the default agent.

Jobs are identified by a stable `jobId` (used by CLI/Gateway APIs).
In agent tool calls, `jobId` is canonical; legacy `id` is accepted for compatibility.
One-shot jobs auto-delete after success by default; set `deleteAfterRun: false` to keep them.

### Schedules

Cron supports three schedule kinds:

- `at`: one-shot timestamp via `schedule.at` (ISO 8601).
- `every`: fixed interval (ms).
- `cron`: 5-field cron expression (or 6-field with seconds) with optional IANA timezone.

Cron expressions use `croner`. If a timezone is omitted, the Gateway host’s
local timezone is used.

To reduce top-of-hour load spikes across many gateways, OpenClaw applies a
deterministic per-job stagger window of up to 5 minutes for recurring
top-of-hour expressions (for example `0 * * * *`, `0 */2 * * *`). Fixed-hour
expressions such as `0 7 * * *` remain exact.

For any cron schedule, you can set an explicit stagger window with `schedule.staggerMs`
(`0` keeps exact timing). CLI shortcuts:

- `--stagger 30s` (or `1m`, `5m`) to set an explicit stagger window.
- `--exact` to force `staggerMs = 0`.

### Main vs isolated execution

#### Main session jobs (system events)

Main jobs enqueue a system event and optionally wake the heartbeat runner.
They must use `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (default): event triggers an immediate heartbeat run.
- `wakeMode: "next-heartbeat"`: event waits for the next scheduled heartbeat.

This is the best fit when you want the normal heartbeat prompt + main-session context.
See [Heartbeat](/gateway/heartbeat).

Main-session cron jobs create [background task](/automation/tasks) records with `silent` notify policy (no notifications by default). They appear in `openclaw tasks list` but do not generate delivery messages.

#### Isolated jobs (dedicated cron sessions)

Isolated jobs run a dedicated agent turn in session `cron:<jobId>` or a custom session.

Key behaviors:

- Prompt is prefixed with `[cron:<jobId> <job name>]` for traceability.
- Each run starts a **fresh session id** (no prior conversation carry-over), unless using a custom session.
- Custom sessions (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.
- Default behavior: if `delivery` is omitted, isolated jobs announce a summary (`delivery.mode = "announce"`).
- `delivery.mode` chooses what happens:
  - `announce`: deliver a summary to the target channel and post a brief summary to the main session.
  - `webhook`: POST the finished event payload to `delivery.to` when the finished event includes a summary.
  - `none`: internal only (no delivery, no main-session summary).
- `wakeMode` controls when the main-session summary posts:
  - `now`: immediate heartbeat.
  - `next-heartbeat`: waits for the next scheduled heartbeat.

Use isolated jobs for noisy, frequent, or "background chores" that shouldn't spam
your main chat history.

These detached runs create [background task](/automation/tasks) records visible in `openclaw tasks` and subject to task audit and maintenance.

### Payload shapes (what runs)

Two payload kinds are supported:

- `systemEvent`: main-session only, routed through the heartbeat prompt.
- `agentTurn`: isolated-session only, runs a dedicated agent turn.

Common `agentTurn` fields:

- `message`: required text prompt.
- `model` / `thinking`: optional overrides (see below).
- `timeoutSeconds`: optional timeout override.
- `lightContext`: optional lightweight bootstrap mode for jobs that do not need workspace bootstrap file injection.

Delivery config:

- `delivery.mode`: `none` | `announce` | `webhook`.
- `delivery.channel`: `last` or a specific channel.
- `delivery.to`: channel-specific target (announce) or webhook URL (webhook mode).
- `delivery.bestEffort`: avoid failing the job if announce delivery fails.

Announce delivery suppresses messaging tool sends for the run; use `delivery.channel`/`delivery.to`
to target the chat instead. When `delivery.mode = "none"`, no summary is posted to the main session.

If `delivery` is omitted for isolated jobs, OpenClaw defaults to `announce`.

#### Announce delivery flow

When `delivery.mode = "announce"`, cron delivers directly via the outbound channel adapters.
The main agent is not spun up to craft or forward the message.

Behavior details:

- Content: delivery uses the isolated run's outbound payloads (text/media) with normal chunking and
  channel formatting.
- Heartbeat-only responses (`HEARTBEAT_OK` with no real content) are not delivered.
- If the isolated run already sent a message to the same target via the message tool, delivery is
  skipped to avoid duplicates.
- Missing or invalid delivery targets fail the job unless `delivery.bestEffort = true`.
- A short summary is posted to the main session only when `delivery.mode = "announce"`.
- The main-session summary respects `wakeMode`: `now` triggers an immediate heartbeat and
  `next-heartbeat` waits for the next scheduled heartbeat.

#### Webhook delivery flow

When `delivery.mode = "webhook"`, cron posts the finished event payload to `delivery.to` when the finished event includes a summary.

Behavior details:

- The endpoint must be a valid HTTP(S) URL.
- No channel delivery is attempted in webhook mode.
- No main-session summary is posted in webhook mode.
- If `cron.webhookToken` is set, auth header is `Authorization: Bearer <cron.webhookToken>`.
- Deprecated fallback: stored legacy jobs with `notify: true` still post to `cron.webhook` (if configured), with a warning so you can migrate to `delivery.mode = "webhook"`.

### Model and thinking overrides

Isolated jobs (`agentTurn`) can override the model and thinking level:

- `model`: Provider/model string (e.g., `anthropic/claude-sonnet-4-20250514`) or alias (e.g., `opus`)
- `thinking`: Thinking level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; GPT-5.2 + Codex models only)

Note: You can set `model` on main-session jobs too, but it changes the shared main
session model. We recommend model overrides only for isolated jobs to avoid
unexpected context shifts.

Resolution priority:

1. Job payload override (highest)
2. Hook-specific defaults (e.g., `hooks.gmail.model`)
3. Agent config default

### Lightweight bootstrap context

Isolated jobs (`agentTurn`) can set `lightContext: true` to run with lightweight bootstrap context.

- Use this for scheduled chores that do not need workspace bootstrap file injection.
- In practice, the embedded runtime runs with `bootstrapContextMode: "lightweight"`, which keeps cron bootstrap context empty on purpose.
- CLI equivalents: `openclaw cron add --light-context ...` and `openclaw cron edit --light-context`.

### Delivery (channel + target)

Isolated jobs can deliver output to a channel via the top-level `delivery` config:

- `delivery.mode`: `announce` (channel delivery), `webhook` (HTTP POST), or `none`.
- `delivery.channel`: `last` or any deliverable channel id, for example `discord`, `matrix`, `telegram`, or `whatsapp`.
- `delivery.to`: channel-specific recipient target.

`announce` delivery is only valid for isolated jobs (`sessionTarget: "isolated"`).
`webhook` delivery is valid for both main and isolated jobs.

If `delivery.channel` or `delivery.to` is omitted, cron can fall back to the main session’s
“last route” (the last place the agent replied).

Target format reminders:

- Slack/Discord/Mattermost (plugin) targets should use explicit prefixes (e.g. `channel:<id>`, `user:<id>`) to avoid ambiguity.
  Mattermost bare 26-char IDs are resolved **user-first** (DM if user exists, channel otherwise) — use `user:<id>` or `channel:<id>` for deterministic routing.
- Telegram topics should use the `:topic:` form (see below).

#### Telegram delivery targets (topics / forum threads)

Telegram supports forum topics via `message_thread_id`. For cron delivery, you can encode
the topic/thread into the `to` field:

- `-1001234567890` (chat id only)
- `-1001234567890:topic:123` (preferred: explicit topic marker)
- `-1001234567890:123` (shorthand: numeric suffix)

Prefixed targets like `telegram:...` / `telegram:group:...` are also accepted:

- `telegram:group:-1001234567890:topic:123`

## JSON schema for tool calls

Use these shapes when calling Gateway `cron.*` tools directly (agent tool calls or RPC).
CLI flags accept human durations like `20m`, but tool calls should use an ISO 8601 string
for `schedule.at` and milliseconds for `schedule.everyMs`.

### cron.add params

One-shot, main session job (system event):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

Recurring, isolated job with delivery:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates.",
    "lightContext": true
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Recurring job bound to current session (auto-resolved at creation):

```json
{
  "name": "Daily standup",
  "schedule": { "kind": "cron", "expr": "0 9 * * *" },
  "sessionTarget": "current",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize yesterday's progress."
  }
}
```

Recurring job in a custom persistent session:

```json
{
  "name": "Project monitor",
  "schedule": { "kind": "every", "everyMs": 300000 },
  "sessionTarget": "session:project-alpha-monitor",
  "payload": {
    "kind": "agentTurn",
    "message": "Check project status and update the running log."
  }
}
```

Notes:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), or `cron` (`expr`, optional `tz`).
- `schedule.at` accepts ISO 8601. Tool/API values without a timezone are treated as UTC; the CLI also accepts `openclaw cron add|edit --at "<offset-less-iso>" --tz <iana>` for local wall-clock one-shots.
- `everyMs` is milliseconds.
- `sessionTarget`: `"main"`, `"isolated"`, `"current"`, or `"session:<custom-id>"`.
- `"current"` is resolved to `"session:<sessionKey>"` at creation time.
- Custom sessions (`session:xxx`) maintain persistent context across runs.
- Optional fields: `agentId`, `description`, `enabled`, `deleteAfterRun` (defaults to true for `at`),
  `delivery`.
- `wakeMode` defaults to `"now"` when omitted.

### cron.update params

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Notes:

- `jobId` is canonical; `id` is accepted for compatibility.
- Use `agentId: null` in the patch to clear an agent binding.

### cron.run and cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Storage & history

- Job store: `~/.openclaw/cron/jobs.json` (Gateway-managed JSON).
- Run history: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-pruned by size and line count).
- Isolated cron run sessions in `sessions.json` are pruned by `cron.sessionRetention` (default `24h`; set `false` to disable).
- Override store path: `cron.store` in config.

## Retry policy

When a job fails, OpenClaw classifies errors as **transient** (retryable) or **permanent** (disable immediately).

### Transient errors (retried)

- Rate limit (429, too many requests, resource exhausted)
- Provider overload (for example Anthropic `529 overloaded_error`, overload fallback summaries)
- Network errors (timeout, ECONNRESET, fetch failed, socket)
- Server errors (5xx)
- Cloudflare-related errors

### Permanent errors (no retry)

- Auth failures (invalid API key, unauthorized)
- Config or validation errors
- Other non-transient errors

### Default behavior (no config)

**One-shot jobs (`schedule.kind: "at"`):**

- On transient error: retry up to 3 times with exponential backoff (30s → 1m → 5m).
- On permanent error: disable immediately.
- On success or skip: disable (or delete if `deleteAfterRun: true`).

**Recurring jobs (`cron` / `every`):**

- On any error: apply exponential backoff (30s → 1m → 5m → 15m → 60m) before the next scheduled run.
- Job stays enabled; backoff resets after the next successful run.

Configure `cron.retry` to override these defaults (see [Configuration](/automation/cron-jobs#configuration)).

## Configuration

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
    // Optional: override retry policy for one-shot jobs
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhook: "https://example.invalid/legacy", // deprecated fallback for stored notify:true jobs
    webhookToken: "replace-with-dedicated-webhook-token", // optional bearer token for webhook mode
    sessionRetention: "24h", // duration string or false
    runLog: {
      maxBytes: "2mb", // default 2_000_000 bytes
      keepLines: 2000, // default 2000
    },
  },
}
```

Run-log pruning behavior:

- `cron.runLog.maxBytes`: max run-log file size before pruning.
- `cron.runLog.keepLines`: when pruning, keep only the newest N lines.
- Both apply to `cron/runs/<jobId>.jsonl` files.

Webhook behavior:

- Preferred: set `delivery.mode: "webhook"` with `delivery.to: "https://..."` per job.
- Webhook URLs must be valid `http://` or `https://` URLs.
- When posted, payload is the cron finished event JSON.
- If `cron.webhookToken` is set, auth header is `Authorization: Bearer <cron.webhookToken>`.
- If `cron.webhookToken` is not set, no `Authorization` header is sent.
- Deprecated fallback: stored legacy jobs with `notify: true` still use `cron.webhook` when present.

Disable cron entirely:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## Maintenance

Cron has two built-in maintenance paths: isolated run-session retention and run-log pruning.

### Defaults

- `cron.sessionRetention`: `24h` (set `false` to disable run-session pruning)
- `cron.runLog.maxBytes`: `2_000_000` bytes
- `cron.runLog.keepLines`: `2000`

### How it works

- Isolated runs create session entries (`...:cron:<jobId>:run:<uuid>`) and transcript files.
- The reaper removes expired run-session entries older than `cron.sessionRetention`.
- For removed run sessions no longer referenced by the session store, OpenClaw archives transcript files and purges old deleted archives on the same retention window.
- After each run append, `cron/runs/<jobId>.jsonl` is size-checked:
  - if file size exceeds `runLog.maxBytes`, it is trimmed to the newest `runLog.keepLines` lines.

### Performance caveat for high volume schedulers

High-frequency cron setups can generate large run-session and run-log footprints. Maintenance is built in, but loose limits can still create avoidable IO and cleanup work.

What to watch:

- long `cron.sessionRetention` windows with many isolated runs
- high `cron.runLog.keepLines` combined with large `runLog.maxBytes`
- many noisy recurring jobs writing to the same `cron/runs/<jobId>.jsonl`

What to do:

- keep `cron.sessionRetention` as short as your debugging/audit needs allow
- keep run logs bounded with moderate `runLog.maxBytes` and `runLog.keepLines`
- move noisy background jobs to isolated mode with delivery rules that avoid unnecessary chatter
- review growth periodically with `openclaw cron runs` and adjust retention before logs become large

### Customize examples

Keep run sessions for a week and allow bigger run logs:

```json5
{
  cron: {
    sessionRetention: "7d",
    runLog: {
      maxBytes: "10mb",
      keepLines: 5000,
    },
  },
}
```

Disable isolated run-session pruning but keep run-log pruning:

```json5
{
  cron: {
    sessionRetention: false,
    runLog: {
      maxBytes: "5mb",
      keepLines: 3000,
    },
  },
}
```

Tune for high-volume cron usage (example):

```json5
{
  cron: {
    sessionRetention: "12h",
    runLog: {
      maxBytes: "3mb",
      keepLines: 1500,
    },
  },
}
```

## CLI quickstart

One-shot reminder (UTC ISO, auto-delete after success):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

One-shot reminder (main session, wake immediately):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job (announce to WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Recurring cron job with explicit 30-second stagger:

```bash
openclaw cron add \
  --name "Minute watcher" \
  --cron "0 * * * * *" \
  --tz "UTC" \
  --stagger 30s \
  --session isolated \
  --message "Run minute watcher checks." \
  --announce
```

Recurring isolated job (deliver to a Telegram topic):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Isolated job with model and thinking override:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Agent selection (multi-agent setups):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Manual run (force is the default, use `--due` to only run when due):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

`cron.run` now acknowledges once the manual run is queued, not after the job finishes. Successful queue responses look like `{ ok: true, enqueued: true, runId }`. If the job is already running or `--due` finds nothing due, the response stays `{ ok: true, ran: false, reason }`. Use `openclaw cron runs --id <jobId>` or the `cron.runs` gateway method to inspect the eventual finished entry.

Edit an existing job (patch fields):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Force an existing cron job to run exactly on schedule (no stagger):

```bash
openclaw cron edit <jobId> --exact
```

Run history:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Immediate system event without creating a job:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway API surface

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force or due), `cron.runs`
  For immediate system events without a job, use [`openclaw system event`](/cli/system).

## Troubleshooting

### "Nothing runs"

- Check cron is enabled: `cron.enabled` and `OPENCLAW_SKIP_CRON`.
- Check the Gateway is running continuously (cron runs inside the Gateway process).
- For `cron` schedules: confirm timezone (`--tz`) vs the host timezone.

### A recurring job keeps delaying after failures

- OpenClaw applies exponential retry backoff for recurring jobs after consecutive errors:
  30s, 1m, 5m, 15m, then 60m between retries.
- Backoff resets automatically after the next successful run.
- One-shot (`at`) jobs retry transient errors (rate limit, overloaded, network, server_error) up to 3 times with backoff; permanent errors disable immediately. See [Retry policy](/automation/cron-jobs#retry-policy).

### Telegram delivers to the wrong place

- For forum topics, use `-100…:topic:<id>` so it’s explicit and unambiguous.
- If you see `telegram:...` prefixes in logs or stored “last route” targets, that’s normal;
  cron delivery accepts them and still parses topic IDs correctly.

### Subagent announce delivery retries

- When a subagent run completes, the gateway announces the result to the requester session.
- If the announce flow returns `false` (e.g. requester session is busy), the gateway retries up to 3 times with tracking via `announceRetryCount`.
- Announces older than 5 minutes past `endedAt` are force-expired to prevent stale entries from looping indefinitely.
- If you see repeated announce deliveries in logs, check the subagent registry for entries with high `announceRetryCount` values.

## Related

- [Automation Overview](/automation) — all automation mechanisms at a glance
- [Cron vs Heartbeat](/automation/cron-vs-heartbeat) — when to use each
- [Background Tasks](/automation/tasks) — task ledger for cron executions
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [Troubleshooting](/automation/troubleshooting) — debugging automation issues
