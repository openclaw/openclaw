---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Heartbeat polling messages and notification rules"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adjusting heartbeat cadence or messaging（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Deciding between heartbeat and cron for scheduled tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Heartbeat"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Heartbeat (Gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Heartbeat vs Cron?** See [Cron vs Heartbeat](/automation/cron-vs-heartbeat) for guidance on when to use each.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeat runs **periodic agent turns** in the main session so the model can（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
surface anything that needs attention without spamming you.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Troubleshooting: [/automation/troubleshooting](/automation/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick start (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Leave heartbeats enabled (default is `30m`, or `1h` for Anthropic OAuth/setup-token) or set your own cadence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Create a tiny `HEARTBEAT.md` checklist in the agent workspace (optional but recommended).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Decide where heartbeat messages should go (`target: "last"` is the default).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Optional: enable heartbeat reasoning delivery for transparency.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Optional: restrict heartbeats to active hours (local time).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // activeHours: { start: "08:00", end: "24:00" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        // includeReasoning: true, // optional: send separate `Reasoning:` message too（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Interval: `30m` (or `1h` when Anthropic OAuth/setup-token is the detected auth mode). Set `agents.defaults.heartbeat.every` or per-agent `agents.list[].heartbeat.every`; use `0m` to disable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prompt body (configurable via `agents.defaults.heartbeat.prompt`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The heartbeat prompt is sent **verbatim** as the user message. The system（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt includes a “Heartbeat” section and the run is flagged internally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Active hours (`heartbeat.activeHours`) are checked in the configured timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Outside the window, heartbeats are skipped until the next tick inside the window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What the heartbeat prompt is for（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The default prompt is intentionally broad:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Background tasks**: “Consider outstanding tasks” nudges the agent to review（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  follow-ups (inbox, calendar, reminders, queued work) and surface anything urgent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Human check-in**: “Checkup sometimes on your human during day time” nudges an（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  occasional lightweight “anything you need?” message, but avoids night-time spam（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  by using your configured local timezone (see [/concepts/timezone](/concepts/timezone)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want a heartbeat to do something very specific (e.g. “check Gmail PubSub（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
stats” or “verify gateway health”), set `agents.defaults.heartbeat.prompt` (or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`agents.list[].heartbeat.prompt`) to a custom body (sent verbatim).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Response contract（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If nothing needs attention, reply with **`HEARTBEAT_OK`**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- During heartbeat runs, OpenClaw treats `HEARTBEAT_OK` as an ack when it appears（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  at the **start or end** of the reply. The token is stripped and the reply is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  dropped if the remaining content is **≤ `ackMaxChars`** (default: 300).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `HEARTBEAT_OK` appears in the **middle** of a reply, it is not treated（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  specially.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For alerts, **do not** include `HEARTBEAT_OK`; return only the alert text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outside heartbeats, stray `HEARTBEAT_OK` at the start/end of a message is stripped（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and logged; a message that is only `HEARTBEAT_OK` is dropped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m", // default: 30m (0m disables)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        model: "anthropic/claude-opus-4-6",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        includeReasoning: false, // default: false (deliver separate Reasoning: message when available)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last", // last | none | <channel id> (core or plugin, e.g. "bluebubbles")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        to: "+15551234567", // optional channel-specific override（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        accountId: "ops-bot", // optional multi-account channel id（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        ackMaxChars: 300, // max chars allowed after HEARTBEAT_OK（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Scope and precedence（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.heartbeat` sets global heartbeat behavior.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.list[].heartbeat` merges on top; if any agent has a `heartbeat` block, **only those agents** run heartbeats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.defaults.heartbeat` sets visibility defaults for all channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.<channel>.heartbeat` overrides channel defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.<channel>.accounts.<id>.heartbeat` (multi-account channels) overrides per-channel settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-agent heartbeats（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If any `agents.list[]` entry includes a `heartbeat` block, **only those agents**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
run heartbeats. The per-agent block merges on top of `agents.defaults.heartbeat`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(so you can set shared defaults once and override per agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example: two agents, only the second agent runs heartbeats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      { id: "main", default: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "ops",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          every: "1h",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          target: "whatsapp",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          to: "+15551234567",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          prompt: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Active hours example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Restrict heartbeats to business hours in a specific timezone:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    defaults: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        every: "30m",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        target: "last",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        activeHours: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          start: "09:00",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          end: "22:00",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          timezone: "America/New_York", // optional; uses your userTimezone if set, otherwise host tz（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Outside this window (before 9am or after 10pm Eastern), heartbeats are skipped. The next scheduled tick inside the window will run normally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Multi account example（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `accountId` to target a specific account on multi-account channels like Telegram:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  agents: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    list: [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        id: "ops",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        heartbeat: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          every: "1h",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          target: "telegram",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          to: "12345678",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          accountId: "ops-bot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "ops-bot": { botToken: "YOUR_TELEGRAM_BOT_TOKEN" },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Field notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `every`: heartbeat interval (duration string; default unit = minutes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model`: optional model override for heartbeat runs (`provider/model`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `includeReasoning`: when enabled, also deliver the separate `Reasoning:` message when available (same shape as `/reasoning on`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session`: optional session key for heartbeat runs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `main` (default): agent main session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Explicit session key (copy from `openclaw sessions --json` or the [sessions CLI](/cli/sessions)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Session key formats: see [Sessions](/concepts/session) and [Groups](/channels/groups).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `target`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `last` (default): deliver to the last used external channel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - explicit channel: `whatsapp` / `telegram` / `discord` / `googlechat` / `slack` / `msteams` / `signal` / `imessage`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `none`: run the heartbeat but **do not deliver** externally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `to`: optional recipient override (channel-specific id, e.g. E.164 for WhatsApp or a Telegram chat id).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accountId`: optional account id for multi-account channels. When `target: "last"`, the account id applies to the resolved last channel if it supports accounts; otherwise it is ignored. If the account id does not match a configured account for the resolved channel, delivery is skipped.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `prompt`: overrides the default prompt body (not merged).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ackMaxChars`: max chars allowed after `HEARTBEAT_OK` before delivery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `activeHours`: restricts heartbeat runs to a time window. Object with `start` (HH:MM, inclusive), `end` (HH:MM exclusive; `24:00` allowed for end-of-day), and optional `timezone`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Omitted or `"user"`: uses your `agents.defaults.userTimezone` if set, otherwise falls back to the host system timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `"local"`: always uses the host system timezone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Any IANA identifier (e.g. `America/New_York`): used directly; if invalid, falls back to the `"user"` behavior above.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Outside the active window, heartbeats are skipped until the next tick inside the window.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Delivery behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeats run in the agent’s main session by default (`agent:<id>:<mainKey>`),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or `global` when `session.scope = "global"`. Set `session` to override to a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  specific channel session (Discord/WhatsApp/etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `session` only affects the run context; delivery is controlled by `target` and `to`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- To deliver to a specific channel/recipient, set `target` + `to`. With（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  `target: "last"`, delivery uses the last external channel for that session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If the main queue is busy, the heartbeat is skipped and retried later.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If `target` resolves to no external destination, the run still happens but no（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  outbound message is sent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Heartbeat-only replies do **not** keep the session alive; the last `updatedAt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  is restored so idle expiry behaves normally.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Visibility controls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, `HEARTBEAT_OK` acknowledgments are suppressed while alert content is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
delivered. You can adjust this per channel or per account:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showOk: false # Hide HEARTBEAT_OK (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showAlerts: true # Show alert messages (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      useIndicator: true # Emit indicator events (default)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  telegram:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showOk: true # Show OK acknowledgments on Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  whatsapp:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      work:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          showAlerts: false # Suppress alert delivery for this account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Precedence: per-account → per-channel → channel defaults → built-in defaults.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What each flag does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `showOk`: sends a `HEARTBEAT_OK` acknowledgment when the model returns an OK-only reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `showAlerts`: sends the alert content when the model returns a non-OK reply.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `useIndicator`: emits indicator events for UI status surfaces.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If **all three** are false, OpenClaw skips the heartbeat run entirely (no model call).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Per-channel vs per-account examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```yaml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
channels:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showOk: false（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showAlerts: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      useIndicator: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  slack:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showOk: true # all Slack accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    accounts:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      ops:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          showAlerts: false # suppress alerts for the ops account only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  telegram:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    heartbeat:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      showOk: true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Common patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Goal                                     | Config                                                                                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Default behavior (silent OKs, alerts on) | _(no config needed)_                                                                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Fully silent (no messages, no indicator) | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: false }` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Indicator-only (no messages)             | `channels.defaults.heartbeat: { showOk: false, showAlerts: false, useIndicator: true }`  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| OKs in one channel only                  | `channels.telegram.heartbeat: { showOk: true }`                                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## HEARTBEAT.md (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If a `HEARTBEAT.md` file exists in the workspace, the default prompt tells the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent to read it. Think of it as your “heartbeat checklist”: small, stable, and（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
safe to include every 30 minutes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If `HEARTBEAT.md` exists but is effectively empty (only blank lines and markdown（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
headers like `# Heading`), OpenClaw skips the heartbeat run to save API calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the file is missing, the heartbeat still runs and the model decides what to do.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep it tiny (short checklist or reminders) to avoid prompt bloat.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example `HEARTBEAT.md`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Heartbeat checklist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Quick scan: anything urgent in inboxes?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If it’s daytime, do a lightweight check-in if nothing else is pending.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a task is blocked, write down _what is missing_ and ask Peter next time.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Can the agent update HEARTBEAT.md?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Yes — if you ask it to.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`HEARTBEAT.md` is just a normal file in the agent workspace, so you can tell the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent (in a normal chat) something like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Update `HEARTBEAT.md` to add a daily calendar check.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Rewrite `HEARTBEAT.md` so it’s shorter and focused on inbox follow-ups.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want this to happen proactively, you can also include an explicit line in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
your heartbeat prompt like: “If the checklist becomes stale, update HEARTBEAT.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
with a better one.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safety note: don’t put secrets (API keys, phone numbers, private tokens) into（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`HEARTBEAT.md` — it becomes part of the prompt context.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Manual wake (on-demand)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can enqueue a system event and trigger an immediate heartbeat with:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw system event --text "Check for urgent follow-ups" --mode now（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If multiple agents have `heartbeat` configured, a manual wake runs each of those（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent heartbeats immediately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `--mode next-heartbeat` to wait for the next scheduled tick.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Reasoning delivery (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, heartbeats deliver only the final “answer” payload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want transparency, enable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `agents.defaults.heartbeat.includeReasoning: true`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When enabled, heartbeats will also deliver a separate message prefixed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`Reasoning:` (same shape as `/reasoning on`). This can be useful when the agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
is managing multiple sessions/codexes and you want to see why it decided to ping（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
you — but it can also leak more internal detail than you want. Prefer keeping it（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
off in group chats.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Cost awareness（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Heartbeats run full agent turns. Shorter intervals burn more tokens. Keep（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`HEARTBEAT.md` small and consider a cheaper `model` or `target: "none"` if you（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
only want internal state updates.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
