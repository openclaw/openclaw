---
summary: "System architecture of the Operator1 multi-agent system — components, tiers, and integration with OpenClaw gateway."
updated: "2026-03-16"
title: "Architecture"
---

# Architecture

Operator1 is a multi-agent system built on OpenClaw. It organizes AI agents into a corporate hierarchy (similar to how a real company is structured) so they can automatically delegate tasks, execute work, and report results.

## System overview

```mermaid
flowchart TD
    subgraph Human
        CEO["CEO (Human operator)"]
    end

    subgraph Tier1["Tier 1 — Coordinator"]
        OP1["Operator1 (COO)"]
    end

    subgraph Tier2["Tier 2 — Department Heads"]
        NEO["Neo (CTO)"]
        MORPH["Morpheus (CMO)"]
        TRIN["Trinity (CFO)"]
    end

    subgraph Tier3["Tier 3 — Workers"]
        ENG["Tank, Dozer, Mouse, Spark, Cipher, Relay, Ghost, Binary, Kernel, Prism"]
        MKT["Niobe, Switch, Rex, Ink, Vibe, Lens, Echo, Nova, Pulse, Blaze"]
        FIN["Oracle, Seraph, Zee, Ledger, Vault, Shield, Trace, Quota, Merit, Beacon"]
    end

    subgraph Execution["Execution Layer"]
        ACP["ACP Backend (Claude Code / acpx)"]
    end

    CEO --> OP1
    OP1 --> NEO
    OP1 --> MORPH
    OP1 --> TRIN
    NEO --> ENG
    MORPH --> MKT
    TRIN --> FIN
    ENG --> ACP
    MKT --> ACP
    FIN --> ACP
```

## Core components

### Gateway

The OpenClaw gateway is the runtime that runs all agents. It handles:

- Config management and agent sessions
- Messaging (Telegram, WhatsApp, Discord, iMessage)
- Spawning Claude Code when needed
- Connecting external tools
- Memory and semantic search

All agents run in a single gateway process. See [Gateway Patterns](/operator1/gateway-patterns) for other deployment options.

### Agent runtime

Each agent runs in an isolated session. Key components:

| Component    | What it stores                                          |
| ------------ | ------------------------------------------------------- |
| Workspace    | SOUL.md, AGENTS.md, MEMORY.md (agent personality files) |
| Session logs | Events and output from each run                         |
| Credentials  | API keys and provider access tokens                     |
| Memory       | Knowledge and previous notes (searchable)               |
| Tools        | Which capabilities the agent can use                    |

### Config system

Two config files work together:

```
~/.openclaw/openclaw.json    # Gateway settings (channels, models, auth)
    ├── Includes: matrix-agents.json
matrix-agents.json           # Agent definitions (hierarchy, roles, models)
```

See [Configuration](/operator1/configuration) for details.

### State database

All data is stored in `~/.openclaw/operator1.db` (SQLite):

```
operator1.db
├── op1_config      # Config overrides
├── op1_projects    # Project definitions
├── session_entries # Session data
├── core_settings   # Scoped settings
└── audit_log       # Security events
```

The database is created automatically and updates to the latest version on startup. Run `openclaw doctor` to check database health.

## Three-tier model

The hierarchy enforces structured delegation with clear boundaries:

| Tier       | Role               | Agents                         | Model                   | Delegation                     |
| ---------- | ------------------ | ------------------------------ | ----------------------- | ------------------------------ |
| **Tier 1** | Coordinator        | Operator1                      | Strongest available     | Delegates to Tier 2 only       |
| **Tier 2** | Department heads   | Neo, Morpheus, Trinity         | Strong (e.g., glm-5)    | Delegates to any Tier 3 worker |
| **Tier 3** | Specialist workers | 30 agents across 3 departments | Capable (e.g., glm-4.7) | Spawns Claude Code via ACP     |

### Spawn depth

The system enforces `maxSpawnDepth: 4` to prevent runaway delegation chains:

```
Human → Operator1 → Neo → Tank → Claude Code (ACP)
  0         1         2      3         4
```

### Shared talent pool

Tier 3 workers are available to **all** department heads, not just their home department. Neo can spawn Oracle (finance) for data analysis, and Trinity can spawn Tank (engineering) for automation tasks. Cross-department spawning is configured via the `subagents` field on each Tier 2 agent.

## Integration stack

```mermaid
flowchart LR
    subgraph Channels
        TG["Telegram"]
        WA["WhatsApp"]
        DC["Discord"]
        IM["iMessage"]
    end

    subgraph Gateway["OpenClaw Gateway (port 18789)"]
        Router["Message Router"]
        Sessions["Session Manager"]
        Memory["Memory Manager"]
        Config["Config Manager"]
        StateDB["State DB (SQLite)"]
    end

    subgraph Agents["Agent Layer"]
        OP1["Operator1"]
        Heads["Department Heads"]
        Workers["Workers"]
    end

    subgraph Backend["Execution"]
        ACP["ACP / Claude Code"]
    end

    Channels --> Router
    Router --> Sessions
    Sessions --> OP1
    OP1 --> Heads
    Heads --> Workers
    Workers --> ACP
    Memory --- Sessions
    Config --- Gateway
    StateDB --- Sessions
    StateDB --- Config
```

## Key design principles

**Isolation** — Each agent has its own workspace and memory. Agents don't share state directly; they communicate by spawning each other with explicit context.

**Structured flow** — Tasks move down the hierarchy. Cross-department work routes through Operator1 for coordination.

**Workspace memory** — Each agent stores its own notes, knowledge files, and searchable memory index.

**Config-driven** — The entire hierarchy is defined in JSON, so you can add or remove agents without code changes.

**Single database** — All state lives in `operator1.db` (SQLite) for reliable concurrent access and automatic schema updates.

**Project memory** — Projects isolate memory for different codebases. Sub-agents inherit their parent's project context automatically.
