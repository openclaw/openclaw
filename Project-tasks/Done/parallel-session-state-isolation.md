---
# ── Dart AI metadata ──────────────────────────────────────────────────────────
title: "Parallel Session State Isolation"
description: "Scope chat streaming and message state per-session so parallel conversations don't contaminate each other"
dartboard: "Operator1/Tasks"
type: Project
status: "To-do"
priority: high
assignee: "rohit sharma"
tags: [bug, ui, architecture, sessions]
startAt: "2026-03-14"
dueAt: ""
dart_project_id:
# ──────────────────────────────────────────────────────────────────────────────
---

# Parallel Session State Isolation

**Created:** 2026-03-14
**Status:** Planning
**Depends on:** None (standalone refactor)

---

## 1. Overview

When two chat sessions run in parallel, the global Zustand `chat-store` causes cross-contamination: `isStreaming`, `streamRunId`, `streamContent`, and `messages[]` are all shared flat fields keyed to no session. Switching sessions mid-stream shows the wrong session's output, and `handleChatEvent` in `use-gateway.ts` uses a fragile suffix/segment heuristic that lets same-suffix session keys bleed events into each other. This project scopes all per-session volatile state behind a `Map<sessionKey, PerSessionState>` and hardens the event filter to exact matching.

---

## 2. Goals

- Session A's stream never appears in session B's view, even when both are actively streaming.
- Switching sessions while one is streaming leaves the background session streaming correctly; returning shows accurate state.
- Event routing uses exact session key matching — no heuristic suffix/segment fallback.
- Server-side: eliminate the narrow same-key concurrent `initSessionState` race window.

## 3. Out of Scope

- UI for viewing multiple sessions simultaneously (split-pane, tabs) — that is a future feature.
- Heartbeat session targeting improvements (low-severity, deferred).
- Changes to the Pi transcript JSONL format or `SessionManager`.
- Changes to `agentRunSeq` in `server-chat.ts` (already correctly keyed by `runId`, not session).

---

## 4. Design Decisions

| Decision                       | Options Considered                                   | Chosen                                                                                        | Reason                                                                                                            |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Per-session state shape        | Flat Map vs nested object vs separate Zustand slice  | `Map<sessionKey, PerSessionState>` inside existing store                                      | Minimal API surface change; existing selectors become thin wrappers; no new store plumbing                        |
| Session switch behavior        | Clear old session state vs preserve it               | **Preserve** — never clear a session's state on switch                                        | A background stream should survive a session switch so returning shows correct history                            |
| Store action API               | Add optional `sessionKey` param vs require it always | **Require** — all mutating actions take explicit `sessionKey`                                 | Removes ambiguity; compiler enforces correct call sites; no hidden `activeSessionKey` dependency inside the store |
| Session key normalization      | Normalize at write vs at read vs at Map boundary     | **At Map boundary** — one `normalizeSessionKey(key)` helper called before every `Map.get/set` | Single point of truth; callers don't need to think about it                                                       |
| handleChatEvent filter         | Keep suffix heuristic vs strict exact match          | **Strict exact match** (`sessionKey === activeSessionKey`) with no segment fallback           | Fragile heuristic is the source of bleed; all session keys sent from the server are already canonical             |
| Auto-re-arm in handleChatEvent | Keep auto-startStream for unknown runId vs remove it | **Remove** — only start a stream for `state === "started"` events                             | Auto-re-arm is what makes the ping-pong possible; correct server events always include a `"started"` state packet |

---

## 5. Technical Spec

### 5.1 `PerSessionState` Type (chat-store.ts)

```ts
export type PerSessionState = {
  messages: ChatMessage[];
  messagesLoading: boolean;
  isStreaming: boolean;
  streamRunId: string | null;
  streamContent: string;
  isSendPending: boolean;
  lastStreamEventAt: number;
  isPaused: boolean;
  pauseBuffer: string;
};

const DEFAULT_SESSION_STATE: PerSessionState = {
  messages: [],
  messagesLoading: false,
  isStreaming: false,
  streamRunId: null,
  streamContent: "",
  isSendPending: false,
  lastStreamEventAt: 0,
  isPaused: false,
  pauseBuffer: "",
};
```

