---
summary: "Ondersteuningsstatus, mogelijkheden en configuratie van Telegram-bots"
read_when:
  - Werken aan Telegram-functies of webhooks
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:11Z
---

# Telegram (Bot API)

Status: productierijp voor bot-DM’s + groepen via grammY. Long-polling standaard; webhook optioneel.

## Snelle installatie (beginner)

1. Maak een bot aan met **@BotFather** ([directe link](https://t.me/BotFather)). Bevestig dat de handle exact `@BotFather` is en kopieer vervolgens de token.
2. Stel de token in:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - Of config: `channels.telegram.botToken: "..."`.
   - Als beide zijn ingesteld, heeft config voorrang (env-terugval is alleen voor het standaardaccount).
3. Start de Gateway.
4. DM-toegang is standaard gekoppeld via pairing; keur de pairingcode goed bij het eerste contact.

Minimale config:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## Wat het is

- Een Telegram Bot API-kanaal dat eigendom is van de Gateway.
- Deterministische routering: antwoorden gaan terug naar Telegram; het model kiest nooit kanalen.
- DM’s delen de hoofdsessie van de agent; groepen blijven geïsoleerd (`agent:<agentId>:telegram:group:<chatId>`).

## Installatie (snelle route)

### 1) Maak een bot-token aan (BotFather)

1. Open Telegram en chat met **@BotFather** ([directe link](https://t.me/BotFather)). Bevestig dat de handle exact `@BotFather` is.
2. Voer `/newbot` uit en volg de prompts (naam + gebruikersnaam eindigend op `bot`).
3. Kopieer de token en bewaar deze veilig.

Optionele BotFather-instellingen:

- `/setjoingroups` — toevoegen van de bot aan groepen toestaan/weigeren.
- `/setprivacy` — bepalen of de bot alle groepsberichten ziet.

### 2) Configureer de token (env of config)

Voorbeeld:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Env-optie: `TELEGRAM_BOT_TOKEN=...` (werkt voor het standaardaccount).
Als zowel env als config zijn ingesteld, heeft config voorrang.

Ondersteuning voor meerdere accounts: gebruik `channels.telegram.accounts` met per-account tokens en optionele `name`. Zie [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) voor het gedeelde patroon.

3. Start de Gateway. Telegram start zodra een token is opgelost (eerst config, daarna env-terugval).
4. DM-toegang staat standaard op pairing. Keur de code goed wanneer de bot voor het eerst wordt gecontacteerd.
5. Voor groepen: voeg de bot toe, bepaal privacy-/admin-gedrag (hieronder) en stel vervolgens `channels.telegram.groups` in om mention-gating + toegestane lijsten te regelen.

## Token + privacy + rechten (Telegram-zijde)

### Token aanmaken (BotFather)

- `/newbot` maakt de bot aan en retourneert de token (houd deze geheim).
- Als een token lekt, trek deze in/regenereren via @BotFather en werk je config bij.

### Zichtbaarheid van groepsberichten (Privacy Mode)

Telegram-bots staan standaard in **Privacy Mode**, wat beperkt welke groepsberichten zij ontvangen.
Als je bot _alle_ groepsberichten moet zien, heb je twee opties:

- Schakel privacy mode uit met `/setprivacy` **of**
- Voeg de bot toe als **admin** van de groep (admin-bots ontvangen alle berichten).

**Let op:** Wanneer je privacy mode wijzigt, vereist Telegram dat je de bot
uit elke groep verwijdert en opnieuw toevoegt voordat de wijziging van kracht wordt.

### Groepsrechten (adminrechten)

Adminstatus wordt binnen de groep ingesteld (Telegram-UI). Admin-bots ontvangen altijd alle
groepsberichten, gebruik admin dus als je volledige zichtbaarheid nodig hebt.

## Hoe het werkt (gedrag)

- Inkomende berichten worden genormaliseerd naar de gedeelde kanaalenvelop met antwoordcontext en mediaplaatsaanduidingen.
- Groepsantwoorden vereisen standaard een mention (native @mention of `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Multi-agent-override: stel per-agent patronen in op `agents.list[].groupChat.mentionPatterns`.
- Antwoorden worden altijd teruggerouteerd naar dezelfde Telegram-chat.
- Long-polling gebruikt de grammY-runner met per-chat-sequencing; de totale gelijktijdigheid wordt begrensd door `agents.defaults.maxConcurrent`.
- De Telegram Bot API ondersteunt geen leesbevestigingen; er is geen `sendReadReceipts`-optie.

## Conceptstreaming

OpenClaw kan gedeeltelijke antwoorden streamen in Telegram-DM’s met `sendMessageDraft`.

Vereisten:

- Threaded Mode ingeschakeld voor de bot in @BotFather (forum topic-modus).
- Alleen privéchat-threads (Telegram bevat `message_thread_id` in inkomende berichten).
- `channels.telegram.streamMode` niet ingesteld op `"off"` (standaard: `"partial"`, `"block"` schakelt gechunkte conceptupdates in).

Conceptstreaming is alleen voor DM’s; Telegram ondersteunt dit niet in groepen of kanalen.

## Opmaak (Telegram HTML)

- Uitgaande Telegram-tekst gebruikt `parse_mode: "HTML"` (Telegram’s ondersteunde subset van tags).
- Markdown-achtige invoer wordt gerenderd naar **Telegram-veilige HTML** (vet/cursief/doorhalen/code/links); blokelementen worden afgevlakt naar tekst met nieuwe regels/opsommingstekens.
- Ruwe HTML van modellen wordt geëscapet om Telegram-parsefouten te voorkomen.
- Als Telegram de HTML-payload afwijst, probeert OpenClaw hetzelfde bericht opnieuw als platte tekst.

## Opdrachten (native + aangepast)

OpenClaw registreert native opdrachten (zoals `/status`, `/reset`, `/model`) bij het botmenu van Telegram bij het opstarten.
Je kunt aangepaste opdrachten aan het menu toevoegen via config:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## Installatieproblemen oplossen (opdrachten)

- `setMyCommands failed` in logs betekent meestal dat uitgaande HTTPS/DNS is geblokkeerd naar `api.telegram.org`.
- Als je `sendMessage`- of `sendChatAction`-fouten ziet, controleer IPv6-routering en DNS.

Meer hulp: [Kanaalproblemen oplossen](/channels/troubleshooting).

Notities:

- Aangepaste opdrachten zijn **alleen menu-items**; OpenClaw implementeert ze niet tenzij je ze elders afhandelt.
- Opdrachtnamen worden genormaliseerd (leidende `/` verwijderd, naar kleine letters) en moeten overeenkomen met `a-z`, `0-9`, `_` (1–32 tekens).
- Aangepaste opdrachten **kunnen native opdrachten niet overschrijven**. Conflicten worden genegeerd en gelogd.
- Als `commands.native` is uitgeschakeld, worden alleen aangepaste opdrachten geregistreerd (of gewist als er geen zijn).

## Limieten

- Uitgaande tekst wordt gechunked tot `channels.telegram.textChunkLimit` (standaard 4000).
- Optionele nieuwe-regel-chunking: stel `channels.telegram.chunkMode="newline"` in om te splitsen op lege regels (paragraafgrenzen) vóór lengte-chunking.
- Media-downloads/uploads zijn begrensd door `channels.telegram.mediaMaxMb` (standaard 5).
- Telegram Bot API-verzoeken time-outen na `channels.telegram.timeoutSeconds` (standaard 500 via grammY). Stel lager in om lange hangs te voorkomen.
- Groepsgeschiedeniscontext gebruikt `channels.telegram.historyLimit` (of `channels.telegram.accounts.*.historyLimit`), met terugval naar `messages.groupChat.historyLimit`. Stel `0` in om uit te schakelen (standaard 50).
- DM-geschiedenis kan worden beperkt met `channels.telegram.dmHistoryLimit` (gebruikersbeurten). Per-gebruiker overrides: `channels.telegram.dms["<user_id>"].historyLimit`.

## Groepsactivatiemodi

Standaard reageert de bot in groepen alleen op mentions (`@botname` of patronen in `agents.list[].groupChat.mentionPatterns`). Om dit gedrag te wijzigen:

### Via config (aanbevolen)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**Belangrijk:** Het instellen van `channels.telegram.groups` creëert een **toegestane lijst** – alleen vermelde groepen (of `"*"`) worden geaccepteerd.
Forumtopics erven de configuratie van hun bovenliggende groep (allowFrom, requireMention, skills, prompts), tenzij je per-topic overrides toevoegt onder `channels.telegram.groups.<groupId>.topics.<topicId>`.

Alle groepen toestaan met altijd reageren:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

Mention-only behouden voor alle groepen (standaardgedrag):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### Via opdracht (sessieniveau)

Stuur in de groep:

- `/activation always` – reageren op alle berichten
- `/activation mention` – mentions vereisen (standaard)

**Let op:** Opdrachten werken alleen op sessiestatus. Gebruik config voor persistent gedrag na herstarts.

### Het groepschat-ID verkrijgen

Stuur een bericht uit de groep door naar `@userinfobot` of `@getidsbot` op Telegram om het chat-ID te zien (negatief nummer zoals `-1001234567890`).

**Tip:** Voor je eigen gebruikers-ID: DM de bot en hij antwoordt met je gebruikers-ID (pairingbericht), of gebruik `/whoami` zodra opdrachten zijn ingeschakeld.

**Privacy-opmerking:** `@userinfobot` is een bot van derden. Als je dat liever niet wilt, voeg de bot toe aan de groep, stuur een bericht en gebruik `openclaw logs --follow` om `chat.id` te lezen, of gebruik de Bot API `getUpdates`.

## Config-wegschrijvingen

Standaard mag Telegram config-updates wegschrijven die worden getriggerd door kanaalgebeurtenissen of `/config set|unset`.

Dit gebeurt wanneer:

- Een groep wordt geüpgraded naar een supergroep en Telegram `migrate_to_chat_id` uitzendt (chat-ID wijzigt). OpenClaw kan `channels.telegram.groups` automatisch migreren.
- Je `/config set` of `/config unset` uitvoert in een Telegram-chat (vereist `commands.config: true`).

Uitschakelen met:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Topics (forum-supergroepen)

Telegram-forumtopics bevatten per bericht een `message_thread_id`. OpenClaw:

- Voegt `:topic:<threadId>` toe aan de Telegram-groepssessiesleutel zodat elk topic geïsoleerd is.
- Stuurt typindicatoren en antwoorden met `message_thread_id` zodat reacties in het topic blijven.
- Algemeen topic (thread-id `1`) is speciaal: verzenden van berichten laat `message_thread_id` weg (Telegram wijst dit af), maar typindicatoren bevatten het nog steeds.
- Stelt `MessageThreadId` + `IsForum` beschikbaar in templatecontext voor routering/templating.
- Topic-specifieke configuratie is beschikbaar onder `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, toegestane lijsten, auto-antwoord, systeemprompts, uitschakelen).
- Topicconfiguraties erven groepsinstellingen (requireMention, allowlists, skills, prompts, enabled) tenzij per topic overschreven.

Privéchats kunnen in sommige randgevallen `message_thread_id` bevatten. OpenClaw houdt de DM-sessiesleutel ongewijzigd, maar gebruikt de thread-id wel voor antwoorden/conceptstreaming wanneer aanwezig.

## Inline knoppen

Telegram ondersteunt inline toetsenborden met callbackknoppen.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

Voor per-accountconfiguratie:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

Scopes:

- `off` — inline knoppen uitgeschakeld
- `dm` — alleen DM’s (groepsdoelen geblokkeerd)
- `group` — alleen groepen (DM-doelen geblokkeerd)
- `all` — DM’s + groepen
- `allowlist` — DM’s + groepen, maar alleen afzenders toegestaan door `allowFrom`/`groupAllowFrom` (zelfde regels als control-opdrachten)

Standaard: `allowlist`.
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Knoppen verzenden

Gebruik de message-tool met de parameter `buttons`:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

Wanneer een gebruiker op een knop klikt, wordt de callbackdata teruggestuurd naar de agent als een bericht met het formaat:
`callback_data: value`

### Configuratieopties

Telegram-mogelijkheden kunnen op twee niveaus worden geconfigureerd (objectvorm hierboven getoond; legacy string-arrays worden nog ondersteund):

- `channels.telegram.capabilities`: Globale standaard capability-configuratie die op alle Telegram-accounts wordt toegepast, tenzij overschreven.
- `channels.telegram.accounts.<account>.capabilities`: Per-account capabilities die de globale standaarden voor dat specifieke account overschrijven.

Gebruik de globale instelling wanneer alle Telegram-bots/accounts zich hetzelfde moeten gedragen. Gebruik per-accountconfiguratie wanneer verschillende bots verschillend gedrag nodig hebben (bijvoorbeeld één account alleen DM’s afhandelt terwijl een ander in groepen is toegestaan).

## Toegangsbeheer (DM’s + groepen)

### DM-toegang

- Standaard: `channels.telegram.dmPolicy = "pairing"`. Onbekende afzenders ontvangen een pairingcode; berichten worden genegeerd tot goedkeuring (codes verlopen na 1 uur).
- Goedkeuren via:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- Pairing is de standaard tokenuitwisseling voor Telegram-DM’s. Details: [Pairing](/channels/pairing)
- `channels.telegram.allowFrom` accepteert numerieke gebruikers-ID’s (aanbevolen) of `@username`-vermeldingen. Het is **niet** de botgebruikersnaam; gebruik de ID van de menselijke afzender. De wizard accepteert `@username` en zet dit waar mogelijk om naar de numerieke ID.

#### Je Telegram-gebruikers-ID vinden

Veiliger (geen bot van derden):

1. Start de Gateway en DM je bot.
2. Voer `openclaw logs --follow` uit en zoek naar `from.id`.

Alternatief (officiële Bot API):

1. DM je bot.
2. Haal updates op met je bot-token en lees `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Derden (minder privé):

- DM `@userinfobot` of `@getidsbot` en gebruik de geretourneerde gebruikers-ID.

### Groepstoegang

Twee onafhankelijke controles:

**1. Welke groepen zijn toegestaan** (groep-allowlist via `channels.telegram.groups`):

- Geen `groups`-config = alle groepen toegestaan
- Met `groups`-config = alleen vermelde groepen of `"*"` zijn toegestaan
- Voorbeeld: `"groups": { "-1001234567890": {}, "*": {} }` staat alle groepen toe

**2. Welke afzenders zijn toegestaan** (afzenderfiltering via `channels.telegram.groupPolicy`):

- `"open"` = alle afzenders in toegestane groepen kunnen berichten sturen
- `"allowlist"` = alleen afzenders in `channels.telegram.groupAllowFrom` kunnen berichten sturen
- `"disabled"` = helemaal geen groepsberichten geaccepteerd
  Standaard is `groupPolicy: "allowlist"` (geblokkeerd tenzij je `groupAllowFrom` toevoegt).

De meeste gebruikers willen: `groupPolicy: "allowlist"` + `groupAllowFrom` + specifieke groepen vermeld in `channels.telegram.groups`

Om **elk groepslid** toe te staan in een specifieke groep te praten (terwijl control-opdrachten beperkt blijven tot geautoriseerde afzenders), stel een per-groep-override in:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## Long-polling vs webhook

- Standaard: long-polling (geen publieke URL vereist).
- Webhookmodus: stel `channels.telegram.webhookUrl` en `channels.telegram.webhookSecret` in (optioneel `channels.telegram.webhookPath`).
  - De lokale listener bindt aan `0.0.0.0:8787` en serveert standaard `POST /telegram-webhook`.
  - Als je publieke URL anders is, gebruik een reverse proxy en wijs `channels.telegram.webhookUrl` naar het publieke endpoint.

## Antwoord-threading

Telegram ondersteunt optionele gethreadde antwoorden via tags:

- `[[reply_to_current]]` -- antwoord op het triggerende bericht.
- `[[reply_to:<id>]]` -- antwoord op een specifiek bericht-ID.

Aangestuurd door `channels.telegram.replyToMode`:

- `first` (standaard), `all`, `off`.

## Audioberichten (spraak vs bestand)

Telegram onderscheidt **spraaknotities** (rond bubbel) van **audiobestanden** (metadata-kaart).
OpenClaw gebruikt standaard audiobestanden voor achterwaartse compatibiliteit.

Om een spraaknotitie-bubbel af te dwingen in agentantwoorden, neem deze tag ergens in het antwoord op:

- `[[audio_as_voice]]` — verstuur audio als spraaknotitie in plaats van als bestand.

De tag wordt verwijderd uit de afgeleverde tekst. Andere kanalen negeren deze tag.

Voor verzendingen via de message-tool, stel `asVoice: true` in met een spraak-compatibele audio-`media`-URL
(`message` is optioneel wanneer media aanwezig is):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Stickers

OpenClaw ondersteunt het ontvangen en verzenden van Telegram-stickers met intelligente caching.

### Stickers ontvangen

Wanneer een gebruiker een sticker stuurt, handelt OpenClaw deze af op basis van het stickertype:

- **Statische stickers (WEBP):** Gedownload en verwerkt via vision. De sticker verschijnt als een `<media:sticker>`-plaatshouder in de berichtinhoud.
- **Geanimeerde stickers (TGS):** Overgeslagen (Lottie-formaat wordt niet ondersteund voor verwerking).
- **Videostickers (WEBM):** Overgeslagen (videoformaat wordt niet ondersteund voor verwerking).

Templatecontextveld beschikbaar bij het ontvangen van stickers:

- `Sticker` — object met:
  - `emoji` — emoji gekoppeld aan de sticker
  - `setName` — naam van de stickerset
  - `fileId` — Telegram-bestands-ID (stuur dezelfde sticker terug)
  - `fileUniqueId` — stabiele ID voor cache-opzoeking
  - `cachedDescription` — gecachte vision-beschrijving indien beschikbaar

### Stickercache

Stickers worden verwerkt via de vision-mogelijkheden van de AI om beschrijvingen te genereren. Omdat dezelfde stickers vaak herhaaldelijk worden verzonden, cachet OpenClaw deze beschrijvingen om redundante API-aanroepen te vermijden.

**Hoe het werkt:**

1. **Eerste ontmoeting:** De stickerafbeelding wordt naar de AI gestuurd voor vision-analyse. De AI genereert een beschrijving (bijv. “Een cartoonkat die enthousiast zwaait”).
2. **Cache-opslag:** De beschrijving wordt opgeslagen samen met de bestands-ID van de sticker, emoji en setnaam.
3. **Volgende ontmoetingen:** Wanneer dezelfde sticker opnieuw wordt gezien, wordt de gecachte beschrijving direct gebruikt. De afbeelding wordt niet opnieuw naar de AI gestuurd.

**Cachelocatie:** `~/.openclaw/telegram/sticker-cache.json`

**Cache-entryformaat:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**Voordelen:**

- Verlaagt API-kosten door herhaalde vision-calls voor dezelfde sticker te vermijden
- Snellere responstijden voor gecachte stickers (geen vision-verwerkingsvertraging)
- Maakt stickerzoekfunctionaliteit mogelijk op basis van gecachte beschrijvingen

De cache wordt automatisch gevuld wanneer stickers worden ontvangen. Er is geen handmatig cachebeheer nodig.

### Stickers verzenden

De agent kan stickers verzenden en zoeken met de acties `sticker` en `sticker-search`. Deze zijn standaard uitgeschakeld en moeten in config worden ingeschakeld:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**Een sticker verzenden:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Parameters:

- `fileId` (vereist) — de Telegram-bestands-ID van de sticker. Verkrijg deze via `Sticker.fileId` bij het ontvangen van een sticker, of uit een `sticker-search`-zoekresultaat.
- `replyTo` (optioneel) — bericht-ID om op te antwoorden.
- `threadId` (optioneel) — bericht-thread-ID voor forumtopics.

**Stickers zoeken:**

De agent kan gecachte stickers doorzoeken op beschrijving, emoji of setnaam:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Retourneert overeenkomende stickers uit de cache:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

De zoekopdracht gebruikt fuzzy matching over beschrijvingstekst, emoji-tekens en setnamen.

**Voorbeeld met threading:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## Streaming (concepten)

Telegram kan **conceptbubbels** streamen terwijl de agent een antwoord genereert.
OpenClaw gebruikt Bot API `sendMessageDraft` (geen echte berichten) en verzendt daarna het
definitieve antwoord als een normaal bericht.

Vereisten (Telegram Bot API 9.3+):

- **Privéchats met topics ingeschakeld** (forum topic-modus voor de bot).
- Inkomende berichten moeten `message_thread_id` bevatten (privé-topic-thread).
- Streaming wordt genegeerd voor groepen/supergroepen/kanalen.

Config:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (standaard: `partial`)
  - `partial`: werk de conceptbubbel bij met de nieuwste streamingtekst.
  - `block`: werk de conceptbubbel bij in grotere blokken (gechunked).
  - `off`: schakel conceptstreaming uit.
- Optioneel (alleen voor `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - standaarden: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (begrensd tot `channels.telegram.textChunkLimit`).

Let op: conceptstreaming staat los van **blokstreaming** (kanaalberichten).
Blokstreaming staat standaard uit en vereist `channels.telegram.blockStreaming: true`
als je vroege Telegram-berichten wilt in plaats van conceptupdates.

Redeneerstream (alleen Telegram):

- `/reasoning stream` streamt redenering in de conceptbubbel terwijl het antwoord
  wordt gegenereerd, en stuurt daarna het definitieve antwoord zonder redenering.
- Als `channels.telegram.streamMode` `off` is, is de redeneerstream uitgeschakeld.
  Meer context: [Streaming + chunking](/concepts/streaming).

## Retrybeleid

Uitgaande Telegram API-calls worden bij tijdelijke netwerk-/429-fouten opnieuw geprobeerd met exponentiële backoff en jitter. Configureer via `channels.telegram.retry`. Zie [Retrybeleid](/concepts/retry).

## Agent-tool (berichten + reacties)

- Tool: `telegram` met actie `sendMessage` (`to`, `content`, optioneel `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Tool: `telegram` met actie `react` (`chatId`, `messageId`, `emoji`).
- Tool: `telegram` met actie `deleteMessage` (`chatId`, `messageId`).
- Semantiek voor het verwijderen van reacties: zie [/tools/reactions](/tools/reactions).
- Tool-gating: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (standaard: ingeschakeld) en `channels.telegram.actions.sticker` (standaard: uitgeschakeld).

## Reactiemeldingen

**Hoe reacties werken:**
Telegram-reacties komen binnen als **afzonderlijke `message_reaction`-events**, niet als eigenschappen in berichtpayloads. Wanneer een gebruiker een reactie toevoegt, doet OpenClaw het volgende:

1. Ontvangt de `message_reaction`-update van de Telegram API
2. Zet deze om naar een **systeemevent** met formaat: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Plaatst het systeemevent in de wachtrij met **dezelfde sessiesleutel** als reguliere berichten
4. Wanneer het volgende bericht in die conversatie arriveert, worden systeemevents afgevoerd en voorafgaand aan de context van de agent toegevoegd

De agent ziet reacties als **systeemmeldingen** in de conversatiegeschiedenis, niet als berichtmetadata.

**Configuratie:**

- `channels.telegram.reactionNotifications`: Bepaalt welke reacties meldingen triggeren
  - `"off"` — negeer alle reacties
  - `"own"` — meld wanneer gebruikers reageren op botberichten (best-effort; in-memory) (standaard)
  - `"all"` — meld voor alle reacties

- `channels.telegram.reactionLevel`: Bepaalt de reactiemogelijkheid van de agent
  - `"off"` — agent kan niet reageren
  - `"ack"` — bot stuurt bevestigingsreacties (👀 tijdens verwerken) (standaard)
  - `"minimal"` — agent kan spaarzaam reageren (richtlijn: 1 per 5–10 uitwisselingen)
  - `"extensive"` — agent kan vrij reageren wanneer passend

**Forumgroepen:** Reacties in forumgroepen bevatten `message_thread_id` en gebruiken sessiesleutels zoals `agent:main:telegram:group:{chatId}:topic:{threadId}`. Dit zorgt ervoor dat reacties en berichten in hetzelfde topic bij elkaar blijven.

**Voorbeeldconfig:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**Vereisten:**

- Telegram-bots moeten expliciet `message_reaction` aanvragen in `allowed_updates` (automatisch geconfigureerd door OpenClaw)
- Voor webhookmodus zijn reacties inbegrepen in de webhook-`allowed_updates`
- Voor pollingmodus zijn reacties inbegrepen in de `getUpdates` `allowed_updates`

## Afleverdoelen (CLI/cron)

- Gebruik een chat-ID (`123456789`) of een gebruikersnaam (`@name`) als doel.
- Voorbeeld: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Problemen oplossen

**Bot reageert niet op niet-mentionberichten in een groep:**

- Als je `channels.telegram.groups.*.requireMention=false` hebt ingesteld, moet Telegram’s Bot API **privacy mode** zijn uitgeschakeld.
  - BotFather: `/setprivacy` → **Uitschakelen** (verwijder daarna de bot uit de groep en voeg opnieuw toe)
- `openclaw channels status` toont een waarschuwing wanneer de config niet-gementionde groepsberichten verwacht.
- `openclaw channels status --probe` kan aanvullend lidmaatschap controleren voor expliciete numerieke groeps-ID’s (kan geen wildcard-`"*"`-regels auditen).
- Snelle test: `/activation always` (alleen sessie; gebruik config voor persistentie)

**Bot ziet helemaal geen groepsberichten:**

- Als `channels.telegram.groups` is ingesteld, moet de groep worden vermeld of `"*"` gebruiken
- Controleer Privacy-instellingen in @BotFather → “Group Privacy” moet **UIT** staan
- Verifieer dat de bot daadwerkelijk lid is (niet alleen admin zonder leesrechten)
- Controleer Gateway-logs: `openclaw logs --follow` (zoek naar “skipping group message”)

**Bot reageert op mentions maar niet op `/activation always`:**

- De opdracht `/activation` werkt sessiestatus bij maar schrijft niet weg naar config
- Voor persistent gedrag, voeg de groep toe aan `channels.telegram.groups` met `requireMention: false`

**Opdrachten zoals `/status` werken niet:**

- Zorg ervoor dat je Telegram-gebruikers-ID is geautoriseerd (via pairing of `channels.telegram.allowFrom`)
- Opdrachten vereisen autorisatie, zelfs in groepen met `groupPolicy: "open"`

**Long-polling breekt direct af op Node 22+ (vaak met proxies/aangepaste fetch):**

- Node 22+ is strenger met `AbortSignal`-instanties; vreemde signalen kunnen `fetch`-calls onmiddellijk afbreken.
- Upgrade naar een OpenClaw-build die abort-signalen normaliseert, of draai de Gateway op Node 20 totdat je kunt upgraden.

**Bot start en stopt daarna stilzwijgend met reageren (of logt `HttpError: Network request ... failed`):**

- Sommige hosts lossen `api.telegram.org` eerst op naar IPv6. Als je server geen werkende IPv6-egress heeft, kan grammY vastlopen op IPv6-only verzoeken.
- Los dit op door IPv6-egress in te schakelen **of** IPv4-resolutie af te dwingen voor `api.telegram.org` (bijvoorbeeld door een `/etc/hosts`-entry toe te voegen met het IPv4 A-record, of IPv4 te prefereren in je OS-DNS-stack), en herstart vervolgens de Gateway.
- Snelle controle: `dig +short api.telegram.org A` en `dig +short api.telegram.org AAAA` om te bevestigen wat DNS retourneert.

## Configuratiereferentie (Telegram)

Volledige configuratie: [Configuratie](/gateway/configuration)

Provideropties:

- `channels.telegram.enabled`: kanaalstart in-/uitschakelen.
- `channels.telegram.botToken`: bot-token (BotFather).
- `channels.telegram.tokenFile`: lees token uit bestandspad.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (standaard: pairing).
- `channels.telegram.allowFrom`: DM-allowlist (ID’s/gebruikersnamen). `open` vereist `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (standaard: allowlist).
- `channels.telegram.groupAllowFrom`: groepsafzender-allowlist (ID’s/gebruikersnamen).
- `channels.telegram.groups`: per-groep-standaarden + allowlist (gebruik `"*"` voor globale standaarden).
  - `channels.telegram.groups.<id>.groupPolicy`: per-groep-override voor groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: standaard mention-gating.
  - `channels.telegram.groups.<id>.skills`: skillfilter (weglaten = alle skills, leeg = geen).
  - `channels.telegram.groups.<id>.allowFrom`: per-groep-override voor afzender-allowlist.
  - `channels.telegram.groups.<id>.systemPrompt`: extra systeemprompt voor de groep.
  - `channels.telegram.groups.<id>.enabled`: schakel de groep uit wanneer `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per-topic-overrides (zelfde velden als groep).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: per-topic-override voor groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per-topic-override voor mention-gating.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (standaard: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per-account-override.
- `channels.telegram.replyToMode`: `off | first | all` (standaard: `first`).
- `channels.telegram.textChunkLimit`: uitgaande chunkgrootte (tekens).
- `channels.telegram.chunkMode`: `length` (standaard) of `newline` om te splitsen op lege regels (paragraafgrenzen) vóór lengte-chunking.
- `channels.telegram.linkPreview`: schakel linkvoorbeelden in/uit voor uitgaande berichten (standaard: true).
- `channels.telegram.streamMode`: `off | partial | block` (conceptstreaming).
- `channels.telegram.mediaMaxMb`: inkomende/uitgaande medialimiet (MB).
- `channels.telegram.retry`: retrybeleid voor uitgaande Telegram API-calls (pogingen, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: override Node autoSelectFamily (true=inschakelen, false=uitschakelen). Standaard uitgeschakeld op Node 22 om Happy Eyeballs-time-outs te vermijden.
- `channels.telegram.proxy`: proxy-URL voor Bot API-calls (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: webhookmodus inschakelen (vereist `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook-secret (vereist wanneer webhookUrl is ingesteld).
- `channels.telegram.webhookPath`: lokaal webhookpad (standaard `/telegram-webhook`).
- `channels.telegram.actions.reactions`: gate Telegram-toolreacties.
- `channels.telegram.actions.sendMessage`: gate Telegram-toolberichtverzendingen.
- `channels.telegram.actions.deleteMessage`: gate Telegram-toolberichtverwijderingen.
- `channels.telegram.actions.sticker`: gate Telegram-stickeracties — verzenden en zoeken (standaard: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — bepaal welke reacties systeemevents triggeren (standaard: `own` indien niet ingesteld).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — bepaal de reactiemogelijkheid van de agent (standaard: `minimal` indien niet ingesteld).

Gerelateerde globale opties:

- `agents.list[].groupChat.mentionPatterns` (mention-gatingpatronen).
- `messages.groupChat.mentionPatterns` (globale fallback).
- `commands.native` (standaard `"auto"` → aan voor Telegram/Discord, uit voor Slack), `commands.text`, `commands.useAccessGroups` (opdrachtgedrag). Overschrijf met `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
