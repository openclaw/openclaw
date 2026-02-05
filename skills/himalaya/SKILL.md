---
name: himalaya
description: "CLI to manage emails via IMAP/SMTP. Run `himalaya --help` to get started and discover available commands and their correct flags."
homepage: https://github.com/pimalaya/himalaya
metadata:
  {
    "openclaw":
      {
        "emoji": "📧",
        "requires": { "bins": ["himalaya"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "himalaya",
              "bins": ["himalaya"],
              "label": "Install Himalaya (brew)",
            },
          ],
      },
  }
---

# Himalaya Email CLI

Himalaya is a CLI email client that lets you manage emails from the terminal using IMAP, SMTP, Notmuch, or Sendmail backends.

## References

- `references/configuration.md` (config file setup + IMAP/SMTP authentication)
- `references/message-composition.md` (MML syntax for composing emails)
- `references/html-email.md` (HTML styling for formatted emails - use sparingly)

## Email Philosophy

**Simplicity and clarity over complexity.** Emails should be clean, well-aligned, and easy to read.

| User Request                                 | Format                                           |
| -------------------------------------------- | ------------------------------------------------ |
| "Send an email" / "Write an email"           | Plain text only                                  |
| "Styled email" / "nicer" / "polished"        | Editorial style (black/white, clean like Medium) |
| "Marketing email" / specific colors/branding | Full styled HTML                                 |

**Guidelines:**

- Default to plain text for all emails
- Use ASCII characters (`-`, `*`, `>`) over Unicode equivalents
- When styling is requested without specifics, use editorial style (black/white, Medium-like)
- Only use colors/branding when explicitly requested

## Prerequisites

1. Himalaya CLI installed (`himalaya --version` to verify)
2. A configuration file at `~/.config/himalaya/config.toml`
3. IMAP/SMTP credentials configured (password stored securely)

## Before Using Himalaya

Before sending or reading emails, always run these checks first:

1. Verify himalaya is working: `himalaya --version`
2. Check configured accounts: `himalaya account list`
3. Use the account's email address as the `From:` header in all outgoing emails

> **Tip:** Always use the email address from `himalaya account list` as the `From:` header. Do not guess or hardcode email addresses.

If no accounts are configured, guide the user through setup (see Configuration Setup below).

## Configuration Setup

Run the interactive wizard to set up an account:

```bash
himalaya account configure
```

Or create `~/.config/himalaya/config.toml` manually:

```toml
[accounts.personal]
email = "you@example.com"
display-name = "Your Name"
default = true

backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you@example.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show email/imap"  # or use keyring

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "you@example.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show email/smtp"
```

