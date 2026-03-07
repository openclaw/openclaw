---
name: "step-03e-subagent-performance"
description: "Subagent: Check test performance (speed, efficiency, parallelization)"
subagent: true
outputFile: "/tmp/tea-test-review-performance-{{timestamp}}.json"
---

# Subagent 3E: Performance Quality Check

## SUBAGENT CONTEXT

This is an **isolated subagent** running in parallel with other quality dimension checks.

**Your task:** Analyze test files for PERFORMANCE violations only.

---

## MANDATORY EXECUTION RULES

- ✅ Check PERFORMANCE only (not other quality dimensions)
- ✅ Output structured JSON to temp file
- ❌ Do NOT check determinism, isolation, maintainability, or coverage

---

## SUBAGENT TASK

### 1. Identify Performance Violations

**HIGH SEVERITY Violations**:

- Tests not parallelizable (using test.describe.serial unnecessarily)
- Slow setup/teardown (creating fresh DB for every test)
- Excessive navigation (reloading pages unnecessarily)
- No fixture reuse (repeating expensive operations)

**MEDIUM SEVERITY Violations**:

- Hard waits >2 seconds (waitForTimeout(5000))
- Inefficient selectors (page.$$ instead of locators)
- Large data sets in tests without pagination
- Missing performance optimizations

**LOW SEVERITY Violations**:

- Could use parallelization (test.describe.configure({ mode: 'parallel' }))
- Minor inefficiencies
- Excessive logging

### 2. Calculate Performance Score

```javascript
const severityWeights = { HIGH: 10, MEDIUM: 5, LOW: 2 };
const totalPenalty = violations.reduce((sum, v) => sum + severityWeights[v.severity], 0);
const score = Math.max(0, 100 - totalPenalty);
```

---

## OUTPUT FORMAT

```json
{
  "dimension": "performance",
  "score": 80,
  "max_score": 100,
  "grade": "B",
  "violations": [
    {
      "file": "tests/e2e/search.spec.ts",
      "line": 10,
      "severity": "HIGH",
      "category": "not-parallelizable",
      "description": "Tests use test.describe.serial unnecessarily - reduces parallel execution",
      "suggestion": "Remove .serial unless tests truly share state",
      "code_snippet": "test.describe.serial('Search tests', () => { ... });"
    },
    {
      "file": "tests/api/bulk-operations.spec.ts",
      "line": 35,
      "severity": "MEDIUM",
      "category": "slow-setup",
      "description": "Test creates 1000 records in setup - very slow",
      "suggestion": "Use smaller data sets or fixture factories",
      "code_snippet": "beforeEach(async () => { for (let i=0; i<1000; i++) { ... } });"
    }
  ],
  "passed_checks": 13,
  "failed_checks": 2,
  "violation_summary": {
    "HIGH": 1,
    "MEDIUM": 1,
    "LOW": 0
  },
  "performance_metrics": {
    "parallelizable_tests": 80,
    "serial_tests": 20,
    "avg_test_duration_estimate": "~2 seconds",
    "slow_tests": ["bulk-operations.spec.ts (>30s)"]
  },
  "recommendations": [
    "Enable parallel mode where possible",
    "Reduce setup data to minimum needed",
    "Use fixtures to share expensive setup across tests",
    "Remove unnecessary .serial constraints"
  ],
  "summary": "Good performance with 2 violations - 80% tests can run in parallel"
}
```

---

## EXIT CONDITION

Subagent completes when JSON output written to temp file.

**Subagent terminates here.**
