# Agent Architecture

Single Agent type with `hasSidecar` boolean. `critical_actions` decoupled from sidecar.

## Decision Matrix: hasSidecar

| hasSidecar | Structure                     | Use When                                                   |
| ---------- | ----------------------------- | ---------------------------------------------------------- |
| `false`    | Single YAML file (~250 lines) | Stateless, single-purpose, personality-driven              |
| `true`     | YAML + sidecar folder         | Persistent memory, long-term tracking, relationship-driven |

---

## YAML Schema

```yaml
agent:
  metadata:
    id: _bmad/agents/{agent-name}/{agent-name}.md
    name: 'Persona Name'
    title: 'Agent Title'
    icon: '<emoji>'
    module: stand-alone  # or bmm, cis, bmgd

  persona:
    role: |               # First-person, 1-2 sentences
    identity: |           # Background, 2-5 sentences
    communication_style: | # Voice, tone, mannerisms
    principles:           # Core beliefs
      - Principle one

  critical_actions:       # Optional - activation behavior
    - 'Load COMPLETE file {path}'
    - 'ONLY read/write files in {path}'

  prompts:
    - id: prompt-id
      content: |
        <instructions>What it does</instructions>
        <process>1. Step one 2. Step two</process>

  menu:
    - trigger: XX or fuzzy match on command
      action: '#prompt-id' or 'Direct instruction'
      description: '[XX] Description'
```

---

## Metadata Fields

| Field    | Format                          | Example                                   |
| -------- | ------------------------------- | ----------------------------------------- |
| `id`     | `_bmad/agents/{name}/{name}.md` | `_bmad/agents/commit-poet/commit-poet.md` |
| `name`   | Persona name                    | `Inkwell Von Comitizen`                   |
| `title`  | Role                            | `Commit Message Artisan`                  |
| `icon`   | Single emoji                    | `📜`                                      |
| `module` | `stand-alone` or module code    | `bmm`, `cis`, `bmgd`                      |

---

## hasSidecar: false

**Structure:** `{agent-name}.agent.yaml` only

**Use cases:**

- Single-purpose utility with helpful persona
- Each session is independent
- All logic fits in ~250 lines
- No need to remember past sessions

**Examples:** Commit Poet, Snarky Weather Bot, Pun Barista, Gym Bro

**Constraints:**

- Under ~250 lines
- No sidecar path references in `critical_actions`

---

## hasSidecar: true

**Structure:**

```
{agent-name}/
├── {agent-name}.agent.yaml
└── {agent-name}-sidecar/
    ├── instructions.md
    ├── memories.md
    ├── workflows/
    └── knowledge/
```

**Use cases:**

- Must remember things across sessions
- User preferences, settings, progress tracking
- Personal knowledge base that grows
- Domain-specific with restricted file access
- Long-term relationship with user

**Examples:** Journal companion, Novel writing buddy, Fitness coach, Language tutor

### Sidecar Path Rules

**Installation path:** `{project-root}/_bmad/_memory/{sidecar-folder}/`

**ALL references MUST use:**

```yaml
{project-root}/_bmad/_memory/{sidecar-folder}/{file}
```

| Component          | Value                                               |
| ------------------ | --------------------------------------------------- |
| `{project-root}`   | Literal - keep as-is                                |
| `{sidecar-folder}` | Actual folder name (e.g., `journal-keeper-sidecar`) |

```yaml
# ✅ CORRECT
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/journal-keeper-sidecar/memories.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/journal-keeper-sidecar/"

# ❌ WRONG
critical_actions:
  - "Load ./journal-keeper-sidecar/memories.md"
  - "Load /Users/absolute/path/memories.md"
```

### Required critical_actions for Sidecar

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
```

---

## Menu Actions

| Type               | Format                 | Example                        |
| ------------------ | ---------------------- | ------------------------------ |
| Prompt reference   | `action: "#prompt-id"` | `action: "#write-commit"`      |
| Inline instruction | `action: "text"`       | `action: "Update memories.md"` |

**Trigger format:** `XX or fuzzy match on command`
**Description format:** `[XX] Description`

**Reserved codes:** MH, CH, PM, DA (auto-injected - do NOT use)

```yaml
menu:
  - trigger: WC or fuzzy match on write
    action: "#write-commit"
    description: "[WC] Write commit message"

  - trigger: SM or fuzzy match on save
    action: "Update {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
    description: "[SM] Save session"
```

---

## Prompts

Reusable templates referenced via `#id`:

```yaml
prompts:
  - id: write-commit
    content: |
      <instructions>What this does</instructions>
      <process>1. Step 2. Step</process>
      <example>Input → Output</example>
```

**Best practices:**

- Use semantic XML tags
- Keep focused, single purpose
- Number steps in multi-step processes

---

## Persona (All Types)

First-person voice only:

```yaml
role: "I am a Commit Message Artisan..."
identity: "I understand commit messages are documentation..."
communication_style: "Poetic drama with flair..."
principles:
  - "Every commit tells a story - capture the why"
```

**For sidecar agents** - include memory reference patterns:

```yaml
communication_style: |
  I reference past naturally: "Last time you mentioned..." or "I've noticed patterns..."
```

---

## Domain Restriction Patterns

```yaml
# Single folder (most common)
- "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"

# Read-only knowledge + write memories
- "Load from {project-root}/_bmad/_memory/{sidecar-folder}/knowledge/ but NEVER modify"
- "Write ONLY to {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"

# User folder access
- "ONLY access files in {user-folder}/journals/ - private space"
```

---

## Validation Checklist

### Both Types

- [ ] Valid YAML syntax
- [ ] Metadata: id, name, title, icon, module
- [ ] Persona: role, identity, communication_style, principles
- [ ] Unique prompt IDs
- [ ] Menu triggers: `XX or fuzzy match on command`
- [ ] Menu descriptions: `[XX] Description`
- [ ] No reserved codes (MH, CH, PM, DA)
- [ ] File named `{agent-name}.agent.yaml`

### hasSidecar: false

- [ ] Under ~250 lines
- [ ] No sidecar path references

### hasSidecar: true

- [ ] ALL paths: `{project-root}/_bmad/_memory/{sidecar-folder}/...`
- [ ] `{project-root}` is literal
- [ ] Sidecar folder exists with required files

---

## What Compiler Adds (DO NOT Include)

- Frontmatter (`---name/description---`)
- XML activation block
- Menu handlers (workflow, exec logic)
- Auto-injected menu items (MH, CH, PM, DA)
- Rules section

---

## Reference Examples

| Type            | Path                                                    |
| --------------- | ------------------------------------------------------- |
| without sidecar | `data/reference/without-sidecar/commit-poet.agent.yaml` |
| with sidecar    | `data/reference/with-sidecar/journal-keeper/`           |
