# Plan: Persistent Thread Sessions

## Problem

When a sub-agent completes, its session dies (session file cleaned up, run ends). Thread replies after that route to the dead subagent session key (`agent:<agentId>:subagent:<uuid>`) via the thread-binding registry. This results in a fresh run with no conversation context — effectively broken.

## Goal

Thread replies should behave like channel messages: if someone posts in a thread created by an agent, it should route to that agent, creating a new session if the previous one ended, with thread history as context.

## Current Flow (traced)

```
Slack message arrives
  → prepareSlackMessage() [src/slack/monitor/message-handler/prepare.ts]
    → resolveAgentRoute() → gets base session key (channel-level routing)
    → resolveSessionKeyWithBinding() [src/routing/session-key-with-binding.ts]
      → buildThreadKey(channel, accountId, threadId)
      → registry.lookup(threadKey) → returns bound session keys
      → If found: returns boundSessions[0] as sessionKey  ← THIS IS THE DEAD KEY
      → If not found: falls back to suffix-based key
    → message dispatched with that sessionKey
  → dispatchPreparedSlackMessage() [src/slack/monitor/message-handler/dispatch.ts]
    → dispatchInboundMessage() → dispatchReplyFromConfig()
      → getReplyFromConfig() → runs agent with the sessionKey
```

**Thread binding creation:**

- `sessions_spawn` tool [src/agents/tools/sessions-spawn-tool.ts] creates thread + binding
- Binding stored in session store entry's `threadBinding` field
- Registry rebuilt from session store on load (survives restarts)
- Registry entry persists even after subagent session completes

**Key data in the binding (ThreadBinding):**

- `channel`, `accountId`, `to`, `threadId` — delivery coordinates
- `mode` — delivery mode (thread-only, thread+announcer, etc.)
- `createdBy` — session key that created the binding (the parent)
- `label` — human-readable label

## Three Cases to Handle

### Case 1: Thread reply with LIVE session (already works ✅)

- Registry returns bound session key
- Session is active, message routes normally

### Case 2: Thread reply with DEAD session (needs fix ❌)

- Registry returns bound session key (e.g., `agent:architect:subagent:<old-uuid>`)
- Session file/run no longer exists
- **Need:** Create a new session for the same agent, bound to the same thread, with thread history

### Case 3: Thread reply with NO binding (already works ✅)

- Registry has no entry for this thread
- Falls through to suffix-based key or base session key
- Normal behavior

## Proposed Changes

### File 1: `src/routing/session-key-with-binding.ts` — Main change

**What:** When the registry returns a bound session, check if it's alive. If dead, return metadata that tells the caller to revive.

**Change:** Add a `revive` field to the return type. The function needs to:

1. Look up bound sessions (existing)
2. Check if the primary bound session is alive (NEW)
3. If alive → return as-is (existing)
4. If dead → return a `revive` descriptor with: agentId (from parsing the dead key), the original ThreadBinding, and the dead session key

```typescript
export type SessionKeyWithBindingResult = {
  sessionKey: string;
  boundSessions?: string[];
  parentSessionKey?: string;
  /** Set when the bound session is dead and needs revival. */
  revive?: {
    agentId: string;
    deadSessionKey: string;
    threadBinding: ThreadBinding;
  };
};
```

**How to check "is alive":** The session store entry exists AND has a recent `updatedAt`. But actually, the simpler check: the session file still exists on disk. Even simpler: check if the embedded PI runner has an active run for this session.

**Recommended approach:** Check the session store. If the entry exists with `updatedAt` within a reasonable window AND there's an active PI run, consider it alive. But this is complex.

**Simpler approach:** Don't check liveness at the routing layer. Instead, always return the bound session key, but ALSO return the ThreadBinding metadata. Let the dispatch layer handle revival. The dispatch layer already loads the session entry — it can detect "this is a subagent session with no active run" and create a new one.

**Actually, simplest approach:** The real issue is that the bound session key is a one-shot subagent key. When it dies, we should create a NEW session key for the same agent and re-bind. This should happen at the point where we detect the thread reply is targeting a dead session.

### Revised approach: Check liveness via session write lock

File `src/agents/session-write-lock.ts` has `isAlive(pid)` for checking if a process is still running. But that's for process-level locks.

