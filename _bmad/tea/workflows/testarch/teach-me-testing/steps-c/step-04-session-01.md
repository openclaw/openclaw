---
name: "step-04-session-01"
description: "Session 1: Quick Start - TEA Lite intro, run automate workflow (30 min)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-01-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 1 - Quick Start

## STEP GOAL:

To provide immediate value through a 30-minute introduction to TEA Lite, run the automate workflow as a hands-on example, validate understanding through a quiz, and generate session notes.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate _unsolicited_ content without user input (session flow content is allowed once session begins)
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

- 🎯 Focus ONLY on Session 1 content (Quick Start)
- 🚫 FORBIDDEN to skip ahead to other sessions
- 💬 Approach: Teach concepts, provide examples, quiz understanding
- 🚪 Teaching is mostly autonomous, quiz is collaborative
- 📚 Reference TEA docs and provide URLs for further reading

## EXECUTION PROTOCOLS:

- 🎯 Load TEA docs just-in-time (not all at once)
- 💾 Generate session notes after completion
- 📖 Update progress file with session completion and score
- 🚫 FORBIDDEN to skip quiz - validates understanding
- ⏭️ Always return to session menu hub after completion

## CONTEXT BOUNDARIES:

- Available context: Progress file with user role/experience
- Focus: Session 1 - TEA Lite introduction
- Limits: Only Session 1 content, don't preview other sessions
- Dependencies: Progress file exists with assessment data

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Session Welcome

Display:

"🧪 **Session 1: Quick Start** (30 minutes)

**Objective:** Get immediate value by seeing TEA in action

**What you'll learn:**

- What is TEA and why it exists
- TEA Lite quick start approach
- How to run your first TEA workflow (Automate)
- TEA engagement models

Let's get started!"

### 2. Update Progress File (Session Started)

Load {progressFile} and update session-01-quickstart:

- Set `status: 'in-progress'`
- Set `started_date: {current_date}`

Save the updated progress file.

### 3. Teaching: What is TEA?

Present this content (mostly autonomous, clear and educational):

"### 📖 What is TEA (Test Architecture Enterprise)?

TEA is a comprehensive test architecture framework that provides:

- **9 Workflows:** Teach Me Testing, Framework, Test Design, ATDD, Automate, Test Review, Trace, NFR Assessment, CI
- **35 Knowledge Fragments:** Distilled expertise on patterns, best practices, Playwright Utils
- **Quality Standards:** Definition of Done with execution limits (no flaky tests, no hard waits, etc.)
- **Risk-Based Testing:** P0-P3 matrix for prioritizing test coverage

**Why TEA exists:**
Testing knowledge doesn't scale through manual teaching. TEA makes testing expertise accessible through:

- Structured workflows that guide you step-by-step
- Documentation (32 docs) organized by type (tutorials, how-to, explanation, reference)
- Knowledge fragments for just-in-time learning
- Online resources: <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/>

**TEA Engagement Models:**

1. **TEA Lite (30 min):** Quick start - run Automate workflow, generate tests
2. **TEA Solo:** Use workflows individually as needed
3. **TEA Integrated:** Full lifecycle - Framework → Test Design → ATDD/Automate → Review → Trace
4. **TEA Enterprise:** Add NFR Assessment + CI integration for compliance
5. **TEA Brownfield:** Adapt TEA for existing test suites

**Today we're experiencing TEA Lite!**"

### 4. Teaching: TEA Lite Quick Start

Present this content (adapt examples based on user role from progress file):

"### 🚀 TEA Lite: Your First Workflow

The **Automate workflow** generates tests for your application automatically.

**How it works:**

1. You describe what needs testing
2. TEA analyzes your app structure
3. Workflow generates test files with TEA best practices
4. You review and run the tests

{If role == QA:}
**For QA Engineers:** This helps you quickly expand test coverage without writing every test manually. Focus on test design, let TEA handle boilerplate.

{If role == Dev:}
**For Developers:** This generates tests following best practices so you can focus on implementation. Tests are maintainable and follow fixture patterns.

{If role == Lead:}
**For Tech Leads:** This standardizes test architecture across your team. Everyone writes tests the same way using TEA patterns.

