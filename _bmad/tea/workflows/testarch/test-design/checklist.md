# Test Design and Risk Assessment - Validation Checklist

## Prerequisites (Mode-Dependent)

**System-Level Mode (Phase 3):**

- [ ] PRD exists with functional and non-functional requirements
- [ ] ADR (Architecture Decision Record) exists
- [ ] Architecture document available (architecture.md or tech-spec)
- [ ] Requirements are testable and unambiguous

**Epic-Level Mode (Phase 4):**

- [ ] Story markdown with clear acceptance criteria exists
- [ ] PRD or epic documentation available
- [ ] Architecture documents available (test-design-architecture.md + test-design-qa.md from Phase 3, if exists)
- [ ] Requirements are testable and unambiguous

## Process Steps

### Step 1: Context Loading

- [ ] PRD.md read and requirements extracted
- [ ] Epics.md or specific epic documentation loaded
- [ ] Story markdown with acceptance criteria analyzed
- [ ] Architecture documents reviewed (if available)
- [ ] Existing test coverage analyzed
- [ ] Knowledge base fragments loaded (risk-governance, probability-impact, test-levels, test-priorities)

### Step 2: Risk Assessment

- [ ] Genuine risks identified (not just features)
- [ ] Risks classified by category (TECH/SEC/PERF/DATA/BUS/OPS)
- [ ] Probability scored (1-3 for each risk)
- [ ] Impact scored (1-3 for each risk)
- [ ] Risk scores calculated (probability × impact)
- [ ] High-priority risks (score ≥6) flagged
- [ ] Mitigation plans defined for high-priority risks
- [ ] Owners assigned for each mitigation
- [ ] Timelines set for mitigations
- [ ] Residual risk documented

### Step 3: Coverage Design

- [ ] Acceptance criteria broken into atomic scenarios
- [ ] Test levels selected (E2E/API/Component/Unit)
- [ ] No duplicate coverage across levels
- [ ] Priority levels assigned (P0/P1/P2/P3)
- [ ] P0 scenarios meet strict criteria (blocks core + high risk + no workaround)
- [ ] Data prerequisites identified
- [ ] Tooling/access requirements documented when applicable
- [ ] Execution order defined (smoke → P0 → P1 → P2/P3)

### Step 4: Deliverables Generation

- [ ] Risk assessment matrix created
- [ ] Coverage matrix created
- [ ] Execution order documented
- [ ] Resource estimates calculated
- [ ] Quality gate criteria defined
- [ ] Output file written to correct location
- [ ] Output file uses template structure

## Output Validation

### Risk Assessment Matrix

- [ ] All risks have unique IDs (R-001, R-002, etc.)
- [ ] Each risk has category assigned
- [ ] Probability values are 1, 2, or 3
- [ ] Impact values are 1, 2, or 3
- [ ] Scores calculated correctly (P × I)
- [ ] High-priority risks (≥6) clearly marked
- [ ] Mitigation strategies specific and actionable

### Coverage Matrix

- [ ] All requirements mapped to test levels
- [ ] Priorities assigned to all scenarios
- [ ] Risk linkage documented
- [ ] Test counts realistic
- [ ] Owners assigned where applicable
- [ ] No duplicate coverage (same behavior at multiple levels)

### Execution Strategy

**CRITICAL: Keep execution strategy simple, avoid redundancy**

- [ ] **Simple structure**: PR / Nightly / Weekly (NOT complex smoke/P0/P1/P2 tiers)
- [ ] **PR execution**: All functional tests unless significant infrastructure overhead
- [ ] **Nightly/Weekly**: Only performance, chaos, long-running, manual tests
- [ ] **No redundancy**: Don't re-list all tests (already in coverage plan)
- [ ] **Philosophy stated**: "Run everything in PRs if <15 min, defer only if expensive/long"
- [ ] **Playwright parallelization noted**: 100s of tests in 10-15 min

### Resource Estimates

**CRITICAL: Use intervals/ranges, NOT exact numbers**

