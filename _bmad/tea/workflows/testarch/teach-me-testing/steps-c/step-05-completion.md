---
name: "step-05-completion"
description: "Generate completion certificate, final progress update, congratulate learner"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
certificateTemplate: "../templates/certificate-template.md"
certificateFile: "{test_artifacts}/tea-academy/{user_name}/tea-completion-certificate.md"
---

# Step 5: Completion & Certificate Generation

## STEP GOAL:

To generate the TEA Academy completion certificate, update final progress, and congratulate the learner on completing all 7 sessions.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ Master Test Architect and Teaching Guide
- ✅ Celebrating completion

### Step-Specific Rules:

- 🎯 Focus on completion and celebration
- 🚫 FORBIDDEN to proceed without verifying all 7 sessions complete
- 💬 Approach: Congratulate, generate certificate, inspire next steps

## EXECUTION PROTOCOLS:

- 🎯 Verify all sessions complete
- 💾 Generate completion certificate
- 📖 Final progress update
- 🎉 This is the final step - no next step

## CONTEXT BOUNDARIES:

- Available context: Progress file with all 7 sessions completed
- Focus: Certificate generation and celebration
- Dependencies: All 7 sessions must be complete

## MANDATORY SEQUENCE

### 1. Verify All Sessions Complete

Load {progressFile} and check:

- All 7 sessions have `status: 'completed'`
- All 7 sessions have scores
- sessions_completed == 7

**If any session NOT complete:**

Display:

"⚠️ **Not all sessions complete!**

You still have {7 - sessions_completed} sessions remaining.

Please return to the session menu to complete the remaining sessions before generating your certificate."

**THEN:** Stop and do not proceed. This is an error state.

---

**If all 7 sessions complete:** Proceed to step 2.

### 2. Calculate Final Metrics

From progress file, calculate:

**Average Score:**

- Sum all 7 session scores
- Divide by 7
- Round to nearest integer

**Total Duration:**

- Calculate days between started_date and current_date
- Format as "{N} days" or "{N} weeks"

**Individual Session Scores:**

- Extract score for each session (session-01 through session-07)

### 3. Congratulations Message

Display:

"🏆 **CONGRATULATIONS, {user_name}!**

You've completed all 7 sessions of TEA Academy!

**Your Achievement:**

- **Started:** {started_date}
- **Completed:** {current_date}
- **Duration:** {total_duration}
- **Average Score:** {average_score}/100
- **Sessions Completed:** 7 of 7 (100%)

**Session Scores:**

- Session 1 (Quick Start): {session_01_score}/100
- Session 2 (Core Concepts): {session_02_score}/100
- Session 3 (Architecture): {session_03_score}/100
- Session 4 (Test Design): {session_04_score}/100
- Session 5 (ATDD & Automate): {session_05_score}/100
- Session 6 (Quality & Trace): {session_06_score}/100
- Session 7 (Advanced Patterns): {session_07_score}/100

Generating your completion certificate..."

### 4. Generate Completion Certificate

Load {certificateTemplate} and create {certificateFile} with:

