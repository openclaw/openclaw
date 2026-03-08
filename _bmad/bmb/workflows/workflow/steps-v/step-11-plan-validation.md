---
name: "step-11-plan-validation"
description: "Validate plan quality - ensure all user intent and requirements are implemented"

targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
---

# Validation Step 11: Plan Quality Validation

## STEP GOAL:

To validate that a workflow plan (if it exists) has been fully implemented - all user intent captured, all requirements met with high quality.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ This validation step only runs if a plan file exists
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context thread

### Step-Specific Rules:

- 🎯 Validate plan requirements using subprocess optimization - separate subprocess per requirement area for deep analysis
- 🚫 DO NOT skip checking any requirement from the plan - DO NOT BE LAZY
- 💬 Subprocess must either update validation report directly OR return structured findings to parent for aggregation
- 🚪 This ensures the build actually delivered what was planned

## EXECUTION PROTOCOLS:

- 🎯 Load plan and extract all requirements/intent using subprocess optimization when available - separate subprocess per requirement area for deep analysis
- 💾 Subprocesses validate implementation against plan requirements and return findings for aggregation
- 📖 Document gaps and quality issues
- 🚫 Only run this step if workflowPlanFile exists

## CONTEXT BOUNDARIES:

- This step runs AFTER the workflow is built
- Compares what was planned vs what was implemented
- Checks for: missing features, quality gaps, unmet user intent

## MANDATORY SEQUENCE

**CRITICAL:** Only run this step if {workflowPlanFile} exists. If it doesn't exist, skip to final summary.

### 1. Check if Plan Exists

First, check if {workflowPlanFile} exists:

**IF plan file does NOT exist:**

- Skip this validation step
- Proceed to summary with note: "No plan file found - workflow may have been built without BMAD create-workflow process"

**IF plan file exists:**

- Load the complete plan file
- Proceed with validation

### 2. Extract Plan Requirements

**DO NOT BE LAZY - Extract EVERY requirement from the plan:**

**SUBPROCESS EXECUTION PATTERN:**

Launch a subprocess that:

1. Loads {workflowPlanFile}
2. Extracts all requirements from each section (Discovery, Classification, Requirements, Design, Tools)
3. Returns structured requirements list to parent

**SUBPROCESS RETURNS:**
Structured requirements list organized by section (discovery, classification, requirements, design, tools) with all extracted items and a count of total requirements.

**If subprocess unavailable:** Load {workflowPlanFile} in main context and extract requirements (larger context but still functional - demonstrates graceful fallback).

---

### 3. Validate Each Requirement Against Built Workflow

**DO NOT BE LAZY - For EACH requirement area, launch a subprocess that:**

1. Loads relevant workflow files (workflow.md, step files, etc.)
2. Validates that specific requirement area is implemented correctly
3. Assesses quality of implementation
4. **EITHER** updates validation report directly with findings
5. **OR** returns structured validation results to parent for aggregation

**PATTERN 2: Separate subprocess per requirement area for deep analysis**

Each subprocess gets full context to deeply understand that requirement area and validate implementation quality:

---

**SUBPROCESS 1: Discovery Validation**

**Subprocess analyzes:**

- ✅ Built workflow addresses the original problem?
- ✅ Vision from discovery is reflected in final workflow?

**Subprocess returns:**
Discovery validation results indicating whether the original problem and vision from the plan are addressed in the built workflow, with quality assessment, status (✅/❌), and any gaps identified.

---

**SUBPROCESS 2: Classification Validation**

**Subprocess analyzes:**

- ✅ Document output matches plan (yes/no)?
- ✅ Module affiliation correct?
- ✅ Continuable support as specified?
- ✅ Tri-modal structure as specified?

**Subprocess returns:**
Classification validation results for each classification attribute (document output, module, continuable, tri-modal) comparing what was specified vs what was implemented, with overall quality assessment, status (✅/❌), and any gaps.