> **Note:** `message.send.save-copy = true` saves sent emails to Sent folder, but may fail with some IMAP servers due to BINARY extension issues ([himalaya#619](https://github.com/pimalaya/himalaya/issues/619)). If you see "Mailbox does not exist" errors, set it to `false`.

## Common Operations

### List Folders

```bash
himalaya folder list
```

### List Emails

List emails in INBOX (default):

```bash
himalaya envelope list
```

List emails in a specific folder:

```bash
himalaya envelope list --folder "Sent"
```

List with pagination:

```bash
himalaya envelope list --page 1 --page-size 20
```

### Search Emails

Basic search:

```bash
himalaya envelope list from john@example.com subject meeting
```

**Search Query Syntax:**

| Query                 | Description                          |
| --------------------- | ------------------------------------ |
| `subject <pattern>`   | Search by subject                    |
| `from <pattern>`      | Search by sender                     |
| `to <pattern>`        | Search by recipient                  |
| `body <pattern>`      | Search in message body               |
| `flag <flag>`         | Filter by flag (seen, flagged, etc.) |
| `before <yyyy-mm-dd>` | Messages before date                 |
| `after <yyyy-mm-dd>`  | Messages after date                  |

**Operators:** `and`, `or`, `not`

Examples:

```bash
# Find unread emails from a specific sender
himalaya envelope list from boss@company.com not flag seen

# Find emails about "project" in the last week
himalaya envelope list subject project after 2025-01-27
```

### Read an Email

Read email by ID (shows plain text):

```bash
himalaya message read 42
```

Export raw MIME:

```bash
himalaya message export 42 --full
```

### Reply to an Email

Interactive reply (opens $EDITOR):

```bash
himalaya message reply 42
```

Reply-all:

```bash
himalaya message reply 42 --all
```

### Forward an Email

```bash
himalaya message forward 42
```

### Write a New Email

Interactive compose (opens $EDITOR):

```bash
himalaya message write
```

**For non-interactive/programmatic sending, use `template send`:**

```bash
himalaya template send <<EOF
From: you@example.com
To: recipient@example.com
Subject: Test Message

Hello from Himalaya!
EOF
```

> ⚠️ **Note:** `himalaya message write` always opens an interactive editor. Use `himalaya template send` with a heredoc or piped input for automated/scripted email sending.

> **CRITICAL: `template send` vs `message send`**
>
> - `himalaya template send` - Processes MML tags (`<#multipart>`, `<#part>`) into proper MIME. **Use this for all programmatic/scripted sending.**
> - `himalaya message send` - Sends raw MIME bytes WITHOUT processing MML tags. MML tags will appear as literal text in the recipient's inbox. **Do not use this for composing emails.**
>
> If you need to send an email non-interactively (heredoc, pipe, script), ALWAYS use `template send`.

### HTML Emails

**Plain text is the default.** Only use styled formats when explicitly requested.

**Format tiers:**

- "Send an email" → Plain text (no formatting)
- "Styled email" / "nicer" / "polished" → Editorial style (black/white, clean like Medium)
- Specific styles mentioned (colors, branding, buttons) → Full styled HTML

For any HTML email, you **MUST** use MML multipart syntax. Raw HTML sent as the body will appear as literal text:

```bash
# ❌ WRONG - HTML appears as raw text
himalaya template send <<'EOF'
From: you@example.com
To: recipient@example.com
Subject: Test

<html><body><h1>Hello</h1></body></html>
EOF

# ✅ CORRECT - Use MML multipart with text/html part
himalaya template send <<'EOF'
From: you@example.com
To: recipient@example.com
Subject: Test

<#multipart type=alternative>
Hello (plain text fallback)
<#part type=text/html>
<html><body><h1>Hello</h1></body></html>
<#/multipart>
EOF
```

See `references/html-email.md` for complete HTML email guidance.

### Plain Text Email Guidelines

**DO NOT use markdown syntax in plain text emails.** Email clients don't render markdown - it appears as literal characters.

**Prefer ASCII characters over Unicode** for maximum compatibility:

| ❌ Markdown (literal) | ✅ Plain text |
| --------------------- | ------------- |
| `**important**`       | IMPORTANT     |
| `- item`              | - item        |
| `## Heading`          | HEADING       |
| `[text](url)`         | text: url     |

For emphasis, use CAPS, blank lines, or simple punctuation. For lists, use ASCII `-` or `*` (not Unicode bullets like `•`).

### Move/Copy Emails

Move to folder:

```bash
himalaya message move "Archive" 42
```

Copy to folder:

```bash
himalaya message copy "Important" 42
```

### Delete an Email

```bash
himalaya message delete 42
```

### Manage Flags

Add flag (flags are positional arguments, not options):

```bash
himalaya flag add 42 seen
himalaya flag add 42 flagged
```

Remove flag:

```bash
himalaya flag remove 42 seen
himalaya flag remove 42 flagged
```

Common flags: `seen`, `answered`, `flagged`, `deleted`, `draft`

## Multiple Accounts

List accounts:

```bash
himalaya account list
```

Use a specific account:

```bash
himalaya --account work envelope list
```

## Attachments

Save attachments from a message (downloads to system downloads directory):

```bash
himalaya attachment download 42
```

## Output Formats

Most commands support `--output` for structured output:

```bash
himalaya envelope list --output json
himalaya envelope list --output plain
```

## Debugging

Enable debug logging:

```bash
RUST_LOG=debug himalaya envelope list
```

Full trace with backtrace:

```bash
RUST_LOG=trace RUST_BACKTRACE=1 himalaya envelope list
```

## Common Short Flags

| Short | Long          | Description                 |
| ----- | ------------- | --------------------------- |
| `-s`  | `--page-size` | Number of results per page  |
| `-p`  | `--page`      | Page number                 |
| `-f`  | `--folder`    | Target folder               |
| `-a`  | `--account`   | Account to use              |
| `-o`  | `--output`    | Output format (json, plain) |

Example using short flags:

```bash
himalaya envelope list -f Sent -s 10 -o json
```

## ⚠️ Common Mistakes (DO NOT USE)

These flags/options do NOT exist:

| ❌ Wrong                     | ✅ Correct                                          |
| ---------------------------- | --------------------------------------------------- |
| `--limit 10`                 | `--page-size 10` or `-s 10`                         |
| `--flag seen`                | `seen` (positional argument)                        |
| `attachment download --dir`  | `attachment download` (no dir option)               |
| `message write "body"`       | `template send <<EOF...EOF` (for non-interactive)   |
| `message send <<EOF...EOF`   | `template send <<EOF...EOF` (processes MML tags)    |
| `himalaya send`              | `himalaya template send` or `himalaya message send` |
| `message move 42 "Folder"`   | `message move "Folder" 42` (folder first)           |
| `message copy 42 "Folder"`   | `message copy "Folder" 42` (folder first)           |
| Raw `<html>` in body         | Use `<#multipart>` + `<#part type=text/html>`       |
| `<div>` layout in HTML email | Use `<table role="presentation">` (tables only)     |
| `**markdown**` in plain text | Use plain text formatting (CAPS, `-` for bullets)   |
| Sent folder empty            | Known bug with `save-copy=true` (see #619)          |

## Tips

- Use `himalaya --help` or `himalaya <command> --help` for detailed usage.
- Message IDs are relative to the current folder; re-list after folder changes.
- For composing rich emails with attachments, use MML syntax (see `references/message-composition.md`).
- Store passwords securely using `pass`, system keyring, or a command that outputs the password.
- **For scripted/automated email sending, always use `template send` with heredoc input, not `message write`.**
