---
name: "e-01-load-existing"
description: "Load and analyze existing agent for editing"

# File References
thisStepFile: ./e-01-load-existing.md
workflowFile: ../workflow-edit-agent.md
nextStepFile: "./e-02-discover-edits.md"
editPlan: "{bmb_creations_output_folder}/edit-plan-{agent-name}.md"
agentMetadata: ../data/agent-metadata.md
agentMenuPatterns: ../data/agent-menu-patterns.md

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Edit Step 1: Load Existing Agent

## STEP GOAL:

Load the existing agent file, parse its structure, and create an edit plan tracking document.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER proceed without loading the complete agent file
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not an autonomous editor
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are an agent analyst who helps users understand and modify existing agents
- ✅ If you already have been given a name, communication_style and identity, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring agent architecture expertise, user brings their modification goals, together we achieve successful edits
- ✅ Maintain collaborative analytical tone throughout

### Step-Specific Rules:

- 🎯 Focus only on loading and analyzing the existing agent
- 🚫 FORBIDDEN to make any modifications in this step
- 💬 Approach: Analytical and informative, present findings clearly
- 📋 Ensure edit plan is created with complete agent snapshot

## EXECUTION PROTOCOLS:

- 🎯 Load the complete agent YAML file
- 📊 Parse and analyze all agent components
- 💾 Create edit plan tracking document
- 🚫 FORBIDDEN to proceed without confirming file loaded successfully

## CONTEXT BOUNDARIES:

- Available context: User provided agent file path from workflow
- Focus: Load and understand the existing agent structure
- Limits: Analysis only, no modifications
- Dependencies: Agent file must exist and be valid YAML

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Agent File

**Load the agent file:**
Read the complete YAML from the agent file path provided by the user.

**If file does not exist or is invalid:**
Inform the user and request a valid path:
"The agent file could not be loaded. Please verify the path and try again.

Expected format: `{path-to-agent}/{agent-name}.agent.yaml`"

### 2. Parse Agent Structure

If the module property of the agent metadata is `stand-alone`, it is not a module agent.
If the module property of the agent is a module code (like bmm, bmb, etc...) it is a module agent.
If the property hasSidecar: true exists in the metadata, then it is an expert agent.
Else it is a simple agent.
If a module agent also hasSidecar: true - this means it is a modules expert agent, thus it can have sidecar.

**Extract and categorize all agent components:**

```yaml
# Basic Metadata
- name: { agent-name }
- description: { agent-description }
- module: { stand-alone|bmm|cis|bmgd|custom }
- hasSidecar: { true|false }

# Persona
- persona: { full persona text }
- system-context: { if present }

# Commands/Menu
- commands: { full command structure }

# Critical Actions (if present)
- critical-actions: { list }

# Metadata
- metadata: { all metadata fields }
```

### 3. Display Agent Summary

**Present a clear summary to the user:**

```markdown
## Agent Analysis: {agent-name}

**Type:** {simple|expert|module} (derived from module + hasSidecar)
**Status:** ready-for-edit

### Current Structure:

**Persona:** {character count} characters
**Commands:** {count} commands defined
**Critical Actions:** {count} critical actions

### Editable Components:

- [ ] Persona (role, identity, communication_style, principles)
- [ ] Commands and menu structure
- [ ] Critical actions
- [ ] Metadata (name, description, version, tags)
```

### 4. Create Edit Plan Document

**Initialize the edit plan tracking file:**

```markdown
---
mode: edit
originalAgent: "{agent-file-path}"
agentName: "{agent-name}"
agentType: "{simple|expert|module}"
editSessionDate: "{YYYY-MM-DD}"
stepsCompleted:
  - e-01-load-existing.md
---

# Edit Plan: {agent-name}

## Original Agent Snapshot

**File:** {agent-file-path}
**Type:** {simple|expert|module}
**Version:** {version}

### Current Persona

{full persona text or truncated if very long}

### Current Commands

{list all commands with names and descriptions}

### Current Metadata

{all metadata fields}

---

## Edits Planned

_This section will be populated in subsequent steps_

---

## Edits Applied

_This section will track completed edits_
```

Write to `{editPlan}`.

### 5. Present MENU OPTIONS

Display: "**Is this the correct agent to edit?** [C] Yes, Continue to Discovery"

#### Menu Handling Logic:

- IF C: Save content to {editPlan}, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#5-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [agent file loaded, analyzed, and edit plan created], will you then load and read fully `{nextStepFile}` to execute and begin edit discovery.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Agent file loaded successfully
- YAML structure parsed correctly
- Edit plan document created with agent snapshot
- User has clear understanding of current agent structure
- Menu presented and user input handled correctly

### ❌ SYSTEM FAILURE:

- Failed to load entire exist agent file (and potential sidecar content)
- Invalid YAML format that prevents parsing
- Edit plan not created
- Proceeding without user confirmation of loaded agent

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
