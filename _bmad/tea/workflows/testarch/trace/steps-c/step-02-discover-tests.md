---
name: "step-02-discover-tests"
description: "Discover and catalog tests by level"
nextStepFile: "./step-03-map-criteria.md"
outputFile: "{test_artifacts}/traceability-report.md"
---

# Step 2: Discover & Catalog Tests

## STEP GOAL

Identify tests relevant to the requirements and classify by test level.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 Record outputs before proceeding
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: config, loaded artifacts, and knowledge fragments
- Focus: this step's goal only
- Limits: do not execute future steps
- Dependencies: prior steps' outputs (if any)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

## 1. Discover Tests

Search `{test_dir}` for:

- Test IDs (e.g., `1.3-E2E-001`)
- Feature name matches
- Spec patterns (`*.spec.*`, `*.test.*`)

---

## 2. Categorize by Level

Classify as:

- E2E
- API
- Component
- Unit

Record test IDs, describe blocks, and priority markers if present.

---

## 3. Build Coverage Heuristics Inventory

Capture explicit coverage signals so Phase 1 can detect common blind spots:

- API endpoint coverage
  - Inventory endpoints referenced by requirements/specs and endpoints exercised by API tests
  - Mark endpoints with no direct tests
- Authentication/authorization coverage
  - Detect tests for login/session/token flows and permission-denied paths
  - Mark auth/authz requirements with missing negative-path tests
- Error-path coverage
  - Detect validation, timeout, network-failure, and server-error scenarios
  - Mark criteria with happy-path-only tests

Record these findings in step output as `coverage_heuristics` for Step 3/4.

---

### 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-discover-tests"]
  lastStep: "step-02-discover-tests"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-discover-tests'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-discover-tests'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
