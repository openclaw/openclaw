---
name: "step-04-session-02"
description: "Session 2: Core Concepts - Risk-based testing, DoD, testing philosophy (45 min)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-02-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 2 - Core Concepts

## STEP GOAL:

To teach testing fundamentals including risk-based testing, TEA quality standards (Definition of Done), and testing as engineering philosophy in a 45-minute session.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Master Test Architect and Teaching Guide
- ✅ We engage in collaborative learning, not lectures
- ✅ You bring expertise in TEA methodology and teaching pedagogy
- ✅ Learner brings their role context, experience, and learning goals
- ✅ Together we build their testing knowledge progressively

### Step-Specific Rules:

- 🎯 Focus ONLY on Session 2 content (Core Concepts)
- 🚫 FORBIDDEN to skip ahead to other sessions
- 💬 Approach: Teach fundamentals, provide examples, quiz understanding
- 🚪 Teaching is mostly autonomous, quiz is collaborative
- 📚 Reference TEA docs and knowledge fragments

## EXECUTION PROTOCOLS:

- 🎯 Load TEA docs just-in-time
- 💾 Generate session notes after completion
- 📖 Update progress file with session completion and score
- 🚫 FORBIDDEN to skip quiz - validates understanding
- ⏭️ Always return to session menu hub after completion

## CONTEXT BOUNDARIES:

- Available context: Progress file with user role/experience
- Focus: Session 2 - Testing fundamentals and TEA principles
- Limits: Only Session 2 content
- Dependencies: Progress file exists with assessment data

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Session Welcome

Display:

"🧪 **Session 2: Core Concepts** (45 minutes)

**Objective:** Understand WHY behind TEA principles

**What you'll learn:**

- Testing as Engineering philosophy
- Risk-based testing with P0-P3 matrix
- TEA Definition of Done (quality standards)
- Probability × Impact risk scoring

Let's dive into the fundamentals!"

### 2. Update Progress File (Session Started)

Load {progressFile} and update session-02-concepts:

- Set `status: 'in-progress'`
- Set `started_date: {current_date}`

Save the updated progress file.

### 3. Teaching: Testing as Engineering

Present this content:

"### 🏗️ Testing as Engineering

**Core Philosophy:** Testing is not an afterthought - it's engineering.

**What this means:**

- Tests are **designed** before they're written (like architecture before coding)
- Tests have **quality standards** (not just "does it run?")
- Tests are **maintained** like production code
- Testing decisions are **risk-based** (prioritize what matters)

{If role == QA:}
**For QA Engineers:** You're not just finding bugs - you're engineering test systems that scale. Design before write, maintain like production code.

{If role == Dev:}
**For Developers:** Think of tests like you think of production code. Design patterns, refactoring, DRY principles - they all apply to tests.

{If role == Lead:}
**For Tech Leads:** Testing as engineering means architecture decisions: fixture patterns, data strategies, CI orchestration. Not just "write more tests."

{If role == VP:}
**For VPs:** Testing is an engineering discipline requiring investment in tooling, architecture, and knowledge. Not a checklist item.

**Key Principle:** If you wouldn't accept sloppy production code, don't accept sloppy test code.

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/testing-as-engineering/>"

### 4. Teaching: Risk-Based Testing

Present this content:

"### ⚖️ Risk-Based Testing: The P0-P3 Matrix

**Problem:** You can't test everything. How do you prioritize?

**Solution:** Risk = Probability × Impact

**The P0-P3 Matrix:**

**P0 - Critical (Must Test)**

- Login/Authentication
- Payment processing
- Data loss scenarios
- Security vulnerabilities
- **Impact:** Business fails if broken
- **Probability:** High usage, high complexity

**P1 - High (Should Test)**

- Core user workflows
- Key features
- Data integrity
- **Impact:** Major user pain
- **Probability:** Frequent usage

**P2 - Medium (Nice to Test)**

