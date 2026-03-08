---
name: "step-02-define-thresholds"
description: "Identify NFR categories and thresholds"
nextStepFile: "./step-03-gather-evidence.md"
outputFile: "{test_artifacts}/nfr-assessment.md"
---

# Step 2: Define NFR Categories & Thresholds

## STEP GOAL

Establish the NFR categories to assess and the thresholds used for validation.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Never guess thresholds

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

## 1. Select Categories

Use the ADR Quality Readiness Checklist (8 categories):

1. Testability & Automation
2. Test Data Strategy
3. Scalability & Availability
4. Disaster Recovery
5. Security
6. Monitorability/Debuggability/Manageability
7. QoS/QoE
8. Deployability

Add any `custom_nfr_categories` if provided.

---

## 2. Define Thresholds

For each category, extract thresholds from:

- tech-spec (primary)
- PRD (secondary)
- story or test-design (feature-specific)

If a threshold is unknown, mark it **UNKNOWN** and plan to report **CONCERNS**.

---

## 3. Confirm NFR Matrix

List each NFR category with its threshold or UNKNOWN status.

---

## 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-02-define-thresholds"]
  lastStep: "step-02-define-thresholds"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-02-define-thresholds'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-02-define-thresholds'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
