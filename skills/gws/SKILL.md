---
name: gws
description: "Official Google Workspace CLI (gws) for Gmail, Calendar, Drive, Sheets, Docs, Chat, Tasks, People/Contacts, Slides, Forms, Keep, Meet, and more. Dynamically builds its command surface from Google's Discovery Service — every API method is available with zero boilerplate."
homepage: https://github.com/googleworkspace/cli
metadata:
  {
    "openclaw":
      {
        "emoji": "🔷",
        "requires": { "bins": ["gws"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@googleworkspace/cli",
              "bins": ["gws"],
              "label": "Install gws (npm)",
            },
          ],
      },
  }
---

# gws — Official Google Workspace CLI

Use `gws` for Gmail, Calendar, Drive, Sheets, Docs, Chat, Tasks, People/Contacts, Slides,
Forms, Keep, Meet, and every other Google Workspace API. Requires a one-time OAuth setup.

> **Note:** If you are already set up with the `gog` skill, both tools work side-by-side.
> `gws` is the official Google Workspace CLI maintained by Google; `gog` is a third-party
> alternative. Use whichever is already authenticated, or set up `gws` for new installs.

## Setup (once)

```bash
# Guided setup: creates a GCP project, enables APIs, and logs you in
# (requires gcloud CLI to be installed and authenticated)
gws auth setup

# — OR — manual OAuth (Google Cloud Console)
# 1. Create an OAuth Desktop app credential in your GCP project
# 2. Download client JSON to ~/.config/gws/client_secret.json
gws auth login
```

Headless / CI export:

```bash
# On the machine with a browser
gws auth export --unmasked > credentials.json

# On the headless machine
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json
```

Service account (server-to-server):

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
# Domain-Wide Delegation (optional)
export GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER=admin@example.com
```

## Global Flags

| Flag | Description |
|------|-------------|
| `--format <FORMAT>` | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run` | Validate locally without calling the API |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages when using `--page-all` (default: 10) |
| `--sanitize <TEMPLATE>` | Screen responses through Google Model Armor |

## Discovering Commands

`gws` reads Google's Discovery Service at runtime — every API method is available.

```bash
# List all supported services
gws --help

# Browse resources for a service
gws gmail --help
gws calendar --help

# Inspect a method's required params, types, and defaults
gws schema gmail.users.messages.list
gws schema calendar.events.insert
```

## Gmail

```bash
# List messages in inbox (most recent 10)
gws gmail users messages list --params '{"userId": "me", "maxResults": 10, "labelIds": ["INBOX"]}'

# Get a specific message
gws gmail users messages get --params '{"userId": "me", "id": "<messageId>", "format": "full"}'

# Send a message (raw RFC 2822, base64url-encoded)
gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "<base64url>"}'

# Search messages
gws gmail users messages list --params '{"userId": "me", "q": "from:someone@example.com newer_than:7d"}'

# List threads
gws gmail users threads list --params '{"userId": "me", "maxResults": 10}'

# Create a draft
gws gmail users drafts create --params '{"userId": "me"}' --json '{"message": {"raw": "<base64url>"}}'

# Get user profile
gws gmail users getProfile --params '{"userId": "me"}'
```

## Calendar

```bash
# List calendars
gws calendar calendarList list

# List upcoming events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "<RFC3339>", "maxResults": 20, "singleEvents": true, "orderBy": "startTime"}'

# Create an event
gws calendar events insert --params '{"calendarId": "primary"}' \
  --json '{"summary": "Meeting", "start": {"dateTime": "<RFC3339>"}, "end": {"dateTime": "<RFC3339>"}}'

# Update an event
gws calendar events patch --params '{"calendarId": "primary", "eventId": "<id>"}' \
  --json '{"summary": "Updated Title"}'

# Delete an event
gws calendar events delete --params '{"calendarId": "primary", "eventId": "<id>"}' --dry-run

# Query free/busy
gws calendar freebusy query --json '{"timeMin": "<RFC3339>", "timeMax": "<RFC3339>", "items": [{"id": "primary"}]}'
```

## Drive

