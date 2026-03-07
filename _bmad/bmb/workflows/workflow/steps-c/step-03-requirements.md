---
name: "step-03-requirements"
description: "Gather detailed requirements through collaborative conversation"

nextStepFile: "./step-04-tools.md"
workflowExamples: "../data/workflow-examples.md"
outputFormatStandards: "../data/output-format-standards.md"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 3: Requirements Gathering

## STEP GOAL:

To gather comprehensive requirements through conversation, building on the classification decisions, and document them in a standardized format for the design phase.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect gathering requirements
- ✅ Build on what we discovered and classified
- ✅ Ask 1-2 questions at a time, think about responses
- ✅ We already know the 4 key decisions - now we get details

### Step-Specific Rules:

- 🎯 Focus ONLY on requirements gathering
- 🚫 FORBIDDEN to propose workflow designs yet
- 💬 Ask conversationally, not like a form
- 📋 Use the standardized template (below) for consistent storage

## EXECUTION PROTOCOLS:

- 🎯 Load references as needed
- 💾 Store to standardized template in plan document
- 📖 Update frontmatter stepsCompleted when complete
- 🚫 FORBIDDEN to load next step until requirements are complete

## CONTEXT BOUNDARIES:

- Discovery (Step 1) gave us the vision
- Classification (Step 2) gave us the 4 key decisions
- Now we gather detailed requirements
- Don't design workflow steps yet - that's Step 6

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Initialize Requirements

"**Let's gather the requirements for your workflow.**

We already know:

- [Summarize vision from discovery]
- [Summarize 4 key decisions from classification]

Now I need to understand the details of how this workflow should work."

### 2. Workflow Flow and Structure

Load `{workflowExamples}` to reference diverse patterns.

"**How should this workflow flow?**

From our examples, workflows can be structured differently:"

**Flow Patterns:**

- **Linear:** Step 1 → Step 2 → Step 3 → Finish
- **Looping:** Generate → Review → Generate more... until done
- **Branching:** Different paths based on user choices
- **Repeating:** Same steps, new content each session

"Think about your workflow:

- Should it go straight through, or loop/branch?
- How many logical phases does it need?
- What are the major milestones?"

**Think about their response...**

### 3. User Interaction Style

"**How collaborative should this be?**

Think about the person running this workflow:"

- **Highly Collaborative:** AI asks questions, guides, facilitates at each step
- **Mostly Autonomous:** AI does the work with occasional checkpoints
- **Guided Session:** AI leads through a structured experience
- **Mixed:** Some steps collaborative, some autonomous

"Where does your workflow fit on this spectrum?

And are there specific decision points where the user MUST choose something?"

### 4. Input Requirements

"**What does this workflow need to start?**"

- What documents or data must be provided?
- Are there prerequisites or dependencies?
- Will users need to provide specific information?
- Any optional inputs that enhance the workflow?

"**Think about their response before continuing...**"

### 5. Output Specifications (IF document-producing)

**ONLY if `workflowProducesDocuments: true` from classification:**

Load `{outputFormatStandards}` and discuss:

"**What should the output look like?**

Since your workflow produces a document, let's decide the format:"

**Four Template Types:**

1. **Free-form (Recommended)** - Minimal structure, content-driven
   - Use for: Most collaborative workflows
   - Has: Basic frontmatter, progressive content, final polish step

2. **Structured** - Required sections, flexible within each
   - Use for: Reports, proposals, documentation
   - Has: Clear section headers, consistent structure

3. **Semi-structured** - Core sections + optional additions
   - Use for: Forms, checklists, meeting minutes
   - Has: Required fields, optional extras

4. **Strict** - Exact format, specific fields
   - Use for: Compliance, legal, regulated (rare)
   - Has: Precise requirements, validation

"Which format fits your workflow best?"

**If Free-form (most common):**

- "We'll use a minimal template with basic frontmatter. The workflow will build the document section by section, with a final polish step to optimize flow."

**If Structured/Semi-structured:**

- "What sections are required? Any optional sections?"

**If Strict:**

- "Do you have an existing template to follow, or should we design one?"

Document the output format decision.

### 6. Output Specifications (IF non-document)

**ONLY if `workflowProducesDocuments: false` from classification:**

"**What does this workflow produce if not a document?**

- Actions performed?
- Changes made to code/files?
- A decision or recommendation?
- A temporary artifact?"

Document what the workflow produces.

### 7. Success Criteria

"**How will we know this workflow succeeded?**

Think about the end result:

- What does 'done' look like?
- What would make a user satisfied?
- Are there quality criteria?
- Can we measure success?"

"**Think about their response...**"

### 8. Instruction Style (NOW, Not Earlier)

**We ask this NOW because we understand the workflow:**

"**How should the AI executing this workflow behave?**"

**Intent-Based (Recommended for most):**

- Steps describe goals and principles
- AI adapts conversation naturally
- More flexible and responsive
- Example: "Guide user to define requirements through open-ended discussion"

**Prescriptive:**

- Steps provide exact instructions
- More controlled and predictable
- Example: "Ask: 'What is your primary goal? A) Growth B) Efficiency C) Quality'"

**Mixed:**

- Some steps prescriptive, others intent-based
- Use prescriptive for critical/required steps
- Use intent-based for creative/facilitative steps

"Which style fits your workflow, or should it be mixed?"

### 9. Store to Standardized Template

Update `{workflowPlanFile}` with the requirements section:

```markdown
## Requirements

**Flow Structure:**

- Pattern: [linear/looping/branching/repeating]
- Phases: [list major phases]
- Estimated steps: [rough count]

**User Interaction:**

- Style: [highly collaborative/mostly autonomous/guided/mixed]
- Decision points: [where user must choose]
- Checkpoint frequency: [how often to pause]

**Inputs Required:**

- Required: [list]
- Optional: [list]
- Prerequisites: [list]

**Output Specifications:**

- Type: [document/action/decision/temporary]
- Format: [free-form/structured/semi-structured/strict OR describe non-document output]
- Sections: [if structured]
- Frequency: [single/batch/continuous]

**Success Criteria:**

- [list what success looks like]

**Instruction Style:**

- Overall: [intent-based/prescriptive/mixed]
- Notes: [any specific style requirements]
```

### 10. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- ONLY proceed when user selects 'C'
- User can chat or ask questions - always respond and redisplay menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}
- IF P: Execute {partyModeWorkflow}
- IF C: Save requirements to plan, update frontmatter, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Requirements gathered through conversation (not interrogation)
- Flow structure clearly understood
- Input/output specifications defined
- Output format decided (if document-producing)
- Success criteria established
- Instruction style determined
- All stored in standardized template

### ❌ SYSTEM FAILURE:

- Asking for instruction style before understanding the workflow
- Skipping output format discussion
- Not storing to standardized template
- Proceeding without understanding the flow

**Master Rule:** Requirements build on classification. Use the standardized template so the next steps can read consistent data.
