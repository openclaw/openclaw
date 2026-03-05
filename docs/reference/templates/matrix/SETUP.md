# Matrix Agent System — Setup Prerequisites

## Overview

The Matrix system is a hierarchical multi-agent orchestration framework:

```
Operator1 (CEO)
├── Neo (CTO) → 10 engineering workers → ACP coding agents
├── Morpheus (CMO) → 10 marketing workers
└── Trinity (CFO) → 10 finance workers
```

## Prerequisites

### 1. ACP Plugin Configuration

The spawn chain requires the ACP plugin (acpx) to be enabled with auto-approval so coding agents can run without manual permission prompts:

```json
{
  "plugins": {
    "entries": {
      "acpx": {
        "enabled": true,
        "config": {
          "permissionMode": "approve-all"
        }
      }
    }
  }
}
```

**Without this**, ACP spawns will fail with error code 5 (permission denied). This is the most common setup issue.

### 2. Deploy via CLI

```bash
openclaw matrix init
```

This command:

- Copies agent templates to `~/.openclaw/agents/<agentId>/agent/`
- Creates workspace directories for agents that need them
- Merges agent definitions into `~/.openclaw/openclaw.json`
- Sets dynamic model inheritance via `agents.defaults.model.primary`

### 3. Model Configuration

All agents inherit their model from `agents.defaults.model.primary`. Set this to your preferred model:

```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "your-provider/model-name"
      }
    }
  }
}
```

No individual agent has a hardcoded model — changing the default changes all agents.

## Spawn Chain Communication

### Spawning Workers

Department heads spawn workers via `sessions_spawn`:

```
sessions_spawn(agentId: "tank", task: "...", label: "tank-api-work-" + Date.now())
```

### ACP Coding Sessions (Engineering)

Engineering workers spawn CLI coding agents:

```
sessions_spawn(runtime: "acp", agentId: "claude", task: "...", cwd: "/path/to/project", label: "tank-feature-" + Date.now())
```

### Progress Reporting

Agents report progress to the user via the `message` tool (not `sessions_send`):

```
message({ channel: "telegram", target: "<chatId>", text: "Task complete. Results: ..." })
```

### Label Uniqueness

Always append `Date.now()` to labels to avoid session collisions when a worker is spawned multiple times:

```
label: "tank-rate-limiting-" + Date.now()
```

## Workspace Tiers

| Tier      | Agents                                                 | Workspace                                       |
| --------- | ------------------------------------------------------ | ----------------------------------------------- |
| Full      | Operator1, Neo, Morpheus, Trinity + original 9 workers | 8-file workspace (SOUL, AGENTS, TOOLS, etc.)    |
| Minimal   | Spark, Ink, Vibe, Ledger, Quota                        | SOUL.md + IDENTITY.md only                      |
| Ephemeral | 16 remaining tier-3 workers                            | No workspace — context injected via task string |

## Troubleshooting

| Symptom                            | Cause                                   | Fix                                                             |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------------- |
| ACP spawn fails with code 5        | Missing permissionMode config           | Add `plugins.entries.acpx.config.permissionMode: "approve-all"` |
| Label collision errors             | Reusing static labels                   | Append `Date.now()` to all labels                               |
| Worker codes instead of delegating | SOUL.md not enforcing orchestrator role | Check SOUL.md has "orchestrator, not coder" language            |
| Progress not reaching user         | Using `sessions_send`                   | Switch to `message` tool with channel + chat ID                 |
