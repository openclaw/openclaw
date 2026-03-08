---
name: "e-04-sidecar-metadata"
description: "Review and plan metadata edits"

nextStepFile: "./e-05-persona.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
agentMetadata: ../data/agent-metadata.md
agentTypesDoc: ../data/understanding-agent-types.md

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 4: Sidecar and Metadata

## STEP GOAL:

Review the agent's hasSidecar decision and metadata, and plan any changes. If edits involve sidecar conversion, identify the implications.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Load agentMetadata and agentTypesDoc first
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load reference documents before discussing edits
- 📊 Document sidecar conversion requirements if applicable
- 💬 Focus on metadata that user wants to change

## EXECUTION PROTOCOLS:

- 🎯 Load agentMetadata.md and agentTypesDoc.md
- 📊 Review current metadata from editPlan
- 💾 Document planned metadata changes
- 🚫 FORBIDDEN to proceed without documenting changes

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Reference Documents

Read `{agentMetadata}` and `{agentTypesDoc}` to understand validation rules and sidecar implications.

### 2. Review Current Metadata

From `{editPlan}`, display current:

- hasSidecar (true/false)
- All metadata fields: id, name, title, icon, module

### 3. Discuss Metadata Edits

If user wants metadata changes:

**For sidecar conversion:**

- "Converting from hasSidecar: {current} to {target}"
- Explain implications:
  - false → true: Need to create sidecar folder, add critical_actions with sidecar file loading
  - true → false: Remove sidecar fields; if critical_actions only has sidecar references, remove section; otherwise keep non-sidecar critical_actions
- Update editPlan with conversion

**For metadata field changes:**

- id: kebab-case requirements
- name: display name conventions
- title: function description format
- icon: emoji/symbol
- module: path format

### 4. Document to Edit Plan

Append to `{editPlan}`:

```yaml
metadataEdits:
  sidecarConversion:
    from: { current-hasSidecar }
    to: { target-hasSidecar }
    rationale: { explanation }
  fieldChanges:
    - field: { field-name }
      from: { current-value }
      to: { target-value }
```

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Persona"

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

ONLY WHEN [C continue option] is selected and [metadata changes documented], will you then load and read fully `{nextStepFile}` to execute and begin persona planning.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Reference documents loaded
- Metadata changes discussed and documented
- Sidecar conversion implications understood
- Edit plan updated

### ❌ SYSTEM FAILURE:

- Proceeded without loading reference documents
- Sidecar conversion without understanding implications
- Changes not documented to edit plan

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
