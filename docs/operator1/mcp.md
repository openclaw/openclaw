---
summary: "MCP (Model Context Protocol) integration — connect external tool servers to Operator1 agents via the open MCP standard."
updated: "2026-03-22"
title: "MCP Integration"
---

# MCP Integration

Operator1 supports [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers. This lets agents use external tools from any MCP-compatible server. Tools are automatically discovered and available to all agents.

## Quick start

Add an MCP server to your config:

```json
{
  "tools": {
    "mcp": {
      "servers": {
        "my-server": {
          "type": "sse",
          "url": "http://localhost:3001/sse"
        }
      }
    }
  }
}
```

Restart the gateway. The server's tools are now available to all agents.

## Configuration

MCP config lives under the `tools.mcp` key in `openclaw.json`:

```json
{
  "tools": {
    "mcp": {
      "maxResultBytes": 102400,
      "toolSearchThreshold": 15,
      "servers": {
        "docs": {
          "type": "sse",
          "url": "https://docs-server.example.com/sse",
          "headers": {
            "Authorization": "Bearer ${DOCS_API_KEY}"
          },
          "toolNames": "bare",
          "timeout": 30000
        }
      }
    }
  }
}
```

### Global settings

| Field                 | Type   | Default  | Description                                                 |
| --------------------- | ------ | -------- | ----------------------------------------------------------- |
| `maxResultBytes`      | number | `102400` | Max bytes per tool result before truncation (100 KB)        |
| `toolSearchThreshold` | number | `15`     | Tool count threshold for auto-switching to Tool Search mode |
| `toolSearch`          | string | `"auto"` | Override: `"auto"`, `"always"`, or `"never"`                |

### Server settings

Each server entry is keyed by a unique name (e.g., `docs`, `my-server`):

| Field            | Type    | Default      | Description                                                             |
| ---------------- | ------- | ------------ | ----------------------------------------------------------------------- |
| `type`           | string  | —            | Transport type: `"http"`, `"sse"`, or `"stdio"`                         |
| `url`            | string  | —            | Server URL (required for `http` and `sse`)                              |
| `command`        | string  | —            | Command to run (required for `stdio`)                                   |
| `args`           | array   | —            | Arguments for the stdio command                                         |
| `cwd`            | string  | project root | Working directory for stdio servers                                     |
| `env`            | object  | —            | Environment variables passed to the stdio process                       |
| `headers`        | object  | —            | HTTP headers; supports `${ENV_VAR}` and `${ENV_VAR:-default}` templates |
| `auth`           | object  | —            | Auth configuration (see [Authentication](#authentication))              |
| `enabled`        | boolean | `true`       | Whether the server is active                                            |
| `timeout`        | number  | `30000`      | Per-call timeout in milliseconds                                        |
| `toolNames`      | string  | `"prefixed"` | Naming strategy: `"prefixed"` or `"bare"`                               |
| `prefix`         | string  | server key   | Custom prefix for prefixed naming                                       |
| `maxResultBytes` | number  | global value | Per-server override for result truncation                               |

## Transport types

### HTTP (default)

Streamable HTTP transport for modern MCP servers:

```json
{
  "type": "http",
  "url": "https://mcp-server.example.com/mcp"
}
```

### SSE

Server-Sent Events transport for legacy MCP servers:

```json
{
  "type": "sse",
  "url": "https://mcp-server.example.com/sse"
}
```

### Stdio

Run an MCP server as a local subprocess. The server communicates via stdin/stdout using JSON-RPC:

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": {
    "GITHUB_TOKEN": "${GITHUB_TOKEN}"
  }
}
```

Stdio servers are spawned on connect and terminated on shutdown. Environment variables from the `env` field are merged with the current process environment.

## Authentication

MCP servers can require authentication. Two auth types are supported:

### Bearer token

```json
{
  "type": "sse",
  "url": "https://secure-server.example.com/sse",
  "auth": {
    "type": "bearer",
    "token_env": "MCP_SERVER_TOKEN"
  }
}
```

The token is read from the specified environment variable and sent as an `Authorization: Bearer <token>` header. Auth headers are merged with any explicit `headers` config (auth takes precedence on conflict).

### OAuth

```json
{
  "type": "http",
  "url": "https://oauth-server.example.com/mcp",
  "auth": {
    "type": "oauth",
    "client_id": "my-app",
    "client_secret_env": "OAUTH_CLIENT_SECRET"
  }
}
```

Currently uses the `client_secret_env` value as a pre-obtained access token. Full OAuth PKCE flow with browser redirect is planned.

## Per-agent scoping

By default, all agents can access all MCP servers. Use `agentScopes` to restrict which servers specific agents can use:

```json
{
  "tools": {
    "mcp": {
      "servers": {
        "docs": { "type": "sse", "url": "..." },
        "github": { "type": "stdio", "command": "..." },
        "internal": { "type": "http", "url": "..." }
      },
      "agentScopes": {
        "assistant": ["docs", "github"],
        "reviewer": ["github"]
      }
    }
  }
}
```

- Agents listed in `agentScopes` can only access the servers in their array.
- Agents **not** listed have access to all servers (default open).

## Tool naming

MCP tools are registered with names that agents use to call them. Two strategies are available:

### Prefixed (default)

Tools are named `mcp_<prefix>_<toolName>`. The prefix defaults to the server key.

```
Server key: "zread"     Tool: "search_doc"  →  mcp_zread_search_doc
Server key: "my-server" Tool: "query"       →  mcp_my_server_query
```

### Bare

Tools use their original name directly. If a name collides with a built-in tool or another MCP tool, it automatically falls back to the prefixed name with a warning.

```json
{
  "type": "sse",
  "url": "...",
  "toolNames": "bare"
}
```

## Header interpolation

Header values support environment variable interpolation:

| Pattern                | Behavior                                        |
| ---------------------- | ----------------------------------------------- |
| `${API_KEY}`           | Replaced with the env var value; error if unset |
| `${API_KEY:-fallback}` | Replaced with env var, or `fallback` if unset   |

```json
{
  "headers": {
    "Authorization": "Bearer ${MCP_TOKEN}",
    "X-Team": "${TEAM_ID:-default}"
  }
}
```

## Installation scopes

MCP server configs can be defined at multiple scopes, merged with narrowest-wins priority:

| Scope   | Location                                     | Use case                         |
| ------- | -------------------------------------------- | -------------------------------- |
| User    | `~/.openclaw/mcp/servers.yaml`               | Personal servers across projects |
| Project | `<project>/.openclaw/mcp/servers.yaml`       | Shared project servers           |
| Local   | `<project>/.openclaw/mcp.local/servers.yaml` | Local overrides (gitignored)     |
| Inline  | `tools.mcp.servers` in openclaw.json         | Highest priority                 |

Priority order (highest to lowest): inline > local > project > user.

## Result truncation

Tool results are truncated to stay within `maxResultBytes` (default 100 KB) to prevent context window blowout. Image and resource content pass through untouched; only text content is truncated. A marker is appended when truncation occurs:

```
[truncated — 524288 bytes total, showing first 102400 bytes]
```

## Tool Search mode

When the total number of MCP tools exceeds `toolSearchThreshold` (default 15), the system automatically switches from direct registration to **Tool Search mode**. Instead of registering every MCP tool individually (which costs ~200 tokens per tool), a single `mcp_search` meta-tool is registered (~250 tokens total).

### How it works

1. Agent calls `mcp_search({ action: "search", query: "github docs" })`
2. Gets compact tool cards (name, server, description, parameters) — no full schema
3. Calls `mcp_search({ action: "get_schema", tool: "search_doc" })` to get full parameters
4. Calls `mcp_search({ action: "invoke", tool: "search_doc", arguments: { repo: "...", query: "..." } })`

### Actions

| Action         | Description                             | Required params                        |
| -------------- | --------------------------------------- | -------------------------------------- |
| `search`       | Find tools by keyword                   | `query`                                |
| `get_schema`   | Get full JSON Schema for a tool         | `tool`, optional `server`              |
| `invoke`       | Call a tool on an MCP server            | `tool`, optional `server`, `arguments` |
| `list_servers` | List connected servers with tool counts | (none)                                 |

### Mode override

Control when Tool Search activates:

| `toolSearch` value | Behavior                                                |
| ------------------ | ------------------------------------------------------- |
| `"auto"` (default) | Direct mode if tools < threshold, search mode otherwise |
| `"always"`         | Always use search mode regardless of tool count         |
| `"never"`          | Always use direct registration                          |

## Connection lifecycle

MCP servers use persistent sessions:

1. **Discovery** — On gateway startup, connect to each server, call `listTools`, keep connection alive
2. **Execution** — Tool calls reuse the persistent connection (serialized per-server)
3. **Reconnection** — On connection failure, automatic retry with exponential backoff (1s, 2s, 4s, 8s, max 30s, up to 3 retries)
4. **Tool updates** — Servers can notify tool list changes via `tools/list_changed`; the tool index is rebuilt automatically
5. **Shutdown** — All connections are gracefully closed on gateway shutdown

## github_read deprecation

When an MCP server provides zread-compatible tools (`search_doc`, `read_file`, etc.), the built-in `github_read` tool is automatically disabled to avoid duplication. If you have a zread MCP server configured, agents will use the MCP tools instead.

## Registries

MCP servers can be discovered from git-based registries. Registries contain server manifests (`server.yaml`) with connection details, auth requirements, and tool previews.

### Registry configuration

```json
{
  "tools": {
    "mcp": {
      "registries": [
        {
          "id": "openclaw",
          "name": "OpenClaw Official",
          "url": "https://github.com/openclaw/mcp-servers",
          "visibility": "public",
          "enabled": true
        },
        {
          "id": "company",
          "name": "Company Internal",
          "url": "https://github.com/company/mcp-servers",
          "auth_token_env": "COMPANY_MCP_TOKEN",
          "visibility": "private",
          "enabled": true
        }
      ]
    }
  }
}
```

### Lock files

Lock files (`mcp-lock.yaml`) capture the exact state of installed servers for reproducible deployments. They are generated per-scope and can be committed to version control.

```bash
# Regenerate lock file from current state
openclaw mcp lock --regenerate

# Check lock file vs current state
openclaw mcp lock --check

# CI mode — exit non-zero on mismatch
openclaw mcp lock --check --strict
```

## CLI commands

### Server management

```bash
# List configured servers and their status
openclaw mcp list

# Add a new server
openclaw mcp add my-server --type sse --url http://localhost:3001/sse

# Remove a server
openclaw mcp remove my-server

# Test connectivity
openclaw mcp test              # Test all servers
openclaw mcp test my-server    # Test a specific server

# Health check
openclaw mcp health            # All servers
openclaw mcp health my-server  # Specific server
```

### Browse and discovery

```bash
# Browse available servers from registries
openclaw mcp browse
openclaw mcp browse --category code

# Search servers
openclaw mcp search "github"

# Show server details
openclaw mcp info zai-zread
```

### Registry management

```bash
# List configured registries
openclaw mcp registry list

# Add a registry
openclaw mcp registry add company https://github.com/company/mcp-servers

# Remove a registry
openclaw mcp registry remove company

# Sync registries (fetch latest manifests)
openclaw mcp sync
openclaw mcp sync --registry company
```

### Import from other tools

Import MCP server configurations from other AI tools:

```bash
# Import from Claude Code config (~/.claude.json)
openclaw mcp import claude-code

# Import from Cursor (~/.cursor/mcp.json)
openclaw mcp import cursor

# Import from project .mcp.json (Claude Code project scope)
openclaw mcp import project

# Import from Claude Desktop (platform-specific)
openclaw mcp import claude-desktop
```

Import detects duplicates by URL (or command+args for stdio servers) and skips servers that already exist. Both `http`/`sse` and `stdio` server types are supported.

## Web UI

MCP server management is integrated directly into the **MCP Servers** section of the Control Panel sidebar.

### Management Tabs

The UI provides four dedicated views for managing your Model Context integration:

1.  **Browse**: Discover new servers from your configured registries. Filter by category (search, execution, data) and install with one click.
2.  **Installed**: A list of all active servers. Each row shows:
    - **Status**: Live indicators (Connected, Retrying, Error).
    - **Latency**: Real-time round-trip time for tool discovery call.
    - **Actions**: Test connectivity, disable (stop process/disconnect), or remove.
3.  **Registries**: Manage your upstream sources. Add private GitHub registries or sync official OpenClaw manifests.
4.  **Health**: A detailed dashboard surfacing stdio process logs, SSE connection history, and tool registration errors.

### Node Monitoring

Individual stdio servers appear as **Nodes** in the sidebar, allowing you to monitor the resource usage (Memory/CPU) of every running MCP process on your machine.

## Gateway RPCs

MCP management is exposed via gateway RPC methods:

| Method                  | Scope | Description                  |
| ----------------------- | ----- | ---------------------------- |
| `mcp.servers.list`      | READ  | List configured servers      |
| `mcp.servers.tools`     | READ  | List tools for a server      |
| `mcp.health.status`     | READ  | Overall health status        |
| `mcp.registry.list`     | READ  | List configured registries   |
| `mcp.browse.list`       | READ  | Browse registry servers      |
| `mcp.servers.test`      | WRITE | Test server connection       |
| `mcp.servers.configure` | WRITE | Update server settings       |
| `mcp.servers.enable`    | WRITE | Enable a server              |
| `mcp.servers.disable`   | WRITE | Disable a server             |
| `mcp.servers.add`       | ADMIN | Add a new server             |
| `mcp.servers.remove`    | ADMIN | Remove a server              |
| `mcp.registry.add`      | ADMIN | Add a registry               |
| `mcp.registry.remove`   | ADMIN | Remove a registry            |
| `mcp.registry.sync`     | ADMIN | Sync registry manifests      |
| `mcp.health.check`      | ADMIN | Run health check on a server |

## Related

- [Configuration](/operator1/configuration) — Full config reference including `tools.mcp`
- [Architecture](/operator1/architecture) — System design overview
