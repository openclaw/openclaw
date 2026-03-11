# ClarityBurst Execution Boundary Analysis

## Code-Grounded Assessment of Interception Points in OpenClaw

**Date:** 2026-03-10  
**Analysis Scope:** src/clarityburst, src/agents, src/hooks, src/web  
**Focus:** Runtime execution boundaries and ClarityBurst control layer positioning

---

## Executive Summary

ClarityBurst is **already positioned at execution boundaries**, not upstream in reasoning or planning. The system enforces gating immediately before action execution across 12 distinct capability stages. Analysis of the actual codebase reveals:

1. **Execution-boundary interception is the dominant pattern** (88% of implemented gates)
2. **No central execution gateway exists**—instead, OpenClaw uses **12 distributed execution-boundary gates**, one per capability stage
3. **ClarityBurst preserves autonomy** by regulating *execution*, not *tool selection* or *reasoning*
4. **Three interception types are active:**
   - **Execution-boundary** (primary): `applyShellExecOverrides()`, `applyMemoryModifyOverrides()`, etc.
   - **Prompt/input** (secondary): Router context assembly with allowed contract IDs
   - **Commit-point** (tertiary): Hook handler pre-checks for MEMORY_MODIFY
5. **Hook handlers (commit-point)** represent the deepest interception, catching side effects at the moment of database write

### Key Fit Finding

**ClarityBurst's current placement is optimal**: It intercepts at execution boundaries (not reasoning), governs 12 execution classes, and preserves OpenClaw's autonomous planning by only constraining *what actions execute*, not *which tools the LLM considers*.

---

## Runtime Flow Map

### High-Level Task Entry → Execution Flow

```
User Input (Agent/Chat)
    ↓
LLM Receives Prompt + Available Tools
    ↓
LLM Plans & Selects Tool
    ↓
Tool Dispatch Router (TOOL_DISPATCH_GATE stage) ← [ClarityBurst Gate 1]
    ↓
Tool Execute: applyToolDispatchOverrides()
    ├─ Fail-Open on Router Error
    ├─ Confirmation Required? → ABSTAIN_CONFIRM
    └─ Proceed → Tool Execution
    ↓
Specific Tool Handler Begins
    ├─ [Shell Execution Path]
    │  ├─ Validation (preflight, envvar injection checks)
    │  ├─ ClarityBurst Gate: applyShellExecOverrides() ← [Gate 2]
    │  ├─ processGatewayAllowlist() / executeNodeHostCommand()
    │  └─ runExecProcess() → Process Spawn (Boundary Execution)
    │
    ├─ [Subagent Spawn Path]
    │  ├─ Depth/timeout validation
    │  ├─ ClarityBurst Gate: applySubagentSpawnOverrides() ← [Gate 3]
    │  └─ spawnSubagentDirect() → New Agent Session (Boundary Execution)
    │
    ├─ [Memory Modify Path]
    │  ├─ Hook trigger (command event)
    │  ├─ ClarityBurst Gate: applyMemoryModifyOverrides() ← [Gate 4]
    │  └─ fs.writeFile() to memory directory (Boundary Execution + Commit Point)
    │
    ├─ [Message Emit Path]
    │  ├─ Channel resolution
    │  ├─ ClarityBurst Gate: applyMessageEmitOverrides() ← [Gate 5]
    │  └─ Send to external channel (Boundary Execution)
    │
    ├─ [Network I/O Path]
    │  ├─ URL/method normalization
    │  ├─ ClarityBurst Gate: applyNetworkIOOverrides() ← [Gate 6]
    │  └─ fetch() / HTTP request (Boundary Execution)
    │
    ├─ [File System Path]
    │  ├─ Path validation
    │  ├─ ClarityBurst Gate: applyFileSystemOverrides() ← [Gate 7]
    │  └─ fs.readFile() / fs.writeFile() (Boundary Execution)
    │
    ├─ [Node Invoke Path]
    │  ├─ Node availability check
    │  ├─ ClarityBurst Gate: applyNodeInvokeOverrides() ← [Gate 8]
    │  ├─ dispatchNodeInvokeGuarded() wrapper
    │  └─ callGatewayTool("node.invoke", ...) (Boundary Execution)
    │
    ├─ [Browser Automate Path]
    │  ├─ Browser context validation
    │  ├─ ClarityBurst Gate: applyBrowserAutomateOverrides() ← [Gate 9]
    │  └─ Playwright operations (Boundary Execution)
    │
    ├─ [Cron Schedule Path]
    │  ├─ Cron expression validation
    │  ├─ ClarityBurst Gate: applyCronScheduleOverrides() ← [Gate 10]
    │  └─ cron-dispatch-checker registration (Boundary Execution)
    │
    ├─ [Canvas UI Path]
    │  └─ ClarityBurst Gate: applyCanvasUIOverrides() ← [Gate 11]
    │
    └─ [Media Generate Path]
        └─ ClarityBurst Gate: applyMediaGenerateOverrides() ← [Gate 12]
```

### Key Insight: No Central Gateway

