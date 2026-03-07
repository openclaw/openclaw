---
name: "step-02-file-structure"
description: "Validate file structure compliance"

nextStepFile: "./step-03-module-yaml.md"
moduleStandardsFile: "../data/module-standards.md"
validationReportOutput: "{validation_report_output}"
---

# Step 2: File Structure Validation

## STEP GOAL:

Validate file structure against module standards.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — checking structure
- ✅ Reference standards, ensure compliance

---

## MANDATORY SEQUENCE

### 1. Load Standards

Load `{moduleStandardsFile}` for reference.

### 2. Perform Structure Checks

Check based on target type:

**For Modules:**

- [ ] module.yaml exists
- [ ] README.md exists
- [ ] agents/ folder exists (if agents specified)
- [ ] workflows/ folder exists (if workflows specified)

**For Briefs:**

- [ ] Brief file exists
- [ ] Required sections present

**For Agent Specs:**

- [ ] All expected spec files exist

**For Workflow Specs:**

- [ ] All expected spec files exist

### 3. Check Module Type Compliance

**IF Extension Module:**

- [ ] Code matches base module
- [ ] Folder name is unique (not conflicting)

**IF Global Module:**

- [ ] Global flag documented

### 4. Record Results

Append to `{validationReportOutput}`:

```markdown
## File Structure Validation

**Status:** {PASS/FAIL/WARNINGS}

**Checks:**
{list each check with result}

**Issues Found:**
{any structural problems}
```

### 5. Auto-Proceed

"**✓ File structure check complete.**"

Proceeding to next validation...

Load `{nextStepFile}`

---

## Success Metrics

✅ All structure checks performed
✅ Results recorded
✅ Auto-proceeds to next validation
