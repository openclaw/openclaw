# @openclaw/bluesky

Bluesky DM channel plugin for OpenClaw using the AT Protocol.

## Overview

This extension adds Bluesky as a messaging channel to OpenClaw. It enables your bot to:

- Receive DMs from Bluesky users
- Send responses back
- Work with the official Bluesky app and any AT Protocol client

## Installation

```bash
openclaw plugins install @openclaw/bluesky
```

## Quick Setup

1. Create an app password at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords)
   - **Important**: Check "Allow access to direct messages"

2. Add to your config:

   ```json
   {
     "channels": {
       "bluesky": {
         "identifier": "${BLUESKY_IDENTIFIER}",
         "appPassword": "${BLUESKY_APP_PASSWORD}"
       }
     }
   }
   ```

3. Set the environment variables:

   ```bash
   export BLUESKY_IDENTIFIER="your-handle.bsky.social"
   export BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   ```

4. Restart the gateway

## Configuration

| Key              | Type     | Default                 | Description                                                |
| ---------------- | -------- | ----------------------- | ---------------------------------------------------------- |
| `identifier`     | string   | required                | Bluesky handle or DID                                      |
| `appPassword`    | string   | required                | App password (with DM scope)                               |
| `service`        | string   | `"https://bsky.social"` | PDS service URL                                            |
| `pollIntervalMs` | number   | `5000`                  | DM polling interval (ms)                                   |
| `dmPolicy`       | string   | `"pairing"`             | Access control: `pairing`, `allowlist`, `open`, `disabled` |
| `allowFrom`      | string[] | `[]`                    | Allowed sender DIDs or handles                             |
| `enabled`        | boolean  | `true`                  | Enable/disable the channel                                 |
| `name`           | string   | -                       | Display name for the account                               |

## Access Control

### DM Policies

- **pairing** (default): Unknown senders receive a pairing code to request access
- **allowlist**: Only DIDs/handles in `allowFrom` can message the bot
- **open**: Anyone can message the bot (use with caution)
- **disabled**: DMs are disabled

### Example: Allowlist Mode

```json
{
  "channels": {
    "bluesky": {
      "identifier": "${BLUESKY_IDENTIFIER}",
      "appPassword": "${BLUESKY_APP_PASSWORD}",
      "dmPolicy": "allowlist",
      "allowFrom": ["did:plc:abc123...", "friend.bsky.social"]
    }
  }
}
```

## Security Notes

- App passwords are never logged
- Use environment variables for credentials, never commit to config files
- Create a dedicated app password for OpenClaw (you can revoke it independently)
- Consider using `allowlist` mode in production

## Troubleshooting

### Bot not receiving messages

1. Verify identifier and app password are correctly configured
2. Ensure the app password has DM scope enabled
3. Check that `enabled` is not set to `false`
4. Check gateway logs for authentication errors

### "Bad token scope" error

Your app password doesn't have DM permissions. Create a new one at [bsky.app/settings/app-passwords](https://bsky.app/settings/app-passwords) and check "Allow access to direct messages".

## License

MIT