{If role == VP:}
**For VPs:** This scales testing across teams without manual training. New hires can generate quality tests from day one.

**Let me show you how the Automate workflow works conceptually:**

1. **Input:** You provide targets (features/pages to test)
2. **TEA analyzes:** Understands your app structure
3. **Test generation:** Creates API and/or E2E tests
4. **Output:** Test files in your test suite with proper fixtures

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-automate/>

**Note:** We won't actually run the workflow now (you can do that on your project later), but you understand the concept."

### 5. Teaching: Key Concepts

Present this content:

"### 🎯 Key Concepts from Session 1

**1. TEA is a framework:** Not just docs, but executable workflows that guide you

**2. Risk-based testing:** Prioritize what matters (P0 critical, P3 nice-to-have)

**3. Quality standards:** Definition of Done ensures reliable tests

- No flaky tests
- No hard waits/sleeps
- Stateless & parallelizable
- Self-cleaning tests

**4. Engagement models:** Choose how much TEA you need (Lite → Solo → Integrated → Enterprise → Brownfield)

**5. Knowledge fragments:** 35 fragments for deep-dive topics when you need them

- Testing patterns (fixtures, network-first, data factories)
- Playwright Utils (api-request, network-recorder, recurse)
- Configuration & governance (CI, feature flags, risk)

**You've now experienced TEA Lite! In future sessions, we'll go deeper.**"

### 6. Quiz: Validate Understanding

Display:

"### ✅ Quick Knowledge Check

Let me ask you 3 questions to validate your understanding. Passing score: ≥70% (2 of 3 correct)."

**Question 1:**

"**Question 1 of 3:**

What is the primary purpose of TEA?

A) Replace all testing tools with a single framework
B) Make testing expertise accessible through structured workflows and knowledge
C) Automate 100% of test writing
D) Only works for Playwright tests

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: B
- If correct: "✅ Correct! TEA makes testing expertise accessible and scalable."
- If incorrect: "❌ Not quite. TEA's purpose is to make testing expertise accessible through structured workflows and knowledge (B). It's not about replacing tools or automating everything."

**Store result (1 point if correct, 0 if incorrect)**

**Question 2:**

"**Question 2 of 3:**

What does the P0-P3 risk matrix help with?

A) Prioritizing test coverage based on criticality
B) Grading test code quality
C) Measuring test execution speed
D) Tracking bug severity

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: A
- If correct: "✅ Correct! P0-P3 helps prioritize what to test based on risk and criticality."
- If incorrect: "❌ The P0-P3 matrix is about prioritizing test coverage (A). P0 = critical features like login, P3 = nice-to-have like tooltips."

**Store result**

**Question 3:**

"**Question 3 of 3:**

Which TEA engagement model is best for quick value in 30 minutes?

A) TEA Enterprise
B) TEA Lite
C) TEA Integrated
D) TEA Brownfield

Your answer (A, B, C, or D):"

**Wait for response. Validate:**

- Correct answer: B
- If correct: "✅ Correct! TEA Lite is the 30-minute quick start approach."
- If incorrect: "❌ TEA Lite (B) is the quick start approach. Enterprise and Integrated are more comprehensive."

**Store result**

**Calculate score:**

- Total points / 3 \* 100 = score (0-100)

**Display results:**

"**Quiz Results:** {score}/100

{If score >= 70:}
✅ **Passed!** You've demonstrated understanding of Session 1 concepts.

{If score < 70:}
⚠️ **Below passing threshold.** Would you like to:

- **[R]** Review the content again
- **[C]** Continue anyway (your score will be recorded)

{Wait for response if < 70, handle R or C}"

### 7. Generate Session Notes

Create {sessionNotesFile} using {sessionNotesTemplate} with:

