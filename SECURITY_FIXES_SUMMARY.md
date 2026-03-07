# A2A Security Fixes - Implementation Summary

**Date:** 2026-02-14
**Files Modified:**

- `src/agents/tools/agent-call-tool.ts` (7 tests pass)
- `src/agents/tools/debate-call-tool.ts` (3 tests pass)
- Total: 10/10 unit tests + 3/3 integration tests pass

---

## All 10 Security Fixes Successfully Implemented

### CRITICAL #1: Agent ID Format Validation

**Issue:** Agent IDs not validated, allowing path traversal attacks (e.g., `../../etc/passwd`)

**Fix:**

- Added regex validation: `^[a-z0-9_-]+$` (lowercase alphanumeric, underscore, hyphen)
- Uses `validateAgentId()` from `sessions-helpers.ts`
- Applied at entry point in both tools BEFORE any session key resolution
- Max length: 64 characters

**Implementation:**

```typescript
// agent-call-tool.ts (line 146-156)
let agentId: string;
try {
  agentId = validateAgentId(readStringParam(params, "agent", { required: true }));
} catch (err) {
  logAudit("validation_failed", {
    field: "agent",
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonResult({ status: "error", error: err instanceof Error ? err.message : String(err) });
}

// debate-call-tool.ts (inside resolveAgentSession)
const normalized = validateAgentId(agentRef);
```

---

### CRITICAL #2: Session Key Format Validation

**Issue:** Raw `agent:` prefixes could pass through unvalidated, enabling injection attacks

**Fix:**

- Added `validateAgentSessionKey()` to sessions-helpers.ts
- Regex: `^agent:[a-z0-9_-]+:[a-z0-9_-]+$`
- Validates both format and structure

**Implementation:**

```typescript
// debate-call-tool.ts (line 219-221)
async function resolveAgentSession(agentRef: string, requesterAgentId: string): Promise<string> {
  if (isAgentSessionKeyRef(agentRef)) {
    return validateAgentSessionKey(agentRef);
  }
  const normalized = validateAgentId(agentRef);
  return `agent:${normalized}:main`;
}
```

---

### CRITICAL #3: Input Size Limits

**Issue:** No limits on input payload size, enabling DoS attacks via large payloads

**Fix:**

- Added `validateInputSize()` to sessions-helpers.ts
- Limit: MAX_A2A_INPUT_SIZE = 1MB (1,048,576 bytes)
- Applied BEFORE any gateway calls or agent invocations

**Implementation:**

```typescript
// agent-call-tool.ts (line 163-167)
try {
  validateInputSize(input, MAX_A2A_INPUT_SIZE);
} catch (err) {
  logAudit("validation_failed", {
    field: "input",
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonResult({ status: "error", error: err instanceof Error ? err.message : String(err) });
}

// debate-call-tool.ts (within invokeAgentSkill, line 145)
validateInputSize(params.input, MAX_A2A_INPUT_SIZE);
```

---

### CRITICAL #4: Confidence Bounding

**Issue:** Confidence values not bounded, allowing NaN, Infinity, <0, or >1 to propagate

**Fix:**

- Added `boundConfidence()` to sessions-helpers.ts
- Forces output to [0, 1] range
- Returns 0.5 for invalid values (NaN, Infinity, non-numeric)

**Implementation:**

```typescript
// sessions-helpers.ts
export function boundConfidence(value: unknown): number {
  if (typeof value !== "number") {
    return 0.5;
  }
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

// agent-call-tool.ts (in parseStructuredResponse, lines 101, 124, 146)
confidence = boundConfidence(rawConfidence);

// debate-call-tool.ts (in invokeAgentSkill, lines 195, 207)
confidence = boundConfidence(rawConfidence);
return { output, confidence: boundConfidence(confidence), assumptions, raw };
```

---

### CRITICAL #5: Consolidated A2A Policy Enforcement

**Issue:** Two different policy implementations (checkA2APolicy vs createAgentToAgentPolicy)

**Fix:**

- Standardized on `checkA2APolicy` for both tools
- Returns `{ allowed: boolean, error?: string }`
- Consistent error handling across both tools

**Implementation:**

```typescript
// agent-call-tool.ts (line 269)
const policy = checkA2APolicy(cfg, requesterAgentId, targetAgentId);
if (!policy.allowed) {
  logAudit("policy_denied", { requester: requesterAgentId, target: targetAgentId, skill });
  return jsonResult({ status: "forbidden", error: policy.error });
}

// debate-call-tool.ts (line 295)
const policy = checkA2APolicy(cfg, requesterAgentId, targetId);
if (!policy.allowed) {
  logAudit("policy_denied", { requester: requesterAgentId, target: targetId });
  return jsonResult({ status: "error", error: policy.error, ... });
}
```

---

### HIGH #6: Remove Internal State from Error Messages

**Issue:** Error messages exposed session keys, agent names, internal IDs

**Fix:**

- Replaced sensitive error details with generic messages
- No session keys in error messages
- No agent names in error messages (except for validation failures where user input caused the error)

**Implementation:**

```typescript
// Changed from:
error: `Session ${targetSessionKey} returned empty response`;

// To:
error: "Agent returned empty or invalid response";
```

---

### HIGH #7: Security Audit Logging

**Issue:** No security audit logging for critical operations

**Fix:**

- Added `logAudit()` function to both tools
- Logs all critical operations to console in JSON format
- Suppressed in test environment (NODE_ENV='test')

**Events Logged:**

- `validation_failed` - Agent ID, skill name, input size validation failures
- `policy_denied` - A2A policy denials
- `invocation` - Successful agent invocations

**Implementation:**

