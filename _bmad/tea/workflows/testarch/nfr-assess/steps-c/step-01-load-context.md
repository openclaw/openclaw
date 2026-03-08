---
name: "step-01-load-context"
description: "Load NFR requirements, evidence sources, and knowledge base"
nextStepFile: "./step-02-define-thresholds.md"
knowledgeIndex: "{project-root}/_bmad/tea/testarch/tea-index.csv"
outputFile: "{test_artifacts}/nfr-assessment.md"
---

# Step 1: Load Context & Knowledge Base

## STEP GOAL

Gather NFR requirements, evidence sources, and knowledge fragments needed for assessment.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`
- 🚫 Halt if implementation or evidence is unavailable

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

- Implementation accessible for evaluation
- Evidence sources available (test results, metrics, logs)

If missing: **HALT** and request the missing inputs.

---

## 2. Load Configuration

From `{config_source}`:

- Read `tea_browser_automation`

---

### Tiered Knowledge Loading

Load fragments based on their `tier` classification in `tea-index.csv`:

1. **Core tier** (always load): Foundational fragments required for this workflow
2. **Extended tier** (load on-demand): Load when deeper analysis is needed or when the user's context requires it
3. **Specialized tier** (load only when relevant): Load only when the specific use case matches (e.g., contract-testing only for microservices, email-auth only for email flows)

> **Context Efficiency**: Loading only core fragments reduces context usage by 40-50% compared to loading all fragments.

## 3. Load Knowledge Base Fragments

From `{knowledgeIndex}` load:

- `adr-quality-readiness-checklist.md`
- `ci-burn-in.md`
- `test-quality.md`
- `playwright-config.md`
- `error-handling.md`

**Playwright CLI (if `tea_browser_automation` is "cli" or "auto"):**

- `playwright-cli.md`

**MCP Patterns (if `tea_browser_automation` is "mcp" or "auto"):**

- (existing MCP-related fragments, if any are added in future)

---

## 4. Load Artifacts

If available, read:

- `tech-spec.md` (primary NFRs)
- `PRD.md` (product-level NFRs)
- `story` or `test-design` docs (feature-level NFRs)

---

## 5. Confirm Inputs

Summarize loaded NFR sources and evidence availability.

---

## 6. Save Progress

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

**Update `inputDocuments`**: Set `inputDocuments` in the output template frontmatter to the list of artifact paths loaded in this step (e.g., knowledge fragments, test design documents, configuration files).

Load next step: `{nextStepFile}`

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

- Step completed in full with required outputs

### ❌ SYSTEM FAILURE:

- Skipped sequence steps or missing outputs
  **Master Rule:** Skipping steps is FORBIDDEN.
