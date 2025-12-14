---
summary: "All configuration options for ~/.clawdis/clawdis.json with examples"
read_when:
  - Adding or modifying config fields
---
<!-- {% raw %} -->
# Configuration 🔧

CLAWDIS reads an optional **JSON5** config from `~/.clawdis/clawdis.json` (comments + trailing commas allowed).

If the file is missing, CLAWDIS uses safe-ish defaults (bundled Pi in RPC mode + per-sender sessions). You usually only need a config to:
- restrict who can trigger the bot (`inbound.allowFrom`)
- tune group mention behavior (`inbound.groupChat`)
- customize the agent command (`inbound.reply.command`)
 - set the agent’s identity (`identity`)

## Minimal config (recommended starting point)

```json5
{
  inbound: {
    allowFrom: ["+15555550123"]
  }
}
```

## Common options

### `identity`

Optional agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, CLAWDIS derives defaults (only when you haven’t set them explicitly):
- `inbound.responsePrefix` from `identity.emoji`
- `inbound.groupChat.mentionPatterns` from `identity.name` (so “@Samantha” works in groups)
- `inbound.reply.session.sessionIntro` when `inbound.reply` is present (and for default Pi runs)

```json5
{
  identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" }
}
```

### `logging`

- Default log file: `/tmp/clawdis/clawdis-YYYY-MM-DD.log`
- If you want a stable path, set `logging.file` to `/tmp/clawdis/clawdis.log`.

```json5
{
  logging: { level: "info", file: "/tmp/clawdis/clawdis.log" }
}
```

### `inbound.allowFrom`

Allowlist of E.164 phone numbers that may trigger auto-replies.

```json5
{
  inbound: { allowFrom: ["+15555550123", "+447700900123"] }
}
```

### `inbound.groupChat`

Group messages default to **require mention** (either metadata mention or regex patterns).

```json5
{
  inbound: {
    groupChat: {
      requireMention: true,
      mentionPatterns: ["@clawd", "clawdbot", "clawd"],
      historyLimit: 50
    }
  }
}
```

### `inbound.reply`

Controls how CLAWDIS produces replies. Two modes:
- `mode: "text"` — static reply from config (useful for testing)
- `mode: "command"` — run a local command and use its stdout as the reply (typical)

If you **omit** `inbound.reply`, CLAWDIS defaults to the bundled Pi binary in **RPC** mode:
- command (base): `pi --mode rpc {{BodyStripped}}`
- per-sender sessions + `/new` resets

Safety default: when invoking Pi, CLAWDIS always passes `--provider` and `--model` (unless you already specified them).

Example command-mode config:

```json5
{
  inbound: {
    // Preferred: the agent workspace directory (used as default cwd for agent runs; supports ~).
    workspace: "~/.clawdis/workspace",
    reply: {
      mode: "command",
      // Example: run the bundled agent (Pi) in RPC mode
      command: ["pi", "--mode", "rpc", "{{BodyStripped}}"],
      // Optional override: working directory for this reply command (supports ~).
      // If omitted, `inbound.workspace` is used.
      cwd: "~/.clawdis/workspace",
      timeoutSeconds: 1800,
      heartbeatMinutes: 30,
      // Optional: override the command used for heartbeat runs
      heartbeatCommand: ["pi", "--mode", "rpc", "HEARTBEAT /think:high"],
      session: {
        scope: "per-sender",
        idleMinutes: 10080,
        resetTriggers: ["/new"],
        sessionIntro: "You are Clawd. Be a good lobster."
      },
      agent: {
        kind: "pi",
        format: "json",
        // Only used for status/usage labeling (Pi may report its own model)
        provider: "anthropic",
        model: "claude-opus-4-5",
        contextTokens: 200000
      }
    }
  }
}
```

Notes:
- `inbound.workspace` sets the default working directory for agent runs (supports `~` and is resolved to an absolute path).
- `inbound.reply.cwd` overrides the working directory for that specific reply command.

### `browser` (clawd-managed Chrome)

Clawdis can start a **dedicated, isolated** Chrome/Chromium instance for clawd and expose a small loopback control server.

Defaults:
- enabled: `true`
- control URL: `http://127.0.0.1:18791` (CDP uses `18792`)
- profile color: `#FF4500` (lobster-orange)
- Note: the control server is started by the running gateway (Clawdis.app menubar, or `clawdis gateway`).

```json5
{
  browser: {
    enabled: true,
    controlUrl: "http://127.0.0.1:18791",
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // attachOnly: false,
  }
}
```

## Template variables

Template placeholders are expanded in `inbound.reply.command`, `sessionIntro`, `bodyPrefix`, and other templated strings.

| Variable | Description |
|----------|-------------|
| `{{Body}}` | Full inbound message body |
| `{{BodyStripped}}` | Body with group mentions stripped (best default for agents) |
| `{{From}}` | Sender identifier (E.164 for WhatsApp; may differ per surface) |
| `{{To}}` | Destination identifier |
| `{{MessageSid}}` | Provider message id (when available) |
| `{{SessionId}}` | Current session UUID |
| `{{IsNewSession}}` | `"true"` when a new session was created |
| `{{MediaUrl}}` | Inbound media pseudo-URL (if present) |
| `{{MediaPath}}` | Local media path (if downloaded) |
| `{{MediaType}}` | Media type (image/audio/document/…) |
| `{{Transcript}}` | Audio transcript (when enabled) |
| `{{ChatType}}` | `"direct"` or `"group"` |
| `{{GroupSubject}}` | Group subject (best effort) |
| `{{GroupMembers}}` | Group members preview (best effort) |
| `{{SenderName}}` | Sender display name (best effort) |
| `{{SenderE164}}` | Sender phone number (best effort) |
| `{{Surface}}` | Surface hint (whatsapp|telegram|webchat|…) |

## Cron (Gateway scheduler)

Cron is a Gateway-owned scheduler for wakeups and scheduled jobs. See [Cron + wakeups](./cron.md) for the full RFC and CLI examples.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2
  }
}
```

---

*Next: [Agent Integration](./agents.md)* 🦞
<!-- {% endraw %} -->
