---
name: "step-03-session-menu"
description: "Session selection hub - display all 7 sessions with completion status and route to selected session or completion"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
session01File: "./step-04-session-01.md"
session02File: "./step-04-session-02.md"
session03File: "./step-04-session-03.md"
session04File: "./step-04-session-04.md"
session05File: "./step-04-session-05.md"
session06File: "./step-04-session-06.md"
session07File: "./step-04-session-07.md"
completionFile: "./step-05-completion.md"
---

# Step 3: Session Menu (Hub)

## STEP GOAL:

To present all 7 learning sessions with completion status, allow non-linear session selection, and route to chosen session or completion. This is the central hub - all sessions return here.

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

- 🎯 Focus ONLY on displaying sessions and routing
- 🚫 FORBIDDEN to start teaching - that happens in session steps
- 💬 Approach: Show progress, let learner choose their path
- 🚪 This is the HUB - all sessions loop back here

## EXECUTION PROTOCOLS:

- 🎯 Load progress file to get session completion status
- 💾 Display sessions with accurate indicators
- 📖 Route to selected session or completion
- 🚫 FORBIDDEN to skip progress check - status indicators critical
- ⏭️ No stepsCompleted update (this is a routing hub, not a content step)

## CONTEXT BOUNDARIES:

- Available context: Progress file with all session data
- Focus: Display menu, route to selection
- Limits: No teaching, no session execution
- Dependencies: Progress file exists (created in step-01, updated in step-02)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Progress File

Read {progressFile} and extract:

- user
- role
- experience_level
- sessions array (all 7 sessions with status, scores, dates)
- sessions_completed
- completion_percentage
- next_recommended

### 2. Display Session Menu with Status

Display:

"🧪 **TEA Academy - Session Menu**

**Progress:** {completion_percentage}% ({sessions_completed} of 7 sessions completed)

---

### 📚 Available Sessions

{For each session in sessions array, display with status indicator:}

**Session 1: Quick Start (30 min)**
{status_indicator} TEA Lite intro, run automate workflow
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 2: Core Concepts (45 min)**
{status_indicator} Risk-based testing, DoD, testing philosophy
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 3: Architecture & Patterns (60 min)**
{status_indicator} Fixtures, network patterns, framework setup
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 4: Test Design (60 min)**
{status_indicator} Risk assessment, test design workflow
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 5: ATDD & Automate (60 min)**
{status_indicator} ATDD + Automate workflows, TDD approach
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 6: Quality & Trace (45 min)**
{status_indicator} Test review + Trace workflows, quality metrics
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

**Session 7: Advanced Patterns (ongoing)**
{status_indicator} Menu-driven knowledge fragment exploration (35 fragments)
{if completed: Score: {score}/100 | Completed: {completed_date}}
{if in-progress: Started: {started_date}}

---

**Status Indicators:**

- ✅ = Completed
- 🔄 = In Progress
- ⬜ = Not Started

---

{If next_recommended exists:}
💡 **Recommended Next:** {next_recommended}
"

### 3. Check for Completion

**Before displaying menu options, check:**

If all 7 sessions have status 'completed' AND certificate_generated != true:

- Display: "🎉 **Congratulations!** You've completed all 7 sessions!"
- Skip session menu options
- Proceed directly to step 4b (route to completion)

**Otherwise:** Display session menu options in step 4a

### 4a. Present Session Menu Options (Sessions Remaining)

Display:

"**Select a session or exit:**

**[1-7]** Start or continue a session
**[X]** Save progress and exit

What would you like to do?"

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- Route based on user selection
- User can ask questions - always respond and redisplay menu

#### Menu Handling Logic:

- IF 1: Load, read entire file, then execute {session01File}
- IF 2: Load, read entire file, then execute {session02File}
- IF 3: Load, read entire file, then execute {session03File}
- IF 4: Load, read entire file, then execute {session04File}
- IF 5: Load, read entire file, then execute {session05File}
- IF 6: Load, read entire file, then execute {session06File}
- IF 7: Load, read entire file, then execute {session07File}
- IF X: Display "Progress saved. See you next time! 👋" and END workflow
- IF Any other: "Please select a session number (1-7) or X to exit", then [Redisplay Menu Options](#4a-present-session-menu-options-sessions-remaining)

### 4b. Route to Completion (All Sessions Done)

**If all 7 sessions completed:**

Display:

"**Proceeding to generate your completion certificate...**"

Load, read entire file, then execute {completionFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Progress file loaded correctly
- All 7 sessions displayed with accurate status indicators
- Completion percentage calculated correctly
- Session status matches progress file (✅ completed, 🔄 in-progress, ⬜ not-started)
- User selection validated (1-7 or X)
- Correct routing to selected session file
- Completion detected when all 7 done
- Exit option saves and ends workflow cleanly
- No stepsCompleted update (this is routing hub, not content step)

### ❌ SYSTEM FAILURE:

- Not loading progress file
- Wrong status indicators
- Incorrect completion percentage
- Not detecting when all sessions complete
- Routing to wrong session file
- Updating stepsCompleted (hub should not update this)
- Not displaying session descriptions
- Not allowing non-linear session selection

**Master Rule:** This is the central hub. Display accurate status, let learner choose freely, route correctly. All sessions return here.
