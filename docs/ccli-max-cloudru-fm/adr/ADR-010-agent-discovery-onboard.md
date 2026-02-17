# ADR-010: A2A Agent Discovery in Onboarding Wizard

| Field      | Value                        |
| ---------- | ---------------------------- |
| Status     | ACCEPTED                     |
| Date       | 2026-02-17                   |
| Depends on | ADR-008 (Cloud.ru AI Fabric) |

## Context

After ADR-008 established the `ai-fabric` bounded context with types for agents (`Agent`, `AiFabricAgentEntry`, `ListAgentsParams`), the onboarding wizard (`openclaw onboard`) only discovers MCP servers. Users must manually edit `openclaw.json` to add `aiFabric.agents[]` entries for A2A communication, which defeats the purpose of the guided wizard.

The `CloudruSimpleClient` already has the generic `get<T>()` method and IAM token exchange. Adding agent discovery follows the same pattern as MCP server discovery.

## Decision

Extend the onboarding wizard to discover Cloud.ru AI Agents after MCP server discovery, using the same `CloudruSimpleClient` and IAM credentials.

### Changes

| Aggregate        | Root Entity      | Change                                        |
| ---------------- | ---------------- | --------------------------------------------- |
| `McpDiscovery`   | `McpServer`      | No change — existing                          |
| `AgentDiscovery` | `Agent`          | **NEW**: wizard auto-discovers RUNNING agents |
| `A2AConfig`      | `AiFabricConfig` | **EXTEND**: `agents[]` populated by wizard    |

### Implementation

1. **`CloudruSimpleClient.listAgents()`** — new method, mirrors `listMcpServers()`, calls `GET /{projectId}/agents` with optional `status` filter
2. **`discoverAgents()`** helper in `setup-ai-fabric.ts` — spinner + client call + filter to agents with `endpoint` defined
3. **Interactive flow** — after MCP multiselect, shows agent multiselect (all pre-selected)
4. **Non-interactive flow** — auto-discovers all RUNNING agents with endpoints
5. **`applyAiFabricConfig()`** — extended to write `agents` array to config

### Flow

```
MCP Discovery → MCP Multiselect → Agent Discovery → Agent Multiselect → Write Config
```

### Error Handling

- API errors during agent discovery are caught and logged; the wizard continues without agents
- Agents without `endpoint` are filtered out (not yet deployed or suspended)

## Consequences

### Positive

- Users get agent discovery for free during onboarding — no manual JSON editing
- Reuses existing `CloudruSimpleClient` and IAM auth — no new dependencies
- Pattern is consistent with MCP server discovery (same helper shape)
- Non-interactive flow enables CI/CD automation

### Negative

- Adds ~50 LOC to `setup-ai-fabric.ts` (acceptable for a wizard step)
- Two sequential API calls (MCP servers + agents) during onboarding (both fast, paginated)

### Acceptance Criteria

- AC1: `CloudruSimpleClient.listAgents()` calls `GET /{projectId}/agents` with pagination
- AC2: Interactive wizard shows multiselect of RUNNING agents with endpoints
- AC3: Selected agents are written to `aiFabric.agents[]` in `openclaw.json`
- AC4: Non-interactive flow auto-discovers all RUNNING agents with endpoints
- AC5: If no agents found, wizard shows informative message and continues
- AC6: API errors during discovery are caught and don't block the rest of onboarding
