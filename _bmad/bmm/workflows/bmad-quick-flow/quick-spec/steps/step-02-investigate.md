---
name: 'step-02-investigate'
description: 'Map technical constraints and anchor points within the codebase'

wipFile: '{implementation_artifacts}/tech-spec-wip.md'
---

# Step 2: Map Technical Constraints & Anchor Points

**Progress: Step 2 of 4** - Next: Generate Plan

## RULES:

- MUST NOT skip steps.
- MUST NOT optimize sequence.
- MUST follow exact instructions.
- MUST NOT generate the full spec yet (that's Step 3).
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## CONTEXT:

- Requires `{wipFile}` from Step 1 with the "Problem Statement" defined.
- Focus: Map the problem statement to specific anchor points in the codebase.
- Output: Exact files to touch, classes/patterns to extend, and technical constraints identified.
- Objective: Provide the implementation-ready ground truth for the plan.

## SEQUENCE OF INSTRUCTIONS

### 1. Load Current State

**Read `{wipFile}` and extract:**

- Problem statement and scope from Overview section
- Any context gathered in Step 1

### 2. Execute Investigation Path

**Universal Code Investigation:**

_Isolate deep exploration in sub-agents/tasks where available. Return distilled summaries only to prevent context snowballing._

a) **Build on Step 1's Quick Scan**

Review what was found in Step 1's orient scan. Then ask:

"Based on my quick look, I see [files/patterns found]. Are there other files or directories I should investigate deeply?"

b) **Read and Analyze Code**

For each file/directory provided:

- Read the complete file(s)
- Identify patterns, conventions, coding style
- Note dependencies and imports
- Find related test files

**If NO relevant code is found (Clean Slate):**

- Identify the target directory where the feature should live.
- Scan parent directories for architectural context.
- Identify standard project utilities or boilerplate that SHOULD be used.
- Document this as "Confirmed Clean Slate" - establishing that no legacy constraints exist.


c) **Document Technical Context**

Capture and confirm with user:

- **Tech Stack**: Languages, frameworks, libraries
- **Code Patterns**: Architecture patterns, naming conventions, file structure
- **Files to Modify/Create**: Specific files that will need changes or new files to be created
- **Test Patterns**: How tests are structured, test frameworks used

d) **Look for project-context.md**

If `**/project-context.md` exists and wasn't loaded in Step 1:

- Load it now
- Extract patterns and conventions
- Note any rules that must be followed

### 3. Update WIP File

**Update `{wipFile}` frontmatter:**

```yaml
---
# ... existing frontmatter ...
stepsCompleted: [1, 2]
tech_stack: ['{captured_tech_stack}']
files_to_modify: ['{captured_files}']
code_patterns: ['{captured_patterns}']
test_patterns: ['{captured_test_patterns}']
---
```

**Update the Context for Development section:**

Fill in:

- Codebase Patterns (from investigation)
- Files to Reference table (files reviewed)
- Technical Decisions (any decisions made during investigation)

**Report to user:**

"**Context Gathered:**

- Tech Stack: {tech_stack_summary}
- Files to Modify: {files_count} files identified
- Patterns: {patterns_summary}
- Tests: {test_patterns_summary}"

### 4. Present Checkpoint Menu

Display: "**Select:** [A] Advanced Elicitation [P] Party Mode [C] Continue to Generate Spec (Step 3 of 4)"

**HALT and wait for user selection.**

#### Menu Handling Logic:

- IF A: Read fully and follow: `{advanced_elicitation}` with current tech-spec content, process enhanced insights, ask user "Accept improvements? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF P: Read fully and follow: `{party_mode_exec}` with current tech-spec content, process collaborative insights, ask user "Accept changes? (y/n)", if yes update WIP file then redisplay menu, if no keep original then redisplay menu
- IF C: Verify frontmatter updated with `stepsCompleted: [1, 2]`, then read fully and follow: `{project-root}/_bmad/bmm/workflows/bmad-quick-flow/quick-spec/steps/step-03-generate.md`
- IF Any other comments or queries: respond helpfully then redisplay menu

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After A or P execution, return to this menu

---

## REQUIRED OUTPUTS:

- MUST document technical context (stack, patterns, files identified).
- MUST update `{wipFile}` with functional context.

## VERIFICATION CHECKLIST:

- [ ] Technical mapping performed and documented.
- [ ] `stepsCompleted: [1, 2]` set in frontmatter.
