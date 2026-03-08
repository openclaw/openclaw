---
name: "step-06-validation-design-check"
description: "Check if workflow has proper validation steps that load validation data (if validation is critical)"

nextStepFile: "./step-07-instruction-style-check.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
trimodalWorkflowStructure: "../data/trimodal-workflow-structure.md"
---

# Validation Step 6: Validation Design Check

## STEP GOAL:

To check if the workflow has proper validation steps when validation is critical - validation steps should load from validation data and perform systematic checks.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Check if workflow needs validation steps - use subprocess optimization (per-file deep analysis for Pattern 2)
- 🚫 DO NOT skip any validation step reviews - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return findings to parent for aggregation
- 🚪 This is validation - systematic and thorough

## EXECUTION PROTOCOLS:

- 🎯 Determine if validation is critical for this workflow - use subprocess optimization when available
- 💾 Check validation steps exist and are well-designed - launch subprocess for per-file deep analysis (Pattern 2)
- 💬 Subprocesses must either update validation report OR return findings for parent aggregation
- 📖 Append findings to validation report
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- Some workflows need validation (compliance, safety, quality gates)
- Others don't (creative, exploratory)
- Check the design to determine if validation steps are needed

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Determine If Validation Is Critical

From {workflowPlanFile}, check:

**Does this workflow NEED validation?**

**YES - Validation Critical If:**

- Compliance/regulatory requirements (tax, legal, medical)
- Safety-critical outputs
- Quality gates required
- User explicitly requested validation steps

**NO - Validation Not Critical If:**

- Creative/exploratory workflow
- User-driven without formal requirements
- Output is user's responsibility to validate

### 2. If Validation Is Critical, Check Validation Steps

**DO NOT BE LAZY - For EVERY validation step file, launch a subprocess that:**

1. Loads that validation step file
2. Reads and analyzes the step's content deeply (prose, logic, quality, flow, anti-lazy language)
3. Returns structured analysis findings to parent for aggregation

**SUBPROCESS ANALYSIS PATTERN - Check each validation step file for:**

**Proper Validation Step Design:**

- ✅ Loads validation data/standards from `data/` folder
- ✅ Has systematic check sequence (not hand-wavy)
- ✅ Auto-proceeds through checks (not stopping for each)
- ✅ Clear pass/fail criteria
- ✅ Reports findings to user

**"DO NOT BE LAZY" Language Check:**

- ✅ Step includes "DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE" or similar mandate
- ✅ Step instructs to "Load and review EVERY file" not "sample files"
- ✅ Step has "DO NOT SKIP" or "DO NOT SHORTCUT" language
- ⚠️ WARNING if validation step lacks anti-lazy language

**Critical Flow Check:**

- ✅ For critical flows (compliance, safety, quality gates): validation steps are in steps-v/ folder (tri-modal)
- ✅ Validation steps are segregated from create flow
- ✅ Validation can be run independently
- ⚠️ For non-critical flows (entertainment, therapy, casual): validation may be inline
- ❌ ERROR if critical validation is mixed into create steps

**RETURN FORMAT:**
Return a structured analysis containing:

- Step file name
- Proper design checklist (loads data, systematic checks, auto-proceeds, clear criteria, reports findings)
- Anti-lazy language check (has mandate, mandate text, comprehensive coverage)
- Critical flow check (location, segregation, independence)
- Any issues found
- Overall status (PASS/FAIL/WARN)

**Context savings:** Each subprocess returns analysis (~30 lines), not full step file (~200 lines). Parent gets structured findings, not file contents.

### 3. Aggregate Findings from All Subprocesses

After all validation step files have been analyzed in subprocesses, aggregate findings:

**Process subprocess results:**

- Compile all structured analysis findings
- Identify patterns across validation steps
- Note any critical issues or warnings

### 4. Check Validation Data Files

**If workflow has validation steps:**

1. Check `data/` folder for validation data
2. Verify data files exist and are properly structured:
   - CSV files have headers
   - Markdown files have clear criteria
   - Data is referenced in step frontmatter

### 5. Document Findings

**Create/Update "Validation Design Check" section in {validationReportFile} using aggregated subprocess findings:**

Document the following information:

**Whether validation is required:** Indicate if this workflow needs validation steps based on its domain type (critical/compliance/safety workflows vs. creative/exploratory ones)

**List of validation steps found:** Provide the names/paths of all validation step files in the workflow

**Validation step quality assessment:** For each validation step, document:

- Whether it loads validation data/standards from the data/ folder
- Whether it has a systematic check sequence
- Whether it auto-proceeds through checks (vs. stopping for user input)
- Whether it includes "DO NOT BE LAZY" or similar anti-lazy language mandates
- Whether it has clear pass/fail criteria
- Overall status (PASS/FAIL/WARN)

**"DO NOT BE LAZY" language presence:** For each validation step, note whether anti-lazy language is present and what it says

**Critical flow segregation:** For workflows requiring validation, document:

- The workflow domain type
- Whether validation steps are in the steps-v/ folder (tri-modal structure) or inline with create steps
- Whether this segregation is appropriate for the workflow type

**Validation data files:** List any validation data files found in the data/ folder, or note if they are missing

**Issues identified:** List any problems found with the validation design, missing data files, or quality concerns

**Overall status:** Provide final assessment (PASS/FAIL/WARN/N/A) with reasoning

### 6. Append to Report

Update {validationReportFile} - replace "## Validation Design Check _Pending..._" with actual findings from subprocess aggregation.

### 7. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Validation Design check complete.** Proceeding to Instruction Style Check..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Determined if validation is critical
- If critical: checked all validation steps
- Validated validation step quality
- Checked validation data files
- Findings documented
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not checking validation steps when critical
- Missing validation data files
- Not documenting validation design issues
- Not saving report before proceeding

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Check validation steps thoroughly. Auto-proceed through all validation steps.
