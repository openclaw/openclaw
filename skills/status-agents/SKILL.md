---
name: status-agents
description: Check the live status of Cloud.ru AI Fabric agents and compare with local config. Use when a user wants to see agent health, detect configuration drift, or verify that agents are running before sending requests. Triggers on questions like "are my agents running?", "check agent status", "which agents are healthy?".
---

# Check Cloud.ru AI Fabric Agent Status

Show the live status of Cloud.ru AI Fabric agents, comparing the Cloud.ru API state with the local `openclaw.json` configuration.

## Prerequisites

- Cloud.ru AI Fabric must be configured (`aiFabric.enabled: true` in `openclaw.json`)
- IAM credentials must be available (`aiFabric.keyId` + `CLOUDRU_IAM_SECRET` env var)
- A `projectId` must be set in `aiFabric.projectId`

## Usage

```
/status-agents [agent-name]
```

Examples:

- `/status-agents` — show all agents
- `/status-agents code-reviewer` — show only agents matching "code-reviewer"

## Workflow

### 1. Read config and credentials

```typescript
import { readConfig } from "../config/config.js";

const config = await readConfig();
const aiFabric = config.aiFabric;

if (!aiFabric?.enabled) {
  // Tell user: "AI Fabric is not enabled. Run `openclaw onboard` to configure."
}

const projectId = aiFabric?.projectId ?? "";
const keyId = aiFabric?.keyId ?? "";
const secret = process.env.CLOUDRU_IAM_SECRET ?? "";
const configuredAgents = aiFabric?.agents ?? [];
```

### 2. Call the agent status service

```typescript
import { getAgentStatus } from "../src/ai-fabric/agent-status.js";

const result = await getAgentStatus({
  projectId,
  auth: { keyId, secret },
  configuredAgents,
  nameFilter: args[0], // optional agent name from user input
});
```

### 3. Handle errors

If `result.ok === false`, show an error message based on `result.errorType`:

- **`"config"`**: "Configuration incomplete: {result.error}. Run `openclaw onboard` to set up AI Fabric."
- **`"auth"`**: "Authentication failed: {result.error}. Check your `aiFabric.keyId` and `CLOUDRU_IAM_SECRET`."
- **`"api"`**: "Cloud.ru API error: {result.error}"
- **`"network"`**: "Network error: {result.error}. Check your internet connection and Cloud.ru API availability."

### 4. Render results

#### Multiple agents — table view

Use `renderTable` from `src/terminal/table.ts`:

```typescript
import { renderTable } from "../src/terminal/table.ts";

const table = renderTable({
  columns: [
    { key: "name", header: "Agent", flex: true },
    { key: "status", header: "Status", minWidth: 10 },
    { key: "health", header: "Health", minWidth: 8 },
    { key: "configured", header: "Config", minWidth: 6 },
    { key: "drift", header: "Drift", minWidth: 5 },
  ],
  rows: result.entries.map((e) => ({
    name: e.name,
    status: e.status,
    health:
      e.health === "healthy"
        ? "✓ healthy"
        : e.health === "degraded"
          ? "⚠ degraded"
          : e.health === "failed"
            ? "✗ failed"
            : "? unknown",
    configured: e.configured ? "yes" : "no",
    drift: e.drift ? "⚠ yes" : "no",
  })),
});
```

#### Single agent — detail view

If there is exactly one entry (either from filter or only one agent exists), show a detailed view:

```
**Agent: {entry.name}** (ID: {entry.id})
- Status: {entry.status}
- Health: {entry.health}
- Endpoint: {entry.endpoint ?? "none"}
- Configured: {entry.configured ? "yes" : "no"}
- Drift: {entry.drift ? "⚠ " + entry.driftReason : "none"}
```

### 5. Show summary

After the table or detail view, always show a summary line:

```
Summary: {summary.total} agents — {summary.healthy} healthy, {summary.degraded} degraded, {summary.failed} failed, {summary.unknown} unknown
```

### 6. Show drift warnings

If any entry has `drift: true`, add a warning section:

```
⚠ Configuration drift detected:
- {entry.name}: {entry.driftReason}

Run `openclaw onboard` to update your agent configuration.
```

## Error handling

- **IAM auth failure**: "Could not authenticate with Cloud.ru IAM. Check your keyId and CLOUDRU_IAM_SECRET."
- **API error**: "Cloud.ru API returned an error: {details}. The project may not exist or your credentials may lack access."
- **Network error**: "Cannot reach Cloud.ru API: {details}. Check your network connection."
- **No agents found**: "No agents found in project {projectId}. Deploy agents in the Cloud.ru console or run `openclaw onboard`."
- **AI Fabric not configured**: "AI Fabric is not enabled. Run `openclaw onboard` and select Cloud.ru AI Fabric to get started."
