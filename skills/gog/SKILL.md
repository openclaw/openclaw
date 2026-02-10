---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://gogcli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🎮",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["gog"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/gogcli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["gog"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install gog (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# gog（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `gog` for Gmail/Calendar/Drive/Contacts/Sheets/Docs. Requires OAuth setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup (once)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog auth credentials /path/to/client_secret.json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog auth list`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail search: `gog gmail search 'newer_than:7d' --max 10`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail send draft: `gog gmail drafts send <draftId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Calendar show colors: `gog calendar colors`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Drive search: `gog drive search "query" --max 10`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Contacts: `gog contacts list --max 20`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets metadata: `gog sheets metadata <sheetId> --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs cat: `gog docs cat <docId>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Calendar Colors（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `gog calendar colors` to see all available event colors (IDs 1-11)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add colors to events with `--event-color <id>` flag（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Event color IDs (from `gog calendar colors` output):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 1: #a4bdfc（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 2: #7ae7bf（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 3: #dbadff（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 4: #ff887c（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 5: #fbd75b（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 6: #ffb878（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 7: #46d6db（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 8: #e1e1e1（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 9: #5484ed（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 10: #51b749（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - 11: #dc2127（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Email Formatting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same `--body-file` pattern works for drafts and replies.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--body-html` only when you need rich formatting.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example (plain text via stdin):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gog gmail send --to recipient@example.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    --subject "Meeting Follow-up" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    --body-file - <<'EOF'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Hi Name,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Thanks for meeting today. Next steps:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Item one（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Item two（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Best regards,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Your Name（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  EOF（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Example (HTML list):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gog gmail send --to recipient@example.com \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    --subject "Meeting Follow-up" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  ```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- For scripting, prefer `--json` plus `--no-input`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm before sending mail or creating events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
