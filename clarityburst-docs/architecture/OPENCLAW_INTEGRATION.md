# ClarityBurst Integration with OpenClaw

## Executive Summary

ClarityBurst is a **decision-gating system** integrated into OpenClaw that controls operation execution across 12 capability stages. It routes decisions through a separate router service and applies threshold-based logic to determine whether operations should `PROCEED`, require `ABSTAIN_CONFIRM` (user confirmation), or `ABSTAIN_CLARIFY` (fail-closed).

**Why This Matters for OpenClaw:**
- Enterprises need deterministic control over agent operations (not probabilistic)
- ClarityBurst provides fail-closed gates at 12 critical decision points
- All side-effectful operations (shell, network, file I/O, sub-agent spawn) are routed through ClarityBurst
- Threshold logic ensures confidence and dominance before allowing execution
- Complete audit trail of all decisions

---

## 1. Integration Architecture Overview

### High-Level Flow

```
OpenClaw Operation Request
    ↓
ClarityBurst Gating (decision-override.ts)
    ├─ Load ontology pack (pack-registry.ts)
    ├─ Derive allowed contracts (allowed-contracts.ts)
    ├─ Assert non-empty allowlist (allowed-contracts.ts)
    ├─ Route through ClarityBurst Router API (router-client.ts)
    │   └─ POST /api/route to CLARITYBURST_ROUTER_URL
    └─ Apply local threshold logic
        └─ Return: PROCEED | ABSTAIN_CONFIRM | ABSTAIN_CLARIFY
    ↓
Operation Execution (or Blocking)
```

### 12 Gating Stages (OpenClaw Control Points)

ClarityBurst controls decisions across these stages:

1. **TOOL_DISPATCH_GATE** - Which tool to invoke (web_search, email, calculator, etc.)
2. **SHELL_EXEC** - Command/script execution (bash, PowerShell, etc.)
3. **FILE_SYSTEM_OPS** - File read/write/delete operations
4. **NETWORK_IO** - HTTP/network requests (external APIs)
5. **MEMORY_MODIFY** - Session state modifications (context updates)
6. **SUBAGENT_SPAWN** - Sub-agent creation (new autonomous agents)
7. **NODE_INVOKE** - Node.js code evaluation
8. **BROWSER_AUTOMATE** - Browser automation (Playwright, etc.)
9. **CRON_SCHEDULE** - Scheduled task creation
10. **MESSAGE_EMIT** - Message transmission (chat, email, SMS)
11. **MEDIA_GENERATE** - Media generation (images, videos)
12. **CANVAS_UI** - Canvas UI operations

**Each stage has:**
- Ontology pack defining valid contracts (actions)
- Confidence/dominance thresholds
- Confirmation requirements for HIGH/CRITICAL operations
- Fail-closed default (block unless confident)

---

## 2. Code Structure & OpenClaw Integration Points

### Primary Files in OpenClaw Fork

#### `src/clarityburst/router-client.ts` (The HTTP Bridge)

**Purpose:** HTTP client that calls the separate ClarityBurst Router service

**Function:** `async routeClarityBurst(input: RouterInput): Promise<RouterResult>`

**What it does:**
- Validates request input (`allowedContractIds` array)
- Makes POST request to `CLARITYBURST_ROUTER_URL/api/route`
- Parses and validates response
- Logs metrics (latency, errors, success)
- Handles timeouts (configurable 100-5000ms, default 1200ms)

**Called by:** `decision-override.ts` stage functions

---

#### `src/clarityburst/decision-override.ts` (The 12 Gating Functions)

**Purpose:** Implements the fail-closed gating logic for each of 12 stages

**12 Stage Functions (one per control point):**
- `applyToolDispatchGateOverrides()` → Which tool to use
- `applyShellExecOverrides()` → Allow shell command
- `applyFileSystemOverrides()` → Allow file operation
- `applyNetworkOverrides()` → Allow network request
- `applyMemoryModifyOverrides()` → Allow context modification
- `applySubagentSpawnOverrides()` → Allow sub-agent creation
- `applyNodeInvokeOverrides()` → Allow Node.js evaluation
- `applyBrowserAutomateOverrides()` → Allow browser automation
- `applyCronScheduleOverrides()` → Allow scheduled task
- `applyMessageEmitOverrides()` → Allow message sending
- `applyMediaGenerateOverrides()` → Allow media generation
- `applyCanvasUiOverrides()` → Allow Canvas UI operation

