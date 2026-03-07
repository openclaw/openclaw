---
name: "step-07-instruction-style-check"
description: "Check instruction style - intent-based vs prescriptive, appropriate for domain"

nextStepFile: "./step-08-collaborative-experience-check.md"
targetWorkflowPath: "{workflow_folder_path}"
validationReportFile: "{workflow_folder_path}/validation-report-{datetime}.md"
intentVsPrescriptive: "../data/intent-vs-prescriptive-spectrum.md"
workflowPlanFile: "{workflow_folder_path}/workflow-plan.md"
---

# Validation Step 7: Instruction Style Check

## STEP GOAL:

To validate that workflow instructions use appropriate style - intent-based for creative/facilitative workflows, prescriptive only where absolutely required (compliance, legal).

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 DO NOT BE LAZY - LOAD AND REVIEW EVERY FILE
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step, ensure entire file is read
- ✅ Validation does NOT stop for user input - auto-proceed through all validation steps
- ⚙️ If any instruction references a subprocess, subagent, or tool you do not have access to, you MUST still achieve the outcome in your main context

### Step-Specific Rules:

- 🎯 Review EVERY step's instruction style using subprocess optimization - separate subprocess per file for deep analysis
- 🚫 DO NOT skip any files or style checks - DO NOT BE LAZY
- 💬 Subprocess must either update validation report OR return structured findings to parent for aggregation
- 🚪 This is validation - systematic and thorough

## EXECUTION PROTOCOLS:

- 🎯 Load intent vs prescriptive standards
- 💾 Check EACH step's instruction style using subprocess optimization - each file in its own subprocess
- 📖 Validate style is appropriate for domain
- 🚫 DO NOT halt for user input - validation runs to completion
- 💬 Subprocesses must either update validation report OR return findings for parent aggregation

## CONTEXT BOUNDARIES:

- Instruction style should match domain
- Creative/facilitative → Intent-based (default)
- Compliance/legal → Prescriptive (exception)
- Check EVERY step for style consistency

## MANDATORY SEQUENCE

**CRITICAL:** Follow this sequence exactly. Do not skip or shortcut.

### 1. Load Instruction Style Standards

Load {intentVsPrescriptive} to understand:

**Intent-Based (Default):**

- Use for: Most workflows - creative, exploratory, collaborative
- Step instruction describes goals and principles
- AI adapts conversation naturally
- More flexible and responsive
- Example: "Guide user to define requirements through open-ended discussion"

**Prescriptive (Exception):**

- Use for: Compliance, safety, legal, medical, regulated industries
- Step provides exact instructions
- More controlled and predictable
- Example: "Ask exactly: 'Do you currently experience fever, cough, or fatigue?'"

### 2. Determine Domain Type

From {workflowPlanFile}, identify the workflow domain:

**Intent-Based Domains (Default):**

- Creative work (writing, design, brainstorming)
- Personal development (planning, goals, reflection)
- Exploration (research, discovery)
- Collaboration (facilitation, coaching)

**Prescriptive Domains (Exception):**

- Legal/Compliance (contracts, regulations)
- Medical (health assessments, triage)
- Financial (tax, regulatory compliance)
- Safety (risk assessments, safety checks)

### 3. Check EACH Step's Instruction Style

**DO NOT BE LAZY - For EACH step file, launch a subprocess that:**

1. Loads that step file
2. Reads the instruction sections (MANDATORY SEQUENCE)
3. Analyzes and classifies instruction style deeply
4. **EITHER** updates validation report directly with findings
5. **OR** returns structured analysis findings to parent for aggregation

**SUBPROCESS ANALYSIS PATTERN:**

Each subprocess performs deep analysis of instruction prose to classify style:

**Intent-Based Indicators:**

- ✅ Describes goals/outcomes, not exact wording
- ✅ Uses "think about" language
- ✅ Multi-turn conversation encouraged
- ✅ "Ask 1-2 questions at a time, not a laundry list"
- ✅ "Probe to understand deeper"
- ✅ Flexible: "guide user through..." not "say exactly..."

**Prescriptive Indicators:**

- Exact questions specified
- Specific wording required
- Sequence that must be followed precisely
- "Say exactly:" or "Ask precisely:"

**Mixed Style:**

- Some steps prescriptive (critical/required)
- Others intent-based (creative/facilitative)

**RETURN FORMAT:**
Each subprocess should return findings including:

- Step file identifier
- Instruction style classification (Intent-based/Prescriptive/Mixed)
- Style indicators observed
- Appropriateness assessment (PASS/WARN/FAIL)
- Specific notes and observations
- Examples of good and concerning instruction patterns

**Parent aggregates all subprocess findings into unified report section.**

### 4. Validate Appropriateness

**For Intent-Based Domains:**

- ✅ Instructions should be intent-based
- ❌ Prescriptive instructions inappropriate (unless specific section requires it)

**For Prescriptive Domains:**

- ✅ Instructions should be prescriptive where compliance matters
- ⚠️ May have intent-based sections for creative elements

### 5. Aggregate Findings and Document

After ALL subprocesses have analyzed their respective step files, aggregate findings and create/update section in {validationReportFile}.

Document the following:

**Workflow Domain Assessment:**

- Document the domain type (creative/interactive vs compliance/legal)
- State the appropriate instruction style for this domain

**Instruction Style Findings:**

- List each step and its instruction style classification (intent-based/prescriptive/mixed)
- Note whether the style is appropriate for the domain
- Document specific examples of instruction language that demonstrate the style
- Identify any steps with inappropriate style (e.g., prescriptive in creative domain)

**Issues Identified:**

- List any steps that are overly prescriptive for their domain
- List any steps that should be more prescriptive (for compliance domains)
- Note any style inconsistencies across steps

**Positive Findings:**

- Highlight steps with excellent instruction style
- Note effective use of intent-based facilitation language
- Identify appropriate use of prescriptive instructions (if applicable)

**Overall Status:**

- Provide final assessment (PASS/FAIL/WARN)
- Summarize key findings

**Context Savings Note:** Using subprocess pattern (Pattern 2: per-file deep analysis), parent context receives only structured analysis findings (~50-100 lines per file) instead of full file contents (~200+ lines per file). For 10 steps: ~500-1000 lines received vs ~2000+ lines if loading all files in parent.

### 6. Update Report with Aggregated Findings

Update {validationReportFile} - replace "## Instruction Style Check _Pending..._" with actual aggregated findings from all subprocesses.

### 7. Save Report and Auto-Proceed

**CRITICAL:** Save the validation report BEFORE loading next step.

Then immediately load, read entire file, then execute {nextStepFile}.

**Display:**
"**Instruction Style check complete.** Proceeding to Collaborative Experience Check..."

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- EVERY step's instruction style reviewed via subprocess optimization (Pattern 2: per-file deep analysis)
- Each step analyzed in its own subprocess for style classification
- Style validated against domain appropriateness
- Issues documented with specific examples
- Subprocess findings aggregated into unified report section
- Context savings achieved (~500-1000 lines received vs ~2000+ if loading all files)
- Report saved before proceeding
- Next validation step loaded

### ❌ SYSTEM FAILURE:

- Not checking every step's style via subprocess
- Not analyzing each file in its own subprocess
- Not validating against domain
- Not documenting style issues
- Not aggregating subprocess findings
- Not saving report before proceeding

**Master Rule:** Validation is systematic and thorough. DO NOT BE LAZY. For EACH step file, launch a subprocess to analyze instruction style deeply. Aggregate findings. Auto-proceed through all validation steps. Use graceful fallback if subprocess unavailable.
