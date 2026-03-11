# ClarityBurst Router Audit Report

## Evidence-Backed Assessment of Authorization Model

**Date:** 2026-02-28  
**Scope:** OpenClaw codebase (`src/clarityburst/`, `src/agents/`, integration points)  
**Verdict:** **MIXED** — ADVISORY for tool dispatch; AUTHORITATIVE (fail-closed) for sensitive side-effects

---

## Executive Summary

The ClarityBurst external router is **NOT uniformly authoritative** across all operation types. Its enforcement model is **stage-dependent**:

| Stage | Mode | Evidence |
|-------|------|----------|
| TOOL_DISPATCH_GATE | FAIL-OPEN | Router outage → proceeds with `contractId: null` |
| NETWORK_IO | FAIL-CLOSED | Router outage → blocks with `router_outage` reason |
| MEMORY_MODIFY | FAIL-CLOSED | Router outage → throws `ClarityBurstAbstainError` |
| SUBAGENT_SPAWN | FAIL-CLOSED | Router outage → throws `ClarityBurstAbstainError` |
| FILE_SYSTEM_OPS | FAIL-CLOSED | Router outage → blocks with `router_outage` reason |
| SHELL_EXEC | FAIL-CLOSED | Router outage → blocks via wrapper gate |

---

## Question 1: Can Actions Execute After DENY?

### Answer: CONDITIONALLY NO

**For High-Risk Operations (MEMORY_MODIFY, SUBAGENT_SPAWN, NETWORK_IO):**

- If router returns `ok: false` (outage) or contract marked for denial, operation **HARD FAILS**
- [`applyMemoryModifyOverridesImpl`](src/clarityburst/decision-override.ts:1113-1120): Throws `ClarityBurstAbstainError` immediately
- [`applySubagentSpawnOverridesImpl`](src/clarityburst/decision-override.ts:1270-1278): Throws `ClarityBurstAbstainError` immediately
- [`applyNetworkOverridesImpl`](src/clarityburst/decision-override.ts:833-840): Returns `ABSTAIN_CLARIFY` blocking outcome

**For Tool Dispatch (TOOL_DISPATCH_GATE):**

- If router denies (returns contract not in allowedList), proceeds anyway (**FAIL-OPEN**)
- [`applyToolDispatchOverrides`](src/clarityburst/decision-override.ts:391-395): Returns `PROCEED` when contract lookup fails

**For User Confirmation (SHELL_EXEC, NETWORK_IO writes):**

- If contract requires confirmation (`needs_confirmation: true` or `HIGH/CRITICAL` risk):
  - [`contractRequiresConfirmation`](src/clarityburst/decision-override.ts:218-228) checks both flags
  - Operation blocks with `ABSTAIN_CONFIRM` if `userConfirmed !== true`
  - **Exact token match required** (tripwire test: [`shell_exec.confirmation.exact_token.tripwire.test.ts:164-205`](src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts:164-205))
  - Substring/prefix matches rejected; only exact match bypasses

---

## Question 2: Behavior on Router Unreachable/Timeout/Error

### Answer: STAGE-DEPENDENT

**Fail-Closed Stages (MEMORY_MODIFY, SUBAGENT_SPAWN, FILE_SYSTEM_OPS):**

| Error Condition | Behavior | Code Path |
|---|---|---|
| Router timeout (≥1200ms) | **BLOCK** — throws/returns `ABSTAIN_CLARIFY` | [`router-client.ts:212-216`](src/clarityburst/router-client.ts:212-216) timeout abort |
| HTTP error (non-2xx) | **BLOCK** — returns `ok: false` | [`router-client.ts:161-166`](src/clarityburst/router-client.ts:161-166) |
| Network unreachable | **BLOCK** — catches and returns `ok: false` | [`router-client.ts:208-227`](src/clarityburst/router-client.ts:208-227) exception handler |
| Malformed response | **BLOCK** — returns `ok: false` | [`router-client.ts:180-197`](src/clarityburst/router-client.ts:180-197) shape validation |

