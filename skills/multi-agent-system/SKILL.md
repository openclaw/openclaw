---
name: multi-agent-system
description: Multi-agent orchestration with 14 agent personas, 3 brigades, autonomous HEARTBEAT loop, semantic decomposition, and Chain-of-Agents sequential execution. Use when discussing agent coordination, persona behavior, or autonomous operation.
metadata:
  openclaw:
    emoji: "🤖"
    category: ai
---

# Multi-Agent System

Autonomous multi-agent orchestrator with persona-based role execution.

## Architecture

```
OpenClawGateway (Telegram/Discord)
├── Intent Classification → SmartModelRouter
├── Semantic Decomposer → splits complex tasks
├── AFlow Engine → generates execution chain
└── PipelineExecutor → sequential role execution
    ├── Role 1: System prompt + few-shot + memory context
    ├── Role 2: Receives compressed output from Role 1
    ├── ...
    └── Final role: Output → user
```

## HEARTBEAT Autonomous Loop

Defined in `HEARTBEAT.md`, the bot's autonomous cycle:

1. **READ** — Gather input (messages, events, monitoring)
2. **OBSERVE** — Analyze context, detect intent, classify urgency
3. **PLAN** — Select brigade + chain via AFlow, decompose if complex
4. **EXECUTE** — Run pipeline roles sequentially with tool access
5. **PERSIST** — Store results in SuperMemory, save successful patterns
6. **UPDATE** — Self-evolve via SAGE, update learning log

## Agent Personas (14)

Configured in `config/openclaw_agents.json`:

| Category    | Roles                                                         |
| ----------- | ------------------------------------------------------------- |
| Planning    | Planner, Architect, Foreman                                   |
| Execution   | Coder, Executor_Architect, Executor_Tools, Executor_Research  |
| Quality     | Auditor, Test_Writer, Security_Auditor                        |
| Analysis    | Researcher, Analyst, Summarizer                               |
| Management  | State_Manager, Archivist, Risk_Analyst                        |
| Specialized | Orchestrator, Prompt_Engineer, Data_Engineer, DevOps_Engineer |

Each persona has: temperature, max_tokens, system_prompt, tools_allowed, model_preference.

## Brigades

| Brigade       | Purpose                    | Workspace      |
| ------------- | -------------------------- | -------------- |
| Dmarket-Dev   | Bot development            | D:\Dmarket_bot |
| OpenClaw-Core | Framework self-improvement | ./ (root)      |
| Research-Ops  | Deep research & analysis   | N/A            |

## Key Components

- **SmartModelRouter** (`src/pipeline/_state.py`): Maps roles → models based on intent
- **AFlow Engine**: Dynamic chain generation (arXiv:2410.10762)
- **Semantic Decomposer**: Multi-paragraph task splitting
- **Context Bridge**: Cross-model context transfer (disabled in cloud mode)
- **SAGE Engine**: Self-evolution from auditor feedback
- **MAC Constitution**: Dynamic ethical rules via auditor analysis

## Security

- Brigade policies in `config/brigade_policy.json`
- Dmarket brigade: restricted from modifying framework code
- OpenClaw brigade: full system access
- Each brigade has dedicated MCP client with scoped filesystem access
