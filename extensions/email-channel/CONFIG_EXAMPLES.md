# Email Channel Configuration Examples

This directory contains example configurations for various email providers.

## Security Notice

**IMPORTANT**: Never commit actual credentials to version control!
Always use placeholder values in example configurations.

## Configuration Examples

### Gmail

- Requires App-Specific Password: https://support.google.com/accounts/answer/185833
- IMAP: imap.gmail.com:993 (SSL)
- SMTP: smtp.gmail.com:587 (STARTTLS)

### QQ Mail

- Requires authorization code (not QQ password)
- IMAP: imap.qq.com:993 (SSL)
- SMTP: smtp.qq.com:587 (STARTTLS)

### 163 Mail

- Requires authorization code
- IMAP: imap.163.com:993 (SSL)
- SMTP: smtp.163.com:465 (SSL)

### Outlook

- IMAP: outlook.office365.com:993 (SSL)
- SMTP: smtp-mail.outlook.com:587 (STARTTLS)

## Quick Start Template

```json
{
  "channels": {
    "email": {
      "accounts": {
        "default": {
          "enabled": true,
          "imap": {
            "host": "imap.example.com",
            "port": 993,
            "secure": true,
            "user": "your-email@example.com",
            "password": "your-password-or-token"
          },
          "smtp": {
            "host": "smtp.example.com",
            "port": 587,
            "secure": false,
            "user": "your-email@example.com",
            "password": "your-password-or-token"
          },
          "checkInterval": 30,
          "allowedSenders": ["trusted@example.com"]
        }
      }
    }
  }
}
```

Replace placeholder values with your actual email server configuration.
