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

# 7. Enable dev mode (auto-restarts the gateway)
openclaw --dev-mode 1
```

### Updating

```bash
cd /opt/openclaw-dev-mode && git pull && openclaw gateway restart
```

### Reverting to original openclaw

```bash
openclaw --dev-mode 0
openclaw gateway stop
rm /usr/lib/node_modules/openclaw
mv /usr/lib/node_modules/openclaw.bak /usr/lib/node_modules/openclaw
openclaw gateway start
```

### Verify it works

```bash
# Check dev mode is on
openclaw config get cli.devMode
# Should return: true

# Check config values are unredacted (API keys visible)
openclaw config get models.providers
```

## About

OpenClaw is AMAZING. And security is awesome for prod. And a hell of a buzz killer for dev/other situations.

I cloned, listed all security features (latest - V2026.3.2) and just added a simple flag to relax them, introducing:

```bash
openclaw --dev-mode 1    # enable (auto-restarts gateway)
openclaw --dev-mode 0    # disable (auto-restarts gateway)
```

Because the beauty of any opensource project is that it's MINE and I am allowed to enjoy it to its full extent.

## What dev-mode changes

| ID | What it does |
|----|-------------|
| SEC-15a | Lighter safety section in system prompt |
| SEC-27 | Channel metadata treated as trusted (no "UNTRUSTED" wrapper) |
| SEC-59 | Skip messaging profile default in onboarding |
| SEC-67 | Default compaction mode (no safeguard) |
| SEC-70 | Skip browser navigation URL checks |
| SEC-71 | 50MB web fetch cap (instead of 2MB) |
| SEC-72 | Unredacted config in CLI (API keys visible) |
| SEC-78 | No control plane rate limiting |
| SEC-79 | 50MB prompt cap (instead of 2MB) |
| SEC-80 | Skip hooks token uniqueness check |
| SEC-96 | All env vars passed through to child processes |
| FIX-01 | Auto-bootstrap MEMORY.md in new workspaces |

## Hub notification plugin

The Hub is a lightweight notification server that auto-starts in dev-mode. It gives agents three tools:

- **hub_notify** — POST a notification (any app/cron/agent can notify)
- **hub_pending** — GET pending notifications
- **hub_done** — Mark a notification as done

The Hub server (`dev-mode/hub/server.py`) auto-starts on `127.0.0.1:10020` when dev-mode is active. It uses SQLite for storage.

### Manual hub server management

```bash
# Start manually
python3 /opt/openclaw-dev-mode/dev-mode/hub/server.py &

# Test it
curl http://127.0.0.1:10020/pending
curl -X POST http://127.0.0.1:10020/notify -H "Content-Type: application/json" -d '{"source":"test","title":"hello"}'
```

See [dev-mode/hub/README.md](dev-mode/hub/README.md) for full API reference.
