# RFC: AgentRuntime Abstraction

---

**Summary:** Introduce an `AgentRuntime` interface to unify agent execution
**Status:** draft
**Last Updated:** 2026-01-29

---

## Problem

Moltbot executes agents through two distinct code paths:

1. **Embedded Pi Runtime** (`runEmbeddedPiAgent`) - Our agent loop handling model inference, tool execution, and streaming.

2. **CLI Agents** (`runCliAgent`) - External CLI tools (Claude Code, Aider) that have their own agent loops.

These paths share concerns (session management, event emission, abort handling) but implement them independently, causing:

- Inconsistent event emission
- Duplicated session lifecycle logic
- Fragmented error handling
- Difficulty testing without real inference

## Goals

1. **Unified Interface** - Single `AgentRuntime` interface that both paths implement
2. **Consistent Events** - All runs emit the same lifecycle events (`start`, `end`, `error`)
3. **Centralized Orchestration** - Fallback, retry, and error handling in one place
4. **Testability** - Mock runtimes for unit tests

## Non-Goals

- Replacing Pi runtime internals (this defines the boundary, not the guts)
- Changing external APIs (gateway RPC, CLI commands unchanged)
- Unifying daemon management (`GatewayServiceRuntime` stays separate)

## Design

### Core Interface

```typescript
export interface AgentRuntime {
  readonly id: string;

  run(params: AgentRunParams): Promise<AgentRunResult>;
  abort(runId: string): Promise<void>;
  isRunActive(runId: string): boolean;
}

export interface AgentRunParams {
  runId: string;
  sessionId: string;
  prompt: string;
  provider: string; // Model provider (anthropic, openai, ollama, etc.)
  model: string;
  config: MoltbotConfig;
  workspaceDir: string;
  agentDir: string;
  onEvent?: (event: AgentEvent) => void;
  abortSignal?: AbortSignal;
  // ... other existing params
}

export interface AgentRunResult {
  payloads: ReplyPayload[];
  usage?: AgentUsage;
  meta: AgentRunMeta;
}

export interface AgentRunMeta {
  status: "success" | "error" | "aborted";
  sessionId: string;
  durationMs: number;
  error?: { kind: string; message: string; retryable: boolean };
}
```

### Events

```typescript
export type AgentEvent =
  | { type: "run:start"; runId: string; sessionId: string }
  | { type: "run:end"; runId: string; status: string; durationMs: number }
  | { type: "run:error"; runId: string; error: AgentRunMeta["error"] }
  | { type: "tool:start"; runId: string; toolName: string; toolId: string }
  | { type: "tool:end"; runId: string; toolName: string; toolId: string; durationMs: number }
  | { type: "assistant:chunk"; runId: string; content: string }
  | { type: "assistant:message"; runId: string; content: string };
```

### Runtime Selection

No registry needed. A simple function determines which runtime to use:

```typescript
export function getRuntime(config: MoltbotConfig): AgentRuntime {
  // Check if config specifies using an external CLI agent
  if (config.agent?.useCliAgent) {
    return cliRuntime;
  }
  return piEmbeddedRuntime;
}
```

The choice is about **who owns the agent loop**, not which model provider is used:

| Runtime       | When to use                                     |
| ------------- | ----------------------------------------------- |
| `pi-embedded` | Moltbot orchestrates (default)                  |
| `cli`         | External CLI owns the loop (Claude Code, Aider) |

Provider (Anthropic, OpenAI, Ollama) is orthogonal - it's just which API the runtime calls for inference.

### Orchestration

The orchestrator wraps any runtime with fallback/retry logic:

```typescript
export async function executeAgentRun(
  runtime: AgentRuntime,
  params: AgentRunParams,
  fallbacks?: Array<{ provider: string; model: string }>,
): Promise<AgentRunResult> {
  // 1. Try primary model
  // 2. On retryable error, retry with backoff
  // 3. On non-retryable error, try fallback models
  // 4. Emit consistent events throughout
}
```

## File Organization

```
src/agents/runtime/
  types.ts          # AgentRuntime interface, events, params
  orchestrator.ts   # executeAgentRun with fallback/retry
  pi-embedded.ts    # Wraps runEmbeddedPiAgent
  cli.ts            # Wraps runCliAgent
  index.ts          # Exports
```

## Migration

1. **Define types** - Create interface, wrap existing functions
2. **Add orchestrator** - Extract fallback logic from `agent-runner-execution.ts`
3. **Normalize events** - Ensure both runtimes emit consistent events
4. **Update call sites** - Use `executeAgentRun` instead of direct calls

Each phase keeps existing tests passing.

## Alternatives Considered

**Keep current structure** - Accept duplication. Rejected: cost grows with each change.

**Merge into Pi runtime** - Make CLI a special case inside Pi. Rejected: conflates concerns; CLI tools have fundamentally different session semantics.

## Open Questions

1. **Streaming interface** - Callbacks (`onEvent`) vs async iterators? Callbacks match existing patterns.

2. **Mid-run steering** - Should `queueMessage(runId, message)` be on the interface? CLI runtimes can't support it. Maybe optional or separate interface.

---

_Feedback welcome on interface design and migration approach._
