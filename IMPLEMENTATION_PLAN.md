# Implementation Plan: Agent End Hook with Message Injection

## Goal
Allow plugins to intercept agent responses and inject continuation messages (e.g. anti-rationalization gates).

## Current State
- `agent_end` hook exists and fires after agent completes
- Event includes full message array but not the final assistant message
- Hook is fire-and-forget (void return)
- No mechanism to inject messages based on hook results

## Changes Needed

### 1. Update Event Type (src/plugins/types.ts)
```typescript
export type PluginHookAgentEndEvent = {
  messages: unknown[];
  lastAssistantMessage?: string;  // NEW: the final assistant message content
  success: boolean;
  error?: string;
  durationMs?: number;
};
```

### 2. Add injectMessage to Context (src/plugins/types.ts)
```typescript
export type PluginHookAgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  injectMessage?: (message: string) => void;  // NEW
};
```

### 3. Update Hook Runner (src/plugins/hooks.ts)
Change `runAgentEnd` to provide `injectMessage()` and collect injected messages:
```typescript
async function runAgentEnd(
  event: PluginHookAgentEndEvent,
  ctx: PluginHookAgentContext,
): Promise<string[]> {
  const injectedMessages: string[] = [];
  const agentEndCtx = {
    ...ctx,
    injectMessage: (msg: string) => injectedMessages.push(msg),
  };
  // Run hooks sequentially
  // Return injectedMessages array
}
```

### 4. Update Agent Loop (src/agents/pi-embedded-runner/run/attempt.ts)
```typescript
if (hookRunner?.hasHooks("agent_end")) {
  const injectedMessages = await hookRunner.runAgentEnd(...);
  if (injectedMessages.length > 0) {
    // Inject user messages to force continuation
    // Add each message to session and trigger new agent run
  }
}
```

### 5. Extract Last Assistant Message
In the agent loop, extract the last assistant message text and add to event:
```typescript
const lastMsg = messagesSnapshot[messagesSnapshot.length - 1];
const lastAssistantMessage = lastMsg?.role === 'assistant' && typeof lastMsg.content === 'string'
  ? lastMsg.content
  : undefined;
```

## Testing Strategy
1. Write unit test for hook return value
2. Write e2e test with mock plugin that forces continuation
3. Test anti-rationalization plugin against known patterns

## Backwards Compatibility
- Existing hooks that return `void` continue to work
- Only hooks that return `{ continue: true }` trigger injection
- Event adds new optional field, doesn't break existing consumers

## Implementation Order
1. ✅ Types (event + context.injectMessage)
2. ✅ Hook runner (sequential execution with message collection)
3. Agent loop (message injection into session)
4. Tests
5. ✅ Example plugin (anti-rationalization)
