# Input Document Discovery Standards

**Purpose:** Workflow input discovery, validation, and selection from prior workflows or external sources.

---

## Discovery Patterns

1. **Prior Workflow Output** - Sequential workflows (e.g., PRD → Architecture → Epics)
2. **Module Folder Search** - Known project locations
3. **User-Specified Paths** - User-provided document locations
4. **Pattern-Based Discovery** - File naming pattern matching (e.g., `*-brief.md`)

---

## Discovery Step Pattern

**When:** Step 1 (init) or Step 2 (discovery)

**Frontmatter:**

```yaml
---
# Input discovery variables
inputDocuments: [] # Discovered docs
requiredInputCount: 1 # Minimum required
optionalInputCount: 0 # Additional optional docs
moduleInputFolder: "{planning_artifacts}"
inputFilePatterns:
  - "*-prd.md"
  - "*-ux.md"
---
```

**Discovery Logic:**

```markdown
## 1. Check Known Prior Workflow Outputs

Search order:

1. {module_output_folder}/[known-prior-workflow-output].md
2. {project_folder}/[standard-locations]/
3. {planning_artifacts}/
4. User-provided paths

## 2. Pattern-Based Search

If no known prior workflow: match {inputFilePatterns} in {moduleInputFolder} and {project_folder}/docs/

## 3. Present Findings

"Found these documents:

- [1] prd-my-project.md (3 days ago)
- [2] ux-research.md (1 week ago)

Select multiple or provide additional paths."

## 4. Confirm and Load

Add selections to {inputDocuments} array in output frontmatter
```

---

## Required vs Optional Inputs

**Required:** Workflow cannot proceed without these.

```markdown
## INPUT REQUIREMENT:

Requires PRD to proceed.

Searching: {bmm_creations_output_folder}/prd-_.md, {planning_artifacts}/_-prd.md

[Found:] "Found PRD: prd-my-project.md. Use this?"
[Missing:] "No PRD found. Run PRD workflow first or provide path."
```

**Optional:** Workflow can proceed without these.

```markdown
## OPTIONAL INPUTS:

Can incorporate research if available.

Searching: {bmm_creations_output_folder}/research-\*.md, {project_folder}/research/

[Found:] "Found research documents. Include any? (None required)"
```

---

## Module Workflow Chaining

**Frontmatter in workflow.md:**

```yaml
---
## INPUT FROM PRIOR WORKFLOWS

### Required Inputs:
- {module_output_folder}/prd-{project_name}.md

### Optional Inputs:
- {module_output_folder}/ux-research-{project_name}.md
---
```

**Step 1 discovery:**

```markdown
## 1. Discover Prior Workflow Outputs

Check required: {module_output_folder}/prd-{project_name}.md

- Missing → Error: "Run PRD workflow first"
- Found → Confirm with user

Check optional: Search for patterns, present findings, add selections to {inputDocuments}
```

---

## Input Validation

```markdown
## INPUT VALIDATION:

For each discovered document:

1. Load frontmatter
2. Check workflowType matches expected
3. Check stepsCompleted == complete
4. Check date (warn if old)

[Fail:] "Document appears incomplete. Last step: step-06 (of 11). Proceed anyway?"
```

---

## Multiple Input Selection

```markdown
## Document Selection

"Found relevant documents:
[1] prd-my-project.md (3 days ago) ✓ Recommended
[2] prd-v1.md (2 months ago) ⚠ Older

Enter numbers (comma-separated): > 1, 3"
```

**Track in frontmatter:**

```yaml
---
inputDocuments:
  - path: "{output_folder}/prd-my-project.md"
    type: "prd"
    source: "prior-workflow"
    selected: true
---
```

---

## Search Path Variables

| Variable                 | Purpose                    |
| ------------------------ | -------------------------- |
| `{module_output_folder}` | Prior workflow outputs     |
| `{planning_artifacts}`   | General planning docs      |
| `{project_folder}/docs`  | Project documentation      |
| `{product_knowledge}`    | Product-specific knowledge |
| `{user_documents}`       | User-provided location     |

---

## Discovery Step Template

```markdown
---
name: "step-01-init"
description: "Initialize and discover input documents"

# Input Discovery
inputDocuments: []
requiredInputCount: 1
moduleInputFolder: "{module_output_folder}"
inputFilePatterns:
  - "*-prd.md"
---
```

---

## Validation Checklist

- [ ] Required inputs defined in step frontmatter
- [ ] Search paths defined (module variables or patterns)
- [ ] User confirmation before using documents
- [ ] Validation of document completeness
- [ ] Clear error messages when required inputs missing
- [ ] Support for multiple document selection
- [ ] Optional inputs clearly marked
