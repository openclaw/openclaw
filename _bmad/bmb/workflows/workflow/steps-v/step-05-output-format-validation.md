---
name: "step-05-output-format-validation"
description: "Validate output format compliance - template type, final polish, step-to-output mapping"

nextStepFile: "./step-06-validation-design-check.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
outputFormatStandards: "../data/output-format-standards.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
---

# Validation Step 5: Output Format Validation

## STEP GOAL:

To validate that the workflow's output format matches the design - correct template type, proper final polish step if needed, and step-to-output mapping is correct.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context thread

### Step-Specific Rules:

- 🎯 Validate output format using subprocess optimization - per-file subprocess for step-to-output validation
- 🚫 DO NOT skip any checks - DO NOT BE LAZY
- 💬 Subprocess must either update validation report OR return findings to parent for aggregation
- 🚪 This is validation - systematic and thorough

## EXECUTION PROTOCOLS:

- 🎯 Load output format standards first
- 💾 Check template type matches design
- 📖 Check for final polish step if needed
- 🔍 Use subprocess optimization for step-to-output mapping validation - per-file subprocess for deep analysis
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- Check template file in templates/ folder
- Review design in {workflowPlanFile} for output format specification
- Validate step-to-output mapping
- Check if final polish step is present (if needed)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Output Format Standards

Load {outputFormatStandards} to understand:

**Golden Rule:** Every step MUST output to document BEFORE loading next step.

**Four Template Types:**

1. **Free-form** (Recommended) - Minimal structure, progressive append
2. **Structured** - Required sections, flexible within each
3. **Semi-structured** - Core sections plus optional additions
4. **Strict** - Exact format, specific fields (rare)

**Final Polish Step:**

- For free-form workflows, include a polish step that optimizes the entire document
- Loads entire document, reviews for flow, removes duplication

### 2. Check Design Specification

From {workflowPlanFile}, identify:

- Does this workflow produce a document?
- If yes, what template type was designed?
- Is a final polish step needed?

### 3. Validate Template File

**If workflow produces documents:**

1. Load the template file from `templates/` folder
2. Check it matches the designed type:

**For Free-form (most common):**

- ✅ Has frontmatter with `stepsCompleted: []`
- ✅ Has `lastStep: ''`
- ✅ Has `date: ''`
- ✅ Has `user_name: ''`
- ✅ Document title header
- ✅ No rigid section structure (progressive append)

**For Structured:**

- ✅ Has clear section headers
- ✅ Section placeholders with {{variable}} syntax
- ✅ Consistent structure

**For Semi-structured:**

- ✅ Has core required sections
- ✅ Has optional section placeholders

**For Strict:**

- ✅ Has exact field definitions
- ✅ Validation rules specified

### 4. Check for Final Polish Step

**If free-form template:**

- ✅ A final polish step should exist in the design
- ✅ The step loads entire document
- ✅ The step optimizes flow and coherence
- ✅ The step removes duplication
- ✅ The step ensures ## Level 2 headers

**If no final polish step for free-form:**

- ⚠️ WARNING - Free-form workflows typically need final polish

### 5. Validate Step-to-Output Mapping

**DO NOT BE LAZY - For EACH step that outputs to document, launch a subprocess that:**

1. Loads that step file
2. Analyzes frontmatter for `outputFile` variable
3. Analyzes step body to verify output is written before loading next step
4. Checks menu C option saves to output before proceeding
5. Returns structured findings to parent for aggregation

**SUBPROCESS EXECUTION PATTERN:**

**For EACH step file, launch a subprocess that:**

1. Loads the step file
2. Performs deep analysis of output operations (frontmatter, body, menu options)
3. Returns findings to parent for aggregation

**RETURN FORMAT:**
Each subprocess should return:

- Step filename
- Whether output variable exists in frontmatter
- Whether output is saved before loading next step
- Whether menu option C saves to output before proceeding
- Output order number (if applicable)
- Any issues found
- Overall status (PASS/FAIL/WARNING)

**Parent aggregates findings into:**

**Steps should be in ORDER of document appearance:**

- Step 1 creates doc
- Step 2 → ## Section 1
- Step 3 → ## Section 2
- Step N → Polish step

### 6. Document Findings

Document your output format validation findings in the validation report. Include:

- **Document Production**: Whether the workflow produces documents and what template type it uses
- **Template Assessment**: Template file existence, whether it matches the designed type, and frontmatter correctness
- **Final Polish Evaluation**: Whether a final polish step is required (for free-form workflows) and if present, whether it properly loads the entire document and optimizes flow
- **Step-to-Output Mapping**: For each step that outputs to the document, document whether it has the output variable in frontmatter, saves output before loading the next step, and properly saves in menu option C
- **Subprocess Analysis Summary**: Count of total steps analyzed, steps with output, steps saving correctly, and steps with issues
- **Issues Identified**: List any problems found with template structure, polish step, or output mapping
- **Overall Status**: Pass, fail, or warning designation

### 7. Append to Report

Update {validationReportFile} - replace "## Output Format Validation _Pending..._" with actual findings.

### 8. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Output Format validation complete.** Proceeding to Validation Design Check..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Template type matches design
- Final polish step present if needed
- Step-to-output mapping validated via subprocess optimization
- All findings documented
- Report saved before proceeding
- Next validation step loaded
- Subprocess pattern applied correctly (per-file analysis for step-to-output validation)

### ❌ SYSTEM FAILURE:

- Not checking template file
- Missing final polish step for free-form
- Not documenting mapping issues
- Not saving report before proceeding
- Not using subprocess optimization for step-to-output validation
- Loading all step files into parent context instead of per-file subprocess

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Check template, polish step, and mapping. Use subprocess optimization for step-to-output validation - per-file subprocess returns analysis, not full content. Auto-proceed through all validation steps.
