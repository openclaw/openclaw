### Bug type

Behavior bug (incorrect output/state without crash)

### Summary

Internal hooks registered for `message:sent` via HOOK.md never fire for normal agent replies on any channel (Telegram, Discord, Signal, Slack, iMessage). They only fire for `message` tool sends (`action=send`). Each channel's delivery path bypasses `deliverOutboundPayloads` / `emitMessageSent` entirely.

### Steps to reproduce

1. Create a HOOK.md in workspace with `events: ["message:sent"]`
2. Create handler.ts that logs when event fires:
   console.log(`[hook] message:sent fired: ${event.context?.content?.slice(0, 50)}`);
3. Restart gateway — hook registers successfully in logs
4. Send a message to the agent via Telegram (or any channel)
5. Agent replies normally
6. Check gateway logs — no hook log lines appear
7. Use `message` tool (action=send) to send a message — hook DOES fire

### Expected behavior

`message:sent` hook should fire after every successful outbound message, including normal agent replies — not just `message` tool sends. The docs describe this event as firing for outbound messages generally.

### Actual behavior

Hook is registered at startup (`Registered hook: nmem-reply-save -> message:sent`) but zero events are emitted for agent replies. The `emitMessageSent` function exists in `deliverOutboundPayloads` but is never called from channel-specific delivery paths:

- Telegram: `deliverReplies` → `bot.api.sendMessage` (bypasses deliverOutboundPayloads)
- Discord: `deliverDiscordInteractionReply` (bypasses deliverOutboundPayloads)
- Signal: `deps.deliverReplies` (bypasses deliverOutboundPayloads)
- Slack: `ctx.app.client.chat.update` (bypasses deliverOutboundPayloads)

Only the `message` tool path (`action=send`) goes through `deliverOutboundPayloads` → `emitMessageSent` → hook fires.

Meanwhile, `message:received` fires correctly for every inbound message.

### OpenClaw version

2026.2.26

### Operating system

MacOS Tahoe 26.3

### Install method

npm global

### Logs, screenshots, and evidence

```shell
Gateway startup log shows hook registered:
  "Registered hook: nmem-reply-save -> message:sent"
  "nmem-reply-save: handler loaded, listening for message:sent"

Debug logging added to handler — zero log lines appear despite many agent replies.

Comparison: `message:received` hook (nmem-autosave) fires correctly for every inbound message.

Code trace in deliver-DzVpHq63.js:
- emitMessageSent() is defined inside deliverOutboundPayloads() (line ~1138)
- It correctly calls both hookRunner.runMessageSent AND triggerInternalHook
- BUT deliverOutboundPayloads is only called from the `message` tool send path
- Channel-specific agent reply delivery (Telegram/Discord/Signal/Slack/iMessage) all use their own direct delivery functions that never call emitMessageSent
```

### Impact and severity

Affected: All users using `message:sent` hooks via HOOK.md on any channel
Severity: Medium (hooks silently non-functional for primary use case)
Frequency: 100% repro — agent replies never trigger message:sent hooks
Consequence: Cannot capture outbound agent replies via hooks. Breaks use cases like conversation logging, memory sync, analytics. Users may not realize hooks aren't firing since registration succeeds without error.

### Additional information

Suggested fix: Add hook emission to createReplyDispatcher / createReplyDispatcherWithTyping (single change point). After the `deliver` callback succeeds, call emitMessageSent with the payload content. This way all channels benefit without per-channel modifications:

// In createReplyDispatcher, wrap the deliver callback:
sendChain = sendChain.then(async () => {
await options.deliver(normalized, { kind });
// Fire message:sent hook after successful delivery
if (options.onDelivered) options.onDelivered(normalized);
});

Workaround: Using a cron job (every 30 min, Gemini Flash) to extract replies from daily notes and sync to NeuralMemory.

Channel: Telegram (tested), but code analysis shows all channels are affected.
