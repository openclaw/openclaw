---
summary: "Configuration reference for the Operator1 multi-agent system — openclaw.json structure, agent definitions, and include directives."
updated: "2026-03-22"
title: "Configuration"
---

# Configuration

Operator1 uses a **SQL-first configuration model** with JSON fallbacks. While primary logic and hierarchies can be defined in JSON files, all runtime settings, UI overrides, and project bindings are persisted to a unified SQLite database (`operator1.db`).

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

The system has migrated to a SQL-first configuration model. Settings changed via the **Configuration tab** in the UI or the **Onboarding GUI** are persisted to `operator1.db`.

Settings are checked in this order:

1. **SQLite (`op1_config`)** — Highest priority (UI/GUI overrides)
2. **`openclaw.json`** — File-based settings
3. **Built-in defaults** — System fallbacks

This ensures that UI-driven changes take precedence over static configuration files without requiring manual JSON editing.

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

CLI command configuration, native skills, and display settings. See [Slash Commands](/operator1/slash-commands) for the new unified command system.

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

## SQLite State Model

Operator1 has migrated to a **SQL-first state model**. All runtime state, configuration, and audit logs are consolidated into `~/.openclaw/operator1.db`.

### Domain Prefixes

The schema (v1-v12) organizes tables into logical domains:

| Prefix      | Domain         | Purpose                                             |
| :---------- | :------------- | :-------------------------------------------------- |
| `core_`     | Infrastructure | Schema versions, global settings, KV pairs.         |
| `session_`  | Sessions       | Session metadata, channel bindings, thread maps.    |
| `delivery_` | Outbound       | Reliable message delivery queue and retries.        |
| `agent_`    | Agents         | Auth profiles, subagent runs, capability registry.  |
| `channel_`  | Communication  | Telegram/Discord pairing and allowlists.            |
| `op1_`      | Operator1      | Teams, Marketplace, Commands, and Onboarding state. |

## Straico Provider

Operator1 supports **Straico** as a custom provider, giving you access to 50+ models (including Claude 4.5, GPT-5, and Gemini 3) via a single API key.

### Configuration

1. Set `STRAICO_API_KEY` in your environment.
2. In the **Control Panel**, select Straico as your provider.
3. Note: Straico models currently require `streaming: false` in the agent defaults.

```json
"models": {
  "providers": {
    "straico": {
      "baseUrl": "https://api.straico.com/v0",
      "apiKey": "${STRAICO_API_KEY}",
      "api": "openai-completions"
    }
  }
}
```

## Agent hierarchy: matrix-agents.json

This file defines the 4 core agents in the hierarchy. It is included into `openclaw.json` via `$include` and merges into the `agents.list` array. Specialist workers are spawned dynamically from the **Persona Registry** and do not need to be statically defined here.

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

### Example: Core Department Head (Tier 2)

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
  "subagents": ["*"]
}
```

_Note: `subagents: ["*"]` allows the agent to spawn any persona from the Registry._

### Persona-Based Spawning

Tier 3 workers are spawned using their persona slug. The gateway resolves the persona from `agents/personas/_index.json` and injects the corresponding settings and personality at runtime.

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