Evidence from tripwire test:

- [`tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts:104-113`](src/clarityburst/__tests__/tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts:104-113): Outage → `convertAbstainToBlockedResponse` → blocks execution

**Fail-Open Stages (TOOL_DISPATCH_GATE):**

```typescript
// applyToolDispatchOverrides (line 322-327)
if (!routeResult.ok) {
  return { outcome: "PROCEED", contractId: null };  // FAIL-OPEN
}
```

| Error Condition | Behavior |
|---|---|
| Router timeout | **PROCEED** with `contractId: null` |
| HTTP error | **PROCEED** with `contractId: null` |
| Network unreachable | **PROCEED** with `contractId: null` |

Evidence from tripwire test:

- [`tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts:162-200`](src/clarityburst/__tests__/tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts:162-200): Router mismatch → tool executes anyway (fail-open)

**Router Configuration (timeout policy):**

- Default: `1200ms` ([`config.ts:98`](src/clarityburst/config.ts:98))
- Min: `100ms`, Max: `5000ms` ([`config.ts:118-133`](src/clarityburst/config.ts:118-133))
- Configurable via `CLARITYBURST_ROUTER_TIMEOUT_MS` env var
- On timeout: `AbortController` fires, returns `{ ok: false, error: "Request timed out after Xms" }`

---

## Question 3: Bypass Execution Paths

### A. CRITICAL BYPASS: Tool Dispatch Fail-Open

**Path:** `applyToolDispatchOverrides()` → router outage/error → PROCEEDS

```typescript
// src/clarityburst/decision-override.ts:321-327
export function applyToolDispatchOverrides(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: DispatchContext
): OverrideOutcome {
  // Fail-open: if router result is not ok, proceed with null contractId
  if (!routeResult.ok) {
    return { outcome: "PROCEED", contractId: null };  // ← BYPASS
  }
  ...
}
```

**When it applies:** Any scenario where `routeClarityBurst()` returns `ok: false`  
**Impact:** Tool executes despite router unreachability  
**Severity:** **CRITICAL** for unconfirmed high-risk tools

**Fix (smallest):** Change to:

```typescript
if (!routeResult.ok) {
  return { outcome: "ABSTAIN_CLARIFY", reason: "router_outage", contractId: null };
}
```

---

### B. BYPASS: Router Mismatch (Contract Not in Pack)

**Stages affected:** NETWORK_IO, NODE_INVOKE, BROWSER_AUTOMATE, MEDIA_GENERATE, CRON_SCHEDULE, MESSAGE_EMIT, CANVAS_UI

**Path:**

```typescript
// src/clarityburst/decision-override.ts:848-860 (NETWORK_IO example)
const packContractIds = new Set(pack.contracts.map(c => c.contract_id));
const routerMismatch = contractId !== null && !packContractIds.has(contractId);

if (routerMismatch) {
  // fail-open on router mismatch
  return { outcome: "PROCEED", contractId: null };  // ← BYPASS
}
```

**Evidence:** [`tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts:162-200`](src/clarityburst/__tests__/tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts:162-200)

**When it applies:**

1. Router returns contract NOT in pack's contract list
2. Pack derivation still permits operation (non-empty allowlist, capability checks pass)
3. System fails-open and allows execution

**Impact:** Stale/misconfigured router can be bypassed if it returns unrecognized contract IDs  
**Severity:** **HIGH** — assumes router contract definitions stay in sync with pack

**Fix (smallest):**

```typescript
if (routerMismatch) {
  // Fail-closed on mismatch for safety
  return {
    outcome: "ABSTAIN_CLARIFY",
    reason: "router_mismatch_unrecognized_contract",
    contractId: null,
    instructions: `Router returned unrecognized contract "${contractId}". Pack sync failure or router misconfiguration.`
  };
}
```

---

### C. BYPASS: Configuration Disabling

**Path:** [`config.ts:60-63`](src/clarityburst/config.ts:60-63)