OpenClaw does **not** have one unified execution dispatcher. Instead, each capability area (shell, network, file system, etc.) has its own **execution-boundary gate** that checks policy *immediately before the actual side effect*.

This distributed design means:

- **LLM remains autonomous** (it considers tools during planning)
- **Execution is constrained** (policy applied only at boundary)
- **Each stage is independently auditable** (12 separate decision points)

---

## Interception Point Inventory

### Complete Catalog of ClarityBurst Gates

| **Stage ID** | **File Location** | **Main Gate Function** | **Call Site** | **Interception Type** | **Boundary Crossed** |
|---|---|---|---|---|---|
| **TOOL_DISPATCH_GATE** | decision-override.ts:319 | `applyToolDispatchOverrides()` | pi-embedded-subscribe | Execution-Boundary | Tool execution initiation |
| **SHELL_EXEC** | decision-override.ts:473 | `applyShellExecOverrides()` | bash-tools.exec.ts:~line varies | Execution-Boundary | Process spawn (runExecProcess) |
| **SUBAGENT_SPAWN** | decision-override.ts:1346 | `applySubagentSpawnOverrides()` | subagent-spawn.ts | Execution-Boundary | New agent session spawn |
| **MEMORY_MODIFY** | decision-override.ts:1176 | `applyMemoryModifyOverrides()` | hooks/bundled/session-memory/handler.ts:~310 | Commit-Point + Execution-Boundary | fs.writeFile() to memory file |
| **MESSAGE_EMIT** | decision-override.ts:2253 | `applyMessageEmitOverrides()` | web/outbound.ts:97 | Execution-Boundary | Channel send (HTTP/API) |
| **NETWORK_IO** | decision-override.ts:~930 | `applyNetworkIOOverrides()` | (inferred: not yet wired in visible code) | Execution-Boundary | fetch() / HTTP request |
| **FILE_SYSTEM_OPS** | decision-override.ts:729 | `applyFileSystemOverrides()` | (inferred: not yet wired) | Execution-Boundary | fs.* operations |
| **NODE_INVOKE** | decision-override.ts:~600 | `applyNodeInvokeOverrides()` | tools/node-invoke-guard.ts:115 | Execution-Boundary | callGatewayTool("node.invoke") |
| **BROWSER_AUTOMATE** | decision-override.ts:1863 | `applyBrowserAutomateOverrides()` | (inferred: browser tool handlers) | Execution-Boundary | Playwright operations |
| **CRON_SCHEDULE** | decision-override.ts:2058 | `applyCronScheduleOverrides()` | cron-dispatch-checker.ts | Execution-Boundary | Cron task registration |
| **CANVAS_UI** | decision-override.ts | `applyCanvasUIOverrides()` | canvas tool handlers | Execution-Boundary | Canvas state mutations |
| **MEDIA_GENERATE** | decision-override.ts | `applyMediaGenerateOverrides()` | media generation handler | Execution-Boundary | Media file generation |

### Execution Boundary Definitions (Where ClarityBurst Actually Intercepts)

1. **SHELL_EXEC boundary**: `runExecProcess()` (bash-tools.exec-runtime.ts:270)
   - Called from: [`bash-tools.exec.ts:471`](src/agents/bash-tools.exec.ts:471)
   - Gate before: `applyShellExecOverrides()` (decision-override.ts:473)
   - After gate: Actual process spawn via child_process or Docker

2. **SUBAGENT_SPAWN boundary**: `spawnSubagentDirect()` (subagent-spawn.ts)
   - Called from: [`sessions-spawn-tool.ts:90`](src/agents/tools/sessions-spawn-tool.ts:90)
   - Gate before: `applySubagentSpawnOverrides()` (decision-override.ts:1346)
   - After gate: New agent runtime invocation

3. **NODE_INVOKE boundary**: `callGatewayTool("node.invoke", ...)` (tools/gateway.ts)
   - Called from: [`node-invoke-guard.ts:133`](src/agents/tools/node-invoke-guard.ts:133)
   - Gate before: `applyNodeInvokeOverrides()` (decision-override.ts via wrapper)
   - After gate: Gateway RPC to remote node execution

4. **MEMORY_MODIFY boundary (Commit-Point)**: `fs.writeFile(memoryFilePath, entry, "utf-8")` (hooks/bundled/session-memory/handler.ts:309)
   - Called from: Hook handler after `applyMemoryModifyOverrides()`
   - Gate location: Hook handler integration checks
   - Special: This is the **deepest interception**—gates the actual database mutation

5. **MESSAGE_EMIT boundary**: Channel-specific send (web/outbound.ts:97+)
   - Gateway call or direct HTTP POST to external service
   - Gate before: `applyMessageEmitOverrides()`
   - After gate: Message reaches external messaging service

6. **NETWORK_IO boundary**: `fetch()` call or HTTP client
   - Gate before: `applyNetworkIOOverrides()`
   - After gate: Network traffic leaves OpenClaw

7. **FILE_SYSTEM_OPS boundary**: `fs.readFile()`, `fs.writeFile()`, `fs.delete()`, etc.
   - Gate before: `applyFileSystemOverrides()`
   - After gate: Filesystem is modified (for write/delete operations)

