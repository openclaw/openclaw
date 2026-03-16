---
summary: "Configuration reference for the Operator1 multi-agent system — openclaw.json structure, agent definitions, and include directives."
updated: "2026-03-16"
title: "Configuration"
---

# Configuration

Operator1 is configured through JSON files. These define the agent hierarchy, gateway behavior, channels, and how memory is stored.

## Visual Overview

![Operator1 Configuration System](/images/config-system-infographic.png)
_The configuration system architecture showing how openclaw.json, $include directives, and agent workspaces combine to create the running multi-agent system_

## Config file layout

```
~/.openclaw/
   +-- openclaw.json              # Primary config (gateway, channels, models, etc.)
   +-- matrix-agents.json         # Agent hierarchy ($included from openclaw.json)
   +-- operator1.db               # Unified state database (SQLite, WAL mode)
   +-- .env                       # Environment variables (PATH, etc.)
   +-- credentials/               # Web provider credentials
   +-- workspace/                 # Operator1 workspace
   +--   projects/{id}/memory/    # Project-scoped memory (per project)
   +-- workspace-neo/             # Neo workspace
   +-- workspace-morpheus/        # Morpheus workspace
   +-- workspace-trinity/         # Trinity workspace
   +-- workspace-{agentId}/       # Worker workspaces
   +-- agents/{agentId}/agent/    # Agent runtime directories
```

## State database: operator1.db

All runtime state is stored in `~/.openclaw/operator1.db` (SQLite). The database is created automatically and uses WAL mode for safe concurrent access.

### Data stored

| What             | Purpose                                 |
| ---------------- | --------------------------------------- |
| Config overrides | Registry and project settings           |
| Projects         | Project definitions and repo references |
| Agent scopes     | Marketplace scope assignments           |
| Sessions         | Session metadata and project bindings   |
| Settings         | Global, agent, and project settings     |
| Audit log        | Security event history                  |

### Schema versions

The database auto-updates to the latest schema (current: v10) on startup. Run `openclaw doctor` to check database health.

### Config priority

Settings are checked in this order:

1. SQLite (if set)
2. openclaw.json
3. Built-in defaults

This lets you change settings either way.

## Primary config: openclaw.json

The primary config file contains all gateway-level settings. The agent hierarchy is split into a separate file via `$include`.

### Top-level structure

```json
{
  "$include": ["./matrix-agents.json"],
  "meta": {},
  "env": {},
  "wizard": {},
  "auth": {},
  "acp": {},
  "models": {},
  "agents": {},
  "tools": {},
  "messages": {},
  "commands": {},
  "hooks": {},
  "channels": {},
  "gateway": {},
  "memory": {},
  "skills": {},
  "plugins": {}
}
```

### Key sections

#### `$include`

Merges additional config files into the primary config. Used to keep the agent hierarchy in a separate, manageable file.

```json
{
  "$include": ["./matrix-agents.json"]
}
```

Paths are relative to the config file location (`~/.openclaw/`).

#### `env`

Environment variables available to the gateway process and spawned agents.

```json
{
  "env": {
    "PATH": "/usr/local/bin:...",
    "ANTHROPIC_API_KEY": "...",
    "WHISPER_MODEL": "large-v3-turbo"
  }
}
```

#### `auth`

Provider authentication profiles. Each profile maps a `provider:mode` key to credentials.

```json
{
  "auth": {
    "profiles": {
      "anthropic:api-key": { "apiKey": "..." },
      "openai:api-key": { "apiKey": "..." }
    }
  }
}
```

#### `acp`

Agent Communication Protocol settings — controls how agents spawn Claude Code sessions.

```json
{
  "acp": {
    "enabled": true,
    "dispatch": "round-robin",
    "backend": "acpx",
    "defaultAgent": "main",
    "allowedAgents": ["main", "neo", "morpheus", "trinity"],
    "maxConcurrentSessions": 4,
    "stream": true,
    "runtime": "claude-code"
  }
}
```

#### `models`

Model provider configuration and selection.

```json
{
  "models": {
    "mode": "single",
    "providers": {
      "anthropic": { "model": "claude-sonnet-4-20250514" }
    }
  }
}
```

#### `agents`

Agent defaults and the agent list. The `list` is typically populated via `$include` from `matrix-agents.json`.

```json
{
  "agents": {
    "defaults": {
      "model": "zai/glm-4.7",
      "workspace": "~/.openclaw/workspace",
      "maxConcurrent": 3,
      "subagents": [],
      "timeoutSeconds": 1800
    },
    "list": []
  }
}
```

