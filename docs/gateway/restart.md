# Restarting the Clawdbot Gateway

This guide covers how to properly restart the Clawdbot gateway service on different platforms.

## Linux (systemd)

The gateway runs as a systemd user service on Linux servers.

### Quick Restart

```bash
systemctl --user restart clawdbot-gateway.service
```

### Full Reload (after code updates)

When you update the codebase (git pull, rebase, etc.), follow these steps:

```bash
# 1. Stop the service
systemctl --user stop clawdbot-gateway.service

# 2. Kill any stray gateway processes
pkill -f "gateway.*18789"

# 3. Reload systemd configuration (if service file changed)
systemctl --user daemon-reload

# 4. Start the service
systemctl --user start clawdbot-gateway.service

# 5. Verify it's running
systemctl --user status clawdbot-gateway.service
```

### Reinstall Service (after major updates)

If the gateway command changed or you're having persistent issues:

```bash
# Uninstall old service
pnpm clawdbot daemon uninstall

# Reinstall with latest configuration
pnpm clawdbot daemon install

# Reload and start
systemctl --user daemon-reload
systemctl --user start clawdbot-gateway.service
```

### Check Logs

```bash
# Follow live logs
journalctl --user -u clawdbot-gateway.service -f

# View recent logs
journalctl --user -u clawdbot-gateway.service -n 50

# View logs since last boot
journalctl --user -u clawdbot-gateway.service --boot
```

### Common Issues

**Port already in use:**
```bash
# Find process using port 18789
lsof -i :18789

# Kill specific process
kill -9 <PID>
```

**Service keeps restarting:**
```bash
# Check for error details
journalctl --user -u clawdbot-gateway.service --since "5 minutes ago" | grep -i error

# Verify service file is correct
cat ~/.config/systemd/user/clawdbot-gateway.service
```

## macOS (launchd)

Use the macOS menu app or restart script:

```bash
./scripts/restart-mac.sh
```

Or manually:

```bash
# Stop service
launchctl unload ~/Library/LaunchAgents/dev.steipete.clawdbot.gateway.plist

# Start service
launchctl load ~/Library/LaunchAgents/dev.steipete.clawdbot.gateway.plist
```

## Using Clawdbot CLI

Cross-platform daemon management:

```bash
# Stop gateway
pnpm clawdbot daemon stop

# Start gateway
pnpm clawdbot daemon start

# Check status
pnpm clawdbot daemon status
```

## After Configuration Changes

After modifying `~/.clawdbot/clawdbot.json` or auth profiles:

```bash
# Restart to reload configuration
systemctl --user restart clawdbot-gateway.service

# Or use CLI
pnpm clawdbot daemon stop && pnpm clawdbot daemon start
```

The gateway will automatically reload:
- Auth profiles
- Model fallback configuration
- Gateway settings (port, bind, etc.)
- Provider configurations

## Verifying Gateway Health

```bash
# Check gateway is responding
pnpm clawdbot health

# List auth providers
pnpm clawdbot providers list

# Test agent connection
pnpm clawdbot agent --message "hello" --local
```

## Troubleshooting

**Gateway won't start:**
1. Check for port conflicts: `lsof -i :18789`
2. Verify configuration: `pnpm clawdbot doctor`
3. Check logs for errors
4. Try reinstalling the service

**Changes not taking effect:**
- Configuration changes require restart
- Code changes require rebuild: `pnpm build`
- Service file changes require daemon-reload

**Multiple gateways running:**
```bash
# List all gateway processes
ps aux | grep gateway

# Kill all gateway processes
pkill -f "gateway.*18789"

# Clean start
systemctl --user stop clawdbot-gateway.service
pkill -f "gateway.*18789"
systemctl --user start clawdbot-gateway.service
```
