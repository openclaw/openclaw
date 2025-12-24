---
summary: "All configuration options for ~/.clawdis/clawdis.json with examples"
read_when:
  - Adding or modifying config fields
---
<!-- {% raw %} -->
# Configuration 🔧

CLAWDIS reads an optional **JSON5** config from `~/.clawdis/clawdis.json` (comments + trailing commas allowed).

If the file is missing, CLAWDIS uses safe-ish defaults (embedded Pi agent + per-sender sessions + workspace `~/clawd`). You usually only need a config to:
- restrict who can trigger the bot (`routing.allowFrom`)
- tune group mention behavior (`routing.groupChat`)
- customize message prefixes (`messages`)
- set the agent’s workspace (`agent.workspace`)
- tune the embedded agent (`agent`) and session behavior (`session`)
- set the agent’s identity (`identity`)

## Minimal config (recommended starting point)

```json5
{
  agent: { workspace: "~/clawd" },
  routing: { allowFrom: ["+15555550123"] }
}
```

## Common options

### `identity`

Optional agent identity used for defaults and UX. This is written by the macOS onboarding assistant.

If set, CLAWDIS derives defaults (only when you haven’t set them explicitly):
- `messages.responsePrefix` from `identity.emoji`
- `routing.groupChat.mentionPatterns` from `identity.name` (so “@Samantha” works in groups)

```json5
{
  identity: { name: "Samantha", theme: "helpful sloth", emoji: "🦥" }
}
```

### `logging`

- Default log file: `/tmp/clawdis/clawdis-YYYY-MM-DD.log`
- If you want a stable path, set `logging.file` to `/tmp/clawdis/clawdis.log`.
- Console output can be tuned separately via:
  - `logging.consoleLevel` (defaults to `info`, bumps to `debug` when `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/clawdis/clawdis.log",
    consoleLevel: "info",
    consoleStyle: "pretty"
  }
}
```

### `routing.allowFrom`

Allowlist of E.164 phone numbers that may trigger auto-replies.

```json5
{
  routing: { allowFrom: ["+15555550123", "+447700900123"] }
}
```

### `routing.groupChat`

Group messages default to **require mention** (either metadata mention or regex patterns).

```json5
{
  routing: {
    groupChat: {
      mentionPatterns: ["@clawd", "clawdbot", "clawd"],
      historyLimit: 50
    }
  }
}
```

### `agent.workspace`

Sets the **single global workspace directory** used by the agent for file operations.

Default: `~/clawd`.

```json5
{
  agent: { workspace: "~/clawd" }
}
```

### `messages`

Controls inbound/outbound prefixes and timestamps.

```json5
{
  messages: {
    messagePrefix: "[clawdis]",
    responsePrefix: "🦞",
    timestampPrefix: "Europe/London"
  }
}
```

### `agent`

Controls the embedded agent runtime (provider/model/thinking/verbose/timeouts).
`allowedModels` lets `/model` list/filter and enforce a per-session allowlist
(omit to show the full catalog).

```json5
{
  agent: {
    provider: "anthropic",
    model: "claude-opus-4-5",
    allowedModels: [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-1"
    ],
    thinkingDefault: "low",
    verboseDefault: "off",
    timeoutSeconds: 600,
    mediaMaxMb: 5,
    heartbeatMinutes: 30,
    contextTokens: 200000
  }
}
```

### `models` (custom providers + base URLs)

Clawdis uses the **pi-coding-agent** model catalog. You can add custom providers
(LiteLLM, local OpenAI-compatible servers, Anthropic proxies, etc.) by writing
`~/.clawdis/agent/models.json` or by defining the same schema inside your
Clawdis config under `models.providers`.

When `models.providers` is present, Clawdis writes/merges a `models.json` into
`~/.clawdis/agent/` on startup:
- default behavior: **merge** (keeps existing providers, overrides on name)
- set `models.mode: "replace"` to overwrite the file contents

Select the model via `agent.provider` + `agent.model`.

```json5
{
  agent: { provider: "custom-proxy", model: "llama-3.1-8b" },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000
          }
        ]
      }
    }
  }
}
```

Notes:
- Supported APIs: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Use `authHeader: true` + `headers` for custom auth needs.
- Override the agent config root with `CLAWDIS_AGENT_DIR` (or `PI_CODING_AGENT_DIR`)
  if you want `models.json` stored elsewhere.

### `session`

Controls session scoping, idle expiry, reset triggers, and where the session store is written.

```json5
{
  session: {
    scope: "per-sender",
    idleMinutes: 60,
    resetTriggers: ["/new", "/reset"],
    store: "~/.clawdis/sessions/sessions.json",
    mainKey: "main"
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
multiple install options. Defaults to **brew when available** and **npm** for
node installs.

```json5
{
  skillsInstall: {
    preferBrew: true,
    nodeManager: "npm" // npm | pnpm | yarn
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
    // auth: { mode: "token" | "password" }
    // tailscale: { mode: "off" | "serve" | "funnel" }
  }
}
```

Notes:
- `clawdis gateway` refuses to start unless `gateway.mode` is set to `local` (or you pass the override flag).

Auth and Tailscale:
- `gateway.auth.mode` sets the handshake requirements (`token` or `password`).
- When `gateway.auth.mode` is set, only that method is accepted (plus optional Tailscale headers).
- `gateway.auth.password` can be set here, or via `CLAWDIS_GATEWAY_PASSWORD` (recommended).
- `gateway.auth.allowTailscale` controls whether Tailscale identity headers can satisfy auth.
- `gateway.tailscale.mode: "serve"` uses Tailscale Serve (tailnet only, loopback bind).
- `gateway.tailscale.mode: "funnel"` exposes the dashboard publicly; requires auth.
- `gateway.tailscale.resetOnExit` resets Serve/Funnel config on shutdown.

### `canvasHost` (LAN/tailnet Canvas file server + live reload)

The Gateway serves a directory of HTML/CSS/JS over HTTP so iOS/Android nodes can simply `canvas.navigate` to it.

Default root: `~/clawd/canvas`  
Default port: `18793` (chosen to avoid the clawd browser CDP port `18792`)  
The server listens on the **bridge bind host** (LAN or Tailnet) so nodes can reach it.

The server:
- serves files under `canvasHost.root`
- injects a tiny live-reload client into served HTML
- watches the directory and broadcasts reloads over a WebSocket endpoint at `/__clawdis/ws`
- auto-creates a starter `index.html` when the directory is empty (so you see something immediately)
- also serves A2UI at `/__clawdis__/a2ui/` and is advertised to nodes as `canvasHostUrl`
  (always used by nodes for Canvas/A2UI)

```json5
{
  canvasHost: {
    root: "~/clawd/canvas",
    port: 18793
  }
}
```

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

Template placeholders are expanded in `routing.transcribeAudio.command` (and any future templated command fields).

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
