---
summary: "Sync OpenClaw config between multiple machines using git and $include"
read_when:
  - Setting up OpenClaw across multiple machines (server + laptop)
  - Syncing workspaces and sessions via git
  - Switching between local and remote gateway modes
title: "Multi-Machine Config Sync"
---

# Multi-Machine Config Sync with Git

A guide for syncing OpenClaw configuration between multiple machines (e.g., home server + laptop) while keeping machine-specific gateway settings separate.

## The Problem

You have:

- A **home server** (always-on, runs the gateway, handles Telegram/WhatsApp)
- A **laptop** (connects remotely when home, runs locally when traveling)

You want to sync workspaces, sessions, and config via git, but:

- The server needs `gateway.mode: "local"` (it runs the gateway)
- The laptop needs `gateway.mode: "remote"` (it connects to the server)

If you just git sync `openclaw.json`, pulling on one machine overwrites its gateway mode with the other's settings.

## The Solution: `$include` for Machine-Specific Config

OpenClaw's [`$include` directive](/gateway/configuration#config-includes-$include) lets you split config into multiple files. Put shared settings in the git-tracked config, and machine-specific settings in a gitignored local file.

### Step 1: Create Machine-Specific Config Files

On your **server**:

```bash
cat > ~/.openclaw/gateway-local.json5 << 'EOF'
// Machine-specific gateway config (gitignored)
// Server: runs the gateway locally
{
  "mode": "local",
  "bind": "lan"
}
EOF
```

On your **laptop**:

```bash
cat > ~/.openclaw/gateway-local.json5 << 'EOF'
// Machine-specific gateway config (gitignored)
// Laptop: connects to server remotely
{
  "mode": "remote",
  "remote": {
    "url": "ws://YOUR_SERVER_IP:18789",
    "token": "your-gateway-token"
  }
}
EOF
```

### Step 2: Update Main Config to Use `$include`

Edit `~/.openclaw/openclaw.json` to include the local file in the gateway section:

```json5
{
  // ... other config ...

  gateway: {
    $include: "./gateway-local.json5", // Machine-specific mode
    port: 18789, // Shared settings below
    auth: {
      mode: "token",
      token: "your-gateway-token",
    },
    tailscale: {
      mode: "off",
    },
  },

  // ... rest of config ...
}
```

The `$include` is processed first, then sibling keys are merged. So `port`, `auth`, and `tailscale` are shared, while `mode` and `remote` come from the local file.

### Step 3: Set Up Git with Proper Ignores

```bash
cd ~/.openclaw
git init

cat > .gitignore << 'EOF'
# Cache and large files
media/

# Machine-specific
devices/
gateway-local.json5
gateway-local-*.json5

# Runtime
*.log
*.tmp
*.bak
*.lock
EOF

git add -A
git commit -m "Initial commit"
git remote add origin git@github.com:youruser/openclaw-config.git
git push -u origin main
```

### Step 4: Clone on Second Machine

```bash
# On laptop
git clone git@github.com:youruser/openclaw-config.git ~/.openclaw

# Create the machine-specific config (not in git)
cat > ~/.openclaw/gateway-local.json5 << 'EOF'
{
  "mode": "remote",
  "remote": {
    "url": "ws://YOUR_SERVER_IP:18789",
    "token": "your-gateway-token"
  }
}
EOF
```

## Optional: Mode Switching Scripts

If your laptop needs to switch between remote (at home) and local (traveling), keep template files:

```
~/.openclaw/gateway-local-local.json5   # Template for local gateway mode
~/.openclaw/gateway-local-remote.json5  # Template for remote client mode
~/.openclaw/gateway-local.json5         # Active config (copied from template)
```

All three files should be gitignored.

**Security note:** For laptop local mode, use `"bind": "loopback"` instead of `"lan"` — this prevents the gateway from being exposed on public networks (coffee shops, airports, etc.). Only use `"lan"` when you need other devices on the same network to connect.

**openclaw.local** script:

```bash
#!/bin/bash
cd ~/.openclaw
git pull --rebase || echo "Warning: Could not pull"
cp gateway-local-local.json5 gateway-local.json5
openclaw gateway start
echo "Running in local mode."
```

**openclaw.remote** script:

```bash
#!/bin/bash
cd ~/.openclaw
openclaw gateway stop 2>/dev/null || true
git add -A && git diff --quiet --cached || git commit -m "sync $(date +%Y-%m-%d\ %H:%M)"
git push
git pull --rebase
cp gateway-local-remote.json5 gateway-local.json5
echo "Switched to remote mode. Use 'openclaw tui' or 'openclaw agent'."
```

## What Gets Synced

| Synced (tracked in git)                     | Not Synced (gitignored)   |
| ------------------------------------------- | ------------------------- |
| `openclaw.json` (base config)               | `gateway-local*.json5`    |
| `workspace*/` (all agent workspaces)        | `media/` (cache)          |
| `agents/*/sessions/` (conversation history) | `devices/` (paired nodes) |
| `credentials/` (pairing state)              | `*.lock` files            |
| `cron/` (scheduled jobs)                    |                           |

## Auto-Sync with Cron

Add to your crontab for automatic commits:

```bash
*/30 * * * * cd ~/.openclaw && git add -A && git diff --quiet --cached || (git commit -m "auto-sync $(date +\%Y-\%m-\%d\ \%H:\%M)" && git push) >/dev/null 2>&1
```

## Troubleshooting

### Timestamp conflicts on pull

The gateway updates timestamps in `identity/` and `device-auth.json` on startup, even without content changes. This can cause git conflicts when switching machines.

Quick fix:

```bash
git fetch origin
git reset --hard origin/main
```

This is safe when the actual content is identical and only timestamps differ.

### Config validation fails after pull

- Check that `gateway-local.json5` exists and has valid JSON5
- Run `openclaw doctor` to see specific issues

### Sessions not continuing between machines

- Make sure you committed sessions before switching: `git add -A && git commit`
- Session paths are absolute; both machines need the same username/home paths

### Gateway won't start on laptop

- If switching to local mode, make sure the server's gateway is stopped first
- Telegram/WhatsApp bots can only have one active connection

## Summary

The key insight: `openclaw.json` mixes shared settings with machine-specific settings. Using `$include` lets you separate them, so git sync works without overwriting machine-specific gateway configuration.

This pattern works for any multi-machine setup where you want shared workspaces and sessions but different gateway modes.

## Related

- [Configuration](/gateway/configuration)
- [Config Includes](/gateway/configuration#config-includes-$include)
- [Remote Access](/gateway/remote)
- [Multiple Gateways](/gateway/multiple-gateways)
