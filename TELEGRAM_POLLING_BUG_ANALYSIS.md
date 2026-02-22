# Telegram Polling Bug - Root Cause Analysis & Fix Proposal

**GitHub Issue:** #20518
**Severity:** Critical
**Status:** Under Investigation
**Date:** February 19, 2026

## Executive Summary

Telegram bot in polling mode successfully fetches messages via `getUpdates` but silently drops them without triggering AI agent invocations. Messages are marked as consumed in Telegram's API but never processed by OpenClaw.

**Impact:** Complete Telegram channel failure for all polling mode users.

**Workaround:** Delete offset file and restart gateway (temporary, may reoccur).

---

## Symptoms

1. Bot receives messages (Telegram shows "delivered")
2. No agent invocations in logs (`messageChannel=telegram` never appears)
3. `openclaw channels status` shows "running" with no errors
4. Telegram `getUpdates?offset=-1` returns 0 messages (already consumed)
5. Messages sent via webchat work fine (`messageChannel=webchat` appears)

---

## Investigation Process

### 1. Verified Polling Loop is Functional

**File:** `src/telegram/monitor.ts`

The Grammy runner successfully fetches updates:

- `@grammyjs/runner` library handles polling
- Updates are fetched from Telegram API
- Update offset is correctly incremented
- No errors in polling loop

**Conclusion:** The polling mechanism itself works. The problem is downstream.

### 2. Checked Update Deduplication

**File:** `src/telegram/bot-updates.ts`

Updates are deduplicated via:

- TTL-based cache (5 minutes)
- Max 2000 updates cached
- Keys based on `update_id`, `callback_id`, or message coordinates

**Possible Issue:** If updates are being incorrectly marked as duplicates, they would be silently dropped.

**Test:** Check deduplication logic for false positives.

### 3. Examined Message Handler Registration

**File:** `src/telegram/bot-handlers.ts`

Handlers are registered for:

- `bot.on("message", handler)` - Direct messages
- `bot.on("callback_query", handler)` - Button clicks
- `bot.on("message_reaction", handler)` - Reactions
- `bot.on("channel_post", handler)` - Channel posts

**Possible Issue:** Handler might not be properly attached to the bot instance, or middleware is blocking messages.

### 4. Traced Message Processing Flow

**Expected flow:**

```
Polling Update
  → bot.ts: createTelegramBot()
  → bot.use(sequentialize)
  → bot.use(dedupe)
  → bot.use(recordUpdateId)
  → bot-handlers.ts: registerTelegramHandlers()
  → bot.on("message", processMessage)
  → bot-message.ts: buildTelegramMessageContext()
  → bot-message-dispatch.ts: dispatchTelegramMessage()
  → dispatchReplyWithBufferedBlockDispatcher()  // Invokes agent
```

**Break Point:** Messages are likely being dropped somewhere between `bot.on("message")` and `dispatchTelegramMessage()`.

---

## Root Cause Hypotheses

### Hypothesis A: Middleware Blocking (Most Likely)

**Theory:** The sequentialize, dedupe, or recordUpdateId middleware is silently blocking messages without logging.

**Evidence:**

- Only affects polling mode (webhook might bypass some middleware)
- Offset is advanced (updates consumed) but not processed
- No error logs (middleware fails silently)

**File to Check:**

- `src/telegram/bot.ts` lines 1-200 (middleware setup)
- `src/telegram/bot-updates.ts` (deduplication logic)

**Suggested Fix:**

```typescript
// In bot.ts, add logging to each middleware
bot.use(async (ctx, next) => {
  const updateType = ctx.updateType;
  const updateId = ctx.update?.update_id;

  console.log(`[Telegram] Received update ${updateId} type=${updateType}`);

  try {
    await next();
    console.log(`[Telegram] Processed update ${updateId}`);
  } catch (err) {
    console.error(`[Telegram] Error processing update ${updateId}:`, err);
    throw err;
  }
});
```

### Hypothesis B: Handler Registration Timing Issue

**Theory:** Message handler is registered too late, after bot polling starts. Early messages get consumed but no handler exists yet.

**Evidence:**

- Workaround (delete offset + restart) sometimes works
- Suggests timing/race condition

**File to Check:**

- `src/telegram/monitor.ts` - When polling starts
- `src/telegram/bot-handlers.ts` - When handlers register

**Suggested Fix:**
Ensure handlers are registered synchronously before `run(bot)` is called:

