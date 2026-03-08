---
name: "step-03-quality-evaluation"
description: "Orchestrate adaptive quality dimension checks (agent-team, subagent, or sequential)"
nextStepFile: "./step-03f-aggregate-scores.md"
---

# Step 3: Orchestrate Adaptive Quality Evaluation

## STEP GOAL

Select execution mode deterministically, then evaluate quality dimensions using agent-team, subagent, or sequential execution while preserving output contracts:

- Determinism
- Isolation
- Maintainability
- Performance

Coverage is intentionally excluded from this workflow and handled by `trace`.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Resolve execution mode from config (`tea_execution_mode`, `tea_capability_probe`)
- ✅ Apply fallback rules deterministically when requested mode is unsupported
- ✅ Wait for required worker steps to complete
- ❌ Do NOT skip capability checks when probing is enabled
- ❌ Do NOT proceed until required worker steps finish

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Wait for subagent outputs
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: test files from Step 2, knowledge fragments
- Focus: orchestration only (mode selection + worker dispatch)
- Limits: do not evaluate quality directly (delegate to worker steps)

---

## MANDATORY SEQUENCE

### 1. Prepare Execution Context

**Generate unique timestamp:**

```javascript
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
```

**Prepare context for all subagents:**

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
  test_files: /* from Step 2 */,
  knowledge_fragments_loaded: ['test-quality'],
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

### 3. Dispatch 4 Quality Workers

**Subagent A: Determinism**

- File: `./step-03a-subagent-determinism.md`
- Output: `/tmp/tea-test-review-determinism-${timestamp}.json`
- Execution:
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait
- Status: Running... ⟳

**Subagent B: Isolation**

- File: `./step-03b-subagent-isolation.md`
- Output: `/tmp/tea-test-review-isolation-${timestamp}.json`
- Status: Running... ⟳

**Subagent C: Maintainability**

- File: `./step-03c-subagent-maintainability.md`
- Output: `/tmp/tea-test-review-maintainability-${timestamp}.json`
- Status: Running... ⟳

**Subagent D: Performance**

- File: `./step-03e-subagent-performance.md`
- Output: `/tmp/tea-test-review-performance-${timestamp}.json`
- Status: Running... ⟳

In `agent-team` and `subagent` modes, runtime decides worker scheduling and concurrency.

---

### 4. Wait for Expected Worker Completion

**If `resolvedMode` is `agent-team` or `subagent`:**

```
⏳ Waiting for 4 quality subagents to complete...
✅ All 4 quality subagents completed successfully!
```

**If `resolvedMode` is `sequential`:**

```
✅ Sequential mode: each worker already completed during dispatch.
```

---

### 5. Verify All Outputs Exist

```javascript
const outputs = ["determinism", "isolation", "maintainability", "performance"].map(
  (dim) => `/tmp/tea-test-review-${dim}-${timestamp}.json`,
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
- Parallel Gain: ~60-70% faster when mode is subagent/agent-team
```

---

### 7. Proceed to Aggregation

Pass the same `timestamp` value to Step 3F (do not regenerate it). Step 3F must read the exact temp files written in this step.

Load next step: `{nextStepFile}`

The aggregation step (3F) will:

- Read all 4 subagent outputs
- Calculate weighted overall score (0-100)
- Aggregate violations by severity
- Generate review report with top suggestions

---

## EXIT CONDITION

Proceed to Step 3F when:

- ✅ All 4 subagents completed successfully
- ✅ All output files exist and are valid JSON
- ✅ Execution metrics displayed

**Do NOT proceed if any subagent failed.**

---

## 🚨 SYSTEM SUCCESS METRICS

### ✅ SUCCESS:

- All 4 subagents launched and completed
- All required worker steps completed
- Output files generated and valid
- Fallback behavior respected configuration and capability probe rules

### ❌ FAILURE:

- One or more subagents failed
- Output files missing or invalid
- Unsupported requested mode with probing disabled

**Master Rule:** Deterministic mode selection + stable output contract. Use the best supported mode, then aggregate normally.
