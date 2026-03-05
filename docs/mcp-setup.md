# MCP Setup (Claude / Codex)

## Claude Code

Add via terminal:

```bash
claude mcp add
# Name: remotion-documentation
# Command: npx
# Args: @remotion/mcp@latest
```

Manual settings:

```json
{
  "mcpServers": {
    "remotion-documentation": {
      "command": "npx",
      "args": ["@remotion/mcp@latest"]
    }
  }
}
```

Then in chat: “Use remotion-documentation to look up the render h264 flag.”

## Codex CLI

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.remotion_documentation]
type = "stdio"
command = "npx"
args = ["@remotion/mcp@latest"]
```