```typescript
// In monitor.ts
async function startTelegramPolling(bot, options) {
  // CRITICAL: Register handlers BEFORE starting runner
  await registerTelegramHandlers(bot, config);

  // Now start polling
  const runner = run(bot, options);
  // ...
}
```

### Hypothesis C: Message Context Building Failure

**Theory:** `buildTelegramMessageContext()` throws an exception that's caught and logged elsewhere, preventing dispatch.

**Evidence:**

- Complex context building with history, media, etc.
- Silent failures possible if try/catch swallows errors

**File to Check:**

- `src/telegram/bot-message-context.ts`
- `src/telegram/bot-message.ts`

**Suggested Fix:**
Add explicit error logging in message processing:

```typescript
// In bot-message.ts
async function processMessage(ctx, ...) {
  try {
    const context = await buildTelegramMessageContext(ctx, ...);

    if (!context) {
      console.error('[Telegram] Failed to build message context');
      return;
    }

    await dispatchTelegramMessage(context, ...);
  } catch (err) {
    console.error('[Telegram] Error in processMessage:', err);
    // Don't silently swallow - rethrow or alert
    throw err;
  }
}
```

### Hypothesis D: Access Control Blocking

**Theory:** `allowFrom` or `dmPolicy` is blocking messages, but not logging the rejection.

**Evidence:**

- User had to set `dmPolicy: "open"` and `allowFrom: ["*"]` to fix
- Suggests access control was silently dropping messages

**File to Check:**

- Access control checks in bot-message.ts or bot-message-dispatch.ts

**Suggested Fix:**
Add explicit logging for access control rejections:

```typescript
// In access control check
if (!isAllowed(userId, allowFrom)) {
  console.warn(`[Telegram] Message from ${userId} blocked by allowFrom policy`);
  return; // Don't process message
}
```

---

## Diagnostic Script

Created `scripts/doctor/debug-telegram-polling.sh` to help diagnose this issue:

```bash
#!/bin/bash
# Telegram polling diagnostic tool

# 1. Check if polling is active
openclaw channels status | grep telegram

# 2. Check recent logs for telegram messages
journalctl --user -u openclaw-gateway --since "1 hour ago" \
  | grep -i telegram \
  | grep -v "heartbeat"

# 3. Check if updates are being consumed
BOT_TOKEN=$(openclaw config get channels.telegram.botToken | tr -d '"')
curl -s "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1&limit=1"

# 4. Check for agent invocations
journalctl --user -u openclaw-gateway --since "1 hour ago" \
  | grep "messageChannel=telegram"

# 5. Check access control config
echo "dmPolicy:" $(openclaw config get channels.telegram.dmPolicy)
echo "allowFrom:" $(openclaw config get channels.telegram.allowFrom)
```

---

## Recommended Fixes (Priority Order)

### 1. Add Comprehensive Logging (Immediate)

**Where:** Throughout the message processing pipeline

**What:**

```typescript
// At each stage:
logger.info("[Telegram] Update received", { updateId, updateType });
logger.info("[Telegram] Handler called", { chatId, messageId });
logger.info("[Telegram] Context built", { contextId });
logger.info("[Telegram] Dispatching to agent", { agentId });
logger.info("[Telegram] Agent invoked", { runId });
```

**Benefit:** Pinpoints exactly where messages are being dropped.

### 2. Add Error Boundaries (Immediate)

**Where:** `bot-message.ts`, `bot-message-dispatch.ts`

**What:**
Wrap critical sections in try/catch with explicit error logging. Never silently swallow exceptions.

### 3. Add Access Control Logging (Immediate)

**Where:** Access control checks

**What:**
Log when messages are rejected by `allowFrom`, `dmPolicy`, or pairing requirements.

### 4. Add Middleware Debug Mode (Short-term)

**Where:** `bot.ts`

**What:**
Add a debug flag that logs every middleware execution:

```typescript
if (process.env.TELEGRAM_DEBUG_MIDDLEWARE === "true") {
  bot.use(async (ctx, next) => {
    console.log("[Telegram Middleware]", {
      updateId: ctx.update?.update_id,
      updateType: ctx.updateType,
      stack: new Error().stack,
    });
    await next();
  });
}
```

### 5. Review Deduplication Logic (Short-term)

**Where:** `src/telegram/bot-updates.ts`

**What:**

