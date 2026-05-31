---
summary: "Versioned Agent OS ticket, capability, proof, artifact, lifecycle, and security contracts"
read_when:
  - You are building a native capability agent
  - You are adapting an external agent framework into OpenClaw
  - You need the stable Blackboard, proof, artifact, or sandbox contract
title: "Agent OS contract"
---

The Agent OS contract is the stable boundary between the local scheduler, native OpenClaw agents, sidecars, and future framework adapters. It defines the objects that can cross the Blackboard, signal-hub, proof, artifact, and sandbox boundaries without coupling adapters to internal script details.

Use these contracts when you build a native capability agent or wrap an external runtime such as a graph, crew, coding worker, or browser operator.

## Current schemas

| Contract             | Schema version                 | Canonical producer                            |
| -------------------- | ------------------------------ | --------------------------------------------- |
| Ticket               | `agent-os.ticket.v1`           | `scripts/docker/sidecars/blackboard-cli.cjs`  |
| Capability manifest  | `agent-os.capability.v1`       | `scripts/agents/capability-agent-profile.mjs` |
| Proof event          | `agent-os.proof-event.v1`      | `scripts/lib/proof-events.cjs`                |
| Artifact             | `agent-os.artifact.v1`         | `scripts/agents/capability-proof-kit.mjs`     |
| Sandbox and security | `agent-os.sandbox-security.v1` | Capability manifests and sandbox providers    |

The runtime validators live in `scripts/lib/agent-os-contracts.cjs`. New native agents and adapters should use those helpers rather than copying enum lists.

## Ticket contract

Tickets are the durable task unit. Blackboard stores legacy columns for compatibility, but every new ticket can be normalized into `agent-os.ticket.v1`.

```json
{
  "schemaVersion": "agent-os.ticket.v1",
  "id": "ticket-1",
  "type": "research",
  "title": "Compare local agent runtimes",
  "priority": 7,
  "status": "OPEN",
  "targetAgent": "research_agent",
  "capabilityFamily": "research",
  "input": {
    "query": "best local-first agent operating system contract"
  },
  "constraints": {
    "network": "allowlist"
  },
  "proofRequired": ["proof-events-bundle"],
  "createdAt": "2026-05-31T08:00:00.000Z",
  "updatedAt": "2026-05-31T08:00:00.000Z",
  "ttlMinutes": 60
}
```

Supported ticket statuses are `OPEN`, `CLAIMED`, `IN_PROGRESS`, `WAITING_APPROVAL`, `BLOCKED`, `DONE`, `FAILED`, and `ARCHIVED`. The validator maps `RUNNING` to `IN_PROGRESS` so adapters can use the common wording while Blackboard keeps its existing storage value.

## Capability manifest

Capability manifests describe what an agent can claim, how it runs, which tools it can use, and which proof it must emit. Native OpenClaw agents are the reference implementation.

```json
{
  "schemaVersion": "agent-os.capability.v1",
  "id": "research_agent",
  "name": "Research Agent",
  "version": "1.0.0",
  "runtime": "native-openclaw",
  "capabilityFamilies": ["research"],
  "ticketTypes": ["research", "web_research", "citation_answer"],
  "tools": {
    "allow": ["semantic-code-retrieval", "gitcrawl"],
    "deny": []
  },
  "sandbox": {
    "schemaVersion": "agent-os.sandbox-security.v1",
    "mode": "workspace-read",
    "network": "allowlist",
    "filesystem": "read",
    "secrets": "named-refs-only",
    "hostBridge": false,
    "approvals": []
  },
  "proof": {
    "required": true,
    "commands": ["proof-events-bundle"]
  },
  "artifacts": {
    "kinds": ["proof-bundle", "json", "markdown"]
  },
  "lifecycle": {
    "heartbeatSeconds": 30,
    "timeoutSeconds": 900,
    "retryLimit": 0
  }
}
```

Adapters must target this manifest shape. Do not expose framework-specific scheduler fields directly to signal-hub.

## Proof event contract

Proof events are the system journal for autonomous work. A ticket can only make a durable claim when the responsible agent or sidecar emits proof.

```json
{
  "schemaVersion": "agent-os.proof-event.v1",
  "ticketId": "ticket-1",
  "runId": "run-1",
  "agentId": "research_agent",
  "component": "signal-hub",
  "eventType": "TICKET.CLAIMED",
  "status": "PASS",
  "message": "Research Agent claimed the ticket",
  "data": {
    "routingMode": "ticket-type"
  },
  "artifactRefs": [],
  "createdAt": "2026-05-31T08:00:10.000Z"
}
```

Supported proof statuses are `INFO`, `PASS`, `WARN`, `FAIL`, and `ACTION`.

## Artifact contract

Artifacts carry the evidence behind a result. The contract records the kind, location, redaction state, creator, and optional hash.

```json
{
  "schemaVersion": "agent-os.artifact.v1",
  "id": "artifact-1",
  "ticketId": "ticket-1",
  "runId": "run-1",
  "kind": "proof-bundle",
  "path": ".artifacts/capability-proofs/ticket-1/proof-events-bundle.json",
  "mediaType": "application/json",
  "sha256": null,
  "createdBy": "research_agent",
  "visibility": "local",
  "redaction": {
    "status": "not-needed"
  },
  "createdAt": "2026-05-31T08:00:20.000Z"
}
```

Artifacts should use repo-relative paths when they are written inside the checkout. External object-store URLs should be represented as artifact metadata, not as secret-bearing local paths.

## Lifecycle contract

The ticket lifecycle is:

```text
OPEN -> CLAIMED -> IN_PROGRESS -> DONE
OPEN -> CLAIMED -> IN_PROGRESS -> WAITING_APPROVAL -> IN_PROGRESS -> DONE
OPEN -> CLAIMED -> IN_PROGRESS -> BLOCKED
OPEN -> CLAIMED -> IN_PROGRESS -> FAILED
OPEN -> ARCHIVED
```

Agent lifecycle is:

```text
REGISTERED -> IDLE -> CLAIMING -> RUNNING -> IDLE
REGISTERED -> DEGRADED
REGISTERED -> OFFLINE
```

Adapters should report lifecycle through proof events and ticket transitions. They should not invent terminal states outside the contract.

## Sandbox and security contract

Every capability manifest must declare a sandbox and security policy. Dangerous host-native agents should fail closed when the contract is missing.

Supported sandbox modes:

| Mode              | Meaning                                                       |
| ----------------- | ------------------------------------------------------------- |
| `off`             | No sandbox. Use only for trusted local agents.                |
| `workspace-read`  | The agent can read the assigned workspace.                    |
| `workspace-write` | The agent can write the assigned workspace.                   |
| `container`       | The agent runs in a container or equivalent isolated runtime. |
| `remote`          | The agent runs through a remote sandbox provider.             |

Supported network policies are `none`, `allowlist`, and `full`. Supported filesystem policies are `none`, `read`, and `workspace-write`. Supported secret policies are `none` and `named-refs-only`.

Host-native bridges must require explicit native-agent configuration and should write dispatch attempts to the proof journal before handing work to the host. Sidecars that only proxy model traffic should not receive channel or auth-profile secret mounts unless they need those named references.

## Validation

Use the shared validators in scripts and tests:

```js
const {
  assertAgentOsCapabilityManifest,
  assertAgentOsTicket,
  validateAgentOsProofEvent,
} = require("./scripts/lib/agent-os-contracts.cjs");
```

Validation returns `{ ok, errors, value }`. The `assert*` helpers throw with actionable field errors.

## Related

- [Capability agents](/tools/capability-agents)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
- [API usage and costs](/reference/api-usage-costs)
