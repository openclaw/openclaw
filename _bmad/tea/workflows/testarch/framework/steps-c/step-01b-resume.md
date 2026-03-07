---
name: "step-01b-resume"
description: "Resume interrupted workflow from last completed step"
outputFile: "{test_artifacts}/framework-setup-progress.md"
---

# Step 1b: Resume Workflow

## STEP GOAL

Resume an interrupted workflow by loading the existing progress document, verifying previously created artifacts still exist on disk, displaying progress, and routing to the next incomplete step.

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

Since this workflow creates code files, verify that artifacts from completed steps still exist on disk:

- If `step-01-preflight` completed: Confirm `package.json` still exists
- If `step-03-scaffold-framework` completed: Confirm directory structure and config files exist
- If `step-04-docs-and-scripts` completed: Confirm `{test_dir}/README.md` exists

If any expected artifacts are missing, warn the user and suggest re-running from the step that created them.

---

### 3. Display Progress Dashboard

Display:

"📋 **Workflow Resume — Test Framework Setup**

**Last saved:** {lastSaved}
**Steps completed:** {stepsCompleted.length} of 5

1. ✅/⬜ Preflight Checks (step-01-preflight)
2. ✅/⬜ Select Framework (step-02-select-framework)
3. ✅/⬜ Scaffold Framework (step-03-scaffold-framework)
4. ✅/⬜ Docs & Scripts (step-04-docs-and-scripts)
5. ✅/⬜ Validate & Summary (step-05-validate-and-summary)"

---

### 4. Route to Next Step

Based on `lastStep`, load the next incomplete step:

- `'step-01-preflight'` → `./step-02-select-framework.md`
- `'step-02-select-framework'` → `./step-03-scaffold-framework.md`
- `'step-03-scaffold-framework'` → `./step-04-docs-and-scripts.md`
- `'step-04-docs-and-scripts'` → `./step-05-validate-and-summary.md`
- `'step-05-validate-and-summary'` → **Workflow already complete.** Display: "✅ **All steps completed.** Use **[V] Validate** to review outputs or **[E] Edit** to make revisions." Then halt.

**If `lastStep` does not match any value above**, display: "⚠️ **Unknown progress state** (`lastStep`: {lastStep}). Please use **[C] Create** to start fresh." Then halt.

**Otherwise**, load the identified step file, read completely, and execute.

The existing content in `{outputFile}` provides context from previously completed steps.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Output document loaded and parsed correctly
- Previously created artifacts verified on disk
- Progress dashboard displayed accurately
- Routed to correct next step

### ❌ SYSTEM FAILURE:

- Not loading output document
- Not verifying existing artifacts
- Incorrect progress display
- Routing to wrong step
- Re-executing completed steps

**Master Rule:** Resume MUST route to the exact next incomplete step. Never re-execute completed steps.
