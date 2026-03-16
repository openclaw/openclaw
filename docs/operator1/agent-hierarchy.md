---
summary: "Complete agent hierarchy for the Operator1 system — all 34 agents, their roles, departments, and workspace structure."
updated: "2026-03-16"
title: "Agent Hierarchy"
---

# Agent Hierarchy

Operator1 has 34 agents organized into three tiers: a coordinator, three department heads, and thirty specialist workers. Each agent has a specific role and workspace.

## Visual Overview

![Operator1 Agent Hierarchy](/images/agent-hierarchy-infographic.png)
_The 34-agent Matrix hierarchy organized into three tiers across Engineering, Marketing, and Finance departments_

## Full agent tree

```
CEO (Human operator)
   |
   +-- Operator1 (COO) ........................ Tier 1
          |
          +-- Neo (CTO - Engineering) ......... Tier 2
          |      +-- Tank (Backend Engineer)
          |      +-- Dozer (DevOps Engineer)
          |      +-- Mouse (QA + Research)
          |      +-- Spark (Frontend Engineer)
          |      +-- Cipher (Security Engineer)
          |      +-- Relay (Integration Engineer)
          |      +-- Ghost (Data Engineer)
          |      +-- Binary (Mobile Engineer)
          |      +-- Kernel (Systems Engineer)
          |      +-- Prism (AI/ML Engineer)
          |
          +-- Morpheus (CMO - Marketing) ...... Tier 2
          |      +-- Niobe (Content Strategist)
          |      +-- Switch (Creative Director)
          |      +-- Rex (PR + Communications)
          |      +-- Ink (Copywriter)
          |      +-- Vibe (Social Media Manager)
          |      +-- Lens (Video Producer)
          |      +-- Echo (Email Marketing)
          |      +-- Nova (SEO Specialist)
          |      +-- Pulse (Community Manager)
          |      +-- Blaze (Brand Strategist)
          |
          +-- Trinity (CFO - Finance) ......... Tier 2
                 +-- Oracle (Data Analyst)
                 +-- Seraph (Security + Compliance)
                 +-- Zee (Financial Analyst)
                 +-- Ledger (Bookkeeper)
                 +-- Vault (Investment Analyst)
                 +-- Shield (Insurance + Risk)
                 +-- Trace (Expense Tracker)
                 +-- Quota (Budget Manager)
                 +-- Merit (Procurement)
                 +-- Beacon (Tax Specialist)
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
- Handles cross-department coordination

## Tier 2 — Department heads

| Agent        | Title | Department  | Responsibilities                                                           |
| ------------ | ----- | ----------- | -------------------------------------------------------------------------- |
| **Neo**      | CTO   | Engineering | Architecture decisions, code review, technical planning, worker assignment |
| **Morpheus** | CMO   | Marketing   | Content strategy, brand direction, campaign planning, creative oversight   |
| **Trinity**  | CFO   | Finance     | Financial analysis, budgeting, compliance, risk management                 |

Department heads:

- Receive delegated tasks from Operator1
- Read their workspace SOUL.md and AGENTS.md for context
- Break down complex tasks into worker-sized units
- Create requirements briefs for workers
- Can spawn **any** Tier 3 worker (shared talent pool)
- Report results back to Operator1

## Tier 3 — Workers

### Engineering (reports to Neo)

| Agent      | Role                 | Specialization                           |
| ---------- | -------------------- | ---------------------------------------- |
| **Tank**   | Backend Engineer     | APIs, databases, server-side logic       |
| **Dozer**  | DevOps Engineer      | CI/CD, infrastructure, deployment        |
| **Mouse**  | QA + Research        | Testing, research, investigation         |
| **Spark**  | Frontend Engineer    | UI components, web apps, styling         |
| **Cipher** | Security Engineer    | Security audits, vulnerability analysis  |
| **Relay**  | Integration Engineer | APIs, webhooks, third-party services     |
| **Ghost**  | Data Engineer        | Data pipelines, ETL, data modeling       |
| **Binary** | Mobile Engineer      | iOS, Android, cross-platform apps        |
| **Kernel** | Systems Engineer     | OS-level, performance, low-level systems |
| **Prism**  | AI/ML Engineer       | Machine learning, model integration      |

### Marketing (reports to Morpheus)

| Agent      | Role                 | Specialization                        |
| ---------- | -------------------- | ------------------------------------- |
| **Niobe**  | Content Strategist   | Content planning, editorial calendar  |
| **Switch** | Creative Director    | Visual design, creative direction     |
| **Rex**    | PR + Communications  | Press releases, external comms        |
| **Ink**    | Copywriter           | Copy, messaging, tone of voice        |
| **Vibe**   | Social Media Manager | Social content, engagement            |
| **Lens**   | Video Producer       | Video content, editing                |
| **Echo**   | Email Marketing      | Email campaigns, newsletters          |
| **Nova**   | SEO Specialist       | Search optimization, keyword strategy |
| **Pulse**  | Community Manager    | Community engagement, support         |
| **Blaze**  | Brand Strategist     | Brand identity, positioning           |

### Finance (reports to Trinity)

| Agent      | Role                  | Specialization                          |
| ---------- | --------------------- | --------------------------------------- |
| **Oracle** | Data Analyst          | Data analysis, reporting, dashboards    |
| **Seraph** | Security + Compliance | Regulatory compliance, security policy  |
| **Zee**    | Financial Analyst     | Financial modeling, forecasting         |
| **Ledger** | Bookkeeper            | Transaction records, reconciliation     |
| **Vault**  | Investment Analyst    | Investment research, portfolio analysis |
| **Shield** | Insurance + Risk      | Risk assessment, insurance management   |
| **Trace**  | Expense Tracker       | Expense categorization, reporting       |
| **Quota**  | Budget Manager        | Budget planning, allocation tracking    |
| **Merit**  | Procurement           | Vendor management, purchasing           |
| **Beacon** | Tax Specialist        | Tax planning, compliance, filing        |

## Model assignments

| Tier   | Model Class         | Example         | Rationale                                        |
| ------ | ------------------- | --------------- | ------------------------------------------------ |
| Tier 1 | Strongest available | Latest flagship | Complex reasoning, multi-department coordination |
| Tier 2 | Strong              | zai/glm-5       | Department-level planning and oversight          |
| Tier 3 | Capable             | zai/glm-4.7     | Task execution, code generation                  |

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
  "subagents": [
    "tank",
    "dozer",
    "mouse",
    "spark",
    "cipher",
    "relay",
    "ghost",
    "binary",
    "kernel",
    "prism"
  ]
}
```

See [Configuration](/operator1/configuration) for the full config reference.
