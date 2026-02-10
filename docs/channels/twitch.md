---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Twitch chat bot configuration and setup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Setting up Twitch chat integration for OpenClaw（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Twitch"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Twitch (plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Twitch chat support via IRC connection. OpenClaw connects as a Twitch user (bot account) to receive and send messages in channels.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin required（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Twitch ships as a plugin and is not bundled with the core install.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install via CLI (npm registry):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/twitch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Local checkout (when running from a git repo):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/twitch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Details: [Plugins](/tools/plugin)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick setup (beginner)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a dedicated Twitch account for the bot (or use an existing account).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Generate credentials: [Twitch Token Generator](https://twitchtokengenerator.com/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Select **Bot Token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Verify scopes `chat:read` and `chat:write` are selected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Copy the **Client ID** and **Access Token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Find your Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. Configure the token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (default account only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Or config: `channels.twitch.accessToken`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - If both are set, config takes precedence (env fallback is default-account only).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. Start the gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**⚠️ Important:** Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot. `requireMention` defaults to `true`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      username: "openclaw", // Bot's Twitch account（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientId: "xyz789...", // Client ID from Token Generator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channel: "vevisk", // Which Twitch channel's chat to join (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## What it is（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- A Twitch channel owned by the Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Deterministic routing: replies always go back to Twitch.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each account maps to an isolated session key `agent:<agentId>:twitch:<accountName>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `username` is the bot's account (who authenticates), `channel` is which chat room to join.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Setup (detailed)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Generate credentials（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use [Twitch Token Generator](https://twitchtokengenerator.com/):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Select **Bot Token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify scopes `chat:read` and `chat:write` are selected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Copy the **Client ID** and **Access Token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No manual app registration needed. Tokens expire after several hours.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Configure the bot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Env var (default account only):**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Or config:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      username: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "oauth:abc123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientId: "xyz789...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channel: "vevisk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If both env and config are set, config takes precedence.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Access control (recommended)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Available roles:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Why user IDs?** Usernames can change, allowing impersonation. User IDs are permanent.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Find your Twitch user ID: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Convert your Twitch username to ID)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Token refresh (optional)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tokens from [Twitch Token Generator](https://twitchtokengenerator.com/) cannot be automatically refreshed - regenerate when expired.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
For automatic token refresh, create your own Twitch application at [Twitch Developer Console](https://dev.twitch.tv/console) and add to config:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientSecret: "your_client_secret",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      refreshToken: "your_refresh_token",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The bot automatically refreshes tokens before expiration and logs refresh events.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Multi-account support（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example (one bot account in two channels):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel1: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          username: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          accessToken: "oauth:abc123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          clientId: "xyz789...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channel: "vevisk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        channel2: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          username: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          accessToken: "oauth:def456...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          clientId: "uvw012...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channel: "secondchannel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Note:** Each account needs its own token (one token per channel).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Role-based restrictions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedRoles: ["moderator", "vip"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Allowlist by User ID (most secure)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowFrom: ["123456789", "987654321"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Role-based access (alternative)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedRoles: ["moderator"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Disable @mention requirement（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default, `requireMention` is `true`. To disable and respond to all messages:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          requireMention: false,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
First, run diagnostic commands:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw doctor（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw channels status --probe（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Bot doesn't respond to messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check access control:** Ensure your user ID is in `allowFrom`, or temporarily remove（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`allowFrom` and set `allowedRoles: ["all"]` to test.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check the bot is in the channel:** The bot must join the channel specified in `channel`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Token issues（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**"Failed to connect" or authentication errors:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Verify `accessToken` is the OAuth access token value (typically starts with `oauth:` prefix)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Check token has `chat:read` and `chat:write` scopes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If using token refresh, verify `clientSecret` and `refreshToken` are set（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Token refresh not working（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Check logs for refresh events:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Using env token source for mybot（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Access token refreshed for user 123456 (expires in 14400s)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If you see "token refresh disabled (no refresh token)":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure `clientSecret` is provided（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure `refreshToken` is provided（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Account config:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `username` - Bot username（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `accessToken` - OAuth access token with `chat:read` and `chat:write`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clientId` - Twitch Client ID (from Token Generator or your app)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channel` - Channel to join (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `enabled` - Enable this account (default: `true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `clientSecret` - Optional: For automatic token refresh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `refreshToken` - Optional: For automatic token refresh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `expiresIn` - Token expiry in seconds（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `obtainmentTimestamp` - Token obtained timestamp（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowFrom` - User ID allowlist（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowedRoles` - Role-based access control (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention` - Require @mention (default: `true`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Provider options:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.enabled` - Enable/disable channel startup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.username` - Bot username (simplified single-account config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.accessToken` - OAuth access token (simplified single-account config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.clientId` - Twitch Client ID (simplified single-account config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.channel` - Channel to join (simplified single-account config)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Full example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      username: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "oauth:abc123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientId: "xyz789...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channel: "vevisk",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientSecret: "secret123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      refreshToken: "refresh456...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["123456789"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowedRoles: ["moderator", "vip"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          username: "mybot",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          accessToken: "oauth:abc123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          clientId: "xyz789...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          channel: "your_channel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          clientSecret: "secret123...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          refreshToken: "refresh456...",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          expiresIn: 14400,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          obtainmentTimestamp: 1706092800000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowFrom: ["123456789", "987654321"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          allowedRoles: ["moderator"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Tool actions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The agent can call `twitch` with action:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `send` - Send a message to a channel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  action: "twitch",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  params: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    message: "Hello Twitch!",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    to: "#mychannel",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Safety & ops（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Treat tokens like passwords** - Never commit tokens to git（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use automatic token refresh** for long-running bots（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Use user ID allowlists** instead of usernames for access control（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Monitor logs** for token refresh events and connection status（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Scope tokens minimally** - Only request `chat:read` and `chat:write`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **If stuck**: Restart the gateway after confirming no other process owns the session（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **500 characters** per message (auto-chunked at word boundaries)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Markdown is stripped before chunking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- No rate limiting (uses Twitch's built-in rate limits)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