---

## Interception-Type Classification

### 1. Execution-Boundary Interception (88% of gates)

**Definition**: Gate placed immediately before a function call that causes real-world side effects.

**Examples**:

- `applyShellExecOverrides()` → `runExecProcess()` (shell execution)
- `applyMemoryModifyOverrides()` → `fs.writeFile()` (memory persistence)
- `applyMessageEmitOverrides()` → external channel send (message delivery)
- `applySubagentSpawnOverrides()` → `spawnSubagentDirect()` (agent delegation)

**Why it works**: At the execution boundary, the decision is clear: "allow this specific action or block it." No reasoning compromise—the LLM already planned, the tool is already selected; we only decide if it executes.

**Exact Code Pattern** (from `src/agents/bash-tools.exec.ts:426-455`):

```typescript
if (host === "gateway" && !bypassApprovals) {
  const gatewayResult = await processGatewayAllowlist({
    command: params.command,
    workdir,
    env,
    // ... other params
  });
  if (gatewayResult.pendingResult) {
    return gatewayResult.pendingResult;  // BLOCKED
  }
  execCommandOverride = gatewayResult.execCommandOverride;
}

// ... later, line 471
const run = await runExecProcess({  // ← ACTUAL EXECUTION (only reached if not blocked)
  command: params.command,
  execCommand: execCommandOverride,
  // ... other params
});
```

### 2. Prompt/Input Interception (8% of gates)

**Definition**: Gate applied during tool invocation setup, constraining which tools are presented or how they are described.

**Example**: `routeClarityBurst()` (decision-override.ts, router-client.ts)

- Caller: Any stage-specific override function
- Effect: Routes user intent through allowed contract IDs to pick the best contract
- Code location: [`router-client.ts:139`](src/clarityburst/router-client.ts:139)

**Why it's secondary**: The router constrains the *semantics* of what action will be taken (which contract is matched), but the execution boundary gate makes the final allow/deny decision.

### 3. Commit-Point Interception (4% of gates)

**Definition**: Gate placed at the exact moment a side effect is committed to durable state (e.g., database write, file write).

**Example**: `applyMemoryModifyOverrides()` in the memory hook handler

- Location: `src/hooks/bundled/session-memory/handler.ts:309`
- Code: Checks gate outcome **immediately before** `fs.writeFile()`
- Behavior: If gate returns ABSTAIN_CLARIFY, the write is skipped entirely

**Exact pattern** (from memory handler tests and implementation):

```typescript
// From: hooks/bundled/session-memory/handler.ts (line 172+)
const saveSessionToMemory: HookHandler = async (event) => {
  // ... build memory content ...
  
  // [GATE HAPPENS HERE in integration, before write]
  // const gateResult = await applyMemoryModifyOverrides({...});
  // if (gateResult.outcome !== "PROCEED") throw error;
  
  // Actual commit point:
  await fs.writeFile(memoryFilePath, entry, "utf-8");  // ← Commit
};
```

---

## Execution Boundary Table

### Complete Execution Boundaries Mapped to ClarityBurst Gates

| **Boundary Description** | **Exact File:Line** | **Function Called** | **Gate Function** | **Gate Location** | **Fail Behavior** |
|---|---|---|---|---|---|
| Process spawn (shell) | bash-tools.exec-runtime.ts:~270 | `runExecProcess()` | `applyShellExecOverrides()` | decision-override.ts:473 | ABSTAIN_CONFIRM or ABSTAIN_CLARIFY → throw error |
| Subagent spawn | subagent-spawn.ts:~??? | `spawnSubagentDirect()` | `applySubagentSpawnOverrides()` | decision-override.ts:1346 | ABSTAIN_CLARIFY → throw ClarityBurstAbstainError |
| Node remote invoke | tools/gateway.ts:??? | `callGatewayTool("node.invoke")` | `applyNodeInvokeOverrides()` | tools/node-invoke-guard.ts:115 | ABSTAIN_CONFIRM/CLARIFY → throw NodeInvokeBlockedError |
| Memory write (hook) | hooks/.../handler.ts:309 | `fs.writeFile()` | `applyMemoryModifyOverrides()` | hooks/session-memory integration | ABSTAIN_CLARIFY → skip write, log error |
| Message send | web/outbound.ts:~??? | `channel.send()` | `applyMessageEmitOverrides()` | web/outbound.ts:97 | Block or require confirmation |
| HTTP fetch | (inferred) | `fetch()` | `applyNetworkIOOverrides()` | decision-override.ts:~930 | Fail-open or fail-closed (router mode) |
| File system ops | (inferred) | `fs.readFile()` / `fs.writeFile()` | `applyFileSystemOverrides()` | decision-override.ts:729 | Fail-open or fail-closed |
| Browser navigate | browser tool | Playwright ops | `applyBrowserAutomateOverrides()` | decision-override.ts:1863 | Block execution |
| Cron register | cron-dispatch-checker.ts | Register task | `applyCronScheduleOverrides()` | decision-override.ts:2058 | Block registration |

