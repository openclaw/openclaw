---
summary: "Slack-konfiguration för socket- eller HTTP-webhook-läge"
read_when: "Konfigurera Slack eller felsöka Slack socket/HTTP-läge"
title: "Slack"
---

# Slack

## Socket-läge (standard)

### Snabb konfigurering (nybörjare)

1. Skapa en Slack-app och aktivera **Socket Mode**.
2. Skapa en **App Token** (`xapp-...`) och **Bot Token** (`xoxb-...`).
3. Ange token för OpenClaw och starta gatewayen.

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

### Konfigurering

1. Skapa en Slack-app (From scratch) på [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Sockelläge** → växla på. Gå sedan till **Grundläggande information** → **App-Level Tokens** → **Generera token och omfattning** med scope `connections:write`. Kopiera **App Token** (`xapp-...`).
3. **OAuth & Behörigheter** → lägg till bot token scopes (använd manifestet nedan). Klicka **Installera till Workspace**. Kopiera **Bot User OAuth Token** (`xoxb-...`).
4. Valfritt: **OAuth & Permissions** → lägg till **Användartoken Scopes** (se listan nedan för skrivskydd). Installera om appen och kopiera **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → aktivera events och prenumerera på:
   - `message.*` (inkluderar redigeringar/borttagningar/trådsändningar)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Bjud in boten till kanaler som du vill att den ska läsa.
7. Slash kommandon → skapa `/openclaw` om du använder `channels.slack.slashCommand`. Om du aktiverar inbyggda kommandon, lägg till ett snedstreck kommando per inbyggt kommando (samma namn som `/help`). Native defaults to off for Slack if you set `channels.slack.commands.native: true` (global `commands.native` är `"auto"` som lämnar Slack av).
8. App Home → aktivera **Messages Tab** så att användare kan DM:a boten.

Använd manifestet nedan så att scopes och events hålls synkroniserade.

Stöd för flera konton: använd `channels.slack.accounts` med per-konto-token och valfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) för det delade mönstret.

### OpenClaw-konfig (Socket-läge)

Ange token via miljövariabler (rekommenderas):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Eller via konfig:

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

### Användartoken (valfritt)

OpenClaw kan använda en Slack användartoken (`xoxp-...`) för läsoperationer (historia,
pins, reaktioner, emoji, medlemsinfo). Som standard förblir detta skrivskyddad: läser
föredrar användaren token när närvarande, och skriver fortfarande använda bot token om inte
du uttryckligen väljer in. Även med `userTokenReadOnly: false`, bottoken förblir
föredras för skriver när den är tillgänglig.

Användartokens är konfigurerade i konfigurationsfilen (ingen env var support). För
multi-konto, ange `channels.slack.accounts.<id>.userToken`.

Exempel med bot + app + användartoken:

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

Exempel med userTokenReadOnly explicit satt (tillåt skrivningar med användartoken):

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

#### Tokenanvändning

- Läsoperationer (historik, reaktionslista, nållista, emojilista, medlemsinfo,
  sökning) föredrar användartoken när den är konfigurerad, annars bot-token.
- Skriv operationer (send/edit/delete messages, add/remove reactions, pin/unpin,
  file uploads) använd bot-token som standard. Om `userTokenReadOnly: false` och
  finns ingen bot token tillgänglig, faller OpenClaw tillbaka till användartoken.

### Historikkontext

- `channels.slack.historyLimit` (eller `channels.slack.accounts.*.historyLimit`) styr hur många senaste kanal-/gruppmeddelanden som bäddas in i prompten.
- Faller tillbaka till `messages.groupChat.historyLimit`. Sätt `0` till att inaktivera (standard 50).

## HTTP-läge (Events API)

Använd HTTP webhook-läge när din Gateway kan nås av Slack över HTTPS (typiskt för serverdistributioner).
HTTP-läge använder Händelser API + Interactivity + Slash kommandon med en delad begäran URL.

### Konfigurering (HTTP-läge)

1. Skapa en Slack-app och **inaktivera Socket Mode** (valfritt om du endast använder HTTP).
2. **Basic Information** → kopiera **Signing Secret**.
3. **OAuth & Permissions** → installera appen och kopiera **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → aktivera events och sätt **Request URL** till din gateways webhook-sökväg (standard `/slack/events`).
5. **Interactivity & Shortcuts** → aktivera och sätt samma **Request URL**.
6. **Slash Commands** → sätt samma **Request URL** för dina kommando(n).

Exempel på request-URL:
`https://gateway-host/slack/events`

### OpenClaw-konfig (minimal)

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

Multi-konto HTTP-läge: sätt `channels.slack.accounts.<id>.mode = "http"` och ge en unik
`webhookPath` per konto så att varje Slack app kan peka på sin egen URL.

### Manifest (valfritt)

Använd denna Slack app manifest för att skapa appen snabbt (justera namnet/kommandot om du vill). Inkludera
användarens omfattning om du planerar att konfigurera en användartoken.

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

Om du aktiverar inhemska kommandon, lägg till en `slash_commands`-post per kommando som du vill avslöja (matchar listan` /help`). Åsidosätt med `channels.slack.commands.native`.

