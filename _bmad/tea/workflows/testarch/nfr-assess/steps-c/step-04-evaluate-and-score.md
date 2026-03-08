---
name: "step-04-evaluate-and-score"
description: "Orchestrate adaptive NFR domain assessments (agent-team, subagent, or sequential)"
nextStepFile: "./step-04e-aggregate-nfr.md"
---

# Step 4: Orchestrate Adaptive NFR Assessment

## STEP GOAL

Select execution mode deterministically, then assess NFR domains using agent-team, subagent, or sequential execution while preserving output contracts.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Resolve execution mode from config (`tea_execution_mode`, `tea_capability_probe`)
- ✅ Apply fallback rules deterministically when requested mode is unsupported
- ✅ Wait for required worker steps to complete
- ❌ Do NOT skip capability checks when probing is enabled

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Wait for subagent outputs
- 📖 Load the next step only when instructed

---

## MANDATORY SEQUENCE

### 1. Prepare Execution Context

**Generate unique timestamp:**

```javascript
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
```

**Prepare context:**

```javascript
const parseBooleanFlag = (value, defaultValue = true) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  }
  if (value === undefined || value === null) return defaultValue;
  return Boolean(value);
};

const subagentContext = {
  system_context: /* from Step 1 */,
  nfr_thresholds: /* from Step 2 */,
  evidence_gathered: /* from Step 3 */,
  config: {
    execution_mode: config.tea_execution_mode || 'auto',  // "auto" | "subagent" | "agent-team" | "sequential"
    capability_probe: parseBooleanFlag(config.tea_capability_probe, true),  // supports booleans and "false"/"true" strings
  },
  timestamp: timestamp
};
```

---

### 2. Resolve Execution Mode with Capability Probe

```javascript
const normalizeUserExecutionMode = (mode) => {
  if (typeof mode !== "string") return null;
  const normalized = mode.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");

  if (normalized === "auto") return "auto";
  if (normalized === "sequential") return "sequential";
  if (
    normalized === "subagent" ||
    normalized === "sub agent" ||
    normalized === "subagents" ||
    normalized === "sub agents"
  ) {
    return "subagent";
  }
  if (normalized === "agent team" || normalized === "agent teams" || normalized === "agentteam") {
    return "agent-team";
  }

  return null;
};

const normalizeConfigExecutionMode = (mode) => {
  if (mode === "subagent") return "subagent";
  if (mode === "auto" || mode === "sequential" || mode === "subagent" || mode === "agent-team") {
    return mode;
  }
  return null;
};

// Explicit user instruction in the active run takes priority over config.
const explicitModeFromUser = normalizeUserExecutionMode(
  runtime.getExplicitExecutionModeHint?.() || null,
);

const requestedMode =
  explicitModeFromUser ||
  normalizeConfigExecutionMode(subagentContext.config.execution_mode) ||
  "auto";
const probeEnabled = subagentContext.config.capability_probe;

const supports = {
  subagent: false,
  agentTeam: false,
};

if (probeEnabled) {
  supports.subagent = runtime.canLaunchSubagents?.() === true;
  supports.agentTeam = runtime.canLaunchAgentTeams?.() === true;
}

let resolvedMode = requestedMode;

if (requestedMode === "auto") {
  if (supports.agentTeam) resolvedMode = "agent-team";
  else if (supports.subagent) resolvedMode = "subagent";
  else resolvedMode = "sequential";
} else if (probeEnabled && requestedMode === "agent-team" && !supports.agentTeam) {
  resolvedMode = supports.subagent ? "subagent" : "sequential";
} else if (probeEnabled && requestedMode === "subagent" && !supports.subagent) {
  resolvedMode = "sequential";
}

subagentContext.execution = {
  requestedMode,
  resolvedMode,
  probeEnabled,
  supports,
};
```

Resolution precedence:

1. Explicit user request in this run (`agent team` => `agent-team`; `subagent` => `subagent`; `sequential`; `auto`)
2. `tea_execution_mode` from config
3. Runtime capability fallback (when probing enabled)

If probing is disabled, honor the requested mode strictly. If that mode cannot be executed at runtime, fail with explicit error instead of silent fallback.

---

### 3. Dispatch 4 NFR Workers

**Subagent A: Security Assessment**

- File: `./step-04a-subagent-security.md`
- Output: `/tmp/tea-nfr-security-${timestamp}.json`
- Execution:
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait
- Status: Running... ⟳

**Subagent B: Performance Assessment**

- File: `./step-04b-subagent-performance.md`
- Output: `/tmp/tea-nfr-performance-${timestamp}.json`
- Status: Running... ⟳

**Subagent C: Reliability Assessment**

- File: `./step-04c-subagent-reliability.md`
- Output: `/tmp/tea-nfr-reliability-${timestamp}.json`
- Status: Running... ⟳

**Subagent D: Scalability Assessment**

- File: `./step-04d-subagent-scalability.md`
- Output: `/tmp/tea-nfr-scalability-${timestamp}.json`
- Status: Running... ⟳

In `agent-team` and `subagent` modes, runtime decides worker scheduling and concurrency.

---

### 4. Wait for Expected Worker Completion

**If `resolvedMode` is `agent-team` or `subagent`:**

```
⏳ Waiting for 4 NFR subagents to complete...
  ├── Subagent A (Security): Running... ⟳
  ├── Subagent B (Performance): Running... ⟳
  ├── Subagent C (Reliability): Running... ⟳
  └── Subagent D (Scalability): Running... ⟳

[... time passes ...]

✅ All 4 NFR subagents completed!
```

**If `resolvedMode` is `sequential`:**

```
✅ Sequential mode: each worker already completed during dispatch.
```

---

### 5. Verify All Outputs Exist

```javascript
const outputs = ["security", "performance", "reliability", "scalability"].map(
  (domain) => `/tmp/tea-nfr-${domain}-${timestamp}.json`,
);

outputs.forEach((output) => {
  if (!fs.existsSync(output)) {
    throw new Error(`Subagent output missing: ${output}`);
  }
});
```

---

### 6. Execution Report

```
🚀 Performance Report:
- Execution Mode: {resolvedMode}
- Total Elapsed: ~mode-dependent
- Parallel Gain: ~67% faster when mode is subagent/agent-team
```

---

### 7. Proceed to Aggregation

Load next step: `{nextStepFile}`

The aggregation step will:

- Read all 4 NFR domain outputs
- Calculate overall risk level
- Aggregate compliance status
- Identify cross-domain risks
- Generate executive summary

---

## EXIT CONDITION

Proceed when all 4 required worker steps completed and outputs exist.

---

## 🚨 SYSTEM SUCCESS METRICS

### ✅ SUCCESS:

- All required worker steps completed
- Fallback behavior respected configuration and capability probe rules

### ❌ FAILURE:

- One or more subagents failed
- Unsupported requested mode with probing disabled
