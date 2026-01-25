---
summary: "Twitch chat bot support status, capabilities, and configuration"
read_when:
  - Setting up Twitch chat integration for Clawdbot
  - Configuring Twitch bot permissions and access control
---
# Twitch (plugin)

Twitch chat support via IRC connection. Clawdbot connects as a Twitch user (bot account) to receive and send messages in channels.

Status: ready for Twitch chat via IRC connection with @twurple.

## Quick setup (beginner)
1) Install the Twitch plugin and create a Twitch application.
2) Generate your OAuth token (recommended: use [Twitch Token Generator](https://twitchtokengenerator.com/)).
3) Set the token for Clawdbot:
   - Env: `CLAWDBOT_TWITCH_ACCESS_TOKEN=...` (default account only)
   - Or config: `channels.twitch.accounts.default.token`
   - If both are set, config takes precedence (env fallback is default-account only).
4) Start the gateway.
5) The bot joins your channel and responds to messages.

Minimal config:
```json5
{
  channels: {
    twitch: {
      enabled: true,
      accounts: {
        default: {
          username: "clawdbot",              // Bot's Twitch account
          token: "oauth:abc123...",          // Or omit to use CLAWDBOT_TWITCH_ACCESS_TOKEN env var
          clientId: "your_client_id_here",
          channel: "vevisk"                  // Which Twitch channel's chat to join
        }
      }
    }
  }
}
```

**Note:** `username` is the bot's account, `channel` is which chat to join.

## How it works
1. Create a Twitch application and bot account (or use an existing account).
2. Configure Clawdbot with `channels.twitch.accounts.default.token` (or `CLAWDBOT_TWITCH_ACCESS_TOKEN` as a fallback).
3. Run the gateway; it auto-starts the Twitch channel when a token is available (config first, env fallback) and `channels.twitch.enabled` is not `false`.
4. The bot joins the specified `channel` to send/receive messages.
5. Direct chats collapse into the agent's main session (default `agent:main:main`); each account maps to an isolated session key `agent:<agentId>:twitch:<accountName>`.

**Key distinction:** `username` is who the bot authenticates as (the bot's account), `channel` is which chat room it joins.

## Plugin required

Twitch ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
clawdbot plugins install @clawdbot/twitch
```

Local checkout (when running from a git repo):

```bash
clawdbot plugins install ./extensions/twitch
```

Details: [Plugins](/plugin)

## Setup

### 1) Create a Twitch application
- Go to [Twitch Developer Console](https://dev.twitch.tv/console)
- Click "Register Your Application"
- Set Application Type to "Chat Bot"
- Copy the **Client ID**

### 2) Generate your OAuth token (recommended: Twitch Token Generator)
- Use [Twitch Token Generator](https://twitchtokengenerator.com/)
- Select scopes: `chat:read` and `chat:write`
- Copy the token (starts with `oauth:`)

### 3) Configure credentials
Env (default account only):

```bash
export CLAWDBOT_TWITCH_ACCESS_TOKEN=oauth:your_token_here
```

Or config:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      accounts: {
        default: {
          username: "clawdbot",              // Bot's Twitch account
          token: "oauth:abc123...",          // Or omit to use CLAWDBOT_TWITCH_ACCESS_TOKEN env var
          clientId: "your_client_id_here",
          channel: "vevisk"                  // Which Twitch channel's chat to join
        }
      }
    }
  }
}
```

**Note:** `username` is the bot's account, `channel` is which chat to join.

With env, you still need `clientId` and `channel` in config (or use the minimal config above without `token`).

### 4) Start the gateway
Twitch starts when a token is resolved (config first, env fallback).

### 5) Join a channel
The bot joins the channel specified in `channel`.

## Token refresh (optional, recommended for long-running bots)

For long-running bots, configure automatic token refresh to avoid expired tokens:

1. Use [Twitch Token Generator](https://twitchtokengenerator.com/) with **"Include Refresh Token"** checked
2. Get your **Client Secret** from [Twitch Developer Console](https://dev.twitch.tv/console)
3. Add to config:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "clawdbot",
          token: "oauth:abc123...",
          clientId: "your_client_id",
          clientSecret: "your_client_secret",
          refreshToken: "your_refresh_token",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000
        }
      }
    }
  }
}
```

The bot automatically refreshes tokens before they expire and logs refresh events.

## Routing model
- Replies always go back to Twitch.
- Each account maps to `agent:<agentId>:twitch:<accountName>`.

## Multi-account support

Use `channels.twitch.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

