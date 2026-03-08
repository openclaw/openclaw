# Workflow Chaining Standards

## Module Workflow Pipeline

**Example:** BMM Module - Idea to Implementation

```
brainstorming → research → brief → PRD → UX → architecture → epics → sprint-planning
                                                        ↓
                                            implement-story → review → repeat
```

Each workflow:

1. Checks for required inputs from prior workflows
2. Validates inputs are complete
3. Produces output for next workflow
4. Recommends next workflow in sequence

## Input/Output Contract

### Output Contract

**Every workflow should:**

1. Create output document with predictable filename
2. Include `workflowType` in frontmatter for identification
3. Mark `stepsCompleted: [all steps]` when complete
4. Store in known location (`{module_output_folder}`)

**Example frontmatter:**

```yaml
---
workflowType: "prd"
stepsCompleted: ["step-01-init", ..., "step-11-complete"]
project_name: "my-project"
date: "2025-01-02"
nextWorkflow: "create-ux"
previousWorkflow: "create-brief"
---
```

### Input Contract

**Every workflow should:**

1. Define required inputs in Step 1
2. Search in `{module_output_folder}` for prior outputs
3. Validate inputs are complete
4. Allow user to select from discovered documents

## Step 1: Input Discovery Pattern

```markdown
## 1. Discover Required Inputs

### Required Inputs:

- {module_output_folder}/prd-{project_name}.md

### Search:

1. Look for prd-{project_name}.md in {module_output_folder}
2. If found → validate completeness
3. If missing or incomplete → error with guidance

"Error: This workflow requires a completed PRD.
Expected location: {module_output_folder}/prd-{project_name}.md
To fix: Run the PRD workflow first, or provide the path to your PRD."
```

## Final Step: Next Workflow Recommendation

```markdown
## Next Steps

Based on your completed [workflow], recommended next workflows:

1. **[next-workflow-name]** - [why it's next]
2. **[alternative-workflow]** - [when to use this instead]

Would you like to:

- Run [next-workflow-name] now?
- Run a different workflow?
- Exit for now?
```

**Update output frontmatter:**

```yaml
nextWorkflow: "create-ux"
nextWorkflowRecommended: true
```

## Cross-Workflow Status Tracking

**Optional:** Module can maintain `workflow-status.yaml`:

```yaml
---
current_workflow: "create-prd"
completed_workflows:
  - brainstorming
  - research
  - brief
pending_workflows:
  - create-ux
  - create-architecture
  - create-epics
  - sprint-planning
outputs:
  brief: "{module_output_folder}/brief-{project_name}.md"
  prd: "{module_output_folder}/prd-{project_name}.md"
---
```

**Workflow checks this file to:**

- Validate sequence (don't run UX before PRD)
- Find output locations
- Track overall progress

## Branching Workflows

```markdown
## Next Steps

Based on your project type:

**For software projects:**

- create-architecture - Technical architecture
- create-epics - Break down into epics

**For data projects:**

- data-modeling - Database schema design
- etl-pipeline - Data pipeline design

Which workflow would you like to run next?
```

## Required vs Optional Sequences

### Required Sequence

**PRD must come before Architecture:**

```yaml
# In architecture workflow.md
## PREREQUISITE:
This workflow requires a completed PRD.

## INITIALIZATION:
IF prd-{project_name}.md exists AND is complete:
  → Proceed with architecture workflow
ELSE:
  → Error: "Please complete PRD workflow first"
```

### Optional Sequence

**UX research helps Architecture but isn't required:**

```yaml
# In architecture workflow.md
## OPTIONAL INPUTS:
UX research documents can inform technical decisions.

IF ux-research-{project_name}.md exists:
  → "Found UX research. Include findings in architecture design?"
ELSE:
  → "No UX research found. Continuing without it."
```

## Filename Conventions for Chaining

**Standard pattern:** `{workflow-name}-{project-name}.md`

| Workflow      | Output Filename Pattern           |
| ------------- | --------------------------------- |
| brainstorming | `brainstorming-{project_name}.md` |
| brief         | `brief-{project_name}.md`         |
| PRD           | `prd-{project_name}.md`           |
| UX            | `ux-design-{project_name}.md`     |
| architecture  | `architecture-{project_name}.md`  |
| epics         | `epics-{project_name}.md`         |

## Module-Level Workflow Registry

**Module can define `workflows.yaml`:**

```yaml
---
module: "bmm"
workflows:
  brainstorming:
    output: "brainstorming-{project_name}.md"
    next: ["research"]
  research:
    output: "research-{project_name}.md"
    next: ["brief"]
  brief:
    output: "brief-{project_name}.md"
    next: ["prd"]
  prd:
    output: "prd-{project_name}.md"
    next: ["create-ux", "create-architecture"]
  create-ux:
    output: "ux-design-{project_name}.md"
    next: ["create-architecture"]
  create-architecture:
    output: "architecture-{project_name}.md"
    next: ["create-epics"]
  create-epics:
    output: "epics-{project_name}.md"
    next: ["sprint-planning"]
---
```

## Cross-Module Dependencies

```yaml
# In BMGD narrative workflow
## INPUT REQUIREMENTS:

### Required:
- {bmm_output_folder}/prd-{project_name}.md
- {bmm_output_folder}/architecture-{project_name}.md

### From BMGD:
- {bmgd_output_folder}/gdd-{project_name}.md (Game Design Document)
```
