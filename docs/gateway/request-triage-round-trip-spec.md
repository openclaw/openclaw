---
summary: "End-to-end gateway round trip spec for request triage and lane execution"
read_when:
  - Designing API-only vs LLM-assisted execution strategy
  - Integrating external AppFolio/FastAPI services into gateway routing
  - Defining rollout safety checks for gateway triage changes
title: "Gateway Request Round-Trip Spec"
---

# Gateway request round-trip spec

This document defines the full gateway round trip for inbound requests through triage, execution lane selection, and final response delivery.

Current codebase status:

- Identity and scope state machine exists in `src/domain/identity/stateMachine.ts`.
- HTTP ingress already supports execution mode hints via headers in `src/gateway/server-http.ts`.
- OpenResponses and tools HTTP surfaces already execute through gateway agent/tool infrastructure.
- A dedicated production `/api/triage` lane router is not yet implemented in `src/gateway`.

## 1) Request and context schema

### 1.1 Canonical ingress envelope

All inbound messages normalize into this envelope before triage:

```json
{
  "requestId": "uuid",
  "receivedAtMs": 1770686400000,
  "channel": "email",
  "channelIdentity": "resident@example.com",
  "messageText": "What is my current balance for unit 402?",
  "threadId": "optional-thread-id",
  "callSid": "optional-call-id",
  "headers": {
    "x-openclaw-intent-slug": "current_balance",
    "x-openclaw-execution-mode": "api+light-llm",
    "x-openclaw-action-type": "read",
    "x-openclaw-id-resolution": "infer_from_text",
    "x-openclaw-auth-scope": "account.read",
    "x-openclaw-is-financial": "true"
  }
}
```

### 1.2 Context layers

Triaging must build and carry four context layers:

1. Identity context
   - Subject candidates from `createIdentityLookupFromEnv`.
   - Role, allowed properties/units/work orders, verification recency.
2. Authorization context
   - Auth scope claims and channel constraints.
   - State-machine decision: allow, deny, ask_clarification, stepup.
3. Intent context
   - Intent slug from header or classifier.
   - Action type: read, write, notify.
   - Id resolution strategy: single_unit, prompt, infer_from_text.
4. Runtime context
   - Latency budget.
   - Retry budget.
   - Execution mode hint: api-first, api+light-llm, heavy-llm.

### 1.3 Normalized triage request contract

```json
{
  "request": {
    "requestId": "uuid",
    "channel": "sms|email|voice|telegram",
    "channelIdentity": "string",
    "messageText": "string",
    "intentSlug": "string",
    "actionType": "read|write|notify",
    "idResolution": "single_unit|prompt|infer_from_text",
    "executionHint": "api-first|api+light-llm|heavy-llm",
    "isFinancial": true
  },
  "identity": {
    "subjectId": "string",
    "role": "pm|owner|renter|vendor|unknown",
    "allowedPropertyIds": ["string"],
    "allowedUnitIds": ["string"],
    "authLevel": "none|verified|stepup_required",
    "riskScore": 0
  },
  "policy": {
    "decision": "allow|deny|ask_clarification|stepup",
    "denyReason": "optional-string"
  },
  "runtime": {
    "deadlineMs": 6000,
    "maxApiHops": 3,
    "maxLlmCalls": 1
  }
}
```

### 1.4 FastAPI AppFolio adapter contract

Gateway should treat your FastAPI server as a lane dependency, not as a top-level orchestrator.

Required adapter interface:

```ts
type AppFolioAdapter = {
  lookupIdentity(input: {
    channel: "sms" | "email" | "voice" | "telegram";
    channelIdentity: string;
    intentSlug: string;
    requestedAtMs: number;
  }): Promise<{ candidates: SubjectCandidate[] }>;

  executeIntent(input: {
    requestId: string;
    intentSlug: string;
    unitId?: string;
    propertyId?: string;
    messageText: string;
    args: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    data?: Record<string, unknown>;
    errorCode?: string;
    errorMessage?: string;
    retriable?: boolean;
    sourceLatencyMs: number;
  }>;
};
```

