---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Gateway runtime on macOS (external launchd service)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Packaging OpenClaw.app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging the macOS gateway launchd service（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Installing the gateway CLI for macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Gateway on macOS"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Gateway on macOS (external launchd)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw.app no longer bundles Node/Bun or the Gateway runtime. The macOS app（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
expects an **external** `openclaw` CLI install, does not spawn the Gateway as a（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
child process, and manages a per‑user launchd service to keep the Gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
running (or attaches to an existing local Gateway if one is already running).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install the CLI (required for local mode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
You need Node 22+ on the Mac, then install `openclaw` globally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
npm install -g openclaw@<version>（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app’s **Install CLI** button runs the same flow via npm/pnpm (bun not recommended for Gateway runtime).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Launchd (Gateway as LaunchAgent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Label:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.openclaw.*` may remain)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Plist location (per‑user):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `~/Library/LaunchAgents/bot.molt.gateway.plist`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  (or `~/Library/LaunchAgents/bot.molt.<profile>.plist`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Manager:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The macOS app owns LaunchAgent install/update in Local mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- The CLI can also install it: `openclaw gateway install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Behavior:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- “OpenClaw Active” enables/disables the LaunchAgent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- App quit does **not** stop the gateway (launchd keeps it alive).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If a Gateway is already running on the configured port, the app attaches to（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  it instead of starting a new one.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Logging:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Version compatibility（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app checks the gateway version against its own version. If they’re（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
incompatible, update the global CLI to match the app version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Smoke check（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw --version（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_SKIP_CHANNELS=1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_SKIP_CANVAS_HOST=1 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway --port 18999 --bind loopback（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
