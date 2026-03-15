# OpenClaw Configuration Templates

This directory contains configuration templates for common OpenClaw setups.

## Claude Persistent Memory Workflow

The `claude-persistent-memory.json5` configuration enables persistent memory across Claude sessions, supporting:

- **Knowledge retention** - Store and retrieve information across sessions
- **Project context** - Maintain awareness of ongoing work
- **User preferences** - Remember communication and coding preferences
- **Decision history** - Track reasoning for important choices

### Quick Setup

```bash
# 1. Copy the configuration
cp config-templates/claude-persistent-memory.json5 ~/.openclaw/openclaw.json

# 2. Copy workspace bootstrap files
cp -r config-templates/workspace-bootstrap/* ~/.openclaw/workspace/

# 3. Initialize the setup
openclaw setup

# 4. Start the gateway
openclaw gateway run
```

### Workspace Bootstrap Files

The `workspace-bootstrap/` directory contains template files for the agent workspace:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Operating instructions and memory guidelines |
| `SOUL.md` | Agent persona and communication style |
| `TOOLS.md` | Tool usage notes and best practices |
| `USER.md` | User profile and preferences (customize this) |
| `IDENTITY.md` | Agent name, emoji, and vibe |

### MCP Integration

To use with Claude Code or Claude Desktop, add to your MCP configuration:

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

### Memory Operations

Store information:
```
Use openclaw_memory_add to store "Important project decision: using TypeScript strict mode"
```

Retrieve context:
```
Use openclaw_memory_search to find "project decisions" with mode vsearch
```

### Customization

Edit the configuration to:

1. **Change the model** - Update `agents.defaults.model`
2. **Add memory paths** - Extend `memory.qmd.paths`
3. **Adjust retrieval** - Tune `memory.retrieval` settings
4. **Configure skills** - Add to `skills.directories`

See the [documentation](https://docs.openclaw.ai/integrations/mcp) for full details.
