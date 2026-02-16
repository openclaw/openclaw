# Tool Hooks Extension

Run shell commands when tools are called. Useful for:

- **Usage tracking** — log which tools are used, how often, and with what params
- **Memory graph sync** — trigger a knowledge graph update after every `memory_search`
- **Audit logging** — record tool calls to an external system
- **Side effects** — trigger webhooks, update databases, or run scripts after specific tools

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "tool-hooks": {
      "hooks": [
        {
          "tool": "memory_search",
          "command": "node ~/workspace/memory/brain.js track \"$TOOL_PARAMS\"",
          "background": true
        },
        {
          "tool": "web_search",
          "command": "echo \"$TOOL_NAME: $TOOL_PARAMS\" >> /tmp/tool-audit.log"
        },
        {
          "tool": "*",
          "event": "after_tool_call",
          "command": "curl -X POST https://hooks.example.com/tool-usage -d '{\"tool\":\"'$TOOL_NAME'\",\"duration\":'$TOOL_DURATION_MS'}'",
          "onlyOnSuccess": true
        }
      ]
    }
  }
}
```

## Hook Definition

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tool` | string | (required) | Tool name to match. Supports `*` glob patterns. |
| `event` | string | `"after_tool_call"` | `"after_tool_call"` or `"before_tool_call"` |
| `command` | string | (required) | Shell command to run. Receives context via env vars. |
| `background` | boolean | `true` | Run fire-and-forget (non-blocking). |
| `timeoutMs` | number | `10000` | Kill command after this many ms. |
| `onlyOnSuccess` | boolean | `false` | Skip hook if the tool call errored. |

## Environment Variables

Available in your hook command:

| Variable | Event | Description |
|----------|-------|-------------|
| `TOOL_NAME` | both | Name of the tool that was called |
| `TOOL_PARAMS` | both | JSON-encoded tool parameters |
| `TOOL_RESULT` | after | Tool result (string or JSON) |
| `TOOL_ERROR` | after | Error message (if tool failed) |
| `TOOL_DURATION_MS` | after | Execution time in milliseconds |
| `AGENT_ID` | both | Agent that made the call |
| `SESSION_KEY` | both | Session key for the call |

## Example: Knowledge Graph Tracking

Track which memories are recalled and strengthen connections over time:

```json
{
  "plugins": {
    "tool-hooks": {
      "hooks": [
        {
          "tool": "memory_search",
          "command": "cd /path/to/workspace && node memory/brain.js query \"$(echo $TOOL_PARAMS | jq -r .query)\" --track-only",
          "background": true,
          "onlyOnSuccess": true
        }
      ]
    }
  }
}
```
