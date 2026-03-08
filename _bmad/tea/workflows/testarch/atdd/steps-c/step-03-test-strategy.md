---
name: "step-03-test-strategy"
description: "Map acceptance criteria to test levels and priorities"
outputFile: "{test_artifacts}/atdd-checklist-{story_id}.md"
nextStepFile: "./step-04-generate-tests.md"
---

# Step 3: Test Strategy

## STEP GOAL

Translate acceptance criteria into a prioritized, level-appropriate test plan.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Avoid duplicate coverage across levels

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

## 1. Map Acceptance Criteria

- Convert each acceptance criterion into test scenarios
- Include negative and edge cases where risk is high

---

## 2. Select Test Levels

Choose the best level per scenario based on `{detected_stack}`:

**If {detected_stack} is `frontend` or `fullstack`:**

- **E2E** for critical user journeys
- **API** for business logic and service contracts
- **Component** for UI behavior

**If {detected_stack} is `backend` or `fullstack`:**

- **Unit** for pure functions, business logic, and edge cases
- **Integration** for service interactions, database queries, and middleware
- **API/Contract** for endpoint validation, request/response schemas, and Pact contracts
- **No E2E** for pure backend projects (no browser-based testing needed)

---

## 3. Prioritize Tests

Assign P0–P3 priorities using risk and business impact.

---

## 4. Confirm Red Phase Requirements

Ensure all tests are designed to **fail before implementation** (TDD red phase).

---

## 5. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-03-test-strategy"]
  lastStep: "step-03-test-strategy"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-03-test-strategy'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-03-test-strategy'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
