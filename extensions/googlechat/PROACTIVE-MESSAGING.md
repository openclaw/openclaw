# Google Chat Proactive Messaging

This document describes how to send proactive (initiated by the bot) messages in Google Chat, rather than only responding to incoming webhooks.

## Overview

Google Chat is unique among Moltbot channels because it operates purely via webhooks rather than persistent connections. This creates challenges for proactive messaging, but we've implemented several features to make it possible:

1. **Space ID Persistence** - Auto-cache space IDs when users message the bot
2. **Auto-Resolve** - Automatically resolve `users/{id}` to cached spaces
3. **findDirectMessage Fallback** - Use Google Chat API to find DM spaces
4. **Manual Space Targeting** - Send directly to known space IDs

## How It Works

### Automatic Space Caching

When a user messages your bot, Moltbot automatically caches the space mapping:

```json
{
  "channels": {
    "googlechat": {
      "knownSpaces": {
        "users/123456789": {
          "spaceId": "spaces/AAAAxxxx",
          "displayName": "John Doe",
          "type": "DM",
          "lastSeenAt": 1706515200000
        }
      }
    }
  }
}
```

This cache persists across restarts and enables proactive messaging to users who have previously interacted with the bot.

## Sending Proactive Messages

### Method 1: Using User ID (Recommended)

If the user has messaged your bot before, you can use their user ID:

```bash
moltbot message send \
  --channel googlechat \
  --to "users/123456789" \
  --text "Hello! This is a proactive message."
```

Moltbot will:
1. Check the `knownSpaces` cache for the user
2. If found, send to the cached space
3. If not found, call `findDirectMessage` API
4. If still not found, show an error with instructions

### Method 2: Using Space ID

If you know the space ID (from a previous message or Google Chat UI):

```bash
moltbot message send \
  --channel googlechat \
  --to "spaces/AAAAxxxx" \
  --text "Hello space!"
```

### Method 3: Via Cron/Heartbeat

Schedule proactive messages in your config:

```json
{
  "cron": {
    "jobs": [
      {
        "schedule": "0 9 * * *",
        "text": "Good morning! Your daily reminder.",
        "target": "users/123456789",
        "channel": "googlechat"
      }
    ]
  }
}
```

Or for spaces:

```json
{
  "cron": {
    "jobs": [
      {
        "schedule": "0 9 * * MON",
        "text": "Weekly standup time!",
        "target": "spaces/AAAAxxxx",
        "channel": "googlechat"
      }
    ]
  }
}
```

### Method 4: From Skills/Agents

Skills can send proactive messages using the message tool:

```typescript
// In a skill
await message.send({
  channel: "googlechat",
  target: "users/123456789", // or "spaces/AAAAxxxx"
  text: "Proactive notification from skill!"
});
```

## Target Formats

Google Chat supports several target formats:

| Format | Example | Description |
|--------|---------|-------------|
| User ID | `users/123456789` | Google Chat user resource name |
| Email | `users/user@example.com` | User's email address |
| Space ID | `spaces/AAAAxxxx` | Google Chat space resource name |
| With prefix | `googlechat:users/123` | Explicit channel prefix |

## Troubleshooting

### "No Google Chat DM found for users/xxx"

This error means:
1. The user has never messaged your bot, OR
2. The space cache was lost, AND
3. The `findDirectMessage` API couldn't locate a DM

**Solutions:**
- Ask the user to message your bot first
- Use the space ID directly if you know it
- Check your service account permissions

### Service Account Permissions

Your Google Chat service account needs these scopes:

- `https://www.googleapis.com/auth/chat.bot`

For `findDirectMessage` to work, the service account must be added to the Google Chat space or have domain-wide delegation (for Workspace admins).

### Checking Cached Spaces

To see cached spaces in your config:

```bash
moltbot config get channels.googlechat.knownSpaces
```

### Clearing Space Cache

If you need to clear the cache (e.g., spaces were renamed):

```bash
moltbot config set channels.googlechat.knownSpaces '{}'
```

## Limitations

1. **DMs require prior interaction** - You cannot initiate a DM with a user who has never messaged your bot
2. **Bot must be in space** - For group/room messages, the bot must be a member
3. **Service account limits** - Some API features require domain-wide delegation in Google Workspace

## Comparison with Other Channels

| Feature | WhatsApp | Telegram | Google Chat |
|---------|----------|----------|-------------|
| Initiate DMs | ✅ Yes | ✅ Yes | ❌ No* |
| Persistent connection | ✅ Yes | ✅ Yes | ❌ No |
| Requires webhook | ❌ No | Optional | ✅ Yes |
| Space caching | N/A | N/A | ✅ Auto |

*Google Chat requires the user to message the bot first, or use `findDirectMessage` which may not always work

## API Reference

### `resolveGoogleChatOutboundSpace`

```typescript
async function resolveGoogleChatOutboundSpace(params: {
  account: ResolvedGoogleChatAccount;
  target: string;
  cfg?: MoltbotConfig;
  useCache?: boolean;        // default: true
  useFindDirectMessage?: boolean;  // default: true
}): Promise<string>
```

Resolves a target (user ID or space ID) to a space ID for sending messages.

### `getCachedSpaceForUser`

```typescript
function getCachedSpaceForUser(
  cfg: MoltbotConfig,
  userId: string,
  accountId?: string
): GoogleChatKnownSpace | undefined
```

Retrieves cached space info for a user.

### Space Cache Schema

```typescript
type GoogleChatKnownSpace = {
  spaceId: string;        // "spaces/AAAAxxxx"
  displayName?: string;   // User or space name
  type?: "DM" | "ROOM";   // Space type
  lastSeenAt?: number;    // Timestamp
};
```

## Best Practices

1. **Let users message first** - Design flows where users initiate contact
2. **Cache proactively** - Store space IDs when users message, before you need them
3. **Handle errors gracefully** - Always wrap proactive sends in try-catch
4. **Use space IDs for critical messages** - More reliable than user ID resolution
5. **Document your flows** - Users should know why they're getting messages

## Examples

### Welcome Message After Pairing

```typescript
// In pairing approval handler
await message.send({
  channel: "googlechat",
  target: `users/${userId}`,
  text: "You're now paired! I'll send you daily summaries at 9 AM."
});
```

### Daily Digest

```json
{
  "cron": {
    "jobs": [{
      "schedule": "0 9 * * *",
      "text": "📊 Your daily digest:\n- 3 new emails\n- 2 PRs awaiting review",
      "target": "users/xxx",
      "channel": "googlechat"
    }]
  }
}
```

### Error Notifications

```typescript
// In a skill or agent
try {
  await performTask();
} catch (error) {
  await message.send({
    channel: "googlechat",
    target: `users/${adminUserId}`,
    text: `⚠️ Task failed: ${error.message}`
  });
}
```
