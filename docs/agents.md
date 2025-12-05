# Agent Integration 🤖

CLAWDIS now ships with a single coding agent: Pi (the Tau CLI). Legacy Claude/Codex/Gemini/Opencode paths have been removed.
Pi is bundled as a dependency of `clawdis`, so a fresh `pnpm install` gives you the `pi`/`tau` binaries automatically.

## Pi / Tau

The recommended (and only) agent for CLAWDIS. Built by Mario Zechner, forked with love.

```json
{
  "reply": {
    "mode": "command",
  "agent": {
    "kind": "pi",
    "format": "json",
    "model": "claude-opus-4-5" // default if omitted
  },
    "command": [
      "node",
      "/path/to/pi-mono/packages/coding-agent/dist/cli.js",
      "-p",
      "--mode", "json",
      "{{BodyStripped}}"
    ]
  }
}
```

#### RPC Mode (Recommended)

For streaming tool output and better integration:

```json
{
  "command": [
    "tau",
    "--mode", "rpc",
    "--session", "/path/to/sessions/{{SessionId}}.jsonl"
  ]
}
```

RPC mode is enforced by CLAWDIS (we rewrite `--mode` to `rpc` for Pi invocations). It gives you:
- 💻 Real-time tool execution display
- 📊 Token usage tracking
- 🔄 Streaming responses

If the agent does not report a model, CLAWDIS assumes `claude-opus-4-5` with ~200k context tokens (pi-ai defaults) for usage summaries.

## Session Management

### Per-Sender Sessions

Each phone number gets its own conversation history:

```json
{
  "session": {
    "scope": "per-sender",
    "sessionArgNew": ["--session", "{{SessionId}}.jsonl"],
    "sessionArgResume": ["--session", "{{SessionId}}.jsonl", "--continue"]
  }
}
```
By default CLAWDIS stores sessions under `~/.clawdis/sessions` and will create the folder automatically.

### Global Session

Everyone shares the same context (useful for team bots):

```json
{
  "session": {
    "scope": "global"
  }
}
```

### Session Reset

Users can start fresh with trigger words:

```json
{
  "session": {
    "resetTriggers": ["/new", "/reset", "/clear"]
  }
}
```

## System Prompts

Give your agent personality:

```json
{
  "session": {
    "sessionIntro": "You are Clawd, a space lobster AI assistant. Be helpful, be funny, use 🦞 liberally. Read /path/to/AGENTS.md for your instructions.",
    "sendSystemOnce": true
  }
}
```

## Heartbeats

Keep your agent alive and doing background tasks:

```json
{
  "reply": {
    "heartbeatMinutes": 10,
    "heartbeatBody": "HEARTBEAT"
  }
}
```

The agent receives "HEARTBEAT" and can:
- Check for pending tasks
- Update memory files
- Monitor systems
- Reply with `HEARTBEAT_OK` to skip

## Tool Streaming

When using RPC mode, CLAWDIS shows tool usage in real-time:

```
💻 ls -la ~/Projects
📄 Reading README.md
✍️ Writing config.json
📝 Editing main.ts
📎 Attaching image.jpg
🛠️ Running custom tool
```

Configure the display:

```json
{
  "agent": {
    "kind": "pi",
    "format": "json",
    "toolEmoji": {
      "bash": "💻",
      "read": "📄",
      "write": "✍️",
      "edit": "📝",
      "attach": "📎"
    }
  }
}
```

## Timeouts

Long-running tasks need appropriate timeouts:

```json
{
  "reply": {
    "timeoutSeconds": 1800
  }
}
```

For background tasks, the agent can yield and continue later using the `process` tool.

## Error Handling

When the agent fails:

1. CLAWDIS logs the error
2. Sends a user-friendly message
3. Preserves the session for retry

```json
{
  "reply": {
    "errorMessage": "🦞 Oops! Something went wrong. Try again?"
  }
}
```

## Multi-Agent Setup

Run different agents for different numbers:

```json
{
  "inbound": {
    "routes": [
      {
        "from": "+1234567890",
        "command": ["work-agent", "{{Body}}"]
      },
      {
        "from": "+0987654321", 
        "command": ["fun-agent", "{{Body}}"]
      }
    ]
  }
}
```

---

*Next: [Group Chats](./groups.md)* 🦞
