# Requirements Traceability & Quality Gate

**Workflow:** `testarch-trace`
**Version:** 5.0 (Step-File Architecture)

---

## Overview

Create a requirements-to-tests traceability matrix, analyze coverage gaps, and optionally make a gate decision (PASS/CONCERNS/FAIL/WAIVED) based on evidence.

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
- `test_dir`, `source_dir`, `coverage_levels`, `gate_type`, `decision_mode`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/trace/steps-c/step-01-load-context.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/trace/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.
