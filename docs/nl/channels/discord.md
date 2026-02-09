---
summary: "Status van Discord-botondersteuning, mogelijkheden en configuratie"
read_when:
  - Werken aan functies voor het Discord-kanaal
title: "Discord"
---

# Discord (Bot API)

Status: klaar voor DM’s en tekstkanalen in servers via de officiële Discord-botgateway.

## Snelle installatie (beginner)

1. Maak een Discord-bot en kopieer de bot-token.
2. Schakel in de instellingen van de Discord-app **Message Content Intent** in (en **Server Members Intent** als je toegestane lijsten of naamopzoekingen wilt gebruiken).
3. Stel de token in voor OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Of config: `channels.discord.token: "..."`.
   - Als beide zijn ingesteld, heeft config voorrang (env-terugval is alleen voor het standaardaccount).
4. Nodig de bot uit op je server met berichtenrechten (maak een privésserver als je alleen DM’s wilt).
5. Start de Gateway.
6. DM-toegang is standaard gekoppeld; keur de koppelcode goed bij het eerste contact.

Minimale config:

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

## Doelen

- Praten met OpenClaw via Discord-DM’s of serverkanalen.
- Directe chats worden samengevoegd in de hoofdsessie van de agent (standaard `agent:main:main`); serverkanalen blijven geïsoleerd als `agent:<agentId>:discord:channel:<channelId>` (weergavenamen gebruiken `discord:<guildSlug>#<channelSlug>`).
- Groeps-DM’s worden standaard genegeerd; inschakelen via `channels.discord.dm.groupEnabled` en optioneel beperken met `channels.discord.dm.groupChannels`.
- Routering deterministisch houden: antwoorden gaan altijd terug naar het kanaal waarop ze zijn binnengekomen.

## Hoe het werkt

1. Maak een Discord-applicatie → Bot, schakel de benodigde intents in (DM’s + serverberichten + berichtinhoud) en pak de bot-token.
2. Nodig de bot uit op je server met de rechten om berichten te lezen/verzenden waar je hem wilt gebruiken.
3. Configureer OpenClaw met `channels.discord.token` (of `DISCORD_BOT_TOKEN` als terugval).
4. Start de Gateway; deze start automatisch het Discord-kanaal wanneer een token beschikbaar is (eerst config, env als terugval) en `channels.discord.enabled` niet `false` is.
   - Als je env-vars verkiest, stel `DISCORD_BOT_TOKEN` in (een configblok is optioneel).
5. Directe chats: gebruik `user:<id>` (of een `<@id>`-vermelding) bij het afleveren; alle beurten komen in de gedeelde `main`-sessie terecht. Kale numerieke ID’s zijn dubbelzinnig en worden geweigerd.
6. Serverkanalen: gebruik `channel:<channelId>` voor aflevering. Vermeldingen zijn standaard vereist en kunnen per server of per kanaal worden ingesteld.
7. Directe chats: standaard beveiligd via `channels.discord.dm.policy` (standaard: `"pairing"`). Onbekende afzenders krijgen een koppelcode (verloopt na 1 uur); keur goed via `openclaw pairing approve discord <code>`.
   - Om het oude “open voor iedereen”-gedrag te behouden: stel `channels.discord.dm.policy="open"` en `channels.discord.dm.allowFrom=["*"]` in.
   - Voor een harde toegestane lijst: stel `channels.discord.dm.policy="allowlist"` in en vermeld afzenders in `channels.discord.dm.allowFrom`.
   - Om alle DM’s te negeren: stel `channels.discord.dm.enabled=false` of `channels.discord.dm.policy="disabled"` in.
8. Groeps-DM’s worden standaard genegeerd; inschakelen via `channels.discord.dm.groupEnabled` en optioneel beperken met `channels.discord.dm.groupChannels`.
9. Optionele serverregels: stel `channels.discord.guilds` in, gesleuteld op server-id (voorkeur) of slug, met regels per kanaal.
10. Optionele native opdrachten: `commands.native` staat standaard op `"auto"` (aan voor Discord/Telegram, uit voor Slack). Overschrijf met `channels.discord.commands.native: true|false|"auto"`; `false` wist eerder geregistreerde opdrachten. Tekstopdrachten worden geregeld door `commands.text` en moeten als zelfstandige `/...`-berichten worden verzonden. Gebruik `commands.useAccessGroups: false` om toegangscontrole voor opdrachten te omzeilen.
    - Volledige opdrachtenlijst + config: [Slash commands](/tools/slash-commands)
