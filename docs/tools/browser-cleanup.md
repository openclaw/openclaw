---
title: Browser Process Cleanup
description: Automatically manage Chrome/Chromium browser processes to prevent memory exhaustion
---

# Browser Process Cleanup

OpenClaw can automatically monitor and clean up orphaned Chrome/Chromium browser processes to prevent RAM exhaustion during long-running sessions.

## Overview

The browser cleanup daemon monitors Chrome processes launched by OpenClaw and terminates orphaned main processes that have been idle for too long. This prevents memory leaks from accumulated browser instances.

**Key features:**

- Targets only OpenClaw browser processes (never touches regular user Chrome)
- Configurable idle timeout and instance limits
- Cross-platform: Linux (systemd) and macOS (launchd)
- Dry-run mode for testing

## Installation

```bash
bash install.sh
```

This installs:

- `~/.openclaw/browser/chrome-cleanup.sh` - Main cleanup script
- `~/.openclaw/browser/chrome-cleanup.conf` - Configuration file
- System service (systemd on Linux, launchd on macOS)

## Configuration

Edit `~/.openclaw/browser/chrome-cleanup.conf`:

```bash
# Maximum number of Chrome instances allowed
MAX_CHROME_INSTANCES=2

# Idle time before cleanup (seconds)
IDLE_TIMEOUT_SECS=120

# Check interval (seconds)
CHECK_INTERVAL_SECS=30

# Log file location
LOG_FILE="$HOME/.openclaw/logs/chrome-cleanup.log"

# Dry run mode (set to true to log without killing)
DRY_RUN=false
```

## Usage

### Check Status

```bash
~/.openclaw/browser/chrome-cleanup.sh status
```

### Run Once

```bash
~/.openclaw/browser/chrome-cleanup.sh once
```

### Start Daemon

```bash
# Linux
systemctl --user start chrome-cleanup.service

# macOS
launchctl load ~/Library/LaunchAgents/com.openclaw.chrome-cleanup.plist
```

### Stop Daemon

```bash
# Linux
systemctl --user stop chrome-cleanup.service

# macOS
launchctl unload ~/Library/LaunchAgents/com.openclaw.chrome-cleanup.plist
```

### Kill All OpenClaw Chrome Processes

```bash
~/.openclaw/browser/chrome-cleanup.sh kill-all
```

## How It Works

1. **Discovery**: Finds Chrome main processes with `--user-data-dir` pointing to OpenClaw's browser directory
2. **Filtering**: Only targets main processes (not child zygote/renderer/GPU processes)
3. **Idle Detection**: Checks CPU usage and elapsed time
4. **Cleanup**: Kills main processes that exceed `IDLE_TIMEOUT_SECS`

Killing a main process automatically terminates all its children.

## Logs

View cleanup activity:

```bash
tail -f ~/.openclaw/logs/chrome-cleanup.log
```

## Safety

- Only processes with `--user-data-dir` matching `~/.openclaw/browser/*` are targeted
- Regular user Chrome (without OpenClaw user-data-dir) is never touched
- Use `DRY_RUN=true` to test without killing processes

## Troubleshooting

### Service won't start

```bash
# Linux - check systemd logs
systemctl --user status chrome-cleanup.service
journalctl --user -u chrome-cleanup.service

# macOS - check launchctl
launchctl list | grep chrome-cleanup
```

### Processes not being cleaned

1. Check `IDLE_TIMEOUT_SECS` is not too high
2. Verify `MAX_CHROME_INSTANCES` limit
3. Check logs for "OpenClaw user-data-dir" filtering
4. Ensure `DRY_RUN=false`

### Too aggressive cleanup

Increase `IDLE_TIMEOUT_SECS` or `MAX_CHROME_INSTANCES` in the config file.

## Uninstallation

```bash
# Linux
systemctl --user stop chrome-cleanup.service
systemctl --user disable chrome-cleanup.service
rm ~/.config/systemd/user/chrome-cleanup.service

# macOS
launchctl unload ~/Library/LaunchAgents/com.openclaw.chrome-cleanup.plist
rm ~/Library/LaunchAgents/com.openclaw.chrome-cleanup.plist

# Remove files
rm -rf ~/.openclaw/browser/chrome-cleanup.sh
rm -rf ~/.openclaw/browser/chrome-cleanup.conf
```
