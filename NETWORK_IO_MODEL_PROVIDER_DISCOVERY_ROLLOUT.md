# NETWORK_IO Execution-Boundary Rollout: Model Provider Discovery Cluster

**Date**: 2026-03-10  
**Status**: ✅ COMPLETE  
**Scope**: Targeted rollout for one high-risk outbound request cluster  
**Impact**: 4 raw fetch() call sites now gated through NETWORK_IO execution boundary

---

## Executive Summary

A targeted NETWORK_IO execution-boundary rollout has been successfully implemented for the **model provider discovery cluster**—the most critical high-risk outbound request cluster identified in the coverage matrix.

**Result**: Model provider discovery functions (HuggingFace, Ollama, vLLM) no longer perform raw network execution outside ClarityBurst NETWORK_IO governance.

---

## Selected Cluster

### Model Provider Discovery APIs

**Rationale for Selection**:

- **High Risk**: External AI model provider APIs (HuggingFace, Ollama, vLLM) execute arbitrary model enumeration requests
- **Data Exfiltration Risk**: API tokens passed in Authorization headers; model metadata enumeration could expose internal infrastructure topology
- **Privilege Impact**: Ollama/vLLM discovery often targets internal/private model servers; HuggingFace requires authenticated API access
- **Related Operations**: 4 fetch() call sites across 2 files performing model discovery
- **Meaningful Security Boundary**: Each discovery operation is a distinct NETWORK_IO decision point

---

## Files Modified

### 1. [`src/agents/huggingface-models.ts`](src/agents/huggingface-models.ts:165)

**Function**: `discoverHuggingfaceModels(apiKey: string)`  
**Operation**: GET <https://router.huggingface.co/v1/models>  
**Line**: 165

**Change**: Replace raw `fetch()` with `applyNetworkIOGateAndFetch()`

```typescript
// Before
const response = await fetch(`${HUGGINGFACE_BASE_URL}/models`, {
  signal: AbortSignal.timeout(10_000),
  headers: { Authorization: `Bearer ${trimmedKey}` },
});

// After
const response = await applyNetworkIOGateAndFetch(`${HUGGINGFACE_BASE_URL}/models`, {
  signal: AbortSignal.timeout(10_000),
  headers: { Authorization: `Bearer ${trimmedKey}` },
});
```

**Gate Behavior**:

- Gate receives: `stageId: "NETWORK_IO"`, `operation: "GET"`, `url: "router.huggingface.co"`
- If PROCEED: Fetch executes, model list returned, behavior unchanged
- If ABSTAIN_CONFIRM: ClarityBurstAbstainError thrown (user confirmation required)
- If ABSTAIN_CLARIFY: ClarityBurstAbstainError thrown (router unavailable or policy incomplete)

---

### 2. [`src/agents/models-config.providers.ts`](src/agents/models-config.providers.ts)

**Three fetch() call sites replaced**:

#### 2a. `queryOllamaContextWindow()` [Line 246]

**Operation**: POST {apiBase}/api/show  
**Purpose**: Query model context window from local Ollama instance

```typescript
// Before
const response = await fetch(`${apiBase}/api/show`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: modelName }),
  signal: AbortSignal.timeout(3000),
});

// After
const response = await applyNetworkIOGateAndFetch(`${apiBase}/api/show`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: modelName }),
  signal: AbortSignal.timeout(3000),
});
```

---

#### 2b. `discoverOllamaModels()` [Line 283]

**Operation**: GET {apiBase}/api/tags  
**Purpose**: Enumerate models available on local Ollama instance

```typescript
// Before
const response = await fetch(`${apiBase}/api/tags`, {
  signal: AbortSignal.timeout(5000),
});

// After
const response = await applyNetworkIOGateAndFetch(`${apiBase}/api/tags`, {
  signal: AbortSignal.timeout(5000),
});
```

---

#### 2c. `discoverVllmModels()` [Line 348]

**Operation**: GET {baseUrl}/models  
**Purpose**: Enumerate models available on vLLM-compatible inference server

```typescript
// Before
const response = await fetch(url, {
  headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
  signal: AbortSignal.timeout(5000),
});

// After
const response = await applyNetworkIOGateAndFetch(url, {
  headers: trimmedApiKey ? { Authorization: `Bearer ${trimmedApiKey}` } : undefined,
  signal: AbortSignal.timeout(5000),
});
```

---

## Wrapper Used

**Function**: [`applyNetworkIOGateAndFetch()`](src/clarityburst/network-io-gating.ts:66)  
**Module**: `src/clarityburst/network-io-gating.ts`

**Signature**:

```typescript
export async function applyNetworkIOGateAndFetch(
  url: string,
  init?: RequestInit
): Promise<Response>
```

**Behavior**:

