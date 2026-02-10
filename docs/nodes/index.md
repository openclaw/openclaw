---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pairing iOS/Android nodes to a gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Using node canvas/camera for agent context（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Adding new node commands or CLI helpers（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Nodes"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nodes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A **node** is a companion device (macOS/iOS/Android/headless) that connects to the Gateway **WebSocket** (same port as operators) with `role: "node"` and exposes a command surface (e.g. `canvas.*`, `camera.*`, `system.*`) via `node.invoke`. Protocol details: [Gateway protocol](/gateway/protocol).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Legacy transport: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; deprecated/removed for current nodes).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS can also run in **node mode**: the menubar app connects to the Gateway’s WS server and exposes its local canvas/camera commands as a node (so `openclaw nodes …` works against this Mac).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes are **peripherals**, not gateways. They don’t run the gateway service.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram/WhatsApp/etc. messages land on the **gateway**, not on nodes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Troubleshooting runbook: [/nodes/troubleshooting](/nodes/troubleshooting)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Pairing + status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**WS nodes use device pairing.** Nodes present a device identity during `connect`; the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
creates a device pairing request for `role: node`. Approve via the devices CLI (or UI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick CLI:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw devices reject <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes describe --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `nodes status` marks a node as **paired** when its device pairing role includes `node`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) is a separate gateway-owned（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  node pairing store; it does **not** gate the WS `connect` handshake.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote node host (system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use a **node host** when your Gateway runs on one machine and you want commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
to execute on another. The model still talks to the **gateway**; the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
forwards `exec` calls to the **node host** when `host=node` is selected.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### What runs where（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Gateway host**: receives messages, runs the model, routes tool calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Node host**: executes `system.run`/`system.which` on the node machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Approvals**: enforced on the node host via `~/.openclaw/exec-approvals.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Start a node host (foreground)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On the node machine:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Remote gateway via SSH tunnel (loopback bind)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the Gateway binds to loopback (`gateway.bind=loopback`, default in local mode),（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
remote node hosts cannot connect directly. Create an SSH tunnel and point the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node host at the local end of the tunnel.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (node host -> gateway host):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Terminal B: export the gateway token and connect through the tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The token is `gateway.auth.token` from the gateway config (`~/.openclaw/openclaw.json` on the gateway host).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw node run` reads `OPENCLAW_GATEWAY_TOKEN` for auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Start a node host (service)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node restart（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Pair + name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On the gateway host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Naming options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--display-name` on `openclaw node run` / `openclaw node install` (persists in `~/.openclaw/node.json` on the node).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (gateway override).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allowlist the commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Exec approvals are **per node host**. Add allowlist entries from the gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Approvals live on the node host at `~/.openclaw/exec-approvals.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Point exec at the node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configure defaults (gateway config):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set tools.exec.host node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set tools.exec.security allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set tools.exec.node "<id-or-name>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or per session:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
/exec host=node security=allowlist node=<id-or-name>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Once set, any `exec` call with `host=node` runs on the node host (subject to the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
node allowlist/approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Related:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Node host CLI](/cli/node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec tool](/tools/exec)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Exec approvals](/tools/exec-approvals)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Invoking commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Low-level (raw RPC):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Higher-level helpers exist for the common “give the agent a MEDIA attachment” workflows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Screenshots (canvas snapshots)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the node is showing the Canvas (WebView), `canvas.snapshot` returns `{ format, base64 }`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI helper (writes to a temp file and prints `MEDIA:<path>`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Canvas controls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas hide --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvas present` accepts URLs or local file paths (`--target`), plus optional `--x/--y/--width/--height` for positioning.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvas eval` accepts inline JS (`--js`) or a positional arg.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### A2UI (Canvas)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Only A2UI v0.8 JSONL is supported (v0.9/createSurface is rejected).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Photos + videos (node camera)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Photos (`jpg`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera list --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera snap --node <idOrNameOrIp> --facing front（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Video clips (`mp4`):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The node must be **foregrounded** for `canvas.*` and `camera.*` (background calls return `NODE_BACKGROUND_UNAVAILABLE`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clip duration is clamped (currently `<= 60s`) to avoid oversized base64 payloads.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android will prompt for `CAMERA`/`RECORD_AUDIO` permissions when possible; denied permissions fail with `*_PERMISSION_REQUIRED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Screen recordings (nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes expose `screen.record` (mp4). Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `screen.record` requires the node app to be foregrounded.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android will show the system screen-capture prompt before recording.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Screen recordings are clamped to `<= 60s`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--no-audio` disables microphone capture (supported on iOS/Android; macOS uses system capture audio).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--screen <index>` to select a display when multiple screens are available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Location (nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes expose `location.get` when Location is enabled in settings.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
CLI helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes location get --node <idOrNameOrIp>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Location is **off by default**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “Always” requires system permission; background fetch is best-effort.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The response includes lat/lon, accuracy (meters), and timestamp.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## SMS (Android nodes)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Android nodes can expose `sms.send` when the user grants **SMS** permission and the device supports telephony.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Low-level invoke:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The permission prompt must be accepted on the Android device before the capability is advertised.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Wi-Fi-only devices without telephony will not advertise `sms.send`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System commands (node host / mac node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS node exposes `system.run`, `system.notify`, and `system.execApprovals.get/set`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The headless node host exposes `system.run`, `system.which`, and `system.execApprovals.get/set`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Examples:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.run` returns stdout/stderr/exit code in the payload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.notify` respects notification permission state on the macOS app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.run` supports `--cwd`, `--env KEY=VAL`, `--command-timeout`, and `--needs-screen-recording`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.notify` supports `--priority <passive|active|timeSensitive>` and `--delivery <system|overlay|auto>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS nodes drop `PATH` overrides; headless node hosts only accept `PATH` when it prepends the node host PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On macOS node mode, `system.run` is gated by exec approvals in the macOS app (Settings → Exec approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Ask/allowlist/full behave the same as the headless node host; denied prompts return `SYSTEM_RUN_DENIED`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On headless node host, `system.run` is gated by exec approvals (`~/.openclaw/exec-approvals.json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec node binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When multiple nodes are available, you can bind exec to a specific node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This sets the default node for `exec host=node` (and can be overridden per agent).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Global default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set tools.exec.node "node-id-or-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Per-agent override:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config get agents.list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Unset to allow any node:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config unset tools.exec.node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw config unset agents.list[0].tools.exec.node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Nodes may include a `permissions` map in `node.list` / `node.describe`, keyed by permission name (e.g. `screenRecording`, `accessibility`) with boolean values (`true` = granted).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Headless node host (cross-platform)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw can run a **headless node host** (no UI) that connects to the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WebSocket and exposes `system.run` / `system.which`. This is useful on Linux/Windows（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or for running a minimal node alongside a server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Start it:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw node run --host <gateway-host> --port 18789（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Pairing is still required (the Gateway will show a node approval prompt).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The node host stores its node id, token, display name, and gateway connection info in `~/.openclaw/node.json`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exec approvals are enforced locally via `~/.openclaw/exec-approvals.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (see [Exec approvals](/tools/exec-approvals)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On macOS, the headless node host prefers the companion app exec host when reachable and falls（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  back to local execution if the app is unavailable. Set `OPENCLAW_NODE_EXEC_HOST=app` to require（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  the app, or `OPENCLAW_NODE_EXEC_FALLBACK=0` to disable fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add `--tls` / `--tls-fingerprint` when the Gateway WS uses TLS.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Mac node mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The macOS menubar app connects to the Gateway WS server as a node (so `openclaw nodes …` works against this Mac).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- In remote mode, the app opens an SSH tunnel for the Gateway port and connects to `localhost`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
