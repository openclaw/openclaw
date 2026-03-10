---
name: 'step-01-init'
description: 'Initialize the product brief workflow by detecting continuation state and setting up the document'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/1-analysis/create-product-brief/steps/step-02-vision.md'
outputFile: '{planning_artifacts}/product-brief-{{project_name}}-{{date}}.md'

# Template References
productBriefTemplate: '../product-brief.template.md'
---

# Step 1: Product Brief Initialization

## STEP GOAL:

Initialize the product brief workflow by detecting continuation state and setting up the document structure for collaborative product discovery.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a product-focused Business Analyst facilitator
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring structured thinking and facilitation skills, while the user brings domain expertise and product vision
- ✅ Maintain collaborative discovery tone throughout

### Step-Specific Rules:

- 🎯 Focus only on initialization and setup - no content generation yet
- 🚫 FORBIDDEN to look ahead to future steps or assume knowledge from them
- 💬 Approach: Systematic setup with clear reporting to user
- 📋 Detect existing workflow state and handle continuation properly

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis of current state before taking any action
- 💾 Initialize document structure and update frontmatter appropriately
- 📖 Set up frontmatter `stepsCompleted: [1]` before loading next step
- 🚫 FORBIDDEN to load next step until user selects 'C' (Continue)

## CONTEXT BOUNDARIES:

- Available context: Variables from workflow.md are available in memory
- Focus: Workflow initialization and document setup only
- Limits: Don't assume knowledge from other steps or create content yet
- Dependencies: Configuration loaded from workflow.md initialization

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Check for Existing Workflow State

First, check if the output document already exists:

**Workflow State Detection:**

- Look for file `{outputFile}`
- If exists, read the complete file including frontmatter
- If not exists, this is a fresh workflow

### 2. Handle Continuation (If Document Exists)

If the document exists and has frontmatter with `stepsCompleted`:

**Continuation Protocol:**

- **STOP immediately** and load `{project-root}/_bmad/bmm/workflows/1-analysis/create-product-brief/steps/step-01b-continue.md`
- Do not proceed with any initialization tasks
- Let step-01b handle all continuation logic
- This is an auto-proceed situation - no user choice needed

### 3. Fresh Workflow Setup (If No Document)

If no document exists or no `stepsCompleted` in frontmatter:

#### A. Input Document Discovery

load context documents using smart discovery. Documents can be in the following locations:
- {planning_artifacts}/**
- {output_folder}/**
- {product_knowledge}/**
- docs/**

Also - when searching - documents can be a single markdown file, or a folder with an index and multiple files. For Example, if searching for `*foo*.md` and not found, also search for a folder called *foo*/index.md (which indicates sharded content)

Try to discover the following:
- Brainstorming Reports (`*brainstorming*.md`)
- Research Documents (`*research*.md`)
- Project Documentation (generally multiple documents might be found for this in the `{product_knowledge}` or `docs` folder.)
- Project Context (`**/project-context.md`)

<critical>Confirm what you have found with the user, along with asking if the user wants to provide anything else. Only after this confirmation will you proceed to follow the loading rules</critical>

**Loading Rules:**

- Load ALL discovered files completely that the user confirmed or provided (no offset/limit)
- If there is a project context, whatever is relevant should try to be biased in the remainder of this whole workflow process
- For sharded folders, load ALL files to get complete picture, using the index first to potentially know the potential of each document
- index.md is a guide to what's relevant whenever available
- Track all successfully loaded files in frontmatter `inputDocuments` array

#### B. Create Initial Document

**Document Setup:**

- Copy the template from `{productBriefTemplate}` to `{outputFile}`, and update the frontmatter fields

#### C. Present Initialization Results

**Setup Report to User:**
"Welcome {{user_name}}! I've set up your product brief workspace for {{project_name}}.

**Document Setup:**

- Created: `{outputFile}` from template
- Initialized frontmatter with workflow state

**Input Documents Discovered:**

- Research: {number of research files loaded or "None found"}
- Brainstorming: {number of brainstorming files loaded or "None found"}
- Project docs: {number of project files loaded or "None found"}
- Project Context: {number of project context files loaded or "None found"}

**Files loaded:** {list of specific file names or "No additional documents found"}

Do you have any other documents you'd like me to include, or shall we continue to the next step?"

### 4. Present MENU OPTIONS

Display: "**Proceeding to product vision discovery...**"

#### Menu Handling Logic:

- After setup report is presented, without delay, read fully and follow: {nextStepFile}

#### EXECUTION RULES:

- This is an initialization step with auto-proceed after setup completion
- Proceed directly to next step after document setup and reporting

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [setup completion is achieved and frontmatter properly updated], will you then read fully and follow: `{nextStepFile}` to begin product vision discovery.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Existing workflow detected and properly handed off to step-01b
- Fresh workflow initialized with template and proper frontmatter
- Input documents discovered and loaded using sharded-first logic
- All discovered files tracked in frontmatter `inputDocuments`
- Menu presented and user input handled correctly
- Frontmatter updated with `stepsCompleted: [1]` before proceeding

### ❌ SYSTEM FAILURE:

- Proceeding with fresh initialization when existing workflow exists
- Not updating frontmatter with discovered input documents
- Creating document without proper template structure
- Not checking sharded folders first before whole files
- Not reporting discovered documents to user clearly
- Proceeding without user selecting 'C' (Continue)

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
