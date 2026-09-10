---
summary: "Discord bot setup, config keys, components, voice, and troubleshooting"
read_when:
  - Working on Discord channel features
title: "Discord"
---

OpenClaw connects to Discord as a bot over the official Discord gateway. DMs and guild channels are supported.

<CardGroup cols={3}>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Discord DMs default to pairing mode.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior and command catalog.
  </Card>
  <Card title="Channel troubleshooting" icon="wrench" href="/channels/troubleshooting">
    Cross-channel diagnostics and repair flow.
  </Card>
</CardGroup>

## What each page covers

- [Discord setup](/channels/discord/setup) — install the app, invite the bot, pair it, and prepare a guild workspace.
- [Discord access control](/channels/discord/access-control) — DM policy, guild allowlists, mention gating, role routing, and action gates.
- [Discord message behavior](/channels/discord/messaging) — runtime model, reply tags, link previews, ack reactions, and mention aliases.
- [Discord threads and sessions](/channels/discord/threads-and-sessions) — forum threads, history limits, subagent threads, and ACP bindings.
- [Discord components and approvals](/channels/discord/rich-messages) — components v2 containers, interactions, and exec approvals.
- [Discord events and operations](/channels/discord/events) — reaction and presence wakes, bot presence, proxying, and PluralKit.
- [Discord voice channels](/channels/discord/voice-channels) — realtime voice conversations, auto-join, and voice message attachments.
- [Discord voice transcripts and meeting notes](/channels/discord/voice-transcripts) — continuous capture, transcript storage, and automatic notes.
- [Follow users in Discord voice](/channels/discord/voice-follow) — make the bot join, move, and leave voice channels with selected users.
- [Discord troubleshooting](/channels/discord/troubleshooting) — blocked messages, intent errors, gateway timeouts, bot loops, and STT drops.

## Where each section moved

Every section heading from the previous single-page version keeps its anchor here, so an existing link such as `/channels/discord#voice-channels` still resolves. Each entry points at the page that now holds the content.

