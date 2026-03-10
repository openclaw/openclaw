---
name: 'step-03-success'
description: 'Define comprehensive success criteria covering user, business, and technical success'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-04-journeys.md'
outputFile: '{planning_artifacts}/prd.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 3: Success Criteria Definition

**Progress: Step 3 of 11** - Next: User Journey Mapping

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between PM peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on defining what winning looks like for this product
- 🎯 COLLABORATIVE discovery, not assumption-based goal setting
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating success criteria content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step name to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Executive Summary and Project Classification already exist in document
- Input documents from step-01 are available (product briefs, research, brainstorming)
- No additional data files needed for this step
- Focus on measurable, specific success criteria
- LEVERAGE existing input documents to inform success criteria

## YOUR TASK:

Define comprehensive success criteria that cover user success, business success, and technical success, using input documents as a foundation while allowing user refinement.

## SUCCESS DISCOVERY SEQUENCE:

### 1. Begin Success Definition Conversation

**Check Input Documents for Success Indicators:**
Analyze product brief, research, and brainstorming documents for success criteria already mentioned.

**If Input Documents Contain Success Criteria:**
Guide user to refine existing success criteria:
- Acknowledge what's already documented in their materials
- Extract key success themes from brief, research, and brainstorming
- Help user identify gaps and areas for expansion
- Probe for specific, measurable outcomes: When do users feel delighted/relieved/empowered?
- Ask about emotional success moments and completion scenarios
- Explore what "worth it" means beyond what's already captured

**If No Success Criteria in Input Documents:**
Start with user-centered success exploration:
- Guide conversation toward defining what "worth it" means for users
- Ask about the moment users realize their problem is solved
- Explore specific user outcomes and emotional states
- Identify success "aha!" moments and completion scenarios
- Focus on user experience of success first

### 2. Explore User Success Metrics

Listen for specific user outcomes and help make them measurable:

- Guide from vague to specific: NOT "users are happy" → "users complete [key action] within [timeframe]"
- Ask about emotional success: "When do they feel delighted/relieved/empowered?"
- Identify success moments: "What's the 'aha!' moment?"
- Define completion scenarios: "What does 'done' look like for the user?"

### 3. Define Business Success

Transition to business metrics:
- Guide conversation to business perspective on success
- Explore timelines: What does 3-month success look like? 12-month success?
- Identify key business metrics: revenue, user growth, engagement, or other measures?
- Ask what specific metric would indicate "this is working"
- Understand business success from their perspective

### 4. Challenge Vague Metrics

Push for specificity on business metrics:

- "10,000 users" → "What kind of users? Doing what?"
- "99.9% uptime" → "What's the real concern - data loss? Failed payments?"
- "Fast" → "How fast, and what specifically needs to be fast?"
- "Good adoption" → "What percentage adoption by when?"

### 5. Connect to Product Differentiator

Tie success metrics back to what makes the product special:
- Connect success criteria to the product's unique differentiator
- Ensure metrics reflect the specific value proposition
- Adapt success criteria to domain context:
  - Consumer: User love, engagement, retention
  - B2B: ROI, efficiency, adoption
  - Developer tools: Developer experience, community
  - Regulated: Compliance, safety, validation
  - GovTech: Government compliance, accessibility, procurement

### 6. Smart Scope Negotiation

Guide scope definition through success lens:
- Help user distinguish MVP (must work to be useful) from growth (competitive) and vision (dream)
- Guide conversation through three scope levels:
  1. MVP: What's essential for proving the concept?
  2. Growth: What makes it competitive?
  3. Vision: What's the dream version?
- Challenge scope creep conversationally: Could this wait until after launch? Is this essential for MVP?
- For complex domains: Ensure compliance minimums are included in MVP

### 7. Generate Success Criteria Content

Prepare the content to append to the document:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Success Criteria

### User Success

[Content about user success criteria based on conversation]

### Business Success

[Content about business success metrics based on conversation]

### Technical Success

[Content about technical success requirements based on conversation]

### Measurable Outcomes

[Content about specific measurable outcomes based on conversation]

## Product Scope

### MVP - Minimum Viable Product

[Content about MVP scope based on conversation]

### Growth Features (Post-MVP)

[Content about growth features based on conversation]

### Vision (Future)

[Content about future vision based on conversation]
```

### 8. Present MENU OPTIONS

Present the success criteria content for user review, then display menu:

- Show the drafted success criteria and scope definition (using structure from section 7)
- Ask if they'd like to refine further, get other perspectives, or proceed
- Present menu options naturally as part of the conversation

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to User Journey Mapping (Step 4 of 11)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current success criteria content, process the enhanced success metrics that come back, ask user "Accept these improvements to the success criteria? (y/n)", if yes update content with improvements then redisplay menu, if no keep original content then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the current success criteria, process the collaborative improvements to metrics and scope, ask user "Accept these changes to the success criteria? (y/n)", if yes update content with improvements then redisplay menu, if no keep original content then redisplay menu
- IF C: Append the final content to {outputFile}, update frontmatter by adding this step name to the end of the stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 7.

## SUCCESS METRICS:

✅ User success criteria clearly identified and made measurable
✅ Business success metrics defined with specific targets
✅ Success criteria connected to product differentiator
✅ Scope properly negotiated (MVP, Growth, Vision)
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Accepting vague success metrics without pushing for specificity
❌ Not connecting success criteria back to product differentiator
❌ Missing scope negotiation and leaving it undefined
❌ Generating content without real user input on what success looks like
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## DOMAIN CONSIDERATIONS:

If working in regulated domains (healthcare, fintech, govtech):

- Include compliance milestones in success criteria
- Add regulatory approval timelines to MVP scope
- Consider audit requirements as technical success metrics

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-04-journeys.md` to map user journeys.

Remember: Do NOT proceed to step-04 until user explicitly selects 'C' from the A/P/C menu and content is saved!
