---
name: "step-11-completion"
description: "Complete the workflow creation and provide next steps"

targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{new_workflow_name}"
workflowPlanFile: "{targetWorkflowPath}/workflow-plan-{new_workflow_name}.md"
---

# Step 11: Completion

## STEP GOAL:

Complete the workflow creation process with a summary of what was built and next steps guidance.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER modify the completed workflow at this stage
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect and systems designer
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring completion expertise
- ✅ User decides next steps

### Step-Specific Rules:

- 🎯 Focus ONLY on summary and next steps
- 🚫 FORBIDDEN to modify the built workflow
- 💬 Present options clearly
- 🚪 This is the final step

## EXECUTION PROTOCOLS:

- 🎯 Present completion summary
- 💾 Finalize plan document
- 📖 Provide usage guidance
- 🚫 No more modifications at this stage

## CONTEXT BOUNDARIES:

- All workflow steps have been built
- Confirmation has been completed
- Validation may or may not have been run
- This is the final step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Present Completion Summary

"**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

# Workflow Creation Complete!

**Workflow:** {new_workflow_name}
**Location:** {targetWorkflowPath}
**Created:** {current date}

---

## What Was Built

**Workflow Structure:**

- **Type:** [continuable/single-session]
- **Mode:** [create-only/tri-modal]
- **Steps Created:** [count]

**Files Created:**

- workflow.md (entry point)
- [count] step files in steps-c/
- [count] validation files in steps-v/ (if tri-modal)
- [count] edit files in steps-e/ (if tri-modal)
- [count] supporting files in data/
- [count] templates in templates/

---

## Your Workflow Is Ready!

**To use your new workflow:**

1. Navigate to: {targetWorkflowPath}
2. Load workflow.md to start
3. Follow the step-by-step instructions

**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**"

### 2. Update Plan with Completion Status

Update {workflowPlanFile} frontmatter:

```yaml
---
workflowName: {new_workflow_name}
creationDate: [original creation date]
completionDate: [current date]
status: COMPLETE
stepsCompleted: ['step-01-discovery' or 'step-00-conversion', 'step-02-classification', 'step-03-requirements', 'step-04-tools', 'step-05-plan-review', 'step-06-design', 'step-07-foundation', 'step-08-build-step-01', 'step-09-build-next-step', 'step-10-confirmation', 'step-11-completion']
---
```

### 3. Provide Next Steps Guidance

"**Next Steps:**

**Test your workflow:**

- Run through it end-to-end
- Try with sample data
- Verify all steps work as expected

**Get user feedback:**

- If others will use it, have them test
- Gather feedback on facilitation
- Note any friction points

**Future maintenance:**

- Use validation mode to check compliance
- Use edit mode to make changes
- Validation can be run anytime

**Resources:**

- **Validate later:** Load {targetWorkflowPath}/workflow.md with -v flag
- **Edit later:** Load {targetWorkflowPath}/workflow.md with -e flag
- **Build more:** Use create workflow mode for new workflows"

### 4. Conversion-Specific Summary (If Applicable)

**Check workflowPlanFile frontmatter for `conversionFrom`:**

**IF this was a conversion:**

"**Conversion Complete!**

**Original workflow:** {conversionFrom}
**New location:** {targetWorkflowPath}

**Preserved:**

- Original goal and purpose
- All {count} steps
- Key instruction patterns
- Output format

**Improvements made:**

- BMAD compliance
- Better structure
- Enhanced collaboration
- Standards adherence

**Review the conversion report** in the confirmation step for full details."

### 5. Final Completion Message

"**Thank you for using BMAD Workflow Creator!**

Your workflow **{new_workflow_name}** is complete and ready to use.

**Workflow location:** {targetWorkflowPath}/workflow.md

Happy workflowing! ✅"

## CRITICAL STEP COMPLETION NOTE

This is the final step. Present completion summary, finalize plan, and provide next steps. No further modifications.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Completion summary presented clearly
- Plan finalized with COMPLETE status
- Usage guidance provided
- Conversion specifics noted (if applicable)
- Session ends positively

### ❌ SYSTEM FAILURE:

- Not providing clear summary
- Not finalizing plan status
- Missing usage guidance

**Master Rule:** End on a positive note with clear summary and next steps. The workflow is ready to use.
