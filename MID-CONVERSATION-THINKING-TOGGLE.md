# Mid-Conversation Reasoning Visibility Toggle

## Executive Summary

Implement a true mid-conversation toggle for reasoning/thinking visibility that updates server-side callback behavior during an active agent run. The existing `Ctrl+T` keybinding will be enhanced to communicate with the gateway.

## Problem Statement

Currently, the TUI's `showThinking` toggle (triggered by `Ctrl+T`) only affects **client-side display composition**:

- The `TuiStreamAssembler` filters reasoning content based on `showThinking` state
- Reasoning events are still transmitted from the gateway regardless of toggle state
- The `onReasoningStream` callback is set once at message start and cannot be changed mid-run

**User expectation:** Toggling `Ctrl+T` should actually stop/start reasoning event emission from the server.

## Architecture Analysis

### Current Flow

```
TUI (Ctrl+T)                Gateway                     Agent Runtime
    │                          │                             │
    │  chat.send               │                             │
    ├─────────────────────────>│  dispatchInboundMessage()   │
    │                          ├────────────────────────────>│
    │                          │                             │
    │                          │  onReasoningStream (fixed)  │
    │                          │<────────────────────────────│
    │   broadcast "chat"       │                             │
    │<─────────────────────────│                             │
    │                          │                             │
    │  (showThinking filters   │                             │
    │   display locally)       │                             │
```

### Key Files & Their Roles

| File                                             | Role                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `src/gateway/chat-abort.ts`                      | Manages active chat run state (`ChatAbortControllerEntry`)       |
| `src/gateway/server-methods/chat.ts`             | Handles `chat.send`, `chat.abort`, `chat.history`, `chat.inject` |
| `src/gateway/protocol/schema/logs-chat.ts`       | TypeBox schemas for chat RPC messages                            |
| `src/gateway/protocol/index.ts`                  | Exports validators and types                                     |
| `src/tui/gateway-chat.ts`                        | `GatewayChatClient` - TUI's gateway connection                   |
| `src/tui/tui.ts`                                 | Main TUI logic, includes `Ctrl+T` handler                        |
| `src/tui/tui-event-handlers.ts`                  | Handles `chat` and `agent` events from gateway                   |
| `src/tui/tui-stream-assembler.ts`                | Assembles streaming deltas, filters thinking                     |
| `src/auto-reply/dispatch.ts`                     | Entry point for message dispatch                                 |
| `src/auto-reply/reply/agent-runner-execution.ts` | Wires `onReasoningStream` callback                               |

### Current Limitations

1. **Callbacks are locked at run start** - The `onReasoningStream` callback is passed through `replyOptions` when `dispatchInboundMessage()` is called
2. **No mechanism to update callback behavior** - Once the agent run starts, there's no way to modify callback behavior
3. **Gateway doesn't track reasoning visibility** - The `ChatAbortControllerEntry` only tracks abort state, not reasoning preferences

---

## Implementation Plan

### Approach: Mutable Reasoning Visibility Flag Per Run

Add a mutable `reasoningVisible` flag to each active run's state. The `onReasoningStream` callback will check this flag before emitting events.

---

### Part 1: Extend Chat Run State

**File: `src/gateway/chat-abort.ts`**

Add `reasoningVisible` to the run entry type:

```typescript
export type ChatAbortControllerEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  startedAtMs: number;
  expiresAtMs: number;
  reasoningVisible: boolean; // NEW: mutable flag, defaults to true
};
```

**Changes:**

- Add `reasoningVisible: boolean` field
- Default to `true` when creating new entries

---

### Part 2: Add Schema for Toggle Message

**File: `src/gateway/protocol/schema/logs-chat.ts`**

Add new schema:

```typescript
export const ChatToggleReasoningParamsSchema = Type.Object(
  {
    sessionKey: NonEmptyString,
    runId: NonEmptyString,
    reasoningVisible: Type.Boolean(),
  },
  { additionalProperties: false },
);
```

**File: `src/gateway/protocol/index.ts`**

Add validator and exports:

```typescript
import { ChatToggleReasoningParamsSchema } from "./schema/logs-chat.js";

export const validateChatToggleReasoningParams = ajv.compile(ChatToggleReasoningParamsSchema);

// Add to exports
export { ChatToggleReasoningParamsSchema };
```

---

### Part 3: Add `chat.toggleReasoning` RPC Handler

**File: `src/gateway/server-methods/chat.ts`**

Add new handler to `chatHandlers`:

```typescript
"chat.toggleReasoning": ({ params, respond, context }) => {
  if (!validateChatToggleReasoningParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.toggleReasoning params: ${formatValidationErrors(validateChatToggleReasoningParams.errors)}`,
      ),
    );
    return;
  }

  const { sessionKey, runId, reasoningVisible } = params as {
    sessionKey: string;
    runId: string;
    reasoningVisible: boolean;
  };

  const runState = context.chatAbortControllers.get(runId);
  if (!runState) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "run not active"));
    return;
  }

  if (runState.sessionKey !== sessionKey) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey mismatch"));
    return;
  }

  // Update mutable flag
  runState.reasoningVisible = reasoningVisible;

  // Broadcast state change to all clients watching this session
  const payload = { runId, sessionKey, reasoningVisible };
  context.broadcast("chat.reasoningToggled", payload);
  context.nodeSendToSession(sessionKey, "chat.reasoningToggled", payload);

  respond(true, { ok: true, reasoningVisible });
},
```

---

### Part 4: Wire Reasoning Visibility Check into Callback

**File: `src/gateway/server-methods/chat.ts`**

This is the challenging part. Currently, `dispatchInboundMessage()` is called without an `onReasoningStream` callback for webchat. We need to:

1. Add an `onReasoningStream` callback to the dispatch
2. Make that callback check the mutable `reasoningVisible` flag

**Option A: Add reasoning streaming to webchat dispatch**

In the `chat.send` handler, after setting up the abort controller:

```typescript
// After: context.chatAbortControllers.set(clientRunId, { ... });

