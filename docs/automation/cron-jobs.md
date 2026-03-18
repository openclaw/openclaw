---
summary: "Scheduled jobs, webhooks, and Gmail PubSub triggers for the Gateway scheduler"
read_when:
  - Scheduling background jobs or wakeups
  - Wiring external triggers (webhooks, Gmail) into OpenClaw
  - Deciding between heartbeat and cron for scheduled tasks
title: "Scheduled Tasks"
---

# Scheduled Tasks (Cron)

Cron is the Gateway's built-in scheduler. It persists jobs, wakes the agent at the right time, and can deliver output back to a chat channel or webhook endpoint.

## Quick start

```bash
# Add a one-shot reminder
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

# Check your jobs
openclaw cron list

# See run history
openclaw cron runs --id <job-id>
```

## How cron works

- Cron runs **inside the Gateway** process (not inside the model).
- Jobs persist at `~/.openclaw/cron/jobs.json` so restarts do not lose schedules.
- All cron executions create [background task](/automation/tasks) records.
- One-shot jobs (`--at`) auto-delete after success by default.
- Isolated cron runs best-effort close tracked browser tabs/processes for their `cron:<jobId>` session when the run completes, so detached browser automation does not leave orphaned processes behind.
- Isolated cron runs also guard against stale acknowledgement replies. If the
  first result is just an interim status update (`on it`, `pulling everything
together`, and similar hints) and no descendant subagent run is still
  responsible for the final answer, OpenClaw re-prompts once for the actual
  result before delivery.

Task reconciliation for cron is runtime-owned: an active cron task stays live while the
cron runtime still tracks that job as running, even if an old child session row still exists.
Once the runtime stops owning the job and the 5-minute grace window expires, maintenance can
mark the task `lost`.

## Schedule types

| Kind    | CLI flag  | Description                                             |
| ------- | --------- | ------------------------------------------------------- |
| `at`    | `--at`    | One-shot timestamp (ISO 8601 or relative like `20m`)    |
| `every` | `--every` | Fixed interval                                          |
| `cron`  | `--cron`  | 5-field or 6-field cron expression with optional `--tz` |

Timestamps without a timezone are treated as UTC. Add `--tz America/New_York` for local wall-clock scheduling.

Recurring top-of-hour expressions are automatically staggered by up to 5 minutes to reduce load spikes. Use `--exact` to force precise timing or `--stagger 30s` for an explicit window.

## Execution styles

| Style           | `--session` value   | Runs in                  | Best for                        |
| --------------- | ------------------- | ------------------------ | ------------------------------- |
| Main session    | `main`              | Next heartbeat turn      | Reminders, system events        |
| Isolated        | `isolated`          | Dedicated `cron:<jobId>` | Reports, background chores      |
| Current session | `current`           | Bound at creation time   | Context-aware recurring work    |
| Custom session  | `session:custom-id` | Persistent named session | Workflows that build on history |

**Main session** jobs enqueue a system event and optionally wake the heartbeat (`--wake now` or `--wake next-heartbeat`). **Isolated** jobs run a dedicated agent turn with a fresh session. **Custom sessions** (`session:xxx`) persist context across runs, enabling workflows like daily standups that build on previous summaries.

For isolated jobs, runtime teardown now includes best-effort browser cleanup for that cron session. Cleanup failures are ignored so the actual cron result still wins.

When isolated cron runs orchestrate subagents, delivery also prefers the final
descendant output over stale parent interim text. If descendants are still
running, OpenClaw suppresses that partial parent update instead of announcing it.

### Payload options for isolated jobs

- `--message`: prompt text (required for isolated)
- `--model` / `--thinking`: model and thinking level overrides
- `--light-context`: skip workspace bootstrap file injection
- `--tools exec,read`: restrict which tools the job can use

`--model` uses the selected allowed model for that job. If the requested model
is not allowed, cron logs a warning and falls back to the job's agent/default
model selection instead. Configured fallback chains still apply, but a plain
model override with no explicit per-job fallback list no longer appends the
agent primary as a hidden extra retry target.

Model-selection precedence for isolated jobs is:

1. Gmail hook model override (when the run came from Gmail and that override is allowed)
2. Per-job payload `model`
3. Stored cron session model override
4. Agent/default model selection

Fast mode follows the resolved live selection too. If the selected model config
has `params.fastMode`, isolated cron uses that by default. A stored session
`fastMode` override still wins over config in either direction.

