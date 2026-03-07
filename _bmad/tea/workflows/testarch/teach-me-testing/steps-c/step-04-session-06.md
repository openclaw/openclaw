---
name: "step-04-session-06"
description: "Session 6: Quality & Trace - Test review, traceability, quality metrics (45 min)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-06-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 6 - Quality & Trace

## STEP GOAL:

To teach test quality auditing and requirements traceability using Test Review and Trace workflows in a 45-minute session.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate _unsolicited_ content without user input (session flow content is allowed once session begins)
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ Master Test Architect and Teaching Guide
- ✅ Collaborative learning

### Step-Specific Rules:

- 🎯 Focus on Session 6 (Quality & Trace)
- 💬 Teach quality metrics

## EXECUTION PROTOCOLS:

- 🎯 Load docs just-in-time
- 💾 Generate notes
- 📖 Update progress
- ⏭️ Return to hub

## MANDATORY SEQUENCE

### 1. Welcome

"🧪 **Session 6: Quality & Trace** (45 minutes)

**Objective:** Audit quality and ensure traceability

**What you'll learn:**

- Test Review workflow (quality scoring)
- 5 dimensions of test quality
- Trace workflow (requirements traceability)
- Release gate decisions

Let's ensure quality!"

### 2. Update Progress (Started)

Set session-06-quality-trace `status: 'in-progress'`.

### 3. Teaching: Test Review Workflow

"### 🔍 Test Review Workflow

**Purpose:** Audit test quality with 0-100 scoring

**5 Dimensions of Quality:**

**1. Determinism (0-100)**

- Tests pass/fail consistently
- No flakiness, no randomness
- Proper async handling

**2. Isolation (0-100)**

- Tests run independently
- No shared state
- Parallelizable

**3. Assertions (0-100)**

- Correct checks for expected behavior
- Meaningful assertions (not just presence)
- Fails for the right reasons

**4. Structure (0-100)**

- Readable test code
- Clear organization and naming
- Minimal duplication

**5. Performance (0-100)**

- Test execution speed
- Resource usage
- Parallel efficiency

**Overall Score = Average of 5 dimensions**

{Role-adapted example}

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-test-review/>"

### 4. Teaching: Trace Workflow

"### 🔗 Trace Workflow: Requirements Traceability

**Purpose:** Map tests to requirements, make release gate decision

**Trace Workflow:**

1. **Load Context:** Understand acceptance criteria
2. **Discover Tests:** Find all test files
3. **Map Criteria:** Link tests to requirements
4. **Analyze Gaps:** What's not tested?
5. **Gate Decision:** GREEN (ship) or RED (block)

**Release Gate Logic:**

- **GREEN:** All P0/P1 criteria have tests, gaps are P2/P3
- **YELLOW:** Some P1 gaps, assess risk
- **RED:** P0 gaps exist, DO NOT SHIP

{Role-adapted example}

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-trace/>"

### 5. Teaching: Quality Metrics

"### 📊 Quality Metrics That Matter

**Track:**

- **P0/P1 Coverage %** (not total line coverage)
- **Flakiness Rate** (flaky tests / total tests)
- **Test Execution Time** (feedback loop speed)
- **Determinism Score** (from Test Review)

**Don't Track (Vanity Metrics):**

- Total line coverage % (tells you nothing about risk)
- Number of tests (quantity ≠ quality)
- Test file count (irrelevant)

{Role-adapted example}

**Goal:** High P0/P1 coverage, zero flakiness, fast execution."

### 6. Quiz (3 questions)

**Q1:** "What are the 5 dimensions in Test Review workflow?
A) Speed, cost, coverage, bugs, time
B) Determinism, Isolation, Assertions, Structure, Performance
C) Unit, integration, E2E, manual, exploratory
D) P0, P1, P2, P3, P4"

Correct: B

**Q2:** "When should the Trace workflow gate decision be RED (block release)?
A) Any test failures exist
B) P0 gaps exist (critical requirements not tested)
C) Code coverage is below 80%
D) Tests are slow"

Correct: B

**Q3:** "Which metric matters most for quality?
A) Total line coverage %
B) Number of tests written
C) P0/P1 coverage %
D) Test file count"

Correct: C

Calculate score, handle <70% retry.

### 7. Generate Session Notes

Create {sessionNotesFile} with Session 6 content, Test Review + Trace workflows, quality metrics.

### 8. Update Progress (Completed)

Update session-06-quality-trace: completed, score, notes.
Increment sessions_completed, update percentage.
Append 'step-04-session-06' to stepsCompleted.
Set next_recommended: 'session-07-advanced'.

### 9. Complete Message

"🎉 **Session 6 Complete!** Score: {score}/100
You can now audit quality and ensure traceability!
Progress: {completion_percentage}%"

### 10. Menu

[A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

Return to {nextStepFile}.

---

## 🚨 SUCCESS METRICS

✅ Test Review and Trace taught, quality dimensions explained, quiz passed, notes generated, returned to hub.
