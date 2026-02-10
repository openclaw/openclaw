# @openclaw/twitch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Twitch channel plugin for OpenClaw.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install (local checkout)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install ./extensions/twitch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Install (npm)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
openclaw plugins install @openclaw/twitch（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Onboarding: select Twitch and confirm the install prompt to fetch the plugin automatically.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Config（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Minimal config (simplified single-account):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**⚠️ Important:** `requireMention` defaults to `true`. Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      username: "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accessToken: "oauth:abc123...", // OAuth Access Token (add oauth: prefix)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      clientId: "xyz789...", // Client ID from Token Generator（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      channel: "vevisk", // Channel to join (required)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only (Convert your twitch username to ID at https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
**Access control options:**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `requireMention: false` - Disable the default mention requirement to respond to all messages（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowFrom: ["your_user_id"]` - Restrict to your Twitch user ID only (find your ID at https://www.twitchangles.com/xqc or similar)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `allowedRoles: ["moderator", "vip", "subscriber"]` - Restrict to specific roles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Multi-account config (advanced):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    twitch: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      enabled: true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      accounts: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        default: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
## Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Create a dedicated Twitch account for the bot, then generate credentials: [Twitch Token Generator](https://twitchtokengenerator.com/)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Select **Bot Token**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Verify scopes `chat:read` and `chat:write` are selected（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Copy the **Access Token** to `token` property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
   - Copy the **Client ID** to `clientId` property（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Start the gateway（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Full documentation（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
See https://docs.openclaw.ai/channels/twitch for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Token refresh setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Access control patterns（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-account configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Troubleshooting（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Capabilities & limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
