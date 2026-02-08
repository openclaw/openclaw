---
summary: "Setup ng Slack para sa socket o HTTP webhook mode"
read_when: "Kapag nagsi-setup ng Slack o nagde-debug ng Slack socket/HTTP mode"
title: "Slack"
x-i18n:
  source_path: channels/slack.md
  source_hash: 8ab00a8a93ec31b7
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:00Z
---

# Slack

## Socket mode (default)

### Mabilis na setup (baguhan)

1. Gumawa ng Slack app at i-enable ang **Socket Mode**.
2. Gumawa ng **App Token** (`xapp-...`) at **Bot Token** (`xoxb-...`).
3. Itakda ang mga token para sa OpenClaw at simulan ang gateway.

Minimal na config:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Setup

1. Gumawa ng Slack app (From scratch) sa [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → i-toggle on. Pagkatapos ay pumunta sa **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** na may scope na `connections:write`. Kopyahin ang **App Token** (`xapp-...`).
3. **OAuth & Permissions** → magdagdag ng bot token scopes (gamitin ang manifest sa ibaba). I-click ang **Install to Workspace**. Kopyahin ang **Bot User OAuth Token** (`xoxb-...`).
4. Opsyonal: **OAuth & Permissions** → magdagdag ng **User Token Scopes** (tingnan ang read-only na listahan sa ibaba). I-reinstall ang app at kopyahin ang **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → i-enable ang events at mag-subscribe sa:
   - `message.*` (kasama ang edits/deletes/thread broadcasts)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. I-invite ang bot sa mga channel na gusto mong mabasa nito.
7. Slash Commands → gumawa ng `/openclaw` kung gumagamit ka ng `channels.slack.slashCommand`. Kung i-enable mo ang native commands, magdagdag ng isang slash command kada built-in command (parehong pangalan gaya ng `/help`). Naka-off ang native bilang default para sa Slack maliban kung itatakda mo ang `channels.slack.commands.native: true` (ang global `commands.native` ay `"auto"` na iniiwang naka-off ang Slack).
8. App Home → i-enable ang **Messages Tab** para makapag-DM ang mga user sa bot.

Gamitin ang manifest sa ibaba para manatiling naka-sync ang scopes at events.

Multi-account support: gamitin ang `channels.slack.accounts` na may per-account tokens at opsyonal na `name`. Tingnan ang [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para sa shared pattern.

### OpenClaw config (Socket mode)

Itakda ang mga token via env vars (inirerekomenda):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

O via config:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User token (opsyonal)

Maaaring gumamit ang OpenClaw ng Slack user token (`xoxp-...`) para sa mga read operation (history,
pins, reactions, emoji, member info). Bilang default, nananatili itong read-only: mas pinipili ng reads ang user token kapag mayroon, at ang writes ay gumagamit pa rin ng bot token maliban kung tahasan kang mag-opt in. Kahit may `userTokenReadOnly: false`, nananatiling mas pinipili ang bot token para sa writes kapag available ito.

Ang mga user token ay kino-configure sa config file (walang env var support). Para sa
multi-account, itakda ang `channels.slack.accounts.<id>.userToken`.

Halimbawa na may bot + app + user tokens:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Halimbawa na may tahasang itinakda ang userTokenReadOnly (pinapayagan ang user token writes):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Paggamit ng token

- Mga read operation (history, reactions list, pins list, emoji list, member info,
  search) ay mas pinipili ang user token kapag naka-configure, kung hindi ay ang bot token.
- Mga write operation (magpadala/mag-edit/mag-delete ng mga mensahe, magdagdag/mag-alis ng reactions, mag-pin/mag-unpin,
  file uploads) ay gumagamit ng bot token bilang default. Kung `userTokenReadOnly: false` at
  walang available na bot token, babalik ang OpenClaw sa user token.

### History context

- Kinokontrol ng `channels.slack.historyLimit` (o `channels.slack.accounts.*.historyLimit`) kung ilang pinakahuling mensahe ng channel/group ang isinasama sa prompt.
- Babagsak sa `messages.groupChat.historyLimit`. Itakda ang `0` para i-disable (default 50).

## HTTP mode (Events API)

Gamitin ang HTTP webhook mode kapag ang iyong Gateway ay naaabot ng Slack sa HTTPS (karaniwan para sa server deployments).
Ginagamit ng HTTP mode ang Events API + Interactivity + Slash Commands na may iisang request URL.

### Setup (HTTP mode)

1. Gumawa ng Slack app at **i-disable ang Socket Mode** (opsyonal kung HTTP lang ang gagamitin).
2. **Basic Information** → kopyahin ang **Signing Secret**.
3. **OAuth & Permissions** → i-install ang app at kopyahin ang **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → i-enable ang events at itakda ang **Request URL** sa webhook path ng iyong gateway (default `/slack/events`).
5. **Interactivity & Shortcuts** → i-enable at itakda ang parehong **Request URL**.
6. **Slash Commands** → itakda ang parehong **Request URL** para sa iyong mga command.

Halimbawang request URL:
`https://gateway-host/slack/events`

### OpenClaw config (minimal)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Multi-account HTTP mode: itakda ang `channels.slack.accounts.<id>.mode = "http"` at magbigay ng natatanging
`webhookPath` kada account para maituro ng bawat Slack app ang sarili nitong URL.

### Manifest (opsyonal)

Gamitin ang Slack app manifest na ito para mabilis na magawa ang app (i-adjust ang pangalan/command kung gusto mo). Isama ang
user scopes kung plano mong mag-configure ng user token.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Kung i-enable mo ang native commands, magdagdag ng isang `slash_commands` entry kada command na gusto mong ilantad (tumutugma sa listahang `/help`). I-override gamit ang `channels.slack.commands.native`.

## Scopes (kasalukuyan vs opsyonal)

Type-scoped ang Conversations API ng Slack: kailangan mo lang ang scopes para sa mga
uri ng conversation na aktuwal mong ginagamit (channels, groups, im, mpim). Tingnan ang
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) para sa pangkalahatang-ideya.

### Bot token scopes (kinakailangan)

- `chat:write` (magpadala/mag-update/mag-delete ng mga mensahe via `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (magbukas ng DMs via `conversations.open` para sa user DMs)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (lookup ng user)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (uploads via `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (opsyonal, read-only bilang default)

Idagdag ang mga ito sa **User Token Scopes** kung iko-configure mo ang `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Hindi kailangan sa ngayon (ngunit posibleng sa hinaharap)

- `mpim:write` (kung magdadagdag lang tayo ng group-DM open/DM start via `conversations.open`)
- `groups:write` (kung magdadagdag lang tayo ng private-channel management: create/rename/invite/archive)
- `chat:write.public` (kung gusto nating mag-post sa mga channel na wala ang bot)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (kung kailangan natin ang email fields mula sa `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (kung magsisimula tayong maglista/magbasa ng file metadata)

## Config

Gumagamit ang Slack ng Socket Mode lamang (walang HTTP webhook server). Ibigay ang parehong token:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Maaari ring ibigay ang mga token via env vars:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ang ack reactions ay kinokontrol sa global via `messages.ackReaction` +
`messages.ackReactionScope`. Gamitin ang `messages.removeAckAfterReply` para i-clear ang
ack reaction matapos mag-reply ang bot.

## Limits

- Ang outbound text ay hina-hati sa `channels.slack.textChunkLimit` (default 4000).
- Opsyonal na newline chunking: itakda ang `channels.slack.chunkMode="newline"` para hatiin sa mga blank line (mga hangganan ng talata) bago ang length chunking.
- Ang media uploads ay may limit na `channels.slack.mediaMaxMb` (default 20).

## Reply threading

Bilang default, nagre-reply ang OpenClaw sa main channel. Gamitin ang `channels.slack.replyToMode` para kontrolin ang awtomatikong threading:

| Mode    | Behavior                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Default.** Mag-reply sa main channel. Magti-thread lang kung ang nag-trigger na mensahe ay nasa thread na.                                                                                                  |
| `first` | Ang unang reply ay papasok sa thread (sa ilalim ng nag-trigger na mensahe), ang mga kasunod ay sa main channel. Kapaki-pakinabang para panatilihing visible ang context habang iniiwasan ang kalat sa thread. |
| `all`   | Lahat ng reply ay sa thread. Pinananatiling contained ang mga usapan ngunit maaaring bumaba ang visibility.                                                                                                   |

Nalalapat ang mode sa parehong auto-replies at agent tool calls (`slack sendMessage`).

### Per-chat-type threading

Maaari kang mag-configure ng magkakaibang threading behavior kada uri ng chat sa pamamagitan ng pagtatakda ng `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Mga sinusuportahang chat type:

- `direct`: 1:1 DMs (Slack `im`)
- `group`: group DMs / MPIMs (Slack `mpim`)
- `channel`: standard channels (public/private)

Precedence:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Provider default (`off`)

Ang legacy na `channels.slack.dm.replyToMode` ay tinatanggap pa rin bilang fallback para sa `direct` kapag walang chat-type override na nakatakda.

Mga halimbawa:

I-thread ang DMs lang:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

I-thread ang group DMs pero panatilihin ang channels sa root:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Gawing thread ang channels, panatilihin ang DMs sa root:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Manual threading tags

Para sa mas detalyadong kontrol, gamitin ang mga tag na ito sa mga response ng agent:

- `[[reply_to_current]]` — mag-reply sa nag-trigger na mensahe (simulan/ipagpatuloy ang thread).
- `[[reply_to:<id>]]` — mag-reply sa isang partikular na message id.

## Sessions + routing

- Ang DMs ay nagbabahagi ng `main` session (tulad ng WhatsApp/Telegram).
- Ang mga channel ay tumutugma sa `agent:<agentId>:slack:channel:<channelId>` sessions.
- Ang Slash commands ay gumagamit ng `agent:<agentId>:slack:slash:<userId>` sessions (maaaring i-configure ang prefix via `channels.slack.slashCommand.sessionPrefix`).
- Kung hindi ibinigay ng Slack ang `channel_type`, ini-infer ito ng OpenClaw mula sa channel ID prefix (`D`, `C`, `G`) at nagde-default sa `channel` para panatilihing stable ang mga session key.
- Ang native command registration ay gumagamit ng `commands.native` (global default `"auto"` → Slack off) at maaaring i-override kada workspace gamit ang `channels.slack.commands.native`. Ang text commands ay nangangailangan ng standalone na `/...` messages at maaaring i-disable gamit ang `commands.text: false`. Ang Slack slash commands ay mina-manage sa Slack app at hindi awtomatikong inaalis. Gamitin ang `commands.useAccessGroups: false` para i-bypass ang access-group checks para sa mga command.
- Buong listahan ng command + config: [Slash commands](/tools/slash-commands)

## DM security (pairing)

- Default: `channels.slack.dm.policy="pairing"` — ang mga hindi kilalang DM sender ay nakakakuha ng pairing code (nag-e-expire pagkalipas ng 1 oras).
- I-approve via: `openclaw pairing approve slack <code>`.
- Para payagan ang kahit sino: itakda ang `channels.slack.dm.policy="open"` at `channels.slack.dm.allowFrom=["*"]`.
- Tumatanggap ang `channels.slack.dm.allowFrom` ng mga user ID, @handle, o email (nire-resolve sa startup kapag pinapayagan ng mga token). Tumatanggap ang wizard ng mga username at nire-resolve ang mga ito sa mga id habang setup kapag pinapayagan ng mga token.

## Group policy

- Kinokontrol ng `channels.slack.groupPolicy` ang paghawak sa channel (`open|disabled|allowlist`).
- Ang `allowlist` ay nangangailangan na mailista ang mga channel sa `channels.slack.channels`.
- Kung itatakda mo lang ang `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` at hindi kailanman gagawa ng `channels.slack` na seksyon,
  ang runtime defaults ay itinatakda ang `groupPolicy` sa `open`. Magdagdag ng `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, o isang channel allowlist para higpitan ito.
- Tumatanggap ang configure wizard ng mga pangalan ng `#channel` at nire-resolve ang mga ito sa mga ID kapag posible
  (public + private); kung may maraming tugma, mas pinipili ang aktibong channel.
- Sa startup, nire-resolve ng OpenClaw ang mga pangalan ng channel/user sa mga allowlist papunta sa mga ID (kapag pinapayagan ng mga token)
  at nilo-log ang mapping; ang mga hindi na-resolve na entry ay pinananatili ayon sa pagkakatype.
- Para payagan ang **walang channel**, itakda ang `channels.slack.groupPolicy: "disabled"` (o panatilihing walang laman ang allowlist).

Mga opsyon sa channel (`channels.slack.channels.<id>` o `channels.slack.channels.<name>`):

- `allow`: payagan/itanggi ang channel kapag `groupPolicy="allowlist"`.
- `requireMention`: mention gating para sa channel.
- `tools`: opsyonal na per-channel tool policy overrides (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: opsyonal na per-sender tool policy overrides sa loob ng channel (ang mga key ay sender ids/@handle/email; suportado ang `"*"` wildcard).
- `allowBots`: payagan ang mga mensaheng authored ng bot sa channel na ito (default: false).
- `users`: opsyonal na per-channel user allowlist.
- `skills`: skill filter (omit = lahat ng skills, empty = wala).
- `systemPrompt`: karagdagang system prompt para sa channel (pinagsasama sa topic/purpose).
- `enabled`: itakda ang `false` para i-disable ang channel.

## Delivery targets

Gamitin ang mga ito sa cron/CLI sends:

- `user:<id>` para sa DMs
- `channel:<id>` para sa mga channel

## Tool actions

Maaaring i-gate ang mga Slack tool actions gamit ang `channels.slack.actions.*`:

| Action group | Default | Mga tala                 |
| ------------ | ------- | ------------------------ |
| reactions    | enabled | React + list reactions   |
| messages     | enabled | Basa/padala/edit/delete  |
| pins         | enabled | Pin/unpin/list           |
| memberInfo   | enabled | Impormasyon ng miyembro  |
| emojiList    | enabled | Listahan ng custom emoji |

## Mga tala sa seguridad

- Ang writes ay nagde-default sa bot token para manatiling naka-scope ang mga aksyong nagbabago ng state sa
  mga permiso at identidad ng bot ng app.
- Ang pagtatakda ng `userTokenReadOnly: false` ay nagpapahintulot na magamit ang user token para sa write
  operations kapag walang available na bot token, na nangangahulugang tumatakbo ang mga aksyon gamit ang access ng
  user na nag-install. Ituring ang user token bilang mataas ang pribilehiyo at panatilihing mahigpit ang
  mga action gate at allowlist.
- Kung i-enable mo ang user-token writes, siguraduhing kasama sa user token ang mga write
  scopes na inaasahan mo (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) kung hindi ay mabibigo ang mga operasyong iyon.

## Pag-troubleshoot

Patakbuhin muna ang ladder na ito:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Pagkatapos ay kumpirmahin ang DM pairing state kung kinakailangan:

```bash
openclaw pairing list slack
```

Mga karaniwang pagkabigo:

- Nakakonekta ngunit walang reply sa channel: naka-block ang channel ng `groupPolicy` o wala sa `channels.slack.channels` allowlist.
- Hindi pinapansin ang DMs: hindi aprubado ang sender kapag `channels.slack.dm.policy="pairing"`.
- Mga API error (`missing_scope`, `not_in_channel`, mga auth failure): kulang o mali ang bot/app tokens o Slack scopes.

Para sa triage flow: [/channels/troubleshooting](/channels/troubleshooting).

## Mga tala

- Ang mention gating ay kinokontrol via `channels.slack.channels` (itakda ang `requireMention` sa `true`); ang `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) ay binibilang din bilang mentions.
- Multi-agent override: magtakda ng per-agent patterns sa `agents.list[].groupChat.mentionPatterns`.
- Ang reaction notifications ay sumusunod sa `channels.slack.reactionNotifications` (gamitin ang `reactionAllowlist` na may mode na `allowlist`).
- Ang mga mensaheng authored ng bot ay hindi pinapansin bilang default; i-enable via `channels.slack.allowBots` o `channels.slack.channels.<id>.allowBots`.
- Babala: Kung papayagan mo ang mga reply sa ibang bot (`channels.slack.allowBots=true` o `channels.slack.channels.<id>.allowBots=true`), pigilan ang bot-to-bot reply loops gamit ang `requireMention`, `channels.slack.channels.<id>.users` allowlists, at/o malinaw na guardrails sa `AGENTS.md` at `SOUL.md`.
- Para sa Slack tool, ang semantics ng reaction removal ay nasa [/tools/reactions](/tools/reactions).
- Ang mga attachment ay dina-download sa media store kapag pinahihintulutan at nasa ilalim ng size limit.
