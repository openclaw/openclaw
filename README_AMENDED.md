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

---

## Idle Reminder V2 (Simulated Heartbeat)

**Date**: 2026-02-06

**Description**: Added an idle reminder that sends a "simulated heartbeat" when the agent goes idle after responding. Bypasses the regular heartbeat-runner entirely (avoids guard clauses that blocked V1) by calling `getReplyFromConfig` + `deliverOutboundPayloads` directly.

### How It Works

```
Agent sends non-heartbeat reply with payloads
          ↓
  startIdleReminder(sessionKey, count=0)
  Record transcript file size
          ↓ (after 3 minutes)
  Read transcript tail (new bytes since last check)
          ↓
  ├─ New non-HEARTBEAT_OK content → Reset timer + count (activity detected)
  ├─ No new content, count < 3 → Send simulated heartbeat, count++
  ├─ Reply is HEARTBEAT_OK → Agent confirmed idle, stop
  └─ count >= 3 → Max reminders reached, stop

User sends message → Agent replies → startIdleReminder resets count
```

### Key Differences from V1

- **V1**: Called `requestHeartbeatNow()` which went through `heartbeat-runner` guard clauses (heartbeatsEnabled, empty-heartbeat-file, etc.) — often blocked
- **V2**: Calls `getReplyFromConfig()` + `deliverOutboundPayloads()` directly, bypassing all guards
- **V1**: Checked `session.updatedAt` for activity detection
- **V2**: Reads transcript JSONL tail bytes, filters out `HEARTBEAT_OK` lines
- **V2**: Max 3 reminders per cycle, resets on user message

### Files Added/Modified

1. **`src/infra/idle-reminder.ts`** (REWRITTEN)
   - `startIdleReminder()` - Start/reset timer, snapshot transcript size
   - `stopIdleReminder()` - Stop timer (on HEARTBEAT_OK from original heartbeat)
   - `sendSimulatedHeartbeat()` - Direct model call + delivery (bypass heartbeat-runner)
   - `hasNewNonHeartbeatContent()` - Read transcript tail for real activity
   - `stopAllIdleReminders()` - Cleanup on shutdown

2. **`src/auto-reply/reply/agent-runner.ts`**
   - Calls `startIdleReminder({ sessionKey, storePath })` after non-heartbeat agent runs

3. **`src/infra/heartbeat-runner.ts`**
   - Calls `stopIdleReminder()` on `ok-empty` and `ok-token` responses (unchanged)

### Debug Logging

```
idle-reminder: started sessionKey=main timeoutMs=180000
idle-reminder: new activity detected, resetting sessionKey=main
idle-reminder: session idle, sending simulated heartbeat sessionKey=main count=0
idle-reminder: simulated heartbeat delivered sessionKey=main channel=signal
idle-reminder: HEARTBEAT_OK reply, agent confirmed idle sessionKey=main
idle-reminder: max reminders reached sessionKey=main count=3
```

---

## Signal Pre-cached Media Cache Sync

**Date**: 2026-02-06

**Description**: Fixed an issue where pre-cached attachments/stickers (from `requireMention` pre-caching) were saved to the agent media cache but NOT registered in the in-memory `cacheMedia` map. This caused quoted/reply messages to fail to find the referenced media.

### Problem

When `requireMention` is enabled:

1. Attachments/stickers from non-mentioned group messages were pre-cached to agent cache (disk) ✓
2. But NOT registered in the runtime `cacheMedia()` map ✗
3. When a later message quoted/replied to a message with those attachments, the media lookup by timestamp failed

### Solution

After pre-caching attachments and stickers to the agent cache, also call `cacheMedia()` to register them in the runtime media map so quoted message lookups work.

### Files Modified

1. **`src/signal/monitor/event-handler.ts`**
   - After `saveToAgentCache()` for attachments: added `cacheMedia(timestamp, { path, contentType })`
   - After `saveToAgentCache()` for stickers: added `cacheMedia(timestamp, { path, contentType })`

---

## Thinking Content Leak Fix (enforceFinalTag bypass)

**Date**: 2026-02-07

**Description**: Fixed a bug where the model's internal "thinking" content (tool call debug text, reasoning) leaked to users on external messaging channels (Signal, Telegram, etc.) when using `google-gemini-cli` or other reasoning-tag providers.

### Root Cause

For providers where `isReasoningTagProvider()` returns `true` (e.g. `google-gemini-cli`, `ollama`), `enforceFinalTag` is set to `true`. This tells the subscribe layer to only deliver content wrapped in `<final>` tags — everything else (thinking, reasoning, tool call text) is suppressed.

