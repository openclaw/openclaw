# Step 3: Starter Template Evaluation

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input
- ✅ ALWAYS treat this as collaborative discovery between architectural peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on evaluating starter template options with current versions
- 🌐 ALWAYS search the web to verify current versions - NEVER trust hardcoded versions
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete architecture
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 🌐 Search the web to verify current versions and options
- ⚠️ Present A/P/C menu after generating starter template analysis
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to explore unconventional starter options or custom approaches
- **P (Party Mode)**: Bring multiple perspectives to evaluate starter trade-offs for different use cases
- **C (Continue)**: Save the content to the document and proceed to next step

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to display this step's A/P/C menu after the A or P have completed
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Project context from step 2 is available and complete
- Project context file from step-01 may contain technical preferences
- No architectural decisions made yet - evaluating foundations
- Focus on technical preferences discovery and starter evaluation
- Consider project requirements and existing preferences when evaluating options

## YOUR TASK:

Discover technical preferences and evaluate starter template options, leveraging existing technical preferences and establishing solid architectural foundations.

## STARTER EVALUATION SEQUENCE:

### 0. Check Technical Preferences & Context

**Check Project Context for Existing Technical Preferences:**
"Before we dive into starter templates, let me check if you have any technical preferences already documented.

{{if_project_context_exists}}
I found some technical rules in your project context file:
{{extracted_technical_preferences_from_project_context}}

**Project Context Technical Rules Found:**

- Languages/Frameworks: {{languages_frameworks_from_context}}
- Tools & Libraries: {{tools_from_context}}
- Development Patterns: {{patterns_from_context}}
- Platform Preferences: {{platforms_from_context}}

{{else}}
No existing technical preferences found in project context file. We'll establish your technical preferences now.
{{/if_project_context}}"

**Discover User Technical Preferences:**
"Based on your project context, let's discuss your technical preferences:

{{primary_technology_category}} Preferences:

- **Languages**: Do you have preferences between TypeScript/JavaScript, Python, Go, Rust, etc.?
- **Frameworks**: Any existing familiarity or preferences (React, Vue, Angular, Next.js, etc.)?
- **Databases**: Any preferences or existing infrastructure (PostgreSQL, MongoDB, MySQL, etc.)?

**Development Experience:**

- What's your team's experience level with different technologies?
- Are there any technologies you want to learn vs. what you're comfortable with?

**Platform/Deployment Preferences:**

- Cloud provider preferences (AWS, Vercel, Railway, etc.)?
- Container preferences (Docker, Serverless, Traditional)?

**Integrations:**

- Any existing systems or APIs you need to integrate with?
- Third-party services you plan to use (payment, authentication, analytics, etc.)?

These preferences will help me recommend the most suitable starter templates and guide our architectural decisions."

### 1. Identify Primary Technology Domain

Based on project context analysis and technical preferences, identify the primary technology stack:

- **Web application** → Look for Next.js, Vite, Remix, SvelteKit starters
- **Mobile app** → Look for React Native, Expo, Flutter starters
- **API/Backend** → Look for NestJS, Express, Fastify, Supabase starters
- **CLI tool** → Look for CLI framework starters (oclif, commander, etc.)
- **Full-stack** → Look for T3, RedwoodJS, Blitz, Next.js starters
- **Desktop** → Look for Electron, Tauri starters

### 2. UX Requirements Consideration

If UX specification was loaded, consider UX requirements when selecting starter:

- **Rich animations** → Framer Motion compatible starter
- **Complex forms** → React Hook Form included starter
- **Real-time features** → Socket.io or WebSocket ready starter
- **Design system** → Storybook-enabled starter
- **Offline capability** → Service worker or PWA configured starter

### 3. Research Current Starter Options

Search the web to find current, maintained starter templates:

```
Search the web: "{{primary_technology}} starter template CLI create command latest"
Search the web: "{{primary_technology}} boilerplate generator latest options"
Search the web: "{{primary_technology}} production-ready starter best practices"
```

### 4. Investigate Top Starter Options

For each promising starter found, investigate details:

```
Search the web: "{{starter_name}} default setup technologies included latest"
Search the web: "{{starter_name}} project structure file organization"
Search the web: "{{starter_name}} production deployment capabilities"
Search the web: "{{starter_name}} recent updates maintenance status"
```