- Verify deduplication keys are correct
- Check for false positives
- Add logging when updates are deduplicated
- Consider shorter TTL or opt-out for testing

### 6. Add Integration Test (Medium-term)

**Where:** `test/telegram/`

**What:**
Create end-to-end test that:

1. Starts bot in polling mode
2. Sends test message via Telegram API
3. Verifies agent invocation
4. Checks response delivery

**Benefit:** Prevents regression of this critical bug.

---

## Testing Procedure

To test the fix:

1. **Enable debug logging:**

   ```bash
   export TELEGRAM_DEBUG_MIDDLEWARE=true
   export DEBUG=telegram:*
   ```

2. **Start gateway with verbose logging:**

   ```bash
   systemctl --user stop openclaw-gateway.service
   openclaw gateway start --verbose
   ```

3. **Send test message:**
   Send "test" to the Telegram bot

4. **Check logs:**

   ```bash
   # Should see:
   [Telegram] Update received updateId=123
   [Telegram] Handler called chatId=456
   [Telegram] Context built
   [Telegram] Dispatching to agent
   [Telegram] Agent invoked runId=789
   [messageChannel=telegram] <-- THIS IS CRITICAL
   ```

5. **If missing any of the above:** That's where the message is being dropped.

---

## Workaround for Users (Temporary)

Until the core fix is implemented:

**Option 1: Use the fix script (recommended)**

```bash
./scripts/troubleshooting/fix-telegram-polling.sh
```

**Option 2: Manual steps**

```bash
systemctl --user stop openclaw-gateway.service
rm ~/.openclaw/telegram/update-offset-default.json
systemctl --user start openclaw-gateway.service
```

**Option 3: Switch to webhook mode** (if you have a public URL)

```bash
openclaw config set channels.telegram.webhookUrl "https://your-domain.com/telegram"
openclaw config set channels.telegram.webhookSecret "$(openssl rand -hex 32)"
systemctl --user restart openclaw-gateway.service
```

---

## Code Files Requiring Changes

Based on investigation:

1. **`src/telegram/bot.ts`** (lines 1-200)
   - Add middleware logging
   - Ensure handler registration before polling starts

2. **`src/telegram/bot-handlers.ts`** (lines 58-300)
   - Add logging to message handler
   - Verify handler is called for all message types

3. **`src/telegram/bot-message.ts`** (lines 49-150)
   - Add error boundaries
   - Log message processing steps

4. **`src/telegram/bot-message-dispatch.ts`** (lines 63-300)
   - Add logging before agent dispatch
   - Verify dispatchReplyWithBufferedBlockDispatcher is called

5. **`src/telegram/bot-updates.ts`** (deduplication)
   - Review dedupe logic for false positives
   - Add logging when updates are deduplicated

6. **`src/auto-reply/reply/*.ts`** (agent dispatch)
   - Verify agent invocation
   - Check for silent failures

---

## Related Issues

- **#20503** - Original bug report
- **#20519** - Webhook → polling transition issues
- **#20520** - Config validation errors

---

## Next Steps for Maintainers

1. **Immediate:**
   - Add comprehensive logging throughout the pipeline
   - Deploy to staging for testing
   - Reproduce the issue with logs enabled

2. **Short-term:**
   - Implement the suggested fixes based on log findings
   - Add integration test
   - Document the root cause once confirmed

3. **Long-term:**
   - Review all "silent failure" patterns in codebase
   - Add linting rule to prevent exception swallowing
   - Improve error visibility in general

---

## Appendix: Debugging Commands

```bash
# Check if gateway is running
systemctl --user status openclaw-gateway.service

# Watch logs in real-time
journalctl --user -u openclaw-gateway -f

# Check last 100 telegram-related logs
journalctl --user -u openclaw-gateway -n 100 | grep -i telegram

# Check for agent invocations
journalctl --user -u openclaw-gateway -n 1000 | grep "messageChannel="

# Test Telegram API directly
BOT_TOKEN="your-token"
curl "https://api.telegram.org/bot${BOT_TOKEN}/getMe"
curl "https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1&limit=1"

# Check offset file
cat ~/.openclaw/telegram/update-offset-default.json

# Check access control config
openclaw config get channels.telegram.dmPolicy
openclaw config get channels.telegram.allowFrom
```

---

**Status:** This document provides analysis and fix proposals. Core code changes required for complete fix.

**Contact:** Submit findings to GitHub Issue #20518
