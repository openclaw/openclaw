<!-- Powered by BMAD-CORE™ -->

# CI/CD Pipeline Setup

**Workflow ID**: `_bmad/tea/testarch/ci`
**Version**: 5.0 (Step-File Architecture)

---

## Overview

Scaffold a production-ready CI/CD quality pipeline with test execution, burn-in loops for flaky detection, parallel sharding, artifact collection, and notifications.

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
- `ci_platform`, `test_dir`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/ci/steps-c/step-01-preflight.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/ci/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.
