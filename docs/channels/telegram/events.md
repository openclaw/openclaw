---
summary: "Reaction notifications, config writes from Telegram events, and error reply policy"
read_when:
  - Waking an agent on a Telegram reaction
  - Allowing or blocking config writes from Telegram
  - Stopping error messages from reaching a chat
title: "Telegram events and operations"
sidebarTitle: "Events and operations"
---

Operational Telegram surfaces: reaction wakes, config writes, and what the bot says when something fails.

## Events and operations

<AccordionGroup>
  <Accordion title="Reaction notifications">
    Telegram reactions arrive as `message_reaction` updates, separate from message payloads. When enabled, OpenClaw enqueues system events like `Telegram reaction added: 👍 by Alice (@alice) on msg 42`.

    - `channels.telegram.reactionNotifications`: `off | own | all` (default: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (default: `minimal`)

    `own` means user reactions to bot-sent messages only (best-effort via a sent-message cache). Reaction events still respect Telegram access controls (`dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`); unauthorized senders are dropped.

    Telegram does not provide topic metadata in reaction updates. Ordinary non-forum groups remain chat-scoped. Forum and channel Direct Messages reactions recover the originating topic from OpenClaw's bounded message cache (keyed by account, chat, and message ID), so topic config, topic agents, and conversation bindings still apply. If the cached topic is missing or belongs to the wrong scope, OpenClaw skips the reaction notification and logs a warning instead of falling back to General or the base chat.

    `allowed_updates` for polling/webhook include `message_reaction` automatically.

  </Accordion>

  <Accordion title="Config writes from Telegram events and commands">
    Channel config writes are enabled by default (`configWrites !== false`). Telegram-triggered writes include group migration events (`migrate_to_chat_id`, updates `channels.telegram.groups`) and `/config set` / `/config unset` (requires command enablement).

    Disable:

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>
</AccordionGroup>

## Error reply controls

When the agent hits a delivery or provider error, the error policy controls whether error messages reach the Telegram chat:

| Key                             | Values                     | Default  | Description                                                                                                                                                                |
| ------------------------------- | -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels.telegram.errorPolicy` | `always`, `once`, `silent` | `always` | `always` sends every error message to the chat. `once` sends each unique error message once per built-in cooldown window. `silent` never sends error messages to the chat. |

Per-account, per-group, and per-topic overrides are supported (same inheritance as other Telegram config keys).

```json5
{
  channels: {
    telegram: {
      errorPolicy: "always",
      groups: {
        "-1001234567890": {
          errorPolicy: "silent", // suppress errors in this group
        },
      },
    },
  },
}
```
