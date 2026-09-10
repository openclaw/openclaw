---
summary: "DM policy, guild allowlists, mention gating, role routing, command auth, and action gates"
read_when:
  - Deciding who may talk to the Discord bot and where
  - Routing guild channels or roles to specific agents
  - Gating Discord message actions and native commands
title: "Discord access control"
sidebarTitle: "Access control"
---

Who may reach the bot, which guild channels it answers in, and which Discord actions it is allowed to take.

## Access control and routing

<Tabs>
  <Tab title="DM policy">
    `channels.discord.dmPolicy` controls DM access. `channels.discord.allowFrom` is the canonical DM allowlist.

    - `pairing` (default)
    - `allowlist` (requires at least one `allowFrom` sender)
    - `open` (requires `channels.discord.allowFrom` to include `"*"`)
    - `disabled`

    If DM policy is not open, unknown users are blocked (or prompted for pairing in `pairing` mode).

    Multi-account precedence:

    - Omitted account `dmPolicy` and `groupPolicy` inherit the channel root. Explicit account policies win; with neither scope set, defaults remain `pairing` and `allowlist` respectively.
    - `channels.discord.accounts.default.allowFrom` applies only to the `default` account.
    - For one account, `allowFrom` takes precedence over legacy `dm.allowFrom`.
    - Named accounts inherit `channels.discord.allowFrom` when their own `allowFrom` and legacy `dm.allowFrom` are unset.
    - Named accounts do not inherit `channels.discord.accounts.default.allowFrom`.

    Legacy `channels.discord.dm.policy` and `channels.discord.dm.allowFrom` are still read for compatibility. `openclaw doctor --fix` migrates them to `dmPolicy` and `allowFrom` when it can do so without changing access.

    DM target format for delivery:

    - `user:<id>`
    - `<@id>` mention

    Bare numeric IDs normally resolve as channel IDs when a channel default is active, but IDs listed in the account's effective DM `allowFrom` are treated as user DM targets for compatibility.

  </Tab>

  <Tab title="Access groups">
    Discord DMs and text command authorization can use dynamic `accessGroup:<name>` entries in `channels.discord.allowFrom`.

    Access group names are shared across message channels. Use `type: "message.senders"` for a static group whose members are expressed in each channel's normal `allowFrom` syntax, or `type: "discord.channelAudience"` when a Discord channel's current `ViewChannel` audience should define membership dynamically. Shared access-group behavior: [Access groups](/channels/access-groups).

```json5
{
  accessGroups: {
    operators: {
      type: "message.senders",
      members: {
        "*": ["global-owner-id"],
        discord: ["discord:123456789012345678"],
        telegram: ["987654321"],
      },
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:operators"],
    },
  },
}
```

    A Discord text channel has no separate member list. `type: "discord.channelAudience"` models membership as: the DM sender is a member of the configured guild and currently has effective `ViewChannel` permission on the configured channel after role and channel overwrites are applied.

    Example: allow anyone who can see `#maintainers` to DM the bot, while keeping DMs closed to everyone else.

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
      membership: "canViewChannel",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers"],
    },
  },
}
```

    You can mix dynamic and static entries:

```json5
{
  accessGroups: {
    maintainers: {
      type: "discord.channelAudience",
      guildId: "1456350064065904867",
      channelId: "1456744319972282449",
    },
  },
  channels: {
    discord: {
      dmPolicy: "allowlist",
      allowFrom: ["accessGroup:maintainers", "discord:123456789012345678"],
    },
  },
}
```

    Lookups fail closed. If Discord returns `Missing Access`, the member lookup fails, or the channel belongs to a different guild, the DM sender is treated as unauthorized.

    Enable the Discord Developer Portal **Server Members Intent** when using channel-audience access groups. DMs do not include guild member state, so OpenClaw resolves the member through Discord REST at authorization time.

  </Tab>

  <Tab title="Guild policy">
    Guild handling is controlled by `channels.discord.groupPolicy`:

    - `open`
    - `allowlist`
    - `disabled`

    Secure baseline when `channels.discord` exists is `allowlist`.

    `allowlist` behavior:

    - guild must match `channels.discord.guilds` (`id` preferred, slug accepted)
    - optional sender allowlists: `users` (stable IDs recommended) and `roles` (role IDs only); if either is configured, senders are allowed when they match `users` OR `roles`
    - direct name/tag matching is disabled by default; enable `channels.discord.dangerouslyAllowNameMatching: true` only as break-glass compatibility mode
    - names/tags are supported for `users`, but IDs are safer; `openclaw security audit` warns when name/tag entries are used
    - if a guild has `channels` configured, non-listed channels are denied
    - if a guild has no `channels` block, all channels in that allowlisted guild are allowed

    Example:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          ignoreOtherMentions: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { enabled: true },
            help: { enabled: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    The legacy per-channel `allow` key is migrated to `enabled` by `openclaw doctor --fix`.

    Without a `channels.discord` block, the Gateway does not auto-start Discord from `DISCORD_BOT_TOKEN`. Once the block exists, `DISCORD_BOT_TOKEN` remains the default-account token fallback. Passing `--ambient-channels` opts into env-only auto-configuration; that path uses `groupPolicy="allowlist"` and logs a warning, even if `channels.defaults.groupPolicy` is `open`.

  </Tab>

  <Tab title="Mentions and group DMs">
    Guild messages are mention-gated by default.

    Mention detection includes:

    - explicit bot mention
    - configured mention patterns (`agents.entries.*.groupChat.mentionPatterns`, fallback `messages.groupChat.mentionPatterns`)
    - implicit reply-to-bot behavior in supported cases

    When writing outbound Discord messages, use canonical mention syntax: `<@USER_ID>` for users, `<#CHANNEL_ID>` for channels, and `<@&ROLE_ID>` for roles. Do not use the legacy `<@!USER_ID>` nickname mention form.

    `requireMention` is configured per guild/channel (`channels.discord.guilds...`).
    `ignoreOtherMentions` optionally drops messages addressed to another identity but not the bot. This covers explicit user/role mentions (excluding @everyone/@here) and replies to another non-webhook bot. An explicit mention of the current bot still wins.

    Group DMs:

    - default: ignored (`dm.groupEnabled=false`)
    - optional allowlist via `dm.groupChannels` (channel IDs or slugs)

  </Tab>
