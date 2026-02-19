# ADR-011: Agent Status Monitoring Service

| Field      | Value                                                   |
| ---------- | ------------------------------------------------------- |
| Status     | ACCEPTED                                                |
| Date       | 2026-02-17                                              |
| Depends on | ADR-008 (Cloud.ru AI Fabric), ADR-010 (Agent Discovery) |

## Context

After ADR-010 enabled agent discovery during onboarding, `openclaw.json` contains `aiFabric.agents[]` entries with agent IDs, names, and endpoints. However, there is no way to check agent status from messaging channels (Telegram, MAX, Slack) — users must visit the Cloud.ru console manually.

Agents transition through 13+ statuses (`RUNNING`, `SUSPENDED`, `COOLED`, `FAILED`, `DELETED`, etc.) and may drift from the saved configuration (deleted in Cloud.ru, endpoint changed). A reusable service enables both the `/status-agents` skill and future CLI commands, webhook health checks, and gateway endpoints.

## Decision

Introduce a stateless `agent-status` service in the `ai-fabric` bounded context that fetches live agent data from the Cloud.ru API, compares it with the local configuration, and returns a structured result.

### Module Structure

| Layer        | File                                 | Responsibility                  |
| ------------ | ------------------------------------ | ------------------------------- |
| Service      | `src/ai-fabric/agent-status.ts`      | Business logic, drift detection |
| Presentation | `skills/status-agents/SKILL.md`      | LLM skill adapter (thin)        |
| Tests        | `src/ai-fabric/agent-status.test.ts` | Unit tests (~15 scenarios)      |

### Health Model

Map 13 Cloud.ru statuses to 4 health states:

| Health     | Cloud.ru Statuses                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `healthy`  | `RUNNING`                                                                                                       |
| `degraded` | `SUSPENDED`, `COOLED`, `PULLING`, `RESOURCE_ALLOCATION`, `LLM_UNAVAILABLE`, `TOOL_UNAVAILABLE`, `ON_SUSPENSION` |
| `failed`   | `FAILED`, `DELETED`, `IMAGE_UNAVAILABLE`                                                                        |
| `unknown`  | `UNKNOWN`, `ON_DELETION`                                                                                        |

### Drift Detection

- Agent in config but not in API → drift (synthetic `DELETED` status)
- Agent in config but endpoint changed in API → drift warning with reason
- Agent in API but not in config → not drift (created manually, still reported)

### Error Handling

Structured `{ ok: false, errorType, error }` result instead of thrown exceptions:

| Source             | `errorType` | Example                                     |
| ------------------ | ----------- | ------------------------------------------- |
| `CloudruAuthError` | `"auth"`    | IAM auth failed: invalid keyId              |
| `CloudruApiError`  | `"api"`     | Cloud.ru API error (404): project not found |
| Network failure    | `"network"` | ENOTFOUND: getaddrinfo ENOTFOUND ...        |
| Missing config     | `"config"`  | Missing projectId in aiFabric config        |

### Reuse

- `CloudruSimpleClient.listAgents()` for API calls
- `CloudruAuthError`, `CloudruApiError` for error classification
- `describeNetworkError()` for network error formatting
- `renderTable()` for output formatting in the skill

## Consequences

### Positive

- Users can check agent health from any messaging channel via `/status-agents`
- Drift detection catches stale config entries before they cause runtime errors
- Stateless service is reusable in CLI commands, health endpoints, and webhooks
- Structured errors make it easy for LLM skills to render helpful messages

### Negative

- Adds one API call per invocation (paginated, typically fast)
- Health model is a simplification — some Cloud.ru statuses may need finer granularity in the future

### Acceptance Criteria

- AC1: `getAgentStatus()` returns structured result with health, drift, and summary
- AC2: `mapAgentHealth()` correctly maps all 13 Cloud.ru statuses to 4 health states
- AC3: Drift detected when configured agent is deleted or has changed endpoint
- AC4: Auth, API, network, and config errors return structured error objects (not thrown)
- AC5: Optional name filter limits results to matching agents
- AC6: `/status-agents` skill renders table for multiple agents, detail view for single agent
- AC7: Unit tests cover all health mappings, drift scenarios, error types, and filtering
