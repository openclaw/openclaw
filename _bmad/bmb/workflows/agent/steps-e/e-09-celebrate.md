---
name: "e-09-celebrate"
description: "Celebrate successful agent edit completion"

editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
validationWorkflow: "{project-root}/src/modules/bmb/workflows/agent/steps-v/v-01-load-review.md"
---

# Edit Step 9: Celebration

## STEP GOAL:

Celebrate the successful agent edit, provide summary of changes, and mark edit workflow completion.

## MANDATORY EXECUTION RULES:

- 🎉 ALWAYS celebrate the achievement with enthusiasm
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Read editPlan to summarize what was accomplished
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a celebration coordinator who acknowledges successful agent improvements
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring celebration energy, user brings their satisfaction, together we acknowledge successful collaboration

### Step-Specific Rules:

- 🎯 Focus on celebrating and summarizing what was accomplished
- 🚫 FORBIDDEN to end without marking workflow completion
- 💬 Approach: Enthusiastic while providing clear summary

## EXECUTION PROTOCOLS:

- 🎉 Celebrate the edit completion enthusiastically
- 📊 Provide clear summary of all changes made
- 💾 Mark workflow completion in edit plan
- 🚫 FORBIDDEN to end without proper completion marking

## CONTEXT BOUNDARIES:

- Available context: editPlan with full edit history
- Focus: Celebration and summary
- Limits: No more edits, only acknowledgment
- Dependencies: All edits successfully applied

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.:

### 1. Read Edit Plan

Read `{editPlan}` to get:

- Original agent state
- All edits that were applied
- Validation results (before and after)

### 2. Grand Celebration

"🎉 **Excellent work!** Your agent **{agent-name}** has been successfully updated!"

### 3. Edit Summary

```markdown
## Edit Summary for {agent-name}

**Completed:** {YYYY-MM-DD HH:MM}
**Edits Applied:** {count}

### What Changed

**Persona Updates:** {list or "None"}
**Command Updates:** {list or "None"}
**Metadata Updates:** {list or "None"}
**Type Conversion:** {details or "None"}

### Validation Results

**Before:** {summary of pre-edit validation}
**After:** {summary of post-edit validation}
```

### 4. Verification Guidance

"**Quick Test:**

- Load the agent and check it initializes correctly
- Run through a few commands to verify behavior

**File Locations:**

- **Agent File:** `{agentFile}`
- **Backup:** `{agentFile}.backup`"

### 5. Document Completion

Append to editPlan:

```markdown
## Edit Session Complete ✅

**Completed:** {YYYY-MM-DD HH:MM}
**Status:** Success

### Final State

- Agent file updated successfully
- All edits applied
- Backup preserved
```

### 6. Present MENU OPTIONS

Display: "**✅ Agent Edit Complete! Select an Option:** [V] Run Validation [S] Skip - Complete Now [A] Advanced Elicitation [P] Party Mode"

#### Menu Handling Logic:

- IF V: "Loading validation phase..." → Save completion status to {editPlan}, update frontmatter with edit completion, then load, read entire file, then execute {validationWorkflow}
- IF S: "Skipping validation. Completing workflow..." → Save completion status to {editPlan} and end workflow gracefully
- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#6-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User can choose validation (V), skip to complete (S), or use advanced elicitation (A) or party mode (P)
- After other menu items execution (A/P), return to this menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [S skip option] is selected and [completion documented], will the workflow end gracefully with agent edit complete.
IF [V validation option] is selected, the validation workflow will be loaded to perform comprehensive validation checks.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Enthusiastic celebration of edit completion
- Clear summary of all changes provided
- Before/after validation comparison shown
- Verification guidance provided
- Workflow completion marked in edit plan

### ❌ SYSTEM FAILURE:

- Ending without marking workflow completion
- Not providing clear summary of changes
- Missing celebration of achievement

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
