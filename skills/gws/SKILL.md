---
name: gws
description: "Google Workspace operations via `gws` CLI: Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and all Workspace APIs. Use when: (1) listing, searching, or managing Google Drive files, (2) reading or sending Gmail, (3) checking or creating Calendar events, (4) reading or writing Sheets/Docs, (5) managing Workspace users or groups, (6) any Google Workspace API task. NOT for: non-Google services, local file operations, or when gws auth is not configured."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏢",
        "requires": { "bins": ["gws"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@googleworkspace/cli",
              "bins": ["gws"],
              "label": "Install Google Workspace CLI (npm)",
            },
          ],
      },
  }
---

# Google Workspace CLI Skill

Use the `gws` CLI to interact with all Google Workspace APIs. Commands are built dynamically from Google's Discovery Service — when Google adds an API endpoint, `gws` picks it up automatically.

## Setup

```bash
# Install
npm install -g @googleworkspace/cli

# Authenticate (one-time, requires browser)
gws auth setup     # creates GCP project + enables APIs + logs in
gws auth login     # subsequent logins

# Verify
gws drive files list --params '{"pageSize": 1}'
```

If `gws auth setup` fails (no `gcloud`), set up OAuth manually in the Google Cloud Console — create a Desktop OAuth client and save the JSON to `~/.config/gws/client_secret.json`, then run `gws auth login`.

## CLI Syntax

```bash
gws <service> <resource> [sub-resource] <method> [flags]
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--params '{...}'` | URL/query parameters (JSON) |
| `--json '{...}'` | Request body (JSON) |
| `--dry-run` | Preview without calling the API |
| `--upload <path>` | Upload file content (multipart) |
| `-o, --output <path>` | Save binary response to file |
| `--page-all` | Auto-paginate (NDJSON output) |
| `--page-limit <N>` | Max pages (default: 10) |

All output is structured JSON by default.

## Common Operations

### Drive

```bash
# List recent files
gws drive files list --params '{"pageSize": 10}'

# Search files
gws drive files list --params '{"q": "name contains '\''report'\'' and mimeType='\''application/pdf'\''", "pageSize": 20}'

# Download a file
gws drive files get --params '{"fileId": "FILE_ID", "alt": "media"}' -o ./downloaded.pdf

# Upload a file
gws drive files create --json '{"name": "report.pdf"}' --upload ./report.pdf
```

### Gmail

```bash
# List recent messages
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Get a message
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID", "format": "full"}'

# Send an email (base64-encoded RFC 2822)
gws gmail users messages send --params '{"userId": "me"}' --json '{"raw": "BASE64_ENCODED_MESSAGE"}'
```

### Calendar

```bash
# List upcoming events
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2025-01-01T00:00:00Z", "maxResults": 10, "orderBy": "startTime", "singleEvents": true}'

# Create an event
gws calendar events insert --params '{"calendarId": "primary"}' --json '{"summary": "Team sync", "start": {"dateTime": "2025-01-15T10:00:00-05:00"}, "end": {"dateTime": "2025-01-15T10:30:00-05:00"}}'
```

### Sheets

```bash
# Read cells
gws sheets spreadsheets values get --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1:C10"}'

# Append rows
gws sheets spreadsheets values append \
  --params '{"spreadsheetId": "SHEET_ID", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Score"], ["Alice", 95]]}'

# Create a spreadsheet
gws sheets spreadsheets create --json '{"properties": {"title": "Q1 Budget"}}'
```

### Docs

```bash
# Get document content
gws docs documents get --params '{"documentId": "DOC_ID"}'
```

### Chat

```bash
# Send a Chat message
gws chat spaces messages create \
  --params '{"parent": "spaces/SPACE_ID"}' \
  --json '{"text": "Hello from gws!"}'
```

## Discover APIs

```bash
# List all available services
gws list

# Get help for any service
gws drive --help
gws gmail users messages --help

# Inspect method schemas
gws schema drive.files.list
gws schema gmail.users.messages.send
```

## Multiple Accounts

```bash
gws auth login --account work@corp.com
gws auth login --account personal@gmail.com
gws auth list                                    # list accounts
gws auth default work@corp.com                   # set default
gws --account personal@gmail.com drive files list  # one-off override
```

## Safety

- Confirm with the user before write/delete operations
- Use `--dry-run` to preview destructive commands
- Shell-escape single quotes in Sheets ranges (they contain `!`)
- Paginated results stream as NDJSON — pipe through `jq` for filtering
