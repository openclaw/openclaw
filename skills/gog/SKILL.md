---
name: gog
description: "Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, Docs, Slides, Forms, Chat, Classroom, Maps, YouTube, Meet, Keep, Tasks, Photos, Analytics, Search Console, Sites, Admin, Backup, and more."
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

Use `gog` for Google Workspace. Requires OAuth setup. Use `gog --help` and `gog <command> --help` for the most current flags and options, as the CLI evolves rapidly.

## Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,docs,sheets,contacts`
- `gog auth list`
- `gog auth doctor --check`
- To avoid 7-day token expiry: publish the OAuth app (Google Cloud Console → Auth Platform → Audience → "Publish"), then re-authorize with `--force-consent`.
- Account selection: `export GOG_ACCOUNT=you@gmail.com` or `--account <email>`

## Auth & Credentials

```
gog auth add                   Authorize and store a refresh token
gog auth alias list|set|unset  Manage account aliases
gog auth credentials set|list|remove  Manage OAuth client credentials
gog auth doctor                Diagnose auth, keyring, and token issues
gog auth import                Non-interactive token import
gog auth keep                  Configure service account for Google Keep
gog auth keyring               Configure keyring backend
gog auth list                  List stored accounts
gog auth manage                Open interactive accounts manager in browser
gog auth remove                Remove a stored refresh token
gog auth service-account set|status|unset  Service account management
gog auth services              List supported auth services and scopes
gog auth status                Show auth config and keyring backend
gog auth tokens list|export|import|delete  Token management
```

Aliases: `gog login` → `auth add`, `gog logout` → `auth remove`, `gog status` → `auth status`

## Keyring for headless/container

```bash
GOG_KEYRING_BACKEND=file GOG_KEYRING_PASSWORD=... gog auth list --check
```

## Gmail

Common commands:
- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:example.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`

Full command tree:
```
gog gmail
├── archive                     Archive messages or threads
├── attachment                  Download a single attachment
├── autoreply                   Reply once to matching messages
├── batch delete|modify         Batch operations on messages
├── drafts create|delete|get|list|send|update  Draft management
├── forward                     Forward a message
├── get                         Get a message (full|metadata|raw)
├── history                     Gmail history
├── labels create|delete|get|list|modify|rename|style  Label management
├── mark-read                   Mark messages as read
├── messages modify|search      Per-message operations (ignores threading)
├── raw                         Dump raw API response as JSON
├── reply                       Reply to a message
├── reply-all                   Reply to all participants
├── search                      Search threads using Gmail query syntax
├── send                        Send an email
├── settings autoforward get|update  Auto-forwarding settings
├── settings delegates add|get|list|remove  Delegate management
├── settings filters create|delete|export|get|list  Filter management
├── settings forwarding create|delete|get|list  Forwarding addresses
├── settings sendas create|delete|get|list|update|verify  Send-as aliases
├── settings vacation get|update  Vacation responder
├── settings watch pull|renew|serve|start|status|stop  Gmail watch/PubSub
├── thread attachments          List thread attachments
├── thread get                  Get thread with all messages
├── thread modify               Modify labels on thread
├── track key rotate            Rotate tracking encryption key
├── track opens                 Query email opens
├── track setup                 Set up email tracking (Cloudflare Worker)
├── track status                Show tracking config
├── trash                       Move messages to trash
├── unread                      Mark messages as unread
└── url                         Print Gmail web URLs for threads
```

To block sends during automation: `--gmail-no-send` flag or `GOG_GMAIL_NO_SEND=1`.

## Calendar

Common commands:
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`
- Calendar show colors: `gog calendar colors`
- Calendar events today: `gog calendar events --today`
- Calendar move event: `gog calendar move primary <eventId> team-calendar@example.com`
- Calendar create-calendar: `gog calendar create-calendar "Project calendar" --timezone Europe/London`
- Calendar subscribe: `gog calendar subscribe en.uk#holiday@group.v.calendar.google.com`
- Calendar add Meet: `gog calendar update primary <eventId> --with-meet`

