---
summary: "Gateway runtime on macOS (launchd default, optional child mode)"
read_when:
  - Packaging OpenClaw.app
  - Debugging the macOS gateway launchd service
  - Installing the gateway CLI for macOS
title: "Gateway on macOS"
---

# Gateway on macOS

OpenClaw.app no longer bundles Node/Bun or the Gateway runtime. The macOS app
expects an **external** `openclaw` CLI install.

For Local mode, OpenClaw supports two launch strategies:

| Mode      | Default     | Supervision                         | Permission context            |
| --------- | ----------- | ----------------------------------- | ----------------------------- |
| `launchd` | Yes         | Persistent/background (LaunchAgent) | launchd service process       |
| `child`   | No (opt-in) | Bound to OpenClaw app lifecycle     | inherits OpenClaw app context |

## Install the CLI (required for local mode)

You need Node 22+ on the Mac, then install `openclaw` globally:

```bash
npm install -g openclaw@<version>
```

The macOS app’s **Install CLI** button runs the same flow via npm/pnpm (bun not recommended for Gateway runtime).

## Launchd mode (default)

Label:

- `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.openclaw.*` may remain)

Plist location (per‑user):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (or `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Manager:

- The macOS app owns LaunchAgent install/update in Local mode.
- The CLI can also install it: `openclaw gateway install`.

Behavior:

- “OpenClaw Active” enables/disables the LaunchAgent.
- App quit does **not** stop the gateway (launchd keeps it alive).
- If a Gateway is already running on the configured port, the app attaches to
  it instead of starting a new one.
- Switching from child mode back to launchd clears the attach-only marker automatically.

Logging:

- launchd stdout/err: `/tmp/openclaw/openclaw-gateway.log`

## Child mode (opt-in)

When enabled in **Settings > General > Gateway runtime**, OpenClaw starts
`openclaw gateway --port <port> --bind <bind> --allow-unconfigured` as a child process.

Behavior:

- OpenClaw performs an auth preflight before child spawn. If local token auth is
  missing, it auto-repairs `gateway.auth.token` (reuse when available, otherwise
  generate + persist) so restarts do not require manual token commands.
- Child process is supervised by the app with bounded restart backoff.
- If the child exits repeatedly, OpenClaw surfaces a failed state instead of infinite restarts.
- On quit, OpenClaw prompts:
  - Stop child gateway and quit
  - Hand off to launchd and quit
  - Cancel
- Prompt supports “Remember my choice”.

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
