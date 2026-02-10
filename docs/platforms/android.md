---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Android app (node): connection runbook + Canvas/Chat/Camera"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Pairing or reconnecting the Android node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging Android gateway discovery or auth（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Verifying chat history parity across clients（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Android App"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Android App (Node)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Support snapshot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Role: companion node app (Android does not host the Gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway required: yes (run it on macOS, Linux, or Windows via WSL2).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Install: [Getting Started](/start/getting-started) + [Pairing](/gateway/pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway: [Runbook](/gateway) + [Configuration](/gateway/configuration).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Protocols: [Gateway protocol](/gateway/protocol) (nodes + control plane).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## System control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
System control (launchd/systemd) lives on the Gateway host. See [Gateway](/gateway).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Connection Runbook（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Android node app ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Android connects directly to the Gateway WebSocket (default `ws://<host>:18789`) and uses Gateway-owned pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Prerequisites（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can run the Gateway on the “master” machine.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Android device/emulator can reach the gateway WebSocket:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Same LAN with mDNS/NSD, **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Same Tailscale tailnet using Wide-Area Bonjour / unicast DNS-SD (see below), **or**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Manual gateway host/port (fallback)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You can run the CLI (`openclaw`) on the gateway machine (or via SSH).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Start the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18789 --verbose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Confirm in logs you see something like:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `listening on ws://0.0.0.0:18789`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For tailnet-only setups (recommended for Vienna ⇄ London), bind the gateway to the tailnet IP:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `gateway.bind: "tailnet"` in `~/.openclaw/openclaw.json` on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Restart the Gateway / macOS menubar app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Verify discovery (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
From the gateway machine:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
dns-sd -B _openclaw-gw._tcp local.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
More debugging notes: [Bonjour](/gateway/bonjour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Tailnet (Vienna ⇄ London) discovery via unicast DNS-SD（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Android NSD/mDNS discovery won’t cross networks. If your Android node and the gateway are on different networks but connected via Tailscale, use Wide-Area Bonjour / unicast DNS-SD instead:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Set up a DNS-SD zone (example `openclaw.internal.`) on the gateway host and publish `_openclaw-gw._tcp` records.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Configure Tailscale split DNS for your chosen domain pointing at that DNS server.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details and example CoreDNS config: [Bonjour](/gateway/bonjour).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Connect from Android（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
In the Android app:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app keeps its gateway connection alive via a **foreground service** (persistent notification).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Open **Settings**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Under **Discovered Gateways**, select your gateway and hit **Connect**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If mDNS is blocked, use **Advanced → Manual Gateway** (host + port) and **Connect (Manual)**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After the first successful pairing, Android auto-reconnects on launch:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Manual endpoint (if enabled), otherwise（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The last discovered gateway (best-effort).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 4) Approve pairing (CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
On the gateway machine:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes pending（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes approve <requestId>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pairing details: [Gateway pairing](/gateway/pairing).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 5) Verify the node is connected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Via nodes status:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw nodes status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Via Gateway:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  openclaw gateway call node.list --params "{}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 6) Chat + history（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The Android node’s Chat sheet uses the gateway’s **primary session key** (`main`), so history and replies are shared with WebChat and other clients:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- History: `chat.history`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Send: `chat.send`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Push updates (best-effort): `chat.subscribe` → `event:"chat"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 7) Canvas + camera（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#### Gateway Canvas Host (recommended for web content)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want the node to show real HTML/CSS/JS that the agent can edit on disk, point the node at the Gateway canvas host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: nodes use the standalone canvas host on `canvasHost.port` (default `18793`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create `~/.openclaw/workspace/canvas/index.html` on the gateway host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Navigate the node to it (LAN):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tailnet (optional): if both devices are on Tailscale, use a MagicDNS name or tailnet IP instead of `.local`, e.g. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This server injects a live-reload client into HTML and reloads on file changes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The A2UI host lives at `http://<gateway-host>:18793/__openclaw__/a2ui/`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Canvas commands (foreground only):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (use `{"url":""}` or `{"url":"/"}` to return to the default scaffold). `canvas.snapshot` returns `{ format, base64 }` (default `format="jpeg"`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` legacy alias)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Camera commands (foreground only; permission-gated):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera.snap` (jpg)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `camera.clip` (mp4)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See [Camera node](/nodes/camera) for parameters and CLI helpers.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
