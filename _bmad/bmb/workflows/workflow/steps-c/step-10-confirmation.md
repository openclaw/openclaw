---
name: "step-10-confirmation"
description: "Confirm workflow completion - validate plan completion or conversion coverage"

targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{new_workflow_name}"
workflowPlanFile: "{targetWorkflowPath}/workflow-plan-{new_workflow_name}.md"
nextStepFile: "./step-11-completion.md"
validationWorkflow: "{targetWorkflowPath}/steps-v/step-01-validate.md"
---

# Step 10: Confirmation

## STEP GOAL:

Confirm the workflow build is complete by checking plan metadata. If this is a conversion, verify all original workflow elements are covered. If new, validate all plan requirements were met.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER skip reading the plan file completely
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous converter
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow quality assurance specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring thorough review expertise
- ✅ User confirms everything is complete

### Step-Specific Rules:

- 🎯 Focus on confirmation and verification
- 🚫 FORBIDDEN to skip checking plan metadata
- 💬 MUST read the entire plan to verify completion
- 📋 Different paths for conversion vs new workflows

## EXECUTION PROTOCOLS:

- 🎯 Load and read workflow plan completely
- 💾 Check for conversionFrom metadata field
- 📖 Route to appropriate confirmation path
- 🚫 FORBIDDEN to proceed without verification

## CONTEXT BOUNDARIES:

- All build steps are complete
- This is the final verification before completion
- Conversion workflows get coverage check
- New workflows get plan completion check

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Load Workflow Plan

**Load the workflowPlanFile completely:**

Read `{workflowPlanFile}` entirely to extract:

- Frontmatter metadata (check for `conversionFrom`)
- Discovery notes
- All requirements from classification, design, tools sections
- Original workflow analysis (if conversion)

"**Loading workflow plan for confirmation...**"

### 2. Check Conversion Metadata

**Examine plan frontmatter for `conversionFrom` field:**

```yaml
conversionFrom: "{path to source workflow if this is a conversion}"
```