Example (one bot account in two different channels):

```json5
{
  channels: {
    twitch: {
      accounts: {
        ninjaChannel: {
          username: "clawdbot",
          token: "oauth:...",
          clientId: "...",
          channel: "vevisk"
        },
        shroudChannel: {
          username: "clawdbot",
          token: "oauth:...",
          clientId: "...",
          channel: "secondchannel"
        }
      }
    }
  }
}
```

## Access control

### Role-based restrictions (recommended)

Restrict access to specific roles:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "mybot",
          token: "oauth:...",
          clientId: "...",
          channel: "your_channel",
          allowedRoles: ["moderator", "vip"]
        }
      }
    }
  }
}
```

**Available roles:**
- `"moderator"` - Channel moderators
- `"owner"` - Channel owner/broadcaster
- `"vip"` - VIPs
- `"subscriber"` - Subscribers
- `"all"` - Anyone in chat

### Allowlist by User ID

Only allow specific Twitch user IDs (most secure):

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "mybot",
          token: "oauth:...",
          clientId: "...",
          channel: "your_channel",
          allowFrom: ["123456789", "987654321"]
        }
      }
    }
  }
}
```

**Why user IDs instead of usernames?** Twitch usernames can change, which could allow someone to hijack another user's access. User IDs are permanent.

Find your Twitch user ID at: https://www.streamweasels.com/tools/convert-your-twitch-username-to-user-id/

### Combined allowlist + roles

Users in `allowFrom` bypass role checks. In this example:
- User `123456789` can always message (bypasses role check)
- All moderators can message
- Everyone else is blocked

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "mybot",
          token: "oauth:...",
          clientId: "...",
          channel: "your_channel",
          allowFrom: ["123456789"],
          allowedRoles: ["moderator"]
        }
      }
    }
  }
}
```

### Require @mention

Only respond when the bot is mentioned:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "mybot",
          token: "oauth:...",
          clientId: "...",
          channel: "your_channel",
          requireMention: true
        }
      }
    }
  }
}
```

## Environment variables

For the default account, you can use environment variables instead of config:

- `CLAWDBOT_TWITCH_ACCESS_TOKEN` - OAuth token (with `oauth:` prefix)

Env fallback only works for the default account. For multi-account setups, use config.

Example:

```bash
export CLAWDBOT_TWITCH_ACCESS_TOKEN=oauth:abc123def456...
```

