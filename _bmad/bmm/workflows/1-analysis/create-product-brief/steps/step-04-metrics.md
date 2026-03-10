---
name: 'step-04-metrics'
description: 'Define comprehensive success metrics that include user success, business objectives, and key performance indicators'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/1-analysis/create-product-brief/steps/step-05-scope.md'
outputFile: '{planning_artifacts}/product-brief-{{project_name}}-{{date}}.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 4: Success Metrics Definition

## STEP GOAL:

Define comprehensive success metrics that include user success, business objectives, and key performance indicators through collaborative metric definition aligned with product vision and user value.

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- 🛑 NEVER generate content without user input
- 📖 CRITICAL: Read the complete step file before taking any action
- 🔄 CRITICAL: When loading next step with 'C', ensure entire file is read
- 📋 YOU ARE A FACILITATOR, not a content generator
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

### Role Reinforcement:

- ✅ You are a product-focused Business Analyst facilitator
- ✅ If you already have been given a name, communication_style and persona, continue to use those while playing this new role
- ✅ We engage in collaborative dialogue, not command-response
- ✅ You bring structured thinking and facilitation skills, while the user brings domain expertise and product vision
- ✅ Maintain collaborative discovery tone throughout

### Step-Specific Rules:

- 🎯 Focus only on defining measurable success criteria and business objectives
- 🚫 FORBIDDEN to create vague metrics that can't be measured or tracked
- 💬 Approach: Systematic metric definition that connects user value to business success
- 📋 COLLABORATIVE metric definition that drives actionable decisions

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 💾 Generate success metrics collaboratively with user
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4]` before loading next step
- 🚫 FORBIDDEN to proceed without user confirmation through menu

## CONTEXT BOUNDARIES:

- Available context: Current document and frontmatter from previous steps, product vision and target users already defined
- Focus: Creating measurable, actionable success criteria that align with product strategy
- Limits: Focus on metrics that drive decisions and demonstrate real value creation
- Dependencies: Product vision and user personas from previous steps must be complete

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Begin Success Metrics Discovery

**Opening Exploration:**
"Now that we know who {{project_name}} serves and what problem it solves, let's define what success looks like.

**Success Discovery:**

- How will we know we're succeeding for our users?
- What would make users say 'this was worth it'?
- What metrics show we're creating real value?

Let's start with the user perspective."

### 2. User Success Metrics

**User Success Questions:**
Define success from the user's perspective:

- "What outcome are users trying to achieve?"
- "How will they know the product is working for them?"
- "What's the moment where they realize this is solving their problem?"
- "What behaviors indicate users are getting value?"

**User Success Exploration:**
Guide from vague to specific metrics:

- "Users are happy" → "Users complete [key action] within [timeframe]"
- "Product is useful" → "Users return [frequency] and use [core feature]"
- Focus on outcomes and behaviors, not just satisfaction scores

### 3. Business Objectives

**Business Success Questions:**
Define business success metrics:

- "What does success look like for the business at 3 months? 12 months?"
- "Are we measuring revenue, user growth, engagement, something else?"
- "What business metrics would make you say 'this is working'?"
- "How does this product contribute to broader company goals?"

**Business Success Categories:**

- **Growth Metrics:** User acquisition, market penetration
- **Engagement Metrics:** Usage patterns, retention, satisfaction
- **Financial Metrics:** Revenue, profitability, cost efficiency
- **Strategic Metrics:** Market position, competitive advantage

### 4. Key Performance Indicators

**KPI Development Process:**
Define specific, measurable KPIs:

- Transform objectives into measurable indicators
- Ensure each KPI has a clear measurement method
- Define targets and timeframes where appropriate
- Include leading indicators that predict success

**KPI Examples:**

- User acquisition: "X new users per month"
- Engagement: "Y% of users complete core journey weekly"
- Business impact: "$Z in cost savings or revenue generation"

### 5. Connect Metrics to Strategy

**Strategic Alignment:**
Ensure metrics align with product vision and user needs:

- Connect each metric back to the product vision
- Ensure user success metrics drive business success
- Validate that metrics measure what truly matters
- Avoid vanity metrics that don't drive decisions

### 6. Generate Success Metrics Content

**Content to Append:**
Prepare the following structure for document append:

```markdown
## Success Metrics

[Success metrics content based on conversation]

### Business Objectives

[Business objectives content based on conversation, or N/A if not discussed]

### Key Performance Indicators

[Key performance indicators content based on conversation, or N/A if not discussed]
```

### 7. Present MENU OPTIONS

**Content Presentation:**
"I've defined success metrics that will help us track whether {{project_name}} is creating real value for users and achieving business objectives.

**Here's what I'll add to the document:**
[Show the complete markdown content from step 6]

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Read fully and follow: {advancedElicitationTask} with current metrics content to dive deeper into success metric insights
- IF P: Read fully and follow: {partyModeWorkflow} to bring different perspectives to validate comprehensive metrics
- IF C: Save content to {outputFile}, update frontmatter with stepsCompleted: [1, 2, 3, 4], then read fully and follow: {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu with updated content
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [success metrics finalized and saved to document with frontmatter updated], will you then read fully and follow: `{nextStepFile}` to begin MVP scope definition.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- User success metrics that focus on outcomes and behaviors
- Clear business objectives aligned with product strategy
- Specific, measurable KPIs with defined targets and timeframes
- Metrics that connect user value to business success
- A/P/C menu presented and handled correctly with proper task execution
- Content properly appended to document when C selected
- Frontmatter updated with stepsCompleted: [1, 2, 3, 4]

### ❌ SYSTEM FAILURE:

- Vague success metrics that can't be measured or tracked
- Business objectives disconnected from user success
- Too many metrics or missing critical success indicators
- Metrics that don't drive actionable decisions
- Not presenting standard A/P/C menu after content generation
- Appending content without user selecting 'C'
- Not updating frontmatter properly

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
