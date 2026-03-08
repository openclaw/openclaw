# Agent Validation

## Common (All Agents)

### YAML Structure

- [ ] Parses without errors
- [ ] `metadata`: `id`, `name`, `title`, `icon`, `module`, `hasSidecar`
- [ ] `hasSidecar`: `true`|`false`
- [ ] `module`: `stand-alone`|`bmm`|`cis`|`bmgd`|...
- [ ] `persona`: `role`, `identity`, `communication_style`, `principles`
- [ ] `menu`: ≥1 item
- [ ] Filename: `{name}.agent.yaml` (lowercase, hyphenated)

### Persona Fields

| Field                 | Contains                                    | Does NOT Contain                              |
| --------------------- | ------------------------------------------- | --------------------------------------------- |
| `role`                | Knowledge/skills/capabilities               | Background, experience, "who"                 |
| `identity`            | Background/experience/context               | Skills, "what"                                |
| `communication_style` | Tone/voice/mannerisms (1-2 sentences)       | "ensures", "expert", "believes", "who does X" |
| `principles`          | Operating philosophy, behavioral guidelines | Verbal patterns, "how they talk"              |

### Menu Items

- [ ] `trigger`: `XX or fuzzy match on command-name` (XX = 2-letter code, unique)
- [ ] No reserved codes: `MH`, `CH`, `PM`, `DA` (auto-injected)
- [ ] `description`: Starts with `[XX]`, code matches trigger
- [ ] `action`: `#prompt-id` (exists) or inline text

### Prompts (if present)

- [ ] Each has `id`, `content`
- [ ] IDs unique within agent
- [ ] Uses semantic XML: `<instructions>`, `<process>`, etc.

### Quality

- [ ] No broken references
- [ ] Indentation consistent
- [ ] Purpose clear from persona
- [ ] Name/title descriptive, icon appropriate

---

## hasSidecar: false

### Structure

- [ ] Single `.agent.yaml` file (no sidecar folder)
- [ ] No `{project-root}/_bmad/_memory/` paths
- [ ] Size under ~250 lines (unless justified)

### critical_actions (OPTIONAL)

- [ ] No references to sidecar files
- [ ] No placeholders, no compiler-injected steps
- [ ] Valid paths if any files referenced

**Reference:** `commit-poet.agent.yaml`

---

## hasSidecar: true

### Structure

- [ ] `sidecar-folder` specified in metadata
- [ ] Folder exists: `{name}-sidecar/`
- [ ] Sidecar contains: `instructions.md`, `memories.md` (recommended)

### critical_actions (MANDATORY)

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
```

- [ ] Exists with ≥3 actions
- [ ] Loads memories, loads instructions, restricts file access
- [ ] No placeholders, no compiler-injected steps

### Path Format (CRITICAL)

- [ ] ALL sidecar paths: `{project-root}/_bmad/_memory/{sidecar-folder}/...`
- [ ] `{project-root}` is literal (not replaced)
- [ ] `{sidecar-folder}` = actual folder name
- [ ] No `./` or `/Users/` paths <!-- validate-file-refs:ignore -->

### Persona Addition

- [ ] `communication_style` includes memory reference patterns
- [ ] Natural: "Last time you mentioned..." or "I've noticed patterns..."

### Menu Actions

- [ ] Sidecar references use correct path format
- [ ] Update actions are complete

**Reference:** `journal-keeper/`

---

## Compiler-Injected (Skip Validation)

- Frontmatter (`---name/description---`)
- XML activation block
- Menu items: `MH`, `CH`, `PM`, `DA`
- Rules section

---

## Common Fixes

| Issue                                         | Fix                                                        |
| --------------------------------------------- | ---------------------------------------------------------- |
| Behaviors in `communication_style`            | Move to `identity` or `principles`                         |
| `trigger: analyze`                            | `trigger: AN or fuzzy match on analyze`                    |
| `description: 'Analyze code'`                 | `description: '[AC] Analyze code'`                         |
| `./sidecar/memories.md`                       | `{project-root}/_bmad/_memory/sidecar/memories.md`         |
| Missing `critical_actions` (hasSidecar: true) | Add load memories, load instructions, restrict access      |
| No memory references (hasSidecar: true)       | Add to `communication_style`: "Last time you mentioned..." |
