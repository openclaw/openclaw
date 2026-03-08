---
name: "step-01-init"
description: "Initialize TEA Academy - check for existing progress and route to continuation or new assessment"

nextStepFile: "./step-02-assess.md"
continueFile: "./step-01b-continue.md"
progressFile: "{test_artifacts}/teaching-progress/{user_name}-tea-progress.yaml"
progressTemplate: "../templates/progress-template.yaml"
---

# Step 1: Initialize TEA Academy

## STEP GOAL:

To welcome the learner, check for existing progress from previous sessions, and route to either continuation (if progress exists) or new assessment (if starting fresh).

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

- 🎯 Focus ONLY on initialization and routing
- 🚫 FORBIDDEN to start teaching yet - that comes in session steps
- 💬 Approach: Check for progress, route appropriately
- 🚪 This is the entry point - sets up everything that follows

## EXECUTION PROTOCOLS:

- 🎯 Check for existing progress file
- 💾 Create initial progress if new learner
- 📖 Route to continuation or assessment based on progress
- 🚫 FORBIDDEN to skip continuation check - critical for multi-session learning

## CONTEXT BOUNDARIES:

- Available context: User name, test artifacts path, templates
- Focus: Detect continuation vs new start
- Limits: No teaching yet, no assessment yet
- Dependencies: None - this is the first step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Welcome Message

Display:

"🧪 **Welcome to TEA Academy - Test Architecture Enterprise Learning**

A multi-session learning companion that teaches testing progressively through 7 structured sessions.

Let me check if you've started this journey before..."

### 2. Check for Existing Progress

Check if {progressFile} exists.

**How to check:**

- Attempt to read {progressFile}
- If file exists and is readable → Progress found
- If file not found or error → No progress (new learner)

### 3. Route Based on Progress

**IF progress file EXISTS:**

Display:

"✅ **Welcome back!** I found your existing progress.

Let me load where you left off..."

**THEN:** Immediately load, read entire file, then execute {continueFile}

---

**IF progress file DOES NOT EXIST:**

Display:

"📝 **Starting fresh!** I'll create your progress tracking file.

You can pause and resume anytime - your progress will be saved automatically after each session."

**THEN:** Proceed to step 4

### 4. Create Initial Progress File (New Learner Only)

Load {progressTemplate} and create {progressFile} with:

```yaml
---
# TEA Academy Progress Tracking
user: { user_name }
role: null # Will be set in assessment
experience_level: null # Will be set in assessment
learning_goals: null # Will be set in assessment
pain_points: null # Optional, set in assessment

started_date: { current_date }
last_session_date: { current_date }

sessions:
  - id: session-01-quickstart
    name: "Quick Start"
    duration: "30 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-02-concepts
    name: "Core Concepts"
    duration: "45 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-03-architecture
    name: "Architecture & Patterns"
    duration: "60 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-04-test-design
    name: "Test Design"
    duration: "60 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-05-atdd-automate
    name: "ATDD & Automate"
    duration: "60 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-06-quality-trace
    name: "Quality & Trace"
    duration: "45 min"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

  - id: session-07-advanced
    name: "Advanced Patterns"
    duration: "ongoing"
    status: not-started
    started_date: null
    completed_date: null
    score: null
    notes_artifact: null

sessions_completed: 0
total_sessions: 7
completion_percentage: 0
next_recommended: session-01-quickstart

stepsCompleted: ["step-01-init"]
lastStep: "step-01-init"
lastContinued: { current_date }

certificate_generated: false
certificate_path: null
completion_date: null
---
```

### 5. Proceed to Assessment (New Learner Only)

Display:

"✅ **Progress file created!**

Now let's learn about you - your role, experience level, and learning goals.

This helps me customize examples and recommendations for you.

**Proceeding to assessment...**"

**THEN:** Immediately load, read entire file, then execute {nextStepFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Progress file check performed correctly
- Existing learners routed to continuation (step-01b)
- New learners get progress file created
- Progress file has complete schema with all 7 sessions
- New learners routed to assessment (step-02)
- stepsCompleted array initialized

### ❌ SYSTEM FAILURE:

- Skipping progress file check
- Not routing to continuation for existing learners
- Creating duplicate progress files
- Progress file missing required fields
- Not updating stepsCompleted array
- Asking user questions before checking progress

**Master Rule:** This is an auto-proceed initialization step. Check progress, route appropriately, no user menu needed.
