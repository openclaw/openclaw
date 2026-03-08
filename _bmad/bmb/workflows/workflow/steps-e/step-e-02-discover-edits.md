---
name: "step-e-02-discover-edits"
description: "Discover what user wants to change - fix validation issues, make changes, or both"

# File References
nextStepFile: "./step-e-03-fix-validation.md"
directEditStep: "./step-e-04-direct-edit.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
targetWorkflowPath: "{targetWorkflowPath}"
validationReport: "{targetWorkflowPath}/validation-report-{workflow_name}.md"
---

# Edit Step 2: Discover Edits

## STEP GOAL:

Discover what the user wants to do: fix validation issues, make specific changes, or both. Document edit goals in the edit plan.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER assume what edits are needed
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus ONLY on understanding edit goals
- 🚫 FORBIDDEN to make any modifications yet
- 💬 Ask clarifying questions
- 🚪 CATEGORIZE edits by type

## EXECUTION PROTOCOLS:

- 🎯 Guide discovery conversation
- 💾 Document edit goals in edit plan
- 📖 Determine which next step to load
- 🚫 FORBIDDEN to proceed without user confirmation

## CONTEXT BOUNDARIES:

- Edit plan from previous step provides context
- Validation report (if exists) provides issues to fix
- Focus: What does user want to change?
- This is discovery, not implementation

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Read Edit Plan Context

**Load the editPlan file:**
Read `{editPlan}` to understand the workflow context and validation status.

### 2. Determine Discovery Approach

**IF validation report exists AND has issues:**

Present fix-or-change options (step 3a)

**ELSE (no validation report or no issues):**

Present direct change options (step 3b)

---

### 3a. Discovery With Validation Issues

**IF validation report exists with issues:**

"**I found an existing validation report for this workflow.**

**Validation Summary:**

- Status: {status from report}
- Critical Issues: {count}
- Warnings: {count}

**What would you like to do?**

**[F]ix Validation Issues** - Systematically fix issues found in validation
**[C]hange Something** - Make a specific change (add feature, modify step, etc.)
**[B]oth** - Fix validation issues, then make a change
**[R]eview Report** - See detailed validation findings first

#### Menu Handling Logic:

- IF F: Proceed to [Document Fix Goals](#4-document-fix-goals), then route to {nextStepFile}
- IF C: Proceed to [Document Change Goals](#3b-discovery-for-direct-change)
- IF B: Document both fix and change goals, then route to {nextStepFile} for fixes first
- IF R: Present key findings from validation report, then redisplay this menu
- IF Any other: help user, then redisplay menu"

---

### 3b. Discovery For Direct Change

**IF no validation report or no issues:**

"**What would you like to change about this workflow?**

I can help you modify:

**[W]orkflow.md** - Goal, role, initialization, routing
**[S]tep Files** - Add, remove, or modify steps
**[D]ata Files** - Add or modify reference data in data/ folder
**[T]emplates** - Add or modify output templates
**[M]ultiple** - Changes across multiple areas
**[O]ther** - Something else

Which areas would you like to edit?"

#### For Each Selected Category:

**If Workflow.md selected:**

- "What aspects need change?"
  - Goal or description?
  - Role definition?
  - Architecture principles?
  - Initialization/routing?

**If Step Files selected:**

- "What type of step changes?"
  - Add new step?
  - Remove existing step?
  - Modify step content?
  - Reorder steps?

**If Data Files selected:**

- "What data changes?"
  - Add new data file?
  - Modify existing data?
  - Add/remove data entries?

**If Templates selected:**

- "What template changes?"
  - Add new template?
  - Modify template structure?
  - Change variable references?"

**If Multiple selected:**

- Walk through each area systematically

**If Other selected:**

- "Describe what you'd like to change..."

---

### 4. Document Fix Goals (For Validation Issues)

**Append to editPlan:**

```markdown
## Edit Goals

### Fix Validation Issues

**Priority: High** - These issues prevent compliance

**Critical Issues to Fix:**

- [ ] {issue from validation report}
- [ ] {issue from validation report}

**Warnings to Address:**

- [ ] {warning from validation report}
- [ ] {warning from validation report}
```

---

### 5. Document Change Goals

**Append to editPlan:**

```markdown
### Direct Changes

**Category:** [workflow.md / step files / data / templates / other]

**Changes Requested:**

- [ ] {specific change description}
- [ ] {specific change description}

**Rationale:**
{user's explanation of why this change is needed}
```

---

### 6. Confirm and Route

**Present summary for confirmation:**

"**Here's what I heard you want to do:**

{Summarize all edit goals clearly}

**Did I capture everything correctly?**

- [C] Yes, continue
- [M] Modify the plan
- [x] Cancel"

#### Menu Handling Logic:

- IF C: Update editPlan stepsCompleted, then route based on goals:
  - **If Fix goals only**: Load, read entirely, then execute {nextStepFile} (fix-validation)
  - **If Change goals only**: Load, read entirely, then execute {directEditStep}
  - **If Both**: Load, read entirely, then execute {nextStepFile} (fix first, then direct edit after)
- IF M: Return to relevant discovery section
- IF X: Exit with explanation
- IF Any other: help user, then redisplay menu

### 7. Present MENU OPTIONS (Final)

Display: "**Edit Goals Confirmed. Select an Option:** [C] Continue to Edits"

#### Menu Handling Logic:

- IF C: Save editPlan with confirmed goals, then load appropriate next step based on [Route Based on Goals](#6-confirm-and-route)
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user confirms goals and routing is determined, will you then load and read fully the appropriate next step file to execute.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Edit goals clearly documented
- User confirmed the plan
- Routing determined (fix vs direct vs both)
- Edit plan updated with goals
- Appropriate next step selected

### ❌ SYSTEM FAILURE:

- Not documenting edit goals
- Routing to wrong next step
- Not getting user confirmation
- Missing changes user mentioned

**Master Rule:** Discovery must be thorough. Document all goals. Route correctly based on whether fixes, changes, or both are needed.
