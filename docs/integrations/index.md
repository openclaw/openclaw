---
title: Integrations
description: OpenClaw integration guides for external tools and services
---

# Integrations

OpenClaw integrates with various tools and services to extend its capabilities.

## Claude Code Integration

<CardGroup cols={2}>
  <Card title="MCP Server" icon="plug" href="/integrations/mcp">
    Model Context Protocol server for Claude Code integration
  </Card>
  <Card title="Subagents" icon="users" href="/integrations/claude-code-subagents">
    Using Claude Code subagents with OpenClaw
  </Card>
  <Card title="Persistent Memory" icon="brain" href="/integrations/persistent-memory-workflows">
    Build Claude-based applications with persistent memory
  </Card>
</CardGroup>

## Quick Links

- [MCP Server Setup](/integrations/mcp#quick-start)
- [Browser Transport](/integrations/mcp#browser-transport)
- [Memory Configuration](/integrations/persistent-memory-workflows#configuration-templates)

## Getting Started

### 1. Install OpenClaw

```bash
npm install -g openclaw
```

### 2. Configure MCP for Claude Code

Add to `~/.config/claude-code/mcp.json`:

```json
{
  "mcpServers": {
    "openclaw": {
      "command": "openclaw",
      "args": ["mcp", "serve"]
    }
  }
}
```

### 3. Start the Gateway

```bash
openclaw gateway run
```

### 4. Use OpenClaw Tools in Claude Code

OpenClaw tools are now available:

- `openclaw_send_message` - Communicate with agents
- `openclaw_memory_search` - Search persistent memory
- `openclaw_memory_add` - Store memories
- `openclaw_browser_action` - Browser automation
- And more...

## Browser Integration

For web applications, use the browser transport:

```bash
openclaw mcp serve --transport browser --port 8765
```

Connect from browser JavaScript:

```javascript
const ws = new WebSocket('ws://127.0.0.1:8765');
// Use MCP protocol over WebSocket
```

See the [MCP Server documentation](/integrations/mcp) for details.
