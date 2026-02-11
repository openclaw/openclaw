---
name: dj-gmail
description: Triage Gmail inbox — view unread, search, read threads, archive, label, and draft replies.
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["gog"] },
        "commands":
          [
            { "name": "inbox", "description": "Show unread emails grouped by sender" },
            { "name": "mail", "description": "Search, read, archive, label, or draft emails" },
          ],
      },
  }
---

# dj-gmail

Triage Gmail inbox, search threads, read messages, and take actions (archive, label, draft replies).

## Commands

- `/inbox` — Show unread emails (default: 20 most recent)
- `/inbox today` — Only today's unread
- `/mail search <query>` — Search with Gmail query syntax
- `/mail read <threadId>` — Show full thread content
- `/mail archive <threadId>` — Remove from inbox
- `/mail label <threadId> <labelName>` — Apply a label
- `/mail labels` — List available labels
- `/mail draft <recipient> <subject>` — Draft a reply for approval

## Implementation

### Listing Unread Emails

```bash
gog gmail search "is:unread" --json --max 20
```

Output is JSON with `threads[]` array. Each thread has: `id`, `date`, `from`, `subject`, `labels[]`, `messageCount`.

Format output grouped by sender:

```
📧 Inbox — 7 unread

boss@company.com (3 threads)
  • Re: Q1 Budget Review — Feb 11 12:32 [IMPORTANT]
    id: 19c4dc29728c2b19
  • Project kickoff — Feb 10 09:15
    id: 19c4da69414fa4d7

client@agency.com (2 threads)
  • Final deliverables — Feb 11 10:00 [has attachment]
    id: 19c4da69414fa4d8

newsletter@techcrunch.com (2 threads)
  • TechCrunch Daily — Feb 11 [PROMOTIONS]
    id: 19c4da69414fa4d9
```

For `/inbox today`, add `after:YYYY/MM/DD` to the query (use today's date).

### Searching

```bash
gog gmail search "<query>" --json --max 20
```

Gmail query syntax:
- `is:unread`, `is:read`, `is:starred`
- `from:<email>`, `to:<email>`
- `subject:<text>`
- `has:attachment`
- `label:<name>` (e.g., `label:work`)
- `before:YYYY/MM/DD`, `after:YYYY/MM/DD`
- `newer_than:2d`, `older_than:1w`
- Combine with spaces (AND): `from:boss is:unread has:attachment`

### Reading a Thread

```bash
gog gmail get <threadId> --json
```

Display: sender, date, subject, body text (truncated if very long). For multi-message threads, show each message in order.

### Archiving

```bash
gog gmail labels modify <threadId> --remove INBOX
```

Confirm to user: "Archived thread <subject> from <sender>."

### Labeling

```bash
gog gmail labels modify <threadId> --add "<labelName>"
```

### Listing Labels

```bash
gog gmail labels list --json
```

### Drafting Replies

When asked to draft a reply:
1. Read the thread with `gog gmail get <threadId>`
2. Compose a contextual reply based on the thread content and user's instructions
3. Present the draft to the user for approval
4. Do NOT send until the user explicitly approves

## Privacy

- Only show sender name and subject in triage view (not body text)
- Only fetch full message body when user explicitly requests `/mail read`
- Never auto-forward email content to other channels
- Draft replies require explicit user approval before sending

## Notes

- Thread IDs are stable — you can reference them across commands
- `gog gmail search` returns threads (conversations), not individual messages
- Labels are case-sensitive
- Gmail has built-in labels: INBOX, SENT, TRASH, SPAM, DRAFT, STARRED, IMPORTANT, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS
