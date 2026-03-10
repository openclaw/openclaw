# Step 1b: Workflow Continuation Handler

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between architectural peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on understanding current state and getting user confirmation
- 🚪 HANDLE workflow resumption smoothly and transparently
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 📖 Read existing document completely to understand current state
- 💾 Update frontmatter to reflect continuation
- 🚫 FORBIDDEN to proceed to next step without user confirmation

## CONTEXT BOUNDARIES:

- Existing document and frontmatter are available
- Input documents already loaded should be in frontmatter `inputDocuments`
- Steps already completed are in `stepsCompleted` array
- Focus on understanding where we left off

## YOUR TASK:

Handle workflow continuation by analyzing existing work and guiding the user to resume at the appropriate step.

## CONTINUATION SEQUENCE:

### 1. Analyze Current Document State

Read the existing architecture document completely and analyze:

**Frontmatter Analysis:**

- `stepsCompleted`: What steps have been done
- `inputDocuments`: What documents were loaded
- `lastStep`: Last step that was executed
- `project_name`, `user_name`, `date`: Basic context

**Content Analysis:**

- What sections exist in the document
- What architectural decisions have been made
- What appears incomplete or in progress
- Any TODOs or placeholders remaining

### 2. Present Continuation Summary

Show the user their current progress:

"Welcome back {{user_name}}! I found your Architecture work for {{project_name}}.

**Current Progress:**

- Steps completed: {{stepsCompleted list}}
- Last step worked on: Step {{lastStep}}
- Input documents loaded: {{number of inputDocuments}} files

**Document Sections Found:**
{list all H2/H3 sections found in the document}

{if_incomplete_sections}
**Incomplete Areas:**

- {areas that appear incomplete or have placeholders}
  {/if_incomplete_sections}

**What would you like to do?**
[R] Resume from where we left off
[C] Continue to next logical step
[O] Overview of all remaining steps
[X] Start over (will overwrite existing work)
"

### 3. Handle User Choice

#### If 'R' (Resume from where we left off):

- Identify the next step based on `stepsCompleted`
- Load the appropriate step file to continue
- Example: If `stepsCompleted: [1, 2, 3]`, load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md`

#### If 'C' (Continue to next logical step):

- Analyze the document content to determine logical next step
- May need to review content quality and completeness
- If content seems complete for current step, advance to next
- If content seems incomplete, suggest staying on current step

#### If 'O' (Overview of all remaining steps):

- Provide brief description of all remaining steps
- Let user choose which step to work on
- Don't assume sequential progression is always best

#### If 'X' (Start over):

- Confirm: "This will delete all existing architectural decisions. Are you sure? (y/n)"
- If confirmed: Delete existing document and read fully and follow: `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-01-init.md`
- If not confirmed: Return to continuation menu

### 4. Navigate to Selected Step

After user makes choice:

**Load the selected step file:**

- Update frontmatter `lastStep` to reflect current navigation
- Execute the selected step file
- Let that step handle the detailed continuation logic

**State Preservation:**

- Maintain all existing content in the document
- Keep `stepsCompleted` accurate
- Track the resumption in workflow status

### 5. Special Continuation Cases

#### If `stepsCompleted` is empty but document has content:

- This suggests an interrupted workflow
- Ask user: "I see the document has content but no steps are marked as complete. Should I analyze what's here and set the appropriate step status?"

#### If document appears corrupted or incomplete:

- Ask user: "The document seems incomplete. Would you like me to try to recover what's here, or would you prefer to start fresh?"

#### If document is complete but workflow not marked as done:

- Ask user: "The architecture looks complete! Should I mark this workflow as finished, or is there more you'd like to work on?"

## SUCCESS METRICS:

✅ Existing document state properly analyzed and understood
✅ User presented with clear continuation options
✅ User choice handled appropriately and transparently
✅ Workflow state preserved and updated correctly
✅ Navigation to appropriate step handled smoothly

## FAILURE MODES:

❌ Not reading the complete existing document before making suggestions
❌ Losing track of what steps were actually completed
❌ Automatically proceeding without user confirmation of next steps
❌ Not checking for incomplete or placeholder content
❌ Losing existing document content during resumption

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects their continuation option, load the appropriate step file based on their choice. The step file will handle the detailed work from that point forward.

Valid step files to load:
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-02-context.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-03-starter.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-06-structure.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-07-validation.md`
- `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-08-complete.md`

Remember: The goal is smooth, transparent resumption that respects the work already done while giving the user control over how to proceed.
