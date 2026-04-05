---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/device/notifications/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
title: "Nodes"
---

# Nodes

A **node** is a companion device (macOS/iOS/Android/headless) that connects to the Gateway **WebSocket** (same port as operators) with `role: "node"` and exposes a command surface (e.g. `canvas.*`, `camera.*`, `device.*`, `notifications.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).

Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL;
historical only for current nodes).

macOS can also run in **node mode**: the menubar app connects to the Gateway’s WS server and exposes its local canvas/camera commands as a node (so `mullusi nodes …` works against this Mac).

Notes:

- Nodes are **peripherals**, not gateways. They don’t run the gateway service.
- Telegram/WhatsApp/etc. messages land on the **gateway**, not on nodes.
- Troubleshooting runbook: [/nodes/troubleshooting](/nodes/troubleshooting)

## Pairing + status

**WS nodes use device pairing.** Nodes present a device identity during `connect`; the Gateway
creates a device pairing request for `role: node`. Approve via the devices CLI (or UI).

Quick CLI:

```bash
mullusi devices list
mullusi devices approve <requestId>
mullusi devices reject <requestId>
mullusi nodes status
mullusi nodes describe --node <idOrNameOrIp>
```

If a node retries with changed auth details (role/scopes/public key), the prior
pending request is superseded and a new `requestId` is created. Re-run
`mullusi devices list` before approving.

Notes:

- `nodes status` marks a node as **paired** when its device pairing role includes `node`.
- The device pairing record is the durable approved-role contract. Token
  rotation stays inside that contract; it cannot upgrade a paired node into a
  different role that pairing approval never granted.
- `node.pair.*` (CLI: `mullusi nodes pending/approve/reject/rename`) is a separate gateway-owned
  node pairing store; it does **not** gate the WS `connect` handshake.
- Approval scope follows the pending request's declared commands:
  - commandless request: `operator.pairing`
  - non-exec node commands: `operator.pairing` + `operator.write`
  - `system.run` / `system.run.prepare` / `system.which`: `operator.pairing` + `operator.admin`

## Remote node host (system.run)

Use a **node host** when your Gateway runs on one machine and you want commands
to execute on another. The model still talks to the **gateway**; the gateway
forwards `exec` calls to the **node host** when `host=node` is selected.

### What runs where

- **Gateway host**: receives messages, runs the model, routes tool calls.
- **Node host**: executes `system.run`/`system.which` on the node machine.
- **Approvals**: enforced on the node host via `~/.mullusi/exec-approvals.json`.

Approval note:

- Approval-backed node runs bind exact request context.
- For direct shell/runtime file executions, Mullusi also best-effort binds one concrete local
  file operand and denies the run if that file changes before execution.
- If Mullusi cannot identify exactly one concrete local file for an interpreter/runtime command,
  approval-backed execution is denied instead of pretending full runtime coverage. Use sandboxing,
  separate hosts, or an explicit trusted allowlist/full workflow for broader interpreter semantics.

### Start a node host (foreground)

On the node machine:

```bash
mullusi node run --host <gateway-host> --port 18790 --display-name "Build Node"
```

### Remote gateway via SSH tunnel (loopback bind)

If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode),
remote node hosts cannot connect directly. Create an SSH tunnel and point the
node host at the local end of the tunnel.

Example (node host -> gateway host):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18790
ssh -N -L 18790:127.0.0.1:18790 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export MULLUSI_GATEWAY_TOKEN="<gateway-token>"
mullusi node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notes:

- `mullusi node run` supports token or password auth.
- Env vars are preferred: `MULLUSI_GATEWAY_TOKEN` / `MULLUSI_GATEWAY_PASSWORD`.
- Config fallback is `gateway.auth.token` / `gateway.auth.password`.
- In local mode, node host intentionally ignores `gateway.remote.token` / `gateway.remote.password`.
- In remote mode, `gateway.remote.token` / `gateway.remote.password` are eligible per remote precedence rules.
- If active local `gateway.auth.*` SecretRefs are configured but unresolved, node-host auth fails closed.
- Node-host auth resolution only honors `MULLUSI_GATEWAY_*` env vars.

### Start a node host (service)

```bash
mullusi node install --host <gateway-host> --port 18790 --display-name "Build Node"
mullusi node restart
```

### Pair + name

On the gateway host:

```bash
mullusi devices list
mullusi devices approve <requestId>
mullusi nodes status
```

If the node retries with changed auth details, re-run `mullusi devices list`
and approve the current `requestId`.

Naming options:

- `--display-name` on `mullusi node run` / `mullusi node install` (persists in `~/.mullusi/node.json` on the node).
- `mullusi nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).