## 2) Triage policy and scoring

### 2.1 Hard policy gates (must run first)

Before lane scoring, evaluate hard gates:

1. Identity/scope state machine decision.
2. Financial and legal restrictions.
3. Sensitive-data denial or staff escalation.
4. Channel-level restrictions.

If decision is deny, ask_clarification, or stepup, skip lane scoring and return a policy response immediately.

### 2.2 Lane score model

Compute three lane scores in $[0, 1]$.

$$
score(lane) = w_c \cdot confidence + w_p \cdot policyFit + w_l \cdot latencyFit + w_d \cdot dataAvailability - penalties
$$

Default weights:

- $w_c = 0.35$
- $w_p = 0.25$
- $w_l = 0.20$
- $w_d = 0.20$

### 2.3 Feature definitions

- confidence
  - Identity confidence + intent confidence + entity extraction confidence.
- policyFit
  - 1.0 only if lane can satisfy auth and scope constraints.
- latencyFit
  - 1.0 when estimated completion fits SLA for channel.
- dataAvailability
  - 1.0 when required AppFolio/CRM records are available.

Penalty examples:

- High LLM penalty for regulated financial intents without strict citation mode.
- API-only penalty when required fields are missing and cannot be inferred.
- Low LLM penalty when deterministic tool calling is unavailable.

### 2.4 Route selection and fallback

Deterministic selection:

1. Disqualify lanes that violate policy.
2. Select highest-scoring lane if score >= 0.60.
3. If all scores < 0.60:
   - Prefer Low LLM for read intents.
   - Prefer API Only for strongly structured intents with enough entities.
   - Escalate to High LLM only when synthesis is necessary.
4. On execution failure:
   - API Only retriable failure -> Low LLM with tool-call guidance.
   - Low LLM tool failure -> API Only retry if deterministic path exists.
   - High LLM failure -> fail-safe message + staff escalation flag.

### 2.5 Channel latency budgets

- SMS: 2.5s target, 6s hard timeout.
- Email: 6s target, 20s hard timeout.
- Voice: 1.5s partial + 4s final.
- Telegram: 3s target, 8s hard timeout.

## 3) Lane executors (API Only, Low LLM, High LLM)

### 3.1 API Only lane

Use when intent is deterministic and all required entities are present.

Execution steps:

1. Validate required entities (unitId, propertyId, etc.).
2. Invoke FastAPI AppFolio endpoint through adapter.
3. Apply response sanitizer and field-level policy masking.
4. Format deterministic response template.

Success criteria:

- No model call.
- Stable, auditable field lineage.
- Response contains source and freshness metadata.

### 3.2 Low LLM lane

Use for light paraphrase, slot-filling, and minimal synthesis around tool/API facts.

Execution steps:

1. Build constrained prompt with lane policy and allowed claims.
2. Run at most one model call.
3. Permit tool calls only for approved read operations.
4. Require grounded output from API/tool evidence set.

Guardrails:

- Temperature low.
- No speculative legal or financial interpretation.
- If evidence missing, return clarification prompt instead of fabrication.

### 3.3 High LLM lane

Use only when multi-hop reasoning or broad synthesis is required.

Execution steps:

1. Build comprehensive context bundle (history, policy, evidence).
2. Allow multiple tool calls within budget.
3. Run structured verifier pass for policy and citation compliance.
4. If verifier fails, downgrade to safe fallback response.

Guardrails:

- Strict max token and tool-call budgets.
- Sensitive intents require citation-backed statements.
- Automatic escalation when confidence is below threshold.

### 3.4 Executor interface

```ts
type LaneExecutorResult = {
  lane: "api_only" | "low_llm" | "high_llm";
  status: "ok" | "clarify" | "stepup" | "deny" | "error";
  answerText: string;
  evidence: Array<{
    source: "appfolio_api" | "gateway_tool" | "llm";
    ref: string;
    latencyMs: number;
    freshnessMs?: number;
  }>;
  usage: {
    apiCalls: number;
    llmCalls: number;
    promptTokens?: number;
    completionTokens?: number;
  };
  escalation: {
    required: boolean;
    reason?: string;
  };
};
```

