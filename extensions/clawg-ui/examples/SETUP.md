# Cron Report Demo Setup

This guide walks through setting up a dedicated OpenClaw agent for the Cron Report A2UI demo, accessible via the `X-OpenClaw-Agent-Id` header from an AG-UI client (e.g. the CopilotKit Dojo app).

## Prerequisites

- OpenClaw gateway running with clawg-ui plugin installed
- An approved clawg-ui device (see main README for pairing)
- The `cron` tool enabled globally or for the agent (provides job history)

## 1. Add the agent to `openclaw.json`

Add a new agent entry under `agents.list`:

```json5
{
  "agents": {
    "list": [
      // ... your existing agents ...
      {
        "id": "cron-demo",
        "name": "Cron Demo",
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["cron_report", "cron"]
        }
      }
    ]
  }
}
```

- **`cron_report`** (optional, from clawg-ui plugin) -- wraps run data in A2UI v0.9 cards
- **`cron`** (built-in) -- gives the agent access to `{"action": "runs", "jobId": "..."}` for real cron job history

The `cron_report` tool is registered with `optional: true`, so it only activates for agents that explicitly allow it.

## 2. Add the agent system prompt

Create or edit the workspace bootstrap file for the agent. If using a shared workspace, add to `AGENTS.md`:

```
~/.openclaw/workspace/AGENTS.md
```

Or if the agent has its own workspace directory:

```
~/.openclaw/workspace-cron-demo/AGENTS.md
```

Contents:

```markdown
You are a CI/CD monitoring assistant for scheduled automation runs.

When the user asks about cron jobs, automation runs, or scheduled tasks:
1. Use the `cron` tool with `{"action": "runs", "jobId": "..."}` to retrieve run history
2. Reshape the results into the cron_report schema
3. Call `cron_report` with the results

For each run, gather:
- id: unique run identifier
- startedAt: when the run started (readable format, e.g. "Apr 5, 10:30 AM")
- duration: how long it took (e.g. "2m 14s")
- model: which LLM model was used (e.g. "claude-sonnet-4-6")
- tokensUsed: total tokens consumed (formatted with commas, e.g. "12,847")
- summary: brief description of what the job did and its outcome

IMPORTANT: After calling cron_report, do NOT repeat or summarize the data
in your text response. The tool renders a rich card UI automatically. Just
confirm briefly, e.g. "Here are your recent cron runs."
```

## 3. Route AG-UI requests to the agent

The AG-UI client targets this agent by sending the `X-OpenClaw-Agent-Id` header with each request. No static binding is required.

### How it works

The clawg-ui HTTP handler reads the header at request time:

```
X-OpenClaw-Agent-Id: cron-demo
```

This is passed to `resolveAgentRoute()` as the `accountId`, which matches the agent by ID. The header approach is flexible -- the same device can target different agents per request.

### CopilotKit / Dojo client configuration

In the Dojo app or any CopilotKit `HttpAgent` configuration, set the agent header:

```typescript
const agent = new HttpAgent({
  url: "https://your-server/v1/clawg-ui",
  headers: {
    "Authorization": "Bearer <device-token>",
    "X-OpenClaw-Agent-Id": "cron-demo",
  },
});
```

### Alternative: static binding

If you prefer all clawg-ui traffic to route to this agent (no header needed):

```json5
{
  "bindings": [
    {
      "agentId": "cron-demo",
      "match": { "channel": "clawg-ui", "accountId": "*" }
    }
  ]
}
```

## 4. Optional: identity linking for shared session context

If you want the cron-demo agent to share session context with your identity on other channels (e.g. Telegram), add an identity link:

```json5
{
  "session": {
    "dmScope": "per-peer",
    "identityLinks": {
      "me": ["clawg-ui:<your-device-id>", "telegram:<your-telegram-id>"]
    }
  }
}
```

This means the agent sees prior conversation history from linked channels, so it doesn't start with a blank slate.

## 5. Verify

Restart the gateway to pick up config changes, then send a request:

```bash
curl -X POST https://your-server/v1/clawg-ui \
  -H "Authorization: Bearer <device-token>" \
  -H "Accept: text/event-stream" \
  -H "X-OpenClaw-Agent-Id: cron-demo" \
  -d '{
    "threadId": "test-1",
    "messages": [{"role": "user", "content": "Show me the last 3 cron runs"}]
  }'
```

Expected SSE event sequence:

```
RUN_STARTED
  TOOL_CALL_START   { toolCallName: "cron_report" }
  TOOL_CALL_ARGS    { delta: '{"runs": [...]}' }
  TOOL_CALL_RESULT  { content: '{"a2ui_operations": [...]}' }
  ACTIVITY_SNAPSHOT { activityType: "a2ui-surface", replace: true }
  TOOL_CALL_END
  TEXT_MESSAGE_START
  TEXT_MESSAGE_CONTENT  { delta: "Here are your recent cron runs." }
  TEXT_MESSAGE_END
RUN_FINISHED
```

The Dojo client renders the `ACTIVITY_SNAPSHOT` as interactive cards with startedAt, duration, model, tokens, and summary fields.
