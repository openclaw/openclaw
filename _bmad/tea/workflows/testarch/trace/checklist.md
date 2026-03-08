# Requirements Traceability & Gate Decision - Validation Checklist

**Workflow:** `testarch-trace`
**Purpose:** Ensure complete traceability matrix with actionable gap analysis AND make deployment readiness decision (PASS/CONCERNS/FAIL/WAIVED)

This checklist covers **two sequential phases**:

- **PHASE 1**: Requirements Traceability (always executed)
- **PHASE 2**: Quality Gate Decision (executed if `enable_gate_decision: true`)

---

# PHASE 1: REQUIREMENTS TRACEABILITY

## Prerequisites Validation

- [ ] Acceptance criteria are available (from story file OR inline)
- [ ] Test suite exists (or gaps are acknowledged and documented)
- [ ] If tests are missing, recommend `*atdd` (trace does not run it automatically)
- [ ] Test directory path is correct (`test_dir` variable)
- [ ] Story file is accessible (if using BMad mode)
- [ ] Knowledge base is loaded (test-priorities, traceability, risk-governance)

---

## Context Loading

- [ ] Story file read successfully (if applicable)
- [ ] Acceptance criteria extracted correctly
- [ ] Story ID identified (e.g., 1.3)
- [ ] `test-design.md` loaded (if available)
- [ ] `tech-spec.md` loaded (if available)
- [ ] `PRD.md` loaded (if available)
- [ ] Relevant knowledge fragments loaded from `tea-index.csv`

---

## Test Discovery and Cataloging

- [ ] Tests auto-discovered using multiple strategies (test IDs, describe blocks, file paths)
- [ ] Tests categorized by level (E2E, API, Component, Unit)
- [ ] Test metadata extracted:
  - [ ] Test IDs (e.g., 1.3-E2E-001)
  - [ ] Describe/context blocks
  - [ ] It blocks (individual test cases)
  - [ ] Given-When-Then structure (if BDD)
  - [ ] Priority markers (P0/P1/P2/P3)
- [ ] All relevant test files found (no tests missed due to naming conventions)

---

## Criteria-to-Test Mapping

- [ ] Each acceptance criterion mapped to tests (or marked as NONE)
- [ ] Explicit references found (test IDs, describe blocks mentioning criterion)
- [ ] Test level documented (E2E, API, Component, Unit)
- [ ] Given-When-Then narrative verified for alignment
- [ ] Traceability matrix table generated:
  - [ ] Criterion ID
  - [ ] Description
  - [ ] Test ID
  - [ ] Test File
  - [ ] Test Level
  - [ ] Coverage Status

---

## Coverage Classification

- [ ] Coverage status classified for each criterion:
  - [ ] **FULL** - All scenarios validated at appropriate level(s)
  - [ ] **PARTIAL** - Some coverage but missing edge cases or levels
  - [ ] **NONE** - No test coverage at any level
  - [ ] **UNIT-ONLY** - Only unit tests (missing integration/E2E validation)
  - [ ] **INTEGRATION-ONLY** - Only API/Component tests (missing unit confidence)
- [ ] Classification justifications provided
- [ ] Edge cases considered in FULL vs PARTIAL determination

---

## Duplicate Coverage Detection

- [ ] Duplicate coverage checked across test levels
- [ ] Acceptable overlap identified (defense in depth for critical paths)
- [ ] Unacceptable duplication flagged (same validation at multiple levels)
- [ ] Recommendations provided for consolidation
- [ ] Selective testing principles applied

---

## Gap Analysis

- [ ] Coverage gaps identified:
  - [ ] Criteria with NONE status
  - [ ] Criteria with PARTIAL status
  - [ ] Criteria with UNIT-ONLY status
  - [ ] Criteria with INTEGRATION-ONLY status
- [ ] Coverage heuristics gaps identified:
  - [ ] Endpoints referenced in requirements but not covered by API tests
  - [ ] Auth/authz criteria missing denied/invalid path tests
  - [ ] Criteria with happy-path-only coverage (missing error scenarios)
- [ ] Gaps prioritized by risk level using test-priorities framework:
  - [ ] **CRITICAL** - P0 criteria without FULL coverage (BLOCKER)
  - [ ] **HIGH** - P1 criteria without FULL coverage (PR blocker)
  - [ ] **MEDIUM** - P2 criteria without FULL coverage (nightly gap)
  - [ ] **LOW** - P3 criteria without FULL coverage (acceptable)
