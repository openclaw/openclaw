---
summary: "Gateway runtime on macOS (external launchd service)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS (external launchd)

OpenClaw.app no longer bundles Node/Bun or the Gateway runtime. The macOS app
expects an **external** `openclaw` CLI install, does not spawn the Gateway as a
child process, and manages a per‑user launchd service to keep the Gateway
running (or attaches to an existing local Gateway if one is already running).

## Install the CLI (required for local mode)

Node 24 is the default runtime on the Mac. Node 22 LTS, currently `22.14+`, still works for compatibility. Then install `openclaw` globally:

```bash
npm install -g openclaw@<version>
```

The macOS app’s **Install CLI** button runs the same global install flow the app
uses internally: it prefers npm first, then pnpm, then bun if that is the only
detected package manager. Node remains the recommended Gateway runtime.

## Launchd (Gateway as LaunchAgent)

Label:

- `ai.openclaw.gateway` (or `ai.openclaw.<profile>`; legacy `com.openclaw.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/ai.openclaw.gateway.plist`
  (or `~/Library/LaunchAgents/ai.openclaw.<profile>.plist`)

Manager:

- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `openclaw gateway install`.

Behavior:

- “OpenClaw Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Version compatibility

The macOS app checks the gateway version against its own version. If they’re
incompatible, update the global CLI to match the app version.

## Smoke check

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Then:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```

## Optional: add a system-level recovery watchdog

`launchd` already restarts the Gateway when the process exits. That is usually
enough. If you run OpenClaw as an always-on local service and want an extra
recovery layer for "process is alive but unhealthy" cases, add a small
**separate** watchdog LaunchAgent.

Use this only if you understand the trade-offs:

- this is for **local macOS LaunchAgent** deployments, not containers or Linux services
- keep it **local-only** (`gateway.bind: "loopback"` is the safest default)
- probe health sparingly (for example every 30-60 seconds)
- prefer `openclaw doctor` first, then `openclaw doctor --fix`, then
  `openclaw gateway restart`
- avoid tight restart loops; let `launchd` handle ordinary crash restarts

For other environments, prefer the platform-native supervisor that OpenClaw
already documents:

- **Docker / containers**: use the built-in `HEALTHCHECK` + container restart policy
- **Linux systemd**: use `Restart=` policies on the user service

Example watchdog script:

```bash
#!/bin/zsh
set -euo pipefail

# launchd uses a minimal PATH. Replace this if your install lives elsewhere
# (for example nvm, pnpm, Homebrew on Apple Silicon, or a custom prefix).
OPENCLAW_BIN="${OPENCLAW_BIN:-/opt/homebrew/bin/openclaw}"

if "$OPENCLAW_BIN" health --json >/dev/null 2>&1; then
  exit 0
fi

"$OPENCLAW_BIN" doctor >/dev/null 2>&1 || true
"$OPENCLAW_BIN" doctor --fix >/dev/null 2>&1 || true
"$OPENCLAW_BIN" gateway restart >/dev/null 2>&1 || true
```

Before loading the watchdog, verify the binary path with `which openclaw` and
update `OPENCLAW_BIN` if needed.

Example LaunchAgent (`~/Library/LaunchAgents/ai.openclaw.gateway-watchdog.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>ai.openclaw.gateway-watchdog</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>/Users/YOU/.openclaw/bin/gateway-watchdog.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/openclaw/gateway-watchdog.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/openclaw/gateway-watchdog.log</string>
  </dict>
</plist>
```

Load it with:

```bash
launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway-watchdog.plist 2>/dev/null || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway-watchdog.plist
launchctl kickstart -k gui/$UID/ai.openclaw.gateway-watchdog
```

This is intentionally documented as an **operator-managed** safeguard rather
than a built-in feature. If you need productized watchdog behavior, open an
issue or discussion first so the recovery policy, thresholds, and platform
scope can be designed deliberately.
