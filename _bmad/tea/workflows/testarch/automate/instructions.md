<!-- Powered by BMAD-CORE™ -->

# Test Automation Expansion

**Workflow ID**: `_bmad/tea/testarch/automate`
**Version**: 5.0 (Step-File Architecture)

---

## Overview

Expands test automation coverage by generating prioritized tests at the appropriate level (E2E, API, Component, Unit) with supporting fixtures and helpers.

Modes:

- **BMad-Integrated**: Uses story/PRD/test-design artifacts when available
- **Standalone**: Analyzes existing codebase without BMad artifacts

---

## WORKFLOW ARCHITECTURE

This workflow uses **step-file architecture** for disciplined execution:

- **Micro-file Design**: Each step is self-contained
- **JIT Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Execute steps in order without skipping

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

From `workflow.yaml`, resolve:

- `config_source`, `test_artifacts`, `user_name`, `communication_language`, `document_output_language`, `date`
- `test_dir`, `source_dir`, `coverage_target`, `standalone_mode`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/automate/steps-c/step-01-preflight-and-context.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/automate/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.
