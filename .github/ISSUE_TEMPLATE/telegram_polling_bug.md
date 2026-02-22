---
name: Telegram Polling Bug - Messages Silently Dropped
about: Telegram bot in polling mode doesn't process incoming messages
title: "[BUG] Telegram polling silently drops messages"
labels: "bug, telegram, high-priority"
assignees: ""
---

## Bug Description

When Telegram channel is configured in polling mode, incoming messages are successfully fetched via `getUpdates` but never passed to the AI agent for processing. Messages are silently consumed and dropped without any error logs.

## Environment

- **OpenClaw Version:** v2026.2.17
- **Platform:** Raspberry Pi 5 (ARM64) / [YOUR PLATFORM]
- **OS:** Linux / [YOUR OS]
- **Node Version:** v22.22.0 / [YOUR VERSION]

## Reproduction Steps

1. Configure Telegram bot with polling mode (default):

   ```bash
   openclaw config set channels.telegram.botToken "YOUR_TOKEN"
   openclaw config set channels.telegram.dmPolicy "open"
   openclaw config set channels.telegram.allowFrom '["*"]'
   ```

2. Start gateway:

   ```bash
   systemctl --user restart openclaw-gateway.service
   ```

3. Send a message to the bot via Telegram

4. Check logs:
   ```bash
   tail -f /tmp/openclaw/*.log | grep telegram
   ```

## Expected Behavior

- Incoming Telegram messages should trigger agent runs
- Logs should show entries with `messageChannel=telegram`
- Bot should respond to user messages

## Actual Behavior

- No agent invocations for Telegram messages
- All agent runs only show `messageChannel=webchat`
- No error logs generated
- Telegram API shows 0 pending updates (messages consumed but not processed)

## Evidence

### Gateway Log (Telegram starts successfully)

```
{"subsystem":"gateway/channels/telegram"},"[default] starting provider (@bot_name)"
```

### Agent Logs (Only webchat, no telegram)

```
embedded run start: ... messageChannel=webchat
// Never shows: messageChannel=telegram
```

### Telegram Status

```bash
$ openclaw channels status
- Telegram default: enabled, configured, running, mode:polling, token:config
```

### API Check

```bash
$ curl "https://api.telegram.org/bot<TOKEN>/getUpdates?offset=-1"
{"ok":true,"result":[]}  # Empty - messages already consumed
```

## Root Cause Analysis

The Telegram polling loop successfully calls `getUpdates` and receives messages, but the message handler callback that should dispatch to the agent subsystem is not being triggered. This suggests an issue in the event binding between the Telegram client library and the OpenClaw message processing pipeline.

## Workaround

Deleting the offset file and restarting gateway sometimes fixes the issue:

```bash
systemctl --user stop openclaw-gateway.service
rm ~/.openclaw/telegram/update-offset-default.json
systemctl --user start openclaw-gateway.service
```

**Note:** This workaround is inconsistent and may be timing/environment-dependent.

## Additional Context

- Outbound messages work correctly (bot can send messages)
- Other channels (Slack, webchat) work fine
- Plugin is enabled: `plugins.entries.telegram.enabled: true`
- Switching from webhook to polling mode doesn't help

## Suggested Fix

1. Add debug logging to the Telegram message handler
2. Verify event listener registration in polling mode
3. Ensure message objects are properly formatted before dispatch
4. Add unit tests for Telegram message flow

## Related Files

Likely affected files:

- `src/gateway/channels/telegram/*.ts`
- Message handler event binding code
- Polling loop implementation

## Testing

To verify fix:

1. Configure Telegram bot in polling mode
2. Send test message via Telegram client
3. Verify log entry: `messageChannel=telegram`
4. Verify bot responds with AI-generated message

---

**Reproducible:** Yes, consistently
**Severity:** High (breaks Telegram channel completely)
**Impact:** All Telegram users unable to interact with bot