```typescript
// agent-call-tool.ts (lines 134-142, 154, 160, 166, 274, 277)
const LOG_PREFIX = "[agent_call]";
const logAudit = (event: string, data: Record<string, unknown>) => {
  if (process.env.NODE_ENV !== "test") {
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "audit",
        component: LOG_PREFIX,
        event,
        ...data,
      }),
    );
  }
};

// Usage examples:
logAudit("validation_failed", { field: "agent", error: err.message });
logAudit("policy_denied", { requester: requesterAgentId, target: targetAgentId, skill });
logAudit("invocation", { requester: requesterAgentId, target: targetAgentId, skill });
```

---

### HIGH #8: Concurrency Limit for Critics

**Issue:** Unbounded `Promise.all` for concurrent critic calls could overwhelm system

**Fix:**

- Added `MAX_CONCURRENT_CRITICS = 3` constant
- Implemented batched execution: runCriticsInBatches
- Processes critics in batches of 3, not all at once

**Implementation:**

```typescript
// debate-call-tool.ts
const MAX_CONCURRENT_CRITICS = 3;

const runCriticsInBatches = async (criticList, sessions, maxConcurrent) => {
  const results = [];
  for (let i = 0; i < criticList.length; i += maxConcurrent) {
    const batch = criticList.slice(i, i + maxConcurrent);
    const batchResults = await Promise.all(
      batch.map(async (critic, batchIdx) => {
        // Execute critic...
      }),
    );
    results.push(...batchResults);
  }
  return results;
};

const critiques = await runCriticsInBatches(critics, criticSessions, MAX_CONCURRENT_CRITICS);
```

---

### HIGH #9: Minimum Critic Success Threshold

**Issue:** All critics failing resulted in empty debate proceeding to resolution

**Fix:**

- Added check: `if (successfulCritiques.length === 0) return error`
- Requires at least 1 successful critique before resolution
- Fails fast with clear error message

**Implementation:**

```typescript
// debate-call-tool.ts (after critiques complete)
const successfulCritiques = critiques.filter((c) => c.confidence > 0);
if (successfulCritiques.length === 0) {
  return jsonResult({
    status: "error",
    conclusion: null,
    confidence: 0,
    confidenceHistory,
    rounds,
    error: "All critics failed - cannot proceed with resolution",
    assumptions: [],
  } as DebateCallResult);
}
```

---

### HIGH #10: Skill Name Validation

**Issue:** Skill names not validated, enabling path traversal via skill parameter

**Fix:**

- Added regex validation: `^[a-zA-Z0-9_-]+$` (case-insensitive)
- Uses `validateSkillName()` from sessions-helpers.ts
- Applied to all skill references (agent, critic, proposer, resolver)

**Implementation:**

```typescript
// agent-call-tool.ts (lines 159-165)
let skill: string;
try {
  skill = validateSkillName(skillRaw);
} catch (err) {
  logAudit("validation_failed", {
    field: "skill",
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonResult({ status: "error", error: err instanceof Error ? err.message : String(err) });
}

// debate-call-tool.ts (lines 204-219)
try {
  proposerSkill = validateSkillName(proposer.skill);
  resolverSkill = validateSkillName(resolver.skill);
  for (const critic of critics) {
    const skillName = critic.skill || "critique";
    criticSkills.push(validateSkillName(skillName));
  }
} catch (err) {
  // Return error...
}
```

---

## Test Results

### Unit Tests: 10/10 PASS ✅

- `agent-call-tool.test.ts`: 7 tests pass
- `debate-call-tool.test.ts`: 3 tests pass

### Integration Tests: 3/3 PASS ✅

- `a2a-tools.integration.test.ts`: 3 tests pass

### Total: 13/13 Tests Pass ✅

---

## Validation Functions Added to sessions-helpers.ts

```typescript
/** Maximum serialized input size (1MB) */
export const MAX_A2A_INPUT_SIZE = 1024 * 1024;

/** Valid agent ID format: lowercase alphanumeric, underscore, hyphen */
export const AGENT_ID_RE = /^[a-z0-9_-]+$/;

/** Valid skill name format: alphanumeric, underscore, hyphen */
export const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Valid session key format for agent sessions: agent:<agentId>:<label> */
export const AGENT_SESSION_KEY_RE = /^agent:[a-z0-9_-]+:[a-z0-9_-]+$/;

export function validateAgentId(agentId: string): string;
export function validateSkillName(skillName: string): string;
export function validateAgentSessionKey(sessionKey: string): string;
export function validateInputSize(input: unknown, maxSize?: number): void;
export function boundConfidence(value: unknown): number;

export function checkA2APolicy(
  cfg: OpenClawConfig,
  requesterAgentId: string,
  targetAgentId: string,
): { allowed: boolean; error?: string };
```

---

## Security Improvements Summary

1. **Injection Prevention:** Agent IDs, skill names, session keys all validated with regex
2. **DoS Protection:** Input size limited to 1MB to prevent large payload attacks
3. **Data Integrity:** Confidence values bounded to [0,1] to prevent NaN/Infinity propagation
4. **Audit Trail:** All critical operations logged for security monitoring
5. **Error Sanitization:** Internal state removed from error messages
6. **Resource Management:** Concurrency limited for critic calls (max 3 concurrent)
7. **Fault Tolerance:** Minimum critic success threshold prevents empty debates
8. **Consistency:** Single policy enforcement function (checkA2APolicy) across both tools

---

## Next Steps

1. **Third Independent Review:** Have a different agent review the fixes
2. **Merge to Main:** After third review approval, merge to main branch
3. **Documentation:** Update tool documentation with security considerations
4. **Integration Testing:** Test with real agent deployments
5. **Monitoring:** Track audit logs in production

---

**Status:** ✅ ALL FIXES IMPLEMENTED AND TESTED
**Recommendation:** Ready for third independent security review
