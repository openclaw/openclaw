---
summary: "Slack-opsætning til socket- eller HTTP-webhook-tilstand"
read_when: "Opsætning af Slack eller fejlfinding af Slack socket/HTTP-tilstand"
title: "Slack"
---

# Slack

## Socket-tilstand (standard)

### Hurtig opsætning (begynder)

1. Opret en Slack-app og aktivér **Socket Mode**.
2. Opret et **App Token** (`xapp-...`) og et **Bot Token** (`xoxb-...`).
3. Sæt tokens for OpenClaw og start gatewayen.

Minimal konfiguration:

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

### Opsætning

1. Opret en Slack-app (From scratch) på [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Sokkel tilstand** → slå til. Gå derefter til **Grundlæggende oplysninger** → **App-Level Tokens** → **Generere Token og Scopes** med anvendelsesområde `forbindelser:skrive`. Kopier **App Token** (`xapp-...`).
3. **OAuth & Tilladelser** → Tilføj bot token scopes (brug manifestet nedenfor). Klik på **Installer på arbejdsområdet**. Kopier **Bot User OAuth Token** (`xoxb-...`).
4. Valgfri: **OAuth & Tilladelser** → Tilføj **Bruger Token Scopes** (se listen med skrivebeskyttet nedenfor). Geninstaller app'en og kopier **Bruger OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → aktivér events og abonnér på:
   - `message.*` (inkluderer redigeringer/sletninger/tråd-broadcasts)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Invitér botten til de kanaler, du vil have den til at læse.
7. Slash kommandoer → oprette `/openclaw` hvis du bruger `channels.slack.slashCommand`. Hvis du aktiverer lokale kommandoer, skal du tilføje en skråstreg kommando pr. indbygget kommando (samme navne som `/help`). Indfødte standarder er slukket for Slack medmindre du sætter `channels.slack.commands.native: true` (global `commands.native` er `"auto"` som efterlader Slack off).
8. App Home → aktivér **Messages Tab**, så brugere kan DM’e botten.

Brug manifestet nedenfor, så scopes og events forbliver synkroniserede.

Understøttelse af flere konti: brug `channels.slack.accounts` med tokens pr. konto og valgfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for det delte mønster.

### OpenClaw-konfiguration (Socket-tilstand)

Sæt tokens via miljøvariabler (anbefalet):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Eller via konfiguration:

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

### User token (valgfrit)

OpenClaw kan bruge en Slack bruger token (`xoxp-...`) for læseoperationer (historie,
pins, reaktioner, emoji, medlem info). Som standard forbliver dette read-only: læser
foretrækker brugeren token når den er til stede, og skriver stadig bruge bot token medmindre
du udtrykkeligt vælger det. Selv med `userTokenReadOnly: false`, bot token forbliver
foretrukket for skriver, når den er tilgængelig.

Bruger-tokens er konfigureret i konfigurationsfilen (ingen understøttelse for env var). For
multi-konto, angiv `channels.slack.accounts.<id>.userToken`.

Eksempel med bot + app + user tokens:

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

Eksempel med userTokenReadOnly eksplicit sat (tillad skrivninger med user token):

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

#### Token-brug

- Læseoperationer (historik, reaktionsliste, pins-liste, emoji-liste, medlemsinfo,
  søgning) foretrækker user token, når det er konfigureret, ellers bot token.
- Skriv operationer (send/edit/delete beskeder, tilføj/remove reaktioner, pin/unpin,
  fil uploads) bruge bot token som standard. If `userTokenReadOnly: false` and
  no bot token is available OpenClaw falls back to the user token.

### Historik-kontekst

- `channels.slack.historyLimit` (eller `channels.slack.accounts.*.historyLimit`) styrer, hvor mange nylige kanal-/gruppebeskeder der pakkes ind i prompten.
- Falder tilbage til `messages.groupChat.historyLimit`. Sæt `0` til at deaktivere (standard 50).

## HTTP-tilstand (Events API)

Brug HTTP webhook tilstand, når din Gateway er tilgængelig af Slack over HTTPS (typisk for server implementeringer).
HTTP-tilstand bruger Events API + Interaktivitet + Slash kommandoer med en delt anmodning URL.

### Opsætning (HTTP-tilstand)

1. Opret en Slack-app og **deaktivér Socket Mode** (valgfrit, hvis du kun bruger HTTP).
2. **Basic Information** → kopiér **Signing Secret**.
3. **OAuth & Permissions** → installér appen og kopiér **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → aktivér events og sæt **Request URL** til din gateway webhook-sti (standard `/slack/events`).
5. **Interactivity & Shortcuts** → aktivér og sæt den samme **Request URL**.
6. **Slash Commands** → sæt den samme **Request URL** for dine kommandoer.

Eksempel på request-URL:
`https://gateway-host/slack/events`

### OpenClaw-konfiguration (minimal)

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

Multi-konto HTTP-tilstand: sæt `channels.slack.accounts.<id>.mode = "http"` og angiv en unik
`webhookPath` pr. konto, så hver Slack app kan pege på sin egen URL.

### Manifest (valgfrit)

Brug denne Slack app manifest til at oprette app hurtigt (justere navn/kommando, hvis du vil). Inkluder
brugerens anvendelsesområder, hvis du planlægger at konfigurere et bruger-token.

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

Hvis du aktiverer lokale kommandoer, så tilføj en `slash_commands` post pr. kommando du ønsker at udsætte (matcher listen `/help`). Tilsidesæt med `channels.slack.commands.native`.

## Scopes (aktuelle vs. valgfri)

Slack's Conversations API er type-scoped: du behøver kun scopes for de
samtaletyper, du rent faktisk rører (kanaler, grupper, im, mpim). Se
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) for oversigten.