Config with env fallback:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      accounts: {
        default: {
          username: "mybot",
          clientId: "your_client_id",
          channel: "your_channel"
          // token will be read from CLAWDBOT_TWITCH_ACCESS_TOKEN
        }
      }
    }
  }
}
```

Priority: account config > base config > env var (for default account only).

## Plugin options

Control markdown stripping behavior:

```json5
{
  plugins: {
    entries: {
      twitch: {
        stripMarkdown: true
      }
    }
  }
}
```

- `stripMarkdown` (default: `true`) - Remove markdown formatting before sending to Twitch

Twitch doesn't support markdown, so this is enabled by default. Disable if you want to send markdown as-is (it will appear as plain text with markdown symbols).

## Capabilities & limits

**Supported:**
- ✅ Channel messages (group chat)
- ✅ Whispers/DMs (received but replies not supported - Twitch doesn't allow bots to send whispers)
- ✅ Markdown stripping (automatically applied)
- ✅ Message chunking (500 char limit)
- ✅ Access control (user ID allowlist, role-based)
- ✅ @mention requirement
- ✅ Automatic token refresh (with RefreshingAuthProvider)
- ✅ Multi-account support

**Not supported:**
- ❌ Native reactions
- ❌ Threaded replies
- ❌ Message editing
- ❌ Message deletion
- ❌ Rich embeds/media uploads (sends media URLs as text)

## Troubleshooting

First, run diagnostic commands:

```bash
clawdbot doctor
clawdbot channels status --probe
```

### Bot doesn't respond to messages

**Check access control:**
```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          username: "mybot",
          token: "oauth:...",
          clientId: "...",
          channel: "your_channel",
          // Temporary: allow everyone
          allowedRoles: ["all"]
        }
      }
    }
  }
}
```

**Check the bot is in the channel:** The bot must join the channel specified in `channel`.

### Token issues

**"Failed to connect" or authentication errors:**
- Verify token starts with `oauth:`
- Check token has `chat:read` and `chat:write` scopes
- If using RefreshingAuthProvider, verify `clientSecret` and `refreshToken` are set

### Token refresh not working

**Check logs for refresh events:**
```
[twitch] Using env token source for mybot
[twitch] Access token refreshed for user 123456 (expires in 14400s)
```

If you see "token refresh disabled (no refresh token)":
- Ensure `clientSecret` is provided
- Ensure `refreshToken` is provided (from Twitch Token Generator with "Include Refresh Token" checked)

## Configuration reference (Twitch)

Full configuration: [Configuration](/gateway/configuration)

### Account config

```typescript
{
  username: string,           // Bot username
  token: string,              // OAuth token with chat:read and chat:write
  clientId: string,           // Twitch Client ID
  channel: string,            // Channel to join
  enabled?: boolean,          // Enable this account (default: true)
  clientSecret?: string,      // For RefreshingAuthProvider
  refreshToken?: string,      // For RefreshingAuthProvider
  expiresIn?: number,         // Token expiry in seconds
  obtainmentTimestamp?: number, // Token obtained timestamp
  allowFrom?: string[],       // User ID allowlist
  allowedRoles?: TwitchRole[], // Role-based access control
  requireMention?: boolean    // Require @mention (default: false)
}
```

**TwitchRole:** `"moderator"` | `"owner"` | `"vip"` | `"subscriber"` | `"all"`

### Plugin config

```typescript
{
  stripMarkdown?: boolean  // Strip markdown from outbound (default: true)
}
```

Provider options:
- `channels.twitch.enabled`: enable/disable channel startup.
- `channels.twitch.accounts.<accountName>.username`: bot username.
- `channels.twitch.accounts.<accountName>.token`: OAuth token.
- `channels.twitch.accounts.<accountName>.clientId`: Twitch Client ID.
- `channels.twitch.accounts.<accountName>.channel`: channel to join.
- `channels.twitch.accounts.<accountName>.enabled`: enable/disable account (default: true).
- `channels.twitch.accounts.<accountName>.clientSecret`: for RefreshingAuthProvider.
- `channels.twitch.accounts.<accountName>.refreshToken`: for RefreshingAuthProvider.
- `channels.twitch.accounts.<accountName>.expiresIn`: token expiry in seconds.
- `channels.twitch.accounts.<accountName>.obtainmentTimestamp`: token obtained timestamp.
- `channels.twitch.accounts.<accountName>.allowFrom`: user ID allowlist.
- `channels.twitch.accounts.<accountName>.allowedRoles`: role-based access control.
- `channels.twitch.accounts.<accountName>.requireMention`: require @mention (default: false).

## Tool actions

The agent can call `twitch` with action:

- `send` - Send a message to a channel

Example:

```json5
{
  "action": "twitch",
  "params": {
    "message": "Hello Twitch!",
    "to": "#mychannel"
  }
}
```

## Safety & ops

- **Treat tokens like passwords** - Never commit tokens to git
- **Use RefreshingAuthProvider** for long-running bots
- **Use user ID allowlists** instead of usernames for access control
- **Monitor logs** for token refresh events and connection status
- **Scope tokens minimally** - Only request `chat:read` and `chat:write`
- **If stuck**: Restart the gateway after confirming no other process owns the session

## Message limits

- **500 characters** per message (Twitch limit)
- Messages are automatically chunked at word boundaries
- Markdown is stripped before chunking to avoid breaking patterns
- No rate limiting (uses Twitch's built-in rate limits)
