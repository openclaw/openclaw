---
name: 'step-08-scoping'
description: 'Define MVP boundaries and prioritize features across development phases'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-09-functional.md'
outputFile: '{planning_artifacts}/prd.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 8: Scoping Exercise - MVP & Future Features

**Progress: Step 8 of 11** - Next: Functional Requirements

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between PM peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on strategic scope decisions that keep projects viable
- 🎯 EMPHASIZE lean MVP thinking while preserving long-term vision
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 📚 Review the complete PRD document built so far
- ⚠️ Present A/P/C menu after generating scoping decisions
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step name to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected


## CONTEXT BOUNDARIES:

- Complete PRD document built so far is available for review
- User journeys, success criteria, and domain requirements are documented
- Focus on strategic scope decisions, not feature details
- Balance between user value and implementation feasibility

## YOUR TASK:

Conduct comprehensive scoping exercise to define MVP boundaries and prioritize features across development phases.

## SCOPING SEQUENCE:

### 1. Review Current PRD State

Analyze everything documented so far:
- Present synthesis of established vision, success criteria, journeys
- Assess domain and innovation focus
- Evaluate scope implications: simple MVP, medium, or complex project
- Ask if initial assessment feels right or if they see it differently

### 2. Define MVP Strategy

Facilitate strategic MVP decisions:
- Explore MVP philosophy options: problem-solving, experience, platform, or revenue MVP
- Ask critical questions:
  - What's the minimum that would make users say 'this is useful'?
  - What would make investors/partners say 'this has potential'?
  - What's the fastest path to validated learning?
- Guide toward appropriate MVP approach for their product

### 3. Scoping Decision Framework

Use structured decision-making for scope:

**Must-Have Analysis:**
- Guide identification of absolute MVP necessities
- For each journey and success criterion, ask:
  - Without this, does the product fail?
  - Can this be manual initially?
  - Is this a deal-breaker for early adopters?
- Analyze journeys for MVP essentials

**Nice-to-Have Analysis:**
- Identify what could be added later:
  - Features that enhance but aren't essential
  - User types that can be added later
  - Advanced functionality that builds on MVP
- Ask what features could be added in versions 2, 3, etc.

### 4. Progressive Feature Roadmap

Create phased development approach:
- Guide mapping of features across development phases
- Structure as Phase 1 (MVP), Phase 2 (Growth), Phase 3 (Vision)
- Ensure clear progression and dependencies

- Core user value delivery
- Essential user journeys
- Basic functionality that works reliably

**Phase 2: Growth**

- Additional user types
- Enhanced features
- Scale improvements

**Phase 3: Expansion**

- Advanced capabilities
- Platform features
- New markets or use cases

**Where does your current vision fit in this development sequence?**"

### 5. Risk-Based Scoping

Identify and mitigate scoping risks:

**Technical Risks:**
"Looking at your innovation and domain requirements:

- What's the most technically challenging aspect?
- Could we simplify the initial implementation?
- What's the riskiest assumption about technology feasibility?"

**Market Risks:**

- What's the biggest market risk?
- How does the MVP address this?
- What learning do we need to de-risk this?"

**Resource Risks:**

- What if we have fewer resources than planned?
- What's the absolute minimum team size needed?
- Can we launch with a smaller feature set?"

### 6. Generate Scoping Content

Prepare comprehensive scoping section:

#### Content Structure:

```markdown
## Project Scoping & Phased Development

### MVP Strategy & Philosophy

**MVP Approach:** {{chosen_mvp_approach}}
**Resource Requirements:** {{mvp_team_size_and_skills}}

### MVP Feature Set (Phase 1)

**Core User Journeys Supported:**
{{essential_journeys_for_mvp}}

**Must-Have Capabilities:**
{{list_of_essential_mvp_features}}

### Post-MVP Features

**Phase 2 (Post-MVP):**
{{planned_growth_features}}

**Phase 3 (Expansion):**
{{planned_expansion_features}}

### Risk Mitigation Strategy

**Technical Risks:** {{mitigation_approach}}
**Market Risks:** {{validation_approach}}
**Resource Risks:** {{contingency_approach}}
```

### 7. Present MENU OPTIONS

Present the scoping decisions for review, then display menu:
- Show strategic scoping plan (using structure from step 6)
- Highlight MVP boundaries and phased roadmap
- Ask if they'd like to refine further, get other perspectives, or proceed
- Present menu options naturally as part of conversation

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Functional Requirements (Step 9 of 11)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current scoping analysis, process the enhanced insights that come back, ask user if they accept the improvements, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the scoping context, process the collaborative insights on MVP and roadmap decisions, ask user if they accept the changes, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF C: Append the final content to {outputFile}, update frontmatter by adding this step name to the end of the stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 6.

## SUCCESS METRICS:

✅ Complete PRD document analyzed for scope implications
✅ Strategic MVP approach defined and justified
✅ Clear MVP feature boundaries established
✅ Phased development roadmap created
✅ Key risks identified and mitigation strategies defined
✅ User explicitly agrees to scope decisions
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Not analyzing the complete PRD before making scoping decisions
❌ Making scope decisions without strategic rationale
❌ Not getting explicit user agreement on MVP boundaries
❌ Missing critical risk analysis
❌ Not creating clear phased development approach
❌ Not presenting A/P/C menu after content generation

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load {nextStepFile}.

Remember: Do NOT proceed to step-09 until user explicitly selects 'C' from the A/P/C menu and content is saved!
