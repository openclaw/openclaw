# Email Channel for OpenClaw

A powerful email channel plugin for OpenClaw that enables bidirectional communication via IMAP/SMTP servers.

## Features

### ✨ Core Capabilities

- **IMAP Email Receiving**: Connects to any standard IMAP server to receive emails
- **SMTP Email Sending**: Sends AI responses directly to the sender's email
- **Sender Whitelist**: Optional security feature to restrict which email addresses can send commands
- **Session History**: Maintains conversation history per sender, viewable in OpenClaw Dashboard
- **Duplicate Prevention**: Uses Message-ID tracking to prevent processing the same email multiple times
- **Persistent State**: Robust state management survives Gateway restarts

### 🔄 Smart State Management

The email channel uses intelligent state tracking:

- **Time-based Search**: Searches for emails since the last processed timestamp (not reliant on UNSEEN flags)
- **Message-ID Deduplication**: Tracks processed emails to prevent duplicates
- **Persistent Storage**: State saved to `~/.openclaw/extensions/email/state.json`
- **Auto Cleanup**: Maintains only the last 1000 Message-IDs to prevent file bloat

### 📅 Persistent State File

```json
{
  "lastProcessedTimestamp": "2026-02-07T03:04:51.614Z",
  "processedMessageIds": ["<message-id-1>", "<message-id-2>"]
}
```

**Benefits**:

- ✅ Processes both read and unread emails (works even if you check email in other clients)
- ✅ No duplicate processing (Message-ID tracking)
- ✅ Survives restarts (state persistence)
- ✅ Time window protection (1-minute buffer for timing edge cases)

## Installation

### Prerequisites

- OpenClaw installed and running
- Node.js >= 18.0.0
- An email account with IMAP/SMTP access

### Setup

1. **Install the Plugin**

The email channel is included in OpenClaw. Ensure it's enabled in your configuration.

2. **Configure Email Settings**

