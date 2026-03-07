---
name: "step-e-07-complete"
description: "Complete the edit session with summary and next steps"

# File References
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
targetWorkflowPath: "{targetWorkflowPath}"
validationReport: "{targetWorkflowPath}/validation-report-{workflow_name}.md"
---

# Edit Step 7: Complete

## STEP GOAL:

Complete the edit session with a comprehensive summary of changes made and provide next steps guidance.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus on summary and completion
- 💬 Present clear change summary
- 🚫 No more edits at this stage

## EXECUTION PROTOCOLS:

- 🎯 Generate comprehensive summary
- 💾 Finalize edit plan document
- 📖 Provide next steps guidance

## CONTEXT BOUNDARIES:

- All edits are complete
- Focus: Summary and closure
- This is the final step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Read Edit Plan and Validation Report

**Load both files:**

1. `{editPlan}` - Full edit session history
2. `{validationReport}` - Final validation status (if exists)

### 2. Generate Completion Summary

"**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

# Edit Session Complete

**Workflow:** {workflow_name}
**Path:** {targetWorkflowPath}
**Session Date:** {editSessionDate}

---

## Changes Made

**Validation Fixes Applied:** {count}
{list from edit plan}

**Direct Changes Applied:** {count}
{list from edit plan}

**Files Modified:**
{List all files that were changed}

---

## Final Validation Status

**Status:** {status from report or 'Not run'}

**Issues:**

- Critical: {count}
- Warnings: {count}

---

## Edit Session Summary

Your workflow has been successfully edited. Here's what was accomplished:

{Summarize the transformation in 2-3 sentences}

**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**"

### 3. Update Edit Plan with Completion

**Append final completion section to editPlan:**

```markdown
## Completion Summary

**Completed:** {current-date}
**Session Duration:** {from start to end}

**Total Edits:** {count}

- Validation Fixes: {count}
- Direct Changes: {count}

**Files Modified:** {count}
**Final Validation Status:** {status}

**Workflow is ready for:** {use/testing/production with caveats}
```

### 4. Provide Next Steps Guidance

"**Next Steps for Your Workflow:**

1. **Test the workflow** - Run through the workflow end-to-end to verify changes
2. **Get user feedback** - If this is for others, have them test it
3. **Monitor for issues** - Watch for any problems in actual use
4. **Re-validate periodically** - Run validation again after future changes

**Resources:**

- Edit this workflow again: Edit workflow mode
- Run validation: Validate workflow mode
- Build new workflow: Create workflow mode

---

**Thank you for using BMAD Workflow Creator!**

Your edit session for **{workflow_name}** is complete. ✅"

### 5. Final Confirmation

"**Edit Session Complete.**

**[F]inish** - End the edit session
**[S]ave summary** - Save a copy of the edit summary to your output folder
**[R]eview** - Review the full edit plan one more time"

#### Menu Handling Logic:

- IF F: End the session
- IF S: Save edit summary to output folder, then end
- IF R: Display full edit plan, then redisplay this menu
- IF Any other: help user, then redisplay menu

### 6. Save Summary (If Requested)

**IF user selects [S]ave summary:**

Create summary file at `{output_folder}/workflow-edit-summary-{workflow_name}-{date}.md`:

```markdown
# Workflow Edit Summary

**Workflow:** {workflow_name}
**Path:** {targetWorkflowPath}
**Edit Date:** {current-date}

## Changes Made

{All changes from edit plan}

## Files Modified

{List with paths}

## Validation Status

{Final validation results}

## Next Steps

{Recommendations}
```

"**Summary saved to:** {output_folder}/workflow-edit-summary-{workflow_name}-{date}.md"

## CRITICAL STEP COMPLETION NOTE

This is the final step. Ensure edit plan is complete, summary is presented, and user has all information needed. End session gracefully.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Comprehensive summary presented
- All changes documented clearly
- Edit plan finalized
- Next steps guidance provided
- Session ended gracefully

### ❌ SYSTEM FAILURE:

- Not summarizing all changes
- Missing files from change list
- Not providing next steps
- Ending without user confirmation

**Master Rule:** Provide complete summary of all changes. Document everything. Give clear next steps. End on a positive note.