11. Optionele servercontextgeschiedenis: stel `channels.discord.historyLimit` in (standaard 20, valt terug op `messages.groupChat.historyLimit`) om de laatste N serverberichten als context mee te nemen bij het antwoorden op een vermelding. Stel `0` in om uit te schakelen.
12. Reacties: de agent kan reacties activeren via de `discord`-tool (afgeschermd door `channels.discord.actions.*`).
    - Semantiek voor het verwijderen van reacties: zie [/tools/reactions](/tools/reactions).
    - De `discord`-tool wordt alleen beschikbaar gesteld wanneer het huidige kanaal Discord is.
13. Native opdrachten gebruiken geïsoleerde sessiesleutels (`agent:<agentId>:discord:slash:<userId>`) in plaats van de gedeelde `main`-sessie.

Let op: Naam → id-resolutie gebruikt zoeken naar serverleden en vereist Server Members Intent; als de bot geen leden kan doorzoeken, gebruik id’s of `<@id>`-vermeldingen.
Let op: Slugs zijn lowercase met spaties vervangen door `-`. Kanaalnamen worden geslugged zonder de leidende `#`.
Let op: Servercontext-`[from:]`-regels bevatten `author.tag` + `id` om ping-klare antwoorden te vergemakkelijken.

## Config-wegschrijvingen

