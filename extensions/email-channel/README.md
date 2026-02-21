# Email Channel Plugin

Email channel support for OpenClaw using IMAP and SMTP protocols.

## Features

- **Send and Receive Emails**: Full email communication support via standard IMAP/SMTP protocols
- **Parallel Processing**: Concurrent email processing for different senders
- **Sequential Per-Sender**: Ordered processing for multiple emails from the same sender
- **Multi-Account Support**: Handle multiple email accounts independently
- **AI Integration**: Automatic AI-powered reply generation
- **State Persistence**: Track processed emails to avoid duplicates
- **Attachment Support**: Process email attachments and pass them to AI agents
- **Attachment Size Limits**: Configure maximum attachment size with automatic rejection

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
          "allowedSenders": ["trusted@example.com"],
          "maxAttachmentSize": 10485760
        }
      }
    }
  }
}
```

### Configuration Options

- **imap**: IMAP server settings for receiving emails
  - `host`: IMAP server hostname
  - `port`: IMAP server port (typically 993 for SSL)
  - `secure`: Use TLS/SSL connection
  - `user`: Email address/username
  - `password`: Email password

- **smtp**: SMTP server settings for sending emails
  - `host`: SMTP server hostname
  - `port`: SMTP server port (typically 587 for TLS)
  - `secure`: Use TLS/SSL connection
  - `user`: Email address/username
  - `password`: Email password

- **checkInterval**: Email polling interval in seconds (default: 30)
- **allowedSenders**: Array of email addresses to accept emails from (optional, accepts all if not set)
- **maxAttachmentSize**: Maximum attachment size in bytes (default: 10MB = 10485760)

## Attachment Handling

### How Attachments Work

1. **Received**: Email attachments are extracted from incoming emails
2. **Saved**: Attachments are saved to `/tmp/openclaw-email-attachments/<timestamp>/`
3. **Processed**: Attachment information and file paths are included in the message sent to the AI agent
4. **Accessible**: AI agents can read attachment files from the saved paths

### Attachment Size Limits

- If an attachment exceeds `maxAttachmentSize`, the email will not be processed
- An automatic rejection email is sent to the sender explaining the issue
- The rejection email includes details about which attachments were too large

### Message Format with Attachments

When an email has attachments, the AI agent receives:

```
From: sender@example.com
Subject: Email Subject

Email body text here...

--- Attachments ---
- document.pdf (245.67KB, application/pdf)
  File: /tmp/openclaw-email-attachments/1234567890/document.pdf
- image.png (1024.50KB, image/png)
  File: /tmp/openclaw-email-attachments/1234567890/image.png
```

The AI agent can then:

1. Read the attachment files using the provided paths
2. Process the attachments according to the user's request
3. Reference attachment information in its response

## Outbound Attachments

The email channel supports sending AI-generated files as email attachments in replies.

### How Outbound Attachments Work

1. **System Instructions**: Every email includes clear instructions telling the AI agent to save files to ONE allowed directory only
2. **AI Generates Files**: When the AI agent creates files, it should save them to a single location (not multiple copies)
3. **Files in Reply Payload**: Agent can return files via `mediaUrl` or `mediaUrls` parameters (preferred)
4. **Text Path Extraction**: As a backup, the system extracts file paths mentioned in the text response
5. **Smart Deduplication**: Files with the same filename are automatically deduplicated (prefers /tmp/ over workspace)
6. **Sent as Email Attachments**: Unique files are automatically attached to the email reply
7. **Proper MIME Types**: Attachments include correct content types for proper display

### Allowed Directories

Files must be saved to one of these directories to be attached:

- `/tmp/` (recommended)
- `/tmp/openclaw-generated/`
- `~/.openclaw/workspace/`

### Deduplication Logic

The system automatically deduplicates files:

- **By filename**: If multiple paths have the same filename, only one is kept
- **Preference**: `/tmp/` paths are preferred over workspace paths
- **No duplicates**: Avoids sending the same file multiple times

**Note:** Files mentioned only in text response will be extracted only if they are in allowed directories.

### System Instructions Sent to AI

Every incoming email includes detailed instructions for the AI on how to handle file generation:

```
--- System Instructions ---
This is an email channel. If you need to generate any files (images, documents, code, etc.):

STEPS TO FOLLOW:
1. Save the files to a temporary location (e.g., /tmp/openclaw-generated/filename.ext)
2. IMPORTANT: You MUST return the generated file paths using the appropriate media tools/functions available to you
   - Use mediaUrl or mediaUrls parameter to return file paths
   - The system will automatically convert these paths into email attachments
3. You may also mention the file paths in your text response for clarity
4. Supported file types: images, PDFs, text files, code files, data files, etc.

EXAMPLE:
- If you generate an image: save to /tmp/openclaw-generated/chart.png and return it via mediaUrl
- If you generate code: save to /tmp/openclaw-generated/script.py and return it via mediaUrl

NOTE: The recipient will receive these files as email attachments automatically.
```

### Example Workflow

**User sends email:**

```
Subject: Create a chart
Body: Please create a pie chart showing the market share of different programming languages
```

**AI processes the request:**

1. Receives the email with system instructions
2. Generates a pie chart image and saves to `/tmp/openclaw-generated/chart.png`
3. Includes the file path in the reply payload as `mediaUrl: "/tmp/openclaw-generated/chart.png"`
4. Writes text explanation

**User receives reply:**

- Email body contains the text explanation
- Email includes `chart.png` as an attachment
- User can download and view the chart

## Dependencies

- `imap` - IMAP client for receiving emails
- `nodemailer` - SMTP client for sending emails
- `mailparser` - Parse raw email messages