---

**SUBPROCESS 3: Requirements Validation**

**Subprocess analyzes:**

- ✅ Flow structure matches plan?
- ✅ User interaction style as specified?
- ✅ All required inputs configured?
- ✅ Output format matches specification?
- ✅ Success criteria achievable?

**Subprocess returns:**
Requirements validation results for flow structure, interaction style, inputs, outputs, and success criteria comparing what was specified vs what was implemented, with overall quality assessment, status (✅/❌), and any gaps.

---

**SUBPROCESS 4: Design Validation**

**Subprocess analyzes:**

- ✅ All steps from design present in workflow?
- ✅ Step purposes match design?
- ✅ Flow follows design diagram?
- ✅ Interaction patterns as specified?

**Subprocess returns:**
Design validation results for each step from the plan checking if it exists in the workflow and if the purpose matches, along with whether the flow follows the design diagram and interaction patterns match, with overall quality assessment, status (✅/❌), and any gaps.

---

**SUBPROCESS 5: Tools Validation**

**Subprocess analyzes:**

- ✅ Specified tools configured in workflow?
- ✅ Data files created as specified?

**Subprocess returns:**
Tools validation results checking which specified tools are configured and which data files were created, with overall quality assessment, status (✅/❌), and any gaps.

---

**If subprocess unavailable:** Validate each requirement area sequentially in main context (larger context but still functional - demonstrates graceful fallback).

---

### 4. Aggregate Findings and Update Report

After ALL requirement area subprocesses complete, aggregate findings into validation report.

Document the following information:

**Plan Information:**

- Plan file location
- Whether a plan was found
- Total number of requirements extracted from the plan

**Implementation Coverage:**
For each requirement area from the plan (Discovery/Vision, Classification attributes, Requirements specifications, Design elements, Tools):

- What was specified in the plan
- Whether it was implemented in the workflow
- Quality assessment (High/Medium/Low)
- Implementation status

**Implementation Gaps:**
List any requirements from the plan that are NOT present in the built workflow

**Quality Issues:**
List any requirements that are implemented but with quality concerns

**Plan-Reality Alignment:**
Describe where the built workflow doesn't match what was planned

**Overall Assessment:**

- Plan implementation score (percentage)
- Overall status (Fully Implemented/Partially Implemented/Poorly Implemented/Missing Critical Items)

**Quality Assessment Framework:**
For each implemented requirement, assess quality:

- **High Quality**: Implementation follows best practices, would facilitate effectively
- **Medium Quality**: Functional but has issues or gaps
- **Low Quality**: Minimal/barely working, would not facilitate well

Examples:

- Plan specifies "Highly collaborative, intent-based facilitation" and implementation has A/P menus with intent-based language = High Quality
- Plan specifies "Continuable workflow with session resume" and implementation has step-01b-continue.md tracking stepsCompleted = High Quality

### 5. Append to Report

Append the aggregated findings to {validationReportFile} after the "## Cohesive Review" section.

### 6. Save and Complete

Save the validation report. This is the final validation step.

**Display:**
"**Plan Quality validation complete.** Validation report finalized."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Plan file loaded completely (in subprocess or main context)
- Every requirement extracted and validated using subprocess optimization when available
- Each requirement area analyzed in separate subprocess (or main context with graceful fallback)
- Implementation gaps documented with structured findings
- Quality assessed for each requirement
- Findings aggregated and appended to report
- Context saved via subprocess pattern (return only findings, not full file contents)

### ❌ SYSTEM FAILURE:

- Not loading complete plan
- Skipping requirement checks
- Not validating each requirement area deeply
- Not using subprocess optimization when available
- Not documenting implementation gaps
- Not assessing quality
- Loading full file contents into parent instead of returning only findings

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. Check EVERY requirement from the plan. Use subprocess optimization (Pattern 2: per-requirement deep analysis) when available. Document all gaps. Return only findings to parent, not full file contents.
