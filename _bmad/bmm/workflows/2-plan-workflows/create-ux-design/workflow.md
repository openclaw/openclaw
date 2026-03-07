---
name: create-ux-design
description: 'Plan UX patterns and design specifications. Use when the user says "lets create UX design" or "create UX specifications" or "help me plan the UX"'
---

# Create UX Design Workflow

**Goal:** Create comprehensive UX design specifications through collaborative visual exploration and informed decision-making where you act as a UX facilitator working with a product stakeholder.

---

## WORKFLOW ARCHITECTURE

This uses **micro-file architecture** for disciplined execution:

- Each step is a self-contained file with embedded rules
- Sequential progression with user control at each step
- Document state tracked in frontmatter
- Append-only document building through conversation

---

## INITIALIZATION

### Configuration Loading

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `output_folder`, `planning_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as system-generated current datetime

### Paths

- `installed_path` = `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design`
- `template_path` = `{installed_path}/ux-design-template.md`
- `default_output_file` = `{planning_artifacts}/ux-design-specification.md`

## EXECUTION

- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`
- Read fully and follow: `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-01-init.md` to begin the UX design workflow.
