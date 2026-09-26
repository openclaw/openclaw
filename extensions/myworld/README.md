# myworld

myworld gives OpenClaw a safe company world to practice in before an agent uses
real tools. The bundled plugin contributes one MCP server:

```json
{
  "myworld": {
    "transport": "stdio",
    "command": "uvx",
    "args": ["myworld==0.2.1", "world", "invoice-review"]
  }
}
```

The default world contains Gmail, Slack and Drive in one shared environment. The
agent can read invoice emails, find a Slack correction, update a spreadsheet and
grade the result without touching a real inbox, workspace or Drive.

Enable the plugin, then start a new session so OpenClaw can discover the MCP
tools:

```sh
openclaw plugins enable myworld
```

The `uvx` command installs the pinned PyPI package on first use.
