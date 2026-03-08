# Agent Compilation: YAML → Compiled

**TL;DR:** Write minimal YAML → compiler adds frontmatter, activation XML, handlers, rules, MH/CH/PM/DA menu items.

---

## YAML Structure (YOU WRITE)

```yaml
agent:
  metadata:
    id: "_bmad/..."
    name: "Persona Name"
    title: "Agent Title"
    icon: "🔧"
    module: "stand-alone" | "bmm" | "cis" | "bmgd"

  persona:
    role: "First-person role description"
    identity: "Background and specializations"
    communication_style: "How the agent speaks"
    principles:
      - "Core belief or methodology"

  critical_actions:              # Optional - ANY agent can have these
    - "Load COMPLETE file {project-root}/_bmad/_memory/journal-sidecar/memories.md"
    - "Load COMPLETE file {project-root}/_bmad/_memory/journal-sidecar/instructions.md"
    - "ONLY read/write files in {project-root}/_bmad/_memory/journal-sidecar/"

  prompts:                        # Optional - standalone agents
    - id: prompt-name
      content: |
        <instructions>Prompt content</instructions>

  menu:                           # Custom items ONLY
    - trigger: XX or fuzzy match on command-name
      workflow: "path/to/workflow.yaml"   # OR
      exec: "path/to/file.md"             # OR
      action: "#prompt-id"
      description: "[XX] Command description"
```

---

## What Compiler Adds (DO NOT WRITE)

| Component                                | Source                       |
| ---------------------------------------- | ---------------------------- |
| Frontmatter (`---name/description---`)   | Auto-generated               |
| XML activation block with numbered steps | Auto-generated               |
| critical_actions → activation steps      | Injected as steps 4, 5, 6... |
| Menu handlers (workflow/exec/action)     | Auto-detected                |
| Rules section                            | Auto-generated               |
| MH, CH, PM, DA menu items                | Always injected              |

### Auto-Injected Menu Items (NEVER add)

| Code | Trigger                             | Description                        |
| ---- | ----------------------------------- | ---------------------------------- |
| MH   | menu or help                        | Redisplay Menu Help                |
| CH   | chat                                | Chat with the Agent about anything |
| PM   | party-mode                          | Start Party Mode                   |
| DA   | exit, leave, goodbye, dismiss agent | Dismiss Agent                      |

---

## Compiled Output Structure

````markdown
---
name: "architect"
description: "Architect"
---

You must fully embody this agent's persona...

```xml
<agent id="architect.agent.yaml" name="Winston" title="Architect" icon="🏗️">
<activation critical="MANDATORY">
  <step n="1">Load persona from this current agent file (already in context)</step>
  <step n="2">Load config to get {user_name}, {communication_language}</step>
  <step n="3">Remember: user's name is {user_name}</step>
  <!-- YOUR critical_actions inserted here as steps 4, 5, 6... -->
  <step n="N">ALWAYS communicate in {communication_language}</step>
  <step n="N+1">Show greeting + numbered menu</step>
  <step n="N+2">STOP and WAIT for user input</step>

  <menu-handlers>
    <handlers>
      <handler type="workflow">Load workflow.xml and execute with workflow-config parameter</handler>
      <handler type="exec">Load and execute the file at that path</handler>
      <handler type="action">Execute prompt with matching id from prompts section</handler>
    </handlers>
  </menu-handlers>

  <rules>
    <r>ALWAYS communicate in {communication_language}</r>
    <r>Stay in character until exit selected</r>
    <r>Display Menu items as the item dictates</r>
    <r>Load files ONLY when executing menu items</r>
  </rules>
</activation>

<persona>
  <role>System Architect + Technical Design Leader</role>
  <identity>Senior architect with expertise...</identity>
  <communication_style>Speaks in calm, pragmatic tones...</communication_style>
  <principles>- User journeys drive technical decisions...</principles>
</persona>

<prompts>
  <prompt id="prompt-name">
    <instructions>Prompt content</instructions>
  </prompt>
</prompts>

<menu>
  <item cmd="MH or fuzzy match on menu or help">[MH] Redisplay Menu Help</item>
  <item cmd="CH or fuzzy match on chat">[CH] Chat with the Agent about anything</item>
  <!-- YOUR CUSTOM ITEMS HERE -->
  <item cmd="PM or fuzzy match on party-mode">[PM] Start Party Mode</item>
  <item cmd="DA or fuzzy match on exit leave goodbye dismiss agent">[DA] Dismiss Agent</item>
</menu>
</agent>
```
````

---

## critical_actions Injection

Your `critical_actions` become numbered activation steps.

### With sidecar (hasSidecar: true):

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/journal-sidecar/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/journal-sidecar/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/journal-sidecar/"
```

→ Injected as steps 4, 5, 6

### Without sidecar (hasSidecar: false):

```yaml
critical_actions:
  - "Give user an inspirational quote before showing menu"
```

→ Injected as step 4

### No critical_actions:

Activation jumps directly from step 3 to "ALWAYS communicate in {communication_language}"

---

## DO NOT / DO Checklist

**DO NOT:**

- [ ] Add frontmatter
- [ ] Create activation/XML blocks
- [ ] Add MH/CH/PM/DA menu items
- [ ] Add menu handlers
- [ ] Add rules section
- [ ] Duplicate auto-injected content

**DO:**

- [ ] Define metadata (id, name, title, icon, module)
- [ ] Define persona (role, identity, communication_style, principles)
- [ ] Define critical_actions (if activation behavior needed)
- [ ] Define prompts with IDs (standalone agents)
- [ ] Define menu with custom items only
- [ ] Use format: `XX or fuzzy match on command-name`
- [ ] Use description format: `[XX] Description text`

---

## Division of Responsibilities

| Aspect           | YOU (YAML)         | COMPILER               |
| ---------------- | ------------------ | ---------------------- |
| Agent identity   | metadata + persona | Wrapped in XML         |
| Activation steps | critical_actions   | Inserted as steps 4+   |
| Prompts          | prompts with IDs   | Referenced by actions  |
| Menu items       | Custom only        | + MH, CH, PM, DA       |
| Activation block | —                  | Full XML with handlers |
| Rules            | —                  | Standardized section   |
| Frontmatter      | —                  | name/description       |