```markdown
---
session_id: session-01-quickstart
session_name: "Session 1: Quick Start"
user: { user_name }
role: { role }
completed_date: { current_date }
score: { score }
duration: "30 min"
---

# Session 1: Quick Start - Session Notes

**Learner:** {user_name} ({role})
**Completed:** {current_date}
**Score:** {score}/100
**Duration:** 30 min

---

## Session Objectives

- Understand what TEA is and why it exists
- Learn TEA Lite quick start approach
- Conceptually understand the Automate workflow
- Explore TEA engagement models

---

## Key Concepts Covered

1. **TEA Framework:** 9 workflows + 35 knowledge fragments + quality standards
2. **Risk-Based Testing:** P0-P3 prioritization matrix
3. **Quality Standards:** Definition of Done (no flaky tests, no hard waits, stateless, self-cleaning)
4. **Engagement Models:** Lite, Solo, Integrated, Enterprise, Brownfield
5. **Automate Workflow:** Generates tests automatically with TEA best practices

---

## TEA Resources Referenced

### Documentation

- TEA Overview: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/tea-overview/
- TEA Lite Quickstart: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/tutorials/tea-lite-quickstart/
- Automate Workflow: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/how-to/workflows/run-automate/

### Knowledge Fragments

- (None used in this session - knowledge fragments explored in Session 7)

### Online Resources

- TEA Website: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/
- Knowledge Base: https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/reference/knowledge-base/

---

## Quiz Results

**Score:** {score}/100

### Questions & Answers

1. What is the primary purpose of TEA? → {user_answer} ({correct/incorrect})
2. What does the P0-P3 risk matrix help with? → {user_answer} ({correct/incorrect})
3. Which TEA engagement model is best for quick value? → {user_answer} ({correct/incorrect})

---

## Key Takeaways

- TEA makes testing expertise accessible at scale
- Start with TEA Lite (30 min) for immediate value
- Risk-based testing prioritizes what matters (P0 critical features first)
- Quality standards ensure reliable, maintainable tests
- 5 engagement models let you choose the right level of TEA adoption

---

## Next Recommended Session

{If experience_level == 'beginner':}
**Session 2: Core Concepts** - Learn testing fundamentals and TEA principles

{If experience_level == 'intermediate':}
**Session 2 or 3** - Review concepts or dive into architecture patterns

{If experience_level == 'experienced':}
**Session 7: Advanced Patterns** - Explore 35 knowledge fragments

---

**Generated by:** TEA Academy - Teach Me Testing Workflow
**Session Path:** Session 1 of 7
```

### 8. Update Progress File (Session Complete)

Load {progressFile} and update session-01-quickstart:

- Set `status: 'completed'`
- Set `completed_date: {current_date}`
- Set `score: {score}`
- Set `notes_artifact: '{sessionNotesFile}'`

Update progress metrics:

- If previous status for `session-01-quickstart` is not `completed`, increment `sessions_completed` by 1 (otherwise leave unchanged)
- Calculate `completion_percentage: (sessions_completed / 7) * 100`
- Set `next_recommended: 'session-02-concepts'`

Update stepsCompleted array:

- Append 'step-04-session-01' to stepsCompleted array
- Update lastStep: 'step-04-session-01'

Save the updated progress file.

### 9. Session Complete Message

Display:

"🎉 **Session 1 Complete!**

**Your Score:** {score}/100

**Session notes saved:** {sessionNotesFile}

You've completed your first step in TEA Academy! You now understand what TEA is, how TEA Lite works, and the different engagement models.

**Next:** You'll return to the session menu where you can choose Session 2 or explore any other session.

**Progress:** {completion_percentage}% complete ({sessions_completed} of 7 sessions)"

### 10. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to session menu when user selects 'C'
- After other menu items execution, return to this menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Progress file already updated in step 8, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then [Redisplay Menu Options](#10-present-menu-options)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Teaching content presented clearly
- Examples adapted to user role
- Quiz administered with 3 questions
- Score calculated correctly (0-100)
- Session notes generated with all required sections
- Progress file updated (status: completed, score, notes_artifact)
- stepsCompleted array updated with 'step-04-session-01'
- Completion percentage recalculated
- Next recommended session set
- User routed back to session menu hub

### ❌ SYSTEM FAILURE:

- Skipping quiz
- Not adapting examples to user role
- Not generating session notes
- Not updating progress file
- Not updating stepsCompleted array
- Not calculating completion percentage
- Not routing back to hub
- Loading all docs at once (should be just-in-time)

**Master Rule:** Teach, quiz, generate notes, update progress, return to hub. This pattern repeats for all 7 sessions.