See the [agent definition schema](#agent-definition-schema) below for list entry format.

#### `channels`

Channel plugin configuration. See [Channels](/operator1/channels) for details.

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "dmPolicy": "pairing",
      "botToken": "..."
    }
  }
}
```

#### `gateway`

Gateway server settings.

```json
{
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback",
    "auth": { "token": "..." },
    "tailscale": {},
    "tls": {}
  }
}
```

#### `memory`

Memory backend configuration. See [Memory System](/operator1/memory-system) for details.

```json
{
  "memory": {
    "backend": "qmd",
    "citations": "on",
    "qmd": {
      "command": "/path/to/qmd",
      "searchMode": "query",
      "update": { "commandTimeoutMs": 60000 },
      "limits": { "timeoutMs": 30000 }
    }
  }
}
```

#### `hooks`

Internal hooks for event-driven automation.

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {}
    }
  }
}
```

#### `tools`

Tool configuration including media processing and MCP servers.

```json
{
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": {}
      }
    },
    "mcp": {
      "maxResultBytes": 102400,
      "toolSearchThreshold": 15,
      "servers": {
        "my-server": {
          "type": "sse",
          "url": "http://localhost:3001/sse",
          "toolNames": "prefixed"
        }
      }
    }
  }
}
```

See [MCP Integration](/operator1/mcp) for the full MCP configuration reference.

#### `commands`

CLI command configuration, native skills, and display settings.

```json
{
  "commands": {
    "native": true,
    "nativeSkills": true,
    "restart": {},
    "ownerDisplay": "..."
  }
}
```

## Agent hierarchy: matrix-agents.json

This file defines the full agent tree. It is included into `openclaw.json` via `$include` and merges into the `agents.list` array.

### Agent definition schema

Each agent entry has these fields:

| Field            | Type     | Required | Description                                          |
| ---------------- | -------- | -------- | ---------------------------------------------------- |
| `id`             | string   | Yes      | Unique agent identifier (e.g., `neo`)                |
| `name`           | string   | Yes      | Display name (e.g., `Neo`)                           |
| `department`     | string   | Yes      | Department: `engineering`, `marketing`, `finance`    |
| `role`           | string   | Yes      | Role title (e.g., `CTO`, `Backend Engineer`)         |
| `workspace`      | string   | Yes      | Path to agent workspace directory                    |
| `agentDir`       | string   | Yes      | Path to agent runtime directory                      |
| `identity`       | string   | No       | Path to IDENTITY.md                                  |
| `subagents`      | string[] | No       | Agent IDs this agent can spawn                       |
| `model`          | string   | No       | Model override (defaults to `agents.defaults.model`) |
| `maxConcurrent`  | number   | No       | Max concurrent sessions                              |
| `timeoutSeconds` | number   | No       | Session timeout                                      |

### Example: Tier 2 agent

```json
{
  "id": "neo",
  "name": "Neo",
  "department": "engineering",
  "role": "CTO",
  "model": "zai/glm-5",
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

### Example: Tier 3 worker

```json
{
  "id": "tank",
  "name": "Tank",
  "department": "engineering",
  "role": "Backend Engineer",
  "model": "zai/glm-4.7",
  "workspace": "~/.openclaw/workspace-tank",
  "agentDir": "~/.openclaw/agents/tank/agent",
  "identity": "~/.openclaw/workspace-tank/IDENTITY.md",
  "subagents": []
}
```

### Template

A ready-to-use template is available at `Project-tasks/matrix/matrix-agents.template.json`. Copy it to `~/.openclaw/matrix-agents.json` and update paths to match your home directory.

## Projects

Projects are stored in the `op1_projects` SQLite table and link agent sessions to codebases or workstreams.

### Project types

| Type       | Description                                   | Memory location                                                                               |
| ---------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `internal` | Workspace-managed projects (no external repo) | `~/.openclaw/workspace/projects/{id}/memory/`                                                 |
| `external` | References to external repositories           | `~/.openclaw/workspace/projects/{id}/memory/` (centralized, never pollutes the external repo) |

### Session binding

Sessions can be bound to a project via:

- **Auto-bind** — Telegram topic messages automatically bind to the matching project
- **RPC** — `projects.bindSession` / `projects.unbindSession`
- **Subagent inheritance** — child sessions inherit the parent's `project_id` automatically

When a session is bound to a project, the agent receives project context (soul, agents, tools, memory path) injected into its system prompt.

### Project memory

Each project gets an isolated memory directory at `~/.openclaw/workspace/projects/{id}/memory/`. Memory search (`memory.search`) auto-discovers these directories via `extraPaths` and indexes them alongside the agent's workspace memory.

## Config hot reload

The gateway supports hot-reloading configuration changes without restart for most settings. See the [gateway configuration docs](/gateway/configuration) for details on which settings hot-apply vs require a restart.

## Related

- [Agent Configs](/operator1/agent-configs) — workspace file reference
- [MCP Integration](/operator1/mcp) — external tool server configuration
- [Memory System](/operator1/memory-system) — memory backend setup
- [Channels](/operator1/channels) — channel integration config
- [Deployment](/operator1/deployment) — new machine setup
- [RPC Reference](/operator1/rpc) — projects and session RPCs
