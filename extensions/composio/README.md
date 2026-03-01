# Composio Tool Router Plugin for Clawdbot

Access 1000+ third-party tools through Composio's unified Tool Router interface.

## Features

- **Search Tools**: Find tools by describing what you want to accomplish
- **Execute Tools**: Run any tool with authenticated connections
- **Multi-Execute**: Run up to 50 tools in parallel
- **Connection Management**: Connect to toolkits via OAuth or API keys

## Supported Integrations

Gmail, Slack, GitHub, Notion, Linear, Jira, HubSpot, Salesforce, Google Drive, Asana, Trello, and 1000+ more.

## Configuration

### Option 1: Environment Variable

```bash
export COMPOSIO_API_KEY=your-api-key
```

### Option 2: Clawdbot Config

```bash
clawdbot config set plugins.composio.enabled true
clawdbot config set plugins.composio.apiKey "your-api-key"
```

Get your API key from [platform.composio.dev/settings](https://platform.composio.dev/settings).

## CLI Commands

```bash
# List available toolkits
clawdbot composio list

# Check connection status
clawdbot composio status
clawdbot composio status github

# Connect to a toolkit (opens auth URL)
clawdbot composio connect github
clawdbot composio connect gmail

# Disconnect from a toolkit
clawdbot composio disconnect github

# Search for tools
clawdbot composio search "send email"
clawdbot composio search "create issue" --toolkit github
```

## Agent Tools

The plugin provides six tools for agents:

### `composio_search_tools`

Search for tools matching a task description.

```json
{
  "query": "send an email with attachment",
  "toolkits": ["gmail"],
  "limit": 5
}
```

### `composio_execute_tool`

Execute a single tool.

```json
{
  "tool_slug": "GMAIL_SEND_EMAIL",
  "arguments": {
    "to": "user@example.com",
    "subject": "Hello",
    "body": "Message content"
  }
}
```

### `composio_multi_execute`

Execute multiple tools in parallel (up to 50).

```json
{
  "executions": [
    { "tool_slug": "GITHUB_CREATE_ISSUE", "arguments": { "title": "Bug", "repo": "org/repo" } },
    {
      "tool_slug": "SLACK_SEND_MESSAGE",
      "arguments": { "channel": "#dev", "text": "Issue created" }
    }
  ]
}
```

### `composio_manage_connections`

Manage toolkit connections.

```json
{
  "action": "status",
  "toolkits": ["github", "gmail"]
}
```

### `composio_workbench`

Executes Python code in a remote Jupyter sandbox and provides helpers for running Composio tools, invoking LLMs, and processing data (e.g. `run_composio_tool`, `invoke_llm`, `upload_local_file`, `web_search`, `smart_file_extract`).

### `composio_bash`

Execute bash commands in a remote sandbox for file operations, data processing, and handling large tool responses saved to remote files.

## Advanced Configuration

```json
{
  "plugins": {
    "composio": {
      "enabled": true,
      "apiKey": "your-api-key",
      "defaultUserId": "user_123",
      "allowedToolkits": ["github", "gmail", "slack"],
      "blockedToolkits": ["dangerous-toolkit"]
    }
  }
}
```

## Links

- [Composio Documentation](https://docs.composio.dev)
- [Tool Router Overview](https://docs.composio.dev/tool-router/overview)
- [Composio Platform](https://platform.composio.dev)
