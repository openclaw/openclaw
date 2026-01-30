# OpenClaw Arcade.dev Plugin

Connect OpenClaw to [Arcade.dev](https://arcade.dev) for access to **7500+ authorized tools** across hundreds of services including Gmail, Slack, GitHub, Google Calendar, Notion, Linear, Jira, Stripe, HubSpot, and more.

## Features

- **7500+ Tools**: Productivity, communication, development, and business services
- **Automatic OAuth**: Arcade handles all authorization flows securely
- **Dynamic Registration**: Tools are automatically discovered and registered
- **JIT Authorization**: Prompts users to authorize when needed
- **Tool Filtering**: Control which tools are available via allowlists/denylists
- **CLI Commands**: Manage tools and authorization from the command line

## Installation

```bash
# Enable the plugin
openclaw plugins enable arcade

# Configure
openclaw config set plugins.entries.arcade.config.apiKey "arc_..."
openclaw config set plugins.entries.arcade.config.userId "user@example.com"

# Initialize the tools cache
openclaw arcade init

# Restart gateway
openclaw gateway restart
```

## Configuration

### Environment Variables

```bash
export ARCADE_API_KEY="arc_..."          # Required: Arcade API key
export ARCADE_USER_ID="user@example.com" # Optional: Default user ID
```

Alternative names: `ARCADE_KEY`, `ARCADE_USER`

### Config File

```json
// ~/.openclaw/openclaw.json
{
  "plugins": {
    "entries": {
      "arcade": {
        "enabled": true,
        "config": {
          "apiKey": "arc_...",
          "userId": "user@example.com",
          "tools": {
            "allow": ["Gmail.*", "Slack.*", "Github.*"],
            "deny": ["*.Delete*"]
          },
          "toolkits": {
            "Gmail": { "enabled": true },
            "Slack": { "enabled": true }
          }
        }
      }
    }
  }
}
```

## Usage

### Agent Tools

The plugin registers three static utility tools:

- `arcade_list_tools` - List available tools (filter by toolkit)
- `arcade_authorize` - Pre-authorize a tool
- `arcade_execute` - Execute any tool by name

Plus auto-registered tools using the naming convention `arcade_<toolkit>_<tool_name>`:

- `Gmail.SendEmail` → `arcade_gmail_send_email`
- `Slack.SendMessage` → `arcade_slack_send_message`
- `Github.CreateIssue` → `arcade_github_create_issue`
- `GoogleCalendar.CreateEvent` → `arcade_google_calendar_create_event`

### CLI Commands

```bash
# List available tools
openclaw arcade tools list
openclaw arcade tools list --toolkit Gmail

# Search for tools
openclaw arcade tools search email

# Get tool info
openclaw arcade tools info Gmail.SendEmail

# Execute a tool
openclaw arcade tools execute Gmail.SendEmail -i '{"recipient":"test@example.com","subject":"Hello","body":"Test"}'

# Check authorization status
openclaw arcade auth status
openclaw arcade auth status --tool Gmail.SendEmail

# Authorize a tool
openclaw arcade auth login Gmail.SendEmail

# Show configuration
openclaw arcade config

# Health check
openclaw arcade health

# Manage cache
openclaw arcade init          # Initialize/refresh cache
openclaw arcade cache         # Show cache status
openclaw arcade cache --clear # Clear cache
```

## Available Toolkits

### Productivity
- **Gmail** (18 tools) - ListEmails, SendEmail, ReplyToEmail, SearchThreads
- **GoogleCalendar** (7 tools) - ListEvents, CreateEvent, UpdateEvent, DeleteEvent
- **GoogleDrive** (11 tools) - SearchFiles, UploadFile, ShareFile, DownloadFile
- **GoogleDocs** (13 tools) - CreateBlankDocument, EditDocument, SearchDocuments
- **GoogleSheets** (9 tools) - GetSpreadsheet, WriteToCell, CreateSpreadsheet
- **NotionToolkit** (8 tools) - CreatePage, SearchByTitle, GetPageContentById
- **Asana** + **AsanaApi** (218 tools)
- **Linear** (39 tools) - CreateIssue, UpdateIssue, ArchiveIssue
- **Jira** (43 tools) - CreateIssue, UpdateIssue, AddCommentToIssue
- **Clickup** + **ClickupApi**
- **Confluence**
- **Trello** (TrelloApi)

### Communication
- **Slack** + **SlackApi** (81 tools) - SendMessage, GetMessages, ListChannels
- **Microsoft** (11 tools) - CreateAndSendEmail, CreateEvent, ListEmails
- **MicrosoftTeams**
- **OutlookMail** (9 tools) - ListEmails, SendEmail, CreateDraftEmail
- **OutlookCalendar**
- **Zoom** (2 tools) - GetMeetingInvitation, ListUpcomingMeetings
- **Intercom** (IntercomApi - 107 tools)

### Development
- **Github** + **GithubApi** (862 tools)
- **Figma** + **FigmaApi** (58 tools)
- **E2b**
- **Vercel** (VercelApi)
- **Datadog** (DatadogApi)
- **Posthog** (PosthogApi)

### Business & CRM
- **Stripe** + **StripeApi** (235 tools)
- **Hubspot** (809 tools across 9 toolkits)
- **Salesforce** (3 tools)
- **Zendesk** (6 tools)
- **Pylon** + **PylonApi**
- **Freshservice** (FreshserviceApi)
- **Calendly** (CalendlyApi)

### Data & Search
- **GoogleSearch** (1 tool)
- **GoogleNews** (1 tool)
- **Firecrawl** (6 tools)
- **Exa** (ExaApi)
- **Brightdata**
- **Weaviate** (WeaviateApi)

### Storage & Files
- **Airtable** (AirtableApi - 96 tools)
- **Dropbox**
- **Box** (BoxApi)
- **Sharepoint**

### Social
- **X** (Twitter)
- **Linkedin**
- **Reddit**
- **Youtube**
- **Spotify**

### Other
- **Xero** (XeroApi) - Accounting
- **ZohoBooks** (ZohoBooksApi)
- **Mailchimp** (MailchimpMarketingApi)
- **Customer.io** (CustomerioApi + tracks/pipelines)
- **Pagerduty** + **PagerdutyApi**
- **Miro** (MiroApi)
- **Luma** (LumaApi)
- **Imgflip**
- **Math**
- **Walmart**
- **GoogleMaps**, **GoogleFlights**, **GoogleHotels**, **GoogleJobs**, **GoogleShopping**, **GoogleFinance**, **GoogleContacts**, **GoogleSlides**

## Authorization Flow

1. User invokes a tool (e.g., "Send an email via Gmail")
2. If not authorized, Arcade returns an authorization URL
3. OpenClaw prompts the user with the URL
4. User visits URL and grants access
5. Tool execution proceeds automatically

## Development

```bash
# Run tests
cd extensions/arcade
pnpm test

# Type check
pnpm build

# Lint
pnpm lint
```

## Config Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | - | Arcade API key (required) |
| `userId` | string | - | Default user ID for authorization |
| `baseUrl` | string | `https://api.arcade.dev` | API base URL |
| `toolPrefix` | string | `arcade` | Prefix for tool names |
| `autoAuth` | boolean | `true` | Auto-prompt for authorization |
| `cacheToolsTtlMs` | number | `300000` | Tool cache TTL (5 min) |
| `tools.allow` | string[] | - | Allowlist patterns |
| `tools.deny` | string[] | - | Denylist patterns |
| `toolkits.<id>.enabled` | boolean | `true` | Enable/disable toolkit |

## License

MIT
