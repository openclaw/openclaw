# OpenClaw ClarityBurst Integration Report

## Executive Summary

ClarityBurst is a **decision-gating system** integrated into OpenClaw that controls operation execution across 12 capability stages. It routes decisions through a local router service and applies threshold-based logic to determine whether operations should `PROCEED`, require `ABSTAIN_CONFIRM` (user confirmation), or `ABSTAIN_CLARIFY` (fail-closed).

---

## 1. Integration Architecture Overview

### High-Level Flow

```
Operation Request
    ↓
ClarityBurst Gating (decision-override.ts)
    ├─ Load ontology pack (pack-registry.ts)
    ├─ Derive allowed contracts (allowed-contracts.ts)
    ├─ Assert non-empty allowlist (allowed-contracts.ts)
    ├─ Route through ClarityBurst API (router-client.ts)
    │   └─ POST /api/route to CLARITYBURST_ROUTER_URL
    └─ Apply local threshold logic
        └─ Return: PROCEED | ABSTAIN_CONFIRM | ABSTAIN_CLARIFY
    ↓
Operation Execution (or Blocking)
```

### 12 Gating Stages

ClarityBurst controls decisions across these stages:

1. **TOOL_DISPATCH_GATE** - Routing tool selections
2. **SHELL_EXEC** - Command/script execution
3. **FILE_SYSTEM_OPS** - File read/write/delete operations
4. **NETWORK_IO** - HTTP/network requests
5. **MEMORY_MODIFY** - Session state modifications
6. **SUBAGENT_SPAWN** - Sub-agent creation
7. **NODE_INVOKE** - Node.js code evaluation
8. **BROWSER_AUTOMATE** - Browser automation
9. **CRON_SCHEDULE** - Scheduled task creation
10. **MESSAGE_EMIT** - Message transmission
11. **MEDIA_GENERATE** - Media generation
12. **CANVAS_UI** - Canvas UI operations

---

## 2. Code Structure & Call Sites

### Primary Files

#### `src/clarityburst/router-client.ts` (The HTTP Bridge)

**Contains:** The actual HTTP client that calls the ClarityBurst router API

**Function:** `async routeClarityBurst(input: RouterInput): Promise<RouterResult>`

**Responsibilities:**

- Validates input (`allowedContractIds` array)
- Makes POST request to router service
- Parses response
- Logs metrics (latency, errors, success)
- Handles timeouts (default 1200ms, configurable 100-5000ms)

#### `src/clarityburst/decision-override.ts` (The Gating Logic)

**Contains:** 12 override functions, one per stage

**Stage Functions:**

- `applyToolDispatchGateOverrides()`
- `applyShellExecOverrides()`
- `applyFileSystemOverrides()`
- `applyNetworkOverrides()`
- `applyMemoryModifyOverrides()`
- `applySubagentSpawnOverrides()`
- `applyNodeInvokeOverrides()`
- `applyBrowserAutomateOverrides()`
- `applyCronScheduleOverrides()`
- `applyMessageEmitOverrides()`
- `applyMediaGenerateOverrides()`
- `applyCanvasUiOverrides()`

**Pattern (All Stage Functions):**

```typescript
export async function applyXxxOverrides(context: XxxContext): Promise<OverrideOutcome> {
  // 1. Load pack for stage
  const pack = loadPackOrAbstain(STAGE_ID);
  
  // 2. Derive allowed contracts from runtime capabilities
  const caps = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(STAGE_ID, pack, caps);
  
  // 3. Assert allowlist is non-empty (fail-closed)
  assertNonEmptyAllowedContracts(STAGE_ID, allowedContractIds);
  
  // 4. Route through ClarityBurst API
  const routeResult = await routeClarityBurst({
    stageId: STAGE_ID,
    packId: pack.pack_id,
    packVersion: pack.pack_version,
    allowedContractIds,
    userText: "",
    context: { /* stage-specific context */ }
  });
  
  // 5. Apply local override logic
  const result = applyXxxOverridesImpl(pack, routeResult, context);
  return result;
}
```