If an isolated run hits a live model-switch handoff, cron retries with the
switched provider/model and persists that live selection before retrying. When
the switch also carries a new auth profile, cron persists that auth profile
override too. Retries are bounded: after the initial attempt plus 2 switch
retries, cron aborts instead of looping forever.

## Delivery and output

| Mode       | What happens                                             |
| ---------- | -------------------------------------------------------- |
| `announce` | Deliver summary to target channel (default for isolated) |
| `webhook`  | POST finished event payload to a URL                     |
| `none`     | Internal only, no delivery                               |

Use `--announce --channel telegram --to "-1001234567890"` for channel delivery. For Telegram forum topics, use `-1001234567890:topic:123`. Slack/Discord/Mattermost targets should use explicit prefixes (`channel:<id>`, `user:<id>`).

For cron-owned isolated jobs, the runner owns the final delivery path. The
agent is prompted to return a plain-text summary, and that summary is then sent
through `announce`, `webhook`, or kept internal for `none`. `--no-deliver`
does not hand delivery back to the agent; it keeps the run internal.

If the original task explicitly says to message some external recipient, the
agent should note who/where that message should go in its output instead of
trying to send it directly.

Failure notifications follow a separate destination path:

- `cron.failureDestination` sets a global default for failure notifications.
- `job.delivery.failureDestination` overrides that per job.
- If neither is set and the job already delivers via `announce`, failure notifications now fall back to that primary announce target.
- `delivery.failureDestination` is only supported on `sessionTarget="isolated"` jobs unless the primary delivery mode is `webhook`.

## CLI examples

One-shot reminder (main session):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Recurring isolated job with delivery:

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
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `signal` / `imessage` / `irc` / `googlechat` / `line` / `last`, plus extension channels like `msteams` / `mattermost` (plugins).
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

### Pre-run hooks

A pre-run hook lets you gate job execution on a shell command. The command runs
via `/bin/sh -c` before the agent turn starts. Use it to check resource
availability, network reachability, or any other precondition.

```json5
{
  preHook: {
    command: "curl -sf http://localhost:8080/healthz",
    timeoutSeconds: 10, // default: 30
  },
}
```

**Exit code contract:**

| Exit code | Behavior                                                                              |
| --------- | ------------------------------------------------------------------------------------- |
| `0`       | Proceed with agent execution                                                          |
| `10`      | Skip this run (not counted as a failure; `consecutiveErrors` stays at 0)              |
| Any other | Error (counted as a failure; increments `consecutiveErrors`, triggers backoff/alerts) |

stdout and stderr are captured (capped at 64 KB) and logged for debugging.

Set `preHook` to `null` in a patch to remove it from an existing job.

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
  --announce
```

## Webhooks

Gateway can expose HTTP webhook endpoints for external triggers. Enable in config:

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

### Authentication

Every request must include the hook token via header:

- `Authorization: Bearer <token>` (recommended)
- `x-openclaw-token: <token>`

Query-string tokens are rejected.

### POST /hooks/wake

Enqueue a system event for the main session:

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

- `text` (required): event description
- `mode` (optional): `now` (default) or `next-heartbeat`

### POST /hooks/agent

Run an isolated agent turn:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.4-mini"}'
```

Fields: `message` (required), `name`, `agentId`, `wakeMode`, `deliver`, `channel`, `to`, `model`, `thinking`, `timeoutSeconds`.

### Mapped hooks (POST /hooks/\<name\>)

Custom hook names are resolved via `hooks.mappings` in config. Mappings can transform arbitrary payloads into `wake` or `agent` actions with templates or code transforms.

### Security

- Keep hook endpoints behind loopback, tailnet, or trusted reverse proxy.
- Use a dedicated hook token; do not reuse gateway auth tokens.
- Keep `hooks.path` on a dedicated subpath; `/` is rejected.
- Set `hooks.allowedAgentIds` to limit explicit `agentId` routing.
- Keep `hooks.allowRequestSessionKey=false` unless you require caller-selected sessions.
- If you enable `hooks.allowRequestSessionKey`, also set `hooks.allowedSessionKeyPrefixes` to constrain allowed session key shapes.
- Hook payloads are wrapped with safety boundaries by default.

## Gmail PubSub integration

Wire Gmail inbox triggers to OpenClaw via Google PubSub.

**Prerequisites**: `gcloud` CLI, `gog` (gogcli), OpenClaw hooks enabled, Tailscale for the public HTTPS endpoint.

### Wizard setup (recommended)

