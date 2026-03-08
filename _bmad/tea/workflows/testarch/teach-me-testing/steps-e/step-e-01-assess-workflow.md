---
name: "step-e-01-assess-workflow"
description: "Assess what needs to be edited in the teaching workflow"

nextStepFile: "./step-e-02-apply-edits.md"
workflowPath: "../"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 1: Assess What to Edit

## STEP GOAL:

To identify what the user wants to edit in the teach-me-testing workflow and gather requirements for the modifications.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read complete step file before action
- ✅ SPEAK OUTPUT In {communication_language}

### Role Reinforcement:

- ✅ You are a workflow architect helping with modifications
- ✅ Collaborative dialogue for understanding edit needs

### Step-Specific Rules:

- 🎯 Focus on understanding what to edit
- 🚫 FORBIDDEN to make edits yet
- 💬 Ask questions to clarify requirements

## EXECUTION PROTOCOLS:

- 🎯 Understand edit requirements
- 💾 Document what needs editing
- 📖 Prepare for edits in next step

## MANDATORY SEQUENCE

### 1. Welcome to Edit Mode

"**Edit Mode: Teach Me Testing Workflow**

What would you like to edit?

**Common edits:**

- Update session content (new concepts, updated examples)
- Modify quiz questions
- Add/remove knowledge fragments from session 7
- Update TEA resource references
- Change session durations or structure
- Update role-based examples

**Tell me what you'd like to change.**"

### 2. Gather Edit Requirements

Ask targeted questions based on their response:

**If editing session content:**

- Which session? (1-7)
- What specific content needs updating?
- Why the change? (outdated, incorrect, needs improvement)

**If editing quiz questions:**

- Which session's quiz?
- Which question(s)?
- What's wrong with current questions?

**If editing session 7 fragments:**

- Add new fragment category?
- Update existing fragment references?
- Change organization?

**If editing templates:**

- Progress template?
- Session notes template?
- Certificate template?
- What fields need changing?

**If editing data files:**

- Curriculum structure?
- Role customizations?
- Resource mappings?

### 3. Load Current Content

Based on what they want to edit, load the relevant files:

- Session step files (steps-c/step-04-session-\*.md)
- Templates (`templates/*.md` or `*.yaml`)
- Data files (data/\*.yaml)

Show user the current content.

### 4. Document Edit Plan

"**Edit Plan:**

**Target Files:**

- {list files to be modified}

**Changes Required:**

- {list specific changes}

**Reason:**

- {why these edits are needed}

Ready to proceed with edits?"

### 5. Menu

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Apply Edits

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, redisplay menu
- IF P: Execute {partyModeWorkflow}, redisplay menu
- IF C: Load, read entire file, then execute {nextStepFile}
- IF Any other: help user, redisplay menu

---

## 🚨 SUCCESS METRICS

✅ Edit requirements clearly understood, target files identified, edit plan documented, user approves plan.

**Master Rule:** Understand before editing. Get clear requirements first.
