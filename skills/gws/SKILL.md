---
name: gws
description: "Official Google Workspace CLI (gws) for Gmail, Calendar, Drive, Sheets, Docs, Chat, Tasks, People/Contacts, Slides, Forms, Keep, Meet, and more. Dynamically builds its command surface from Google's Discovery Service."
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
              "id": "node",
              "kind": "node",
              "package": "@googleworkspace/cli",
              "bins": ["gws"],
              "label": "Install gws (npm)",
            },
          ],
      },
  }
---

# gws — Official Google Workspace CLI

`gws` is the official Google Workspace CLI. It reads Google's Discovery Service at runtime and builds its entire command surface dynamically — when Google adds an API endpoint, `gws` picks it up automatically.

Covers: Gmail, Calendar, Drive, Sheets, Docs, People/Contacts, Tasks, Chat, Meet, Forms, Slides, Keep, Classroom, Admin, Vault, Cloud Identity, Apps Script, Alert Center, and more.

> **Coexistence with gog:** Both `gws` and `gog` can be installed side by side. `gws` is a strict superset of `gog` — it covers all 6 gog services (Gmail, Calendar, Drive, Contacts, Sheets, Docs) plus 14+ additional services. If both are present, prefer `gws` for any service it supports.

---

## Setup (once)

### Interactive (recommended)

```bash
gws auth setup     # creates a Cloud project, enables APIs, logs you in
```

> Requires the `gcloud` CLI to be installed and authenticated.

### Manual OAuth (Google Cloud Console)

Use this when `gws auth setup` cannot automate project/client creation:

1. Open the Google Cloud Console for your project
2. Configure OAuth consent screen (External, testing mode)
3. Create an OAuth client (Desktop app type)
4. Download the client JSON to `~/.config/gws/client_secret.json`
5. Run `gws auth login`

### Headless / CI

1. Complete interactive auth on a machine with a browser
2. Export: `gws auth export --unmasked > credentials.json`
3. On headless machine: `export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json`

### Service Account

```bash
export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/service-account.json
gws drive files list
```

For Domain-Wide Delegation, also set:

```bash
export GOOGLE_WORKSPACE_CLI_IMPERSONATED_USER=admin@example.com
```

---

## Global Flags

These flags work on every command:

| Flag                    | Description                                             |
| ----------------------- | ------------------------------------------------------- |
| `--format <FORMAT>`     | Output format: `json` (default), `table`, `yaml`, `csv` |
| `--dry-run`             | Validate locally without calling the API                |
| `--sanitize <TEMPLATE>` | Screen responses through Model Armor                    |

## Method Flags

These flags apply to individual API method calls:

| Flag                        | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| `--params '{"key": "val"}'` | URL/query parameters                                 |
| `--json '{"key": "val"}'`   | Request body                                         |
| `-o, --output <PATH>`       | Save binary responses to file (e.g. Drive downloads) |
| `--upload <PATH>`           | Upload file content (multipart)                      |
| `--page-all`                | Auto-paginate (NDJSON output)                        |
| `--page-limit <N>`          | Max pages when using `--page-all` (default: 10)      |
| `--page-delay <MS>`         | Delay between pages in ms (default: 100)             |

---

## CLI Syntax

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

## Discovering Commands

Use `gws schema` to introspect any method's request/response schema:

```bash
gws schema drive.files.list
gws schema gmail.users.messages.send
```

---

## Gmail

```bash
# List messages
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Get a message
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'

# Search
gws gmail users messages list --params '{"userId": "me", "q": "newer_than:7d from:notifications@github.com"}'

# Send
gws gmail users messages send --params '{"userId": "me"}' \
  --json '{"raw": "BASE64_ENCODED_RFC2822"}'

# List labels
gws gmail users labels list --params '{"userId": "me"}'
```

## Calendar

```bash
# List upcoming events
gws calendar events list --params '{"calendarId": "primary", "maxResults": 10, "timeMin": "2025-01-01T00:00:00Z", "orderBy": "startTime", "singleEvents": true}'

# Create an event
gws calendar events insert --params '{"calendarId": "primary"}' \
  --json '{"summary": "Team standup", "start": {"dateTime": "2025-01-15T09:00:00-08:00"}, "end": {"dateTime": "2025-01-15T09:30:00-08:00"}}'

# List calendars
gws calendar calendarList list
```

