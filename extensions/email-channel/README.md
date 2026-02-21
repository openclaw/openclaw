# Email Channel Plugin

Email channel support for OpenClaw using IMAP and SMTP protocols.

## Features

- **Send and Receive Emails**: Full email communication support via standard IMAP/SMTP protocols
- **Parallel Processing**: Concurrent email processing for different senders
- **Sequential Per-Sender**: Ordered processing for multiple emails from the same sender
- **Multi-Account Support**: Handle multiple email accounts independently
- **AI Integration**: Automatic AI-powered reply generation
- **State Persistence**: Track processed emails to avoid duplicates

## Configuration

Add email channel configuration to your OpenClaw config:

```json
{
  "channels": {
    "email": {
      "accounts": {
        "default": {
          "imap": {
            "host": "imap.example.com",
            "port": 993,
            "secure": true,
            "user": "your-email@example.com",
            "password": "your-password"
          },
          "smtp": {
            "host": "smtp.example.com",
            "port": 587,
            "secure": true,
            "user": "your-email@example.com",
            "password": "your-password"
          },
          "checkInterval": 30,
          "allowedSenders": ["trusted@example.com"]
        }
      }
    }
  }
}
```

## Dependencies

- `imap` - IMAP client for receiving emails
- `nodemailer` - SMTP client for sending emails
- `mailparser` - Parse raw email messages