- [ ] Specific test recommendations provided for each gap:
  - [ ] Suggested test level (E2E, API, Component, Unit)
  - [ ] Test description (Given-When-Then)
  - [ ] Recommended test ID (e.g., 1.3-E2E-004)
  - [ ] Explanation of why test is needed

---

## Coverage Metrics

- [ ] Overall coverage percentage calculated (FULL coverage / total criteria)
- [ ] P0 coverage percentage calculated
- [ ] P1 coverage percentage calculated
- [ ] P2 coverage percentage calculated (if applicable)
- [ ] Coverage by level calculated:
  - [ ] E2E coverage %
  - [ ] API coverage %
  - [ ] Component coverage %
  - [ ] Unit coverage %

---

## Test Quality Verification

For each mapped test, verify:

- [ ] Explicit assertions are present (not hidden in helpers)
- [ ] Test follows Given-When-Then structure
- [ ] No hard waits or sleeps (deterministic waiting only)
- [ ] Self-cleaning (test cleans up its data)
- [ ] File size < 300 lines
- [ ] Test duration < 90 seconds

Quality issues flagged:

- [ ] **BLOCKER** issues identified (missing assertions, hard waits, flaky patterns)
- [ ] **WARNING** issues identified (large files, slow tests, unclear structure)
- [ ] **INFO** issues identified (style inconsistencies, missing documentation)

Knowledge fragments referenced:

- [ ] `test-quality.md` for Definition of Done
- [ ] `fixture-architecture.md` for self-cleaning patterns
- [ ] `network-first.md` for Playwright best practices
- [ ] `data-factories.md` for test data patterns

---

## Phase 1 Deliverables Generated

### Traceability Matrix Markdown

- [ ] File created at `{test_artifacts}/traceability-matrix.md`
- [ ] Template from `trace-template.md` used
- [ ] Full mapping table included
- [ ] Coverage status section included
- [ ] Gap analysis section included
- [ ] Quality assessment section included
- [ ] Recommendations section included

### Coverage Badge/Metric (if enabled)

- [ ] Badge markdown generated
- [ ] Metrics exported to JSON for CI/CD integration

### Updated Story File (if enabled)

- [ ] "Traceability" section added to story markdown
- [ ] Link to traceability matrix included
- [ ] Coverage summary included

---

## Phase 1 Quality Assurance

### Accuracy Checks

- [ ] All acceptance criteria accounted for (none skipped)
- [ ] Test IDs correctly formatted (e.g., 1.3-E2E-001)
- [ ] File paths are correct and accessible
- [ ] Coverage percentages calculated correctly
- [ ] No false positives (tests incorrectly mapped to criteria)
- [ ] No false negatives (existing tests missed in mapping)

### Completeness Checks

- [ ] All test levels considered (E2E, API, Component, Unit)
- [ ] All priorities considered (P0, P1, P2, P3)
- [ ] All coverage statuses used appropriately (FULL, PARTIAL, NONE, UNIT-ONLY, INTEGRATION-ONLY)
- [ ] All gaps have recommendations
- [ ] All quality issues have severity and remediation guidance

### Actionability Checks

- [ ] Recommendations are specific (not generic)
- [ ] Test IDs suggested for new tests
- [ ] Given-When-Then provided for recommended tests
- [ ] Impact explained for each gap
- [ ] Priorities clear (CRITICAL, HIGH, MEDIUM, LOW)

---

## Phase 1 Documentation

- [ ] Traceability matrix is readable and well-formatted
- [ ] Tables render correctly in markdown
- [ ] Code blocks have proper syntax highlighting
- [ ] Links are valid and accessible
- [ ] Recommendations are clear and prioritized

---

# PHASE 2: QUALITY GATE DECISION

**Note**: Phase 2 executes only if `enable_gate_decision: true` in workflow.yaml

---

## Prerequisites

### Evidence Gathering

- [ ] Test execution results obtained (CI/CD pipeline, test framework reports)
- [ ] Story/epic/release file identified and read
- [ ] Test design document discovered or explicitly provided (if available)
- [ ] Traceability matrix discovered or explicitly provided (available from Phase 1)
- [ ] NFR assessment discovered or explicitly provided (if available)
- [ ] Code coverage report discovered or explicitly provided (if available)
- [ ] Burn-in results discovered or explicitly provided (if available)

### Evidence Validation

- [ ] Evidence freshness validated (warn if >7 days old, recommend re-running workflows)
- [ ] All required assessments available or user acknowledged gaps
- [ ] Test results are complete (not partial or interrupted runs)
- [ ] Test results match current codebase (not from outdated branch)

### Knowledge Base Loading