const replyOptions: Omit<GetReplyOptions, "onToolResult" | "onBlockReply"> = {
  runId: clientRunId,
  abortSignal: abortController.signal,
  images: parsedImages.length > 0 ? parsedImages : undefined,
  disableBlockStreaming: true,
  onAgentRunStart: () => {
    agentRunStarted = true;
  },
  onModelSelected: (ctx) => {
    prefixContext.provider = ctx.provider;
    prefixContext.model = extractShortModelName(ctx.model);
    prefixContext.modelFull = `${ctx.provider}/${ctx.model}`;
    prefixContext.thinkingLevel = ctx.thinkLevel ?? "off";
  },
  // NEW: Add reasoning stream callback
  onReasoningStream: async (payload) => {
    const runState = context.chatAbortControllers.get(clientRunId);
    if (!runState?.reasoningVisible) {
      return; // Skip emission when reasoning visibility is off
    }

    const seq = nextChatSeq({ agentRunSeq: context.agentRunSeq }, clientRunId);
    const chatPayload = {
      runId: clientRunId,
      sessionKey: p.sessionKey,
      seq,
      state: "reasoning" as const,
      message: payload,
    };
    context.broadcast("chat", chatPayload);
    context.nodeSendToSession(p.sessionKey, "chat", chatPayload);
  },
};
```

**Note:** This requires updating the `ChatEventSchema` to include `"reasoning"` as a valid state.

---

### Part 5: Update Chat Event Schema

**File: `src/gateway/protocol/schema/logs-chat.ts`**

Update `ChatEventSchema` to include reasoning state:

```typescript
export const ChatEventSchema = Type.Object(
  {
    runId: NonEmptyString,
    sessionKey: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    state: Type.Union([
      Type.Literal("delta"),
      Type.Literal("final"),
      Type.Literal("aborted"),
      Type.Literal("error"),
      Type.Literal("reasoning"), // NEW
    ]),
    message: Type.Optional(Type.Unknown()),
    errorMessage: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
```

---

### Part 6: Add TUI Client Method

**File: `src/tui/gateway-chat.ts`**

Add method to `GatewayChatClient`:

```typescript
async toggleReasoningVisibility(opts: {
  sessionKey: string;
  runId: string;
  reasoningVisible: boolean;
}): Promise<{ ok: boolean; reasoningVisible: boolean }> {
  return await this.client.request("chat.toggleReasoning", opts);
}
```

---

### Part 7: Update TUI Toggle Handler

**File: `src/tui/tui.ts`**

Update the `Ctrl+T` handler to also update the server:

```typescript
editor.onCtrlT = () => {
  showThinking = !showThinking;

  // Update server-side callback if run is active
  if (activeChatRunId) {
    void client
      .toggleReasoningVisibility({
        sessionKey: currentSessionKey,
        runId: activeChatRunId,
        reasoningVisible: showThinking,
      })
      .catch((err) => {
        // Log but don't block - local toggle still works
        logVerbose(`Failed to toggle reasoning on server: ${String(err)}`);
      });
  }

  // Re-render with new display setting (also filters locally)
  void loadHistory();
  setActivityStatus(showThinking ? "thinking visible" : "thinking hidden");
  tui.requestRender();
};
```

---

### Part 8: Handle `chat.reasoningToggled` Event in TUI

**File: `src/tui/tui-event-handlers.ts`**

Add handler for the new event type. Update `createEventHandlers` to return an additional handler:

```typescript
const handleReasoningToggled = (payload: unknown) => {
  if (!payload || typeof payload !== "object") return;
  const evt = payload as { runId: string; sessionKey: string; reasoningVisible: boolean };

  // Only sync if this is our active run
  if (evt.runId !== state.activeChatRunId) return;
  if (evt.sessionKey !== state.currentSessionKey) return;

  // Sync local state (handles multi-client scenarios)
  if (state.showThinking !== evt.reasoningVisible) {
    state.showThinking = evt.reasoningVisible;
    setActivityStatus(evt.reasoningVisible ? "thinking visible" : "thinking hidden");
    tui.requestRender();
  }
};

return { handleChatEvent, handleAgentEvent, handleReasoningToggled };
```

**File: `src/tui/tui.ts`**

Wire up the new handler:

```typescript
const { handleChatEvent, handleAgentEvent, handleReasoningToggled } = createEventHandlers({
  // ... existing params
});

client.onEvent = (evt) => {
  if (evt.event === "chat") handleChatEvent(evt.payload);
  if (evt.event === "agent") handleAgentEvent(evt.payload);
  if (evt.event === "chat.reasoningToggled") handleReasoningToggled(evt.payload);
};
```

---

### Part 9: Handle Reasoning Events in TUI Stream Assembler

**File: `src/tui/tui-event-handlers.ts`**

Update `handleChatEvent` to process reasoning state:

```typescript
if (evt.state === "reasoning") {
  if (!state.showThinking) return; // Skip if thinking is hidden locally

  // Extract reasoning text from the message
  const reasoningText = extractReasoningText(evt.message);
  if (!reasoningText) return;

  // Update the chat log with reasoning content
  chatLog.updateReasoning(reasoningText, evt.runId);
  setActivityStatus("thinking");
  tui.requestRender();
  return;
}
```

**Note:** This may require adding an `updateReasoning` method to `ChatLog` or incorporating reasoning into the existing streaming mechanism.

---

## Files to Modify Summary

| File                                       | Changes                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `src/gateway/chat-abort.ts`                | Add `reasoningVisible: boolean` to `ChatAbortControllerEntry`                       |
| `src/gateway/protocol/schema/logs-chat.ts` | Add `ChatToggleReasoningParamsSchema`, update `ChatEventSchema`                     |
| `src/gateway/protocol/index.ts`            | Export new validator                                                                |
| `src/gateway/server-methods/chat.ts`       | Add `chat.toggleReasoning` handler, add `onReasoningStream` callback to `chat.send` |
| `src/tui/gateway-chat.ts`                  | Add `toggleReasoningVisibility()` method                                            |
| `src/tui/tui.ts`                           | Update `Ctrl+T` handler to call server                                              |
| `src/tui/tui-event-handlers.ts`            | Add `handleReasoningToggled`, handle `reasoning` state                              |
| `src/tui/tui-types.ts`                     | Update `ChatEvent` type if needed                                                   |

---

## Verification Plan

### Test 1: Mid-Conversation Toggle

1. Start TUI, set `/think high`
2. Send a message that triggers extended thinking
3. While response is streaming, press `Ctrl+T`
4. **Verify:** Reasoning events STOP being emitted (check gateway logs)
5. Press `Ctrl+T` again
6. **Verify:** Reasoning events RESUME

### Test 2: Multi-Client Sync

1. Open two TUI sessions connected to same gateway
2. Both connected to same session key
3. Start a conversation in one
4. Toggle reasoning in the other
5. **Verify:** Both UIs sync reasoning visibility state

### Test 3: Race Condition Resilience

1. Rapidly toggle `Ctrl+T` during streaming
2. **Verify:** No crashes, no inconsistent state
3. **Verify:** Final state is consistent between client and server

### Test 4: Run Completion Cleanup

1. Start a run with reasoning visible
2. Toggle off mid-run
3. Let run complete
4. Start new run
5. **Verify:** New run respects current toggle state (should be visible by default)

---

## Alternatives Considered

### A. Client-Side Only (Current Behavior)

- **Pros:** Simple, no server changes
- **Cons:** Reasoning still transmitted (bandwidth waste), doesn't truly "stop" the callback

### B. Abort + Restart with New Settings

- **Pros:** Clean state transition
- **Cons:** Loses in-progress response, terrible UX

### C. Session-Level Patch

- **Pros:** Uses existing `sessions.patch` infrastructure
- **Cons:** Only affects NEXT run, not current run

### D. Mutable Flag Per Run (Chosen)

- **Pros:** Minimal disruption, true mid-conversation control, no data loss
- **Cons:** Requires WebSocket protocol addition, slightly more complex

---

## Edge Cases & Considerations

1. **Default State:** `reasoningVisible` defaults to `true` when run starts
2. **No Persistence:** Toggle resets each session (intentional - matches current behavior)
3. **Run Not Found:** If toggle is called after run ends, return graceful error
4. **Session Mismatch:** Validate `sessionKey` matches run's session
5. **Bandwidth:** When reasoning is hidden, events are not emitted at all (not just filtered)
6. **History Reload:** When toggling, may want to reload history to show/hide past reasoning

---

## Implementation Order

1. **Schema & Types** - Add new schemas and types
2. **Run State** - Extend `ChatAbortControllerEntry`
3. **Gateway Handler** - Add `chat.toggleReasoning` RPC
4. **Callback Wiring** - Add `onReasoningStream` to `chat.send`
5. **TUI Client** - Add `toggleReasoningVisibility()` method
6. **TUI Handler** - Update `Ctrl+T` to call server
7. **Event Handler** - Handle `chat.reasoningToggled` and `reasoning` state
8. **Testing** - Verify all scenarios