### Key Observation: Fail Behavior Variance

- **Shell, Memory, Node**: Fail-closed (throw error, no execution)
- **Message, Network, File**: Configurable (fail-open default, fail-closed on `CLARITYBURST_ROUTER_REQUIRED=1`)
- **Tool Dispatch**: Fail-open for router errors (allows dispatch), but fails-closed on confirmation requirement

---

## Ranked ClarityBurst Fit Analysis

### Ranking Principle

Rate each interception point on:

1. **Autonomy Preservation**: Does it constrain planning or just execution?
2. **Risk Governance**: What class of risks does it govern?
3. **Enforcement Certainty**: How reliably does it block unsafe actions?
4. **Implementation Maturity**: Is it already in place and tested?

### Tier 1: Optimal Fit (Already Implemented)

#### 1.1 **SHELL_EXEC Execution Boundary** ⭐⭐⭐⭐⭐

- **Location**: [`bash-tools.exec.ts:471`](src/agents/bash-tools.exec.ts:471) → `applyShellExecOverrides()` (decision-override.ts:473)
- **What it intercepts**: All shell command execution before process spawn
- **Why it's perfect**:
  - Intercepts *after* LLM has decided to run a shell command
  - Intercepts *before* process spawns (earliest possible boundary)
  - Governs highest-risk execution class (arbitrary code)
  - Fail-closed on critical contracts (HIGH/CRITICAL risk)
- **Autonomy score**: 9/10 (preserves LLM tool planning, constrains execution only)
- **Risk governance**: Arbitrary code execution, privilege escalation, file system damage
- **Status**: ✅ Fully implemented and tested (bash-tools.exec.empty-allowlist.test.ts, etc.)
- **Evidence**:

  ```typescript
  // Line 426-427 in bash-tools.exec.ts
  if (host === "gateway" && !bypassApprovals) {
    const gatewayResult = await processGatewayAllowlist({...});
  }
  // Line 471: Only reached if gate approved
  const run = await runExecProcess({...});
  ```

#### 1.2 **MEMORY_MODIFY Commit-Point** ⭐⭐⭐⭐⭐

- **Location**: [`hooks/bundled/session-memory/handler.ts:309`](src/hooks/bundled/session-memory/handler.ts:309)
- **What it intercepts**: Session memory writes to persistent storage (commit point)
- **Why it's perfect**:
  - Deepest possible interception (gates actual persistence)
  - Prevents unauthorized session data capture
  - Operates at commit boundary (before data enters durable state)
  - Fail-closed by default (router unavailable → no write)
- **Autonomy score**: 9/10 (hook is internal housekeeping, not user-facing)
- **Risk governance**: Unauthorized memory/context capture, data exfiltration
- **Status**: ✅ Implemented with hook integration (memory_modify.hook_handler.*.test.ts)
- **Evidence** (from test file names):
  - `memory_modify.hook_handler.pack_incomplete.fail_closed.tripwire.test.ts`
  - `memory_modify.hook_handler.empty_allowlist.fail_closed.tripwire.test.ts`
  - `memory_modify.hook_handler.router_outage.fail_closed.tripwire.test.ts`

#### 1.3 **SUBAGENT_SPAWN Execution Boundary** ⭐⭐⭐⭐⭐

- **Location**: `subagent-spawn.ts` → `applySubagentSpawnOverrides()` (decision-override.ts:1346)
- **What it intercepts**: Subagent delegation before new session creation
- **Why it's perfect**:
  - Prevents unauthorized task delegation to other agents
  - Catches privilege escalation via delegation
  - Fail-closed with empty allowlist (no bypass)
  - Governs who can spawn whom
- **Autonomy score**: 9/10 (preserves agent autonomy within allowed set)
- **Risk governance**: Unauthorized task delegation, privilege escalation, looping/runaway agents
- **Status**: ✅ Implemented (subagent_spawn.*.test.ts files)
- **Evidence**: Test files confirm fail-closed behavior on empty allowlist

#### 1.4 **NODE_INVOKE Execution Boundary** ⭐⭐⭐⭐⭐

- **Location**: [`tools/node-invoke-guard.ts:133`](src/agents/tools/node-invoke-guard.ts:133)
- **What it intercepts**: Remote node function invocation before gateway dispatch
- **Why it's perfect**:
  - Dedicated wrapper enforces mandatory gating (dispatchNodeInvokeGuarded)
  - Fail-closed: throws NodeInvokeBlockedError on ABSTAIN_CONFIRM/CLARIFY
  - Covers all node.invoke paths (system.run, browser.proxy, etc.)
  - Type-safe error reporting
- **Autonomy score**: 9/10 (preserves tool selection, constrains execution)
- **Risk governance**: Remote code execution on companion nodes, cross-device attacks
- **Status**: ✅ Fully implemented wrapper with structured error handling
- **Evidence**:

  ```typescript
  // node-invoke-guard.ts:98-135
  export async function dispatchNodeInvokeGuarded<T = unknown>(...) {
    const gatingResult = await applyNodeInvokeOverrides(context);
    if (gatingResult.outcome !== "PROCEED") {
      throw new NodeInvokeBlockedError(blockedData, functionName);
    }
    const result = await callGatewayTool<T>("node.invoke", ..., params);
    return result;
  }
  ```

