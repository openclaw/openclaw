---
name: "step-04-generate-tests"
description: "Orchestrate adaptive FAILING test generation (TDD red phase)"
nextStepFile: "./step-04c-aggregate.md"
---

# Step 4: Orchestrate Adaptive FAILING Test Generation

## STEP GOAL

Select execution mode deterministically, then generate FAILING API and E2E tests (TDD RED PHASE) with consistent output contracts across agent-team, subagent, or sequential execution.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Resolve execution mode from config (`tea_execution_mode`, `tea_capability_probe`)
- ✅ Apply fallback rules deterministically when requested mode is unsupported
- ✅ Generate FAILING tests only (TDD red phase)
- ✅ Wait for required worker steps to complete
- ❌ Do NOT skip capability checks when probing is enabled
- ❌ Do NOT generate passing tests (this is red phase)
- ❌ Do NOT proceed until required worker steps finish

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Wait for subagent outputs
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, acceptance criteria from Step 1, test strategy from Step 3
- Focus: orchestration only (mode selection + worker dispatch)
- Limits: do not generate tests directly (delegate to worker steps)
- Dependencies: Steps 1-3 outputs

---

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Prepare Execution Context

**Generate unique timestamp** for temp file naming:

```javascript
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
```

**Prepare input context for both subagents:**

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
  story_acceptance_criteria: /* from Step 1 */,
  test_strategy: /* from Step 3 */,
  knowledge_fragments_loaded: /* list of fragments */,
  config: {
    test_framework: config.test_framework,
    use_playwright_utils: config.tea_use_playwright_utils,
    browser_automation: config.tea_browser_automation,
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
  subagent: runtime.canLaunchSubagents?.() === true,
  agentTeam: runtime.canLaunchAgentTeams?.() === true,
};

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

if (!probeEnabled && (requestedMode === "agent-team" || requestedMode === "subagent")) {
  const unsupportedRequestedMode =
    (requestedMode === "agent-team" && !supports.agentTeam) ||
    (requestedMode === "subagent" && !supports.subagent);

  if (unsupportedRequestedMode) {
    subagentContext.execution.error = `Requested execution mode "${requestedMode}" is unavailable because capability probing is disabled.`;
    throw new Error(subagentContext.execution.error);
  }
}
```

Resolution precedence:

1. Explicit user request in this run (`agent team` => `agent-team`; `subagent` => `subagent`; `sequential`; `auto`)
2. `tea_execution_mode` from config
3. Runtime capability fallback (when probing enabled)

If probing is disabled, honor the requested mode strictly. If that mode cannot be executed at runtime, fail with explicit error instead of silent fallback.

---

### 3. Dispatch Worker A: Failing API Test Generation

**Dispatch worker:**

- **Subagent File:** `./step-04a-subagent-api-failing.md`
- **Output File:** `/tmp/tea-atdd-api-tests-${timestamp}.json`
- **Context:** Pass `subagentContext`
- **Execution:**
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait before next dispatch
- **TDD Phase:** RED (failing tests)

**System Action:**

```
🚀 Launching Subagent A: FAILING API Test Generation (RED PHASE)
📝 Output: /tmp/tea-atdd-api-tests-${timestamp}.json
⚙️ Mode: ${resolvedMode}
🔴 TDD Phase: RED (tests will fail until feature implemented)
⏳ Status: Running...
```

---

### 4. Dispatch Worker B: Failing E2E Test Generation

**Dispatch worker:**

- **Subagent File:** `./step-04b-subagent-e2e-failing.md`
- **Output File:** `/tmp/tea-atdd-e2e-tests-${timestamp}.json`
- **Context:** Pass `subagentContext`
- **Execution:**
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait before next dispatch
- **TDD Phase:** RED (failing tests)

**System Action:**

```
🚀 Launching Subagent B: FAILING E2E Test Generation (RED PHASE)
📝 Output: /tmp/tea-atdd-e2e-tests-${timestamp}.json
⚙️ Mode: ${resolvedMode}
🔴 TDD Phase: RED (tests will fail until feature implemented)
⏳ Status: Running...
```

---

### 5. Wait for Required Worker Completion

**If `resolvedMode` is `agent-team` or `subagent`:**

```
⏳ Waiting for subagents to complete...
  ├── Subagent A (API RED): Running... ⟳
  └── Subagent B (E2E RED): Running... ⟳

[... time passes ...]

  ├── Subagent A (API RED): Complete ✅
  └── Subagent B (E2E RED): Complete ✅

✅ All subagents completed successfully!
```

**If `resolvedMode` is `sequential`:**

```
✅ Sequential mode: each worker already completed during dispatch.
```

**Verify both outputs exist:**

```javascript
const apiOutputExists = fs.existsSync(`/tmp/tea-atdd-api-tests-${timestamp}.json`);
const e2eOutputExists = fs.existsSync(`/tmp/tea-atdd-e2e-tests-${timestamp}.json`);

if (!apiOutputExists || !e2eOutputExists) {
  throw new Error("One or both subagent outputs missing!");
}
```

---

### 6. TDD Red Phase Report

**Display TDD status:**

```
🔴 TDD RED PHASE: Failing Tests Generated

✅ Both subagents completed:
- API Tests: Generated with test.skip()
- E2E Tests: Generated with test.skip()

📋 All tests assert EXPECTED behavior
📋 All tests will FAIL until feature implemented
📋 This is INTENTIONAL (TDD red phase)

Next: Aggregation will verify TDD compliance
```

---

### 7. Execution Report

**Display performance metrics:**

```
🚀 Performance Report:
- Execution Mode: {resolvedMode}
- API Test Generation: ~X minutes
- E2E Test Generation: ~Y minutes
- Total Elapsed: ~mode-dependent
- Parallel Gain: ~50% faster when mode is subagent/agent-team
```

---

### 8. Proceed to Aggregation

**Load aggregation step:**
Load next step: `{nextStepFile}`

The aggregation step (4C) will:

- Read both subagent outputs
- Verify TDD red phase compliance (all tests have test.skip())
- Write all test files to disk
- Generate ATDD checklist
- Calculate summary statistics

---

## EXIT CONDITION

Proceed to Step 4C (Aggregation) when:

- ✅ Subagent A (API failing tests) completed successfully
- ✅ Subagent B (E2E failing tests) completed successfully
- ✅ Both output files exist and are valid JSON
- ✅ TDD red phase status reported

**Do NOT proceed if:**

- ❌ One or both subagents failed
- ❌ Output files missing or corrupted
- ❌ Subagent generated passing tests (wrong - must be failing)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Both subagents launched successfully
- Both worker steps completed without errors
- Output files generated and valid
- Tests generated with test.skip() (TDD red phase)
- Fallback behavior respected configuration and capability probe rules

### ❌ SYSTEM FAILURE:

- Failed to launch subagents
- One or both subagents failed
- Output files missing or invalid
- Tests generated without test.skip() (wrong phase)
- Unsupported requested mode with probing disabled

**Master Rule:** TDD RED PHASE requires FAILING tests (with test.skip()). Mode selection changes orchestration, never red-phase requirements.