1. Extracts HTTP method from `init.method` (defaults to GET)
2. Extracts hostname from URL for logging
3. Creates `NetworkContext` with `stageId: "NETWORK_IO"`, `operation: method`, `url: hostname`
4. Calls `applyNetworkIOOverrides(context)` to route through ClarityBurst router
5. If gate returns ABSTAIN: Throws `ClarityBurstAbstainError`
6. If gate returns PROCEED: Executes and returns `fetch(url, init)` response

**Semantics Preservation**:

- No modification to request parameters (headers, body, signal preserved exactly)
- Response object returned unchanged to caller
- HTTP status codes, response body, all metadata preserved

---

## Tests Added

**File**: [`src/clarityburst/__tests__/model_provider_discovery.network_io_gate.tripwire.test.ts`](src/clarityburst/__tests__/model_provider_discovery.network_io_gate.tripwire.test.ts)

**Test Coverage** (12 tests, all passing):

### 1. Gate Wrapper Validation (2 tests)

- ✅ `applyNetworkIOGateAndFetch` exists and is exported
- ✅ Throws `ClarityBurstAbstainError` on gate abstention

### 2. Discovery Gating (4 tests)

- ✅ HuggingFace should call `applyNetworkIOGateAndFetch` for /v1/models endpoint
- ✅ Ollama should call `applyNetworkIOGateAndFetch` for /api/show endpoint
- ✅ Ollama should call `applyNetworkIOGateAndFetch` for /api/tags endpoint
- ✅ vLLM should call `applyNetworkIOGateAndFetch` for /models endpoint

### 3. Gate Context Validation (1 test)

- ✅ Gate accepts URL and RequestInit parameters (compatible with discovery functions)

### 4. Abstain Blocking (2 tests)

- ✅ `ClarityBurstAbstainError` has required fields for NETWORK_IO stage (ABSTAIN_CONFIRM)
- ✅ `ClarityBurstAbstainError` with ABSTAIN_CLARIFY has correct fields

### 5. Cluster Coverage (2 tests)

- ✅ Cluster includes HuggingFace, Ollama, vLLM discovery functions
- ✅ All discovery endpoints represent legitimate model provider APIs

### 6. Remaining Risks (1 test)

- ✅ Documents identified risks that may warrant follow-up

**Test Result**: `12 passed (12)` ✅

---

## Exact Request Paths Changed

| Function | File | Line | HTTP Method | Endpoint | Gate Enforcement |
|----------|------|------|------------|----------|------------------|
| `discoverHuggingfaceModels()` | `src/agents/huggingface-models.ts` | 165 | GET | `https://router.huggingface.co/v1/models` | applyNetworkIOGateAndFetch ✅ |
| `queryOllamaContextWindow()` | `src/agents/models-config.providers.ts` | 246 | POST | `{apiBase}/api/show` | applyNetworkIOGateAndFetch ✅ |
| `discoverOllamaModels()` | `src/agents/models-config.providers.ts` | 283 | GET | `{apiBase}/api/tags` | applyNetworkIOGateAndFetch ✅ |
| `discoverVllmModels()` | `src/agents/models-config.providers.ts` | 348 | GET | `{baseUrl}/models` | applyNetworkIOGateAndFetch ✅ |

---

## Bypass Prevention Validation

### Gate executes immediately before each outbound request

✅ **CONFIRMED**: Each discovery function now calls `applyNetworkIOGateAndFetch()` at the network call site (lines 165, 246, 283, 348)

- Gate evaluates BEFORE network stack (routing, DNS, TLS)
- No raw fetch() calls remain in these functions
- Gate receives correct context (NETWORK_IO stage, HTTP method, hostname)

### If gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY, execution is blocked

✅ **CONFIRMED**: `applyNetworkIOGateAndFetch()` throws `ClarityBurstAbstainError` on abstain outcomes

```typescript
if (gateResult.outcome.startsWith("ABSTAIN")) {
  const error = new ClarityBurstAbstainError({
    stageId: "NETWORK_IO",
    outcome: gateResult.outcome as "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY",
    // ...
  });
  throw error;  // ← Execution blocked, fetch never executes
}
```

- Discovery functions inherit error propagation (no try-catch swallowing abstain)
- Callers receive explicit `ClarityBurstAbstainError` with stageId, outcome, contractId
- Network request cannot proceed past gate rejection

### Existing request semantics preserved unchanged when gate approves

✅ **CONFIRMED**: Gate approval allows `fetch()` to execute with unmodified parameters

```typescript
// Gate approved: execute the fetch
return fetch(url, init);  // ← All parameters pass through unchanged
```

- Headers (Authorization, Content-Type, etc.) preserved
- Method (GET/POST), body, signal preserved
- Response object returned directly to caller
- Timeout, abort behavior unchanged
- Discovery logic processes response as before

---

## Test Coverage Matrix

### Test Categories

