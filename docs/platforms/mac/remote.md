---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "macOS app flow for controlling a remote OpenClaw gateway over SSH"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up or debugging remote mac control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Remote Control"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Remote OpenClaw (macOS ⇄ remote host)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This flow lets the macOS app act as a full remote control for a OpenClaw gateway running on another host (desktop/server). It’s the app’s **Remote over SSH** (remote run) feature. All features—health checks, Voice Wake forwarding, and Web Chat—reuse the same remote SSH configuration from _Settings → General_.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Modes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local (this Mac)**: Everything runs on the laptop. No SSH involved.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote over SSH (default)**: OpenClaw commands are executed on the remote host. The mac app opens an SSH connection with `-o BatchMode` plus your chosen identity/key and a local port-forward.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote direct (ws/wss)**: No SSH tunnel. The mac app connects to the gateway URL directly (for example, via Tailscale Serve or a public HTTPS reverse proxy).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote transports（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Remote mode supports two transports:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH tunnel** (default): Uses `ssh -N -L ...` to forward the gateway port to localhost. The gateway will see the node’s IP as `127.0.0.1` because the tunnel is loopback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Direct (ws/wss)**: Connects straight to the gateway URL. The gateway sees the real client IP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prereqs on the remote host（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install Node + pnpm and build/install the OpenClaw CLI (`pnpm install && pnpm build && pnpm link --global`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Ensure `openclaw` is on PATH for non-interactive shells (symlink into `/usr/local/bin` or `/opt/homebrew/bin` if needed).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Open SSH with key auth. We recommend **Tailscale** IPs for stable reachability off-LAN.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## macOS app setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Open _Settings → General_.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Under **OpenClaw runs**, pick **Remote over SSH** and set:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Transport**: **SSH tunnel** or **Direct (ws/wss)**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **SSH target**: `user@host` (optional `:port`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
     - If the gateway is on the same LAN and advertises Bonjour, pick it from the discovered list to auto-fill this field.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Gateway URL** (Direct only): `wss://gateway.example.ts.net` (or `ws://...` for local/LAN).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Identity file** (advanced): path to your key.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **Project root** (advanced): remote checkout path used for commands.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - **CLI path** (advanced): optional path to a runnable `openclaw` entrypoint/binary (auto-filled when advertised).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Hit **Test remote**. Success indicates the remote `openclaw status --json` runs correctly. Failures usually mean PATH/CLI issues; exit 127 means the CLI isn’t found remotely.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Health checks and Web Chat will now run through this SSH tunnel automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Web Chat（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH tunnel**: Web Chat connects to the gateway over the forwarded WebSocket control port (default 18789).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Direct (ws/wss)**: Web Chat connects straight to the configured gateway URL.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- There is no separate WebChat HTTP server anymore.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Permissions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The remote host needs the same TCC approvals as local (Automation, Accessibility, Screen Recording, Microphone, Speech Recognition, Notifications). Run onboarding on that machine to grant them once.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Nodes advertise their permission state via `node.list` / `node.describe` so agents know what’s available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Security notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer loopback binds on the remote host and connect via SSH or Tailscale.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If you bind the Gateway to a non-loopback interface, require token/password auth.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- See [Security](/gateway/security) and [Tailscale](/gateway/tailscale).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## WhatsApp login flow (remote)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Run `openclaw channels login --verbose` **on the remote host**. Scan the QR with WhatsApp on your phone.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Re-run login on that host if auth expires. Health check will surface link problems.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **exit 127 / not found**: `openclaw` isn’t on PATH for non-login shells. Add it to `/etc/paths`, your shell rc, or symlink into `/usr/local/bin`/`/opt/homebrew/bin`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Health probe failed**: check SSH reachability, PATH, and that Baileys is logged in (`openclaw status --json`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Web Chat stuck**: confirm the gateway is running on the remote host and the forwarded port matches the gateway WS port; the UI requires a healthy WS connection.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Node IP shows 127.0.0.1**: expected with the SSH tunnel. Switch **Transport** to **Direct (ws/wss)** if you want the gateway to see the real client IP.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Voice Wake**: trigger phrases are forwarded automatically in remote mode; no separate forwarder is needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notification sounds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Pick sounds per notification from scripts with `openclaw` and `node.invoke`, e.g.:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw nodes notify --node <id> --title "Ping" --body "Remote gateway ready" --sound Glass（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
There is no global “default sound” toggle in the app anymore; callers choose a sound (or none) per request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
