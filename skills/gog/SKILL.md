---
name: gog
description: "Google Workspace CLI for Gmail, Calendar, Drive, Docs, Sheets, Sites, Slides, Forms, Meet, Apps Script, Analytics, Search Console, Contacts, Tasks, People, Classroom, Chat, YouTube, and Workspace admin."
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog (brew)",
            },
          ],
      },
  }
---

# gog

Use `gog` for Google Workspace from the terminal. Requires OAuth setup.

## Supported Services

`gog` covers these Google services (run `gog <service> --help` for full subcommands):

| Service            | Key commands                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| **Gmail**          | search, send, drafts, reply, messages, labels, filters, attachments         |
| **Calendar**       | events, create, update, colors, focus-time, out-of-office, working-location |
| **Drive**          | search, upload, download, tree, disk-usage, sharing-audit, changes, raw API |
| **Docs**           | export, cat, copy                                                           |
| **Sheets**         | get, update, append, clear, metadata                                        |
| **Contacts**       | list, create, update, delete                                                |
| **Tasks**          | list, create, update, complete                                              |
| **People**         | search, get, connections                                                    |
| **Classroom**      | courses, roster, coursework, materials, submissions, announcements          |
| **Chat**           | spaces, messages, threads, direct messages                                  |
| **YouTube**        | channel data, search                                                        |
| **Maps/Places**    | places search, details, directions, geocoding                               |
| **Forms**          | form creation, responses                                                    |
| **Meet**           | attachment/auth setup for calendar events                                   |
| **Sites**          | site management                                                             |
| **Slides**         | presentation operations                                                     |
| **Apps Script**    | project management, deployments                                             |
| **Analytics**      | reporting                                                                   |
| **Search Console** | site verification, performance reports                                      |

Additional capabilities:

- **MCP server** — typed MCP server for agent clients (`gog mcp`), read-only by default
- **Drive audits** — tree, disk usage, sharing audits, bulk public removal, Drive Labels
- **Drive changes** — change tracking, polling, revision history, activity logs
- **Gmail filters** — export in Gmail web UI import format
- **Workspace admin** — directory, users, groups

## Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

## Common commands

- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar show colors: `gog calendar colors`
- Drive search: `gog drive search "query" --max 10`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

## Full Command Reference

For the complete, up-to-date command surface, use:

- `gog --help` — top-level service list
- `gog <service> --help` — subcommands for a specific service (e.g. `gog gmail --help`)
- Generated docs: <https://gogcli.sh/>
- Command index: <https://gogcli.sh/commands/>

## Calendar Colors

- Use `gog calendar colors` to see all available event colors (IDs 1-11)
- Add colors to events with `--event-color <id>` flag
- Event color IDs (from `gog calendar colors` output):
  - 1: #a4bdfc
  - 2: #7ae7bf
  - 3: #dbadff
  - 4: #ff887c
  - 5: #fbd75b
  - 6: #ffb878
  - 7: #46d6db
  - 8: #e1e1e1
  - 9: #5484ed
  - 10: #51b749
  - 11: #dc2127

## Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.
- Example (plain text via stdin):

  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-file - <<'EOF'
  Hi Name,

  Thanks for meeting today. Next steps:
  - Item one
  - Item two

  Best regards,
  Your Name
  EOF
  ```

- Example (HTML list):
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"
  ```

## Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
- `gog mcp` starts a typed MCP server for agent integration (read-only by default).
