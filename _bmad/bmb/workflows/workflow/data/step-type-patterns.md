# Step Type Patterns

## Core Skeleton

```markdown
---
name: 'step-[N]-[name]'
description: '[action]'
[file refs only if used]
---

# Step [N]: [Name]

## STEP GOAL:

[single sentence]

## MANDATORY EXECUTION RULES:

### Universal:

- 🛑 NEVER generate without user input
- 📖 Read complete step file before action
- 🔄 When loading with 'C', read entire file
- 📋 Facilitator, not generator

### Role:

- ✅ Role: [specific]
- ✅ Collaborative dialogue
- ✅ You bring [expertise], user brings [theirs]

### Step-Specific:

- 🎯 Focus: [task]
- 🚫 Forbidden: [action]
- 💬 Approach: [method]

## EXECUTION PROTOCOLS:

- 🎯 Follow MANDATORY SEQUENCE exactly
- 💾 [protocol]
- 📖 [protocol]

## CONTEXT BOUNDARIES:

- Available: [context]
- Focus: [scope]
- Limits: [bounds]
- Dependencies: [reqs]

## MANDATORY SEQUENCE

**Follow exactly. No skip/reorder without user request.**

### 1. [action]

[instructions]

### N. MENU OPTIONS

[see menu-handling-standards.md]

## 🚨 SUCCESS/FAILURE:

### ✅ SUCCESS: [criteria]

### ❌ FAILURE: [criteria]

**Master Rule:** Skipping steps FORBIDDEN.
```

## Step Types

### 1. Init (Non-Continuable)

**Use:** Single-session workflow

**Frontmatter:**

```yaml
---
name: "step-01-init"
description: "Initialize [workflow]"
nextStepFile: "./step-02-[name].md"
outputFile: "{output_folder}/[output].md"
templateFile: "../templates/[template].md"
---
```

- No continuation detection
- Auto-proceeds to step 2
- No A/P menu
- Creates output from template

### 2. Init (Continuable)

**Use:** Multi-session workflow

**Frontmatter:** Add `continueFile: './step-01b-continue.md'` <!-- validate-file-refs:ignore -->

**Logic:**

```markdown
## 1. Check Existing Workflow

- Look for {outputFile}
- If exists + has stepsCompleted → load {continueFile}
- If not → continue to setup
```

**Ref:** `step-01-init-continuable-template.md`

### 3. Continuation (01b)

**Use:** Paired with continuable init

**Frontmatter:**

```yaml
---
name: "step-01b-continue"
description: "Handle workflow continuation"
outputFile: "{output_folder}/[output].md"
workflowFile: "{workflow_path}/workflow.md"
---
```

**Logic:**

1. Read `stepsCompleted` from output
2. Read last completed step file to find nextStep
3. Welcome user back
4. Route to appropriate step

**Ref:** `step-1b-template.md`

### 4. Middle (Standard)

**Use:** Collaborative content generation

**Frontmatter:**

```yaml
---
name: "step-[N]-[name]"
nextStepFile: "./step-[N+1]-[name].md"
outputFile: "{output_folder}/[output].md"
advancedElicitationTask: "{project-root}/.../advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/.../party-mode/workflow.md"
---
```

**Menu:** A/P/C

### 5. Middle (Simple)

**Use:** Data gathering, no refinement

**Menu:** C only

### 6. Branch Step

**Use:** User choice determines path

**Frontmatter:**

```yaml
nextStepFile: "./step-[default].md"
altStepFile: "./step-[alternate].md"
```

**Menu:** Custom letters (L/R/etc.)

### 7. Validation Sequence

**Use:** Multiple checks without interruption

**Menu:** Auto-proceed

**Pattern:**

```markdown
## 1. Perform validation check

[logic]

## 2. Write results to {outputFile}

Append findings

## 3. Proceed to next validation

"**Proceeding to next check...**"
→ Load {nextValidationStep}
```

### 8. Init (With Input Discovery)

**Use:** Requires documents from prior workflows/external sources

**Frontmatter:**

```yaml
---
name: "step-01-init"
description: "Initialize and discover input documents"
inputDocuments: []
requiredInputCount: 1
moduleInputFolder: "{module_output_folder}"
inputFilePatterns:
  - "*-prd.md"
  - "*-ux.md"
---
```

**Logic:**

```markdown
## 1. Discover Inputs

Search {moduleInputFolder} + {project_folder}/docs/ for {inputFilePatterns}

## 2. Present Findings

"Found these documents:
[1] prd-my-project.md (3 days ago) ✓
[2] ux-research.md (1 week ago)
Which would you like to use?"

## 3. Validate and Load

Check workflowType, stepsCompleted, date
Load selected docs
Add to {inputDocuments}

## 4. Auto-Proceed

If all required inputs → step 2
If missing → Error with guidance
```

**Ref:** `input-discovery-standards.md`

### 9. Final Polish

**Use:** Optimizes document section-by-section

**Frontmatter:**

```yaml
---
name: "step-[N]-polish"
description: "Optimize and finalize document"
outputFile: "{output_folder}/[document].md"
---
```

**Logic:**

```markdown
## 1. Load Complete Document

Read {outputFile}

## 2. Document Optimization

Review for:

1. Flow/coherence
2. Duplication (remove, preserve essential)
3. Proper ## Level 2 headers
4. Smooth transitions
5. Readability

## 3. Optimize

Maintain:

- General order
- Essential info
- User's voice

## 4. Final Output

Save, mark complete
```

**Use for:** Free-form output workflows

### 10. Final Step

**Use:** Last step, completion

**Frontmatter:** No `nextStepFile`

**Logic:**

- Update frontmatter (mark complete)
- Final summary
- No next step

## Step Size Limits

| Type                  | Max |
| --------------------- | --- |
| Init                  | 150 |
| Init (with discovery) | 200 |
| Continuation          | 200 |
| Middle (simple)       | 200 |
| Middle (complex)      | 250 |
| Branch                | 200 |
| Validation sequence   | 150 |
| Final polish          | 200 |
| Final                 | 200 |

**If exceeded:** Split steps or extract to `/data/`.
