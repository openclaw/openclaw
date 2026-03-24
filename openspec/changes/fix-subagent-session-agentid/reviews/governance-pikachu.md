# Governance Review: Fix Subagent Session agentId Attribution
**Reviewer:** Pikachu ⚡ (Governance)  
**Date:** 2026-03-24  
**Status:** ✅ **APPROVED**

---

## Executive Summary

The proposed fix is **sound and surgical**. The root cause is correctly identified as missing explicit `agentId` propagation in two locations. The proposed changes are minimal, non-breaking, and directly address the problem without introducing side effects.

**Verdict: APPROVED for implementation.**

---

## Source Code Inspection

### Finding 1: Session Entry Creation (CONFIRMED BUG)

**File:** `src/agents/subagent-spawn.ts` (lines 478-489)

```typescript
const initialChildSessionPatch: Record<string, unknown> = {
  spawnDepth: childDepth,
  subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
  subagentControlScope: childCapabilities.controlScope,
};
if (resolvedModel) {
  initialChildSessionPatch.model = resolvedModel;
}
if (thinkingOverride !== undefined) {
  initialChildSessionPatch.thinkingLevel = thinkingOverride === "off" ? null : thinkingOverride;
}

const initialPatchError = await patchChildSession(initialChildSessionPatch);
```

✅ **Confirmed:** The session patch is created **without explicit `agentId`**.
- Session key is correctly constructed: `agent:${targetAgentId}:subagent:${uuid}`
- But the session entry object is never populated with `agentId: targetAgentId`
- This means downstream lookups must parse the session key every time (fragile)

### Finding 2: Session Entry in Agent Handler (CONFIRMED GAP)

**File:** `src/gateway/server-methods/agent.ts` (lines 430-460)

```typescript
if (requestedSessionKey) {
  const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
  // ... lots of merging logic ...
  const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
  // ... more logic ...
  const nextEntryPatch: SessionEntry = {
    sessionId,
    updatedAt: now,
    thinkingLevel: entry?.thinkingLevel,
    // ... 50+ fields ...
    spawnedBy: spawnedByValue,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnDepth: entry?.spawnDepth,
    // ... NO agentId FIELD ANYWHERE
  };
}
```

✅ **Confirmed:** The agent handler **extracts `sessionAgent`** from the session key on line 435 but **never persists it** back into `nextEntryPatch`.
- `resolveAgentIdFromSessionKey(canonicalKey)` is called and stored in `sessionAgent`
- But `nextEntryPatch` has no `agentId` field — it relies on the session key existing in session.sessionKey
- Problem: downstream API consumers query the session entry and don't get an explicit `agentId` field

### Finding 3: SessionEntry Type Definition

**File:** `src/config/sessions/types.ts` (lines 57-260)

✅ **Confirmed:** The `SessionEntry` type does **NOT include an `agentId` field**.
- All other identity fields are present: `sessionId`, `channel`, `spawnedBy`, etc.
- Absence of `agentId` means it was never intended to be stored at the entry level — relying solely on session key parsing

---

## Root Cause Analysis

The bug occurs because of **split responsibility**:

1. **Session key is authoritative:** `agent:mew:subagent:uuid` correctly encodes the agent identity
2. **Session entry is incomplete:** The `SessionEntry` object never stores the parsed `agentId`
3. **Event broadcasting lacks enrichment:** `createAgentEventHandler()` includes `sessionKey` in payloads but not a derived `agentId` field

### Why This Causes the "agentId: main" Problem

- **Subagent spawn:** `spawnSubagentDirect()` creates correct session key but no explicit `agentId` in entry
- **Session lookup:** When a dashboard or API queries the session, it gets the entry back
- **Downstream parsing:** If the consumer doesn't parse `agentId` from `sessionKey`, it defaults to `"main"` (or inherits from parent context)
- **Event payload:** Events include `sessionKey` but not explicit `agentId`, forcing consumers to parse every time (error-prone)

---

## Proposed Fix Assessment

### ✅ Fix 1: Add `agentId` to Initial Session Patch

**Location:** `src/agents/subagent-spawn.ts` ~line 478

```diff
  const initialChildSessionPatch: Record<string, unknown> = {
+   agentId: targetAgentId,
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
  };
```

**Verdict:** ✅ **SOUND**
- `targetAgentId` is already validated and used to construct the session key
- Adding it to the patch ensures it's persisted on first creation
- No risk: if session already exists, merge semantics preserve the existing value
- Minimal change: one line, idempotent

---

### ✅ Fix 2: Persist `agentId` in Agent Handler Session Entry

**Location:** `src/gateway/server-methods/agent.ts` ~line 454

```diff
  const nextEntryPatch: SessionEntry = {
+   agentId: sessionAgent,  // ADDED: Explicit agentId from session key
    sessionId,
    updatedAt: now,
    thinkingLevel: entry?.thinkingLevel,
    // ... rest of patch
  };
```