#### `src/clarityburst/config.ts` (Configuration)

**Contains:** Runtime configuration management

**Environment Variables:**

- `CLARITYBURST_ENABLED` (default: `true`)
- `CLARITYBURST_ROUTER_URL` (default: `http://localhost:3001`)
- `CLARITYBURST_ROUTER_TIMEOUT_MS` (default: `1200`, range: 100-5000)
- `CLARITYBURST_LOG_LEVEL` (default: `info`, options: debug|info|warn|error)

**Validation:**

- Router URL must be a valid URL
- Timeout must be 100-5000ms
- Fails fast at startup if config is invalid
- Warns if router URL is non-HTTPS in production

#### `src/clarityburst/pack-registry.ts` (Ontology Packs)

**Contains:** Pack loading and validation

**What's a Pack?**
An ontology pack is a JSON file defining the contracts for a stage:

- `pack_id`: Unique identifier
- `pack_version`: Semantic version
- `stage_id`: The stage this pack governs
- `thresholds`: Confidence/dominance thresholds
- `contracts`: Array of contract definitions
- `field_schema`: Field definitions

**Packs Location:** `ontology-packs/` directory (JSON files per stage)

#### `src/clarityburst/allowed-contracts.ts` (Capability Filtering)

**Contains:** Logic to derive which contracts are allowed at runtime

**RuntimeCapabilities:**

```typescript
interface RuntimeCapabilities {
  browserEnabled: boolean;
  shellEnabled: boolean;
  fsWriteEnabled: boolean;
  networkEnabled: boolean;
  explicitlyAllowCritical: boolean;
  sensitiveAccessEnabled: boolean;
}
```

**Filtering Rules:**

- Exclude CRITICAL + `deny_by_default: true` unless `explicitlyAllowCritical: true`
- Filter by `capability_requirements` (e.g., requires "browser", "shell")
- TOOL_DISPATCH_GATE has special filtering logic

---

## 3. API Contract

### Request Format (Router Input)

**Endpoint:** `POST {CLARITYBURST_ROUTER_URL}/api/route`

**Content-Type:** `application/json`

**Request Body:**

```typescript
interface RouterInput {
  stageId: string;                      // e.g., "NETWORK_IO"
  packId: string;                        // e.g., "openclawd.NETWORK_IO"
  packVersion: string;                   // e.g., "1.0.0"
  allowedContractIds: string[];          // e.g., ["NET_GET", "NET_POST"]
  userText: string;                      // Context text (usually empty)
  context?: Record<string, unknown>;     // Stage-specific context
}
```

**Request Validation (Pre-Router):**

- `allowedContractIds` must be an array
- All entries must be non-empty strings
- No duplicate contract IDs allowed
- Validated in `validateAllowedContractIds()` before making HTTP call

### Response Format (Router Result)

**Success Response:**

```typescript
interface RouterResultOk {
  ok: true;
  data: {
    top1: {
      contract_id: string;    // e.g., "NET_HTTPS_POST"
      score: number;          // 0.0-1.0 confidence
    };
    top2: {
      contract_id: string;    // e.g., "NET_HTTPS_GET"
      score: number;
    };
    router_version?: string;  // Optional version identifier
  };
}
```

**Error Response:**

```typescript
interface RouterResultError {
  ok: false;
  error: string;              // Error message
  status?: number;            // HTTP status code if available
}
```

### HTTP Error Handling

The router-client handles these error scenarios:

- **HTTP 4xx/5xx:** Returns `{ ok: false, error: "HTTP NNN: StatusText", status: NNN }`
- **Timeout (AbortError):** Returns `{ ok: false, error: "Request timed out after XXXms" }`
- **Network Error:** Returns `{ ok: false, error: error.message }`
- **JSON Parse Error:** Returns `{ ok: false, error: "Failed to parse JSON response" }`
- **Invalid Response Shape:** Returns `{ ok: false, error: "Invalid response shape: missing or malformed top1/top2" }`

