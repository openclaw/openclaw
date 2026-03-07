# Step File Rules

**Purpose:** Quick reference for step structure and compliance. See linked data files for detailed standards.

---

## File Size Limits

| Metric           | Value       |
| ---------------- | ----------- |
| Recommended      | < 200 lines |
| Absolute Maximum | 250 lines   |

**If exceeded:** Split into multiple steps or extract to `/data/` files.

---

## Required Step Structure

```markdown
---
name: 'step-[N]-[name]'
description: '[what this step does]'

# File References (ONLY variables used in this step!)
[file references in {variable} format
---

# Step [N]: [Name]

## STEP GOAL:

[Single sentence: what this step accomplishes]

## MANDATORY EXECUTION RULES (READ FIRST):

### Universal Rules:

- NEVER generate content without user input
- CRITICAL: Read complete step file before taking action
- CRITICAL: When loading next step with 'C', ensure entire file is read
- YOU ARE A FACILITATOR, not a content generator

### Role Reinforcement:

- You are a [specific role]
- We engage in collaborative dialogue, not command-response
- You bring [expertise], user brings [theirs]
- Together we produce something better

### Step-Specific Rules:

- Focus only on [specific task]
- FORBIDDEN to [prohibited action]
- Approach: [how to engage]

## EXECUTION PROTOCOLS:

- [Protocol 1]
- [Protocol 2 - save/update]
- [Protocol 3 - tracking]

## CONTEXT BOUNDARIES:

- Available context: [what's available]
- Focus: [what to focus on]
- Limits: [boundaries]
- Dependencies: [what this depends on]

## Sequence of Instructions:

### 1. [Action]

[Instructions]

### N. Present MENU OPTIONS

[Menu section - see menu-handling-standards.md]

## SYSTEM SUCCESS/FAILURE METRICS:

### SUCCESS:

[Success criteria]

### SYSTEM FAILURE:

[Failure criteria]
**Master Rule:** Skipping steps is FORBIDDEN.
```

---

## Critical Rules (Quick Reference)

### Frontmatter

- Only variables USED in step body
- All file references use `{variable}` format
- Relative paths within workflow folder
- See: `frontmatter-standards.md`

### Menus

- Handler section MUST follow display
- "Halt and wait" in execution rules
- A/P options only when appropriate
- Non-C options redisplay menu
- See: `menu-handling-standards.md`

### Progressive Disclosure

- Only load next step when user selects 'C'
- Read entire step file before execution
- Don't create mental todos from future steps

### Continuable Workflows

- Append step number to `stepsCompleted`
- Don't hardcode full array
- See: `workflow-type-criteria.md`

---

## Data Files Reference

| File                             | Purpose                                      |
| -------------------------------- | -------------------------------------------- |
| `frontmatter-standards.md`       | Variables, paths, frontmatter rules          |
| `menu-handling-standards.md`     | Menu patterns, handler requirements          |
| `output-format-standards.md`     | Document output, template types              |
| `workflow-type-criteria.md`      | Continuable, module, tri-modal decisions     |
| `step-type-patterns.md`          | Templates for init/middle/final/branch steps |
| `trimodal-workflow-structure.md` | Create/Edit/Validate folder structure        |

---

## Step Type Reference

| Step Type              | Template/Reference                              |
| ---------------------- | ----------------------------------------------- |
| Init (non-continuable) | Auto-proceed, no continuation logic             |
| Init (continuable)     | `step-01-init-continuable-template.md`          |
| Continuation (01b)     | `step-1b-template.md`                           |
| Middle (standard)      | A/P/C menu, collaborative content               |
| Middle (simple)        | C only menu, no A/P                             |
| Branch/Conditional     | Custom menu options, routing to different steps |
| Validation sequence    | Auto-proceed through checks                     |
| Final                  | No next step, completion message                |

See: `step-type-patterns.md`

---

## Frontmatter Variables

### Standard (Always Available)

- `{project-root}`
- `{project_name}`
- `{output_folder}`
- `{user_name}`
- `{communication_language}`
- `{document_output_language}`

### Module-Specific (e.g., BMB)

- `{bmb_creations_output_folder}`

### User-Defined

- New variables can be defined in steps for future steps

See: `frontmatter-standards.md`

---

## Validation Checklist

For every step file:

- [ ] File < 200 lines (250 max)
- [ ] `name` and `description` in frontmatter
- [ ] All frontmatter variables are used
- [ ] File references use `{variable}` format
- [ ] Relative paths within workflow folder
- [ ] Handler section follows menu display
- [ ] "Halt and wait" in execution rules
- [ ] A/P options appropriate for step type
- [ ] C option saves and loads next step
- [ ] Non-C options redisplay menu
- [ ] StepsCompleted appended (if continuable)
- [ ] Success/failure metrics present

---

## Quick Menu Reference

```markdown
### N. Present MENU OPTIONS

Display: "**Select:** [A] [action A] [P] [action P] [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {outputFile}, update frontmatter, then load, read entire file, then execute {nextStepFile}
- IF Any other comments or queries: help user respond then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
```

---

## Common Violations

| Violation                           | Fix                                              |
| ----------------------------------- | ------------------------------------------------ |
| Unused variable in frontmatter      | Remove unused variables                          |
| Hardcoded file path                 | Use `{variable}` format                          |
| A/P menu in step 1                  | Remove A/P (inappropriate for init)              |
| Missing handler section             | Add handler after menu display                   |
| No "halt and wait" instruction      | Add to EXECUTION RULES                           |
| Hardcoded `stepsCompleted: [1,2,3]` | Append: "update stepsCompleted to add this step" |
| File > 250 lines                    | Split into multiple steps or extract to /data/   |
| Absolute path for same-folder ref   | Use relative path or `{workflow_path}`           |

---

## When to Extract to Data Files

Extract step content to `/data/` when:

- Step file exceeds 200 lines
- Content is reference material
- Content is reused across steps
- Content is domain-specific (examples, patterns)

**Data file types:**

- `.md` - Reference documentation
- `.csv` - Structured data for lookup
- `examples/` - Reference implementations

---

## Tri-Modal Workflow Note

For Create/Edit/Validate workflows:

- Each mode has its own `steps-c/`, `steps-e/`, `steps-v/` folder
- NO shared step files (`s-*.md`) between modes
- All modes share `/data/` folder
- This prevents confusion and routing errors

See: `trimodal-workflow-structure.md`
