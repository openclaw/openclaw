---
name: 'step-v-09-project-type-validation'
description: 'Project-Type Compliance Validation - Validate project-type specific requirements are properly documented'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-10-smart-validation.md'
prdFile: '{prd_file_path}'
prdFrontmatter: '{prd_frontmatter}'
validationReportPath: '{validation_report_path}'
projectTypesData: '../data/project-types.csv'
---

# Step 9: Project-Type Compliance Validation

## STEP GOAL:

Validate project-type specific requirements are properly documented - different project types (api_backend, web_app, mobile_app, etc.) have different required and excluded sections.

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
- ✅ You bring project type expertise and architectural knowledge
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on project-type compliance
- 🚫 FORBIDDEN to validate other aspects in this step
- 💬 Approach: Validate required sections present, excluded sections absent
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Check classification.projectType from PRD frontmatter
- 🎯 Validate required sections for that project type are present
- 🎯 Validate excluded sections for that project type are absent
- 💾 Append compliance findings to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: PRD file with frontmatter classification, validation report
- Focus: Project-type compliance only
- Limits: Don't validate other aspects, don't pause for user input
- Dependencies: Steps 2-8 completed - domain and requirements validation done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Load Project Types Data

Load and read the complete file at:
`{projectTypesData}` (../data/project-types.csv)

This CSV contains:
- Detection signals for each project type
- Required sections for each project type
- Skip/excluded sections for each project type
- Innovation signals

Internalize this data - it drives what sections must be present or absent for each project type.

### 2. Extract Project Type Classification

From PRD frontmatter, extract:
- `classification.projectType` - what type of project is this?

**Common project types:**
- api_backend
- web_app
- mobile_app
- desktop_app
- data_pipeline
- ml_system
- library_sdk
- infrastructure
- other

**If no projectType classification found:**
Assume "web_app" (most common) and note in findings

### 3. Determine Required and Excluded Sections from CSV Data

**From loaded project-types.csv data, for this project type:**

**Required sections:** (from required_sections column)
These MUST be present in the PRD

**Skip sections:** (from skip_sections column)
These MUST NOT be present in the PRD

**Example mappings from CSV:**
- api_backend: Required=[endpoint_specs, auth_model, data_schemas], Skip=[ux_ui, visual_design]
- mobile_app: Required=[platform_reqs, device_permissions, offline_mode], Skip=[desktop_features, cli_commands]
- cli_tool: Required=[command_structure, output_formats, config_schema], Skip=[visual_design, ux_principles, touch_interactions]
- etc.

### 4. Validate Against CSV-Based Requirements

**Based on project type, determine:**

**api_backend:**
- Required: Endpoint Specs, Auth Model, Data Schemas, API Versioning
- Excluded: UX/UI sections, mobile-specific sections

**web_app:**
- Required: User Journeys, UX/UI Requirements, Responsive Design
- Excluded: None typically

**mobile_app:**
- Required: Mobile UX, Platform specifics (iOS/Android), Offline mode
- Excluded: Desktop-specific sections

**desktop_app:**
- Required: Desktop UX, Platform specifics (Windows/Mac/Linux)
- Excluded: Mobile-specific sections

**data_pipeline:**
- Required: Data Sources, Data Transformation, Data Sinks, Error Handling
- Excluded: UX/UI sections

**ml_system:**
- Required: Model Requirements, Training Data, Inference Requirements, Model Performance
- Excluded: UX/UI sections (unless ML UI)

**library_sdk:**
- Required: API Surface, Usage Examples, Integration Guide
- Excluded: UX/UI sections, deployment sections

**infrastructure:**
- Required: Infrastructure Components, Deployment, Monitoring, Scaling
- Excluded: Feature requirements (this is infrastructure, not product)

### 4. Attempt Sub-Process Validation

"Perform project-type compliance validation for {projectType}:

**Check that required sections are present:**
{List required sections for this project type}
For each: Is it present in PRD? Is it adequately documented?

**Check that excluded sections are absent:**
{List excluded sections for this project type}
For each: Is it absent from PRD? (Should not be present)

Build compliance table showing:
- Required sections: [Present/Missing/Incomplete]
- Excluded sections: [Absent/Present] (Present = violation)

Return compliance table with findings."

**Graceful degradation (if no Task tool):**
- Manually check PRD for required sections
- Manually check PRD for excluded sections
- Build compliance table

### 5. Build Compliance Table

**Required sections check:**
- For each required section: Present / Missing / Incomplete
- Count: Required sections present vs total required

**Excluded sections check:**
- For each excluded section: Absent / Present (violation)
- Count: Excluded sections present (violations)

**Total compliance score:**
- Required: {present}/{total}
- Excluded violations: {count}

### 6. Report Project-Type Compliance Findings to Validation Report

Append to validation report:

```markdown
## Project-Type Compliance Validation

**Project Type:** {projectType}

### Required Sections

**{Section 1}:** [Present/Missing/Incomplete]
{If missing or incomplete: Note specific gaps}

**{Section 2}:** [Present/Missing/Incomplete]
{If missing or incomplete: Note specific gaps}

[Continue for all required sections]

### Excluded Sections (Should Not Be Present)

**{Section 1}:** [Absent/Present] ✓
{If present: This section should not be present for {projectType}}

**{Section 2}:** [Absent/Present] ✓
{If present: This section should not be present for {projectType}}

[Continue for all excluded sections]

### Compliance Summary

**Required Sections:** {present}/{total} present
**Excluded Sections Present:** {violations} (should be 0)
**Compliance Score:** {percentage}%

**Severity:** [Critical if required sections missing, Warning if incomplete, Pass if complete]

**Recommendation:**
[If Critical] "PRD is missing required sections for {projectType}. Add missing sections to properly specify this type of project."
[If Warning] "Some required sections for {projectType} are incomplete. Strengthen documentation."
[If Pass] "All required sections for {projectType} are present. No excluded sections found."
```

### 7. Display Progress and Auto-Proceed

Display: "**Project-Type Compliance Validation Complete**

Project Type: {projectType}
Compliance: {score}%

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile} (step-v-10-smart-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Project type extracted correctly (or default assumed)
- Required sections validated for presence and completeness
- Excluded sections validated for absence
- Compliance table built with status for all sections
- Severity assessed correctly
- Findings reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not checking project type before proceeding
- Missing required section checks
- Missing excluded section checks
- Not building compliance table
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** Different project types have different requirements. API PRDs don't need UX sections - validate accordingly.
