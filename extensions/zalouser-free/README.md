# zalouser-free

Free Zalo Personal channel plugin for OpenClaw using [zca-js](https://github.com/RFS-ADRENO/zca-js) library.

## ⚠️ Warning

> Using this plugin could get your Zalo account locked or banned. The zca-js library is unofficial and simulates browser interactions. Use at your own risk.

## Features

- ✅ QR code login
- ✅ Session persistence (auto-reconnect)
- ✅ Send/receive text messages
- ✅ Direct messages (DM)
- ✅ Group messages
- ✅ Send stickers
- ✅ Reply/quote messages
- ⏳ Image/file attachments (planned)

## Installation

### From local directory

```bash
# Clone or copy to your workspace
cd ~/.openclaw/workspace
mkdir zalouser-free && cd zalouser-free

# Install dependencies
npm install zca-js

# Link to OpenClaw
openclaw plugins install -l ~/.openclaw/workspace/zalouser-free
```

### From npm (when published)

```bash
openclaw plugins install zalouser-free
```

## Configuration

Add to your OpenClaw config (`~/.openclaw/config.json5`):

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        default: {
          enabled: false, // Set to true to auto-start on gateway boot
          dmAccess: "whitelist", // "open" (anyone) or "whitelist" (only allowed users)
          groupAccess: "whitelist", // "open" (anyone) or "whitelist" (only allowed groups)
          groupReplyMode: "mention", // "mention" (only when mentioned) or "all" (reply to all messages)
          allowedUsers: [
            // List of allowed user IDs (for whitelist modes)
            "user123", // Specific user ID
            "*", // Wildcard = all users (use carefully!)
          ],
          allowedGroups: [
            // List of allowed group IDs (for whitelist modes)
            "group456", // Specific group ID
          ],
        },
        work: {
          enabled: false, // Example: second account
          dmAccess: "whitelist",
          groupAccess: "whitelist",
          groupReplyMode: "mention",
          allowedUsers: [],
          allowedGroups: [],
        },
      },
    },
  },
}
```

### Multi-Account Setup

1. **Add accounts to config** with `enabled: false` initially
2. **Login each account separately**:
   ```bash
   openclaw zalouser-free login default
   openclaw zalouser-free login work
   ```
3. **Enable accounts in config** after successful login:
   ```json5
   {
     channels: {
       "zalouser-free": {
         accounts: {
           default: { enabled: true },
           work: { enabled: true },
         },
       },
     },
   }
   ```

When `enabled: true`, the account will auto-start when OpenClaw gateway boots up.

````

## Usage

### Login (required first time)

```bash
# Login with QR code
openclaw zalouser-free login

# Login specific account
openclaw zalouser-free login myaccount

# Save QR to file instead of terminal
openclaw zalouser-free login --qr-path /tmp/zalo-qr.png
````

### Check status

```bash
openclaw zalouser-free status
openclaw zalouser-free accounts
```

### Send messages

```bash
# Send DM
openclaw zalouser-free send <userId> "Hello!"

# Send to group
openclaw zalouser-free send <groupId> "Hello group!" --group

# With specific account
openclaw zalouser-free send <userId> "Hello!" --account myaccount
```

### Stop

```bash
openclaw zalouser-free stop
```

## How it works

1. **Login**: Uses zca-js to display QR code, scanned by Zalo mobile app
2. **Session**: Credentials (cookies + IMEI) saved to `~/.openclaw/zalouser-free/sessions.json`
3. **Listening**: zca-js WebSocket listener receives real-time messages
4. **Sending**: Messages sent via zca-js API methods

## Differences from official @openclaw/zalouser

| Feature   | zalouser-free        | @openclaw/zalouser           |
| --------- | -------------------- | ---------------------------- |
| Library   | zca-js (open source) | zca binary                   |
| Cost      | Free                 | May require API costs        |
| Setup     | Simple (QR login)    | May require additional setup |
| Stability | Community maintained | Official support             |

## Access Control

The plugin supports flexible access control for privacy and security:

### DM Access Modes

- **`open`**: Accept messages from anyone who knows your bot's Zalo ID
- **`whitelist`**: Only accept messages from users in `allowedUsers` list

### Group Access Modes

- **`open`**: Accept messages from any group
- **`whitelist`**: Only accept messages from groups in `allowedGroups` list

### Group Reply Modes

- **`mention`**: Only respond when bot is @mentioned in group messages
- **`all`**: Respond to all messages in allowed groups

### Examples

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        // Personal bot - only family/friends
        default: {
          dmAccess: "whitelist",
          groupAccess: "whitelist",
          groupReplyMode: "mention",
          allowedUsers: ["friend123", "family456"],
        },
        // Public bot - anyone can message
        public: {
          dmAccess: "open",
          groupAccess: "open",
          groupReplyMode: "all",
        },
        // Group admin bot - only when mentioned
        admin: {
          dmAccess: "whitelist",
          groupAccess: "open",
          groupReplyMode: "mention",
          allowedUsers: ["admin123"],
        },
      },
    },
  },
}
```

## Troubleshooting

### "Session expired" or "Login required"

Run `openclaw zalouser-free login` again. Sessions may expire if:

- You logged in on another device/browser
- Zalo detected unusual activity
- Session cookies expired

### "Listener stopped" unexpectedly

Only one web listener can run per Zalo account. If you open Zalo Web in browser while the plugin is running, it will disconnect. Close browser Zalo first.

### QR code not displaying

- Ensure terminal supports image display (iTerm2, kitty, etc.)
- Use `--qr-path /tmp/qr.png` to save as file instead

### Access denied messages

Check your `dmAccess`/`groupAccess`/`groupReplyMode` settings in config. If using "whitelist" mode, ensure the sender's user ID is in `allowedUsers` or group ID is in `allowedGroups`. If using "mention" reply mode, ensure the bot is @mentioned in the message.

## Development

```bash
cd ~/.openclaw/workspace/zalouser-free

# Install deps
npm install

# Test plugin loading
openclaw plugins list
openclaw plugins info zalouser-free
```

## License

MIT

## Credits

- [zca-js](https://github.com/RFS-ADRENO/zca-js) - Unofficial Zalo API for JavaScript
- [OpenClaw](https://github.com/openclaw/openclaw) - AI assistant platform