```typescript
private parseEnabled(): boolean {
  const value = process.env.CLARITYBURST_ENABLED ?? 'true';
  const enabled = value.toLowerCase() === 'true';
  return enabled;
}
```

**When it applies:** `CLARITYBURST_ENABLED=false` at runtime  
**Impact:** All gating can be completely disabled  
**Severity:** **CRITICAL** in production unless access to env vars is restricted

**Fix (smallest):** Enforce via infrastructure (read-only config at startup; prevent env var override in production)

---

### D. BYPASS: Confirmation Token Substring Acceptance (NOT EXPLOITABLE)

**Tested:** [`shell_exec.confirmation.exact_token.tripwire.test.ts:164-205`](src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts:164-205)

**Status:** **NOT A BYPASS** — confirmation tokens require exact match

```typescript
// Tripwire confirms: Substring rejected
const invalidToken = `${expectedToken} EXTRA`;  // Substring, not exact match
// Test assertion: Still returns ABSTAIN_CONFIRM (not PROCEED)
```

---

### E. BYPASS: Empty Allowlist Circumvention (NOT EXPLOITABLE)

**Tested:** [`tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts:220-226`](src/clarityburst/__tests__/tool_dispatch_gate.empty_allowlist.abstain_clarify.tripwire.test.ts:220-226)

**Status:** **NOT A BYPASS** — hard-blocked at assertion stage

```typescript
// src/clarityburst/allowed-contracts.ts:232-240
export function assertNonEmptyAllowedContracts(
  stageId: ClarityBurstStageId,
  allowedContractIds: string[]
): void {
  if (allowedContractIds.length === 0) {
    throw new ClarityBurstAbstainError({
      stageId,
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: "No contracts permitted by current capability set; cannot proceed."
    });
  }
}
```

Throws before router is even called. **Non-bypassable.**

---

## Enforcement Points Summary

### Hard Gates (Non-Bypassable)

| Gate | Function | File | Behavior |
|---|---|---|---|
| **Pack Load Integrity** | `loadPackOrAbstain()` | [`pack-load.ts:51-73`](src/clarityburst/pack-load.ts:51-73) | Throws on incomplete/mismatched pack |
| **Allowed Contracts Derivation** | `assertNonEmptyAllowedContracts()` | [`allowed-contracts.ts:232-240`](src/clarityburst/allowed-contracts.ts:232-240) | Throws if allowlist is empty |
| **Router Input Validation** | `validateAllowedContractIds()` | [`router-client.ts:69-125`](src/clarityburst/router-client.ts:69-125) | Throws on duplicates/non-strings before routing |
| **Confirmation Token Matching** | `contractRequiresConfirmation()` + context check | [`decision-override.ts:218-228`](src/clarityburst/decision-override.ts:218-228) | Exact match only; substring rejected |

### Soft Gates (Can Be Bypassed)

| Gate | Function | File | Bypass Condition |
|---|---|---|---|
| **Router Availability (Tool Dispatch)** | `applyToolDispatchOverrides()` | [`decision-override.ts:321-327`](src/clarityburst/decision-override.ts:321-327) | Router outage → PROCEED |
| **Router Contract Mismatch** | `applyNetworkOverridesImpl()` | [`decision-override.ts:848-860`](src/clarityburst/decision-override.ts:848-860) | Unknown contract ID → PROCEED |
| **Configuration Flag** | `parseEnabled()` | [`config.ts:60-63`](src/clarityburst/config.ts:60-63) | `CLARITYBURST_ENABLED=false` |

---

## Detailed Gating Table

