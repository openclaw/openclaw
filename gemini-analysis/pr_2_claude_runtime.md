# PR 2: Claude Runtime Implementation

## Description

This PR adds the **Claude Code SDK** runtime implementation. It includes the runtime logic, the unified runner that handles failover, and the runtime factory.

## Implementation Details

### 1. `src/agents/claude-agent-sdk/sdk-agent-runtime.ts`

This is the core implementation. Key responsibilities:

- **Initialization:** Check `isSdkAvailable()`.
- **Tool Conversion:** Use `createClawdbotCodingTools` (mapped from `createMoltbotCodingTools`) and `convertClientToolsForSdk`.
- **Execution:** Call `runSdkAgent` (from `./sdk-runner.ts`).
- **Result Adaptation:** Convert `SdkRunnerResult` -> `AgentRuntimeResult`.

**Key Code Skeleton:**

```typescript
import type { ClawdbotConfig } from "../../config/config.js";

export type CcSdkAgentRuntimeContext = {
  config?: ClawdbotConfig; // Uses ClawdbotConfig
  // ...
};

export function createCcSdkAgentRuntime(context?: CcSdkAgentRuntimeContext): AgentRuntime {
  return {
    kind: "ccsdk",
    displayName: `Claude Code SDK`,

    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      // 1. Resolve Configuration
      // 2. Build Tools (builtInTools + clientTools)
      // 3. Run SDK
      const sdkResult = await runSdkAgent({
        // ... map params ...
        tools,
        // ... map callbacks ...
      });
      // 4. Adapt Result
      return adaptSdkResult(sdkResult, params.sessionId);
    },
  };
}
```

### 2. `src/agents/unified-agent-runner.ts`

Implement the failover logic using `ClawdbotConfig`.

**Logic Flow:**

1.  **Resolve Chain:** `resolveRuntimeFailoverChain(primaryRuntime)` -> e.g. `['ccsdk', 'pi']`.
2.  **Outer Loop (Runtimes):** Iterate through runtimes.
3.  **Inner Loop (Models):** Iterate through model candidates for that runtime.
4.  **Execution:** `await runtime.run(params)`.
5.  **Error Handling:** Catch errors, collect them in `UnifiedFallbackAttempt[]`, try next candidate.

### 3. `src/agents/main-agent-runtime-factory.ts`

Implement the factory that decides which runtime to load.

```typescript
import type { ClawdbotConfig } from "../config/config.js";

export async function createAgentRuntime(
  config: ClawdbotConfig, // Uses ClawdbotConfig
  agentId: string,
  forceKind?: AgentRuntimeKind,
): Promise<AgentRuntime> {
  const runtimeKind = forceKind ?? resolveAgentRuntimeKind(config, agentId);

  if (runtimeKind === "ccsdk") {
    // Dynamic import is CRITICAL to avoid loading SDK if unused
    const { createCcSdkAgentRuntime, isSdkAvailable } = await import("./claude-agent-sdk/index.js");
    if (!isSdkAvailable()) return createPiAgentRuntime();
    return createCcSdkAgentRuntime({ ... });
  }

  return createPiAgentRuntime();
}
```

## Dependencies

- Add `@anthropic-ai/claude-agent-sdk` to `package.json`.

## Verification

- Run unit tests for `unified-agent-runner.test.ts`.
- Ensure the dynamic import works (code should compile but not fail at runtime if SDK is missing, though `package.json` usually ensures it's there).
