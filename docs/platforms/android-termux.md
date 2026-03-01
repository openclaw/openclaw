---
summary: "Run OpenClaw Gateway on Android 10+ using Termux"
read_when:
  - Running OpenClaw on Android devices
  - Using Termux as a Linux-like environment on Android
title: "Android (Termux)"
---

# Android 10+ Running Guide (Termux)

This guide explains how to run OpenClaw Gateway on Android devices using **Termux**, a Linux-like terminal emulator for Android.

> **Note**: Android 10+ restricts background execution. Termux provides a way to run Node.js applications, but requires specific setup for persistent background operation.

## Overview

- **Runtime**: Node.js 22+ via Termux
- **Platform**: Android 10+ (Termux app)
- **Role**: Gateway host (limited - no native Android node features like camera/screen)
- **Use Case**: Personal AI assistant running on Android device

## Prerequisites

1. **Android Device**: Android 10 or higher
2. **Termux App**: Install from [F-Droid](https://f-droid.org/packages/com.termux/) (recommended over Google Play version)
3. **Storage Permission**: Required for Termux to access device storage

## Installation Steps

### 1. Install Termux

Download and install Termux from F-Droid:
- F-Droid: https://f-droid.org/packages/com.termux/
- GitHub: https://github.com/termux/termux-app/releases

### 2. Update Package Repository

```bash
pkg update
pkg upgrade
```

### 3. Install Node.js

```bash
pkg install nodejs
```

Verify Node.js version (requires 22+):

```bash
node --version
# Should be v22.x.x or higher
```

### 4. Install OpenClaw

```bash
# Using npm
npm install -g openclaw@latest

# Or using pnpm (recommended)
npm install -g pnpm
pnpm add -g openclaw@latest
```

### 5. Verify Installation

```bash
openclaw --version
```

## Configuration

### Create Configuration File

```bash
mkdir -p ~/.openclaw
nano ~/.openclaw/openclaw.json
```

Example configuration:

```json
{
  "gateway": {
    "port": 18789,
    "bind": "127.0.0.1"
  },
  "agent": {
    "model": "anthropic/claude-opus-4-6"
  }
}
```

### Configure Environment Variables

```bash
# Add to ~/.bashrc or ~/.profile
export OPENCLAW_GATEWAY_PORT=18789
```

## Running Gateway

### Interactive Mode

```bash
openclaw gateway run --port 18789 --verbose
```

### Background Running

Use `nohup` or `tmux` for background operation:

#### Option 1: Using nohup

```bash
# Start in background
nohup openclaw gateway run --port 18789 > ~/.openclaw/gateway.log 2>&1 &

# Check if running
ps aux | grep openclaw

# View logs
tail -f ~/.openclaw/gateway.log
```

#### Option 2: Using tmux (Recommended)

```bash
# Install tmux
pkg install tmux

# Start tmux session
tmux new-session -s openclaw

# Run gateway inside tmux
openclaw gateway run --port 18789 --verbose

# Detach from tmux: Press Ctrl+B, then D

# Reattach to session
tmux attach-session -t openclaw
```

#### Option 3: Using termux-wake-lock

Prevent Android from killing the process when screen is off:

```bash
# Install termux-wake-lock
pkg install termux-wake-lock

# Before starting gateway
termux-wake-lock

# Run gateway
openclaw gateway run --port 18789

# Release wake lock when done
termux-wake-unlock
```

## Log Location

- **Log Directory**: `~/.openclaw/logs/`
- **Log Files**: `~/.openclaw/logs/openclaw-YYYY-MM-DD.log`

## Accessing Gateway

### Local Access

```bash
# Check gateway status
openclaw gateway status
```

### Network Access

By default, Gateway binds to `127.0.0.1`. To access from other devices:

```bash
# Bind to all interfaces ( LAN accessible )
openclaw gateway run --port 18789 --bind 0.0.0.0

# Or set in config
# "gateway": { "bind": "0.0.0.0" }
```

> **Warning**: Binding to `0.0.0.0` exposes your Gateway to the local network. Consider using firewall rules or VPN.

## Known Limitations

1. **No Native Android Features**: Cannot use camera, screen recording, or system notifications
2. **Background Execution**: Requires workarounds (tmux, wake-lock) to keep running
3. **No systemd/launchd**: Process management must be manual
4. **Performance**: Mobile hardware may be slower than dedicated servers
5. **Battery**: Running continuously will drain battery faster

## Troubleshooting

### Gateway Won't Start

```bash
# Check if port is in use
lsof -i :18789

# Kill any existing process
pkill -f openclaw

# Try again
openclaw gateway run --port 18789 --verbose
```

### Termux Gets Killed

- Use `termux-wake-lock` to prevent background killing
- Use tmux for persistent sessions
- Consider using a dedicated app like "Termux:Boot" for auto-start

### Network Connectivity Issues

- Check firewall settings on both devices
- Verify both devices are on the same network
- Use `ip addr` to find your local IP address

## Auto-Start on Boot (Advanced)

To auto-start Gateway when Android boots:

1. Install Termux:Boot
2. Create startup script:

```bash
mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-openclaw.sh
```

Add content:

```bash
#!/bin/bash
termux-wake-lock
cd ~
nohup openclaw gateway run --port 18789 > ~/.openclaw/gateway.log 2>&1 &
```

Make executable:

```bash
chmod +x ~/.termux/boot/start-openclaw.sh
```

## Security Notes

1. **Don't expose to public internet** without authentication
2. **Use VPN** (like Tailscale) for remote access
3. **Keep credentials secure** - don't share device access
4. **Regularly update** OpenClaw for security patches

## Related Documentation

- [Gateway Configuration](/gateway/configuration)
- [Security Guide](/gateway/security)
- [Network Access](/network)
- [Tailscale Setup](/gateway/tailscale)
