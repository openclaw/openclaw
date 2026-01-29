# Troubleshooting Guide

## Diagnostic Commands

```bash
dna status              # Quick overview: gateway, channels, sessions
dna status --all        # Full diagnosis (safe to share, redacts tokens)
dna doctor              # Validates and repairs config/state
dna doctor --fix        # Auto-repair known issues
dna health --json       # Gateway reachability check
dna channels status --probe  # Test each channel connection
dna models status       # Check model credentials
```

## Log Locations

| Log Type | Location |
|----------|----------|
| Gateway logs | `/tmp/dna/dna-YYYY-MM-DD.log` |
| LaunchAgent logs | `~/.dna/logs/gateway.log` |
| Session files | `~/.dna/agents/<agentId>/sessions/` |

**Real-time monitoring:**

```bash
dna logs --follow
# or
tail -f /tmp/dna/dna-*.log
```

## Common Issues

### Gateway Won't Start

**Symptoms:** Gateway fails to start, port already in use.

**Diagnosis:**

```bash
dna doctor --fix
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

**Fix:**

```bash
launchctl bootout gui/$UID/com.dna.gateway
dna gateway
```

### "All Models Failed" Error

**Symptoms:** Messages fail with model errors.

**Diagnosis:**

```bash
dna models status
```

**Fix:**

```bash
dna models auth setup-token --provider anthropic
```

Verify API key is valid and has sufficient credits.

### WhatsApp Disconnected

**Symptoms:** WhatsApp stops receiving/sending messages.

**Fix:**

```bash
dna channels logout
rm -rf ~/.dna/credentials
dna channels login --verbose
```

Re-scan QR code within 60 seconds.

### Discord MESSAGE CONTENT INTENT

**Symptoms:** Discord bot doesn't see message content.

**Fix:** Enable MESSAGE CONTENT INTENT in Discord Developer Portal under Bot settings.

### Unknown Senders Blocked

**Symptoms:** New contacts can't reach the bot.

**Fix:**

```bash
dna pairing approve whatsapp <code>
```

Or configure `dmPolicy: "allow"` in config (less secure).

### High Token Usage

**Symptoms:** $300+ API costs in days.

**Diagnosis:**

```bash
dna status
```

Check token usage, configure model fallbacks to free tiers.

### Session Context Buildup

**Symptoms:** Cron jobs accumulate context, degrade over time.

**Fix:** Use `--session isolated` for scheduled tasks:

```bash
moltbot cron add --session isolated ...
```

### Gateway Dashboard Slash Commands Not Working

**Symptoms:** Slash commands (`/help`, `/status`, `/compact`, `/commands`, `/whoami`, `/context`) fail silently on the Gateway Dashboard webchat UI at `http://127.0.0.1:18790/chat`. Commands execute (visible in logs) but no response appears.

**Root Cause:** Bug in `command-auth.js` where `resolveProviderFromContext()` doesn't recognize `webchat` as a valid provider. It falls through to dock resolution which defaults to WhatsApp. Since WhatsApp has `enforceOwnerForCommands: true`, webchat senders are marked unauthorized (`isAuthorizedSender: false`).

**Fix:** Patch `/usr/local/lib/node_modules/dna/dist/auto-reply/command-auth.js` to recognize webchat:

```javascript
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

function resolveProviderFromContext(ctx, cfg) {
    // Check for webchat first - it's a special internal channel that's not registered
    const surfaceNormalized = (ctx.Surface ?? "").trim().toLowerCase();
    const providerNormalized = (ctx.Provider ?? "").trim().toLowerCase();
    if (surfaceNormalized === INTERNAL_MESSAGE_CHANNEL || providerNormalized === INTERNAL_MESSAGE_CHANNEL) {
        return INTERNAL_MESSAGE_CHANNEL;
    }
    // ... rest of function unchanged
}
```

**Auto-patch script:** If you have the patch system set up:

```bash
~/.dna/patches/fix-webchat-commands.sh
dna gateway stop && dna gateway start
```

**Note:** This fix is lost on DNA updates. Use the npm wrapper hook system to auto-reapply, or report upstream.

## Nuclear Reset

**Warning:** Loses all sessions, requires re-pairing all channels.

```bash
dna gateway stop
rm -rf ~/.dna
dna onboard --install-daemon
```

## Backup Before Reset

```bash
# Backup workspace
cp -r ~/clawd ~/clawd-backup-$(date +%Y%m%d)

# Backup config (without secrets)
cp ~/.dna/dna.json ~/dna-config-backup.json
```

## Getting Help

1. Run `dna status --all` (output is safe to share)
2. Check Discord (8,900+ members): https://discord.gg/dna
3. GitHub Issues: https://github.com/dna/dna/issues