---

## 4. Example Payloads

### Example 1: NETWORK_IO Stage - HTTP POST Request

**Request:**

```json
{
  "stageId": "NETWORK_IO",
  "packId": "openclawd.NETWORK_IO",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "NET_HTTPS_GET",
    "NET_HTTPS_POST",
    "NET_HTTPS_PATCH",
    "NET_HTTPS_DELETE"
  ],
  "userText": "",
  "context": {
    "operation": "POST",
    "url": "https://api.example.com/data"
  }
}
```

**Success Response (Confidence: 0.92, Dominance: 0.75):**

```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "NET_HTTPS_POST",
      "score": 0.92
    },
    "top2": {
      "contract_id": "NET_HTTPS_PATCH",
      "score": 0.17
    },
    "router_version": "1.2.3"
  }
}
```

**Error Response (Router Unavailable):**

```json
{
  "ok": false,
  "error": "Connection refused",
  "status": null
}
```

### Example 2: SHELL_EXEC Stage - Command Execution

**Request:**

```json
{
  "stageId": "SHELL_EXEC",
  "packId": "openclawd.SHELL_EXEC",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "SHELL_RUN_COMMAND",
    "SHELL_RUN_SCRIPT"
  ],
  "userText": "run npm test",
  "context": {
    "command": "npm test",
    "cwd": "/home/user/project"
  }
}
```

**Success Response:**

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
    },
    "router_version": "1.2.3"
  }
}
```

### Example 3: FILE_SYSTEM_OPS Stage - File Write

**Request:**

```json
{
  "stageId": "FILE_SYSTEM_OPS",
  "packId": "openclawd.FILE_SYSTEM_OPS",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "FS_READ_FILE",
    "FS_WRITE_FILE",
    "FS_CREATE_DIR"
  ],
  "userText": "",
  "context": {
    "operation": "write",
    "path": "/tmp/output.txt"
  }
}
```

**Success Response:**

```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "FS_WRITE_FILE",
      "score": 0.95
    },
    "top2": {
      "contract_id": "FS_CREATE_DIR",
      "score": 0.03
    }
  }
}
```

### Example 4: TOOL_DISPATCH_GATE Stage - Tool Selection

**Request:**

```json
{
  "stageId": "TOOL_DISPATCH_GATE",
  "packId": "openclawd.TOOL_DISPATCH_GATE",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "TOOL_WEB_SEARCH",
    "TOOL_CALCULATOR",
    "TOOL_EMAIL"
  ],
  "userText": "search for latest news",
  "context": {
    "toolName": "web_search"
  }
}
```

**Success Response:**

```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "TOOL_WEB_SEARCH",
      "score": 0.91
    },
    "top2": {
      "contract_id": "TOOL_CALCULATOR",
      "score": 0.07
    }
  }
}
```

### Example 5: MEMORY_MODIFY Stage - Session State Update

**Request:**

```json
{
  "stageId": "MEMORY_MODIFY",
  "packId": "openclawd.MEMORY_MODIFY",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "MEM_UPDATE_SESSION",
    "MEM_ADD_CONTEXT",
    "MEM_CLEAR_SESSION"
  ],
  "userText": "",
  "context": {
    "operation": "update",
    "key": "user_preferences"
  }
}
```

**Success Response:**

```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "MEM_UPDATE_SESSION",
      "score": 0.89
    },
    "top2": {
      "contract_id": "MEM_ADD_CONTEXT",
      "score": 0.11
    }
  }
}
```

### Example 6: SUBAGENT_SPAWN Stage - Sub-Agent Creation

**Request:**

```json
{
  "stageId": "SUBAGENT_SPAWN",
  "packId": "openclawd.SUBAGENT_SPAWN",
  "packVersion": "1.0.0",
  "allowedContractIds": [
    "SUBAGENT_CREATE",
    "SUBAGENT_DELEGATE"
  ],
  "userText": "",
  "context": {
    "agentType": "research_agent",
    "autonomyLevel": "high"
  }
}
```

**Success Response:**

```json
{
  "ok": true,
  "data": {
    "top1": {
      "contract_id": "SUBAGENT_CREATE",
      "score": 0.87
    },
    "top2": {
      "contract_id": "SUBAGENT_DELEGATE",
      "score": 0.13
    }
  }
}
```

---

## 5. Outcome Types

### PROCEED Outcome

Operation is approved, execution continues.

```typescript
interface ProceedOutcome {
  outcome: "PROCEED";
  contractId: string | null;  // Routed contract ID
}
```

### ABSTAIN_CONFIRM Outcome

User confirmation required (contract marked `needs_confirmation: true` or HIGH/CRITICAL risk).

```typescript
interface AbstainConfirmOutcome {
  outcome: "ABSTAIN_CONFIRM";
  reason: "CONFIRM_REQUIRED";
  contractId: string;
  instructions?: string;  // How to obtain confirmation
}
```

### ABSTAIN_CLARIFY Outcome

Operation blocked pending clarification (fail-closed). Reasons include:

- `LOW_DOMINANCE_OR_CONFIDENCE` - Router scores below thresholds
- `PACK_POLICY_INCOMPLETE` - Missing pack definitions
- `router_outage` - Router unavailable
- `capability_denied` - Runtime capabilities insufficient
- `ROUTER_UNAVAILABLE` - Side-effectful op with router down

```typescript
interface AbstainClarifyOutcome {
  outcome: "ABSTAIN_CLARIFY";
  reason: "LOW_DOMINANCE_OR_CONFIDENCE" | "PACK_POLICY_INCOMPLETE" | "router_outage" | "capability_denied" | "ROUTER_UNAVAILABLE";
  contractId: string | null;
  stageId?: string;
  instructions?: string;  // Remediation guidance
}
```

---

## 6. Threshold Logic (Example: NETWORK_IO)

After router returns top1/top2 matches, local thresholds are applied:

```typescript
const minConfidenceT = pack.thresholds.min_confidence_T;        // e.g., 0.55
const dominanceMarginDelta = pack.thresholds.dominance_margin_Delta;  // e.g., 0.10

