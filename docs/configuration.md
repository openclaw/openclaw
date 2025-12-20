---
summary: "All configuration options for ~/.clawdis/clawdis.json with examples"
read_when:
  - Adding or modifying config fields
---
<!-- {% raw %} -->
# Configuration 🔧

CLAWDIS reads an optional **JSON5** config from `~/.clawdis/clawdis.json` (comments + trailing commas allowed).

If the file is missing, CLAWDIS uses safe-ish defaults (embedded Pi agent + per-sender sessions + workspace `~/clawd`). You usually only need a config to:
- restrict who can trigger the bot (`inbound.allowFrom`)
- tune group mention behavior (`inbound.groupChat`)
- set the agent’s workspace (`inbound.workspace`)
- tune the embedded agent (`inbound.agent`) and session behavior (`inbound.session`)
- set the agent’s identity (`identity`)

## Minimal config (recommended starting point)

```json5
{
  inbound: {
    allowFrom: ["+15555550123"],
    workspace: "~/clawd"
  }
}
```

## Common options

### `identity`

Optional agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, CLAWDIS derives defaults (only when you haven’t set them explicitly):
- `inbound.responsePrefix` from `identity.emoji`
- `inbound.groupChat.mentionPatterns` from `identity.name` (so “@Samantha” works in groups)

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

### `inbound.workspace`

Sets the **single global workspace directory** used by the agent for file operations.

Default: `~/clawd`.

```json5
{
  inbound: { workspace: "~/clawd" }
}
```

### `inbound.agent`

Controls the embedded agent runtime (provider/model/thinking/verbose/timeouts).

```json5
{
  inbound: {
    workspace: "~/clawd",
    agent: {
      provider: "anthropic",
      model: "claude-opus-4-5",
      thinkingDefault: "low",
      verboseDefault: "off",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeatMinutes: 30,
      contextTokens: 200000
    }
  }
}
```

### `inbound.session`

Controls session scoping, idle expiry, reset triggers, and where the session store is written.

```json5
{
  inbound: {
    session: {
      scope: "per-sender",
      idleMinutes: 60,
      resetTriggers: ["/new"],
      store: "~/.clawdis/sessions/sessions.json",
      mainKey: "main"
    }
  }
}
```

### `skills` (skill config/env)

Configure skill toggles and env injection. Applies to **bundled** skills and `~/.clawdis/skills` (workspace skills still win on name conflicts).

Common fields per skill:
- `enabled`: set `false` to disable a skill even if it’s bundled/installed.
- `env`: environment variables injected for the agent run (only if not already set).
- `apiKey`: optional convenience for skills that declare a primary env var (e.g. `nano-banana-pro` → `GEMINI_API_KEY`).

Example:

```json5
{
  skills: {
    "nano-banana-pro": {
      apiKey: "GEMINI_KEY_HERE",
      env: {
        GEMINI_API_KEY: "GEMINI_KEY_HERE"
      }
    },
    peekaboo: { enabled: true },
    sag: { enabled: false }
  }
}
```

### `skillsInstall` (installer preference)

Controls which installer is surfaced by the macOS Skills UI when a skill offers
multiple install options (brew vs node). Defaults to **brew when available** and
**npm** for node installs.

```json5
{
  skillsInstall: {
    preferBrew: true,
    nodeManager: "npm" // npm | pnpm | bun
  }
}
```

### `skillsLoad`

Additional skill directories to scan (lowest precedence). This is useful if you keep skills in a separate repo but want Clawdis to pick them up without copying them into the workspace.

```json5
{
  skillsLoad: {
    extraDirs: [
      "~/Projects/agent-scripts/skills",
      "~/Projects/oss/some-skill-pack/skills"
    ]
  }
}
```

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

### `gateway` (Gateway server mode + bind)

Use `gateway.mode` to explicitly declare whether this machine should run the Gateway.

Defaults:
- mode: **unset** (treated as “do not auto-start”)
- bind: `loopback`

```json5
{
  gateway: {
    mode: "local", // or "remote"
    bind: "loopback",
    // controlUi: { enabled: true }
  }
}
```

Notes:
- `clawdis gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).

### `canvasHost` (Gateway Canvas file server + live reload)

The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can `canvas.navigate` to it.

Default root: `~/clawd/canvas`  
Port: **same as the Gateway WebSocket/HTTP port** (default `18789`)  
Path: `/__clawdis__/canvas/`  
Live-reload WebSocket: `/__clawdis/ws`

The server:
- serves files under `canvasHost.root`
- injects a tiny live-reload client into served HTML
- watches the directory and broadcasts reloads over `/__clawdis/ws`
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)

```json5
{
  canvasHost: {
    root: "~/clawd/canvas"
  }
}
```

Notes:
- `canvasHost.port` is deprecated/ignored (the Gateway port is always used).
- The bind host follows `gateway.bind` (loopback/lan/tailnet).

Disable with:
- config: `canvasHost: { enabled: false }`
- env: `CLAWDIS_SKIP_CANVAS_HOST=1`

### `bridge` (node bridge server)

The Gateway can expose a simple TCP bridge for nodes (iOS/Android), typically on port `18790`.

Defaults:
- enabled: `true`
- port: `18790`
- bind: `lan` (binds to `0.0.0.0`)

Bind modes:
- `lan`: `0.0.0.0` (reachable on any interface, including LAN/Wi‑Fi and Tailscale)
- `tailnet`: bind only to the machine’s Tailscale IP (recommended for Vienna ⇄ London)
- `loopback`: `127.0.0.1` (local only)
- `auto`: prefer tailnet IP if present, else `lan`

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet"
  }
}
```

### `discovery.wideArea` (Wide-Area Bonjour / unicast DNS‑SD)

When enabled, the Gateway writes a unicast DNS-SD zone for `_clawdis-bridge._tcp` under `~/.clawdis/dns/` using the standard discovery domain `clawdis.internal.`

To make iOS/Android discover across networks (Vienna ⇄ London), pair this with:
- a DNS server on the gateway host serving `clawdis.internal.` (CoreDNS is recommended)
- Tailscale **split DNS** so clients resolve `clawdis.internal` via that server

One-time setup helper (gateway host):

```bash
clawdis dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } }
}
```

## Template variables

Template placeholders are expanded in `inbound.transcribeAudio.command` (and any future templated command fields).

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

*Next: [Agent Runtime](./agent.md)* 🦞
<!-- {% endraw %} -->
