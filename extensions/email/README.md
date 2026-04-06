# @openclaw/email

Email channel plugin for OpenClaw — **IMAP polling inbound, SMTP outbound**.

Works with any standard IMAP/SMTP mail server: Gmail, Fastmail, self-hosted Postfix/Dovecot, Migadu, Proton Bridge, etc.

## How it works

- Polls an IMAP mailbox for unseen messages at a configurable interval (default 30 s).
- Each new email becomes an inbound message in the agent's conversation session keyed by the sender's address.
- The agent's reply is sent back via SMTP with a properly threaded `In-Reply-To` / `References` header.
- Attachments are listed in the inbound context; PDF text is surfaced inline when the native `pdf` tool is available.

## Configuration

```json
{
  "channels": {
    "email": {
      "imapHost": "imap.example.com",
      "imapPort": 993,
      "imapUsername": "bot@example.com",
      "imapPassword": "...",
      "imapMailbox": "INBOX",
      "imapUseSsl": true,

      "smtpHost": "smtp.example.com",
      "smtpPort": 587,
      "smtpUsername": "bot@example.com",
      "smtpPassword": "...",
      "smtpUseTls": true,
      "fromAddress": "OpenClaw Bot <bot@example.com>",

      "autoReplyEnabled": true,
      "consentGranted": true,
      "pollIntervalSeconds": 30,
      "markSeen": true,
      "maxBodyChars": 12000,
      "subjectPrefix": "Re: ",

      "dmPolicy": "allowlist",
      "allowFrom": ["trusted@example.com", "*@mycompany.com"]
    }
  }
}
```

### Environment variable shortcuts

| Variable | Equivalent config key |
|---|---|
| `EMAIL_IMAP_HOST` | `channels.email.imapHost` |
| `EMAIL_IMAP_USERNAME` | `channels.email.imapUsername` |
| `EMAIL_IMAP_PASSWORD` | `channels.email.imapPassword` |
| `EMAIL_SMTP_HOST` | `channels.email.smtpHost` |
| `EMAIL_SMTP_USERNAME` | `channels.email.smtpUsername` |
| `EMAIL_SMTP_PASSWORD` | `channels.email.smtpPassword` |

### Multi-account

```json
{
  "channels": {
    "email": {
      "accounts": {
        "ops": {
          "imapHost": "imap.ops.example.com",
          "imapUsername": "ops@example.com",
          "imapPassword": "...",
          "smtpHost": "smtp.ops.example.com",
          "smtpUsername": "ops@example.com",
          "smtpPassword": "...",
          "autoReplyEnabled": true,
          "consentGranted": true
        },
        "support": {
          "imapHost": "imap.support.example.com",
          "imapUsername": "support@example.com",
          "imapPassword": "...",
          "autoReplyEnabled": false,
          "consentGranted": true
        }
      }
    }
  }
}
```

## Key options

| Key | Default | Description |
|---|---|---|
| `autoReplyEnabled` | `false` | Allow the agent to send replies via SMTP |
| `consentGranted` | `false` | Safety gate — must be explicitly `true` |
| `pollIntervalSeconds` | `30` | IMAP poll frequency (5–3600 s) |
| `markSeen` | `true` | Mark fetched messages as `\Seen` |
| `maxBodyChars` | `12000` | Truncate body at this many characters |
| `dmPolicy` | `"allowlist"` | `"open"`, `"allowlist"`, `"disabled"` |
| `allowFrom` | `["*"]` | Email addresses / domain wildcards (`"*@domain.com"`) |

## Error handling & backoff

- **Auth failures** (`authentication failed`, `invalid credentials`, etc.) → exponential backoff capped at 2 h. Prevents account lockout on bad credentials.
- **Transient failures** (timeout, connection reset, etc.) → exponential backoff capped at 30 min.
- **Normal failures** → linear backoff proportional to `pollIntervalSeconds`.

## Dependencies

- [`imapflow`](https://imapflow.com/) — modern IMAP client
- [`mailparser`](https://nodemailer.com/extras/mailparser/) — MIME parsing
- [`nodemailer`](https://nodemailer.com/) — SMTP transport