### Allowlist the commands

Exec approvals are **per node host**. Add allowlist entries from the gateway:

```bash
mullusi approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
mullusi approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Approvals live on the node host at `~/.mullusi/exec-approvals.json`.

### Point exec at the node

Configure defaults (gateway config):

```bash
mullusi config set tools.exec.host node
mullusi config set tools.exec.security allowlist
mullusi config set tools.exec.node "<id-or-name>"
```

Or per session:

```
/exec host=node security=allowlist node=<id-or-name>
```

Once set, any `exec` call with `host=node` runs on the node host (subject to the
node allowlist/approvals).

`host=auto` will not implicitly choose the node on its own, but an explicit per-call `host=node` request is allowed from `auto`. If you want node exec to be the default for the session, set `tools.exec.host=node` or `/exec host=node ...` explicitly.

Related:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## Invoking commands

Low-level (raw RPC):

```bash
mullusi nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.

## Screenshots (canvas snapshots)

If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.

CLI helper (writes to a temp file and prints `MEDIA:<path>`):

```bash
mullusi nodes canvas snapshot --node <idOrNameOrIp> --format png
mullusi nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Canvas controls

```bash
mullusi nodes canvas present --node <idOrNameOrIp> --target https://example.com
mullusi nodes canvas hide --node <idOrNameOrIp>
mullusi nodes canvas navigate https://example.com --node <idOrNameOrIp>
mullusi nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notes:

- `canvas present` accepts URLs or local file paths (`--target`), plus optional `--x/--y/--width/--height` for positioning.
- `canvas eval` accepts inline JS (`--js`) or a positional arg.

### A2UI (Canvas)

```bash
mullusi nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
mullusi nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
mullusi nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notes:

- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).

## Photos + videos (node camera)

Photos (`jpg`):

```bash
mullusi nodes camera list --node <idOrNameOrIp>
mullusi nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
mullusi nodes camera snap --node <idOrNameOrIp> --facing front
```

Video clips (`mp4`):

```bash
mullusi nodes camera clip --node <idOrNameOrIp> --duration 10s
mullusi nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notes:

- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.

## Screen recordings (nodes)

Supported nodes expose `screen.record` (mp4). Example:

```bash
mullusi nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
mullusi nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notes:

- `screen.record` availability depends on node platform.
- Screen recordings are clamped to `<= 60s`.
- `--no-audio` disables microphone capture on supported platforms.
- Use `--screen <index>` to select a display when multiple screens are available.

## Location (nodes)

Nodes expose `location.get` when Location is enabled in settings.

CLI helper:

```bash
mullusi nodes location get --node <idOrNameOrIp>
mullusi nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notes:

- Location is **off by default**.
- “Always” requires system permission; background fetch is best-effort.
- The response includes lat/lon, accuracy (meters), and timestamp.

## SMS (Android nodes)

Android nodes can expose `sms.send` when the user grants **SMS** permission and the device supports telephony.

Low-level invoke:

```bash
mullusi nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from Mullusi"}'
```

Notes:

- The permission prompt must be accepted on the Android device before the capability is advertised.
- Wi-Fi-only devices without telephony will not advertise `sms.send`.

## Android device + personal data commands

Android nodes can advertise additional command families when the corresponding capabilities are enabled.

Available families:

- `device.status`, `device.info`, `device.permissions`, `device.health`
- `notifications.list`, `notifications.actions`
- `photos.latest`
- `contacts.search`, `contacts.add`
- `calendar.events`, `calendar.add`
- `callLog.search`
- `sms.search`
- `motion.activity`, `motion.pedometer`