- Secondary features
- Edge cases with workarounds
- **Impact:** Inconvenience
- **Probability:** Moderate usage

**P3 - Low (Optional)**

- Tooltips, help text
- Nice-to-have features
- Aesthetic issues
- **Impact:** Minimal
- **Probability:** Low usage

{If role == QA:}
**For QA Engineers:** Use P0-P3 to defend test coverage decisions. "We have 100% P0 coverage, 80% P1" is better than "we have 50% coverage overall."

{If role == Dev:}
**For Developers:** When writing tests, ask "Is this P0 login or P3 tooltip?" Focus your time accordingly.

{If role == Lead:}
**For Tech Leads:** P0-P3 helps allocate test automation budget. Mandate P0/P1 automation, P2/P3 is cost-benefit analysis.

{If role == VP:}
**For VPs:** Risk-based testing aligns engineering effort with business impact. Metrics that matter: P0 coverage, not lines of code.

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/risk-based-testing/>

**Knowledge Fragment:** probability-impact.md defines scoring criteria"

### 5. Teaching: Definition of Done (Quality Standards)

Present this content:

"### ✅ TEA Definition of Done: Quality Standards

**The Problem:** "The tests pass" isn't enough. What about quality?

**TEA Definition of Done ensures:**

**1. No Flaky Tests**

- Tests pass/fail deterministically
- No "run it again, it'll work" tests
- Use explicit waits, not hard sleeps
- Handle async properly

**2. No Hard Waits/Sleeps**

- Use `waitFor` conditions, not `sleep(5000)`
- React to state changes, don't guess timing
- Tests complete when ready, not after arbitrary delays

**3. Stateless & Parallelizable**

- Tests run independently, any order
- No shared state between tests
- Can run in parallel (fast feedback)
- Use cron jobs/semaphores only when unavoidable

**4. No Order Dependency**

- Every `it`/`describe`/`context` block works in isolation
- Supports `.only` execution for debugging
- Tests don't depend on previous tests

**5. Self-Cleaning Tests**

- Test sets up its own data
- Test automatically deletes/deactivates entities created
- No manual cleanup required

**6. Tests Live Near Source Code**

- Co-locate test files with code they validate
- `component.tsx` → `component.spec.tsx` in same folder

**7. Low Maintenance**

- Minimize manual upkeep
- Avoid brittle selectors
- Use APIs to set up state, not UI clicks
- Don't repeat UI actions

{If role == QA:}
**For QA Engineers:** These standards prevent the "test maintenance nightmare." Upfront investment in quality = long-term stability.

{If role == Dev:}
**For Developers:** Write tests you'd want to inherit. No flaky tests, no "run twice" culture, no mystery failures.

{If role == Lead:}
**For Tech Leads:** Enforce these standards in code review. Flaky test PRs don't merge. Period.

{If role == VP:}
**For VPs:** Definition of Done isn't perfectionism - it's engineering rigor. Flaky tests erode trust in CI/CD.

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/test-quality-standards/>

**Knowledge Fragment:** test-quality.md has execution limits and criteria"

### 6. Teaching: Key Takeaways

Present this content:

"### 🎯 Session 2 Key Takeaways

**1. Testing is Engineering**

- Design before write
- Maintain like production code
- Apply engineering principles

**2. Risk-Based Testing**

- P0 = Critical (login, payment)
- P1 = High (core workflows)
- P2 = Medium (secondary features)
- P3 = Low (tooltips, nice-to-have)
- Prioritize based on Probability × Impact

**3. Definition of Done**

- No flaky tests (deterministic)
- No hard waits (use waitFor)
- Stateless & parallelizable
- Self-cleaning tests
- Low maintenance

**4. Quality Standards = Engineering Rigor**

- Not perfectionism, but reliability
- Prevents test maintenance nightmares
- Builds trust in CI/CD

**You now understand the WHY behind TEA principles!**"

### 7. Quiz: Validate Understanding

Display:

