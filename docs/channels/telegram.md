---
summary: "Telegram bot support status, capabilities, and configuration"
read_when:
  - Working on Telegram features or webhooks
title: "Telegram"
---

This page connects a Telegram bot to OpenClaw and sets who is allowed to message it.

Telegram is production-ready for bot DMs and groups via grammY. Long polling is the default transport. Webhook mode is optional.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Default DM policy for Telegram is pairing.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair playbooks.
  </Card>
  <Card title="Gateway configuration" icon="settings" href="/gateway/configuration">
    Full channel config patterns and examples.
  </Card>
</CardGroup>

## What each page covers

- [Telegram setup](/channels/telegram/setup) — install the bot, set the token, approve the first DM, and add the bot to a group.
- [Telegram access control](/channels/telegram/access-control) — DM policy, group allowlists, mention gating, and per-chat tool policy.
- [Telegram message behavior](/channels/telegram/messaging) — runtime model, stream previews, native commands, reply tags, and send limits.
- [Telegram threads and sessions](/channels/telegram/threads-and-sessions) — forum topic session keys, per-topic agents, and ACP bindings.
- [Telegram rich messages and approvals](/channels/telegram/rich-messages) — Bot API 10.3 rich messages, inline buttons, message actions, and exec approvals.
- [Telegram media and attachments](/channels/telegram/media) — photo albums, voice and video notes, locations, venues, and stickers.
- [Telegram events and operations](/channels/telegram/events) — reaction notifications, config writes, and error reply policy.
- [Telegram transports](/channels/telegram/transports) — long polling and webhook mode compared.
- [Telegram Dashboard Mini App](/channels/telegram/mini-app) — open the Control UI inside Telegram with `/dashboard`.
- [Telegram troubleshooting](/channels/telegram/troubleshooting) — silent groups, missing commands, rejected tokens, and unstable polling.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/telegram#troubleshooting` still resolves. Each entry points at the page that now holds the content.