</Tabs>

### Guild channel maps are allowlists

A guild entry with no `channels` map lets the bot work in every channel it can see, subject to the guild's `requireMention` and `users` rules. **Adding even one channel entry turns the map into an allowlist**: any channel not matched by an entry is denied, not merely left at guild defaults.

This surprises people who add one channel to give it special settings and find the bot has gone silent everywhere else. Use the `"*"` wildcard key to keep the rest of the guild reachable:

```json5
{
  channels: {
    discord: {
      guilds: {
        YOUR_SERVER_ID: {
          requireMention: true,
          users: ["YOUR_USER_ID"],
          channels: {
            // always-on room: everyone in it can talk to the bot, no mention needed
            YOUR_CHANNEL_ID: { enabled: true, requireMention: false, users: ["*"] },
            // every other channel keeps the guild defaults
            "*": { enabled: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

Channel entries override guild-level values, so a channel entry with `users: ["*"]` opens that one room to any sender even when the guild `users` list is narrow. Entries match by channel ID, name, or slug, and a thread falls back to its parent channel's entry.

### Applying access-policy changes

For running Discord accounts, policy-only changes saved in the Control UI apply
through the Gateway's validated runtime config publication without restarting the
Discord connection or waiting for active Control UI turns to finish. This covers
`groupPolicy`, `dmPolicy`, `allowFrom`, `dm`, `guilds`, `allowBots`, and
`dangerouslyAllowNameMatching`, both at `channels.discord` and under
`channels.discord.accounts.<accountId>`.

New messages and interactions use the published policy, including guild/channel
membership, user and role allowlists, and mention requirements. Name-based entries
are resolved and cached for the policy revision before admission; already admitted
work retains its existing context. If a name-policy lookup cannot finish within
an interaction's response budget, components show an ephemeral policy-updating
message and autocomplete returns no choices. A later interaction uses the resolved
policy; the expired interaction is never resumed.

Token, application ID, proxy, intents, command registration, voice configuration,
and account enablement still use the channel's restart path and drain deferral.
A write that mixes policy and restart-required settings stays one deferred
transaction. Manual channel stop/start reads the committed config; it does not
publish a pending transport change from disk.

### Role-based agent routing

Use `bindings[].match.roles` to route Discord guild members to different agents by role ID. Role-based bindings accept role IDs only and are evaluated after peer or parent-peer bindings and before guild-only bindings. If a binding also sets other match fields (for example `peer` + `guildId` + `roles`), all configured fields must match.

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Native commands and command auth

- `commands.native` defaults to `"auto"` and is enabled for Discord.
- Per-channel override: `channels.discord.commands.native`.
- `commands.native=false` skips Discord slash-command registration and cleanup during startup. Previously registered commands may remain visible in Discord until you remove them from the Discord app.
- Native command auth uses the same Discord allowlists/policies as normal message handling.
- Commands may still be visible in the Discord UI for unauthorized users; execution enforces OpenClaw auth and replies "not authorized".
- Default slash command settings: `ephemeral: true` (`channels.discord.slashCommand.ephemeral`).

See [Slash commands](/tools/slash-commands) for the command catalog and behavior.

## Tools and action gates

Discord message actions cover messaging, channel admin, moderation, presence, and metadata.

Core examples:

- messaging: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- reactions: `react`, `reactions`, `emoji-list`
- moderation: `timeout`, `kick`, `ban`
- presence: `setPresence`

Use `emoji-list` to discover the current server's custom emoji:

```json
{ "action": "emoji-list", "channel": "discord", "limit": 25 }
```

`guildId` defaults to the current conversation's server; provide it explicitly to query another server. Results are sorted by name, and `limit` defaults to and cannot exceed 100:

```json
{
  "ok": true,
  "emojis": [
    { "name": "dance", "identifier": "dance:456", "animated": true },
    { "name": "party", "identifier": "party:123" }
  ]
}
```

Pass `identifier` directly to `react`. Discord accepts Unicode emoji, custom `name:id` identifiers, and the `<:name:id>` or `<a:name:id>` forms. `emoji-list`, `react`, and `reactions` are all controlled by `channels.discord.actions.reactions`.

The `event-create` action accepts an optional `image` parameter (URL or local file path) to set the scheduled event cover image.

Action gates live under `channels.discord.actions.*`.

Default gate behavior:

| Action group                                                                                                                                                             | Default  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | enabled  |
| roles                                                                                                                                                                    | disabled |
| moderation                                                                                                                                                               | disabled |
| presence                                                                                                                                                                 | disabled |