## 4) Response composer and audit trail

### 4.1 Unified response envelope

All lanes must emit the same outer shape:

```json
{
  "ok": true,
  "requestId": "uuid",
  "decision": "allow",
  "lane": "api_only",
  "status": "ok",
  "answer": {
    "text": "Your current balance for Unit 402 is $315.22.",
    "channelSafeText": "Your current balance for Unit 402 is $315.22."
  },
  "meta": {
    "confidence": 0.93,
    "riskScore": 40,
    "latencyMs": 812,
    "escalated": false
  },
  "evidence": [
    {
      "source": "appfolio_api",
      "ref": "accounts_ar.current-balance",
      "latencyMs": 214,
      "freshnessMs": 45000
    }
  ],
  "audit": {
    "policyVersion": "gateway-policy-v1",
    "triageVersion": "triage-v1",
    "traceId": "trace-uuid"
  }
}
```

### 4.2 Audit event stream

Persist one audit event per phase:

1. ingress_received
2. identity_resolved
3. policy_evaluated
4. lane_scored
5. lane_selected
6. executor_completed
7. response_composed
8. response_delivered

Minimum audit fields:

- requestId, traceId, timestampMs
- actor/channel identity hash
- policy decision + reason
- chosen lane + fallback chain
- external dependency timings
- redaction count and sensitive-field flags

### 4.3 Redaction and data minimization

- Never store raw payment credentials, SSN, or full banking numbers.
- Hash channel identities in persistent audit logs.
- Store prompt/response text only in compliant logging mode.

## 5) Test matrix and rollout gates

### 5.1 Test matrix

Functional matrix (minimum):

1. Intent classes
   - billing read, maintenance status, violation info, legal-sensitive, emergency.
2. Identity states
   - known single-unit, known multi-unit, unknown identity.
3. Policy outcomes
   - allow, deny, ask_clarification, stepup.
4. Lane outcomes
   - primary success, fallback success, terminal error.
5. Channel variants
   - sms, email, voice, telegram.

Non-functional matrix:

1. P50/P95 latency per lane and per channel.
2. External API timeout/retry behavior.
3. Hallucination regression for Low/High LLM lanes.
4. Audit completeness and redaction correctness.

### 5.2 Required automated suites

- Unit tests
  - Scoring function determinism and threshold boundaries.
  - Policy gate precedence over scoring.
  - Response envelope invariants.
- Integration tests
  - FastAPI adapter success/failure/timeouts.
  - Fallback routing correctness.
  - Identity scope machine + lane interaction.
- End-to-end tests
  - Representative tenant prompts through HTTP ingress.
  - Expected lane, response, and audit artifacts.

### 5.3 Rollout gates

Gate A: Shadow mode

- Compute triage decisions but do not route production traffic.
- Record lane recommendation and hypothetical outputs.

Gate B: Canary

- Route 5% of eligible traffic.
- Auto-rollback if any of:
  - policy error rate > 0.5%
  - p95 latency regression > 20%
  - escalation miss rate > 0.2%

Gate C: Progressive ramp

- 5% -> 20% -> 50% -> 100% after stable windows.

Gate D: Steady-state SLOs

- API-only lane success >= 99.5% on deterministic intents.
- Clarification precision >= 95% for multi-unit ambiguity.
- Zero unauthorized financial disclosure incidents.

### 5.4 Implementation mapping in this repository

- Ingress + header normalization: `src/gateway/server-http.ts`
- Identity + scope machine: `src/domain/identity/stateMachine.ts`
- External identity lookup adapter: `src/domain/identity/lookup.ts`
- HTTP agent execution surface: `src/gateway/openresponses-http.ts`
- HTTP tool execution surface: `src/gateway/tools-invoke-http.ts`

Suggested next implementation unit:

- Add `src/gateway/triage-router.ts` for scoring and lane selection.
- Add `src/gateway/lane-executors.ts` for API/Low/High executors.
- Add `src/gateway/response-compose.ts` for unified envelope + audit.
