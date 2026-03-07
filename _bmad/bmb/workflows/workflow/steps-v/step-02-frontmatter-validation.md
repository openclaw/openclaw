---
name: "step-02-frontmatter-validation"
description: "Validate frontmatter compliance across all step files"

nextStepFile: "./step-02b-path-violations.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
frontmatterStandards: "../data/frontmatter-standards.md"
---

# Validation Step 2: Frontmatter Validation

## STEP GOAL:

To validate that EVERY step file's frontmatter follows the frontmatter standards - correct variables, proper relative paths, NO unused variables.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - VALIDATE EVERY FILE'S FRONTMATTER
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context thread

### Step-Specific Rules:

- 🎯 Validate EVERY step file's frontmatter using subprocess optimization - each file in its own subprocess
- 🚫 DO NOT skip any files or checks - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This is validation - systematic and thorough using per-file deep analysis (Pattern 2)

## EXECUTION PROTOCOLS:

- 🎯 Load frontmatter standards first, then validate each file in its own subprocess for deep analysis
- 💾 Subprocesses must either update validation report OR return findings for parent aggregation
- 📖 Aggregate all findings into validation report before loading next step
- 🚫 DO NOT halt for user input - validation runs to completion

## CONTEXT BOUNDARIES:

- All step files in the workflow must be validated
- Load {frontmatterStandards} for validation criteria
- Check for: unused variables, non-relative paths, missing required fields, forbidden patterns

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Frontmatter Standards

Load {frontmatterStandards} to understand validation criteria.

**Key Rules:**

1. Only variables USED in the step may be in frontmatter
2. All file references MUST use `{variable}` format
3. Paths within workflow folder MUST be relative - NO `workflow_path` allowed

**Forbidden Patterns:**

- `workflow_path: '...'` - use relative paths instead
- `thisStepFile: '...'` - remove unless actually referenced in body
- `workflowFile: '...'` - remove unless actually referenced in body
- `./...` - use `./step-XX.md`
- `{workflow_path}/templates/...` - use `../template.md`

### 2. Validate EVERY Step File - Systematic Algorithm with Subprocess Optimization

**DO NOT BE LAZY - For EACH step file, launch a subprocess that:**

1. Loads that file
2. Loads {frontmatterStandards} to understand validation criteria
3. Performs all frontmatter validation checks on that file (extract variables, check usage, validate paths)
4. **EITHER** updates the validation report directly with its findings
5. **OR** returns structured findings to parent for aggregation

**SUBPROCESS ANALYSIS PATTERN:**

For each file, the subprocess performs the following deep analysis:

#### Step 2.1: Extract Frontmatter Variables

```python
# Algorithm to extract variables from frontmatter:
1. Find content between first `---` and second `---`
2. For each line, extract key before `:`
3. Skip `name`, `description`, and comment lines starting with `#`
4. Collect all variable names
```

Example frontmatter:

```yaml
---
# File References
nextStepFile: "./step-02-vision.md"
outputFile: "{planning_artifacts}/product-brief-{{project_name}}.md"
workflow_path: "{project-root}/..." # ❌ FORBIDDEN
thisStepFile: "./step-01-init.md" # ❌ Likely unused
---
```

Variables extracted: `nextStepFile`, `outputFile`, `workflow_path`, `thisStepFile`

#### Step 2.2: Check Each Variable Is Used

```python
# Algorithm to check variable usage:
for each variable in extracted_variables:
    search_body = "{variableName}"  # with curly braces
    if search_body NOT found in step body (after frontmatter):
        MARK_AS_UNUSED(variable)
```

**Example:**

- Variable `nextStepFile`: Search body for `{nextStepFile}` → Found in line 166 ✅
- Variable `thisStepFile`: Search body for `{thisStepFile}` → Not found ❌ VIOLATION

#### Step 2.3: Check Path Formats

For each variable containing a file path:

```python
# Algorithm to validate paths:
if path contains "{workflow_path}":
    MARK_AS_VIOLATION("workflow_path is forbidden - use relative paths")

if path is to another step file:
    if not path.startswith("./step-"):
        MARK_AS_VIOLATION("Step-to-step paths must be ./filename.md")

if path is to parent folder template:
    if not path.startswith("../"):
        MARK_AS_VIOLATION("Parent folder paths must be ../filename.md")

if path contains "{project-root}" and is internal workflow reference:
    MARK_AS_VIOLATION("Internal paths must be relative, not project-root")
```

**RETURN FORMAT:**

Subprocess returns file name, frontmatter compliance status, unused variables found, path violations, and overall status (PASS/FAIL). Include specific variable names and violation details for documentation.

Check ALL files systematically. Return findings for compilation and appendage to validation report.

### 3. Aggregate Findings and Document Results

Document frontmatter validation results in the validation report showing:

- Which files were checked
- Frontmatter compliance status for each file
- Unused variables found in each file
- Path violations detected
- Overall pass/fail status for each file

### 4. List All Violations

Document all violations found in the validation report, including:

- Specific files with violations
- Unused variable names and why they're unused
- Forbidden patterns detected with explanation
- Path format violations with details
- Files that passed all checks

### 5. Append to Report

Update {validationReportFile} - replace "## Frontmatter Validation _Pending..._" with actual findings.

### 6. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Frontmatter validation complete.** Proceeding to Menu Handling Validation..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- EVERY step file validated using subprocess optimization (Pattern 2: per-file deep analysis)
- Each subprocess validates frontmatter, checks variable usage, validates paths
- Structured findings returned to parent OR report updated directly by subprocesses
- All violations documented with specific variable names
- Findings aggregated into validation report
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not validating every file using subprocess optimization
- Not systematically checking each variable for usage in subprocess
- Missing forbidden pattern detection
- Not documenting violations with specific details
- Not returning structured findings OR updating report from subprocess
- Not saving report before proceeding

**Master Rule:** Validation is systematic and thorough using subprocess optimization. DO NOT BE LAZY. For EACH file, launch a subprocess that validates frontmatter, checks variable usage, validates paths, and returns findings. Auto-proceed through all validation steps.
