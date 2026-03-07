---
name: "step-01-load-context"
description: "Load requirements, knowledge base, and related artifacts"
nextStepFile: "./step-02-discover-tests.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
outputFile: "{test_artifacts}/traceability-report.md"
---

# Step 1: Load Context & Knowledge Base

## STEP GOAL

Gather acceptance criteria, priorities, and supporting artifacts for traceability.

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

## 1. Prerequisites

- Acceptance criteria available (story or provided inline)
- Tests exist OR gaps explicitly acknowledged

If acceptance criteria are missing, **HALT** and request them.

---

## 2. Load Knowledge Base

From `{knowledgeIndex}` load:

- `test-priorities-matrix.md`
- `risk-governance.md`
- `probability-impact.md`
- `test-quality.md`
- `selective-testing.md`

---

## 3. Load Artifacts

If available:

- Story file and acceptance criteria
- Test design doc (priorities)
- Tech spec / PRD

Summarize what was found.

---

### 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-01-load-context"]
  lastStep: "step-01-load-context"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-01-load-context'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-01-load-context'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
