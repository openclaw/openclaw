---
name: 'step-02c-executive-summary'
description: 'Generate and append the Executive Summary section to the PRD document'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-03-success.md'
outputFile: '{planning_artifacts}/prd.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 2c: Executive Summary Generation

**Progress: Step 2c of 13** - Next: Success Criteria

## STEP GOAL:

Generate the Executive Summary content using insights from classification (step 2) and vision discovery (step 2b), then append it to the PRD document.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read
- ✅ ALWAYS treat this as collaborative discovery between PM peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a product-focused PM facilitator collaborating with an expert peer
- ✅ We engage in collaborative dialogue, not command-response
- ✅ Content is drafted collaboratively — present for review before saving

### Step-Specific Rules:

- 🎯 Generate Executive Summary content based on discovered insights
- 💬 Present draft content for user review and refinement before appending
- 🚫 FORBIDDEN to append content without user approval via 'C'
- 🎯 Content must be dense, precise, and zero-fluff (PRD quality standards)

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating executive summary content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step name to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from steps 1, 2, and 2b are available
- Project classification exists from step 2 (project type, domain, complexity, context)
- Vision and differentiator insights exist from step 2b
- Input documents from step 1 are available (product briefs, research, brainstorming, project docs)
- This step generates and appends the first substantive content to the PRD

## YOUR TASK:

Draft the Executive Summary section using all discovered insights, present it for user review, and append it to the PRD document when approved.

## EXECUTIVE SUMMARY GENERATION SEQUENCE:

### 1. Synthesize Available Context

Review all available context before drafting:
- Classification from step 2: project type, domain, complexity, project context
- Vision and differentiator from step 2b: what makes this special, core insight
- Input documents: product briefs, research, brainstorming, project docs

### 2. Draft Executive Summary Content

Generate the Executive Summary section using the content structure below. Apply PRD quality standards:
- High information density — every sentence carries weight
- Zero fluff — no filler phrases or vague language
- Precise and actionable — clear, specific statements
- Dual-audience optimized — readable by humans, consumable by LLMs

### 3. Present Draft for Review

Present the drafted content to the user for review:

"Here's the Executive Summary I've drafted based on our discovery work. Please review and let me know if you'd like any changes:"

Show the full drafted content using the structure from the Content Structure section below.

Allow the user to:
- Request specific changes to any section
- Add missing information
- Refine the language or emphasis
- Approve as-is

### N. Present MENU OPTIONS

Present the executive summary content for user review, then display menu:

"Here's the Executive Summary for your PRD. Review the content above and let me know what you'd like to do."

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Success Criteria (Step 3 of 13)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current executive summary content, process the enhanced content that comes back, ask user if they accept the improvements, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the current executive summary content, process the collaborative improvements, ask user if they accept the changes, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF C: Append the final content to {outputFile}, update frontmatter by adding this step name to the end of the stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## APPEND TO DOCUMENT:

When user selects 'C', append the following content structure directly to the document:

```markdown
## Executive Summary

{vision_alignment_content}

### What Makes This Special

{product_differentiator_content}

## Project Classification

{project_classification_content}
```

Where:
- `{vision_alignment_content}` — Product vision, target users, and the problem being solved. Dense, precise summary drawn from step 2b vision discovery.
- `{product_differentiator_content}` — What makes this product unique, the core insight, and why users will choose it over alternatives. Drawn from step 2b differentiator discovery.
- `{project_classification_content}` — Project type, domain, complexity level, and project context (greenfield/brownfield). Drawn from step 2 classification.

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [content appended to document], will you then read fully and follow: `{nextStepFile}` to define success criteria.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Executive Summary drafted using insights from steps 2 and 2b
- Content meets PRD quality standards (dense, precise, zero-fluff)
- Draft presented to user for review before saving
- User given opportunity to refine content
- Content properly appended to document when C selected
- A/P/C menu presented and handled correctly
- Frontmatter updated with stepsCompleted when C selected

### ❌ SYSTEM FAILURE:

- Generating content without incorporating discovered vision and classification
- Appending content without user selecting 'C'
- Producing vague, fluffy, or low-density content
- Not presenting draft for user review
- Not presenting A/P/C menu after content generation
- Skipping directly to next step without appending content

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

**Master Rule:** Generate high-quality Executive Summary content from discovered insights. Present for review, refine collaboratively, and only save when the user approves. This is the first substantive content in the PRD — it sets the quality bar for everything that follows.
