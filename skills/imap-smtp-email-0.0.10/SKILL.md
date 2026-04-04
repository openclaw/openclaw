---
name: imap-smtp-email
description: Read and send email via IMAP/SMTP. Check for new/unread messages, fetch content, search mailboxes, mark as read/unread, and send emails with attachments. Supports multiple accounts. Works with any IMAP/SMTP server including Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, and vip.188.com.
metadata:
  openclaw:
    emoji: "📧"
    requires:
      bins:
        - node
        - npm
---

# IMAP/SMTP Email Tool

Read, search, and manage email via IMAP protocol. Send email via SMTP. Supports Gmail, Outlook, 163.com, vip.163.com, 126.com, vip.126.com, 188.com, vip.188.com, and any standard IMAP/SMTP server.

## Configuration

Run the setup script to configure your email account:

```bash
bash setup.sh
```

Configuration is stored at `~/.config/imap-smtp-email/.env` (survives skill updates). If no config is found there, the skill falls back to a `.env` file in the skill directory (for backward compatibility).

### Config file format

```bash
# Default account (no prefix)
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
IMAP_USER=your@email.com
IMAP_PASS=your_password
IMAP_TLS=true
IMAP_REJECT_UNAUTHORIZED=true
IMAP_MAILBOX=INBOX

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your@email.com
SMTP_PASS=your_password
SMTP_FROM=your@email.com
SMTP_REJECT_UNAUTHORIZED=true

# File access whitelist (security)
ALLOWED_READ_DIRS=~/Downloads,~/Documents
ALLOWED_WRITE_DIRS=~/Downloads
```

## Multi-Account

You can configure additional email accounts in the same config file. Each account uses a name prefix (uppercase) on all variables.

### Adding an account

Run the setup script and choose "Add a new account":

```bash
bash setup.sh
```

Or manually add prefixed variables to `~/.config/imap-smtp-email/.env`:

```bash
# Work account (WORK_ prefix)
WORK_IMAP_HOST=imap.company.com
WORK_IMAP_PORT=993
WORK_IMAP_USER=me@company.com
WORK_IMAP_PASS=password
WORK_IMAP_TLS=true
WORK_IMAP_REJECT_UNAUTHORIZED=true
WORK_IMAP_MAILBOX=INBOX
WORK_SMTP_HOST=smtp.company.com
WORK_SMTP_PORT=587
WORK_SMTP_SECURE=false
WORK_SMTP_USER=me@company.com
WORK_SMTP_PASS=password
WORK_SMTP_FROM=me@company.com
WORK_SMTP_REJECT_UNAUTHORIZED=true
```

### Using a named account

Add `--account <name>` before the command:

```bash
node scripts/imap.js --account work check
node scripts/smtp.js --account work send --to foo@bar.com --subject Hi --body Hello
```

Without `--account`, the default (unprefixed) account is used.

### Account name rules

- Letters and digits only (e.g., `work`, `163`, `personal2`)
- Case-insensitive: `work` and `WORK` refer to the same account
- The prefix in `.env` is always uppercase (e.g., `WORK_IMAP_HOST`)
- `ALLOWED_READ_DIRS` and `ALLOWED_WRITE_DIRS` are shared across all accounts (always unprefixed)

## Common Email Servers

| Provider    | IMAP Host             | IMAP Port | SMTP Host          | SMTP Port |
| ----------- | --------------------- | --------- | ------------------ | --------- |
| 163.com     | imap.163.com          | 993       | smtp.163.com       | 465       |
| vip.163.com | imap.vip.163.com      | 993       | smtp.vip.163.com   | 465       |
| 126.com     | imap.126.com          | 993       | smtp.126.com       | 465       |
| vip.126.com | imap.vip.126.com      | 993       | smtp.vip.126.com   | 465       |
| 188.com     | imap.188.com          | 993       | smtp.188.com       | 465       |
| vip.188.com | imap.vip.188.com      | 993       | smtp.vip.188.com   | 465       |
| yeah.net    | imap.yeah.net         | 993       | smtp.yeah.net      | 465       |
| Gmail       | imap.gmail.com        | 993       | smtp.gmail.com     | 587       |
| Outlook     | outlook.office365.com | 993       | smtp.office365.com | 587       |
| QQ Mail     | imap.qq.com           | 993       | smtp.qq.com        | 587       |

**Important for Gmail:**

- Gmail does **not** accept your regular account password
- You must generate an **App Password**: https://myaccount.google.com/apppasswords
- Use the generated 16-character App Password as `IMAP_PASS` / `SMTP_PASS`
- Requires Google Account with 2-Step Verification enabled

