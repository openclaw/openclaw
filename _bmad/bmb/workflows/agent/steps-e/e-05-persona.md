---
name: "e-05-persona"
description: "Review and plan persona edits"

nextStepFile: "./e-06-commands-menu.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
personaProperties: ../data/persona-properties.md
principlesCrafting: ../data/principles-crafting.md
communicationPresets: ../data/communication-presets.csv

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 5: Persona

## STEP GOAL:

Review the agent's persona and plan any changes using the four-field persona system.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Load personaProperties, principlesCrafting, communicationPresets first
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load reference documents before discussing persona edits
- 📊 Maintain four-field system purity
- 💬 Focus on persona fields that user wants to change

## EXECUTION PROTOCOLS:

- 🎯 Load personaProperties.md, principlesCrafting.md, communicationPresets.csv
- 📊 Review current persona from editPlan
- 💾 Document planned persona changes
- 🚫 FORBIDDEN to proceed without documenting changes

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Reference Documents

Read `{personaProperties}`, `{principlesCrafting}`, `{communicationPresets}` to understand the four-field system.

### 2. Review Current Persona

From `{editPlan}`, display current persona:

- **role:** What they do
- **identity:** Who they are
- **communication_style:** How they speak
- **principles:** Why they act (decision framework)

### 3. Discuss Persona Edits

For each field the user wants to change:

**Role edits:**

- Ensure functional definition (not personality)
- Define expertise domain and capabilities

**Identity edits:**

- Ensure personality definition (not job description)
- Define character, attitude, worldview

**Communication_style edits:**

- Ensure speech pattern definition (not expertise)
- Define tone, formality, voice

**Principles edits:**

- First principle must activate expert knowledge
- Other principles guide decision-making
- Follow principlesCrafting.md guidance

### 4. Document to Edit Plan

Append to `{editPlan}`:

```yaml
personaEdits:
  role:
    from: { current }
    to: { target }
  identity:
    from: { current }
    to: { target }
  communication_style:
    from: { current }
    to: { target }
  principles:
    from: { current }
    to: { target }
```

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Commands Menu"

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

ONLY WHEN [C continue option] is selected and [persona changes documented with field purity maintained], will you then load and read fully `{nextStepFile}` to execute and begin commands menu planning.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Reference documents loaded
- Four-field system purity maintained
- Persona changes documented

### ❌ SYSTEM FAILURE:

- Proceeded without loading reference documents
- Field purity violated (mixed concepts)
- Changes not documented to edit plan

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
