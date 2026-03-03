# Mid-Task Message Injection — Implementation Plan

## 1. Codebase Overview

### Existing Architecture (Key Discovery)

**Mid-task injection already exists in the codebase** — the infrastructure is largely built. The system calls it "steering" (`steer`). Here's where the pieces live:

#### Session & Run Management

- **`src/agents/pi-embedded-runner/runs.ts`** — Central registry of active runs (`ACTIVE_EMBEDDED_RUNS` Map). Exposes `queueEmbeddedPiMessage(sessionId, text)` which calls `handle.queueMessage(text)` on the active run handle. Also provides `isEmbeddedPiRunActive()`, `isEmbeddedPiRunStreaming()`, `abortEmbeddedPiRun()`, `waitForEmbeddedPiRunEnd()`.
- **`src/agents/pi-embedded-runner/run/attempt.ts`** (~1500 lines) — Creates the `EmbeddedPiQueueHandle` at line ~1108. The `queueMessage` implementation delegates to `activeSession.steer(text)` which is a method on the `@mariozechner/pi-coding-agent` SDK's session object. This inserts a user message into the active streaming context between tool calls.
- **`src/agents/pi-embedded-runner.ts`** — Re-exports from the runner modules.

#### Message Routing & Dispatch

- **`src/auto-reply/reply/agent-runner.ts`** — The `runReplyAgent()` function is the main entry point. At line ~222, when `shouldSteer && isStreaming`, it calls `queueEmbeddedPiMessage(sessionId, prompt)`. If steering succeeds and no followup is needed, it returns immediately (no new run created).
- **`src/auto-reply/reply/get-reply-run.ts`** — Resolves queue mode (`steer`, `steer-backlog`, `followup`, `collect`, `interrupt`) and determines `shouldSteer`/`shouldFollowup` flags. The queue mode comes from session config or per-message inline directives.
- **`src/auto-reply/reply/followup-runner.ts`** — Handles queued followup messages that run after the current task completes.

#### Queue Mode System

The codebase already has a sophisticated queue mode system:

- `"steer"` — Inject message into active run (mid-task injection)
- `"steer-backlog"` — Steer + queue followup if steer fails
- `"followup"` — Queue message for after current run
- `"collect"` — Collect messages, deliver together
- `"interrupt"` — Abort current run, start new one

#### Gateway / WebSocket Layer

- **`src/gateway/server-methods/chat.ts`** — Handles `chat.send`, `chat.abort`, `chat.inject` RPC methods. The `chat.send` handler dispatches to `dispatchInboundMessage()` which flows through the auto-reply pipeline. Currently, webchat messages go through the same pipeline as other channels.
- **`src/gateway/server-methods-list.ts`** — Lists available RPC methods.
- **`src/gateway/method-scopes.ts`** — Defines permission scopes for methods.

#### ControlUI (Web Dashboard)

- **`ui/src/ui/controllers/chat.ts`** — Chat controller that calls `chat.send` and `chat.abort`. Tracks `chatRunId`, `chatStream`, `chatSending` state.
- **`ui/src/ui/views/chat.ts`** — Chat view. **Already shows "Queue" instead of "Send"** when `isBusy` (line 473: `${isBusy ? "Queue" : "Send"}`). The `isBusy` flag is `props.sending || props.stream !== null`.

#### TUI (CLI Interactive Mode)

- **`node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`** — The CLI TUI already fully supports mid-task steering. When `session.isStreaming`, it calls `session.prompt(text, { streamingBehavior: "steer" })`. Shows "Steering: <msg>" and "Follow-up: <msg>" in pending area. Has keybinds: Enter = steer, Alt+Enter = follow-up, Ctrl+K = dequeue.

#### Subagent Steering

- **`src/agents/subagent-announce.ts`** — Uses `queueEmbeddedPiMessage()` to steer parent sessions when subagent results arrive (line 672).

---

## 2. Architecture Design

### Current State

The backend **already supports mid-task injection**. The `steer` mechanism works:

1. User sends message while agent is streaming
2. `queueEmbeddedPiMessage(sessionId, text)` is called
3. This calls `activeSession.steer(text)` on the SDK session
4. The SDK inserts the user message into the conversation between tool calls
5. The agent sees the injected message on its next iteration

### What's Missing

The **ControlUI (web dashboard)** doesn't properly surface this. Specifically:

1. **No queue mode awareness** — `chat.send` dispatches through the auto-reply pipeline, but the webchat UI doesn't know whether the message was steered, queued as followup, or dropped.
2. **No acknowledgement** — When a message is steered into an active run, the user gets no feedback (the response is `{ runId, status: "started" }` same as a new run).
3. **No pending message display** — The TUI shows "Steering: <msg>" but the web UI doesn't.
4. **The "Queue" button label exists** but doesn't distinguish steer vs. followup.

### Proposed Changes

#### A. Gateway: Return steer/queue status in `chat.send` response

When `chat.send` is called and the session has an active run:

- Attempt `queueEmbeddedPiMessage()` first (steer)
- If steered: respond with `{ status: "steered", runId }`
- If queued as followup: respond with `{ status: "queued", runId }`
- If dropped: respond with `{ status: "dropped" }` (shouldn't happen with default config)

Currently `chat.send` goes through `dispatchInboundMessage()` which is async and fire-and-forget. The status is returned before the steer happens. **This needs restructuring** — the steer attempt should happen synchronously before the response.

#### B. Gateway: Broadcast steer events

When a message is steered, broadcast a `chat.steered` event to webchat clients so they can show feedback.

#### C. ControlUI: Show injection feedback

- When response has `status: "steered"`: show "Message injected into active task" toast
- When response has `status: "queued"`: show "Message queued for after current task" toast
- Show pending steered/queued messages in the chat area (like TUI does)

---

## 3. ControlUI Changes

### Current State

File: `ui/src/ui/views/chat.ts` and `ui/src/ui/controllers/chat.ts`

The UI already:

- ✅ Shows "Queue" button when busy (`isBusy` check at line 242)
- ✅ Tracks `chatRunId` and `chatStream` for active task state
- ✅ Has abort button when streaming

### Required Changes

#### `ui/src/ui/controllers/chat.ts`

1. **Add `chatPendingMessages: Array<{text: string, mode: 'steered' | 'queued'}>` to `ChatState`**
2. **Update `sendChatMessage()`** to handle the new response statuses:
   ```typescript
   const res = await state.client.request("chat.send", { ... });
   if (res.status === "steered") {
     state.chatPendingMessages.push({ text: msg, mode: 'steered' });
     // Don't set chatRunId — the existing run continues
     return null;
   }
   if (res.status === "queued") {
     state.chatPendingMessages.push({ text: msg, mode: 'queued' });
     return null;
   }
   ```
3. **Clear pending messages** when `handleChatEvent` receives a `final` state for the current run.

#### `ui/src/ui/views/chat.ts`

1. **Show pending messages area** between chat messages and the input:
   ```html
   ${pendingMessages.map(m => html`
   <div class="pending-msg ${m.mode}">
     ${m.mode === 'steered' ? '→ Injected' : '⏳ Queued'}: ${m.text}
   </div>
   `)}
   ```
2. **Toast/inline feedback** when a message is steered (brief "✓ Message injected" near the send button).
3. **Change "Queue" label** to "Inject" when the default queue mode is `steer`, or keep "Queue" for followup mode.

---

## 4. Dashboard Changes

The "dashboard" in this codebase **is** the ControlUI (`ui/` directory, served at port 3001). The same changes described in Section 3 apply. There is no separate dashboard codebase.

Additional dashboard-level enhancements:

1. **Session list view** — Could show a "🔄 Running" indicator for sessions with active runs (using `isEmbeddedPiRunActive()` status from a new RPC method or existing session status).
2. **Real-time steer counter** — Show how many messages have been steered into the current run in the session info panel.

---

## 5. Edit Message Removal

### What "Edit Message" Means Here

There are two concepts in the codebase:

1. **Channel-level message editing** (Discord `editMessage`, Telegram `editMessage`, Slack `editMessage`) — These are tool actions for the agent to edit messages it previously sent on messaging platforms. Found in:
   - `src/agents/tools/discord-actions-messaging.ts` (line 322)
   - `src/agents/tools/slack-actions.ts` (line 215)
   - `src/agents/tools/telegram-actions.ts` (line 270)
   - `src/discord/send.messages.ts` (`editMessageDiscord()`)

   **These should NOT be removed** — they're legitimate messaging features.

2. **User message editing in webchat** — There is **no edit-message feature** in the webchat ControlUI. The `chat.send` handler creates new messages; there's no `chat.edit` RPC. The TUI has fork/branch (`/fork`, `/tree`) which lets users go back to a previous message and branch, but this is not "edit".

3. **Signal `editMessage`** — `src/signal/monitor/event-handler.ts` handles Signal's edit message envelope. This is inbound message processing, not something to remove.

**Conclusion: There is no "edit message" feature in the webchat to remove.** If the intent is to prevent users from editing/resending a message that's already been processed, that's already the case — `chat.send` always creates a new message.

---

## 6. Implementation Steps

### PR 1: Gateway steer-aware `chat.send` response (Complexity: Medium)

**Files:** `src/gateway/server-methods/chat.ts`

- Before dispatching through the full auto-reply pipeline, check if the session has an active run
- If active: attempt `queueEmbeddedPiMessage()` directly
- Return `{ status: "steered" }` on success, or fall through to normal dispatch
- Add `chat.steered` broadcast event type

**Estimated effort:** 2-3 days

### PR 2: ControlUI pending messages & feedback (Complexity: Medium)

**Files:** `ui/src/ui/controllers/chat.ts`, `ui/src/ui/views/chat.ts`

- Add `chatPendingMessages` to state
- Handle `steered`/`queued` response statuses
- Render pending messages area
- Show inline feedback
- Clear on run completion

**Estimated effort:** 2-3 days

### PR 3: Configurable queue mode in webchat (Complexity: Low)

**Files:** `ui/src/ui/views/chat.ts`, `src/gateway/server-methods/chat.ts`

- Allow webchat to specify steer vs. followup behavior (e.g., shift+Enter = followup, Enter = steer)
- Pass queue mode preference in `chat.send` params

**Estimated effort:** 1-2 days

### PR 4: Session active-run status in UI (Complexity: Low)

**Files:** `ui/src/ui/controllers/chat.ts`, `ui/src/ui/views/chat.ts`

- Show visual indicator (spinner, colored border) when a task is actively running
- Use existing `chatStream !== null` state more prominently

**Estimated effort:** 1 day

### PR 5: Tests (Complexity: Medium)

**Files:** Various test files

- Test `chat.send` returning `steered` status
- Test message injection during active run
- Test UI state transitions

**Estimated effort:** 2-3 days

**Total estimated effort: 8-12 days**

---

## 7. Risks & Edge Cases

### Race Conditions

1. **Task finishes between steer check and steer attempt** — `queueEmbeddedPiMessage()` already handles this: returns `false` if no active run. The gateway should fall back to starting a new run.
2. **Multiple rapid steer messages** — Each `steer()` call appends a user message to the conversation. The SDK handles this correctly, but rapid injections could confuse the agent.
3. **Steer during compaction** — `queueEmbeddedPiMessage()` returns `false` if `isCompacting()`. The TUI queues messages during compaction and flushes after. The webchat should do the same.

### Context Window Overflow

- Each steered message adds tokens to the active context. If many messages are injected, the context could overflow.
- **Mitigation:** The existing auto-compaction system handles this — when context exceeds threshold, compaction triggers automatically.
- **Safeguard:** Consider a max-steer-count per run (e.g., 10) after which messages are queued as followups instead.

### Message Ordering

- Steered messages are inserted at the current position in the conversation (after the last tool result). Order is preserved as long as steers are sequential.
- If a steer and a tool result complete simultaneously, the SDK's internal ordering handles this (messages are appended to the conversation array).

### UI Consistency

- The steered message appears in the agent's context but may not be visible in the webchat transcript (it's not a separate turn). The UI should show it inline or in a pending area.
- When the run completes and history is reloaded, steered messages will appear as regular user messages in the transcript.

