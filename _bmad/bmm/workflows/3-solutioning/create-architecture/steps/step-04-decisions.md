# Step 4: Core Architectural Decisions

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between architectural peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on making critical architectural decisions collaboratively
- 🌐 ALWAYS search the web to verify current technology versions
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 🌐 Search the web to verify technology versions and options
- ⚠️ Present A/P/C menu after each major decision category
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices for each decision category:

- **A (Advanced Elicitation)**: Use discovery protocols to explore innovative approaches to specific decisions
- **P (Party Mode)**: Bring multiple perspectives to evaluate decision trade-offs
- **C (Continue)**: Save the current decisions and proceed to next decision category

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to display this step's A/P/C menu after the A or P have completed
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Project context from step 2 is available
- Starter template choice from step 3 is available
- Project context file may contain technical preferences and rules
- Technical preferences discovered in step 3 are available
- Focus on decisions not already made by starter template or existing preferences
- Collaborative decision making, not recommendations

## YOUR TASK:

Facilitate collaborative architectural decision making, leveraging existing technical preferences and starter template decisions, focusing on remaining choices critical to the project's success.

## DECISION MAKING SEQUENCE:

### 1. Load Decision Framework & Check Existing Preferences

**Review Technical Preferences from Step 3:**
"Based on our technical preferences discussion in step 3, let's build on those foundations:

**Your Technical Preferences:**
{{user_technical_preferences_from_step_3}}

**Starter Template Decisions:**
{{starter_template_decisions}}

**Project Context Technical Rules:**
{{project_context_technical_rules}}"

**Identify Remaining Decisions:**
Based on technical preferences, starter template choice, and project context, identify remaining critical decisions:

**Already Decided (Don't re-decide these):**

- {{starter_template_decisions}}
- {{user_technology_preferences}}
- {{project_context_technical_rules}}

**Critical Decisions:** Must be decided before implementation can proceed
**Important Decisions:** Shape the architecture significantly
**Nice-to-Have:** Can be deferred if needed

### 2. Decision Categories by Priority

#### Category 1: Data Architecture

- Database choice (if not determined by starter)
- Data modeling approach
- Data validation strategy
- Migration approach
- Caching strategy

#### Category 2: Authentication & Security

- Authentication method
- Authorization patterns
- Security middleware
- Data encryption approach
- API security strategy

#### Category 3: API & Communication

- API design patterns (REST, GraphQL, etc.)
- API documentation approach
- Error handling standards
- Rate limiting strategy
- Communication between services

#### Category 4: Frontend Architecture (if applicable)

- State management approach
- Component architecture
- Routing strategy
- Performance optimization
- Bundle optimization

#### Category 5: Infrastructure & Deployment

- Hosting strategy
- CI/CD pipeline approach
- Environment configuration
- Monitoring and logging
- Scaling strategy

### 3. Facilitate Each Decision Category

For each category, facilitate collaborative decision making:

**Present the Decision:**
Based on user skill level and project context:

**Expert Mode:**
"{{Decision_Category}}: {{Specific_Decision}}

Options: {{concise_option_list_with_tradeoffs}}

What's your preference for this decision?"

**Intermediate Mode:**
"Next decision: {{Human_Friendly_Category}}

We need to choose {{Specific_Decision}}.

Common options:
{{option_list_with_brief_explanations}}

For your project, I'd lean toward {{recommendation}} because {{reason}}. What are your thoughts?"

**Beginner Mode:**
"Let's talk about {{Human_Friendly_Category}}.

{{Educational_Context_About_Why_This_Matters}}

Think of it like {{real_world_analogy}}.

Your main options:
{{friendly_options_with_pros_cons}}

My suggestion: {{recommendation}}
This is good for you because {{beginner_friendly_reason}}.

What feels right to you?"

**Verify Technology Versions:**
If decision involves specific technology:

```
Search the web: "{{technology}} latest stable version"
Search the web: "{{technology}} current LTS version"
Search the web: "{{technology}} production readiness"
```

**Get User Input:**
"What's your preference? (or 'explain more' for details)"

**Handle User Response:**

- If user wants more info: Provide deeper explanation
- If user has preference: Discuss implications and record decision
- If user wants alternatives: Explore other options

**Record the Decision:**

- Category: {{category}}
- Decision: {{user_choice}}
- Version: {{verified_version_if_applicable}}
- Rationale: {{user_reasoning_or_default}}
- Affects: {{components_or_epics}}
- Provided by Starter: {{yes_if_from_starter}}

### 4. Check for Cascading Implications

After each major decision, identify related decisions:

"This choice means we'll also need to decide:

- {{related_decision_1}}
- {{related_decision_2}}"

### 5. Generate Decisions Content

After facilitating all decision categories, prepare the content to append:

#### Content Structure:

```markdown
## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions (Block Implementation):**
{{critical_decisions_made}}

**Important Decisions (Shape Architecture):**
{{important_decisions_made}}

**Deferred Decisions (Post-MVP):**
{{decisions_deferred_with_rationale}}

### Data Architecture

{{data_related_decisions_with_versions_and_rationale}}

### Authentication & Security

{{security_related_decisions_with_versions_and_rationale}}

### API & Communication Patterns

{{api_related_decisions_with_versions_and_rationale}}

### Frontend Architecture

{{frontend_related_decisions_with_versions_and_rationale}}

### Infrastructure & Deployment

{{infrastructure_related_decisions_with_versions_and_rationale}}

### Decision Impact Analysis

**Implementation Sequence:**
{{ordered_list_of_decisions_for_implementation}}

**Cross-Component Dependencies:**
{{how_decisions_affect_each_other}}
```

### 6. Present Content and Menu

Show the generated decisions content and present choices:

"I've documented all the core architectural decisions we've made together.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 5]

**What would you like to do?**
[A] Advanced Elicitation - Explore innovative approaches to any specific decisions
[P] Party Mode - Review decisions from multiple perspectives
[C] Continue - Save these decisions and move to implementation patterns"

### 7. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with specific decision categories
- Process enhanced insights about particular decisions
- Ask user: "Accept these enhancements to the architectural decisions? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with architectural decisions context
- Process collaborative insights about decision trade-offs
- Ask user: "Accept these changes to the architectural decisions? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/architecture.md`
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4]`
- Load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 5.

## SUCCESS METRICS:

✅ All critical architectural decisions made collaboratively
✅ Technology versions verified using web search
✅ Decision rationale clearly documented
✅ Cascading implications identified and addressed
✅ User provided appropriate level of explanation for skill level
✅ A/P/C menu presented and handled correctly for each category
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Making recommendations instead of facilitating decisions
❌ Not verifying technology versions with web search
❌ Missing cascading implications between decisions
❌ Not adapting explanations to user skill level
❌ Forgetting to document decisions made by starter template
❌ Not presenting A/P/C menu after content generation

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-05-patterns.md` to define implementation patterns that ensure consistency across AI agents.

Remember: Do NOT proceed to step-05 until user explicitly selects 'C' from the A/P/C menu and content is saved!
