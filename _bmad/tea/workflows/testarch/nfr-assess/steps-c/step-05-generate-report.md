---
name: "step-05-generate-report"
description: "Create NFR report and validation summary"
outputFile: "{test_artifacts}/nfr-assessment.md"
---

# Step 5: Generate Report & Validate

## STEP GOAL

Produce the NFR assessment report and validate completeness.

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

## 1. Report Generation

Use `nfr-report-template.md` to produce `{outputFile}` containing:

- Category results (PASS/CONCERNS/FAIL)
- Evidence summary
- Remediation actions
- Gate-ready YAML snippet (if applicable)

---

## 2. Polish Output

Before finalizing, review the complete output document for quality:

1. **Remove duplication**: Progressive-append workflow may have created repeated sections — consolidate
2. **Verify consistency**: Ensure terminology, risk scores, and references are consistent throughout
3. **Check completeness**: All template sections should be populated or explicitly marked N/A
4. **Format cleanup**: Ensure markdown formatting is clean (tables aligned, headers consistent, no orphaned references)

---

## 3. Validation

Validate against `checklist.md` and fix gaps.

- [ ] CLI sessions cleaned up (no orphaned browsers)

---

## 4. Save Progress

**Save this step's accumulated work to `{outputFile}`.**

- **If `{outputFile}` does not exist** (first save), create it using the workflow template (if available) with YAML frontmatter:

  ```yaml
  ---
  stepsCompleted: ["step-05-generate-report"]
  lastStep: "step-05-generate-report"
  lastSaved: "{date}"
  ---
  ```

  Then write this step's output below the frontmatter.

- **If `{outputFile}` already exists**, update:
  - Add `'step-05-generate-report'` to `stepsCompleted` array (only if not already present)
  - Set `lastStep: 'step-05-generate-report'`
  - Set `lastSaved: '{date}'`
  - Append this step's output to the appropriate section of the document.

---

## 5. Completion Summary

Report:

- Overall NFR status
- Critical blockers or waivers needed
- Next recommended workflow (`trace` or release gate)

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
