# Himalaya Configuration Reference

Configuration file location: `~/.config/himalaya/config.toml`

These examples use the Himalaya 2.1+ schema. Check `himalaya --version` before
reusing configuration written for an older release. Himalaya can generate a
discovered account with `himalaya configure`; providers that are not discovered
can be configured manually as shown below.

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

mailbox.alias.inbox = "INBOX"

# IMAP for reading email
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "user@example.com"
imap.sasl.plain.password.command = "pass show email/imap"

# SMTP for sending email
smtp.server = "smtp://smtp.example.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "user@example.com"
smtp.sasl.plain.password.command = "pass show email/smtp"
```

## Password Options

Password settings belong to a protocol and SASL mechanism. Prefer a command
that reads the secret from a password manager.

### Password from command (recommended)

```toml
imap.sasl.plain.password.command = "pass show email/imap"
smtp.sasl.plain.password.command = "pass show email/smtp"
# macOS Keychain examples:
# imap.sasl.plain.password.command = "security find-generic-password -a user@example.com -s imap -w"
# smtp.sasl.plain.password.command = "security find-generic-password -a user@example.com -s smtp -w"
```

### Raw password (testing only, not recommended)

```toml
imap.sasl.plain.password.raw = "your-password"
smtp.sasl.plain.password.raw = "your-password"
```

## Gmail Configuration

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "[Gmail]/Sent Mail"
mailbox.alias.drafts = "[Gmail]/Drafts"
mailbox.alias.trash = "[Gmail]/Trash"
mailbox.alias.archive = "[Gmail]/All Mail"

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.plain.username = "you@gmail.com"
imap.sasl.plain.password.command = "pass show google/app-password"

smtp.server = "smtps://smtp.gmail.com:465"
smtp.sasl.plain.username = "you@gmail.com"
smtp.sasl.plain.password.command = "pass show google/app-password"
```

**Note:** Gmail requires an App Password if 2FA is enabled.

## iCloud Configuration

```toml
[accounts.icloud]
email = "johnappleseed@icloud.com"
display-name = "Your Name"

mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "Sent Messages"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "johnappleseed"
imap.sasl.plain.password.command = "pass show icloud/app-password"

smtp.server = "smtp://smtp.mail.me.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "johnappleseed@icloud.com"
smtp.sasl.plain.password.command = "pass show icloud/app-password"
```

**Note:** Generate an app-specific password at appleid.apple.com

## Mailbox Aliases

Map custom folder names:

```toml
[accounts.default]
mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "Sent"
mailbox.alias.drafts = "Drafts"
mailbox.alias.trash = "Trash"
```

## Multiple Accounts

```toml
[accounts.personal]
email = "personal@example.com"
default = true
# ... protocol config ...

[accounts.work]
email = "work@company.com"
# ... protocol config ...
```

Switch accounts with `--account`:

```bash
himalaya --account work envelope list
```

## Maildir Backend (local mail)

```toml
[accounts.local]
email = "user@example.com"
mailbox.alias.inbox = "INBOX"
maildir.root = "~/.mail"
```

## OAuth 2.0 Tokens (for providers that support them)

```toml
imap.sasl.oauthbearer.username = "user@example.com"
imap.sasl.oauthbearer.token.command = "pass show oauth/access-token"

smtp.sasl.oauthbearer.username = "user@example.com"
smtp.sasl.oauthbearer.token.command = "pass show oauth/access-token"
```

The command must return a usable access token. Himalaya does not perform the
authorization or refresh flow for this SASL setting.

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

## Troubleshooting

If `himalaya account check` reports `No backend matching \`auto\` is configured
for this account`, first compare the configuration schema with the installed
Himalaya version. Current releases ignore keys under `backend`,
`message.send.backend`, and `folder.alias`. Use `imap`, `smtp`, and
`mailbox.alias` instead, then confirm the configured protocols with:

```bash
himalaya account list
himalaya account check
```
