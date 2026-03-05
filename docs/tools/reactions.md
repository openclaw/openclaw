---
summary: "Reaction tool semantics across all supported channels"
read_when:
  - Working on reactions in any channel
  - Understanding how emoji reactions differ across platforms
title: "Reactions"
---

# Reactions

The agent can add and remove emoji reactions on messages using the `message`
tool with the `react` action. Reaction behavior varies by channel.

## How it works

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- `emoji` is required when adding a reaction.
- Set `emoji` to an empty string (`""`) to remove the bot's reaction(s).
- Set `remove: true` to remove a specific emoji (requires non-empty `emoji`).

## Channel behavior

<AccordionGroup>
  <Accordion title="Discord and Slack">
    - Empty `emoji` removes all of the bot's reactions on the message.
    - `remove: true` removes just the specified emoji.
  </Accordion>

  <Accordion title="Google Chat">
    - Empty `emoji` removes the app's reactions on the message.
    - `remove: true` removes just the specified emoji.
  </Accordion>

  <Accordion title="Telegram">
    - Empty `emoji` removes the bot's reactions.
    - `remove: true` also removes reactions but still requires a non-empty `emoji` for tool validation.
  </Accordion>

  <Accordion title="WhatsApp">
    - Empty `emoji` removes the bot reaction.
    - `remove: true` maps to empty emoji internally (still requires `emoji` in the tool call).
  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - Requires non-empty `emoji`.
    - `remove: true` removes that specific emoji reaction.
  </Accordion>

  <Accordion title="Signal">
    - Inbound reaction notifications are controlled by `channels.signal.reactionNotifications`: `"off"` disables them, `"own"` (default) emits events when users react to bot messages, and `"all"` emits events for all reactions.
  </Accordion>
</AccordionGroup>

## Related

- [Agent Send](/tools/agent-send) — the `message` tool that includes `react`

## Reaction trigger (`reactionTrigger`)

When `reactionTrigger` is enabled, receiving a reaction immediately wakes the agent session (via `requestHeartbeatNow`) instead of waiting for the next message or scheduled heartbeat. This lets the agent respond to reactions in real time.

Currently supported for **Slack** only. Other channels (Telegram, Discord, Signal) can be added in follow-up PRs.

**Values:**

| Value       | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| `off`       | (Default) No immediate wake on reactions.                            |
| `own`       | Wake only when a reaction is added to one of the bot's own messages. |
| `all`       | Wake on any reaction the bot can see.                                |
| `allowlist` | (Slack only) Wake for reactions from allowlisted users.              |

**Important distinctions:**

- `reactionNotifications` controls which reactions generate system events (the data the agent sees).
- `reactionTrigger` controls whether those reactions also wake the agent immediately.
- Both settings are independent — you can have notifications without triggering, or vice versa.

**Slack Free plan limitation:** Reaction events (`reaction_added` / `reaction_removed`) are not delivered on Slack Free workspaces, so `reactionTrigger` has no effect there.
