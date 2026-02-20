# Delta.Chat Channel

Delta.Chat is a privacy-focused messaging app that uses email infrastructure for transport. The OpenClaw Delta.Chat extension enables your agent to receive and respond to messages from Delta.Chat users.

## Setup

### Prerequisites

1. **Delta.Chat Account**: You need a Delta.Chat account (email address + password)
2. **OpenClaw Gateway**: Running with the Delta.Chat extension installed

### Configuration

Add the Delta.Chat channel to your OpenClaw configuration:

```yaml
channels:
  deltachat:
    enabled: true
    # Choose ONE of these authentication methods:

    # Option 1: Email credentials (traditional)
    addr: "your-email@example.com"
    mail_pw: "your-email-password"

    # Option 2: Chatmail QR code (recommended for privacy)
    chatmailQr: "your-chatmail-qr-code-here"

    # Optional: Data directory for Delta.Chat state
    dataDir: "~/.openclaw/state/deltachat"

    # Optional: Media size limit in MB (default: 20)
    mediaMaxMb: 20
```

### Configuration Options

| Option       | Type    | Required | Description                                                            |
| ------------ | ------- | -------- | ---------------------------------------------------------------------- |
| `enabled`    | boolean | Yes      | Enable/disable Delta.Chat channel                                      |
| `addr`       | string  | No       | Email address for Delta.Chat account                                   |
| `mail_pw`    | string  | No       | Email password for Delta.Chat account                                  |
| `chatmailQr` | string  | No       | Chatmail QR code for privacy-focused setup                             |
| `dataDir`    | string  | No       | Directory for Delta.Chat data (default: `~/.openclaw/state/deltachat`) |
| `mediaMaxMb` | number  | No       | Maximum media file size in MB (default: 20)                            |

## Security Model

Delta.Chat uses email infrastructure for transport, so security is handled at the email level. OpenClaw provides additional security layers:

### DM Policy

Controls who can send direct messages to your agent:

| Policy      | Description                                               |
| ----------- | --------------------------------------------------------- |
| `disabled`  | No direct messages allowed                                |
| `allowlist` | Only users in `allowFrom` can send DMs                    |
| `pairing`   | Unapproved users receive a pairing code to request access |
| `open`      | Anyone can send DMs (not recommended)                     |

### Group Policy

Controls which groups your agent participates in:

| Policy      | Description                                             |
| ----------- | ------------------------------------------------------- |
| `allowlist` | Only groups listed in `groups` config can send messages |
| `open`      | Any group can send messages (not recommended)           |

### Allowlist Configuration

```yaml
channels:
  deltachat:
    dm:
      enabled: true
      policy: "pairing" # or "allowlist", "disabled", "open"
      allowFrom:
        - "alice@example.com"
        - "deltachat:charlie@example.com" # deltachat: prefix is stripped
        - "*" # Allow all (use with caution)

    groupPolicy: "allowlist" # or "open"
    groups:
      "123456": # numeric chat ID (from Delta.Chat)
        users: ["alice@example.com"]
      "*": # wildcard — applies to all groups not listed explicitly
        requireMention: true
```

### Pairing Mode

When `dm.policy` is set to `pairing`, unapproved senders receive a pairing code:

```
OpenClaw pairing request: abc123def456

To approve this sender, use: openclaw pairing approve --channel deltachat --code abc123def456
```

To approve a sender:

```bash
openclaw pairing approve --channel deltachat --code <code>
```

## Message Handling

### Message Limits

- **Text messages**: Delta.Chat has a ~4000 character limit. OpenClaw automatically chunks longer messages.
- **Media files**: Configurable via `mediaMaxMb` (default: 20MB)

### Command Detection

OpenClaw detects control commands in messages. Commands are only executed by authorized users (based on `allowFrom` configuration).

Common commands:

- `!help` - Show available commands
- `!status` - Show agent status
- `!ping` - Test connectivity

### Debouncing

Rapid-fire messages from the same sender are debounced and combined to reduce noise. The debounce timeout is configurable via the global `inboundDebounceMs` setting.

## Examples

### Basic Setup (Email Credentials)

```yaml
channels:
  deltachat:
    enabled: true
    addr: "agent@mydomain.com"
    mail_pw: "secure-password-here"
    dm:
      policy: "allowlist"
      allowFrom:
        - "user:alice@example.com"
        - "user:bob@example.com"
```

### Privacy-Focused Setup (Chatmail)

```yaml
channels:
  deltachat:
    enabled: true
    chatmailQr: "https://chatmail.example.com/qr/abc123..."
    dm:
      policy: "pairing" # Users must request access
    groupPolicy: "allowlist"
    groups:
      "123456": # numeric chat ID
        users: ["alice@example.com"]
```

### Open DM (Not Recommended for Production)

```yaml
channels:
  deltachat:
    enabled: true
    addr: "agent@mydomain.com"
    mail_pw: "secure-password-here"
    dm:
      policy: "open" # Anyone can message the agent
```

## Troubleshooting

### "Delta.Chat requires addr/mail_pw or chatmailQr to be configured"

**Cause**: Missing authentication credentials in configuration.

**Solution**: Add either `addr`/`mail_pw` or `chatmailQr` to your configuration.

### "Failed to start Delta.Chat RPC server"

**Cause**: Delta.Chat core library failed to initialize.

**Solutions**:

1. Check that Delta.Chat data directory exists and is writable
2. Verify email credentials are correct
3. Check network connectivity (Delta.Chat needs internet access)
4. Review gateway logs for detailed error messages

### Messages Not Being Received

**Checklist**:

1. Verify `enabled: true` in configuration
2. Check `dm.policy` and `allowFrom` settings
3. Verify email account is configured and receiving emails
4. Check gateway logs for inbound message processing
5. Ensure Delta.Chat IO is started (check logs for "Delta.Chat bot started")

### Messages Not Being Sent

**Checklist**:

1. Verify email account is configured and can send emails
2. Check that the target email address is valid
3. Review gateway logs for send errors
4. Verify network connectivity

### Pairing Codes Not Working

**Checklist**:

1. Verify `dm.policy: "pairing"` is set
2. Check that the sender is not already in `allowFrom`
3. Verify the pairing code is correct (case-sensitive)
4. Check that the pairing command was executed successfully

### Media Files Not Sending

**Checklist**:

1. Verify `mediaMaxMb` is large enough for your files
2. Check that the file type is supported by Delta.Chat
3. Verify file permissions (gateway needs read access)
4. Check gateway logs for media processing errors

## Advanced Configuration

### Custom Data Directory

```yaml
channels:
  deltachat:
    enabled: true
    addr: "agent@mydomain.com"
    mail_pw: "secure-password-here"
    dataDir: "/var/lib/openclaw/deltachat" # Custom location
```

### Multiple Accounts

OpenClaw currently supports one Delta.Chat account per gateway instance. For multiple accounts, run multiple gateway instances with different configurations.

### Integration with Other Channels

Delta.Chat can work alongside other channels (Telegram, Discord, Signal, etc.). Configure each channel independently in the `channels` section.

## Related Commands

- `openclaw channels status` - Check Delta.Chat channel status
- `openclaw pairing approve --channel deltachat --code <code>` - Approve a pairing request
- `openclaw config set channels.deltachat.enabled true` - Enable Delta.Chat channel

## See Also

- [Channel Configuration](/configuration#channels)
- [Security Policies](/security)
- [Pairing System](/pairing)