**Execution Pattern (All Stages Follow This):**

```typescript
export async function applyXxxOverrides(context: XxxContext): Promise<OverrideOutcome> {
  // 1. Load ontology pack for this stage
  const pack = loadPackOrAbstain(STAGE_ID);
  
  // 2. Derive which contracts are allowed at runtime
  // (filters by runtime capabilities: shellEnabled, fsWriteEnabled, etc.)
  const caps = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(STAGE_ID, pack, caps);
  
  // 3. Fail-closed: assert allowlist is non-empty
  // (if no contracts allowed, block operation)
  assertNonEmptyAllowedContracts(STAGE_ID, allowedContractIds);
  
  // 4. Route through ClarityBurst API to get decision
  const routeResult = await routeClarityBurst({
    stageId: STAGE_ID,
    packId: pack.pack_id,
    packVersion: pack.pack_version,
    allowedContractIds,
    userText: "",
    context: { /* operation-specific context */ }
  });
  
  // 5. Apply local threshold logic
  // (check confidence, dominance, confirmation requirements)
  const result = applyXxxOverridesImpl(pack, routeResult, context);
  return result;  // PROCEED | ABSTAIN_CONFIRM | ABSTAIN_CLARIFY
}
```

---

#### `src/clarityburst/config.ts` (Configuration Management)

**Purpose:** Loads and validates ClarityBurst configuration at startup

**Environment Variables:**
```bash
CLARITYBURST_ENABLED=true                      # Enable/disable gating
CLARITYBURST_ROUTER_URL=http://localhost:3001  # Router service URL
CLARITYBURST_ROUTER_TIMEOUT_MS=1200            # Request timeout
CLARITYBURST_LOG_LEVEL=info                    # Log verbosity
```

**Validation:**
- Router URL must be valid HTTP/HTTPS
- Timeout must be 100-5000ms
- Fails fast at startup if invalid
- Warns if non-HTTPS in production

---

#### `src/clarityburst/pack-registry.ts` (Ontology Pack Loading)

**Purpose:** Loads and validates ontology packs for each stage

**What's an Ontology Pack?**
A JSON file defining the contracts (valid actions) for a stage:

```json
{
  "pack_id": "openclawd.NETWORK_IO",
  "pack_version": "1.0.0",
  "stage_id": "NETWORK_IO",
  "thresholds": {
    "min_confidence_T": 0.55,
    "dominance_margin_Delta": 0.10
  },
  "contracts": [
    {
      "contract_id": "NET_HTTPS_POST",
      "description": "HTTPS POST request",
      "risk_level": "MEDIUM",
      "needs_confirmation": false
    },
    ...
  ]
}
```

**Packs Location:** `ontology-packs/` directory in ClarityBurst Router repository

---

#### `src/clarityburst/allowed-contracts.ts` (Capability Filtering)

**Purpose:** Derives which contracts are allowed at runtime based on OpenClaw capabilities

**Runtime Capabilities:**
```typescript
interface RuntimeCapabilities {
  browserEnabled: boolean;        // Can use browser automation
  shellEnabled: boolean;          // Can execute shell commands
  fsWriteEnabled: boolean;        // Can write to filesystem
  networkEnabled: boolean;        // Can make network requests
  explicitlyAllowCritical: boolean;  // Can execute CRITICAL contracts
  sensitiveAccessEnabled: boolean;   // Can access sensitive resources
}
```

**Filtering Logic:**
- Exclude CRITICAL contracts unless `explicitlyAllowCritical: true`
- Filter by `capability_requirements` (e.g., requires "shell")
- TOOL_DISPATCH_GATE has special filtering for tool availability

---

## 3. API Contract (OpenClaw → ClarityBurst Router)

### Request Format

**Endpoint:** `POST {CLARITYBURST_ROUTER_URL}/api/route`

**Content-Type:** `application/json`

```typescript
interface RouterInput {
  stageId: string;                  // e.g., "NETWORK_IO"
  packId: string;                   // e.g., "openclawd.NETWORK_IO"
  packVersion: string;              // e.g., "1.0.0"
  allowedContractIds: string[];     // e.g., ["NET_HTTPS_GET", "NET_HTTPS_POST"]
  userText: string;                 // Additional context (usually empty)
  context?: Record<string, unknown>;  // Stage-specific metadata
}
```

