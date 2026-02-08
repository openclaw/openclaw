---
summary: "Katayuan ng suporta ng Discord bot, mga kakayahan, at konpigurasyon"
read_when:
  - Gumagawa sa mga feature ng Discord channel
title: "Discord"
x-i18n:
  source_path: channels/discord.md
  source_hash: 9bebfe8027ff1972
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:20Z
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
5. Direct chats: gamitin ang `user:<id>` (o isang `<@id>` mention) kapag nagde-deliver; lahat ng turn ay napupunta sa pinagsasaluhang `main` session. Ang mga hubad na numeric ID ay ambiguous at tinatanggihan.
6. Guild channels: gamitin ang `channel:<channelId>` para sa delivery. Ang mga mention ay required by default at maaaring itakda per guild o per channel.
7. Direct chats: secure by default sa pamamagitan ng `channels.discord.dm.policy` (default: `"pairing"`). Ang mga hindi kilalang sender ay nakakakuha ng pairing code (mag-e-expire pagkalipas ng 1 oras); aprubahan sa pamamagitan ng `openclaw pairing approve discord <code>`.
   - Para panatilihin ang lumang “open to anyone” na behavior: itakda ang `channels.discord.dm.policy="open"` at `channels.discord.dm.allowFrom=["*"]`.
   - Para sa mahigpit na allowlist: itakda ang `channels.discord.dm.policy="allowlist"` at ilista ang mga sender sa `channels.discord.dm.allowFrom`.
   - Para balewalain ang lahat ng DM: itakda ang `channels.discord.dm.enabled=false` o `channels.discord.dm.policy="disabled"`.
8. Ang mga group DM ay binabalewala by default; i-enable sa pamamagitan ng `channels.discord.dm.groupEnabled` at opsyonal na higpitan gamit ang `channels.discord.dm.groupChannels`.
9. Opsyonal na guild rules: itakda ang `channels.discord.guilds` na naka-key sa guild id (mas gusto) o slug, na may per-channel na mga patakaran.
10. Opsyonal na native commands: ang `commands.native` ay default sa `"auto"` (on para sa Discord/Telegram, off para sa Slack). I-override gamit ang `channels.discord.commands.native: true|false|"auto"`; ang `false` ay naglilinis ng mga dating nairehistrong command. Ang mga text command ay kontrolado ng `commands.text` at dapat ipadala bilang standalone na `/...` na mga mensahe. Gamitin ang `commands.useAccessGroups: false` para i-bypass ang mga access-group check para sa mga command.
    - Buong listahan ng command + config: [Slash commands](/tools/slash-commands)
11. Opsyonal na guild context history: itakda ang `channels.discord.historyLimit` (default 20, bumabagsak sa `messages.groupChat.historyLimit`) para isama ang huling N guild messages bilang context kapag nagre-reply sa isang mention. Itakda ang `0` para i-disable.
12. Reactions: maaaring mag-trigger ang agent ng mga reaction sa pamamagitan ng `discord` tool (nakagated ng `channels.discord.actions.*`).
    - Semantics ng pag-alis ng reaction: tingnan ang [/tools/reactions](/tools/reactions).
    - Ang `discord` tool ay inilalantad lamang kapag ang kasalukuyang channel ay Discord.
13. Ang mga native command ay gumagamit ng hiwalay na session key (`agent:<agentId>:discord:slash:<userId>`) sa halip na ang pinagsasaluhang `main` session.

Note: Ang name → id resolution ay gumagamit ng guild member search at nangangailangan ng Server Members Intent; kung hindi makapag-search ang bot ng mga member, gumamit ng mga id o `<@id>` mentions.
Note: Ang mga slug ay lowercase na may mga espasyo na pinalitan ng `-`. Ang mga pangalan ng channel ay sinuslug nang walang nangungunang `#`.
Note: Ang mga linya ng guild context na `[from:]` ay may kasamang `author.tag` + `id` para maging madali ang paggawa ng ping-ready na mga reply.

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

### 1) Gumawa ng Discord app + bot user

1. Discord Developer Portal → **Applications** → **New Application**
2. Sa iyong app:
   - **Bot** → **Add Bot**
   - Kopyahin ang **Bot Token** (ito ang inilalagay mo sa `DISCORD_BOT_TOKEN`)

### 2) I-enable ang mga gateway intent na kailangan ng OpenClaw

