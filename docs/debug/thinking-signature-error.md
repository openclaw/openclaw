---
summary: "Missing thinking.signature error when session history is corrupted by external AI messages"
read_when:
  - Getting "thinking.signature: Field required" error
  - Session crashes after Meta AI or other AI responds in same channel
  - Claude Extended Thinking chain integrity issues
title: "Thinking Signature Error"
---

# Missing `thinking.signature` Session Crash

## Summary

When using Claude models with Extended Thinking (e.g., Claude 4.5 Opus) on WhatsApp, a collision can occur if Meta's built-in AI also responds in the same chat. This corrupts the session history file and causes an unrecoverable crash.

## Error Message

```
[openclaw] LLM request rejected:
messages.X.content.Y.thinking.signature: Field required
```

Where `X` and `Y` are indices pointing to the corrupted message in the session history.

## Cause

Claude's Extended Thinking feature uses cryptographic signatures to maintain reasoning chain integrity across conversation turns. When a foreign message (like Meta AI's response) gets written to the local `.jsonl` session file without the required `thinking.signature` metadata, the API rejects subsequent requests.

### What happens:

1. OpenClaw picks up a message from WhatsApp
2. Meta AI (built into WhatsApp) also responds to the same message
3. Meta AI's response gets logged to OpenClaw's session file
4. The Meta AI message lacks `thinking.signature` metadata
5. On next turn, Claude API rejects the request due to broken chain integrity

## Solutions

### Option 1: Delete the Session File (Recommended)

The fastest fix is to remove the corrupted session file:

```bash
# Find your session file
ls ~/.openclaw/agents/main/sessions/

# Delete the corrupted session
rm ~/.openclaw/agents/main/sessions/<session-id>.jsonl
```

**Note:** This loses conversation history for that session.

### Option 2: Manual Edit (Advanced)

If you want to preserve history, you can try editing the session file:

1. Open `~/.openclaw/agents/main/sessions/<session-id>.jsonl`
2. Find the line index from the error (e.g., `messages.17` = line 17)
3. Remove lines containing messages without `thoughtSignature`
4. Restart OpenClaw

**Warning:** This often doesn't work if the thinking chain is already broken. The signature validation is cryptographic, so partial fixes may still fail.

## Prevention

- **Disable Meta AI:** In WhatsApp settings, disable Meta AI if you're running OpenClaw on the same number
- **Use separate channels:** Run OpenClaw on a channel without competing AI assistants
- **Monitor for collisions:** If you see duplicate responses (one from OpenClaw, one from Meta AI), check your session file promptly

## Environment

- Affected models: Claude models with Extended Thinking enabled
- Affected channels: WhatsApp (with Meta AI enabled), potentially others with built-in AI
- All platforms (Windows, macOS, Linux)

## Related

- [Anthropic Extended Thinking Documentation](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking)
