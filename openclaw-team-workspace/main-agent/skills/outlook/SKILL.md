---
name: outlook
description: Read, search, and manage Outlook emails and calendar via Microsoft Graph API. Use when the user asks about emails, inbox, Outlook, Microsoft mail, calendar events, scheduling, or looking up people and contacts within the organization via Outlook directory.
version: 1.4.0
author: jotamed
---

# Outlook Skill

Access Outlook/Hotmail email and calendar via Microsoft Graph API using OAuth2.

## Quick Setup (Automated)

```bash
# Requires: Azure CLI, jq
./scripts/outlook-setup.sh
```

The setup script will:

1. Log you into Azure (device code flow)
2. Create an App Registration automatically
3. Configure API permissions (Mail.ReadWrite, Mail.Send, Calendars.ReadWrite)
4. Guide you through authorization
5. Save credentials to `~/.outlook-mcp/`

## Manual Setup

See `references/setup.md` for step-by-step manual configuration via Azure Portal.

## Usage

### Token Management

```bash
./scripts/outlook-token.sh refresh  # Refresh expired token
./scripts/outlook-token.sh test     # Test connection
./scripts/outlook-token.sh get      # Print access token
```

### Reading Emails (Inbox/Received)

````bash
./scripts/outlook-mail.sh inbox [count]                           # List received emails (inbox only)
./scripts/outlook-mail.sh unread [count]                          # List unread emails (inbox only)
./scripts/outlook-mail.sh focused [count]                         # Focused/important inbox
./scripts/outlook-mail.sh other [count]                           # Other/low-priority inbox
./scripts/outlook-mail.sh from <email> [count]                    # Emails from sender (inbox only)
./scripts/outlook-mail.sh read <id>                               # Read email content
./scripts/outlook-mail.sh attachments <id>                        # List email attachments
./scripts/outlook-mail.sh download <email-id> <attachment-name> <output-dir>   # Download attachment — use 'name' field from attachments output (NOT attachment id)```

### Sent Emails
```bash
./scripts/outlook-mail.sh sent [count]            # List sent emails
./scripts/outlook-mail.sh to <email> [count]      # Sent emails to a specific recipient
````

### Searching Emails

Always use the folder-scoped search that matches where the email lives:

```bash
./scripts/outlook-mail.sh search "query" [count]         # Search inbox (received emails only)
./scripts/outlook-mail.sh search-sent "query" [count]    # Search sent items
./scripts/outlook-mail.sh search-drafts "query" [count]  # Search drafts
./scripts/outlook-mail.sh search-deleted "query" [count] # Search deleted items
./scripts/outlook-mail.sh search-all "query" [count]     # Search ALL folders (use only when folder is unknown)
./scripts/outlook-mail.sh thread <id>                    # View thread (shows inbox + sent)
```

### Managing Emails

```bash
./scripts/outlook-mail.sh mark-read <id>          # Mark as read
./scripts/outlook-mail.sh mark-unread <id>        # Mark as unread
./scripts/outlook-mail.sh flag <id>               # Flag as important
./scripts/outlook-mail.sh unflag <id>             # Remove flag
./scripts/outlook-mail.sh delete <id>             # Move to trash
./scripts/outlook-mail.sh archive <id>            # Move to archive
./scripts/outlook-mail.sh move <id> <folder>      # Move to folder
```

### Drafts and Sending them

```bash
./scripts/outlook-mail.sh draft <to> <subj> <body> [cc] [bcc]                       # Create new draft for review (not sent)
./scripts/outlook-mail.sh reply-draft <id> "body" [cc] [bcc]                        # Create reply draft for review (not sent)
./scripts/outlook-mail.sh draft-attachment <to> <subj> <body> <file> [cc] [bcc]     # Create draft with attachment (not sent)
./scripts/outlook-mail.sh reply-draft-attachment <id> "body" <file> [cc] [bcc]      # Create reply draft with attachment (not sent)
./scripts/outlook-mail.sh drafts [count]                                            # List drafts
./scripts/outlook-mail.sh send-draft <id>                                           # Send a reviewed draft
```

### Folders & Stats

```bash
./scripts/outlook-mail.sh folders                          # List mail folders
./scripts/outlook-mail.sh stats                            # Inbox statistics
./scripts/outlook-mail.sh create-folder <name> [parent]    # Create folder
./scripts/outlook-mail.sh delete-folder <name>             # Delete folder
./scripts/outlook-mail.sh categories                       # List categories
```

### Bulk Operations

```bash
./scripts/outlook-mail.sh bulk-read <id1> <id2>...    # Mark multiple as read
./scripts/outlook-mail.sh bulk-delete <id1> <id2>...  # Delete multiple
```

## Calendar

### Viewing Events

```bash
./scripts/outlook-calendar.sh events [count]      # List upcoming events
./scripts/outlook-calendar.sh today               # Today's events
./scripts/outlook-calendar.sh week                # This week's events
./scripts/outlook-calendar.sh read <id>           # Event details
./scripts/outlook-calendar.sh calendars           # List all calendars
./scripts/outlook-calendar.sh availability <email> [date]  # Check person's calendar availability (default: today)"
```

### Creating Events

```bash
./scripts/outlook-calendar.sh create <subj> <start> <end> <attendees> [location] # Create event (attendees: comma-separated emails, append :optional for optional attendees e.g. "a@b.com,c@d.com:optional")
```

### Managing Events

```bash
./scripts/outlook-calendar.sh update <id> [subject=val] [location=val] [start=val] [end=val] [body=val] [attendees=email1,email2:optional]  # Update event (multiple fields supported)
./scripts/outlook-calendar.sh cancel <id>                  # Cancel event (sends cancellation to attendees)
```

## Lookup

### Contacts Lookup

```bash
./scripts/outlook-lookup.sh get-profile <name-or-email>    # Look up a person's details using their names or email address
./scripts/outlook-lookup.sh designation <designation>      # Look up a person's details using their designation
```

Date format: `YYYY-MM-DDTHH:MM` (e.g., `2026-01-26T10:00`)

### Example Output

```bash
$ ./scripts/outlook-mail.sh inbox 3

