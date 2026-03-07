---
name: "step-e-01-assess-workflow"
description: "Load target workflow, check compliance, check for validation report, offer validation if needed"

# File References
nextStepFile: "./step-e-02-discover-edits.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{workflow_name}.md"
validationWorkflow: "../steps-v/step-01-validate.md"
conversionStep: "../steps-c/step-00-conversion.md"
---

# Edit Step 1: Assess Workflow

## STEP GOAL:

Load the target workflow, check if it follows BMAD step-file architecture, check for existing validation report, and offer to run validation if needed.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Focus ONLY on assessment - no editing yet
- 🚫 FORBIDDEN to proceed without loading workflow completely
- 💬 Explain findings clearly and get user confirmation
- 🚪 ROUTE non-compliant workflows to create flow

## EXECUTION PROTOCOLS:

- 🎯 Load and analyze target workflow
- 💾 Create edit plan document
- 📖 Check for validation report
- 🚫 FORBIDDEN to proceed without user confirmation

## CONTEXT BOUNDARIES:

- User provides workflow path from workflow.md routing
- Focus: Assessment and routing
- This is NOT about making changes yet

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Get Workflow Path

From the user input provided by workflow.md routing, extract:

- `targetWorkflowPath` - path to workflow.md file
- `workflowName` - derived from path

**If path was not provided:**

"Which workflow would you like to edit? Please provide the path to the workflow.md file."

### 2. Load Workflow Completely

**Load these files:**

1. `{targetWorkflowPath}/workflow.md` - Must exist - if the user indicates is something else, ask if this is a conversion to the compliant v6 format
2. Check for step folders: `steps*`
3. Check for `data/` folder
4. Check for `templates/` folder

### 3. Compliance Check

**Determine if workflow is BMAD-compliant:**

**Compliant workflow has:**

- ✅ workflow.md file exists at root
- ✅ At least one step folder exists (steps-c/, steps-v/, or steps-e/)
- ✅ Step files use markdown format (.md)
- ✅ workflow.md has frontmatter (name, description)

**Non-compliant workflow:**

- ❌ No workflow.md file
- ❌ Has workflow.yaml or instructions.md (legacy format)
- ❌ No step folders
- ❌ Step files are not markdown

### 4. Route Based on Compliance

**IF NON-COMPLIANT:**

"**Workflow Assessment Result: Non-Compliant Format**

I found that this workflow does not follow BMAD step-file architecture:

- [Describe what was found - e.g., legacy format, missing workflow.md, etc.]

**Recommendation:** This workflow should be converted using the create workflow process. The create workflow can use your existing workflow as input discovery material to build a new compliant workflow.

**Would you like to:**

1. **[C]onvert to Compliant Workflow** - Use existing workflow as input to build compliant version
2. **[E]xplore manual conversion** - I can explain what needs to change
3. **[X] Exit** - Cancel this operation

#### Menu Handling Logic:

- IF C: Route to create workflow conversion mode → Load {conversionStep} with sourceWorkflowPath set to {targetWorkflowPath}
- IF E: Explain conversion requirements, then redisplay menu
- IF X: Exit with guidance
- IF Any other: help user, then redisplay menu"

**IF COMPLIANT:**

"**Workflow Assessment Result: Compliant Format**

This workflow follows BMAD step-file architecture:

- ✅ workflow.md found
- ✅ Step folders: [list which ones exist]
- ✅ Data folder: [yes/no]
- ✅ Templates folder: [yes/no]"

Continue to step 5.

### 5. Check for Validation Report

**Look for validation report:**

- Check `{targetWorkflowPath}/validation-report-{workflow_name}.md`
- Check if report exists and read completion status

**IF NO VALIDATION REPORT EXISTS:**

"This workflow has not been validated yet.

**Recommendation:** Running validation first can help identify issues before editing. Would you like to:

1. **[V]alidate first** - Run comprehensive validation, then proceed with edits
2. **[S]kip validation** - Proceed directly to editing

#### Menu Handling Logic:

- IF V: Load, read entirely, then execute {validationWorkflow}. After validation completes, return to this step and proceed to step 6.
- IF S: Proceed directly to step 6 (Discover Edits)
- IF Any other: help user, then redisplay menu"

**IF VALIDATION REPORT EXISTS:**

Read the validation report and note:

- Overall status (COMPLETE/INCOMPLETE)
- Critical issues count
- Warning issues count

"**Existing Validation Report Found:**

- Status: [status]
- Critical Issues: [count]
- Warnings: [count]

I'll keep this report in mind during editing."

Continue to step 6.

### 6. Create Edit Plan Document

**Initialize edit plan:**

```markdown
---
mode: edit
targetWorkflowPath: "{targetWorkflowPath}"
workflowName: "{workflow_name}"
editSessionDate: "{current-date}"
stepsCompleted:
  - step-e-01-assess-workflow.md
hasValidationReport: [true/false]
validationStatus: [from report if exists]
---

# Edit Plan: {workflow_name}

## Workflow Snapshot

**Path:** {targetWorkflowPath}
**Format:** BMAD Compliant ✅
**Step Folders:** [list found]

## Validation Status

[If report exists: summary of validation status]
[If no report: No validation run yet]

---

## Edit Goals

_To be populated in next step_

---

## Edits Applied

_To track changes made_
```

Write to `{editPlan}`.

### 7. Present MENU OPTIONS

Display: "**Assessment Complete. Select an Option:** [C] Continue to Discovery"

#### Menu Handling Logic:

- IF C: Update editPlan, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN user selects [C] and edit plan is created, will you then load and read fully `{nextStepFile}` to execute and begin edit discovery.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Workflow loaded completely
- Compliance status determined
- Non-compliant workflows routed to create flow
- Edit plan document created
- Validation report checked
- User confirmed to proceed

### ❌ SYSTEM FAILURE:

- Not loading workflow completely
- Misclassifying non-compliant workflow as compliant
- Not routing non-compliant to create flow
- Not checking for validation report
- Not creating edit plan

**Master Rule:** Assessment must be thorough. Non-compliant workflows MUST be routed to create flow. Always check for validation report before editing.
