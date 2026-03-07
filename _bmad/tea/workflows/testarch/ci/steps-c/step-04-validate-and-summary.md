---
name: "step-04-validate-and-summary"
description: "Validate pipeline and summarize"
outputFile: "{test_artifacts}/ci-pipeline-progress.md"
---

# Step 4: Validate & Summarize

## STEP GOAL

Validate CI configuration and report completion details.

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

## 1. Validation

Validate against `checklist.md`:

- Config file created
- Stages and sharding configured
- Burn-in and artifacts enabled
- Secrets/variables documented

Fix gaps before completion.

---

## 2. Completion Summary

Report:

- CI platform and config path
- Key stages enabled
- Artifacts and notifications
- Next steps (set secrets, run pipeline)

---

### 3. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-04-validate-and-summary"]
  lastStep: "step-04-validate-and-summary"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-04-validate-and-summary'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-04-validate-and-summary'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