### Final approach: Use the PI embedded runner's run state

Actually, let me reconsider. The gateway doesn't reject messages to "dead" session keys — it just starts a new run. The subagent session key works fine for a new run. The problem is:

1. **No conversation history** — the session file was cleaned up
2. **No system prompt context** — the subagent's `extraSystemPrompt` (which included thread/task context) is gone
3. **Replies go to the right thread** — because the ThreadBinding on the session entry persists

So actually, **the routing is fine**. The issue is that the new run on the old session key has no context. We need to:

1. Detect that this is a "revival" (thread reply to a completed subagent session)
2. Inject thread history as context into the new run
3. Inject a system prompt that explains "you are continuing a thread conversation"

### Revised Plan

#### Change 1: `src/routing/session-key-with-binding.ts`

Return the `ThreadBinding` object alongside the session key so downstream code can use it.

```diff
 export function resolveSessionKeyWithBinding(params: {
   ...
 }): {
   sessionKey: string;
   boundSessions?: string[];
   parentSessionKey?: string;
+  threadBinding?: ThreadBinding;
 } {
```

When bound sessions are found, look up the ThreadBinding from the registry/store and include it.

#### Change 2: `src/slack/monitor/message-handler/prepare.ts`

When `resolveSessionKeyWithBinding` returns a bound session:

1. Check if the session is a subagent session (via `isSubagentSessionKey`)
2. Check if the session has an active run (via checking session store `updatedAt` or similar)
3. If it's a dead subagent session:
   - Generate a NEW session key: `agent:<agentId>:subagent:<new-uuid>`
   - Re-bind the thread to the new session key (call `bindSessionToThread`)
   - Set a flag/context so the dispatch layer knows to inject thread history

**Actually, this is getting complex. Let me find the minimal change.**

---

## Minimal Change Plan (Revised)

The core insight: we don't need to create a new session key. The gateway's `agent` handler already handles messages to any session key — it creates/updates the session entry. The problem is purely about **context**: when a thread reply hits a dead subagent session, the new run has no history.

### Step 1: Detect "thread revival" in prepare.ts

In `prepareSlackMessage`, after `resolveSessionKeyWithBinding`:

```typescript
const isThreadRevival =
  isThreadReply &&
  threadKeys.boundSessions?.length > 0 &&
  isSubagentSessionKey(threadKeys.sessionKey) &&
  !hasActiveRun(threadKeys.sessionKey); // need to implement
```

### Step 2: Create new session key on revival

When `isThreadRevival` is true:

1. Extract `agentId` from the dead session key
2. Generate new session key: `agent:<agentId>:subagent:<new-uuid>`
3. Copy the ThreadBinding from the dead session to the new one
4. Update the registry binding
5. Use the new session key for dispatch

### Step 3: Include thread history as context

When `isThreadRevival` is true:

1. Fetch thread messages from Slack (via `conversations.replies`)
2. Format them as context (similar to how `threadStarterBody` works)
3. Include as part of the message body or as `ThreadStarterBody`

### Step 4: Inject revival system prompt

Add an `extraSystemPrompt` or equivalent that tells the agent:

- "You are continuing a conversation in a thread"
- "Here is the thread history for context"

---

## Exact Files to Modify

### 1. `src/routing/session-key-with-binding.ts` (and `src/routing/session-key.ts`)

**Change:** Return `threadBinding` metadata when a bound session is found.

```typescript
// In resolveSessionKeyWithBinding:
if (boundSessions.length > 0) {
  return {
    sessionKey: boundSessions[0],
    boundSessions,
    threadBinding: lookupThreadBinding(boundSessions[0]), // NEW
  };
}
```

Need a synchronous way to get ThreadBinding. Options:

- Add a method to `ThreadBindingRegistry` that stores the binding object (not just the key mapping)
- Or look it up from the session store (already loaded)

**Recommended:** Extend `ThreadBindingRegistry` to store `ThreadBinding` objects, not just key mappings. Add `getBindingData(sessionKey): ThreadBinding | undefined`.

### 2. `src/config/thread-registry.ts`

**Change:** Store `ThreadBinding` objects in the registry alongside key mappings.