{
  "n": 1,
  "subject": "Your weekly digest",
  "from": "digest@example.com",
  "date": "2026-01-25T15:44",
  "read": false,
  "id": "icYY6QAIUE26PgAAAA=="
}
{
  "n": 2,
  "subject": "Meeting reminder",
  "from": "calendar@outlook.com",
  "date": "2026-01-25T14:06",
  "read": true,
  "id": "icYY6QAIUE26PQAAAA=="
}

$ ./scripts/outlook-mail.sh read "icYY6QAIUE26PgAAAA=="

{
  "subject": "Your weekly digest",
  "from": { "name": "Digest", "address": "digest@example.com" },
  "to": ["you@hotmail.com", "colleague@example.com"],
  "cc": ["manager@example.com"],
  "bcc": [],
  "date": "2026-01-25T15:44:00Z",
  "body": "Here's what happened this week..."
}

$ ./scripts/outlook-mail.sh stats

{
  "folder": "Inbox",
  "total": 14098,
  "unread": 2955
}

$ ./scripts/outlook-calendar.sh today

{
  "n": 1,
  "subject": "Team standup",
  "start": "2026-01-25T10:00",
  "end": "2026-01-25T10:30",
  "location": "Teams",
  "id": "AAMkAGQ5NzE4YjQ3..."
}

$ ./scripts/outlook-calendar.sh create "Lunch with client" "2026-01-26T13:00" "2026-01-26T14:00" "client@example.com,colleague@example.com:optional" "Restaurant"

