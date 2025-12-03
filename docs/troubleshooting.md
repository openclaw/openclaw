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

**Check 1:** Is the sender in `allowFrom`?
```bash
cat ~/.clawdis/clawdis.json | jq '.inbound.allowFrom'
```

**Check 2:** For group chats, is mention required?
```bash
# The message must contain a pattern from mentionPatterns
cat ~/.clawdis/clawdis.json | jq '.inbound.groupChat'
```

**Check 3:** Check the logs
```bash
tail -f /tmp/clawdis/clawdis.log | grep "blocked\|skip\|unauthorized"
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

**Check 3:** Did someone send `/new` or a reset trigger?

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
# Check status
clawdis status

# View recent connection events
tail -100 /tmp/clawdis/clawdis.log | grep "connection\|disconnect\|logout"
```

**Fix:** Usually reconnects automatically. If not:
```bash
clawdis restart
```

If you're logged out:
```bash
clawdis stop
rm -rf ~/.clawdis/credentials  # Clear session
clawdis start  # Re-scan QR code
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
grep "media\|fetch\|download" /tmp/clawdis/clawdis.log | tail -20
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
# In config
{
  "logging": {
    "level": "trace"
  }
}

# Or environment
CLAWDIS_LOG_LEVEL=trace clawdis start
```

## Log Locations

| Log | Location |
|-----|----------|
| Main log | `/tmp/clawdis/clawdis.log` |
| Session files | `~/.clawdis/sessions/` |
| Media cache | `~/.clawdis/media/` |
| Credentials | `~/.clawdis/credentials/` |

## Health Check

```bash
# Is it running?
clawdis status

# Check the socket
ls -la ~/.clawdis/clawdis.sock

# Recent activity
tail -20 /tmp/clawdis/clawdis.log
```

## Reset Everything

Nuclear option:

```bash
clawdis stop
rm -rf ~/.clawdis
clawdis start  # Fresh setup
```

⚠️ This loses all sessions and requires re-pairing WhatsApp.

## Getting Help

1. Check logs first: `/tmp/clawdis/clawdis.log`
2. Search existing issues on GitHub
3. Open a new issue with:
   - CLAWDIS version
   - Relevant log snippets
   - Steps to reproduce
   - Your config (redact secrets!)

---

*"Have you tried turning it off and on again?"* — Every IT person ever

🦞🔧