- [ ] P0 effort provided as interval range (e.g., "~25-40 hours" NOT "36 hours")
- [ ] P1 effort provided as interval range (e.g., "~20-35 hours" NOT "27 hours")
- [ ] P2 effort provided as interval range (e.g., "~10-30 hours" NOT "15.5 hours")
- [ ] P3 effort provided as interval range (e.g., "~2-5 hours" NOT "2.5 hours")
- [ ] Total effort provided as interval range (e.g., "~55-110 hours" NOT "81 hours")
- [ ] Timeline provided as week range (e.g., "~1.5-3 weeks" NOT "11 days")
- [ ] Estimates include setup time and account for complexity variations
- [ ] **No false precision**: Avoid exact calculations like "18 tests × 2 hours = 36 hours"

### Quality Gate Criteria

- [ ] P0 pass rate threshold defined (should be 100%)
- [ ] P1 pass rate threshold defined (typically ≥95%)
- [ ] High-risk mitigation completion required
- [ ] Coverage targets specified (≥80% recommended)

## Quality Checks

### Evidence-Based Assessment

- [ ] Risk assessment based on documented evidence
- [ ] No speculation on business impact
- [ ] Assumptions clearly documented
- [ ] Clarifications requested where needed
- [ ] Historical data referenced where available

### Risk Classification Accuracy

- [ ] TECH risks are architecture/integration issues
- [ ] SEC risks are security vulnerabilities
- [ ] PERF risks are performance/scalability concerns
- [ ] DATA risks are data integrity issues
- [ ] BUS risks are business/revenue impacts
- [ ] OPS risks are deployment/operational issues

### Priority Assignment Accuracy

**CRITICAL: Priority classification is separate from execution timing**

- [ ] **Priority sections (P0/P1/P2/P3) do NOT include execution context** (e.g., no "Run on every commit" in headers)
- [ ] **Priority sections have only "Criteria" and "Purpose"** (no "Execution:" field)
- [ ] **Execution Strategy section** is separate and handles timing based on infrastructure overhead
- [ ] P0: Truly blocks core functionality + High-risk (≥6) + No workaround
- [ ] P1: Important features + Medium-risk (3-4) + Common workflows
- [ ] P2: Secondary features + Low-risk (1-2) + Edge cases
- [ ] P3: Nice-to-have + Exploratory + Benchmarks
- [ ] **Note at top of Test Coverage Plan**: Clarifies P0/P1/P2/P3 = priority/risk, NOT execution timing

### Test Level Selection

- [ ] E2E used only for critical paths
- [ ] API tests cover complex business logic
- [ ] Component tests for UI interactions
- [ ] Unit tests for edge cases and algorithms
- [ ] No redundant coverage

## Integration Points

### Knowledge Base Integration

- [ ] risk-governance.md consulted
- [ ] probability-impact.md applied
- [ ] test-levels-framework.md referenced
- [ ] test-priorities-matrix.md used
- [ ] Additional fragments loaded as needed

### Status File Integration

- [ ] Test design logged in Quality & Testing Progress
- [ ] Epic number and scope documented
- [ ] Completion timestamp recorded

### Workflow Dependencies

- [ ] Can proceed to `*atdd` workflow with P0 scenarios
- [ ] `*atdd` is a separate workflow and must be run explicitly (not auto-run)
- [ ] Can proceed to `automate` workflow with full coverage plan
- [ ] Risk assessment informs `gate` workflow criteria
- [ ] Integrates with `ci` workflow execution order

## Accountability & Logistics

### Not in Scope

- [ ] Out-of-scope items explicitly listed with reasoning
- [ ] Mitigation noted for each excluded item
- [ ] Exclusions reviewed and accepted by stakeholders

### Entry Criteria

- [ ] Prerequisites for testing start are clearly defined
- [ ] Environment readiness included
- [ ] Test data readiness included
- [ ] Pre-implementation blocker resolution referenced

### Exit Criteria

- [ ] Pass/fail thresholds defined for each priority level
- [ ] Bug severity gate defined (e.g., no open P0/P1 bugs)
- [ ] Coverage sufficiency criteria specified

### Project Team (Optional)

- [ ] If included, key roles identified (QA Lead, Dev Lead, PM, Architect minimum)
- [ ] If included, testing responsibilities mapped to roles
- [ ] If included, names populated where available (placeholders acceptable for draft)

### Tooling & Access (System-Level Only, If Applicable)

- [ ] If non-standard tools or access requests exist, list them
- [ ] Access requirements identified for each tool/service
- [ ] Status tracked (Ready/Pending) when applicable

### Interworking & Regression

- [ ] Impacted services/components identified
- [ ] Regression scope defined per impacted service
- [ ] Cross-team coordination noted where needed