{
  "status": "event created",
  "subject": "Lunch with client",
  "start": "2026-01-26T13:00:00.0000000",
  "end": "2026-01-26T14:00:00.0000000",
  "id": "AAMkAGQ5NzE4YjQ3..."
}
```

## Token Refresh

Access tokens expire after ~1 hour. Refresh with:

```bash
./scripts/outlook-token.sh refresh
```

## Files

- `~/.outlook-mcp/config.json` - Client ID and secret
- `~/.outlook-mcp/credentials.json` - OAuth tokens (access + refresh)

## Permissions

- `Mail.ReadWrite` - Read and modify emails
- `Mail.Send` - Send emails
- `Calendars.ReadWrite` - Read and modify calendar events
- `offline_access` - Refresh tokens (stay logged in)
- `User.Read` - Basic profile info
- `People.Read` - Look up people via People API

## Tool use notes

- **Attachment downloads**: Always download attachments to `./attachments/` (relative to workspace). The directory already exists — use this path with the `download` command.
- **Email IDs**: The `id` field shows the last 20 characters of the full message ID. Use this ID with commands like `read`, `mark-read`, `delete`, etc.
- **Email content formatting**: Always write email body as HTML using
  `<p>` and `<br>` tags for line breaks. Never use `\n` — they will
  appear as literal text. Example: use `<p>Hello</p><p>Regards,</p>`
  not `Hello\n\nRegards,`
- **Folder-scoped search**: Always use the correct folder-scoped search command. Use `search` for received/inbox emails, `search-sent` for sent emails. Only use `search-all` when the folder is genuinely unknown.
- **Numbered results**: Emails are numbered (n: 1, 2, 3...) for easy reference in conversation.
- **Text extraction**: HTML email bodies are automatically converted to plain text.
- **Token expiry**: Access tokens expire after ~1 hour. Run `outlook-token.sh refresh` when you see auth errors.
- **Recent emails**: Commands like `read`, `mark-read`, etc. search the 100 most recent emails for the ID.
- **Reply preference**: When you feel the user wants to reply to an email, prefer `reply-draft` or `reply-draft-attachment` over creating a new draft. This ensures the message is chained in the original thread.
- **Reply recipients**: For replying to emails, ensure to attach same recipients as parent email (the one you are replying to). Use `cc` and `bcc` fields if the original email had them.
- **Designation search limitations:** The `designation` command matches from the start of the job title only. For common titles with variations (e.g. CTO vs "Chief Technical Officer"), try multiple searches.
- **Checking user's availability**: When checking the availability of user, always use their email address rather than "you" or "me".
- **Timezone note:** `availability` and `busySlots` times are returned in IST (India Standard Time). No conversion needed.
- **Working hours:** Working hours are from 10am to 6pm, so stick to it.

## Troubleshooting

**"Token expired"** → Run `outlook-token.sh refresh`

**"Invalid grant"** → Token invalid, re-run setup: `outlook-setup.sh`

**"Insufficient privileges"** → Check app permissions in Azure Portal → API Permissions

**"Message not found"** → The email may be older than 100 messages. Use search to find it first.

**"Folder not found"** → Use exact folder name. Run `folders` to see available folders.

## Supported Accounts

- Personal Microsoft accounts (outlook.com, hotmail.com, live.com)
- Work/School accounts (Microsoft 365) - may require admin consent

## Email Retreival Notes

- When looking for emails using their target's names, if you find multiple matches and are not sure which one is correct, always clarify with user rather than guess.
- Display the 'to' and 'cc' fields ('bcc' field too if getting from user's sent folder), as well as subject and body of the email to the user.
- **Attachment Delivery.** When delivering any file to the user, use exec to run `openclaw.mjs message send` with `--target`, `--media` for the file path, and `--message` for the email summary as the caption. This delivers text and file together in one Telegram message. Do NOT send a separate text reply before or after.

## Email Sending Workflow (same for direct or reply emails, with or without attachments)

If you feel the user wants you to send an email, do these:

1. If user provides just names or designations (not email addresses) and you don't know their email addresses, first lookup their email address, if you find multiple matching email address and are not sure which one they are referring to, always clarify with them by showing the email addresses. (obviously, if the names doesn't match, don't raise, like Tala is not same as Talal)
2. Create a draft using `draft`, `reply-draft`, `draft-attachment`, or `reply-draft-attachment` — include cc/bcc if relevant
3. If you feel the request follows a previous email exchange or references an existing thread, use `reply-draft` or `reply-draft-attachment` to keep the message chained in the thread.
4. Show the draft details to the user for confirmation (to, cc, bcc, attachments, subject, body)
5. ONLY when user confirms, send via `send-draft`.

- **Strict 1:1 Flow.** Confirmation applies ONLY to the single most recent draft created in the current turn. Never batch multiple pending drafts unless explicitly told to "send all."
- Direct send is disabled. The ONLY way to send is via `send-draft` after user confirmation.
- NEVER attempt to send without going through the draft → confirm → send-draft flow.

## Meeting Scheduling workflow

If you feel the user wants you to book a meeting, do these:

1. If user provides just names or designations (not email addresses) and you don't know their email addresses, first lookup their email address, if you find multiple matching email address and are not sure which one they are referring to, always clarify with them by showing the email addresses. (obviously, if the names doesn't match, don't raise, like Tala is not same as Talal)
2. Check availability for ALL parties (including the user). Before proposing a slot, verify that the proposed start and end time do not overlap with any entry in busySlots for any party. Do NOT propose or book a slot if it overlaps with any busySlot.
3. If availability is not there, and start and end are deduced from defaults, try new slots as specified in "Meeting Scheduling defaults" paragraph, if user specified time and duration, inform them that the said slot is unavailable, and recommend 3-4, same duration close-by slots in which availability is there.
4. If availability is there, show the user the slot.
5. NEVER call `outlook-calendar.sh create` (or update event times using `outlook-calendar.sh update`) until the user explicitly confirms with words like "yes", "go ahead", "book it", "confirm". Showing availability and details is NOT confirmation.
6. On receiving confirmation from user to book, check availability for everyone once again (as by the time user confirms, others might get blocked), if available, proceed with booking, if there is a blocker revert back to step 3.

- **Note:** When updating meeting times, check availability of all existing attendees in the new slot first, show results, and only proceed on confirmation. When adding a new attendee to an existing meeting, check their availability for that slot — if free, inform the user and add on confirmation; if busy, inform the user and suggest nearby available slots.
- **Note** Always treat "Tentative" as "busy", they are blocked if they are "Tentative" for the slot.

## Meeting Scheduling defaults

The user at times does not specify many details that might be needed to set a meeting, Hence you assume certain defaults, whose correctness will be evaluated by the user when you show them the availability details.

Date: Today
Subject: Appropriate title you deduced from user conversations or "Meeting with [participant's names]" if user provides standalone meeting request.
Start Time: If date is today's, then 10 minutes after current time. If its any other day, try tomorrow 1pm, it thats unavailable, try 30 minutes before or after.
End Time: 30 minutes after start time.
Duration: 30 minutes default (set start and end time appropriately)

## General Rules and Constraints

- If no contacts tool is available, do not infer contacts from email history. Explicitly tell the user you cannot retrieve contacts directly.
- You are not dumb, meetings cannot be booked in past.
- Don't use escape quotes.
