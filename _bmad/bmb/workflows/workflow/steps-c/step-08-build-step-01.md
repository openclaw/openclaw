---
name: "step-08-build-step-01"
description: "Build step-01-init.md and step-01b-continue.md (if continuable) with any supporting files"

nextStepFile: "./step-09-build-next-step.md"
targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{new_workflow_name}"
workflowPlanFile: "{targetWorkflowPath}/workflow-plan-{new_workflow_name}.md"
stepTemplate: "../templates/step-template.md"
stepTypePatterns: "../data/step-type-patterns.md"
frontmatterStandards: "../data/frontmatter-standards.md"
menuHandlingStandards: "../data/menu-handling-standards.md"
outputFormatStandards: "../data/output-format-standards.md"
inputDiscoveryStandards: "../data/input-discovery-standards.md"
subprocessPatterns: "../data/subprocess-optimization-patterns.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 8: Build Step 01 (and 01b if Continuable)

## STEP GOAL:

To build the first step file(s) for the new workflow - step-01-init.md and step-01b-continue.md if the workflow is continuable - including any supporting files these steps need.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a workflow architect and systems designer
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring implementation expertise and best practices
- ✅ User brings their specific requirements and design approvals

### Step-Specific Rules:

- 🎯 Focus ONLY on building step-01 (and 01b if continuable)
- 🚫 FORBIDDEN to build other steps yet - use step-09 for those
- 💬 Generate step content collaboratively based on approved design
- 🚪 CREATE files in the correct target location

## EXECUTION PROTOCOLS:

- 🎯 Load standards to understand step type patterns
- 💾 Document what was created in the plan
- 📖 Update frontmatter stepsCompleted to add this step when completed
- 🚫 FORBIDDEN to load next step until user selects 'C'

## CONTEXT BOUNDARIES:

- Approved design from step 6 specifies step-01's purpose and type
- Load step type patterns to understand init step structure
- Frontmatter and menu standards ensure compliance
- This is the FIRST step - sets up everything that follows

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Standards for Init Steps

**Load {stepTypePatterns}** to understand the init step patterns:

- Init Step (Non-Continuable) - For single-session workflows
- Init Step (Continuable) - For multi-session workflows
- Init Step (With Input Discovery) - If workflow needs prior documents

**Load {frontmatterStandards}** for variable and path rules.

**Load {menuHandlingStandards}** for menu patterns (init steps typically use auto-proceed or C-only).

### 2. Determine Step 01 Type

From the approved design, determine:

**Is the workflow continuable?**

- **YES:** Use Init Step (Continuable) pattern
- **NO:** Use Init Step (Non-Continuable) pattern

**Does the workflow need input discovery?**

- **YES:** Use Init Step (With Input Discovery) pattern
- **NO:** Standard init pattern

Confirm with user: "Based on your design, step-01 will be [continuable/non-continuable] with [input discovery/standard init]. Is this correct?"

### 3. Build step-01-init.md

**Load {stepTemplate}** for base structure.

Create `steps-c/step-01-init.md` with:

**Frontmatter:**

```yaml
---
name: "step-01-init"
description: "[from design]"

# File references (ONLY variables used in this step)
nextStepFile: "./step-02-[next-step-name].md"
outputFile: "{output_folder}/[output-name].md"
templateFile: "../templates/output-template.md" # If applicable

# Continuation support (if continuable)
continueFile: "./step-01b-continue.md" # If continuable

# Input discovery (if needed)
inputDocuments: []
requiredInputCount: [number]
moduleInputFolder: "{module_output_folder}"
inputFilePatterns: ["*-prd.md", "*-ux.md"] # From design

# Tasks (if A/P menu used)
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---
```

**Content Structure:**

```markdown
# Step 1: [Step Name From Design]

## STEP GOAL:

[Single sentence goal from design]

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are [role from design]
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring [expertise], user brings [theirs]
- ✅ Together we produce something better

### Step-Specific Rules:

- 🎯 Focus only on [specific task for step-01]
- 🚫 FORBIDDEN to [prohibited action]
- 💬 Approach: [how to engage]

## EXECUTION PROTOCOLS:

- 🎯 [Protocol 1]
- 💾 [Protocol 2 - create/append to output]
- 📖 [Protocol 3 - tracking]
- 🚫 This is the init step - sets up everything

## CONTEXT BOUNDARIES:

- [What's available at step 01]
- Focus: [what to focus on]
- Limits: [boundaries]
- Dependencies: [none - this is first step]

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. [First action - from design]

[Instructions for step-01 - intent-based, not prescriptive]

### 2. [Second action - from design]

[Instructions]

### ... [continue for all actions in step-01]

### N. Present MENU OPTIONS

[Menu from design - typically C-only for init, or A/P/C if appropriate]

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'

#### Menu Handling Logic:

- IF C: Create/append to {outputFile} with content, update frontmatter stepsCompleted, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then redisplay menu

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

[What success looks like for step-01]

### ❌ SYSTEM FAILURE:

[What failure looks like]

**Master Rule:** Skipping steps is FORBIDDEN.
```

