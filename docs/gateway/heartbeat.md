---
summary: "Heartbeat polling messages and notification rules"
read_when:
  - Adjusting heartbeat cadence or messaging
  - Deciding between heartbeat and cron for scheduled tasks
title: "Heartbeat"
---

# Heartbeat (Gateway)

> **Heartbeat vs Cron?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.

Heartbeat runs **periodic agent turns** in the main session so the model can
surface anything that needs attention without spamming you.

Troubleshooting: [/automation/troubleshooting](/automation/troubleshooting)

## Quick start (beginner)

1. Leave heartbeats enabled (default is `30m`, or `1h` for Anthropic OAuth/setup-token) or set your own cadence.
2. Create a tiny `HEARTBEAT.md` checklist in the agent workspace (optional but recommended).
3. Decide where heartbeat messages should go (`target: "none"` is the default; set `target: "last"` to route to the last contact).
4. Optional: enable heartbeat reasoning delivery for transparency.
5. Optional: restrict heartbeats to active hours (local time).

Example config:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
        directPolicy: "allow", // default: allow direct/DM targets; set "block" to suppress
        // activeHours: { start: "08:00", end: "24:00" },
        // includeReasoning: true, // optional: send separate `Reasoning:` message too
      },
    },
  },
}
```

## Defaults

- Interval: `30m` (or `1h` when Anthropic OAuth/setup-token is the detected auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`
- The heartbeat prompt is sent **verbatim** as the user message. The system
  prompt includes a “Heartbeat” section and the run is flagged internally.
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.
  Outside the window, heartbeats are skipped until the next tick inside the window.

## What the heartbeat prompt is for

The default prompt is intentionally broad:

- **Background tasks**: “Consider outstanding tasks” nudges the agent to review
  follow-ups (inbox, calendar, reminders, queued work) and surface anything urgent.
- **Human check-in**: “Checkup sometimes on your human during day time” nudges an
  occasional lightweight “anything you need?” message, but avoids night-time spam
  by using your configured local timezone (see [/concepts/timezone](/concepts/timezone)).

If you want a heartbeat to do something very specific (e.g. “check Gmail PubSub
stats” or “verify gateway health”), set `agents.defaults.heartbeat.prompt` (or
`agents.list[].heartbeat.prompt`) to a custom body (sent verbatim).

## Response contract

- If nothing needs attention, reply with **`HEARTBEAT_OK`**.
- During heartbeat runs, OpenClaw treats `HEARTBEAT_OK` as an ack when it appears
  at the **start or end** of the reply. The token is stripped and the reply is
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated
  specially.
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.

Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped
and logged; a message that is only `HEARTBEAT_OK` is dropped.

## Config

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // default: 30m (0m disables)
        model: "anthropic/claude-opus-4-6",
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)
        target: "last", // default: none | options: last | none | <channel id> (core or plugin, e.g. "bluebubbles")
        to: "+15551234567", // optional channel-specific override
        accountId: "ops-bot", // optional multi-account channel id
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK
      },
    },
  },
}
```

### Scope and precedence

- `agents.defaults.heartbeat` sets global heartbeat behavior.
- `agents.list[].heartbeat` merges on top; if any agent has a `heartbeat` block, **only those agents** run heartbeats.
- `channels.defaults.heartbeat` sets visibility defaults for all channels.
- `channels.<channel>.heartbeat` overrides channel defaults.
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) overrides per-channel settings.

### Per-agent heartbeats

If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`
(so you can set shared defaults once and override per agent).

Example: two agents, only the second agent runs heartbeats.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
      },
    },
    list: [
      { id: "main", default: true },
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "whatsapp",
          to: "+15551234567",
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",
        },
      },
    ],
  },
}
```

### Active hours example

Restrict heartbeats to business hours in a specific timezone:

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
        target: "last", // explicit delivery to last contact (default is "none")
        activeHours: {
          start: "09:00",
          end: "22:00",
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz
        },
      },
    },
  },
}
```

Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.

### 24/7 setup

If you want heartbeats to run all day, use one of these patterns:

- Omit `activeHours` entirely (no time-window restriction; this is the default behavior).
- Set a full-day window: `activeHours: { start: "00:00", end: "24:00" }`.

Do not set the same `start` and `end` time (for example `08:00` to `08:00`).
That is treated as a zero-width window, so heartbeats are always skipped.

### Multi account example

Use `accountId` to target a specific account on multi-account channels like Telegram:

```json5
{
  agents: {
    list: [
      {
        id: "ops",
        heartbeat: {
          every: "1h",
          target: "telegram",
          to: "12345678:topic:42", // optional: route to a specific topic/thread
          accountId: "ops-bot",
        },
      },
    ],
  },
  channels: {
    telegram: {
      accounts: {
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },
      },
    },
  },
}
```

### Field notes

- `every`: heartbeat interval (duration string; default unit = minutes).
- `model`: optional model override for heartbeat runs (`provider/model`).
- `includeReasoning`: when enabled, also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`).
- `session`: optional session key for heartbeat runs.
  - `main` (default): agent main session.
  - Explicit session key (copy from `openclaw sessions --json` or the [sessions CLI](/cli/sessions)).
  - Session key formats: see [Sessions](/concepts/session) and [Groups](/channels/groups).
- `target`:
  - `last`: deliver to the last used external channel.
  - explicit channel: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.
  - `none` (default): run the heartbeat but **do not deliver** externally.
- `directPolicy`: controls direct/DM delivery behavior:
  - `allow` (default): allow direct/DM heartbeat delivery.
  - `block`: suppress direct/DM delivery (`reason=dm-blocked`).
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id). For Telegram topics/threads, use `<chatId>:topic:<messageThreadId>`.
- `accountId`: optional account id for multi-account channels. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts; otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.
- `prompt`: overrides the default prompt body (not merged).
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery.
- `suppressToolErrorWarnings`: when true, suppresses tool error warning payloads during heartbeat runs.
- `activeHours`: restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive; use `00:00` for start-of-day), `end` (HH:MM exclusive; `24:00` allowed for end-of-day), and optional `timezone`.
  - Omitted or `"user"`: uses your `agents.defaults.userTimezone` if set, otherwise falls back to the host system timezone.
  - `"local"`: always uses the host system timezone.
  - Any IANA identifier (e.g. `America/New_York`): used directly; if invalid, falls back to the `"user"` behavior above.
  - `start` and `end` must not be equal for an active window; equal values are treated as zero-width (always outside the window).
  - Outside the active window, heartbeats are skipped until the next tick inside the window.

## Delivery behavior

- Heartbeats run in the agent’s main session by default (`agent:<id>:<mainKey>`),
  or `global` when `session.scope = "global"`. Set `session` to override to a
  specific channel session (Discord/WhatsApp/etc.).
- `session` only affects the run context; delivery is controlled by `target` and `to`.
- To deliver to a specific channel/recipient, set `target` + `to`. With
  `target: "last"`, delivery uses the last external channel for that session.
- Heartbeat deliveries allow direct/DM targets by default. Set `directPolicy: "block"` to suppress direct-target sends while still running the heartbeat turn.
- If the main queue is busy, the heartbeat is skipped and retried later.
- If `target` resolves to no external destination, the run still happens but no
  outbound message is sent.
- Heartbeat-only replies do **not** keep the session alive; the last `updatedAt`
  is restored so idle expiry behaves normally.

## Visibility controls

By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is
delivered. You can adjust this per channel or per account:

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false # Hide HEARTBEAT_OK (default)
      showAlerts: true # Show alert messages (default)
      useIndicator: true # Emit indicator events (default)
  telegram:
    heartbeat:
      showOk: true # Show OK acknowledgments on Telegram
  whatsapp:
    accounts:
      work:
        heartbeat:
          showAlerts: false # Suppress alert delivery for this account
```

Precedence: per-account → per-channel → channel defaults → built-in defaults.

### What each flag does

- `showOk`: sends a `HEARTBEAT_OK` acknowledgment when the model returns an OK-only reply.
- `showAlerts`: sends the alert content when the model returns a non-OK reply.
- `useIndicator`: emits indicator events for UI status surfaces.

If **all three** are false, OpenClaw skips the heartbeat run entirely (no model call).

### Per-channel vs per-account examples

```yaml
channels:
  defaults:
    heartbeat:
      showOk: false
      showAlerts: true
      useIndicator: true
  slack:
    heartbeat:
      showOk: true # all Slack accounts
    accounts:
      ops:
        heartbeat:
          showAlerts: false # suppress alerts for the ops account only
  telegram:
    heartbeat:
      showOk: true
```

### Common patterns

