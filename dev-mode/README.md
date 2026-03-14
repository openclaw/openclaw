# OpenClaw Dev Mode — Personal AI DEV Assistant

# Presenting - Dev Mode, Lowering Un-Necessary Security Features, back to fun level!

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.png">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.png" alt="OpenClaw" width="500">
    </picture>
</p>

## What have I done

[HTML with --dev-mode list](https://htmlpreview.github.io/?https://github.com/bresleveloper/openclaw-dev-mode/blob/main/dev-mode/yes.2026.03.06.html)

## How to install

### Prerequisites

- An existing OpenClaw installation (this fork is based on V2026.3.2)
- Node.js 22.12+
- Python 3 (for the Hub notification server)
- Git

### Installation (VPS / Linux)

```bash
# 1. Stop the gateway
openclaw gateway stop

# 2. Back up the existing openclaw installation
mv /usr/lib/node_modules/openclaw /usr/lib/node_modules/openclaw.bak

# 3. Clone the fork
git clone https://github.com/bresleveloper/openclaw-dev-mode.git /opt/openclaw-dev-mode

# 4. Install dependencies
cd /opt/openclaw-dev-mode
npm install --ignore-scripts

# 5. Symlink our fork into the original location
#    (required because the systemd gateway service points to /usr/lib/node_modules/openclaw/)
ln -s /opt/openclaw-dev-mode /usr/lib/node_modules/openclaw

# 6. Create a CLI wrapper
echo '#!/usr/bin/env bash' > /usr/local/bin/openclaw
echo 'set -euo pipefail' >> /usr/local/bin/openclaw
echo 'exec node /opt/openclaw-dev-mode/openclaw.mjs "$@"' >> /usr/local/bin/openclaw
chmod +x /usr/local/bin/openclaw

# 7. Enable dev mode
echo 'OPENCLAW_DEV_MODE=1' >> ~/.openclaw/.env

# 8. Start the gateway
openclaw gateway start
```

### Updating

```bash
cd /opt/openclaw-dev-mode && git pull && npm install --ignore-scripts && openclaw gateway restart
```

The `main` branch ships with pre-built `dist/`, so no build step is needed on the VPS. Just pull, install any new dependencies, and restart.

### Reverting to original openclaw

```bash
openclaw gateway stop
# Remove OPENCLAW_DEV_MODE=1 from ~/.openclaw/.env
sed -i '/OPENCLAW_DEV_MODE/d' ~/.openclaw/.env
rm /usr/lib/node_modules/openclaw
mv /usr/lib/node_modules/openclaw.bak /usr/lib/node_modules/openclaw
openclaw gateway start
```

### Verify it works

```bash
# Check env var is set
grep OPENCLAW_DEV_MODE ~/.openclaw/.env
# Should return: OPENCLAW_DEV_MODE=1

# Check config values are unredacted (API keys visible — means dev mode is active)
openclaw config get models.providers
```

## About

OpenClaw is AMAZING. And security is awesome for prod. And a hell of a buzz killer for dev/other situations.

I cloned, listed all security features (latest - V2026.3.2) and just added a simple flag to relax them:

```bash
# Add to ~/.openclaw/.env
OPENCLAW_DEV_MODE=1
```

Because the beauty of any opensource project is that it's MINE and I am allowed to enjoy it to its full extent.

## What dev-mode changes

| ID      | What it does                                                 |
| ------- | ------------------------------------------------------------ |
| SEC-15a | Lighter safety section in system prompt                      |
| SEC-27  | Channel metadata treated as trusted (no "UNTRUSTED" wrapper) |
| SEC-59  | Skip messaging profile default in onboarding                 |
| SEC-67  | Default compaction mode (no safeguard)                       |
| SEC-70  | Skip browser navigation URL checks                           |
| SEC-71  | 50MB web fetch cap (instead of 2MB)                          |
| SEC-72  | Unredacted config in CLI (API keys visible)                  |
| SEC-78  | No control plane rate limiting                               |
| SEC-79  | 50MB prompt cap (instead of 2MB)                             |
| SEC-80  | Skip hooks token uniqueness check                            |
| SEC-96  | All env vars passed through to child processes               |
| FIX-01  | Auto-bootstrap MEMORY.md in new workspaces                   |

## Hub notification plugin (optional)

Dev-mode includes a bundled Hub notification server that gives agents tools to send and receive notifications. It auto-starts on `127.0.0.1:10020` when dev-mode is active.

The Hub registers three agent tools: **hub_notify**, **hub_pending**, **hub_done**.

**How it works:** When a notification arrives (from a cron job, an app, or another agent), the Hub doesn't just store it — it forwards the notification through OpenClaw's `/v1/chat/completions` API. This means the notification enters the agent's active session as a real message, triggering a full cognitive response: the agent reasons about it using its system prompt, memory, and context, then delivers its response through the configured channel (WhatsApp, Telegram, etc.). The agent then calls `hub_done` to close the loop.

If you already run your own Hub server (e.g. on a different port), the auto-start will not interfere — it only spawns if port 10020 is free. You can also disable auto-start by removing or not running the bundled `server.py`, and point the plugin config at your existing hub instead.

### Changing the hub port

If your existing hub uses a different port, update your openclaw config to match:

```bash
openclaw config set plugins.hub.port 10021
```

### Full documentation

See the [Hub README](https://github.com/bresleveloper/openclaw-dev-mode/tree/main/dev-mode/hub) for the full API reference, setup guide, and configuration options.