**Validation (in OpenClaw before sending):**
- `allowedContractIds` must be a non-empty array
- No duplicate contract IDs
- Validated in `validateAllowedContractIds()` before HTTP call

### Response Format

**Success Response (200 OK):**

```typescript
interface RouterResultOk {
  ok: true;
  data: {
    top1: {
      contract_id: string;    // e.g., "NET_HTTPS_POST"
      score: number;          // 0.0-1.0 (confidence)
    };
    top2: {
      contract_id: string;    // e.g., "NET_HTTPS_GET"
      score: number;
    };
    router_version?: string;  // Optional version info
  };
}
```

**Error Response:**

```typescript
interface RouterResultError {
  ok: false;
  error: string;    // Error description
  status?: number;  // HTTP status if available
}
```

**Error Handling in OpenClaw:**
- **HTTP 4xx/5xx:** Returns error, operation blocked (fail-closed)
- **Timeout (>1200ms):** Returns error, operation blocked for side-effectful ops
- **Network error:** Returns error, operation blocked for side-effectful ops
- **Invalid JSON:** Returns error, operation blocked

---

## 4. Example Integration Scenarios

### Example 1: NETWORK_IO (Web Search)

**OpenClaw operation:** Agent wants to search the web

**Request to ClarityBurst:**
```json
{
  "stageId": "NETWORK_IO",
  "packId": "openclawd.NETWORK_IO",
  "packVersion": "1.0.0",
  "allowedContractIds": ["NET_HTTPS_GET", "NET_HTTPS_POST"],
  "userText": "",
  "context": {
    "operation": "GET",
    "url": "https://api.example.com/search"
  }
}
```

**ClarityBurst Response:**
```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "NET_HTTPS_GET",
      "score": 0.92
    },
    "top2": {
      "contract_id": "NET_HTTPS_POST",
      "score": 0.08
    }
  }
}
```

**OpenClaw Applies Local Thresholds:**
- Min confidence: 0.55
- Dominance margin: 0.10
- Top1 score: 0.92 ✅ (exceeds 0.55)
- Dominance: 0.92 - 0.08 = 0.84 ✅ (exceeds 0.10)
- **Result: PROCEED** → Allow HTTP GET request

---

### Example 2: SHELL_EXEC (Run Test)

**OpenClaw operation:** Agent wants to run `npm test`

**Request to ClarityBurst:**
```json
{
  "stageId": "SHELL_EXEC",
  "packId": "openclawd.SHELL_EXEC",
  "packVersion": "1.0.0",
  "allowedContractIds": ["SHELL_RUN_COMMAND", "SHELL_RUN_SCRIPT"],
  "userText": "run npm test",
  "context": {
    "command": "npm test",
    "cwd": "/home/user/project"
  }
}
```

**ClarityBurst Response:**
```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "SHELL_RUN_COMMAND",
      "score": 0.88
    },
    "top2": {
      "contract_id": "SHELL_RUN_SCRIPT",
      "score": 0.12
    }
  }
}
```

**OpenClaw Applies Local Thresholds:**
- Min confidence: 0.60
- Dominance margin: 0.15
- Top1 score: 0.88 ✅ (exceeds 0.60)
- Dominance: 0.88 - 0.12 = 0.76 ✅ (exceeds 0.15)
- Check needs_confirmation in pack: true (shell is HIGH risk)
- **Result: ABSTAIN_CONFIRM** → Requires user confirmation before executing

---

### Example 3: TOOL_DISPATCH_GATE (Which Tool?)

**OpenClaw operation:** Agent needs to decide which tool to use

**Request to ClarityBurst:**
```json
{
  "stageId": "TOOL_DISPATCH_GATE",
  "packId": "openclawd.TOOL_DISPATCH_GATE",
  "packVersion": "1.0.0",
  "allowedContractIds": ["TOOL_WEB_SEARCH", "TOOL_CALCULATOR", "TOOL_EMAIL"],
  "userText": "search for latest AI news",
  "context": {
    "query": "latest AI news"
  }
}
```

**ClarityBurst Response:**
```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "TOOL_WEB_SEARCH",
      "score": 0.95
    },
    "top2": {
      "contract_id": "TOOL_CALCULATOR",
      "score": 0.02
    }
  }
}
```

