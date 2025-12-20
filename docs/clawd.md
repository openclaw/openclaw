---
summary: "End-to-end guide for running Clawdis as a personal assistant with safety cautions"
read_when:
  - Onboarding a new assistant instance
  - Reviewing safety/permission implications
---
<!-- {% raw %} -->
# Building a personal assistant with CLAWDIS (Clawd-style)

CLAWDIS is a WhatsApp + Telegram gateway for **Pi** agents. This guide is the “personal assistant” setup: one dedicated WhatsApp number that behaves like your always-on agent.

## ⚠️ Safety first

You’re putting an agent in a position to:
- run commands on your machine (depending on your Pi tool setup)
- read/write files in your workspace
- send messages back out via WhatsApp/Telegram

Start conservative:
- Always set `inbound.allowFrom` (never run open-to-the-world on your personal Mac).
- Use a dedicated WhatsApp number for the assistant.
- Keep heartbeats disabled until you trust the setup (`heartbeatMinutes: 0`).

## Prerequisites

- Node **22+**
- CLAWDIS available on PATH (recommended during development: from source + global link)
- A second phone number (SIM/eSIM/prepaid) for the assistant

From source (recommended while the npm package is still settling):

```bash
pnpm install
pnpm build
pnpm link --global
```

## The two-phone setup (recommended)

You want this:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-CLAWD   │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (clawdis)      │
                              │    Pi agent     │
                              └─────────────────┘
```

If you link your personal WhatsApp to CLAWDIS, every message to you becomes “agent input”. That’s rarely what you want.

## 5-minute quick start

1) Pair WhatsApp Web (shows QR; scan with the assistant phone):

```bash
clawdis login
```

2) Start the Gateway (leave it running):

```bash
clawdis gateway --port 18789
```

3) Put a minimal config in `~/.clawdis/clawdis.json`:

```json5
{
  inbound: {
    allowFrom: ["+15555550123"]
  }
}
```

Now message the assistant number from your allowlisted phone.

## Give the agent a workspace (AGENTS.md)

Clawd reads operating instructions and “memory” from its workspace directory.

By default, Clawdis uses `~/clawd` as the agent workspace, and will create it (plus starter `AGENTS.md`, `SOUL.md`, `TOOLS.md`) automatically on setup/first agent run.

Tip: treat this folder like Clawd’s “memory” and make it a git repo (ideally private) so your `AGENTS.md` + memory files are backed up.

```bash
clawdis setup
```

Optional: choose a different workspace with `inbound.workspace` (supports `~`).

```json5
{
  inbound: {
    workspace: "~/clawd"
  }
}
```

## The config that turns it into “an assistant”

CLAWDIS defaults to a good assistant setup, but you’ll usually want to tune:
- persona/instructions in `SOUL.md`
- thinking defaults (if desired)
- heartbeats (once you trust it)

Example:

```json5
{
  logging: { level: "info" },
  inbound: {
    allowFrom: ["+15555550123"],
    workspace: "~/clawd",
    groupChat: {
      requireMention: true,
      mentionPatterns: ["@clawd", "clawd"]
    },
    agent: {
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkingDefault: "high",
      timeoutSeconds: 1800,
      // Start with 0; enable later.
      heartbeatMinutes: 0
    },
    session: {
      scope: "per-sender",
      resetTriggers: ["/new"],
      idleMinutes: 10080,
      mainKey: "main"
    }
  }
}
```

## Sessions and memory

- Session files: `~/.clawdis/sessions/{{SessionId}}.jsonl`
- Session metadata (token usage, last route, etc): `~/.clawdis/sessions/sessions.json` (legacy: `~/.clawdis/sessions.json`)
- `/new` starts a fresh session for that chat (configurable via `resetTriggers`). If sent alone, the agent replies with a short hello to confirm the reset.

## Heartbeats (proactive mode)

When `inbound.agent.heartbeatMinutes > 0`, CLAWDIS periodically runs a heartbeat prompt (default: `HEARTBEAT`).

- If the agent replies with `HEARTBEAT_OK` (exact token), CLAWDIS suppresses outbound delivery for that heartbeat.

```json5
{
  inbound: {
    agent: {
      heartbeatMinutes: 30
    }
  }
}
```

## Media in and out

Inbound attachments (images/audio/docs) can be surfaced to your command via templates:
- `{{MediaPath}}` (local temp file path)
- `{{MediaUrl}}` (pseudo-URL)
- `{{Transcript}}` (if audio transcription is enabled)

Outbound attachments from the agent: include `MEDIA:<path-or-url>` on its own line (no spaces). Example:

```
Here’s the screenshot.
MEDIA:/tmp/screenshot.png
```

CLAWDIS extracts these and sends them as media alongside the text.

## Operations checklist

```bash
clawdis status          # local status (creds, sessions, queued events)
clawdis status --deep   # also probes the running Gateway (WA connect + Telegram)
clawdis health --json   # gateway health snapshot (WS)
```

Logs live under `/tmp/clawdis/` (default: `clawdis-YYYY-MM-DD.log`).

## Next steps

- WebChat: [WebChat](./webchat.md)
- Gateway ops: [Gateway runbook](./gateway.md)
- Cron + wakeups: [Cron + wakeups](./cron.md)
- macOS menu bar companion: [Clawdis macOS app](./clawdis-mac.md)
- Security: [Security](./security.md)
<!-- {% endraw %} -->
