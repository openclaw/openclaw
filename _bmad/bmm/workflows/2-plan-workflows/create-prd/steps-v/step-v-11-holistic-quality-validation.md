---
name: 'step-v-11-holistic-quality-validation'
description: 'Holistic Quality Assessment - Assess PRD as cohesive, compelling document - is it a good PRD?'

# File references (ONLY variables used in this step)
nextStepFile: './step-v-12-completeness-validation.md'
prdFile: '{prd_file_path}'
validationReportPath: '{validation_report_path}'
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
---

# Step 11: Holistic Quality Assessment

## STEP GOAL:

Assess the PRD as a cohesive, compelling document - evaluating document flow, dual audience effectiveness (humans and LLMs), BMAD PRD principles compliance, and overall quality rating.

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
- ✅ You bring analytical rigor and document quality expertise
- ✅ This step runs autonomously - no user input needed
- ✅ Uses Advanced Elicitation for multi-perspective evaluation

### Step-Specific Rules:

- 🎯 Focus ONLY on holistic document quality assessment
- 🚫 FORBIDDEN to validate individual components (done in previous steps)
- 💬 Approach: Multi-perspective evaluation using Advanced Elicitation
- 🚪 This is a validation sequence step - auto-proceeds when complete

## EXECUTION PROTOCOLS:

- 🎯 Use Advanced Elicitation for multi-perspective assessment
- 🎯 Evaluate document flow, dual audience, BMAD principles
- 💾 Append comprehensive assessment to validation report
- 📖 Display "Proceeding to next check..." and load next step
- 🚫 FORBIDDEN to pause or request user input

## CONTEXT BOUNDARIES:

- Available context: Complete PRD file, validation report with findings from steps 1-10
- Focus: Holistic quality - the WHOLE document
- Limits: Don't re-validate individual components, don't pause for user input
- Dependencies: Steps 1-10 completed - all systematic checks done

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip, reorder, or improvise unless user explicitly requests a change.

### 1. Attempt Sub-Process with Advanced Elicitation

**Try to use Task tool to spawn a subprocess using Advanced Elicitation:**

"Perform holistic quality assessment on this PRD using multi-perspective evaluation:

**Read fully and follow the Advanced Elicitation workflow:**
{advancedElicitationTask}

**Evaluate the PRD from these perspectives:**

**1. Document Flow & Coherence:**
- Read entire PRD
- Evaluate narrative flow - does it tell a cohesive story?
- Check transitions between sections
- Assess consistency - is it coherent throughout?
- Evaluate readability - is it clear and well-organized?

**2. Dual Audience Effectiveness:**

**For Humans:**
- Executive-friendly: Can executives understand vision and goals quickly?
- Developer clarity: Do developers have clear requirements to build from?
- Designer clarity: Do designers understand user needs and flows?
- Stakeholder decision-making: Can stakeholders make informed decisions?

**For LLMs:**
- Machine-readable structure: Is the PRD structured for LLM consumption?
- UX readiness: Can an LLM generate UX designs from this?
- Architecture readiness: Can an LLM generate architecture from this?
- Epic/Story readiness: Can an LLM break down into epics and stories?

**3. BMAD PRD Principles Compliance:**
- Information density: Every sentence carries weight?
- Measurability: Requirements testable?
- Traceability: Requirements trace to sources?
- Domain awareness: Domain-specific considerations included?
- Zero anti-patterns: No filler or wordiness?
- Dual audience: Works for both humans and LLMs?
- Markdown format: Proper structure and formatting?

**4. Overall Quality Rating:**
Rate the PRD on 5-point scale:
- Excellent (5/5): Exemplary, ready for production use
- Good (4/5): Strong with minor improvements needed
- Adequate (3/5): Acceptable but needs refinement
- Needs Work (2/5): Significant gaps or issues
- Problematic (1/5): Major flaws, needs substantial revision

**5. Top 3 Improvements:**
Identify the 3 most impactful improvements to make this a great PRD

Return comprehensive assessment with all perspectives, rating, and top 3 improvements."

