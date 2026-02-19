---
name: status-agents
description: Check the live status of Cloud.ru AI Fabric agents, MCP servers, and agent systems. Agents are discovered automatically from the Cloud.ru API — no local config needed. Use when a user wants to see agent health, list available agents, or check what MCP tools are available. Triggers on questions like "are my agents running?", "check agent status", "which agents are healthy?", "list MCP servers".
---

# Check Cloud.ru AI Fabric Status

Show the live status of Cloud.ru AI Fabric resources: agents, MCP servers, and agent systems.
All resources are discovered automatically from the Cloud.ru management API.

## Prerequisites

- Cloud.ru AI Fabric must be configured (`aiFabric.enabled: true` in `openclaw.json`)
- IAM credentials must be available (`aiFabric.keyId` + `CLOUDRU_IAM_SECRET` env var)
- A `projectId` must be set in `aiFabric.projectId`

## Usage

```
/status-agents [agent-name]
```

Examples:

- `/status-agents` — show all agents, MCP servers, and agent systems
- `/status-agents weather` — show only resources matching "weather"

## Workflow

### 1. Read config and credentials

```typescript
import { loadConfig } from "../src/config/io.js";

const config = loadConfig();
const aiFabric = config.aiFabric;

if (!aiFabric?.enabled) {
  // Tell user: "AI Fabric is not enabled. Run `openclaw onboard` to configure."
}

const projectId = aiFabric?.projectId ?? "";
const keyId = aiFabric?.keyId ?? "";
const secret = process.env.CLOUDRU_IAM_SECRET ?? "";
```

### 2. Discover all resources from Cloud.ru API

```typescript
import { CloudruSimpleClient } from "../src/ai-fabric/cloudru-client-simple.js";

const client = new CloudruSimpleClient({
  projectId,
  auth: { keyId, secret },
});

// Fetch all three resource types in parallel
const [agentsResult, mcpResult] = await Promise.all([
  client.listAgents({ limit: 100 }),
  client.listMcpServers({ limit: 100 }),
]);

// Filter out deleted resources
const agents = agentsResult.data.filter(
  (a) => a.status !== "DELETED" && a.status !== "AGENT_STATUS_DELETED",
);
const mcpServers = mcpResult.data.filter((s) => s.status !== "MCP_SERVER_STATUS_DELETED");
```

### 3. Render agents table

Map agent statuses to health:

| API Status           | Health   | Display   |
| -------------------- | -------- | --------- |
| AGENT_STATUS_RUNNING | healthy  | ✓ running |
| AGENT_STATUS_COOLED  | degraded | ⏸ cooled  |
| AGENT_STATUS_FAILED  | failed   | ✗ failed  |
| Other                | unknown  | ? unknown |

Show table:

```
**Agents ({count})**

| Name | Status | Health | ID |
|------|--------|--------|----|
| weather-agent | RUNNING | ✓ healthy | 66a83b8a... |
| web-search-agent | COOLED | ⏸ cooled | 14f83379... |
```

If agent has a `statusReason` with useful error info (e.g., missing env var), show it below the table.

### 4. Render MCP servers table

```
**MCP Servers ({count})**

| Name | Status | Tools | URL |
|------|--------|-------|-----|
| mcp-server-weather | RUNNING | get_today_weather, get_weekly_forecast | https://...mcp |
| web-searcher-mcp | COOLED | search_web, search_news, +8 more | https://...mcp |
```

For each MCP server, list the `tools[].name` array. If more than 3 tools, show first 3 + `+N more`.

### 5. Show summary

```
Summary: {agents.length} agents ({healthy} healthy, {degraded} degraded, {failed} failed) | {mcpServers.length} MCP servers
```

### 6. Show tips

After the summary, show actionable tips:

- If any agent is COOLED: "⏸ Cooled agents wake up automatically on the first request."
- If any agent is FAILED: "✗ Failed agents need attention in the Cloud.ru console."
- "Use `/ask-agent <name> <message>` to send a message to any agent."

## Error handling

- **IAM auth failure**: "Could not authenticate with Cloud.ru IAM. Check your keyId and CLOUDRU_IAM_SECRET."
- **API error**: "Cloud.ru API returned an error: {details}. The project may not exist or your credentials may lack access."
- **Network error**: "Cannot reach Cloud.ru API: {details}. Check your network connection."
- **No resources found**: "No agents or MCP servers found in project {projectId}. Deploy resources in the Cloud.ru console."

## Key architecture notes

- **All resources are discovered from the API** — nothing is read from `aiFabric.agents[]` in config
- **Management API paths**: `/agents` (with `limit=100`), `/mcpServers` (camelCase, with `limit=100`)
- **Agent public URLs**: `https://{id}-agent.ai-agent.inference.cloud.ru`
- **MCP server public URLs**: `https://{id}-mcp-server.ai-agent.inference.cloud.ru/mcp`