```typescript
// Add to ThreadBindingRegistry:
private sessionBindings = new Map<string, ThreadBinding>();

bind(sessionKey: string, threadKey: string, binding?: ThreadBinding): void {
  // ... existing logic ...
  if (binding) {
    this.sessionBindings.set(sessionKey, binding);
  }
}

getBindingData(sessionKey: string): ThreadBinding | undefined {
  return this.sessionBindings.get(sessionKey);
}
```

Update `mergeFromSessions` to pass binding objects.

### 3. `src/slack/monitor/message-handler/prepare.ts`

**Change:** After resolving thread session key, detect revival and handle it.

Add after the `resolveSessionKeyWithBinding` call (~line 175):

```typescript
let sessionKey = threadKeys.sessionKey;
let isThreadRevival = false;

if (isThreadReply && threadKeys.boundSessions?.length && isSubagentSessionKey(sessionKey)) {
  // Check if the bound session has an active run
  const agentId = parseAgentSessionKey(sessionKey)?.agentId;
  if (agentId) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey.toLowerCase()] ?? store[sessionKey];

    // Consider "dead" if no session entry or very stale
    // A live embedded-pi run updates the entry frequently
    const isLikelyDead = !entry || Date.now() - (entry.updatedAt ?? 0) > 60_000;

    if (isLikelyDead) {
      // Create new session key for the same agent
      const newSessionKey = `agent:${agentId}:subagent:${crypto.randomUUID()}`;

      // Re-bind thread to new session
      const oldBinding = threadKeys.threadBinding;
      if (oldBinding) {
        await bindSessionToThread({
          storePath,
          sessionKey: newSessionKey,
          binding: { ...oldBinding, boundAt: Date.now() },
        });
      }

      sessionKey = newSessionKey;
      isThreadRevival = true;
    }
  }
}
```

When `isThreadRevival` is true, include thread history in the context. The thread starter + messages are already fetched for thread replies (existing code handles `threadStarterBody`). We can extend this to include more thread messages.

### 4. `src/slack/monitor/message-handler/prepare.ts` (thread history for revival)

**Change:** When `isThreadRevival`, fetch full thread history and format as context.

The existing code already fetches the thread starter message. For revival, we need the full thread (all messages). Add a helper:

```typescript
// In prepare.ts, when isThreadRevival:
if (isThreadRevival && threadTs) {
  const threadMessages = await fetchThreadHistory({
    channelId: message.channel,
    threadTs,
    client: ctx.app.client,
    limit: 50, // reasonable limit
  });
  // Format as context and prepend to body
  const threadContext = formatThreadHistoryForRevival(threadMessages);
  combinedBody = `${threadContext}\n\n${combinedBody}`;
}
```

### 5. New helper: `src/slack/monitor/thread-history.ts`

**Change:** New file with `fetchThreadHistory` and `formatThreadHistoryForRevival`.

Uses `conversations.replies` API (already used in `src/slack/actions.ts`).

### 6. `src/auto-reply/reply/dispatch-from-config.ts` (minor)

**No change needed** — the dispatch code already handles ThreadBinding delivery. The new session key will have the same binding, so replies route correctly.

---

## Summary of Changes

| File                                           | Change                                                      | Complexity |
| ---------------------------------------------- | ----------------------------------------------------------- | ---------- |
| `src/config/thread-registry.ts`                | Store ThreadBinding objects in registry                     | Small      |
| `src/routing/session-key-with-binding.ts`      | Return threadBinding in result                              | Small      |
| `src/routing/session-key.ts`                   | Pass through threadBinding from binding module              | Small      |
| `src/slack/monitor/message-handler/prepare.ts` | Detect dead session, create new key, re-bind, fetch history | Medium     |
| `src/slack/monitor/thread-history.ts` (NEW)    | Fetch + format thread history for revival                   | Small      |

**Total: ~150-200 lines of new/changed code.**

## Why It Doesn't "Just Work" Today

Even with `cleanup: "keep"` (default), thread replies to dead subagents fail because:

1. **Session staleness:** `evaluateSessionFreshness()` in `initSessionState()` (session.ts:222) checks `updatedAt` against the reset policy's `idleMinutes`. A subagent that finished hours ago is marked stale → new empty session created with `isNewSession = true`.

2. **Lost system prompt context:** The subagent's `extraSystemPrompt` (containing the task description, thread context, and subagent identity) was injected as a one-shot parameter in the initial `callGateway({ method: "agent", ... extraSystemPrompt })` call. It's not persisted or re-injected on subsequent runs.