Hinaharangan ng Discord ang mga “privileged intents” maliban kung tahasan mong i-enable ang mga ito.

Sa **Bot** → **Privileged Gateway Intents**, i-enable ang:

- **Message Content Intent** (kinakailangan para mabasa ang text ng mensahe sa karamihan ng guild; kung wala nito makikita mo ang “Used disallowed intents” o kokonekta ang bot pero hindi tutugon sa mga mensahe)
- **Server Members Intent** (inirerekomenda; kinakailangan para sa ilang member/user lookup at allowlist matching sa mga guild)

Karaniwan ay **hindi** mo kailangan ang **Presence Intent**. Ang pagtatakda ng sariling presence ng bot (aksiyong `setPresence`) ay gumagamit ng gateway OP3 at hindi nangangailangan ng intent na ito; kailangan lang ito kung gusto mong makatanggap ng presence updates tungkol sa ibang guild member.

### 3) Bumuo ng invite URL (OAuth2 URL Generator)

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

### 4) Kunin ang mga id (guild/user/channel)

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

Suporta sa multi-account: gamitin ang `channels.discord.accounts` na may per-account na mga token at opsyonal na `name`. Tingnan ang [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para sa shared pattern.

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
- Ang mga thread ay nagmamana ng config ng parent channel (allowlist, `requireMention`, skills, prompts, atbp.) maliban kung idagdag mo nang tahasan ang thread channel id.
- Owner hint: kapag tumugma ang per-guild o per-channel na `users` allowlist sa sender, itinuturing ng OpenClaw ang sender na iyon bilang owner sa system prompt. Para sa global owner sa lahat ng channel, itakda ang `commands.ownerAllowFrom`.
- Ang mga mensaheng gawa ng bot ay binabalewala by default; itakda ang `channels.discord.allowBots=true` para payagan ang mga ito (ang sariling mensahe ay mananatiling filtered).
- Babala: Kung papayagan mo ang mga reply sa ibang bot (`channels.discord.allowBots=true`), pigilan ang bot-to-bot reply loop gamit ang `requireMention`, `channels.discord.guilds.*.channels.<id>.users` allowlist, at/o linisin ang mga guardrail sa `AGENTS.md` at `SOUL.md`.

### 6) I-verify na gumagana ito

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
- Ang `channels.discord.groupPolicy` ay default sa **allowlist**; itakda ito sa `"open"` o magdagdag ng guild entry sa ilalim ng `channels.discord.guilds` (opsyonal na ilista ang mga channel sa ilalim ng `channels.discord.guilds.<id>.channels` para higpitan).
  - Kung itinatakda mo lang ang `DISCORD_BOT_TOKEN` at hindi ka kailanman gumagawa ng seksyong `channels.discord`, ang runtime ay nagde-default ng `groupPolicy` sa `open`. Magdagdag ng `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, o isang guild/channel allowlist para i-lock ito.
- Ang `requireMention` ay dapat nasa ilalim ng `channels.discord.guilds` (o isang partikular na channel). Ang `channels.discord.requireMention` sa top level ay binabalewala.
- Ang mga **permission audit** (`channels status --probe`) ay sinusuri lamang ang mga numeric channel ID. Kung gumagamit ka ng mga slug/pangalan bilang mga `channels.discord.guilds.*.channels` key, hindi mabe-verify ng audit ang mga pahintulot.
- **Hindi gumagana ang mga DM**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, o hindi ka pa naaprubahan (`channels.discord.dm.policy="pairing"`).
- **Mga exec approval sa Discord**: Sinusuportahan ng Discord ang **button UI** para sa mga exec approval sa mga DM (Allow once / Always allow / Deny). Ang `/approve <id> ...` ay para lang sa mga forwarded approval at hindi aayusin ang mga button prompt ng Discord. Kung makita mo ang `❌ Failed to submit approval: Error: unknown approval id` o hindi kailanman lumalabas ang UI, suriin:
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

Ang mga outbound na Discord API call ay nagre-retry sa mga rate limit (429) gamit ang Discord `retry_after` kapag available, na may exponential backoff at jitter. I-configure sa pamamagitan ng `channels.discord.retry`. Tingnan ang [Retry policy](/concepts/retry).

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

Ang mga ack reaction ay kinokontrol nang global sa pamamagitan ng `messages.ackReaction` +
`messages.ackReactionScope`. Gamitin ang `messages.removeAckAfterReply` para linisin ang
ack reaction pagkatapos sumagot ng bot.

- `dm.enabled`: itakda ang `false` para balewalain ang lahat ng DM (default `true`).
- `dm.policy`: kontrol sa access ng DM (`pairing` ang inirerekomenda). Ang `"open"` ay nangangailangan ng `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM allowlist (mga user id o pangalan). Ginagamit ng `dm.policy="allowlist"` at para sa `dm.policy="open"` validation. Tumatanggap ang wizard ng mga username at nireresolba ang mga ito sa mga id kapag makakapag-search ng mga member ang bot.
- `dm.groupEnabled`: i-enable ang mga group DM (default `false`).
- `dm.groupChannels`: opsyonal na allowlist para sa mga group DM channel id o slug.
- `groupPolicy`: kumokontrol sa paghawak ng mga guild channel (`open|disabled|allowlist`); ang `allowlist` ay nangangailangan ng mga channel allowlist.
- `guilds`: per-guild na mga patakaran na naka-key sa guild id (mas gusto) o slug.
- `guilds."*"`: default na per-guild na mga setting na inilalapat kapag walang tahasang entry.
- `guilds.<id>.slug`: opsyonal na friendly slug na ginagamit para sa mga display name.
- `guilds.<id>.users`: opsyonal na per-guild user allowlist (mga id o pangalan).
- `guilds.<id>.tools`: opsyonal na per-guild tool policy override (`allow`/`deny`/`alsoAllow`) na ginagamit kapag nawawala ang channel override.
- `guilds.<id>.toolsBySender`: opsyonal na per-sender tool policy override sa antas ng guild (naaangkop kapag nawawala ang channel override; sinusuportahan ang `"*"` wildcard).
- `guilds.<id>.channels.<channel>.allow`: payagan/tanggihan ang channel kapag `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: mention gating para sa channel.
- `guilds.<id>.channels.<channel>.tools`: opsyonal na per-channel tool policy override (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: opsyonal na per-sender tool policy override sa loob ng channel (sinusuportahan ang `"*"` wildcard).
- `guilds.<id>.channels.<channel>.users`: opsyonal na per-channel user allowlist.
- `guilds.<id>.channels.<channel>.skills`: skill filter (omit = lahat ng skills, empty = wala).
- `guilds.<id>.channels.<channel>.systemPrompt`: dagdag na system prompt para sa channel. Ang mga Discord channel topic ay ini-inject bilang **untrusted** na context (hindi system prompt).
- `guilds.<id>.channels.<channel>.enabled`: itakda ang `false` para i-disable ang channel.
- `guilds.<id>.channels`: mga patakaran ng channel (ang mga key ay mga channel slug o id).
- `guilds.<id>.requireMention`: per-guild mention requirement (maaaring i-override per channel).
- `guilds.<id>.reactionNotifications`: reaction system event mode (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: outbound text chunk size (chars). Default: 2000.
- `chunkMode`: ang `length` (default) ay naghahati lang kapag lumampas sa `textChunkLimit`; ang `newline` ay naghahati sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- `maxLinesPerMessage`: soft max na bilang ng linya bawat mensahe. Default: 17.
- `mediaMaxMb`: i-clamp ang inbound media na sine-save sa disk.
- `historyLimit`: bilang ng mga kamakailang guild message na isasama bilang context kapag nagre-reply sa isang mention (default 20; bumabagsak sa `messages.groupChat.historyLimit`; ang `0` ay nagdi-disable).
- `dmHistoryLimit`: DM history limit sa mga user turn. Per-user override: `dms["<user_id>"].historyLimit`.
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
- `execApprovals`: Discord-only na exec approval DM (button UI). Sinusuportahan ang `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Ang mga reaction notification ay gumagamit ng `guilds.<id>.reactionNotifications`:

- `off`: walang reaction event.
- `own`: mga reaction sa sariling mensahe ng bot (default).
- `all`: lahat ng reaction sa lahat ng mensahe.
- `allowlist`: mga reaction mula sa `guilds.<id>.users` sa lahat ng mensahe (ang walang laman na listahan ay nagdi-disable).

### Suporta sa PluralKit (PK)

I-enable ang PK lookup para ang mga proxied message ay maresolba sa underlying system + member.
Kapag naka-enable, ginagamit ng OpenClaw ang identity ng member para sa mga allowlist at nilalabel ang
sender bilang `Member (PK:System)` para maiwasan ang aksidenteng Discord ping.

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

- Gamitin ang `pk:<memberId>` sa `dm.allowFrom`, `guilds.<id>.users`, o per-channel na `users`.
- Ang mga display name ng member ay tinatapatan din ayon sa pangalan/slug.
- Ang mga lookup ay gumagamit ng **orihinal** na Discord message ID (ang pre-proxy message), kaya nireresolba lang ito ng PK API sa loob ng 30-minutong window nito.
- Kapag pumalya ang mga PK lookup (hal., private system na walang token), ang mga proxied message ay itinuturing na mga mensahe ng bot at ibinabagsak maliban kung `channels.discord.allowBots=true`.

### Mga default ng tool action

| Action group   | Default  | Mga tala                           |
| -------------- | -------- | ---------------------------------- |
| reactions      | enabled  | React + list reactions + emojiList |
| stickers       | enabled  | Magpadala ng stickers              |
| emojiUploads   | enabled  | Mag-upload ng emojis               |
| stickerUploads | enabled  | Mag-upload ng stickers             |
| polls          | enabled  | Gumawa ng mga poll                 |
| permissions    | enabled  | Snapshot ng pahintulot sa channel  |
| messages       | enabled  | Basa/padala/edit/bura              |
| threads        | enabled  | Gumawa/maglista/magreply           |
| pins           | enabled  | Pin/unpin/list                     |
| search         | enabled  | Paghahanap ng mensahe (preview)    |
| memberInfo     | enabled  | Impormasyon ng member              |
| roleInfo       | enabled  | Listahan ng role                   |
| channelInfo    | enabled  | Impormasyon + listahan ng channel  |
| channels       | enabled  | Pamamahala ng channel/category     |
| voiceStatus    | enabled  | Lookup ng voice state              |
| events         | enabled  | Maglista/gumawa ng scheduled event |
| roles          | disabled | Role add/remove                    |
| moderation     | disabled | Timeout/kick/ban                   |
| presence       | disabled | Bot status/activity (setPresence)  |

- `replyToMode`: `off` (default), `first`, o `all`. Nalalapat lamang kapag ang model ay may kasamang reply tag.

## Reply tags

Para humiling ng threaded reply, maaaring magsama ang model ng isang tag sa output nito:

- `[[reply_to_current]]` — mag-reply sa nag-trigger na Discord message.
- `[[reply_to:<id>]]` — mag-reply sa isang partikular na message id mula sa context/history.
  Ang mga kasalukuyang message id ay idinadagdag sa mga prompt bilang `[message_id: …]`; ang mga entry sa history ay may kasama nang mga id.

Ang behavior ay kinokontrol ng `channels.discord.replyToMode`:

- `off`: balewalain ang mga tag.
- `first`: ang unang outbound chunk/attachment lang ang reply.
- `all`: bawat outbound chunk/attachment ay reply.

Mga tala sa allowlist matching:

- Ang `allowFrom`/`users`/`groupChannels` ay tumatanggap ng mga id, pangalan, tag, o mga mention tulad ng `<@id>`.
- Sinusuportahan ang mga prefix tulad ng `discord:`/`user:` (users) at `channel:` (group DM).
- Gamitin ang `*` para payagan ang anumang sender/channel.
- Kapag naroon ang `guilds.<id>.channels`, ang mga channel na hindi nakalista ay tinatanggihan by default.
- Kapag tinanggal ang `guilds.<id>.channels`, pinapayagan ang lahat ng channel sa allowlisted guild.
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

Ang mga Discord message id ay inilalantad sa injected context (`[discord message id: …]` at mga history line) para matarget ng agent.
Ang emoji ay maaaring unicode (hal., `✅`) o custom emoji syntax tulad ng `<:party_blob:1234567890>`.

## Kaligtasan at ops

- Ituring ang bot token na parang password; mas piliin ang `DISCORD_BOT_TOKEN` env var sa mga supervised host o higpitan ang mga pahintulot ng config file.
- Ibigay lamang sa bot ang mga pahintulot na kailangan nito (karaniwan Read/Send Messages).
- Kung ang bot ay na-stuck o na-rate limit, i-restart ang gateway (`openclaw gateway --force`) matapos tiyaking walang ibang prosesong may-ari ng Discord session.