### 5. Analyze What Each Starter Provides

For each viable starter option, document:

**Technology Decisions Made:**

- Language/TypeScript configuration
- Styling solution (CSS, Tailwind, Styled Components, etc.)
- Testing framework setup
- Linting/Formatting configuration
- Build tooling and optimization
- Project structure and organization

**Architectural Patterns Established:**

- Code organization patterns
- Component structure conventions
- API layering approach
- State management setup
- Routing patterns
- Environment configuration

**Development Experience Features:**

- Hot reloading and development server
- TypeScript configuration
- Debugging setup
- Testing infrastructure
- Documentation generation

### 6. Present Starter Options

Based on user skill level and project needs:

**For Expert Users:**
"Found {{starter_name}} which provides:
{{quick_decision_list_of_key_decisions}}

This would establish our base architecture with these technical decisions already made. Use it?"

**For Intermediate Users:**
"I found {{starter_name}}, which is a well-maintained starter for {{project_type}} projects.

It makes these architectural decisions for us:
{{decision_list_with_explanations}}

This gives us a solid foundation following current best practices. Should we use it?"

**For Beginner Users:**
"I found {{starter_name}}, which is like a pre-built foundation for your project.

Think of it like buying a prefab house frame instead of cutting each board yourself.

It makes these decisions for us:
{{friendly_explanation_of_decisions}}

This is a great starting point that follows best practices and saves us from making dozens of small technical choices. Should we use it?"

### 7. Get Current CLI Commands

If user shows interest in a starter, get the exact current commands:

```
Search the web: "{{starter_name}} CLI command options flags latest"
Search the web: "{{starter_name}} create new project command examples"
```

### 8. Generate Starter Template Content

Prepare the content to append to the document:

#### Content Structure:

````markdown
## Starter Template Evaluation

### Primary Technology Domain

{{identified_domain}} based on project requirements analysis

### Starter Options Considered

{{analysis_of_evaluated_starters}}

### Selected Starter: {{starter_name}}

**Rationale for Selection:**
{{why_this_starter_was_chosen}}

**Initialization Command:**

```bash
{{full_starter_command_with_options}}
```

**Architectural Decisions Provided by Starter:**

**Language & Runtime:**
{{language_typescript_setup}}

**Styling Solution:**
{{styling_solution_configuration}}

**Build Tooling:**
{{build_tools_and_optimization}}

**Testing Framework:**
{{testing_setup_and_configuration}}

**Code Organization:**
{{project_structure_and_patterns}}

**Development Experience:**
{{development_tools_and_workflow}}

**Note:** Project initialization using this command should be the first implementation story.

````

### 9. Present Content and Menu

Show the generated content and present choices:

"I've analyzed starter template options for {{project_type}} projects.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 8]

**What would you like to do?**
[A] Advanced Elicitation - Explore custom approaches or unconventional starters
[P] Party Mode - Evaluate trade-offs from different perspectives
[C] Continue - Save this decision and move to architectural decisions"

### 10. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with current starter analysis
- Process enhanced insights about starter options or custom approaches
- Ask user: "Accept these changes to the starter template evaluation? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with starter evaluation context
- Process collaborative insights about starter trade-offs
- Ask user: "Accept these changes to the starter template evaluation? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/architecture.md`
- Update frontmatter: `stepsCompleted: [1, 2, 3]`
- Load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 8.

## SUCCESS METRICS:

✅ Primary technology domain correctly identified from project context
✅ Current, maintained starter templates researched and evaluated
✅ All versions verified using web search, not hardcoded
✅ Architectural implications of starter choice clearly documented
✅ User provided with clear rationale for starter selection
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Not verifying current versions with web search
❌ Ignoring UX requirements when evaluating starters
❌ Not documenting what architectural decisions the starter makes
❌ Failing to consider maintenance status of starter templates
❌ Not providing clear rationale for starter selection
❌ Not presenting A/P/C menu after content generation
❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-04-decisions.md` to begin making specific architectural decisions.

Remember: Do NOT proceed to step-04 until user explicitly selects 'C' from the A/P/C menu and content is saved!
