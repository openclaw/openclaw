---
name: 'step-05-scope'
description: 'Define MVP scope with clear boundaries and outline future vision while managing scope creep'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/1-analysis/create-product-brief/steps/step-06-complete.md'
outputFile: '{planning_artifacts}/product-brief-{{project_name}}-{{date}}.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 5: MVP Scope Definition

## STEP GOAL:

Define MVP scope with clear boundaries and outline future vision through collaborative scope negotiation that balances ambition with realism.

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

- 🎯 Focus only on defining minimum viable scope and future vision
- 🚫 FORBIDDEN to create MVP scope that's too large or includes non-essential features
- 💬 Approach: Systematic scope negotiation with clear boundary setting
- 📋 COLLABORATIVE scope definition that prevents scope creep

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 💾 Generate MVP scope collaboratively with user
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4, 5]` before loading next step
- 🚫 FORBIDDEN to proceed without user confirmation through menu

## CONTEXT BOUNDARIES:

- Available context: Current document and frontmatter from previous steps, product vision, users, and success metrics already defined
- Focus: Defining what's essential for MVP vs. future enhancements
- Limits: Balance user needs with implementation feasibility
- Dependencies: Product vision, user personas, and success metrics from previous steps must be complete

## Sequence of Instructions (Do not deviate, skip, or optimize)

### 1. Begin Scope Definition

**Opening Exploration:**
"Now that we understand what {{project_name}} does, who it serves, and how we'll measure success, let's define what we need to build first.

**Scope Discovery:**

- What's the absolute minimum we need to deliver to solve the core problem?
- What features would make users say 'this solves my problem'?
- How do we balance ambition with getting something valuable to users quickly?

Let's start with the MVP mindset: what's the smallest version that creates real value?"

### 2. MVP Core Features Definition

**MVP Feature Questions:**
Define essential features for minimum viable product:

- "What's the core functionality that must work?"
- "Which features directly address the main problem we're solving?"
- "What would users consider 'incomplete' if it was missing?"
- "What features create the 'aha!' moment we discussed earlier?"

**MVP Criteria:**

- **Solves Core Problem:** Addresses the main pain point effectively
- **User Value:** Creates meaningful outcome for target users
- **Feasible:** Achievable with available resources and timeline
- **Testable:** Allows learning and iteration based on user feedback

### 3. Out of Scope Boundaries

**Out of Scope Exploration:**
Define what explicitly won't be in MVP:

- "What features would be nice to have but aren't essential?"
- "What functionality could wait for version 2.0?"
- "What are we intentionally saying 'no' to for now?"
- "How do we communicate these boundaries to stakeholders?"

**Boundary Setting:**

- Clear communication about what's not included
- Rationale for deferring certain features
- Timeline considerations for future additions
- Trade-off explanations for stakeholders

### 4. MVP Success Criteria

**Success Validation:**
Define what makes the MVP successful:

- "How will we know the MVP is successful?"
- "What metrics will indicate we should proceed beyond MVP?"
- "What user feedback signals validate our approach?"
- "What's the decision point for scaling beyond MVP?"

**Success Gates:**

- User adoption metrics
- Problem validation evidence
- Technical feasibility confirmation
- Business model validation

### 5. Future Vision Exploration

**Vision Questions:**
Define the longer-term product vision:

- "If this is wildly successful, what does it become in 2-3 years?"
- "What capabilities would we add with more resources?"
- "How does the MVP evolve into the full product vision?"
- "What markets or user segments could we expand to?"

**Future Features:**

- Post-MVP enhancements that build on core functionality
- Scale considerations and growth capabilities
- Platform or ecosystem expansion opportunities
- Advanced features that differentiate in the long term

### 6. Generate MVP Scope Content

**Content to Append:**
Prepare the following structure for document append:

```markdown
## MVP Scope

### Core Features

[Core features content based on conversation]

### Out of Scope for MVP

[Out of scope content based on conversation, or N/A if not discussed]

### MVP Success Criteria

[MVP success criteria content based on conversation, or N/A if not discussed]

### Future Vision

[Future vision content based on conversation, or N/A if not discussed]
```

### 7. Present MENU OPTIONS

**Content Presentation:**
"I've defined the MVP scope for {{project_name}} that balances delivering real value with realistic boundaries. This gives us a clear path forward while keeping our options open for future growth.

**Here's what I'll add to the document:**
[Show the complete markdown content from step 6]

**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Read fully and follow: {advancedElicitationTask} with current scope content to optimize scope definition
- IF P: Read fully and follow: {partyModeWorkflow} to bring different perspectives to validate MVP scope
- IF C: Save content to {outputFile}, update frontmatter with stepsCompleted: [1, 2, 3, 4, 5], then read fully and follow: {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#7-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu with updated content
- User can chat or ask questions - always respond and then end with display again of the menu options

## CRITICAL STEP COMPLETION NOTE

ONLY WHEN [C continue option] is selected and [MVP scope finalized and saved to document with frontmatter updated], will you then read fully and follow: `{nextStepFile}` to complete the product brief workflow.

---

## 🚨 SYSTEM SUCCESS/FAILURE METRICS

### ✅ SUCCESS:

- MVP features that solve the core problem effectively
- Clear out-of-scope boundaries that prevent scope creep
- Success criteria that validate MVP approach and inform go/no-go decisions
- Future vision that inspires while maintaining focus on MVP
- A/P/C menu presented and handled correctly with proper task execution
- Content properly appended to document when C selected
- Frontmatter updated with stepsCompleted: [1, 2, 3, 4, 5]

### ❌ SYSTEM FAILURE:

- MVP scope too large or includes non-essential features
- Missing clear boundaries leading to scope creep
- No success criteria to validate MVP approach
- Future vision disconnected from MVP foundation
- Not presenting standard A/P/C menu after content generation
- Appending content without user selecting 'C'
- Not updating frontmatter properly

**Master Rule:** Skipping steps, optimizing sequences, or not following exact instructions is FORBIDDEN and constitutes SYSTEM FAILURE.