Full command tree:
```
gog calendar
├── acl                         List calendar ACL
├── alias list|set|unset        Calendar alias management
├── calendars                   List calendars
├── colors                      Show calendar colors
├── conflicts                   Find busy-time overlaps
├── create                      Create an event
├── create-calendar             Create a new secondary calendar
├── delete                      Delete an event
├── delete-calendar             Delete an owned secondary calendar
├── event                       Get event
├── events                      List events (with --today, --from/--to)
├── focus-time                  Create a Focus Time block
├── freebusy                    Get free/busy
├── move                        Move an event to another calendar
├── out-of-office               Create an Out of Office event
├── propose-time                Generate URL to propose new meeting time
├── raw                         Dump raw API response as JSON
├── respond                     Respond to event invitation
├── search                      Search events
├── subscribe                   Add calendar to your calendar list
├── team                        Show events for Workspace group members
├── time                        Show server time
├── unsubscribe                 Remove calendar from your calendar list
├── update                      Update an event
├── users                       List workspace users
└── working-location            Set working location (home/office/custom)
```

Calendar Colors (IDs 1-11):
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

## Drive

Common commands:
- Drive search: `gog drive search "query" --max 10`
- Drive tree: `gog drive tree --parent <folderId> --depth 2`
- Drive du: `gog drive du --parent <folderId> --max 20 --json`
- Drive audit sharing: `gog drive audit sharing --parent <folderId> --internal-domain example.com --json`
- Drive share: `gog drive share <fileId> --to user --email person@example.com --notify --dry-run`
- Drive upload: `gog drive upload ./file.txt --parent <folderId>`
- Drive download: `gog drive download <fileId> --out ./file.txt`
- Drive copy: `gog drive copy <fileId>`
- Drive ls: `gog drive ls --parent <folderId>`

Full command tree:
```
gog drive
├── activity query              Query Drive Activity API v2
├── audit sharing|user          Find public/external/user permissions
├── bulk remove-public|update-role  Batch permission changes
├── changes list|poll|serve|start-token|stop|watch  Change tracking
├── comments create|delete|get|list|reopen|reply|resolve|update  Comment management
├── copy                        Copy a file
├── delete                      Move to trash (--permanent to delete forever)
├── download                    Download (exports Google Docs formats)
├── drives                      List shared drives
├── du                          Summarize folder sizes
├── get                         Get file metadata
├── inventory                   Export read-only Drive inventory
├── labels file apply|list|remove  Manage Drive labels on files
├── labels get|list             Drive label schema
├── ls                          List files in a folder
├── mkdir                       Create a folder
├── move                        Move to a different folder
├── permissions                 List permissions
├── raw                         Dump raw API response as JSON
├── rename                      Rename file or folder
├── revisions get|list          Revision management
├── search                      Full-text search
├── share                       Share file or folder
├── shortcut create             Create shortcut
├── tree                        Print folder tree
├── unshare                     Remove permission
├── upload                      Upload file
└── url                         Print web URLs
```

## Contacts

- `gog contacts list --max 20 --json`
- `gog contacts search alice --json`
- `gog contacts export --all --out contacts.vcf`
- `gog contacts dedupe --match email,phone,name --apply --dry-run --json`

Full command tree:
```
gog contacts
├── create                      Create a contact
├── dedupe                      Find and merge duplicates
├── delete                      Delete a contact
├── directory list|search       Workspace directory
├── export                      Export as vCard (.vcf)
├── get                         Get a contact
├── list                        List contacts
├── other list|search           Other contacts
├── raw                         Dump raw API response as JSON
├── search                      Search by name/email/phone
└── update                      Update a contact
```

## Sheets

- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Sheets batch-update: `gog sheets batch-update <sheetId> --data-json @updates.json`

