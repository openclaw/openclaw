---
summary: "A2A Protocol plugin: Agent Card discovery + JSON-RPC task execution for cross-framework agent interoperability"
read_when:
  - You want to let external A2A agents discover and call OpenClaw agents
  - You want OpenClaw to join an A2A network as a peer
  - You are configuring the bundled A2A plugin
title: "A2A Protocol plugin"
---

The A2A plugin adds standard [A2A protocol](https://a2aproject.github.io/A2A/)
endpoints to the OpenClaw Gateway, so any A2A-compatible agent (Claude, Gemini,
Hermes, LangChain, etc.) can discover OpenClaw agents and send them tasks
through a standardized JSON-RPC interface.

## Where it runs

The A2A plugin runs on the Gateway process. No agent-side setup needed.

## What you get

Three endpoints mounted on your Gateway:

| Endpoint | Method | Purpose |
|---|---|---|
| `/.well-known/agent.json` | GET | Agent Card discovery |
| `/a2a/tasks/send` | POST (JSON-RPC) | Task execution |
| `/a2a/tasks/<taskId>` | GET | Task status |

## Enable the plugin

```json5
{
  plugins: {
    entries: {
      a2a: {
        enabled: true,
        config: {
          gatewayUrl: "http://your-gateway-host:18789",
          agents: {
            // expose: ["agent-id-1", "agent-id-2"]   // optional filter; omit = all agents
          },
          auth: {
            mode: "gateway_token",   // "gateway_token" | "none"
          },
        },
      },
    },
  },
}
```

After restarting the Gateway, verify:

```bash
curl -s http://localhost:18789/.well-known/agent.json | jq .
```

## Agent Card

The plugin builds an A2A-compliant Agent Card automatically from your existing
`agents.list[]` config. Each agent becomes a skill; the card advertises the
union of all agents as a single multi-skill A2A node.

```json
{
  "name": "OpenClaw",
  "description": "OpenClaw AI agent — multi-model, multi-channel personal assistant …",
  "url": "http://your-gateway-host:18789",
  "version": "2026.7.0",
  "defaultInputModes": ["text"],
  "defaultOutputModes": ["text"],
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "skills": [
    {
      "id": "my-agent",
      "name": "my-agent",
      "description": "Helpful assistant",
      "tags": ["openclaw"],
      "inputModes": ["text"],
      "outputModes": ["text"]
    }
  ],
  "agents": ["my-agent"]
}
```

## Joining an A2A network

Once the plugin is enabled, your Gateway is an A2A peer. Any other A2A agent on
the network can call it:

```bash
# Another A2A agent discovers your Gateway
curl http://your-gateway:18789/.well-known/agent.json

# Another agent sends a task
curl -X POST http://your-gateway:18789/a2a/tasks/send \
  -H "Content-Type: application/json" \
  -H "X-Gateway-Token: $GATEWAY_TOKEN" \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "tasks/send",
    "params": {
      "message": "Summarize the latest RFC on MCP authorization"
    }
  }'

# Check task status
curl http://your-gateway:18789/a2a/tasks/<taskId>
```

## Calling other A2A agents from OpenClaw

To let your OpenClaw agents call external A2A agents, configure the upstream
peers in your agent's tool config (this part is handled by the Gateway's
built-in HTTP tool support — the A2A plugin does not add outbound A2A calling
yet). See [Agent tools](/plugins/agent-tools) for HTTP tool configuration.

## Task lifecycle

```
submitted → working → completed
                   ↘ failed
                   ↘ canceled  (future)
```

- **submitted** → task received, session created
- **working** → message dispatched to agent
- **completed** / **failed** → agent finished or errored

Task state is tracked in-memory and exposed through `GET /a2a/tasks/<taskId>`.
SSE streaming for real-time state updates is planned for the next release.

## Authentication

| Mode | Behavior |
|---|---|
| `gateway_token` (default) | Requires `X-Gateway-Token` header matching the Gateway's configured token |
| `none` | No auth — open to any caller on the network |

For production, use `gateway_token`. The token is the same one used for Gateway
admin APIs.

## JSON-RPC methods

| Method | Status | Description |
|---|---|---|
| `tasks/send` | ✅ MVP | Send a text message to an agent, get a task ID back |
| `tasks/get` | ✅ MVP | Query task state via REST endpoint |
| `tasks/cancel` | 🔜 planned | Cancel a running task |
| `tasks/pushNotification/set` | 🔜 planned | Register webhook for task state changes |

Batch JSON-RPC requests are supported: send an array of requests and get an
array of responses back.

## Cross-framework example

OpenClaw ↔ Hermes Agent (DeepArchi MAEA):

```
Hermes (sg agent, port :9900)  ←→  OpenClaw Gateway (port :18789)
     │                                       │
     │  curl :18789/.well-known/agent.json   │
     │──────────────────────────────────────→│  "I see OpenClaw agents"
     │                                       │
     │  POST :18789/a2a/tasks/send           │
     │──────────────────────────────────────→│  "Please analyze this data"
     │                                       │
     │  GET :18789/a2a/tasks/<id>            │
     │←──────────────────────────────────────│  { state: "completed" }
```

## Current limits (MVP)

- **Text-only** — images, files, and structured data are not yet passed as A2A
  `message.parts[]`.
- **In-memory task store** — tasks are lost on Gateway restart.
- **No outbound A2A** — the plugin registers inbound endpoints only. Use
  Gateway HTTP tools to call external A2A agents.
- **Single Agent Card** — all agents are exposed as skills under one Card.
  Multi-card (one per agent) is planned.
- **No SSE streaming** — `tasks/get` is poll-based. SSE push and
  `tasks/pushNotification/set` are planned for the next release.

## Troubleshooting

**Agent Card returns 404**
→ Plugin not enabled. Check `plugins.entries.a2a.enabled: true`.

**tasks/send returns 401**
→ Auth mode is `gateway_token` but header is missing or wrong. Add
`X-Gateway-Token: <your-token>`.

**Task stuck in "working"**
→ The agent is still processing or the Gateway session was lost. Check Gateway
logs for session errors.
