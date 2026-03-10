---
name: 'step-03-generate'
description: 'Build the implementation plan based on the technical mapping of constraints'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 3: Generate Implementation Plan

**Progress: Step 3 of 4** - Next: Review & Finalize

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- MUST NOT implement anything - just document.
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Requires `{wipFile}` with defined "Overview" and "Context for Development" sections.
- Focus: Create the implementation sequence that addresses the requirement delta using the captured technical context.
- Output: Implementation-ready tasks with specific files and instructions.
- Target: Meet the **READY FOR DEVELOPMENT** standard defined in `workflow.md`.

## SEQUENCE OF INSTRUCTIONS

### 1. Load Current State

**Read `{wipFile}` completely and extract:**

- All frontmatter values
- Overview section (Problem, Solution, Scope)
- Context for Development section (Patterns, Files, Decisions)

### 2. Generate Implementation Plan

Generate specific implementation tasks:

a) **Task Breakdown**

- Each task should be a discrete, completable unit of work
- Tasks should be ordered logically (dependencies first)
- Include the specific files to modify in each task
- Be explicit about what changes to make

b) **Task Format**

```markdown
- [ ] Task N: Clear action description
  - File: `path/to/file.ext`
  - Action: Specific change to make
  - Notes: Any implementation details
```

### 3. Generate Acceptance Criteria

**Create testable acceptance criteria:**

Each AC should follow Given/When/Then format:

```markdown
- [ ] AC N: Given [precondition], when [action], then [expected result]
```

**Ensure ACs cover:**

- Happy path functionality
- Error handling
- Edge cases (if relevant)
- Integration points (if relevant)

### 4. Complete Additional Context

**Fill in remaining sections:**

a) **Dependencies**

- External libraries or services needed
- Other tasks or features this depends on
- API or data dependencies

b) **Testing Strategy**

- Unit tests needed
- Integration tests needed
- Manual testing steps

c) **Notes**

- High-risk items from pre-mortem analysis
- Known limitations
- Future considerations (out of scope but worth noting)

### 5. Write Complete Spec

a) **Update `{wipFile}` with all generated content:**

- Ensure all template sections are filled in
- No placeholder text remaining
- All frontmatter values current
- Update status to 'review' (NOT 'ready-for-dev' - that happens after user review in Step 4)

b) **Update frontmatter:**

```yaml
---
# ... existing values ...
status: 'review'
stepsCompleted: [1, 2, 3]
---
```

c) **Read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-04-review.md` (Step 4)**

## REQUIRED OUTPUTS:

- Tasks MUST be specific, actionable, ordered logically, with files to modify.
- ACs MUST be testable, using Given/When/Then format.
- Status MUST be updated to 'review'.

## VERIFICATION CHECKLIST:

- [ ] `stepsCompleted: [1, 2, 3]` set in frontmatter.
- [ ] Spec meets the **READY FOR DEVELOPMENT** standard.
