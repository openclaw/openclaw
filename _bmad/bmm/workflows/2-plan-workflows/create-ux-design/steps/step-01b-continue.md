# Step 1B: UX Design Workflow Continuation

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between UX facilitator and stakeholder
- 📋 YOU ARE A UX FACILITATOR, not a content generator
- 💬 FOCUS on understanding where we left off and continuing appropriately
- 🚪 RESUME workflow from exact point where it was interrupted
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis of current state before taking action
- 💾 Keep existing frontmatter `stepsCompleted` values
- 📖 Only load documents that were already tracked in `inputDocuments`
- 🚫 FORBIDDEN to modify content completed in previous steps

## CONTEXT BOUNDARIES:

- Current document and frontmatter are already loaded
- Previous context = complete document + existing frontmatter
- Input documents listed in frontmatter were already processed
- Last completed step = `lastStep` value from frontmatter

## YOUR TASK:

Resume the UX design workflow from where it was left off, ensuring smooth continuation.

## CONTINUATION SEQUENCE:

### 1. Analyze Current State

Review the frontmatter to understand:

- `stepsCompleted`: Which steps are already done
- `lastStep`: The most recently completed step number
- `inputDocuments`: What context was already loaded
- All other frontmatter variables

### 2. Load All Input Documents

Reload the context documents listed in `inputDocuments`:

- For each document in `inputDocuments`, load the complete file
- This ensures you have full context for continuation
- Don't discover new documents - only reload what was previously processed

### 3. Summarize Current Progress

Welcome the user back and provide context:
"Welcome back {{user_name}}! I'm resuming our UX design collaboration for {{project_name}}.

**Current Progress:**

- Steps completed: {stepsCompleted}
- Last worked on: Step {lastStep}
- Context documents available: {len(inputDocuments)} files
- Current UX design specification is ready with all completed sections

**Document Status:**

- Current UX design document is ready with all completed sections
- Ready to continue from where we left off

Does this look right, or do you want to make any adjustments before we proceed?"

### 4. Determine Next Step

Based on `lastStep` value, determine which step to load next:

- If `lastStep = 1` → Load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-02-discovery.md`
- If `lastStep = 2` → Load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-03-core-experience.md`
- If `lastStep = 3` → Load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-04-emotional-response.md`
- Continue this pattern for all steps
- If `lastStep` indicates final step → Workflow already complete

### 5. Present Continuation Options

After presenting current progress, ask:
"Ready to continue with Step {nextStepNumber}: {nextStepTitle}?

[C] Continue to Step {nextStepNumber}"

## SUCCESS METRICS:

✅ All previous input documents successfully reloaded
✅ Current workflow state accurately analyzed and presented
✅ User confirms understanding of progress
✅ Correct next step identified and prepared for loading

## FAILURE MODES:

❌ Discovering new input documents instead of reloading existing ones
❌ Modifying content from already completed steps
❌ Loading wrong next step based on `lastStep` value
❌ Proceeding without user confirmation of current state

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## WORKFLOW ALREADY COMPLETE?

If `lastStep` indicates the final step is completed:
"Great news! It looks like we've already completed the UX design workflow for {{project_name}}.

The final UX design specification is ready at {output_folder}/ux-design-specification.md with all sections completed through step {finalStepNumber}.

The complete UX design includes visual foundations, user flows, and design specifications ready for implementation.

Would you like me to:

- Review the completed UX design specification with you
- Suggest next workflow steps (like wireframe generation or architecture)
- Start a new UX design revision

What would be most helpful?"

## NEXT STEP:

After user confirms they're ready to continue, load the appropriate next step file based on the `lastStep` value from frontmatter.

Remember: Do NOT load the next step until user explicitly selects [C] to continue!