Example invokes:

```bash
mullusi nodes invoke --node <idOrNameOrIp> --command device.status --params '{}'
mullusi nodes invoke --node <idOrNameOrIp> --command notifications.list --params '{}'
mullusi nodes invoke --node <idOrNameOrIp> --command photos.latest --params '{"limit":1}'
```

Notes:

- Motion commands are capability-gated by available sensors.

## System commands (node host / mac node)

The macOS node exposes `system.run`, `system.notify`, and `system.execApprovals.get/set`.
The headless node host exposes `system.run`, `system.which`, and `system.execApprovals.get/set`.

Examples:

```bash
mullusi nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
mullusi nodes invoke --node <idOrNameOrIp> --command system.which --params '{"name":"git"}'
```

Notes:

- `system.run` returns stdout/stderr/exit code in the payload.
- Shell execution now goes through the `exec` tool with `host=node`; `nodes` remains the direct-RPC surface for explicit node commands.
- `nodes invoke` does not expose `system.run` or `system.run.prepare`; those stay on the exec path only.
- The exec path prepares a canonical `systemRunPlan` before approval. Once an
  approval is granted, the gateway forwards that stored plan, not any later
  caller-edited command/cwd/session fields.
- `system.notify` respects notification permission state on the macOS app.
- Unrecognized node `platform` / `deviceFamily` metadata uses a conservative default allowlist that excludes `system.run` and `system.which`. If you intentionally need those commands for an unknown platform, add them explicitly via `gateway.nodes.allowCommands`.
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.
- For shell wrappers (`bash|sh|zsh ... -c/-lc`), request-scoped `--env` values are reduced to an explicit allowlist (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`).
- For allow-always decisions in allowlist mode, known dispatch wrappers (`env`, `nice`, `nohup`, `stdbuf`, `timeout`) persist inner executable paths instead of wrapper paths. If unwrapping is not safe, no allowlist entry is persisted automatically.
- On Windows node hosts in allowlist mode, shell-wrapper runs via `cmd.exe /c` require approval (allowlist entry alone does not auto-allow the wrapper form).
- `system.notify` supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.
- Node hosts ignore `PATH` overrides and strip dangerous startup/shell keys (`DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`, `SHELLOPTS`, `PS4`). If you need extra PATH entries, configure the node host service environment (or install tools in standard locations) instead of passing `PATH` via `--env`.
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.
- On headless node host, `system.run` is gated by exec approvals (`~/.mullusi/exec-approvals.json`).

## Exec node binding

When multiple nodes are available, you can bind exec to a specific node.
This sets the default node for `exec host=node` (and can be overridden per agent).

Global default:

```bash
mullusi config set tools.exec.node "node-id-or-name"
```

Per-agent override:

```bash
mullusi config get agents.list
mullusi config set agents.list[0].tools.exec.node "node-id-or-name"
```

Unset to allow any node:

```bash
mullusi config unset tools.exec.node
mullusi config unset agents.list[0].tools.exec.node
```

## Permissions map

Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).

## Headless node host (cross-platform)

Mullusi can run a **headless node host** (no UI) that connects to the Gateway
WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows
or for running a minimal node alongside a server.

Start it:

```bash
mullusi node run --host <gateway-host> --port 18790
```

Notes:

- Pairing is still required (the Gateway will show a device pairing prompt).
- The node host stores its node id, token, display name, and gateway connection info in `~/.mullusi/node.json`.
- Exec approvals are enforced locally via `~/.mullusi/exec-approvals.json`
  (see [Exec approvals](/tools/exec-approvals)).
- On macOS, the headless node host executes `system.run` locally by default. Set
  `MULLUSI_NODE_EXEC_HOST=app` to route `system.run` through the companion app exec host; add
  `MULLUSI_NODE_EXEC_FALLBACK=0` to require the app host and fail closed if it is unavailable.
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.

## Mac node mode

- The macOS menubar app connects to the Gateway WS server as a node (so `mullusi nodes …` works against this Mac).
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.
