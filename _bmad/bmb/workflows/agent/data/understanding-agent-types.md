# Understanding Agent Types

> **LLM Instructions:** Load example files when helping users:
>
> - Without sidecar: `{workflow_path}/data/reference/without-sidecar/commit-poet.agent.yaml`
> - With sidecar: `{workflow_path}/data/reference/with-sidecar/journal-keeper/`

---

## Decision Tree

```
Multiple personas/roles OR multi-user OR mixed data scope?
├── YES → Use BMAD Module Builder
└── NO → Single Agent
    └── Need memory across sessions?
        ├── YES → hasSidecar: true
        └── NO → hasSidecar: false
```

**Key:** All agents have equal capability. Difference is memory/state management only.

---

## Without Sidecar (`hasSidecar: false`)

**Single file, stateless, ~250 lines max**

```
agent-name.agent.yaml
├── metadata.hasSidecar: false
├── persona
├── prompts (inline)
└── menu (triggers → #prompt-id or inline)
```

| When to Use                    | Examples             |
| ------------------------------ | -------------------- |
| Single-purpose utility         | Commit Poet          |
| Each session independent       | Snarky Weather Bot   |
| All knowledge fits in YAML     | Pun-making Barista   |
| Menu handlers 1-2 lines        | Motivational Gym Bro |
| Persona-driven (fun/character) | Sassy Fortune Teller |

**Optional critical_actions:** Allowed for activation behaviors (quotes, data fetches). Must NOT reference sidecar files.

---

## With Sidecar (`hasSidecar: true`)

**Persistent memory, knowledge, workflows**

```
agent-name.agent.yaml
└── agent-name-sidecar/
    ├── memories.md           # User profile, session history
    ├── instructions.md       # Protocols, boundaries
    ├── [custom-files].md     # Tracking, goals, etc.
    ├── workflows/            # Large workflows on-demand
    └── knowledge/            # Domain reference
```

| When to Use                         | Examples                |
| ----------------------------------- | ----------------------- |
| Remember across sessions            | Journal companion       |
| User preferences/settings           | Novel writing buddy     |
| Personal knowledge base             | Job augmentation agent  |
| Learning/evolving over time         | Therapy/health tracking |
| Domain-specific + restricted access | Fitness coach with PRs  |
| Complex multi-step workflows        | Language tutor          |

**Required critical_actions:**

```yaml
critical_actions:
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/memories.md"
  - "Load COMPLETE file {project-root}/_bmad/_memory/{sidecar-folder}/instructions.md"
  - "ONLY read/write files in {project-root}/_bmad/_memory/{sidecar-folder}/"
```

---

## Comparison

| Aspect            | Without Sidecar | With Sidecar            |
| ----------------- | --------------- | ----------------------- |
| Structure         | Single YAML     | YAML + sidecar/         |
| Persistent memory | No              | Yes                     |
| critical_actions  | Optional        | MANDATORY               |
| Workflows         | Inline prompts  | Sidecar files           |
| File access       | Project/output  | Restricted to sidecar   |
| Session state     | Stateless       | Remembers               |
| Best for          | Focused skills  | Long-term relationships |

---

## Selection Checklist

**Without sidecar:**

- [ ] One clear purpose, related skills
- [ ] No cross-session memory needed
- [ ] Fits in ~250 lines
- [ ] Independent interactions
- [ ] Persona-driven value

**With sidecar:**

- [ ] Memory across sessions
- [ ] Personal knowledge base
- [ ] Domain-specific expertise
- [ ] Restricted file access
- [ ] Progress tracking/history
- [ ] Complex workflows

**Escalate to Module Builder if:**

- [ ] Multiple distinct personas needed
- [ ] Many specialized workflows
- [ ] Multiple users with mixed data scope
- [ ] Shared resources across agents

---

## Quick Tips

- Unsure? Ask about **memory needs first**
- Multiple personas → Module Builder, not one giant agent
- Ask: memory needs, user count, data scope, integration plans
- Personality agents → usually without sidecar
- Relationship/coaching agents → usually with sidecar
