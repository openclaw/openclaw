# OpenClaw WRT

OpenClaw bridge plugin for ClawWRT router device WebSocket control.

**[中文文档](README_zh.md)**

## Features

- WebSocket bridge server accepting router device connections
- Request/response correlation via `req_id`
- Device session management (connect, auth, timeout, alias)
- AWAS authentication proxy (forwards cloud-mode device connect/heartbeat to AWAS server)
- 30+ fine-grained tools covering: WiFi config, client management, BPF traffic monitoring, WireGuard VPN, shell execution, portal page publishing, domain trust list, etc.

## Installation

### Option 1: npm install (after published)

```bash
openclaw plugins install @openclaw/openclaw-wrt
```

### Option 2: Local directory install (recommended for development)

Install the source directory directly into OpenClaw without building:

```bash
openclaw plugins install /path/to/openclaw-wrt
```

Example:

```bash
openclaw plugins add /home/user/work/openclaw-wrt
```

> OpenClaw automatically links the plugin into `~/.openclaw/extensions/` and loads it via jiti TypeScript compilation.

### Option 3: Build then install locally

```bash
# Build first
pnpm build

# Install the built artifacts
openclaw plugins install /path/to/openclaw-wrt
```

### Verify installation

```bash
# List installed plugins
openclaw plugins list

# Inspect plugin details
openclaw plugins inspect openclaw-wrt
```

### Uninstall

```bash
openclaw plugins remove openclaw-wrt
```

## How it works

```
┌──────────────┐    WebSocket     ┌──────────────────┐    Tool calls    ┌──────────────────┐
│   ClawWRT    │ ──────────────>  │  OpenClaw WRT    │ ──────────────>  │  OpenClaw Agent  │
│   Router     │ <──────────────  │  Bridge Plugin   │ <──────────────  │  (LLM)           │
│   Device     │    JSON-RPC      │                  │                  │                  │
│              │                  │  · req_id correl. │                  │  Uses 30+ tools  │
└──────────────┘                  │  · device mgmt   │                  │  to manage router│
                                  │  · auth/token    │                  └──────────────────┘
                                  │  · AWAS proxy    │
                                  └──────────────────┘
```

1. **Router connects** — Each ClawWRT-enabled router opens a WebSocket to the bridge (`ws://host:8001/ws/clawwrt`) and sends a connect message with its `device_id`.
2. **Bridge manages sessions** — The plugin maintains a device registry with connection state, aliases, and optional token-based authentication.
3. **Agent controls devices** — OpenClaw's LLM agent calls 30+ registered tools (e.g., `clawwrt_get_clients`, `clawwrt_set_wifi_info`, `clawwrt_exec_shell`). Each tool call is correlated with the router's response via `req_id`.
4. **AWAS proxy (optional)** — For cloud-mode devices, the plugin can forward authentication traffic to an AWAS (Auth Server) backend.

## Captive portal pages

Use `clawwrt_publish_portal_page` after the agent has generated the portal HTML from the user's prompt. The tool writes the page into the host nginx web root as a device-specific HTML file, then updates the connected router so ApFree WiFiDog redirects users to that page.

The page should be self-contained HTML. Keep CSS and JavaScript inline unless you know the nginx web root will also serve extra assets.

## Configuration

| Setting            | Description                    | Default       |
| ------------------ | ------------------------------ | ------------- |
| `enabled`          | Enable bridge                  | `true`        |
| `bind`             | Bind address                   | `127.0.0.1`   |
| `port`             | Bridge port                    | `8001`        |
| `path`             | WebSocket path                 | `/ws/clawwrt` |
| `allowDeviceIds`   | Allowed device IDs (allowlist) | _(any)_       |
| `requestTimeoutMs` | Default request timeout (ms)   | `10000`       |
| `maxPayloadBytes`  | Max payload bytes              | `262144`      |
| `token`            | Device authentication token    | `clawwrt`     |
| `awasEnabled`      | Enable AWAS auth proxy         | `false`       |
| `awasHost`         | AWAS server hostname           | `127.0.0.1`   |
| `awasPort`         | AWAS server port               | `80`          |
| `awasPath`         | AWAS WebSocket path            | `/ws/clawwrt` |
| `awasSsl`          | Use TLS (wss://)               | `false`       |

### Tool allowlist note

If your OpenClaw config uses a restrictive tool profile such as:

```json
{
  "tools": {
    "profile": "coding"
  }
}
```

then the built-in `coding` profile only allows core coding tools by default. Plugin tools from `openclaw-wrt` are loaded, but they may not be callable by the agent unless you explicitly re-allow them.

Recommended configuration:

```json
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["openclaw-wrt"]
  }
}
```

Why this matters:

- `coding` is a core-tool allowlist, not a plugin-tool allowlist
- `alsoAllow: ["openclaw-wrt"]` expands to the tools registered by this plugin
- without it, the agent may recognize the plugin conceptually but fail to call tools such as `clawwrt_list_devices`, `clawwrt_get_status`, or `clawwrt_get_clients`

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Watch mode
pnpm dev
```

## License

MIT
