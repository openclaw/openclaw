---
name: gog
description: "Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, Docs, Chat, Classroom, Forms, Maps, Meet, YouTube, and more."
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

Quick reference for `gog` — Google Workspace CLI covering Gmail, Calendar, Drive, Contacts, Sheets, Docs, Chat, Classroom, Forms, Maps, Meet, YouTube, and more. Requires OAuth setup.

> **Full command reference**: https://github.com/openclaw/gogcli/blob/main/docs/commands/README.md
> **Community skill (ClawHub)**: https://clawhub.ai/
> Run `gog <command> --help` for the most current flags and options.

Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets,chat,classroom,forms,maps,meet,youtube`
- `gog auth list`
- Use service account: `gog auth service-account /path/to/service-account.json --impersonate admin@domain.com`

## Gmail

- Search threads: `gog gmail search 'newer_than:7d' --max 10`
- Search per-email: `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Send draft: `gog gmail drafts send <draftId>`
- Reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Watch (PubSub): `gog gmail watch <topicName>`
- Filters export: `gog gmail filters export --format xml`
- Delegates: `gog gmail delegates list --account you@example.com`
- Send-as: `gog gmail sendas list`
- Auto-forwarding: `gog gmail forwarding list`

## Google Calendar

- List events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Show colors: `gog calendar colors`
- Create calendar: `gog calendar create-calendar "Team Events"`
- Delete calendar: `gog calendar delete-calendar <calendarId>`
- Subscribe: `gog calendar subscribe <calendarId>`
- Focus time: `gog calendar create <calendarId> --summary "Focus" --from <iso> --to <iso> --focus-time`
- Out-of-office: `gog calendar create <calendarId> --summary "OOO" --from <iso> --to <iso> --out-of-office`
- Move events: `gog calendar move <eventId> --target <targetCalendarId>`

Calendar Colors

- Use `gog calendar colors` to see all available event colors (IDs 1-11)
  - 1: #a4bdfc 2: #7ae7bf 3: #dbadff 4: #ff887c 5: #fbd75b
  - 6: #ffb878 7: #46d6db 8: #e1e1e1 9: #5484ed 10: #51b749 11: #dc2127

## Google Drive

- Search: `gog drive search "query" --max 10`
- Download: `gog drive download <fileId> --out /tmp/file`
- Upload: `gog drive upload /path/to/file --name "File" --mime-type "text/plain"`
- List: `gog drive ls [folderId]`
- Tree (audit): `gog drive tree <folderId>`
- Disk usage: `gog drive du <folderId>`
- Sharing audit: `gog drive sharing-audit <folderId>`
- Bulk public removal: `gog drive remove-public <folderId>`
- Drive Labels: `gog drive labels list`
- Changes/watch: `gog drive changes start --watch <webhookUrl>`
- Activity: `gog drive activity <fileId>`
- Revision history: `gog drive revisions list <fileId>`
- Shared drives: `gog drive shared-drives list`
- Raw API: `gog drive raw <method> <path>`

## Google Sheets

- Get range: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Metadata: `gog sheets metadata <sheetId> --json`
- Conditional formatting: `gog sheets conditional-format <sheetId> --json '{"ranges":[...]}'`
- Data validation: `gog sheets data-validation <sheetId> --json '{"rule":{...}}'`
- Charts: `gog sheets charts <sheetId>`
- Merged cells: `gog sheets merged-cells <sheetId>`
- Named ranges: `gog sheets named-ranges <sheetId>`

## Google Docs

- Export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Cat: `gog docs cat <docId>`
- Tabs: `gog docs tabs <docId>`
- Named ranges: `gog docs named-ranges <docId>`
- Images: `gog docs images <docId>`
- Smart chips: `gog docs smart-chips <docId>`

## Google Chat

- Send message: `gog chat send --space <spaceId> --text "Hello"`
- List spaces: `gog chat spaces list --max 20`
- Read messages: `gog chat messages list --space <spaceId> --max 10`
- Create thread: `gog chat send --space <spaceId> --text "Thread start" --thread`
- Reply in thread: `gog chat send --space <spaceId> --thread <threadKey> --text "Reply"`
- Direct messages: `gog chat dms list`

