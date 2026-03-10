# Step 5: Implementation Patterns & Consistency Rules

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input

- 📖 CRITICAL: ALWAYS read the complete step file before taking any action - partial understanding leads to incomplete decisions
- 🔄 CRITICAL: When loading next step with 'C', ensure the entire file is read and understood before proceeding
- ✅ ALWAYS treat this as collaborative discovery between architectural peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on patterns that prevent AI agent implementation conflicts
- 🎯 EMPHASIZE what agents could decide DIFFERENTLY if not specified
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 🎯 Focus on consistency, not implementation details
- ⚠️ Present A/P/C menu after generating patterns content
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter `stepsCompleted: [1, 2, 3, 4, 5]` before loading next step
- 🚫 FORBIDDEN to load next step until C is selected

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices:

- **A (Advanced Elicitation)**: Use discovery protocols to develop comprehensive consistency patterns
- **P (Party Mode)**: Bring multiple perspectives to identify potential conflict points
- **C (Continue)**: Save the patterns and proceed to project structure

## PROTOCOL INTEGRATION:

- When 'A' selected: Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml
- When 'P' selected: Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md
- PROTOCOLS always return to display this step's A/P/C menu after the A or P have completed
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Core architectural decisions from step 4 are complete
- Technology stack is decided and versions are verified
- Focus on HOW agents should implement, not WHAT they should implement
- Consider what could vary between different AI agents

## YOUR TASK:

Define implementation patterns and consistency rules that ensure multiple AI agents write compatible, consistent code that works together seamlessly.

## PATTERNS DEFINITION SEQUENCE:

### 1. Identify Potential Conflict Points

Based on the chosen technology stack and decisions, identify where AI agents could make different choices:

**Naming Conflicts:**

- Database table/column naming conventions
- API endpoint naming patterns
- File and directory naming
- Component/function/variable naming
- Route parameter formats

**Structural Conflicts:**

- Where tests are located
- How components are organized
- Where utilities and helpers go
- Configuration file organization
- Static asset organization

**Format Conflicts:**

- API response wrapper formats
- Error response structures
- Date/time formats in APIs and UI
- JSON field naming conventions
- API status code usage

**Communication Conflicts:**

- Event naming conventions
- Event payload structures
- State update patterns
- Action naming conventions
- Logging formats and levels

**Process Conflicts:**

- Loading state handling
- Error recovery patterns
- Retry implementation approaches
- Authentication flow patterns
- Validation timing and methods

### 2. Facilitate Pattern Decisions

For each conflict category, facilitate collaborative pattern definition:

**Present the Conflict Point:**
"Given that we're using {{tech_stack}}, different AI agents might handle {{conflict_area}} differently.

For example, one agent might name database tables 'users' while another uses 'Users' - this would cause conflicts.

We need to establish consistent patterns that all agents follow."

**Show Options and Trade-offs:**
"Common approaches for {{pattern_category}}:

1. {{option_1}} - {{pros_and_cons}}
2. {{option_2}} - {{pros_and_cons}}
3. {{option_3}} - {{pros_and_cons}}

Which approach makes the most sense for our project?"

**Get User Decision:**
"What's your preference for this pattern? (or discuss the trade-offs more)"

### 3. Define Pattern Categories

#### Naming Patterns

**Database Naming:**

- Table naming: users, Users, or user?
- Column naming: user_id or userId?
- Foreign key format: user_id or fk_user?
- Index naming: idx_users_email or users_email_index?

**API Naming:**

- REST endpoint naming: /users or /user? Plural or singular?
- Route parameter format: :id or {id}?
- Query parameter naming: user_id or userId?
- Header naming conventions: X-Custom-Header or Custom-Header?

**Code Naming:**

- Component naming: UserCard or user-card?
- File naming: UserCard.tsx or user-card.tsx?
- Function naming: getUserData or get_user_data?
- Variable naming: userId or user_id?

#### Structure Patterns

**Project Organization:**

- Where do tests live? **tests**/ or \*.test.ts co-located?
- How are components organized? By feature or by type?
- Where do shared utilities go?
- How are services and repositories organized?

**File Structure:**

- Config file locations and naming
- Static asset organization
- Documentation placement
- Environment file organization

#### Format Patterns

**API Formats:**

- API response wrapper? {data: ..., error: ...} or direct response?
- Error format? {message, code} or {error: {type, detail}}?
- Date format in JSON? ISO strings or timestamps?
- Success response structure?

**Data Formats:**

- JSON field naming: snake_case or camelCase?
- Boolean representations: true/false or 1/0?
- Null handling patterns
- Array vs object for single items

#### Communication Patterns

