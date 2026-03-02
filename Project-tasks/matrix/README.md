# Matrix Multi-Agent Config

A 3-tier agent hierarchy for OpenClaw, themed after The Matrix.

## Hierarchy

```
Operator1 (Tier 1 - Orchestrator)
  Neo       (Tier 2 - Department Head, zai/glm-5)
  Morpheus  (Tier 2 - Department Head, zai/glm-5)
  Trinity   (Tier 2 - Department Head, zai/glm-5)
    Tank      (Tier 3 - Worker, zai/glm-4.7)
    Dozer     (Tier 3 - Worker, zai/glm-4.7)
    Mouse     (Tier 3 - Worker, zai/glm-4.7)
    Niobe     (Tier 3 - Worker, zai/glm-4.7)
    Switch    (Tier 3 - Worker, zai/glm-4.7)
    Rex       (Tier 3 - Worker, zai/glm-4.7)
    Oracle    (Tier 3 - Worker, zai/glm-4.7)
    Seraph    (Tier 3 - Worker, zai/glm-4.7)
    Zee       (Tier 3 - Worker, zai/glm-4.7)
```

Tier 3 agents are a **shared talent pool** — all three department heads can spawn any tier-3 worker.

## Setup

1. Copy `matrix-agents.template.json` to `~/.openclaw/matrix-agents.json`
2. Update `workspace` and `agentDir` paths to use your home directory (replace `~` with your absolute home path)
3. Add the include directive to your `~/.openclaw/openclaw.json`:

```json
{
  "$include": ["./matrix-agents.json"],
  ...rest of your config
}
```

4. Restart the gateway

## How it works

- `$include` deep-merges the agents file into the main config
- `subagents.allowAgents` defines which agents a parent can spawn via `sessions_spawn`
- `maxSpawnDepth: 3` allows Operator1 -> Department Head -> Worker delegation chains
- Each tier-2 and tier-3 agent has its own workspace and agent directory for isolated SOUL.md/IDENTITY.md persona files

See also: `Project-tasks/matrix-multi-agent-implementation.md`
