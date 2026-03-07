---
name: "step-04-step-type-validation"
description: "Validate that each step follows its correct step type pattern"

nextStepFile: "./step-05-output-format-validation.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
stepTypePatterns: "../data/step-type-patterns.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
---

# Validation Step 4: Step Type Validation

## STEP GOAL:

To validate that each step file follows the correct pattern for its step type - init, continuation, middle, branch, validation, final polish, or final.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Load and validate EVERY step against its type pattern - use subprocess optimization (Pattern 2: per-file deep analysis) when available
- 🚫 DO NOT skip any files or checks - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This is validation - systematic and thorough

## EXECUTION PROTOCOLS:

- 🎯 Load step type patterns first (use subprocess for data operations when available)
- 💾 Check EACH file follows its designated type pattern - use per-file subprocesses for deep analysis when available
- 📖 Append findings to validation report (subprocess updates report OR returns findings to parent)
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- All step files in steps-c/ must be validated
- Load {stepTypePatterns} for pattern definitions
- The design in {workflowPlanFile} specifies what each step should be

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Step Type Patterns

**Load {stepTypePatterns} to understand the pattern for each type:**

**If subprocess capability available:**

```markdown
Launch a subprocess that:

1. Loads {stepTypePatterns}
2. Extracts all pattern definitions deeply
3. Returns summary of patterns to parent (not full file - saves context)
```

**If subprocess unavailable:**

```markdown
Load {stepTypePatterns} in main context

# Larger context but still functional - demonstrates graceful fallback
```

**Step Types:**

1. **Init (Non-Continuable)** - Auto-proceed, no continuation logic
2. **Init (Continuable)** - Has continueFile reference, continuation detection
3. **Continuation (01b)** - Paired with continuable init, routes based on stepsCompleted
4. **Middle (Standard)** - A/P/C menu, collaborative content
5. **Middle (Simple)** - C only menu, no A/P
6. **Branch** - Custom menu with routing to different steps
7. **Validation Sequence** - Auto-proceed through checks, no menu
8. **Init (With Input Discovery)** - Has inputDocuments array, discovery logic
9. **Final Polish** - Loads entire doc, optimizes flow
10. **Final** - No next step, completion message

### 2. Check EACH Step Against Its Type

**DO NOT BE LAZY - For EACH file in steps-c/, launch a subprocess that:**

1. Determines what type this step SHOULD be from:
   - Step number (01 = init, 01b = continuation, last = final)
   - Design in {workflowPlanFile}
   - Step name pattern

2. Loads the step file

3. Validates it follows the pattern for its type

4. **EITHER** updates the validation report directly with its findings
5. **OR** returns structured findings to parent for aggregation

**SUBPROCESS ANALYSIS PATTERN - Validate each step file for:**

**For Init Steps:**

- ✅ Creates output from template (if document-producing)
- ✅ No A/P menu (or C-only)
- ✅ If continuable: has continueFile reference

**For Continuation (01b):**

- ✅ Has nextStepOptions in frontmatter
- ✅ Reads stepsCompleted from output
- ✅ Routes to appropriate step

**For Middle (Standard):**

- ✅ Has A/P/C menu
- ✅ Outputs to document (if applicable)
- ✅ Has mandatory execution rules

**For Middle (Simple):**

- ✅ Has C-only menu
- ✅ No A/P options

**For Branch:**

- ✅ Has custom menu letters
- ✅ Handler routes to different steps

**For Validation Sequence:**

- ✅ Auto-proceeds (no user choice)
- ✅ Proceeds to next validation

**For Final Polish:**

- ✅ Loads entire document
- ✅ Optimizes flow, removes duplication
- ✅ Uses ## Level 2 headers

**For Final:**

- ✅ No nextStepFile in frontmatter
- ✅ Completion message
- ✅ No next step to load

**RETURN FORMAT:**
Return a concise summary containing:

- File name analyzed
- What type the step should be
- What type it actually is
- Whether it follows the correct pattern
- List of any violations found
- Overall pass/fail status

**Context savings:** Each subprocess returns only validation findings, not full file contents. Parent receives structured analysis objects instead of 10+ full step files.

### 3. Aggregate Findings and Document

**After ALL files analyzed, aggregate findings from subprocesses and document results:**

**Document the following in the validation report:**

- Overall summary of step type validation (how many steps checked, pass/fail counts)
- For each step file:
  - File name
  - What type the step should be (based on design, step number, naming)
  - What type it actually is
  - Whether it follows the correct pattern for its type
  - Any violations or issues found
  - Pass/fail/warning status

**Format:** Create a clear, readable section in the validation report that shows the validation results for each step file.

### 4. List Violations

**Compile and document all violations found:**

**Document the following for any violations:**

- File name with violation
- What the violation is (specifically what doesn't match the expected pattern)
- What should be changed to fix it
- Severity level (error/warning)

**For files that pass validation:** Briefly note they follow their type patterns correctly.

### 5. Append to Report

Update {validationReportFile} - replace "## Step Type Validation _Pending..._" with actual findings.

### 6. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Step Type validation complete.** Proceeding to Output Format Validation..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- EVERY step validated against its type pattern (ideally using per-file subprocess optimization)
- All violations documented with structured findings
- Findings aggregated from subprocesses into report
- Report saved before proceeding
- Next validation step loaded
- Context saved: parent receives only findings, not full file contents

### ❌ SYSTEM FAILURE:

- Not checking every file's type pattern
- Skipping type-specific checks
- Not documenting violations
- Not saving report before proceeding

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Check EVERY file's type pattern. Auto-proceed through all validation steps.