- [ ] `risk-governance.md` loaded successfully
- [ ] `probability-impact.md` loaded successfully
- [ ] `test-quality.md` loaded successfully
- [ ] `test-priorities.md` loaded successfully
- [ ] `ci-burn-in.md` loaded (if burn-in results available)

---

## Process Steps

### Step 1: Context Loading

- [ ] Gate type identified (story/epic/release/hotfix)
- [ ] Target ID extracted (story_id, epic_num, or release_version)
- [ ] Decision thresholds loaded from workflow variables
- [ ] Risk tolerance configuration loaded
- [ ] Waiver policy loaded

### Step 2: Evidence Parsing

**Test Results:**

- [ ] Total test count extracted
- [ ] Passed test count extracted
- [ ] Failed test count extracted
- [ ] Skipped test count extracted
- [ ] Test duration extracted
- [ ] P0 test pass rate calculated
- [ ] P1 test pass rate calculated
- [ ] Overall test pass rate calculated

**Quality Assessments:**

- [ ] P0/P1/P2/P3 scenarios extracted from test-design.md (if available)
- [ ] Risk scores extracted from test-design.md (if available)
- [ ] Coverage percentages extracted from traceability-matrix.md (available from Phase 1)
- [ ] Coverage gaps extracted from traceability-matrix.md (available from Phase 1)
- [ ] NFR status extracted from nfr-assessment.md (if available)
- [ ] Security issues count extracted from nfr-assessment.md (if available)

**Code Coverage:**

- [ ] Line coverage percentage extracted (if available)
- [ ] Branch coverage percentage extracted (if available)
- [ ] Function coverage percentage extracted (if available)
- [ ] Critical path coverage validated (if available)

**Burn-in Results:**

- [ ] Burn-in iterations count extracted (if available)
- [ ] Flaky tests count extracted (if available)
- [ ] Stability score calculated (if available)

### Step 3: Decision Rules Application

**P0 Criteria Evaluation:**

- [ ] P0 test pass rate evaluated (must be 100%)
- [ ] P0 acceptance criteria coverage evaluated (must be 100%)
- [ ] Security issues count evaluated (must be 0)
- [ ] Critical NFR failures evaluated (must be 0)
- [ ] Flaky tests evaluated (must be 0 if burn-in enabled)
- [ ] P0 decision recorded: PASS or FAIL

**P1 Criteria Evaluation:**

- [ ] P1 test pass rate evaluated (threshold: min_p1_pass_rate)
- [ ] P1 acceptance criteria coverage evaluated (PASS >=90%, CONCERNS 80-89%, FAIL <80%)
- [ ] Overall test pass rate evaluated (threshold: min_overall_pass_rate)
- [ ] Overall requirements coverage evaluated (threshold: >=80%)
- [ ] Code coverage considered if available (informational unless explicitly required by policy)
- [ ] P1 decision recorded: PASS or CONCERNS

**P2/P3 Criteria Evaluation:**

