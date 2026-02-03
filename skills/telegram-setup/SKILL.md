---
name: telegram-setup
description: Set up Telegram bot integration for OpenClaw. Use when users need to connect OpenClaw to Telegram via Bot API, configure bot tokens, or set up DM/group access policies.
---

# Telegram Bot Setup

Quick guide for connecting OpenClaw to Telegram.

## Quick Setup (3 steps)

### 1. Create Bot with BotFather

1. Open Telegram and message **@BotFather**: https://t.me/BotFather
2. Send `/newbot` and follow prompts:
   - Bot name (can be anything)
   - Username (must end with `bot`)
3. Copy the token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

**Optional BotFather commands:**
- `/setjoingroups` - Allow/deny adding to groups
- `/setprivacy` - Disabled = sees all messages; Enabled = mentions only

### 2. Add Token to OpenClaw

```bash
openclaw gateway config.patch
```

Paste this config (replace `YOUR_TOKEN`):

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "YOUR_TOKEN_HERE",
      "dmPolicy": "pairing",
      "groups": {
        "*": {
          "requireMention": true
        }
      }
    }
  }
}
```

Gateway will restart automatically.

### 3. Pair with Bot

1. Find your bot on Telegram (search for the username you created)
2. Send it a message - you'll get a pairing code
3. Approve the pairing:

```bash
openclaw pairing approve telegram <CODE>
```

Done! The bot is now connected.

## Configuration Options

### DM Access Policies

```json
{
  "dmPolicy": "pairing"    // Require pairing approval (recommended)
  "dmPolicy": "open"       // Anyone can DM (risky)
  "dmPolicy": "allowlist"  // Only specific user IDs
}
```

### Group Settings

**Require mention in all groups:**
```json
{
  "groups": {
    "*": {
      "requireMention": true
    }
  }
}
```

**Allow specific groups without mention:**
```json
{
  "groups": {
    "*": {
      "requireMention": true
    },
    "-1001234567890": {
      "allow": true,
      "requireMention": false
    }
  }
}
```

To get a group's chat ID, add the bot and check logs.

### Privacy Mode (Telegram Side)

By default, Telegram bots in groups only see:
- Messages that mention them
- Commands (`/start`, etc.)

To see ALL messages in a group:
- Disable privacy mode via @BotFather: `/setprivacy` → Disable
- **OR** make the bot a group admin

**Note:** After changing privacy mode, remove and re-add the bot to groups for it to take effect.

## Multi-User Considerations

**One bot, multiple users:**
- Each user gets isolated sessions (keyed by Telegram user ID)
- Users can't see each other's conversations
- All users share rate limits and server resources
- **Bot owner can see all sessions**

**Recommended for:**
- Personal use + trusted friends/family
- Small teams (<20 people)
- Internal tools

**For public/SaaS products:**
- Each user should create their own bot + OpenClaw instance
- Provide setup script/guide for users
- Full isolation + user owns their data

## Testing

Send a message to your bot on Telegram. You should see:
- Pairing prompt (if not approved yet)
- Response from OpenClaw (after pairing)

Check logs:
```bash
openclaw logs --follow
```

List sessions:
```bash
openclaw sessions list
```

## Troubleshooting

**Bot doesn't respond:**
- Check gateway is running: `openclaw status`
- Verify token in config: `openclaw config get | grep telegram`
- Check logs: `openclaw logs --follow`

**Pairing code not working:**
- Code is case-sensitive
- Check you're using the correct format: `openclaw pairing approve telegram <CODE>`

**Bot doesn't see group messages:**
- Check privacy mode settings with @BotFather
- Try making the bot an admin
- Verify `requireMention` settings in config

**Rate limiting:**
- Telegram has per-bot limits (~30 messages/second)
- Consider multiple bots for high-traffic scenarios

## Security Notes

- Keep bot token secret (don't commit to git)
- Use `dmPolicy: "pairing"` for access control
- Bot owner can see all user sessions/conversations
- Consider one bot per user for sensitive use cases
- Revoke/regenerate compromised tokens via @BotFather