const top1Score = routeResult.data.top1.score;  // e.g., 0.92
const top2Score = routeResult.data.top2.score;  // e.g., 0.17

// Check confidence: top1 must be at or above threshold
const lowConfidence = top1Score < minConfidenceT;

// Check dominance: top1 must exceed top2 by margin
const lowDominance = (top1Score - top2Score) < dominanceMarginDelta;

if (lowConfidence || lowDominance) {
  return { outcome: "ABSTAIN_CLARIFY", reason: "LOW_DOMINANCE_OR_CONFIDENCE" };
}

// If thresholds passed, check confirmation requirements
if (contract.needs_confirmation && !context.userConfirmed) {
  return { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId };
}

// Otherwise proceed
return { outcome: "PROCEED", contractId };
```

---

## 7. Fail-Closed Policy

ClarityBurst implements strict fail-closed semantics:

### Pack Validation Failures

- **Missing ontology pack:** Throws `PackPolicyIncompleteError`
- **Missing pack fields:** Blocked (no silent defaults)
- **Invalid contract definitions:** Blocked

### Threshold Failures

- **Low confidence:** ABSTAIN_CLARIFY (operation blocked)
- **Low dominance:** ABSTAIN_CLARIFY (operation blocked)
- **Missing thresholds:** ABSTAIN_CLARIFY (operation blocked)

### Router Failures

- **Timeout (>1200ms default):** ABSTAIN_CLARIFY for side-effectful ops (when `CLARITYBURST_ROUTER_REQUIRED=1`)
- **Connection refused:** ABSTAIN_CLARIFY for side-effectful ops
- **Invalid response:** ABSTAIN_CLARIFY

### Allowlist Failures

- **Empty allowlist:** Throws `ClarityBurstAbstainError` with ABSTAIN_CLARIFY (operation blocked)
- **Duplicate contract IDs:** Throws before routing (pre-flight validation)

---

## 8. Configuration & Startup

### Initialization

ClarityBurst config is initialized at module load time (`src/clarityburst/config.ts`):

```typescript
// Fails fast if config is invalid
const configManager = new ClarityBurstConfigManager();
try {
  configManager.initialize();
} catch (error) {
  console.error('[ClarityBurst] Failed to initialize configuration');
  process.exit(1);  // Exits immediately
}
```

### Example Startup Logs

```
[ClarityBurst Config] Configuration loaded:
  Enabled: true
  Router URL: http://localhost:3001
  Router Timeout: 1200ms
  Log Level: info