Full command tree:
```
gog sheets
├── add-tab                     Add a new tab/sheet
├── append                      Append values to a range
├── banding clear|list|set      Alternating color banding
├── batch-update                Update multiple ranges
├── chart create|delete|get|list|update  Chart management
├── clear                       Clear values in a range
├── conditional-format add|clear|list  Conditional formatting
├── copy                        Copy a spreadsheet
├── copy-paste                  Copy range values/formulas/format
├── create                      Create a new spreadsheet
├── delete-dimension            Delete rows/columns
├── delete-tab                  Delete a tab/sheet
├── export                      Export (pdf|xlsx|csv) via Drive
├── find-replace                Find and replace text
├── format                      Apply cell formatting
├── freeze                      Freeze rows/columns
├── get                         Get values from a range
├── insert                      Insert empty rows/columns
├── links get|set               Cell hyperlinks
├── merge                       Merge cells
├── metadata                    Get spreadsheet metadata
├── named-ranges add|delete|get|list|update  Named range management
├── notes                       Get cell notes
├── number-format               Apply number format
├── raw                         Dump raw API response as JSON
├── read-format                 Read cell formatting
├── rename-tab                  Rename a tab
├── reorder-tab                 Move a tab
├── resize-columns              Resize columns
├── resize-rows                 Resize rows
├── table append|clear|create|delete|get|list  Table management
├── unmerge                     Unmerge cells
├── update                      Update values in a range
├── update-note                 Set/clear cell note
└── validation clear|get|set    Data validation rules
```

## Docs

- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`
- Docs write: `gog docs write <docId> --append --markdown --text '## Status'`
- Docs format: `gog docs format <docId> --match Status --bold --font-size 18`
- Docs find-replace: `gog docs find-replace <docId> old new --dry-run`
- Docs insert-table: `gog docs insert-table <docId> --rows 3 --cols 2 --at-end`
- Docs insert-page-break: `gog docs insert-page-break <docId> --at-end`
- Docs comments poll: `gog docs comments poll <docId> --state-file ~/.local/state/gog/doc-comments.json --json`

Full command tree:
```
gog docs
├── add-tab                     Add a tab
├── cat                         Print as plain text
├── cell-style                  Table cell styling
├── cell-update                 Replace/append in table cell
├── clear                       Clear all content
├── comments add|delete|get|list|locate|poll|reopen|reply|resolve  Comment management
├── copy                        Copy a document
├── create                      Create a document
├── delete                      Delete text range
├── delete-tab                  Delete a tab
├── edit                        Find and replace text
├── export                      Export (pdf|docx|txt|md|html)
├── find-range                  Find text and print index ranges
├── find-replace                Find/replace (supports markdown with images)
├── format                      Apply text/paragraph formatting
├── headings list               List heading paragraphs
├── images list                 List images
├── info                        Get document metadata
├── insert                      Insert text at position
├── insert-date-chip            Insert native date chip
├── insert-file-chip            Insert native Drive file chip
├── insert-image                Insert image (URL or local)
├── insert-page-break           Insert page break
├── insert-person               Insert person chip
├── insert-table                Insert table
├── list-tabs                   List tabs
├── named-range create|delete|list|replace  Named ranges
├── page-layout                 Set page layout (pageless|pages)
├── paragraphs list             List paragraphs
├── raw                         Dump raw API response as JSON
├── rename-tab                  Rename a tab
├── sed                         Regex find/replace (sed-style)
├── structure                   Show document structure
├── table-column delete|insert  Table column operations
├── table-column-width          Set/reset column widths
├── table-merge                 Merge table cell range
├── table-row delete|insert     Table row operations
├── table-unmerge               Unmerge table cells
├── tables list                 List tables
├── tabs add|delete|list|rename Tab management
├── update                      Insert/replace text
└── write                       Write content (--append, --markdown)
```

## Classroom

```
gog classroom
├── announcements assignees|create|delete|get|list|update  Announcement management
├── courses archive|create|delete|get|join|leave|list|unarchive|update|url  Course management
├── coursework assignees|create|delete|get|list|update  Coursework management
├── guardian-invitations create|get|list  Guardian invitations
├── guardians delete|get|list  Guardian management
├── invitations accept|create|delete|get|list  Invitation management
├── materials create|delete|get|list|update  Coursework materials
├── profile get                Get user profile
├── roster                     Course roster (students + teachers)
├── students add|get|list|remove  Student management
├── submissions get|grade|list|reclaim|return|turn-in  Submission management
├── teachers add|get|list|remove  Teacher management
└── topics create|delete|get|list|update  Topic management
```

## Chat

```
gog chat
├── dm send|space              Direct messages
├── messages list|react|reactions|send  Message management
├── spaces create|find|list    Space management
└── threads list               Thread listing
```

## Maps

- Places search: `gog maps places search "Elysian Coffee Vancouver" --json`
- Directions: `gog maps directions --origin "Vancouver, BC" --destination "Seattle, WA" --json`
- Geocode: `gog maps geocode "1600 Amphitheatre Parkway, Mountain View, CA" --json`

```
gog maps
├── directions                  Get directions
├── distance                    Travel distance/duration matrix
├── geocode                     Address to coordinates
├── places details|search       Place details and search
└── reverse-geocode             Coordinates to address
```

## YouTube

- Requires API key: `gog config set youtube_api_key YOUR_API_KEY`
- Popular videos: `gog yt videos list --chart mostPopular --region US --max 5`
- Channel info: `gog yt channels list --id UC_x5X1GOV2P6uZZ5FSM9Ttw --json`
- Writes need OAuth with `youtube.force-ssl` scope: `gog auth add you@gmail.com --services youtube --extra-scopes https://www.googleapis.com/auth/youtube.force-ssl --force-consent`

