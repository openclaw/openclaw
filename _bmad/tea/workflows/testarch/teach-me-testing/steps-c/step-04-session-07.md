---
name: "step-04-session-07"
description: "Session 7: Advanced Patterns - Menu-driven knowledge fragment exploration (ongoing)"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
sessionNotesTemplate: "../templates/session-notes-template.md"
sessionNotesFile: "{test_artifacts}/tea-academy/{user_name}/session-07-notes.md"
nextStepFile: "./step-03-session-menu.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Session 7 - Advanced Patterns

## STEP GOAL:

To provide menu-driven exploration of 35 TEA knowledge fragments organized by category, allowing deep-dive into specific advanced topics on-demand.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ Master Test Architect and Teaching Guide
- ✅ Collaborative exploration

### Step-Specific Rules:

- 🎯 Focus on Session 7 (Advanced Patterns exploration)
- 💬 Menu-driven, user chooses topics
- 📚 This session is ONGOING - users can explore multiple fragments

## EXECUTION PROTOCOLS:

- 🎯 Display fragment categories
- 💾 Generate notes after exploration
- 📖 Update progress when user exits
- ⏭️ Return to hub when done

## MANDATORY SEQUENCE

### 1. Welcome

"🧪 **Session 7: Advanced Patterns** (Ongoing Exploration)

**Objective:** Deep-dive into 34 TEA knowledge fragments

**This session is different:**

- Menu-driven exploration (you choose topics)
- Explore as many fragments as you want
- Can revisit this session anytime
- No quiz - this is reference learning

**35 Knowledge Fragments organized by category:**

Let's explore!"

### 2. Update Progress (Started)

Set session-07-advanced `status: 'in-progress'` (only first time).

### 3. Display Knowledge Fragment Categories

"### 📚 Knowledge Fragment Categories

**1. Testing Patterns (9 fragments)**

- fixture-architecture.md - Composable fixture patterns
- fixtures-composition.md - mergeTests composition patterns
- network-first.md - Network interception safeguards
- data-factories.md - Data seeding & setup
- component-tdd.md - TDD red-green loop
- api-testing-patterns.md - Pure API testing
- test-healing-patterns.md - Auto-fix common failures
- selector-resilience.md - Robust selectors
- timing-debugging.md - Race condition fixes

**2. Playwright Utils (11 fragments)**

- overview.md - Playwright Utils overview
- api-request.md - Typed HTTP client
- network-recorder.md - HAR record/playback
- intercept-network-call.md - Network spy/stub
- recurse.md - Async polling
- log.md - Report logging
- file-utils.md - CSV/XLSX/PDF validation
- burn-in.md - Smart test selection
- network-error-monitor.md - HTTP error detection
- contract-testing.md - Pact integration
- visual-debugging.md - Trace viewer workflows

**3. Configuration & Governance (6 fragments)**

- playwright-config.md - Environment & timeout guardrails
- ci-burn-in.md - CI orchestration
- selective-testing.md - Tag/grep filters
- feature-flags.md - Governance & cleanup
- risk-governance.md - Scoring matrix & gates
- adr-quality-readiness-checklist.md - Quality readiness checklist

**4. Quality Frameworks (5 fragments)**

- test-quality.md - DoD execution limits
- test-levels-framework.md - Unit/Integration/E2E
- test-priorities-matrix.md - P0-P3 coverage targets
- probability-impact.md - Probability × impact scoring
- nfr-criteria.md - NFR assessment definitions

**5. Authentication & Security (3 fragments)**

- email-auth.md - Magic link extraction
- auth-session.md - Token persistence
- error-handling.md - Exception handling

**GitHub Repository:** <https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/tree/main/src/testarch/knowledge>

**Select a category (1-5) or specific fragment to explore, or [X] to finish:**"

### 4. Fragment Exploration Loop

**Wait for user selection.**

**Handle selection:**

- **IF 1-5 (category):** Display all fragments in that category with descriptions, ask which fragment to explore
- **IF specific fragment name:** Load and present that fragment's content
- **IF X:** Proceed to step 5 (complete session)
- **IF Any other:** Help user, redisplay categories

**For each fragment explored:**

1. Present the fragment's key concepts
2. Provide role-adapted examples
3. Link to GitHub source
4. Ask: "Explore another fragment? [Y/N/X to finish]"
5. If Y: Redisplay categories
6. If N or X: Proceed to completion

**Track fragments explored** (for session notes).

### 5. Session Summary

After user selects X (finish exploration):

"### 🎯 Session 7 Summary

**Fragments Explored:** {count}

{List each fragment explored}

**Key Takeaways:**
{Summarize insights from explored fragments}

**Remember:** You can return to Session 7 anytime to explore more fragments!

**GitHub Knowledge Base:** <https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/tree/main/src/testarch/knowledge>"

### 6. Generate Session Notes

Create {sessionNotesFile} with:

- Session 7 content
- List of fragments explored
- Key insights from each
- GitHub links
- No quiz (exploratory session)
- Score: 100 (completion based, not quiz based)

### 7. Update Progress (Completed)

Update session-07-advanced: completed, score: 100, notes.
Increment sessions_completed, update percentage.
Append 'step-04-session-07' to stepsCompleted.

**Check completion:**

- If sessions_completed == 7: Set next_recommended: 'completion'
- Otherwise: Recommend next incomplete session

### 8. Complete Message

"🎉 **Session 7 Complete!**

**Fragments Explored:** {count}

{If sessions_completed == 7:}
🏆 **Congratulations!** You've completed ALL 7 sessions!
Your completion certificate will be generated when you return to the menu.

{Otherwise:}
**Progress:** {completion_percentage}% complete ({sessions_completed} of 7 sessions)
You can return to Session 7 anytime to explore more fragments!"

### 9. Menu

[A] Advanced Elicitation [P] Party Mode [C] Continue to Session Menu

Return to {nextStepFile}.

---

## 🚨 SUCCESS METRICS

✅ Fragment categories displayed, user explored chosen fragments, notes generated with exploration summary, progress updated, returned to hub.

**Master Rule:** This session is exploratory and repeatable. User drives exploration, workflow facilitates.
