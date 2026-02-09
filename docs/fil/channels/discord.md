---
summary: "Katayuan ng suporta ng Discord bot, mga kakayahan, at konpigurasyon"
read_when:
  - Gumagawa sa mga feature ng Discord channel
title: "Discord"
---

# Discord (Bot API)

Status: handa para sa DM at mga guild text channel sa pamamagitan ng opisyal na Discord bot gateway.

## Quick setup (beginner)

1. Gumawa ng Discord bot at kopyahin ang bot token.
2. Sa mga setting ng Discord app, i-enable ang **Message Content Intent** (at **Server Members Intent** kung balak mong gumamit ng mga allowlist o name lookup).
3. Itakda ang token para sa OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - O config: `channels.discord.token: "..."`.
   - Kapag parehong naka-set, mas nauuna ang config (ang env fallback ay para lang sa default-account).
4. I-invite ang bot sa iyong server na may mga pahintulot sa mensahe (gumawa ng private server kung DM lang ang gusto mo).
5. Simulan ang gateway.
6. Ang DM access ay pairing by default; aprubahan ang pairing code sa unang contact.

Minimal na config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Mga layunin

- Makipag-usap sa OpenClaw sa pamamagitan ng Discord DMs o mga guild channel.
- Ang mga direct chat ay pinagsasama sa pangunahing session ng agent (default `agent:main:main`); ang mga guild channel ay nananatiling hiwalay bilang `agent:<agentId>:discord:channel:<channelId>` (ang mga display name ay gumagamit ng `discord:<guildSlug>#<channelSlug>`).
- Ang mga group DM ay binabalewala by default; i-enable sa pamamagitan ng `channels.discord.dm.groupEnabled` at opsyonal na higpitan gamit ang `channels.discord.dm.groupChannels`.
- Panatilihing deterministiko ang routing: ang mga reply ay laging bumabalik sa channel kung saan sila dumating.

## Paano ito gumagana

1. Gumawa ng Discord application → Bot, i-enable ang mga intent na kailangan mo (DMs + guild messages + message content), at kunin ang bot token.
2. I-invite ang bot sa iyong server na may mga pahintulot na kailangan para magbasa/magpadala ng mga mensahe kung saan mo ito gagamitin.
3. I-configure ang OpenClaw gamit ang `channels.discord.token` (o `DISCORD_BOT_TOKEN` bilang fallback).
4. Patakbuhin ang gateway; awtomatiko nitong sinisimulan ang Discord channel kapag may available na token (config muna, env fallback) at ang `channels.discord.enabled` ay hindi `false`.
   - Kung mas gusto mo ang env vars, itakda ang `DISCORD_BOT_TOKEN` (opsyonal ang config block).
5. Direct chats: use `user:<id>` (or a `<@id>` mention) when delivering; all turns land in the shared `main` session. Bare numeric IDs are ambiguous and rejected.
6. Guild channels: use `channel:<channelId>` for delivery. Mentions are required by default and can be set per guild or per channel.
7. Direct chats: secure by default via `channels.discord.dm.policy` (default: `"pairing"`). Unknown senders get a pairing code (expires after 1 hour); approve via `openclaw pairing approve discord <code>`.
   - Para panatilihin ang lumang “open to anyone” na behavior: itakda ang `channels.discord.dm.policy="open"` at `channels.discord.dm.allowFrom=["*"]`.
   - Para sa mahigpit na allowlist: itakda ang `channels.discord.dm.policy="allowlist"` at ilista ang mga sender sa `channels.discord.dm.allowFrom`.
   - Para balewalain ang lahat ng DM: itakda ang `channels.discord.dm.enabled=false` o `channels.discord.dm.policy="disabled"`.
8. Ang mga group DM ay binabalewala by default; i-enable sa pamamagitan ng `channels.discord.dm.groupEnabled` at opsyonal na higpitan gamit ang `channels.discord.dm.groupChannels`.
9. Opsyonal na guild rules: itakda ang `channels.discord.guilds` na naka-key sa guild id (mas gusto) o slug, na may per-channel na mga patakaran.
10. Optional native commands: `commands.native` defaults to `"auto"` (on for Discord/Telegram, off for Slack). Override with `channels.discord.commands.native: true|false|"auto"`; `false` clears previously registered commands. Text commands are controlled by `commands.text` and must be sent as standalone `/...` messages. Use `commands.useAccessGroups: false` to bypass access-group checks for commands.
    - Buong listahan ng command + config: [Slash commands](/tools/slash-commands)
