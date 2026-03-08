# Test Quality Review - Validation Checklist

Use this checklist to validate that the test quality review workflow completed successfully and all quality criteria were properly evaluated.

---

## Prerequisites

Note: `test-review` is optional and only audits existing tests; it does not generate tests.
Coverage analysis is out of scope for this workflow. Use `trace` for coverage metrics and coverage gate decisions.

### Test File Discovery

- [ ] Test file(s) identified for review (single/directory/suite scope)
- [ ] Test files exist and are readable
- [ ] Test framework detected (Playwright, Jest, Cypress, Vitest, etc.)
- [ ] Test framework configuration found (playwright.config.ts, jest.config.js, etc.)

### Knowledge Base Loading

- [ ] tea-index.csv loaded successfully
- [ ] `test-quality.md` loaded (Definition of Done)
- [ ] `fixture-architecture.md` loaded (Pure function → Fixture patterns)
- [ ] `network-first.md` loaded (Route intercept before navigate)
- [ ] `data-factories.md` loaded (Factory patterns)
- [ ] `test-levels-framework.md` loaded (E2E vs API vs Component vs Unit)
- [ ] All other enabled fragments loaded successfully

### Context Gathering

- [ ] Story file discovered or explicitly provided (if available)
- [ ] Test design document discovered or explicitly provided (if available)
- [ ] Acceptance criteria extracted from story (if available)
- [ ] Priority context (P0/P1/P2/P3) extracted from test-design (if available)

---

## Process Steps

### Step 1: Context Loading

- [ ] Review scope determined (single/directory/suite)
- [ ] Test file paths collected
- [ ] Related artifacts discovered (story, test-design)
- [ ] Knowledge base fragments loaded successfully
- [ ] Quality criteria flags read from workflow variables

### Step 2: Test File Parsing

**For Each Test File:**

- [ ] File read successfully
- [ ] File size measured (lines, KB)
- [ ] File structure parsed (describe blocks, it blocks)
- [ ] Test IDs extracted (if present)
- [ ] Priority markers extracted (if present)
- [ ] Imports analyzed
- [ ] Dependencies identified

**Test Structure Analysis:**

- [ ] Describe block count calculated
- [ ] It/test block count calculated
- [ ] BDD structure identified (Given-When-Then)
- [ ] Fixture usage detected
- [ ] Data factory usage detected
- [ ] Network interception patterns identified
- [ ] Assertions counted
- [ ] Waits and timeouts cataloged
- [ ] Conditionals (if/else) detected
- [ ] Try/catch blocks detected
- [ ] Shared state or globals detected

### Step 3: Quality Criteria Validation

Coverage criteria are intentionally excluded from this checklist.

**For Each Enabled Criterion:**

#### BDD Format (if `check_given_when_then: true`)

- [ ] Given-When-Then structure evaluated
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with line numbers
- [ ] Examples of good/bad patterns noted

#### Test IDs (if `check_test_ids: true`)

- [ ] Test ID presence validated
- [ ] Test ID format checked (e.g., 1.3-E2E-001)
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Missing IDs cataloged

#### Priority Markers (if `check_priority_markers: true`)

- [ ] P0/P1/P2/P3 classification validated
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Missing priorities cataloged

#### Hard Waits (if `check_hard_waits: true`)

- [ ] sleep(), waitForTimeout(), hardcoded delays detected
- [ ] Justification comments checked
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with line numbers and recommended fixes

#### Determinism (if `check_determinism: true`)

- [ ] Conditionals (if/else/switch) detected
- [ ] Try/catch abuse detected
- [ ] Random values (Math.random, Date.now) detected
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Isolation (if `check_isolation: true`)

- [ ] Cleanup hooks (afterEach/afterAll) validated
- [ ] Shared state detected
- [ ] Global variable mutations detected
- [ ] Resource cleanup verified
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Fixture Patterns (if `check_fixture_patterns: true`)

- [ ] Fixtures detected (test.extend)
- [ ] Pure functions validated
- [ ] mergeTests usage checked
- [ ] beforeEach complexity analyzed
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Data Factories (if `check_data_factories: true`)

- [ ] Factory functions detected
- [ ] Hardcoded data (magic strings/numbers) detected
- [ ] Faker.js or similar usage validated
- [ ] API-first setup pattern checked
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Network-First (if `check_network_first: true`)

- [ ] page.route() before page.goto() validated
- [ ] Race conditions detected (route after navigate)
- [ ] waitForResponse patterns checked
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Assertions (if `check_assertions: true`)

- [ ] Explicit assertions counted
- [ ] Implicit waits without assertions detected
- [ ] Assertion specificity validated
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

#### Test Length (if `check_test_length: true`)

- [ ] File line count calculated
- [ ] Threshold comparison (≤300 lines ideal)
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Splitting recommendations generated (if >300 lines)

#### Test Duration (if `check_test_duration: true`)

