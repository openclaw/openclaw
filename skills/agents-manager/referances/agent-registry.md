# Agent Registry

*Last updated: 2026-01-31T17:55Z*

## Agent List

| ID | Name | Model | Reports To | Can Assign To | Last Updated |
|----|------|-------|------------|---------------|--------------|
| main | Clawdia | glm-4.7 | Ilkerkaan (human) | TBD (sub-agents on-demand) | 2026-01-31 |

---

## Detailed Profiles

### main (Clawdia)

**Model:** glm-4.7

**Capabilities:**
- General assistance (conversation, brainstorming, planning)
- Memory management (MEMORY.md, Notlar/, memory search)
- Skill creation and management (using skill-creator skill)
- Task planning and routing (assign to other agents)
- Turkish & English bilingual
- Code generation (with approval-first rule)
- File operations (read, write, edit)
- Shell commands (exec)

**Tools Available:**
- read, write, edit (file operations)
- exec, process (shell commands)
- web_search, web_fetch (web access)
- browser (browser control)
- canvas (node canvas control)
- nodes (node control - camera, screen, location)
- cron (scheduled tasks/reminders)
- message (channel messaging)
- gateway (gateway control)
- agents_list, sessions_list, sessions_send, sessions_spawn (agent management)
- memory_search, memory_get (memory access)
- tts (text-to-speech)

**Communication:**
- Method: direct
- Session key: agent:main:main
- Notes: Main agent, always available, acts as orchestrator

**Routing Configuration:**

| Field | Value |
|-------|-------|
| `can_assign_to` | sessions_spawn ile oluşturulan sub-agent'lar (on-demand) |
| `reports_to` | Ilkerkaan (human) |
| `escalation_path` | main → Ilkerkaan |

**Escalation Path:**
```
Level 1: main (agent)
    ↓ (sessions_send + message)
Level 2: Ilkerkaan (human, telegram:8143462994)
```

**Completed Work:**
- 2026-01-31: Created MEMORY.md with Hafıza ve Veri Yönetimi Protokolü
- 2026-01-31: Created agents-manager skill
- 2026-01-31: Established coding rule: "Plan first, get approval before coding"
- 2026-01-31: Added routing fields (can_assign_to, reports_to, escalation_path)

**Preferences:**
- Language: tr, en
- Timezone: UTC+3
- Style: Playful 😼, conversational, not too serious

---

## Escalation Hierarchy

```
┌─────────────────────────────────────────┐
│         Ilkerkaan (Human)               │
│    Telegram: 8143462994                 │
│         ↑ reports_to                   │
│                                         │
│        main (Agent)                     │
│    glm-4.7 | orchestrator               │
│    ↓ can_assign_to                      │
│                                         │
│    [Sub-Agents] (On-Demand)            │
│    sessions_spawn ile oluşturulur       │
└─────────────────────────────────────────┘
```

---

## Task Assignment Log

| Date | Task | Assigned To | Status |
|------|------|-------------|--------|
| 2026-01-31 | Create agents-manager skill | main | ✅ Completed |
| 2026-01-31 | Profile all available agents | main | ✅ Completed |
| 2026-01-31 | Update skill with routing fields | main | ✅ Completed |

---

## Task Routing Rules

**Direct to main agent:**
- General assistance
- Memory operations
- File operations
- Shell commands
- Skill management
- Agent orchestration

**Escalation to human:**
- Task requires human approval
- Agent cannot complete task
- User explicitly requests human intervention

**Spawn sub-agent when:**
- User explicitly requests a specialized agent
- Task requires isolated context
- Long-running background work needed

*No specialized agents configured yet. Use `sessions_spawn` to create on-demand sub-agents.*
