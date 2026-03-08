---
name: "step-02-identify-targets"
description: "Identify automation targets and create coverage plan"
outputFile: "{test_artifacts}/automation-summary.md"
nextStepFile: "./step-03-generate-tests.md"
---

# Step 2: Identify Automation Targets

## STEP GOAL

Determine what needs to be tested and select appropriate test levels and priorities.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Avoid duplicate coverage across test levels

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

## 1. Determine Targets

**BMad-Integrated:**

- Map acceptance criteria to test scenarios
- Check for existing ATDD outputs to avoid duplication
- Expand coverage with edge cases and negative paths

**Standalone:**

- If specific target feature/files are provided, focus there
- Otherwise auto-discover features in `{source_dir}`
- Prioritize critical paths, integrations, and untested logic

**If {detected_stack} is `frontend` or `fullstack`:**

**Browser Exploration (if `tea_browser_automation` is `cli` or `auto`):**

> **Fallback:** If CLI is not installed, fall back to MCP (if available) or skip browser exploration and rely on code/doc analysis.

Use CLI to explore the application and identify testable pages/flows:

1. `playwright-cli -s=tea-automate open <target_url>`
2. `playwright-cli -s=tea-automate snapshot` → capture page structure and element refs
3. Analyze snapshot output to identify testable elements and flows
4. `playwright-cli -s=tea-automate close`

> **Session Hygiene:** Always close sessions using `playwright-cli -s=tea-automate close`. Do NOT use `close-all` — it kills every session on the machine and breaks parallel execution.

**If {detected_stack} is `backend` or `fullstack`:**

**Source & API Analysis (no browser exploration):**

- Scan source code for route handlers, controllers, service classes, and public APIs
- Read OpenAPI/Swagger specs (`openapi.yaml`, `swagger.json`) if available
- Identify database models, migrations, and data access patterns
- Map service-to-service integrations and message queue consumers/producers
- Check for existing contract tests (Pact, etc.)

---

## 2. Choose Test Levels

Use `test-levels-framework.md` to select:

- **E2E** for critical user journeys
- **API** for business logic and service contracts
- **Component** for UI behavior
- **Unit** for pure logic and edge cases

---

## 3. Assign Priorities

Use `test-priorities-matrix.md`:

- P0: Critical path + high risk
- P1: Important flows + medium/high risk
- P2: Secondary + edge cases
- P3: Optional/rare scenarios

---

## 4. Coverage Plan

Produce a concise coverage plan:

- Targets by test level
- Priority assignments
- Justification for coverage scope (critical-paths/comprehensive/selective)

---

## 5. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-identify-targets"]
  lastStep: "step-02-identify-targets"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-identify-targets'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-identify-targets'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
