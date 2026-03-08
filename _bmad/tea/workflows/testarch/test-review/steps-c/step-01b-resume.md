---
name: "step-01b-resume"
description: "Resume interrupted workflow from last completed step"
outputFile: "{test_artifacts}/test-review.md"
---

# Step 1b: Resume Workflow

## STEP GOAL

Resume an interrupted workflow by loading the existing output document, displaying progress, and routing to the next incomplete step.

## MANDATORY EXECUTION RULES

- Read the entire step file before acting
- Speak in `{communication_language}`

---

## EXECUTION PROTOCOLS:

- Follow the MANDATORY SEQUENCE exactly
- Load the next step only when instructed

## CONTEXT BOUNDARIES:

- Available context: Output document with progress frontmatter
- Focus: Load progress and route to next step
- Limits: Do not re-execute completed steps
- Dependencies: Output document must exist from a previous run

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly.

### 1. Load Output Document

Read `{outputFile}` and parse YAML frontmatter for:

- `stepsCompleted` -- array of completed step names
- `lastStep` -- last completed step name
- `lastSaved` -- timestamp of last save

**If `{outputFile}` does not exist**, display:

"No previous progress found. There is no output document to resume from. Please use **[C] Create** to start a fresh workflow run."

**THEN:** Halt. Do not proceed.

---

### 2. Display Progress Dashboard

Display progress with checkmark/empty indicators:

```
Test Quality Review - Resume Progress:

1. Load Context (step-01-load-context)              [completed/pending]
2. Discover Tests (step-02-discover-tests)           [completed/pending]
3. Quality Evaluation + Aggregate (step-03f-aggregate-scores) [completed/pending]
4. Generate Report (step-04-generate-report)         [completed/pending]

Last saved: {lastSaved}
```

---

### 3. Route to Next Step

Based on `lastStep`, load the next incomplete step:

| lastStep                    | Next Step File                    |
| --------------------------- | --------------------------------- |
| `step-01-load-context`      | `./step-02-discover-tests.md`     |
| `step-02-discover-tests`    | `./step-03-quality-evaluation.md` |
| `step-03f-aggregate-scores` | `./step-04-generate-report.md`    |
| `step-04-generate-report`   | **Workflow already complete.**    |

**If `lastStep` is the final step** (`step-04-generate-report`), display: "All steps completed. Use **[C] Create** to start fresh, **[V] Validate** to review outputs, or **[E] Edit** to make revisions." Then halt.

**If `lastStep` does not match any value above**, display: "Unknown progress state (`lastStep`: {lastStep}). Please use **[C] Create** to start fresh." Then halt.

**Otherwise**, load the identified step file, read completely, and execute.

The existing content in `{outputFile}` provides context from previously completed steps.

---

## SYSTEM SUCCESS/FAILURE METRICS

### SUCCESS:

- Output document loaded and parsed correctly
- Progress dashboard displayed accurately
- Routed to correct next step

### FAILURE:

- Not loading output document
- Incorrect progress display
- Routing to wrong step

**Master Rule:** Resume MUST route to the exact next incomplete step. Never re-execute completed steps.
