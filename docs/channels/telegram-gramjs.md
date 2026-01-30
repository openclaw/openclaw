---
summary: "Telegram user account support via GramJS/MTProto - access cloud chats as your personal account"
read_when:
  - Working on Telegram user account features
  - Need access to personal DMs and groups
  - Want to use Telegram without creating a bot
---
# Telegram (GramJS / User Account)

**Status:** Beta (Phase 1 complete - DMs and groups)

Connect openclaw to your **personal Telegram account** using GramJS (MTProto protocol). This allows the agent to access your DMs, groups, and channels as *you* — no bot required.

## Quick Setup

1. **Get API credentials** from [https://my.telegram.org/apps](https://my.telegram.org/apps)
   - `api_id` (integer)
   - `api_hash` (string)
   
2. **Run the setup wizard:**
   ```bash
   openclaw setup telegram-gramjs
   ```
   
3. **Follow the prompts:**
   - Enter your phone number (format: +12025551234)
   - Enter SMS verification code
   - Enter 2FA password (if enabled on your account)
   
4. **Done!** The session is saved to your config file.

## What It Is

- A **user account** channel (not a bot)
- Uses **GramJS** (JavaScript implementation of Telegram's MTProto protocol)
- Access to **all your chats**: DMs, groups, channels (as yourself)
- **Session persistence** via encrypted StringSession
- **Routing rules**: DMs → main session, Groups → isolated sessions

## When to Use GramJS vs Bot API

| Feature | GramJS (User Account) | Bot API (grammY) |
|---------|----------------------|------------------|
| **Access** | Your personal account | Separate bot account |
| **DMs** | ✅ All your DMs | ✅ Only DMs to the bot |
| **Groups** | ✅ All your groups | ❌ Only groups with bot added |
| **Channels** | ✅ Subscribed channels | ❌ Not supported |
| **Read History** | ✅ Full message history | ❌ Only new messages |
| **Setup** | API credentials + phone auth | Bot token from @BotFather |
| **Privacy** | You are the account | Separate bot identity |
| **Rate Limits** | Strict (user account limits) | More lenient (bot limits) |

**Use GramJS when:**
- You want the agent to access your personal Telegram
- You need full chat history access
- You want to avoid creating a separate bot

**Use Bot API when:**
- You want a separate bot identity
- You need webhook support (not yet in GramJS)
- You prefer simpler setup (just a token)

## Configuration

### Basic Setup (Single Account)

```json5
{
  channels: {
    telegramGramjs: {
      enabled: true,
      apiId: 123456,
      apiHash: "your_api_hash_here",
      phoneNumber: "+12025551234",
      sessionString: "encrypted_session_data",
      dmPolicy: "pairing",
      groupPolicy: "open"
    }
  }
}
```

### Multi-Account Setup

```json5
{
  channels: {
    telegramGramjs: {
      enabled: true,
      accounts: {
        personal: {
          name: "Personal Account",
          apiId: 123456,
          apiHash: "hash1",
          phoneNumber: "+12025551234",
          sessionString: "session1",
          dmPolicy: "pairing"
        },
        work: {
          name: "Work Account",
          apiId: 789012,
          apiHash: "hash2",
          phoneNumber: "+15551234567",
          sessionString: "session2",
          dmPolicy: "allowlist",
          allowFrom: ["+15559876543"]
        }
      }
    }
  }
}
```

### Environment Variables

You can set credentials via environment variables:

```bash
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=your_api_hash
export TELEGRAM_SESSION_STRING=your_encrypted_session
```

**Note:** Config file values take precedence over environment variables.

## Getting API Credentials

1. Go to [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your phone number
3. Click **"API Development Tools"**
4. Fill out the form:
   - **App title:** openclaw
   - **Short name:** openclaw-gateway
   - **Platform:** Other
   - **Description:** Personal agent gateway
5. Click **"Create application"**
6. Save your `api_id` and `api_hash`

**Important notes:**
- `api_id` and `api_hash` are **NOT secrets** — they identify your app, not your account
- The **session string** is the secret — keep it encrypted and secure
- You can use the same API credentials for multiple phone numbers

## Authentication Flow

The interactive setup wizard (`openclaw setup telegram-gramjs`) handles:

### 1. Phone Number
```
Enter your phone number (format: +12025551234): +12025551234
```

**Format rules:**
- Must start with `+`
- Country code required
- 10-15 digits total
- Example: `+12025551234` (US), `+442071234567` (UK)

### 2. SMS Code
```
📱 A verification code has been sent to your phone via SMS.
Enter the verification code: 12345
```

**Telegram will send a 5-digit code to your phone.**

### 3. Two-Factor Authentication (if enabled)
```
🔒 Your account has Two-Factor Authentication enabled.
Enter your 2FA password: ********
```

**Only required if you have 2FA enabled on your Telegram account.**

### 4. Session Saved
```
✅ Authentication successful!
Session string generated. This will be saved to your config.
```

The encrypted session string is saved to your config file.

## Session Management

### Session Persistence

After successful authentication, a **StringSession** is generated and saved:

```json5
{
  sessionString: "encrypted_base64_session_data"
}
```

This session remains valid until:
- You explicitly log out via Telegram settings
- Telegram detects suspicious activity
- You hit the max concurrent sessions limit (~10)

### Session Security

**⚠️ IMPORTANT: Session strings are sensitive credentials!**

- Session strings grant **full access** to your account
- Store them **encrypted** (openclaw does this automatically)
- Never commit session strings to git
- Never share session strings with anyone

If a session is compromised:
1. Go to Telegram Settings → Privacy → Active Sessions
2. Terminate the suspicious session
3. Re-run `openclaw setup telegram-gramjs` to create a new session

### Session File Storage (Alternative)

Instead of storing in config, you can use a session file:

```json5
{
  sessionFile: "~/.config/openclaw/sessions/telegram-personal.session"
}
```

The file will be encrypted automatically.

## DM Policies

Control who can send DMs to your account:

```json5
{
  dmPolicy: "pairing",  // "pairing", "open", "allowlist", "closed"
  allowFrom: ["+12025551234", "@username", "123456789"]
}
```

| Policy | Behavior |
|--------|----------|
| `pairing` | First contact requires approval (default) |
| `open` | Accept DMs from anyone |
| `allowlist` | Only accept from `allowFrom` list |
| `closed` | Reject all DMs |

## Group Policies

Control how the agent responds in groups:

```json5
{
  groupPolicy: "open",  // "open", "allowlist", "closed"
  groupAllowFrom: ["@groupusername", "-100123456789"],
  groups: {
    "-100123456789": {  // Specific group ID
      requireMention: true,
      allowFrom: ["@alice", "@bob"]
    }
  }
}
```

### Group Settings

- **`requireMention`:** Only respond when mentioned (default: true)
- **`allowFrom`:** Allowlist of users who can trigger the agent
- **`autoReply`:** Enable auto-reply in this group

### Group IDs

GramJS uses Telegram's internal group IDs:
- Format: `-100{channel_id}` (e.g., `-1001234567890`)
- Find group ID: Send a message in the group, check logs for `chatId`

## Message Routing

### DM Messages
```
telegram-gramjs:{accountId}:{senderId}
```
Routes to the **main agent session** (shared history with this user).

### Group Messages
```
telegram-gramjs:{accountId}:group:{groupId}
```
Routes to an **isolated session** per group (separate context).

### Channel Messages
**Not yet supported.** Channel messages are skipped in Phase 1.

## Features

### ✅ Supported (Phase 1)

- ✅ DM messages (send and receive)
- ✅ Group messages (send and receive)
- ✅ Reply context (reply to specific messages)
- ✅ Text messages
- ✅ Command detection (`/start`, `/help`, etc.)
- ✅ Session persistence
- ✅ Multi-account support
- ✅ Security policies (allowFrom, dmPolicy, groupPolicy)

### ⏳ Coming Soon (Phase 2)

- ⏳ Media support (photos, videos, files)
- ⏳ Voice messages
- ⏳ Stickers and GIFs
- ⏳ Reactions
- ⏳ Message editing and deletion
- ⏳ Forward detection

### ⏳ Future (Phase 3)

- ⏳ Channel messages
- ⏳ Secret chats
- ⏳ Poll creation
- ⏳ Inline queries
- ⏳ Custom entity parsing (mentions, hashtags, URLs)

## Rate Limits

Telegram has **strict rate limits** for user accounts:

- **~20 messages per minute** per chat
- **~40-50 messages per minute** globally
- **Flood wait errors** trigger cooldown (can be minutes or hours)

**Best practices:**
- Don't spam messages rapidly
- Respect `FLOOD_WAIT` errors (the client will auto-retry)
- Use batching for multiple messages
- Consider using Bot API for high-volume scenarios

## Troubleshooting

### "API_ID_INVALID" or "API_HASH_INVALID"
- Check your credentials at https://my.telegram.org/apps
- Ensure `apiId` is a **number** (not string)
- Ensure `apiHash` is a **string** (not number)

### "PHONE_NUMBER_INVALID"
- Phone number must start with `+`
- Include country code
- Remove spaces and dashes
- Example: `+12025551234`

### "SESSION_PASSWORD_NEEDED"
- Your account has 2FA enabled
- Enter your 2FA password when prompted
- Check Telegram Settings → Privacy → Two-Step Verification

### "AUTH_KEY_UNREGISTERED"
- Your session expired or was terminated
- Re-run `openclaw setup telegram-gramjs` to re-authenticate

### "FLOOD_WAIT_X"
- You hit Telegram's rate limit
- Wait X seconds before retrying
- GramJS handles this automatically with exponential backoff

### Connection Issues
- Check internet connection
- Verify Telegram isn't blocked on your network
- Try restarting the gateway
- Check logs: `openclaw logs --channel=telegram-gramjs`

### Session Lost After Restart
- Ensure `sessionString` is saved in config
- Check file permissions on config file
- Verify encryption key is consistent

## Security Best Practices

### ✅ Do
- ✅ Store session strings encrypted
- ✅ Use `dmPolicy: "pairing"` for new contacts
- ✅ Use `allowFrom` to restrict access
- ✅ Regularly review active sessions in Telegram
- ✅ Use separate accounts for different purposes
- ✅ Enable 2FA on your Telegram account

### ❌ Don't
- ❌ Share session strings publicly
- ❌ Commit session strings to git
- ❌ Use `groupPolicy: "open"` in public groups
- ❌ Run on untrusted servers
- ❌ Reuse API credentials across multiple machines

## Migration from Bot API

If you're currently using the Telegram Bot API (`telegram` channel), you can run both simultaneously:

```json5
{
  channels: {
    // Bot API (existing)
    telegram: {
      enabled: true,
      botToken: "123:abc"
    },
    
    // GramJS (new)
    telegramGramjs: {
      enabled: true,
      apiId: 123456,
      apiHash: "hash"
    }
  }
}
```

**Routing:**
- Bot token messages → `telegram` channel
- User account messages → `telegram-gramjs` channel
- No conflicts (separate accounts, separate sessions)

## Examples

### Personal Assistant Setup
```json5
{
  channels: {
    telegramGramjs: {
      enabled: true,
      apiId: 123456,
      apiHash: "your_hash",
      phoneNumber: "+12025551234",
      dmPolicy: "pairing",
      groupPolicy: "closed",  // No groups
      sessionString: "..."
    }
  }
}
```

### Team Bot in Groups
```json5
{
  channels: {
    telegramGramjs: {
      enabled: true,
      apiId: 123456,
      apiHash: "your_hash",
      phoneNumber: "+12025551234",
      dmPolicy: "closed",  // No DMs
      groupPolicy: "allowlist",
      groupAllowFrom: [
        "-1001234567890",  // Team group
        "-1009876543210"   // Project group
      ],
      groups: {
        "-1001234567890": {
          requireMention: true,
          allowFrom: ["@alice", "@bob"]
        }
      }
    }
  }
}
```

### Multi-Account with Family + Work
```json5
{
  channels: {
    telegramGramjs: {
      enabled: true,
      accounts: {
        family: {
          name: "Family Account",
          apiId: 123456,
          apiHash: "hash1",
          phoneNumber: "+12025551234",
          dmPolicy: "allowlist",
          allowFrom: ["+15555551111", "+15555552222"],  // Family members
          groupPolicy: "closed"
        },
        work: {
          name: "Work Account",
          apiId: 789012,
          apiHash: "hash2",
          phoneNumber: "+15551234567",
          dmPolicy: "allowlist",
          allowFrom: ["@boss", "@coworker1"],
          groupPolicy: "allowlist",
          groupAllowFrom: ["-1001111111111"]  // Work group
        }
      }
    }
  }
}
```

## Advanced Configuration

### Connection Settings
```json5
{
  connectionRetries: 5,
  connectionTimeout: 30000,  // 30 seconds
  floodSleepThreshold: 60,   // Auto-sleep on flood wait < 60s
  useIPv6: false,
  deviceModel: "openclaw",
  systemVersion: "1.0.0",
  appVersion: "1.0.0"
}
```

### Message Settings
```json5
{
  historyLimit: 100,          // Max messages to fetch on poll
  mediaMaxMb: 10,             // Max media file size (Phase 2)
  textChunkLimit: 4096        // Max text length per message
}
```

### Capabilities
```json5
{
  capabilities: [
    "sendMessage",
    "receiveMessage",
    "replyToMessage",
    "deleteMessage",      // Phase 2
    "editMessage",        // Phase 2
    "sendMedia",          // Phase 2
    "downloadMedia"       // Phase 2
  ]
}
```

## Logs and Debugging

### Enable Debug Logs
```bash
export DEBUG=telegram-gramjs:*
openclaw gateway start
```

### Check Session Status
```bash
openclaw status telegram-gramjs
```

### View Recent Messages
```bash
openclaw logs --channel=telegram-gramjs --limit=50
```

## References

- **GramJS Documentation:** https://gram.js.org/
- **GramJS GitHub:** https://github.com/gram-js/gramjs
- **Telegram API Docs:** https://core.telegram.org/methods
- **MTProto Protocol:** https://core.telegram.org/mtproto
- **Get API Credentials:** https://my.telegram.org/apps
- **openclaw Issue #937:** https://github.com/openclaw/openclaw/issues/937

## Support

For issues specific to the GramJS channel:
- Check GitHub issues: https://github.com/openclaw/openclaw/issues
- Join the community: https://discord.gg/openclaw
- Report bugs: `openclaw report --channel=telegram-gramjs`

---

**Last Updated:** 2026-01-30  
**Version:** Phase 1 (Beta)  
**Tested Platforms:** macOS, Linux  
**Dependencies:** GramJS 2.24.15+, Node.js 18+
