---
summary: "Quick troubleshooting guide for common Clawdis failures"
read_when:
  - Investigating runtime issues or failures
---
# Troubleshooting 🔧

When your CLAWDIS misbehaves, here's how to fix it.

## Common Issues

### "Agent was aborted"

The agent was interrupted mid-response.

**Causes:**
- User sent `stop`, `abort`, `esc`, or `exit`
- Timeout exceeded
- Process crashed

**Fix:** Just send another message. The session continues.

### Messages Not Triggering

**Check 1:** Is the sender in `routing.allowFrom`?
```bash
cat ~/.clawdis/clawdis.json | jq '.routing.allowFrom'
```

**Check 2:** For group chats, is mention required?
```bash
# The message must contain a pattern from mentionPatterns
cat ~/.clawdis/clawdis.json | jq '.routing.groupChat'
```

**Check 3:** Check the logs
```bash
tail -f "$(ls -t /tmp/clawdis/clawdis-*.log | head -1)" | grep "blocked\\|skip\\|unauthorized"
```

### Image + Mention Not Working

Known issue: When you send an image with ONLY a mention (no other text), WhatsApp sometimes doesn't include the mention metadata.

**Workaround:** Add some text with the mention:
- ❌ `@clawd` + image
- ✅ `@clawd check this` + image

### Session Not Resuming

**Check 1:** Is the session file there?
```bash
ls -la ~/.clawdis/sessions/
```

**Check 2:** Is `idleMinutes` too short?
```json
{
  "session": {
    "idleMinutes": 10080  // 7 days
  }
}
```

**Check 3:** Did someone send `/new`, `/reset`, or a reset trigger?

### Agent Timing Out

Default timeout is 30 minutes. For long tasks:

```json
{
  "reply": {
    "timeoutSeconds": 3600  // 1 hour
  }
}
```

Or use the `process` tool to background long commands.

### WhatsApp Disconnected

```bash
# Check local status (creds, sessions, queued events)
clawdis status
# Probe the running gateway + providers (WA connect + Telegram API)
clawdis status --deep

# View recent connection events
tail -100 /tmp/clawdis/clawdis-*.log | grep "connection\\|disconnect\\|logout"
```

**Fix:** Usually reconnects automatically once the Gateway is running. If you’re stuck, restart the Gateway process (however you supervise it), or run it manually with verbose output:

```bash
clawdis gateway --verbose
```

If you’re logged out / unlinked:

```bash
clawdis logout
rm -rf ~/.clawdis/credentials # if logout can't cleanly remove everything
clawdis login --verbose       # re-scan QR
```

### Media Send Failing

**Check 1:** Is the file path valid?
```bash
ls -la /path/to/your/image.jpg
```

**Check 2:** Is it too large?
- Images: max 6MB
- Audio/Video: max 16MB  
- Documents: max 100MB

**Check 3:** Check media logs
```bash
grep "media\\|fetch\\|download" "$(ls -t /tmp/clawdis/clawdis-*.log | head -1)" | tail -20
```

### High Memory Usage

CLAWDIS keeps conversation history in memory.

**Fix:** Restart periodically or set session limits:
```json
{
  "session": {
    "historyLimit": 100  // Max messages to keep
  }
}
```

## Debug Mode

Get verbose logging:

```bash
# Turn on trace logging in config:
#   ~/.clawdis/clawdis.json -> { logging: { level: "trace" } }
#
# Then run verbose commands to mirror debug output to stdout:
clawdis gateway --verbose
clawdis login --verbose
```

## Log Locations

| Log | Location |
|-----|----------|
| Main logs (default) | `/tmp/clawdis/clawdis-YYYY-MM-DD.log` |
| Session files | `~/.clawdis/sessions/` |
| Media cache | `~/.clawdis/media/` |
| Credentials | `~/.clawdis/credentials/` |

## Health Check

```bash
# Is the gateway reachable?
clawdis health --json

# Is something listening on the default port?
lsof -nP -iTCP:18789 -sTCP:LISTEN

# Recent activity
tail -20 /tmp/clawdis/clawdis-*.log
```

## Reset Everything

Nuclear option:

```bash
rm -rf ~/.clawdis
clawdis login         # re-pair WhatsApp
clawdis gateway        # start the Gateway again
```

⚠️ This loses all sessions and requires re-pairing WhatsApp.

## Getting Help

1. Check logs first: `/tmp/clawdis/` (default: `clawdis-YYYY-MM-DD.log`, or your configured `logging.file`)
2. Search existing issues on GitHub
3. Open a new issue with:
   - CLAWDIS version
   - Relevant log snippets
   - Steps to reproduce
   - Your config (redact secrets!)

---

*"Have you tried turning it off and on again?"* — Every IT person ever

🦞🔧