```

### Example Production Config

```bash
export CLARITYBURST_ENABLED=true
export CLARITYBURST_ROUTER_URL=https://clarity-router.internal:8443
export CLARITYBURST_ROUTER_TIMEOUT_MS=2000
export CLARITYBURST_LOG_LEVEL=info
```

---

## 9. Logging & Observability

### Router Client Logs

Key events logged to `clarityburst-router-client`:

**Entry:**

```
CB_RT_SENTINEL_ROUTE_ENTER {
  stageId: "NETWORK_IO",
  packId: "openclawd.NETWORK_IO",
  routerUrl: "http://localhost:3001/api/route"
}
```

**Success:**

```
ROUTER_CALL_OK {
  latencyMs: 45,
  httpStatus: 200,
  routeOk: true,
  contractId: "NET_HTTPS_POST"
}
```

**Error:**

```
ROUTER_CALL_ERR {
  latencyMs: 1203,
  errorName: "AbortError",
  errorMessage: "Request timed out after 1200ms",
  contractId: "NET_HTTPS_POST"
}
```

---

## 10. Testing Strategy

ClarityBurst includes comprehensive tripwire tests validating:

### Fail-Closed Policy

- `pack_incomplete.fail_closed.tripwire.test.ts` - Pack validation failures block operations
- `router_outage.fail_closed.tripwire.test.ts` - Router unavailability blocks side-effectful ops
- `empty_allowlist.abstain_clarify.tripwire.test.ts` - Empty allowlist blocks routing

### Threshold Boundaries

- `threshold_boundary.confidence.exact_match.tripwire.test.ts` - Confidence at exact threshold
- `threshold_boundary.dominance.exact_match.tripwire.test.ts` - Dominance margin boundary
- `threshold_boundary.missing_top2.fail_safe.tripwire.test.ts` - Missing top2 handling

### Router Integration

- `router_mismatch.fail_open_only.tripwire.test.ts` - Router contract mismatch handling
- `router.duplicate_ids.test.ts` - Duplicate contract ID validation
- `contract_lookup.not_found.fail_open_only.tripwire.test.ts` - Contract not found handling

### Confirmation Workflow

- `shell_exec.confirmation.exact_token.tripwire.test.ts` - Confirmation token validation

---

## Summary

| Aspect | Details |
|--------|---------|
| **Integration Type** | HTTP POST to router service |
| **Endpoint** | `POST {CLARITYBURST_ROUTER_URL}/api/route` |
| **Request Timeout** | 100-5000ms (default 1200ms) |
| **Response Format** | JSON with top1/top2 contract matches + scores |
| **Decision Points** | 12 gating stages (SHELL_EXEC, NETWORK_IO, FILE_SYSTEM_OPS, etc.) |
| **Failure Mode** | Fail-closed (blocks operations on uncertainty) |
| **Config Validation** | Fails fast at startup if invalid |
| **Pack Validation** | No silent defaults; missing fields block operations |
| **Threshold Logic** | Confidence + dominance checks per pack definition |
| **Confirmation Workflow** | HIGH/CRITICAL contracts require user confirmation |