11. Optional guild context history: set `channels.discord.historyLimit` (default 20, falls back to `messages.groupChat.historyLimit`) to include the last N guild messages as context when replying to a mention. Set `0` to disable.
12. Reactions: maaaring mag-trigger ang agent ng mga reaction sa pamamagitan ng `discord` tool (nakagated ng `channels.discord.actions.*`).
    - Semantics ng pag-alis ng reaction: tingnan ang [/tools/reactions](/tools/reactions).
    - Ang `discord` tool ay inilalantad lamang kapag ang kasalukuyang channel ay Discord.
13. Ang mga native command ay gumagamit ng hiwalay na session key (`agent:<agentId>:discord:slash:<userId>`) sa halip na ang pinagsasaluhang `main` session.

Note: Name → id resolution uses guild member search and requires Server Members Intent; if the bot can’t search members, use ids or `<@id>` mentions.
Note: Slugs are lowercase with spaces replaced by `-`. Channel names are slugged without the leading `#`.
Note: Guild context `[from:]` lines include `author.tag` + `id` to make ping-ready replies easy.

## Config writes

By default, pinapayagan ang Discord na magsulat ng mga update sa config na na-trigger ng `/config set|unset` (nangangailangan ng `commands.config: true`).

I-disable gamit ang:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Paano gumawa ng sarili mong bot

Ito ang setup ng “Discord Developer Portal” para patakbuhin ang OpenClaw sa isang server (guild) channel tulad ng `#help`.

### 1. Gumawa ng Discord app + bot user

1. Discord Developer Portal → **Applications** → **New Application**
2. Sa iyong app:
   - **Bot** → **Add Bot**
   - Kopyahin ang **Bot Token** (ito ang inilalagay mo sa `DISCORD_BOT_TOKEN`)

### 2) I-enable ang mga gateway intent na kailangan ng OpenClaw

Hinaharangan ng Discord ang mga “privileged intents” maliban kung tahasan mong i-enable ang mga ito.

Sa **Bot** → **Privileged Gateway Intents**, i-enable ang:

- **Message Content Intent** (kinakailangan para mabasa ang text ng mensahe sa karamihan ng guild; kung wala nito makikita mo ang “Used disallowed intents” o kokonekta ang bot pero hindi tutugon sa mga mensahe)
- **Server Members Intent** (inirerekomenda; kinakailangan para sa ilang member/user lookup at allowlist matching sa mga guild)

You usually do **not** need **Presence Intent**. Setting the bot's own presence (`setPresence` action) uses gateway OP3 and does not require this intent; it is only needed if you want to receive presence updates about other guild members.

### 3. Bumuo ng invite URL (OAuth2 URL Generator)

Sa iyong app: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (kinakailangan para sa native commands)

**Bot Permissions** (minimal na baseline)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (opsyonal ngunit inirerekomenda)
- ✅ Use External Emojis / Stickers (opsyonal; kung gusto mo lang ang mga ito)

Iwasan ang **Administrator** maliban kung nagde-debug ka at lubos mong pinagkakatiwalaan ang bot.

Kopyahin ang nabuong URL, buksan ito, piliin ang iyong server, at i-install ang bot.

### 4. Kunin ang mga id (guild/user/channel)

Gumagamit ang Discord ng mga numeric id sa lahat ng dako; mas gusto ng OpenClaw config ang mga id.

1. Discord (desktop/web) → **User Settings** → **Advanced** → i-enable ang **Developer Mode**
2. Right-click:
   - Pangalan ng server → **Copy Server ID** (guild id)
   - Channel (hal. `#help`) → **Copy Channel ID**
   - Ang iyong user → **Copy User ID**

### 5) I-configure ang OpenClaw

#### Token

Itakda ang bot token sa pamamagitan ng env var (inirerekomenda sa mga server):

- `DISCORD_BOT_TOKEN=...`

