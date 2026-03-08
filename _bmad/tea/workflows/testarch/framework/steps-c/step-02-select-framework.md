---
name: "step-02-select-framework"
description: "Select Playwright or Cypress and justify choice"
nextStepFile: "./step-03-scaffold-framework.md"
outputFile: "{test_artifacts}/framework-setup-progress.md"
---

# Step 2: Framework Selection

## STEP GOAL

Choose the most appropriate framework and document the rationale.

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

## 1. Selection Logic

Use `{detected_stack}` from Step 1 to guide framework selection.

**If {detected_stack} is `frontend` or `fullstack` (browser-based testing):**

Default to **Playwright** unless strong reasons suggest Cypress.

**Playwright recommended when:**

- Large or complex repo
- Multi-browser support needed
- Heavy API + UI integration
- CI speed/parallelism is important

**Cypress recommended when:**

- Small team prioritizes DX
- Component testing focus
- Simpler setup needed

**If {detected_stack} is `backend` (no browser-based testing):**

Select the framework matching the project language:

- **Python**: pytest (default), unittest
- **Java/Kotlin**: JUnit 5 (default), TestNG
- **Go**: Go test (built-in)
- **C#/.NET**: xUnit (default), NUnit, MSTest
- **Ruby**: RSpec (default), Minitest
- **Rust**: cargo test (built-in)

**If {detected_stack} is `fullstack`:**

Select both a browser-based framework (Playwright/Cypress) AND the appropriate backend framework for the detected language.

Respect `config.test_framework` if explicitly set (not `"auto"`).

---

## 2. Announce Decision

State the selected framework and reasoning.

---

### 3. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-select-framework"]
  lastStep: "step-02-select-framework"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-select-framework'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-select-framework'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
