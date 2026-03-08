---
name: "step-05-gate-decision"
description: "Phase 2: Apply gate decision logic and generate outputs"
outputFile: "{test_artifacts}/traceability-report.md"
---

# Step 5: Phase 2 - Gate Decision

## STEP GOAL

**Phase 2:** Read coverage matrix from Phase 1, apply deterministic gate decision logic, and generate traceability report.

---

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Read coverage matrix from Phase 1 temp file
- ✅ Apply gate decision logic
- ❌ Do NOT regenerate coverage matrix (use Phase 1 output)

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 This is the FINAL step

## CONTEXT BOUNDARIES:

- Available context: Coverage matrix from Phase 1 temp file
- Focus: gate decision logic only
- Dependencies: Phase 1 complete (coverage matrix exists)

---

## MANDATORY SEQUENCE

### 1. Read Phase 1 Coverage Matrix

```javascript
const matrixPath = "/tmp/tea-trace-coverage-matrix-{{timestamp}}.json";
const coverageMatrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));

console.log("✅ Phase 1 coverage matrix loaded");
```

**Verify Phase 1 complete:**

```javascript
if (coverageMatrix.phase !== "PHASE_1_COMPLETE") {
  throw new Error("Phase 1 not complete - cannot proceed to gate decision");
}
```

---

### 2. Apply Gate Decision Logic

**Decision Tree:**

```javascript
const stats = coverageMatrix.coverage_statistics;
const p0Coverage = stats.priority_breakdown.P0.percentage;
const p1Coverage = stats.priority_breakdown.P1.percentage;
const hasP1Requirements = (stats.priority_breakdown.P1.total || 0) > 0;
const effectiveP1Coverage = hasP1Requirements ? p1Coverage : 100;
const overallCoverage = stats.overall_coverage_percentage;
const criticalGaps = coverageMatrix.gap_analysis.critical_gaps.length;

let gateDecision;
let rationale;

// Rule 1: P0 coverage must be 100%
if (p0Coverage < 100) {
  gateDecision = "FAIL";
  rationale = `P0 coverage is ${p0Coverage}% (required: 100%). ${criticalGaps} critical requirements uncovered.`;
}
// Rule 2: Overall coverage must be >= 80%
else if (overallCoverage < 80) {
  gateDecision = "FAIL";
  rationale = `Overall coverage is ${overallCoverage}% (minimum: 80%). Significant gaps exist.`;
}
// Rule 3: P1 coverage < 80% → FAIL
else if (effectiveP1Coverage < 80) {
  gateDecision = "FAIL";
  rationale = hasP1Requirements
    ? `P1 coverage is ${effectiveP1Coverage}% (minimum: 80%). High-priority gaps must be addressed.`
    : `P1 requirements are not present; continuing with remaining gate criteria.`;
}
// Rule 4: P1 coverage >= 90% and overall >= 80% with P0 at 100% → PASS
else if (effectiveP1Coverage >= 90) {
  gateDecision = "PASS";
  rationale = hasP1Requirements
    ? `P0 coverage is 100%, P1 coverage is ${effectiveP1Coverage}% (target: 90%), and overall coverage is ${overallCoverage}% (minimum: 80%).`
    : `P0 coverage is 100% and overall coverage is ${overallCoverage}% (minimum: 80%). No P1 requirements detected.`;
}
// Rule 5: P1 coverage 80-89% with P0 at 100% and overall >= 80% → CONCERNS
else if (effectiveP1Coverage >= 80) {
  gateDecision = "CONCERNS";
  rationale = hasP1Requirements
    ? `P0 coverage is 100% and overall coverage is ${overallCoverage}% (minimum: 80%), but P1 coverage is ${effectiveP1Coverage}% (target: 90%).`
    : `P0 coverage is 100% and overall coverage is ${overallCoverage}% (minimum: 80%), but additional non-P1 gaps need mitigation.`;
}

// Rule 6: Manual waiver option
const manualWaiver = false; // Can be set via config or user input
if (manualWaiver) {
  gateDecision = "WAIVED";
  rationale += " Manual waiver applied by stakeholder.";
}
```

