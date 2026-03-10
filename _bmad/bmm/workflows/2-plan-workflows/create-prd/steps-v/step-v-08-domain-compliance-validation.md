---
name: 'step-v-08-domain-compliance-validation'
description: 'Domain Compliance Validation - Validate domain-specific requirements are present for high-complexity domains'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-09-project-type-validation.md'
prdFile: '{prd_file_path}'
prdFrontmatter: '{prd_frontmatter}'
validationReportPath: '{validation_report_path}'
domainComplexityData: '../data/domain-complexity.csv'
---

# Step 8: Domain Compliance Validation

## STEP GOAL:

Validate domain-specific requirements are present for high-complexity domains (Healthcare, Fintech, GovTech, etc.), ensuring regulatory and compliance requirements are properly documented.

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
- ✅ You bring domain expertise and compliance knowledge
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on domain-specific compliance requirements
- 🚫 FORBIDDEN to validate other aspects in this step
- 💬 Approach: Conditional validation based on domain classification
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Check classification.domain from PRD frontmatter
- 💬 If low complexity (general): Skip detailed checks
- 🎯 If high complexity: Validate required special sections
- 💾 Append compliance findings to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: PRD file with frontmatter classification, validation report
- Focus: Domain compliance only (conditional on domain complexity)
- Limits: Don't validate other aspects, conditional execution
- Dependencies: Steps 2-7 completed - format and requirements validation done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Domain Complexity Data

Load and read the complete file at:
`{domainComplexityData}` (../data/domain-complexity.csv)

This CSV contains:
- Domain classifications and complexity levels (high/medium/low)
- Required special sections for each domain
- Key concerns and requirements for regulated industries

Internalize this data - it drives which domains require special compliance sections.

### 2. Extract Domain Classification

From PRD frontmatter, extract:
- `classification.domain` - what domain is this PRD for?

**If no domain classification found:**
Treat as "general" (low complexity) and proceed to step 4

### 2. Determine Domain Complexity

**Low complexity domains (skip detailed checks):**
- General
- Consumer apps (standard e-commerce, social, productivity)
- Content websites
- Business tools (standard)

**High complexity domains (require special sections):**
- Healthcare / Healthtech
- Fintech / Financial services
- GovTech / Public sector
- EdTech (educational records, accredited courses)
- Legal tech
- Other regulated domains

### 3. For High-Complexity Domains: Validate Required Special Sections

**Attempt subprocess validation:**

"Perform domain compliance validation for {domain}:

Based on {domain} requirements, check PRD for:

**Healthcare:**
- Clinical Requirements section
- Regulatory Pathway (FDA, HIPAA, etc.)
- Safety Measures
- HIPAA Compliance (data privacy, security)
- Patient safety considerations

**Fintech:**
- Compliance Matrix (SOC2, PCI-DSS, GDPR, etc.)
- Security Architecture
- Audit Requirements
- Fraud Prevention measures
- Financial transaction handling

**GovTech:**
- Accessibility Standards (WCAG 2.1 AA, Section 508)
- Procurement Compliance
- Security Clearance requirements
- Data residency requirements

**Other regulated domains:**
- Check for domain-specific regulatory sections
- Compliance requirements
- Special considerations

For each required section:
- Is it present in PRD?
- Is it adequately documented?
- Note any gaps

Return compliance matrix with presence/adequacy assessment."

**Graceful degradation (if no Task tool):**
- Manually check for required sections based on domain
- List present sections and missing sections
- Assess adequacy of documentation

### 5. For Low-Complexity Domains: Skip Detailed Checks

Append to validation report:
```markdown
## Domain Compliance Validation

**Domain:** {domain}
**Complexity:** Low (general/standard)
**Assessment:** N/A - No special domain compliance requirements

**Note:** This PRD is for a standard domain without regulatory compliance requirements.
```

Display: "**Domain Compliance Validation Skipped**

Domain: {domain} (low complexity)

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile}

### 6. Report Compliance Findings (High-Complexity Domains)

Append to validation report:

```markdown
## Domain Compliance Validation

**Domain:** {domain}
**Complexity:** High (regulated)

### Required Special Sections

**{Section 1 Name}:** [Present/Missing/Adequate]
{If missing or inadequate: Note specific gaps}

**{Section 2 Name}:** [Present/Missing/Adequate]
{If missing or inadequate: Note specific gaps}

[Continue for all required sections]

### Compliance Matrix

| Requirement | Status | Notes |
|-------------|--------|-------|
| {Requirement 1} | [Met/Partial/Missing] | {Notes} |
| {Requirement 2} | [Met/Partial/Missing] | {Notes} |
[... continue for all requirements]

### Summary

**Required Sections Present:** {count}/{total}
**Compliance Gaps:** {count}

**Severity:** [Critical if missing regulatory sections, Warning if incomplete, Pass if complete]

**Recommendation:**
[If Critical] "PRD is missing required domain-specific compliance sections. These are essential for {domain} products."
[If Warning] "Some domain compliance sections are incomplete. Strengthen documentation for full compliance."
[If Pass] "All required domain compliance sections are present and adequately documented."
```

### 7. Display Progress and Auto-Proceed

Display: "**Domain Compliance Validation Complete**

Domain: {domain} ({complexity})
Compliance Status: {status}

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile} (step-v-09-project-type-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Domain classification extracted correctly
- Complexity assessed appropriately
- Low complexity domains: Skipped with clear "N/A" documentation
- High complexity domains: All required sections checked
- Compliance matrix built with status for each requirement
- Severity assessed correctly
- Findings reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not checking domain classification before proceeding
- Performing detailed checks on low complexity domains
- For high complexity: missing required section checks
- Not building compliance matrix
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** Domain compliance is conditional. High-complexity domains require special sections - low complexity domains skip these checks.