Standaard mag Discord config-updates wegschrijven die worden getriggerd door `/config set|unset` (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Je eigen bot maken

Dit is de installatie in het “Discord Developer Portal” voor het draaien van OpenClaw in een serverkanaal zoals `#help`.

### 1. Maak de Discord-app + botgebruiker

1. Discord Developer Portal → **Applications** → **New Application**
2. In je app:
   - **Bot** → **Add Bot**
   - Kopieer de **Bot Token** (dit is wat je invult in `DISCORD_BOT_TOKEN`)

### 2) Schakel de gateway-intents in die OpenClaw nodig heeft

Discord blokkeert “privileged intents” tenzij je ze expliciet inschakelt.

In **Bot** → **Privileged Gateway Intents**, schakel in:

- **Message Content Intent** (vereist om berichttekst te lezen in de meeste servers; zonder dit zie je “Used disallowed intents” of verbindt de bot maar reageert niet op berichten)
- **Server Members Intent** (aanbevolen; vereist voor sommige lid-/gebruikersopzoekingen en het matchen van toegestane lijsten in servers)

Je hebt **Presence Intent** meestal **niet** nodig. Het instellen van de eigen aanwezigheid van de bot (actie `setPresence`) gebruikt gateway OP3 en vereist deze intent niet; deze is alleen nodig als je aanwezigheidupdates van andere serverleden wilt ontvangen.

### 3. Genereer een uitnodigings-URL (OAuth2 URL Generator)

In je app: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (vereist voor native opdrachten)

**Bot Permissions** (minimale basis)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (optioneel maar aanbevolen)
- ✅ Use External Emojis / Stickers (optioneel; alleen als je ze wilt)

Vermijd **Administrator** tenzij je aan het debuggen bent en de bot volledig vertrouwt.

Kopieer de gegenereerde URL, open deze, kies je server en installeer de bot.

### 4. Verkrijg de id’s (server/gebruiker/kanaal)

Discord gebruikt overal numerieke id’s; OpenClaw-config verkiest id’s.

1. Discord (desktop/web) → **User Settings** → **Advanced** → schakel **Developer Mode** in
2. Rechtsklik:
   - Servernaam → **Copy Server ID** (server-id)
   - Kanaal (bijv. `#help`) → **Copy Channel ID**
   - Je gebruiker → **Copy User ID**

### 5) Configureer OpenClaw

#### Token

Stel de bot-token in via env-var (aanbevolen op servers):

- `DISCORD_BOT_TOKEN=...`

Of via config:

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

Ondersteuning voor meerdere accounts: gebruik `channels.discord.accounts` met per-account tokens en optioneel `name`. Zie [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) voor het gedeelde patroon.

#### Toegestane lijst + kanaalroutering

Voorbeeld “één server, alleen ik toestaan, alleen #help toestaan”:

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

Notities:

- `requireMention: true` betekent dat de bot alleen antwoordt wanneer hij wordt vermeld (aanbevolen voor gedeelde kanalen).
- `agents.list[].groupChat.mentionPatterns` (of `messages.groupChat.mentionPatterns`) tellen ook als vermeldingen voor serverberichten.
- Multi-agent-override: stel per-agent patronen in op `agents.list[].groupChat.mentionPatterns`.
- Als `channels` aanwezig is, wordt elk kanaal dat niet is vermeld standaard geweigerd.
- Gebruik een `"*"`-kanaalingang om standaardwaarden toe te passen op alle kanalen; expliciete kanaalingangen overschrijven de wildcard.
- Threads erven de configuratie van het bovenliggende kanaal (toegestane lijst, `requireMention`, Skills, prompts, enz.) tenzij je de thread-kanaal-id expliciet toevoegt.
- Eigenaars-hint: wanneer een per-server of per-kanaal `users`-toegestane lijst overeenkomt met de afzender, behandelt OpenClaw die afzender als de eigenaar in de systeemprompt. Voor een globale eigenaar over kanalen heen, stel `commands.ownerAllowFrom` in.
- Door de bot geschreven berichten worden standaard genegeerd; stel `channels.discord.allowBots=true` in om ze toe te staan (eigen berichten blijven gefilterd).
- Waarschuwing: als je antwoorden op andere bots toestaat (`channels.discord.allowBots=true`), voorkom bot-tot-bot-antwoordlussen met `requireMention`, `channels.discord.guilds.*.channels.<id>.users`-toegestane lijsten en/of door guardrails te wissen in `AGENTS.md` en `SOUL.md`.

### 6. Verifieer dat het werkt

1. Start de Gateway.
2. Stuur in je serverkanaal: `@Krill hello` (of wat je botnaam ook is).
3. Als er niets gebeurt: controleer **Problemen oplossen** hieronder.

### Problemen oplossen

- Eerst: voer `openclaw doctor` en `openclaw channels status --probe` uit (actiegerichte waarschuwingen + snelle audits).
- **“Used disallowed intents”**: schakel **Message Content Intent** (en waarschijnlijk **Server Members Intent**) in het Developer Portal in en start daarna de Gateway opnieuw.
- **Bot verbindt maar antwoordt nooit in een serverkanaal**:
  - Ontbrekende **Message Content Intent**, of
  - De bot mist kanaalrechten (View/Send/Read History), of
  - Je config vereist vermeldingen en je hebt die niet gebruikt, of
  - Je server-/kanaaltoegestane lijst weigert het kanaal/de gebruiker.
- **`requireMention: false` maar nog steeds geen antwoorden**:
- `channels.discord.groupPolicy` staat standaard op **allowlist**; stel het in op `"open"` of voeg een serververmelding toe onder `channels.discord.guilds` (optioneel kanalen opsommen onder `channels.discord.guilds.<id>.channels` om te beperken).
  - Als je alleen `DISCORD_BOT_TOKEN` instelt en nooit een `channels.discord`-sectie maakt, stelt de runtime
    `groupPolicy` standaard in op `open`. Voeg `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy` of een server-/kanaaltoegestane lijst toe om het af te schermen.
- `requireMention` moet onder `channels.discord.guilds` staan (of een specifiek kanaal). `channels.discord.requireMention` op het hoogste niveau wordt genegeerd.
- **Rechtenaudits** (`channels status --probe`) controleren alleen numerieke kanaal-id’s. Als je slugs/namen gebruikt als `channels.discord.guilds.*.channels`-sleutels, kan de audit de rechten niet verifiëren.
- **DM’s werken niet**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, of je bent nog niet goedgekeurd (`channels.discord.dm.policy="pairing"`).
- **Uitvoeringsgoedkeuringen in Discord**: Discord ondersteunt een **knop-UI** voor uitvoeringsgoedkeuringen in DM’s (Eenmalig toestaan / Altijd toestaan / Weigeren). `/approve <id> ...` is alleen voor doorgestuurde goedkeuringen en zal de knopprompts van Discord niet oplossen. Als je `❌ Failed to submit approval: Error: unknown approval id` ziet of de UI nooit verschijnt, controleer:
  - `channels.discord.execApprovals.enabled: true` in je config.
  - Of je Discord-gebruikers-id in `channels.discord.execApprovals.approvers` staat (de UI wordt alleen naar goedkeurders gestuurd).
  - Gebruik de knoppen in de DM-prompt (**Eenmalig toestaan**, **Altijd toestaan**, **Weigeren**).
  - Zie [Exec approvals](/tools/exec-approvals) en [Slash commands](/tools/slash-commands) voor de bredere goedkeurings- en opdrachtflow.

## Mogelijkheden & beperkingen

- DM’s en tekstkanalen in servers (threads worden als aparte kanalen behandeld; voice wordt niet ondersteund).
- Typindicatoren worden best-effort verzonden; berichtopdeling gebruikt `channels.discord.textChunkLimit` (standaard 2000) en splitst lange antwoorden op regelaantal (`channels.discord.maxLinesPerMessage`, standaard 17).
- Optionele alinea-opdeling: stel `channels.discord.chunkMode="newline"` in om te splitsen op lege regels (alinea-grenzen) vóór lengte-opdeling.
- Uploads van bestanden worden ondersteund tot de geconfigureerde `channels.discord.mediaMaxMb` (standaard 8 MB).
- Antwoorden in servers zijn standaard vermeldings-afgeschermd om lawaaierige bots te vermijden.
- Antwoordcontext wordt geïnjecteerd wanneer een bericht naar een ander bericht verwijst (geciteerde inhoud + id’s).
- Native antwoord-threading staat **standaard uit**; schakel in met `channels.discord.replyToMode` en reply-tags.

## Herhaalbeleid

Uitgaande Discord-API-aanroepen herhalen bij rate limits (429) met Discord `retry_after` waar beschikbaar, met exponentiële backoff en jitter. Configureer via `channels.discord.retry`. Zie [Retry policy](/concepts/retry).

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

Ack-reacties worden globaal geregeld via `messages.ackReaction` +
`messages.ackReactionScope`. Gebruik `messages.removeAckAfterReply` om de
ack-reactie te verwijderen nadat de bot heeft geantwoord.

- `dm.enabled`: stel `false` in om alle DM’s te negeren (standaard `true`).
- `dm.policy`: DM-toegangsbeheer (`pairing` aanbevolen). `"open"` vereist `dm.allowFrom=["*"]`.
- `dm.allowFrom`: DM-toegestane lijst (gebruikers-id’s of namen). Gebruikt door `dm.policy="allowlist"` en voor `dm.policy="open"`-validatie. De wizard accepteert gebruikersnamen en lost ze op naar id’s wanneer de bot leden kan doorzoeken.
- `dm.groupEnabled`: groeps-DM’s inschakelen (standaard `false`).
- `dm.groupChannels`: optionele toegestane lijst voor groeps-DM-kanaal-id’s of slugs.
- `groupPolicy`: regelt de afhandeling van serverkanalen (`open|disabled|allowlist`); `allowlist` vereist kanaaltoegestane lijsten.
- `guilds`: per-serverregels gesleuteld op server-id (voorkeur) of slug.
- `guilds."*"`: standaard per-serverinstellingen die worden toegepast wanneer geen expliciete vermelding bestaat.
- `guilds.<id>.slug`: optionele vriendelijke slug voor weergavenamen.
- `guilds.<id>.users`: optionele per-servergebruikers-toegestane lijst (id’s of namen).
- `guilds.<id>.tools`: optionele per-server toolbeleid-overschrijvingen (`allow`/`deny`/`alsoAllow`) gebruikt wanneer de kanaaloverschrijving ontbreekt.
- `guilds.<id>.toolsBySender`: optionele per-afzender toolbeleid-overschrijvingen op serverniveau (van toepassing wanneer de kanaaloverschrijving ontbreekt; `"*"`-wildcard ondersteund).
- `guilds.<id>.channels.<channel>.allow`: sta het kanaal toe/weiger wanneer `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: vermelding-afscherming voor het kanaal.
- `guilds.<id>.channels.<channel>.tools`: optionele per-kanaal toolbeleid-overschrijvingen (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: optionele per-afzender toolbeleid-overschrijvingen binnen het kanaal (`"*"`-wildcard ondersteund).
- `guilds.<id>.channels.<channel>.users`: optionele per-kanaal gebruikers-toegestane lijst.
- `guilds.<id>.channels.<channel>.skills`: skillfilter (weglaten = alle Skills, leeg = geen).
- `guilds.<id>.channels.<channel>.systemPrompt`: extra systeemprompt voor het kanaal. Discord-kanaaltopics worden als **onbetrouwbare** context geïnjecteerd (niet als systeemprompt).
- `guilds.<id>.channels.<channel>.enabled`: stel `false` in om het kanaal uit te schakelen.
- `guilds.<id>.channels`: kanaalregels (sleutels zijn kanaalslugs of id’s).
- `guilds.<id>.requireMention`: per-server vermeldingseis (overschrijfbaar per kanaal).
- `guilds.<id>.reactionNotifications`: reactiestelsel-gebeurtenismodus (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: uitgaande tekst-chunkgrootte (tekens). Standaard: 2000.
- `chunkMode`: `length` (standaard) splitst alleen bij overschrijden van `textChunkLimit`; `newline` splitst op lege regels (alinea-grenzen) vóór lengte-opdeling.
- `maxLinesPerMessage`: zachte maximale regellimiet per bericht. Standaard: 17.
- `mediaMaxMb`: begrens inkomende media die op schijf worden opgeslagen.
- `historyLimit`: aantal recente serverberichten om als context mee te nemen bij het antwoorden op een vermelding (standaard 20; valt terug op `messages.groupChat.historyLimit`; `0` schakelt uit).
- `dmHistoryLimit`: DM-geschiedenislimeit in gebruikersbeurten. Per-gebruiker-overschrijvingen: `dms["<user_id>"].historyLimit`.
- `retry`: herhaalbeleid voor uitgaande Discord-API-aanroepen (pogingen, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: los PluralKit-geproxiede berichten op zodat systeemleden als afzonderlijke afzenders verschijnen.
- `actions`: per-actie tool-afschermingen; weglaten om alles toe te staan (stel `false` in om uit te schakelen).
  - `reactions` (dekt reageren + reacties lezen)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (kanalen + categorieën + rechten maken/bewerken/verwijderen)
  - `roles` (rollen toevoegen/verwijderen, standaard `false`)
  - `moderation` (timeout/kick/ban, standaard `false`)
  - `presence` (botstatus/-activiteit, standaard `false`)
- `execApprovals`: Discord-specifieke uitvoeringsgoedkeurings-DM’s (knop-UI). Ondersteunt `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Reactiemeldingen gebruiken `guilds.<id>.reactionNotifications`:

- `off`: geen reactiegebeurtenissen.
- `own`: reacties op de eigen berichten van de bot (standaard).
- `all`: alle reacties op alle berichten.
- `allowlist`: reacties van `guilds.<id>.users` op alle berichten (lege lijst schakelt uit).

### PluralKit (PK)-ondersteuning

Schakel PK-opzoekingen in zodat geproxiede berichten worden opgelost naar het onderliggende systeem + lid.
Wanneer ingeschakeld gebruikt OpenClaw de lididentiteit voor toegestane lijsten en labelt de
afzender als `Member (PK:System)` om onbedoelde Discord-pings te voorkomen.

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

Notities bij toegestane lijsten (PK ingeschakeld):

- Gebruik `pk:<memberId>` in `dm.allowFrom`, `guilds.<id>.users` of per-kanaal `users`.
- Weergavenamen van leden worden ook gematcht op naam/slug.
- Opzoekingen gebruiken de **oorspronkelijke** Discord-bericht-id (het pre-proxy-bericht), zodat
  de PK-API dit alleen binnen zijn venster van 30 minuten kan oplossen.
- Als PK-opzoekingen mislukken (bijv. privé-systeem zonder token), worden geproxiede berichten
  behandeld als botberichten en verworpen tenzij `channels.discord.allowBots=true`.

### Standaarden voor toolacties

| Actiegroep     | Standaard     | Notities                                               |
| -------------- | ------------- | ------------------------------------------------------ |
| reactions      | ingeschakeld  | Reageren + reacties tonen + emojiList                  |
| stickers       | ingeschakeld  | Stickers verzenden                                     |
| emojiUploads   | ingeschakeld  | Emoji’s uploaden                                       |
| stickerUploads | ingeschakeld  | Stickers uploaden                                      |
| polls          | ingeschakeld  | Polls maken                                            |
| permissions    | ingeschakeld  | Snapshot van kanaalrechten                             |
| messages       | ingeschakeld  | Lezen/verzenden/bewerken/verwijderen                   |
| threads        | ingeschakeld  | Maken/lijsten/antwoorden                               |
| pins           | ingeschakeld  | Vastzetten/losmaken/lijsten                            |
| search         | ingeschakeld  | Berichten zoeken (previewfunctie)   |
| memberInfo     | ingeschakeld  | Lid informatie                                         |
| roleInfo       | ingeschakeld  | Rollenlijst                                            |
| channelInfo    | ingeschakeld  | Kanaalinformatie + lijst                               |
| channels       | ingeschakeld  | Kanaal-/categoriebeheer                                |
| voiceStatus    | ingeschakeld  | Voice-status opzoeken                                  |
| events         | ingeschakeld  | Geplande events tonen/maken                            |
| roles          | uitgeschakeld | Rollen toevoegen/verwijderen                           |
| moderation     | uitgeschakeld | Timeout/kick/ban                                       |
| presence       | uitgeschakeld | Botstatus/-activiteit (setPresence) |

- `replyToMode`: `off` (standaard), `first` of `all`. Geldt alleen wanneer het model een reply-tag bevat.

## Reply-tags

Om een antwoord in een thread te vragen, kan het model één tag in zijn uitvoer opnemen:

- `[[reply_to_current]]` — antwoord op het triggerende Discord-bericht.
- `[[reply_to:<id>]]` — antwoord op een specifieke bericht-id uit context/geschiedenis.
  Huidige bericht-id’s worden aan prompts toegevoegd als `[message_id: …]`; geschiedenisvermeldingen bevatten al id’s.

Gedrag wordt geregeld door `channels.discord.replyToMode`:

- `off`: tags negeren.
- `first`: alleen de eerste uitgaande chunk/bijlage is een antwoord.
- `all`: elke uitgaande chunk/bijlage is een antwoord.

Notities bij het matchen van toegestane lijsten:

- `allowFrom`/`users`/`groupChannels` accepteren id’s, namen, tags of vermeldingen zoals `<@id>`.
- Prefixen zoals `discord:`/`user:` (gebruikers) en `channel:` (groeps-DM’s) worden ondersteund.
- Gebruik `*` om elke afzender/elk kanaal toe te staan.
- Wanneer `guilds.<id>.channels` aanwezig is, worden niet-vermelde kanalen standaard geweigerd.
- Wanneer `guilds.<id>.channels` ontbreekt, zijn alle kanalen in de toegestane server toegestaan.
- Om **geen kanalen** toe te staan, stel `channels.discord.groupPolicy: "disabled"` in (of houd een lege toegestane lijst).
- De configuratiewizard accepteert `Guild/Channel`-namen (publiek + privé) en lost ze waar mogelijk op naar id’s.
- Bij het opstarten lost OpenClaw kanaal-/gebruikersnamen in toegestane lijsten op naar id’s (wanneer de bot leden kan doorzoeken)
  en logt de mapping; niet-opgeloste items blijven zoals ingevoerd.

Notities bij native opdrachten:

- De geregistreerde opdrachten weerspiegelen de chatopdrachten van OpenClaw.
- Native opdrachten respecteren dezelfde toegestane lijsten als DM’s/serverberichten (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, per-kanaalregels).
- Slash-commando’s kunnen in de Discord-UI zichtbaar blijven voor gebruikers die niet op de toegestane lijst staan; OpenClaw handhaaft de toegestane lijsten bij uitvoering en antwoordt met “niet geautoriseerd”.

## Toolacties

De agent kan `discord` aanroepen met acties zoals:

- `react` / `reactions` (reacties toevoegen of tonen)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Lees-/zoek-/pin-toolpayloads bevatten genormaliseerde `timestampMs` (UTC-epoch ms) en `timestampUtc` naast ruwe Discord `timestamp`.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (botactiviteit en online status)

Discord-bericht-id’s worden zichtbaar gemaakt in de geïnjecteerde context (`[discord message id: …]` en geschiedenisregels) zodat de agent ze kan targeten.
Emoji kunnen unicode zijn (bijv. `✅`) of aangepaste emoji-syntaxis zoals `<:party_blob:1234567890>`.

## Veiligheid & beheer

- Behandel de bot-token als een wachtwoord; geef de voorkeur aan de `DISCORD_BOT_TOKEN` env-var op beheerde hosts of vergrendel de bestandsrechten van de config.
- Geef de bot alleen de rechten die hij nodig heeft (meestal Berichten lezen/verzenden).
- Als de bot vastloopt of rate limited is, herstart de Gateway (`openclaw gateway --force`) nadat je hebt bevestigd dat geen andere processen de Discord-sessie bezitten.
