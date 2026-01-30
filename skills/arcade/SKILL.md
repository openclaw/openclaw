---
name: arcade
description: Arcade.dev integration - 7500+ authorized tools across hundreds of services
homepage: https://docs.arcade.dev
metadata: {"openclaw":{"emoji":"🎮","requires":{"env":["ARCADE_API_KEY"]},"primaryEnv":"ARCADE_API_KEY","plugins":["arcade"]}}
---

# Arcade.dev Tools

Arcade.dev provides authorized access to 7500+ tools across hundreds of services including Gmail, Slack, GitHub, Google Calendar, Asana, Jira, Notion, Figma, Stripe, and more. Each tool handles OAuth automatically.

## Setup

1. Get an API key from [arcade.dev](https://www.arcade.dev)
2. Configure OpenClaw:
```bash
openclaw config set plugins.entries.arcade.config.apiKey "arc_..."
openclaw config set plugins.entries.arcade.config.userId "user@example.com"
openclaw plugins enable arcade
```
3. Initialize the tools cache:
```bash
openclaw arcade init
```

## Discovering Tools

### Search by keyword
```bash
openclaw arcade tools search gmail
openclaw arcade tools search slack
openclaw arcade tools search calendar
```

### List by toolkit
```bash
openclaw arcade tools list --toolkit Gmail
openclaw arcade tools list --toolkit Slack
openclaw arcade tools list --toolkit Github
```

### View tool details
```bash
openclaw arcade tools info SendEmail
openclaw arcade tools info Gmail.SendEmail --no-cache
```

## Tool Naming Convention

Arcade tools are registered with the pattern `arcade_<toolkit>_<tool_name>` (snake_case):

| Arcade Tool | Registered As |
|-------------|---------------|
| Gmail.SendEmail | `arcade_gmail_send_email` |
| Gmail.ListEmails | `arcade_gmail_list_emails` |
| Slack.SendMessage | `arcade_slack_send_message` |
| Github.CreateIssue | `arcade_github_create_issue` |
| GoogleCalendar.CreateEvent | `arcade_google_calendar_create_event` |

## Static Tools (Always Available)

These three tools are always available, even without cache:

### arcade_list_tools
List available Arcade tools.
- `toolkit` (optional): Filter by toolkit name (e.g., "Gmail", "Slack")

### arcade_authorize
Initiate OAuth authorization for a tool.
- `tool_name` (required): The Arcade tool name (e.g., "Gmail.SendEmail")

### arcade_execute
Execute any Arcade tool by name.
- `tool_name` (required): The Arcade tool name (e.g., "Gmail.SendEmail")
- `input` (required): Tool parameters as JSON object

## Authorization Flow

When a tool requires authorization:

1. The tool returns an `authorization_url`
2. User visits the URL and grants access
3. Once authorized, tools work automatically

Check authorization status:
```bash
openclaw arcade auth status
openclaw arcade auth status --tool Gmail.SendEmail
```

Pre-authorize a service:
```bash
openclaw arcade auth login Gmail.SendEmail
```

## Available Toolkits

Run `openclaw arcade cache` to see all toolkits. Popular ones include:

- **Productivity**: Gmail, GoogleCalendar, GoogleDrive, GoogleDocs, GoogleSheets, NotionToolkit, Asana, Linear, Jira, Clickup, Confluence
- **Communication**: Slack, OutlookMail, Microsoft, MicrosoftTeams, Zoom, IntercomApi
- **Development**: Github (862 tools), Figma, E2b, VercelApi, DatadogApi
- **Business**: Stripe, Hubspot (809 tools), Salesforce, Zendesk, PylonApi
- **Data**: AirtableApi, Firecrawl, GoogleSearch, GoogleNews, ExaApi
- **And 60+ more...**

## Best Practices

1. **Initialize cache first**: Run `openclaw arcade init` to load all 7500+ tools
2. **Search before guessing**: Use `arcade_list_tools` to find the right tool
3. **Check auth status**: Some tools require user authorization first
4. **Handle auth gracefully**: If a tool needs auth, share the URL with the user
5. **Confirm actions**: Always confirm before sending emails, messages, or making changes

## CLI Commands

```bash
openclaw arcade init          # Initialize/refresh tools cache
openclaw arcade cache         # Show cache status
openclaw arcade tools list    # List tools
openclaw arcade tools search  # Search for tools
openclaw arcade tools execute # Execute a tool
openclaw arcade auth status   # Check authorization
openclaw arcade auth login    # Pre-authorize a tool
openclaw arcade health        # Check API health
openclaw arcade config        # Show configuration
```

## Execute via CLI

```bash
openclaw arcade tools execute Gmail.SendEmail -i '{"recipient":"test@example.com","subject":"Hello","body":"Test"}'
openclaw arcade tools execute Gmail.ListEmails -i '{"max_results":5}'
```
