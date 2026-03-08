# BMAD Continuable Step 01 Init Template

This template provides the standard structure for step-01-init files that support workflow continuation. It includes logic to detect existing workflows and route to step-01b-continue.md for resumption.

Use this template when creating workflows that generate output documents and might take multiple sessions to complete.

<!-- TEMPLATE START -->

---

name: 'step-01-init'
description: 'Initialize the [workflow-type] workflow by detecting continuation state and creating output document'

<!-- Path Definitions -->

workflow\*path: `{project-root}/_bmad/[module-path]/workflows/[workflow-name]`

# File References (all use {variable} format in file)

thisStepFile: `./step-01-init.md`
nextStepFile: `./step-02-[step-name].md`
workflowFile: `{workflow_path}/workflow.md`
outputFile: `{output_folder}/[output-file-name]-{project_name}.md`
continueFile: `./step-01b-continue.md`
templateFile: `{workflow_path}/templates/[main-template].md`

# Template References

# This step doesn't use content templates, only the main template

---

# Step 1: Workflow Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator

### Role Reinforcement:

- ✅ You are a [specific role, e.g., "business analyst" or "technical architect"]
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring [your expertise], user brings [their expertise], and together we produce something better than we could on our own
- ✅ Maintain collaborative [adjective] tone throughout

### Step-Specific Rules:

- 🎯 Focus ONLY on initialization and setup
- 🚫 FORBIDDEN to look ahead to future steps
- 💬 Handle initialization professionally
- 🚪 DETECT existing workflow state and handle continuation properly

## EXECUTION PROTOCOLS:

- 🎯 Show analysis before taking any action
- 💾 Initialize document and update frontmatter
- 📖 Set up frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until setup is complete

## CONTEXT BOUNDARIES:

- Variables from workflow.md are available in memory
- Previous context = what's in output document + frontmatter
- Don't assume knowledge from other steps
- Input document discovery happens in this step

## STEP GOAL:

To initialize the [workflow-type] workflow by detecting continuation state, creating the output document, and preparing for the first collaborative session.

## INITIALIZATION SEQUENCE:

### 1. Check for Existing Workflow

First, check if the output document already exists:

- Look for file at `{output_folder}/[output-file-name]-{project_name}.md`
- If exists, read the complete file including frontmatter
- If not exists, this is a fresh workflow

### 2. Handle Continuation (If Document Exists)

If the document exists and has frontmatter with `stepsCompleted`:

- **STOP here** and load `./step-01b-continue.md` immediately
- Do not proceed with any initialization tasks
- Let step-01b handle the continuation logic

### 3. Handle Completed Workflow

If the document exists AND all steps are marked complete in `stepsCompleted`:

- Ask user: "I found an existing [workflow-output] from [date]. Would you like to:
  1. Create a new [workflow-output]
  2. Update/modify the existing [workflow-output]"
- If option 1: Create new document with timestamp suffix
- If option 2: Load step-01b-continue.md

### 4. Fresh Workflow Setup (If No Document)

If no document exists or no `stepsCompleted` in frontmatter:

#### A. Input Document Discovery

This workflow requires [describe input documents if any]:

**[Document Type] Documents (Optional):**

- Look for: `{output_folder}/*[pattern1]*.md`
- Look for: `{output_folder}/*[pattern2]*.md`
- If found, load completely and add to `inputDocuments` frontmatter

#### B. Create Initial Document

Copy the template from `{templateFile}` to `{output_folder}/[output-file-name]-{project_name}.md`

Initialize frontmatter with:

```yaml
---
stepsCompleted: [1]
lastStep: 'init'
inputDocuments: []
date: [current date]
user_name: { user_name }
[additional workflow-specific fields]
---
```

#### C. Show Welcome Message

"[Welcome message appropriate for workflow type]

Let's begin by [brief description of first activity]."

## ✅ SUCCESS METRICS:

- Document created from template (for fresh workflows)
- Frontmatter initialized with step 1 marked complete
- User welcomed to the process
- Ready to proceed to step 2
- OR continuation properly routed to step-01b-continue.md

## ❌ FAILURE MODES TO AVOID:

- Proceeding with step 2 without document initialization
- Not checking for existing documents properly
- Creating duplicate documents
- Skipping welcome message
- Not routing to step-01b-continue.md when needed

### 5. Present MENU OPTIONS

Display: **Proceeding to [next step description]...**

#### EXECUTION RULES:

- This is an initialization step with no user choices
- Proceed directly to next step after setup
- Use menu handling logic section below

#### Menu Handling Logic:

- After setup completion, immediately load, read entire file, then execute `{nextStepFile}` to begin [next step description]

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Document created from template (for fresh workflows)
- update frontmatter `stepsCompleted` to add 1 at the end of the array before loading next step
- Frontmatter initialized with `stepsCompleted: [1]`
- User welcomed to the process
- Ready to proceed to step 2
- OR existing workflow properly routed to step-01b-continue.md

### ❌ SYSTEM FAILURE:

- Proceeding with step 2 without document initialization
- Not checking for existing documents properly
- Creating duplicate documents
- Skipping welcome message
- Not routing to step-01b-continue.md when appropriate

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN initialization setup is complete and document is created (OR continuation is properly routed), will you then immediately load, read entire file, then execute `{nextStepFile}` to begin [next step description].

<!-- TEMPLATE END -->

## Customization Guidelines

When adapting this template for your specific workflow:

### 1. Update Placeholders

Replace bracketed placeholders with your specific values:

- `[workflow-type]` - e.g., "nutrition planning", "project requirements"
- `[module-path]` - e.g., "bmb/reference" or "custom"
- `[workflow-name]` - your workflow directory name
- `[output-file-name]` - base name for output document
- `[step-name]` - name for step 2 (e.g., "gather", "profile")
- `[main-template]` - name of your main template file
- `[workflow-output]` - what the workflow produces
- `[Document Type]` - type of input documents (if any)
- `[pattern1]`, `[pattern2]` - search patterns for input documents
- `[additional workflow-specific fields]` - any extra frontmatter fields needed

### 2. Customize Welcome Message

Adapt the welcome message in section 4C to match your workflow's tone and purpose.

### 3. Update Success Metrics

Ensure success metrics reflect your specific workflow requirements.

### 4. Adjust Next Step References

Update `{nextStepFile}` to point to your actual step 2 file.

## Implementation Notes

1. **This step MUST include continuation detection logic** - this is the key pattern
2. **Always include `continueFile` reference** in frontmatter
3. **Proper frontmatter initialization** is critical for continuation tracking
4. **Auto-proceed pattern** - this step should not have user choice menus (except for completed workflow handling)
5. **Template-based document creation** - ensures consistent output structure

## Integration with step-01b-continue.md

This template is designed to work seamlessly with the step-01b-template.md continuation step. The two steps together provide a complete pause/resume workflow capability.
