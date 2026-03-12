# OpenClaw Configuration Templates

Configuration templates for common OpenClaw deployment scenarios.

## Quick Start

### Claude-based Persistent Memory

```bash
# Copy configuration
cp config-templates/claude-persistent-memory.json5 ~/.openclaw/openclaw.json

# Initialize workspace
mkdir -p ~/.openclaw/workspace
cp -r config-templates/workspace-bootstrap/* ~/.openclaw/workspace/

# Setup OpenClaw
openclaw setup

# Start gateway
openclaw gateway run
```

## Templates

### `claude-persistent-memory.json5`

Full configuration for Claude-based persistent memory workflows:

- Vector-based semantic memory (qmd backend)
- Episodic session memory
- MCP server with browser transport
- Multi-agent support with memory sharing
- Privacy filters and memory hygiene

### `workspace-bootstrap/`

Template files for agent workspace initialization:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent guidelines and capabilities |
| `SOUL.md` | Agent personality and behavior |
| `TOOLS.md` | Available tools documentation |
| `USER.md` | User preferences and context |
| `IDENTITY.md` | Project identity and goals |

## Customization

### Memory Backend

Options for the memory backend:

```json5
// Local SQLite with vector search
"backend": { "type": "qmd", "path": "~/.openclaw/memory" }

// Remote QMD server
"backend": { "type": "qmd-remote", "url": "http://qmd-server:8080" }
```

### Embedding Providers

Configure embedding provider:

```json5
"embedding": {
  "provider": "voyage",    // voyage, openai, gemini, mistral, local
  "model": "voyage-3"
}
```

### Model Selection

Configure the AI model:

```json5
"model": {
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "fallback": [
    { "provider": "anthropic", "model": "claude-haiku-4-5" }
  ]
}
```

## Documentation

- [Persistent Memory Workflows](https://docs.openclaw.ai/integrations/persistent-memory-workflows)
- [MCP Server Integration](https://docs.openclaw.ai/integrations/mcp)
- [Claude Code Subagents](https://docs.openclaw.ai/integrations/claude-code-subagents)
- [Memory System](https://docs.openclaw.ai/concepts/memory)