Edit `~/.openclaw/openclaw.json`:

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
            "password": "your-password-or-app-token"
          },
          "smtp": {
            "host": "smtp.example.com",
            "port": 587,
            "secure": false,
            "user": "your-email@example.com",
            "password": "your-password-or-app-token"
          },
          "checkInterval": 30,
          "allowedSenders": ["trusted@example.com", "admin@yourdomain.com"]
        }
      }
    }
  }
}
```

3. **Restart Gateway**

```bash
openclaw gateway restart
```

## Configuration

### IMAP Settings (Receiving Emails)

| Field      | Type    | Description                                    |
| ---------- | ------- | ---------------------------------------------- |
| `host`     | string  | IMAP server address                            |
| `port`     | number  | IMAP port (993 for SSL, 143 for non-encrypted) |
| `secure`   | boolean | Use SSL/TLS connection                         |
| `user`     | string  | Email username                                 |
| `password` | string  | Email password or app-specific token           |

### SMTP Settings (Sending Emails)

| Field      | Type    | Description                               |
| ---------- | ------- | ----------------------------------------- |
| `host`     | string  | SMTP server address                       |
| `port`     | number  | SMTP port (465 for SSL, 587 for STARTTLS) |
| `secure`   | boolean | Use SSL (typically false for port 587)    |
| `user`     | string  | Email username                            |
| `password` | string  | Email password or app-specific token      |

### Optional Settings

| Field            | Type     | Default | Description                                    |
| ---------------- | -------- | ------- | ---------------------------------------------- |
| `checkInterval`  | number   | 30      | Email check interval in seconds                |
| `allowedSenders` | string[] | []      | Whitelist of authorized sender email addresses |

### Security: Sender Whitelist

**Important**: Configure `allowedSenders` to restrict which email addresses can send commands to your bot.

- If set (non-empty array): Only emails from addresses in the list will be processed
- If empty or omitted: All senders are accepted (not recommended for production)

**Example**:

```json
"allowedSenders": [
  "personal@example.com",
  "admin@company.com"
]
```

AI responses are always sent to the original sender, regardless of whitelist settings.

## Common Email Server Configurations

### Gmail

```json
{
  "imap": {
    "host": "imap.gmail.com",
    "port": 993,
    "secure": true,
    "user": "your@gmail.com",
    "password": "app-specific-password"
  },
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "user": "your@gmail.com",
    "password": "app-specific-password"
  }
}
```

**Note**: Gmail requires [App-Specific Passwords](https://support.google.com/accounts/answer/185833).

### QQ Mail

```json
{
  "imap": {
    "host": "imap.qq.com",
    "port": 993,
    "secure": true,
    "user": "your@qq.com",
    "password": "authorization-code"
  },
  "smtp": {
    "host": "smtp.qq.com",
    "port": 587,
    "secure": false,
    "user": "your@qq.com",
    "password": "authorization-code"
  }
}
```

**Note**: QQ Mail requires authorization code (not QQ password).

### 163 Mail

```json
{
  "imap": {
    "host": "imap.163.com",
    "port": 993,
    "secure": true,
    "user": "your@163.com",
    "password": "authorization-code"
  },
  "smtp": {
    "host": "smtp.163.com",
    "port": 465,
    "secure": true,
    "user": "your@163.com",
    "password": "authorization-code"
  }
}
```

### Outlook / Office365

```json
{
  "imap": {
    "host": "outlook.office365.com",
    "port": 993,
    "secure": true,
    "user": "your@outlook.com",
    "password": "your-password"
  },
  "smtp": {
    "host": "smtp-mail.outlook.com",
    "port": 587,
    "secure": false,
    "user": "your@outlook.com",
    "password": "your-password"
  }
}
```

## Usage

1. **Configure your email server** and optional sender whitelist
2. **Restart the Gateway**: `openclaw gateway restart`
3. **Send an email** from a whitelisted address to your configured email account
4. **Receive AI response** directly in your inbox

## Workflow

1. **Load State**: Read `state.json` to get last processed time and Message-ID list
2. **Search Emails**: Use IMAP `SINCE` search to find emails after last processed time
3. **Verify Sender**: Check if sender is in `allowedSenders` whitelist
4. **Check Duplicates**: Verify Message-ID hasn't been processed
5. **Process Command**: Send email content to AI agent
6. **Update State**: Save timestamp and Message-ID to state file
7. **Send Reply**: AI response automatically sent to original sender
8. **Record History**: Interaction saved to session file for Dashboard viewing

## Viewing History in Dashboard

### Start Dashboard

```bash
openclaw dashboard
```

### View Sessions

Email conversations appear in the session list with format:

- **Title**: `📧 {sender-email} - {subject}`
- **Aggregation**: All emails from same sender are in one conversation
- **Session Key**: `email:{sender-email}`

### View Conversation

Click any email session to see:

- Complete email content
- AI responses
- Timestamps and metadata
- Thread history

**Session Storage**: `~/.openclaw/agents/main/sessions/{sessionId}.jsonl`

## Log Output

### Startup

```
[EMAIL PLUGIN] Loaded state: lastProcessed=2026-02-07T03:04:51.614Z, processedCount=17
[EMAIL PLUGIN] Restricting to 2 allowed sender(s): trusted@example.com, admin@yourdomain.com
[EMAIL PLUGIN] Connecting to IMAP server imap.example.com:993
[EMAIL PLUGIN] IMAP connection ready!
```

### Email Received

```
[EMAIL PLUGIN] Searching for emails since 07-Feb-2026
[EMAIL PLUGIN] Found 1 email(s) since 07-Feb-2026
[EMAIL PLUGIN] Checking: from=trusted@example.com, subject="Test email"
[EMAIL PLUGIN] ✓ ACCEPTED email from: trusted@example.com
[EMAIL PLUGIN] Subject: Test email
[default] Processing email from trusted@example.com: "Test email" (UID: 12345)
[EMAIL PLUGIN] ✓ Marked UID 12345 as seen
[default] Sending reply to trusted@example.com
Email sent to trusted@example.com
[default] Email processed successfully
```

### Unauthorized Sender

```
[EMAIL PLUGIN] ✗ Ignoring email from unauthorized sender: unknown@spam.com
[EMAIL PLUGIN] Allowed senders: trusted@example.com, admin@yourdomain.com
```

## Troubleshooting

### Email Not Processed

**Possible causes**:

1. Sender not in whitelist
2. IMAP connection lost
3. Email already processed (check logs for "Skipping already processed")

**Solutions**:

1. Verify whitelist configuration
2. Check logs: `tail -f /tmp/openclaw/openclaw-*.log | grep EMAIL`
3. Check state file: `cat ~/.openclaw/extensions/email/state.json`

### Read Emails Not Processed

**Resolved in current version!**

The email channel now:

- ✅ Processes all emails regardless of read/unread status
- ✅ Uses time-based search instead of UNSEEN flag
- ✅ Prevents duplicates via Message-ID tracking
- ✅ Maintains persistent state across restarts

### Cannot See Session History

**Possible causes**:

1. No emails successfully processed yet
2. Dashboard needs refresh

**Solutions**:

1. Verify at least one email was processed (check logs)
2. Refresh Dashboard page
3. Check session files exist: `ls ~/.openclaw/agents/main/sessions/`

### Reprocess an Email

**Method 1: Remove Message-ID from state**

```bash
# Edit state file
vim ~/.openclaw/extensions/email/state.json
# Remove the Message-ID from processedMessageIds array