## System-Level Mode: Two-Document Validation

**When in system-level mode (PRD + ADR input), validate BOTH documents:**

### test-design-architecture.md

- [ ] **Purpose statement** at top (serves as contract with Architecture team)
- [ ] **Executive Summary** with scope, business context, architecture decisions, risk summary
- [ ] **Quick Guide** section with three tiers:
  - [ ] 🚨 BLOCKERS - Team Must Decide (pre-implementation critical path items)
  - [ ] ⚠️ HIGH PRIORITY - Team Should Validate (recommendations for approval)
  - [ ] 📋 INFO ONLY - Solutions Provided (no decisions needed)
- [ ] **Risk Assessment** section - **ACTIONABLE**
  - [ ] Total risks identified count
  - [ ] High-priority risks table (score ≥6) with all columns: Risk ID, Category, Description, Probability, Impact, Score, Mitigation, Owner, Timeline
  - [ ] Medium and low-priority risks tables
  - [ ] Risk category legend included
- [ ] **Testability Concerns and Architectural Gaps** section - **ACTIONABLE**
  - [ ] **Sub-section: 🚨 ACTIONABLE CONCERNS** at TOP
    - [ ] Blockers to Fast Feedback table (WHAT architecture must provide)
    - [ ] Architectural Improvements Needed (WHAT must be changed)
    - [ ] Each concern has: Owner, Timeline, Impact
  - [ ] **Sub-section: Testability Assessment Summary** at BOTTOM (FYI)
    - [ ] What Works Well (passing items)
    - [ ] Accepted Trade-offs (no action required)
    - [ ] This section only included if worth mentioning; otherwise omitted
- [ ] **Risk Mitigation Plans** for all high-priority risks (≥6)
  - [ ] Each plan has: Strategy (numbered steps), Owner, Timeline, Status, Verification
  - [ ] **Only Backend/DevOps/Arch/Security mitigations** (production code changes)
  - [ ] QA-owned mitigations belong in QA doc instead
- [ ] **Assumptions and Dependencies** section
  - [ ] **Architectural assumptions only** (SLO targets, replication lag, system design)
  - [ ] Assumptions list (numbered)
  - [ ] Dependencies list with required dates
  - [ ] Risks to plan with impact and contingency
  - [ ] QA execution assumptions belong in QA doc instead
- [ ] **NO test implementation code** (long examples belong in QA doc)
- [ ] **NO test scripts** (no Playwright test(...) blocks, no assertions, no test setup code)
- [ ] **NO NFR test examples** (NFR sections describe WHAT to test, not HOW to test)
- [ ] **NO test scenario checklists** (belong in QA doc)
- [ ] **NO bloat or repetition** (consolidate repeated notes, avoid over-explanation)
- [ ] **Cross-references to QA doc** where appropriate (instead of duplication)
- [ ] **RECIPE SECTIONS NOT IN ARCHITECTURE DOC:**
  - [ ] NO "Test Levels Strategy" section (unit/integration/E2E split belongs in QA doc only)
  - [ ] NO "NFR Testing Approach" section with detailed test procedures (belongs in QA doc only)
  - [ ] NO "Test Environment Requirements" section (belongs in QA doc only)
  - [ ] NO "Recommendations for pre-implementation" section with test framework setup (belongs in QA doc only)
  - [ ] NO "Quality Gate Criteria" section (pass rates, coverage targets belong in QA doc only)
  - [ ] NO "Tool Selection" section (Playwright, k6, etc. belongs in QA doc only)

### test-design-qa.md

**REQUIRED SECTIONS:**

- [ ] **Purpose statement** at top (test execution recipe)
- [ ] **Executive Summary** with risk summary and coverage summary
- [ ] **Dependencies & Test Blockers** section appears near the top (immediately after Executive Summary, or after Not in Scope)
  - [ ] Backend/Architecture dependencies listed (what QA needs from other teams)
  - [ ] QA infrastructure setup listed (factories, fixtures, environments)
  - [ ] Code example with playwright-utils if config.tea_use_playwright_utils is true
  - [ ] Test from '@seontechnologies/playwright-utils/api-request/fixtures'
  - [ ] Expect from '@playwright/test' (playwright-utils does not re-export expect)
  - [ ] Code examples include assertions (no unused imports)
