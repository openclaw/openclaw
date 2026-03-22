---
summary: "Core agent hierarchy for the Operator1 system — 4 leadership agents and a 147+ persona registry for specialist workers."
updated: "2026-03-22"
title: "Agent Hierarchy"
---

# Agent Hierarchy

Operator1 has **4 core agents** organized into two leadership tiers, supported by a vast **Persona Registry of 147+ specialist personas** that can be spawned on-demand for specific tasks.

## Visual Overview

![Operator1 Agent Hierarchy](/images/agent-hierarchy-infographic.png)
_The 4-agent core hierarchy supported by a dynamic library of specialist personas._

## Core agent tree

```
CEO (Human operator)
   |
   +-- Operator1 (COO) ........................ Tier 1
          |
          +-- Neo (CTO - Engineering) ......... Tier 2
          +-- Morpheus (CMO - Marketing) ...... Tier 2
          +-- Trinity (CFO - Finance) ......... Tier 2
                 |
                 +-- [Dynamic Specialist Workers] (Tier 3)
                     (Spawned from Persona Registry)
```

## Tier 1 — Coordinator

| Agent         | Role                                                            | Model               | Workspace                |
| ------------- | --------------------------------------------------------------- | ------------------- | ------------------------ |
| **Operator1** | COO — task intake, classification, delegation, status reporting | Strongest available | `~/.openclaw/workspace/` |

Operator1 is the single entry point for all human requests. It:

- Receives tasks from the CEO via messaging channels
- Classifies tasks by department (engineering, marketing, finance)
- Delegates to the appropriate C-suite head
- Tracks progress and reports back

## Tier 2 — Department heads

| Agent        | Title | Department  | Responsibilities                                                           |
| ------------ | ----- | ----------- | -------------------------------------------------------------------------- |
| **Neo**      | CTO   | Engineering | Architecture decisions, code review, technical planning, worker assignment |
| **Morpheus** | CMO   | Marketing   | Content strategy, brand direction, campaign planning, creative oversight   |
| **Trinity**  | CFO   | Finance     | Financial analysis, budgeting, compliance, risk management                 |

Department heads receive delegated tasks from Operator1 and use the **Persona Registry** to spawn the best-fit specialist for the work.

## Tier 3 — Specialist Workers (Persona Registry)

Specialist workers are no longer fixed, pre-deployed agents. Instead, they are created dynamically using the **Persona Registry**, which contains over 147 specialized personas across 13 categories.

### Persona Categories

| Category        | Description                                     | Example Personas                                  |
| --------------- | ----------------------------------------------- | ------------------------------------------------- |
| **Engineering** | Backend, Frontend, DevOps, Security, AI, Mobile | `backend-architect`, `sre`, `security-engineer`   |
| **Marketing**   | Content, SEO, Social Media, Growth, PR          | `content-creator`, `seo-specialist`, `copywriter` |
| **Leadership**  | Role templates for core agents                  | `cto`, `cmo`, `cfo`, `coo`                        |
| **Design**      | UI/UX, Visual Storytelling, Brand Identity      | `ui-designer`, `ux-researcher`                    |
| **Game Dev**    | Godot, Unity, Unreal, Level/Narrative Design    | `unity-architect`, `narrative-designer`           |
| **Finance**     | Analysis, Compliance, Bookkeeping, Risk         | `data-analyst`, `financial-analyst`               |
| **Specialized** | Support, HR, Legal, and other niche roles       | `technical-writer`, `support-specialist`          |

### Benefits of Persona Spawning

- **On-Demand Specialization**: Spawn the exact expert needed for a single sub-task.
- **Resource Efficiency**: Only run the agents you need right now.
- **Vast Knowledge Base**: Access 147+ distinct personality and decision frameworks.
- **Consistent Context**: Each worker inherits the parent's project context and goals.

## Model assignments

| Tier   | Model Class         | Example         | Rationale                                        |
| ------ | ------------------- | --------------- | ------------------------------------------------ |
| Tier 1 | Strongest available | Latest flagship | Complex reasoning, multi-department coordination |
| Tier 2 | Strong              | zai/glm-5       | Department-level planning and oversight          |
| Tier 3 | Capable             | zai/glm-4.7     | Specialized task execution                       |

Model assignments are configured in the global `openclaw.json` and can be overridden per agent or per spawn.

Model assignments are configured in `matrix-agents.json` and can be overridden per agent.

## Workspace structure

Each agent has a dedicated workspace directory at `~/.openclaw/workspace-{agentId}/` containing:

| File           | Purpose                                                | Required |
| -------------- | ------------------------------------------------------ | -------- |
| `SOUL.md`      | Persona, values, decision framework                    | Yes      |
| `AGENTS.md`    | Workspace rules, delegation patterns, memory structure | Yes      |
| `IDENTITY.md`  | Name, role, emoji, department, creature type           | Yes      |
| `MEMORY.md`    | Curated long-term memory                               | Yes      |
| `TOOLS.md`     | Tool-specific notes, credential references             | Optional |
| `HEARTBEAT.md` | Periodic task checklist                                | Optional |
| `USER.md`      | Human preferences and context                          | Optional |
| `BOOTSTRAP.md` | First-run setup ritual                                 | Optional |

See [Agent Configs](/operator1/agent-configs) for detailed file reference.

## Template locations

- **Generic templates**: `docs/reference/templates/` — base versions of all workspace files
- **Matrix-specific templates**: `docs/reference/templates/matrix/{agentId}/` — role-specific overrides for each agent

When bootstrapping a new agent, copy from the matrix-specific template if one exists, otherwise fall back to the generic template.

## Agent scopes

Agent marketplace scopes (which tools, channels, and capabilities each agent can access) are persisted in the `agent_scopes` SQLite table in `operator1.db`. This replaces the previous JSON-only approach, enabling dynamic scope updates via RPC without config file edits.

## Agent configuration

Each agent is defined in `matrix-agents.json` with these fields:

```json
{
  "id": "neo",
  "name": "Neo",
  "department": "engineering",
  "role": "CTO",
  "workspace": "~/.openclaw/workspace-neo",
  "agentDir": "~/.openclaw/agents/neo/agent",
  "identity": "~/.openclaw/workspace-neo/IDENTITY.md",
  "subagents": ["*"]
}
```

See [Configuration](/operator1/configuration) for the full config reference.