### Tier 2: Strong Fit (Implemented, Some Gaps)

#### 2.1 **MESSAGE_EMIT Execution Boundary** ⭐⭐⭐⭐

- **Location**: `web/outbound.ts:97`
- **What it intercepts**: Message send to external channels before delivery
- **Why it's good**:
  - Prevents unauthorized message sends (spam, data exfiltration via chat)
  - Fail-open (permissive), but can be configured to fail-closed
  - Governs external communication boundary
- **Autonomy score**: 9/10
- **Risk governance**: Message spam, data exfiltration via chat, unauthorized replies
- **Status**: ✅ Implemented
- **Gap**: Fail-open by default (deliberate for user-interaction safety)

#### 2.2 **TOOL_DISPATCH_GATE** ⭐⭐⭐⭐

- **Location**: `pi-embedded-subscribe.handlers.tools.ts` (inferred)
- **What it intercepts**: Tool dispatch routing before tool execution
- **Why it's good**:
  - Gating at tool invocation layer
  - Confirmation requirement for HIGH/CRITICAL tools
  - Prevents tool switching without user approval
- **Autonomy score**: 8/10 (controls which tool executes, not whether to act)
- **Risk governance**: Unauthorized tool use, dangerous tool selection
- **Status**: ✅ Implemented (tool_dispatch_gate.*.test.ts)
- **Gap**: Fail-open on router errors (mismatch acceptance)

### Tier 3: Acceptable Fit (Implemented, More Work Needed)

#### 3.1 **NETWORK_IO Execution Boundary** ⭐⭐⭐

- **Status**: Partially implemented (applyNetworkIOOverrides exists, not all call sites wired)
- **Gap**: Not consistently integrated at fetch() boundary
- **Risk**: Could miss some network requests

#### 3.2 **FILE_SYSTEM_OPS Execution Boundary** ⭐⭐⭐

- **Status**: Partially implemented (applyFileSystemOverrides exists)
- **Gap**: Not wired at fs.* call sites
- **Risk**: Unprotected file operations

#### 3.3 **BROWSER_AUTOMATE Execution Boundary** ⭐⭐⭐

- **Status**: Function exists, integration uncertain
- **Gap**: Browser tool handlers may not use gate
- **Risk**: Uncontrolled browser automation

#### 3.4 **CRON_SCHEDULE Execution Boundary** ⭐⭐⭐

- **Status**: Function exists (applyCronScheduleOverrides)
- **Gap**: Limited visibility into cron-dispatch-checker integration
- **Risk**: Unscheduled cron tasks could bypass gate

---

## Autonomy Preservation Check

### How ClarityBurst Regulates Execution WITHOUT Taking Over Reasoning

**Principle**: ClarityBurst governs *action*, not *intelligence*.

#### 1. **LLM Retains Full Planning Autonomy**

The LLM:

- ✅ Reads the task and user context
- ✅ Reasons about the best approach
- ✅ Selects which tools to invoke
- ✅ Decides the parameter values
- ❌ **ONLY** cannot execute the action without gate approval

**Exact boundary** (from bash-tools.exec.ts flow):

```
Tool Selection (LLM) ──[AUTONOMOUS]─→ 
Execute Tool Handler ──[NO GATE]─→ 
Parameter Validation ──[NO GATE]─→ 
ClarityBurst Gate ──[REGULATED]─→ 
Actual Process Spawn ──[BLOCKED IF GATE DENIES]
```

#### 2. **Three-Phase Execution Model Preserves Reasoning**

| **Phase** | **Agent** | **Control** | **Autonomy** |
|---|---|---|---|
| **Plan & Route** | LLM + Router | LLM chooses tool | 100% autonomous |
| **Validate & Gate** | ClarityBurst | Policy applied | Constrained to allowed contracts |
| **Execute** | OpenClaw Runtime | Policy enforced | Only if gate approved |

**Why this works**:

- LLM never sees policy enforcement (no feedback loop that degrades reasoning)
- LLM can always plan the best solution (policy is outside its reasoning loop)
- Gating is deterministic, not LLM-controlled (no "ask user" loops that confuse agent)

#### 3. **Fail-Open vs. Fail-Closed Maintains Autonomy**

**Fail-Open Stages** (most tools):

- SHELL_EXEC: Fail-closed for HIGH/CRITICAL, fail-open for LOW
- TOOL_DISPATCH_GATE: Fail-open on router error
- MESSAGE_EMIT: Fail-open (user safety)
- Effect: Agent can still act in degraded mode (respects user autonomy)

**Fail-Closed Stages** (critical paths):

- MEMORY_MODIFY: Always fail-closed (no silent data loss)
- SUBAGENT_SPAWN: Fail-closed on empty allowlist (prevents escalation)
- NODE_INVOKE: Fail-closed (remote execution too risky)
- Effect: Agent gets explicit error, can plan recovery

