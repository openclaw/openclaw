# QMD MCP Server Setup

## Add to Claude Code Settings

Add the QMD MCP server to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

This exposes the following MCP tools to Claude Code:

- `mcp__qmd__query` — search with lex/vec/hyde queries
- `mcp__qmd__get` — retrieve a doc by path or `#docid`
- `mcp__qmd__multi_get` — retrieve multiple docs by glob or list
- `mcp__qmd__status` — show collections and health

## Verify

After adding the config, restart Claude Code. The QMD tools should appear in the tool list.

```bash
# Check QMD is running
qmd status
```

## Collections

Collections are configured in `~/.config/qmd/index.yml`. Each collection maps a directory + glob pattern to a named searchable index.

```bash
# Add a new collection
qmd collection add ~/notes --name notes

# Re-embed after adding
qmd embed
```
