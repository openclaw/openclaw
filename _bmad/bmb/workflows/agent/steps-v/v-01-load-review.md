---
name: "v-01-load-review"
description: "Load agent and initialize validation report"

nextStepFile: "./v-02a-validate-metadata.md"
validationReport: "{bmb_creations_output_folder}/validation-report-{agent-name}.md"
agentMetadata: ../data/agent-metadata.md

advancedElicitationTask: "{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml"
partyModeWorkflow: "{project-root}/_bmad/core/workflows/party-mode/workflow.md"
---

# Validate Step 1: Load Agent for Review

## STEP GOAL:

Load the existing agent file and initialize a validation report to track all findings.

## MANDATORY EXECUTION RULES:

- 📖 CRITICAL: Read the complete step file before taking any action
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Step-Specific Rules:

- 🎯 Load the complete agent file
- 📊 Create validation report tracking document
- 🚫 FORBIDDEN to proceed without user confirming correct agent

## EXECUTION PROTOCOLS:

- 🎯 Load the complete agent YAML file
- 📊 Parse and display agent summary
- 💾 Create validation report document
- 🚫 FORBIDDEN to proceed without user confirmation

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Agent File

Read the complete YAML from the agent file path provided by the user.

Check the metadata to determine agent configuration:

- **module**: `stand-alone` or module code (bmm, cis, bmgd, etc.)
- **hasSidecar**: `true` or `false`

### 2. Display Agent Summary

```markdown
## Agent to Validate: {agent-name}

**Configuration:** Agent {WITH|WITHOUT} sidecar
**hasSidecar:** {true|false}
**module:** {module-value}
**File:** {agent-file-path}

### Current Structure:

**Persona:** {character count} characters
**Commands:** {count} commands
**Critical Actions:** {count} actions (if hasSidecar: true)
**Sidecar:** {present|not present}
```

### 3. Create Validation Report

Initialize the validation report:

```markdown
---
agentName: "{agent-name}"
hasSidecar: { true|false }
module: "{module-value}"
agentFile: "{agent-file-path}"
validationDate: "{YYYY-MM-DD}"
stepsCompleted:
  - v-01-load-review.md
---

# Validation Report: {agent-name}

## Agent Overview

**Name:** {agent-name}
**hasSidecar:** {true|false}
**module:** {module-value}
**File:** {agent-file-path}

---

## Validation Findings

_This section will be populated by validation steps_
```

Write to `{validationReport}`.

### 4. Present MENU OPTIONS

Display: "**Is this the correct agent to validate and is it identified as the proper configuration?** [A] Advanced Elicitation [P] Party Mode [C] Yes, Begin Validation"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save to {validationReport}, then only then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#4-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [agent loaded and report created], will you then load and read fully `{nextStepFile}` to execute and begin validation.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Agent file loaded successfully
- Validation report created
- User confirmed correct agent

### ❌ SYSTEM FAILURE:

- Failed to load agent file
- Report not created
- Proceeded without user confirmation

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