- <a id="quick-setup" />[Quick setup](/channels/discord/setup#quick-setup)
- <a id="recommended%3A-set-up-a-guild-workspace" />[Recommended: Set up a guild workspace](/channels/discord/setup#recommended%3A-set-up-a-guild-workspace)
- <a id="runtime-model" />[Runtime model](/channels/discord/messaging#runtime-model)
- <a id="forum-channels" />[Forum channels](/channels/discord/threads-and-sessions#forum-channels)
- <a id="interactive-components" />[Interactive components](/channels/discord/rich-messages#interactive-components)
- <a id="access-control-and-routing" />[Access control and routing](/channels/discord/access-control#access-control-and-routing)
- <a id="guild-channel-maps-are-allowlists" />[Guild channel maps are allowlists](/channels/discord/access-control#guild-channel-maps-are-allowlists)
- <a id="applying-access-policy-changes" />[Applying access-policy changes](/channels/discord/access-control#applying-access-policy-changes)
- <a id="role-based-agent-routing" />[Role-based agent routing](/channels/discord/access-control#role-based-agent-routing)
- <a id="native-commands-and-command-auth" />[Native commands and command auth](/channels/discord/access-control#native-commands-and-command-auth)
- <a id="feature-details" />[Feature details](/channels/discord/messaging#message-behavior)
- <a id="tools-and-action-gates" />[Tools and action gates](/channels/discord/access-control#tools-and-action-gates)
- <a id="components-v2-ui" />[Components v2 UI](/channels/discord/rich-messages#components-v2-ui)
- <a id="voice" />[Voice](/channels/discord/voice-channels#voice)
- <a id="voice-channels" />[Voice channels](/channels/discord/voice-channels#voice-channels)
- <a id="capture-voice-transcripts" />[Capture voice transcripts](/channels/discord/voice-transcripts#capture-voice-transcripts)
- <a id="meeting-notes" />[Meeting notes](/channels/discord/voice-transcripts#meeting-notes)
- <a id="follow-users-in-voice" />[Follow users in voice](/channels/discord/voice-follow#follow-users-in-voice)
- <a id="voice-messages" />[Voice messages](/channels/discord/voice-channels#voice-messages)
- <a id="troubleshooting" />[Troubleshooting](/channels/discord/troubleshooting#troubleshooting)
- <a id="recommended-set-up-a-guild-workspace" />[Recommended: Set up a guild workspace](/channels/discord/setup#recommended-set-up-a-guild-workspace)
- <a id="create-a-discord-application-and-bot" />[Create a Discord application and bot](/channels/discord/setup#create-a-discord-application-and-bot)
- <a id="enable-privileged-intents" />[Enable privileged intents](/channels/discord/setup#enable-privileged-intents)
- <a id="copy-your-bot-token" />[Copy your bot token](/channels/discord/setup#copy-your-bot-token)
- <a id="generate-an-invite-url-and-add-the-bot-to-your-server" />[Generate an invite URL and add the bot to your server](/channels/discord/setup#generate-an-invite-url-and-add-the-bot-to-your-server)
- <a id="enable-developer-mode-and-collect-your-ids" />[Enable Developer Mode and collect your IDs](/channels/discord/setup#enable-developer-mode-and-collect-your-ids)
- <a id="allow-dms-from-server-members" />[Allow DMs from server members](/channels/discord/setup#allow-dms-from-server-members)
- <a id="set-your-bot-token-securely-do-not-send-it-in-chat" />[Set your bot token securely (do not send it in chat)](/channels/discord/setup#set-your-bot-token-securely-do-not-send-it-in-chat)
- <a id="configure-openclaw-and-pair" />[Configure OpenClaw and pair](/channels/discord/setup#configure-openclaw-and-pair)
- <a id="ask-your-agent" />[Ask your agent](/channels/discord/setup#ask-your-agent)
- <a id="cli-%2F-config" />[CLI / config](/channels/discord/setup#cli-%2F-config)
- <a id="approve-first-dm-pairing" />[Approve first DM pairing](/channels/discord/setup#approve-first-dm-pairing)
- <a id="ask-your-agent-2" />[Ask your agent](/channels/discord/setup#ask-your-agent-2)
- <a id="cli" />[CLI](/channels/discord/setup#cli)
- <a id="add-your-server-to-the-guild-allowlist" />[Add your server to the guild allowlist](/channels/discord/setup#add-your-server-to-the-guild-allowlist)
- <a id="ask-your-agent-3" />[Ask your agent](/channels/discord/setup#ask-your-agent-3)
- <a id="config" />[Config](/channels/discord/setup#config)
- <a id="allow-responses-without-%40mention" />[Allow responses without @mention](/channels/discord/setup#allow-responses-without-%40mention)
- <a id="ask-your-agent-4" />[Ask your agent](/channels/discord/setup#ask-your-agent-4)
- <a id="config-2" />[Config](/channels/discord/setup#config-2)
- <a id="plan-for-memory-in-guild-channels" />[Plan for memory in guild channels](/channels/discord/setup#plan-for-memory-in-guild-channels)
- <a id="ask-your-agent-5" />[Ask your agent](/channels/discord/setup#ask-your-agent-5)
- <a id="manual" />[Manual](/channels/discord/setup#manual)
- <a id="dm-policy" />[DM policy](/channels/discord/access-control#dm-policy)
- <a id="access-groups" />[Access groups](/channels/discord/access-control#access-groups)
- <a id="guild-policy" />[Guild policy](/channels/discord/access-control#guild-policy)
- <a id="mentions-and-group-dms" />[Mentions and group DMs](/channels/discord/access-control#mentions-and-group-dms)
- <a id="introductions-when-joining-a-server" />[Introductions when joining a server](/channels/discord/messaging#introductions-when-joining-a-server)
- <a id="reply-tags-and-native-replies" />[Reply tags and native replies](/channels/discord/messaging#reply-tags-and-native-replies)
- <a id="link-previews" />[Link previews](/channels/discord/messaging#link-previews)
- <a id="live-stream-preview" />[Live stream preview](/channels/discord/messaging#live-stream-preview)
- <a id="history-context-and-thread-behavior" />[History, context, and thread behavior](/channels/discord/threads-and-sessions#history-context-and-thread-behavior)
- <a id="thread-bound-sessions-for-subagents" />[Thread-bound sessions for subagents](/channels/discord/threads-and-sessions#thread-bound-sessions-for-subagents)
- <a id="persistent-acp-channel-bindings" />[Persistent ACP channel bindings](/channels/discord/threads-and-sessions#persistent-acp-channel-bindings)
- <a id="reaction-notifications" />[Reaction notifications](/channels/discord/events#reaction-notifications)
- <a id="online-presence-events" />[Online presence events](/channels/discord/events#online-presence-events)
- <a id="ack-reactions" />[Ack reactions](/channels/discord/messaging#ack-reactions)
- <a id="config-writes" />[Config writes](/channels/discord/events#config-writes)
- <a id="gateway-proxy" />[Gateway proxy](/channels/discord/events#gateway-proxy)
- <a id="pluralkit-support" />[PluralKit support](/channels/discord/events#pluralkit-support)
- <a id="outbound-mention-aliases" />[Outbound mention aliases](/channels/discord/messaging#outbound-mention-aliases)
- <a id="presence-configuration" />[Presence configuration](/channels/discord/events#presence-configuration)
- <a id="approvals-in-discord" />[Approvals in Discord](/channels/discord/rich-messages#approvals-in-discord)
- <a id="used-disallowed-intents-or-bot-sees-no-guild-messages" />[Used disallowed intents or bot sees no guild messages](/channels/discord/troubleshooting#used-disallowed-intents-or-bot-sees-no-guild-messages)
- <a id="guild-messages-blocked-unexpectedly" />[Guild messages blocked unexpectedly](/channels/discord/troubleshooting#guild-messages-blocked-unexpectedly)
- <a id="require-mention-false-but-still-blocked" />[Require mention false but still blocked](/channels/discord/troubleshooting#require-mention-false-but-still-blocked)
- <a id="long-running-discord-turns-or-duplicate-replies" />[Long-running Discord turns or duplicate replies](/channels/discord/troubleshooting#long-running-discord-turns-or-duplicate-replies)
- <a id="gateway-metadata-lookup-timeout-warnings" />[Gateway metadata lookup timeout warnings](/channels/discord/troubleshooting#gateway-metadata-lookup-timeout-warnings)
- <a id="gateway-ready-timeout-restarts" />[Gateway READY timeout restarts](/channels/discord/troubleshooting#gateway-ready-timeout-restarts)
- <a id="permissions-audit-mismatches" />[Permissions audit mismatches](/channels/discord/troubleshooting#permissions-audit-mismatches)
- <a id="dm-and-pairing-issues" />[DM and pairing issues](/channels/discord/troubleshooting#dm-and-pairing-issues)
- <a id="bot-to-bot-loops" />[Bot to bot loops](/channels/discord/troubleshooting#bot-to-bot-loops)
- <a id="voice-stt-drops-with-decryptionfailed" />[Voice STT drops with DecryptionFailed(...)](/channels/discord/troubleshooting#voice-stt-drops-with-decryptionfailed)

## Configuration reference

Primary reference: [Configuration reference - Discord](/gateway/config-channels#discord).

<Accordion title="High-signal Discord fields">

- startup/auth: `enabled`, `token`, `applicationId`, `accounts.*`, `allowBots`
- policy: `groupPolicy`, `dmPolicy`, `allowFrom`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- group introductions: `joinIntro`, `accounts.*.joinIntro` (default: `true`)
- command: `commands.native`, `commands.allowFrom` (global), `configWrites`, `slashCommand.ephemeral`
- gateway: `proxy`
- reply/history: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- delivery: `textChunkLimit` (default `2000`), `maxLinesPerMessage` (default `17`)
- streaming: `streaming.mode`, `streaming.chunkMode`, `streaming.preview.*`, `streaming.progress.*`, `streaming.block.*` (legacy flat `streamMode`, `draftChunk`, `blockStreaming`, `blockStreamingCoalesce`, `chunkMode` keys are migrated into `streaming.*` by `openclaw doctor --fix`)
- media: `mediaMaxMb` (caps outbound Discord uploads, default `100`)
- actions: `actions.*`
- presence: `activity`, `status`, `activityType`, `activityUrl`, `autoPresence.*`
- features: `threadBindings`, top-level `bindings[]` (`type: "acp"`), `pluralkit`, `execApprovals`, `intents`, `agentComponents.enabled`, `agentComponents.ttlMs`, `activities`, `heartbeatVisibility`, `responsePrefix`

</Accordion>

### Discord Activities

Set `channels.discord.activities` to let the core `show_widget` tool post self-contained HTML widgets that open inside Discord. The block is opt-in. Discord registers the Activity plumbing statically, but the current-channel presenter stays unavailable and `/discord/activity` remains externally hidden behind the normal 404 until an enabled account has an available bot token, resolved client secret, and application ID. See [Discord Activities](/channels/discord-activities) for the Developer Portal, tunnel, security, and troubleshooting setup.

- `activities.clientSecret`: OAuth2 client secret for the Discord application; falls back to `DISCORD_CLIENT_SECRET`
- `activities.applicationId`: optional Activity application ID; defaults to the bot application ID learned at gateway startup

## Safety and operations

- Treat bot tokens as secrets (`DISCORD_BOT_TOKEN` preferred in supervised environments).
- Grant least-privilege Discord permissions.
- If command deploy/state is stale, restart the gateway and re-check with `openclaw channels status --probe`.

## Related

<CardGroup cols={2}>
  <Card title="Discord Activities" icon="window" href="/channels/discord-activities">
    Launch interactive HTML widgets inside Discord.
  </Card>
  <Card title="Pairing" icon="link" href="/channels/pairing">
    Pair a Discord user to the gateway.
  </Card>
  <Card title="Groups" icon="users" href="/channels/groups">
    Group chat and allowlist behavior.
  </Card>
  <Card title="Channel routing" icon="route" href="/channels/channel-routing">
    Route inbound messages to agents.
  </Card>
  <Card title="Security" icon="shield" href="/gateway/security">
    Threat model and hardening.
  </Card>
  <Card title="Multi-agent routing" icon="sitemap" href="/concepts/multi-agent">
    Map guilds and channels to agents.
  </Card>
  <Card title="Slash commands" icon="terminal" href="/tools/slash-commands">
    Native command behavior.
  </Card>
</CardGroup>