### 5.2 Store Shape Change

Replace the flat fields in `ChatState` with:

```ts
// Before (flat, global):
messages: ChatMessage[];
messagesLoading: boolean;
isStreaming: boolean;
streamRunId: string | null;
streamContent: string;
isSendPending: boolean;
lastStreamEventAt: number;
isPaused: boolean;
pauseBuffer: string;

// After (per-session Map + active-session selectors):
sessionStates: Map<string, PerSessionState>;

// Computed read helpers (not stored, derived):
getSessionState: (key: string) => PerSessionState;      // returns DEFAULT_SESSION_STATE if key missing
getActiveSessionState: () => PerSessionState;           // shorthand for getSessionState(activeSessionKey)
```

Active-session selectors used by all UI components become:

```ts
// Zustand selector pattern:
const messages = useChatStore((s) => s.getSessionState(s.activeSessionKey).messages);
const isStreaming = useChatStore((s) => s.getSessionState(s.activeSessionKey).isStreaming);
const streamContent = useChatStore((s) => s.getSessionState(s.activeSessionKey).streamContent);
const isSendPending = useChatStore((s) => s.getSessionState(s.activeSessionKey).isSendPending);
```

### 5.3 Updated Action Signatures

All mutating actions gain an explicit `sessionKey` parameter:

```ts
startStream:       (runId: string, sessionKey: string) => void;
updateStreamDelta: (runId: string, text: string, sessionKey: string) => void;
finalizeStream:    (runId: string, sessionKey: string, text?: string, usage?: MessageUsage) => void;
appendMessage:     (message: Omit<ChatMessage,"id"> & { id?: string }, sessionKey: string) => void;
setMessages:       (messages: Array<...>, isRunning: boolean | undefined, sessionKey: string) => void;
setMessagesLoading:(loading: boolean, sessionKey: string) => void;
setSendPending:    (pending: boolean, sessionKey: string) => void;
clearMessages:     (sessionKey: string) => void;
```

`setActiveSessionKey` stays as-is (`(key: string) => void`) — it does NOT need to clear session state because state is now isolated per-key. The act of switching the `activeSessionKey` means selectors naturally read the new session's (already correct) state.

### 5.4 `normalizeSessionKey` Helper

```ts
// chat-store.ts
function normalizeSessionKey(key: string): string {
  return key.trim().toLowerCase();
}
```

All `Map.get(key)` / `Map.set(key, ...)` calls inside the store pass through this helper. The key used in `activeSessionKey` also normalizes through `setActiveSessionKey`.

### 5.5 `handleChatEvent` Session Filter Replacement (use-gateway.ts)

Current fragile filter (lines 283–291):

```ts
if (sessionKey && sessionKey !== chatStore.activeSessionKey) {
  const suffixMatch = sessionKey.endsWith(`:${ak}`) || ak.endsWith(`:${sessionKey}`);
  const eventSegment = sessionKey.split(":").pop() ?? sessionKey;
  const activeSegment = ak.split(":").pop() ?? ak;
  const segmentMatch = eventSegment === activeSegment && eventSegment.length > 0;
  if (!suffixMatch && !segmentMatch) {
    return;
  }
}
```

Replacement (exact match, with event still dispatched to the correct session regardless of which is active):

```ts
// Resolve which session this event targets (default to activeSessionKey if untagged)
const targetKey = sessionKey ? normalizeSessionKey(sessionKey) : chatStore.activeSessionKey;

// Always mutate the correct session's state (not activeSessionKey)
// UI will show it if targetKey === activeSessionKey; otherwise it silently updates background state
```

Downstream store calls change from:

```ts
chatStore.startStream(runId);               // → chatStore.startStream(runId, targetKey)
chatStore.updateStreamDelta(runId, delta);  // → chatStore.updateStreamDelta(runId, delta, targetKey)
chatStore.finalizeStream(runId, ...);       // → chatStore.finalizeStream(runId, targetKey, ...)
```

