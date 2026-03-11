# NODE_INVOKE ClarityBurst Gating Audit

**Date:** 2026-03-09  
**Scope:** Verify all code paths to `callGatewayTool("node.invoke", ...)` pass through ClarityBurst gate  
**Gate Function:** `applyNodeInvokeOverrides()` in [`src/clarityburst/decision-override.ts:1643`](src/clarityburst/decision-override.ts:1643)

---

## Summary

**CRITICAL FINDING:** Multiple code paths trigger `node.invoke` WITHOUT passing through ClarityBurst gating.

| Category | Status | Count | Risk |
|----------|--------|-------|------|
| Agent Tools (Gated) | ✅ | 1 | Low |
| Agent Tools (Ungated) | ❌ | 3 | **HIGH** |
| Gateway RPC | ✅ | 1 | Low |
| CLI Commands | ⚠️ | 6 | Medium |

---

## GATED Code Paths (✅ Safe)

### 1. Canvas Tool - src/agents/tools/canvas-tool.ts:114-142

**Status:** ✅ PROPERLY GATED

```typescript
const invoke = async (command: string, invokeParams?: Record<string, unknown>) => {
  const nodeCtx = {
    stageId: "NODE_INVOKE" as const,
    userConfirmed: false,
    functionName: command,
    nodeId,
  };

  const gate = await applyNodeInvokeOverrides(nodeCtx);  // ✅ GATE CHECK

  if (gate.outcome === "ABSTAIN_CONFIRM" || gate.outcome === "ABSTAIN_CLARIFY") {
    return jsonResult({  // ✅ BLOCKED RESPONSE RETURNED
      status: "blocked",
      outcome: gate.outcome,
      ...
    });
  }

  return await callGatewayTool("node.invoke", gatewayOpts, {  // ✅ ONLY AFTER GATE APPROVAL
    nodeId,
    command,
    params: invokeParams,
    idempotencyKey: crypto.randomUUID(),
  });
};
```

**Gate Location:** Line 122 calls `applyNodeInvokeOverrides(nodeCtx)`  
**Block Handling:** Lines 125-134 return blocked response before proceeding  
**Verification:** Lines 136-141 call `callGatewayTool()` ONLY if gate outcome is "PROCEED"

---

## UNGATED Code Paths (❌ CRITICAL RISK)

### 1. Nodes Tool - src/agents/tools/nodes-tool.ts

#### Line 76 - invokeNodeCommandPayload()

**Status:** ❌ NO GATING

```typescript
async function invokeNodeCommandPayload(params: {
  gatewayOpts: GatewayCallOptions;
  node: string;
  command: string;
  commandParams?: Record<string, unknown>;
}): Promise<unknown> {
  const nodeId = await resolveNodeId(params.gatewayOpts, params.node);
  const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", params.gatewayOpts, {
    // ❌ NO GATE CHECK
    nodeId,
    command: params.command,
    params: params.commandParams ?? {},
    idempotencyKey: crypto.randomUUID(),
  });
  return raw?.payload ?? {};
}
```

**Callers (all ungated):**

- Line 216: `nodes` action → calls `callGatewayTool("node.invoke")` without gate
- Line 267: `camera_clip` action
- Line 393: `notifications_list` action
- Line 437: `screen_record` action
- Line 545: `run` action (main command execution)
- Line 602: `run` action with approval retry
- Line 634: `invoke` action (direct node.invoke wrapper)

#### Line 202 - Browser Tool - src/agents/tools/browser-tool.ts

**Status:** ❌ NO GATING

```typescript
const payload = await callGatewayTool<{ payloadJSON?: string; payload?: string }>(
  "node.invoke",  // ❌ NO GATE CHECK BEFORE THIS
  { timeoutMs: gatewayTimeoutMs },
  {
    nodeId: params.nodeId,
    command: "browser.proxy",
    params: {
      method: params.method,
      path: params.path,
      query: params.query,
      body: params.body,
      timeoutMs: params.timeoutMs,
      profile: params.profile,
    },
    idempotencyKey: crypto.randomUUID(),
  },
);
```

**Risk:** Browser automation can execute arbitrary code via eval-style commands  
**Missing:** No call to `applyNodeInvokeOverrides()` before `callGatewayTool()`

#### Lines 284, 327 - Bash Exec Host Node - src/agents/bash-tools.exec-host-node.ts

**Status:** ❌ NO GATING (Even with approval workflow)

```typescript
// Line 284-288: Even with approval, direct invoke without gate
try {
  await callGatewayTool(
    "node.invoke",  // ❌ NO GATE CHECK
    { timeoutMs: invokeTimeoutMs },
    buildInvokeParams(approvedByAsk, approvalDecision, approvalId),
  );
}

// Line 327-329: Direct invoke without gate
const raw = await callGatewayTool(
  "node.invoke",  // ❌ NO GATE CHECK
  { timeoutMs: invokeTimeoutMs },
```

