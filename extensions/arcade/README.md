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

## Available Toolkits (89 total)

### Productivity & Project Management
- **Gmail** (18 tools) - SendEmail, ListEmails, SearchThreads, ReplyToEmail
- **GoogleCalendar** (7 tools) - ListEvents, CreateEvent, UpdateEvent, DeleteEvent
- **GoogleDrive** (11 tools) - SearchFiles, UploadFile, ShareFile, DownloadFile
- **GoogleDocs** (13 tools) - CreateBlankDocument, EditDocument, SearchDocuments
- **GoogleSheets** (9 tools) - GetSpreadsheet, WriteToCell, CreateSpreadsheet
- **GoogleSlides** (8 tools) - Presentation management
- **GoogleContacts** (5 tools) - Contact management
- **Google** (37 tools) - General Google services
- **NotionToolkit** (8 tools) - CreatePage, SearchByTitle, GetPageContentById
- **Asana** + **AsanaApi** (218 tools) - Task and project management
- **Linear** (39 tools) - CreateIssue, UpdateIssue, ArchiveIssue
- **Jira** (43 tools) - CreateIssue, UpdateIssue, AddCommentToIssue
- **Clickup** + **ClickupApi** (158 tools) - Project management
- **Confluence** (14 tools) - Documentation
- **TrelloApi** (246 tools) - Board and card management
- **TicktickApi** (11 tools) - Task management

### Communication
- **Slack** + **SlackApi** (81 tools) - SendMessage, GetMessages, ListChannels
- **Microsoft** (11 tools) - CreateAndSendEmail, CreateEvent, ListEmails
- **MicrosoftTeams** (25 tools) - Team messaging
- **OutlookMail** (9 tools) - ListEmails, SendEmail, CreateDraftEmail
- **OutlookCalendar** (4 tools) - Calendar management
- **Zoom** (2 tools) - GetMeetingInvitation, ListUpcomingMeetings
- **IntercomApi** (107 tools) - Customer messaging

### Development & DevOps
- **Github** + **GithubApi** (862 tools) - Repos, issues, PRs, actions
- **Figma** + **FigmaApi** (58 tools) - Design files, comments, components
- **VercelApi** (194 tools) - Deployment and hosting
- **DatadogApi** (588 tools) - Monitoring and analytics
- **PosthogApi** (766 tools) - Product analytics
- **E2b** (2 tools) - Code execution
- **CursorAgentsApi** (7 tools) - AI coding agents
- **ArcadeEngineApi** (29 tools) - Arcade platform tools

### Business, CRM & Finance
- **Stripe** + **StripeApi** (235 tools) - Payments, customers, subscriptions
- **SquareupApi** (286 tools) - Payment processing
- **Hubspot** + **HubspotCrmApi** + **HubspotMarketingApi** + **HubspotCmsApi** + **HubspotConversationsApi** + **HubspotAutomationApi** + **HubspotEventsApi** + **HubspotMeetingsApi** + **HubspotUsersApi** (769 tools) - Full CRM suite
- **Salesforce** (3 tools) - CRM
- **Zendesk** (6 tools) - Customer support
- **Pylon** + **PylonApi** (95 tools) - Customer success
- **FreshserviceApi** (214 tools) - IT service management
- **CalendlyApi** (51 tools) - Scheduling
- **XeroApi** (153 tools) - Accounting
- **ZohoBooksApi** (511 tools) - Accounting
- **MailchimpMarketingApi** (278 tools) - Email marketing
- **CustomerioApi** + **CustomerioTrackApi** + **CustomerioPipelinesApi** (139 tools) - Customer engagement
- **AshbyApi** (141 tools) - Recruiting

### Data, Search & AI
- **GoogleSearch** (1 tool) - Web search
- **GoogleNews** (1 tool) - News search
- **Firecrawl** (6 tools) - Web scraping
- **ExaApi** (45 tools) - AI search
- **Brightdata** (3 tools) - Web data
- **WeaviateApi** (81 tools) - Vector database
- **Math** (23 tools) - Calculations

### Storage & Files
- **AirtableApi** (96 tools) - Database/spreadsheet
- **Dropbox** (3 tools) - File storage
- **BoxApi** (188 tools) - Enterprise file storage
- **Sharepoint** (12 tools) - Document management

### Social & Media
- **X** (8 tools) - Twitter/X posting
- **Linkedin** (1 tool) - Professional networking
- **Reddit** (11 tools) - Reddit interactions
- **Youtube** (2 tools) - Video platform
- **Spotify** (13 tools) - Music streaming

### Other Services
- **Pagerduty** + **PagerdutyApi** (388 tools) - Incident management
- **MiroApi** (139 tools) - Whiteboard collaboration
- **LumaApi** (37 tools) - Event management
- **Imgflip** (3 tools) - Meme generation
- **Walmart** (2 tools) - E-commerce
- **GoogleMaps** (2 tools), **GoogleFlights** (1 tool), **GoogleHotels** (1 tool), **GoogleJobs** (1 tool), **GoogleShopping** (1 tool), **GoogleFinance** (2 tools) - Google services

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
| `useApiTools` | boolean | `false` | Include *Api toolkits (GithubApi, SlackApi, etc.) |
| `tools.allow` | string[] | - | Allowlist patterns |
| `tools.deny` | string[] | - | Denylist patterns |
| `toolkits.<id>.enabled` | boolean | `true` | Enable/disable toolkit |

## License

MIT
