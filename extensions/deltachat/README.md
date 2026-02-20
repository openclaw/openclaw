# Delta.Chat Channel Plugin for OpenClaw

This extension provides Delta.Chat channel support for OpenClaw, enabling end-to-end encrypted messaging via the Delta.Chat core.

## Features

- **Incoming Message Handling**: Listens for `IncomingMsg` events from Delta.Chat core
- **Sending Messages**: Uses `miscSendTextMessage()` to send responses
- **Security**: Supports DM policies (pairing, allowlist, open) and group policies
- **Multiple Accounts**: Supports multiple Delta.Chat accounts
- **Chatmail Support**: Works with chatmail servers for enhanced privacy
- **Avatar Support**: Automatically sets the OpenClaw logo as the bot's avatar

## Installation

### Prerequisites

- OpenClaw CLI installed (`openclaw` command available)
- Node.js 22+ runtime
- Gateway running (see Gateway Configuration below)

### Enabling the Delta.Chat Extension

The Delta.Chat extension is built-in to OpenClaw. Enable it using the plugins command:

```bash
# Enable the Delta.Chat extension
openclaw plugins enable deltachat

# Verify the plugin is enabled
openclaw plugins list
```

**Note**: The Delta.Chat extension is a built-in plugin that runs within the OpenClaw gateway. After enabling, you need to **restart the gateway** for the plugin to load, then configure it (see Gateway Configuration below).

### Development Installation

If you're developing or testing the extension locally:

```bash
# From the OpenClaw workspace root
cd /path/to/openclaw
pnpm install
pnpm build

# The extension is located at extensions/deltachat/
```

### Dependencies

The extension requires these packages (automatically installed):

- `@deltachat/jsonrpc-client@^1.160.0` - TypeScript client for JSON-RPC API
- `@deltachat/stdio-rpc-server@^1.160.0` - Runs Delta.Chat core as subprocess
- `zod@^4.3.6` - Configuration validation

## Gateway Configuration

The Delta.Chat extension runs as part of the OpenClaw gateway. The gateway should be **running** for the extension to function.

### Configuration File Location

Configuration is stored in `~/.openclaw/openclaw.json`. This file contains the main OpenClaw configuration including all channel settings.

### Complete Setup from Scratch

If you've deleted the configuration or are setting up for the first time:

1. **Ensure the gateway is running**:
   - Start the OpenClaw Mac app (menubar app)
   - Or run: `openclaw gateway run --bind loopback --port 18789`

2. **Configure the Delta.Chat channel** (choose ONE method):

   **Option A: Use the interactive onboarding wizard** (recommended for initial setup)

   ```bash
   openclaw onboard
   ```

   During the wizard, select Delta.Chat as a channel and provide your email address and password when prompted.

   **Option B: Manually edit the config file**
   Edit `~/.openclaw/openclaw.json` with the configuration structure shown below.

   **Option C: Use environment variables**
   Set the following environment variables before starting the gateway:

   ```bash
   export DELTACHAT_ADDR="your-email@example.com"
   export DELTACHAT_MAIL_PW="your-password"
   # Or for chatmail:
   export DELTACHAT_CHATMAIL_QR="dcaccount:https://nine.testrun.org/new"
   ```

   **Note**: These are alternatives - you only need to use one method, not both.

3. **Configuration Structure**:
   The `openclaw.json` file should contain a `channels` object with a `deltachat` section:

   ```json
   {
     "channels": {
       "deltachat": {
         "enabled": true,
         "addr": "your-email@example.com",
         "mail_pw": "your-password",
         "bot": "1",
         "e2ee_enabled": "1",
         "dm": {
           "policy": "pairing",
           "allowFrom": ["user@example.com"]
         },
         "groupPolicy": "allowlist",
         "groups": {
           "my-group": {
             "users": ["user@example.com"]
           }
         }
       }
     }
   }
   ```

4. **Verification**:
   - Check gateway logs: `tail -f ~/.openclaw/logs/gateway.log`
   - Run status check: `openclaw channels status --probe`
   - The gateway will automatically start the Delta.Chat RPC server when the channel is enabled

### Configuration Options

The Delta.Chat extension supports the following configuration options:

