---
stepsCompleted: []
lastStep: ""
lastSaved: ""
workflowType: "testarch-test-review"
inputDocuments: []
---

# Test Quality Review: {test_filename}

**Quality Score**: {score}/100 ({grade} - {assessment})
**Review Date**: {YYYY-MM-DD}
**Review Scope**: {single | directory | suite}
**Reviewer**: {user_name or TEA Agent}

---

Note: This review audits existing tests; it does not generate tests.
Coverage mapping and coverage gates are out of scope here. Use `trace` for coverage decisions.

## Executive Summary

**Overall Assessment**: {Excellent | Good | Acceptable | Needs Improvement | Critical Issues}

**Recommendation**: {Approve | Approve with Comments | Request Changes | Block}

### Key Strengths

✅ {strength_1}
✅ {strength_2}
✅ {strength_3}

### Key Weaknesses

❌ {weakness_1}
❌ {weakness_2}
❌ {weakness_3}

### Summary

{1-2 paragraph summary of overall test quality, highlighting major findings and recommendation rationale}

---

## Quality Criteria Assessment

| Criterion                            | Status                          | Violations | Notes        |
| ------------------------------------ | ------------------------------- | ---------- | ------------ |
| BDD Format (Given-When-Then)         | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Test IDs                             | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Priority Markers (P0/P1/P2/P3)       | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Hard Waits (sleep, waitForTimeout)   | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Determinism (no conditionals)        | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Isolation (cleanup, no shared state) | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Fixture Patterns                     | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Data Factories                       | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Network-First Pattern                | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Explicit Assertions                  | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |
| Test Length (≤300 lines)             | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {lines}    | {brief_note} |
| Test Duration (≤1.5 min)             | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {duration} | {brief_note} |
| Flakiness Patterns                   | {✅ PASS \| ⚠️ WARN \| ❌ FAIL} | {count}    | {brief_note} |

**Total Violations**: {critical_count} Critical, {high_count} High, {medium_count} Medium, {low_count} Low

---

## Quality Score Breakdown

```
Starting Score:          100
Critical Violations:     -{critical_count} × 10 = -{critical_deduction}
High Violations:         -{high_count} × 5 = -{high_deduction}
Medium Violations:       -{medium_count} × 2 = -{medium_deduction}
Low Violations:          -{low_count} × 1 = -{low_deduction}

Bonus Points:
  Excellent BDD:         +{0|5}
  Comprehensive Fixtures: +{0|5}
  Data Factories:        +{0|5}
  Network-First:         +{0|5}
  Perfect Isolation:     +{0|5}
  All Test IDs:          +{0|5}
                         --------
Total Bonus:             +{bonus_total}

Final Score:             {final_score}/100
Grade:                   {grade}
```

---

## Critical Issues (Must Fix)

{If no critical issues: "No critical issues detected. ✅"}

{For each critical issue:}

### {issue_number}. {Issue Title}

**Severity**: P0 (Critical)
**Location**: `{filename}:{line_number}`
**Criterion**: {criterion_name}
**Knowledge Base**: [{fragment_name}]({fragment_path})

