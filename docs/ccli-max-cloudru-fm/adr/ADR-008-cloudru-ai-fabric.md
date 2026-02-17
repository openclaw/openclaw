# ADR-008: Cloud.ru AI Fabric Bounded Context

| Field      | Value                                         |
| ---------- | --------------------------------------------- |
| Status     | ACCEPTED                                      |
| Date       | 2026-02-17                                    |
| Depends on | ADR-007 (Cloud.ru A2A Integration — DEFERRED) |

## Context

ADR-007 deferred direct A2A integration with Cloud.ru, recommending a REST API approach as the practical first step. This ADR defines the bounded context, module structure, and API contract for `src/ai-fabric/` — a standalone module that wraps the Cloud.ru AI Agents REST API.

The module covers:

- **IAM token lifecycle** — exchange keyId+secret for a Bearer token, cache it, auto-refresh before expiry
- **Agent CRUD** — create, read, update, delete, suspend, resume agents
- **Agent Systems** — multi-agent orchestration (CRUD, membership)
- **MCP Discovery** — list MCP servers and their tools for integration with OpenClaw's tool chain
- **Instance Types** — list compute tiers for agent provisioning

## Decision

### Bounded Context: `ai-fabric`

The module lives at `src/ai-fabric/` and has **zero coupling** with OpenClaw core. It can be extracted to a standalone package (`@openclaw/ai-fabric`) if needed.

### Aggregates

| Aggregate              | Root Entity     | Responsibility                          |
| ---------------------- | --------------- | --------------------------------------- |
| `CloudruAuth`          | `ResolvedToken` | Token exchange, caching, refresh        |
| `AgentLifecycle`       | `Agent`         | CRUD + status machine                   |
| `AgentSystemLifecycle` | `AgentSystem`   | Multi-agent system CRUD + membership    |
| `McpDiscovery`         | `McpServer`     | MCP server listing and tool enumeration |

### Ports (Interfaces)

| Port                  | Implementation     | Purpose                                       |
| --------------------- | ------------------ | --------------------------------------------- |
| `CloudruClientConfig` | Config object      | Base URL, project ID, timeouts                |
| `CloudruAuthConfig`   | Config object      | keyId + secret for IAM                        |
| HTTP transport        | `fetch` (injected) | All HTTP calls go through `cloudru-client.ts` |

### Anti-Corruption Layer

`cloudru-client.ts` isolates the external Cloud.ru API surface from internal domain models:

- Maps Cloud.ru JSON responses to typed interfaces
- Normalizes error responses to `CloudruApiError`
- Handles retry with exponential backoff (reusing `retryAsync` from `src/infra/retry.ts`)

### Module Structure

```
src/ai-fabric/
  constants.ts              — API base URLs, default timeouts
  types.ts                  — All TypeScript types and enums
  cloudru-auth.ts           — IAM token exchange + cache
  cloudru-client.ts         — Generic HTTP client (fetch + retry + auth)
  cloudru-agents-client.ts  — Agent CRUD operations
  cloudru-agent-systems-client.ts — Agent System operations
  cloudru-mcp-client.ts     — MCP server discovery
  index.ts                  — Barrel exports
```

### API Endpoints Covered

All paths relative to `https://ai-agents.api.cloud.ru/api/v1`:

**Agents**: `GET|POST /{projectId}/agents`, `GET|PATCH|DELETE /{projectId}/agents/{agentId}`, `PATCH /{projectId}/agents/suspend/{agentId}`, `PATCH /{projectId}/agents/resume/{agentId}`

**Agent Systems**: `GET|POST /{projectId}/agentSystems`, `GET|PATCH|DELETE /{projectId}/agentSystems/{agentSystemId}`, suspend/resume, add/remove agent

**MCP**: `GET /{projectId}/mcpServers`

**Instance Types**: `GET /{projectId}/instanceTypes`

### Authentication Flow

1. Exchange `keyId` + `secret` at `POST https://iam.api.cloud.ru/api/v1/auth/token`
2. Cache token until `expiresAt - 5min`
3. On cache miss or near-expiry, re-exchange automatically
4. Pass `Authorization: Bearer <token>` on every API call

### Quality Attributes

- **Testability**: All HTTP calls go through injected `fetch`, enabling mock-based unit tests
- **Retry**: Exponential backoff with jitter, reusing `retryAsync`
- **Isolation**: No imports from OpenClaw core except `src/infra/` utilities
- **Type Safety**: Strict TypeScript types for all API shapes; no `any`

## Consequences

- OpenClaw gains programmatic access to Cloud.ru AI Agents without tight coupling
- The module can later power: agent provisioning wizard, MCP auto-discovery, agent status monitoring
- SSE chat (`POST {agentUrl}/sse`) is deferred to a follow-up — this ADR covers REST management only
- Marketplace endpoints (`/marketplace/*`) are deferred — not needed for core integration
- Bulk operations (bulk delete/suspend/resume) are deferred for simplicity
