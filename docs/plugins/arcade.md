---
summary: "Arcade.dev plugin: 7500+ authorized tools (Gmail, Slack, GitHub, etc.) with automatic OAuth"
read_when:
  - You want to connect OpenClaw to external services like Gmail, Slack, or GitHub
  - You need to send emails, manage calendars, or interact with third-party APIs
  - You are configuring the Arcade plugin
---

# Arcade.dev (plugin)

Connect OpenClaw to [Arcade.dev](https://arcade.dev) for **7500+ authorized tools** across hundreds of services. Arcade handles OAuth automatically—no credential management required.

Popular integrations:
- **Productivity**: Gmail, Google Calendar, Google Drive, Notion, Asana, Linear, Jira
- **Communication**: Slack, Microsoft Teams, Outlook, Zoom
- **Development**: GitHub (862 tools), Figma
- **Business**: Stripe, HubSpot, Salesforce, Zendesk

Quick mental model:
- Install plugin + set API key
- Initialize the tools cache
- Use tools via agent or CLI
- OAuth happens automatically on first use

## Install

```bash
# Enable the built-in plugin
openclaw plugins enable arcade

# Or install from npm
openclaw plugins install @openclaw/arcade
```

Restart the Gateway afterwards.

## Config

### Required: API Key + User ID

```bash
openclaw config set plugins.entries.arcade.config.apiKey "arc_your_key"
openclaw config set plugins.entries.arcade.config.userId "you@example.com"
```

Or via environment variables:

```bash
export ARCADE_API_KEY="arc_..."
export ARCADE_USER_ID="user@example.com"
```

### Initialize the Cache

After configuring, initialize the tools cache:

```bash
openclaw arcade init
```

Then restart:

```bash
openclaw gateway restart
```

### Full Config Example

```json
{
  "plugins": {
    "entries": {
      "arcade": {
        "enabled": true,
        "config": {
          "apiKey": "arc_...",
          "userId": "user@example.com",
          "tools": {
            "allow": ["Gmail.*", "Slack.*"],
            "deny": ["*.Delete*"]
          }
        }
      }
    }
  }
}
```

Config file location: `~/.openclaw/openclaw.json`

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | — | Arcade API key (required) |
| `userId` | string | — | User ID for auth tracking |
| `baseUrl` | string | `https://api.arcade.dev` | API endpoint |
| `toolPrefix` | string | `arcade` | Prefix for tool names |
| `autoAuth` | boolean | `true` | Auto-prompt for authorization |
| `cacheToolsTtlMs` | number | `300000` | Cache TTL (5 min) |
| `tools.allow` | string[] | — | Allowlist patterns (e.g., `Gmail.*`) |
| `tools.deny` | string[] | — | Denylist patterns |

## CLI Commands

```bash
# List tools
openclaw arcade tools list
openclaw arcade tools list --toolkit Gmail

# Search tools
openclaw arcade tools search email

# Get tool info
openclaw arcade tools info Gmail.SendEmail

# Execute a tool directly
openclaw arcade tools execute Gmail.SendEmail -i '{"recipient":"bob@example.com","subject":"Hi","body":"Hello!"}'

# Check authorization
openclaw arcade auth status
openclaw arcade auth status --tool Gmail.SendEmail

# Pre-authorize a service
openclaw arcade auth login Gmail.SendEmail

# Plugin status
openclaw arcade config
openclaw arcade health

# Cache management
openclaw arcade init          # Refresh cache
openclaw arcade cache         # Show status
openclaw arcade cache --clear # Clear cache
```

## Agent Tools

The plugin registers tools the agent can use:

### Static Tools (always available)

| Tool | Description |
|------|-------------|
| `arcade_list_tools` | List available tools (filter by toolkit) |
| `arcade_authorize` | Initiate OAuth for a tool |
| `arcade_execute` | Execute any tool by name |

### Auto-registered Tools

Tools are registered using the pattern `arcade_<toolkit>_<tool_name>`:

| Arcade Tool | Registered As |
|-------------|---------------|
| `Gmail.SendEmail` | `arcade_gmail_send_email` |
| `Slack.SendMessage` | `arcade_slack_send_message` |
| `Github.CreateIssue` | `arcade_github_create_issue` |
| `GoogleCalendar.CreateEvent` | `arcade_google_calendar_create_event` |

## Authorization Flow

1. Agent invokes a tool (e.g., "Send an email")
2. If not authorized, Arcade returns an authorization URL
3. OpenClaw shows the URL to the user
4. User visits URL and grants access
5. Tool executes automatically

Authorizations persist across sessions. Pre-authorize with:

```bash
openclaw arcade auth login Gmail.SendEmail
```

## Available Toolkits

### Productivity
| Toolkit | Tools | Examples |
|---------|-------|----------|
| Gmail | 18 | ListEmails, SendEmail, ReplyToEmail, SearchThreads |
| GoogleCalendar | 7 | ListEvents, CreateEvent, UpdateEvent, DeleteEvent |
| GoogleDrive | 11 | SearchFiles, UploadFile, ShareFile, DownloadFile |
| GoogleDocs | 13 | CreateBlankDocument, EditDocument, SearchDocuments |
| GoogleSheets | 9 | GetSpreadsheet, WriteToCell, CreateSpreadsheet |
| NotionToolkit | 8 | CreatePage, SearchByTitle, GetPageContentById |
| Asana + AsanaApi | 218 | Task and project management |
| Linear | 39 | CreateIssue, UpdateIssue, ArchiveIssue |
| Jira | 43 | CreateIssue, UpdateIssue, AddCommentToIssue |

### Communication
| Toolkit | Tools | Examples |
|---------|-------|----------|
| Slack + SlackApi | 81 | SendMessage, GetMessages, ListChannels |
| OutlookMail | 9 | ListEmails, SendEmail, CreateDraftEmail |
| Microsoft | 11 | CreateAndSendEmail, CreateEvent |
| MicrosoftTeams | 25 | Teams messaging |
| Zoom | 2 | GetMeetingInvitation, ListUpcomingMeetings |

### Development
| Toolkit | Tools | Examples |
|---------|-------|----------|
| Github + GithubApi | 862 | Issues, PRs, repos, commits, actions |
| Figma + FigmaApi | 58 | Files, comments, components |

### Business
| Toolkit | Tools | Examples |
|---------|-------|----------|
| Stripe + StripeApi | 235 | Payments, customers, subscriptions |
| Hubspot (9 toolkits) | 809 | CRM, marketing, automation |
| Salesforce | 3 | Contacts, accounts |
| Zendesk | 6 | Tickets, comments |
| IntercomApi | 107 | Conversations, contacts |

### Data & Search
| Toolkit | Tools | Examples |
|---------|-------|----------|
| GoogleSearch | 1 | Web search |
| GoogleNews | 1 | News search |
| Firecrawl | 6 | Web scraping |
| AirtableApi | 96 | Records, tables |

Run `openclaw arcade cache` to see all 89 toolkits.

## Troubleshooting

### "No tools found" or cache empty

```bash
openclaw arcade init
openclaw gateway restart
```

### Authorization not working

Check your user ID is set consistently:

```bash
openclaw arcade config
```

Re-authorize:

```bash
openclaw arcade auth login Gmail.SendEmail
```

### Too many tools loading

Filter to only what you need:

```bash
openclaw config set plugins.entries.arcade.config.tools.allow '["Gmail.*", "Slack.*"]' --json
openclaw gateway restart
```

### API key invalid

1. Verify at [arcade.dev](https://arcade.dev)
2. Re-set: `openclaw config set plugins.entries.arcade.config.apiKey "arc_..."`
3. Restart: `openclaw gateway restart`

## Resources

- [Arcade.dev](https://arcade.dev) — Get an API key
- [Arcade Documentation](https://docs.arcade.dev)
- [Extension Source](https://github.com/openclaw/openclaw/tree/main/extensions/arcade)
