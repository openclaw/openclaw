---
summary: "Zalo Personal (Free) plugin: installation, CLI commands, configuration, and integration guide"
read_when:
  - Installing zalouser-free plugin
  - Using zalouser-free CLI commands
  - Configuring plugin settings
title: "zalouser-free Plugin"
---

# zalouser-free Plugin

Free Personal Zalo channel plugin for OpenClaw using the [zca-js](https://github.com/RFS-ADRENO/zca-js) library.

## Overview

The `zalouser-free` plugin enables OpenClaw to communicate via personal Zalo accounts without requiring the `zca` CLI binary. It uses the open-source `zca-js` JavaScript library for all Zalo interactions.

**Plugin type:** Channel plugin  
**Status:** Experimental  
**Dependencies:** `zca-js`, `qrcode-terminal`, `jsqr`, `pngjs`

> [!CAUTION]
> This plugin uses an unofficial library. Using it may result in account suspension. Use at your own risk.

## Installation

### From Workspace

```bash
# Clone or navigate to the extension
cd ~/.openclaw/workspace/openclaw/extensions/zalouser-free

# Install dependencies
npm install

# Install plugin
openclaw plugins install -l $(pwd)
```

### From npm (when published)

```bash
openclaw plugins install zalouser-free
```

### Via Onboarding

The plugin can be installed during onboarding:

```bash
openclaw onboard
# or
openclaw configure --section channels
```

Select "Zalo Personal (Free)" from the channel list.

## Configuration

### Plugin Configuration

In `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "zalouser-free": {
        enabled: true,
        config: {
          // Optional: custom session storage path
          sessionPath: "~/.openclaw/zalouser-free/sessions.json",
        },
      },
    },
  },
}
```

### Channel Configuration

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        default: {
          enabled: false, // Enable after login
          dmAccess: "whitelist", // "open" | "whitelist"
          groupAccess: "whitelist", // "open" | "whitelist"
          groupReplyMode: "mention", // "mention" | "all"
          allowedUsers: [], // User IDs for whitelist
          allowedGroups: [], // Group IDs for whitelist
          userAgent: "", // Optional custom UA
        },
      },
    },
  },
}
```

### Configuration Schema

The plugin accepts the following configuration options:

#### Plugin Config (`plugins.entries.zalouser-free.config`)

| Field         | Type   | Default                                   | Description                       |
| ------------- | ------ | ----------------------------------------- | --------------------------------- |
| `sessionPath` | string | `~/.openclaw/zalouser-free/sessions.json` | Path to store session credentials |

#### Account Config (`channels.zalouser-free.accounts.<accountId>`)

| Field            | Type     | Default       | Description                                                                            |
| ---------------- | -------- | ------------- | -------------------------------------------------------------------------------------- |
| `enabled`        | boolean  | `false`       | Enable account on gateway startup                                                      |
| `dmAccess`       | string   | `"whitelist"` | DM access control: `"open"` or `"whitelist"`                                           |
| `groupAccess`    | string   | `"whitelist"` | Group access control: `"open"` or `"whitelist"`                                        |
| `groupReplyMode` | string   | `"mention"`   | Group reply mode: `"mention"` (only when mentioned) or `"all"` (reply to all messages) |
| `allowedUsers`   | string[] | `[]`          | Allowed user IDs (for whitelist modes)                                                 |
| `allowedGroups`  | string[] | `[]`          | Allowed group IDs (for whitelist mode)                                                 |
| `userAgent`      | string   | `""`          | Custom user agent for this account                                                     |

## CLI Commands

### `openclaw zalouser-free login [accountId]`

Login to Zalo via QR code.

**Options:**

- `--qr-path <path>` - Save QR code to file instead of terminal

**Examples:**

```bash
# Login default account
openclaw zalouser-free login

# Login specific account
openclaw zalouser-free login work

# Save QR to file
openclaw zalouser-free login --qr-path ~/zalo-qr.png
```

### `openclaw zalouser-free status [accountId]`

Check account connection status.

**Examples:**

```bash
# Check default account
openclaw zalouser-free status

# Check specific account
openclaw zalouser-free status work
```

### `openclaw zalouser-free start [accountId]`

Start listening for messages.

**Examples:**

```bash
# Start default account
openclaw zalouser-free start

# Start specific account
openclaw zalouser-free start work
```

### `openclaw zalouser-free stop [accountId]`

Stop listening and disconnect.

**Examples:**

```bash
# Stop default account
openclaw zalouser-free stop

# Stop specific account
openclaw zalouser-free stop work
```

### `openclaw zalouser-free send <threadId> <message>`

Send a text message.

**Options:**

- `-a, --account <accountId>` - Account ID (default: "default")
- `-g, --group` - Send to group instead of direct

**Examples:**

```bash
# Send DM
openclaw zalouser-free send 123456789 "Hello!"

# Send to group
openclaw zalouser-free send 987654321 "Hello group!" --group

