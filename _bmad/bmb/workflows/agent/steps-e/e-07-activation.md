---
name: "e-07-activation"
description: "Review critical_actions and route to edit step"

editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
criticalActions: ../data/critical-actions.md

# Edit step route (determined by hasSidecar)
agentEdit: "./e-08-edit-agent.md"

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 7: Activation and Routing

## STEP GOAL:

Review critical_actions and route to the agent edit step based on hasSidecar value.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: Load criticalActions and editPlan first
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load criticalActions.md before discussing activation
- 📊 Determine hasSidecar for routing
- 💬 Route based on POST-EDIT hasSidecar value

## EXECUTION PROTOCOLS:

- 🎯 Load criticalActions.md
- 📊 Check editPlan for target hasSidecar value
- 💾 Route to agent edit step
- ➡️ Auto-advance to edit step on [C]

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Reference Documents

Read `{criticalActions}` and `{editPlan}` to understand:

- Current critical_actions (if any)
- Target hasSidecar value after edits

### 2. Review Critical Actions

If user wants to add/modify critical_actions:

- Reference patterns from criticalActions.md
- Define action name, description, invocation
- For hasSidecar: true — specify sidecar-folder and file paths

### 3. Determine Routing

Check `{editPlan}` for agent metadata (hasSidecar):

```yaml
# Simple routing based on hasSidecar
hasSidecar: true → route to e-08-edit-agent.md (create sidecar structure)
hasSidecar: false → route to e-08-edit-agent.md (single YAML file)
```

The edit step handles both cases based on hasSidecar value.

### 4. Document to Edit Plan

Append to `{editPlan}`:

```yaml
activationEdits:
  criticalActions:
    additions: []
    modifications: []
routing:
  destinationEdit: e-08-edit-agent.md
  hasSidecar: { true|false } # Derived from edit plan
```

### 5. Present MENU OPTIONS

Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Edit Agent"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save to {editPlan}, then only then load and execute the agent edit step
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#5-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## CRITICAL STEP COMPLETION NOTE

This is the **ROUTING HUB** for edit flow. ONLY WHEN [C continue option] is selected and [routing determined], load and execute the agent edit step:

- hasSidecar: false → Single YAML file edit
- hasSidecar: true → YAML + sidecar folder structure edit

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- criticalActions.md loaded
- Routing determined based on hasSidecar
- Edit plan updated with routing info

### ❌ SYSTEM FAILURE:

- Proceeded without loading reference documents
- Routing not determined
- Wrong edit step selected

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