**IF conversionFrom EXISTS:**
Route to [Conversion Confirmation](#3-conversion-confirmation-path)

**ELSE (no conversionFrom):**
Route to [New Workflow Confirmation](#4-new-workflow-confirmation-path)

---

### 3. Conversion Confirmation Path

**DO NOT BE LAZY - Load and review the ORIGINAL workflow completely:**

"**This is a workflow conversion. Verifying all original elements are covered...**"

**Load the original workflow from conversionFrom path:**

- Read EVERY file from the source workflow
- Extract original goal, steps, instructions

**For each element from the original, verify coverage:**

#### A. Original Goal Coverage

"**Original Goal:** {from source}

**✅ Covered in new workflow:** {how it's covered}

OR

**⚠️ Partial coverage:** {what's covered} - {what might be missing}

OR

**❌ Not covered:** {explain gap}"

#### B. Original Step Coverage

**For EACH step from the original workflow:**

| Original Step | Purpose   | Covered In          | Status                            |
| ------------- | --------- | ------------------- | --------------------------------- |
| {step name}   | {purpose} | {new step location} | ✅ Full / ⚠️ Partial / ❌ Missing |

"**Step-by-step coverage:** {count} of {total} steps fully covered"

#### C. Original Instruction Patterns

**Review how the original workflow instructed the LLM:**

"**Original instruction style:** {describe}

**New workflow instruction style:** {describe}

**Collaborative patterns preserved:** {yes/no + details}

**Key LLM instructions covered:**
{List the key instruction patterns and how they're preserved}"

#### D. Conversion Coverage Summary

Present findings:

"**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

**Conversion Coverage Report**

**Source:** {conversionFrom}
**Target:** {targetWorkflowPath}

**Overall Coverage:** {percentage}%

| Category     | Total   | Covered | Partial | Missing |
| ------------ | ------- | ------- | ------- | ------- |
| Goal         | 1       | 1       | 0       | 0       |
| Steps        | {count} | {count} | {count} | {count} |
| Instructions | {count} | {count} | {count} | {count} |
| Output       | 1       | 1       | 0       | 0       |

---

**Missing Elements:** {count}
{List any gaps found}

**Improvements Made:** {count}
{List enhancements beyond original}

**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

**Does this coverage look complete? Any gaps to address?**

[C] Continue - Coverage is complete
[F] Fix gaps - Address missing elements
[R] Review details - See full comparison"

**Menu Handling Logic:**

- IF C: Proceed to [Completion Handoff](#5-completion-handoff)
- IF F: Return to build steps to address gaps (route to step-09-build-next-step.md)
- IF R: Present detailed step-by-step comparison, then redisplay menu
- IF Any other: help user respond, then redisplay menu

---

### 4. New Workflow Confirmation Path

**This is a new workflow (not a conversion). Validate all plan requirements were met.**

"**Verifying all requirements from the plan were implemented...**"

#### A. Load Plan Requirements

**From workflowPlanFile, extract ALL requirements:**

- Discovery: User's vision, who it's for, what it produces
- Classification: Type, structure, mode decisions
- Requirements: Specific features, inputs, outputs
- Design: Step structure, flow, key decisions
- Tools: Data files, templates, references

#### B. Verify Each Requirement

**For EACH requirement from the plan:**

| Requirement Area | Specified            | Implemented      | Location    | Status   |
| ---------------- | -------------------- | ---------------- | ----------- | -------- |
| {area}           | {what was specified} | {what was built} | {file/step} | ✅/⚠️/❌ |

#### C. Plan Completion Summary

Present findings:

"**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

**Plan Completion Report**

**Workflow:** {new_workflow_name}
**Location:** {targetWorkflowPath}

**Overall Completion:** {percentage}%

| Requirement Area | Specified   | Implemented      | Status |
| ---------------- | ----------- | ---------------- | ------ |
| Discovery Vision | {from plan} | {what was built} | ✅/⚠️  |
| Workflow Type    | {from plan} | {what was built} | ✅/⚠️  |
| Structure        | {from plan} | {what was built} | ✅/⚠️  |
| Key Features     | {from plan} | {what was built} | ✅/⚠️  |
| Data/Tools       | {from plan} | {what was built} | ✅/⚠️  |

---

**Missing Requirements:** {count}
{List any unmet requirements}

**Beyond Plan:** {count}
{List any additional features added during build}

**━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━**

**Does this implementation match your vision?**

[C] Continue - Implementation is complete
[F] Fix gaps - Address missing requirements
[R] Review details - See full comparison"

**Menu Handling Logic:**

- IF C: Proceed to [Completion Handoff](#5-completion-handoff)
- IF F: Return to build steps to address gaps (route to step-09-build-next-step.md)
- IF R: Present detailed requirement-by-requirement comparison, then redisplay menu
- IF Any other: help user respond, then redisplay menu

---

### 5. Completion Handoff

**After user confirms coverage/completion:**

Update `{workflowPlanFile}` frontmatter:

```yaml
status: CONFIRMED
confirmationDate: { current date }
confirmationType: { conversion / new_workflow }
coverageStatus: { complete / gaps_accepted }
```

Proceed to [Validation Offer](#6-validation-offer).

---

### 6. Validation Offer

"**✅ Workflow build confirmed!**

**Before using your workflow, I recommend running extensive validation.**

The validation phase will systematically check:

- File structure & size
- Frontmatter compliance
- Menu handling patterns
- Step type patterns
- Output format standards
- Instruction style
- Overall quality

**Would you like to run validation?**"

Display: **Build Confirmed! Select an Option:** [V] Start Validation [S] Skip - Complete Now

#### Menu Handling Logic:

- IF V: "Loading validation phase..." → Save confirmation status, update frontmatter, then load, read entire file, then execute {validationWorkflow}
- IF S: "Skipping validation. Proceeding to completion..." → Load, read entire file, then execute {nextStepFile}
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ALWAYS check plan metadata for conversionFrom field. Route to appropriate confirmation path. Only proceed after user confirms coverage/completion is satisfactory.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Plan file loaded completely
- ConversionFrom metadata checked
- Appropriate confirmation path executed
- Original workflow reviewed (if conversion)
- Plan requirements verified (if new)
- Coverage/completion report presented clearly
- User confirms and proceeds

### ❌ SYSTEM FAILURE:

- Not loading plan file completely
- Not checking conversionFrom metadata
- Skipping original workflow review (conversion)
- Not verifying plan requirements (new)
- Proceeding without user confirmation
- Missing gaps in coverage

**Master Rule:** Check conversionFrom metadata first. For conversions, REVIEW THE ORIGINAL COMPLETELY. For new workflows, VERIFY ALL PLAN REQUIREMENTS. Only proceed after user confirms.