```markdown
---
certificate_type: tea-academy-completion
user: { user_name }
role: { role }
completion_date: { current_date }
started_date: { started_date }
total_duration: { total_duration }
average_score: { average_score }
---

# 🏆 TEA Academy Completion Certificate

---

## Certificate of Completion

**This certifies that**

# {user_name}

**has successfully completed the TEA Academy testing curriculum**

---

### Program Details

**Role:** {role}
**Started:** {started_date}
**Completed:** {current_date}
**Total Duration:** {total_duration}
**Average Score:** {average_score}/100

---

### Sessions Completed

✅ **Session 1:** Quick Start (30 min) - Score: {session_01_score}/100
✅ **Session 2:** Core Concepts (45 min) - Score: {session_02_score}/100
✅ **Session 3:** Architecture & Patterns (60 min) - Score: {session_03_score}/100
✅ **Session 4:** Test Design (60 min) - Score: {session_04_score}/100
✅ **Session 5:** ATDD & Automate (60 min) - Score: {session_05_score}/100
✅ **Session 6:** Quality & Trace (45 min) - Score: {session_06_score}/100
✅ **Session 7:** Advanced Patterns (ongoing) - Score: {session_07_score}/100

---

### Skills Acquired

{user_name} has demonstrated proficiency in:

- ✅ **Testing Fundamentals:** Risk-based testing, test pyramid, test types, P0-P3 prioritization
- ✅ **TEA Methodology:** 9 workflows (Teach Me Testing, Framework, Test Design, ATDD, Automate, Test Review, Trace, NFR, CI)
- ✅ **Architecture Patterns:** Fixture composition, network-first patterns, data factories, step-file architecture
- ✅ **Test Design:** Risk assessment (Probability × Impact), coverage planning, test levels framework
- ✅ **Test Development:** ATDD red-green TDD approach, test automation, API testing patterns
- ✅ **Quality Assurance:** Test review (5 dimensions), traceability, release gates, quality metrics
- ✅ **Advanced Techniques:** Knowledge fragments explored, Playwright Utils integration

---

### Learning Artifacts

All session notes and progress tracking available at:
`{test_artifacts}/tea-academy/{user_name}/`

**Session Notes:**

- session-01-notes.md - Quick Start
- session-02-notes.md - Core Concepts
- session-03-notes.md - Architecture & Patterns
- session-04-notes.md - Test Design
- session-05-notes.md - ATDD & Automate
- session-06-notes.md - Quality & Trace
- session-07-notes.md - Advanced Patterns

**Progress File:**
`{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml`

---

### Next Steps

**Recommended Actions:**

1. **Apply TEA to your project:** Start with Framework setup workflow
2. **Run TEA workflows:** Test Design → ATDD/Automate → Test Review
3. **Share knowledge:** Help team members through TEA Academy
4. **Explore knowledge fragments:** 35 fragments for just-in-time learning
5. **Contribute improvements:** Share feedback on TEA methodology

**TEA Resources:**

- **Documentation:** https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/
- **Knowledge Base:** https://bmad-code-org.github.io/bmad-method-test-architecture-enterprise/reference/knowledge-base/
- **GitHub Fragments:** https://github.com/bmad-code-org/bmad-method-test-architecture-enterprise/tree/main/src/testarch/knowledge

---

**Generated by:** TEA Academy - Teach Me Testing Workflow
**Module:** Test Architecture Enterprise (TEA)
**Completion Date:** {current_date}

---

🧪 **Master Test Architect and Quality Advisor**
```

Save certificate to {certificateFile}.

### 5. Update Progress File (Final)

Load {progressFile} and make final updates:

**Update session-07 (if not already):**

- `status: 'completed'`
- `completed_date: {current_date}`
- `score: 100` (exploratory session, completion based)
- `notes_artifact: '{sessionNotesFile}'`

**Update completion fields:**

- `sessions_completed: 7`
- `completion_percentage: 100`
- `certificate_generated: true`
- `certificate_path: '{certificateFile}'`
- `completion_date: {current_date}`

**Update stepsCompleted:**

- Append 'step-04-session-07' (if session 7 just completed)
- Append 'step-05-completion'
- Update lastStep: 'step-05-completion'

Save final progress file.

### 6. Display Certificate

Display the complete certificate content to the user.

### 7. Final Celebration

Display:

"🎉 **CONGRATULATIONS, {user_name}!** 🎉

You've successfully completed the entire TEA Academy curriculum!

**Your Achievement:**

- ✅ 7 sessions completed
- ✅ Average score: {average_score}/100
- ✅ {total_duration} of dedicated learning
- ✅ Certificate generated

**All Your Artifacts:**

- **Certificate:** {certificateFile}
- **Progress:** {progressFile}
- **Session Notes:** {test_artifacts}/tea-academy/{user_name}/

**You're now equipped to:**

- Write high-quality tests following TEA principles
- Use all 9 TEA workflows effectively
- Apply risk-based testing (P0-P3 prioritization)
- Implement architecture patterns (fixtures, network-first)
- Maintain quality through Test Review and Trace
- Explore 35 knowledge fragments as needed

**Next Steps:**

1. Apply TEA to your current project
2. Share this workflow with your team
3. Help onboard new team members
4. Continue learning through knowledge fragments

**Thank you for investing in testing excellence!** 🧪

---

**TEA Academy - Mission Accomplished** ✅"

### 8. Workflow Complete

**This is the final step - no menu, no next step.**

Workflow ends here. User can run the workflow again to re-take sessions or explore more fragments.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All 7 sessions verified complete before certificate generation
- Average score calculated correctly
- Certificate generated with all session data
- Certificate saved to file
- Progress file updated with completion status
- Final celebration message displayed
- All artifacts paths provided to user
- Workflow completes successfully

### ❌ SYSTEM FAILURE:

- Generating certificate without verifying all sessions complete
- Incorrect average score calculation
- Missing session data in certificate
- Not updating progress file with completion status
- Not providing artifact paths to user
- Proceeding to next step (this is final - no next step)

**Master Rule:** Verify completion, generate certificate, celebrate achievement, end workflow. This is the finale.