- [ ] **Risk Assessment** section (brief, references Architecture doc)
  - [ ] High-priority risks table
  - [ ] Medium/low-priority risks table
  - [ ] Each risk shows "QA Test Coverage" column (how QA validates)
- [ ] **Test Coverage Plan** with P0/P1/P2/P3 sections
  - [ ] Priority sections have ONLY "Criteria" (no execution context)
  - [ ] Note at top: "P0/P1/P2/P3 = priority, NOT execution timing"
  - [ ] Test tables with columns: Test ID | Requirement | Test Level | Risk Link | Notes
- [ ] **Execution Strategy** section (organized by TOOL TYPE)
  - [ ] Every PR: Playwright tests (~10-15 min)
  - [ ] Nightly: k6 performance tests (~30-60 min)
  - [ ] Weekly: Chaos & long-running (~hours)
  - [ ] Philosophy: "Run everything in PRs unless expensive/long-running"
- [ ] **QA Effort Estimate** section (QA effort ONLY)
  - [ ] Interval-based estimates (e.g., "~1-2 weeks" NOT "36 hours")
  - [ ] NO DevOps, Backend, Data Eng, Finance effort
  - [ ] No per-milestone effort breakdowns in this section
- [ ] **Implementation Planning Handoff** section (optional)
  - [ ] Only include if implementation tasks must be scheduled
  - [ ] Owners assigned (QA/Dev/Platform/etc)
  - [ ] Target milestone may be noted, but avoid detailed per-milestone breakdowns
- [ ] **Appendix A: Code Examples & Tagging**
- [ ] **Appendix B: Knowledge Base References**

**DON'T INCLUDE (bloat):**

- [ ] ❌ NO Quick Reference section
- [ ] ❌ NO System Architecture Summary
- [ ] ❌ NO Test Environment Requirements as separate section (integrate into Dependencies)
- [ ] ❌ NO Testability Assessment section (covered in Dependencies)
- [ ] ❌ NO Test Levels Strategy section (obvious from test scenarios)
- [ ] ❌ NO NFR Readiness Summary
- [ ] ❌ NO Quality Gate Criteria section (teams decide for themselves)
- [ ] ❌ NO Follow-on Workflows section (BMAD commands self-explanatory)
- [ ] ❌ NO Approval section
- [ ] ❌ NO Infrastructure/DevOps/Finance effort tables (out of scope)
- [ ] ❌ NO detailed milestone-by-milestone breakdown tables (use Implementation Planning Handoff if needed)
- [ ] ❌ NO generic Next Steps section (use Implementation Planning Handoff if needed)

### Cross-Document Consistency

- [ ] Both documents reference same risks by ID (R-001, R-002, etc.)
- [ ] Both documents use consistent priority levels (P0, P1, P2, P3)
- [ ] Both documents reference same pre-implementation blockers
- [ ] No duplicate content (cross-reference instead)
- [ ] Dates and authors match across documents
- [ ] ADR and PRD references consistent

### Document Quality (Anti-Bloat Check)

**CRITICAL: Check for bloat and repetition across BOTH documents**