3. **Subagent prompt mode:** `isSubagentSessionKey()` triggers `promptMode = "minimal"` (pi-embedded-runner/run/attempt.ts:340), which gives a stripped-down system prompt. Without the original task context, the agent has no idea what the thread is about.

So even though the routing/binding infrastructure works, the revived session starts as a blank agent with no understanding of the thread's purpose.

## Edge Cases

1. **Race condition:** Two messages arrive at the same time for a dead session → both try to create new keys. Mitigation: the first one wins (registry bind is idempotent), second message routes to the first's new key on next lookup. Acceptable.

2. **Session "just finished" but updatedAt is recent:** Use a more robust check — look for active PI runner session, not just timestamp. Can use `isEmbeddedPiRunActive()` from `src/agents/pi-embedded-runner/runs.ts`.

3. **Non-subagent thread bindings:** Only apply revival logic to subagent session keys. Regular thread sessions (suffix-based) don't need this.

4. **Thread binding cleanup:** Old dead session entries accumulate bindings. The existing `mergeFromSessions` handles this — old entries get cleaned up when the session store is compacted.

5. **Cross-agent thread revival:** The binding's `createdBy` field tells us which parent session spawned it. We could optionally notify the parent. Not needed for MVP.

## Alternative: Simpler "re-route to parent" approach

Instead of creating a new subagent session, we could route thread replies to the **parent session** (the one that spawned the subagent). This is simpler but changes the UX: the main agent would see thread replies, not a fresh sub-agent.

**Not recommended** because: the thread was created by a specific agent for a specific purpose. Routing to parent breaks the isolation model.

## Revised Architectural Decision

Given the findings above, there are two viable approaches:

### Approach A: "New session key per revival" (recommended)

When a thread reply targets a dead subagent session:

1. Create a fresh session key (`agent:<agentId>:thread:<threadId>`) — NOT a subagent key
2. This avoids `promptMode: "minimal"` and subagent restrictions
3. Bind the thread to the new key
4. Inject thread history as the conversation preamble
5. Include a system prompt explaining the thread context

**Pros:** Clean separation from the original subagent. No subagent restrictions. Thread-scoped reset policy.
**Cons:** Loses original subagent's conversation history (mitigated by thread history injection).

### Approach B: "Reuse dead session key"

Route to the same subagent session key and let the system create a new session file.

**Pros:** Simpler. Retains session file if `cleanup: "keep"` and not stale.
**Cons:** Subject to `promptMode: "minimal"`, `requireExplicitMessageTarget`, and no `sessions_spawn` capability. Lost `extraSystemPrompt`. Feels fragile.

**Verdict: Approach A.** The new session key format `agent:<agentId>:thread:<threadId>` makes it a normal agent session (full prompt mode, full capabilities), scoped to the thread. This is semantically correct: the thread is now a standalone conversation channel for that agent.

## Updated Exact Changes

### 1. `src/config/thread-registry.ts`

**Store ThreadBinding data in registry.**

```typescript
// Add to ThreadBindingRegistry class:
private sessionBindings = new Map<string, ThreadBinding>();

// Update bind():
bind(sessionKey: string, threadKey: string, binding?: ThreadBinding): void {
  // existing unbind/rebind logic...
  if (binding) {
    this.sessionBindings.set(sessionKey, binding);
  }
}

// Update unbind():
unbind(sessionKey: string): boolean {
  // existing logic...
  // DO NOT delete from sessionBindings — we need it for revival lookup
}

// New method:
getBindingData(sessionKey: string): ThreadBinding | undefined {
  return this.sessionBindings.get(sessionKey);
}

// Update mergeFromSessions to pass binding data
```

### 2. `src/routing/session-key-with-binding.ts`

**Return binding metadata + detect dead sessions.**

```typescript
export type SessionKeyBindingResult = {
  sessionKey: string;
  boundSessions?: string[];
  parentSessionKey?: string;
  threadBinding?: ThreadBinding;
};

export function resolveSessionKeyWithBinding(params: {
  baseSessionKey: string;
  channel?: string;
  accountId?: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): SessionKeyBindingResult {
  // ... existing lookup ...

  if (boundSessions.length > 0) {
    const primaryKey = boundSessions[0];
    const binding = registry.getBindingData(primaryKey);

    return {
      sessionKey: primaryKey,
      boundSessions,
      threadBinding: binding,
    };
  }
  // ... existing fallback ...
}
```

