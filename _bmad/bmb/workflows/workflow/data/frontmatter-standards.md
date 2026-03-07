# Frontmatter Standards

**Purpose:** Variables, paths, and frontmatter rules for workflow steps.

---

## Golden Rules

1. **Only variables USED in the step** may be in frontmatter
2. **All file references MUST use `{variable}` format** - no hardcoded paths
3. **Paths within workflow folder MUST be relative** - NO `workflow_path` variable allowed

---

## Standard Variables

| Variable                     | Example                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| `{project-root}`             | `/Users/user/dev/BMAD-METHOD` <!-- validate-file-refs:ignore -->        |
| `{project_name}`             | `my-project`                                                            |
| `{output_folder}`            | `/Users/user/dev/BMAD-METHOD/output` <!-- validate-file-refs:ignore --> |
| `{user_name}`                | `Brian`                                                                 |
| `{communication_language}`   | `english`                                                               |
| `{document_output_language}` | `english`                                                               |

---

## Module-Specific Variables

Workflows in a MODULE can access additional variables from its `module.yaml`.

**Example:**

```yaml
bmb_creations_output_folder: "{project-root}/_bmad/bmb-creations"
```

**Standalone workflows:** Only have access to standard variables.

---

## Frontmatter Structure

### Required Fields

```yaml
---
name: "step-[N]-[name]"
description: "[what this step does]"
---
```

### File References - ONLY variables used in this step

```yaml
---
# Step to step (SAME folder) - use ./filename.md
nextStepFile: "./step-02-vision.md"

# Step to template (PARENT folder) - use ../filename.md
productBriefTemplate: "../product-brief.template.md"

# Step to data (SUBFOLDER) - use ./data/filename.md
someData: "./data/config.csv"

# Output files - use variable
outputFile: "{planning_artifacts}/product-brief-{{project_name}}-{{date}}.md"

# External references - use {project-root}
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
---
```

---

## Critical Rule: Unused Variables Forbidden

**Detection Rule:** For EVERY variable in frontmatter, search the step body for `{variableName}`. If not found, it's a violation.

### ❌ VIOLATION

```yaml
---
outputFile: "{output_folder}/output.md"
thisStepFile: "./step-01-init.md" # ❌ NEVER USED
workflowFile: "./workflow.md" # ❌ NEVER USED
---
```

### ✅ CORRECT

```yaml
---
outputFile: "{output_folder}/output.md"
nextStepFile: "./step-02-foo.md"
---
```

---

## Path Rules

| Type                       | Format                  | Example                                   |
| -------------------------- | ----------------------- | ----------------------------------------- |
| Step to Step (same folder) | `./filename.md`         | `./step-02-vision.md`                     |
| Step to Template (parent)  | `../filename.md`        | `../template.md`                          |
| Step to Subfolder          | `./subfolder/file.md`   | `./data/config.csv`                       |
| External References        | `{project-root}/...`    | `{project-root}/_bmad/core/workflows/...` |
| Output Files               | `{folder_variable}/...` | `{planning_artifacts}/output.md`          |

---

## ❌ FORBIDDEN Patterns

| Pattern                               | Why                                                         |
| ------------------------------------- | ----------------------------------------------------------- |
| `workflow_path: '{project-root}/...'` | Use relative paths                                          |
| `thisStepFile: './step-XX.md'`        | Remove unless referenced <!-- validate-file-refs:ignore --> |
| `workflowFile: './workflow.md'`       | Remove unless referenced <!-- validate-file-refs:ignore --> |
| `{workflow_path}/templates/...`       | Use `../template.md`                                        |
| `{workflow_path}/data/...`            | Use `./data/file.md`                                        |

---

## Variable Naming

Use `snake_case` with descriptive prefixes:

| Suffix       | Usage               | Example                      |
| ------------ | ------------------- | ---------------------------- |
| `*_File`     | File references     | `outputFile`, `nextStepFile` |
| `*_Task`     | Task references     | `advancedElicitationTask`    |
| `*_Workflow` | Workflow references | `partyModeWorkflow`          |
| `*_Template` | Templates           | `productBriefTemplate`       |
| `*_Data`     | Data files          | `dietaryData`                |

---

## Defining New Variables

Steps can define NEW variables for future steps.

**Step 01 defines:**

```yaml
---
targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{workflow_name}"
---
```

**Step 02 uses:**

```yaml
---
targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{workflow_name}"
workflowPlanFile: "{targetWorkflowPath}/plan.md"
---
```

---

## Continuable Workflow Frontmatter

```yaml
---
stepsCompleted: ["step-01-init", "step-02-gather", "step-03-design"]
lastStep: "step-03-design"
lastContinued: "2025-01-02"
date: "2025-01-01"
---
```

**Step tracking:** Each step appends its NAME to `stepsCompleted`.

---

## Validation Checklist

For EVERY step frontmatter, verify:

- [ ] `name` present, kebab-case format
- [ ] `description` present
- [ ] Extract ALL variable names from frontmatter
- [ ] For EACH variable, search body: is `{variableName}` present?
- [ ] If variable NOT in body → ❌ VIOLATION, remove from frontmatter
- [ ] All step-to-step paths use `./filename.md` format
- [ ] All parent-folder paths use `../filename.md` format
- [ ] All subfolder paths use `./subfolder/filename.md` format
- [ ] NO `{workflow_path}` variable exists
- [ ] External paths use `{project-root}` variable
- [ ] Module variables only used if workflow belongs to that module