```
gog youtube
├── activities list             Channel activities
├── channels list               Channel info by ID or auth user
├── comments list               Comment threads
├── playlists add|create|delete|items|list|remove  Playlist management
├── search list                 Search videos/channels/playlists
├── subscriptions list|subscribe|unsubscribe  Subscription management
└── videos list                 List videos by ID/chart/rating
```

## Slides

- Create from markdown: `gog slides create-from-markdown "Weekly update" --content-file slides.md`
- Info: `gog slides info <presentationId> --json`
- New slide: `gog slides new-slide <presentationId> --layout TITLE_AND_BODY --index 1`
- Replace text: `gog slides replace-text <presentationId> old new --object <objectId>`
- Duplicate slide: `gog slides duplicate-slide <presentationId> <slideId> --to-index 2`
- Table: `gog slides table create <presentationId> <slideId> --rows 2 --cols 3`
- Export: `gog slides export <presentationId> --format pdf --out pres.pdf`

Full command tree: add-slide, bullets, copy, create, create-from-markdown, create-from-template, delete-slide, duplicate-slide, element (alt-text, create-line, create-shape, delete, group, style, transform, ungroup, z-order), export, info, insert-image, insert-text, link, list-slides, locate, move-slide, new-slide, raw, read-slide, replace-slide, replace-text, style-text, table (border/style, cell/style, column/delete/insert/size, create, merge, row/delete/insert/size, unmerge), thumbnail, update-notes.

## Forms

- Add question: `gog forms add-question <formId> --title "What is 2+2?" --type radio -o 1 -o 4 --correct 4 --points 1`
- Responses: `gog forms responses list <formId> --json`

```
gog forms
├── add-question                Add a question
├── create                      Create a form
├── delete-question             Delete a question by index
├── get                         Get a form
├── move-question               Move question to new position
├── publish                     Publish/unpublish
├── questions add|delete|move   Question management
├── raw                         Dump raw API response as JSON
├── responses get|list          Form responses
├── update                      Update title/description/settings
└── watch create|delete|list|renew  Watch for new responses
```

## Meet

```
gog meet
├── create                      Create meeting space
├── end                         End active conference
├── get                         Get meeting space
├── history                     List past calls
├── participants                List participants from latest call
└── update                      Update space config
```

## Tasks

