---
name: 'step-v-04-brief-coverage-validation'
description: 'Product Brief Coverage Check - Validate PRD covers all content from Product Brief (if used as input)'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-05-measurability-validation.md'
prdFile: '{prd_file_path}'
productBrief: '{product_brief_path}'
validationReportPath: '{validation_report_path}'
---

# Step 4: Product Brief Coverage Validation

## STEP GOAL:

Validate that PRD covers all content from Product Brief (if brief was used as input), mapping brief content to PRD sections and identifying gaps.

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
- ✅ We engage in systematic validation, not collaborative dialogue
- ✅ You bring analytical rigor and traceability expertise
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on Product Brief coverage (conditional on brief existence)
- 🚫 FORBIDDEN to validate other aspects in this step
- 💬 Approach: Systematic mapping and gap analysis
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Check if Product Brief exists in input documents
- 💬 If no brief: Skip this check and report "N/A - No Product Brief"
- 🎯 If brief exists: Map brief content to PRD sections
- 💾 Append coverage findings to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: PRD file, input documents from step 1, validation report
- Focus: Product Brief coverage only (conditional)
- Limits: Don't validate other aspects, conditional execution
- Dependencies: Step 1 completed - input documents loaded

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Check for Product Brief

Check if Product Brief was loaded in step 1's inputDocuments:

**IF no Product Brief found:**
Append to validation report:
```markdown
## Product Brief Coverage

**Status:** N/A - No Product Brief was provided as input
```

Display: "**Product Brief Coverage: Skipped** (No Product Brief provided)

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile}

**IF Product Brief exists:** Continue to step 2 below

### 2. Attempt Sub-Process Validation

**Try to use Task tool to spawn a subprocess:**

"Perform Product Brief coverage validation:

1. Load the Product Brief
2. Extract key content:
   - Vision statement
   - Target users/personas
   - Problem statement
   - Key features
   - Goals/objectives
   - Differentiators
   - Constraints
3. For each item, search PRD for corresponding coverage
4. Classify coverage: Fully Covered / Partially Covered / Not Found / Intentionally Excluded
5. Note any gaps with severity: Critical / Moderate / Informational

Return structured coverage map with classifications."

### 3. Graceful Degradation (if Task tool unavailable)

If Task tool unavailable, perform analysis directly:

**Extract from Product Brief:**
- Vision: What is this product?
- Users: Who is it for?
- Problem: What problem does it solve?
- Features: What are the key capabilities?
- Goals: What are the success criteria?
- Differentiators: What makes it unique?

**For each item, search PRD:**
- Scan Executive Summary for vision
- Check User Journeys or user personas
- Look for problem statement
- Review Functional Requirements for features
- Check Success Criteria section
- Search for differentiators

**Classify coverage:**
- **Fully Covered:** Content present and complete
- **Partially Covered:** Content present but incomplete
- **Not Found:** Content missing from PRD
- **Intentionally Excluded:** Content explicitly out of scope

### 4. Assess Coverage and Severity

**For each gap (Partially Covered or Not Found):**
- Is this Critical? (Core vision, primary users, main features)
- Is this Moderate? (Secondary features, some goals)
- Is this Informational? (Nice-to-have features, minor details)

**Note:** Some exclusions may be intentional (valid scoping decisions)

### 5. Report Coverage Findings to Validation Report

Append to validation report:

```markdown
## Product Brief Coverage

**Product Brief:** {brief_file_name}

### Coverage Map

**Vision Statement:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: Note severity and specific missing content]

**Target Users:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: Note severity and specific missing content]

**Problem Statement:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: Note severity and specific missing content]

**Key Features:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: List specific features with severity]

**Goals/Objectives:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: Note severity and specific missing content]

**Differentiators:** [Fully/Partially/Not Found/Intentionally Excluded]
[If gap: Note severity and specific missing content]

### Coverage Summary

**Overall Coverage:** [percentage or qualitative assessment]
**Critical Gaps:** [count] [list if any]
**Moderate Gaps:** [count] [list if any]
**Informational Gaps:** [count] [list if any]

**Recommendation:**
[If critical gaps exist] "PRD should be revised to cover critical Product Brief content."
[If moderate gaps] "Consider addressing moderate gaps for complete coverage."
[If minimal gaps] "PRD provides good coverage of Product Brief content."
```

### 6. Display Progress and Auto-Proceed

Display: "**Product Brief Coverage Validation Complete**

Overall Coverage: {assessment}

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile} (step-v-05-measurability-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Checked for Product Brief existence correctly
- If no brief: Reported "N/A" and skipped gracefully
- If brief exists: Mapped all key brief content to PRD sections
- Coverage classified appropriately (Fully/Partially/Not Found/Intentionally Excluded)
- Severity assessed for gaps (Critical/Moderate/Informational)
- Findings reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not checking for brief existence before attempting validation
- If brief exists: not mapping all key content areas
- Missing coverage classifications
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** Product Brief coverage is conditional - skip if no brief, validate thoroughly if brief exists. Always auto-proceed.
