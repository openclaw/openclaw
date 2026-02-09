---
summary: "Slack-installatie voor socket- of HTTP-webhookmodus"
read_when: "Slack instellen of Slack socket-/HTTP-modus debuggen"
title: "Slack"
---

# Slack

## Socketmodus (standaard)

### Snelle installatie (beginner)

1. Maak een Slack-app en schakel **Socket Mode** in.
2. Maak een **App Token** (`xapp-...`) en **Bot Token** (`xoxb-...`).
3. Stel tokens in voor OpenClaw en start de Gateway.

Minimale config:

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

### Installatie

1. Maak een Slack-app (From scratch) op [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → schakel in. Ga daarna naar **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** met scope `connections:write`. Kopieer de **App Token** (`xapp-...`).
3. **OAuth & Permissions** → voeg bot-token-scopes toe (gebruik het manifest hieronder). Klik **Install to Workspace**. Kopieer de **Bot User OAuth Token** (`xoxb-...`).
4. Optioneel: **OAuth & Permissions** → voeg **User Token Scopes** toe (zie de alleen-lezenlijst hieronder). Installeer de app opnieuw en kopieer de **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → schakel events in en abonneer je op:
   - `message.*` (inclusief bewerkingen/verwijderingen/thread-uitzendingen)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Nodig de bot uit voor kanalen die hij moet lezen.
7. Slash Commands → maak `/openclaw` als je `channels.slack.slashCommand` gebruikt. Als je native commands inschakelt, voeg één slash command per ingebouwde opdracht toe (dezelfde namen als `/help`). Native staat standaard uit voor Slack tenzij je `channels.slack.commands.native: true` instelt (globaal `commands.native` is `"auto"` waardoor Slack uit blijft).
8. App Home → schakel de **Messages Tab** in zodat gebruikers de bot kunnen DM’en.

Gebruik het manifest hieronder zodat scopes en events gesynchroniseerd blijven.

Ondersteuning voor meerdere accounts: gebruik `channels.slack.accounts` met tokens per account en optioneel `name`. Zie [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) voor het gedeelde patroon.

### OpenClaw-config (Socketmodus)

Stel tokens in via omgevingsvariabelen (aanbevolen):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Of via config:

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

### User token (optioneel)

OpenClaw kan een Slack user token (`xoxp-...`) gebruiken voor leesbewerkingen (geschiedenis,
pins, reacties, emoji, ledeninfo). Standaard blijft dit alleen-lezen: lezen
gebruikt bij aanwezigheid bij voorkeur het user token, en schrijven gebruikt
nog steeds het bot-token tenzij je expliciet kiest. Zelfs met `userTokenReadOnly: false`
blijft het bot-token de voorkeur houden voor schrijven wanneer het beschikbaar is.

User tokens worden geconfigureerd in het configbestand (geen ondersteuning voor env vars). Voor
meerdere accounts stel je `channels.slack.accounts.<id>.userToken` in.

Voorbeeld met bot- + app- + user-tokens:

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

Voorbeeld met userTokenReadOnly expliciet ingesteld (user-token-schrijven toestaan):

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

#### Tokengebruik

- Leesbewerkingen (geschiedenis, reactieslijst, pinslijst, emojilijst, ledeninfo,
  zoeken) geven de voorkeur aan het user token wanneer geconfigureerd, anders het bot-token.
- Schrijfbewerkingen (berichten verzenden/bewerken/verwijderen, reacties toevoegen/verwijderen, pinnen/ontpinnen,
  bestandsuploads) gebruiken standaard het bot-token. Als `userTokenReadOnly: false` en
  er geen bot-token beschikbaar is, valt OpenClaw terug op het user token.

### Geschiedeniscontext

- `channels.slack.historyLimit` (of `channels.slack.accounts.*.historyLimit`) bepaalt hoeveel recente kanaal-/groepberichten in de prompt worden opgenomen.
- Valt terug op `messages.groupChat.historyLimit`. Stel `0` in om uit te schakelen (standaard 50).

## HTTP-modus (Events API)

Gebruik HTTP-webhookmodus wanneer je Gateway via HTTPS door Slack bereikbaar is (typisch voor serverdeployments).
HTTP-modus gebruikt de Events API + Interactivity + Slash Commands met één gedeelde request-URL.

### Installatie (HTTP-modus)

1. Maak een Slack-app en **schakel Socket Mode uit** (optioneel als je alleen HTTP gebruikt).
2. **Basic Information** → kopieer de **Signing Secret**.
3. **OAuth & Permissions** → installeer de app en kopieer de **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → schakel events in en stel de **Request URL** in op het webhookpad van je Gateway (standaard `/slack/events`).
5. **Interactivity & Shortcuts** → schakel in en stel dezelfde **Request URL** in.
6. **Slash Commands** → stel dezelfde **Request URL** in voor je commando(’s).

Voorbeeld request-URL:
`https://gateway-host/slack/events`

### OpenClaw-config (minimaal)

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

HTTP-modus met meerdere accounts: stel `channels.slack.accounts.<id>.mode = "http"` in en geef een unieke
`webhookPath` per account zodat elke Slack-app naar zijn eigen URL kan wijzen.

### Manifest (optioneel)

Gebruik dit Slack-app-manifest om de app snel te maken (pas naam/commando aan indien gewenst). Neem de
user-scopes op als je van plan bent een user token te configureren.

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

Als je native commands inschakelt, voeg één `slash_commands`-entry toe per commando dat je wilt blootstellen (overeenkomend met de lijst `/help`). Overschrijf met `channels.slack.commands.native`.

## Scopes (huidig vs optioneel)

Slack’s Conversations API is type-gescopeerd: je hebt alleen de scopes nodig voor de
gesprekstypen die je daadwerkelijk gebruikt (channels, groups, im, mpim). Zie
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) voor het overzicht.