## Drive

```bash
# List files
gws drive files list --params '{"pageSize": 10}'

# Search files
gws drive files list --params '{"q": "name contains '\''report'\''", "pageSize": 10}'

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' -o ./downloaded-file.pdf

# Upload a file
gws drive files create --json '{"name": "report.pdf"}' --upload ./report.pdf

# Auto-paginate all files
gws drive files list --params '{"pageSize": 100}' --page-all
```

## Sheets

```bash
# Read a range
gws sheets spreadsheets values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:D10"}'

# Write values
gws sheets spreadsheets values update \
  --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Score"], ["Alice", 95], ["Bob", 87]]}'

# Create a spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'
```

## Docs

```bash
# Get document content
gws docs documents get --params '{"documentId": "DOC_ID"}'

# Create a document
gws docs documents create --json '{"title": "Meeting Notes"}'

# Batch update
gws docs documents batchUpdate --params '{"documentId": "DOC_ID"}' \
  --json '{"requests": [{"insertText": {"location": {"index": 1}, "text": "Hello World"}}]}'
```

## People / Contacts

```bash
# List contacts
gws people people connections list --params '{"resourceName": "people/me", "personFields": "names,emailAddresses", "pageSize": 10}'

# Search contacts
gws people people searchContacts --params '{"query": "Alice", "readMask": "names,emailAddresses"}'

# Get own profile
gws people people get --params '{"resourceName": "people/me", "personFields": "names,emailAddresses,phoneNumbers"}'
```

## Tasks

```bash
# List task lists
gws tasks tasklists list

# List tasks in a list
gws tasks tasks list --params '{"tasklist": "TASKLIST_ID"}'

# Create a task
gws tasks tasks insert --params '{"tasklist": "TASKLIST_ID"}' \
  --json '{"title": "Review PR", "notes": "Check the gws integration"}'
```

## Chat

```bash
# List spaces
gws chat spaces list

# Send a message
gws chat spaces messages create \
  --params '{"parent": "spaces/SPACE_ID"}' \
  --json '{"text": "Deploy complete."}'

# Send with dry-run
gws chat spaces messages create \
  --params '{"parent": "spaces/SPACE_ID"}' \
  --json '{"text": "Test message"}' \
  --dry-run
```

---

## MCP Server (optional)

`gws mcp` starts a Model Context Protocol server over stdio:

```bash
gws mcp -s drive                  # expose Drive tools
gws mcp -s drive,gmail,calendar   # expose multiple services
gws mcp -s all                    # expose all services (many tools!)
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

Each service adds roughly 10-80 tools. Keep the list to what you actually need to stay under your client's tool limit.

| Flag                    | Description                                  |
| ----------------------- | -------------------------------------------- |
| `-s, --services <list>` | Comma-separated services to expose, or `all` |
| `-w, --workflows`       | Also expose workflow tools                   |
| `-e, --helpers`         | Also expose helper tools                     |

---

## Agent Skills (optional)

The `gws` repo ships 100+ Agent Skills — one for every supported API, plus workflows and 50 curated recipes:

```bash
# Install all skills
npx skills add https://github.com/googleworkspace/cli

# Or pick specific ones
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-drive
npx skills add https://github.com/googleworkspace/cli/tree/main/skills/gws-gmail
```

---

## Notes

- **Output:** All output is structured JSON. Use `--format table` for human-readable output.
- **Rate limits:** Google APIs enforce per-user rate limits. If you get a 429 error, wait and retry.
- **API enablement:** If you get a 403 `accessNotConfigured` error, enable the API in your GCP Console (the error includes a direct link). Or run `gws auth setup` which enables common APIs automatically.
- **Token refresh:** OAuth tokens auto-refresh. No manual intervention needed.
- **Pagination:** Use `--page-all` for complete result sets; output is NDJSON (one JSON object per page).