**Risk:** system.run execution (shell commands) can be executed without ClarityBurst approval  
**Note:** File has exec approval flow but NO ClarityBurst NODE_INVOKE gate

---

## CLI Commands (⚠️ Conditional Risk)

### Ungated callGatewayCli("node.invoke") Calls

All these use `callGatewayCli()` instead of `callGatewayTool()`:

1. **register.camera.ts:153, 223** - Camera clip/snap operations
2. **register.invoke.ts:149, 349, 437** - Direct node.invoke command
3. **register.location.ts:56** - Location queries
4. **register.notify.ts:47** - Notification delivery
5. **register.screen.ts:53** - Screen record operations

**Context:** CLI commands use `callGatewayCli()` → these may have different gating strategy or intentionally skip agent-level gating  
**Status:** ⚠️ NEEDS CLARIFICATION - Is CLI tool-level gating a design choice?

---

## Gateway RPC Handler (✅ Safe)

### src/gateway/server-methods/nodes.ts:611

**Status:** ✅ GATED AT RPC LEVEL

The gateway `"node.invoke"` RPC handler includes:

- Line 637-648: Blocks `system.execApprovals.*` commands (redirect to `exec.approvals.node.*`)
- Line 650: Wraps execution in `respondUnavailableOnThrow()` for error handling
- Line 751: Sanitizes params via `sanitizeNodeInvokeParamsForForwarding()`

**Note:** This is the RPC entry point. Agent-level gating via ClarityBurst should STILL be applied by callers.

---

## Code Path Analysis

### How node.invoke Reaches Gateway

```
callGatewayTool("node.invoke", ...)
    ↓
src/agents/tools/gateway.ts
    ↓
src/gateway/call.ts → callGateway()
    ↓
src/gateway/server-methods/nodes.ts:611 (RPC handler)
    ↓
src/gateway/node-registry.ts (dispatch to node session)
```

### Where ClarityBurst Should Intercept

All agent-level calls to `callGatewayTool("node.invoke", ...)` should be preceded by:

```typescript
const gate = await applyNodeInvokeOverrides({
  stageId: "NODE_INVOKE",
  userConfirmed: false,
  functionName: command,
  nodeId,
});

if (gate.outcome !== "PROCEED") {
  return handleBlockedOutcome(gate);
}

// Only then call callGatewayTool
await callGatewayTool("node.invoke", ...)
```

---

## Recommendations

### Immediate Actions (P0)

1. **Apply ClarityBurst gating to ungated agent tool paths:**
   - [ ] `src/agents/tools/nodes-tool.ts` - Wrap `invokeNodeCommandPayload()` and all its callers
   - [ ] `src/agents/tools/browser-tool.ts` - Add gating before `callGatewayTool("node.invoke")`
   - [ ] `src/agents/bash-tools.exec-host-node.ts` - Add gating before both invoke calls (line 284, 327)

2. **Verify CLI command strategy:**
   - [ ] Clarify if CLI-level gating is intentional (different trust model than agents)
   - [ ] If agents also use CLI internally, verify no bypass paths exist

3. **Add test coverage:**
   - [ ] Create test `node_invoke.ungated_paths.fail_closed.tripwire.test.ts` for each ungated path
   - [ ] Verify gating blocks unsafe commands per pack policy

### Testing Pattern (Example)

```typescript
// nodes-tool should fail closed if ClarityBurst gate is misconfigured
test("nodes.invoke fails closed if ClarityBurst gate returns ABSTAIN_CLARIFY", async () => {
  const mockGate = vi.fn().mockResolvedValue({
    outcome: "ABSTAIN_CLARIFY",
    reason: "CONFIRM_REQUIRED",
    contractId: "NODE_INVOKE_SYSTEM_RUN",
  });

  const result = await nodesTool.execute("invoke-test", {
    action: "run",
    node: "device-1",
    command: "system.run",
    params: { command: "ls" },
  });

  expect(result).toMatchObject({
    status: "blocked",
    outcome: "ABSTAIN_CLARIFY",
  });

  expect(callGatewayTool).not.toHaveBeenCalled();
});
```

---

## References

- **ClarityBurst Decision Override:** [`src/clarityburst/decision-override.ts`](src/clarityburst/decision-override.ts)
- **NODE_INVOKE Stage Definition:** [`src/clarityburst/stages.ts:31`](src/clarityburst/stages.ts:31)
- **Canvas Tool (Reference Implementation):** [`src/agents/tools/canvas-tool.ts:114-142`](src/agents/tools/canvas-tool.ts:114-142)
- **Ungated Nodes Tool:** [`src/agents/tools/nodes-tool.ts:76`](src/agents/tools/nodes-tool.ts:76)
- **Ungated Browser Tool:** [`src/agents/tools/browser-tool.ts:202`](src/agents/tools/browser-tool.ts:202)
- **Ungated Bash Exec Node:** [`src/agents/bash-tools.exec-host-node.ts:284,327`](src/agents/bash-tools.exec-host-node.ts:284)