| Option                            | Type    | Description                                                        | Default                       |
| --------------------------------- | ------- | ------------------------------------------------------------------ | ----------------------------- |
| `enabled`                         | boolean | Enable/disable the Delta.Chat channel                              | `false`                       |
| `addr`                            | string  | Email address for the account                                      | -                             |
| `mail_pw`                         | string  | Email password                                                     | -                             |
| `chatmailQr`                      | string  | Chatmail QR code URL (alternative to addr/mail_pw)                 | -                             |
| `dataDir`                         | string  | Directory for Delta.Chat state                                     | `~/.openclaw/state/deltachat` |
| `bot`                             | string  | Bot mode flag ("1" for enabled)                                    | "1"                           |
| `e2ee_enabled`                    | string  | End-to-end encryption flag ("1" for enabled)                       | "1"                           |
| `mediaMaxMb`                      | number  | Maximum inbound/outbound media size in MB                          | 20                            |
| `dm.policy`                       | string  | DM policy: `disabled`, `pairing`, `allowlist`, `open`              | `pairing`                     |
| `dm.allowFrom`                    | array   | List of allowed email addresses for DMs                            | `[]`                          |
| `groupPolicy`                     | string  | Group policy: `allowlist`, `open`                                  | `allowlist`                   |
| `groupAllowFrom`                  | array   | List of allowed group chat IDs (when `groupPolicy` is `allowlist`) | `[]`                          |
| `groups`                          | object  | Per-group config (keyed by numeric chat ID or `"*"` for wildcard)  | `{}`                          |
| `reactionLevel`                   | string  | Reaction mode: `off`, `ack`, `minimal`, `extensive`                | `minimal`                     |
| `replyToMode`                     | string  | Reply threading mode: `off`, `reply`, `thread`                     | `off`                         |
| `livenessReactionsEnabled`        | boolean | Show cycling liveness emoji while the agent is processing          | `true`                        |
| `livenessReactionIntervalSeconds` | number  | Interval in seconds between liveness emoji changes                 | `15`                          |
| `initialSyncLimit`                | number  | Max messages to sync on first connect                              | -                             |

## Configuration

**Note**: The CLI setup command (see Usage section) handles configuration automatically. These manual configuration examples are provided for reference or advanced use cases.

### Basic Setup (Traditional Email)

If manually editing `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "deltachat": {
      "enabled": true,
      "addr": "your-email@example.com",
      "mail_pw": "your-password",
      "bot": "1",
      "e2ee_enabled": "1"
    }
  }
}
```

### Chatmail Setup (Recommended)

If manually editing `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "deltachat": {
      "enabled": true,
      "chatmailQr": "dcaccount:https://nine.testrun.org/new",
      "bot": "1",
      "e2ee_enabled": "1"
    }
  }
}
```

### DM Security Policy

If manually editing `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "deltachat": {
      "dm": {
        "policy": "pairing", // disabled, pairing, allowlist, open
        "allowFrom": ["user@example.com", "admin@example.com"]
      }
    }
  }
}
```

### Group Security Policy

If manually editing `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "deltachat": {
      "groupPolicy": "allowlist", // allowlist or open
      "groups": {
        "my-group": {
          "users": ["user@example.com"]
        }
      }
    }
  }
}
```

**Note**: The gateway must be running for these configurations to take effect. After modifying `openclaw.json`, restart the gateway or the OpenClaw Mac app.

## Usage

### Gateway Status

Before using the Delta.Chat channel, verify the gateway is running:

```bash
# Check if gateway is running
openclaw channels status --probe

# View gateway logs
tail -f ~/.openclaw/logs/gateway.log

# Check gateway process
ss -ltnp | grep 18789
```

If the gateway is not running, start it via the OpenClaw Mac app or run:

```bash
openclaw gateway run --bind loopback --port 18789
```

### Setup Command

The Delta.Chat channel is configured through the interactive `openclaw onboard` wizard or by manually editing the configuration file. There is no dedicated CLI command for Delta.Chat setup.

**Interactive Setup**:

```bash
openclaw onboard
```

During the wizard, select Delta.Chat as a channel and provide your credentials.

**Manual Configuration**:
Edit `~/.openclaw/openclaw.json` directly (see Configuration section above).

**Note**: The gateway must be running for the configuration to take effect. After configuring Delta.Chat:

1. The account is saved in `~/.openclaw/openclaw.json`
2. The Delta.Chat RPC server starts automatically
3. The OpenClaw avatar is copied to the data directory
4. The `selfavatar` configuration is set

### Pairing Command (Generate QR Code)

To pair a Delta.Chat client (mobile app or desktop) with your bot, generate a QR code:

```bash
# Display QR code in terminal (ASCII format)
openclaw pairing generate --channel deltachat

# Save QR code to a file
openclaw pairing generate --channel deltachat --output /path/to/qr-code.qr

# Generate as image (requires external QR code generator)
openclaw pairing generate --channel deltachat --format image --output /path/to/qr-code.png

# With specific account
openclaw pairing generate --channel deltachat --account main
```

The QR code can be scanned by the Delta.Chat mobile app or desktop client to establish a secure connection.

