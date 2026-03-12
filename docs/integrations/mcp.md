---
summary: "Model Context Protocol (MCP) integration for OpenClaw"
read_when:
  - Setting up MCP servers with OpenClaw
  - Connecting Claude Code or Claude Desktop to OpenClaw
  - Building custom MCP integrations
title: "MCP Integration"
---

# MCP Integration

OpenClaw provides a Model Context Protocol (MCP) server that exposes its capabilities to MCP-compatible clients like Claude Code, Claude Desktop, and custom applications.

## Overview

The MCP server acts as a bridge between MCP clients and the OpenClaw gateway, enabling:

- **Message sending** to OpenClaw agents
- **Memory search and storage** for persistent context
- **Session management** for conversation continuity
- **Skill execution** for complex workflows
- **Workspace access** for file operations

## Quick Start

### 1. Install the MCP Server

The MCP server is included with OpenClaw:

```bash
# If using npx
npx openclaw-mcp-server

# Or run directly
openclaw mcp serve
```

### 2. Configure Your MCP Client

Add to your MCP client configuration (e.g., Claude Code's `mcp_settings.json`):

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "npx",
      "args": ["openclaw-mcp-server"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://localhost:18789",
        "OPENCLAW_AGENT_ID": "main"
      }
    }
  }
}
```

### 3. Verify Connection

The MCP server exposes these tools:

- `openclaw_send_message` - Send messages to the agent
- `openclaw_memory_search` - Search persistent memory
- `openclaw_memory_add` - Store new memories
- `openclaw_agent_status` - Check agent status
- `openclaw_list_sessions` - List active sessions
- `openclaw_get_session` - Get session transcript
- `openclaw_execute_skill` - Run skills
- `openclaw_read_file` - Read workspace files
- `openclaw_list_files` - List workspace files

## Tool Reference

### openclaw_send_message

Send a message to the OpenClaw agent and receive a response.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | Yes | The message to send |
| `session_key` | string | No | Continue existing session |
| `thinking` | string | No | Thinking level: off, low, medium, high |

**Example:**
```json
{
  "name": "openclaw_send_message",
  "arguments": {
    "message": "What's the status of the auth system?",
    "thinking": "low"
  }
}
```

### openclaw_memory_search

Search the agent's knowledge base for relevant information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `limit` | number | No | Max results (default: 10) |
| `mode` | string | No | search, vsearch, or query |

**Search Modes:**
- `search` - Keyword-based search
- `vsearch` - Vector/semantic search using embeddings
- `query` - Natural language query interpretation

**Example:**
```json
{
  "name": "openclaw_memory_search",
  "arguments": {
    "query": "authentication implementation decisions",
    "mode": "vsearch",
    "limit": 5
  }
}
```

### openclaw_memory_add

Store information in persistent memory.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | Yes | Content to store |
| `metadata` | object | No | Tags, source, or other metadata |

**Example:**
```json
{
  "name": "openclaw_memory_add",
  "arguments": {
    "content": "User prefers TypeScript over JavaScript for all new code",
    "metadata": {
      "type": "preference",
      "source": "user-stated",
      "confidence": "high"
    }
  }
}
```

### openclaw_execute_skill

Execute a skill (slash command) on the agent.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `skill` | string | Yes | Skill name (without /) |
| `args` | string | No | Arguments for the skill |

**Example:**
```json
{
  "name": "openclaw_execute_skill",
  "arguments": {
    "skill": "commit",
    "args": "-m 'Add MCP integration'"
  }
}
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_URL` | `http://localhost:18789` | Gateway URL |
| `OPENCLAW_AGENT_ID` | `main` | Agent to use |
| `OPENCLAW_MCP_DEBUG` | `0` | Enable debug logging |

### Gateway Configuration

Enable MCP-related settings in `~/.openclaw/openclaw.json`:

```json5
{
  gateway: {
    // Enable the HTTP API (required for MCP)
    api: {
      enabled: true,
      port: 18789
    }
  },

  memory: {
    // Enable memory backend
    backend: "qmd",

    qmd: {
      // Optional: use mcporter for faster queries
      mcporter: {
        enabled: true,
        serverName: "qmd",
        startDaemon: true
      }
    }
  }
}
```

## Integration Patterns

### Claude Code Integration

Configure Claude Code to use OpenClaw for persistent memory:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": ["mcp", "serve"],
      "env": {
        "OPENCLAW_AGENT_ID": "coding-assistant"
      }
    }
  }
}
```

Then in Claude Code, you can:

```
// Search for previous context
Use openclaw_memory_search to find "previous session notes about this project"

// Store decisions
Use openclaw_memory_add to store "Decided to use Prisma for database ORM"

// Continue conversations
Use openclaw_send_message with session_key to continue where we left off
```

### Claude Desktop Integration

Add to Claude Desktop's MCP configuration:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "/usr/local/bin/openclaw",
      "args": ["mcp", "serve"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://localhost:18789"
      }
    }
  }
}
```

### Custom Application Integration

For custom applications using the MCP SDK:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "openclaw",
  args: ["mcp", "serve"]
});

const client = new Client({
  name: "my-app",
  version: "1.0.0"
});

await client.connect(transport);

// Use OpenClaw tools
const result = await client.callTool({
  name: "openclaw_memory_search",
  arguments: { query: "user preferences" }
});
```

## Security Considerations

### Authentication

The MCP server inherits authentication from the OpenClaw gateway. Ensure:

- The gateway is bound to `loopback` for local-only access
- Use appropriate auth profiles for multi-user setups
- Don't expose the gateway port to untrusted networks

### Data Privacy

Memory entries may contain sensitive information:

- Use metadata tags to categorize sensitivity
- Implement retention policies for sensitive data
- Review stored memories periodically

### Tool Permissions

Configure tool policies in OpenClaw config:

```json5
{
  tools: {
    policy: {
      // Restrict dangerous tools
      dangerous: ["exec", "write"],

      // Auto-approve safe tools
      safe: ["read", "search", "memory_search"]
    }
  }
}
```

## Troubleshooting

### Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:18789
```

**Solution:** Start the OpenClaw gateway:
```bash
openclaw gateway run --bind loopback --port 18789
```

### Tool Not Found

```
Error: Unknown tool: openclaw_memory_search
```

**Solution:** Verify the MCP server is properly configured and running:
```bash
openclaw mcp serve --debug
```

### Memory Search Returns Empty

**Possible causes:**
1. No memories stored yet
2. Wrong agent ID
3. Memory backend not configured

**Solution:**
```bash
# Check memory status
openclaw memory status

# Verify agent config
openclaw config get agents.defaults
```

### Slow Responses

**Solution:** Enable mcporter for faster memory queries:
```json5
{
  memory: {
    qmd: {
      mcporter: {
        enabled: true,
        startDaemon: true
      }
    }
  }
}
```

---

_See also: [Claude Code Subagents](/integrations/claude-code-subagents), [Memory System](/concepts/memory)_
