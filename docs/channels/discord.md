---
summary: "Discord bot support status, capabilities, and configuration"
read_when:
  - Working on Discord channel features
---
# Discord (Bot API)


Status: ready for DM and guild text channels via the official Discord bot gateway.

## Quick setup (beginner)
1) Create a Discord bot and copy the bot token.
2) In the Discord app settings, enable **Message Content Intent** (and **Server Members Intent** if you plan to use allowlists or name lookups).
3) Set the token for Moltbot:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Or config: `channels.discord.token: "..."`.
   - If both are set, config takes precedence (env fallback is default-account only).
4) Invite the bot to your server with message permissions (create a private server if you just want DMs).
5) Start the gateway.
6) DM access is pairing by default; approve the pairing code on first contact.

Minimal config:
```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN"
    }
  }
}
```

## Goals
- Talk to Moltbot via Discord DMs or guild channels.
- Direct chats collapse into the agent's main session (default `agent:main:main`); guild channels stay isolated as `agent:<agentId>:discord:channel:<channelId>` (display names use `discord:<guildSlug>#<channelSlug>`).
- Group DMs are ignored by default; enable via `channels.discord.dm.groupEnabled` and optionally restrict by `channels.discord.dm.groupChannels`.
- Keep routing deterministic: replies always go back to the channel they arrived on.

## How it works
1. Create a Discord application → Bot, enable the intents you need (DMs + guild messages + message content), and grab the bot token.
2. Invite the bot to your server with the permissions required to read/send messages where you want to use it.
3. Configure Moltbot with `channels.discord.token` (or `DISCORD_BOT_TOKEN` as a fallback).
4. Run the gateway; it auto-starts the Discord channel when a token is available (config first, env fallback) and `channels.discord.enabled` is not `false`.
   - If you prefer env vars, set `DISCORD_BOT_TOKEN` (a config block is optional).
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session. Bare numeric IDs are ambiguous and rejected.
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default and can be set per guild or per channel.
7. Direct chats: secure by default via `channels.discord.dm.policy` (default: `"pairing"`). Unknown senders get a pairing code (expires after 1 hour); approve via `moltbot pairing approve discord <code>`.
   - To keep old “open to anyone” behavior: set `channels.discord.dm.policy="open"` and `channels.discord.dm.allowFrom=["*"]`.
   - To hard-allowlist: set `channels.discord.dm.policy="allowlist"` and list senders in `channels.discord.dm.allowFrom`.
   - To ignore all DMs: set `channels.discord.dm.enabled=false` or `channels.discord.dm.policy="disabled"`.
8. Group DMs are ignored by default; enable via `channels.discord.dm.groupEnabled` and optionally restrict by `channels.discord.dm.groupChannels`.
9. Optional guild rules: set `channels.discord.guilds` keyed by guild id (preferred) or slug, with per-channel rules.
10. Optional native commands: `commands.native` defaults to `"auto"` (on for Discord/Telegram, off for Slack). Override with `channels.discord.commands.native: true|false|"auto"`; `false` clears previously registered commands. Text commands are controlled by `commands.text` and must be sent as standalone `/...` messages. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
    - Full command list + config: [Slash commands](/tools/slash-commands)
11. Optional guild context history: set `channels.discord.historyLimit` (default 20, falls back to `messages.groupChat.historyLimit`) to include the last N guild messages as context when replying to a mention. Set `0` to disable.
12. Reactions: the agent can trigger reactions via the `discord` tool (gated by `channels.discord.actions.*`).
    - Reaction removal semantics: see [/tools/reactions](/tools/reactions).
    - The `discord` tool is only exposed when the current channel is Discord.
    - User reactions on the bot's messages can **trigger** the session (yes/no style) when `guilds.<id>.reactionTrigger` is enabled; see [Reaction trigger](#reaction-trigger).
13. Native commands use isolated session keys (`agent:<agentId>:discord:slash:<userId>`) rather than the shared `main` session.

Note: Name → id resolution uses guild member search and requires Server Members Intent; if the bot can’t search members, use ids or `<@id>` mentions.
Note: Slugs are lowercase with spaces replaced by `-`. Channel names are slugged without the leading `#`.
Note: Guild context `[from:]` lines include `author.tag` + `id` to make ping-ready replies easy.

## Config writes
By default, Discord is allowed to write config updates triggered by `/config set|unset` (requires `commands.config: true`).

Disable with:
```json5
{
  channels: { discord: { configWrites: false } }
}
```

## How to create your own bot

This is the “Discord Developer Portal” setup for running Moltbot in a server (guild) channel like `#help`.

### 1) Create the Discord app + bot user
1. Discord Developer Portal → **Applications** → **New Application**
2. In your app:
   - **Bot** → **Add Bot**
   - Copy the **Bot Token** (this is what you put in `DISCORD_BOT_TOKEN`)

### 2) Enable the gateway intents Moltbot needs
Discord blocks “privileged intents” unless you explicitly enable them.

In **Bot** → **Privileged Gateway Intents**, enable:
- **Message Content Intent** (required to read message text in most guilds; without it you’ll see “Used disallowed intents” or the bot will connect but not react to messages)
- **Server Members Intent** (recommended; required for some member/user lookups and allowlist matching in guilds)

You usually do **not** need **Presence Intent**.

### 3) Generate an invite URL (OAuth2 URL Generator)
In your app: **OAuth2** → **URL Generator**

**Scopes**
- ✅ `bot`
- ✅ `applications.commands` (required for native commands)

**Bot Permissions** (minimal baseline)
- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (optional but recommended)
- ✅ Use External Emojis / Stickers (optional; only if you want them)

Avoid **Administrator** unless you’re debugging and fully trust the bot.

Copy the generated URL, open it, pick your server, and install the bot.

### 4) Get the ids (guild/user/channel)
Discord uses numeric ids everywhere; Moltbot config prefers ids.

1. Discord (desktop/web) → **User Settings** → **Advanced** → enable **Developer Mode**
2. Right-click:
   - Server name → **Copy Server ID** (guild id)
   - Channel (e.g. `#help`) → **Copy Channel ID**
   - Your user → **Copy User ID**

### 5) Configure Moltbot

#### Token
Set the bot token via env var (recommended on servers):
- `DISCORD_BOT_TOKEN=...`

Or via config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN"
    }
  }
}
```

Multi-account support: use `channels.discord.accounts` with per-account tokens and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

#### Allowlist + channel routing
Example “single server, only allow me, only allow #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        "YOUR_GUILD_ID": {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true }
          }
        }
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1
      }
    }
  }
}
```

