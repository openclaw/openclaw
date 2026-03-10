# Step 5: UX Pattern Analysis & Inspiration

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between UX facilitator and stakeholder
- 📋 YOU ARE A UX FACILITATOR, not a content generator
- 💬 FOCUS on analyzing existing UX patterns and extracting inspiration
- 🎯 COLLABORATIVE discovery, not assumption-based design
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating inspiration analysis content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step to the end of the list of stepsCompleted.
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to develop deeper pattern insights
- **P ( Party Mode)**: Bring multiple perspectives to analyze UX patterns
- **C (Continue)**: Save the content to the document and proceed to next step

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to this step's A/P/C menu
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Emotional response goals from step 4 inform pattern analysis
- No additional data files needed for this step
- Focus on analyzing existing UX patterns and extracting lessons

## YOUR TASK:

Analyze inspiring products and UX patterns to inform design decisions for the current project.

## INSPIRATION ANALYSIS SEQUENCE:

### 1. Identify User's Favorite Apps

Start by gathering inspiration sources:
"Let's learn from products your users already love and use regularly.

**Inspiration Questions:**

- Name 2-3 apps your target users already love and USE frequently
- For each one, what do they do well from a UX perspective?
- What makes the experience compelling or delightful?
- What keeps users coming back to these apps?

Think about apps in your category or even unrelated products that have great UX."

### 2. Analyze UX Patterns and Principles

Break down what makes these apps successful:
"For each inspiring app, let's analyze their UX success:

**For [App Name]:**

- What core problem does it solve elegantly?
- What makes the onboarding experience effective?
- How do they handle navigation and information hierarchy?
- What are their most innovative or delightful interactions?
- What visual design choices support the user experience?
- How do they handle errors or edge cases?"

### 3. Extract Transferable Patterns

Identify patterns that could apply to your project:
"**Transferable UX Patterns:**
Looking across these inspiring apps, I see patterns we could adapt:

**Navigation Patterns:**

- [Pattern 1] - could work for your [specific use case]
- [Pattern 2] - might solve your [specific challenge]

**Interaction Patterns:**

- [Pattern 1] - excellent for [your user goal]
- [Pattern 2] - addresses [your user pain point]

**Visual Patterns:**

- [Pattern 1] - supports your [emotional goal]
- [Pattern 2] - aligns with your [platform requirements]

Which of these patterns resonate most for your product?"

### 4. Identify Anti-Patterns to Avoid

Surface what not to do based on analysis:
"**UX Anti-Patterns to Avoid:**
From analyzing both successes and failures in your space, here are patterns to avoid:

- [Anti-pattern 1] - users find this confusing/frustrating
- [Anti-pattern 2] - this creates unnecessary friction
- [Anti-pattern 3] - doesn't align with your [emotional goals]

Learning from others' mistakes is as important as learning from their successes."

### 5. Define Design Inspiration Strategy

Create a clear strategy for using this inspiration:
"**Design Inspiration Strategy:**

**What to Adopt:**

- [Specific pattern] - because it supports [your core experience]
- [Specific pattern] - because it aligns with [user needs]

**What to Adapt:**

- [Specific pattern] - modify for [your unique requirements]
- [Specific pattern] - simplify for [your user skill level]

**What to Avoid:**

- [Specific anti-pattern] - conflicts with [your goals]
- [Specific anti-pattern] - doesn't fit [your platform]

This strategy will guide our design decisions while keeping {{project_name}} unique."

### 6. Generate Inspiration Analysis Content

Prepare the content to append to the document:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## UX Pattern Analysis & Inspiration

### Inspiring Products Analysis

[Analysis of inspiring products based on conversation]

### Transferable UX Patterns

[Transferable patterns identified based on conversation]

### Anti-Patterns to Avoid

[Anti-patterns to avoid based on conversation]

### Design Inspiration Strategy

[Strategy for using inspiration based on conversation]
```

### 7. Present Content and Menu

Show the generated inspiration analysis content and present choices:
"I've analyzed inspiring UX patterns and products to inform our design strategy for {{project_name}}. This gives us a solid foundation of proven patterns to build upon.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 6]

**What would you like to do?**
[A] Advanced Elicitation - Let's deepen our UX pattern analysis
[P] Party Mode - Bring different perspectives on inspiration sources
[C] Continue - Save this to the document and move to design system choice"

### 8. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with the current inspiration analysis content
- Process the enhanced pattern insights that come back
- Ask user: "Accept these improvements to the inspiration analysis? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with the current inspiration analysis
- Process the collaborative pattern insights that come back
- Ask user: "Accept these changes to the inspiration analysis? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/ux-design-specification.md`
- Update frontmatter: append step to end of stepsCompleted array
- Read fully and follow: `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-06-design-system.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 6.

## SUCCESS METRICS:

✅ Inspiring products identified and analyzed thoroughly
✅ UX patterns extracted and categorized effectively
✅ Transferable patterns identified for current project
✅ Anti-patterns identified to avoid common mistakes
✅ Clear design inspiration strategy established
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Not getting specific examples of inspiring products
❌ Surface-level analysis without deep pattern extraction
❌ Missing opportunities for pattern adaptation
❌ Not identifying relevant anti-patterns to avoid
❌ Strategy too generic or not actionable
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-06-design-system.md` to choose the appropriate design system approach.

Remember: Do NOT proceed to step-06 until user explicitly selects 'C' from the A/P/C menu and content is saved!
