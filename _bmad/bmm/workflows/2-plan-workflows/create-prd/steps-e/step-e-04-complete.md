---
name: 'step-e-04-complete'
description: 'Complete & Validate - Present options for next steps including full validation'

# File references (ONLY variables used in this step)
prdFile: '{prd_file_path}'
validationWorkflow: '../steps-v/step-v-01-discovery.md'
---

# Step E-4: Complete & Validate

## STEP GOAL:

Present summary of completed edits and offer next steps including seamless integration with validation workflow.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 ALWAYS generate content WITH user input/approval
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a Validation Architect and PRD Improvement Specialist
- ✅ If you already have been given communication or persona patterns, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring synthesis and summary expertise
- ✅ User chooses next actions

### Step-Specific Rules:

- 🎯 Focus ONLY on presenting summary and options
- 🚫 FORBIDDEN to make additional changes
- 💬 Approach: Clear, concise summary with actionable options
- 🚪 This is the final edit step - no more edits

## EXECUTION PROTOCOLS:

- 🎯 Compile summary of all changes made
- 🎯 Present options clearly with expected outcomes
- 📖 Route to validation if user chooses
- 🚫 FORBIDDEN to proceed without user selection

## CONTEXT BOUNDARIES:

- Available context: Updated PRD file, edit history from step e-03
- Focus: Summary and options only (no more editing)
- Limits: Don't make changes, just present options
- Dependencies: Step e-03 completed - all edits applied

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Compile Edit Summary

From step e-03 change execution, compile:

**Changes Made:**
- Sections added: {list with names}
- Sections updated: {list with names}
- Content removed: {list}
- Structure changes: {description}

**Edit Details:**
- Total sections affected: {count}
- Mode: {restructure/targeted/both}
- Priority addressed: {Critical/High/Medium/Low}

**PRD Status:**
- Format: {BMAD Standard / BMAD Variant / Legacy (converted)}
- Completeness: {assessment}
- Ready for: {downstream use cases}

### 2. Present Completion Summary

Display:

"**✓ PRD Edit Complete**

**Updated PRD:** {prd_file_path}

**Changes Summary:**
{Present bulleted list of major changes}

**Edit Mode:** {mode}
**Sections Modified:** {count}

**PRD Format:** {format}

**PRD is now ready for:**
- Downstream workflows (UX Design, Architecture)
- Validation to ensure quality
- Production use

**What would you like to do next?**"

### 3. Present MENU OPTIONS

Display:

**[V] Run Full Validation** - Execute complete validation workflow (steps-v) to verify PRD quality
**[E] Edit More** - Make additional edits to the PRD
**[S] Summary** - End with detailed summary of changes
**[X] Exit** - Exit edit workflow

#### EXECUTION RULES:

- ALWAYS halt and wait for user input
- Only proceed based on user selection

#### Menu Handling Logic:

- **IF V (Run Full Validation):**
  - Display: "**Starting Validation Workflow**"
  - Display: "This will run all 13 validation checks on the updated PRD."
  - Display: "Preparing to validate: {prd_file_path}"
  - Display: "**Proceeding to validation...**"
  - Read fully and follow: {validationWorkflow} (steps-v/step-v-01-discovery.md)
  - Note: This hands off to the validation workflow which will run its complete 13-step process

- **IF E (Edit More):**
  - Display: "**Additional Edits**"
  - Ask: "What additional edits would you like to make?"
  - Accept input, then display: "**Returning to edit step...**"
  - Read fully and follow: step-e-03-edit.md again

- **IF S (Summary):**
  - Display detailed summary including:
    - Complete list of all changes made
    - Before/after comparison (key improvements)
    - Recommendations for next steps
  - Display: "**Edit Workflow Complete**"
  - Exit

- **IF X (Exit):**
  - Display summary
  - Display: "**Edit Workflow Complete**"
  - Exit

- **IF Any other:** Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Complete edit summary compiled accurately
- All changes clearly documented
- Options presented with clear expectations
- Validation option seamlessly integrates with steps-v workflow
- User can validate, edit more, or exit
- Clean handoff to validation workflow (if chosen)
- Edit workflow completes properly

### ❌ SYSTEM FAILURE:

- Missing changes in summary
- Not offering validation option
- Not documenting completion properly
- No clear handoff to validation workflow

**Master Rule:** Edit workflow seamlessly integrates with validation. User can edit → validate → edit again → validate again in iterative improvement cycle.
