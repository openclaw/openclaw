---
name: 'step-v-12-completeness-validation'
description: 'Completeness Check - Final comprehensive completeness check before report generation'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-13-report-complete.md'
prdFile: '{prd_file_path}'
prdFrontmatter: '{prd_frontmatter}'
validationReportPath: '{validation_report_path}'
---

# Step 12: Completeness Validation

## STEP GOAL:

Final comprehensive completeness check - validate no template variables remain, each section has required content, section-specific completeness, and frontmatter is properly populated.

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
- ✅ You bring attention to detail and completeness verification
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on completeness verification
- 🚫 FORBIDDEN to validate quality (done in step 11) or other aspects
- 💬 Approach: Systematic checklist-style verification
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Check template completeness (no variables remaining)
- 🎯 Validate content completeness (each section has required content)
- 🎯 Validate section-specific completeness
- 🎯 Validate frontmatter completeness
- 💾 Append completeness matrix to validation report
- 📖 Display "Proceeding to final step..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: Complete PRD file, frontmatter, validation report
- Focus: Completeness verification only (final gate)
- Limits: Don't assess quality, don't pause for user input
- Dependencies: Steps 1-11 completed - all validation checks done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Attempt Sub-Process Validation

**Try to use Task tool to spawn a subprocess:**

"Perform completeness validation on this PRD - final gate check:

**1. Template Completeness:**
- Scan PRD for any remaining template variables
- Look for: {variable}, {{variable}}, {placeholder}, [placeholder], etc.
- List any found with line numbers

**2. Content Completeness:**
- Executive Summary: Has vision statement? ({key content})
- Success Criteria: All criteria measurable? ({metrics present})
- Product Scope: In-scope and out-of-scope defined? ({both present})
- User Journeys: User types identified? ({users listed})
- Functional Requirements: FRs listed with proper format? ({FRs present})
- Non-Functional Requirements: NFRs with metrics? ({NFRs present})

For each section: Is required content present? (Yes/No/Partial)

**3. Section-Specific Completeness:**
- Success Criteria: Each has specific measurement method?
- User Journeys: Cover all user types?
- Functional Requirements: Cover MVP scope?
- Non-Functional Requirements: Each has specific criteria?

**4. Frontmatter Completeness:**
- stepsCompleted: Populated?
- classification: Present (domain, projectType)?
- inputDocuments: Tracked?
- date: Present?

Return completeness matrix with status for each check."

**Graceful degradation (if no Task tool):**
- Manually scan for template variables
- Manually check each section for required content
- Manually verify frontmatter fields
- Build completeness matrix

### 2. Build Completeness Matrix

**Template Completeness:**
- Template variables found: count
- List if any found

**Content Completeness by Section:**
- Executive Summary: Complete / Incomplete / Missing
- Success Criteria: Complete / Incomplete / Missing
- Product Scope: Complete / Incomplete / Missing
- User Journeys: Complete / Incomplete / Missing
- Functional Requirements: Complete / Incomplete / Missing
- Non-Functional Requirements: Complete / Incomplete / Missing
- Other sections: [List completeness]

**Section-Specific Completeness:**
- Success criteria measurable: All / Some / None
- Journeys cover all users: Yes / Partial / No
- FRs cover MVP scope: Yes / Partial / No
- NFRs have specific criteria: All / Some / None

**Frontmatter Completeness:**
- stepsCompleted: Present / Missing
- classification: Present / Missing
- inputDocuments: Present / Missing
- date: Present / Missing

**Overall completeness:**
- Sections complete: X/Y
- Critical gaps: [list if any]

### 3. Report Completeness Findings to Validation Report

Append to validation report:

```markdown
## Completeness Validation

### Template Completeness

**Template Variables Found:** {count}
{If count > 0, list variables with line numbers}
{If count = 0, note: No template variables remaining ✓}

### Content Completeness by Section

**Executive Summary:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

**Success Criteria:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

**Product Scope:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

**User Journeys:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

**Functional Requirements:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

**Non-Functional Requirements:** [Complete/Incomplete/Missing]
{If incomplete or missing, note specific gaps}

### Section-Specific Completeness

**Success Criteria Measurability:** [All/Some/None] measurable
{If Some or None, note which criteria lack metrics}

**User Journeys Coverage:** [Yes/Partial/No] - covers all user types
{If Partial or No, note missing user types}

**FRs Cover MVP Scope:** [Yes/Partial/No]
{If Partial or No, note scope gaps}

**NFRs Have Specific Criteria:** [All/Some/None]
{If Some or None, note which NFRs lack specificity}

### Frontmatter Completeness

**stepsCompleted:** [Present/Missing]
**classification:** [Present/Missing]
**inputDocuments:** [Present/Missing]
**date:** [Present/Missing]

**Frontmatter Completeness:** {complete_fields}/4

### Completeness Summary

**Overall Completeness:** {percentage}% ({complete_sections}/{total_sections})

**Critical Gaps:** [count] [list if any]
**Minor Gaps:** [count] [list if any]

**Severity:** [Critical if template variables exist or critical sections missing, Warning if minor gaps, Pass if complete]

**Recommendation:**
[If Critical] "PRD has completeness gaps that must be addressed before use. Fix template variables and complete missing sections."
[If Warning] "PRD has minor completeness gaps. Address minor gaps for complete documentation."
[If Pass] "PRD is complete with all required sections and content present."
```

### 4. Display Progress and Auto-Proceed

Display: "**Completeness Validation Complete**

Overall Completeness: {percentage}% ({severity})

**Proceeding to final step...**"

Without delay, read fully and follow: {nextStepFile} (step-v-13-report-complete.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Scanned for template variables systematically
- Validated each section for required content
- Validated section-specific completeness (measurability, coverage, scope)
- Validated frontmatter completeness
- Completeness matrix built with all checks
- Severity assessed correctly
- Findings reported to validation report
- Auto-proceeds to final step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not scanning for template variables
- Missing section-specific completeness checks
- Not validating frontmatter
- Not building completeness matrix
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** Final gate to ensure document is complete before presenting findings. Template variables or critical gaps must be fixed.
