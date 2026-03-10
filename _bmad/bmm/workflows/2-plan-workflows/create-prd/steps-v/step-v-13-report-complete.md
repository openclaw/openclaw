---
name: 'step-v-13-report-complete'
description: 'Validation Report Complete - Finalize report, summarize findings, present to user, offer next steps'

# File references (ONLY variables used in this step)
validationReportPath: '{validation_report_path}'
prdFile: '{prd_file_path}'
---

# Step 13: Validation Report Complete

## STEP GOAL:

Finalize validation report, summarize all findings from steps 1-12, present summary to user conversationally, and offer actionable next steps.

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
- ✅ You bring synthesis and summary expertise
- ✅ This is the FINAL step - requires user interaction

### Step-Specific Rules:

- 🎯 Focus ONLY on summarizing findings and presenting options
- 🚫 FORBIDDEN to perform additional validation
- 💬 Approach: Conversational summary with clear next steps
- 🚪 This is the final step - no next step after this

## EXECUTION PROTOCOLS:

- 🎯 Load complete validation report
- 🎯 Summarize all findings from steps 1-12
- 🎯 Update report frontmatter with final status
- 💬 Present summary to user conversationally
- 💬 Offer menu options for next actions
- 🚫 FORBIDDEN to proceed without user selection

## CONTEXT BOUNDARIES:

- Available context: Complete validation report with findings from all validation steps
- Focus: Summary and presentation only (no new validation)
- Limits: Don't add new findings, just synthesize existing
- Dependencies: Steps 1-12 completed - all validation checks done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Complete Validation Report

Read the entire validation report from {validationReportPath}

Extract all findings from:
- Format Detection (Step 2)
- Parity Analysis (Step 2B, if applicable)
- Information Density (Step 3)
- Product Brief Coverage (Step 4)
- Measurability (Step 5)
- Traceability (Step 6)
- Implementation Leakage (Step 7)
- Domain Compliance (Step 8)
- Project-Type Compliance (Step 9)
- SMART Requirements (Step 10)
- Holistic Quality (Step 11)
- Completeness (Step 12)

### 2. Update Report Frontmatter with Final Status

Update validation report frontmatter:

```yaml
---
validationTarget: '{prd_path}'
validationDate: '{current_date}'
inputDocuments: [list of documents]
validationStepsCompleted: ['step-v-01-discovery', 'step-v-02-format-detection', 'step-v-03-density-validation', 'step-v-04-brief-coverage-validation', 'step-v-05-measurability-validation', 'step-v-06-traceability-validation', 'step-v-07-implementation-leakage-validation', 'step-v-08-domain-compliance-validation', 'step-v-09-project-type-validation', 'step-v-10-smart-validation', 'step-v-11-holistic-quality-validation', 'step-v-12-completeness-validation']
validationStatus: COMPLETE
holisticQualityRating: '{rating from step 11}'
overallStatus: '{Pass/Warning/Critical based on all findings}'
---
```

### 3. Create Summary of Findings

**Overall Status:**
- Determine from all validation findings
- **Pass:** All critical checks pass, minor warnings acceptable
- **Warning:** Some issues found but PRD is usable
- **Critical:** Major issues that prevent PRD from being fit for purpose

**Quick Results Table:**
- Format: [classification]
- Information Density: [severity]
- Measurability: [severity]
- Traceability: [severity]
- Implementation Leakage: [severity]
- Domain Compliance: [status]
- Project-Type Compliance: [compliance score]
- SMART Quality: [percentage]
- Holistic Quality: [rating/5]
- Completeness: [percentage]

**Critical Issues:** List from all validation steps
**Warnings:** List from all validation steps
**Strengths:** List positives from all validation steps

**Holistic Quality Rating:** From step 11
**Top 3 Improvements:** From step 11

**Recommendation:** Based on overall status

### 4. Present Summary to User Conversationally

Display:

"**✓ PRD Validation Complete**

**Overall Status:** {Pass/Warning/Critical}

**Quick Results:**
{Present quick results table with key findings}

**Critical Issues:** {count or "None"}
{If any, list briefly}

**Warnings:** {count or "None"}
{If any, list briefly}

**Strengths:**
{List key strengths}

**Holistic Quality:** {rating}/5 - {label}

**Top 3 Improvements:**
1. {Improvement 1}
2. {Improvement 2}
3. {Improvement 3}

**Recommendation:**
{Based on overall status:
- Pass: "PRD is in good shape. Address minor improvements to make it great."
- Warning: "PRD is usable but has issues that should be addressed. Review warnings and improve where needed."
- Critical: "PRD has significant issues that should be fixed before use. Focus on critical issues above."}

**What would you like to do next?**"

### 5. Present MENU OPTIONS

Display:

**[R] Review Detailed Findings** - Walk through validation report section by section
**[E] Use Edit Workflow** - Use validation report with Edit workflow for systematic improvements
**[F] Fix Simpler Items** - Immediate fixes for simple issues (anti-patterns, leakage, missing headers)
**[X] Exit** - Exit and Suggest Next Steps.

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- Only proceed based on user selection

#### Menu Handling Logic:

- **IF R (Review Detailed Findings):**
  - Walk through validation report section by section
  - Present findings from each validation step
  - Allow user to ask questions
  - After review, return to menu

- **IF E (Use Edit Workflow):**
  - Explain: "The Edit workflow (steps-e/) can use this validation report to systematically address issues. Edit mode will guide you through discovering what to edit, reviewing the PRD, and applying targeted improvements."
  - Offer: "Would you like to launch Edit mode now? It will help you fix validation findings systematically."
  - If yes: Read fully and follow: steps-e/step-e-01-discovery.md
  - If no: Return to menu

- **IF F (Fix Simpler Items):**
  - Offer immediate fixes for:
    - Template variables (fill in with appropriate content)
    - Conversational filler (remove wordy phrases)
    - Implementation leakage (remove technology names from FRs/NFRs)
    - Missing section headers (add ## headers)
  - Ask: "Which simple fixes would you like me to make?"
  - If user specifies fixes, make them and update validation report
  - Return to menu

- **IF X (Exit):**
  - Display: "**Validation Report Saved:** {validationReportPath}"
  - Display: "**Summary:** {overall status} - {recommendation}"
  - PRD Validation complete. Read fully and follow: `{project-root}/_bmad/core/tasks/help.md`

- **IF Any other:** Help user, then redisplay menu

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Complete validation report loaded successfully
- All findings from steps 1-12 summarized
- Report frontmatter updated with final status
- Overall status determined correctly (Pass/Warning/Critical)
- Quick results table presented
- Critical issues, warnings, and strengths listed
- Holistic quality rating included
- Top 3 improvements presented
- Clear recommendation provided
- Menu options presented with clear explanations
- User can review findings, get help, or exit

### ❌ SYSTEM FAILURE:

- Not loading complete validation report
- Missing summary of findings
- Not updating report frontmatter
- Not determining overall status
- Missing menu options
- Unclear next steps

**Master Rule:** User needs clear summary and actionable next steps. Edit workflow is best for complex issues; immediate fixes available for simpler ones.