### 3. `src/slack/monitor/message-handler/prepare.ts`

**Core revival logic.** After `resolveSessionKeyWithBinding`:

```typescript
import { isSubagentSessionKey, parseAgentSessionKey } from "../../../routing/session-key.js";
import { bindSessionToThread } from "../../../config/thread-registry.js";
import { isEmbeddedPiRunActive } from "../../../agents/pi-embedded-runner/runs.js";

// After resolveSessionKeyWithBinding call:
let sessionKey = threadKeys.sessionKey;
let threadRevivalContext: string | undefined;

if (isThreadReply && threadKeys.boundSessions?.length && threadKeys.threadBinding) {
  const primaryBoundKey = threadKeys.boundSessions[0];

  // Check if the bound session is a completed subagent
  if (isSubagentSessionKey(primaryBoundKey)) {
    const parsed = parseAgentSessionKey(primaryBoundKey);
    const agentId = parsed?.agentId;

    if (agentId) {
      // Check if run is still active
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);
      const entry = store[primaryBoundKey.toLowerCase()] ?? store[primaryBoundKey];
      const sessionId = entry?.sessionId;
      const isActive = sessionId ? isEmbeddedPiRunActive(sessionId) : false;

      if (!isActive) {
        // REVIVAL: Create new thread-scoped session key
        const threadSessionKey = `agent:${agentId}:slack:channel:${message.channel}:thread:${threadTs}`;

        // Re-bind the thread to the new session key
        const binding = threadKeys.threadBinding;
        await bindSessionToThread({
          storePath,
          sessionKey: threadSessionKey,
          binding: { ...binding, boundAt: Date.now() },
        });

        sessionKey = threadSessionKey;

        // Flag for thread history injection (handled below)
        threadRevivalContext = `[Thread revival] This thread was originally handled by a sub-agent session. The sub-agent has completed. You are continuing the conversation in this thread as agent "${agentId}".`;
      }
    }
  }
}
```

Then, when building `combinedBody`, prepend `threadRevivalContext` if set. The existing `threadStarterBody` already provides the thread's first message. For full context, we can also fetch recent thread messages.

### 4. `src/slack/monitor/thread-history.ts` (NEW)

**Fetch and format thread history for revival context.**

```typescript
export async function fetchThreadHistoryForRevival(params: {
  channelId: string;
  threadTs: string;
  client: WebClient;
  botUserId?: string;
  limit?: number;
}): Promise<string | undefined> {
  const { channelId, threadTs, client, limit = 20 } = params;

  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit,
    });

    if (!result.messages?.length) return undefined;

    const formatted = result.messages
      .map((msg) => {
        const sender = msg.user === params.botUserId ? "Agent" : (msg.user ?? "Unknown");
        const text = (msg.text ?? "").trim();
        return `[${sender}]: ${text}`;
      })
      .join("\n");

    return `--- Thread History ---\n${formatted}\n--- End Thread History ---`;
  } catch {
    return undefined;
  }
}
```

### 5. `src/routing/session-key.ts`

**Update the re-exported `resolveSessionKeyWithBinding` to pass through new fields.**

The function in `session-key.ts` is a copy of the one in `session-key-with-binding.ts`. Update both to return `threadBinding`.

### 6. No changes needed in:

- `dispatch-from-config.ts` — ThreadBinding delivery already works via session store lookup
- `sessions-spawn-tool.ts` — binding creation is fine
- `gateway/server-methods/agent.ts` — handles any session key format

## Recommended Implementation Order

1. Extend `ThreadBindingRegistry` to store binding data (thread-registry.ts)
2. Update `resolveSessionKeyWithBinding` to return binding metadata (both files)
3. Create thread history helper (slack/monitor/thread-history.ts)
4. Implement revival logic in `prepareSlackMessage` (prepare.ts)
5. Test manually: spawn sub-agent with thread binding → let it complete → reply in thread
6. Add unit tests for revival detection and re-binding
7. Later: generalize for Discord/Telegram (same pattern, different prepare files)