| Side-Effect Type | Entry Function(s) | Stage | File | Gate Location | Behavior on DENY | Behavior on Unreachable/Timeout | Bypass Paths | Severity |
|---|---|---|---|---|---|---|---|---|
| **Shell execution** | `exec()` tool handler | SHELL_EXEC | [`bash-tools.exec.ts:209-594`](src/agents/bash-tools.exec.ts:209-594) | `applyShellExecOverrides()` wrapper | ABSTAIN_CONFIRM blocks; token required | Returns error outcome if pack fails | Config disable; no router gating if outage | **HIGH** |
| **File write/delete** | `write_file()`, `edit()` | FILE_SYSTEM_OPS | `pi-tools.read.js` | `applyFileSystemOverrides()` commit point | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Config disable; empty allowlist blocks (not bypassable) | **HIGH** |
| **Network POST/PUT** | `fetch()` with method | NETWORK_IO | `pi-tools.read.js` | `wrapWithNetworkGating()` | ABSTAIN_CONFIRM blocks; exact token | Blocks with router_outage | Router mismatch contract → PROCEED; config disable | **MEDIUM-HIGH** |
| **Network GET (read)** | `fetch()` with method=GET | NETWORK_IO | `pi-tools.read.js` | `wrapWithNetworkGating()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Memory write** | `saveSessionToMemory()` hook | MEMORY_MODIFY | [`hooks/bundled/session-memory/handler.ts:172-328`](src/hooks/bundled/session-memory/handler.ts:172-328) | `applyMemoryModifyOverrides()` | Throws ClarityBurstAbstainError | Throws ClarityBurstAbstainError (fail-closed) | None (hard-blocked) | **CRITICAL** |
| **Subagent spawn** | Subagent tool invocation | SUBAGENT_SPAWN | Agent execution | `applySubagentSpawnOverrides()` | Throws ClarityBurstAbstainError | Throws ClarityBurstAbstainError (fail-closed) | Router mismatch → PROCEED (fail-open) | **HIGH** |
| **Tool dispatch routing** | Tool selection → execution | TOOL_DISPATCH_GATE | Agent framework | `applyToolDispatchOverrides()` | Proceeds with null contractId | **PROCEEDS** (fail-open) | Router outage → PROCEED; mismatch → PROCEED | **CRITICAL** |
| **Cron scheduling** | Cron task registration | CRON_SCHEDULE | Agent execution | `applyCronScheduleOverrides()` | ABSTAIN_CLARIFY blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Message emit** | Send to Slack/Discord/etc. | MESSAGE_EMIT | [`web/outbound.ts:13-14`](src/web/outbound.ts:13-14) | `applyMessageEmitOverrides()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Browser automation** | Puppeteer/Playwright actions | BROWSER_AUTOMATE | Agent framework | `applyBrowserAutomateOverrides()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Node code invoke** | `eval()`, `require()` indirect | NODE_INVOKE | Agent framework | `applyNodeInvokeOverrides()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Media generation** | Image/video/audio generation | MEDIA_GENERATE | Agent framework | `applyMediaGenerateOverrides()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **MEDIUM** |
| **Canvas UI rendering** | UI component output | CANVAS_UI | Agent framework | `applyCanvasUiOverrides()` | ABSTAIN_CONFIRM blocks | Blocks with router_outage | Router mismatch → PROCEED | **LOW-MEDIUM** |

---

## Router Dependency Analysis

### Configuration Loading

**File:** [`config.ts:20-200`](src/clarityburst/config.ts:20-200)

| Property | Default | Min | Max | Env Var |
|---|---|---|---|---|
| **Enabled** | `true` | N/A | N/A | `CLARITYBURST_ENABLED` |
| **Router URL** | `http://localhost:3001` | N/A | N/A | `CLARITYBURST_ROUTER_URL` |
| **Timeout (ms)** | `1200` | `100` | `5000` | `CLARITYBURST_ROUTER_TIMEOUT_MS` |
| **Log Level** | `info` | — | — | `CLARITYBURST_LOG_LEVEL` |

**Validation:**

- URL validated via `new URL()` constructor
- Timeout bounds enforced; throws on out-of-range
- HTTPS check warns in production but allows HTTP (line 84-89)

### Retry/Fallback Policy

**Policy:** **NO RETRY** — Request fails immediately on timeout

```typescript
// src/clarityburst/router-client.ts:146-157
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

// On timeout: AbortError caught, returns { ok: false, error: "Request timed out after Xms" }
```