**OpenClaw Applies Local Thresholds:**
- Min confidence: 0.50
- Dominance margin: 0.10
- Top1 score: 0.95 ✅
- Dominance: 0.95 - 0.02 = 0.93 ✅
- **Result: PROCEED** → Route to web_search tool

---

## 5. Decision Outcome Types

### PROCEED
Operation is approved and can execute immediately.

```typescript
{
  outcome: "PROCEED",
  contractId: "NET_HTTPS_GET"  // Which contract was selected
}
```

### ABSTAIN_CONFIRM
Operation requires user confirmation before executing (HIGH/CRITICAL risk).

```typescript
{
  outcome: "ABSTAIN_CONFIRM",
  reason: "CONFIRM_REQUIRED",
  contractId: "SHELL_RUN_COMMAND",
  instructions: "User must approve shell command execution"
}
```

### ABSTAIN_CLARIFY
Operation blocked (fail-closed). Router cannot confidently decide, or configuration incomplete.

```typescript
{
  outcome: "ABSTAIN_CLARIFY",
  reason: "LOW_DOMINANCE_OR_CONFIDENCE",  // or other reasons:
                                           // "PACK_POLICY_INCOMPLETE" | "router_outage"
                                           // "capability_denied" | "ROUTER_UNAVAILABLE"
  contractId: null,
  instructions: "Insufficient confidence to route operation"
}
```

---

## 6. Threshold Logic Details

After ClarityBurst Router returns top1/top2 matches, OpenClaw applies local thresholds:

```typescript
// Load thresholds from ontology pack
const minConfidenceT = pack.thresholds.min_confidence_T;        // e.g., 0.55
const dominanceMarginDelta = pack.thresholds.dominance_margin_Delta;  // e.g., 0.10

// Extract router scores
const top1Score = routeResult.data.top1.score;  // e.g., 0.92
const top2Score = routeResult.data.top2.score;  // e.g., 0.17

// Confidence check: top1 must be at or above threshold
const lowConfidence = top1Score < minConfidenceT;

// Dominance check: top1 must exceed top2 by margin
const lowDominance = (top1Score - top2Score) < dominanceMarginDelta;

// Fail-closed: block if either check fails
if (lowConfidence || lowDominance) {
  return { 
    outcome: "ABSTAIN_CLARIFY", 
    reason: "LOW_DOMINANCE_OR_CONFIDENCE" 
  };
}

// If thresholds pass, check if operation needs user confirmation
const contract = pack.contracts.find(c => c.contract_id === top1Score.contract_id);
if (contract.needs_confirmation && !userApproved) {
  return { 
    outcome: "ABSTAIN_CONFIRM", 
    reason: "CONFIRM_REQUIRED",
    contractId: contract.contract_id
  };
}

// All checks passed
return { outcome: "PROCEED", contractId: contract.contract_id };
```

---

## 7. Fail-Closed Guarantees

ClarityBurst enforces fail-closed semantics at every stage:

### Pack Validation Failures
- **Missing pack:** Operation blocked
- **Missing thresholds:** Operation blocked
- **Invalid contract definitions:** Operation blocked

### Threshold Failures
- **Low confidence:** ABSTAIN_CLARIFY (blocked)
- **Low dominance:** ABSTAIN_CLARIFY (blocked)

### Router Failures
- **Timeout:** ABSTAIN_CLARIFY for side-effectful operations
- **Connection refused:** ABSTAIN_CLARIFY for side-effectful operations
- **Invalid response:** ABSTAIN_CLARIFY

### Capability Failures
- **Empty allowlist:** ABSTAIN_CLARIFY (blocked)
- **Capability not enabled:** Operation blocked

---

## 8. Configuration for OpenClaw Deployment

### Environment Variables

```bash
# ClarityBurst Router service location
CLARITYBURST_ROUTER_URL=http://localhost:3001

# Request timeout (100-5000ms)
CLARITYBURST_ROUTER_TIMEOUT_MS=1200

# Enable/disable gating (true = enabled)
CLARITYBURST_ENABLED=true

# Log verbosity
CLARITYBURST_LOG_LEVEL=info
```

### Production Example

```bash
# Separate ClarityBurst router service running on internal host
export CLARITYBURST_ENABLED=true
export CLARITYBURST_ROUTER_URL=https://clarity-router.internal:8443
export CLARITYBURST_ROUTER_TIMEOUT_MS=2000
export CLARITYBURST_LOG_LEVEL=info
```

