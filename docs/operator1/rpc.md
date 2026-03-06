---
summary: "Gateway RPC methods reference for Operator1 — existing methods, planned Matrix RPCs, and how to add new endpoints."
title: "RPC Reference"
---

# RPC Reference

The OpenClaw gateway exposes a WebSocket JSON-RPC interface for managing configuration, agents, sessions, memory, and system health. Operator1 and its agents interact with the gateway through these RPC methods.

## Connection

The gateway listens on `ws://127.0.0.1:18789` by default. All RPC calls use the JSON-RPC 2.0 protocol over WebSocket.

```json
{
  "jsonrpc": "2.0",
  "method": "method.name",
  "params": {},
  "id": 1
}
```

## Existing gateway RPCs

### Config

| Method         | Description                 | Params               |
| -------------- | --------------------------- | -------------------- |
| `config.get`   | Get current configuration   | `{ path?: string }`  |
| `config.patch` | Update configuration values | `{ ops: PatchOp[] }` |

### Models

| Method        | Description           | Params |
| ------------- | --------------------- | ------ |
| `models.list` | List available models | `{}`   |

### Agents

| Method              | Description                   | Params                                               |
| ------------------- | ----------------------------- | ---------------------------------------------------- |
| `agents.files.list` | List agent workspace files    | `{ agentId: string }`                                |
| `agents.files.get`  | Read an agent workspace file  | `{ agentId: string, file: string }`                  |
| `agents.files.set`  | Write an agent workspace file | `{ agentId: string, file: string, content: string }` |

### Sessions

| Method             | Description                     | Params                                                                          |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------------- |
| `sessions.list`    | List active and recent sessions | `{ agentId?: string }`                                                          |
| `sessions.spawn`   | Spawn a new agent session       | `{ agentId: string, task: string, label?: string, runTimeoutSeconds?: number }` |
| `sessions.history` | Get session message history     | `{ sessionId: string }`                                                         |

### Memory

| Method           | Description                | Params                                                |
| ---------------- | -------------------------- | ----------------------------------------------------- |
| `memory.status`  | Get memory provider status | `{ agentId?: string }`                                |
| `memory.search`  | Search agent memory        | `{ agentId?: string, query: string, limit?: number }` |
| `memory.reindex` | Trigger memory reindexing  | `{ agentId?: string }`                                |

### System

| Method       | Description          | Params |
| ------------ | -------------------- | ------ |
| `health`     | Gateway health check | `{}`   |
| `update.run` | Run system update    | `{}`   |

### Wizard

| Method          | Description             | Params                |
| --------------- | ----------------------- | --------------------- |
| `wizard.start`  | Start onboarding wizard | `{}`                  |
| `wizard.next`   | Advance wizard step     | `{ answer?: string }` |
| `wizard.cancel` | Cancel active wizard    | `{}`                  |
| `wizard.status` | Get wizard state        | `{}`                  |

## Planned Matrix RPCs

These RPCs are planned to support Matrix-specific operations:

| Method              | Purpose                                               | Priority |
| ------------------- | ----------------------------------------------------- | -------- |
| `projects.add`      | Register a new project with context                   | High     |
| `projects.scaffold` | Create project directory structure                    | High     |
| `projects.list`     | List all registered projects                          | Medium   |
| `agents.spawn`      | Structured agent spawning with hierarchy validation   | Medium   |
| `memory.sync`       | Force memory consolidation across agents              | Low      |
| `health.matrix`     | Matrix-specific health check (all agents, workspaces) | Low      |

## RPC vs script boundaries

Use the right tool for the job:

| Use RPC when                | Use a script when         |
| --------------------------- | ------------------------- |
| Real-time response needed   | Batch or async processing |
| UI integration required     | File system operations    |
| Gateway state access needed | External tool invocation  |
| Low latency is critical     | Long-running operations   |
| Multi-agent coordination    | Local validation only     |

## Adding new RPCs

To add a new RPC method to the gateway:

### 1. Define the method

Create a new file in `src/gateway/server-methods/`:

```typescript
// src/gateway/server-methods/my-method.ts
import type { MethodDeps } from "./types.js";

interface MyMethodParams {
  agentId?: string;
  // ... other params
}

interface MyMethodResponse {
  // ... response fields
}

export async function myMethod(
  deps: MethodDeps,
  params: MyMethodParams,
): Promise<MyMethodResponse> {
  // Implementation
  return {
    /* response */
  };
}
```

### 2. Add TypeScript interfaces

Define request and response types. Keep params minimal and responses structured.

### 3. Register in the gateway

Add the method to the gateway's method map so it's routable via JSON-RPC.

### 4. Document

Add the method to this reference page and to `docs/gateway/rpc.md` if it's a general-purpose method.

### Example: memory.status

```typescript
export async function memoryStatus(
  deps: MethodDeps,
  params: { agentId?: string },
): Promise<MemoryProviderStatus> {
  const agentId = params.agentId || deps.config.agents.defaults?.defaultAgent || "main";
  const manager = deps.memoryManagers.get(agentId);
  if (!manager) throw new Error(`No memory manager for ${agentId}`);
  return manager.getStatus();
}
```

## Related

- [Architecture](/operator1/architecture) — system design overview
- [Sub-Agent Spawning](/operator1/spawning) — how `sessions.spawn` is used in practice
- [Configuration](/operator1/configuration) — config RPC usage and hot reload
