---
name: "step-01b-resume"
description: "Resume interrupted workflow from last completed step"
outputFile: "{test_artifacts}/ci-pipeline-progress.md"
---

# Step 1b: Resume Workflow

## STEP GOAL

Resume an interrupted workflow by loading the existing progress document, displaying progress, verifying previously created artifacts, and routing to the next incomplete step.

## MANDATORY EXECUTION RULES

- 📖 Read the entire step file before acting
- ✅ Speak in `{communication_language}`

---

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 📖 Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: Output document with progress frontmatter
- Focus: Load progress and route to next step
- Limits: Do not re-execute completed steps
- Dependencies: Output document must exist from a previous run

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Load Output Document

Read `{outputFile}` and parse YAML frontmatter for:

- `stepsCompleted` — array of completed step names
- `lastStep` — last completed step name
- `lastSaved` — timestamp of last save

**If `{outputFile}` does not exist**, display:

"⚠️ **No previous progress found.** There is no output document to resume from. Please use **[C] Create** to start a fresh workflow run."

**THEN:** Halt. Do not proceed.

---

### 2. Verify Previously Created Artifacts

Since this is a file-creation workflow, verify that artifacts from completed steps still exist on disk:

- If `step-02-generate-pipeline` is in `stepsCompleted`, check that the pipeline config file exists (e.g., `.github/workflows/test.yml` or equivalent)
- If any expected artifact is missing, warn the user and suggest re-running from the step that creates it

---

### 3. Display Progress Dashboard

Display:

"📋 **Workflow Resume — CI/CD Pipeline Setup**

**Last saved:** {lastSaved}
**Steps completed:** {stepsCompleted.length} of 4

1. Preflight Checks (step-01-preflight) — {✅ if in stepsCompleted, ⬜ otherwise}
2. Generate Pipeline (step-02-generate-pipeline) — {✅ if in stepsCompleted, ⬜ otherwise}
3. Configure Quality Gates (step-03-configure-quality-gates) — {✅ if in stepsCompleted, ⬜ otherwise}
4. Validate & Summary (step-04-validate-and-summary) — {✅ if in stepsCompleted, ⬜ otherwise}"

---

### 4. Route to Next Step

Based on `lastStep`, load the next incomplete step:

- `'step-01-preflight'` → Load `./step-02-generate-pipeline.md`
- `'step-02-generate-pipeline'` → Load `./step-03-configure-quality-gates.md`
- `'step-03-configure-quality-gates'` → Load `./step-04-validate-and-summary.md`
- `'step-04-validate-and-summary'` → **Workflow already complete.** Display: "✅ **All steps completed.** Use **[V] Validate** to review outputs or **[E] Edit** to make revisions." Then halt.

**If `lastStep` does not match any value above**, display: "⚠️ **Unknown progress state** (`lastStep`: {lastStep}). Please use **[C] Create** to start fresh." Then halt.

**Otherwise**, load the identified step file, read completely, and execute.

The existing content in `{outputFile}` provides context from previously completed steps. Use it as reference for remaining steps.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Output document loaded and parsed correctly
- Previously created artifacts verified
- Progress dashboard displayed accurately
- Routed to correct next step

### ❌ SYSTEM FAILURE:

- Not loading output document
- Incorrect progress display
- Routing to wrong step
- Re-executing completed steps

**Master Rule:** Resume MUST route to the exact next incomplete step. Never re-execute completed steps.