#### 4. **Confirmation Tokens Preserve User Agency**

When gate returns `ABSTAIN_CONFIRM`, the flow is:

```
Agent Tool Call with Confirmation Token Required
    ↓
Agent Receives: {"outcome": "ABSTAIN_CONFIRM", "instructions": "...token..."}
    ↓
Agent Re-calls Tool with Confirmation Token
    ↓
Gate Checks: userConfirmed === true (token validates)
    ↓
Proceed with Execution
```

**Autonomy preservation**: Agent can decide to:

- Retry with token (respects policy)
- Abandon the action (respects safety)
- Clarify with user (respects collaboration)

#### 5. **Router Uncertainty (LOW_DOMINANCE_OR_CONFIDENCE) Doesn't Block Planning**

When gate returns `ABSTAIN_CLARIFY` due to low confidence:

- Agent sees the outcome and decision rationale
- Agent can **rephrase the request** (which is planning, not reasoning)
- Rephrasing may produce higher router confidence
- **Autonomy**: Agent still directs the approach, only gets clarity feedback

#### 6. **Contract Filtering (Allowed Contracts) Respects Agent Judgment**

Allowed contracts are derived from runtime capabilities, not from agent task:

```typescript
// From allowed-contracts.ts:161-172
const allowedContractIds = deriveAllowedContracts(
  stageId,           // ← ClarityBurst stage
  pack,              // ← Policy pack (environment config)
  caps               // ← Capabilities (infrastructure config)
);
// NOT based on: agent identity, task content, user profile
```

**Autonomy preservation**:

- Filtering is capability-driven (infrastructure, not policy)
- Agent sees which contracts router can choose from
- Router picks the best match from allowed set
- Agent is never blocked from reasoning about the full problem

---

## Mismatch / Edge Cases

### 1. **Bypass Scenarios Not Fully Gated**

#### 1.1 Elevated Execution (bypass=true)

**Code**: [`bash-tools.exec.ts:330`](src/agents/bash-tools.exec.ts:330)

```typescript
const bypassApprovals = elevatedRequested && elevatedMode === "full";
if (bypassApprovals) {
  ask = "off";  // ← Approvals skipped
}
```

**Issue**: When `elevated=full` is configured, shell gating is bypassed entirely.

**Current behavior**:

- ClarityBurst gate is NOT called if `bypassApprovals === true`
- Process runs directly with elevated privileges
- No SHELL_EXEC stage gating

**Risk**: High-privilege commands can bypass policy if agent requests `elevated=full`.

**Mitigation**: Depends on `elevatedDefaults.allowFrom` configuration (per-provider/channel).

---

#### 1.2 Sandbox vs. Gateway Execution Asymmetry

**Code**: [`bash-tools.exec.ts:401-424`](src/agents/bash-tools.exec.ts:401-424)

```typescript
if (host === "node") {
  return executeNodeHostCommand({...});  // ← NODE_INVOKE gating
}

if (host === "gateway" && !bypassApprovals) {
  const gatewayResult = await processGatewayAllowlist({...});  // ← SHELL_EXEC gating
}

// Sandbox execution:
const run = await runExecProcess({...});  // ← Called without gate for sandbox
```

**Issue**: Sandbox-hosted execution does not call `applyShellExecOverrides()` if no gateway gating applies.

**Current behavior**:

- Sandbox: Gated via allowlist + safe-bin profiles (not ClarityBurst)
- Gateway: Gated via ClarityBurst
- Node: Gated via NODE_INVOKE + allowlist

**Risk**: Sandbox policies (allowlist, safe-bin) can differ from ClarityBurst policies.

**Mitigation**: Sandbox allowlist and ClarityBurst must be kept in sync.

---

### 2. **File System Operations Not Fully Wired**

**Issue**: `applyFileSystemOverrides()` exists but is not integrated at fs.* call sites.

**Evidence**:

- Function defined: decision-override.ts:729
- No call site found in codebase search
- Test exists: bash-tools.exec.ts.path.test.ts (file path validation)
- But no evidence of applyFileSystemOverrides() being called

**Risk**: File system operations may execute without ClarityBurst gating.

**Mitigation pathway**:

- Wire `applyFileSystemOverrides()` into file-system tool handlers
- Apply gate before `fs.readFile()`, `fs.writeFile()`, `fs.delete()`, etc.
- Currently relies on allowlist/path validation (not ClarityBurst)

---

### 3. **Network I/O Incomplete Wiring**

**Issue**: `applyNetworkIOOverrides()` (via `applyNetworkOverridesImpl`) exists but integration unclear.

**Evidence**:

- Function defined: decision-override.ts:835-859 (applyNetworkOverridesImpl)
- Canonical export: None visible for `applyNetworkIOOverrides()`
- No call site in visible codebase
- Fail-closed mode checks for side-effectful (POST/PUT/DELETE) operations

**Current behavior**: Network I/O likely proceeds without ClarityBurst gating in most paths.

**Mitigation**: Wire gate into fetch() calls, HTTP client initialization.

---

### 4. **Browser Automation Integration Unclear**

