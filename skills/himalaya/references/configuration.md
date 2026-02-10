# Himalaya Configuration Reference（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Configuration file location: `~/.config/himalaya/config.toml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Minimal IMAP + SMTP Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.default]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "user@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
display-name = "Your Name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default = true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# IMAP backend for reading emails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.type = "imap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.host = "imap.example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.port = 993（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.encryption.type = "tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.login = "user@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.raw = "your-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# SMTP backend for sending emails（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.type = "smtp"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.host = "smtp.example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.port = 587（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.encryption.type = "start-tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.login = "user@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.raw = "your-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Password Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Raw password (testing only, not recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.raw = "your-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Password from command (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.cmd = "pass show email/imap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# backend.auth.cmd = "security find-generic-password -a user@example.com -s imap -w"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### System keyring (requires keyring feature)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.keyring = "imap-example"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Then run `himalaya account configure <account>` to store the password.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Gmail Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.gmail]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "you@gmail.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
display-name = "Your Name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default = true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.type = "imap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.host = "imap.gmail.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.port = 993（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.encryption.type = "tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.login = "you@gmail.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.cmd = "pass show google/app-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.type = "smtp"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.host = "smtp.gmail.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.port = 587（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.encryption.type = "start-tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.login = "you@gmail.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.cmd = "pass show google/app-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Gmail requires an App Password if 2FA is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## iCloud Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.icloud]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "you@icloud.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
display-name = "Your Name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.type = "imap"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.host = "imap.mail.me.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.port = 993（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.encryption.type = "tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.login = "you@icloud.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.cmd = "pass show icloud/app-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.type = "smtp"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.host = "smtp.mail.me.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.port = 587（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.encryption.type = "start-tls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.login = "you@icloud.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.type = "password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
message.send.backend.auth.cmd = "pass show icloud/app-password"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Generate an app-specific password at appleid.apple.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Folder Aliases（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Map custom folder names:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.default.folder.alias]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
inbox = "INBOX"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sent = "Sent"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
drafts = "Drafts"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
trash = "Trash"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multiple Accounts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.personal]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "personal@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
default = true（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... backend config ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.work]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "work@company.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ... backend config ...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Switch accounts with `--account`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
himalaya --account work envelope list（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notmuch Backend (local mail)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.local]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
email = "user@example.com"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.type = "notmuch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.db-path = "~/.mail/.notmuch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## OAuth2 Authentication (for providers that support it)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.type = "oauth2"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.client-id = "your-client-id"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.client-secret.cmd = "pass show oauth/client-secret"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.access-token.cmd = "pass show oauth/access-token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.refresh-token.cmd = "pass show oauth/refresh-token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.auth-url = "https://provider.com/oauth/authorize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
backend.auth.token-url = "https://provider.com/oauth/token"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Additional Options（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Signature（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.default]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
signature = "Best regards,\nYour Name"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
signature-delim = "-- \n"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Downloads directory（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```toml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
[accounts.default]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
downloads-dir = "~/Downloads/himalaya"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Editor for composing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set via environment variable:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
export EDITOR="vim"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
