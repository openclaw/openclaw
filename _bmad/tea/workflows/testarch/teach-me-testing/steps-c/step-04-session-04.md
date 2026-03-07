---
name: "step-04-session-04"
description: "Session 4: Test Design - Risk assessment, test design workflow (60 min)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-04-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 4 - Test Design

## STEP GOAL:

To teach risk assessment and coverage planning using the TEA Test Design workflow in a 60-minute session.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Master Test Architect and Teaching Guide
- ✅ We engage in collaborative learning
- ✅ You bring expertise in TEA methodology

### Step-Specific Rules:

- 🎯 Focus on Session 4 (Test Design)
- 💬 Teach workflow, provide examples

## EXECUTION PROTOCOLS:

- 🎯 Load docs just-in-time
- 💾 Generate notes
- 📖 Update progress
- ⏭️ Return to hub

## MANDATORY SEQUENCE

### 1. Welcome

"🧪 **Session 4: Test Design** (60 minutes)

**Objective:** Learn risk assessment and coverage planning

**What you'll learn:**

- Test Design workflow
- Risk/testability assessment
- Coverage planning with test levels
- Test priorities matrix

Let's plan some tests!"

### 2. Update Progress (Started)

Set session-04-test-design `status: 'in-progress'`, `started_date`.

### 3. Teaching: Test Design Workflow

"### 📐 Test Design Workflow

**Purpose:** Plan tests BEFORE writing them (design before code).

**Workflow Steps:**

1. **Load Context:** Understand feature/system
2. **Risk/Testability Assessment:** Score probability × impact
3. **Coverage Planning:** Determine what to test and how
4. **Generate Test Design Document:** Blueprint for implementation

**When to Use:**

- New features (epic/system level)
- Major refactors
- Quality gate before development

{Role-adapted example}

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-test-design/>"

### 4. Teaching: Risk/Testability Assessment

"### ⚖️ Risk & Testability Assessment

**Risk Scoring:**

- **Probability:** How likely is this to fail? (Low/Medium/High)
- **Impact:** What happens if it fails? (Low/Medium/High)
- **Risk = Probability × Impact**

**Example: Login Feature**

- Probability: High (complex, authentication)
- Impact: High (business critical)
- **Risk: HIGH** → P0 priority

**Example: Tooltip Text**

- Probability: Low (simple rendering)
- Impact: Low (aesthetic only)
- **Risk: LOW** → P3 priority

**Testability:**

- Can we test this easily?
- Are there dependencies blocking us?
- Do we need test infrastructure first?

{Role-adapted example}

**Knowledge Fragments:** probability-impact.md, test-priorities-matrix.md"

### 5. Teaching: Coverage Planning

"### 📋 Coverage Planning

**Test Levels Framework:**

**Unit Tests:** Isolated functions/classes

- Fast, focused
- No external dependencies
- Example: Pure functions, business logic

**Integration Tests:** Multiple components together

- Database, API interactions
- Example: Service layer with DB

**E2E Tests:** Full user workflows

- Browser automation
- Example: Complete checkout flow

**Coverage Strategy:**

- **P0 features:** Unit + Integration + E2E (high confidence)
- **P1 features:** Integration + E2E (good coverage)
- **P2 features:** E2E or Integration (basic coverage)
- **P3 features:** Manual or skip (low priority)

{Role-adapted example}

**Knowledge Fragment:** test-levels-framework.md

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/test-quality-standards/>"

### 6. Teaching: Test Priorities Matrix

"### 📊 Test Priorities Matrix

**P0-P3 Coverage Targets:**

| Priority | Unit | Integration | E2E | Manual |
| -------- | ---- | ----------- | --- | ------ |
| P0       | ✅   | ✅          | ✅  | ✅     |
| P1       | ✅   | ✅          | ✅  | -      |
| P2       | -    | ✅          | -   | ✅     |
| P3       | -    | -           | -   | ✅     |

**Goal:** 100% P0, 80% P1, 50% P2, 20% P3

{Role-adapted example}

**Knowledge Fragment:** test-priorities-matrix.md"

### 7. Quiz (3 questions)

**Q1:** "What does the Test Design workflow help you do?
A) Write tests faster
B) Plan tests BEFORE writing them
C) Run tests in parallel
D) Debug test failures"

Correct: B

**Q2:** "How do you calculate risk?
A) Probability + Impact
B) Probability × Impact
C) Probability - Impact
D) Probability / Impact"

Correct: B

**Q3:** "For P0 features, which test levels should you use?
A) Only E2E tests
B) Only unit tests
C) Unit + Integration + E2E (comprehensive)
D) Manual testing only"

Correct: C

Calculate score, handle <70% retry.

### 8. Generate Session Notes

Create {sessionNotesFile} with Session 4 content, docs, fragments, quiz.

### 9. Update Progress (Completed)

Update session-04-test-design: completed, score, notes.
Increment sessions_completed, update percentage.
Append 'step-04-session-04' to stepsCompleted.
Set next_recommended: 'session-05-atdd-automate'.

### 10. Complete Message

"🎉 **Session 4 Complete!** Score: {score}/100
You can now plan tests using risk assessment!
Progress: {completion_percentage}%"

### 11. Menu

[A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

Return to {nextStepFile}.

---

## 🚨 SUCCESS METRICS

✅ Test Design workflow taught, quiz passed, notes generated, progress updated, returned to hub.

**Master Rule:** Teach planning, quiz, update, return.
