# Himalaya Configuration Reference

Configuration file location: `~/.config/himalaya/config.toml`

This reference is aligned with the installed CLI here: `himalaya v1.1.0`.

## What Actually Matters

- Account selection is per subcommand in v1.1.x: `himalaya envelope list -a work`.
- Folder aliases use `folder.aliases.*`, not `folder.alias.*`.
- The stock Homebrew build does not include OAuth2 support, so the reliable local path is IMAP/SMTP with passwords or provider app passwords.
- Read failures usually come from the wrong IMAP login or the wrong folder aliases, not from the base read/list commands.

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "Sent"
folder.aliases.drafts = "Drafts"
folder.aliases.trash = "Trash"

# IMAP backend for reading emails
backend.type = "imap"
backend.host = "imap.example.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "user@example.com"
backend.auth.type = "password"
backend.auth.raw = "your-password"

# SMTP backend for sending emails
message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "user@example.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.raw = "your-password"
```

## Password Options

### Raw password (testing only, not recommended)

```toml
backend.auth.raw = "your-password"
```

### Password from command (recommended)

```toml
backend.auth.cmd = "pass show email/imap"
# backend.auth.cmd = "security find-generic-password -a user@example.com -s imap -w"
```

### System keyring (requires keyring feature)

```toml
backend.auth.keyring = "imap-example"
```

Then run `himalaya account configure <account>` to store the password.

## Gmail Configuration

Use Gmail app passwords with the stock Homebrew build. Generic aliases like `Sent` are not enough for Gmail because Gmail exposes provider-specific mailbox names.

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "[Gmail]/Sent Mail"
folder.aliases.drafts = "[Gmail]/Drafts"
folder.aliases.trash = "[Gmail]/Trash"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you@gmail.com"
backend.auth.type = "password"
backend.auth.cmd = "pass show google/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 465
message.send.backend.encryption.type = "tls"
message.send.backend.login = "you@gmail.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show google/app-password"
```

Notes:

- Gmail IMAP must be enabled on the account.
- Gmail requires a Google app password for this local non-OAuth setup.
- If reads work but sent-mail copy, drafts, or trash behavior is wrong, the alias block is usually the bug.

## iCloud Configuration

The easy failure mode here is using the full email address for both logins. Upstream Himalaya documents different login shapes for IMAP vs SMTP on iCloud.

```toml
[accounts.icloud]
email = "you@icloud.com"
display-name = "Your Name"

folder.aliases.inbox = "INBOX"
folder.aliases.sent = "Sent Messages"
folder.aliases.drafts = "Drafts"
folder.aliases.trash = "Deleted Messages"

backend.type = "imap"
backend.host = "imap.mail.me.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "you"
backend.auth.type = "password"
backend.auth.cmd = "pass show icloud/app-password"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.mail.me.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "you@icloud.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "pass show icloud/app-password"
```

Notes:

- IMAP login is the mailbox name, not the full email address. For `you@icloud.com`, that means `backend.login = "you"`.
- SMTP login stays the full email address.
- Generate an app-specific password in Apple ID settings and use it for both IMAP and SMTP auth.
- If folder operations miss, verify aliases against `himalaya folder list -a icloud`.

## Folder Aliases

Map custom folder names:

```toml
folder.aliases.inbox = "INBOX"
folder.aliases.sent = "Sent"
folder.aliases.drafts = "Drafts"
folder.aliases.trash = "Trash"
```

## Multiple Accounts

```toml
[accounts.personal]
email = "personal@example.com"
default = true
# ... backend config ...

[accounts.work]
email = "work@company.com"
# ... backend config ...
```

Switch accounts by placing `-a/--account` on the subcommand:

```bash
himalaya envelope list -a work
```

## Notmuch Backend (local mail)

```toml
[accounts.local]
email = "user@example.com"

backend.type = "notmuch"
backend.db-path = "~/.mail/.notmuch"
```

## OAuth2 Authentication (for providers that support it)

Only use this if your Himalaya build actually includes OAuth2 support. The Homebrew build used in this worktree does not.

```toml
backend.auth.type = "oauth2"
backend.auth.client-id = "your-client-id"
backend.auth.client-secret.cmd = "pass show oauth/client-secret"
backend.auth.access-token.cmd = "pass show oauth/access-token"
backend.auth.refresh-token.cmd = "pass show oauth/refresh-token"
backend.auth.auth-url = "https://provider.com/oauth/authorize"
backend.auth.token-url = "https://provider.com/oauth/token"
```

## Additional Options

### Signature

```toml
[accounts.default]
signature = "Best regards,\nYour Name"
signature-delim = "-- \n"
```

### Downloads directory

```toml
[accounts.default]
downloads-dir = "~/Downloads/himalaya"
```

### Editor for composing

Set via environment variable:

```bash
export EDITOR="vim"
```

## Validation Checklist

Use read-only checks in this order after editing config:

```bash
himalaya account list
himalaya folder list -a gmail
himalaya envelope list -a gmail --folder INBOX --page 1 --page-size 5
himalaya folder list -a icloud
himalaya envelope list -a icloud --folder INBOX --page 1 --page-size 5
```

If folder names differ from the examples above, update `folder.aliases.*` to match what `folder list` returns for that provider.
