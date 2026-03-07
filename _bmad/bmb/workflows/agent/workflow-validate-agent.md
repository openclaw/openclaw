---
name: validate-agent
description: Validate existing BMAD agents and offer to improve deficiencies
web_bundle: true
validateWorkflow: "./steps-v/v-01-load-review.md"
---

# Validate Agent

**Goal:** Review existing BMAD Core compliant agents through systematic validation and generate comprehensive reports.

**Your Role:** In addition to your name, communication_style, and persona, you are also a validation specialist and quality assurance expert for BMAD Core agents. You conduct systematic reviews and provide actionable improvement recommendations.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self-contained instruction file
- **Just-In-Time Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Steps completed in order
- **State Tracking**: Document progress in tracking files (validationReport)
- **Mode-Aware Routing**: Validate-specific step flow

### Step Processing Rules

1. **READ COMPLETELY**: Always read the entire step file before taking any action
2. **FOLLOW SEQUENCE**: Execute numbered sections in order
3. **WAIT FOR INPUT**: Halt at menus and wait for user selection
4. **CHECK CONTINUATION**: Only proceed when user selects appropriate option
5. **SAVE STATE**: Update progress before loading next step
6. **LOAD NEXT**: When directed, load and execute the next step file

### Critical Rules

- 🛑 **NEVER** load multiple step files simultaneously
- 📖 **ALWAYS** read entire step file before execution
- 🚫 **NEVER** skip steps unless explicitly optional
- 💾 **ALWAYS** save progress and outputs
- 🎯 **ALWAYS** follow exact instructions in step files
- ⏸️ **ALWAYS** halt at menus and wait for input
- 📋 **NEVER** pre-load future steps

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

Load and read full config from `{project-root}/_bmad/bmb/config.yaml`:

- `project_name`, `user_name`, `communication_language`, `document_output_language`, `bmb_creations_output_folder`
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### 2. Route to Validate Workflow

"**Validate Mode: Reviewing an existing BMAD Core compliant agent.**"

Prompt for agent file path: "Which agent would you like to validate? Please provide the path to the `.agent.yaml` file."

Then load, read completely, and execute `{validateWorkflow}` (steps-v/v-01-load-review.md)

---

## VALIDATE MODE NOTES

- Loads existing agent
- Runs systematic validation (metadata, persona, menu, structure, sidecar)
- Generates comprehensive validation report
- Offers option to apply fixes if user desires
