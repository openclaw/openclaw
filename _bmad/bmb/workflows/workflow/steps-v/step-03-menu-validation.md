---
name: "step-03-menu-validation"
description: "Validate menu handling compliance across all step files"

nextStepFile: "./step-04-step-type-validation.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
menuHandlingStandards: "../data/menu-handling-standards.md"
---

# Validation Step 3: Menu Handling Validation

## STEP GOAL:

To validate that EVERY step file's menus follow the menu handling standards - proper handlers, execution rules, appropriate menu types.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Validate EVERY step file's menus using subprocess optimization - per-file deep analysis pattern (Pattern 2)
- 🚫 DO NOT skip any files or checks - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This is validation - systematic and thorough, leveraging per-file subprocess for menu structure analysis

## EXECUTION PROTOCOLS:

- 🎯 Load menu standards first
- 💾 Check EVERY file's menu structure using subprocess optimization when available - per-file deep analysis for menu structure validation
- 📖 Append findings to validation report (subprocesses either update report OR return findings for parent aggregation)
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- All step files in steps-c/ must be validated
- Load {menuHandlingStandards} for validation criteria
- Check for: handler section, execution rules, reserved letters, inappropriate A/P

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Menu Standards

Load {menuHandlingStandards} to understand validation criteria:

**Reserved Letters:** A (Advanced Elicitation), P (Party Mode), C (Continue/Accept), X (Exit/Cancel)

**Required Structure:**

1. Display section
2. Handler section (MANDATORY)
3. Execution Rules section

**When To Include A/P:**

- DON'T: Step 1 (init), validation sequences, simple data gathering
- DO: Collaborative content creation, user might want alternatives, quality gates

### 2. Check EVERY Step File

**DO NOT BE LAZY - For EVERY file in steps-c/, launch a subprocess that:**

1. Loads that step file
2. Loads {menuHandlingStandards} to understand validation criteria
3. Validates menu structure deeply (handler section, execution rules, A/P appropriateness, reserved letter compliance)
4. **EITHER** updates validation report directly with findings
5. **OR** returns structured validation findings to parent for aggregation

**SUBPROCESS VALIDATION PATTERN - Each subprocess checks for:**

**Check 1: Handler Section Exists**

- ✅ Handler section immediately follows Display
- ❌ If missing: mark as violation

**Check 2: Execution Rules Section Exists**

- ✅ "EXECUTION RULES" section present
- ✅ Contains "halt and wait" instruction
- ❌ If missing: mark as violation

**Check 3: Non-C Options Redisplay Menu**

- ✅ A/P options specify "redisplay menu"
- ❌ If missing: mark as violation

**Check 4: C Option Sequence**

- ✅ C option: save → update frontmatter → load next step
- ❌ If sequence wrong: mark as violation

**Check 5: A/P Only Where Appropriate**

- Step 01 should NOT have A/P (inappropriate for init)
- Validation sequences should auto-proceed, not have menus
- ❌ If A/P in wrong place: mark as violation

**RETURN FORMAT:**
Each subprocess should return validation findings for its assigned file including:

- File name
- Whether a menu is present
- Results of all 5 checks (handler section, execution rules, redisplay menu, C sequence, A/P appropriateness)
- List of any violations found
- Overall status (PASS/FAIL/WARN)

**Context savings estimate:** Each subprocess returns structured findings vs full file content. Parent aggregates all findings into final report table.

### 3. Aggregate Findings and Document Results

After ALL files have been validated (either via subprocess or main context), document the menu handling validation results in the validation report, including:

- Overall assessment of menu handling compliance across all step files
- Summary of files checked and their menu status
- Files that passed all menu validation checks
- Files with warnings or issues that need attention
- Files that failed validation with specific violations

### 4. List Violations

Compile and document all violations found during validation, organizing them by file and providing clear descriptions of each issue, such as:

- Missing handler sections
- Incomplete execution rules
- Improper A/P usage
- Missing redisplay menu instructions
- Any other menu handling standard violations

### 5. Append to Report

Update {validationReportFile} - replace "## Menu Handling Validation _Pending..._" with actual findings.

### 6. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Menu Handling validation complete.** Proceeding to Step Type Validation..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Menu standards loaded and understood
- EVERY step file's menus validated via subprocess (per-file deep analysis) OR main context
- All violations documented across handler sections, execution rules, A/P appropriateness
- Findings aggregated into validation report (subprocesses either updated report OR returned findings)
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not checking every file's menus
- Skipping menu structure checks
- Not documenting violations
- Not saving report before proceeding
- Loading full file contents into parent context instead of using subprocess analysis

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Use subprocess optimization (Pattern 2) - each file in its own subprocess for deep menu structure analysis. Subprocess returns only findings to parent. Auto-proceed through all validation steps.
