# README_AMENDED

This file documents local amendments to the OpenClaw codebase.

---

## Signal `requireMention` Support

**Date**: 2026-02-03

**Description**: Added `requireMention` configuration option for Signal channel to require @mention in group messages before the bot responds.

### Configuration

```json
{
  "channels": {
    "signal": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "requireMention": true
    }
  }
}
```

### Behavior

When `requireMention: true` is set:
- Group messages that do NOT @mention the bot account will be ignored
- Group messages that @mention the bot account will be processed
- DM (direct message) behavior is unchanged

### Files Modified

1. **`src/config/zod-schema.providers-core.ts`**
   - Added `requireMention: z.boolean().optional()` to `SignalAccountSchemaBase`

2. **`src/config/types.signal.ts`**
   - Added `requireMention?: boolean` to `SignalAccountConfig` type

3. **`src/signal/monitor/event-handler.types.ts`**
   - Added `SignalMention` type for mention structure
   - Added `mentions?: Array<SignalMention> | null` to `SignalDataMessage`
   - Added `requireMention: boolean` to `SignalEventHandlerDeps`

4. **`src/signal/monitor.ts`**
   - Read `requireMention` from config (default: `false`)
   - Pass `requireMention` to event handler

5. **`src/signal/monitor/event-handler.ts`**
   - Added mention check logic after `groupPolicy` validation
   - Checks if bot account number is in message mentions array
   - Logs `"Blocked signal group message (requireMention, not mentioned)"` when blocked
   - Strip U+FFFC (mention placeholder) before command detection so `@bot /new` is detected as `/new`
   - Strip U+FFFC from message body before passing to agent so `/new` command executes correctly

### Note

Signal mentions work differently from other platforms. The bot checks if its phone number appears in the `mentions` array of the incoming message. This relies on signal-cli properly parsing and forwarding mention data from Signal.

### Debug Logging

When `requireMention` is enabled, verbose logs will show:
```
[requireMention] mentions=[...], botAccount=..., botAccountId=...
[requireMention] mention detected, proceeding
```
or
```
Blocked signal group message (requireMention, not mentioned)
```

Use `--verbose` flag or enable verbose logging to see these messages.

---

## Signal Sticker Support Fix

**Date**: 2026-02-03

**Description**: Fixed Signal sticker fetching - stickers were showing as `media:unknown` because `sticker.attachment.id` was not always available.

### Changes

1. **`src/signal/monitor/event-handler.ts`**
   - Added debug logging to print sticker data structure
   - Added fallback to fetch sticker via `packId` + `stickerId` when `attachment.id` is missing

2. **`src/signal/monitor/event-handler.types.ts`**
   - Added `fetchSticker` optional method to `SignalEventHandlerDeps`

3. **`src/signal/monitor.ts`**
   - Implemented `fetchSticker` function using signal-cli `getSticker` RPC method
   - Added `logVerbose` import

### Debug Logging

```
sticker data: {"packId":"xxx","stickerId":1,...}
sticker has no attachment.id, packId=xxx, stickerId=1
```

---

## Group Attachment Pre-caching (requireMention fix)

**Date**: 2026-02-03

**Description**: When `requireMention` is enabled, attachments/stickers from non-mentioned group messages were being ignored. Now they are pre-cached before the mention check.

### Problem

With `requireMention: true`:
- Most people send attachments without text
- Stickers never have text
- These were being blocked because no @mention was present

### Solution

Before `requireMention` check:
1. Detect if message has attachments or sticker
2. Download and cache to independent agent cache
3. Then perform mention check (message may still be blocked, but attachment is saved)

### New Agent Media Cache

**Location**: `~/.openclaw/agents/<agentId>/media-cache/`

**Features**:
- Independent from regular `media/inbound` and `media/outbound` (no TTL cleanup)
- 5GB limit per agent
- Automatic cleanup: oldest files deleted when limit exceeded
- Stores metadata: channel, groupId, senderId, timestamp

### Files Added/Modified

1. **`src/media/agent-cache.ts`** (NEW)
   - `saveToAgentCache()` - Save media to agent cache
   - `getAgentCacheStats()` - Get cache statistics
   - Automatic 5GB limit enforcement with LRU cleanup

2. **`src/signal/monitor/event-handler.ts`**
   - Added pre-cache logic before `requireMention` check
   - Imports `saveToAgentCache` from agent-cache module

### Cache Index

Each agent has a `cache-index.json` file tracking:
```json
{
  "entries": [
    {
      "id": "uuid",
      "path": "/path/to/file",
      "contentType": "image/jpeg",
      "size": 12345,
      "savedAt": 1706976000000,
      "channel": "signal",
      "groupId": "xxx",
      "senderId": "yyy",
      "timestamp": 1706975999999
    }
  ],
  "totalSize": 12345
}
```

### Debug Logging

```
signal: pre-cached attachment for group xxx from User
signal: pre-cached sticker for group xxx from User
agent media cache saved: agentId=main path=/path/to/file size=1.2MB
agent media cache cleanup: deleted /old/file (500KB)
```