```bash
openclaw webhooks gmail setup --account openclaw@gmail.com
```

This writes `hooks.gmail` config, enables the Gmail preset, and uses Tailscale Funnel for the push endpoint.

### Gateway auto-start

When `hooks.enabled=true` and `hooks.gmail.account` is set, the Gateway starts `gog gmail watch serve` on boot and auto-renews the watch. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out.

### Manual one-time setup

1. Select the GCP project that owns the OAuth client used by `gog`:

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud services enable gmail.googleapis.com pubsub.googleapis.com
```

2. Create topic and grant Gmail push access:

```bash
gcloud pubsub topics create gog-gmail-watch
gcloud pubsub topics add-iam-policy-binding gog-gmail-watch \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

3. Start the watch:

```bash
gog gmail watch start \
  --account openclaw@gmail.com \
  --label INBOX \
  --topic projects/<project-id>/topics/gog-gmail-watch
```

### Gmail model override

```json5
{
  hooks: {
    gmail: {
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      thinking: "off",
    },
  },
}
```

## Managing jobs

```bash
# List all jobs
openclaw cron list

# Edit a job
openclaw cron edit <jobId> --message "Updated prompt" --model "opus"

# Force run a job now
openclaw cron run <jobId>

# Run only if due
openclaw cron run <jobId> --due

# View run history
openclaw cron runs --id <jobId> --limit 50

# Delete a job
openclaw cron remove <jobId>

# Agent selection (multi-agent setups)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops
openclaw cron edit <jobId> --clear-agent
```

Model override note:

- `openclaw cron add|edit --model ...` changes the job's selected model.
- If the model is allowed, that exact provider/model reaches the isolated agent
  run.
- If it is not allowed, cron warns and falls back to the job's agent/default
  model selection.
- Configured fallback chains still apply, but a plain `--model` override with
  no explicit per-job fallback list no longer falls through to the agent
  primary as a silent extra retry target.

## Configuration

```json5
{
  cron: {
    enabled: true,
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1,
    retry: {
      maxAttempts: 3,
      backoffMs: [60000, 120000, 300000],
      retryOn: ["rate_limit", "overloaded", "network", "server_error"],
    },
    webhookToken: "replace-with-dedicated-webhook-token",
    sessionRetention: "24h",
    runLog: { maxBytes: "2mb", keepLines: 2000 },
  },
}
```

Disable cron: `cron.enabled: false` or `OPENCLAW_SKIP_CRON=1`.

**One-shot retry**: transient errors (rate limit, overload, network, server error) retry up to 3 times with exponential backoff. Permanent errors disable immediately.

**Recurring retry**: exponential backoff (30s to 60m) between retries. Backoff resets after the next successful run.

**Maintenance**: `cron.sessionRetention` (default `24h`) prunes isolated run-session entries. `cron.runLog.maxBytes` / `cron.runLog.keepLines` auto-prune run-log files.

## Troubleshooting

### Command ladder

```bash
openclaw status
openclaw gateway status
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
openclaw doctor
```

### Cron not firing

- Check `cron.enabled` and `OPENCLAW_SKIP_CRON` env var.
- Confirm the Gateway is running continuously.
- For `cron` schedules, verify timezone (`--tz`) vs the host timezone.
- `reason: not-due` in run output means manual run was checked with `openclaw cron run <jobId> --due` and the job was not due yet.

### Cron fired but no delivery

- Delivery mode is `none` means no external message is expected.
- Delivery target missing/invalid (`channel`/`to`) means outbound was skipped.
- Channel auth errors (`unauthorized`, `Forbidden`) mean delivery was blocked by credentials.
- If the isolated run returns only the silent token (`NO_REPLY` / `no_reply`),
  OpenClaw suppresses direct outbound delivery and also suppresses the fallback
  queued summary path, so nothing is posted back to chat.
- For cron-owned isolated jobs, do not expect the agent to use the message tool
  as a fallback. The runner owns final delivery; `--no-deliver` keeps it
  internal instead of allowing a direct send.

### Timezone gotchas

- Cron without `--tz` uses the gateway host timezone.
- `at` schedules without timezone are treated as UTC.
- Heartbeat `activeHours` uses configured timezone resolution.

## Related

- [Automation & Tasks](/automation) — all automation mechanisms at a glance
- [Background Tasks](/automation/tasks) — task ledger for cron executions
- [Heartbeat](/gateway/heartbeat) — periodic main-session turns
- [Timezone](/concepts/timezone) — timezone configuration
