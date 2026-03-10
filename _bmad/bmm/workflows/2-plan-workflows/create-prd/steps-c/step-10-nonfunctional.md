---
name: 'step-10-nonfunctional'
description: 'Define quality attributes that matter for this specific product'

# File References
nextStepFile: '{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-prd/steps-c/step-11-polish.md'
outputFile: '{planning_artifacts}/prd.md'

# Task References
advancedElicitationTask: '{project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml'
partyModeWorkflow: '{project-root}/_bmad/core/workflows/party-mode/workflow.md'
---

# Step 10: Non-Functional Requirements

**Progress: Step 10 of 12** - Next: Polish Document

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between PM peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on quality attributes that matter for THIS specific product
- 🎯 SELECTIVE: Only document NFRs that actually apply to the product
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating NFR content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step name to the end of the list of stepsCompleted
- 🚫 FORBIDDEN to load next step until C is selected


## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Functional requirements already defined and will inform NFRs
- Domain and project-type context will guide which NFRs matter
- Focus on specific, measurable quality criteria

## YOUR TASK:

Define non-functional requirements that specify quality attributes for the product, focusing only on what matters for THIS specific product.

## NON-FUNCTIONAL REQUIREMENTS SEQUENCE:

### 1. Explain NFR Purpose and Scope

Start by clarifying what NFRs are and why we're selective:

**NFR Purpose:**
NFRs define HOW WELL the system must perform, not WHAT it must do. They specify quality attributes like performance, security, scalability, etc.

**Selective Approach:**
We only document NFRs that matter for THIS product. If a category doesn't apply, we skip it entirely. This prevents requirement bloat and focuses on what's actually important.

### 2. Assess Product Context for NFR Relevance

Evaluate which NFR categories matter based on product context:

**Quick Assessment Questions:**

- **Performance**: Is there user-facing impact of speed?
- **Security**: Are we handling sensitive data or payments?
- **Scalability**: Do we expect rapid user growth?
- **Accessibility**: Are we serving broad public audiences?
- **Integration**: Do we need to connect with other systems?
- **Reliability**: Would downtime cause significant problems?

### 3. Explore Relevant NFR Categories

For each relevant category, conduct targeted discovery:

#### Performance NFRs (If relevant):

Explore performance requirements:
- What parts of the system need to be fast for users to be successful?
- Are there specific response time expectations?
- What happens if performance is slower than expected?
- Are there concurrent user scenarios we need to support?

#### Security NFRs (If relevant):

Explore security requirements:
- What data needs to be protected?
- Who should have access to what?
- What are the security risks we need to mitigate?
- Are there compliance requirements (GDPR, HIPAA, PCI-DSS)?

#### Scalability NFRs (If relevant):

Explore scalability requirements:
- How many users do we expect initially? Long-term?
- Are there seasonal or event-based traffic spikes?
- What happens if we exceed our capacity?
- What growth scenarios should we plan for?

#### Accessibility NFRs (If relevant):

Explore accessibility requirements:
- Are we serving users with visual, hearing, or motor impairments?
- Are there legal accessibility requirements (WCAG, Section 508)?
- What accessibility features are most important for our users?

#### Integration NFRs (If relevant):

Explore integration requirements:
- What external systems do we need to connect with?
- Are there APIs or data formats we must support?
- How reliable do these integrations need to be?

### 4. Make NFRs Specific and Measurable

For each relevant NFR category, ensure criteria are testable:

**From Vague to Specific:**

- NOT: "The system should be fast" → "User actions complete within 2 seconds"
- NOT: "The system should be secure" → "All data is encrypted at rest and in transit"
- NOT: "The system should scale" → "System supports 10x user growth with <10% performance degradation"

### 5. Generate NFR Content (Only Relevant Categories)

Prepare the content to append to the document:

#### Content Structure (Dynamic based on relevance):

When saving to document, append these Level 2 and Level 3 sections (only include sections that are relevant):

```markdown
## Non-Functional Requirements

### Performance

[Performance requirements based on conversation - only include if relevant]

### Security

[Security requirements based on conversation - only include if relevant]

### Scalability

[Scalability requirements based on conversation - only include if relevant]

### Accessibility

[Accessibility requirements based on conversation - only include if relevant]

### Integration

[Integration requirements based on conversation - only include if relevant]
```

### 6. Present MENU OPTIONS

Present the non-functional requirements for review, then display menu:
- Show defined NFRs (using structure from step 5)
- Note that only relevant categories were included
- Emphasize NFRs specify how well the system needs to perform
- Ask if they'd like to refine further, get other perspectives, or proceed
- Present menu options naturally as part of conversation

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Polish Document (Step 11 of 12)"

#### Menu Handling Logic:
- IF A: Read fully and follow: {advancedElicitationTask} with the current NFR content, process the enhanced quality attribute insights that come back, ask user if they accept the improvements, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF P: Read fully and follow: {partyModeWorkflow} with the current NFR list, process the collaborative technical validation and additions, ask user if they accept the changes, if yes update content then redisplay menu, if no keep original content then redisplay menu
- IF C: Append the final content to {outputFile}, update frontmatter by adding this step name to the end of the stepsCompleted array, then read fully and follow: {nextStepFile}
- IF Any other: help user respond, then redisplay menu

#### EXECUTION RULES:
- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 5.

## SUCCESS METRICS:

✅ Only relevant NFR categories documented (no requirement bloat)
✅ Each NFR is specific and measurable
✅ NFRs connected to actual user needs and business context
✅ Vague requirements converted to testable criteria
✅ Domain-specific compliance requirements included if relevant
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Documenting NFR categories that don't apply to the product
❌ Leaving requirements vague and unmeasurable
❌ Not connecting NFRs to actual user or business needs
❌ Missing domain-specific compliance requirements
❌ Creating overly prescriptive technical requirements
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NFR CATEGORY GUIDANCE:

**Include Performance When:**

- User-facing response times impact success
- Real-time interactions are critical
- Performance is a competitive differentiator

**Include Security When:**

- Handling sensitive user data
- Processing payments or financial information
- Subject to compliance regulations
- Protecting intellectual property

**Include Scalability When:**

- Expecting rapid user growth
- Handling variable traffic patterns
- Supporting enterprise-scale usage
- Planning for market expansion

**Include Accessibility When:**

- Serving broad public audiences
- Subject to accessibility regulations
- Targeting users with disabilities
- B2B customers with accessibility requirements

## NEXT STEP:

After user selects 'C' and content is saved to document, load {nextStepFile} to finalize the PRD and complete the workflow.

Remember: Do NOT proceed to step-11 until user explicitly selects 'C' from the A/P/C menu and content is saved!
