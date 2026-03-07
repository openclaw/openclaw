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

Inputs needed:

- Workflow name and description
- Step structure and sequence
- Input/output specifications
- Agent associations

---

_Spec created on {date} via BMAD Module workflow_
