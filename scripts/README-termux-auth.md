# Clawdbot Auth Management Scripts

## Current Setup (Jan 2025)

Using `claude setup-token` for **1-year long-lived token**. No daily re-auth needed.

- **Token expires**: January 9, 2027
- **Check status**: `./claude-auth-status.sh`

## Scripts

| Script | Purpose |
|--------|---------|
| `claude-auth-status.sh` | Check Claude Code + Clawdbot auth status |
| `mobile-reauth.sh` | Guided re-auth (only needed annually now) |
| `auth-monitor.sh` | Cron-able expiry monitor with notifications |
| `termux-quick-auth.sh` | Termux widget - one-tap status check |
| `termux-auth-widget.sh` | Termux widget - full guided re-auth flow |
| `setup-auth-system.sh` | Interactive setup wizard |

## Quick Commands

```bash
# Check auth status
~/clawdbot/scripts/claude-auth-status.sh

# Sync Claude Code token to Clawdbot
clawdbot doctor --yes

# Renew long-lived token (run in terminal, not Claude Code)
claude setup-token
```

## Termux Widget Setup (if needed)

1. Install Termux + Termux:Widget from F-Droid
2. Create shortcuts dir: `mkdir -p ~/.shortcuts`
3. Copy widget script:
   ```bash
   scp l36:~/clawdbot/scripts/termux-quick-auth.sh ~/.shortcuts/ClawdAuth
   chmod +x ~/.shortcuts/ClawdAuth
   ```
4. Set server: `echo 'export CLAWDBOT_SERVER=l36' >> ~/.bashrc`
5. Add Termux:Widget to home screen

## How It Works

1. `claude setup-token` creates a 1-year token in `~/.claude/.credentials.json`
2. `clawdbot doctor --yes` syncs it to `~/.clawdbot/agents/main/agent/auth-profiles.json`
3. Clawdbot uses the `anthropic:claude-cli` profile automatically

## Troubleshooting

```bash
# Check what's happening
~/clawdbot/scripts/claude-auth-status.sh full

# Force sync from Claude Code
clawdbot doctor --yes

# If token expired (annually), run in terminal:
claude setup-token
```
