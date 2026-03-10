---
name: 'step-e-02-review'
description: 'Deep Review & Analysis - Thoroughly review existing PRD and prepare detailed change plan'

# File references (ONLY variables used in this step)
nextStepFile: './step-e-03-edit.md'
prdFile: '{prd_file_path}'
validationReport: '{validation_report_path}'  # If provided
prdPurpose: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/data/prd-purpose.md'
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
---

# Step E-2: Deep Review & Analysis

## STEP GOAL:

Thoroughly review the existing PRD, analyze validation report findings (if provided), and prepare a detailed change plan before editing.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation Architect and PRD Improvement Specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring analytical expertise and improvement planning
- ✅ User brings domain knowledge and approval authority

### Step-Specific Rules:

- 🎯 Focus ONLY on review and analysis, not editing yet
- 🚫 FORBIDDEN to make changes to PRD in this step
- 💬 Approach: Thorough analysis with user confirmation on plan
- 🚪 This is a middle step - user confirms plan before proceeding

## EXECUTION PROTOCOLS:

- 🎯 Load and analyze validation report (if provided)
- 🎯 Deep review of entire PRD
- 🎯 Map validation findings to specific sections
- 🎯 Prepare detailed change plan
- 💬 Get user confirmation on plan
- 🚫 FORBIDDEN to proceed to edit without user approval

## CONTEXT BOUNDARIES:

- Available context: PRD file, validation report (if provided), user requirements from step e-01
- Focus: Analysis and planning only (no editing)
- Limits: Don't change PRD yet, don't validate yet
- Dependencies: Step e-01 completed - requirements and format known

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Attempt Sub-Process Deep Review

**Try to use Task tool with sub-agent:**

"Perform deep PRD review and change planning:

**Context from step e-01:**
- User's edit requirements: {user_requirements}
- PRD format: {BMAD/legacy}
- Validation report provided: {yes/no}
- Conversion mode: {restructure/targeted/both} (if legacy)

**IF validation report provided:**
1. Extract all findings from validation report
2. Map findings to specific PRD sections
3. Prioritize by severity: Critical > Warning > Informational
4. For each critical issue: identify specific fix needed
5. For user's manual edit goals: identify where in PRD to apply

**IF no validation report:**
1. Read entire PRD thoroughly
2. Analyze against BMAD standards (from prd-purpose.md)
3. Identify issues in:
   - Information density (anti-patterns)
   - Structure and flow
   - Completeness (missing sections/content)
   - Measurability (unmeasurable requirements)
   - Traceability (broken chains)
   - Implementation leakage
4. Map user's edit goals to specific sections

**Output:**
- Section-by-section analysis
- Specific changes needed for each section
- Prioritized action list
- Recommended order for applying changes

Return detailed change plan with section breakdown."

**Graceful degradation (if no Task tool):**
- Manually read PRD sections
- Manually analyze validation report findings (if provided)
- Build section-by-section change plan
- Prioritize changes by severity/user goals

### 2. Build Change Plan

**Organize by PRD section:**

**For each section (in order):**
- **Current State:** Brief description of what exists
- **Issues Identified:** [List from validation report or manual analysis]
- **Changes Needed:** [Specific changes required]
- **Priority:** [Critical/High/Medium/Low]
- **User Requirements Met:** [Which user edit goals address this section]

**Include:**
- Sections to add (if missing)
- Sections to update (if present but needs work)
- Content to remove (if incorrect/leakage)
- Structure changes (if reformatting needed)

### 3. Prepare Change Plan Summary

**Summary sections:**

**Changes by Type:**
- **Additions:** {count} sections to add
- **Updates:** {count} sections to update
- **Removals:** {count} items to remove
- **Restructuring:** {yes/no} if format conversion needed

**Priority Distribution:**
- **Critical:** {count} changes (must fix)
- **High:** {count} changes (important)
- **Medium:** {count} changes (nice to have)
- **Low:** {count} changes (optional)

**Estimated Effort:**
[Quick/Moderate/Substantial] based on scope and complexity

### 4. Present Change Plan to User

Display:

"**Deep Review Complete - Change Plan**

**PRD Analysis:**
{Brief summary of PRD current state}

{If validation report provided:}
**Validation Findings:**
{count} issues identified: {critical} critical, {warning} warnings

**Your Edit Requirements:**
{summary of what user wants to edit}

**Proposed Change Plan:**

**By Section:**
{Present section-by-section breakdown}

**By Priority:**
- Critical: {count} items
- High: {count} items
- Medium: {count} items

**Estimated Effort:** {effort level}

**Questions:**
1. Does this change plan align with what you had in mind?
2. Any sections I should add/remove/reprioritize?
3. Any concerns before I proceed with edits?

**Review the plan and let me know if you'd like any adjustments.**"

### 5. Get User Confirmation

Wait for user to review and provide feedback.

**If user wants adjustments:**
- Discuss requested changes
- Revise change plan accordingly
- Represent for confirmation

**If user approves:**
- Note: "Change plan approved. Proceeding to edit step."
- Continue to step 6

### 6. Document Approved Plan

Store approved change plan for next step:

- **Approved changes:** Section-by-section list
- **Priority order:** Sequence to apply changes
- **User confirmed:** Yes

Display: "**Change Plan Approved**

{Brief summary of approved plan}

**Proceeding to edit step...**"

Read fully and follow: {nextStepFile} (step-e-03-edit.md)

### 7. Present MENU OPTIONS (If User Wants Discussion)

**[A] Advanced Elicitation** - Get additional perspectives on change plan
**[P] Party Mode** - Discuss with team for more ideas
**[C] Continue to Edit** - Proceed with approved plan

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- Only proceed to edit when user selects 'C'

#### Menu Handling Logic:

- IF A: Read fully and follow: {advancedElicitationTask}, then return to discussion
- IF P: Read fully and follow: {partyModeWorkflow}, then return to discussion
- IF C: Document approval, then load {nextStepFile}
- IF Any other: discuss, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Validation report findings fully analyzed (if provided)
- Deep PRD review completed systematically
- Change plan built section-by-section
- Changes prioritized by severity/user goals
- User presented with clear plan
- User confirms or adjusts plan
- Approved plan documented for next step

### ❌ SYSTEM FAILURE:

- Not analyzing validation report findings (if provided)
- Superficial review instead of deep analysis
- Missing section-by-section breakdown
- Not prioritizing changes
- Proceeding without user approval

**Master Rule:** Plan before editing. Thorough analysis ensures we make the right changes in the right order. User approval prevents misalignment.
