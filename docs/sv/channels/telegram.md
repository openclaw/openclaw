---
summary: "Status för Telegram-botstöd, funktioner och konfiguration"
read_when:
  - Arbetar med Telegram-funktioner eller webhooks
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:27Z
---

# Telegram (Bot API)

Status: produktionsklart för bot-DM:er + grupper via grammY. Long-polling som standard; webhook valfritt.

## Snabb konfigurering (nybörjare)

1. Skapa en bot med **@BotFather** ([direktlänk](https://t.me/BotFather)). Bekräfta att handtaget är exakt `@BotFather`, och kopiera sedan token.
2. Ange token:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - Eller konfig: `channels.telegram.botToken: "..."`.
   - Om båda är satta har konfig företräde (env‑fallback gäller endast standardkontot).
3. Starta gateway.
4. DM‑åtkomst är parkoppling som standard; godkänn parkopplingskoden vid första kontakt.

Minimal konfig:

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

## Vad det är

- En Telegram Bot API‑kanal som ägs av Gateway.
- Deterministisk routning: svar går tillbaka till Telegram; modellen väljer aldrig kanaler.
- DM:er delar agentens huvudsession; grupper hålls isolerade (`agent:<agentId>:telegram:group:<chatId>`).

## Konfigurering (snabb väg)

### 1) Skapa en bot‑token (BotFather)

1. Öppna Telegram och chatta med **@BotFather** ([direktlänk](https://t.me/BotFather)). Bekräfta att handtaget är exakt `@BotFather`.
2. Kör `/newbot`, och följ sedan anvisningarna (namn + användarnamn som slutar på `bot`).
3. Kopiera token och lagra den säkert.

Valfria BotFather‑inställningar:

- `/setjoingroups` — tillåt/förbjud att lägga till boten i grupper.
- `/setprivacy` — styr om boten ser alla gruppmeddelanden.

### 2) Konfigurera token (env eller konfig)

Exempel:

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

Env‑alternativ: `TELEGRAM_BOT_TOKEN=...` (fungerar för standardkontot).
Om både env och konfig är satta har konfig företräde.

Stöd för flera konton: använd `channels.telegram.accounts` med tokens per konto och valfri `name`. Se [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) för det gemensamma mönstret.

3. Starta gateway. Telegram startar när en token kan lösas (konfig först, env‑fallback).
4. DM‑åtkomst är parkoppling som standard. Godkänn koden när boten kontaktas första gången.
5. För grupper: lägg till boten, bestäm sekretess/admin‑beteende (nedan) och sätt sedan `channels.telegram.groups` för att styra nämningskrav + tillåtelselistor.

## Token + sekretess + behörigheter (Telegram‑sidan)

### Token‑skapande (BotFather)

- `/newbot` skapar boten och returnerar token (håll den hemlig).
- Om en token läcker, återkalla/återskapa den via @BotFather och uppdatera din konfig.

### Synlighet av gruppmeddelanden (Privacy Mode)

Telegram‑botar har som standard **Privacy Mode**, vilket begränsar vilka gruppmeddelanden de tar emot.
Om din bot måste se _alla_ gruppmeddelanden har du två alternativ:

- Inaktivera sekretessläge med `/setprivacy` **eller**
- Lägg till boten som **admin** i gruppen (admin‑botar tar emot alla meddelanden).

**Obs:** När du växlar sekretessläge kräver Telegram att boten tas bort och läggs till igen
i varje grupp för att ändringen ska träda i kraft.

### Gruppbehörigheter (admin‑rättigheter)

Admin‑status ställs in i gruppen (Telegram‑UI). Admin‑botar tar alltid emot alla
gruppmeddelanden, så använd admin om du behöver full synlighet.

## Hur det fungerar (beteende)

- Inkommande meddelanden normaliseras till det delade kanalomslaget med svarskontext och medieplatshållare.
- Gruppsvar kräver nämning som standard (inbyggd @‑nämning eller `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Multi‑agent‑override: sätt mönster per agent på `agents.list[].groupChat.mentionPatterns`.
- Svar routas alltid tillbaka till samma Telegram‑chatt.
- Long‑polling använder grammY‑runner med sekvensering per chatt; total samtidighet begränsas av `agents.defaults.maxConcurrent`.
- Telegram Bot API stöder inte läskvitton; det finns inget `sendReadReceipts`‑alternativ.

## Utkast‑streaming

OpenClaw kan strömma partiella svar i Telegram‑DM:er med `sendMessageDraft`.

Krav:

- Trådat läge aktiverat för boten i @BotFather (forum‑ämnesläge).
- Endast privata chatttrådar (Telegram inkluderar `message_thread_id` i inkommande meddelanden).
- `channels.telegram.streamMode` inte satt till `"off"` (standard: `"partial"`, `"block"` aktiverar chunkade utkastuppdateringar).

Utkast‑streaming är endast för DM; Telegram stöder det inte i grupper eller kanaler.

## Formatering (Telegram HTML)

- Utgående Telegram‑text använder `parse_mode: "HTML"` (Telegram’s stödda tagg‑delmängd).
- Markdown‑liknande indata renderas till **Telegram‑säker HTML** (fet/kursiv/genomstruken/kod/länkar); blockelement plattas till text med radbrytningar/punktlistor.
- Rå HTML från modeller escap:as för att undvika Telegram‑parsningfel.
- Om Telegram avvisar HTML‑payloaden försöker OpenClaw igen med samma meddelande som vanlig text.

## Kommandon (inbyggda + egna)

OpenClaw registrerar inbyggda kommandon (som `/status`, `/reset`, `/model`) i Telegrams botmeny vid start.
Du kan lägga till egna kommandon i menyn via konfig:

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

## Felsökning vid konfigurering (kommandon)

- `setMyCommands failed` i loggarna betyder oftast att utgående HTTPS/DNS blockeras till `api.telegram.org`.
- Om du ser `sendMessage` eller `sendChatAction`‑fel, kontrollera IPv6‑routning och DNS.

Mer hjälp: [Felsökning av kanal](/channels/troubleshooting).

Noteringar:

- Egna kommandon är **endast menyval**; OpenClaw implementerar dem inte om du inte hanterar dem någon annanstans.
- Kommandonamn normaliseras (inledande `/` tas bort, gemener) och måste matcha `a-z`, `0-9`, `_` (1–32 tecken).
- Egna kommandon **kan inte åsidosätta inbyggda kommandon**. Krockar ignoreras och loggas.
- Om `commands.native` är inaktiverat registreras endast egna kommandon (eller rensas om inga finns).

## Begränsningar

- Utgående text delas upp till `channels.telegram.textChunkLimit` (standard 4000).
- Valfri radbrytnings‑chunkning: sätt `channels.telegram.chunkMode="newline"` för att dela på tomrader (styckegränser) före längd‑chunkning.
- Nedladdning/uppladdning av media begränsas av `channels.telegram.mediaMaxMb` (standard 5).
- Telegram Bot API‑anrop får timeout efter `channels.telegram.timeoutSeconds` (standard 500 via grammY). Sätt lägre för att undvika långa hängningar.
- Grupphistorikkontext använder `channels.telegram.historyLimit` (eller `channels.telegram.accounts.*.historyLimit`), med fallback till `messages.groupChat.historyLimit`. Sätt `0` för att inaktivera (standard 50).
- DM‑historik kan begränsas med `channels.telegram.dmHistoryLimit` (användarturer). Per‑användar‑överskrivningar: `channels.telegram.dms["<user_id>"].historyLimit`.

## Gruppaktiveringslägen

Som standard svarar boten endast på nämningar i grupper (`@botname` eller mönster i `agents.list[].groupChat.mentionPatterns`). För att ändra detta beteende:

### Via konfig (rekommenderas)

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

**Viktigt:** Att sätta `channels.telegram.groups` skapar en **tillåtelselista** – endast listade grupper (eller `"*"`) accepteras.
Forum‑ämnen ärver sin överordnade gruppkonfig (allowFrom, requireMention, skills, prompts) om du inte lägger till ämnesspecifika överskrivningar under `channels.telegram.groups.<groupId>.topics.<topicId>`.

För att tillåta alla grupper med alltid‑svara:

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

För att behålla endast‑nämning för alla grupper (standardbeteende):

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

### Via kommando (sessionsnivå)

Skicka i gruppen:

- `/activation always` – svara på alla meddelanden
- `/activation mention` – kräv nämningar (standard)

**Obs:** Kommandon uppdaterar endast sessionsstatus. För beständigt beteende över omstarter, använd konfig.

### Hämta gruppens chatt‑ID

Vidarebefordra valfritt meddelande från gruppen till `@userinfobot` eller `@getidsbot` på Telegram för att se chatt‑ID (negativt tal som `-1001234567890`).

**Tips:** För ditt eget användar‑ID, DM:a boten så svarar den med ditt användar‑ID (parkopplingsmeddelande), eller använd `/whoami` när kommandon är aktiverade.

**Sekretessnot:** `@userinfobot` är en tredjepartsbot. Om du föredrar det, lägg till boten i gruppen, skicka ett meddelande och använd `openclaw logs --follow` för att läsa `chat.id`, eller använd Bot API `getUpdates`.

## Konfigskrivningar

Som standard tillåts Telegram att skriva konfiguppdateringar som triggas av kanalhändelser eller `/config set|unset`.

Detta sker när:

- En grupp uppgraderas till supergrupp och Telegram skickar `migrate_to_chat_id` (chatt‑ID ändras). OpenClaw kan migrera `channels.telegram.groups` automatiskt.
- Du kör `/config set` eller `/config unset` i en Telegram‑chatt (kräver `commands.config: true`).

Inaktivera med:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Ämnen (forum‑supergrupper)

Telegram‑forumämnen inkluderar ett `message_thread_id` per meddelande. OpenClaw:

- Lägger till `:topic:<threadId>` till Telegram‑gruppens sessionsnyckel så att varje ämne isoleras.
- Skickar skrivindikatorer och svar med `message_thread_id` så att svaren stannar i ämnet.
- Allmänt ämne (tråd‑ID `1`) är speciellt: meddelandesändningar utelämnar `message_thread_id` (Telegram avvisar det), men skrivindikatorer inkluderar det fortfarande.
- Exponerar `MessageThreadId` + `IsForum` i mallkontext för routning/mallning.
- Ämnesspecifik konfiguration finns under `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, tillåtelselistor, autosvar, systemprompter, inaktivera).
- Ämneskonfig ärver gruppinställningar (requireMention, tillåtelselistor, skills, prompter, aktiverad) om de inte åsidosätts per ämne.

Privata chattar kan i vissa kantfall inkludera `message_thread_id`. OpenClaw behåller DM‑sessionsnyckeln oförändrad, men använder ändå tråd‑ID för svar/utkast‑streaming när det finns.

## Inline‑knappar

Telegram stöder inline‑tangentbord med callback‑knappar.

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

För konfiguration per konto:

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

Omfång:

- `off` — inline‑knappar inaktiverade
- `dm` — endast DM:er (gruppmål blockeras)
- `group` — endast grupper (DM‑mål blockeras)
- `all` — DM:er + grupper
- `allowlist` — DM:er + grupper, men endast avsändare som tillåts av `allowFrom`/`groupAllowFrom` (samma regler som kontrollkommandon)

Standard: `allowlist`.
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Skicka knappar

Använd meddelandeverktyget med parametern `buttons`:

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

När en användare klickar på en knapp skickas callback‑data tillbaka till agenten som ett meddelande med formatet:
`callback_data: value`

### Konfigurationsalternativ

Telegram‑funktioner kan konfigureras på två nivåer (objektform visas ovan; äldre strängarrayer stöds fortfarande):

- `channels.telegram.capabilities`: Global standard‑kapabilitetskonfig som tillämpas på alla Telegram‑konton om inget åsidosätter.
- `channels.telegram.accounts.<account>.capabilities`: Kapabiliteter per konto som åsidosätter globala standarder för just det kontot.

Använd global inställning när alla Telegram‑botar/konton ska bete sig likadant. Använd per‑konto‑konfiguration när olika botar behöver olika beteenden (t.ex. ett konto hanterar bara DM:er medan ett annat tillåts i grupper).

## Åtkomstkontroll (DM:er + grupper)

### DM‑åtkomst

- Standard: `channels.telegram.dmPolicy = "pairing"`. Okända avsändare får en parkopplingskod; meddelanden ignoreras tills de godkänns (koder löper ut efter 1 timme).
- Godkänn via:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- Parkoppling är standard tokenutbyte för Telegram‑DM:er. Detaljer: [Parkoppling](/channels/pairing)
- `channels.telegram.allowFrom` accepterar numeriska användar‑ID:n (rekommenderas) eller `@username`‑poster. Det är **inte** botens användarnamn; använd den mänskliga avsändarens ID. Guiden accepterar `@username` och löser det till numeriskt ID när möjligt.

#### Hitta ditt Telegram‑användar‑ID

Säkrare (ingen tredjepartsbot):

1. Starta gateway och DM:a din bot.
2. Kör `openclaw logs --follow` och leta efter `from.id`.

Alternativ (officiella Bot API):

1. DM:a din bot.
2. Hämta uppdateringar med din bot‑token och läs `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Tredjepart (mindre privat):

- DM:a `@userinfobot` eller `@getidsbot` och använd det returnerade användar‑ID:t.

### Gruppåtkomst

Två oberoende kontroller:

**1. Vilka grupper som tillåts** (grupp‑tillåtelselista via `channels.telegram.groups`):

- Ingen `groups`‑konfig = alla grupper tillåtna
- Med `groups`‑konfig = endast listade grupper eller `"*"` tillåts
- Exempel: `"groups": { "-1001234567890": {}, "*": {} }` tillåter alla grupper

**2. Vilka avsändare som tillåts** (avsändarfiltrering via `channels.telegram.groupPolicy`):

- `"open"` = alla avsändare i tillåtna grupper kan skriva
- `"allowlist"` = endast avsändare i `channels.telegram.groupAllowFrom` kan skriva
- `"disabled"` = inga gruppmeddelanden accepteras alls
  Standard är `groupPolicy: "allowlist"` (blockerat om du inte lägger till `groupAllowFrom`).

De flesta användare vill ha: `groupPolicy: "allowlist"` + `groupAllowFrom` + specifika grupper listade i `channels.telegram.groups`

För att tillåta **alla gruppmedlemmar** att prata i en specifik grupp (samtidigt som kontrollkommandon förblir begränsade till auktoriserade avsändare), sätt en per‑grupp‑överskrivning:

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

## Long‑polling vs webhook

- Standard: long‑polling (ingen publik URL krävs).
- Webhook‑läge: sätt `channels.telegram.webhookUrl` och `channels.telegram.webhookSecret` (valfritt `channels.telegram.webhookPath`).
  - Den lokala lyssnaren binder till `0.0.0.0:8787` och serverar `POST /telegram-webhook` som standard.
  - Om din publika URL är annorlunda, använd en reverse proxy och peka `channels.telegram.webhookUrl` mot den publika ändpunkten.

## Svarstrådning

Telegram stöder valfri trådad svarning via taggar:

- `[[reply_to_current]]` — svara på det utlösande meddelandet.
- `[[reply_to:<id>]]` — svara på ett specifikt meddelande‑ID.

Styrs av `channels.telegram.replyToMode`:

- `first` (standard), `all`, `off`.

## Ljudmeddelanden (röst vs fil)

Telegram skiljer mellan **röstanteckningar** (rund bubbla) och **ljudfiler** (metadatakort).
OpenClaw använder som standard ljudfiler för bakåtkompatibilitet.

För att tvinga röstanteckningsbubbla i agentsvar, inkludera denna tagg var som helst i svaret:

- `[[audio_as_voice]]` — skicka ljud som röstanteckning i stället för fil.

Taggen tas bort från levererad text. Andra kanaler ignorerar taggen.

För meddelandeverktygssändningar, sätt `asVoice: true` med en röstkompatibel ljud‑`media`‑URL
(`message` är valfri när media finns):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Klistermärken

OpenClaw stöder mottagning och sändning av Telegram‑klistermärken med intelligent cachelagring.

### Ta emot klistermärken

När en användare skickar ett klistermärke hanterar OpenClaw det baserat på typ:

- **Statiska klistermärken (WEBP):** Hämtas och bearbetas via vision. Klistermärket visas som en `<media:sticker>`‑platshållare i meddelandets innehåll.
- **Animerade klistermärken (TGS):** Hoppas över (Lottie‑format stöds inte för bearbetning).
- **Videoklistermärken (WEBM):** Hoppas över (videoformat stöds inte för bearbetning).

Mallkontextfält som är tillgängliga vid mottagning av klistermärken:

- `Sticker` — objekt med:
  - `emoji` — emoji kopplad till klistermärket
  - `setName` — namn på klistermärkesetet
  - `fileId` — Telegram‑fil‑ID (skicka samma klistermärke tillbaka)
  - `fileUniqueId` — stabilt ID för cache‑uppslag
  - `cachedDescription` — cachad visionsbeskrivning när tillgänglig

### Klistermärkes‑cache

Klistermärken bearbetas via AI:ns visionsförmågor för att generera beskrivningar. Eftersom samma klistermärken ofta skickas upprepade gånger cachelagrar OpenClaw dessa beskrivningar för att undvika redundanta API‑anrop.

**Så fungerar det:**

1. **Första mötet:** Klistermärkesbilden skickas till AI:n för visionsanalys. AI:n genererar en beskrivning (t.ex. ”En tecknad katt som vinkar entusiastiskt”).
2. **Cache‑lagring:** Beskrivningen sparas tillsammans med klistermärkesfil‑ID, emoji och set‑namn.
3. **Efterföljande möten:** När samma klistermärke ses igen används den cachade beskrivningen direkt. Bilden skickas inte till AI:n.

**Cache‑plats:** `~/.openclaw/telegram/sticker-cache.json`

**Cache‑postformat:**

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

**Fördelar:**

- Minskar API‑kostnader genom att undvika upprepade visionsanrop för samma klistermärke
- Snabbare svarstider för cachade klistermärken (ingen visionsfördröjning)
- Möjliggör klistermärkesökning baserad på cachade beskrivningar

Cachen fylls automatiskt när klistermärken tas emot. Ingen manuell cachehantering krävs.

### Skicka klistermärken

Agenten kan skicka och söka klistermärken med åtgärderna `sticker` och `sticker-search`. Dessa är inaktiverade som standard och måste aktiveras i konfig:

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

**Skicka ett klistermärke:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Parametrar:

- `fileId` (krävs) — Telegram‑fil‑ID för klistermärket. Hämta detta från `Sticker.fileId` när du tar emot ett klistermärke, eller från ett `sticker-search`‑resultat.
- `replyTo` (valfri) — meddelande‑ID att svara på.
- `threadId` (valfri) — meddelandetråd‑ID för forumämnen.

**Sök efter klistermärken:**

Agenten kan söka cachade klistermärken efter beskrivning, emoji eller set‑namn:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Returnerar matchande klistermärken från cachen:

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

Sökningen använder fuzzy‑matchning över beskrivningstext, emoji‑tecken och set‑namn.

**Exempel med trådning:**

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

## Streaming (utkast)

Telegram kan strömma **utkastbubblor** medan agenten genererar ett svar.
OpenClaw använder Bot API `sendMessageDraft` (inte riktiga meddelanden) och skickar sedan
det slutliga svaret som ett vanligt meddelande.

Krav (Telegram Bot API 9.3+):

- **Privata chattar med ämnen aktiverade** (forum‑ämnesläge för boten).
- Inkommande meddelanden måste inkludera `message_thread_id` (privat ämnestråd).
- Streaming ignoreras för grupper/supergrupper/kanaler.

Konfig:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (standard: `partial`)
  - `partial`: uppdatera utkastbubblan med den senaste strömningstexten.
  - `block`: uppdatera utkastbubblan i större block (chunkat).
  - `off`: inaktivera utkast‑streaming.
- Valfritt (endast för `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - standardvärden: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (begränsat till `channels.telegram.textChunkLimit`).

Obs: utkast‑streaming är separat från **blockstreaming** (kanalmeddelanden).
Blockstreaming är avstängt som standard och kräver `channels.telegram.blockStreaming: true`
om du vill ha tidiga Telegram‑meddelanden i stället för utkastuppdateringar.

Resonemangsström (endast Telegram):

- `/reasoning stream` strömmar resonemang till utkastbubblan medan svaret
  genereras, och skickar sedan det slutliga svaret utan resonemang.
- Om `channels.telegram.streamMode` är `off` är resonemangsström inaktiverad.
  Mer kontext: [Streaming + chunkning](/concepts/streaming).

## Policy för omförsök

Utgående Telegram API‑anrop gör omförsök vid tillfälliga nätverks-/429‑fel med exponentiell backoff och jitter. Konfigurera via `channels.telegram.retry`. Se [Policy för omförsök](/concepts/retry).

## Agentverktyg (meddelanden + reaktioner)

- Verktyg: `telegram` med åtgärden `sendMessage` (`to`, `content`, valfritt `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Verktyg: `telegram` med åtgärden `react` (`chatId`, `messageId`, `emoji`).
- Verktyg: `telegram` med åtgärden `deleteMessage` (`chatId`, `messageId`).
- Semantik för borttagning av reaktioner: se [/tools/reactions](/tools/reactions).
- Verktygsgating: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (standard: aktiverad) och `channels.telegram.actions.sticker` (standard: inaktiverad).

## Reaktionsnotifieringar

**Hur reaktioner fungerar:**
Telegram‑reaktioner anländer som **separata `message_reaction`‑händelser**, inte som egenskaper i meddelandepayloads. När en användare lägger till en reaktion gör OpenClaw:

1. Tar emot `message_reaction`‑uppdateringen från Telegram API
2. Konverterar den till en **systemhändelse** med format: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Köar systemhändelsen med **samma sessionsnyckel** som vanliga meddelanden
4. När nästa meddelande anländer i konversationen töms systemhändelserna och förhandsläggs i agentens kontext

Agenten ser reaktioner som **systemnotifieringar** i konversationshistoriken, inte som meddelandemetadata.

**Konfiguration:**

- `channels.telegram.reactionNotifications`: Styr vilka reaktioner som triggar notifieringar
  - `"off"` — ignorera alla reaktioner
  - `"own"` — notifiera när användare reagerar på botmeddelanden (best effort; i minnet) (standard)
  - `"all"` — notifiera för alla reaktioner

- `channels.telegram.reactionLevel`: Styr agentens reaktionsförmåga
  - `"off"` — agenten kan inte reagera på meddelanden
  - `"ack"` — boten skickar bekräftelsereaktioner (👀 under bearbetning) (standard)
  - `"minimal"` — agenten kan reagera sparsamt (riktlinje: 1 per 5–10 utbyten)
  - `"extensive"` — agenten kan reagera generöst när lämpligt

**Forumgrupper:** Reaktioner i forumgrupper inkluderar `message_thread_id` och använder sessionsnycklar som `agent:main:telegram:group:{chatId}:topic:{threadId}`. Detta säkerställer att reaktioner och meddelanden i samma ämne hålls tillsammans.

**Exempelkonfig:**

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

**Krav:**

- Telegram‑botar måste uttryckligen begära `message_reaction` i `allowed_updates` (konfigureras automatiskt av OpenClaw)
- I webhook‑läge inkluderas reaktioner i webhook‑`allowed_updates`
- I polling‑läge inkluderas reaktioner i `getUpdates` `allowed_updates`

## Leveransmål (CLI/cron)

- Använd ett chatt‑ID (`123456789`) eller ett användarnamn (`@name`) som mål.
- Exempel: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Felsökning

**Boten svarar inte på icke‑nämnda meddelanden i en grupp:**

- Om du satte `channels.telegram.groups.*.requireMention=false` måste Telegrams Bot API **sekretessläge** vara inaktiverat.
  - BotFather: `/setprivacy` → **Disable** (ta sedan bort + lägg till boten i gruppen igen)
- `openclaw channels status` visar en varning när konfig förväntar sig onämnda gruppmeddelanden.
- `openclaw channels status --probe` kan dessutom kontrollera medlemskap för explicita numeriska grupp‑ID:n (den kan inte granska wildcard‑regler som `"*"`).
- Snabbtest: `/activation always` (endast session; använd konfig för beständighet)

**Boten ser inga gruppmeddelanden alls:**

- Om `channels.telegram.groups` är satt måste gruppen vara listad eller använda `"*"`
- Kontrollera sekretessinställningar i @BotFather → ”Group Privacy” ska vara **OFF**
- Verifiera att boten faktiskt är medlem (inte bara admin utan läsåtkomst)
- Kontrollera gateway‑loggar: `openclaw logs --follow` (leta efter ”skipping group message”)

**Boten svarar på nämningar men inte `/activation always`:**

- Kommandot `/activation` uppdaterar sessionsstatus men sparar inte i konfig
- För beständigt beteende, lägg till gruppen i `channels.telegram.groups` med `requireMention: false`

**Kommandon som `/status` fungerar inte:**

- Säkerställ att ditt Telegram‑användar‑ID är auktoriserat (via parkoppling eller `channels.telegram.allowFrom`)
- Kommandon kräver auktorisering även i grupper med `groupPolicy: "open"`

**Long‑polling avbryts direkt på Node 22+ (ofta med proxies/anpassad fetch):**

- Node 22+ är striktare med `AbortSignal`‑instanser; främmande signaler kan avbryta `fetch`‑anrop direkt.
- Uppgradera till en OpenClaw‑build som normaliserar abort‑signaler, eller kör gateway på Node 20 tills du kan uppgradera.

**Boten startar och slutar sedan tyst att svara (eller loggar `HttpError: Network request ... failed`):**

- Vissa värdar löser `api.telegram.org` till IPv6 först. Om din server saknar fungerande IPv6‑utgående trafik kan grammY fastna på IPv6‑endast‑anrop.
- Åtgärda genom att aktivera IPv6‑utgående trafik **eller** tvinga IPv4‑upplösning för `api.telegram.org` (t.ex. lägg till en `/etc/hosts`‑post med IPv4‑A‑posten, eller föredra IPv4 i OS:ets DNS‑stack), och starta sedan om gateway.
- Snabbkontroll: `dig +short api.telegram.org A` och `dig +short api.telegram.org AAAA` för att bekräfta vad DNS returnerar.

## Konfigurationsreferens (Telegram)

Fullständig konfiguration: [Konfiguration](/gateway/configuration)

Leverantörsalternativ:

- `channels.telegram.enabled`: aktivera/inaktivera kanalstart.
- `channels.telegram.botToken`: bot‑token (BotFather).
- `channels.telegram.tokenFile`: läs token från filsökväg.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (standard: parkoppling).
- `channels.telegram.allowFrom`: DM‑tillåtelselista (ID:n/användarnamn). `open` kräver `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (standard: tillåtelselista).
- `channels.telegram.groupAllowFrom`: grupp‑avsändar‑tillåtelselista (ID:n/användarnamn).
- `channels.telegram.groups`: per‑grupp‑standarder + tillåtelselista (använd `"*"` för globala standarder).
  - `channels.telegram.groups.<id>.groupPolicy`: per‑grupp‑överskrivning för groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: standard för nämningskrav.
  - `channels.telegram.groups.<id>.skills`: skill‑filter (utelämna = alla skills, tom = inga).
  - `channels.telegram.groups.<id>.allowFrom`: per‑grupp‑överskrivning av avsändar‑tillåtelselista.
  - `channels.telegram.groups.<id>.systemPrompt`: extra systemprompt för gruppen.
  - `channels.telegram.groups.<id>.enabled`: inaktivera gruppen när `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: per‑ämne‑överskrivningar (samma fält som grupp).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: per‑ämne‑överskrivning för groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: per‑ämne‑överskrivning av nämningskrav.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (standard: tillåtelselista).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: per‑konto‑överskrivning.
- `channels.telegram.replyToMode`: `off | first | all` (standard: `first`).
- `channels.telegram.textChunkLimit`: utgående chunk‑storlek (tecken).
- `channels.telegram.chunkMode`: `length` (standard) eller `newline` för att dela på tomrader (styckegränser) före längd‑chunkning.
- `channels.telegram.linkPreview`: växla länkförhandsvisningar för utgående meddelanden (standard: true).
- `channels.telegram.streamMode`: `off | partial | block` (utkast‑streaming).
- `channels.telegram.mediaMaxMb`: gräns för inkommande/utgående media (MB).
- `channels.telegram.retry`: policy för omförsök för utgående Telegram API‑anrop (försök, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: åsidosätt Node autoSelectFamily (true=aktivera, false=inaktivera). Standard är inaktiverad på Node 22 för att undvika Happy Eyeballs‑timeouts.
- `channels.telegram.proxy`: proxy‑URL för Bot API‑anrop (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: aktivera webhook‑läge (kräver `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook‑hemlighet (krävs när webhookUrl är satt).
- `channels.telegram.webhookPath`: lokal webhook‑sökväg (standard `/telegram-webhook`).
- `channels.telegram.actions.reactions`: gate Telegram‑verktygsreaktioner.
- `channels.telegram.actions.sendMessage`: gate Telegram‑verktygets meddelandesändningar.
- `channels.telegram.actions.deleteMessage`: gate Telegram‑verktygets borttagning av meddelanden.
- `channels.telegram.actions.sticker`: gate Telegram‑klistermärkesåtgärder — skicka och sök (standard: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — styr vilka reaktioner som triggar systemhändelser (standard: `own` när ej satt).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — styr agentens reaktionsförmåga (standard: `minimal` när ej satt).

Relaterade globala alternativ:

- `agents.list[].groupChat.mentionPatterns` (nämningsmönster).
- `messages.groupChat.mentionPatterns` (global fallback).
- `commands.native` (standard till `"auto"` → på för Telegram/Discord, av för Slack), `commands.text`, `commands.useAccessGroups` (kommandobeteende). Åsidosätt med `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
