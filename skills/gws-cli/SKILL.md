---
name: gws-cli
description: "Google Workspace access via the local `gwsc` wrapper for Drive, Sheets, Docs, Slides, Gmail, Calendar, and Tasks. Use when the user wants OpenClaw to inspect Google Drive contents, search Workspace files, read or create Google Sheets/Docs/Slides, or query Gmail/Calendar/Tasks from the Ubuntu host where `gwsc` is configured."
metadata:
  {
    "openclaw":
      {
        "emoji": "🗂️",
        "requires": { "bins": ["gwsc"] },
      },
  }
---

# gws-cli

Use `gwsc`, not raw `gws`. `gwsc` pins the known credentials file on the Ubuntu host and is the stable entrypoint for non-interactive OpenClaw exec runs.

Hard rule

- When the user asks to read, summarize, or inspect the contents of a Drive `.docx` file or provides a Drive `fileId` for a `.docx`, do not answer from general knowledge and do not ask to use a browser first.
- Instead, download the binary file with `gwsc drive files get --params '{"fileId":"<FILE_ID>","alt":"media"}' --output /tmp/<name>.docx`, then run `/usr/bin/python3 /home/deepnoa/openclaw/skills/gws-cli/scripts/docx_text.py /tmp/<name>.docx`, then summarize that extracted text.
- For `.docx` handling, use only the bundled `docx_text.py` helper after download. Do not use `unzip`, `sed`, shell heredocs, inline Python, or ad-hoc XML parsing.
- Only report that reading is unavailable if the download or extraction command actually fails.

When to use

- User asks to see Google Drive contents or search Drive files
- User asks to read or create Sheets, Docs, or Slides
- User asks to inspect Gmail, Calendar, or Tasks through the CLI

Quick checks

- Verify command exists: `command -v gwsc`
- Verify auth path if needed: `gwsme`

Common commands

- Drive list recent files: `gwsc drive files list --params '{"pageSize":10}'`
- Drive search by name: `gwsc drive files list --params '{"q":"name contains '\''invoice'\''","pageSize":10}'`
- Drive get metadata: `gwsc drive files get --params '{"fileId":"<FILE_ID>"}'`
- Download binary file: `gwsc drive files get --params '{"fileId":"<FILE_ID>","alt":"media"}' --output /tmp/file.bin`
- Read a Drive `.docx`: `gwsc drive files get --params '{"fileId":"<FILE_ID>","alt":"media"}' --output /tmp/file.docx && /usr/bin/python3 /home/deepnoa/openclaw/skills/gws-cli/scripts/docx_text.py /tmp/file.docx`
- Sheets create: `gwsc sheets spreadsheets create --json '{"properties":{"title":"New sheet"}}'`
- Docs create: `gwsc docs documents create --json '{"title":"New doc"}'`
- Slides create: `gwsc slides presentations create --json '{"title":"New slides"}'`
- Gmail list: `gwsc gmail users messages list --params '{"userId":"me","maxResults":10}'`
- Calendar list: `gwsc calendar events list --params '{"calendarId":"primary"}'`
- Tasks list: `gwsc tasks tasklists list`

Guidance

- Prefer `--format json` when parsing results.
- For Drive browsing requests, start with `drive files list` and summarize names, MIME types, and ids.
- For file-specific follow-up, use the returned `fileId`.
- For `.docx` files stored in Drive, download them to `/tmp` and run `scripts/docx_text.py` to extract readable text before summarizing.
- Use this exact pattern for `.docx` requests: first `gwsc drive files get ... --output /tmp/<name>.docx`, then `/usr/bin/python3 /home/deepnoa/openclaw/skills/gws-cli/scripts/docx_text.py /tmp/<name>.docx`.
- When the user gives a `fileId`, prefer using that `fileId` directly instead of asking follow-up questions.
- For document-summary requests, return a compact summary of purpose, named people/organizations, dates, and the main sections in the document.
- Confirm before creating or modifying Workspace data unless the user already asked for that write action.

Troubleshooting

- If `gwsc` is missing, stop and report that the Ubuntu host setup is incomplete.
- If exec is denied, the gateway/node exec allowlist likely needs the `gwsc` path added.
- If `.docx` extraction is denied, the gateway/node exec allowlist likely also needs `/usr/bin/python3`.
- If auth fails, check `/home/deepnoa/.config/gws/credentials.json` and the `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE` environment variable.