The "event ignored if not active session" logic is removed — events always update their target session's state. If that session is not the active one, the Zustand selector simply doesn't re-render the chat view (no visible effect until the user switches back).

### 5.6 Auto-Re-arm Removal (use-gateway.ts lines 303–309)

Current code that causes ping-pong:

```ts
if (state !== "started" && chatStore.streamRunId !== runId) {
  chatStore.startStream(runId); // ← re-arms for whoever fires last
}
```

Replacement: only start a stream on an explicit `"started"` state packet from the server:

```ts
if (state === "started") {
  chatStore.startStream(runId, targetKey);
}
```

If a `"delta"` or `"done"` packet arrives for an unknown runId (e.g., after a page refresh mid-stream), it is silently dropped. This is acceptable — the stream is already lost in that edge case; auto-re-arm produces worse UX (corrupted output).

### 5.7 Server-Side: Per-SessionKey Locking in `initSessionState`

File: `src/auto-reply/reply/session.ts`

Currently the function reads the session store (`loadSessionStore`) before acquiring the write lock (`updateSessionStore`). Two concurrent `chat.send` calls for the same `sessionKey` can read the same snapshot and diverge on `sessionId` selection before either write commits.

Fix: wrap the full `initSessionState` read-decide-write cycle in a per-`sessionKey` async lock (using the existing `withSessionStoreLock` mechanism or a lightweight `AsyncMutex` keyed by `agentId:sessionKey`).

```ts
// Pseudocode structure
return withSessionKeyLock(`${agentId}:${sessionKey}`, async () => {
  const store = await loadSessionStore(storePath, { skipCache: true });
  // ... existing decide logic ...
  await updateSessionStore(storePath, ...);
  return sessionState;
});
```

This is a narrow race (only for simultaneous messages to the same session) and is already mostly mitigated by the outer lock, but worth closing cleanly.

---

## 6. Implementation Plan

> **Sync rules:**
>
> - Each `### Task` heading = one Dart Task (child of the Project)
> - Each `- [ ]` checkbox = one Dart Subtask (child of its Task)
> - `**Status:**` on line 1 of each task syncs with Dart status field
> - Task titles and subtask text must match Dart exactly
> - **Estimates:** hours, not days
> - **Subtasks:** every `- [ ]` item includes a brief inline description after `—`

### Task 1: Phase 1 — Per-session state shape in chat-store.ts

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 3h

Define `PerSessionState`, replace flat global fields with `sessionStates: Map`, add normalized key helper and computed selectors. All existing action implementations are updated to be session-keyed. This is the foundational change that all other phases depend on.

- [ ] 1.1 Define `PerSessionState` type and `DEFAULT_SESSION_STATE` constant — add to top of `chat-store.ts` covering all fields listed in §5.1
- [ ] 1.2 Add `sessionStates: Map<string, PerSessionState>` to store shape — replace the flat `messages`, `messagesLoading`, `isStreaming`, `streamRunId`, `streamContent`, `isSendPending`, `lastStreamEventAt`, `isPaused`, `pauseBuffer` fields
- [ ] 1.3 Add `normalizeSessionKey(key)` helper function — used at every `Map.get/set` boundary inside the store to ensure consistent key format (see §5.4)
- [ ] 1.4 Add `getSessionState(key)` and `getActiveSessionState()` methods to the store — return `DEFAULT_SESSION_STATE` clone when the key is not yet in the Map
- [ ] 1.5 Update `startStream(runId, sessionKey)` — set `isStreaming: true`, `streamRunId: runId`, `streamContent: ""` on the target session's Map entry; create entry if missing
- [ ] 1.6 Update `updateStreamDelta(runId, text, sessionKey)` — guard on `entry.streamRunId !== runId` before mutating; write to the correct Map entry
- [ ] 1.7 Update `finalizeStream(runId, sessionKey, text?, usage?)` — guard on `entry.streamRunId !== runId`; append final assistant message to that session's `messages`; reset `isStreaming`, `streamRunId`, `streamContent`
- [ ] 1.8 Update `appendMessage(message, sessionKey)` — push to the target session's `messages` array; create entry if missing
- [ ] 1.9 Update `setMessages(messages, isRunning, sessionKey)` — apply existing dedup/restore-image-blocks logic scoped to the target session's entry
- [ ] 1.10 Update `setMessagesLoading(loading, sessionKey)` — set `messagesLoading` on the target session entry
- [ ] 1.11 Update `setSendPending(pending, sessionKey)` — set `isSendPending` on the target session entry
- [ ] 1.12 Update `clearMessages(sessionKey)` — reset only that session's `messages` to `[]`
- [ ] 1.13 Update `setActiveSessionKey(key)` — normalize the key; do NOT clear any existing session state (background streams must survive session switches)
- [ ] 1.14 Verify TypeScript compiles clean (`pnpm tsgo`) with no remaining references to the old flat fields

