---
name: "step-09-build-next-step"
description: "Build the next step in the workflow sequence - repeatable until all steps are built"

nextStepFile: "./step-09-build-next-step.md" # Self-referencing - repeats until complete
targetWorkflowPath: "{bmb_creations_output_folder}/workflows/{new_workflow_name}"
workflowPlanFile: "{targetWorkflowPath}/workflow-plan-{new_workflow_name}.md"
stepTemplate: "../templates/step-template.md"
stepTypePatterns: "../data/step-type-patterns.md"
frontmatterStandards: "../data/frontmatter-standards.md"
menuHandlingStandards: "../data/menu-handling-standards.md"
outputFormatStandards: "../data/output-format-standards.md"
csvDataFileStandards: "../data/csv-data-file-standards.md"
subprocessPatterns: "../data/subprocess-optimization-patterns.md"
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Step 9: Build Next Step (Repeatable)

## STEP GOAL:

To build the next step file in the workflow sequence based on the approved design. This step is REPEATABLE - continue running it until all steps from the design have been built.

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

- 🎯 Load the plan to determine WHICH step to build next
- 🚫 FORBIDDEN to skip steps or build out of order
- 💬 Each step is built collaboratively based on approved design
- 🚪 This step REPEATS until all workflow steps are built

## EXECUTION PROTOCOLS:

- 🎯 Always check what's been built, then build the next one
- 💾 Document each step in the plan as it's built
- 📖 Update frontmatter stepsCompleted to add each step when completed
- 🚫 Don't proceed to completion until ALL workflow steps are built

## CONTEXT BOUNDARIES:

- Approved design from step 6 specifies all steps
- The plan tracks which steps have been built
- Load step type patterns to understand each step's structure
- This step continues until the design is fully implemented

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Check Build Status

Load {workflowPlanFile} and check:

**What steps have been built so far?**

- Step 01: Always built in step-08
- Subsequent steps: Track in plan

**What is the NEXT step to build?**

From the design in the plan, identify:

- Step number and name
- Step type (Middle/Standard, Middle/Simple, Branch, Validation, Final Polish, Final)
- This step's goal and purpose

Confirm: "The next step to build is **step-{N}-{name}** which is a [step type]. Its goal is: [goal from design]. Ready to proceed?"

### 2. Load Standards for This Step Type

**Load {stepTypePatterns}** and find the pattern for this step type:

- Middle Step (Standard) - A/P/C menu, collaborative content
- Middle Step (Simple) - C only menu, no A/P
- Branch Step - Custom menu with routing logic
- Validation Sequence - Auto-proceed through checks
- Final Polish Step - Optimizes document built section-by-section
- Final Step - Completion, no next step

**Load {frontmatterStandards}** for variable rules.

**Load {menuHandlingStandards}** for menu patterns.

**Load {outputFormatStandards}** if this step outputs to document.

### 2a. Apply Subprocess Optimization (If Designed for This Step)

**Check the approved design from step 6:** Was subprocess optimization identified for this step?

**If YES, apply the appropriate pattern(s):**

Load {subprocessPatterns} and implement the subprocess optimization for this step:

1. **Identify the pattern(s) from the design for this step:**
   - Pattern 1: Single subprocess for grep/regex across many files
   - Pattern 2: Per-file subprocess for deep analysis
   - Pattern 3: Subprocess for data file operations
   - Pattern 4: Parallel execution of independent operations

2. **Add subprocess-specific Step-Specific Rules to this step:**

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

**If NO subprocess optimization was designed for this step:**

Skip this section and proceed to build the step file.

### 3. Build the Step File

**Load {stepTemplate}** for base structure.

Create `steps-c/step-{N}-{name}.md` with:

**Frontmatter:**

```yaml
---
name: "step-{N}-{name}"
description: "[what this step does]"

# File references (ONLY variables used in this step)
nextStepFile: "./step-{N+1}-[next-name].md" # Omit for final step
outputFile: "{output_folder}/[output-name].md"
templateFile: "../templates/[template-name].md" # If applicable

# Data files (if this step needs them)
someData: "../data/[data-file].csv" # If applicable

# Tasks (if A/P menu used)
advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---
```

**Content Structure:** (Same pattern as step-01, customized for this step)

