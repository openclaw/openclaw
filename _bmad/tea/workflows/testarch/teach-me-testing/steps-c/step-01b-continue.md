---
name: "step-01b-continue"
description: "Resume TEA Academy learning - load progress and display dashboard"

progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
nextStepFile: "./step-03-session-menu.md"
---

# Step 1b: Continue TEA Academy

## STEP GOAL:

To resume the TEA Academy workflow from a previous session by loading progress, displaying a dashboard, and routing to the session menu.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate _new instructional content_ without user input (auto-proceed steps may display status/route)
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

- 🎯 Focus ONLY on loading progress and routing to session menu
- 🚫 FORBIDDEN to start teaching - that happens in session steps
- 💬 Approach: Load progress, show dashboard, route to menu
- 🚪 This is the continuation entry point - seamless resume

## EXECUTION PROTOCOLS:

- 🎯 Load progress file completely
- 💾 Update lastContinued timestamp
- 📖 Display progress dashboard with completion status
- 🚫 FORBIDDEN to skip dashboard - learners need to see progress
- ⏭️ Auto-route to session menu after dashboard

## CONTEXT BOUNDARIES:

- Available context: Progress file with all session data
- Focus: Display progress, route to menu
- Limits: No teaching, no session execution
- Dependencies: Progress file must exist (checked in step-01-init)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Progress File

Read {progressFile} completely and extract:

- user
- role
- experience_level
- started_date
- sessions array (all 7 sessions with status, scores)
- sessions_completed
- completion_percentage
- next_recommended

### 2. Update Last Continued Timestamp

Update {progressFile} frontmatter:

- Set `lastContinued: {current_date}`
- Keep all other fields unchanged

### 3. Display Progress Dashboard

Display:

"🧪 **Welcome back to TEA Academy, {user}!**

**Your Role:** {role}
**Experience Level:** {experience_level}
**Started:** {started_date}
**Progress:** {completion_percentage}% ({sessions_completed} of 7 sessions completed)

---

### 📊 Session Progress

{Display each session with completion indicator}

{For each session in sessions array:}
{If status == 'completed':}
✅ **Session {N}:** {name} - Completed {completed_date} (Score: {score}/100)
{If status == 'in-progress':}
🔄 **Session {N}:** {name} - In Progress (Started {started_date})
{If status == 'not-started':}
⬜ **Session {N}:** {name} - Not Started

---

### 🎯 Next Recommended

{next_recommended}

---

**Let's continue your learning journey!**

Loading session menu..."

### 4. Route to Session Menu

Display:

"**Proceeding to session menu...**"

**THEN:** Immediately load, read entire file, then execute {nextStepFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Progress file loaded correctly
- lastContinued timestamp updated
- Dashboard displayed with accurate completion status
- Session indicators correct (✅ completed, 🔄 in-progress, ⬜ not-started)
- Completion percentage calculated correctly
- Next recommended session identified
- Auto-routed to session menu (step-03)

### ❌ SYSTEM FAILURE:

- Not loading progress file
- Dashboard missing or incomplete
- Incorrect completion indicators
- Not updating lastContinued timestamp
- Asking user for input instead of auto-routing
- Not routing to session menu

**Master Rule:** This is an auto-proceed continuation step. Load progress, show dashboard, route to session menu - no user menu needed.
