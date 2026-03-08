---
name: "step-04-analyze-gaps"
description: "Complete Phase 1 with adaptive orchestration (agent-team, subagent, or sequential)"
nextStepFile: "./step-05-gate-decision.md"
outputFile: "{test_artifacts}/traceability-report.md"
tempOutputFile: "/tmp/tea-trace-coverage-matrix-{{timestamp}}.json"
---

# Step 4: Complete Phase 1 - Coverage Matrix Generation

## STEP GOAL

**Phase 1 Final Step:** Analyze coverage gaps (including endpoint/auth/error-path blind spots), generate recommendations, and output complete coverage matrix to temp file for Phase 2 (gate decision).

---

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Output coverage matrix to temp file
- ✅ Resolve execution mode from explicit user request first, then config
- ✅ Apply fallback rules deterministically when requested mode is unsupported
- ❌ Do NOT make gate decision (that's Phase 2 - Step 5)

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: requirements from Step 1, tests from Step 2, traceability matrix from Step 3
- Focus: gap analysis and matrix completion
- Limits: do not make gate decision (Phase 2 responsibility)

---

## MANDATORY SEQUENCE

### 0. Resolve Execution Mode (User Override First)

```javascript
const parseBooleanFlag = (value, defaultValue = true) => {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["false", "0", "off", "no"].includes(normalized)) return false;
    if (["true", "1", "on", "yes"].includes(normalized)) return true;
  }
  if (value === undefined || value === null) return defaultValue;
  return Boolean(value);
};

const orchestrationContext = {
  config: {
    execution_mode: config.tea_execution_mode || "auto", // "auto" | "subagent" | "agent-team" | "sequential"
    capability_probe: parseBooleanFlag(config.tea_capability_probe, true), // supports booleans and "false"/"true" strings
  },
  timestamp: new Date().toISOString().replace(/[:.]/g, "-"),
};

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
  normalizeConfigExecutionMode(orchestrationContext.config.execution_mode) ||
  "auto";
const probeEnabled = orchestrationContext.config.capability_probe;

const supports = { subagent: false, agentTeam: false };
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
```

Resolution precedence:

1. Explicit user request in this run (`agent team` => `agent-team`; `subagent` => `subagent`; `sequential`; `auto`)
2. `tea_execution_mode` from config
3. Runtime capability fallback (when probing enabled)

### 1. Gap Analysis

**Identify uncovered requirements:**

```javascript
const uncoveredRequirements = traceabilityMatrix.filter((req) => req.coverage === "NONE");
const partialCoverage = traceabilityMatrix.filter((req) => req.coverage === "PARTIAL");
const unitOnlyCoverage = traceabilityMatrix.filter((req) => req.coverage === "UNIT-ONLY");
```

**Prioritize gaps by risk:**

```javascript
const criticalGaps = uncoveredRequirements.filter((req) => req.priority === "P0");
const highGaps = uncoveredRequirements.filter((req) => req.priority === "P1");
const mediumGaps = uncoveredRequirements.filter((req) => req.priority === "P2");
const lowGaps = uncoveredRequirements.filter((req) => req.priority === "P3");
```

---

### 2. Coverage Heuristics Checks

Use the heuristics inventory from Step 2 and mapped criteria from Step 3 to flag common coverage blind spots:

```javascript
const endpointCoverageGaps = coverageHeuristics?.endpoints_without_tests || [];
const authCoverageGaps = coverageHeuristics?.auth_missing_negative_paths || [];
const errorPathGaps = coverageHeuristics?.criteria_happy_path_only || [];

const heuristicGapCounts = {
  endpoints_without_tests: endpointCoverageGaps.length,
  auth_missing_negative_paths: authCoverageGaps.length,
  happy_path_only_criteria: errorPathGaps.length,
};
```

Heuristics are advisory but must influence gap severity and recommendations, especially for P0/P1 criteria.

---

### 3. Generate Recommendations

**Based on gap analysis:**

```javascript
const recommendations = [];

// Critical gaps (P0)
if (criticalGaps.length > 0) {
  recommendations.push({
    priority: "URGENT",
    action: `Run /bmad:tea:atdd for ${criticalGaps.length} P0 requirements`,
    requirements: criticalGaps.map((r) => r.id),
  });
}

// High priority gaps (P1)
if (highGaps.length > 0) {
  recommendations.push({
    priority: "HIGH",
    action: `Run /bmad:tea:automate to expand coverage for ${highGaps.length} P1 requirements`,
    requirements: highGaps.map((r) => r.id),
  });
}

// Partial coverage
if (partialCoverage.length > 0) {
  recommendations.push({
    priority: "MEDIUM",
    action: `Complete coverage for ${partialCoverage.length} partially covered requirements`,
    requirements: partialCoverage.map((r) => r.id),
  });
}

if (endpointCoverageGaps.length > 0) {
  recommendations.push({
    priority: "HIGH",
    action: `Add API tests for ${endpointCoverageGaps.length} uncovered endpoint(s)`,
    requirements: endpointCoverageGaps.map((r) => r.id || r.endpoint || "unknown"),
  });
}

if (authCoverageGaps.length > 0) {
  recommendations.push({
    priority: "HIGH",
    action: `Add negative-path auth/authz tests for ${authCoverageGaps.length} requirement(s)`,
    requirements: authCoverageGaps.map((r) => r.id || "unknown"),
  });
}

if (errorPathGaps.length > 0) {
  recommendations.push({
    priority: "MEDIUM",
    action: `Add error/edge scenario tests for ${errorPathGaps.length} happy-path-only criterion/criteria`,
    requirements: errorPathGaps.map((r) => r.id || "unknown"),
  });
}

// Quality issues
recommendations.push({
  priority: "LOW",
  action: "Run /bmad:tea:test-review to assess test quality",
  requirements: [],
});
```

---

### 4. Calculate Coverage Statistics

```javascript
const totalRequirements = traceabilityMatrix.length;
const coveredRequirements = traceabilityMatrix.filter(
  (r) => r.coverage === "FULL" || r.coverage === "PARTIAL",
).length;
const fullyCovered = traceabilityMatrix.filter((r) => r.coverage === "FULL").length;

const safePct = (covered, total) => (total > 0 ? Math.round((covered / total) * 100) : 100);
const coveragePercentage = safePct(fullyCovered, totalRequirements);

// Priority-specific coverage
const p0Total = traceabilityMatrix.filter((r) => r.priority === "P0").length;
const p0Covered = traceabilityMatrix.filter(
  (r) => r.priority === "P0" && r.coverage === "FULL",
).length;
const p1Total = traceabilityMatrix.filter((r) => r.priority === "P1").length;
const p1Covered = traceabilityMatrix.filter(
  (r) => r.priority === "P1" && r.coverage === "FULL",
).length;
const p2Total = traceabilityMatrix.filter((r) => r.priority === "P2").length;
const p2Covered = traceabilityMatrix.filter(
  (r) => r.priority === "P2" && r.coverage === "FULL",
).length;
const p3Total = traceabilityMatrix.filter((r) => r.priority === "P3").length;
const p3Covered = traceabilityMatrix.filter(
  (r) => r.priority === "P3" && r.coverage === "FULL",
).length;

const p0CoveragePercentage = safePct(p0Covered, p0Total);
const p1CoveragePercentage = safePct(p1Covered, p1Total);
const p2CoveragePercentage = safePct(p2Covered, p2Total);
const p3CoveragePercentage = safePct(p3Covered, p3Total);
```

---

### 5. Generate Complete Coverage Matrix

**Compile all Phase 1 outputs:**

```javascript
const coverageMatrix = {
  phase: "PHASE_1_COMPLETE",
  generated_at: new Date().toISOString(),

  requirements: traceabilityMatrix, // Full matrix from Step 3

  coverage_statistics: {
    total_requirements: totalRequirements,
    fully_covered: fullyCovered,
    partially_covered: partialCoverage.length,
    uncovered: uncoveredRequirements.length,
    overall_coverage_percentage: coveragePercentage,

    priority_breakdown: {
      P0: { total: p0Total, covered: p0Covered, percentage: p0CoveragePercentage },
      P1: { total: p1Total, covered: p1Covered, percentage: p1CoveragePercentage },
      P2: { total: p2Total, covered: p2Covered, percentage: p2CoveragePercentage },
      P3: { total: p3Total, covered: p3Covered, percentage: p3CoveragePercentage },
    },
  },

  gap_analysis: {
    critical_gaps: criticalGaps,
    high_gaps: highGaps,
    medium_gaps: mediumGaps,
    low_gaps: lowGaps,
    partial_coverage_items: partialCoverage,
    unit_only_items: unitOnlyCoverage,
  },

  coverage_heuristics: {
    endpoint_gaps: endpointCoverageGaps,
    auth_negative_path_gaps: authCoverageGaps,
    happy_path_only_gaps: errorPathGaps,
    counts: heuristicGapCounts,
  },

  recommendations: recommendations,
};
```

---

### 6. Output Coverage Matrix to Temp File

**Write to temp file for Phase 2:**

```javascript
const outputPath = "{tempOutputFile}";
fs.writeFileSync(outputPath, JSON.stringify(coverageMatrix, null, 2), "utf8");

console.log(`✅ Phase 1 Complete: Coverage matrix saved to ${outputPath}`);
```

---

### 7. Display Phase 1 Summary

```
✅ Phase 1 Complete: Coverage Matrix Generated

📊 Coverage Statistics:
- Total Requirements: {totalRequirements}
- Fully Covered: {fullyCovered} ({coveragePercentage}%)
- Partially Covered: {partialCoverage.length}
- Uncovered: {uncoveredRequirements.length}

🎯 Priority Coverage:
- P0: {p0Covered}/{p0Total} ({p0CoveragePercentage}%)
- P1: {p1Covered}/{p1Total} ({p1CoveragePercentage}%)
- P2: {p2Covered}/{p2Total} ({p2CoveragePercentage}%)
- P3: {p3Covered}/{p3Total} ({p3CoveragePercentage}%)

⚠️ Gaps Identified:
- Critical (P0): {criticalGaps.length}
- High (P1): {highGaps.length}
- Medium (P2): {mediumGaps.length}
- Low (P3): {lowGaps.length}

🔍 Coverage Heuristics:
- Endpoints without tests: {endpointCoverageGaps.length}
- Auth negative-path gaps: {authCoverageGaps.length}
- Happy-path-only criteria: {errorPathGaps.length}

📝 Recommendations: {recommendations.length}

🔄 Phase 2: Gate decision (next step)
```

### Orchestration Notes for This Step

When `resolvedMode` is `agent-team` or `subagent`, parallelize only dependency-safe sections:

- Worker A: gap classification (section 1)
- Worker B: heuristics gap extraction (section 2)
- Worker C: coverage statistics (section 4)

Section 3 (recommendation synthesis) depends on outputs from sections 1 and 2, so run it only after Workers A and B complete.

Section 5 remains the deterministic merge point after sections 1-4 are finished.

If `resolvedMode` is `sequential`, execute sections 1→7 in order.

---

## EXIT CONDITION

**PHASE 1 COMPLETE when:**

- ✅ Gap analysis complete
- ✅ Recommendations generated
- ✅ Coverage statistics calculated
- ✅ Coverage matrix saved to temp file
- ✅ Summary displayed

**Proceed to Phase 2 (Step 5: Gate Decision)**

---

### 8. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-04-analyze-gaps"]
  lastStep: "step-04-analyze-gaps"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-04-analyze-gaps'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-04-analyze-gaps'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

---

## 🚨 PHASE 1 SUCCESS METRICS

### ✅ SUCCESS:

- Coverage matrix complete and accurate
- All gaps identified and prioritized
- Recommendations actionable
- Temp file output valid JSON

### ❌ FAILURE:

- Coverage matrix incomplete
- Gap analysis missing
- Invalid JSON output

**Master Rule:** Phase 1 MUST output complete coverage matrix to temp file before Phase 2 can proceed.