### Startup Validation

ClarityBurst configuration is validated when OpenClaw starts:
- If invalid, OpenClaw fails to start (fail-closed)
- Logs show which configuration is loaded
- Warns if router URL is non-HTTPS in production

---

## 9. Logging & Observability

### Key Events Logged

**Router Request Entry:**
```
CB_RT_SENTINEL_ROUTE_ENTER {
  stageId: "NETWORK_IO",
  packId: "openclawd.NETWORK_IO",
  routerUrl: "http://localhost:3001/api/route"
}
```

**Router Call Success:**
```
ROUTER_CALL_OK {
  latencyMs: 45,
  httpStatus: 200,
  routeOk: true,
  contractId: "NET_HTTPS_POST"
}
```

**Router Call Error:**
```
ROUTER_CALL_ERR {
  latencyMs: 1203,
  errorName: "AbortError",
  errorMessage: "Request timed out after 1200ms",
  contractId: "NET_HTTPS_POST"
}
```

### Audit Trail

All routing decisions are logged with:
- Timestamp
- Stage ID
- Selected contract
- Confidence score
- Dominance score
- Final outcome (PROCEED/ABSTAIN_CONFIRM/ABSTAIN_CLARIFY)

---

## 10. Testing ClarityBurst Integration

### Test Strategy

ClarityBurst integration includes comprehensive tests:

**Fail-Closed Tests:**
- Pack validation failures block operations
- Router unavailability blocks side-effectful ops
- Empty allowlist blocks routing

**Threshold Boundary Tests:**
- Confidence at exact threshold
- Dominance margin boundary
- Missing top2 handling

**Router Integration Tests:**
- Contract mismatch handling
- Duplicate contract ID validation
- Response parsing

**Confirmation Workflow Tests:**
- Confirmation token validation
- CRITICAL/HIGH contract handling

### Running Tests

```bash
# Full verification suite
npm run verify

# Individual smoke tests
npm run smoke:router
npm run smoke:http
npm run eval:router

# Adversarial injection tests
npm run smoke:adversarial-injection

# Pack isolation tests
npm run smoke:pack-isolation
```

---

## 11. Why ClarityBurst Matters for Enterprise OpenClaw

| Requirement | How ClarityBurst Addresses It |
|---|---|
| **Predictability** | Single deterministic routing decision per operation (not probabilistic) |
| **Safety** | Fail-closed by default (denies unless confident) |
| **Auditability** | Every routing decision logged with confidence/dominance scores |
| **Control** | 12 gating stages cover all side-effectful operations |
| **Flexibility** | Ontology packs allow per-stage customization |
| **Confirmation** | USER-REQUIRED contracts block until approved |
| **Offline Resilience** | Local threshold checks continue even if router temporarily unavailable |
| **No Wasted Calls** | Router decision made upfront, prevents wasted downstream API calls |

---

## Summary Table

| Aspect | Details |
|--------|---------|
| **Service Type** | Separate HTTP service (not embedded) |
| **Endpoint** | `POST {CLARITYBURST_ROUTER_URL}/api/route` |
| **Request Timeout** | Configurable 100-5000ms (default 1200ms) |
| **Decision Points** | 12 stages (SHELL_EXEC, NETWORK_IO, TOOL_DISPATCH, etc.) |
| **Response Format** | JSON with top1/top2 contract matches + scores |
| **Failure Mode** | Fail-closed (blocks operations on any error) |
| **Confirmation** | HIGH/CRITICAL contracts require user approval |
| **Audit Trail** | Full logging of all routing decisions |
| **Configuration** | Environment variables, validated at startup |
| **Testing** | 84+ tests covering normal/edge/adversarial cases |

---

## Next Steps for OpenClaw Operators

1. **Deploy ClarityBurst Router** as a separate service (Fly.io, Docker, etc.)
2. **Set CLARITYBURST_ROUTER_URL** in OpenClaw environment
3. **Load ontology packs** appropriate for your use case
4. **Monitor logs** for routing decisions and any failures
5. **Update thresholds** in packs if needed for your risk tolerance

---

**Last Updated:** March 8, 2026  
**Status:** Production-Ready Integration  
**ClarityBurst Version:** Integrated in OpenClaw Fork  
**Router Version:** 1.0.0+