### What Happens If Task Finishes Before Injection Is Processed

- `queueEmbeddedPiMessage()` returns `false` → the message is not lost
- The gateway should detect this and either start a new run or queue as followup
- The current auto-reply pipeline already handles this via `resolveActiveRunQueueAction()` which returns `"enqueue-followup"` or starts a new run

### Subagent Interaction

- Subagent result announcements already use `queueEmbeddedPiMessage()` (in `subagent-announce.ts`)
- User steers and subagent announcements could interleave — this is by design and works correctly

### Provider-Specific Behavior

- Steering inserts a user message between tool calls. Some providers may handle this differently (e.g., Gemini has strict turn ordering rules — see `applyGoogleTurnOrderingFix`).
- The SDK's `steer()` method handles provider-specific ordering internally.

---

## Summary

The core mid-task injection mechanism **already exists** in the OpenClaw codebase under the name "steering" (`steer`). The TUI fully supports it. The main work is:

1. **Surface it in the web ControlUI** — response status, pending message display, user feedback
2. **Make `chat.send` steer-aware** — return status immediately instead of only after full pipeline dispatch
3. **Add UI affordances** — visual indicators, steer vs. followup selection

This is a relatively small feature since the backend infrastructure is complete. The primary risk is race conditions at task boundaries, which are already handled by the existing `queueEmbeddedPiMessage()` fallback logic.