### Task 2: Phase 2 — Update event handler in use-gateway.ts

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 2h

Replace the fragile sessionKey segment heuristic with exact target-key resolution, remove the auto-re-arm, and thread `targetKey` through all store calls. This is the fix for the ping-pong contamination.

- [ ] 2.1 Resolve `targetKey` at the top of `handleChatEvent` — use `normalizeSessionKey(sessionKey)` when the event carries a session key; fall back to `chatStore.activeSessionKey` when untagged (see §5.5)
- [ ] 2.2 Remove the suffix/segment filter block (lines 283–291 in `use-gateway.ts`) — events are no longer dropped based on active session; they always update their target session's state
- [ ] 2.3 Remove the auto-re-arm block (lines 303–309) — replace with `if (state === "started") { chatStore.startStream(runId, targetKey); }` only (see §5.6)
- [ ] 2.4 Update all `chatStore.startStream(runId)` calls to pass `targetKey` as second argument
- [ ] 2.5 Update all `chatStore.updateStreamDelta(runId, delta)` calls to pass `targetKey`
- [ ] 2.6 Update all `chatStore.finalizeStream(runId, ...)` calls to pass `targetKey`
- [ ] 2.7 Update any `chatStore.appendMessage(...)` calls in `use-gateway.ts` to pass `targetKey`
- [ ] 2.8 Run `pnpm tsgo` and confirm no type errors

### Task 3: Phase 3 — Update use-chat.ts call sites

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 1.5h

All store mutations in `use-chat.ts` must pass an explicit session key (the `activeSessionKey` at the time of the call — captured in the closure, not read lazily from the store).

- [ ] 3.1 In `loadHistory`, pass `activeSessionKey` to `store.setMessages(...)` and `store.setMessagesLoading(...)` — capture the key at hook invocation time to prevent race if session changes during async load
- [ ] 3.2 In `sendMessage`, pass `activeSessionKey` to `store.appendMessage(...)` (optimistic user message) and `store.setSendPending(...)`
- [ ] 3.3 In `sendMessage` error path, pass `activeSessionKey` to `store.appendMessage(...)` (error system message) and `store.setSendPending(false, ...)`
- [ ] 3.4 In `clearHistory` / session reset path, pass `activeSessionKey` to `store.clearMessages(...)` and `store.setMessages([], undefined, ...)`
- [ ] 3.5 Audit `useChatStore.getState()` imperative calls in the hook — update each to pass `activeSessionKey` captured from the calling context
- [ ] 3.6 Run `pnpm tsgo` and confirm clean

### Task 4: Phase 4 — Update UI component selectors

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 1.5h

Every `useChatStore((s) => s.fieldName)` call that reads a per-session field must change to `useChatStore((s) => s.getSessionState(s.activeSessionKey).fieldName)`. Covers `chat.tsx`, `chat-input.tsx`, `use-dynamic-placeholder.ts`, and any other consumers found in §3.

