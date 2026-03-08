---
name: "step-07-complete"
description: "Finalize, offer to run validation"

buildTrackingFile: "{bmb_creations_output_folder}/modules/module-build-{module_code}.md"
targetLocation: "{build_tracking_targetLocation}"
moduleHelpGenerateWorkflow: "../module-help-generate.md"
validationWorkflow: "../steps-v/step-01-validate.md"
moduleHelpCsvFile: "{build_tracking_targetLocation}/module-help.csv"
---

# Step 7: Complete

## STEP GOAL:

Finalize the module build, update tracking, and offer to run validation.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Builder** — completing the build
- ✅ Celebrate what was created
- ✅ Guide next steps

---

## MANDATORY SEQUENCE

### 1. Generate module-help.csv

"**🎯 Generating module-help.csv...**"

Load and execute the module-help-generate workflow:

```
{moduleHelpGenerateWorkflow}
```

**Set these variables before loading:**

- `modulePath: {targetLocation}`
- `moduleYamlFile: {targetLocation}/module.yaml`
- `moduleHelpCsvFile: {targetLocation}/module-help.csv`
- `workflowsDir: {targetLocation}/workflows`
- `agentsDir: {targetLocation}/agents`

**What this does:**

- Scans all workflows in `{workflowsDir}/`
- Scans all agents in `{agentsDir}/`
- Generates `{moduleHelpCsvFile}` with proper structure:
  - `anytime` entries at top (no sequence)
  - Phased entries below (phase-1, phase-2, etc.)
  - Agent-only entries have empty `workflow-file`

**Wait for workflow completion** before proceeding.

### 2. Final Build Summary

"**🎉 Module structure build complete!**"

**Module:** {moduleName} ({moduleCode})
**Type:** {moduleType}
**Location:** {targetLocation}

**What was created:**

| Component      | Count   | Location           |
| -------------- | ------- | ------------------ |
| Agent specs    | {count} | agents/            |
| Workflow specs | {count} | workflows/         |
| Configuration  | 1       | module.yaml        |
| Help Registry  | 1       | module-help.csv    |
| Documentation  | 2       | README.md, TODO.md |

### 3. Update Build Tracking

Update `{buildTrackingFile}`:

```yaml
---
moduleCode: { module_code }
moduleName: { name }
moduleType: { type }
targetLocation: { location }
stepsCompleted:
  [
    "step-01-load-brief",
    "step-02-structure",
    "step-03-config",
    "step-04-agents",
    "step-05-workflows",
    "step-06-docs",
    "step-07-complete",
  ]
created: { created_date }
completed: { date }
status: COMPLETE
---
```

### 3. Next Steps

"**Your module structure is ready! Here's what to do next:**"

1. **Review the build** — Check {targetLocation}
2. **Build agents** — Use `bmad:bmb:agents:agent-builder` for each agent spec
3. **Build workflows** — Use `bmad:bmb:workflows:workflow` for each workflow spec
4. **Test installation** — Run `bmad install {module_code}`
5. **Iterate** — Refine based on testing

### 4. Offer Validation

"**Would you like to run validation on the module structure?**"

Validation checks:

- File structure compliance
- module.yaml correctness
- Spec completeness
- Installation readiness

### 5. MENU OPTIONS

**Select an Option:** [V] Validate Module [D] Done

#### EXECUTION RULES:

- ALWAYS halt and wait for user input

#### Menu Handling Logic:

- IF V: Load `{validationWorkflow}` to run validation
- IF D: Celebration message, workflow complete
- IF Any other: Help user, then redisplay menu

### 6. Completion Message (if Done selected)

"**🚀 You've built a module structure for BMAD!**"

"**Module:** {moduleName} ({moduleCode})"
"**Location:** {targetLocation}"
"**Status:** Ready for agent and workflow implementation"

"**The journey from idea to installable module continues:**

- Agent specs → create-agent workflow
- Workflow specs → create-workflow workflow
- Full module → `bmad install`

"**Great work! Let's build something amazing.** ✨"

---

## Success Metrics

✅ module-help.csv generated at module root
✅ Build tracking marked COMPLETE
✅ Summary presented to user
✅ Next steps clearly explained
✅ Validation offered (optional)
