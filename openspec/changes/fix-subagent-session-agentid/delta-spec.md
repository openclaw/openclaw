# Fix Subagent Session agentId Attribution

## Problem Statement

Spawned subagent sessions are incorrectly reporting `agentId: "main"` in API payloads and downstream dashboards, even when spawned with explicit `agentId` parameters (e.g., `mew`, `charmander`, `bulbasaur`).

### Observed Behavior
- **Session keys** are correct: `agent:mew:subagent:...`, `agent:charmander:subagent:...`, `agent:bulbasaur:subagent:...`
- **Downstream titles** display correct agent names: `mew-real-attribution-check`, `charmander-real-attribution-check`
- **API payloads** report incorrect `agentId: "main"` instead of the actual agent identity

### Expected Behavior
When a subagent is spawned with `agentId: "mew"`, all downstream systems (API responses, events, dashboards, analytics) should consistently report `agentId: "mew"`, not `main`.

## Root Cause Analysis

### 1. Where Session Identity is Created

**File:** `src/agents/subagent-spawn.ts`
**Function:** `spawnSubagentDirect()`
**Line:** ~360

```typescript
const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

✅ **This is correct** — the session key is constructed with the target agent ID.

### 2. Where agentId is Resolved for Downstream Consumers

**Problem Area 1: Gateway Event Broadcasting**

**File:** `src/gateway/server-chat.ts`
**Function:** `createAgentEventHandler()`

Events broadcast to nodes/clients include `sessionKey` but not an explicit `agentId` field. The downstream consumer (iOS/Android app, web dashboard, PokeDex dashboard) must derive `agentId` from `sessionKey`.

**File:** `src/routing/session-key.ts`
**Function:** `resolveAgentIdFromSessionKey()`

```typescript
export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const parsed = parseAgentSessionKey(sessionKey);
  return normalizeAgentId(parsed?.agentId ?? DEFAULT_AGENT_ID);
}
```

✅ **This should work correctly** — it extracts the agent ID from the session key.

**Problem Area 2: Context Propagation in Session Store**

**File:** `src/config/sessions.ts` (and related session utility files)

When session metadata is queried or broadcast, there may be code paths that:
1. Look up the **parent session** instead of the child
2. Use a **cached** or **inherited** `agentId` from the spawning context
3. Fail to parse the session key correctly when constructing responses

### 3. Likely Bug Location

**Hypothesis:** The issue is in how `agentId` is propagated when:

1. **Session lifecycle events are emitted** (`sessions.changed`, `subagent_spawned`, etc.)
2. **API responses are constructed** (e.g., `agent.identity.get`, `sessions.list`, dashboard queries)
3. **Context is inherited from parent** during spawn

The most likely culprit is in **`src/agents/subagent-spawn.ts`** where session metadata is patched but `agentId` is not explicitly set in the session entry:

```typescript
const initialChildSessionPatch: Record<string, unknown> = {
  spawnDepth: childDepth,
  subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
  subagentControlScope: childCapabilities.controlScope,
};
```

❌ **Missing:** No explicit `agentId: targetAgentId` in the patch

**File:** `src/gateway/server-methods/agent.ts`
**Function:** `agentHandlers.agent()`

When the subagent session is created via `callGateway({ method: "agent", ... })`, the session entry may be created/updated without explicitly setting `agentId`, allowing it to default to or inherit from the wrong context.

### 4. Secondary Issue: Session Entry Type

**File:** `src/config/sessions/types.ts` (likely)

The `SessionEntry` type may not include an explicit `agentId` field, relying solely on session key parsing. If this field exists but is not being set during subagent spawn, downstream queries may return stale or inherited values.

## Proposed Fix

### Core Change 1: Explicit agentId in Session Entry

**File:** `src/agents/subagent-spawn.ts`
**Line:** ~560 (inside `spawnSubagentDirect`)

Add explicit `agentId` to the initial session patch:

```diff
  const initialChildSessionPatch: Record<string, unknown> = {
+   agentId: targetAgentId,
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
  };