## Google Classroom

- List courses: `gog classroom courses list --max 20`
- Coursework: `gog classroom coursework list --course <courseId>`
- Submissions: `gog classroom submissions list --course <courseId> --work <workId>`
- Announcements: `gog classroom announcements list --course <courseId>`
- Roster: `gog classroom roster <courseId>`

## Google Forms

- List forms: `gog forms list --max 10`
- Get form: `gog forms get <formId> --json`
- Create form: `gog forms create --title "Survey"`
- Responses: `gog forms responses list <formId> --json`
- Watch: `gog forms watch <formId> --webhook <webhookUrl>`

## Google Maps / Places

- Places search: `gog maps places search "coffee shops near me" --max 5`
- Place details: `gog maps places details <placeId>`
- Geocode: `gog maps geocode "1600 Amphitheatre Parkway, Mountain View, CA"`
- Reverse geocode: `gog maps reverse-geocode "37.422,-122.084"`
- Directions: `gog maps directions "Mountain View, CA" "San Francisco, CA"`
- Distance matrix: `gog maps distance-matrix "Mountain View, CA" "San Francisco, CA" --mode transit`

## Google Meet

- Create conference: `gog meet create --summary "Team Standup"`
- List conferences: `gog meet list --max 10`
- Participants: `gog meet participants <conferenceId>`
- Recordings: `gog meet recordings list`

## YouTube

- Search: `gog youtube search "openclaw tutorial" --max 10`
- Channel info: `gog youtube channels <channelId>`
- Playlist items: `gog youtube playlist <playlistId>`
- Comments: `gog youtube comments <videoId>`

## Contacts & People

- List: `gog contacts list --max 20`
- Directory contacts: `gog contacts directory list --max 20`
- Other contacts: `gog contacts other list --max 20`
- Deduplicate: `gog contacts dedupe`
- VCard export: `gog contacts export --format vcf --out /tmp/contacts.vcf`
- My profile: `gog people me --json`

## Other Services

- Google Slides: `gog slides get <slideId> --json`
- Google Sites: `gog sites list --max 10`
- Google Tasks: `gog tasks lists --json`
- Google Keep: `gog keep list --max 10`
- Google Photos: `gog photos list --max 20`
- Google Analytics: `gog analytics properties list`
- Search Console: `gog searchconsole search-analytics <siteUrl> --json`
- Apps Script: `gog appscript list --json`

## gog MCP Server

- Start MCP server: `gog mcp` (runs a typed, allowlisted MCP server over stdio)
- Schema: `gog schema` (machine-readable command/flag schema)

## Backup & Shell

- Encrypted backup: `gog backup create --out /tmp/backup.gpg`
- Restore backup: `gog backup restore /tmp/backup.gpg`
- Verify backup: `gog backup verify /tmp/backup.gpg`
- Generate shell completions:
  - Bash: `gog completion bash > /usr/local/share/bash-completion/completions/gog`
  - Zsh: `gog completion zsh > /usr/local/share/zsh/site-functions/_gog`
  - Fish: `gog completion fish > ~/.config/fish/completions/gog.fish`

## Aliases

- `gog login` → `gog auth add`
- `gog logout` → `gog auth remove`
- `gog ls` → `gog drive ls`
- `gog me` → `gog people me`
- `gog search` → `gog drive search`
- `gog send` → `gog gmail send`
- `gog status` → `gog auth status`
- `gog upload` → `gog drive upload`
- `gog download` → `gog drive download`

Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. Use heredoc or `$'Line 1\n\nLine 2'` for inline newlines.
- Use `--body-html` only for rich formatting.
- HTML tags: `<p>` paragraphs, `<br>` line breaks, `<strong>` bold, `<em>` italic, `<a href="url">` links, `<ul>`/`<li>` lists.
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

Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` for individual emails.
- For the complete command reference, visit: https://github.com/openclaw/gogcli/blob/main/docs/commands/README.md
- Community gog skill on ClawHub: https://clawhub.ai/