O sa pamamagitan ng config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Suporta sa multi-account: gamitin ang `channels.discord.accounts` na may per-account na mga token at opsyonal na `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

#### Allowlist + channel routing

Halimbawa ng “isang server lang, ako lang ang papayagan, #help lang ang papayagan”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Mga tala:

- Ang `requireMention: true` ay nangangahulugang sasagot lang ang bot kapag nabanggit (inirerekomenda para sa mga shared channel).
- Ang `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) ay binibilang din bilang mga mention para sa mga guild message.
- Multi-agent override: magtakda ng per-agent pattern sa `agents.list[].groupChat.mentionPatterns`.
- Kapag naroon ang `channels`, anumang channel na hindi nakalista ay tinatanggihan by default.
- Gumamit ng `"*"` na channel entry para mag-apply ng mga default sa lahat ng channel; ang mga explicit channel entry ay nag-o-override sa wildcard.
- Threads inherit parent channel config (allowlist, `requireMention`, skills, prompts, etc.) unless you add the thread channel id explicitly.
- Owner hint: when a per-guild or per-channel `users` allowlist matches the sender, OpenClaw treats that sender as the owner in the system prompt. For a global owner across channels, set `commands.ownerAllowFrom`.
- Ang mga mensaheng gawa ng bot ay binabalewala by default; itakda ang `channels.discord.allowBots=true` para payagan ang mga ito (ang sariling mensahe ay mananatiling filtered).
- Warning: If you allow replies to other bots (`channels.discord.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.

### 6. I-verify na gumagana ito

1. Simulan ang gateway.
2. Sa iyong server channel, ipadala: `@Krill hello` (o kung ano man ang pangalan ng iyong bot).
3. Kung walang nangyari: tingnan ang **Troubleshooting** sa ibaba.

### Troubleshooting

- Una: patakbuhin ang `openclaw doctor` at `openclaw channels status --probe` (actionable warnings + quick audits).
- **“Used disallowed intents”**: i-enable ang **Message Content Intent** (at malamang **Server Members Intent**) sa Developer Portal, pagkatapos ay i-restart ang gateway.
- **Kumokonekta ang bot pero hindi kailanman sumasagot sa isang guild channel**:
  - Nawawala ang **Message Content Intent**, o
  - Kulang ang pahintulot ng bot sa channel (View/Send/Read History), o
  - Nangangailangan ng mention ang iyong config at hindi mo ito binanggit, o
  - Tinatanggihan ng iyong guild/channel allowlist ang channel/user.
- **`requireMention: false` pero wala pa ring mga reply**:
- `channels.discord.groupPolicy` defaults to **allowlist**; set it to `"open"` or add a guild entry under `channels.discord.guilds` (optionally list channels under `channels.discord.guilds.<id>.channels` to restrict).
  - If you only set `DISCORD_BOT_TOKEN` and never create a `channels.discord` section, the runtime
    defaults `groupPolicy` to `open`. Add `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, or a guild/channel allowlist to lock it down.
- `requireMention` must live under `channels.discord.guilds` (or a specific channel). `channels.discord.requireMention` at the top level is ignored.
- **Permission audits** (`channels status --probe`) only check numeric channel IDs. If you use slugs/names as `channels.discord.guilds.*.channels` keys, the audit can’t verify permissions.
- **Hindi gumagana ang mga DM**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, o hindi ka pa naaprubahan (`channels.discord.dm.policy="pairing"`).
- **Exec approvals in Discord**: Discord supports a **button UI** for exec approvals in DMs (Allow once / Always allow / Deny). `/approve <id> ...` is only for forwarded approvals and won’t resolve Discord’s button prompts. 1. Kung makita mo ang `❌ Failed to submit approval: Error: unknown approval id` o hindi kailanman lumitaw ang UI, suriin ang:
  - Ang `channels.discord.execApprovals.enabled: true` sa iyong config.
  - Ang iyong Discord user ID ay nakalista sa `channels.discord.execApprovals.approvers` (ang UI ay ipinapadala lang sa mga approver).
  - Gamitin ang mga button sa DM prompt (**Allow once**, **Always allow**, **Deny**).
  - Tingnan ang [Exec approvals](/tools/exec-approvals) at [Slash commands](/tools/slash-commands) para sa mas malawak na daloy ng approvals at command.

## Mga kakayahan at limitasyon

- DMs at mga guild text channel (ang mga thread ay itinuturing na hiwalay na mga channel; hindi suportado ang voice).
- Ang mga typing indicator ay ipinapadala sa best-effort; ang message chunking ay gumagamit ng `channels.discord.textChunkLimit` (default 2000) at hinahati ang mahahabang reply ayon sa bilang ng linya (`channels.discord.maxLinesPerMessage`, default 17).
- Opsyonal na newline chunking: itakda ang `channels.discord.chunkMode="newline"` para hatiin sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- Sinusuportahan ang file upload hanggang sa naka-configure na `channels.discord.mediaMaxMb` (default 8 MB).
- Mention-gated ang mga guild reply by default para maiwasan ang maingay na mga bot.
- Ang reply context ay ini-inject kapag ang isang mensahe ay tumutukoy sa isa pang mensahe (quoted content + ids).
- Ang native reply threading ay **off by default**; i-enable gamit ang `channels.discord.replyToMode` at mga reply tag.

## Retry policy

2. Ang mga outbound Discord API call ay muling sinusubukan kapag may rate limit (429) gamit ang Discord `retry_after` kapag available, na may exponential backoff at jitter. 3. I-configure sa pamamagitan ng `channels.discord.retry`. 4. Tingnan ang [Retry policy](/concepts/retry).

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
            general: { allow: true },
          },
        },
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
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

