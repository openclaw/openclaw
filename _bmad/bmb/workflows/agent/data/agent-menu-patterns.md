# Agent Menu Patterns

## Menu Item Schema

```yaml
- trigger: XX or fuzzy match on command-name
  [handler]: [value]
  description: "[XX] Display text"
  data: [optional] # Pass file to workflow
```

| Field         | Required | Validation                                  |
| ------------- | -------- | ------------------------------------------- |
| `trigger`     | Yes      | Format: `XX or fuzzy match on command-name` |
| `description` | Yes      | Must start with `[XX]` code                 |
| handler       | Yes      | `action` (Agent) or `exec` (Module)         |
| `data`        | No       | File path for workflow input                |

**Reserved codes (DO NOT USE):** MH, CH, PM, DA (auto-injected)

---

## Handlers

| Handler  | Use Case                        | Syntax                                            |
| -------- | ------------------------------- | ------------------------------------------------- |
| `action` | Agent self-contained operations | `action: '#prompt-id'` or `action: 'inline text'` |
| `exec`   | Module external workflows       | `exec: '{project-root}/path/to/workflow.md'`      |

```yaml
# Action - reference prompt
- trigger: WC or fuzzy match on write-commit
  action: "#write-commit"
  description: "[WC] Write commit message"

# Action - inline
- trigger: QC or fuzzy match on quick-commit
  action: "Generate commit message from diff"
  description: "[QC] Quick commit from diff"

# Exec - workflow
- trigger: CP or fuzzy match on create-prd
  exec: "{project-root}/_bmad/bmm/workflows/create-prd/workflow.md"
  description: "[CP] Create PRD"

# Exec - unimplemented
- trigger: FF or fuzzy match on future-feature
  exec: "todo"
  description: "[FF] Coming soon"
```

---

## Data Parameter

Attach to ANY handler to pass input files.

```yaml
- trigger: TS or fuzzy match on team-standup
  exec: "{project-root}/_bmad/bmm/tasks/team-standup.md"
  data: "{project-root}/_bmad/_config/agent-manifest.csv"
  description: "[TS] Run team standup"
```

---

## Prompts Section

For `action: '#id'` references in Agent menus.

```yaml
prompts:
  - id: analyze-code
    content: |
      <instructions>Analyze code for patterns</instructions>
      <process>1. Identify structure 2. Check issues 3. Suggest improvements</process>

menu:
  - trigger: AC or fuzzy match on analyze-code
    action: "#analyze-code"
    description: "[AC] Analyze code patterns"
```

**Common XML tags:** `<instructions>`, `<process>`, `<example>`, `<output_format>`

---

## Path Variables

| Variable                   | Expands To               |
| -------------------------- | ------------------------ |
| `{project-root}`           | Project root directory   |
| `{output_folder}`          | Document output location |
| `{user_name}`              | User's name from config  |
| `{communication_language}` | Language preference      |

```yaml
# ✅ CORRECT
exec: '{project-root}/_bmad/core/workflows/brainstorming/workflow.md'

# ❌ WRONG
exec: '../../../core/workflows/brainstorming/workflow.md'
```

---

## Agent Types

| Type   | hasSidecar | Additional Fields                     |
| ------ | ---------- | ------------------------------------- |
| Simple | false      | `prompts`, `menu`                     |
| Expert | true       | `prompts`, `menu`, `critical_actions` |
| Module | true       | `menu` only (external workflows)      |

**Expert Agent sidecar path pattern:**

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
```

---

## Complete Examples

### Simple Agent (hasSidecar: false)

```yaml
prompts:
  - id: format-code
    content: |
      <instructions>Format code to style guidelines</instructions>

menu:
  - trigger: FC or fuzzy match on format-code
    action: "#format-code"
    description: "[FC] Format code"

  - trigger: LC or fuzzy match on lint-code
    action: "Check code for issues"
    description: "[LC] Lint code"
```

### Expert Agent (hasSidecar: true)

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/journal-keeper-sidecar/memories.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/journal-keeper-sidecar/"

prompts:
  - id: guided-entry
    content: |
      <instructions>Guide through journal entry</instructions>

menu:
  - trigger: WE or fuzzy match on write-entry
    action: "#guided-entry"
    description: "[WE] Write journal entry"

  - trigger: SM or fuzzy match on save-memory
    action: "Update {project-root}/_bmad/_memory/journal-keeper-sidecar/memories.md"
    description: "[SM] Save session"
```

### Module Agent (hasSidecar: true)

```yaml
menu:
  - trigger: WI or fuzzy match on workflow-init
    exec: "{project-root}/_bmad/bmm/workflows/workflow-status/workflow.md"
    description: "[WI] Initialize workflow"

  - trigger: BS or fuzzy match on brainstorm
    exec: "{project-root}/_bmad/core/workflows/brainstorming/workflow.md"
    description: "[BS] Guided brainstorming"
```

---

## Validation Rules

1. **Triggers:** `XX or fuzzy match on command-name` format required
2. **Descriptions:** Must start with `[XX]` code matching trigger
3. **Reserved codes:** MH, CH, PM, DA never valid in user menus
4. **Code uniqueness:** Required within each agent
5. **Paths:** Always use `{project-root}`, never relative paths
6. **Handler choice:** `action` for Agents, `exec` for Modules
7. **Sidecar paths:** `{project-root}/_bmad/_memory/{sidecar-folder}/`