- [ ] P2 failures tracked (informational, don't block if allow_p2_failures: true)
- [ ] P3 failures tracked (informational, don't block if allow_p3_failures: true)
- [ ] Residual risks documented

**Final Decision:**

- [ ] Decision determined: PASS / CONCERNS / FAIL / WAIVED
- [ ] Decision rationale documented
- [ ] Decision is deterministic (follows rules, not arbitrary)

### Step 4: Documentation

**Gate Decision Document Created:**

- [ ] Story/epic/release info section complete (ID, title, description, links)
- [ ] Decision clearly stated (PASS / CONCERNS / FAIL / WAIVED)
- [ ] Decision date recorded
- [ ] Evaluator recorded (user or agent name)

**Evidence Summary Documented:**

- [ ] Test results summary complete (total, passed, failed, pass rates)
- [ ] Coverage summary complete (P0/P1 criteria, code coverage)
- [ ] NFR validation summary complete (security, performance, reliability, maintainability)
- [ ] Flakiness summary complete (burn-in iterations, flaky test count)

**Rationale Documented:**

- [ ] Decision rationale clearly explained
- [ ] Key evidence highlighted
- [ ] Assumptions and caveats noted (if any)

**Residual Risks Documented (if CONCERNS or WAIVED):**

- [ ] Unresolved P1/P2 issues listed
- [ ] Probability × impact estimated for each risk
- [ ] Mitigations or workarounds described

**Waivers Documented (if WAIVED):**

- [ ] Waiver reason documented (business justification)
- [ ] Waiver approver documented (name, role)
- [ ] Waiver expiry date documented
- [ ] Remediation plan documented (fix in next release, due date)
- [ ] Monitoring plan documented

**Critical Issues Documented (if FAIL or CONCERNS):**

- [ ] Top 5-10 critical issues listed
- [ ] Priority assigned to each issue (P0/P1/P2)
- [ ] Owner assigned to each issue
- [ ] Due date assigned to each issue

**Recommendations Documented:**

- [ ] Next steps clearly stated for decision type
- [ ] Deployment recommendation provided
- [ ] Monitoring recommendations provided (if applicable)
- [ ] Remediation recommendations provided (if applicable)

### Step 5: Status Updates and Notifications

**Gate YAML Created:**

- [ ] Gate YAML snippet generated with decision and criteria
- [ ] Evidence references included in YAML
- [ ] Next steps included in YAML
- [ ] YAML file saved to output folder

**Stakeholder Notification Generated:**

- [ ] Notification subject line created
- [ ] Notification body created with summary
- [ ] Recipients identified (PM, SM, DEV lead, stakeholders)
- [ ] Notification ready for delivery (if notify_stakeholders: true)

**Outputs Saved:**

- [ ] Gate decision document saved to `{output_file}`
- [ ] Gate YAML saved to `{test_artifacts}/gate-decision-{target}.yaml`
- [ ] All outputs are valid and readable

---

## Phase 2 Output Validation

### Gate Decision Document

**Completeness:**

- [ ] All required sections present (info, decision, evidence, rationale, next steps)
- [ ] No placeholder text or TODOs left in document
- [ ] All evidence references are accurate and complete
- [ ] All links to artifacts are valid

**Accuracy:**

- [ ] Decision matches applied criteria rules
- [ ] Test results match CI/CD pipeline output
- [ ] Coverage percentages match reports
- [ ] NFR status matches assessment document
- [ ] No contradictions or inconsistencies

**Clarity:**

- [ ] Decision rationale is clear and unambiguous
- [ ] Technical jargon is explained or avoided
- [ ] Stakeholders can understand next steps
- [ ] Recommendations are actionable

### Gate YAML

**Format:**

- [ ] YAML is valid (no syntax errors)
- [ ] All required fields present (target, decision, date, evaluator, criteria, evidence)
- [ ] Field values are correct data types (numbers, strings, dates)

**Content:**

- [ ] Criteria values match decision document
- [ ] Evidence references are accurate
- [ ] Next steps align with decision type

---

## Phase 2 Quality Checks

### Decision Integrity

- [ ] Decision is deterministic (follows rules, not arbitrary)
- [ ] P0 failures result in FAIL decision (unless waived)
- [ ] Security issues result in FAIL decision (unless waived - but should never be waived)
- [ ] Waivers have business justification and approver (if WAIVED)
- [ ] Residual risks are documented (if CONCERNS or WAIVED)

### Evidence-Based

- [ ] Decision is based on actual test results (not guesses)
- [ ] All claims are supported by evidence
- [ ] No assumptions without documentation
- [ ] Evidence sources are cited (CI run IDs, report URLs)

### Transparency

- [ ] Decision rationale is transparent and auditable
- [ ] Criteria evaluation is documented step-by-step
- [ ] Any deviations from standard process are explained
- [ ] Waiver justifications are clear (if applicable)

### Consistency

- [ ] Decision aligns with risk-governance knowledge fragment
- [ ] Priority framework (P0/P1/P2/P3) applied consistently
- [ ] Terminology consistent with test-quality knowledge fragment
- [ ] Decision matrix followed correctly

---

## Phase 2 Integration Points

### CI/CD Pipeline

- [ ] Gate YAML is CI/CD-compatible
- [ ] YAML can be parsed by pipeline automation
- [ ] Decision can be used to block/allow deployments
- [ ] Evidence references are accessible to pipeline

### Stakeholders

- [ ] Notification message is clear and actionable
- [ ] Decision is explained in non-technical terms
- [ ] Next steps are specific and time-bound
- [ ] Recipients are appropriate for decision type

---

## Phase 2 Compliance and Audit

### Audit Trail

- [ ] Decision date and time recorded
- [ ] Evaluator identified (user or agent)
- [ ] All evidence sources cited
- [ ] Decision criteria documented
- [ ] Rationale clearly explained

### Traceability

- [ ] Gate decision traceable to story/epic/release
- [ ] Evidence traceable to specific test runs
- [ ] Assessments traceable to workflows that created them
- [ ] Waiver traceable to approver (if applicable)

### Compliance

- [ ] Security requirements validated (no unresolved vulnerabilities)
- [ ] Quality standards met or waived with justification
- [ ] Regulatory requirements addressed (if applicable)
- [ ] Documentation sufficient for external audit

---

## Phase 2 Edge Cases and Exceptions

### Missing Evidence

- [ ] If test-design.md missing, decision still possible with test results + trace
- [ ] If traceability-matrix.md missing, decision still possible with test results (but Phase 1 should provide it)
- [ ] If nfr-assessment.md missing, NFR validation marked as NOT ASSESSED
- [ ] If code coverage missing, coverage criterion marked as NOT ASSESSED
- [ ] User acknowledged gaps in evidence or provided alternative proof

### Stale Evidence

- [ ] Evidence freshness checked (if validate_evidence_freshness: true)
- [ ] Warnings issued for assessments >7 days old
- [ ] User acknowledged stale evidence or re-ran workflows
- [ ] Decision document notes any stale evidence used

### Conflicting Evidence

- [ ] Conflicts between test results and assessments resolved
- [ ] Most recent/authoritative source identified
- [ ] Conflict resolution documented in decision rationale
- [ ] User consulted if conflict cannot be resolved

### Waiver Scenarios

- [ ] Waiver only used for FAIL decision (not PASS or CONCERNS)
- [ ] Waiver has business justification (not technical convenience)
- [ ] Waiver has named approver with authority (VP/CTO/PO)
- [ ] Waiver has expiry date (does NOT apply to future releases)
- [ ] Waiver has remediation plan with concrete due date
- [ ] Security vulnerabilities are NOT waived (enforced)

---

# FINAL VALIDATION (Both Phases)

## Non-Prescriptive Validation

- [ ] Traceability format adapted to team needs (not rigid template)
- [ ] Examples are minimal and focused on patterns
- [ ] Teams can extend with custom classifications
- [ ] Integration with external systems supported (JIRA, Azure DevOps)
- [ ] Compliance requirements considered (if applicable)

---

## Documentation and Communication

- [ ] All documents are readable and well-formatted
- [ ] Tables render correctly in markdown
- [ ] Code blocks have proper syntax highlighting
- [ ] Links are valid and accessible
- [ ] Recommendations are clear and prioritized
- [ ] Gate decision is prominent and unambiguous (Phase 2)

---

## Final Validation

**Phase 1 (Traceability):**

- [ ] All prerequisites met
- [ ] All acceptance criteria mapped or gaps documented
- [ ] P0 coverage is 100% OR documented as BLOCKER
- [ ] Gap analysis is complete and prioritized
- [ ] Test quality issues identified and flagged
- [ ] Deliverables generated and saved

**Phase 2 (Gate Decision):**

- [ ] All quality evidence gathered
- [ ] Decision criteria applied correctly
- [ ] Decision rationale documented
- [ ] Gate YAML ready for CI/CD integration
- [ ] Status file updated (if enabled)
- [ ] Stakeholders notified (if enabled)

**Workflow Complete:**

- [ ] Phase 1 completed successfully
- [ ] Phase 2 completed successfully (if enabled)
- [ ] All outputs validated and saved
- [ ] Ready to proceed based on gate decision

---

## Sign-Off

**Phase 1 - Traceability Status:**

- [ ] ✅ PASS - All quality gates met, no critical gaps
- [ ] ⚠️ WARN - P1 gaps exist, address before PR merge
- [ ] ❌ FAIL - P0 gaps exist, BLOCKER for release

**Phase 2 - Gate Decision Status (if enabled):**

- [ ] ✅ PASS - Deploy to production
- [ ] ⚠️ CONCERNS - Deploy with monitoring
- [ ] ❌ FAIL - Block deployment, fix issues
- [ ] 🔓 WAIVED - Deploy with business approval and remediation plan

**Next Actions:**

- If PASS (both phases): Proceed to deployment
- If WARN/CONCERNS: Address gaps/issues, proceed with monitoring
- If FAIL (either phase): Run `*atdd` for missing tests, fix issues, re-run `*trace`
- If WAIVED: Deploy with approved waiver, schedule remediation

---

## Notes

Record any issues, deviations, or important observations during workflow execution:

- **Phase 1 Issues**: [Note any traceability mapping challenges, missing tests, quality concerns]
- **Phase 2 Issues**: [Note any missing, stale, or conflicting evidence]
- **Decision Rationale**: [Document any nuanced reasoning or edge cases]
- **Waiver Details**: [Document waiver negotiations or approvals]
- **Follow-up Actions**: [List any actions required after gate decision]

---

<!-- Powered by BMAD-CORE™ -->
