# Proposal: `message:received` Hook

## Summary

Add a new hook event `message:received` that fires **before** the agent processes an incoming message. This enables pre-turn automations like memory curation, context injection, and audit logging.

## Motivation

Currently, hooks only fire on:
- `command:*` (new, reset, stop)
- `agent:bootstrap` 
- `gateway:startup`

There's no way to run automation **before each agent turn**. Use cases:

1. **Memory curation** (memfas) — Score and curate relevant memories before the turn, reducing token usage by 80%+
2. **Context injection** — Auto-inject relevant context based on message content
3. **Audit logging** — Log all incoming messages for compliance
4. **Rate limiting** — Check/enforce per-user limits before processing
5. **Content filtering** — Pre-screen messages before agent sees them

## Proposed API

### Event Shape

```typescript
export type MessageReceivedHookEvent = InternalHookEvent & {
  type: "message";
  action: "received";
  context: {
    // Message content
    message: string;
    messageId?: string;
    
    // Sender info
    senderId?: string;
    senderName?: string;
    
    // Channel info
    channel: string; // "whatsapp" | "telegram" | "discord" | etc.
    chatId?: string;
    isGroup: boolean;
    
    // Session info
    sessionKey: string;
    agentId: string;
    
    // Mutable: hooks can add context to inject
    injectedContext?: string;
    
    // Mutable: hooks can request skip
    skipProcessing?: boolean;
    skipReason?: string;
  };
};
```

### Hook Example

```typescript
// hooks/memfas-curate/handler.ts
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "received") {
    return;
  }

  // Run memfas curation
  const curated = await runMemfasCurate(event.context.message);
  
  // Inject curated context into the turn
  event.context.injectedContext = curated.context;
  
  console.log(`[memfas] Curated ${curated.tokensSaved} tokens`);
};

export default handler;
```

### HOOK.md

```markdown
---
name: memfas-curate
description: "Auto-curate memory context before each turn using memfas v3"
metadata: {"clawdbot":{"emoji":"🧠","events":["message:received"]}}
---

# memfas Curation Hook

Runs memfas ContextCurator before each agent turn to inject relevant memories.
```

## Implementation

### 1. Add Event Type

```typescript
// src/hooks/internal-hooks.ts
export type InternalHookEventType = "command" | "session" | "agent" | "gateway" | "message";
```

### 2. Trigger Point

In `src/web/auto-reply/monitor/on-message.ts` (or equivalent for each channel), before passing to agent:

```typescript
// Before agent processing
const hookEvent = createInternalHookEvent("message", "received", sessionKey, {
  message: body,
  senderId,
  channel: "whatsapp",
  isGroup,
  // ...
});

await triggerInternalHook(hookEvent);

// Check if hook requested skip
if (hookEvent.context.skipProcessing) {
  return; // Don't process this message
}

// Inject any context from hooks
const contextPrefix = hookEvent.context.injectedContext ?? "";

// Continue with agent processing...
```

### 3. Context Injection

The `injectedContext` field gets prepended to the system prompt or message, similar to how bootstrap files work.

## Alternatives Considered

1. **MCP Server** — memfas as external MCP server
   - Pro: Cleaner separation
   - Con: More latency, complexity
   
2. **System prompt injection** — Always-load instructions
   - Pro: No code changes
   - Con: Agent must manually call memfas, not automatic

3. **Plugin API** — Extend plugin system
   - Pro: More flexible
   - Con: Heavier than hooks

## Migration

- No breaking changes
- Existing hooks unaffected
- New event type opt-in

## Open Questions

1. Should `injectedContext` go in system prompt or as a user message prefix?
2. Should we support async hooks blocking the message flow, or fire-and-forget?
3. Per-channel enable/disable for this hook?

## References

- [Hooks documentation](/hooks)
- [memfas v3 design](/docs/v3-context-engineering.md)
- Related: `agent:bootstrap` hook pattern
