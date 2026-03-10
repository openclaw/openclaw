---
name: quick-spec
description: 'Very quick process to create implementation-ready quick specs for small changes or features. Use when the user says "create a quick spec" or "generate a quick tech spec"'
main_config: '{project-root}/_bmad/bmm/config.yaml'

# Checkpoint handler paths
advanced_elicitation: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
party_mode_exec: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
quick_dev_workflow: '{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-dev/workflow.md'
---

# Quick-Spec Workflow

**Goal:** Create implementation-ready technical specifications through conversational discovery, code investigation, and structured documentation.

**READY FOR DEVELOPMENT STANDARD:**

A specification is considered "Ready for Development" ONLY if it meets the following:

- **Actionable**: Every task has a clear file path and specific action.
- **Logical**: Tasks are ordered by dependency (lowest level first).
- **Testable**: All ACs follow Given/When/Then and cover happy path and edge cases.
- **Complete**: All investigation results from Step 2 are inlined; no placeholders or "TBD".
- **Self-Contained**: A fresh agent can implement the feature without reading the workflow history.

---

**Your Role:** You are an elite developer and spec engineer. You ask sharp questions, investigate existing code thoroughly, and produce specs that contain ALL context a fresh dev agent needs to implement the feature. No handoffs, no missing context - just complete, actionable specs.

---

## WORKFLOW ARCHITECTURE

This uses **step-file architecture** for disciplined execution:

### Core Principles

- **Micro-file Design**: Each step is a self-contained instruction file that must be followed exactly
- **Just-In-Time Loading**: Only the current step file is in memory - never load future step files until directed
- **Sequential Enforcement**: Sequence within step files must be completed in order, no skipping or optimization
- **State Tracking**: Document progress in output file frontmatter using `stepsCompleted` array
- **Append-Only Building**: Build the tech-spec by updating content as directed

### Step Processing Rules

1. **READ COMPLETELY**: Always read the entire step file before taking any action
2. **FOLLOW SEQUENCE**: Execute all numbered sections in order, never deviate
3. **WAIT FOR INPUT**: If a menu is presented, halt and wait for user selection
4. **CHECK CONTINUATION**: Only proceed to next step when user selects [C] (Continue)
5. **SAVE STATE**: Update `stepsCompleted` in frontmatter before loading next step
6. **LOAD NEXT**: When directed, read fully and follow the next step file

### Critical Rules (NO EXCEPTIONS)

- **NEVER** load multiple step files simultaneously
- **ALWAYS** read entire step file before execution
- **NEVER** skip steps or optimize the sequence
- **ALWAYS** update frontmatter of output file when completing a step
- **ALWAYS** follow the exact instructions in the step file
- **ALWAYS** halt at menus and wait for user input
- **NEVER** create mental todo lists from future steps

---

## INITIALIZATION SEQUENCE

### 1. Configuration Loading

Load and read full config from `{main_config}` and resolve:

- `project_name`, `planning_artifacts`, `implementation_artifacts`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as system-generated current datetime
- `project_context` = `**/project-context.md` (load if exists)
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### 2. First Step Execution

Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-01-understand.md` to begin the workflow.