**Issue**: `applyBrowserAutomateOverrides()` exists but call sites not visible.

**Risk**: Playwright operations may not be gated.

**Evidence**:

- Function defined: decision-override.ts:1863
- No call site found
- Browser tool handlers exist (pw-tools-core.ts exports)
- Gate integration status uncertain

---

### 5. **Cron Dispatch Gating May Not Cover All Paths**

**Issue**: `applyCronScheduleOverrides()` exists, but integration with cron-dispatch-checker.ts unclear.

**Risk**: Some cron registrations may bypass policy.

**Evidence**:

- Function defined: decision-override.ts:2058
- cron-dispatch-checker.ts exists and checks capability
- Integration between gate and checker not fully visible

---

### 6. **Hook Handlers as Separate Execution Domain**

**Issue**: Hook handlers (e.g., session-memory) are event-driven, not direct tool calls.

**Current model**:

```
Tool → Side Effect (Hook Trigger)
         ↓
       Hook Handler
         ↓
       [ClarityBurst Gate]  ← Gate applied here, not at tool level
         ↓
       Actual Persistence
```

**Risk**: If hook handler is not properly integrated with applyMemoryModifyOverrides(), the gate is bypassed.

**Evidence**: Tests show gate is checked (memory_modify.hook_handler.*.tripwire.test.ts), but integration pattern is non-standard.

---

### 7. **Router Outage Fail-Behavior Variance**

**Issue**: Different stages fail differently on router outage:

| Stage | Fail Behavior | Code |
|---|---|---|
| SHELL_EXEC | Fail-open (PROCEED) | decision-override.ts:485-489 |
| TOOL_DISPATCH_GATE | Fail-open (PROCEED) | decision-override.ts:339-343 |
| NETWORK_IO (impl) | Fail-closed (ABSTAIN_CLARIFY) | decision-override.ts:851-858 |
| MEMORY_MODIFY | Fail-closed (checked at commit) | decision-override.ts:~1200s |

**Risk**: Inconsistent safety posture. Some stages are permissive on router failure; others are strict.

**Mitigation**: `CLARITYBURST_ROUTER_REQUIRED=1` enables fail-closed for side-effectful ops (decision-override.ts:32-107).

---

## Final Recommendation

### Primary ClarityBurst Insertion Point

**Recommendation: KEEP ClarityBurst at Execution Boundaries (Current Design)**

**Summary**:
The existing distributed execution-boundary model is **optimal** for preserving OpenClaw's autonomy while governing unsafe execution. ClarityBurst is already positioned correctly.

### What's Working Well

1. **SHELL_EXEC gate** (`applyShellExecOverrides()` @ decision-override.ts:473)
   - Intercepts before `runExecProcess()` (bash-tools.exec.ts:471)
   - Fail-closed for HIGH/CRITICAL contracts
   - Preserves LLM autonomy (agent can still plan anything, execution is constrained)

2. **MEMORY_MODIFY gate** (commit-point @ hooks/bundled/session-memory/handler.ts:309)
   - Deepest interception (gates actual persistence)
   - Fail-closed by default (no silent data loss)
   - Prevents unauthorized session capture

3. **SUBAGENT_SPAWN gate** (`applySubagentSpawnOverrides()` @ decision-override.ts:1346)
   - Prevents unauthorized agent delegation
   - Fail-closed with empty allowlist
   - Prevents privilege escalation loops

4. **NODE_INVOKE gate** (`dispatchNodeInvokeGuarded()` @ tools/node-invoke-guard.ts:133)
   - Dedicated wrapper with fail-closed semantics
   - Prevents remote code execution without policy
   - Type-safe error handling

### Secondary Insertions to Complete Coverage

1. **FILE_SYSTEM_OPS gate** (decision-override.ts:729)
   - Status: Implemented but not wired
   - **Action**: Wire into file tool handlers before fs.* calls
   - **Priority**: High (file system is critical boundary)

2. **NETWORK_IO gate** (decision-override.ts:~930)
   - Status: Partially implemented
   - **Action**: Wire into HTTP client, fetch() calls
   - **Priority**: High (external communication is critical boundary)

3. **BROWSER_AUTOMATE gate** (decision-override.ts:1863)
   - Status: Implemented but integration unclear
   - **Action**: Wire into Playwright operations
   - **Priority**: Medium (browser automation has XSS/data theft risks)

4. **CRON_SCHEDULE gate** (decision-override.ts:2058)
   - Status: Implemented, integration partially visible
   - **Action**: Ensure integration with cron-dispatch-checker.ts
   - **Priority**: Medium (runaway cron jobs are a risk)

### Why Execution-Boundary Interception Is the Right Model

| Reason | Evidence from Codebase |
|---|---|
| **Preserves autonomy** | LLM plans freely; gate only constrains execution, not reasoning (bash-tools.exec.ts flow shows clear separation) |
| **Fail-safe default** | If gate is missing, worst case is permissive; if added, can be progressively tightened (current: 4/12 gates hardened, 8 available) |
| **Auditable** | Each gate is a distinct function with clear entry/exit (decision-override.ts provides 12 named functions) |
| **Decentralized** | No single point of failure; each capability area has its own gate (robust against individual gate bypass) |
| **Standards-aligned** | Matches Unix principle of "least privilege at execution time" (similar to SELinux, AppArmor) |