- [ ] Test complexity analyzed (as proxy for duration if no execution data)
- [ ] Threshold comparison (≤1.5 min target)
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Optimization recommendations generated

#### Flakiness Patterns (if `check_flakiness_patterns: true`)

- [ ] Tight timeouts detected (e.g., { timeout: 1000 })
- [ ] Race conditions detected
- [ ] Timing-dependent assertions detected
- [ ] Retry logic detected
- [ ] Environment-dependent assumptions detected
- [ ] Status assigned (PASS/WARN/FAIL)
- [ ] Violations recorded with recommended fixes

---

### Step 4: Quality Score Calculation

**Violation Counting:**

- [ ] Critical (P0) violations counted
- [ ] High (P1) violations counted
- [ ] Medium (P2) violations counted
- [ ] Low (P3) violations counted
- [ ] Violation breakdown by criterion recorded

**Score Calculation:**

- [ ] Starting score: 100
- [ ] Critical violations deducted (-10 each)
- [ ] High violations deducted (-5 each)
- [ ] Medium violations deducted (-2 each)
- [ ] Low violations deducted (-1 each)
- [ ] Bonus points added (max +30):
  - [ ] Excellent BDD structure (+5 if applicable)
  - [ ] Comprehensive fixtures (+5 if applicable)
  - [ ] Comprehensive data factories (+5 if applicable)
  - [ ] Network-first pattern (+5 if applicable)
  - [ ] Perfect isolation (+5 if applicable)
  - [ ] All test IDs present (+5 if applicable)
- [ ] Final score calculated: max(0, min(100, Starting - Violations + Bonus))

**Quality Grade:**

- [ ] Grade assigned based on score:
  - 90-100: A+ (Excellent)
  - 80-89: A (Good)
  - 70-79: B (Acceptable)
  - 60-69: C (Needs Improvement)
  - <60: F (Critical Issues)

---

### Step 5: Review Report Generation

**Report Sections Created:**

- [ ] **Header Section**:
  - [ ] Test file(s) reviewed listed
  - [ ] Review date recorded
  - [ ] Review scope noted (single/directory/suite)
  - [ ] Quality score and grade displayed

- [ ] **Executive Summary**:
  - [ ] Overall assessment (Excellent/Good/Needs Improvement/Critical)
  - [ ] Key strengths listed (3-5 bullet points)
  - [ ] Key weaknesses listed (3-5 bullet points)
  - [ ] Recommendation stated (Approve/Approve with comments/Request changes/Block)

- [ ] **Quality Criteria Assessment**:
  - [ ] Table with all criteria evaluated
  - [ ] Status for each criterion (PASS/WARN/FAIL)
  - [ ] Violation count per criterion

- [ ] **Critical Issues (Must Fix)**:
  - [ ] P0/P1 violations listed
  - [ ] Code location provided for each (file:line)
  - [ ] Issue explanation clear
  - [ ] Recommended fix provided with code example
  - [ ] Knowledge base reference provided

- [ ] **Recommendations (Should Fix)**:
  - [ ] P2/P3 violations listed
  - [ ] Code location provided for each (file:line)
  - [ ] Issue explanation clear
  - [ ] Recommended improvement provided with code example
  - [ ] Knowledge base reference provided

- [ ] **Best Practices Examples** (if good patterns found):
  - [ ] Good patterns highlighted from tests
  - [ ] Knowledge base fragments referenced
  - [ ] Examples provided for others to follow

- [ ] **Knowledge Base References**:
  - [ ] All fragments consulted listed
  - [ ] Links to detailed guidance provided

---

### Step 6: Optional Outputs Generation

**Inline Comments** (if `generate_inline_comments: true`):

- [ ] Inline comments generated at violation locations
- [ ] Comment format: `// TODO (TEA Review): [Issue] - See test-review-{filename}.md`
- [ ] Comments added to test files (no logic changes)
- [ ] Test files remain valid and executable

**Quality Badge** (if `generate_quality_badge: true`):

- [ ] Badge created with quality score (e.g., "Test Quality: 87/100 (A)")
- [ ] Badge format suitable for README or documentation
- [ ] Badge saved to output folder

**Story Update** (if `append_to_story: true` and story file exists):

- [ ] "Test Quality Review" section created
- [ ] Quality score included
- [ ] Critical issues summarized
- [ ] Link to full review report provided
- [ ] Story file updated successfully

---

### Step 7: Save and Notify

**Outputs Saved:**

- [ ] Review report saved to `{output_file}`
- [ ] Inline comments written to test files (if enabled)
- [ ] Quality badge saved (if enabled)
- [ ] Story file updated (if enabled)
- [ ] All outputs are valid and readable

**Summary Message Generated:**

- [ ] Quality score and grade included
- [ ] Critical issue count stated
- [ ] Recommendation provided (Approve/Request changes/Block)
- [ ] Next steps clarified
- [ ] Message displayed to user

---

## Output Validation

### Review Report Completeness

