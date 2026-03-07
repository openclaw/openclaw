---
name: "step-05-workflows"
description: "Create workflow placeholder/spec files"

nextStepFile: "./step-06-docs.md"
workflowSpecTemplate: "../templates/workflow-spec-template.md"
buildTrackingFile: "{bmad_creations_output_folder}/modules/module-build-{module_code}.md"
targetLocation: "{build_tracking_targetLocation}"
---

# Step 5: Workflow Specs

## STEP GOAL:

Create workflow placeholder/spec files based on the brief.

## MANDATORY EXECUTION RULES:

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ Speak in `{communication_language}`

### Role Reinforcement:

- ✅ You are the **Module Builder** — creating workflow specs
- ✅ These are specs, not full workflows (workflow-builder does that)
- ✅ Keep it high-level

---

## MANDATORY SEQUENCE

### 1. Get Workflow List from Brief

Extract from the brief:

- Core workflows
- Feature workflows
- Utility workflows

For each workflow:

- Name
- Purpose/goal
- Primary agent
- Input/output requirements

### 2. For Each Workflow, Create Spec

Load `{workflowSpecTemplate}` and create:

`{targetLocation}/workflows/{workflow_name}/{workflow_name}.spec.md`

With content:

````markdown
# Workflow Specification: {workflow_name}

**Module:** {module_code}
**Status:** Placeholder — To be created via create-workflow workflow
**Created:** {date}

---

## Workflow Overview

**Goal:** {workflow_goal}

**Description:** {workflow_description}

**Workflow Type:** {workflow_type}

---

## Workflow Structure

### Entry Point

```yaml
---
name: { workflow_name }
description: { workflow_description }
web_bundle: true
installed_path: "{project-root}/_bmad/{module_code}/workflows/{workflow_folder_name}"
---
```
````

### Mode

- [ ] Create-only (steps-c/)
- [ ] Tri-modal (steps-c/, steps-e/, steps-v/)

---

## Planned Steps

| Step | Name | Goal |
| ---- | ---- | ---- |

{workflow_steps_table}

---

## Workflow Inputs

### Required Inputs

{required_inputs}

### Optional Inputs

{optional_inputs}

---

## Workflow Outputs

### Output Format

- [ ] Document-producing
- [ ] Non-document

### Output Files

{output_files}

---

## Agent Integration

### Primary Agent

{primary_agent}

### Other Agents

{other_agents}

---

## Implementation Notes

**Use the create-workflow workflow to build this workflow.**

---

_Spec created on {date} via BMAD Module workflow_

```

### 3. Create All Workflow Specs

Iterate through each workflow from the brief and create their spec file.

### 4. Update Build Tracking

Update `{buildTrackingFile}`:
- Add 'step-05-workflows' to stepsCompleted
- List all workflow specs created

### 5. Report Success

"**✓ Workflow specs created:**"

- {count} workflow spec files
- {list workflow names}

"**These are specs/blueprints. Use the create-workflow workflow to build each workflow.**"

### 6. MENU OPTIONS

**Select an Option:** [C] Continue

- IF C: Update tracking, load `{nextStepFile}`
- IF Any other: Help, then redisplay menu

---

## Success Metrics

✅ Workflow spec files created for all workflows
✅ Each spec has goal, steps, inputs/outputs
✅ Agent associations documented
✅ Build tracking updated
```