# Restart Gateway
openclaw gateway restart
```

**Method 2: Reset timestamp**

Edit `state.json` and set `lastProcessedTimestamp` to an earlier time.

### Reset All State

To completely start fresh:

```bash
# Remove state file
rm ~/.openclaw/extensions/email/state.json

# Restart Gateway
openclaw gateway restart
```

## Security Best Practices

1. **Always configure `allowedSenders` whitelist** in production
2. **Use a dedicated email account** for your bot (not your personal email)
3. **Use app-specific passwords** (Gmail, QQ, 163, etc.)
4. **Never commit credentials** to version control
5. **Rotate passwords periodically**
6. **Monitor logs** for unauthorized access attempts

## How It Works: Technical Details

### State Persistence

The email channel maintains a persistent state file that tracks:

- **lastProcessedTimestamp**: ISO 8601 timestamp of last successful email processing
- **processedMessageIds**: Array of Message-IDs that have been processed (max 1000)

This enables:

- Recovery from Gateway restarts
- Prevention of duplicate processing
- Time-based email search (independent of read/unread flags)

### Processing Flow

```
┌─────────────────┐
│  IMAP Search    │ SINCE lastProcessedTimestamp - 1min buffer
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Filter Emails │ By Message-ID (skip duplicates)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Check Sender   │ In allowedSenders whitelist?
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Process Email  │ Send to AI agent
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Update State   │ Save timestamp + Message-ID
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Send Reply     │ Via SMTP to original sender
└─────────────────┘
```

### Session Management

- **Session Key**: `email:{sender-email}`
- **Title Format**: `📧 {sender} - {subject}`
- **Continuity**: All emails from same sender in one session

## Architecture

The email channel consists of three main components:

### `src/runtime.ts`

- IMAP connection management
- Email receiving and parsing
- SMTP email sending
- State persistence (load/save)
- Duplicate detection

### `src/channel.ts`

- OpenClaw ChannelPlugin interface implementation
- Dynamic import of OpenClaw core functions
- Message dispatching to AI agent
- Session history integration

### `index.ts`

- Plugin entry point
- Plugin registration with OpenClaw

## Development

### Building

```bash
npm install
npm run build
```

### Testing

Create a test configuration with your email credentials and run:

```bash
openclaw gateway
```

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - see LICENSE file for details

## Support

- **Issues**: https://github.com/openclaw/openclaw/issues
- **Documentation**: https://github.com/openclaw/openclaw/wiki