```bash
# List files (most recent 10)
gws drive files list --params '{"pageSize": 10}'

# Search files
gws drive files list --params '{"q": "name contains '\''budget'\'' and mimeType='\''application/vnd.google-apps.spreadsheet'\''", "pageSize": 10}'

# Get file metadata
gws drive files get --params '{"fileId": "<id>", "fields": "id,name,mimeType,size,modifiedTime"}'

# Upload a file
gws drive files create --json '{"name": "report.pdf"}' --upload ./report.pdf

# Download a file
gws drive files get --params '{"fileId": "<id>", "alt": "media"}' -o ./downloaded.pdf

# Create a folder
gws drive files create --json '{"name": "My Folder", "mimeType": "application/vnd.google-apps.folder"}'

# Delete a file (use --dry-run first)
gws drive files delete --params '{"fileId": "<id>"}' --dry-run
```

## Sheets

```bash
# Get spreadsheet metadata
gws sheets spreadsheets get --params '{"spreadsheetId": "<id>"}'

# Read values from a range
gws sheets spreadsheets values get --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:D10"}'

# Write values to a range
gws sheets spreadsheets values update \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:B2", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["A", "B"], ["1", "2"]]}'

# Append rows
gws sheets spreadsheets values append \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A:C", "valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"}' \
  --json '{"values": [["x", "y", "z"]]}'

# Clear a range
gws sheets spreadsheets values clear \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A2:Z"}' --json '{}'

# Create a new spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'
```

## Docs

```bash
# Get document content
gws docs documents get --params '{"documentId": "<id>"}'

# Create a new document
gws docs documents create --json '{"title": "My New Doc"}'

# Batch update (insert text, etc.)
gws docs documents batchUpdate --params '{"documentId": "<id>"}' \
  --json '{"requests": [{"insertText": {"location": {"index": 1}, "text": "Hello World\n"}}]}'
```

## People / Contacts

```bash
# List connections (contacts)
gws people people connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses,phoneNumbers"}'

# Get a contact
gws people people get --params '{"resourceName": "people/<id>", "personFields": "names,emailAddresses"}'

# Search contacts
gws people people searchContacts --params '{"query": "Alice", "readMask": "names,emailAddresses"}'
```

## Tasks

```bash
# List task lists
gws tasks tasklists list

# List tasks in a task list
gws tasks tasks list --params '{"tasklist": "<tasklistId>"}'

# Create a task
gws tasks tasks insert --params '{"tasklist": "<tasklistId>"}' \
  --json '{"title": "Buy groceries", "due": "<RFC3339>"}'

# Complete a task
gws tasks tasks patch --params '{"tasklist": "<tasklistId>", "task": "<taskId>"}' \
  --json '{"status": "completed"}'
```

## Chat

```bash
# List spaces
gws chat spaces list

# Send a message to a space
gws chat spaces messages create \
  --params '{"parent": "spaces/<spaceId>"}' \
  --json '{"text": "Hello from gws!"}' \
  --dry-run
```

## MCP Server (optional)

`gws mcp` exposes Google Workspace APIs as MCP tools for any compatible client
(Claude Desktop, VS Code, Gemini CLI, etc.):

```bash
gws mcp -s drive,gmail,calendar   # expose specific services
gws mcp -s all                     # expose all services
```

Configure in your MCP client:

```json
{
  "mcpServers": {
    "gws": {
      "command": "gws",
      "args": ["mcp", "-s", "drive,gmail,calendar"]
    }
  }
}
```

## Agent Skills (optional)

The `gws` repo ships 100+ focused `SKILL.md` files — one per API, plus workflow helpers.
Install them all into OpenClaw at once:

```bash
# Symlink all gws skills (stays in sync with upstream)
git clone https://github.com/googleworkspace/cli /tmp/googleworkspace-cli
ln -s /tmp/googleworkspace-cli/skills/gws-* ~/.openclaw/skills/
```

Or install only the services you need:

```bash
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-drive
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-gmail
```

## Notes

- Run `gws auth setup` for guided first-time setup (requires `gcloud`).
- Use `gws schema <service>.<resource>.<method>` to inspect any API method before calling it.
- All output is structured JSON; pipe to `jq` for filtering.
- Use `--dry-run` before any write or delete operation.
- Use `--page-all` to auto-paginate large result sets (outputs NDJSON).
- Confirm with the user before sending mail, creating calendar events, or deleting files.
- The `gws` binary is built in Rust and also available via `cargo install --path .` from source.