# Use specific account
openclaw zalouser-free send 123456789 "Hi!" --account work
```

### `openclaw zalouser-free accounts`

List all connected accounts.

**Example:**

```bash
openclaw zalouser-free accounts
```

## Plugin API

The plugin registers the following components:

### Channel Plugin

**ID:** `zalouser-free`  
**Label:** "Zalo Personal (Free)"  
**Capabilities:**

- Chat types: `direct`, `group`
- Media: `text`, `sticker`

### Onboarding Adapter

Provides guided setup during `openclaw onboard`:

- QR login instructions
- Access control configuration
- Multi-account setup

### Auto-start Service

**Service ID:** `zalouser-free-autostart`

Automatically starts accounts with `enabled: true` when gateway boots.

## Usage Examples

### Basic Setup

1. **Install plugin:**

```bash
openclaw plugins install zalouser-free
```

2. **Login:**

```bash
openclaw zalouser-free login
# Scan QR code with Zalo mobile app
```

3. **Enable in config:**

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        default: {
          enabled: true,
          dmAccess: "whitelist",
          allowedUsers: ["friend123"],
        },
      },
    },
  },
}
```

4. **Restart gateway:**

```bash
openclaw gateway restart
```

### Multi-Account Setup

```json5
{
  channels: {
    "zalouser-free": {
      accounts: {
        personal: {
          enabled: true,
          dmAccess: "whitelist",
          groupAccess: "whitelist",
          groupReplyMode: "mention",
          allowedUsers: ["friend1", "friend2"],
        },
        work: {
          enabled: true,
          dmAccess: "open",
          groupAccess: "whitelist",
          groupReplyMode: "all",
          allowedGroups: ["workgroup1"],
        },
      },
    },
  },
}
```

Login each account:

```bash
openclaw zalouser-free login personal
openclaw zalouser-free login work
```

### Access Control Examples

**Personal bot (friends only):**

```json5
{
  dmAccess: "whitelist",
  groupAccess: "whitelist",
  groupReplyMode: "mention",
  allowedUsers: ["friend1", "friend2", "family1"],
}
```

**Public bot (anyone can message):**

```json5
{
  dmAccess: "open",
  groupAccess: "open",
  groupReplyMode: "all",
}
```

**Group admin bot (mention only):**

```json5
{
  dmAccess: "whitelist",
  groupAccess: "open",
  groupReplyMode: "mention",
  allowedUsers: ["admin1"],
}
```

**Specific groups only, reply to all:**

```json5
{
  dmAccess: "whitelist",
  groupAccess: "whitelist",
  groupReplyMode: "all",
  allowedUsers: ["*"],
  allowedGroups: ["group1", "group2"],
}
```

## Development

### Project Structure

```
extensions/zalouser-free/
├── channel.ts          # Channel plugin implementation
├── index.ts            # Plugin entry point
├── onboarding.ts       # Onboarding adapter
├── types.ts            # TypeScript definitions
├── package.json        # Dependencies
├── openclaw.plugin.json # Plugin metadata
├── tsconfig.json       # TypeScript config
└── README.md           # User documentation
```

### Testing

```bash
cd extensions/zalouser-free

# Install dependencies
npm install

# Test plugin loading
openclaw plugins list | grep zalouser-free

# Test plugin info
openclaw plugins info zalouser-free
```

### Debugging

Enable debug logging:

```bash
DEBUG=zalouser-free:* openclaw gateway run
```

Check session file:

```bash
cat ~/.openclaw/zalouser-free/sessions.json
```

## Troubleshooting

### Plugin not loading

Check plugin status:

```bash
openclaw plugins list
openclaw plugins info zalouser-free
```

Verify dependencies:

```bash
cd extensions/zalouser-free
npm install
```

### Session issues

Remove and re-login:

```bash
rm ~/.openclaw/zalouser-free/sessions.json
openclaw zalouser-free login
```

### Gateway not starting accounts

Check config:

- Ensure `enabled: true` for the account
- Verify `plugins.entries.zalouser-free.enabled: true`
- Check gateway logs for errors

## Security Considerations

- **Session storage:** Sessions stored in `~/.openclaw/zalouser-free/sessions.json`
- **Credentials:** Contains cookies and IMEI - keep secure
- **Access control:** Use `whitelist` mode for better security
- **Multi-user:** Use `dmAccess: "whitelist"` to restrict access
- **Account safety:** Monitor for unusual activity

## Related Documentation

- Channel docs: [Zalo Personal (Free)](/channels/zalouser-free)
- Official Zalo: [Zalo Personal](/channels/zalouser)
- Plugin system: [Plugins](/tools/plugins)
- Access control: [Pairing](/start/pairing)

## Support

- GitHub: [openclaw/openclaw](https://github.com/openclaw/openclaw)
- zca-js: [RFS-ADRENO/zca-js](https://github.com/RFS-ADRENO/zca-js)