5. Ang mga ack reaction ay kinokontrol sa buong sistema sa pamamagitan ng `messages.ackReaction` +
   `messages.ackReactionScope`. 6. Gamitin ang `messages.removeAckAfterReply` upang alisin ang ack reaction matapos sumagot ang bot.

- `dm.enabled`: itakda ang `false` para balewalain ang lahat ng DM (default `true`).
- 7. `dm.policy`: kontrol sa access ng DM (`pairing` ang inirerekomenda). 8. Ang `"open"` ay nangangailangan ng `dm.allowFrom=["*"]`.
- 9. `dm.allowFrom`: DM allowlist (mga user id o pangalan). 10. Ginagamit ng `dm.policy="allowlist"` at para sa pag-validate ng `dm.policy="open"`. 11. Tumatanggap ang wizard ng mga username at nireresolba ang mga ito sa mga id kapag kayang maghanap ng bot ng mga miyembro.
- `dm.groupEnabled`: i-enable ang mga group DM (default `false`).
- `dm.groupChannels`: opsyonal na allowlist para sa mga group DM channel id o slug.
- `groupPolicy`: kumokontrol sa paghawak ng mga guild channel (`open|disabled|allowlist`); ang `allowlist` ay nangangailangan ng mga channel allowlist.
- `guilds`: per-guild na mga patakaran na naka-key sa guild id (mas gusto) o slug.
- `guilds."*"`: default na per-guild na mga setting na inilalapat kapag walang tahasang entry.
- 12. `guilds.<id>13. .slug`: opsyonal na friendly slug na ginagamit para sa mga display name.
- 14. `guilds.<id>15. .users`: opsyonal na per-guild user allowlist (mga id o pangalan).
- 16. `guilds.<id>17. .tools`: opsyonal na per-guild tool policy overrides (`allow`/`deny`/`alsoAllow`) na ginagamit kapag nawawala ang channel override.
- 18. `guilds.<id>19. .toolsBySender`: opsyonal na per-sender tool policy overrides sa antas ng guild (naaangkop kapag nawawala ang channel override; sinusuportahan ang wildcard na `"*"`).
- 20. `guilds.<id>21. .channels.<channel>.allow`: payagan/itanggi ang channel kapag `groupPolicy="allowlist"`.
- 22. `guilds.<id>23. .channels.<channel>.requireMention`: mention gating para sa channel.
- 24. `guilds.<id>25. .channels.<channel>.tools`: opsyonal na per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- 26. `guilds.<id>27. .channels.<channel>28. .toolsBySender`: opsyonal na per-sender tool policy overrides sa loob ng channel (sinusuportahan ang wildcard na `"*"`).
- 29. `guilds.<id>30. .channels.<channel>.users`: opsyonal na per-channel user allowlist.
- 31. `guilds.<id>.channels.<channel>.skills`: skill filter (omit = lahat ng skills, empty = wala).
- 33. `guilds.<id>34. .channels.<channel>35. .systemPrompt`: karagdagang system prompt para sa channel. 36. Ang mga Discord channel topic ay ini-inject bilang **hindi pinagkakatiwalaan** na context (hindi system prompt).
- 37. `guilds.<id>38. .channels.<channel>.enabled`: itakda ang `false` para i-disable ang channel.
- 39. `guilds.<id>40. .channels`: mga patakaran ng channel (ang mga key ay mga channel slug o id).
- 41. `guilds.<id>.requireMention`: per-guild mention requirement (overridable per channel).
- 43. `guilds.<id>44. .reactionNotifications`: mode ng reaction system event (`off`, `own`, `all`, `allowlist`).
- 45. `textChunkLimit`: laki ng outbound text chunk (mga character). 46. Default: 2000.
- `chunkMode`: ang `length` (default) ay naghahati lang kapag lumampas sa `textChunkLimit`; ang `newline` ay naghahati sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- 47. `maxLinesPerMessage`: soft max na bilang ng linya kada mensahe. Default: 17.
- `mediaMaxMb`: i-clamp ang inbound media na sine-save sa disk.
- `historyLimit`: bilang ng mga kamakailang guild message na isasama bilang context kapag nagre-reply sa isang mention (default 20; bumabagsak sa `messages.groupChat.historyLimit`; ang `0` ay nagdi-disable).
- 49. `dmHistoryLimit`: limit ng DM history sa bilang ng user turn. 50. Per-user overrides: `dms["<user_id>"].historyLimit`.
- `retry`: retry policy para sa mga outbound na Discord API call (attempts, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: resolbahin ang mga PluralKit proxied message para lumitaw ang mga system member bilang magkakaibang sender.
- `actions`: per-action tool gate; i-omit para payagan ang lahat (itakda ang `false` para i-disable).
  - `reactions` (saklaw ang react + read reactions)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (gumawa/mag-edit/magbura ng mga channel + category + pahintulot)
  - `roles` (role add/remove, default `false`)
  - `moderation` (timeout/kick/ban, default `false`)
  - `presence` (bot status/activity, default `false`)
- `execApprovals`: Discord-only exec approval DMs (button UI). Supports `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reaction notifications use `guilds.<id>.reactionNotifications`:

- `off`: walang reaction event.
- `own`: mga reaction sa sariling mensahe ng bot (default).
- `all`: lahat ng reaction sa lahat ng mensahe.
- `allowlist`: reactions from `guilds.<id>.users` on all messages (empty list disables).

### Suporta sa PluralKit (PK)

Enable PK lookups so proxied messages resolve to the underlying system + member.
When enabled, OpenClaw uses the member identity for allowlists and labels the
sender as `Member (PK:System)` to avoid accidental Discord pings.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Mga tala sa allowlist (PK-enabled):

- Use `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users`, or per-channel `users`.
- Ang mga display name ng member ay tinatapatan din ayon sa pangalan/slug.
- Ang mga lookup ay gumagamit ng **orihinal** na Discord message ID (ang pre-proxy message), kaya nireresolba lang ito ng PK API sa loob ng 30-minutong window nito.
- Kapag pumalya ang mga PK lookup (hal., private system na walang token), ang mga proxied message ay itinuturing na mga mensahe ng bot at ibinabagsak maliban kung `channels.discord.allowBots=true`.

### Mga default ng tool action

| Action group   | Default  | Mga tala                                             |
| -------------- | -------- | ---------------------------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList                   |
| stickers       | enabled  | Magpadala ng stickers                                |
| emojiUploads   | enabled  | Mag-upload ng emojis                                 |
| stickerUploads | enabled  | Mag-upload ng stickers                               |
| polls          | enabled  | Gumawa ng mga poll                                   |
| permissions    | enabled  | Snapshot ng pahintulot sa channel                    |
| messages       | enabled  | Basa/padala/edit/bura                                |
| threads        | enabled  | Gumawa/maglista/magreply                             |
| pins           | enabled  | Pin/unpin/list                                       |
| search         | enabled  | Paghahanap ng mensahe (preview)   |
| memberInfo     | enabled  | Impormasyon ng member                                |
| roleInfo       | enabled  | Listahan ng role                                     |
| channelInfo    | enabled  | Impormasyon + listahan ng channel                    |
| channels       | enabled  | Pamamahala ng channel/category                       |
| voiceStatus    | enabled  | Lookup ng voice state                                |
| events         | enabled  | Maglista/gumawa ng scheduled event                   |
| roles          | disabled | Role add/remove                                      |
| moderation     | disabled | Timeout/kick/ban                                     |
| presence       | disabled | Bot status/activity (setPresence) |

- `replyToMode`: `off` (default), `first`, or `all`. Applies only when the model includes a reply tag.

## Reply tags

Para humiling ng threaded reply, maaaring magsama ang model ng isang tag sa output nito:

- `[[reply_to_current]]` — mag-reply sa nag-trigger na Discord message.
- `[[reply_to:<id>]]` — reply to a specific message id from context/history.
  Current message ids are appended to prompts as `[message_id: …]`; history entries already include ids.

Ang behavior ay kinokontrol ng `channels.discord.replyToMode`:

- `off`: balewalain ang mga tag.
- `first`: ang unang outbound chunk/attachment lang ang reply.
- `all`: bawat outbound chunk/attachment ay reply.

Mga tala sa allowlist matching:

- Ang `allowFrom`/`users`/`groupChannels` ay tumatanggap ng mga id, pangalan, tag, o mga mention tulad ng `<@id>`.
- Sinusuportahan ang mga prefix tulad ng `discord:`/`user:` (users) at `channel:` (group DM).
- Gamitin ang `*` para payagan ang anumang sender/channel.
- When `guilds.<id>.channels` is present, channels not listed are denied by default.
- When `guilds.<id>.channels` is omitted, all channels in the allowlisted guild are allowed.
- Para payagan ang **walang channel**, itakda ang `channels.discord.groupPolicy: "disabled"` (o panatilihin ang walang laman na allowlist).
- Tumatanggap ang configure wizard ng mga pangalang `Guild/Channel` (public + private) at nireresolba ang mga ito sa mga ID kapag posible.
- Sa startup, nireresolba ng OpenClaw ang mga pangalan ng channel/user sa mga allowlist tungo sa mga ID (kapag makakapag-search ng mga member ang bot)
  at nilolog ang mapping; ang mga hindi maresolba ay pinananatili gaya ng itinype.

Mga tala sa native command:

- Ang mga nairehistrong command ay sumasalamin sa mga chat command ng OpenClaw.
- Iginagalang ng mga native command ang parehong mga allowlist gaya ng DMs/guild messages (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, mga patakaran per channel).
- Maaaring makita pa rin ang mga slash command sa Discord UI ng mga user na hindi allowlisted; ipinapatupad ng OpenClaw ang mga allowlist sa execution at sumasagot ng “not authorized”.

## Mga tool action

Maaaring tawagin ng agent ang `discord` na may mga aksyon tulad ng:

- `react` / `reactions` (magdagdag o maglista ng mga reaction)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Ang mga payload ng read/search/pin tool ay may kasamang normalized na `timestampMs` (UTC epoch ms) at `timestampUtc` kasama ng raw Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (aktibidad ng bot at online status)

Discord message ids are surfaced in the injected context (`[discord message id: …]` and history lines) so the agent can target them.
Emoji can be unicode (e.g., `✅`) or custom emoji syntax like `<:party_blob:1234567890>`.

## Kaligtasan at ops

- Ituring ang bot token na parang password; mas piliin ang `DISCORD_BOT_TOKEN` env var sa mga supervised host o higpitan ang mga pahintulot ng config file.
- Ibigay lamang sa bot ang mga pahintulot na kailangan nito (karaniwan Read/Send Messages).
- Kung ang bot ay na-stuck o na-rate limit, i-restart ang gateway (`openclaw gateway --force`) matapos tiyaking walang ibang prosesong may-ari ng Discord session.