### Target Format

When sending messages, use email addresses as targets:

```
deltachat:user@example.com
email:user@example.com
user@example.com
```

### Group Messages

```
deltachat:group:my-group
group:my-group
```

## How It Works

### Incoming Messages

The plugin uses the Delta.Chat JSON-RPC API to listen for `IncomingMsg` events:

1. **Event Listener**: `emitter.on("IncomingMsg", async ({ chatId, msgId }) => { ... })`
2. **Message Retrieval**: Fetch message details using `dc.rpc.getMessage(account.id, msgId)`
3. **Security Checks**: Verify sender against DM/group policies
4. **Context Building**: Create agent context with sender info, chat type, etc.
5. **Response Generation**: Trigger agent's message handling pipeline

### Sending Messages

Messages are sent using `miscSendTextMessage()`:

```typescript
await dc.rpc.miscSendTextMessage(account.id, chatId, messageText);
```

### Avatar Configuration

When the Delta.Chat account is configured, the extension automatically:

1. **Copies the OpenClaw avatar** from `ui/public/favicon.svg` (the lobster logo) to the Delta.Chat data directory
2. **Sets the `selfavatar` configuration** via the RPC API to use this avatar

This ensures the bot displays the OpenClaw logo in Delta.Chat clients. The avatar is copied once during account setup and persists across restarts.

## Architecture

### Files

- `index.ts` - Plugin registration
- `src/channel.ts` - Channel plugin definition
- `src/monitor.ts` - Incoming message handler (IncomingMsg event)
- `src/send.ts` - Message sending utilities
- `src/outbound.ts` - Outbound message handler
- `src/accounts.ts` - Account management
- `src/config-schema.ts` - Configuration validation
- `src/types.ts` - TypeScript types
- `src/actions.ts` - Message actions
- `src/onboarding.ts` - Setup commands
- `src/probe.ts` - Health checks
- `src/targets.ts` - Target resolution
- `src/runtime.ts` - Runtime management

### Event Flow

```
Delta.Chat Core
    ↓ (IncomingMsg event)
monitor.ts (emitter.on)
    ↓ (security checks)
Agent Pipeline
    ↓ (response)
miscSendTextMessage()
    ↓
Delta.Chat Core
```

## Limitations

- **Reactions**: Supported via `sendReaction()` RPC; configurable via `reactionLevel`
- **Threads**: No native thread support; `replyToMode` enables reply-style behavior
- **Editing**: Message editing not supported
- **Unsend**: Message unsending not supported
- **Native replies**: Reply threading (`capabilities.reply`) is off; use `replyToMode` for reply-like routing

## Troubleshooting

### Gateway Not Running

**Symptom**: Commands fail with connection errors or no response.

**Solution**: Ensure the gateway is running:

```bash
# Check gateway status
openclaw channels status --probe

# Start gateway if not running
openclaw gateway run --bind loopback --port 18789
```

### Configuration Not Taking Effect

**Symptom**: Changes to `~/.openclaw/openclaw.json` don't seem to work.

**Solution**: The gateway must be restarted to pick up configuration changes:

```bash
# Stop the gateway
pkill -f openclaw-gateway

# Start it again
openclaw gateway run --bind loopback --port 18789
```

### RPC Server Connection Issues

**Symptom**: Error messages about RPC server connection failures.

**Solution**: Check the Delta.Chat RPC server logs:

```bash
tail -f ~/.openclaw/logs/gateway.log | grep deltachat
```

### Avatar Not Showing

**Symptom**: Bot avatar doesn't display the OpenClaw logo.

**Solution**: The avatar is set during account setup. If it's missing:

1. Check that `ui/public/favicon.svg` exists in the workspace
2. Verify the Delta.Chat data directory has the avatar file
3. Restart the gateway to re-trigger avatar setup

### Message Sending Issues

**Symptom**: Messages can be sent from mobile but not received by the bot.

**Solution**: Check the DM policy configuration:

- Ensure `dm.policy` is not set to `disabled`
- If using `allowlist`, add your email to `dm.allowFrom`
- If using `pairing`, ensure you've scanned the QR code with your mobile app

### Chatmail Setup Issues

**Symptom**: Chatmail account setup fails.

**Solution**:

- Verify the `chatmailQr` URL is valid
- Check network connectivity to the chatmail server
- Review gateway logs for specific error messages

## References

- [Delta.Chat Bots Documentation](https://bots.delta.chat/)
- [JSON-RPC API Docs](https://js.jsonrpc.delta.chat/)
- [Delta.Chat Echo Bot Example](https://github.com/deltachat-bot/echo)