---

### 3. Generate Gate Report

```javascript
const gateReport = {
  decision: gateDecision,
  rationale: rationale,
  decision_date: new Date().toISOString(),

  coverage_matrix: coverageMatrix,

  gate_criteria: {
    p0_coverage_required: "100%",
    p0_coverage_actual: `${p0Coverage}%`,
    p0_status: p0Coverage === 100 ? "MET" : "NOT MET",

    p1_coverage_target_pass: "90%",
    p1_coverage_minimum: "80%",
    p1_coverage_actual: `${effectiveP1Coverage}%`,
    p1_status:
      effectiveP1Coverage >= 90 ? "MET" : effectiveP1Coverage >= 80 ? "PARTIAL" : "NOT MET",

    overall_coverage_minimum: "80%",
    overall_coverage_actual: `${overallCoverage}%`,
    overall_status: overallCoverage >= 80 ? "MET" : "NOT MET",
  },

  uncovered_requirements: coverageMatrix.gap_analysis.critical_gaps.concat(
    coverageMatrix.gap_analysis.high_gaps,
  ),

  recommendations: coverageMatrix.recommendations,
};
```

---

### 4. Generate Traceability Report

**Use trace-template.md to generate:**

```markdown
# Traceability Report

## Gate Decision: {gateDecision}

**Rationale:** {rationale}

## Coverage Summary

- Total Requirements: {totalRequirements}
- Covered: {fullyCovered} ({coveragePercentage}%)
- P0 Coverage: {p0CoveragePercentage}%

## Traceability Matrix

[Full matrix with requirement → test mappings]

## Gaps & Recommendations

[List of uncovered requirements with recommended actions]

## Next Actions

{recommendations}
```

**Save to:**

```javascript
fs.writeFileSync("{outputFile}", reportContent, "utf8");
```

---

### 5. Display Gate Decision

```
🚨 GATE DECISION: {gateDecision}

📊 Coverage Analysis:
- P0 Coverage: {p0Coverage}% (Required: 100%) → {p0_status}
- P1 Coverage: {effectiveP1Coverage}% (PASS target: 90%, minimum: 80%) → {p1_status}
- Overall Coverage: {overallCoverage}% (Minimum: 80%) → {overall_status}

✅ Decision Rationale:
{rationale}

⚠️ Critical Gaps: {criticalGaps.length}

📝 Recommended Actions:
{list top 3 recommendations}

📂 Full Report: {outputFile}

{if FAIL}
🚫 GATE: FAIL - Release BLOCKED until coverage improves
{endif}

{if CONCERNS}
⚠️ GATE: CONCERNS - Proceed with caution, address gaps soon
{endif}

{if PASS}
✅ GATE: PASS - Release approved, coverage meets standards
{endif}
```

---

### 6. Save Progress

**Update the YAML frontmatter in `{outputFile}` to mark this final step complete.**

Since step 4 (Generate Traceability Report) already wrote the report content to `{outputFile}`, do NOT overwrite it. Instead, update only the frontmatter at the top of the existing file:

- Add `'step-05-gate-decision'` to `stepsCompleted` array (only if not already present)
- Set `lastStep: 'step-05-gate-decision'`
- Set `lastSaved: '{date}'`

Then append the gate decision summary (from section 5 above) to the end of the existing report content.

---

## EXIT CONDITION

**WORKFLOW COMPLETE when:**

- ✅ Phase 1 coverage matrix read successfully
- ✅ Gate decision logic applied
- ✅ Traceability report generated
- ✅ Gate decision displayed

**Workflow terminates here.**

---

## 🚨 PHASE 2 SUCCESS METRICS

### ✅ SUCCESS:

- Coverage matrix read from Phase 1
- Gate decision made with clear rationale
- Report generated and saved
- Decision communicated clearly

### ❌ FAILURE:

- Could not read Phase 1 matrix
- Gate decision logic incorrect
- Report missing or incomplete

**Master Rule:** Gate decision MUST be deterministic based on clear criteria (P0 100%, P1 90/80, overall >=80).