**Customize content based on:**

- The step's goal from the design
- The workflow's role and persona
- Whether it's continuable
- Whether it needs input discovery
- The template type (if document-producing)

### 4. Build step-01b-continue.md (If Continuable)

**If workflow is continuable**, create `steps-c/step-01b-continue.md`:

**Frontmatter:**

```yaml
---
name: "step-01b-continue"
description: "Handle workflow continuation from previous session"

outputFile: "{output_folder}/[output-name].md"
workflowFile: "../workflow.md"
nextStepOptions:
  step-02: "./step-02-[name].md"
  step-03: "./step-03-[name].md"
  # ... add all subsequent steps
---
```

**Content:**

```markdown
# Step 1b: Continue Workflow

## STEP GOAL:

To resume the workflow from where it was left off in a previous session.

## MANDATORY EXECUTION RULES:

[Standard universal rules]

## CONTEXT BOUNDARIES:

- User has run this workflow before
- Output file exists with stepsCompleted array
- Need to route to the correct next step

## MANDATORY SEQUENCE

### 1. Welcome Back

"**Welcome back!** Let me check where we left off..."

### 2. Read stepsCompleted from Output

Load {outputFile} and read frontmatter `stepsCompleted` array.

### 3. Determine Next Step

Find the last completed step and identify the next step to load.

### 4. Route to Correct Step

Load the appropriate next step file based on stepsCompleted.

## MENU OPTIONS

Display continuation status and offer to proceed.

## SUCCESS/FAILURE METRICS

[Standard metrics]
```

### 5. Create Supporting Files (If Needed)

**Does step-01 need any:**

**Small templates?** (inline in step, no separate file needed)

**Data files?** (create if step references CSV data)

**Validation checklists?** (create if step validates something)

**If supporting files are needed, create them in `data/` folder and update step-01 frontmatter to reference them.**

### 5a. Apply Subprocess Optimization (If Designed)

**Check the approved design from step 6:** Was subprocess optimization identified for step-01?

**If YES, apply the appropriate pattern(s):**

Load {subprocessPatterns} and implement the subprocess optimization:

1. **Identify the pattern(s) from the design:**
   - Pattern 1: Single subprocess for grep/regex across many files
   - Pattern 2: Per-file subprocess for deep analysis
   - Pattern 3: Subprocess for data file operations
   - Pattern 4: Parallel execution of independent operations

2. **Add subprocess-specific Step-Specific Rules:**

   ```markdown
   ### Step-Specific Rules:

   - 🎯 [Brief description of which pattern applies]
   - 💬 Subprocess must either update report OR return findings to parent
   - 🚫 DO NOT BE LAZY - [specific guidance if Pattern 2]
   - ⚙️ TOOL/SUBPROCESS FALLBACK: If subprocess unavailable, perform in main thread
   ```

3. **Implement subprocess directives in the MANDATORY SEQUENCE:**
   - Use appropriate subprocess language:
     - Pattern 1: "Launch a subprocess that runs [command] across all files, returns [results]"
     - Pattern 2: "DO NOT BE LAZY - For EACH file, launch a subprocess that [analyzes], returns [findings]"
     - Pattern 3: "Launch a subprocess that loads [data file], performs [operation], returns [results]"
     - Pattern 4: "Launch subprocesses in parallel that [operations], aggregate results"

4. **Ensure return patterns are specified:**
   - Subprocess updates report directly OR
   - Subprocess returns structured findings to parent for aggregation

5. **Verify graceful fallback is documented:**
   - Universal fallback rule in Universal Rules
   - Step-specific fallback in Step-Specific Rules
   - Clear instructions for LLMs without subprocess capability

**If NO subprocess optimization was designed for step-01:**

Skip this section and proceed to document build in plan.

### 6. Document Build in Plan

Append to {workflowPlanFile}:

```markdown
## Step 01 Build Complete

**Created:**

- steps-c/step-01-init.md
- steps-c/step-01b-continue.md [if continuable]
- [any supporting files]

**Step Configuration:**

- Type: [continuable/non-continuable]
- Input Discovery: [yes/no]
- Next Step: step-02-[name]

**Supporting Files:**

- [list any data files, templates created]
```

### 7. Present MENU OPTIONS

Display: **Step 01 Complete - Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Next Step Build

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save build summary to {workflowPlanFile}, update frontmatter stepsCompleted, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN C is selected and build is saved to plan will you load {nextStepFile} to begin building the next step.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- step-01-init.md created with proper structure
- step-01b-continue.md created (if continuable)
- Frontmatter follows {frontmatterStandards}
- Menu handling follows {menuHandlingStandards}
- Step type pattern followed correctly
- Supporting files created (if needed)
- Build documented in plan

### ❌ SYSTEM FAILURE:

- Creating step without following template
- Missing continuation support for continuable workflow
- Wrong menu pattern for step type
- Frontmatter variables not used in step body
- Hardcoded paths instead of variables

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
