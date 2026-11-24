# Himalaya Configuration Reference

Himalaya 2.x. Configuration file: `~/.config/himalaya/config.toml`.

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

imap.server = "imaps://imap.example.com:993"
imap.sasl.login.username = "user@example.com"
imap.sasl.login.password.raw = "your-password"

smtp.server = "smtps://smtp.example.com:465"
smtp.sasl.login.username = "user@example.com"
smtp.sasl.login.password.raw = "your-password"
```

`imap.server` and `smtp.server` take a bare authority or a URL. `imaps://` and `smtps://` use implicit TLS; `imap://` and `smtp://` start cleartext and upgrade when `imap.starttls` / `smtp.starttls` is set.

## Authentication

Each backend takes exactly one SASL mechanism: `login`, `plain`, `oauthbearer`, `xoauth2`, `scram-sha-256` or `anonymous`.

### Password from a command (recommended)

```toml
imap.sasl.login.password.command = "pass show email/imap"
smtp.sasl.login.password.command = "pass show email/smtp"
```

### Raw password (testing only)

```toml
imap.sasl.login.password.raw = "your-password"
```

## Gmail Configuration

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.plain.username = "you@gmail.com"
imap.sasl.plain.password.command = "pass show google/app-password"

smtp.server = "smtps://smtp.gmail.com:465"
smtp.sasl.plain.username = "you@gmail.com"
smtp.sasl.plain.password.command = "pass show google/app-password"
```

Gmail requires an app password when 2-step verification is on; generate it at <https://myaccount.google.com/apppasswords>. Plain account passwords are rejected.

## iCloud Configuration

```toml
[accounts.icloud]
email = "you@icloud.com"
display-name = "Your Name"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "you@icloud.com"
imap.sasl.plain.password.command = "pass show icloud/app-password"

smtp.server = "smtps://smtp.mail.me.com:465"
smtp.sasl.plain.username = "you@icloud.com"
smtp.sasl.plain.password.command = "pass show icloud/app-password"
```

Generate the app-specific password at <https://appleid.apple.com>.

## NetEase 163 and 126

Both refuse `AUTHENTICATE PLAIN`, both falsely advertise `SASL-IR` and reject the inline credentials with `BAD Request not ending with`, and both answer `SELECT Unsafe Login` until the client sends an IMAP `ID` after authentication. Set `imap.sasl-ir = false` so authentication waits for the server's continuation request, and keep the `imap.id` settings for the mailbox select.

```toml
[accounts.net163]
email = "you@163.com"
display-name = "Your Name"

imap.server = "imaps://imap.163.com:993"
imap.sasl-ir = false
imap.sasl.login.username = "you@163.com"
imap.sasl.login.password.command = "pass show netease/auth-code"
imap.id.auto = true
imap.id.fields = { name = true, version = true, vendor = true }

smtp.server = "smtps://smtp.163.com:465"
smtp.sasl.login.username = "you@163.com"
smtp.sasl.login.password.command = "pass show netease/auth-code"
```

Use the client authorization code from the webmail settings, not the account password. Leave `imap.id.fields` out and the server sees `ID NIL` and keeps refusing the mailbox.

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

Select one with `-a/--account`:

```bash
himalaya envelope list -a work
```

## Mailbox Aliases

```toml
mailbox.alias.archive = "Archives"
mailbox.alias.sent = "Sent Items"
```

Aliases resolve in `-m` and in `--to` for copy and move.

## Signature, Downloads, Editor

```toml
[accounts.default]
signature = "Best regards,\nYour Name"
signature-delim = "-- \n"
downloads-dir = "~/Downloads/himalaya"
```

The composer reads `EDITOR` (or `VISUAL`) for interactive editing.

## Validate

```bash
himalaya account check -a default
```