"### ✅ Knowledge Check

3 questions to validate your understanding. Passing: ≥70% (2 of 3 correct)."

**Question 1:**

"**Question 1 of 3:**

In the P0-P3 matrix, what priority level should login/authentication have?

A) P3 - Low priority
B) P2 - Medium priority
C) P1 - High priority
D) P0 - Critical priority

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: D
- If correct: "✅ Correct! Login/authentication is P0 - critical. Business fails if broken."
- If incorrect: "❌ Login/authentication is P0 - Critical (D). It's high usage, high impact, and business-critical."

**Store result**

**Question 2:**

"**Question 2 of 3:**

What is the problem with using `sleep(5000)` instead of `waitFor` conditions?

A) It makes tests slower
B) It's a hard wait that doesn't react to state changes (violates DoD)
C) It uses too much memory
D) It's not supported in modern frameworks

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: B
- If correct: "✅ Correct! Hard waits don't react to state - they guess timing. Use `waitFor` to react to conditions."
- If incorrect: "❌ The issue is that hard waits don't react to state changes (B). They guess timing instead of waiting for conditions. This violates TEA Definition of Done."

**Store result**

**Question 3:**

"**Question 3 of 3:**

What does "self-cleaning tests" mean in TEA Definition of Done?

A) Tests automatically fix their own bugs
B) Tests delete/deactivate entities they create during testing
C) Tests run faster by cleaning up code
D) Tests remove old test files

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: B
- If correct: "✅ Correct! Self-cleaning tests clean up their data - no manual cleanup needed."
- If incorrect: "❌ Self-cleaning means tests delete/deactivate entities they created (B). No manual cleanup required."

**Store result**

**Calculate score:**

- Total points / 3 \* 100 = score (0-100)

**Display results:**

"**Quiz Results:** {score}/100

{If score >= 70:}
✅ **Passed!** You understand core testing concepts.

{If score < 70:}
⚠️ **Below passing.** Would you like to:

- **[R]** Review the content again
- **[C]** Continue anyway (score will be recorded)

{Wait for response if < 70, handle R or C}"

### 8. Generate Session Notes

Create {sessionNotesFile} using {sessionNotesTemplate} with session-02 content including:

- Teaching topics covered
- TEA docs referenced
- Knowledge fragments referenced (test-quality.md, probability-impact.md)
- Quiz results
- Key takeaways
- Next recommended session based on experience level

### 9. Update Progress File (Session Complete)

Load {progressFile} and update session-02-concepts:

- Set `status: 'completed'`
- Set `completed_date: {current_date}`
- Set `score: {score}`
- Set `notes_artifact: '{sessionNotesFile}'`

Update progress metrics:

- Increment `sessions_completed` by 1
- Calculate `completion_percentage`
- Set `next_recommended: 'session-03-architecture'`

Update stepsCompleted array:

- Append 'step-04-session-02'
- Update lastStep

Save the updated progress file.

### 10. Session Complete Message

Display:

"🎉 **Session 2 Complete!**

**Your Score:** {score}/100

**Session notes saved:** {sessionNotesFile}

You now understand:

- Testing as engineering philosophy
- Risk-based testing (P0-P3 matrix)
- TEA Definition of Done
- Why quality standards matter

**Next:** Session 3 (Architecture & Patterns) or explore any session from the menu.

**Progress:** {completion_percentage}% complete ({sessions_completed} of 7 sessions)"

### 11. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Progress file already updated, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Teaching content presented (Testing as Engineering, Risk-based, DoD)
- Examples adapted to user role
- Quiz administered (3 questions)
- Score calculated correctly
- Session notes generated
- Progress file updated
- stepsCompleted array updated
- User routed back to hub

### ❌ SYSTEM FAILURE:

- Skipping quiz
- Not adapting to role
- Not generating notes
- Not updating progress
- Not routing to hub

**Master Rule:** Teach, quiz, generate notes, update progress, return to hub.
