# BMAD Workflow Step Template

This template provides the standard structure for all BMAD workflow step files. Copy and modify this template for each new step you create.

<!-- TEMPLATE START -->

---

name: 'step-[N]-[short-name]'
description: '[Brief description of what this step accomplishes]'

<!-- Path Definitions -->

workflow\*path: '{project-root}/\_bmad/[module]/reference/workflows/[workflow-name]' # the folder the workflow.md file is in

# File References (all use {variable} format in file)

thisStepFile: './step-[N]-[short-name].md'
nextStep{N+1}: './step-[N+1]-[next-short-name].md' # Remove for final step or no next step
altStep{Y}: './step-[Y]-[some-other-step].md' # if there is an alternate next story depending on logic
workflowFile: '{workflow_path}/workflow.md'
outputFile: '{output_folder}/[output-file-name]-{project_name}.md'

# Task References (IF THE workflow uses and it makes sense in this step to have these )

advancedElicitationTask: '{project-root}/\_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/\_bmad/core/workflows/party-mode/workflow.md'

# Template References (if this step uses a specific templates)

profileTemplate: '{workflow_path}/templates/profile-section.md'
assessmentTemplate: '{workflow_path}/templates/assessment-section.md'
strategyTemplate: '{workflow_path}/templates/strategy-section.md'

# Data (CSV for example) References (if used in this step)

someData: '{workflow_path}/data/foo.csv'

# Add more as needed - but ONLY what is used in this specific step file!

---

# Step [N]: [Step Name]

## STEP GOAL:

[State the goal in context of the overall workflow goal. Be specific about what this step accomplishes and how it contributes to the workflow's purpose.]

Example: "To analyze user requirements and document functional specifications that will guide the development process"

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

- 🎯 Focus only on [specific task for this step]
- 🚫 FORBIDDEN to [what not to do in this step]
- 💬 Approach: [how to handle this specific task]
- 📋 Additional rule relevant to this step

## EXECUTION PROTOCOLS:

- 🎯 Follow the MANDATORY SEQUENCE exactly
- 💾 [Step-specific protocol 2 - e.g., document updates]
- 📖 [Step-specific protocol 3 - e.g., tracking requirements]
- 🚫 [Step-specific restriction]

## CONTEXT BOUNDARIES:

- Available context: [what context is available from previous steps]
- Focus: [what this step should concentrate on]
- Limits: [what not to assume or do]
- Dependencies: [what this step depends on]

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Title

[Specific instructions for first part of the work]

### 2. Title

[Specific instructions for second part of the work]

### N. Title (as many as needed)

<!-- not ever step will include advanced elicitation or party mode, in which case generally will just have the C option -->
<!-- for example an init step 1 that loads data, or step 1b continues a workflow would not need advanced elicitation or party mode - but any step where the user and the llm work together on content, thats where it makes sense to include them -->

### N. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask} # Or custom action
- IF P: Execute {partyModeWorkflow} # Or custom action
- IF C: Save content to {outputFile}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution completes, redisplay the menu
- User can chat or ask questions - always respond when conversation ends, redisplay the menu

## CRITICAL STEP COMPLETION NOTE

[Specific conditions for completing this step and transitioning to the next, such as output to file being created with this tasks updates]

ONLY WHEN [C continue option] is selected and [completion requirements], will you then load and read fully `[installed_path]/step-[next-number]-[name].md` to execute and begin [next step description].

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- [Step-specific success criteria 1]
- [Step-specific success criteria 2]
- Content properly saved/document updated
- Menu presented and user input handled correctly
- [General success criteria]

### ❌ SYSTEM FAILURE:

- [Step-specific failure mode 1]
- [Step-specific failure mode 2]
- Proceeding without user input/selection
- Not updating required documents/frontmatter
- [Step-specific failure mode N]

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.

<!-- TEMPLATE END-->

## Common Menu Patterns to use in the final sequence item in a step file

FYI Again - party mode is useful for the user to reach out and get opinions from other agents.

Advanced elicitation is use to direct you to think of alternative outputs of a sequence you just performed.

### Standard Menu - when a sequence in a step results in content produced by the agent or human that could be improved before proceeding

```markdown
### N. Present MENU OPTIONS

Display: "**Select an Option:** [A] [Advanced Elicitation] [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}
- IF P: Execute {partyModeWorkflow}
- IF C: Save content to {outputFile}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options
```

### Optional Menu - Auto-Proceed Menu (No User Choice or confirm, just flow right to the next step once completed)

```markdown
### N. Present MENU OPTIONS

Display: "**Proceeding to [next action]...**"

#### Menu Handling Logic:

- After [completion condition], immediately load, read entire file, then execute {nextStepFile}

#### EXECUTION RULES:

- This is an [auto-proceed reason] step with no user choices
- Proceed directly to next step after setup
```

### Custom Menu Options

```markdown
### N. Present MENU OPTIONS

Display: "**Select an Option:** [A] [Custom Action 1] [B] [Custom Action 2] [C] Continue"

#### Menu Handling Logic:

- IF A: [Custom handler route for option A]
- IF B: [Custom handler route for option B]
- IF C: Save content to {outputFile}, update frontmatter, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options
```

### Conditional Menu (Based on Workflow State)

```markdown
### N. Present MENU OPTIONS

Display: "**Select an Option:** [A] [Continue to Step Foo] [A] [Continue to Step Bar]"

#### Menu Handling Logic:

- IF A: Execute {customAction}
- IF C: Save content to {outputFile}, update frontmatter, check [condition]:
  - IF [condition true]: load, read entire file, then execute {pathA}
  - IF [condition false]: load, read entire file, then execute {pathB}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options
```

## Example Step Implementations

### Initialization Step Example

See [step-01-discovery.md](../steps-c/step-01-discovery.md) for an example of:

- Detecting existing workflow state and short circuit to 1b
- Creating output documents from templates
- Auto-proceeding to the next step (this is not the normal behavior of most steps)
- Handling continuation scenarios

### Continuation Step Example

See [step-01b-continue.md](../steps-c/step-01b-continuation.md) for an example of:

- Handling already-in-progress workflows that the user now wants to continue progress
- Detecting completion status (which step was already completed last)
- Presenting update vs new plan options
- Seamless workflow resumption by reviewing existing plan and output thus far that has been recorded and then jumping to the proper step

### Standard Step with Menu Example

See [step-02-classification.md](../steps-c/step-02-classification.md#8-present-menu-options) for an example of:

- Presenting a menu with A/P/C options
- Forcing halt until user selects 'C' (Continue)
- Writing all collected content to output file only when 'C' is selected
- Updating frontmatter with step completion before proceeding
- Using frontmatter variables for file references

### Final Step Example

See [step-11-completion.md](../steps-c/step-11-completion.md) for an example of:

- Completing workflow deliverables
- Marking workflow as complete in frontmatter
- Providing final success messages
- Ending the workflow session gracefully or moving on to a validation workflow if applicable

## Best Practices

1. **Keep step files focused** - Each step should do one thing well
2. **Be explicit in instructions** - No ambiguity about what to do
3. **Include all critical rules** - Don't assume anything from other steps
4. **Use clear, concise language** - Avoid jargon unless necessary
5. **Ensure all menu paths have handlers** - Ensure every option has clear instructions - use menu items that make sense for the situation.
6. **Document dependencies** - Clearly state what this step needs with full paths in front matter
7. **Define success and failure clearly** - Both for the step and the workflow
8. **Mark completion clearly** - Ensure final steps update frontmatter to indicate workflow completion
