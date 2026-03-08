---
stepsCompleted: []
lastStep: ""
lastSaved: ""
---

# Test Design: Epic {epic_num} - {epic_title}

**Date:** {date}
**Author:** {user_name}
**Status:** Draft / Approved

---

## Executive Summary

**Scope:** {design_level} test design for Epic {epic_num}

**Risk Summary:**

- Total risks identified: {total_risks}
- High-priority risks (≥6): {high_priority_count}
- Critical categories: {top_categories}

**Coverage Summary:**

- P0 scenarios: {p0_count} ({p0_hours} hours)
- P1 scenarios: {p1_count} ({p1_hours} hours)
- P2/P3 scenarios: {p2p3_count} ({p2p3_hours} hours)
- **Total effort**: {total_hours} hours (~{total_days} days)

---

## Not in Scope

| Item       | Reasoning      | Mitigation            |
| ---------- | -------------- | --------------------- |
| **{Item}** | {Why excluded} | {How risk is handled} |

---

## Risk Assessment

### High-Priority Risks (Score ≥6)

| Risk ID | Category | Description   | Probability | Impact | Score | Mitigation   | Owner   | Timeline |
| ------- | -------- | ------------- | ----------- | ------ | ----- | ------------ | ------- | -------- |
| R-001   | SEC      | {description} | 2           | 3      | 6     | {mitigation} | {owner} | {date}   |
| R-002   | PERF     | {description} | 3           | 2      | 6     | {mitigation} | {owner} | {date}   |

### Medium-Priority Risks (Score 3-4)

| Risk ID | Category | Description   | Probability | Impact | Score | Mitigation   | Owner   |
| ------- | -------- | ------------- | ----------- | ------ | ----- | ------------ | ------- |
| R-003   | TECH     | {description} | 2           | 2      | 4     | {mitigation} | {owner} |
| R-004   | DATA     | {description} | 1           | 3      | 3     | {mitigation} | {owner} |

### Low-Priority Risks (Score 1-2)

| Risk ID | Category | Description   | Probability | Impact | Score | Action  |
| ------- | -------- | ------------- | ----------- | ------ | ----- | ------- |
| R-005   | OPS      | {description} | 1           | 2      | 2     | Monitor |
| R-006   | BUS      | {description} | 1           | 1      | 1     | Monitor |

### Risk Category Legend

- **TECH**: Technical/Architecture (flaws, integration, scalability)
- **SEC**: Security (access controls, auth, data exposure)
- **PERF**: Performance (SLA violations, degradation, resource limits)
- **DATA**: Data Integrity (loss, corruption, inconsistency)
- **BUS**: Business Impact (UX harm, logic errors, revenue)
- **OPS**: Operations (deployment, config, monitoring)

---

## Entry Criteria

- [ ] Requirements and assumptions agreed upon by QA, Dev, PM
- [ ] Test environment provisioned and accessible
- [ ] Test data available or factories ready
- [ ] Feature deployed to test environment
- [ ] {Epic-specific entry criteria}

## Exit Criteria

- [ ] All P0 tests passing
- [ ] All P1 tests passing (or failures triaged)
- [ ] No open high-priority / high-severity bugs
- [ ] Test coverage agreed as sufficient
- [ ] {Epic-specific exit criteria}

## Project Team (Optional)

**Include only if roles/names are known or responsibility mapping is needed; otherwise omit.**

| Name   | Role     | Testing Responsibilities |
| ------ | -------- | ------------------------ |
| {Name} | QA Lead  | {Responsibilities}       |
| {Name} | Dev Lead | {Responsibilities}       |
| {Name} | PM       | {Responsibilities}       |

---

## Test Coverage Plan

### P0 (Critical) - Run on every commit

**Criteria**: Blocks core journey + High risk (≥6) + No workaround

| Requirement   | Test Level | Risk Link | Test Count | Owner | Notes   |
| ------------- | ---------- | --------- | ---------- | ----- | ------- |
| {requirement} | E2E        | R-001     | 3          | QA    | {notes} |
| {requirement} | API        | R-002     | 5          | QA    | {notes} |

**Total P0**: {p0_count} tests, {p0_hours} hours

### P1 (High) - Run on PR to main

**Criteria**: Important features + Medium risk (3-4) + Common workflows

| Requirement   | Test Level | Risk Link | Test Count | Owner | Notes   |
| ------------- | ---------- | --------- | ---------- | ----- | ------- |
| {requirement} | API        | R-003     | 4          | QA    | {notes} |
| {requirement} | Component  | -         | 6          | DEV   | {notes} |

**Total P1**: {p1_count} tests, {p1_hours} hours

### P2 (Medium) - Run nightly/weekly

**Criteria**: Secondary features + Low risk (1-2) + Edge cases

| Requirement   | Test Level | Risk Link | Test Count | Owner | Notes   |
| ------------- | ---------- | --------- | ---------- | ----- | ------- |
| {requirement} | API        | R-004     | 8          | QA    | {notes} |
| {requirement} | Unit       | -         | 15         | DEV   | {notes} |

**Total P2**: {p2_count} tests, {p2_hours} hours

