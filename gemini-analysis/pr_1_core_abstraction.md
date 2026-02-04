# PR 1: Core Agent Runtime Abstraction

## Description

This PR introduces the `AgentRuntime` interface, a unifying abstraction for different agent backends. It also includes an adapter (`PiAgentRuntime`) that wraps the existing Pi agent logic to conform to this new interface.

**Note:** This PR strictly adheres to the existing `Clawdbot` naming conventions.

## Implementation Details

### 1. `src/agents/agent-runtime.ts`

Define the core interface using `ClawdbotConfig`.

```typescript
import type { ClawdbotConfig } from "../config/config.js";
import type { AgentStreamParams } from "../commands/agent/types.js";
// ... imports

export type AgentRuntimeRunParams = {
  // Core fields
  sessionId: string;
  config?: ClawdbotConfig; // Uses ClawdbotConfig
  prompt: string;
  // ... other standard params (images, timeoutMs, etc)

  // Callbacks
  onPartialReply?: (payload: { text?: string; mediaUrls?: string[] }) => void | Promise<void>;
  onBlockReply?: (payload: BlockReplyPayload) => void | Promise<void>;
  // ... other callbacks
};

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly displayName: string;
  run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult>;
}
```

### 2. `src/agents/pi-agent-runtime.ts`

Implement the factory and class for the Pi runtime.

```typescript
import { runEmbeddedPiAgent } from "./pi-embedded.js";

export function createPiAgentRuntime(): AgentRuntime {
  return {
    kind: "pi",
    displayName: "Pi Agent",
    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      // Adapter logic:
      // 1. Extract pi-specific options from params (if any)
      // 2. Call runEmbeddedPiAgent(params)
      return runEmbeddedPiAgent({
        ...params,
        // Map specific overrides if names differ
      });
    },
  };
}
```

### 3. `src/agents/runtime-result-types.ts`

Move shared type definitions (like `AgentRunResult`, `AgentRuntimeKind`) here to avoid circular dependencies between the runtime definition and the specific implementations.

## Justification

This establishes the architectural foundation for multi-runtime support without risking stability, as the main application loop continues to use the legacy entry point until PR 3.

## Verification

- Create a test file `src/agents/pi-agent-runtime.test.ts` that instantiates `createPiAgentRuntime` and calls `run()` with a mock, ensuring it delegates correctly to `runEmbeddedPiAgent`.