### Bot token scopes (påkrævet)

- `chat:write` (send/opdatér/slet beskeder via `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (åbn DMs via `conversations.open` for bruger-DMs)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (brugeropslag)
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

### User token scopes (valgfri, read-only som standard)

Tilføj disse under **User Token Scopes**, hvis du konfigurerer `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Ikke nødvendige i dag (men sandsynligvis fremtid)

- `mpim:write` (kun hvis vi tilføjer group-DM open/DM start via `conversations.open`)
- `groups:write` (kun hvis vi tilføjer håndtering af private kanaler: opret/omdøb/invitér/arkivér)
- `chat:write.public` (kun hvis vi vil poste til kanaler, botten ikke er i)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (kun hvis vi har brug for e-mailfelter fra `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (kun hvis vi begynder at liste/læse filmetadata)

## Konfiguration

Slack bruger kun Socket Mode (ingen HTTP webhook server). Giv begge tokens:

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

Tokens kan også leveres via miljøvariabler:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack reaktioner styres globalt via `messages.ackReaction` +
`messages.ackReactionScope`. Brug `messages.removeAckAfterReply` for at rydde
ack reaktion efter bot svar.

## Grænser

- Udgående tekst opdeles i bidder på `channels.slack.textChunkLimit` (standard 4000).
- Valgfri opdeling ved linjeskift: sæt `channels.slack.chunkMode="newline"` for at splitte ved tomme linjer (afsnitsgrænser) før længdeopdeling.
- Medieuploads er begrænset af `channels.slack.mediaMaxMb` (standard 20).

## Svar-trådning

Som standard besvarer OpenClaw i hovedkanalen. Brug `channels.slack.replyToMode` til at styre automatisk gevind:

| Tilstand | Adfærd                                                                                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`    | **Standard.** Svar i hovedkanalen. Kun tråd hvis den udløsende besked allerede var i en tråd.                                                                          |
| `first`  | Første svar går til tråd (under den udløsende meddelelse), efterfølgende svar gå til hovedkanalen. Nyttigt til at holde sammenhæng synlig, samtidig undgå tråd rod. |
| `all`    | Alle svar går til tråd. Holder samtalerne indeholdt, men kan reducere synligheden.                                                                                                     |

Tilstanden gælder både autosvar og agent-værktøjskald (`slack sendMessage`).

### Trådning pr. chat-type

Du kan konfigurere forskellig trådningsadfærd pr. chat-type ved at sætte `channels.slack.replyToModeByChatType`:

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

Understøttede chat-typer:

- `direct`: 1:1 DMs (Slack `im`)
- `group`: gruppe-DMs / MPIMs (Slack `mpim`)
- `channel`: standardkanaler (offentlige/private)

Præcedens:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Udbyder-standard (`off`)

Legacy `channels.slack.dm.replyToMode` accepteres stadig som fallback for `direct`, når ingen chat-type-override er sat.

Eksempler:

Tråd kun DMs:

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

Tråd gruppe-DMs, men behold kanaler i roden:

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

Gør kanaler til tråde, behold DMs i roden:

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

### Manuelle trådningstags

Til finjusteret kontrol kan du bruge disse tags i agent-svar:

- `[[reply_to_current]]` — svar på den udløsende besked (start/fortsæt tråd).
- `[[reply_to:<id>]]` — svar på en specifik besked-id.

## Sessioner + routing

- DMs deler `main`-sessionen (som WhatsApp/Telegram).
- Kanaler kortlægges til `agent:<agentId>:slack:channel:<channelId>`-sessioner.
- Slash commands bruger `agent:<agentId>:slack:slash:<userId>`-sessioner (præfiks konfigurerbart via `channels.slack.slashCommand.sessionPrefix`).
- Hvis Slack ikke leverer `channel_type`, udleder OpenClaw det fra kanal-id-præfikset (`D`, `C`, `G`) og falder tilbage til `channel` for at holde sessionsnøgler stabile.
- Indfødte kommando registrering bruger `commands.native` (global standard `"auto"` → Slack off) og kan tilsidesættes per-workspace med `channels.slack.commands.native`. Tekst kommandoer kræver standalone `/...` beskeder og kan deaktiveres med `commands.text: false`. Slack skråstreg kommandoer administreres i Slack app og fjernes ikke automatisk. Brug `commands.useAccessGroups: false` for at omgå access-group tjek for kommandoer.
- Fuld kommandoliste + konfiguration: [Slash commands](/tools/slash-commands)

## DM-sikkerhed (parring)

- Standard: `channels.slack.dm.policy="pairing"` — ukendte DM-afsendere får en parringskode (udløber efter 1 time).
- Godkend via: `openclaw pairing approve slack <code>`.
- For at tillade alle: sæt `channels.slack.dm.policy="open"` og `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` accepterer bruger-ID, @handles, eller e-mails (løst ved opstart, når tokens tillader). Guiden accepterer brugernavne og løser dem til id'er under opsætning, når tokens tillader.

## Gruppepolitik

- `channels.slack.groupPolicy` styrer kanalhåndtering (`open|disabled|allowlist`).
- `allowlist` kræver, at kanaler er listet i `channels.slack.channels`.
- Hvis du kun indstille `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` og aldrig oprette en `channels.slack` sektion,
  runtime standard `groupPolicy` til `open`. Tilføj `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, eller en kanal tilladt liste for at låse det ned.
- Opsætningsguiden accepterer `#channel`-navne og opløser dem til id’er, når muligt
  (offentlige + private); hvis der findes flere match, foretrækkes den aktive kanal.
- Ved opstart opløser OpenClaw kanal-/brugernavne i tilladelseslister til id’er (når tokens tillader det)
  og logger mappingen; uløste poster bevares som indtastet.
- For at tillade **ingen kanaler**, sæt `channels.slack.groupPolicy: "disabled"` (eller behold en tom tilladelsesliste).

Kanalindstillinger (`channels.slack.channels.<id>` eller `channels.slack.channels.<name>`):

- `allow`: tillad/afvis kanalen, når `groupPolicy="allowlist"`.
- `requireMention`: mention-gating for kanalen.
- `tools`: valgfrie pr.-kanal værktøjspolitik-overskrivninger (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: valgfrie pr.-afsender værktøjspolitik-overskrivninger inden for kanalen (nøgler er afsender-id’er/@handles/e-mails; `"*"` jokertegn understøttes).
- `allowBots`: tillad bot-forfattede beskeder i denne kanal (standard: false).
- `users`: valgfri pr.-kanal bruger-tilladelsesliste.
- `skills`: skill-filter (udeladt = alle Skills, tom = ingen).
- `systemPrompt`: ekstra systemprompt for kanalen (kombineret med emne/formål).
- `enabled`: sæt `false` for at deaktivere kanalen.

## Leveringsmål

Brug disse med cron/CLI-sends:

- `user:<id>` til DMs
- `channel:<id>` til kanaler

## Værktøjshandlinger

Slack-værktøjshandlinger kan gates med `channels.slack.actions.*`:

| Handlingsgruppe | Standard | Noter                       |
| --------------- | -------- | --------------------------- |
| reactions       | enabled  | Reagér + list reaktioner    |
| messages        | enabled  | Læs/send/redigér/slet       |
| pins            | enabled  | Pin/afpin/list              |
| memberInfo      | enabled  | Medlemsinfo                 |
| emojiList       | enabled  | Brugerdefineret emoji-liste |

## Sikkerhedsnoter

- Skrivehandlinger bruger som standard bot token, så tilstandsændrende handlinger forbliver afgrænset til
  appens bot-tilladelser og identitet.
- Indstilling af `userTokenReadOnly: false` tillader bruger token at blive brugt til at skrive
  operationer, når en bot token er utilgængelig, hvilket betyder, at handlinger kører med
  -installationsbrugerens adgang. Behandl brugeren token som meget privilegeret og holde
  handling porte og tillad lister stramt.
- Hvis du aktiverer skrivninger med user token, skal du sikre, at user token inkluderer de forventede skrive-scopes
  (`chat:write`, `reactions:write`, `pins:write`, `files:write`), ellers vil disse handlinger fejle.

## Fejlfinding

Kør først denne trappe:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bekræft derefter DM-parringsstatus om nødvendigt:

```bash
openclaw pairing list slack
```

Almindelige fejl:

- Forbundet men ingen kanalsvar: kanal blokeret af `groupPolicy` eller ikke i `channels.slack.channels`-tilladelseslisten.
- DMs ignoreres: afsender ikke godkendt, når `channels.slack.dm.policy="pairing"`.
- API-fejl (`missing_scope`, `not_in_channel`, auth-fejl): bot-/app-tokens eller Slack-scopes er ufuldstændige.

For triage-flow: [/channels/troubleshooting](/channels/troubleshooting).

## Noter

- Mention-gating styres via `channels.slack.channels` (sæt `requireMention` til `true`); `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) tæller også som mentions.
- Multi-agent-override: sæt pr.-agent-mønstre på `agents.list[].groupChat.mentionPatterns`.
- Reaktionsnotifikationer følger `channels.slack.reactionNotifications` (brug `reactionAllowlist` med tilstand `allowlist`).
- Bot-authored messages are ignored as default; enable via `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.
- Advarsel: Hvis du tillader svar til andre bots (`channels.slack.allowBots=true` eller `channels.slack.channels.<id>.allowBots=true`), forhindre bot-to-bot svar loops med `requireMention`, `channels.slack.channels.<id>.users` tilladte og/eller klare guardrails i »AGENTS.md« og »SOUL.md«.
- For Slack-værktøjet findes semantik for fjernelse af reaktioner i [/tools/reactions](/tools/reactions).
- Vedhæftninger downloades til medielageret, når det er tilladt og under størrelsesgrænsen.
