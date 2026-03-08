<!-- Powered by BMAD-CORE™ -->

# Test Framework Setup

**Workflow ID**: `_bmad/tea/testarch/framework`
**Version**: 5.0 (Step-File Architecture)

---

## Overview

Initialize a production-ready test framework (Playwright or Cypress) with fixtures, helpers, configuration, and best practices.

---

## WORKFLOW ARCHITECTURE

This workflow uses **step-file architecture**:

- **Micro-file Design**: Each step is self-contained
- **JIT Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Execute steps in order without skipping

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

From `workflow.yaml`, resolve:

- `config_source`, `test_artifacts`, `user_name`, `communication_language`, `document_output_language`, `date`
- `test_dir`, `use_typescript`, `framework_preference`, `project_size`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/framework/steps-c/step-01-preflight.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/framework/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.
