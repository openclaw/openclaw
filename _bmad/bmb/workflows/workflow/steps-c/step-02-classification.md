---
name: "step-02-classification"
description: "Classify the workflow by answering the 4 key structural decisions"

nextStepFile: "./step-03-requirements.md"
workflowTypeCriteria: "../data/workflow-type-criteria.md"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
bmbCreationsOutputFolder: "{bmb_creations_output_folder}"
customWorkflowLocation: "{custom_workflow_location}"
---

# Step 2: Workflow Classification

## STEP GOAL:

To determine the 4 key structural decisions that define how the workflow will be built: module affiliation, continuable vs single-session, tri-modal vs create-only, and document output.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect helping classify their workflow
- ✅ Explain the trade-offs of each decision clearly
- ✅ Help them make informed choices
- ✅ These 4 decisions affect the entire workflow structure

### Step-Specific Rules:

- 🎯 Focus ONLY on the 4 key structural decisions
- 🚫 FORBIDDEN to skip any of the 4 decisions
- 💬 Explain each decision in plain language before asking
- 🚪 These decisions determine file structure, naming, and location

## EXECUTION PROTOCOLS:

- 🎯 Load workflowTypeCriteria for the decision framework
- 💾 Document each decision in the plan
- 📖 Update frontmatter stepsCompleted when complete
- 🚫 FORBIDDEN to load next step until all 4 decisions are made

## CONTEXT BOUNDARIES:

- Discovery from Step 1 informs these decisions
- These are STRUCTURAL decisions that affect everything else
- Once made, changing them is difficult
- Take time to explain trade-offs

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 0. Load Decision Framework

Load `{workflowTypeCriteria}` to understand the 4 key decisions and their implications.

### 1. Decision 1: Document Output (FIRST - It's Fundamental)

"**Let's classify your workflow. I'll walk you through 4 key decisions that determine how it's built.**

**Decision 1: What does your workflow produce?**

Based on your idea from discovery, let me clarify:"

- [If unclear from discovery] "Does this workflow produce a document or file at the end? A report, a plan, a story, a checklist?"

Present the two options:

**A. Document-Producing**

- Creates a persistent output file
- Examples: reports, plans, stories, checklists, forms
- Uses templates for structure

**B. Non-Document**

- Performs actions without creating a document
- Examples: refactoring code, running tests, orchestrating tools
- May produce temporary files but no persistent output

"Which describes your workflow?"

**Think about their response before continuing...**

Once decided:

- Document: `workflowProducesDocuments: true`
- Non-document: `workflowProducesDocuments: false`

### 2. Decision 2: Module Affiliation

"**Decision 2: Where will this workflow live?**

Workflows can be standalone or part of a module:"

**Standalone:**

- NOT part of any module
- Stored in your custom location
- Only standard variables available

**Module-Based (BMB, BMM, CIS, BMGD, etc.):**

- Part of a specific module
- Has access to module-specific variables
- Stored in that module's workflows directory

"Is this workflow:

- **A)** Standalone - just for you/custom use
- **B)** Part of a module - which one?"

**If they don't know modules:**
"Modules are specialized areas:

- **BMB** - Module building workflows
- **BMM** - Software development workflows (PRDs, architecture, etc.)
- **CIS** - Innovation and creative workflows
- **BMGD** - Game development workflows
- **Custom** - Your own workflows

Does your workflow fit into one of these areas, or is it standalone?"

Document the result.

### 3. Decision 3: Continuable or Single-Session

"**Decision 3: Could this workflow take multiple sessions to complete?**

Think about: Will this workflow consume many tokens or take a long time? Might users need to pause and come back later?"

**Single-Session:**

- Quick, focused workflows (15-30 minutes)
- Simpler structure
- No continuation logic needed

**Continuable:**

- Can span multiple sessions
- Complex, many steps
- Saves progress, can resume later
- Needs `step-01b-continue.md`

"Is your workflow:

- **A)** Single-session - quick and focused
- **B)** Continuable - could take multiple sessions"

**Help them think:**

- "Walk me through how long you think this would take..."
- "What happens if someone gets halfway through and has to stop?"

Document the result.

### 4. Decision 4: Create-Only or Tri-Modal

"**Decision 4: Will this workflow need Edit and Validate capabilities?**

Some workflows are simple - you create them once and use them. Others need full lifecycle support:\*\*

**Create-Only:**

- Just `steps-c/` (create steps)
- Simpler, faster to build
- Good for: experimental workflows, one-off use, simple tools

**Tri-Modal (Create + Edit + Validate):**

- Has `steps-c/`, `steps-e/` (edit), and `steps-v/` (validate)
- Full lifecycle support
- Can be modified and validated after creation
- Good for: complex workflows, maintained workflows, team use

"Do you envision:

- **A)** Create-only - build it and use it
- **B)** Tri-modal - create, edit, AND validate capabilities"

**If they're unsure:**
"Think: Will you or others want to modify this workflow later? Does it need quality checking/validation?"

Document the result.

### 5. Name the Workflow

"Now that we understand what this workflow IS, let's name it properly.

Based on everything we've discovered, what would you call this?

Some guidance:

- Use kebab-case: `my-workflow-name`
- Be descriptive but concise
- Think: What would someone search for to find this?

[Offer suggestions based on their vision]"

**Check for uniqueness:**

- Look for folder at `{bmb_creationsOutputFolder}/workflows/{proposed-name}/`
- If exists: "That name is taken. Want to try a variant like...?"
- Loop until unique name confirmed

Document the final name.

### 6. Confirm Target Location

Based on module decision, confirm and document the target path:

**For standalone/custom:**

- Target: `{customWorkflowLocation}/{workflow-name}/`
- Typically: `_bmad/custom/src/workflows/{workflow-name}/`

**For modules:**

- Check module's workflow location from module.yaml
- Confirm path with user

Document: `targetWorkflowPath: [confirmed path]`

### 7. Update Plan with Classification

Update `{workflowPlanFile}`:

```markdown
## Classification Decisions

**Workflow Name:** {name}
**Target Path:** {targetWorkflowPath}

**4 Key Decisions:**

1. **Document Output:** {true/false}
2. **Module Affiliation:** {standalone/module-name}
3. **Session Type:** {single-session/continuable}
4. **Lifecycle Support:** {create-only/tri-modal}

**Structure Implications:**

- [Document what this means: e.g., "Needs steps-c/, steps-e/, steps-v/", "Needs step-01b-continue.md", etc.]
```

### 8. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and redisplay menu

#### Menu Handling Logic:

- IF A: Execute {project-root}/\_bmad/core/workflows/advanced-elicitation/workflow.xml
- IF P: Execute {project-root}/\_bmad/core/workflows/party-mode/workflow.md
- IF C: Update plan frontmatter with stepsCompleted and classification, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All 4 key decisions made and documented
- Workflow named appropriately
- Target location confirmed
- Structural implications understood
- Plan updated with classification

### ❌ SYSTEM FAILURE:

- Skipping any of the 4 key decisions
- Naming before understanding (old pattern)
- Not explaining trade-offs
- Not checking for name conflicts

**Master Rule:** The 4 key decisions determine everything else. Get them right before proceeding.
