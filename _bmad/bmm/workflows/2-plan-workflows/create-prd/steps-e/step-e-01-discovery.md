---
name: 'step-e-01-discovery'
description: 'Discovery & Understanding - Understand what user wants to edit and detect PRD format'

# File references (ONLY variables used in this step)
altStepFile: './step-e-01b-legacy-conversion.md'
prdPurpose: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/data/prd-purpose.md'
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step E-1: Discovery & Understanding

## STEP GOAL:

Understand what the user wants to edit in the PRD, detect PRD format/type, check for validation report guidance, and route appropriately.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation Architect and PRD Improvement Specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring analytical expertise and improvement guidance
- ✅ User brings domain knowledge and edit requirements

### Step-Specific Rules:

- 🎯 Focus ONLY on discovering user intent and PRD format
- 🚫 FORBIDDEN to make any edits yet
- 💬 Approach: Inquisitive and analytical, understanding before acting
- 🚪 This is a branch step - may route to legacy conversion

## EXECUTION PROTOCOLS:

- 🎯 Discover user's edit requirements
- 🎯 Auto-detect validation reports in PRD folder (use as guide)
- 🎯 Load validation report if provided (use as guide)
- 🎯 Detect PRD format (BMAD/legacy)
- 🎯 Route appropriately based on format
- 💾 Document discoveries for next step
- 🚫 FORBIDDEN to proceed without understanding requirements

## CONTEXT BOUNDARIES:

- Available context: PRD file to edit, optional validation report, auto-detected validation reports
- Focus: User intent discovery and format detection only
- Limits: Don't edit yet, don't validate yet
- Dependencies: None - this is first edit step

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load PRD Purpose Standards

Load and read the complete file at:
`{prdPurpose}` (data/prd-purpose.md)

This file defines what makes a great BMAD PRD. Internalize this understanding - it will guide improvement recommendations.

### 2. Discover PRD to Edit

"**PRD Edit Workflow**

Which PRD would you like to edit?

Please provide the path to the PRD file you want to edit."

**Wait for user to provide PRD path.**

### 3. Validate PRD Exists and Load

Once PRD path is provided:
- Check if PRD file exists at specified path
- If not found: "I cannot find a PRD at that path. Please check the path and try again."
- If found: Load the complete PRD file including frontmatter

### 4. Check for Existing Validation Report

**Check if validation report exists in the PRD folder:**

```bash
# Look for most recent validation report in the PRD folder
ls -t {prd_folder_path}/validation-report-*.md 2>/dev/null | head -1
```

**If validation report found:**

Display:
"**📋 Found Validation Report**

I found a validation report from {validation_date} in the PRD folder.

This report contains findings from previous validation checks and can help guide our edits to fix known issues.

**Would you like to:**
- **[U] Use validation report** - Load it to guide and prioritize edits
- **[S] Skip** - Proceed with manual edit discovery"

**Wait for user input.**

**IF U (Use validation report):**
- Load the validation report file
- Extract findings, issues, and improvement suggestions
- Note: "Validation report loaded - will use it to guide prioritized improvements"
- Continue to step 5

**IF S (Skip) or no validation report found:**
- Note: "Proceeding with manual edit discovery"
- Continue to step 5

**If no validation report found:**
- Note: "No validation report found in PRD folder"
- Continue to step 5 without asking user

### 5. Ask About Validation Report

"**Do you have a validation report to guide edits?**

If you've run the validation workflow on this PRD, I can use that report to guide improvements and prioritize changes.

Validation report path (or type 'none'):"

**Wait for user input.**

**If validation report path provided:**
- Load the validation report
- Extract findings, severity, improvement suggestions
- Note: "Validation report loaded - will use it to guide prioritized improvements"

**If no validation report:**
- Note: "Proceeding with manual edit discovery"
- Continue to step 6

### 6. Discover Edit Requirements

"**What would you like to edit in this PRD?**

Please describe the changes you want to make. For example:
- Fix specific issues (information density, implementation leakage, etc.)
- Add missing sections or content
- Improve structure and flow
- Convert to BMAD format (if legacy PRD)
- General improvements
- Other changes

**Describe your edit goals:**"

**Wait for user to describe their requirements.**

### 7. Detect PRD Format

Analyze the loaded PRD:

**Extract all ## Level 2 headers** from PRD

**Check for BMAD PRD core sections:**
1. Executive Summary
2. Success Criteria
3. Product Scope
4. User Journeys
5. Functional Requirements
6. Non-Functional Requirements

**Classify format:**
- **BMAD Standard:** 5-6 core sections present
- **BMAD Variant:** 3-4 core sections present, generally follows BMAD patterns
- **Legacy (Non-Standard):** Fewer than 3 core sections, does not follow BMAD structure

### 8. Route Based on Format and Context

**IF validation report provided OR PRD is BMAD Standard/Variant:**

Display: "**Edit Requirements Understood**

**PRD Format:** {classification}
{If validation report: "**Validation Guide:** Yes - will use validation report findings"}
**Edit Goals:** {summary of user's requirements}

**Proceeding to deep review and analysis...**"

Read fully and follow: next step (step-e-02-review.md)

**IF PRD is Legacy (Non-Standard) AND no validation report:**

Display: "**Format Detected:** Legacy PRD

This PRD does not follow BMAD standard structure (only {count}/6 core sections present).

**Your edit goals:** {user's requirements}

**How would you like to proceed?**"

Present MENU OPTIONS below for user selection

### 9. Present MENU OPTIONS (Legacy PRDs Only)

**[C] Convert to BMAD Format** - Convert PRD to BMAD standard structure, then apply your edits
**[E] Edit As-Is** - Apply your edits without converting the format
**[X] Exit** - Exit and review conversion options

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- Only proceed based on user selection

#### Menu Handling Logic:

- IF C (Convert): Read fully and follow: {altStepFile} (step-e-01b-legacy-conversion.md)
- IF E (Edit As-Is): Display "Proceeding with edits..." then load next step
- IF X (Exit): Display summary and exit
- IF Any other: help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- User's edit requirements clearly understood
- Auto-detected validation reports loaded and analyzed (when found)
- Manual validation report loaded and analyzed (if provided)
- PRD format detected correctly
- BMAD PRDs proceed directly to review step
- Legacy PRDs pause and present conversion options
- User can choose conversion path or edit as-is

### ❌ SYSTEM FAILURE:

- Not discovering user's edit requirements
- Not auto-detecting validation reports in PRD folder
- Not loading validation report when provided (auto or manual)
- Missing format detection
- Not pausing for legacy PRDs without guidance
- Auto-proceeding without understanding intent

**Master Rule:** Understand before editing. Detect format early so we can guide users appropriately. Auto-detect and use validation reports for prioritized improvements.
