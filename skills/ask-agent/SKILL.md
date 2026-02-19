---
name: ask-agent
description: >-
  Send a message to a Cloud.ru AI Agent via A2A protocol and display the response.
  Trigger phrases: "ask agent", "send to agent", "delegate to agent",
  "query agent", "talk to agent", "forward to agent".
---

# Ask Cloud.ru AI Agent

Send a message to a Cloud.ru AI Agent via the A2A (Agent-to-Agent) protocol.

## Prerequisites

1. **AI Fabric enabled** — `aiFabric.enabled: true` in `openclaw.json`
2. **IAM credentials** — `aiFabric.keyId` in config + `CLOUDRU_IAM_SECRET` in `.env`
3. **Agents configured** — at least one entry in `aiFabric.agents[]`

## Usage

```
/ask-agent <agent-name-or-id> <message>
```

Examples:

- `/ask-agent code-reviewer Review this function for bugs`
- `/ask-agent data-analyst What are the top 5 sales trends?`
- `/ask-agent summarizer Summarize the latest project updates`

## Workflow

### Step 1 — Read config and validate

```typescript
import { loadConfig } from "../src/config/io.js";

const config = loadConfig();
const aiFabric = config.aiFabric;
```

**Validate in order:**

1. If `!aiFabric?.enabled` → reply:
   > AI Fabric is not enabled. Run `openclaw onboard` and select Cloud.ru AI Fabric to enable it.
2. If `!aiFabric.keyId` or `!process.env.CLOUDRU_IAM_SECRET` → reply:
   > IAM credentials missing. Set `aiFabric.keyId` in openclaw.json and `CLOUDRU_IAM_SECRET` in your .env file.
3. If `!aiFabric.agents?.length` → reply:
   > No agents configured. Add agents to `aiFabric.agents` in openclaw.json or run `openclaw onboard`.

### Step 2 — Resolve agent

Parse the user input: first token after `/ask-agent` is the agent query, the rest is the message.

Resolve the agent from `aiFabric.agents` using this algorithm:

1. **Exact ID match** — `agents.find(a => a.id === query)`
2. **Exact name match** (case-insensitive) — `agents.find(a => a.name.toLowerCase() === query.toLowerCase())`
3. **Substring match** (case-insensitive) — `agents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))`

**Results:**

- **0 matches** → show all available agents and ask the user to pick:

  > Agent "{query}" not found. Available agents:
  >
  > - `{agent.name}` (ID: {agent.id})
  > - ...

- **1 match** → use it

- **Multiple matches** → show disambiguation list:
  > Multiple agents match "{query}":
  >
  > 1. `{agent.name}` (ID: {agent.id})
  > 2. `{agent.name}` (ID: {agent.id})
  >
  > Please specify the exact agent name or ID.

### Step 3 — Send message via A2A

```typescript
import { CloudruA2AClient } from "../src/ai-fabric/cloudru-a2a-client.js";

const client = new CloudruA2AClient({
  auth: {
    keyId: aiFabric.keyId,
    secret: process.env.CLOUDRU_IAM_SECRET,
  },
});

const result = await client.sendMessage({
  endpoint: agent.endpoint,
  message: userMessage,
});
```

### Step 4 — Format response

Display the agent response with metadata for debugging and multi-turn conversations:

```
**Agent: {agent.name}**

{result.text}

---
_Task ID: {result.taskId} | Session ID: {result.sessionId ?? "n/a"}_
```

If the task state is `"failed"`, prefix with a warning:

```
⚠ Agent returned an error:

{result.text}
```

### Step 5 — Error handling

Handle errors by type. All error classes are already defined — do **not** create new ones.

| Error type        | Source                                                  | How to detect                                | User message                                                                                                            |
| ----------------- | ------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Auth failure**  | `CloudruAuthError` from `src/ai-fabric/cloudru-auth.js` | `err instanceof CloudruAuthError`            | "Could not authenticate with Cloud.ru IAM. Check your `aiFabric.keyId` and `CLOUDRU_IAM_SECRET`."                       |
| **HTTP 401/403**  | `A2AError` from `src/ai-fabric/cloudru-a2a-client.js`   | `err.status === 401 \|\| err.status === 403` | "Access denied to agent '{name}'. Your IAM credentials may lack permission for this agent."                             |
| **HTTP 404**      | `A2AError`                                              | `err.status === 404`                         | "Agent '{name}' not found at {endpoint}. It may have been deleted or the endpoint is wrong."                            |
| **HTTP 502/503**  | `A2AError`                                              | `err.status === 502 \|\| err.status === 503` | "Agent '{name}' is temporarily unavailable (HTTP {status}). It may be starting up (cold start). Try again in a minute." |
| **Timeout**       | `A2AError`                                              | message contains "timed out"                 | "Agent '{name}' did not respond within 30 seconds. The agent may be starting up or overloaded."                         |
| **RPC error**     | `A2AError`                                              | `err.code` is set                            | "Agent '{name}' returned an RPC error (code {code}): {message}"                                                         |
| **Network error** | `A2AError`                                              | fallback                                     | "Cannot reach agent '{name}' at {endpoint}. Check your network connection."                                             |

**After any error, always add the tip:**

> Run `/status-agents {name}` to check the agent's current status.

## Reusable modules

These modules already exist — import them directly, do **not** create new files:

| Module        | Import path                           | Exports used                   |
| ------------- | ------------------------------------- | ------------------------------ |
| A2A client    | `src/ai-fabric/cloudru-a2a-client.js` | `CloudruA2AClient`, `A2AError` |
| IAM auth      | `src/ai-fabric/cloudru-auth.js`       | `CloudruAuthError`             |
| Config loader | `src/config/io.js`                    | `loadConfig`                   |
| Agent types   | `src/config/types.ai-fabric.js`       | `AiFabricAgentEntry`           |

## Agent configuration

Agents are stored in `openclaw.json` under `aiFabric`:

```json
{
  "aiFabric": {
    "enabled": true,
    "projectId": "proj-xxxx",
    "keyId": "key-xxxx",
    "agents": [
      {
        "id": "agent-123",
        "name": "code-reviewer",
        "endpoint": "https://ai-agents.api.cloud.ru/a2a/agent-123"
      },
      {
        "id": "agent-456",
        "name": "data-analyst",
        "endpoint": "https://ai-agents.api.cloud.ru/a2a/agent-456"
      }
    ]
  }
}
```
