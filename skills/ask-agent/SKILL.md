---
name: ask-agent
description: >-
  Send a message to a Cloud.ru AI Agent via A2A protocol and display the response.
  Trigger phrases: "ask agent", "send to agent", "delegate to agent",
  "query agent", "talk to agent", "forward to agent".
---

# Ask Cloud.ru AI Agent

Send a message to a Cloud.ru AI Agent via the A2A (Agent-to-Agent) protocol.
Agents are discovered automatically from the Cloud.ru AI Fabric project — no need to configure them manually.

## Prerequisites

1. **AI Fabric enabled** — `aiFabric.enabled: true` in `openclaw.json`
2. **IAM credentials** — `aiFabric.keyId` in config + `CLOUDRU_IAM_SECRET` in env
3. **Project ID** — `aiFabric.projectId` in config

## Usage

```
/ask-agent <agent-name-or-id> <message>
```

Examples:

- `/ask-agent weather-agent What is the weather in Moscow?`
- `/ask-agent web-search-agent Find the latest news about AI`
- `/ask-agent sre-agent Check production status`

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
3. If `!aiFabric.projectId` → reply:
   > Project ID missing. Set `aiFabric.projectId` in openclaw.json.

### Step 2 — Discover agents from Cloud.ru API

**Do NOT look up agents from `aiFabric.agents[]` in config.** Instead, discover them dynamically:

```typescript
import { CloudruSimpleClient } from "../src/ai-fabric/cloudru-client-simple.js";

const client = new CloudruSimpleClient({
  projectId: aiFabric.projectId,
  auth: {
    keyId: aiFabric.keyId,
    secret: process.env.CLOUDRU_IAM_SECRET,
  },
});

const result = await client.listAgents({ limit: 100 });
const allAgents = result.data;

// Filter out deleted agents
const agents = allAgents.filter(
  (a) => a.status !== "DELETED" && a.status !== "AGENT_STATUS_DELETED",
);
```

### Step 3 — Resolve agent by name or ID

Parse the user input: first token after `/ask-agent` is the agent query, the rest is the message.

Resolve the agent from discovered agents:

1. **Exact ID match** — `agents.find(a => a.id === query)`
2. **Exact name match** (case-insensitive) — `agents.find(a => a.name.toLowerCase() === query.toLowerCase())`
3. **Substring match** (case-insensitive) — `agents.filter(a => a.name.toLowerCase().includes(query.toLowerCase()))`

**Results:**

- **0 matches** → show all available agents and ask the user to pick:

  > Agent "{query}" not found. Available agents:
  >
  > - `{agent.name}` — {agent.status} (ID: {agent.id})
  > - ...

- **1 match** → use it

- **Multiple matches** → show disambiguation list:
  > Multiple agents match "{query}":
  >
  > 1. `{agent.name}` — {agent.status}
  > 2. `{agent.name}` — {agent.status}
  >
  > Please specify the exact agent name or ID.

### Step 4 — Send message via A2A

The agent's public URL comes from the `publicUrl` field of the agent object.

```typescript
import { CloudruA2AClient } from "../src/ai-fabric/cloudru-a2a-client.js";

const client = new CloudruA2AClient({
  auth: {
    keyId: aiFabric.keyId,
    secret: process.env.CLOUDRU_IAM_SECRET,
  },
});

const result = await client.sendMessage({
  endpoint: agent.publicUrl, // from Cloud.ru API, NOT from config
  message: userMessage,
});
```

### Step 5 — Format response

Display the agent response with metadata:

```
**Agent: {agent.name}**

{result.text}

---
_Task ID: {result.taskId} | Context: {result.sessionId ?? "n/a"}_
```

If the task state is `"failed"`, prefix with a warning:

```
⚠ Agent returned an error:

{result.text}
```

### Step 6 — Error handling

Handle errors by type. All error classes are already defined — do **not** create new ones.

| Error type        | Source                                                  | How to detect                                | User message                                                                                                            |
| ----------------- | ------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Auth failure**  | `CloudruAuthError` from `src/ai-fabric/cloudru-auth.js` | `err instanceof CloudruAuthError`            | "Could not authenticate with Cloud.ru IAM. Check your `aiFabric.keyId` and `CLOUDRU_IAM_SECRET`."                       |
| **HTTP 401/403**  | `A2AError` from `src/ai-fabric/cloudru-a2a-client.js`   | `err.status === 401 \|\| err.status === 403` | "Access denied to agent '{name}'. Your IAM credentials may lack permission for this agent."                             |
| **HTTP 404**      | `A2AError`                                              | `err.status === 404`                         | "Agent '{name}' not found at {endpoint}. It may have been deleted."                                                     |
| **HTTP 502/503**  | `A2AError`                                              | `err.status === 502 \|\| err.status === 503` | "Agent '{name}' is temporarily unavailable (HTTP {status}). It may be starting up (cold start). Try again in a minute." |
| **Timeout**       | `A2AError`                                              | message contains "timed out"                 | "Agent '{name}' did not respond within 30 seconds. The agent may be starting up or overloaded."                         |
| **RPC error**     | `A2AError`                                              | `err.code` is set                            | "Agent '{name}' returned an RPC error (code {code}): {message}"                                                         |
| **Network error** | `A2AError`                                              | fallback                                     | "Cannot reach agent '{name}' at {endpoint}. Check your network connection."                                             |

**After any error, always add the tip:**

> Run `/status-agents` to check agent statuses.

## Reusable modules

These modules already exist — import them directly, do **not** create new files:

| Module        | Import path                              | Exports used                   |
| ------------- | ---------------------------------------- | ------------------------------ |
| A2A client    | `src/ai-fabric/cloudru-a2a-client.js`    | `CloudruA2AClient`, `A2AError` |
| Simple client | `src/ai-fabric/cloudru-client-simple.js` | `CloudruSimpleClient`          |
| IAM auth      | `src/ai-fabric/cloudru-auth.js`          | `CloudruAuthError`             |
| Config loader | `src/config/io.js`                       | `loadConfig`                   |

## Key architecture notes

- **Agents are NOT stored in config** — they are discovered dynamically from the Cloud.ru management API
- **The `publicUrl` field** from the management API response is the A2A endpoint (e.g., `https://{agent-id}-agent.ai-agent.inference.cloud.ru`)
- **A2A protocol v0.3.0** — uses `message/send` method (not `tasks/send`)
- **Agent statuses**: RUNNING (healthy), COOLED (sleeping, wakes on request), FAILED (broken), DELETED (gone)
