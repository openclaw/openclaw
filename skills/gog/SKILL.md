---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, Docs, and Tasks.
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

Use `gog` for Gmail/Calendar/Drive/Contacts/Sheets/Docs/Tasks. Requires OAuth setup.

Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets,tasks`
- `gog auth list`

Common commands

- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Gmail get message (with attachments): `gog gmail get <messageId> --json`
- Gmail download attachment: `gog gmail attachment <messageId> <attachmentId> --out /tmp/file.pdf`
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar show colors: `gog calendar colors`
- Drive search: `gog drive search "query" --max 10`
- Tasks list task lists: `gog tasks lists list`
- Tasks list tasks: `gog tasks list <tasklistId>`
- Tasks add: `gog tasks add <tasklistId> --title "Buy milk"`
- Tasks add (with due date): `gog tasks add <tasklistId> --title "File taxes" --due 2025-04-15`
- Tasks add (with notes): `gog tasks add <tasklistId> --title "Call dentist" --notes "Ask about next appointment"`
- Tasks add (subtask): `gog tasks add <tasklistId> --title "Subtask" --parent <parentTaskId>`
- Tasks add (recurring): `gog tasks add <tasklistId> --title "Weekly review" --due 2025-03-01 --repeat weekly --repeat-count 4`
- Tasks complete: `gog tasks done <tasklistId> <taskId>`
- Tasks uncomplete: `gog tasks undo <tasklistId> <taskId>`
- Tasks update: `gog tasks update <tasklistId> <taskId> --title "New title" --due 2025-05-01`
- Tasks delete: `gog tasks delete <tasklistId> <taskId>`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

Calendar Colors

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

Email Formatting

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

Gmail Attachments

To read email attachments (PDFs, images, etc.):

1. Get the message with `--json` to find attachment metadata:
   `gog gmail get <messageId> --json`
   The response includes an `attachments` array with `filename`, `mimeType`, `size`, and `attachmentId` for each attachment.

2. Download the attachment:
   `gog gmail attachment <messageId> <attachmentId> --out /tmp/filename.pdf`

3. Read or process the downloaded file as needed.

- Gmail attachment downloads use the Gmail API directly. Tokens do not expire per-attachment; any attachment can be downloaded at any time as long as the OAuth session is valid.
- Use `--name` to override the saved filename when `--out` is not set.

Tasks

- `gog tasks lists list` to see all task lists and their IDs.
- `gog tasks list <tasklistId>` to see tasks in a list. Add `--json` for structured output.
- `gog tasks add <tasklistId> --title "Task"` to create a task.
- `--due YYYY-MM-DD` sets a due date (time portion may be ignored by Google Tasks).
- `--notes "..."` adds a description/notes body.
- `--parent <taskId>` creates a subtask under the given parent.
- `--repeat daily|weekly|monthly|yearly` with `--repeat-count N` or `--repeat-until YYYY-MM-DD` creates recurring tasks.
- `gog tasks done <tasklistId> <taskId>` marks a task as completed.
- `gog tasks undo <tasklistId> <taskId>` marks it as needs action again.
- `gog tasks update <tasklistId> <taskId>` with `--title`, `--notes`, or `--due` to modify a task.
- `gog tasks delete <tasklistId> <taskId>` to remove a task.
- `gog tasks clear <tasklistId>` removes all completed tasks from a list.

Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
