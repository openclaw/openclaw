# Menu Handling Standards

**CRITICAL:** Every menu MUST have a handler section. No exceptions.

## Reserved Letters

| Letter | Purpose              | After Execution                |
| ------ | -------------------- | ------------------------------ |
| **A**  | Advanced Elicitation | Redisplay menu                 |
| **P**  | Party Mode           | Redisplay menu                 |
| **C**  | Continue/Accept      | Save → update → load next step |
| **X**  | Exit/Cancel          | End workflow                   |

**Custom letters** allowed (L/R/F/etc.) but don't conflict with reserved.

## Required Structure

### Section 1: Display

```markdown
### N. Present MENU OPTIONS

Display: "**Select:** [A] [action] [P] [action] [C] Continue"
```

### Section 2: Handler (MANDATORY)

```markdown
#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {outputFile}, update frontmatter, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then [Redisplay Menu Options](#n-present-menu-options)
```

### Section 3: Execution Rules

```markdown
#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
```

## When To Include A/P

**DON'T Include A/P:** Step 1 (init), Step 2 if only loading documents, validation sequences, simple data gathering

**DO Include A/P:** Collaborative content creation, user might want alternatives, quality gate before proceeding, creative exploration valuable

## Menu Patterns

### Pattern 1: Standard A/P/C

```markdown
Display: "**Select an Option:** [A] Advanced Elicitation [P] Party Mode [C] Continue"

#### Menu Handling Logic:

- IF A: Execute {advancedElicitationTask}, and when finished redisplay the menu
- IF P: Execute {partyModeWorkflow}, and when finished redisplay the menu
- IF C: Save content to {outputFile}, update frontmatter, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
- After other menu items execution, return to this menu
```

### Pattern 2: C Only (No A/P)

```markdown
Display: "**Select:** [C] Continue"

#### Menu Handling Logic:

- IF C: Save content to {outputFile}, update frontmatter, then load, read entire file, then execute {nextStepFile}
- IF Any other: help user, then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- ONLY proceed to next step when user selects 'C'
```

**Use for:** Step 1, document discovery, simple progression

### Pattern 3: Auto-Proceed (No Menu)

```markdown
Display: "**Proceeding to [next step]...**"

#### Menu Handling Logic:

- After [completion condition], immediately load, read entire file, then execute {nextStepFile}

#### EXECUTION RULES:

- This is an [auto-proceed reason] step with no user choices
- Proceed directly to next step after setup
```

**Use for:** Init steps, validation sequences

### Pattern 4: Branching

```markdown
Display: "**Select:** [L] Load Existing [N] Create New [C] Continue"

#### Menu Handling Logic:

- IF L: Load existing document, then load, read entire file, then execute {stepForExisting}
- IF N: Create new document, then load, read entire file, then execute {stepForNew}
- IF C: Save content to {outputFile}, update frontmatter, check {condition}, then load appropriate step
- IF Any other: help user, then [Redisplay Menu Options](#n-present-menu-options)

#### EXECUTION RULES:

- ALWAYS halt and wait for user input after presenting menu
- Branching options load different steps based on user choice
```

## Critical Rules

### ❌ DON'T:

- Omit handler section after Display
- Include A/P in Step 1 (no content to refine)
- Forget "redisplay menu" for non-C options
- Miss "halt and wait" in EXECUTION RULES

### ✅ DO:

- Handler section immediately follows Display
- "Halt and wait" in EXECUTION RULES
- Non-C options specify "redisplay menu"
- A/P only when appropriate for step type

## Validation Checklist

For every menu:

- [ ] Display section present
- [ ] Handler section immediately follows
- [ ] EXECUTION RULES section present
- [ ] "Halt and wait" instruction included
- [ ] A/P options appropriate for step type
- [ ] Non-C options redisplay menu
- [ ] C option: save → update → load next
- [ ] All file references use variables
