---
summary: "Zalo Personal (Free) channel: QR login, messaging via zca-js library, configuration, and access control"
read_when:
  - Setting up Zalo Personal messaging with free library
  - Configuring zalouser-free channel
  - Troubleshooting zca-js integration
title: "Zalo Personal (Free)"
---

# Zalo Personal (Free)

Status: **experimental**. This integration uses the **unofficial** `zca-js` library to automate a personal Zalo account.

## ⚠️ Important Warning

> [!CAUTION]
> Using this plugin could result in your Zalo account being locked or banned. The `zca-js` library is unofficial and simulates browser interactions. **Use at your own risk.**

For production use or official support, consider the official [Zalo Personal](/channels/zalouser) channel which uses the `zca` CLI binary.

## Overview

The `zalouser-free` channel plugin enables OpenClaw to send and receive messages through a personal Zalo account using the open-source [zca-js](https://github.com/RFS-ADRENO/zca-js) library.

**Key features:**

- ✅ QR code login (no API keys needed)
- ✅ Session persistence and auto-reconnect
- ✅ Send/receive text messages
- ✅ Direct messages (DM) and group messages
- ✅ Send stickers
- ✅ Reply/quote messages
- ✅ Multi-account support
- ✅ Granular access control (DM and group policies)
- ⏳ Image/file attachments (planned)

## Prerequisites

The plugin automatically installs `zca-js` and its dependencies when you install the plugin. No manual setup required.

## Installation

### Via Plugin System

```bash
# Install from local workspace
openclaw plugins install -l ~/.openclaw/workspace/openclaw/extensions/zalouser-free

# Or from npm (when published)
openclaw plugins install zalouser-free
```

### Via Onboarding

The plugin appears in the channel selection during `openclaw onboard` or `openclaw configure --section channels`.

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        default: {
          enabled: false, // Set to true after login to auto-start
          dmAccess: "whitelist", // "open" or "whitelist"
          groupAccess: "mention", // "open", "mention", or "whitelist"
          allowedUsers: [
            // For whitelist/mention modes
            "user123",
            "user456",
          ],
          allowedGroups: [
            // For whitelist mode
            "group789",
          ],
          userAgent: "", // Optional custom user agent
        },
      },
    },
  },
  plugins: {
    entries: {
      "zalouser-free": {
        enabled: true,
        config: {
          sessionPath: null, // Optional: custom session storage path
        },
      },
    },
  },
}
```

### Access Control

The plugin supports flexible access control to protect your privacy:

#### DM Access Modes

- **`whitelist`** (default): Only accept messages from users in `allowedUsers` list
- **`open`**: Accept messages from anyone who knows your Zalo ID

#### Group Access Modes

- **`mention`** (default): Only respond when bot is @mentioned in group messages
- **`open`**: Accept messages from anyone in any group
- **`whitelist`**: Only accept messages from users in `allowedUsers` OR groups in `allowedGroups`

#### Wildcard Support

Use `"*"` in `allowedUsers` or `allowedGroups` to allow all:

```json5
{
  allowedUsers: ["*"], // Allow all users
  allowedGroups: ["*"], // Allow all groups
}
```

## Usage

### Login (Required First Time)

```bash
# Login with QR code (default account)
openclaw zalouser-free login

# Login specific account
openclaw zalouser-free login myaccount

# Save QR to file instead of terminal
openclaw zalouser-free login --qr-path /tmp/zalo-qr.png
```

**Login flow:**

1. Run the login command
2. A QR code appears in your terminal (or saved to file)
3. Open Zalo mobile app → Settings → Linked Devices → Scan QR code
4. Confirm on your mobile device
5. Session is saved automatically

### Enable Account

After successful login, enable the account in your config:

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        default: {
          enabled: true, // Change to true
        },
      },
    },
  },
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Check Status

```bash
# Check account status
openclaw zalouser-free status

