---
name: "step-03f-aggregate-scores"
description: "Aggregate quality dimension scores into overall 0-100 score"
nextStepFile: "./step-04-generate-report.md"
outputFile: "{test_artifacts}/test-review.md"
---

# Step 3F: Aggregate Quality Scores

## STEP GOAL

Read outputs from 4 quality subagents, calculate weighted overall score (0-100), and aggregate violations for report generation.

---

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- ✅ Read all 4 subagent outputs
- ✅ Calculate weighted overall score
- ✅ Aggregate violations by severity
- ❌ Do NOT re-evaluate quality (use subagent outputs)

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

---

## MANDATORY SEQUENCE

### 1. Read All Subagent Outputs

```javascript
// Use the SAME timestamp generated in Step 3 (do not regenerate).
const timestamp = subagentContext?.timestamp;
if (!timestamp) {
  throw new Error("Missing timestamp from Step 3 context. Pass Step 3 timestamp into Step 3F.");
}
const dimensions = ["determinism", "isolation", "maintainability", "performance"];
const results = {};

dimensions.forEach((dim) => {
  const outputPath = `/tmp/tea-test-review-${dim}-${timestamp}.json`;
  results[dim] = JSON.parse(fs.readFileSync(outputPath, "utf8"));
});
```

**Verify all succeeded:**

```javascript
const allSucceeded = dimensions.every((dim) => results[dim].score !== undefined);
if (!allSucceeded) {
  throw new Error("One or more quality subagents failed!");
}
```

---

### 2. Calculate Weighted Overall Score

**Dimension Weights** (based on TEA quality priorities):

```javascript
const weights = {
  determinism: 0.3, // 30% - Reliability and flake prevention
  isolation: 0.3, // 30% - Parallel safety and independence
  maintainability: 0.25, // 25% - Readability and long-term health
  performance: 0.15, // 15% - Speed and execution efficiency
};
```

**Calculate overall score:**

```javascript
const overallScore = dimensions.reduce((sum, dim) => {
  return sum + results[dim].score * weights[dim];
}, 0);

const roundedScore = Math.round(overallScore);
```

**Determine grade:**

```javascript
const getGrade = (score) => {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
};

const overallGrade = getGrade(roundedScore);
```

---

### 3. Aggregate Violations by Severity

**Collect all violations from all dimensions:**

```javascript
const allViolations = dimensions.flatMap((dim) =>
  results[dim].violations.map((v) => ({
    ...v,
    dimension: dim,
  })),
);

// Group by severity
const highSeverity = allViolations.filter((v) => v.severity === "HIGH");
const mediumSeverity = allViolations.filter((v) => v.severity === "MEDIUM");
const lowSeverity = allViolations.filter((v) => v.severity === "LOW");

const violationSummary = {
  total: allViolations.length,
  HIGH: highSeverity.length,
  MEDIUM: mediumSeverity.length,
  LOW: lowSeverity.length,
};
```

---

### 4. Prioritize Recommendations

**Extract recommendations from all dimensions:**

```javascript
const allRecommendations = dimensions.flatMap((dim) =>
  results[dim].recommendations.map((rec) => ({
    dimension: dim,
    recommendation: rec,
    impact: results[dim].score < 70 ? "HIGH" : "MEDIUM",
  })),
);

// Sort by impact (HIGH first)
const prioritizedRecommendations = allRecommendations
  .sort((a, b) => (a.impact === "HIGH" ? -1 : 1))
  .slice(0, 10); // Top 10 recommendations
```

---

### 5. Create Review Summary Object

**Aggregate all results:**

```javascript
const reviewSummary = {
  overall_score: roundedScore,
  overall_grade: overallGrade,
  quality_assessment: getQualityAssessment(roundedScore),

  dimension_scores: {
    determinism: results.determinism.score,
    isolation: results.isolation.score,
    maintainability: results.maintainability.score,
    performance: results.performance.score,
  },

  dimension_grades: {
    determinism: results.determinism.grade,
    isolation: results.isolation.grade,
    maintainability: results.maintainability.grade,
    performance: results.performance.grade,
  },

  violations_summary: violationSummary,

  all_violations: allViolations,

  high_severity_violations: highSeverity,

  top_10_recommendations: prioritizedRecommendations,

  subagent_execution: "PARALLEL (4 quality dimensions)",
  performance_gain: "~60% faster than sequential",
};

// Save for Step 4 (report generation)
fs.writeFileSync(
  `/tmp/tea-test-review-summary-${timestamp}.json`,
  JSON.stringify(reviewSummary, null, 2),
  "utf8",
);
```

---

### 6. Display Summary to User

```
✅ Quality Evaluation Complete (Parallel Execution)

📊 Overall Quality Score: {roundedScore}/100 (Grade: {overallGrade})

📈 Dimension Scores:
- Determinism:      {determinism_score}/100 ({determinism_grade})
- Isolation:        {isolation_score}/100 ({isolation_grade})
- Maintainability:  {maintainability_score}/100 ({maintainability_grade})
- Performance:      {performance_score}/100 ({performance_grade})

ℹ️ Coverage is excluded from `test-review` scoring. Use `trace` for coverage analysis and gates.

⚠️ Violations Found:
- HIGH:   {high_count} violations
- MEDIUM: {medium_count} violations
- LOW:    {low_count} violations
- TOTAL:  {total_count} violations

🚀 Performance: Parallel execution ~60% faster than sequential

✅ Ready for report generation (Step 4)
```

---

---

### 7. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-03f-aggregate-scores"]
  lastStep: "step-03f-aggregate-scores"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-03f-aggregate-scores'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-03f-aggregate-scores'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

---

## EXIT CONDITION

Proceed to Step 4 when:

- ✅ All subagent outputs read successfully
- ✅ Overall score calculated
- ✅ Violations aggregated
- ✅ Recommendations prioritized
- ✅ Summary saved to temp file
- ✅ Output displayed to user
- ✅ Progress saved to output document

Load next step: `{nextStepFile}`

---

## 🚨 SYSTEM SUCCESS METRICS

### ✅ SUCCESS:

- All 4 subagent outputs read and parsed
- Overall score calculated with proper weights
- Violations aggregated correctly
- Summary complete and saved

### ❌ FAILURE:

- Failed to read one or more subagent outputs
- Score calculation incorrect
- Summary missing or incomplete

**Master Rule:** Aggregate determinism, isolation, maintainability, and performance only.