### Bot-token-scopes (vereist)

- `chat:write` (berichten verzenden/bijwerken/verwijderen via `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (DM’s openen via `conversations.open` voor user-DM’s)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (gebruikersopzoeking)
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

### User-token-scopes (optioneel, standaard alleen-lezen)

Voeg deze toe onder **User Token Scopes** als je `channels.slack.userToken` configureert.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Vandaag niet nodig (maar waarschijnlijk in de toekomst)

- `mpim:write` (alleen als we group-DM openen/DM starten toevoegen via `conversations.open`)
- `groups:write` (alleen als we private-kanalen gaan beheren: maken/hernoemen/uitnodigen/archiveren)
- `chat:write.public` (alleen als we willen posten naar kanalen waar de bot niet in zit)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (alleen als we e-mailvelden nodig hebben van `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (alleen als we beginnen met het lijst/lezen van bestandsmetadata)

## Config

Slack gebruikt alleen Socket Mode (geen HTTP-webhookserver). Geef beide tokens op:

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

Tokens kunnen ook via omgevingsvariabelen worden aangeleverd:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack-reacties worden globaal aangestuurd via `messages.ackReaction` +
`messages.ackReactionScope`. Gebruik `messages.removeAckAfterReply` om de
ack-reactie te verwijderen nadat de bot heeft geantwoord.

## Beperkingen

- Uitgaande tekst wordt opgeknipt tot `channels.slack.textChunkLimit` (standaard 4000).
- Optioneel splitsen op nieuwe regels: stel `channels.slack.chunkMode="newline"` in om op lege regels (paragraafgrenzen) te splitsen vóór lengte-opknippen.
- Media-uploads zijn beperkt door `channels.slack.mediaMaxMb` (standaard 20).

## Antwoord-threading

Standaard antwoordt OpenClaw in het hoofdkanaal. Gebruik `channels.slack.replyToMode` om automatische threading te regelen:

| Modus   | Gedrag                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `off`   | **Standaard.** Antwoord in het hoofdkanaal. Thread alleen als het triggerende bericht al in een thread stond.                                                                        |
| `first` | Eerste antwoord gaat in de thread (onder het triggerende bericht), vervolgreplies gaan naar het hoofdkanaal. Handig om context zichtbaar te houden en thread-rommel te vermijden. |
| `all`   | Alle antwoorden gaan in de thread. Houdt gesprekken compact maar kan zichtbaarheid verminderen.                                                                                                      |

De modus geldt voor zowel auto-replies als agent tool calls (`slack sendMessage`).

### Threading per chat-type

Je kunt verschillend threading-gedrag per chat-type configureren door `channels.slack.replyToModeByChatType` in te stellen:

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

Ondersteunde chat-typen:

- `direct`: 1:1 DM’s (Slack `im`)
- `group`: groeps-DM’s / MPIM’s (Slack `mpim`)
- `channel`: standaardkanalen (openbaar/privé)

Voorrang:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Provider-standaard (`off`)

Legacy `channels.slack.dm.replyToMode` wordt nog geaccepteerd als fallback voor `direct` wanneer geen chat-type-override is ingesteld.

Voorbeelden:

Alleen DM’s in threads:

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

Groeps-DM’s in threads, kanalen in de root houden:

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

Kanalen in threads maken, DM’s in de root houden:

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

### Handmatige threading-tags

Voor fijnmazige controle gebruik je deze tags in agent-antwoorden:

- `[[reply_to_current]]` — antwoord op het triggerende bericht (thread starten/voortzetten).
- `[[reply_to:<id>]]` — antwoord op een specifiek bericht-id.

## Sessies + routering

- DM’s delen de `main`-sessie (zoals WhatsApp/Telegram).
- Kanalen mappen naar `agent:<agentId>:slack:channel:<channelId>`-sessies.
- Slash commands gebruiken `agent:<agentId>:slack:slash:<userId>`-sessies (prefix configureerbaar via `channels.slack.slashCommand.sessionPrefix`).
- Als Slack `channel_type` niet levert, leidt OpenClaw dit af uit de kanaal-ID-prefix (`D`, `C`, `G`) en valt terug op `channel` om sessiesleutels stabiel te houden.
- Registratie van native commands gebruikt `commands.native` (globale standaard `"auto"` → Slack uit) en kan per werkruimte worden overschreven met `channels.slack.commands.native`. Tekstcommando’s vereisen losse `/...`-berichten en kunnen worden uitgeschakeld met `commands.text: false`. Slack slash commands worden in de Slack-app beheerd en niet automatisch verwijderd. Gebruik `commands.useAccessGroups: false` om access-group-controles voor commando’s te omzeilen.
- Volledige commandolijst + config: [Slash commands](/tools/slash-commands)

## DM-beveiliging (koppelen)

- Standaard: `channels.slack.dm.policy="pairing"` — onbekende DM-afzenders krijgen een koppelcode (verloopt na 1 uur).
- Goedkeuren via: `openclaw pairing approve slack <code>`.
- Om iedereen toe te staan: stel `channels.slack.dm.policy="open"` en `channels.slack.dm.allowFrom=["*"]` in.
- `channels.slack.dm.allowFrom` accepteert gebruikers-ID’s, @handles of e-mails (worden bij opstarten opgelost wanneer tokens dit toestaan). De wizard accepteert gebruikersnamen en zet ze tijdens de installatie om naar id’s wanneer tokens dit toestaan.

## Groepsbeleid

- `channels.slack.groupPolicy` regelt kanaalafhandeling (`open|disabled|allowlist`).
- `allowlist` vereist dat kanalen in `channels.slack.channels` worden vermeld.
- Als je alleen `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` instelt en nooit een `channels.slack`-sectie maakt,
  stelt de runtime standaard `groupPolicy` in op `open`. Voeg `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` of een kanaal-allowlist toe om het te vergrendelen.
- De configuratiewizard accepteert `#channel`-namen en zet ze waar mogelijk om naar ID’s
  (openbaar + privé); bij meerdere overeenkomsten heeft het actieve kanaal de voorkeur.
- Bij het opstarten zet OpenClaw kanaal-/gebruikersnamen in allowlists om naar ID’s (wanneer tokens dit toestaan)
  en logt de mapping; niet-opgeloste entries blijven zoals ingevoerd.
- Om **geen kanalen** toe te staan, stel `channels.slack.groupPolicy: "disabled"` in (of houd een lege allowlist aan).

Kanaalopties (`channels.slack.channels.<id>` of `channels.slack.channels.<name>`):

- `allow`: sta het kanaal toe/weiger het wanneer `groupPolicy="allowlist"`.
- `requireMention`: mention-gating voor het kanaal.
- `tools`: optionele per-kanaal tool-policy-overschrijvingen (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: optionele per-afzender tool-policy-overschrijvingen binnen het kanaal (sleutels zijn afzender-id’s/@handles/e-mails; `"*"`-wildcard ondersteund).
- `allowBots`: sta door de bot geschreven berichten toe in dit kanaal (standaard: false).
- `users`: optionele per-kanaal gebruikers-allowlist.
- `skills`: skill-filter (weglaten = alle Skills, leeg = geen).
- `systemPrompt`: extra systeemprompt voor het kanaal (gecombineerd met topic/doel).
- `enabled`: stel `false` in om het kanaal uit te schakelen.

## Doelbestemmingen voor levering

Gebruik deze met cron/CLI-verzendingen:

- `user:<id>` voor DM’s
- `channel:<id>` voor kanalen

## Toolacties

Slack-toolacties kunnen worden begrensd met `channels.slack.actions.*`:

| Actiegroep | Standaard    | Notities                             |
| ---------- | ------------ | ------------------------------------ |
| reactions  | ingeschakeld | Reageren + reacties lijst            |
| messages   | ingeschakeld | Lezen/verzenden/bewerken/verwijderen |
| pins       | ingeschakeld | Pinnen/ontpinnen/lijsten             |
| memberInfo | ingeschakeld | Lid informatie                       |
| emojiList  | ingeschakeld | Aangepaste emojilijst                |

## Beveiligingsnotities

- Schrijven gebruikt standaard het bot-token zodat statusveranderende acties
  binnen de bot-rechten en -identiteit van de app blijven.
- Het instellen van `userTokenReadOnly: false` staat toe dat het user token wordt gebruikt voor schrijf-
  bewerkingen wanneer geen bot-token beschikbaar is; acties draaien dan met de
  rechten van de installerende gebruiker. Behandel het user token als zeer
  geprivilegieerd en houd actiegates en allowlists strak.
- Als je user-token-schrijven inschakelt, zorg ervoor dat het user token de
  verwachte schrijfrechten bevat (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`), anders zullen die bewerkingen falen.

## Problemen oplossen

Doorloop eerst deze ladder:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Controleer daarna zo nodig de DM-koppelstatus:

```bash
openclaw pairing list slack
```

Veelvoorkomende fouten:

- Verbonden maar geen kanaalantwoorden: kanaal geblokkeerd door `groupPolicy` of niet in de `channels.slack.channels`-allowlist.
- DM’s genegeerd: afzender niet goedgekeurd wanneer `channels.slack.dm.policy="pairing"`.
- API-fouten (`missing_scope`, `not_in_channel`, authenticatiefouten): bot-/app-tokens of Slack-scopes zijn onvolledig.

Voor triageflow: [/channels/troubleshooting](/channels/troubleshooting).

## Notities

- Mention-gating wordt geregeld via `channels.slack.channels` (stel `requireMention` in op `true`); `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`) tellen ook als mentions.
- Multi-agent-override: stel per-agent patronen in op `agents.list[].groupChat.mentionPatterns`.
- Reactienotificaties volgen `channels.slack.reactionNotifications` (gebruik `reactionAllowlist` met modus `allowlist`).
- Door de bot geschreven berichten worden standaard genegeerd; schakel in via `channels.slack.allowBots` of `channels.slack.channels.<id>.allowBots`.
- Waarschuwing: als je antwoorden aan andere bots toestaat (`channels.slack.allowBots=true` of `channels.slack.channels.<id>.allowBots=true`), voorkom bot-tot-bot-antwoordlussen met `requireMention`, `channels.slack.channels.<id>.users`-allowlists en/of duidelijke guardrails in `AGENTS.md` en `SOUL.md`.
- Voor de Slack-tool staan de semantiek voor het verwijderen van reacties in [/tools/reactions](/tools/reactions).
- Bijlagen worden, wanneer toegestaan en onder de groottelimiet, gedownload naar de mediaopslag.