```
gog tasks
├── add                         Add a task
├── clear                       Clear completed tasks
├── delete                      Delete a task
├── done                        Mark task completed
├── get                         Get a task
├── list                        List tasks
├── lists create|list           Task list management
├── raw                         Dump raw API response as JSON
├── undo                        Mark task needs action
└── update                      Update a task
```

## Photos

Only app-created media accessible via Library API:
```
gog photos
├── download                    Download media item
├── get                         Get media item
├── list                        List media items
├── picker create|delete|download|get|list|wait  Photo-picking sessions
└── search                      Search media items
```

## Keep

```
gog keep
├── attachment                  Download attachment
├── create                      Create note
├── delete                      Delete note
├── get                         Get note
├── list                        List notes
└── search                      Search notes by text
```

## Analytics

- `gog analytics accounts --all --json`
- `gog analytics report 123456789 --from 7daysAgo --to today --dimensions date,country --metrics activeUsers,sessions`

## Search Console

- `gog searchconsole query sc-domain:example.com --from 2026-02-01 --to 2026-02-07 --dimensions query,page`
- `gog searchconsole sitemaps submit sc-domain:example.com https://example.com/sitemap.xml --force`

## Sites

```
gog sites
├── get                         Get site metadata
├── list                        List sites visible in Drive
├── search                      Search sites
└── url                         Print editor URLs
```

## Zoom

```
gog zoom
└── auth doctor|setup           Zoom OAuth credentials
```

## MCP

```
gog mcp                         Run typed, allowlisted MCP server over stdio
```

With allowlist:
```bash
gog --enable-commands-exact mcp,docs.cat,docs.write mcp --allow-write --allow-tool 'docs.*'
```

## Admin (Workspace Directory)

```
gog admin
├── groups list|members add|list|remove  Group management
├── orgunits create|delete|get|list|update  Organizational units
└── users create|delete|get|list|suspend  User management
```

## Backup

```
gog backup
├── cat                         Decrypt one shard to stdout
├── export                      Write local plaintext export
├── gmail push                  Export Gmail into encrypted shards
├── init                        Initialize encrypted backup
├── push                        Export services into encrypted shards
├── status                      Inspect manifest without decrypting
└── verify                      Decrypt and verify all shards
```

## Apps Script

```
gog appscript
├── content                     Get project content
├── create                      Create project
├── get                         Get project metadata
└── run                         Run deployed function
```

## Batch

```
gog batch
├── abort                       Delete batch without submitting
├── begin                       Begin persisted request batch
├── end                         Submit and remove batch
├── list                        List persisted batches
├── prune                       Delete stale batches
└── show                        Show persisted batch
```

## Config

```
gog config
├── get                         Get config value
├── keys                        List available config keys
├── list                        List all config values
├── no-send list|remove|set     Block Gmail send per account
├── path                        Print config file path
├── set                         Set config value
└── unset                       Unset config value
```

## Other commands

- `gog completion` — Shell completion scripts
- `gog open` — Print web URL for a Google URL/ID
- `gog schema` — Machine-readable command/flag schema
- `gog time now` — Show current time
- `gog version` — Print version
- `gog people get|me|raw|relations|search` — People/Directory API
- `gog groups list|members` — Cloud Identity Groups

## Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.

## Important Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy/write. Rich editing via Docs API is fully supported.
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.
- Prefer `gog --help` and `gog <command> --help` for the most current flags.
- Key environment variables: `GOG_ACCOUNT`, `GOG_KEYRING_BACKEND`, `GOG_KEYRING_PASSWORD`, `GOG_HOME`, `GOG_GMAIL_NO_SEND`, `GOG_WRAP_UNTRUSTED`, `GOG_ENABLE_COMMANDS_EXACT`.
- Enable APIs in the same Google Cloud project as your OAuth client. If `accessNotConfigured`, enable the API and wait for propagation.
- Never commit OAuth client JSON files, refresh tokens, service-account keys, or file-keyring passwords.
- Drive Labels require a Google Workspace customer.