**Event Systems:**

- Event naming convention: user.created or UserCreated?
- Event payload structure standards
- Event versioning approach
- Async event handling patterns

**State Management:**

- State update patterns: immutable updates or direct mutation?
- Action naming conventions
- Selector patterns
- State organization principles

#### Process Patterns

**Error Handling:**

- Global error handling approach
- Error boundary patterns
- User-facing error message format
- Logging vs user error distinction

**Loading States:**

- Loading state naming conventions
- Global vs local loading states
- Loading state persistence
- Loading UI patterns

### 4. Generate Patterns Content

Prepare the content to append to the document:

#### Content Structure:

```markdown
## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

**Critical Conflict Points Identified:**
{{number_of_potential_conflicts}} areas where AI agents could make different choices

### Naming Patterns

**Database Naming Conventions:**
{{database_naming_rules_with_examples}}

**API Naming Conventions:**
{{api_naming_rules_with_examples}}

**Code Naming Conventions:**
{{code_naming_rules_with_examples}}

### Structure Patterns

**Project Organization:**
{{project_structure_rules_with_examples}}

**File Structure Patterns:**
{{file_organization_rules_with_examples}}

### Format Patterns

**API Response Formats:**
{{api_response_structure_rules}}

**Data Exchange Formats:**
{{data_format_rules_with_examples}}

### Communication Patterns

**Event System Patterns:**
{{event_naming_and_structure_rules}}

**State Management Patterns:**
{{state_update_and_organization_rules}}

### Process Patterns

**Error Handling Patterns:**
{{consistent_error_handling_approaches}}

**Loading State Patterns:**
{{loading_state_management_rules}}

### Enforcement Guidelines

**All AI Agents MUST:**

- {{mandatory_pattern_1}}
- {{mandatory_pattern_2}}
- {{mandatory_pattern_3}}

**Pattern Enforcement:**

- How to verify patterns are followed
- Where to document pattern violations
- Process for updating patterns

### Pattern Examples

**Good Examples:**
{{concrete_examples_of_correct_pattern_usage}}

**Anti-Patterns:**
{{examples_of_what_to_avoid}}
```

### 5. Present Content and Menu

Show the generated patterns content and present choices:

"I've documented implementation patterns that will prevent conflicts between AI agents working on this project.

**Here's what I'll add to the document:**

[Show the complete markdown content from step 4]

**What would you like to do?**
[A] Advanced Elicitation - Explore additional consistency patterns
[P] Party Mode - Review patterns from different implementation perspectives
[C] Continue - Save these patterns and move to project structure"

### 6. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Read fully and follow: {project-root}/_bmad/core/workflows/advanced-elicitation/workflow.xml with current patterns
- Process enhanced consistency rules that come back
- Ask user: "Accept these additional pattern refinements? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Read fully and follow: {project-root}/_bmad/core/workflows/party-mode/workflow.md with implementation patterns context
- Process collaborative insights about potential conflicts
- Ask user: "Accept these changes to the implementation patterns? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Append the final content to `{planning_artifacts}/architecture.md`
- Update frontmatter: `stepsCompleted: [1, 2, 3, 4, 5]`
- Load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-06-structure.md`

## APPEND TO DOCUMENT:

When user selects 'C', append the content directly to the document using the structure from step 4.

## SUCCESS METRICS:

✅ All potential AI agent conflict points identified and addressed
✅ Comprehensive patterns defined for naming, structure, and communication
✅ Concrete examples provided for each pattern
✅ Enforcement guidelines clearly documented
✅ User collaborated on pattern decisions rather than receiving recommendations
✅ A/P/C menu presented and handled correctly
✅ Content properly appended to document when C selected

## FAILURE MODES:

❌ Missing potential conflict points that could cause agent conflicts
❌ Being too prescriptive about implementation details instead of focusing on consistency
❌ Not providing concrete examples for each pattern
❌ Failing to address cross-cutting concerns like error handling
❌ Not considering the chosen technology stack when defining patterns
❌ Not presenting A/P/C menu after content generation

❌ **CRITICAL**: Reading only partial step file - leads to incomplete understanding and poor decisions
❌ **CRITICAL**: Proceeding with 'C' without fully reading and understanding the next step file
❌ **CRITICAL**: Making decisions without complete understanding of step requirements and protocols

## NEXT STEP:

After user selects 'C' and content is saved to document, load `{project-root}/_bmad/bmm/workflows/3-solutioning/create-architecture/steps/step-06-structure.md` to define the complete project structure.

Remember: Do NOT proceed to step-06 until user explicitly selects 'C' from the A/P/C menu and content is saved!