```markdown
# Step {N}: [Step Name From Design]

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
- ✅ You bring [expertise for this step], user brings [theirs]

### Step-Specific Rules:

- 🎯 Focus only on [specific task for this step]
- 🚫 FORBIDDEN to [prohibited action]
- 💬 Approach: [how to engage for this step]

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 [Protocol - append to output if this step outputs]
- 📖 [Protocol - tracking if applicable]

## CONTEXT BOUNDARIES:

- [What's available at this step]
- Focus: [what to focus on]
- Limits: [boundaries]
- Dependencies: [what this step depends on from previous steps]

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. [First action - from design]

[Intent-based instructions for this step]

### 2. [Second action - from design]

[Intent-based instructions]

### ... [continue for all actions in this step]

### N. Present MENU OPTIONS

[Menu based on step type - Standard A/P/C, Simple C-only, Branching, Auto-proceed]

#### EXECUTION RULES:

[Based on menu type from {menuHandlingStandards}]

#### Menu Handling Logic:

[Handler for this step's menu]

## 🚨 SYSTEM SUCCESS/FAILURE METRICS:

### ✅ SUCCESS:

[What success looks like for this step]

### ❌ SYSTEM FAILURE:

[What failure looks like]

**Master Rule:** Skipping steps is FORBIDDEN.
```

**Customize based on:**

- Step type pattern from {stepTypePatterns}
- The step's specific goal and actions from design
- What this step outputs (if document-producing workflow)
- Menu pattern appropriate for step type

### 4. Create Supporting Files (If Needed)

**Does this step need any:**

**Small templates?** - Inline in step content or create small template file

**Data files?** - If step references CSV data, create in `data/` folder

- Load {csvDataFileStandards} for CSV structure
- Create CSV with proper headers and data

**Validation checklists?** - If this step validates something, create checklist

**Section templates?** - If step outputs to specific document section

**If supporting files are created:**

1. Create in appropriate folder (`data/` or `templates/`)
2. Update step frontmatter to reference them
3. Document in plan

### 5. Document Build in Plan

Append to {workflowPlanFile}:

```markdown
## Step {N} Build Complete

**Created:**

- steps-c/step-{N}-{name}.md
- [any supporting files]

**Step Configuration:**

- Type: [step type]
- Outputs to: [output section or file]
- Next Step: [next step or "final step"]

**Supporting Files:**

- [list any data files, templates created for this step]
```

### 6. Check If More Steps Needed

After documenting, check the design:

**Are all steps from the design now built?**

- **YES:** Proceed to completion menu (option 7 below)
- **NO:** Present continuation menu (option 6 below)

### 6a. Present MENU OPTIONS (More Steps Remaining)

Display: **Step {N} Complete - Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Build Next Step

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY build next step when user selects 'C'
- After other menu items execution, return to this menu

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save build summary to {workflowPlanFile}, update frontmatter stepsCompleted, then load, read entire file, then execute {nextStepFile} (which is THIS FILE - self-referencing for next iteration)
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#6a-present-menu-options-more-steps-remaining)

### 6b. Present MENU OPTIONS (All Steps Complete)

Display: **All Workflow Steps Built! Select an Option:** [R] Review Built Steps [V] Proceed to Validation [C] Complete Build

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- User selects final action

#### Menu Handling Logic:

- IF R: List all built steps with their paths, allow review, then redisplay menu
- IF V: Save final build summary to {workflowPlanFile}, update frontmatter stepsCompleted to include ALL steps, then load `./step-10-confirmation.md`
- IF C: Same as V (complete and proceed)
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#6b-present-menu-options-all-steps-complete)

## CRITICAL STEP COMPLETION NOTE

This step REPEATS until all workflow steps from the design are built. When complete, user selects V or C to proceed to completion.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Each step file created with proper structure for its type
- Frontmatter follows {frontmatterStandards}
- Menu handling follows {menuHandlingStandards}
- Step type pattern followed correctly
- Supporting files created as needed
- Each build documented in plan
- Process continues until ALL design steps are built

### ❌ SYSTEM FAILURE:

- Building steps out of order
- Skipping steps from the design
- Wrong menu pattern for step type
- Not documenting each step in plan
- Proceeding to completion before all steps built

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