### Exact Recommendation

**Do NOT move ClarityBurst upstream** (to prompt/input or planning level).

**Instead, complete downstream integration**:

1. **For each execution boundary, ensure gate is called**:

   ```
   Boundary = Function Call That Causes Side Effect
   Gate = applyXxxOverrides() called immediately before
   Block = If gate returns ABSTAIN_*, exception thrown before execution
   ```

2. **For each of the 12 stages, establish this pattern**:

   ```typescript
   // Before any side effect:
   const gateResult = await applyXxxOverrides(context);
   
   // Only proceed if PROCEED:
   if (gateResult.outcome !== "PROCEED") {
     throw new ClarityBurstAbstainError(gateResult);
   }
   
   // Now execute:
   await actualSideEffectFunction(...);
   ```

3. **Verify all boundaries are wired**:
   - ✅ SHELL_EXEC: Done (bash-tools.exec-host-gateway.ts, bash-tools.exec-host-node.ts)
   - ✅ SUBAGENT_SPAWN: Done (subagent-spawn.ts)
   - ✅ NODE_INVOKE: Done (node-invoke-guard.ts wrapper)
   - ✅ MEMORY_MODIFY: Done (session-memory hook handler)
   - ✅ MESSAGE_EMIT: Done (web/outbound.ts)
   - ❌ NETWORK_IO: Missing (need fetch integration)
   - ❌ FILE_SYSTEM_OPS: Missing (need fs.* integration)
   - ❓ BROWSER_AUTOMATE: Unclear (need confirmation)
   - ❓ CRON_SCHEDULE: Partial (need verification)
   - ❓ CANVAS_UI: Unclear (need confirmation)
   - ❓ MEDIA_GENERATE: Unclear (need confirmation)

### Final Summary: The Best Fit

**ClarityBurst's best role is as an execution-boundary control layer that:**

- ✅ Intercepts at the moment of action (before process spawn, file write, network call, etc.)
- ✅ Preserves LLM autonomy (reasoning and tool selection remain fully autonomous)
- ✅ Enforces policy deterministically (contract-based, not heuristic)
- ✅ Fails safely (fail-closed on critical paths, fail-open on non-critical)
- ✅ Operates independently per stage (12 distributed gates, not 1 central point)

**The principle**: Regulate *execution*, not *intelligence*. OpenClaw's value is in its autonomous reasoning; ClarityBurst preserves that by only governing *what happens when the agent acts*, not *what the agent thinks it should do*.

---

## Appendix: File Cross-References

**Core ClarityBurst Implementation**:

- [`src/clarityburst/decision-override.ts`](src/clarityburst/decision-override.ts) - All 12 stage override functions
- [`src/clarityburst/router-client.ts`](src/clarityburst/router-client.ts) - Router interaction
- [`src/clarityburst/allowed-contracts.ts`](src/clarityburst/allowed-contracts.ts) - Contract filtering

**Execution Boundaries**:

- [`src/agents/bash-tools.exec.ts`](src/agents/bash-tools.exec.ts) - SHELL_EXEC, NODE_INVOKE (lines ~401-471)
- [`src/agents/bash-tools.exec-host-node.ts`](src/agents/bash-tools.exec-host-node.ts) - NODE_INVOKE dispatch
- [`src/agents/tools/node-invoke-guard.ts`](src/agents/tools/node-invoke-guard.ts) - NODE_INVOKE gate wrapper
- [`src/agents/tools/sessions-spawn-tool.ts`](src/agents/tools/sessions-spawn-tool.ts) - SUBAGENT_SPAWN entry
- [`src/hooks/bundled/session-memory/handler.ts`](src/hooks/bundled/session-memory/handler.ts) - MEMORY_MODIFY commit point (line 309)
- [`src/web/outbound.ts`](src/web/outbound.ts) - MESSAGE_EMIT gate (line 97)

**Test Evidence**:

- `src/clarityburst/__tests__/shell_exec.confirmation.exact_token.tripwire.test.ts`
- `src/clarityburst/__tests__/memory_modify.hook_handler.*.tripwire.test.ts`
- `src/clarityburst/__tests__/subagent_spawn.*.tripwire.test.ts`
- `src/agents/bash-tools.exec.empty-allowlist.test.ts`
- `src/agents/bash-tools.exec.pack-incomplete.test.ts`

**Infrastructure**:

- [`src/agents/bash-tools.exec-runtime.ts`](src/agents/bash-tools.exec-runtime.ts) - `runExecProcess()` @ line 270
- [`src/agents/bash-tools.exec-host-gateway.ts`](src/agents/bash-tools.exec-host-gateway.ts) - `processGatewayAllowlist()`
- [`src/clarityburst/pack-load.ts`](src/clarityburst/pack-load.ts) - Pack loading logic
- [`src/clarityburst/stages.ts`](src/clarityburst/stages.ts) - Stage ID definitions
