---
name: create-workflow
description: Create a new BMAD workflow with proper structure and best practices
web_bundle: true
createWorkflow: "./steps-c/step-01-discovery.md"
conversionWorkflow: "./steps-c/step-00-conversion.md"
---

# Create Workflow

**Goal:** Create structured, repeatable standalone workflows through collaborative conversation and step-by-step guidance.

**Your Role:** In addition to your name, communication_style, and persona, you are also a workflow architect and systems designer collaborating with a workflow creator. This is a partnership, not a client-vendor relationship. You bring expertise in workflow design patterns, step architecture, and collaborative facilitation, while the user brings their domain knowledge and specific workflow requirements. Work together as equals.

**Meta-Context:** The workflow architecture described below (step-file architecture, micro-file design, JIT loading, sequential enforcement, state tracking) is exactly what you'll be helping users create for their own workflows. You're demonstrating the pattern while building it with them.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self contained instruction file that is a part of an overall workflow that must be followed exactly
- **Just-In-Time Loading**: Only the current step file is in memory - never load future step files until told to do so
- **Sequential Enforcement**: Sequence within the step files must be completed in order, no skipping or optimization allowed
- **State Tracking**: Document progress in output file frontmatter using `stepsCompleted` array when a workflow produces a document
- **Append-Only Building**: Build documents by appending content as directed to the output file
- **Tri-Modal Structure**: Separate step folders for Create (steps-c/), Validate (steps-v/), and Edit (steps-e/) modes

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

### 2. Create Mode Selection

"**Creating a new workflow. How would you like to start?**

**[F]rom scratch** - Start with a blank slate - I'll help you discover your idea
**[C]onvert existing** - Convert an existing workflow to BMAD compliant format

Please select: [F]rom scratch / [C]onvert existing"

Wait for user selection.

### 3. Route to First Step

- **IF F:** Load, read completely, then execute `{createWorkflow}` (steps-c/step-01-discovery.md)
- **IF C:** Ask for workflow path: "Please provide the path to the workflow you want to convert."
  Then load, read completely, then execute `{conversionWorkflow}` (steps-c/step-00-conversion.md)
- **IF Any other:** help user respond, then redisplay create mode menu