- [ ] 4.1 Update `ui-next/src/pages/chat.tsx` — change `messages`, `isStreamingRaw`, `isSendPending`, `streamContent` selectors (lines 50–58) to read from `getSessionState(activeSessionKey)`
- [ ] 4.2 Update `ui-next/src/components/chat/chat-input.tsx` — change the `messages` selector (line 105) to read from active session state
- [ ] 4.3 Update `ui-next/src/hooks/use-dynamic-placeholder.ts` — change `isSendPending`, `isStreaming`, `isPaused` selectors (lines 22–24) to read from active session state
- [ ] 4.4 Update `ui-next/src/hooks/use-chat.ts` — change the `isStreaming` and `isSendPending` selectors (lines 458–459) used for the poll-after-stream `useEffect` to read from active session state
- [ ] 4.5 Audit `ui-next/src/components/chat/chat-header.tsx` for any direct reads of old flat fields — update if found (this component currently only reads `sessions` and `activeSessionKey` which are unaffected)
- [ ] 4.6 Run `pnpm build` (full UI build) — confirm zero type errors and no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings

### Task 5: Phase 5 — Integration smoke test

**Status:** To-do | **Priority:** High | **Assignee:** rohit sharma | **Due:** | **Est:** 1h

Manual and automated verification that parallel sessions are now isolated. No new test framework required — use the existing Vitest suite plus a manual scenario.

- [ ] 5.1 Write a unit test for `chat-store.ts` — create two session keys, start a stream on each concurrently, assert that `getSessionState(keyA).streamContent` and `getSessionState(keyB).streamContent` never overlap
- [ ] 5.2 Write a unit test for the `normalizeSessionKey` round-trip — assert that switching `activeSessionKey` does not clear the old key's Map entry
- [ ] 5.3 Manual scenario: open two chat sessions in the UI simultaneously; send a long-running message in each; switch between them mid-stream; verify no cross-contamination in messages or streaming indicator
- [ ] 5.4 Manual scenario: start a stream in session A, switch to session B (which is idle), confirm session B shows no streaming indicator and correct (empty) messages
- [ ] 5.5 Run `pnpm test` — confirm existing test suite still passes (no regressions from store API changes)

### Task 6: Phase 6 — Server-side per-sessionKey lock in initSessionState

**Status:** To-do | **Priority:** Medium | **Assignee:** rohit sharma | **Due:** | **Est:** 1.5h

Close the narrow race window where two simultaneous `chat.send` calls for the same `sessionKey` can observe the same pre-write snapshot in `initSessionState`. Lower priority than client fixes but important for correctness.

- [ ] 6.1 Add a per-`agentId:sessionKey` async lock map in `src/auto-reply/reply/session.ts` — lightweight `Map<string, Promise<void>>` mutex pattern (or reuse existing `withSessionStoreLock` if it can be keyed at finer granularity)
- [ ] 6.2 Wrap the `loadSessionStore` → decide → `updateSessionStore` block in `initSessionState` with this lock — ensure the lock is released on both success and error paths
- [ ] 6.3 Confirm the lock does not deadlock with the existing per-`storePath` lock in `updateSessionStore` — the inner lock should be a superset, making the outer one a no-op for same-key concurrent calls
- [ ] 6.4 Write a unit test: two concurrent `initSessionState` calls for the same key; assert they receive different `sessionId` values only if one of them triggered a `/new` reset, else assert they see the same stable `sessionId`
- [ ] 6.5 Run `pnpm test` to confirm no regressions in session store tests

---

## 7. References

- Analysis source: this conversation (2026-03-14) — see full breakdown above §4 Design Decisions
- Key source files:
  - `ui-next/src/store/chat-store.ts` (lines 83–290) — global flat state being replaced
  - `ui-next/src/hooks/use-gateway.ts` (lines 270–325) — `handleChatEvent` with fragile filter
  - `ui-next/src/hooks/use-chat.ts` (lines 74–211) — `loadHistory` / `sendMessage`
  - `ui-next/src/pages/chat.tsx` (lines 50–58) — primary streaming state consumers
  - `ui-next/src/hooks/use-dynamic-placeholder.ts` (lines 22–25) — `isSendPending`/`isStreaming` reads
  - `src/auto-reply/reply/session.ts` — `initSessionState` server-side race
  - `src/config/sessions/store.ts` (lines 367–379) — existing `withSessionStoreLock`
- Dart project: _(filled after first sync)_

---

_Template version: 1.0_
