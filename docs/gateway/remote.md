---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Remote access using SSH tunnels (Gateway WS) and tailnets"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Running or troubleshooting remote gateway setups（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Remote Access"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Remote access (SSH, tunnels, and tailnets)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This repo supports “remote over SSH” by keeping a single Gateway (the master) running on a dedicated host (desktop/server) and connecting clients to it.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For **operators (you / the macOS app)**: SSH tunneling is the universal fallback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For **nodes (iOS/Android and future devices)**: connect to the Gateway **WebSocket** (LAN/tailnet or SSH tunnel as needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The core idea（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The Gateway WebSocket binds to **loopback** on your configured port (defaults to 18789).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For remote use, you forward that loopback port over SSH (or use a tailnet/VPN and tunnel less).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Common VPN/tailnet setups (where the agent lives)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Think of the **Gateway host** as “where the agent lives.” It owns sessions, auth profiles, channels, and state.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Your laptop/desktop (and nodes) connect to that host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 1) Always-on Gateway in your tailnet (VPS or home server)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Run the Gateway on a persistent host and reach it via **Tailscale** or SSH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Best UX:** keep `gateway.bind: "loopback"` and use **Tailscale Serve** for the Control UI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Fallback:** keep loopback + SSH tunnel from any machine that needs access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Examples:** [exe.dev](/install/exe-dev) (easy VM) or [Hetzner](/install/hetzner) (production VPS).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This is ideal when your laptop sleeps often but you want the agent always-on.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 2) Home desktop runs the Gateway, laptop is remote control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The laptop does **not** run the agent. It connects remotely:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use the macOS app’s **Remote over SSH** mode (Settings → General → “OpenClaw runs”).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The app opens and manages the tunnel, so WebChat + health checks “just work.”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runbook: [macOS remote access](/platforms/mac/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### 3) Laptop runs the Gateway, remote access from other machines（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Keep the Gateway local but expose it safely:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- SSH tunnel to the laptop from other machines, or（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Tailscale Serve the Control UI and keep the Gateway loopback-only.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Guide: [Tailscale](/gateway/tailscale) and [Web overview](/web).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Command flow (what runs where)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
One gateway service owns state + channels. Nodes are peripherals.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Flow example (Telegram → node):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Telegram message arrives at the **Gateway**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway runs the **agent** and decides whether to call a node tool.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gateway calls the **node** over the Gateway WebSocket (`node.*` RPC).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Node returns the result; Gateway replies back out to Telegram.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Nodes do not run the gateway service.** Only one gateway should run per host unless you intentionally run isolated profiles (see [Multiple gateways](/gateway/multiple-gateways)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- macOS app “node mode” is just a node client over the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## SSH tunnel (CLI + tools)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Create a local tunnel to the remote Gateway WS:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ssh -N -L 18789:127.0.0.1:18789 user@host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
With the tunnel up:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw health` and `openclaw status --deep` now reach the remote gateway via `ws://127.0.0.1:18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openclaw gateway {status,health,send,agent,call}` can also target the forwarded URL via `--url` when needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: replace `18789` with your configured `gateway.port` (or `--port`/`OPENCLAW_GATEWAY_PORT`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Note: when you pass `--url`, the CLI does not fall back to config or environment credentials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Include `--token` or `--password` explicitly. Missing explicit credentials is an error.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## CLI remote defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You can persist a remote target so CLI commands use it by default:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    mode: "remote",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    remote: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      url: "ws://127.0.0.1:18789",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      token: "your-token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the gateway is loopback-only, keep the URL at `ws://127.0.0.1:18789` and open the SSH tunnel first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Chat UI over SSH（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
WebChat no longer uses a separate HTTP port. The SwiftUI chat UI connects directly to the Gateway WebSocket.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Forward `18789` over SSH (see above), then connect clients to `ws://127.0.0.1:18789`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- On macOS, prefer the app’s “Remote over SSH” mode, which manages the tunnel automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS app “Remote over SSH”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS menu bar app can drive the same setup end-to-end (remote status checks, WebChat, and Voice Wake forwarding).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Runbook: [macOS remote access](/platforms/mac/remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security rules (remote/VPN)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Short version: **keep the Gateway loopback-only** unless you’re sure you need a bind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Loopback + SSH/Tailscale Serve** is the safest default (no public exposure).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Non-loopback binds** (`lan`/`tailnet`/`custom`, or `auto` when loopback is unavailable) must use auth tokens/passwords.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.token` is **only** for remote CLI calls — it does **not** enable local auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gateway.remote.tlsFingerprint` pins the remote TLS cert when using `wss://`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tailscale Serve** can authenticate via identity headers when `gateway.auth.allowTailscale: true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Set it to `false` if you want tokens/passwords instead.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Treat browser control like operator access: tailnet-only + deliberate node pairing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deep dive: [Security](/gateway/security).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
