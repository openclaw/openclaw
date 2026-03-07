# Test Quality Review

**Workflow:** `testarch-test-review`
**Version:** 5.0 (Step-File Architecture)

---

## Overview

Review test quality using TEA knowledge base and produce a 0–100 quality score with actionable findings.

Coverage assessment is intentionally out of scope for this workflow. Use `trace` for requirements coverage and coverage gate decisions.

---

## WORKFLOW ARCHITECTURE

This workflow uses **step-file architecture**:

- **Micro-file Design**: Each step is self-contained
- **JIT Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Execute steps in order

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

From `workflow.yaml`, resolve:

- `config_source`, `test_artifacts`, `user_name`, `communication_language`, `document_output_language`, `date`
- `test_dir`, `review_scope`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/test-review/steps-c/step-01-load-context.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/test-review/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.
