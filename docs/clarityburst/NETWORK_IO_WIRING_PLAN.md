# NETWORK_IO Stage Wiring Plan for ClarityBurst

**Status:** Implementation in Progress  
**Last Updated:** February 15, 2026  
**Pattern:** Follows FILE_SYSTEM_OPS fail-closed template

---

## Executive Summary

The NETWORK_IO stage protects all HTTP/fetch operations invoked by agents. The override function `applyNetworkOverrides()` is fully implemented and tested. This document outlines the integration pattern and identified commit points.

---

## 1. NETWORK_IO Override Function

### Function Signature
```typescript
export function applyNetworkOverrides(
  context: NetworkContext
): Promise<OverrideOutcome>;
```

### Behavior
1. Load NETWORK_IO pack (fail-closed on incomplete)
2. Derive allowed contracts from capabilities
3. Assert non-empty allowlist
4. Route through ClarityBurst router
5. Check thresholds (min_confidence_T, dominance_margin_Delta)
6. Look up contract, check confirmation requirements
7. Return OverrideOutcome (PROCEED, ABSTAIN_CONFIRM, ABSTAIN_CLARIFY)

### Context Structure
```typescript
interface NetworkContext {
  stageId?: string;           // Must be "NETWORK_IO"
  userConfirmed?: boolean;    // Confirmation flag
  operation?: string;         // "fetch", "POST", "GET", etc.
  url?: string;               // Target URL
  [key: string]: unknown;     // Other context fields
}
```

### Return Values
- **PROCEED**: Network operation may execute
- **ABSTAIN_CONFIRM**: Requires user confirmation (HIGH/CRITICAL contracts)
- **ABSTAIN_CLARIFY**: Router unavailable or pack policy incomplete (fail-closed)

---

## 2. Identified Network Operation Commit Points

### Primary Integration Points

#### 1. Media Fetch Operations
**File:** [`src/media/fetch.ts`](src/media/fetch.ts)  
**Function:** `fetchRemoteMedia(options: FetchMediaOptions)`  
**Commit Point:** Line 87 - before `fetchWithSsrFGuard()` call  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "fetch",
  url: options.url,
  userConfirmed: false,
};
```

#### 2. Provider Usage Fetch (API calls)
**Files:**
- [`src/infra/provider-usage.fetch.claude.ts`](src/infra/provider-usage.fetch.claude.ts)
- [`src/infra/provider-usage.fetch.zai.ts`](src/infra/provider-usage.fetch.zai.ts)
- [`src/infra/provider-usage.fetch.gemini.ts`](src/infra/provider-usage.fetch.gemini.ts)
- etc.

**Commit Point:** Before final fetch() calls to external APIs  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "fetch",
  url: "https://api.provider.com/usage",
  userConfirmed: false,
};
```

#### 3. Slack Media Fetch
**File:** [`src/slack/monitor/media.ts`](src/slack/monitor/media.ts)  
**Function:** `fetchWithSlackAuth(url, token)`  
**Commit Point:** Before internal fetch calls  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "fetch",
  url,
  userConfirmed: false,
};
```

#### 4. Telegram Download Operations
**File:** [`src/telegram/download.ts`](src/telegram/download.ts)  
**Functions:** `downloadTelegramFile()`, `fetchTelegramFile()`  
**Commit Point:** Before fetch() calls to Telegram API  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "fetch",
  url: `https://api.telegram.org/file/bot${token}/${filePath}`,
  userConfirmed: false,
};
```

#### 5. TTS Audio Fetch
**File:** [`src/tts/tts.ts`](src/tts/tts.ts)  
**Functions:** `generateAudioOpenAI()`, etc.  
**Commit Point:** Before fetch() calls to TTS providers  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "POST",
  url: "https://api.openai.com/v1/audio/speech",
  userConfirmed: false,
};
```

#### 6. Web/WhatsApp Fetch Operations
**File:** [`src/web/media.ts`](src/web/media.ts)  
**Function:** `loadWebMedia()`  
**Commit Point:** Before `fetchRemoteMedia()` call  
**Context:**
```typescript
const context: NetworkContext = {
  stageId: "NETWORK_IO",
  operation: "fetch",
  url: mediaUrl,
  userConfirmed: false,
};
```

---

## 3. Wiring Pattern

### Template for Each Integration Point

```typescript
// BEFORE: Raw fetch call
const result = await fetchRemoteMedia({
  url,
  // ... other options
});

// AFTER: With ClarityBurst gating
import { applyNetworkOverrides } from "../clarityburst/decision-override.js";

// Step 1: Gate the operation before commit point
const gatingResult = await applyNetworkOverrides({
  stageId: "NETWORK_IO",
  operation: "fetch",
  url,
  userConfirmed: false, // Or extract from context if available
});

// Step 2: Check outcome
if (gatingResult.outcome === "ABSTAIN_CONFIRM") {
  // Requires confirmation - prompt user or return instructions
  throw new ClarityBurstAbstainError(
    gatingResult,
    "User confirmation required before network operation"
  );
}

if (gatingResult.outcome === "ABSTAIN_CLARIFY") {
  // Router outage or policy incomplete - fail closed
  throw new ClarityBurstAbstainError(
    gatingResult,
    "Network operation blocked - gating system unavailable"
  );
}

// Step 3: Operation approved - proceed
const result = await fetchRemoteMedia({
  url,
  // ... other options
});
```

