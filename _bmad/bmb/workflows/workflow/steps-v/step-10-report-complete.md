---
name: "step-10-report-complete"
description: "Finalize validation report - check for plan file, summarize all findings, present to user"

targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
planValidationStep: "./step-11-plan-validation.md"
---

# Validation Step 10: Report Complete

## STEP GOAL:

To check if a plan file exists (and run plan validation if it does), then summarize all validation findings and present to the user.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 This is the final validation step - present findings
- 🚫 DO NOT modify the workflow without user request
- 💬 Present summary and ask what changes are needed
- 🚪 This ends validation - user decides next steps

## EXECUTION PROTOCOLS:

- 🎯 Load the complete validation report
- 💾 Summarize ALL findings
- 📖 Update report status to COMPLETE
- 🚫 DO NOT proceed without user review

## CONTEXT BOUNDARIES:

- All 10 previous validation steps have completed
- Report contains findings from all checks
- User needs to see summary and decide on changes
- This step DOES NOT auto-proceed

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Check for Plan File

Before finalizing the report, check if a plan file exists:

**Check if {workflowPlanFile} exists:**

- **IF YES:** Run plan validation first
  - Load, read entire file, then execute {planValidationStep}
  - The plan validation will append its findings to the report
  - Then return to this step to finalize the report
- **IF NO:** Proceed to finalize the report (no plan to validate)

### 2. Load Complete Validation Report

After plan validation (if applicable), load {validationReportFile} and read ALL findings from every validation step.

### 3. Create Summary Section

At the end of {validationReportFile}, replace "## Summary _Pending..._" with a comprehensive summary that includes:

- Validation completion date
- Overall status assessment (based on all validation steps)
- List of all validation steps completed with their individual results
- Summary of critical issues that must be fixed (or note if none found)
- Summary of warnings that should be addressed (or note if none found)
- Key strengths identified during validation
- Overall assessment of workflow quality
- Recommendation on readiness (ready to use / needs tweaks / needs revision / major rework needed)
- Suggested next steps for the user

Present this information in a clear, readable format - the exact structure is flexible as long as it covers all these points.

### 4. Update Report Status

Update the frontmatter of {validationReportFile} to set validationStatus to COMPLETE and add the completionDate. Keep existing fields like validationDate, workflowName, and workflowPath unchanged.

### 5. Present Summary to User

Present a clear summary to the user that includes:

- Confirmation that validation is complete
- Overall status of the workflow
- Quick results overview showing each validation step and its result
- Count of critical issues and warnings (or note if none found)
- Recommendation on workflow readiness
- Path to the full validation report
- Options for next steps (review detailed findings, make changes, explain results, or other actions)

Present this information in a natural, conversational way - the exact format doesn't matter as long as all this information is clearly communicated.

### 6. Present MENU OPTIONS

Display: **Validation Complete! Select an Option:** [R] Review Detailed Findings [F] Fix Issues [X] Exit Validation

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User chooses their next action

#### Menu Handling Logic:

- IF R: Walk through the validation report section by section, explaining findings, then redisplay menu
- IF F: "What issues would you like to fix?" → Discuss specific changes needed → User can make edits manually OR you can help edit files
- IF X: "Validation complete. Your workflow is at: {targetWorkflowPath}. You can make changes and re-run validation anytime."
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#5-present-menu-options)

### 7. If User Wants to Fix Issues

Explain the available options for fixing issues:

- Manual edits: User edits files directly, then re-runs validation
- Guided edits: User specifies what to fix, help create specific edits for user approval
- Edit workflow: If the workflow has steps-e/, use the edit workflow to make systematic changes

The exact format doesn't matter - just ensure the user understands their options for addressing issues.

### 8. Update Plan with Validation Status

If a plan file exists at {workflowPlanFile}, update its frontmatter to include the validation status (COMPLETE), the current validation date, and a reference to the validation report file.

## CRITICAL STEP COMPLETION NOTE

This is the final validation step. User reviews findings and decides whether to make changes. Validation workflow ends here.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All validation findings summarized
- Complete report presented to user
- Summary section added to report
- Report status updated to COMPLETE
- User can review findings and decide on changes
- Plan updated with validation status

### ❌ SYSTEM FAILURE:

- Not summarizing all findings
- Not presenting complete report to user
- Not updating report status
- Not giving user clear options for next steps

**Master Rule:** Validation is complete. User reviews findings and decides what changes to make. Provide clear summary and options.
