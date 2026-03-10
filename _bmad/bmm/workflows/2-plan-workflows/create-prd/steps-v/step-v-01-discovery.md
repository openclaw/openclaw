---
name: 'step-v-01-discovery'
description: 'Document Discovery & Confirmation - Handle fresh context validation, confirm PRD path, discover input documents'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-02-format-detection.md'
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
prdPurpose: '../data/prd-purpose.md'
---

# Step 1: Document Discovery & Confirmation

## STEP GOAL:

Handle fresh context validation by confirming PRD path, discovering and loading input documents from frontmatter, and initializing the validation report.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation Architect and Quality Assurance Specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring systematic validation expertise and analytical rigor
- ✅ User brings domain knowledge and specific PRD context

### Step-Specific Rules:

- 🎯 Focus ONLY on discovering PRD and input documents, not validating yet
- 🚫 FORBIDDEN to perform any validation checks in this step
- 💬 Approach: Systematic discovery with clear reporting to user
- 🚪 This is the setup step - get everything ready for validation

## EXECUTION PROTOCOLS:

- 🎯 Discover and confirm PRD to validate
- 💾 Load PRD and all input documents from frontmatter
- 📖 Initialize validation report next to PRD
- 🚫 FORBIDDEN to load next step until user confirms setup

## CONTEXT BOUNDARIES:

- Available context: PRD path (user-specified or discovered), workflow configuration
- Focus: Document discovery and setup only
- Limits: Don't perform validation, don't skip discovery
- Dependencies: Configuration loaded from PRD workflow.md initialization

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load PRD Purpose and Standards

Load and read the complete file at:
`{prdPurpose}`

This file contains the BMAD PRD philosophy, standards, and validation criteria that will guide all validation checks. Internalize this understanding - it defines what makes a great BMAD PRD.

### 2. Discover PRD to Validate

**If PRD path provided as invocation parameter:**
- Use provided path

**If no PRD path provided, auto-discover:**
- Search `{planning_artifacts}` for files matching `*prd*.md`
- Also check for sharded PRDs: `{planning_artifacts}/*prd*/*.md`

**If exactly ONE PRD found:**
- Use it automatically
- Inform user: "Found PRD: {discovered_path} — using it for validation."

**If MULTIPLE PRDs found:**
- List all discovered PRDs with numbered options
- "I found multiple PRDs. Which one would you like to validate?"
- Wait for user selection

**If NO PRDs found:**
- "I couldn't find any PRD files in {planning_artifacts}. Please provide the path to the PRD file you want to validate."
- Wait for user to provide PRD path.

### 3. Validate PRD Exists and Load

Once PRD path is provided:

- Check if PRD file exists at specified path
- If not found: "I cannot find a PRD at that path. Please check the path and try again."
- If found: Load the complete PRD file including frontmatter

### 4. Extract Frontmatter and Input Documents

From the loaded PRD frontmatter, extract:

- `inputDocuments: []` array (if present)
- Any other relevant metadata (classification, date, etc.)

**If no inputDocuments array exists:**
Note this and proceed with PRD-only validation

### 5. Load Input Documents

For each document listed in `inputDocuments`:

- Attempt to load the document
- Track successfully loaded documents
- Note any documents that fail to load

**Build list of loaded input documents:**
- Product Brief (if present)
- Research documents (if present)
- Other reference materials (if present)

### 6. Ask About Additional Reference Documents

"**I've loaded the following documents from your PRD frontmatter:**

{list loaded documents with file names}

**Are there any additional reference documents you'd like me to include in this validation?**

These could include:
- Additional research or context documents
- Project documentation not tracked in frontmatter
- Standards or compliance documents
- Competitive analysis or benchmarks

Please provide paths to any additional documents, or type 'none' to proceed."

**Load any additional documents provided by user.**

### 7. Initialize Validation Report

Create validation report at: `{validationReportPath}`

**Initialize with frontmatter:**
```yaml
---
validationTarget: '{prd_path}'
validationDate: '{current_date}'
inputDocuments: [list of all loaded documents]
validationStepsCompleted: []
validationStatus: IN_PROGRESS
---
```

**Initial content:**
```markdown
# PRD Validation Report

**PRD Being Validated:** {prd_path}
**Validation Date:** {current_date}

## Input Documents

{list all documents loaded for validation}

## Validation Findings

[Findings will be appended as validation progresses]
```

### 8. Present Discovery Summary

"**Setup Complete!**

**PRD to Validate:** {prd_path}

**Input Documents Loaded:**
- PRD: {prd_name} ✓
- Product Brief: {count} {if count > 0}✓{else}(none found){/if}
- Research: {count} {if count > 0}✓{else}(none found){/if}
- Additional References: {count} {if count > 0}✓{else}(none){/if}

**Validation Report:** {validationReportPath}

**Ready to begin validation.**"

### 9. Present MENU OPTIONS

Display: **Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Format Detection

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- User can ask questions or add more documents - always respond and redisplay menu

#### Menu Handling Logic:

- IF A: Read fully and follow: {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Read fully and follow: {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Read fully and follow: {nextStepFile} to begin format detection
- IF user provides additional document: Load it, update report, redisplay summary
- IF Any other: help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- PRD path discovered and confirmed
- PRD file exists and loads successfully
- All input documents from frontmatter loaded
- Additional reference documents (if any) loaded
- Validation report initialized next to PRD
- User clearly informed of setup status
- Menu presented and user input handled correctly

### ❌ SYSTEM FAILURE:

- Proceeding with non-existent PRD file
- Not loading input documents from frontmatter
- Creating validation report in wrong location
- Proceeding without user confirming setup
- Not handling missing input documents gracefully

**Master Rule:** Complete discovery and setup BEFORE validation. This step ensures everything is in place for systematic validation checks.
