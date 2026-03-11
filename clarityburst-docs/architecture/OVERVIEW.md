# ClarityBurst Architecture Overview

**A comprehensive technical guide to the ClarityBurst decision gating framework**

---

## What is ClarityBurst?

ClarityBurst is OpenClaw's **fail-closed decision gating framework** that:

1. **Intercepts high-risk operations** (shell execution, network I/O, file system operations, etc.)
2. **Routes decisions through a deterministic ontology router** that evaluates risk contracts
3. **Applies fine-grained gating logic** based on stage, context, and user confirmation
4. **Fails safely** when the router is unavailable (defaults to ABSTAIN on outage)
5. **Prevents runaway cost loops** through deterministic action tracking and intervention

---

## Core Concepts

### Stages (13 total)

ClarityBurst gates 13 execution stages across the platform:

| Stage | Purpose | Risk Level |
|-------|---------|-----------|
| `TOOL_DISPATCH_GATE` | Tool availability routing | Medium |
| `SHELL_EXEC` | Shell command execution | HIGH |
| `NETWORK_IO` | Network requests (fetch, HTTP) | HIGH |
| `FILE_SYSTEM_OPS` | File system operations | HIGH |
| `SUBAGENT_SPAWN` | Subagent creation/spawning | HIGH |
| `MEMORY_MODIFY` | Memory/knowledge base updates | Medium |
| `NODE_INVOKE` | Node invocation | Medium |
| `CRON_SCHEDULE` | Scheduled task definition | Medium |
| `CRON_PREFLIGHT_GATE` | Preflight cron validation | Medium |
| `MESSAGE_EMIT` | Message output | Low |
| `CANVAS_UI` | Canvas UI operations | Low |
| `BROWSER_AUTOMATE` | Browser automation | Medium |
| `MEDIA_GENERATE` | Media generation | Low |

### Contracts (127 total)

Each stage defines a set of **contracts** — fine-grained authorization rules that specify:

- **Contract ID** – Unique identifier within the stage
- **Name** – Human-readable name
- **Risk Level** – LOW, MEDIUM, HIGH, CRITICAL
- **Requires Confirmation** – Whether user approval is needed
- **Capabilities Required** – browser, shell, network, fs_write, critical_opt_in, sensitive_access
- **Conditions** – Context-specific gating rules

**Total Contracts Across All Stages:** ~127

See [`Stage Definitions`](STAGE_DEFINITIONS.md) for the complete list.

### Routing Decision Outcomes

When ClarityBurst evaluates a request, it returns one of four outcomes:

| Outcome | Meaning | Action |
|---------|---------|--------|
| `PROCEED` | Approved; execute operation | Allow execution |
| `ABSTAIN_CLARIFY` | Router unavailable or contract denied; escalate to user | Ask for confirmation or block |
| `ABSTAIN_CONFIRM` | Confirmation required; waiting for user token | Block until user confirms |
| `MODIFY` | Allow with modifications | Apply constraints (e.g., timeout adjustment) |

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│ Application Layer (agents, commands, API handlers)      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  src/clarityburst/decision-override.ts                 │
│  ├─ applyToolDispatchOverrides()                        │
│  ├─ applyShellExecOverrides()                           │
│  ├─ applyNetworkOverrides()                             │
│  ├─ applyFileSystemOverrides()                          │
│  ├─ applyMemoryModifyOverrides()                        │
│  ├─ applySubagentSpawnOverrides()                       │
│  └─ ... (11 total gating functions)                     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Routing Layer                                           │
│                                                         │
│  src/clarityburst/router-client.ts                      │
│  ├─ routeClarityBurst() – HTTP POST to router           │
│  ├─ Allowlist validation before routing                 │
│  ├─ Timeout handling (default: 1200ms, range: 100-5000) │
│  └─ Error handling (returns ok: false on failure)       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ Ontology Pack Layer                                     │
│                                                         │
│  src/clarityburst/pack-registry.ts                      │
│  ├─ Dynamic loading from ontology-packs/*.json          │
│  ├─ Lazy loading (packs only loaded when needed)        │
│  ├─ Caching after first load                            │
│  └─ 13 packs total: one per stage                       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│ External Service: ClarityBurst Router                   │
│                                                         │
│  HTTP endpoint (configurable)                           │
│  ├─ Receives: { stageId, allowedContractIds, context }  │
│  ├─ Returns: { ok, topMatch, topTwoMatches }            │
│  └─ Applies: deterministic arbitration                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Configuration

ClarityBurst is configured via environment variables:

```bash
# Enable/disable gating (default: true)
CLARITYBURST_ENABLED=true

# Router service endpoint (default: http://localhost:3001)
CLARITYBURST_ROUTER_URL=http://localhost:3001

# Router request timeout in milliseconds (default: 1200, range: 100-5000)
CLARITYBURST_ROUTER_TIMEOUT_MS=1200

# Logging level (debug|info|warn|error, default: info)
CLARITYBURST_LOG_LEVEL=info
```

See [`src/clarityburst/config.ts`](../../src/clarityburst/config.ts) for implementation details.

---

## Fail-Closed Behavior

ClarityBurst is **fundamentally fail-closed**:

| Scenario | Behavior | Rationale |
|----------|----------|-----------|
| Router unavailable (timeout, connection refused, malformed response) | Return `ABSTAIN_CLARIFY` (block execution) | Conservative default; errors block rather than allow |
| Router returns contract not in allowedList | **PROCEED** (for TOOL_DISPATCH_GATE) or **ABSTAIN_CLARIFY** (for other stages) | Tool dispatch is more permissive; other stages are strict |
| Pack incomplete or missing | Throw `ClarityBurstAbstainError` immediately | Incomplete packs are unsafe; fail hard |
| User confirmation required but not provided | Return `ABSTAIN_CONFIRM` (block execution) | Explicit approval required |
| CLARITYBURST_ENABLED=false | Bypass gating entirely | Opt-out available for development/testing only |

See [`Security Audit Report`](../security/SECURITY_AUDIT_REPORT.md) for a detailed audit of fail-closed behavior.

---

## Integration Points

### How an Operation Gets Gated

```typescript
// Example: Shell execution in src/agents/bash-tools.exec.ts

// 1. Application code calls the operation
const result = await executeShellCommand(cmd);

// 2. Actually, it's wrapped in a gating check:
async function executeShellCommand(cmd) {
  // 2. Get the decision
  const decision = await applyShellExecOverrides({
    stageId: "SHELL_EXEC",
    command: cmd,
    userConfirmed: await getUserConfirmation(),
  });

  // 3. Evaluate outcome
  if (decision.outcome === "PROCEED") {
    return await exec(cmd);  // OK, run it
  } else if (decision.outcome === "ABSTAIN_CLARIFY") {
    throw new ClarityBurstAbstainError(...);  // Block it
  } else if (decision.outcome === "ABSTAIN_CONFIRM") {
    throw new Error("Confirmation required");  // Ask user
  } else if (decision.outcome === "MODIFY") {
    return await exec(cmd, decision.modifiedContext);  // Run with constraints
  }
}
```

### Stages with Gating

| Stage | Integration File | Function | Status |
|-------|------------------|----------|--------|
| TOOL_DISPATCH_GATE | `src/agents/` | `applyToolDispatchOverrides()` | ✅ Wired |
| SHELL_EXEC | `src/process/exec.ts`, `src/agents/bash-tools.exec.ts` | `applyShellExecOverrides()` | ✅ Wired |
| NETWORK_IO | `src/telegram/send.ts`, `src/infra/fetch.ts` | `applyNetworkOverrides()` | ✅ Wired |
| FILE_SYSTEM_OPS | `src/config/sessions/` | `applyFileSystemOverrides()` | ✅ Wired |
| MEMORY_MODIFY | `src/memory/` | `applyMemoryModifyOverrides()` | ✅ Wired |
| SUBAGENT_SPAWN | `src/agents/spawn.ts` | `applySubagentSpawnOverrides()` | ✅ Wired |
| NODE_INVOKE | (See implementation status) | `applyNodeInvokeOverrides()` | ✅ Implemented |
| CRON_SCHEDULE | `src/cron/` | `applyCronScheduleOverrides()` | ✅ Implemented |
| CRON_PREFLIGHT_GATE | `src/cron/preflight.ts` | `applyCronPreflightGate()` | ✅ Implemented |
| MESSAGE_EMIT | `src/channels/` | `applyMessageEmitOverrides()` | ✅ Implemented |
| CANVAS_UI | `src/canvas/` | `applyCanvasUIOverrides()` | ✅ Implemented |
| BROWSER_AUTOMATE | `src/browser/` | `applyBrowserAutomateOverrides()` | ✅ Implemented |
| MEDIA_GENERATE | `src/media/` | `applyMediaGenerateOverrides()` | ✅ Implemented |

---

## Testing & Validation

ClarityBurst includes comprehensive testing:

### Unit Tests (5 files, ~50 test cases)

- [`pack-load.test.ts`](../../src/clarityburst/pack-load.test.ts) – Pack integrity
- [`router-client.duplicate-ids.test.ts`](../../src/clarityburst/router-client.duplicate-ids.test.ts) – Router validation
- [`stages.packs.test.ts`](../../src/clarityburst/stages.packs.test.ts) – Stage loadability
- [`decision-override.test.ts`](../../src/clarityburst/decision-override.test.ts) – Gating logic
- And more...

### Tripwire Tests (30+ files, in `src/clarityburst/__tests__/`)

Focused on **fail-closed behavior** under specific failure modes:

- Router outage scenarios
- Pack incompleteness
- Empty allowlists
- Confirmation token validation
- Threshold boundary checking

### Production Readiness Verification

- 7-point verification harness (`scripts/clarityburst-verify.ts`)
- Checks: coverage, dominance (heuristic + strict), agentic loop simulation, outage handling, chaos integration, benchmarking
- See [`Verification Harness`](../validation/VERIFICATION_HARNESS.md) for full details

### Chaos Testing

- Phase 1-2: Synchronous + asynchronous routing simulation
- Phase 3: Fault injection (router outage, network partition, cascading failures)
- Phase 4: Prompt injection security (instruction override attack detection)

---

## Module Dependency Graph

```
Application Code
  ↓
src/clarityburst/decision-override.ts (11 override functions)
  ↓ calls
src/clarityburst/router-client.ts (HTTP routing)
  ↓ calls
External ClarityBurst Router Service
  ↓ returns
src/clarityburst/pack-registry.ts (loaded on-demand)
  ↓ reads
ontology-packs/*.json (13 packs, ~127 contracts)
```

---

## Performance Characteristics

**Router Latency:**

- Default timeout: 1200ms
- Typical latency: 10-100ms (subject to network conditions)
- Fail-closed on timeout (returns ABSTAIN_CLARIFY)

**Memory Footprint:**

- Packs loaded lazily (only when needed)
- Cached after first load (~10-50 KB per pack)
- Router client is stateless

**Overhead:**

- Per-operation routing adds ~15-50ms on average
- Cost reduction benefit offsets overhead when preventing runaway loops
- See [`Verification Harness`](../validation/VERIFICATION_HARNESS.md) for benchmark details

---

## Future Enhancements

Planned improvements documented in:

- [`Hardening Roadmap`](../security/HARDENING_ROADMAP.md) – Security upgrades
- [`Remaining Issues`](../reference/REMAINING_ISSUES.md) – Prioritized backlog

---

## See Also

- **For Design Patterns:** [`Control Plane Analogy`](CONTROL_PLANE_ANALOGY.md)
- **For Module Boundaries:** [`Architecture Boundaries`](ARCHITECTURE_BOUNDARIES.md)
- **For Integration Details:** [`Network I/O Wiring Plan`](NETWORK_IO_WIRING_PLAN.md)
- **For Security Model:** [`Security Overview`](../security/SECURITY_OVERVIEW.md)
- **For Testing:** [`Verification Harness`](../validation/VERIFICATION_HARNESS.md)

---

**Last Updated:** 2026-03-07  
**Status:** ✅ Production-ready
