# Subagent Context Propagation Audit Report

**Task 2.4 - Audit complete**
**Date:** 2026-02-12

## Summary

Audited subagent creation flows to verify that `internal` flag does NOT inherit through subagent spawning. SYSTEM tier must be explicitly granted per-call, not inherited from parent context.

## Key Finding: No Inheritance (CORRECT ✅)

**`internal` flag is NOT propagated to subagents.** This is correct by design:

1. SYSTEM tier is for direct internal runtime calls (cron, CLI, heartbeat)
2. Subagents represent delegated work, not direct internal operations
3. Subagents should use parent sender identity (senderId/senderUsername), not parent privileges

## Files Audited

### 1. Subagent Creation (sessions_spawn tool)

**File:** `src/agents/tools/sessions-spawn-tool.ts`

**Key observations:**

- Lines 248-271: `callGateway()` for subagent run
- Parameters passed: `sessionKey`, `channel`, `to`, `accountId`, `threadId`, `spawnedBy`
- Parameters NOT passed: `internal`, `senderIsOwner`
- Sender identity (`senderId`, `senderUsername`) inherited via context, NOT internal flag

**Verdict:** ✅ CORRECT — no internal flag propagation

### 2. Run Attempt Params

**File:** `src/agents/pi-embedded-runner/run/types.ts`

**Type definition:**

```typescript
export type EmbeddedRunAttemptParams = {
  // ... many fields
  senderIsOwner?: boolean; // Line 37 — legacy field present
  // NO internal?: boolean field
};
```

**Verdict:** ✅ CORRECT — type definition excludes internal field

### 3. Tool Creation in Subagent

**File:** `src/agents/pi-embedded-runner/run/attempt.ts`

**Lines 211-246:** `createOpenClawCodingTools()` call

- Receives `params.senderIsOwner` (line 229)
- Does NOT receive `params.internal` (field doesn't exist in type)

**Verdict:** ✅ CORRECT — no internal parameter passed to tools

## Propagation Flow

```
Parent Session (cron job)
  internal: true → SYSTEM tier

    ↓ (sessions_spawn)

Gateway Call (agent)
  NO internal field passed

    ↓

Subagent Session
  internal: undefined/false → uses senderId resolution
  - If senderId in owners → OWNER tier
  - If senderId in members → MEMBER tier
  - Otherwise → GUEST tier
```

## Security Implications

**Why this matters:**

1. **Principle of attenuation:** Delegated privileges should be less than or equal to delegator
2. **No confused deputy:** Subagent cannot impersonate internal runtime with SYSTEM tier
3. **Audit trail clarity:** SYSTEM tier events are direct internal operations, not delegated work
4. **Explicit trust:** Each SYSTEM tier call must be explicitly attested (internal=true at source)

## Test Coverage

**New tests:** `src/security/heimdall/subagent-inheritance.test.ts` (6 tests)

| Test                                          | Purpose                             |
| --------------------------------------------- | ----------------------------------- |
| parent internal=true, subagent internal=false | Verify NO inheritance               |
| subagent uses parent senderId                 | Identity propagates, not privileges |
| explicit internal=true in subagent            | Security test (should never happen) |
| parent SYSTEM + subagent GUEST                | Inheritance blocked                 |
| parent SYSTEM + subagent MEMBER               | Tier downgrade                      |
| Heimdall disabled                             | internal flag ignored               |

All 6 tests passing ✅

## Potential Attack Vectors (MITIGATED)

1. **Malicious tool attempting to spawn subagent with internal=true**
   - Mitigation: `sessions_spawn` does NOT accept internal parameter
   - Status: ✅ SAFE

2. **Gateway API call with internal=true in params**
   - Mitigation: Type definition excludes internal field
   - Status: ✅ SAFE

3. **Subagent inheriting SYSTEM tier via context**
   - Mitigation: Tool creation does not read internal from params
   - Status: ✅ SAFE

## Recommendations

### ✅ Already Implemented

1. Type safety: `EmbeddedRunAttemptParams` excludes `internal` field
2. Gateway isolation: `sessions_spawn` does not pass internal flag
3. Test coverage: Comprehensive subagent inheritance tests

### Optional Future Enhancements

1. **Audit logging:** Log warning if subagent session has same tier as parent SYSTEM tier
   - Low priority: happens naturally (senderId in members → MEMBER = SYSTEM baseline)
   - Not a security issue, just informational

2. **Explicit non-delegation in docs:**
   - Document in SYSTEM_TIER.md that SYSTEM tier is non-delegable
   - Already implicit in design, make explicit

## Conclusion

**Subagent context propagation is SECURE and CORRECT:**

- ✅ internal flag does NOT inherit to subagents
- ✅ Type definitions enforce exclusion
- ✅ Test coverage validates behavior
- ✅ No security vulnerabilities identified

**Task 2.4 complete:** Subagent inheritance properly audited and verified.
