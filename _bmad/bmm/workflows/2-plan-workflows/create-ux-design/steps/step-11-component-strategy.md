# Step 11: Component Strategy

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between UX facilitator and stakeholder
- 📋 YOU ARE A UX FACILITATOR, not a content generator
- 💬 FOCUS on defining component library strategy and custom components
- 🎯 COLLABORATIVE component planning, not assumption-based design
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- ⚠️ Present A/P/C menu after generating component strategy content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update output file frontmatter, adding this step to the end of the list of stepsCompleted.
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to develop deeper component insights
- **P (Party Mode)**: Bring multiple perspectives to define component strategy
- **C (Continue)**: Save the content to the document and proceed to next step

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to this step's A/P/C menu
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Current document and frontmatter from previous steps are available
- Design system choice from step 6 determines available components
- User journeys from step 10 identify component needs
- Focus on defining custom components and implementation strategy

## YOUR TASK:

Define component library strategy and design custom components not covered by the design system.

## COMPONENT STRATEGY SEQUENCE:

### 1. Analyze Design System Coverage

Review what components are available vs. needed:
"Based on our chosen design system [design system from step 6], let's identify what components are already available and what we need to create custom.

**Available from Design System:**
[List of components available in chosen design system]

**Components Needed for {{project_name}}:**
Looking at our user journeys and design direction, we need:

- [Component need 1 from journey analysis]
- [Component need 2 from design requirements]
- [Component need 3 from core experience]

**Gap Analysis:**

- [Gap 1 - needed but not available]
- [Gap 2 - needed but not available]"

### 2. Design Custom Components

For each custom component needed, design thoroughly:

**For each custom component:**
"**[Component Name] Design:**

**Purpose:** What does this component do for users?
**Content:** What information or data does it display?
**Actions:** What can users do with this component?
**States:** What different states does it have? (default, hover, active, disabled, error, etc.)
**Variants:** Are there different sizes or styles needed?
**Accessibility:** What ARIA labels and keyboard support needed?

Let's walk through each custom component systematically."

### 3. Document Component Specifications

Create detailed specifications for each component:

**Component Specification Template:**

```markdown
### [Component Name]

**Purpose:** [Clear purpose statement]
**Usage:** [When and how to use]
**Anatomy:** [Visual breakdown of parts]
**States:** [All possible states with descriptions]
**Variants:** [Different sizes/styles if applicable]
**Accessibility:** [ARIA labels, keyboard navigation]
**Content Guidelines:** [What content works best]
**Interaction Behavior:** [How users interact]
```

### 4. Define Component Strategy

Establish overall component library approach:
"**Component Strategy:**

**Foundation Components:** (from design system)

- [Foundation component 1]
- [Foundation component 2]

**Custom Components:** (designed in this step)

- [Custom component 1 with rationale]
- [Custom component 2 with rationale]

**Implementation Approach:**

- Build custom components using design system tokens
- Ensure consistency with established patterns
- Follow accessibility best practices
- Create reusable patterns for common use cases"

### 5. Plan Implementation Roadmap

Define how and when to build components:
"**Implementation Roadmap:**

**Phase 1 - Core Components:**

- [Component 1] - needed for [critical flow]
- [Component 2] - needed for [critical flow]

**Phase 2 - Supporting Components:**

- [Component 3] - enhances [user experience]
- [Component 4] - supports [design pattern]

**Phase 3 - Enhancement Components:**

- [Component 5] - optimizes [user journey]
- [Component 6] - adds [special feature]

This roadmap helps prioritize development based on user journey criticality."

### 6. Generate Component Strategy Content

Prepare the content to append to the document:

#### Content Structure:

When saving to document, append these Level 2 and Level 3 sections:

```markdown
## Component Strategy

### Design System Components

[Analysis of available design system components based on conversation]

### Custom Components

[Custom component specifications based on conversation]

### Component Implementation Strategy

[Component implementation strategy based on conversation]

### Implementation Roadmap

[Implementation roadmap based on conversation]
```

### 7. Present Content and Menu

Show the generated component strategy content and present choices:
"I've defined the component strategy for {{project_name}}. This balances using proven design system components with custom components for your unique needs.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 6]

**What would you like to do?**
[A] Advanced Elicitation - Let's refine our component strategy
[P] Party Mode - Bring technical perspectives on component design
[C] Continue - Save this to the document and move to UX patterns

### 8. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with the current component strategy content
- Process the enhanced component insights that come back
- Ask user: "Accept these improvements to the component strategy? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with the current component strategy
- Process the collaborative component insights that come back
- Ask user: "Accept these changes to the component strategy? (y/n)"
- If yes: Update content with improvements, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/ux-design-specification.md`
- Update frontmatter: append step to end of stepsCompleted array
- Load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-12-ux-patterns.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 6.

## SUCCESS METRICS:

✅ Design system coverage properly analyzed
✅ All custom components thoroughly specified
✅ Component strategy clearly defined
✅ Implementation roadmap prioritized by user need
✅ Accessibility considered for all components
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Not analyzing design system coverage properly
❌ Custom components not thoroughly specified
❌ Missing accessibility considerations
❌ Component strategy not aligned with user journeys
❌ Implementation roadmap not prioritized effectively
❌ Not presenting A/P/C menu after content generation
❌ Appending content without user selecting 'C'

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/2-plan-workflows/create-ux-design/steps/step-12-ux-patterns.md` to define UX consistency patterns.

Remember: Do NOT proceed to step-12 until user explicitly selects 'C' from the A/P/C menu and content is saved!
