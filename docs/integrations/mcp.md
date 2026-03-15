---
title: MCP Server Integration
description: Model Context Protocol server for Claude Code and browser integration
---

# OpenClaw MCP Server

OpenClaw provides a Model Context Protocol (MCP) server that exposes gateway capabilities
to Claude Code and other MCP-compatible clients. The server supports both stdio and
browser (WebSocket) transports.

## Quick Start

### Start MCP Server (stdio)

```bash
# Default stdio transport for Claude Code
openclaw mcp serve
```

### Start MCP Server (browser)

```bash
# WebSocket transport for browser clients
openclaw mcp serve --transport browser --port 8765
```

### Configure in Claude Code

Add to your MCP settings (`~/.config/claude-code/mcp.json`):

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": ["mcp", "serve"],
      "env": {
        "OPENCLAW_GATEWAY_URL": "http://localhost:18789"
      }
    }
  }
}
```

## Transport Options

### Stdio Transport

Default transport for CLI integration:

```bash
openclaw mcp serve --transport stdio
```

Features:
- Direct process communication
- No network configuration needed
- Ideal for Claude Code CLI

### Browser Transport

WebSocket-based transport for web applications:

```bash
openclaw mcp serve --transport browser --port 8765 --host 127.0.0.1
```

Features:
- WebSocket connections from browser
- CORS support for web apps
- Multiple concurrent clients
- Health check endpoint

#### Browser Client Example

```javascript
// Connect from browser
const ws = new WebSocket('ws://127.0.0.1:8765');

ws.onopen = () => {
  // Initialize MCP session
  ws.send(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      clientInfo: { name: 'browser-client', version: '1.0.0' }
    }
  }));
};

ws.onmessage = (event) => {
  const response = JSON.parse(event.data);
  console.log('MCP response:', response);
};
```

## Available Tools

### Agent Communication

#### `openclaw_send_message`

Send a message to an OpenClaw agent:

```json
{
  "message": "What files were changed today?",
  "agentId": "main",
  "sessionKey": "session-123"
}
```

#### `openclaw_agent_status`

Check agent status:

```json
{
  "agentId": "main"
}
```

### Memory Operations

#### `openclaw_memory_search`

Search persistent memory:

```json
{
  "query": "API authentication patterns",
  "limit": 10,
  "threshold": 0.7
}
```

#### `openclaw_memory_add`

Add to persistent memory:

```json
{
  "content": "The user prefers TypeScript for all new code",
  "metadata": {
    "source": "conversation",
    "tags": ["preferences", "coding"]
  }
}
```

### Session Management

#### `openclaw_list_sessions`

List active sessions:

```json
{
  "agentId": "main",
  "limit": 20
}
```

#### `openclaw_get_session`

Get session transcript:

```json
{
  "sessionKey": "session-123",
  "limit": 50
}
```

### Skill Execution

#### `openclaw_execute_skill`

Execute a registered skill:

```json
{
  "skill": "commit",
  "args": "-m 'Add new feature'",
  "agentId": "main"
}
```

### Browser Control

#### `openclaw_browser_action`

Execute browser automation:

```json
{
  "action": "navigate",
  "url": "https://example.com",
  "profile": "default"
}
```

Supported actions:
- `navigate` - Go to URL
- `click` - Click element by selector
- `type` - Type text into element
- `screenshot` - Capture screenshot
- `snapshot` - Get DOM snapshot

### Workspace Access

#### `openclaw_read_file`

Read workspace file:

```json
{
  "path": "src/index.ts",
  "encoding": "utf-8"
}
```

#### `openclaw_list_files`

List workspace files:

```json
{
  "path": "src",
  "pattern": "*.ts"
}
```

## Configuration

### Server Options

```bash
openclaw mcp serve \
  --transport browser \
  --port 8765 \
  --host 127.0.0.1 \
  --gateway-url http://localhost:18789 \
  --agent-id main \
  --workspace /path/to/workspace
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_GATEWAY_URL` | Gateway HTTP endpoint | `http://localhost:18789` |
| `OPENCLAW_MCP_PORT` | Browser transport port | `8765` |
| `OPENCLAW_MCP_HOST` | Browser transport host | `127.0.0.1` |
| `OPENCLAW_AGENT_ID` | Default agent ID | `default` |

### CORS Configuration

For browser transport, configure allowed origins:

```json5
{
  "mcp": {
    "browser": {
      "cors": {
        "origin": ["https://your-app.com", "http://localhost:3000"],
        "credentials": true
      }
    }
  }
}
```

## Security Considerations

### Browser Transport Security

When using browser transport:

1. **Bind to localhost** - Default binding to `127.0.0.1` prevents external access
2. **Configure CORS** - Explicitly allow trusted origins
3. **Use authentication** - Enable gateway auth tokens for production

```json5
{
  "gateway": {
    "auth": {
      "enabled": true,
      "token": "${OPENCLAW_AUTH_TOKEN}"
    }
  }
}
```

### Workspace Sandboxing

File operations are sandboxed to the workspace:

```json5
{
  "mcp": {
    "workspace": {
      "root": "/path/to/workspace",
      "allowEscape": false
    }
  }
}
```

## Troubleshooting

### Connection Issues

Check gateway connectivity:

```bash
curl http://localhost:18789/health
```

### Browser Transport Not Starting

Verify port availability:

```bash
lsof -i :8765
```

### Tool Execution Failures

Enable debug logging:

```bash
OPENCLAW_LOG_LEVEL=debug openclaw mcp serve
```

## Related Documentation

- [Claude Code Subagents](/integrations/claude-code-subagents)
- [Persistent Memory Workflows](/integrations/persistent-memory-workflows)
- [Browser Control](/tools/browser)
- [Gateway Configuration](/gateway/configuration)