**Verdict:** ✅ **SOUND**
- `sessionAgent` is already derived from `canonicalKey` on line 435
- Reusing it here ensures the entry always has explicit `agentId`
- Non-breaking: downstream consumers that parse `sessionKey` continue to work; those that use `agentId` now get correct data
- Safe: merge preserves existing entry values if patch is undefined

---

### ⚠️ Missing: Add `agentId?` Field to SessionEntry Type

**Location:** `src/config/sessions/types.ts` (type definition)

**Current state:** No `agentId` field in `SessionEntry`

**Proposed change:**
```typescript
export type SessionEntry = {
  agentId?: string;  // ADDED: Explicit agent identity for faster lookups
  sessionId: string;
  // ... rest of fields
};
```

**Verdict:** ✅ **NECESSARY** (implied by the fix but not explicitly listed in delta-spec)
- Without this, TypeScript will reject adding `agentId` to `nextEntryPatch`
- Should be added before or alongside the other two changes
- Low risk: optional field, purely additive

---

### ⚠️ Mentioned but NOT Critical: Event Enrichment

**Location:** `src/gateway/server-chat.ts` ~line 697

The delta-spec mentions enriching event payloads with `agentId`:

```diff
  const agentPayload = sessionKey 
+   ? { ...eventForClients, sessionKey, agentId } 
    : eventForClients;
```

**Verdict:** ✅ **GOOD, BUT SECONDARY**
- Current code broadcasts `sessionKey` but not explicit `agentId`
- Adding `agentId: resolveAgentIdFromSessionKey(sessionKey)` would be beneficial for downstream UI
- However, this is **defensive optimization**, not critical to fixing the bug
- The core bug is in session entry creation, not event broadcasting
- Consumers can still parse `agentId` from `sessionKey` if needed

---

## Impact Assessment

### Scope of Changes
- **2 files modified** (subagent-spawn.ts, server-methods/agent.ts)
- **1 type updated** (sessions/types.ts)
- **3 lines of code added** (highly surgical)
- **0 lines deleted**
- **0 breaking changes**

### Backward Compatibility
✅ **No breaking changes**
- Adding `agentId?` to `SessionEntry` is purely additive
- Existing code that ignores `agentId` continues to work
- Session keys remain the canonical source of truth
- Fallback parsing from `sessionKey` still works

### Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Type mismatch on patch | **Very low** | Build failure | Add `agentId?` to SessionEntry type |
| Stale values in entry | **Very low** | Data inconsistency | Patch is merged fresh on every session start |
| Downstream parsing breaks | **None** | N/A | All consumers can still parse `sessionKey` |
| Performance regression | **None** | N/A | Only field assignment, no new queries |

### Testing Requirements (from delta-spec)
1. ✅ Unit test: Session entry includes explicit `agentId`
2. ✅ Unit test: Event payloads include `agentId` (optional)
3. ✅ Integration test: Spawn → list API → verify `agentId` matches
4. ✅ Manual: Dashboard verification (PokeDex agent cost tracking)

**Effort:** ~30-45 minutes (straightforward test cases)

---

## Validation Against Goals

| Criterion | Met? | Notes |
|-----------|------|-------|
| Fixes "agentId: main" problem | ✅ Yes | Session entry now stores correct agent identity |
| Non-breaking | ✅ Yes | Purely additive changes |
| Surgical/minimal | ✅ Yes | 3 lines across 2-3 files |
| Type-safe | ✅ Yes | Requires SessionEntry type update |
| End-to-end correct | ✅ Yes | Session → entry → API → dashboard chain is fixed |
| Testable | ✅ Yes | Clear unit and integration tests |

---

## Recommendations

### Before Merge
1. ✅ Add `agentId?: string` field to `SessionEntry` type definition (required)
2. ✅ Apply Fix 1 (initialChildSessionPatch) 
3. ✅ Apply Fix 2 (nextEntryPatch in agent handler)
4. ⚠️ Consider (optional) applying event enrichment in server-chat.ts for consumer convenience
5. ✅ Add unit tests covering both patches
6. ✅ Add integration test for end-to-end attribution

### Post-Deploy Validation
- Spawn test subagents with distinct agent IDs (mew, charmander, bulbasaur)
- Query `sessions.list` API and verify `agentId` field matches expected values
- Check PokeDex dashboard for correct agent attribution in run history
- Confirm Control UI WebSocket events include correct `agentId`

---

## Conclusion

The fix is **correct and well-scoped**. The root cause is accurately diagnosed as missing explicit `agentId` propagation during subagent spawn and session entry creation. The proposed changes are minimal, type-safe, and non-breaking.

The two core changes (adding `agentId` to initial patch and agent handler patch) directly address the problem. Combined with a SessionEntry type update, this will ensure all downstream systems receive consistent agent attribution without relying solely on session key parsing.

**Verdict: ✅ APPROVED for immediate implementation.**

---

**Signed:** Pikachu ⚡  
**Role:** Governance Review  
**Confidence:** High (based on source inspection + type analysis)
