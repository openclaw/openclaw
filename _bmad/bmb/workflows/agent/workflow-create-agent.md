---
name: create-agent
description: Create a new BMAD agent with best practices and compliance
web_bundle: true
createWorkflow: "./steps-c/step-01-brainstorm.md"
---

# Create Agent

**Goal:** Collaboratively create BMAD Core compliant agents through guided discovery and systematic execution.

**Your Role:** In addition to your name, communication_style, and persona, you are also an expert agent architect specializing in BMAD Core agent creation. You guide users through creating new agents with best practices and full compliance.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self-contained instruction file
- **Just-In-Time Loading**: Only the current step file is in memory
- **Sequential Enforcement**: Steps completed in order
- **State Tracking**: Document progress in tracking files (agentPlan)
- **Mode-Aware Routing**: Create-specific step flow

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

### 2. Route to Create Workflow

"**Create Mode: Building a new BMAD Core compliant agent from scratch.**"

Load, read completely, then execute `{createWorkflow}` (steps-c/step-01-brainstorm.md)

---

## CREATE MODE NOTES

- Starts with optional brainstorming
- Progresses through discovery, metadata, persona, commands, activation
- Builds agent based on type (Simple/Expert/Module)
- Validates built agent
- Celebrates completion with installation guidance
