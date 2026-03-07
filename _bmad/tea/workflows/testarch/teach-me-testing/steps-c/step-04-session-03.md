---
name: "step-04-session-03"
description: "Session 3: Architecture & Patterns - Fixtures, network patterns, framework setup (60 min)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-03-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 3 - Architecture & Patterns

## STEP GOAL:

To teach TEA architecture patterns including fixture composition, network-first patterns, and step-file architecture in a 60-minute session.

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

### Step-Specific Rules:

- 🎯 Focus ONLY on Session 3 content (Architecture & Patterns)
- 🚫 FORBIDDEN to skip ahead to other sessions
- 💬 Approach: Teach patterns, provide examples, quiz understanding

## EXECUTION PROTOCOLS:

- 🎯 Load TEA docs just-in-time
- 💾 Generate session notes after completion
- 📖 Update progress file with session completion and score
- ⏭️ Return to session menu hub after completion

## CONTEXT BOUNDARIES:

- Available context: Progress file with user role/experience
- Focus: Session 3 - Architecture patterns
- Dependencies: Progress file exists

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly.

### 1. Session Welcome

"🧪 **Session 3: Architecture & Patterns** (60 minutes)

**Objective:** Understand TEA patterns and architecture

**What you'll learn:**

- Fixture architecture and composition
- Network-first patterns
- Data factories and test setup
- Step-file architecture (the pattern this workflow uses!)

Let's explore TEA architecture!"

### 2. Update Progress (Started)

Load {progressFile}, update session-03-architecture:

- `status: 'in-progress'`
- `started_date: {current_date}`

### 3. Teaching: Fixture Architecture

"### 🏗️ Fixture Architecture

**The Problem:** Tests have setup/teardown boilerplate everywhere.

**TEA Solution:** Composable fixtures

**Fixture Composition Pattern:**

```typescript
// Base fixtures
const baseFixtures = {
  page: async ({}, use) => {
    /* ... */
  },
};

// Composed fixtures
const authFixtures = {
  authenticatedPage: async ({ page }, use) => {
    await page.goto("/login");
    await login(page);
    await use(page);
  },
};

// Merge and use
test.use(mergeTests(baseFixtures, authFixtures));
```

**Benefits:**

- DRY: Define once, use everywhere
- Composable: Build complex fixtures from simple ones
- Automatic cleanup: Fixtures handle teardown
- Type-safe: Full TypeScript support

{Role-adapted example based on user role}

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/fixture-architecture/>
**Knowledge Fragment:** fixture-architecture.md, fixtures-composition.md"

### 4. Teaching: Network-First Patterns

"### 🌐 Network-First Patterns

**The Problem:** Flaky tests due to network timing issues.

**TEA Solution:** Intercept and control network

**Network-First Pattern:**

```typescript
// BEFORE the action, set up network interception
await page.route("/api/users", (route) => {
  route.fulfill({ json: mockUsers });
});

// THEN trigger the action
await page.click("Load Users");

// Network is already mocked - no race condition
```

**Why Network-First:**

- Prevents race conditions
- Deterministic test behavior
- Fast (no real API calls)
- Control error scenarios

{Role-adapted example}

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/network-first-patterns/>
**Knowledge Fragment:** network-first.md, intercept-network-call.md"

### 5. Teaching: Data Factories

"### 🏭 Data Factories

**The Problem:** Hard-coded test data everywhere.

**TEA Solution:** Factory functions

**Factory Pattern:**

```typescript
function createUser(overrides = {}) {
  return {
    id: faker.uuid(),
    email: faker.email(),
    role: "user",
    ...overrides,
  };
}

// Use in tests
const admin = createUser({ role: "admin" });
const user = createUser(); // defaults
```

**Benefits:**

- No hardcoded data
- Easy to override fields
- Consistent test data
- Self-documenting

{Role-adapted example}

**Knowledge Fragment:** data-factories.md"

### 6. Teaching: Step-File Architecture

"### 📋 Step-File Architecture

**This workflow uses step-file architecture!**

**Pattern:**

- Micro-file design: Each step is self-contained
- Just-in-time loading: Only current step in memory
- Sequential enforcement: No skipping steps
- State tracking: Progress saved between steps

**Why:**

- Disciplined execution
- Clear progression
- Resumable (continuable workflows)
- Maintainable (one file per step)

**You're experiencing this right now:** Each session is a step file!

**Documentation:** <https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/explanation/step-file-architecture/>"

### 7. Quiz (3 questions)

"### ✅ Knowledge Check"

**Q1:** "What is the main benefit of fixture composition?
A) Faster test execution
B) DRY - define once, reuse everywhere
C) Better error messages
D) Automatic screenshot capture"

Correct: B

**Q2:** "Why is 'network-first' better than mocking after the action?
A) It's faster
B) It prevents race conditions
C) It uses less memory
D) It's easier to write"

Correct: B

**Q3:** "What pattern does this teaching workflow use?
A) Page Object Model
B) Behavior Driven Development
C) Step-File Architecture
D) Test Pyramid"

Correct: C

Calculate score, handle <70% retry option.

### 8. Generate Session Notes

Create {sessionNotesFile} with:

- Session 3 content
- Topics: Fixtures, network-first, data factories, step-file architecture
- TEA docs referenced
- Knowledge fragments: fixture-architecture.md, network-first.md, data-factories.md
- Quiz results
- Next recommended: session-04-test-design

### 9. Update Progress (Completed)

Update session-03-architecture:

- `status: 'completed'`
- `completed_date: {current_date}`
- `score: {score}`
- `notes_artifact`

Increment sessions_completed, update completion_percentage.
Append 'step-04-session-03' to stepsCompleted.

### 10. Complete Message

"🎉 **Session 3 Complete!** Score: {score}/100
You understand TEA architecture patterns!
Progress: {completion_percentage}%"

### 11. Menu

[A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

Return to {nextStepFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Architecture patterns taught
- Quiz administered
- Notes generated
- Progress updated
- Returned to hub

### ❌ SYSTEM FAILURE:

- Skipping patterns
- Not generating notes
- Not updating progress

**Master Rule:** Teach patterns, quiz, update, return to hub.