Notes:
- `requireMention: true` means the bot only replies when mentioned (recommended for shared channels).
- `agents.list[].groupChat.mentionPatterns` (or `messages.groupChat.mentionPatterns`) also count as mentions for guild messages.
- Multi-agent override: set per-agent patterns on `agents.list[].groupChat.mentionPatterns`.
- If `channels` is present, any channel not listed is denied by default.
- Use a `"*"` channel entry to apply defaults across all channels; explicit channel entries override the wildcard.
- Threads inherit parent channel config (allowlist, `requireMention`, skills, prompts, etc.) unless you add the thread channel id explicitly.
- Bot-authored messages are ignored by default; set `channels.discord.allowBots=true` to allow them (own messages remain filtered).
- Warning: If you allow replies to other bots (`channels.discord.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.

### 6) Verify it works
1. Start the gateway.
2. In your server channel, send: `@Krill hello` (or whatever your bot name is).
3. If nothing happens: check **Troubleshooting** below.

### Troubleshooting
- First: run `moltbot doctor` and `moltbot channels status --probe` (actionable warnings + quick audits).
- **“Used disallowed intents”**: enable **Message Content Intent** (and likely **Server Members Intent**) in the Developer Portal, then restart the gateway.
- **Bot connects but never replies in a guild channel**:
  - Missing **Message Content Intent**, or
  - The bot lacks channel permissions (View/Send/Read History), or
  - Your config requires mentions and you didn’t mention it, or
  - Your guild/channel allowlist denies the channel/user.
- **`requireMention: false` but still no replies**:
- `channels.discord.groupPolicy` defaults to **allowlist**; set it to `"open"` or add a guild entry under `channels.discord.guilds` (optionally list channels under `channels.discord.guilds.<id>.channels` to restrict).
  - If you only set `DISCORD_BOT_TOKEN` and never create a `channels.discord` section, the runtime
    defaults `groupPolicy` to `open`. Add `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, or a guild/channel allowlist to lock it down.
- `requireMention` must live under `channels.discord.guilds` (or a specific channel). `channels.discord.requireMention` at the top level is ignored.
- **Permission audits** (`channels status --probe`) only check numeric channel IDs. If you use slugs/names as `channels.discord.guilds.*.channels` keys, the audit can’t verify permissions.
- **DMs don’t work**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, or you haven’t been approved yet (`channels.discord.dm.policy="pairing"`).

## Capabilities & limits
- DMs and guild text channels (threads are treated as separate channels; voice not supported).
- Typing indicators sent best-effort; message chunking uses `channels.discord.textChunkLimit` (default 2000) and splits tall replies by line count (`channels.discord.maxLinesPerMessage`, default 17).
- Optional newline chunking: set `channels.discord.chunkMode="newline"` to split on blank lines (paragraph boundaries) before length chunking.
- File uploads supported up to the configured `channels.discord.mediaMaxMb` (default 8 MB).
- Mention-gated guild replies by default to avoid noisy bots.
- Reply context is injected when a message references another message (quoted content + ids).
- Native reply threading is **off by default**; enable with `channels.discord.replyToMode` and reply tags.

## Retry policy
Outbound Discord API calls retry on rate limits (429) using Discord `retry_after` when available, with exponential backoff and jitter. Configure via `channels.discord.retry`. See [Retry policy](/concepts/retry).

## Config

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true }
          }
        }
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
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
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["clawd-dm"]
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-clawd",
          requireMention: false,
          reactionNotifications: "own",
          reactionTrigger: {
            enabled: true,
            windowSeconds: 60,
            positiveEmojis: ["👍", "✅", "👌"],
            negativeEmojis: ["👎", "❌"]
          },
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short."
            }
          }
        }
      }
    }
  }
}
```

Ack reactions are controlled globally via `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` to clear the
ack reaction after the bot replies.

- `dm.enabled`: set `false` to ignore all DMs (default `true`).
- `dm.policy`: DM access control (`pairing` recommended). `"open"` requires `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM allowlist (user ids or names). Used by `dm.policy="allowlist"` and for `dm.policy="open"` validation. The wizard accepts usernames and resolves them to ids when the bot can search members.
- `dm.groupEnabled`: enable group DMs (default `false`).
- `dm.groupChannels`: optional allowlist for group DM channel ids or slugs.
- `groupPolicy`: controls guild channel handling (`open|disabled|allowlist`); `allowlist` requires channel allowlists.
- `guilds`: per-guild rules keyed by guild id (preferred) or slug.
- `guilds."*"`: default per-guild settings applied when no explicit entry exists.
- `guilds.<id>.slug`: optional friendly slug used for display names.
- `guilds.<id>.users`: optional per-guild user allowlist (ids or names).
- `guilds.<id>.tools`: optional per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`) used when the channel override is missing.
- `guilds.<id>.toolsBySender`: optional per-sender tool policy overrides at the guild level (applies when the channel override is missing; `"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.allow`: allow/deny the channel when `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: mention gating for the channel.
- `guilds.<id>.channels.<channel>.tools`: optional per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optional per-sender tool policy overrides within the channel (`"*"` wildcard supported).
- `guilds.<id>.channels.<channel>.users`: optional per-channel user allowlist.
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = all skills, empty = none).
- `guilds.<id>.channels.<channel>.systemPrompt`: extra system prompt for the channel (combined with channel topic).
- `guilds.<id>.channels.<channel>.enabled`: set `false` to disable the channel.
- `guilds.<id>.channels`: channel rules (keys are channel slugs or ids).
- `guilds.<id>.requireMention`: per-guild mention requirement (overridable per channel).
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).
- `guilds.<id>.reactionTrigger`: optional config to turn user reactions on the bot's messages into session triggers. When enabled, positive/negative emoji reactions on the bot's recent messages (within a time window) dispatch an inbound message to the session instead of only emitting a system event. See [Reaction trigger](#reaction-trigger) below.
- `textChunkLimit`: outbound text chunk size (chars). Default: 2000.
- `chunkMode`: `length` (default) splits only when exceeding `textChunkLimit`; `newline` splits on blank lines (paragraph boundaries) before length chunking.
- `maxLinesPerMessage`: soft max line count per message. Default: 17.
- `mediaMaxMb`: clamp inbound media saved to disk.
- `historyLimit`: number of recent guild messages to include as context when replying to a mention (default 20; falls back to `messages.groupChat.historyLimit`; `0` disables).
- `dmHistoryLimit`: DM history limit in user turns. Per-user overrides: `dms["<user_id>"].historyLimit`.
- `retry`: retry policy for outbound Discord API calls (attempts, minDelayMs, maxDelayMs, jitter).
- `actions`: per-action tool gates; omit to allow all (set `false` to disable).
  - `reactions` (covers react + read reactions)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (create/edit/delete channels + categories + permissions)
  - `roles` (role add/remove, default `false`)
  - `moderation` (timeout/kick/ban, default `false`)

Reaction notifications use `guilds.<id>.reactionNotifications`:
- `off`: no reaction events.
- `own`: reactions on the bot's own messages (default).
- `all`: all reactions on all messages.
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).

#### Reaction trigger

When `guilds.<id>.reactionTrigger.enabled` is `true`, reactions on the **bot's own messages** within a short time window are treated as session triggers: the agent receives an inbound message describing the reaction (e.g. positive/negative and who reacted), and can reply in the same channel. Useful for yes/no or confirm/cancel flows without typing a new message.

- **Scope**: only reactions on messages sent by the bot; only within `reactionTrigger.windowSeconds` (default 60) after the bot message.
- **Classification**: emoji are classified as positive (e.g. 👍 ✅ 👌) or negative (e.g. 👎 ❌). Custom lists: `reactionTrigger.positiveEmojis` and `reactionTrigger.negativeEmojis`. Neutral emoji do not trigger.
- **Behavior**: when a positive or negative reaction matches, a system event is enqueued and an inbound message is dispatched to the session; the agent can reply. Regular reaction notifications are not emitted for that reaction.

Example:

```json5
"YOUR_GUILD_ID": {
  "requireMention": false,
  "reactionNotifications": "own",
  "reactionTrigger": {
    "enabled": true,
    "windowSeconds": 60,
    "positiveEmojis": ["👍", "✅", "👌"],
    "negativeEmojis": ["👎", "❌"]
  },
  "channels": { "general": { "allow": true } }
}
```

Omit `positiveEmojis`/`negativeEmojis` to use built-in default lists.

### Tool action defaults

| Action group | Default | Notes |
| --- | --- | --- |
| reactions | enabled | React + list reactions + emojiList |
| stickers | enabled | Send stickers |
| emojiUploads | enabled | Upload emojis |
| stickerUploads | enabled | Upload stickers |
| polls | enabled | Create polls |
| permissions | enabled | Channel permission snapshot |
| messages | enabled | Read/send/edit/delete |
| threads | enabled | Create/list/reply |
| pins | enabled | Pin/unpin/list |
| search | enabled | Message search (preview feature) |
| memberInfo | enabled | Member info |
| roleInfo | enabled | Role list |
| channelInfo | enabled | Channel info + list |
| channels | enabled | Channel/category management |
| voiceStatus | enabled | Voice state lookup |
| events | enabled | List/create scheduled events |
| roles | disabled | Role add/remove |
| moderation | disabled | Timeout/kick/ban |
- `replyToMode`: `off` (default), `first`, or `all`. Applies only when the model includes a reply tag.

## Reply tags
To request a threaded reply, the model can include one tag in its output:
- `[[reply_to_current]]` — reply to the triggering Discord message.
- `[[reply_to:<id>]]` — reply to a specific message id from context/history.
Current message ids are appended to prompts as `[message_id: …]`; history entries already include ids.

Behavior is controlled by `channels.discord.replyToMode`:
- `off`: ignore tags.
- `first`: only the first outbound chunk/attachment is a reply.
- `all`: every outbound chunk/attachment is a reply.

Allowlist matching notes:
- `allowFrom`/`users`/`groupChannels` accept ids, names, tags, or mentions like `<@id>`.
- Prefixes like `discord:`/`user:` (users) and `channel:` (group DMs) are supported.
- Use `*` to allow any sender/channel.
- When `guilds.<id>.channels` is present, channels not listed are denied by default.
- When `guilds.<id>.channels` is omitted, all channels in the allowlisted guild are allowed.
- To allow **no channels**, set `channels.discord.groupPolicy: "disabled"` (or keep an empty allowlist).
- The configure wizard accepts `Guild/Channel` names (public + private) and resolves them to IDs when possible.
- On startup, Moltbot resolves channel/user names in allowlists to IDs (when the bot can search members)
  and logs the mapping; unresolved entries are kept as typed.

Native command notes:
- The registered commands mirror Moltbot’s chat commands.
- Native commands honor the same allowlists as DMs/guild messages (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, per-channel rules).
- Slash commands may still be visible in Discord UI to users who aren’t allowlisted; Moltbot enforces allowlists on execution and replies “not authorized”.

## Tool actions
The agent can call `discord` with actions like:
- `react` / `reactions` (add or list reactions)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Read/search/pin tool payloads include normalized `timestampMs` (UTC epoch ms) and `timestampUtc` alongside raw Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`

Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.
Emoji can be unicode (e.g., `✅`) or custom emoji syntax like `<:party_blob:1234567890>`.

## Safety & ops
- Treat the bot token like a password; prefer the `DISCORD_BOT_TOKEN` env var on supervised hosts or lock down the config file permissions.
- Only grant the bot permissions it needs (typically Read/Send Messages).
- If the bot is stuck or rate limited, restart the gateway (`moltbot gateway --force`) after confirming no other processes own the Discord session.
