---
name: "step-05-plan-review"
description: "Review the complete workflow plan and approve before design"

nextStepFile: "./step-06-design.md"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 5: Plan Review and Approval

## STEP GOAL:

To present the complete workflow plan (discovery, classification, requirements, tools) for review and approval before proceeding to the design phase.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect conducting a design review
- ✅ Present the complete plan clearly
- ✅ Solicit feedback and make refinements
- ✅ Get explicit approval before proceeding to design

### Step-Specific Rules:

- 🎯 Focus ONLY on review and refinement
- 🚫 FORBIDDEN to start designing workflow steps in this step
- 💬 Present plan clearly, ask targeted questions
- 🚫 DO NOT proceed to design without user approval

## EXECUTION PROTOCOLS:

- 🎯 Present complete plan from {workflowPlanFile}
- 💾 Capture any modifications or refinements
- 📖 Update frontmatter stepsCompleted when complete
- 🚫 FORBIDDEN to load next step until user approves

## CONTEXT BOUNDARIES:

- Discovery (Step 1) → Classification (Step 2) → Requirements (Step 3) → Tools (Step 4)
- ALL the information needed for design is now captured
- This is the final checkpoint before designing the workflow structure
- Once we proceed to Step 6, we'll be designing actual step files

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Initialize Review

"**Let's review the complete plan before we start designing.**

We've covered a lot of ground. Let me walk you through everything we've decided, and you can tell me what looks right and what needs adjustment."

### 2. Present Complete Plan

Load and present from `{workflowPlanFile}`:

"**Complete Workflow Plan: {workflow-name}**

---

**1. DISCOVERY** (from Step 1)

**Your Vision:**
[Present user's vision]

**Who It's For:**
[Present users/audience]

**Key Insights:**
[Present important context]

---

**2. CLASSIFICATION** (from Step 2)

**The 4 Key Decisions:**

1. **Document Output:** {true/false} - [what it produces]
2. **Module Affiliation:** {standalone/module} - {target path}
3. **Session Type:** {single-session/continuable} - [implications]
4. **Lifecycle Support:** {create-only/tri-modal} - [implications]

**Workflow Name:** {name}
**Target Location:** {path}

---

**3. REQUIREMENTS** (from Step 3)

**Flow Structure:**

- Pattern: {linear/looping/branching/repeating}
- Phases: {list major phases}
- Estimated steps: {count}

**User Interaction:**

- Style: {collaborative/autonomous/guided/mixed}
- Decision points: {where user must choose}

**Inputs:** {required and optional}
**Output:** {type and format}
**Success Criteria:** {what success looks like}
**Instruction Style:** {intent/prescriptive/mixed}

---

**4. TOOLS CONFIGURATION** (from Step 4)

**Core Tools:**

- Party Mode: {included/excluded} - {integration point}
- Advanced Elicitation: {included/excluded} - {integration point}
- Brainstorming: {included/excluded} - {integration point}

**LLM Features:**

- Web-Browsing: {included/excluded}
- File I/O: {included/excluded}
- Sub-Agents: {included/excluded}
- Sub-Processes: {included/excluded}

**Memory:** {continuable/single-session}

---

### 3. Detailed Review by Section

"**Let's go through this systematically. I want your feedback on each area:**"

**A. Vision and Scope (Discovery)**

- "Does the 'Your Vision' section capture what you're trying to build?"
- "Anything we missed in the key insights?"

**B. Structural Decisions (Classification)**

- "Do the 4 key decisions still feel right?"
- "Any second thoughts on continuable vs single-session?"
- "Create-only or tri-modal - still the right call?"

**C. Requirements (Details)**

- "Does the flow structure match what you envisioned?"
- "Are the interaction style and decision points accurate?"
- "Input/output specifications complete?"
- "Success criteria clear?"

**D. Tools (Integrations)**

- "Do the selected tools make sense?"
- "Integration points feel right?"
- "Any tools we should add or remove?"

### 4. Collect Feedback

"**Your feedback:**

For each section above, tell me:

1. What looks good and should stay as-is
2. What needs modification or refinement
3. What's missing that should be added
4. Anything unclear or confusing

**Take your time - this is our last chance to make changes before we start designing the actual workflow.**"

### 5. Process Feedback and Refine

For each feedback item:

- Document the requested change
- Discuss implications on workflow design
- Make the refinement
- Confirm with user

Update `{workflowPlanFile}` with all approved changes.

### 6. Final Confirmation

"**One last check before we proceed to design:**

Based on everything we've discussed:

- [Re-state the workflow's purpose in one sentence]
- [Re-state the key structural decision: continuable/tri-modal]
- [Re-state the flow pattern]

You're approving this plan to move into the actual workflow design phase.

Ready to proceed?"

### 7. Update Plan Status

Update `{workflowPlanFile}` frontmatter:

```yaml
status: APPROVED_FOR_DESIGN
approvedDate: [current date]
```

### 8. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Design

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and redisplay menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}
- IF P: Execute {partyModeWorkflow}
- IF C: Update plan frontmatter with approval, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Complete plan presented clearly from the plan document
- All 4 sections reviewed systematically
- User feedback collected and incorporated
- User explicitly approves the plan
- Plan status updated to APPROVED_FOR_DESIGN
- Ready to proceed to design phase

### ❌ SYSTEM FAILURE:

- Not loading plan from {workflowPlanFile}
- Skipping review sections
- Not documenting refinements
- Proceeding without explicit approval
- Not updating plan status

**Master Rule:** The plan must be complete and approved before design. This is the gatekeeper step.
