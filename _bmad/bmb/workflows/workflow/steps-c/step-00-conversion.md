---
name: "step-00-conversion"
description: "Convert existing workflow to BMAD compliant format by reading all instructions and extracting plan"

nextStepFile: "./step-02-classification.md"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
---

# Step 0: Workflow Conversion

## STEP GOAL:

Convert an existing workflow (any format) to BMAD compliant format by fully reading and understanding every instruction, extracting the essence, and creating a plan document.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER skip reading the entire source workflow
- 📖 CRITICAL: Read the complete step file before taking any action
- 📋 YOU ARE A FACILITATOR, not an autonomous converter
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow analyst and conversion specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring workflow architecture expertise, user brings their existing workflow
- ✅ Together we will extract the essence and rebuild compliantly

### Step-Specific Rules:

- 🎯 Focus on understanding the COMPLETE existing workflow
- 🚫 FORBIDDEN to skip any instruction or file
- 💬 Read EVERYTHING - instructions.md, workflow.yaml, step files, templates
- 📋 Document the essence succinctly

## EXECUTION PROTOCOLS:

- 🎯 Load and read the ENTIRE source workflow
- 💾 Extract: goal, steps, output, input requirements
- 📖 Create plan with conversionFrom metadata
- 🚫 FORBIDDEN to proceed without complete understanding

## CONTEXT BOUNDARIES:

- User provides existing workflow path (from routing or direct)
- This REPLACES step-01-discovery - we skip to step-02-classification
- The source workflow can be ANY format (legacy XML, partial, other systems)

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise.

### 1. Get Source Workflow Path

**If path was passed from routing (e.g., from edit workflow):**

- Use `{sourceWorkflowPath}` provided

**If no path was passed:**

"I can help you convert an existing workflow to BMAD compliant format.

**Please provide the path to the workflow you want to convert:**

This could be:

- A folder containing workflow.md
- A folder with workflow.yaml (legacy format)
- A folder with instructions.md
- Any workflow from another system

**Path:** {user provides path}"

### 2. Load EVERYTHING - DO NOT BE LAZY

"**Loading source workflow for complete analysis...**

**CRITICAL:** I will read EVERY file in this workflow to understand it completely."

**Load these files based on what exists:**

**If workflow.md exists:**

- Load workflow.md completely
- Load all step files (steps/_, steps-c/_, steps-v/_, steps-e/_)
- Load all data files (data/\*)
- Load all templates (templates/\*)

**If workflow.yaml exists (legacy XML format):**

- Load workflow.yaml completely
- Load instructions.md completely
- Load all step files, templates, data

**If other format:**

- Load every file that exists
- Read everything to understand the structure

**⚠️ DO NOT BE LAZY - Load and READ COMPLETELY:**

For each step file, read:

- The STEP GOAL
- All MANDATORY EXECUTION RULES
- All instructions in EXECUTION PROTOCOLS
- All menu options
- All templates and outputs

"**✅ Source workflow loaded completely**

**Files read:** {count} files
**Format detected:** {format}
**Structure identified:** {brief description}"

### 3. Extract and Document Workflow Essence

Create the workflow plan with complete extraction:

"**Extracting workflow essence...**"

Create `{workflowPlanFile}`:

```markdown
---
conversionFrom: "{sourceWorkflowPath}"
originalFormat: "{detected format}"
stepsCompleted: ["step-00-conversion"]
created: { current date }
status: CONVERSION
---

# Workflow Creation Plan

## Conversion Source

**Original Path:** {sourceWorkflowPath}
**Original Format:** {workflow.yaml / workflow.md / custom / etc.}
**Detected Structure:** {describe what was found}

---

## Original Workflow Analysis

### Goal (from source)

{Extract the exact goal from the source workflow}

### Original Steps (Complete List)

{Create succinct bullet list of EVERY step from the source:}

**Step 1:** {Step name} - {Brief purpose}
**Step 2:** {Step name} - {Brief purpose}
**Step 3:** {Step name} - {Brief purpose}
...
**Step N:** {Step name} - {Brief purpose}

### Output / Deliverable

{What does this workflow produce?}

### Input Requirements

{What inputs does this workflow need from the user?}

### Key Instructions to LLM

{Extract the key instruction patterns - how does the workflow talk to the LLM?
What style? What level of detail? What collaborative approach?}

---

## Conversion Notes

**What works well in original:**
{List strengths to preserve}

**What needs improvement:**
{List issues to address}

**Compliance gaps identified:**
{List what's missing for BMAD compliance}
```

### 4. Present Extracted Information to User

"**I've analyzed your existing workflow completely. Here's what I found:**

---

**Workflow Goal:**
{goal from analysis}

**Steps ({count}):**
{Display succinct bullet list}

**Output:**
{what it produces}

**Input Requirements:**
{what it needs from user}

---

**Format:** {originalFormat}
**Compliance Status:** {compliant / non-compliant / partial}

**Key observations:**
{Share 2-3 key insights about the workflow}"

### 5. Discovery Questions for Conversion

Even though this is a conversion, we need to understand some things:

"**A few questions to ensure the conversion captures your intent:**

1. **What's working well** in this workflow that we should definitely preserve?

2. **What problems** have you encountered with this workflow that we should fix?

3. **Any missing features** or improvements you'd like to add during conversion?

4. **Who will use** the converted workflow - same audience or different?"

### 6. Confirm and Proceed to Classification

"**Based on my analysis and your answers, I'm ready to proceed with classification.**

**Next step:** We'll classify the workflow type (document, action, interactive, autonomous, meta), determine structure (continuable or single-session), and decide if it needs validation steps.

**Ready to proceed?** [C] Continue to Classification"

#### Menu Handling Logic:

- IF C: Update workflowPlanFile with conversion notes, then load, read entirely, then execute {nextStepFile}
- IF Any other: help user respond, then redisplay menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN the entire source workflow has been read and analyzed, and the plan document contains the complete extraction (goal, steps, output, inputs) and conversionFrom metadata, will you then load and read fully `{nextStepFile}` to execute classification.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- ENTIRE source workflow loaded and read
- Every step documented in plan
- Goal, output, inputs extracted
- conversionFrom metadata set
- User confirms understanding
- Proceeding to classification

### ❌ SYSTEM FAILURE:

- Not loading all files in source workflow
- Skipping step files
- Not reading instructions completely
- Missing steps in documentation
- Not setting conversionFrom metadata
- Proceeding without complete understanding

**Master Rule:** DO NOT BE LAZY. Read EVERYTHING. Document the COMPLETE workflow essence. The conversion must capture ALL of the original workflow's intent and functionality.
