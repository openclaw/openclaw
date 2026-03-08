---
name: "step-02-generation-mode"
description: "Choose AI generation or recording mode"
outputFile: "{test_artifacts}/atdd-checklist-{story_id}.md"
nextStepFile: "./step-03-test-strategy.md"
---

# Step 2: Generation Mode Selection

## STEP GOAL

Choose the appropriate generation mode for ATDD tests.

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

## 1. Default Mode: AI Generation

Use AI generation when:

- Acceptance criteria are clear
- Scenarios are standard (CRUD, auth, API, navigation)
- **If {detected_stack} is `backend`:** Always use AI generation (no browser recording needed)

Proceed directly to test strategy if this applies.

---

## 2. Optional Mode: Recording (Complex UI)

**Skip this section entirely if {detected_stack} is `backend`.** For backend projects, use AI generation from API documentation, OpenAPI/Swagger specs, or source code analysis instead.

**If {detected_stack} is `frontend` or `fullstack`:**

Use recording when UI interactions need live browser verification.

**Tool selection based on `config.tea_browser_automation`:**

If `auto`:

> **Note:** `${timestamp}` is a placeholder the agent should replace with a unique value (e.g., epoch seconds) for session isolation.

- **Simple recording** (snapshot selectors, capture structure): Use CLI
  - `playwright-cli -s=tea-atdd-${timestamp} open <url>` → `playwright-cli -s=tea-atdd-${timestamp} snapshot` → extract refs
- **Complex recording** (drag/drop, wizards, multi-step state): Use MCP
  - Full browser automation with rich tool semantics
- **Fallback:** If preferred tool unavailable, use the other; if neither, skip recording

If `cli`:

- Use Playwright CLI for all recording
- `playwright-cli -s=tea-atdd-${timestamp} open <url>`, `snapshot`, `screenshot`, `click <ref>`, etc.

If `mcp`:

- Use Playwright MCP tools for all recording (current behavior)
- Confirm MCP availability, record selectors and interactions

If `none`:

- Skip recording mode entirely, use AI generation from documentation

---

## 3. Confirm Mode

State the chosen mode and why. Then proceed.

---

## 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-generation-mode"]
  lastStep: "step-02-generation-mode"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-generation-mode'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-generation-mode'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
