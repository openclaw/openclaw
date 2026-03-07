---
name: "step-01-validate"
description: "Initialize validation: create report and check file structure & size"

nextStepFile: "./step-02-frontmatter-validation.md"
targetWorkflowPath: "{workflow_folder_path}"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
stepFileRules: "../data/step-file-rules.md"
---

# Validation Step 1: File Structure & Size

## STEP GOAL:

To create the validation report and check that the workflow has correct file structure and all step files are within size limits.

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

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

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

---

## File Structure & Size

_Validation in progress..._

## Frontmatter Validation

_Pending..._

## Critical Path Violations

_Pending..._

## Menu Handling Validation

_Pending..._

## Step Type Validation

_Pending..._

## Output Format Validation

_Pending..._

## Validation Design Check

_Pending..._

## Instruction Style Check

_Pending..._

## Collaborative Experience Check

_Pending..._

## Subprocess Optimization Opportunities

_Pending..._

## Cohesive Review

_Pending..._

## Plan Quality Validation

_Pending..._

## Summary

_Pending..._
```

### 2. Load File Structure Standards

Load {stepFileRules} to understand:

- File size limits (<200 recommended, 250 max)
- Required folder structure
- Required files

### 3. Check Folder Structure

**Launch a single subprocess that:**

1. Lists the entire folder structure using bash commands
2. Verifies all required folders and files exist
3. Returns structured findings to parent for aggregation

```bash
# List folder structure
find {targetWorkflowPath} -type f -name "*.md" | sort
```

**Expected structure:**

```
{targetWorkflowPath}/
├── workflow.md
├── steps*/ potentially more than one folder like this (such as steps-v, steps-c - the folder name is not critical but should make sense)
│   ├── step-01-init.md
│   ├── step-01b-continue.md (if continuable)
│   ├── step-02-*.md
│   └── ...
├── */ # any other random files - critical will be later ensure its all used - aside from potential documentation for user later.
├── data/
│   └── [as needed]
└── templates/
    └── [as needed]
```

**Check:**

- ✅ workflow.md exists
- ✅ step files are in a well organized folder
- ✅ non step reference files are organized in other folders such as data, templates, or others that make sense for the workflow
- ✅ Folder names make sense

### 4. Check File Sizes

**DO NOT BE LAZY - For EACH step file in steps-c/, launch a subprocess that:**

1. Loads that step file
2. Counts lines and checks against size limits
3. Returns structured findings to parent for aggregation

**Limits:**

- < 200 lines: ✅ Good
- 200-250 lines: ⚠️ Approaching limit
- > 250 lines: ❌ Exceeds limit

**Subprocess returns:** File name, line count, status (Good/Approaching limit/Exceeds limit), and any issues found.

**Subprocess must either:**

- Update validation report directly with findings, OR
- Return structured findings to parent for aggregation into report

**Document findings in validation report:**

- List all step files checked with their line counts
- Note any files approaching or exceeding size limits (<200 recommended, 250 max)
- Check data and reference files for size issues (large files should be sharded or indexed)
- Identify specific size violations and recommendations

### 5. Verify File Presence

From the design in {workflowPlanFile}, verify:

- Every step from design has a corresponding file
- Step files are numbered sequentially
- No gaps in numbering
- Final step exists

### 6. Append Findings to Report

Replace the "## File Structure & Size" section in {validationReportFile} with actual findings:

**Document the following:**

- Folder structure assessment
- Required files presence check
- File size analysis results
- List of any issues found (missing files, extra files, size violations, naming issues)
- Overall validation status (PASS/FAIL/WARNINGS)

### 7. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**File Structure & Size validation complete.** Proceeding to Frontmatter Validation..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Validation report created with header structure
- EVERY file checked for structure and size
- Findings appended to report
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not checking every file
- Skipping size checks
- Not saving report before proceeding
- Halting for user input

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Check EVERY file. Auto-proceed through all validation steps.
