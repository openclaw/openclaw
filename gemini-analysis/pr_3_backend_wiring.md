# PR 3: Backend Wiring & Activation

## Description

This PR switches the application's main execution loop to use the new `UnifiedAgentRunner`. This is the activation point.

## Implementation Details

### 1. `src/auto-reply/reply/agent-runner-execution.ts`

Modify `runAgentTurnWithFallback` to use the unified runner.

**Diff Logic:**

```typescript
// BEFORE
// import { runEmbeddedPiAgent } from "../../agents/pi-embedded.js";
// runResult = await runEmbeddedPiAgent({ ... });

// AFTER
import { runAgentWithUnifiedFailover } from "../../agents/unified-agent-runner.js";

// ... inside the loop ...
const unifiedResult = await runAgentWithUnifiedFailover({
  // Map all existing params to the new unified params structure
  sessionId: params.followupRun.run.sessionId,
  // ...
  // Pass callbacks
  onPartialReply: ...,
  onBlockReply: ...,
});

runResult = unifiedResult.result;
fallbackProvider = unifiedResult.provider;
fallbackModel = unifiedResult.model;
```

### 2. `src/agents/tool-event-logger.ts`

Ensure this logger is hooked into the `onAgentEvent` callback in the unified runner parameters. This ensures we don't lose visibility into tool execution.

### 3. CLI Provider Handling

**Watch Out:** CLI providers (like `runCliAgent`) often bypass the standard runtime because they manage their own process lifecycle. Ensure the code in `agent-runner-execution.ts` preserves the `if (primaryIsCliProvider)` check _before_ calling the unified runner.

```typescript
if (primaryIsCliProvider) {
  // ... existing CLI runner logic ...
} else {
  // ... NEW Unified Runner logic ...
}
```

## Verification

- **Regression Test:** Run the standard Pi agent (default config). It should work exactly as before, just passing through the unified runner wrapper.
- **Failover Test:** Set `agents.defaults.runtime` to `"ccsdk"` but provide an invalid API key. It should fail and fallback to `"pi"` (logging the error).
