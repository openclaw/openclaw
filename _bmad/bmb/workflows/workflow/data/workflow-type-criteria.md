# Workflow Type Criteria

## Key Decisions

1. **Module affiliation** - Standalone or part of a module?
2. **Continuable** - Can it span multiple sessions?
3. **Edit/Validate support** - Will it have edit and validate flows?
4. **Document output** - Does it produce a document?

## 1. Module Affiliation

### Standalone Workflow

- NOT part of any module
- Stored in user's custom location
- Only standard variables available

### Module-Based Workflow

- Part of a specific module (e.g., BMB)
- Has access to module-specific variables
- Stored in module's workflows directory

**BMB additional variable:** `{bmb_creations_output_folder}`

## 2. Continuable or Single-Session?

### Continuable (Multi-Session)

**Use when:** Workflow might consume MASSIVE tokens, complex, many steps

**Required:**

- `step-01-init.md` with continuation detection
- `step-01b-continue.md` for resuming
- `stepsCompleted` tracking in output frontmatter

**Frontmatter:**

```yaml
stepsCompleted: ["step-01-init", "step-02-gather"]
lastStep: "step-02-gather"
lastContinued: "2025-01-02"
```

**Rule:** Each step appends its NAME to `stepsCompleted`

### Single-Session

**Use when:** Simple, quick (<15 min), token-efficient

**Required:**

- Standard `step-01-init.md` (no continuation logic)
- No `stepsCompleted` tracking needed

## 3. Edit/Validate Support

### Create-Only

```
workflow-folder/
├── workflow.md
├── data/
└── steps-c/
    ├── step-01-init.md
    └── step-N-final.md
```

**Use when:** Simple workflows, experimental, one-off

### Create + Edit + Validate (Tri-Modal)

```
workflow-folder/
├── workflow.md
├── data/                    # SHARED
├── steps-c/                 # Create
├── steps-e/                 # Edit
└── steps-v/                 # Validate
```

**Key:**

- Each mode is SELF-CONTAINED
- NO shared step files between modes
- DATA folder is SHARED (prevents drift)
- Duplicative steps OK (better than confusion)

**Use when:** Complex workflows that will be maintained

## 4. Document Output

### Document-Producing

- Creates persistent output file
- Uses templates for structure
- Each step contributes to document
- Consider final polish step

### Non-Document

- Performs actions without persistent output
- May produce temporary files
- Focus on execution, not creation

## Decision Tree

```
START: Creating a workflow
│
├─ Part of a module?
│  ├─ YES → Module-based (include module variables)
│  └─ NO  → Standalone (standard variables only)
│
├─ Could this take multiple sessions / lots of tokens?
│  ├─ YES → Continuable (add step-01b-continue.md)
│  └─ NO  → Single-session (simpler init)
│
└─ Will users need to edit/validate this workflow?
   ├─ YES → Tri-modal (steps-c/, steps-e/, steps-v/)
   └─ NO  → Create-only (steps-c/ only)
```

## Output Format Decision

| Workflow Type             | Init Template            | Output Format |
| ------------------------- | ------------------------ | ------------- |
| Continuable + Document    | step-01-init-continuable | Free-form     |
| Single-Session + Document | Standard init            | Free-form     |
| Continuable + No Doc      | step-01-init-continuable | N/A           |
| Single-Session + No Doc   | Standard init            | N/A           |

**Free-form template** (recommended):

```yaml
---
stepsCompleted: []
lastStep: ""
date: ""
user_name: ""
---
# {{document_title}}

[Content appended progressively]
```
