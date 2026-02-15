# RFC: A2A Response Routing

**Status:** Draft  
**Author:** OpenClaw Team (Atlas, Metis, Hephaestus, Mara)  
**Date:** 2026-02-15  
**Related:** PR #16565 (A2A tool_invocation provenance)

---

## Abstract

Agent-to-Agent (A2A) communication via `agent_call` and `debate_call` tools currently lacks a structured response return path. When an agent invokes another agent's skill, the response routes to the callee's delivery channel (e.g., Telegram) rather than back to the caller. This RFC proposes a **gateway-level auto-response mechanism** with correlation IDs to deliver responses directly to the calling agent's session context.

---

## Problem Statement

### Current Behavior

```
┌─────────┐    agent_call     ┌─────────┐
│  Caller │ ─────────────────→│  Callee │
│         │   {status:working}│         │
│         │                   │         │
│         │                   │ processes
│         │                   │ skill   │
│         │←── channel ───────│         │
│         │   (Telegram!)     │         │
└─────────┘                   └─────────┘
```

**The gap:**

- `agent_call` returns `{ status: "working", taskId }` immediately
- The callee's response goes to **delivery channel** (Telegram by default)
- The caller never receives the structured result through the tool interface
- `sessions_send` delivers successfully but the return path is missing

### Why This Matters

1. **A2A becomes fire-and-forget** - callers can't build on results
2. **No programmatic access** - responses go to chat UIs, not agent code
3. **Unreliable coordination** - multi-agent workflows can't chain properly
4. **Inconsistent UX** - `agent_call` looks like a function call but behaves like a notification

---

## Proposed Solution

### Design: Gateway-Level Auto-Response with Correlation

**Core principle:** The gateway intercepts callee completion and auto-routes the response to the caller's session context. No agent cooperation required.

```
┌─────────┐    agent_call     ┌─────────┐
│  Caller │ ─────────────────→│  Callee │
│         │   {correlationId, │         │
│         │    status:pending}│         │
│         │                   │ processes
│         │                   │ skill   │
│         │←── gateway ───────│         │
│         │  {correlationId,  │         │
│         │   output, ...}    │         │
└─────────┘                   └─────────┘
```

---

## Specification

### 1. Enhanced skill_invocation Payload

Every `agent_call` invocation includes:

```json
{
  "kind": "skill_invocation",
  "skill": "research",
  "mode": "execute",
  "input": { ... },
  "correlationId": "uuid-here",
  "returnTo": "agent:main:main",
  "timeout": 60000
}
```

**New fields:**

| Field           | Type          | Required | Description                                |
| --------------- | ------------- | -------- | ------------------------------------------ |
| `correlationId` | string (UUID) | Yes      | Matches request to response                |
| `returnTo`      | string        | Yes      | Caller's session key for response delivery |
| `timeout`       | number (ms)   | No       | Per-call timeout, default 60000            |

**Source of `returnTo`:** Derived from `inputProvenance.sourceSessionKey` of the calling tool.

---

### 2. agent_call Return Value

```typescript
// Immediate return (before callee completes)
{
  status: "pending",
  correlationId: "abc-123",
  taskId: "run-id"
}
```

**Note:** Status changes from "working" to "pending" to indicate the response will arrive asynchronously.

---

### 3. Gateway Auto-Response

After the callee's LLM completes, the gateway:

```typescript
async function handleCalleeCompletion(invocation, sessionOutput) {
  if (invocation.correlationId && invocation.returnTo) {
    const response = {
      kind: "skill_response",
      correlationId: invocation.correlationId,
      taskId: sessionOutput.runId,
      status: "completed",
      output: sessionOutput.parsedOutput,
      confidence: sessionOutput.confidence,
      assumptions: sessionOutput.assumptions,
      caveats: sessionOutput.caveats,
    };

    await deliverToSession({
      targetSession: invocation.returnTo,
      message: JSON.stringify(response),
      provenance: {
        kind: "tool_response",
        sourceTool: "agent_call",
        correlationId: invocation.correlationId,
      },
    });
  }
}
```

---

### 4. Response Delivery to Caller

The response appears in the caller's session transcript:

```
[caller session]
...
[tool] agent_call → { correlationId: "abc-123", status: "pending" }
...
[user] skill_response {
  correlationId: "abc-123",
  status: "completed",
  output: {...},
  confidence: 0.9
}
```

The calling agent sees the response naturally in context. No polling required.

---

### 5. Timeout Handling

```typescript
// Gateway sets timeout timer
const timeoutMs = invocation.timeout ?? 60000;

setTimeout(async () => {
  if (!responseDelivered[correlationId]) {
    await deliverToSession({
      targetSession: invocation.returnTo,
      message: JSON.stringify({
        kind: "skill_timeout",
        correlationId,
        taskId: runId,
        status: "timeout",
        message: `Agent call timed out after ${timeoutMs}ms`,
      }),
    });
  }
}, timeoutMs);
```

**Timeout message delivered to caller's session context.**

---

### 6. Storage and State

**Pending request tracking:**

```typescript
// Stored in session state file (survives gateway restart)
pendingRequests: {
  "abc-123": {
    agent: "metis",
    skill: "research",
    startTime: 1708012345678,
    timeout: 90000,
    status: "pending"
  }
}
```

**Lifecycle:**

- Created when `agent_call` invoked
- Updated when response/timeout delivered
- Cleaned up on retrieval or session end