- [ ] All required sections present
- [ ] No placeholder text or TODOs in report
- [ ] All code locations are accurate (file:line)
- [ ] All code examples are valid and demonstrate fix
- [ ] All knowledge base references are correct

### Review Report Accuracy

- [ ] Quality score matches violation breakdown
- [ ] Grade matches score range
- [ ] Violations correctly categorized by severity (P0/P1/P2/P3)
- [ ] Violations correctly attributed to quality criteria
- [ ] No false positives (violations are legitimate issues)
- [ ] No false negatives (critical issues not missed)

### Review Report Clarity

- [ ] Executive summary is clear and actionable
- [ ] Issue explanations are understandable
- [ ] Recommended fixes are implementable
- [ ] Code examples are correct and runnable
- [ ] Recommendation (Approve/Request changes) is clear

---

## Quality Checks

### Knowledge-Based Validation

- [ ] All feedback grounded in knowledge base fragments
- [ ] Recommendations follow proven patterns
- [ ] No arbitrary or opinion-based feedback
- [ ] Knowledge fragment references accurate and relevant

### Actionable Feedback

- [ ] Every issue includes recommended fix
- [ ] Every fix includes code example
- [ ] Code examples demonstrate correct pattern
- [ ] Fixes reference knowledge base for more detail

### Severity Classification

- [ ] Critical (P0) issues are genuinely critical (hard waits, race conditions, no assertions)
- [ ] High (P1) issues impact maintainability/reliability (missing IDs, hardcoded data)
- [ ] Medium (P2) issues are nice-to-have improvements (long files, missing priorities)
- [ ] Low (P3) issues are minor style/preference (verbose tests)

### Context Awareness

- [ ] Review considers project context (some patterns may be justified)
- [ ] Violations with justification comments noted as acceptable
- [ ] Edge cases acknowledged
- [ ] Recommendations are pragmatic, not dogmatic

---

## Integration Points

### Story File Integration

- [ ] Story file discovered correctly (if available)
- [ ] Acceptance criteria extracted and used for context
- [ ] Test quality section appended to story (if enabled)
- [ ] Link to review report added to story

### Test Design Integration

- [ ] Test design document discovered correctly (if available)
- [ ] Priority context (P0/P1/P2/P3) extracted and used
- [ ] Review validates tests align with prioritization
- [ ] Misalignment flagged (e.g., P0 scenario missing tests)

### Knowledge Base Integration

- [ ] tea-index.csv loaded successfully
- [ ] All required fragments loaded
- [ ] Fragments applied correctly to validation
- [ ] Fragment references in report are accurate

---

## Edge Cases and Special Situations

### Empty or Minimal Tests

- [ ] If test file is empty, report notes "No tests found"
- [ ] If test file has only boilerplate, report notes "No meaningful tests"
- [ ] Score reflects lack of content appropriately

### Legacy Tests

- [ ] Legacy tests acknowledged in context
- [ ] Review provides practical recommendations for improvement
- [ ] Recognizes that complete refactor may not be feasible
- [ ] Prioritizes critical issues (flakiness) over style

### Test Framework Variations

- [ ] Review adapts to test framework (Playwright vs Jest vs Cypress)
- [ ] Framework-specific patterns recognized (e.g., Playwright fixtures)
- [ ] Framework-specific violations detected (e.g., Cypress anti-patterns)
- [ ] Knowledge fragments applied appropriately for framework

### Justified Violations

- [ ] Violations with justification comments in code noted as acceptable
- [ ] Justifications evaluated for legitimacy
- [ ] Report acknowledges justified patterns
- [ ] Score not penalized for justified violations

---

## Final Validation

### Review Completeness

- [ ] All enabled quality criteria evaluated
- [ ] All test files in scope reviewed
- [ ] All violations cataloged
- [ ] All recommendations provided
- [ ] Review report is comprehensive

### Review Accuracy

- [ ] Quality score is accurate
- [ ] Violations are correct (no false positives)
- [ ] Critical issues not missed (no false negatives)
- [ ] Code locations are correct
- [ ] Knowledge base references are accurate

### Review Usefulness

- [ ] Feedback is actionable
- [ ] Recommendations are implementable
- [ ] Code examples are correct
- [ ] Review helps developer improve tests
- [ ] Review educates on best practices

### Workflow Complete

- [ ] All checklist items completed
- [ ] All outputs validated and saved
- [ ] User notified with summary
- [ ] Review ready for developer consumption
- [ ] Follow-up actions identified (if any)

---

## Notes

Record any issues, observations, or important context during workflow execution:

- **Test Framework**: [Playwright, Jest, Cypress, etc.]
- **Review Scope**: [single file, directory, full suite]
- **Quality Score**: [0-100 score, letter grade]
- **Critical Issues**: [Count of P0/P1 violations]
- **Recommendation**: [Approve / Approve with comments / Request changes / Block]
- **Special Considerations**: [Legacy code, justified patterns, edge cases]
- **Follow-up Actions**: [Re-review after fixes, pair programming, etc.]
