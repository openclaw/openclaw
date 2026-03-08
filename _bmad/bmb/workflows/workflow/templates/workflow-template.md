# BMAD Workflow Template

This template provides the standard structure for all BMAD workflow files. Copy and modify this template for each new workflow you create.

<!-- TEMPLATE START -->

---

name: [WORKFLOW_DISPLAY_NAME]
description: [Brief description of what this workflow accomplishes]
web_bundle: [true/false] # Set to true for inclusion in web bundle builds

---

# [WORKFLOW_DISPLAY_NAME]

**Goal:** [State the primary goal of this workflow in one clear sentence]

**Your Role:** In addition to your name, communication_style, and persona, you are also a [role] collaborating with [user type]. This is a partnership, not a client-vendor relationship. You bring [your expertise], while the user brings [their expertise]. Work together as equals.

## WORKFLOW ARCHITECTURE

### Core Principles

- **Micro-file Design**: Each step of the overall goal is a self contained instruction file that you will adhere too 1 file as directed at a time
- **Just-In-Time Loading**: Only 1 current step file will be loaded, read, and executed to completion - never load future step files until told to do so
- **Sequential Enforcement**: Sequence within the step files must be completed in order, no skipping or optimization allowed
- **State Tracking**: Document progress in output file frontmatter using `stepsCompleted` array when a workflow produces a document
- **Append-Only Building**: Build documents by appending content as directed to the output file

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

---

## INITIALIZATION SEQUENCE

### 1. Module Configuration Loading

Load and read full config from {project-root}/\_bmad/[MODULE FOLDER]/config.yaml and resolve:

- `project_name`, `output_folder`, `user_name`, `communication_language`, `document_output_language`, [MODULE VARS]

### 2. First Step EXECUTION

Load, read the full file and then execute [FIRST STEP FILE PATH] to begin the workflow.

<!-- TEMPLATE END -->

## How to Use This Template

### Step 1: Copy and Replace Placeholders

Copy the template above and replace:

- `[WORKFLOW_DISPLAY_NAME]` → Your workflow's display name
- `[MODULE FOLDER]` → Default is `core` unless this is for another module (such as bmm, cis, or another as directed by user)
- `[Brief description]` → One-sentence description
- `[true/false]` → Whether to include in web bundle
- `[role]` → AI's role in this workflow
- `[user type]` → Who the user is
- `[CONFIG_PATH]` → Path to config file (usually `bmm/config.yaml` or `bmb/config.yaml`)
- `[WORKFLOW_PATH]` → Path to your workflow folder
- `[MODULE VARS]` → Extra config variables available in a module configuration that the workflow would need to use

### Step 2: Create the Folder Structure

```
[workflow-folder]/
├── workflow.md          # This file
├── data/                # (Optional csv or other data files)
├── templates/           # template files for output
└── steps/
    ├── step-01-init.md
    ├── step-02-[name].md
    └── ...

```

### Step 3: Configure the Initialization Path

Update the last line of the workflow.md being created to replace [FIRST STEP FILE PATH] with the path to the actual first step file.

Example: Load, read the full file and then execute `./step-01-init.md` to begin the workflow.

### NOTE: You can View a real example of a perfect workflow.md file from the one you were executed from `../workflow.md`
