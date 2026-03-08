---
name: "step-03-generate-tests"
description: "Orchestrate adaptive test generation (agent-team, subagent, or sequential)"
nextStepFile: "./step-03c-aggregate.md"
---

# Step 3: Orchestrate Adaptive Test Generation

## STEP GOAL

Select execution mode deterministically, then generate tests using agent-team, subagent, or sequential execution while preserving the same output contract. Worker selection depends on `{detected_stack}`.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Resolve execution mode from config (`tea_execution_mode`, `tea_capability_probe`)
- ✅ Apply fallback rules deterministically when requested mode is unsupported
- ✅ Preserve output schema and temp file naming across all modes
- ❌ Do NOT skip capability checks when probing is enabled
- ❌ Do NOT change output paths or JSON schema by mode

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Wait for subagent outputs
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, coverage plan from Step 2, knowledge fragments
- Focus: orchestration only (mode selection + worker dispatch)
- Limits: do not generate tests directly (delegate to worker steps)
- Dependencies: Step 2 outputs (coverage plan, target features)

---

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Prepare Execution Context

**Generate unique timestamp** for temp file naming:

```javascript
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
```

**Prepare input context for subagents:**

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
  features: /* from Step 2 coverage plan */,
  knowledge_fragments_loaded: /* list of fragments */,
  config: {
    test_framework: config.test_framework,
    use_playwright_utils: config.tea_use_playwright_utils,
    use_pactjs_utils: config.tea_use_pactjs_utils,
    pact_mcp: config.tea_pact_mcp,  // "mcp" | "none"
    browser_automation: config.tea_browser_automation,  // "auto" | "cli" | "mcp" | "none"
    detected_stack: '{detected_stack}',  // "frontend" | "backend" | "fullstack"
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
  // Probe using runtime-native capability checks or a no-op launch test.
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

Report selected mode before dispatch:

```
⚙️ Execution Mode Resolution:
- Requested: {requestedMode}
- Probe Enabled: {probeEnabled}
- Supports agent-team: {supports.agentTeam}
- Supports subagent: {supports.subagent}
- Resolved: {resolvedMode}
```

---

### 3. Subagent Dispatch Matrix

**Select subagents based on `{detected_stack}`:**

| `{detected_stack}` | Subagent A (API) | Subagent B (E2E) | Subagent B-backend |
| ------------------ | ---------------- | ---------------- | ------------------ |
| `frontend`         | Launch           | Launch           | Skip               |
| `backend`          | Launch           | Skip             | Launch             |
| `fullstack`        | Launch           | Launch           | Launch             |

### 3A. Runtime-Managed Parallelism

When `resolvedMode` is `agent-team` or `subagent`, let the runtime decide concurrency and scheduling. TEA does not impose an additional worker ceiling.

---

### Contract Test Generation Note

When `use_pactjs_utils` is enabled, the API test generation subagent (step-03a) also generates:

- **Consumer contract tests**: Using `createProviderState` for type-safe provider states
- **Provider verification tests**: Using `buildVerifierOptions` for one-call verifier setup
- **Message contract tests**: Using `buildMessageVerifierOptions` if async/Kafka patterns detected
- **Helper files**: Request filter setup with `createRequestFilter`, shared state constants

When `pact_mcp` is `"mcp"`, the subagent can use SmartBear MCP tools to fetch existing provider states and generate tests informed by broker data.

---

### 4. Dispatch Worker A: API Test Generation (always)

**Dispatch worker:**

- **Subagent File:** `./step-03a-subagent-api.md`
- **Output File:** `/tmp/tea-automate-api-tests-${timestamp}.json`
- **Context:** Pass `subagentContext`
- **Execution:**
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait before next dispatch

**System Action:**

```
🚀 Launching Subagent A: API Test Generation
📝 Output: /tmp/tea-automate-api-tests-${timestamp}.json
⚙️ Mode: ${resolvedMode}
⏳ Status: Running...
```

---

### 5. Dispatch Worker B: E2E Test Generation (frontend/fullstack only)

**If {detected_stack} is `frontend` or `fullstack`:**

**Dispatch worker:**

- **Subagent File:** `./step-03b-subagent-e2e.md`
- **Output File:** `/tmp/tea-automate-e2e-tests-${timestamp}.json`
- **Context:** Pass `subagentContext`
- **Execution:**
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait before next dispatch

**System Action:**

```
🚀 Launching Subagent B: E2E Test Generation
📝 Output: /tmp/tea-automate-e2e-tests-${timestamp}.json
⚙️ Mode: ${resolvedMode}
⏳ Status: Running...
```

**If {detected_stack} is `backend`:** Skip this subagent.

---

### 6. Dispatch Worker B-backend: Backend Test Generation (backend/fullstack only)

**If {detected_stack} is `backend` or `fullstack`:**

**Dispatch worker:**

- **Subagent File:** `./step-03b-subagent-backend.md`
- **Output File:** `/tmp/tea-automate-backend-tests-${timestamp}.json`
- **Context:** Pass `subagentContext`
- **Execution:**
  - `agent-team` or `subagent`: launch non-blocking
  - `sequential`: run blocking and wait before next dispatch

**System Action:**

```
🚀 Launching Subagent B-backend: Backend Test Generation
📝 Output: /tmp/tea-automate-backend-tests-${timestamp}.json
⚙️ Mode: ${resolvedMode}
⏳ Status: Running...
```

**If {detected_stack} is `frontend`:** Skip this subagent.

---

### 7. Wait for Expected Worker Completion

**If `resolvedMode` is `agent-team` or `subagent`:**

```
⏳ Waiting for subagents to complete...
  ├── Subagent A (API): Running... ⟳
  ├── Subagent B (E2E): Running... ⟳       [if frontend/fullstack]
  └── Subagent B-backend: Running... ⟳     [if backend/fullstack]

[... time passes ...]

  ├── Subagent A (API): Complete ✅
  ├── Subagent B (E2E): Complete ✅         [if frontend/fullstack]
  └── Subagent B-backend: Complete ✅       [if backend/fullstack]

✅ All subagents completed successfully!
```

**If `resolvedMode` is `sequential`:**

```
✅ Sequential mode: each worker already completed during dispatch.
```

**Verify outputs exist (based on `{detected_stack}`):**

```javascript
const apiOutputExists = fs.existsSync(`/tmp/tea-automate-api-tests-${timestamp}.json`);

// Check based on detected_stack
if (detected_stack === "frontend" || detected_stack === "fullstack") {
  const e2eOutputExists = fs.existsSync(`/tmp/tea-automate-e2e-tests-${timestamp}.json`);
  if (!e2eOutputExists) throw new Error("E2E subagent output missing!");
}
if (detected_stack === "backend" || detected_stack === "fullstack") {
  const backendOutputExists = fs.existsSync(`/tmp/tea-automate-backend-tests-${timestamp}.json`);
  if (!backendOutputExists) throw new Error("Backend subagent output missing!");
}
if (!apiOutputExists) throw new Error("API subagent output missing!");
```

---

### Subagent Output Schema Contract

The aggregate step expects both outputs to include `success`, but the payload shapes are intentionally different:

- `step-03b-subagent-e2e.md` output includes `success`, `subagent`, `tests`, `fixture_needs`, `knowledge_fragments_used`, `test_count`, and `summary`.
- `step-03b-subagent-backend.md` output includes `success`, `subagent`, `subagentType`, `testsGenerated`, `coverageSummary` (with `fixtureNeeds`), `status`, `knowledge_fragments_used`, and `summary`.

The aggregate step reads whichever output file(s) exist based on `{detected_stack}` and must use the matching schema per subagent type.

---

### 8. Execution Report

**Display performance metrics:**

```
🚀 Performance Report:
- Execution Mode: {resolvedMode}
- Stack Type: {detected_stack}
- API Test Generation: ~X minutes
- E2E Test Generation: ~Y minutes       [if frontend/fullstack]
- Backend Test Generation: ~Z minutes    [if backend/fullstack]
- Total Elapsed: ~mode-dependent
- Parallel Gain: ~40-70% faster when mode is subagent/agent-team
```

---

### 9. Proceed to Aggregation

**Load aggregation step:**
Load next step: `{nextStepFile}`

The aggregation step (3C) will:

- Read all subagent outputs (based on `{detected_stack}`)
- Write all test files to disk
- Generate shared fixtures and helpers
- Calculate summary statistics

---

## EXIT CONDITION

Proceed to Step 3C (Aggregation) when:

- ✅ Subagent A (API tests) completed successfully
- ✅ Subagent B (E2E tests) completed successfully [if frontend/fullstack]
- ✅ Subagent B-backend (Backend tests) completed successfully [if backend/fullstack]
- ✅ All expected output files exist and are valid JSON
- ✅ Execution metrics displayed

**Do NOT proceed if:**

- ❌ Any launched subagent failed
- ❌ Output files missing or corrupted
- ❌ Timeout occurred (parallel mode only)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- All required subagents launched successfully (based on `{detected_stack}`)
- All required worker steps completed without errors
- Output files generated and valid
- Fallback behavior respected configuration and capability probe rules

### ❌ SYSTEM FAILURE:

- Failed to launch subagents
- One or more subagents failed
- Output files missing or invalid
- Unsupported requested mode with probing disabled

**Master Rule:** Deterministic mode selection + stable output contract. Use the best supported mode, then aggregate normally.
