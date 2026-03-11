---
name: gws
description: Google Workspace CLI (gws) for Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and more. Dynamic API surface from Discovery Service; not an officially supported Google product.
homepage: https://github.com/googleworkspace/cli
metadata:
  {
    "openclaw":
      {
        "emoji": "📋",
        "requires": { "bins": ["gws"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "@googleworkspace/cli",
              "bins": ["gws"],
              "label": "Install gws (npm global)",
            },
          ],
      },
  }
---

# gws (Google Workspace CLI)

Use `gws` for Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, Keep, Meet, Tasks, People, and more. Commands are built at runtime from Google's Discovery Service. Structured JSON output; optional gcloud-free auth.

> **Note**: `gws` is published under the `googleworkspace` GitHub org but is **not an officially supported Google product** (see [repo disclaimer](https://github.com/googleworkspace/cli)).

**Gmail Pub/Sub push**: OpenClaw's Gmail watch flow uses **gog** (`gog gmail watch serve`). Use gws for ad-hoc Gmail (and other Workspace) operations; use gog when wiring Gmail push to webhooks.

## Setup (once)

**Option A — with gcloud (fastest)**  
If `gcloud` is installed and authenticated:

```bash
gws auth setup    # creates project, enables APIs, logs you in
gws auth login    # subsequent logins / scope selection
```

**Option B — without gcloud**  
Create a GCP project and OAuth Desktop client in [Cloud Console](https://console.cloud.google.com/apis/credentials). Download the client JSON and save as:

- `~/.config/gws/client_secret.json`

Then:

```bash
gws auth login
```

Add yourself as a **Test user** in OAuth consent screen if the app is in testing mode. For unverified apps, limit scopes to avoid the ~25-scope limit:

```bash
gws auth login -s drive,gmail,calendar,sheets,docs
```

**Pre-obtained token (e.g. from gcloud)**  
`export GOOGLE_WORKSPACE_CLI_TOKEN=$(gcloud auth print-access-token)` then run `gws` as usual.

**Credentials file (export or service account)**  
`export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/path/to/credentials.json`

## Global flags

| Flag                                | Description                                    |
| ----------------------------------- | ---------------------------------------------- |
| `--format <json\|table\|yaml\|csv>` | Output format (default: json)                  |
| `--dry-run`                         | Validate request locally, do not call API      |
| `--params '{"key": "val"}'`         | URL/query parameters                           |
| `--json '{"key": "val"}'`           | Request body                                   |
| `--page-all`                        | Auto-paginate, one JSON line per page (NDJSON) |
| `--page-limit <n>`                  | Max pages when using --page-all (default 10)   |

## Common commands

**Drive**

- List files: `gws drive files list --params '{"pageSize": 10}'`
- Create + upload: `gws drive files create --json '{"name": "report.pdf"}' --upload ./report.pdf`

**Gmail**

- Profile: `gws gmail users getProfile`
- List messages: use `gws gmail --help` and `gws schema gmail.users.messages.list` for params.
- Send: build request with `gws schema`; body via `--json`.

**Calendar**

- List events: `gws calendar events list --params '{"calendarId": "primary", "timeMin": "<iso>", "timeMax": "<iso>"}'`

**Sheets**

- Get values: `gws sheets spreadsheets values get --params '{"spreadsheetId": "ID", "range": "Sheet1!A1:C10"}'`
- Append: `gws sheets spreadsheets values append --params '{"spreadsheetId": "ID", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' --json '{"values": [["A","B"]]}'`
- Use **single quotes** for ranges (e.g. `'Sheet1!A1:C10'`) to avoid shell history expansion on `!`.

**Docs**

- Export: use Drive export or Docs API via `gws docs --help` and `gws schema`.

**Chat**

- Send message: `gws chat spaces messages create --params '{"parent": "spaces/XYZ"}' --json '{"text": "Hello"}'`

## Introspection

```bash
gws <service> --help
gws schema <service>.<resource>.<method>
```

Use `gws schema` output to build `--params` and `--json` for any method.

## Notes

- Credentials are encrypted at rest when using `gws auth login` (keyring or `~/.config/gws/.encryption_key`).
- For scripting: `--format json` (default); use `--page-all` for large lists.
- Confirm before sending mail, creating events, or deleting resources.
- Upstream skills index and recipes: [github.com/googleworkspace/cli](https://github.com/googleworkspace/cli) → `docs/skills.md`. You can symlink or copy skills from that repo into `~/.openclaw/skills/` if you want per-API skills (e.g. gws-gmail, gws-drive).
