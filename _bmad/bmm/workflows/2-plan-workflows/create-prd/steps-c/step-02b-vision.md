---
name: 'step-02b-vision'
description: 'Discover the product vision and differentiator through collaborative dialogue'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-02c-executive-summary.md'
outputFile: '{planning_artifacts}/prd.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 2b: Product Vision Discovery

**Progress: Step 2b of 13** - Next: Executive Summary

## STEP GOAL:

Discover what makes this product special and understand the product vision through collaborative conversation. No content generation — facilitation only.

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
- ✅ You bring structured thinking and facilitation skills, while the user brings domain expertise and product vision

### Step-Specific Rules:

- 🎯 Focus on discovering vision and differentiator — no content generation yet
- 🚫 FORBIDDEN to generate executive summary content (that's the next step)
- 🚫 FORBIDDEN to append anything to the document in this step
- 💬 APPROACH: Natural conversation to understand what makes this product special
- 🎯 BUILD ON classification insights from step 2

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after vision discovery is complete
- 📖 Update frontmatter, adding this step to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from steps 1 and 2 are available
- Project classification exists from step 2 (project type, domain, complexity, context)
- Input documents already loaded are in memory (product briefs, research, brainstorming, project docs)
- No executive summary content yet (that's step 2c)
- This step ONLY discovers — it does NOT write to the document

## YOUR TASK:

Discover the product vision and differentiator through natural conversation. Understand what makes this product unique and valuable before any content is written.

## VISION DISCOVERY SEQUENCE:

### 1. Acknowledge Classification Context

Reference the classification from step 2 and use it to frame the vision conversation:

"We've established this is a {{projectType}} in the {{domain}} domain with {{complexityLevel}} complexity. Now let's explore what makes this product special."

### 2. Explore What Makes It Special

Guide the conversation to uncover the product's unique value:

- **User delight:** "What would make users say 'this is exactly what I needed'?"
- **Differentiation moment:** "What's the moment where users realize this is different or better than alternatives?"
- **Core insight:** "What insight or approach makes this product possible or unique?"
- **Value proposition:** "If you had one sentence to explain why someone should use this over anything else, what would it be?"

### 3. Understand the Vision

Dig deeper into the product vision:

- **Problem framing:** "What's the real problem you're solving — not the surface symptom, but the deeper need?"
- **Future state:** "When this product is successful, what does the world look like for your users?"
- **Why now:** "Why is this the right time to build this?"

### 4. Validate Understanding

Reflect back what you've heard and confirm:

"Here's what I'm hearing about your vision and differentiator:

**Vision:** {{summarized_vision}}
**What Makes It Special:** {{summarized_differentiator}}
**Core Insight:** {{summarized_insight}}

Does this capture it? Anything I'm missing?"

Let the user confirm or refine your understanding.

### N. Present MENU OPTIONS

Present your understanding of the product vision for review, then display menu:

"Based on our conversation, I have a clear picture of your product vision and what makes it special. I'll use these insights to draft the Executive Summary in the next step.

**What would you like to do?**"

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Executive Summary (Step 2c of 13)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current vision insights, process the enhanced insights that come back, ask user if they accept the improvements, if yes update understanding then redisplay menu, if no keep original understanding then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the current vision insights, process the collaborative insights, ask user if they accept the changes, if yes update understanding then redisplay menu, if no keep original understanding then redisplay menu
- IF C: Update {outputFile} frontmatter by adding this step name to the end of stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [stepsCompleted updated], will you then read fully and follow: `{nextStepFile}` to generate the Executive Summary.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- Classification context from step 2 acknowledged and built upon
- Natural conversation to understand product vision and differentiator
- User's existing documents (briefs, research, brainstorming) leveraged for vision insights
- Vision and differentiator validated with user before proceeding
- Clear understanding established that will inform Executive Summary generation
- Frontmatter updated with stepsCompleted when C selected

### ❌ SYSTEM FAILURE:

- Generating executive summary or any document content (that's step 2c!)
- Appending anything to the PRD document
- Not building on classification from step 2
- Being prescriptive instead of having natural conversation
- Proceeding without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file

**Master Rule:** This step is vision discovery only. No content generation, no document writing. Have natural conversations, build on what you know from classification, and establish the vision that will feed into the Executive Summary.