The subscribe layer (`stripBlockTags`) correctly enforced this, so `assistantTexts` was empty when the model didn't use `<final>` tags.

However, `buildEmbeddedRunPayloads()` had a **fallback**: when `assistantTexts` was empty, it called `extractAssistantText(lastAssistant)` directly. This function only strips `<think>` tags but does NOT enforce `<final>` tags — so unfiltered content bypassed the enforcement and was delivered to users.

### Symptoms

- Model outputs `[Historical context: a different model called tool "X" with arguments: {...}]` as text → sent to user on Signal
- Model outputs reasoning text without `<final>` tags → sent to user on Signal
- Model "thinks out loud" about what tools to call → visible to user

### Fix

1. **`src/agents/pi-embedded-runner/run/payloads.ts`**
   - Added `enforceFinalTag?: boolean` parameter to `buildEmbeddedRunPayloads`
   - When `enforceFinalTag=true`, skip the `extractAssistantText()` fallback — content without `<final>` tags was already suppressed by the subscribe layer

2. **`src/agents/pi-embedded-runner/run.ts`**
   - Pass `enforceFinalTag: params.enforceFinalTag` to `buildEmbeddedRunPayloads()`

### Affected Providers

Any provider where `isReasoningTagProvider()` returns `true`:

- `google-gemini-cli`
- `google-generative-ai`
- `google-antigravity` (and variants)
- `ollama`

### Test Results

All 131 embedded runner tests + 67 subscribe tests pass after the fix.

---

## Cron Scheduler Permanent Death Fix

**Date**: 2026-02-07

**Description**: Fixed a critical bug where the cron scheduler could permanently die and never recover, causing all scheduled jobs (`0 3 * * *`, `0 7 * * *`, etc.) to silently stop firing.

### Incident Timeline

- **Feb 5**: Last successful automatic cron runs.
- **Feb 6-7**: Zero automatic executions. All jobs MISSED. Manual `cron run` at 09:52 HKT Feb 6 confirmed the scheduler was responsive to API calls but the internal timer was dead.

### Root Cause

Two related bugs in the self-rearming timer chain (`armTimer → setTimeout → onTimer → armTimer → ...`):

**Bug 1: `start()` silent failure** (`ops.ts`) — PRIMARY CAUSE

`start()` placed `armTimer()` inside the `locked()` callback. If `ensureLoaded()`, `recomputeNextRuns()`, or `persist()` threw (e.g., transient file I/O error during gateway restart), the timer was never created. No error was logged ("cron: started" also never printed). The scheduler simply never existed.

**Evidence**: `/tmp/openclaw/` logs show a 20+ hour gap with no "cron: started" entries (Feb 5 18:39 UTC → Feb 6 16:21 UTC), despite the gateway process running and handling requests the entire time.

**Bug 2: `onTimer()` chain break** (`timer.ts`)

`onTimer()` placed `armTimer()` inside the `locked()` callback. Any exception in `ensureLoaded`/`runDueJobs`/`persist` would permanently break the timer chain. The `.catch` handler on `setTimeout` only logged the error without re-arming.

### Fix

| File       | Function              | Before                              | After                                                                                        |
| ---------- | --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `ops.ts`   | `start()`             | `armTimer` inside `locked` callback | `armTimer` outside `locked`, after `try/catch` — always arms even if startup partially fails |
| `timer.ts` | `onTimer()`           | `armTimer` inside `locked` callback | `armTimer` in `finally` block — always re-arms regardless of success/failure                 |
| `timer.ts` | `armTimer()` `.catch` | Only logs error                     | Logs error + re-arms timer (belt-and-suspenders)                                             |

### Files Modified

1. **`src/cron/service/ops.ts`**
   - Moved `armTimer(state)` and `log.info("cron: started")` outside the `locked()` callback
   - Added `try/catch` around the locked block so startup errors are logged but don't prevent timer creation
   - Moved `cronEnabled` check before `locked()` (early return)

2. **`src/cron/service/timer.ts`**
   - Moved `armTimer(state)` from inside `locked()` callback to the `finally` block of `onTimer()`
   - Added `armTimer(state)` in the `.catch` handler of the setTimeout callback as a safety net

### Behavior After Fix

- If `ensureLoaded`/`persist` fails during `start()`: error is logged, timer still arms, next tick retries automatically
- If any step fails during `onTimer()`: `finally` block always re-arms the timer for the next cycle
- If `onTimer()` itself throws past its `finally`: `.catch` handler re-arms as last resort
- The scheduler is now self-healing — transient errors cause temporary failures, not permanent death
