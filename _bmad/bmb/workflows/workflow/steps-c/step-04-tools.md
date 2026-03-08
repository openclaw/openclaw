---
name: "step-04-tools"
description: "Preview workflow structure, then configure tools with context"

nextStepFile: "./step-05-plan-review.md"
commonToolsCsv: "../data/common-workflow-tools.csv"
workflowPlanFile: "{bmb_creations_output_folder}/workflows/{new_workflow_name}/workflow-plan-{new_workflow_name}.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 4: Tools Configuration

## STEP GOAL:

To preview the workflow structure FIRST, then configure tools with clear context on where and how they'll be used.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect
- ✅ Tools need context to be configured intelligently
- ✅ We preview structure BEFORE deciding tool integration points

### Step-Specific Rules:

- 🎯 Preview workflow structure BEFORE configuring tools
- 🚫 FORBIDDEN to skip the preview - tools can't be configured without it
- 💬 Use the preview to make tool discussions concrete
- 🚫 Load tools from CSV, don't hardcode descriptions

## EXECUTION PROTOCOLS:

- 🎯 Present design preview based on requirements
- 💬 Discuss tools WITHIN the context of the preview
- 💾 Document tool decisions with integration points
- 📖 Update frontmatter stepsCompleted when complete
- 🚫 FORBIDDEN to load next step until tools are configured

## CONTEXT BOUNDARIES:

- Discovery → Classification → Requirements are complete
- We know the flow pattern, phases, interaction style
- NOW we can talk about tools with concrete examples
- This creates an intelligent tool configuration

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Present Design Preview

"**Before we configure tools, let me preview what your workflow structure might look like.**

Based on everything we've gathered, here's a rough outline:"

Create a concrete preview showing:

```markdown
## Workflow Structure Preview: {workflow-name}

**Phase 1: Initialization**

- Welcome user, explain the workflow
- Gather any starting inputs
- [Specific to this workflow]

**Phase 2: [Name from requirements]**

- [What happens in this phase]
- [User interaction point]

**Phase 3: [Name from requirements]**

- [What happens in this phase]
- [User interaction point]

**Phase 4: Completion**

- [What happens at the end]
- [Output/final step]
```

"This is just a preview - we'll design the actual steps in detail next. But this gives us context for discussing tools."

**Ask:** "Does this structure feel right? Any major phases I'm missing?"

### 2. Initialize Tools Discussion

"**Now let's configure the tools and integrations for your workflow.**

Since we can see the structure, we can talk about tools concretely: 'Party Mode could fit here in Phase 2 for creative brainstorming...' instead of abstractly."

### 3. Load and Present Available Tools

Load `{commonToolsCsv}` and present by category:

"**Available BMAD Tools:**

**Core Tools:**

- [List from CSV with descriptions]

**Optional Tools:**

- [List from CSV with descriptions]"

### 4. Configure Core Tools WITH Context

Go through each core tool, referencing the preview:

"**Party Mode** - For creative, unrestricted exploration

Looking at your workflow structure, I see potential in:

- [Specific phase from preview] for [specific reason]

Should we include Party Mode? If so, where would it fit best?"

"**Advanced Elicitation** - For deep exploration and quality

This could work well in:

- [Specific phase] for [specific reason]

Should we include Advanced Elicitation? Where would you want quality gates or deeper exploration?"

"**Brainstorming** - For idea generation

In your workflow, this might fit in:

- [Specific phase if applicable]

Should we include Brainstorming?"

### 5. Configure LLM Features WITH Context

"**LLM Features to enhance your workflow:**"

"**Web-Browsing** - For real-time information

Would your workflow benefit from:

- Current data/information
- Research during execution
- Live references

If yes, where in the structure would this be needed?"

"**File I/O** - For reading/writing files

Your workflow [will/won't] need file operations based on:

- [Input requirements from requirements]
- [Output specifications from requirements]

Any specific file operations needed?"

"**Sub-Agents** - For delegating specialized tasks

Could any part of your workflow benefit from:

- Specialized expertise
- Parallel processing
- Focused sub-tasks

Looking at your structure, [specific phase] might benefit..."

"**Sub-Processes** - For parallel workflows

Would any phase benefit from:

- Running multiple processes in parallel
- Coordinating multiple workflows

If so, which phase?"

### 6. Configure Memory Systems

"**Memory and State Management**"

**If continuable from classification:**
"Since your workflow is continuable, it needs to track progress between sessions.

We'll use:

- `stepsCompleted` array in output frontmatter
- `lastStep` tracking
- `step-01b-continue.md` for resuming

Any additional state we need to track?"

**If single-session:**
"Your workflow is single-session, so we'll keep state simple - no complex memory needed."

### 7. External Integrations (Optional)

"**External Integrations** - MCP, databases, APIs

Based on your workflow, are there any external systems it needs to connect to?

- Databases?
- APIs?
- MCP servers?
- Other tools?"

If yes, note installation requirements.

### 8. Installation Assessment

"**Installation and Dependencies**

Some tools require additional setup.

Based on what we've selected:

- [List any tools requiring installation]
- [Assess user comfort level]

Are you comfortable with these installations, or should we consider alternatives?"

### 9. Store Tools Configuration

Update `{workflowPlanFile}`:

```markdown
## Tools Configuration

**Core BMAD Tools:**

- **Party Mode:** [included/excluded] - Integration point: [specific phase/reason]
- **Advanced Elicitation:** [included/excluded] - Integration point: [specific phase/reason]
- **Brainstorming:** [included/excluded] - Integration point: [specific phase/reason]

**LLM Features:**

- **Web-Browsing:** [included/excluded] - Use case: [specific need]
- **File I/O:** [included/excluded] - Operations: [specific needs]
- **Sub-Agents:** [included/excluded] - Use case: [specific need]
- **Sub-Processes:** [included/excluded] - Use case: [specific need]

**Memory:**

- Type: [continuable/single-session]
- Tracking: [stepsCompleted, lastStep, etc.]

**External Integrations:**

- [List any selected with purposes]

**Installation Requirements:**

- [List tools needing installation]
- User preference: [willing/not willing/alternatives]
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
- IF C: Save tools to plan, update frontmatter, then load `{nextStepFile}`
- IF Any other: Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Design preview presented BEFORE tools discussion
- Tools discussed WITHIN concrete context
- Integration points clearly identified
- User can visualize where tools fit
- All decisions documented in plan

### ❌ SYSTEM FAILURE:

- Configuring tools without design preview
- Abstract tool discussions ("it could go somewhere")
- Not identifying concrete integration points
- Hardcoding tool descriptions instead of using CSV

**Master Rule:** Tools need context. Preview structure first, then configure tools with concrete integration points.
