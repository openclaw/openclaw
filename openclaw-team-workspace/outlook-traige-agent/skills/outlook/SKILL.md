# Outlook Email Triage Skill

Reference for Outlook bash scripts. Load this skill when reading or threading emails.

## Scripts

All scripts are in `skills/outlook/`.

### outlook-mail.sh (READ-ONLY)

- `outlook-mail.sh read <id>` — Read full email: subject, from, to, cc, bcc, date, body
- `outlook-mail.sh thread <id>` — View full conversation thread (inbox + sent sides)
- `outlook-mail.sh attachments <id>` — List attachments with name, size, and contentType
- `outlook-mail.sh download <id> <attachment-name> <output-dir>` — Download attachment by name (NOT id) to output directory. Example: `download "GTWCAAAAWb3GXgAAAA==" "circular.png" "./attachments/"`

**NEVER use:** send, reply, forward, delete, move, archive, mark-read, mark-unread, flag, draft, or any write command.

## Reading Workflow

1. Always run `skills/outlook/outlook-mail.sh read <id>` first
2. If subject starts with `Re:` or `Fwd:`, or body contains quoted content, run `skills/outlook/outlook-mail.sh thread <id>`
3. Pass full content to classification

```

```
