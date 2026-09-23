---
summary: "Per-channel config keys for Discord, Matrix, and IRC"
read_when:
  - Configuring Discord, Matrix, or IRC
  - Setting Discord guild, voice, presence, or exec approval keys
  - Choosing Matrix auth, proxy, or auto-join behavior
title: "Configuration — community chat channels"
---

`channels.*` keys for the community chat channels: Discord, Matrix, and IRC.

## Discord

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 100,
      allowBots: false,
      actions: {
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all | batched
      dmPolicy: "pairing",
      allowFrom: ["1234567890", "123456789012345678"],
      dm: { enabled: true, groupEnabled: false, groupChannels: ["openclaw-dm"] },
      guilds: {
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          ignoreOtherMentions: true,
          reactionNotifications: "own",
          users: ["987654321098765432"],
          channels: {
            general: { enabled: true },
            help: {
              enabled: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20,
      textChunkLimit: 2000,
      suppressEmbeds: true,
      streaming: {
        mode: "progress", // explicit opt-in; Discord defaults to off
        chunkMode: "length", // length | newline
        progress: {
          label: "auto",
          maxLines: 8,
          maxLineChars: 120,
          toolProgress: true,
        },
      },
      maxLinesPerMessage: 17,
      threadBindings: {
        enabled: true,
        idleHours: 24,
        maxAgeHours: 0,
        spawnSessions: true,
        defaultSpawnContext: "fork",
      },
      voice: {
        enabled: true,
        autoJoin: [
          {
            guildId: "123456789012345678",
            channelId: "234567890123456789",
            whenOccupied: true,
          },
        ],
        daveEncryption: true,
        decryptionFailureTolerance: 24,
        connectTimeoutMs: 30000,
        reconnectGraceMs: 15000,
        tts: {
          provider: "openai",
          providers: { openai: { speakerVoice: "alloy" } },
        },
      },
      execApprovals: {
        enabled: "auto", // true | false | "auto"
        approvers: ["987654321098765432"],
        agentFilter: ["default"],
        sessionFilter: ["discord:"],
        target: "dm", // dm | channel | both
        cleanupAfterResolve: false,
      },
    },
  },
}
```

- Token: `channels.discord.token`, with `DISCORD_BOT_TOKEN` as fallback for the default account.
- `channels.discord.joinIntro` defaults to `true`. When the bot joins an allowed server, it posts one introduction in the system channel when permitted, or the first text channel where it can view and send messages. Recent messages are included only when the bot can read message history. Set this option to `false` to disable introductions, or use `channels.discord.accounts.<accountId>.joinIntro` for an account-specific override. Up to 100 recent messages are read when permitted, once per server; see [group join introductions](/channels#group-join-introductions). Introductions never run in direct messages.
- Direct outbound calls that provide an explicit Discord `token` use that token for the call; account policy settings still come from the selected account in the active runtime snapshot.
- Optional `channels.discord.defaultAccount` overrides default account selection when it matches a configured account id.
- Use `user:<id>` (DM) or `channel:<id>` (guild channel) for delivery targets; bare numeric IDs are rejected.
- `actions.reactions` controls `react`, `reactions`, and `emoji-list`; emoji discovery defaults to the current server unless `guildId` is provided.
- Guild slugs are lowercase with spaces replaced by `-`; channel keys use the slugged name (no `#`). Prefer guild IDs.
- Bot-authored messages are ignored by default. `allowBots: true` enables them; use `allowBots: "mentions"` to only accept bot messages that mention the bot (own messages still filtered).
- Channels that support bot-authored inbound messages can use shared [bot loop protection](/channels/bot-loop-protection). Set `channels.defaults.botLoopProtection` for baseline pair budgets, then override the channel or account only when one surface needs different limits.
- `channels.discord.guilds.<id>.ignoreOtherMentions` (and channel overrides) drops messages addressed to another identity but not the bot. This covers explicit user/role mentions (excluding @everyone/@here) and replies to another non-webhook bot; an explicit mention of the current bot still wins.
- `channels.discord.mentionAliases` maps stable outbound `@handle` text to Discord user IDs before sending, so known teammates can be mentioned deterministically even when the transient directory cache is empty. Per-account overrides live under `channels.discord.accounts.<accountId>.mentionAliases`.
- `maxLinesPerMessage` (default `17`) splits tall messages even when under 2000 chars.
- `channels.discord.suppressEmbeds` defaults to `true`, so outbound URLs do not expand into Discord link previews unless disabled. Explicit `embeds` payloads still send normally; per-message tool calls can override with `suppressEmbeds`.
- `channels.discord.threadBindings` controls Discord thread-bound routing:
  - `enabled`: Discord override for thread-bound session spawning, delivery, and routing; manage bindings with `/session unbind`, `/agents`, `/session idle`, and `/session max-age`
  - `idleHours`: Discord override for inactivity auto-unbind in hours (`0` disables)
  - `maxAgeHours`: Discord override for hard max age in hours (`0` disables)
  - `spawnSessions`: switch for `sessions_spawn({ thread: true })` and ACP thread-spawn auto thread creation/binding (default: `true`)
  - `defaultSpawnContext`: native subagent context for thread-bound spawns (`"fork"` by default)
- Top-level `bindings[]` entries with `type: "acp"` configure persistent ACP bindings for channels and threads (use channel/thread id in `match.peer.id`). Field semantics are shared in [ACP Agents](/tools/acp-agents#persistent-channel-bindings).
- `channels.discord.agentComponents.ttlMs` controls how long sent Discord component callbacks remain registered. Default `1800000` (30 minutes), maximum `86400000` (24 hours). Per-account overrides live under `channels.discord.accounts.<accountId>.agentComponents.ttlMs`. Prefer the shortest TTL that fits the workflow.
- `channels.discord.voice` enables Discord voice channel conversations and optional auto-join + LLM + TTS overrides. Text-only Discord configs leave voice off by default; set `channels.discord.voice.enabled=true` to opt in.
- `channels.discord.voice.autoJoin[].whenOccupied` keeps an auto-managed voice channel disconnected until a human is present, then leaves when the last human departs. It defaults to `false`; bots do not count as occupants, and manual or ad-hoc voice sessions are not managed by this policy.
- `channels.discord.voice.model` optionally overrides the LLM model used for Discord voice channel responses.
- `channels.discord.voice.daveEncryption` (default `true`) and `channels.discord.voice.decryptionFailureTolerance` (default `24`) pass through to `@discordjs/voice` DAVE options.
- `channels.discord.voice.connectTimeoutMs` controls the initial `@discordjs/voice` Ready wait for `/vc join` and auto-join attempts (default `30000`).
- `channels.discord.voice.reconnectGraceMs` controls how long a disconnected voice session may take to enter reconnect signalling before OpenClaw destroys it (default `15000`).
- Discord voice playback is not interrupted by another user's speaking-start event. To avoid feedback loops, OpenClaw ignores new voice capture while TTS is playing.
- OpenClaw additionally attempts voice receive recovery by leaving/rejoining a voice session after repeated decrypt failures.
- `channels.discord.streaming` is the canonical stream mode key. Discord preview streaming defaults to `off`; set `streaming.mode: "progress"` to opt into one edited tool/work progress message, or choose `partial` or `block` for answer previews. Legacy flat keys (`streamMode`, `chunkMode`, `blockStreaming`, `draftChunk`, `blockStreamingCoalesce`) are no longer read at runtime; run `openclaw doctor --fix` to migrate persisted config.
- `channels.discord.autoPresence` maps runtime availability to bot presence (healthy => online, degraded => idle, exhausted => dnd) and allows optional status text overrides.
- `channels.discord.guilds.<id>.presenceEvents` routes human availability arrivals into one configured Discord channel as agent system events. Eligible members must be able to view `channelId`; public threads inherit parent visibility, while private threads additionally require membership or Manage Threads. `users` can further narrow that audience. It seeds current online members from complete `GUILD_CREATE` snapshots, routes observed offline-to-online transitions, and treats a first later online signal for an unseen member as newly available without asserting whether they came online or joined after the snapshot. Guilds above Discord's 75,000-member snapshot limit require an explicit offline update first. Throttling knobs: `reconnectSuppressSeconds` (quiet window after a new Gateway session while guild presence state is rebuilt, default 300, `0` disables) and `burstLimit`/`burstWindowSeconds` (per-guild successfully queued event rate limit, default 8 events per 60s sliding window). Resumed sessions do not start the reconnect suppression window. The existing per-user re-greet cooldown remains eight hours. It requires `channels.discord.intents.presence=true`, the privileged Presence Intent in Discord's Developer Portal, and an enabled agent heartbeat.
- `channels.discord.intents.messageContent` defaults to `true`. Set it to `false` only for mention-only operation when Discord cannot grant the privileged Message Content intent; DMs and explicit bot mentions still carry message content, while other guild messages do not. Keep `requireMention: true` on every configured guild channel in this mode.
- `channels.discord.dangerouslyAllowNameMatching` re-enables mutable name/tag matching (break-glass compatibility mode).
- `channels.discord.execApprovals`: Discord-native exec approval delivery and approver authorization.
  - `enabled`: `true`, `false`, or `"auto"`. Unset or `false` disables native delivery. Set `true` or `"auto"` to activate it when approvers resolve from `approvers` or `commands.ownerAllowFrom`.
  - `approvers`: Discord user IDs allowed to approve exec requests. Falls back to `commands.ownerAllowFrom` when omitted.
  - `agentFilter`: optional agent ID allowlist. Omit to forward approvals for all agents.
  - `sessionFilter`: optional session key patterns (substring or regex).
  - `target`: where to send approval prompts. `"dm"` (default) sends to approver DMs, `"channel"` sends to the originating channel, `"both"` sends to both. When target includes `"channel"`, buttons are only usable by resolved approvers.
  - `cleanupAfterResolve`: when `true`, deletes approval DMs after approval, denial, or timeout.

**Reaction notification modes:** `off` (none), `own` (bot's messages, default), `all` (all messages), `allowlist` (from `guilds.<id>.users` on all messages).

## Matrix

Matrix is plugin-backed and configured under `channels.matrix`.

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_bot_xxx",
      proxy: "http://127.0.0.1:7890",
      encryption: true,
      initialSyncLimit: 20,
      defaultAccount: "ops",
      accounts: {
        ops: {
          name: "Ops",
          userId: "@ops:example.org",
          accessToken: "syt_ops_xxx",
        },
        alerts: {
          userId: "@alerts:example.org",
          password: "secret",
          proxy: "http://127.0.0.1:7891",
        },
      },
    },
  },
}
```

- Token auth uses `accessToken`; password auth uses `userId` + `password`.
- `channels.matrix.proxy` routes Matrix HTTP traffic through an explicit HTTP(S) proxy. Named accounts can override it with `channels.matrix.accounts.<id>.proxy`.
- `channels.matrix.network.dangerouslyAllowPrivateNetwork` allows private/internal homeservers. `proxy` and this network opt-in are independent controls.
- `channels.matrix.defaultAccount` selects the preferred account in multi-account setups.
- `channels.matrix.autoJoin` defaults to `"off"`, so invited rooms and fresh DM-style invites are ignored until you set `autoJoin: "allowlist"` with `autoJoinAllowlist` or `autoJoin: "always"`.
- `channels.matrix.joinIntro` defaults to `true`. When the bot actually joins an allowed group room, it posts one introduction using the room name, topic, and up to 100 readable recent messages. A failed history read leaves a metadata-only introduction. Set this option to `false` to disable introductions, or use `channels.matrix.accounts.<accountId>.joinIntro` for an account-specific override. Introductions happen once per room; unaccepted invites, startup room snapshots, membership updates that leave the bot joined, and direct rooms do not trigger them. See [group join introductions](/channels#group-join-introductions).
- `channels.matrix.execApprovals`: Matrix-native exec approval delivery and approver authorization.
  - `enabled`: `true`, `false`, or `"auto"` (default). In auto mode, exec approvals activate when approvers can be resolved from `approvers` or `commands.ownerAllowFrom`.
  - `approvers`: Matrix user IDs (e.g. `@owner:example.org`) allowed to approve exec requests.
  - `agentFilter`: optional agent ID allowlist. Omit to forward approvals for all agents.
  - `sessionFilter`: optional session key patterns (substring or regex).
  - `target`: where to send approval prompts. `"dm"` (default), `"channel"` (originating room), or `"both"`.
  - Per-account overrides: `channels.matrix.accounts.<id>.execApprovals`.
- `channels.matrix.dm.sessionScope` controls how Matrix DMs group into sessions: `per-user` (default) shares by routed peer, while `per-room` isolates each DM room.
- Matrix status probes and live directory lookups use the same proxy policy as runtime traffic.
- Full Matrix configuration, targeting rules, and setup examples are documented in [Matrix](/channels/matrix).

## IRC

IRC is plugin-backed and configured under `channels.irc`.

```json5
{
  channels: {
    irc: {
      enabled: true,
      dmPolicy: "pairing",
      configWrites: true,
      nickserv: {
        enabled: true,
        service: "NickServ",
        password: "${IRC_NICKSERV_PASSWORD}",
        register: false,
        registerEmail: "bot@example.com",
      },
    },
  },
}
```

- Core key paths covered here: `channels.irc`, `channels.irc.dmPolicy`, `channels.irc.configWrites`, `channels.irc.nickserv.*`.
- Optional `channels.irc.defaultAccount` overrides default account selection when it matches a configured account id.
- Full IRC channel configuration (host/port/TLS/channels/allowlists/mention gating) is documented in [IRC](/channels/irc).