**Issue Description**:
{Detailed explanation of what the problem is and why it's critical}

**Current Code**:

```typescript
// ❌ Bad (current implementation)
{
  code_snippet_showing_problem;
}
```

**Recommended Fix**:

```typescript
// ✅ Good (recommended approach)
{
  code_snippet_showing_solution;
}
```

**Why This Matters**:
{Explanation of impact - flakiness risk, maintainability, reliability}

**Related Violations**:
{If similar issue appears elsewhere, note line numbers}

---

## Recommendations (Should Fix)

{If no recommendations: "No additional recommendations. Test quality is excellent. ✅"}

{For each recommendation:}

### {rec_number}. {Recommendation Title}

**Severity**: {P1 (High) | P2 (Medium) | P3 (Low)}
**Location**: `{filename}:{line_number}`
**Criterion**: {criterion_name}
**Knowledge Base**: [{fragment_name}]({fragment_path})

**Issue Description**:
{Detailed explanation of what could be improved and why}

**Current Code**:

```typescript
// ⚠️ Could be improved (current implementation)
{
  code_snippet_showing_current_approach;
}
```

**Recommended Improvement**:

```typescript
// ✅ Better approach (recommended)
{
  code_snippet_showing_improvement;
}
```

**Benefits**:
{Explanation of benefits - maintainability, readability, reusability}

**Priority**:
{Why this is P1/P2/P3 - urgency and impact}

---

## Best Practices Found

{If good patterns found, highlight them}

{For each best practice:}

### {practice_number}. {Best Practice Title}

**Location**: `{filename}:{line_number}`
**Pattern**: {pattern_name}
**Knowledge Base**: [{fragment_name}]({fragment_path})

**Why This Is Good**:
{Explanation of why this pattern is excellent}

**Code Example**:

```typescript
// ✅ Excellent pattern demonstrated in this test
{
  code_snippet_showing_best_practice;
}
```

**Use as Reference**:
{Encourage using this pattern in other tests}

---

## Test File Analysis

### File Metadata

- **File Path**: `{relative_path_from_project_root}`
- **File Size**: {line_count} lines, {kb_size} KB
- **Test Framework**: {Playwright | Jest | Cypress | Vitest | Other}
- **Language**: {TypeScript | JavaScript}

### Test Structure

- **Describe Blocks**: {describe_count}
- **Test Cases (it/test)**: {test_count}
- **Average Test Length**: {avg_lines_per_test} lines per test
- **Fixtures Used**: {fixture_count} ({fixture_names})
- **Data Factories Used**: {factory_count} ({factory_names})

### Test Scope

- **Test IDs**: {test_id_list}
- **Priority Distribution**:
  - P0 (Critical): {p0_count} tests
  - P1 (High): {p1_count} tests
  - P2 (Medium): {p2_count} tests
  - P3 (Low): {p3_count} tests
  - Unknown: {unknown_count} tests

### Assertions Analysis

- **Total Assertions**: {assertion_count}
- **Assertions per Test**: {avg_assertions_per_test} (avg)
- **Assertion Types**: {assertion_types_used}

---

## Context and Integration

### Related Artifacts

{If story file found:}

- **Story File**: [{story_filename}]({story_path})

{If test-design found:}

- **Test Design**: [{test_design_filename}]({test_design_path})
- **Risk Assessment**: {risk_level}
- **Priority Framework**: P0-P3 applied

---

## Knowledge Base References

This review consulted the following knowledge base fragments:

- **[test-quality.md](../../../testarch/knowledge/test-quality.md)** - Definition of Done for tests (no hard waits, <300 lines, <1.5 min, self-cleaning)
- **[fixture-architecture.md](../../../testarch/knowledge/fixture-architecture.md)** - Pure function → Fixture → mergeTests pattern
- **[network-first.md](../../../testarch/knowledge/network-first.md)** - Route intercept before navigate (race condition prevention)
- **[data-factories.md](../../../testarch/knowledge/data-factories.md)** - Factory functions with overrides, API-first setup
- **[test-levels-framework.md](../../../testarch/knowledge/test-levels-framework.md)** - E2E vs API vs Component vs Unit appropriateness
- **[tdd-cycles.md](../../../testarch/knowledge/tdd-cycles.md)** - Red-Green-Refactor patterns
- **[selective-testing.md](../../../testarch/knowledge/selective-testing.md)** - Duplicate coverage detection
- **[ci-burn-in.md](../../../testarch/knowledge/ci-burn-in.md)** - Flakiness detection patterns (10-iteration loop)
- **[test-priorities.md](../../../testarch/knowledge/test-priorities.md)** - P0/P1/P2/P3 classification framework

For coverage mapping, consult `trace` workflow outputs.

See [tea-index.csv](../../../testarch/tea-index.csv) for complete knowledge base.

---

## Next Steps

### Immediate Actions (Before Merge)

1. **{action_1}** - {description}
   - Priority: {P0 | P1 | P2}
   - Owner: {team_or_person}
   - Estimated Effort: {time_estimate}

2. **{action_2}** - {description}
   - Priority: {P0 | P1 | P2}
   - Owner: {team_or_person}
   - Estimated Effort: {time_estimate}

### Follow-up Actions (Future PRs)

1. **{action_1}** - {description}
   - Priority: {P2 | P3}
   - Target: {next_milestone | backlog}

2. **{action_2}** - {description}
   - Priority: {P2 | P3}
   - Target: {next_milestone | backlog}

### Re-Review Needed?

{✅ No re-review needed - approve as-is}
{⚠️ Re-review after critical fixes - request changes, then re-review}
{❌ Major refactor required - block merge, pair programming recommended}

---

## Decision

**Recommendation**: {Approve | Approve with Comments | Request Changes | Block}

**Rationale**:
{1-2 paragraph explanation of recommendation based on findings}

**For Approve**:

> Test quality is excellent/good with {score}/100 score. {Minor issues noted can be addressed in follow-up PRs.} Tests are production-ready and follow best practices.

**For Approve with Comments**:

> Test quality is acceptable with {score}/100 score. {High-priority recommendations should be addressed but don't block merge.} Critical issues resolved, but improvements would enhance maintainability.

**For Request Changes**:

> Test quality needs improvement with {score}/100 score. {Critical issues must be fixed before merge.} {X} critical violations detected that pose flakiness/maintainability risks.

**For Block**:

> Test quality is insufficient with {score}/100 score. {Multiple critical issues make tests unsuitable for production.} Recommend pairing session with QA engineer to apply patterns from knowledge base.

---

## Appendix

### Violation Summary by Location

{Table of all violations sorted by line number:}

| Line   | Severity      | Criterion   | Issue         | Fix         |
| ------ | ------------- | ----------- | ------------- | ----------- |
| {line} | {P0/P1/P2/P3} | {criterion} | {brief_issue} | {brief_fix} |
| {line} | {P0/P1/P2/P3} | {criterion} | {brief_issue} | {brief_fix} |

### Quality Trends

{If reviewing same file multiple times, show trend:}

| Review Date  | Score         | Grade     | Critical Issues | Trend       |
| ------------ | ------------- | --------- | --------------- | ----------- |
| {YYYY-MM-DD} | {score_1}/100 | {grade_1} | {count_1}       | ⬆️ Improved |
| {YYYY-MM-DD} | {score_2}/100 | {grade_2} | {count_2}       | ⬇️ Declined |
| {YYYY-MM-DD} | {score_3}/100 | {grade_3} | {count_3}       | ➡️ Stable   |

### Related Reviews

{If reviewing multiple files in directory/suite:}

| File     | Score       | Grade   | Critical | Status             |
| -------- | ----------- | ------- | -------- | ------------------ |
| {file_1} | {score}/100 | {grade} | {count}  | {Approved/Blocked} |
| {file_2} | {score}/100 | {grade} | {count}  | {Approved/Blocked} |
| {file_3} | {score}/100 | {grade} | {count}  | {Approved/Blocked} |

**Suite Average**: {avg_score}/100 ({avg_grade})

---

## Review Metadata

**Generated By**: BMad TEA Agent (Test Architect)
**Workflow**: testarch-test-review v4.0
**Review ID**: test-review-{filename}-{YYYYMMDD}
**Timestamp**: {YYYY-MM-DD HH:MM:SS}
**Version**: 1.0

---

## Feedback on This Review

If you have questions or feedback on this review:

1. Review patterns in knowledge base: `testarch/knowledge/`
2. Consult tea-index.csv for detailed guidance
3. Request clarification on specific violations
4. Pair with QA engineer to apply patterns

This review is guidance, not rigid rules. Context matters - if a pattern is justified, document it with a comment.
