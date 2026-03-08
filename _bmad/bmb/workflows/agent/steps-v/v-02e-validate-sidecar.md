---
name: "v-02e-validate-sidecar"
description: "Validate sidecar structure and append to report"

nextStepFile: "./v-03-summary.md"
validationReport: "{bmb_creations_output_folder}/validation-report-{agent-name}.md"
agentValidation: ../data/agent-validation.md
criticalActions: ../data/critical-actions.md
agentFile: "{agent-file-path}"
sidecarFolder: "{agent-sidecar-folder}"
---

# Validate Step 2e: Validate Sidecar

## STEP GOAL

Validate the agent's sidecar structure (if hasSidecar: true) against BMAD standards as defined in agentValidation.md. Append findings to validation report and auto-advance.

## MANDATORY EXECUTION RULES

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Read validationReport and agentValidation first
- 🔄 CRITICAL: Load the actual agent file to check for sidecar
- 🚫 NO MENU - append findings and auto-advance
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Validate sidecar against agentValidation.md rules (for agents with sidecar)
- 📊 Append findings to validation report
- 🚫 FORBIDDEN to present menu

## EXECUTION PROTOCOLS

- 🎯 Load agentValidation.md reference
- 🎯 Load the actual agent file for validation
- 📊 Validate sidecar if hasSidecar: true, skip for hasSidecar: false
- 💾 Append findings to validation report
- ➡️ Auto-advance to summary step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load References

Read `{agentValidation}`, `{criticalActions}`, `{validationReport}`, and `{agentFile}`.

### 2. Conditional Validation

**IF hasSidecar = true:**
Perform these checks systematically - validate EVERY rule specified in agentValidation.md:

#### A. Sidecar Folder Validation

- [ ] Sidecar folder exists at specified path
- [ ] Sidecar folder is accessible and readable
- [ ] Sidecar folder path in metadata matches actual location
- [ ] Folder naming follows convention: `{agent-name}-sidecar`

#### B. Sidecar File Inventory

- [ ] List all files in sidecar folder
- [ ] Verify expected files are present (memories.md, instructions.md recommended)
- [ ] Check for unexpected files
- [ ] Validate file names follow conventions

#### C. Path Reference Validation

For each sidecar path reference in agent YAML:

- [ ] Extract path from YAML reference
- [ ] Verify path format is correct: `{project-root}/_bmad/_memory/{sidecar-folder}/...`
- [ ] `{project-root}` is literal
- [ ] `{sidecar-folder}` is actual folder name
- [ ] Validate no broken path references

#### D. Critical Actions Validation (MANDATORY for hasSidecar: true)

- [ ] critical_actions section exists in agent YAML
- [ ] Contains at minimum 3 actions
- [ ] Loads sidecar memories: `{project-root}/_bmad/_memory/{sidecar-folder}/memories.md`
- [ ] Loads sidecar instructions: `{project-root}/_bmad/_memory/{sidecar-folder}/instructions.md`
- [ ] Restricts file access: `ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/`
- [ ] No placeholder text in critical_actions
- [ ] No compiler-injected steps

#### E. Sidecar Structure Completeness

- [ ] All referenced sidecar files present
- [ ] No orphaned references (files referenced but not present)
- [ ] No unreferenced files (files present but not referenced)
- [ ] File structure matches agent requirements

**IF hasSidecar = false:**

- [ ] Mark sidecar validation as N/A
- [ ] Confirm no sidecar-folder path in metadata
- [ ] Confirm no sidecar references in critical_actions (if present)
- [ ] Confirm no sidecar references in menu handlers

### 3. Append Findings to Report

Append to `{validationReport}`:

```markdown
### Sidecar Validation

**Status:** {✅ PASS / ⚠️ WARNING / ❌ FAIL / N/A}

**hasSidecar:** {true|false}

**Checks:**

- [ ] metadata.sidecar-folder present (if hasSidecar: true)
- [ ] Sidecar path format correct: `{project-root}/_bmad/_memory/{sidecar-folder}/...`
- [ ] Sidecar files exist at specified path (if hasSidecar: true)
- [ ] All referenced files present
- [ ] No broken path references

**Detailed Findings:**

_PASSING (for agents WITH sidecar):_
{List of passing checks}

_WARNINGS:_
{List of non-blocking issues}

_FAILURES:_
{List of blocking issues that must be fixed}

_N/A (for agents WITHOUT sidecar):_
N/A - Agent has hasSidecar: false, no sidecar required
```

### 4. Auto-Advance

Load and execute `{nextStepFile}` immediately.

---

**Compiling validation summary...**