- <a id="quick-setup" />[Quick setup](/channels/telegram/setup#quick-setup)
- <a id="telegram-side-settings" />[Telegram side settings](/channels/telegram/setup#telegram-side-settings)
- <a id="dashboard-mini-app" />[Dashboard Mini App](/channels/telegram/mini-app#dashboard-mini-app)
- <a id="access-control-and-activation" />[Access control and activation](/channels/telegram/access-control#access-control-and-activation)
- <a id="group-bot-identity" />[Group bot identity](/channels/telegram/access-control#group-bot-identity)
- <a id="finding-your-telegram-user-id" />[Finding your Telegram user ID](/channels/telegram/access-control#finding-your-telegram-user-id)
- <a id="runtime-behavior" />[Runtime behavior](/channels/telegram/messaging#runtime-behavior)
- <a id="feature-reference" />[Feature reference](/channels/telegram#what-each-page-covers)
- <a id="device-pairing-commands-(device-pair-plugin)" />[Device pairing commands (`device-pair` plugin)](</channels/telegram/messaging#device-pairing-commands-(device-pair-plugin)>)
- <a id="photo-albums" />[Photo albums](/channels/telegram/media#photo-albums)
- <a id="audio-messages" />[Audio messages](/channels/telegram/media#audio-messages)
- <a id="video-messages" />[Video messages](/channels/telegram/media#video-messages)
- <a id="locations-and-venues" />[Locations and venues](/channels/telegram/media#locations-and-venues)
- <a id="stickers" />[Stickers](/channels/telegram/media#stickers)
- <a id="error-reply-controls" />[Error reply controls](/channels/telegram/events#error-reply-controls)
- <a id="troubleshooting" />[Troubleshooting](/channels/telegram/troubleshooting#troubleshooting)
- <a id="device-pairing-commands-device-pair-plugin" />[Device pairing commands (`device-pair` plugin)](/channels/telegram/messaging#device-pairing-commands-device-pair-plugin)
- <a id="create-the-bot-token-in-botfather" />[Create the bot token in BotFather](/channels/telegram/setup#create-the-bot-token-in-botfather)
- <a id="configure-token-and-dm-policy" />[Configure token and DM policy](/channels/telegram/setup#configure-token-and-dm-policy)
- <a id="restart-the-gateway" />[Restart the gateway](/channels/telegram/setup#restart-the-gateway)
- <a id="approve-your-first-dm" />[Approve your first DM](/channels/telegram/setup#approve-your-first-dm)
- <a id="add-the-bot-to-a-group" />[Add the bot to a group](/channels/telegram/setup#add-the-bot-to-a-group)
- <a id="privacy-mode-and-group-visibility" />[Privacy mode and group visibility](/channels/telegram/setup#privacy-mode-and-group-visibility)
- <a id="group-permissions" />[Group permissions](/channels/telegram/setup#group-permissions)
- <a id="helpful-botfather-toggles" />[Helpful BotFather toggles](/channels/telegram/setup#helpful-botfather-toggles)
- <a id="dm-policy" />[DM policy](/channels/telegram/access-control#dm-policy)
- <a id="group-policy-and-allowlists" />[Group policy and allowlists](/channels/telegram/access-control#group-policy-and-allowlists)
- <a id="mention-behavior" />[Mention behavior](/channels/telegram/access-control#mention-behavior)
- <a id="live-stream-preview-message-edits" />[Live stream preview (message edits)](/channels/telegram/messaging#live-stream-preview-message-edits)
- <a id="rich-message-formatting" />[Rich message formatting](/channels/telegram/rich-messages#rich-message-formatting)
- <a id="native-commands-and-custom-commands" />[Native commands and custom commands](/channels/telegram/messaging#native-commands-and-custom-commands)
- <a id="inline-buttons" />[Inline buttons](/channels/telegram/rich-messages#inline-buttons)
- <a id="telegram-message-actions-for-agents-and-automation" />[Telegram message actions for agents and automation](/channels/telegram/rich-messages#telegram-message-actions-for-agents-and-automation)
- <a id="reply-threading-tags" />[Reply threading tags](/channels/telegram/messaging#reply-threading-tags)
- <a id="forum-topics-and-thread-behavior" />[Forum topics and thread behavior](/channels/telegram/threads-and-sessions#forum-topics-and-thread-behavior)
- <a id="photo-albums-audio-video-and-stickers" />[Photo albums, audio, video, and stickers](/channels/telegram/media#photo-albums-audio-video-and-stickers)
- <a id="reaction-notifications" />[Reaction notifications](/channels/telegram/events#reaction-notifications)
- <a id="ack-reactions" />[Ack reactions](/channels/telegram/messaging#ack-reactions)
- <a id="config-writes-from-telegram-events-and-commands" />[Config writes from Telegram events and commands](/channels/telegram/events#config-writes-from-telegram-events-and-commands)
- <a id="long-polling-vs-webhook" />[Long polling vs webhook](/channels/telegram/transports#long-polling-vs-webhook)
- <a id="limits-and-cli-targets" />[Limits and CLI targets](/channels/telegram/messaging#limits-and-cli-targets)
- <a id="exec-approvals-in-telegram" />[Exec approvals in Telegram](/channels/telegram/rich-messages#exec-approvals-in-telegram)
- <a id="bot-does-not-respond-to-non-mention-group-messages" />[Bot does not respond to non mention group messages](/channels/telegram/troubleshooting#bot-does-not-respond-to-non-mention-group-messages)
- <a id="bot-not-seeing-group-messages-at-all" />[Bot not seeing group messages at all](/channels/telegram/troubleshooting#bot-not-seeing-group-messages-at-all)
- <a id="commands-work-partially-or-not-at-all" />[Commands work partially or not at all](/channels/telegram/troubleshooting#commands-work-partially-or-not-at-all)
- <a id="startup-reports-unauthorized-token" />[Startup reports unauthorized token](/channels/telegram/troubleshooting#startup-reports-unauthorized-token)
- <a id="polling-or-network-instability" />[Polling or network instability](/channels/telegram/troubleshooting#polling-or-network-instability)

## Configuration reference

Primary reference: [Configuration reference - Telegram](/gateway/config-channels#telegram).

`openclaw doctor --fix` removes retired tuning settings (`timeoutSeconds`, `mediaGroupFlushMs`, `pollingStallThresholdMs`, `retry`, and `errorCooldownMs`) from their former configuration scopes. Account names and sender-specific tool-policy keys are preserved, even when they match a retired setting name.

<Accordion title="High-signal Telegram fields">

- startup/auth: `enabled`, `botToken`, `tokenFile` (must be a regular file; symlinks are rejected), `accounts.*`
- access control: `dmPolicy`, `allowFrom`, `direct.*.tools`, `direct.*.toolsBySender`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`, top-level `bindings[]` (`type: "acp"`)
- group introductions: `joinIntro`, `accounts.*.joinIntro` (default: `true`)
- topic defaults: `groups.<chatId>.topics."*"` applies to unmatched forum topics; exact topic IDs override it
- exec approvals: `execApprovals`, `accounts.*.execApprovals`
- command/menu: `commands.native`, `commands.nativeSkills`, `customCommands`
- threading/replies: `replyToMode`, `threadBindings`
- streaming: `streaming` (modes `off | partial | block | progress`), `streaming.preview.toolProgress`
- formatting/delivery: `textChunkLimit`, `streaming.chunkMode`, `richMessages`, `markdown.tables` (`off | bullets | code | block`), `linkPreview`, `responsePrefix`
- media/network: `mediaMaxMb`, `network.autoSelectFamily`, `network.dangerouslyAllowPrivateNetwork`, `proxy`
- custom API root: `apiRoot` (Bot API root only; do not include `/bot<TOKEN>`), `trustedLocalFileRoots` (self-hosted Bot API absolute `file_path` roots)
- webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`, `webhookPort`, `webhookCertPath`
- actions/capabilities: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker|createForumTopic|editForumTopic`
- reactions: `reactionNotifications`, `reactionLevel`
- errors: `errorPolicy`, `silentErrorReplies`
- writes/history: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

</Accordion>

<Note>
Multi-account precedence: with two or more account IDs configured, set `channels.telegram.defaultAccount` (or include `channels.telegram.accounts.default`) to make default routing explicit. Otherwise OpenClaw falls back to the first normalized account ID and `openclaw doctor` warns. Omitted account `dmPolicy`, `groupPolicy`, `allowFrom`, and `groupAllowFrom` inherit the channel root, not `accounts.default.*`. Explicit account policies win; if neither scope sets them, DMs use `pairing` and groups use `allowlist`.
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Telegram user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group and topic allowlist behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Multi-agent routing" icon="sitemap" href="/concepts/multi-agent">
    Map groups and topics to agents.
  </Card>
  <Card title="Troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics.
  </Card>
</CardGroup>
