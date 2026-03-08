---
name: "step-03-map-criteria"
description: "Map acceptance criteria to tests and build traceability matrix"
nextStepFile: "./step-04-analyze-gaps.md"
outputFile: "{test_artifacts}/traceability-report.md"
---

# Step 3: Map Criteria to Tests

## STEP GOAL

Create the traceability matrix linking requirements to tests.

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

## 1. Build Matrix

For each acceptance criterion:

- Map to matching tests
- Mark coverage status: FULL / PARTIAL / NONE / UNIT-ONLY / INTEGRATION-ONLY
- Record test level and priority
- Record heuristic signals:
  - Endpoint coverage present/missing (for API-impacting criteria)
  - Auth/authz coverage present/missing (positive and negative paths)
  - Error-path coverage present/missing (validation, timeout, network/server failures)

---

## 2. Validate Coverage Logic

Ensure:

- P0/P1 criteria have coverage
- No duplicate coverage across levels without justification
- Criteria are not happy-path-only when requirements imply error handling
- API criteria are not marked FULL if endpoint-level checks are missing
- Auth/authz criteria include at least one denied/invalid-path test where applicable

---

### 3. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-03-map-criteria"]
  lastStep: "step-03-map-criteria"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-03-map-criteria'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-03-map-criteria'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
