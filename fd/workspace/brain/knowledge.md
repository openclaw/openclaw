# Knowledge Organization

How the agent's knowledge is structured and accessed.

---

## Knowledge Sources

| Source | Type | Location | Update frequency |
|--------|------|----------|-----------------|
| SOUL.md | Identity | `openclaw/SOUL.md` | Rarely |
| IDENTITY.md | Authority | `openclaw/IDENTITY.md` | Rarely |
| MISSION.md | Objectives | `openclaw/MISSION.md` | Quarterly |
| Entity profiles | Facts | `bank/entities/` | On change |
| Client memory | Relationships | `memory/clients.md` | On change |
| Project memory | Work tracking | `memory/projects.md` | Weekly |
| Active context | Current focus | `bank/active-context.md` | Weekly |
| Opinions | Hypotheses | `bank/opinions.md` | As evidence accumulates |
| Agent SOUL files | Agent behavior | `agents/*/SOUL.md` | On change |
| Config files | Runtime settings | `config/` | On change |

---

## Knowledge Hierarchy

```
Permanent (rarely changes)
  └── SOUL.md, IDENTITY.md, OPERATING_RULES.md

Stable (changes quarterly)
  └── MISSION.md, entity profiles, SECURITY.md

Dynamic (changes weekly)
  └── active-context.md, projects.md, opinions.md

Volatile (changes per-session)
  └── conversation history, task queue, inbox
```

---

## Knowledge Access Pattern

1. **Always loaded:** SOUL, IDENTITY, OPERATING_RULES (defines behavior)
2. **Loaded per-request:** Relevant memory notes, active context
3. **Loaded on-demand:** Client details, project specifics, entity profiles
4. **Cached:** System state, schedule, finance summaries (30s TTL)
