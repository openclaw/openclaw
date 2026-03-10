---
name: 'step-v-07-implementation-leakage-validation'
description: 'Implementation Leakage Check - Ensure FRs and NFRs don\'t include implementation details'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-08-domain-compliance-validation.md'
prdFile: '{prd_file_path}'
validationReportPath: '{validation_report_path}'
---

# Step 7: Implementation Leakage Validation

## STEP GOAL:

Ensure Functional Requirements and Non-Functional Requirements don't include implementation details - they should specify WHAT, not HOW.

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
- ✅ You bring analytical rigor and separation of concerns expertise
- ✅ This step runs autonomously - no user input needed

### Step-Specific Rules:

- 🎯 Focus ONLY on implementation leakage detection
- 🚫 FORBIDDEN to validate other aspects in this step
- 💬 Approach: Systematic scanning for technology and implementation terms
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Scan FRs and NFRs for implementation terms
- 💾 Distinguish capability-relevant vs leakage
- 📖 Append findings to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: PRD file, validation report
- Focus: Implementation leakage detection only
- Limits: Don't validate other aspects, don't pause for user input
- Dependencies: Steps 2-6 completed - initial validations done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Attempt Sub-Process Validation

**Try to use Task tool to spawn a subprocess:**

"Perform implementation leakage validation on this PRD:

**Scan for:**
1. Technology names (React, Vue, Angular, PostgreSQL, MongoDB, AWS, GCP, Azure, Docker, Kubernetes, etc.)
2. Library names (Redux, axios, lodash, Express, Django, Rails, Spring, etc.)
3. Data structures (JSON, XML, CSV) unless relevant to capability
4. Architecture patterns (MVC, microservices, serverless) unless business requirement
5. Protocol names (HTTP, REST, GraphQL, WebSockets) - check if capability-relevant

**For each term found:**
- Is this capability-relevant? (e.g., 'API consumers can access...' - API is capability)
- Or is this implementation detail? (e.g., 'React component for...' - implementation)

Document violations with line numbers and explanation.

Return structured findings with leakage counts and examples."

### 2. Graceful Degradation (if Task tool unavailable)

If Task tool unavailable, perform analysis directly:

**Implementation leakage terms to scan for:**

**Frontend Frameworks:**
React, Vue, Angular, Svelte, Solid, Next.js, Nuxt, etc.

**Backend Frameworks:**
Express, Django, Rails, Spring, Laravel, FastAPI, etc.

**Databases:**
PostgreSQL, MySQL, MongoDB, Redis, DynamoDB, Cassandra, etc.

**Cloud Platforms:**
AWS, GCP, Azure, Cloudflare, Vercel, Netlify, etc.

**Infrastructure:**
Docker, Kubernetes, Terraform, Ansible, etc.

**Libraries:**
Redux, Zustand, axios, fetch, lodash, jQuery, etc.

**Data Formats:**
JSON, XML, YAML, CSV (unless capability-relevant)

**For each term found in FRs/NFRs:**
- Determine if it's capability-relevant or implementation leakage
- Example: "API consumers can access data via REST endpoints" - API/REST is capability
- Example: "React components fetch data using Redux" - implementation leakage

**Count violations and note line numbers**

### 3. Tally Implementation Leakage

**By category:**
- Frontend framework leakage: count
- Backend framework leakage: count
- Database leakage: count
- Cloud platform leakage: count
- Infrastructure leakage: count
- Library leakage: count
- Other implementation details: count

**Total implementation leakage violations:** sum

### 4. Report Implementation Leakage Findings to Validation Report

Append to validation report:

```markdown
## Implementation Leakage Validation

### Leakage by Category

**Frontend Frameworks:** {count} violations
{If violations, list examples with line numbers}

**Backend Frameworks:** {count} violations
{If violations, list examples with line numbers}

**Databases:** {count} violations
{If violations, list examples with line numbers}

**Cloud Platforms:** {count} violations
{If violations, list examples with line numbers}

**Infrastructure:** {count} violations
{If violations, list examples with line numbers}

**Libraries:** {count} violations
{If violations, list examples with line numbers}

**Other Implementation Details:** {count} violations
{If violations, list examples with line numbers}

### Summary

**Total Implementation Leakage Violations:** {total}

**Severity:** [Critical if >5 violations, Warning if 2-5, Pass if <2]

**Recommendation:**
[If Critical] "Extensive implementation leakage found. Requirements specify HOW instead of WHAT. Remove all implementation details - these belong in architecture, not PRD."
[If Warning] "Some implementation leakage detected. Review violations and remove implementation details from requirements."
[If Pass] "No significant implementation leakage found. Requirements properly specify WHAT without HOW."

**Note:** API consumers, GraphQL (when required), and other capability-relevant terms are acceptable when they describe WHAT the system must do, not HOW to build it.
```

### 5. Display Progress and Auto-Proceed

Display: "**Implementation Leakage Validation Complete**

Total Violations: {count} ({severity})

**Proceeding to next validation check...**"

Without delay, read fully and follow: {nextStepFile} (step-v-08-domain-compliance-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Scanned FRs and NFRs for all implementation term categories
- Distinguished capability-relevant from implementation leakage
- Violations documented with line numbers and explanations
- Severity assessed correctly
- Findings reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not scanning all implementation term categories
- Not distinguishing capability-relevant from leakage
- Missing line numbers for violations
- Not reporting findings to validation report
- Not auto-proceeding

**Master Rule:** Requirements specify WHAT, not HOW. Implementation details belong in architecture documents, not PRDs.