**Important for 163.com:**

- Use **authorization code** (授权码), not account password
- Enable IMAP/SMTP in web settings first

## IMAP Commands (Receiving Email)

### check

Check for new/unread emails.

```bash
node scripts/imap.js [--account <name>] check [--limit 10] [--mailbox INBOX] [--recent 2h]
```

Options:

- `--limit <n>`: Max results (default: 10)
- `--mailbox <name>`: Mailbox to check (default: INBOX)
- `--recent <time>`: Only show emails from last X time (e.g., 30m, 2h, 7d)

### fetch

Fetch full email content by UID.

```bash
node scripts/imap.js [--account <name>] fetch <uid> [--mailbox INBOX]
```

### download

Download all attachments from an email, or a specific attachment.

```bash
node scripts/imap.js [--account <name>] download <uid> [--mailbox INBOX] [--dir <path>] [--file <filename>]
```

Options:

- `--mailbox <name>`: Mailbox (default: INBOX)
- `--dir <path>`: Output directory (default: current directory)
- `--file <filename>`: Download only the specified attachment (default: download all)

### search

Search emails with filters.

```bash
node scripts/imap.js [--account <name>] search [options]

Options:
  --unseen           Only unread messages
  --seen             Only read messages
  --from <email>     From address contains
  --subject <text>   Subject contains
  --recent <time>    From last X time (e.g., 30m, 2h, 7d)
  --since <date>     After date (YYYY-MM-DD)
  --before <date>    Before date (YYYY-MM-DD)
  --limit <n>        Max results (default: 20)
  --mailbox <name>   Mailbox to search (default: INBOX)
```

### mark-read / mark-unread

Mark message(s) as read or unread.

```bash
node scripts/imap.js [--account <name>] mark-read <uid> [uid2 uid3...]
node scripts/imap.js [--account <name>] mark-unread <uid> [uid2 uid3...]
```

### list-mailboxes

List all available mailboxes/folders.

```bash
node scripts/imap.js [--account <name>] list-mailboxes
```

### list-accounts

List all configured email accounts.

```bash
node scripts/imap.js list-accounts
node scripts/smtp.js list-accounts
```

Shows account name, email address, server addresses, and configuration status.

## SMTP Commands (Sending Email)

### send

Send email via SMTP.

```bash
node scripts/smtp.js [--account <name>] send --to <email> --subject <text> [options]
```

**Required:**

- `--to <email>`: Recipient (comma-separated for multiple)
- `--subject <text>`: Email subject, or `--subject-file <file>`

**Optional:**

- `--body <text>`: Plain text body
- `--html`: Send body as HTML
- `--body-file <file>`: Read body from file
- `--html-file <file>`: Read HTML from file
- `--cc <email>`: CC recipients
- `--bcc <email>`: BCC recipients
- `--attach <file>`: Attachments (comma-separated)
- `--from <email>`: Override default sender

**Examples:**

```bash
# Simple text email
node scripts/smtp.js send --to recipient@example.com --subject "Hello" --body "World"

# HTML email
node scripts/smtp.js send --to recipient@example.com --subject "Newsletter" --html --body "<h1>Welcome</h1>"

# Email with attachment
node scripts/smtp.js send --to recipient@example.com --subject "Report" --body "Please find attached" --attach report.pdf

# Multiple recipients
node scripts/smtp.js send --to "a@example.com,b@example.com" --cc "c@example.com" --subject "Update" --body "Team update"
```

### test

Test SMTP connection by sending a test email to yourself.

```bash
node scripts/smtp.js [--account <name>] test
```

## Dependencies

```bash
npm install
```

## Security Notes

- Configuration is stored at `~/.config/imap-smtp-email/.env` with `600` permissions (owner read/write only)
- **Gmail**: regular password is rejected — generate an App Password at https://myaccount.google.com/apppasswords
- For 163.com: use authorization code (授权码), not account password

## Troubleshooting

**Connection timeout:**

- Verify server is running and accessible
- Check host/port configuration

**Authentication failed:**

- Verify username (usually full email address)
- Check password is correct
- For 163.com: use authorization code, not account password
- For Gmail: regular password won't work — generate an App Password at https://myaccount.google.com/apppasswords

**TLS/SSL errors:**

- Match `IMAP_TLS`/`SMTP_SECURE` setting to server requirements
- For self-signed certs: set `IMAP_REJECT_UNAUTHORIZED=false` or `SMTP_REJECT_UNAUTHORIZED=false`