### P3 (Low) - Run on-demand

**Criteria**: Nice-to-have + Exploratory + Performance benchmarks

| Requirement   | Test Level | Test Count | Owner | Notes   |
| ------------- | ---------- | ---------- | ----- | ------- |
| {requirement} | E2E        | 2          | QA    | {notes} |
| {requirement} | Unit       | 8          | DEV   | {notes} |

**Total P3**: {p3_count} tests, {p3_hours} hours

---

## Execution Order

### Smoke Tests (<5 min)

**Purpose**: Fast feedback, catch build-breaking issues

- [ ] {scenario} (30s)
- [ ] {scenario} (45s)
- [ ] {scenario} (1min)

**Total**: {smoke_count} scenarios

### P0 Tests (<10 min)

**Purpose**: Critical path validation

- [ ] {scenario} (E2E)
- [ ] {scenario} (API)
- [ ] {scenario} (API)

**Total**: {p0_count} scenarios

### P1 Tests (<30 min)

**Purpose**: Important feature coverage

- [ ] {scenario} (API)
- [ ] {scenario} (Component)

**Total**: {p1_count} scenarios

### P2/P3 Tests (<60 min)

**Purpose**: Full regression coverage

- [ ] {scenario} (Unit)
- [ ] {scenario} (API)

**Total**: {p2p3_count} scenarios

---

## Resource Estimates

### Test Development Effort

| Priority  | Count             | Hours/Test | Total Hours       | Notes                   |
| --------- | ----------------- | ---------- | ----------------- | ----------------------- |
| P0        | {p0_count}        | 2.0        | {p0_hours}        | Complex setup, security |
| P1        | {p1_count}        | 1.0        | {p1_hours}        | Standard coverage       |
| P2        | {p2_count}        | 0.5        | {p2_hours}        | Simple scenarios        |
| P3        | {p3_count}        | 0.25       | {p3_hours}        | Exploratory             |
| **Total** | **{total_count}** | **-**      | **{total_hours}** | **~{total_days} days**  |

### Prerequisites

**Test Data:**

- {factory_name} factory (faker-based, auto-cleanup)
- {fixture_name} fixture (setup/teardown)

**Tooling:**

- {tool} for {purpose}
- {tool} for {purpose}

**Environment:**

- {env_requirement}
- {env_requirement}

---

## Quality Gate Criteria

### Pass/Fail Thresholds

- **P0 pass rate**: 100% (no exceptions)
- **P1 pass rate**: ≥95% (waivers required for failures)
- **P2/P3 pass rate**: ≥90% (informational)
- **High-risk mitigations**: 100% complete or approved waivers

### Coverage Targets

- **Critical paths**: ≥80%
- **Security scenarios**: 100%
- **Business logic**: ≥70%
- **Edge cases**: ≥50%

### Non-Negotiable Requirements

- [ ] All P0 tests pass
- [ ] No high-risk (≥6) items unmitigated
- [ ] Security tests (SEC category) pass 100%
- [ ] Performance targets met (PERF category)

---

## Mitigation Plans

### R-001: {Risk Description} (Score: 6)

**Mitigation Strategy:** {detailed_mitigation}
**Owner:** {owner}
**Timeline:** {date}
**Status:** Planned / In Progress / Complete
**Verification:** {how_to_verify}

### R-002: {Risk Description} (Score: 6)

**Mitigation Strategy:** {detailed_mitigation}
**Owner:** {owner}
**Timeline:** {date}
**Status:** Planned / In Progress / Complete
**Verification:** {how_to_verify}

---

## Assumptions and Dependencies

### Assumptions

1. {assumption}
2. {assumption}
3. {assumption}

### Dependencies

1. {dependency} - Required by {date}
2. {dependency} - Required by {date}

### Risks to Plan

- **Risk**: {risk_to_plan}
  - **Impact**: {impact}
  - **Contingency**: {contingency}

---

---

## Follow-on Workflows (Manual)

- Run `*atdd` to generate failing P0 tests (separate workflow; not auto-run).
- Run `*automate` for broader coverage once implementation exists.

---

## Approval

**Test Design Approved By:**

- [ ] Product Manager: {name} Date: {date}
- [ ] Tech Lead: {name} Date: {date}
- [ ] QA Lead: {name} Date: {date}

**Comments:**

---

---

---

## Interworking & Regression

| Service/Component | Impact         | Regression Scope                |
| ----------------- | -------------- | ------------------------------- |
| **{Service}**     | {How affected} | {Existing tests that must pass} |

---

## Appendix

### Knowledge Base References

- `risk-governance.md` - Risk classification framework
- `probability-impact.md` - Risk scoring methodology
- `test-levels-framework.md` - Test level selection
- `test-priorities-matrix.md` - P0-P3 prioritization

### Related Documents

- PRD: {prd_link}
- Epic: {epic_link}
- Architecture: {arch_link}
- Tech Spec: {tech_spec_link}

---

**Generated by**: BMad TEA Agent - Test Architect Module
**Workflow**: `_bmad/tea/testarch/test-design`
**Version**: 4.0 (BMad v6)
