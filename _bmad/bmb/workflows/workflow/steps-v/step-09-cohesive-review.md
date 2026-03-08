---
name: "step-09-cohesive-review"
description: "Cohesive ultra-think review - overall quality, does this workflow actually facilitate well?"

nextStepFile: "./step-10-report-complete.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
---

# Validation Step 9: Cohesive Review

## STEP GOAL:

To perform a cohesive "ultra-think" review of the entire workflow - walk through it as a whole, assess overall quality, does it actually facilitate well?

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Review the workflow as a cohesive whole - **NOTE: This step loads ENTIRE workflow for holistic review (different pattern from other validation steps)**
- 🚫 DO NOT skip any aspect of the review - DO NOT BE LAZY
- 💬 Subprocess optimization: When available, can use subprocesses to load individual step files and return structured summaries to parent for aggregation
- 💬 However, since cohesive review requires understanding the COMPLETE workflow as one unit, parent may need full context for proper holistic assessment
- 🚪 This is the meta-review - overall assessment

## EXECUTION PROTOCOLS:

- 🎯 Walk through the ENTIRE workflow end-to-end using subprocess optimization when available
- 💬 When using subprocesses: Each subprocess loads one step file, performs deep analysis, returns structured findings to parent for aggregation
- 💬 Subprocess must either update validation report directly OR return findings to parent for compilation
- 💾 Assess overall quality, not just individual components
- 📖 Think deeply: would this actually work well?
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- This is the cohesive review - look at the workflow as a whole
- Consider user experience from start to finish
- Assess whether the workflow achieves its goal
- Be thorough and thoughtful

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load the Entire Workflow

**DO NOT BE LAZY - Load EVERY step file using subprocess optimization when available:**

**SUBPROCESS APPROACH (when available):**

For EACH workflow file (workflow.md + all step files in order), launch a subprocess that:

1. Loads that single file
2. Performs deep analysis of content, flow, quality, and connection points
3. Returns structured findings to parent for holistic aggregation

**Subprocess should return:**

- File name analyzed
- Purpose and flow position within the workflow
- How it connects to previous and next steps
- Quality indicators and any issues found
- Voice and tone consistency assessment

**FALLBACK APPROACH (if subprocess unavailable):**

Load workflow.md and EVERY step file in steps-c/ sequentially in main context:

1. Load workflow.md
2. Load EVERY step file in steps-c/ in order
3. Read through each step
4. Understand the complete flow

**CRITICAL:** Whether using subprocess or main context, you must understand the COMPLETE workflow as one cohesive unit before proceeding to assessment.

### 2. Walk Through the Workflow Mentally

**Imagine you are a user running this workflow:**

- Starting from workflow.md
- Going through step-01
- Progressing through each step
- Experiencing the interactions
- Reaching the end

**Ask yourself:**

- Does this make sense?
- Is the flow logical?
- Would I feel guided or confused?
- Does it achieve its goal?

### 3. Assess Cohesiveness

**Check for:**

**✅ Cohesive Indicators:**

- Each step builds on previous work
- Clear progression toward goal
- Consistent voice and approach throughout
- User always knows where they are
- Satisfying completion

**❌ Incohesive Indicators:**

- Steps feel disconnected
- Jumps in logic or flow
- Inconsistent patterns
- User might be confused
- Abrupt or unclear ending

### 4. Assess Overall Quality

**Evaluate the workflow across key dimensions:**

Consider goal clarity, logical flow, facilitation quality, user experience, and goal achievement. Provide an overall quality assessment based on these dimensions.

### 5. Identify Strengths and Weaknesses

**Strengths:**

- What does this workflow do well?
- What makes it excellent?
- What should other workflows emulate?

**Weaknesses:**

- What could be improved?
- What doesn't work well?
- What would confuse users?

**Critical Issues:**

- Are there any show-stopper problems?
- Would this workflow fail in practice?

### 6. Provide Recommendation

**Assess overall workflow readiness:**

Determine if the workflow is excellent (ready to use, exemplifies best practices), good (solid with minor improvements possible), needs work (has issues to address), or problematic (major issues requiring significant revision). Provide a clear recommendation on readiness for use.

### 7. Document Findings

**Document your cohesive review findings in the validation report:**

Include your overall assessment (excellent/good/needs work/problematic), quality evaluation across key dimensions, cohesiveness analysis (flow, progression, voice and tone), identified strengths and weaknesses, any critical issues, what makes the workflow work well, what could be improved, user experience forecast, and your recommendation on readiness for use.

### 8. Append to Report

Update {validationReportFile} - replace "## Cohesive Review _Pending..._" with actual findings.

### 9. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Cohesive Review complete.** Proceeding to finalize validation report..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- ENTIRE workflow reviewed end-to-end
- Quality assessed across multiple dimensions
- Strengths and weaknesses documented
- Thoughtful recommendation provided
- Findings appended to report
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not reviewing the entire workflow
- Superficial or lazy assessment
- Not documenting strengths/weaknesses
- Not providing clear recommendation
- Not saving report before proceeding

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Review the ENTIRE workflow cohesively. Think deeply about quality. Auto-proceed through all validation steps.
