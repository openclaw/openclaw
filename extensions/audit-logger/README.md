# Audit Logger Plugin

Creates a tamper-evident audit trail of all agent actions for independent verification.

## Why This Exists

When an AI agent claims it did something ("I sent that message", "I created that file"), how do you verify it actually happened? The audit logger creates an **independent record** of all tool calls and messages that:

1. **Cannot be manipulated by the agent** — logs at the gateway level, not agent level
2. **Captures everything** — every tool call, every message, across all sessions
3. **Enables verification** — compare agent claims against actual recorded actions

## Installation

The plugin is bundled with OpenClaw. Enable it in your config:

```json
{
  "plugins": {
    "audit-logger": {
      "enabled": true
    }
  }
}
```

## What It Logs

### Tool Calls (`type: "tool_call"`)

Every tool invocation (exec, read, write, message, etc.):

```json
{
  "ts": "2026-02-14T14:30:05.000Z",
  "type": "tool_call",
  "tool": "exec",
  "params": { "command": "git status" },
  "success": true,
  "durationMs": 150,
  "sessionKey": "agent:main:main"
}
```

### Messages Sent (`type: "message_sent"`)

Every outbound message to any channel:

```json
{
  "ts": "2026-02-14T14:30:10.000Z",
  "type": "message_sent",
  "channelId": "telegram",
  "to": "+1234567890",
  "success": true,
  "contentLength": 42
}
```

### Session Events

Markers for session boundaries:

```json
{"ts": "...", "type": "session_start", "sessionId": "...", "agentId": "main"}
{"ts": "...", "type": "session_end", "sessionId": "...", "messageCount": 15}
```

## Log Location

Default: `~/.openclaw/logs/audit.jsonl`

Override via config:

```json
{
  "plugins": {
    "audit-logger": {
      "enabled": true,
      "logPath": "/custom/path/audit.jsonl"
    }
  }
}
```

## Security Features

### Sensitive Data Redaction

Passwords, tokens, API keys, and other sensitive parameters are automatically redacted:

```json
{ "tool": "exec", "params": { "command": "curl -H 'Authorization: [REDACTED]' ..." } }
```

Default redacted keys: `password`, `token`, `secret`, `apikey`, `auth`, `credential`, `private`, `bearer`

Add custom patterns:

```json
{
  "plugins": {
    "audit-logger": {
      "enabled": true,
      "redactPatterns": ["ssn", "creditcard"]
    }
  }
}
```

### Append-Only Format

Logs are written in JSONL (JSON Lines) format — each line is a complete JSON object. This makes tampering detectable (modifying a line changes its structure).

## Verification Use Cases

### Check if a command was actually run

```bash
grep '"tool":"exec"' ~/.openclaw/logs/audit.jsonl | grep 'git push'
```

### Check if a message was actually sent

```bash
grep '"type":"message_sent"' ~/.openclaw/logs/audit.jsonl | jq .
```

### List all tool calls in a session

```bash
grep '"sessionKey":"agent:main:main"' ~/.openclaw/logs/audit.jsonl | jq -r '.tool' | sort | uniq -c
```

### View recent activity

```bash
tail -20 ~/.openclaw/logs/audit.jsonl | jq .
```

## Related Issues

- [#13131](https://github.com/openclaw/openclaw/issues/13131) — Gateway-level audit logging feature request
- [#12563](https://github.com/openclaw/openclaw/issues/12563) — Messaging operations without audit (security issue)
- [#16026](https://github.com/openclaw/openclaw/issues/16026) — Immune system improvements

## Future: Pre-Completion Verification

This plugin handles **Part 1** (audit logging). **Part 2** (pre-completion verification) requires a new `before_response` hook that would:

1. Intercept agent responses before they're sent
2. Parse completion claims ("done", "created", "sent")
3. Verify claims against the audit log
4. Block or warn if verification fails

See the PR for the `before_response` hook for progress on this.