# List all accounts
openclaw zalouser-free accounts
```

### Send Messages

```bash
# Send DM
openclaw zalouser-free send <userId> "Hello!"

# Send to group
openclaw zalouser-free send <groupId> "Hello group!" --group

# With specific account
openclaw zalouser-free send <userId> "Hello!" --account myaccount
```

### Start/Stop Manually

```bash
# Start listening (if not auto-started)
openclaw zalouser-free start

# Stop listening
openclaw zalouser-free stop
```

## Multi-Account Setup

You can run multiple Zalo accounts simultaneously:

1. **Add accounts to config** with `enabled: false`:

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        personal: { enabled: false, dmAccess: "whitelist", allowedUsers: ["friend123"] },
        work: { enabled: false, dmAccess: "open", groupAccess: "mention" },
      },
    },
  },
}
```

2. **Login each account separately:**

```bash
openclaw zalouser-free login personal
openclaw zalouser-free login work
```

3. **Enable accounts** after successful login:

```json5
{
  accounts: {
    personal: { enabled: true },
    work: { enabled: true },
  },
}
```

4. **Restart gateway** to activate all accounts.

## How It Works

1. **Login**: Uses `zca-js` to display QR code, scanned by Zalo mobile app
2. **Session**: Credentials (cookies + IMEI) saved to `~/.openclaw/zalouser-free/sessions.json`
3. **Listening**: `zca-js` WebSocket listener receives real-time messages
4. **Access Control**: Messages filtered by `dmAccess`/`groupAccess` settings before processing
5. **Sending**: Messages sent via `zca-js` API methods

## Capabilities

### Supported

- ✅ Text messages (send/receive)
- ✅ Stickers (send/receive)
- ✅ Quote/reply to messages
- ✅ Direct messages
- ✅ Group messages
- ✅ Multi-account
- ✅ Session persistence

### Planned

- ⏳ Image attachments
- ⏳ File attachments
- ⏳ Voice messages
- ⏳ Video messages

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
- Check that `qrcode-terminal`, `jsqr`, and `pngjs` packages are installed

### Access denied messages

Check your `dmAccess`/`groupAccess` settings in config:

- If using `whitelist` mode, ensure sender's user ID is in `allowedUsers`
- If using group `whitelist`, ensure group ID is in `allowedGroups`
- For `mention` mode, ensure bot is @mentioned in the message

### Account suspended/banned

If your Zalo account gets suspended:

1. Stop using the plugin immediately
2. Contact Zalo support to appeal
3. Consider using the official [Zalo Personal](/channels/zalouser) channel instead

### Dependencies not installed

If you see errors about missing packages:

```bash
cd ~/.openclaw/workspace/openclaw/extensions/zalouser-free
npm install
```

## Differences from Official zalouser

| Feature        | zalouser-free           | @openclaw/zalouser            |
| -------------- | ----------------------- | ----------------------------- |
| Library        | zca-js (open source)    | zca binary                    |
| Cost           | Free                    | May require API costs         |
| Setup          | Simple (QR login)       | Requires zca-cli installation |
| Stability      | Community maintained    | Official support              |
| Risk           | Account suspension risk | Lower risk                    |
| Access Control | dmAccess/groupAccess    | dmPolicy/groupPolicy          |

## Security Notes

- Sessions are stored in `~/.openclaw/zalouser-free/sessions.json`
- Credentials include cookies and IMEI
- Use `dmAccess: "whitelist"` for better security
- Never share your session file
- Use different accounts for testing vs production

## Related Documentation

- Plugin docs: [zalouser-free plugin](/plugins/zalouser-free)
- Official Zalo channel: [Zalo Personal](/channels/zalouser)
- Access control: [Pairing](/start/pairing)
- Multi-account: [Agent workspace](/concepts/agent-workspace)

## Support

- GitHub Issues: [openclaw/openclaw](https://github.com/openclaw/openclaw/issues)
- zca-js library: [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js)
