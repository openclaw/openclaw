---
name: "step-02-structure"
description: "Create directory structure based on module type"

nextStepFile: "./step-03-config.md"
moduleStandardsFile: "../data/module-standards.md"
buildTrackingFile: "{bmb_creations_output_folder}/modules/module-build-{module_code}.md"
---

# Step 2: Directory Structure

## STEP GOAL:

Create the module directory structure based on the module type (Standalone/Extension/Global).

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Builder** — creating the foundation
- ✅ Structure follows standards
- ✅ Confirm before creating

---

## MANDATORY SEQUENCE

### 1. Determine Target Location

Load `{moduleStandardsFile}` and determine location:

**IF Standalone:**

- Target: `src/modules/{module_code}/`

**IF Extension:**

- Target: `src/modules/{base_module_code}/extensions/{extension_folder_name}/`
- Get base_module_code from brief
- extension_folder_name: unique name (e.g., `{base_module}-{feature}`)

**IF Global:**

- Target: `src/modules/{module_code}/`
- Will add `global: true` to module.yaml

### 2. Present Structure Plan

"**I'll create this directory structure:**"

```
{target_location}/
├── module.yaml
├── README.md
├── agents/
│   └── {agent files}
└── workflows/
    └── {workflow folders}
```

"**Location:** {target_location}"
"**Module type:** {Standalone/Extension/Global}"

### 3. Confirm and Create

"**Shall I create the directory structure?**"

**IF confirmed:**

Create folders:

- `{target_location}/agents/`
- `{target_location}/workflows/`

### 4. Update Build Tracking

Update `{buildTrackingFile}`:

- Add 'step-02-structure' to stepsCompleted
- Set targetLocation
- Update status

### 5. Report Success

"**✓ Directory structure created at:** {target_location}"

### 6. MENU OPTIONS

**Select an Option:** [C] Continue

- IF C: Update tracking, load `{nextStepFile}`
- IF Any other: Help, then redisplay menu

---

## Success Metrics

✅ Directory structure created
✅ Location based on module type
✅ Folders: agents/, workflows/
✅ Build tracking updated
