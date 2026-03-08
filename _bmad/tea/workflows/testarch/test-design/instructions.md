<!-- Powered by BMAD-CORE™ -->

# Test Design and Risk Assessment

**Workflow ID**: `_bmad/tea/testarch/test-design`
**Version**: 5.0 (Step-File Architecture)

---

## Overview

Plans comprehensive test coverage strategy with risk assessment, priority classification, and execution ordering. This workflow operates in **two modes**:

- **System-Level Mode (Phase 3)**: Testability review of architecture before solutioning gate check
- **Epic-Level Mode (Phase 4)**: Per-epic test planning with risk assessment

The workflow auto-detects which mode to use based on project phase and user intent.

---

## WORKFLOW ARCHITECTURE

This workflow uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self-contained instruction file
- **Just-In-Time Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Execute steps in order without skipping
- **State Tracking**: Write outputs only when instructed, then proceed

### Step Processing Rules (Non-Negotiable)

1. **READ COMPLETELY**: Read the entire step file before taking any action
2. **FOLLOW SEQUENCE**: Execute all numbered sections in order
3. **WAIT FOR INPUT**: Halt when user input is required
4. **LOAD NEXT**: Only load the next step file when directed

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

From `workflow.yaml`, resolve:

- `config_source`, `test_artifacts`, `user_name`, `communication_language`, `document_output_language`, `date`

### 2. First Step

Load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/test-design/steps-c/step-01-detect-mode.md`

### 3. Resume Support

If the user selects **Resume** mode, load, read completely, and execute:
`{project-root}/_bmad/tea/workflows/testarch/test-design/steps-c/step-01b-resume.md`

This checks the output document for progress tracking frontmatter and routes to the next incomplete step.

---

## OUTPUT GENERATION GUIDANCE

When populating templates in step 5, apply the following guidance for these sections:

### Not in Scope

- Identify components, third-party services, or subsystems NOT covered by this test plan
- For each excluded item, provide reasoning (why excluded) and mitigation (how risk is addressed elsewhere)
- Common exclusions: external vendor APIs tested by upstream teams, legacy modules outside the current phase scope, infrastructure already covered by platform team monitoring

### Entry and Exit Criteria

- **Entry criteria**: Derive from Dependencies and Test Blockers -- what must be resolved before QA can start testing
- **Exit criteria**: Derive from Quality Gate Criteria -- what constitutes "done" for the testing phase
- Include project-specific criteria based on context (e.g., "feature flag enabled in staging", "seed data loaded", "pre-implementation blockers resolved")

### Project Team (Optional)

- Include only if roles/names are known or responsibility mapping is needed
- Extract names and roles from PRD, ADR, or project context if available
- If names are unknown, either omit or use role placeholders for drafts
- Map testing responsibilities to each role (e.g., who owns E2E tests, who signs off)

### Tooling and Access (System-Level QA Document Only)

- Include only if non-standard tools or access requests are required
- List notable tools/services needed for test execution and any access approvals
- Avoid assuming specific vendors unless the project context names them
- Mark each item's status as Ready or Pending based on available information
- This section applies only to `test-design-qa-template.md` output

### Implementation Planning Handoff (Optional)

- Include only if test design produces implementation tasks that must be scheduled
- Derive items from Dependencies & Test Blockers, tooling/access needs, and QA infra setup
- If no dedicated QA, assign ownership to Dev/Platform as appropriate
- Keep the list short; avoid per-milestone breakdown tables

### Interworking & Regression

- Identify services and components that interact with or are affected by the feature under test
- For each, define what existing regression tests must pass before release
- Note any cross-team coordination needed for regression validation (e.g., shared staging environments, upstream API contracts)
