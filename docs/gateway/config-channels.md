---
summary: "Channel configuration: access control, pairing, per-channel keys across Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, and more"
read_when:
  - Configuring a channel plugin (auth, access control, multi-account)
  - Troubleshooting per-channel config keys
  - Auditing DM policy, group policy, or mention gating
title: "Configuration — channels"
---

Per-channel configuration keys under `channels.*`: DM and group access, multi-account setups, mention gating, and per-channel keys for Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, and other channel plugins.

For agents, tools, gateway runtime, and other top-level keys, see [Configuration reference](/gateway/configuration-reference).

## Channels

Each channel starts automatically when its config section exists (unless `enabled: false`). Telegram ships inside the core `openclaw` package. Other official channels (iMessage, Discord, Slack, WhatsApp, Matrix, Microsoft Teams, IRC, Google Chat, Signal, Mattermost, and more) install as separate plugins with `openclaw plugins install <spec>`; see [Channels](/channels) for the full list and install specs.

## Other plugin channels

Many plugin channels are configured as `channels.<id>` and documented in their dedicated channel pages (for example Feishu, Nextcloud Talk, Nostr, QQ Bot, Synology Chat, Twitch, and Zalo).
See the full channel index: [Channels](/channels).

## What each page covers

- [Configuration — shared channel policies](/gateway/config-channels/shared-policies) — DM and group access policies, `channels.modelByChannel`, `channels.defaults`, heartbeat visibility, and the shared multi-account pattern.
- [Configuration — personal messaging channels](/gateway/config-channels/personal-messaging) — `channels.*` keys for WhatsApp, Telegram, Signal, iMessage, and LINE.
- [Configuration — workplace chat channels](/gateway/config-channels/workplace-chat) — `channels.*` keys for Google Chat, Slack, Mattermost, and Microsoft Teams.
- [Configuration — community chat channels](/gateway/config-channels/community-chat) — `channels.*` keys for Discord, Matrix, and IRC.
- [Configuration — group mention gating and history](/gateway/config-channels/mention-gating-and-history) — mention gating, visible reply modes, DM history limits, and self-chat mode.
- [Configuration — chat commands](/gateway/config-channels/commands) — the `commands.*` block: command surfaces, bash and config gating, and owner allowlists.

## Where each section moved

Every heading this page used to publish keeps its anchor here, so an existing
link such as `/gateway/config-channels#imessage` still resolves. Each entry
points at the page that now holds the content.

- <a id="dm-and-group-access" />[DM and group access](/gateway/config-channels/shared-policies#dm-and-group-access)
- <a id="channel-model-overrides" />[Channel model overrides](/gateway/config-channels/shared-policies#channel-model-overrides)
- <a id="channel-defaults-and-heartbeat" />[Channel defaults and heartbeat](/gateway/config-channels/shared-policies#channel-defaults-and-heartbeat)
- <a id="multi-account-(all-channels)" /><a id="multi-account-all-channels" />[Multi-account (all channels)](/gateway/config-channels/shared-policies#multi-account-all-channels)
- <a id="whatsapp" />[WhatsApp](/gateway/config-channels/personal-messaging#whatsapp)
- <a id="multi-account-whatsapp" />[Multi-account WhatsApp](/gateway/config-channels/personal-messaging#multi-account-whatsapp)
- <a id="telegram" />[Telegram](/gateway/config-channels/personal-messaging#telegram)
- <a id="signal" />[Signal](/gateway/config-channels/personal-messaging#signal)
- <a id="imessage" />[iMessage](/gateway/config-channels/personal-messaging#imessage)
- <a id="imessage-ssh-wrapper-example" />[iMessage SSH wrapper example](/gateway/config-channels/personal-messaging#imessage-ssh-wrapper-example)
- <a id="line" />[LINE](/gateway/config-channels/personal-messaging#line)
- <a id="google-chat" />[Google Chat](/gateway/config-channels/workplace-chat#google-chat)
- <a id="slack" />[Slack](/gateway/config-channels/workplace-chat#slack)
- <a id="mattermost" />[Mattermost](/gateway/config-channels/workplace-chat#mattermost)
- <a id="microsoft-teams" />[Microsoft Teams](/gateway/config-channels/workplace-chat#microsoft-teams)
- <a id="discord" />[Discord](/gateway/config-channels/community-chat#discord)
- <a id="matrix" />[Matrix](/gateway/config-channels/community-chat#matrix)
- <a id="irc" />[IRC](/gateway/config-channels/community-chat#irc)
- <a id="group-chat-mention-gating" />[Group chat mention gating](/gateway/config-channels/mention-gating-and-history#group-chat-mention-gating)
- <a id="dm-history-limits" />[DM history limits](/gateway/config-channels/mention-gating-and-history#dm-history-limits)
- <a id="self-chat-mode" />[Self-chat mode](/gateway/config-channels/mention-gating-and-history#self-chat-mode)
- <a id="commands-(chat-command-handling)" /><a id="commands-chat-command-handling" />[Commands (chat command handling)](/gateway/config-channels/commands#commands-chat-command-handling)
- <a id="command-details" />[Command details](/gateway/config-channels/commands#command-details)

---

## Related

- [Configuration reference](/gateway/configuration-reference) — top-level keys
- [Configuration — agents](/gateway/config-agents)
- [Channels overview](/channels)
