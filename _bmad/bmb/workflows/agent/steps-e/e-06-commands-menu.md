---
name: "e-06-commands-menu"
description: "Review and plan command/menu edits"

nextStepFile: "./e-07-activation.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
agentMenuPatterns: ../data/agent-menu-patterns.md

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 6: Commands Menu

## STEP GOAL:

Review the agent's command menu and plan any additions, modifications, or removals.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Load agentMenuPatterns first
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load agentMenuPatterns before discussing menu edits
- 📊 Follow A/P/C convention for menu structure
- 💬 Focus on commands that user wants to add/modify/remove

## EXECUTION PROTOCOLS:

- 🎯 Load agentMenuPatterns.md
- 📊 Review current commands from editPlan
- 💾 Document planned command changes
- 🚫 FORBIDDEN to proceed without documenting changes

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Reference Documents

Read `{agentMenuPatterns}` to understand menu structure requirements.

### 2. Review Current Commands

From `{editPlan}`, display current commands with:

- trigger
- description
- handler/action

### 3. Discuss Command Edits

**For additions:**

- Define trigger (clear, intuitive, following conventions)
- Define description (concise, one line)
- Define handler/action (references capability)

**For modifications:**

- Update trigger, description, or handler
- Ensure still follows menu patterns

**For removals:**

- Identify commands to remove
- Confirm impact on agent functionality

### 4. Document to Edit Plan

Append to `{editPlan}`:

```yaml
commandEdits:
  additions:
    - trigger: { trigger }
      description: { description }
      handler: { handler }
  modifications:
    - command: { existing-command }
      changes: { what-to-change }
  removals:
    - command: { command-to-remove }
```

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Activation"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save to {editPlan}, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#5-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [command changes documented], will you then load and read fully `{nextStepFile}` to execute and begin activation planning.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- agentMenuPatterns loaded
- Command changes documented with trigger/description/handler
- A/P/C convention followed

### ❌ SYSTEM FAILURE:

- Proceeded without loading reference documents
- Commands missing required elements
- Changes not documented to edit plan

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