**Graceful degradation (if no Task tool or Advanced Elicitation unavailable):**
- Perform holistic assessment directly in current context
- Read complete PRD
- Evaluate document flow, coherence, transitions
- Assess dual audience effectiveness
- Check BMAD principles compliance
- Assign overall quality rating
- Identify top 3 improvements

### 2. Synthesize Assessment

**Compile findings from multi-perspective evaluation:**

**Document Flow & Coherence:**
- Overall assessment: [Excellent/Good/Adequate/Needs Work/Problematic]
- Key strengths: [list]
- Key weaknesses: [list]

**Dual Audience Effectiveness:**
- For Humans: [assessment]
- For LLMs: [assessment]
- Overall dual audience score: [1-5]

**BMAD Principles Compliance:**
- Principles met: [count]/7
- Principles with issues: [list]

**Overall Quality Rating:** [1-5 with label]

**Top 3 Improvements:**
1. [Improvement 1]
2. [Improvement 2]
3. [Improvement 3]

### 3. Report Holistic Quality Findings to Validation Report

Append to validation report:

```markdown
## Holistic Quality Assessment

### Document Flow & Coherence

**Assessment:** [Excellent/Good/Adequate/Needs Work/Problematic]

**Strengths:**
{List key strengths}

**Areas for Improvement:**
{List key weaknesses}

### Dual Audience Effectiveness

**For Humans:**
- Executive-friendly: [assessment]
- Developer clarity: [assessment]
- Designer clarity: [assessment]
- Stakeholder decision-making: [assessment]

**For LLMs:**
- Machine-readable structure: [assessment]
- UX readiness: [assessment]
- Architecture readiness: [assessment]
- Epic/Story readiness: [assessment]

**Dual Audience Score:** {score}/5

### BMAD PRD Principles Compliance

| Principle | Status | Notes |
|-----------|--------|-------|
| Information Density | [Met/Partial/Not Met] | {notes} |
| Measurability | [Met/Partial/Not Met] | {notes} |
| Traceability | [Met/Partial/Not Met] | {notes} |
| Domain Awareness | [Met/Partial/Not Met] | {notes} |
| Zero Anti-Patterns | [Met/Partial/Not Met] | {notes} |
| Dual Audience | [Met/Partial/Not Met] | {notes} |
| Markdown Format | [Met/Partial/Not Met] | {notes} |

**Principles Met:** {count}/7

### Overall Quality Rating

**Rating:** {rating}/5 - {label}

**Scale:**
- 5/5 - Excellent: Exemplary, ready for production use
- 4/5 - Good: Strong with minor improvements needed
- 3/5 - Adequate: Acceptable but needs refinement
- 2/5 - Needs Work: Significant gaps or issues
- 1/5 - Problematic: Major flaws, needs substantial revision

### Top 3 Improvements

1. **{Improvement 1}**
   {Brief explanation of why and how}

2. **{Improvement 2}**
   {Brief explanation of why and how}

3. **{Improvement 3}**
   {Brief explanation of why and how}

### Summary

**This PRD is:** {one-sentence overall assessment}

**To make it great:** Focus on the top 3 improvements above.
```

### 4. Display Progress and Auto-Proceed

Display: "**Holistic Quality Assessment Complete**

Overall Rating: {rating}/5 - {label}

**Proceeding to final validation checks...**"

Without delay, read fully and follow: {nextStepFile} (step-v-12-completeness-validation.md)

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Advanced Elicitation used for multi-perspective evaluation (or graceful degradation)
- Document flow & coherence assessed
- Dual audience effectiveness evaluated (humans and LLMs)
- BMAD PRD principles compliance checked
- Overall quality rating assigned (1-5 scale)
- Top 3 improvements identified
- Comprehensive assessment reported to validation report
- Auto-proceeds to next validation step
- Subprocess attempted with graceful degradation

### ❌ SYSTEM FAILURE:

- Not using Advanced Elicitation for multi-perspective evaluation
- Missing document flow assessment
- Missing dual audience evaluation
- Not checking all BMAD principles
- Not assigning overall quality rating
- Missing top 3 improvements
- Not reporting comprehensive assessment to validation report
- Not auto-proceeding

**Master Rule:** This evaluates the WHOLE document, not just components. Answers "Is this a good PRD?" and "What would make it great?"