---

## Implementation Phases

### Phase 1: Correlation Metadata

**Scope:** Add correlation fields to skill_invocation

**Changes:**

- `agent-call-tool.ts`: Generate UUID, include in invocation
- `debate-call-tool.ts`: Same for debate participants
- `input-provenance.ts`: Already has `sourceSessionKey` (use as `returnTo`)

**Files:**

- `src/agents/tools/agent-call-tool.ts`
- `src/agents/tools/debate-call-tool.ts`

**Backward compatible:** Additive only

---

### Phase 2: Response Routing in Invocation

**Scope:** Include `returnTo` and `timeout` in every invocation

**Changes:**

- Extract `returnTo` from `inputProvenance.sourceSessionKey`
- Add `timeout` parameter to tool schema (optional, default 60000)
- Include both in the skill_invocation payload

**Files:**

- `src/agents/tools/agent-call-tool.ts`
- `src/agents/tools/debate-call-tool.ts`

---

### Phase 3: Gateway Auto-Response

**Scope:** Gateway intercepts completion and delivers to caller

**Changes:**

- Add completion hook in session/gateway processing
- Check for `correlationId` + `returnTo` in invocation context
- Call `deliverToSession` with skill_response payload

**Files:**

- `src/gateway/session-methods/agent-job.ts` (completion hook)
- `src/sessions/message-delivery.ts` (or equivalent)

**This is the core change.** Requires careful testing.

---

### Phase 4: Timeout Handler

**Scope:** Timeout timer + message delivery

**Changes:**

- Start timer when `agent_call` begins
- On timeout: deliver timeout message to `returnTo` session
- Clean up pending request state

**Files:**

- `src/gateway/server-methods/agent.ts` (or timeout handler location)

---

## Edge Cases

| Scenario                             | Behavior                                                        |
| ------------------------------------ | --------------------------------------------------------------- |
| Callee crashes mid-call              | Timeout message delivered to caller                             |
| Caller session gone                  | Response discarded (no recipient)                               |
| Multiple overlapping calls           | Each `correlationId` tracked independently                      |
| Cascading calls (A→B→C)              | Each hop has own correlation                                    |
| Gateway restart                      | Session state survives; pending requests may timeout on restart |
| Callee returns non-structured output | Parse as best-effort, include as `output` string                |

---

## Backward Compatibility

| Scenario                                | Behavior                                                        |
| --------------------------------------- | --------------------------------------------------------------- |
| Existing `agent_call` without `timeout` | Uses default 60000ms                                            |
| Old caller expecting channel delivery   | Response ALSO goes to channel (dual delivery during transition) |
| `timeoutSeconds: 0` (fire-and-forget)   | No response routing, works as before                            |
| Callee doesn't understand correlation   | Ignores extra fields, still works                               |

**Migration path:**

1. Phase 1-2: Additive, no behavior change
2. Phase 3: Response routing enabled, dual delivery
3. Future: Channel delivery becomes opt-in for fire-and-forget

---

## Alternative: agent_poll Tool

**Lighter alternative if gateway changes are deferred:**

```typescript
agent_poll({ taskId: "..." }) → {
  status: "completed" | "working" | "error" | "timeout",
  output?: unknown,
  confidence?: number
}
```

**Pros:**

- No gateway changes
- Reuses existing `agent.wait` + history fetch
- Works today

**Cons:**

- Requires polling (caller must check repeatedly)
- Not as clean as push delivery
- Doesn't solve fundamental routing gap

**Recommendation:** Implement `agent_poll` as interim solution, pursue full auto-response for clean UX.

---

## Security Considerations

1. **Correlation ID spoofing:** IDs generated by gateway, not caller-controlled
2. **Cross-session access:** `returnTo` validated against caller's actual session
3. **Timeout limits:** Enforce max timeout (e.g., 5 minutes) to prevent resource exhaustion
4. **State cleanup:** Expire pending requests after timeout + grace period

---

## Success Metrics

| Metric                 | Target                            |
| ---------------------- | --------------------------------- |
| Response delivery rate | >99% of completed calls           |
| P99 response latency   | <500ms after callee completion    |
| Timeout accuracy       | ±2 seconds of configured timeout  |
| Backward compatibility | 100% of existing calls unaffected |

---

## Open Questions

1. **Max timeout value:** Should there be a hard cap? (Proposed: 5 minutes)
2. **Response persistence:** How long to keep responses in session state? (Proposed: TTL equal to timeout)
3. **Batch responses:** If multiple skill_responses arrive, how to handle? (Proposed: FIFO in transcript)
4. **Streaming:** Can responses include streaming updates? (Proposed: No, v1 is single-shot)

---

## References

- PR #16565: A2A tool_invocation provenance
- `src/agents/tools/agent-call-tool.ts`: Current implementation
- `src/agents/tools/debate-call-tool.ts`: Debate orchestration
- `src/sessions/input-provenance.ts`: Provenance metadata handling

---

## Acknowledgments

This RFC synthesized from a multi-agent design debate:

- **Mentor** - Proposed initial correlated request-response pattern
- **Metis** - Practicality critique, identified callee routing gap
- **Hephaestus** - Implementation analysis, identified LLM cooperation gap
- **Mara** - Newcomer lens, pushed for default behavior (no flags)
- **Atlas** - Synthesis and RFC author

---

**Status:** Ready for review and implementation planning.