| Goal                                     | Config                                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Default behavior (silent OKs, alerts on) | _(no config needed)_                                                                     |
| Fully silent (no messages, no indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |
| Indicator-only (no messages)             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |
| OKs in one channel only                  | `channels.telegram.heartbeat: { showOk: true }`                                          |

## HEARTBEAT.md (optional)

If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the
agent to read it. Think of it as your “heartbeat checklist”: small, stable, and
safe to include every 30 minutes.

If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.
If the file is missing, the heartbeat still runs and the model decides what to do.

Keep it tiny (short checklist or reminders) to avoid prompt bloat.

Example `HEARTBEAT.md`:

```md
# Heartbeat checklist

- Quick scan: anything urgent in inboxes?
- If it’s daytime, do a lightweight check-in if nothing else is pending.
- If a task is blocked, write down _what is missing_ and ask Peter next time.
```

### Can the agent update HEARTBEAT.md?

Yes — if you ask it to.

`HEARTBEAT.md` is just a normal file in the agent workspace, so you can tell the
agent (in a normal chat) something like:

- “Update `HEARTBEAT.md` to add a daily calendar check.”
- “Rewrite `HEARTBEAT.md` so it’s shorter and focused on inbox follow-ups.”

If you want this to happen proactively, you can also include an explicit line in
your heartbeat prompt like: “If the checklist becomes stale, update HEARTBEAT.md
with a better one.”

Safety note: don’t put secrets (API keys, phone numbers, private tokens) into
`HEARTBEAT.md` — it becomes part of the prompt context.

## Manual wake (on-demand)

You can enqueue a system event and trigger an immediate heartbeat with:

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
```

If multiple agents have `heartbeat` configured, a manual wake runs each of those
agent heartbeats immediately.

Use `--mode next-heartbeat` to wait for the next scheduled tick.

## Reasoning delivery (optional)

By default, heartbeats deliver only the final “answer” payload.

If you want transparency, enable:

- `agents.defaults.heartbeat.includeReasoning: true`

When enabled, heartbeats will also deliver a separate message prefixed
`Reasoning:` (same shape as `/reasoning on`). This can be useful when the agent
is managing multiple sessions/codexes and you want to see why it decided to ping
you — but it can also leak more internal detail than you want. Prefer keeping it
off in group chats.

## Hooks

Heartbeat runs emit hook events that let you react to the heartbeat lifecycle
without modifying core code. Register handlers for `heartbeat:before` and
`heartbeat:after` in any hook (workspace, managed, or bundled).

See [Hooks → Heartbeat Events](/automation/hooks#heartbeat-events) for context
fields, type definitions, and examples.

### Why hooks?

Hooks are the **extensibility surface** for heartbeat runs. Without them, any
logic that needs to run before or after a heartbeat (metrics collection, health
scoring, alert escalation, stuck detection) must be implemented as a separate
scheduled task, duplicating scheduling, deduplication, and session resolution.

With hooks, extensions receive structured context (agent ID, session key,
status, duration) and run in-process — no extra cron jobs, no polling, no
race conditions.

### Example: HOOK.md for a heartbeat hook

```markdown
---
name: heartbeat-metrics
description: "Log heartbeat outcomes for monitoring"
metadata: { "openclaw": { "emoji": "📊", "events": ["heartbeat:after"] } }
---

# Heartbeat Metrics

Logs heartbeat status and duration after each run.
```

## Event History

Heartbeat events are recorded in an in-memory ring buffer (last 50 events).
Use `getHeartbeatEventHistory()` to query recent outcomes for trend analysis,
health dashboards, or alert logic.

### Why event history?

A single `getLastHeartbeatEvent()` is not enough when you need to:

- Compute a failure rate over a window (e.g., 3 of last 10 failed)
- Detect stuck patterns (e.g., every run returns `ok-empty` for hours)
- Build a health score from recent outcomes
- Show a status timeline in a dashboard

The ring buffer keeps the last 50 events in memory with zero persistence
overhead. It is the **data source** that hooks and skills can query to make
informed decisions.

### API

```typescript
import { getHeartbeatEventHistory, getLastHeartbeatEvent } from "../infra/heartbeat-events.js";

// Get all recorded events (up to 50)
const all = getHeartbeatEventHistory();

// Get the last 10 events
const recent = getHeartbeatEventHistory(10);

// Compute failure rate
const failRate = recent.filter((e) => e.status === "failed").length / recent.length;

// Still available: last single event
const last = getLastHeartbeatEvent();
```

### Event payload

Each event in the history has the same shape as `HeartbeatEventPayload`:

```typescript
{
  ts: number,              // Unix timestamp (ms)
  agentId: string,         // Agent identifier
  status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed",
  durationMs?: number,     // Wall-clock duration
  channel?: string,        // Delivery channel
  reason?: string,         // Why the run was triggered
}
```

## Cost awareness

Heartbeats run full agent turns. Shorter intervals burn more tokens. Keep
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you
only want internal state updates.
