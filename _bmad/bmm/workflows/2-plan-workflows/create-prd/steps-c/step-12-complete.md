---
name: "step-12-complete"
description: "Complete the PRD workflow, update status files, and suggest next steps including validation"

# File References
outputFile: "{planning_artifacts}/prd.md"
validationFlow: "../steps-v/step-v-01-discovery.md"
---

# Step 12: Workflow Completion

**Final Step - Complete the PRD**

## MANDATORY EXECUTION RULES (READ FIRST):

- ✅ THIS IS A FINAL STEP - Workflow completion required
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action
- 🛑 NO content generation - this is a wrap-up step
- 📋 FINALIZE document and update workflow status
- 💬 FOCUS on completion, validation options, and next steps
- 🎯 UPDATE workflow status files with completion information
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 💾 Update the main workflow status file with completion information (if exists)
- 📖 Offer validation workflow options to user
- 🚫 DO NOT load additional steps after this one

## TERMINATION STEP PROTOCOLS:

- This is a FINAL step - workflow completion required
- Update workflow status file with finalized document
- Suggest validation and next workflow steps
- Mark workflow as complete in status tracking

## CONTEXT BOUNDARIES:

- Complete and polished PRD document is available from all previous steps
- Workflow frontmatter shows all completed steps including polish
- All collaborative content has been generated, saved, and optimized
- Focus on completion, validation options, and next steps

## YOUR TASK:

Complete the PRD workflow, update status files, offer validation options, and suggest next steps for the project.

## WORKFLOW COMPLETION SEQUENCE:

### 1. Announce Workflow Completion

Inform user that the PRD is complete and polished:

- Celebrate successful completion of comprehensive PRD
- Summarize all sections that were created
- Highlight that document has been polished for flow and coherence
- Emphasize document is ready for downstream work

### 2. Workflow Status Update

Update the main workflow status file if there is one:

- Load `{status_file}` from workflow configuration (if exists)
- Update workflow_status["prd"] = "{default_output_file}"
- Save file, preserving all comments and structure
- Mark current timestamp as completion time

### 3. Validation Workflow Options

Offer validation workflows to ensure PRD is ready for implementation:

**Available Validation Workflows:**

**Option 1: Check Implementation Readiness** (`{checkImplementationReadinessWorkflow}`)

- Validates PRD has all information needed for development
- Checks epic coverage completeness
- Reviews UX alignment with requirements
- Assesses epic quality and readiness
- Identifies gaps before architecture/design work begins

**When to use:** Before starting technical architecture or epic breakdown

**Option 2: Skip for Now**

- Proceed directly to next workflows (architecture, UX, epics)
- Validation can be done later if needed
- Some teams prefer to validate during architecture reviews

### 4. Suggest Next Workflows

PRD complete. Read fully and follow: `{project-root}/_bmad/core/tasks/help.md`

### 5. Final Completion Confirmation

- Confirm completion with user and summarize what has been accomplished
- Document now contains: Executive Summary, Success Criteria, User Journeys, Domain Requirements (if applicable), Innovation Analysis (if applicable), Project-Type Requirements, Functional Requirements (capability contract), Non-Functional Requirements, and has been polished for flow and coherence
- Ask if they'd like to run validation workflow or proceed to next workflows

## SUCCESS METRICS:

✅ PRD document contains all required sections and has been polished
✅ All collaborative content properly saved and optimized
✅ Workflow status file updated with completion information (if exists)
✅ Validation workflow options clearly presented
✅ Clear next step guidance provided to user
✅ Document quality validation completed
✅ User acknowledges completion and understands next options

## FAILURE MODES:

❌ Not updating workflow status file with completion information (if exists)
❌ Not offering validation workflow options
❌ Missing clear next step guidance for user
❌ Not confirming document completeness with user
❌ Workflow not properly marked as complete in status tracking (if applicable)
❌ User unclear about what happens next or what validation options exist

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## FINAL REMINDER to give the user:

The polished PRD serves as the foundation for all subsequent product development activities. All design, architecture, and development work should trace back to the requirements and vision documented in this PRD - update it also as needed as you continue planning.

**Congratulations on completing the Product Requirements Document for {{project_name}}!** 🎉
