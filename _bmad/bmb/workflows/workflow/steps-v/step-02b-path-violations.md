---
name: "step-02b-path-violations"
description: "CRITICAL: Catch path violations step-02 misses - hardcoded paths, dead links, module awareness"

nextStepFile: "./step-03-menu-validation.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
---

# Validation Step 2b: Critical Path Violations

## STEP GOAL:

CRITICAL path checks that step-02's frontmatter validation MISSES. This catches violations in CONTENT (not frontmatter), dead links, and module path unawareness using grep/bash (ideally in a subprocess that can update the report or return all results to parent).

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - CHECK EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction in this file references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the instructed outcome in your main context thread and available toolset

### Step-Specific Rules:

- 🎯 Perform systematic bash/grep checks using subprocess optimization - single subprocess for grep/regex across many files
- 🚫 DO NOT skip any file or violation type - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This catches what step-02 misses - CONTENT violations, dead links, module awareness, links in code and not in front matter

## EXECUTION PROTOCOLS:

- 🎯 Perform systematic checks using subprocess optimization when available - single subprocess for grep/regex across many files, separate subprocess per file for deep analysis, subprocess for data file operations
- 💾 Subprocesses must either update validation report OR return findings for parent aggregation
- 📖 Save report before continuing to {nextStepFile}

## CONTEXT BOUNDARIES:

- Step-02 validated frontmatter (variables, relative paths)
- This step validates CONTENT and file existence with a Focus on: hardcoded paths in body, dead links, module awareness in every file found under {targetWorkflowPath}
- **CRITICAL:** Output files the workflow itself being validated produces won't exist during validation - <example> a contract document creation workflow might have a reference to said output - but it of course will not yet exist during workflow validation</example>

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Perform Critical Path Violation Detection

**Perform systematic path violation checks on EVERY workflow file using subprocess optimization when available - each file in its own subprocess:**

**SUBPROCESS EXECUTION PATTERN:**

For EACH file in the workflow being validated, launch a subprocess that:

1. Loads any reference files it needs (to avoid bloating parent context)
2. Performs all required checks on that file
3. **EITHER** updates the validation report directly with its findings
4. **OR** returns structured findings to parent for aggregation

**DO NOT BE LAZY - Use appropriate subprocess pattern for each check:**

- **Single subprocess for grep/regex**: Run one command across many files, return matches
- **Separate subprocess per file**: When deep analysis of each file's content is required
- **Subprocess for data operations**: Load reference data, find matches, summarize key findings

**PHASE 1: Identify Config Variables (EXCEPTIONS to path checks):**

Read {targetWorkflowPath}/workflow.md to extract known config variables from the Configuration Loading section:

```bash
# Extract config variables from workflow.md
grep -A 20 "Configuration Loading" {targetWorkflowPath}/workflow.md | grep -E "^\s+-\s+`\{[^}]+\}`" | sed "s/.*//;s/[`']//g"
```

**Store these as KNOWN_CONFIG_VARIABLES for reference in later checks.**

These are EXCEPTIONS - paths using these variables are VALID even if not relative:

- Example: `{output_folder}/doc.md` - VALID (uses config variable)
- Example: `{planning_artifacts}/prd.md` - VALID (uses config variable)
- These paths won't exist during validation (workflow not running yet)

---

**PHASE 2: Hardcoded paths in CONTENT (CRITICAL):**

Step-02 checks frontmatter - this checks CONTENT (body text after frontmatter).

**Launch a single subprocess that:**

1. Runs grep across all step files to find hardcoded {project-root}/ paths in content
2. Extracts content after frontmatter from each file
3. Returns all findings to parent for aggregation

```bash
# Extract content after frontmatter from all files, search for {project-root}/
for file in steps-c/*.md; do
  awk '/^---$/,0 {if (p) print; p=1} /^---$/{p=1}' "$file" | grep -n "{project-root}/" && echo "Found in: $file"
done
```

**What we're catching:**

- Content like: `Load {project-root}/_bmad/foo/workflows/.../file.csv`
- Should be: `Load {dataFile}` (frontmatter variable with a relative path like ../data/file.csv)

**SKIP:** Paths using KNOWN_CONFIG_VARIABLES (these are valid exceptions)

---

**PHASE 3: Dead or bad links - referenced files don't exist (CRITICAL):**

**Launch a single subprocess that:**

1. Extracts all frontmatter path references from all files
2. Tests file existence for each reference (skipping output files that use config variables)
3. Returns all dead link findings to parent for aggregation

**CRITICAL DISTINCTION:**

- **Output files using config variables:** Skip (won't exist yet - workflow not installed/running)
  - Example: `{output_folder}/my-doc.md` - SKIP
  - Example: `{planning_artifacts}/prd.md` - SKIP
  - Example: `{bmb_creations_output_folder}/file.md` - SKIP

- **Data files, step files, other workflows:** MUST EXIST - flag if missing
  - Example: `{dataFile}` where value is `../data/config.csv` - MUST EXIST
  - Example: `{nextStepFile}` where value is `./step-02.md` - MUST EXIST
  - Example: `{advancedElicitationTask}` - MUST EXIST
  - Example: `{partyModeWorkflow}` - MUST EXIST

**Bash execution pattern:**

```bash
# Extract all frontmatter path references from all files
for file in steps-c/*.md; do
  # Extract file reference variables from frontmatter
  grep "^\w*File:" "$file" | sed "s/.*: //"

  # Resolve path (handle relative paths)
  resolved_path=$(resolve_relative_path "$file" "$value")

  # Check file existence - BUT SKIP output files using config variables
  if ! path_uses_known_config_variable "$value"; then
    if ! test -f "$resolved_path"; then
      echo "DEAD LINK: $file references $resolved_path (not found)"
    fi
  fi
done
```

**What we're catching:**

- Dead links to any files that don't exist that the workflow needs during execution

---

**PHASE 4: Module path awareness:**

**Launch a single subprocess that:**

1. Determines if current workflow is in a non-bmb module
2. If yes, runs grep across all files to find bmb-specific path assumptions
3. Returns all module awareness issues to parent for aggregation

```bash
# Check if in non-bmb module, then search for bmb-specific paths
if pwd | grep -q "/modules/[^/]\+/" && ! pwd | grep -q "/bmb/"; then
  grep -rn "{project-root}/_bmad/bmb/" steps-c/ steps-e/ steps-v/ 2>/dev/null || echo "No bmb-specific paths found"
fi
```

---

**RETURN FORMAT:**

```json
{
  "known_config_variables": ["output_folder", "planning_artifacts", "bmb_creations_output_folder", ...],
  "content_violations": [
    {"file": "step-v-01-discovery.md", "line": 63, "violation": "hardcoded path in content", "details": "{project-root}/src/modules/.../prd-purpose.md"}
  ],
  "dead_links": [
    {"file": "step-06-innovation.md", "line": 215, "violation": "dead link", "details": "nextStepFile './step-07-project-type.md' should be './step-07-project-type.md'"}
  ],
  "module_awareness_issues": [
    {"file": "step-XX.md", "issue": "using bmb-specific path in non-bmb module"}
  ],
  "summary": {"critical": N, "high": N, "medium": N}
}
```

Check ALL files systematically. Return structured report for compilation and appendage to validation report.

### 2. Process Findings and Update Report

**Create/Update "Critical Path Violations" section in {validationReportFile}:**

If ANY violations found:

```markdown
## Critical Path Violations

### Config Variables (Exceptions)

The following config variables were identified from workflow.md Configuration Loading section.
Paths using these variables are valid even if not relative (they reference post-install output locations):

{list of known_config_variables found}

### Content Path Violations

| File | Line | Issue | Details |
| ---- | ---- | ----- | ------- |

{table from content_violations}

### Dead Links

| File | Line | Issue | Details |
| ---- | ---- | ----- | ------- |

{table from dead_links}

**Note:** Output files using config variables were correctly skipped during existence checks.

### Module Awareness

{module_awareness_issues}

### Summary

- **CRITICAL:** {critical_count} violations (must fix - workflow will break)
- **HIGH:** {high_count} violations (should fix)
- **MEDIUM:** {medium_count} violations (review)

**Status:** {"❌ FAIL - Critical violations detected" or "⚠️ WARNINGS - Review recommended" or "✅ PASS - No violations"}
```

### 3. Handle Critical Violations

**If CRITICAL violations found (content violations OR dead links):**

Halt process once all files have been checked and aggregated - and share the severity of the issue with the user and ask them if they want to stop and you can try to fix these now, or else go to the next item in this list. If not proceeding - its still critical all findings thus far are documented in the report output.

### 4. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report to {validationReportFile} BEFORE loading and executing {nextStepFile}.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Config variables identified from workflow.md FIRST
- Known config variables used as exceptions in later checks
- ALL step files checked for content path violations
- Dead links detected via file existence tests (skipping output files)
- Module awareness issues flagged
- Findings appended to validation report
- CRITICAL violations halt validation
- Clean workflows proceed to step-03

### ❌ SYSTEM FAILURE:

- Not identifying config variables first
- Not skipping output files during existence checks
- Not checking content (only frontmatter)
- Missing dead link detection
- Not detecting module-specific assumptions
- Proceeding despite critical violations