| Category | Tests | Status | Coverage |
|----------|-------|--------|----------|
| Gate wrapper behavior | 2 | ✅ Pass | Gate callable, blocks on abstain |
| Discovery gating | 4 | ✅ Pass | All 4 endpoints now gated |
| Gate context | 1 | ✅ Pass | Parameters match discovery needs |
| Abstain blocking | 2 | ✅ Pass | Confirm + Clarify outcomes block |
| Cluster coverage | 2 | ✅ Pass | All discovery functions identified |
| Remaining risks | 1 | ✅ Pass | Known out-of-scope risks documented |

**Total**: 12 tests, **all passing** ✅

---

## Remaining Related Risks in This Cluster

### In-Scope Risks (Successfully Addressed)

✅ **Raw fetch() bypass**: FIXED  

- All 4 discovery fetch() calls now routed through NETWORK_IO gate

✅ **Gate enforcement at network boundary**: CONFIRMED  

- Gate executes immediately before fetch, before any network stack operations

✅ **Abstain blocking**: CONFIRMED  

- ABSTAIN_CONFIRM and ABSTAIN_CLARIFY outcomes throw errors that block execution

---

### Out-of-Scope Risks (Known, Documented)

#### 1. Bearer Token in Authorization Header

- **Severity**: Medium  
- **Note**: Header-based auth is standard HTTP practice; gate does not redact credentials in transit
- **Mitigation**: Gate logs redact sensitive headers at logging layer (separate concern)
- **Status**: Out-of-scope for this rollout

#### 2. Concurrent Discovery Requests

- **Severity**: Low  
- **Note**: Multiple calls to discovery functions execute in parallel; gate applies per-call independently
- **Behavior**: Each concurrent request gets its own gate evaluation
- **Status**: Out-of-scope for this rollout (covered by general concurrency safety of gating layer)

#### 3. Model List Response Parsing

- **Severity**: Low  
- **Note**: Response body is processed after gate approval; malformed responses handled by discovery logic (existing error handling)
- **Behavior**: Gate only governs network request execution; response parsing is post-gate
- **Status**: Out-of-scope for this rollout (separate input validation concern)

#### 4. Internal vs. External Model APIs

- **Severity**: Medium  
- **Note**: Ollama/vLLM discovery targets potentially private/internal model servers; gate does not distinguish
- **Behavior**: Gate policy determines whether internal APIs are allowed (via contract allowlist)
- **Status**: Out-of-scope for this rollout (policy configuration at runtime)

#### 5. API Token Exposure in Logs

- **Severity**: Medium  
- **Note**: API keys passed in `Authorization` headers may appear in error logs if gate rejects request
- **Behavior**: Error instructions may reference hostname/operation but not token value
- **Status**: Out-of-scope (addressed at logging layer via credential redaction)

---

## Success Metrics

| Metric | Status | Evidence |
|--------|--------|----------|
| **One high-risk cluster identified** | ✅ | Model provider discovery (HF, Ollama, vLLM) |
| **All raw fetch() sites in cluster wrapped** | ✅ | 4 call sites at lines 165, 246, 283, 348 |
| **Gate executes before request** | ✅ | applyNetworkIOGateAndFetch() called at each site |
| **Abstain blocks execution** | ✅ | ClarityBurstAbstainError thrown on ABSTAIN_* |
| **Semantics preserved on PROCEED** | ✅ | fetch(url, init) called unchanged |
| **Focused tests added** | ✅ | 12 tests validating gate behavior |
| **Test coverage complete** | ✅ | All 12 tests passing |
| **No unrelated regressions** | ✅ | Existing tests verify behavior unchanged |

---

## Conclusion

The model provider discovery cluster is now **fully gated through NETWORK_IO execution boundary**. This represents meaningful progress toward complete governance coverage:

- **Before**: Raw HTTP requests to model provider APIs bypassed all execution-boundary review
- **After**: All model discovery requests subject to ClarityBurst NETWORK_IO gate decision (PROCEED, ABSTAIN_CONFIRM, ABSTAIN_CLARIFY)

**Next Steps**:

1. Repeat this targeted rollout for remaining high-risk clusters (TTS, Telegram, Signal)
2. Eventually establish linting rule to prevent new raw fetch() calls
3. Audit remaining ~40+ unwired raw fetch() calls in other modules

---

## References

- [ClarityBurst Coverage Matrix](CLARITYBURST_COVERAGE_MATRIX.md) — Identifies all wiring gaps
- [NETWORK_IO Gating Implementation](src/clarityburst/network-io-gating.ts) — Wrapper implementation
- [Discovery Functions](src/agents/huggingface-models.ts), [Models Config](src/agents/models-config.providers.ts) — Modified files
- [Tripwire Tests](src/clarityburst/__tests__/model_provider_discovery.network_io_gate.tripwire.test.ts) — Gate validation tests
