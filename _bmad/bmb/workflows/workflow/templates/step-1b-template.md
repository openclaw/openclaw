# BMAD Workflow Step 1B Continuation Template

This template provides the standard structure for workflow continuation steps. It handles resuming workflows that were started but not completed, ensuring seamless continuation across multiple sessions.

Use this template alongside **step-01-init-continuable-template.md** to create workflows that can be paused and resumed. The init template handles the detection and routing logic, while this template handles the resumption logic.

<!-- TEMPLATE START -->

---

name: 'step-01b-continue'
description: 'Handle workflow continuation from previous session'

<!-- Path Definitions -->

workflow\*path: '{project-root}/\_bmad/[module-path]/workflows/[workflow-name]'

# File References (all use {variable} format in file)

thisStepFile: './step-01b-continue.md'
outputFile: '{output_folder}/[output-file-name]-{project_name}.md'
workflowFile: '{workflow_path}/workflow.md'

# Template References (if needed for analysis)

## analysisTemplate: '{workflow_path}/templates/[some-template].md'

# Step 1B: Workflow Continuation

## STEP GOAL:

To resume the [workflow-type] workflow from where it was left off, ensuring smooth continuation without loss of context or progress.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator

### Role Reinforcement:

- ✅ You are a [specific role, e.g., "business analyst" or "technical architect"]
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring [your expertise], user brings [their expertise], and together we produce something better than we could on our own
- ✅ Maintain collaborative [adjective] tone throughout

### Step-Specific Rules:

- 🎯 Focus ONLY on analyzing and resuming workflow state
- 🚫 FORBIDDEN to modify content completed in previous steps
- 💬 Maintain continuity with previous sessions
- 🚪 DETECT exact continuation point from frontmatter of incomplete file {outputFile}

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis of current state before taking action
- 💾 Keep existing frontmatter `stepsCompleted` values intact
- 📖 Review the template content already generated in {outputFile}
- 🚫 FORBIDDEN to modify content that was completed in previous steps
- 📝 Update frontmatter with continuation timestamp when resuming

## CONTEXT BOUNDARIES:

- Current [output-file-name] document is already loaded
- Previous context = complete template + existing frontmatter
- [Key data collected] already gathered in previous sessions
- Last completed step = last value in `stepsCompleted` array from frontmatter

## CONTINUATION SEQUENCE:

### 1. Analyze Current State

Review the frontmatter of {outputFile} to understand:

- `stepsCompleted`: Which steps are already done (the rightmost value is the last step completed)
- `lastStep`: Name/description of last completed step (if exists)
- `date`: Original workflow start date
- `inputDocuments`: Any documents loaded during initialization
- [Other relevant frontmatter fields]

Example: If `stepsCompleted: [1, 2, 3, 4]`, then step 4 was the last completed step.

### 2. Read All Completed Step Files

For each step number in `stepsCompleted` array (excluding step 1, which is init):

1. **Construct step filename**: `step-[N]-[name].md`
2. **Read the complete step file** to understand:
   - What that step accomplished
   - What the next step should be (from nextStep references)
   - Any specific context or decisions made

Example: If `stepsCompleted: [1, 2, 3]`:

- Read `step-02-[name].md`
- Read `step-03-[name].md`
- The last file will tell you what step-04 should be

### 3. Review Previous Output

Read the complete {outputFile} to understand:

- Content generated so far
- Sections completed vs pending
- User decisions and preferences
- Current state of the deliverable

### 4. Determine Next Step

Based on the last completed step file:

1. **Find the nextStep reference** in the last completed step file
2. **Validate the file exists** at the referenced path
3. **Confirm the workflow is incomplete** (not all steps finished)

### 5. Welcome Back Dialog

Present a warm, context-aware welcome:

"Welcome back! I see we've completed [X] steps of your [workflow-type].

We last worked on [brief description of last step].

Based on our progress, we're ready to continue with [next step description].

Are you ready to continue where we left off?"

### 6. Validate Continuation Intent

Ask confirmation questions if needed:

"Has anything changed since our last session that might affect our approach?"
"Are you still aligned with the goals and decisions we made earlier?"
"Would you like to review what we've accomplished so far?"

### 7. Present MENU OPTIONS

Display: "**Resuming workflow - Select an Option:** [C] Continue to [Next Step Name]"

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can chat or ask questions - always respond and then end with display again of the menu options
- Update frontmatter with continuation timestamp when 'C' is selected

#### Menu Handling Logic:

- IF C:
  1. Update frontmatter: add `lastContinued: [current date]`
  2. Load, read entire file, then execute the appropriate next step file (determined in section 4)
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN C is selected and continuation analysis is complete, will you then:

1. Update frontmatter in {outputFile} with continuation timestamp
2. Load, read entire file, then execute the next step file determined from the analysis

Do NOT modify any other content in the output document during this continuation step.

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Correctly identified last completed step from `stepsCompleted` array
- Read and understood all previous step contexts
- User confirmed readiness to continue
- Frontmatter updated with continuation timestamp
- Workflow resumed at appropriate next step

### ❌ SYSTEM FAILURE:

- Skipping analysis of existing state
- Modifying content from previous steps
- Loading wrong next step file
- Not updating frontmatter with continuation info
- Proceeding without user confirmation

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.

<!-- TEMPLATE END -->

## Customization Guidelines

When adapting this template for your specific workflow:

### 1. Update Placeholders

Replace bracketed placeholders with your specific values:

- `[module-path]` - e.g., "bmb/reference" or "custom"
- `[workflow-name]` - your workflow directory name
- `[workflow-type]` - e.g., "nutrition planning", "project requirements"
- `[output-file-name]` - base name for output document
- `[specific role]` - the role this workflow plays
- `[your expertise]` - what expertise you bring
- `[their expertise]` - what expertise user brings

### 2. Add Workflow-Specific Context

Add any workflow-specific fields to section 1 (Analyze Current State) if your workflow uses additional frontmatter fields for tracking.

### 3. Customize Welcome Message

Adapt the welcome dialog in section 5 to match your workflow's tone and context.

### 4. Add Continuation-Specific Validations

If your workflow has specific checkpoints or validation requirements, add them to section 6.

## Implementation Notes

1. **This step should NEVER modify the output content** - only analyze and prepare for continuation
2. **Always preserve the `stepsCompleted` array** - don't modify it in this step
3. **Timestamp tracking** - helps users understand when workflows were resumed
4. **Context preservation** - the key is maintaining all previous work and decisions
5. **Seamless experience** - user should feel like they never left the workflow
