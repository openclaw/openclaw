---
name: 'step-v-10-smart-validation'
description: 'SMART Requirements Validation - Validate Functional Requirements meet SMART quality criteria'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-11-holistic-quality-validation.md'
prdFile: '{prd_file_path}'
validationReportPath: '{validation_report_path}'
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
---

# Step 10: SMART Requirements Validation

## STEP GOAL:

Validate Functional Requirements meet SMART quality criteria (Specific, Measurable, Attainable, Relevant, Traceable), ensuring high-quality requirements.

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
- ✅ You bring requirements engineering expertise and quality assessment
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on FR quality assessment using SMART framework
- 🚫 FORBIDDEN to validate other aspects in this step
- 💬 Approach: Score each FR on SMART criteria (1-5 scale)
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Extract all FRs from PRD
- 🎯 Score each FR on SMART criteria (Specific, Measurable, Attainable, Relevant, Traceable)
- 💾 Flag FRs with score < 3 in any category
- 📖 Append scoring table and suggestions to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: PRD file, validation report
- Focus: FR quality assessment only using SMART framework
- Limits: Don't validate NFRs or other aspects, don't pause for user input
- Dependencies: Steps 2-9 completed - comprehensive validation checks done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Extract All Functional Requirements

From the PRD's Functional Requirements section, extract:
- All FRs with their FR numbers (FR-001, FR-002, etc.)
- Count total FRs

### 2. Attempt Sub-Process Validation

**Try to use Task tool to spawn a subprocess:**

"Perform SMART requirements validation on these Functional Requirements:

{List all FRs}

**For each FR, score on SMART criteria (1-5 scale):**

**Specific (1-5):**
- 5: Clear, unambiguous, well-defined
- 3: Somewhat clear but could be more specific
- 1: Vague, ambiguous, unclear

**Measurable (1-5):**
- 5: Quantifiable metrics, testable
- 3: Partially measurable
- 1: Not measurable, subjective

**Attainable (1-5):**
- 5: Realistic, achievable with constraints
- 3: Probably achievable but uncertain
- 1: Unrealistic, technically infeasible

**Relevant (1-5):**
- 5: Clearly aligned with user needs and business objectives
- 3: Somewhat relevant but connection unclear
- 1: Not relevant, doesn't align with goals

**Traceable (1-5):**
- 5: Clearly traces to user journey or business objective
- 3: Partially traceable
- 1: Orphan requirement, no clear source

**For each FR with score < 3 in any category:**
- Provide specific improvement suggestions

Return scoring table with all FR scores and improvement suggestions for low-scoring FRs."

**Graceful degradation (if no Task tool):**
- Manually score each FR on SMART criteria
- Note FRs with low scores
- Provide improvement suggestions

### 3. Build Scoring Table

For each FR:
- FR number
- Specific score (1-5)
- Measurable score (1-5)
- Attainable score (1-5)
- Relevant score (1-5)
- Traceable score (1-5)
- Average score
- Flag if any category < 3

**Calculate overall FR quality:**
- Percentage of FRs with all scores ≥ 3
- Percentage of FRs with all scores ≥ 4
- Average score across all FRs and categories

### 4. Report SMART Findings to Validation Report

Append to validation report:

```markdown
## SMART Requirements Validation

**Total Functional Requirements:** {count}

### Scoring Summary

**All scores ≥ 3:** {percentage}% ({count}/{total})
**All scores ≥ 4:** {percentage}% ({count}/{total})
**Overall Average Score:** {average}/5.0

### Scoring Table

| FR # | Specific | Measurable | Attainable | Relevant | Traceable | Average | Flag |
|------|----------|------------|------------|----------|-----------|--------|------|
| FR-001 | {s1} | {m1} | {a1} | {r1} | {t1} | {avg1} | {X if any <3} |
| FR-002 | {s2} | {m2} | {a2} | {r2} | {t2} | {avg2} | {X if any <3} |
[Continue for all FRs]

**Legend:** 1=Poor, 3=Acceptable, 5=Excellent
**Flag:** X = Score < 3 in one or more categories

### Improvement Suggestions

**Low-Scoring FRs:**

**FR-{number}:** {specific suggestion for improvement}
[For each FR with score < 3 in any category]

### Overall Assessment

**Severity:** [Critical if >30% flagged FRs, Warning if 10-30%, Pass if <10%]

**Recommendation:**
[If Critical] "Many FRs have quality issues. Revise flagged FRs using SMART framework to improve clarity and testability."
[If Warning] "Some FRs would benefit from SMART refinement. Focus on flagged requirements above."
[If Pass] "Functional Requirements demonstrate good SMART quality overall."
```

### 5. Display Progress and Auto-Proceed

Display: "**SMART Requirements Validation Complete**

FR Quality: {percentage}% with acceptable scores ({severity})

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile} (step-v-11-holistic-quality-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- All FRs extracted from PRD
- Each FR scored on all 5 SMART criteria (1-5 scale)
- FRs with scores < 3 flagged for improvement
- Improvement suggestions provided for low-scoring FRs
- Scoring table built with all FR scores
- Overall quality assessment calculated
- Findings reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not scoring all FRs on all SMART criteria
- Missing improvement suggestions for low-scoring FRs
- Not building scoring table
- Not calculating overall quality metrics
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** FRs should be high-quality, not just present. SMART framework provides objective quality measure.