```

### Core Change 2: Persist agentId in Session Store

**File:** `src/gateway/server-methods/agent.ts`
**Line:** ~400-450 (inside `agentHandlers.agent`)

When loading/creating a session entry for the agent request, ensure `agentId` is extracted from the session key and persisted:

```diff
  if (requestedSessionKey) {
    const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
    cfgForAgent = cfg;
    isNewSession = !entry;
    const now = Date.now();
    const sessionId = entry?.sessionId ?? randomUUID();
    const labelValue = request.label?.trim() || entry?.label;
    const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
+   
    spawnedByValue = canonicalizeSpawnedByForAgent(cfg, sessionAgent, entry?.spawnedBy);
    
    // ... rest of the function
    
    const nextEntryPatch: SessionEntry = {
+     agentId: sessionAgent, // ADDED: Explicit agentId from session key
      sessionId,
      updatedAt: now,
      // ... rest of fields
    };
```

### Core Change 3: Ensure SessionEntry Type Includes agentId

**File:** `src/config/sessions/types.ts` (or wherever `SessionEntry` is defined)

Verify the type includes `agentId?`:

```typescript
export type SessionEntry = {
  agentId?: string; // ADDED if missing
  sessionId: string;
  sessionKey?: string;
  // ... rest of fields
};
```

### Core Change 4: Event Broadcasting Enhancement

**File:** `src/gateway/server-chat.ts`
**Function:** `createAgentEventHandler()`

When broadcasting events to nodes/clients, include an explicit `agentId` field derived from `sessionKey`:

```diff
  return (evt: AgentEventPayload) => {
    const chatLink = chatRunState.registry.peek(evt.runId);
    const eventSessionKey =
      typeof evt.sessionKey === "string" && evt.sessionKey.trim() ? evt.sessionKey : undefined;
    const isControlUiVisible = getAgentRunContext(evt.runId)?.isControlUiVisible ?? true;
    const sessionKey =
      chatLink?.sessionKey ?? eventSessionKey ?? resolveSessionKeyForRun(evt.runId);
+   const agentId = sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined;
    const clientRunId = chatLink?.clientRunId ?? evt.runId;
    const eventRunId = chatLink?.clientRunId ?? evt.runId;
    const eventForClients = chatLink ? { ...evt, runId: eventRunId } : evt;
    const isAborted =
      chatRunState.abortedRuns.has(clientRunId) || chatRunState.abortedRuns.has(evt.runId);
    // Include sessionKey so Control UI can filter tool streams per session.
-   const agentPayload = sessionKey ? { ...eventForClients, sessionKey } : eventForClients;
+   const agentPayload = sessionKey 
+     ? { ...eventForClients, sessionKey, agentId } 
+     : eventForClients;
```

## Validation

### End-to-End Validation

1. **Spawn test:**
   ```bash
   # From main session
   sessions_spawn task="test attribution" agentId="mew" label="test-mew-attr"
   ```

2. **Check session list API:**
   ```bash
   openclaw gateway call sessions.list | jq '.[] | select(.label | contains("test-mew-attr")) | {sessionKey, agentId, label}'
   ```
   
   **Expected:**
   ```json
   {
     "sessionKey": "agent:mew:subagent:...",
     "agentId": "mew",
     "label": "test-mew-attr"
   }
   ```

3. **Check live events in Control UI:**
   - Open Control UI dashboard
   - Monitor WebSocket events during spawn
   - Verify `agent` and `chat` events include `agentId: "mew"`

4. **Check PokeDex dashboard:**
   - Spawn Mew, Charmander, Bulbasaur specialists via the pipeline
   - Verify dashboard panels display correct agent names in run history
   - Confirm cost tracking attributes tokens to correct agents

### Unit Test Coverage

**File:** `src/agents/subagent-spawn.test.ts` (create if missing)

```typescript
test("spawned subagent session entry includes explicit agentId", async () => {
  const result = await spawnSubagentDirect(
    { task: "test", agentId: "mew" },
    { agentSessionKey: "agent:main:main" }
  );
  
  expect(result.status).toBe("accepted");
  
  const sessionEntry = loadSessionEntry(result.childSessionKey!);
  expect(sessionEntry.entry?.agentId).toBe("mew");
});

test("event payloads include agentId from session key", () => {
  const sessionKey = "agent:charmander:subagent:test-123";
  const event = {
    runId: "test-run",
    stream: "lifecycle",
    data: { phase: "start" },
    sessionKey,
  };
  
  const enriched = enrichEventWithAgentId(event);
  expect(enriched.agentId).toBe("charmander");
});
```

### Integration Test

**File:** `test/integration/subagent-attribution.test.ts` (create new)

End-to-end test that:
1. Spawns subagents with different agentIds
2. Subscribes to SSE events
3. Validates all events include correct `agentId`
4. Queries session list API and confirms `agentId` matches

## Migration & Compatibility

### Backward Compatibility

✅ **No breaking changes** — adding `agentId` to session entries and event payloads is additive.

Existing systems that:
- Parse `agentId` from `sessionKey` → continue to work
- Don't consume `agentId` → unaffected
- Expect `agentId` in payloads → **now get correct data**

### Migration Steps

1. **Deploy gateway changes** (session store + event enrichment)
2. **No data migration needed** — `agentId` is derived from existing session keys
3. **Dashboard updates** (if needed):
   - PokeDex: Update queries to prefer `agentId` field over parsing `sessionKey`
   - Control UI: Use explicit `agentId` from events instead of deriving it

### Rollback Safety

If issues arise:
1. The explicit `agentId` field can be ignored by downstream consumers
2. All consumers can fall back to parsing `sessionKey` (existing behavior)
3. No data loss — session keys remain the canonical source of truth

## Impact Assessment

### Systems Affected

1. ✅ **Gateway session store** — adds `agentId` field to session entries
2. ✅ **Event broadcasting** — includes `agentId` in `agent` and `chat` events
3. ✅ **Control UI dashboard** — displays correct agent names
4. ✅ **PokeDex dashboard** — accurate cost tracking per agent
5. ✅ **iOS/Android companion apps** — correct session attribution in UI
6. ✅ **Analytics/logging** — proper agent-level metrics

### Performance Impact

❌ **Negligible** — no new queries, just field assignment during existing operations.

### Testing Burden

- Unit tests: ~4 new tests
- Integration tests: 1 new end-to-end test
- Manual QA: 10-15 minutes (spawn + dashboard verification)

## Conclusion

The root cause is missing explicit `agentId` propagation during subagent spawn and event broadcasting. The session key is correct, but downstream consumers receive inconsistent data because:

1. Session entries don't include explicit `agentId` field
2. Event payloads omit `agentId` and rely on parsing `sessionKey` (which may not happen consistently)

The fix is surgical: add `agentId` in two places (session patch + event enrichment) and validate end-to-end attribution. No breaking changes, minimal risk, high impact for dashboard accuracy and operator confidence.
