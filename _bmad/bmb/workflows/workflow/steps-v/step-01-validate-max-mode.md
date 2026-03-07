---
name: 'step-01-validate'
description: 'Initialize validation: create report and check file structure & size'

parallel-steps: ['./step-01b-structure.md', './step-02-frontmatter-validation.md', './step-02b-path-violations.md', './step-03-menu-validation.md' './step-04-step-type-validation.md', './step-05-output-format-validation.md', './step-06-validation-design-check.md', './step-07-instruction-style-check.md', './step-08-collaborative-experience-check.md', './step-08b-subprocess-optimization.md', './step-09-cohesive-review.md']
nextStep: './step-10-report-complete.md'
targetWorkflowPath: '{workflow_folder_path}'
workflowPlanFile: '{workflow_folder_path}/workflow-plan.md'
validationReportFile: '{workflow_folder_path}/validation-report-{datetime}.md'
partialValidationFragmentFile: '{workflow_folder_path}/validation-report-{step-name}.md'
stepFileRules: '../data/step-file-rules.md'
---

# Validation Step 1: File Structure & Size

## STEP GOAL:

To create the validation report that all parallel tasks that this will kick off will be able to report to.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Create validation report with header structure using subprocess optimization when available
- 🚫 DO NOT skip checking any file - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This is validation - systematic and thorough

## EXECUTION PROTOCOLS:

- 🎯 Load and check EVERY file in the workflow using subprocess optimization when available - single subprocess for bash/grep operations, separate subprocess per file for size analysis
- 💾 Subprocesses must either update validation report OR return findings for parent aggregation
- 📖 Save report before loading next validation step
- 🚫 DO NOT halt for user input - validation runs to completion

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut. IF there is no subprocess type tool available that can achieve running a process in a subprocess and handle starting multiple - let the user know they need to restart validation specifically NOT using max-parallel mode and HALT and end this workflow!

### 1. Create Validation Report

Create {validationReportFile} with header structure:

```markdown
---
validationDate: [current date]
workflowName: { new_workflow_name }
workflowPath: { workflow_folder_path }
validationStatus: IN_PROGRESS
---

# Validation Report: {new_workflow_name}

**Validation Started:** [current date]
**Validator:** BMAD Workflow Validation System
**Standards Version:** BMAD Workflow Standards

{{TOC}}

{{#each parallel-steps}}

## {{title}}

{{results}}

{{/each}}
```

Save the file (without the handlebars output of course) before proceeding.

### 2. Launch Mass Parallelization and consolidate results!

Utilizing a subprocess for each step file in {parallel-steps} - complete all of these - with the caveat indication to the subprocess that at the end of the specific step it will not on its own proceed to the nextStep file!

Critically - instruct that instructions to write out or return results within each subprocess for a step file in the array MUST ensure that it writes it to {partialValidationFragmentFile} file name even though the step file it loads might indicate otherwise!

Once every process has completed - there should be a separate validation file for each given step. Also - each step should return JUST its results and recommendations to you also.

### 3. CRITICAL WRITES to the report.

You MUST now ensure that all results are added to the final cohesive {validationReportFile} following the indicated handlebars sequence - and then after appending each subprocess report to a level 2 section - and the TOC to accurately reflect the documents state using proper markdown linking conventions to the actual heading names you created.

IF a file is missing or empty from a given subprocess - but it did return to you results - you will append those results - ONLY do this if you cannot access the specific steps file produced or it is empty though. IE File from subprocess is primary, results returned from step complete are backup insurance.

### 4. Proceed to Completion Step

ONLY after ensuring all has been written to the final report, let the user know about the final report that is a consolidation - and they can ignore or remove the smaller files or use them as they like to focus on a specific validation (but its all in the master doc), and then proceed to {nextStep}, ensuring that in the {nextStep} it is focused on the {validationReportFile}

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Validation report created with header structure
- EVERY section of the template is filled in with content from a subprocess that added the results of its area of expertise

### ❌ SYSTEM FAILURE:

- Output Report does not exist with content all filled in
- EVERY step listed in {parallel-steps} was not executed in a subprocess and completed with its results captured in output
