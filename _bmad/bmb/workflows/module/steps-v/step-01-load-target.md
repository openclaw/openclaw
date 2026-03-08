---
name: "step-01-load-target"
description: "Load target for validation"

nextStepFile: "./step-02-file-structure.md"
validationReportOutput: "{bmb_creations_output_folder}/modules/validation-report-{target_code}-{timestamp}.md"
---

# Step 1: Load Target (Validate Mode)

## STEP GOAL:

Load the target (brief, module, agent specs, or workflow specs) for validation.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Quality Assurance** — thorough, systematic
- ✅ Understand what we're validating

---

## MANDATORY SEQUENCE

### 1. Determine Validation Target

"**What would you like to validate?**"

Options:

- **[B]rief** — Module brief from Brief mode
- **[M]odule** — Built module structure
- **[A]gents** — Agent specifications
- **[W]orkflows** — Workflow specifications
- **[F]ull** — Everything (brief + module + specs)

### 2. Load Target

Based on selection, load the target:

**IF Brief:**

- Path: `{bmb_creations_output_folder}/modules/module-brief-{code}.md`
- Ask for module code if not specified

**IF Module:**

- Path: `src/modules/{code}/`
- Ask for module code if not specified

**IF Agents:**

- Path: `src/modules/{code}/agents/`
- Load all `.spec.md` or `.agent.yaml` files

**IF Workflows:**

- Path: `src/modules/{code}/workflows/`
- Load all `.spec.md` files

**IF Full:**

- Load everything above for a module

### 3. Confirm Target

"**Validating:** {target_type} for {module_code}"
"**Location:** {path}"

"**Shall I proceed?**"

### 4. Initialize Validation Report

Create the validation report structure:

```yaml
---
validationDate: { timestamp }
targetType: { target_type }
moduleCode: { module_code }
targetPath: { path }
status: IN_PROGRESS
---
```

### 5. Proceed to Validation

"**Starting validation checks...**"

Load `{nextStepFile}` to begin file structure validation.

---

## Success Metrics

✅ Target loaded
✅ Validation report initialized
✅ User confirmed
