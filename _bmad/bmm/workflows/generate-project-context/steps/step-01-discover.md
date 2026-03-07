# Step 1: Context Discovery & Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input
- ✅ ALWAYS treat this as collaborative discovery between technical peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on discovering existing project context and technology stack
- 🎯 IDENTIFY critical implementation rules that AI agents need
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 📖 Read existing project files to understand current context
- 💾 Initialize document and update frontmatter
- 🚫 FORBIDDEN to load next step until discovery is complete

## CONTEXT BOUNDARIES:

- Variables from workflow.md are available in memory
- Focus on existing project files and architecture decisions
- Look for patterns, conventions, and unique requirements
- Prioritize rules that prevent implementation mistakes

## YOUR TASK:

Discover the project's technology stack, existing patterns, and critical implementation rules that AI agents must follow when writing code.

## DISCOVERY SEQUENCE:

### 1. Check for Existing Project Context

First, check if project context already exists:

- Look for file at `{project_knowledge}/project-context.md or {project-root}/**/project-context.md`
- If exists: Read complete file to understand existing rules
- Present to user: "Found existing project context with {number_of_sections} sections. Would you like to update this or create a new one?"

### 2. Discover Project Technology Stack

Load and analyze project files to identify technologies:

**Architecture Document:**

- Look for `{planning_artifacts}/architecture.md`
- Extract technology choices with specific versions
- Note architectural decisions that affect implementation

**Package Files:**

- Check for `package.json`, `requirements.txt`, `Cargo.toml`, etc.
- Extract exact versions of all dependencies
- Note development vs production dependencies

**Configuration Files:**

- Look for project language specific configs ( example: `tsconfig.json`)
- Build tool configs (webpack, vite, next.config.js, etc.)
- Linting and formatting configs (.eslintrc, .prettierrc, etc.)
- Testing configurations (jest.config.js, vitest.config.ts, etc.)

### 3. Identify Existing Code Patterns

Search through existing codebase for patterns:

**Naming Conventions:**

- File naming patterns (PascalCase, kebab-case, etc.)
- Component/function naming conventions
- Variable naming patterns
- Test file naming patterns

**Code Organization:**

- How components are structured
- Where utilities and helpers are placed
- How services are organized
- Test organization patterns

**Documentation Patterns:**

- Comment styles and conventions
- Documentation requirements
- README and API doc patterns

### 4. Extract Critical Implementation Rules

Look for rules that AI agents might miss:

**Language-Specific Rules:**

- TypeScript strict mode requirements
- Import/export conventions
- Async/await vs Promise usage patterns
- Error handling patterns specific to the language

**Framework-Specific Rules:**

- React hooks usage patterns
- API route conventions
- Middleware usage patterns
- State management patterns

**Testing Rules:**

- Test structure requirements
- Mock usage conventions
- Integration vs unit test boundaries
- Coverage requirements

**Development Workflow Rules:**

- Branch naming conventions
- Commit message patterns
- PR review requirements
- Deployment procedures

### 5. Initialize Project Context Document

Based on discovery, create or update the context document:

#### A. Fresh Document Setup (if no existing context)

Copy template from `{installed_path}/project-context-template.md` to `{output_folder}/project-context.md`
Initialize frontmatter fields.

#### B. Existing Document Update

Load existing context and prepare for updates
Set frontmatter `sections_completed` to track what will be updated

### 6. Present Discovery Summary

Report findings to user:

"Welcome {{user_name}}! I've analyzed your project for {{project_name}} to discover the context that AI agents need.

**Technology Stack Discovered:**
{{list_of_technologies_with_versions}}

**Existing Patterns Found:**

- {{number_of_patterns}} implementation patterns
- {{number_of_conventions}} coding conventions
- {{number_of_rules}} critical rules

**Key Areas for Context Rules:**

- {{area_1}} (e.g., TypeScript configuration)
- {{area_2}} (e.g., Testing patterns)
- {{area_3}} (e.g., Code organization)

{if_existing_context}
**Existing Context:** Found {{sections}} sections already defined. We can update or add to these.
{/if_existing_context}

Ready to create/update your project context. This will help AI agents implement code consistently with your project's standards.

[C] Continue to context generation"

## SUCCESS METRICS:

✅ Existing project context properly detected and handled
✅ Technology stack accurately identified with versions
✅ Critical implementation patterns discovered
✅ Project context document properly initialized
✅ Discovery findings clearly presented to user
✅ User ready to proceed with context generation

## FAILURE MODES:

❌ Not checking for existing project context before creating new one
❌ Missing critical technology versions or configurations
❌ Overlooking important coding patterns or conventions
❌ Not initializing frontmatter properly
❌ Not presenting clear discovery summary to user

## NEXT STEP:

After user selects [C] to continue, load `{project-root}/_bmad/bmm/workflows/generate-project-context/steps/step-02-generate.md` to collaboratively generate the specific project context rules.

Remember: Do NOT proceed to step-02 until user explicitly selects [C] from the menu and discovery is confirmed and the initial file has been written as directed in this discovery step!