## Scopes (aktuella vs valfria)

Slack's Conversations API är typ-scoped: du behöver bara omfattningen för de
konversationstyper du faktiskt rör (kanaler, grupper, im, mpim). Se
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) för översikten.

### Bot-token-scopes (krävs)

- `chat:write` (skicka/uppdatera/ta bort meddelanden via `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (öppna DM via `conversations.open` för användar-DM)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (användaruppslag)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (uppladdningar via `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### Användartoken-scopes (valfritt, skrivskyddat som standard)

Lägg till dessa under **User Token Scopes** om du konfigurerar `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Inte behövda idag (men sannolikt i framtiden)

- `mpim:write` (endast om vi lägger till öppning av grupp-DM/DM-start via `conversations.open`)
- `groups:write` (endast om vi lägger till hantering av privata kanaler: skapa/byt namn/bjud in/arkivera)
- `chat:write.public` (endast om vi vill posta till kanaler som boten inte är med i)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (endast om vi behöver e-postfält från `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (endast om vi börjar lista/läsa filmetadata)

## Konfig

Slack använder endast Socket Mode (ingen HTTP webhook server). Ge båda tokens:

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

Token kan också anges via miljövariabler:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Ack reaktioner kontrolleras globalt via `messages.ackReaction` +
`messages.ackReactionScope`. Använd `messages.removeAckAfterReply` för att rensa
ack-reaktionen efter att botten svarat.

## Begränsningar

- Utgående text delas upp i `channels.slack.textChunkLimit` (standard 4000).
- Valfri radbrytningsuppdelning: sätt `channels.slack.chunkMode="newline"` för att dela på tomrader (styckegränser) före längduppdelning.
- Mediauppladdningar begränsas av `channels.slack.mediaMaxMb` (standard 20).

## Svarstrådning

Som standard svarar OpenClaw i huvudkanalen. Använd `channels.slack.replyToMode` för att styra automatisk trådning:

| Läge    | Beteende                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Standard.** Svara i huvudkanalen. Endast tråd om det utlösande meddelandet redan fanns i en tråd.                                                                                     |
| `first` | Första svaret går till tråden (under det utlösande meddelandet), följande svar går till huvudkanalen. Användbart för att hålla kontexten synlig samtidigt som trådens skräp undviks. |
| `all`   | Alla svar går till tråden. Håller konversationer innehöll men kan minska synligheten.                                                                                                                   |

Läget gäller både autosvar och agentverktygsanrop (`slack sendMessage`).

### Trådning per chatttyp

Du kan konfigurera olika trådningsbeteenden per chatttyp genom att sätta `channels.slack.replyToModeByChatType`:

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

Stödda chatttyper:

- `direct`: 1:1-DM (Slack `im`)
- `group`: grupp-DM / MPIM (Slack `mpim`)
- `channel`: standardkanaler (offentliga/privata)

Prioritet:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Leverantörens standard (`off`)

Äldre `channels.slack.dm.replyToMode` accepteras fortfarande som fallback för `direct` när ingen chatttyp-åsidosättning är satt.

Exempel:

Tråda endast DM:

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

Tråda grupp-DM men behåll kanaler i roten:

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

Gör kanaler till trådar, behåll DM i roten:

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

### Manuella trådtaggar

För finmaskig kontroll, använd dessa taggar i agentsvar:

- `[[reply_to_current]]` — svara på det utlösande meddelandet (starta/fortsätt tråd).
- `[[reply_to:<id>]]` — svara på ett specifikt meddelande-ID.

## Sessioner + routning

- DM delar `main`-sessionen (som WhatsApp/Telegram).
- Kanaler mappar till `agent:<agentId>:slack:channel:<channelId>`-sessioner.
- Slash-kommandon använder `agent:<agentId>:slack:slash:<userId>`-sessioner (prefix konfigurerbart via `channels.slack.slashCommand.sessionPrefix`).
- Om Slack inte tillhandahåller `channel_type`, härleder OpenClaw den från kanal-ID-prefix (`D`, `C`, `G`) och använder som standard `channel` för att hålla sessionsnycklar stabila.
- Inhemsk kommandoregistrering använder `commands.native` (global default `"auto"` → Slack off) och kan åsidosättas per-workspace med `channels.slack.commands.native`. Textkommandon kräver fristående `/...` meddelanden och kan inaktiveras med `commands.text: false`. Slack snedstreck kommandon hanteras i Slack appen och tas inte bort automatiskt. Använd `commands.useAccessGroups: false` för att förbigå access-gruppskontroller efter kommandon.
- Fullständig kommandolista + konfig: [Slash commands](/tools/slash-commands)

## DM-säkerhet (parning)

- Standard: `channels.slack.dm.policy="pairing"` — okända DM-avsändare får en parningskod (löper ut efter 1 timme).
- Godkänn via: `openclaw pairing approve slack <code>`.
- För att tillåta alla: sätt `channels.slack.dm.policy="open"` och `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` accepterar användar-ID, @handles, eller e-post (lösas vid start när tokens tillåts). Guiden accepterar användarnamn och löser dem till ids under installationen när tokens tillåter.

## Gruppolicy

- `channels.slack.groupPolicy` styr kanalhantering (`open|disabled|allowlist`).
- `allowlist` kräver att kanaler listas i `channels.slack.channels`.
- Om du bara anger `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` och aldrig skapar en `channels.slack` sektion,
  runtime defaults `groupPolicy` till `open`. Lägg till `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, eller en kanal tillåten lista för att låsa ner den.
- Konfigureringsguiden accepterar `#channel`-namn och löser dem till ID:n när möjligt
  (offentliga + privata); om flera träffar finns föredras den aktiva kanalen.
- Vid start löser OpenClaw kanal-/användarnamn i tillåtelselistor till ID:n (när token tillåter)
  och loggar mappningen; olösta poster behålls som inmatade.
- För att tillåta **inga kanaler**, sätt `channels.slack.groupPolicy: "disabled"` (eller behåll en tom tillåtelselista).

Kanalalternativ (`channels.slack.channels.<id>` eller `channels.slack.channels.<name>`):

- `allow`: tillåt/nekad kanalen när `groupPolicy="allowlist"`.
- `requireMention`: omnämnandespärr för kanalen.
- `tools`: valfria verktygspolicy-åsidosättningar per kanal (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: valfria verktygspolicy-åsidosättningar per avsändare inom kanalen (nycklar är avsändar-ID:n/@handles/e-post; jokertecknet `"*"` stöds).
- `allowBots`: tillåt bot-skapade meddelanden i denna kanal (standard: false).
- `users`: valfri användar-tillåtelselista per kanal.
- `skills`: färdighetsfilter (utelämna = alla Skills, tom = inga).
- `systemPrompt`: extra systemprompt för kanalen (kombineras med ämne/syfte).
- `enabled`: sätt `false` för att inaktivera kanalen.

## Leveransmål

Använd dessa med cron/CLI-utskick:

- `user:<id>` för DM
- `channel:<id>` för kanaler

## Verktygsåtgärder

Slack-verktygsåtgärder kan spärras med `channels.slack.actions.*`:

| Åtgärdsgrupp | Standard | Noteringar                  |
| ------------ | -------- | --------------------------- |
| reactions    | enabled  | Reagera + lista reaktioner  |
| messages     | enabled  | Läs/skicka/redigera/ta bort |
| pins         | enabled  | Nåla/avnåla/lista           |
| memberInfo   | enabled  | Medlemsinfo                 |
| emojiList    | enabled  | Anpassad emojilista         |

## Säkerhetsnoteringar

- Skrivningar använder som standard bot-token så att tillståndsändrande åtgärder hålls inom
  appens botbehörigheter och identitet.
- Ställa in `userTokenReadOnly: false` låter användaren token användas för att skriva
  operationer när en bot token inte är tillgänglig, vilket innebär åtgärder som körs med att
  installera användarens åtkomst. Behandla användartoken som mycket privilegierad och håll
  åtgärdsgrindar och tillåt listor strama.
- Om du aktiverar skrivningar med användartoken, säkerställ att användartoken inkluderar de skriv-
  scopes du förväntar dig (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) annars kommer dessa operationer att misslyckas.

## Felsökning

Kör denna stege först:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Bekräfta sedan DM-parningsstatus vid behov:

```bash
openclaw pairing list slack
```

Vanliga fel:

- Ansluten men inga kanalsvar: kanal blockerad av `groupPolicy` eller inte i `channels.slack.channels`-tillåtelselistan.
- DM ignoreras: avsändaren inte godkänd när `channels.slack.dm.policy="pairing"`.
- API-fel (`missing_scope`, `not_in_channel`, autentiseringsfel): bot-/app-token eller Slack-scopes är ofullständiga.

För triage-flöde: [/channels/troubleshooting](/channels/troubleshooting).

## Noteringar

- Omnämnandespärr styrs via `channels.slack.channels` (sätt `requireMention` till `true`); `agents.list[].groupChat.mentionPatterns` (eller `messages.groupChat.mentionPatterns`) räknas också som omnämnanden.
- Multi-agent-åsidosättning: sätt per-agent-mönster på `agents.list[].groupChat.mentionPatterns`.
- Reaktionsnotifieringar följer `channels.slack.reactionNotifications` (använd `reactionAllowlist` med läge `allowlist`).
- Bot-författade meddelanden ignoreras som standard; aktivera via `channels.slack.allowBots` eller `channels.slack.channels.<id>.allowBots`.
- Varning: Om du tillåter svar på andra robotar (`channels.slack.allowBots=true` eller `channels.slack.channels.<id>.allowBots=true`), förhindra bot-to-bot svarsloopar med `requireMention`, `channels.slack.channels.<id>.users` tillåter listor, och/eller klara skyddsräcken i `AGENTS.md` och `SOUL.md`.
- För Slack-verktyget finns semantiken för borttagning av reaktioner i [/tools/reactions](/tools/reactions).
- Bilagor laddas ned till medielagret när det är tillåtet och under storleksgränsen.
