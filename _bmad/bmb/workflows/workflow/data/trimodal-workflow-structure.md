# Tri-Modal Workflow Structure

## Golden Rule

**For complex critical workflows: Implement tri-modal structure (create/validate/edit) with cross-mode integration.**

**Cross-mode integration patterns:**

- Create → Validation (handoff after build)
- Edit → Validation (verify changes)
- Edit → Create/conversion (for non-compliant input)
- Validation → Edit (fix issues found)
- All modes run standalone via workflow.md routing

## Directory Structure

```
workflow-name/
├── workflow.md                    # Entry point with mode routing
├── data/                          # SHARED standards and reference
│   ├── [domain]-standards.md
│   └── [domain]-patterns.md
├── steps-c/                       # Create (self-contained)
│   ├── step-00-conversion.md     # Entry for non-compliant input
│   ├── step-01-init.md
│   └── step-N-complete.md
├── steps-e/                       # Edit (self-contained)
│   ├── step-01-assess.md          # Checks compliance, routes if needed
│   └── step-N-complete.md
└── steps-v/                       # Validate (self-contained, runs standalone)
    └── step-01-validate.md
```

## Mode Responsibilities

### Create Mode (steps-c/)

- **Primary:** Build new entities from scratch
- **Secondary:** Convert non-compliant input via step-00-conversion

**Key patterns:**

- step-00-conversion: Loads non-compliant input, extracts essence, creates plan with `conversionFrom` metadata
- Final step routes to validation (optional but recommended)
- Confirmation step checks `conversionFrom` to verify coverage vs new workflow

### Edit Mode (steps-e/)

- **Primary:** Modify existing compliant entities
- **Secondary:** Detect non-compliance and route to conversion

**Key patterns:**

- step-01-assess: Checks compliance first
- Non-compliant → Offer route to step-00-conversion (not step-01-discovery)
- Post-edit → Offer validation (reuse validation workflow)
- During edits → Check standards, offer to fix non-compliance

### Validate Mode (steps-v/)

- **Primary:** Standalone validation against standards
- **Secondary:** Generates actionable reports

**Key patterns:**

- Runs standalone (invoked via -v flag or direct call)
- Auto-proceeds through all checks
- Generates report with issue severity
- Report consumed by edit mode for fixes

## workflow.md Routing Pattern

```yaml
## INITIALIZATION SEQUENCE

### 1. Mode Determination

**Check invocation:**
- "create" / -c → mode = create
- "validate" / -v → mode = validate
- "edit" / -e → mode = edit

**If create mode:** Ask "From scratch or convert existing?"
- From scratch → steps-c/step-01-init.md
- Convert → steps-c/step-00-conversion.md

**If unclear:** Ask user to select mode

### 2. Route to First Step

**IF mode == create:**
Route to appropriate create entry (init or conversion)

**IF mode == validate:**
Prompt for path → load steps-v/step-01-validate.md

**IF mode == edit:**
Prompt for path → load steps-e/step-01-assess.md
```

**Critical:** workflow.md is lean. No step listings. Only routing logic.

## Cross-Mode Integration Points

### 1. Edit → Create (Non-Compliant Detection)

```yaml
Check workflow compliance:
  - Compliant → Continue to edit steps
  - Non-compliant → Offer conversion
    - IF user accepts: Load steps-c/step-00-conversion.md with sourceWorkflowPath
```

### 2. Create/Edit → Validation

```yaml
# In create final step or edit post-edit step
Offer: "Run validation?"
  - IF yes: Load ../steps-v/step-01-validate.md
  - Validation runs standalone, returns report
  - Resume create/edit with validation results
```

### 3. Validation → Edit

```yaml
# User can invoke edit mode with report as input
"Fix issues found?"
  - IF yes: Load steps-e/step-01-assess.md with validationReport path
```

### 4. Conversion Coverage Tracking

```yaml
# In create step-10-confirmation
Check workflowPlan metadata:
  - IF conversionFrom exists:
      - Load original workflow
      - Compare each step/instruction
      - Report coverage percentage
  - ELSE (new workflow):
      - Validate all plan requirements implemented
```

## When to Use Tri-Modal

**Use Tri-Modal for:**

- Complex workflows requiring quality assurance
- Workflows that will be maintained over time
- Workflows where non-compliant input may be offered
- Critical workflows where standards compliance matters

**Use Create-Only for:**

- Simple one-off workflows
- Experimental workflows
- Workflows unlikely to need editing or validation

## Frontmatter Standards for Cross-Mode References

Never inline file paths. Always use frontmatter variables:

```yaml
---
# Create mode step calling validation
validationWorkflow: "../steps-v/step-01-validate.md"
---
# Edit mode step routing to conversion
conversionStep: "../steps-c/step-00-conversion.md"
---
# Create conversion step receiving from edit
sourceWorkflowPath: "{targetWorkflowPath}" # Passed from edit
---
```
