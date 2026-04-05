---
name: brigade-management
description: Multi-brigade orchestration with role-based permissions, workspace isolation, semantic task decomposition, and security policies. Covers Dmarket-Dev, OpenClaw-Core, and Research-Ops brigades.
metadata:
  openclaw:
    emoji: "🏗️"
    category: ai
---

# Brigade Management

Multi-team orchestration with workspace isolation and permission boundaries.

## Brigades

### Dmarket-Dev

- **Purpose**: Dmarket bot development (D:\Dmarket_bot)
- **Chain**: Planner → Coder → Auditor
- **Permissions**: can_modify_dmarket=true, can_modify_framework=false
- **Restrictions**: `os.system`, `subprocess`, `openclaw_bot.core` namespaces blocked
- **MCP**: Dedicated `DmarketMCPClient` with fs_allowed_dirs=[workspace]

### OpenClaw-Core

- **Purpose**: Framework self-improvement and maintenance
- **Chain**: Planner → Foreman → Executor_Tools → Executor_Architect → Auditor → State_Manager → Archivist
- **Permissions**: can_modify_framework=true, can_execute_system_commands=true
- **MCP**: `OpenClawMCPClient` with full framework access

### Research-Ops

- **Purpose**: Deep research, analysis, and summarization
- **Chain**: Researcher → Analyst → Summarizer
- **Tools**: DeepResearchPipeline, MultiPerspectiveResearcher, BraveSearch

## Security Policy (`config/brigade_policy.json`)

```json
{
  "brigades": {
    "OpenClaw": {
      "permissions": {
        "can_modify_framework": true,
        "can_execute_system_commands": true,
        "restricted_namespaces": []
      }
    },
    "Dmarket": {
      "permissions": {
        "can_modify_framework": false,
        "can_execute_system_commands": false,
        "restricted_namespaces": ["os.system", "subprocess", "openclaw_bot.core"]
      }
    }
  }
}
```

## Semantic Decomposition

Complex tasks (>1 actionable paragraphs) are auto-split by `_semantic_decompose()`:

1. Paragraphs classified by intent (URL-bearing → Research, code-related → Dmarket/OpenClaw)
2. `_route_subtask()` maps each sub-task to appropriate brigade
3. Sub-tasks executed in sequence with context passing

## Agent Personas (14)

Defined in `config/openclaw_agents.json`:

- **Engineering**: Planner, Coder, Architect, Auditor, Test_Writer
- **Operations**: DevOps_Engineer, State_Manager, Archivist
- **Research**: Researcher, Analyst, Summarizer
- **Security**: Security_Auditor, Risk_Analyst
- **Management**: Foreman, Orchestrator

Each persona has: system_prompt, temperature, max_tokens, tools_allowed, model_preference.
