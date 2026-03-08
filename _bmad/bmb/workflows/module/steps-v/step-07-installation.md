---
name: "step-07-installation"
description: "Installation readiness check"

nextStepFile: "./step-08-report.md"
moduleHelpGenerateWorkflow: "../module-help-generate.md"
validationReportOutput: "{validation_report_output}"
targetPath: "{validation_target_path}"
moduleHelpCsvFile: "{validation_target_path}/module-help.csv"
---

# Step 7: Installation Readiness

## STEP GOAL:

Check if the module is ready for installation.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — checking readiness
- ✅ Installation should work

---

## MANDATORY SEQUENCE

### 1. Check module.yaml Install Variables

**IF custom variables exist:**

- [ ] All variables have prompts
- [ ] Defaults are reasonable
- [ ] Result templates are valid

**Path Variables:**

- [ ] Paths use `{project-root}/` prefix
- [ ] Output paths are user-configurable

### 2. Check module-help.csv

**CRITICAL:** Every module must have `module-help.csv` at its root.

**Check:**

- [ ] `module-help.csv` exists at `{moduleHelpCsvFile}`
- [ ] Has valid header: `module,phase,name,code,sequence,workflow-file,command,required,agent,options,description,output-location,outputs,`
- [ ] `anytime` entries at TOP with EMPTY sequence
- [ ] Phased entries BELOW anytime (phase-1, phase-2, etc.)
- [ ] Agent-only entries have EMPTY `workflow-file`

**If missing:**

- FAIL - Module is not ready for installation without help registry
- Suggest running `{moduleHelpGenerateWorkflow}`

### 3. Module Type Installation

**IF Extension:**

- [ ] `code:` matches base (for proper merge)
- [ ] Folder name is unique

**IF Global:**

- [ ] `global: true` or documented
- [ ] Global impact is minimal/intentional

### 4. Record Results

Append to `{validationReportOutput}`:

```markdown
## Installation Readiness

**Status:** {PASS/FAIL/WARNINGS}

**Install Variables:** {count} variables
**Install Variables:** {count} variables
**Help Registry:** {present/missing} - {status}
**Ready to Install:** {yes/no}

**Issues Found:**
{list any issues}
```

### 5. Auto-Proceed

"**✓ Installation readiness check complete.**"

Proceeding to final report...

Load `{nextStepFile}`

---

## Success Metrics

✅ Installation readiness assessed
✅ module-help.csv presence and structure validated
✅ Module type compatibility checked
✅ Results recorded
