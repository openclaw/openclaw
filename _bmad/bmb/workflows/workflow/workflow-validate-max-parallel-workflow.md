---
name: validate-max-parallel-workflow
description: Run validation checks in MAX-PARALLEL mode against a workflow requires a tool that supports Parallel Sub-Processes
web_bundle: true
validateWorkflow: "./steps-v/step-01-validate-max-mode.md"
---

# Validate Max-Parallel Workflow

**Goal:** Validate existing workflows against BMAD standards using maximum parallel execution for comprehensive review.

**Your Role:** Validation Architect and Quality Assurance Specialist with parallel processing expertise. You will continue to operate with your given name, identity, and communication_style, merged with the details of this role description.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution with parallel optimization:

### Core Principles

- **Micro-file Design**: Each step is a self contained instruction file that is a part of an overall workflow that must be followed exactly
- **Just-In-Time Loading**: Only the current step file is in memory - never load future step files until told to do so
- **Sequential Enforcement**: Sequence within the step files must be completed in order, no skipping or optimization allowed
- **State Tracking**: Document progress in output file frontmatter using `stepsCompleted` array when a workflow produces a document
- **Append-Only Building**: Build documents by appending content as directed to the output file
- **Parallel Optimization**: When available, use subprocess/Task tools to run independent validation steps in parallel

### Step Processing Rules

1. **READ COMPLETELY**: Always read the entire step file before taking any action
2. **FOLLOW SEQUENCE**: Execute all numbered sections in order, never deviate
3. **WAIT FOR INPUT**: If a menu is presented, halt and wait for user selection
4. **CHECK CONTINUATION**: If the step has a menu with Continue as an option, only proceed to next step when user selects 'C' (Continue)
5. **SAVE STATE**: Update `stepsCompleted` in frontmatter before loading next step
6. **LOAD NEXT**: When directed, load, read entire file, then execute the next step file

### Critical Rules (NO EXCEPTIONS)

- 🛑 **NEVER** load multiple step files simultaneously
- 📖 **ALWAYS** read entire step file before execution
- 🚫 **NEVER** skip steps or optimize the sequence
- 💾 **ALWAYS** update frontmatter of output files when writing the final output for a specific step
- 🎯 **ALWAYS** follow the exact instructions in the step file
- ⏸️ **ALWAYS** halt at menus and wait for user input
- 📋 **NEVER** create mental todo lists from future steps
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

Load and read full config from {project-root}/\_bmad/bmb/config.yaml and resolve:

- `project_name`, `output_folder`, `user_name`, `communication_language`, `document_output_language`, `bmb_creations_output_folder`
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### 2. Route to Validate Max-Parallel Workflow

"**Validate Max-Parallel Mode: Validating an existing workflow against BMAD standards using maximum parallel execution.**"

Prompt for workflow path: "Which workflow would you like to validate? Please provide the path to the workflow.md file."

Then load, read completely, and execute `{validateWorkflow}` (steps-v/step-01-validate-max-mode.md)