---

## 4. Test Coverage

### Tripwire Test File
**Location:** [`src/clarityburst/__tests__/network_io.router_outage.fail_closed.tripwire.test.ts`](src/clarityburst/__tests__/network_io.router_outage.fail_closed.tripwire.test.ts)

**Tests:**
1. ✅ Router outage returns ABSTAIN_CLARIFY with router_outage reason
2. ✅ Blocks fetch operations when router unavailable (fail-closed invariant)
3. ✅ Provides recovery instructions on router outage

### Existing Tests in decision-override.test.ts
- HIGH-risk contract confirmation gating
- CRITICAL-risk contract confirmation gating
- Uncertainty gating before confirmation
- Router mismatch behavior
- Low dominance/confidence thresholds

---

## 5. NETWORK_IO Contracts Overview

### Contracts by Risk Class

#### LOW Risk (No confirmation required)
- `NETWORK_GET_PUBLIC` - Public HTTP GET requests
- `NETWORK_DNS_LOOKUP` - DNS hostname lookups
- `NETWORK_HEAD_REQUEST` - HTTP HEAD requests

#### MEDIUM Risk (May require confirmation)
- `NETWORK_POST_DATA` - POST requests with body (rate-limited)
- `NETWORK_DOWNLOAD_RESOURCE` - Resource downloads (size-limited)
- `NETWORK_UPLOAD_RESOURCE` - Resource uploads (size-limited)
- `NETWORK_WEBSOCKET_CONNECT` - WebSocket connections

#### HIGH Risk (Requires confirmation)
- `NETWORK_AUTHENTICATED_REQUEST` - Requests with auth headers
- `NETWORK_INTERNAL_ENDPOINT` - Internal network access

#### CRITICAL Risk (Requires confirmation, deny by default)
- `NETWORK_RAW_SOCKET` - Raw socket connections
- `NETWORK_PROXY_TUNNEL` - Proxy tunnel creation

---

## 6. Implementation Strategy

### Phase 1: Core Integration (1-2 days)
1. ✅ Create tripwire test for NETWORK_IO router outage
2. Wire `applyNetworkOverrides()` at primary commit points:
   - Media fetch operations
   - Provider API calls
   - Telegram downloads
   - Slack media operations
3. Run tripwire tests to verify fail-closed behavior

### Phase 2: Extended Coverage (1 day)
1. Wire `applyNetworkOverrides()` at secondary commit points:
   - TTS operations
   - Web/WhatsApp media
   - Provider usage fetches
2. Integration testing with real network calls
3. Verify confirmation gating works as expected

### Phase 3: Validation (1 day)
1. Run full test suite: `pnpm test -- network_io`
2. Verify no regressions in existing functionality
3. Update IMPLEMENTATION_STATUS doc
4. Commit changes

---

## 7. Fail-Closed Invariant

NETWORK_IO uses **fail-closed semantics**:

- ✅ Router unavailable → ABSTAIN_CLARIFY (blocks operation)
- ✅ Pack policy incomplete → ABSTAIN_CLARIFY (blocks operation)
- ✅ Low confidence in routing → ABSTAIN_CLARIFY (blocks operation)
- ✅ HIGH/CRITICAL contract without confirmation → ABSTAIN_CONFIRM (blocks operation)
- ✅ Only PROCEED allows operation to execute

**Critical Property:** If anything goes wrong with the gating system, operations are **blocked** rather than silently allowed.

---

## 8. Key Differences from FILE_SYSTEM_OPS

| Aspect | FILE_SYSTEM_OPS | NETWORK_IO |
|--------|-----------------|-----------|
| Operation Type | Synchronous file I/O | Asynchronous network I/O |
| Confirmation | Token-based with timeout | Boolean flag (async caller owns tokens) |
| Blocking Behavior | Sync throw at commit point | Async reject promise |
| Primary Caller | Agent tools (edit, write, mkdir) | Media processors, API clients |
| Recovery Strategy | Caller retries with token | Caller handles ABSTAIN outcomes |

---

## 9. Status Summary

| Item | Status | Notes |
|------|--------|-------|
| Override function | ✅ Complete | `applyNetworkOverrides()` fully implemented |
| Ontology pack | ✅ Complete | `NETWORK_IO.json` with 11 contracts |
| Tripwire test | ✅ Created | Router outage fail-closed verification |
| Integration wiring | 🔄 In Progress | Identifying and wiring commit points |
| Full test coverage | ⏳ Pending | Will run after wiring all commit points |
| Documentation | 🔄 In Progress | This document + IMPLEMENTATION_STATUS update |

---

## 10. Next Steps

1. **Complete Wiring:** Add `applyNetworkOverrides()` calls at all identified commit points
2. **Test Execution:** Run `pnpm test -- network_io` to verify tripwire passes
3. **Integration Testing:** Test with actual network calls to verify behavior
4. **Documentation:** Update IMPLEMENTATION_STATUS to reflect completion
5. **Commit:** Land changes with clear commit message

---

**Document Status:** READY FOR IMPLEMENTATION  
**Prepared By:** ClarityBurst Implementation  
**Last Review:** February 15, 2026

