---
name: "step-01b-resume"
description: "Resume interrupted workflow from last completed step"
outputFile: "{test_artifacts}/traceability-report.md"
---

# Step 1b: Resume Workflow

## STEP GOAL

Resume an interrupted workflow by loading the existing output document, displaying progress, and routing to the next incomplete step.

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

### 2. Display Progress Dashboard

Display:

"📋 **Workflow Resume — Requirements Traceability & Quality Gate**

**Last saved:** {lastSaved}
**Steps completed:** {stepsCompleted.length} of 5

1. Load Context (step-01-load-context) — {✅ if in stepsCompleted, ⬜ otherwise}
2. Discover Tests (step-02-discover-tests) — {✅ if in stepsCompleted, ⬜ otherwise}
3. Map Criteria (step-03-map-criteria) — {✅ if in stepsCompleted, ⬜ otherwise}
4. Analyze Gaps (step-04-analyze-gaps) — {✅ if in stepsCompleted, ⬜ otherwise}
5. Gate Decision (step-05-gate-decision) — {✅ if in stepsCompleted, ⬜ otherwise}"

---

### 3. Route to Next Step

Based on `lastStep`, load the next incomplete step:

- `'step-01-load-context'` → Load `./step-02-discover-tests.md`
- `'step-02-discover-tests'` → Load `./step-03-map-criteria.md`
- `'step-03-map-criteria'` → Load `./step-04-analyze-gaps.md`
- `'step-04-analyze-gaps'` → Load `./step-05-gate-decision.md`
- `'step-05-gate-decision'` → **Workflow already complete.** Display: "✅ **All steps completed.** Use **[V] Validate** to review outputs or **[E] Edit** to make revisions." Then halt.

**If `lastStep` does not match any value above**, display: "⚠️ **Unknown progress state** (`lastStep`: {lastStep}). Please use **[C] Create** to start fresh." Then halt.

**Otherwise**, load the identified step file, read completely, and execute.

The existing content in `{outputFile}` provides context from previously completed steps. Use it as reference for remaining steps.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Output document loaded and parsed correctly
- Progress dashboard displayed accurately
- Routed to correct next step

### ❌ SYSTEM FAILURE:

- Not loading output document
- Incorrect progress display
- Routing to wrong step
- Re-executing completed steps

**Master Rule:** Resume MUST route to the exact next incomplete step. Never re-execute completed steps.