- [ ] **No repeated notes 10+ times** (e.g., "Timing is pessimistic until R-005 fixed" on every section)
- [ ] **Repeated information consolidated** (write once at top, reference briefly if needed)
- [ ] **No excessive detail** that doesn't add value (obvious concepts, redundant examples)
- [ ] **Focus on unique/critical info** (only document what's different from standard practice)
- [ ] **Architecture doc**: Concerns-focused, NOT implementation-focused
- [ ] **QA doc**: Implementation-focused, NOT theory-focused
- [ ] **Clear separation**: Architecture = WHAT and WHY, QA = HOW
- [ ] **Professional tone**: No AI slop markers
  - [ ] Avoid excessive ✅/❌ emojis (use sparingly, only when adding clarity)
  - [ ] Avoid "absolutely", "excellent", "fantastic", overly enthusiastic language
  - [ ] Write professionally and directly
- [ ] **Architecture doc length**: Target ~150-200 lines max (focus on actionable concerns only)
- [ ] **QA doc length**: Keep concise, remove bloat sections

### Architecture Doc Structure (Actionable-First Principle)

**CRITICAL: Validate structure follows actionable-first, FYI-last principle**

- [ ] **Actionable sections at TOP:**
  - [ ] Quick Guide (🚨 BLOCKERS first, then ⚠️ HIGH PRIORITY, then 📋 INFO ONLY last)
  - [ ] Risk Assessment (high-priority risks ≥6 at top)
  - [ ] Testability Concerns (concerns/blockers at top, passing items at bottom)
  - [ ] Risk Mitigation Plans (for high-priority risks ≥6)
- [ ] **FYI sections at BOTTOM:**
  - [ ] Testability Assessment Summary (what works well - only if worth mentioning)
  - [ ] Assumptions and Dependencies
- [ ] **ASRs categorized correctly:**
  - [ ] Actionable ASRs included in 🚨 or ⚠️ sections
  - [ ] FYI ASRs included in 📋 section or omitted if obvious

## BMAD Handoff Validation (System-Level Mode Only)

- [ ] Handoff document generated at `{test_artifacts}/test-design/{project_name}-handoff.md`
- [ ] TEA Artifacts Inventory table populated with actual paths
- [ ] Epic-Level Integration Guidance populated with P0/P1 risks
- [ ] Story-Level Integration Guidance populated with critical test scenarios
- [ ] Risk-to-Story Mapping table populated from risk register
- [ ] Recommended workflow sequence is accurate
- [ ] Phase transition quality gates are defined

## Completion Criteria

**All must be true:**

- [ ] All prerequisites met
- [ ] All process steps completed
- [ ] All output validations passed
- [ ] All quality checks passed
- [ ] All integration points verified
- [ ] Output file(s) complete and well-formatted
- [ ] **System-level mode:** Both documents validated (if applicable)
- [ ] **System-level mode:** Handoff document validated (if applicable)
- [ ] **Epic-level mode:** Single document validated (if applicable)
- [ ] Team review scheduled (if required)

## Post-Workflow Actions

**User must complete:**

1. [ ] Review risk assessment with team
2. [ ] Prioritize mitigation for high-priority risks (score ≥6)
3. [ ] Allocate resources per estimates
4. [ ] Run `*atdd` workflow to generate P0 tests (separate workflow; not auto-run)
5. [ ] Set up test data factories and fixtures
6. [ ] Schedule team review of test design document

**Recommended next workflows:**

1. [ ] Run `atdd` workflow for P0 test generation
2. [ ] Run `framework` workflow if not already done
3. [ ] Run `ci` workflow to configure pipeline stages

## Rollback Procedure

If workflow fails:

1. [ ] Delete output file
2. [ ] Review error logs
3. [ ] Fix missing context (PRD, architecture docs)
4. [ ] Clarify ambiguous requirements
5. [ ] Retry workflow

## Notes

### Common Issues

**Issue**: Too many P0 tests

- **Solution**: Apply strict P0 criteria - must block core AND high risk AND no workaround

**Issue**: Risk scores all high

- **Solution**: Differentiate between high-impact (3) and degraded (2) impacts

**Issue**: Duplicate coverage across levels

- **Solution**: Use test pyramid - E2E for critical paths only

**Issue**: Resource estimates too high or too precise

- **Solution**:
  - Invest in fixtures/factories to reduce per-test setup time
  - Use interval ranges (e.g., "~55-110 hours") instead of exact numbers (e.g., "81 hours")
  - Widen intervals if high uncertainty exists

**Issue**: Execution order section too complex or redundant

- **Solution**:
  - Default: Run everything in PRs (<15 min with Playwright parallelization)
  - Only defer to nightly/weekly if expensive (k6, chaos, 4+ hour tests)
  - Don't create smoke/P0/P1/P2/P3 tier structure
  - Don't re-list all tests (already in coverage plan)

### Best Practices

- Base risk assessment on evidence, not assumptions
- High-priority risks (≥6) require immediate mitigation
- P0 tests should cover <10% of total scenarios
- Avoid testing same behavior at multiple levels
- **Use interval-based estimates** (e.g., "~25-40 hours") instead of exact numbers to avoid false precision and provide flexibility
- **Keep execution strategy simple**: Default to "run everything in PRs" (<15 min with Playwright), only defer if expensive/long-running
- **Avoid execution order redundancy**: Don't create complex tier structures or re-list tests

---

**Checklist Complete**: Sign off when all items validated.

**Completed by:** {name}
**Date:** {date}
**Epic:** {epic title}
**Notes:** {additional notes}
