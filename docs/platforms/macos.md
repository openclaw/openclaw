---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw macOS companion app (menu bar + gateway broker)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Implementing macOS app features（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Changing gateway lifecycle or node bridging on macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS App"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw macOS Companion (menu bar + gateway broker)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app is the **menu‑bar companion** for OpenClaw. It owns permissions,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
manages/attaches to the Gateway locally (launchd or manual), and exposes macOS（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
capabilities to the agent as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it does（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Shows native notifications and status in the menu bar.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Owns TCC prompts (Notifications, Accessibility, Screen Recording, Microphone,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Speech Recognition, Automation/AppleScript).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Runs or connects to the Gateway (local or remote).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Exposes macOS‑only tools (Canvas, Camera, Screen Recording, `system.run`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Starts the local node host service in **remote** mode (launchd), and stops it in **local** mode.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Optionally hosts **PeekabooBridge** for UI automation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Installs the global CLI (`openclaw`) via npm/pnpm on request (bun not recommended for the Gateway runtime).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Local vs remote mode（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local** (default): the app attaches to a running local Gateway if present;（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  otherwise it enables the launchd service via `openclaw gateway install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote**: the app connects to a Gateway over SSH/Tailscale and never starts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  a local process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The app starts the local **node host service** so the remote Gateway can reach this Mac.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  The app does not spawn the Gateway as a child process.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Launchd control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The app manages a per‑user LaunchAgent labeled `bot.molt.gateway`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
(or `bot.molt.<profile>` when using `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.*` still unloads).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl kickstart -k gui/$UID/bot.molt.gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
launchctl bootout gui/$UID/bot.molt.gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Replace the label with `bot.molt.<profile>` when running a named profile.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the LaunchAgent isn’t installed, enable it from the app or run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`openclaw gateway install`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Node capabilities (mac)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The macOS app presents itself as a node. Common commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Camera: `camera.snap`, `camera.clip`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Screen: `screen.record`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- System: `system.run`, `system.notify`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The node reports a `permissions` map so agents can decide what’s allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Node service + app IPC:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When the headless node host service is running (remote mode), it connects to the Gateway WS as a node.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.run` executes in the macOS app (UI/TCC context) over a local Unix socket; prompts + output stay in-app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Diagram (SCI):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Gateway -> Node Service (WS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 |  IPC (UDS + token + HMAC + TTL)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
                 v（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
             Mac App (UI + TCC + system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Exec approvals (system.run)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`system.run` is controlled by **Exec approvals** in the macOS app (Settings → Exec approvals).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Security + ask + allowlist are stored locally on the Mac in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
~/.openclaw/exec-approvals.json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "version": 1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "defaults": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "security": "deny",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "ask": "on-miss"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  "agents": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "main": {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "security": "allowlist",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "ask": "on-miss",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowlist` entries are glob patterns for resolved binary paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Choosing “Always Allow” in the prompt adds that command to the allowlist.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `system.run` environment overrides are filtered (drops `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) and then merged with the app’s environment.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Deep links（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The app registers the `openclaw://` URL scheme for local actions.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### `openclaw://agent`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Triggers a Gateway `agent` request.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
open 'openclaw://agent?message=Hello%20from%20deep%20link'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Query parameters:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `message` (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sessionKey` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `thinking` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `deliver` / `to` / `channel` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `timeoutSeconds` (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `key` (optional unattended mode key)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Safety:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Without `key`, the app prompts for confirmation.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- With a valid `key`, the run is unattended (intended for personal automations).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Onboarding flow (typical)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Install and launch **OpenClaw.app**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Complete the permissions checklist (TCC prompts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Ensure **Local** mode is active and the Gateway is running.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Install the CLI if you want terminal access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build & dev workflow (native)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `cd apps/macos && swift build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `swift run OpenClaw` (or Xcode)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Package app: `scripts/package-mac-app.sh`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Debug gateway connectivity (macOS CLI)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the debug CLI to exercise the same Gateway WebSocket handshake and discovery（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
logic that the macOS app uses, without launching the app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
cd apps/macos（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run openclaw-mac connect --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
swift run openclaw-mac discover --timeout 3000 --json（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Connect options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--url <ws://host:port>`: override config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--mode <local|remote>`: resolve from config (default: config or local)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--probe`: force a fresh health probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: request timeout (default: `15000`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: structured output for diffing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Discovery options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--include-local`: include gateways that would be filtered as “local”（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--timeout <ms>`: overall discovery window (default: `2000`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--json`: structured output for diffing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tip: compare against `openclaw gateway discover --json` to see whether the（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
macOS app’s discovery pipeline (NWBrowser + tailnet DNS‑SD fallback) differs from（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
the Node CLI’s `dns-sd` based discovery.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Remote connection plumbing (SSH tunnels)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the macOS app runs in **Remote** mode, it opens an SSH tunnel so local UI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
components can talk to a remote Gateway as if it were on localhost.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control tunnel (Gateway WebSocket port)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Purpose:** health checks, status, Web Chat, config, and other control-plane calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Local port:** the Gateway port (default `18789`), always stable.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Remote port:** the same Gateway port on the remote host.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Behavior:** no random local port; the app reuses an existing healthy tunnel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  or restarts it if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **SSH shape:** `ssh -N -L <local>:127.0.0.1:<remote>` with BatchMode +（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ExitOnForwardFailure + keepalive options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **IP reporting:** the SSH tunnel uses loopback, so the gateway will see the node（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  IP as `127.0.0.1`. Use **Direct (ws/wss)** transport if you want the real client（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  IP to appear (see [macOS remote access](/platforms/mac/remote)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For setup steps, see [macOS remote access](/platforms/mac/remote). For protocol（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
details, see [Gateway protocol](/gateway/protocol).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Related docs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway runbook](/gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Gateway (macOS)](/platforms/mac/bundled-gateway)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [macOS permissions](/platforms/mac/permissions)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [Canvas](/platforms/mac/canvas)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