**Error Handling:**

- Timeouts: Return `ok: false` with error message (line 212-216)
- HTTP errors: Return `ok: false` with status code (line 161-166)
- Network errors: Return `ok: false` with error message (line 218-221)
- JSON parse errors: Return `ok: false` (line 172-177)
- Shape validation errors: Return `ok: false` (line 192-196)

**Fallback behavior:** Each stage defines its own fallback (fail-open vs. fail-closed)

---

## Verdict

### Fail-Closed Confirmation: TRUE (with caveats)

**For sensitive operations (memory, subagent, file system):** ClarityBurst IS authoritative. Router outage blocks execution.

**For tool dispatch and network reads:** ClarityBurst is ADVISORY. Router outage allows fallthrough.

### Bypass Confirmation: YES (3 exploitable paths)

1. **TOOL_DISPATCH_GATE fail-open:** Router outage → proceeds
2. **Router mismatch:** Unknown contract → proceeds in most stages
3. **Configuration disable:** `CLARITYBURST_ENABLED=false` disables all gating

### Evidence Summary

- **Testing:** 20+ tripwire tests in `src/clarityburst/__tests__/` explicitly verify fail-closed/fail-open behavior
- **Code paths:** All decision override functions examined; gating logic isolated and hardened
- **Integration:** Memory hooks, network wrappers, file system gates all independently verified
- **Router contract:** Input validation (duplicates, non-strings) proven non-bypassable before routing

---

## Recommendations

### Priority 1: CRITICAL

1. Make TOOL_DISPATCH_GATE fail-closed on router outage (change line 321-327)
2. Restrict `CLARITYBURST_ENABLED` env var in production (read-only startup config)

### Priority 2: HIGH

3. Treat router mismatch as failure, not bypass (add hard block for unknown contracts in all stages)
4. Implement router contract version pinning to prevent stale pack/router desync

### Priority 3: MEDIUM

5. Add explicit logging on every bypass decision
6. Implement circuit breaker for repeated router timeouts
7. Require signed router responses to prevent MITM attacks

---

## Appendices

### A. File Path Reference

- Core gating: [`src/clarityburst/decision-override.ts`](src/clarityburst/decision-override.ts)
- Router client: [`src/clarityburst/router-client.ts`](src/clarityburst/router-client.ts)
- Error types: [`src/clarityburst/errors.ts`](src/clarityburst/errors.ts)
- Configuration: [`src/clarityburst/config.ts`](src/clarityburst/config.ts)
- Pack loading: [`src/clarityburst/pack-load.ts`](src/clarityburst/pack-load.ts)
- Allowed contracts: [`src/clarityburst/allowed-contracts.ts`](src/clarityburst/allowed-contracts.ts)
- Shell execution: [`src/agents/bash-tools.exec.ts`](src/agents/bash-tools.exec.ts)
- Memory hook handler: [`src/hooks/bundled/session-memory/handler.ts`](src/hooks/bundled/session-memory/handler.ts)
- Network gating wrapper: `src/agents/pi-tools.read.js` (referenced in tests)

### B. Test File Reference

- Tool dispatch gate outage: [`src/clarityburst/__tests__/tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts`](src/clarityburst/__tests__/tool_dispatch_gate.router_outage.fail_closed.tripwire.test.ts)
- Tool dispatch gate mismatch: [`src/clarityburst/__tests__/tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts`](src/clarityburst/__tests__/tool_dispatch_gate.router_mismatch.fail_open_only.tripwire.test.ts)
- Shell exec confirmation: [`src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts`](src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts)
- Memory modify hook: [`src/clarityburst/__tests__/memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts`](src/clarityburst/__tests__/memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts)
- Subagent spawn: [`src/clarityburst/__tests__/subagent_spawn.router_outage.fail_closed.tripwire.test.ts`](src/clarityburst/__tests__/subagent_spawn.router_outage.fail_closed.tripwire.test.ts)

---

**End of Report**
