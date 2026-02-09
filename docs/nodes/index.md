---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
title: "Nodes"
---

# Nodes

A **node** is a companion device (macOS/iOS/Android/headless) that connects to the Gateway **WebSocket** (same port as operators) with `role: "node"` and exposes a command surface (e.g. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; deprecated/removed for current nodes).

macOS can also run in **node mode**: the menubar app connects to the Gateway’s WS server and exposes its local canvas/camera commands as a node (so `EasyHub nodes …` works against this Mac).

Notes:

- Nodes are **peripherals**, not gateways. They don’t run the gateway service.
- Telegram/WhatsApp/etc. messages land on the **gateway**, not on nodes.
- Troubleshooting runbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

**WS nodes use device pairing.** Nodes present a device identity during `connect`; the Gateway
creates a device pairing request for `role: node`. Approve via the devices CLI (or UI).

Quick CLI:

```bash
EasyHub devices list
EasyHub devices approve <requestId>
EasyHub devices reject <requestId>
EasyHub nodes status
EasyHub nodes describe --node <idOrNameOrIp>
```

Notes:

- `nodes status` marks a node as **paired** when its device pairing role includes `node`.
- `node.pair.*` (CLI: `EasyHub nodes pending/approve/reject`) is a separate gateway-owned
  node pairing store; it does **not** gate the WS `connect` handshake.

## Remote node host (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands
to execute on another. The model still talks to the **gateway**; the gateway
forwards `exec` calls to the **node host** when `host=node` is selected.

### What runs where

- **Gateway host**: receives messages, runs the model, routes tool calls.
- **Node host**: executes `system.run`/`system.which` on the node machine.
- **Approvals**: enforced on the node host via `~/.easyhub/exec-approvals.json`.

### Start a node host (foreground)

On the node machine:

```bash
EasyHub node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Remote gateway via SSH tunnel (loopback bind)

If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode),
remote node hosts cannot connect directly. Create an SSH tunnel and point the
node host at the local end of the tunnel.

Example (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export EASYHUB_GATEWAY_TOKEN="<gateway-token>"
EasyHub node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notes:

- The token is `gateway.auth.token` from the gateway config (`~/.easyhub/easyhub.json` on the gateway host).
- `EasyHub node run` reads `EASYHUB_GATEWAY_TOKEN` for auth.

### Start a node host (service)

```bash
EasyHub node install --host <gateway-host> --port 18789 --display-name "Build Node"
EasyHub node restart
```

### Pair + name

On the gateway host:

```bash
EasyHub nodes pending
EasyHub nodes approve <requestId>
EasyHub nodes list
```

Naming options:

- `--display-name` on `EasyHub node run` / `EasyHub node install` (persists in `~/.easyhub/node.json` on the node).
- `EasyHub nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
EasyHub approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
EasyHub approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host at `~/.easyhub/exec-approvals.json`.

### Point exec at the node

Configure defaults (gateway config):

```bash
EasyHub config set tools.exec.host node
EasyHub config set tools.exec.security allowlist
EasyHub config set tools.exec.node "<id-or-name>"
```

Or per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the
node allowlist/approvals).

Related:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

Low-level (raw RPC):

```bash
EasyHub nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints `MEDIA:<path>`):

```bash
EasyHub nodes canvas snapshot --node <idOrNameOrIp> --format png
EasyHub nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
EasyHub nodes canvas present --node <idOrNameOrIp> --target https://example.com
EasyHub nodes canvas hide --node <idOrNameOrIp>
EasyHub nodes canvas navigate https://example.com --node <idOrNameOrIp>
EasyHub nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes:

- `canvas present` accepts URLs or local file paths (`--target`), plus optional `--x/--y/--width/--height` for positioning.
- `canvas eval` accepts inline JS (`--js`) or a positional arg.

### A2UI (Canvas)

```bash
EasyHub nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
EasyHub nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
EasyHub nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes:

- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).

## Photos + videos (node camera)

Photos (`jpg`):

```bash
EasyHub nodes camera list --node <idOrNameOrIp>
EasyHub nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
EasyHub nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
EasyHub nodes camera clip --node <idOrNameOrIp> --duration 10s
EasyHub nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:

- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Nodes expose `screen.record` (mp4). Example:

```bash
EasyHub nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
EasyHub nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:

- `screen.record` requires the node app to be foregrounded.
- Android will show the system screen-capture prompt before recording.
- Screen recordings are clamped to `<= 60s`.
- `--no-audio` disables microphone capture (supported on iOS/Android; macOS uses system capture audio).
- Use `--screen <index>` to select a display when multiple screens are available.

## Location (nodes)

Nodes expose `location.get` when Location is enabled in settings.

CLI helper:

```bash
EasyHub nodes location get --node <idOrNameOrIp>
EasyHub nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:

- Location is **off by default**.
- “Always” requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.

## SMS (Android nodes)

Android nodes can expose `sms.send` when the user grants **SMS** permission and the device supports telephony.

Low-level invoke:

```bash
EasyHub nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from EasyHub"}'
```

Notes:

- The permission prompt must be accepted on the Android device before the capability is advertised.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.

## System commands (node host / mac node)

The macOS node exposes `system.run`, `system.notify`, and `system.execApprovals.get/set`.
The headless node host exposes `system.run`, `system.which`, and `system.execApprovals.get/set`.

Examples:

```bash
EasyHub nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
EasyHub nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notes:

- `system.run` returns stdout/stderr/exit code in the payload.
- `system.notify` respects notification permission state on the macOS app.
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.
- `system.notify` supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- macOS nodes drop `PATH` overrides; headless node hosts only accept `PATH` when it prepends the node host PATH.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by exec approvals (`~/.easyhub/exec-approvals.json`).

## Exec node binding

When multiple nodes are available, you can bind exec to a specific node.
This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
EasyHub config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
EasyHub config get agents.list
EasyHub config set agents.list[0].tools.exec.node "node-id-or-name"
```

Unset to allow any node:

```bash
EasyHub config unset tools.exec.node
EasyHub config unset agents.list[0].tools.exec.node
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).

## Headless node host (cross-platform)

EasyHub can run a **headless node host** (no UI) that connects to the Gateway
WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows
or for running a minimal node alongside a server.

Start it:

```bash
EasyHub node run --host <gateway-host> --port 18789
```

Notes:

- Pairing is still required (the Gateway will show a node approval prompt).
- The node host stores its node id, token, display name, and gateway connection info in `~/.easyhub/node.json`.
- Exec approvals are enforced locally via `~/.easyhub/exec-approvals.json`
  (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host prefers the companion app exec host when reachable and falls
  back to local execution if the app is unavailable. Set `EASYHUB_NODE_EXEC_HOST=app` to require
  the app, or `EASYHUB_NODE_EXEC_FALLBACK=0` to disable fallback.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `EasyHub nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
